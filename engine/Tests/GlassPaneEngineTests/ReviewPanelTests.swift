import XCTest
import GlassPaneEngine
@testable import glasspane_settings

/// 复核 2026-10-09 那组发现之后钉下的闸：**面板只许说实测到的东西**。
///
/// 每一条例子都是同一类毛病的两个方向——没测过的东西亮着（残留 socket 让页脚写
/// 「运行中」、读不到位置却把滑块画在「关」上），或者证据过期了还亮着（上一次
/// 实测的徽标压在一次超时上面、退役的 daemon 路径一直被 exec）。
/// 每条都写明**什么改动会把它变红**；抓不住反向改动的断言等于没写。
///
/// `glasspane-settings` 是这个测试目标的依赖，所以下面这些判定是**被执行**的。
/// 只有单测点不到的 SwiftUI 表面才退回读源码，那些条目的名字里都带 `Shape`。
@MainActor
final class ReviewPanelTests: XCTestCase {

    // MARK: - 存活判定（发现 1）：绿点背后必须是一次真实握手

    /// 反向变异：**把 `fileExists` 当存活判据**（改回 `transport.reachable(...)`，
    /// 或再加一句「探测失败不推翻上一次 reachable=true」）——残留 socket 会点亮
    /// 「运行中」，而同一页四张权限卡说服务没在运行。
    func testSocketFileThatAnswersNothingIsNotRunning() async {
        let model = makeSettingsModel(DaemonProbe(
            fileExists: { _ in true },
            rawTransport: { _, _, _ in .occupied(reason: "read: Operation timed out") }
        ))
        model.refresh()
        await waitUntil { model.daemon.liveness != .unmeasured }

        XCTAssertNotEqual(model.daemon.liveness, .answering,
                          "有人接了连接却没回话，这一枚灯就不许是运行中")
        XCTAssertEqual(model.daemon.liveness, .presentButSilent(reason: "read: Operation timed out"))
        XCTAssertEqual(SettingsModel.livenessTone(model.daemon.liveness), .warning)
        let caption = SettingsModel.livenessCaption(model.daemon.liveness, footer: true)
        XCTAssertTrue(caption.contains("没回话"), "第三种结局要有它自己那句话：\(caption)")
        XCTAssertNil(model.daemon.version, "没回话就没有版本号可报")
        XCTAssertNil(model.daemon.subject, "没回话就没有授权主体可报")
        // 权限卡那句注记也跟着分家：借「未在运行」那句会把人支去重启一个其实活着的进程。
        XCTAssertEqual(model.entries.first { $0.kind == .accessibility }?.statusNote,
                       SettingsModel.silentDaemonReportNote)
    }

    /// 反向变异：**「文件都不在」那一支被画成警示点**、或干脆画成运行中。
    func testMissingSocketFileIsNotRunning() async {
        let model = makeSettingsModel(DaemonProbe(
            fileExists: { _ in false },
            rawTransport: { _, _, _ in .noListener(reason: "no socket file") }
        ))
        model.refresh()
        await waitUntil { model.daemon.liveness != .unmeasured }

        XCTAssertEqual(model.daemon.liveness, .notRunning)
        XCTAssertEqual(SettingsModel.livenessCaption(model.daemon.liveness, footer: true), "后台服务未运行")
        XCTAssertEqual(SettingsModel.livenessTone(model.daemon.liveness), .bad)
        XCTAssertEqual(model.status(of: .accessibility), .unverifiable)
        XCTAssertEqual(model.entries.first { $0.kind == .accessibility }?.statusNote,
                       SettingsModel.noDaemonReportNote)
    }

