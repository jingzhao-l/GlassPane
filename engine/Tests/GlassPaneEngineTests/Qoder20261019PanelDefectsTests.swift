import XCTest
import GlassPaneEngine
@testable import glasspane_settings

/// Qoder lane 2026-10-19（面板 / daemon CLI 收口）——本文件补的是**行为**那一半。
///
/// 与 `QoderPanel20261019Tests`（同一批缺陷的源码形状闸）的分工：那一份钉"这处改了
/// 没有"，这一份钉"改完之后它在真实输入上真的这么说"。两条都留着，因为形状闸能证
/// 分支的存在却证不到它被走到，而行为测试反过来会漏掉整块没接线的代码。
///
/// 每条都写明什么改动会把它变红（本仓的规矩：跑不到拒绝分支的闸不是闸）。

/// 一条读得出的档案：`revealFileControl` 只认**这一支有没有整包**，不认包里的内容，
/// 所以这里给的是最小合法形状（与 `EngineP1Batch4Tests` 的夹具同源）。
private enum Gp20261019Pack {
    static let loaded = EvidencePack(
        operationId: "op_0123456789ABCDEFGHJKMNPQRS",
        createdAt: "2026-10-19T04:00:00.000Z",
        attribution: Attribution(level: .soft, contaminated: false),
        circuitBreaker: CircuitBreaker(level: .normal),
        signals: Signals(act: ActSignal(
            selector: Selector(role: "AXButton", title: "Submit"),
            action: .press,
            actConfirmed: true
        ))
    )
}

// MARK: - 夹具

/// 固定席位探针：构造面板模型时一次都不碰真 TCC（同 `PermissionSubjectTests` 的定式）。
enum Gp20261019FakeProbes {
    static func set(granted: Bool = false) -> PermissionProbeSet {
        PermissionProbeSet(
            accessibility: AccessibilityPermissionProbe(
                trustCheck: { granted }, prompt: { XCTFail("假席位不该触发真申请面") }, openPane: {}),
            inputMonitoring: InputMonitoringPermissionProbe(
                preflight: { granted }, requestAccess: { XCTFail("假席位不该触发真申请面") }, openPane: {}),
            screenRecording: ScreenCapturePermissionProbe(
                preflight: { granted }, requestAccess: { XCTFail("假席位不该触发真申请面") }),
            developerTools: DeveloperToolsPermissionProbe(openPane: {}),
            inputTapProbe: { false },
            subjectProvider: { PermissionSubject(binaryPath: "/opt/glasspane/glasspaned") }
        )
    }
}

/// 一个"有监听者却不开口"的 daemon 探测：面板手里第三种实测结局，从前没有任何
/// 一条路径能把它的红行点亮。
private func silentDaemonProbe(reason: String) -> DaemonProbe {
    DaemonProbe(
        fileExists: { _ in true },
        rawTransport: { _, _, _ in .occupied(reason: reason) }
    )
}

@MainActor
private func makePanelModel(probe: DaemonProbe) -> SettingsModel {
    SettingsModel(
        socketPath: nil, refreshOnAppear: false,
        probes: Gp20261019FakeProbes.set(), daemonProbe: probe
    )
}

// MARK: - 缺陷 6：在途的写入动作回到 .ready

@MainActor
final class Qoder20261019PruneInFlightTests: XCTestCase {

    /// 一个"本来就按得动"的控制台：写入闸（daemon 路径 + 已报根）全部满足，
    /// 下面那条红才只能是"在途"造成的，不是"本来就按不动"的另一种写法。
    private func readyConsole(_ label: String) -> ConsoleModel {
        let root = TestSandbox.directory(label)
        let console = ConsoleModel(
            daemonBinaryPath: "/opt/glasspane/glasspaned",
            env: ["GLASSPANE_STATE_DIR": root],
            home: "/Users/someone-else",
            evidenceScanner: { _ in
                ConsoleModel.EvidenceScanOutcome(directoryExists: true, totalBytes: 0, listFailure: nil)
            }
        )
        console.adoptDaemonReport(
            binaryPath: "/opt/glasspane/glasspaned",
            daemonStateRoot: root,
            answered: true
        )
        console.projectsState = .loaded
        return console
    }

