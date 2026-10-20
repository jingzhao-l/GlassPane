import XCTest
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 2026-10-20 每日轮的引擎侧修复。每一条都带一次"能变红"的对照：判据要么打在真二进制/真
/// 文件系统上，要么同时钉住正例与反例，绝不用"跑过了"代替"这条断言会因这个缺陷而失败"。
final class DailyRound20261020Tests: XCTestCase {

    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }
        return url.path
    }

    private var daemonBinary: String { repoRoot + "/.build/debug/glasspaned" }

    private func run(_ args: [String]) -> (status: Int32, out: String, err: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: daemonBinary)
        process.arguments = args
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try! process.run()
        let stdoutData = out.fileHandleForReading.readDataToEndOfFile()
        let stderrData = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus,
                String(data: stdoutData, encoding: .utf8) ?? "",
                String(data: stderrData, encoding: .utf8) ?? "")
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOfFile: repoRoot + "/Sources/" + relative, encoding: .utf8)
    }

    private func isoNow(_ offset: TimeInterval = 0) -> String {
        EvidenceStore.isoDateFormatter.string(from: Date().addingTimeInterval(offset))
    }

    /// id 由生成器给：档案名的形状由 `OperationID` 决定，手写一个"看着像"的 id 会让
    /// 这条用例测在 schema 语法上，而不是测在我真正改的那处 id 比对上。
    private func opId(_ seed: UInt64) -> String {
        OperationID.generate(
            milliseconds: seed,
            entropy: [UInt8](repeating: UInt8(seed & 0xFF), count: 10),
            prefix: "op_"
        )
    }

    private func pack(_ operationId: String, contaminated: Bool = false, reason: String? = nil) -> EvidencePack {
        EvidencePack(
            operationId: operationId,
            createdAt: isoNow(),
            attribution: Attribution(level: .soft, contaminated: contaminated),
            circuitBreaker: CircuitBreaker(level: .normal, reason: reason),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: "提交"),
                    action: .press,
                    actConfirmed: true
                )
            )
        )
    }

    // MARK: - 证据档案的文件名必须与包里的 operationId 对上（改名/复制即拒答）

    func testARenamedPackIsNeverAnsweredAsTheOperationItsFileNameNames() throws {
        let dir = TestSandbox.directory("readbinding")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        TestSandbox.assertIsolated(dir, label: "archive")
        let now = Date()
        let store = EvidenceStore(directory: dir, maxFiles: nil, now: { now })

        let realId = opId(1)
        let forgedId = opId(99)
        let real = pack(realId)
        XCTAssertTrue(store.write(real), "写一次真档案必须成功，否则这条闸只是永远拒")
        let realPath = dir + "/" + realId + "." + EvidenceStore.fileExtension
        let forgedPath = dir + "/" + forgedId + "." + EvidenceStore.fileExtension
        XCTAssertTrue(FileManager.default.fileExists(atPath: realPath), realPath)
        try FileManager.default.copyItem(atPath: realPath, toPath: forgedPath)

        // 反例：把 A 的字节放到 B 的档案名下。读 B 必须回 nil（→ GP_E_NO_EVIDENCE），
        // 不许把 A 的测量当成 B 的结论交给 gp_last_evidence、面板与 HTML 报告。
        XCTAssertNil(store.read(operationId: forgedId),
                     "包内 operationId 与文件名不一致时必须拒答；答出来就是把一次别的操作的测量冒充成这个操作的")
        // 正例：同一个字节在它自己的名字下仍然读得到——否则这条修复只是永远报错。
        let readBack = try XCTUnwrap(store.read(operationId: realId))
        XCTAssertEqual(readBack.operationId, realId)
    }

    // MARK: - 列表那一侧不许替引擎声称一次它拒绝做出的测量

    func testSummaryCarriesTheBreakerReasonAndTheRowTextSeparatesMeasuredFromAssumed() throws {
        let notMonitored = pack("op_a", contaminated: true, reason: "input-contamination-not-monitored")
        let watched = pack("op_b", contaminated: true, reason: "performance|handler-not-run")
        let quiet = pack("op_c", contaminated: false)

        let a = EvidenceSummary.from(pack: notMonitored, fileBytes: 100)
        let b = EvidenceSummary.from(pack: watched, fileBytes: 100)
        let c = EvidenceSummary.from(pack: quiet, fileBytes: 100)
        XCTAssertEqual(a.breakerReason, "input-contamination-not-monitored",
                       "from(pack:) 不把 circuitBreaker.reason 带进摘要，行里就没有任何依据区分『测到了』与『没人看守按保守判』")
        XCTAssertNil(c.breakerReason)

        XCTAssertEqual(EvidenceCopy.contaminationChip(contaminated: true, breakerReason: a.breakerReason),
                       "污染未经监测")
        XCTAssertEqual(EvidenceCopy.contaminationChip(contaminated: true, breakerReason: b.breakerReason),
                       "有人同时操作")
        XCTAssertEqual(EvidenceCopy.contaminationChip(contaminated: false, breakerReason: nil), "",
                       "判净的一侧不在列表里挂这一枚")
        XCTAssertFalse(EvidenceCopy.wasWatched(breakerReason: a.breakerReason))
        XCTAssertTrue(EvidenceCopy.wasWatched(breakerReason: b.breakerReason))
    }

    func testContaminatedFilterTitleDoesNotClaimAMeasurement() {
        // 过滤器按结论筛（保守判污的也在里面），所以标题不许说"有人同时操作"——
        // `--no-c33` 起的 daemon 每一行都落在这个筛子里，而没有任何一行被看守过。
        XCTAssertNotEqual(EvidenceFilter.contaminated.title, "有人同时操作",
                          "标题把未看守的行说成看守过，与行文案自相矛盾")
        XCTAssertTrue(EvidenceFilter.contaminated.title.contains("污染"),
                      "标题仍要指得出这一筛是什么：\(EvidenceFilter.contaminated.title)")
        let unwatched = EvidenceSummary.from(
            pack: pack("op_u", contaminated: true, reason: "input-contamination-monitor-lost"), fileBytes: 1)
        XCTAssertTrue(EvidenceFilter.contaminated.matches(unwatched),
                      "筛子按 contaminated 这个结论走，保守判污的仍在其中")
    }

    // MARK: - 开发者工具卡：附加那一臂没答上来就不是已授权（启动臂不许代答）

    func testGrantedFollowsTheAttachArmNotTheOredPair() {
        XCTAssertFalse(DebugCapabilityProbe.Snapshot(launch: .ok, attach: .spawnFailed).granted,
                       "附加那一臂压根没得到答案，卡却点亮『可用（实测）』= 面板替引擎声称了一次引擎没做的测量")
        XCTAssertFalse(DebugCapabilityProbe.Snapshot(launch: .ok, attach: .timeout).granted)
        XCTAssertTrue(DebugCapabilityProbe.Snapshot(launch: .denied, attach: .ok).granted == false,
                      "实测到的拒绝不被另一半折掉")
        XCTAssertTrue(DebugCapabilityProbe.Snapshot(launch: .ok, attach: .ok).granted)
    }

    func testCardIgnoresAnOlderPayloadsOredGrantedFlag() {
        // 旧版 daemon 发来的 `granted` 是或值。卡只认两臂的实测词，否则一份
        // launch:ok/attach:spawnFailed/granted:true 的负载在新面板上依旧点绿。
        let old = DeveloperToolsCapability.Report(
            launch: "ok", attach: "spawnFailed", granted: true,
            observedAt: Date(timeIntervalSince1970: 1_760_000_000))
        XCTAssertEqual(old.status, .unverifiable,
                       "or 值把没问过的臂说成授权，正是这张卡存在的意义所禁止的")
        let fresh = DeveloperToolsCapability.Report(launch: "timeout", attach: "ok", granted: true,
                                                    observedAt: Date(timeIntervalSince1970: 1_760_000_000))
        XCTAssertEqual(fresh.status, .granted, "对照：附加臂真的答了 ok，才点绿")
    }

    // MARK: - 方法表与 § 引用：抄写的那一份与说给人听的那一句

    func testMethodNotFoundRemedyIsDerivedFromTheMethodTableItself() {
        let remedy = GPError.remedy(for: .methodNotFound)
        for method in EngineMethod.allCases {
            XCTAssertTrue(remedy.contains(method.rawValue),
                          "remedy 少了一格 \(method.rawValue)，下一个加方法的人会被指到一张不全的表前：\(remedy)")
        }
        XCTAssertFalse(remedy.contains("probe,"), "表里从前抄出一个线上不存在的 `probe`")
    }

    func testEmittedRemediesCarryNoSpecSectionReferences() {
        // 对外文案是给 agent 读的：`P0 spec §3.3` 那种括号既不指路也不可执行。
        for code in GPErrorCode.allCases {
            let text = GPError.remedy(for: code)
            XCTAssertFalse(text.contains("§"), "\(code.rawValue) 的 remedy 里还有规格章节号：\(text)")
        }
    }

    func testReportNumberFormatFollowsThePercentGRuleOnEveryLocaleFreePath() {
        XCTAssertEqual(EvidenceReportGenerator.doubleText(0.25), "0.25")
        XCTAssertEqual(EvidenceReportGenerator.doubleText(1234.5678), "1234.57")
        XCTAssertEqual(EvidenceReportGenerator.doubleText(9), "9")
        XCTAssertEqual(EvidenceReportGenerator.doubleText(1234567), "1.23457e+06")
        // 这两个边界就是"交给 Foundation 显式 locale"那条修法露馅的地方：POSIX locale 的
        // %g 把 999999.5 印成 `1000000`，而规则要的是 `1e+06`（TS 那份也是后者）。
        XCTAssertEqual(EvidenceReportGenerator.doubleText(999999.5), "1e+06")
        XCTAssertEqual(EvidenceReportGenerator.doubleText(1.234567e-05), "1.23457e-05")
        XCTAssertEqual(EvidenceReportGenerator.doubleText(1e21), "1e+21")
        XCTAssertEqual(EvidenceReportGenerator.doubleText(-0.25), "-0.25")
        // 隐式 locale 确实会改分隔符——这条对照保证"上面的断言不是恰好在这台机器上成立"。
        let comma = String(format: "%g", locale: Locale(identifier: "de_DE"), arguments: [0.25])
        XCTAssertEqual(comma, "0,25", "对照本身要能变红：把格式化交回 locale 就会改这个数")
        XCTAssertNotEqual(EvidenceReportGenerator.doubleText(0.25), comma)
    }

    // MARK: - CLI：`--key=value` 是一种写法，不是两个开关的特权

    func testEqualsSpellingReachesEachFlagsOwnValidation() throws {
        XCTAssertTrue(FileManager.default.fileExists(atPath: daemonBinary), "真二进制不在：\(daemonBinary)")
        // `--older-than=abc` 从前落到 default 分支 ⇒ "unknown argument" + 64；现在它必须
        // 走到这一位自己的取值校验（rc 2，且说的是取值）。
        let badNumber = run(["--prune-evidence", "--older-than=abc"])
        XCTAssertEqual(badNumber.status, 2, "\(badNumber.status)/\(badNumber.err)")
        XCTAssertTrue(badNumber.err.contains("--older-than requires a positive integer"), badNumber.err)
        // `--request-permission=x` 同理：报"unknown kind"，而不是"unknown argument"。
        let badKind = run(["--request-permission=not-a-seat"])
        XCTAssertEqual(badKind.status, 64, "\(badKind.status)/\(badKind.err)")
        XCTAssertTrue(badKind.err.contains("--request-permission unknown kind"), badKind.err)
        // 对照：不认识的开关仍旧不认识，且报的是裁掉 `=value` 之后的那一半名字。
        let unknown = run(["--definitely-not-a-flag=1"])
        XCTAssertEqual(unknown.status, 64, "\(unknown.status)/\(unknown.err)")
        XCTAssertTrue(unknown.err.contains("unknown argument: --definitely-not-a-flag"), unknown.err)
    }

    func testGuideScreenPermissionExitCodeFollowsTheReading() throws {
        let body = try source("glasspaned/main.swift")
        XCTAssertTrue(body.contains("exit(guided == .granted ? 0 : 1)"),
                      "--guide-screen-permission 的退出码必须跟着这次读到的席位走；从前它打印『still not granted』之后退 0")
        XCTAssertFalse(body.contains("runGuideScreenPermission(probe)\n    }\n    if false"), "占位，防呆")
        // 真机：席位已授予时这一条是无副作用的（它只说一句 already granted）。
        let check = run(["--check-screen-permission"])
        if check.out.trimmingCharacters(in: .whitespacesAndNewlines) == "granted" {
            let guided = run(["--guide-screen-permission"])
            XCTAssertEqual(guided.status, 0, "已授予时退 0：\(guided.out)/\(guided.err)")
        } else {
            throw XCTSkip("本机屏幕录制席位读数不是 granted，跑这条会真去开系统设置面板；补法：先授予再跑 `glasspaned --guide-screen-permission; echo $?`")
        }
    }

    // MARK: - socket 叶子符号链接：bind 之前就拒，不在没看过的东西上赌

    func testSocketLeafSymlinkIsRefusedBeforeAnythingIsCreated() throws {
        let dir = TestSandbox.directory("socketleaflink")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        TestSandbox.assertIsolated(dir, label: "socket parent")
        let link = dir + "/engine.sock"
        let target = dir + "/elsewhere.sock"
        // 悬空链接：`bind()` 会顺着它在**别处**造出监听点，chmod/unlink 都打在链接的另一头，
        // 而两条既有守卫都只在 EADDRINUSE 那一支跑——这个形状 bind 是成功的。
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: target)
        let core = EngineCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard), settle: {})
        let server = SocketServer(socketPath: link, dispatcher: Dispatcher(core: core, log: EngineLog(quiet: true)),
                                  log: EngineLog(quiet: true))
        // `run()` binds and then would enter the accept loop, so the call is parked on a worker:
        // if the guard were missing, the bind *succeeds through the link* and this test must say
        // so on a timeout rather than hang forever — a control that can only hang is not a control.
        var thrown: Error?
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue(label: "gp-daily-20261020-bind").async {
            do { try server.run() } catch { thrown = error }
            finished.signal()
        }
        if finished.wait(timeout: .now() + 10) == .timedOut {
            server.cleanup()
            XCTFail("叶子符号链接必须在 bind 之前被拒；十秒内没抛出，说明它顺链把监听点建到了别处")
            return
        }
        guard case SocketErrorResponse.nameOccupied(let detail)? = thrown as? SocketErrorResponse else {
            return XCTFail("要回 nameOccupied，实得 \(String(describing: thrown))")
        }
        XCTAssertTrue(detail.contains("symlink"), detail)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target),
                       "被拒的那一趟不许在链接的另一头造出任何东西")
        // 悬空链接用 `fileExists` 量不到（它跟链走），必须 `lstat` 看这个名字本身。
        var linkInfo = stat()
        XCTAssertEqual(lstat(link, &linkInfo), 0, "拒不等于删：那不是 daemon 拥有的名字")
        XCTAssertEqual(linkInfo.st_mode & S_IFMT, S_IFLNK, "那个位置仍应是原来那条链接")
    }

    // MARK: - 状态根收紧：跑不到的那一趟也不许 chmod 链接的另一头

    func testTightenPermissionsRefusesASymlinkedRootAndLeavesTheTargetAlone() throws {
        let dir = TestSandbox.directory("tightenlink")
        let fm = FileManager.default
        try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        TestSandbox.assertIsolated(dir, label: "tighten parent")
        let target = dir + "/real"
        try fm.createDirectory(atPath: target, withIntermediateDirectories: true)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target)
        let link = dir + ".glasspane-link"
        try fm.createSymbolicLink(atPath: link, withDestinationPath: target)

        let notes = StateRoot(path: link).tightenPermissions(log: EngineLog(quiet: true))
        XCTAssertFalse(notes.isEmpty, "符号链接的状态根必须报一条缺陷，而不是安静地 chmod 目标目录")
        var info = stat()
        XCTAssertEqual(lstat(target, &info), 0)
        XCTAssertEqual(Int(info.st_mode & 0o777), 0o755,
                       "目标目录的模式必须原样：这一趟本该什么都不改（它连 bind 都走不到）")
        XCTAssertTrue(fm.fileExists(atPath: link), "拒的那一支不删别人的链接")
    }
}