    /// 反向变异：**真回话那一支不再把自报席位落到卡上**（只剩一个亮点），
    /// 或 hello 的解析被换成了面板自己代测。
    func testAnsweredHelloIsTheOnlyThingThatLightsTheIndicator() async {
        let hello = Data(helloJSON(version: "1.9.0", pid: 4242).utf8)
        let model = makeSettingsModel(DaemonProbe(
            fileExists: { _ in true },
            rawTransport: { _, _, _ in .answered(hello) }
        ))
        model.refresh()
        await waitUntil { model.daemon.liveness == .answering }

        XCTAssertEqual(model.daemon.liveness, .answering)
        XCTAssertEqual(model.daemon.version, "1.9.0")
        XCTAssertEqual(model.daemon.pid, 4242)
        XCTAssertEqual(SettingsModel.daemonSummaryLine(model.daemon), "运行中 1.9.0")
        XCTAssertEqual(SettingsModel.livenessTone(model.daemon.liveness), .good)
        XCTAssertEqual(model.status(of: .accessibility), .granted, "自报席位必须真的落到卡上")
        XCTAssertEqual(model.status(of: .screenRecording), .denied)
        XCTAssertNil(model.entries.first { $0.kind == .accessibility }?.statusNote)
    }

    /// 反向变异：**这一轮没回话时保留上一轮的判定**（就是被发现的那句原注释）——
    /// 灯会一直亮到面板关掉为止。
    func testFailedHelloClearsAnIndicatorThatWasLitBefore() async {
        let answering = AnswerBox()
        let hello = Data(helloJSON(version: "1.9.0", pid: 7).utf8)
        let model = makeSettingsModel(DaemonProbe(
            fileExists: { _ in true },
            rawTransport: { _, _, _ in
                answering.isOn ? .answered(hello) : .occupied(reason: "listener closed without answering")
            }
        ))
        model.refresh()
        await waitUntil { model.daemon.liveness == .answering }
        XCTAssertEqual(model.daemon.version, "1.9.0")

        answering.isOn = false
        model.refresh()
        await waitUntil { model.daemon.liveness != .answering }
        XCTAssertNotEqual(model.daemon.liveness, .answering,
                          "没了回话就该灭；留着上一次的测量冒充现状是同一类缺陷")
        XCTAssertNil(model.daemon.version)
        XCTAssertNil(model.daemon.pid)
        XCTAssertEqual(model.status(of: .accessibility), .unverifiable)
    }

    /// 四种结局各有自己的文案、点色与标识（并成两态就是这一次发现的形状）。
    func testTheLivenessAnswersAreFourDifferentThings() {
        let states: [SettingsModel.DaemonLiveness] = [
            .unmeasured, .answering, .notRunning, .presentButSilent(reason: "x"),
        ]
        XCTAssertEqual(Set(states.map { SettingsModel.livenessCaption($0, footer: true) }).count, states.count)
        XCTAssertEqual(Set(states.map { SettingsModel.livenessCaption($0, footer: false) }).count, states.count)
        XCTAssertEqual(Set(states.map { SettingsModel.livenessIdentifier($0) }).count, states.count)
        XCTAssertEqual(SettingsModel.livenessTone(.unmeasured), .neutral, "没实测过不许点亮，也不许点红")
        XCTAssertEqual(SettingsModel.livenessTone(.answering), .good)
        XCTAssertEqual(SettingsModel.livenessTone(.notRunning), .bad)
        XCTAssertEqual(SettingsModel.livenessTone(.presentButSilent(reason: "x")), .warning,
                       "应门不回话既不是运行中也不是未运行")
        for state in states {
            let text = SettingsModel.livenessCaption(state, footer: true)
            XCTAssertFalse(text.contains("<"), "尖括号占位符用户按它做不了任何事：\(text)")
            XCTAssertFalse(text.contains("reachable"), "把内部字段名印到页面上：\(text)")
            XCTAssertFalse(text.contains("§"), "给人读的那一句里不许有内部编号：\(text)")
        }
    }

    // MARK: - 调试能力徽标（发现 4）：失败必须作废上一次的实测

    /// 反向变异：**失败那一支只写错误、不作废旧结论**（`capabilityMarker` 于是继续
    /// 优先显示 `.concluded`），徽标写着「可用（实测）」而下面一行说这次超时。
    func testFailedVerificationDoesNotLeaveTheMeasuredBadge() {
        let model = makeSettingsModel(DaemonProbe())
        model.developerToolsCapability = DeveloperToolsCapability.Report(
            launch: "ok", attach: "ok", granted: true, observedAt: Date()
        )
        model.developerToolsProbePid = 4242
        let before = badge(for: model)
        XCTAssertEqual(before.text, "可用（实测）")
        XCTAssertEqual(before.status, .granted)

        model.recordProbeFailure(.timedOut)

        XCTAssertNil(model.developerToolsCapability, "这次没测成，上一次的结论就不再代表现状")
        XCTAssertNil(model.developerToolsProbePid)
        XCTAssertEqual(model.capabilityMarker, PermissionGuide.CapabilityMarker.failed(.timedOut))
        let after = badge(for: model)
        XCTAssertEqual(after.status, .unverifiable)
        XCTAssertEqual(after.text, "未验证", "徽标与那一行结论必须同意：\(after.text)")
        XCTAssertNotEqual(after.identifier, before.identifier)
    }

