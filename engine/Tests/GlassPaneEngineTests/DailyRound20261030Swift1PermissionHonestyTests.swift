import XCTest
import Foundation
@testable import GlassPaneEngine

/// 每日任务 2026-10-30 · 泳道 1 · 缺陷 3：四个权限席位里有两张卡拿**一个布尔**说不支持的那句话。
///
/// 危害。`CGPreflightListenEventAccess()` / `CGPreflightScreenCaptureAccess()` 只回一个布尔，
/// false 同时装着"从没问过"、"问过还挂着"、"问过被拒了"、"上次运行被拒、这次没问"——TCC 是
/// 持久的，`hasRequestedThisRun` 是**每进程**的。而：
///  - `InputMonitoringPermissionProbe.state` 回 `hasRequestedThisRun ? .unverifiable : .notDetermined`
///    ⇒ 上一次运行里被拒的席位，这次读出来是 `.notDetermined`；
///  - `ScreenCapturePermissionProbe.state` 在预检 false 时**一律**回 `.notDetermined`，注释还写着
///    "预检 false 只支持'系统尚未决定'这一句"——那句本身就是超额主张：false 也支持"已经决定：拒"。
/// 面板把 `notDetermined` 渲染成「未请求」（`PermissionBadge.make`），所以这两张卡是在**替系统
/// 声明一段它没量过的历史**。第三张卡（辅助功能）早就为同一件事改过：`displayStatus()` 只认
/// true → `.granted`，其余 → `.unverifiable`。
///
/// 修法住在探针层（判决属于 Swift，不属于面板的文案）：预检 false 最多支持"没量到 granted"，
/// 所以诚实值是 `.unverifiable`；`hasRequestedThisRun` 退回去只管**措辞**（`hasPendingRequestThisRun`
/// 仍然说这次运行问没问过），不再管判定。取值表跟着走：`--help` 那三行、`--permissions` 的 JSON
/// 席位、`--check-*` 打印的词，两边由 `DaemonPermissionVocabularyTests` 与本文件钉在一起。
///
/// REVERSE：把任一回退成 `hasRequestedThisRun ? .unverifiable : .notDetermined` → 前两条红；
/// 把屏幕录制那一支改回 `.notDetermined` → 第三条红；把帮助表改回旧词表 → 取值表那条红；
/// 面板把 `.unverifiable` 那张卡的「授权」按钮摘掉 → 可动作用那条红。
final class DailyRound20261030Swift1PermissionHonestyTests: XCTestCase {

    private let stateTokens = ["granted", "denied", "notDetermined", "unverifiable"]

    // MARK: - 夹具：从被交付的 main.swift 里读 `--help` 的段落（两侧都不许抄字面量）

