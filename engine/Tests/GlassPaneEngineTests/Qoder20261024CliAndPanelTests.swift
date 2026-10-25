import XCTest
import Foundation
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 2026-10-24 lane（被轮数上限切掉的那条：代码已落地，一条测试都没写）。
///
/// 四条缺陷，四种"对调用方说了不成立的话"：
///
///  1. **`--request-permission` 的两支用法错只回一行。** `.errorCode(…, 64)` 写一行 stderr、
///     不写 usage，而 `--help` 的 64 那一条自己承诺"printed with the whole usage block"，
///     其余七枚取值开关也都印整块。同一个失败类两套答案，安静的那一套什么也没教会调用方。
///     现在走 `.error`：报文 + 整块 usage + 64。
///  2. **`--project-remove` / `--older-than` 缺值退 2**，而 `--active-project`、`--project`、
///     `--recipe-validate` 犯同一个错退 64。按 rc 分叉的人无法预判。现在缺值 = 64 + usage；
///     "值给了但这一条用不了"仍留 2（那正是 `--help` 的 2 段在说的一档）。
///  3. **`glasspaned --list-projects --older-than 7` 静默退 0。** 分发是一条 first-match 的
///     `if` 链、命中就 `exit`，所以凡属"这一趟永远不会跑的那条命令"或"这一趟不会进入的
///     服务形态"的修饰旗标，一个读者都没有。`OneShotFlagScope` 逐枚点名并拒绝（64 + usage）；
///     `--state-dir` / `--verbose` 在不读状态的命令上**不拒**（点名隔离根永远不该被罚），
///     但要写一行 stderr 说这一枚没被读到。
///  4. **面板侧两处不诚实**：`--permissions` 无论席位读成什么都退 0，且出键是 camelCase、
///     而 `--request-permission` 只吃 kebab（读到一个键名照抄进另一条命令就是一次失败调用）；
///     `launchctl submit` 走 `try? process.run()`，一次**实测到的拒绝**只剩"输出文件一直没
///     内容"这一种显形方式，于是等完整笔预算后报 `.timedOut`，给的下一步（再点一次）并不
///     会改变 launchd 的回答。外加控制台把 daemon 自报的 `stateRoot` 直接采纳，而 TS 侧
///     对同一个值早就有闸。
///
/// 为什么 CLI 那三条跑**真二进制**：`OneShotFlagScope` 与 `parseArguments` 在可执行目标的
/// `main.swift` 顶层，测试目标既不链接 `glasspaned`，顶层代码在任何可见性下都 import 不动
/// ——改成 `internal` 也换不来一句可执行的断言。判据形状抄 `DaemonExitCodeTests`（源码对照）
/// 与 `RegistryCliRefusalShapeTests` / `QoderPanel20261019Tests`（真二进制）。
///
/// 每条都写明 REVERSE：把那句改回去，这一条就红。

// MARK: - 共用夹具：真二进制的一次性调用

private struct GP24Run {
    let status: Int32
    let stdout: String
    let stderr: String

    /// 整块 usage 走 **stdout**（`printUsage` 写那里，与 `--help` 同一条通道），
    /// stderr 只留那一行报文。
    var usageWasPrinted: Bool {
        stdout.contains("glasspaned — GlassPane P0 engine daemon")
            && stdout.contains("USAGE:")
            && stdout.contains("EXIT CODES")
    }

    var json: [String: Any]? {
        for stream in [stdout, stderr] {
            let trimmed = stream.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            return object
        }
        return nil
    }
}

private enum GP24Daemon {
    /// `engine/.build/debug/glasspaned`，由本文件位置推出（不吃进程工作目录）。
    static var path: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }   // → engine/
        return url.appendingPathComponent(".build/debug/glasspaned").path
    }

    /// 先读到 EOF 再等退出：反过来的话，输出超过管道缓冲的子进程会把这里卡住。
    static func run(_ arguments: [String]) throws -> GP24Run {
        guard FileManager.default.isExecutableFile(atPath: path) else {
            throw XCTSkip("没有 \(path)；这一条要的是真 argv 处理（swift build --package-path engine）")
        }
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
        return GP24Run(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }
}

/// 源码对照用的两只手：读本仓源文件、抠正则捕获组。
private enum GP24Source {
    static func read(_ relative: String) throws -> String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // → 仓库根
        let path = url.appendingPathComponent(relative).path
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(path)；这一条源码对照在没有该文件的环境里不作数")
        }
        return text
    }

    /// 捕获组 1 的每个匹配。
    static func captures(_ pattern: String, in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            XCTFail("正则写坏了：\(pattern)")
            return []
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        var out: [String] = []
        regex.enumerateMatches(in: text, range: range) { match, _, _ in
            guard let match, match.numberOfRanges > 1,
                  let group = Range(match.range(at: 1), in: text) else { return }
            out.append(String(text[group]))
        }
        return out
    }

    /// `static let <declaration>: Set<String> = [ "a", "b", … ]` 里的字面量。
    static func stringSet(in text: String, declaration: String) -> [String] {
        guard let start = text.range(of: declaration),
              let open = text.range(of: "[", range: start.upperBound..<text.endIndex),
              let close = text.range(of: "]", range: open.upperBound..<text.endIndex)
        else { return [] }
        return captures("\"([^\"]+)\"", in: String(text[open.upperBound..<close.lowerBound]))
    }

    /// 某个标记在**非注释行**里出现的次数：文档里提到一个函数名不该算一次调用。
    static func codeOccurrences(_ text: String, _ marker: String) -> Int {
        codeOnly(text).components(separatedBy: marker).count - 1
    }

    /// 只留代码行：注释里对旧写法的描述不该被读成现存的代码，一段"新写法说明"也不该
    /// 替不存在的代码背书。源码形状判据一律先过这一道。
    static func codeOnly(_ region: String) -> String {
        region.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.hasPrefix("//") && !$0.hasPrefix("/*") && !$0.hasPrefix("*") }
            .joined(separator: "\n")
    }

    /// 一个函数（或分支）体的窗口：从含 `marker` 的那一行起，到**第一个匹配 `stopPattern`
    /// 的行**前止。按行切、用正则认行首，不锚任何一段缩进——别人把缩进从 4 个空格改成
    /// 2 个、或把这一段整体挪一层，都不该把这个窗口关成空。
    static func body(of text: String, startsAt marker: String, stoppingAtFirstLineMatching stopPattern: String) -> String? {
        guard let stop = try? NSRegularExpression(pattern: stopPattern) else {
            XCTFail("正则写坏了：\(stopPattern)")
            return nil
        }
        guard let start = text.range(of: marker) else { return nil }
        var lines: [String] = []
        for raw in text[start.lowerBound...].split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if !lines.isEmpty, stop.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil {
                break
            }
            lines.append(line)
        }
        return lines.joined(separator: "\n")
    }

    /// 一个窗口里抠到的**代码行**数：给"抽取本身要先能被证伪"那句自检用。
    static func codeLineCount(_ region: String) -> Int {
        codeOnly(region).split(separator: "\n", omittingEmptySubsequences: true).count
    }
}

// MARK: - 第 1..3 条：CLI 用法面与一次性旗标范围

final class Qoder20261024CliAndPanelTests: XCTestCase {

    // MARK: - 1. `--request-permission` 的两支用法错

    /// REVERSE：把那一支改回 `.errorCode("--request-permission requires one of: …", 64)`
    /// → `usageWasPrinted` 红（stdout 一字节都没有），其余照旧绿——那正是"同一失败类两套答案"。
    func testRequestPermissionWithNoValueGivesMessagePlusWholeUsageAnd64() throws {
        let root = TestSandbox.directory("req-perm-missing")
        let result = try GP24Daemon.run(["--state-dir", root, "--request-permission"])
        assertUsageErrorShape(
            result,
            messageFragment: "--request-permission requires one of: accessibility | input-monitoring | screen-recording | developer-tools"
        )
    }

    /// 未知 kind 那一支，两种拼写各走一次：`--request-permission nope` 与 `--request-permission=nope`
    /// （`=` 在 `parseArguments` 顶上就被展开，一套语法不该一个印 usage、一个只回一行）。
    /// REVERSE：回到 `.errorCode("--request-permission unknown kind: …", 64)` → usage 红；
    /// 把 `=` 展开那一圈删掉 → 报文变成 unknown argument，红。
    func testRequestPermissionWithAnUnknownKindGivesMessagePlusWholeUsageAnd64() throws {
        let root = TestSandbox.directory("req-perm-kind")
        for arguments in [["--request-permission", "not-a-seat"], ["--request-permission=not-a-seat"]] {
            let result = try GP24Daemon.run(["--state-dir", root] + arguments)
            assertUsageErrorShape(result, messageFragment: "--request-permission unknown kind: not-a-seat")
        }
    }

    // MARK: - 2. 缺值 → 64；值用不了 → 仍是 2

