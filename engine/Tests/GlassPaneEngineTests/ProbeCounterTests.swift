import XCTest
@testable import GlassPaneEngine

/// X-3, closed: three probe-side counters used to have no reader at all — the
/// SDK reported them, the daemon's decoder dropped them at the wire boundary, and
/// nothing surfaced them, so "0 handler hits" and "the probe lost 400 frames" were
/// the same observable. The rule this file pins is the one that makes that
/// difference survive: **`nil` is unreported, `0` is a measurement**, and a row
/// never upgrades the first into the second.
final class ProbeCounterTests: XCTestCase {

    private func hello(
        pid: Int32 = 4242,
        capabilities: [String] = ["z1"],
        droppedEvents: Int? = nil,
        droppedWrites: Int? = nil,
        rejectedKeys: Int? = nil
    ) -> ProbeHello {
        ProbeHello(
            pid: pid,
            bundleId: "com.example.app",
            appName: "Example",
            probeVersion: "gp-probe/0.1.0",
            capabilities: capabilities,
            droppedEvents: droppedEvents,
            droppedWrites: droppedWrites,
            rejectedKeys: rejectedKeys
        )
    }

    // MARK: - the wire boundary

    func testHelloCountersDecodeWhenReported() throws {
        let json = """
        {"t":"hello","pid":4242,"appName":"Example","probeVersion":"gp-probe/0.1.0",\
        "capabilities":["z1"],"droppedEvents":12,"droppedWrites":3,"rejectedKeys":1}
        """
        guard case let .hello(decoded) = ProbeWire.decode(Data(json.utf8)) else {
            return XCTFail("expected a hello frame")
        }
        XCTAssertEqual(decoded.droppedEvents, 12)
        XCTAssertEqual(decoded.droppedWrites, 3)
        XCTAssertEqual(decoded.rejectedKeys, 1)
    }

    /// A probe that predates the keys, or whose `hello` never carried them, must
    /// not be recorded as having dropped nothing. That single confusion is the
    /// whole "unmeasured reported as measured" defect class this project ranks
    /// above ordinary bugs.
    func testAbsentHelloCountersStayUnreportedRatherThanZero() throws {
        let json = """
        {"t":"hello","pid":4242,"appName":"Example","probeVersion":"gp-probe/0.1.0",\
        "capabilities":["z1"]}
        """
        guard case let .hello(decoded) = ProbeWire.decode(Data(json.utf8)) else {
            return XCTFail("expected a hello frame")
        }
        XCTAssertNil(decoded.droppedEvents)
        XCTAssertNil(decoded.droppedWrites)
        XCTAssertNil(decoded.rejectedKeys)
    }

    func testNonsenseCounterValuesAreUnreportedNotGuessed() throws {
        for (field, value, read) in [
            ("droppedEvents", "-4", { (one: ProbeHello) in one.droppedEvents }),
            ("droppedWrites", "\"many\"", { (one: ProbeHello) in one.droppedWrites }),
            ("rejectedKeys", "null", { (one: ProbeHello) in one.rejectedKeys }),
        ] {
            let json = """
            {"t":"hello","pid":1,"appName":"A","probeVersion":"v","capabilities":[],\
            "\(field)":\(value)}
            """
            guard case let .hello(decoded) = ProbeWire.decode(Data(json.utf8)) else {
                return XCTFail("\(field): expected the frame to still decode as hello")
            }
            XCTAssertNil(
                read(decoded),
                "\(field): \(value) must not become a reported count"
            )
        }
    }

    /// A JSON boolean is not a count, but `JSONSerialization` hands it back as an
    /// `NSNumber` and `as? NSNumber` accepts it, so a naive numeric read turns
    /// `"droppedWrites": false` into the claim "zero writes were lost" — the
    /// exact inversion of the rule this file pins, reached from the side nobody
    /// thought to test. `true` is the same mistake wearing a different number.
    func testBooleanHelloCountersAreUnreportedNotReadAsZeroOrOne() throws {
        let json = """
        {"t":"hello","pid":1,"appName":"A","probeVersion":"v","capabilities":[],\
        "droppedWrites":false,"droppedEvents":true,"rejectedKeys":false}
        """
        guard case let .hello(decoded) = ProbeWire.decode(Data(json.utf8)) else {
            return XCTFail("expected the frame to still decode as hello")
        }
        XCTAssertNil(decoded.droppedWrites, "false must not become the measured claim 0")
        XCTAssertNil(decoded.droppedEvents, "true must not become the measured claim 1")
        XCTAssertNil(decoded.rejectedKeys, "false must not become the measured claim 0")
    }

