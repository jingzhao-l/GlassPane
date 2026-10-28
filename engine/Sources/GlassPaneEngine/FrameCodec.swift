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

    /// `allCases` 减去 `capabilityMethods` 的那两个线名，同样**从表里算**（E1：错误
    /// 句子里不许出现手抄的清单）。判据是 `capabilityMethods` 自己的过滤条件，所以
    /// 这一族永远是两个、也永远不可能是"抄下来的一份表"。
    /// `EngineCore.hello()` 发布的是上面那一份，不是这一份。
    public static var unadvertisedMethodWireNames: [String] {
        allCases.filter { !capabilityMethods.contains($0) }.map(\.rawValue)
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

    /// 调用方送来的 `method` 该怎么写进那句拒绝。
    ///
    /// 两件事在这一支上都要成立，而 `String(describing: dict["method"])` 两件都不做：
    /// ① 报的是**调用方送的东西**，不是 Swift 的表示法——实测它会写出
    ///    `method 'Optional(obsserve)'`，那个壳是本进程的内存模型，读的人只会照着它去找
    ///    一个叫 `Optional(obsserve)` 的方法；② 原样回显一个调用方可控的、最长到整帧上限
    ///    （4 MiB）的值，是把日志与线格式交给对方决定——本仓对"未知参数名"早有
    ///    `ParamValidation.cappedParamKey` 这一条，两个未知面不许两套口径。
    /// 短的原样报（那是一个人说得出、能照着改的名字），超上限的按"总量 + 前缀"报，
    /// 截断要标明，不许悄悄剪。
    static func callerMethodDescription(_ raw: Any?) -> String {
        guard let raw else { return "<absent>" }
        if raw is NSNull { return "null" }
        if let string = raw as? String { return ParamValidation.cappedParamKey(string) }
        if let number = raw as? NSNumber { return ParamValidation.cappedParamKey(number.stringValue) }
        if let array = raw as? [Any] { return "<array of \(array.count)>" }
        if let object = raw as? [String: Any] { return "<object of \(object.count) keys>" }
        return ParamValidation.cappedParamKey("\(raw)")
    }

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
                // 句子必须自己指到真源：从前只说 "is not in the whitelist"，既不点名是
                // 哪份清单，也不给下一步，而 `hello.capabilities` 里就是这张表（同文件的
                // `capabilityWireNames`，由 `EngineMethod` 派生，不手抄）。
                //
                // E1：那句 "the methods it does answer are <capabilityWireNames>" 说的
                // 是**代理能力清单**，而它挨着的 `Dispatcher.dispatch` 实际会执行 13 个
                // 线名，其中包括 `hello`（承载握手的本身）与 `shutdown`（运维动作，
                // `Dispatcher.swift:94` → `core.shutdown()`）。所以一帧错误既报了一个不
                // 完整的"它答这些"清单，又把 `:86-92` 刚刚论证过的"清单只能派生、不许
                // 手抄"违反在成文里：一个拼错 method 的调用方照着这句话去找 `shutdown`，
                // 会以为这个 daemon 不能停。下面两半都是**从表里算出来的**，一个字也没抄：
                // 能力清单 = `capabilityMethods` 的线名，另外那些 = `allCases` 减去它。
                // 帧的字节形制（一行 JSON、`{id,error{code,message,remedy}}`）与此无关，
                // 改的只有文案。
                error: GPError(
                    code: .methodNotFound,
                    message: "method '\(RequestParser.callerMethodDescription(dict["method"]))' is not one the engine implements. The agent-facing capabilities it answers — and the set `hello` publishes in its `capabilities` field — are \(EngineMethod.capabilityWireNames.joined(separator: ", ")). Beyond that list this daemon also answers \(EngineMethod.unadvertisedMethodWireNames.joined(separator: " and ")), which are the handshake itself and an operational action rather than capabilities, so `hello` does not advertise them; call hello to read the advertised set from the running daemon instead of from this message"
                )
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
