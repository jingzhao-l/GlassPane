import XCTest
@testable import GlassPaneEngine

/// 每日任务 2026-11-05 · 上一轮候选 G 的那一手改过了头，而它要防的那一件事没做成。
///
/// 缺陷一（改过了头）。2026-11-04 那一批把 `EngineCore.redactHome(...)` 铺进了
/// `RemedyCommand.quote(...)` 里面，于是出路句子打出来的是 ``chmod 700 '~/.glasspane'``。
/// 单引号里的 `~` 不归 shell 展开：本机实测 `test -e '~'` 退 1、`test -e ~` 退 0，
/// `ls -ld '~/.glasspane'` 回 `No such file or directory`。这一条命令对**每一个用默认状态根
/// 的装机**都失败——出路读起来像出路、跑起来是一句报错，比没有出路更糟，而本仓对 remedy 的
/// 要求一直是"agent 照着敲就得做得动"。
///
/// 缺陷二（没做成）。那句折主目录的代码在 `ProjectRegistry.listing()` 的**兜底**里，而兜底只在
/// `unreadableReport == nil` 时走到；`loadFailed` 为真时 `unreadableReport` 恒不为 nil ⇒ 那一处
/// 永远不执行，真源 `unreadableReport` 原样把 `/Users/<账号>` 发进每一条拒绝。更细的一层：
/// `NSError.description` 把路径写在句子**中间**（`UserInfo={NSFilePath=/Users/…}`），
/// `redactHome` 的 `hasPrefix` 那一支对它无能为力，所以账号名从后半句又回来了。
///
/// 修法分工写成两条判据，而不是把 redactHome 整个撤掉：
///   · 散文（message/reason/error 描述）折 `~`，且**只有真源一处作者**；
///   · 命令位（反引号里那条要人敲的）带真路径——与 `main.swift` 里
///     `--state-dir \(RemedyCommand.quote(stateRoot.path))` 同一条既有约定。
///
/// REVERSE：把 `ProjectRegistry.swift` 任一处改回 `RemedyCommand.quote(EngineCore.redactHome(x))`
/// ⇒ `noQuotedShellWordWrapsRedaction` 具名红并点名那一枚文件；把 `unreadableReport` 里的
/// `redactHome(filePath)` 改回 `filePath` ⇒ `theUnreadableSentenceHasOneAuthorAndItFoldsHome` 红；
/// 把 `loadFailure` 那两处的 `EngineCore.described(error)` 改回 `\(error)` ⇒ 同一条红。
final class DailyRound20261105RemedyWordUsableTests: XCTestCase {

    private func source(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(relative)
        return try XCTUnwrap(try? String(contentsOf: url, encoding: .utf8),
                             "读不到 \(url.path)——这一条源码对照没有对照物了")
    }

    /// 取一个计算属性/函数的正文（从声明行到它与 `indent` 同缩进的那个 `}` 为止）。
    /// 不这么切就会把整个文件当成对照面：`filePath` 在别处当然可以裸写（命令位就在那儿）。
    private func body(of declaration: String, in text: String, file: String) throws -> String {
        guard let start = text.range(of: declaration) else {
            XCTFail("\(file) 里找不到「\(declaration)」——这一路的形状变了，对照不作数")
            return ""
        }
        let lines = text[start.lowerBound...].components(separatedBy: "\n")
        let indent = String(lines[0].prefix(while: { $0 == " " }))
        var out = lines[0]
        for line in lines.dropFirst() {
            out += "\n" + line
            if line == indent + "}" { break }
        }
        return out
    }

    // MARK: - 1. 结构：引号里不许包一次折主目录

