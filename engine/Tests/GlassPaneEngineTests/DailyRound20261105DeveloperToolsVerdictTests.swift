import XCTest
import Foundation
@testable import GlassPaneEngine

/// 每日任务 2026-11-05 · `--check-developer-tools` 不许把"没量到"答成"被拒"。
///
/// 缺陷。这份报文只有一个 `granted` 布尔，而 `Snapshot.granted` 在**两件不同的事**上都回 false：
/// 系统明确拒绝这一席（`.denied`），和这一趟探测压根没跑成（`.timeout` / `.spawnFailed`——工具链
/// 不在位、lldb 那一臂没答）。`main.swift:1222` 又把它折成 `granted ? 0 : 1`，于是两种输入同一个
/// 号；而 payload 里那句 note 写的是"granted=false 的唯一人工步骤是系统设置勾选"——给一次没发生
/// 的测量指派了一个人工步骤。同文件的同族命令（`--check-input-permission`、`--check-accessibility`）
/// 早就按"取值表 + 词在打印里、码只说测没测"办（`DaemonPermissionVocabularyTests` 钉着），
/// 这一位是那一族里唯一还在用布尔答判决的。
///
/// 修法。三档词表 `granted|denied|unverifiable`（沿用面板那一卡与
/// `DaemonPermissionVocabularyTests` 已在用的那三个词，不另造第四个）进 payload，下一步随档位走（unverifiable 指工具链，
/// 不指勾选），退出码 0/1/5 各自一档——非零仍是"没成"，老调用方不必改，只是新的那一档能自己说清为什么。
///
/// REVERSE：把 `Snapshot.verdict` 折回 `attach == .ok ? granted : denied` ⇒
/// `anUnrunProbeIsNotADenial` 与 `theUnmeasuredStepNamesTheToolchain` 一起红；
/// 把 `main.swift` 那一支改回 `granted ? 0 : 1` ⇒ `theExitCodeHasThreeArmsNotTwo` 红。
final class DailyRound20261105DeveloperToolsVerdictTests: XCTestCase {

    private static let attachFlags = ["-p", "--attach-pid", "4242"]

    private struct StubRunner: DebugCapabilityProbe.Running {
        var launch: (exit: Int32?, timedOut: Bool, output: String)
        var attach: (exit: Int32?, timedOut: Bool, output: String)
        func run(_ binary: String, _ arguments: [String], timeout: TimeInterval)
            -> (exit: Int32?, timedOut: Bool, output: String) {
            arguments.contains(where: { Self.attachFlags.contains($0) }) ? attach : launch
        }
        static let attachFlags = DailyRound20261105DeveloperToolsVerdictTests.attachFlags
        func spawnVictim(seconds: Int) -> String? { "4242" }
        func killVictim(_ pid: Int32) {}
    }

    private func reading(_ state: String) -> (exit: Int32?, timedOut: Bool, output: String) {
        switch state {
        case "ok": return (0, false, "Process completed. exited with status 0")
        case "denied": return (1, false, "error: Not allowed to attach to process")
        case "timeout": return (nil, true, "")
        default: return (nil, false, "no lldb available on this machine")
        }
    }

    private func payload(launch: String, attach: String) -> [String: Any] {
        DebugCapabilityProbe(runner: StubRunner(
            launch: reading(launch), attach: reading(attach)
        )).jsonPayload()
    }

    private func verdict(_ json: [String: Any]) -> String { json["verdict"] as? String ?? "missing" }

    // MARK: - 三档各答各的

    func testTheThreeArmsAnswerWithThreeWords() {
        XCTAssertEqual(verdict(payload(launch: "ok", attach: "ok")), "granted")
        XCTAssertEqual(verdict(payload(launch: "ok", attach: "denied")), "denied")
        XCTAssertEqual(verdict(payload(launch: "denied", attach: "ok")), "denied",
            "一半被明确拒过，就不许被另一半的成功抵掉（既有判据）")
        XCTAssertEqual(verdict(payload(launch: "spawnFailed", attach: "spawnFailed")), "unverifiable")
        XCTAssertEqual(verdict(payload(launch: "ok", attach: "timeout")), "unverifiable")
    }

    func testAnUnrunProbeIsNotADenial() {
        let json = payload(launch: "spawnFailed", attach: "spawnFailed")
        XCTAssertEqual(verdict(json), "unverifiable")
        // `granted` 仍然为 false（老读码方按"没成"处理是对的），但句子不许再替系统答"被拒"。
        XCTAssertEqual(json["granted"] as? Bool, false)
        let note = json["note"] as? String ?? ""
        XCTAssertTrue(note.contains("unverifiable"), note)
        XCTAssertFalse(note.contains("唯一人工步骤"),
            "note 又把唯一出路写成勾选——那是一次没发生的测量的下一步：\(note)")
    }

    func testTheUnmeasuredStepNamesTheToolchain() {
        let json = payload(launch: "spawnFailed", attach: "timeout")
        let next = json["next"] as? String ?? ""
        XCTAssertTrue(next.contains("xcrun --find lldb") || next.contains("xcode-select --install"),
            "没跑成的下一步是工具链，不是权限勾选：\(next)")
        XCTAssertFalse(next.contains("System Settings"),
            "unverifiable 不许把人支到系统设置里去：\(next)")
        XCTAssertTrue(next.contains("--check-developer-tools"), "复验的那一条命令要能照抄：\(next)")
        // 三档的下一步互不替换：拒绝那一档才谈勾选。
        let denied = payload(launch: "ok", attach: "denied")["next"] as? String ?? ""
        XCTAssertTrue(denied.contains("System Settings"), denied)
        XCTAssertFalse(denied.contains("xcode-select"), denied)
        let granted = payload(launch: "ok", attach: "ok")["next"] as? String ?? ""
        XCTAssertTrue(granted.lowercased().contains("no manual step"), granted)
    }

