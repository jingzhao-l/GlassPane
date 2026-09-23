import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// A1/A5: the complete act pipeline and evidence lifecycle against a
/// scripted channel — the walking-skeleton loop without GUI permission.
final class EngineCoreTests: XCTestCase {

    private var channel: ScriptedChannel!
    private var core: EngineCore!

    override func setUp() {
        super.setUp()
        channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        core = EngineCore(channel: channel, settle: {})
    }

    private func attach() throws {
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
    }

    private var submitSelector: Selector {
        Selector(role: "AXButton", title: "Submit")
    }

    // MARK: - hello / attach

    func testHelloShape() {
        let result = core.hello()
        XCTAssertEqual(result["engine"] as? String, "glasspaned")
        XCTAssertEqual(result["protocolVersion"] as? String, "0")
        XCTAssertNotNil(result["pid"] as? Int)
        XCTAssertEqual(
            result["capabilities"] as? [String],
            ["act", "observe", "assert_element", "diagnose", "snapshot", "restore", "probe"]
        )
    }

    func testAttachIsIdempotentForSameAppAndKeepsHistory() throws {
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertNoThrow(try core.act(selector: submitSelector, action: .press))
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        // Same app: history survives the re-attach.
        XCTAssertNoThrow(try core.lastEvidence(operationId: nil))
        XCTAssertEqual(channel.attachCallCount, 3)
    }

    func testAttachingDifferentAppResetsHistory() throws {
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertNoThrow(try core.act(selector: submitSelector, action: .press))
        channel.app = AttachedApp(pid: 9999, bundleId: "com.other.app", appName: "Other")
        _ = try core.attach(bundleId: "com.other.app", pid: nil)
        XCTAssertThrowsGPError(.noEvidence) {
            try core.lastEvidence(operationId: nil)
        }
    }

    // MARK: - act: happy path

