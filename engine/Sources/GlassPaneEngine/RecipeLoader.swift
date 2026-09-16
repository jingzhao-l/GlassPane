import Foundation

// MARK: - Recipe Loader (P1 spec v1.4 §2)

/// Result of validating a recipe configuration file.
public struct RecipeValidationResult: Codable, Equatable {
    public let valid: Bool
    public let errors: [String]
    public let recipeName: String?
}

/// Structural recipe-file validator for the engine (P1 spec v1.4 §2.1–§2.2).
///
/// Full ajv schema validation lives in `kernel/recipe-config.schema.json`
/// and runs at the MCP/CI layer (spec §8.2 — the daemon does not embed ajv).
/// This validator checks the essential structural constraints required
/// for a recipe to be usable at daemon startup and for onboarding.
public struct RecipeLoader {

    /// Minimum valid schemaVersion in the recipe file.
    public static let minSchemaVersion = 1
    /// Maximum number of steps in a recipe.
    public static let maxSteps = 64

    /// Validate a recipe JSON/JSONL file and return a structured result.
    ///
    /// - Parameter data: Contents of a `.json` or `.yaml` file (JSON format
    ///   is the primary contract; YAML support is delegated to kernel/mcp-shell).
    /// - Returns: `RecipeValidationResult` with `valid: true` iff the file
    ///   passes all structural checks.
    public static func validate(_ data: Data) -> RecipeValidationResult {
        // 1. Must be parseable JSON.
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return RecipeValidationResult(valid: false, errors: ["file is not valid JSON"], recipeName: nil)
        }

        var errors: [String] = []

        // 2. schemaVersion: required, integer ≥ 1.
        let schemaVersion = root["schemaVersion"]
        let rawVersion = schemaVersion as? Int
        if rawVersion == nil {
            errors.append("missing or non-integer 'schemaVersion'")
        } else if rawVersion! < minSchemaVersion {
            errors.append("'schemaVersion' \(schemaVersion!) is below minimum \(minSchemaVersion)")
        }

        // 3. name: required, non-empty string.
        let name = root["name"] as? String
        if name == nil || (name?.isEmpty ?? true) {
            errors.append("missing or empty 'name'")
        }

        // 4. steps: required array with 1..maxSteps items.
        if let stepsArray = root["steps"] as? [Any] {
            if stepsArray.isEmpty {
                errors.append("'steps' must contain at least 1 step")
            } else if stepsArray.count > maxSteps {
                errors.append("'steps' contains \(stepsArray.count) steps; maximum is \(maxSteps)")
            } else {
                // Validate each step has required fields.
                for (i, step) in stepsArray.enumerated() {
                    guard let stepDict = step as? [String: Any] else {
                        errors.append("'steps[\(i)]' is not an object")
                        continue
                    }
                    if stepDict["selector"] == nil {
                        errors.append("'steps[\(i)].selector' is required")
                    }
                    if stepDict["action"] == nil {
                        errors.append("'steps[\(i)].action' is required")
                    }
                }
            }
        } else if root["steps"] != nil {
            errors.append("'steps' must be an array")
        } else {
            errors.append("'steps' is required")
        }

        return RecipeValidationResult(
            valid: errors.isEmpty,
            errors: errors,
            recipeName: name
        )
    }
}
