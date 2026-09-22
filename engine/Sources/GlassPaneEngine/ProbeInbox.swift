import Foundation

/// Daemon-side event inbox for the probe socket (P6 spec v6.0 §2/§5.2).
/// Pure logic over an injected command sender: the socket layer feeds frames
/// in, EngineCore pulls windowed signals out, and the sender answers whether a
/// command actually left the daemon. All state is lock-guarded; probe reader
/// threads and the dispatcher thread touch this concurrently.
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

    /// One recorded probe drop-off (P6 §2.1/§5.4, R2-18): what *was* connected,
    /// when it went away, what the reader thread saw, and how many times that
    /// pid has come and gone. Absence of a record means "never registered" —
    /// the two are distinguishable on purpose.
    public struct Disconnection: Equatable {
        public let pid: Int32
        public let appName: String
        public let probeVersion: String
        public let capabilities: [String]
        public let connectedAt: Date
        public let disconnectedAt: Date
        public let eventsSeen: Int
        public let reason: String
        public let drops: Int
    }

    /// Events received after window close within this grace count as late
    /// (async-timing evidence, T8; §2.3).
    public static let lateGraceSeconds: TimeInterval = 2.0
    public static let eventRingCapacity = 512
    public static let windowHistoryLimit = 16
    /// Distinct pids that may hold a registration at once (R5-06). The socket
    /// layer bounds connections too; this is the inbox-side cap so no caller
    /// can grow the connection table by streaming hellos.
    public static let maxRegisteredProbes = 16
    /// How many dropped probes stay visible in `probe_status` (R2-18).
    public static let recentDisconnectionsLimit = 8

    /// Test/daemon hook that writes an encoded command line to one probe.
    /// Returns whether the bytes actually left the daemon: `false` means the
    /// command was never delivered, which is a different fact from "the probe
    /// did not answer in time" and must not be reported as a timeout (R2-07).
    public var sender: ((Int32, Data) -> Bool)?

    private let lock = NSLock()
    private var connections: [Int32: Connection] = [:]
    private var disconnections: [Disconnection] = []
    private var disconnectionTotal = 0
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

    /// Admit a hello. Returns false when the registration is refused because
    /// the distinct-pid capacity is reached — the socket layer then drops that
    /// connection instead of growing the table (R5-06). A re-hello for a pid
    /// that is already registered replaces its entry (§2.2 "重复 hello 视为重连")
    /// and is always admitted.
    @discardableResult
    public func register(_ hello: ProbeHello) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let existing = connections[hello.pid] {
            // 同 pid 的第二个 hello 有两种来源：探针 SDK 的能力变更公告，或断线后
            // 同一进程重连。两种都不是新进程 —— 必须保留该 pid 的事件环与已见计数，
            // 否则每次公告都会抹掉在途 act 的命中，证据里的 `hitCount: 0` 就又变成
            // 一个"没采到"被说成"没命中"的假负结论（round-1 协调项 X-1）。
            // capabilities 取新值：SDK 每次发的是当前全集，替换才是权威语义。
            connections[hello.pid] = Connection(
                hello: hello,
                connectedAt: existing.connectedAt,
                eventsSeen: existing.eventsSeen
            )
            return true
        }
        if connections.count >= ProbeInbox.maxRegisteredProbes {
            return false
        }
        connections[hello.pid] = Connection(hello: hello, connectedAt: now(), eventsSeen: 0)
        events[hello.pid] = []
        return true
    }

    public func disconnect(pid: Int32) {
        disconnect(pid: pid, reason: "connection closed")
    }

    /// Drop a registration *and* record why, so `probe_status` can tell
    /// "never integrated" from "was connected, now dropped" (R2-18). A pid
    /// that was not registered leaves no record — nothing is invented.
    public func disconnect(pid: Int32, reason: String) {
        lock.lock(); defer { lock.unlock() }
        events.removeValue(forKey: pid)
        guard let connection = connections.removeValue(forKey: pid) else { return }
        let previousDrops = disconnections.first(where: { $0.pid == pid })?.drops ?? 0
        disconnections.removeAll(where: { $0.pid == pid })
        disconnections.append(Disconnection(
            pid: pid,
            appName: connection.hello.appName,
            probeVersion: connection.hello.probeVersion,
            capabilities: connection.hello.capabilities,
            connectedAt: connection.connectedAt,
            disconnectedAt: now(),
            eventsSeen: connection.eventsSeen,
            reason: reason,
            drops: previousDrops + 1
        ))
        while disconnections.count > ProbeInbox.recentDisconnectionsLimit {
            disconnections.removeFirst()
        }
        disconnectionTotal += 1
    }

    /// Registrations dropped since the daemon started (monotonic).
    public var recordedDisconnectionCount: Int {
        lock.lock(); defer { lock.unlock() }
        return disconnectionTotal
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
        return ProbeInbox.declaredStateSource(capabilities: entry.hello.capabilities) != nil
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

    /// Encode one command line and hand it to the socket layer. Returns false
    /// — and records why in `lastDeliveryError` — when the command never left
    /// the daemon, so a caller can report "not delivered" instead of presenting
    /// a dropped command as a probe that failed to answer (R2-07).
    @discardableResult
    public func sendCommand(_ name: String, _ fields: [String: Any] = [:], to pid: Int32) -> Bool {
        let data = ProbeWire.command(name, fields)
        if data.isEmpty {
            lastDeliveryError = "\(name): command frame could not be encoded"
            return false
        }
        guard let sender = sender else {
            lastDeliveryError = "\(name): no probe socket is attached (pid \(pid))"
            return false
        }
        // Deliberately outside any inbox lock: the socket layer takes its own
        // descriptor lock here and must never re-enter this one.
        guard sender(pid, data) else {
            lastDeliveryError = "\(name): not delivered to pid \(pid)"
            return false
        }
        lastDeliveryError = nil
        return true
    }

    /// Reason the last `sendCommand` failed, nil when it went out.
    public private(set) var lastDeliveryError: String?

    /// Z1 emits a handler frame on *entry* (no `durationNs`) and, when the call
    /// took longer than 1 ms, a second frame carrying `durationNs` for the same
    /// `file:line` on exit (§2.2 — the SDK only reports duration frames so hot
    /// handlers do not flood the socket). One invocation is therefore one entry
    /// frame plus at most one follow-up: the follow-up aggregates into the hit
    /// already counted for that `file:line` instead of doubling `hitCount`,
    /// which is exactly the "slow handler" case (R6-05). A duration frame whose
    /// entry frame is not in the counted set still counts once.
    static func countsAsInvocation(
        file: String, line: Int, durationNs: Int?, seenKeys: Set<String>
    ) -> Bool {
        guard durationNs != nil else { return true }
        return !seenKeys.contains("\(file):\(line)")
    }

    /// `stateDiff.source` names the channel the observation really came from:
    /// the source carried by in-window state frames when there were any,
    /// otherwise the channel the probe *declared* in its hello. No channel and
    /// no events yields nil — absence, never a channel name the probe never
    /// had (R6-15; §3.1 presence rule).
    static func stateDiffSource(
        observed: StateDiffSource?, capabilities: [String]
    ) -> StateDiffSource? {
        if let observed { return observed }
        if capabilities.contains("z2") { return .z2Mirror }
        if capabilities.contains("z3") { return .z3KVC }
        return nil
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
            case .handler(let file, let line, _, let durationNs):
                if ProbeInbox.countsAsInvocation(
                    file: file, line: line, durationNs: durationNs, seenKeys: window.handlerKeys
                ) {
                    window.hitCount += 1
                }
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
        // §3.1 presence rule: a state channel exists when the probe declared
        // one (z2/z3) OR when it actually reported state events in this
        // window (manual GP.recordState on the z1 lane — P6 §8 H7 opt-in
        // form). Silence with no channel stays honest null, never false. The
        // channel *name* comes from those two observations only: no default,
        // because a probe that never had the channel must not be credited one
        // (R6-15).
        var stateDiff: StateDiffSignal?
        if let resolvedSource = ProbeInbox.stateDiffSource(
            observed: source, capabilities: connectionCapabilities(pid)
        ) {
            let list = entries.values.sorted { $0.key < $1.key }
            stateDiff = StateDiffSignal(source: resolvedSource, changed: !list.isEmpty, entries: list)
        }
        return (handlerProbe, stateDiff)
    }

    /// The state channel a probe declared in its hello, or nil when it declared
    /// none (§2.2 capability list). z2 is checked before z3 only as a tie-break
    /// for a probe that declared both and reported nothing in-window; a probe
    /// that really reported state gets the source its frames carried.
    static func declaredStateSource(capabilities: [String]) -> StateDiffSource? {
        if capabilities.contains("z2") { return .z2Mirror }
        if capabilities.contains("z3") { return .z3KVC }
        return nil
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
        var seenKeys: Set<String> = []
        for event in events[window.pid] ?? [] {
            guard event.receivedAt > t1,
                  event.receivedAt.timeIntervalSince(t1) <= ProbeInbox.lateGraceSeconds else { continue }
            if case .handler(let file, let line, _, let durationNs) = event.frame {
                // Same §2.2 entry/duration pairing as the in-window count: a
                // slow handler's follow-up frame must not double the late count.
                if ProbeInbox.countsAsInvocation(
                    file: file, line: line, durationNs: durationNs, seenKeys: seenKeys
                ) {
                    late += 1
                }
                seenKeys.insert("\(file):\(line)")
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
        guard sendCommand("checkpoint_export", ["ref": ref], to: pid) else {
            lastCheckpointError = lastDeliveryError ?? "checkpoint_export not delivered to pid \(pid)"
            return nil
        }
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
        guard sendCommand("checkpoint_restore", ["ref": ref, "domains": domains], to: pid) else {
            lastResultError = lastDeliveryError ?? "checkpoint_restore not delivered to pid \(pid)"
            return nil
        }
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

    /// Live probes first (each row carries `connected: true`), then the
    /// recently dropped ones — with `connectedAt`, `disconnectedAt`,
    /// `disconnectReason` and a per-pid `drops` count — so an agent reading
    /// `probe_status` can tell "never integrated" from "was connected, now
    /// dropped" instead of seeing an empty list (R2-18, §5.3(3)).
    public func statusJSON() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        var rows = connections.values.sorted { $0.hello.pid < $1.hello.pid }.map { connection -> [String: Any] in
            var entry: [String: Any] = [
                "pid": Int(connection.hello.pid),
                "appName": connection.hello.appName,
                "probeVersion": connection.hello.probeVersion,
                "capabilities": connection.hello.capabilities,
                "connectedAt": ProbeInbox.iso8601(connection.connectedAt),
                "eventsSeen": connection.eventsSeen,
                "connected": true
            ]
            if let bundleId = connection.hello.bundleId { entry["bundleId"] = bundleId }
            return entry
        }
        let dropped = disconnections
            .filter { connections[$0.pid] == nil }
            .sorted { $0.disconnectedAt > $1.disconnectedAt }
        rows.append(contentsOf: dropped.map { drop -> [String: Any] in
            [
                "pid": Int(drop.pid),
                "appName": drop.appName,
                "probeVersion": drop.probeVersion,
                "capabilities": drop.capabilities,
                "connectedAt": ProbeInbox.iso8601(drop.connectedAt),
                "eventsSeen": drop.eventsSeen,
                "connected": false,
                "disconnectedAt": ProbeInbox.iso8601(drop.disconnectedAt),
                "disconnectReason": drop.reason,
                "drops": drop.drops
            ]
        })
        return rows
    }

    // MARK: - Timestamps

    /// ISO-8601 with millisecond precision in UTC — the same shape the engine
    /// library writes for `capturedAt`/`createdAt` (§5.4). Hoisting the four
    /// copies of this formatter into one helper is engine-wide work, not this
    /// file's (R7-15).
    private static let isoFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    static func iso8601(_ date: Date) -> String {
        isoFormatter.string(from: date)
    }
}
