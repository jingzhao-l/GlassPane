import XCTest
@testable import GlassPaneEngine

/// 面板「打开报告」那一份落盘副本的隔离性。
///
/// 修之前是 `try? data.write(to: url)`，`url` 为
/// `临时目录/glasspane-evidence-<operationId>.html`：umask 给出 **0644**（本机任意
/// 进程都能读），名字**人人可猜**（谁先占住这个名字、包括放一个 symlink，就被照着写），
/// 内容里带着被测应用的界面文本，而且永远不落进 `~/.glasspane` 那套被 §2.4 交代过的
/// 权限收紧与清理规则里。SECURITY 那节又写着"这一面不写报告副本"——文案与代码相反。
final class ReportWriteIsolationTests: XCTestCase {

    private var scratch: URL!

    override func setUpWithError() throws {
        // 沙盒里再开一个 0700 的子目录当"合格目录"：判定要求"属于本用户且同组/其他人
        // 写不动"，而沙盒目录的模式随进程 umask 变化——把合格样本的形状固定下来，
        // 这一条闸测的才是判定本身。
        let base = TestSandbox.directory("report")
        let root = URL(fileURLWithPath: base + "/private")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        scratch = root
    }

    override func tearDown() {
        if let scratch { try? FileManager.default.removeItem(at: scratch) }
    }

    private func mode(of path: String) -> Int {
        var info = stat()
        guard stat(path, &info) == 0 else { return -1 }
        return Int(info.st_mode & 0o777)
    }

    func testReportLandsOwnerOnlyWithItsExactBytes() throws {
        let html = "<div class=\"gp-evidence\">界面文本 · <按钮标签></div>"
        let outcome = EvidenceReportGenerator.writePrivateHTMLReport(
            html, operationId: "op_abcdefghij1234567890ABCD", directory: scratch)
        guard case .written(let path) = outcome else {
            return XCTFail("在 0700 目录里应当写成本地报告，实到 \(outcome)")
        }
        XCTAssertEqual(mode(of: path), 0o600, "报告里是被测应用的界面文本，不许按 umask 的 0644 落盘")
        let read = try String(contentsOfFile: path, encoding: .utf8)
        XCTAssertEqual(read, html, "写了一半就交出去，等于把残缺当报告")
    }

    /// 名字不可预测是"抢占"唯一的解法：撞名重试不解决 symlink 预置。
    func testSuccessiveReportsDoNotReuseOneGuessableName() throws {
        var paths: Set<String> = []
        for _ in 0..<3 {
            guard case .written(let path) = EvidenceReportGenerator.writePrivateHTMLReport(
                "<p>x</p>", operationId: "op_abcdefghij1234567890ABCDE", directory: scratch) else {
                return XCTFail("三次写入都应成功")
            }
            paths.insert(path)
        }
        XCTAssertEqual(paths.count, 3, "同一个 operationId 的报告反复打开必须各占一个名字：复用同一个名字就是把抢占的门留着")
        for path in paths {
            XCTAssertTrue((path as NSString).lastPathComponent.hasPrefix("glasspane-evidence-op_"), path)
        }
    }

    /// 一个占住的 symlink 不该被跟着写：独占创建在它上面直接失败并换个名字。
    func testAPlantedSymlinkIsNotWrittenThrough() throws {
        let victim = scratch.appendingPathComponent("victim.txt")
        try "canary".data(using: .utf8)!.write(to: victim)
        // 目录里预置一堆同名前缀的链接，模拟"攻击者已经知道名字"的最坏情况。
        for index in 0..<16 {
            let link = scratch.appendingPathComponent(
                "glasspane-evidence-op_\(String(repeating: "A", count: 26))-\(index).html")
            try? FileManager.default.createSymbolicLink(
                at: link, withDestinationURL: victim)
        }
        guard case .written(let path) = EvidenceReportGenerator.writePrivateHTMLReport(
            "<p>report</p>", operationId: "op_" + String(repeating: "A", count: 26), directory: scratch) else {
            return XCTFail("预置的链接不该挡住一次合法写入")
        }
        XCTAssertEqual(
            try String(contentsOf: victim, encoding: .utf8), "canary",
            "报告被写进了别人指好的那个文件里")
        XCTAssertNotEqual((path as NSString).lastPathComponent, victim.lastPathComponent)
    }

    func testSharedOrMissingDirectoryIsRefusedNotWritten() throws {
        let open = scratch.appendingPathComponent("shared")
        try FileManager.default.createDirectory(at: open, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: open.path)
        let defect = EvidenceReportGenerator.reportDirectoryDefect(open.path)
        XCTAssertNotNil(defect, "同组/其他人可写的临时目录必须被拒：那等于把报告交给本机所有账号")
        XCTAssertTrue(defect!.contains("同组或其他人可写"), defect ?? "nil")

        let file = scratch.appendingPathComponent("afile.html")
        try "x".data(using: .utf8)!.write(to: file)
        XCTAssertNotNil(EvidenceReportGenerator.reportDirectoryDefect(file.path),
                        "路径是个文件时不能说「目录没问题」")

        let missing = scratch.appendingPathComponent("nope")
        XCTAssertNotNil(EvidenceReportGenerator.reportDirectoryDefect(missing.path))
        XCTAssertNil(EvidenceReportGenerator.reportDirectoryDefect(scratch.path),
                     "0700 且属于本用户的目录必须放行，否则这条闸只会一路拒绝")

        // 拒绝分支必须真的能走到调用方：目录不可用时不得回 .written。
        if case .written(let path) = EvidenceReportGenerator.writePrivateHTMLReport(
            "<p>x</p>", operationId: "op_abcdefghij1234567890ABCDE", directory: open) {
            XCTFail("同组可写目录里写出了报告：\(path)")
        }
    }
}
