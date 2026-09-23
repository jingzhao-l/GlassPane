import Foundation

// MARK: - Recipe Loader (P1 spec v1.4 §2)

/// Result of validating a recipe configuration file.
public struct RecipeValidationResult: Codable, Equatable {
    public let valid: Bool
    public let errors: [String]
    public let recipeName: String?
}

/// Structural recipe validator for the engine, mirroring the **frozen kernel
/// contract** for recipe files: `kernel/schemas/recipe-config.schema.json` and
/// its zod twin `kernel/src/recipe-config.ts`.
///
/// Why it mirrors instead of defining its own rules (R4-02 / R6-01): this type
/// used to require an *integer* `schemaVersion ≥ 1` and steps shaped
/// `{selector, action}`, while the kernel contract — and `specs/…P0 §…:209`
/// and `specs/…P1 v1.4:58`, which says the daemon validates *through* the
/// kernel schema — both require the string const
/// `"glasspane.recipe/0.1-draft"` and steps `{kind, params}`. Two validators
/// that accept disjoint languages mean **no recipe file can pass both**: the
/// engine's own `--recipe-validate` rejected every file the contract calls
/// valid, and its tests were green because their literals were written from the
/// implementation instead of from the shared truth set. The unit now answers the
/// contract's question, and
/// `RecipeLoaderTests.testKernelFixtureIsTheTruthThisValidatesAgainst` feeds it
/// `kernel/fixtures/recipe-config.ok-01.json` — the same file the kernel and
/// MCP-shell suites check, so a drift on either side fails a test rather than
/// shipping.
///
/// Deliberately JSON-only, and it says so rather than implying more: the
/// contract is a JSON Schema, and nothing in this repository parses YAML
/// recipes (the CLI help used to claim "JSON/JSONL" and "YAML"; that text is
/// corrected alongside this comment).
public struct RecipeLoader {

    /// The contract's version literal, in one place so the rule and the error
    /// text cannot disagree about what is required.
    public static let schemaVersion = "glasspane.recipe/0.1-draft"
    /// `name` length cap (kernel `RECIPE_NAME_MAX_LENGTH`).
    public static let nameMaxLength = 256
    /// Kernel `RECIPE_MIN_STEPS`.
    public static let minSteps = 1
    /// Kernel `RECIPE_MAX_STEPS`.
    public static let maxSteps = 64
    /// The step kinds the contract allows (kernel `RecipeStepKindSchema`).
    public static let stepKinds: [String] = ["act", "observe", "assert", "diagnose"]

    /// A step is exactly `{kind, params}` — the contract is `strictObject`, so
    /// an extra key is a violation, not a detail to ignore.
    public static let stepKeys: [String] = ["kind", "params"]
    /// Top-level keys the contract allows (also `strictObject`).
    public static let configKeys: [String] = ["schemaVersion", "name", "steps"]

    /// Validate recipe file contents against the contract.
    ///
    /// - Parameter data: the bytes of a `.json` recipe file.
    /// - Returns: `valid: true` only when every contract rule holds. Each
    ///   violation is one specific error string naming the key and what it saw;
    ///   nothing here is optional-output, because `--recipe-validate` prints
    ///   these verbatim to an agent that has to fix the file.
    public static func validate(_ data: Data) -> RecipeValidationResult {
        // 1. Parseable JSON…
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            return RecipeValidationResult(
                valid: false,
                errors: ["file is not valid JSON: \(error.localizedDescription)"],
                recipeName: nil
            )
        }
        // …and a JSON *object* at the top level. A top-level array or string is
        // a different mistake than malformed text, and reporting it as "not
        // valid JSON" sends whoever reads it to fix the wrong thing.
        guard let root = parsed as? [String: Any] else {
            return RecipeValidationResult(
                valid: false,
                errors: ["top level must be a JSON object, got \(describe(parsed))"],
                recipeName: nil
            )
        }

        var errors: [String] = []

        // 2. Unknown top-level keys (strictObject).
        for key in root.keys.sorted() where !configKeys.contains(key) {
            errors.append("unknown top-level key '\(key)' (the contract allows only \(configKeys.joined(separator: ", ")))")
        }

