import Foundation

/// Per-method parameter validation (P0 spec §3.3/§3.5). Every violation maps
/// to GP_E_BAD_PARAMS with a message naming the offending field.
enum ParamValidation {

    static let selectorMaxLength = 512
    /// `expected` is persisted verbatim into every evidence pack and re-emitted
    /// by exports, so it carries the same cap as the selector fields and the
    /// shell's `ExpectSchema` — length-only checks were the gap (P0 §3.3).
    static let expectedMaxLength = 512
    static let observeMaxDepthLower = 1
    static let observeMaxDepthUpper = 10
    static let stepsLower = 1
    static let stepsUpper = 64
    /// `attach.pid` is narrowed to `pid_t` (Int32) by the dispatcher: an
    /// unbounded value survives the integer check and then traps the whole
    /// conversion, so the range is part of the bad-params contract, not a
    /// nicety (P0 §3.3).
    static let pidLower = 1
    static let pidUpper = Int(Int32.max)
    /// Crockford base32 body shared by op_/snap_ ids (§1.2 / P0 §4.1).
    private static let idBodyPattern = "[0-9A-HJKMNP-TV-Z]{26}"
    static let snapshotIdPattern = "^snap_" + idBodyPattern + "$"
    static let operationIdPattern = "^op_" + idBodyPattern + "$"
    static let restoreModeMaxLength = 32

    /// Closed set for `restore.mode` (P1 v1.1 §1.2, P5 v5.0 §6.4): the two
    /// literals EngineCore branches on, plus the documented names of the two
    /// forms it runs when `mode` is omitted. Anything else used to be free
    /// text that ended up inside the hash-chained approval ledger.
    static let restoreModes: [String] = [
        "compare", "ffwd", "restore_snapshot", "rollback_full"
    ]

    static func optString(
        _ params: [String: Any],
        _ key: String,
        maxLength: Int? = nil
    ) throws -> String? {
        guard let raw = params[key] else { return nil }
        guard let string = raw as? String else {
            throw GPError(code: .badParams, message: "field '\(key)' must be a string")
        }
        if let maxLength, string.count > maxLength {
            throw GPError(code: .badParams, message: "field '\(key)' exceeds \(maxLength) characters")
        }
        return string
    }

    static func optInt(
        _ params: [String: Any],
        _ key: String,
        range: ClosedRange<Int>? = nil
    ) throws -> Int? {
        guard let raw = params[key] else { return nil }
        guard let number = raw as? NSNumber,
              !ParamValidation.isBoolean(raw),
              number.isIntegerType,
              let value = number.int64ValueExact,
              Int(exactly: value) != nil else {
            throw GPError(code: .badParams, message: "field '\(key)' must be an integer")
        }
        let intValue = Int(value)
        if let range, !range.contains(intValue) {
            throw GPError(code: .badParams, message: "field '\(key)' must be in \(range)")
        }
        return intValue
    }

    /// 可选浮点参数。与 `optInt` 同一判据：布尔不当数字收，越界即拒（拒得越早，
    /// 调用方越不需要猜默认值）。
    static func optDouble(
        _ params: [String: Any],
        _ key: String,
        range: ClosedRange<Double>? = nil
    ) throws -> Double? {
        guard let raw = params[key] else { return nil }
        guard let number = raw as? NSNumber, !ParamValidation.isBoolean(raw) else {
            throw GPError(code: .badParams, message: "field '\(key)' must be a number")
        }
        let value = number.doubleValue
        if !value.isFinite {
            throw GPError(code: .badParams, message: "field '\(key)' must be finite")
        }
        if let range, !range.contains(value) {
            throw GPError(code: .badParams, message: "field '\(key)' must be in \(range)")
        }
        return value
    }

    static func optBool(_ params: [String: Any], _ key: String) throws -> Bool? {
        guard let raw = params[key] else { return nil }
        guard ParamValidation.isBoolean(raw), let bool = raw as? Bool else {
            throw GPError(code: .badParams, message: "field '\(key)' must be a boolean")
        }
        return bool
    }

    static func optSelector(_ params: [String: Any], _ key: String = "selector") throws -> Selector? {
        guard params.keys.contains(key) else { return nil }
        guard let dict = params[key] as? [String: Any] else {
            throw GPError(code: .badParams, message: "field 'selector' must be an object")
        }
        guard let role = dict["role"] as? String, !role.isEmpty else {
            throw GPError(code: .badParams, message: "field 'selector.role' must be a non-empty string")
        }
        if role.count > selectorMaxLength {
            throw GPError(code: .badParams, message: "field 'selector.role' exceeds \(selectorMaxLength) characters")
        }
        let title = try optString(dict, "title", maxLength: selectorMaxLength)
        let identifier = try optString(dict, "identifier", maxLength: selectorMaxLength)
        return Selector(role: role, title: title, identifier: identifier)
    }

    static func requireSelector(_ params: [String: Any]) throws -> Selector {
        guard let selector = try optSelector(params) else {
            throw GPError(code: .badParams, message: "field 'selector' is required")
        }
        return selector
    }