    /// 这一条**能区分改前改后**：改前 `--project-remove` 缺值退 2 且不印 usage，
    /// 于是"码=64"与"印了整块 usage"两条各红一次。
    /// REVERSE：改回 `.errorCode("--project-remove requires a project ID", 2)` → 两条都红。
    func testProjectRemoveWithoutAValueIsAUsageErrorNowNotATwo() throws {
        let root = TestSandbox.directory("remove-missing")
        let result = try GP24Daemon.run(["--state-dir", root, "--project-remove"])
        assertUsageErrorShape(result, messageFragment: "--project-remove requires a project ID")
    }

    /// REVERSE：改回 `.errorCode("--older-than requires a day count", 2)` → 64 与 usage 两条红。
    func testOlderThanWithoutADayCountIsAUsageError() throws {
        let root = TestSandbox.directory("older-missing")
        let result = try GP24Daemon.run(["--state-dir", root, "--prune-evidence", "--older-than"])
        assertUsageErrorShape(result, messageFragment: "--older-than requires a day count")
    }

    /// 分界的另一侧，这一轮**故意没动**：旗标听懂了，它带的这个值没听懂。2、一行 stderr、
    /// 不印 usage——`--help` 的 2 段说的就是这一档。两支各测一半才叫判据。
    /// REVERSE：把 `.errorCode(…, 2)` 也换成 `.error`（一律 64）→ 这一条红。
    func testOlderThanWithAnUnusableValueStillExitsTwoWithoutUsage() throws {
        let root = TestSandbox.directory("older-bad-value")
        for value in ["0", "abc", "-3"] {
            let result = try GP24Daemon.run(["--state-dir", root, "--prune-evidence", "--older-than", value])
            XCTAssertEqual(result.status, 2, "值给了但用不了 = 2（--help 的 2 段），实得 \(result.status)：\(result.stderr)")
            XCTAssertTrue(result.stderr.contains("--older-than requires a positive integer"), result.stderr)
            XCTAssertFalse(result.usageWasPrinted, "2 这一档不印整块 usage：\(result.stdout.prefix(120))")
            XCTAssertEqual(result.stdout, "", "2 的答复只有那一行 stderr：\(result.stdout.debugDescription)")
        }
    }

    /// 对照：换了码之后，`--project-remove` 那条"这个 id 没注册"（3）不许被 64 吞掉。
    /// REVERSE：把缺值那一支写成"任何 `--project-remove` 都 64" → 这一条红。
    func testProjectRemoveStillAnswersThreeForAnIdThatIsNotRegistered() throws {
        let root = TestSandbox.directory("remove-unregistered")
        try Data("[]\n".utf8).write(to: URL(fileURLWithPath: root + "/projects.json"))
        let result = try GP24Daemon.run(["--state-dir", root, "--project-remove", "prj_01M34567890123456789012A"])
        XCTAssertEqual(result.status, 3, "\(result.stderr)")
        XCTAssertFalse(result.usageWasPrinted, "3 是一次实测到的缺席，不是一次用法错")
        XCTAssertEqual(result.json?["found"] as? Bool, false)
    }

    /// `--help` 得说得出程序真正会回的东西：两枚开关都进了 64 段，2 段不再提 `--project-remove`。
    /// REVERSE：只改程序不改文档（或反过来）→ 各红一次。
    func testUsageTextMovedBothFlagsIntoTheSixtyFourParagraph() throws {
        let text = try GP24Source.read("engine/Sources/glasspaned/main.swift")
        let sixtyFour = try exitCodeParagraph(text, code: "64")
        XCTAssertFalse(sixtyFour.isEmpty, "EXIT CODES 里找不到 64 那一段：夹具本身没成立")
        for flag in ["--project-remove", "--older-than", "--request-permission"] {
            XCTAssertTrue(
                sixtyFour.contains(flag),
                "这一支现在回 64，64 段却没点名它：\(flag)（按码分叉的人读不到这一条）"
            )
        }
        let two = try exitCodeParagraph(text, code: "2")
        XCTAssertFalse(two.isEmpty, "EXIT CODES 里找不到 2 那一段")
        XCTAssertFalse(
            two.contains("--project-remove"),
            "2 段还在替 `--project-remove` 说话：文档比程序更能干（那一支已经走 64）：\(two)"
        )
        XCTAssertTrue(two.contains("--older-than"), "2 段仍要说得出「值给了却用不了」那一档：\(two)")
    }

    // MARK: - 3. OneShotFlagScope