    /// The other half of that veto: rejecting booleans must not slide into
    /// "suspicious shapes go missing". `0` is the one value here that *is* a
    /// measurement, and a probe reporting a clean channel has to be believed.
    func testZeroHelloCounterStaysAMeasurementAndIsNotSweptIntoAbsence() throws {
        let json = """
        {"t":"hello","pid":1,"appName":"A","probeVersion":"v","capabilities":[],\
        "droppedWrites":0,"droppedEvents":0,"rejectedKeys":0}
        """
        guard case let .hello(decoded) = ProbeWire.decode(Data(json.utf8)) else {
            return XCTFail("expected a hello frame")
        }
        XCTAssertEqual(decoded.droppedWrites, 0, "an explicit 0 is a measured \"nothing lost\"")
        XCTAssertEqual(decoded.droppedEvents, 0)
        XCTAssertEqual(decoded.rejectedKeys, 0)
    }

    /// Unknown keys must keep being tolerated: this decoder is what lets an older
    /// daemon run against a newer SDK, and tightening it here would break the
    /// pairing the wire table documents.
    func testUnknownHelloKeysAreStillTolerated() throws {
        let json = """
        {"t":"hello","pid":1,"appName":"A","probeVersion":"v","capabilities":[],\
        "droppedEvents":2,"someFutureCounter":7}
        """
        guard case let .hello(decoded) = ProbeWire.decode(Data(json.utf8)) else {
            return XCTFail("expected a hello frame")
        }
        XCTAssertEqual(decoded.droppedEvents, 2)
    }

    // MARK: - the status surface

    func testStatusRowsCarryReportedCountersAndOmitUnreportedOnes() throws {
        let inbox = ProbeInbox(now: { Date(timeIntervalSince1970: 1_800_000_000) })
        XCTAssertTrue(inbox.register(hello(pid: 11, droppedEvents: 40, droppedWrites: 2, rejectedKeys: 1)))
        XCTAssertTrue(inbox.register(hello(pid: 22)))

        let rows = inbox.statusJSON()
        XCTAssertEqual(rows.count, 2)
        let reported = try XCTUnwrap(rows.first { ($0["pid"] as? Int) == 11 })
        XCTAssertEqual(reported["droppedEvents"] as? Int, 40)
        XCTAssertEqual(reported["droppedWrites"] as? Int, 2)
        XCTAssertEqual(reported["rejectedKeys"] as? Int, 1)

        let silent = try XCTUnwrap(rows.first { ($0["pid"] as? Int) == 22 })
        for key in ["droppedEvents", "droppedWrites", "rejectedKeys"] {
            XCTAssertNil(
                silent[key],
                "\(key): a probe that never reported it must not be shown as 0"
            )
        }
    }

    func testProbeStatusPublishesTheDaemonSideTotalOnlyWithAnInbox() throws {
        let withInbox = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            settle: {},
            probeInbox: ProbeInbox(now: { Date() })
        )
        XCTAssertEqual(withInbox.probeStatus()["unmapableStateFrames"] as? Int, 0)

