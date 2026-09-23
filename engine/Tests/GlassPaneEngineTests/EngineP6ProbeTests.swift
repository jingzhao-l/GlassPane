import XCTest
@testable import GlassPaneEngine

// P6 spec v6.0 batch tests: probe wire codec, inbox windowing, peer-credential
// authentication of the probe listener, command delivery reporting, EngineCore
// act/diagnose/snapshot/restore integration, classifier T4/T5/T7/T8, and the
// probe_status method surface.

private let p6ClockStart = Date(timeIntervalSince1970: 1_758_200_000)

/// Shared mutable clock for inbox + core in one test.
private final class P6TimeBox {
    var now = p6ClockStart
}

/// Scripted probe reply: parses the daemon command line and answers through
/// `ingest`, mirroring what a live GlassPaneProbe does over the socket. The
/// Bool the sender returns is delivery, not reply: true means the bytes left
/// the daemon.
private func scriptedProbeReplies(
    inbox: ProbeInbox,
    domains: [String: [String: String]],
    digest: String? = nil,
    restoreDigest: String? = nil
) {
    let reply: (Int32, Data) -> Bool = { pid, data in
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard let type = object?["t"] as? String else { return true }
        switch type {
        case "checkpoint_export":
            let ref = object?["ref"] as? String ?? ""
            let reported = digest ?? ProbeWire.sha256Hex(ProbeWire.checkpointCanonical(domains))
            inbox.ingest(pid: pid, frame: .checkpoint(ref: ref, domains: domains, digest: reported, error: nil))
        case "checkpoint_restore":
            let post = restoreDigest ?? digest ?? ProbeWire.sha256Hex(ProbeWire.checkpointCanonical(domains))
            inbox.ingest(pid: pid, frame: .result(ok: true, postStateDigest: post, error: nil))
        default:
            break // op_begin / op_end need no reply in tests
        }
        return true
    }
    inbox.sender = reply
}

private func p6Hello(pid: Int32 = 4242, capabilities: [String]) -> ProbeHello {
    ProbeHello(
        pid: pid, bundleId: "com.example.app", appName: "Example",
        probeVersion: "gp-probe/0.1.0", capabilities: capabilities
    )
}

// MARK: - ProbeWire

final class P6ProbeWireTests: XCTestCase {

