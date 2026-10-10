import XCTest
@testable import GlassPaneEngine

/// `glasspaned --version` 这一条读数的来历与它的对称性闸。
///
/// 更新器把自己看到的版本交代成"两读数必须一致"（`updater/lib/version.js` 的表头就这么写）：
/// 一份是 bundle 的 `CFBundleShortVersionString`，另一份是 `glasspaned --version`。
/// 1.9.0 之前后者**从来不存在**——`grep -n '"--version"' engine/Sources` 零命中，真机上
/// `glasspaned --version` 回的是 `unknown argument` + usage 加退出码 64。也就是说那条
/// "pairing" 一直只有一条腿是活的，而更新器的测试用一个**对任何参数都 echo 版本号**的
/// shell 桩把它假装出来了（`updater/test/helpers.mjs` 的 `makeDaemonBinary`）。桩里跑过的
/// 守卫等于没验：这道缺口因此从来没红过。
///
/// 这里补两样：真的起一次真二进制核那句话，以及一张"解析表与 usage 必须互逆"的对称性闸
/// ——同一个文件里已经栽过两次（`--help` 把 `--permissions` 说成 daemon 自报快照；
/// `--check-developer-tools` 这类开关只在一侧出现）。
final class DaemonVersionFlagTests: XCTestCase {

    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        return url.path
    }

    /// debug 产物：CI 的 `swift` job 是 `swift build` → `swift test`，所以它在；
    /// 真的不在时按**声明的跳过**处理，不许默默通过（本仓的规矩是 skip 要写清理由）。
    private var daemonBinary: String { repoRoot + "/engine/.build/debug/glasspaned" }

    private func spawn(_ arguments: [String]) throws -> (status: Int32, output: String) {
        guard FileManager.default.isExecutableFile(atPath: daemonBinary) else {
            throw XCTSkip("没有 \(daemonBinary)；这一条要的是真二进制的行为，跑不了就先明说跑不了"
                + "（produce it with: cd engine && swift build）")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: daemonBinary)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    /// 一句话、退出码 0，而且报的就是 `hello` 里那个字面量。
    func testVersionFlagPrintsTheSameLiteralHelloReports() throws {
        let outcome = try spawn(["--version"])
        XCTAssertEqual(outcome.status, 0, "--version 应当正常退出，实际输出：\(outcome.output)")
        XCTAssertEqual(outcome.output.trimmingCharacters(in: .whitespacesAndNewlines),
                       "glasspaned \(EngineCore.buildVersion)",
                       "自报的版本必须与 hello 同源，不是第三处字面量")
    }

    /// `--version` 不读状态：它既不该建状态根，也不该触发那次收紧扫描。
    func testVersionFlagTouchesNoStateRoot() throws {
        // 地点走 `TestSandbox`——本仓的隔离闸（`TestIsolationGateTests`）把测试自己手拼
        // 临时目录记成一条违规。这里必须是 `pendingDirectory` 而不是 `directory`：后者会
        // 把目录**建好**再交出来，那"daemon 有没有创建状态根"就永远只有一个答案，
        // 而且是夹具给的答案，不是被测代码给的。
        let rootPath = TestSandbox.pendingDirectory("version-no-state")
        XCTAssertFalse(FileManager.default.fileExists(atPath: rootPath),
            "夹具自己把状态根建出来了，这条断言从此只会重复夹具的话")
        let outcome = try spawn(["--state-dir", rootPath, "--version"])
        XCTAssertEqual(outcome.status, 0, outcome.output)
        XCTAssertFalse(FileManager.default.fileExists(atPath: rootPath),
            "只报一个版本号的调用不该把状态根创建出来（更不该顺手 chmod 别人的目录）")
    }

    /// 版本字面量只有一处：实例属性转读 static，别处再抄一份字符串就是漂移。
    func testVersionLiteralIsSingleSourced() throws {
        let path = repoRoot + "/engine/Sources/GlassPaneEngine/EngineCore.swift"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 EngineCore.swift；这一条在没有该文件的环境里不作数")
        }
        let literal = try? NSRegularExpression(pattern: "static let buildVersion = \"[0-9.]+\"")
        let hits = literal?.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text)) ?? 0
        XCTAssertEqual(hits, 1, "版本字面量应当恰好一处（供位点表改写），实际 \(hits) 处")
        XCTAssertTrue(text.contains("public let version = EngineCore.buildVersion"),
                      "实例属性又开始自带一份字符串了：hello 与 --version 会各说各话")
        // 位点表必须还认这一行：认不上的话 `set-version` 会静默漏改这一处。
        let sites = repoRoot + "/scripts/version-sites.mjs"
        guard let table = try? String(contentsOfFile: sites, encoding: .utf8) else {
            throw XCTSkip("读不到 scripts/version-sites.mjs")
        }
        XCTAssertTrue(table.contains("public static let buildVersion = \""),
                      "daemon 位点的正则不再指向那一行——下一次 set-version 会悄悄漏改这个位点")
    }

    /// 解析表、usage 与文件头注释块必须互逆：只在一侧出现的开关，一边是"能用但没人知道"，
    /// 另一边是"说了却用不了"（后者会回 unknown argument + 64）。
    ///
    /// 三张列表，不是两张。文件头那截 `/// Usage:` 注释从前根本没进这条闸，而它是
    /// 读代码的人（和复审）第一个看到的开关表——它漏了 `--version`、`--no-c33`、
    /// `--force-socket`、`--recipe-validate`、`--check-input-permission` 五处而一直没人
    /// 发现，正是"闸只数两张表"的代价。短形态 `-v` 同理：旧的正则只认 `--[a-z][a-z0-9-]+`，
    /// 一个字母的开关对这条闸**结构性不可见**，于是 `-v` 能用、`--help` 从不提它，闸还
    /// 一直是绿的。抽取规则现在收 `-{1,2}` 两种形态，三张表逐对比较，并且由
    /// `testTheParityGateReportsAFlagMissingFromOneList` 拿合成源码把每一条拒绝分支跑一遍。
    func testParsedFlagsAndUsageTextListTheSameFlags() throws {
        let path = repoRoot + "/engine/Sources/glasspaned/main.swift"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 main.swift；这一条对照不作数")
        }
        let parsed = DaemonFlagParity.parsedFlags(text)
        XCTAssertGreaterThanOrEqual(parsed.count, 30,
            "只解析出 \(parsed.count) 个开关，这条闸已经看不见东西")
        let documented = DaemonFlagParity.usageFlags(text)
        XCTAssertFalse(documented.isEmpty, "usage 里一个开关都没抠出来，这条闸已经不作数了")
        XCTAssertGreaterThanOrEqual(documented.count, 30,
            "usage 只抠出 \(documented.count) 个开关，短形态八成是被正则丢掉了")
        let header = DaemonFlagParity.headerFlags(text)
        XCTAssertFalse(header.isEmpty, "文件头注释块里一个开关都没抠出来，这张表已经不在闸的视野里了")

        let undocumented = parsed.subtracting(documented).sorted()
        let unparseable = documented.subtracting(parsed).sorted()
        XCTAssertEqual(undocumented, [], "这些开关能用但 --help 没说：\(undocumented.joined(separator: " "))")
        XCTAssertEqual(unparseable, [], "这些开关 --help 说了但 daemon 不认（回 unknown argument + 64）：\(unparseable.joined(separator: " "))")
        let headerMissing = parsed.subtracting(header).sorted()
        let headerInvented = header.subtracting(parsed).sorted()
        XCTAssertEqual(headerMissing, [], "这些开关 daemon 认，但文件头的开关表没列（读代码的人只会信那张表）：\(headerMissing.joined(separator: " "))")
        XCTAssertEqual(headerInvented, [], "文件头那注释块说了这些开关，而解析表里根本没有：\(headerInvented.joined(separator: " "))")
        // 三条差集都空才算互逆；把这条留着，是为了上面四行被人删掉其中一行时还有声音。
        XCTAssertEqual(DaemonFlagParity.differences(text), [], "开关表三张对不上（见上面逐条断言的措辞）")
    }

    /// 拒绝分支必须真的会拒绝：这条闸的判据被喂进合成源码，缺一张表就得红。
    /// 本仓的规矩是"跑不到拒绝分支的闸不是闸"（见 `TestIsolationGateTests`），
    /// 三张表的抽取规则都在这里各跑一次"只在一侧"的形态。
    func testTheParityGateReportsAFlagMissingFromOneList() throws {
        // 一张"本来互逆"的最小源码：一个长开关 + 一个短开关，三张表都列全。
        let whole = DaemonFlagParity.syntheticMain(
            parsed: ["--recipe-validate", "--verbose", "-v"],
            usage: ["--recipe-validate <path>", "--verbose", "-v"],
            header: ["--recipe-validate", "--verbose", "-v"]
        )
        XCTAssertEqual(DaemonFlagParity.differences(whole), [], "合成夹具自己都不互逆，下面的断言就全是假的")

        // (1) 解析表里有、usage 没有 —— 就是 `-v` 当初的形状。
        let missingFromUsage = DaemonFlagParity.syntheticMain(
            parsed: ["--recipe-validate", "--verbose", "-v"],
            usage: ["--recipe-validate <path>", "--verbose"],
            header: ["--recipe-validate", "--verbose", "-v"]
        )
        XCTAssertTrue(
            DaemonFlagParity.differences(missingFromUsage).contains { $0.contains("-v") },
            "短开关只写在解析表里时这条闸必须报它（旧的正则根本看不见它）：\(DaemonFlagParity.differences(missingFromUsage))")

        // (2) usage 里有、解析表没有 —— 用户会拿到 unknown argument + 64。
        let missingFromParser = DaemonFlagParity.syntheticMain(
            parsed: ["--recipe-validate", "--verbose"],
            usage: ["--recipe-validate <path>", "--verbose", "-v"],
            header: ["--recipe-validate", "--verbose", "-v"]
        )
        XCTAssertTrue(
            DaemonFlagParity.differences(missingFromParser).contains { $0.contains("-v") },
            "usage 说了 `-v` 而解析表不认时必须有声音：\(DaemonFlagParity.differences(missingFromParser))")

        // (3) 文件头那张表漏一个 —— 五处漏报就是这么攒起来的。
        let missingFromHeader = DaemonFlagParity.syntheticMain(
            parsed: ["--recipe-validate", "--verbose", "-v"],
            usage: ["--recipe-validate <path>", "--verbose", "-v"],
            header: ["--verbose", "-v"]
        )
        XCTAssertTrue(
            DaemonFlagParity.differences(missingFromHeader).contains { $0.contains("--recipe-validate") },
            "文件头注释块漏列开关时必须报它：\(DaemonFlagParity.differences(missingFromHeader))")

        // (4) 抽取规则必须只认开关，别把注释里的破折号当成 `-x` 开关：真是那样的话
        // 这张闸会红在一句散文上，而读者的第一反应是改散文。
        let prose = DaemonFlagParity.syntheticMain(
            parsed: ["--verbose", "-v"],
            usage: ["--verbose", "-v", "(no-op when already granted)"],
            header: ["--verbose", "-v"]
        )
        XCTAssertEqual(DaemonFlagParity.differences(prose), [],
                       "散文里的 `no-op` 不该被当成一个叫 `-o` 的开关")
        XCTAssertFalse(DaemonFlagParity.usageFlags(prose).contains("-o"),
                       "短形态的抽取正则吃进了散文里的连字符")

        // (5) 解析表只数 `case "…"` 那一行的字面量，别把 usage 散文里的开关也算成
        // "daemon 认的开关"（否则 `--help` 说的话就永远查不出错）。
        XCTAssertEqual(
            DaemonFlagParity.parsedFlags(missingFromHeader).count, 3,
            "解析表应当只来自 `case` 标签，实得 \(DaemonFlagParity.parsedFlags(missingFromHeader))")
    }
}