    /// 那张表是 `private`、且在可执行目标的顶层代码里——任何可见性都摸不到，所以按**源码形状**
    /// 钉它（`DaemonExitCodeTests` 的写法），并带上"抽取本身要能被证伪"那条义务。
    /// REVERSE：给 `--list-projects` 加上 `--older-than` → 表红；删掉 `--evidence-stats` 的
    /// `--project` → 表红；把 `--list-projects` 放进 `stateFreeCommands` → 第三条红；
    /// 表里命令名打错 → `requestedCommands` 那条对照红；把 `modifiers` 里任意一枚改名 →
    /// 第一句红，而 `orphan` 那条会替另一侧背书。
    func testOneShotScopeTableIsTheTableTheDispatchReads() throws {
        let text = try GP24Source.read("engine/Sources/glasspaned/main.swift")
        // 窗口按**行首正则**收口，不锚任何一段缩进：重排缩进不该把窗口关成空。
        let scope = GP24Source.codeOnly(try XCTUnwrap(
            GP24Source.body(of: text, startsAt: "enum OneShotFlagScope",
                            stoppingAtFirstLineMatching: "^\\s*(private )?func printUsage\\(\\)"),
            "找不到 OneShotFlagScope：这一轮新增的那张表不见了，对照不能对着空表成立"
        ))
        XCTAssertGreaterThanOrEqual(
            GP24Source.codeLineCount(scope), 15,
            "那张表只抠到 \(GP24Source.codeLineCount(scope)) 行代码：窗口没张对，下面的内容断言不作数"
        )

        let modifiers = Set(GP24Source.stringSet(in: scope, declaration: "static let modifiers"))
        XCTAssertEqual(
            modifiers,
            [
                "--dry-run", "--older-than", "--project", "--socket-path", "--probe-socket-path",
                "--force-socket", "--force-probe-socket", "--no-probe", "--no-c33", "--unattended-window",
            ],
            "修饰旗标的全集变了：这一轮由这张表说了算的那一批就得跟着改"
        )

        let table = try allowedModifierTable(scope)
        XCTAssertGreaterThanOrEqual(table.count, 4, "只抠出 \(table.count) 条命令：抽取式已经在看不到东西的地方")
        XCTAssertEqual(
            table,
            [
                "--project-prune": ["--dry-run"],
                "--project-remove": ["--dry-run"],
                "--prune-evidence": ["--dry-run", "--older-than", "--project"],
                "--evidence-stats": ["--project"],
            ],
            "每条一次性命令真的读的修饰旗标（判据来自分发段那几行代码）"
        )
        XCTAssertTrue(
            scope.contains("default:") && scope.contains("return []"),
            "表里少了 default 那一支：没列出的命令会变成「什么都不接受」而不是「一枚都不读」"
        )

        // 表不许漂：allowed 里每一枚都得先在 modifiers 全集里出现，否则 `refused()`
        // （先 intersection 再 subtracting）根本看不到它，写下去的是一条不起作用的豁免。
        let orphan = table.values.flatMap { $0 }.filter { !modifiers.contains($0) }.sorted()
        XCTAssertTrue(orphan.isEmpty, "这些豁免不在 modifiers 全集里，因此永远不起作用：\(orphan)")

        // 每一条被点名的命令都得是分发段真的认得的命令。
        let dispatched = Set(GP24Source.captures(#"names\.append\("(--[a-z-]+)"\)"#, in: text))
        XCTAssertGreaterThanOrEqual(dispatched.count, 15, "抠到的命令名单只有 \(dispatched.count) 条：对照本身失效了")
        let phantom = table.keys.filter { !dispatched.contains($0) }.sorted()
        XCTAssertTrue(phantom.isEmpty, "表里点名了不存在的命令（那条豁免永远跑不到）：\(phantom)")

        let stateFree = Set(GP24Source.stringSet(in: scope, declaration: "static let stateFreeCommands"))
        for named in [
            "--version", "--permissions", "--request-permission", "--check-developer-tools", "--recipe-validate",
        ] {
            XCTAssertTrue(stateFree.contains(named), "\(named) 一枚状态都不读，点名隔离根只能给提示、不能拒")
        }
        let touching = [
            "--list-projects", "--active-project", "--project-prune", "--project-remove",
            "--prune-evidence", "--evidence-stats", "--approval-audit", "--approval-verify",
        ]
        let wronglyFree = touching.filter { stateFree.contains($0) }
        XCTAssertTrue(
            wronglyFree.isEmpty,
            "这些命令读状态，却被列成「不读状态」（那会给出一句假的「没碰过这个根」）：\(wronglyFree)"
        )
    }

    /// 头条缺陷，端到端：一枚这一趟永远不会读的修饰旗标从前被静默吞掉并退 0。
    /// 现在：点名、拒绝、整块 usage、64、一条都没跑。
    /// REVERSE：删掉分发段那句 `if !refused.isEmpty { … exit(64) }` → 回到 rc=0 且无提示，红。
    func testListProjectsRefusesAnOlderThanItWillNeverRead() throws {
        let root = TestSandbox.directory("scope-list-older")
        let result = try GP24Daemon.run(["--state-dir", root, "--list-projects", "--older-than", "7"])
        XCTAssertEqual(result.status, 64, "一枚这条命令不读的修饰旗标混进来是一次用法错：\(result.stderr)")
        XCTAssertTrue(result.stderr.contains("--older-than"), "要点名被拒的那一枚：\(result.stderr.prefix(300))")
        XCTAssertTrue(result.stderr.contains("is not read by --list-projects"), String(result.stderr.prefix(300)))
        XCTAssertTrue(result.stderr.contains("no modifier flags at all"),
                      "还得说清这一条一枚都不读，否则调用方不知道往哪儿补：\(result.stderr.prefix(300))")
        XCTAssertTrue(result.stderr.contains("--prune-evidence"),
                      "拒绝要给「这枚旗标归谁」的去处：\(result.stderr.prefix(300))")
        XCTAssertTrue(result.usageWasPrinted, "与「一次要两条命令」那一支同一口径：整块 usage")
        XCTAssertNotEqual(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "[]",
                          "拒了却还把这一条跑了出去：项目清单被印了出来")
    }

    /// 同一枚旗标在两条命令上一个是非法的一个是合法的：范围按**命令**算，不按旗标算。
    /// REVERSE：删掉 `allowedModifiers(for:)` 里 `--prune-evidence` 那一行 → 后半红（一次合法调用被拒）；
    /// 把 `--dry-run` 从 `--project-prune` 那行删掉 → 第三条红。
    func testScopeRefusesPerCommandNotPerFlag() throws {
        let root = TestSandbox.directory("scope-per-command")

        let refusedHere = try GP24Daemon.run(["--state-dir", root, "--project-prune", "--dry-run", "--older-than", "7"])
        XCTAssertEqual(refusedHere.status, 64, "\(refusedHere.stderr.prefix(300))")
        XCTAssertTrue(refusedHere.stderr.contains("--older-than"), String(refusedHere.stderr.prefix(300)))
        XCTAssertFalse(refusedHere.stderr.contains("--dry-run is not read by"),
                       "同一串里被这条命令认下的那一枚不许一起点名：\(refusedHere.stderr.prefix(300))")

        let honouredThere = try GP24Daemon.run(["--state-dir", root, "--prune-evidence", "--older-than", "7"])
        XCTAssertNotEqual(honouredThere.status, 64, "--prune-evidence 真的读 --older-than：\(honouredThere.stderr.prefix(300))")
        XCTAssertFalse(honouredThere.stderr.contains("not read by"), String(honouredThere.stderr.prefix(300)))

        let dryRunPreview = try GP24Daemon.run(["--state-dir", root, "--project-prune", "--dry-run"])
        XCTAssertNotEqual(dryRunPreview.status, 64, "预览这一枚归它自己：\(dryRunPreview.stderr.prefix(300))")
        XCTAssertFalse(dryRunPreview.stderr.contains("not read by"), String(dryRunPreview.stderr.prefix(300)))
        let payload = try XCTUnwrap(dryRunPreview.json, "这一条该交出答复而不是一句提示：\(dryRunPreview.stderr)")
        XCTAssertEqual(payload["command"] as? String, "--project-prune")
        XCTAssertEqual(payload["dryRun"] as? Bool, true)
    }

    /// 服务形态那批旗标与一次性命令同现，同一口径拒绝，并把唯一能认下它们的形态说出口
    /// （"… only mean something when this run serves the socket"）。
    /// REVERSE：把 `--socket-path` 从 `modifiers` 里摘掉 → 这一条红（旗标又被静默吃掉）。
    func testVersionRefusesASocketPathItCannotUse() throws {
        let result = try GP24Daemon.run(["--version", "--socket-path", TestSandbox.pendingDirectory("scope-socket")])
        XCTAssertEqual(result.status, 64, "\(result.stderr.prefix(300))")
        XCTAssertTrue(result.stderr.contains("--socket-path"), String(result.stderr.prefix(300)))
        XCTAssertTrue(result.stderr.contains("is not read by --version"), String(result.stderr.prefix(300)))
        XCTAssertTrue(result.stderr.contains("serves the socket"), String(result.stderr.prefix(300)))
        XCTAssertTrue(result.usageWasPrinted)
        XCTAssertFalse(result.stdout.contains("glasspaned \(EngineCore.buildVersion)"),
                       "拒了却还是把版本号印了出去：\(result.stdout.prefix(120))")
    }

    /// `--state-dir` 在不读状态的命令上**不被拒**：罚下唯一那个隔离动作，会把调用方推回
    /// "干脆不带隔离根"。取而代之的是一行 stderr，而且说得属实：那个根没被创建、没被读、
    /// 没被收紧、没被写。
    /// REVERSE：把 `--state-dir` 加进 `modifiers` → 第一条红（点名隔离根被拒）；
    /// 删掉那行 note → 第二条红（旗标又静默消失）；note 改成"已按它读过" → 第三条红。
    func testPermissionsDoesNotRefuseStateDirButSaysItWasNeverConsulted() throws {
        let uncreated = TestSandbox.pendingDirectory("scope-state-free-note")
        let result = try GP24Daemon.run(["--permissions", "--state-dir", uncreated])
        XCTAssertFalse(
            result.stderr.contains("not read by"),
            "点名状态根不该被当成用法错：\(result.stderr.prefix(300))"
        )
        XCTAssertNotEqual(result.status, 64, "\(result.stderr.prefix(300))")
        XCTAssertTrue(result.stderr.contains("--permissions reads no state"),
                      "这一枚没被读到，得有一行 stderr 说出来：\(result.stderr.debugDescription)")
        XCTAssertTrue(result.stderr.contains("was not consulted"), result.stderr)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: uncreated),
            "那句话说「没碰过这个根」，这一趟就得真的没碰过：目录被创建出来了"
        )
        XCTAssertNotNil(result.json, "--permissions 仍要交出那份席位报告：\(result.stdout.prefix(200))")
    }

    /// `--verbose` 是另一枚在一次性形态下没有读者的旗标：不拒，但要说出口。
    /// 两行提示各是一行（不许把 note 折进 stdout，也不许一句顶两行）。
    /// REVERSE：删掉分发段 `if options.verbose` 那一句 → 第二行红；把提示写进 stdout → 第四条红。
    func testVerboseOnAOneShotGetsItsOwnHonestLineAndStillAnswers() throws {
        let uncreated = TestSandbox.pendingDirectory("scope-verbose-note")
        let result = try GP24Daemon.run(["--permissions", "--state-dir", uncreated, "-v"])
        XCTAssertNotEqual(result.status, 64, "\(result.stderr.prefix(300))")
        let noteLines = result.stderr.split(separator: "\n").map(String.init).filter { $0.contains("note —") }
        XCTAssertEqual(
            noteLines.count, 2,
            "state-dir 与 verbose 各该有一行、且各只是一行：\(noteLines)"
        )
        XCTAssertTrue(noteLines.contains { $0.contains("--verbose") && $0.contains("serving daemon") },
                      "\(noteLines)")
        XCTAssertTrue(noteLines.contains { $0.contains("--state-dir") }, "\(noteLines)")
        XCTAssertTrue(result.stdout.hasPrefix("{"), "提示走 stderr，报告仍走 stdout：\(result.stdout.prefix(120))")
    }

    // MARK: - 形状判据

    /// `.error` 那一支的形状：一行报文（stderr）+ 整块 usage（stdout）+ 64。
    private func assertUsageErrorShape(
        _ result: GP24Run, messageFragment: String, file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(result.status, 64, "用法错就是 64：\(result.stderr)", file: file, line: line)
        XCTAssertTrue(
            result.stderr.hasPrefix("glasspaned: "),
            "报文得是本 CLI 的说法（`glasspaned: …`）：\(result.stderr.debugDescription)",
            file: file, line: line
        )
        XCTAssertTrue(
            result.stderr.contains(messageFragment),
            "报文没点出那一枚开关的毛病（要找 \(messageFragment)）：\(result.stderr)",
            file: file, line: line
        )
        XCTAssertEqual(
            result.stderr.split(separator: "\n").count, 1,
            "stderr 只许那一行报文：usage 走 stdout，与 `--help` 同一条通道：\(result.stderr.debugDescription)",
            file: file, line: line
        )
        XCTAssertTrue(
            result.usageWasPrinted,
            "缺值这一支不印整块 usage（改前正是这样：`.errorCode(…, 64)` 只给一行）",
            file: file, line: line
        )
        XCTAssertFalse(result.stderr.contains("USAGE:"), "usage 漏进了 stderr：\(result.stderr.prefix(200))",
                       file: file, line: line)
        XCTAssertNil(result.json, "一次用法错不许顺手吐出一份 JSON：\(result.stdout.prefix(200))",
                     file: file, line: line)
    }

