import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// P2 batch 1: C33 concurrency attribution protection (spec v2.0 §15–§17).
/// Covers the input event source abstraction, operation-right idle detection,
/// contamination verdicts, EngineCore act() integration and the C33 synthetic
/// scenario rates. No AX dependency — ScriptedChannel + ScriptedInputEventSource.
final class EngineP2Batch1Tests: XCTestCase {

    // MARK: - Helpers

    private func makeCore(
        channel: ScriptedChannel,
        guard source: InputEventSource? = nil,
        now: Date = Date(timeIntervalSince1970: 1_000)
    ) -> (EngineCore, AttributionGuard?) {
        if let source {
            let guard_ = AttributionGuard(
                inputSource: source,
                clock: { now },
                idleWindowSeconds: 0.5
            )
            let core = EngineCore(
                channel: channel,
                clock: { now },
                attributionGuard: guard_
            )
            return (core, guard_)
        }
        let core = EngineCore(channel: channel, clock: { now })
        return (core, nil)
    }

    private func attaching(_ core: EngineCore) throws {
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
    }

    private func actResult(_ core: EngineCore) throws -> [String: Any] {
        try attaching(core)
        return try core.act(
            selector: Selector(role: "AXButton", title: "Submit"),
            action: .press
        )
    }

    // MARK: - P2-A1 ScriptedInputEventSource

