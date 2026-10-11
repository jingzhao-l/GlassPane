import XCTest

/// 面板 → daemon 的命令行契约闸。
///
/// 这条闸存在的原因是一次真实的静默失效：`ConsoleModel` 一直在调
/// `glasspaned --project-prune` 与 `--project-remove`，而 daemon 的参数表里
/// **从来没有这两个开关**（它们在 479a11c 之后被拿掉了）。进程照样起得来，
/// 回一句 `unknown argument` + 退出码 64，面板把那段帮助文本读成 `matched = 0`，
/// 于是当着一屏"N 条注册项指向系统临时目录"回一句"没有需要清理的测试残留项目"。
/// 两边各自看都合理：面板的测试测的是消息折算，daemon 的测试测的是它自己解析的那些。
/// 缺的是有人把两张表对在一起。
///
/// 判据形状抄 `mcp-shell/test/tools.test.mjs` 的 `daemonCliFlags()`——同一仓里
/// 已经认这个办法：从源码里把开关名抠出来对照，而不是信任何一方的自述。
final class PanelDaemonCommandContractTests: XCTestCase {

    /// 仓库根：测试文件在 `engine/Tests/GlassPaneEngineTests/` 下。
    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        // …/engine/Tests/GlassPaneEngineTests/<this>.swift → 上溯四级到仓库根
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        url.deleteLastPathComponent()
        return url.path
    }

    private func read(_ relative: String) throws -> String {
        let path = repoRoot + "/" + relative
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(relative)；这一条对照在没有该文件的环境里不作数")
        }
        return text
    }

    /// 按正则把捕获组 1 抠出来（跨语言对照用的就是这个最笨的办法：只信源码文本）。
    private func captures(_ pattern: String, in source: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            XCTFail("正则写坏了：\(pattern)")
            return []
        }
        let range = NSRange(source.startIndex..<source.endIndex, in: source)
        var out: [String] = []
        regex.enumerateMatches(in: source, range: range) { match, _, _ in
            guard let match, match.numberOfRanges > 1,
                  let group = Range(match.range(at: 1), in: source) else { return }
            out.append(String(source[group]))
        }
        return out
    }

    /// daemon 真正解析的开关集合。
    private func daemonFlags() throws -> Set<String> {
        let source = try read("engine/Sources/glasspaned/main.swift")
        let flags = Set(captures(#"case\s+"(--[a-z][a-z0-9-]*)""#, in: source))
        // 反向闸：解析本身也要能被证伪。抠不出至少这么多开关，说明源码写法变了、
        // 这条对照已经在看不到东西的地方——那必须炸，不许静默"全通过"。
        XCTAssertGreaterThanOrEqual(flags.count, 20,
            "只解析出 \(flags.count) 个 daemon 开关，这条契约闸已经不作数了")
        return flags
    }

    /// 面板实际发给 daemon 的开关。
    private func panelInvocations() throws -> [(flag: String, line: Int)] {
        let source = try read("engine/Sources/glasspane-settings/ConsoleModel.swift")
        var found: [(String, Int)] = []
        for (offset, lineText) in source.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            let line = String(lineText)
            // argv 现在由 `daemonCLIArguments(_:stateRoot:)` 组装，开关字面量因此落在
            // 那一行而不是 `arguments:` 那一行——提取器跟着走，否则这条闸会看不见东西
            // （它自己会报"一个都没抠出来"，这一轮就是这么被抓出来的）。
            guard line.contains("runDaemonCLI") || line.contains("arguments:")
                || line.contains("daemonCLIArguments(") else { continue }
            for flag in captures(#""(--[a-z][a-z0-9-]*)""#, in: line) {
                found.append((flag, offset + 1))
            }
        }
        XCTAssertGreaterThanOrEqual(found.count, 2,
            "面板里一个 daemon 开关都没抠出来（找到 \(found.count) 个），这条契约闸已经不作数了")
        return found
    }

    /// 面板发出的每一条一次性 daemon 命令，都必须是 daemon 参数表真解析的开关。
    func testEveryDaemonFlagThePanelNamesIsOneTheDaemonParses() throws {
        let parsed = try daemonFlags()
        let invoked = try panelInvocations()
        let unknown = invoked.filter { !parsed.contains($0.flag) }
        XCTAssertEqual(unknown.map { $0.flag }.sorted().uniqueed(), [],
            "面板会拿到 `unknown argument` + 退出码 64，并把它折算成一句报平安的话："
            + unknown.map { "\($0.flag) (ConsoleModel.swift:\($0.line))" }.joined(separator: ", "))
    }

    /// 正向的一半：写入面确实还在用这两条命令。若哪天面板不再调它们，
    /// 上面那条闸会因为"什么都没见过"而空转，所以这里把调用本身也钉住。
    func testWriteSurfaceStillGoesThroughTheDaemonCLI() throws {
        let parsed = try daemonFlags()
        for flag in ["--project-prune", "--project-remove"] {
            XCTAssertTrue(parsed.contains(flag), "daemon 不再解析 \(flag) 了，而面板的清理/删除按钮依赖它")
        }
        let invoked = Set(try panelInvocations().map { $0.flag })
        XCTAssertTrue(invoked.contains("--project-prune"), "面板不再调 --project-prune：清理按钮成了死的")
        XCTAssertTrue(invoked.contains("--project-remove"), "面板不再调 --project-remove：删除按钮成了死的")
    }

    /// 「档案读不了」这件事在两侧必须用**同一个键名**说话。
    ///
    /// 面板的统计卡与档案列表页读的是 daemon `--evidence-stats` 回的那个
    /// `listFailure`；引擎侧 `EvidenceArchiveScan.listFailure` 是同一个意思的第二个
    /// 出处。自己拼一个别名（`list_failed`、`listingError`…）就等于两侧各自判读，
    /// 而"读不出条数"最终又会被折成"档案目录是空的"。这条闸只认源码文本。
    func testTheUnreadableArchiveKeyIsSpelledTheSameOnBothSides() throws {
        let daemon = try read("engine/Sources/glasspaned/main.swift")
        XCTAssertTrue(daemon.contains("\"listFailure\""),
                      "daemon 不再用 listFailure 报「档案读不了」了，而面板还在读这个键")
        let engine = try read("engine/Sources/GlassPaneEngine/LocalArchive.swift")
        XCTAssertTrue(engine.contains("listFailure"),
                      "引擎侧扫描结果丢了 listFailure：面板这一侧就只能把没看过说成没有")

        for panel in ["engine/Sources/glasspane-settings/ConsoleModel.swift",
                      "engine/Sources/glasspane-settings/EvidenceStatsView.swift"] {
            let source = try read(panel)
            XCTAssertTrue(source.contains("listFailure"), "\(panel) 不再读这个键：读不了会掉回空档案那一支")
        }
        // 反向的一半：不许有人在这里给同一个意思起第二个名字。
        let aliases = ["listFailed", "list_failed", "listingError", "listError", "readFailure"]
        let settings = try read("engine/Sources/glasspane-settings/ConsoleModel.swift")
        for alias in aliases {
            XCTAssertFalse(settings.contains(alias), "面板给同一个字段起了别名 \(alias)：两侧就不再是同一件事")
        }
    }

    /// 面板问统计时发的是 daemon 真解析的那条命令，而不是自己扫一份冒充 daemon 的数。
    func testStatsComesFromTheDaemonCommandItParses() throws {
        let parsed = try daemonFlags()
        XCTAssertTrue(parsed.contains("--evidence-stats"), "daemon 不再解析 --evidence-stats 了")
        let invoked = Set(try panelInvocations().map { $0.flag })
        XCTAssertTrue(invoked.contains("--evidence-stats"),
                      "面板不再向后台服务要统计：那一栏的数字就没有了来源，只能靠本地扫一份冒充")
    }
    /// 每一条一次性 daemon 命令都必须带着**面板自己认的那个根**。
    ///
    /// 从前这三处递的是裸数组（`arguments: ["--project-prune"]`），daemon 于是按它自己的
    /// 家目录默认根解析——面板显示一个根，点"清理/删除"改的却是另一个根里的真注册表。
    ///
    /// 判据原来写死 `== 3`。那是把"当前有几条命令"当成了不变量：2026-10-11 清理预览也改成
    /// 经 daemon 干一次 `--project-prune --dry-run`（第四处，带根，正确行为），这条闸就红了
    /// ——数字变了而规则没变。现在数的是**关系**：每个 `runDaemonCLI` 调用点都要有一次
    /// `daemonCLIArguments` 组装，且每一次组装都显式点名根；条数只留下限（≥3），
    /// 裸数组仍一处都不许留。加一条不带根的调用 ⇒ 组装次数与调用次数不等，红。
    func testEveryConsoleCommandCarriesThePanelsOwnStateRoot() throws {
        let source = try read("engine/Sources/glasspane-settings/ConsoleModel.swift")
        let calls = captures(#"(ConsoleModel\.runDaemonCLI\(binary:)"#, in: source)
        // 数调用点而不是函数名：`daemonCLIArguments` 的定义行也含那个名字，
        // 把它算进"组装次数"会让计数比调用点多一，于是这条闸永远只能靠写死数字过。
        let built = captures(#"(ConsoleModel\.daemonCLIArguments\()"#, in: source)
        let withRoot = captures(#"(stateRoot: stateRoot\.path\))"#, in: source)
        XCTAssertGreaterThanOrEqual(calls.count, 3,
            "只找到 \(calls.count) 处 daemon 一次性调用，这条闸已经在看不到东西的地方")
        XCTAssertGreaterThanOrEqual(built.count, 3,
            "只有 \(built.count) 处经 daemonCLIArguments 组装，低于已知的三条")
        XCTAssertEqual(built.count, calls.count,
            "有 \(calls.count) 处一次性调用却只有 \(built.count) 处组装：多出来的那一支不点名状态根，"
            + "就会在家目录默认根上执行")
        XCTAssertEqual(withRoot.count, built.count,
            "\(built.count) 处组装里只有 \(withRoot.count) 处显式带上面板认的状态根")
        XCTAssertFalse(source.contains("arguments: [\"--"),
            "还有一处把开关数组直接递给 daemon——它会在家目录默认根上执行")
    }

}

private extension Sequence where Element: Hashable {
    func uniqueed() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }



}