    func testHelloHandlerStateDecode() throws {
        let hello = ProbeWire.decode(Data(#"{"t":"hello","pid":42,"appName":"Demo","probeVersion":"gp-probe/0.1.0","capabilities":["z1","z2","checkpoint"],"bundleId":"com.example.demo"}"#.utf8))
        guard case .hello(let parsed) = hello else { return XCTFail("hello expected: \(hello)") }
        XCTAssertEqual(parsed.pid, 42)
        XCTAssertEqual(parsed.bundleId, "com.example.demo")
        XCTAssertEqual(parsed.capabilities, ["z1", "z2", "checkpoint"])

        let handler = ProbeWire.decode(Data(#"{"t":"handler","file":"View.swift","line":12,"ts":1.5,"durationNs":2200}"#.utf8))
        XCTAssertEqual(handler, .handler(file: "View.swift", line: 12, ts: 1.5, durationNs: 2200))

        let state = ProbeWire.decode(Data(#"{"t":"state","key":"model.count","before":"3","after":"4","source":"z2-mirror","ts":2.0}"#.utf8))
        XCTAssertEqual(state, .state(key: "model.count", before: "3", after: "4", source: "z2-mirror", ts: 2.0))
    }

    func testMalformedFramesNeverThrow() {
        guard case .malformed = ProbeWire.decode(Data("not json".utf8)) else { return XCTFail("bad JSON must be malformed") }
        guard case .malformed = ProbeWire.decode(Data(#"{"pid":1}"#.utf8)) else { return XCTFail("missing t must be malformed") }
        guard case .malformed = ProbeWire.decode(Data(#"{"t":"mystery"}"#.utf8)) else { return XCTFail("unknown type must be malformed") }
        guard case .malformed = ProbeWire.decode(Data(#"{"t":"hello","pid":-1,"appName":"x","probeVersion":"v"}"#.utf8)) else { return XCTFail("pid<=0 must be malformed") }
        guard case .malformed = ProbeWire.decode(Data(#"{"t":"handler","file":"a"}"#.utf8)) else { return XCTFail("handler without line must be malformed") }
    }

    func testCommandEncodingIsSortedSingleLineJSON() throws {
        let data = ProbeWire.command("checkpoint_restore", ["ref": "snap_A", "domains": ["counter"]])
        XCTAssertEqual(data.last, UInt8(ascii: "\n"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["t"] as? String, "checkpoint_restore")
        XCTAssertEqual(
            String(data: data.subdata(in: 0..<(data.count - 1)), encoding: .utf8),
            #"{"domains":["counter"],"ref":"snap_A","t":"checkpoint_restore"}"#
        )
    }

    func testCheckpointCanonicalIsDeterministicAndEscaped() {
        let a = ProbeWire.checkpointCanonical(["b": ["y": "2", "x": "1\"\n"], "a": ["k": "v"]])
        XCTAssertEqual(a, #"{"a":{"k":"v"},"b":{"x":"1\"\n","y":"2"}}"#)
        let b = ProbeWire.checkpointCanonical(["a": ["k": "v"], "b": ["y": "2", "x": "1\"\n"]])
        XCTAssertEqual(a, b, "key insertion order must not change the digest input")
    }
}

// MARK: - ProbeInbox windowing

final class P6ProbeInboxTests: XCTestCase {

    /// ISO-8601 with exactly three fractional digits and a literal Z (kernel
    /// ISO_MILLIS_PATTERN's shape).
    static let isoMillisPattern = #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"#

    func testWindowCollectsHandlerAndStateSignals() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2", "checkpoint"]))
        inbox.beginWindow(pid: 4242, opId: "op_window1")
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 12, ts: 0, durationNs: nil))
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 12, ts: 0, durationNs: nil))
        inbox.ingest(pid: 4242, frame: .state(key: "model.count", before: "3", after: "4", source: "z2-mirror", ts: 0))
        time.now = time.now.addingTimeInterval(0.2)
        inbox.ingest(pid: 4242, frame: .state(key: "model.count", before: "4", after: "5", source: "z2-mirror", ts: 0))
        guard let signals = inbox.endWindow(pid: 4242, opId: "op_window1") else { return XCTFail("window must exist") }
        let handlerProbe = try XCTUnwrap(signals.handlerProbe)
        XCTAssertEqual(handlerProbe.hitCount, 2)
        XCTAssertEqual(handlerProbe.handlers, [HandlerRef(file: "View.swift", line: 12)])
        XCTAssertEqual(handlerProbe.probeVersion, "gp-probe/0.1.0")
        let stateDiff = try XCTUnwrap(signals.stateDiff)
        XCTAssertTrue(stateDiff.changed)
        // First-before / last-after collapse per key (§3.1).
        XCTAssertEqual(stateDiff.entries, [StateEntry(key: "model.count", before: "3", after: "5")])
    }

    /// X-1: the SDK re-sends `hello` every time its capability set changes, and a
    /// reconnect of the same process also arrives as a hello for the same pid. That
    /// must NOT reset the per-pid event ring — if it did, the in-flight window would
    /// lose the handlers it had already collected and the pack would report
    /// `hitCount: 0` for an act whose handlers really ran (a "not sampled" rendered
    /// as "no hit").
    func testCapabilityReAdvertisementPreservesInFlightWindow() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_readvertise")
        inbox.ingest(pid: 4242, frame: .handler(file: "Before.swift", line: 7, ts: 0, durationNs: nil))

        // The app registers a mirror root mid-session: same pid, wider capability set.
        XCTAssertTrue(inbox.register(p6Hello(capabilities: ["z1", "z2"])))
        inbox.ingest(pid: 4242, frame: .handler(file: "After.swift", line: 9, ts: 0, durationNs: nil))
        inbox.ingest(pid: 4242, frame: .state(key: "model.count", before: "1", after: "2", source: "z2-mirror", ts: 0))

        guard let signals = inbox.endWindow(pid: 4242, opId: "op_readvertise") else {
            return XCTFail("window must survive a capability re-advertisement")
        }
        let handlerProbe = try XCTUnwrap(signals.handlerProbe)
        XCTAssertEqual(handlerProbe.hitCount, 2, "handler seen before the re-hello must not be erased")
        XCTAssertEqual(handlerProbe.handlers, [
            HandlerRef(file: "Before.swift", line: 7),
            HandlerRef(file: "After.swift", line: 9),
        ])
        XCTAssertNotNil(signals.stateDiff, "the newly advertised z2 channel must be honoured")
    }

    /// A pid that genuinely went away is disconnected first, and `disconnect` clears
    /// the ring — so a later hello from a recycled pid starts clean rather than
    /// inheriting another process's events.
    func testDisconnectThenReRegisterStartsFromEmptyRing() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_gone")
        inbox.ingest(pid: 4242, frame: .handler(file: "Old.swift", line: 1, ts: 0, durationNs: nil))
        inbox.disconnect(pid: 4242, reason: "connection closed")
        inbox.register(p6Hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_new")
        inbox.ingest(pid: 4242, frame: .handler(file: "Fresh.swift", line: 2, ts: 0, durationNs: nil))
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_new"))
        XCTAssertEqual(signals.handlerProbe?.handlers, [HandlerRef(file: "Fresh.swift", line: 2)],
                       "a re-registered pid must not inherit the previous process's events")
    }

    func testStateIncapableProbeWithoutEventsKeepsStateDiffNull() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_window2")
        guard let signals = inbox.endWindow(pid: 4242, opId: "op_window2") else { return XCTFail("window must exist") }
        XCTAssertNotNil(signals.handlerProbe)
        XCTAssertNil(signals.stateDiff, "silence from a state-incapable probe must not become changed=false")
    }

    func testManualZ1StateEventsConstituteAChannel() throws {
        // H7 opt-in form: probe declares only z1 but reports state manually
        // (§8/§4 recordState). Real events override the capability gate.
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_manual")
        inbox.ingest(pid: 4242, frame: .state(key: "volume.42", before: "0.5", after: "0.6", source: "z1-macro", ts: 0))
        guard let signals = inbox.endWindow(pid: 4242, opId: "op_manual") else { return XCTFail("window must exist") }
        let stateDiff = try XCTUnwrap(signals.stateDiff)
        XCTAssertEqual(stateDiff.source, .z1Macro)
        XCTAssertTrue(stateDiff.changed)
    }

    func testLateCountWithinGraceAndNotAfter() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2"]))
        inbox.beginWindow(pid: 4242, opId: "op_late")
        guard inbox.endWindow(pid: 4242, opId: "op_late") != nil else { return XCTFail("window must exist") }
        time.now = time.now.addingTimeInterval(0.5)
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 30, ts: 0, durationNs: nil))
        time.now = time.now.addingTimeInterval(ProbeInbox.lateGraceSeconds)
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 30, ts: 0, durationNs: nil))
        XCTAssertEqual(inbox.lateCount(opId: "op_late"), 1, "only the in-grace event counts")
        XCTAssertNil(inbox.lateCount(opId: "op_missing"))
    }

    func testEndWindowWithoutBeginOrDoubleCloseIsNil() {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        XCTAssertNil(inbox.endWindow(pid: 9999, opId: "op_none"))
        inbox.register(p6Hello(capabilities: ["z1", "z2"]))
        inbox.beginWindow(pid: 4242, opId: "op_open")
        XCTAssertNil(inbox.endWindow(pid: 4242, opId: "op_other"))
        XCTAssertNotNil(inbox.endWindow(pid: 4242, opId: "op_open"))
        XCTAssertNil(inbox.endWindow(pid: 4242, opId: "op_open"), "double close must not resurface the window")
    }

    func testStatusJSONCarriesConnectedAtAndDropCause() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2", "checkpoint"]))
        inbox.ingest(pid: 4242, frame: .handler(file: "a", line: 1, ts: 0, durationNs: nil))
        let status = inbox.statusJSON()
        XCTAssertEqual(status.count, 1)
        let entry = try XCTUnwrap(status.first)
        XCTAssertEqual(entry["pid"] as? Int, 4242)
        XCTAssertEqual(entry["appName"] as? String, "Example")
        XCTAssertEqual(entry["eventsSeen"] as? Int, 1)
        XCTAssertEqual(entry["bundleId"] as? String, "com.example.app")
        XCTAssertEqual(entry["connected"] as? Bool, true)
        XCTAssertNotNil(inbox.connection(for: 4242))
        // §5.3(3) names connectedAt; without it "just reconnected" and
        // "connected since attach" were the same row (R6-04).
        let connectedAt = try XCTUnwrap(entry["connectedAt"] as? String)
        XCTAssertEqual(connectedAt, ProbeInbox.iso8601(p6ClockStart))
        XCTAssertNotNil(
            connectedAt.range(of: Self.isoMillisPattern, options: .regularExpression),
            "connectedAt must be ISO-8601 with milliseconds in UTC, the shape every other engine timestamp uses"
        )

        inbox.disconnect(pid: 4242, reason: "read failed: errno 54 (Connection reset by peer)")
        XCTAssertNil(inbox.connection(for: 4242), "a dropped probe is not a live connection")
        XCTAssertFalse(inbox.isStateCapable(pid: 4242))
        // A-10: the dropped probe leaves `probes` altogether. Every reader of
        // that array — `spike/run_h1_retest.py`, `spike/run_spikes2.py` and the
        // agent mental model they encode — treats "the pid is in `probes`" as
        // "the pid has a live probe", so a row for a dead probe made a dropped
        // probe read as an attached one and an act spent against it reported
        // `hitCount: 0` as measurement.
        XCTAssertTrue(
            inbox.statusJSON().isEmpty,
            "probes must mean live registrations: A-10's whole contract"
        )
        // The row survives on purpose, in its own array: an empty list used to
        // read as "never integrated" even for a probe that had just been
        // connected (R2-18).
        let dropped = try XCTUnwrap(inbox.recentDisconnectionsJSON().first)
        XCTAssertEqual(dropped["connected"] as? Bool, false)
        XCTAssertEqual(dropped["eventsSeen"] as? Int, 1)
        XCTAssertEqual(dropped["drops"] as? Int, 1)
        XCTAssertEqual((dropped["disconnectReason"] as? String)?.contains("errno 54"), true)
        XCTAssertNotNil(dropped["disconnectedAt"] as? String)
        XCTAssertEqual(inbox.recordedDisconnectionCount, 1)
        inbox.beginWindow(pid: 4242, opId: "op_after_drop")
        XCTAssertNil(
            inbox.endWindow(pid: 4242, opId: "op_after_drop"),
            "a dropped probe cannot open an act window: the row is history, not connectivity"
        )
    }

    /// A-10: the two arrays are disjoint by construction — a pid that
    /// re-registered is a live row and its older drop stays out of both.
    func testRecentDisconnectionsNeverAppearInTheLiveProbesArray() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(p6Hello(pid: 4242, capabilities: ["z1"]))
        inbox.disconnect(pid: 4242, reason: "peer closed the connection (EOF)")
        inbox.register(p6Hello(pid: 4242, capabilities: ["z1", "z3"]))
        let live = inbox.statusJSON()
        XCTAssertEqual(live.count, 1)
        XCTAssertEqual(live.first?["capabilities"] as? [String], ["z1", "z3"], "the re-hello's capabilities are authoritative")
        XCTAssertFalse(
            live.contains { ($0["connected"] as? Bool) == false },
            "no row of `probes` may say connected:false (A-10)"
        )
        XCTAssertTrue(
            inbox.recentDisconnectionsJSON().isEmpty,
            "the pid is live again: its history is not a disconnection now"
        )
        XCTAssertEqual(inbox.recordedDisconnectionCount, 1, "the drop still happened")
    }

    /// A-05: `ingest` must not be a second door into the connection table. The
    /// hello branch there cleared the pid's event ring, enforced neither
    /// `maxRegisteredProbes` nor the peer-credential decision the socket layer
    /// makes, and is no longer reachable from the daemon at all.
    func testHelloFrameThroughIngestRegistersNothingAndErasesNothing() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })

