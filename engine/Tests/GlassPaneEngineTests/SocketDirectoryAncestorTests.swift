import XCTest
@testable import GlassPaneEngine

/// The socket directory rule reached only the leaf. A `--state-dir` under a
/// directory another account owns (or that anybody can write) binds a private
/// socket into a public path: the owner of the ancestor can move `st` aside and
/// answer clients that connect by name, while the daemon keeps serving a
/// descriptor nobody can reach.
final class SocketDirectoryAncestorTests: XCTestCase {

    func testIsolationTable() {
        let me = Int64(getuid())
        XCTAssertTrue(SocketDirectoryRule.ancestorIsIsolated(ownerUID: me, fullMode: 0o700, ourUID: me))
        XCTAssertTrue(
            SocketDirectoryRule.ancestorIsIsolated(ownerUID: me, fullMode: 0o755, ourUID: me),
            "readable-by-others is not writable-by-others; /Users and ~/.glasspane's parents look like this"
        )
        XCTAssertTrue(SocketDirectoryRule.ancestorIsIsolated(ownerUID: 0, fullMode: 0o755, ourUID: me), "root's system levels")
        XCTAssertTrue(
            SocketDirectoryRule.ancestorIsIsolated(ownerUID: 0, fullMode: 0o1777, ourUID: me),
            "/tmp: world-writable, and the sticky bit is precisely what stops another account renaming my directory away"
        )
        XCTAssertFalse(
            SocketDirectoryRule.ancestorIsIsolated(ownerUID: me, fullMode: 0o757, ourUID: me),
            "group-writable without sticky: the group can move the socket directory aside"
        )
        XCTAssertFalse(SocketDirectoryRule.ancestorIsIsolated(ownerUID: me, fullMode: 0o777, ourUID: me))
        XCTAssertFalse(
            SocketDirectoryRule.ancestorIsIsolated(ownerUID: me + 1, fullMode: 0o755, ourUID: me),
            "a foreign account, however tidy its mode, is the one that can replace the file"
        )
        XCTAssertFalse(SocketDirectoryRule.ancestorIsIsolated(ownerUID: me + 1, fullMode: 0o700, ourUID: me))
    }

    func testRealAncestorThatBecomesGroupWritableRefusesThePath() throws {
        let parent = TestSandbox.directory("ancestor-parent")
        let leaf = parent + "/st"
        XCTAssertNoThrow(try FileManager.default.createDirectory(atPath: leaf, withIntermediateDirectories: true))
        chmod(parent, 0o700)
        XCTAssertNil(SocketDirectoryRule.ancestorDefect(for: leaf), "an owner-only ancestor is the ordinary case")

        chmod(parent, 0o777)
        let defect = SocketDirectoryRule.ancestorDefect(for: leaf)
        XCTAssertNotNil(defect, "chmod 0777 on the ancestor must be caught")
        XCTAssertTrue(defect?.contains(parent) == true, "the refusal has to name the directory: \(defect ?? "nil")")
        XCTAssertTrue(
            defect?.contains("--state-dir") == true,
            "and give the reader the next action it can run: \(defect ?? "nil")"
        )
        chmod(parent, 0o700)
        XCTAssertNil(SocketDirectoryRule.ancestorDefect(for: leaf), "the rule reads the mode, not a memory of it")
    }

    func testHomeDefaultPassesTheAncestorRule() throws {
        // The documented default is `~/.glasspane`. Refusing it would be a P0 of its
        // own (every installed daemon fails to start), so this is checked, not assumed.
        let homeSocket = StateRoot.engineSocketPath(explicitSocketPath: nil, stateRoot: nil)
        let directory = (homeSocket as NSString).deletingLastPathComponent
        XCTAssertNil(
            SocketDirectoryRule.ancestorDefect(for: directory),
            "the machine's own default state root must satisfy the rule: \(SocketDirectoryRule.ancestorDefect(for: directory) ?? "nil")"
        )
    }

    func testUnreadableAncestorIsUnprovenRatherThanPassed() {
        let missing = TestSandbox.pendingDirectory("ancestor-missing") + "/does-not-exist"
        let defect = SocketDirectoryRule.ancestorDefect(for: missing)
        XCTAssertNotNil(defect, "a path that cannot be examined has not been shown to be isolated")
        XCTAssertTrue(defect!.contains("unproven"), defect!)
    }
}
