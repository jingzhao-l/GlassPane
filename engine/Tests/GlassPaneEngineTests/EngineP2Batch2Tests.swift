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

    func testFlatSeriesIsHealthy() {
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        for index in 0..<6 {
            tracker.record(DegradationSample(
                timestamp: 1_000 + Double(index),
                pingMs: 3,
                memoryBytes: 4_000,
                handleCount: 100
            ))
        }
        let verdict = tracker.verdict()
        XCTAssertEqual(verdict.tier, .healthy)
        XCTAssertTrue(verdict.drivers.isEmpty)
        XCTAssertEqual(verdict.sampleCount, 6)
    }

    func testSingleRisingSignalIsWatch() {
        let tracker = DegradationTracker(minimumSamplesForTrend: 2)
        // Only memory rises; ping and handles stay flat → exactly one driver.
        for index in 0..<4 {
            tracker.record(DegradationSample(
                timestamp: 1_000 + Double(index),
                pingMs: 3,
                memoryBytes: 1_000 * Int64(index),
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
                timestamp: 1_000 + Double(index),
                pingMs: 2 + Double(index),
                memoryBytes: 1_000 * Int64(index),
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
                timestamp: 1_000 + Double(index),
                pingMs: 3,
                memoryBytes: 800 * Int64(index),
                handleCount: 100 + index
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
        XCTAssertEqual(tracker.verdict().tier, .healthy)
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
                timestamp: 1_000 + Double(index),
                pingMs: 1 + Double(index),
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
        probe.memorySeries = [4_000, 4_000]
        let core = EngineCore(
            channel: channel,
            clock: { clock.time() },
            degradationTracker: tracker,
            metricsProbe: probe
        )
        _ = try attachingAndActing(core)
        clock.advance(by: 1)
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
        probe.memorySeries = [1_000, 5_000] // rising resident memory
        let core = EngineCore(
            channel: channel,
            clock: { clock.time() },
            degradationTracker: tracker,
            metricsProbe: probe
        )
        _ = try attaching(core)
        channel.pingResult = .success(2)
        _ = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        clock.advance(by: 1)
        channel.pingResult = .success(5) // rising main-thread latency
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
        clock.advance(by: 1)
        channel.pingResult = .success(9)
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