        // An unknown pid cannot become a registration by pushing a hello frame.
        inbox.ingest(pid: 9999, frame: .hello(p6Hello(pid: 9999, capabilities: ["z1", "z2"])))
        XCTAssertNil(inbox.connection(for: 9999), "ingest is not an admission path (A-05)")
        XCTAssertTrue(inbox.statusJSON().isEmpty, "a forged hello frame must not show up as a live probe")
        XCTAssertEqual(inbox.recordedDisconnectionCount, 0)
        inbox.beginWindow(pid: 9999, opId: "op_forged")
        XCTAssertNil(inbox.endWindow(pid: 9999, opId: "op_forged"))

        // A hello for a pid that IS registered must not touch its entry or ring.
        inbox.register(p6Hello(capabilities: ["z1", "z2"]))
        inbox.beginWindow(pid: 4242, opId: "op_ingest_hello")
        inbox.ingest(pid: 4242, frame: .handler(file: "Keep.swift", line: 5, ts: 0, durationNs: nil))
        let before = try XCTUnwrap(inbox.connection(for: 4242))
        inbox.ingest(pid: 4242, frame: .hello(ProbeHello(
            pid: 4242, bundleId: "com.example.app", appName: "Example",
            probeVersion: "gp-probe/0.9.9", capabilities: []
        )))
        let after = try XCTUnwrap(inbox.connection(for: 4242))
        XCTAssertEqual(after, before, "only `register` may replace a registration")
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_ingest_hello"))
        XCTAssertEqual(
            signals.handlerProbe?.handlers, [HandlerRef(file: "Keep.swift", line: 5)],
            "the old hello branch wiped the ring; that is the X-1 false negative"
        )
    }

    /// Residual (A-1's second door): a disconnect for a pid that is not
    /// registered is a no-op, ordered like `register` checks. The reachable
    /// half of that contract is that it invents no record; the event-ring half
    /// has no reader from outside the inbox (`lateCount` needs a window, and a
    /// window needs a registration), so it is pinned by ordering, not by a
    /// probe — see the comment on `disconnect(pid:reason:)`.
    func testDisconnectOfUnregisteredPidRecordsNothing() {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(p6Hello(capabilities: ["z1"]))
        inbox.disconnect(pid: 9999, reason: "stray teardown")
        inbox.disconnect(pid: 9999, reason: "stray teardown again")
        XCTAssertEqual(inbox.recordedDisconnectionCount, 0, "an unregistered pid never dropped")
        XCTAssertEqual(inbox.recentDisconnectionsJSON().count, 0)
        XCTAssertEqual(inbox.statusJSON().count, 1, "the live registration is untouched")
        XCTAssertEqual(inbox.statusJSON().first?["pid"] as? Int, 4242)
    }


    func testStatusJSONIsEmptyForNeverRegisteredProbes() {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        XCTAssertTrue(
            inbox.statusJSON().isEmpty,
            "no hello ever sent => no row at all; absence must stay absence"
        )
        XCTAssertEqual(inbox.recordedDisconnectionCount, 0)
    }

    func testCheckpointExportRejectsTamperedDigest() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2", "checkpoint"]))
        scriptedProbeReplies(
            inbox: inbox,
            domains: ["counter": ["value": "3"]],
            digest: String(repeating: "0", count: 64)
        )
        XCTAssertNil(inbox.checkpointExport(pid: 4242, ref: "snap_x", timeout: 0.1))
        XCTAssertTrue(inbox.lastCheckpointError?.contains("digest mismatch") ?? false)
    }

    // MARK: Z1 entry/duration aggregation (P6 §2.2, R6-05)

    func testSlowHandlerDurationFollowUpIsNotCountedTwice() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2"]))
        inbox.beginWindow(pid: 4242, opId: "op_slow")
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 44, ts: 0, durationNs: nil))
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 44, ts: 0, durationNs: 2_400_000))
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_slow"))
        let handlerProbe = try XCTUnwrap(signals.handlerProbe)
        XCTAssertEqual(
            handlerProbe.hitCount, 1,
            "the >1ms exit frame is the same invocation as the entry frame, not a second hit"
        )
        XCTAssertEqual(handlerProbe.handlers, [HandlerRef(file: "View.swift", line: 44)])
    }

    func testRepeatedSlowHandlerCountsInvocationsNotFrames() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2"]))
        inbox.beginWindow(pid: 4242, opId: "op_twice")
        for _ in 0..<2 {
            inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 7, ts: 0, durationNs: nil))
            inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 7, ts: 0, durationNs: 5_000_000))
        }
        inbox.ingest(pid: 4242, frame: .handler(file: "Other.swift", line: 3, ts: 0, durationNs: 7_000_000))
        let handlerProbe = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_twice")?.handlerProbe)
        XCTAssertEqual(handlerProbe.hitCount, 3, "two slow invocations of one site plus one orphan duration frame")
        XCTAssertEqual(handlerProbe.handlers.count, 2)
    }

    func testLateDurationFollowUpIsNotCountedTwice() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2"]))
        inbox.beginWindow(pid: 4242, opId: "op_late_pair")
        XCTAssertNotNil(inbox.endWindow(pid: 4242, opId: "op_late_pair"))
        time.now = time.now.addingTimeInterval(0.4)
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 88, ts: 0, durationNs: nil))
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 88, ts: 0, durationNs: 3_000_000))
        XCTAssertEqual(inbox.lateCount(opId: "op_late_pair"), 1, "one late invocation, two late frames")
    }

    func testCountsAsInvocationRule() {
        XCTAssertTrue(
            ProbeInbox.countsAsInvocation(file: "a.swift", line: 1, durationNs: nil, seenKeys: ["a.swift:1"]),
            "an entry frame is always an invocation"
        )
        XCTAssertFalse(
            ProbeInbox.countsAsInvocation(file: "a.swift", line: 1, durationNs: 4, seenKeys: ["a.swift:1"]),
            "a duration frame for an already-counted site is the same invocation"
        )
        XCTAssertTrue(
            ProbeInbox.countsAsInvocation(file: "a.swift", line: 1, durationNs: 4, seenKeys: []),
            "a duration frame with no entry in the window still proves one run"
        )
    }

    // MARK: stateDiff source derivation (P6 §3.1, R6-15)

    func testZ3OnlyProbeWithoutStateEventsNamesZ3() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z3", "checkpoint"]))
        inbox.beginWindow(pid: 4242, opId: "op_z3")
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_z3"))
        let stateDiff = try XCTUnwrap(signals.stateDiff)
        XCTAssertEqual(
            stateDiff.source, .z3KVC,
            "the channel must come from what the probe declared; z2-mirror was invented"
        )
        XCTAssertFalse(stateDiff.changed)
        XCTAssertTrue(stateDiff.entries.isEmpty)
    }

    func testSourceDerivationPrefersObservedFramesAndNeverInvents() {
        XCTAssertEqual(ProbeInbox.stateDiffSource(observed: .z1Macro, capabilities: ["z1", "z3"]), .z1Macro)
        XCTAssertEqual(ProbeInbox.stateDiffSource(observed: nil, capabilities: ["z1", "z2"]), .z2Mirror)
        XCTAssertEqual(ProbeInbox.stateDiffSource(observed: nil, capabilities: ["z3"]), .z3KVC)
        XCTAssertNil(ProbeInbox.stateDiffSource(observed: nil, capabilities: ["z1"]))
        XCTAssertNil(ProbeInbox.stateDiffSource(observed: nil, capabilities: ["z1", "checkpoint"]))
        XCTAssertNil(ProbeInbox.declaredStateSource(capabilities: ["z1", "checkpoint"]))
    }

    /// A-09 (the survivable half): a probe that reported before/after frames
    /// whose `source` token this daemon cannot read is still credited to the
    /// channel its *hello* declared — the declaration is kernel-verified, the
    /// token is not, and throwing the pair away silently downgraded strong
    /// attribution to soft with no trace.
    func testUnreadableStateSourceFallsBackToTheDeclaredChannelNotToSilence() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(p6Hello(capabilities: ["z1", "z2"]))
        inbox.beginWindow(pid: 4242, opId: "op_unknown_src")
        inbox.ingest(pid: 4242, frame: .state(
            key: "model.count", before: "3", after: "4", source: "z4-teleprompter", ts: 0
        ))
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_unknown_src"))
        let stateDiff = try XCTUnwrap(signals.stateDiff, "the observation is real; only the token is unreadable")
        XCTAssertEqual(stateDiff.source, .z2Mirror, "named from the hello, never from the unmapable frame")
        XCTAssertTrue(stateDiff.changed)
        XCTAssertEqual(stateDiff.entries, [StateEntry(key: "model.count", before: "3", after: "4")])
        XCTAssertEqual(inbox.unmapableStateFrameCount, 1, "and the unreadable token is counted, not swallowed")
        XCTAssertEqual(inbox.statusJSON().first?["stateFramesUnmappedSource"] as? Int, 1)
    }

    /// A-09 (the un-survivable half) + R6-15: with no declared channel either,
    /// `stateDiff` stays absent — a fabricated default must not come back — but
    /// the absence is attributable: the frames are counted per pid and in total,
    /// so "this probe has no state channel" can be told apart from "state frames
    /// arrived through a channel this daemon cannot read".
    func testUnreadableStateSourceWithoutDeclaredChannelIsCountedNotInvented() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(p6Hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_unnameable")
        inbox.ingest(pid: 4242, frame: .state(
            key: "volume.42", before: "0.5", after: "0.6", source: "z9-mystery", ts: 0
        ))
        inbox.ingest(pid: 4242, frame: .state(
            key: "volume.42", before: "0.6", after: "0.7", source: "z9-mystery", ts: 0
        ))
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_unnameable"))
        XCTAssertNotNil(signals.handlerProbe, "the handler signal is unaffected by the state-channel question")
        XCTAssertNil(signals.stateDiff, "no channel may be invented for a probe that never declared one (R6-15)")
        XCTAssertEqual(inbox.unmapableStateFrameCount, 2)
        XCTAssertEqual(inbox.statusJSON().first?["stateFramesUnmappedSource"] as? Int, 2)
        XCTAssertFalse(inbox.isStateCapable(pid: 4242), "capability still means *declared*, not *observed but unreadable*")

        // A drop-off takes the per-pid tally with it; the monotonic total stays.
        inbox.disconnect(pid: 4242, reason: "peer closed the connection (EOF)")
        XCTAssertEqual(inbox.unmapableStateFrameCount, 2)
        inbox.register(p6Hello(pid: 4242, capabilities: ["z1"]))
        XCTAssertNil(
            inbox.statusJSON().first?["stateFramesUnmappedSource"],
            "a fresh registration of a recycled pid starts clean"
        )
    }

    /// A pid that sends nothing unmapable gets no `stateFramesUnmappedSource`
    /// key: absence means zero measured, never a default.
    func testLiveProbeRowOmitsTheUnmappedTallyWhenNothingFellThrough() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(p6Hello(capabilities: ["z1", "z2"]))
        inbox.ingest(pid: 4242, frame: .state(key: "k", before: "1", after: "2", source: "z2-mirror", ts: 0))
        let row = try XCTUnwrap(inbox.statusJSON().first)
        XCTAssertNil(row["stateFramesUnmappedSource"])
        XCTAssertEqual(inbox.unmapableStateFrameCount, 0)
        XCTAssertEqual(row["eventsSeen"] as? Int, 1, "the frame itself is still counted as seen")
    }

    // MARK: command delivery (R2-07)

    func testSendCommandReportsDeliveryBothWays() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(p6Hello(capabilities: ["z1"]))
        XCTAssertFalse(inbox.sendCommand("op_begin", to: 4242), "no sender means nothing can be delivered")
        XCTAssertTrue(inbox.lastDeliveryError?.contains("no probe socket") ?? false)

        var seen: [String] = []
        let recorder: (Int32, Data) -> Bool = { _, data in
            seen.append(String(data: data, encoding: .utf8) ?? "")
            return true
        }
        inbox.sender = recorder
        XCTAssertTrue(inbox.sendCommand("op_end", to: 4242))
        XCTAssertNil(inbox.lastDeliveryError)
        XCTAssertEqual(seen.count, 1)

        inbox.sender = { _, _ in false }
        XCTAssertFalse(inbox.sendCommand("op_begin", to: 4242))
        XCTAssertTrue(inbox.lastDeliveryError?.contains("not delivered") ?? false)
    }

    func testUndeliveredCheckpointExportIsNotReportedAsTimeout() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(p6Hello(capabilities: ["z1", "z2", "checkpoint"]))
        inbox.sender = { _, _ in false }
        let started = Date()
        XCTAssertNil(inbox.checkpointExport(pid: 4242, ref: "snap_d", timeout: 5.0))
        let error = try XCTUnwrap(inbox.lastCheckpointError)
        XCTAssertTrue(error.contains("not delivered"), error)
        XCTAssertFalse(error.contains("timed out"), "a command that never left must not become the probe's silence: \(error)")
        XCTAssertLessThan(
            Date().timeIntervalSince(started), 1.0,
            "delivery failure returns at once instead of burning the whole timeout budget"
        )
    }

    func testUndeliveredCheckpointRestoreIsNotReportedAsRefusal() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(p6Hello(capabilities: ["z1", "checkpoint"]))
        inbox.sender = { _, _ in false }
        XCTAssertNil(inbox.checkpointRestore(pid: 4242, ref: "snap_r", domains: ["counter"], timeout: 5.0))
        let error = try XCTUnwrap(inbox.lastResultError)
        XCTAssertTrue(error.contains("not delivered"), error)
        XCTAssertFalse(error.contains("refused"), "the probe never heard about the restore: \(error)")
    }

    // MARK: registration bounds (R5-06, A-11)
    /// What this pins is the **inbox-side backstop**, reached by calling
    /// `register` directly. A-11: it is *not* the daemon's live gate —
    /// `ProbeSocketServer` admits at most `maxConcurrentClients` (8) connections
    /// and one connection can register exactly one pid, so a socket-served probe
    /// face can never grow the table to 16. `testClientCapCountsClientsNotTheListener`
    /// pins the live gate, and `testListenerBoundsStayInsideInboxCapacity` keeps
    /// the two numbers in the honest order.
    func testRegisteredPidCapacityIsEnforced() {
        let inbox = ProbeInbox(now: { Date() })
        for pid in 1...Int32(ProbeInbox.maxRegisteredProbes) {
            XCTAssertTrue(inbox.register(p6Hello(pid: pid, capabilities: ["z1"])), "pid \(pid) fits under the cap")
        }
        XCTAssertFalse(
            inbox.register(p6Hello(pid: 9999, capabilities: ["z1"])),
            "distinct pids are bounded, so streaming hellos cannot grow the table"
        )
        XCTAssertTrue(
            inbox.register(p6Hello(pid: 1, capabilities: ["z1"])),
            "a re-hello for a registered pid replaces its entry (§2.2) and stays admitted"
        )
        XCTAssertEqual(inbox.statusJSON().count, ProbeInbox.maxRegisteredProbes)
        XCTAssertGreaterThan(
            ProbeInbox.maxRegisteredProbes, ProbeSocketServer.maxConcurrentClients,
            "the inbox cap has to stay looser than the connection cap or the socket layer would "
                + "refuse connections the inbox could have kept and the refusal branch here would "
                + "not be the backstop the comment says it is"
        )
    }
}