/// `DaemonVersionFlagTests` 的抽取规则，单独成一个类型而不是留在测试类里：
/// 同一段代码既要跑真文件（`testParsedFlagsAndUsageTextListTheSameFlags`），
/// 也要跑合成源码（`testTheParityGateReportsAFlagMissingFromOneList`）。
/// 闸的"能拒绝"只有第二种跑法能证明，而两种跑法必须共用判据，否则证的是另一件事。
enum DaemonFlagParity {

    /// 解析表：`parseArguments` 里 `case "…":` 的字符串字面量，长短线都要收。
    /// 旧实现的正则是 `case\s+"(--[a-z][a-z0-9-]*)"`，一个字母的短形态对它是
    /// 结构性不可见的；按行取字面量再筛形状，`case "--help", "-h":` 的两个都能拿到。
    static func parsedFlags(_ source: String) -> Set<String> {
        var out: Set<String> = []
        for line in source.components(separatedBy: "\n") {
            let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
            guard trimmed.hasPrefix("case ") else { continue }
            for literal in capture("\"([^\"]+)\"", in: line) {
                if fullMatch("^-{1,2}[a-z][a-z0-9-]*$", in: literal) { out.insert(literal) }
            }
        }
        return out
    }

    /// `printUsage()` 那段三引号文本里的开关（长 + 短）。
    static func usageFlags(_ source: String) -> Set<String> {
        flagsIn(usageBlock(source))
    }