    /// `EXIT CODES` 里某一个码的那一段：从它自己的头行到下一个码的头行。
    private func exitCodeParagraph(_ text: String, code: String) throws -> String {
        let region = try XCTUnwrap(
            text.range(of: "EXIT CODES").flatMap { head in
                text.range(of: "PROTOCOL:", range: head.upperBound..<text.endIndex).map { head.upperBound..<$0.lowerBound }
            },
            "找不到 EXIT CODES 到 PROTOCOL 那一段"
        )
        let headPattern = try NSRegularExpression(pattern: "^\\s*(\\d+)\\s{2,}\\S", options: [.anchorsMatchLines])
        let section = String(text[region])
        var paragraph = ""
        var collecting = false
        for line in section.split(separator: "\n") {
            let nsLine = String(line)
            let range = NSRange(nsLine.startIndex..<nsLine.endIndex, in: nsLine)
            if let match = headPattern.firstMatch(in: nsLine, range: range),
               let captured = Range(match.range(at: 1), in: nsLine) {
                collecting = nsLine[captured] == code
            }
            if collecting { paragraph += nsLine.trimmingCharacters(in: .whitespaces) + "\n" }
        }
        return paragraph
    }

    /// `static let <declaration>: Set<String> = [ … ]` 里的字符串字面量。
    private func allowedModifierTable(_ scope: String) throws -> [String: Set<String>] {
        guard let start = scope.range(of: "static func allowedModifiers"),
              let end = scope.range(of: "static let stateFreeCommands", range: start.upperBound..<scope.endIndex)
        else {
            XCTFail("找不到 allowedModifiers(for:)：这一轮新增的那张表不见了")
            return [:]
        }
        let body = scope[start.lowerBound..<end.lowerBound]
        let lines = body.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        var table: [String: Set<String>] = [:]
        var index = 0
        while index < lines.count {
            let line = lines[index]
            if line.hasPrefix("case "), line.hasSuffix(":"), !line.contains("default") {
                let names = GP24Source.captures("\"([^\"]+)\"", in: line)
                var walker = index + 1
                while walker < lines.count, !lines[walker].hasPrefix("return") { walker += 1 }
                guard walker < lines.count else { break }
                let granted = Set(GP24Source.captures("\"([^\"]+)\"", in: lines[walker]))
                for name in names { table[name] = granted }
                index = walker + 1
                continue
            }
            index += 1
        }
        return table
    }
}

// MARK: - 第 4..5 条：`--permissions` 的席位报告

/// `PermissionSeatReport` 是公开库 API，判据可在无 TCC 环境下直接求值；最后一条跑一次真二进制，
/// 钉住 CLI 那一面真的把这份形状交了出去。
final class Qoder20261024PermissionSeatReportTests: XCTestCase {

    /// 带空格与单引号的那种真机安装路径：它同时是"出键"与"引用"两件事的夹具。
    private let binary = "/opt/Glass Pane's/Contents/MacOS/glasspaned"

    private func seats(
        _ accessibility: PermissionStatus = .granted,
        _ inputMonitoring: PermissionStatus = .granted,
        _ screenRecording: PermissionStatus = .granted,
        _ developerTools: PermissionStatus = .unverifiable
    ) -> [PermissionKind: PermissionStatus] {
        [
            .accessibility: accessibility,
            .inputMonitoring: inputMonitoring,
            .screenRecording: screenRecording,
            .developerTools: developerTools,
        ]
    }

    private func seat(_ entry: [String: Any]) -> String { entry["seat"] as? String ?? "?" }
    private func entries(_ value: Any?) -> [[String: Any]] { value as? [[String: Any]] ?? [] }

    /// 四个键就是 `--request-permission` **吃**的那四个词。从前这一面出 `inputMonitoring`，
    /// 读的人照抄进那条命令就是一次失败调用。
    /// REVERSE：`cliWire` 改回 `kind.rawValue` → 第一句红；只列三个席位 → 第二句红；
    /// 缺席位的读数折成 `granted` → 最后两句红。
    func testCliWireSpellsEverySeatTheWayTheAskCommandTakesIt() {
        let mixed = seats(.granted, .denied, .notDetermined, .unverifiable)
        let wire = PermissionSeatReport.cliWire(statuses: mixed)
        XCTAssertEqual(
            Set(wire.keys), Set(PermissionKind.allCases.map { $0.cliValue }),
            "出键必须是 kebab 四件套：\(wire.keys.sorted())"
        )
        for kind in PermissionKind.allCases {
            XCTAssertNotNil(PermissionKind.from(cliValue: kind.cliValue), "\(kind.cliValue) 喂不回去")
            XCTAssertEqual(wire[kind.cliValue], mixed[kind]?.rawValue, "\(kind.cliValue) 的读数对不上")
        }
        XCTAssertEqual(wire["input-monitoring"], "denied")
        XCTAssertEqual(wire["screen-recording"], "notDetermined")
        XCTAssertEqual(wire["developer-tools"], "unverifiable", "developer-tools 恒 unverifiable 是设计，不是拒")

        // 一栏都没给的席位也要出现，且不许被折成 granted：看不见不等于批了。
        let empty = PermissionSeatReport.cliWire(statuses: [:])
        XCTAssertEqual(Set(empty.keys), Set(PermissionKind.allCases.map { $0.cliValue }))
        XCTAssertEqual(Set(empty.values), [PermissionStatus.unverifiable.rawValue])
    }

    /// 四种组合，而只有**测得到的三个席位**能动答案。
    /// REVERSE：`measuredKinds` 里加进 `.developerTools` → 前两句红（这一面从没测过它，任何真机
    /// 上它都不是 granted，`--permissions` 于是永远退 1）；判据写成"任一 granted 即真" → 后四句红。
    func testAllMeasuredSeatsGrantedIsExactlyThreeSeats() {
        XCTAssertTrue(
            PermissionSeatReport.allMeasuredSeatsGranted(seats(.granted, .granted, .granted, .unverifiable)),
            "三个测得到的席位全 granted、developer-tools 无从测量 ⇒ 真"
        )
        XCTAssertTrue(
            PermissionSeatReport.allMeasuredSeatsGranted(seats(.granted, .granted, .granted, .denied)),
            "developer-tools 不参与判决：那一栏写着 denied 也不算未批"
        )
        XCTAssertFalse(PermissionSeatReport.allMeasuredSeatsGranted(seats(.denied, .granted, .granted)))
        XCTAssertFalse(PermissionSeatReport.allMeasuredSeatsGranted(seats(.granted, .notDetermined, .granted)))
        XCTAssertFalse(PermissionSeatReport.allMeasuredSeatsGranted(seats(.granted, .granted, .unverifiable)))
        XCTAssertFalse(
            PermissionSeatReport.allMeasuredSeatsGranted([.accessibility: .granted, .inputMonitoring: .granted]),
            "少一栏是「没测到」，不是「测到了 granted」"
        )
        XCTAssertEqual(
            Set(PermissionSeatReport.measuredKinds),
            Set(PermissionKind.allCases.filter { $0 != .developerTools })
        )
        XCTAssertEqual(PermissionSeatReport.unmeasuredKinds, [.developerTools])
    }

    /// REVERSE：`exitCode` 无条件 `return 0`（改前 `--permissions` 那一支就是这样）→ 中间两句红。
    func testExitCodeStatesTheReadingNotThatTheCommandRan() {
        XCTAssertEqual(PermissionSeatReport.exitCode(seats()), 0)
        XCTAssertEqual(
            PermissionSeatReport.exitCode(seats(.denied)), 1,
            "一份没批下来的席位配一个 0，读 rc 的人记住的就是「批了」"
        )
        XCTAssertEqual(PermissionSeatReport.exitCode(seats(.granted, .granted, .notDetermined)), 1)
        XCTAssertEqual(
            PermissionSeatReport.exitCode(seats(.granted, .granted, .granted, .denied)), 0,
            "developer-tools 不许把判决折成 1"
        )
    }

