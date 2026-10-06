import XCTest
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 面板跑 daemon 一次性 CLI 的那条通道：给出的结论必须来自 daemon 真正回过的话。
///
/// `glasspaned` 在**拒绝执行**的路径上把整份 JSON 报告写到 stderr（main.swift 里的
/// `to: .standardError`）——注册表读不开、id 不存在都是这一类。面板从前只读 stdout，
/// 于是那些结论一律读成空，然后给出一个凭"空"编出来的原因。
final class ConsoleCliChannelTests: XCTestCase {

    /// 真机症状复现：损坏的 projects.json 被报成"后台服务不认得 --project-prune"。
    func testPruneRefusalThatOnlyAppearsOnStderrIsNotReportedAsAnUnknownFlag() {
        let refusal = """
        {"command":"--project-prune","dryRun":false,"loadFailed":true,"total":3,"matched":0,\
        "pruned":0,"failed":0,"remaining":3,"requiresDaemonRestart":false,\
        "error":"projects.json cannot be read back, so nothing was written"}
        """
        let message = ConsoleModel.pruneActionMessage(
            cliRan: true, stdout: "", stderr: refusal, exitCode: 1
        )
        XCTAssertTrue(message.contains("注册表文件读不开"), message)
        XCTAssertFalse(message.contains("不认得"), "那是一次幻影原因：\(message)")
        XCTAssertFalse(message.contains("没有需要清理"), "读不开不等于干净：\(message)")
    }

    /// 未知 id 是最日常的一条拒绝，它同样只在 stderr（退出码 3）。
    func testRemoveUnknownIdAnsweredOnlyOnStderrStillSaysNotFound() {
        let refusal = """
        {"command":"--project-remove","dryRun":false,"loadFailed":false,"found":false,\
        "removed":false,"remaining":3,"projectId":"gp-demo","error":"no project gp-demo is registered"}
        """
        let message = ConsoleModel.removeActionMessage(
            cliRan: true, stdout: "", stderr: refusal, exitCode: 3
        )
        XCTAssertTrue(message.contains("没找到这个项目"), message)
        XCTAssertFalse(message.contains("不认得"), message)
    }

    func testRemoveRefusalForUnreadableRegistryIsNotAMissingProject() {
        let refusal = """
        {"command":"--project-remove","dryRun":false,"loadFailed":true,"found":false,\
        "removed":false,"remaining":0,"projectId":"gp-demo"}
        """
        let message = ConsoleModel.removeActionMessage(
            cliRan: true, stdout: "", stderr: refusal, exitCode: 1
        )
        XCTAssertTrue(message.contains("注册表文件读不开"), message)
        XCTAssertFalse(message.contains("没找到这个项目"), "报成 id 不存在会让人去改 id：\(message)")
    }

    /// 真的没被理解时（两路都没有 JSON 形状）仍要说"没按形状回"，并把后台服务的
    /// 原话带上——"不认得这条命令"只是那种情形的一个猜测。
    func testUnshapedReplyKeepsTheNotUnderstoodVerdictAndQuotesTheDaemon() {
        let help = "glasspaned: 未知开关 --project-prune（见 --help）"
        let message = ConsoleModel.pruneActionMessage(
            cliRan: true, stdout: "", stderr: help, exitCode: 64
        )
        XCTAssertTrue(message.contains("不认得"), message)
        XCTAssertTrue(message.contains("未知开关 --project-prune"),
                      "daemon 真正说过的话必须能被读到：\(message)")
    }

    /// stdout 有形状时它优先，stderr 的噪声不得混进结论。
    func testWellFormedStdoutWinsOverStderrNoise() {
        let message = ConsoleModel.pruneActionMessage(
            cliRan: true,
            stdout: #"{"matched":2,"pruned":2,"failed":0,"loadFailed":false,"requiresDaemonRestart":true}"#,
            stderr: "a warning about something else",
            exitCode: 0
        )
        XCTAssertTrue(message.contains("已清理 2 条"), message)
        XCTAssertFalse(message.contains("a warning"), message)
    }

    /// 反向变异：把 stderr 原样贴进结论 → ESC/贝声会跟着被复制进终端与报告（R5-03）。
    func testDaemonWordsNeverCarryRawTerminalControlCharacters() {
        let hostile = "bad\u{1b}]52;c;SEVMTE8=\u{7}\nsecond line"
        XCTAssertTrue(AgentText.containsTerminalControlText(hostile))
        let quoted = ConsoleModel.quoteDaemonWords(hostile)
        XCTAssertFalse(AgentText.containsTerminalControlText(quoted), quoted)
        XCTAssertTrue(quoted.contains("\\u001B"), "控制字符要可见，不是被悄悄删掉：\(quoted)")
        XCTAssertTrue(quoted.contains("second line"))
        XCTAssertTrue(ConsoleModel.quoteDaemonWords("   \n  ").isEmpty, "空白不算一句原话")
    }

    /// 真子进程：只写 stderr 的命令，它的文字必须真的回到面板手里（管道被读过）。
    func testRunDaemonCLIReadsTheStderrOfAChildThatWritesNothingToStdout() throws {
        let run = try XCTUnwrap(ConsoleModel.runDaemonCLI(
            binary: "/bin/ls",
            arguments: ["/glasspane-no-such-path-here"],
            timeoutSeconds: 15
        ))
        XCTAssertNotEqual(run.status, 0)
        XCTAssertTrue(run.output.isEmpty, "ls 失败时 stdout 本来就是空的")
        XCTAssertFalse(run.errorOutput.isEmpty, "stderr 没被读过，正是面板那个空结果的来源")
        let reply = ConsoleModel.cliReply(run)
        XCTAssertTrue(reply.isEmpty, "没有 JSON 形状时退回 stdout（空），不把 stderr 当结论")
        let message = ConsoleModel.pruneActionMessage(
            cliRan: true, stdout: run.output, stderr: run.errorOutput, exitCode: run.status
        )
        XCTAssertTrue(
            message.contains("不认得") && message.contains(run.errorOutput.trimmingCharacters(in: .whitespacesAndNewlines)),
            "结论里要能查到 daemon 到底说了什么：\(message)"
        )
    }

    /// 命令起不来时不给"未执行成功"编一个原因，也绝不引用不存在的原话。
    func testMissingBinaryIsReportedAsNotRun() {
        XCTAssertNil(ConsoleModel.runDaemonCLI(binary: nil, arguments: ["--project-prune"]))
        let message = ConsoleModel.pruneActionMessage(
            cliRan: false, stdout: "", stderr: "", exitCode: -1
        )
        XCTAssertTrue(message.contains("没能跑起来"), message)
    }
}
