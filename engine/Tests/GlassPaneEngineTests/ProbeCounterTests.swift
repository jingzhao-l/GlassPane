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
        droppedEvents: Int? = nil,
        droppedWrites: Int? = nil,
        rejectedKeys: Int? = nil
    ) -> ProbeHello {
        ProbeHello(
            pid: pid,
            bundleId: "com.example.app",
            appName: "Example",
            probeVersion: "gp-probe/0.1.0",
            capabilities: ["z1"],
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
}
