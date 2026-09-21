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
// lock + O(1) socket write — no reflection on the hot path (reflection work
// happens only on daemon-pulled commands, op_end mirror diffs included).

public enum GP {
    static let runtime = ProbeRuntime()

    /// Connect to the daemon probe socket and start the reader thread.
    /// Safe to call twice (second call is a no-op). Never throws: a missing
    /// daemon degrades to local buffering — the app runs untouched (Z1 hits
    /// still count, delivery resumes on the next `start()` retry window).
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
    public static func registerMirrorRoot(label: String, object: AnyObject) {
        runtime.registerMirrorRoot(label: label, object: object)
    }

    /// Z3: register an NSObject subclass with @objc dynamic keys for live
    /// KVO state events (and optional KVC write-back checkpoints).
    public static func registerKVCObject(_ object: NSObject, label: String, keys: [String]) {
        runtime.registerKVCObject(object, label: label, keys: keys)
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

    /// Test/smoke hook: current drop counter (frames lost while offline).
    public static var droppedEventCount: Int { runtime.droppedEventCount }
}

// MARK: - Runtime

/// Lock-guarded throughout (NSLock around every mutable field), hence
/// `@unchecked Sendable` for Swift 6 strict-concurrency consumers.
final class ProbeRuntime: @unchecked Sendable {

    static let probeVersion = "gp-probe/0.1.0"
    static let reconnectAttempts = 3
    static let reconnectIntervalMs = 1000
    static let offlineBufferLimit = 256
    static let checkpointRetention = 8

    private let lock = NSLock()
    private var fd: Int32 = -1
    private var started = false
    private var appNameValue = ""
    private var bundleIdValue: String?
    private var offlineBuffer: [[String: Any]] = []
    private var dropped = 0
    private var readerRunning = false

    // Registration surfaces.
    private var mirrorRoots: [(label: String, object: AnyObject)] = []
    private var kvObserver: KVCObserver?
    private var checkpoints: [(domain: String, get: () -> [String: String], set: (([String: String]) -> Void)?)] = []
    private var retainedCheckpoints: [(ref: String, domains: [String: [String: String]])] = []
    private var lastMirrorExport: [String: String] = [:]

    init() {}

    var droppedEventCount: Int {
        lock.lock(); defer { lock.unlock() }
        return dropped
    }

    // MARK: Connection

    func start(socketPath: String?, appName: String?) {
        lock.lock()
        guard !started else { lock.unlock(); return }
        started = true
        lock.unlock()

        appNameValue = appName ?? ProcessInfo.processInfo.processName
        bundleIdValue = Bundle.main.bundleIdentifier
        let path = socketPath
            ?? ProcessInfo.processInfo.environment["GLASSPANE_PROBE_SOCK"]
            ?? (NSHomeDirectory() + "/.glasspane/probe.sock")

        connectAndServe(path: path)
    }

    private func connectAndServe(path: String) {
        // Connect with bounded retries; the reader thread keeps serving on
        // the same connection and re-connects (once per dropout) thereafter.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            for attempt in 0..<ProbeRuntime.reconnectAttempts {
                let descriptor = connect(to: path)
                if descriptor >= 0 {
                    self.lock.lock()
                    self.fd = descriptor
                    self.lock.unlock()
                    self.sendHello()
                    self.drainOfflineBuffer()
                    self.readLoop(path: path)
                    return
                }
                Thread.sleep(forTimeInterval: Double(ProbeRuntime.reconnectIntervalMs) / 1000.0 * Double(attempt + 1))
            }
            // Offline: Z1 hits still buffer locally up to the cap, then drop
            // with a counter — never a crash, never a fake "delivered".
            self.lock.lock()
            self.fd = -1
            self.lock.unlock()
        }
    }

    private func sendHello() {
        var payload: [String: Any] = [
            "t": "hello",
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "appName": appNameValue,
            "probeVersion": ProbeRuntime.probeVersion,
            "capabilities": currentCapabilities()
        ]
        if let bundleIdValue { payload["bundleId"] = bundleIdValue }
        writeFrame(payload)
    }

    private func currentCapabilities() -> [String] {
        lock.lock(); defer { lock.unlock() }
        var capabilities = ["z1"]
        if !mirrorRoots.isEmpty { capabilities.append("z2") }
        if kvObserver != nil { capabilities.append("z3") }
        if checkpoints.contains(where: { $0.set != nil }) || kvObserver != nil { capabilities.append("checkpoint") }
        return capabilities
    }

    private func readLoop(path: String) {
        readerRunning = true
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: 64 * 1024, alignment: 16)
        defer { buffer.deallocate() }
        var partial = Data()
        while true {
            lock.lock()
            let currentFD = fd
            lock.unlock()
            guard currentFD >= 0 else { return }
            let received = read(currentFD, buffer, 64 * 1024)
            if received <= 0 {
                // Daemon restarted or connection lost: try once to reconnect.
                let next = connect(to: path)
                if next >= 0 {
                    lock.lock()
                    fd = next
                    lock.unlock()
                    sendHello()
                    continue
                }
                lock.lock()
                fd = -1
                lock.unlock()
                return
            }
            partial.append(Data(bytes: buffer, count: received))
            while let newline = partial.firstIndex(of: UInt8(ascii: "\n")) {
                let line = partial[partial.startIndex..<newline]
                partial.removeSubrange(partial.startIndex...newline)
                if let object = try? JSONSerialization.jsonObject(with: Data(line)),
                   let dict = object as? [String: Any] {
                    handleCommand(dict)
                }
            }
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
        mirrorRoots.append((label, object))
        lock.unlock()
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
    }

    func registerCheckpoint(domain: String, get: @escaping () -> [String: String], set: (([String: String]) -> Void)?) {
        lock.lock()
        checkpoints.removeAll { $0.domain == domain }
        checkpoints.append((domain, get, set))
        lock.unlock()
    }

    // MARK: State export (Z2 Mirror walk, bounded §1)

    func exportMirrorState() -> [String: String] {
        lock.lock()
        let roots = mirrorRoots
        let checkpointGets = checkpoints
        lock.unlock()
        var exported: [String: String] = [:]
        for (label, object) in roots {
            MirrorWalk.flatten(object, label: label, maxDepth: 8, maxNodes: 4000, into: &exported)
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
        lock.unlock()
        let written = line.withUnsafeBytes { raw in
            write(currentFD, raw.baseAddress, raw.count)
        }
        if written <= 0 {
            lock.lock()
            fd = -1 // treat as dropout; reader thread handles reconnect once
            lock.unlock()
        }
    }

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

    internal func resetForTests() {
        lock.lock(); defer { lock.unlock() }
        fd = -1
        started = false
        offlineBuffer = []
        dropped = 0
        mirrorRoots = []
        kvObserver = nil
        checkpoints = []
        retainedCheckpoints = []
        lastMirrorExport = [:]
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

final class KVCObserver: NSObject {
    private struct Target {
        let object: NSObject
        let label: String
        let keys: [String]
    }
    private var targets: [Target] = []
    private let emit: (_ key: String, _ before: String, _ after: String) -> Void
    private let emitLock = NSLock()

    init(emit: @escaping (_ key: String, _ before: String, _ after: String) -> Void) {
        self.emit = emit
    }

    func attach(_ object: NSObject, label: String, keys: [String]) {
        emitLock.lock()
        targets.append(Target(object: object, label: label, keys: keys))
        emitLock.unlock()
        for key in keys {
            object.addObserver(
                self, forKeyPath: key,
                options: [.old, .new],
                context: nil
            )
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
    return fd
}
