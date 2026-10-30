import XCTest
import Foundation
@testable import GlassPaneEngine

/// 每日任务 2026-10-30 · 泳道 1 · 缺陷 1：`.` 与 `..` 两种拼写绕过"这个根永不 chmod"那一道闸。
///
/// 危害。`StateRootArgument.dedicatedness` 与 `SocketDirectoryRule.ownsItNeverChmodDefect`
/// 都只做**字符串**折算：削掉尾斜杠，然后和 `NSHomeDirectory()` /
/// `homeDirectoryForCurrentUser.path` 比相等。POSIX 把 `.` 和 `..` 当目录项解析，
/// 所以 `chmod("$T/home/proj/..", 0700)` 改的就是 `$T/home`，`"$HOME/."` 就是 `$HOME`：
/// `--state-dir "$HOME/."` 与 `--state-dir "$HOME/Desktop/.."` 都能走过那道比较，随后
/// `tightenPermissions`（`StateRoot.swift:245`）把**用户的主目录**chmod 成 0700——正是
/// `StateRoot.swift:376-381` 那段注释说这道闸存在的理由（`--state-dir ~` 曾把家目录锁死）。
/// socket 那一侧同一形状：`SocketDirectoryRule.swift:57` 对传入的目录 chmod 0700。
///
/// 判据住哪。动盘之前、参数层，两个入口共用**一个**判据（`dedicatedness` 先把形状判一遍，
/// 再看折算后的位置），措辞照本仓先例 `EngineCore.storedPathShapeDefect`——那一条对存储的
/// 档案路径同时拒"非绝对"与"含 `.`/`..` 分量"。两处拒绝各写自己的下一步，判据不许有第二份。
///
/// REVERSE：
///  - 把 `dedicatedness` 里那段形状检查删掉 → 前两条用例与真二进制那条一起红（家目录拼写又
///    被当成"专用目录"放行）；
///  - 只做形状检查、不折算位置 → `home + "//"` 那类拼写红（既有闸同源）；
///  - 把 `ownsItNeverChmodDefect` 改回自己那份字符串折算 → 两处一致性那条红；
///  - 把闸挪到 chmod 之后 → `mode of home 未变` 那条红（这条是本轮唯一真跑磁盘的对照）。
///
/// 全程不碰真家目录：唯一的 chmod 对照跑在 `TestSandbox` 里现搭的 `<sandbox>/home/proj`
/// 假树上（`TestIsolationGateTests` 的规矩：能伤害机器的对照不算对照）。
final class DailyRound20261030Swift1PathShapeTests: XCTestCase {

    /// 家目录字符串**取自引擎自己的默认根的父目录**：本仓的隔离闸把 `NSHomeDirectory()` 手拼
    /// 成路径记成违规，而这几条只需要那个名字，从来不往里面写任何东西。
    private var home: String {
        (StateRoot.homeDefault().path as NSString).deletingLastPathComponent
    }

    private func mode(of path: String) throws -> Int {
        var info = stat()
        guard lstat(path, &info) == 0 else {
            throw XCTSkip("lstat \(path) 失败；这一条的读数在没有该目录的环境里不作数")
        }
        return Int(info.st_mode & 0o777)
    }

    /// 拒绝文案的两件必备物：说清**什么都没 chmod**，并给出能照着写的下一步
    /// （`--state-dir <home>/.glasspane`，与既有的家目录那一句同一个位置）。
    private func assertRefusalHasNextStep(
        _ reason: String?, spelling: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        guard let reason else {
            return XCTFail("`\(spelling)` 走过去了：它指着的就是家目录本身", file: file, line: line)
        }
        XCTAssertTrue(reason.contains("Nothing was chmod-ed"),
                      "拒绝必须说清什么都没 chmod——读者据此才知道磁盘无损：\(reason)")
        XCTAssertTrue(reason.contains("--state-dir"),
                      "拒绝要给一条能照着写的替代：\(reason)", file: file, line: line)
        XCTAssertTrue(reason.contains(StateRoot.homeDefault().path),
                      "下一步就是默认的那个专用目录：\(reason)", file: file, line: line)
    }

    // MARK: - `--state-dir` 那一侧

    /// 家目录的 `.`/`..` 拼写必须拒——它们指的就是家目录，而收紧扫描 chmod 的正是这个名字
    /// 指着的目录。
    func testStateDirRefusesTheDotAndParentSpellingsOfHome() {
        for spelling in [
            home + "/.",
            home + "/./",
            home + "/Desktop/..",
            home + "/Desktop/../",
            home + "/Library/../",
            home + "/Documents/../Downloads/..",
        ] {
            assertRefusalHasNextStep(
                StateRootArgument.notADedicatedRoot(spelling), spelling: spelling
            )
        }
    }

