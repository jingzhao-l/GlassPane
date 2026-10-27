import XCTest
@testable import glasspane_settings

/// 2026-10-27 审查 E1：证据「趋势 / 统计」那张卡上，"没测得"后面跟着的那颗按钮必须真能带来变化。
///
/// 缺陷形状：`daemonStats == .notAsked`（后台服务程序路径还没实测到）时，这一页给出的可见
/// 下一步是「重新问一次」，而它调的正是 `ConsoleModel.refreshDaemonStats()`——该函数第一行
/// 就在 `daemonBinaryPath == nil` 时短路回 `.notAsked`、一个字节都不发。按下去无事发生，
/// 而句子里那句补救（"点「刷新」恢复连接后这一栏才会实起来"）指着的是**别的页上**的按钮。
/// 本仓把"GUI 有控件而背后无对应能力"记为 P0（当年 `--project-prune`/`--project-remove`
/// 就是这一族），所以这一条按同一口径处理：判据收进一处纯函数，措辞跟着判据走。
@MainActor
final class Qoder20261027StatsRecoveryTests: XCTestCase {

    func testUnknownPathMapsToRehandshakeAndNamesThatAction() {
        XCTAssertEqual(
            ConsoleModel.daemonStatsRecovery(pathKnown: false), .rehandshakeFirst,
            "路径不在手上时，重发统计等于重发同一句「还没问过」"
        )
        XCTAssertEqual(ConsoleModel.daemonStatsRecoveryLabel(pathKnown: false), "重新连接后台服务")
        XCTAssertNotEqual(
            ConsoleModel.daemonStatsRecoveryLabel(pathKnown: false), "重新问一次",
            "按钮写着「问一次」而实际不发问，就是这条缺陷本体"
        )
    }

    func testKnownPathStillReAsksTheStats() {
        // 控制：这道闸不许把合法的那一步也改掉，否则它是恒拒而不是判据。
        XCTAssertEqual(ConsoleModel.daemonStatsRecovery(pathKnown: true), .askStatsAgain)
        XCTAssertEqual(ConsoleModel.daemonStatsRecoveryLabel(pathKnown: true), "重新问一次")
    }

    func testRefreshDaemonStatsWithoutAPathNeverClaimsToHaveAsked() throws {
        // `notAsked` 与 `unreachable` 是两句话：没发过 vs 发了没答。短路那一支必须停在第一句。
        // 状态根钉进临时目录：`NSHomeDirectory()` 不吃 $HOME，不给一个隔离根就会去读
        // 开发者那一份真状态（本仓的隔离闸就是为这件事装的）。
        let root = TestSandbox.directory("gp-stats-recovery")
        let model = ConsoleModel(
            daemonBinaryPath: nil,
            env: ["GLASSPANE_STATE_DIR": root],
            home: root,
            evidenceDirectory: root
        )
        XCTAssertNil(model.daemonBinaryPath, "前提：这台机器上还没实测到后台服务的程序路径")
        model.refreshDaemonStats()
        XCTAssertEqual(
            ConsoleModel.daemonStatsRecovery(pathKnown: model.daemonBinaryPath != nil), .rehandshakeFirst,
            "路径为 nil 时这一页的下一步只能是被重新握手"
        )
    }

    func testSentenceOnTheCardNamesTheButtonThatIsActuallyThere() {
        // 结构闸：卡片上的那句话与按钮的 label 由**同一个函数**给，不许各写一份。
        // 这条用例的红法是具体的：把 `daemonStatsRecoveryLabel` 的调用换成写死的字符串，
        // 或者把 `retryButton` 的分支删回只调 `refreshDaemonStats()`，都会在这里点名变红。
        let view = sourceOf("EvidenceStatsView.swift")
        XCTAssertTrue(
            view.contains("ConsoleModel.daemonStatsRecoveryLabel(pathKnown: pathKnown)"),
            "按钮的措辞不再由判据给出，就会重新和它做的事分家"
        )
        XCTAssertTrue(
            view.contains("switch ConsoleModel.daemonStatsRecovery(pathKnown: pathKnown)"),
            "retryButton 又只剩一条手臂了"
        )
        XCTAssertTrue(
            view.contains("settings.refresh()"),
            "路径未知那一支没有走重新握手，就还是那颗按下去无事发生的按钮"
        )
        XCTAssertTrue(
            view.contains("@EnvironmentObject private var settings: SettingsModel"),
            "这一页拿不到握手那条路，句子就又成指着重在别的页上的按钮"
        )
        // 那句"没测得"的话不许再指向另一页的按钮名。判据只取**用户可见的那一行**
        // （`unmeasuredLine(…)` 的实参），不是整份文件——本文件自己的注释里还写着
        // 缺陷的旧句子，那是台账，不是文案。
        let sentences = view.components(separatedBy: "unmeasuredLine(\"").dropFirst()
            .compactMap { $0.components(separatedBy: "\")").first }
        XCTAssertFalse(sentences.isEmpty, "这一页的未测得句子被挪去哪了？")
        for line in sentences {
            XCTAssertFalse(
                line.contains("点「刷新」"),
                "补救句子又指回这张卡上不存在的按钮了：\(line)"
            )
        }
        XCTAssertTrue(
            sentences.contains { $0.contains("daemonStatsRecoveryLabel") },
            "那张卡的「没问过」句子没有跟着判据走，下一次改判据它又会先漂：\(sentences)"
        )
    }

    private func sourceOf(_ name: String) -> String {
        let root = URL(fileURLWithPath: String(#filePath))
            .deletingLastPathComponent()  // Tests/GlassPaneEngineTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // engine
            .appendingPathComponent("Sources/glasspane-settings/\(name)")
        return (try? String(contentsOf: root, encoding: .utf8)) ?? ""
    }
}
