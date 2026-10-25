import Foundation

// MARK: - Recipe Loader (P1 spec v1.4 §2)

/// Result of validating a recipe configuration file.
public struct RecipeValidationResult: Codable, Equatable {
    public let valid: Bool
    public let errors: [String]
    public let recipeName: String?
    /// 校验层**如实说出、但不参与 `valid` 判定**的话（E2）。
    ///
    /// 为什么不进 `errors`：`errors` 非空即 `valid == false`，而 `--recipe-validate`
    /// 按它退出码（`main.swift` 的 `exit(result.valid ? 0 : 1)`）。把"这一构建没有
    /// 执行器"写成 error，等于把一份契约合法的文件判成非法——那是本文件在 R4-02
    /// 之后一直拒绝的"两个校验器接受不相交的语言"。写成 notes 之后，读者拿到的是
    /// 两条各自成立的事实：形状与 params 都对着方法表核过 ✅；"跑一遍"这件事
    /// 当前构建里没有任何一条命令做得到 ⚠️。
    /// 这个键是引擎侧给面板/CLI 的**指得着真事**的字段（另一条泳道改的是文案，
    /// 不是这里的判据）；`--recipe-validate` 编码的是整个结构体，所以这一句
    /// 不用改 `main.swift` 就已经在那条输出里了。
    public let notes: [String]

    public init(
        valid: Bool,
        errors: [String],
        recipeName: String?,
        notes: [String] = []
    ) {
        self.valid = valid
        self.errors = errors
        self.recipeName = recipeName
        self.notes = notes
    }
}

/// Structural recipe validator for the engine, mirroring the **frozen kernel
/// contract** for recipe files: `kernel/schemas/recipe-config.schema.json` and
/// its zod twin (the published `iterate-kernel/recipe-config`).
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
///
/// Two answers, kept apart on purpose (E2):
/// - **`errors`** — the contract's own rules (shape, the version literal, the
///   name cap in code points, `strictObject` keys) *plus* the rule that a step's
///   `params` keys must be keys the named method actually reads. That half is not
///   in the JSON Schema; it is derived from `Dispatcher.acceptedParamKeys`, the
///   same table the live `requireOnlyReadParamKeys` gate uses, so a recipe whose
///   steps the daemon would refuse with `GP_E_BAD_PARAMS` cannot be called valid
///   here. A non-empty `errors` means `valid == false`.
/// - **`notes`** — facts that are true of every file this validator judges and
///   must not change the verdict: this build has no recipe executor, and the
///   file's `assert` is the wire's `assert_element`. Putting those in `errors`
///   would reject files the frozen contract accepts, which is the split R4-02
///   exists to remove.
public struct RecipeLoader {

    /// The contract's version literal, in one place so the rule and the error
    /// text cannot disagree about what is required.
    public static let schemaVersion = "glasspane.recipe/0.1-draft"
    /// `name` length cap (kernel `RECIPE_NAME_MAX_LENGTH`), in **Unicode code
    /// points**.
    ///
    /// The unit is the rule, not a detail: `recipe-config.schema.json` states the
    /// cap as `"maxLength": 256`, and the validator the kernel suite runs that
    /// schema through (ajv 8, `runtime/ucs2length.js`) counts code points — it
    /// walks UTF-16 and folds each high/low surrogate pair into one. This type
    /// compared `String.count`, which counts **grapheme clusters**, so outside
    /// ASCII it agreed with neither contract side.
    ///
    /// Aligning with the schema does **not** align with the zod twin, and that is
    /// the honest limit of this fix: `iterate-kernel/recipe-config` reaches 256
    /// through `z.string().max(256)`, and JavaScript's `.length` counts **UTF-16
    /// code units**. For every BMP character — precomposed or decomposed accents,
    /// CJK, Cyrillic — one code point is one unit, so the two contract sides agree
    /// and this matches both. For each *astral* character (emoji, rare
    /// ideographs) zod counts 2 where the schema counts 1, so a name of 256
    /// U+1F600 is 256 code points for the schema and here, but 512 units for zod:
    /// accepted on one side, rejected on the other. No unit choice removes that
    /// disagreement — it is the same set of astral strings whichever side this
    /// mirrors — and mirroring zod would have meant diverging from the frozen
    /// schema, which is the cross-language truth surface and a protected path.
    /// What the grapheme count could not claim is any agreement at all outside
    /// ASCII, which is why the schema wins.
    /// Pinned, in both directions, by
    /// `testNonAsciiNameBoundaryIsCountedInCodePoints` and
    /// `testAstralNameFollowsTheSchemaAndStillDivergesFromZod`.
    public static let nameMaxLength = 256
    /// Kernel `RECIPE_MIN_STEPS`.
    public static let minSteps = 1
    /// Kernel `RECIPE_MAX_STEPS`.
    public static let maxSteps = 64
    /// The step kinds the contract allows (kernel `RecipeStepKindSchema`).
    public static let stepKinds: [String] = ["act", "observe", "assert", "diagnose"]

