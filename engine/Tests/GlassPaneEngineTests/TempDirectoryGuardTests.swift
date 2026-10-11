import XCTest
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 一次性 launchd 脚本落临时目录之前的属主/权限判定。
///
/// 安全审查抓出来的形状：面板把一份脚本写进 `NSTemporaryDirectory()`，chmod 0755，
/// 然后 `launchctl submit -l <label> -- <script> <daemonBinary> <outputPath> --permissions`
/// —— 那趟执行带的是 **daemon 自己的责任上下文**（`SettingsModel` 顶部就这么交代过：
/// 申请动作必须由 daemon 发起，否则席位记到面板头上）。而落盘之前没有任何一步问一句
/// "这个目录是谁的、别人能不能写"。`$TMPDIR` 被改指到共享位置（agent 宿主、
/// launchd 起的进程都可能）时，含时钟 nonce 的脚本名与输出名别的账号能预置。
/// 同一仓里 `SocketServer.prepareSocketDirectory` 与证据写入早就有这套判定，
/// 只是各写各的——所以这里把它收成一份（`StateRoot.directoryIsolation`）。
final class TempDirectoryGuardTests: XCTestCase {

    private func makeDirectory(_ name: String, mode: Int) -> String {
        let base = TestSandbox.directory("tempguard")
        let path = base + "/" + name
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: path)
        return path
    }

    func testUsableOnlyWhenOwnedAndNotSharablyWritable() {
        XCTAssertEqual(StateRoot.directoryIsolation(at: makeDirectory("private", mode: 0o700)), .usable)
        // 0755 是本用户拥有、同组与其他人只能读与进——不构成预置面
        XCTAssertEqual(StateRoot.directoryIsolation(at: makeDirectory("worldread", mode: 0o755)), .usable)
        XCTAssertEqual(
            StateRoot.directoryIsolation(at: makeDirectory("sticky", mode: 0o777)),
            .sharedWritable(mode: 0o777),
            "同组或其他人可写的临时目录必须被拒")
        XCTAssertEqual(
            StateRoot.directoryIsolation(at: makeDirectory("groupwrite", mode: 0o730)),
            .sharedWritable(mode: 0o730))
    }

    func testMissingAndNonDirectoryAreNamedSeparately() {
        XCTAssertEqual(
            StateRoot.directoryIsolation(at: TestSandbox.pendingDirectory("absent")), .missing,
            "目录还没建是全新机器上的正常形态，必须与「不合格」分开——一次性脚本那边要先建再判")
        let file = TestSandbox.directory("notadir") + "/afile"
        try? "x".data(using: .utf8)!.write(to: URL(fileURLWithPath: file))
        XCTAssertEqual(StateRoot.directoryIsolation(at: file), .notADirectory)
    }

    /// 判定不许有两份实现：两份就会有一处漏（这次漏的正是一次性脚本那处）。
    /// 要求的是**调用式**（`…(at:`）而不是裸标识符——注释里提一句函数名不算调用，
    /// 只查裸名字的断言会被一段说明文字喂绿。
    func testThePanelHasNoHandRolledOwnershipCheck() throws {
        for file in ["engine/Sources/glasspane-settings/SettingsModel.swift",
                     "engine/Sources/GlassPaneEngine/EvidenceReportGenerator.swift"] {
            let text = try source(file)
            XCTAssertTrue(text.contains("StateRoot.directoryIsolation(at:"),
                "\(file) 不再调用那份共同判定：又长出一个各写各的版本（或干脆不判）")
            XCTAssertFalse(text.contains("st_mode & 0o022"),
                "\(file) 里还留着自己算权限位的第二份实现")
        }
    }

    /// 一次性任务必须在**写脚本之前**判目录，且拒绝要成为独立结局。
    func testOneShotChecksTheDirectoryBeforeItWritesTheScript() throws {
        let text = try source("engine/Sources/glasspane-settings/SettingsModel.swift")
        guard let start = text.range(of: "private static func runOneShot"),
              let write = text.range(of: "script.write(to:") else {
            return XCTFail("runOneShot 或那句 script.write 不在了：这条闸要重新对着新形状写")
        }
        XCTAssertLessThan(start.lowerBound, write.lowerBound, "读不到 runOneShot 的函数头")
        let between = text[start.lowerBound..<write.lowerBound]
        XCTAssertTrue(between.contains("StateRoot.directoryIsolation(at: directory)"),
            "runOneShot 又在写脚本之前不判目录了：预置脚本/输出的门重新打开")
        XCTAssertTrue(between.contains("return .directoryUnsafe("),
            "判出不合格却没有真的停下：拒绝分支必须是能走到的那一条")
        XCTAssertTrue(text.contains("case directoryUnsafe(String)"),
            "目录不合格必须是一个能单独读出来的结局，不许混进 writeFailed")
        XCTAssertTrue(text.contains("case .directoryUnsafe(let reason)"),
            "拒绝那一步要有面向用户的文案（换临时目录这个下一步只有代码知道）")
    }

    private func source(_ relative: String) throws -> String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        let path = url.appendingPathComponent(relative).path
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(relative)；这一条对照在没有该文件的环境里不作数")
        }
        return text
    }
}
