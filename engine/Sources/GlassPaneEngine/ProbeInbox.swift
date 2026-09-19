import Foundation

/// Daemon-side event inbox for the probe socket (P6 spec v6.0 §2/§5.2).
/// Pure logic over an injected command sender: the socket layer feeds frames
/// in, EngineCore pulls windowed signals out. All state is lock-guarded;
/// probe reader threads and the dispatcher thread touch this concurrently.
public final class ProbeInbox {

    public struct Connection: Equatable {
        public let hello: ProbeHello
        public let connectedAt: Date
        public var eventsSeen: Int
    }

    private struct Event {
        let receivedAt: Date
        let frame: ProbeInboundFrame
    }

    private struct Window {
        let opId: String
        let pid: Int32
        let t0: Date
        var t1: Date?
        var hitCount = 0
        /// First-seen order (deduplicated by file:line).
        var handlers: [HandlerRef] = []
        var handlerKeys: Set<String> = []
        var stateBefore: [String: StateEntry] = [:]
        var stateSource: StateDiffSource?
        var probeVersion: String
    }

    /// Events received after window close within this grace count as late
    /// (async-timing evidence, T8; §2.3).
    public static let lateGraceSeconds: TimeInterval = 2.0
    public static let eventRingCapacity = 512
    public static let windowHistoryLimit = 16

    /// Test/daemon hook that writes an encoded command line to one probe.
    public var sender: ((Int32, Data) -> Void)?

    private let lock = NSLock()
    private var connections: [Int32: Connection] = [:]
    private var events: [Int32: [Event]] = [:]
    private var windows: [Window] = []
    // Response tracking uses monotonic sequence counters, not wall clocks:
    // a scripted unit test freezes `now` and pre-ingests replies, so "newer
    // than my command" must be decidable without Date arithmetic.
    private var responseSequence = 0
    private var latestCheckpoint: (seq: Int, pid: Int32, ref: String, domains: [String: [String: String]]?, digest: String?, error: String?)?
    private var latestResult: (seq: Int, pid: Int32, ok: Bool, postStateDigest: String?, error: String?)?
    private var latestCapture: (seq: Int, pid: Int32, path: String?, error: String?)?
    private let now: () -> Date

    public init(now: @escaping () -> Date = { Date() }) {
        self.now = now
    }

    // MARK: - Connection lifecycle

    public func register(_ hello: ProbeHello) {
        lock.lock(); defer { lock.unlock() }
        connections[hello.pid] = Connection(hello: hello, connectedAt: now(), eventsSeen: 0)
        events[hello.pid] = []
    }

    public func disconnect(pid: Int32) {
        lock.lock(); defer { lock.unlock() }
        connections.removeValue(forKey: pid)
        events.removeValue(forKey: pid)
    }

    public func connection(for pid: Int32) -> Connection? {
        lock.lock(); defer { lock.unlock() }
        return connections[pid]
    }

