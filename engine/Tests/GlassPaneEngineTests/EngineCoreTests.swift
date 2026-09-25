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
            ["act", "observe", "assert_element", "audit_ui", "capture_view", "diagnose", "snapshot", "restore", "probe"]
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
        // Deliberately changed by X-6 (was `== "screen-recording-denied"`): the
        // blanket label is what mis-diagnosed every pixel failure, so the
        // breaker now carries the channel's own reason after the class token.
        // This is the permission case, where that token still holds.
        XCTAssertEqual(
            pack.circuitBreaker.reason,
            "screen-recording-denied: screen recording denied"
        )
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

// MARK: - Round-1 engine data-plane fixes

/// Pins the round-1 fixes on the observe→act→attribute loop (R1-01/03/04/05/
/// 06/07/09 plus the ledger-label half of R5-08): no unmeasured conclusion may
/// be reported, and no rejected call may leave the channel pointed somewhere
/// the caller never approved. Built on the helpers in TestSupport.swift.
final class EngineCoreRound1Tests: XCTestCase {

    private var cleanupPaths: [String] = []

    override func tearDown() {
        for path in cleanupPaths {
            try? FileManager.default.removeItem(atPath: path)
        }
        cleanupPaths.removeAll()
        super.tearDown()
    }

    private func makeChannel() -> ScriptedChannel {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        return channel
    }

    private var submitSelector: Selector {
        Selector(role: "AXButton", title: "Submit")
    }

    /// C-05: this used to compose its own path from `NSTemporaryDirectory()`,
    /// which the runtime half of the isolation gate never saw. Everything a
    /// state object is built on now comes from `TestSandbox`, whose paths are
    /// asserted isolated before they are handed out.
    private func tempDirectory(_ prefix: String) -> String {
        TestSandbox.directory(prefix)
    }

    private func tempRegistry() -> ProjectRegistry {
        TestSandbox.projectRegistry("r1")
    }

    // MARK: - R1-01: attach() is atomic

    func testRejectedProjectIdNeverRebindsTheChannel() throws {
        let channel = makeChannel()
        let registry = tempRegistry()
        let core = EngineCore(channel: channel, settle: {}, projectRegistry: registry)
        // An app the user believes is untouched.
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertEqual(channel.attachCallCount, 1)
        let entry = try registry.create(displayName: "Other", bundleId: "com.other.app")

        XCTAssertThrowsGPError(.badParams) {
            _ = try core.attach(bundleId: "com.example.app", pid: nil, projectId: entry.projectId)
        }
        XCTAssertEqual(
            channel.attachCallCount, 1,
            "the projectId is resolved before channel.attach: a rejected attach must not rebind the AX target"
        )
        XCTAssertEqual(core.attachedApp?.bundleId, "com.example.app")
        XCTAssertNil(core.activeProjectId)
        // The next act therefore still goes to the app the engine claims.
        XCTAssertNoThrow(try core.act(selector: submitSelector, action: .press))
    }

    func testUnknownProjectIdThrowsBeforeTheChannelIsTouched() throws {
        let channel = makeChannel()
        let core = EngineCore(
            channel: channel, settle: {}, projectRegistry: tempRegistry()
        )
        XCTAssertThrowsGPError(.notFound) {
            _ = try core.attach(bundleId: "com.example.app", pid: nil, projectId: "prj_NONEXISTENT")
        }
        XCTAssertEqual(channel.attachCallCount, 0)
        XCTAssertNil(core.attachedApp)
    }

    func testProjectMismatchOnTheResolvedAppRollsTheChannelBack() throws {
        let channel = makeChannel()
        let registry = tempRegistry()
        let entry = try registry.create(displayName: "Target", bundleId: "com.example.app")
        let core = EngineCore(channel: channel, settle: {}, projectRegistry: registry)
        _ = try core.attach(bundleId: "com.example.app", pid: nil, projectId: entry.projectId)
        XCTAssertEqual(core.activeProjectId, entry.projectId)
        XCTAssertEqual(channel.attachCallCount, 1)

        // Attaching by pid hides the bundleId conflict from the pre-flight; the
        // channel resolves a different app, so the post-flight must reject it
        // *and* undo the rebind. ScriptedChannel always returns its current app,
        // so the rollback is pinned through the call count.
        channel.app = AttachedApp(pid: 777, bundleId: "com.unrelated.app", appName: "Unrelated")
        XCTAssertThrowsGPError(.badParams) {
            _ = try core.attach(bundleId: nil, pid: 777, projectId: entry.projectId)
        }
        XCTAssertEqual(
            channel.attachCallCount, 3,
            "rejected attach (2) + channel rolled back to the previously attached app (3)"
        )
        XCTAssertEqual(core.attachedApp?.bundleId, "com.example.app")
        XCTAssertEqual(core.activeProjectId, entry.projectId, "a rejected attach commits nothing")
    }

    // MARK: - R1-03: an unmeasured post-action tree is absence, not false

