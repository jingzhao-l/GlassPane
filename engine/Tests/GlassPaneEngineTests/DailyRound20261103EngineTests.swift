import Foundation
import Testing
@testable import GlassPaneEngine

/// 本轮（2026-11-03）在 Swift 这一侧修掉的四件事，每条都问真字节，不问注释。
///
/// 1. **一条事实一种拼写**（缺陷 #25）。`--evidence-stats` 曾自己实现过一份
///    `EvidenceStore.ageRetentionReading` 的语义，两份的字节已经分叉
///    （"no daemon flag **and** no configuration path" vs "no daemon flag **or** configuration path"），
///    于是同一个状态根在 socket `stats()` 与 CLI 两个门面上印成两句话。载荷现在直接转读
///    `stats.ageRetention`——合并说明（`main.swift` 里那段"合并后本函数删掉"）写的就是这一件事。
/// 2. **报文不回显账号名**（缺陷 #18，安全侧）。`Dispatcher.swift:50-60` 自己立的规矩是
///    "这一帧会到达任何握着 socket 的同用户进程，也包括那台 loopback 网关"，而网关按
///    `SECURITY.md` §2.3 是**别的本地账号也能寻址**的。注册条目里的档案目录通常在用户主目录之下，
///    原样回显就把账号名发了出去。现在过 `redactHome`。
/// 3. **`.tmp-*` 残渣有人收**（缺陷 #27）。`DurableFileWrite.stage` 在 write 与 rename 之间被
///    打断留下的那个名字过不了 `isEntryName`，`clear()`、两种 prune 与 `stats()` 一起跳过它，
///    本仓自己的日志原话是"nothing will ever reclaim it"。现在按 pid 存活判据回收。
/// 4. **面板控件的存在性**（缺陷 #26 的反面）。`engine/smoke.md` 2026-10-31 那一节断言
///    `gp-refresh-daemon-stats` "在这次构建的面板上不存在"，而它在
///    `EvidenceStatsView.swift:126` 自 2026-10-10 就在（只是 `.loaded` 那个状态不渲染）。
///    这里把"这个标识由源码登记"钉成断言，文档再写"不存在"就要对着它道歉。
@Suite("每日 2026-11-03：引擎侧的四条")
struct DailyRound20261103EngineTests {

    // ------------------------------------------------------------ 1. 一种拼写

    @Test("年龄闸那句话说一次：stats() 的字段与库里的常量逐字节相等")
    func ageRetentionHasOneSpelling() {
        let notEnforced = EvidenceStore.ageRetentionReading(maxAgeDays: nil)
        #expect(notEnforced == EvidenceStore.ageRetentionNotEnforced,
            "没有年龄闸时那句读数必须逐字节等于库里那份；两份拼写就是两个门面两种答案")

