import Foundation

/// Dispatches parsed requests onto EngineCore and encodes response frames
/// (P0 spec §3.2/§3.2.1). Pure logic — unit-testable without a socket.
public final class Dispatcher {

    public let core: EngineCore
    private let log: EngineLog

    public init(core: EngineCore, log: EngineLog = EngineLog(quiet: true)) {
        self.core = core
        self.log = log
    }

    /// Handles one frame event; every event produces exactly one response
    /// line (frames with invalid JSON still get a GP_E_BAD_REQUEST answer).
    public func handle(_ event: FrameCodec.Event) -> Data {
        switch event {
        case .oversize:
            let error = GPError(
                code: .payloadTooLarge,
                message: "frame exceeds \(FrameCodec.maxFrameBytes) bytes"
            )
            return response(id: nil, error: error)
        case .frame(let data):
            return processFrame(data)
        }
    }

    private func processFrame(_ data: Data) -> Data {
        switch RequestParser.parse(data) {
        case .failure(let failure):
            return response(id: failure.id, error: failure.error)
        case .success(let request):
            do {
                let result = try dispatch(request)
                return response(id: request.id, result: result)
            } catch let error as GPError {
                return response(id: request.id, error: error)
            } catch {
                log.error("unhandled engine error: \(error)")
                let gpError = GPError(code: .internalError, message: "\(error)")
                return response(id: request.id, error: gpError)
            }
        }
    }

    private func dispatch(_ request: ParsedRequest) throws -> [String: Any] {
        switch request.method {
        case .hello:
            return core.hello()
        case .attach:
            return try handleAttach(request.params)
        case .act:
            return try handleAct(request.params)
        case .observe:
            return try handleObserve(request.params)
        case .assertElement:
            return try handleAssert(request.params)
        case .diagnose:
            return try handleDiagnose(request.params)
        case .lastEvidence:
            return try handleLastEvidence(request.params)
        case .snapshot:
            return try handleSnapshot(request.params)
        case .restore:
            return try handleRestore(request.params)
        case .probeStatus:
            return core.probeStatus()
        case .shutdown:
            return core.shutdown()
        }
    }

    private func handleAttach(_ params: [String: Any]) throws -> [String: Any] {
        let bundleId = try ParamValidation.optString(params, "bundleId", maxLength: 512)
        // Range-checked because `pid` is narrowed to `pid_t` (Int32) below:
        // an unbounded integral frame must answer GP_E_BAD_PARAMS, not trap.
        let pid = try ParamValidation.optInt(
            params,
            "pid",
            range: ParamValidation.pidLower...ParamValidation.pidUpper
        )
        guard (bundleId == nil) != (pid == nil) else {
            throw GPError(code: .badParams, message: "exactly one of bundleId or pid is required")
        }
        let projectId = try ParamValidation.optString(params, "projectId", maxLength: 64)
        return try core.attach(bundleId: bundleId, pid: pid.map { pid_t($0) }, projectId: projectId)
    }

    private func handleAct(_ params: [String: Any]) throws -> [String: Any] {
        let selector = try ParamValidation.requireSelector(params)
        let action = try ParamValidation.requireAction(params)
        // P6 §11: declared degradation — busy input admits the act with
        // weak + contaminated evidence instead of bouncing it to a human.
        let degrade = (try ParamValidation.optBool(params, "degrade")) ?? false
        return try core.act(selector: selector, action: action, degrade: degrade)
    }

    private func handleObserve(_ params: [String: Any]) throws -> [String: Any] {
        let maxDepth = try ParamValidation.optInt(
            params,
            "maxDepth",
            range: ParamValidation.observeMaxDepthLower...ParamValidation.observeMaxDepthUpper
        ) ?? EngineCore.defaultObserveDepth
        let role = try ParamValidation.optString(params, "role", maxLength: ParamValidation.selectorMaxLength)
        return try core.observe(maxDepth: maxDepth, role: role)
    }

    private func handleAssert(_ params: [String: Any]) throws -> [String: Any] {
        let selector = try ParamValidation.requireSelector(params)
        let property = try ParamValidation.requireProperty(params)
        let expected = try ParamValidation.requireExpected(params)
        return try core.assertElement(selector: selector, property: property, expected: expected)
    }

    private func handleDiagnose(_ params: [String: Any]) throws -> [String: Any] {
        let operationId = try ParamValidation.optOperationId(params)
        return try core.diagnose(operationId: operationId)
    }