    /// 前半：**删除在途时这一枚必须按不动**，并且禁用态自己给出原因 + 下一步。
    /// 反向变异：`pruneControl` 不再看 `isRunningPrune` → 前两条红；把理由那句
    /// 改成只说"正在清理" → 后两条红（禁用态不给下一步就是本仓认下的缺陷）。
    func testInFlightPruneBlocksTheCleanControlWithAReasonAndANextStep() {
        let console = readyConsole("prune-inflight")
        if case .ready = console.pruneControl {} else {
            return XCTFail("夹具没造出按得动那一支：\(console.pruneControl)")
        }
        console.isRunningPrune = true
        XCTAssertFalse(
            console.canPreviewTestResiduePrune,
            "一次真删（可跑约 20 s）还在跑，「清理」就又按得动了：第二次点击会对着正在被改的注册表起 dry-run"
        )
        guard case .blocked(let banner, let reason) = console.pruneControl else {
            return XCTFail("在途的删除要用 .blocked 说话，不许回到 .ready：\(console.pruneControl)")
        }
        XCTAssertFalse(banner.isEmpty, "禁用态同样要报得出这一页知道的东西")
        XCTAssertTrue(reason.contains("按不动"), "禁用态那句要说清它按不动：\(reason)")
        XCTAssertTrue(reason.contains("下一步"), "禁用态那句必须给得出下一步：\(reason)")
        XCTAssertTrue(reason.contains("清理"), "那句话说的是这一枚控件：\(reason)")
    }

    /// 后半：在途时**一次 dry-run 都不能起**。判据不止在控件的呈现上，`previewTestResiduePrune()`
    /// 自己那道闸也要看同一个状态——否则键盘/自动化绕过灰掉的按钮就还是能起第二次。
    /// 反向变异：只改 `pruneControl` 不改这条入口 → 红在这里。
    func testPreviewIsRefusedWhileAPruneIsRunning() {
        let console = readyConsole("prune-preview-gate")
        console.isRunningPrune = true
        console.previewTestResiduePrune()
        XCTAssertFalse(
            console.isPreparingPrunePreview,
            "删除还在跑就又起了一次 --project-prune --dry-run：预览读的是正在被改的那张表"
        )
    }
}

// MARK: - 缺陷 8：永远点不亮的红行

/// 「刷新失败」那一行红字读的是 `lastRefreshError`，而那个状态从头到尾只被赋过 `nil`
/// ——一条永远画不出来的警告行在这一面等于没有警告。这一支选的是**删掉那一行**，
/// 条件是它要说的话已经有一个能亮的出口。这几条测的就是那个出口真的亮：
/// 「有人应门却不开口」这一支必须自己把状态、灯色、卡片注记与下一步说出来，
/// 而且不许把上一次测量的结论留下。
/// 反向变异：把那一行接回一个只被赋 nil 的状态 → 第一条红（死行回来了）；
/// 把 `presentButSilent` 那一支的注记或灯色改掉 → 红在后面几条。
@MainActor
final class Qoder20261019SilentDaemonOutletTests: XCTestCase {

