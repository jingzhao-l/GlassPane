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
        case .shutdown:
            return core.shutdown()
        }
    }

    private func handleAttach(_ params: [String: Any]) throws -> [String: Any] {
        let bundleId = try ParamValidation.optString(params, "bundleId", maxLength: 512)
        let pid = try ParamValidation.optInt(params, "pid")
        guard (bundleId == nil) != (pid == nil) else {
            throw GPError(code: .badParams, message: "exactly one of bundleId or pid is required")
        }
        return try core.attach(bundleId: bundleId, pid: pid.map { pid_t($0) })
    }

    private func handleAct(_ params: [String: Any]) throws -> [String: Any] {
        let selector = try ParamValidation.requireSelector(params)
        let action = try ParamValidation.requireAction(params)
        return try core.act(selector: selector, action: action)
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
        let operationId = try ParamValidation.optString(params, "operationId", maxLength: 64)
        return try core.diagnose(operationId: operationId)
    }

    private func handleLastEvidence(_ params: [String: Any]) throws -> [String: Any] {
        let operationId = try ParamValidation.optString(params, "operationId", maxLength: 64)
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
        let mode = try ParamValidation.optString(params, "mode", maxLength: 32)
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
        return encode(frame)
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
        return encode(frame)
    }

    private func encode(_ frame: [String: Any]) -> Data {
        guard let data = try? JSONSerialization.data(
            withJSONObject: frame,
            options: [.sortedKeys, .withoutEscapingSlashes]
        ) else {
            // Result objects are built from JSON-serializable values only;
            // if serialization still fails, answer with a structured internal
            // error rather than dropping the response.
            let fallback: [String: Any] = [
                "id": NSNull(),
                "error": [
                    "code": GPErrorCode.internalError.rawValue,
                    "message": "response serialization failed; reduce observe maxDepth",
                    "remedy": GPError.remedy(for: .internalError)
                ]
            ]
            let fallbackData = (try? JSONSerialization.data(
                withJSONObject: fallback,
                options: [.sortedKeys, .withoutEscapingSlashes]
            )) ?? Data("{\"id\":null,\"error\":{\"code\":\"GP_E_INTERNAL\"}}".utf8)
            return fallbackData + Data([0x0A])
        }
        return data + Data([0x0A])
    }
}
