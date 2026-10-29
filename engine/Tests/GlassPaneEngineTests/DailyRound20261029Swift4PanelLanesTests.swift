import Testing
import Foundation
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 2026-10-29 · 每日轮 5（SwiftUI 设置面板）三条缺陷的闸。
///
/// 与同一批日常轮同一条分工：视图在单测里起不来（`ProjectsTabView` 要 `@EnvironmentObject`，
/// 真窗口要 TCC），所以判据一律长在**折算层**（`ConsoleModel` / `LocalArchive` 那些
/// `nonisolated static` 纯函数）上，再各配一把源码形状闸钉住「视图画的确实是这一份判据」——
/// 只测折算函数不看视图，在本仓就是半修。真机那一侧的走查读数记在 `engine/smoke.md`。
///
/// 三条共同的那件事：面板只许呈现它自己或后台服务量到过的东西，不许替谁断言。
/// 一句「删除没有执行」、一次把横幅抹掉的采纳、一枚按下去什么都不做的按钮，是同一件事的
/// 三个面——屏幕说了话，而那句话背后没有测量。
@MainActor
@Suite("Daily round 2026-10-29 swift4: the panel says only what was measured")
struct DailyRound20261029Swift4PanelLanesTests {

    // MARK: - 夹具

    private enum FixtureError: Error {
        case entryMissing(String)
    }

    /// 这一页手里那份「只喂 hello、不 exec、不扫盘」的控制台。
    private func makeConsole() -> ConsoleModel {
        ConsoleModel(
            evidenceDirectory: TestSandbox.directory("s5-1-evidence"),
            projectsPath: TestSandbox.filePath("s5-1-projects"),
            approvalsPath: TestSandbox.filePath("s5-1-approvals"),
            evidenceScanner: { _ in
                ConsoleModel.EvidenceScanOutcome(
                    summaries: [], unreadableFiles: [], directoryExists: false,
                    totalBytes: 0, sizeFailure: nil, entryCount: 0, listFailure: nil
                )
            },
            packReader: { _ in nil }
        )
    }

    /// 把 daemon 那份载荷原样序列化成一行 JSON：夹具与生产共用同一个来源，载荷形状漂了
    /// 这条就红——不让测试里手抄的那份字符串继续替它背书。
    private func daemonJSON(_ payload: [String: Any]) -> String {
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return String(decoding: data, as: UTF8.self)
    }

    private let registryPath = "/var/tmp/glasspane-s5-2/projects.json"

    // MARK: - S5-1 横幅的收起只认实测到换过进程

    /// 缺陷形状：同一个 daemon 进程、注册表还是旧那一张时，1 秒一轮的轮询里 hello 只要
    /// 再答一次，横幅就连同它里面那枚唯一的「重启后台服务」一起消失——用户失去的是那一次
    /// 补救的入口。判据从前是「应过门」，与 `SettingsModel.pruneBannerCleared(by:)`
    /// （只认实测到换过进程号）不是同一条。
    /// REVERSE：把 `adoptDaemonReport` 里 `if let previous = lastReportedPid, previous != reportedPid`
    /// 换成 `if reportedPid != nil` → 前三段红；整段清旗逻辑删掉 → 对照臂（换个 pid 那一支）红。
    @Test("S5-1 an answered hello from the same process never clears the restart banner")
    func sameProcessAnsweringAgainKeepsTheBanner() {
        let console = makeConsole()
        console.pruneNeedsRestart = true
        // 第一帧：这一页先认识这个进程号，此后才谈得上「换没换」。
        console.adoptDaemonReport(
            binaryPath: "/opt/glasspane/glasspaned", reportedPid: 501, answered: true)
        #expect(console.pruneNeedsRestart,
                      "第一次量到进程号不等于换过进程，撤横幅就没有任何测量支撑")

