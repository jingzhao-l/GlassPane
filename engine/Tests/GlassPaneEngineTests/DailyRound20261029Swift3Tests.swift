import XCTest
import Foundation
@testable import GlassPaneEngine

/// 每日任务 2026-10-29 · 修复泳道 4（Swift daemon 的 CLI 参数与状态根）。
///
/// 台账里的三条（S4-1/S4-2/S4-3）加一条泳道 2 的交接，四种"这一串 argv 说了却不做"：
///
///  1. **S4-1 重复的取值旗静默后者胜。** 本机在 1.25.2 的真二进制上实测：
///     `glasspaned --state-dir A --state-dir B --list-projects` ⇒ rc 0、A 被丢弃、stderr 零字节；
///     `--project-remove idA --project-remove idB` ⇒ 只处理 idB、rc 3、idA 一个字没提。
///     "后来者胜"没有任何一处写过——它只是第二次 `options.x = …` 的副作用，而它和本文件开头
///     那句话（"`--state-dir` 是唯一点名根的入口，一次运行解析一个根"）直接矛盾。现在按旗标记
///     出现次数：同一枚取值旗第二次出现 ⇒ 64 + 整块 usage + 两个值都点名；值相同也点名。
///  2. **S4-2 只给修饰旗、不给一次性命令 ⇒ 修饰旗无人读。** 范围检查整支写在
///     `if let oneShotCommand` 里面，所以"不起命令、只起服务"那一趟从来没有资格被检查：
///     `--state-dir X --older-than 7 --dry-run` 起了服务、打了 `listening on`、SIGTERM 后 rc 0、
///     stderr 零字节，而同一枚 `--older-than` 配 `--list-projects` 是 64 + 整块 usage。两条入口
///     两套答案。现在两种形态共用一条链：命令形态问 `allowedModifiers(for:)`，服务形态问
///     `serviceFormModifiers`，被拒时点名"这枚旗标归哪条命令"。
///  3. **S4-3 `--socket-path "$HOME/engine.sock"` 把家目录 chmod 成 0700。**
///     `SocketServer.prepareSocketDirectory()` 拿 `deletingLastPathComponent` 直接
///     `SocketDirectoryRule.enforce`（内部 `chmod(0700)`），而 `notADedicatedRoot` 只用在
///     `--state-dir` 上——`--state-dir ~` 早就被拒，同一危害的 socket 写法没有同一判据。
///     判据搬进 `StateRootArgument`（一处测量、两处措辞），`--socket-path` 与
///     `--probe-socket-path` 两支都调它；`SocketDirectoryRule.enforce` 再加一条**动盘之前**的
///     兜底：家目录与 `/` 永远不 chmod。
///  4. **泳道 2 交接（S2-3 的值没有读者）。** `--evidence-stats` 的载荷是
///     `{count, totalBytes, listFailure, project, dir}`，而"这个档案柜会不会按年龄到期"这件事
///     daemon 从没答过——`maxAgeDays` 在 CLI 上没有入口，模块头那句 "older than N day(s)" 于是
///     成了一条没人设置过的承诺。现在这一面把那条读数发出去，且没设年龄闸时不许出现"多少天后
///     到期"。
///
/// 为什么 CLI 那几条跑**真二进制**：`parseArguments`、`OneShotFlagScope` 与分发段都在可执行
/// 目标的顶层代码里，测试目标既不链接 `glasspaned`，顶层代码在任何可见性下也 import 不动
/// （`StateRootArgument` 存在的理由就是同一件事）。所以判据本体（`ValueFlagLedger`、
/// `rejectionForSocketParent`、`SocketDirectoryRule.ownsItNeverChmodDefect`）都住在被 import
/// 的那一侧、可以直接跑；"分发段真的问了这一个判据"这类接线按本仓先例走源码对照（形状抄
/// `PanelControlAlwaysVisibleTests` 与 `Qoder20261024CliAndPanelTests`）。
///
/// 每条都写明 REVERSE：把那句改回去，这一条就红。
///
/// 全程不碰真 `~/.glasspane`：每一次 CLI 调用都带 `--state-dir <TestSandbox 里的根>`。S4-3 的
/// 家目录那一支只在**纯函数**与源码对照上量——真二进制只跑"父目录是 `/`"那一支（无权限进程
/// chmod `/` 必然 EPERM，动不了任何东西），绝不在真家目录上跑 chmod 验证。

// MARK: - 共用夹具：真二进制的一次性调用与限时起服务

private struct S3Run {
    let status: Int32
    let stdout: String
    let stderr: String
    var combined: String { stdout + stderr }

    /// 整块 usage 走 **stdout**（`printUsage()` 写那里，与 `--help` 同一条通道）。
    var usageWasPrinted: Bool {
        stdout.contains("glasspaned — GlassPane P0 engine daemon")
            && stdout.contains("USAGE:")
            && stdout.contains("EXIT CODES")
    }

    var json: [String: Any]? {
        let trimmed = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object
    }
}

/// 限时起服务的读数：`served` 是"到点还在服务"（被拒的那一支自己就退了），`text` 是
/// 两路合成的全部输出——`listening on` 有没有出现由调用方自己判，S4-2 要的那条正是
/// "这一趟不许说自己在监听"。
private struct S3Serving {
    let served: Bool
    let status: Int32
    let text: String
}

private enum S3Daemon {
    /// `engine/.build/debug/glasspaned`，由本文件位置推出（不吃进程工作目录）。
    static var path: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }   // → engine/
        return url.appendingPathComponent(".build/debug/glasspaned").path
    }

    /// 先读到 EOF 再等退出：反过来的话，输出超过管道缓冲（19 KiB 的 usage 块）的子进程会卡住。
    static func run(_ arguments: [String]) throws -> S3Run {
        try requireBinary(arguments: arguments)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()
        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        process.waitUntilExit()
        return S3Run(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }

    /// 限时起服务：形状抄 `ReviewLifecycleTests.spawnDaemon`——**先把两路合成一根管道**，
    /// 轮询"到点了还活着吗"，再 SIGTERM，最后读到 EOF。不许在子进程还活着时对管道调
    /// `availableData`/`readDataToEndOfFile`：那一句在 macOS 上是**阻塞**的，静默的 daemon
    /// 会让这条夹具永远等下去（本机实测：测试挂在等 stderr 的那一句上，进程 15 分钟不动）。
    /// `served` 说的是"到点还在服务"，`combined` 里有没有 `listening on` 由调用方自己判——
    /// S4-2 要的那条断言正是"这一趟不许说自己在监听"。
    static func serve(_ arguments: [String]) throws -> S3Serving {
        try requireBinary(arguments: arguments)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        // 被拒的那一支在几十毫秒内就自己退了；真的在起服务的那一支到点还活着。
        let grace = Date().addingTimeInterval(2.5)
        while process.isRunning, Date() < grace { usleep(50_000) }
        let served = process.isRunning
        if served {
            process.terminate()
            let stopped = Date().addingTimeInterval(8)
            while process.isRunning, Date() < stopped { usleep(50_000) }
        }
        process.waitUntilExit()
        let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return S3Serving(served: served, status: process.terminationStatus, text: text)
    }

    private static func requireBinary(arguments: [String]) throws {
        guard FileManager.default.isExecutableFile(atPath: path) else {
            throw XCTSkip("没有 \(path)；这两条要的是真 argv 处理与真启动（swift build --package-path engine），"
                + "argv=\(arguments)")
        }
    }
}

