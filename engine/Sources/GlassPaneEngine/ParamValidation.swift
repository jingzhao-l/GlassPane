import Foundation

/// Per-method parameter validation (P0 spec §3.3/§3.5). Every violation maps
/// to GP_E_BAD_PARAMS with a message naming the offending field.
enum ParamValidation {

    static let selectorMaxLength = 512
    /// `expected` is persisted verbatim into every evidence pack and re-emitted
    /// by exports, so it carries the same cap as the selector fields and the
    /// shell's `ExpectSchema` — length-only checks were the gap (P0 §3.3).
    static let expectedMaxLength = 512
    /// The unit every cap above counts in: UTF-16 code units.
    ///
    /// `String.count` counts *grapheme clusters*, and the contract on both other
    /// sides counts units: `mcp-shell/src/tools.ts:95,124` (`z.string().max(512)`)
    /// and `kernel/schemas/evidence-pack.schema.json` `$defs.selector.maxLength`
    /// (JSON Schema defines `maxLength` as the number of UTF-16 code units, and
    /// the kernel's validator is ajv with `unicode: false`, i.e. the default).
    /// Counting clusters let the daemon admit a 512-grapheme combining sequence
    /// (1024 units) that the shell refuses and the frozen schema refuses —
    /// one contract, three answers, with the daemon's the loosest.
    /// `RecipeLoader.capped` truncates by *scalar* for the same reason: the unit
    /// a length check uses has to be the unit the reader counts.
    static func length(_ value: String) -> Int { value.utf16.count }
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
    /// Crockford base32 body shared by op_/snap_ ids (§1.2 / P0 §4.1), built from
    /// `OperationID` — the only generator of these ids — so an alphabet or length
    /// change there cannot leave this pattern describing the old one. The same
    /// literal is still spelled by hand in `EvidenceModels.swift`
    /// (`operationIdRegex`, `entryIdRegex`) and in `mcp-shell/src/tools.ts`;
    /// neither file is reachable from this one, so both are reported rather than
    /// edited here.
    private static let idBodyPattern =
        "[\(String(OperationID.crockfordAlphabet))]{\(OperationID.totalLength)}"
    static let snapshotIdPattern = "^" + OperationID.snapshotPrefix + idBodyPattern + "$"
    static let operationIdPattern = "^" + OperationID.prefix + idBodyPattern + "$"
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
        if let maxLength, Self.length(string) > maxLength {
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
        if Self.length(role) > selectorMaxLength {
            throw GPError(code: .badParams, message: "field 'selector.role' exceeds \(selectorMaxLength) characters")
        }
        // 显式给出的 `title` 不许为空。判据的出处是发布出去的契约本身：
        // `kernel/schemas/evidence-pack.schema.json` 的 `$defs.selector.title` 写了
        // `minLength: 1`，而 daemon 是那份 schema 声明的最后判决层——"schema 说拒、
        // 执行它的层收"就是"一份契约、两个判决"（gp_act 收下的空 title 会进证据包，
        // 那份包再被同一份 schema 判为非法）。
        //
        // 判据放在 `optSelector` 而不是 `optString` 里，是有意的：`optString` 是全
        // 模块共用的长度读取（`attach.bundleId`、`observe.role`、`restore.mode`……），
        // 给所有字段加空串禁令会一次性改掉十条命令的已接受输入，而这条缺陷只关于
        // selector 的 title。
        //
        // `identifier` 保持原样（长度判据而已）——这不是遗漏，是照着 schema 那句话做的：
        // `$defs.selector.identifier` 刻意没有 `minLength`，原文是 "Deliberately has no
        // minLength: no side rules on an empty identifier (the daemon has no guard for
        // it), so the kernel does not invent one."。要在这里加拒绝，就得同时改 kernel
        // 的 schema 与 zod（不是本次修复的层，也不是我的文件所有权），那才是把一处
        // 未测量的规则塞进代码。`mcp-shell/test/tools.test.mjs` 也按"空 identifier
        // 仍然转发" Behavioral 地钉着这一条。
        if let presentTitle = dict["title"] as? String, presentTitle.isEmpty {
            throw GPError(
                code: .badParams,
                message: "field 'selector.title' must be a non-empty string when present"
            )
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
            guard Self.length(string) <= expectedMaxLength else {
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

    // MARK: - Per-method params whitelist (P0 §3.3)

    /// 调用方给的键名回显进拒绝文本时的封顶。判据与 `RecipeLoader.errorEchoMaxLength`
    /// 同一条：一句错误里的 4 KiB 键名会变成读者终端上的一屏，而这一整句还要进
    /// `Dispatcher.encode` 的那一帧——超限兜底路径是为真正的大答复准备的，不该靠它。
    static let paramEchoMaxLength = 120

    /// 拒绝这个方法**不读**的每一个 `params` 键。
    ///
    /// 缺陷形状：`optOperationId` 对**缺键**回 nil，`diagnose`/`last_evidence` 于是
    /// 回答"最近那一个操作"。把 `operationId` 拼成 `operationid` 的调用方拿到的是
    /// **另一个操作**的证据包与针对它的诊断，却挂在自己点名的那个 id 下面；拼错的
    /// `degrade`（busy 窗口照旧被拒）、`maxDepth`、`mode` 是同一类。一个表达意图的键
    /// 被静默忽略不是宽容，是替调用方回答了它没问的问题——本仓对同一个形状早就写过
    /// 判据（`RecipeLoader.stepKeys` 的 strictObject 拒绝），这里把它接到线上协议面。
    ///
    /// 接受集由调用方给（`Dispatcher.acceptedParamKeys`，那张表逐个 handler 反查自
    /// `Dispatcher.swift` 里真实发生的 `ParamValidation.*` 读取）。这个函数只管形状：
    /// 说出被拒的键，并说出这个方法读哪些键——读者不需要猜"是不是还有别的键也被吞了"。
    static func requireOnlyKnownKeys(
        _ params: [String: Any], accepted: [String], method: String
    ) throws {
        let rejected = params.keys.filter { !accepted.contains($0) }.sorted()
        guard !rejected.isEmpty else { return }
        let names = rejected.map { "'\(cappedParamKey($0))'" }.joined(separator: ", ")
        let reads = accepted.isEmpty
            ? "reads no `params` keys at all"
            : "reads only these `params` keys: \(accepted.sorted().joined(separator: ", "))"
        throw GPError(
            code: .badParams,
            message: "method '\(method)' does not read \(names); it \(reads)"
                + " — the frame was refused before its handler ran, so nothing this frame asked for happened",
            remedy: "spell the key exactly the way this method reads it (the list is case-sensitive: `operationId`, not `operationid`) and resend; do not simply drop the rejected key when it carried intent — an ignored `degrade`, `maxDepth` or `operationId` changes which answer the caller would have got, which is why the daemon refuses instead of ignoring"
        )
    }

    /// 键名按**标量**截断（`RecipeLoader.capped` 的同一条理由：按码元截会留下半个星外
    /// 字符），并且把截断本身说出来——一个看起来完整的截断值是同样的一句假话，只是字号小。
    static func cappedParamKey(_ key: String) -> String {
        let codePoints = key.unicodeScalars.count
        guard codePoints > paramEchoMaxLength else { return key }
        let kept = String(String.UnicodeScalarView(key.unicodeScalars.prefix(paramEchoMaxLength)))
        return kept + "… (\(codePoints) code points total, first \(kept.unicodeScalars.count) shown)"
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