        let set = EvidenceStore.ageRetentionReading(maxAgeDays: 30)
        #expect(set.contains("age gate of 30 day(s)"), "设了 30 天那一档要说谁设的：\(set)")
        #expect(set.contains("no daemon flag or configuration path sets one"),
            "设了闸那半句的尾巴必须与库里那一版同词：\(set)")
        #expect(set.hasSuffix(EvidenceStore.ageRetentionNotEnforced),
            "尾巴要复用同一枚常量，不许再抄一遍：\(set)")
    }

    @Test("CLI 那一面不再自己拼这句话：main.swift 里既没有副本，也没有第二种词")
    func cliReadsTheLibraryValue() throws {
        let source = try daemonMainSource()
        #expect(!source.contains("evidenceAgeRetentionReading"),
            "main.swift 里还留着那份副本函数——两处拼写的缺陷就回来了")
        #expect(source.contains("\"ageRetention\": stats.ageRetention"),
            "--evidence-stats 的载荷必须转读 stats().ageRetention（合并说明写的那一条）")
        // 反向对照：库里那句"and no configuration path"这一形只该存在一份。
        let engine = try engineCoreAndStoreSources()
        #expect(!engine.contains("no daemon flag and no configuration path"),
            "分叉的那一形还留在树里，两个门面又会说两种话")
    }

    // ------------------------------------------------------------ 2. 账号名上线

    @Test("redactHome 只剥主目录那一段，别的一个字不改")
    func redactHomeKeepsEverythingElse() {
        #expect(EngineCore.redactHome("/Users/alice/glasspane-evidence", home: "/Users/alice")
            == "~/glasspane-evidence")
        #expect(EngineCore.redactHome("/Users/alice", home: "/Users/alice") == "~")
        #expect(EngineCore.redactHome("/System/Library/Java", home: "/Users/alice")
            == "/System/Library/Java", "不在主目录下的路径不许被改写——那是判据本身")
        #expect(EngineCore.redactHome("/Users/alicex/evidence", home: "/Users/alice")
            == "/Users/alicex/evidence", "前缀像但不是同一棵树：不许把别人的账号名折成 ~")
    }

    @Test("被拒的注册条目：报文说得出缺陷，但不说出**这台机器上那一个**账号名")
    func refusalDoesNotPublishTheAccountName() throws {
        // 注入一个合成主目录：隔离闸禁的正是把 `NSHomeDirectory()` 拼成路径的写法（那等于给测试
        // 一个能写真状态的位置），而这条要测的是"折的是主目录那一段"，与主目录究竟在哪无关。
        // 主目录下一个**不存在**的目录是合法注册值（daemon 会自己建），测不出拒装那一路；
        // Library 之下才是 deny 表里的一档，而那条报文里带的正是主目录前缀。
        let home = "/Users/gp-probe-user"
        let stored = home + "/Library/gp-20261103-refusal-probe"
        let defect = try #require(EngineCore.resolvedStoragePathDefect(resolved: stored, home: home))
        let message = "project prj_X stores evidenceStoragePath \"\(EngineCore.redactHome(stored, home: home))\", which \(defect)."
        #expect(message.contains("~/Library/gp-20261103-refusal-probe"),
            "主目录下的注册值没折成 ~：\(message)")
        #expect(!message.contains(home),
            "账号名出现在报文里，网关那一面就读得到：\(message)")
    }

    @Test("ownability 那一路回显的祖先路径也过同一把尺子")
    func ownabilityMessagesRedactAncestors() throws {
        let store = try engineCoreAndStoreSources()
        let occurrences = store.components(separatedBy: "\\(cursor.path)").count - 1
        #expect(occurrences == 0,
            "ownabilityDefect 里还有 \(occurrences) 处原样回显 cursor.path；那一路会带着主目录上线")
        let redacted = store.components(separatedBy: "redactHome(cursor.path)").count - 1
        #expect(redacted >= 5, "六处回显至少五处要过 redactHome，实测 \(redacted)")
    }

    // ------------------------------------------------------- 3. `.tmp-*` 残渣

    @Test("staging 名字里的 pid 读得出来，别的名字一律不算")
    func stagingNameParsing() {
        #expect(EvidenceStore.stagingTempPid("op_ABCDEFG.json.tmp-4242-7E9A-1") == 4242)
        #expect(EvidenceStore.stagingTempPid("op_ABCDEFG.json.tmp-4242-") == 4242,
            "pid 段读完就该停；uuid 段缺了也还是这一族的名字")
        #expect(EvidenceStore.stagingTempPid("op_ABCDEFG.json") == nil, "正式档案名不是残渣")
        #expect(EvidenceStore.stagingTempPid("notes.json.tmp-hello-x") == nil,
            "pid 段不是十进制数字就不算这一族，不许顺手删别人的文件")
        #expect(EvidenceStore.stagingTempPid("op_ABCDEFG.json.tmp-0-x") == nil,
            "pid 0 不是一个进程，认不出就不动")
    }

    @Test("收残渣只收**那个进程已经不在**的那些；活着的写者一根手指都不碰")
    func reclaimSkipsLiveWriters() throws {
        // TestSandbox 而不是手写 temp 路径：`TestIsolationGateTests` 就为这件事存在——
        // " somewhere under the shared temp directory is not isolation"，手拼的名字是别的进程也可能挑中的名字。
        let directory = TestSandbox.directory("reclaim")

        func touch(_ name: String) throws {
            try Data("half-written".utf8).write(to: URL(fileURLWithPath: directory + "/" + name))
        }
        let livePid = ProcessInfo.processInfo.processIdentifier
        let deadPid: pid_t = 999_999  // 本机不存在的那一号
        try touch("op_A.json.tmp-\(livePid)-live")
        try touch("op_B.json.tmp-\(deadPid)-dead")
        try touch("op_C.json")

        let store = EvidenceStore(directory: directory)
        let removed = store.reclaimStaleStagingFiles()
        #expect(removed == 1, "只该收走那一枚 pid 已经不在了的残渣，实测 removed=\(removed)")

        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory))?.sorted() ?? []
        #expect(names.contains("op_A.json.tmp-\(livePid)-live"),
            "活着的那个写者还在写它的文件，这一趟把它删了就是抢刀：\(names)")
        #expect(names.contains("op_C.json"), "正式档案不归这里管：\(names)")
        #expect(!names.contains("op_B.json.tmp-\(deadPid)-dead"), "\(names)")
    }

    @Test("清空档案目录把残渣也算在内——清完之后目录里不许还剩字节")
    func clearLeavesNoStagingOrphan() throws {
        // TestSandbox 而不是手写 temp 路径：`TestIsolationGateTests` 就为这件事存在——
        // " somewhere under the shared temp directory is not isolation"，手拼的名字是别的进程也可能挑中的名字。
        let directory = TestSandbox.directory("reclaim-clear")
        try Data("x".utf8).write(to: URL(fileURLWithPath: directory + "/op_D.json.tmp-999998-orphan"))

        let store = EvidenceStore(directory: directory)
        _ = store.clear()
        let left = (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? []
        #expect(left.isEmpty, "clear() 说清空了，而目录里还有：\(left)")
    }

    // ------------------------------------------------------ 4. 控件存在性

    @Test("smoke.md 点名的那枚刷新标识由源码登记（文档再写\"不存在\"就是文档的错）")
    func daemonStatsRefreshIdentifierExists() throws {
        let view = try settingsSource("EvidenceStatsView.swift")
        #expect(view.contains(#"accessibilityIdentifier("gp-refresh-daemon-stats")"#),
            "这枚标识不在源码里了——那 engine/smoke.md 2026-10-31 那一节的\"不存在\"反而对了，请把这条测试与那一节一起改")
    }

    @Test("面板里每一条 gp-* 标识都还能从源码里数出来（≥31 是 2026-10-31 的实测读数）")
    func panelIdentifiersAreStillEnumerated() throws {
        let sources = try settingsSourcesText()
        let identifiers = sources.components(separatedBy: "accessibilityIdentifier(\"gp-")
            .dropFirst().map { $0.prefix(while: { $0 != "\"" }) }
        #expect(identifiers.count >= 31,
            "只数出 \(identifiers.count) 枚 gp-* 标识；上一轮实测 31 枚，掉了就是控件被摘了")
    }

    // ------------------------------------------------------------ 源码读者
    //
    // 与 `HumanInterventionAuditTests.repoSource` 同一把尺子：`main.swift` 是 executable 的
    // 源码、`glasspane-settings` 是另一个 target，测试进程 link 不到它们，所以"这一面有没有
    // second 拼写""这枚标识还在不在"这类契约只能把源码当字节核对。

    private func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests/GlassPaneEngineTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // engine
            .deletingLastPathComponent()   // repo root
    }

    private func repoSource(_ relativePath: String) throws -> String {
        try String(contentsOf: repoRoot().appendingPathComponent(relativePath), encoding: .utf8)
    }

    private func daemonMainSource() throws -> String {
        try repoSource("engine/Sources/glasspaned/main.swift")
    }

    private func engineCoreAndStoreSources() throws -> String {
        try repoSource("engine/Sources/GlassPaneEngine/EngineCore.swift")
            + repoSource("engine/Sources/GlassPaneEngine/EvidenceStore.swift")
    }

    private func settingsSource(_ name: String) throws -> String {
        try repoSource("engine/Sources/glasspane-settings/" + name)
    }

    private func settingsSourcesText() throws -> String {
        let directory = repoRoot().appendingPathComponent("engine/Sources/glasspane-settings")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.path))?.sorted() ?? []
        let swift = files.filter { $0.hasSuffix(".swift") }
        #expect(!swift.isEmpty, "读不到 glasspane-settings 的源码，这条对照就什么都不是")
        var text = ""
        for name in swift { text += try settingsSource(name) + "\n" }
        return text
    }
}
