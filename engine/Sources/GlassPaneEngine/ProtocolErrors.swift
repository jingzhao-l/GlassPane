import Foundation

/// Structured error surface of the engine protocol (P0 spec §3.4).
/// `remedy` mirrors the spec table's agent-executable guidance verbatim so
/// MCP-shell consumers can surface identical hints without knowing the engine.
public enum GPErrorCode: String, Codable {
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
    public static func remedy(for code: GPErrorCode) -> String {
        switch code {
        case .badRequest:
            return "fix the JSON payload and resend the frame"
        case .payloadTooLarge:
            return "reduce observe maxDepth or narrow the selector scope"
        case .methodNotFound:
            return "use a method from the protocol method table (hello/attach/act/observe/assert_element/diagnose/last_evidence/snapshot/restore/probe_status/shutdown)"
        case .badParams:
            return "fix the parameters according to the method table"
        case .notAttached:
            return "call attach first"
        case .appNotFound:
            return "confirm the target app is running, then attach again"
        case .axUnavailable:
            return "run onboarding: glasspaned --grant-accessibility (opens System Settings > Privacy & Security > Accessibility)"
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
