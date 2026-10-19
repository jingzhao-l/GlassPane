import XCTest
@testable import GlassPaneEngine

/// `--help` 的取值表是 agent 与冒烟脚本据以分叉的契约，不是装饰。
///
/// 本轮把三个权限探针的诚实值改成了 `unverifiable`（问过而系统未答不是"被拒"；AX 只有
/// 一个布尔，"没问过"与"被关掉"分不开），代码改了、卡片改了，`--help` 里那三行却还写着
/// 旧词表——它一边承诺 `denied` 是一个打印得出来的值，一边漏掉现在真会打印的
/// `unverifiable`。按那份表写的分支会永远走不到它该走的那条。同一件事在 `--guide-screen-permission`
/// 的输出里也有：一句 "Permission still denied after the request." 替一次系统还没作决定的
/// 询问宣告了拒绝。
///
/// 这条闸不抄字面量：可达集合从探针自己算（注入 preflight / request），文案从被交付的
/// `main.swift` 里读，两边对上才算数。把探针改回旧行为会让它红——那是它存在的理由。
final class DaemonPermissionVocabularyTests: XCTestCase {

    private static let stateTokens = ["granted", "denied", "notDetermined", "unverifiable"]

    private func mainSource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
        let path = url.deletingLastPathComponent()
            .appendingPathComponent("Sources/glasspaned/main.swift").path
        return try String(contentsOfFile: path, encoding: .utf8)
    }

    /// 从 `--help` 里切出某一条旗标自己那一段：从"旗标 + 至少三个空格 + 说明"那一行起，
    /// 到下一条同形状的说明行为止。锚必须带 "Print"，否则会撞上文件头那份纯名字清单。
    private func helpSegment(for flag: String, in source: String) throws -> String {
        let lines = source.components(separatedBy: "\n")
        let start = try XCTUnwrap(
            lines.firstIndex { $0.trimmingCharacters(in: .whitespaces).hasPrefix("\(flag)   ") },
            "--help 里找不到 \(flag) 这一段——文案被整块挪走时这条闸必须红，不许静默通过"
        )
        var collected: [String] = [lines[start].trimmingCharacters(in: .whitespaces)]
        var i = start + 1
        while i < lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
            if trimmed.range(of: "^--\\S+\\s{3,}", options: .regularExpression) != nil { break }
            collected.append(trimmed)
            i += 1
        }
        return collected.joined(separator: " ")
    }

    private func tokensNamed(in text: String) -> Set<String> {
        Set(Self.stateTokens.filter { token in
            text.range(of: "\\b\(token)\\b", options: .regularExpression) != nil
        })
    }

    // MARK: - the reachable sets, computed from the probes themselves

    private func reachableScreenRecording() -> Set<String> {
        let granted = ScreenCapturePermissionProbe(preflight: { true }, requestAccess: {})
        let silent = ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {})
        _ = silent.guideAccess()   // 问过之后仍没有回答：这条路径的取值也在表里
        return [granted.state.rawValue, silent.state.rawValue, silent.panelStatus.rawValue]
            .reduce(into: Set<String>()) { $0.insert($1) }
    }

    private func reachableInputMonitoring() -> Set<String> {
        let granted = InputMonitoringPermissionProbe(
            preflight: { true }, requestAccess: {}, openPane: {}
        )
        let asked = InputMonitoringPermissionProbe(
            preflight: { false }, requestAccess: {}, openPane: {}
        )
        _ = asked.requestAccess()
        let never = InputMonitoringPermissionProbe(
            preflight: { false }, requestAccess: {}, openPane: {}
        )
        return [granted.state.rawValue, asked.state.rawValue, never.state.rawValue]
            .reduce(into: Set<String>()) { $0.insert($1) }
    }

    private func reachableAccessibility() -> Set<String> {
        let trusted = AccessibilityPermissionProbe(isTrusted: { true })
        let untrusted = AccessibilityPermissionProbe(isTrusted: { false })
        return [trusted.displayStatus().rawValue, untrusted.displayStatus().rawValue]
            .reduce(into: Set<String>()) { $0.insert($1) }
    }

    // MARK: - the gate

    func testCheckScreenPermissionHelpNamesExactlyWhatItCanPrint() throws {
        let segment = try helpSegment(for: "--check-screen-permission", in: mainSource())
        let reachable = reachableScreenRecording()
        XCTAssertEqual(reachable, ["granted", "notDetermined"], "探针自己算出来的可达集合变了：\(reachable)")
        for value in reachable {
            XCTAssertTrue(
                tokensNamed(in: segment).contains(value),
                "--check-screen-permission 打印得出 \(value)，取值表却漏了它：\(segment)"
            )
        }
        for value in tokensNamed(in: segment).subtracting(reachable) {
            XCTFail("--help 教调用方分叉到一个这条命令打印不出来的值 \(value)：\(segment)")
        }
    }

    func testCheckInputPermissionHelpNamesExactlyWhatItCanPrint() throws {
        let segment = try helpSegment(for: "--check-input-permission", in: mainSource())
        let reachable = reachableInputMonitoring()
        XCTAssertEqual(
            reachable, ["granted", "notDetermined", "unverifiable"],
            "输入监控探针现在的可达集合变了；这条闸要跟着改判据，不是把表改回去"
        )
        XCTAssertEqual(tokensNamed(in: segment), reachable, "--check-input-permission 的取值表与可达集合不等：\(segment)")
    }

    func testCheckAccessibilityHelpNamesExactlyWhatItCanPrint() throws {
        let segment = try helpSegment(for: "--check-accessibility", in: mainSource())
        let reachable = reachableAccessibility()
        XCTAssertEqual(reachable, ["granted", "unverifiable"], "AX 那一个布尔能给出的集合变了：\(reachable)")
        XCTAssertEqual(tokensNamed(in: segment), reachable, "--check-accessibility 的取值表与可达集合不等：\(segment)")
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
            "该说的还是要说清楚：没批，并且这一步的下一步动作是什么"
        )
    }
}
