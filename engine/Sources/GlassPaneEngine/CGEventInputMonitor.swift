import Foundation
import CoreGraphics

/// Real CGEvent-backed input source (P2 spec v2.0 §16.2). Requires the
/// Input Monitoring TCC permission at runtime; genuine always-on polling is
/// not testable in unit tests, so the daemon consumes this adapter and tests
/// consume `ScriptedInputEventSource`. When the permission is denied the
/// monitor stays silent (no access → no events), which degrades C33 to
/// operation-right mutual exclusion only — the honest降级 documented in
/// spec v2.0 §17.2.
///
/// A tap that *was* installed can still stop delivering: macOS disables an
/// active tap when its callback overruns the system budget
/// (`tapDisabledByTimeout`) or when the user/系统 asks taps off
/// (`tapDisabledByUserInput`), and the disable arrives as the callback's
/// `type` with no user event attached. Swallowing that type would turn "we
/// stopped measuring" into "nothing happened" — the one reading
/// `AttributionGuard` must never be allowed to make. So the tap is re-armed
/// on those notifications (bounded, with the read-back checked rather than
/// assumed), and every outcome is *published* through `isMonitoringInput` /
/// `inputMonitoringFault` instead of being inferred from an empty stream.
public final class CGEventInputMonitor: InputEventSource, InputSourceMonitoring {

    /// 重装预算：反复被停用说明系统/用户持续拒绝投递，继续重装只会把"零投递"
    /// 一路伪装成"在测"。预算用尽后存活位改 false，裁决改走未监测分支。
    static let maxReArmAttempts = 8

    /// 泵循环的唤醒间隔：`stop()` 之后后台线程最迟这么久而退出。
    static let runLoopWakeInterval: TimeInterval = 0.05

    /// `stop()` 等后台线程自行拆卸的有界上限。
    static let teardownJoinLimitSeconds: TimeInterval = 1.0

    private let eventsBuffer = LockedEventBuffer()
    private let log: EngineLog

    /// Tap / run-loop state is touched by the installing thread, by the CGEvent
    /// callback (on the pumping thread) and by `stop()` (on the caller's
    /// thread). Everything below is read and written only with `stateLock`
    /// held — the pre-fix code assigned `eventTap`/`runLoopSource` from
    /// `stop()` with no lock at all.
    private let stateLock = NSLock()
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    /// 泵这个 tap 的循环。`stop()` 要 wake 它，而 `RunLoop.current` 在别的线程
    /// 上取不到，所以必须存下来。
    private var runLoop: RunLoop?
    /// `runLoop` 是否由本对象的后台线程拥有（决定 `stop()` 能不能 join 它）。
    private var ownsRunLoop = false
    private var monitorThread: Thread?
    private var tapAlive = false
    private var shuttingDown = false

    private var disableCount = 0
    private var reArmCount = 0
    private var reArmFailureCount = 0
    private var disablePendingReport = false
    private var lastFault: String?

    /// 装 tap 并把它挂到**当前**线程的 run loop 上。返回 false = 没装成
    /// （权限被拒 / 拿不到 run loop source），此时调用方必须按"未监测"降级。
    /// Only `.human` events are enqueued: the AX-synthesized `.agent` events
    /// are attributed by the engine already and must not count as real user
    /// input (spec v2.0 §15.2).
    private func installTap(pumpedByMonitorThread: Bool) -> Bool {
        // No captures: this closure is passed to CoreGraphics as a C function
        // pointer, so the monitor comes back through `userInfo`.
        let callback: CGEventTapCallBack = { _, type, event, context in
            guard let context else { return Unmanaged.passUnretained(event) }
            let monitor = Unmanaged<CGEventInputMonitor>
                .fromOpaque(context)
                .takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                // `event` here is the disable notification, not user input:
                // enqueueing it (or forwarding it as if nothing happened) is
                // exactly how a dead channel used to look like a clean one.
                monitor.noteTapDisabled(kind: type)
                return nil
            }
            monitor.enqueue(event)
            return Unmanaged.passUnretained(event)
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: 1 << CGEventType.keyDown.rawValue
                | 1 << CGEventType.leftMouseDown.rawValue
                | 1 << CGEventType.rightMouseDown.rawValue
                | 1 << CGEventType.otherMouseDown.rawValue,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            recordFault("CGEventTapCreate returned nil (Input Monitoring TCC not granted?)")
            return false
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        stateLock.lock()
        if shuttingDown {
            // stop() raced the install: nothing may keep a tap after teardown.
            stateLock.unlock()
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
            return false
        }
        if let source {
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        }
        CGEvent.tapEnable(tap: tap, enable: true)
        // 没有 source 的 tap 挂在空的循环上永不投递 —— 那也是"没在测"。
        tapAlive = source != nil
        eventTap = tap
        runLoopSource = source
        ownsRunLoop = pumpedByMonitorThread && source != nil
        runLoop = source == nil ? nil : RunLoop.current
        lastFault = source == nil ? "tap has no run loop source: no pump, no events" : nil
        stateLock.unlock()
        return source != nil
    }

