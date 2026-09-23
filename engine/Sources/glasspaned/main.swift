import Foundation
import ApplicationServices
import GlassPaneEngine

/// glasspaned — the P0 engine daemon. Serves the v0 local-socket protocol
/// (P0 spec §3) on a Unix domain socket with 0600 permissions.
///
/// Usage:
///   glasspaned [--socket-path <path>] [--verbose]
///   glasspaned --grant-accessibility
///   glasspaned --check-screen-permission
///   glasspaned --guide-screen-permission
///   glasspaned --permissions
///   glasspaned --request-permission <kind>
///   glasspaned --help

private struct Options {
    var socketPath: String?
    var verbose = false
    var grantAccessibility = false
    var checkScreenPermission = false
    var guideScreenPermission = false
    var checkInputPermission = false
    var checkAccessibility = false
    var permissionsJSON = false
    var requestPermission: PermissionKind?
    var forceSocket = false
    var forceProbeSocket = false
    var listProjects = false
    var activeProjectId: String?
    var recipeValidate: String?
    var approvalAudit = false
    var approvalVerify = false
    var pruneEvidence = false
    var pruneOlderThanDays = 30
    var maintenanceProjectId: String?
    var pruneDryRun = false
    var evidenceStats = false
    var c33Enabled = true
    var checkDeveloperTools = false
    var probeSocketPath: String?
    var probeEnabled = true
}

private enum ParseResult {
    case parsed(Options)
    case help
    case error(String)
    case errorCode(String, Int32)
}

private func parseArguments(_ arguments: [String]) -> ParseResult {
    var options = Options()
    var index = 1
    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "--help", "-h":
            return .help
        case "--verbose", "-v":
            options.verbose = true
        case "--grant-accessibility":
            options.grantAccessibility = true
        case "--check-screen-permission":
            options.checkScreenPermission = true
        case "--guide-screen-permission":
            options.guideScreenPermission = true
        case "--check-input-permission":
            options.checkInputPermission = true
        case "--check-accessibility":
            options.checkAccessibility = true
        case "--permissions":
            options.permissionsJSON = true
        case "--request-permission":
            guard index + 1 < arguments.count else {
                return .errorCode("--request-permission requires one of: accessibility | input-monitoring | screen-recording | developer-tools", 64)
            }
            index += 1
            guard let kind = PermissionKind.from(cliValue: arguments[index]) else {
                return .errorCode("--request-permission unknown kind: \(arguments[index])", 64)
            }
            options.requestPermission = kind
        case "--check-developer-tools":
            options.checkDeveloperTools = true
        case "--no-c33":
            options.c33Enabled = false
        case "--no-probe":
            options.probeEnabled = false
        case "--probe-socket-path":
            guard index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") else {
                return .error("--probe-socket-path requires a file path")
            }
            index += 1
            options.probeSocketPath = arguments[index]
        case "--force-socket":
            options.forceSocket = true
        case "--force-probe-socket":
            options.forceProbeSocket = true
        case "--list-projects":
            options.listProjects = true
        case "--active-project":
            guard index + 1 < arguments.count else {
                return .error("--active-project requires a project ID")
            }
            index += 1
            options.activeProjectId = arguments[index]
        case "--recipe-validate":
            guard index + 1 < arguments.count else {
                return .error("--recipe-validate requires a file path")
            }
            index += 1
            options.recipeValidate = arguments[index]
        case "--approval-audit":
            options.approvalAudit = true
        case "--approval-verify":
            options.approvalVerify = true
        case "--prune-evidence":
            options.pruneEvidence = true
        case "--evidence-stats":
            options.evidenceStats = true
        case "--older-than":
            guard index + 1 < arguments.count else {
                return .errorCode("--older-than requires a day count", 2)
            }
            index += 1
            guard let days = Int(arguments[index]), days >= 1 else {
                return .errorCode("--older-than requires a positive integer (days), got: \(arguments[index])", 2)
            }
            options.pruneOlderThanDays = days
        case "--project":
            guard index + 1 < arguments.count else {
                return .error("--project requires a project ID")
            }
            index += 1
            options.maintenanceProjectId = arguments[index]
        case "--dry-run":
            options.pruneDryRun = true
        case "--socket-path":
            guard index + 1 < arguments.count else {
                return .error("--socket-path requires a value")
            }
            index += 1
            options.socketPath = arguments[index]
        default:
            if argument.hasPrefix("--socket-path=") {
                let value = String(argument.dropFirst("--socket-path=".count))
                guard !value.isEmpty else {
                    return .error("--socket-path requires a value")
                }
                options.socketPath = value
            } else {
                return .error("unknown argument: \(argument)")
            }
        }
        index += 1
    }
    return .parsed(options)
}

