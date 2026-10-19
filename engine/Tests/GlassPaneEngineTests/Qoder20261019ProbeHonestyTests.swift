import XCTest
@testable import GlassPaneEngine

/// 2026-10-19 review lane, probe side.
///
/// Every case here is the same shape: a channel that stopped being measured is
/// reported as if it had reported a value. The fixtures are shaped from the real
/// wire frames and real inbox windows (`EngineP6ProbeTests`, `ProbeCounterTests`),
/// because an invented frame proves nothing about a decoder.
final class Qoder20261019ProbeHonestyTests: XCTestCase {

    private static let clockStart = Date(timeIntervalSince1970: 1_758_200_000)

    /// The label `EngineCore.lateArrivalsUnmeasuredLabel` carries. Spelled as a
    /// literal on purpose: it is a string a reader of the archive matches on, so
    /// this case has to break when the producer renames it, and it has to compile
    /// against the pre-fix code to go red rather than fail to build.
    private static let unmeasuredLabel = "late-arrivals-unmeasured"

    private final class TimeBox {
        var now = Qoder20261019ProbeHonestyTests.clockStart
    }

    private func hello(pid: Int32 = 4242, capabilities: [String] = ["z1", "z2"]) -> ProbeHello {
        ProbeHello(
            pid: pid, bundleId: "com.example.app", appName: "Example",
            probeVersion: "gp-probe/0.1.0", capabilities: capabilities
        )
    }

    // MARK: - defect 1: a probe that vanished mid-act