    static func requireAction(_ params: [String: Any]) throws -> Action {
        guard let raw = params["action"] as? String else {
            throw GPError(code: .badParams, message: "field 'action' must be a string")
        }
        guard let action = Action(rawValue: raw) else {
            throw GPError(code: .badParams, message: "field 'action' must be one of \(Action.allCases.map(\.rawValue))")
        }
        return action
    }

    static func requireProperty(_ params: [String: Any]) throws -> AssertionProperty {
        guard let raw = params["property"] as? String else {
            throw GPError(code: .badParams, message: "field 'property' must be a string")
        }
        guard let property = AssertionProperty(rawValue: raw) else {
            throw GPError(code: .badParams, message: "field 'property' must be one of \(AssertionProperty.allCases.map(\.rawValue))")
        }
        return property
    }

    static func requireExpected(_ params: [String: Any]) throws -> StringOrBool {
        guard let raw = params["expected"] else {
            throw GPError(code: .badParams, message: "field 'expected' is required")
        }
        if ParamValidation.isBoolean(raw), let bool = raw as? Bool {
            return .bool(bool)
        }
        if let string = raw as? String {
            guard string.count <= expectedMaxLength else {
                throw GPError(
                    code: .badParams,
                    message: "field 'expected' exceeds \(expectedMaxLength) characters"
                )
            }
            return .string(string)
        }
        throw GPError(code: .badParams, message: "field 'expected' must be a string or boolean")
    }

    static func isBoolean(_ value: Any) -> Bool {
        CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID()
    }

    // MARK: - P1 snapshot/restore (spec v1.1 §1.2)

    static func requireSnapshotId(_ params: [String: Any]) throws -> String {
        guard let raw = params["snapshotId"] else {
            throw GPError(code: .badParams, message: "field 'snapshotId' is required")
        }
        guard let snapshotId = raw as? String,
              snapshotId.range(of: snapshotIdPattern, options: .regularExpression) != nil else {
            throw GPError(code: .badParams, message: "field 'snapshotId' must match \(snapshotIdPattern)")
        }
        return snapshotId
    }

    /// Required `operationId`: the ULID shape, never free text. The value is
    /// composed straight into the on-disk evidence path
    /// (`EvidenceStore.path(for:)`), so an unchecked string let a caller walk
    /// out of the archive directory (P0 §4.1).
    static func requireOperationId(_ params: [String: Any], _ key: String = "operationId") throws -> String {
        guard let raw = params[key] else {
            throw GPError(code: .badParams, message: "field '\(key)' is required")
        }
        guard let operationId = raw as? String,
              operationId.range(of: operationIdPattern, options: .regularExpression) != nil else {
            throw GPError(code: .badParams, message: "field '\(key)' must match \(operationIdPattern)")
        }
        return operationId
    }

    /// Optional `operationId` (diagnose / last_evidence): omitting the field
    /// yields nil (the engine then answers "latest"), any present value must
    /// match the id pattern.
    static func optOperationId(_ params: [String: Any], _ key: String = "operationId") throws -> String? {
        guard params.keys.contains(key) else { return nil }
        return try requireOperationId(params, key)
    }

    /// Optional `restore.mode` restricted to `restoreModes`. A length-only
    /// check let any agent-authored sentence reach the approval ledger
    /// verbatim (`restore executed: <mode>`).
    static func optRestoreMode(_ params: [String: Any], _ key: String = "mode") throws -> String? {
        guard let mode = try optString(params, key, maxLength: restoreModeMaxLength) else { return nil }
        guard restoreModes.contains(mode) else {
            throw GPError(
                code: .badParams,
                message: "field '\(key)' must be one of \(restoreModes)"
            )
        }
        return mode
    }

    /// Optional `steps` array of act-like steps for ffwd 重演 (§1.2).
    /// Returns nil when absent; otherwise validates 1–64 entries.
    static func optSteps(_ params: [String: Any], _ key: String = "steps") throws -> [(Selector, Action)]? {
        guard params.keys.contains(key) else { return nil }
        guard let rawSteps = params[key] as? [[String: Any]] else {
            throw GPError(code: .badParams, message: "field 'steps' must be an array of {selector, action} steps")
        }
        guard rawSteps.count >= stepsLower, rawSteps.count <= stepsUpper else {
            throw GPError(code: .badParams, message: "field 'steps' must contain \(stepsLower)–\(stepsUpper) steps")
        }
        var steps: [(Selector, Action)] = []
        steps.reserveCapacity(rawSteps.count)
        for (index, step) in rawSteps.enumerated() {
            let selector: Selector
            let action: Action
            do {
                guard let parsedSelector = try optSelector(step, "selector") else {
                    throw GPError(code: .badParams, message: "requires field 'selector'")
                }
                selector = parsedSelector
                action = try requireAction(step)
            } catch let error as GPError {
                // Re-wrap with the step index for a debuggable message.
                throw GPError(code: .badParams, message: "steps[\(index)]: \(error.message)")
            }
            steps.append((selector, action))
        }
        return steps
    }
}