    func testAPresentButSilentDaemonSpeaksForItself() async {
        let model = makePanelModel(probe: silentDaemonProbe(reason: "listener closed without answering"))
        model.refresh()
        await waitUntil { model.daemon.liveness != .unmeasured }
        guard case .presentButSilent(let reason) = model.daemon.liveness else {
            return XCTFail("夹具没造出\"应门却不回话\"那一支：\(model.daemon.liveness)")
        }
        XCTAssertTrue(model.daemonCaption.contains("没回话"), model.daemonCaption)
        XCTAssertEqual(model.daemonTone, .warning, "这一支既不是运行中也不是未运行，灯色必须自己说")
        XCTAssertTrue(model.daemonLivenessIdentifier.hasSuffix("-silent"), model.daemonLivenessIdentifier)
        XCTAssertTrue(reason.contains("without answering"), "实测到的原因要能读出来：\(reason)")
        // 没自报就没有自报：四张卡各自给出那句"接了连接却没回话"，而不是"未在运行"。
        XCTAssertEqual(model.entries.count, PermissionDescriptor.all.count)
        for entry in model.entries where entry.kind != .developerTools {
            XCTAssertEqual(entry.status, .unverifiable, "\(entry.kind)：没有回话时不许有一个席位结论")
            XCTAssertEqual(entry.statusNote, SettingsModel.silentDaemonReportNote,
                           "\(entry.kind)：那句注记不许写成\"服务没在运行\"——那会把人支去重启一个还活着的进程")
        }
        XCTAssertNil(model.daemon.version, "上一次测量的版本号不许替这一次背书")
        XCTAssertNil(model.daemon.stateRoot, "同上：状态根也是没测到的")
    }

    /// 对照：真应门的那一次不留一句失败说法，卡片跟着自报席位走。
    func testAnAnsweringDaemonReportsTheSeatsItSelfReported() async {
        let model = makePanelModel(probe: DaemonProbe(
            fileExists: { _ in true },
            rawTransport: { _, _, _ in
                .answered(Data(
                    #"{"result":{"version":"9.9.9","protocolVersion":"1","pid":4242,"permissions":{"accessibility":"granted"},"stateRoot":"/tmp/gp-reported-root"}}"#.utf8
                ))
            }
        ))
        model.refresh()
        await waitUntil { model.daemon.liveness != .unmeasured }
        XCTAssertEqual(model.daemon.liveness, .answering, "\(model.daemon.liveness)")
        XCTAssertEqual(model.daemonCaption, "运行中", model.daemonCaption)
        XCTAssertEqual(model.daemon.stateRoot, "/tmp/gp-reported-root")
        XCTAssertTrue(model.daemonStateRootCaption.contains("/tmp/gp-reported-root"),
                      "页面上那一行要说出它在跟哪一个根说话：\(model.daemonStateRootCaption)")
    }

    /// 那个死行的形状不许回来：两处源码里都不许再有只被赋 nil 的错误状态。
    func testTheUnreachableErrorStateStaysGone() throws {
        for name in ["SettingsModel.swift", "SettingsPanelView.swift"] {
            let text = try PanelSourceText.code(name)
            XCTAssertFalse(text.contains("lastRefreshError"),
                "\(name) 里又出现了 lastRefreshError：那一行要么能亮，要么就该消失")
        }
    }

    @MainActor
    private func waitUntil(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<400 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 25_000_000)
        }
    }
}

// MARK: - 缺陷 5：更新页住在自己算的那个根里

final class Qoder20261019UpdateRootWiringTests: XCTestCase {

    /// `ConsoleModel.adoptDaemonReport`（:148-152）把这条记成它**只给自己**修掉的 P1，
    /// 而更新页的根在 init 那一刻由 env/家目录定死，`ConsoleRootView.syncFromSettings`
    /// 只把 hello 报的根接到 console 上。后果：「自动更新」开关与
    /// `update-install.json`/`ca-roots.pem` 落在真的 `~/.glasspane`，而人看着的是沙箱。
    /// 反向变异：接线或入口被删 → 前两条红；根留成 `let` → 第三条红（报来的根无处可放）。
    func testTheUpdatePageAdoptsTheRootTheDaemonReports() throws {
        let view = try PanelSourceText.code("ConsoleRootView.swift")
        XCTAssertTrue(view.contains("updates.adoptDaemonReport"),
            "更新页没从 hello 接根：它还住在面板自己算的那一个里")
        let model = try PanelSourceText.code("UpdateModel.swift")
        XCTAssertTrue(model.contains("func adoptDaemonReport"),
            "UpdateModel 上没有接根入口，接线的人只能再算一遍——那正是这条缺陷的形状")
        XCTAssertTrue(model.contains("var stateRootPath"),
            "根还是 init 时定死的常量，报来的那一个放不进去")
        XCTAssertTrue(model.contains("stateRootCaption"),
            "那一行只印路径：屏幕上两行「状态根」并排时没人说得出它们不是同一个数")
        let tab = try PanelSourceText.code("UpdateTabView.swift")
        XCTAssertTrue(tab.contains("model.stateRootCaption"),
            "那句话算出来却没画出来——正是 lastActionMessage 当年的形状")
    }
}