/// 源码对照用的两手（本仓既有形状：只数**代码行**，注释里提到一个函数名不算一次调用）。
private enum S3Source {
    static func main() throws -> String { try engineFile("glasspaned/main.swift") }

    static func engineFile(_ name: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/\(name)")
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            throw XCTSkip("读不到 \(url.path)；这一条源码对照在没有该文件的环境里不作数")
        }
        return text
    }

    /// 一个 `case "<flag>":` 块：从那一行起，到下一个 `case "` / `default:` 前止。
    static func caseBlock(for flag: String, in text: String) -> String? {
        let marker = "case \"\(flag)\":"
        guard let start = text.range(of: marker) else { return nil }
        var block = ""
        for line in text[start.upperBound...].split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("case \"") || trimmed.hasPrefix("default:") { break }
            block += String(line) + "\n"
        }
        return block
    }

    /// 从含 `marker` 的那一行起，到第一个含 `stop` 的行前止。
    static func window(of text: String, startsAt marker: String, stopsAt stop: String) -> String? {
        guard let start = text.range(of: marker) else { return nil }
        guard let stopRange = text.range(of: stop, range: start.upperBound..<text.endIndex) else { return nil }
        return String(text[start.lowerBound..<stopRange.lowerBound])
    }

    /// 标记在**非注释行**里的出现次数。
    static func codeOccurrences(_ text: String, _ marker: String) -> Int {
        codeOnly(text).components(separatedBy: marker).count - 1
    }

    static func codeOnly(_ region: String) -> String {
        region.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.hasPrefix("//") && !$0.hasPrefix("/*") && !$0.hasPrefix("*") }
            .joined(separator: "\n")
    }

    /// `static let <declaration>: Set<String> = [ "a", "b", … ]` 里的字面量。
    static func stringSet(in text: String, declaration: String) -> [String] {
        guard let start = text.range(of: declaration),
              let open = text.range(of: "[", range: start.upperBound..<text.endIndex),
              let close = text.range(of: "]", range: open.upperBound..<text.endIndex)
        else { return [] }
        let body = String(text[open.upperBound..<close.lowerBound])
        guard let regex = try? NSRegularExpression(pattern: "\"([^\"]+)\"") else { return [] }
        var out: [String] = []
        regex.enumerateMatches(in: body, range: NSRange(body.startIndex..., in: body)) { match, _, _ in
            guard let match, match.numberOfRanges > 1,
                  let group = Range(match.range(at: 1), in: body) else { return }
            out.append(String(body[group]))
        }
        return out
    }

    /// `parseArguments` 里**真的吃一个值**的 case 标签：块里出现这三枚取值入口之一就算。
    /// `--state-dir` 走 `StateRootArgument(raw:)`，两面路径旗走 `rejection(for:)`，其余六面走
    /// `ArgumentValue.follow`——这张表是解析器自己的形状，不是测试里写死的名单。
    static func valueTakingFlags(in text: String) -> [String] {
        let markers = [
            "ArgumentValue.follow(", "StateRootArgument.rejection(for:", "StateRootArgument(raw:",
        ]
        var flags: Set<String> = []
        var current: String?
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("//") { continue }
            if line.hasPrefix("case \"") {
                current = String(line.dropFirst(6).prefix { $0 != "\"" })
                continue
            }
            if markers.contains(where: { line.contains($0) }), let current {
                flags.insert(current)
            }
        }
        return flags.sorted()
    }
}

// MARK: - S4-1：一枚旗标一次运行只许给一个值

final class DailyRound20261029Swift3ValueFlagTests: XCTestCase {

    /// 表本身：只列**吃值**的旗标，且每一枚都必须是解析器真的读值的 case。数目不写死——
    /// 两边都从代码里数出来（`valueTakingFlags` 读 main.swift 的解析器形状，`onePerRun` 读被
    /// import 的那一张表）。
    /// REVERSE：把某枚旗标从 `onePerRun` 里删掉 → 集合相等那条红；只加表不接线 → 计数那条红；
    /// 解析器新增一枚吃值旗而表不跟着长 → 集合相等那条红。
    func testTheOnePerRunTableIsTheTableTheParserReads() throws {
        let text = try S3Source.main()
        let parsed = S3Source.valueTakingFlags(in: text)
        XCTAssertGreaterThanOrEqual(parsed.count, 6,
            "只抠出 \(parsed.count) 枚吃值旗：抽取式已经在看不到东西的地方，下面的对照不作数")
        XCTAssertEqual(
            Set(parsed), Set(ValueFlagLedger.onePerRun.keys),
            "解析器吃值的旗标与「一次运行只许给一个值」的表不是同一批——被漏掉的那一枚仍旧后者胜"
        )

        // 接线：每一枚都得有一个问账本的位置，且被问的总次数 == 表的长度（少问一处就是那一枚
        // 退回静默后者胜，多问一处就是有一枚被问了两遍）。
        for flag in ValueFlagLedger.onePerRun.keys.sorted() {
            XCTAssertEqual(
                S3Source.codeOccurrences(text, "valueFlags.note(flag: \"\(flag)\""), 1,
                "\(flag) 的取值点没把这一枚交给账本（或交了两次）——它还能静默后者胜"
            )
        }
        XCTAssertEqual(
            S3Source.codeOccurrences(text, "valueFlags.note(flag:"),
            ValueFlagLedger.onePerRun.count,
            "问账本的位置数与表的长度不一致：有一枚旗标漏接，或有一处重复"
        )
    }

