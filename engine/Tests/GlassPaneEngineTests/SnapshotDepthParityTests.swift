import XCTest
@testable import GlassPaneEngine

/// §1.2 — a tree digest is a digest of a tree walked to one specific depth, so a
/// baseline at depth 3 and a re-read at depth 6 are two different measurements
/// of two different trees. `restore` compared them anyway, and nothing on either
/// side recorded the depth, so an untouched app answered `consistent: false`.
final class SnapshotDepthParityTests: XCTestCase {

    private func makeCore(channel: ScriptedChannel) throws -> EngineCore {
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        return core
    }

    func testRestoreReCapturesAtTheDepthTheBaselineUsed() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = try makeCore(channel: channel)

        let snapshot = try core.snapshot(maxDepth: 3)
        let snapshotId = try XCTUnwrap(snapshot["snapshotId"] as? String)
        XCTAssertEqual(
            snapshot["captureDepth"] as? Int, 3,
            "the digest is keyed to the depth it was taken at, so the answer says which depth"
        )

        _ = try core.restore(snapshotId: snapshotId, steps: nil)
        XCTAssertEqual(
            channel.treeDepths, [3, 3],
            "baseline capture and the restore re-read must ask for the same depth; got \(channel.treeDepths)"
        )
    }

    func testUntouchedAppIsConsistentWhenTheBaselineWasShallow() throws {
        // The real channel answers depth 3 with a shallower tree — and therefore
        // a different digest — than depth 6. Scripted that way, the old
        // hard-coded depth 6 re-read reported an untouched app as inconsistent.
        let shallow = TestTrees.snapshot([
            AxNode(role: "AXWindow", title: "Main", children: [
                AxNode(role: "AXButton", title: "Submit", identifier: "submit-button")
            ])
        ])
        let deep = TestTrees.standard
        XCTAssertNotEqual(shallow.digest, deep.digest, "the fixture must actually differ by depth")

        let channel = ScriptedChannel(fallbackTree: deep)
        channel.treeResults = [.success(shallow), .success(shallow)]
        let core = try makeCore(channel: channel)

        let snapshot = try core.snapshot(maxDepth: 2)
        let snapshotId = try XCTUnwrap(snapshot["snapshotId"] as? String)
        let restore = try core.restore(snapshotId: snapshotId, steps: nil)
        XCTAssertEqual(
            restore["consistent"] as? Bool, true,
            "the app never moved; comparing the same depth against itself must not invent a change"
        )
        XCTAssertEqual(restore["comparedDepth"] as? Int, 2)
        XCTAssertEqual(restore["targetDigest"] as? String, shallow.digest)
    }

    func testDefaultDepthBaselineStillComparesAtTheDefaultDepth() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = try makeCore(channel: channel)

        let snapshot = try core.snapshot(maxDepth: EngineCore.defaultObserveDepth)
        let snapshotId = try XCTUnwrap(snapshot["snapshotId"] as? String)
        XCTAssertEqual(snapshot["captureDepth"] as? Int, EngineCore.defaultObserveDepth)

        let restore = try core.restore(snapshotId: snapshotId, steps: nil)
        XCTAssertEqual(restore["consistent"] as? Bool, true)
        XCTAssertEqual(channel.treeDepths, [6, 6], "the default path keeps its shape: \(channel.treeDepths)")
    }

    func testRollForwardComparesAtTheBaselineDepthToo() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        let core = try makeCore(channel: channel)

        let snapshot = try core.snapshot(maxDepth: 5)
        let snapshotId = try XCTUnwrap(snapshot["snapshotId"] as? String)
        _ = try core.restore(
            snapshotId: snapshotId,
            steps: [(Selector(role: "AXButton", title: "Submit"), .press)],
            mode: nil
        )
        // Depth 5 baseline, depth 5 re-read after the steps — never the engine default.
        XCTAssertEqual(channel.treeDepths.last, 5, "got \(channel.treeDepths)")
    }
}
