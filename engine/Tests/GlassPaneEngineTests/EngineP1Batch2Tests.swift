import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// P1 batch-2 tests (spec v1.1): snapshot/restore primitives and the
/// performance circuit breaker. Pure logic — scripted channel, no AX.
final class EngineP1Batch2Tests: XCTestCase {

    // MARK: - Helpers

    private func makeCore(
        channel: ScriptedChannel,
        clock: @escaping () -> Date = { Date(timeIntervalSince1970: 1_760_000_000) }
    ) -> EngineCore {
        let core = EngineCore(channel: channel, clock: clock, settle: {})
        _ = try? core.attach(bundleId: nil, pid: 4242)
        return core
    }

    private func result(_ object: [String: Any]) -> [String: Any] {
        object
    }

    /// Captures a snapshot after attaching, reusing the standard test tree.
    private func capture(_ core: EngineCore) throws -> [String: Any] {
        try core.snapshot(maxDepth: 6)
    }

    // MARK: - snapshot

    func testSnapshotReturnsWellFormedBaseline() throws {
        let core = makeCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard))
        let snap = try capture(core)

        let snapshotId = try XCTUnwrap(snap["snapshotId"] as? String)
        XCTAssertTrue(snapshotId.hasPrefix("snap_"), "snapshot id must use the snap_ prefix")
        XCTAssertEqual(snapshotId.count, "snap_".count + 26)
        XCTAssertEqual(snap["treeDigest"] as? String, TestTrees.standard.digest)
        XCTAssertEqual(snap["nodeCount"] as? Int, TestTrees.standard.nodeCount)
        XCTAssertNotNil(try XCTUnwrap(snap["capturedAt"] as? String))
    }

    func testSnapshotRequiresAttachment() {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, clock: { Date() }, settle: {})
        XCTAssertThrowsError(try core.snapshot(maxDepth: 6)) { error in
            XCTAssertEqual((error as? GPError)?.code, .notAttached)
        }
    }

    func testSnapshotHistoryIsBoundedAndFifoEvicted() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = makeCore(channel: channel)

        // Capture more than the retention cap;每轮树相同，digest 相同，但 snapshotId 唯一。
        var ids: [String] = []
        for _ in 0..<(EngineCore.snapshotHistoryLimit + 3) {
            let snap = try capture(core)
            ids.append(try XCTUnwrap(snap["snapshotId"] as? String))
        }
        XCTAssertEqual(ids.count, EngineCore.snapshotHistoryLimit + 3)

        // 最旧的 3 条必须被淘汰：restore 它们应抛 GP_E_NO_SNAPSHOT。
        for index in 0..<3 {
            let snapshotId = ids[index]
            assertThrowsNoSnapshot(core, snapshotId: snapshotId)
        }
        // 最近 8 条仍保留（至少存在一条可成功 restore 的基线）。
        let latest = ids[ids.count - 1]
        let restore = try core.restore(snapshotId: latest, steps: nil)
        XCTAssertEqual(restore["consistent"] as? Bool, true)
    }

    // MARK: - restore (tier-2 ffwd)

    func testRestoreWithoutStepsComparesBaselineWhenConsistent() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = makeCore(channel: channel)
        let snap = try capture(core)
        let snapshotId = try XCTUnwrap(snap["snapshotId"] as? String)

        let restore = try core.restore(snapshotId: snapshotId, steps: nil)
        XCTAssertEqual(restore["confirmed"] as? Int, 0)
        XCTAssertEqual(restore["total"] as? Int, 0)
        XCTAssertEqual(restore["consistent"] as? Bool, true)
        XCTAssertEqual(restore["targetDigest"] as? String, TestTrees.standard.digest)
    }

    func testRestoreWithoutStepsFlagsInconsistency() throws {
        // Tree changes after the snapshot: fall back to a different tree on
        // the restore read so the digests diverge.
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = makeCore(channel: channel)
        let snap = try capture(core)
        let snapshotId = try XCTUnwrap(snap["snapshotId"] as? String)

        // Script the divergence: the next tree read reports the retitled tree.
        channel.treeResults = [.success(TestTrees.buttonRetitled)]
        let restore = try core.restore(snapshotId: snapshotId, steps: nil)
        XCTAssertEqual(restore["consistent"] as? Bool, false)
        XCTAssertNotEqual(restore["targetDigest"] as? String, TestTrees.standard.digest)
    }

    func testRestoreReplaysStepsThroughActPipeline() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = makeCore(channel: channel)
        let snap = try capture(core)
        let snapshotId = try XCTUnwrap(snap["snapshotId"] as? String)

        let steps = [
            (Selector(role: "AXButton", title: "Submit"), Action.press),
            (Selector(role: "AXCheckBox", title: "Agree"), Action.press),
        ]
        let restore = try core.restore(snapshotId: snapshotId, steps: steps)
        XCTAssertEqual(restore["confirmed"] as? Int, 2)
        XCTAssertEqual(restore["total"] as? Int, 2)
        let stepResults = try XCTUnwrap(restore["steps"] as? [[String: Any]])
        XCTAssertEqual(stepResults.count, 2)
        for step in stepResults {
            XCTAssertEqual(step["actConfirmed"] as? Bool, true)
            let operationId = try XCTUnwrap(step["operationId"] as? String)
            XCTAssertTrue(operationId.hasPrefix("op_"))
        }
        XCTAssertEqual(channel.actionCallCount, 2)
    }

    func testRestoreStopsAtFirstFailedStep() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = makeCore(channel: channel)
        let snap = try capture(core)
        let snapshotId = try XCTUnwrap(snap["snapshotId"] as? String)

        // ScriptedChannel throws actionError on every performAction call, so
        // the very first step is rejected — restore must abort immediately.
        channel.actionError = ChannelError.actRejected(reason: "scripted rejection")
        let steps = [
            (Selector(role: "AXButton", title: "Submit"), Action.press),
            (Selector(role: "AXCheckBox", title: "Agree"), Action.press),
        ]
        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: steps)) { error in
            let gpError = error as? GPError
            XCTAssertEqual(gpError?.code, .restoreStepFailed)
            XCTAssertTrue(gpError?.message.contains("step 0 failed") == true)
        }
        XCTAssertEqual(channel.actionCallCount, 1, "only the first step is attempted before abort")
    }

    // MARK: - rest of ffwd failure semantics

    func testRestoreRejectsUnknownSnapshotId() throws {
        let core = makeCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard))
        let unknown = "snap_" + String(repeating: "A", count: 26)
        assertThrowsNoSnapshot(core, snapshotId: unknown)
    }

    /// Requests tier-1 full-snapshot mode; rejected by design (spec v1.1 §1.2).
    func testRestoreRejectsTier1Mode() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = makeCore(channel: channel)
        let snap = try capture(core)
        let snapshotId = try XCTUnwrap(snap["snapshotId"] as? String)

        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: nil, mode: "restore_snapshot")) { error in
            let gpError = error as? GPError
            XCTAssertEqual(gpError?.code, .restoreUnsupported)
        }
    }

    // MARK: - Performance circuit breaker

    private func makeClock(start: Date, stepMs: Double) -> () -> Date {
        var cursor = start
        return {
            cursor = cursor.addingTimeInterval(stepMs / 1000)
            return cursor
        }
    }

    func testNormalLatencyDoesNotElevateCircuitBreaker() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        // Let pixel capture succeed so the channel-level judgment is clean
        // (no screen-recording-denied downgrade interfering with the latency check).
        channel.fallbackCapture = TestImages.solid(128)
        let core = EngineCore(
            channel: channel,
            clock: makeClock(start: Date(timeIntervalSince1970: 0), stepMs: 5),
            settle: {}
        )
        _ = try? core.attach(bundleId: nil, pid: 4242)
        let outcome = try core.act(selector: Selector(role: "AXButton"), action: .press)
        let operationId = try XCTUnwrap(outcome["operationId"] as? String)
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.circuitBreaker.level, .normal, "sub-budget latency must stay at level 0")
        XCTAssertNil(pack.circuitBreaker.reason)
    }

    func testOvershootLatencyElevatesCircuitBreakerToDegraded() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        // 15 s of elapsed time per act — above the 10 s budget.
        let core = EngineCore(
            channel: channel,
            clock: makeClock(start: Date(timeIntervalSince1970: 0), stepMs: 15_000),
            settle: {}
        )
        _ = try? core.attach(bundleId: nil, pid: 4242)
        let outcome = try core.act(selector: Selector(role: "AXButton"), action: .press)
        let operationId = try XCTUnwrap(outcome["operationId"] as? String)
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.circuitBreaker.level, .degraded, "overshoot latency must elevate to level 1")
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.contains("performance-act-latency-over-budget"), "reason must carry the performance flag; got \(reason)")
        XCTAssertTrue(reason.contains("15000ms"), "reason should report the real measured latency")
    }

    func testPerformanceAssemblyPreservesExistingActFailedLevel() throws {
        // act-failed-channel-alive (2) must never be lowered by the
        // performance escalation path — max() keeps it at 2.
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.alive = false // act sees a dead process -> level 2 actFailedChannelAlive
        let core = EngineCore(
            channel: channel,
            clock: makeClock(start: Date(timeIntervalSince1970: 0), stepMs: 15_000),
            settle: {}
        )
        _ = try? core.attach(bundleId: nil, pid: 4242)
        XCTAssertThrowsError(try core.act(selector: Selector(role: "AXButton"), action: .press)) { error in
            XCTAssertEqual((error as? GPError)?.code, .actFailed)
        }
        // The evidence still exists with the elevated latency and the
        // act-failed level preserved.
        let pack = try? core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack?.circuitBreaker.level, .actFailedChannelAlive, "act-failed (2) must survive the performance path")
        if let pack {
            let reason = pack.circuitBreaker.reason
            XCTAssertTrue(reason?.contains("performance|") == true, "reason should be prefixed performance|; got \(reason ?? "nil")")
        }
    }

    func testPerformanceReasonMergesWithExistingReason() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.captureResults = [
            // captureBefore fails -> pixelCaptureDenied; captureAfter still runs.
            .failure(ChannelError.pixelCaptureDenied(reason: "denied")),
        ]
        let core = EngineCore(
            channel: channel,
            clock: makeClock(start: Date(timeIntervalSince1970: 0), stepMs: 15_000),
            settle: {}
        )
        _ = try? core.attach(bundleId: nil, pid: 4242)
        let outcome = try core.act(selector: Selector(role: "AXButton"), action: .press)
        let operationId = try XCTUnwrap(outcome["operationId"] as? String)
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.circuitBreaker.level, .degraded)
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.hasPrefix("performance|"), "performance reason precedes the channel reason; got \(reason)")
        XCTAssertTrue(reason.contains("screen-recording-denied"), "channel reason should survive merged; got \(reason)")
    }

    // MARK: - Boundary helpers

    private func assertThrowsNoSnapshot(
        _ core: EngineCore,
        snapshotId: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(
            try core.restore(snapshotId: snapshotId, steps: nil),
            "restore of unknown snapshotId \(snapshotId)",
            file: file,
            line: line
        ) { error in
            XCTAssertEqual((error as? GPError)?.code, .noSnapshot, file: file, line: line)
        }
    }
}