// MARK: - Probe listener peer credentials (P6 §2.1, R5-01)

final class P6ProbePeerCredentialTests: XCTestCase {

    private func identity(
        pid: Int32?, uid: uid_t?, pidErrno: Int32? = nil, uidErrno: Int32? = nil
    ) -> ProbeSocketServer.PeerIdentity {
        ProbeSocketServer.PeerIdentity(pid: pid, uid: uid, pidErrno: pidErrno, uidErrno: uidErrno)
    }

    func testMatchingPeerIsAdmitted() {
        XCTAssertNil(
            ProbeSocketServer.helloRejectionReason(
                claimedPID: 4242,
                peer: identity(pid: 4242, uid: ProbeSocketServer.daemonUID),
                daemonUID: ProbeSocketServer.daemonUID
            ),
            "a hello whose declared pid and uid match the kernel's peer is the normal case"
        )
    }

    func testForgedPidIsRejected() throws {
        let reason = try XCTUnwrap(ProbeSocketServer.helloRejectionReason(
            claimedPID: 4242,
            peer: identity(pid: 999, uid: ProbeSocketServer.daemonUID),
            daemonUID: ProbeSocketServer.daemonUID
        ))
        XCTAssertTrue(reason.contains("4242"), reason)
        XCTAssertTrue(reason.contains("999"), reason)
    }