    // MARK: - daemon 程序路径（发现 5 + 发现 10b）：跟着每一帧 hello 走

    /// 反向变异：**只在 `== nil` 时赋值**（发现的那处），重装/重开之后
    /// 清理/删除/校验/统计一直在 exec 那份已经退役的二进制。
    func testEveryReportedPathReplacesTheRetiredOne() {
        let console = makeConsole()
        console.adoptDaemonReport(
            binaryPath: "/opt/glasspane-1.app/Contents/MacOS/glasspaned", answered: true
        )
        XCTAssertEqual(console.daemonBinaryPath, "/opt/glasspane-1.app/Contents/MacOS/glasspaned")
        console.adoptDaemonReport(
            binaryPath: "/opt/glasspane-2.app/Contents/MacOS/glasspaned", answered: true
        )
        XCTAssertEqual(console.daemonBinaryPath, "/opt/glasspane-2.app/Contents/MacOS/glasspaned",
                       "第二次 hello 报的那个路径必须赢：页面写的与按钮 exec 的不能是两份程序")
        // 这一帧没自报（旧 daemon / 没连上）不等于路径没了：清空它会把写入动作整个断掉。
        console.adoptDaemonReport(binaryPath: nil, answered: false)
        XCTAssertEqual(console.daemonBinaryPath, "/opt/glasspane-2.app/Contents/MacOS/glasspaned")
        console.adoptDaemonReport(binaryPath: "   ", answered: false)
        XCTAssertEqual(console.daemonBinaryPath, "/opt/glasspane-2.app/Contents/MacOS/glasspaned",
                       "空白路径不是路径")
    }

    /// 反向变异：**按下「重启后台服务」就把 `pruneNeedsRestart` 抹掉**——点一下
    /// 不构成重启成功，那句话只能等服务重新应门之后撤。
    func testRestartNoticeSurvivesTheClickAndClearsOnAnAnsweredHello() {
        let console = makeConsole()
        console.pruneNeedsRestart = true
        console.adoptDaemonReport(binaryPath: "/opt/glasspane/glasspaned", answered: false)
        XCTAssertTrue(console.pruneNeedsRestart, "没应门就没有「重启好了」的证据")
        console.adoptDaemonReport(binaryPath: "/opt/glasspane/glasspaned", answered: true)
        XCTAssertFalse(console.pruneNeedsRestart)
    }

    // MARK: - daemon 统计（发现 6）：路径到了要重问，重试要真重问

    /// 反向变异：**只在卡片 `.onAppear` 问一次**——那一刻 hello 还没落地、路径还是
    /// nil，这一栏就永远停在「不可达」，而页面上的「刷新」再没碰过它。
    func testStatsAreAskedWhenThePathArrivesAndNeverBefore() async throws {
        let reply = #"{"count":3,"totalBytes":42,"listFailure":null,"dir":"/tmp/evidence"}"#
        let script = try writeShellFixture(answer: reply)
        let console = makeConsole()
        XCTAssertEqual(console.daemonStats, .notAsked)
        console.refreshDaemonStats()
        XCTAssertEqual(console.daemonStats, .notAsked,
                       "路径还不知道时不许发一次假的请求，更不许把没发过写成发了但不可达")

        console.adoptDaemonReport(binaryPath: script, answered: true)
        await waitUntil { console.daemonStats.isLoaded }
        XCTAssertEqual(console.daemonStats,
                       ConsoleModel.DaemonStats.loaded(
                           count: 3, totalBytes: 42, listFailure: nil, dir: "/tmp/evidence"
                       ))
    }

