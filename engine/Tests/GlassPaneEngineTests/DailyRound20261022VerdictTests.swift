import XCTest
import Foundation
@testable import GlassPaneEngine

/// 2026-10-22 轮的三条"判决"类缺陷（P2）。三条的共同形状是**同一个事实在两个面上说出
/// 不同的话**，而不是崩溃或数据丢失：
///
///  1. `DebugCapabilityProbe.classify` 把"进程根本没起来"读成"系统拒绝授权"：EPERM 的
///     `localizedDescription`（"Operation not permitted"）里带着拒绝扫描的 `not permitted`，
///     于是 `glasspaned --check-developer-tools` 打印 `attach: denied`，面板显示
///     「调试被系统拒绝」并把人送去勾 TCC 那个复选框——而那句话系统从未被问过。
///  2. `ProbeWire` 用 `intValue` 读 `durationNs`：字符串 "800" 或超过 Int32 的数都解码成
///     `nil`，而 `nil` 在这个协议里正是**入口帧**的判据，于是一次点击的补报帧被数成第二次
///     调用，`hitCount`（T4/T5/T7 的分叉依据）被抬高；2^32+1 折成 1。
///  3. `DecisionLogEntry` 数 `summary` 用的是字素簇，而同一字段的已发布内核验证器数的是
///     **UTF-16 码元**（`kernel/schemas/decision-log-entry.schema.json` 的 `maxLength`，
///     由发布内核 `iterate-kernel` 的 `z.string().max(SUMMARY_MAX_LENGTH)` 执行，
///     zod 读 `value.length`）：1025 个 emoji 是 1025 簇却也是 2050 码元，daemon 侧收下的
///     账本行会被契约另一侧拒掉。
///
/// 每条都标了 REVERSE：把那个修复撤掉时**哪一条**会红。夹具取自本仓既有测试的形状
/// （`DebugCapabilityProbeDrainTests`、`DeveloperToolsVerdictTests`、`ProbeCounterTests`、
/// `EngineP6ProbeTests`、`SelectorTitleEmptinessTests`），判据数字与契约文本都从仓库里的
/// 真文件读，不是手抄的。
final class DailyRound20261022VerdictTests: XCTestCase {

    // MARK: - 公共夹具