private func printUsage() {
    let usage = """
    glasspaned — GlassPane P0 engine daemon

    USAGE:
        glasspaned [--socket-path <path>] [--verbose]
        glasspaned --grant-accessibility
        glasspaned --check-screen-permission
        glasspaned --guide-screen-permission
        glasspaned --check-input-permission
        glasspaned --check-accessibility
        glasspaned --permissions
        glasspaned --request-permission <kind>
        glasspaned --list-projects
        glasspaned --active-project <project-id>
        glasspaned --recipe-validate <path>
        glasspaned --approval-audit
        glasspaned --approval-verify
        glasspaned --prune-evidence [--older-than <days>] [--project <id>] [--dry-run]
        glasspaned --evidence-stats [--project <id>]

    OPTIONS:
        --socket-path <path>   Unix socket path (default: ~/.glasspane/engine.sock)
        --verbose             Log frames and state transitions to stderr
        --grant-accessibility  Onboarding: prompt for accessibility permission
        --check-screen-permission   Print screen recording permission state
                                 (granted | denied | notDetermined) and exit
        --guide-screen-permission   Prompt for screen recording permission
                                 (no-op when already granted) and exit
        --check-input-permission    Print input monitoring permission state
                                 (granted | denied | notDetermined) and exit
        --check-accessibility      Print this process's accessibility seat
                                 (granted | notDetermined — AX exposes no
                                 denied visibility) and exit
        --permissions              Print the daemon's own permission snapshot
                                 as JSON: {"subject":…,"permissions":…} and exit
        --request-permission <kind>  Ask for <kind> TCC access **as this very
                                 process** (no pane navigation, no waiting) and
                                 print the resulting JSON. Kinds: accessibility |
                                 input-monitoring | screen-recording | developer-tools.
                                 The Settings panel invokes this through
                                 `launchctl submit` so the grant lands on the
                                 daemon's own identity instead of its launcher's.
        --check-developer-tools     Probe debugger capability (launch/attach
                                 three-state JSON, P6 §7); exit 0 = granted.
                                 The only human step is the System Settings
                                 checkbox; verification is machine-owned.
        --no-c33             Disable C33 input monitoring (degrade to pure
                                 operation-right mutex; act never blocks on user input)
        --no-probe           Disable the P6 probe socket (Z5 black-box only;
                                 handlerProbe/stateDiff signals stay null)
        --probe-socket-path <path>  Probe listener path (default ~/.glasspane/probe.sock)
        --force-socket       Take over the engine socket even when a live daemon
                                 is already serving it (default: refuse and exit 65)
        --force-probe-socket Take over probe.sock even when another listener owns
                                 it (default: start without a probe listener and
                                 keep the Z5 black-box form; the probe listener
                                 never answers hello, so "a connection can be
                                 established" is how its owner is detected)
        --list-projects        List all registered projects (JSON) and exit
        --active-project <id>  Report whether <id> is a registered project (JSON)
                                 and exit. **This command changes nothing**: the
                                 registry has no active-project field and no
                                 protocol method accepts one, so the payload says
                                 stateChanged=false. To make a project active,
                                 call gp_attach with its projectId.
        --recipe-validate <path>  Validate a recipe YAML file and exit
        --approval-audit        Dump the approval ledger (JSON array) and exit
        --approval-verify       Verify the approval hash chain and exit
        --prune-evidence        Prune expired evidence entries and exit
        --older-than <days>     Expiry threshold in days (default: 30; --prune-evidence only)
        --project <id>          Scope maintenance to a project's evidence directory
                                 (a directory the daemon would refuse to archive
                                 into is refused here too: exit 1, stateChanged=false)
        --dry-run               Report what pruning would remove without deleting
        --evidence-stats        Print evidence archive stats (JSON) and exit
        --help, -h            Show this help

    PROTOCOL:
        Newline-delimited JSON over the socket; see specs/GlassPane_P0_实施规格_v1.0.md §3.

    """
    FileHandle.standardOutput.write(Data(usage.utf8))
}