// MARK: - 缺陷 5（行为那一半）：更新页真的跟着报来的根走

@MainActor
final class Qoder20261019UpdateRootAdoptionTests: XCTestCase {

    /// `pointerFile` / `caBundleFile` 这两条路径是这一页**写出去**的东西（更新器按
    /// `--state-dir` 落 `update-install.json` 与 `ca-roots.pem`），daemon 报了隔离根时
    /// 它们必须一起跟着换，否则操作者看着沙箱、东西落在真的 `~/.glasspane`。
    /// 反向变异：`stateRootPath` 回到 init 定死 → 前两条红；只换指针不换束 → 红在第三条。
    func testPointerAndCaBundleFollowTheReportedRoot() {
        let panelRoot = TestSandbox.directory("update-panel-root")
        let daemonRoot = TestSandbox.directory("update-daemon-root")
        let model = UpdateModel(stateRoot: panelRoot, nodePath: "/usr/bin/true", clock: Date.init)
        XCTAssertEqual(model.pointerFile, panelRoot + "/" + UpdatePanel.pointerFileName,
                       "没上报之前这一页按的是面板算的那一个根")
        model.adoptDaemonReport(daemonStateRoot: daemonRoot, answered: true)
        let adopted = StateRoot(path: daemonRoot).path
        XCTAssertEqual(model.stateRoot, adopted, "根要跟着 daemon 报的换")
        XCTAssertEqual(model.pointerFile, adopted + "/" + UpdatePanel.pointerFileName,
                       "指针还留在面板自己算的那个根下：开关写的是另一份真状态")
        XCTAssertEqual(model.caBundleFile, adopted + "/" + UpdatePanel.caBundleFileName,
                       "根证书束没跟着换：递给 node 的是另一个安装的那一份")
        XCTAssertTrue(model.stateRootCaption.contains(adopted), model.stateRootCaption)
        XCTAssertTrue(model.stateRootCaption.contains("这一帧上报"), model.stateRootCaption)

        // 报过又断了（老 daemon 不带这个键）：路径留着，出处降级。
        model.adoptDaemonReport(daemonStateRoot: nil, answered: true)
        XCTAssertEqual(model.stateRoot, adopted, "降级不许把已实测的根换成面板算的")
        XCTAssertTrue(model.stateRootCaption.contains("早前上报"), model.stateRootCaption)
    }

    /// 空白自报不是"报了一个根"；没拿到回话的那一帧更不许换根。
    func testBlankOrUnansweredReportMovesNothing() {
        let panelRoot = TestSandbox.directory("update-blank-root")
        let model = UpdateModel(stateRoot: panelRoot, nodePath: "/usr/bin/true", clock: Date.init)
        model.adoptDaemonReport(daemonStateRoot: "   ", answered: true)
        XCTAssertEqual(model.stateRoot, StateRoot(path: panelRoot).path)
        XCTAssertTrue(model.stateRootCaption.contains("面板自己算的"), model.stateRootCaption)
        model.adoptDaemonReport(daemonStateRoot: "/tmp/never-answered-root", answered: false)
        XCTAssertEqual(model.stateRoot, StateRoot(path: panelRoot).path,
                       "这一次连 hello 都没回，那个路径是上一次测量的残留，不能拿来换根")
    }