    func testActHappyPathProducesCompleteEvidence() throws {
        try attach()
        channel.treeResults = [
            .success(TestTrees.standard),
            .success(TestTrees.buttonRetitled),
        ]
        channel.captureResults = [
            .success(TestImages.solid(100)),
            .success(TestImages.quadrantChanged(base: 100, delta: 120)),
        ]
        let result = try core.act(selector: submitSelector, action: .press)

        XCTAssertEqual(result["actConfirmed"] as? Bool, true)
        XCTAssertEqual(result["axChanged"] as? Bool, true)
        XCTAssertEqual(result["pixelChanged"] as? Bool, true)
        let operationId = try XCTUnwrap(result["operationId"] as? String)
        XCTAssertTrue(operationId.hasPrefix("op_"))

        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.operationId, operationId)
        XCTAssertEqual(pack.attribution.level, .soft)
        XCTAssertEqual(pack.attribution.contaminated, false)
        XCTAssertEqual(pack.circuitBreaker.level, .normal)
        XCTAssertEqual(pack.signals.act.actConfirmed, true)
        XCTAssertEqual(pack.signals.axEvent?.axChanged, true)
        XCTAssertEqual(pack.signals.pixelDiff?.changedPixelRatio ?? 0, 0.25, accuracy: 1e-9)
        XCTAssertEqual(pack.signals.crash, CrashSignal(processAliveBefore: true, processAliveAfter: true))
    }

    // MARK: - act: failure paths

    func testActBeforeAttachThrowsNotAttached() {
        XCTAssertThrowsGPError(.notAttached) {
            try core.act(selector: submitSelector, action: .press)
        }
    }

    func testActRejectionIsRecordedAsEvidence() throws {
        try attach()
        channel.actionError = .actRejected(reason: "element does not support action")
        XCTAssertThrowsGPError(.actFailed) {
            try core.act(selector: submitSelector, action: .press)
        }
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.signals.act.actConfirmed, false)
        XCTAssertEqual(pack.circuitBreaker.level, .actFailedChannelAlive)
        XCTAssertNotNil(pack.circuitBreaker.reason)
    }

    /// 操作前就已不在场的进程**不能**判 T1（"崩在本次操作里"是没发生过的断言）。
    /// 此前这条用例正是按那个错误口径写的，现在钉住两个方向。
    func testAlreadyDeadProcessIsNotClaimedAsCrashDuringOperation() throws {
        try attach()
        channel.alive = false
        XCTAssertThrowsGPError(.actFailed) {
            try core.act(selector: submitSelector, action: .press)
        }
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.signals.crash?.processAliveBefore, false)
        XCTAssertEqual(pack.signals.crash?.processAliveAfter, false)
        let (diagnosisClass, _) = Classifier.classify(pack)
        XCTAssertNotEqual(diagnosisClass, .t1, "进程没启动不能被说成崩在我们的操作里")
    }

    func testProcessExitingDuringOperationRecordsT1() throws {
        try attach()
        // 存活序列 [true, false]：操作前在场、操作后没了。act 本身不必失败，
        // T1 断言的是"退出发生在本次操作窗口内"这一归因。
        channel.aliveSequence = [true, false]
        _ = try core.act(selector: submitSelector, action: .press)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.signals.crash?.processAliveBefore, true)
        XCTAssertEqual(pack.signals.crash?.processAliveAfter, false)
        let (diagnosisClass, report) = Classifier.classify(pack)
        XCTAssertEqual(diagnosisClass, .t1)
        XCTAssertTrue(report.anomaly.contains("exited during the operation"))
    }

    func testUnresponsiveAppRecordsT2Evidence() throws {
        try attach()
        channel.pingResult = .failure(.pingTimeout)
        XCTAssertThrowsGPError(.actFailed) {
            try core.act(selector: submitSelector, action: .press)
        }
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.signals.responsiveness?.responsive, false)
        let (diagnosisClass, _) = Classifier.classify(pack)
        XCTAssertEqual(diagnosisClass, .t2)
    }

    func testAxUnavailablePropagatesAsChannelError() throws {
        try attach()
        channel.treeResults = [
            .failure(.axUnavailable(reason: "permission lost")),
            .failure(.axUnavailable(reason: "permission lost")),
        ]
        XCTAssertThrowsGPError(.axUnavailable) {
            try core.act(selector: submitSelector, action: .press)
        }
    }

    func testPixelCaptureDeniedDegradesButlerBreaker() throws {
        try attach()
        channel.treeResults = [
            .success(TestTrees.standard),
            .success(TestTrees.buttonRetitled),
        ]
        channel.captureResults = [
            .failure(.pixelCaptureDenied(reason: "screen recording denied")),
            .failure(.pixelCaptureDenied(reason: "screen recording denied")),
        ]
        let result = try core.act(selector: submitSelector, action: .press)
        XCTAssertEqual(result["actConfirmed"] as? Bool, true)

        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.circuitBreaker.level, .degraded)
        XCTAssertEqual(pack.circuitBreaker.reason, "screen-recording-denied")
        XCTAssertNil(pack.signals.pixelDiff)
        // Tree changed + pixel signal unavailable => T6 undecidable (§9).
        let (diagnosisClass, _) = Classifier.classify(pack)
        XCTAssertEqual(diagnosisClass, .inconclusive)
    }

    // MARK: - observe

    func testObserveReturnsTreeAndDigest() throws {
        try attach()
        let result = try core.observe(maxDepth: 6, role: nil)
        XCTAssertEqual(result["nodeCount"] as? Int, 4)
        XCTAssertEqual((result["digest"] as? String)?.count, TreeDigest.digestHexLength)
        let tree = try XCTUnwrap(result["axTree"] as? [[String: Any]])
        XCTAssertEqual(tree.count, 1)
        XCTAssertEqual(tree[0]["role"] as? String, "AXWindow")
    }

    func testObserveRoleFilterPrunesToMatchingSubtrees() throws {
        try attach()
        let result = try core.observe(maxDepth: 6, role: "AXButton")
        XCTAssertEqual(result["nodeCount"] as? Int, 1)
        let tree = try XCTUnwrap(result["axTree"] as? [[String: Any]])
        XCTAssertEqual(tree[0]["role"] as? String, "AXButton")
        XCTAssertEqual(tree[0]["title"] as? String, "Submit")
    }

    func testObserveBeforeAttachThrowsNotAttached() {
        XCTAssertThrowsGPError(.notAttached) {
            try core.observe(maxDepth: 6, role: nil)
        }
    }

    // MARK: - assert_element

    func testAssertReusesLatestActSignalContext() throws {
        try attach()
        channel.treeResults = [
            .success(TestTrees.standard),
            .success(TestTrees.buttonRetitled),
        ]
        channel.captureResults = [
            .success(TestImages.solid(100)),
            .success(TestImages.quadrantChanged(base: 100, delta: 120)),
        ]
        _ = try core.act(selector: submitSelector, action: .press)
        let actPack = try core.lastEvidence(operationId: nil)

        channel.propertyResult = .success(.bool(true))
        let result = try core.assertElement(
            selector: submitSelector, property: .enabled, expected: .bool(true)
        )
        XCTAssertEqual(result["passed"] as? Bool, true)
        XCTAssertEqual(result["actual"] as? Bool, true)

        let assertPack = try core.lastEvidence(operationId: result["operationId"] as? String)
        XCTAssertEqual(assertPack.signals, actPack.signals)
        XCTAssertEqual(assertPack.attribution, actPack.attribution)
        XCTAssertNotNil(assertPack.assertion)
        XCTAssertEqual(assertPack.assertion?.passed, true)
    }

    func testAssertWithoutPriorOperationThrowsNoOperation() throws {
        try attach()
        XCTAssertThrowsGPError(.noOperation) {
            _ = try core.assertElement(selector: submitSelector, property: .title, expected: .string("X"))
        }
    }

    func testAssertTargetNotFoundMapsToError() throws {
        try attach()
        _ = try core.act(selector: submitSelector, action: .press)
        channel.propertyResult = .failure(.assertTargetNotFound)
        XCTAssertThrowsGPError(.assertTargetNotFound) {
            _ = try core.assertElement(selector: submitSelector, property: .title, expected: .string("X"))
        }
    }

    // MARK: - diagnose

    func testDiagnoseLatestOperationUpdatesPackInPlace() throws {
        try attach()
        _ = try core.act(selector: submitSelector, action: .press)
        let result = try core.diagnose(operationId: nil)
        XCTAssertEqual(result["class"] as? String, "T3")
        let report = try XCTUnwrap(result["report"] as? [String: Any])
        XCTAssertEqual(report.count, 4)

        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.diagnosis?.class, .t3)
    }

    func testDiagnoseUnknownOperationIdThrows() throws {
        try attach()
        _ = try core.act(selector: submitSelector, action: .press)
        XCTAssertThrowsGPError(.noOperation) {
            _ = try core.diagnose(operationId: "op_0123456789ABCDEFGHJKMNPQRS")
        }
    }

    // MARK: - history bounds

    func testHistoryIsBoundedAndEvictsOldest() throws {
        try attach()
        var firstOperationId = ""
        for index in 0..<(EngineCore.historyLimit + 6) {
            _ = try core.act(selector: submitSelector, action: .press)
            if index == 0 {
                firstOperationId = try core.lastEvidence(operationId: nil).operationId
            }
        }
        XCTAssertNoThrow(try core.lastEvidence(operationId: nil))
        XCTAssertThrowsGPError(.noEvidence) {
            _ = try core.lastEvidence(operationId: firstOperationId)
        }
    }

    func testShutdownIsIdempotent() {
        let result = core.shutdown()
        XCTAssertEqual(result["bye"] as? Bool, true)
        XCTAssertTrue(core.shutdownRequested)
    }
}

// MARK: - GPError assertion helper

extension XCTestCase {
    func XCTAssertThrowsGPError(
        _ code: GPErrorCode,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: () throws -> Void
    ) {
        do {
            _ = try body()
            XCTFail("expected GPError \(code.rawValue)", file: file, line: line)
        } catch let error as GPError {
            XCTAssertEqual(error.code, code, file: file, line: line)
        } catch {
            XCTFail("expected GPError \(code.rawValue), got \(error)", file: file, line: line)
        }
    }
}