    private func engineSources() throws -> [URL] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: nil) else {
            throw XCTSkip("读不到 \(root.path)——这一条源码对照在没有该目录的环境里不作数")
        }
        let urls = enumerator.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
            .sorted { $0.path < $1.path }
        XCTAssertGreaterThanOrEqual(urls.count, 20,
            "只扫到 \(urls.count) 份引擎源码：扫描形状变了，这条闸已经在空转")
        return urls
    }

    func testNoQuotedShellWordWrapsRedaction() throws {
        var offenders: [String] = []
        var goodUses = 0
        for url in try engineSources() {
            let text = try String(contentsOf: url, encoding: .utf8)
            goodUses += text.components(separatedBy: "RemedyCommand.quote(").count - 1
            for pattern in ["RemedyCommand.quote(EngineCore.redactHome(",
                            "RemedyCommand.quote(redactHome(",
                            "RemedyCommand.quote(EngineCore.redactHomeWithin("] {
                let hits = text.components(separatedBy: pattern).count - 1
                if hits > 0 { offenders.append("\(url.lastPathComponent) ×\(hits) 「\(pattern)」") }
            }
        }
        XCTAssertGreaterThanOrEqual(goodUses, 20,
            "全仓只数到 \(goodUses) 处 `RemedyCommand.quote(`——命令位本来就不少，数不到说明扫描空跑")
        XCTAssertEqual(offenders, [],
            "这些把要人敲的命令折成了 `~`，单引号里的波浪号不归 shell 展开：\(offenders.joined(separator: ", "))")
    }

    // MARK: - 2. 行为：真 shell 量一次那个词开不开

    private func shellCanOpen(_ word: String) -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-c", "test -e \(word)"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        do {
            try task.run()
        } catch {
            // 起不了 shell 就等于没量到：这一条不许替任何一边作保。
            return false
        }
        task.waitUntilExit()
        _ = pipe.fileHandleForReading.readDataToEndOfFile()
        return task.terminationStatus == 0
    }

    func testTildeWordFailsInTheShellWhileTheRealWordWorks() throws {
        // 这条对照的意义就是"同一个位置，带引号的波浪号开不了，真路径开得了"。
        // 用测试沙箱里一枚真存在的目录当"真路径"，不拿用户的状态根作对照物
        // （`TestIsolationGateTests` 禁的正是那种形状，而它禁得对）。
        let directory = TestSandbox.directory("remedy-word-usable")
        XCTAssertTrue(shellCanOpen(RemedyCommand.quote(directory)),
                      "真路径那个词连本机 shell 都打不开，这条对照没有对照物：\(directory)")
        XCTAssertTrue(shellCanOpen("~"), "波浪号不引号时 shell 认得它——这一格变了说明测的不是那件事")
        XCTAssertFalse(shellCanOpen(RemedyCommand.quote("~")),
                       "单引号里的 `~` 被 shell 认了 ⇒ 那条缺陷判据得跟着改（实测它不该认）")
        XCTAssertFalse(shellCanOpen(RemedyCommand.quote("~/Library/Application Support")),
                       "同上，换成一条会落空的真实出路形状再量一次")
    }

    func testUnreadableRegistryPayloadNamesThePathItMeans() throws {
        // 沙箱里那一枚是真存在的：出路里那个词必须指得到它。
        let directory = TestSandbox.directory("registry-payload-word")
        let real = directory + "/projects.json"
        for payload in [
            ProjectRegistry.pruneUnreadablePayload(total: 0, matched: 0, dryRun: true, registryPath: real),
            ProjectRegistry.removalUnreadableAtLoadPayload(
                projectId: "prj_01M34567890123456789012A", dryRun: false, registryPath: real),
        ] {
            let next = try XCTUnwrap(payload["next"] as? String, "\(payload)")
            let word = try XCTUnwrap(
                next.range(of: "'[^']*'", options: .regularExpression).map { String(next[$0]) },
                "出路里找不到一个带引号的路径词，这条对照看不到东西：\(next)")
            XCTAssertEqual(word, RemedyCommand.quote(real),
                "命令里那个词不是报文带进来的路径：\(word)")
            XCTAssertFalse(word.contains("~"), "带引号的命令词不许出现波浪号：\(word)")
        }
    }

    // MARK: - 3. 真源：拒绝那一句的作者与折法

    func testTheUnreadableSentenceHasOneAuthorAndItFoldsHome() throws {
        let registry = try source("Sources/GlassPaneEngine/ProjectRegistry.swift")
        let report = try body(of: "public var unreadableReport: String? {", in: registry,
                              file: "ProjectRegistry.swift")
        XCTAssertTrue(report.contains("EngineCore.redactHome(filePath)"),
            "真源不再折主目录，账号名就跟着每一条拒绝上线：\(report)")
        XCTAssertFalse(report.contains("projects.json at \\(filePath)"),
            "真源里又出现裸回显：\(report)")

        // 兜底不许成为第二个作者：同一句话在两处拼写就是下一次漂移的地方。
        let listing = try body(of: "public func listing() -> RegistryListing {", in: registry,
                               file: "ProjectRegistry.swift")
        XCTAssertTrue(listing.contains("unreadableReport ??"),
            "`listing()` 不再共用真源那句：\(listing)")

        // `NSError.description` 里的主目录写在句子中间，`redactHome` 的 `hasPrefix` 够不着，
        // 所以两处 `loadFailure` 的赋值都得过 `described`。漏一处就是留一条泄漏面。
        let describedUses = registry.components(separatedBy: "EngineCore.described(error)").count - 1
        XCTAssertGreaterThanOrEqual(describedUses, 2,
            "只数到 \(describedUses) 处 `EngineCore.described(error)`：这一族有两个出口，都得过")
        let bareErrorEchoes = registry.components(separatedBy: "loadFailure = \"").dropFirst()
            .filter { head in head.hasPrefix("cannot be read (\\(error))") || head.hasPrefix("is not a decodable project list (\\(error))") }
        XCTAssertEqual(bareErrorEchoes, [], "又有 loadFailure 把错误原样插值进去了")
    }

    func testDescribedFoldsHomeInsideTheSentence() {
        // `redactHome` 是 `hasPrefix`，对句子中间的绝对路径无能为力；这里量的就是那一点。
        // 主目录是合成的：测试不去碰真的那一个（隔离闸禁的形状）。
        let fakeHome = "/Users/gp-probe-user"
        let embedded = "Error Domain=NSCocoaErrorDomain Code=256 \" couldn’t be opened.\" "
            + "UserInfo={NSFilePath=\(fakeHome)/.glasspane/projects.json, "
            + "NSUnderlyingError=… Domain=NSPOSIXErrorDomain Code=21}"
        let folded = EngineCore.redactHomeWithin(embedded, home: fakeHome)
        XCTAssertTrue(folded.contains("~/./glasspane/projects.json") || folded.contains("~/.glasspane/projects.json"),
            "句子中间的主目录没被折掉：\(folded)")
        XCTAssertFalse(folded.contains(fakeHome), "账号名还在：\(folded)")
        // 不在那一段之内的一个字都不许改（把 /System 折走就是另一件事了）。
        XCTAssertEqual(EngineCore.redactHomeWithin("/System/Library", home: fakeHome), "/System/Library")
    }

    func testAPathOutsideHomeIsReportedVerbatim() throws {
        // 主目录之外不许被折写——那是判据本身，也是别的测试赖以点名文件的前提。
        // 对照物是一个**真存在但不是 JSON 文件**的位置（目录）：读它必失败，
        // 于是这一路有报文可量，而不是在空集上自证。
        let directory = try XCTUnwrap(
            URL(string: "file://" + TestSandbox.directory("redact-outside-home"))?.path,
            "沙箱路径取不到")
        let registry = ProjectRegistry(filePath: directory)
        let report = try XCTUnwrap(registry.unreadableReport,
            "把一个目录当表读却没进 loadFailed，这条对照没有对照物：\(directory)")
        XCTAssertFalse(report.contains("~"), "主目录之外的路径被折写了：\(report)")
        XCTAssertTrue(report.contains(directory), "拒绝点不出它说的是哪一份：\(report)")
    }
}