    /// 判据本体，覆盖表里每一枚（名单从表里数）：第二次出现 ⇒ 拒绝，两个值都点名，说的就是
    /// "一次运行只解析一个"这件事，且给得出下一步。
    /// REVERSE：`note` 改成无条件覆盖并回 nil → 每一枚都红（一条也没拒）。
    func testLedgerRefusesTheSecondValueOfEveryFlagAndNamesBoth() throws {
        for flag in ValueFlagLedger.onePerRun.keys.sorted() {
            let noun = try XCTUnwrap(ValueFlagLedger.onePerRun[flag], "\(flag) 在表里却没说清它定的是哪一样东西")
            var ledger = ValueFlagLedger()
            XCTAssertNil(ledger.note(flag: flag, value: "first-of-\(flag)"),
                         "\(flag) 第一次出现就被拒了：这一枚从此没法用了")
            guard let refusal = ledger.note(flag: flag, value: "second-of-\(flag)") else {
                XCTFail("\(flag) 给了两次还放行——后者胜那条老路回来了")
                continue
            }
            XCTAssertTrue(refusal.contains("\(flag) given twice"), refusal)
            XCTAssertTrue(refusal.contains("first-of-\(flag)"),
                          "两个值都要点名，少了这一个调用方就看不出丢的是哪一个：\(refusal)")
            XCTAssertTrue(refusal.contains("second-of-\(flag)"), refusal)
            XCTAssertTrue(refusal.contains("one run resolves exactly one \(noun)"), refusal)
            XCTAssertTrue(refusal.contains("Next step"), "拒绝必须给下一步：\(refusal)")
            XCTAssertFalse(refusal.contains("§"), "给人看的文案里不许夹内部条款号：\(refusal)")
        }
    }

    /// 值相同也要点名：不许静默"就当我没看见"。
    /// REVERSE：`note` 在 `prior == value` 时回 nil → 这一条红（同一句被当成没发生过）。
    func testLedgerNamesARepeatedFlagEvenWhenBothValuesAgree() {
        var ledger = ValueFlagLedger()
        XCTAssertNil(ledger.note(flag: "--state-dir", value: "/srv/glasspane-root"))
        guard let refusal = ledger.note(flag: "--state-dir", value: "/srv/glasspane-root") else {
            return XCTFail("同一枚旗标同值两次被放行了——「值相同也要点名」那一格空着")
        }
        XCTAssertTrue(refusal.contains("--state-dir given twice"), refusal)
        XCTAssertTrue(refusal.contains("/srv/glasspane-root"), refusal)
        XCTAssertTrue(refusal.contains("Next step"), refusal)
    }

    /// 拒的就是"不能替调用方挑一个"：账本里留的必须是**第一个**值。
    /// REVERSE：让 `note` 在拒绝前先把 `seen[flag] = value` 写掉 → 第一条红。
    func testLedgerKeepsTheFirstValueWhenItRefuses() {
        var ledger = ValueFlagLedger()
        _ = ledger.note(flag: "--project-remove", value: "idAAA")
        _ = ledger.note(flag: "--project-remove", value: "idBBB")
        XCTAssertEqual(ledger.seen["--project-remove"], "idAAA",
                       "拒了一次「哪个 id」却把账本改成第二个：这一趟仍然在后继者胜")
        XCTAssertEqual(ledger.seen.count, 1, "账本里不该有第二份状态")
    }

    /// 表外那几位不吃值的旗标不归本账管（`--dry-run` 给两次说的是同一件事，没有值被丢掉）。
    /// REVERSE：把 `note` 改成对所有旗标一律记账并拒 → 这一条红。
    func testLedgerLeavesFlagsWithoutAValueAlone() {
        var ledger = ValueFlagLedger()
        XCTAssertNil(ledger.note(flag: "--dry-run", value: ""))
        XCTAssertNil(ledger.note(flag: "--dry-run", value: ""))
        XCTAssertTrue(ledger.seen.isEmpty, "不吃值的旗标被记进账本了：那张表说的是什么就是什么")
    }

    /// 头条形状，端到端：`--state-dir A --state-dir B --list-projects`。修前实测 rc 0、stdout
    /// `[]`、stderr 零字节（A 被丢）。修后 64 + 整块 usage + 两个根都点名，且一条命令都没跑。
    /// REVERSE：删掉 `--state-dir` 那一支的 `valueFlags.note` → rc 回到 0，第一句就红。
    func testRealBinaryRefusesStateDirGivenTwiceWithBothRootsAndUsage() throws {
        let root = TestSandbox.directory("dup-root")
        let first = root + "/named-first"
        let second = root + "/named-second"
        let result = try S3Daemon.run([
            "--state-dir", first, "--state-dir", second, "--list-projects",
        ])
        XCTAssertEqual(result.status, 64, "同一枚取值旗给两次是一次用法错：\(result.stderr.prefix(400))")
        XCTAssertTrue(result.stderr.contains("--state-dir given twice"), String(result.stderr.prefix(400)))
        XCTAssertTrue(result.stderr.contains(first),
                      "第一个根必须被点名，它以前是被丢的那一个：\(result.stderr.prefix(400))")
        XCTAssertTrue(result.stderr.contains(second), String(result.stderr.prefix(400)))
        XCTAssertTrue(result.stderr.contains("one run resolves exactly one root"),
                      String(result.stderr.prefix(400)))
        XCTAssertTrue(result.usageWasPrinted, "用法错要带整块 usage（`--help` 的 64 段承诺的就是这个形状）")
        XCTAssertFalse(result.stdout.contains("[]"), "拒了却还把 --list-projects 跑了出去")
        XCTAssertFalse(result.combined.contains("listening on"), "这一趟不许起服务")
    }

    /// 台账给的第二个形状：`--project-remove idA --project-remove idB`。修前实测 rc 3、只处理
    /// idB、idA 一个字没提。修后 64，两个 id 都点名。
    /// REVERSE：删掉 `--project-remove` 那一支的 `valueFlags.note` → rc 回到 3、idAAA 消失，红。
    func testRealBinaryRefusesProjectRemoveGivenTwiceAndNamesBothIds() throws {
        let root = TestSandbox.directory("dup-remove")
        let result = try S3Daemon.run([
            "--state-dir", root, "--project-remove", "idAAA-gone", "--project-remove", "idBBB-gone",
        ])
        XCTAssertEqual(result.status, 64, "删注册项的 id 不许由赋值顺序决定：\(result.stderr.prefix(400))")
        XCTAssertTrue(result.stderr.contains("--project-remove given twice"), String(result.stderr.prefix(400)))
        XCTAssertTrue(result.stderr.contains("idAAA-gone"),
                      "第一个 id 以前一个字都没被提到：\(result.stderr.prefix(400))")
        XCTAssertTrue(result.stderr.contains("idBBB-gone"), String(result.stderr.prefix(400)))
        XCTAssertTrue(result.usageWasPrinted)
        XCTAssertFalse(result.stderr.contains("\"registryPath\""),
                       "拒了却还是跑了一次删除：\(result.stderr.prefix(400))")
    }

