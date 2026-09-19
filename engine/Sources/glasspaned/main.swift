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
        case "--no-c33":
            options.c33Enabled = false
        case "--force-socket":
            options.forceSocket = true
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
        --no-c33             Disable C33 input monitoring (degrade to pure
                                 operation-right mutex; act never blocks on user input)
        --force-socket       Take over the socket even when a live daemon is
                                 already serving it (default: refuse and exit 65)
        --list-projects        List all registered projects (JSON) and exit
        --active-project <id>  Set the active project ID and exit
        --recipe-validate <path>  Validate a recipe YAML file and exit
        --approval-audit        Dump the approval ledger (JSON array) and exit
        --approval-verify       Verify the approval hash chain and exit
        --prune-evidence        Prune expired evidence entries and exit
        --older-than <days>     Expiry threshold in days (default: 30; --prune-evidence only)
        --project <id>          Scope maintenance to a project's evidence directory
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

private func writeJSON(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        return
    }
    FileHandle.standardOutput.write(Data((text + "\n").utf8))
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
    print("Enable the entry for the terminal running glasspaned, then switch back here.")
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

private func installSignalHandlers(_ server: SocketServer) {
    // Writes to a socket whose peer has closed raise SIGPIPE by default and
    // would kill the daemon. Ignore it so write() returns EPIPE and the
    // connection is torn down cleanly (seen on real devices when a client
    // disconnects mid-operation).
    _ = signal(SIGPIPE, SIG_IGN)
    for signalNumber in [SIGINT, SIGTERM] {
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            server.cleanup()
            exit(0)
        }
        source.resume()
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
    if let entry = registry.get(activeId) {
        FileHandle.standardOutput.write(
            Data("active project: \(entry.projectId) (\(entry.displayName))\n".utf8)
        )
    } else {
        FileHandle.standardError.write(
            Data("error: unknown project \(activeId)\n".utf8)
        )
        exit(1)
    }
    exit(0)
}

if let recipePath = options.recipeValidate {
    let fm = FileManager.default
    guard fm.fileExists(atPath: recipePath) else {
        FileHandle.standardError.write(
            Data("{\"valid\":false,\"errors\":[\"file not found: \(recipePath)\"]}\n".utf8)
        )
        exit(2)
    }
    guard let data = fm.contents(atPath: recipePath) else {
        FileHandle.standardError.write(
            Data("{\"valid\":false,\"errors\":[\"cannot read: \(recipePath)\"]}\n".utf8)
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
        if let data = try? JSONSerialization.data(
            withJSONObject: payload, options: [.sortedKeys]
        ) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
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
    let dir: String
    if let projectId = options.maintenanceProjectId {
        let registry = ProjectRegistry()
        guard let entry = registry.get(projectId) else {
            FileHandle.standardError.write(
                Data("{\"error\": \"unknown project \(projectId)\"}\n".utf8)
            )
            exit(1)
        }
        dir = entry.evidenceStoragePath ?? EvidenceStore.defaultDirectory
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
        if let data = try? JSONSerialization.data(
            withJSONObject: payload, options: [.sortedKeys]
        ) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
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
        if let data = try? JSONSerialization.data(
            withJSONObject: payload, options: [.sortedKeys]
        ) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
        exit(0)
    }
}

let socketPath = options.socketPath ?? defaultSocketPath()
let log = EngineLog(quiet: !options.verbose)

// 单实例护栏（P1 v1.2 §11.1）：socket 已由活着的 daemon 在服务时拒绝启动。
// 绑定的 unlink+bind 语义会抢占文件，留下一个"没人连得到"的孤儿实例——而
// TCC 授权条目按进程身份记账，多实例并存时用户在系统设置里看到的条目与真正
// 服务请求的实例可能对不上，这正是本次修的坑。`--force-socket` 显式抢占，
// `--socket-path` 起并行实例（不同 socket 即不同主体）。
if !options.forceSocket {
    if let incumbent = DaemonProbe().helloSummary(socketPath: socketPath) {
        let message = """
        glasspaned: a daemon is already serving \(socketPath) (pid \(incumbent.pid), version \(incumbent.version)).
          - attach to it instead of starting a second instance, or
          - use --socket-path <other> for a parallel instance, or
          - use --force-socket to take over this socket (the old instance keeps running but loses the socket).
        """
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(65)
    }
}
let channel = AXChannel()
// T9 progressive degradation is on by default: it needs no TCC permission
// (proc_pidinfo is same-user process inspection). C33 is injected by default
// since 2026-09-19 (P4 §36): the CGEvent tap creation itself is the honest
// permission probe — denied TCC means tapCreate fails and we degrade to the
// pure operation-right mutex form documented in P2 spec v2.0 §17.2.
// --no-c33 opts out explicitly (act never waits on user input).
var attributionGuard: AttributionGuard?
if options.c33Enabled {
    let inputMonitor = CGEventInputMonitor()
    if inputMonitor.startOnBackgroundRunLoop() {
        attributionGuard = AttributionGuard(inputSource: inputMonitor)
        log.info("C33 active: CGEvent input tap installed (AttributionGuard injected)")
    } else {
        log.info("C33 degraded: input tap unavailable (Input Monitoring TCC not granted?) — contamination undecidable, operation-right mutex only")
    }
} else {
    log.info("C33 disabled via --no-c33 (pure no-guard form)")
}
let core = EngineCore(
    channel: channel,
    evidenceStore: EvidenceStore(),
    attributionGuard: attributionGuard,
    degradationTracker: DegradationTracker(),
    metricsProbe: ProcessMetricsProbe(),
    approvalGate: ApprovalGate(path: ApprovalGate.defaultPath),
    permissionsReport: { permissionProbes.snapshot() }
)
let dispatcher = Dispatcher(core: core, log: log)
let server = SocketServer(socketPath: socketPath, dispatcher: dispatcher, log: log)
installSignalHandlers(server)

FileHandle.standardOutput.write(
    Data("glasspaned \(core.version) listening on \(socketPath)\n".utf8)
)

do {
    try server.run()
    exit(0)
} catch {
    log.error("fatal: \(error)")
    server.cleanup()
    exit(1)
}
