import XCTest
@testable import GlassPaneEngine

/// Human-intervention audit batch (P6 spec §11, item ①): the GP_E_BUSY_INPUT
/// remedy used to promise a "degrade mode" that did not exist. These tests pin
/// the real `degrade` parameter end-to-end: AttributionGuard degraded
/// acquisition (backdated hold start charges the busy window into the
/// contamination verdict), EngineCore.act(degrade:) admission, and Dispatcher
/// parameter routing/validation. No AX dependency.
final class HumanInterventionAuditTests: XCTestCase {

    // MARK: - Helpers

    private func makeCore(
        channel: ScriptedChannel,
        guard source: InputEventSource,
        now: Date = Date(timeIntervalSince1970: 1_000)
    ) -> (EngineCore, AttributionGuard) {
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { now },
            idleWindowSeconds: 0.5
        )
        let core = EngineCore(channel: channel, clock: { now }, attributionGuard: guard_)
        return (core, guard_)
    }

    private func pressSubmit(_ core: EngineCore, degrade: Bool = false) throws -> [String: Any] {
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        return try core.act(
            selector: Selector(role: "AXButton", title: "Submit"),
            action: .press,
            degrade: degrade
        )
    }

    // MARK: - AttributionGuard degraded acquisition

    func testDegradeAcquireAdmitsBusyWindowAndChargesContamination() {
        // One human event 0.1s before `now`: inside the 0.5s idle window, so
        // the normal acquire refuses. The degraded acquire admits, and the
        // backdated hold start must charge this event into the verdict.
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.9, source: .human)
        ])
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) },
            idleWindowSeconds: 0.5
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .idleNotMet)
        XCTAssertEqual(guard_.acquireOperationRight(degradeOnBusy: true), .acquired)
        XCTAssertTrue(guard_.isHolding)
        guard_.monitorInput()
        let verdict = guard_.releaseOperationRight()
        XCTAssertTrue(verdict.contaminated,
            "a degraded admission over a busy window must never look clean")
        XCTAssertEqual(verdict.humanEvents.map(\.timestamp), [999.9])
    }

    func testDegradeAcquireOnQuietWindowStaysClean() {
        // degrade:true on an idle window is just a normal acquisition —
        // no phantom contamination, and the out-of-window human event (999.0,
        // before the un-backdated hold start of 1000.0) stays uncharged.
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.0, source: .human)
        ])
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) },
            idleWindowSeconds: 0.5
        )
        XCTAssertEqual(guard_.acquireOperationRight(degradeOnBusy: true), .acquired)
        let verdict = guard_.releaseOperationRight()
        XCTAssertFalse(verdict.contaminated)
        XCTAssertTrue(verdict.humanEvents.isEmpty)
    }

    func testDegradeAcquireWhileHoldingIsIdleNotMet() {
        let source = ScriptedInputEventSource(events: [])
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) },
            idleWindowSeconds: 0.5
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        XCTAssertEqual(guard_.acquireOperationRight(degradeOnBusy: true), .idleNotMet)
        _ = guard_.releaseOperationRight()
    }

    // MARK: - EngineCore.act(degrade:)

    func testActDegradeAdmitsBusyWindowAsWeakContaminatedEvidence() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.9, source: .human)
        ])
        let (core, _) = makeCore(channel: channel, guard: source)
        let result = try pressSubmit(core, degrade: true)
        XCTAssertEqual(result["actConfirmed"] as? Bool, true)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.attribution.level, .weak)
        XCTAssertTrue(pack.attribution.contaminated,
            "degrade admits the act but the busy window must be recorded, never silently clean")
    }

    func testActWithoutDegradeStillRefusesBusyWindow() throws {
        // Regression: the default path is byte-for-byte the old semantics —
        // bounded retries, then GP_E_BUSY_INPUT and no evidence recorded.
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.9, source: .human)
        ])
        let (core, _) = makeCore(channel: channel, guard: source)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertThrowsError(
            try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        ) { error in
            guard let gpError = error as? GPError else {
                return XCTFail("expected GPError, got \(error)")
            }
            XCTAssertEqual(gpError.code, .busyInput)
            XCTAssertTrue(gpError.remedy.contains("\"degrade\": true"),
                "the remedy must point at the parameter that actually exists")
        }
        XCTAssertThrowsError(try core.lastEvidence(operationId: nil))
    }

    // MARK: - Dispatcher parameter routing

    private func makeDispatcher() -> (ScriptedChannel, Dispatcher) {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        return (channel, Dispatcher(core: EngineCore(channel: channel, settle: {})))
    }

    private func perform(_ dispatcher: Dispatcher, _ json: String) throws -> [String: Any] {
        let response = dispatcher.handle(.frame(Data(json.utf8)))
        let object = try JSONSerialization.jsonObject(with: response, options: [])
        return try XCTUnwrap(object as? [String: Any])
    }

    func testDispatcherAcceptsDegradeBoolean() throws {
        let (_, dispatcher) = makeDispatcher()
        _ = try perform(dispatcher, "{\"id\":1,\"method\":\"attach\",\"params\":{\"bundleId\":\"com.example.app\"}}")
        let response = try perform(dispatcher,
            "{\"id\":2,\"method\":\"act\",\"params\":{\"selector\":{\"role\":\"AXButton\",\"title\":\"Submit\"},\"action\":\"press\",\"degrade\":true}}"
        )
        let result = try XCTUnwrap(response["result"] as? [String: Any])
        XCTAssertEqual(result["actConfirmed"] as? Bool, true)
    }

    func testDispatcherRejectsNonBooleanDegrade() throws {
        let (_, dispatcher) = makeDispatcher()
        _ = try perform(dispatcher, "{\"id\":1,\"method\":\"attach\",\"params\":{\"bundleId\":\"com.example.app\"}}")
        let response = try perform(dispatcher,
            "{\"id\":2,\"method\":\"act\",\"params\":{\"selector\":{\"role\":\"AXButton\",\"title\":\"Submit\"},\"action\":\"press\",\"degrade\":\"yes\"}}"
        )
        let error = try XCTUnwrap(response["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "GP_E_BAD_PARAMS")
    }
}