        // 轮询里它又答了三次，进程号还是 501：注册表没被新进程加载过，横幅一句都不许撤。
        for _ in 0..<3 {
            console.adoptDaemonReport(
                binaryPath: "/opt/glasspane/glasspaned", reportedPid: 501, answered: true)
        }
        #expect(console.pruneNeedsRestart,
                      "同一个 pid 的再应答把横幅与它里面那枚唯一的「重启后台服务」一起抹掉了")

        // 对照臂（负例的另一边）：报回另一个进程号＝实测到换了进程，这才撤得动。
        console.adoptDaemonReport(
            binaryPath: "/opt/glasspane/glasspaned", reportedPid: 702, answered: true)
        #expect(!console.pruneNeedsRestart,
                       "量到新进程应门之后横幅还挂着，就是把实测的结论压着不说")
    }

    /// 那条缺陷的真实走法（比「再多答一次」更狠）：一次 `presentButSilent` 把
    /// `daemon.stateRoot` 与 `pid` 清成 nil，下一帧同一个根又报回来 → `rootChanged` →
    /// `.onChange` 再采纳一遍 → 从前正是这一帧把横幅抹掉的。
    /// REVERSE：删掉 `adoptDaemonReport` 里 `reportedPid` 那一段（回到 `answered` 即清）→ 红。
    @Test("S5-1 a silent gap followed by the same root and pid coming back keeps the banner")
    func livenessGapAndRootReAdoptionKeepsTheBanner() {
        let root = TestSandbox.directory("s5-1-root")
        let console = makeConsole()
        console.pruneNeedsRestart = true
        console.adoptDaemonReport(
            binaryPath: "/opt/glasspane/glasspaned", daemonStateRoot: root,
            reportedPid: 501, answered: true)
        // daemon 占着门不应：这一侧把自报的根与进程号清空。
        console.adoptDaemonReport(
            binaryPath: "/opt/glasspane/glasspaned", daemonStateRoot: nil,
            reportedPid: nil, answered: false)
        // 同一个进程又答了，根还是那一个：nil → 有值，`rootChanged` 为真，走的就是从前那条路。
        console.adoptDaemonReport(
            binaryPath: "/opt/glasspane/glasspaned", daemonStateRoot: root,
            reportedPid: 501, answered: true)
        #expect(console.pruneNeedsRestart,
                      "旧进程重新应门不等于旧注册表被换新表，横幅里那枚按钮是唯一出路")
        // 而它一旦真换了进程就该撤（两臂都要有，只断一边等于没断）。
        console.adoptDaemonReport(
            binaryPath: "/opt/glasspane/glasspaned", daemonStateRoot: root,
            reportedPid: 803, answered: true)
        #expect(!console.pruneNeedsRestart, "量到换过进程之后横幅仍挂着")
    }

    /// 从没量到进程号的那些帧（旧 daemon 的 hello 不带 pid）不许冒充一次重启成功；
    /// 这一支的收起只能靠重启那侧的实测（`pruneBannerCleared`）。
    /// REVERSE：把清旗条件写成 `reportedPid == nil || …` → 这一条红。
    @Test("S5-1 a hello without a reported pid is not evidence of a new process")
    func helloWithoutPidKeepsTheBanner() {
        let console = makeConsole()
        console.pruneNeedsRestart = true
        for _ in 0..<3 {
            console.adoptDaemonReport(
                binaryPath: "/opt/glasspane/glasspaned", reportedPid: nil, answered: true)
        }
        #expect(console.pruneNeedsRestart, "没读到进程号就没有换过进程这件事可说")
        #expect(console.daemonHasAnswered, "应门这一件事实照样要记下来，只是它撤不动横幅")
    }

    /// 形状闸：新判据必须真的接在面板的采纳点上，否则修的是死代码。
    ///
    /// 2026-10-29 真机那一趟量到的第二件事：只挂 `liveness` 与 `stateRoot` 的采纳点收不到
    /// "同一档 liveness、同一个根、只有进程号换了"那一帧——屏上实测过：把后台服务换成新进程
    /// 并按「刷新」之后，横幅仍挂着（因为没有采纳点被触发）。所以 `daemon.pid` 自己也得是一个
    /// 采纳点，否则"只有 pid 换过才清"这一条在真窗口里永远轮不到跑。
    @Test("S5-1 shape: the view feeds the measured pid into the adoption")
    func adoptionIsWiredToTheReportedPid() throws {
        let root = try PanelSourceText.code("ConsoleRootView.swift")
        #expect(root.contains("reportedPid: settings.daemon.pid"),
                "收起判据换了，调用点却还只交「有没有应门」那一半")
        #expect(root.contains(".onChange(of: settings.daemon.pid)"),
                "进程号换了不是 liveness 变化也不是换根：没有这一个采纳点，实测到的新进程收不进这一页")
        let model = try PanelSourceText.code("ConsoleModel.swift")
        #expect(model.contains("reportedPid: Int? = nil"),
                "采纳点没收这一个实测字段，判据就没地方住")
        // 项目页那一侧的收起只认重启实测，这一条不许被顺手放宽。
        let projects = try PanelSourceText.code("ProjectsTabView.swift")
        #expect(projects.contains("SettingsModel.pruneBannerCleared(by:"),
                "重启横幅唯一的实测出口被拆掉了")
    }

    // MARK: - S5-2 写前拒与写后读不回各说各话

    /// 今天没有任何用例喂过 `loadFailed:true + needsRestart:true + found:true` 这一组
    /// （既有那条只喂 `loadFailed:true, needsRestart:false`），而它正是 daemon
    /// `--project-remove` 写后读不回那一支的真实形状。
    /// REVERSE：删掉 `LocalArchive.removeResultMessage` 里 `if found` 那一支 → 中间四条红
    /// （「删除没有执行」回到屏幕上，与同一屏那句「重启后台服务后它才会用新表」互相否定）。
    @Test("S5-2 remove: written-then-unreadable is never reported as nothing happened")
    func removePostWriteReadBackFailure() {
        let message = LocalArchive.removeResultMessage(
            cliRan: true, replyShaped: true, exitCode: 1,
            removed: false, loadFailed: true, found: true, needsRestart: true)
        #expect(message.contains("读不回"), "读数: \(message)")
        #expect(message.contains("重启"), "读数: \(message)")
        #expect(!message.contains("没有执行"), "盘已经动过，这句是替 daemon 断了一件它不敢断的事：\(message)")
        #expect(!message.contains("未执行"), "读数: \(message)")
        #expect(!message.contains("未改动"), "读数: \(message)")
        #expect(!message.contains("保持原样"), "读数: \(message)")

        // 对照臂：动手之前就读不开，这一趟确实什么都没写，那句「没有执行」说得出口。
        let before = LocalArchive.removeResultMessage(
            cliRan: true, replyShaped: true, exitCode: 1,
            removed: false, loadFailed: true, found: false, needsRestart: false)
        #expect(before.contains("删除没有执行"), "写前拒那一支被顺手改成已落盘：\(before)")
        #expect(!before.contains("已经写进"), "这一趟连表都没读到，说不了写后的事：\(before)")
    }

    /// 同一条判据必须走到屏幕上那句话：面板从 stderr 里那份真载荷折算。
    /// REVERSE：`ConsoleModel.removeActionMessage` 不交 `found`（回到恒 false）→ 这一条红。
    @Test("S5-2 remove: the panel folds the daemon payload into the new sentence")
    func removeActionMessageFoldsFound() {
        let afterWrite = daemonJSON([
            "command": "--project-remove", "dryRun": false, "loadFailed": true,
            "found": true, "removed": false, "projectId": "gp-selftest-01",
            "registryPath": registryPath, "requiresDaemonRestart": true,
            "error": "projects.json at \(registryPath) could not be read",
            "next": "make the file readable again and restart the daemon",
        ])
        let message = ConsoleModel.removeActionMessage(
            cliRan: true, stdout: "", stderr: afterWrite, exitCode: 1)
        #expect(message.contains("读不回"), "读数: \(message)")
        #expect(message.contains("重启"), "读数: \(message)")
        #expect(!message.contains("没有执行"), "读数: \(message)")
        #expect(!message.contains("未改动"), "读数: \(message)")

        let beforeWrite = daemonJSON(ProjectRegistry.removalUnreadableAtLoadPayload(
            projectId: "gp-selftest-01", dryRun: false, registryPath: registryPath))
        let refusal = ConsoleModel.removeActionMessage(
            cliRan: true, stdout: "", stderr: beforeWrite, exitCode: 1)
        #expect(refusal.contains("删除没有执行"), "写前拒那一支的读数被改掉了：\(refusal)")
        #expect(!refusal.contains("已经写进"), "这一趟根本没写到过盘，已落盘是假的：\(refusal)")
    }

    /// `found:true` 也否定另一句旧话：表里认得这一条、这一趟却没删掉、盘还读得开
    /// （daemon 写失败那一支），说「没找到这个项目」就是把 daemon 的 `found:true` 读反。
    /// REVERSE：删掉 `removeResultMessage` 末尾那条 `if found` 臂 → 红。
    @Test("S5-2 remove: a known id that survived the write is not reported as missing")
    func removeKnownIdNotRemovedHasItsOwnSentence() {
        let message = LocalArchive.removeResultMessage(
            cliRan: true, replyShaped: true, exitCode: 1,
            removed: false, loadFailed: false, found: true, needsRestart: false)
        #expect(message.contains("没把它删掉"), "读数: \(message)")
        #expect(!message.contains("没找到这个项目"), "它自己报了 found:true：\(message)")
        // 未知 id 那一支保持原样（负例）。
        let unknown = LocalArchive.removeResultMessage(
            cliRan: true, replyShaped: true, exitCode: 3,
            removed: false, loadFailed: false, found: false, needsRestart: false)
        #expect(unknown.contains("没找到这个项目"), "读数: \(unknown)")
    }

    /// `pruneResultMessage` 同形的一条：`loadFailed:true` 与 `requiresDaemonRestart:true`
    /// 同时成立就是「写完读不回」（动手前读不开那份载荷里这个键是 false，见下面的对照）。
    /// REVERSE：删掉 `pruneResultMessage` 里 `if needsRestart` 那一支 → 中间四条红。
    @Test("S5-2 prune: written-then-unreadable is never reported as nothing happened")
    func prunePostWriteReadBackFailure() {
        let message = LocalArchive.pruneResultMessage(
            cliRan: true, replyShaped: true, exitCode: 1,
            loadFailed: true, matched: 5, pruned: 0, failed: 5, needsRestart: true)
        #expect(message.contains("读不回"), "读数: \(message)")
        #expect(message.contains("重启"), "读数: \(message)")
        #expect(!message.contains("没有执行"), "这一趟写过盘，这句是编的：\(message)")
        #expect(!message.contains("未改动"), "读数: \(message)")
        #expect(!message.contains("保持原样"), "读数: \(message)")

        // 对照臂一：动手前读不开那份载荷——它自己说没有要重启（一次都没写）。
        let atLoad = ProjectRegistry.pruneUnreadableAtLoadPayload(
            dryRun: false, registryPath: registryPath)
        #expect((atLoad["requiresDaemonRestart"] as? Bool) == false,
                "夹具依赖 daemon 那份载荷的判据：写前拒不许带重启位")
        let refusal = LocalArchive.pruneResultMessage(
            cliRan: true, replyShaped: true, exitCode: 1,
            loadFailed: true, matched: 0, pruned: 0, failed: 0, needsRestart: false)
        #expect(refusal.contains("清理没有执行"), "写前拒那一支被顺手改成已动过盘：\(refusal)")

        // 对照臂二：预览那一趟读不回——它一次删除都没派过，仍该说没有执行。
        let dry = ProjectRegistry.pruneUnreadablePayload(
            total: 200, matched: 5, dryRun: true, registryPath: registryPath)
        #expect((dry["requiresDaemonRestart"] as? Bool) == false,
                "预览一趟没派过删除，这一支仍该说没有执行")
        let preview = LocalArchive.pruneResultMessage(
            cliRan: true, replyShaped: true, exitCode: 1,
            loadFailed: true, matched: 5, pruned: 0, failed: 0, needsRestart: false)
        #expect(preview.contains("清理没有执行"), "读数: \(preview)")
    }

    /// 面板那条折算链同样要吃到真载荷（`--project-prune` 写后读不回那一份）。
    /// REVERSE：`pruneActionMessage` 不交 `needsRestart` → 红。
    @Test("S5-2 prune: the panel folds the daemon payload into the new sentence")
    func pruneActionMessageFoldsTheReadBackFailure() {
        let payload = daemonJSON(ProjectRegistry.pruneUnreadablePayload(
            total: 200, matched: 5, dryRun: false, registryPath: registryPath))
        #expect((payload.contains("\"requiresDaemonRestart\":true")
                 || payload.contains("\"requiresDaemonRestart\" : true")),
                "夹具自己没带上那一位，后面那条对照就什么也没对照：\(payload)")
        let message = ConsoleModel.pruneActionMessage(
            cliRan: true, stdout: "", stderr: payload, exitCode: 1)
        #expect(message.contains("读不回"), "读数: \(message)")
        #expect(!message.contains("没有执行"), "读数: \(message)")
        #expect(!message.contains("未改动"), "读数: \(message)")

        let atLoad = daemonJSON(ProjectRegistry.pruneUnreadableAtLoadPayload(
            dryRun: false, registryPath: registryPath))
        let refusal = ConsoleModel.pruneActionMessage(
            cliRan: true, stdout: "", stderr: atLoad, exitCode: 1)
        #expect(refusal.contains("清理没有执行"), "读数: \(refusal)")
    }

    // MARK: - S5-3 注册项自己写过的路径也要量过在不在

    private let ownedDirectory = "/var/folders/xx/T/glasspane-evidence"
    private let sharedDirectory = "/var/tmp/glasspane-s5-3/evidence"

    private func control(
        registered: String?,
        registeredExists: Bool?,
        sharedExists: Bool? = true
    ) -> ConsoleModel.PanelControl {
        ConsoleModel.projectEvidenceDirectoryControl(
            registeredPath: registered,
            registeredDirectoryExists: registeredExists,
            sharedDirectory: sharedDirectory,
            sharedDirectoryExists: sharedExists,
            stateRootCaption: "后台服务这一帧上报的状态根 /var/tmp/glasspane-s5-3"
        )
    }

    /// 缺陷形状：`registered` 非空就无条件 `enabled:true`，而共用那一份的分支用了
    /// `Self.directoryIsPresent`。注册项写过的档案目录被系统/TTL 清掉时（最常见就是本页
    /// 点名要清的测试残留，`/var/folders/…` 按天清），按下 `NSWorkspace.selectFile`
    /// 无事发生、屏幕零字。
    /// REVERSE：把 `projectEvidenceDirectoryControl` 里注册项那三态折回无条件
    /// `enabled:true` → 「量到不在」与「还没量过」两支红。
    @Test("S5-3 the registered archive directory is gated on the same measurement")
    func registeredDirectoryUsesTheSameCriterion() {
        let present = control(registered: ownedDirectory, registeredExists: true)
        #expect(present.enabled, "量到在盘上就该按得动：\(present.help)")
        #expect(present.help.contains(ownedDirectory), "读数: \(present.help)")

        let absent = control(registered: ownedDirectory, registeredExists: false)
        #expect(!absent.enabled,
                "目录已被清掉还按得动，按下就是一次静默无反应：\(absent.help)")
        #expect(absent.help.contains("按不动"), "读数: \(absent.help)")
        #expect(absent.help.contains(ownedDirectory), "理由要点名量过的是哪一个去处：\(absent.help)")
        #expect(absent.help.contains("不在盘上"), "读数: \(absent.help)")
        #expect(absent.help.contains("下一步"), "禁用的一句话必须给得出下一步：\(absent.help)")
        #expect(absent.help.contains("刷新"), "读数: \(absent.help)")
        #expect(absent.help.contains("evidenceStoragePath"),
                "下一步要落在这一屏说得出的一件事上：\(absent.help)")
        // 这一句只说这一枚自己的去处，不许顺口替共用那一份说话（那是另一枚控件的读数）。
        #expect(!absent.help.contains(sharedDirectory), "读数: \(absent.help)")

        // 没量过不等于不在：两件事两句话，两种都不许开一个没验证过的位置。
        let unmeasured = control(registered: ownedDirectory, registeredExists: nil)
        #expect(!unmeasured.enabled, "没量过就按得动＝拿注册表里的一句话当实测：\(unmeasured.help)")
        #expect(unmeasured.help.contains("还没量过"), "读数: \(unmeasured.help)")
        #expect(!unmeasured.help.contains("不在盘上"),
                "把没量过说成那里没有，是另一件没观测到的事：\(unmeasured.help)")
    }

    /// 判据必须来自这一页扫注册表那一趟的真实测量，不是夹具里的布尔。
    /// 这一条起的是**真盘**：四条注册项——目录在、目录已被清掉、那个位置被一个文件占住、
    /// 没写目录——由 `reloadProjects()` 自己去量、自己去折算那一枚控件。
    /// REVERSE：删掉 `reloadProjects` 里 `registeredPresence` 那一次量 → 三条红（全落到「还没量过」）；
    /// 把判据换成 `directoryIsPresent(evidenceDirectory)`（借共用那一份的读数）→ 在的那一条红。
    @Test("S5-3 the projects scan measures each entry's own archive directory")
    func reloadProjectsMeasuresRegisteredDirectories() async throws {
        let root = TestSandbox.directory("s5-3-root")
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
        let present = root + "/archive-present"
        try FileManager.default.createDirectory(atPath: present, withIntermediateDirectories: true)
        let absent = root + "/archive-gone"  // 故意不建：注册项写过、盘上已没有
        let takenByFile = root + "/archive-file"
        try Data("x".utf8).write(to: URL(fileURLWithPath: takenByFile))

        let registry = ProjectRegistry(filePath: root + "/projects.json")
        _ = try registry.create(
            displayName: "Present", bundleId: "com.glasspane.selftest",
            evidenceStoragePath: present)
        _ = try registry.create(
            displayName: "Gone", bundleId: "com.glasspane.selftest.two",
            evidenceStoragePath: absent)
        _ = try registry.create(
            displayName: "Taken", bundleId: "com.glasspane.selftest.three",
            evidenceStoragePath: takenByFile)
        _ = try registry.create(displayName: "NoPath", bundleId: "com.glasspane.selftest.four")

        let console = ConsoleModel(
            evidenceDirectory: root + "/shared-evidence",
            projectsPath: root + "/projects.json",
            approvalsPath: root + "/approvals.json"
        )
        let sharedDirectoryUnderTest = root + "/shared-evidence"
        console.reloadProjects()
        var settled = false
        for _ in 0..<200 {
            if console.projectsState == .loaded && console.projects.count == 4 { settled = true; break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        guard settled else {
            Issue.record("注册表这一趟没落地，控件的判据无从可断：\(console.projectsState)")
            return
        }

        func entry(_ displayName: String) throws -> ProjectEntry {
            guard let found = console.projects.first(where: { $0.displayName == displayName }) else {
                throw FixtureError.entryMissing(displayName)
            }
            return found
        }

        let measured = console.registeredEvidenceDirectoryExists
        #expect(measured.count == 3,
                "三条写了目录的注册项都该被量到，没写目录那条不许有一个数：\(measured)")
        #expect(measured[try entry("Present").projectId] == true,
                "在盘上的那一份被量成了不在（或没量）：\(measured)")
        #expect(measured[try entry("Gone").projectId] == false,
                "已经不在的那一份被量成了在（或没量）：\(measured)")
        #expect(measured[try entry("Taken").projectId] == false,
                "一个文件不是访达能打开的去处，它不该被算作档案目录：\(measured)")
        #expect(measured[try entry("NoPath").projectId] == nil,
                "没写目录的注册项不该在这一份读数里冒出一个数：\(measured)")

        #expect(console.projectEvidenceDirectoryControl(for: try entry("Present")).enabled,
                "量到在盘上，这一枚就该按得动")
        let gone = console.projectEvidenceDirectoryControl(for: try entry("Gone"))
        #expect(!gone.enabled, "按下 NSWorkspace.selectFile 无事发生、屏幕零字的那一支：\(gone.help)")
        #expect(gone.help.contains(absent), "读数: \(gone.help)")
        let taken = console.projectEvidenceDirectoryControl(for: try entry("Taken"))
        #expect(!taken.enabled, "被文件占住的那个位置同样不是去处：\(taken.help)")
        let noPath = console.projectEvidenceDirectoryControl(for: try entry("NoPath"))
        // 没写目录的那一条开的是本页共用的那一份，判据仍来自它自己那一次实测（这里没建过）。
        #expect(!noPath.enabled, "共用那一份也没量到在，这一枚不该按得动：\(noPath.help)")
        #expect(noPath.help.contains(sharedDirectoryUnderTest), "读数: \(noPath.help)")
    }

    /// 形状闸：视图那侧确实把这一枚控件的判据挂在 disabled 与 help 上。
    @Test("S5-3 shape: the control renders the measured answer")
    func viewRendersTheMeasuredGate() throws {
        let model = try PanelSourceText.code("ConsoleModel.swift")
        #expect(model.contains("self.registeredEvidenceDirectoryExists = registeredPresence"),
                "量到的那一次没落进状态，控件只好继续按「注册时写过所以应该还在」来亮")
        #expect(model.contains("registeredDirectoryExists: registeredEvidenceDirectoryExists[entry.projectId]"),
                "落进了状态却没递给这一枚，等于白量")
        let projects = try PanelSourceText.code("ProjectsTabView.swift")
        #expect(projects.contains(".disabled(!evidenceDirectoryEnabled(entry))"),
                "那一枚又回到永远按得动")
        #expect(projects.contains(".help(evidenceDirectoryHelp(entry))"),
                "按不动时那句理由与下一步必须挂在它自己身上")
    }
}