    func testOtherUsersPeerIsRejected() throws {
        let foreignUID: uid_t = ProbeSocketServer.daemonUID == 0 ? 501 : 0
        let reason = try XCTUnwrap(ProbeSocketServer.helloRejectionReason(
            claimedPID: 4242, peer: identity(pid: 4242, uid: foreignUID),
            daemonUID: ProbeSocketServer.daemonUID
        ))
        XCTAssertTrue(reason.contains("uid"), reason)
    }

    func testUnreadablePidFailsClosed() throws {
        // No "trust the self-declared pid" fallback: unverified means unregistered.
        let reason = try XCTUnwrap(ProbeSocketServer.helloRejectionReason(
            claimedPID: 4242,
            peer: identity(pid: nil, uid: ProbeSocketServer.daemonUID, pidErrno: ENOPROTOOPT),
            daemonUID: ProbeSocketServer.daemonUID
        ))
        XCTAssertTrue(reason.contains("pid"), reason)
        XCTAssertTrue(reason.contains("unreadable"), reason)
    }

    func testUnreadableUidFailsClosedBeforePidIsConsulted() throws {
        let reason = try XCTUnwrap(ProbeSocketServer.helloRejectionReason(
            claimedPID: 4242,
            peer: identity(pid: 4242, uid: nil, uidErrno: EBADF),
            daemonUID: ProbeSocketServer.daemonUID
        ))
        XCTAssertTrue(reason.contains("getpeereid"), reason)
    }

    func testListenerBoundsStayInsideInboxCapacity() {
        // Refusing a connection is only honest if the inbox could have kept it:
        // the connection cap must not exceed the distinct-pid cap.
        XCTAssertLessThanOrEqual(
            ProbeSocketServer.maxConcurrentClients, ProbeInbox.maxRegisteredProbes
        )
        XCTAssertGreaterThan(ProbeSocketServer.preHelloReadTimeoutSeconds, 0)
        XCTAssertGreaterThan(ProbeSocketServer.idleReadTimeoutSeconds, 0)
        XCTAssertGreaterThan(ProbeSocketServer.commandWriteTimeoutSeconds, 0)
    }
}

// MARK: - Live probe socket face (A-06, A-11, A-17)

/// These three drive a real `ProbeSocketServer` with real client sockets (see
/// `P6SocketFaceFixture`), because the facts they pin are only observable
/// through a live descriptor: which lock a write holds, how many clients fit
/// under the cap, and whether a closed descriptor can still be written to.
final class P6ProbeSocketFaceTests: XCTestCase {

    /// A-06: the shared state lock must never be held across a bounded command
    /// write, because every probe reader thread and the accept loop take it on
    /// each iteration. The assertion is on the *face*, not on the lock: one peer
    /// that stops draining may cost its own connection its own write budget, and
    /// nothing else — not another app's command, not a new app's hello. With the
    /// pre-A-06 code both measurements come out at the ~2 s write budget.
    ///
    /// The condition has to be *produced*, not assumed. A peer that merely never
    /// reads can absorb a whole command line in kernel buffers, and macOS
    /// auto-tunes a unix socket towards `kern.ipc.maxsockbuf`, which on current
    /// releases is far above any payload a test may reasonably build (an earlier
    /// build of this case pushed 8 MiB through in ~0 s and reported *delivered* —
    /// a green run that measured nothing). So: shrink the stalled peer's receive
    /// buffer, push bounded chunks until one send cannot go out, then keep that
    /// connection inside a blocked write for as long as the measurements run. The
    /// recorded per-send timing is what distinguishes "back-pressure happened"
    /// from "the connection was gone", and a platform that cannot be filled skips
    /// with its numbers instead of passing vacuously.
    func testStalledPeerDoesNotDelayAnotherPeersCommandOrTheAcceptLoop() throws {
        let fixture = try P6SocketFaceFixture.open(requireVerifiedPeer: false)
        defer { fixture.teardown() }

        let chunkBytes = 64 * 1024
        let stalledPeer = try XCTUnwrap(
            fixture.connectAndHello(pid: 9101), "first client must be registered"
        )
        XCTAssertNotNil(fixture.connectAndHello(pid: 9102), "second client must be registered")
        // The peer that stalls is an accepted socket that never reads a byte, and
        // the space the daemon has to write into is *that socket's* receive
        // buffer — so shrinking it is what makes back-pressure reachable in
        // kilobytes instead of megabytes. A refused request is not a failure of
        // the test: the push budget covers it, and the skip text reports which of
        // the two happened.
        let grantedBuffer = fixture.shrinkReceiveBuffer(stalledPeer, to: chunkBytes)
        let chunk = String(repeating: "x", count: chunkBytes)

        let filled = DispatchSemaphore(value: 0)
        let measured = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue(label: "p6.stalled-writer").async {
            // Fill. Nothing drains this peer, so the successful sends queue up
            // until one of them cannot go out at all.
            while fixture.stall.sends < P6SocketFaceFixture.stallPushLimit {
                let started = Date()
                let delivered = fixture.inbox.sendCommand("op_begin", ["pad": chunk], to: 9101)
                fixture.recordSend(
                    delivered: delivered, bytes: chunkBytes,
                    seconds: Date().timeIntervalSince(started)
                )
                if !delivered { break }
            }
            // Hold. The buffer is full and stays full — nobody reads this socket —
            // so every write now costs its whole budget. Issuing the next one
            // immediately and only then telling the main thread to measure is what
            // makes the two overlap a property of the design rather than a raced
            // `Thread.sleep`: the stall repeats until it is released.
            filled.signal()
            while fixture.stall.sends < P6SocketFaceFixture.stallPushLimit,
                  measured.wait(timeout: .now()) == .timedOut {
                let started = Date()
                let delivered = fixture.inbox.sendCommand("op_begin", ["pad": chunk], to: 9101)
                fixture.recordSend(
                    delivered: delivered, bytes: chunkBytes,
                    seconds: Date().timeIntervalSince(started)
                )
            }
            finished.signal()
        }

        XCTAssertEqual(
            filled.wait(timeout: .now() + 30), .success,
            "the fill phase never ended: a command to a peer that stopped draining did not return within"
                + " \(ProbeSocketServer.commandWriteTimeoutSeconds)s — the write budget is not enforced on this"
                + " socket, which is exactly what A-06 promises"
        )
        // One blocked write lasts the whole `commandWriteTimeoutSeconds` budget,
        // so a short margin is enough to land the measurements inside it — and the
        // margin cannot make the case vacuous, because `stall.blockedSeconds` below
        // is the proof that a write really did wait.
        Thread.sleep(forTimeInterval: 0.2)
        let commandAt = Date()
        XCTAssertTrue(
            fixture.inbox.sendCommand("op_end", to: 9102),
            "a healthy peer must still receive its command while another peer is stalling"
        )
        let healthyWriteSeconds = Date().timeIntervalSince(commandAt)

        let acceptAt = Date()
        XCTAssertNotNil(
            fixture.connectAndHello(pid: 9103),
            "a new app must still get admitted while one peer stalls"
        )
        let acceptSeconds = Date().timeIntervalSince(acceptAt)
        measured.signal() // release the hold loop

        guard finished.wait(timeout: .now() + 30) == .success else {
            XCTFail(
                "the stalled write never returned, although the release was asked for: one command to one"
                    + " non-draining peer costs more than its \(ProbeSocketServer.commandWriteTimeoutSeconds)s"
                    + " budget, so the send gate — and the close waiting on it — can be held indefinitely"
            )
            return
        }
        // Only now may the writer's numbers be read: the semaphore is what orders
        // them against its writes.
        let stall = fixture.stall
        if !stall.backPressureSeen {
            let granted = grantedBuffer.map { "\($0)" } ?? "nothing (setsockopt refused)"
            throw XCTSkip(
                "back-pressure cannot be induced on this machine: \(stall.sends) commands of"
                    + " \(chunkBytes) bytes (\(stall.bytesPushed) bytes in total) went to a peer that never"
                    + " read a single byte without one write blocking. The client asked for a"
                    + " \(chunkBytes)-byte receive buffer and got \(granted); compare"
                    + " `sysctl kern.ipc.maxsockbuf` with the"
                    + " \(P6SocketFaceFixture.stallPushLimit)-command budget this test is willing to spend"
            )
        }
        XCTAssertFalse(
            stall.delivered,
            "a write that cannot complete must be reported as undelivered, never counted as sent"
        )
        let budget = Double(ProbeSocketServer.commandWriteTimeoutSeconds)
        XCTAssertGreaterThanOrEqual(
            stall.blockedSeconds, budget * 0.5,
            "the failed write has to have *blocked* for this to mean anything: the longest send gave up after"
                + " \(stall.blockedSeconds)s of a \(budget)s budget — an instant `false` means the connection was"
                + " gone or unrouted (A-17's case), which is not a stalled peer"
        )
        XCTAssertLessThanOrEqual(
            stall.blockedSeconds, budget + 3.0,
            "A-06: one stalled peer must cost its own write budget, not the kernel's unbounded send timeout"
        )
        XCTAssertLessThan(
            healthyWriteSeconds, 1.0,
            "A-06 regression: another app's command waited \(healthyWriteSeconds)s behind one stalled peer"
        )
        XCTAssertLessThan(
            acceptSeconds, 1.0,
            "A-06 regression: the accept loop waited \(acceptSeconds)s behind one stalled peer"
        )
        XCTAssertEqual(
            fixture.inbox.statusJSON().count, 3,
            "no probe was evicted to make room, and none was lost to the stall"
        )
    }

