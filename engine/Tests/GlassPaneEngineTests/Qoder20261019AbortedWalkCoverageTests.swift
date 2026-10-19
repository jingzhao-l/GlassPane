import XCTest
@testable import GlassPaneEngine

/// An aborted geometry walk must not hand the audit a denominator made only of what it
/// visited.
///
/// `AXChannel.swift:204` — `guard !aborted else { return }` inside the children loop —
/// drops every sibling after the abort point without producing a node for it. The
/// file's own comment (:159-166) names the consequence and the earlier bug
/// ("未走过的子树连一个节点都不产生…看过 5% 也能报出 ratio=1.00"), and the drop is still
/// there for the *budget-abort* path. `LayoutCoverage.ratio` (UILayoutAudit.swift:69) is
/// `measured / total` over those nodes, so a walk that reached one corner of a tree
/// published `ratio: 1.00` in the machine-readable payload with nothing beside it saying
/// the number was about the visited part only.
///
/// Two halves, and `complete` keeps its meaning: it is "the promised walk finished", not
/// "the walk was deep enough" — depth is the caller's declared scope (`captureDepth`), so
/// depth truncation must not become an incompleteness.
final class Qoder20261019AbortedWalkCoverageTests: XCTestCase {

    // MARK: - fixtures

    private func measuredNode(_ path: String, role: String = "AXGroup") -> AxGeometryNode {
        AxGeometryNode(
            path: path, role: role,
            geometry: .measured(AxFrame(x: 10, y: 10, width: 120, height: 60))
        )
    }

    /// The node shape a budget-aborted walk produces **today**: the elements it reached,
    /// and nothing at all for the siblings it never reached.
    private func sliverSnapshot() -> AxGeometrySnapshot {
        AxGeometrySnapshot(
            nodes: [measuredNode("0"), measuredNode("0/0", role: "AXButton")],
            window: AxFrame(x: 0, y: 0, width: 640, height: 480),
            latencyMs: 2,
            complete: false,
            stopReason: "the 10.0s accessibility budget ran out"
        )
    }

    /// The coverage block as the caller sees it: the audit result travels as JSON over
    /// the socket, so its machine-readable fields are what a reader can actually weigh.
    private func coverageOf(_ snapshot: AxGeometrySnapshot) throws -> [String: Any] {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackGeometry = snapshot
        let core = EngineCore(channel: channel, evidenceStore: nil, approvalGate: nil)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let payload = try core.auditUI(maxDepth: 6, minHitTargetPt: nil)
        return try XCTUnwrap(payload["coverage"] as? [String: Any])
    }

    // MARK: - the published number has to carry its scope

    /// A 1.00 ratio computed over a visited-only denominator is the lie; the payload must
    /// say, machine-readably and next to the number, which denominator it used.
    func testAbortedWalkCoverageStatesThatItsDenominatorIsTheVisitedPart() throws {
        let coverage = try coverageOf(sliverSnapshot())
        XCTAssertEqual(coverage["total"] as? Int, 2)
        XCTAssertEqual(coverage["measured"] as? Int, 2)
        XCTAssertEqual(try XCTUnwrap(coverage["ratio"] as? Double), 1.0, accuracy: 1e-9,
                       "the number the reader of this file gets today")
        XCTAssertEqual(
            coverage["walkComplete"] as? Bool, false,
            "ratio=1.00 here describes 2 visited nodes of a tree the walk never finished; "
                + "without a scope field the reader cannot tell that from full coverage: \(coverage)"
        )
    }

    /// The control that keeps the fix from being "never trust coverage": a complete walk
    /// whose every node answered still reports 1.00 — and now reports it as a claim about
    /// the whole walked tree.
    func testCompleteWalkStillReportsFullCoverage() throws {
        let coverage = try coverageOf(sliverSnapshotComplete())
        XCTAssertEqual(try XCTUnwrap(coverage["ratio"] as? Double), 1.0, accuracy: 1e-9)
        XCTAssertEqual(coverage["total"] as? Int, 2)
        XCTAssertEqual(coverage["walkComplete"] as? Bool, true)
    }

    private func sliverSnapshotComplete() -> AxGeometrySnapshot {
        AxGeometrySnapshot(
            nodes: [measuredNode("0"), measuredNode("0/0", role: "AXButton")],
            window: AxFrame(x: 0, y: 0, width: 640, height: 480),
            latencyMs: 2
        )
    }

    /// Depth truncation is a caller-declared scope, not an unfinished promise: a walk
    /// that stopped because it reached the depth it was told to use must not be
    /// described as incomplete (that would make `complete` mean two things and the
    /// aborted-walk caveat unreadable).
    func testDepthTruncationIsNotReportedAsAnIncompleteWalk() throws {
        let snapshot = sliverSnapshotComplete()
        XCTAssertEqual(try coverageOf(snapshot)["walkComplete"] as? Bool, true)
        let result = UILayoutAudit.audit(snapshot)
        XCTAssertFalse(
            result.findings.contains { $0.rule == "geometryScanIncomplete" },
            "a finished walk must not be described as unfinished: \(result.findings.map(\.rule))"
        )
    }