    /// `disconnect(pid:)` takes the pid's event ring with it (`events.removeValue`)
    /// and leaves the open window record untouched, while `endWindow` reads
    /// `events[pid] ?? []`. A probe that dropped mid-act therefore closed as
    /// `hitCount: 0, handlers: []` — a measurement of a channel that no longer
    /// existed — and `Classifier` took its zero-hit branches. The file's own
    /// honest-absence shape for "no window served this act" is `(nil, nil)`
    /// (§3.1 presence rule, and `Classifier.evidenceLine` already says
    /// "handlerProbe=absent … not a zero hit count").
    func testMidActDisconnectClosesTheWindowAsAbsentRatherThanAsZeroHits() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello())
        inbox.beginWindow(pid: 4242, opId: "op_vanished")
        inbox.ingest(
            pid: 4242,
            frame: .handler(file: "View.swift", line: 12, ts: 0, durationNs: nil)
        )
        inbox.disconnect(pid: 4242, reason: "read failed: errno 54 (Connection reset by peer)")
        time.now = time.now.addingTimeInterval(0.2)

        let signals = try XCTUnwrap(
            inbox.endWindow(pid: 4242, opId: "op_vanished"),
            "the window record still exists, so the close itself must be answerable"
        )
        XCTAssertNil(
            signals.handlerProbe,
            "revert: the gone ring folded into `hitCount: 0` — an unmeasured channel reported as a measured zero"
        )
        XCTAssertNil(signals.stateDiff, "the same refusal covers the state channel")

        // The classifier is the consumer this distinction exists for.
        let pack = EvidencePack(
            operationId: "op_" + String(repeating: "A", count: 26),
            createdAt: "2026-09-18T12:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(selector: Selector(role: "AXButton", title: "Submit"), action: .press, actConfirmed: true),
                axEvent: AxEventSignal(
                    treeDigestBefore: String(repeating: "1", count: 32),
                    treeDigestAfter: String(repeating: "1", count: 32),
                    nodeCount: 4, axChanged: false, latencyMs: 3
                ),
                handlerProbe: signals.handlerProbe,
                stateDiff: signals.stateDiff
            )
        )
        let (_, report) = Classifier.classify(pack)
        XCTAssertTrue(
            report.evidence.contains("handlerProbe=absent"),
            "the archived evidence line must say the channel was absent, not that it hit zero times: \(report.evidence)"
        )
    }

    /// The other half: a probe that stays connected keeps producing a real
    /// `hitCount: 0`, and a zero measured is a measurement.
    func testConnectedProbeWithNoEventsStillReportsAMeasuredZero() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_alive")
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_alive"))
        XCTAssertEqual(signals.handlerProbe?.hitCount, 0, "a live probe that saw nothing is a measured zero")
        XCTAssertNotNil(signals.handlerProbe)
    }

    /// A drop that happens *after* the window closed must not retroactively
    /// invalidate the signal the close already measured.
    func testDisconnectAfterTheWindowClosedKeepsTheMeasuredSignal() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello())
        inbox.beginWindow(pid: 4242, opId: "op_closed_first")
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 9, ts: 0, durationNs: nil))
        let before = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_closed_first"))
        inbox.disconnect(pid: 4242, reason: "peer closed the connection (EOF)")
        XCTAssertEqual(before.handlerProbe?.hitCount, 1)
        XCTAssertEqual(before.handlerProbe?.handlers, [HandlerRef(file: "View.swift", line: 9)])
    }

    // MARK: - defect 2: counters outside Int32

    /// `counter` reads `number.intValue` and vetoes only `< 0`, so a value past
    /// Int32 is silently coerced — `gp_probe_status` then prints a count the probe
    /// never claimed. `boundedInt32` ~20 lines below documents exactly this trap
    /// (a frame carrying 4294967297 came back as pid 1).
    func testCountersBeyondInt32AreUnreportedRatherThanCoerced() throws {
        // The battery ProbeCounterTests already pins, plus the out-of-range cases.
        for (field, value) in [
            ("droppedEvents", "-4"),
            ("droppedWrites", "\"many\""),
            ("rejectedKeys", "null"),
            ("droppedInboundFrames", "4294967296"),   // 2^32
            ("droppedInboundLines", "2147483648"),    // Int32.max + 1
            ("droppedEvents", "-2147483649"),         // below Int32.min
            ("droppedWrites", "9007199254740993"),    // past exact-integer range
        ] {
            let json = """
            {"t":"hello","pid":1,"appName":"A","probeVersion":"v","capabilities":[],\
            "\(field)":\(value)}
            """
            guard case let .hello(decoded) = ProbeWire.decode(Data(json.utf8)) else {
                return XCTFail("\(field): the frame must still decode as a hello")
            }
            switch field {
            case "droppedEvents": XCTAssertNil(decoded.droppedEvents, "\(field): \(value) must not become a reported count")
            case "droppedWrites": XCTAssertNil(decoded.droppedWrites, "\(field): \(value) must not become a reported count")
            case "rejectedKeys": XCTAssertNil(decoded.rejectedKeys, "\(field): \(value) must not become a reported count")
            case "droppedInboundFrames": XCTAssertNil(decoded.droppedInboundFrames, "\(field): \(value) must not become a reported count")
            default: XCTAssertNil(decoded.droppedInboundLines, "\(field): \(value) must not become a reported count")
            }
        }
    }

    /// The boundary that is still a measurement: Int32's own max, and 0.
    func testCountersInsideInt32KeepBeingMeasurements() throws {
        let json = """
        {"t":"hello","pid":1,"appName":"A","probeVersion":"v","capabilities":[],\
        "droppedWrites":2147483647,"droppedEvents":0,"rejectedKeys":2147483647}
        """
        guard case let .hello(decoded) = ProbeWire.decode(Data(json.utf8)) else {
            return XCTFail("expected a hello frame")
        }
        XCTAssertEqual(decoded.droppedWrites, 2_147_483_647, "Int32.max is inside the wire contract")
        XCTAssertEqual(decoded.droppedEvents, 0)
        XCTAssertEqual(decoded.rejectedKeys, 2_147_483_647)
    }

    // MARK: - defect 3: a late count nobody can measure

    /// `HandlerProbeSignal(lateCount: 0)` is hard-written at act time; the only
    /// writer of a real value (`refreshedHandlerProbe`) needs the window still in
    /// the 16-entry ring, and `guard ... let late = lateCount(...), late !=
    /// stored.lateCount else { return nil }` folds "cannot refresh" into "keep the
    /// 0". EngineCore then substitutes only on non-nil, so an archived pack keeps
    /// asserting "no late arrivals" for a fact nobody measured, and T8 can never
    /// go red for it.
    func testDiagnoseOfAnEvictedWindowStatesTheLateCountWasNeverMeasured() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.sender = { _, _ in true }
        inbox.register(hello())
        let directory = TestSandbox.directory("late-unmeasured")
        let store = TestSandbox.evidenceStore(at: directory)
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        let core = EngineCore(channel: channel, settle: {}, evidenceStore: store, probeInbox: inbox)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let actResult = try core.act(
            selector: Selector(role: "AXButton", title: "Submit"), action: .press
        )
        let operationId = try XCTUnwrap(actResult["operationId"] as? String)

        // A real late arrival inside the grace window … then 16 further windows,
        // which is exactly `ProbeInbox.windowHistoryLimit`: the first op's record
        // is gone, so nothing can ever read that late arrival again.
        time.now = time.now.addingTimeInterval(0.1)
        inbox.ingest(pid: 4242, frame: .handler(file: "Async.swift", line: 3, ts: 0, durationNs: nil))
        for index in 0..<ProbeInbox.windowHistoryLimit {
            let filler = "op_filler\(index)"
            inbox.beginWindow(pid: 4242, opId: filler)
            XCTAssertNotNil(inbox.endWindow(pid: 4242, opId: filler))
        }
        XCTAssertNil(inbox.lateCount(opId: operationId), "the premise: this late count is unmeasurable now")

        _ = try core.diagnose(operationId: operationId)
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.signals.handlerProbe?.lateCount, 0)
        XCTAssertNotNil(
            pack.circuitBreaker.reason,
            "revert: the pack asserts `lateCount: 0` with nothing behind it — a fabricated zero needs a stated reason, not silence"
        )
        XCTAssertTrue(
            pack.circuitBreaker.reason?.contains(Self.unmeasuredLabel) == true,
            "the reason must name the unmeasured late count: \(pack.circuitBreaker.reason ?? "nil")"
        )
        // And the archived bytes carry it, not just the in-memory copy.
        let archived = try XCTUnwrap(store.read(operationId: operationId))
        XCTAssertTrue(
            archived.circuitBreaker.reason?.contains(Self.unmeasuredLabel) == true,
            "the pack on disk is what the panel and gp_export_evidence read: \(archived.circuitBreaker.reason ?? "nil")"
        )

        // `diagnose` is callable more than once on one pack; the statement may not
        // stack into a sentence that reads like a defect in the writer.
        _ = try core.diagnose(operationId: operationId)
        _ = try core.diagnose(operationId: operationId)
        let twice = try XCTUnwrap(store.read(operationId: operationId))
        XCTAssertEqual(
            twice.circuitBreaker.reason?.components(separatedBy: Self.unmeasuredLabel).count, 2,
            "one stated reason, however many times the pack was diagnosed: \(twice.circuitBreaker.reason ?? "nil")"
        )
    }

    /// The contrast that keeps the fix honest: while the window is still in the
    /// ring, the late count IS measurable, gets refreshed, and no
    /// "unmeasured" sentence is written anywhere.
    func testRefreshableLateCountIsStillARealMeasurement() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.sender = { _, _ in true }
        inbox.register(hello())
        let store = TestSandbox.evidenceStore(at: TestSandbox.directory("late-refreshable"))
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        let core = EngineCore(channel: channel, settle: {}, evidenceStore: store, probeInbox: inbox)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let actResult = try core.act(
            selector: Selector(role: "AXButton", title: "Submit"), action: .press
        )
        let operationId = try XCTUnwrap(actResult["operationId"] as? String)
        time.now = time.now.addingTimeInterval(0.1)
        inbox.ingest(pid: 4242, frame: .handler(file: "Async.swift", line: 4, ts: 0, durationNs: nil))

        _ = try core.diagnose(operationId: operationId)
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.signals.handlerProbe?.lateCount, 1, "a late arrival that can be read must be counted")
        XCTAssertNil(
            pack.circuitBreaker.reason,
            "and nothing may be labelled unmeasured when it was measured: \(pack.circuitBreaker.reason ?? "")"
        )
    }
}
