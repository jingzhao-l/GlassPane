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

    /// 解析表与 usage 必须互逆：只在一侧出现的开关，一边是"能用但没人知道"，
    /// 另一边是"说了却用不了"（后者会回 unknown argument + 64）。
    func testParsedFlagsAndUsageTextListTheSameFlags() throws {
        let path = repoRoot + "/engine/Sources/glasspaned/main.swift"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 main.swift；这一条对照不作数")
        }
        let parsed = capture(#"case\s+"(--[a-z][a-z0-9-]*)""#, in: text)
        XCTAssertGreaterThanOrEqual(parsed.count, 30,
            "只解析出 \(parsed.count) 个开关，这条闸已经看不见东西")
        let documented = capture(#"(--[a-z][a-z0-9-]+)"#, in: usageBlock(text))
        XCTAssertFalse(documented.isEmpty, "usage 里一个开关都没抠出来，这条闸已经不作数了")
        let undocumented = parsed.subtracting(documented).sorted()
        let unparseable = documented.subtracting(parsed).sorted()
        XCTAssertEqual(undocumented, [], "这些开关能用但 --help 没说：\(undocumented.joined(separator: " "))")
        XCTAssertEqual(unparseable, [], "这些开关 --help 说了但 daemon 不认（回 unknown argument + 64）：\(unparseable.joined(separator: " "))")
    }

    /// usage 是 `printUsage()` 里那段三引号字符串。
    private func usageBlock(_ text: String) -> String {
        guard let start = text.range(of: "private func printUsage()"),
              let open = text.range(of: "\"\"\"", range: start.upperBound..<text.endIndex),
              let close = text.range(of: "\"\"\"", range: open.upperBound..<text.endIndex) else {
            XCTFail("找不到 printUsage 的字符串块，这条对照已不作数")
            return ""
        }
        return String(text[open.upperBound..<close.lowerBound])
    }

    private func capture(_ pattern: String, in source: String) -> Set<String> {
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            XCTFail("正则写坏了：\(pattern)")
            return []
        }
        var out: Set<String> = []
        regex.enumerateMatches(in: source, range: NSRange(source.startIndex..., in: source)) { match, _, _ in
            guard let match, match.numberOfRanges > 1,
                  let group = Range(match.range(at: 1), in: source) else { return }
            out.insert(String(source[group]))
        }
        return out
    }
}
