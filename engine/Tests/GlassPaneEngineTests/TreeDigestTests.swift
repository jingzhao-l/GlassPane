import XCTest
@testable import GlassPaneEngine

/// A5: tree digest stability and structural sensitivity (P0 spec §3.3).
final class TreeDigestTests: XCTestCase {

    func testDigestIsStableAcrossIdenticalTrees() throws {
        let treeA = AxNode(role: "AXWindow", title: "W", children: [
            AxNode(role: "AXButton", title: "B", identifier: "b"),
        ])
        let treeB = AxNode(role: "AXWindow", title: "W", children: [
            AxNode(role: "AXButton", title: "B", identifier: "b"),
        ])
        XCTAssertEqual(try TreeDigest.digest([treeA]), try TreeDigest.digest([treeB]))
    }

    func testDigestIsDeterministicForRepeatedCalls() throws {
        let tree = TestTrees.standard.roots
        XCTAssertEqual(try TreeDigest.digest(tree), try TreeDigest.digest(tree))
    }

    func testChildOrderChangesDigest() throws {
        let first = AxNode(role: "r", children: [
            AxNode(role: "a"), AxNode(role: "b"),
        ])
        let second = AxNode(role: "r", children: [
            AxNode(role: "b"), AxNode(role: "a"),
        ])
        XCTAssertNotEqual(
            try TreeDigest.digest([first]),
            try TreeDigest.digest([second])
        )
    }

    func testTitleChangeChangesDigest() throws {
        XCTAssertNotEqual(
            try TreeDigest.digest(TestTrees.standard.roots),
            try TreeDigest.digest(TestTrees.buttonRetitled.roots)
        )
    }

    func testEmptyTreeHasWellFormedDigest() throws {
        let digest = try TreeDigest.digest([])
        XCTAssertEqual(digest.count, TreeDigest.digestHexLength)
        XCTAssertTrue(digest.allSatisfy { $0.isHexDigit })
        XCTAssertEqual(digest, digest.lowercased())
    }

    func testDigestIs32HexCharacters() throws {
        let digest = try TreeDigest.digest(TestTrees.standard.roots)
        XCTAssertEqual(digest.count, TreeDigest.digestHexLength)
        XCTAssertTrue(digest.allSatisfy { $0.isHexDigit })
    }

    func testNodeCountCountsWholeTree() {
        XCTAssertEqual(TreeDigest.nodeCount([]), 0)
        XCTAssertEqual(TreeDigest.nodeCount(TestTrees.standard.roots), 4)
        let nested = AxNode(role: "a", children: [
            AxNode(role: "b", children: [AxNode(role: "c")]),
        ])
        XCTAssertEqual(TreeDigest.nodeCount([nested]), 3)
    }
}