    func testThePayloadNamesBothArmsItActuallyRead() {
        let json = payload(launch: "ok", attach: "timeout")
        let states = json["verdictStates"] as? [String: String] ?? [:]
        XCTAssertEqual(states, ["launch": "ok", "attach": "timeout"],
            "verdict 是两臂合算的，读者必须看得出是哪一臂没答：\(json)")
    }

    // MARK: - 接线：退出码三档（判据在可执行目标的顶层，只能对着源码核）

    func testTheExitCodeHasThreeArmsNotTwo() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/glasspaned/main.swift")
        let source = try XCTUnwrap(
            try? String(contentsOf: url, encoding: .utf8), "读不到 \(url.path)")
        let codeOnly = source.components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        XCTAssertFalse(
            codeOnly.contains("exit((payload[\"granted\"] as? Bool) == true ? 0 : 1)"),
            "那一支又回到把两件事折成一个号的老写法")
        XCTAssertTrue(codeOnly.contains("case \"granted\": exit(0)"), codeOnly.contains("verdict") ? "" : "找不到 verdict 分叉")
        XCTAssertTrue(codeOnly.contains("case \"denied\": exit(1)"))
        XCTAssertTrue(codeOnly.contains("default: exit(5)"),
            "第三档不在，unverifiable 就又被并进 denied 的号里")
        // 帮助页必须给这一号一个说法——`DaemonExitCodeTests` 的既有规矩：没文档的号不放行。
        XCTAssertTrue(codeOnly.contains("5   --check-developer-tools could not run its probe"),
            "EXIT CODES 那一格没写 5，读 rc 的人无从知道它是什么意思")
    }

    /// 每日任务 2026-11-08 · `--help` 里 `--check-developer-tools` 那一格**自己**也要交代 5。
    ///
    /// 缺陷。1.31.0 把"没量到"从 1 挪成 5 之后，EXIT CODES 那张表（705 行）改对了，
    /// 但 OPTIONS 里那一格还写着 "Exit 1 for a refusal **and for an arm that never reached
    /// a verdict**"——同一个文件里两处文档各说各话，读者只读那一格就拿到的仍是老契约：
    /// 一次没跑成的探测被许诺成"被拒"。`testTheExitCodeHasThreeArmsNotTwo` 钉的是那张表与
    /// `exit()` 三档，`DaemonExitCodeTests` 钉的是"表里没码不放行"，**两把都不读 OPTIONS 那一格**，
    /// 于是这一处漂移三档变两档之后一直绿着。
    ///
    /// 判据。那一格必须把"没量到"这一档点名到 5，并且不许再把"never reached a verdict"
    /// 与 exit 1 写在同一口气里。
    ///
    /// REVERSE：把那一格改回 "Exit 1 for a refusal and for an arm that never reached a
    /// verdict" ⇒ 这一条红（同时 EXIT CODES 那一格仍在，表那一把照旧绿——证明它抓的是
    /// OPTIONS 那一格而不是表）。
    func testTheFlagBlockItselfNamesExitFiveForAnUnmeasuredArm() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/glasspaned/main.swift")
        let source = try XCTUnwrap(
            try? String(contentsOf: url, encoding: .utf8), "读不到 \(url.path)")
        // 取 OPTIONS 里那一格：从 `--check-developer-tools` 那一行到下一个 `--` 开关或 EXIT CODES。
        let block = try XCTUnwrap(flagBlock(source, flag: "--check-developer-tools"),
            "OPTIONS 里找不到 --check-developer-tools 那一格")
        XCTAssertTrue(block.contains("5"),
            "--check-developer-tools 那一格没交代第三档退 5：\n\(block)")
        XCTAssertFalse(block.contains("Exit 1 for a refusal and for an arm that never reached a verdict"),
            "那一格又把'没量到'折回 exit 1（老契约）：\n\(block)")
    }

    /// OPTIONS 里一枚开关的整段：从该行起到下一枚 `--` 开关行（或 EXIT CODES / PROTOCOL）为止。
    /// 含开关那一行自己——那句"Exit 1/5…"就折行写在这一格里，丢掉它判据就看空。
    private func flagBlock(_ text: String, flag: String) -> String? {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        // 锚到 OPTIONS 里以这枚开关起头的那一行，不是它在别处（注释、flag 名单）的首次出现。
        guard let start = lines.firstIndex(where: {
            $0.trimmingCharacters(in: .whitespaces).hasPrefix(flag)
        }) else { return nil }
        var block = lines[start].trimmingCharacters(in: .whitespaces) + " "
        for line in lines[(start + 1)...] {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { break }
            if trimmed.hasPrefix("--") || trimmed.hasPrefix("EXIT CODES") || trimmed.hasPrefix("PROTOCOL") { break }
            block += trimmed + " "
        }
        return block.isEmpty ? nil : block
    }
}