    /// A probe counts as state-capable when it declared a state observation
    /// channel (z2 mirror roots or z3 KVC objects); without one, stateDiff
    /// stays honestly null instead of asserting "no change" from silence.
    public func isStateCapable(pid: Int32) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let entry = connections[pid] else { return false }
        return hasStateCapability(entry.hello.capabilities)
    }

    private func hasStateCapability(_ capabilities: [String]) -> Bool {
        capabilities.contains("z2") || capabilities.contains("z3")
    }

    // MARK: - Ingest

    public func ingest(pid: Int32, frame: ProbeInboundFrame) {
        lock.lock(); defer { lock.unlock() }
        switch frame {
        case .handler:
            events[pid, default: []].append(Event(receivedAt: now(), frame: frame))
            trimEvents(&events[pid])
            connections[pid]?.eventsSeen += 1
        case .state:
            events[pid, default: []].append(Event(receivedAt: now(), frame: frame))
            trimEvents(&events[pid])
            connections[pid]?.eventsSeen += 1
        case .checkpoint(let ref, let domains, let digest, let error):
            responseSequence += 1
            latestCheckpoint = (responseSequence, pid, ref, domains, digest, error)
        case .result(let ok, let postStateDigest, let error):
            responseSequence += 1
            latestResult = (responseSequence, pid, ok, postStateDigest, error)
        case .capture(let path, let error):
            responseSequence += 1
            latestCapture = (responseSequence, pid, path, error)
        case .hello(let hello):
            // Re-hello on the same connection = replacement registration.
            connections[hello.pid] = Connection(hello: hello, connectedAt: now(), eventsSeen: 0)
            events[hello.pid] = []
        case .malformed:
            break // logged by the socket layer
        }
    }

    private func trimEvents(_ slot: inout [Event]?) {
        guard slot != nil else { return }
        if slot!.count > ProbeInbox.eventRingCapacity {
            slot!.removeFirst(slot!.count - ProbeInbox.eventRingCapacity)
        }
    }

    // MARK: - Command dispatch

    public func sendCommand(_ name: String, _ fields: [String: Any] = [:], to pid: Int32) {
        let data = ProbeWire.command(name, fields)
        guard !data.isEmpty else { return }
        sender?(pid, data)
    }

    // MARK: - Act windows (§2.3)

    public func beginWindow(pid: Int32, opId: String) {
        lock.lock(); defer { lock.unlock() }
        guard let connection = connections[pid] else { return }
        windows.append(Window(
            opId: opId, pid: pid, t0: now(),
            probeVersion: connection.hello.probeVersion
        ))
        if windows.count > ProbeInbox.windowHistoryLimit {
            windows.removeFirst(windows.count - ProbeInbox.windowHistoryLimit)
        }
    }

    /// Close the window and build the §3.1 signals from events received in
    /// `[t0, t1]`. Returns nil pair only when no window was open (no probe
    /// connection at begin time — the null-signal honest absence).
    public func endWindow(pid: Int32, opId: String) -> (handlerProbe: HandlerProbeSignal?, stateDiff: StateDiffSignal?)? {
        lock.lock(); defer { lock.unlock() }
        let closedAt = now()
        guard let index = windows.lastIndex(where: { $0.opId == opId && $0.pid == pid && $0.t1 == nil }) else {
            return nil
        }
        var window = windows[index]
        window.t1 = closedAt
        windows[index] = window

        let stream = events[pid] ?? []
        var stateEvents: [Event] = []
        for event in stream where event.receivedAt >= window.t0 && event.receivedAt <= closedAt {
            switch event.frame {
            case .handler(let file, let line, _, _):
                window.hitCount += 1
                let key = "\(file):\(line)"
                if !window.handlerKeys.contains(key) {
                    window.handlerKeys.insert(key)
                    window.handlers.append(HandlerRef(file: file, line: line))
                }
            case .state:
                stateEvents.append(event)
            default:
                break
            }
        }
        // Second pass keeps first-before/last-after per key in insertion order.
        var entries: [String: StateEntry] = [:]
        var source: StateDiffSource?
        for event in stateEvents {
            if case .state(let key, let before, let after, let rawSource, _) = event.frame {
                if source == nil { source = StateDiffSource(rawValue: rawSource) }
                if let existing = entries[key] {
                    entries[key] = StateEntry(key: key, before: existing.before, after: after)
                } else {
                    entries[key] = StateEntry(key: key, before: before, after: after)
                }
            }
        }
        window.stateBefore = entries
        window.stateSource = source ?? window.stateSource
        windows[index] = window

        let handlerProbe = HandlerProbeSignal(
            probeVersion: window.probeVersion,
            hitCount: window.hitCount,
            handlers: window.handlers,
            lateCount: 0
        )
        var stateDiff: StateDiffSignal?
        if hasStateCapability(connectionCapabilities(pid)) {
            let resolvedSource = window.stateSource ?? .z2Mirror
            let list = entries.values.sorted { $0.key < $1.key }
            stateDiff = StateDiffSignal(source: resolvedSource, changed: !list.isEmpty, entries: list)
        }
        return (handlerProbe, stateDiff)
    }

    private func connectionCapabilities(_ pid: Int32) -> [String] {
        connections[pid]?.hello.capabilities ?? []
    }

    /// Late arrivals for a closed window: handler events received in the
    /// grace period after t1 (P6 §2.3 — "delayed reaction" is exactly a
    /// handler firing shortly after the act, so no file:line preconditions;
    /// acts are serialized by the dispatcher, keeping attribution unambiguous).
    public func lateCount(opId: String) -> Int? {
        lock.lock(); defer { lock.unlock() }
        guard let window = windows.first(where: { $0.opId == opId }), let t1 = window.t1 else {
            return nil
        }
        var late = 0
        for event in events[window.pid] ?? [] {
            guard event.receivedAt > t1,
                  event.receivedAt.timeIntervalSince(t1) <= ProbeInbox.lateGraceSeconds else { continue }
            if case .handler = event.frame {
                late += 1
            }
        }
        return late
    }

    /// Refresh a stored handlerProbe with the final late count (diagnose time).
    public func refreshedHandlerProbe(for pack: EvidencePack) -> HandlerProbeSignal? {
        guard let stored = pack.signals.handlerProbe,
          let late = lateCount(opId: pack.operationId), late != stored.lateCount else {
            return nil
        }
        return HandlerProbeSignal(
            probeVersion: stored.probeVersion,
            hitCount: stored.hitCount,
            handlers: stored.handlers,
            lateCount: late
        )
    }

    // MARK: - Checkpoint request/response (tier-1, §5.5)

    /// Ask a probe to export and retain a checkpoint under `ref`. The daemon
    /// recomputes the digest over §2 canonical JSON and rejects mismatches.
    public func checkpointExport(pid: Int32, ref: String, timeout: TimeInterval = 2.0)
        -> (domains: [String: [String: String]], digest: String)? {
        lock.lock()
        responseSequence += 1
        let issuedSeq = responseSequence
        lock.unlock()
        sendCommand("checkpoint_export", ["ref": ref], to: pid)
        var attempts = Int(timeout / 0.02) + 1
        while attempts > 0 {
            lock.lock()
            let entry: (seq: Int, pid: Int32, ref: String, domains: [String: [String: String]]?, digest: String?, error: String?)?
            if let candidate = latestCheckpoint, candidate.seq > issuedSeq, candidate.pid == pid, candidate.ref == ref {
                entry = candidate
                latestCheckpoint = nil
            } else {
                entry = nil
            }
            lock.unlock()
            if let entry {
                if let error = entry.error {
                    lastCheckpointError = error
                    return nil
                }
                if let domains = entry.domains, let reported = entry.digest {
                    let computed = ProbeWire.sha256Hex(ProbeWire.checkpointCanonical(domains))
                    if computed == reported {
                        lastCheckpointError = nil
                        return (domains, computed)
                    }
                    lastCheckpointError = "digest mismatch: probe reported \(reported), daemon recomputed \(computed)"
                    return nil
                }
                lastCheckpointError = "empty checkpoint payload"
                return nil
            }
            attempts -= 1
            Thread.sleep(forTimeInterval: 0.02)
        }
        lastCheckpointError = "checkpoint_export timed out after \(timeout)s"
        return nil
    }

    public private(set) var lastCheckpointError: String?

    /// Ask a probe to rewrite the retained checkpoint for `ref` and report the
    /// post-restore digest over the same domain set.
    public func checkpointRestore(pid: Int32, ref: String, domains: [String], timeout: TimeInterval = 2.0)
        -> String? {
        lock.lock()
        responseSequence += 1
        let issuedSeq = responseSequence
        lock.unlock()
        lastResultError = nil
        sendCommand("checkpoint_restore", ["ref": ref, "domains": domains], to: pid)
        var attempts = Int(timeout / 0.02) + 1
        while attempts > 0 {
            lock.lock()
            let entry: (seq: Int, pid: Int32, ok: Bool, postStateDigest: String?, error: String?)?
            if let candidate = latestResult, candidate.seq > issuedSeq, candidate.pid == pid {
                entry = candidate
                latestResult = nil
            } else {
                entry = nil
            }
            lock.unlock()
            if let entry {
                if !entry.ok {
                    lastResultError = entry.error ?? "probe refused restore"
                    return nil
                }
                guard let digest = entry.postStateDigest else {
                    lastResultError = "restore result missing postStateDigest"
                    return nil
                }
                return digest
            }
            attempts -= 1
            Thread.sleep(forTimeInterval: 0.02)
        }
        lastResultError = "checkpoint_restore timed out after \(timeout)s"
        return nil
    }

    public private(set) var lastResultError: String?

    // MARK: - Status (probe_status method, §5.4)

    public func statusJSON() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return connections.values.sorted { $0.hello.pid < $1.hello.pid }.map { connection in
            var entry: [String: Any] = [
                "pid": Int(connection.hello.pid),
                "appName": connection.hello.appName,
                "probeVersion": connection.hello.probeVersion,
                "capabilities": connection.hello.capabilities,
                "eventsSeen": connection.eventsSeen
            ]
            if let bundleId = connection.hello.bundleId { entry["bundleId"] = bundleId }
            return entry
        }
    }
}