    /// 反向变异：**输出没形状也算问到**（garbage 被读成一份 loaded），或者
    /// `listFailure` 这个键缺席时凭空造出一句失败。
    func testUnshapedStatsReplyIsUnreachableNotZeroes() {
        for garbage in ["", "   ", "not json", "{}", "[1,2]", "总条数：3"] {
            XCTAssertNil(ConsoleModel.parseDaemonStats(garbage),
                         "读不出形状就是没读到：\(garbage.debugDescription)")
        }
        XCTAssertEqual(ConsoleModel.foldDaemonStats(fromCLIReply: nil), .unreachable, "起不来不等于零条")
        // 缺 `listFailure` 键（旧 daemon）：读成 nil，不是读成一句失败，也不是读成整行作废。
        let legacy = ConsoleModel.parseDaemonStats(#"{"count":0,"totalBytes":0,"dir":"/x"}"#)
        XCTAssertEqual(legacy, .loaded(count: 0, totalBytes: 0, listFailure: nil, dir: "/x"))
    }

    // MARK: - 单条档案（发现 7）：读不出要说读不出，不许永远转圈

    /// 反向变异：**把解不开折算成 `selectedPack = nil`**——详情页对 nil 只有一句
    /// 「正在读取这条档案……」，于是卡在一个不会再出答案的转圈上，没有错误也没有重试。
    func testUnreadablePackEndsInFailedNotLoading() async {
        let console = makeConsole(
            scan: ConsoleModel.EvidenceScanOutcome(
                summaries: [summaryStub(filePath: "/tmp/glasspane-gone.json")],
                unreadableFiles: [], directoryExists: true, totalBytes: 512, listFailure: nil
            ),
            packReader: { _ in nil }
        )
        console.reloadEvidence()
        await waitUntil {
            if case .failed = console.packLoad { return true }
            return false
        }
        guard case .failed(let reason) = console.packLoad else {
            return XCTFail("读不出的档案必须落在 failed，现在停在：\(console.packLoad)")
        }
        XCTAssertFalse(reason.isEmpty)
        XCTAssertTrue(reason.contains("/tmp/glasspane-gone.json"), "要说清读不出的是哪一条：\(reason)")
        XCTAssertFalse(reason.contains("正在读取"), "读不出不能写成还在读：\(reason)")
        XCTAssertNil(console.selectedPack)
    }

    /// 反向变异：**成功那一支也被判成读不出**（默认读法被顺手改掉）。
    /// 这一条走的是**默认**扫描与**默认**读取：真落一份内核夹具档案到沙箱里。
    func testReadablePackStillLoadsThroughTheDefaultReader() async throws {
        let directory = TestSandbox.directory("review-default-pack")
        let pack = try EvidencePack.decodeAndValidate(KernelFixtures.data("evidence-pack.ok-01.json"))
        try KernelFixtures.data("evidence-pack.ok-01.json").write(
            to: URL(fileURLWithPath: directory + "/" + pack.operationId + ".json")
        )
        let console = ConsoleModel(
            evidenceDirectory: directory,
            projectsPath: TestSandbox.filePath("review-projects"),
            approvalsPath: TestSandbox.filePath("review-approvals")
        )
        console.reloadEvidence()
        await waitUntil { console.selectedPack != nil }
        if case .loaded(let loaded) = console.packLoad {
            XCTAssertEqual(loaded.operationId, pack.operationId)
        } else {
            XCTFail("读得出来就该是 loaded：\(console.packLoad)")
        }
        XCTAssertEqual(console.evidenceState, .loaded)
    }

    // MARK: - 目录读不了（发现 8）：那个零不是「这里没有档案」

    /// 反向变异：**「读不了」与「空目录」共用一支**（发现的那处 `directoryExists=true`
    /// + `summaries=[]` → 「档案目录是空的」），`evidenceState` 永远到不了 `.failed`，
    /// 于是那一屏的重试入口根本走不到。
    func testListingFailureFailsWhileAnEmptyDirectoryStaysEmpty() {
        let readable = ConsoleModel.EvidenceScanOutcome(
            summaries: [], unreadableFiles: [], directoryExists: true, totalBytes: 0, listFailure: nil
        )
        XCTAssertEqual(ConsoleModel.foldEvidenceState(outcome: readable, listFailure: nil), .empty,
                       "读得动又确实一条没有，才是空")
        let absent = ConsoleModel.EvidenceScanOutcome(
            summaries: [], unreadableFiles: [], directoryExists: false, totalBytes: 0, listFailure: nil
        )
        XCTAssertEqual(ConsoleModel.foldEvidenceState(outcome: absent, listFailure: nil), .empty)

        let failure = "cannot read the evidence archive to count it"
        guard case .failed(let message) = ConsoleModel.foldEvidenceState(
            outcome: readable, listFailure: failure
        ) else {
            return XCTFail("后台服务报了读不了，状态就不许是空目录")
        }
        XCTAssertTrue(message.contains(failure), "原话要带出来好跟日志核对：\(message)")
        XCTAssertFalse(message.contains("空的"), "读不了不能被写成空目录：\(message)")

        // 目录在、文件一个都解不开：同样不是「空」。
        let undecodable = ConsoleModel.EvidenceScanOutcome(
            summaries: [], unreadableFiles: ["a.json", "b.json"],
            directoryExists: true, totalBytes: 0, listFailure: nil
        )
        guard case .failed(let tooBroken) = ConsoleModel.foldEvidenceState(
            outcome: undecodable, listFailure: nil
        ) else {
            return XCTFail("两个读不开的文件不是「档案目录是空的」")
        }
        XCTAssertTrue(tooBroken.contains("2"), tooBroken)

        let oneLoaded = ConsoleModel.EvidenceScanOutcome(
            summaries: [summaryStub(filePath: "/x/a.json")], unreadableFiles: ["b.json"],
            directoryExists: true, totalBytes: 8, listFailure: nil
        )
        XCTAssertEqual(ConsoleModel.foldEvidenceState(outcome: oneLoaded, listFailure: nil), .loaded,
                       "读到一条是一条：剩下的读不开由 unreadableFiles 那一句说")
    }

    /// 反向变异：**`listFailure` 这一路没接进列表状态**（只接了那张统计卡），
    /// 列表页就还在对着读不了的档案写「还没有证据档案」。
    func testDaemonReportedListFailureReachesTheEvidenceState() async throws {
        let reply = """
        {"count":null,"totalBytes":null,\
        "listFailure":"cannot read the evidence archive to count it","dir":"/tmp/evidence"}
        """
        let script = try writeShellFixture(answer: reply)
        let console = makeConsole(
            scan: ConsoleModel.EvidenceScanOutcome(
                summaries: [], unreadableFiles: [], directoryExists: true, totalBytes: 0, listFailure: nil
            )
        )
        console.daemonBinaryPath = script
        console.reloadEvidence()
        console.refreshDaemonStats()
        await waitUntil {
            if case .failed = console.evidenceState { return true }
            return false
        }
        guard case .failed(let message) = console.evidenceState else {
            return XCTFail("daemon 报了读不了，列表页状态就该是 failed：\(console.evidenceState)")
        }
        XCTAssertTrue(message.contains("cannot read the evidence archive to count it"), message)
    }

    // MARK: - 重启结局（发现 9）：本轮的两条断言让给了上游那份更完整的实现

    // 本轮这里原有两条：`restartOutcomeHint(exitStatus:)` 的三档，与"hint 必须被渲染"
    // 的形状闸。合并时上游那版重启判定是超集（`restartVerdict` 用 pid 回读、
    // `restartLaunchStepOutcome` 把 launchctl 那一层分开、失败态一律给得出下一步、
    // `manualRestartHint` 终于有读者），且 `PanelActionReadoutTests` 逐条钉住
    // （nil→.spawnFailed、每个失败态点名下一步、pid 没变不算确认）。同一个修复不留两把闸，
    // 两条随之删除；删的是重复的测试，不是被护住的行为。

    // MARK: - 徽标同源（发现 10c）：一张卡不许说两件事

    /// 反向变异：**图标与标识跟着 `entry.status`、文字跟着实测状态**（发现的那处
    /// 417 与 519-522 分家），人读到「可用（实测）」而自动化读到 `unverifiable`。
    func testBadgeTextIconAndIdentifierComeFromOneMeasurement() {
        let measured = PermissionBadge.make(kind: .developerTools, reported: .unverifiable, measured: .granted)
        XCTAssertEqual(measured.text, "可用（实测）")
        XCTAssertEqual(measured.icon, PermissionGuide.statusIcon(for: .granted), "图标得和文字说的是同一次测量")
        XCTAssertEqual(measured.identifier,
                       PermissionGuide.statusIdentifier(kind: .developerTools, status: .granted),
                       "自动化读到的状态必须是肉眼看到的那一个")

        let reportedOnly = PermissionBadge.make(kind: .accessibility, reported: .granted, measured: nil)
        XCTAssertEqual(reportedOnly.text, "已授权")
        XCTAssertFalse(reportedOnly.text.contains("实测"), "没有实测结论就不许声称实测：\(reportedOnly.text)")
        XCTAssertEqual(reportedOnly.icon, PermissionGuide.statusIcon(for: .granted))

        let denied = PermissionBadge.make(kind: .developerTools, reported: .unverifiable, measured: .denied)
        XCTAssertEqual(denied.text, "被拒绝（实测）")
        XCTAssertEqual(denied.identifier,
                       PermissionGuide.statusIdentifier(kind: .developerTools, status: .denied))

        let unknown = PermissionBadge.make(kind: .screenRecording, reported: .unverifiable, measured: nil)
        XCTAssertEqual(unknown.text, "未验证")
        XCTAssertEqual(unknown.icon, PermissionGuide.statusIcon(for: .unverifiable))
    }

    // MARK: - 台账文件那一枚（发现 10d）

    /// 反向变异：**按钮永远可用**——没有台账时按下只是让访达开到别处，静默无反应。
    func testLedgerButtonIsDisabledUntilTheFileIsKnownToBeThere() {
        XCTAssertFalse(ConsoleModel.ledgerRevealable(report: nil), "没读过就不知道在不在")
        XCTAssertFalse(ConsoleModel.ledgerRevealable(report: ledger(fileExists: false)))
        XCTAssertTrue(ConsoleModel.ledgerRevealable(report: ledger(fileExists: true)))
        XCTAssertTrue(ConsoleModel.ledgerUnavailableReason(report: nil).contains("刷新"),
                      "禁用要给出做得动的那一步")
        let missing = ConsoleModel.ledgerUnavailableReason(report: ledger(fileExists: false))
        XCTAssertFalse(missing.contains("刷新"), "没读过与确实没有是两件事：\(missing)")
        XCTAssertTrue(missing.contains("还没有"), missing)
    }

    // MARK: - 形状闸（SwiftUI 表面单测点不到，只能读源码；名字里都带 Shape）

    /// 形状闸：自动更新那一格读不到时**不许画一个停在「关」上的滑块**（发现 2 的
    /// 视图那一半；判定层的 `toggleEnabled` 由 UpdatePanelTests 执行）。
    func testShapeAutoSwitchDoesNotDefaultToOff() throws {
        let source = try readSource("engine/Sources/glasspane-settings/UpdateTabView.swift")
        XCTAssertFalse(source.contains("autoUpdateOn ?? false"),
                       "把读不到折算成关，就是替这台机器编了一个它没说过的决定")
        XCTAssertTrue(source.contains("UpdatePanel.autoSwitchUnknownText"), "读不到要有它自己那一格")
        XCTAssertTrue(source.contains("if let on = model.autoUpdateOn"),
                       "开关只在该位置真的读到时才画出来")
    }

    /// 形状闸：证据统计的两条重问入口必须接得住（发现 6 的视图那一半）。
    func testShapeStatsRetryIsWiredIntoTheView() throws {
        let stats = try readSource("engine/Sources/glasspane-settings/EvidenceStatsView.swift")
        let tab = try readSource("engine/Sources/glasspane-settings/EvidenceTabView.swift")
        XCTAssertFalse(stats.contains("@State private var daemonResult"),
                       "统计结果回到卡片自己的 State，就又在模型外面：路径到达时没人重问")
        XCTAssertTrue(stats.contains("model.refreshDaemonStats()"), "卡片要问模型那一份")
        XCTAssertTrue(tab.contains("model.refreshDaemonStats()"),
                      "证据页的「刷新」必须把 daemon 统计一起重问")
        XCTAssertTrue(stats.contains("model.daemonStats"), "卡上呈现的是模型实测到的那份结局")
    }

    /// 形状闸：详情页的失败分支要给得出动作（发现 7 的视图那一半）。
    func testShapeFailedPackOffersRetry() throws {
        let tab = try readSource("engine/Sources/glasspane-settings/EvidenceTabView.swift")
        XCTAssertTrue(tab.contains("case .failed(let reason)"), "读不出那一支要在页面上现身")
        XCTAssertTrue(tab.contains("model.reloadSelectedPack()"), "并且给出做得动的那一步")
        XCTAssertTrue(tab.contains("packLoad: model.packLoad"),
                      "详情页不能再只看 pack 是不是 nil")
    }

    /// 形状闸：重启结论那句必须真的被渲染（发现 9 的视图那一半）。上游把状态换成了
    /// `restartOutcomeText` + `gp-restart-outcome`，这里跟着改指它——留这条而不是删掉，
    /// 是因为 `PanelActionReadoutTests` 的"发布态有没有读者"扫的是模型属性被读，
    /// 而这一条要钉的是**两页都渲染了它**（权限页与项目页各一处）。
    func testShapeRestartOutcomeIsRenderedOnBothPages() throws {
        let panel = try readSource("engine/Sources/glasspane-settings/SettingsPanelView.swift")
        let projects = try readSource("engine/Sources/glasspane-settings/ProjectsTabView.swift")
        XCTAssertTrue(panel.contains("model.restartOutcomeText"),
                      "权限页要把重启结局渲染出来，否则它又是一句写好了却没人接的话")
        XCTAssertTrue(projects.contains("settings.restartOutcomeText"),
                      "项目页那枚「重启后台服务」同样要看得见失败")
        XCTAssertTrue(projects.contains("gp-restart-outcome"),
                      "结论要有可指认的标识，自动化才测得到它现身")
    }

    /// 形状闸：项目页那枚死路按钮不再挂着破坏性动作（发现 10e）。
    func testShapeDeadEndPruneButtonIsNotDestructive() throws {
        let source = try readSource("engine/Sources/glasspane-settings/ProjectsTabView.swift")
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        XCTAssertFalse(source.contains("prunePreview.isEmpty ? \"知道了\""),
                       "「知道了」又变成一枚灰掉的破坏性按钮")
        // 合并后这里允许出现清除，但**必须带实测前提**：`if case .confirmed = outcome`
        // 才算重启成功。无条件抹掉这句（点一下就算重启好了）才是这一条要挡的形状。
        let clears = lines.filter {
            $0.contains("pruneNeedsRestart = false") && $0.contains("model.")
        }
        XCTAssertFalse(clears.isEmpty,
                       "重启确认之后总得有人撤掉这句横幅；一条清除都没有就是另一回事了")
        for line in clears {
            XCTAssertTrue(line.contains("case .confirmed"),
                          "抹掉这句只能凭实测确认，不能凭一次点击：\(line)")
        }
        let index = try XCTUnwrap(
            lines.firstIndex { $0.contains("知道了") && $0.contains("Button(") },
            "那一枚按钮不见了"
        )
        let deadEnd = lines[index]
        XCTAssertTrue(deadEnd.contains("isPruneSheetPresented = false"),
                      "死路那一支给的必须是关掉这一屏：\(deadEnd)")
        XCTAssertFalse(deadEnd.contains("confirmPrune"), "同一枚按钮不许还挂着清理动作：\(deadEnd)")
        XCTAssertFalse(deadEnd.contains(".disabled"), "按得动的按钮不该再灰着：\(deadEnd)")
    }

    // MARK: - 夹具

    /// 一个能翻面的「有没有回话」开关（闭包里捕获 `var` 在并发检查下会散架）。
    private final class AnswerBox: @unchecked Sendable {
        var isOn = true
    }

    private func helloJSON(version: String, pid: Int) -> String {
        """
        {"result":{"version":"\(version)","protocolVersion":"1.1","pid":\(pid),\
        "identity":{"binaryPath":"/opt/glasspane.app/Contents/MacOS/glasspaned","hasBundleIdentity":false},\
        "permissions":{"accessibility":"granted","inputMonitoring":"notDetermined","screenRecording":"denied"}}}
        """
    }

    private func fakeProbes() -> PermissionProbeSet {
        PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(trustCheck: { false }, prompt: {}, openPane: {}),
            inputMonitoring: InputMonitoringPermissionProbe(preflight: { false }, requestAccess: {}, openPane: {}),
            screenRecording: ScreenCapturePermissionProbe(preflight: { false }, requestAccess: {}),
            developerTools: DeveloperToolsPermissionProbe(openPane: {}),
            inputTapProbe: { false },
            subjectProvider: { PermissionSubject(binaryPath: "/opt/glasspane/panel") }
        )
    }

