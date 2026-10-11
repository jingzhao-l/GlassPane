import XCTest
@testable import GlassPaneEngine

/// 2026-10-11 续轮的引擎侧修复（`--socket-path` 两道校验、开发者工具卡的拒绝优先）。
///
/// `--project-prune` 读不回台账那一支的 `remaining: 0` / `projects: []` 也一并删掉了（同一形状的
/// 伪造数字，`--project-remove` 那条分支早就这么处理），但**这一支无法被确定性跑到**：它要求
/// 写成功而读回失败，而载荷又拼在 `main.swift` 里（executable target 不可 import，只能起真二进制，
/// 起真二进制又没法在中途把文件变得读不回）。所以那条修复按"少说一句没测过的话"处理，
/// 记在未验证清单里，不当成已交付的闸。
final class DailyRound20261011Batch2Tests: XCTestCase {

    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }
        return url.path
    }

    private var daemonBinary: String { repoRoot + "/.build/debug/glasspaned" }

    private func run(_ args: [String]) -> (status: Int32, out: String, err: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: daemonBinary)
        process.arguments = args
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try! process.run()
        let stdoutData = out.fileHandleForReading.readDataToEndOfFile()
        let stderrData = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus,
                String(data: stdoutData, encoding: .utf8) ?? "",
                String(data: stderrData, encoding: .utf8) ?? "")
    }

    // MARK: - --socket-path：开关样的值不再被吃掉，光文件名不再绕过 0700 父目录检查

    func testSocketPathRefusesAFlagLookingValueAndABareFileName() throws {
        XCTAssertTrue(FileManager.default.fileExists(atPath: daemonBinary), "真二进制不在：\(daemonBinary)")
        // 位置由 TestSandbox 给：自己伸手摸 NSTemporaryDirectory() 会被
        // `TestIsolationGateTests` 判"temp location peeked at by hand"（本轮真的被它抓住过一次）。
        let dir = URL(fileURLWithPath: TestSandbox.directory("sockpath"), isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // 判据现在归 `StateRootArgument`（与 --state-dir 同一套，两种拼写共用）。
        // 从前：`--socket-path --force-socket` 把后者当路径吃下，接管开关静默失效，
        // 还在那个目录里真建出一个名为 `--force-socket` 的 socket。
        let eaten = run(["--socket-path", "--force-socket", "--state-dir", dir.path])
        XCTAssertNotEqual(eaten.status, 0, "开关样的值必须报错，不能静默接管：\(eaten.out)")
        XCTAssertTrue(eaten.err.contains("looks like another argument"), "要给出能照做的句子：\(eaten.err)")

        // 从前：`--socket-path gp.sock`（相对路径）绕过 prepareSocketDirectory 的全部检查，
        // SECURITY 那句"父目录收不到 0700 就拒绝服务"对这一形状是空的。
        let bare = run(["--socket-path", "gp.sock", "--state-dir", dir.path])
        XCTAssertNotEqual(bare.status, 0, "相对路径必须拒：\(bare.out)")
        XCTAssertTrue(bare.err.contains("must be an absolute path"), bare.err)

        // 等号拼写走的是同一道判据（两种拼写不许对什么是合法路径各说各话）。
        let equals = run(["--socket-path=gp.sock", "--state-dir", dir.path])
        XCTAssertNotEqual(equals.status, 0, "--socket-path= 形式同样不得绕过")
        XCTAssertTrue(equals.err.contains("must be an absolute path"), equals.err)

        // 对照：绝对路径必须**不被这道闸拒**，否则这条修复只是永远报错。
        let good = run(["--state-dir", dir.path, "--socket-path", dir.appendingPathComponent("engine.sock").path,
                        "--list-projects"])
        XCTAssertEqual(good.status, 0, "合法路径要能过解析：\(good.err)")
        XCTAssertFalse(good.err.contains("absolute path"), good.err)
    }

    // MARK: - 开发者工具卡：实测到的系统拒绝不得折成"已授权"

    private func report(launch: String, attach: String, granted: Bool) -> DeveloperToolsCapability.Report {
        DeveloperToolsCapability.Report(launch: launch, attach: attach, granted: granted,
                                         observedAt: Date(timeIntervalSince1970: 1_760_000_000))
    }

    func testDenialOnEitherHalfWinsOverTheOredGrantedFlag() {
        // 这张卡存在的意义就是"能不能让调试器附加到进程"。attach 被系统明确拒绝却点绿，
        // 等于把一次实测的拒绝折算成一次授权。
        XCTAssertEqual(report(launch: "ok", attach: "denied", granted: true).status, .denied,
                       "launch ok + attach denied 不许点绿")
        XCTAssertEqual(report(launch: "denied", attach: "ok", granted: true).status, .denied)

        // 对照：两半都成、granted 也算真，必须仍然算已授权——否则这条判据只是永远拒绝。
        XCTAssertEqual(report(launch: "ok", attach: "ok", granted: true).status, .granted)
        // 未知失败不得被折成任何结论。
        XCTAssertEqual(report(launch: "timeout", attach: "spawnFailed", granted: false).status, .unverifiable)
    }
}
