import XCTest
import Foundation
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 每日任务 2026-11-04（同日第二条会话）· 候选 A 与候选 C 复核成立并修完。
///
/// **A**：2026-11-03 的 #23 给"按不动的控件把理由只写在悬停里"补了 `accessibilityHint`，
/// 只补了两处（`EvidenceTabView:183`、`ApprovalsTabView:79`）——而本机量到的同款站点是
/// **12** 处（一份用 `.help`、没有 `.accessibilityHint` 的 `.disabled` 控件链）。改 A 面留 B 面
/// 就是半修：读屏用户按下去仍然只知道"按不动"，不知道为什么、也不知道下一步做什么。
/// 这条闸按**目录扫描**取文件（不点名文件，名单永远少下一枚是本仓第五次咬人的形状），
/// 并把不变量钉成"链上有 `.disabled` 且有 `.help` ⇒ 同链必须有 `.accessibilityHint`"。
///
/// **C**：`UpdatePanel.consentGateNextStepText` 把更新器程序路径裸插进"照着跑"的命令
/// （`node \(updaterPath) status`），而同一条命令里的状态根走了 `RemedyCommand.quote`。
/// 交付形态里这一枚路径可以含空格（本仓那条 `GlassPane Daemon.app` 就是活例子），裸插值会把
/// 一条命令劈成两句，读者照抄拿到的是"找不到文件"而不是出路。
///
/// REVERSE：删掉任一 `.accessibilityHint` ⇒ `everyDisabledControlWithAHelpSaysItsReasonToAXToo` 红并点名那一处；
/// 把 `RemedyCommand.quote(updaterPath)` 改回裸插值 ⇒ `theUpdaterPathIsOneWholeShellWord` 红。
final class DailyRound20261104PanelReasonAndPathTests: XCTestCase {

    private func settingsSourcesDir() throws -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/glasspane-settings")
    }

    private func balance(_ line: String) -> Int {
        line.filter { $0 == "(" }.count - line.filter { $0 == ")" }.count
    }

    /// 一条控件的修饰链：从本行向两侧延伸、同一缩进上以 `.` 开头的连续行。
    /// 括号要**配平着走**——`model.isRestartInFlight ? … : …` 这种多行实参的续行既不以 `.`
    /// 开头也不是链的尽头；按"是否以点开头的缩进行"判会在实参中间就断链，把已配好的站点误报成缺失。
    private func chain(at i: Int, in lines: [String]) -> [String] {
        let indent = String(lines[i].prefix(while: { $0 == " " || $0 == "\t" }))
        func isModifier(_ line: String) -> Bool {
            line.hasPrefix(indent + ".") || line.hasPrefix(indent + "    .")
        }
        var out = [lines[i]]
        var open = balance(lines[i])
        var b = i - 1
        while b >= 0, isModifier(lines[b]) {
            out.insert(lines[b], at: 0)
            open += balance(lines[b])
            b -= 1
        }
        var f = i + 1
        while f < lines.count {
            if open > 0 || isModifier(lines[f]) {
                out.append(lines[f])
                open += balance(lines[f])
                f += 1
                continue
            }
            break
        }
        return out
    }

    // MARK: - A

    func testEveryDisabledControlWithAHelpSaysItsReasonToAXToo() throws {
        let dir = try settingsSourcesDir()
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertFalse(files.isEmpty, "扫不到任何面板源码——这条闸在空集上自证，是空跑")
        var offenders: [String] = []
        var disabledWithHelp = 0
        for name in files {
            let lines = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
                .components(separatedBy: "\n")
            for (i, line) in lines.enumerated() where line.contains(".help(") {
                let chain = chain(at: i, in: lines)
                guard chain.contains(where: { $0.contains(".disabled(") }) else { continue }
                disabledWithHelp += 1
                if !chain.contains(where: { $0.contains(".accessibilityHint(") }) {
                    offenders.append("\(name):\(i + 1)")
                }
            }
        }
        XCTAssertEqual(offenders, [],
            "这些按不动的控件只把理由给了悬停，没给读屏：\(offenders.joined(separator: ", "))")
        // 会咬人之下这条不能是空跑：面板里"禁用且有理由"的站点本就有两位数。
        XCTAssertGreaterThanOrEqual(disabledWithHelp, 10,
            "只量到 \(disabledWithHelp) 处禁用带理由的控件——扫描或链的取法变了，这条闸已经在空转")
    }

    func testTheHintRepeatsTheHelpSentenceNotASecondOne() throws {
        // 同源要求：链上的 hint 与 help 必须是同一个表达式，否则两处各改一次又是一条事实两种拼写。
        let dir = try settingsSourcesDir()
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".swift") }
        var checked = 0
        for name in files {
            let lines = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
                .components(separatedBy: "\n")
            for (i, line) in lines.enumerated() where line.contains(".help(") {
                let chain = chain(at: i, in: lines)
                guard chain.contains(where: { $0.contains(".disabled(") }),
                      let hint = chain.first(where: { $0.contains(".accessibilityHint(") }) else { continue }
                let helpArg = line.components(separatedBy: ".help(").dropFirst().joined(separator: ".help(")
                let hintArg = hint.components(separatedBy: ".accessibilityHint(").dropFirst().joined(separator: ".accessibilityHint(")
                let head = helpArg.prefix(24)
                XCTAssertTrue(hintArg.hasPrefix(head),
                    "\(name):\(i + 1) 的 hint 与 help 不是同一句话：help=\(head) hint=\(hintArg.prefix(24))")
                checked += 1
            }
        }
        XCTAssertGreaterThanOrEqual(checked, 10, "同源核对只走了 \(checked) 处——它在空转")
    }

    // MARK: - C

    func testTheUpdaterPathIsOneWholeShellWord() {
        let spaced = "/Users/someone/Applications/Glass Pane Update/updater/cli.js"
        let text = UpdatePanel.consentGateNextStepText(updaterPath: spaced, stateRoot: "/tmp/my root")
        XCTAssertTrue(text.contains("'\(spaced)'"),
            "更新器路径必须整体带引号成一个词，否则含空格的安装位会被劈成两句：\(text)")
        XCTAssertFalse(text.contains("node \(spaced)"),
            "同一条命令里不许再出现裸插值的那一份：\(text)")
        // 状态根那一半本来就走引号，这里复核两半同规则（一条命令两种口径就是 #28 那一族）。
        XCTAssertTrue(text.contains("--state-dir '/tmp/my root'"), text)
    }
}