    /// 文件头那截 `///` 注释块里的开关（长 + 短）——读代码的人第一个看到的表。
    static func headerFlags(_ source: String) -> Set<String> {
        let marker = "private struct Options"
        let head = source.range(of: marker).map { String(source[..<$0.lowerBound]) } ?? source
        let comments = head.components(separatedBy: "\n")
            .filter { $0.drop(while: { $0 == " " || $0 == "\t" }).hasPrefix("///") }
            .joined(separator: "\n")
        return flagsIn(comments)
    }

    /// 三张表的逐对差集，带说明文字；空集就是互逆。
    static func differences(_ source: String) -> [String] {
        let parsed = parsedFlags(source)
        let usage = usageFlags(source)
        let header = headerFlags(source)
        var out: [String] = []
        for flag in parsed.subtracting(usage).sorted() { out.append("解析表有、usage 没有: \(flag)") }
        for flag in usage.subtracting(parsed).sorted() { out.append("usage 有、解析表没有: \(flag)") }
        for flag in parsed.subtracting(header).sorted() { out.append("解析表有、文件头注释块没有: \(flag)") }
        for flag in header.subtracting(parsed).sorted() { out.append("文件头注释块有、解析表没有: \(flag)") }
        return out
    }

    /// 合成一份"三张表"的最小 main.swift，给拒绝分支用。
    static func syntheticMain(parsed: [String], usage: [String], header: [String]) -> String {
        var text = ""
        for flag in header { text += "///   \(flag)\n" }
        text += "\nprivate struct Options {\n}\n"
        for flag in parsed { text += "    case \"\(flag)\":\n        break\n" }
        text += "\nprivate func printUsage() {\n    let usage = \"\"\"\n"
        for flag in usage { text += "        \(flag)\n" }
        text += "    \"\"\"\n}\n"
        return text
    }

