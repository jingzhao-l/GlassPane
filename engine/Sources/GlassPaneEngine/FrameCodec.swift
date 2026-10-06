import Foundation

/// Newline-delimited JSON framing with the 4 MiB single-frame cap
/// (P0 spec §3.1). Pure value type — unit-testable without a socket.
public struct FrameCodec {

    public static let maxFrameBytes = 4 * 1024 * 1024

    private var buffer = Data()
    private var discardUntilNewline = false

    public enum Event: Equatable {
        /// A complete frame (payload without the trailing newline).
        case frame(Data)
        /// A line exceeded the cap; the line is discarded, the connection
        /// stays open (caller answers GP_E_PAYLOAD_TOO_LARGE).
        case oversize
    }

    public init() {}

    public mutating func append(_ data: Data) -> [Event] {
        var events: [Event] = []
        for byte in data {
            if discardUntilNewline {
                if byte == UInt8(ascii: "\n") {
                    events.append(.oversize)
                    discardUntilNewline = false
                }
                continue
            }
            if byte == UInt8(ascii: "\n") {
                events.append(.frame(buffer))
                buffer.removeAll(keepingCapacity: true)
            } else {
                buffer.append(byte)
                if buffer.count > Self.maxFrameBytes {
                    // Oversize: drop the buffered bytes and wait for EOL.
                    buffer.removeAll(keepingCapacity: false)
                    discardUntilNewline = true
                }
            }
        }
        return events
    }

    /// Bytes still waiting for a newline (diagnostics only).
    public var pendingBytes: Int {
        buffer.count
    }

    /// 超长帧正在丢弃中：buffer 已被清空，但对端还停在**同一行**里没写换行。
    public var isDiscardingOversizeFrame: Bool {
        discardUntilNewline
    }

    /// "这一行还没完"的唯一判据。`pendingBytes > 0` 判断不了它：丢弃超长帧时
    /// buffer 被清零，而 4 MiB 之后的每个字节都还在同一行里。真机上这不只是诊断
    /// 口径——daemon 一次只服务一个客户端，写满 4 MiB 就停手的对端会把读环永久
    /// 卡在 read() 上，其余客户端全被锁在门外（B-12）。
    public var awaitsNewline: Bool {
        !buffer.isEmpty || discardUntilNewline
    }
}

/// One parsed request frame (P0 spec §3.2).
public struct ParsedRequest {
    public let id: Int64
    public let method: EngineMethod
    public let params: [String: Any]
}

public enum EngineMethod: String, CaseIterable {
    case hello, attach, act, observe
    case assertElement = "assert_element"
    case diagnose, lastEvidence = "last_evidence"
    case snapshot, restore
    case auditUI = "audit_ui" // 界面可操作性审计（几何 + 确定性规则）
    case captureView = "capture_view" // 一次性视觉审查通道（PNG 到调用方，引擎不落盘）
    case probeStatus = "probe_status" // P6 spec v6.0 §5.4
    case shutdown
}

extension EngineMethod {

    /// `hello` 的 `capabilities` 清单＝本表去掉两个纯传输方法（`hello` 是承载清单的
    /// 握手本身，`shutdown` 是运维动作而非代理可使的能力）。这里从前是 EngineCore
    /// 手抄的字面量，已与真源漂移（报了线上不存在的 `probe`，漏掉 attach/
    /// last_evidence/probe_status）且没有读者会报错——所以清单只能派生，不许再手抄。
    public static let capabilityMethods: [EngineMethod] = allCases.filter {
        $0 != .hello && $0 != .shutdown
    }

    /// 对外协商的线名（与 `RequestParser` 接受的 `method` 字段同一拼写）。
    public static var capabilityWireNames: [String] {
        capabilityMethods.map(\.rawValue)
    }
}

/// A request frame that could not be parsed into a valid request. `id` is
/// the request id when one was recoverable, else nil.
public struct ParseFailure: Error {
    public let id: Int64?
    public let error: GPError

    public init(id: Int64?, error: GPError) {
        self.id = id
        self.error = error
    }
}

public enum RequestParser {

    /// Parses a single frame payload into a request. Every failure maps to a
    /// GPError so the dispatcher can always answer with a structured frame.
    public static func parse(_ data: Data) -> Result<ParsedRequest, ParseFailure> {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data, options: [])
        } catch {
            return .failure(ParseFailure(
                id: nil,
                error: GPError(code: .badRequest, message: "frame is not valid JSON: \(error.localizedDescription)")
            ))
        }
        guard let dict = object as? [String: Any] else {
            return .failure(ParseFailure(
                id: nil,
                error: GPError(code: .badRequest, message: "frame must be a JSON object")
            ))
        }

        guard let rawId = dict["id"], let idNumber = rawId as? NSNumber,
              !isBoolean(rawId), idNumber.isIntegerType,
              let id = idNumber.int64ValueExact, id >= 0 else {
            return .failure(ParseFailure(
                id: nil,
                error: GPError(code: .badRequest, message: "id must be an integer >= 0")
            ))
        }

        guard let rawMethod = dict["method"] as? String,
              let method = EngineMethod(rawValue: rawMethod) else {
            return .failure(ParseFailure(
                id: id,
                error: GPError(code: .methodNotFound, message: "method '\(String(describing: dict["method"]))' is not in the whitelist")
            ))
        }

        let params: [String: Any]
        if let rawParams = dict["params"] {
            guard let paramsDict = rawParams as? [String: Any] else {
                return .failure(ParseFailure(
                    id: id,
                    error: GPError(code: .badParams, message: "params must be a JSON object")
                ))
            }
            params = paramsDict
        } else {
            params = [:]
        }

        return .success(ParsedRequest(id: id, method: method, params: params))
    }

    private static func isBoolean(_ value: Any) -> Bool {
        CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID()
    }
}

extension NSNumber {
    /// True when the boxed value came from a JSON integer token (i.e. not a
    /// float-typed number like `3.0`).
    var isIntegerType: Bool {
        !CFNumberIsFloatType(self)
    }

    /// Int64 value if the number is integral; nil otherwise.
    var int64ValueExact: Int64? {
        if CFNumberIsFloatType(self) {
            let double = doubleValue
            guard double.rounded() == double, abs(double) < 9.0e18 else { return nil }
            return Int64(double)
        }
        return int64Value
    }
}
