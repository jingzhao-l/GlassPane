import Foundation
import CoreGraphics

/// Real CGEvent-backed input source (P2 spec v2.0 §16.2). Requires the
/// Input Monitoring TCC permission at runtime; genuine always-on polling is
/// not testable in unit tests, so the daemon consumes this adapter and tests
/// consume `ScriptedInputEventSource`. When the permission is denied the
/// monitor stays silent (no access → no events), which degrades C33 to
/// operation-right mutual exclusion only — the honest降级 documented in
/// spec v2.0 §17.2.
public final class CGEventInputMonitor: InputEventSource {

    private let eventsBuffer = LockedEventBuffer()
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    /// Only `.human` events are enqueued: the AX-synthesized `.agent` events
    /// are attributed by the engine already and must not count as real user
    /// input (spec v2.0 §15.2).
    private func installTap() -> Bool {
        let callback: CGEventTapCallBack = { _, _, event, context in
            guard let context else { return Unmanaged.passUnretained(event) }
            let monitor = Unmanaged<CGEventInputMonitor>.fromOpaque(context).takeUnretainedValue()
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
            return false
        }
        eventTap = tap
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        if let runLoopSource {
            CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        }
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    fileprivate func enqueue(_ event: CGEvent) {
        let timestamp = Date().timeIntervalSince1970
        eventsBuffer.push(InputEvent(timestamp: timestamp, source: .human))
    }

    // MARK: - InputEventSource

    public func nextEvent() -> InputEvent? {
        eventsBuffer.pop()
    }

    public func peekAvailable() -> [InputEvent] {
        eventsBuffer.snapshot()
    }

    // MARK: - Lifecycle

    /// Starts the tap on the calling run loop (dispatch to an event queue).
    /// Returns false when the tap cannot be created (permission denied).
    @discardableResult
    public func start() -> Bool {
        installTap()
    }

    /// Installs the tap on a dedicated background thread with its own run
    /// loop and keeps that loop pumped. The daemon main thread blocks in
    /// `server.run()`, so tapping the *current* loop there would silently
    /// deliver zero events — this is the shape the daemon must use.
    /// Returns false when the tap cannot be created (Input Monitoring TCC
    /// not granted): the caller degrades to operation-right mutex only.
    public func startOnBackgroundRunLoop() -> Bool {
        let ready = DispatchSemaphore(value: 0)
        var installed = false
        let thread = Thread { [weak self] in
            guard let self else {
                ready.signal()
                return
            }
            installed = self.installTap()
            ready.signal()
            if installed {
                RunLoop.current.run()
            }
        }
        thread.name = "glasspane.c33.input-monitor"
        thread.start()
        ready.wait()
        return installed
    }

    public func stop() {
        // Tap delivery runs on the background thread's loop; invalidating the
        // mach port from any thread stops callbacks (CFMachPort is
        // thread-safe for invalidation).
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
            CFMachPortInvalidate(eventTap)
        }
        eventTap = nil
        runLoopSource = nil
    }

    public init() {}
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