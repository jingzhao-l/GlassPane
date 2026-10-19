import Foundation
import CoreGraphics

/// 可选能力：输入源把"我订阅了哪些事件种类"说出来。
///
/// 协议声明放在本文件：`InputSourceMonitoring` 属 `AttributionGuard.swift`（另一条泳道的
/// 文件，本批不动它），而"监测到的种类"必须有地方说出口——`EngineCore` 的
/// `contaminationBasis` 那句"整段都被看着"要靠它才能被核对而不是被信任。
///
/// 不实现它的源没有第二条路：调用方要么自己申报种类（`EngineCore` 的
/// `inputEventKindsProvider`），要么得到一句"这个源没申报种类"。把缺席读成"全都看着"
/// 就是本批要关掉的那句话。
public protocol InputEventKindReporting: AnyObject {
    var monitoredEventKinds: [String] { get }
}

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
public final class CGEventInputMonitor: InputEventSource, InputSourceMonitoring, InputEventKindReporting {

    // MARK: - What this tap actually subscribes to (single source of truth)

    /// 这张 tap 订阅的事件种类。**唯一真源**：`eventsOfInterest` 的蒙版由这张表生成，
    /// `EngineCore` 的 `contaminationBasis` 那句"watched for the whole operation window"
    /// 说的也是这张表（`inputEventKindsProvider`）。
    ///
    /// 从前蒙版里写死的是 keyDown + 三种 mouse **down**，而句子说的是"整个操作窗口都在
    /// 看着"：一个人如果在 act 期间只滚了滚轮、或只把一次拖拽抬起，被订阅的种类一个都不会
    /// 投递，于是那次"零事件"被当成"没人碰机器"发布出去（`EngineCore.swift:1246`，
    /// 归因仍是 `.soft`/`contaminated=false`）。这正是本项目最贵的一类错：把一个没测到的
    /// 负例说成一个测到的负例。
    ///
    /// `mouseMoved` 不在名单里，而句子也不声称看着它：把一个会话级、每帧都来的位移事件
    /// 投给 `.defaultTap`（不是 listen-only）是已知的输入延迟代价，而"指针动了、没按也
    /// 没滚"不是这条主张要覆盖的交互。写在这里而不是藏在代码里，是因为漏掉的种类必须
    /// 能被读出来——句子列出的就是蒙版有的，名单没列的读者看得见它没被列。
    /// 名单本身是产品面：本批补的是"说的与订的是同一件事"，不是替产品决定监测范围。
    static let monitoredEventTypes: [(name: String, type: CGEventType)] = [
        ("keyDown", .keyDown),
        ("keyUp", .keyUp),
        ("flagsChanged", .flagsChanged),
        ("leftMouseDown", .leftMouseDown),
        ("leftMouseUp", .leftMouseUp),
        ("rightMouseDown", .rightMouseDown),
        ("rightMouseUp", .rightMouseUp),
        ("otherMouseDown", .otherMouseDown),
        ("otherMouseUp", .otherMouseUp),
        ("leftMouseDragged", .leftMouseDragged),
        ("rightMouseDragged", .rightMouseDragged),
        ("otherMouseDragged", .otherMouseDragged),
        ("scrollWheel", .scrollWheel),
    ]

    /// 订阅种类的线上形态（`act` 响应里的 `monitoredEventKinds`）。
    public static var monitoredEventKinds: [String] { monitoredEventTypes.map { $0.name } }

    /// 单个种类对应的蒙版位。认不出的名字回 nil——让调用方拿到 0 再或进蒙版，等于把
    /// 一个拼错的名字变成"订阅了第 0 号事件"。
    public static func eventMask(forKind name: String) -> CGEventMask? {
        guard let entry = monitoredEventTypes.first(where: { $0.name == name }) else { return nil }
        return CGEventMask(1) << CGEventMask(entry.type.rawValue)
    }