    /// 同值两次也要点名（不许"就当我没看见"）。
    /// REVERSE：把 `prior == value` 折回放行 → rc 回到 0，红。
    func testRealBinaryNamesStateDirGivenTwiceWithTheSameValue() throws {
        let root = TestSandbox.directory("dup-same")
        let result = try S3Daemon.run([
            "--state-dir", root, "--state-dir", root, "--list-projects",
        ])
        XCTAssertEqual(result.status, 64, String(result.stderr.prefix(400)))
        XCTAssertTrue(result.stderr.contains("--state-dir given twice"), String(result.stderr.prefix(400)))
        XCTAssertTrue(result.stderr.contains(root), String(result.stderr.prefix(400)))
        XCTAssertTrue(result.usageWasPrinted)
    }

    /// 整族覆盖：表里每一枚在真二进制上都撞一次这条闸（名单从表里数，不写死）。
    /// REVERSE：删掉任何一枚的 `valueFlags.note` → 那一枚那一圈红。
    func testRealBinaryRefusesEveryValueFlagGivenTwice() throws {
        let root = TestSandbox.directory("dup-family")
        let flags = ValueFlagLedger.onePerRun.keys.sorted()
        XCTAssertFalse(flags.isEmpty, "表是空的：这一条对照看不见任何东西")
        for flag in flags {
            let (first, second) = try samplePair(flag, under: root)
            let result = try S3Daemon.run([flag, first, flag, second, "--list-projects"])
            XCTAssertEqual(result.status, 64, "\(flag) 给两次还放行：\(result.stderr.prefix(300))")
            XCTAssertTrue(result.stderr.contains("given twice"), "\(flag): \(result.stderr.prefix(300))")
            XCTAssertTrue(result.stderr.contains(first), "\(flag) 的第一个值没被点名：\(result.stderr.prefix(300))")
            XCTAssertTrue(result.stderr.contains(second), "\(flag) 的第二个值没被点名：\(result.stderr.prefix(300))")
            XCTAssertTrue(result.usageWasPrinted, "\(flag) 的用法错少了整块 usage")
        }
    }

    /// 对照臂：只给一次必须照旧可用——这条不许被"一律拒"冒充。
    /// REVERSE：把记账时机写错（见过一次就拒）→ 这两支红。
    func testRealBinaryStillAcceptsEachValueFlagGivenOnce() throws {
        let root = TestSandbox.directory("single-ok")
        let listed = try S3Daemon.run(["--state-dir", root, "--list-projects"])
        XCTAssertEqual(listed.status, 0, "\(listed.stderr.prefix(300))")
        XCTAssertEqual(listed.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "[]")
        XCTAssertFalse(listed.stderr.contains("given twice"))

        let pruned = try S3Daemon.run([
            "--state-dir", root, "--prune-evidence", "--older-than", "7", "--dry-run",
        ])
        XCTAssertEqual(pruned.status, 0, "\(pruned.stderr.prefix(300))")
        let payload = try XCTUnwrap(pruned.json, "--prune-evidence 该交出答复：\(pruned.stderr.prefix(300))")
        XCTAssertEqual(payload["dryRun"] as? Bool, true)
        XCTAssertEqual(payload["pruned"] as? Int, 0)
        XCTAssertFalse(pruned.stderr.contains("given twice"))

        // 两面路径旗各给一次、父目录就是这一趟自己的临时根：解析期不许拦。
        let pathFlags = try S3Daemon.run([
            "--state-dir", root, "--socket-path", root + "/engine.sock", "--list-projects",
        ])
        XCTAssertFalse(pathFlags.stderr.contains("given twice"), String(pathFlags.stderr.prefix(300)))
        XCTAssertFalse(pathFlags.stderr.contains("would put the socket"),
                       "一枚合法的 socket 名字被父目录判据拒了：\(String(pathFlags.stderr.prefix(300)))")
    }

    /// 表里每一枚的样例值。认不出的那一枚必须红，不许悄悄绕过这一族覆盖。
    private func samplePair(_ flag: String, under root: String) throws -> (String, String) {
        switch flag {
        case "--state-dir": return (root + "/root-first", root + "/root-second")
        case "--socket-path": return (root + "/engine-a.sock", root + "/engine-b.sock")
        case "--probe-socket-path": return (root + "/probe-a.sock", root + "/probe-b.sock")
        case "--older-than": return ("7", "9")
        case "--request-permission": return ("accessibility", "input-monitoring")
        case "--recipe-validate": return (root + "/recipe-a.json", root + "/recipe-b.json")
        case "--project", "--project-remove", "--active-project": return ("projAAA", "projBBB")
        default:
            XCTFail("表里出现了一枚夹具不认得的旗标 \(flag)：给它一对值，别让它绕过这一族覆盖")
            return ("a", "b")
        }
    }
}

// MARK: - S4-2：只给修饰旗、不给一次性命令

final class DailyRound20261029Swift3FlagScopeTests: XCTestCase {

    /// 头条形状，端到端：`--state-dir X --older-than 7`。修前实测起了服务、打了 `listening on`、
    /// SIGTERM 后 rc 0、stderr 零字节；修后 64 + 整块 usage，点名这枚旗标与**归哪条命令**，
    /// 而且一个字都不说自己在监听。
    /// REVERSE：把范围检查挪回 `if let oneShotCommand` 里面 → 这一条回到 rc 0 + listening on，红。
    func testServiceFormRefusesADayCountNoCommandWillRead() throws {
        let root = TestSandbox.directory("scope-service")
        let result = try S3Daemon.serve(["--state-dir", root, "--older-than", "7"])
        XCTAssertFalse(result.served,
                       "这一趟读了 --older-than 却没有读者，还活成了一个服务：\(result.text.prefix(400))")
        XCTAssertEqual(result.status, 64, "只给修饰旗不给命令也是用法错：\(result.text.prefix(400))")
        XCTAssertTrue(result.text.contains("--older-than"), "要点名被拒的那一枚：\(result.text.prefix(400))")
        XCTAssertTrue(result.text.contains("--prune-evidence"),
                      "还得说出这枚旗标归哪条命令，否则调用方不知道往哪儿补：\(result.text.prefix(400))")
        XCTAssertTrue(result.text.contains("Next step"), "拒绝要给下一步：\(result.text.prefix(400))")
        // 只量那一行报文：整块 usage 里本来就有 `§3` 之类的协议出处，把它当缺陷会在下一轮
        // 被"删掉说明换绿"绕过。
        let refusalLine = result.text.split(separator: "\n").first { $0.contains("not read by") } ?? ""
        XCTAssertFalse(refusalLine.contains("§"), "给人看的拒绝文案里不许夹内部条款号：\(refusalLine)")
        XCTAssertTrue(
            result.text.contains("glasspaned — GlassPane P0 engine daemon") && result.text.contains("USAGE:"),
            "整块 usage 要打出去（`--help` 的 64 段承诺的就是这个形状）"
        )
        XCTAssertFalse(result.text.contains("listening on"),
                       "被拒的那一趟不许留下任何一句它在监听：\(result.text.prefix(400))")
    }

