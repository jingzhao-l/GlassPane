import XCTest
@testable import GlassPaneEngine

/// The layout audit must publish the *scope* it measured (README's promise about the
/// `audit_ui` result fields).
///
/// `EngineCore.auditUI` (EngineCore.swift:1409-1440) hands back `complete`,
/// `stopReason`, `overlapScanTruncated` and `coverage` as machine-readable fields, but
/// not the depth the walk actually ran at, while `EngineCore.snapshot` (:2012) publishes
/// `captureDepth` for exactly this reason ("a digest is a digest of a tree walked to one
/// specific depth" — `SnapshotDepthParityTests`). A caller that omits `maxDepth`
/// therefore reads "verdict: pass, complete: true" with no way to learn that the answer
/// came from a depth-2 walk. The field is the depth the walk was **allowed** to use,
/// named the way `snapshot` names it.
final class Qoder20261019AuditDepthFieldTests: XCTestCase {

    private func makeCore() throws -> (EngineCore, ScriptedChannel) {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackGeometry = AxGeometrySnapshot(
            nodes: [
                AxGeometryNode(
                    path: "0", role: "AXButton",
                    geometry: .measured(AxFrame(x: 40, y: 40, width: 88, height: 44))
                ),
            ],
            window: AxFrame(x: 0, y: 0, width: 640, height: 480),
            latencyMs: 3
        )
        let core = EngineCore(channel: channel, evidenceStore: nil, approvalGate: nil)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        return (core, channel)
    }

    /// The defect: no field says which depth produced the verdict.
    func testAuditPayloadPublishesTheDepthTheWalkWasAllowedToUse() throws {
        let (core, channel) = try makeCore()
        let payload = try core.auditUI(maxDepth: 6, minHitTargetPt: nil)
        XCTAssertEqual(
            payload["captureDepth"] as? Int, 6,
            "the audit result must name the scope it measured, the way snapshot does"
        )
        XCTAssertEqual(channel.geometryCallCount, 1, "the walk really ran")
    }

    /// The value tracks the call rather than being a constant: a second audit at a
    /// different declared depth reports that other depth.
    func testAuditDepthFieldTracksTheDeclaredScope() throws {
        let (core, _) = try makeCore()
        XCTAssertEqual(try core.auditUI(maxDepth: 2, minHitTargetPt: nil)["captureDepth"] as? Int, 2)
        XCTAssertEqual(try core.auditUI(maxDepth: 9, minHitTargetPt: nil)["captureDepth"] as? Int, 9)
    }

    /// Naming has to match the field that already carries this fact for the same kind of
    /// measurement; inventing a second name for "the depth I walked to" is how two
    /// readers end up disagreeing about one walk.
    func testDepthFieldNameMatchesTheSnapshotFace() throws {
        let (core, _) = try makeCore()
        let snapshot = try core.snapshot(maxDepth: 4)
        let audit = try core.auditUI(maxDepth: 4, minHitTargetPt: nil)
        XCTAssertEqual(snapshot["captureDepth"] as? Int, 4, "snapshot keeps publishing its depth")
        XCTAssertEqual(audit["captureDepth"] as? Int, 4)
        XCTAssertEqual(
            snapshot.keys.contains("captureDepth"), audit.keys.contains("captureDepth"),
            "one fact, one name on both faces"
        )
    }

    /// The other machine-readable scope fields keep working (control for the field
    /// above: the payload is not being rewritten around one new key).
    func testOtherScopeFieldsAreStillPublished() throws {
        let (core, _) = try makeCore()
        let payload = try core.auditUI(maxDepth: 6, minHitTargetPt: nil)
        XCTAssertEqual(payload["complete"] as? Bool, true)
        XCTAssertNotNil(payload["coverage"])
        XCTAssertNotNil(payload["overlapScanTruncated"])
        XCTAssertNotNil(payload["latencyMs"])
    }

    /// Honesty bound for the new field: `captureDepth` is the depth the walk was
    /// *allowed*, not a claim that the tree was that deep. A walk that stopped early
    /// still says which depth it was asked for, and says separately that it did not
    /// finish — the two must not be collapsed into each other.
    func testDepthAndCompletenessStayTwoDifferentFacts() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackGeometry = AxGeometrySnapshot(
            nodes: [
                AxGeometryNode(
                    path: "0", role: "AXButton",
                    geometry: .measured(AxFrame(x: 40, y: 40, width: 88, height: 44))
                ),
            ],
            window: AxFrame(x: 0, y: 0, width: 640, height: 480),
            latencyMs: 3,
            complete: false,
            stopReason: "the 10.0s accessibility budget ran out"
        )
        let core = EngineCore(channel: channel, evidenceStore: nil, approvalGate: nil)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let payload = try core.auditUI(maxDepth: 7, minHitTargetPt: nil)
        XCTAssertEqual(payload["captureDepth"] as? Int, 7)
        XCTAssertEqual(payload["complete"] as? Bool, false)
    }
}
