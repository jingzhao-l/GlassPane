import XCTest
import Foundation
import CryptoKit
@testable import GlassPaneEngine

// MARK: - P5 批二：恢复快照 tier-1 管线纯逻辑（spec v5.0 §6，验收 P5-B2..B4）

final class RestorePipelineTests: XCTestCase {

    /// Envelope digest helper — mirrors RestorePipeline.verifyStateDigest's
    /// digest input so a schema-consistent probe can be built in tests.
    private func envelopeDigest(_ probe: SnapshotProbeInfo) -> String {
        let payload: [String: Any] = [
            "probeVersion": probe.probeVersion,
            "exportedDomains": probe.exportedDomains,
            "checkpointFormat": probe.checkpointFormat,
            "capturedAt": probe.capturedAt
        ]
        let data = CanonicalJSON.stringify(payload).data(using: .utf8)!
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Deterministic probe whose stateDigest matches its envelope.
    private func makeProbe(
        domains: [String] = ["objc", "heap", "ui"],
        digestOverride: String? = nil
    ) -> SnapshotProbeInfo {
        let draft = SnapshotProbeInfo(
            probeVersion: "z5-0.1.0",
            exportedDomains: domains,
            stateDigest: "",
            checkpointFormat: "z5-json-v1",
            capturedAt: "2026-09-18T00:00:00.000Z"
        )
        return SnapshotProbeInfo(
            probeVersion: draft.probeVersion,
            exportedDomains: draft.exportedDomains,
            stateDigest: digestOverride ?? envelopeDigest(draft),
            checkpointFormat: draft.checkpointFormat,
            capturedAt: draft.capturedAt
        )
    }

    private func makeSnapshot(probe: SnapshotProbeInfo?) -> AppStateSnapshot {
        AppStateSnapshot(
            snapshotId: "snap_0000000000000000000000ABCDEF",
            treeDigest: String(repeating: "a", count: 64),
            nodeCount: 10,
            capturedAt: "2026-09-18T00:00:00.000Z",
            probeInfo: probe
        )
    }

    // MARK: - P5-B2 plan building

    func testPlanNilWithoutProbePayload() {
        let snapshot = makeSnapshot(probe: nil)
        XCTAssertNil(RestorePipeline.plan(snapshot: snapshot))
    }

    func testPlanSynthesisIsDeterministicLexicographic() throws {
        let probe = makeProbe(domains: ["objc", "heap", "ui"])
        let snapshot = makeSnapshot(probe: probe)
        guard let plan = RestorePipeline.plan(snapshot: snapshot) else {
            return XCTFail("plan should build")
        }
        XCTAssertEqual(plan.domains, ["heap", "objc", "ui"])
        XCTAssertEqual(plan.domainCount, 3)
        XCTAssertEqual(plan.steps.count, 3)
        XCTAssertEqual(plan.snapshotId, snapshot.snapshotId)
        XCTAssertEqual(plan.baselineDigest, snapshot.treeDigest)
        XCTAssertEqual(plan.expectedStateDigest, probe.stateDigest)
        for step in plan.steps {
            XCTAssertEqual(step.action, "rewrite")
            XCTAssertTrue(step.checkpointRef.hasPrefix(probe.checkpointFormat), step.checkpointRef)
            XCTAssertTrue(step.preconditions.isEmpty)
        }
        // Same input → same output (determinism of the plan contract).
        let replay = RestorePipeline.plan(snapshot: makeSnapshot(probe: probe))
        XCTAssertEqual(plan, replay)
    }

    func testPreconditionOrderingPutsRequirementsFirst() {
        // "aa" depends on "z" — a dependency that contradicts plain
        // lexicographic order ("aa" < "z"). Topological sorting must still put
        // "z" strictly before "aa"; the dependency-free "m" interleaves
        // deterministically by lexicographic tie-break.
        let steps = [
            RestoreStep(domain: "aa", checkpointRef: "k#aa", preconditions: ["z"]),
            RestoreStep(domain: "z", checkpointRef: "k#z"),
            RestoreStep(domain: "m", checkpointRef: "k#m")
        ]
        guard let plan = RestorePipeline.plan(
            snapshotId: "snap_0000000000000000000000ABCDEF",
            baselineDigest: "x",
            domains: ["aa", "z", "m"],
            steps: steps,
            expectedStateDigest: "d"
        ) else { return XCTFail("plan should build") }
        XCTAssertEqual(plan.domains, ["m", "z", "aa"])
        guard let zIndex = plan.domains.firstIndex(of: "z"),
              let aaIndex = plan.domains.firstIndex(of: "aa") else {
            return XCTFail("z/aa missing")
        }
        XCTAssertLessThan(zIndex, aaIndex)
        // Steps expanded in the same dependency order.
        XCTAssertEqual(plan.steps.map(\.domain), plan.domains)
    }

    func testSelfPreconditionIsNotACycle() {
        let steps = [
            RestoreStep(domain: "a", checkpointRef: "k#a", preconditions: ["a"])
        ]
        XCTAssertNotNil(RestorePipeline.plan(
            snapshotId: "s", baselineDigest: "x", domains: ["a"],
            steps: steps, expectedStateDigest: "d"
        ))
    }

    func testCyclicDependencyReturnsNil() {
        let steps = [
            RestoreStep(domain: "a", checkpointRef: "k#a", preconditions: ["b"]),
            RestoreStep(domain: "b", checkpointRef: "k#b", preconditions: ["a"])
        ]
        XCTAssertNil(RestorePipeline.plan(
            snapshotId: "s", baselineDigest: "x", domains: ["a", "b"],
            steps: steps, expectedStateDigest: "d"
        ))
    }

    // MARK: - P5-B3 plan validation

    func testValidateCleanPlan() {
        let probe = makeProbe()
        let snapshot = makeSnapshot(probe: probe)
        guard let plan = RestorePipeline.plan(snapshot: snapshot) else {
            return XCTFail("plan should build")
        }
        let verdict = RestorePipeline.validate(plan: plan, snapshot: snapshot)
        XCTAssertTrue(verdict.valid)
        XCTAssertTrue(verdict.issues.isEmpty)
    }

    func testValidateDetectsDomainMismatch() {
        let probe = makeProbe(domains: ["heap", "objc"])
        let snapshot = makeSnapshot(probe: probe)
        guard let plan = RestorePipeline.plan(snapshot: snapshot) else {
            return XCTFail("plan should build")
        }
        // Plan built over a snapshot whose probe was later reduced.
        let reducedProbe = makeProbe(domains: ["heap"])
        let desyncedSnapshot = makeSnapshot(probe: reducedProbe)
        let verdict = RestorePipeline.validate(plan: plan, snapshot: desyncedSnapshot)
        XCTAssertFalse(verdict.valid)
        XCTAssertTrue(verdict.issues.contains { $0.contains("objc") })
    }

    func testValidateDetectsDuplicateDomains() {
        let probe = makeProbe()
        let snapshot = makeSnapshot(probe: probe)
        let plan = RestorePlan(
            snapshotId: snapshot.snapshotId,
            baselineDigest: snapshot.treeDigest,
            domains: ["heap", "heap"],
            steps: [
                RestoreStep(domain: "heap", checkpointRef: "k#heap"),
                RestoreStep(domain: "heap", checkpointRef: "k#heap2")
            ],
            expectedStateDigest: probe.stateDigest,
            domainCount: 2
        )
        let verdict = RestorePipeline.validate(plan: plan, snapshot: snapshot)
        XCTAssertFalse(verdict.valid)
        XCTAssertTrue(verdict.issues.contains { $0.contains("duplicate") })
    }

    func testValidateDetectsEmptyCheckpointRef() {
        let probe = makeProbe(domains: ["heap"])
        let snapshot = makeSnapshot(probe: probe)
        let plan = RestorePlan(
            snapshotId: snapshot.snapshotId,
            baselineDigest: snapshot.treeDigest,
            domains: ["heap"],
            steps: [RestoreStep(domain: "heap", checkpointRef: "")],
            expectedStateDigest: probe.stateDigest,
            domainCount: 1
        )
        let verdict = RestorePipeline.validate(plan: plan, snapshot: snapshot)
        XCTAssertFalse(verdict.valid)
        XCTAssertTrue(verdict.issues.contains { $0.contains("empty checkpointRef") })
    }

    func testValidateDetectsTopologicalViolation() {
        let probe = makeProbe(domains: ["a", "b"])
        let snapshot = makeSnapshot(probe: probe)
        // Deliberately reversed order while b declares a precondition on a.
        let plan = RestorePlan(
            snapshotId: snapshot.snapshotId,
            baselineDigest: snapshot.treeDigest,
            domains: ["b", "a"],
            steps: [
                RestoreStep(domain: "b", checkpointRef: "k#b", preconditions: ["a"]),
                RestoreStep(domain: "a", checkpointRef: "k#a")
            ],
            expectedStateDigest: probe.stateDigest,
            domainCount: 2
        )
        let verdict = RestorePipeline.validate(plan: plan, snapshot: snapshot)
        XCTAssertFalse(verdict.valid)
        XCTAssertTrue(verdict.issues.contains { $0.contains("must run earlier") })
    }

    // MARK: - P5-B4 tamper detection

    func testValidateDetectsDigestMismatch() {
        let probe = makeProbe()
        let snapshot = makeSnapshot(probe: probe)
        guard let plan = RestorePipeline.plan(snapshot: snapshot) else {
            return XCTFail("plan should build")
        }
        let tamperedPlan = RestorePlan(
            snapshotId: plan.snapshotId,
            baselineDigest: plan.baselineDigest,
            domains: plan.domains,
            steps: plan.steps,
            expectedStateDigest: String(repeating: "b", count: 64),
            domainCount: plan.domainCount
        )
        let verdict = RestorePipeline.validate(plan: tamperedPlan, snapshot: snapshot)
        XCTAssertFalse(verdict.valid)
        XCTAssertTrue(verdict.issues.contains { $0.contains("stateDigest") })
    }

    func testVerifyStateDigestAcceptsEnvelopeConsistentProbe() {
        let probe = makeProbe()
        let snapshot = makeSnapshot(probe: probe)
        XCTAssertTrue(RestorePipeline.verifyStateDigest(snapshot: snapshot))
    }

    func testVerifyStateDigestDetectsTamperedEnvelopeField() {
        let probe = makeProbe()
        let tampered = SnapshotProbeInfo(
            probeVersion: "z5-9.9.9", // tampered
            exportedDomains: probe.exportedDomains,
            stateDigest: probe.stateDigest,
            checkpointFormat: probe.checkpointFormat,
            capturedAt: probe.capturedAt
        )
        XCTAssertFalse(RestorePipeline.verifyStateDigest(snapshot: makeSnapshot(probe: tampered)))
    }

    func testVerifyStateDigestDetectsTamperedSelfDigest() {
        let probe = makeProbe(digestOverride: String(repeating: "0", count: 64))
        XCTAssertFalse(RestorePipeline.verifyStateDigest(snapshot: makeSnapshot(probe: probe)))
    }
}

// MARK: - P5 批二：EngineCore tier-1 三分支集成（验收 P5-B1/B5/B6）

final class EngineP5Batch2Tests: XCTestCase {

