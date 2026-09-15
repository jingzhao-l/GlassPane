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
    case noSnapshot = "GP_E_NO_SNAPSHOT"
    case restoreUnsupported = "GP_E_RESTORE_UNSUPPORTED"
    case restoreStepFailed = "GP_E_RESTORE_STEP_FAILED"
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
            return "use a method from the protocol method table (hello/attach/act/observe/assert_element/diagnose/last_evidence/snapshot/restore/shutdown)"
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
        case .noSnapshot:
            return "run gp_snapshot first, then restore with that snapshotId"
        case .restoreUnsupported:
            return "use tier-2 ffwd (pass steps) or wait for the Z5 snapshot batch"
        case .restoreStepFailed:
            return "fix the failing step in the steps array (see the failed step index), then retry restore"
        case .internalError:
            return "check the daemon log (stderr) and retry"
        }
    }
}