    /// 同一形态的另外两枚（`--dry-run` 与 `--project`）同一口径；`--dry-run` 那一支就是台账里
    /// 实测过的那一串（`--older-than 7 --dry-run`），两枚都得点名。
    /// REVERSE：从 `modifiers` 里摘掉 `--dry-run` → 第一支红（那枚旗标又被静默吃掉）。
    func testServiceFormRefusesDryRunAndProjectAndNamesBoth() throws {
        let root = TestSandbox.directory("scope-service2")

        let dryRun = try S3Daemon.serve(["--state-dir", root, "--older-than", "7", "--dry-run"])
        XCTAssertEqual(dryRun.status, 64, String(dryRun.text.prefix(400)))
        XCTAssertTrue(dryRun.text.contains("--dry-run"), String(dryRun.text.prefix(400)))
        XCTAssertTrue(dryRun.text.contains("--older-than"), String(dryRun.text.prefix(400)))
        XCTAssertTrue(dryRun.text.contains("--project-prune"),
                      "--dry-run 的去处要说得出：\(String(dryRun.text.prefix(400)))")
        XCTAssertFalse(dryRun.served)

        let project = try S3Daemon.serve(["--state-dir", root, "--project", "ppp"])
        XCTAssertEqual(project.status, 64, String(project.text.prefix(400)))
        XCTAssertTrue(project.text.contains("--project"), String(project.text.prefix(400)))
        XCTAssertTrue(project.text.contains("--prune-evidence"), String(project.text.prefix(400)))
        XCTAssertFalse(project.served)
    }

    /// ★ 负例（不许把真服务形态判红）：单独 `--state-dir X` 照旧起服务；服务形态白名单那几枚
    /// 一起给也照旧起服务。两条都得真的听到 `listening on`——只断"没退 64"不够，那正是上一轮
    /// 的形状。
    /// REVERSE：把 `--socket-path`/`--no-probe` 从 `serviceFormModifiers` 里删掉 → 第二支红
    /// （一次合法的服务启动被拒）。
    func testRealServingFormStillServes() throws {
        let bareRoot = TestSandbox.directory("serve-bare")
        let bare = try S3Daemon.serve(["--state-dir", bareRoot, "--no-probe"])
        XCTAssertTrue(bare.served, "单独点名状态根就是起服务，它必须真的起来：\(bare.text.prefix(400))")
        XCTAssertTrue(bare.text.contains("listening on"), "它得把自己说成在服务：\(bare.text.prefix(400))")
        XCTAssertEqual(bare.status, 0, "SIGTERM 之后收尾正常：\(bare.text.prefix(400))")
        XCTAssertFalse(bare.text.contains("not read by"), String(bare.text.prefix(400)))

        let wiredRoot = TestSandbox.directory("serve-wired")
        let wired = try S3Daemon.serve([
            "--state-dir", wiredRoot,
            "--socket-path", wiredRoot + "/engine.sock",
            "--probe-socket-path", wiredRoot + "/probe.sock",
            "--no-probe", "--no-c33", "--unattended-window",
        ])
        XCTAssertTrue(wired.served, "白名单里的服务形态旗标被拒了：\(wired.text.prefix(400))")
        XCTAssertTrue(wired.text.contains("listening on"), "它得把自己说成在服务：\(wired.text.prefix(400))")
        XCTAssertFalse(wired.text.contains("not read by"), String(wired.text.prefix(400)))
    }

    /// 结构那一半：范围检查不再住在 `if let oneShotCommand` 里面，且服务形态的白名单与
    /// `modifiers` 全集自洽（差集恰好是那三枚只有命令才读的）。
    /// REVERSE：把 `refused(options:allowed:)` 挪回一次性分支里 → 顺序那条红；往
    /// `serviceFormModifiers` 里加一枚不在 `modifiers` 的旗标 → orphan 那条红。
    func testTheScopeCheckIsOutsideTheOneShotBranch() throws {
        let text = try S3Source.main()
        let scope = try XCTUnwrap(
            S3Source.window(of: text, startsAt: "enum OneShotFlagScope", stopsAt: "private func printUsage()"),
            "找不到 OneShotFlagScope：这一轮新增的那张白名单不见了"
        )
        let service = Set(S3Source.stringSet(in: scope, declaration: "static let serviceFormModifiers"))
        let all = Set(S3Source.stringSet(in: scope, declaration: "static let modifiers"))
        XCTAssertFalse(service.isEmpty, "服务形态的白名单是空的：抽取式已经看不见东西")
        for flag in ["--socket-path", "--probe-socket-path", "--force-socket", "--force-probe-socket",
                     "--no-probe", "--no-c33", "--unattended-window"] {
            XCTAssertTrue(service.contains(flag), "\(flag) 是这一趟真的读的，它必须在白名单里")
        }
        let orphan = service.subtracting(all)
        XCTAssertTrue(orphan.isEmpty, "白名单里有不在 modifiers 全集的旗标，那条豁免永远不起作用：\(orphan)")
        XCTAssertEqual(
            all.subtracting(service), Set(["--dry-run", "--older-than", "--project"]),
            "服务形态不读的那三枚变了：这张差集说的是「谁归哪条命令」，得跟着分发段一起改"
        )

        // 检查点必须在**任何分发之前**，且不再嵌在"这一趟命名了命令"的那一支里面：上一轮的
        // 形状是 `if let oneShotCommand = requestedCommandNames.first { … }` 一整支包住检查。
        let code = S3Source.codeOnly(text)
        let scopeCall = try XCTUnwrap(
            code.range(of: "let refused = OneShotFlagScope.refused(options: options, allowed: allowedForThisRun)"),
            "范围检查不再走 allowedForThisRun：两种形态又各有各的读者表了"
        )
        let firstDispatch = try XCTUnwrap(
            // 分发段的第一条出口（`--version` 那一支的 print）。认 `if options.printVersion {`
            // 不行——`requestedCommands` 里也有一枚同样的判断，而它在检查点之前。
            code.range(of: "print(\"glasspaned \\(EngineCore.buildVersion)\")"),
            "找不到分发的第一条出口：顺序对照没有对照物了"
        )
        XCTAssertTrue(scopeCall.lowerBound < firstDispatch.lowerBound,
                      "范围检查跑在分发之后：那一趟已经先把一条命令跑出去了")
        XCTAssertEqual(
            S3Source.codeOccurrences(text, "if let oneShotCommand = requestedCommandNames.first {"), 0,
            "范围检查又整支缩回一次性分支里面：只起服务那一趟不受检查"
        )
        XCTAssertEqual(
            S3Source.codeOccurrences(text, "allowedForThisRun = OneShotFlagScope.allowedModifiers(for:"), 1,
            "命令形态的读者表被问了两遍或没被问"
        )
        XCTAssertEqual(
            S3Source.codeOccurrences(text, "allowedForThisRun = OneShotFlagScope.serviceFormModifiers"), 1,
            "服务形态的读者表被问了两遍或没被问"
        )
        XCTAssertEqual(
            S3Source.codeOccurrences(text, "OneShotFlagScope.refused(options: options, allowed:"), 1,
            "范围检查被问了两遍：两支会互相覆盖"
        )
    }