        let withoutInbox = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            settle: {}
        )
        XCTAssertNil(
            withoutInbox.probeStatus()["unmapableStateFrames"],
            "no inbox is the absence of the surface, not a measured zero"
        )
    }

    /// The same veto has to cover the identity fields, not only the counters:
    /// `{"pid": true}` used to bridge through `NSNumber` and register a probe as
    /// pid 1 — every later "hitCount: 0" would then be a measurement about
    /// somebody else's process, and the frame that *proved* nothing was watched
    /// would be the one the daemon trusted least.
    func testBooleanPidIsMalformedRatherThanProcessOne() throws {
        let json = """
        {"t":"hello","pid":true,"appName":"A","probeVersion":"v","capabilities":[]}
        """
        guard case let .malformed(reason) = ProbeWire.decode(Data(json.utf8)) else {
            return XCTFail("a boolean pid must not decode as a registration")
        }
        XCTAssertTrue(reason.contains("pid"), reason)
    }

    func testBooleanLineAndTimestampsAreNotReadAsNumbers() throws {
        let handler = """
        {"t":"handler","file":"a.swift","line":true,"ts":false}
        """
        guard case let .malformed(reason) = ProbeWire.decode(Data(handler.utf8)) else {
            return XCTFail("a boolean `line` must not decode as line 1")
        }
        XCTAssertTrue(reason.contains("line"), reason)
    }

    func testAbsentTimestampIsStillZeroAndNotRefused() throws {
        // The boolean veto must not turn into a required-field invention: `ts`
        // has always defaulted, and defaulting there is not a false measurement.
        let handler = """
        {"t":"handler","file":"a.swift","line":7,"ts":1.5}
        """
        guard case .handler(let file, let line, let ts, _) = ProbeWire.decode(Data(handler.utf8)) else {
            return XCTFail("expected a handler frame")
        }
        XCTAssertEqual(file, "a.swift")
        XCTAssertEqual(line, 7)
        XCTAssertEqual(ts, 1.5, accuracy: 0.0001)
    }

    func testProbeStatusRowsReachTheAgentWithTheirCounters() throws {
        let inbox = ProbeInbox(now: { Date() })
        XCTAssertTrue(inbox.register(hello(pid: 77, droppedWrites: 5)))
        let core = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            settle: {},
            probeInbox: inbox
        )
        let rows = try XCTUnwrap(core.probeStatus()["probes"] as? [[String: Any]])
        let row = try XCTUnwrap(rows.first { ($0["pid"] as? Int) == 77 })
        XCTAssertEqual(row["droppedWrites"] as? Int, 5)
    }

    // MARK: - a second hello for the same pid

    /// The SDK's capability announcements reuse the pid and do not have to repeat
    /// the counters, so the old whole-`hello` replacement turned a reported
    /// `droppedEvents: 40` back into "unreported". That direction is still honest
    /// — absence is not zero — but a real measurement evaporated only because a
    /// later frame chose to say less. A probe that measured its own losses gets
    /// to keep the credit for having measured them.
    func testRehelloThatOmitsCountersCarriesForwardTheEarlierMeasurement() throws {
        let inbox = ProbeInbox(now: { Date(timeIntervalSince1970: 1_800_000_000) })
        XCTAssertTrue(inbox.register(hello(pid: 33, droppedEvents: 40, droppedWrites: 2, rejectedKeys: 1)))
        XCTAssertTrue(inbox.register(hello(pid: 33, capabilities: ["z1", "kvc"])))

        let rows = inbox.statusJSON()
        XCTAssertEqual(rows.count, 1, "a re-hello is the same process, not a second registration")
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row["droppedEvents"] as? Int, 40)
        XCTAssertEqual(row["droppedWrites"] as? Int, 2)
        XCTAssertEqual(row["rejectedKeys"] as? Int, 1)
        // The counters are the only fields that merge: capabilities keep the
        // "the newest announcement is authoritative" semantics, so this fix must
        // not be read as a general sticky-hello rule.
        XCTAssertEqual(
            row["capabilities"] as? [String],
            ["z1", "kvc"],
            "capabilities take the new value; only the counters carry forward"
        )
    }

    /// The opposite direction, which the carry-forward must not break: an earlier
    /// absence is not a verdict that pins the row there. The first hello had
    /// nothing to report, the second one reports 7, and the row has to move.
    func testRehelloWithANewMeasurementOverridesTheEarlierAbsence() throws {
        let inbox = ProbeInbox(now: { Date(timeIntervalSince1970: 1_800_000_000) })
        XCTAssertTrue(inbox.register(hello(pid: 55)))
        let before = try XCTUnwrap(inbox.statusJSON().first)
        XCTAssertNil(
            before["droppedWrites"],
            "before anyone measures it the key is absent"
        )

        XCTAssertTrue(inbox.register(hello(pid: 55, droppedWrites: 7)))
        let row = try XCTUnwrap(inbox.statusJSON().first)
        XCTAssertEqual(row["droppedWrites"] as? Int, 7, "a new measurement beats an earlier absence")
        XCTAssertNil(
            row["droppedEvents"],
            "and the merge stays per-counter: one nobody ever reported is still not a 0"
        )
    }

    /// A counter that *neither* hello reported must survive the merge as absence —
    /// carrying forward "nothing" is how a 0 gets invented.
    func testRehelloNeverInventsACounterNeitherHelloReported() throws {
        let inbox = ProbeInbox(now: { Date(timeIntervalSince1970: 1_800_000_000) })
        XCTAssertTrue(inbox.register(hello(pid: 66, droppedEvents: 40)))
        XCTAssertTrue(inbox.register(hello(pid: 66, rejectedKeys: 1)))

        let row = try XCTUnwrap(inbox.statusJSON().first)
        XCTAssertEqual(row["droppedEvents"] as? Int, 40)
        XCTAssertEqual(row["rejectedKeys"] as? Int, 1)
        XCTAssertNil(row["droppedWrites"], "nil merged with nil stays nil")
    }

    /// The carry-forward belongs to one live registration, not to a pid slot: a
    /// process that genuinely disconnected starts its own counters at nothing,
    /// otherwise a recycled pid would be judged against the last app's losses.
    func testDisconnectClearsTheCarriedForwardCountersForTheNextRegistration() throws {
        let inbox = ProbeInbox(now: { Date(timeIntervalSince1970: 1_800_000_000) })
        XCTAssertTrue(inbox.register(hello(pid: 88, droppedEvents: 40)))
        inbox.disconnect(pid: 88)
        XCTAssertTrue(inbox.register(hello(pid: 88)))

        let row = try XCTUnwrap(inbox.statusJSON().first)
        XCTAssertNil(
            row["droppedEvents"],
            "a new process has not measured anything yet — its predecessor's 40 is not its claim"
        )
    }
}