    /// `/` 的 `.`/`..` 拼法同样是文件系统根：`/./.`、`/..`、`/private/..` 一个都不许放行。
    func testStateDirRefusesFilesystemRootSpellingsBuiltFromDots() {
        for spelling in ["/.", "/..", "/./.", "/../..", "/private/..", "/Users/..", "/Users/x/../.."] {
            let reason = StateRootArgument.notADedicatedRoot(spelling)
            XCTAssertNotNil(reason, "`\(spelling)` 折算后就是 `/`，却被当成专用目录收下了")
            XCTAssertTrue(reason?.contains("Nothing was chmod-ed") == true, reason ?? "")
            XCTAssertTrue(reason?.contains("--state-dir") == true, reason ?? "")
        }
    }

    /// 形状检查不许顺手把**合法**的根判红：专用目录（含 `.` 开头的分量，如 `.glasspane`、
    /// `.build`）照旧收——拒它就把每一处自定义安装位置都判红了。
    func testStateDirStillAcceptsDedicatedRootsIncludingDotPrefixedNames() {
        let sandbox = TestSandbox.directory("dot-shape")
        let dedicated = sandbox + "/proj"
        XCTAssertNil(StateRootArgument.notADedicatedRoot(dedicated),
                     "专用临时目录被误拒：\(StateRootArgument.notADedicatedRoot(dedicated) ?? "")")
        XCTAssertNil(StateRootArgument.rejection(for: dedicated))
        XCTAssertNil(StateRootArgument.notADedicatedRoot(StateRoot.homeDefault().path),
                     "默认位置（家目录里引擎自己的那个目录）不能被新判据误拒")
        XCTAssertNil(StateRootArgument.notADedicatedRoot(sandbox + "/.build/x"))
        // 既有拼写一条不许退化。
        XCTAssertNotNil(StateRootArgument.notADedicatedRoot(home))
        XCTAssertNotNil(StateRootArgument.notADedicatedRoot(home + "/"))
        XCTAssertNotNil(StateRootArgument.notADedicatedRoot("/"))
    }

    // MARK: - socket 那一侧：同一个判据，两处措辞

    /// `--socket-path` / `--probe-socket-path` 的父目录问的是同一个判据：同危害不同答案正是
    /// 本轮要关的那一半。
    func testSocketParentRefusesTheSameShapes() {
        for spelling in [
            home + "/.",
            home + "/Desktop/..",
            "/.",
            "/..",
            "/private/..",
        ] {
            let reason = StateRootArgument.rejectionForSocketParent(of: spelling + "/engine.sock")
            XCTAssertNotNil(reason, "`--socket-path \(spelling)/engine.sock` 走过去了")
            XCTAssertTrue(reason?.contains("Nothing was chmod-ed") == true, reason ?? "")
            XCTAssertTrue(reason?.contains("--socket-path") == true, reason ?? "")
        }
        // 默认布局照旧放行（这一面不许把今天装好的安装判红）。
        let defaultSocket = StateRoot.engineSocketPath(explicitSocketPath: nil, stateRoot: nil)
        XCTAssertNil(StateRootArgument.rejectionForSocketParent(of: defaultSocket))
        let sandbox = TestSandbox.directory("socket-shape")
        XCTAssertNil(StateRootArgument.rejectionForSocketParent(of: sandbox + "/daemon.sock"))
        XCTAssertNil(StateRootArgument.rejectionForSocketParent(of: sandbox + "/.glasspane/daemon.sock"))
    }

    /// 兜底那一半（`SocketDirectoryRule`）对同一批拼写也说得出同一句话——判据只有一份。
    func testSocketDirectoryRuleRefusesTheDotShapesWithoutChmod() throws {
        let sandbox = TestSandbox.directory("rule-shape")
        for directory in [home + "/.", home + "/Desktop/..", "/.", "/private/.."] {
            let defect = SocketDirectoryRule.ownsItNeverChmodDefect(directory)
            XCTAssertNotNil(defect, "\(directory) 在 socket 兜底上走过去了")
            XCTAssertTrue(defect?.contains("Nothing was chmod-ed") == true, defect ?? "")
            XCTAssertTrue(defect?.contains("--socket-path") == true, defect ?? "")
        }
        XCTAssertNil(SocketDirectoryRule.ownsItNeverChmodDefect(sandbox + "/.glasspane"))
        XCTAssertNil(SocketDirectoryRule.ownsItNeverChmodDefect(StateRoot.homeDefault().path))
    }

