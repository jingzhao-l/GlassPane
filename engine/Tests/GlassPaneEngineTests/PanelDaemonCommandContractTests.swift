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
            guard line.contains("runDaemonCLI") || line.contains("arguments:") else { continue }
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
}

private extension Sequence where Element: Hashable {
    func uniqueed() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}
