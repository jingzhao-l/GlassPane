import XCTest
@testable import GlassPaneEngine

/// 一次性 launchd 任务留在磁盘上的两件东西，模式不许由别人的 umask 决定。
///
/// `SettingsModel.runOneShot` 写一个 zsh 脚本、交给 `launchctl submit` 以本用户的上下文执行，
/// 脚本里用 `>` 重定向出 `--permissions` 的读数（主体路径、pid、四张席位的判决）。从前脚本
/// 被 chmod 成 0755，而输出文件根本没被面板创建过——它的模式因此是**那个执行上下文的 umask**
/// 决定的。这两件事叠在一起的窗口不是抽象的：目录闸 `StateRoot.directoryIsolation` 拒的是
/// "同组/其他人可写"，一个 0755 的目录照样通过（`$TMPDIR` 被改指到别处时就是这样），于是
/// "0755 目录 + 0644 文件" 就是一份别人读得到的权限读数。引擎侧对同一类派生物早就要求
/// 0600（`EvidenceReportGenerator.swift:196-201`）。
///
/// 两条用例各盯一半：一条把这个修法依赖的**机制**在真 `/bin/sh` 与真 umask 下量出来（包括
/// 它不成立时该长什么样），一条盯住交付代码里那两个属性确实写了。
final class Qoder20261019OneShotFileModesTests: XCTestCase {

    private func mode(of path: String) throws -> Int {
        var info = stat()
        XCTAssertEqual(stat(path, &info), 0, "量不到 \(path) 的模式")
        return Int(info.st_mode & 0o777)
    }

    /// 跑一条真的 sh，先把 umask 设成面板以外没人会怀疑的值，再重定向出一个文件。
    private func redirect(withUmask umask: String, to path: String) throws {
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/sh")
        shell.arguments = ["-c", "umask \(umask); echo probe-reading > '\(path)'"]
        shell.standardOutput = FileHandle.nullDevice
        shell.standardError = FileHandle.nullDevice
        try shell.run()
        shell.waitUntilExit()
        XCTAssertEqual(shell.terminationStatus, 0, "重定向那趟没跑成，这条对照就没量到任何东西")
    }

    /// 机制本身：预先按 0600 建好文件，`>` 只会截断、不会把模式换回 umask 的那一份。
    /// 没有这条，"先建再重定向"就是一句没有读者相信的断言。
    func testShellRedirectKeepsAPreCreatedPrivateMode() throws {
        let dir = TestSandbox.directory("oneshot-dir")
        chmod(dir, 0o755)   // 目录闸接受的那个形状：可读、不可写
        XCTAssertEqual(try mode(of: dir), 0o755, "对照前提：目录必须是别人可读的，否则这组量不出暴露面")

        let preCreated = dir + "/reading-precreated.json"
        XCTAssertTrue(
            FileManager.default.createFile(
                atPath: preCreated, contents: Data(), attributes: [.posixPermissions: 0o600]),
            "面板那一步在这里就是 createFile(..., 0600)：建不出来，修法也就没跑")
        try redirect(withUmask: "022", to: preCreated)
        XCTAssertEqual(
            try mode(of: preCreated), 0o600,
            "重定向把预置的 0600 换掉了——那这条修法依赖的机制不成立，得改脚本内的 umask 而不是改创建")

        // 对照：不预置时，模式确实由那一趟的 umask 决定。这条红就意味着上面那条 0600 是白拿的。
        let naively = dir + "/reading-naive.json"
        try redirect(withUmask: "022", to: naively)
        XCTAssertEqual(
            try mode(of: naively), 0o644,
            "对照失效：默认 umask 下新建的输出不是 0644，那这条闸量的已不是那件事")
        XCTAssertNotEqual(try mode(of: naively), try mode(of: preCreated),
                          "预置与不预置必须量出差别，否则这条修法什么都没改变")
    }

    /// 交付代码那一半：脚本不再 owner 之外可读，输出在提交之前就被面板建好。
    func testOneShotWriterSetsBothModesItself() throws {
        let url = URL(fileURLWithPath: #filePath)
        let path = url.deletingLastPathComponent()
            .appendingPathComponent("Sources/glasspane-settings/SettingsModel.swift").path
        let source = try String(contentsOfFile: path, encoding: .utf8)
        let start = try XCTUnwrap(
            source.range(of: "nonisolated private static func runOneShot("),
            "一次性任务的执行面搬家了：这条闸要跟着搬，不许把它删掉")
        let end = try XCTUnwrap(
            source.range(of: "launchctl submit", range: start.upperBound..<source.endIndex),
            "找不到提交那一步，说明这一段的结构变了")
        let body = source[start.lowerBound..<end.lowerBound]

        XCTAssertFalse(body.contains("0o755"),
                       "一次性脚本又被 chmod 成 0755：它由同一个 uid 的 launchd 执行，owner 的 x 就够")
        XCTAssertTrue(body.contains("[.posixPermissions: 0o700]"),
                      "脚本要有显式的 owner-only 模式，不能靠建出来时的那一份默认：\(body)")
        XCTAssertTrue(body.contains("[.posixPermissions: 0o600]"),
                      "输出文件必须在提交之前由面板按 0600 建好，否则模式由那一趟的 umask 决定：\(body)")
        let preCreate = try XCTUnwrap(
            body.range(of: "createFile("),
            "提交之前没有任何创建动作——那 0600 只是注释")
        let remove = body.range(of: "removeItem(atPath: outputPath)")
        XCTAssertLessThan(
            remove?.upperBound ?? body.startIndex, preCreate.lowerBound,
            "先删后建的顺序反了：重定向会自己建一个 umask 模式的文件，面板那份 0600 就永远不在那里")
    }
}
