import XCTest
@testable import GlassPaneEngine

/// R5-06: the degradation window used to advance only on `act`, and the verdict
/// only ever surfaced inside an act's evidence. Two consequences were invisible
/// from the outside: a read-only agent (observe/diagnose/last_evidence — which
/// is what an audit-shaped integration actually does) never produced a sample, so
/// a leaking app could run for hours without T9 ever seeing it; and a single
/// trending channel produced no output at all, because escalation requires two
/// drivers. Sampling is a measurement of the attached process, not of the click,
/// and the `watch` tier is a fact worth publishing — that is what these pin.
final class DegradationSurfaceTests: XCTestCase {

    private final class VariableClock {
        private var now: Date
        init(start: TimeInterval) { now = Date(timeIntervalSince1970: start) }
        func time() -> Date { now }
        func advance(by seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
    }

    private final class ScriptedMetricsProbe: ProcessMetricsProviding {
        var memorySeries: [Int64?] = []
        func metrics(for pid: pid_t) -> (memoryBytes: Int64?, handleCount: Int?) {
            (memoryBytes: memorySeries.isEmpty ? nil : memorySeries.removeFirst(), handleCount: nil)
        }
    }

    private func makeCore(
        channel: ScriptedChannel,
        clock: VariableClock,
        tracker: DegradationTracker?,
        probe: ScriptedMetricsProbe?
    ) -> EngineCore {
        EngineCore(
            channel: channel,
            clock: { clock.time() },
            degradationTracker: tracker,
            metricsProbe: probe
        )
    }

    /// The whole point: `observe` alone advances the window. Before the fix this
    /// asserted 0 and passed for the wrong reason (nothing sampled at all), so the
    /// expectation is stated as "one sample per observe", not "≥ 1".
    func testObserveAloneAdvancesTheDegradationWindow() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let clock = VariableClock(start: 1_000)
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        let probe = ScriptedMetricsProbe()
        probe.memorySeries = [1_000, 1_200, 1_400]
        let core = makeCore(channel: channel, clock: clock, tracker: tracker, probe: probe)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)

        XCTAssertEqual(tracker.verdict().sampleCount, 0, "nothing sampled before the first request")
        for round in 1...3 {
            _ = try core.observe(maxDepth: 4, role: nil)
            clock.advance(by: 1)
            XCTAssertEqual(
                tracker.verdict().sampleCount, round,
                "each observe must add exactly one sample (round \(round))"
            )
        }
    }

    /// Sampling alone must not silently escalate: without two trending drivers the
    /// breaker stays where it was; what changes is that the reader can now see the
    /// trend rather than its absence.
    func testProbeStatusPublishesTheVerdictAndItsDrivers() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let clock = VariableClock(start: 1_000)
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        let probe = ScriptedMetricsProbe()
        // 30 s apart, 60 KB/step: the window has to clear the trend-span floor
        // before any of this is a judgement rather than a refusal to make one.
        probe.memorySeries = [1_000, 61_000]     // one trending channel: memory
        let core = makeCore(channel: channel, clock: clock, tracker: tracker, probe: probe)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        _ = try core.observe(maxDepth: 4, role: nil)
        clock.advance(by: 30)
        _ = try core.observe(maxDepth: 4, role: nil)

        let block = try XCTUnwrap(
            core.probeStatus()["degradation"] as? [String: Any],
            "the verdict must be readable without performing an action"
        )
        let tier = try XCTUnwrap(block["tier"] as? String)
        XCTAssertEqual(block["samples"] as? Int, 2)
        XCTAssertEqual(tier, "watch", "one trending channel is an early warning, not an escalation")
        XCTAssertNotEqual(tier, "degrading", "escalation needs two drivers: \(block)")
        XCTAssertEqual(
            block["drivers"] as? [String] ?? [],
            ["memory"],
            "the one trending driver has to be named, not folded into silence: \(block)"
        )
        // R6-01: the reading has to travel with what it means. `judged` separates
        // a measurement from a refusal, the two thresholds are published next to
        // the counts they gate (so a reader never has to know the defaults), and
        // `slopes` carries only the channels that produced one.
        XCTAssertEqual(block["judged"] as? Bool, true, "\(block)")
        let basis = try XCTUnwrap(block["basis"] as? String)
        XCTAssertTrue(basis.hasPrefix("judged from "), basis)
        XCTAssertEqual(block["minimumSamples"] as? Int, 2)
        XCTAssertEqual(block["minimumSpanSeconds"] as? Double, 20)
        XCTAssertEqual(block["spanSeconds"] as? Double, 30)
        let slopes = try XCTUnwrap(block["slopes"] as? [String: Any])
        XCTAssertNotNil(slopes["memoryBytesPerSec"], "\(slopes)")
        XCTAssertNil(slopes["pingMsPerSec"], "observe pays for no ping: absent, not zero")
        XCTAssertNil(slopes["handlesPerSec"], "the scripted probe reports no handle count")
    }

    /// R6-01, the published half of the fix: before it, an unmeasured window
    /// reached an agent as `tier: "healthy"` — the same bytes a measured-clean app
    /// produces. `probe_status` is where the read-only agent looks, so this is the
    /// one place the ambiguity could not stay invisible.
    func testProbeStatusSaysWhenNothingWasJudged() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let clock = VariableClock(start: 1_000)
        let tracker = DegradationTracker()          // defaults: 6 samples, 20 s span
        let probe = ScriptedMetricsProbe()
        probe.memorySeries = [1_000, 9_000]
        let core = makeCore(channel: channel, clock: clock, tracker: tracker, probe: probe)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        _ = try core.observe(maxDepth: 4, role: nil)
        clock.advance(by: 30)
        _ = try core.observe(maxDepth: 4, role: nil)

        let block = try XCTUnwrap(core.probeStatus()["degradation"] as? [String: Any])
        XCTAssertEqual(block["judged"] as? Bool, false, "\(block)")
        XCTAssertEqual(block["tier"] as? String, "healthy")
        let basis = try XCTUnwrap(block["basis"] as? String)
        XCTAssertTrue(basis.hasPrefix("not judged: "), basis)
        XCTAssertTrue(basis.contains("2 samples"), basis)
        XCTAssertNil(block["drivers"], "a refusal names no drivers")
        XCTAssertNil(block["slopes"], "a refusal publishes no slopes")
        XCTAssertEqual(block["minimumSamples"] as? Int, 6, "the reader needs the gate value")
    }

    /// The negative half: an engine wired without a tracker reports no
    /// degradation block at all — absence of the surface, never `healthy`.
    func testVerdictIsAbsentWhenT9IsNotWired() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertNil(
            core.probeStatus()["degradation"],
            "no tracker must not read as a healthy trend"
        )
    }
}
