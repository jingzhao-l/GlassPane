import Foundation
import CryptoKit
#if canImport(Metal)
import Metal
#endif

// GlassPaneProbe runtime — P6 spec v6.0 §4/§6.
//
// Lives inside the app under test. Speaks the §2 wire format to the daemon's
// probe socket: registers on connect, streams Z1 handler / Z2+Z3 state
// events, answers checkpoint and Metal-capture commands. Event emission is a
// lock + O(1) hand-off to the probe's own serial write queue — no reflection on
// the hot path (reflection work happens only on daemon-pulled commands, op_end
// mirror diffs included) — and nothing on it may hurt the host:
//   * descriptors are created with SO_NOSIGPIPE, so a write after the daemon
//     vanished cannot raise SIGPIPE in the app under test (the daemon may
//     afford `signal(SIGPIPE, SIG_IGN)` for itself; a library that changes the
//     signal disposition of somebody else's process may not);
//   * the descriptor is non-blocking and every write waits on POLLOUT inside a
//     bounded budget, so a daemon that stopped draining costs one counted drop
//     instead of a hung thread (SO_SNDTIMEO/SO_RCVTIMEO are not assumed to be
//     implemented);
// Losses stay observable (GP.droppedEventCount / GP.droppedWriteCount) and are
// announced in `hello`, so "the handler did not run" can be told apart from
// "the probe could not deliver".

public enum GP {
    static let runtime = ProbeRuntime()

    /// Connect to the daemon probe socket and start the reader thread.
    /// Safe to call twice (second call is a no-op). Never throws: a missing
    /// daemon degrades to local buffering — the app runs untouched (Z1 hits
    /// still count). The connection thread keeps re-arming with a bounded
    /// backoff for the life of the process, so an app that started before the
    /// daemon is served as soon as it appears; buffered frames drain onto the
    /// new connection, and what did not fit shows up in `droppedEventCount`.
    public static func start(socketPath: String? = nil, appName: String? = nil) {
        runtime.start(socketPath: socketPath, appName: appName)
    }

    /// Z1 handler record (the macro expands into `instrument`).
    public static func recordHandler(file: String = #fileID, line: Int = #line) {
        runtime.emitHandler(file: file, line: line, durationNs: nil)
    }

    /// Z1 manual state report — explicit instrumentation without reflection
    /// (P6 §1: Z1 means "author-annotated"; the macro is its syntactic
    /// sugar, this is its no-plugin-cost form — the C1 opt-in path when the
    /// macro build inflation exceeds threshold, P6 §8 H7). `source` stays in
    /// the schema's z1-macro lane: same author-declared evidence strength.
    public static func recordState(key: String, before: String, after: String) {
        runtime.emitState(key: key, before: before, after: after, source: "z1-macro")
    }

    /// Wrap an expression: record entry, evaluate, record duration (>1ms).
    public static func instrument<T>(file: String, line: Int, body: () throws -> T) rethrows -> T {
        let started = DispatchTime.now().uptimeNanoseconds
        runtime.emitHandler(file: file, line: line, durationNs: nil)
        let value = try body()
        let duration = DispatchTime.now().uptimeNanoseconds - started
        if duration > 1_000_000 {
            runtime.emitHandler(file: file, line: line, durationNs: Int(duration))
        }
        return value
    }

    /// Z2: register an object for Mirror export (checkpoint domains and
    /// op-window state diffs). Read-only unless a checkpoint setter exists.
    /// The probe holds it *weakly*: exporting the state of an object the app
    /// already released would attribute a diff to dead state.
    public static func registerMirrorRoot(label: String, object: AnyObject) {
        runtime.registerMirrorRoot(label: label, object: object)
    }

    /// Z3: register an NSObject subclass with @objc dynamic keys for live
    /// KVO state events (and optional KVC write-back checkpoints). Held
    /// weakly — see `detachKVCObject`.
    public static func registerKVCObject(_ object: NSObject, label: String, keys: [String]) {
        runtime.registerKVCObject(object, label: label, keys: keys)
    }

    /// Stop observing an object registered through `registerKVCObject` and
    /// release the probe's reference to it (removes the KVO observers). false =
    /// never registered. Detach before letting go of a registered model:
    /// releasing an object that is still observed relies on Foundation tearing
    /// the registration down with it.
    @discardableResult
    public static func detachKVCObject(_ object: NSObject) -> Bool {
        runtime.detachKVCObject(object)
    }

    /// Tier-1 checkpoint domain (P6 §6.4): `get` exports string state,
    /// `set` writes it back (nil ⇒ export-only, never claimed restorable).
    public static func registerCheckpoint(
        domain: String,
        get: @escaping () -> [String: String],
        set: (([String: String]) -> Void)?
    ) {
        runtime.registerCheckpoint(domain: domain, get: get, set: set)
    }

    /// Forget a checkpoint domain (its `get`/`set` closures keep whatever they
    /// capture, so this is the only way to release them). false = not registered.
    @discardableResult
    public static func detachCheckpoint(domain: String) -> Bool {
        runtime.detachCheckpoint(domain: domain)
    }