private func defaultSocketPath() -> String {
    NSHomeDirectory() + "/.glasspane/engine.sock"
}

// MARK: - Permission subject surface (P1 spec v1.2 §11.2)

/// 本进程的权限探针集合：daemon 是四类 TCC 席位的**唯一合法主体**，因此
/// 席位由这里求值，并随 `hello` 自报给设置面板（面板不得代测）。
private let permissionProbes = PermissionProbeSet()

/// 权限快照的对外 JSON 形态（CLI `--permissions` / `--request-permission` 共用）。
private func permissionSnapshotJSON(_ snapshot: DaemonPermissionSnapshot) -> [String: Any] {
    let subject = snapshot.subject.wireValue.merging(
        ["entryName": snapshot.subject.tccEntryName],
        uniquingKeysWith: { _, new in new }
    )
    return ["subject": subject, "permissions": snapshot.permissionsWire]
}

/// CLI 的机器可读出口：任何一行都经过 JSON 转义（R5-03）。历史上这几处是字符串
/// 插值拼 JSON / 直接原文打印，把 agent 自撰的 `displayName` 与路径原样送上终端
/// （OSC-52 复制序列、ANSI 光标移动都可执行）。转义口径与 `--list-projects` 的
/// JSONEncoder 一致：<0x20 控制字符、引号、反斜杠一律转义，斜杠不转义。
private func writeJSON(_ object: [String: Any], to handle: FileHandle = .standardOutput) {
    guard let line = AgentText.jsonLine(object) else { return }
    handle.write(Data(line.utf8))
}

// MARK: - Onboarding (R36: permission guidance)