    /// 每个非 granted 的可测席位都带一条**照着能跑**的命令：以 daemon 自己的身份经 launchd 问、
    /// 系统面板深链、再读一次的命令。三样都在 `PermissionGuide` 里早就拼好了，只是没接到这一面。
    /// REVERSE：去掉 `pane` 或 `recheck` 任一键 → 对应断言红；把 `measuredKinds` 换成 `allCases`
    /// → developer-tools 那条"现成命令"被印出来，而那条命令问不出任何答案，红。
    func testRemediesHandOverARunnableAskForEveryUngrantedSeat() throws {
        let all = seats(.denied, .notDetermined, .unverifiable, .denied)
        let remedies = PermissionSeatReport.remedies(statuses: all, daemonBinaryPath: binary, nonce: "777")
        XCTAssertEqual(remedies.count, 3, "三个测得到的席位都没批：\(remedies.map(seat))")
        XCTAssertEqual(
            remedies.map(seat), ["accessibility", "input-monitoring", "screen-recording"],
            "按 allCases 的稳定顺序给，且不含 developer-tools：\(remedies.map(seat))"
        )
        for entry in remedies {
            let kind = try XCTUnwrap(
                PermissionKind.from(cliValue: seat(entry)),
                "seat 那个键必须是 --request-permission 吃的名字：\(entry)"
            )
            XCTAssertEqual(entry["status"] as? String, all[kind]?.rawValue)
            XCTAssertEqual(
                entry["pane"] as? String, PermissionGuide.systemPaneURL(for: kind),
                "面板深链要与卡片同一个真源：\(entry["pane"] ?? "nil")"
            )
            XCTAssertEqual(entry["recheck"] as? String, "glasspaned --permissions")
            let request = try XCTUnwrap(entry["request"] as? String)
            XCTAssertTrue(request.hasPrefix(Launchctl.path + " submit -l "), "不猜 launchctl 的位置：\(request)")
            XCTAssertTrue(request.contains("--request-permission \(kind.cliValue)"),
                          "那条命令要以 daemon 自己的身份问这一席：\(request)")
            XCTAssertTrue(request.contains("com.glasspane.guide.\(kind.cliValue).777"), request)
        }
        XCTAssertTrue(
            PermissionSeatReport.remedies(statuses: seats(), daemonBinaryPath: binary, nonce: "n").isEmpty,
            "全批下来就没有什么重探命令可给"
        )
    }

    /// 那个二进制路径是对端自报的字节（`hello.identity.binaryPath`），而这条字符串是给人（和
    /// agent）照着敲的：不引用就在第一个空格上散成三段。
    /// REVERSE：把 `RemedyCommand.quote($0)` 换成 `$0` → 前两句红；在这一侧再拼一遍 argv
    /// → 第三句红（同一件事两份判据）。
    func testRemediesQuoteThePeerReportedPathAndNothingElse() throws {
        let remedies = PermissionSeatReport.remedies(statuses: seats(.denied), daemonBinaryPath: binary, nonce: "1")
        XCTAssertEqual(remedies.count, 1)
        let request = try XCTUnwrap(remedies[0]["request"] as? String)
        XCTAssertEqual(RemedyCommand.quote(binary), "'/opt/Glass Pane'\\''s/Contents/MacOS/glasspaned'")
        XCTAssertTrue(request.contains(RemedyCommand.quote(binary)), request)
        XCTAssertFalse(request.contains("\(binary) --request-permission"),
                       "路径没被引用就拼进了一条给人照着敲的命令：\(request)")
        // 固定词原样写出：连它们一起套引用，这条命令就跑不起来了。
        XCTAssertTrue(request.contains(" submit -l com.glasspane.guide.accessibility.1 -- "), request)
        let plain = try XCTUnwrap(
            PermissionSeatReport.remedies(
                statuses: seats(.denied), daemonBinaryPath: "/opt/plain/glasspaned", nonce: "2"
            )[0]["request"] as? String
        )
        XCTAssertTrue(plain.contains(RemedyCommand.quote("/opt/plain/glasspaned")), plain)
    }

    /// REVERSE：`payload` 去掉 `next`（本文件其它 27 个机器可读出口都带）→ 红；
    /// `verdict` 把 developer-tools 的读数折进来 → 第二句红；`verdictExcludes` 不点名是谁 → 红。
    func testPayloadCarriesTheVerdictANextStepAndNamesTheExcludedSeat() throws {
        let subject = PermissionSubject(binaryPath: binary)
        let granted = PermissionSeatReport.payload(
            subject: subject, statuses: seats(.granted, .granted, .granted, .denied), nonce: "9"
        )
        for key in ["subject", "permissions", "verdict", "verdictSeats", "verdictExcludes", "seatsNotGranted", "next"] {
            XCTAssertNotNil(granted[key], "载荷缺了 `\(key)`：\(granted.keys.sorted())")
        }
        XCTAssertEqual(granted["verdict"] as? String, "granted", "developer-tools 写着 denied 也不改判决")
        XCTAssertEqual(
            granted["verdictSeats"] as? [String],
            ["accessibility", "input-monitoring", "screen-recording"]
        )
        let excludes = entries(granted["verdictExcludes"])
        XCTAssertEqual(excludes.count, 1, "不参与判决的那一席要说得出是哪一席")
        let excluded = try XCTUnwrap(excludes.first)
        XCTAssertEqual(excluded["seat"] as? String, "developer-tools")
        XCTAssertEqual(excluded["judgedByThisCommand"] as? Bool, false)
        XCTAssertNotNil(excluded["reason"] as? String)
        XCTAssertTrue((excluded["next"] as? String ?? "").contains("--check-developer-tools"),
                      "不参与判决要给「由谁去测」，不是给一句「不知道」")
        XCTAssertTrue((granted["next"] as? String ?? "").contains("--check-developer-tools"),
                      "全批下来也要说清剩下那一席归哪条命令")

        let notGranted = PermissionSeatReport.payload(
            subject: subject, statuses: seats(.granted, .notDetermined, .granted), nonce: "9"
        )
        XCTAssertEqual(notGranted["verdict"] as? String, "not-granted")
        let next = try XCTUnwrap(notGranted["next"] as? String)
        XCTAssertFalse(next.isEmpty, "一份不给下一步的报告读起来就是「就这样吧」")
        XCTAssertTrue(next.contains("seatsNotGranted"), next)
        XCTAssertTrue(next.contains("glasspaned --permissions"), next)
        XCTAssertEqual(entries(notGranted["seatsNotGranted"]).map(seat), ["input-monitoring"])
        XCTAssertEqual(
            notGranted["permissions"] as? [String: String],
            PermissionSeatReport.cliWire(statuses: seats(.granted, .notDetermined, .granted))
        )
        let subjectBlock = try XCTUnwrap(notGranted["subject"] as? [String: Any])
        XCTAssertEqual(subjectBlock["entryName"] as? String, subject.tccEntryName,
                       "报告要说得出这是谁的席位（ProtocolErrors 不许人把它读成 daemon 的状态）")
    }

    /// 第 5 条：两种拼写都还原成同一份席位表——`hello` 仍走 camelCase（那是协议形状，本轮不动），
    /// CLI 自报走 kebab，而面板的重探读的是后者。
    /// REVERSE：`statuses(from:)` 只认 `kind.rawValue` → kebab 那一半红（面板对着一次它其实
    /// 读到了的自报说"读不懂"）；只认 `cliValue` → camel 那一半红（旧 daemon 的 hello 全废）。
    func testSnapshotRestoresSeatsFromBothSpellings() {
        let camel: [String: Any] = [
            "accessibility": "granted", "inputMonitoring": "denied",
            "screenRecording": "notDetermined", "developerTools": "unverifiable",
        ]
        let kebab: [String: Any] = [
            "accessibility": "granted", "input-monitoring": "denied",
            "screen-recording": "notDetermined", "developer-tools": "unverifiable",
        ]
        let expected = seats(.granted, .denied, .notDetermined, .unverifiable)
        XCTAssertEqual(DaemonPermissionSnapshot.statuses(from: camel), expected, "hello 那一面（camelCase）读不回来了")
        XCTAssertEqual(DaemonPermissionSnapshot.statuses(from: kebab), expected, "--permissions 那一面（kebab）读不回来了")
        XCTAssertEqual(
            DaemonPermissionSnapshot.statuses(from: camel), DaemonPermissionSnapshot.statuses(from: kebab),
            "两种拼写必须还原成同一份席位表"
        )
        // 两形同现时 kebab 赢：那是这一面今天的出键。
        let mixed: [String: Any] = ["inputMonitoring": "granted", "input-monitoring": "denied"]
        XCTAssertEqual(DaemonPermissionSnapshot.statuses(from: mixed), [.inputMonitoring: .denied])
        // 读不懂的一律跳过，不折成任何一个态。
        XCTAssertEqual(DaemonPermissionSnapshot.statuses(from: ["accessibility": "approved"]), [:])
        XCTAssertEqual(DaemonPermissionSnapshot.statuses(from: ["unrelated": "granted"]), [:])
        XCTAssertEqual(DaemonPermissionSnapshot.statuses(from: nil), [:])

        let snapshot = DaemonPermissionSnapshot(subject: PermissionSubject(binaryPath: binary), statuses: expected)
        XCTAssertEqual(snapshot.permissionsWire["inputMonitoring"], "denied", "hello 线上那一面不许跟着换键名")
        XCTAssertNil(snapshot.permissionsWire["input-monitoring"])
    }