    /// Z4.5 capture 结果监听（进程内自动化用：帧照常发往 daemon，钩子让
    /// spike/冒烟能在 app 侧记录 path/error，无需第二个 daemon 方法面）。
    public static var onMetalCaptureResult: ((String?, String?) -> Void)?

    /// Z4.5: programmatic Metal capture via MTLCaptureManager.
    public static func beginMetalCapture(destinationURL: URL? = nil) {
        runtime.beginMetalCapture(destinationURL: destinationURL)
    }

    public static func endMetalCapture() {
        runtime.endMetalCapture()
    }

    /// Test/smoke hook: frames lost while offline, i.e. the local buffer hit
    /// its cap before the daemon came back.
    public static var droppedEventCount: Int { runtime.droppedEventCount }

    /// Frames handed to the socket that never arrived: a write that timed out
    /// or came back short, and frames refused because the probe's write queue
    /// was full. Delivery losses, never an error thrown into the host.
    public static var droppedWriteCount: Int { runtime.droppedWriteCount }

    /// Frames still waiting in the offline buffer for the next connection.
    public static var bufferedEventCount: Int { runtime.bufferedEventCount }

    /// Whether a live daemon connection backs the probe right now — with the
    /// two drop counters, what separates "no hits" from "could not report".
    public static var isConnected: Bool { runtime.isConnected }
}

// MARK: - Runtime

/// Lock-guarded throughout (NSLock around every mutable field), hence
/// `@unchecked Sendable` for Swift 6 strict-concurrency consumers.
final class ProbeRuntime: @unchecked Sendable {

    static let probeVersion = "gp-probe/0.1.0"
    static let reconnectAttempts = 3
    static let reconnectIntervalMs = 1000
    /// Wait after a *whole* failed cycle. P6 §2.1 fixes the per-attempt backoff
    /// (1s×3) but cannot mean "latch the probe off", since "app started before
    /// daemon" is the ordinary case — so the cycle repeats after this gap.
    static let reconnectCycleIntervalMs = 30_000
    static let offlineBufferLimit = 256
    /// Serial write queue cap — larger than the offline buffer, so a reconnect
    /// drain is never itself the overflow.
    static let queuedWriteLimit = 512
    /// Per-frame write budget (POLLOUT waits + writes must finish inside it).
    static let sendTimeoutMs = 250
    /// How long the reader waits in poll() before re-checking the connection.
    static let receiveTimeoutMs = 2_000
    static let checkpointRetention = 8

    /// Backoff after a failed attempt inside one cycle (P6 §2.1: 1s, 2s, 3s).
    static func attemptBackoffMs(afterFailedAttempt attempt: Int) -> Int {
        max(1, attempt + 1) * reconnectIntervalMs
    }

    /// Weak slot wrapper: a struct cannot hold a `weak` member, and the probe
    /// must not keep the app's model objects alive.
    private final class MirrorRoot {
        let label: String
        weak var object: AnyObject?

        init(label: String, object: AnyObject) {
            self.label = label
            self.object = object
        }
    }

    private let lock = NSLock()
    /// Every socket write serializes here: the emitting thread (any thread of
    /// the app under test) only enqueues, so a daemon that stopped draining can
    /// neither hang the host nor interleave two half-written frames.
    private let writeQueue = DispatchQueue(label: "glasspane.probe.write", qos: .utility)
    private var connectionThread: Thread?
    private var fd: Int32 = -1
    private var started = false
    private var stopped = false
    private var connectionGeneration = 0
    private var failedCycles = 0
    private var queuedWrites = 0
    private var appNameValue = ""
    private var bundleIdValue: String?
    private var offlineBuffer: [[String: Any]] = []
    private var dropped = 0
    private var droppedWrites = 0
    private var readerRunning = false
    private var advertisedCapabilities: [String] = []

    // Registration surfaces.
    private var mirrorRoots: [MirrorRoot] = []
    private var kvObserver: KVCObserver?
    private var checkpoints: [(domain: String, get: () -> [String: String], set: (([String: String]) -> Void)?)] = []
    private var retainedCheckpoints: [(ref: String, domains: [String: [String: String]])] = []
    private var lastMirrorExport: [String: String] = [:]

    /// Test/smoke seam: shrinks both backoff waits so a re-arm can be observed
    /// without sleeping the real 1s×3 + 30s schedule.
    var backoffOverrideMs: Int? {
        get { lock.lock(); defer { lock.unlock() }; return backoffOverrideStorage }
        set { lock.lock(); backoffOverrideStorage = newValue; lock.unlock() }
    }
    private var backoffOverrideStorage: Int?

    init() {}

    var droppedEventCount: Int {
        lock.lock(); defer { lock.unlock() }
        return dropped
    }

    var droppedWriteCount: Int {
        lock.lock(); defer { lock.unlock() }
        return droppedWrites
    }

    var bufferedEventCount: Int {
        lock.lock(); defer { lock.unlock() }
        return offlineBuffer.count
    }

    var isConnected: Bool {
        lock.lock(); defer { lock.unlock() }
        return fd >= 0
    }
    // MARK: Connection

