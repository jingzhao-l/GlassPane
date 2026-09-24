import Foundation

/// Structured error surface of the engine protocol (P0 spec §3.4).
/// `remedy` mirrors the spec table's agent-executable guidance verbatim so
/// MCP-shell consumers can surface identical hints without knowing the engine.
/// `CaseIterable` exists so the remedy table can be swept by a test that checks
/// every command it names is a command the daemon/installer really parses.
public enum GPErrorCode: String, Codable, CaseIterable {
    case badRequest = "GP_E_BAD_REQUEST"
    case payloadTooLarge = "GP_E_PAYLOAD_TOO_LARGE"
    case methodNotFound = "GP_E_METHOD_NOT_FOUND"
    case badParams = "GP_E_BAD_PARAMS"
    case notAttached = "GP_E_NOT_ATTACHED"
    case appNotFound = "GP_E_APP_NOT_FOUND"
    case axUnavailable = "GP_E_AX_UNAVAILABLE"
    case actFailed = "GP_E_ACT_FAILED"
    case assertTargetNotFound = "GP_E_ASSERT_TARGET_NOT_FOUND"
    case noOperation = "GP_E_NO_OPERATION"
    case noEvidence = "GP_E_NO_EVIDENCE"
    case noSnapshot = "GP_E_NO_SNAPSHOT"
    case restoreUnsupported = "GP_E_RESTORE_UNSUPPORTED"
    case restoreStepFailed = "GP_E_RESTORE_STEP_FAILED"
    case projectLimit = "GP_E_PROJECT_LIMIT"
    case notFound = "GP_E_NOT_FOUND"
    case busyInput = "GP_E_BUSY_INPUT"
    case probeUnavailable = "GP_E_PROBE_UNAVAILABLE" // P6 spec v6.0 §1/§5.4
    case internalError = "GP_E_INTERNAL"
}

public struct GPError: Error {
    public let code: GPErrorCode
    public let message: String
    public let remedy: String

    public init(code: GPErrorCode, message: String) {
        self.code = code
        self.message = message
        self.remedy = Self.remedy(for: code)
    }

    public init(code: GPErrorCode, message: String, remedy: String) {
        self.code = code
        self.message = message
        self.remedy = remedy
    }

    /// Remedy text per P0 spec §3.4 (kept in sync with the spec table).
    /// Every command named here must exist in `glasspaned`'s argument parser or
    /// in `installer/cli.js` — see `HumanInterventionAuditTests` for the gate.
    public static func remedy(for code: GPErrorCode) -> String {
        switch code {
        case .badRequest:
            return "fix the JSON payload and resend the frame"
        case .payloadTooLarge:
            return "reduce observe maxDepth or narrow the selector scope"
        case .methodNotFound:
            return "use a method from the protocol method table (hello/attach/act/observe/assert_element/audit_ui/diagnose/last_evidence/snapshot/restore/probe_status/shutdown)"
        case .badParams:
            return "fix the parameters according to the method table"
        case .notAttached:
            return "call attach first"
        case .appNotFound:
            return "confirm the target app is running, then attach again"
        case .axUnavailable:
            // R2-13：旧文案把人支去 `glasspaned --grant-accessibility`，而那条命令
            // 申请的是**运行它的进程**的席位（终端），阻塞至多 300s，还会打印
            // "already granted" 并退出 0 —— daemon 的席位一点没变，却报成成功。
            // TCC 按责任进程身份记账，所以 remedy 必须指向真正作用在 daemon 身份上
            // 的路径（installer --restore-launchd 会 bootstrap、用 hello 读 daemon
            // 自报的席位，必要时 `launchctl kickstart -k` 换新判定进程复验）。
            return "the Accessibility seat that is missing belongs to the **daemon process**, not to you — GP_E_AX_UNAVAILABLE is always reported by the daemon. Run `node installer/cli.js --restore-launchd`: it bootstraps the launchd job if needed, reads `hello` from the running daemon to see the seat *it* reports, and restarts it with `launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon` so a fresh process re-reads TCC. The only physical step left to a human is ticking the daemon's own entry under System Settings > Privacy & Security > Accessibility, then re-running the same command. If that entry is not in the list yet, the way to make the daemon register itself is `launchctl submit -l <one-shot label> -- <daemon binary> --request-permission accessibility` — the daemon binary's own path, because that flag grants the seat of whichever process runs it. Do NOT try to fix a running daemon with `glasspaned --grant-accessibility` (nor with `--check-accessibility` / `--permissions`): those act on the caller's process, so they grant your shell's seat — `--grant-accessibility` additionally blocks up to 300s and exits 0 while the daemon stays exactly as denied as before. Until the daemon's own seat exists, observe/act are genuinely unavailable: report INCONCLUSIVE with this reason, do not retry blindly and do not re-attach hoping for a different answer."
        case .actFailed:
            return "try another action or verify the selector matches an existing element"
        case .assertTargetNotFound:
            return "verify the selector or run observe first to inspect the tree"
        case .noOperation:
            return "run act or assert_element first"
        case .noEvidence:
            return "produce evidence first (act/assert_element/diagnose), or check the operationId matches a recorded operation"
        case .noSnapshot:
            return "run gp_snapshot first, then restore with that snapshotId"
        case .restoreUnsupported:
            return "tier-1 restore needs a probe checkpoint: integrate GlassPaneProbe (GP.start() + registerCheckpoint), re-snapshot, then restore; or use tier-2 ffwd (pass steps)"
        case .restoreStepFailed:
            return "fix the failing step in the steps array (see the failed step index), then retry restore"
        case .projectLimit:
            return "delete unused projects first (glasspaned --list-projects), then retry"
        case .notFound:
            return "check the projectId; use gp_project_list to view available projects"
        case .busyInput:
            return "wait for the user to stop interacting, then retry act; or re-issue act with \"degrade\": true to proceed now with the contamination recorded in evidence (attribution weak + contaminated=true) — never silently clean"
        case .probeUnavailable:
            return "integrate GlassPaneProbe into the target app (GP.start()) and confirm it is running; probe presence is required for T4/T5/T7/T8 verdicts — without it diagnosis stays INCONCLUSIVE, do not guess"
        case .internalError:
            return "check the daemon log (stderr) and retry"
        }
    }
}

/// Agent-facing text surface shared by the daemon and the `glasspaned` CLI.
///
/// Anything this process did not author — an agent-supplied `displayName`, a
/// caller-supplied path, a peer's error string — must leave through JSON
/// escaping, otherwise control characters reach the terminal and act on it
/// (R5-03: `--active-project` used to interpolate the registry's `displayName`
/// raw, so an OSC-52 clipboard sequence or an ANSI cursor move typed straight
/// through). `JSONSerialization` escapes the same set that matters here as
/// `JSONEncoder` does — `< 0x20`, `"` and `\` — and leaves `/` unescaped, so the
/// escaping properties match `--list-projects`.
public enum AgentText {

    /// One JSON line (trailing newline included), or nil when the payload could
    /// not be encoded. There is no raw-text fallback: no line beats a lie.
    public static func jsonLine(_ object: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(
            withJSONObject: object, options: [.sortedKeys]
        ) else {
            return nil
        }
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        return text + "\n"
    }

    /// True when `text` would move the terminal instead of merely printing to it.
    public static func containsTerminalControlText(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }
}