private func runGrantAccessibilityFlow() {
    if AXIsProcessTrusted() {
        print("accessibility permission already granted — the daemon is ready to attach.")
        return
    }
    // Show the system prompt anchored to this process, and open the pane.
    let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let promptOptions = [promptKey: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(promptOptions)
    openPrivacyPane()
    print("Waiting for accessibility permission (System Settings > Privacy & Security > Accessibility)...")
    // §11.4 教训写进文案：勾"终端"= 借来的席位，launchd/开机形态会失效。
    // 本命令在 daemon 自身上下文运行，列表里那条 glasspaned 才是正主。
    let selfPath = Bundle.main.executablePath ?? CommandLine.arguments[0]
    print("Enable the entry for the **daemon binary itself** — \(selfPath)")
    print("(do NOT enable the terminal instead: that seat is borrowed from the launcher and breaks under launchd — P1 v1.2 §11.4;")
    print(" if the entry is absent, run: glasspaned --request-permission accessibility, which lands the grant on the daemon identity)")
    let pollIntervalSeconds: UInt32 = 1
    let timeoutSeconds = 300
    var waited = 0
    while waited < timeoutSeconds {
        if AXIsProcessTrusted() {
            print("Accessibility permission granted — the daemon is ready to attach.")
            return
        }
        sleep(pollIntervalSeconds)
        waited += Int(pollIntervalSeconds)
    }
    print("Timed out after \(timeoutSeconds)s waiting for accessibility permission.")
    print("Re-run: glasspaned --grant-accessibility  (the daemon requires this permission to observe and drive apps.)")
    exit(1)
}

private func openPrivacyPane() {
    let paneURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = [paneURL]
    do {
        try process.run()
    } catch {
        // Opening the pane is best-effort; the system prompt above is the
        // primary path.
    }
}

// MARK: - Onboarding (P1 §3: screen recording permission)

private func openScreenRecordingPane() {
    let paneURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = [paneURL]
    do {
        try process.run()
    } catch {
        // Best-effort; the system authorization dialog is the primary path.
    }
}

private func runCheckScreenPermission(_ probe: ScreenCapturePermissionProbe) {
    print(probe.state.rawValue)
}

private func runGuideScreenPermission(_ probe: ScreenCapturePermissionProbe) {
    switch probe.state {
    case .granted:
        print("screen recording permission already granted — no action needed.")
    case .notDetermined:
        print("Screen recording permission has not been granted yet. A system authorization dialog is being requested now.")
        let outcome = probe.guideAccess()
        openScreenRecordingPane()
        if outcome == .granted {
            print("Screen recording permission granted.")
        } else {
            print("Permission still denied after the request. Enable the entry for this app under System Settings > Privacy & Security > Screen Recording, then re-run: glasspaned --check-screen-permission")
        }
    case .denied:
        print("Screen recording permission is denied. Open System Settings > Privacy & Security > Screen Recording and enable the entry for this app, then re-run: glasspaned --check-screen-permission")
        openScreenRecordingPane()
    }
}

// MARK: - Signals

/// SIGINT/SIGTERM 的等待集。在主线程、任何 daemon 线程创建**之前**用它做一次
/// pthread_sigmask(SIG_BLOCK)（见入口处的遮罩点），此后所有线程（CGEvent 后台
/// runloop、probe accept、per-client、GCD worker）都继承屏蔽，信号在进程内只会
/// 以 pending 形式存在——唯一的消费点就是 sigwait 线程，送达是确定性的；
/// waiter 启动前到达的信号同样不丢。注意：不能对这些信号设 SIG_IGN，忽略的
/// disposition 不进 pending 队列，sigwait 将永远收不到。
var shutdownSignalSet: sigset_t = {
    var set = sigset_t()
    sigemptyset(&set)
    sigaddset(&set, SIGINT)
    sigaddset(&set, SIGTERM)
    return set
}()

private func blockShutdownSignalsEarly() {
    // Writes to a socket whose peer has closed raise SIGPIPE by default and
    // would kill the daemon. Ignore it so write() returns EPIPE and the
    // connection is torn down cleanly (seen on real devices when a client
    // disconnects mid-operation).
    _ = signal(SIGPIPE, SIG_IGN)
    pthread_sigmask(SIG_BLOCK, &shutdownSignalSet, nil)
}

/// SIGTERM/SIGINT 收尾（P6 §11 项⑥ + §11.1 归因修正）。DispatchSource 形态的
/// 三个真机坑：(1) 信号源不作显式持有，安装完即被 ARC 释放、handler 永不触发
/// ——此前本机"换专用队列仍哑火"的最小复现正是栽在这一条上，"任意队列都失效"
/// 的归因不成立，特此更正；(2) 挂 `.main` 队列时 accept() 阻塞主线程、主队列
/// 永不泵；(3) 收尾若调 `server.cleanup()`，它会 close 正被 accept() 使用的
/// fd——跨线程 close 有 fd 复用竞态。sigwait 形态三条全免疫：遮罩继承送达确
/// 定、收尾跑在普通线程上下文；这里只 unlink socket 文件、不关在用的 fd，
/// 与正常退出留下的现场一致。运维不再需要 kill -9。
private func startShutdownWaiter(socketPaths: [String]) {
    Thread.detachNewThread {
        var signalNumber: Int32 = 0
        while true {
            let code = sigwait(&shutdownSignalSet, &signalNumber)
            guard code == 0 else { continue }
            for path in socketPaths { unlink(path) }
            exit(0)
        }
    }
}

// MARK: - Entry

private let parseResult = parseArguments(CommandLine.arguments)
private let options: Options
switch parseResult {
case .help:
    printUsage()
    exit(0)
case .error(let message):
        FileHandle.standardError.write(Data("glasspaned: \(message)\n".utf8))
        printUsage()
        exit(64)
case .errorCode(let message, let code):
        FileHandle.standardError.write(Data("glasspaned: \(message)\n".utf8))
        exit(code)
case .parsed(let parsed):
    options = parsed
}

if options.grantAccessibility {
    runGrantAccessibilityFlow()
    exit(0)
}

if options.checkScreenPermission || options.guideScreenPermission {
    // P1 §3: 屏幕录制权限探针复用单例，保证两命令在同一进程内状态一致。
    let probe = ScreenCapturePermissionProbe()
    if options.checkScreenPermission {
        runCheckScreenPermission(probe)
    }
    if options.guideScreenPermission {
        runGuideScreenPermission(probe)
    }
    exit(0)
}

if options.checkDeveloperTools {
    // P6 §7 修订：开发者工具/调试能力的三态**受限真探测**——用户唯一的动作是
    // 勾选系统面板，检测/复验/机器消费全部由此命令承担。
    let probe = DebugCapabilityProbe()
    let payload = probe.jsonPayload()
    writeJSON(payload)
    exit((payload["granted"] as? Bool) == true ? 0 : 1)
}
if options.checkInputPermission {
    // P2 §17.2 真机冒烟前置：C33 输入监控 TCC 状态对外如实输出
    // （granted | denied | notDetermined），供冒烟脚本判断可否观察输入流。
    let probe = InputMonitoringPermissionProbe()
    print(probe.state.rawValue)
    exit(0)
}

if options.checkAccessibility {
    // AX 只有布尔可见性（无 denied 查询接口），如实输出两态。
    print(permissionProbes.accessibility.displayStatus().rawValue)
    exit(0)
}

if options.permissionsJSON {
    writeJSON(permissionSnapshotJSON(permissionProbes.snapshot()))
    exit(0)
}

if let kind = options.requestPermission {
    // 以**本进程身份**申请：调用方（设置面板）经 launchctl submit 起一次性
    // 任务，避免面板成为责任父进程、把席位记到面板 app 头上（P1 v1.2 §11.2）。
    let status = permissionProbes.request(kind)
    let snapshot = permissionProbes.snapshot()
    var payload = permissionSnapshotJSON(snapshot)
    payload["requested"] = kind.cliValue
    payload["requestedStatus"] = status.rawValue
    writeJSON(payload)
    exit(0)
}

// MARK: - P1 project management commands (spec v1.4 §3)

if options.listProjects {
    let registry = ProjectRegistry()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    if let data = try? encoder.encode(registry.all) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } else {
        FileHandle.standardOutput.write(Data("[]\n".utf8))
    }
    exit(0)
}