    func start(socketPath: String?, appName: String?) {
        lock.lock()
        guard !started else { lock.unlock(); return }
        started = true
        stopped = false
        connectionGeneration += 1
        let generation = connectionGeneration
        appNameValue = appName ?? ProcessInfo.processInfo.processName
        bundleIdValue = Bundle.main.bundleIdentifier
        lock.unlock()

        let path = socketPath
            ?? ProcessInfo.processInfo.environment["GLASSPANE_PROBE_SOCK"]
            ?? (NSHomeDirectory() + "/.glasspane/probe.sock")

        let thread = Thread { [weak self] in self?.serveConnections(path: path, generation: generation) }
        thread.name = "glasspane.probe.connection"
        lock.lock()
        connectionThread = thread
        lock.unlock()
        thread.start()
    }

    /// connect → hello → drain → read, for the life of the process. Every exit
    /// from a connection comes back through here, so a reconnect always
    /// re-announces, re-drains and starts from an empty read buffer — the
    /// mid-session shortcut that stranded buffered evidence is gone by
    /// construction.
    private func serveConnections(path: String, generation: Int) {
        while !isSuperseded(generation) {
            let descriptor = connectWithBackoff(path: path, generation: generation)
            guard descriptor >= 0 else { continue }
            lock.lock()
            if stopped || generation != connectionGeneration {
                lock.unlock()
                close(descriptor) // freshly created: nobody else can reference it
                return
            }
            fd = descriptor
            lock.unlock()

            sendHello()
            drainOfflineBuffer()
            readLoop(descriptor: descriptor)
            teardown(descriptor)
        }
    }

    private func isSuperseded(_ generation: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return stopped || generation != connectionGeneration
    }

    /// Bounded connect attempts per P6 §2.1; -1 means "this whole cycle failed",
    /// and the caller re-arms rather than giving up.
    private func connectWithBackoff(path: String, generation: Int) -> Int32 {
        for attempt in 0..<ProbeRuntime.reconnectAttempts {
            if isSuperseded(generation) { return -1 }
            let descriptor = connect(to: path)
            if descriptor >= 0 { return descriptor }
            Thread.sleep(forTimeInterval: TimeInterval(backoffMs(attempt: attempt)) / 1000.0)
        }
        lock.lock()
        failedCycles += 1
        lock.unlock()
        Thread.sleep(forTimeInterval: TimeInterval(cycleBackoffMs) / 1000.0)
        return -1
    }

    private func backoffMs(attempt: Int) -> Int {
        lock.lock(); let override = backoffOverrideStorage; lock.unlock()
        return override ?? ProbeRuntime.attemptBackoffMs(afterFailedAttempt: attempt)
    }

    private var cycleBackoffMs: Int {
        lock.lock(); defer { lock.unlock() }
        return backoffOverrideStorage ?? ProbeRuntime.reconnectCycleIntervalMs
    }

    /// Retire one connection: the shared descriptor goes first (later writes
    /// then fall back to the offline buffer), and the close is sequenced *on
    /// the write queue* so the number can never be recycled under a write that
    /// is still in flight on it.
    private func teardown(_ descriptor: Int32) {
        lock.lock()
        let owns = fd == descriptor
        if owns { fd = -1 }
        readerRunning = false
        lock.unlock()
        if owns { closeDeferred(descriptor) }
    }

    private func closeDeferred(_ descriptor: Int32) {
        writeQueue.async { close(descriptor) }
    }

    private func sendHello() {
        lock.lock()
        let capabilities = currentCapabilitiesLocked()
        let offlineDropped = dropped
        let writeDropped = droppedWrites
        let appName = appNameValue
        let bundleId = bundleIdValue
        advertisedCapabilities = capabilities
        lock.unlock()

        var payload: [String: Any] = [
            "t": "hello",
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "appName": appName,
            "probeVersion": ProbeRuntime.probeVersion,
            "capabilities": capabilities,
            // §2.2 registration lane, optional keys (the daemon's decoder
            // tolerates unknown fields): they are what lets a daemon-side
            // "0 handler hits" be read as "0 hits" instead of "N frames never
            // delivered".
            "droppedEvents": offlineDropped,
            "droppedWrites": writeDropped
        ]
        if let bundleId { payload["bundleId"] = bundleId }
        writeFrame(payload)
    }

    /// Capabilities only travel in `hello`, so anything registered after the
    /// connection was accepted has to re-announce itself or the daemon keeps
    /// serving against a stale set (P6 §2.2: a repeated hello replaces the
    /// registration). Only a *changed* set is re-sent: a registration burst
    /// costs one frame, and the daemon's per-pid event ring is not replaced for
    /// nothing.
    private func advertiseCapabilities() {
        lock.lock()
        let changed = fd >= 0 && currentCapabilitiesLocked() != advertisedCapabilities
        lock.unlock()
        guard changed else { return }
        sendHello()
    }

    private func currentCapabilitiesLocked() -> [String] {
        var capabilities = ["z1"]
        if mirrorRoots.contains(where: { $0.object != nil }) { capabilities.append("z2") }
        let observesLiveObjects = kvObserver?.hasLiveTargets == true
        if observesLiveObjects { capabilities.append("z3") }
        if checkpoints.contains(where: { $0.set != nil }) || observesLiveObjects {
            capabilities.append("checkpoint")
        }
        return capabilities
    }