    /// 逼出这条规则的那个读者：`PermissionReprobe` 读的是 `--permissions` 那一行的输出。
    /// REVERSE：`statuses(from:)` 退回只认 camel → 这一条红（重探整份报告读成 nil）。
    func testReprobeReadsAKebabSelfReport() throws {
        func line(_ permissions: [String: String]) throws -> String {
            let text = String(
                decoding: try JSONSerialization.data(
                    withJSONObject: [
                        "subject": ["binaryPath": "/x/glasspaned", "hasBundleIdentity": false] as [String: Any],
                        "permissions": permissions,
                    ] as [String: Any]
                ),
                as: UTF8.self
            )
            return text
        }
        let kebabLine = try line([
            "accessibility": "granted", "input-monitoring": "denied", "screen-recording": "notDetermined",
        ])
        let result = try XCTUnwrap(PermissionReprobe.parse(kebabLine), "重探读不回那份 kebab 自报：\(kebabLine)")
        XCTAssertEqual(result.statuses[.inputMonitoring], .denied)
        XCTAssertEqual(result.statuses[.screenRecording], .notDetermined)
        XCTAssertEqual(result.subject.binaryPath, "/x/glasspaned")

        let camelLine = try line([
            "accessibility": "granted", "inputMonitoring": "denied", "screenRecording": "notDetermined",
        ])
        let older = try XCTUnwrap(PermissionReprobe.parse(camelLine), "旧 daemon 那份 hello 形状也得读得回来")
        XCTAssertEqual(older.statuses, result.statuses)
    }

    /// 端到端：CLI 真的把这份形状交出去，而退出码真的是"测得到的那三个席位读成了什么"。
    /// 判据写成不变式，因此在任何一台真机（任何席位组合）上都成立。
    /// REVERSE：`--permissions` 那一支改回 `exit(0)` + `snapshot.permissionsWire` → 三句红
    /// （键形、判决与码的一致性、`next`）。
    func testPermissionsCommandServesTheSeatReport() throws {
        let result = try GP24Daemon.run(["--permissions"])
        let payload = try XCTUnwrap(result.json, "`--permissions` 那一行必须是一份 JSON：\(result.stdout.prefix(300))")
        let permissions = payload["permissions"] as? [String: String] ?? [:]
        XCTAssertEqual(Set(permissions.keys), Set(PermissionKind.allCases.map { $0.cliValue }),
                       "CLI 出键仍是 camelCase：\(permissions.keys.sorted())")
        let measured = PermissionSeatReport.measuredKinds.map { $0.cliValue }
        XCTAssertEqual(payload["verdictSeats"] as? [String], measured)
        let granted = measured.allSatisfy { permissions[$0] == PermissionStatus.granted.rawValue }
        XCTAssertEqual(payload["verdict"] as? String, granted ? "granted" : "not-granted")
        XCTAssertEqual(Int(result.status), granted ? 0 : 1,
                       "退出码说的必须是测得到的那三个席位读成了什么，不是「这条命令跑完了」")
        XCTAssertNotNil(payload["next"] as? String, "本文件其它机器可读出口都带 next，这一面不能例外")
        XCTAssertEqual((payload["verdictExcludes"] as? [[String: Any]])?.first?["seat"] as? String, "developer-tools")
        let listed = entries(payload["seatsNotGranted"]).map(seat)
        XCTAssertFalse(listed.contains("developer-tools"), "这一面从没测过它，不许给它开一条「现成命令」")
        XCTAssertEqual(Set(listed), Set(measured.filter { permissions[$0] != PermissionStatus.granted.rawValue }.sorted()),
                       "seatsNotGranted 必须正好是测得到却没批的那几席")
    }
}

// MARK: - 第 6 条：`launchctl submit` 的拒绝不再被折成超时

/// `submitRefusalText` 是为这一条而抽出来的纯函数；`.submitRefused` 落到 `.spawnFailed` 那一步
/// 在一个需要真 launchd 作业才走得到的分支里，所以按**源码形状**钉（本仓对 `main.swift` 其余
/// 不可触发分支的同一条做法，见 `RegistryCliRefusalShapeTests`）：它证的是分支的形状，不是它被走到。
final class Qoder20261024SubmitRefusalTests: XCTestCase {

    private func settingsSource() throws -> String {
        try GP24Source.read("engine/Sources/glasspane-settings/SettingsModel.swift")
    }

    /// 缺陷本体：一次实测到的拒绝被说成一次等待，而给出的下一步不会改变 launchd 的回答。
    /// REVERSE：这一支落回 `CapabilityFailure.timedOut.fallbackText`（或直接 `recordProbeFailure(.timedOut)`）
    /// → 前两句红；把码丢掉 → 第四句红；把 `quoteDaemonWords` 换成裸插值 → 第五句红。
    func testRefusalTextSaysRefusalWithTheCodeAndNeverTheTimeoutTone() {
        let timeoutTone = CapabilityFailure.timedOut.fallbackText
        XCTAssertTrue(timeoutTone.contains("等得有点久"),
                      "对照本身要先成立：`.timedOut` 的默认文案就是那句超时口吻")

        let text = SettingsModel.submitRefusalText(status: 111, detail: "could not find specified job")
        XCTAssertFalse(text.contains("等得有点久"), "一次实测到的拒绝被说成一次等待：\(text)")
        XCTAssertFalse(text.contains(timeoutTone), "复用超时那句，下一步就成了「再点一次试试」：\(text)")
        XCTAssertTrue(text.contains("不是超时"), "得把「这不是超时」说出来：\(text)")
        XCTAssertTrue(text.contains("退出码 111"), "码是这一次拒绝的实测：\(text)")
        XCTAssertTrue(text.contains("后台服务的原话：could not find specified job"),
                      "launchctl 自己的那句话必须原样交出：\(text)")
        XCTAssertTrue(text.contains("未验证"), "诚实边界：没有新结论就不许点亮")
        XCTAssertTrue(text.contains("单靠再点一次不会改变"),
                      "下一步不许再指一个不会改变回答的动作：\(text)")
        XCTAssertFalse(text.contains("reachable"), "内部字段名不该印到人读的那一行上：\(text)")
    }

    /// peer 给的字节仍是一段话：控制字符折成可见转义，而不是原样落地或多出一行。
    /// REVERSE：`ConsoleModel.quoteDaemonWords(detail)` 换成 `detail` → 三句全红。
    func testRefusalTextCannotGrowLinesOrCarryTerminalBytes() {
        let text = SettingsModel.submitRefusalText(
            status: 5, detail: "label\u{001B}[31m exists\u{000A}in this session"
        )
        XCTAssertEqual(text.filter { $0 == "\u{000A}" }.count, 0,
                       "一个换行在页面上多写出一次 launchctl 从没说过的话：\(text)")
        XCTAssertFalse(
            text.unicodeScalars.contains { $0.value < 0x20 },
            "控制字节混进了面板文案：\(text.debugDescription)"
        )
        XCTAssertTrue(text.contains("\\u001B"), "转义要看得见而不是被删掉：\(text)")
    }

