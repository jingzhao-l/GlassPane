import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// P2 batch 2: T9 progressive degradation detection (spec v2.1 §18–§20).
/// Covers the DegradationTracker joint verdict (ping/memory/handles slopes),
/// the ProcessMetricsProbe real proc_pidinfo reads, EngineCore act()
/// escalation, and the Classifier T9 rule. No AX dependency beyond the
/// ScriptedChannel harness.
final class EngineP2Batch2Tests: XCTestCase {

    // MARK: - DegradationTracker pure logic


    // R6-01: a trend is a rate, so these fixtures sample 30 s apart — the window
    // has to clear `minimumTrendSpanSeconds` (20 s) for a judgement to exist at
    // all. The deltas are scaled with the spacing so each slope stays above its
    // own noise floor (memory 60 KB/30 s = 2 000 B/s vs the 512 B/s floor; handles
    // 4/30 s = 0.13 fd/s vs 0.05; ping 20 ms/30 s = 0.67 ms/s vs 0.5).

    func testFlatSeriesIsHealthy() {
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        for index in 0..<6 {
            tracker.record(DegradationSample(
                timestamp: 1_000 + 30 * Double(index),
                pingMs: 3,
                memoryBytes: 4_000,
                handleCount: 100
            ))
        }
        let verdict = tracker.verdict()
        XCTAssertEqual(verdict.tier, .healthy)
        XCTAssertTrue(verdict.drivers.isEmpty)
        XCTAssertEqual(verdict.sampleCount, 6)
        // The distinction R6-01 exists for: this is healthy *because it was
        // measured*, not because the window was too short to judge.
        XCTAssertTrue(verdict.judged, verdict.basis)
    }

    func testSingleRisingSignalIsWatch() {
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        // Only memory rises; ping and handles stay flat → exactly one driver.
        for index in 0..<4 {
            tracker.record(DegradationSample(
                timestamp: 1_000 + 30 * Double(index),
                pingMs: 3,
                memoryBytes: 60_000 * Int64(index),
                handleCount: 100
            ))
        }
        let verdict = tracker.verdict()
        XCTAssertEqual(verdict.tier, .watch)
        XCTAssertEqual(verdict.drivers, ["memory"])
        XCTAssertNotNil(verdict.memorySlopeBytesPerSec)
        XCTAssertGreaterThanOrEqual(verdict.memorySlopeBytesPerSec ?? 0, 512)
    }

    func testTwoRisingSignalsIsDegrading() {
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        // Ping and memory both rise; handles absent → joint verdict degrading.
        for index in 0..<5 {
            tracker.record(DegradationSample(
                timestamp: 1_000 + 30 * Double(index),
                pingMs: 2 + 20 * Double(index),
                memoryBytes: 60_000 * Int64(index),
                handleCount: nil
            ))
        }
        let verdict = tracker.verdict()
        XCTAssertEqual(verdict.tier, .degrading)
        XCTAssertEqual(verdict.drivers, ["ping", "memory"])
    }

    func testHandlesAndMemoryRisingIsDegrading() {
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        guard tracker.sampleCount == 0 else {
            return XCTFail("tracker must start empty")
        }
        for index in 0..<5 {
            tracker.record(DegradationSample(
                timestamp: 1_000 + 30 * Double(index),
                pingMs: 3,
                memoryBytes: 60_000 * Int64(index),
                handleCount: 100 + 4 * index
            ))
        }
        let verdict = tracker.verdict()
        XCTAssertEqual(verdict.tier, .degrading)
        XCTAssertEqual(verdict.drivers, ["memory", "handles"])
    }

    func testInsufficientSamplesIsHealthy() {
        // Default minimumSamplesForTrend = 6; only 3 samples → no judgment.
        let tracker = DegradationTracker()
        for index in 0..<3 {
            tracker.record(DegradationSample(
                timestamp: 1_000 + Double(index),
                pingMs: 1 + Double(index),
                memoryBytes: 1_000 * Int64(index),
                handleCount: nil
            ))
        }
        let verdict = tracker.verdict()
        XCTAssertEqual(verdict.tier, .healthy)
        XCTAssertFalse(verdict.judged, "three samples is not a measurement")
        XCTAssertTrue(
            verdict.basis.contains("3 samples in the window, 6 needed"),
            "the refusal has to name both numbers: \(verdict.basis)"
        )
    }

    func testWindowTrimsOldestSamples() {
        let tracker = DegradationTracker() // default window 64
        for index in 0..<70 {
            tracker.record(DegradationSample(
                timestamp: 1_000 + Double(index),
                pingMs: 3,
                memoryBytes: 4_000,
                handleCount: 100
            ))
        }
        XCTAssertEqual(tracker.sampleCount, DegradationTracker.defaultWindowSize)
        XCTAssertEqual(tracker.verdict().tier, .healthy)
    }

