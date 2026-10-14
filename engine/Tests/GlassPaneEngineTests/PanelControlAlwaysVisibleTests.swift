import XCTest
import GlassPaneEngine
@testable import glasspane_settings

/// 按不动的控件一律在屏上，理由与下一步写在它自己身上。
///
/// 三条同一类的毛病：
///   1. 项目页唯一的「清理」入口被一个**本地算出来的条数**挡住——注册表读失败时
///      那个数是 0，于是 daemon 的 `--project-prune --dry-run` 一次都没被问过。
///      README 认下的规矩是"never hides a control to avoid explaining it"。
///   2. 菜单栏里「打开设置面板」只前置**已经存在**的窗口：Cmd-W 关掉之后（进程被
///      `MenuBarExtra` 留着）它按下去什么都不发生，也什么都不说。
///   3. 证据页那两枚禁用态（「档案目录」、「打开报告」）的 help 只描述启用态。
final class PanelControlAlwaysVisibleTests: XCTestCase {

    // MARK: - 缺陷 5：「清理」永远画得出来

    /// 面板本地读到 0 条、注册表读成了：这一枚**仍然按得动**——有没有得清由
    /// daemon 那趟 dry-run 答，不是由这个零答（revert 成"藏在条数后面"就红在这里）。
    func testLocalZeroDoesNotTakeThePruneEntryOutOfReach() {
        let control = ConsoleModel.pruneControl(
            projectsState: .loaded, residueCount: 0,
            canRunDaemonCLI: true, isPreparingPreview: false
        )
        guard case .ready(let banner, let help) = control else {
            return XCTFail("读到 0 条也要把入口递出去：\(control)")
        }
        XCTAssertTrue(banner.contains("0"), banner)
        XCTAssertTrue(help.contains("--project-prune"), help)
        XCTAssertFalse(help.contains("按不动"), help)
    }

    /// 读失败那一支：理由 + 下一步，且不许把"0 条"说成后台服务的答复。
    func testFailedRegistryReadDisablesThePruneWithAReasonAndTheNextMove() {
        let control = ConsoleModel.pruneControl(
            projectsState: .failed("注册表文件读不开"), residueCount: 0,
            canRunDaemonCLI: true, isPreparingPreview: false
        )
        guard case .blocked(let banner, let reason) = control else {
            return XCTFail("注册表没读成时这一枚按不动：\(control)")
        }
        XCTAssertTrue(banner.contains("报不出条数"), banner)
        XCTAssertTrue(reason.contains("按不动"), reason)
        XCTAssertTrue(reason.contains("刷新"), reason)
        XCTAssertFalse(reason.contains("没有需要清理"), reason)
    }

    /// 每一个按不动的形态都得同一句话：原因 + 这一屏做得动的那一步。
    func testEveryBlockedPruneStateNamesTheNextMove() {
        let cases: [(ConsoleModel.LoadState, Int, Bool, Bool)] = [
            (.idle, 0, true, false),
            (.loading, 0, true, false),
            (.failed("读不开"), 3, true, false),
            (.loaded, 0, false, false),
            (.loaded, 2, true, true),
        ]
        for (state, count, hasCLI, preparing) in cases {
            let control = ConsoleModel.pruneControl(
                projectsState: state, residueCount: count,
                canRunDaemonCLI: hasCLI, isPreparingPreview: preparing
            )
            guard case .blocked(_, let reason) = control else { continue }
            XCTAssertTrue(reason.contains("下一步"), "\(state)/\(count) 的拒绝没给出下一步：\(reason)")
            XCTAssertFalse(reason.isEmpty)
        }
    }

    /// 视图那一半：那一枚不在任何条数判断的里面。
    func testPruneButtonIsNoLongerGatedOnTheLocalCount() throws {
        let source = try PanelSourceText.code("ProjectsTabView.swift")
        XCTAssertFalse(source.contains("if model.testResidueCount > 0"),
                       "「清理」又回到只有本地数出残留时才画出来：daemon 于是从没被问过")
        XCTAssertTrue(source.contains("Button(\"清理\") { model.previewTestResiduePrune() }"),
                      "那一枚不再是向后台服务要清单的入口")
        XCTAssertTrue(source.contains(".disabled(!model.canPreviewTestResiduePrune)"),
                      "禁用条件改回了一次点击或一个本地条数")
        XCTAssertTrue(source.contains(".help(model.pruneControlHelp)"),
                      "按不动时那句理由与下一步必须挂在它自己身上")
        XCTAssertTrue(source.contains(".accessibilityIdentifier(\"gp-prune-projects\")"),
                      "这一枚要留一个可指认的标识，自动化才点得到它")
    }

    // MARK: - 缺陷 6：菜单栏那一枚要真的把窗口带回来

