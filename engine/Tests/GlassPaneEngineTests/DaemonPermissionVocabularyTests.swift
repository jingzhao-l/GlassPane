import XCTest
@testable import GlassPaneEngine

/// `--help` 的取值表是 agent 与冒烟脚本据以分叉的契约，不是说明文。
///
/// 本轮把三个权限探针的诚实值改成 `unverifiable`（问过而系统没答不是"被拒"；AX 只回一个
/// 布尔，"没问过"与"被关掉"分不开），代码改了、卡片改了，`--help` 那三行却还写着旧词表：
/// 它一边承诺 `denied` 是一次打印得出来的值，一边漏掉现在真会打印的 `unverifiable`；
/// `--guide-screen-permission` 的回执还在说 "Permission still denied after the request."。
///
/// 两边的取法都不许抄字面量：可达集合由探针自己算（注入 preflight / request），文案从被
/// 交付的 `main.swift` 里按帮助块的段落切出来读。把任何一侧改回旧行为都会让这条红——包括
/// 把探针改回 `hasRequestedThisRun ? .denied : .notDetermined`（可达集合变了，表就不等）与
/// 把文案改回 `(granted | denied | notDetermined)`（表里出现一个打印不出来的值）。
final class DaemonPermissionVocabularyTests: XCTestCase {

    private static let stateTokens = ["granted", "denied", "notDetermined", "unverifiable"]

    private func mainSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("engine/Sources/glasspaned/main.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// `--help` 里某一条旗标自己那一段：从它的标题行起，到下一条同缩进的旗标行为止。
    private func helpSegment(for flag: String, in source: String) throws -> String {
        let lines = source.components(separatedBy: "\n")
        let prefix = "        \(flag)"
        let start = try XCTUnwrap(
            lines.firstIndex { $0.hasPrefix(prefix) },
            "--help 里找不到 \(flag) 这一段——文案被整块挪走时这条闸必须红，不许静默通过"
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
        Set(Self.stateTokens.filter {
            text.range(of: "\\b\($0)\\b", options: .regularExpression) != nil
        })
    }

    // MARK: - 可达集合：由探针自己算

    private func reachableScreenRecording() -> Set<String> {
        let granted = ScreenCapturePermissionProbe(preflight: { true }, requestAccess: {})
        let asked = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {})
        _ = asked.guideAccess()          // 问过、系统未答：这一条路径也在表的责任范围里
        let fresh = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {})
        return [
            granted.state.rawValue, granted.panelStatus.rawValue,
            asked.state.rawValue, asked.panelStatus.rawValue,
            fresh.state.rawValue, fresh.panelStatus.rawValue,
        ].reduce(into: Set<String>()) { $0.insert($1) }
    }

    private func reachableInputMonitoring() -> Set<String> {
        let granted = InputMonitoringPermissionProbe(
            preflight: { true }, requestAccess: {}, openPane: {}
        )
        let asked = InputMonitoringPermissionProbe(
            preflight: { false }, requestAccess: {}, openPane: {}
        )
        _ = asked.requestAccess()
        let fresh = InputMonitoringPermissionProbe(
            preflight: { false }, requestAccess: {}, openPane: {}
        )
        return [granted.state.rawValue, asked.state.rawValue, fresh.state.rawValue]
            .reduce(into: Set<String>()) { $0.insert($1) }
    }

    private func reachableAccessibility() -> Set<String> {
        let trusted = AccessibilityPermissionProbe(trustCheck: { true })
        let untrusted = AccessibilityPermissionProbe(trustCheck: { false })
        return [trusted.displayStatus().rawValue, untrusted.displayStatus().rawValue]
            .reduce(into: Set<String>()) { $0.insert($1) }
    }

    // MARK: - 闸

    /// `--check-screen-permission` 打印的是 `state`（面板读的那一面另有 `panelStatus`），可达集合
    /// 由探针自己算——两侧都不抄字面量。2026-10-30 S1-3 之前这里写着一条硬编码的
    /// `printed = ["granted", "notDetermined"]`：那条闸因此会跟着旧行为一起绿，而"表里出现一个
    /// 打印不出来的值"正是它要防的事，抄字面量等于让闸自己背书。
    func testCheckScreenPermissionHelpNamesOnlyWhatItCanPrint() throws {
        let segment = try helpSegment(for: "--check-screen-permission", in: mainSource())
        let reachable = reachableScreenRecording()
        XCTAssertFalse(reachable.contains("notDetermined"),
                       "屏幕录制的席位又能报 notDetermined 了——那是面板念成「未请求」的那句历史")
        XCTAssertEqual(tokensNamed(in: segment), reachable,
                       "--check-screen-permission 的取值表与可达集合不等：表=\(segment) 可达=\(reachable)")
    }

    func testCheckInputPermissionHelpEqualsItsReachableSet() throws {
        let segment = try helpSegment(for: "--check-input-permission", in: mainSource())
        let reachable = reachableInputMonitoring()
        XCTAssertFalse(reachable.contains("denied"),
                       "输入监控探针又回到 `state` 能给出 denied 的形状——那正是本轮改掉的假判决")
        XCTAssertEqual(tokensNamed(in: segment), reachable,
                       "--check-input-permission 的取值表与可达集合不等：表=\(segment) 可达=\(reachable)")
    }

    func testCheckAccessibilityHelpEqualsItsReachableSet() throws {
        let segment = try helpSegment(for: "--check-accessibility", in: mainSource())
        let reachable = reachableAccessibility()
        XCTAssertEqual(tokensNamed(in: segment), reachable,
                       "--check-accessibility 的取值表与可达集合不等：表=\(segment) 可达=\(reachable)")
    }

    /// 那句给人读的回执同样不许替系统作判决。
    func testGuideMessageDoesNotClaimADenialNobodyMeasured() throws {
        let source = try mainSource()
        XCTAssertFalse(
            source.contains("Permission still denied after the request"),
            "--guide-screen-permission 又在一问未答的时候宣告被拒绝了——预检的 false 支持不到那句话"
        )
        XCTAssertTrue(
            source.contains("Screen recording is still not granted after the request"),
            "该说清楚的还是要说：没批，以及下一步动作是什么"
        )
    }
}