    /// #filePath 是编译期烘焙的，与 `KernelFixtures`/`SelectorTitleEmptinessTests` 同一技术：
    /// Tests/GlassPaneEngineTests → Tests → engine → 仓库根。
    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.path
    }

    private func json(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object)
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// lldb 的两臂各按自己的 argv 得到答案，一半不许代另一半答（同 `DeveloperToolsVerdictTests`）。
    private final class TwoArmRunner: DebugCapabilityProbe.Running {
        var launch: (exit: Int32?, timedOut: Bool, output: String) =
            (0, false, "Process 1 stopped\nexited with status 0")
        var attach: (exit: Int32?, timedOut: Bool, output: String) =
            (0, false, "Process 4242 attached\n(lldb) detach\n")
        var attachRuns = 0
        var launchRuns = 0
        /// The flags lldb parses for attaching (`lldb --help`, ATTACHING).
        private let attachFlags = ["-p", "--attach-pid"]

        func run(_ binary: String, _ arguments: [String], timeout: TimeInterval)
            -> (exit: Int32?, timedOut: Bool, output: String) {
            if arguments.contains(where: { attachFlags.contains($0) }) {
                attachRuns += 1
                return attach
            }
            launchRuns += 1
            return launch
        }
        func spawnVictim(seconds: Int) -> String? { "4242" }
        func killVictim(_ pid: Int32) {}
    }

    // MARK: - 1. 起不来的进程回答不了权限问题

    /// 生产里那一行的字面量：`ProcessRunner.run` 的 catch 分支拼的就是
    /// `"spawn failed: " + error.localizedDescription`，EPERM 的措辞是 "Operation not permitted"。
    /// REVERSE：删掉 `classify` 里 `if text.hasPrefix(spawnFailurePrefix) { return .spawnFailed }`
    /// 这一行（或把它挪到拒绝串扫描之后）→ 这三条全红，因为 "not permitted" 先被认成 `.denied`。
    func testSpawnFailureTextIsNeverFoldedIntoADenial() {
        for message in [
            "Operation not permitted",      // EPERM：缺二进制、noexec 挂载、签名被拒
            "Not allowed to attach",        // 同一条通道上最像"权限答复"的措辞
            "Permission denied",            // EACCES：文件不可执行
        ] {
            let text = "\(DebugCapabilityProbe.spawnFailurePrefix) \(message)"
            XCTAssertEqual(
                DebugCapabilityProbe.classify((exit: nil, timedOut: false, output: text)),
                .spawnFailed,
                "\(text)：一次从未启动的调试器不许被写成系统的拒绝"
            )
            XCTAssertNotEqual(
                DebugCapabilityProbe.classify((exit: nil, timedOut: false, output: text)),
                .denied,
                "\(text)：denied 是一份权限结论，而这里连问题都没问出口"
            )
        }
        // 标记只有一种表示法：`ProcessRunner` 的 catch、它的收尾复查、`classify` 读的都是这个串。
        XCTAssertEqual(DebugCapabilityProbe.spawnFailurePrefix, "spawn failed:")
    }

    /// 对照必须能过：认出"没起来"不许顺手把**真拒绝**也洗白。已经 spawn 成功的 lldb 说了
    /// 拒绝句仍是 `.denied`——`DebugCapabilityProbeDrainTests` 钉过的 "taskgated: not permitted"
    /// 在这里仍然成立；标记只在**串首**算数，输出中间提到它的是子进程自己的话。
    func testASpawnedDebuggerNamingARefusalIsStillReadAsADenial() {
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: nil, timedOut: false, output: "taskgated: not permitted")),
            .denied,
            "spawn 成功、随后被内核拒绝：那仍是一次实测到的拒绝"
        )
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: 1, timedOut: false,
                                           output: "Process 42 attached\nerror: attach failed: (os/kern) failure\n")),
            .denied
        )
        XCTAssertEqual(
            DebugCapabilityProbe.classify((exit: 1, timedOut: false,
                                           output: "(lldb) command watch command add\nchild reported spawn failed: not permitted\n")),
            .denied,
            "标记是前缀判据：子进程在输出中间说 spawn failed 不等于它自己没起来"
        )
        XCTAssertFalse(
            DebugCapabilityProbe.classify((exit: nil, timedOut: false,
                                           output: "spawn failed: Operation not permitted")) == .denied
        )
    }

    /// 真形状：真的 `ProcessRunner` 对一个不存在的可执行文件、对一个存在但不可执行的文件，
    /// 各自走的是同一条 catch 通道——探测不许因此发明一次拒绝。
    /// REVERSE：撤掉修复后第一条仍红（Foundation 的 "Operation not permitted"/"Permission denied"
    /// 措辞按机器而异，所以把这条当作实路径的补充证明，红的判据在上面那条）。
    func testTheRealRunnerReportsASpawnThatNeverStartedAsSpawnFailed() throws {
        let runner = DebugCapabilityProbe.ProcessRunner()

        let missing = runner.run(repoRoot + "/engine/no-such-probe-binary", [], timeout: 2)
        XCTAssertTrue(
            missing.output.hasPrefix(DebugCapabilityProbe.spawnFailurePrefix),
            "生产者必须继续只发这一种表示法：\(missing.output)"
        )
        XCTAssertNil(missing.exit)
        XCTAssertFalse(missing.timedOut)
        XCTAssertEqual(DebugCapabilityProbe.classify(missing), .spawnFailed, missing.output)

        let directory = TestSandbox.directory("probe-spawn")
        let notExecutable = directory + "/payload"
        try Data("not a program\n".utf8).write(to: URL(fileURLWithPath: notExecutable))
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: notExecutable)
        let refused = runner.run(notExecutable, [], timeout: 2)
        let outcome = DebugCapabilityProbe.classify(refused)
        XCTAssertNotEqual(outcome, .denied, "一次 exec 被拒不是调试席位被拒：\(refused.output)")
        XCTAssertNotEqual(outcome, .ok, "也不许因为任何输出形状被点成已授权：\(refused.output)")
    }

    /// 两个面同一句活：`--check-developer-tools` 打的是 `jsonPayload()`（`main.swift` 的
    /// `if options.checkDeveloperTools { writeJSON(payload); exit(granted ? 0 : 1) }`），
    /// 面板卡读的是同一份 JSON 经 `DeveloperToolsCapability.parse` 得出的措辞。
    /// spawn 失败时两侧必须都是"没得出有效结论"，而退出码仍按"席位未证实"非零。
    /// REVERSE：撤掉 `classify` 的标记判据 → 负载里 attach 变成 "denied"、卡片状态变成
    /// `.denied`、`summaryText` 出现「调试被系统拒绝」与"开发者工具"那句 TCC 指引 → 本条红。
    func testBothDoorwaysGiveTheSameNonVerdictForASpawnFailure() throws {
        let runner = TwoArmRunner()
        runner.attach = (nil, false, "spawn failed: Operation not permitted")
        let payload = DebugCapabilityProbe(runner: runner, timeout: 1).jsonPayload()
        XCTAssertEqual(runner.attachRuns, 1, "attach 那一臂要真的被问过")
        XCTAssertEqual(runner.launchRuns, 1, "两臂各自跑一次，一半不许代另一半答")
        XCTAssertEqual(
            (payload["attach"] as? [String: Any])?["state"] as? String, "spawnFailed",
            "--check-developer-tools 打印的就是这个字段：\(payload)"
        )
        XCTAssertEqual(
            payload["granted"] as? Bool, false,
            "退出码这条通道仍然是非零：修的是措辞，不是把没测到当成测到了"
        )

        let payloadText = try json(payload)
        let report = try XCTUnwrap(
            DeveloperToolsCapability.parse(payloadText, observedAt: Date(timeIntervalSince1970: 1_800_000_000)),
            "负载必须能被面板解析：\(payload)"
        )
        XCTAssertEqual(
            report.status, .unverifiable,
            "面板那盏灯不许把一次没起来的进程点成 denied：\(report)"
        )
        let text = report.summaryText()
        XCTAssertTrue(text.contains("调试器未能启动"), text)
        XCTAssertFalse(text.contains("调试被系统拒绝"), "这条文案把人送去勾复选框：\(text)")
        XCTAssertFalse(text.contains("开发者工具"), "同一个 payload 不许在两个面上说不同的话：\(text)")
    }

    /// 对照（同一对接的两个面）：真的拒绝必须还是真的拒绝——负载说 denied、卡片说 denied、
    /// 文案里那句 TCC 指引还在。撤掉修复不会让这条红，但把标记改成 `contains` 或干脆不分类时会红。
    func testBothDoorwaysStillSayDeniedForARealRefusal() throws {
        let runner = TwoArmRunner()
        runner.attach = (1, false, "error: Not allowed to attach to process 4242")
        let payload = DebugCapabilityProbe(runner: runner, timeout: 1).jsonPayload()
        XCTAssertEqual((payload["attach"] as? [String: Any])?["state"] as? String, "denied")
        let payloadText = try json(payload)
        let report = try XCTUnwrap(
            DeveloperToolsCapability.parse(payloadText, observedAt: Date()),
            "\(payload)"
        )
        XCTAssertEqual(report.status, .denied)
        XCTAssertTrue(report.summaryText().contains("调试被系统拒绝"))
        XCTAssertFalse(report.granted)
    }

    // MARK: - 2. durationNs：存在性是判据，有效性是硬要求

    private func helloFrame() -> ProbeHello {
        ProbeHello(
            pid: 4242, bundleId: "com.example.app", appName: "Example",
            probeVersion: "gp-probe/0.1.0", capabilities: ["z1", "z2"]
        )
    }

    private func wire(_ json: String) -> ProbeInboundFrame {
        ProbeWire.decode(Data(json.utf8))
    }

    /// SDK 自己发的两条帧（`GlassPaneProbe.emitHandler`：入口帧**没有** durationNs 这个键，
    /// >1ms 的退出帧才加上它），逐字段按 §2.2 的线上形状写出来。
    private static let entryLine = #"{"t":"handler","file":"View.swift","line":44,"ts":1758200000.123}"#
    private static let durationLine =
        #"{"t":"handler","file":"View.swift","line":44,"ts":1758200000.5,"durationNs":2400000}"#

    private func hitCount(after lines: [String]) throws -> Int {
        let inbox = ProbeInbox(now: { Date(timeIntervalSince1970: 1_800_000_000) })
        XCTAssertTrue(inbox.register(helloFrame()))
        inbox.beginWindow(pid: 4242, opId: "op_20261022")
        for line in lines { inbox.ingest(pid: 4242, frame: wire(line)) }
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_20261022"))
        return try XCTUnwrap(signals.handlerProbe).hitCount
    }

    /// 真帧的配对规则没被动过：一条入口 + 一条补报 = 一次调用。
    /// 这条同时是下一条的对照——它先证明 `durationNs` 真的解出了值，
    /// 否则"补报帧不抬高 hitCount"只是因为补报帧根本不存在。
    func testEntryAndDurationFramesFromTheRealWireShapeStillPairToOneInvocation() throws {
        XCTAssertEqual(
            wire(Self.durationLine),
            .handler(file: "View.swift", line: 44, ts: 1_758_200_000.5, durationNs: 2_400_000),
            "补报帧必须带着时长解出：\(wire(Self.durationLine))"
        )
        XCTAssertEqual(try hitCount(after: [Self.entryLine, Self.durationLine]), 1,
                       "同一次点击的两条帧不许数成两次调用（T4/T5/T7 读的就是这个数）")
        XCTAssertEqual(try hitCount(after: [Self.entryLine]), 1)
        XCTAssertEqual(try hitCount(after: [Self.entryLine, Self.entryLine]), 2,
                       "两条入口帧是两次调用：入口永远是新的一次")
    }

    /// 字符串 "800" 不是时长。旧写法 `intValue` 把它读成 nil，而 nil 正是入口帧的判据——
    /// 于是这条补报帧变成"这个 site 又跑了一次"。
    /// REVERSE：把 `durationNs` 换回 `(scalar(dict["durationNs"]))?.intValue` → 第一条红
    /// （解出 `.handler(durationNs: nil)`），第二条红（hitCount 从 1 变 2）。
    func testStringDurationIsMalformedAndNeverBecomesASecondInvocation() throws {
        let bad = #"{"t":"handler","file":"View.swift","line":44,"ts":1758200000.5,"durationNs":"800"}"#
        guard case .malformed(let reason) = wire(bad) else {
            return XCTFail("一个字符串时长不许被降级成入口帧：\(wire(bad))")
        }
        XCTAssertTrue(reason.contains("durationNs"), "报文要点名是哪个字段：\(reason)")
        XCTAssertEqual(
            try hitCount(after: [Self.entryLine, bad]), 1,
            "被拒的帧就是被拒的帧：它不许替这次点击再记一次调用"
        )
    }

    /// 2^32+1 折成 1、2^32 折成 0、负数与小数折成"有值"——`ProbeWire.boundedInt32` 的注释
    /// 把这叫 "two truncations posing as one check"，`pid`/`line` 早就改成拒了，
    /// `durationNs` 是漏掉的最后一个。
    /// REVERSE：把 `boundedInt32` 那段撤成 `?.intValue` → 每个值都红（1、0、-1、1、
    /// 1 都是"带时长的补报帧"，不再是畸形帧）。
    func testDurationOutsideInt32IsMalformedNotFoldedOntoSomethingReadable() {
        for value in ["4294967297", "4294967296", "-1", "9007199254740993", "1.5"] {
            // Written as a JSON **number** (escaped quotes, interpolated value): the
            // folding this pins happens on numbers, and a quoted value would only
            // prove the string case again.
            let candidate =
                "{\"t\":\"handler\",\"file\":\"View.swift\",\"line\":44,"
                + "\"ts\":1758200000.5,\"durationNs\":\(value)}"
            guard case .malformed(let reason) = wire(candidate) else {
                return XCTFail("durationNs: \(value) 不许折成一个能读的数：\(wire(candidate))")
            }
            XCTAssertTrue(reason.contains("durationNs"), "\(value): \(reason)")
        }
    }

    /// 判据是"这个键在不在"，不是"值能不能读出来"：入口帧**省略**键（SDK 就是省略的），
    /// 显式 `null` 是一次自称有时长却说不出时长的畸形帧，不许混进入口帧那一支。
    /// REVERSE：撤掉修复后 `null` 那一支红（`.handler(durationNs: nil)` = 入口帧 → 抬高 hitCount）。
    func testAbsentKeyIsTheEntryFrameAndAnExplicitNullIsNot() throws {
        guard case .handler(_, _, _, let durationNs) = wire(Self.entryLine) else {
            return XCTFail("省略 durationNs 就是入口帧")
        }
        XCTAssertNil(durationNs)

        let nullLine = #"{"t":"handler","file":"View.swift","line":44,"ts":1758200000.5,"durationNs":null}"#
        guard case .malformed(let reason) = wire(nullLine) else {
            return XCTFail("显式 null 不是省略：\(wire(nullLine))")
        }
        XCTAssertTrue(reason.contains("durationNs"), reason)
        XCTAssertEqual(try hitCount(after: [Self.entryLine, nullLine]), 1)
    }

    /// `line` 的行为一个字节都不许变（本次修复只动 `durationNs`）。
    func testTheLineFieldRefusalIsUnchanged() {
        let outsideLine = #"{"t":"handler","file":"a.swift","line":4294967297}"#
        guard case .malformed(let reason) = wire(outsideLine) else {
            return XCTFail("超过 Int32 的行号仍然要拒：\(wire(outsideLine))")
        }
        XCTAssertTrue(reason.contains("line"), reason)

        let booleanLine = #"{"t":"handler","file":"a.swift","line":true}"#
        guard case .malformed(let booleanReason) = wire(booleanLine) else {
            return XCTFail("布尔行号仍然要拒：\(wire(booleanLine))")
        }
        XCTAssertTrue(booleanReason.contains("line"), booleanReason)
    }

    // MARK: - 3. summary 的长度单位必须是契约用的那个单位

    /// 已发布契约里 `summary.maxLength` 的**原文**（与 `SelectorTitleEmptinessTests` 同一手法：
    /// 判据数字从仓库里的真文件读，不在测试里手抄）。
    private func publishedSummaryBound() throws -> Int {
        let url = URL(fileURLWithPath: repoRoot + "/kernel/schemas/decision-log-entry.schema.json")
        let data = try Data(contentsOf: url)
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let properties = try XCTUnwrap(root["properties"] as? [String: Any])
        let summary = try XCTUnwrap(properties["summary"] as? [String: Any])
        return try XCTUnwrap((summary["maxLength"] as? NSNumber)?.intValue)
    }

    /// 执行那份契约的验证器里，同一个上限是以**哪个常量**发布的（zod 的 `z.string().max()`
    /// 读 `value.length` ⇒ UTF-16 码元）。
    ///
    /// 2026-10-23（缺陷 83）：这一臂**从前住在 Swift 里，而它在 Swift 那一格永远量不到**。
    /// 它读的是 `kernel/dist/decision-log-entry.js`——那个路径没有被 git 追踪（`git ls-files
    /// kernel/dist` 为空，是 2026-10-18 内核代码镜像退场后留在开发机上的旧副本），于是
    /// 本机 `swift test` 全绿、CI 的 `engine (Swift)` 那一格红：检出的树里根本没有那些字节。
    /// 更糟的是"量到了"这件事本身是假的——本机那份副本可以与装好的包不同号仍读出 2048。
    ///
    /// 这条量法现在搬到 `mcp-shell/test/kernel-validator-bound.test.mjs`：它读的是
    /// `node_modules/iterate-kernel/dist/decision-log-entry.js`（`mcp-shell/package.json`
    /// 用精确版本声明、`check-kernel-corpus.mjs` 的 shell 臂再核同号的那一份），
    /// 而 CI 的每个泳道在跑测试前都 `npm ci`。Swift 这里留下**两侧都是 tracked 字节**的那两臂。
    func testTheSummaryBoundIsTheSameOnTheTwoTrackedSides() throws {
        let bound = try publishedSummaryBound()
        XCTAssertEqual(DecisionLogEntry.summaryMaxLength, bound,
            "引擎侧的 summary 上限与被钉语料里的 maxLength 不同号：一个账本行会在一侧收下、另一侧拒掉")
        XCTAssertEqual(bound % 2, 0, "下面的 emoji 夹具假设一个 emoji = 2 个 UTF-16 码元")
    }

    private func decisionLogData(summary: String, dimension: String? = nil) throws -> Data {
        let fixture = try JSONSerialization.jsonObject(
            with: KernelFixtures.data("decision-log-entry.ok-01.json")
        )
        var object = try XCTUnwrap(fixture as? [String: Any])
        object["summary"] = summary
        if let dimension { object["dimension"] = dimension }
        return try JSONSerialization.data(withJSONObject: object)
    }

    /// REVERSE：把 `summary.utf16.count` 换回 `summary.count` → 超界那一条红（1025 个字素簇
    /// 在旧单位里"没超"），报错数字那一条也红（旧代码报的是 1025）。
    func testAstralSummaryIsRefusedAtExactlyTheLengthTheKernelRefusesIt() throws {
        let bound = try publishedSummaryBound()
        let emoji = "\u{1F600}"       // U+1F600 GRINNING FACE：1 个字素簇、1 个标量、2 个 UTF-16 码元

        let atBound = String(repeating: emoji, count: bound / 2)
        XCTAssertEqual(atBound.count, bound / 2, "字素簇数：\(atBound.count)")
        XCTAssertEqual(atBound.utf16.count, bound, "UTF-16 码元数：\(atBound.utf16.count)")
        XCTAssertNoThrow(
            try DecisionLogEntry.decodeAndValidate(decisionLogData(summary: atBound)),
            "恰好等于上限的一行，两侧都必须收下"
        )

        let overBound = String(repeating: emoji, count: bound / 2 + 1)
        XCTAssertEqual(overBound.count, bound / 2 + 1)
        XCTAssertLessThan(
            overBound.count, bound,
            "旧单位正是从这里开始漏判：字素簇数还在线上，契约的单位已经在线下"
        )
        XCTAssertEqual(overBound.utf16.count, bound + 2)
        XCTAssertThrowsError(try DecisionLogEntry.decodeAndValidate(decisionLogData(summary: overBound))) { error in
            XCTAssertEqual(
                error as? DecisionLogEntryError, .summaryTooLong(bound + 2),
                "报文报的必须是它据以判的那个单位：\(String(describing: error))"
            )
        }
    }

    /// 对照必须能过：ASCII 的一侧两种单位是同一个数，所以这条两侧都不许漂。
    func testASCIISummaryKeepsItsVerdictsAtTheBound() throws {
        let bound = try publishedSummaryBound()
        let fitting = String(repeating: "a", count: bound)
        XCTAssertEqual(fitting.count, fitting.utf16.count)
        XCTAssertNoThrow(try DecisionLogEntry.decodeAndValidate(decisionLogData(summary: fitting)))

        let over = String(repeating: "a", count: bound + 1)
        XCTAssertThrowsError(try DecisionLogEntry.decodeAndValidate(decisionLogData(summary: over))) { error in
            XCTAssertEqual(error as? DecisionLogEntryError, .summaryTooLong(bound + 1))
        }
        // 内核 fixture 自己那行仍然合法——修复不许把已有的账本行判死。
        XCTAssertNoThrow(try DecisionLogEntry.decodeAndValidate(
            KernelFixtures.data("decision-log-entry.ok-01.json")
        ))
    }

    /// `dimension.count` 这条我核对过（REVERSE 无关，是把核对写进代码）：
    /// `dimensionRegex` 与内核的 `DIMENSION_ID_PATTERN` 是同一串字符类
    /// `^[a-z0-9]+(?:-[a-z0-9]+)*$`——能过闸的串只可能由 `a`…`z`、`0`…`9`、`-` 组成，
    /// 其中没有任何一个占两个码元，所以对**任何被接受的** dimension 都有
    /// `count == utf16.count`：字素簇与 UTF-16 码元在这一格是同一个数，单位不用改。
    /// 这里的判据也确实不是长度：10 个 emoji（10 簇 / 20 码元）远在 64 以下，拒它的是模式。
    func testDimensionIsRefusedByItsPatternBeforeAnyLengthQuestionArises() throws {
        let astral = String(repeating: "\u{1F600}", count: 10)
        XCTAssertEqual(astral.count, 10)
        XCTAssertEqual(astral.utf16.count, 20)
        XCTAssertLessThan(astral.utf16.count, DecisionLogEntry.dimensionMaxLength)
        XCTAssertThrowsError(
            try DecisionLogEntry.decodeAndValidate(
                decisionLogData(summary: "a decision", dimension: astral)
            )
        ) { error in
            XCTAssertEqual(error as? DecisionLogEntryError, .badDimension(astral), "拒它的是模式不是长度")
        }

        let legal = String(repeating: "a", count: DecisionLogEntry.dimensionMaxLength)
        XCTAssertEqual(legal.count, legal.utf16.count, "被接受的 dimension 只会是 ASCII，两种单位同数")
        XCTAssertNoThrow(try DecisionLogEntry.decodeAndValidate(
            decisionLogData(summary: "a decision", dimension: legal)
        ))
        XCTAssertNoThrow(try DecisionLogEntry.decodeAndValidate(
            decisionLogData(summary: "a decision", dimension: "performance-budget")
        ))
        XCTAssertThrowsError(try DecisionLogEntry.decodeAndValidate(
            decisionLogData(summary: "a decision", dimension: legal + "b")
        ))
    }
}