    /// Reads daemon commands until this connection is gone. The wait is bounded
    /// by `receiveTimeoutMs`, so a descriptor the write side already retired is
    /// noticed here instead of parking the connection thread forever.
    private func readLoop(descriptor: Int32) {
        lock.lock()
        readerRunning = true
        lock.unlock()
        defer {
            lock.lock()
            readerRunning = false
            lock.unlock()
        }
        let capacity = 64 * 1024
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: 16)
        defer { buffer.deallocate() }
        // Per connection, never carried over: leftover bytes of the old stream
        // must not be glued onto the front of the new one.
        var partial = Data()
        let readInterval = Double(ProbeRuntime.receiveTimeoutMs) / 1000.0
        while true {
            lock.lock()
            let currentFD = fd
            lock.unlock()
            if currentFD != descriptor { return }
            // The descriptor is non-blocking, so the wait is explicit — and
            // waking on an interval is what lets a descriptor the write side
            // already retired be noticed instead of parking the reader.
            guard let revents = waitReady(descriptor, events: Int16(POLLIN),
                                          deadline: Date().addingTimeInterval(readInterval)) else {
                continue // quiet daemon: staleness re-checked at the loop top
            }
            if revents & Int16(POLLIN) == 0 { return } // POLLHUP/POLLERR: daemon restarted or gone
            let received = read(descriptor, buffer, capacity)
            if received > 0 {
                partial.append(Data(bytes: buffer, count: received))
                while let newline = partial.firstIndex(of: UInt8(ascii: "\n")) {
                    let line = partial[partial.startIndex..<newline]
                    partial.removeSubrange(partial.startIndex...newline)
                    if let object = try? JSONSerialization.jsonObject(with: Data(line)),
                       let dict = object as? [String: Any] {
                        handleCommand(dict)
                    }
                }
                continue
            }
            if received < 0, errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR {
                continue
            }
            return // EOF or a real read error
        }
    }

    // MARK: Commands (§2.2)

    func handleCommand(_ dict: [String: Any]) {
        switch dict["t"] as? String {
        case "op_begin":
            // Z2 baseline for the act window's diff (§6.2).
            let exported = exportMirrorState()
            lock.lock()
            lastMirrorExport = exported
            lock.unlock()
        case "op_end":
            let current = exportMirrorState()
            lock.lock()
            let baseline = lastMirrorExport
            lastMirrorExport = current
            lock.unlock()
            for (key, value) in current.sorted(by: { $0.key < $1.key }) {
                let before = baseline[key]
                if before != value {
                    emitState(key: key, before: before ?? "∅", after: value, source: "z2-mirror")
                }
            }
            for key in baseline.keys.sorted() where current[key] == nil {
                emitState(key: key, before: baseline[key] ?? "", after: "∅", source: "z2-mirror")
            }
        case "checkpoint_export":
            let ref = dict["ref"] as? String ?? ""
            let domains = exportCheckpointDomains()
            var retained = retainedCheckpoints
            retained.removeAll { $0.ref == ref }
            retained.append((ref, domains))
            while retained.count > ProbeRuntime.checkpointRetention { retained.removeFirst() }
            lock.lock()
            retainedCheckpoints = retained
            lock.unlock()
            let digest = ProbeCanonical.sha256Hex(ProbeCanonical.checkpointJSON(domains))
            writeFrame(["t": "checkpoint", "ref": ref, "domains": domains, "digest": digest])
        case "checkpoint_restore":
            restoreCheckpoint(dict)
        case "capture_begin":
            let destination = (dict["destinationURL"] as? String).map { URL(fileURLWithPath: $0) }
            beginMetalCapture(destinationURL: destination)
        case "capture_end":
            endMetalCapture()
        default:
            break // hello_ack and unknown commands: no-op
        }
    }

    private func restoreCheckpoint(_ dict: [String: Any]) {
        let ref = dict["ref"] as? String ?? ""
        lock.lock()
        let entry = retainedCheckpoints.first { $0.ref == ref }
        let setters: [(String, (([String: String]) -> Void)?)] = checkpoints.map { ($0.domain, $0.set) }
        lock.unlock()
        guard let entry else {
            writeFrame(["t": "result", "ok": false, "postStateDigest": NSNull(), "error": "checkpoint '\(ref)' evicted or unknown (retention \(ProbeRuntime.checkpointRetention))"])
            return
        }
        let requested = (dict["domains"] as? [String]) ?? Array(entry.domains.keys)
        var missing: [String] = []
        var setterMissing: [String] = []
        let setterMap = Dictionary(uniqueKeysWithValues: setters.map { ($0.0, $0.1) })
        for domain in requested.sorted() {
            guard let values = entry.domains[domain] else { missing.append(domain); continue }
            guard let maybeSetter = setterMap[domain], let set = maybeSetter else {
                setterMissing.append(domain)
                continue
            }
            set(values)
        }
        if !missing.isEmpty || !setterMissing.isEmpty {
            var issues: [String] = []
            if !missing.isEmpty { issues.append("domains not retained: \(missing.joined(separator: ","))") }
            if !setterMissing.isEmpty { issues.append("domains without setter (Z1b-style unobservable writes): \(setterMissing.joined(separator: ","))") }
            writeFrame(["t": "result", "ok": false, "postStateDigest": NSNull(), "error": issues.joined(separator: "; ")])
            return
        }
        let post = exportCheckpointDomains()
        let filtered = post.filter { requested.contains($0.key) }
        let digest = ProbeCanonical.sha256Hex(ProbeCanonical.checkpointJSON(filtered))
        writeFrame(["t": "result", "ok": true, "postStateDigest": digest, "error": NSNull()])
    }

    // MARK: Registration

    func registerMirrorRoot(label: String, object: AnyObject) {
        lock.lock()
        mirrorRoots.removeAll { $0.object == nil }
        mirrorRoots.append(MirrorRoot(label: label, object: object))
        lock.unlock()
        advertiseCapabilities()
    }

    func registerKVCObject(_ object: NSObject, label: String, keys: [String]) {
        let observer: KVCObserver
        lock.lock()
        if let existing = kvObserver {
            observer = existing
        } else {
            observer = KVCObserver { [weak self] key, before, after in
                self?.emitState(key: key, before: before, after: after, source: "z3-kvc")
            }
            kvObserver = observer
        }
        lock.unlock()
        observer.attach(object, label: label, keys: keys)
        advertiseCapabilities()
    }

    @discardableResult
    func detachKVCObject(_ object: NSObject) -> Bool {
        lock.lock()
        let observer = kvObserver
        lock.unlock()
        guard let observer, observer.detach(object) else { return false }
        lock.lock()
        if kvObserver?.hasLiveTargets != true { kvObserver = nil }
        lock.unlock()
        advertiseCapabilities()
        return true
    }

    func registerCheckpoint(domain: String, get: @escaping () -> [String: String], set: (([String: String]) -> Void)?) {
        lock.lock()
        checkpoints.removeAll { $0.domain == domain }
        checkpoints.append((domain, get, set))
        lock.unlock()
        advertiseCapabilities()
    }

    @discardableResult
    func detachCheckpoint(domain: String) -> Bool {
        lock.lock()
        let registered = checkpoints.contains { $0.domain == domain }
        checkpoints.removeAll { $0.domain == domain }
        lock.unlock()
        if registered { advertiseCapabilities() }
        return registered
    }

    // MARK: State export (Z2 Mirror walk, bounded §1)

    func exportMirrorState() -> [String: String] {
        lock.lock()
        let roots = mirrorRoots.compactMap { entry -> (label: String, object: AnyObject)? in
            guard let object = entry.object else { return nil }
            return (entry.label, object)
        }
        let checkpointGets = checkpoints
        lock.unlock()
        var exported: [String: String] = [:]
        for root in roots {
            MirrorWalk.flatten(root.object, label: root.label, maxDepth: 8, maxNodes: 4000, into: &exported)
        }
        for checkpoint in checkpointGets {
            for (key, value) in checkpoint.get() {
                exported["\(checkpoint.domain).\(key)"] = value
            }
        }
        return exported
    }

    func exportCheckpointDomains() -> [String: [String: String]] {
        lock.lock()
        let domains = checkpoints
        lock.unlock()
        var table: [String: [String: String]] = [:]
        for entry in domains {
            table[entry.domain] = entry.get()
        }
        return table
    }

    // MARK: Event emission

    func emitHandler(file: String, line: Int, durationNs: Int?) {
        var frame: [String: Any] = [
            "t": "handler", "file": file, "line": line,
            "ts": Date().timeIntervalSince1970
        ]
        if let durationNs { frame["durationNs"] = durationNs }
        writeFrame(frame)
    }

    func emitState(key: String, before: String, after: String, source: String) {
        writeFrame([
            "t": "state", "key": key,
            "before": String(before.prefix(1024)), "after": String(after.prefix(1024)),
            "source": source, "ts": Date().timeIntervalSince1970
        ])
    }

    /// Hand the frame to the probe's write queue. The emitting thread never
    /// touches the socket: it either appends to the offline buffer, enqueues a
    /// bounded write, or counts a drop — O(1), non-blocking, throw-free.
    private func writeFrame(_ frame: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys]) else { return }
        var line = data
        line.append(UInt8(ascii: "\n"))
        lock.lock()
        let currentFD = fd
        if currentFD < 0 {
            if offlineBuffer.count < ProbeRuntime.offlineBufferLimit {
                offlineBuffer.append(frame)
            } else {
                dropped += 1
            }
            lock.unlock()
            return
        }
        if queuedWrites >= ProbeRuntime.queuedWriteLimit {
            droppedWrites += 1
            lock.unlock()
            return
        }
        queuedWrites += 1
        lock.unlock()
        writeQueue.async { [weak self] in
            self?.deliver(line: line, snapshotFD: currentFD)
        }
    }

    /// Serialized socket write, off the host's thread and bounded by
    /// `sendTimeoutMs` (the descriptor is non-blocking; POLLOUT carries the
    /// wait). A line that cannot be written whole is a drop *and* a broken
    /// stream — half a newline-delimited frame can never be trusted again — so
    /// the descriptor is retired here and the connection thread reconnects (and
    /// re-drains) on its next pass. Never an exception into the app under test.
    private func deliver(line: Data, snapshotFD: Int32) {
        defer {
            lock.lock()
            queuedWrites -= 1
            lock.unlock()
        }
        lock.lock()
        let live = fd == snapshotFD
        lock.unlock()
        guard live else {
            countDroppedWrite()
            return
        }
        let deadline = Date().addingTimeInterval(Double(ProbeRuntime.sendTimeoutMs) / 1000.0)
        let delivered = line.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            guard let base = raw.baseAddress else { return false }
            var offset = 0
            while offset < raw.count {
                let room = raw.count - offset
                let revents = waitReady(snapshotFD, events: Int16(POLLOUT), deadline: deadline) ?? 0
                guard revents & Int16(POLLOUT) != 0 else { return false } // daemon stopped draining: bounded, not hung
                let written = Darwin.write(snapshotFD, base.advanced(by: offset), room)
                if written > 0 { offset += written; continue }
                if written < 0, errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR { continue }
                return false // EPIPE / EBADF: peer gone — and no SIGPIPE, thanks to SO_NOSIGPIPE
            }
            return true
        }
        guard delivered else {
            countDroppedWrite()
            lock.lock()
            if fd == snapshotFD { fd = -1 }
            lock.unlock()
            return
        }
    }

    private func countDroppedWrite() {
        lock.lock()
        droppedWrites += 1
        lock.unlock()
    }

    /// Waits until the descriptor is ready for `events`, never past `deadline`.
    /// nil means "not yet" (the caller re-checks its own state and tries again);
    /// a poll failure comes back as POLLERR so a reader can tell quiet from gone.
    private func waitReady(_ descriptor: Int32, events: Int16, deadline: Date) -> Int16? {
        let remaining = Int32(max(0, deadline.timeIntervalSinceNow * 1000))
        guard remaining > 0 else { return nil }
        var slot = pollfd(fd: descriptor, events: events, revents: 0)
        let ready = poll(&slot, 1, remaining)
        if ready > 0 { return slot.revents }
        if ready < 0, errno != EINTR { return Int16(POLLERR) }
        return nil
    }

    /// Called by the connection thread right after `hello`, on *every* connect —
    /// first one and reconnect alike. Buffered evidence has to reach the daemon
    /// or it must show up as a drop; silently ageing out at the buffer cap is
    /// what turned "the probe could not deliver" into "the handler did not run".
    private func drainOfflineBuffer() {
        lock.lock()
        let buffered = offlineBuffer
        offlineBuffer = []
        lock.unlock()
        for frame in buffered {
            writeFrame(frame)
        }
    }

    // MARK: Test hooks (unit tests exercise the runtime without a socket)

    internal func debugOfflineSnapshot() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return offlineBuffer
    }

    internal var debugIsReaderRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return readerRunning
    }

    internal var debugFailedCycleCount: Int {
        lock.lock(); defer { lock.unlock() }
        return failedCycles
    }

    internal var debugCapabilities: [String] {
        lock.lock(); defer { lock.unlock() }
        return currentCapabilitiesLocked()
    }

    internal var debugKVCRegisteredCount: Int {
        kvObserver?.debugTargetCount ?? 0
    }

    /// Test hook: adopt an already-connected descriptor (a socketpair end) so
    /// the delivery path can be watched without a daemon. Configured exactly
    /// like a connected socket, so an unprotected descriptor cannot sneak
    /// through the tests. Returns false when the probe's own socket options
    /// are refused.
    @discardableResult
    internal func attachSocketForTests(_ descriptor: Int32) -> Bool {
        guard configureSocket(descriptor) else {
            close(descriptor)
            return false
        }
        lock.lock()
        fd = descriptor
        lock.unlock()
        return true
    }

    internal func resetForTests() {
        lock.lock()
        // Invalidate any running connection thread first: it must not come back
        // to life under a later test and drain that test's offline buffer.
        stopped = true
        connectionGeneration += 1
        let descriptor = fd
        fd = -1
        started = false
        queuedWrites = 0
        offlineBuffer = []
        dropped = 0
        droppedWrites = 0
        advertisedCapabilities = []
        backoffOverrideStorage = nil
        let observer = kvObserver
        kvObserver = nil
        mirrorRoots = []
        checkpoints = []
        retainedCheckpoints = []
        lastMirrorExport = [:]
        lock.unlock()
        // Detach rather than orphan: dropping the reference leaves the KVO
        // registrations alive on live objects, and the orphan keeps emitting
        // state frames into whichever runtime comes next.
        observer?.detachAll()
        if descriptor >= 0 { closeDeferred(descriptor) }
    }

    // MARK: Metal (Z4.5)

    /// Active capture file path, reported back on capture_end (nil = none).
    private var metalCaptureURL: URL?

    private func emitCapture(path: String?, error: String?) {
        let hook = GP.onMetalCaptureResult
        var frame: [String: Any] = ["t": "capture"]
        frame["path"] = path ?? NSNull()
        frame["error"] = error ?? NSNull()
        writeFrame(frame)
        hook?(path, error)
    }

    func beginMetalCapture(destinationURL: URL?) {
        #if canImport(Metal)
        let manager = MTLCaptureManager.shared()
        guard let device = MTLCreateSystemDefaultDevice() else {
            emitCapture(path: nil, error: "no Metal device on this machine")
            return
        }
        guard manager.supportsDestination(.gpuTraceDocument) else {
            emitCapture(path: nil, error: "GPU capture unsupported (enable Metal capture in Graphics Inspector / device limitation)")
            return
        }
        let url = destinationURL
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("glasspane-capture-\(Int(Date().timeIntervalSince1970)).gputrace")
        let descriptor = MTLCaptureDescriptor()
        descriptor.captureObject = device
        descriptor.destination = .gpuTraceDocument
        descriptor.outputURL = url
        do {
            try manager.startCapture(with: descriptor)
            lock.lock()
            metalCaptureURL = url
            lock.unlock()
            emitCapture(path: url.path, error: nil)
        } catch {
            emitCapture(path: nil, error: "startCapture failed: \(error.localizedDescription)")
        }
        #else
        emitCapture(path: nil, error: "Metal unavailable in this build")
        #endif
    }

    func endMetalCapture() {
        #if canImport(Metal)
        lock.lock()
        let url = metalCaptureURL
        metalCaptureURL = nil
        lock.unlock()
        guard url != nil else {
            emitCapture(path: nil, error: "no capture in progress")
            return
        }
        MTLCaptureManager.shared().stopCapture()
        emitCapture(path: url?.path, error: nil)
        #else
        emitCapture(path: nil, error: "Metal unavailable in this build")
        #endif
    }
}

