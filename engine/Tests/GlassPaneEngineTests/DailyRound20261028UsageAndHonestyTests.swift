import XCTest
@testable import GlassPaneEngine

/// 用法、文案与总量（每日任务 2026-10-28 的 P1/P2 一批）。
///
/// 覆盖：
/// · W5 六面取值旗把"下一面旗"当值吃掉（`ArgumentValue`）——判据用运行时量，端到端用**发布物
///   形状的真二进制**量（`engine/.build/debug/glasspaned`），不是只钉文本。
/// · W6 `--grant-accessibility` 替 daemon 宣布"ready to attach"（量的是本进程的席位，说的
///   却是另一个主体的结论），以及给人看的文案里夹着内部 § 引用。
/// · W7 被 SIGTERM 打断的 act 不留档案，那一句"少了一条证据"必须能说出是哪个 operationId。
/// · W4 面板把"有条目没报出大小"的档案总量发成一个更小的数字。
/// · S-F1 `method` 未知时把调用方原文不限长地回显进错误帧。
final class DailyRound20261028UsageAndHonestyTests: XCTestCase {

    // MARK: - W5：旗标后面那个 token 算不算值

    /// 判据本体（纯函数，三支都要能红）。
    func testArgumentValueSeparatesAValueFromAnotherFlag() {
        XCTAssertEqual(ArgumentValue.follow(["--project-remove", "op-7"], after: 0), .value("op-7"))
        XCTAssertEqual(
            ArgumentValue.follow(["--project-remove", "--dry-run"], after: 0),
            .anotherArgument("--dry-run"),
            "把另一面旗当值是本轮那条缺陷的起点"
        )
        XCTAssertEqual(ArgumentValue.follow(["--project-remove"], after: 0), .nothingFollows)
        // 单横线不是"另一面旗"：`-` 是合法的项目 ID 字符，判据不许把它吃成旗标。
        XCTAssertEqual(ArgumentValue.follow(["--project-remove", "-"], after: 0), .value("-"))

        XCTAssertNil(ArgumentValue.usageError(flag: "--older-than", expects: "a day count",
                                             value: .value("30")))
        XCTAssertEqual(
            ArgumentValue.usageError(flag: "--older-than", expects: "a day count", value: .nothingFollows),
            "--older-than requires a day count"
        )
        XCTAssertEqual(
            ArgumentValue.usageError(flag: "--project-remove", expects: "a project ID",
                                     value: .anotherArgument("--dry-run")),
            "--project-remove requires a project ID, got what looks like another argument (--dry-run)",
            "句子要同时说清：少了值、以及那个 token 其实是什么"
        )
    }

    /// 端到端（真二进制，实测形状）：`--project-remove` 后面跟的是 `--dry-run` 时，回答必须
    /// 是用法错（64 + 整块 usage），而不是"没有名叫 --dry-run 的项目"（3，一次运行期拒绝）。
    /// 后面那一面旗也不许被吃掉——它没被执行，这一点由"退出码是 64 且打印了整块 usage"来认。
    /// REVERSE：把 `ArgumentValue.usageError` 那一支退回裸的 `arguments[index + 1]` → 本条的
    /// rc 从 64 变成 3，第一句断言就红。
    func testRealBinaryRefusesAFlagSwallowedAsAValue() throws {
        let binary = try daemonBinary()
        let state = try shortTempDirectory("usage")
        defer { try? FileManager.default.removeItem(atPath: state) }

        let swallowed = runCLI(binary, ["--state-dir", state, "--project-remove", "--dry-run"])
        XCTAssertEqual(swallowed.status, 64,
                       "旗标被当成值吃掉时答的是运行期拒绝，不是用法错：\(swallowed.text.prefix(400))")
        XCTAssertTrue(swallowed.text.contains("--project-remove requires a project ID"),
                      swallowed.text.prefix(400).description)
        XCTAssertTrue(swallowed.text.contains("got what looks like another argument (--dry-run)"),
                      swallowed.text.prefix(400).description)
        XCTAssertTrue(swallowed.text.contains("USAGE"),
                      "用法错必须带整块 usage（`--help` 的 64 段承诺的就是这个形状）")

        // ★ 对照：给了真值就不再撞这条判据（这里让它走到"项目不存在"那一支）。
        let real = runCLI(binary, ["--state-dir", state, "--project-remove", "op-does-not-exist"])
        XCTAssertNotEqual(real.status, 64, "一个正常的 ID 不该被认成另一面旗：\(real.text.prefix(300))")
        // ★ 对照二：`--older-than` 的值确实是数字时照常受理（判据不许变成"一律拒"）。
        let days = runCLI(binary, ["--state-dir", state, "--prune-evidence", "--older-than", "30", "--dry-run"])
        XCTAssertNotEqual(days.status, 64, "带真值的旗标被误拒：\(days.text.prefix(300))")
    }