    func testScriptedSourceReplaysQueuedEvents() {
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 1, source: .human),
            InputEvent(timestamp: 2, source: .agent)
        ])
        XCTAssertEqual(source.nextEvent(), InputEvent(timestamp: 1, source: .human))
        XCTAssertEqual(source.nextEvent(), InputEvent(timestamp: 2, source: .agent))
        XCTAssertNil(source.nextEvent())
        XCTAssertNil(source.nextEvent())
    }

    func testScriptedSourceDrainExhaustsQueue() {
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 1, source: .agent),
            InputEvent(timestamp: 2, source: .agent)
        ])
        XCTAssertEqual(source.drain().count, 2)
        XCTAssertNil(source.nextEvent())
    }

    func testEmptySourceDrainReturnsEmpty() {
        let source = ScriptedInputEventSource(events: [])
        XCTAssertTrue(source.drain().isEmpty)
        XCTAssertNil(source.nextEvent())
    }

    // MARK: - P2-A2 Input idle detection

    func testAcquireWhenIdleWindowHasNoHumanEvents() {
        let source = ScriptedInputEventSource(events: [
            // Old human event (outside the 0.5s idle window) — must not block.
            InputEvent(timestamp: 999.0, source: .human)
        ])
        let now = Date(timeIntervalSince1970: 1_000)
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { now },
            idleWindowSeconds: 0.5
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        XCTAssertTrue(guard_.isHolding)
    }

    func testAcquireRejectedWhenHumanEventInsideIdleWindow() {
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.9, source: .human) // 0.1s before now
        ])
        let now = Date(timeIntervalSince1970: 1_000)
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { now },
            idleWindowSeconds: 0.5
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .idleNotMet)
        XCTAssertFalse(guard_.isHolding)
    }

    func testAcquireRejectedWhileAlreadyHolding() {
        let source = ScriptedInputEventSource(events: [])
        let guard_ = AttributionGuard(inputSource: source)
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        XCTAssertEqual(guard_.acquireOperationRight(), .idleNotMet)
    }

    func testIdleWindowBoundaryIsInclusive() {
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.5, source: .human) // exactly at now - 0.5
        ])
        let now = Date(timeIntervalSince1970: 1_000)
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { now },
            idleWindowSeconds: 0.5
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .idleNotMet)
    }

    // MARK: - P2-A3 Contamination verdict

    func testNoInputDuringHoldIsNotContaminated() {
        let source = ScriptedInputEventSource(events: [])
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        let verdict = guard_.releaseOperationRight()
        XCTAssertFalse(verdict.contaminated)
        XCTAssertTrue(verdict.humanEvents.isEmpty)
    }

    func testOnlyAgentEventsDuringHoldIsNotContaminated() {
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 1_000.1, source: .agent)
        ])
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        guard_.monitorInput()
        let verdict = guard_.releaseOperationRight()
        XCTAssertFalse(verdict.contaminated)
        XCTAssertTrue(verdict.humanEvents.isEmpty)
    }

    func testHumanEventDuringHoldIsContaminated() {
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 1_000.1, source: .human)
        ])
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        guard_.monitorInput()
        let verdict = guard_.releaseOperationRight()
        XCTAssertTrue(verdict.contaminated)
        XCTAssertEqual(verdict.humanEvents.count, 1)
        XCTAssertEqual(verdict.humanEvents.first?.source, .human)
    }

    func testHumanEventBetweenMonitorAndReleaseStillCaught() {
        // Events arriving after the last monitorInput() poll but before
        // release must still be attributed to this operation window.
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 1_000.2, source: .human)
        ])
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        // No monitorInput call — release drains the remainder itself.
        let verdict = guard_.releaseOperationRight()
        XCTAssertTrue(verdict.contaminated)
    }

    func testReleaseWithoutHoldIsClean() {
        let source = ScriptedInputEventSource(events: [])
        let guard_ = AttributionGuard(inputSource: source)
        let verdict = guard_.releaseOperationRight()
        XCTAssertFalse(verdict.contaminated)
        XCTAssertTrue(verdict.humanEvents.isEmpty)
    }

    // MARK: - P2-A4/A5 EngineCore act() integration

    func testActWithoutGuardKeepsPodv16Semantics() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let core = EngineCore(channel: channel)
        _ = try actResult(core)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.attribution.level, .soft)
        XCTAssertFalse(pack.attribution.contaminated)
    }

    func testActWithGuardAndCleanInputIsNotContaminated() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let source = ScriptedInputEventSource(events: [])
        let (core, _) = makeCore(channel: channel, guard: source)
        _ = try actResult(core)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.attribution.level, .soft)
        XCTAssertFalse(pack.attribution.contaminated)
    }

    func testActWithParallelHumanInputIsContaminated() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        // A human event arrives during the act window (timestamp inside the
        // hold; the idle window only guards the *pre*-act state).
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 1_000.1, source: .human)
        ])
        let (core, _) = makeCore(channel: channel, guard: source)
        _ = try actResult(core)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.attribution.level, .weak)
        XCTAssertTrue(pack.attribution.contaminated)
    }

    // MARK: - P2-A6 Busy input error

    func testActThrowsBusyInputWhenInputStaysBusy() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        // Human events keep arriving inside the idle window on every retry:
        // a source that is forever busy relative to the fixed clock.
        let source = BusyForeverInputSource(now: 1_000)
        let (core, _) = makeCore(channel: channel, guard: source, now: Date(timeIntervalSince1970: 1_000))
        try attaching(core)
        XCTAssertThrowsError(
            try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        ) { error in
            guard let gpError = error as? GPError else {
                return XCTFail("expected GPError, got \(error)")
            }
            XCTAssertEqual(gpError.code, .busyInput)
        }
        // No evidence must be recorded for the refused operation.
        XCTAssertThrowsError(try core.lastEvidence(operationId: nil))
    }

    func testActRecoversOnceIdleAfterRetries() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        // Models a user who stops typing: the first two idle checks see real
        // input, then the input window goes quiet and acquisition succeeds.
        let source = BusyThenIdleInputSource(busyPeekCount: 2, now: 1_000)
        let (core, _) = makeCore(channel: channel, guard: source, now: Date(timeIntervalSince1970: 1_000))
        let result = try actResult(core)
        XCTAssertEqual(result["actConfirmed"] as? Bool, true)
        XCTAssertEqual(source.busyPeekCountRemaining, 0)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.attribution.level, .soft)
        XCTAssertFalse(pack.attribution.contaminated)
    }

    // MARK: - P2-A7 C33 synthetic scenario rates (deterministic, fixed seed)

    private struct SyntheticScenario {
        let willContaminate: Bool  // ground truth: human input during act
        let events: [InputEvent]
    }

    private func generateScenarios() -> [SyntheticScenario] {
        // Fixed seed for reproducibility; 100 scenarios (60 polluted / 40 clean).
        var generator = SeededGenerator(seed: 0xC33)
        let total = 100
        let pollutedCount = 60
        var scenarios: [SyntheticScenario] = []
        for index in 0..<total {
            let willContaminate = index < pollutedCount
            var events: [InputEvent] = []
            if willContaminate {
                // 1–3 human events arrive during the hold window.
                let humanCount = 1 + generator.next(upperBound: 3)
                for _ in 0..<humanCount {
                    events.append(InputEvent(timestamp: 1_000.1, source: .human))
                }
            } else {
                // Clean scenarios carry only stale/agent events outside the
                // idle window so acquisition succeeds.
                if generator.next(upperBound: 2) == 0 {
                    events.append(InputEvent(timestamp: 999.0, source: .human))
                }
                events.append(InputEvent(timestamp: 1_000.1, source: .agent))
            }
            scenarios.append(SyntheticScenario(willContaminate: willContaminate, events: events))
        }
        return scenarios
    }

    func testSyntheticRatesMeetC33() throws {
        let scenarios = generateScenarios()
        let now = Date(timeIntervalSince1970: 1_000)
        var detections = 0
        var pollutedCount = 0
        var falsePositives = 0
        var cleanCount = 0

        for scenario in scenarios {
            let source = ScriptedInputEventSource(events: scenario.events)
            let guard_ = AttributionGuard(
                inputSource: source,
                clock: { now },
                idleWindowSeconds: 0.5
            )
            let acquisition = guard_.acquireOperationRight()
            guard acquisition == .acquired else {
                // A clean scenario must always acquire; a polluted scenario
                // whose contamination only appears during the hold also must.
                // Fail loudly on misconstruction instead of skewing rates.
                XCTFail("scenario failed to acquire: \(scenario.events)")
                continue
            }
            guard_.monitorInput()
            let verdict = guard_.releaseOperationRight()

            if scenario.willContaminate {
                pollutedCount += 1
                if verdict.contaminated { detections += 1 }
            } else {
                cleanCount += 1
                if verdict.contaminated { falsePositives += 1 }
            }
        }

        let detectionRate = Double(detections) / Double(pollutedCount)
        let falsePositiveRate = Double(falsePositives) / Double(cleanCount)
        XCTAssertGreaterThanOrEqual(detectionRate, 0.95,
            "C33 detection rate must be >= 95%, got \(detectionRate)")
        XCTAssertLessThan(falsePositiveRate, 0.05,
            "C33 false positive rate must be < 5%, got \(falsePositiveRate)")
    }
}