// MARK: - KVC observer (Z3)

/// Observes registered objects without owning them: the app under test must be
/// able to release a document/window model while it is still nominally
/// "instrumented", or every object ever registered stays alive forever and the
/// daemon's per-pid event ring fills with state from objects the app has
/// already thrown away.
final class KVCObserver: NSObject {
    /// Weak slot wrapper (a struct cannot hold a `weak` member): the observed
    /// object belongs to the app under test, not to the probe.
    private final class Target {
        weak var object: NSObject?
        let label: String
        let keys: [String]

        init(object: NSObject, label: String, keys: [String]) {
            self.object = object
            self.label = label
            self.keys = keys
        }
    }
    private var targets: [Target] = []
    private let emit: (_ key: String, _ before: String, _ after: String) -> Void
    private let emitLock = NSLock()

    init(emit: @escaping (_ key: String, _ before: String, _ after: String) -> Void) {
        self.emit = emit
    }

    deinit {
        emitLock.lock()
        let live = targets.compactMap { entry -> (object: NSObject, keys: [String])? in
            guard let object = entry.object else { return nil }
            return (object, entry.keys)
        }
        targets = []
        emitLock.unlock()
        for entry in live {
            for key in entry.keys { entry.object.removeObserver(self, forKeyPath: key) }
        }
    }