    private func makeSettingsModel(_ probe: DaemonProbe) -> SettingsModel {
        SettingsModel(
            socketPath: TestSandbox.filePath("review-socket"),
            refreshOnAppear: false,
            probes: fakeProbes(),
            daemonProbe: probe
        )
    }

    private func makeConsole(
        scan: ConsoleModel.EvidenceScanOutcome? = nil,
        packReader: ((String) -> EvidencePack?)? = nil
    ) -> ConsoleModel {
        ConsoleModel(
            evidenceDirectory: TestSandbox.directory("review-evidence"),
            projectsPath: TestSandbox.filePath("review-projects"),
            approvalsPath: TestSandbox.filePath("review-approvals"),
            evidenceScanner: ReviewPanelTests.fixedScan(scan),
            packReader: packReader
        )
    }

    /// 把一个固定结局包成扫描器；nil = 不注入（走默认真实扫描）。
    private static func fixedScan(
        _ outcome: ConsoleModel.EvidenceScanOutcome?
    ) -> ((String) -> ConsoleModel.EvidenceScanOutcome)? {
        guard let outcome else { return nil }
        return { _ in outcome }
    }

    private func summaryStub(filePath: String) -> EvidenceSummary {
        EvidenceSummary(
            operationId: "op-review-1", createdAt: "2026-10-09T00:00:00.000Z",
            schemaVersion: EvidencePack.schemaVersionConst, action: "press",
            selectorRole: "AXButton", selectorTitle: "提交", actConfirmed: true,
            axChanged: nil, treeChanged: nil, nodeCount: nil, latencyMs: nil,
            pixelRatio: nil, attributionLevel: "strong", contaminated: false,
            circuitBreakerLevel: 0, diagnosisClass: nil, assertionPassed: nil,
            stateChanged: nil, processAliveAfter: nil, fileBytes: 512, filePath: filePath
        )
    }