if let activeId = options.activeProjectId {
    let registry = ProjectRegistry()
    // R2-16 / R6-06：这条命令从来没有写过任何状态——ProjectRegistry 没有 active
    // 字段，冻结的协议方法表里也没有"设置活跃项目"的方法。旧输出把 projectId 与
    // displayName 原文拼成一行确认 + 退出码 0，读起来像一次成功的状态变更（P6 §11
    // 专门审过的幻影控制形状），所以这里如实输出**核验报告**并显式
    // stateChanged=false；displayName 是 agent 自撰内容，只能经 JSON 转义出口离开
    // 进程（R5-03）。
    guard let entry = registry.get(activeId) else {
        writeJSON([
            "command": "--active-project",
            "found": false,
            "stateChanged": false,
            "projectId": activeId,
            "registryPath": registry.filePath,
            "error": "no project \(activeId) is registered",
            "next": "glasspaned --list-projects"
        ], to: .standardError)
        exit(1)
    }
    writeJSON([
        "command": "--active-project",
        "found": true,
        "stateChanged": false,
        "projectId": entry.projectId,
        "displayName": entry.displayName,
        "bundleId": entry.bundleId ?? NSNull(),
        "evidenceStoragePath": entry.evidenceStoragePath ?? NSNull(),
        "registryPath": registry.filePath,
        "note": "this command only verified that the projectId is registered; glasspaned keeps no active-project state, so nothing was selected or written. To archive subsequent operations under this project, call attach/gp_attach with projectId=\(entry.projectId)."
    ])
    exit(0)
}

