import XCTest
@testable import GlassPaneEngine

// P6 spec v6.0 batch tests: probe wire codec, inbox windowing, EngineCore
// act/diagnose/snapshot/restore integration, classifier T4/T5/T7/T8, and the
// probe_status method surface.

private let p6ClockStart = Date(timeIntervalSince1970: 1_758_200_000)

/// Shared mutable clock for inbox + core in one test.
private final class P6TimeBox {
    var now = p6ClockStart
}

/// Scripted probe reply: parses the daemon command line and answers through
/// `ingest`, mirroring what a live GlassPaneProbe does over the socket.
private func scriptedProbeReplies(
    inbox: ProbeInbox,
    domains: [String: [String: String]],
    digest: String? = nil,
    restoreDigest: String? = nil
) {
    inbox.sender = { pid, data in
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard let type = object?["t"] as? String else { return }
        switch type {
        case "checkpoint_export":
            let ref = object?["ref"] as? String ?? ""
            let reported = digest ?? ProbeWire.sha256Hex(ProbeWire.checkpointCanonical(domains))
            inbox.ingest(pid: pid, frame: .checkpoint(ref: ref, domains: domains, digest: reported, error: nil))
        case "checkpoint_restore":
            let post = restoreDigest ?? digest ?? ProbeWire.sha256Hex(ProbeWire.checkpointCanonical(domains))
            inbox.ingest(pid: pid, frame: .result(ok: true, postStateDigest: post, error: nil))
        default:
            break // op_begin / op_end / hello_ack need no reply in tests
        }
    }
}

private func p6Hello(capabilities: [String]) -> ProbeHello {
    ProbeHello(
        pid: 4242, bundleId: "com.example.app", appName: "Example",
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

    func testStatusJSONAndDisconnect() throws {
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
        XCTAssertNotNil(inbox.connection(for: 4242))
        inbox.disconnect(pid: 4242)
        XCTAssertNil(inbox.connection(for: 4242))
        XCTAssertTrue(inbox.statusJSON().isEmpty)
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
        inbox.sender = { _, _ in } // would answer nothing even if consulted
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
    }

    func testProbeStatusWithoutInboxIsHonestEmpty() throws {
        let core = EngineCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard))
        let response = try perform(core, #"{"id":8,"method":"probe_status"}"#)
        let result = try XCTUnwrap(response["result"] as? [String: Any])
        XCTAssertEqual((result["probes"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(result["attachedHasProbe"] as? Bool, false)
    }
}
