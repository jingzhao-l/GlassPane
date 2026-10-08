import XCTest
@testable import GlassPaneEngine

/// 一次性 daemon CLI 报"注册表"时那两句判据的归属闸。
///
/// 立这一条的原因是一次**假清白**：`glasspaned --list-projects` 在 projects.json
/// 读不开时照样回 `[]` 加退出码 0，而 agent 正是被这条命令指来回答"这台机器注册了
/// 什么"（mcp-shell 的 remedy 原文点名它）——把"读不出"报成"什么都没注册"，下一步就
/// 是照着一份空表重建登记，而真条目还在文件里。`--project-remove` 是同一种病的第二处：
/// 写完之后重读，重读失败时 `all` 是空的，于是 `!all.contains(…)` 恒为真，命令便在
/// "根本看不见盘"的情况下报 `removed: true` 并退 0。两处的判据从前都长在 main.swift 里，
/// 而 main.swift 是 executable target、单测摸不到，所以这里把判据挪进
/// `ProjectRegistry`（可单测），再用两条源码形状闸钉住 daemon 确实调了它——否则
/// "测过的判据"和"跑着的判据"又是两张皮，这正是本仓反复拒绝的形状。
final class RegistryVerdictTests: XCTestCase {

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


    /// 注释先剥掉再扫：本仓的注释里写满了"从前那句错的写法"长什么样（正是被撤销的
    /// 那次修复的形状），带注释扫负向断言会红在自己的说明上，而人的第一反应会是删注释。
    private func codeOnly(_ source: String) -> String {
        var out = source
        while let open = out.range(of: "/*") {
            guard let close = out.range(of: "*/", range: open.upperBound..<out.endIndex) else { break }
            out.removeSubrange(open.lowerBound..<close.upperBound)
        }
        return out
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { line in
                let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
                return !trimmed.hasPrefix("//")
            }
            .joined(separator: "\n")
    }

    // MARK: - 判据本体

    /// `[]` 与"读不开"必须分得开：这是整条闸的全部理由。
    func testListingSeparatesAnEmptyTableFromAnUnreadableFile() throws {
        let emptyPath = TestSandbox.filePath("registry-empty")
        let brokenPath = TestSandbox.filePath("registry-broken")
        defer {
            try? FileManager.default.removeItem(atPath: emptyPath)
            try? FileManager.default.removeItem(atPath: brokenPath)
        }
        try Data("[]\n".utf8).write(to: URL(fileURLWithPath: emptyPath))
        // 一份**合法 JSON**、却不是项目数组的文件：真机上报的就是这一类（手改过、
        // 或别的进程把同名文件当缓存写了）。
        try Data("{\"not\":\"a list\"}\n".utf8).write(to: URL(fileURLWithPath: brokenPath))

        switch ProjectRegistry(filePath: emptyPath).listing() {
        case .registered(let entries):
            XCTAssertEqual(entries.count, 0)
        case .unreadable(let reason):
            XCTFail("一份合法的空表被说成读不开：\(reason)")
        }

        switch ProjectRegistry(filePath: brokenPath).listing() {
        case .registered(let entries):
            XCTFail("读不开的文件被当成\"注册了 \(entries.count) 项\"报出去，退出码还是 0")
        case .unreadable(let reason):
            XCTAssertTrue(reason.contains(brokenPath), "拒绝的话得点名是哪份文件：\(reason)")
        }
    }

    /// 反向的那一半：重读失败时**不许**回答 `removed`。这条用例就是原来那个假成功
    /// ——读不开时 `all` 为空，旧写法恒判"已经删掉了"。
    func testRemovalVerdictRefusesToAnswerWhenTheReadBackIsUnreadable() throws {
        let path = TestSandbox.filePath("registry-remove-unreadable")
        defer { try? FileManager.default.removeItem(atPath: path) }
        try Data("{\"not\":\"a list\"}\n".utf8).write(to: URL(fileURLWithPath: path))

        let registry = ProjectRegistry(filePath: path)
        XCTAssertTrue(registry.loadFailed)
        XCTAssertTrue(registry.all.isEmpty, "先确认前提：读不开时 all 是空的，所以旧写法必然报成功")
        let verdict = registry.removalVerdict(projectId: "prj_ANY")
        XCTAssertFalse(verdict.answerable, "看不见盘就不许回答")
        XCTAssertFalse(verdict.removed, "removed: true 在这里是一次凭\"空\"编出来的成功")
    }

    /// 对照必须能红也得能过：盘上真的没有它 / 还在，两个答案要分开。
    func testRemovalVerdictAnswersFromWhatTheDiskActuallyHolds() throws {
        let path = TestSandbox.filePath("registry-remove-answerable")
        defer { try? FileManager.default.removeItem(atPath: path) }

        let registry = ProjectRegistry(filePath: path)
        let entry = try registry.create(
            displayName: "Verdict App", bundleId: "com.example.verdict",
            now: { Date(timeIntervalSince1970: 1_700_000_000) }
        )
        let stillThere = registry.removalVerdict(projectId: entry.projectId)
        XCTAssertTrue(stillThere.answerable)
        XCTAssertFalse(stillThere.removed, "条目还在盘上，不许报已删除")
        _ = try registry.remove(entry.projectId)

        let reread = ProjectRegistry(filePath: path)
        XCTAssertFalse(reread.loadFailed)
        let gone = reread.removalVerdict(projectId: entry.projectId)
        XCTAssertTrue(gone.answerable)
        XCTAssertTrue(gone.removed,
                       "盘上确实没有它了——这一半也必须是能过的，否则拒绝只是恒真")
    }

