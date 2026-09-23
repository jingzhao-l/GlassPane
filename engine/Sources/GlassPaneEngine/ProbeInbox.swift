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
    /// Distinct pids that may hold a registration at once (R5-06). This is the
    /// inbox-side backstop so no caller can grow the connection table by
    /// streaming hellos. A-11 states the honest division of labour: through
    /// `ProbeSocketServer` it is a *looser* bound than the live one — the accept
    /// loop admits at most `ProbeSocketServer.maxConcurrentClients` clients and
    /// each may register exactly one pid, so a daemon-served socket registers at
    /// most 8 pids and never reaches this number. It binds callers that reach
    /// `register` directly (tests today; an in-process producer later).
    public static let maxRegisteredProbes = 16
    /// How many dropped probes stay visible in `probe_status`'s
    /// `recentDisconnections` array (R2-18).
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
    /// A-09: per-pid tally of state frames whose `source` token maps to none of
    /// the schema's channels, plus the monotonic total. Guarded by `lock` like
    /// everything else here; published on the live `probes` row and through
    /// `unmapableStateFrameCount`.
    private var unmappedStateSources: [Int32: Int] = [:]
    private var unmapableStateFrameTotal = 0
    /// Per-command failure reasons. They are inbox state and sit behind `lock`
    /// with everything else: the dispatcher thread writes them while probe
    /// reader threads write the frames those errors explain, and plain storage
    /// was a data race on String (residual from the round-2 ledger). See the
    /// accessors in the "Command dispatch" section.
    private var errorDelivery: String?
    private var errorCheckpoint: String?
    private var errorResult: String?
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

    /// The one admission path (A-05). Nothing else in this type may create or
    /// replace a registration: `ingest` deliberately refuses to, because
    /// admitting a hello there would skip both the peer-credential verdict and
    /// this method's cap. `ProbeSocketServer.acceptHello` calls it *after*
    /// `getpeereid`/`LOCAL_PEERPID` matched the claimed pid, and drops the
    /// connection when this returns false.
    ///
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
        // A fresh pid gets a fresh A-09 tally too; the re-hello branch above
        // deliberately keeps the old one, because it is the same process.
        unmappedStateSources[hello.pid] = 0
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
        // The registration is checked *before* anything is deleted (residual
        // A-1 door, ordered like `register`): an unregistered pid's event ring
        // belongs to whatever still holds it, and a stray disconnect must not
        // wipe an in-flight window's hits the way the old re-hello path did.
        guard let connection = connections.removeValue(forKey: pid) else { return }
        // A genuinely gone process takes its ring with it, so a recycled pid
        // number cannot inherit another app's handler hits. The A-09 tally goes
        // the same way (the monotonic `unmapableStateFrameTotal` keeps the
        // history); `register` starts a fresh pid clean.
        events.removeValue(forKey: pid)
        unmappedStateSources.removeValue(forKey: pid)
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

    /// Feed one authenticated inbound frame for `pid` into the event ring and
    /// the response slots. `pid` is the identity the socket layer verified
    /// against the kernel's peer credentials, never anything the frame claims.
    ///
    /// A-05: this is *not* an admission path. A `.hello` frame here is ignored
    /// on purpose — registering from it would skip the peer-credential verdict
    /// and `maxRegisteredProbes`, and used to clear the pid's event ring on
    /// every hello (the X-1 wipe). `ProbeSocketServer` authenticates and calls
    /// `register` before a connection is allowed to stream anything else, so no
    /// producer hands a hello to this method.
    public func ingest(pid: Int32, frame: ProbeInboundFrame) {
        lock.lock(); defer { lock.unlock() }
        switch frame {
        case .handler:
            events[pid, default: []].append(Event(receivedAt: now(), frame: frame))
            trimEvents(&events[pid])
            connections[pid]?.eventsSeen += 1
        case .state(_, _, _, let source, _):
            events[pid, default: []].append(Event(receivedAt: now(), frame: frame))
            trimEvents(&events[pid])
            connections[pid]?.eventsSeen += 1
            // A-09: a state frame whose `source` token the daemon cannot map is
            // still a real observation, and its loss must be attributable. Count
            // it per pid; `ProbeSocketServer` logs the token itself (it is the
            // only place the raw string survives) and `statusJSON` publishes the
            // tally next to `eventsSeen`.
            if StateDiffSource(rawValue: source) == nil {
                unmappedStateSources[pid, default: 0] += 1
                unmapableStateFrameTotal += 1
            }
        case .checkpoint(let ref, let domains, let digest, let error):
            responseSequence += 1
            latestCheckpoint = (responseSequence, pid, ref, domains, digest, error)
        case .result(let ok, let postStateDigest, let error):
            responseSequence += 1
            latestResult = (responseSequence, pid, ok, postStateDigest, error)
        case .capture(let path, let error):
            responseSequence += 1
            latestCapture = (responseSequence, pid, path, error)
        case .hello:
            break // never an admission path; see the method comment above
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
            setLastDeliveryError("\(name): command frame could not be encoded")
            return false
        }
        guard let sender = sender else {
            setLastDeliveryError("\(name): no probe socket is attached (pid \(pid))")
            return false
        }
        // Deliberately outside any inbox lock: the socket layer takes its own
        // per-connection send lock here and must never re-enter this one.
        guard sender(pid, data) else {
            setLastDeliveryError("\(name): not delivered to pid \(pid)")
            return false
        }
        setLastDeliveryError(nil)
        return true
    }

    // MARK: Per-command failure reasons
    //
    // `lastDeliveryError`/`lastCheckpointError`/`lastResultError` used to be
    // plain `public private(set) var` written outside `lock` while reader
    // threads were writing the frames those errors explain — a data race on
    // String storage, and Swift String is not benign under concurrent write.
    // They now live behind the same lock as the rest of the inbox (storage
    // declared with the other inbox state), with the assignments funnelled
    // through setters that require the lock to be free (`lock` is not
    // recursive). Every call site satisfies that: the checkpoint/restore paths
    // touch these only outside their polling regions, and `sendCommand` never
    // runs under `lock`.

    /// Reason the last `sendCommand` failed, nil when it went out.
    public var lastDeliveryError: String? {
        lock.lock(); defer { lock.unlock() }
        return errorDelivery
    }

    private func setLastDeliveryError(_ value: String?) {
        lock.lock(); defer { lock.unlock() }
        errorDelivery = value
    }

    /// Why the last `checkpointExport` produced no checkpoint: a delivery
    /// failure, a probe-reported error, a digest mismatch or a timeout — four
    /// different facts, kept apart by the writers below (A-01's basis).
    public var lastCheckpointError: String? {
        lock.lock(); defer { lock.unlock() }
        return errorCheckpoint
    }

    private func setLastCheckpointError(_ value: String?) {
        lock.lock(); defer { lock.unlock() }
        errorCheckpoint = value
    }

    /// Why the last `checkpointRestore` did not complete.
    public var lastResultError: String? {
        lock.lock(); defer { lock.unlock() }
        return errorResult
    }

    private func setLastResultError(_ value: String?) {
        lock.lock(); defer { lock.unlock() }
        errorResult = value
    }

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
    /// the source carried by in-window state frames when at least one of them
    /// named a channel this daemon knows, otherwise the channel the probe
    /// *declared* in its hello. Neither available yields nil — absence, never a
    /// channel name the probe never had (R6-15; §3.1 presence rule). A-09 is the
    /// case that falls through here: frames arrived, their `source` token mapped
    /// to nothing, and no channel was declared. Those frames are counted
    /// (`unmapableStateFrameCount`) and logged by the socket layer instead of
    /// being given a name they did not claim.
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
        // §3.1 presence rule as implemented: `stateDiff` needs a *nameable*
        // channel, and there are exactly two honest names for it — the source
        // token the in-window state frames carried, or the channel the probe
        // declared in its hello (z2/z3; manual GP.recordState on the z1 lane is
        // the first kind, P6 §8 H7 opt-in form). Nothing else, and no third:
        // silence from a probe with no channel stays an absent signal rather
        // than `changed: false`, and a probe that never had a channel is never
        // credited one (R6-15). Note that an *empty* entry list with a real
        // channel does produce a signal (`changed: false`) — "asked and silent"
        // is a measurement, so this branch deliberately does not test
        // `entries.isEmpty`.
        //
        // A-09 residue: a probe that really reported before/after frames whose
        // `source` token maps to none of the schema's three channels and whose
        // hello declared no channel has those entries collected above and then
        // nowhere to publish them, because `StateDiffSignal.source` is a closed
        // enum and inventing a lane name is the fabricated default again. The
        // window reports no stateDiff, but the absence is attributable from both
        // ends: the socket layer logs the offending token per connection, and
        // `unmapableStateFrameCount` plus the per-pid
        // `stateFramesUnmappedSource` on the live `probes` row distinguish "frames
        // arrived, channel unreadable" from "this probe has no state channel".
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
            setLastCheckpointError(lastDeliveryError ?? "checkpoint_export not delivered to pid \(pid)")
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
                    setLastCheckpointError(error)
                    return nil
                }
                if let domains = entry.domains, let reported = entry.digest {
                    let computed = ProbeWire.sha256Hex(ProbeWire.checkpointCanonical(domains))
                    if computed == reported {
                        setLastCheckpointError(nil)
                        return (domains, computed)
                    }
                    setLastCheckpointError("digest mismatch: probe reported \(reported), daemon recomputed \(computed)")
                    return nil
                }
                setLastCheckpointError("empty checkpoint payload")
                return nil
            }
            attempts -= 1
            Thread.sleep(forTimeInterval: 0.02)
        }
        setLastCheckpointError("checkpoint_export timed out after \(timeout)s")
        return nil
    }

    /// Ask a probe to rewrite the retained checkpoint for `ref` and report the
    /// post-restore digest over the same domain set.
    public func checkpointRestore(pid: Int32, ref: String, domains: [String], timeout: TimeInterval = 2.0)
        -> String? {
        lock.lock()
        responseSequence += 1
        let issuedSeq = responseSequence
        lock.unlock()
        setLastResultError(nil)
        guard sendCommand("checkpoint_restore", ["ref": ref, "domains": domains], to: pid) else {
            setLastResultError(lastDeliveryError ?? "checkpoint_restore not delivered to pid \(pid)")
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
                    setLastResultError(entry.error ?? "probe refused restore")
                    return nil
                }
                guard let digest = entry.postStateDigest else {
                    setLastResultError("restore result missing postStateDigest")
                    return nil
                }
                return digest
            }
            attempts -= 1
            Thread.sleep(forTimeInterval: 0.02)
        }
        setLastResultError("checkpoint_restore timed out after \(timeout)s")
        return nil
    }

    // MARK: - Status (probe_status method, §5.4)

    /// Live registrations only — the rows the frozen §5.4(3) shape describes,
    /// each carrying `connected: true`.
    ///
    /// A-10: the disconnection history used to be appended into this same array
    /// with `connected: false`, and every existing reader of `probes` treats "the
    /// pid is in here" as "the pid has a live probe" — both
    /// `spike/run_h1_retest.py` and `spike/run_spikes2.py` poll it that way,
    /// which is the agent's mental model of the method. A dropped probe was
    /// therefore read as an attached one: an act got spent against a dead socket
    /// and its `hitCount: 0` was reported as measurement. Dropped pids now live
    /// in `recentDisconnectionsJSON()`, which `EngineCore.probeStatus()` has to
    /// publish as its own top-level `recentDisconnections` key for the history
    /// to reach an agent again (that forwarding is EngineCore's side of A-10 and
    /// is not in this file).
    ///
    /// A row adds `stateFramesUnmappedSource` when that pid sent state frames
    /// whose `source` token the daemon could not map (A-09); absence means zero,
    /// which is what distinguishes "no state channel" from "state reported
    /// through a channel this daemon cannot read".
    ///
    /// The probe's own drop counters (`droppedEvents`, `droppedWrites`,
    /// `rejectedKeys`) follow the **opposite** rule: they are added only when the
    /// probe reported them, because a probe that predates them, or one whose
    /// `hello` never arrived, has not measured anything. Writing `0` there would
    /// turn "unknown" into the project's most expensive kind of wrong answer — a
    /// clean bill of health for a channel that was leaking frames (X-3).
    public func statusJSON() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return connections.values.sorted { $0.hello.pid < $1.hello.pid }.map { connection -> [String: Any] in
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
            if let unmapped = unmappedStateSources[connection.hello.pid], unmapped > 0 {
                entry["stateFramesUnmappedSource"] = unmapped
            }
            if let droppedEvents = connection.hello.droppedEvents {
                entry["droppedEvents"] = droppedEvents
            }
            if let droppedWrites = connection.hello.droppedWrites {
                entry["droppedWrites"] = droppedWrites
            }
            if let rejectedKeys = connection.hello.rejectedKeys {
                entry["rejectedKeys"] = rejectedKeys
            }
            return entry
        }
    }

    /// Recently dropped registrations, newest first, each with `connectedAt`,
    /// `disconnectedAt`, `disconnectReason` and a per-pid `drops` count, so an
    /// agent reading `probe_status` can tell "never integrated" from "was
    /// connected, now dropped" instead of seeing an empty list (R2-18, §5.3(3))
    /// — without that history ever reading as a live probe (A-10). A pid that has
    /// re-registered is a live row in `statusJSON()` and is not repeated here.
    /// Production consumer: `EngineCore.probeStatus()`, which must forward this
    /// as the response's top-level `recentDisconnections` key; until that line
    /// exists in EngineCore the array is only reachable from these tests, and the
    /// daemon log stays the production trace of a drop (R2-18).
    public func recentDisconnectionsJSON() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return disconnections
            .filter { connections[$0.pid] == nil }
            .sorted { $0.disconnectedAt > $1.disconnectedAt }
            .map { drop -> [String: Any] in
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
            }
    }

    /// State frames received since start whose `source` token maps to none of
    /// the schema's channels (A-09). The *per-pid* tally is what reaches an
    /// agent, on the live `probes` row as `stateFramesUnmappedSource`; this
    /// monotonic total has no daemon-surface reader yet, so it exists for tests
    /// and for whichever status surface wants a process-wide figure later. The
    /// socket layer logs the first token it could not map per connection.
    public var unmapableStateFrameCount: Int {
        lock.lock(); defer { lock.unlock() }
        return unmapableStateFrameTotal
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
