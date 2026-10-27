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
        /// Defect 1 (2026-10-19 review): set when the probe owning this window
        /// disconnected while the window was still open. `disconnect` takes the
        /// pid's event ring with it, so the window can no longer be measured —
        /// and "the ring is gone" is a different fact from "the ring was empty".
        /// `endWindow` answers the file's own honest-absence shape for a flagged
        /// window instead of counting the empty replacement ring as zero hits.
        var probeGone = false
        /// Defect 3 (2026-10-22): the event ring is `eventRingCapacity` deep per
        /// pid and `trimEvents` drops the overflow on the **daemon** side. The two
        /// fields below say how much of *this* window that threw away:
        /// `evictionsAtBegin` is the pid's eviction tally when the window opened,
        /// `eventsEvicted` the difference at close. Without them a busy window
        /// answers `hitCount: N` and a truncated `handlers` list as a complete
        /// measurement, while `N` is really a lower bound.
        var evictionsAtBegin: Int = 0
        var eventsEvicted: Int = 0
        /// The pid's eviction tally **at close** (finding A6, 2026-10-27).
        /// `eventsEvicted` covers the in-window half of the window's life; the
        /// grace period `(t1, t1 + lateGraceSeconds]` is the other half, and
        /// nothing observed it. A late handler burst that overflowed the ring
        /// during the grace dropped the earliest late events before
        /// `lateReading` ever counted them, so `late` came back low — and when it
        /// equalled the stored `lateCount`, `refreshLateCount` answered
        /// `.confirmed` = "this count is final", which is exactly the certification
        /// the two existing refusals were written to withhold.
        var evictionsAtClose: Int = 0
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
    /// Defect 3 (2026-10-22): per-pid tally of probe events **this daemon** dropped
    /// when a pid's ring overflowed `eventRingCapacity`, plus the monotonic total —
    /// the same shape A-09's `unmappedStateSources` uses, because every probe-side
    /// loss already had a published counter (`droppedEvents`, `droppedWrites`,
    /// `truncatedValues`) while the daemon-side one left no trace at all. Published
    /// per-pid on the live `probes` row as `ringEvictedEvents` and process-wide as
    /// `ringEvictionCount`.
    private var ringEvictions: [Int32: Int] = [:]
    private var ringEvictionTotal = 0
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
            // 这些自报计数器是这条"替换"规则唯一的例外，因为它们在 hello 上是
            // 可选字段：能力变更公告往往只带 capabilities，若整体换掉 hello，先报过
            // `droppedEvents: 40` 的探针就会被这一帧更啰嗦、但对该键更沉默的公告
            // 抹回"未上报"。方向上仍诚实（缺席不等于 0），可那次真测量白白蒸发了。
            // 合并规则一句话：**新值缺失则沿用旧值** —— 上报过的测量不会因为后一帧
            // 没提它就作废；从没上报过的（旧值也是 nil）继续缺席。
            // 真断开不走这里：`disconnect(pid:)` 会摘掉注册，重连的进程因此落到下面
            // 那条全新分支，计数不会被上一个进程残留。
            connections[hello.pid] = Connection(
                hello: ProbeHello(
                    pid: hello.pid,
                    bundleId: hello.bundleId,
                    appName: hello.appName,
                    probeVersion: hello.probeVersion,
                    capabilities: hello.capabilities,
                    droppedEvents: hello.droppedEvents ?? existing.hello.droppedEvents,
                    droppedWrites: hello.droppedWrites ?? existing.hello.droppedWrites,
                    rejectedKeys: hello.rejectedKeys ?? existing.hello.rejectedKeys,
                    droppedInboundFrames: hello.droppedInboundFrames ?? existing.hello.droppedInboundFrames,
                    droppedInboundLines: hello.droppedInboundLines ?? existing.hello.droppedInboundLines,
                    truncatedValues: hello.truncatedValues ?? existing.hello.truncatedValues
                ),
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
        // Same rule for the defect-3 eviction tally: a new process starts with
        // nothing evicted, and a window opened for it cannot inherit another
        // process's baseline (that delta is what `eventsEvicted` reports).
        ringEvictions[hello.pid] = 0
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
        // Defect 3: the eviction tally is that process's loss, so it goes with it.
        // The monotonic `ringEvictionTotal` keeps the history, exactly like
        // `unmapableStateFrameTotal` above — a re-registered pid must not be
        // charged for events its predecessor overflowed.
        ringEvictions.removeValue(forKey: pid)
        // Defect 1: a window that was open when the probe went away can never be
        // measured again — its event ring is what `endWindow` counts, and that
        // ring is gone with the process. Flag it so the close answers the honest
        // absence instead of `hitCount: 0`, which Classifier reads as a real
        // zero-hit act (its T8/zero branches key on exactly that number).
        for index in windows.indices where windows[index].pid == pid && windows[index].t1 == nil {
            windows[index].probeGone = true
        }
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
            trimEvents(&events[pid], pid: pid)
            connections[pid]?.eventsSeen += 1
        case .state(_, _, _, let source, _):
            events[pid, default: []].append(Event(receivedAt: now(), frame: frame))
            trimEvents(&events[pid], pid: pid)
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

    /// Drop the oldest events past `eventRingCapacity` and **count what was
    /// dropped** (defect 3, 2026-10-22). Before the counter existed this was the
    /// one probe loss with no published number: an in-flight window silently lost
    /// the events it would have counted, so `endWindow` answered a lower
    /// `hitCount` and a truncated `handlers` list as a complete measurement, and
    /// nothing anywhere said that events had been thrown away at all.
    private func trimEvents(_ slot: inout [Event]?, pid: Int32) {
        guard slot != nil else { return }
        if slot!.count > ProbeInbox.eventRingCapacity {
            let evicted = slot!.count - ProbeInbox.eventRingCapacity
            ringEvictions[pid, default: 0] += evicted
            ringEvictionTotal += evicted
            slot!.removeFirst(evicted)
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
            probeVersion: connection.hello.probeVersion,
            // Defect 3: the pid's eviction tally at open. The difference against
            // the tally at close is this window's own loss, which is what
            // `eventsEvictedDuringWindow` hands to `EngineCore`.
            evictionsAtBegin: ringEvictions[pid] ?? 0
        ))
        if windows.count > ProbeInbox.windowHistoryLimit {
            windows.removeFirst(windows.count - ProbeInbox.windowHistoryLimit)
        }
    }

    /// Close the window and build the §3.1 signals from events received in
    /// `[t0, t1]`. Returns nil pair only when no window was open (no probe
    /// connection at begin time — the null-signal honest absence), or when the
    /// probe disconnected while the window was open (defect 1: its event ring
    /// went with the process, so this close has nothing to measure).
    public func endWindow(
        pid: Int32, opId: String, includeMirrorDiff: Bool = true
    ) -> (handlerProbe: HandlerProbeSignal?, stateDiff: StateDiffSignal?)? {
        lock.lock(); defer { lock.unlock() }
        let closedAt = now()
        guard let index = windows.lastIndex(where: { $0.opId == opId && $0.pid == pid && $0.t1 == nil }) else {
            return nil
        }
        var window = windows[index]
        window.t1 = closedAt
        windows[index] = window
        if window.probeGone {
            // The probe for this window is gone and the close is recorded above
            // (so a second close still answers nil). Nothing below this line can
            // be measured: `events[pid]` is now an empty ring belonging to nobody,
            // and reading it would turn "we lost the channel mid-act" into
            // "the act produced zero handler hits". §3.1's absence is the answer.
            return (nil, nil)
        }

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
                // A `z2-mirror` frame is a comparison against the baseline that
                // `op_begin` captured. With no baseline in this window the probe
                // was diffing against the END of the previous act, so whatever it
                // measured belongs to a different operation — filing it here is a
                // misattribution, not a measurement. KVO and macro frames need no
                // window command and are kept verbatim.
                if case .state(_, _, _, let rawSource, _) = event.frame,
                   !includeMirrorDiff, rawSource == StateDiffSource.z2Mirror.rawValue {
                    continue
                }
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
        // Defect 3 (2026-10-22): whatever this pid's ring lost between the window
        // opening and closing is *this window's* loss — those events are exactly
        // the ones the loop above would have counted. `hitCount` is then a lower
        // bound and `handlers` a truncated list, so the number has to travel with
        // the signal instead of silently looking like a complete measurement.
        window.eventsEvicted = max(0, (ringEvictions[pid] ?? 0) - window.evictionsAtBegin)
        // The grace period's own baseline: whatever this pid loses from here on is
        // loss this window's late count cannot see (finding A6).
        window.evictionsAtClose = ringEvictions[pid] ?? 0
        window.stateBefore = entries
        window.stateSource = source ?? window.stateSource
        windows[index] = window

        let handlerProbe = HandlerProbeSignal(
            probeVersion: window.probeVersion,
            hitCount: window.hitCount,
            handlers: window.handlers,
            // The grace period after `closedAt` has not elapsed yet, so this is
            // the count *at close*, not the final answer: `EngineCore.diagnose`
            // refreshes it through `refreshLateCount`, which says out loud when
            // the refresh cannot happen (defect 3) instead of leaving a 0 to be
            // read as "no late arrivals".
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

    /// A closed window's late count, or which refusal applies when it has none.
    ///
    /// Defect 1 (2026-10-22): `.graceOpen` is the refusal the count itself used to
    /// hide. The counting loop below only sees events that have **already landed**,
    /// so a read inside the grace period is not a count of late arrivals — it is a
    /// count of arrivals so far. The normal flow is act, diagnose ~0.3 s later, and
    /// `0 == stored.lateCount` (the act-time default) made `refreshLateCount` answer
    /// `.confirmed` = "nothing to rewrite": the archived pack certified "no late
    /// arrivals" for a window nobody had finished watching, and T8 could never go
    /// red for it. `lateCount(opId:)`'s nil, and therefore this case, is the fix.
    private enum LateReading {
        case closed(Int)
        case graceOpen(TimeInterval)
        case unavailable
        /// The grace elapsed, but the daemon's own ring dropped `evicted` events
        /// for this pid inside that grace window. The number below is then a
        /// **lower bound** on the late arrivals, never the count — so it may not be
        /// certified, and it may not be compared against the stored value to
        /// produce `.confirmed` (finding A6, 2026-10-27).
        case truncated(Int, evicted: Int, pid: Int32)
    }

    private func lateReading(opId: String) -> LateReading {
        lock.lock(); defer { lock.unlock() }
        guard let window = windows.first(where: { $0.opId == opId }), let t1 = window.t1,
              !window.probeGone else {
            return .unavailable
        }
        // The grace window is `(t1, t1 + lateGraceSeconds]`, so the count is only
        // final once the clock is strictly past it: an event can still arrive at
        // the last instant inside the boundary.
        let elapsed = now().timeIntervalSince(t1)
        guard elapsed > ProbeInbox.lateGraceSeconds else {
            return .graceOpen(ProbeInbox.lateGraceSeconds - max(0, elapsed))
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
        // Finding A6: the ring's loss *during the grace* belongs to this count. The
        // in-window tally (`eventsEvicted`, defect 3) was taken at close and says
        // nothing about `(t1, t1 + grace]`, so without this arm a burst that pushed
        // the earliest late events out before the read answers a low number and — if
        // that low number equals the stored act-time default — `.confirmed`, which
        // removes the "this was never measured" basis from the pack.
        let evictedDuringGrace = max(0, (ringEvictions[window.pid] ?? 0) - window.evictionsAtClose)
        return evictedDuringGrace > 0
            ? .truncated(late, evicted: evictedDuringGrace, pid: window.pid)
            : .closed(late)
    }

    /// Late arrivals for a closed window: handler events received in the
    /// grace period after t1 (P6 §2.3 — "delayed reaction" is exactly a
    /// handler firing shortly after the act, so no file:line preconditions;
    /// acts are serialized by the dispatcher, keeping attribution unambiguous).
    ///
    /// nil is "this window's late count cannot be measured", which covers four
    /// states: no record in the ring (evicted by `windowHistoryLimit`, or a
    /// restarted daemon), a window never closed, a window whose probe disconnected
    /// — defect 1's other half, because the ring it would be counted from is gone
    /// and a recycled pid's fresh ring is not this window's data — and, added by
    /// defect 1 proper, **the grace period has not closed yet**: what had arrived
    /// by read time is not the number of late arrivals, and a 0 read inside the
    /// grace says only "nothing has landed so far". A fifth now joins them (finding
    /// A6): the grace closed but the daemon dropped events for this pid inside it,
    /// so what can be read is a lower bound rather than a count.
    public func lateCount(opId: String) -> Int? {
        guard case let .closed(late) = lateReading(opId: opId) else { return nil }
        return late
    }

    /// What a diagnose-time late-count refresh actually established (defect 3).
    ///
    /// The old shape was `HandlerProbeSignal?`, and `nil` stood for two opposite
    /// facts: "the stored count is already final" and "nothing can ever read
    /// this count again". `EngineCore` substituted only on non-nil, so the second
    /// one kept the act-time `lateCount: 0` — a fabricated "no late arrivals" in
    /// the archived pack, and a pack for which T8 can never go red. Four outcomes
    /// now, so the refusal is sayable.
    public enum LateCountRefresh: Equatable {
        /// The final count is known and differs from the stored one.
        case measured(HandlerProbeSignal)
        /// The final count is known and equals the stored one: nothing to rewrite.
        /// Only reachable once the grace period has elapsed, which is what makes
        /// it a measurement of "no late arrivals" rather than a silence about them.
        case confirmed
        /// This pack carries no handlerProbe signal, so there is no late count to
        /// claim either way (§3.1 absence).
        case notCarried
        /// The count could not be established, for one of two stated causes: the
        /// grace period had not closed at read time, or the window left the ring
        /// and can never be read again. Both refuse the same claim, and `reason`
        /// names which one and what the caller can still do about it.
        case unmeasurable(reason: String)
    }

    /// Refresh a stored handlerProbe with the final late count (diagnose time).
    public func refreshLateCount(for pack: EvidencePack) -> LateCountRefresh {
        guard let stored = pack.signals.handlerProbe else { return .notCarried }
        switch lateReading(opId: pack.operationId) {
        case let .closed(late):
            guard late != stored.lateCount else { return .confirmed }
            return .measured(HandlerProbeSignal(
                probeVersion: stored.probeVersion,
                hitCount: stored.hitCount,
                handlers: stored.handlers,
                lateCount: late
            ))
        case let .graceOpen(remaining):
            // Two refusals, two remedies. This one is fixable by waiting, and the
            // sentence has to say *how long* and in which direction: the advice
            // this file used to give — "diagnose within 2 s of the act" — is
            // precisely the interval in which the count cannot be known, so it
            // sent callers to the one window guaranteed to produce the fake zero.
            let left = String(format: "%.2f", remaining)
            return .unmeasurable(reason: """
            the \(Int(ProbeInbox.lateGraceSeconds))s grace period after \(pack.operationId) closed is still \
            open (\(left)s left at read time), so handlerProbe.lateCount=\(stored.lateCount) \
            is only what had arrived by now — not a count of late arrivals, and a 0 here means nothing had \
            landed YET (T8 is undecidable until the grace closes: diagnose only after the grace has elapsed, \
            never within the grace window)
            """)
        case let .truncated(late, evicted, pid):
            // Its own sentence, like the other two causes: waiting does not fix
            // this one (the bytes are already gone), and what the reader should do
            // is account for the loss, not re-diagnose into a number.
            return .unmeasurable(reason: """
            the grace period after \(pack.operationId) elapsed, but this daemon dropped \(evicted) handler event(s) \
            for pid \(pid) from its event ring inside that window, so the late count readable now (\(late)) is a \
            lower bound rather than a measurement — neither it nor the stored `lateCount=\(stored.lateCount)` can be \
            certified (T8 stays undecidable for this pack; `probe_status` publishes `ringEvictedEvents` per pid, \
            which is where this loss is counted)
            """)
        case .unavailable:
            // Kept verbatim in substance, with the advice half corrected: nothing
            // can be counted for this window any more, so re-running is the only
            // route — and the re-run's own count needs the grace closed too.
            return .unmeasurable(reason: """
            the act window for \(pack.operationId) is no longer in the probe inbox's \
            \(ProbeInbox.windowHistoryLimit)-window ring, so the grace period after its close \
            can never be counted — handlerProbe.lateCount=\(stored.lateCount) is the value written \
            when the window closed, not a measurement of late arrivals (T8 is undecidable for this \
            pack — re-run the act and diagnose only after the grace has elapsed, never within \(Int(ProbeInbox.lateGraceSeconds))s of it)
            """)
        }
    }

    /// The signal-only view of `refreshLateCount`, kept for callers that have no
    /// use for the third answer. Prefer `refreshLateCount`: folding "unmeasurable"
    /// into nil is exactly the confusion defect 3 removes.
    public func refreshedHandlerProbe(for pack: EvidencePack) -> HandlerProbeSignal? {
        guard case let .measured(signal) = refreshLateCount(for: pack) else { return nil }
        return signal
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
                // "empty checkpoint payload" used to cover both halves, so a probe
                // that exported its domains and forgot the digest was told it had
                // exported nothing — and the remedy that follows points at the
                // wrong side of the wire.
                if entry.domains == nil {
                    setLastCheckpointError("empty checkpoint payload: no domains table")
                    return nil
                }
                setLastCheckpointError(
                    "checkpoint carried \(entry.domains!.count) domain(s) but no digest, so the daemon had nothing to recompute against"
                )
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
    /// `ringEvictedEvents` is the same rule for defect 3's loss — events **this
    /// daemon** dropped when that pid's ring overflowed `eventRingCapacity`. It is
    /// a daemon-side measurement, so absence means "nothing was evicted for it",
    /// and its presence is what lets a reader tell `hitCount: 512` from
    /// "512 arrived": the count below is a lower bound exactly that far.
    /// `EngineCore.probeStatus()` forwards the process-wide figure
    /// (`ringEvictionCount`) as `ringEvictedEventsTotal`.
    ///
    /// The probe's own drop counters (`droppedEvents`, `droppedWrites`,
    /// `rejectedKeys`, `droppedInboundFrames`, `droppedInboundLines`,
    /// `truncatedValues`) follow the
    /// **opposite** rule: they
    /// are added only when the
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
            // Defect 3: the daemon's own ring loss, published with the same rule
            // A-09's row key uses — present when that pid's overflow dropped at
            // least one event, absent meaning the daemon threw nothing away for
            // it. Never a `0` invented for a pid that is not (or is no longer) the
            // one the events came from.
            if let evicted = ringEvictions[connection.hello.pid], evicted > 0 {
                entry["ringEvictedEvents"] = evicted
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
            if let droppedInbound = connection.hello.droppedInboundFrames {
                entry["droppedInboundFrames"] = droppedInbound
            }
            if let droppedInboundLine = connection.hello.droppedInboundLines {
                entry["droppedInboundLines"] = droppedInboundLine
            }
            if let truncatedValues = connection.hello.truncatedValues {
                entry["truncatedValues"] = truncatedValues
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
    /// Production consumer: `EngineCore.probeStatus()`, which forwards this as the
    /// response's top-level `recentDisconnections` key, which
    /// `EngineCoreTests.testProbeStatusSurfacesTheRecordedDisconnections` pins
    /// along with its row shape, so a drop reaches an agent instead of living
    /// only in the daemon log.
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

    /// Probe events **this daemon** dropped from a pid's ring while `opId`'s window
    /// was open (defect 3), or nil when the window is no longer in the
    /// `windowHistoryLimit` ring — the same honest absence `lateCount` uses: no
    /// record is not a measured zero. `EngineCore.act` reads this right after
    /// `endWindow` and stamps the pack's `circuitBreaker.reason` with
    /// `probe-events-evicted`, because a `hitCount` produced from a truncated ring
    /// is a lower bound, not a complete measurement.
    public func eventsEvictedDuringWindow(opId: String) -> Int? {
        lock.lock(); defer { lock.unlock() }
        return windows.first(where: { $0.opId == opId })?.eventsEvicted
    }

    /// Events evicted from every ring since the daemon started (monotonic), the
    /// process-wide figure that survives a probe disconnecting — mirrors
    /// `unmapableStateFrameCount`, and is published by `EngineCore.probeStatus()`.
    public var ringEvictionCount: Int {
        lock.lock(); defer { lock.unlock() }
        return ringEvictionTotal
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