    /// 第三种"看不见盘"：文件整个不在。`load()` 把缺文件当成"还没注册"，这对读侧是对的；
    /// 写在后面的回读如果只看见"文件不在"，那既可能是写没落盘也可能是表被删了——两种都不能
    /// 报"确认已删除"。REVERSE：把 `removalVerdict` 里那句 `fileExists` 护栏删掉 → 本条红。
    func testRemovalVerdictRefusesWhenTheFileIsGoneAfterTheWrite() throws {
        let path = TestSandbox.filePath("registry-remove-vanished")
        defer { try? FileManager.default.removeItem(atPath: path) }
        let seeded = ProjectRegistry(filePath: path)
        let entry = try seeded.create(
            displayName: "Vanishing", bundleId: "com.example.vanish",
            now: { Date(timeIntervalSince1970: 1_700_000_000) }
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "先确认前提：表本来在盘上")
        try FileManager.default.removeItem(atPath: path)

        let after = ProjectRegistry(filePath: path)
        XCTAssertFalse(after.loadFailed, "缺文件不算「读不开」，所以这一格只能由回读自己判")
        XCTAssertTrue(after.all.isEmpty)
        let verdict = after.removalVerdict(projectId: entry.projectId)
        XCTAssertFalse(verdict.answerable,
                       "文件不在盘上时「没有它」不是一次可以报出去的确认")
        XCTAssertFalse(verdict.removed)
    }

    // MARK: - daemon 确实把判据接上了

    /// `--list-projects` 必须走 `listing()`，且在拒绝分支上非零离场。撤掉那次调用
    /// （回到 `registry.all` 直接打印）这条用例就该红。
    func testDaemonListProjectsAsksTheRegistryForAVerdict() throws {
        let source = codeOnly(try read("engine/Sources/glasspaned/main.swift"))
        guard let start = source.range(of: "if options.listProjects {") else {
            return XCTFail("main.swift 里找不到 --list-projects 的处理块，这条对照已不作数")
        }
        let block = source[start.lowerBound...]
        XCTAssertTrue(block.contains("registry.listing()"),
                      "--list-projects 又回到直接读 registry.all：读不开的文件会被报成\"什么都没注册\"")
        XCTAssertTrue(block.contains("case .unreadable"),
                      "拒绝分支不见了：`.listing()` 被调了却没被判定")
        // 不许 `!`：这段要找的正是"拒绝分支还在不在"，用强制解包会在它消失时把整条
        // xctest 打成 signal 5——红要红成一条具名失败，不是红成一次环境故障。
        // 窗口必须有界。整段切到文件尾的话，`exit(1)` 会被后面八条别的 `exit(1)` 满足，
        // 于是"把拒绝改成 exit(0)"这条变异照样绿——一条只会通过的断言不是断言。
        guard let refusalStart = block.range(of: "case .unreadable") else {
            return XCTFail("拒绝分支的起点找不到")
        }
        let windowEnd = block.range(of: "let encoder", range: refusalStart.upperBound..<block.endIndex)?.lowerBound
            ?? block.endIndex
        let refusal = block[refusalStart.lowerBound..<windowEnd]
        XCTAssertTrue(refusal.contains("exit(1)"),
                      "拒绝却退出码 0：读不开仍然被读成\"注册表是空的\"")
        XCTAssertFalse(refusal.contains("exit(0)"),
                       "拒绝分支里出现 exit(0)：这条闸的窗口又漂回文件尾了")
        // 拒绝的那份 JSON 不许带着 `"count": 0` 或 `"projects": []` 出门：读不开的时候
        // 这两个值都是编的，而它们恰好是这条命令被误读成"什么都没注册"的那两个键。
        XCTAssertFalse(refusal.contains("\"count\""),
                       "拒绝报文里还在给一个数不出来的计数")
        XCTAssertFalse(refusal.contains("\"projects\""),
                       "拒绝报文里还在给一个看不见的表")
    }

    /// `--project-remove` 的 `removed` 只能来自 `removalVerdict`，不许再自己数 `all`。
    func testDaemonProjectRemoveReportsOnlyTheVerdictItCanRead() throws {
        let source = codeOnly(try read("engine/Sources/glasspaned/main.swift"))
        XCTAssertTrue(source.contains("private func runProjectRemove("),
                      "main.swift 里找不到 runProjectRemove，这条对照已不作数")
        XCTAssertTrue(source.contains("removalVerdict(projectId: projectId)"),
                      "--project-remove 又回到 `!verified.all.contains(…)`：重读失败时会报一次假成功")
        XCTAssertFalse(source.contains("!verified.all.contains"),
                       "判据被抄回了 CLI 里，`removalVerdict` 成了一份没人执行的守卫")
        XCTAssertTrue(source.contains("if !verdict.answerable"),
                      "拒绝分支不见了：verdict 被取了却没被判定")
    }
}