    func testLongSessionFlag() {
        let tracker = DegradationTracker(
            minimumSamplesForTrend: 2,
            longSessionThresholdSeconds: 300
        )
        tracker.record(DegradationSample(timestamp: 0, pingMs: nil, memoryBytes: 0, handleCount: nil))
        tracker.record(DegradationSample(timestamp: 300, pingMs: nil, memoryBytes: 0, handleCount: nil))
        let verdict = tracker.verdict()
        XCTAssertTrue(verdict.longSession)
        XCTAssertEqual(verdict.elapsedSeconds, 300)
        XCTAssertEqual(verdict.tier, .healthy)
    }

    func testNilSignalsNeverReachDegrading() {
        // Only ping rises; memory/handles absent → single driver → watch max.
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        for index in 0..<6 {
            tracker.record(DegradationSample(
                timestamp: 1_000 + 30 * Double(index),
                pingMs: 1 + 20 * Double(index),
                memoryBytes: nil,
                handleCount: nil
            ))
        }
        let verdict = tracker.verdict()
        XCTAssertEqual(verdict.tier, .watch)
        XCTAssertNotEqual(verdict.tier, .degrading)
    }

    func testResetClearsWindow() {
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        tracker.record(DegradationSample(timestamp: 1_000, pingMs: 1, memoryBytes: 0, handleCount: nil))
        tracker.record(DegradationSample(timestamp: 1_001, pingMs: 5, memoryBytes: 0, handleCount: nil))
        XCTAssertEqual(tracker.sampleCount, 2)
        tracker.reset()
        XCTAssertEqual(tracker.sampleCount, 0)
        XCTAssertEqual(tracker.verdict().tier, .healthy)
    }

    // MARK: - R6-01: the window must not be a function of the client's cadence

    /// The mechanism: samples arriving faster than `minSampleIntervalSeconds` are
    /// refused, and `record` reports that they were. A cap nobody can observe is
    /// not a cap, hence the return value.
    func testDenseSamplingIsRefusedAndCountsItself() {
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        var accepted = 0
        for index in 0..<100 {  // 100 samples, 10 ms apart = 1 second of calling
            if tracker.record(DegradationSample(
                timestamp: 1_000 + Double(index) * 0.01,
                pingMs: 3, memoryBytes: 4_000, handleCount: 100
            )) { accepted += 1 }
        }
        XCTAssertEqual(accepted, tracker.sampleCount, "only accepted samples may be in the window")
        XCTAssertEqual(
            accepted, 2,
            "a 10 ms cadence must collapse to the 0.5 s cap: first sample + one at +0.5s"
        )
        let verdict = tracker.verdict()
        XCTAssertFalse(verdict.judged, "two samples 0.5 s apart is not a trend: \(verdict.basis)")
    }

    /// The property the cap exists for: the *same physical process* must get the
    /// same verdict whether the agent polls it every 50 ms or every second. Before
    /// this round the 64-sample window's time depth was `64 × cadence`, so the
    /// 50 ms poller evicted the leak out of its own window and read a healthy app.
    func testVerdictIsInvariantToSamplingCadence() {
        // One physical event: at t=20 s the process takes on 2 MB and 40 handles
        // and keeps them. Sampled to t=40 s at two cadences.
        func tier(cadence: Double) -> DegradationTier {
            let tracker = DegradationTracker()
            var time = 0.0
            while time <= 40.0 {
                let stepped = time >= 20
                tracker.record(DegradationSample(
                    timestamp: time,
                    pingMs: 3,
                    memoryBytes: stepped ? 3_000_000 : 1_000_000,
                    handleCount: stepped ? 140 : 100
                ))
                time += cadence
            }
            return tracker.verdict().tier
        }
        let polled = tier(cadence: 0.05)     // an agent hammering observe
        let paced = tier(cadence: 1.0)       // an agent acting about once a second
        XCTAssertEqual(polled, .degrading, "50 ms polling evicted the leak: \(polled.rawValue)")
        XCTAssertEqual(paced, .degrading, "the same leak at 1 s cadence: \(paced.rawValue)")
        XCTAssertEqual(polled, paced, "cadence changed the verdict")
    }