    /// A-11: `maxConcurrentClients` bounds *clients*. Counting the listening
    /// descriptor inside the owned set made the real cap one smaller than the
    /// number the refusal message reported.
    func testClientCapCountsClientsNotTheListener() throws {
        let fixture = try P6SocketFaceFixture.open(requireVerifiedPeer: false)
        defer { fixture.teardown() }
        var served: [Int32] = []
        for index in 1...Int32(ProbeSocketServer.maxConcurrentClients) {
            let pid = 9200 + index
            XCTAssertNotNil(
                fixture.connectAndHello(pid: pid),
                "client \(index) of \(ProbeSocketServer.maxConcurrentClients) must be admitted (A-11 off-by-one)"
            )
            served.append(pid)
        }
        XCTAssertEqual(fixture.inbox.statusJSON().count, served.count)

        // One over the cap: refused without a reader thread, and without
        // evicting an established probe (R5-06).
        let refused = try XCTUnwrap(fixture.rawConnect(), "connecting one past the cap must still be possible")
        fixture.sendHello(pid: 9999, to: refused)
        XCTAssertTrue(
            fixture.closedByDaemon(refused, within: 3),
            "the over-cap connection must be closed unread by the daemon (A-11: the cap counts clients, so this one is the 9th)"
        )
        XCTAssertNil(fixture.inbox.connection(for: 9999), "a refused connection registers nothing")
        XCTAssertEqual(
            fixture.inbox.statusJSON().count, served.count,
            "refusal must not destroy a live probe's act window"
        )
    }

    /// A-17 must survive the lock split: once the daemon's reader thread has
    /// closed a descriptor, a command to that pid is reported as *not
    /// delivered*, never written into a descriptor that may already have been
    /// recycled to somebody else.
    func testCommandAfterTheConnectionClosedIsRefusedNotSentToAFD() throws {
        let fixture = try P6SocketFaceFixture.open(requireVerifiedPeer: false)
        defer { fixture.teardown() }
        let client = try XCTUnwrap(fixture.connectAndHello(pid: 9301))
        fixture.disconnectClient(client)
        XCTAssertTrue(
            fixture.wait(9301, timeout: 3, forRegistration: false),
            "the reader thread must unregister the pid it dropped"
        )
        XCTAssertFalse(
            fixture.inbox.sendCommand("op_begin", to: 9301),
            "no route means no delivery, and the caller must be told so"
        )
        XCTAssertTrue(fixture.inbox.lastDeliveryError?.contains("not delivered") ?? false,
                      "\(fixture.inbox.lastDeliveryError ?? "nil")")
        // And the daemon itself stays usable: a fresh connection for the same pid
        // registers normally after the old descriptor was reaped once.
        XCTAssertNotNil(fixture.connectAndHello(pid: 9301), "the descriptor was closed exactly once (R2-04)")
    }
}

// MARK: - Socket-face fixture

/// A real `ProbeSocketServer` on a temp-dir socket with real client sockets, so
/// the lock layering and the connection cap are measured instead of asserted
/// about. `requireVerifiedPeer: false` is the documented opt-out seam, and these
/// tests are why it exists as a parameter rather than a silent fallback: every
/// connection from one process carries the same `LOCAL_PEERPID`, so distinct
/// pids cannot be peer-authenticated from inside the test binary. Paths come
/// from `TestSandbox`, which proves isolation at runtime.
private final class P6SocketFaceFixture {
    let server: ProbeSocketServer
    let inbox: ProbeInbox
    let path: String
    /// What the stalled-writer thread observed. Written only on that queue and
    /// read after its `finished` semaphore fires, which is the ordering point.
    struct Stall {
        /// Whether the last send went out. `true` is also the initial value, so a
        /// writer that never ran fails the test instead of passing it.
        var delivered = true
        /// Set by the first send that could not be written at all: without it the
        /// test cannot tell "back-pressure" from "the socket was huge".
        var backPressureSeen = false
        var sends = 0
        var bytesPushed = 0
        /// The longest *failed* send. A write a peer stopped draining costs its
        /// whole `commandWriteTimeoutSeconds` budget, so this is the measurement
        /// that says the SendGate path ran rather than being skipped past.
        var blockedSeconds = 0.0
    }
    var stall = Stall()
    /// Ceiling over both phases: `stallPushLimit` x 64 KiB commands, far above the
    /// `kern.ipc.maxsockbuf` any macOS host ships with, so a machine that reaches
    /// it cannot be made to block and says so instead of passing.
    static let stallPushLimit = 1024

    func recordSend(delivered: Bool, bytes: Int, seconds: TimeInterval) {
        stall.delivered = delivered
        stall.sends += 1
        stall.bytesPushed += bytes
        if !delivered {
            stall.backPressureSeen = true
            stall.blockedSeconds = max(stall.blockedSeconds, seconds)
        }
    }

