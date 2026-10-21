import Testing
import Foundation
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 2026-10-21 那一轮面板缺陷的闸。每条都带一次能把它打红的表达式（见各条 `REVERSE`）。
///
/// 视图本身在单测里起不来（`SettingsPanelView` 要 `@EnvironmentObject`，真窗口要 TCC），
/// 所以这一轮的判据一律长在**折算层**上：`nonisolated static func` 把「屏幕上该说哪一句、
/// 那一枚按不按得动」算出来，视图只负责画它；每条再配一把源码形状闸，钉住视图画的确实
/// 是这一份判据——只测折算函数不看视图，在这个仓里就是半修。
///
/// 七条共同的那件事：面板只许说 daemon、或这一页自己起的一次性子进程**量到过**的东西。
@MainActor
@Suite("Daily round 2026-10-21: the panel only says what it measured")
struct DailyRound20261021PanelTests {

    // MARK: - 夹具

    /// 按状态表造一份卡片清单（与 `entriesBeforeDaemonReport()` 同形）。
    private func entries(
        _ statuses: [PermissionKind: PermissionStatus]
    ) -> [SettingsModel.PermissionEntry] {
        PermissionDescriptor.all.map { descriptor in
            SettingsModel.PermissionEntry(
                kind: descriptor.kind,
                descriptor: descriptor,
                status: statuses[descriptor.kind] ?? .unverifiable,
                statusNote: nil
            )
        }
    }

    private let bareSubject = PermissionSubject(binaryPath: "/opt/glasspane/bin/glasspaned")
    private let bundledSubject = PermissionSubject(
        binaryPath: "/opt/GlassPane Daemon.app/Contents/MacOS/glasspaned",
        bundleIdentifier: "com.glasspane.daemon",
        bundlePath: "/opt/GlassPane Daemon.app"
    )

    /// 项目页那枚控件的调用形态（同一份判据，不在测试里另立第二套规则）。
    private func projectControl(
        registered: String?,
        shared: String,
        sharedExists: Bool?
    ) -> ConsoleModel.PanelControl {
        ConsoleModel.projectEvidenceDirectoryControl(
            registeredPath: registered,
            sharedDirectory: shared,
            sharedDirectoryExists: sharedExists,
            stateRootCaption: "后台服务这一帧上报的状态根 /tmp/x"
        )
    }

    // MARK: - 发现 1：重启的实测结论不能死于那一次点击