    /// 这一态存在（编译器看得见——折回 `.timedOut` 的写法根本构造不出来），它的阶段是
    /// `.spawnFailed` 而不是 `.timedOut`，而生产 switch 里那一次接线由源码钉住。
    /// REVERSE：把那一支的 `.spawnFailed` 改成 `.timedOut` → 分支体两句红；把这一态从
    /// `OneShotOutcome` 删掉（折回 `.spawnFailed`）→ 构造那句编译不过，而同一句源码对照也红。
    func testSubmitRefusedIsItsOwnStateAndRoutesToTheSpawnStage() throws {
        let outcome: SettingsModel.OneShotOutcome = .submitRefused(status: 111, detail: "label exists")
        guard case .submitRefused(let status, let detail) = outcome else {
            return XCTFail("`.submitRefused(status:detail:)` 这一态不在了：拒绝又被折进别的结局")
        }
        XCTAssertEqual(status, 111)
        XCTAssertEqual(detail, "label exists")

        // 四个阶段各一个标识：落错档，机器读到的就是另一件事。
        XCTAssertEqual(PermissionGuide.capabilityIdentifier(.failed(.spawnFailed)), "gp-devtools-failed-spawn")
        XCTAssertNotEqual(
            PermissionGuide.capabilityIdentifier(.failed(.spawnFailed)),
            PermissionGuide.capabilityIdentifier(.failed(.timedOut))
        )

        let text = try settingsSource()
        XCTAssertTrue(
            GP24Source.codeOnly(text).contains("case submitRefused(status: Int32, detail: String)"),
            "`OneShotOutcome` 里那一态的声明不见了（码与 launchctl 的原话都要带在身上）"
        )
        let branch = GP24Source.codeOnly(try XCTUnwrap(
            GP24Source.body(of: text, startsAt: "case .submitRefused(",
                            stoppingAtFirstLineMatching: "^\\s*case \\.timedOut:"),
            "分发那个 switch 里找不到 `.submitRefused` 那一支：这一轮接的那条腿没了"
        ))
        XCTAssertGreaterThanOrEqual(
            branch.split(separator: "\n", omittingEmptySubsequences: true).count, 2,
            "那一支只抠到一句代码：窗口没张对，下面的内容断言不作数"
        )
        XCTAssertTrue(branch.contains("recordProbeFailure(.spawnFailed"), "这一态没落到 `.spawnFailed` 档：\(branch)")
        XCTAssertTrue(
            branch.contains("Self.submitRefusalText(status: status, detail: detail)"),
            "文案没接进来（那一支自己再拼一句就是第二份判据）：\(branch)"
        )
        XCTAssertFalse(branch.contains(".timedOut"), "拒绝那一支又落回超时：\(branch)")
        XCTAssertEqual(
            GP24Source.codeOccurrences(text, "submitRefusalText"), 2,
            "纯函数的声明与它唯一的调用点；第三处代码调用就是第二份文案在漂"
        )
    }

    /// 同一条缺陷的另一半：提交那一趟得**等得到码**。从前那一趟是 fire-and-forget，
    /// 于是一次拒绝只剩"输出文件一直没内容"这一种显形方式——那按构造就是超时。
    /// 正反面判据都只看**代码行**：这一段里"从前这里是 `try? process.run()`"那句是注释，
    /// 拿整段文本去 `contains` 会把注释里描写的旧写法读成现存代码（第一版就是这么红的）。
    /// REVERSE：`runOneShot` 换回 `Process()` + `try? process.run()` → 前四句红；
    /// 只读码不判 `!= 0` → 第二句红；`removeJobLabel` 退回 `try? remover.run()` → 最后一句红。
    func testSubmitLegTravelsThroughTheChannelThatReadsTheExitCode() throws {
        let text = try settingsSource()
        let body = GP24Source.codeOnly(try XCTUnwrap(
            GP24Source.body(of: text, startsAt: "static func runOneShot(",
                            stoppingAtFirstLineMatching: #"^\s*(?:(?:nonisolated|private|public|internal)\s+)*static\s+func\s+removeJobLabel\("#),
            "`runOneShot` 的函数体找不出来：窗口没张对，下面的内容断言不作数"
        ))
        XCTAssertGreaterThanOrEqual(
            body.split(separator: "\n", omittingEmptySubsequences: true).count, 10,
            "`runOneShot` 只抠到 \(body.split(separator: "\n").count) 行代码：窗口没张对，判据不作数"
        )
        XCTAssertTrue(body.contains("ConsoleModel.runDaemonCLI("), "提交那一趟没走带退出码的通道")
        XCTAssertTrue(body.contains("submit.status != 0"), "码落地了却没人判")
        XCTAssertTrue(body.contains("return .submitRefused(status: submit.status, detail: detail)"), body)
        XCTAssertFalse(body.contains("try? process.run()"), "起了就走：一次拒绝只剩「输出文件一直没内容」")
        let cleanup = GP24Source.codeOnly(try XCTUnwrap(
            GP24Source.body(of: text, startsAt: "static func removeJobLabel(",
                            stoppingAtFirstLineMatching: #"^\s*(?:(?:nonisolated|private|public|internal)\s+)+static\s+func\s"#),
            "`removeJobLabel` 不见了：窗口没张对，判据不作数"
        ))
        XCTAssertGreaterThanOrEqual(
            cleanup.split(separator: "\n", omittingEmptySubsequences: true).count, 3,
            "`removeJobLabel` 只抠到一句代码：窗口没张对"
        )
        XCTAssertTrue(cleanup.contains("ConsoleModel.runDaemonCLI("), "清理那一腿也该等得到退出码")
        XCTAssertFalse(cleanup.contains("try? remover.run()"), "留一个没人收的子进程与一次没有读者的失败")
    }
}

// MARK: - 第 7 条：控制台采纳自报状态根之前那道闸

/// `hello` 里的 `stateRoot` 与 `binaryPath` 同一条性质：engine.sock 无 peer 鉴权、同用户即全权，
/// 而这一页把采纳下来的根拿去当自己写入的根（注册表、档案目录、台账都在它下面，`--state-dir`
/// 那侧还会把根 chmod 成 0700）。判据用引擎里那一份（`StateRootArgument.rejection(for:)`），
/// 不在这一侧重抄；拒收时保留上一个根，并把三条写入动作一起拦下。
@MainActor
final class Qoder20261024PanelRefusedStateRootTests: XCTestCase {

    private let probeId = "prj_01M34567890123456789012A"

    /// 只记 argv、什么都不干的桩（与 `ConsoleDaemonStateRootTests` 同一形状）：
    /// 分隔符就是帧边界，没写完的那一段不算一次调用。
    private func makeSpy(dir: String) throws -> (spy: String, argv: String) {
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir)
        let argv = dir + "/argv.txt"
        let spy = dir + "/glasspaned"
        let script = """
        #!/bin/sh
        printf '%s\\n' "$@" >> '\(argv)'
        printf '\\36\\36\\36\\n' >> '\(argv)'
        echo '{}'
        """
        try script.write(toFile: spy, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: spy)
        return (spy, argv)
    }

    private func frames(_ argv: String) -> [[String]] {
        guard let text = try? String(contentsOfFile: argv, encoding: .utf8) else { return [] }
        return text.components(separatedBy: "\u{1e}\n").dropLast().map { chunk in
            chunk.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        }.filter { !$0.isEmpty }
    }

    /// 只数三条写入动作那几种：桩本身若被别的命令（`--evidence-stats`）调用过，不该算这里。
    private func waitForWriteFrames(_ argv: String, within limit: TimeInterval = 2) -> [[String]] {
        let deadline = Date().addingTimeInterval(limit)
        var seen: [[String]] = []
        while Date() < deadline {
            seen = frames(argv).filter {
                $0.contains("--project-prune") || $0.contains("--project-remove")
            }
            if !seen.isEmpty { return seen }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return seen
    }

    /// 桩由 `init` 就接上：于是 `adoptDaemonReport(binaryPath: nil, …)` 不会再触发一次
    /// `--evidence-stats`，"这一页一个字都没动"才数得干净。
    private func makeConsole(dir: String, panelRoot: String, spy: String) -> ConsoleModel {
        ConsoleModel(
            daemonBinaryPath: spy,
            env: ["GLASSPANE_STATE_DIR": panelRoot],
            home: dir + "/fake-home",
            evidenceScanner: { _ in
                ConsoleModel.EvidenceScanOutcome(directoryExists: true, totalBytes: 0, listFailure: nil)
            }
        )
    }

    /// 第 7 条点名的三种坏值（外加两枚同族形状）。每一枚都必须在**采纳之前**被拒、要被点得出名，
    /// 而上一个根要活着："这一帧不可信"不等于"这一页没根了"。
    /// REVERSE：`adoptDaemonReport` 里去掉 `StateRootArgument.rejection(for:)` 那一道（回到无条件
    /// `StateRoot(path:)`）→ 每一枚都红（根被换走、`refusedDaemonStateRoot` 是 nil）；
    /// 把"保留上一个根"改成清空 → `displayedStateRoot` 那一句红。
    func testAdoptRefusesHomeFilesystemRootAndRelativePathsKeepingTheLastGoodRoot() throws {
        let dir = TestSandbox.directory("panel-root-refuse")
        let panelRoot = dir + "/panel-side"
        let goodRoot = dir + "/daemon-side"
        let (spy, argv) = try makeSpy(dir: dir)
        let console = makeConsole(dir: dir, panelRoot: panelRoot, spy: spy)
        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: goodRoot, answered: true)
        XCTAssertEqual(console.displayedStateRoot, goodRoot, "夹具本身要先成立：一个好的根得先被采纳")
        XCTAssertEqual(console.stateRootSource, .daemonReported)

        let home = NSHomeDirectory()
        let bad: [(label: String, value: String)] = [
            ("家目录本身", home),
            ("带尾斜杠的家目录", home + "/"),
            ("文件系统根", "/"),
            ("相对路径", "relative/state-root"),
            ("值的位置上站着另一枚开关", "--state-dir"),
        ]
        for case let (label, value) in bad {
            console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: value, answered: true)
            XCTAssertEqual(console.displayedStateRoot, goodRoot, "\(label)：坏值被采纳成了这一页写入用的根")
            XCTAssertEqual(console.stateRoot.path, goodRoot, "\(label)：`stateRoot` 与展示口径分了家")
            XCTAssertEqual(console.projectsPath, StateRoot(path: goodRoot).projectsFile,
                           "\(label)：注册表路径跟着换走了，删除动的是谁的表")
            XCTAssertEqual(console.evidenceDirectory, StateRoot(path: goodRoot).evidenceDirectory, label)
            XCTAssertEqual(console.approvalsPath, StateRoot(path: goodRoot).approvalsFile, label)
            XCTAssertEqual(console.refusedDaemonStateRoot, value,
                           "\(label)：拒了却没人知道拒的是哪一个值")
            XCTAssertEqual(console.stateRootSource, .daemonReported,
                           "\(label)：一帧被拒的读数不许升格成「这一帧报的根」")
            XCTAssertNotNil(console.writeRootRefusal,
                            "\(label)：手里那个根与服务在写的根已知不同，写入这一道该拦")
        }
        XCTAssertTrue(frames(argv).isEmpty, "拦在根这一道的动作还是跑出去了一次：\(frames(argv))")
    }