    /// The other half of the coupling: a short, dense window used to be able to
    /// *manufacture* a trend, because a few KB of allocator jitter over 250 ms is
    /// 800 B/s and that clears the 512 B/s floor. The floors are per-second rates,
    /// so a window with no per-second baseline is refused instead of judged.
    func testAllocatorJitterOverAShortWindowIsNotTrending() {
        // The density cap is switched off here on purpose: this case is about the
        // span gate alone (`testDenseSamplingIsRefusedAndCountsItself` covers the
        // cap, and with the cap on this fixture would be refused for having one
        // sample instead of eight).
        let tracker = DegradationTracker(
            minimumSamplesForTrend: 2, minSampleIntervalSeconds: 0
        )
        for index in 0..<8 {  // 8 samples, 50 ms apart: 0.35 s of wall time
            tracker.record(DegradationSample(
                timestamp: Double(index) * 0.05,
                pingMs: 3 + Double(index) * 0.01,
                memoryBytes: Int64(2_000 * index),   // 2 KB per 50 ms = 40 000 B/s
                handleCount: 100 + index             // 1 fd per 50 ms = 20 fd/s
            ))
        }
        let verdict = tracker.verdict()
        XCTAssertFalse(verdict.judged, verdict.basis)
        XCTAssertEqual(verdict.tier, .healthy, "a refusal must never be published as a trend")
        XCTAssertTrue(verdict.drivers.isEmpty)
        XCTAssertNil(verdict.memorySlopeBytesPerSec, "no slope: nothing was measured")
        XCTAssertLessThan(verdict.elapsedSeconds, verdict.minimumTrendSpanSeconds)
        XCTAssertTrue(
            verdict.basis.contains("window spans"),
            "the refusal has to name the span it measured: \(verdict.basis)"
        )

        // The control that proves the gate is what refuses: same bytes, span gate
        // off → 40 000 B/s of allocator jitter and 20 fd/s of churn read as two
        // trending channels and escalate to `degrading`. If this ever comes back
        // healthy too, the assertion above is passing for a reason unrelated to
        // the window length.
        let ungated = DegradationTracker(
            minimumSamplesForTrend: 2, minSampleIntervalSeconds: 0, minimumTrendSpanSeconds: 0
        )
        for index in 0..<8 {
            ungated.record(DegradationSample(
                timestamp: Double(index) * 0.05,
                pingMs: 3 + Double(index) * 0.01,
                memoryBytes: Int64(2_000 * index),
                handleCount: 100 + index
            ))
        }
        let ungatedVerdict = ungated.verdict()
        XCTAssertTrue(ungatedVerdict.judged, ungatedVerdict.basis)
        XCTAssertEqual(ungatedVerdict.tier, .degrading, "\(ungatedVerdict.drivers)")
    }

    // MARK: - ProcessMetricsProbe real reads


    func testSelfProbeReportsLiveMetrics() {
        let probe = ProcessMetricsProbe()
        let metrics = probe.metrics(for: getpid())
        XCTAssertNotNil(metrics.memoryBytes)
        XCTAssertGreaterThan(metrics.memoryBytes ?? 0, 0)
        XCTAssertNotNil(metrics.handleCount)
        XCTAssertGreaterThanOrEqual(metrics.handleCount ?? 0, 0)
    }

    func testDeadPidYieldsNilMetrics() {
        let probe = ProcessMetricsProbe()
        let metrics = probe.metrics(for: .max)
        XCTAssertNil(metrics.memoryBytes)
        XCTAssertNil(metrics.handleCount)
    }

    // MARK: - EngineCore act() integration