    /// 六面取值旗都要接在同一位作者上（接线断了就等于那一面旗退回裸吃值）。
    func testEveryValueTakingFlagRoutesThroughTheOneAuthor() throws {
        let source = try sourceText("Sources/glasspaned/main.swift")
        XCTAssertEqual(source.components(separatedBy: "ArgumentValue.follow(arguments, after: index)").count - 1, 6,
                       "六面取值旗（--request-permission/--active-project/--project-remove/--recipe-validate/--older-than/--project）少接一面")
        XCTAssertFalse(
            source.contains("options.projectRemoveId = arguments[index]"),
            "--project-remove 又直接吃下一个 token 了"
        )
        // 三面路径旗仍然走 `StateRootArgument.rejection`（`--socket-path`/`--probe-socket-path`
        // 两处调用），两族判据不许各写一套；`--state-dir` 自己走同源的 `init(raw:)`。
        XCTAssertEqual(source.components(separatedBy: "= StateRootArgument.rejection(").count - 1, 2,
                       "路径旗的那一条判据搬家了——它必须与 `--state-dir` 同源")
    }

    // MARK: - W6：一句量错了主语的话

    /// `--grant-accessibility` 读的是本进程的 `AXIsProcessTrusted()`，而 `--help` 与
    /// `--permissions` 都写明那不是 daemon 的席位。从前它替 daemon 宣布 "ready to attach"。
    func testGrantAccessibilityStopsSpeakingForTheDaemon() throws {
        let source = try sourceText("Sources/glasspaned/main.swift")
        XCTAssertFalse(source.contains("the daemon is ready to attach"),
                       "本进程的读数又替 daemon 发言了")
        XCTAssertTrue(source.contains("accessibility permission is granted to **this process**"),
                      "拒绝分支的文案搬家时要留下主语")
        XCTAssertTrue(source.contains("glasspaned --permissions"),
                      "给人看的下一步必须是能问到 daemon 席位的那条命令")
    }

    /// 给人看的文案里不许夹内部 § 引用（本仓的产品规则）。只量真会打印出来的那几行——
    /// 把注释当缺陷，下一轮就会删注释换绿。
    func testPrintedCopyCarriesNoInternalSectionCites() throws {
        let offenders = try printedStringLines(in: "Sources/glasspaned/main.swift")
            .filter { $0.text.contains("§") }
        XCTAssertEqual(offenders.map(\.line), [],
                       "这些行会打印内部章节引用：\n" + offenders.map { "\($0.line): \($0.text)" }.joined(separator: "\n"))
        let panel = try printedStringLines(in: "Sources/glasspane-settings/UpdatePanelLogic.swift")
            .filter { $0.text.contains("§") }
        XCTAssertEqual(panel.map(\.line), [], "面板文案里也有 § 引用")
    }

    // MARK: - W7：被打断的那一次 act 要能被点名