    /// `ConsoleDaemonStateRootTests` 的更新页孪生条：**发出去的那条命令点名的根**
    /// 必须就是报来的那一个——这一页四条动作全部经 `--state-dir` 交给更新器。
    func testTheSpawnedUpdaterIsGivenTheReportedRoot() async throws {
        let dir = TestSandbox.directory("update-argv")
        let daemonRoot = dir + "/daemon-side"
        try FileManager.default.createDirectory(atPath: daemonRoot, withIntermediateDirectories: true)
        let cli = daemonRoot + "/cli.js"
        try "".write(toFile: cli, atomically: true, encoding: .utf8)
        let pointer = #"{"updaterCli":"\#(cli)","installRoot":"\#(daemonRoot)","agentLabel":"com.glasspane.update","registeredAt":"2026-10-19T00:00:00Z"}"#
        try pointer.write(toFile: daemonRoot + "/" + UpdatePanel.pointerFileName, atomically: true, encoding: .utf8)
        let argsLog = dir + "/args.log"
        let node = dir + "/node"
        let script = """
        #!/bin/sh
        printf '%s\\n' "$*" >> '\(argsLog)'
        printf '%s\\n' '{"command":"status","ok":true,"exitCode":0}'
        exit 0
        """
        try script.write(toFile: node, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node)

        let model = UpdateModel(
            stateRoot: dir + "/panel-side", nodePath: node, clock: Date.init,
            baseEnvironment: ["PATH": "/usr/bin:/bin"]
        )
        model.adoptDaemonReport(daemonStateRoot: daemonRoot, answered: true)
        model.refresh()
        var text = ""
        for _ in 0..<200 {
            text = (try? String(contentsOfFile: argsLog, encoding: .utf8)) ?? ""
            if !text.isEmpty { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTAssertTrue(text.contains("--state-dir \(daemonRoot)"),
                      "更新器被起的命令没有点名报来的根，实发：\(text)")
        XCTAssertFalse(text.contains("panel-side"),
                       "这条命令还在动面板自己算的那一份根：\(text)")
    }
}

// MARK: - 缺陷 7（判据那一半）：三态各有各的下一步

final class Qoder20261019RevealControlTests: XCTestCase {

    /// 「在访达中显示」唯一的那份判据。三态都不许是"按下去什么都没发生"：
    /// 按不动时那句理由本身要给出这一屏做得动的那一步。
    /// 反向变异：把某一支的 `enabled` 改成 true → 第一条/第二条红；把理由那句缩成
    /// 一句"文件不在" → 红在"下一步"。
    func testNoPathAndUnreadablePackAreBothRefusedWithANextStep() {
        let loaded = Gp20261019Pack.loaded
        let read = ConsoleModel.revealFileControl(
            packLoad: .loaded(loaded), filePath: "/tmp/gp-evidence/op_1.json"
        )
        XCTAssertTrue(read.enabled, "整包读到了、路径也有——这一枚就该按得动：\(read.help)")

        let empty = ConsoleModel.revealFileControl(packLoad: .loaded(loaded), filePath: "")
        XCTAssertFalse(empty.enabled, "路径是空的：按下去什么都不会发生，这一枚就该灰掉")
        XCTAssertTrue(empty.help.contains("按不动"), empty.help)
        XCTAssertTrue(empty.help.contains("下一步"), empty.help)

        let failed = ConsoleModel.revealFileControl(packLoad: .failed(reason: "这条档案读不出内容"), filePath: "")
        XCTAssertFalse(failed.enabled, "整包读不出时它同样没有去处可去")
        XCTAssertTrue(failed.help.contains("重试") || failed.help.contains("刷新"),
                      "禁用态那句必须给得出下一步：\(failed.help)")

        let loading = ConsoleModel.revealFileControl(packLoad: .loading, filePath: "")
        XCTAssertFalse(loading.enabled, "还在读盘时它按不动，而且要说清在读什么")
        XCTAssertTrue(loading.help.contains("下一步"), loading.help)

        let none = ConsoleModel.revealFileControl(packLoad: .none, filePath: "/tmp/x.json")
        XCTAssertFalse(none.enabled, "这一帧没选中记录时没有去处可去：\(none.help)")
        XCTAssertTrue(none.help.contains("下一步"), none.help)
    }

    /// 判据与同胞同源：路径为空这一支不能只看 `packLoad`——整包读到了但摘要里
    /// 没有路径，去处同样是不存在的。
    func testTheJudgementNeedsBothThePackAndThePath() {
        let loaded = Gp20261019Pack.loaded
        XCTAssertFalse(
            ConsoleModel.revealFileControl(packLoad: .loaded(loaded), filePath: "   ").enabled,
            "只有空白串却报按得动：访达没有一个去处可显示"
        )
    }
}

// MARK: - 缺陷 7（接线那一半）：那枚按钮自己带着禁用与理由

final class Qoder20261019RevealButtonWiringTests: XCTestCase {

    /// 详情页那枚 folder 按钮调的是 `revealFile()`，它对空路径与读不出的整包都**静默返回**：
    /// 按得动、什么都不发生、也不说为什么——同胞「打开报告」早就走 `reportControl(packLoad:)`
    /// 带禁用理由与下一步。判据落在**用点上**（那枚按钮自己的 modifier 链），不是判据函数
    /// 定义在哪里：只看"文件里出现过 revealFileControl"会放过一件算了却从没画出来的事。
    /// 反向变异：把这两行 `.help`/`.disabled` 摘掉 → 红在这里。
    func testTheRevealButtonCarriesTheSameJudgementAsItsSibling() throws {
        let view = try PanelSourceText.code("EvidenceTabView.swift")
        let anchor = try XCTUnwrap(view.range(of: "revealFile()"),
                                   "这枚按钮的动作入口不见了，这条对照已不作数")
        let window = String(view[anchor.lowerBound...].prefix(420))
        XCTAssertTrue(window.contains(".help(revealControl.help)"),
                      "禁用态那句理由没挂在它自己身上：\(window.prefix(300))")
        XCTAssertTrue(window.contains(".disabled(!revealControl.enabled)"),
                      "按不动时这一枚不灰：还是一个按了没反应的按钮：\(window.prefix(300))")
        XCTAssertTrue(window.contains("gp-reveal-evidence-file"),
                      "它要有自己的机器可读出口，否则面板验证点不到它：\(window.prefix(300))")
        XCTAssertTrue(window.contains("revealFileControl") || view.contains("revealFileControl"),
                      "那一枚的判据必须来自 `ConsoleModel.revealFileControl`，不是第二处自写规则")
    }
}

// MARK: - 缺陷 9：副标题替一份这一屏没读到的文件背书

final class Qoder20261019RecipeSourceLabelTests: XCTestCase {

    /// 这一屏显示的到底是哪一份：`load()` 只试 CWD 相对的候选，launchd/Finder 起面板时
    /// cwd 是 `/`，显示的永远是内置快照，而副标题写着"真源：kernel/schemas/…"。
    func testTheSnapshotBranchNamesItselfASnapshot() {
        let snapshot = RecipeSchemaLoader.load(fromWorkingDirectory: "/")
        XCTAssertTrue(snapshot.source.contains("内置快照"),
            "工作目录是 / 的一次加载没落到快照那一支：\(snapshot.source)")
        XCTAssertFalse(snapshot.source.contains("只读真源"),
            "这一屏显示的是内置快照，来源却说读到了 schema 文件：\(snapshot.source)")
    }

    /// 反向变异：副标题改回硬写的静态句子 → 红在后两条。
    func testTheSubtitleIsDerivedFromWhatWasActuallyLoaded() throws {
        let view = try PanelSourceText.code("RecipesTabView.swift")
        XCTAssertFalse(view.contains("真源：kernel/schemas/recipe-config.schema.json（只读）"),
            "副标题又回到替一份这一屏没读到的文件背书")
        XCTAssertTrue(view.contains("RecipeSchemaLoader.subtitle"),
            "那一行必须由这份 overview 的 source 折算出来，才可能说的是它显示的东西")
    }
}

// MARK: - 缺陷 10：那句自述被两处真持久化证伪

final class Qoder20261019PersistenceHonestyTests: XCTestCase {

    /// `@AppStorage` 持久化配方草稿（`RecipesTabView`）与卡片折叠状态（`ConsoleTheme`），
    /// 而入口注释写"面板不持久化任何配置"。持久化是故意的，所以修的是那句话。
    /// 缺陷本身就是那句注释，判据只能落在文字上（其余结构闸只认代码）。
    func testTheHeaderCommentStatesWhatIsAndIsNotPersisted() throws {
        let path = PanelSourceText.panelDirectory + "/GlassPaneSettingsApp.swift"
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 \(path)")
        }
        XCTAssertFalse(raw.contains("面板不持久化任何配置"),
            "这句自述被同一屏的两处 AppStorage 证伪")
        XCTAssertTrue(raw.contains("AppStorage"), "注释要点明持久化用的是什么机制：\(raw.prefix(400))")
        XCTAssertTrue(raw.contains("草稿") && raw.contains("折叠"),
            "要说清持久化的是 UI 本地的草稿与折叠状态")
        XCTAssertTrue(
            raw.contains("不持久化") || raw.contains("从不写") || raw.contains("不落盘") || raw.contains("不落盘的东西"),
            "同一句里要说清**不**落盘的是什么（读数与结论），不然又是一句自述过头"
        )
    }

    /// 反向：这句话删掉之后两处 AppStorage 还在，所以判据必须能自己找到那两处。
    func testTheTwoPersistedPiecesOfUIStateAreStillThere() throws {
        let recipes = try PanelSourceText.code("RecipesTabView.swift")
        XCTAssertTrue(recipes.contains("@AppStorage"), "配方草稿的持久化不见了：这条闸的另一半失效")
        let theme = try PanelSourceText.code("ConsoleTheme.swift")
        XCTAssertTrue(theme.contains("AppStorage"), "卡片折叠状态的持久化不见了：同上")
    }
}

// MARK: - 缺陷 9（折算那一半）：来源句子只是这份 overview 的函数

final class Qoder20261019RecipeSubtitleTests: XCTestCase {