    private func makeCore(
        probe: SnapshotProbeInfo?,
        gate: ApprovalGate? = nil
    ) throws -> EngineCore {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(
            channel: channel,
            evidenceStore: nil,
            approvalGate: gate,
            snapshotProbe: { probe }
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        return core
    }

    private func makeProbe(domains: [String] = ["objc", "heap"]) -> SnapshotProbeInfo {
        SnapshotProbeInfo(
            probeVersion: "z5-0.1.0",
            exportedDomains: domains,
            stateDigest: String(repeating: "d", count: 64),
            checkpointFormat: "z5-json-v1",
            capturedAt: "2026-09-18T00:00:00.000Z"
        )
    }

    private func takeSnapshot(_ core: EngineCore) throws -> String {
        let snap = try core.snapshot(maxDepth: 6)
        guard let snapshotId = snap["snapshotId"] as? String else {
            throw NSError(domain: "test", code: 1)
        }
        return snapshotId
    }

    /// P5-B1: the injection slot exists (nil default) and captures attach the
    /// synthetic payload observable through the tier-1 branch.
    func testSnapshotCarriesSyntheticProbePayload() throws {
        let probe = makeProbe(domains: ["ui", "heap"])
        let core = try makeCore(probe: probe)
        let snapshotId = try takeSnapshot(core)
        let result = try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")
        let plan = result["plan"] as? [String: Any]
        XCTAssertEqual(plan?["domainCount"] as? Int, 2)
        XCTAssertEqual((plan?["domains"] as? [String])?.sorted(), ["heap", "ui"])
    }

    /// P5-B5: no probe payload → same code/semantics as the P1 tier-1 refusal.
    func testRollbackFullWithoutProbeRefuses() throws {
        let core = try makeCore(probe: nil)
        let snapshotId = try takeSnapshot(core)
        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")) { error in
            guard let gpError = error as? GPError else {
                return XCTFail("expected GPError")
            }
            XCTAssertEqual(gpError.code, .restoreUnsupported)
        }
    }