    /// 按下「重启后台服务」的那一刻 `reprobed` 被清空（重启后不许再信旧的重探），
    /// `kindsNeedingRestart` 于是变空表。横幅从前就挂在这张表上，而按钮与
    /// `gp-permission-restart-outcome` 那一行都长在横幅里——这次点击于是抹掉了自己
    /// 唯一的出口，实测到的重启结论永远没有读者。
    /// REVERSE：把 `SettingsModel.showsRestartBanner` 三个分支删剩
    /// `!kindsNeedingRestart.isEmpty` → 在途与已出结论那两组 #expect 红。
    @Test("The restart banner keeps its readout after the click that clears the reprobe")
    func restartBannerSurvivesTheClickThatClearsItsOwnTrigger() {
        // 前提自己也要钉住：清掉重探之后那张表确实是空的（否则这条修的是不存在的东西）。
        let running: [PermissionKind: PermissionStatus] = [.accessibility: .notDetermined]
        let reprobed = PermissionReprobe.Result(
            subject: bareSubject, statuses: [.accessibility: .granted]
        )
        #expect(
            PermissionReprobe.kindsNeedingRestart(running: running, reprobed: reprobed)
                == [.accessibility], "前提：重探在时这一项确实待重启")
        #expect(
            PermissionReprobe.kindsNeedingRestart(running: running, reprobed: nil).isEmpty,
            "前提：`restartDaemon()` 清空 reprobed 之后这张表就是空的")

        // 在途：此刻表是空的，横幅必须在。
        #expect(SettingsModel.showsRestartBanner(
            kindsNeedingRestart: [], isRestartInFlight: true, outcome: .inFlight))
        // 已出结论（哪怕是「没换成进程」这种失败的）：表同样是空的，横幅还得在。
        for outcome in [
            SettingsModel.DaemonRestartOutcome.unchanged(pid: nil),
            .unchanged(pid: 4242),
            .launchctlFailed(status: 3, detail: "Could not find service"),
            .spawnFailed,
            .confirmed(previousPid: 1, currentPid: 2),
        ] {
            #expect(
                SettingsModel.showsRestartBanner(
                    kindsNeedingRestart: [], isRestartInFlight: false, outcome: outcome),
                "重启结论「没换成进程」这一类没有出口：横幅的条件又回到那张被自己清空的表")
        }
        // 反面对照：什么都没发生过的时候不许凭空长出一条横幅。
        #expect(!SettingsModel.showsRestartBanner(
            kindsNeedingRestart: [], isRestartInFlight: false, outcome: .idle),
            "还没重启过就冒出一条横幅，是另一句没测过的话")
        // 待重启的权限本身仍是理由（原有那一支不许被这次改动弄丢）。
        #expect(SettingsModel.showsRestartBanner(
            kindsNeedingRestart: [.accessibility], isRestartInFlight: false, outcome: .idle))
    }

    /// 横幅在屏上、手里却没有待重启的权限可指时，那句提示不能是空串——空串的横幅
    /// 是一块画出来却什么都没说出来的橙色区域。
    /// REVERSE：让 `restartBannerWithoutReprobeHint` 回到 `""` → 第一条红。
    @Test("A restart banner with nothing pending still says what the button does")
    func restartHintIsNeverAnEmptySentence() {
        let hint = SettingsModel.restartBannerWithoutReprobeHint
        #expect(!hint.isEmpty, "横幅可以画出来而话说不出，就是块空壳")
        #expect(hint.contains("重启后台服务"), "读数: \(hint)")
        #expect(hint.contains("打断"), "点了会中断正在执行的操作，这件事必须写出来：\(hint)")
        for forbidden in ["§", "R35", "P0", "specs/"] {
            #expect(!hint.contains(forbidden), "给人读的一句话里不许有内部编号 \(forbidden)：\(hint)")
        }
    }

    /// 形状闸：视图那一半真的改用这份判据了，且重启结论的标识还在那一块里。
    /// REVERSE：把 `if model.showsRestartBanner` 改回
    /// `if !model.kindsNeedingRestart.isEmpty` → 第一条红；删掉那一行结论 → 第二条红。
    @Test("Shape: the permission page keys the banner on the decision function") func ShapeThePermissionPageKeysTheBannerOnTheDecisionFunction() throws {
        let panel = try PanelSourceText.code("SettingsPanelView.swift")
        #expect(panel.contains("if model.showsRestartBanner {"),
                "横幅又回到挂在 `kindsNeedingRestart` 上：那一次点击会继续抹掉自己的读数")
        #expect(panel.contains("gp-permission-restart-outcome"),
                "重启结论的可指认出口不见了")
        #expect(panel.contains("model.restartOutcomeText"),
                "重启结论没被渲染，又是一句算好了没人接的话")
        #expect(panel.contains("model.restartHint"),
                "横幅那句提示不再来自模型（空壳那一支回来了）")
    }

    // MARK: - 发现 2：横幅那句话由提交结局折算

    /// 从前 `setPendingGuide` 无条件发一句「已请求「辅助功能」授权」，而它下面那条
    /// `launchctl submit` 走的是 `try? process.run()`：退出码与输出都不读，成没成无人
    /// 知道；`daemon.subject` 为 nil 时更是**一个申请都没提交**，同一句话照发。
    /// REVERSE：把 `guideText` 的 `.notStarted` / `.refused` / `.submitting` 三支都折回
    /// `PermissionGuide.instruction(...)` → 那三支的「不含已请求」断言红。
    @Test("The guide sentence is chosen from the measured submission outcome")
    func guideSentenceTracksTheMeasuredOutcome() {
        // 折算本身：nil = 连退出码都没拿到，那不是「已提交」。
        #expect(SettingsModel.daemonRequestStage(from: nil) == .notStarted)
        #expect(SettingsModel.daemonRequestStage(
            from: (output: "", errorOutput: "", status: 0)) == .submitted)
        #expect(SettingsModel.daemonRequestStage(
            from: (output: "", errorOutput: "Could not find service.", status: 3))
            == .refused(status: 3, detail: "Could not find service."))
        // 退出码非 0 时 stderr 是那句话的来源；stdout 有内容才轮得到它。
        #expect(SettingsModel.daemonRequestStage(
            from: (output: "kept", errorOutput: "", status: 5))
            == .refused(status: 5, detail: "kept"))

        let submitted = SettingsModel.guideText(
            for: .accessibility, subject: bundledSubject, stage: .submitted)
        #expect(submitted.contains("已请求"),
                "退出码 0 这一次才是真的申请过，那句话不能反过来被删：\(submitted)")

        let notStarted = SettingsModel.guideText(
            for: .accessibility, subject: bundledSubject, stage: .notStarted)
        #expect(!notStarted.contains("已请求"),
                "连退出码都没读到，这句话还在替系统宣布已经申请过：\(notStarted)")
        #expect(notStarted.contains("下一步"),
                "没提交成的一句话必须给得出下一步：\(notStarted)")

        let refused = SettingsModel.guideText(
            for: .screenRecording, subject: bareSubject,
            stage: .refused(status: 3, detail: "Could not find service."))
        #expect(!refused.contains("已请求"), "launchctl 拒了，这句还在说已请求：\(refused)")
        #expect(refused.contains("Could not find service"),
                "失败的理由必须是它自己回的那句话：\(refused)")
        #expect(refused.contains("3"), "退出码要落在话里，读者才知道是哪一趟：\(refused)")
        #expect(refused.contains("下一步"), "读数: \(refused)")

        // 在途那一支：它说的是「正在提交」，不是「已请求」。
        let inFlight = SettingsModel.guideText(
            for: .inputMonitoring, subject: bareSubject, stage: .submitting)
        #expect(!inFlight.contains("已请求"), "还在等回话就宣布已请求：\(inFlight)")

        // 身份没上报：一次都没提交，`daemonRequiredText` 那一句必须在（原有行为）。
        let notAttempted = SettingsModel.guideText(
            for: .accessibility, subject: nil, stage: .notAttempted)
        #expect(notAttempted.contains(PermissionGuide.daemonRequiredText),
                "身份缺失那一支的既有免责句被换掉了：\(notAttempted)")
        // 拖入的名字在结局之后仍然要说清它不是授权对象。
        let dropped = SettingsModel.guideText(
            for: .accessibility, subject: bundledSubject, stage: .notStarted,
            droppedName: "MyApp")
        #expect(dropped.contains("MyApp"), "读数: \(dropped)")
    }

    /// 提交那一趟必须走已有的、会读退出码的执行通道，不再复制第二份执行器。
    /// REVERSE：把 `requestPermissionViaDaemon` 里那次 `ConsoleModel.runDaemonCLI`
    /// 换回 `runSystemBinary(command.launchPath, …)` → 前两条红。
    @Test("Shape: the submission goes through the exit-code-capturing channel") func ShapeTheSubmissionGoesThroughTheExitCodeCapturingChannel() throws {
        let model = try PanelSourceText.code("SettingsModel.swift")
        guard let start = model.range(of: "private func requestPermissionViaDaemon(") else {
            Issue.record("SettingsModel 里找不到 requestPermissionViaDaemon，这条对照已不作数")
            return
        }
        let windowEnd = model.range(
            of: "nonisolated static func daemonRequestStage(", range: start.upperBound..<model.endIndex
        )?.lowerBound ?? model.endIndex
        let block = model[start.lowerBound..<windowEnd]
        #expect(windowEnd != model.endIndex,
                "窗口切到了文件尾：这一段形状闸就在看整份文件，等于没闸")
        #expect(block.contains("ConsoleModel.runDaemonCLI("),
                "提交那一趟又回到不读退出码的执行路径")
        #expect(!block.contains("runSystemBinary("),
                "那一条静默的 `try? process.run()` 执行器又被用来提交申请了")
        #expect(block.contains("daemonRequestStage(from: run)"),
                "退出码读回来了却没被折算成那句话")
    }

    // MARK: - 发现 4：hello 之前的总览不数「没授权」

    /// 第一帧 hello 之前每一条必备席位都是 `unverifiable`（这一页什么都没读到），
    /// 而总览从前写「还有 3 项必备权限没授权」、侧栏写「3 项待处理」——那是对本机 TCC
    /// 的一次没测过的断言，且正印在四张自述「读不到它的授权状态」的卡上面。
    /// REVERSE：让 `PermissionOverview.make` 不看 `unverifiable`、直接数
    /// `status != .granted` → 前三条 #expect 红。
    @Test("The overview strip reports that nothing was reported, instead of counting seats")
    func overviewBeforeTheFirstHelloClaimsNothingAboutSeats() {
        let preHello = SettingsModel.entriesBeforeDaemonReport()
        let overview = SettingsModel.PermissionOverview.make(entries: preHello)
        #expect(overview == .awaitingDaemonReport,
                "hello 之前四张卡全是 unverifiable，总览却给出了一个数：\(overview.headline)")
        #expect(overview.headline.contains("还没上报"), "读数: \(overview.headline)")
        #expect(!overview.headline.contains("没授权"),
                "没读到过席位就不许断言本机 TCC：\(overview.headline)")
        #expect(!overview.headline.contains("3"),
                "那一句没有一次测量撑着，数出来的 3 是编的：\(overview.headline)")
        #expect(overview.detail.contains("刷新"),
                "没上报的一句话也要给得出下一步：\(overview.detail)")
        #expect(overview.tone == .unmeasured,
                "这一支既不该点绿也不该点橙：\(overview.tone)")
        #expect(SettingsModel.sidebarPermissionBadge(entries: preHello) == "未上报")
    }

    /// 对照（这条闸必须两面都能红）：真读到席位时才数得出「没授权」，而「这一帧没上报」
    /// 的那几项不许被并进同一个数——那是两件不同的事实。
    /// REVERSE：把 `measured` 那一支的合成句改成 `ungranted + unreported` 一起数 → 本条红。
    @Test("Counted seats and unreported seats stay two separate numbers")
    func measuredAndUnreportedAreNotMergedIntoOneCount() {
        let granted = entries([
            .accessibility: .granted, .inputMonitoring: .granted,
            .screenRecording: .granted, .developerTools: .unverifiable,
        ])
        let allGranted = SettingsModel.PermissionOverview.make(entries: granted)
        #expect(allGranted == .allGranted, "读数: \(allGranted.headline)")
        #expect(allGranted.headline == "必备权限已全部授权", "读数: \(allGranted.headline)")
        #expect(SettingsModel.sidebarPermissionBadge(entries: granted) == nil,
                "全授权了还在侧栏挂一个标记，是替读者编一件没办完的事")

        let twoDownOneMissing = SettingsModel.PermissionOverview.make(entries: entries([
            .accessibility: .denied, .inputMonitoring: .notDetermined,
            .screenRecording: .unverifiable, .developerTools: .unverifiable,
        ]))
        guard case .measured(let ungranted, let unreported) = twoDownOneMissing else {
            Issue.record("读到过席位，这一支就该是 measured，实际是 \(twoDownOneMissing.headline)")
            return
        }
        #expect(ungranted == ["辅助功能", "输入监控"], "\(ungranted)")
        #expect(unreported == 1, "屏幕录制那一帧没上报，它不是没授权")
        #expect(twoDownOneMissing.headline.contains("实测到 2 项"), "读数: \(twoDownOneMissing.headline)")
        #expect(twoDownOneMissing.headline.contains("另有 1 项这一帧没上报"),
                "读数: \(twoDownOneMissing.headline)")

        #expect(SettingsModel.sidebarPermissionBadge(entries: entries([
            .accessibility: .denied, .inputMonitoring: .granted, .screenRecording: .granted,
            .developerTools: .unverifiable,
        ])) == "1 项待处理")
        // 一项都没授权出去、只是没上报：侧栏那句话也不能写成待处理。
        #expect(SettingsModel.sidebarPermissionBadge(entries: entries([
            .accessibility: .granted, .inputMonitoring: .granted, .screenRecording: .unverifiable,
            .developerTools: .unverifiable,
        ])) == "1 项没上报")
    }

    /// 形状闸：侧栏那一行不再自己数一遍，两处共用同一份判据。
    /// REVERSE：把 `badgeText(for:)` 改回本地 `filter { $0.status != .granted }` → 第一条红。
    @Test("Shape: sidebar and overview share one decision") func ShapeSidebarAndOverviewShareOneDecision() throws {
        let root = try PanelSourceText.code("ConsoleRootView.swift")
        #expect(root.contains("SettingsModel.sidebarPermissionBadge(entries: settings.entries)"),
                "侧栏那一枚又开始自己数未授权了——两个面各数一遍正是这条缺陷的形状")
        let panel = try PanelSourceText.code("SettingsPanelView.swift")
        #expect(panel.contains("let overview = model.permissionOverview"),
                "总览那一行不再读这份判据")
        #expect(panel.contains("gp-permission-overview-awaiting-report"),
                "「还没上报」那一支没有机器可读的出口，冒烟就分不清它和没授权那一支")
    }

    // MARK: - 发现 5：一次性实测的徽标不能借 daemon 自报那一族标识

    /// 开发者工具一张按设计恒「未验证」（`engine/smoke.md` 记的就是这一条：系统不提供
    /// 查询接口）。点过「验证调试能力」之后，那枚徽标从前把**另一个进程**
    /// （`glasspaned --check-developer-tools` 的一过性任务）量到的结论挂进
    /// `gp-perm-developer-tools-granted`——那正是 C6 冒烟当作 daemon 席位来读的那一族
    /// 标识，机器于是把「某个一次性任务能附加调试器」读成「daemon 自己有这个席位」。
    /// REVERSE：把 `PermissionBadge.make` 的 identifier 那句改回恒走
    /// `PermissionGuide.statusIdentifier(...)` → 本条红。
    @Test("The one-shot measurement carries its own identifier, not the daemon seat family")
    func measuredBadgeIdentifierIsSplitFromTheSeatFamily() {
        let seatStates: Set<String> = ["granted", "denied", "notDetermined", "unverifiable"]
        let seatPrefix = "gp-perm-developer-tools-"

        let measured = PermissionBadge.make(
            kind: .developerTools, reported: .unverifiable, measured: .granted)
        #expect(measured.identifier == "gp-perm-developer-tools-measured-granted",
                "实测那一枚的标识又回到自报席位那一族：\(measured.identifier)")
        #expect(measured.identifier != PermissionGuide.statusIdentifier(
            kind: .developerTools, status: .granted),
            "自动化读到的必须是「这是另一个进程量的」，而不是 daemon 的席位")
        #expect(!seatStates.contains(String(measured.identifier.dropFirst(seatPrefix.count))),
                "C6 按 gp-perm-<kind>-<state> 的形状数 daemon 席位，这个标识会被它读成席位")
        #expect(measured.text.contains("后台服务实测"),
                "文字要说得出是谁量的：\(measured.text)")
        // 同源那一条不许回退：文字、形状、标识仍来自同一个 status。
        #expect(measured.status == .granted)
        #expect(measured.icon == PermissionGuide.statusIcon(for: .granted))
        #expect(measured.source == .oneShotMeasurement)

        let measuredDenied = PermissionBadge.make(
            kind: .developerTools, reported: .unverifiable, measured: .denied)
        #expect(measuredDenied.identifier == "gp-perm-developer-tools-measured-denied")
        #expect(measuredDenied.text.contains("后台服务实测"), "读数: \(measuredDenied.text)")

        // daemon 自报那一枚一个字没动：必备卡与未验证那一张仍走原来那一族。
        let seat = PermissionBadge.make(kind: .developerTools, reported: .unverifiable)
        #expect(seat.identifier == "gp-perm-developer-tools-unverifiable",
                "C6 每卡恰好一枚的那一枚不见了")
        #expect(seat.text == "未验证")
        #expect(seat.source == .daemonReported)
        #expect(PermissionBadge.make(kind: .accessibility, reported: .granted).identifier
                    == "gp-perm-accessibility-granted")
        #expect(PermissionBadge.make(kind: .accessibility, reported: .granted).text == "已授权",
                "没有实测结论就不许声称实测")
        #expect(seat.identifier != measured.identifier,
                "两个来源共用一个标识，就等于其中一个从没说过话")
    }

    /// 形状闸：实测那一枚不能**顶掉**自报席位那一枚——两张并排各说各话，
    /// C6 那一族才永远有恰好一枚。
    /// REVERSE：删掉 `if let measuredBadge` 那一段 → 第一条红。
    @Test("Shape: the card renders both the seat badge and the one-shot badge") func ShapeTheCardRendersBothTheSeatBadgeAndTheOneShotBadge() throws {
        let panel = try PanelSourceText.code("SettingsPanelView.swift")
        #expect(panel.contains("if let measuredBadge {"),
                "实测那一枚又去覆盖自报席位：那张卡于是只答一个来源")
        #expect(panel.contains("measuredIdentifier(kind: kind, status: status)"),
                "标识不再分家，冒烟会把一过性实测读成 daemon 的席位")
        #expect(panel.contains("capabilityIdentifier"),
                "结论行那枚带时刻的标识不能被这次改动一起删掉")
    }

    // MARK: - 发现 6：契约自己的注脚不是用户文案

    /// 配方页从前把 schema 那句 `description` 原样印出来——「Recipe configuration
    /// contract (P0 landing of the shared recipe validator, R35)…」：给内核读者的批次
    /// 编号与自我说明，被当成给人读的一句话。契约文本本身没动（`kernel/schemas/**` 与
    /// 内置快照 `embeddedRaw` 是发布出去的镜像），修的是这一页拿它说什么。
    /// REVERSE：把视图那一句换回 `Text(description)` → 形状闸红；把 `userFacingSummary`
    /// 改成回读 schema 那句 → 前面那组 forbidden 红。
    @Test("The recipe page shows a user sentence instead of the contract note")
    func contractNoteStaysOutOfUserCopy() {
        let snapshot = RecipeSchemaLoader.load(fromWorkingDirectory: "/")
        let sentence = RecipeSchemaLoader.userFacingSummary(for: snapshot)
        for forbidden in ["P0", "R35", "§", "specs/", "contract", "landing", "validator"] {
            #expect(!sentence.contains(forbidden),
                    "给人读的一句话里出现了内部说法 \(forbidden)：\(sentence)")
        }
        #expect(sentence.contains("按顺序执行的步骤"), "读数: \(sentence)")
        #expect(sentence.contains("校验"),
                "这一页不替后台服务判定，那句话要说出来：\(sentence)")
        // 必填字段是从这一屏真读到的那份取来的，不是手抄的第二份。
        #expect(sentence.contains("schemaVersion") && sentence.contains("steps"), "读数: \(sentence)")
        // 镜像一个字没改：契约原文仍在 embeddedRaw 里（这条不许被「顺手清理文案」弄丢）。
        #expect(RecipeSchemaLoader.embeddedRaw.contains("Recipe configuration contract"),
                "内置快照的 schema 字段被动了——那份镜像不是这一条该改的东西")
    }

    /// 真读到一份要求不同的 schema 时，那句话跟着它说，不留在旧抄本上。
    /// REVERSE：把 `userFacingSummary` 写成一句不含 `required` 的常量 → 本条红。
    @Test("The user sentence follows the required list actually loaded") func TheUserSentenceFollowsTheRequiredListActuallyLoaded() throws {
        let root = TestSandbox.directory("recipe-user-copy")
        let directory = root + "/kernel/schemas"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let altered = RecipeSchemaLoader.embeddedRaw.replacingOccurrences(
            of: "\"required\": [\"schemaVersion\", \"name\", \"steps\"]",
            with: "\"required\": [\"schemaVersion\", \"name\", \"steps\", \"owner\"]"
        )
        #expect(altered != RecipeSchemaLoader.embeddedRaw, "夹具没改到那份必填表，这条不作数")
        try altered.write(
            toFile: directory + "/recipe-config.schema.json", atomically: true, encoding: .utf8)

        let loaded = RecipeSchemaLoader.load(fromWorkingDirectory: root)
        #expect(loaded.required?.contains("owner") == true,
                "夹具没让 load 真的读到那份文件：\(loaded.required ?? [])")
        #expect(RecipeSchemaLoader.userFacingSummary(for: loaded).contains("owner"),
                "这一句还停在手抄的那份必填表上，不是这一屏读到的")
    }

    /// 形状闸：视图不再把 schema 那句注脚印出来。
    /// REVERSE：恢复 `if let description = overview.description { Text(description) }` → 红。
    @Test("Shape: no contract description reaches the recipe card") func ShapeNoContractDescriptionReachesTheRecipeCard() throws {
        let view = try PanelSourceText.code("RecipesTabView.swift")
        #expect(!view.contains("Text(description)"), "契约自己的注脚又被原样印给用户了")
        #expect(view.contains("RecipeSchemaLoader.userFacingSummary(for: overview)"),
                "这一行不再来自那份判据，下一步就又是一句散文")
    }

    // MARK: - 发现 7：拒绝的原话不能被折成「不可达」

    /// `glasspaned --recipe-validate` 把拒绝写在 **stderr**：文件读不开是
    /// `{"valid":false,"errors":["file not found: …"],"path":…}` + 退出码 2
    /// （main.swift:1178-1190），结论编码不出去是 `{"encodeFailed":true,…}` + 退出码 1
    /// （main.swift:1203-1209）。从前只看 stdout，两份回话都折成 `daemonUnavailable`，
    /// 屏幕上于是写「后台服务不可达」——它明明答了话、还答了原因，被换成一件没发生过的事实。
    /// REVERSE：把 `foldValidation` 里那次 `ConsoleModel.replyText(stdout:stderr:)` 换回
    /// 只看 `stdout` → 前两组断言红。
    @Test("A daemon that answered and refused is not reported as unreachable")
    func refusalsKeepTheirOwnWords() {
        let fileNotFound =
            "{\"valid\":false,\"errors\":[\"file not found: /tmp/recipe-check-1.json\"],\"path\":\"/tmp/recipe-check-1.json\"}"
        let refused = RecipesTabView.foldValidation(
            stdout: "", stderr: fileNotFound, exitCode: 2)
        guard case .daemonRefused(let reason, let code) = refused else {
            Issue.record("读不到文件的拒绝被折成 \(refused)：它的原话又没了")
            return
        }
        #expect(code == 2)
        #expect(reason.contains("file not found"), "读数: \(reason)")
        #expect(refused != .daemonUnavailable,
                "「它答了话」被报成「它不可达」是两件不同的事实")

        let encodeFailed =
            "{\"command\":\"--recipe-validate\",\"encodeFailed\":true,\"error\":\"the validation result could not be encoded for output (boom) - no verdict published\"}"
        let notPublished = RecipesTabView.foldValidation(
            stdout: "", stderr: encodeFailed, exitCode: 1)
        guard case .daemonRefused(let reason2, let code2) = notPublished else {
            Issue.record("编码失败的拒绝被折成 \(notPublished)")
            return
        }
        #expect(code2 == 1)
        #expect(reason2.contains("could not be encoded"), "读数: \(reason2)")

        // 对照：真答出一个结论的两格仍走 verdict——这次的改动不许把有效答案也吞掉。
        let invalid = RecipesTabView.foldValidation(
            stdout: "{\"valid\":false,\"recipeName\":\"最小单步\",\"errors\":[\"steps: minItems\"]}",
            stderr: "", exitCode: 1)
        guard case .verdict(let valid, let recipeName, let errors) = invalid else {
            Issue.record("一条答出来的非法结论被折成 \(invalid)")
            return
        }
        #expect(!valid)
        #expect(recipeName == "最小单步")
        #expect(errors == ["steps: minItems"])
        #expect(
            RecipesTabView.foldValidation(
                stdout: "{\"valid\":true,\"recipeName\":\"x\",\"errors\":[]}",
                stderr: "", exitCode: 0)
                == .verdict(valid: true, recipeName: "x", errors: []),
            "有效那一格被这次改动弄丢了")
    }

    /// 「不可达」这一支只留给一次回话都没拿到的那趟（调用点：`runDaemonCLI` 回 nil）。
    /// REVERSE：把 `result = .daemonUnavailable` 那句挪进 `if let run` 分支 → 第一条红；
    /// 把两路输出只取走一路 → 第二条红。
    @Test("Shape: unreachable is reserved for a run with no reply at all") func ShapeUnreachableIsReservedForARunWithNoReplyAtAll() throws {
        let view = try PanelSourceText.code("RecipesTabView.swift")
        guard let start = view.range(of: "let run = ConsoleModel.runDaemonCLI(") else {
            Issue.record("找不到校验那趟调用，这条对照已不作数")
            return
        }
        guard let end = view.range(of: "await MainActor.run", range: start.upperBound..<view.endIndex) else {
            Issue.record("校验那趟调用的块尾找不到，这条对照已不作数")
            return
        }
        let block = view[start.lowerBound..<end.lowerBound]
        #expect(block.contains("result = .daemonUnavailable"), "没有回话那一支不见了")
        #expect(
            block.contains("stdout: run.output, stderr: run.errorOutput, exitCode: run.status"),
            "两路输出与退出码又只被取走一路")
        // 文案那一支也得把两件事分开：`未测得` 不再声称「输出不是约定的 JSON」。
        #expect(!view.contains("或其输出不是约定的 JSON"),
                "把「它答了话却没答出形状」又请回不可达那一支")
        #expect(view.contains("后台服务答了话，但没给出结论"),
                "拒绝那一支在屏幕上没有自己的说法")
    }

    /// 从回话里取「它自己说的原因」那一步单独钉：`errors` → `error` → 原文 → 一句没有。
    /// REVERSE：让 `daemonRefusalReason` 恒回空串 → 这五条 #expect 全红。
    @Test("The refusal reason is pulled out of the reply in a fixed precedence")
    func refusalReasonPrecedence() {
        #expect(ConsoleModel.daemonRefusalReason(
            reply: "{\"valid\":false,\"errors\":[\"cannot read: /tmp/a\"]}")
            .contains("cannot read: /tmp/a"))
        #expect(ConsoleModel.daemonRefusalReason(
            reply: "{\"encodeFailed\":true,\"error\":\"no verdict published\"}")
            .contains("no verdict published"))
        // 两条都有时 errors 在前——那是这条命令自己的拒绝形状。
        #expect(ConsoleModel.daemonRefusalReason(
            reply: "{\"errors\":[\"first\"],\"error\":\"second\"}") == "first")
        #expect(ConsoleModel.daemonRefusalReason(reply: "not json at all").contains("not json at all"))
        #expect(ConsoleModel.daemonRefusalReason(reply: "   ").contains("一个字都没回"),
                "空的回话不能折成一句凭空的原因")
    }

    // MARK: - 发现 3：一枚按不动的控件要说出去处与下一步

    /// 项目页那枚「在访达中打开证据目录」从前没有闸：注册项没写目录时它开的是本页
    /// 在读的那一份，而这一份在同一趟里已经被量过「不在盘上」——`NSWorkspace.selectFile`
    /// 对着一个不存在的位置什么都不做，屏幕上没有一个字说为什么。证据页的同胞
    /// （`evidenceDirectoryControl`）早就管住了自己，这一枚是漏网的那一个。
    /// REVERSE：把 `projectEvidenceDirectoryControl` 里 `false` / `nil` 两支折回
    /// `enabled: true` → 本条红。
    @Test("The project Finder control is gated on what this page measured")
    func evidenceDirectoryControlIsGated() {
        let shared = "/tmp/gp-shared-root/evidence/"
        let absent = projectControl(registered: nil, shared: shared, sharedExists: false)
        #expect(!absent.enabled,
                "这一页已经量过那个去处不在盘上，这一枚还按得动——按下就是一次静默无反应")
        #expect(absent.help.contains("按不动"), "读数: \(absent.help)")
        #expect(absent.help.contains(shared), "理由要点名它本来要开的是哪一份：\(absent.help)")
        #expect(absent.help.contains("下一步"),
                "禁用的一句话必须给得出下一步：\(absent.help)")
        #expect(absent.help.contains("evidenceStoragePath"),
                "给出的动作要是这一屏做得动的：\(absent.help)")

        // 没量过 ≠ 不在：两种都不许开一个没验证过的位置，但话说的是两件事。
        let unmeasured = projectControl(registered: nil, shared: shared, sharedExists: nil)
        #expect(!unmeasured.enabled)
        #expect(unmeasured.help.contains("还没量过"), "读数: \(unmeasured.help)")
        #expect(!unmeasured.help.contains("不在盘上"),
                "把没量过说成那里没有，是另一件没观测到的事：\(unmeasured.help)")
        #expect(unmeasured.help.contains("刷新"), "读数: \(unmeasured.help)")

        // 对照两面都必须能过：量到在，就按得动，且明说开的是共用那一份。
        let present = projectControl(registered: nil, shared: shared, sharedExists: true)
        #expect(present.enabled, "读数: \(present.help)")
        #expect(present.help.contains(shared), "读数: \(present.help)")
        #expect(present.help.contains("共用的档案目录"),
                "这一枚开的是本页共用的那一份，这句话必须写在控件上：\(present.help)")

        // 注册项自己写了目录：共用那一份量没量过都与它无关，照旧按得动且点名自己那份。
        let owned = projectControl(
            registered: "/tmp/project-own/evidence", shared: shared, sharedExists: false)
        #expect(owned.enabled)
        #expect(owned.help.contains("/tmp/project-own/evidence"), "读数: \(owned.help)")
        #expect(!owned.help.contains(shared),
                "它说的是自己那一份，不该顺带替共用那一份说话：\(owned.help)")
        // 空白串不算写了目录（与 `adoptDaemonReport` 那一条同一判据）。
        #expect(!projectControl(registered: "   ", shared: shared, sharedExists: false).enabled,
                "空白那一份等于没写：控件不该按得动")
    }

    /// 判据必须来自这一页自己的那次实测（扫注册表的同一趟），不能借证据页那一枚的
    /// 布尔——那一枚的 `false` 里还混着「还没扫过」。
    /// REVERSE：删掉 `reloadProjects` 里 `Self.directoryIsPresent(sharedDirectory)`
    /// 那一句 → 存在性那四条红；把控件判据换成 `archiveExists` → 后两条红。
    @Test("Shape: the gate reads this page own measurement") func ShapeTheGateReadsThisPageOwnMeasurement() throws {
        let dir = TestSandbox.directory("project-dir-gate")
        let missing = dir + "/evidence-missing"
        let present = dir + "/evidence"
        try FileManager.default.createDirectory(atPath: present, withIntermediateDirectories: true)
        #expect(!ConsoleModel.directoryIsPresent(missing), "量过且不在，要说不在")
        #expect(ConsoleModel.directoryIsPresent(present), "量过且在，要说在")
        #expect(!ConsoleModel.directoryIsPresent("   "), "空串不是一个去处")
        // 位置被一个文件占住时它不是「档案目录」：这一枚要开得动一个去处，不是一个文件。
        let aFile = dir + "/not-a-directory"
        try Data("x".utf8).write(to: URL(fileURLWithPath: aFile))
        #expect(!ConsoleModel.directoryIsPresent(aFile), "一个文件不是访达能打开的去处")

        let model = try PanelSourceText.code("ConsoleModel.swift")
        #expect(model.contains("self.sharedEvidenceDirectoryExists = sharedExists"),
                "这一页没有把量到的那一次落进状态，控件只好继续猜")
        let projects = try PanelSourceText.code("ProjectsTabView.swift")
        #expect(projects.contains(".disabled(!evidenceDirectoryEnabled(entry))"),
                "那一枚又回到永远按得动")
        #expect(projects.contains(".help(evidenceDirectoryHelp(entry))"),
                "按不动时那句理由与下一步必须挂在它自己身上")
        #expect(projects.contains(".accessibilityIdentifier(\"gp-open-evidence-directory\")"),
                "禁用态要有可指认的出口，冒烟才测得到它此刻按不动")
    }
}