    fileprivate func enqueue(_ event: CGEvent) {
        let timestamp = Date().timeIntervalSince1970
        eventsBuffer.push(InputEvent(timestamp: timestamp, source: .human))
    }

    /// tap 停用通知的响应：重装 + 如实记账。重装结果以 `CGEventTapIsEnabled`
    /// 的读回为准（`CGEventTapEnable` 无返回值，请求本身不构成证据）。
    private func noteTapDisabled(kind: CGEventType) {
        let name = kind == .tapDisabledByUserInput ? "tapDisabledByUserInput" : "tapDisabledByTimeout"
        stateLock.lock()
        guard !shuttingDown else {
            stateLock.unlock()
            return
        }
        disableCount += 1
        disablePendingReport = true
        let tap = eventTap
        let budgetLeft = reArmCount < Self.maxReArmAttempts
        let disables = disableCount
        stateLock.unlock()

        guard budgetLeft, let tap else {
            stateLock.lock()
            reArmFailureCount += 1
            tapAlive = false
            lastFault = budgetLeft
                ? "\(name): no tap handle to re-enable"
                : "\(name): re-arm budget (\(Self.maxReArmAttempts)) exhausted, tap left disabled"
            let fault = lastFault
            stateLock.unlock()
            log.error("C33 input monitor: \(fault ?? "unknown fault") — contamination is now undecidable")
            return
        }

        CGEvent.tapEnable(tap: tap, enable: true)
        let revived = CGEvent.tapIsEnabled(tap: tap)
        stateLock.lock()
        if revived {
            reArmCount += 1
            tapAlive = true
            lastFault = nil
        } else {
            reArmFailureCount += 1
            tapAlive = false
            lastFault = "\(name): CGEventTapEnable did not revive the tap"
        }
        let fault = lastFault
        let reArms = reArmCount
        stateLock.unlock()

        if let fault {
            log.error("C33 input monitor: \(fault) (disables so far: \(disables))")
        } else {
            log.error("C33 input monitor: \(name) → tap re-armed "
                + "(\(reArms)/\(Self.maxReArmAttempts), disables so far: \(disables))")
        }
    }

    private func recordFault(_ message: String) {
        stateLock.lock()
        lastFault = message
        tapAlive = false
        stateLock.unlock()
        log.error("C33 input monitor: \(message)")
    }

    // MARK: - InputEventSource

    public func nextEvent() -> InputEvent? {
        eventsBuffer.pop()
    }

    public func peekAvailable() -> [InputEvent] {
        eventsBuffer.snapshot()
    }

    // MARK: - InputSourceMonitoring