    /// P5-B5: probe present → planValid + rollbackExecuted:false + surface.
    func testRollbackFullWithProbeReturnsHonestPlan() throws {
        let probe = makeProbe(domains: ["objc", "heap"])
        let core = try makeCore(probe: probe)
        let snapshotId = try takeSnapshot(core)
        let result = try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")

        XCTAssertEqual(result["planValid"] as? Bool, true)
        XCTAssertEqual(result["rollbackExecuted"] as? Bool, false)
        XCTAssertEqual(result["executionSurface"] as? String, "z5-probe-runtime")
        XCTAssertEqual(result["consistent"] as? Bool, true)
        guard let baseline = result["baselineTreeDigest"] as? String else {
            return XCTFail("missing baselineTreeDigest")
        }
        XCTAssertTrue(baseline.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil)
        let plan = result["plan"] as? [String: Any]
        XCTAssertNotNil(plan)
        XCTAssertEqual(plan?["expectedStateDigest"] as? String, probe.stateDigest)
        XCTAssertEqual(plan?["domainCount"] as? Int, 2)
        let steps = plan?["steps"] as? [[String: Any]]
        XCTAssertEqual(steps?.count, 2)
        XCTAssertEqual((steps?.first?["action"] as? String), "rewrite")
    }

    /// P5-B5: unknown snapshot keeps the noSnapshot invariant ahead of mode checks.
    func testRollbackFullUnknownSnapshotKeepsNoSnapshotInvariant() throws {
        let core = try makeCore(probe: makeProbe())
        XCTAssertThrowsError(
            try core.restore(snapshotId: "snap_999", steps: nil, mode: "rollback_full")
        ) { error in
            guard let gpError = error as? GPError else {
                return XCTFail("expected GPError")
            }
            XCTAssertEqual(gpError.code, .noSnapshot)
        }
    }