    /// Ask for a small receive buffer on a client socket and report the size the
    /// kernel actually granted (nil when the request itself failed). For AF_UNIX
    /// stream sockets the space a writer has *is* the peer's receive buffer, so
    /// this is the only knob that makes "the peer stopped draining" reachable
    /// without building a payload as large as the platform default.
    func shrinkReceiveBuffer(_ fd: Int32, to bytes: Int) -> Int? {
        var request = Int32(bytes)
        guard setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &request, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            return nil
        }
        var granted = Int32(0)
        var length = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(fd, SOL_SOCKET, SO_RCVBUF, &granted, &length) == 0 else { return nil }
        return Int(granted)
    }

    private let directory: String
    private var clients: [Int32] = []

    static func open(requireVerifiedPeer: Bool) throws -> P6SocketFaceFixture {
        let directory = TestSandbox.directory("sock")
        let path = directory + "/s"
        let inbox = ProbeInbox(now: { Date() })
        let server = ProbeSocketServer(
            socketPath: path, inbox: inbox,
            log: EngineLog(quiet: true), requireVerifiedPeer: requireVerifiedPeer
        )
        try server.start()
        return P6SocketFaceFixture(server: server, inbox: inbox, path: path, directory: directory)
    }

    private init(server: ProbeSocketServer, inbox: ProbeInbox, path: String, directory: String) {
        self.server = server
        self.inbox = inbox
        self.path = path
        self.directory = directory
    }

    func teardown() {
        server.stop()
        for fd in clients { close(fd) }
        clients.removeAll()
        try? FileManager.default.removeItem(atPath: directory)
    }

    /// A client socket connected to the listener, without saying hello.
    func rawConnect() -> Int32? {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let copied = path.withCString { source in
            withUnsafeMutableBytes(of: &address.sun_path) { destination in
                guard let base = destination.baseAddress else { return false }
                _ = strncpy(base.assumingMemoryBound(to: CChar.self), source, destination.count)
                return true
            }
        }
        guard copied else { return nil }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                Darwin.connect(fd, rebound, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { close(fd); return nil }
        clients.append(fd)
        return fd
    }

    /// One hello line, in the §2.2 shape `ProbeWire.decode` reads.
    func sendHello(pid: Int32, to fd: Int32) {
        let line = "{\"t\":\"hello\",\"pid\":\(pid),\"appName\":\"Example\","
            + "\"probeVersion\":\"gp-probe/0.1.0\",\"capabilities\":[\"z1\"]}\n"
        line.withCString { pointer in
            _ = Darwin.write(fd, pointer, strlen(pointer))
        }
    }

    /// Connect, hello, and wait until the daemon's inbox really has the pid —
    /// nil when the peer never got admitted, so a refusal is a fact and not a
    /// hang.
    func connectAndHello(pid: Int32) -> Int32? {
        guard let fd = rawConnect() else { return nil }
        sendHello(pid: pid, to: fd)
        return wait(pid, timeout: 3, forRegistration: true) ? fd : nil
    }

    /// Hang up the way a dying app does, so the daemon's reader thread runs its
    /// own close path.
    func disconnectClient(_ fd: Int32) {
        clients.removeAll { $0 == fd }
        shutdown(fd, SHUT_RDWR)
        close(fd)
    }

    /// True when the daemon ended the connection (EOF or a hard read error)
    /// within `timeout`. `SO_RCVTIMEO` bounds each read so a daemon that *keeps*
    /// the connection — the failure this probes for — costs a timeout instead of
    /// hanging the run, and an expired deadline (`EAGAIN`) is deliberately not
    /// read as a close.
    func closedByDaemon(_ fd: Int32, within timeout: TimeInterval) -> Bool {
        var deadlineInterval = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(
            fd, SOL_SOCKET, SO_RCVTIMEO, &deadlineInterval, socklen_t(MemoryLayout<timeval>.size)
        )
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            var byte: UInt8 = 0
            let got = Darwin.read(fd, &byte, 1)
            if got == 0 { return true }
            if got < 0, errno != EAGAIN, errno != EWOULDBLOCK, errno != EINTR { return true }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return false
    }

    /// Polls until the pid's registration is (or is no longer) there.
    func wait(_ pid: Int32, timeout: TimeInterval, forRegistration: Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (inbox.connection(for: pid) != nil) == forRegistration { return true }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return (inbox.connection(for: pid) != nil) == forRegistration
    }
}

// MARK: - EngineCore integration

final class P6EngineCoreProbeTests: XCTestCase {

    private func makeCore(time: P6TimeBox, inbox: ProbeInbox?) -> EngineCore {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(120)
        return EngineCore(
            channel: channel,
            clock: { time.now },
            settle: {},
            probeInbox: inbox
        )
    }

    func testStateOnlyProbeEventsAlsoGrantStrong() throws {
        // Z1b real-world path: binding writes produce no handler events, yet
        // an in-window state change is operation-attributable evidence (§2.3).
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z2"]))
        let core = makeCore(time: time, inbox: inbox)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        inbox.ingest(pid: 4242, frame: .state(key: "settings.unit", before: "db", after: "percent", source: "z2-mirror", ts: 0))
        let result = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let pack = try core.lastEvidence(operationId: result["operationId"] as? String)
        XCTAssertEqual(pack.attribution.level, .strong)
        XCTAssertEqual(pack.signals.handlerProbe?.hitCount, 0)
        XCTAssertEqual(pack.signals.stateDiff?.changed, true)
    }

    func testActWithProbeYieldsStrongAttributionAndRealSignals() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2"]))
        let core = makeCore(time: time, inbox: inbox)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 12, ts: 0, durationNs: nil))
        inbox.ingest(pid: 4242, frame: .state(key: "counter", before: "0", after: "1", source: "z2-mirror", ts: 0))
        let result = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let pack = try core.lastEvidence(operationId: result["operationId"] as? String)
        XCTAssertEqual(pack.attribution.level, .strong, "in-window probe hit upgrades soft → strong (§2.3)")
        XCTAssertFalse(pack.attribution.contaminated)
        let handlerProbe = try XCTUnwrap(pack.signals.handlerProbe)
        XCTAssertGreaterThanOrEqual(handlerProbe.hitCount, 1)
        let stateDiff = try XCTUnwrap(pack.signals.stateDiff)
        XCTAssertTrue(stateDiff.changed)
        XCTAssertEqual(stateDiff.entries.first?.after, "1")
    }

    func testActWithoutProbeKeepsNullSignalsAndSoftAttribution() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        // Registered to a *different* pid: the attached app has no probe.
        inbox.register(ProbeHello(pid: 7, bundleId: nil, appName: "Other", probeVersion: "gp-probe/0.1.0", capabilities: ["z1", "z2"]))
        let core = makeCore(time: time, inbox: inbox)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let pack = try core.lastEvidence(operationId: result["operationId"] as? String)
        XCTAssertEqual(pack.attribution.level, .soft)
        XCTAssertNil(pack.signals.handlerProbe)
        XCTAssertNil(pack.signals.stateDiff)
    }

    func testDiagnoseRefreshesLateCountIntoT8() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2"]))
        let core = makeCore(time: time, inbox: inbox)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let operationId = try XCTUnwrap(result["operationId"] as? String)
        // Async continuation lands after the window closed.
        time.now = time.now.addingTimeInterval(0.5)
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 88, ts: 0, durationNs: nil))
        let diagnosis = try core.diagnose(operationId: operationId)
        XCTAssertEqual(diagnosis["class"] as? String, "T8")
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.signals.handlerProbe?.lateCount, 1, "the refreshed late count must persist into evidence")
    }

    func testSnapshotCarriesRealCheckpointAndRollbackFullExecutes() throws {
        let time = P6TimeBox()
        let domains = ["counter": ["value": "3"]]
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2", "checkpoint"]))
        scriptedProbeReplies(inbox: inbox, domains: domains)
        let core = makeCore(time: time, inbox: inbox)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let snapshot = try core.snapshot(maxDepth: 4)
        let snapshotId = try XCTUnwrap(snapshot["snapshotId"] as? String)

        let restore = try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")
        XCTAssertEqual(restore["rollbackExecuted"] as? Bool, true)
        XCTAssertEqual(restore["executionSurface"] as? String, "gp-probe")
        XCTAssertEqual(restore["consistent"] as? Bool, true)
        let expectedDigest = ProbeWire.sha256Hex(ProbeWire.checkpointCanonical(domains))
        XCTAssertEqual(restore["postStateDigest"] as? String, expectedDigest)
        XCTAssertEqual((restore["domains"] as? [String]) ?? [], ["counter"])
    }

    func testRollbackSurfacesInconsistentWhenPostDigestDiverges() throws {
        let time = P6TimeBox()
        let domains = ["counter": ["value": "3"]]
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2", "checkpoint"]))
        let tamperedPost = ProbeWire.sha256Hex(ProbeWire.checkpointCanonical(["counter": ["value": "9"]]))
        scriptedProbeReplies(inbox: inbox, domains: domains, restoreDigest: tamperedPost)
        let core = makeCore(time: time, inbox: inbox)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let snapshot = try core.snapshot(maxDepth: 4)
        let snapshotId = try XCTUnwrap(snapshot["snapshotId"] as? String)
        let restore = try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")
        XCTAssertEqual(restore["rollbackExecuted"] as? Bool, true)
        XCTAssertEqual(restore["consistent"] as? Bool, false, "digest divergence must surface as inconsistent, not be hidden")
    }

    func testSnapshotWithoutCheckpointCapabilityStaysPlanLess() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1"]))
        inbox.sender = { _, _ in false } // no socket layer behind it: nothing is delivered
        let core = makeCore(time: time, inbox: inbox)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let snapshot = try core.snapshot(maxDepth: 4)
        let snapshotId = try XCTUnwrap(snapshot["snapshotId"] as? String)
        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")) { error in
            let gpError = error as? GPError
            XCTAssertEqual(gpError?.code, .restoreUnsupported)
            XCTAssertTrue(gpError?.message.contains("probe") ?? false)
        }
    }

    func testProbeUnavailableRemedyIsAgentActionable() {
        let remedy = GPError.remedy(for: .probeUnavailable)
        XCTAssertTrue(remedy.contains("GlassPaneProbe"))
        XCTAssertTrue(remedy.contains("INCONCLUSIVE"))
    }
}

