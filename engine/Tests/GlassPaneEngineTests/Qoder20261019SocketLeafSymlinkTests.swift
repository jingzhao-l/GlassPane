import XCTest
@testable import GlassPaneEngine

/// 2026-10-19, the socket directory's own type.
///
/// `SocketDirectoryRule.enforce` measured the directory the socket lands in — owner,
/// mode 0700, ancestors — but every one of those syscalls (`chmod`, `stat`, `bind`)
/// **follows** a symlink at the end of the path, while the ancestor walk is handed the
/// link's own path string. A state root named `/Users/me/.glasspane` whose leaf links to
/// a directory elsewhere therefore passed: the target can be owned and 0700 while the
/// parents of the *real* location were never asked whether another account can create
/// names there — which is the exact failure this file's ancestor half was written to
/// close. The evidence archive side already refuses the shape for the same reason
/// (`EvidenceStore.nameIsUsableArchiveDirectory`, "chmod 会跟着符号链接走").
final class Qoder20261019SocketLeafSymlinkTests: XCTestCase {

    /// Per-instance: `TestSandbox.directory` hands out a fresh process-private path, and
    /// the property is a plain `String` because interpolating an optional into a path
    /// silently produces `Optional("…")/…` — a *relative* path that Foundation happily
    /// creates somewhere beside the working directory, which is both a broken assertion
    /// and the exact hole the isolation gate exists to catch.
    private let work = TestSandbox.directory("socket-root")

    override func setUpWithError() throws {
        chmod(work, 0o700)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: work)
        super.tearDown()
    }

    private func real(_ name: String) throws -> String {
        let dir = work + "/" + name
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        chmod(dir, 0o700)
        return dir
    }

    private func link(named leaf: String, to target: String) -> String {
        let path = work + "/" + leaf
        if FileManager.default.fileExists(atPath: path) { try? FileManager.default.removeItem(atPath: path) }
        symlink(target, path)
        return path
    }

    /// The refusal itself: a leaf symlink is named as a leaf symlink, says the socket
    /// would be bound *through* it, and does not follow it to measure the target.
    func testLeafSymlinkIsRefusedWithoutFollowingIt() throws {
        let target = try real("target")
        let leaf = link(named: "state", to: target)
        let defect = try XCTUnwrap(
            SocketDirectoryRule.enforce(directory: leaf),
            "叶子是符号链接时这道规则放过了它——chmod/stat/bind 都跟着走，父链检查看的却是这条路径本身"
        )
        XCTAssertTrue(defect.contains("symlink"), defect)
        XCTAssertFalse(defect.contains("is not a directory"), "符号链接不能被报成\"不是目录\"，那是另一句假话：\(defect)")
        XCTAssertTrue(
            defect.contains("--state-dir"),
            "拒绝必须给出人能直接执行的动作，不是只宣布失败：\(defect)"
        )
        // Following it would have chmod'd the target; the refusal must leave it alone.
        var info = stat()
        XCTAssertEqual(lstat(target, &info), 0)
        XCTAssertEqual(Int(info.st_mode & 0o777), 0o700, "拒绝分支不许先把目标改了再说不合法")
    }

    /// Control, the arm that keeps this from being a rule that refuses everything: a real
    /// directory owned by this account at 0700 still passes exactly as it did.
    func testRealDirectoryStillPasses() throws {
        let dir = try real("plain")
        XCTAssertNil(SocketDirectoryRule.enforce(directory: dir),
                     SocketDirectoryRule.enforce(directory: dir) ?? "nil")
    }

    /// A missing leaf is the ordinary "the daemon creates it" case, not a symlink case —
    /// refusing here would break every first run.
    func testAbsentLeafIsNotARefusal() throws {
        XCTAssertNil(SocketDirectoryRule.leafSymlinkDefect(work + "/not-there"))
    }

    /// A symlink in the **middle** of the path is a different matter and must not be
    /// refused here: macOS itself lays temporary directories out that way (`/var` →
    /// `/private/var`), and refusing it would break every real install. What that case
    /// still has to survive is the ancestor walk, which is why the leaf is measured where
    /// it actually lands.
    func testAncestorSymlinkIsNotTheLeafCase() throws {
        let realParent = try real("realparent")
        // The leaf exists here: this case is about a path that *reaches* a directory
        // through a symlink in the middle (how macOS itself lays out `/var` →
        // `/private/var`), not about creating one.
        let inside = "\(realParent)/state"
        try FileManager.default.createDirectory(atPath: inside, withIntermediateDirectories: true)
        chmod(inside, 0o700)
        let alias = link(named: "alias", to: realParent)
        let leaf = "\(alias)/state"
        XCTAssertNil(SocketDirectoryRule.enforce(directory: leaf), SocketDirectoryRule.enforce(directory: leaf) ?? "nil")
        var info = stat()
        XCTAssertEqual(stat(inside, &info), 0, "中间符号链接后面的目录照样量得到：\(inside)")
        XCTAssertEqual(Int(info.st_mode & 0o777), 0o700)
    }

    /// The leaf link is refused *before* anything is written, so a planted symlink cannot
    /// end up with a socket in the directory it points at.
    func testRefusalHappensBeforeAnythingIsBound() throws {
        let target = try real("unbound-target")
        let leaf = link(named: "state", to: target)
        _ = SocketDirectoryRule.enforce(directory: leaf)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: "\(target)/engine.sock"),
            "拒绝分支还是跟着符号链接在目标里落了东西，那这句拒绝不算拒绝"
        )
    }
}
