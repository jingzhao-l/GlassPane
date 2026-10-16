import XCTest
import GlassPaneEngine
@testable import glasspane_settings

/// 状态根的出处闸（2026-10-15，`smoke.md` 2026-10-13 §4 记为已确认、一直没人修的 P1）。
///
/// 缺陷形状：daemon 只认启动时的 `--state-dir`，它**从不读** `GLASSPANE_STATE_DIR`；
/// 而控制台这一页的根是面板按 env/家目录自己算的。两者不一致时，页面上并排显示两个根的
/// 数据，而「清理 / 删除 / 统计」这四条一次性 CLI 改的是**另一个实例的真注册表**——
/// 屏幕上还写着"档案目录：<新根>"。侧栏那行「状态根」本来就是 daemon 报的
/// （`hello.stateRoot`），面板从来没把它接回自己这一侧。
///
/// 每条都写明什么改动会把它变红：
/// · 反向变异 A：`adoptDaemonReport` 不跟着换根（回到只认 binaryPath）→ 第 1、2 条红。
/// · 反向变异 B：四个调用点里漏掉一个不走 `daemonCLIArguments(_:)`（半修）→ 第 1 条红。
/// · 反向变异 C：把"面板算的根"写成"daemon 报的"（`stateRootSource` 恒 `.daemonReported`）
///   → 第 3、4 条红：那一句话就成了替没发生过的实测背书。
@MainActor
final class ConsoleDaemonStateRootTests: XCTestCase {

    /// 一次真起进程的 argv 记录器。桩只认 `--state-dir` 打头的那条形，其余一律
    /// `unknown argument` + 64：对任何参数都答话的桩会替一条不存在的能力背书。
    private func makeArgvSpy(dir: String) throws -> (spy: String, argvFile: String) {
        let argvFile = dir + "/argv.txt"
        let spy = dir + "/glasspaned"
        let script = """
        #!/bin/sh
        printf '%s\\n' "$@" >> '\(argvFile)'
        printf '\\36\\36\\36\\n' >> '\(argvFile)'
        if [ "$1" != "--state-dir" ] || [ -z "$2" ]; then
          echo "glasspaned: unknown argument: $1" >&2
          exit 64
        fi
        shift 2
        case "$1" in
          --evidence-stats|--project-prune) echo '{}' ;;
          --project-remove)
            if [ -z "$2" ]; then
              echo "glasspaned: --project-remove requires a project ID" >&2
              exit 2
            fi
            echo '{}' ;;
          *)
            echo "glasspaned: unknown argument: $1" >&2
            exit 64 ;;
        esac
        """
        try script.write(toFile: spy, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: spy)
        return (spy, argvFile)
    }

    /// 读完一次调用记下的 argv（分隔符切段），并等它真的落地。
    private func readInvocations(_ argvFile: String) -> [[String]] {
        guard let text = try? String(contentsOfFile: argvFile, encoding: .utf8) else { return [] }
        return text.components(separatedBy: "\u{1e}\n")
            .map { $0.split(separator: "\n", omittingEmptySubsequences: true).map(String.init) }
            .filter { !$0.isEmpty }
    }

    private func waitUntilInvocations(_ argvFile: String, atLeast count: Int) -> [[String]] {
        var got: [[String]] = []
        for _ in 0..<400 {
            got = readInvocations(argvFile)
            if got.count >= count { return got }
            usleep(25_000)
        }
        return got
    }