    /// 这道闸存在的理由就是这三条写入动作：预览、清理、删除都按这一页显示的根动手。
    /// 上一个被拒的根没清掉时，三条都不许跑，而屏幕上要读到那句拒绝的原文。
    /// REVERSE：删掉三处 `if let refusal = writeRootRefusal` 之一 → 那一句红，且真跑出去一次调用；
    /// 把 `writeRootRefusal` 写成恒 nil → 三条全红。
    func testPreviewPruneAndDeleteAllRefuseToActOnUnclearedRefusedRoot() throws {
        let dir = TestSandbox.directory("panel-root-writes")
        let panelRoot = dir + "/panel-side"
        let goodRoot = dir + "/daemon-side"
        let (spy, argv) = try makeSpy(dir: dir)
        let console = makeConsole(dir: dir, panelRoot: panelRoot, spy: spy)
        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: goodRoot, answered: true)
        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: "/", answered: true)
        let refusal = try XCTUnwrap(console.writeRootRefusal)

        console.previewTestResiduePrune()
        let preview = try XCTUnwrap(console.lastActionMessage)
        console.confirmPrune()
        let prune = try XCTUnwrap(console.lastActionMessage)
        console.removeProject(probeId)
        let remove = try XCTUnwrap(console.lastActionMessage)

        XCTAssertTrue(preview.contains("预览没有执行"), preview)
        XCTAssertTrue(prune.contains("清理没有执行"), prune)
        XCTAssertTrue(remove.contains("删除 \(probeId) 没有执行"), remove)
        for message in [preview, prune, remove] {
            XCTAssertTrue(message.contains(refusal), "三处都在复述同一句原话，不是各写一套：\(message)")
            XCTAssertTrue(message.contains("下一步"), "拦下来要给得动的那一步：\(message)")
        }
        XCTAssertTrue(waitForWriteFrames(argv).isEmpty, "三条写入动作里有一条绕过了根这一道闸")
        XCTAssertFalse(console.isRunningPrune, "拒绝的那一趟还把自己标成在跑：那一枚控件再也不会亮回来")
        XCTAssertTrue(console.prunePreview.isEmpty, "预览被拒却还是把上一帧的清单留在表上")
    }

    /// 同一件事在两扇门上讲同一个故事：侧栏那一行说得出这一页按的是哪个根，也说得出这一帧
    /// 报的根被拒了；写侧的拦截语就是模型里那一句，而不是视图再抄一遍。
    /// REVERSE：`displayedStateRootCaption` 里那段 `if let refused` 删掉 → 前两句红（屏幕上
    /// 一个字也看不出这一帧被拒过）；`writeRootRefusal` 改成语义相近的第二份文案 → 最后两句红。
    func testRefusalIsSpokenInTheSameWordsOnBothFaces() throws {
        let dir = TestSandbox.directory("panel-root-caption")
        let (spy, _) = try makeSpy(dir: dir)
        let console = makeConsole(dir: dir, panelRoot: dir + "/panel-side", spy: spy)
        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: dir + "/good", answered: true)
        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: "/", answered: true)

        let caption = console.displayedStateRootCaption
        XCTAssertTrue(caption.contains("状态根 \(dir + "/good")"),
                      "那一行说的仍是上一个被采纳的根：\(caption)")
        XCTAssertTrue(caption.contains("被这一侧拒了"), caption)
        XCTAssertTrue(caption.contains("这一帧报的根 / 被这一侧拒了"),
                      "被拒的那一枚要点名到侧栏那一行上，而不只是模型里有个值：\(caption)")
        XCTAssertTrue(console.refusedDaemonStateRootCaption.contains("不能被这个面板采用"),
                      console.refusedDaemonStateRootCaption)
        XCTAssertEqual(
            console.writeRootRefusal, console.refusedDaemonStateRootCaption,
            "写侧的拦截语必须就是那一句原话"
        )
        XCTAssertTrue(console.writeRootRefusal!.contains("--state-dir"),
                      "那句话还得给得出下一步（带一个专用目录重启）：\(console.writeRootRefusal!)")
    }

    /// 不是一次性闩：下一帧报了一个专用目录就照常采纳、拒迹清空、写入动作恢复。
    /// 少了这半条，"拒绝"与"把这一页永久做死"在测试里长得一模一样。
    /// REVERSE：删掉 `refusedDaemonStateRoot = nil` 那一行 → 第二、三句红（一次坏帧拦死这一页）。
    func testAGoodFrameAfterTheRefusalClearsItAndUnblocksWrites() throws {
        let dir = TestSandbox.directory("panel-root-recover")
        let panelRoot = dir + "/panel-side"
        let goodRoot = dir + "/daemon-side"
        let betterRoot = dir + "/daemon-side-two"
        let (spy, argv) = try makeSpy(dir: dir)
        let console = makeConsole(dir: dir, panelRoot: panelRoot, spy: spy)
        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: goodRoot, answered: true)
        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: "not/absolute", answered: true)
        XCTAssertNotNil(console.writeRootRefusal)

        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: betterRoot, answered: true)
        XCTAssertEqual(console.displayedStateRoot, betterRoot, "好的那一帧仍要采纳：这道闸不是「什么都不收」")
        XCTAssertNil(console.refusedDaemonStateRoot, "上一帧的拒没清掉，这一页再也做不动任何写入")
        XCTAssertNil(console.writeRootRefusal)
        XCTAssertEqual(console.stateRootSource, .daemonReported)

        console.removeProject(probeId)
        let ran = waitForWriteFrames(argv)
        XCTAssertEqual(ran.count, 1, "\(ran)")
        let firstFrame: [String] = ran.first ?? []
        let head: [String] = Array(firstFrame.prefix(4))
        XCTAssertEqual(head, ["--state-dir", betterRoot, "--project-remove", probeId],
                       "恢复之后动的手要点名刚被采纳的那个根：\(ran.first ?? [])")

        // 报过又断了（旧 daemon 不带这个键）：路径留着、出处降级，且不凭空造一次拒绝。
        console.adoptDaemonReport(binaryPath: nil, daemonStateRoot: nil, answered: true)
        XCTAssertEqual(console.stateRootSource, .daemonReportedEarlier)
        XCTAssertEqual(console.displayedStateRoot, betterRoot)
        XCTAssertNil(console.refusedDaemonStateRoot)
    }

    /// 判据不重抄：面板问的就是 `--state-dir` 在 daemon 参数上用的那一个函数。
    /// REVERSE：在这一侧另写一份（例如只判 `== "/"`）→ 源码对照那句红（只剩一处调用），
    /// 而第一条里 home 那一枚会被采纳；把 `writeRootRefusal` 挪进视图 → 第二句红。
    func testThePanelAsksTheEnginesOwnPredicateInsteadOfRecopyingTheRule() throws {
        let home = NSHomeDirectory()
        for value in ["/", home, home + "/", "relative/path", "--state-dir", ""] {
            XCTAssertNotNil(
                StateRootArgument.rejection(for: value),
                "判据本身说得出这一枚不行，面板却可能收下了：\(value.debugDescription)"
            )
        }
        XCTAssertNil(StateRootArgument.rejection(for: TestSandbox.directory("panel-root-accepted")))

        let source = try GP24Source.read("engine/Sources/glasspane-settings/ConsoleModel.swift")
        XCTAssertEqual(
            GP24Source.codeOccurrences(source, "StateRootArgument.rejection(for:"), 2,
            "采纳那一道与 `refusedDaemonStateRootCaption` 那一处共用引擎里那一份判据：重抄一处就漂两份"
        )
        XCTAssertEqual(GP24Source.codeOccurrences(source, "writeRootRefusal"), 4,
                       "一道闸与三处调用点：少一个调用点就是半修（读新根、删旧根）")
    }
}