    func testUnmeasuredTreeCaptureNeverBecomesAnAxChangedVerdict() throws {
        // (a) the post-action capture fails; (b) the pre-action one does.
        let failingAfter = makeChannel()
        let core = EngineCore(channel: failingAfter, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        failingAfter.treeResults = [
            .success(TestTrees.standard),
            .failure(.treeCaptureFailed(reason: "subtree exceeded the capture budget")),
        ]
        let result = try core.act(selector: submitSelector, action: .press)
        XCTAssertNil(
            result["axChanged"],
            "a failed post-action capture must not be reported as axChanged=false"
        )
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertNil(pack.signals.axEvent, "absence is the encoding the frozen schema allows")
        XCTAssertEqual(pack.circuitBreaker.level, .degraded)
        XCTAssertTrue(
            pack.circuitBreaker.reason?.hasPrefix("ax-after-capture-failed") == true,
            "the breaker must name the missing capture; got \(pack.circuitBreaker.reason ?? "nil")"
        )
        // The pack stays schema-valid, and diagnosis refuses instead of calling
        // the unmeasured window a dead click (T3).
        XCTAssertNotNil(try EvidencePack.decodeAndValidate(pack.jsonData()))
        XCTAssertEqual(Classifier.classify(pack).0, .inconclusive)
        // The pixel channel really did measure: its verdict stays present.
        XCTAssertEqual(result["pixelChanged"] as? Bool, false)

        let failingBefore = makeChannel()
        let beforeCore = EngineCore(channel: failingBefore, settle: {})
        _ = try beforeCore.attach(bundleId: "com.example.app", pid: nil)
        failingBefore.treeResults = [
            .failure(.treeCaptureFailed(reason: "root children timed out"))
        ]
        let beforeResult = try beforeCore.act(selector: submitSelector, action: .press)
        XCTAssertNil(beforeResult["axChanged"])
        let beforePack = try beforeCore.lastEvidence(operationId: nil)
        XCTAssertEqual(beforePack.circuitBreaker.level, .degraded)
        XCTAssertEqual(beforePack.circuitBreaker.reason, "ax-tree-capture-failed")
    }

    // MARK: - R1-04: every channel fault maps to its own code

    func testPingMapsEveryChannelFaultOntoItsOwnCode() throws {
        let channel = makeChannel()
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        // A revoked Accessibility seat: the protocol code and its executable
        // remedy must arrive, not the GP_E_INTERNAL "check the daemon log".
        channel.pingResult = .failure(.axUnavailable(reason: "AX API is disabled"))
        do {
            _ = try core.act(selector: submitSelector, action: .press)
            XCTFail("expected the AX fault to surface as a structured error")
        } catch let error as GPError {
            XCTAssertEqual(error.code, .axUnavailable)
            XCTAssertEqual(error.message, "AX API is disabled")
            XCTAssertNotEqual(error.remedy, GPError.remedy(for: .internalError))
        }
        // Residual (documented, not fixed here): this throw path still records
        // no evidence, so T0 stays unreachable for a pre-action channel fault.
        XCTAssertThrowsGPError(.noEvidence) {
            _ = try core.lastEvidence(operationId: nil)
        }
        // Any other ChannelError maps too; pingTimeout keeps its priority and
        // stays a hang verdict instead of an error.
        channel.pingResult = .failure(.appNotFound)
        XCTAssertThrowsGPError(.appNotFound) {
            _ = try core.act(selector: submitSelector, action: .press)
        }
        channel.pingResult = .failure(.pingTimeout)
        XCTAssertThrowsGPError(.actFailed) {
            _ = try core.act(selector: submitSelector, action: .press)
        }
    }

    // MARK: - R1-05: the ffwd wrapper must not destroy the inner error

    func testFfwdStepFailureCarriesTheInnerErrorVerbatim() throws {
        let channel = makeChannel()
        let now = Date(timeIntervalSince1970: 1_000)
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.9, source: .human)
        ])
        let guard_ = AttributionGuard(
            inputSource: source, clock: { now }, idleWindowSeconds: 0.5
        )
        let core = EngineCore(channel: channel, settle: {}, attributionGuard: guard_)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let snapshotId = try XCTUnwrap(
            try core.snapshot(maxDepth: 6)["snapshotId"] as? String
        )
        do {
            _ = try core.restore(snapshotId: snapshotId, steps: [(submitSelector, .press)])
            XCTFail("expected the busy input window to block the roll-forward step")
        } catch let error as GPError {
            XCTAssertEqual(error.code, .restoreStepFailed, "the wrapped code stays frozen")
            XCTAssertTrue(
                error.message.contains("GP_E_BUSY_INPUT"),
                "the inner code must survive the wrap; got \(error.message)"
            )
            XCTAssertFalse(
                error.message.contains("couldn't be completed"),
                "localizedDescription used to destroy code/message/remedy"
            )
            XCTAssertTrue(
                error.remedy.contains("\"degrade\": true"),
                "the escape hatch promised by GP_E_BUSY_INPUT must reach the agent; got \(error.remedy)"
            )
        }
    }

    func testRestoreStepFailureWrapsNonGPErrorWithoutLosingIt() {
        let wrapped = EngineCore.restoreStepFailure(index: 1, inner: NSError(domain: "gp-test", code: 7))
        XCTAssertEqual(wrapped.code, .restoreStepFailed)
        XCTAssertTrue(wrapped.message.contains("ffwd step 1 failed"))
        XCTAssertTrue(
            wrapped.message.contains("Domain=gp-test"),
            "the underlying error still has to be identifiable; got \(wrapped.message)"
        )
    }

    // MARK: - R1-06: diagnose and last_evidence agree on existence

    func testDiagnoseResolvesWhatLastEvidenceResolves() throws {
        let dir = tempDirectory("gp-r1-archive")
        let writer = EngineCore(
            channel: makeChannel(), settle: {}, evidenceStore: TestSandbox.evidenceStore(at: dir)
        )
        _ = try writer.attach(bundleId: "com.example.app", pid: nil)
        let operationId = try XCTUnwrap(
            try writer.act(selector: submitSelector, action: .press)["operationId"] as? String
        )

        // Fresh daemon: same archive, empty in-memory ring.
        let reader = EngineCore(
            channel: makeChannel(), settle: {}, evidenceStore: TestSandbox.evidenceStore(at: dir)
        )
        _ = try reader.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertNoThrow(try reader.lastEvidence(operationId: operationId))
        let diagnosis = try reader.diagnose(operationId: operationId)
        XCTAssertNotNil(diagnosis["class"] as? String)
        XCTAssertEqual(
            try reader.lastEvidence(operationId: operationId).diagnosis?.class.rawValue,
            diagnosis["class"] as? String
        )
        // A genuinely unknown id keeps each method's own code.
        XCTAssertThrowsGPError(.noOperation) {
            _ = try reader.diagnose(operationId: "op_0123456789ABCDEFGHJKMNPQRS")
        }
        XCTAssertThrowsGPError(.noEvidence) {
            _ = try reader.lastEvidence(operationId: "op_0123456789ABCDEFGHJKMNPQRS")
        }
    }

    // MARK: - R1-07: a missing archive may not impersonate an audit trail

    func testUnwritableArchiveIsSurfacedOnBothFaces() throws {
        // A directory that cannot be created (its parent is a regular file).
        let base = tempDirectory("gp-r1-fault") + "/parent-file"
        try "x".write(toFile: base, atomically: true, encoding: .utf8)
        let core = EngineCore(
            channel: makeChannel(), settle: {},
            evidenceStore: TestSandbox.evidenceStore(at: base + "/child")
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.act(selector: submitSelector, action: .press)
        let operationId = try XCTUnwrap(result["operationId"] as? String)
        XCTAssertEqual(
            result["evidencePersisted"] as? Bool, false,
            "an evidenceId without an archive has to say so at the moment it is handed out"
        )
        XCTAssertEqual(core.lastEvidencePersistenceFailure?.operationId, operationId)
        let failure = try XCTUnwrap(core.hello()["evidencePersistenceError"] as? [String: Any])
        XCTAssertEqual(failure["operationId"] as? String, operationId)
        XCTAssertEqual(failure["directory"] as? String, base + "/child")
        XCTAssertNotNil(failure["remedy"] as? String)
        // In-memory evidence keeps working (the write stays non-throwing by spec).
        XCTAssertNoThrow(try core.lastEvidence(operationId: operationId))
    }

    func testSuccessfulAndUnconfiguredArchiveReportTheirOwnVerdicts() throws {
        let core = EngineCore(
            channel: makeChannel(), settle: {},
            evidenceStore: TestSandbox.evidenceStore(at: tempDirectory("gp-r1-ok"))
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.act(selector: submitSelector, action: .press)
        XCTAssertEqual(result["evidencePersisted"] as? Bool, true)
        XCTAssertNil(core.lastEvidencePersistenceFailure)
        XCTAssertNil(core.hello()["evidencePersistenceError"])

        // No archive configured at all is a different fact from a failed write:
        // the verdict is absent, never defaulted to false.
        let memoryOnly = EngineCore(channel: makeChannel(), settle: {})
        _ = try memoryOnly.attach(bundleId: "com.example.app", pid: nil)
        let memoryResult = try memoryOnly.act(selector: submitSelector, action: .press)
        XCTAssertNil(memoryResult["evidencePersisted"])
        XCTAssertNil(memoryOnly.lastEvidencePersistenceFailure)
        XCTAssertNil(memoryOnly.hello()["evidencePersistenceError"])
    }

    // MARK: - R1-09: the measured contamination ships instead of being dropped

    func testContaminatedActShipsItsHumanEvents() throws {
        let channel = makeChannel()
        let now = Date(timeIntervalSince1970: 1_000)
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.9, source: .human)
        ])
        let guard_ = AttributionGuard(
            inputSource: source, clock: { now }, idleWindowSeconds: 0.5
        )
        let core = EngineCore(channel: channel, settle: {}, attributionGuard: guard_)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.act(selector: submitSelector, action: .press, degrade: true)

        XCTAssertEqual(result["humanInputEventCount"] as? Int, 1)
        let events = try XCTUnwrap(result["humanInputEvents"] as? [[String: Any]])
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0]["source"] as? String, "human")
        XCTAssertEqual(events[0]["timestamp"] as? Double, 999.9)
        XCTAssertEqual(core.lastContamination?.events.count, 1)
        let contamination = try XCTUnwrap(core.hello()["contamination"] as? [String: Any])
        XCTAssertEqual(contamination["count"] as? Int, 1)
        XCTAssertEqual(contamination["operationId"] as? String, result["operationId"] as? String)

        // A quiet window afterwards reports nothing instead of a stale record.
        let quiet = try core.act(selector: submitSelector, action: .press)
        XCTAssertNil(quiet["humanInputEvents"])
        XCTAssertNil(core.lastContamination)
        XCTAssertNil(core.hello()["contamination"])
    }

    func testHumanEventsWireKeepsTheCountHonestWhenTheSampleIsCapped() {
        let events = (0..<(EngineCore.humanEventWireLimit + 5)).map {
            InputEvent(timestamp: Double($0), source: .human)
        }
        let wired = EngineCore.humanEventsWire(events)
        XCTAssertEqual(wired.count, EngineCore.humanEventWireLimit)
        XCTAssertEqual(events.count, EngineCore.humanEventWireLimit + 5)
    }

    // MARK: - R5-08 (ledger half): the audit label is the daemon's, not the caller's

    func testRestoreLedgerReasonIsDerivedByTheDaemonNotTheCaller() throws {
        XCTAssertEqual(EngineCore.approvalLedgerLabel(mode: nil, hasSteps: true), "ffwd")
        XCTAssertEqual(EngineCore.approvalLedgerLabel(mode: nil, hasSteps: false), "compare")
        XCTAssertEqual(EngineCore.approvalLedgerLabel(mode: "rollback_full", hasSteps: false), "rollback_full")
        XCTAssertEqual(EngineCore.approvalLedgerLabel(mode: "restore_snapshot", hasSteps: false), "restore_snapshot")
        // A recognised mode still names the form that actually executed.
        XCTAssertEqual(EngineCore.approvalLedgerLabel(mode: "ffwd", hasSteps: false), "compare")
        XCTAssertEqual(EngineCore.approvalLedgerLabel(mode: "compare", hasSteps: true), "ffwd")
        // Anything else is recorded as rejected; the raw value never becomes prose.
        let forged = "human-approved 2026-09-22 14:03 by ethan"
        let label = EngineCore.approvalLedgerLabel(mode: forged, hasSteps: false)
        XCTAssertFalse(label.contains("human-approved"), "agent text must not enter the hash chain")
        XCTAssertTrue(label.contains("unrecognised-mode-rejected"), "got \(label)")
        XCTAssertTrue(label.count < ApprovalGate.reasonMaxLength)

        let gate = ApprovalGate()
        let core = EngineCore(channel: makeChannel(), settle: {}, approvalGate: gate)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let snapshotId = try XCTUnwrap(
            try core.snapshot(maxDepth: 6)["snapshotId"] as? String
        )
        _ = try core.restore(
            snapshotId: snapshotId, steps: nil, mode: "human-approved 2026-09-22"
        )
        XCTAssertEqual(gate.count, 1)
        let reason = try XCTUnwrap(gate.chain().first?.reason)
        XCTAssertTrue(reason.hasPrefix("restore executed:"), "existing ledger contract unchanged")
        XCTAssertFalse(
            reason.contains("human-approved"),
            "the hash-chained record must not carry agent-authored audit prose; got \(reason)"
        )
        XCTAssertTrue(reason.contains("compare executed"), "got \(reason)")
    }
}