    /// Drops slots whose object has since been released. Caller holds `emitLock`.
    private func pruneLocked() {
        targets.removeAll { $0.object == nil }
    }

    var hasLiveTargets: Bool {
        emitLock.lock(); defer { emitLock.unlock() }
        pruneLocked()
        return !targets.isEmpty
    }

    var debugTargetCount: Int {
        emitLock.lock(); defer { emitLock.unlock() }
        pruneLocked()
        return targets.count
    }

    func attach(_ object: NSObject, label: String, keys: [String]) {
        emitLock.lock()
        pruneLocked()
        var replacedKeys: [String] = []
        if let index = targets.firstIndex(where: { $0.object === object }) {
            // Re-registering the same object replaces its key set: KVO raises
            // when the same keyPath is registered twice on one subject, and a
            // crash inside the app under test is the one thing this SDK
            // promises not to do.
            replacedKeys = targets[index].keys
            targets.remove(at: index)
        }
        targets.append(Target(object: object, label: label, keys: keys))
        emitLock.unlock()
        for key in replacedKeys where !keys.contains(key) {
            object.removeObserver(self, forKeyPath: key)
        }
        for key in keys where !replacedKeys.contains(key) {
            object.addObserver(self, forKeyPath: key, options: [.old, .new], context: nil)
        }
    }