    /// 第 1 条：面板 exec 出去的那个根，必须就是 daemon 报的那个。
    func testAdoptedDaemonRootIsWhatTheSpawnedProcessActuallyGets() throws {
        let dir = TestSandbox.directory("console-root-adopt")
        let panelRoot = dir + "/panel-side"
        let daemonRoot = dir + "/daemon-side"
        try FileManager.default.createDirectory(atPath: panelRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(atPath: daemonRoot, withIntermediateDirectories: true)
        let (spy, argvFile) = try makeArgvSpy(dir: dir)

        let console = ConsoleModel(
            daemonBinaryPath: spy,
            env: ["GLASSPANE_STATE_DIR": panelRoot],
            home: dir + "/fake-home",
            evidenceScanner: fixedEmptyScan
        )
        // 先让"没上报"这一支也走一遍：这时候用面板自己算的根是**对的**，
        // 少了这半条，第 1 条就可能因为一路都用了 daemon 根而假绿。
        console.removeProject("prj_000000000000000000000000AA")
        let before = waitUntilInvocations(argvFile, atLeast: 1)
        XCTAssertEqual(before.count, 1, "第一次删除应当留下一条 argv，实得 \(before)")
        XCTAssertEqual(Array(before.first?.prefix(2) ?? []), ["--state-dir", panelRoot],
                       "没上报时这一页按面板算的根走，实得：\(before.first ?? [])")

        console.adoptDaemonReport(binaryPath: spy, daemonStateRoot: daemonRoot, answered: true)
        try FileManager.default.removeItem(atPath: argvFile)

        console.removeProject("prj_000000000000000000000000AA")
        let after = waitUntilInvocations(argvFile, atLeast: 1)
        XCTAssertEqual(Array(after.first?.prefix(2) ?? []), ["--state-dir", daemonRoot],
                       "daemon 报了 \(daemonRoot)，这一页四条一次性 CLI 都必须点名它；实发 "
                       + "\((after.first ?? []).prefix(2)) —— 面板仍在动自己那一份注册表")

        // 剩下三条也必须跟着同一个根：漏任何一条就是半修（读新根、删旧根）。
        for (name, action): (String, () -> Void) in [
            ("--evidence-stats", { console.refreshDaemonStats() }),
            ("--project-prune --dry-run", { console.previewTestResiduePrune() }),
        ] {
            try? FileManager.default.removeItem(atPath: argvFile)
            action()
            let seen = waitUntilInvocations(argvFile, atLeast: 1)
            XCTAssertEqual(Array(seen.first?.prefix(3) ?? []),
                           ["--state-dir", daemonRoot, String(name.split(separator: " ").first!)],
                           "\(name) 这条没跟着换根，实得：\(seen.first ?? [])")
        }
    }

    /// 第 2 条：这一页读的三个位置（档案目录 / 注册表 / 台账）一起跟着报来的根。
    func testDerivedPathsFollowTheAdoptedRoot() {
        let dir = TestSandbox.directory("console-root-paths")
        let panelRoot = dir + "/panel-side"
        let daemonRoot = dir + "/daemon-side"
        let console = ConsoleModel(
            env: ["GLASSPANE_STATE_DIR": panelRoot],
            home: dir + "/fake-home",
            evidenceScanner: fixedEmptyScan
        )
        XCTAssertEqual(console.evidenceDirectory, StateRoot(path: panelRoot).evidenceDirectory,
                       "上报之前读的是面板自己算的那一份")
        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: daemonRoot, answered: true)
        let next = StateRoot(path: daemonRoot)
        XCTAssertEqual(console.displayedStateRoot, next.path, "根要跟着 daemon 报的换")
        XCTAssertEqual(console.evidenceDirectory, next.evidenceDirectory)
        XCTAssertEqual(console.projectsPath, next.projectsFile)
        XCTAssertEqual(console.approvalsPath, next.approvalsFile)
    }

    /// 第 3 条：出处那一句话必须说得出它是谁认定的——三个状态三种说法。
    func testCaptionNamesWhoDeclaredTheRoot() {
        let dir = TestSandbox.directory("console-root-caption")
        let panelRoot = dir + "/panel-side"
        let daemonRoot = dir + "/daemon-side"
        let console = ConsoleModel(
            env: ["GLASSPANE_STATE_DIR": panelRoot],
            home: dir + "/fake-home",
            evidenceScanner: fixedEmptyScan
        )
        XCTAssertEqual(console.stateRootSource, .panelComputed)
        XCTAssertFalse(console.displayedStateRootCaption.contains("这一帧上报"),
                       "从没报过时不许写成报过：\(console.displayedStateRootCaption)")
        XCTAssertTrue(console.displayedStateRootCaption.contains("从没报过"),
                      console.displayedStateRootCaption)

        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: daemonRoot, answered: true)
        XCTAssertEqual(console.stateRootSource, .daemonReported)
        XCTAssertTrue(console.displayedStateRootCaption.contains("这一帧上报的"),
                      console.displayedStateRootCaption)
        XCTAssertTrue(console.displayedStateRootCaption.contains(daemonRoot),
                      "出处说了，路径也要说：\(console.displayedStateRootCaption)")

        // 老 daemon 不带这个键：路径留着，出处必须降级，不许继续冒充"这一帧报的"。
        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: nil, answered: true)
        XCTAssertEqual(console.stateRootSource, .daemonReportedEarlier)
        XCTAssertTrue(console.displayedStateRootCaption.contains("早前上报"),
                      console.displayedStateRootCaption)
        XCTAssertEqual(console.displayedStateRoot, StateRoot(path: daemonRoot).path,
                       "降级只改出处那句话，不许把已实测的根换成面板算的")
    }

    /// 第 4 条：空白自报（""/空格）不是"报了一个根"——四条动作都还要拿它去 exec。
    func testBlankDaemonReportIsNotARoot() {
        let dir = TestSandbox.directory("console-root-blank")
        let panelRoot = dir + "/panel-side"
        let console = ConsoleModel(
            env: ["GLASSPANE_STATE_DIR": panelRoot],
            home: dir + "/fake-home",
            evidenceScanner: fixedEmptyScan
        )
        console.adoptDaemonReport(binaryPath: "/opt/glasspane/glasspaned", daemonStateRoot: "   ", answered: true)
        XCTAssertEqual(console.stateRootSource, .panelComputed, "空白串不许当成 daemon 报的根")
        XCTAssertEqual(console.displayedStateRoot, StateRoot(path: panelRoot).path)
        XCTAssertEqual(console.daemonCLIArguments(["--project-prune"]),
                       ["--state-dir", StateRoot(path: panelRoot).path, "--project-prune"])
    }
}

/// 不捕获 self 的空目录扫描：面板这一页只测"跟着根走"，不测扫盘本身。
private func fixedEmptyScan(_ path: String) -> ConsoleModel.EvidenceScanOutcome {
    ConsoleModel.EvidenceScanOutcome(directoryExists: true, totalBytes: 0, listFailure: nil)
}