    // MARK: - Shared extraction

    /// 一段文本里的开关集合：长形态按 `--x-y` 抓，短形态只认"一个字母、自成词"的
    /// `-x`——散文里的连字符（`no-op`、`per-user`）不是开关，抓进来这张闸就会红在
    /// 说明文字上。
    private static func flagsIn(_ text: String) -> Set<String> {
        var out = Set(capture("(--[a-z][a-z0-9-]+)", in: text))
        for letter in capture("(?:^|[\\s(])-([a-z])(?=[\\s,)\\]]|$)", in: text) {
            out.insert("-" + letter)
        }
        return out
    }

    /// `printUsage()` 里那段三引号字符串。
    private static func usageBlock(_ text: String) -> String {
        guard let start = text.range(of: "private func printUsage()"),
              let open = text.range(of: "\"\"\"", range: start.upperBound..<text.endIndex),
              let close = text.range(of: "\"\"\"", range: open.upperBound..<text.endIndex) else {
            return ""
        }
        return String(text[open.upperBound..<close.lowerBound])
    }

    private static func capture(_ pattern: String, in source: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        var out: [String] = []
        regex.enumerateMatches(in: source, range: NSRange(source.startIndex..., in: source)) { match, _, _ in
            guard let match, match.numberOfRanges > 1,
                  let group = Range(match.range(at: 1), in: source) else { return }
            out.append(String(source[group]))
        }
        return out
    }

    private static func fullMatch(_ pattern: String, in text: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
        return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}