    /// Removes this object's observers and its slot. Returns false when the
    /// object is not registered (including "already released by the app" — its
    /// weak slot simply disappears).
    @discardableResult
    func detach(_ object: NSObject) -> Bool {
        emitLock.lock()
        pruneLocked()
        guard let index = targets.firstIndex(where: { $0.object === object }) else {
            emitLock.unlock()
            return false
        }
        let keys = targets[index].keys
        targets.remove(at: index)
        emitLock.unlock()
        for key in keys { object.removeObserver(self, forKeyPath: key) }
        return true
    }

    /// Detaches everything still observable (test reset: never orphan an
    /// observer onto live objects).
    func detachAll() {
        emitLock.lock()
        let live = targets.compactMap { entry -> (object: NSObject, keys: [String])? in
            guard let object = entry.object else { return nil }
            return (object, entry.keys)
        }
        targets = []
        emitLock.unlock()
        for entry in live {
            for key in entry.keys { entry.object.removeObserver(self, forKeyPath: key) }
        }
    }

    override func observeValue(
        forKeyPath keyPath: String?,
        of object: Any?,
        change: [NSKeyValueChangeKey: Any]?,
        context: UnsafeMutableRawPointer?
    ) {
        guard let keyPath, let object = object as? NSObject else { return }
        emitLock.lock()
        let label = targets.first { $0.object === object }?.label ?? "kvc"
        emitLock.unlock()
        let before = change?[.oldKey].map { stringify($0) } ?? "∅"
        let after = change?[.newKey].map { stringify($0) } ?? "∅"
        emit("\(label).\(keyPath)", before, after)
    }