    /// 事件通道此刻是否真的在投递（tap 存在、已启用、且有人泵它）。
    public var isMonitoringInput: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return tapAlive
    }

    /// `isMonitoringInput == false` 的原因；正在监测时为 nil。
    public var inputMonitoringFault: String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return tapAlive ? nil : lastFault
    }

    // MARK: - Liveness / diagnostics

    public var isTapAlive: Bool { isMonitoringInput }

    /// 自上次读取以来是否发生过停用（读后清零）。区分"一直在测"与"这一轮里掉
    /// 过一次、又装回来了"。
    public func disabledSinceLastCheck() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        let seen = disablePendingReport
        disablePendingReport = false
        return seen
    }

    /// 累计停用 / 重装成功 / 重装失败次数与最近一次故障串（只读观测面）。
    public var tapDisableCount: Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return disableCount
    }

    public var tapReArmCount: Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return reArmCount
    }

    public var tapReArmFailureCount: Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return reArmFailureCount
    }

    /// 最近一次故障原因，**无论**当前存活与否（重装成功后仍想回看掉过几次）。
    public var lastTapFault: String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return lastFault
    }

    // MARK: - Lifecycle

    /// Starts the tap on the calling run loop (dispatch to an event queue).
    /// Returns false when the tap cannot be created (permission denied).
    @discardableResult
    public func start() -> Bool {
        installTap(pumpedByMonitorThread: false)
    }

    /// Installs the tap on a dedicated background thread with its own run
    /// loop and keeps that loop pumped. The daemon main thread blocks in
    /// `server.run()`, so tapping the *current* loop there would silently
    /// deliver zero events — this is the shape the daemon must use.
    /// Returns false when the tap cannot be created (Input Monitoring TCC
    /// not granted): the caller degrades to operation-right mutex only.
    public func startOnBackgroundRunLoop() -> Bool {
        stateLock.lock()
        if monitorThread != nil {
            // 已在跑：不装第二个 tap（第二个循环只会把事件投递翻倍）。
            let alive = tapAlive
            stateLock.unlock()
            return alive
        }
        shuttingDown = false
        stateLock.unlock()

        let ready = DispatchSemaphore(value: 0)
        var installed = false
        let thread = Thread { [weak self] in
            guard let self else {
                ready.signal()
                return
            }
            installed = self.installTap(pumpedByMonitorThread: true)
            ready.signal()
            if installed {
                self.pumpRunLoop()
            }
            self.tearDownOnMonitorThread()
        }
        thread.name = "glasspane.c33.input-monitor"
        // 记下线程**再**起跑：线程可能在几微秒内就走完拆卸并把
        // `monitorThread` 清成 nil，反过来做会让这个实例永久拒绝重启。
        stateLock.lock()
        monitorThread = thread
        stateLock.unlock()
        thread.start()
        ready.wait()
        return installed
    }

    /// `RunLoop.run()` 永不返回，`stop()` 就没有让线程退出的办法（旧代码就是这样
    /// 把线程和 tap 一起泄漏掉）。改为带唤醒间隔的泵：`.default` 属于
    /// `CFRunLoopAddSource` 用的 `.commonModes` 集合，事件投递语义不变。
    private func pumpRunLoop() {
        let loop = RunLoop.current
        while !shuttingDownRequested() {
            _ = loop.run(mode: .default, before: Date(timeIntervalSinceNow: Self.runLoopWakeInterval))
        }
    }

    private func shuttingDownRequested() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return shuttingDown
    }

    /// 拆卸必须在**拥有该 run loop 的线程**上做（`CFRunLoopRemoveSource`），
    /// 所以 `stop()` 只负责先关投递、再等这里跑完。
    private func tearDownOnMonitorThread() {
        stateLock.lock()
        let tap = eventTap
        let source = runLoopSource
        eventTap = nil
        runLoopSource = nil
        runLoop = nil
        ownsRunLoop = false
        tapAlive = false
        monitorThread = nil
        stateLock.unlock()

        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
        }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
    }

    /// 有序拆卸：① 关掉 tap 的投递；② 让泵循环那一侧自己摘 source + invalidate
    /// tap（跨线程摘 source 是未定义行为）；③ 有界地等它退出，超时才在本线程
    /// 补一次 invalidate 并记日志。返回后不可能再有回调往缓冲区里塞事件。
    public func stop() {
        stateLock.lock()
        shuttingDown = true
        let tap = eventTap
        let loop = runLoop
        let joinable = ownsRunLoop && runLoopSource != nil
        if !joinable {
            // 没有我们拥有的循环可 join：直接在本线程拆完
            // （CFMachPortInvalidate 允许跨线程调用，这是文档认可的停投递手段）。
            eventTap = nil
            runLoopSource = nil
            runLoop = nil
            ownsRunLoop = false
            tapAlive = false
            monitorThread = nil
        }
        stateLock.unlock()

        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        guard joinable else {
            if let tap { CFMachPortInvalidate(tap) }
            return
        }

        // Darwin 的 RunLoop 没有 wake(after:)：泵本身按 runLoopWakeInterval 有界返回，
        // 所以下面这个 2ms 轮询最多等一个泵周期就能看到 source 被摘掉。
        var drained = false
        let deadline = Date().addingTimeInterval(Self.teardownJoinLimitSeconds)
        while !drained && Date() < deadline {
            stateLock.lock()
            drained = eventTap == nil && runLoopSource == nil
            stateLock.unlock()
            if !drained {
                Thread.sleep(forTimeInterval: 0.002)
            }
        }
        if drained {
            return
        }

        stateLock.lock()
        // 认领式兜底：只有在锁内仍然看得到 tap 时，本线程才负责拆它 ——
        // 后台线程可能恰好在超时的瞬间自己拆完，那就不该二次 invalidate。
        let orphanTap = eventTap
        eventTap = nil
        runLoopSource = nil
        runLoop = nil
        ownsRunLoop = false
        tapAlive = false
        monitorThread = nil
        stateLock.unlock()
        log.error("C33 input monitor: background run loop did not exit within "
            + "\(Self.teardownJoinLimitSeconds)s of stop(); invalidated the tap from the "
            + "stopping thread instead")
        if let orphanTap {
            CFMachPortInvalidate(orphanTap)
        }
    }

    /// 默认保持响（`quiet: false`）：tap 停用是"测量断了"这一级故障，daemon 不
    /// 该有机会把它吞掉。`glasspaned` 若要用自己的 `--verbose` 口径，构造时把
    /// 它的 `log` 传进来即可。
    public init(log: EngineLog = EngineLog(quiet: false)) {
        self.log = log
    }
}

/// A tiny thread-safe FIFO for monitored input events. The CGEvent tap runs
/// on its own event-tracking thread while the daemon polls from the main
/// loop, so the buffer must be safe under concurrent access.
final class LockedEventBuffer {
    /// Bounded capacity: a long-unpolled stream never grows without limit,
    /// the oldest events drop first.
    private let capacity: Int
    private var buffer: [InputEvent] = []
    private let lock = NSLock()

    init(capacity: Int = 4096) {
        self.capacity = capacity
    }

    func push(_ event: InputEvent) {
        lock.lock()
        defer { lock.unlock() }
        buffer.append(event)
        if buffer.count > capacity {
            buffer.removeFirst(buffer.count - capacity)
        }
    }

    func pop() -> InputEvent? {
        lock.lock()
        defer { lock.unlock() }
        guard !buffer.isEmpty else { return nil }
        return buffer.removeFirst()
    }

    func snapshot() -> [InputEvent] {
        lock.lock()
        defer { lock.unlock() }
        return buffer
    }
}
