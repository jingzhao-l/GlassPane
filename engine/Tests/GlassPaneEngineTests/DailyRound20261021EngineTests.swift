import XCTest
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 2026-10-21 每日轮的引擎侧修复。逐条对应本轮审出的缺陷，每条都写明"破坏哪一句会让它变红"。
final class DailyRound20261021EngineTests: XCTestCase {

    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }
        return url.path
    }

    private var daemonBinary: String { repoRoot + "/.build/debug/glasspaned" }

    private func source(_ relative: String) throws -> String {
        try String(contentsOfFile: repoRoot + "/Sources/" + relative, encoding: .utf8)
    }

    /// 一律走 `TestSandbox`：本仓的隔离闸把"自己拼一个临时路径"列为违规（进程共享的
    /// tmp 名别人也能挑中），而运行时 `assertIsolated` 才是隔离的定义。
    private func makeScratch(_ name: String) throws -> String {
        let base = TestSandbox.directory("gp2021-\(name)")
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: base)
        return base
    }

    private func json(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return object
    }

    // MARK: - 1. remedy 里的路径必须是 shell 安全的一份字面量

    /// `RemedyCommand.quote` 是唯一的出口：单引号包住，值里的单引号折成 `'\''`。
    /// REVERSE：把 `value.replacingOccurrences(...)` 去掉 → 第三条断言红；把外层单引号
    /// 去掉 → 第一条断言红。
    func testRemedyCommandQuoteKeepsAPathAsOneWord() {
        XCTAssertEqual(RemedyCommand.quote("/tmp/a b"), "'/tmp/a b'")
        XCTAssertEqual(RemedyCommand.quote("/tmp/plain"), "'/tmp/plain'")
        XCTAssertEqual(
            RemedyCommand.quote("/tmp/it's"),
            "'/tmp/it'\\''s'",
            "值里的单引号必须折成 close-escape-open，否则它提前闭合了引号，后面的一半就成了命令"
        )
        XCTAssertEqual(RemedyCommand.quote(""), "''", "空路径要是一个看得见的空参数，不是凭空消失的参数")
    }

    /// 真形状：把带 `;`、`$()`、空格、单引号的路径喂给**真的**载荷生产者，再把它回话里
    /// 每一条反引号命令拆出来核。判据不是"字符串里有个引号"，而是"这条命令被整行复制
    /// 进 sh 之后，那个分号仍然只是文件名的一部分"。
    /// REVERSE：把 `pruneUnreadableAtLoadPayload` 里 `RemedyCommand.quote(registryPath)`
    /// 换回裸 `\(registryPath)` → 带分号那一路径的用例红。
    func testEveryRemedyCommandPresentsTheHostilePathAsData() throws {
        let hostiles = [
            "/tmp/x;touch /tmp/GP_PWNED",
            "/tmp/$(touch /tmp/GP_PWNED)",
            "/tmp/a b/projects.json",
            "/tmp/it's/projects.json",
            "/tmp/`touch /tmp/GP_PWNED`/projects.json",
        ]
        for path in hostiles {
            let quoted = RemedyCommand.quote(path)
            for text in [
                (ProjectRegistry.pruneUnreadableAtLoadPayload(
                    dryRun: false, registryPath: path)["next"] as? String) ?? "",
                (ProjectRegistry.removalUnreadableAtLoadPayload(
                    projectId: "prj_X", dryRun: true, registryPath: path)["next"] as? String) ?? "",
            ] {
                XCTAssertFalse(text.isEmpty, "拒绝载荷没给出下一步")
                XCTAssertTrue(text.contains(quoted), "这条命令里没有引号包好的路径：\(text)")
                // 把每一处引号包好的形态遮掉，剩下的文本里不许还有这个路径——那一份就是
                // 会被 shell 执行的那一份。含单引号的路径要按转义后的形态遮，否则遮不掉。
                let masked = text.replacingOccurrences(of: quoted, with: "«quoted-path»")
                XCTAssertFalse(
                    masked.contains(path),
                    "路径有一份裸出现在会被执行的文本里：\(masked)"
                )
                XCTAssertEqual(
                    Self.count(of: "json.tool", in: text), Self.count(of: "«quoted-path»", in: masked),
                    "每一条命令都只许拿到遮好的那份路径：\(masked)"
                )
            }
        }
        // 载荷里必须真有可执行命令，否则"给了下一步"只是句安慰话。
        let next = (ProjectRegistry.pruneUnreadableAtLoadPayload(
            dryRun: false, registryPath: "/tmp/x/projects.json")["next"] as? String) ?? ""
        XCTAssertTrue(next.contains("python3 -m json.tool"), next)
    }

    private static func count(of needle: String, in text: String) -> Int {
        guard !needle.isEmpty else { return 0 }
        var found = 0
        var search = Substring(text)
        while let range = search.range(of: needle) {
            found += 1
            search = search[range.upperBound...]
        }
        return found
    }

    private static func backtickedCommands(_ text: String) -> [String] {
        var found: [String] = []
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "`") {
            let after = rest.index(after: open)
            guard let close = rest[after...].firstIndex(of: "`") else { break }
            found.append(String(rest[after..<close]))
            rest = rest[rest.index(after: close)...]
        }
        return found
    }

    // MARK: - 2. --state-dir 不许指着 / 或 home

    /// 清扫在 `tightenPermissions` 里 chmod 它拿到的那个根，而它跑在 bind 之前——所以
    /// `--state-dir ~` 从前是"把用户主目录锁成 0700，然后照常起服务"。判据只认参数，
    /// 在任何一次 chmod 之前。
    /// REVERSE：删掉 `classify` 里 `Self.notADedicatedRoot(raw)` 那一道 guard → 前两条红。
    func testStateDirRefusesRootsThisProductDoesNotOwn() {
        let home = NSHomeDirectory()
        XCTAssertNotNil(StateRootArgument.notADedicatedRoot("/"), "文件系统根必须拒")
        XCTAssertNotNil(StateRootArgument.notADedicatedRoot(home), "home 本身必须拒")
        XCTAssertNotNil(StateRootArgument.notADedicatedRoot(home + "/"), "带尾斜杠的 home 是同一个目录，同样拒")
        XCTAssertNil(StateRootArgument.notADedicatedRoot(home + "/.glasspane"), "默认位置不能被误拒")
        XCTAssertNil(StateRootArgument.notADedicatedRoot("/var/tmp/gp-state"), "专用目录照旧收")
        XCTAssertNotNil(StateRootArgument.rejection(for: "/"))
        let reason = StateRootArgument.rejection(for: home) ?? ""
        XCTAssertTrue(
            reason.contains("--state-dir"),
            "拒绝要给出一条能照着写的替代，而不是只说不行：\(reason)"
        )
    }

    /// 真进程那一条只跑 `--state-dir /`。**故意不用 home 做这条的输入**：这条用例证明的是
    /// "拒绝发生在 chmod 之前"，而一旦那个 guard 退化了，拿 home 当参数的用例会先把开发者
    /// 自己的主目录锁成 0700 —— 一条能伤害机器的对照不算对照（`TestIsolationGateTests` 立
    /// 的就是这条规矩）。`/` 不同：guard 退化时非 root 的 chmod(0700) 只会失败，机器无损。
    /// home 那一臂由上一条纯函数用例负责，它不碰文件系统。
    /// REVERSE：把 `--state-dir` 的那道 guard 摘掉 → 这条红（进程会走到 bind）。
    func testDaemonRefusesTheFilesystemRootBeforeTouchingAnything() throws {
        var before = stat()
        XCTAssertEqual(stat("/", &before), 0)
        let result = Self.run([daemonBinary, "--state-dir", "/", "--permissions"])
        XCTAssertEqual(result.status, 64, "文件系统根当状态根要拒在服务动手之前，实际退出码 \(result.status)：\(result.err.prefix(200))")
        XCTAssertTrue(result.err.contains("filesystem root"), result.err)
        var after = stat()
        XCTAssertEqual(stat("/", &after), 0)
        XCTAssertEqual(Int(before.st_mode & 0o777), Int(after.st_mode & 0o777), "--state-dir / 不许改 `/` 的权限位")
    }

    // MARK: - 3. 读不开的注册表：拒绝载荷不许带任何"答案"键

    /// REVERSE：把 `pruneUnreadableAtLoadPayload` 里加回 `"matched": 0` → 红。
    func testPruneRefusalCarriesNoCountsItCouldNotMeasure() {
        let payload = ProjectRegistry.pruneUnreadableAtLoadPayload(
            dryRun: true, registryPath: "/tmp/whatever/projects.json"
        )
        XCTAssertEqual(payload["command"] as? String, "--project-prune")
        XCTAssertEqual(payload["loadFailed"] as? Bool, true)
        XCTAssertEqual(payload["dryRun"] as? Bool, true)
        for key in ["total", "matched", "pruned", "prunedProjectIds", "remaining", "projects", "failed", "failures"] {
            XCTAssertNil(payload[key], "`\(key)` 是一条测量结果，而这一趟什么都没读到——它从前写 0，读的人只会记住 0")
        }
        XCTAssertEqual(payload["requiresDaemonRestart"] as? Bool, false, "一次没动过任何东西的拒绝不该凭空造一个待办")
        XCTAssertNotNil(payload["error"] as? String)
        XCTAssertNotNil(payload["next"] as? String)
    }

    /// REVERSE：加回 `"found": false` → 红。
    func testRemoveRefusalDoesNotInventAnAbsence() {
        let payload = ProjectRegistry.removalUnreadableAtLoadPayload(
            projectId: "prj_ABC", dryRun: false, registryPath: "/tmp/whatever/projects.json"
        )
        XCTAssertEqual(payload["loadFailed"] as? Bool, true)
        XCTAssertEqual(payload["projectId"] as? String, "prj_ABC")
        for key in ["found", "wouldRemove", "removed", "remaining", "total"] {
            XCTAssertNil(payload[key], "`\(key)` 在打不开的文件上没有被测量过")
        }
    }

    /// 载荷必须在库里，CLI 只许调用它——否则这份形状没有读者也没有闸（`--active-project`
    /// 的同类缺陷就是这么来的：判据写在 main.swift 里，谁也测不到）。
    /// REVERSE：把 `runProjectPrune` 的拒绝分支改回手拼字典 → 红。
    func testWriteSideRefusalsRouteThroughTheLibrary() throws {
        let main = try source("glasspaned/main.swift")
        XCTAssertTrue(
            main.contains("ProjectRegistry.pruneUnreadableAtLoadPayload("),
            "prune 的读不开分支没走库，载荷成了 CLI 里的私有拼法"
        )
        XCTAssertTrue(
            main.contains("ProjectRegistry.removalUnreadableAtLoadPayload("),
            "remove 的读不开分支没走库"
        )
        let prune = Self.functionBody(main, startsAt: "private func runProjectPrune", stopsBefore: "private func runProjectRemove")
        XCTAssertFalse(
            prune.contains("\"matched\": 0") || prune.contains("\"remaining\": before.count"),
            "CLI 里又出现了裸写的 0 计数"
        )
        let remove = Self.functionBody(main, startsAt: "private func runProjectRemove", stopsBefore: "private func runEvidence")
        XCTAssertFalse(remove.contains("\"found\": false, \"removed\": false, \"wouldRemove\": false"),
                       "CLI 里又拼了一份拒绝载荷")
    }

    /// 真进程 + 真坏文件：损坏的 projects.json 必须让两条写命令给出无计数形状的拒绝。
    /// REVERSE：把 `pruneUnreadableAtLoadPayload` 换成旧手拼 → 第二条断言红。
    func testRealDaemonRefusesToWriteAnUnreadableRegistryWithoutCounts() throws {
        let root = try makeScratch("registries")
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root)
        let projects = root + "/projects.json"
        try Data("{ this is not json ".utf8).write(to: URL(fileURLWithPath: projects))
        for arguments in [["--project-prune", "--dry-run"], ["--project-remove", "prj_ANY"]] {
            let result = Self.run([daemonBinary, "--state-dir", root] + arguments)
            XCTAssertEqual(result.status, 1, "读不开的写命令必须退 1，实际 \(result.status)：\(result.err.prefix(200))")
            guard let payload = json(result.err.isEmpty ? result.out : result.err) else {
                return XCTFail("拒绝回话不是 JSON：\(result.err.prefix(200))")
            }
            XCTAssertEqual(payload["loadFailed"] as? Bool, true)
            for key in ["matched", "remaining", "found", "wouldRemove", "projects"] {
                XCTAssertNil(payload[key], "真进程的回话里又出现了 \(key)：那条 0 是编的")
            }
        }
    }

    /// 面板侧的接缝：新的拒绝载荷不带 `matched`，所以"读不开"必须在"没有 matched"之前判，
    /// 否则一个如实的拒绝会被念成"后台服务没按约定回答"。
    /// REVERSE：把 `ConsoleModel.prunePreviewOutcome` 里 loadFailed 那道判断挪回 `matched`
    /// 之后 → 红。
    func testPanelNamesTheUnreadableRegistryRatherThanAMissingField() {
        let refusal = #"{"command":"--project-prune","dryRun":true,"loadFailed":true,"registryPath":"/tmp/x/projects.json","error":"unreadable","next":"repair it"}"#
        let outcome = ConsoleModel.prunePreviewOutcome(
            cliRan: true, stdout: "", stderr: refusal, exitCode: 1
        )
        guard case .refused(let message) = outcome else {
            return XCTFail("一份 loadFailed 的拒绝被折成了 \(String(describing: outcome))")
        }
        XCTAssertTrue(message.contains("注册表读不开"), "拒绝理由说错了事：\(message)")
        XCTAssertFalse(message.contains("没有 matched 字段"), "把载荷故意不给的键报成对方失职：\(message)")
    }

    // MARK: - 4. 协议层的两处自相矛盾

    /// 入站超长与出站超长是两个方向，共用一句 remedy 时另一半必然指错旋钮。
    /// REVERSE：把 `Dispatcher.handle` 的 `.oversize` 换回 `GPError(code:message:)`（用表里
    /// 那条通用 remedy）→ 红。
    func testInboundOversizeNamesTheRequestItBelongsTo() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let dispatcher = Dispatcher(core: EngineCore(channel: channel, settle: {}))
        let reply = dispatcher.handle(.oversize)
        guard let payload = json(String(data: reply, encoding: .utf8) ?? ""),
              let error = payload["error"] as? [String: Any] else {
            return XCTFail("超长帧没有回结构化错误：\(String(data: reply, encoding: .utf8) ?? "")")
        }
        XCTAssertEqual(error["code"] as? String, "GP_E_PAYLOAD_TOO_LARGE")
        let remedy = (error["remedy"] as? String) ?? ""
        XCTAssertTrue(remedy.contains("request you sent"), "入站帧被支去调输出的旋钮：\(remedy)")
        XCTAssertFalse(remedy.contains("maxDepth"), "maxDepth 缩不了调用方发来的这一行：\(remedy)")
        XCTAssertTrue(remedy.contains("Nothing was executed"), "入站拒绝必须说清这条指令没被执行，否则重发会被当成重复操作")
    }

    /// 同一帧里 message 与 remedy 不许报两张表。
    /// REVERSE：把 `remedy(for: .methodNotFound)` 改回 `EngineMethod.allCases` → 红。
    func testMethodNotFoundFrameTellsOneConsistentStory() throws {
        guard case .failure(let failure) = RequestParser.parse(Data(#"{"id":1,"method":"nope"}"#.utf8)) else {
            return XCTFail("未知方法应当走 .failure")
        }
        let text = failure.error.message
        let remedy = failure.error.remedy
        let advertised = EngineMethod.capabilityWireNames
        for name in advertised {
            XCTAssertTrue(text.contains(name), "message 少了协商过的方法 \(name)")
            XCTAssertTrue(remedy.contains(name), "remedy 少了同一个方法 \(name)")
        }
        XCTAssertFalse(
            advertised.contains("shutdown") && remedy.range(of: "/shutdown/") != nil,
            "remedy 又把传输方法混进可调用清单：\(remedy)"
        )
        XCTAssertTrue(
            remedy.contains("\(EngineMethod.allCases.count) names are dispatched"),
            "两张表的关系要说出来，不能让人自己猜：\(remedy)"
        )
    }

    /// 能力清单只有一份派生源，且 `hello`/`shutdown` 不在其中——remedy 里那句"两张表的关系"
    /// 就是从这一份数出来的，所以它不许变成第二处手抄。（`FrameCodec.swift` 的字节被
    /// `harness/glasspane-harness/contracts/engine-methods.json` 的 `swiftBlob` 钉住，
    /// 顺手在那儿加一个谓词就是改一件跨仓的产物，本轮为此把重构退了回来。）
    /// REVERSE：把 `capabilityMethods` 的过滤条件删成恒含两个传输方法 → 前两条红。
    func testCapabilityListIsDerivedAndExcludesTransport() {
        XCTAssertEqual(EngineMethod.capabilityMethods.count, EngineMethod.allCases.count - 2)
        XCTAssertEqual(
            Set(EngineMethod.capabilityMethods),
            Set(EngineMethod.allCases).subtracting([.hello, .shutdown])
        )
        XCTAssertFalse(EngineMethod.capabilityWireNames.contains("hello"))
        XCTAssertFalse(EngineMethod.capabilityWireNames.contains("shutdown"))
        XCTAssertTrue(EngineMethod.capabilityWireNames.contains("diagnose"))
    }

    // MARK: - 5. probe.sock 的符号链接必须在 bind 之前就被拒

    /// `bind()` 跟着叶子符号链接落到目标：engine.sock 每次 bind 前都问这一句，这个监听者
    /// 从前只在 EADDRINUSE 之后问，于是"能绑成功"的那一种恰恰没人看。
    /// REVERSE：删掉 `ProbeSocketServer.bindListener` 开头的 nameIsClearableSocketName guard → 红。
    func testProbeListenerRefusesASymlinkedNameBeforeBindingIt() throws {
        let dir = try makeScratch("probe-symlink")
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir)
        let target = dir + "/real-target-sock"
        let link = dir + "/probe.sock"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: target)
        let server = ProbeSocketServer(socketPath: link, inbox: ProbeInbox(), log: EngineLog(quiet: true))
        do {
            try server.start()
            XCTFail("符号链接名字上的 probe 监听者绑成功了——它其实落在 \(target)")
            server.stop()
        } catch {
            XCTAssertTrue(
                "\(error)".lowercased().contains("socket") || "\(error)".contains("occupied"),
                "拒绝要指名这个名字不是本进程拥有的 socket：\(error)"
            )
        }
        var info = stat()
        XCTAssertFalse(
            stat(target, &info) == 0 && info.st_mode & S_IFMT == S_IFSOCK,
            "目标被 bind() 变成了 socket：状态根之外的名字上多了一个注入口"
        )
    }

    // MARK: - 9. 面板不许起一个 socket 回话指定的二进制

    /// `binaryPath` 来自 hello 帧，而 engine.sock 没有 peer 鉴权。形状规则拦不住
    /// `/tmp/x/payload`，所以提交前必须问三件实测的事：普通文件、本 uid 拥有、父目录不对
    /// 全体写开放。
    /// REVERSE：把 `isSubmittableExecutable` 改成 `return isSubmittablePath(path)` → 中间
    /// 三条（目录、符号链接、/tmp 里那份）全红。
    func testSubmittableExecutableRejectsWhatAFrameCouldClaim() throws {
        let dir = try makeScratch("submit")
        let real = dir + "/glasspaned"
        try Data("#!/bin/sh\n".utf8).write(to: URL(fileURLWithPath: real))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: real)
        XCTAssertTrue(PermissionReprobe.isSubmittableExecutable(real), "合法安装的那份必须过")

        XCTAssertFalse(PermissionReprobe.isSubmittableExecutable(dir), "目录不是可执行文件")
        XCTAssertFalse(PermissionReprobe.isSubmittableExecutable(dir + "/does-not-exist"), "不存在的路径不答")

        let link = dir + "/glasspaned-link"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: real)
        XCTAssertFalse(PermissionReprobe.isSubmittableExecutable(link), "符号链接的名字不是这个账号拥有的那份文件")

        // 直接落在 /tmp 上：属主是我，但父目录是 root 拥有的 1777——共享暂存目录正是这种
        // 投放的默认落点。
        let dropped = "/tmp/gp-submit-probe-\(UUID().uuidString)"
        try Data("#!/bin/sh\n".utf8).write(to: URL(fileURLWithPath: dropped))
        addTeardownBlock { try? FileManager.default.removeItem(atPath: dropped) }
        XCTAssertFalse(PermissionReprobe.isSubmittableExecutable(dropped),
                       "全体可写目录里的文件不算本机拥有的后台服务")
    }

    /// 判据必须在**读者**那一侧被执行：库里有这么个函数而没人调用，等于没有护栏。
    /// REVERSE：删掉 `SettingsModel` 里那三道 guard 之一 → 红。
    func testPanelGuardsEverySubmitSite() throws {
        let model = try source("glasspane-settings/SettingsModel.swift")
        XCTAssertEqual(
            model.components(separatedBy: "PermissionReprobe.isSubmittableExecutable(").count - 1, 3,
            "面板往 launchd 提交自报路径的地方有三处，护栏也必须有三处"
        )
    }

    // MARK: - 6. 注册表落盘时目录本身也得是 0700

    /// `createDirectory(withIntermediateDirectories:)` 只给**这次**创建的层设属性，一个
    /// 早先被维护子命令建成 0755 的状态根会一直把 projects.json 的名字、大小、mtime
    /// 摊给所有本地账号——而文档里的不变量是 0700。
    /// REVERSE：把 `save` 里那句 chmod 与复核删掉（只留 createDirectory 的 attributes）→ 红。
    func testRegistryWriteTightensAnExistingLooseStateRoot() throws {
        let dir = try makeScratch("loose-root")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir)
        let registry = ProjectRegistry(filePath: dir + "/projects.json")
        _ = try registry.create(displayName: "tighten me", bundleId: "com.example.tighten")
        var info = stat()
        XCTAssertEqual(stat(dir, &info), 0)
        XCTAssertEqual(
            Int(info.st_mode & 0o777), 0o700,
            "写完之后目录还是 \(String(format: "%04o", Int(info.st_mode & 0o777)))，等于每个本地账号都能列出这张表"
        )
    }

    private static func run(_ args: [String]) -> (status: Int32, out: String, err: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: args[0])
        process.arguments = Array(args.dropFirst())
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

    private static func functionBody(_ text: String, startsAt marker: String, stopsBefore stop: String) -> String {
        guard let start = text.range(of: marker) else { return "" }
        let tail = text[start.lowerBound...]
        if let end = tail.range(of: stop) {
            return String(tail[..<end.lowerBound])
        }
        return String(tail)
    }
}