    private func handleLastEvidence(_ params: [String: Any]) throws -> [String: Any] {
        // `operationId` keys an on-disk file name downstream, so it is
        // pattern-checked here rather than length-checked.
        let operationId = try ParamValidation.optOperationId(params)
        let pack = try core.lastEvidence(operationId: operationId)
        let data = try pack.jsonData()
        let object = try JSONSerialization.jsonObject(with: data)
        return ["evidencePack": object]
    }

    private func handleSnapshot(_ params: [String: Any]) throws -> [String: Any] {
        let maxDepth = try ParamValidation.optInt(
            params,
            "maxDepth",
            range: ParamValidation.observeMaxDepthLower...ParamValidation.observeMaxDepthUpper
        ) ?? EngineCore.defaultObserveDepth
        return try core.snapshot(maxDepth: maxDepth)
    }

    private func handleRestore(_ params: [String: Any]) throws -> [String: Any] {
        let snapshotId = try ParamValidation.requireSnapshotId(params)
        let steps = try ParamValidation.optSteps(params)
        // Closed set: `mode` is written verbatim into the hash-chained
        // approval ledger, so free text must never reach EngineCore.
        let mode = try ParamValidation.optRestoreMode(params)
        return try core.restore(snapshotId: snapshotId, steps: steps, mode: mode)
    }

    // MARK: - Response encoding

    private func response(id: Int64?, result: [String: Any]) -> Data {
        var frame: [String: Any] = ["result": result]
        if let id {
            frame["id"] = NSNumber(value: id)
        } else {
            frame["id"] = NSNull()
        }
        return encode(frame, id: id)
    }

    private func response(id: Int64?, error: GPError) -> Data {
        var frame: [String: Any] = [
            "error": [
                "code": error.code.rawValue,
                "message": error.message,
                "remedy": error.remedy
            ]
        ]
        if let id {
            frame["id"] = NSNumber(value: id)
        } else {
            frame["id"] = NSNull()
        }
        return encode(frame, id: id)
    }

    /// Serializes one outbound frame under the same 4 MiB cap the inbound
    /// codec enforces (P0 §3.1: the limit applies to both directions). An
    /// over-cap line would desynchronize the shell's reader, so the caller
    /// gets the spec'd structured error instead — carrying the real request
    /// id, so the answer still matches the pending call.
    private func encode(_ frame: [String: Any], id: Int64?) -> Data {
        guard let data = try? JSONSerialization.data(
            withJSONObject: frame,
            options: [.sortedKeys, .withoutEscapingSlashes]
        ) else {
            // Result objects are built from JSON-serializable values only;
            // if serialization still fails, answer with a structured internal
            // error rather than dropping the response.
            return structuredError(
                id: id,
                code: .internalError,
                message: "response serialization failed; "
                    + "reduce observe maxDepth (\(ParamValidation.observeMaxDepthLower)–\(ParamValidation.observeMaxDepthUpper)) and retry"
            )
        }
        guard data.count + 1 <= FrameCodec.maxFrameBytes else {
            return structuredError(
                id: id,
                code: .payloadTooLarge,
                message: "response of \(data.count) bytes exceeds \(FrameCodec.maxFrameBytes) byte frame cap; "
                    + "reduce observe maxDepth (\(ParamValidation.observeMaxDepthLower)–\(ParamValidation.observeMaxDepthUpper)) or narrow the selector scope"
            )
        }
        return data + Data([0x0A])
    }

    /// Builds a small always-serializable error frame for the two cases where
    /// the caller's payload cannot be used. The text is engine-authored and
    /// bounded, so this path can neither overflow the cap nor recurse.
    private func structuredError(id: Int64?, code: GPErrorCode, message: String) -> Data {
        var frame: [String: Any] = [
            "error": [
                "code": code.rawValue,
                "message": message,
                "remedy": GPError.remedy(for: code)
            ]
        ]
        if let id {
            frame["id"] = NSNumber(value: id)
        } else {
            frame["id"] = NSNull()
        }
        let data = (try? JSONSerialization.data(
            withJSONObject: frame,
            options: [.sortedKeys, .withoutEscapingSlashes]
        )) ?? Data("{\"id\":null,\"error\":{\"code\":\"GP_E_INTERNAL\"}}".utf8)
        return data + Data([0x0A])
    }
}