    /// 一次性形态那句话一个字都不许在搬家时丢掉（既有测试钉着它，这里再钉一次同一形状）。
    /// REVERSE：把两支文案折成一句共用 → "mixes a one-shot subcommand" 消失，红。
    func testTheOneShotWordingSurvivedTheLift() throws {
        let root = TestSandbox.directory("scope-wording")
        let result = try S3Daemon.run(["--state-dir", root, "--list-projects", "--older-than", "7"])
        XCTAssertEqual(result.status, 64, String(result.stderr.prefix(300)))
        XCTAssertTrue(result.stderr.contains("is not read by --list-projects"), String(result.stderr.prefix(400)))
        XCTAssertTrue(result.stderr.contains("mixes a one-shot subcommand"), String(result.stderr.prefix(400)))
        XCTAssertTrue(result.stderr.contains("no modifier flags at all"), String(result.stderr.prefix(400)))
        XCTAssertTrue(result.stderr.contains("serves the socket"), String(result.stderr.prefix(400)))
        XCTAssertTrue(result.usageWasPrinted)
    }
}

// MARK: - S4-3：socket 的父目录要有 `--state-dir` 那一条判据

final class DailyRound20261029Swift3SocketParentTests: XCTestCase {

    /// 三条必备读数：家目录里的 socket 拒、`/` 下的 socket 拒、默认布局（引擎自己那个目录里的
    /// `engine.sock`）**放行**——把默认布局判红的那道闸活不过下一次启动。
    /// REVERSE：`rejectionForSocketParent` 退回不量父目录（直接回 nil）→ 前两条红；让它量整条
    /// 路径而不是父目录 → 默认布局那条红。
    func testSocketParentRefusesHomeAndRootButNotTheDefaultLayout() throws {
        let home = try homeDirectory()

        // ① 家目录本身当 socket 父目录：拒，并给下一步。
        let homeRefusal = try XCTUnwrap(
            StateRootArgument.rejectionForSocketParent(of: home + "/engine.sock"),
            "socket 落在家目录里没有被判据拒——这一支以前会把家目录 chmod 成 0700"
        )
        XCTAssertTrue(homeRefusal.contains("home directory"), homeRefusal)
        XCTAssertTrue(homeRefusal.contains("0700"), "要说清危害是什么：\(homeRefusal)")
        XCTAssertTrue(homeRefusal.contains("--socket-path"), "要给下一步：\(homeRefusal)")
        XCTAssertFalse(homeRefusal.contains("§"), "给人看的文案里不许夹内部条款号：\(homeRefusal)")

        // ② 文件系统根：拒。
        let rootRefusal = try XCTUnwrap(
            StateRootArgument.rejectionForSocketParent(of: "/engine.sock"),
            "socket 直接放 / 里没被拒——那是对着 / 做 chmod"
        )
        XCTAssertTrue(rootRefusal.contains("directly in `/`"), rootRefusal)
        XCTAssertTrue(rootRefusal.contains("0700"), "要说清危害是什么：\(rootRefusal)")
        XCTAssertTrue(rootRefusal.contains("--socket-path"), "要给下一步：\(rootRefusal)")

        // ③ 默认布局：放行。这一面不许把今天装好的安装判红。
        let defaultSocket = StateRoot.engineSocketPath(explicitSocketPath: nil, stateRoot: nil)
        XCTAssertEqual((defaultSocket as NSString).deletingLastPathComponent, StateRoot.homeDefault().path,
                       "前提：默认 socket 就在引擎自己的目录里")
        XCTAssertNil(StateRootArgument.rejectionForSocketParent(of: defaultSocket),
                     "默认 socket 被误拒：\(StateRootArgument.rejectionForSocketParent(of: defaultSocket) ?? "")")

        // ④ 命名的根、临时根里的名字：照旧收。
        let root = TestSandbox.directory("socket-parent")
        XCTAssertNil(StateRootArgument.rejectionForSocketParent(of: root + "/daemon.sock"))
        let named = StateRoot(path: root)
        XCTAssertNil(StateRootArgument.rejectionForSocketParent(of: named.daemonSocketFile))
        XCTAssertNil(StateRootArgument.rejectionForSocketParent(of: named.probeSocketFile))
    }

    /// 尾斜杠与"名字本身"两种拼写都要走到同一个比较上，判据不许只认一种。
    /// REVERSE：去掉折算尾斜杠那一段 → 带尾斜杠那一支红。
    func testSocketParentFoldsTrailingSlashSpellings() throws {
        let home = try homeDirectory()
        XCTAssertNotNil(StateRootArgument.rejectionForSocketParent(of: home + "/engine.sock"))
        XCTAssertNotNil(StateRootArgument.rejectionForSocketParent(of: home + "//engine.sock"))
        XCTAssertNotNil(StateRootArgument.rejectionForSocketParent(of: home + "/engine.sock/"))
        // 家目录**里面**一个专用子目录不是家目录本身：这一支不许拒（拒它就把每一处
        // 自定义安装位置都判红了）。
        XCTAssertNil(StateRootArgument.rejectionForSocketParent(of: home + "/somewhere-else/engine.sock"))
    }

    /// 同一危害同一判据：对任意一个候选父目录，socket 那一条与 `--state-dir` 那一条必须给同一个
    /// "这个目录能不能被收紧"的答案——两处各写一份判据就是本轮那条缺陷本身。
    /// REVERSE：让 socket 那一条只认 `/` 不认家目录 → 这一条红。
    func testSocketParentAndStateDirRulesAgreeOnTheSameDirectory() throws {
        let home = try homeDirectory()
        let root = TestSandbox.directory("socket-agree")
        for directory in [home, home + "/", "/", root, StateRoot.homeDefault().path] {
            let asRoot = StateRootArgument.notADedicatedRoot(directory) != nil
            let socketName = (directory.hasSuffix("/") ? directory : directory + "/") + "engine.sock"
            let asSocketParent = StateRootArgument.rejectionForSocketParent(of: socketName) != nil
            XCTAssertEqual(asRoot, asSocketParent,
                           "同一个目录在 --state-dir 上是「不能收紧」，在 socket 父目录上却是\(asSocketParent ? "放行" : "拒绝")：\(directory)")
        }
    }