        // 3. schemaVersion: the contract's literal, and nothing else. A number
        //    gets its own message: "missing or non-integer" was the old rule,
        //    and it told someone holding `"1"` that the key was absent.
        switch root["schemaVersion"] {
        case .none:
            errors.append("'schemaVersion' is required (must be the string \"\(schemaVersion)\")")
        case let value as String where value == schemaVersion:
            break
        case let value as String:
            errors.append("'schemaVersion' is \"\(value)\"; the contract requires exactly \"\(schemaVersion)\"")
        case let value:
            errors.append("'schemaVersion' must be the string \"\(schemaVersion)\", got \(describe(value))")
        }

        // 4. name: required string, length-capped. The contract states no
        //    minimum, so an empty name is *valid* here on purpose: a daemon that
        //    invented a stricter rule would reject a file the frozen contract
        //    accepts, which is the split being removed.
        switch root["name"] {
        case .none:
            errors.append("'name' is required (a string)")
        case let value as String:
            if value.count > nameMaxLength {
                errors.append("'name' is \(value.count) characters; maximum is \(nameMaxLength)")
            }
        case let value:
            errors.append("'name' must be a string, got \(describe(value))")
        }

        // 5. steps: 1…64 objects of exactly {kind ∈ enum, params: object}.
        if let stepsArray = root["steps"] as? [Any] {
            if stepsArray.isEmpty {
                errors.append("'steps' must contain at least \(minSteps) step")
            } else if stepsArray.count > maxSteps {
                errors.append("'steps' contains \(stepsArray.count) steps; maximum is \(maxSteps)")
            }
            if stepsArray.count <= maxSteps {
                for (index, step) in stepsArray.enumerated() {
                    validateStep(step, at: index, into: &errors)
                }
            }
        } else if root["steps"] != nil {
            errors.append("'steps' must be an array, got \(describe(root["steps"]))")
        } else {
            errors.append("'steps' is required (an array of 1…\(maxSteps) steps)")
        }

        return RecipeValidationResult(
            valid: errors.isEmpty,
            errors: errors,
            recipeName: root["name"] as? String
        )
    }

    private static func validateStep(_ step: Any, at index: Int, into errors: inout [String]) {
        guard let stepDict = step as? [String: Any] else {
            errors.append("'steps[\(index)]' must be an object, got \(describe(step))")
            return
        }
        for key in stepDict.keys.sorted() where !stepKeys.contains(key) {
            errors.append("'steps[\(index)]' has unknown key '\(key)' (the contract allows only \(stepKeys.joined(separator: ", ")); selector and action belong inside 'params')")
        }
        switch stepDict["kind"] {
        case .none:
            errors.append("'steps[\(index)].kind' is required (one of \(stepKinds.joined(separator: ", ")))")
        case let value as String where stepKinds.contains(value):
            break
        case let value as String:
            errors.append("'steps[\(index)].kind' is \"\(value)\"; the contract allows \(stepKinds.joined(separator: ", "))")
        case let value:
            errors.append("'steps[\(index)].kind' must be a string, got \(describe(value))")
        }
        if stepDict["params"] == nil {
            errors.append("'steps[\(index)].params' is required (an object)")
        } else if !(stepDict["params"] is [String: Any]) {
            errors.append("'steps[\(index)].params' must be an object, got \(describe(stepDict["params"]))")
        }
    }

    /// A value's JSON shape, for error text that cannot be guessed.
    ///
    /// `JSONSerialization` hands back `NSNumber` for numbers *and* booleans, and
    /// Swift's `is Bool` answers `true` for a plain numeric one — so the boolean
    /// test has to go through the CoreFoundation type ID, otherwise
    /// `"schemaVersion": 1` is reported as "got a boolean" and the reader
    /// goes looking for a checkbox.
    private static func describe(_ value: Any?) -> String {
        switch value {
        case .none: return "null"
        case is NSNull: return "null"
        case is String: return "a string"
        case is [Any]: return "an array"
        case is [String: Any]: return "an object"
        case let number as NSNumber:
            return CFGetTypeID(number) == CFBooleanGetTypeID() ? "a boolean" : "a number"
        default: return String(describing: type(of: value as Any))
        }
    }
}
