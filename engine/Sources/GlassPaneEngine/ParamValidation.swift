import Foundation

/// Per-method parameter validation (P0 spec §3.3/§3.5). Every violation maps
/// to GP_E_BAD_PARAMS with a message naming the offending field.
enum ParamValidation {

    static let selectorMaxLength = 512
    static let observeMaxDepthLower = 1
    static let observeMaxDepthUpper = 10

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
            return .string(string)
        }
        throw GPError(code: .badParams, message: "field 'expected' must be a string or boolean")
    }

    static func isBoolean(_ value: Any) -> Bool {
        CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID()
    }
}
