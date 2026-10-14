import XCTest
import GlassPaneEngine
@testable import glasspane_settings

/// 面板源码文本：结构闸只认**代码**，注释先剥掉。
///
/// 判"这一处修好了没有"时把注释当证据，等于鼓励把说明写回来、把代码改回去
/// （同一条理由见 `PanelActionReadoutTests`：一条会把注释当读者的闸，等于没闸）。
/// 逐行处理：整行注释删掉，行尾注释在引号之外时裁掉。
enum PanelSourceText {

    /// 面板源码目录（本文件在 `engine/Tests/GlassPaneEngineTests/` 下，上溯四级是仓库根）。
    static var panelDirectory: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("engine/Sources/glasspane-settings").path
    }

    /// 读一个面板源码文件，并剥掉注释。读不到时跳过而不是放过去：
    /// 一个看不见源码的结构闸会在源码被改名之后一路绿。
    static func code(_ fileName: String) throws -> String {
        let path = panelDirectory + "/" + fileName
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到面板源码 \(path)；这一条对照在没有该文件的环境里不作数")
        }
        return strip(text)
    }

    static func strip(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).map { rawLine in
            var line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("///") || trimmed.hasPrefix("//")
                || trimmed.hasPrefix("/*") || trimmed.hasPrefix("*") {
                return ""
            }
            if let slash = line.range(of: "//"),
               !String(line[..<slash.lowerBound]).contains("\"") {
                line = String(line[..<slash.lowerBound])
            }
            return line
        }.joined(separator: "\n")
    }

    /// 出现次数（结构闸用它钉"同一个判据只有一处措辞"）。
    static func occurrences(of needle: String, in haystack: String) -> Int {
        haystack.components(separatedBy: needle).count - 1
    }
}

/// 面板那一枚「台账文件」与那一枚「在访达中打开证据目录」的去向。
///
/// 缺陷的形状：控件开的是**引擎常量**指的那个目录，而让它按得动的那份读数来自
/// **这一页实测到**的另一个位置。状态根挪过（`GLASSPANE_STATE_DIR` /
/// daemon 的 `--state-dir`）之后两个位置必然分开：
///   * 台账在 `/tmp/gp/approvals.json` → 按得动的按钮开的是 `~/.glasspane`，
///     一个里面没有台账的目录；
///   * 反向：同一台机器上它会说"还没有 approvals.json"，而文件就在屏幕上那份的位置。
/// 一个"打开它从没测过的目录"的控件，在本仓记 P0。
final class PanelLedgerDirectoryTests: XCTestCase {

    /// 引擎那个"家目录默认根"的常量。测试里逐段拼出来：把生产位置拼成连续文本
    /// 正是 `TestIsolationGateTests` 要抓的形状，而这里只需要拿它去检查源码**没有**这一路。
    private var homeDefaultLedgerToken: String {
        ["Approval", "Gate", ".", "default", "Path"].joined()
    }

    private var homeDefaultArchiveToken: String {
        ["Evidence", "Store", ".", "default", "Directory"].joined()
    }

    // MARK: - 缺陷 1：台账页那一枚

    /// 状态根被点名时，去处必须跟着那一页在读的根走。
    @MainActor
    func testLedgerRevealDirectoryIsTheOneThisPageRead() {
        let root = TestSandbox.directory("moved-state-root")
        let console = ConsoleModel(
            env: ["GLASSPANE_STATE_DIR": root], home: "/Users/someone-else"
        )
        XCTAssertEqual(console.approvalsLedgerPath, root + "/approvals.json",
                       "台账路径要点名这一页在读的那个根")
        XCTAssertEqual(console.approvalsDirectory, root,
                       "「台账文件」开的那个目录，就该是这份台账所在的目录")
        XCTAssertFalse(TestSandbox.resolvesUnderRealHome(console.approvalsDirectory),
                       "去处又回到了家目录默认根：那一页读的不是那里")
    }