    private func stringify(_ value: Any) -> String {
        if let number = value as? NSNumber { return number.stringValue }
        return String(describing: value)
    }
}

// MARK: - Mirror walk (Z2)

enum MirrorWalk {
    static func flatten(
        _ root: AnyObject,
        label: String,
        maxDepth: Int,
        maxNodes: Int,
        into out: inout [String: String]
    ) {
        var budget = maxNodes
        flatten(Mirror(reflecting: root), path: label, depth: 0, maxDepth: maxDepth, budget: &budget, into: &out)
    }

    private static func flatten(
        _ mirror: Mirror,
        path: String,
        depth: Int,
        maxDepth: Int,
        budget: inout Int,
        into out: inout [String: String]
    ) {
        guard depth < maxDepth, budget > 0 else { return }
        for (maybeLabel, value) in mirror.children {
            // Anonymous children (ObjC `__p` pointers, unlabeled tuple
            // elements) get no stable key — skip rather than emit
            // `Optional("...")` noise into a wire-format key.
            guard let label = maybeLabel, !label.hasPrefix("__") else { continue }
            guard budget > 0 else { return }
            budget -= 1
            let key = "\(path).\(label)"
            let display = String(describing: value)
            // Leaf scalars are recorded verbatim; containers/objects recurse.
            switch value {
            case let nested as AnyObject where isReflectionWorthwhile(nested):
                out[key] = display
                flatten(Mirror(reflecting: nested), path: key, depth: depth + 1, maxDepth: maxDepth, budget: &budget, into: &out)
            default:
                out[key] = String(display.prefix(1024))
            }
        }
    }

    /// Avoid recursing through system objects that produce label-less noise
    /// (closures, internal Foundation machinery). Honest limit: we flatten
    /// named children only.
    private static func isReflectionWorthwhile(_ value: AnyObject) -> Bool {
        !(value is NSString) && !(value is NSNumber)
    }
}

// MARK: - Canonical JSON (mirrors GlassPaneEngine.ProbeWire §2 canonical)

enum ProbeCanonical {
    static func checkpointJSON(_ domains: [String: [String: String]]) -> String {
        let outer = domains.keys.sorted().map { domain -> String in
            let inner = domains[domain]!.keys.sorted().map { key in
                jsonString(key) + ":" + jsonString(domains[domain]![key]!)
            }
            return jsonString(domain) + ":{" + inner.joined(separator: ",") + "}"
        }
        return "{" + outer.joined(separator: ",") + "}"
    }

    static func sha256Hex(_ string: String) -> String {
        SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func jsonString(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

/// Per-socket safety options, installed before a descriptor reaches the
/// runtime; false means the descriptor is closed rather than kept, because an
/// unprotected socket is exactly the "probe killed the host" failure this file
/// promises against.
///
/// * `SO_NOSIGPIPE`: a write to a peer that vanished must not raise SIGPIPE in
///   the app under test. The daemon can afford `signal(SIGPIPE, SIG_IGN)` for
///   itself (it owns that process); an SDK embedded in somebody else's app may
///   not change the host's signal dispositions, so the protection is per
///   socket.
/// * `O_NONBLOCK`: makes the send and receive bounds explicit instead of
///   trusting `SO_SNDTIMEO`/`SO_RCVTIMEO` support (the writer waits on POLLOUT
///   up to `sendTimeoutMs`, the reader waits on POLLIN up to
///   `receiveTimeoutMs` and re-checks the connection in between).
internal func configureSocket(_ descriptor: Int32) -> Bool {
    var noSigpipe = Int32(1)
    guard setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size)) == 0
    else { return false }
    let flags = fcntl(descriptor, F_GETFL)
    guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else { return false }
    return true
}

private func connect(to path: String) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return -1 }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let ok = path.withCString { source in
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            guard let base = destination.baseAddress else { return false }
            _ = strncpy(base.assumingMemoryBound(to: CChar.self), source, destination.count)
            return true
        }
    }
    guard ok else { close(fd); return -1 }
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
            Darwin.connect(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if result != 0 {
        close(fd)
        return -1
    }
    guard configureSocket(fd) else {
        close(fd)
        return -1
    }
    return fd
}
