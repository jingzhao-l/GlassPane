import Foundation
import ApplicationServices
import GlassPaneEngine

/// glasspaned — the P0 engine daemon. Serves the v0 local-socket protocol
/// (P0 spec §3) on a Unix domain socket with 0600 permissions.
///
/// Every mutable location (evidence archive, projects.json, approvals.json,
/// probe socket) is derived from **one** state root: the directory named by
/// `--state-dir <path>`, or — when nothing was named — the per-user folder
/// under this process's home directory, which does **not** follow a `HOME`
/// override. A run that has to stay off the developer's own state names
/// `--state-dir`; every subcommand resolves the same root.
///
/// Usage:
///   glasspaned [--state-dir <path>] [--socket-path <path>] [--verbose|-v]
///   glasspaned --grant-accessibility
///   glasspaned --check-screen-permission
///   glasspaned --guide-screen-permission
///   glasspaned --permissions
///   glasspaned --request-permission <kind>
///   glasspaned [--state-dir <path>] --list-projects
///   glasspaned [--state-dir <path>] --project-prune [--dry-run]
///   glasspaned [--state-dir <path>] --project-remove <id> [--dry-run]
///   glasspaned [--state-dir <path>] --active-project <project-id>
///   glasspaned [--state-dir <path>] --approval-audit | --approval-verify
///   glasspaned [--state-dir <path>] --prune-evidence [--older-than <days>] [--project <id>] [--dry-run]
///   glasspaned [--state-dir <path>] --evidence-stats [--project <id>]
///   glasspaned --recipe-validate <path>
///   glasspaned [--no-probe] [--probe-socket-path <path>] [--no-c33]
///   glasspaned [--state-dir <path>] [--force-socket] [--force-probe-socket]
///   glasspaned --version
///   glasspaned -h
///
/// Every flag the parser accepts, exhaustively (what each one does is what
/// `--help` prints; this line exists because the block above is a synopsis and
/// a synopsis drifts — it used to omit `--version`, `--no-c33`, `--force-socket`,
/// `--recipe-validate` and `--check-input-permission`, which is how a maintainer
/// reading this file ended up with a flag list that was wrong three ways at
/// once. `DaemonVersionFlagTests.testParsedFlagsAndUsageTextListTheSameFlags`
/// now compares this line, the `case` labels of `parseArguments` and
/// `printUsage()` as three sets that have to be equal, short forms included):
///   --active-project, --approval-audit, --approval-verify, --check-accessibility,
///   --check-developer-tools, --check-input-permission, --check-screen-permission,
///   --dry-run, --evidence-stats, --force-probe-socket, --force-socket,
///   --grant-accessibility, --guide-screen-permission, -h, --help, --list-projects,
///   --no-c33, --no-probe, --older-than, --permissions, --probe-socket-path,
///   --project, --project-prune, --project-remove, --prune-evidence,
///   --recipe-validate, --request-permission, --socket-path, --state-dir,
///   --unattended-window, -v, --verbose, --version
///
/// The permission commands above read no state, so they take no state root;
/// every other line resolves exactly one, and `--state-dir` is how it is named.