    /// P5-B6: existing restore forms keep their behavior with the probe slot
    /// wired (zero regression).
    func testExistingFormsUnchangedWithProbeSlot() throws {
        let core = try makeCore(probe: makeProbe())
        let snapshotId = try takeSnapshot(core)

        let compare = try core.restore(snapshotId: snapshotId, steps: nil, mode: nil)
        XCTAssertEqual(compare["confirmed"] as? Int, 0)
        XCTAssertEqual(compare["consistent"] as? Bool, true)

        let step: (Selector, Action) = (Selector(role: "AXButton", title: "Submit"), .press)
        let ffwd = try core.restore(snapshotId: snapshotId, steps: [step], mode: nil)
        XCTAssertEqual(ffwd["confirmed"] as? Int, 1)

        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: nil, mode: "restore_snapshot"))
    }

    /// P5 §6.4: rollback_full registers an approval record through the
    /// batch-1 hook.
    func testRollbackFullRegistersApproval() throws {
        let gate = ApprovalGate()
        let core = try makeCore(probe: makeProbe(), gate: gate)
        let snapshotId = try takeSnapshot(core)
        _ = try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")
        XCTAssertEqual(gate.count, 1)
        XCTAssertEqual(gate.chain().first?.operationType, "restore")
        XCTAssertEqual(gate.chain().first?.riskTier, .high)
        XCTAssertTrue(gate.chain().first?.reason.contains("rollback_full") == true)
    }
}