    /// The aborted snapshot's own finding is still there (it was the only caveat, and it
    /// lives in prose while the ratio is a field): the fix adds the field, it does not
    /// move the sentence into a number.
    func testAbortedWalkStillNamesItsIncompleteness() {
        let result = UILayoutAudit.audit(sliverSnapshot())
        XCTAssertTrue(
            result.findings.contains { $0.rule == "geometryScanIncomplete" },
            result.findings.map(\.rule).description
        )
    }

    // MARK: - walk side: the accounting the denominator can actually see

    /// The abort point must produce one counted node per unreached sibling — that is the
    /// only form in which the audit can learn the subtree exists.
    func testUnvisitedSubtreeNodesCountEveryRemainingSibling() {
        let nodes = AXChannel.unvisitedSubtreeNodes(
            parentLabel: "0", startingAt: 1, childCount: 5, reason: "the 10.0s budget ran out"
        )
        XCTAssertEqual(nodes.count, 4, "siblings 1...4 were never reached")
        XCTAssertEqual(nodes.map(\.path), ["0/1", "0/2", "0/3", "0/4"])
        XCTAssertTrue(
            nodes.allSatisfy { $0.role == AXChannel.unreadSubtreeRole },
            "a placeholder must self-report as one, not as an element of the app"
        )
        for node in nodes {
            guard case let .unread(reason) = node.geometry else {
                return XCTFail("an unreached subtree must be unread, got \(node.geometry)")
            }
            XCTAssertTrue(reason.contains("never visited"), reason)
            XCTAssertTrue(reason.contains("the 10.0s budget ran out"),
                          "the placeholder has to carry the cause, not just its own existence: \(reason)")
        }
        XCTAssertEqual(
            AXChannel.unvisitedSubtreeNodes(
                parentLabel: "0", startingAt: 3, childCount: 3, reason: "x"
            ).count,
            0, "a walk that stopped after the last child invents nothing"
        )
    }

    /// The consequence, on the audit's own numbers: with the placeholders the walk now
    /// leaves behind, a sliver cannot report full coverage — while the same nodes without
    /// them do, which is the shape this batch set out to close.
    func testPlaceholdersDropTheRatioBelowFullCoverage() {
        let reached = [measuredNode("0")]
        let unreached = AXChannel.unvisitedSubtreeNodes(
            parentLabel: "0", startingAt: 0, childCount: 19,
            reason: "the 10.0s accessibility budget ran out"
        )
        let asWalked = AxGeometrySnapshot(
            nodes: reached + unreached, window: AxFrame(x: 0, y: 0, width: 640, height: 480),
            latencyMs: 1, complete: false, stopReason: "the 10.0s accessibility budget ran out"
        )
        let walked = UILayoutAudit.audit(asWalked)
        XCTAssertEqual(walked.coverage.total, 20)
        XCTAssertEqual(walked.coverage.unread, 19)
        XCTAssertLessThan(walked.coverage.ratio, 0.2, "1 of 20 counted elements measured")

        let visitedOnly = AxGeometrySnapshot(
            nodes: reached, window: AxFrame(x: 0, y: 0, width: 640, height: 480),
            latencyMs: 1, complete: false, stopReason: "the 10.0s accessibility budget ran out"
        )
        XCTAssertEqual(UILayoutAudit.audit(visitedOnly).coverage.ratio, 1.0,
                       "the old shape: one node visited, nothing else counted, ratio 1.00")
    }

    // MARK: - walk side: the abort point has to leave a node per unreached subtree

    /// SHAPE GATE, not behavioural: reaching this branch needs a live `AXUIElement` whose
    /// subtree runs out the 10 s messaging budget, which no unit test can stage — the same
    /// reason `ReviewCoreATests` gates `installTap`'s read-back statically and
    /// `GeometryAuditDiagnosticTests` is opt-in. What is pinned is that the abort branch
    /// produces a node per unreached sibling instead of returning silently: the node is
    /// the only thing that can reach the coverage denominator.
    /// REVERSE: replace the placeholder append with a bare `return` → red here.
    func testAbortedWalkLeavesARecordForEveryUnreachedSibling() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("engine/Sources/GlassPaneEngine/AXChannel.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        guard let start = source.range(of: "private func walkGeometry(") else {
            return XCTFail("no walkGeometry in AXChannel.swift — this gate is looking at nothing")
        }
        let rest = source[start.upperBound...]
        let end = rest.range(of: "\n    ///") ?? rest.range(of: "\n    private func ")
        let body = String(rest[..<((end?.lowerBound) ?? rest.endIndex)])

        XCTAssertTrue(
            body.contains("guard !aborted else"),
            "the abort branch is gone: the sibling loop no longer stops on budget"
        )
        XCTAssertTrue(
            body.contains("unvisitedSubtreeNodes"),
            "the aborted sibling loop produces no node at all, so every unreached subtree "
                + "disappears from the coverage denominator (ratio 1.00 for a sliver)"
        )
        // The placeholders must be handed to the same `nodes` inout the walk returns
        // through — appending them anywhere else measures nothing.
        XCTAssertTrue(
            body.contains("nodes.append(contentsOf: Self.unvisitedSubtreeNodes"),
            "placeholders must enter the node stream the audit counts: \(body)"
        )
    }
}
