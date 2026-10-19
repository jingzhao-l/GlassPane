import XCTest

/// `glasspaned` 一次性 CLI 里"读不开 ≠ 没注册"这条判据的落点闸（P1 #1、P2 #2）。
///
/// 为什么这一条要用源码形状而不是端到端：`main.swift` 是 executable target 的顶层
/// 代码，测试进程拿不到它的解析器与那些 `if options.…` 分支——本仓对这个约束早有
/// 定式（`RegistryVerdictTests`、`ProjectRegistryTests.testMaintenanceCliRoutes…`、
/// `EngineCoreTests.testDaemonAlwaysStatesAReasonWhenNoMonitorRuns` 都在读这份文件）。
/// 端到端那一半在 `RegistryCliRefusalShapeTests`，它跑的是真二进制。
///
/// 两条闸各自能红的方式：
///  * 把 `--active-project` 或维护分支里的 `.unreadable` 判定删掉 → 前两条红；
///  * 把 `--list-projects` 的编码失败分支改回 `[]` + `exit(0)` → 第三条红。
final class MainRegistryRefusalBranchTests: XCTestCase {

    private var mainSwiftPath: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("engine/Sources/glasspaned/main.swift").path
    }

    private func mainSource() throws -> String {
        let text = try String(contentsOfFile: mainSwiftPath, encoding: .utf8)
        // 注释里写满了"从前那句错的写法"长什么样，负向断言必须只扫代码。
        var out = text
        while let open = out.range(of: "/*") {
            guard let close = out.range(of: "*/", range: open.upperBound..<out.endIndex) else { break }
            out.removeSubrange(open.lowerBound..<close.upperBound)
        }
        return out
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.drop(while: { $0 == " " || $0 == "\t" }).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// `--active-project` 的分支：读不开必须走 loadFailed 拒绝，且拒绝在 `get` 之前。
    func testActiveProjectBranchSeparatesUnreadableFromNotRegistered() throws {
        let source = try mainSource()
        let start = try XCTUnwrap(
            source.range(of: "if let activeId = options.activeProjectId {"),
            "--active-project 的分支不见了，这条对照已不作数"
        )
        let end = try XCTUnwrap(
            source.range(of: "// MARK: - P1 §12.3.1", range: start.upperBound..<source.endIndex)
                ?? source.range(of: "private func runProjectPrune", range: start.upperBound..<source.endIndex),
            "分支的右边界找不到：窗口没有界，断言就会在整个文件尾上成立"
        )
        let block = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(
            block.contains("case .unreadable"),
            "--active-project 又回到只看 registry.get 的 nil：读不开会被写成一条确定的缺席"
        )
        XCTAssertTrue(
            block.contains("registry.listing()"),
            "判据必须取自 `ProjectRegistry.listing()`，不在 CLI 里重写第二份"
        )
        XCTAssertTrue(
            block.contains("\"found\": false"),
            "读得开、确实没有这一条时，那句诚实的\"未注册\"必须还在"
        )
        // 顺序即判据：拒绝判定必须在 `registry.get` 之前，否则 nil 先被当成答案。
        XCTAssertLessThan(
            try XCTUnwrap(block.range(of: "case .unreadable")).lowerBound,
            try XCTUnwrap(block.range(of: "registry.get(activeId)")).lowerBound,
            "先 get 后判 unreadable 的话，读不开仍然先被写成 found:false"
        )
    }

    /// 维护分支（`--prune-evidence` / `--evidence-stats` 带 `--project`）同理。
    func testMaintenanceBranchSeparatesUnreadableFromUnknownProject() throws {
        let source = try mainSource()
        let start = try XCTUnwrap(
            source.range(of: "if options.pruneEvidence || options.evidenceStats {"),
            "维护分支不见了"
        )
        let end = try XCTUnwrap(
            source.range(of: "let socketPath = StateRoot.engineSocketPath", range: start.upperBound..<source.endIndex),
            "窗口右边界（daemon 入口）不见了"
        )
        let block = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(
            block.contains("case .unreadable"),
            "维护分支又回到只看 registry.get 的 nil：\"unknown project <id>\" 会变成一次凭看不见编出来的缺席"
        )
        XCTAssertTrue(block.contains("registry.listing()"), "判据要取自库里那一份")
        XCTAssertTrue(
            block.contains("\"loadFailed\": true"),
            "拒绝形状必须与 --list-projects / --project-prune 同形"
        )
        XCTAssertTrue(
            block.contains("\"unknown project \\(projectId)\""),
            "读得开而确实没有这一条时，那句未知的答复必须仍然给得出"
        )
        XCTAssertLessThan(
            try XCTUnwrap(block.range(of: "case .unreadable")).lowerBound,
            try XCTUnwrap(block.range(of: "registry.get(projectId)")).lowerBound,
            "顺序倒了就等于没改"
        )
        XCTAssertTrue(
            block.contains("EngineCore.projectArchiveDirectory"),
            "既有判据不能被搬走：项目归档目录仍要过引擎那一份解析器"
        )
    }

    /// `--list-projects` 编码失败不许再回 `[]` + 0（P2 #2）。
    ///
    /// 窗口左界取**顶格（第 0 列）**的处理块 `\nif options.listProjects {`：2026-10-19
    /// 起 `requestedCommands` 的命令名单里也有一条缩进的 `if options.listProjects {
    /// names.append("--list-projects") }`，按裸文本匹配会把窗口从那里张开，吞进
    /// --version / --grant-accessibility / 权限探针等六条别的命令的分发块——那七次
    /// `exit(0)` 就是这么来的，一条都不属于这条命令。
    func testListProjectsEncodeFailureRefusesInsteadOfAnEmptyArray() throws {
        let source = try mainSource()
        let start = try XCTUnwrap(
            source.range(of: "\nif options.listProjects {"),
            "--list-projects 的处理块不见了"
        )
        let end = try XCTUnwrap(
            source.range(of: "if let activeId = options.activeProjectId {", range: start.upperBound..<source.endIndex),
            "窗口右边界找不到"
        )
        let block = source[start.lowerBound..<end.lowerBound]

        XCTAssertFalse(
            block.contains(#"Data("[]\n""#),
            "读不回来的表又被印成 `[]` 并退 0——这正是这条命令自己注释里禁止的形状"
        )
        XCTAssertTrue(
            block.contains("to: .standardError)"),
            "编码失败的分支必须与 `.unreadable` 走同一条 stderr 拒绝"
        )
        // 编码失败路径的可达性判据（比裸计数更精确的那一半）：catch 之后的第一个
        // 出口必须是 exit(1)，且在那之前一次 stdout 都不许写——把失败分支改成
        // "落到 exit(0)"或"编不出去也先发 stdout"，都过不了这两行。
        let catchPath = block[try XCTUnwrap(
            block.range(of: "} catch {"),
            "编码失败的分支不见了：这条闸钉的就是这个 catch"
        ).upperBound..<block.endIndex]
        let firstExit = try XCTUnwrap(
            catchPath.range(of: "exit("),
            "编码失败的路径没有出口：控制流会从失败分支流出去"
        )
        XCTAssertTrue(
            catchPath[firstExit.upperBound...].hasPrefix("1)"),
            "编码失败路径的第一个出口不是 exit(1)：exit(0) 又可达了"
        )
        XCTAssertFalse(
            catchPath[..<firstExit.lowerBound].contains("standardOutput"),
            "编码失败的分支在写 stdout：编不出去的东西被当成答案发出去了"
        )
        let refusals = block.components(separatedBy: "exit(1)").count - 1
        let successes = block.components(separatedBy: "exit(0)").count - 1
        XCTAssertEqual(refusals, 2, "两条拒绝（读不开 / 编不出）各自都得非零离场：\(block)")
        XCTAssertEqual(successes, 1, "这个分支里只许有一次成功退出（stdout 写完答案之后）")
    }

    /// `--evidence-stats` 读不到归档时的退出码判据（P2 #3）。
    func testEvidenceStatsExitsNonZeroWhenTheListingFailed() throws {
        let source = try mainSource()
        let start = try XCTUnwrap(
            source.range(of: "if options.evidenceStats {"),
            "--evidence-stats 的分支不见了"
        )
        let end = try XCTUnwrap(
            source.range(of: "let socketPath = StateRoot.engineSocketPath", range: start.upperBound..<source.endIndex),
            "窗口右边界不见了"
        )
        let block = source[start.lowerBound..<end.lowerBound]
        XCTAssertTrue(
            block.contains("exit(unreadable ? 1 : 0)") || block.contains("exit(stats.listFailure == nil ? 0 : 1)"),
            "读不到归档时 stats 必须与 --prune-evidence 同口径非零：\(block)"
        )
    }
}