    /// act 在途中必须问得出 operationId（收尾 waiter 唯一的用途就是把它写进日志），且
    /// 两条出路（正常返回 / 抛错）都必须清空——留着就是下一个窗口替一次没发生的 act 说话。
    func testActiveOperationIdIsVisibleDuringActAndClearedAfter() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, settle: {})
        var seenDuringAct: String?
        channel.onPerformAction = { seenDuringAct = core.activeOperationId }
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertNil(core.activeOperationId, "没在途 act 时不许凭空有一个 id")

        let selector = Selector(role: "AXButton", title: "Submit")
        _ = try core.act(selector: selector, action: .press)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(seenDuringAct, pack.operationId,
                       "act 期间问到的必须是这一次的 id：\(String(describing: seenDuringAct))")
        XCTAssertNil(core.activeOperationId, "act 返回后必须清空")

        // 抛错那一支同样要清（`defer` 那一条）。
        channel.actionError = .actRejected(reason: "scripted refusal")
        XCTAssertThrowsError(try core.act(selector: selector, action: .press))
        XCTAssertNil(core.activeOperationId, "抛错路径留着 id = 下一个窗口替一次没发生的 act 说话")
    }

    /// 收尾那一条读的是这个读数，且被拒时不写日志之外的任何东西。
    func testShutdownWaiterReadsTheInFlightActAndSaysSo() throws {
        let source = try sourceText("Sources/glasspaned/main.swift")
        XCTAssertTrue(source.contains("inFlightAct: { daemonCore?.activeOperationId }"),
                      "waiter 不再问在途 act 了：那一句\"少了一条证据\"永远不会被写出来")
        XCTAssertTrue(source.contains("the shutdown signal arrived while operation"),
                      "具名要点到那一次的 operationId")
        XCTAssertTrue(source.contains("never archived"),
                      "这一句没了，档案里少一条就只剩\"没发生\"这一种读法")
    }

    // MARK: - W4：总量没测全时不许报一个更小的数字

    /// 一条"名字合法但指着不存在的东西"的档案条目：大小与内容都读不出来。
    /// 从前 `total += listedSize ?? 0` 把它折成 0，于是面板用一个更小的总量冒充测量，而
    /// `--evidence-stats` 对同一件事答 null（判据写在 `EvidenceStore.stats()` 里）。
    func testUnmeasurableEntrySizeIsReportedAsUnmeasuredNotAsZero() throws {
        let dir = try shortTempDirectory("archive-total")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let first = "op_0123456789ABCDEFGHJKMNPQRS.json"
        let second = "op_0123456789ABCDEFGHJKMNPQRT.json"
        try Data("{\"not\":\"a pack\"}".utf8).write(to: URL(fileURLWithPath: dir + "/" + first))
        try Data("{\"also\":\"not a pack\"}".utf8).write(to: URL(fileURLWithPath: dir + "/" + second))

        // 尺寸读数按注入面给：生产里"某条报不出大小"是列完之后被并发改掉的形态（prune 与
        // 扫描赛跑），单元测试造不出那个竞态——本机实测悬空符号链接照样报得出大小（61 字节，
        // 且与 daemon 同一个数），它根本不是失败样本。
        let scan = LocalArchive.scanEvidence(
            directory: dir,
            fileReader: { _ in nil },
            sizeReader: { path in path.hasSuffix(second) ? nil : (try? Data(contentsOf: URL(fileURLWithPath: path)).count) }
        )
        XCTAssertNil(scan.totalBytes, "有条目报不出大小时总量就不是测得值")
        XCTAssertNotNil(scan.sizeFailure, "要说出哪几条没报出来")
        XCTAssertTrue(scan.sizeFailure?.contains("not obtained") == true,
                      "句子要与 daemon 那一条同口径：\(String(describing: scan.sizeFailure))")
        XCTAssertTrue(scan.sizeFailure?.contains(second) == true,
                      "没报出来的是哪一条要点名：\(String(describing: scan.sizeFailure))")
        XCTAssertEqual(scan.entryCount, 2, "两条都是本档案所有的人口")
        XCTAssertTrue(scan.summaries.isEmpty, "解不开的那一份不许被算成档案")

        // ★ 对照：默认读数（真 `.fileSizeKey`）时总量必须是一个数，且等于两条自己的大小之和
        // ——否则上面那条可以由"永远报 nil"来满足。
        let clean = LocalArchive.scanEvidence(directory: dir)
        XCTAssertNotNil(clean.totalBytes, "每一条都报得出大小时必须给出数字")
        XCTAssertNil(clean.sizeFailure)
        var infoA = stat()
        var infoB = stat()
        XCTAssertEqual(lstat(dir + "/" + first, &infoA), 0)
        XCTAssertEqual(lstat(dir + "/" + second, &infoB), 0)
        XCTAssertEqual(clean.totalBytes, Int(infoA.st_size) + Int(infoB.st_size),
                       "那个数就是这两条自己的大小，不是抄来的、也不是折出来的")
    }

    // MARK: - S-F1：错误帧不许不限长地回显调用方原文

    /// `method` 未知时那句错误从前把调用方的原文整个拼回去（任何类型、最长到帧上限），
    /// 而本仓对"未知参数名"早有 `cappedParamKey` 这一条。这里量的是同一个未知值经过
    /// 两条路得到同一个上限——不是新发明一个判据。
    func testUnknownMethodEchoIsBoundedLikeUnknownParamKeys() throws {
        let long = String(repeating: "m", count: 5_000) + "-screen-text"
        let failure = RequestParser.parse(Data("{\"id\":1,\"method\":\"\(long)\"}\n".utf8))
        guard case .failure(let error) = failure else {
            return XCTFail("一个不存在的方法必须被拒")
        }
        let message = error.error.message
        XCTAssertFalse(message.contains(String(repeating: "m", count: 200)),
                       "调用方原文被不限长回显进了错误帧：\(message.prefix(200))")
        XCTAssertTrue(message.contains("code points total"),
                      "截断要标明总量，而不是悄悄剪掉：\(message.prefix(300))")
        // 对照：一个正常的短方法名打错时照原样报——截断不许变成编辑器。
        let shortFailure = RequestParser.parse(Data("{\"id\":2,\"method\":\"obsserve\"}\n".utf8))
        guard case .failure(let shortError) = shortFailure else {
            return XCTFail("拼错的方法必须被拒")
        }
        XCTAssertTrue(shortError.error.message.contains("'obsserve'"), shortError.error.message)
    }

    // MARK: - helpers

    private func daemonBinary() throws -> String {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/debug/glasspaned").path
        guard FileManager.default.isExecutableFile(atPath: path) else {
            throw XCTSkip("没有 \(path)；补上它：swift build --package-path engine")
        }
        return path
    }

    private struct CLIResult { let status: Int32; let text: String }

    private func runCLI(_ binary: String, _ arguments: [String]) -> CLIResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try? process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return CLIResult(status: process.terminationStatus,
                         text: String(data: data, encoding: .utf8) ?? "")
    }

    private func shortTempDirectory(_ label: String) throws -> String {
        let dir = "/tmp/gp28-\(label)-" + String(UUID().uuidString.prefix(8))
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        chmod(dir, 0o700)
        return dir
    }

    private func sourceText(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// 只取真会打印出来的那些字符串行（`print("…")` / `FileHandle…write(Data("…"` 的
    /// 字面量），注释不参与——把注释当缺陷会被"删注释换绿"绕过。
    private func printedStringLines(in file: String) throws -> [(line: Int, text: String)] {
        try sourceText(file).split(separator: "\n", omittingEmptySubsequences: false).enumerated()
            .filter { _, lineText in
                let trimmed = lineText.trimmingCharacters(in: .whitespaces)
                guard !trimmed.starts(with: "//"), !trimmed.starts(with: "*"),
                      !trimmed.starts(with: "/*") else { return false }
                return trimmed.contains("print(") || trimmed.contains(".write(Data(")
            }
            .map { (line: $0.offset + 1, text: String($0.element)) }
    }
}