if let recipePath = options.recipeValidate {
    let fm = FileManager.default
    guard fm.fileExists(atPath: recipePath) else {
        // 手拼 JSON 的旧形状会把未转义的路径直接吐出去，口径改走同一转义出口
        // （R5-03）；{"valid":…,"errors":[…]} 的对外形状与退出码不变。
        writeJSON(
            ["valid": false, "errors": ["file not found: \(recipePath)"], "path": recipePath],
            to: .standardError
        )
        exit(2)
    }
    guard let data = fm.contents(atPath: recipePath) else {
        writeJSON(
            ["valid": false, "errors": ["cannot read: \(recipePath)"], "path": recipePath],
            to: .standardError
        )
        exit(2)
    }
    let result = RecipeLoader.validate(data)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let resultData = try? encoder.encode(result) {
        FileHandle.standardOutput.write(resultData)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
    exit(result.valid ? 0 : 1)
}

// MARK: - P5 approval-ledger maintenance (spec v5.0 §3.6)

if options.approvalAudit || options.approvalVerify {
    let gate = ApprovalGate(path: ApprovalGate.defaultPath)
    if options.approvalVerify {
        let verdict = gate.verifyChain()
        let payload: [String: Any] = [
            "valid": verdict.valid,
            "count": gate.count,
            "firstBrokenIndex": verdict.firstBrokenIndex.map { $0 as Any } ?? NSNull(),
            "loadFailed": gate.loadFailed
        ]
        writeJSON(payload)
        let ok = verdict.valid && !gate.loadFailed
        if !ok && gate.loadFailed {
            FileHandle.standardError.write(
                Data("warning: ledger file exists but is corrupt; verify cannot pass\n".utf8)
            )
        }
        exit(ok ? 0 : 1)
    }
    if options.approvalAudit {
        if gate.loadFailed {
            FileHandle.standardError.write(
                Data("error: approval ledger exists but is corrupt — audit unavailable\n".utf8)
            )
            exit(1)
        }
        if let data = gate.auditJSON() {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
        exit(0)
    }
}

// MARK: - P5 evidence maintenance CLI (spec v5.0 §12)

if options.pruneEvidence || options.evidenceStats {
    // 目录解析与批三 pruneEvidence 同口径：项目维度查 registry →
    // evidenceStoragePath → 默认目录；无项目维度 → 默认证据目录。
    //
    // A-07/C-06: the project dimension used to hand the stored
    // `evidenceStoragePath` straight to the store that deletes from it, while
    // `attach` had already started refusing that same stored value. Both
    // commands now go through `EngineCore.projectArchiveDirectory`, the one
    // resolver the engine uses: nothing is deleted or measured in a directory
    // the daemon would refuse to archive into, and a project that named no
    // directory of its own never gets the shared archive touched in its place.
    let dir: String
    if let projectId = options.maintenanceProjectId {
        let registry = ProjectRegistry()
        guard let entry = registry.get(projectId) else {
            writeJSON(
                [
                    "error": "unknown project \(projectId)",
                    "project": projectId,
                    "stateChanged": false,
                    "next": "glasspaned --list-projects"
                ],
                to: .standardError
            )
            exit(1)
        }
        switch EngineCore.projectArchiveDirectory(projectId: projectId, entry: entry) {
        case .failure(let refusal):
            writeJSON(
                [
                    "error": refusal.message,
                    "remedy": refusal.remedy,
                    "code": refusal.code.rawValue,
                    "project": projectId,
                    "registryPath": registry.filePath,
                    "stateChanged": false
                ],
                to: .standardError
            )
            exit(1)
        case .success(let stored):
            dir = stored
        }
    } else {
        dir = EvidenceStore.defaultDirectory
    }
    if options.pruneEvidence {
        let store = EvidenceStore(directory: dir)
        // --dry-run 与真实修剪共享同一判定路径（countExpired 与 prune 同源，
        // P5 §12.2 诚实口径：输出=真实会删除的数量，非估算）。
        let removed = options.pruneDryRun
            ? store.countExpired(olderThanDays: options.pruneOlderThanDays)
            : store.prune(olderThanDays: options.pruneOlderThanDays)
        let payload: [String: Any] = [
            "pruned": removed,
            "dryRun": options.pruneDryRun,
            "project": options.maintenanceProjectId ?? NSNull(),
            "dir": dir
        ]
        writeJSON(payload)
        exit(0)
    }
    if options.evidenceStats {
        let stats = EvidenceStore(directory: dir).stats()
        let payload: [String: Any] = [
            "count": stats.count,
            "totalBytes": stats.totalBytes,
            "project": options.maintenanceProjectId ?? NSNull(),
            "dir": dir
        ]
        writeJSON(payload)
        exit(0)
    }
}

let socketPath = options.socketPath ?? defaultSocketPath()
let probeSocketPath = options.probeSocketPath
    ?? NSHomeDirectory() + "/.glasspane/probe.sock"
let log = EngineLog(quiet: !options.verbose)

// 单实例护栏（P1 v1.2 §11.1 + R2-02/A-18）：判定必须三态分开——「回了 hello」
// 「名字后面没有监听者（残留文件）」「有监听者但不开口」。旧实现用 helloSummary，
// 把后两种连同「3s 没回音」一起当成"没有 daemon"，随后无条件 unlink+bind，负载下
// 直接覆盖一个只是暂时没回话的活实例，留下没人连得上的孤儿；TCC 席位按进程身份
// 记账，用户在系统设置里看到的条目与真正服务请求的实例就可能对不上。
// `--force-socket` 才是显式抢占，`--socket-path` 起并行实例（不同 socket 即不同主体）。
//
// R5-07：护栏**必须在 `blockShutdownSignalsEarly()` 之前**跑完。旧顺序是先装遮罩再
// 护栏、而 sigwait 线程要到 `startShutdownWaiter` 才存在——那段窗口里 SIGTERM/SIGINT
// 被屏蔽却无人消费，配上无界的 DaemonProbe 读环就成了不可杀的启动。此刻信号还是
// 默认处置，Ctrl-C / kill 立刻生效；探测本身也已换成绝对时限 + 字节上限的有界会话。
let socketProbe = DaemonProbe()
let engineLiveness = socketProbe.liveness(socketPath: socketPath)
switch DaemonProbe.takeoverDecision(engineLiveness, force: options.forceSocket) {
case .refuse(let incumbent):
    let message = """
    glasspaned: \(socketPath) is already owned (\(incumbent)).
      - attach to that instance instead of starting a second one, or
      - use --socket-path <other> for a parallel instance, or
      - use --force-socket to take this name over (the old instance keeps running but loses the socket).
    """
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(65)
case .preempt(let incumbent):
    log.error("--force-socket: taking \(socketPath) over from \(incumbent); the previous instance keeps running but loses the socket")
case .bind:
    if case .noListener(let reason) = engineLiveness {
        log.info("nothing listens on \(socketPath) (\(reason)) — binding it")
    }
}

// A-18：engine.sock 有 §11.1 护栏，probe.sock 过去**一个都没有**——第二个 daemon
// 静默 unlink+bind 抢走探针名字，旧实例继续服务 engine.sock，归因面就此裂到两个进程
// 上（探针事件进 B、操作与证据记在 A）。探针监听者按协议永不回 hello，所以"连接能不
// 能建立"才是它的存活判据（waitForHello: false，不白等 3s）。默认行为不变：名字有主
// 就少开一个监听者并如实报降级，而不是抢；抢占要显式 --force-probe-socket。
// 判定必须在遮罩之前（同上），真正 start() 在遮罩之后——accept 线程要继承遮罩。
var probeListenerAllowed = options.probeEnabled
if options.probeEnabled {
    let probeLiveness = socketProbe.liveness(socketPath: probeSocketPath, waitForHello: false)
    switch DaemonProbe.takeoverDecision(probeLiveness, force: options.forceProbeSocket) {
    case .refuse(let incumbent):
        probeListenerAllowed = false
        // 不经 EngineLog（quiet 模式会被吞）：静默少一个监听者正是 A-18 要消灭的形状。
        FileHandle.standardError.write(Data(("""
        glasspaned: probe name \(probeSocketPath) is already owned (\(incumbent)).
          Starting WITHOUT a probe listener: Z5 black-box only, handlerProbe/stateDiff stay null.
          - use --force-probe-socket to take the name over, or
          - use --probe-socket-path <other> for this instance's own listener.
        """ + "\n").utf8))
    case .preempt(let incumbent):
        log.error("--force-probe-socket: taking \(probeSocketPath) over from \(incumbent); the previous listener keeps its engine.sock but loses the probe stream.")
    case .bind:
        break
    }
}
// 遮罩点必须早于本文件后续创建的任何线程（C33 runloop、probe accept、per-client、
// GCD worker）——线程继承创建者的信号遮罩，这是 sigwait 送达确定性的前提。
// 它也必须晚于上面两条护栏（见上），否则屏蔽期内无人消费信号 = 不可杀。
blockShutdownSignalsEarly()
let channel = AXChannel()
// T9 progressive degradation is on by default: it needs no TCC permission
// (proc_pidinfo is same-user process inspection). C33 is injected by default
// since 2026-09-19 (P4 §36): the CGEvent tap creation itself is the honest
// permission probe — denied TCC means tapCreate fails and we degrade to the
// pure operation-right mutex form documented in P2 spec v2.0 §17.2.
// --no-c33 opts out explicitly (act never waits on user input).
var attributionGuard: AttributionGuard?
// A-08: whichever branch leaves the guard out has to say why, because the
// engine records "contamination not measured" from that statement — an
// unexplained absence would go back to reading as a clean window.
var inputMonitorAbsenceReason: String?
if options.c33Enabled {
    let inputMonitor = CGEventInputMonitor()
    if inputMonitor.startOnBackgroundRunLoop() {
        attributionGuard = AttributionGuard(inputSource: inputMonitor)
        log.info("C33 active: CGEvent input tap installed (AttributionGuard injected)")
    } else {
        inputMonitorAbsenceReason = "the CGEvent input tap could not be created by this daemon (Input Monitoring TCC not granted?)"
        log.info("C33 degraded: input tap unavailable (Input Monitoring TCC not granted?) — contamination undecidable, operation-right mutex only")
    }
} else {
    inputMonitorAbsenceReason = "C33 was declined at startup by the --no-c33 flag"
    log.info("C33 disabled via --no-c33 (pure no-guard form)")
}
// P6 spec v6.0 §5: the probe listener is on by default and self-degrades —
// without probe.sock nothing connects, so every act keeps the Z5 black-box
// form (handlerProbe/stateDiff null). --no-probe skips the listener entirely.
var probeInbox: ProbeInbox?
var probeServer: ProbeSocketServer?
if options.probeEnabled, probeListenerAllowed {
    let inbox = ProbeInbox()
    let server = ProbeSocketServer(
        socketPath: probeSocketPath,
        inbox: inbox,
        log: log,
        preemptsExistingSocket: options.forceProbeSocket
    )
    do {
        try server.start()
        probeInbox = inbox
        probeServer = server
    } catch {
        // start() 自带同一套 bind→三态判定→只清无主名字的纪律（A-18），护栏到这里
        // 之间若被别的实例抢了名字，它会拒绝并如实抛 nameOccupied；其余是
        // bind/chmod/listen 一类 errno。降级口径不变：Z5 黑箱继续。
        // 与上面护栏同一诚实口径：不经 EngineLog（quiet 会把"少一个监听者"整个
        // 吞掉，而那正是 A-18 要消灭的形状）。
        log.error("probe socket unavailable (\(error)) — continuing Z5-only, signals stay null")
        FileHandle.standardError.write(Data(
            "glasspaned: probe socket unavailable (\(error)) — this instance stays Z5-only; handlerProbe/stateDiff stay null\n".utf8
        ))
    }
} else {
    log.info("probe listener disabled via --no-probe (Z5 black-box only)")
}
let core = EngineCore(
    channel: channel,
    // C-02/C-03: this process is the one that owns `~/.glasspane`, so it names
    // both locations out loud instead of letting an omitted argument decide.
    projectRegistry: ProjectRegistry(),
    evidenceStore: EvidenceStore.atProductionDefault(),
    attributionGuard: attributionGuard,
    degradationTracker: DegradationTracker(),
    metricsProbe: ProcessMetricsProbe(),
    approvalGate: ApprovalGate(path: ApprovalGate.defaultPath),
    probeInbox: probeInbox,
    permissionsReport: { permissionProbes.snapshot() },
    inputMonitorAbsenceReason: inputMonitorAbsenceReason
)
let dispatcher = Dispatcher(core: core, log: log)
let server = SocketServer(
    socketPath: socketPath,
    dispatcher: dispatcher,
    log: log,
    preemptsExistingSocket: options.forceSocket
)
// 遮罩已装、所有会创建线程的初始化都已完成，此刻起信号只会被这里消费。
startShutdownWaiter(socketPaths: [server.socketPath] + (probeServer.map { [$0.socketPath] } ?? []))

FileHandle.standardOutput.write(
    Data("glasspaned \(core.version) listening on \(socketPath)\n".utf8)
)

do {
    try server.run()
    probeServer?.stop()
    exit(0)
} catch {
    log.error("fatal: \(error)")
    probeServer?.stop()
    server.cleanup()
    exit(1)
}