    private func ledger(fileExists: Bool) -> ApprovalLedgerReport {
        ApprovalLedgerReport(
            records: [], chainValid: true, firstBrokenIndex: nil,
            loadFailed: false, fileExists: fileExists, autoApprovedHighRiskCount: 0
        )
    }

    /// 详情页徽标的现在读数（视图里那三元取值在这里跑一遍）。
    private func badge(for model: SettingsModel) -> PermissionBadge {
        PermissionBadge.make(
            kind: .developerTools,
            reported: model.status(of: .developerTools),
            measured: model.developerToolsCapability?.status
        )
    }

    /// 一个「照契约回一行」的假 daemon CLI 夹具。
    private func writeShellFixture(answer: String) throws -> String {
        let script = TestSandbox.directory("review-daemon") + "/glasspaned"
        let body = """
        #!/bin/sh
        printf '%s\\n' '\(answer.replacingOccurrences(of: "'", with: "'\\''"))'
        exit 0
        """
        try body.write(toFile: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script)
        return script
    }

    /// 仓库根：测试文件在 `engine/Tests/GlassPaneEngineTests/` 下。
    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.path
    }

    private func readSource(_ relative: String) throws -> String {
        let path = repoRoot + "/" + relative
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(relative)；这一条对照在没有该文件的环境里不作数")
        }
        return text
    }

    private func waitUntil(timeoutSeconds: Int = 20, _ condition: @MainActor () -> Bool) async {
        for _ in 0..<(timeoutSeconds * 20) {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        _ = condition()
    }
}