    /// 那句话由这份 overview 的 `source` 折算：显示的是快照就说是快照，真读到文件才点名文件。
    /// 反向变异：把副标题写回一句常量 → 第一条红；把"没读到文件"那一支也说成真源 → 同样红。
    func testTheSubtitleFollowsTheBranchThatActuallyAnswered() {
        let snapshot = RecipeSchemaLoader.load(fromWorkingDirectory: "/")
        let text = RecipeSchemaLoader.subtitle(for: snapshot)
        XCTAssertTrue(text.contains("内置快照"),
                      "这一屏显示的是内置快照，那句话必须这么说：\(text)")
        XCTAssertFalse(text.contains("真源：kernel/schemas"),
                       "那句话又把一份没读到的文件说成这一屏的真源：\(text)")
    }

    /// 对照：真读到盘上那份 schema 时要点名它——否则修过头，把有真源的一屏也降成快照。
    func testTheSubtitleNamesTheSchemaFileWhenItWasReallyRead() throws {
        let root = TestSandbox.directory("recipe-schema")
        let directory = root + "/kernel/schemas"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let path = directory + "/recipe-config.schema.json"
        try RecipeSchemaLoader.embeddedRaw.replacingOccurrences(of: "0.1-draft", with: "0.2-test")
            .write(toFile: path, atomically: true, encoding: .utf8)

        let loaded = RecipeSchemaLoader.load(fromWorkingDirectory: root)
        XCTAssertTrue(loaded.source.contains("只读真源"),
                      "夹具没让 load 真的读到那份文件：\(loaded.source)")
        XCTAssertEqual(loaded.schemaVersion, "glasspane.recipe/0.2-test",
                       "显示的内容必须是盘上那一份，不是内置快照")
        XCTAssertTrue(RecipeSchemaLoader.subtitle(for: loaded).contains(path),
                      "读到文件的那一屏必须说得出它是哪一份：\(RecipeSchemaLoader.subtitle(for: loaded))")
    }
}