private struct Options {
    var socketPath: String?
    /// The state root named by `--state-dir`. nil means **nothing was named**,
    /// which is different from naming the home folder: the daemon says so on
    /// stderr when it touches state, because "injected" and "fell back" are the
    /// two outcomes a smoke gate has to tell apart.
    var stateDir: StateRoot?
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
    /// P1 §12.3.1：注册表的两条写入命令。面板的"清理测试残留"与"删除这个项目"
    /// 只有这一条出口——它自己不写 `projects.json`，因为运行中的 daemon 内存里
    /// 持有一份表，面板直接覆写会被它下一次写盘静默冲掉。
    var projectPrune = false
    var projectRemoveId: String?
    var recipeValidate: String?
    var approvalAudit = false
    var approvalVerify = false
    var pruneEvidence = false
    /// `--version` — print the same literal `hello` reports, and exit. The updater
    /// pairs this reading with the bundle's `CFBundleShortVersionString`
    /// (`updater/lib/version.js`); until 1.10.0 the daemon never answered it, so
    /// that pairing had exactly one live leg and the tests were covering the other
    /// one with a shell stub that printed a version for *any* argument.
    var printVersion = false
    var pruneOlderThanDays = 30
    var maintenanceProjectId: String?
    var pruneDryRun = false
    var evidenceStats = false
    var c33Enabled = true
    /// R3-1: `--unattended-window` — the operator states that no human input
    /// reaches this machine while the daemon works. A declaration, never a
    /// measurement, and it cannot override one (see `EngineCore`).
    var unattendedWindowDeclared = false
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
        case "--version":
            options.printVersion = true
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
        case "--unattended-window":
            // No value: it states one thing about this process's environment and
            // takes no argument to take it wrong.
            options.unattendedWindowDeclared = true
        case "--no-probe":
            options.probeEnabled = false
        case "--probe-socket-path":
            // X-22's rule, now also for the named sockets: `SocketPathArgument`
            // forwards to `StateRootArgument`, so a value that is another flag
            // and a relative path are refused the same way for both socket flags
            // and for `--state-dir`. Decided here, at the parse, because a
            // relative value is not harmless: the listener chmods its own parent
            // directory to 0700, so `--socket-path ./s.sock` from ~/Documents
            // tightens ~/Documents and keeps it tightened even when the bind
            // later fails and this run exits (see `SocketPathArgument`).
            if let reason = SocketPathArgument.rejection(
                for: index + 1 < arguments.count ? arguments[index + 1] : nil
            ) {
                return .error("--probe-socket-path \(reason)")
            }
            index += 1
            options.probeSocketPath = arguments[index]
        case "--force-socket":
            options.forceSocket = true
        case "--force-probe-socket":
            options.forceProbeSocket = true
        case "--state-dir":
            // The value is consumed only when it is a value: refusal follows
            // `--probe-socket-path` (a token that is another flag is not a
            // path) and additionally demands an absolute path, because a
            // relative one would make the state root depend on the working
            // directory this process was started in. `.error` is the usage
            // route: message to stderr, usage printed, exit 64.
            switch StateRootArgument(raw: index + 1 < arguments.count ? arguments[index + 1] : nil) {
            case .named(let root):
                options.stateDir = root
                index += 1
            case .rejected(let reason):
                return .error("--state-dir \(reason)")
            }
        case "--list-projects":
            options.listProjects = true
        case "--active-project":
            guard index + 1 < arguments.count else {
                return .error("--active-project requires a project ID")
            }
            index += 1
            options.activeProjectId = arguments[index]
        case "--project-prune":
            options.projectPrune = true
        case "--project-remove":
            guard index + 1 < arguments.count else {
                return .errorCode("--project-remove requires a project ID", 2)
            }
            index += 1
            options.projectRemoveId = arguments[index]
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
            // Absolute-path rule at the parse (X-22 sibling, above) — nothing
            // above this line may touch a directory, and this one is reached
            // before `prepareSocketDirectory` could chmod it.
            if let reason = SocketPathArgument.rejection(
                for: index + 1 < arguments.count ? arguments[index + 1] : nil
            ) {
                return .error("--socket-path \(reason)")
            }
            index += 1
            options.socketPath = arguments[index]
        default:
            if argument.hasPrefix("--socket-path=") {
                let value = String(argument.dropFirst("--socket-path=".count))
                // Same `--key=value` shape as `--state-dir`, same validation:
                // one rule set decides both spellings, so the two cannot
                // disagree about what counts as a socket path.
                if let reason = SocketPathArgument.rejection(for: value) {
                    return .error("--socket-path \(reason)")
                }
                options.socketPath = value
            } else if argument.hasPrefix("--state-dir=") {
                // Same `--key=value` shape as --socket-path, same validation:
                // one `StateRootArgument` rule set decides both forms, so the
                // two spellings cannot disagree about what is a root.
                let value = String(argument.dropFirst("--state-dir=".count))
                switch StateRootArgument(raw: value) {
                case .named(let root):
                    options.stateDir = root
                case .rejected(let reason):
                    return .error("--state-dir \(reason)")
                }
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
        glasspaned [--state-dir <path>] [--socket-path <path>] [--verbose|-v]
        glasspaned --grant-accessibility
        glasspaned --check-screen-permission
        glasspaned --guide-screen-permission
        glasspaned --check-input-permission
        glasspaned --check-accessibility
        glasspaned --permissions
        glasspaned --version
        glasspaned --request-permission <kind>
        glasspaned [--state-dir <path>] --list-projects
        glasspaned [--state-dir <path>] --project-prune [--dry-run]
        glasspaned [--state-dir <path>] --project-remove <project-id> [--dry-run]
        glasspaned [--state-dir <path>] --active-project <project-id>
        glasspaned --recipe-validate <path>
        glasspaned [--state-dir <path>] --approval-audit
        glasspaned [--state-dir <path>] --approval-verify
        glasspaned [--state-dir <path>] --prune-evidence [--older-than <days>] [--project <id>] [--dry-run]
        glasspaned [--state-dir <path>] --evidence-stats [--project <id>]

    OPTIONS:
        --state-dir <path>    The directory this process keeps its state in:
                                 <path>/evidence/ (evidence archive),
                                 <path>/projects.json (project registry),
                                 <path>/approvals.json (approval ledger),
                                 <path>/probe.sock (unless --probe-socket-path
                                 is given) and <path>/daemon.sock (unless
                                 --socket-path is given). Applies to every
                                 subcommand that reads state, always the same
                                 one within a run. Must be an absolute path;
                                 anything else is a usage error (exit 64).
                                 When it is absent the root is the per-user
                                 folder under this process's home directory,
                                 which does **not** follow a HOME environment
                                 variable set by the caller — overriding HOME
                                 does not isolate a run, and a run that needs
                                 isolation has to name --state-dir. The first
                                 state-touching command of such a run writes one
                                 line to stderr saying the home default was used.
        --socket-path <path>   Unix socket path (default: ~/.glasspane/engine.sock,
                                 or <state-dir>/daemon.sock when --state-dir names
                                 a root). Must be an **absolute** path: this run
                                 chmods the socket's parent directory to 0700, so
                                 a relative value would tighten whichever
                                 directory the daemon happened to be started in
                                 and keep it tightened even after a failed bind.
                                 Anything else is a usage error (exit 64), decided
                                 before a single directory is touched. The name
                                 must also be free or already a socket: a regular
                                 file, a directory or a symlink here is a fatal
                                 refusal and is never removed.
        --verbose, -v         Log frames and state transitions to stderr
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
        --version                  Print `glasspaned <version>` and exit 0 — the same literal the
                                 `hello` frame reports, which is the reading
                                 `updater/lib/version.js` pairs with the bundle plist. Reads no state,
                                 so it takes no state root.
        --permissions              Print this process's TCC seats as JSON:
                                 {"subject":…,"permissions":…} and exit. Called as a
                                 one-shot it measures the one-shot — not whichever
                                 daemon happens to be serving; the `subject` block is
                                 there so a reader can see whose seats these are
                                 (`ProtocolErrors` refuses to let a caller read this
                                 as the daemon's state).
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
        --unattended-window  Declare that no human input reaches this machine
                                 while the daemon works (a maintenance harness on a
                                 machine nobody is typing at). It changes the
                                 contamination verdict **only** for a window that no
                                 input monitor watched, and never overrides an input
                                 the monitor actually saw; the archive records the
                                 verdict as a declaration, so a reader can still tell
                                 "somebody watched and saw nothing" from "nobody was
                                 watching and somebody said it was fine". Without it a
                                 --no-c33 daemon cannot produce a `strong` attribution
                                 at all: every window reads as unwatched, so every
                                 window reads contaminated.
        --no-probe           Disable the P6 probe socket (Z5 black-box only;
                                 handlerProbe/stateDiff signals stay null)
        --probe-socket-path <path>  Probe listener path (default: <state-dir>/probe.sock,
                                 which is ~/.glasspane/probe.sock when no root is
                                 named). Same rules as --socket-path: an
                                 **absolute** path or a usage error (exit 64), and
                                 the directory holding it is brought to 0700 and
                                 must belong to this account — a probe name inside
                                 a directory another account can write is one
                                 `unlink` away from being rebound by that account,
                                 which is why binding there is refused rather than
                                 degraded silently.
        --force-socket       Take over the engine socket even when a live daemon
                                 is already serving it (default: refuse and exit 65)
        --force-probe-socket Take over probe.sock even when another listener owns
                                 it (default: start without a probe listener and
                                 keep the Z5 black-box form; the probe listener
                                 never answers hello, so "a connection can be
                                 established" is how its owner is detected)
        --list-projects        List all registered projects (JSON) and exit
        --project-prune [--dry-run]
                               Remove the registry entries that are engine test
                                 residue (P1 §12.3: sample bundle id AND evidence
                                 under a system temp root, both required). With
                                 --dry-run nothing is written and the hit list is
                                 printed. `pruned` counts entries verified gone
                                 from disk, not entries matched; partial failure
                                 exits 1.
        --project-remove <id> [--dry-run]
                               Remove exactly one registration. Unknown id exits 3;
                                 a registry that cannot be read back is refused
                                 (exit 1) rather than overwritten.
        --active-project <id>  Report whether <id> is a registered project (JSON)
                                 and exit. **This command changes nothing**: the
                                 registry has no active-project field and no
                                 protocol method accepts one, so the payload says
                                 stateChanged=false. To make a project active,
                                 call gp_attach with its projectId.
        --recipe-validate <path>  Validate a recipe **JSON** file against the frozen
                                 kernel recipe contract (schemaVersion
                                 "glasspane.recipe/0.1-draft", steps {kind, params})
                                 and exit; nothing is written either way
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

// MARK: - State root (X-22)

/// The one state root this process reads and writes through, resolving
/// `--state-dir` against the home default.
///
/// Every state-touching subcommand calls this instead of composing a path of
/// its own: one run, one root, so `--list-projects` cannot read a registry the
/// daemon it reports on is not writing.
///
/// When nothing was named it also writes the line that makes the fallback
/// observable. The other half of the proof is the path each subcommand echoes
/// in its own JSON (`dir`, `registryPath`, `ledgerPath`, `stateRoot`); a run that
/// only points `HOME` at a sandbox is **not** isolated, because the home lookup
/// behind this default never consults that variable, so the line says which root
/// it fell back to instead of letting the fallback read as a choice.
///
/// The daemon calls this *after* the single-instance guard, because a second
/// instance that exits 65 must not announce a root it then never touches — and
/// must not tighten one either.
private func resolvedStateRoot(injected: StateRoot?) -> StateRoot {
    if let injected { return injected }
    let root = StateRoot.homeDefault()
    let notice = "glasspaned: --state-dir was not given — state is read and written "
        + "under the home default \(root.path). That default does not consult a HOME "
        + "environment variable, so pointing HOME at a sandbox does not isolate this "
        + "run; pass --state-dir <path> to name the root."
    FileHandle.standardError.write(Data((notice + "\n").utf8))
    return root
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

/// Which socket files the shutdown waiter may unlink, decided **at signal time**.
///
/// The waiter thread is created the moment the mask goes on (see `startShutdownWaiter`'s
/// call site), which is before either listener exists — so it cannot take a snapshot of
/// the paths. It reads this registry instead, and a path is added only by the code that
/// actually bound it: "只清无主名字" (A-18) is precisely the rule a pre-bind snapshot
/// would break, since an instance that loses the name to an incumbent must never unlink
/// the winner's socket file.
private final class ShutdownSocketRegistry {
    private let lock = NSLock()
    private var paths: [String] = []

    func register(_ path: String) {
        lock.lock()
        defer { lock.unlock() }
        if !paths.contains(path) { paths.append(path) }
    }

    var current: [String] {
        lock.lock()
        defer { lock.unlock() }
        return paths
    }
}

private let shutdownSockets = ShutdownSocketRegistry()

private func blockShutdownSignalsEarly() {
    // Writes to a socket whose peer has closed raise SIGPIPE by default and
    // would kill the daemon. Ignore it so write() returns EPIPE and the
    // connection is torn down cleanly (seen on real devices when a client
    // disconnects mid-operation).
    _ = signal(SIGPIPE, SIG_IGN)
    // R6-12: an **inherited** SIG_IGN must not make the daemon unkillable. POSIX job
    // control sets SIGINT (and SIGQUIT) to ignore for background asynchronous
    // commands, and a child inherits that disposition — so a daemon started from
    // `nohup … &`, or from any script the same way, came up with SIGINT ignored.
    // An ignored signal is never queued as pending, which means `sigwait` cannot
    // receive it: the shutdown thread existed, waited correctly, and simply never
    // woke. Measured that way — the gate was green standalone and red inside a
    // background chain, at 0.6 load per core, with the socket files still on disk
    // (`sigwait 未消费信号`), i.e. this was never a timing or load problem.
    // Reset to default before blocking so the mask, not the parent shell, decides
    // how these two are delivered. SIGPIPE stays ignored on purpose above: there
    // the point is that write() returns EPIPE instead of killing us.
    _ = signal(SIGINT, SIG_DFL)
    _ = signal(SIGTERM, SIG_DFL)
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
private func startShutdownWaiter(registry: ShutdownSocketRegistry) {
    Thread.detachNewThread {
        var signalNumber: Int32 = 0
        while true {
            let code = sigwait(&shutdownSignalSet, &signalNumber)
            guard code == 0 else { continue }
            for path in registry.current { unlink(path) }
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

if options.printVersion {
    // 一行、一个出处、退出码 0：读的就是 `hello` 里那个 `version`。这一句不碰状态根，
    // 所以它既不会创建目录，也不会触发那次收紧扫描——与 `--permissions` 同一个道理。
    print("glasspaned \(EngineCore.buildVersion)")
    exit(0)
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
    let stateRoot = resolvedStateRoot(injected: options.stateDir)
    let registry = ProjectRegistry(stateRoot: stateRoot)
    // 读不回的文件一律拒答，不许回 `[]` + 退出码 0。判据在
    // `ProjectRegistry.listing()`（那里可单测），这里只负责把两种"看起来一样"的形状
    // 分开说：真没注册任何东西，和这份文件读不出注册了什么。这条命令恰是 agent 被指来
    // 回答"注册了什么"的那一条（mcp-shell 的 remedy 原文点名它），而 `ProjectRegistry.all`
    // 自己的注释就写着读回失败时不许当成空表；同一份文件在 --project-prune /
    // --project-remove 那里是拒绝覆写的（§12.3.2），读侧不该比写侧更容易蒙混。
    if case .unreadable(let reason) = registry.listing() {
        // 拒绝报文里不给 `projects`，也不给 `count`：读不开的时候这两个值都是编的，
        // 而它们恰好就是这条命令被误读成"什么都没注册"的那两个键。少给一个键，比给一
        // 个看起来像答案的零诚实。
        writeJSON([
            "command": "--list-projects", "loadFailed": true,
            "registryPath": registry.filePath,
            "error": reason,
            "next": "make the file readable again (python3 -m json.tool \(registry.filePath), or restore it from a copy), then restart the background service so it re-reads"
        ], to: .standardError)
        exit(1)
    }
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
    let stateRoot = resolvedStateRoot(injected: options.stateDir)
    let registry = ProjectRegistry(stateRoot: stateRoot)
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

// MARK: - P1 §12.3.1 registry write surface (prune test residue / remove one entry)

/// 注册表的两条写入命令。它们从前**根本不存在**，而面板一直在调：daemon 回
/// `unknown argument` + 退出码 64，面板把那段帮助文本读成 `matched = 0`，于是当着一屏
/// "N 条注册项指向系统临时目录"回一句"没有需要清理的测试残留项目"。这里把缺的
/// 那一半补上，字段与退出码按 §12.3.1 的表来。
///
/// 三条不能弯的口径：
///  1. 判据只有一份（`LocalArchive.isTestResidue`），面板的预览表与 `--dry-run`
///     用的是同一个函数，不留第二处"什么算残留"；
///  2. `pruned` 是**写成功且读回确认已消失**的条数，不是命中条数——把命中当删除数
///     就是在你问"删了多少"时撒谎；
///  3. 两条都认 `--dry-run`。带它却不预览、直接真删，是面板"先看清单再动手"承诺的反面。
private func runProjectPrune(options: Options) -> Never {
    let stateRoot = resolvedStateRoot(injected: options.stateDir)
    let registry = ProjectRegistry(stateRoot: stateRoot)
    let dryRun = options.pruneDryRun
    let before = registry.all

    if registry.loadFailed {
        // 读不回的文件一律拒绝覆写（§12.3.2 / A-1 同源）：自动重读会丢掉本次写入，
        // 照旧覆写会丢掉文件里的真条目，两个方向都是无声丢数据。
        writeJSON([
            "command": "--project-prune", "dryRun": dryRun, "loadFailed": true,
            "total": before.count, "matched": 0, "pruned": 0,
            "prunedProjectIds": [String](), "failed": 0, "failures": [[String: String]](),
            "remaining": before.count, "requiresDaemonRestart": false,
            "projects": [[String: Any]](),
            "registryPath": registry.filePath,
            "error": "projects.json cannot be read back, so nothing was written: refusing to overwrite a table we cannot verify",
            "next": "repair the file (python3 -m json.tool <path>), then restart the daemon"
        ], to: .standardError)
        exit(1)
    }

    let hits = before.filter { LocalArchive.isTestResidue($0) }
    var failures: [[String: String]] = []
    if !dryRun {
        for entry in hits {
            do {
                _ = try registry.remove(entry.projectId)
            } catch {
                failures.append([
                    "projectId": entry.projectId,
                    "reason": (error as? GPError)?.message ?? error.localizedDescription,
                ])
            }
        }
    }

    // 读回校验：报出去的数字来自盘上现在真的有什么，不来自刚才那几次调用的返回值。
    let verified = ProjectRegistry(stateRoot: stateRoot)
    let stillRegistered = Set(verified.all.map { $0.projectId })
    let prunedIds = dryRun ? [] : hits.map(\.projectId).filter { !stillRegistered.contains($0) }
    let pruned = prunedIds.count
    let failedCount = dryRun ? failures.count : hits.count - pruned
    if verified.loadFailed && !dryRun {
        writeJSON([
            "command": "--project-prune", "dryRun": false, "loadFailed": true,
            "total": before.count, "matched": hits.count, "pruned": 0,
            "prunedProjectIds": [String](), "failed": hits.count,
            "failures": [["projectId": "*", "reason": "the registry cannot be read back after the write"]],
            "remaining": 0, "requiresDaemonRestart": true, "projects": [[String: Any]](),
            "registryPath": registry.filePath,
            "error": "the write left projects.json unreadable; the daemon must not keep running on its in-memory copy",
            "next": "restore the file from \(registry.filePath) backups and restart the daemon"
        ], to: .standardError)
        exit(1)
    }

    let detail: [[String: Any]] = hits.map {
        ["projectId": $0.projectId, "displayName": $0.displayName,
         "bundleId": $0.bundleId, "evidenceStoragePath": $0.evidenceStoragePath ?? NSNull()]
    }
    writeJSON([
        "command": "--project-prune", "dryRun": dryRun, "loadFailed": false,
        "total": before.count, "matched": hits.count, "pruned": pruned,
        "prunedProjectIds": prunedIds, "failed": failedCount, "failures": failures,
        "remaining": verified.all.count, "projects": detail,
        // 真删掉过东西才谈重启：一次预览没有改任何东西，报"要重启"是凭空造一个待办。
        "requiresDaemonRestart": pruned > 0,
        "registryPath": registry.filePath,
    ])
    // 命中 5 条只删掉 3 条即为 1（§12.3.1）：部分成功不许读成全成就。
    exit(failedCount > 0 ? 1 : 0)
}

private func runProjectRemove(projectId: String, options: Options) -> Never {
    let stateRoot = resolvedStateRoot(injected: options.stateDir)
    let registry = ProjectRegistry(stateRoot: stateRoot)
    let dryRun = options.pruneDryRun
    let before = registry.all

    if registry.loadFailed {
        writeJSON([
            "command": "--project-remove", "dryRun": dryRun, "loadFailed": true,
            "found": false, "removed": false, "wouldRemove": false, "remaining": before.count,
            "projectId": projectId, "registryPath": registry.filePath,
            "error": "projects.json cannot be read back, so nothing was written",
            "next": "repair the file (python3 -m json.tool <path>), then restart the daemon"
        ], to: .standardError)
        exit(1)
    }

    let found = before.contains { $0.projectId == projectId }
    if dryRun {
        // 预览面：`--dry-run` 带着却不预览、直接真删，是面板承诺的反面。
        writeJSON([
            "command": "--project-remove", "dryRun": true, "loadFailed": false,
            "found": found, "wouldRemove": found, "removed": false,
            "remaining": found ? before.count - 1 : before.count,
            "projectId": projectId, "registryPath": registry.filePath,
        ])
        exit(found ? 0 : 3)
    }

    guard found else {
        writeJSON([
            "command": "--project-remove", "dryRun": false, "loadFailed": false,
            "found": false, "removed": false, "remaining": before.count,
            "projectId": projectId, "registryPath": registry.filePath,
            "error": "no project \(projectId) is registered",
            "next": "glasspaned --list-projects"
        ], to: .standardError)
        exit(3)   // §12.3.1：未知 id → 3
    }

    do {
        _ = try registry.remove(projectId)
    } catch let error as GPError {
        writeJSON([
            "command": "--project-remove", "dryRun": false, "loadFailed": false,
            "found": true, "removed": false, "remaining": before.count,
            "projectId": projectId, "registryPath": registry.filePath,
            "code": error.code.rawValue, "error": error.message,
        ], to: .standardError)
        exit(1)
    } catch {
        writeJSON([
            "command": "--project-remove", "dryRun": false, "loadFailed": false,
            "found": true, "removed": false, "remaining": before.count,
            "projectId": projectId, "registryPath": registry.filePath,
            "error": error.localizedDescription,
        ], to: .standardError)
        exit(1)
    }

    let verified = ProjectRegistry(stateRoot: stateRoot)
    // 判据在 `ProjectRegistry.removalVerdict`（那里可单测）：读不回时 `all` 是空的，
    // 于是裸的 `!all.contains(…)` 恒为真——这条命令会在"根本看不见盘"的情况下报一次
    // 成功并退 0。`runProjectPrune` 对同一种状况是 exit(1)（§12.3.2 同源），写侧两条
    // 命令不能一个拒、一个报喜。这里不给 remaining：读不回时任何条数都是编的。
    let verdict = verified.removalVerdict(projectId: projectId)
    if !verdict.answerable {
        writeJSON([
            "command": "--project-remove", "dryRun": false, "loadFailed": true,
            "found": true, "removed": false,
            "projectId": projectId, "registryPath": registry.filePath,
            // 盘与 daemon 内存此刻已经不一致，重启确实需要——这里不夸大。
            "requiresDaemonRestart": true,
            "error": verified.unreadableReport ?? "the registry cannot be read back after the write",
            "next": "make the file readable again (python3 -m json.tool \(registry.filePath), or restore it from a copy) and restart the daemon"
        ], to: .standardError)
        exit(1)
    }
    let gone = verdict.removed
    writeJSON([
        "command": "--project-remove", "dryRun": false,
        "loadFailed": verified.loadFailed,
        // `removed` 说的是盘上现在真的没有它了，不是"remove() 没抛异常"。
        "found": true, "removed": gone, "remaining": verified.all.count,
        "projectId": projectId, "registryPath": registry.filePath,
        "requiresDaemonRestart": gone,
    ])
    exit(gone ? 0 : 1)
}

if options.projectPrune {
    runProjectPrune(options: options)
}

if let projectId = options.projectRemoveId {
    runProjectRemove(projectId: projectId, options: options)
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
    let stateRoot = resolvedStateRoot(injected: options.stateDir)
    let gate = ApprovalGate(stateRoot: stateRoot)
    // P8: a ledger whose last append never reached disk is an audit fact, so it
    // is published here rather than left in a log line — and it changes this
    // command's exit code. Scope stated exactly, because the field's honesty
    // depends on it: a one-shot verify/audit run reads the file and never
    // appends, so `gate.persistFailed` can only be nil *in this process*. The
    // run that can fail to persist is the daemon, whose gate `EngineCore` holds;
    // that instance has to surface the field on its own status face (the `hello`
    // payload / an engine method) for the fact to leave the process that knows
    // it. The keys are here so the shape of the answer does not depend on which
    // process is asked, and `ledgerPath`/`stateRoot` so a reader of either run
    // sees the file this run actually opened.
    if options.approvalVerify {
        let verdict = gate.verifyChain()
        let payload: [String: Any] = [
            "valid": verdict.valid,
            "count": gate.count,
            // R6-07: a hash chain can prove that nothing *inside* it was edited;
            // it cannot prove that its tail is still there, because a shorter
            // chain re-verifies from the same genesis. No local anchor fixes
            // that — an anchor file in a directory the same account can write is
            // deletable by exactly the party the check would catch, and claiming
            // otherwise would be a guard with no reachable refusal. What this
            // pair does give an operator or agent is the honest version: verify
            // reports where the chain ends, so a run that recorded `count` and
            // `tailHash` earlier can notice a shrinkage it cannot derive from
            // the ledger alone. The detectable attack (cut, then append a
            // spliced record) remains `valid: false`.
            "tailHash": gate.tailHash(),
            "firstBrokenIndex": verdict.firstBrokenIndex.map { $0 as Any } ?? NSNull(),
            "loadFailed": gate.loadFailed,
            "persistFailed": gate.persistFailed ?? NSNull(),
            "ledgerPath": gate.ledgerPath ?? NSNull(),
            "stateRoot": stateRoot.path
        ]
        writeJSON(payload)
        let ok = verdict.valid && !gate.loadFailed && gate.persistFailed == nil
        if !ok && gate.loadFailed {
            FileHandle.standardError.write(
                Data("warning: ledger file exists but is corrupt; verify cannot pass\n".utf8)
            )
        }
        if let failure = gate.persistFailed {
            FileHandle.standardError.write(
                Data("warning: \(failure)\n".utf8)
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
    // evidenceStoragePath（缺失或不合法即拒绝，不回落共享档案）；
    // 无项目维度 → 本次运行解析出的那一个状态根下的共享档案目录
    // （--state-dir 给了就是 <state-dir>/evidence，没给就是 home 默认）。
    //
    // A-07/C-06: the project dimension used to hand the stored
    // `evidenceStoragePath` straight to the store that deletes from it, while
    // `attach` had already started refusing that same stored value. Both
    // commands now go through `EngineCore.projectArchiveDirectory`, the one
    // resolver the engine uses: nothing is deleted or measured in a directory
    // the daemon would refuse to archive into, and a project that named no
    // directory of its own never gets the shared archive touched in its place.
    //
    // The store is built here, once, so the deleting pass and the reading pass
    // cannot be pointed at different archives. Omitting `--project` still means
    // the shared archive — with `--state-dir` that is `<state-dir>/evidence/`,
    // and without it this process's own per-user archive, which is exactly the
    // root every other subcommand of this run resolved. The destructive scope is
    // still named at the call site rather than folded in by an omitted argument;
    // what leaving the argument out can no longer do is point one command at a
    // directory another command is not using.
    // `EngineCore.pruneEvidence` refuses its own no-store case for exactly that
    // reason (an embedded engine that was handed no archive has no directory to
    // prune), and this branch is where the shared archive is meant to be pruned.
    // `dir` repeats the location because `EvidenceStore.directory` is
    // module-internal and the JSON output has to name what was touched.
    let stateRoot = resolvedStateRoot(injected: options.stateDir)
    let store: EvidenceStore
    let dir: String
    if let projectId = options.maintenanceProjectId {
        let registry = ProjectRegistry(stateRoot: stateRoot)
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
            // P8: the refusal is right that this project owns no archive, and the
            // shared archive it warns against is *this run's* — `<state-dir>/
            // evidence/` when `--state-dir` named a root, this process's per-user
            // folder when it did not. The engine's own sentence cannot know which,
            // so the payload names the locations this process actually opened
            // (`registryPath`, `stateRoot`, `sharedArchiveOfThisRun`) and repeats
            // the command that owns them, with the root spelled out so the agent
            // pruning it cannot be pointed at a different installation than the
            // one that refused.
            writeJSON(
                [
                    "error": refusal.message,
                    "remedy": refusal.remedy,
                    "code": refusal.code.rawValue,
                    "project": projectId,
                    "registryPath": registry.filePath,
                    "stateRoot": stateRoot.path,
                    "sharedArchiveOfThisRun": stateRoot.evidenceDirectory,
                    "next": "glasspaned --prune-evidence --older-than \(options.pruneOlderThanDays) --state-dir \(stateRoot.path) — with no --project, because that command is the surface that owns \(stateRoot.evidenceDirectory); look first with --evidence-stats and count without deleting via --dry-run",
                    "stateChanged": false
                ],
                to: .standardError
            )
            exit(1)
        case .success(let stored):
            dir = stored
            store = EvidenceStore(directory: stored)
        }
    } else {
        dir = stateRoot.evidenceDirectory
        store = EvidenceStore.at(stateRoot: stateRoot)
    }
    if options.pruneEvidence {
        // --dry-run 与真实修剪共享同一判定路径（countExpired 与 prune 同源，
        // P5 §12.2 诚实口径：输出=真实会删除的数量，非估算）。
        let removed = options.pruneDryRun
            ? store.countExpired(olderThanDays: options.pruneOlderThanDays)
            : store.prune(olderThanDays: options.pruneOlderThanDays)
        // 归档读不了的时候 `prune`/`countExpired` 只能回 0，而那句 0 不是"没有过期的"。
        // 与 --evidence-stats 同一条规矩：没测出来就写 null，并把失败原因一起发出去。
        let listFailure = store.listingFailure
        writeJSON(EvidencePruneReport.payload(
            pruned: listFailure == nil ? removed : nil,
            dryRun: options.pruneDryRun,
            project: options.maintenanceProjectId,
            dir: dir,
            listFailure: listFailure
        ))
        exit(0)
    }
    if options.evidenceStats {
        let stats = store.stats()
        // R6-08: when the archive could not be read these are not zeros, they are
        // "not obtained" — and the p6 gate's isolation precondition consumes
        // exactly this line, so a 0 here used to certify an unreadable archive.
        let unreadable = stats.listFailure != nil
        let payload: [String: Any] = [
            "count": unreadable ? NSNull() : stats.count,
            "totalBytes": unreadable ? NSNull() : stats.totalBytes,
            "listFailure": stats.listFailure ?? NSNull(),
            "project": options.maintenanceProjectId ?? NSNull(),
            "dir": dir
        ]
        writeJSON(payload)
        exit(0)
    }
}

// `--socket-path` wins outright. Otherwise a **named** root serves on
// `<root>/daemon.sock`, and a run that named nothing keeps the historic
// `<home>/.glasspane/engine.sock` name — renaming the socket of an existing
// installation is not this change's to make, and `StateRoot` is the one place
// the whole rule is written (the settings panel resolves through it too).
//
// The state root itself is resolved **below**, after the single-instance guard
// has decided that this run is the one that serves: nothing above this line may
// touch state, and neither may a run that is about to exit 65 (P8/R5-04's
// ordering half — see the comment on `stateRoot` where it is finally resolved).
let socketPath = StateRoot.engineSocketPath(
    explicitSocketPath: options.socketPath,
    stateRoot: options.stateDir
)
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
        // X-24: "no listener" is a statement about **listeners**, not a
        // permission to delete what is here. A regular file answers connect with
        // ECONNREFUSED/ENOTSOCK, so `--socket-path ~/.ssh/id_rsa` used to reach
        // this branch, print "binding it", unlink the private key and bind a
        // socket in its place. `SocketServer` now refuses that takeover in front
        // of every unlink; saying "nothing listens — binding it" here would be
        // announcing a plan this run is about to refuse, so the two statements
        // are split by what the inode actually is.
        if let kind = SocketServer.nonSocketInodeKind(at: socketPath) {
            // Not through EngineLog: quiet mode swallows it, and a run that is
            // about to exit having said nothing is the shape A-18 removed for
            // the probe listener.
            FileHandle.standardError.write(Data(("""
            glasspaned: refusing to take over \(socketPath) — it is \(kind), not a socket.
              Nothing was unlinked and this run will not bind here.
              - point --socket-path at a name that is free (or let --state-dir derive it), or
              - remove \(socketPath) yourself first.
            """ + "\n").utf8))
        } else {
            log.info("nothing listens on \(socketPath) (\(reason)) — binding it")
        }
    }
}

// One resolution for the whole daemon: the sockets below and every state object
// handed to EngineCore come from this root, so a `--state-dir` run cannot serve
// from the sandbox while archiving into the per-user folder (or the other way
// round, which is how the real projects.json was lost).
//
// It sits **after** the single-instance guard on purpose (P8). The guard is what
// decides whether this process is the service; a second instance that is about
// to exit 65 owns nothing and gets to change nothing, and until this line moved
// it had already rewritten the *living* instance's state root — the sweep below
// chmods the root, its archive directory and every entry inside them. Tightening
// another process's state from a run that immediately loses the name is the same
// family of defect this round keeps finding: a check that speaks and then acts
// anyway. The ordering also puts the `--state-dir was not given` notice (written
// by `resolvedStateRoot`) in the only run that really is about to read and write
// that root, instead of in one that touches nothing.
let stateRoot = resolvedStateRoot(injected: options.stateDir)
let probeSocketPath = options.probeSocketPath ?? stateRoot.probeSocketFile
// R5-04: this process writes the archive, the registry and the approval chain,
// so it is the process that closes the exposure the umask left there — files and
// directories that predate the 0700/0600 rule are tightened once, here, and
// every path it could not tighten is named in the log. The one-shot maintenance
// subcommands deliberately do **not** do this: `--evidence-stats` and
// `--active-project` are the read-only probes the smoke gates use to measure
// which state root a run resolved, and a probe that chmods is not read-only.
stateRoot.tightenPermissions(log: log)

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
// R6-07: the consumer thread has to exist **before** anything that can take time.
// It used to be started on the last line of startup — after the probe listener, the
// input monitor and `EngineCore` were wired — on the theory that "the mask is on and
// every thread-creating init is done". That left a window in which a masked signal had
// no consumer at all, and the signal gate kept hitting it: measured on this machine at
// 13× its core count, the stretch between the mask and the waiter overran the smoke's
// 6 s budget, so `SIGINT` sat pending with nothing scheduled to take it and the daemon
// read as unkillable. That is the shape R5-07 removed for the single-instance guard,
// reappearing one function later. Starting the thread first costs nothing: the
// registry is empty until a listener really binds, so an early exit unlinks nothing.
startShutdownWaiter(registry: shutdownSockets)
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
// R3-1: the declaration is a statement about the machine, so it has to be
// observable in the run that made it — an agent reading the daemon's own output
// can then tell a declared-unattended run from one that merely never monitored.
if options.unattendedWindowDeclared {
    log.info("unattended window declared (contamination verdicts for unwatched windows are declarations, not measurements)")
} else if attributionGuard == nil {
    log.info("no unattended declaration and no input monitor: every window will read contaminated=true / attribution=weak")
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
        // Bound successfully, so this name is ours to remove on shutdown.
        shutdownSockets.register(probeSocketPath)
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
    // C-02/C-03 named both locations out loud instead of letting an omitted
    // argument decide; X-22 made that one argument: all three come from the
    // `stateRoot` resolved above, which is either the directory `--state-dir`
    // named or, with a line on stderr saying so, this process's per-user folder.
    projectRegistry: ProjectRegistry(stateRoot: stateRoot),
    evidenceStore: EvidenceStore.at(stateRoot: stateRoot),
    attributionGuard: attributionGuard,
    degradationTracker: DegradationTracker(),
    metricsProbe: ProcessMetricsProbe(),
    approvalGate: ApprovalGate(stateRoot: stateRoot, log: log),
    probeInbox: probeInbox,
    permissionsReport: { permissionProbes.snapshot() },
    inputMonitorAbsenceReason: inputMonitorAbsenceReason,
    declaresUnattendedWindow: options.unattendedWindowDeclared
)
let dispatcher = Dispatcher(core: core, log: log)
let server = SocketServer(
    socketPath: socketPath,
    dispatcher: dispatcher,
    log: log,
    preemptsExistingSocket: options.forceSocket
)
// 消费线程已在遮罩之后立刻创建（见上面的 R6-07）；这里只登记 engine 自己的名字，
// 而且登记的时机由 `SocketServer` 在 bind 成功之后回调决定——在 `run()` 之前登记会
// 给"抢名失败的那一方去 unlink 现任的 socket"留出窗口，而那正是 A-18 三条状态判定要
// 消灭的形状。
server.onBound = { shutdownSockets.register(server.socketPath) }

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
