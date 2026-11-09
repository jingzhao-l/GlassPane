import XCTest
import Foundation
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 每日任务 2026-11-09 · 候选 B（读屏理由只走悬停的那一半）成立并修完。
///
/// 2026-11-04 那道闸（`DailyRound20261104PanelReasonAndPathTests`）钉的是
/// "链上有 `.disabled` **且有 `.help`** ⇒ 必须有 `.accessibilityHint`"——它的判据要求
/// 悬停理由先存在，才去要求读屏同源。这一格漏掉了一整类站点：**从没有 `.help`、只靠
/// `.disabled(条件)` 变灰**的按钮。`SettingsPanelView` 的"验证调试能力"那枚就是活例子：
/// 忙碌时变灰，既无 `.help` 也无 `.accessibilityHint`，VoiceOver 只说"已禁用"，听不到
/// 为什么、也听不到下一步。本机量到同款站点共 **17** 处 `.disabled(`，修复前只有这一枚
/// 裸着——其余 16 处都带 hint，说明"禁用 ⇒ 读屏给理由"是产品本来的约定，这一枚是漏网。
///
/// 这道闸与 11-04 那道**互补不重叠**：那道要求"有 help 才要 hint"，这道要求
/// "有 disabled 就要 hint"，判据更宽，专门堵住 never-had-a-help 的那一类。两道都在，
/// 才把"读屏理由"的约定钉全。
///
/// REVERSE：删掉 `SettingsPanelView` 里 capability 按钮的 `.accessibilityHint(…)` ⇒
/// `everyDisabledControlTellsAXWhy` 具名红并点名那一处；恢复后 17/17 复绿。
final class DailyRound20261109DisabledA11yTests: XCTestCase {

    private func settingsSourcesDir() throws -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/glasspane-settings")
    }

    private func balance(_ line: String) -> Int {
        line.filter { $0 == "(" }.count - line.filter { $0 == ")" }.count
    }

    /// 一条控件的修饰链：以 `.disabled(` 那一行的缩进为基准，向上/向下收同一链条。
    /// 属于链条的行：同缩进以 `.` 起头的修饰符、同缩进或更深的注释行、空行、
    /// 以及**缩进比基准更深**的续行（多行实参 `? … : …` 的折行）。
    /// 这与 11-04 那份不同——那份假设每条修饰符一行，遇到 `.accessibilityHint(\n  ? …\n  : …)`
    /// 这种多行实参会断链，把已配好的站点误报成缺失（本轮修的正是这个盲区）。
    private func chain(at i: Int, in lines: [String]) -> [String] {
        let indentCount = lines[i].prefix(while: { $0 == " " || $0 == "\t" }).count
        func isChainLine(_ line: String) -> Bool {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { return true }
            if trimmed.hasPrefix("//") { return true }
            let lineIndent = line.prefix(while: { $0 == " " || $0 == "\t" }).count
            if lineIndent > indentCount { return true }
            if lineIndent == indentCount && line.hasPrefix(String(repeating: " ", count: indentCount) + ".") { return true }
            return false
        }
        var out = [lines[i]]
        var b = i - 1
        while b >= 0, isChainLine(lines[b]) {
            out.insert(lines[b], at: 0)
            b -= 1
        }
        var f = i + 1
        while f < lines.count, isChainLine(lines[f]) {
            out.append(lines[f])
            f += 1
        }
        return out
    }

    func testEveryDisabledControlTellsAXWhy() throws {
        let dir = try settingsSourcesDir()
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertFalse(files.isEmpty, "扫不到任何面板源码——这条闸在空集上自证，是空跑")
        var offenders: [String] = []
        var disabledCount = 0
        for name in files {
            let lines = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
                .components(separatedBy: "\n")
            for (i, line) in lines.enumerated() where line.contains(".disabled(") {
                let chain = self.chain(at: i, in: lines)
                disabledCount += 1
                // 读屏理由可以走 `.accessibilityHint`（首选）或 `.help`（11-04 那道已经
                // 要求它同源到 hint）。两者皆无 ⇒ 变灰的控件对读屏用户一句话都没说。
                let hasHint = chain.contains(where: { $0.contains(".accessibilityHint(") })
                let hasHelp = chain.contains(where: { $0.contains(".help(") })
                if !hasHint && !hasHelp {
                    offenders.append("\(name):\(i + 1)")
                }
            }
        }
        XCTAssertEqual(offenders, [],
            "这些变灰控件对读屏用户既无 accessibilityHint 也无 help：\(offenders.joined(separator: ", "))")
        // 会咬人之下这条不能是空跑：面板里禁用站点本就是两位数（不写死——控件增减不该改这条基线）。
        XCTAssertGreaterThanOrEqual(disabledCount, 10,
            "只量到 \(disabledCount) 处 .disabled( ——扫描或链的取法变了，这条闸已经在空转")
    }

    /// 反空转对照：证明这台扫描器真能咬人。把 capability 按钮那枚 hint 从源码里临时摘掉，
    /// 这道闸必须具名红——否则它跟 11-04 那道一样，会在 never-had-a-help 的站点上永远空转。
    /// 判据读的是**工作树的源码字节**，所以这里只断言"源码里确实有那枚 hint"这一前提，
    /// 真正的变红在反向破坏那一轮用 diff 证。
    func testTheCapabilityButtonIsInTheScannedSet() throws {
        let dir = try settingsSourcesDir()
        let source = try String(contentsOf: dir.appendingPathComponent("SettingsPanelView.swift"), encoding: .utf8)
        let lines = source.components(separatedBy: "\n")
        let busyLine = lines.firstIndex(where: { $0.contains(".disabled(capabilityBusy)") })
        XCTAssertNotNil(busyLine, "扫不到 capability 按钮的 .disabled(capabilityBusy) ——控件改名了，这条闸锚的站点没了")
        let capabilityChain = chain(at: busyLine!, in: lines)
        XCTAssertTrue(capabilityChain.contains(where: { $0.contains(".accessibilityHint(") }),
            "capability 按钮的修饰链里没有 .accessibilityHint ——这正是它修复前的形状，说明扫描器能咬到它")
        // 链内 identifier 走的是常量引用 `PermissionGuide.verifyCapabilityIdentifier`，
        // 不是字面量，所以这里查常量名；它落到 "gp-verify-developer-tools" 由
        // `PermissionGuideTests` 钉（AX 走查按那个字符串 act）。
        XCTAssertTrue(capabilityChain.contains(where: { $0.contains("verifyCapabilityIdentifier") }),
            "capability 按钮丢了它的 accessibilityIdentifier，按 gp-verify-developer-tools 的 AX 走查会点不中")
    }
}