    /// 场景 id 与菜单项点名的必须是同一个去处。
    func testMenuPanelItemOpensTheWindowByIDInsteadOfFrontingWhatAlreadyExists() throws {
        let source = try PanelSourceText.code("GlassPaneSettingsApp.swift")
        XCTAssertTrue(source.contains("id: SettingsWindow.id"),
                      "窗口没有可点名的 id，菜单那一枚就只能去找已经存在的窗口")
        XCTAssertTrue(source.contains("openWindow(id: SettingsWindow.id)"),
                      "「打开设置面板」又退回只前置现有窗口：Cmd-W 之后它按下去没有反应")
        XCTAssertFalse(source.contains("NSApplication.shared.windows"),
                       "还在遍历窗口列表按标题前置——那正是那条静默失效")
        XCTAssertFalse(source.contains("makeKeyAndOrderFront"),
                       "同上：这一枚不再靠屏幕上恰好有一个同名窗口")
        XCTAssertTrue(source.contains(".accessibilityIdentifier(\"gp-open-settings-panel\")"),
                      "菜单项要有可指认的标识")
    }

    /// 那句话不许宣称窗口出现了（`openWindow` 没有回话），但要说清按下去做什么、
    /// 看不见时下一步是什么。
    func testMenuPanelHelpStatesTheActionAndTheNextMoveWithoutClaimingSuccess() {
        XCTAssertTrue(SettingsWindow.openHelp.contains("新开一个"), SettingsWindow.openHelp)
        XCTAssertTrue(SettingsWindow.openHelp.contains("带到前面"), SettingsWindow.openHelp)
        XCTAssertTrue(SettingsWindow.openHelp.contains("下一步"), SettingsWindow.openHelp)
        XCTAssertFalse(SettingsWindow.openHelp.contains("已打开"),
                       "窗口出现与否这一枚测不到，不许替它背书：" + SettingsWindow.openHelp)
        XCTAssertFalse(SettingsWindow.openHelp.contains("已经打开"),
                       "同上：" + SettingsWindow.openHelp)
    }

    // MARK: - 缺陷 7：两枚禁用态的 help

    /// 「档案目录」：禁用那一句得说禁用——从前它无论按得动与否都写着"在访达中打开 …"。
    func testEvidenceDirectoryControlExplainsItsDisabledCase() {
        let directory = TestSandbox.directory("archive-absent")
        let blocked = ConsoleModel.evidenceDirectoryControl(exists: false, directory: directory)
        XCTAssertFalse(blocked.enabled)
        XCTAssertTrue(blocked.help.contains("按不动"), blocked.help)
        XCTAssertTrue(blocked.help.contains(directory), "要点得出它去看的是哪一个目录：" + blocked.help)
        XCTAssertTrue(blocked.help.contains("下一步"), blocked.help)

        let ready = ConsoleModel.evidenceDirectoryControl(exists: true, directory: directory)
        XCTAssertTrue(ready.enabled)
        XCTAssertTrue(ready.help.contains(directory), ready.help)
        XCTAssertFalse(ready.help.contains("按不动"), ready.help)
    }

    /// 「打开报告」：判据是这条档案的**读取结局**，三种按不动各有各的下一步。
    func testReportButtonSplitsReadingFromUnreadable() throws {
        let loading = ConsoleModel.reportButtonControl(packLoad: .loading)
        XCTAssertFalse(loading.enabled)
        XCTAssertTrue(loading.help.contains("还在读盘"), loading.help)
        XCTAssertTrue(loading.help.contains("下一步"), loading.help)

        let failed = ConsoleModel.reportButtonControl(packLoad: .failed(reason: "这条档案读不出内容"))
        XCTAssertFalse(failed.enabled)
        XCTAssertTrue(failed.help.contains("读不出"), failed.help)
        XCTAssertTrue(failed.help.contains("重试"), failed.help)
        XCTAssertTrue(failed.help.contains("gp_export_evidence"), failed.help)
        XCTAssertFalse(failed.help.contains("还在读盘"),
                       "读不出不能写成还在读：那是对一件不会再出答案的事转圈")

        let nothing = ConsoleModel.reportButtonControl(packLoad: .none)
        XCTAssertFalse(nothing.enabled)
        XCTAssertTrue(nothing.help.contains("下一步"), nothing.help)

        let pack = try EvidencePack.decodeAndValidate(
            KernelFixtures.data("evidence-pack.ok-01.json")
        )
        let ready = ConsoleModel.reportButtonControl(packLoad: .loaded(pack))
        XCTAssertTrue(ready.enabled, ready.help)
        XCTAssertTrue(ready.help.contains("0600"), ready.help)
    }

    /// 视图那一半：两枚都从模型那一个判据取话，不再自己写一句启用态。
    func testEvidenceTabRendersTheModelJudgement() throws {
        let source = try PanelSourceText.code("EvidenceTabView.swift")
        XCTAssertTrue(source.contains(".help(model.evidenceDirectoryControl.help)"),
                      "「档案目录」的 help 又回到只描述启用态")
        XCTAssertTrue(source.contains(".disabled(!model.evidenceDirectoryControl.enabled)"),
                      "禁用与那句理由不再是两条各走的判据")
        XCTAssertTrue(source.contains(".help(reportControl.help)"),
                      "「打开报告」的理由不在屏幕上")
        XCTAssertTrue(source.contains(".disabled(!reportControl.enabled)"))
        XCTAssertFalse(source.contains("disabled(pack == nil)"),
                       "「打开报告」又拿那个把「还在读」与「读不出」混在一起的 nil 当判据")
    }
}