    private func mainSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/glasspaned/main.swift")
        return try XCTUnwrap(try? String(contentsOf: url, encoding: .utf8), "读不到 \(url.path)")
    }

    private func helpSegment(for flag: String, in source: String) throws -> String {
        let lines = source.components(separatedBy: "\n")
        let start = try XCTUnwrap(
            lines.firstIndex { $0.hasPrefix("        \(flag)") },
            "--help 里找不到 \(flag) 这一段"
        )
        var collected = [lines[start]]
        var i = start + 1
        while i < lines.count {
            let line = lines[i]
            if line.range(of: "^ {8}--\\S", options: .regularExpression) != nil { break }
            collected.append(line)
            i += 1
        }
        return collected.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
    }

    private func tokensNamed(in text: String) -> Set<String> {
        Set(stateTokens.filter { text.range(of: "\\b\($0)\\b", options: .regularExpression) != nil })
    }

    // MARK: - 输入监控：一个布尔撑不起"未请求"

    /// 一次都没问过的探针，预检 false ⇒ 只能说"没量到"。这是本轮那条缺陷本体：修前这里回
    /// `.notDetermined`，面板据此写「未请求」，而上一次运行里被拒的席位走的正是这一支。
    func testNeverAskedInputMonitoringSeatIsNotReportedAsNeverAsked() {
        let probe = InputMonitoringPermissionProbe(
            preflight: { false }, requestAccess: {}, openPane: {}
        )
        XCTAssertNotEqual(probe.state, .notDetermined,
                          "预检 false 被说成\"系统还没决定/没问过\"——一次询问都没发生过，这句话没有量过")
        XCTAssertEqual(probe.state, .unverifiable, "产品的\"没量到\"就是这一个值")
        XCTAssertFalse(probe.hasPendingRequestThisRun, "措辞那一面仍然要说这次没问过——它管文案，不管判定")
    }

    /// 问过、系统没答：判定与没问过**同一个词**（都是没量到），措辞由 `hasPendingRequestThisRun`
    /// 承担；单调性原样保留（问过之后不许回退）。
    func testAskedInputMonitoringSeatStaysUnverifiableAndKeepsTheWordingFlag() {
        let probe = InputMonitoringPermissionProbe(
            preflight: { false }, requestAccess: {}, openPane: {}
        )
        _ = probe.requestAccess()
        XCTAssertEqual(probe.state, .unverifiable)
        XCTAssertTrue(probe.hasPendingRequestThisRun,
                      "这次确实问过了——那句话是说得出口的，而它不是判定")
        XCTAssertEqual(probe.state, .unverifiable, "状态必须单调，不得回退")
        XCTAssertNotEqual(probe.state, .denied, "没人回答的询问不是一次拒绝")
    }

    func testGrantedInputMonitoringSeatIsUnaffected() {
        let probe = InputMonitoringPermissionProbe(preflight: { true }, requestAccess: {}, openPane: {})
        XCTAssertEqual(probe.state, .granted)
        XCTAssertFalse(probe.hasPendingRequestThisRun)
    }

    // MARK: - 屏幕录制：同一件事的两个出口

    /// `ScreenCapturePermissionProbe` 的两个出口都不许再说"未请求"：预检 false 一次问都没问过
    /// 时回的是"没量到"，`panelStatus`（daemon 快照 / `hello` / `--permissions` 读的那一面）同理。
    func testNeverAskedScreenRecordingSeatIsNotReportedAsNeverAsked() {
        let probe = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {})
        XCTAssertNotEqual(probe.state.rawValue, "notDetermined",
                          "席位自己那一面又把 false 读成\"系统尚未决定\"——同一张卡同一句超额主张")
        XCTAssertEqual(probe.state.rawValue, "unverifiable", "产品的\"没量到\"就是这一个值")
        XCTAssertNotEqual(probe.panelStatus, .notDetermined, "面板那一面渲染成「未请求」")
        XCTAssertEqual(probe.panelStatus, .unverifiable)
        XCTAssertFalse(probe.hasPendingRequestThisRun, "措辞面照旧如实")
    }

    func testAskedScreenRecordingSeatKeepsTheSameVerdictAndTheWordingFlag() {
        let probe = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {})
        _ = probe.guideAccess()
        XCTAssertEqual(probe.panelStatus, .unverifiable)
        XCTAssertTrue(probe.hasPendingRequestThisRun)
        XCTAssertEqual(probe.state.rawValue, probe.panelStatus.rawValue,
                       "两个出口同一个事实源，答案不许分叉")
        XCTAssertNotEqual(probe.state, .denied)
        let granted = ScreenCapturePermissionProbe(preflight: { true }, requestAccess: {})
        XCTAssertEqual(granted.state, .granted)
        XCTAssertEqual(granted.panelStatus, .granted)
    }

    /// 快照那一面（`hello.permissions` / `--permissions` 的 JSON 席位）：两个探针都不再产出
    /// `notDetermined`，`granted` 与 `denied` 的语义一条不动。
    func testSnapshotCarriesNoNeverAskedClaimFromEitherProbe() {
        let input = InputMonitoringPermissionProbe(preflight: { false }, requestAccess: {}, openPane: {})
        let screen = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {})
        let set = PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(trustCheck: { false }, prompt: {}, openPane: {}),
            inputMonitoring: input,
            screenRecording: screen,
            developerTools: DeveloperToolsPermissionProbe(openPane: {}),
            subjectProvider: { PermissionSubject(binaryPath: "/x/glasspaned") }
        )
        let snapshot = set.snapshot()
        for kind in [PermissionKind.accessibility, .inputMonitoring, .screenRecording] {
            XCTAssertEqual(snapshot.status(for: kind), .unverifiable,
                           "\(kind.cliValue) 这张卡又在替系统声明一段没量过的历史")
            XCTAssertNotEqual(snapshot.permissionsWire[kind.rawValue], "notDetermined",
                              "JSON 席位那一面还在写 notDetermined")
        }
        // 批下来的仍然点亮：诚实值不许把一次实测吞掉。
        let granted = PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(trustCheck: { true }, prompt: {}, openPane: {}),
            inputMonitoring: InputMonitoringPermissionProbe(preflight: { true }, requestAccess: {}, openPane: {}),
            screenRecording: ScreenCapturePermissionProbe(preflight: { true }, requestAccess: {}),
            developerTools: DeveloperToolsPermissionProbe(openPane: {}),
            subjectProvider: { PermissionSubject(binaryPath: "/x/glasspaned") }
        )
        XCTAssertEqual(granted.snapshot().status(for: .screenRecording), .granted)
        XCTAssertEqual(granted.snapshot().status(for: .inputMonitoring), .granted)
    }

    /// `PermissionProbeSet.request(_:)` 是 daemon"以自身身份申请"的出口：申请后没被回答的两张
    /// 卡都回诚实值，批下来的那张照旧回 `granted`。
    func testRequestSurfaceIsHonestForBothSeats() {
        let set = PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(trustCheck: { false }, prompt: {}, openPane: {}),
            inputMonitoring: InputMonitoringPermissionProbe(preflight: { false }, requestAccess: {}, openPane: {}),
            screenRecording: ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {}),
            developerTools: DeveloperToolsPermissionProbe(openPane: {}),
            inputTapProbe: { true },
            subjectProvider: { PermissionSubject(binaryPath: "/x/glasspaned") }
        )
        XCTAssertEqual(set.request(.inputMonitoring), .unverifiable)
        XCTAssertEqual(set.request(.screenRecording), .unverifiable)
        XCTAssertEqual(set.request(.accessibility), .unverifiable)
    }

    // MARK: - 取值表：`--help` 与探针可达集一条不许分叉

    /// 两个 check 旗标的取值表 = 探针真打印得出来的集合。修前这里两边都是
    /// `{granted, notDetermined}` / `{granted, notDetermined, unverifiable}`，可达集却不含
    /// `notDetermined`——表里出现一个命令打印不出来的值，比不写更坏。
    func testHelpTablesNameOnlyWhatTheChecksCanPrint() throws {
        let source = try mainSource()
        let inputReachable: Set<String> = [
            InputMonitoringPermissionProbe(preflight: { true }, requestAccess: {}, openPane: {}).state.rawValue,
            InputMonitoringPermissionProbe(preflight: { false }, requestAccess: {}, openPane: {}).state.rawValue,
        ].reduce(into: Set<String>()) { $0.insert($1) }
        let screenReachable: Set<String> = [
            ScreenCapturePermissionProbe(preflight: { true }, requestAccess: {}).state.rawValue,
            ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {}).state.rawValue,
            ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {}).panelStatus.rawValue,
        ].reduce(into: Set<String>()) { $0.insert($1) }
        XCTAssertEqual(inputReachable, ["granted", "unverifiable"], "可达集自己就不对：\(inputReachable)")
        XCTAssertEqual(screenReachable, ["granted", "unverifiable"], "可达集自己就不对：\(screenReachable)")
        for (flag, reachable) in [("--check-input-permission", inputReachable),
                                  ("--check-screen-permission", screenReachable)] {
            let segment = try helpSegment(for: flag, in: source)
            XCTAssertEqual(tokensNamed(in: segment), reachable,
                             "\(flag) 的取值表与可达集合不等：表=\(segment) 可达=\(reachable)")
        }
    }

    // MARK: - 面板那一侧：诚实值不能是死路

    /// `.unverifiable` 那张卡必须仍然给得出一个可执行动作（辅助功能卡是这里的样板：
    /// `gp-perm-accessibility-unverifiable` +「授权」按钮）。判定改了，动作不许跟着没。
    func testUnverifiableSeatStillOffersAnAction() throws {
        for kind in [PermissionKind.accessibility, .inputMonitoring, .screenRecording] {
            XCTAssertEqual(
                PermissionGuide.statusIdentifier(kind: kind, status: .unverifiable),
                "gp-perm-\(kind.cliValue)-unverifiable"
            )
            XCTAssertEqual(PermissionGuide.statusIcon(for: .unverifiable), "questionmark.circle")
        }
        let panel = try XCTUnwrap(
            try? String(contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Sources/glasspane-settings/SettingsPanelView.swift"), encoding: .utf8),
            "读不到面板源码"
        )
        // 引导按钮那一个 `switch entry.status`：`.unverifiable` 那一支必须仍旧回一个能点的动作，
        // 而且这套动作不许只挂在 `.notDetermined` 上——判定搬到 unverifiable 之后，挂在旧值上的
        // 分支就等于没有分支。
        guard let switchRange = panel.range(of: "private var buttonTitle: String") else {
            return XCTFail("面板的 buttonTitle 不见了：这一条对照没有对照物")
        }
        let body = panel[switchRange.lowerBound..<panel.endIndex]
        let unverifiableArm = try XCTUnwrap(
            body.range(of: "case .unverifiable:"),
            "buttonTitle 不再有 `.unverifiable` 这一支——诚实值成了一张没有动作的卡"
        )
        XCTAssertTrue(
            String(body[unverifiableArm.upperBound..<body.endIndex]).prefix(400).contains("授权"),
            "`.unverifiable` 那一支不再给出「授权」这个可执行动作"
        )
    }
}