/// Deterministic pseudo-random generator (Linear Congruential, fixed seed) so
/// the C33 scenario suite and its rate assertions are fully reproducible.
private struct SeededGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed == 0 ? 1 : seed
    }

    mutating func next(upperBound: UInt64) -> UInt64 {
        // LCG constants (Numerical Recipes); never returns 0 for value 0 with
        // implicit +1 below, keeping upperBound semantics exact.
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return (state >> 33) % max(upperBound, 1)
    }
}

/// A source that reports busy on every idle check: peekAvailable always returns
/// a human event inside the idle window relative to the fixed clock, so
/// acquisition never succeeds (models a user who never stops typing). The busy
/// event is peek-only phantom — it is never drained, because acquisition never
/// completes and no monitor/release scan ever runs.
private final class BusyForeverInputSource: InputEventSource {
    private let busyEvent: InputEvent

    init(now: Double) {
        self.busyEvent = InputEvent(timestamp: now - 0.1, source: .human)
    }

    func nextEvent() -> InputEvent? {
        nil
    }

    func peekAvailable() -> [InputEvent] {
        [busyEvent]
    }
}

/// A source that reports busy for the first `busyPeekCount` idle checks, then
/// goes quiet — models a user who stops typing mid-retry. The busy events are
/// transient peek-only phantoms with timestamps strictly before the hold start
/// (now - 0.1), so once acquisition succeeds they never contaminate the hold.
private final class BusyThenIdleInputSource: InputEventSource {
    private(set) var busyPeekCountRemaining: Int
    private let busyEvent: InputEvent

    init(busyPeekCount: Int, now: Double) {
        self.busyPeekCountRemaining = busyPeekCount
        self.busyEvent = InputEvent(timestamp: now - 0.1, source: .human)
    }

    func nextEvent() -> InputEvent? {
        nil
    }

    func peekAvailable() -> [InputEvent] {
        guard busyPeekCountRemaining > 0 else { return [] }
        busyPeekCountRemaining -= 1
        return [busyEvent]
    }
}