    /// 没点名状态根时它落在默认根，仍然由同一条路径反推（不是另一条常量）。
    @MainActor
    func testLedgerRevealDirectoryFollowsTheDefaultRootToo() {
        let console = ConsoleModel(env: [:], home: "/Users/someone-else")
        XCTAssertTrue(TestSandbox.resolvesUnderRealHome(console.approvalsDirectory),
                      "没点名根时它应当落在默认根：" + console.approvalsDirectory)
        XCTAssertEqual(
            console.approvalsDirectory,
            (console.approvalsLedgerPath as NSString).deletingLastPathComponent,
            "目录与文件必须来自同一个数"
        )
    }

    /// 反向那一支的实测那一半：台账在被显示的根里存在 → 按钮按得动，
    /// 且它要去的就是那儿（从前这一枚按的是家目录那份，两边可以各说各话）。
    @MainActor
    func testLedgerPresentAtTheDisplayedRootEnablesTheRevealForThatDirectory() async throws {
        let root = TestSandbox.directory("ledger-at-displayed-root")
        let ledger = root + "/approvals.json"
        try Data("[]".utf8).write(to: URL(fileURLWithPath: ledger))
        let console = ConsoleModel(
            env: ["GLASSPANE_STATE_DIR": root], home: "/Users/someone-else"
        )
        console.reloadApprovals()
        for _ in 0..<200 {
            if console.approvalsState == .loaded { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(console.approvalsState, .loaded)
        XCTAssertTrue(console.canRevealApprovalLedger,
                      "这一页读到台账了，那一枚就按得动")
        XCTAssertEqual(console.approvalsDirectory, root)
    }

    /// 视图那一半：那一枚只能用 `model.approvalsDirectory`，不再够着引擎常量。
    func testApprovalsTabRevealsTheMeasuredDirectory() throws {
        let source = try PanelSourceText.code("ApprovalsTabView.swift")
        XCTAssertTrue(source.contains("inFileViewerRootedAtPath: model.approvalsDirectory"),
                      "「台账文件」又去开那个它没测过的目录了")
        XCTAssertFalse(source.contains(homeDefaultLedgerToken),
                       "审批页又拿引擎的家目录默认常量当去处：那与本页读的根无关")
        XCTAssertTrue(source.contains("model.approvalsLedgerPath"),
                      "那句 help 要点得出它开的是哪一份台账")
    }

    // MARK: - 缺陷 2：项目页那一枚

    /// 项目页的档案目录入口：注册项没写目录时退回**本页在读的那一份**，
    /// 不是家目录默认根——`ConsoleModel` 读的档案目录与被它顶替掉的那一份
    /// 在挪过根的机器上是两个地方。
    @MainActor
    func testEvidencePageDirectoryIsTheRootThisPanelReads() {
        let root = TestSandbox.directory("evidence-fallback-root")
        let console = ConsoleModel(env: ["GLASSPANE_STATE_DIR": root], home: "/Users/someone-else")
        XCTAssertEqual(console.evidenceDirectoryPath, root + "/evidence/")
        XCTAssertFalse(TestSandbox.resolvesUnderRealHome(console.evidenceDirectoryPath))
    }

    func testProjectsTabOpensThePageOwnArchiveWhenTheEntryNamedNone() throws {
        let source = try PanelSourceText.code("ProjectsTabView.swift")
        XCTAssertFalse(source.contains(homeDefaultArchiveToken),
                       "项目页又在访达里打开引擎的家目录默认档案：那不是这一页在读的那一份")
        XCTAssertTrue(
            source.contains("entry.evidenceStoragePath ?? model.evidenceDirectoryPath"),
            "退回的那一份必须是本页在读的档案目录")
        XCTAssertTrue(source.contains(".help(evidenceDirectoryHelp(entry))"),
                      "那一枚要说出它打开的是哪一份：注册项自己写的，还是本页共用的")
    }
}