// MARK: - Round-1 wave-3: diagnosis mapping, probe delivery, registry posture

/// Pins this batch's five items against the shipped implementation: the pixel
/// channel's real reason (X-6), the "could not read" vs "does not exist" split
/// plus the act-rejection remedies (X-9), `sendCommand`'s delivery result
/// (X-11), the delivery/refusal wording and the disconnection count (X-13), the
/// daemon-side archive-path belt for legacy registry entries, and the corrupt
/// registry that must never be overwritten (B-1 daemon half).
final class EngineCoreWaveThreeMappingTests: XCTestCase {

    private var cleanupPaths: [String] = []

    override func tearDown() {
        for path in cleanupPaths {
            try? FileManager.default.removeItem(atPath: path)
        }
        cleanupPaths.removeAll()
        super.tearDown()
    }

    private func makeChannel() -> ScriptedChannel {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        return channel
    }

    private var submitSelector: Selector {
        Selector(role: "AXButton", title: "Submit")
    }

    private func tempDirectory(_ prefix: String) -> String {
        TestSandbox.directory(prefix)
    }

    private func tempRegistryPath() -> String {
        TestSandbox.filePath("w3-registry")
    }

    private func hello(capabilities: [String]) -> ProbeHello {
        ProbeHello(
            pid: 4242, bundleId: "com.example.app", appName: "Example",
            probeVersion: "gp-probe/0.1.0", capabilities: capabilities
        )
    }

    // MARK: - X-6: the pixel channel's reason, not one blanket label

    func testCaptureTimeoutIsNotReportedAsADeniedScreenRecordingSeat() throws {
        let channel = makeChannel()
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        channel.treeResults = [
            .success(TestTrees.standard),
            .success(TestTrees.buttonRetitled),
        ]
        channel.captureResults = [
            .failure(.pixelCaptureDenied(
                reason: "SCStream start timed out after 5.0s (not measured; the cancelled task may still be running)"
            )),
        ]
        _ = try core.act(selector: submitSelector, action: .press)
        let pack = try core.lastEvidence(operationId: nil)
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertEqual(
            reason,
            "pixel-capture-timeout: SCStream start timed out after 5.0s (not measured; the cancelled task may still be running)"
        )
        XCTAssertFalse(reason.contains("screen-recording-denied"), "a timeout must not send the agent to re-grant the seat")
    }

    func testEveryPixelCauseKeepsItsOwnTokenAndAdvice() {
        // The three SCKCapturer outcomes that used to collapse into one label.
        XCTAssertEqual(
            EngineCore.pixelCaptureFailureLabel(reason: "no on-screen SCWindow owned by pid 4242"),
            "pixel-capture-no-onscreen-window"
        )
        XCTAssertEqual(
            EngineCore.pixelCaptureFailureLabel(
                reason: "no SCDisplay intersects pid 42's window 7 frame 100.0x100.0@(0.0,0.0) among 1 display(s)"
            ),
            "pixel-capture-window-outside-display"
        )
        XCTAssertEqual(
            EngineCore.pixelCaptureFailureLabel(reason: "screen recording permission not granted"),
            "screen-recording-denied"
        )
        // An unknown reason stays unknown instead of being guessed as the seat.
        XCTAssertEqual(EngineCore.pixelCaptureFailureLabel(reason: "stream stopped"), "pixel-capture-failed")

        let permission = EngineCore.map(.pixelCaptureDenied(reason: "screen recording permission not granted"))
        XCTAssertTrue(permission.remedy.contains("System Settings > Privacy & Security > Screen Recording"))
        let noWindow = EngineCore.map(.pixelCaptureDenied(reason: "no on-screen SCWindow owned by pid 42"))
        XCTAssertTrue(noWindow.message.contains("pixel-capture-no-onscreen-window"), noWindow.message)
        XCTAssertTrue(noWindow.remedy.contains("unminimise"), noWindow.remedy)
        XCTAssertFalse(noWindow.remedy.hasPrefix("grant Screen Recording"), "the seat is not the cause here")
        XCTAssertTrue(noWindow.remedy.contains("INCONCLUSIVE"), "the degradation statement holds in every branch")
    }

    /// 窗口查找的键名写错那半年里，像素通路**永远**是"未测量"，所以这条判据从没被走到过：
    /// 前后两次截的不是同一个窗口时，跨窗口比出来的 0.x 不是"这次操作改变了界面"，
    /// 而是两个不同界面的差别——那会是一条看起来完全可信的假证据。
    func testWindowSwitchBetweenCapturesYieldsNoPixelClaim() throws {
        let channel = makeChannel()
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        channel.treeResults = [.success(TestTrees.standard), .success(TestTrees.buttonRetitled)]
        channel.captureResults = [
            .success(TestImages.solid(100)),
            .success(TestImages.quadrantChanged(base: 100, delta: 120)),
        ]
        channel.captureWindowIds = [12, 13]
        let result = try core.act(selector: submitSelector, action: .press)
        XCTAssertNil(result["pixelChanged"] as? Bool, "跨窗口的差值不能当成一次像素测量")
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertNil(pack.signals.pixelDiff)
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.contains("pixel-capture-window-changed"), reason)
        XCTAssertFalse(reason.contains("screen-recording-denied"), "换窗不是席位问题：\(reason)")
        XCTAssertEqual(pack.circuitBreaker.level, .degraded)