    /// 配方词汇表 → **线上方法**。这两个词汇表是分开的两份东西，不是同一份的两个写法：
    /// `kernel/schemas/recipe-config.schema.json:27` 的 enum 钉的是 `assert`，而
    /// `EngineMethod` 的线名是 `assert_element`（`FrameCodec.swift:75`）。所以这条映射
    /// 必须存在，且必须由 `EngineMethod` 承接而不是由字符串承接——写成 `method.rawValue`
    /// 的话，一份"合法"配方里的 `assert` 会在任何读者那里变成一个不存在的方法名。
    /// 表里没有 `hello`/`shutdown`/`capture_view` 等，因为契约的 enum 里没有它们。
    static let stepKindMethods: [String: EngineMethod] = [
        "act": .act,
        "observe": .observe,
        "assert": .assertElement,
        "diagnose": .diagnose,
    ]

    /// E2：一条**本构建没有执行器**的实话，随每次校验结果一起交出去。
    ///
    /// 判据是读出来的，不是推测的：`Dispatcher.dispatch` 的 13 个 case 里没有一条走
    /// "配方"，`EngineMethod` 的线名表里也没有 `run_recipe`/`recipe_*`；`recipeConfigPath`
    /// 在 `ProjectEntry` 里是一个**存着的路径**，引擎侧唯一的读者是这份校验器自己
    /// （`--recipe-validate`）。所以"每一步的 params 都对得上方法真读的键集"这件事
    /// 是可达的静态结论，而"把这四步跑一遍"在当前构建里没有任何一条命令做得到。
    /// 校验输出从前只回 `valid`，读的人（面板、agent）据此以为"合法=可执行"。
    public static let executionNote = "shape and per-step params are checked against the method table this build dispatches; no recipe executor exists in this build (no `EngineMethod` runs a recipe, and `Dispatcher.dispatch` has no recipe case), so a valid recipe is a **contract-valid configuration**, not an executed run"