    /// 唯一真跑磁盘的那一条对照：在 `<sandbox>` 里现搭 `home/proj` 假树，把 `home/proj/..`
    /// 交给 `enforce`——它必须**一句 chmod 都不做**就拒绝，而 `home` 的模式保持它原本的
    /// 0755。REVERSE：把闸挪到 chmod 之后，这一条当场红（0755 变 0700）。
    func testEnforceLeavesTheParentDirectoryModeUntouched() throws {
        let sandbox = TestSandbox.directory("chmod-tree")
        let fakeHome = sandbox + "/home"
        let project = fakeHome + "/proj"
        try FileManager.default.createDirectory(atPath: project, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fakeHome)
        let before = try mode(of: fakeHome)
        XCTAssertEqual(before, 0o755, "前提：假树的家目录先是 0755——被 chmod 成 0700 才是本轮的缺陷")

        let defect = SocketDirectoryRule.enforce(directory: project + "/..")
        XCTAssertNotNil(defect, "enforce 收了 `home/proj/..`：这就是 chmod 家目录的那一次调用")
        XCTAssertTrue(defect?.contains("Nothing was chmod-ed") == true, defect ?? "")
        XCTAssertEqual(try mode(of: fakeHome), before,
                       "`home/proj/..` 把 home 的权限改了——拒绝必须发生在任何动盘动作之前")
        // 真目录照旧收：兜底不许把常规位置判红。
        XCTAssertNil(SocketDirectoryRule.enforce(directory: project))
        XCTAssertEqual(try mode(of: project), 0o700, "常规 enforce 仍然把专用目录收到 0700")
    }

    /// 真二进制那一臂：`--state-dir <sandbox>/home/..` 必须在**任何** chmod 之前回 64，
    /// 而那个 home 的模式一字未动。地点全在 `TestSandbox` 里，绝不拿真家目录做输入。
    func testDaemonRefusesAParentComponentStateDirBeforeTouchingAnything() throws {
        let sandbox = TestSandbox.directory("cli-dot")
        let fakeHome = sandbox + "/home"
        let project = fakeHome + "/proj"
        try FileManager.default.createDirectory(atPath: project, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fakeHome)
        let before = try mode(of: fakeHome)

        let outcome = try Self.runDaemon(["--state-dir", project + "/..", "--permissions"])
        XCTAssertEqual(outcome.status, 64, "含 `..` 的 --state-dir 要按用法错误拒在服务动手之前：\(outcome.combined.prefix(300))")
        XCTAssertTrue(outcome.combined.contains("--state-dir"), outcome.combined)
        XCTAssertTrue(outcome.combined.contains("Nothing was chmod-ed"), outcome.combined)
        XCTAssertEqual(try mode(of: fakeHome), before,
                       "被拒的那一趟改了 home 的权限位：拒绝发生在 chmod 之后")

        // 同一棵树的合法写法照旧能用（这一臂证明新判据没有把每一次调用都判红）。
        let good = try Self.runDaemon(["--state-dir", project, "--version"])
        XCTAssertEqual(good.status, 0, good.combined)
    }

    /// 反漂移：socket 那一条不许再抄一份"这是不是家目录"的比较——两份判据各漂各的正是本轮
    /// 缺陷的形状。它问的是同一个函数，只写自己的措辞。
    /// REVERSE：把 `homeDirectoryForCurrentUser` 那一份比较抄回 `SocketDirectoryRule` → 红。
    func testTheSocketRuleSharesTheOneMeasurement() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/GlassPaneEngine/SocketDirectoryRule.swift")
        let text = try XCTUnwrap(try? String(contentsOf: url, encoding: .utf8), "读不到 \(url.path)")
        let code = text.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.hasPrefix("//") && !$0.hasPrefix("/*") && !$0.hasPrefix("*") }
            .joined(separator: "\n")
        XCTAssertEqual(
            code.components(separatedBy: "StateRootArgument.dedicatedness(").count - 1, 1,
            "兜底不再问那一份测量，或者问了不止一遍"
        )
        XCTAssertNil(code.range(of: "homeDirectoryForCurrentUser"),
                     "socket 那一条又自己写了一份家目录比较——判据就有两份了")
        XCTAssertEqual(code.components(separatedBy: "Nothing was chmod-ed").count - 1, 3,
                       "三种拒绝（`/`、家目录、`.`/`..`）都得各自说清什么都没 chmod")
    }

    // MARK: - 真二进制夹具

    private struct DaemonRun {
        let status: Int32
        let stdout: String
        let stderr: String
        var combined: String { stdout + stderr }
    }

    private static func runDaemon(_ arguments: [String]) throws -> DaemonRun {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }   // → engine/
        let binary = url.appendingPathComponent(".build/debug/glasspaned").path
        guard FileManager.default.isExecutableFile(atPath: binary) else {
            throw XCTSkip("没有 \(binary)；这一条要的是真二进制，跑不了就先明说跑不了（swift build --package-path engine）")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = arguments
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()
        // 先读到 EOF 再等退出：反过来的话，输出超过管道缓冲的 usage 块会把这个子进程卡住。
        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        process.waitUntilExit()
        return DaemonRun(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }
}