// MARK: - Classifier probe branches (§3.2)

final class P6ClassifierProbeTests: XCTestCase {

    private func pack(
        axChanged: Bool,
        pixelRatio: Double,
        handlerProbe: HandlerProbeSignal?,
        stateDiff: StateDiffSignal?,
        assertionPassed: Bool? = nil
    ) -> EvidencePack {
        let base = TestTrees.standard
        let after = axChanged ? TestTrees.buttonRetitled : TestTrees.standard
        var signals = Signals(
            act: ActSignal(selector: Selector(role: "AXButton", title: "Submit"), action: .press, actConfirmed: true),
            axEvent: AxEventSignal(
                treeDigestBefore: base.digest, treeDigestAfter: after.digest,
                nodeCount: after.nodeCount, axChanged: axChanged, latencyMs: 20
            ),
            pixelDiff: PixelDiffSignal(changedPixelRatio: pixelRatio, bounds: nil, windowId: 12),
            responsiveness: ResponsivenessSignal(responsive: true, pingMs: 3),
            crash: CrashSignal(processAliveBefore: true, processAliveAfter: true)
        )
        signals.handlerProbe = handlerProbe
        signals.stateDiff = stateDiff
        return EvidencePack(
            operationId: "op_" + String(repeating: "A", count: 26),
            createdAt: "2026-09-19T00:00:00.000Z",
            attribution: Attribution(level: .strong, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: signals,
            assertion: assertionPassed.map { passed in
                Assertion(
                    selector: Selector(role: "AXStaticText", title: "Hello"),
                    property: .value, expected: .string("x"), actual: .string("y"), passed: passed
                )
            }
        )
    }

    private func probe(hitCount: Int = 0, lateCount: Int = 0) -> HandlerProbeSignal {
        HandlerProbeSignal(
            probeVersion: "gp-probe/0.1.0", hitCount: hitCount,
            handlers: hitCount > 0 ? [HandlerRef(file: "View.swift", line: 12)] : [],
            lateCount: lateCount
        )
    }

    private func diff(changed: Bool) -> StateDiffSignal {
        StateDiffSignal(
            source: .z2Mirror, changed: changed,
            entries: changed ? [StateEntry(key: "counter", before: "0", after: "1")] : []
        )
    }

    func testT4HandlerRanStateAndUIQuiet() {
        let (diagnosisClass, report) = Classifier.classify(
            pack(axChanged: false, pixelRatio: 0, handlerProbe: probe(hitCount: 3), stateDiff: diff(changed: false))
        )
        XCTAssertEqual(diagnosisClass, .t4)
        XCTAssertTrue(report.anomaly.contains("logic bug"))
        XCTAssertTrue(report.next.contains("View.swift:12"))
    }

    func testT5StateChangedButUIQuiet() {
        let (diagnosisClass, report) = Classifier.classify(
            pack(axChanged: false, pixelRatio: 0, handlerProbe: probe(hitCount: 2), stateDiff: diff(changed: true))
        )
        XCTAssertEqual(diagnosisClass, .t5)
        XCTAssertTrue(report.anomaly.contains("dependency loss"))
    }

    func testT7UIChangedStateQuiet() {
        let (diagnosisClass, report) = Classifier.classify(
            pack(axChanged: true, pixelRatio: 0.2, handlerProbe: probe(hitCount: 1), stateDiff: diff(changed: false))
        )
        XCTAssertEqual(diagnosisClass, .t7)
        XCTAssertTrue(report.anomaly.contains("view-model decoupling"))
    }

    func testT8WindowSilentThenLateArrivals() {
        let (diagnosisClass, report) = Classifier.classify(
            pack(axChanged: false, pixelRatio: 0, handlerProbe: probe(lateCount: 2), stateDiff: diff(changed: false))
        )
        XCTAssertEqual(diagnosisClass, .t8)
        XCTAssertTrue(report.anomaly.contains("late handler"))
    }

    func testStateIncapableProbeHitDoesNotGuess() {
        // Handler ran (hit>0) but no state channel: T4/T5/T7 undecidable and
        // the black-box T3 ("dead click") would be a lie → INCONCLUSIVE.
        let (diagnosisClass, report) = Classifier.classify(
            pack(axChanged: false, pixelRatio: 0, handlerProbe: probe(hitCount: 1), stateDiff: nil)
        )
        XCTAssertEqual(diagnosisClass, .inconclusive)
        XCTAssertTrue(report.anomaly.contains("state"))
    }

    func testNoProbePackClassificationIsByteIdentical() {
        // T3 regression: no handlerProbe → unchanged black-box verdict.
        let (deadClick, _) = Classifier.classify(
            pack(axChanged: false, pixelRatio: 0, handlerProbe: nil, stateDiff: nil)
        )
        XCTAssertEqual(deadClick, .t3)
        // NO_ANOMALY regression: tree+pixels changed, assertion passed.
        let (clean, _) = Classifier.classify(
            pack(axChanged: true, pixelRatio: 0.3, handlerProbe: nil, stateDiff: nil, assertionPassed: true)
        )
        XCTAssertEqual(clean, .noAnomaly)
    }
}

// MARK: - Dispatcher surface

final class P6DispatcherProbeTests: XCTestCase {

    private func perform(_ core: EngineCore, _ frame: String) throws -> [String: Any] {
        let dispatcher = Dispatcher(core: core)
        let data = dispatcher.handle(.frame(Data(frame.utf8)))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testProbeStatusReportsConnectionsAndAttachment() throws {
        let time = P6TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(p6Hello(capabilities: ["z1", "z2", "checkpoint"]))
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, clock: { time.now }, settle: {}, probeInbox: inbox)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let response = try perform(core, #"{"id":7,"method":"probe_status"}"#)
        let result = try XCTUnwrap(response["result"] as? [String: Any])
        XCTAssertEqual(result["attachedHasProbe"] as? Bool, true)
        let probes = try XCTUnwrap(result["probes"] as? [[String: Any]])
        XCTAssertEqual(probes.first?["pid"] as? Int, 4242)
        XCTAssertEqual(probes.first?["probeVersion"] as? String, "gp-probe/0.1.0")
        // §5.3(3) fields must reach the method surface, not just the inbox.
        XCTAssertNotNil(probes.first?["connectedAt"] as? String)
        XCTAssertEqual(probes.first?["connected"] as? Bool, true)
    }

    func testProbeStatusWithoutInboxIsHonestEmpty() throws {
        let core = EngineCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard))
        let response = try perform(core, #"{"id":8,"method":"probe_status"}"#)
        let result = try XCTUnwrap(response["result"] as? [String: Any])
        XCTAssertEqual((result["probes"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(result["attachedHasProbe"] as? Bool, false)
    }
}