    /// `tapCreate` 用的蒙版：逐位或出来，永远与 `monitoredEventKinds` 同源。
    public static var monitoredEventMask: CGEventMask {
        monitoredEventTypes.reduce(CGEventMask(0)) { mask, entry in
            mask | (eventMask(forKind: entry.name) ?? 0)
        }
    }

    /// 本实例订阅的种类（与 `monitoredEventMask` 同一张表；投递与否由 `isMonitoringInput`
    /// 说，种类不是那条声明）。
    public var monitoredEventKinds: [String] { Self.monitoredEventKinds }

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
    /// （权限被拒 / 拿不到 run loop source / `CGEventTapIsEnabled` 读回 false），
    /// 此时调用方必须按"未监测"降级。
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
            eventsOfInterest: Self.monitoredEventMask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            recordFault("CGEventTapCreate returned nil (Input Monitoring TCC not granted?)")
            return false
        }
        stateLock.lock()
        if shuttingDown {
            // stop() raced the install: nothing may keep a tap after teardown.
            //
            // The run-loop source is created **below** this branch on purpose. It used to
            // be created above it, so the abandoned path built a `CFRunLoopSource`,
            // invalidated the mach port underneath it and returned: ARC lets go of the
            // source at scope exit, so today that is not a leak — it is a teardown path
            // that has to clean up an object it never needed, and the next edit that
            // *stores* that source (the two lines below store everything else) would put
            // an owned object on a path nobody unwinds. Creating nothing here is the
            // smaller claim.
            stateLock.unlock()
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
            return false
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        if let source {
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        }
        CGEvent.tapEnable(tap: tap, enable: true)
        // 存活位以读回为准（与 `noteTapDisabled` 重装分支同一条判据）：
        // `CGEventTapEnable` 没有返回值，而**创建时**就被系统停用的 tap 不会发
        // disable 回调——那种停用只有在这里才看得见。
        let enabled = CGEvent.tapIsEnabled(tap: tap)
        // 没有 source 的 tap 挂在空的循环上永不投递 —— 那也是"没在测"。
        let pumped = source != nil
        tapAlive = pumped && enabled
        eventTap = tap
        runLoopSource = source
        ownsRunLoop = pumpedByMonitorThread && pumped
        runLoop = pumped ? RunLoop.current : nil
        if !pumped {
            lastFault = "tap has no run loop source: no pump, no events"
        } else if !enabled {
            lastFault = "CGEventTapEnable did not enable the tap: CGEventTapIsEnabled read false at creation"
        } else {
            lastFault = nil
        }
        stateLock.unlock()
        return pumped && enabled
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
            // A re-arm that worked is not a fault. It used to be written through
            // `error` while every ERROR line was still suppressed by `quiet`
            // (`EngineLog`); now that errors always reach the log, a healthy
            // recovery would read as a recurring defect to whoever follows
            // `internalError`'s "check the daemon log" remedy.
            log.info("C33 input monitor: \(name) → tap re-armed "
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

    /// 有序拆卸：① 先把"没在测"发布出去；② 关掉 tap 的投递；③ 让泵循环那一侧自己摘
    /// source + invalidate tap（跨线程摘 source 是未定义行为）；④ 有界地等它退出，超时
    /// 才在本线程补一次 invalidate 并记日志。返回后不可能再有回调往缓冲区里塞事件。
    ///
    /// ① 必须在 ② 之前，而且必须在**两条**分支之前：从前只有非 joinable 分支清存活位，
    /// joinable 那条把它留给后台线程自己的拆卸——最迟要等一个泵周期
    /// （`runLoopWakeInterval`）。那一段时间里投递已经关了，`isMonitoringInput` 仍然回
    /// true，面板写着"在监测"，而 `AttributionGuard` 判"这个窗口有人看着"用的正是这个值。
    public func stop() {
        stateLock.lock()
        shuttingDown = true
        // 存活位在读到 `joinable` 之前就已落定：任何一条分支都不再声称"在测"。
        tapAlive = false
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
