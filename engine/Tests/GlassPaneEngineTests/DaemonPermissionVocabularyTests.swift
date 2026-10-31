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
///
/// 2026-10-31 lane D 补的那一半：同一套判据的**读侧**从 `main.swift` 扩到 `engine/smoke.md`。
/// 这个命令的取值表在文档里有第二份读者（真机冒烟那一行是给 agent 与冒烟脚本抄的），而它一直
/// 不在任何闸下——所以代码与 usage 一起改到两态之后，文档那行还在承诺三态，两条闸一路绿着。
final class DaemonPermissionVocabularyTests: XCTestCase {

    private static let stateTokens = ["granted", "denied", "notDetermined", "unverifiable"]

    /// 文档里那一行"这条读数属于旧二进制"的标注锚点（`engine/smoke.md` 用的就是这个短语，
    /// 由下面那条文档闸反向钉住：历史记录要标注，标注要成句，句子要有可核对的版本日期）。
    private static let historicalRecordMarker = "旧二进制的历史记录"

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

    // MARK: - 文档那一侧：`engine/smoke.md` 里同一命令的取值表

    /// 这一条补的是上面两条闸的**盲区**，不是第二份重复闸。
    ///
    /// 为什么 `--check-input-permission` 从既有那条闸里漏了出去：它读的是被交付的
    /// `main.swift`，而冒烟记录里的同一张表活在 `engine/smoke.md`。2026-10-30 把探针收到
    /// `granted | unverifiable` 时，代码与 usage 一起改了（所以那两条一直绿），C33 那一行
    /// 却还写着"granted/denied/notDetermined 三态如实输出"——文档与代码打脸，而读者按文档去
    /// 等一个永远不出现的取值。可达集、token 表、判据全部沿用本类既有的那一份（`reachableInputMonitoring()`
    /// 现算、`tokensNamed(in:)` 同一套词），只是把读的那一侧换成文档：
    ///  - 提过这个命令的每一行，承诺的值必须是探针发得出来的（usage/文档说了、探针发不出 ⇒ 红）；
    ///  - 当下那张表所在的那一行（带"如实输出"的措辞）必须把可达集**整个**说出来（探针发得出、
    ///    文档不说 ⇒ 红；把这一行整块删掉或标成历史记录想绕过子集判据 ⇒ 同样红）。
    /// 历史记录那一类行是例外，但例外要付两样东西：点明它属于哪一版（一个 `2026-…` 日期），
    /// 并且不许同时自称当下的取值表。结论本身不改写，只标注。
    ///
    /// REVERSE：把 :138 那行改回"granted/denied/notDetermined 三态如实输出" ⇒ 本条红（两个
    /// 发不出的值 + 那张表自己不再等于可达集）；把 :183 那次 `notDetermined` 的标注删掉 ⇒
    /// 本条红（一行历史记录被当成了当下的读数）。
    func testSmokeDocInputPermissionTableEqualsWhatTheProbeCanPrint() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("engine/smoke.md")
        let text = try String(contentsOf: url, encoding: .utf8)
        let lines = text.components(separatedBy: "\n")
            .enumerated()
            .filter { $0.element.contains("--check-input-permission") }
            .map { ($0.offset + 1, $0.element) }
        XCTAssertFalse(lines.isEmpty, """
            engine/smoke.md 里再没有一行提到 --check-input-permission：这张表从文档里整块消失时\
            本条必须红，不许静默通过（真机冒烟的取值面就是没有读者的那一份契约）
            """)

        let reachable = reachableInputMonitoring()
        var currentTable = Set<String>()
        var tableLineNumbers: [Int] = []

        for (lineNumber, line) in lines {
            let isHistoricalRecord = line.contains(Self.historicalRecordMarker)
            if isHistoricalRecord {
                XCTAssertNil(
                    line.range(of: "如实输出"),
                    """
                    engine/smoke.md:\(lineNumber) 一面标成\(Self.historicalRecordMarker)、一面宣布这是当下的取值表：\
                    两个身份只能选一个，否则历史记录就成了绕过子集判据的后门
                    """
                )
                XCTAssertNotNil(
                    line.range(of: "20\\d\\d-\\d\\d-\\d\\d", options: .regularExpression),
                    """
                    engine/smoke.md:\(lineNumber) 报了一个探针发不出的值却没说它属于哪一版：\
                    读者无从判断这条读数是哪个二进制发的（标注要给出可核对的日期）
                    """
                )
                continue
            }
            let promised = tokensNamed(in: line)
            let unreachable = promised.subtracting(reachable)
            XCTAssertTrue(unreachable.isEmpty, """
                engine/smoke.md:\(lineNumber) 把 \(unreachable.sorted()) 说成 --check-input-permission 会输出的值，\
                而探针今天只发得出 \(reachable.sorted())：\(line)
                """)
            if line.contains("如实输出") {
                tableLineNumbers.append(lineNumber)
                currentTable.formUnion(promised)
            }
        }

        XCTAssertFalse(tableLineNumbers.isEmpty, """
            engine/smoke.md 里再没有一行说出 --check-input-permission 当下的取值表（带"如实输出"那一句不见了，\
            或者被标成了历史记录）：文档那一侧因此不再对可达集负责，这一条闸就失去了它要钉的那张表
            """)
        XCTAssertEqual(
            currentTable, reachable,
            "engine/smoke.md:\(tableLineNumbers) 那张取值表与可达集不等：表=\(currentTable.sorted()) 可达=\(reachable.sorted())"
        )
    }
}