        // 对照组：同一次脚本、同样的两帧，只把窗口号改成一致，就必须给出数字。
        // 没有这条对照，上面的"没有测量"可能只是因为像素通路整个坏了。
        let control = makeChannel()
        let controlCore = EngineCore(channel: control, settle: {})
        _ = try controlCore.attach(bundleId: "com.example.app", pid: nil)
        control.treeResults = [.success(TestTrees.standard), .success(TestTrees.buttonRetitled)]
        control.captureResults = [
            .success(TestImages.solid(100)),
            .success(TestImages.quadrantChanged(base: 100, delta: 120)),
        ]
        control.captureWindowIds = [12, 12]
        let controlResult = try controlCore.act(selector: submitSelector, action: .press)
        XCTAssertEqual(controlResult["pixelChanged"] as? Bool, true)
        let controlPack = try controlCore.lastEvidence(operationId: nil)
        XCTAssertEqual(controlPack.signals.pixelDiff?.windowId, 12)
        XCTAssertEqual(controlPack.signals.pixelDiff?.changedPixelRatio ?? 0, 0.25, accuracy: 1e-9)
    }

    // MARK: - X-9: an unread attribute is never a verdict about the element

    func testAttributeReadFailureIsNotReportedAsAnAbsentElement() {
        let mapped = EngineCore.map(.attributeUnavailable(
            reason: "element's AXValue gave no value answer (answer is __NSCFBoolean, not text)"
        ))
        XCTAssertEqual(mapped.code, .axUnavailable, "the code table is frozen; only an existing code may carry this")
        XCTAssertNotEqual(mapped.code, .assertTargetNotFound)
        XCTAssertTrue(mapped.message.contains("NOT evidence that the element is missing"), mapped.message)
        XCTAssertTrue(mapped.message.contains("element's AXValue gave no value answer"))
        XCTAssertTrue(mapped.remedy.contains("gp_observe"), mapped.remedy)
        XCTAssertTrue(mapped.remedy.contains("--check-accessibility"), mapped.remedy)
        XCTAssertFalse(mapped.remedy.contains("--grant-accessibility"), "no phantom grant advice")
        XCTAssertEqual(
            EngineCore.map(.assertTargetNotFound).code, .assertTargetNotFound,
            "the distinction must not swallow the real negative"
        )
    }

    func testChannelFaultDuringActionStopsClaimingTheSelectorIsWrong() throws {
        let channel = makeChannel()
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        channel.actionError = .pingTimeout
        XCTAssertThrowsError(try core.act(selector: submitSelector, action: .press)) { error in
            // XCTAssertThrowsError's handler is non-throwing, so the cast is
            // checked here rather than with `try XCTUnwrap`.
            guard let gpError = error as? GPError else {
                return XCTFail("expected a GPError, got \(error)")
            }
            XCTAssertEqual(gpError.code, .actFailed, "the frozen code stays")
            // A-14 changed this wording on purpose: the old text quoted the one
            // per-call timeout (`2.0s`) and told the agent the search had
            // finished, and since R2-19 a `pingTimeout` is also what an aborted
            // mid-tree search reports, with the per-call budget shrunk towards
            // `AXChannel.minMessagingTimeoutSeconds`. The assertion now pins the
            // budget *range*, which is all the daemon is entitled to claim.
            XCTAssertTrue(
                gpError.message.contains("did not answer within its budget"), gpError.message
            )
            XCTAssertTrue(gpError.message.contains("0.1s"), gpError.message)
            XCTAssertTrue(gpError.message.contains("10.0s"), gpError.message)
            XCTAssertFalse(gpError.message.contains("within 2.0s"), gpError.message)
            XCTAssertNotEqual(gpError.remedy, GPError.remedy(for: .actFailed), "the default advice is wrong for a hang")
            XCTAssertTrue(gpError.remedy.contains("sample <pid>"), gpError.remedy)
            XCTAssertFalse(gpError.remedy.contains("the search finished"), gpError.remedy)
        }
        let rejectedPack = try core.lastEvidence(operationId: nil)
        let rejectedReason = try XCTUnwrap(rejectedPack.circuitBreaker.reason)
        XCTAssertTrue(rejectedReason.contains("action not performed"), rejectedReason)
        // An element that really did reject the action keeps the old words and
        // the old default remedy: only the two new causes gained advice.
        let quiet = makeChannel()
        let quietCore = EngineCore(channel: quiet, settle: {})
        _ = try quietCore.attach(bundleId: "com.example.app", pid: nil)
        quiet.actionError = .actRejected(reason: "element does not support action 'press'")
        XCTAssertThrowsError(try quietCore.act(selector: submitSelector, action: .press)) { error in
            // XCTAssertThrowsError's handler is non-throwing, so the cast is
            // checked here rather than with `try XCTUnwrap`.
            guard let gpError = error as? GPError else {
                return XCTFail("expected a GPError, got \(error)")
            }
            XCTAssertEqual(gpError.message, "action rejected: element does not support action 'press'")
            XCTAssertEqual(gpError.remedy, GPError.remedy(for: .actFailed))
        }
    }

    // MARK: - X-10: one definition of the AX timeout

    func testPingTimeoutIsDerivedFromTheChannelConstant() {
        XCTAssertEqual(EngineCore.pingTimeoutMs, AXChannel.messagingTimeoutSeconds * 1000)
        XCTAssertEqual(EngineCore.pingTimeoutMs, 2000, "the value is unchanged; only where it is defined moved")
    }

    // MARK: - X-11: a command that never left is not an empty observation

    private func probeCore(
        time: Box, sender: @escaping (Int32, Data) -> Bool
    ) -> (EngineCore, ProbeInbox) {
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1", "z2"]))
        inbox.sender = sender
        let core = EngineCore(
            channel: makeChannel(), clock: { time.now }, settle: {}, probeInbox: inbox
        )
        return (core, inbox)
    }

    func testUndeliveredProbeWindowNeverBecomesANoStateChangeVerdict() throws {
        let time = Box(Date(timeIntervalSince1970: 1_758_200_000))
        let (core, _) = probeCore(time: time) { _, _ in false } // socket gone: nothing leaves
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        _ = try core.act(selector: submitSelector, action: .press)

        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertNil(pack.signals.stateDiff, "the probe was never asked; `changed: false` is an unmeasured negative")
        XCTAssertNotNil(pack.signals.handlerProbe, "Z1 frames need no command, so a measured zero stays a measurement")
        XCTAssertEqual(pack.signals.handlerProbe?.hitCount, 0)
        XCTAssertEqual(pack.attribution.level, .soft, "no measured signal may upgrade attribution")
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.contains("probe-window-command-not-delivered"), reason)
        XCTAssertTrue(reason.contains("not delivered"), reason)
        XCTAssertFalse(reason.contains("refused"), "the probe never heard the request: \(reason)")
    }

    func testWhatTheProbeReallyReportedSurvivesAnUndeliveredCommand() throws {
        // The opt-in lane (P6 §8 H7): state frames that arrived are their own
        // measurement, and dropping them would erase a positive observation.
        let time = Box(Date(timeIntervalSince1970: 1_758_200_000))
        let (core, inbox) = probeCore(time: time) { _, _ in false }
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        inbox.ingest(pid: 4242, frame: .state(
            key: "model.count", before: "3", after: "4", source: "z2-mirror", ts: 0
        ))
        _ = try core.act(selector: submitSelector, action: .press)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.signals.stateDiff?.changed, true)
        XCTAssertEqual(pack.attribution.level, .strong)
    }

    func testDeliveredProbeWindowKeepsAnEmptyStateDiffAsAMeasurement() throws {
        let time = Box(Date(timeIntervalSince1970: 1_758_200_000))
        let (core, _) = probeCore(time: time) { _, _ in true }
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let operationId = try XCTUnwrap(
            try core.act(selector: submitSelector, action: .press)["operationId"] as? String
        )
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.signals.stateDiff?.changed, false, "asked and silent IS a measurement")
        XCTAssertNil(pack.circuitBreaker.reason, "nothing is unmeasured: got \(pack.circuitBreaker.reason ?? "nil")")
    }

    // MARK: - X-13: delivery vs refusal, and the disconnection count

    func testProbeStatusSurfacesTheRecordedDisconnections() throws {
        let inbox = ProbeInbox(now: { Date() })
        inbox.register(hello(capabilities: ["z1"]))
        inbox.disconnect(pid: 4242, reason: "connection closed")
        let core = EngineCore(
            channel: makeChannel(), settle: {}, probeInbox: inbox
        )
        let status = core.probeStatus()
        XCTAssertEqual(status["disconnections"] as? Int, 1)
        XCTAssertEqual(status["attachedHasProbe"] as? Bool, false)
        let rows = try XCTUnwrap(status["recentDisconnections"] as? [[String: Any]])
        XCTAssertEqual(rows.first?["disconnectReason"] as? String, "connection closed",
                       "A-10: a dropped probe is reported under its own key…")
        XCTAssertTrue(((status["probes"] as? [[String: Any]]) ?? []).isEmpty,
                      "…and never inside `probes`, whose meaning is \"live registrations\"")
    }

    func testProbeStatusOmitsTheCountWhenNoInboxIsWired() {
        let core = EngineCore(channel: makeChannel(), settle: {})
        XCTAssertNil(
            core.probeStatus()["disconnections"],
            "no probe inbox is the absence of the surface, not a measured zero"
        )
    }

    func testRollbackIsNotCalledAProbeRefusalWhenTheBytesNeverLeft() throws {
        let time = Box(Date(timeIntervalSince1970: 1_758_200_000))
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1", "checkpoint"]))
        let domains = ["counter": ["value": "3"]]
        inbox.sender = { pid, data in
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if object?["t"] as? String == "checkpoint_export" {
                let ref = object?["ref"] as? String ?? ""
                inbox.ingest(pid: pid, frame: .checkpoint(
                    ref: ref, domains: domains,
                    digest: ProbeWire.sha256Hex(ProbeWire.checkpointCanonical(domains)),
                    error: nil
                ))
            }
            return true
        }
        let core = EngineCore(
            channel: makeChannel(), clock: { time.now }, settle: {}, probeInbox: inbox
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let snapshotId = try XCTUnwrap(
            try core.snapshot(maxDepth: 4)["snapshotId"] as? String
        )

        inbox.sender = { _, _ in false } // the socket died between snapshot and restore
        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")) { error in
            // XCTAssertThrowsError's handler is non-throwing, so the cast is
            // checked here rather than with `try XCTUnwrap`.
            guard let gpError = error as? GPError else {
                return XCTFail("expected a GPError, got \(error)")
            }
            XCTAssertEqual(gpError.code, .restoreUnsupported, "frozen code")
            XCTAssertTrue(
                gpError.message.contains("never delivered to the probe"),
                gpError.message
            )
            XCTAssertFalse(
                gpError.message.contains("refused by probe"),
                "the probe never heard the request: \(gpError.message)"
            )
            XCTAssertTrue(gpError.remedy.contains("gp_probe_status"), gpError.remedy)
            XCTAssertTrue(gpError.remedy.contains("disconnections"), gpError.remedy)
        }
    }

    // MARK: - A-14 belt: a legacy registration cannot aim the archive anywhere

    func testStoredPathRulesMatchTheOnesTheShellEnforcesAtWriteTime() {
        XCTAssertNotNil(EngineCore.storedPathShapeDefect("relative/dir"))
        XCTAssertNotNil(EngineCore.storedPathShapeDefect("/Users/x/../elsewhere"))
        XCTAssertNotNil(EngineCore.storedPathShapeDefect("/Users/x/./evidence"))
        XCTAssertNil(EngineCore.storedPathShapeDefect("/Users/x/work/.glasspane/evidence"))

        let refused: [(String, String?)] = [
            ("/", "the filesystem root"),
            ("/private/tmp", "a world-writable shared scratch directory"),
            ("/usr", "the top-level directory /usr of the boot volume"),
            ("/Volumes/DataHD", "the root of a mounted volume"),
            ("/System/Library/Foo", "inside the system-owned tree /System"),
            ("/private/etc/evidence", "inside the system-owned tree /private/etc"),
            ("/Users/x", "the current user's home directory itself"),
            ("/Users/x/Library/Logs", "inside the current user's Library folder"),
        ]
        for (resolved, expected) in refused {
            XCTAssertEqual(
                EngineCore.resolvedStoragePathDefect(resolved: resolved, home: "/Users/x"),
                expected, "resolved \(resolved)"
            )
        }
        let accepted = [
            // The firmlink must not turn a real home path into a system tree…
            "/System/Volumes/Data/Users/x/work/app/.glasspane/evidence",
            // …and an injected temp archive (what `NSTemporaryDirectory()`
            // produces, i.e. every test in this target) must stay admissible.
            "/private/var/folders/zz/zy/T/gpb6-1",
            "/Users/x/work/notes-app/.glasspane/evidence",
        ]
        for resolved in accepted {
            XCTAssertNil(
                EngineCore.resolvedStoragePathDefect(resolved: resolved, home: "/Users/x"),
                "resolved \(resolved) must be admissible"
            )
        }
    }

    func testLegacyStoredPathIsRefusedAndNothingIsAdoptedOrDeleted() throws {
        let registry = ProjectRegistry(filePath: tempRegistryPath())
        // Registered straight through the store: exactly what an entry written
        // before the shell started validating paths looks like.
        let system = try registry.create(
            displayName: "Legacy", bundleId: "com.example.app",
            evidenceStoragePath: "/System/Library/Java"
        )
        let traversal = try registry.create(
            displayName: "Escape", bundleId: "com.example.app",
            evidenceStoragePath: "/Users/Shared/../../System/Everything"
        )
        let channel = makeChannel()
        let store = TestSandbox.evidenceStore(at: tempDirectory("gp-w3-archive"))
        let untouchedDirectory = store.directory
        let core = EngineCore(
            channel: channel, settle: {}, projectRegistry: registry, evidenceStore: store
        )
        XCTAssertThrowsGPError(.badParams) {
            _ = try core.attach(bundleId: "com.example.app", pid: nil, projectId: system.projectId)
        }
        XCTAssertEqual(channel.attachCallCount, 0, "the refusal must not rebind the AX target (R1-01)")
        XCTAssertEqual(store.directory, untouchedDirectory, "the refused path was never adopted")
        XCTAssertNil(core.activeProjectId)
        XCTAssertThrowsGPError(.badParams) {
            _ = try core.pruneEvidence(projectId: traversal.projectId, olderThanDays: 30)
        }
        // A refusal, not a silent substitution of the default directory.
        let refusal = try XCTUnwrap(EngineCore.evidenceStorageRefusal(projectId: system.projectId, entry: system))
        XCTAssertTrue(refusal.message.contains("/System/Library/Java"), refusal.message)
        XCTAssertTrue(refusal.remedy.contains("gp_project_set"), refusal.remedy)
        XCTAssertTrue(refusal.remedy.contains("launchctl kickstart"), refusal.remedy)
    }

    func testProjectWithoutItsOwnArchiveIsNotPrunedOutOfTheSharedOne() throws {
        let registry = ProjectRegistry(filePath: tempRegistryPath())
        let entry = try registry.create(displayName: "NoDir", bundleId: "com.example.app")
        let core = EngineCore(channel: makeChannel(), settle: {}, projectRegistry: registry)
        XCTAssertThrowsGPError(.badParams) {
            _ = try core.pruneEvidence(projectId: entry.projectId, olderThanDays: 30)
        }
    }

    // MARK: - B-1 (daemon half): a corrupt registry is never overwritten

    func testCreateRefusesToReplaceAnUnreadableRegistryAndTheFileSurvives() throws {
        let path = tempRegistryPath()
        let corrupt = #"[{"projectId":"prj_0123456789ABCDEFGHJKMNPQRS","displayName":"A","pid":12,"oops":}"#
        try corrupt.write(toFile: path, atomically: true, encoding: .utf8)
        let registry = ProjectRegistry(filePath: path)
        XCTAssertTrue(registry.loadFailed)
        XCTAssertEqual(registry.count, 0, "it loads empty — that is why the write must be refused")

        let core = EngineCore(channel: makeChannel(), settle: {}, projectRegistry: registry)
        XCTAssertThrowsGPError(.internalError) {
            _ = try core.projectSet(
                projectId: nil, displayName: "New", bundleId: "com.new", pid: nil,
                recipeConfigPath: nil, calibrationAssetsPath: nil, evidenceStoragePath: nil
            )
        }
        XCTAssertEqual(
            try String(contentsOfFile: path, encoding: .utf8), corrupt,
            "the damaged file stays intact and recoverable"
        )
        let list = try core.projectList()
        XCTAssertEqual(list["registryReadable"] as? Bool, false)
        XCTAssertNotNil(list["registryFailure"] as? String)
        let refusal = try XCTUnwrap(list["remedy"] as? String)
        XCTAssertTrue(refusal.contains("python3 -m json.tool"), refusal)
        XCTAssertTrue(refusal.contains(path), refusal)

        // Repair the file and the same call goes through: the guard is about
        // the damage, not a permanent lockout.
        try #"[{"projectId":"prj_0123456789ABCDEFGHJKMNPQRS"}]"#
            .write(toFile: path, atomically: true, encoding: .utf8)
        let stillBroken = ProjectRegistry(filePath: path)
        XCTAssertTrue(stillBroken.loadFailed, "an entry the daemon cannot decode is still a failed load")
        try "[]".write(toFile: path, atomically: true, encoding: .utf8)
        let clean = ProjectRegistry(filePath: path)
        XCTAssertFalse(clean.loadFailed)
        _ = try clean.create(displayName: "After repair", bundleId: "com.after")
        XCTAssertEqual(ProjectRegistry(filePath: path).count, 1)
    }

    func testAttachAndLookupRefuseAnUnreadableRegistryInsteadOfUnknownProject() throws {
        let path = tempRegistryPath()
        try "{ not json".write(toFile: path, atomically: true, encoding: .utf8)
        let registry = ProjectRegistry(filePath: path)
        let core = EngineCore(channel: makeChannel(), settle: {}, projectRegistry: registry)
        XCTAssertThrowsGPError(.internalError) {
            _ = try core.attach(bundleId: "com.example.app", pid: nil, projectId: "prj_0123456789ABCDEFGHJKMNPQRS")
        }
        XCTAssertThrowsGPError(.internalError) {
            _ = try core.projectGet(projectId: "prj_0123456789ABCDEFGHJKMNPQRS")
        }
        XCTAssertThrowsGPError(.internalError) {
            _ = try core.pruneEvidence(projectId: "prj_0123456789ABCDEFGHJKMNPQRS", olderThanDays: 1)
        }
        // An attach that never names a project is untouched by the damage.
        XCTAssertNoThrow(try core.attach(bundleId: "com.example.app", pid: nil))
    }

    func testWritesLeaveNoSharedTempNameBehind() throws {
        let path = tempRegistryPath()
        let registry = ProjectRegistry(filePath: path)
        _ = try registry.create(displayName: "One", bundleId: "com.one")
        _ = try registry.create(displayName: "Two", bundleId: "com.two")
        let first = try XCTUnwrap(registry.all.first { $0.displayName == "Two" })
        _ = try registry.update(projectId: first.projectId, displayName: "Dos")

        let base = (path as NSString).lastPathComponent
        let siblings = try FileManager.default.contentsOfDirectory(
            atPath: (path as NSString).deletingLastPathComponent
        )
        XCTAssertTrue(siblings.contains(base), "the registry file is of course there")
        XCTAssertFalse(
            siblings.contains { $0 != base && $0.hasPrefix(base) },
            "no fixed `.tmp` and no swap artifact may sit beside the file: \(siblings.filter { $0.hasPrefix(base) })"
        )
        XCTAssertEqual(ProjectRegistry(filePath: path).count, 2, "the disk holds what every caller was told")
    }
}