    /// 兜底那一半：家目录与 `/` 在 `SocketDirectoryRule` 里也**绝不 chmod**——CLI 那两道闸只看得
    /// 见命令行给的值，默认名、面板注入的路径和下一个调用方都从这一条出去。这里只量纯函数与一个
    /// 真临时目录，绝不在真家目录上跑 chmod。
    /// REVERSE：`enforce` 不再先问这条 → 顺序对照红；把兜底改成"chmod 完再拒" → 顺序对照红；
    /// 把兜底写成一律拒 → 临时目录那条红。
    func testEnforceRefusesHomeAndFilesystemRootWithoutChmod() throws {
        let home = try homeDirectory()
        XCTAssertNotNil(SocketDirectoryRule.ownsItNeverChmodDefect(home), "兜底认不出家目录")
        XCTAssertNotNil(SocketDirectoryRule.ownsItNeverChmodDefect(home + "/"))
        XCTAssertNotNil(SocketDirectoryRule.ownsItNeverChmodDefect("/"))
        XCTAssertNil(SocketDirectoryRule.ownsItNeverChmodDefect(StateRoot.homeDefault().path),
                     "默认布局（家目录里引擎自己的那个目录）不能被兜底误拒")
        let root = TestSandbox.directory("enforce-ok")
        XCTAssertNil(SocketDirectoryRule.ownsItNeverChmodDefect(root))

        // 拒绝文案要说得出"什么都没 chmod"并给下一步，且这一步不碰磁盘。
        let defect = try XCTUnwrap(SocketDirectoryRule.ownsItNeverChmodDefect(home))
        XCTAssertTrue(defect.contains("Nothing was chmod-ed"), defect)
        XCTAssertTrue(defect.contains("0700"), "要说清危害：\(defect)")
        XCTAssertTrue(defect.contains("--socket-path"), "要给下一步：\(defect)")

        // 普通临时目录仍然过 enforce（兜底不许把常规路径判红）。
        XCTAssertNil(SocketDirectoryRule.enforce(directory: root),
                     "一次对专用临时目录的 enforce 被新兜底拒了：\(SocketDirectoryRule.enforce(directory: root) ?? "")")

        // 接线 + 顺序：兜底必须在 createDirectory/chmod 之前问。
        let text = try S3Source.engineFile("GlassPaneEngine/SocketDirectoryRule.swift")
        let code = S3Source.codeOnly(text)
        let guard_ = try XCTUnwrap(
            code.range(of: "ownsItNeverChmodDefect(directory)"),
            "enforce 不再问这条兜底：CLI 之外的调用方又能 chmod 了"
        )
        let firstChmod = try XCTUnwrap(code.range(of: "chmod(directory, 0o700)"),
                                       "找不到那次 chmod：顺序对照没有对照物了")
        XCTAssertTrue(guard_.lowerBound < firstChmod.lowerBound,
                      "兜底跑在 chmod 之后：家目录已经被改完才说不能改")
        let firstCreate = try XCTUnwrap(code.range(of: "createDirectory("),
                                        "找不到 createDirectory：顺序对照没有对照物了")
        XCTAssertTrue(guard_.lowerBound < firstCreate.lowerBound,
                      "兜底跑在 createDirectory 之后：属性没生效，名字却是它建的")
    }

    /// 两支都要调：`--socket-path` 与 `--probe-socket-path` 各问一次同一个判据，而且没把绝对路径
    /// 那一条判据换掉（本仓先例："判据必须住在被 import 的纯函数里"，接线由这条闸数出来）。
    /// REVERSE：删掉探针那一支的调用 → 计数与那一支的红；把两支折成只查 engine → 计数红。
    func testBothSocketFlagsConsultTheOneParentRule() throws {
        let text = try S3Source.main()
        XCTAssertEqual(S3Source.codeOccurrences(text, "StateRootArgument.rejectionForSocketParent(of:"), 2,
                       "socket 父目录的判据只被调了一次或不止两次：两面旗标得各自问过同一份账")
        for flag in ["--socket-path", "--probe-socket-path"] {
            let block = try XCTUnwrap(
                S3Source.caseBlock(for: flag, in: text), "解析表里找不到 \(flag) 的 case 块"
            )
            XCTAssertTrue(block.contains("rejectionForSocketParent"),
                          "\(flag) 没问父目录判据：那一支还能把 socket 放进家目录")
            XCTAssertTrue(block.contains("StateRootArgument.rejection(for:"),
                          "\(flag) 丢了绝对路径那一条判据：两支不能同源了")
        }
        // 判据本体只住一处：`--state-dir` 与 socket 父目录共用同一个测量，两处只写各自的措辞。
        let engine = try S3Source.engineFile("GlassPaneEngine/StateRoot.swift")
        XCTAssertEqual(S3Source.codeOccurrences(engine, "dedicatedness(raw)"), 1,
                       "「这是不是家目录/根」被量了两遍：两处判据会各漂各的")
        XCTAssertEqual(S3Source.codeOccurrences(engine, "dedicatedness(directory)"), 1,
                       "socket 那一条不再走同一份测量：它就成了第三份判据")
        XCTAssertEqual(S3Source.codeOccurrences(engine, "private static func dedicatedness("), 1,
                       "测量本体不止一处定义")
    }

    /// 端到端：真二进制把 socket 指向 `/` 下面一个名字。修后必须在解析期就拒，`/` 的模式一个
    /// 字节不变、那个名字不存在。（家目录那一支不在这里跑：见文件头——无权限进程 chmod `/` 必然
    /// EPERM，所以这一支安全；chmod 家目录会真的改成功。）
    /// REVERSE：删掉 `--socket-path` 那一支的判据 → 这一条红（走到 chmod/绑定那一侧）。
    func testRealBinaryRefusesASocketUnderTheFilesystemRootWithoutTouchingAnything() throws {
        let candidate = "/lane4-swift3-never-created.sock"
        XCTAssertFalse(FileManager.default.fileExists(atPath: candidate), "夹具前提：那个名字本来不存在")
        let modeBefore = try posixMode(of: "/")
        let root = TestSandbox.directory("root-socket")
        let result = try S3Daemon.serve([
            "--state-dir", root, "--socket-path", candidate, "--no-probe",
        ])
        XCTAssertEqual(result.status, 64, "socket 的父目录是 / 时必须是用法错：\(result.text.prefix(400))")
        XCTAssertFalse(result.served, "被拒的这一趟不许活成一个服务：\(result.text.prefix(400))")
        XCTAssertTrue(result.text.contains("--socket-path"), String(result.text.prefix(400)))
        XCTAssertTrue(result.text.contains("directly in `/`"), String(result.text.prefix(400)))
        XCTAssertTrue(result.text.contains("USAGE:"))
        XCTAssertFalse(result.text.contains("listening on"), "被拒的那一趟不许说自己在监听")
        XCTAssertFalse(FileManager.default.fileExists(atPath: candidate), "拒了却把那个名字建出来了")
        XCTAssertEqual(try posixMode(of: "/"), modeBefore, "/ 的模式被动过：这一趟 chmod 了它不该动的目录")
    }