    /// How much of a caller-supplied value an error message may echo, in **code
    /// points** (the unit `nameMaxLength` counts, for the same reason: the grapheme
    /// count under-reads exactly where the text stops being ASCII).
    ///
    /// The bytes being validated come from a cloned repository, and
    /// `--recipe-validate` prints these strings to an agent, so an unbounded echo
    /// turns one 4 KiB key into 4 KiB of terminal — and into the log line of
    /// whoever read the tool call.
    public static let errorEchoMaxLength = 120

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
            errors.append("unknown top-level key '\(capped(key))' (the contract allows only \(configKeys.joined(separator: ", ")))")
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
            errors.append("'schemaVersion' is \"\(capped(value))\"; the contract requires exactly \"\(schemaVersion)\"")
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
            // `unicodeScalars.count`, not `String.count`: the cap's unit is code
            // points (see `nameMaxLength`). The grapheme count under-read exactly
            // where names get non-ASCII — ("e" + U+0301) × 129 is 129 clusters but
            // 258 code points — so the engine passed a file the frozen schema
            // rejects, which is the one-recipe-two-verdicts defect. The message
            // names the unit it enforced, since "258" is not the number of
            // anything a reader would eyeball in that string.
            // Other length caps in this target measure a **different** unit, and
            // that is a decision rather than an accident: `ParamValidation.length`
            // counts UTF-16 units and `EvidenceModels` measures `summary` in
            // UTF-16 units, because the contract those two read is the published
            // validator's (`z.string().max(...)` answers in code units). This file
            // counts code points because the contract it mirrors is the frozen
            // schema's `maxLength` (see `nameMaxLength` above, and
            // `testAstralNameFollowsTheSchemaAndStillDivergesFromZod`, which pins
            // the divergence on both sides so nobody discovers it as a surprise).
            let codePoints = value.unicodeScalars.count
            if codePoints > nameMaxLength {
                errors.append("'name' is \(codePoints) characters (Unicode code points); maximum is \(nameMaxLength)")
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
            recipeName: root["name"] as? String,
            notes: [RecipeLoader.executionNote, RecipeLoader.vocabularyNote]
        )
    }

    /// 两条词汇表事实，随结果一起交出去（E2 的"更实的那一半"要说得出名字）。
    /// 判据是读出来的：`stepKinds` 里的 `assert` 对着 `EngineMethod.assertElement`
    /// 的线名 `assert_element`，所以任何把 `kind` 当线名转发的读者都会指向一个
    /// 不存在的方法；这份映射由 `stepKindMethods` 承担，不由字符串承担。
    public static let vocabularyNote = "recipe step kinds are the frozen contract's vocabulary, not the wire's: `assert` is the file's name for the method the daemon answers as `assert_element` (EngineMethod.assertElement). Mapping is in RecipeLoader.stepKindMethods; do not forward a step `kind` as a `method`"

    private static func validateStep(_ step: Any, at index: Int, into errors: inout [String]) {
        guard let stepDict = step as? [String: Any] else {
            errors.append("'steps[\(index)]' must be an object, got \(describe(step))")
            return
        }
        for key in stepDict.keys.sorted() where !stepKeys.contains(key) {
            errors.append("'steps[\(index)]' has unknown key '\(capped(key))' (the contract allows only \(stepKeys.joined(separator: ", ")); selector and action belong inside 'params')")
        }
        switch stepDict["kind"] {
        case .none:
            errors.append("'steps[\(index)].kind' is required (one of \(stepKinds.joined(separator: ", ")))")
        case let value as String where stepKinds.contains(value):
            break
        case let value as String:
            errors.append("'steps[\(index)].kind' is \"\(capped(value))\"; the contract allows \(stepKinds.joined(separator: ", "))")
        case let value:
            errors.append("'steps[\(index)].kind' must be a string, got \(describe(value))")
        }
        if stepDict["params"] == nil {
            errors.append("'steps[\(index)].params' is required (an object)")
        } else if !(stepDict["params"] is [String: Any]) {
            errors.append("'steps[\(index)].params' must be an object, got \(describe(stepDict["params"]))")
        } else if let kind = stepDict["kind"] as? String,
                  let method = Self.stepKindMethods[kind],
                  let params = stepDict["params"] as? [String: Any] {
            // E2：形状之外，判一步 params 与**这个方法真读的键集**是否相符。
            // 接受集不是这里抄的：`Dispatcher.acceptedParamKeys` 就是那个 target 里
            // 逐 handler 反查出来的真源（`Dispatcher.swift:101-129`），同一模块、同一个
            // 编译单元，所以这条规则跟线上白名单不可能各自漂移。
            //
            // 缺陷形状（面板内置模板实测给的正是这一份）：`observe` 的 params 是
            // `{"selector":{role,title}}`，而 `observe` 只读 `maxDepth`/`role`
            // （`Dispatcher.swift:164-171`）——线上会把这一帧拒成 GP_E_BAD_PARAMS
            // （`requireOnlyReadParamKeys`），也就是说这份"契约合法"的配方按任何方法
            // 都跑不起来。校验层只判形状，就等于把一次必然的拒绝推到运行期。
            //
            // 只判**多出来**的键，不判缺失的必填键：后者要靠每个 handler 的
            // require/opt 规则，那是十份判据的副本，而这条缺陷关于的是被吞掉的那一半。
            let accepted = Dispatcher.acceptedParamKeys[method] ?? []
            for key in params.keys.sorted() where !accepted.contains(key) {
                errors.append(
                    "'steps[\(index)].params' has key '\(capped(key))' that `\(method.rawValue)` does not read; that method reads only \(accepted.isEmpty ? "no params keys at all" : accepted.sorted().joined(separator: ", ")) — the recipe passes the file contract but the engine would refuse this step with GP_E_BAD_PARAMS before it ran"
                )
            }
        }
    }

    /// A caller-supplied value quoted into an error message, capped at
    /// `errorEchoMaxLength` code points with the truncation said out loud — a
    /// clipped value that looks complete is the same dishonesty in a smaller
    /// font, and the reader has to be able to tell the two apart.
    private static func capped(_ value: String) -> String {
        let codePoints = value.unicodeScalars.count
        guard codePoints > errorEchoMaxLength else { return value }
        // Truncating by *scalar* is the point: a code-unit cut can leave half an
        // astral character in the message, a scalar cut never can.
        let kept = String(String.UnicodeScalarView(value.unicodeScalars.prefix(errorEchoMaxLength)))
        return kept + "… (\(codePoints) code points total, first \(kept.unicodeScalars.count) shown)"
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