    func testActWithoutTrackerMatchesV20() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let core = EngineCore(channel: channel)
        _ = try attachingAndActing(core)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.circuitBreaker.level, .normal)
        XCTAssertFalse(pack.circuitBreaker.reason?.hasPrefix("degradation|") ?? false)
    }

    func testFlatSeriesDoesNotEscalate() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let clock = VariableClock(start: 1_000)
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        let probe = ScriptedMetricsProbe()
        probe.memorySeries = [4_000, 4_000]  // flat over a 30 s step: measured, not short
        let core = EngineCore(
            channel: channel,
            clock: { clock.time() },
            degradationTracker: tracker,
            metricsProbe: probe
        )
        _ = try attachingAndActing(core)
        clock.advance(by: 30)
        _ = try attachingAndActing(core)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.circuitBreaker.level, .normal)
        XCTAssertFalse(pack.circuitBreaker.reason?.hasPrefix("degradation|") ?? false)
    }

    func testJointDriftEscalatesEvidence() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let clock = VariableClock(start: 1_000)
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        let probe = ScriptedMetricsProbe()
        probe.memorySeries = [1_000, 61_000] // rising resident memory: 2 000 B/s
        let core = EngineCore(
            channel: channel,
            clock: { clock.time() },
            degradationTracker: tracker,
            metricsProbe: probe
        )
        _ = try attaching(core)
        channel.pingResult = .success(2)
        _ = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        clock.advance(by: 30)
        channel.pingResult = .success(24) // rising main-thread latency: 0.73 ms/s
        _ = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)

        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.circuitBreaker.level, .degraded)
        let reason = pack.circuitBreaker.reason ?? ""
        XCTAssertTrue(reason.hasPrefix("degradation|"), "reason must carry degradation| prefix, got \(reason)")
        XCTAssertTrue(reason.contains("memory"))
        XCTAssertTrue(reason.contains("ping"))
    }

    func testPingOnlyRiseNeverEscalates() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let clock = VariableClock(start: 1_000)
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        // No metrics probe injected → memory/handles absent; at most watch.
        let core = EngineCore(
            channel: channel,
            clock: { clock.time() },
            degradationTracker: tracker
        )
        _ = try attaching(core)
        channel.pingResult = .success(2)
        _ = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        clock.advance(by: 30)
        channel.pingResult = .success(30)  // 0.93 ms/s: one trending channel
        _ = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)

        XCTAssertEqual(tracker.verdict().tier, .watch)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.circuitBreaker.level, .normal)
        XCTAssertFalse(pack.circuitBreaker.reason?.hasPrefix("degradation|") ?? false)
    }

    func testAttachSwitchResetsTracker() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let clock = VariableClock(start: 1_000)
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        let core = EngineCore(
            channel: channel,
            clock: { clock.time() },
            degradationTracker: tracker
        )
        _ = try attaching(core)
        _ = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        XCTAssertEqual(tracker.sampleCount, 1)

        // Attach a different app → degradation window resets with the history.
        channel.app = AttachedApp(pid: 9_999, bundleId: "com.example.other", appName: "Other")
        _ = try attaching(core)
        XCTAssertEqual(tracker.sampleCount, 0)
    }

    // MARK: - Classifier T9 rule

    private func degradedPack(reason: String?, actConfirmed: Bool) -> EvidencePack {
        EvidencePack(
            operationId: "op_t9_test",
            createdAt: "2026-09-17T00:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .degraded, reason: reason),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: "Submit"),
                    action: .press,
                    actConfirmed: actConfirmed
                ),
                axEvent: AxEventSignal(
                    treeDigestBefore: "abc", treeDigestAfter: "abc",
                    nodeCount: 3, axChanged: false, latencyMs: 5
                ),
                pixelDiff: PixelDiffSignal(changedPixelRatio: 0, bounds: nil, windowId: 1),
                responsiveness: ResponsivenessSignal(responsive: true, pingMs: 5),
                crash: CrashSignal(processAliveBefore: true, processAliveAfter: true)
            )
        )
    }

    func testDegradedPackClassifiesAsT9() {
        let (class_, _) = Classifier.classify(
            degradedPack(reason: "degradation|memory+ping; longSession=true", actConfirmed: true)
        )
        XCTAssertEqual(class_, .t9)
    }

    func testNormalPackDoesNotClassifyT9() {
        let (class_, _) = Classifier.classify(degradedPack(reason: nil, actConfirmed: true))
        XCTAssertNotEqual(class_, .t9)
    }

    func testUnconfirmedDegradedPackStaysInconclusive() {
        let (class_, _) = Classifier.classify(
            degradedPack(reason: "degradation|memory+ping; longSession=true", actConfirmed: false)
        )
        XCTAssertEqual(class_, .inconclusive)
    }

    // MARK: - Helpers

    private func attaching(_ core: EngineCore) throws {
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
    }

    private func attachingAndActing(_ core: EngineCore) throws -> [String: Any] {
        _ = try attaching(core)
        return try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
    }
}

/// Mutable fake clock so per-act timestamps advance between acts.
private final class VariableClock {
    private(set) var now: TimeInterval

    init(start: TimeInterval) {
        self.now = start
    }

    func time() -> Date {
        Date(timeIntervalSince1970: now)
    }

    func advance(by seconds: TimeInterval) {
        now += seconds
    }
}

/// Scripted metrics probe: returns scripted series (FIFO), nil once exhausted.
private final class ScriptedMetricsProbe: ProcessMetricsProviding {
    var memorySeries: [Int64?] = []
    var handleSeries: [Int?] = []

    func metrics(for pid: pid_t) -> (memoryBytes: Int64?, handleCount: Int?) {
        let memory = memorySeries.isEmpty ? nil : memorySeries.removeFirst()
        let handles = handleSeries.isEmpty ? nil : handleSeries.removeFirst()
        return (memoryBytes: memory, handleCount: handles)
    }
}