    // MARK: helpers

    /// 家目录的位置：从引擎默认根的**父目录**读出来，不在测试里手拼一个家目录路径。
    /// 只用于比较与拼一个只读候选名——S4-3 的判据量的是字符串，真家目录的 chmod 验证本泳道不做。
    private func homeDirectory() throws -> String {
        let parent = (StateRoot.homeDefault().path as NSString).deletingLastPathComponent
        XCTAssertFalse(parent.isEmpty, "前提：引擎默认根的父目录就是家目录本身")
        return parent
    }

    private func posixMode(of path: String) throws -> Int {
        var info = stat()
        guard lstat(path, &info) == 0 else {
            throw XCTSkip("lstat \(path) 失败；这一条的读数在没有该目录的环境里不作数")
        }
        return Int(info.st_mode & 0o777)
    }
}

// MARK: - 泳道 2 交接：`--evidence-stats` 的年龄闸读数有读者了

final class DailyRound20261029Swift3AgeRetentionTests: XCTestCase {

    /// 载荷里有那条读数，而且没设年龄闸时**不许**出现"多少天后到期"的承诺。`--older-than` 是
    /// `--prune-evidence` 的一次性参数、不是留存配置，所以 CLI 这一面永远走"没有闸"那一支。
    /// REVERSE：把载荷里那一键删掉 → 第一条红（值备好了却没人发）。
    func testEvidenceStatsPublishesTheAgeRetentionReading() throws {
        let root = TestSandbox.directory("stats-age")
        let result = try S3Daemon.run(["--state-dir", root, "--evidence-stats"])
        XCTAssertEqual(result.status, 0, "\(result.stderr.prefix(300))")
        let payload = try XCTUnwrap(result.json, "这一条该交出 JSON 而不是一句提示：\(result.stderr.prefix(300))")
        let reading = try XCTUnwrap(
            payload["ageRetention"] as? String,
            "--evidence-stats 的载荷里没有年龄闸的读数：泳道 2 备好的值又没有读者了"
        )
        XCTAssertTrue(reading.contains("not enforced by the daemon"), reading)
        XCTAssertTrue(reading.contains("--prune-evidence --older-than <days> is the only age path"), reading)
        XCTAssertFalse(
            reading.contains(where: { $0.isNumber }),
            "没有闸的那一支里出现了数字（一条没人设置过的到期承诺）：\(reading)"
        )
        XCTAssertFalse(reading.contains("§"), "给人看的读数里不许夹内部条款号：\(reading)")
        // 既有读数不许在搬家时被动到：这一面仍然把"没有"与"读不出"分得开。
        XCTAssertEqual(payload["count"] as? Int, 0, "空档案那一面的既有读数变了")
    }

    /// 接线：那一键必须就在那一份内联字典里（搬走就等于关掉这一面），且读数出自这个 store。
    /// 允许两种合法形状：本泳道的本地折算函数，或泳道 2 合并后直接转读 `stats.ageRetention`
    /// ——**只有那一键本身在发出去**这件事是判据，字面量不留两处。
    /// REVERSE：删掉 `"ageRetention":` 那一行 → 第一条红；让读数不看 store → 第二条红。
    func testTheReadingIsWiredIntoTheOnePayloadDictionary() throws {
        let text = try S3Source.main()
        // 窗口锚在 `--evidence-stats` 那一段**真正的**起点上：`requestedCommands` 里也有一枚
        // `if options.evidenceStats {`，从它起算会把整个分发段卷进来，那条对照就成了看两遍东西。
        let block = try XCTUnwrap(
            S3Source.window(of: text, startsAt: "let stats = store.stats()", stopsAt: "exit(unreadable ? 1 : 0)"),
            "--evidence-stats 的载荷段不见了"
        )
        let code = S3Source.codeOnly(block)
        XCTAssertEqual(code.components(separatedBy: "\"ageRetention\":").count - 1, 1,
                       "载荷里那一键不在那一份字典上（或被写了两遍）")
        XCTAssertTrue(
            code.contains("evidenceAgeRetentionReading(store)") || code.contains("stats.ageRetention"),
            "那一键不再从这个 store 折算，也不转读引擎的读数：它就成了第三处自辩"
        )
        XCTAssertFalse(code.contains("pruneOlderThanDays"),
                       "把 --older-than 当成年龄闸：那是一条一次性的删除窗口，不是留存配置")

        // 本地折算那一支（合并后被删掉也合法，所以按"要么在、要么已经转读"量）。
        if let helper = S3Source.window(
            of: text, startsAt: "private func evidenceAgeRetentionReading",
            stopsAt: "if options.pruneEvidence || options.evidenceStats {"
        ) {
            let helperCode = S3Source.codeOnly(helper)
            XCTAssertTrue(helperCode.contains("store.maxAgeDays"),
                          "函数不再问这个 store 有没有闸：那句「没设」就成了猜的")
            XCTAssertTrue(helperCode.contains("guard let maxAgeDays = store.maxAgeDays else"),
                          "两支折成一支：设了闸的那一支就不再说是谁设的")
            XCTAssertTrue(helperCode.contains("age gate of \\(maxAgeDays) day(s)"),
                          "设了闸那一支的措辞搬家时要留下出处")
            XCTAssertFalse(helperCode.contains("§"), "给人看的读数里不许夹内部条款号")
        }
    }

    /// 那条句子的拼写只有一处（泳道 2 的纪律：事实只有一个出口）。
    /// REVERSE：在 main.swift 里再写一遍同一句 → 这一条红。
    func testTheNotEnforcedSentenceIsSpelledOnce() throws {
        let text = S3Source.codeOnly(try S3Source.main())
        XCTAssertEqual(
            text.components(separatedBy: "--prune-evidence --older-than <days> is the only age path").count - 1, 1,
            "同一句在 main.swift 里被写了两遍：合并后它就是两套答案"
        )
    }
}