/// Mutable clock box shared by an inbox and the core built on it.
private final class Box {
    var now: Date
    init(_ now: Date) { self.now = now }
}

// MARK: - Round-2 wave-β: registry-less engine, shared archive validator, export reason

/// C-02/C-03 (no path-shaped default left for a test to fall into), A-07/C-06
/// (the half that deletes now uses the validator the adopting half already had),
/// A-01 (a checkpoint export that failed is not "no probe attached"), A-08 (the
/// archive agrees with the response about an unmeasured window) and A-14 (a
/// `pingTimeout` no longer reports a search it may never have finished).
final class EngineCoreWaveTwoBetaTests: XCTestCase {

    private func makeChannel() -> ScriptedChannel {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        return channel
    }

    private var submitSelector: Selector {
        Selector(role: "AXButton", title: "Submit")
    }

    private func hello(capabilities: [String]) -> ProbeHello {
        ProbeHello(
            pid: 4242, bundleId: "com.example.app", appName: "Example",
            probeVersion: "gp-probe/0.1.0", capabilities: capabilities
        )
    }

    /// The daemon's own sources are executable targets, so the contract on the
    /// CLI half is checked the way `HumanInterventionAuditTests` checks it: the
    /// source text is the shipped shape (`main.swift:481` region).
    private func repoSource(_ relativePath: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests/GlassPaneEngineTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // engine
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - C-03: `nil` is "no registry", never "the developer's file"

    func testEngineWithoutARegistryRefusesLookupsInsteadOfOpeningTheProjectsFile() throws {
        let channel = makeChannel()
        let core = EngineCore(channel: channel, settle: {})
        XCTAssertNil(core.projectRegistry, "the initializer creates no registry of its own")

        do {
            _ = try core.attach(
                bundleId: "com.example.app", pid: nil, projectId: "prj_0123456789ABCDEFGHJKMNPQRS"
            )
            return XCTFail("a registry-less engine must refuse, not answer \"unknown project\"")
        } catch let error as GPError {
            XCTAssertEqual(error.code, .internalError, "the honest code, unchanged vocabulary")
            XCTAssertTrue(
                error.message.contains("no project registry is configured"), error.message
            )
            XCTAssertFalse(
                error.message.contains("unknown projectId"),
                "\"not registered\" is a verdict this engine never measured; got \(error.message)"
            )
        }
        XCTAssertEqual(channel.attachCallCount, 0, "the refusal happens before any rebind (R1-01)")
        XCTAssertNil(core.activeProjectId)

        XCTAssertThrowsGPError(.internalError) {
            _ = try core.projectGet(projectId: "prj_0123456789ABCDEFGHJKMNPQRS")
        }
        XCTAssertThrowsGPError(.internalError) {
            _ = try core.pruneEvidence(projectId: "prj_0123456789ABCDEFGHJKMNPQRS", olderThanDays: 30)
        }
        XCTAssertThrowsGPError(.internalError) {
            _ = try core.projectSet(
                projectId: nil, displayName: "Would-be", bundleId: "com.x", pid: nil,
                recipeConfigPath: nil, calibrationAssetsPath: nil, evidenceStoragePath: nil
            )
        }

        // Listing says what it is: no registry, not "nothing registered".
        XCTAssertThrowsGPError(.internalError) {
            _ = try core.projectList()
        }

        // The registry-less engine still attaches and still acts.
        XCTAssertNoThrow(try core.attach(bundleId: "com.example.app", pid: nil))
        XCTAssertNoThrow(try core.act(selector: submitSelector, action: .press))
    }

    // MARK: - A-07 / C-06: one validator for adopting and for deleting

    func testProjectArchiveDirectoryRefusesWhatAttachRefuses() throws {
        let registry = TestSandbox.projectRegistry("beta-archive")
        let doomed = try registry.create(
            displayName: "Legacy", bundleId: "com.a", evidenceStoragePath: "/System/Library/Java"
        )
        let homeless = try registry.create(displayName: "NoPath", bundleId: "com.b")
        let ownedDirectory = TestSandbox.directory("beta-owned")
        let owned = try registry.create(
            displayName: "Owned", bundleId: "com.c", evidenceStoragePath: ownedDirectory
        )

        switch EngineCore.projectArchiveDirectory(projectId: doomed.projectId, entry: doomed) {
        case .success:
            XCTFail("a system-owned tree must never be adopted as an archive")
        case .failure(let refusal):
            XCTAssertEqual(refusal.code, .badParams, "the frozen code of the attach refusal")
            XCTAssertTrue(refusal.message.contains("/System/Library/Java"), refusal.message)
            XCTAssertEqual(
                refusal.remedy, EngineCore.evidenceStorageRemedy,
                "one remedy text, so the deleting half cannot advise differently"
            )
        }
        switch EngineCore.projectArchiveDirectory(projectId: homeless.projectId, entry: homeless) {
        case .success:
            XCTFail("a project that named no directory owns no archive")
        case .failure(let refusal):
            XCTAssertTrue(refusal.message.contains("nothing was deleted"), refusal.message)
        }
        XCTAssertEqual(
            try EngineCore.projectArchiveDirectory(projectId: owned.projectId, entry: owned).get(),
            ownedDirectory
        )

        // The engine method and the CLI read the same words for the same case.
        let core = EngineCore(channel: makeChannel(), settle: {}, projectRegistry: registry)
        XCTAssertThrowsError(
            try core.pruneEvidence(projectId: homeless.projectId, olderThanDays: 30)
        ) { error in
            XCTAssertEqual(
                (error as? GPError)?.message,
                EngineCore.noArchiveRefusal(projectId: homeless.projectId).message,
                "the daemon-side refusal and the shared resolver must not drift apart"
            )
        }
    }

    func testMaintenanceCliRoutesThroughTheSharedValidator() throws {
        let source = try repoSource("engine/Sources/glasspaned/main.swift")
        let start = try XCTUnwrap(
            source.range(of: "if options.pruneEvidence || options.evidenceStats"),
            "the evidence maintenance branch is gone"
        )
        let end = try XCTUnwrap(
            source.range(of: "let socketPath = StateRoot.engineSocketPath"),
            "the slice anchor (daemon entry) is gone"
        )
        let block = source[start.lowerBound..<end.lowerBound]
        XCTAssertTrue(
            block.contains("EngineCore.projectArchiveDirectory"),
            "the deleting CLI must resolve a project's archive through the engine's own validator"
        )
        XCTAssertTrue(
            block.contains("\"stateChanged\": false"),
            "a refusal must not read as a completed maintenance run"
        )
        XCTAssertTrue(block.contains("exit(1)"), "a refusal exits non-zero")
        XCTAssertFalse(
            block.contains("evidenceStoragePath ?? EvidenceStore.default"),
            "substituting the shared archive for a project that named none is the defect"
        )
    }

    func testDaemonNamesBothProductionLocationsInsteadOfDefaultingIntoThem() throws {
        let source = try repoSource("engine/Sources/glasspaned/main.swift")
        // X-22 renamed the route, not the property: the daemon still has to
        // reach its archive by *name*, and the name it uses is now the state
        // root it resolved for this run.
        XCTAssertTrue(
            source.contains("EvidenceStore.at(stateRoot:"),
            "the daemon reaches the real archive by name only"
        )
        // …and the stronger form of the same rule: one root per process, so a
        // subcommand cannot default into a location another subcommand is not
        // using (that is how the real projects.json was overwritten once).
        XCTAssertTrue(
            source.contains("resolvedStateRoot(injected: options.stateDir)"),
            "every state-touching path must come from the one resolved root"
        )
        XCTAssertFalse(
            source.contains("NSHomeDirectory()"),
            "the home lookup lives in StateRoot alone; a second copy here is a "
                + "path no gate can see (NSHomeDirectory does not honour HOME)"
        )
        XCTAssertFalse(
            source.contains("let store = EvidenceStore" + "()")
                || source.contains("evidenceStore: EvidenceStore" + "()"),
            "a bare archive constructor is the shape C-02 removed"
        )
        XCTAssertTrue(
            source.contains("projectRegistry: ProjectRegistry"),
            "the daemon injects its registry instead of letting the initializer decide"
        )
    }

    // MARK: - A-01: an export that failed is not "no probe"

    func testFailedCheckpointExportSurvivesIntoTheRollbackRefusal() throws {
        let time = Box(Date(timeIntervalSince1970: 1_800_000_000))
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1", "checkpoint"]))
        inbox.sender = { pid, data in
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if object?["t"] as? String == "checkpoint_export" {
                inbox.ingest(pid: pid, frame: .checkpoint(
                    ref: object?["ref"] as? String ?? "",
                    domains: ["counter": ["value": "3"]],
                    digest: "digest-the-daemon-will-not-recompute",
                    error: nil
                ))
            }
            return true
        }
        let core = EngineCore(
            channel: makeChannel(), clock: { time.now }, settle: {}, probeInbox: inbox
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let snapshot = try core.snapshot(maxDepth: 4)
        let reported = try XCTUnwrap(
            snapshot["checkpointExportError"] as? String,
            "a probe that answered with a bad digest must not be reported as silence"
        )
        XCTAssertTrue(reported.contains("digest mismatch"), reported)
        let snapshotId = try XCTUnwrap(snapshot["snapshotId"] as? String)

        XCTAssertThrowsError(
            try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")
        ) { error in
            guard let gpError = error as? GPError else {
                return XCTFail("expected a GPError, got \(error)")
            }
            XCTAssertEqual(gpError.code, .restoreUnsupported, "the frozen code stays")
            XCTAssertTrue(gpError.message.contains("export attempted and failed"), gpError.message)
            XCTAssertTrue(gpError.message.contains("digest mismatch"), gpError.message)
            XCTAssertFalse(
                gpError.message.contains("attach the probe"),
                "the probe IS attached; telling the agent to attach one restarts the loop; got \(gpError.message)"
            )
            XCTAssertTrue(gpError.remedy.contains("gp_probe_status"), gpError.remedy)
        }
    }

    func testProbeWithoutTheCheckpointCapabilityIsNamedAsTheCause() throws {
        let inbox = ProbeInbox()
        inbox.register(hello(capabilities: ["z1"]))
        let core = EngineCore(
            channel: makeChannel(), settle: {}, probeInbox: inbox
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let snapshot = try core.snapshot(maxDepth: 4)
        let reported = try XCTUnwrap(snapshot["checkpointExportError"] as? String)
        XCTAssertTrue(reported.contains("does not advertise"), reported)
    }

    func testRollbackWithoutAnyProbeKeepsTheAttachTheProbeAdvice() throws {
        let core = EngineCore(channel: makeChannel(), settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let snapshot = try core.snapshot(maxDepth: 4)
        XCTAssertNil(
            snapshot["checkpointExportError"],
            "no probe connection is the absence of the surface, not a failed export"
        )
        let snapshotId = try XCTUnwrap(snapshot["snapshotId"] as? String)
        XCTAssertThrowsError(
            try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")
        ) { error in
            XCTAssertTrue(
                (error as? GPError)?.message.contains("attach the probe and re-snapshot") == true,
                "the one case where that advice is true must keep its wording; got \(error)"
            )
        }
    }

    // MARK: - A-08: the artifact carries the unmeasured verdict too

    func testStatedMonitorAbsenceIsRecordedInTheArchive() throws {
        let core = EngineCore(
            channel: makeChannel(), settle: {},
            inputMonitorAbsenceReason: "the CGEvent input tap could not be created"
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.act(selector: submitSelector, action: .press)
        XCTAssertEqual(result["contaminationMonitored"] as? Bool, false)
        let basis = try XCTUnwrap(result["contaminationBasis"] as? String)
        XCTAssertTrue(basis.contains("the CGEvent input tap could not be created"), basis)

        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertTrue(
            pack.attribution.contaminated,
            "an unwatched window is archived as unobservable, exactly as the response reads"
        )
        XCTAssertEqual(pack.attribution.level, .weak)
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(
            reason.contains("input-contamination-not-monitored: the CGEvent input tap could not be created"),
            reason
        )
        XCTAssertNotNil(
            try EvidencePack.decodeAndValidate(pack.jsonData()),
            "the basis rides an existing field, so the frozen schema still holds"
        )
    }

    /// R3-1: `--unattended-window` is the operator's *declaration* that nobody is
    /// at the keyboard, and it is the only thing that can make a window nobody
    /// watched read as not contaminated. Two properties are pinned here: it
    /// applies to the inference (never to an observed input), and it does not
    /// erase the record that no monitor was running. Without this, a daemon
    /// started with `--no-c33` can never answer above `.weak`, and the one
    /// end-to-end probe gate (`engine/.p6_smoke.py`) has no reachable `.strong`
    /// canary — which is how that gate sat permanently red before this flag.
    func testDeclaredUnattendedWindowReplacesTheInferenceNotTheRecord() throws {
        let core = EngineCore(
            channel: makeChannel(), settle: {},
            inputMonitorAbsenceReason: "C33 was declined at startup by the --no-c33 flag",
            declaresUnattendedWindow: true
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.act(selector: submitSelector, action: .press)

        XCTAssertEqual(result["contaminationMonitored"] as? Bool, false)
        let basis = try XCTUnwrap(result["contaminationBasis"] as? String)
        XCTAssertTrue(basis.contains("declaration, not a measurement"), basis)
        // The declaration must not become a cover story for a missing monitor:
        // the reason the window was unwatched is quoted in the same sentence.
        XCTAssertTrue(
            basis.contains("C33 was declined at startup by the --no-c33 flag"),
            basis
        )
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertFalse(
            pack.attribution.contaminated,
            "the operator's statement is what makes the verdict false here"
        )
        XCTAssertEqual(
            pack.attribution.level, .soft,
            "the cap lifts from .weak to .soft — the probe signal, not the declaration, is what turns .soft into .strong"
        )
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(
            reason.contains("input-contamination-not-monitored: C33 was declined at startup by the --no-c33 flag"),
            "the archive still says nobody was watching: \(reason)"
        )
        XCTAssertNotNil(
            try EvidencePack.decodeAndValidate(pack.jsonData()),
            "the declaration rides the existing reason/basis fields, so the frozen schema still holds"
        )
    }

    func testDeclaredUnattendedWindowNeverOverridesAnObservedHumanInput() throws {
        // The other half of the ruling: a declaration is allowed to stand only
        // where nothing was watched. An input the monitor actually caught is a
        // measurement, and no startup flag may talk it out of existence —
        // otherwise one flag would silently downgrade the audit trail it is
        // supposed to be honest about.
        let now = Date(timeIntervalSince1970: 1_000)
        let guard_ = AttributionGuard(
            inputSource: ScriptedInputEventSource(events: [
                InputEvent(timestamp: 999.9, source: .human)
            ]),
            clock: { now },
            idleWindowSeconds: 0.5
        )
        let core = EngineCore(
            channel: makeChannel(), settle: {}, attributionGuard: guard_,
            declaresUnattendedWindow: true
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        // The window is busy with a real human input, so the plain call refuses;
        // `degrade` is the documented way to proceed with the contamination
        // recorded, which is the only way this pair (declaration + observation)
        // can reach the archive at all.
        let result = try core.act(selector: submitSelector, action: .press, degrade: true)
        let basis = try XCTUnwrap(result["contaminationBasis"] as? String)
        XCTAssertFalse(
            basis.contains("declaration, not a measurement"),
            "the window WAS watched, so the declared-unattended sentence must not appear: \(basis)"
        )
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(
            pack.attribution, Attribution(level: .weak, contaminated: true),
            "an observed human input decides the verdict against the declaration"
        )
        XCTAssertNotNil(
            result["humanInputEvents"],
            "the observed events stay on the response, declared or not"
        )
    }

    func testUndeclaredEngineKeepsTheConservativeVerdict() throws {
        // The default must stay the pessimistic one: `declaresUnattendedWindow`
        // is opt-in per process, so forgetting the flag cannot quietly upgrade
        // unwatched windows into clean ones. Same engine as the first declared
        // test, one argument missing.
        let core = EngineCore(
            channel: makeChannel(), settle: {},
            inputMonitorAbsenceReason: "C33 was declined at startup by the --no-c33 flag"
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.act(selector: submitSelector, action: .press)
        let basis = try XCTUnwrap(result["contaminationBasis"] as? String)
        XCTAssertFalse(basis.contains("declaration"), basis)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.attribution, Attribution(level: .weak, contaminated: true))
    }

    func testMonitorAbsenceWithoutAStatedReasonChangesNoArchivedVerdict() throws {
        // The route every existing unit test takes: nothing installed and
        // nothing claimed. The response still refuses to call it clean, and the
        // pack keeps the words it has always had — inventing a reason here would
        // be the fabricated default this round is removing elsewhere.
        let core = EngineCore(channel: makeChannel(), settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.act(selector: submitSelector, action: .press)
        XCTAssertEqual(result["contaminationMonitored"] as? Bool, false)
        XCTAssertTrue(
            (try XCTUnwrap(result["contaminationBasis"] as? String)).contains("no reason")
        )
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.attribution.level, .soft)
        XCTAssertFalse(pack.attribution.contaminated)
        XCTAssertNil(pack.circuitBreaker.reason, "no channel fault was measured either")
    }

    func testTapFaultRecordsTheSameVerdictAsNoMonitorWithAReason() throws {
        let faulted = ScriptedMonitoringSource(fault: "tap disabled mid-window")
        let guard_ = AttributionGuard(inputSource: faulted)
        let withGuard = EngineCore(
            channel: makeChannel(), settle: {}, attributionGuard: guard_
        )
        _ = try withGuard.attach(bundleId: "com.example.app", pid: nil)
        let siblingResponse = try withGuard.act(selector: submitSelector, action: .press)
        let sibling = try withGuard.lastEvidence(operationId: nil)

        let withoutGuard = EngineCore(
            channel: makeChannel(), settle: {},
            inputMonitorAbsenceReason: "the CGEvent input tap could not be created"
        )
        _ = try withoutGuard.attach(bundleId: "com.example.app", pid: nil)
        let thisResponse = try withoutGuard.act(selector: submitSelector, action: .press)
        let thisOne = try withoutGuard.lastEvidence(operationId: nil)

        XCTAssertEqual(
            thisOne.attribution, sibling.attribution,
            "one rule for \"not measured\": the two not-measured shapes must not disagree"
        )
        // Equality on its own would also be satisfied by two copies of the old
        // optimistic answer, so pin *which* verdict the one rule produces: the
        // conservative one, on both sides, and both responses still say
        // "nothing watched this window" — pack and response cannot disagree.
        XCTAssertEqual(thisOne.attribution, Attribution(level: .weak, contaminated: true))
        XCTAssertEqual(siblingResponse["contaminationMonitored"] as? Bool, false)
        XCTAssertEqual(thisResponse["contaminationMonitored"] as? Bool, false)
        let siblingBasis = try XCTUnwrap(siblingResponse["contaminationBasis"] as? String)
        XCTAssertTrue(siblingBasis.contains("tap disabled mid-window"), siblingBasis)
        // The verdicts agree; the causes do not collapse into one another. A
        // monitor that died mid-window is a channel fault, a monitor that was
        // never installed is a declared startup state (`--no-c33`, or no Input
        // Monitoring grant) — P2 v2.0 §17.2 gives both the same degradation, so
        // the distinction lives in the reason text, not in a second verdict.
        let lostReason = try XCTUnwrap(sibling.circuitBreaker.reason)
        XCTAssertTrue(
            lostReason.contains("input-contamination-monitor-lost: tap disabled mid-window"),
            lostReason
        )
        let declinedReason = try XCTUnwrap(thisOne.circuitBreaker.reason)
        XCTAssertTrue(
            declinedReason.contains(
                "input-contamination-not-monitored: the CGEvent input tap could not be created"
            ),
            declinedReason
        )
        XCTAssertFalse(declinedReason.contains("monitor-lost"), declinedReason)
        XCTAssertFalse(lostReason.contains("not-monitored"), lostReason)
        // `attribution` and `signals` are frozen (`additionalProperties: false`),
        // so the extra truth rides a field the pack already has and both packs
        // still have to validate against the shipped schema.
        XCTAssertNotNil(try EvidencePack.decodeAndValidate(sibling.jsonData()))
        XCTAssertNotNil(try EvidencePack.decodeAndValidate(thisOne.jsonData()))
    }

    // MARK: - A-14: a pingTimeout no longer reports a completed search

    func testPingTimeoutAdviceReportsAnUnfinishedSearchAndItsRealBudget() throws {
        let rejection = EngineCore.actRejection(for: .pingTimeout)
        XCTAssertFalse(
            rejection.reason.contains("within \(AXChannel.messagingTimeoutSeconds)s"),
            "one fixed duration cannot be quoted: the budget shrinks per call; got \(rejection.reason)"
        )
        XCTAssertTrue(
            rejection.reason.contains("\(AXChannel.minMessagingTimeoutSeconds)s"),
            "the effective floor has to be quoted; got \(rejection.reason)"
        )
        XCTAssertTrue(
            rejection.reason.contains("\(AXChannel.treeTimeoutSeconds)s"), rejection.reason
        )
        let remedy = try XCTUnwrap(rejection.remedy)
        XCTAssertFalse(remedy.contains("the search finished"), remedy)
        XCTAssertFalse(remedy.contains("Do not change the selector"), remedy)
        XCTAssertTrue(remedy.contains("mid-tree"), remedy)
        XCTAssertTrue(remedy.contains("sample <pid>"), remedy)
        XCTAssertTrue(remedy.contains("--check-accessibility"), remedy)
    }

    func testActStillThrowsTheHonestPingTimeoutReasonIntoTheEvidence() throws {
        let channel = makeChannel()
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        channel.actionError = .pingTimeout
        XCTAssertThrowsGPError(.actFailed) {
            _ = try core.act(selector: submitSelector, action: .press)
        }
        let pack = try core.lastEvidence(operationId: nil)
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.contains("did not answer within its budget") || reason.contains("did not answer"), reason)
        XCTAssertFalse(reason.contains("the search finished"), reason)
    }
}

/// A source that reports its own death, so the guard's `monitoringFault` branch
/// is reachable from an `act()` (C33's conservative path). The contract is
/// `InputSourceMonitoring`'s own: `inputMonitoringFault` is non-nil **only
/// while `isMonitoringInput` is false** — `CGEventInputMonitor` implements it as
/// `tapAlive ? nil : lastFault` — so a faulted source has to report "not
/// measuring", never "measuring, and here is a fault".
private final class ScriptedMonitoringSource: InputEventSource, InputSourceMonitoring {
    var fault: String?
    var isMonitoringInput: Bool { fault == nil }
    var inputMonitoringFault: String? { fault }

    init(fault: String?) {
        self.fault = fault
    }

    func nextEvent() -> InputEvent? { nil }
    func peekAvailable() -> [InputEvent] { [] }
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
