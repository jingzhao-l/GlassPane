import Foundation

/// daemon 只读状态探测（P1 spec v1.2 §6.3）+ 启动护栏共用的**有界** socket 会话。
///
/// 面板对 daemon 的唯一协议调用是 `hello`（已存在于方法表），一次性会话：connect /
/// write / read 共用一个**绝对时限**，读环另有**硬字节上限**。旧注释声称"3s 超时后
/// 关闭"，实际只有读端设了 `SO_RCVTIMEO`——那是单次 syscall 的超时且每轮 read 重置，
/// connect()/write() 完全无界，对端每 2.9s 滴 1 字节即可永久绕过（R2-03/R5-07）；
/// 而护栏跑在信号遮罩之后、sigwait 线程之前，挂住就等于不可杀。
///
/// 护栏（§11.1 / R2-02 / A-18）用 `liveness(socketPath:)` 而不是 `helloSummary`：
/// 「回了 hello」「名字后面没有监听者」「有监听者但不开口」必须分开，混为一谈就会
/// unlink+bind 覆盖一个只是暂时没回话的活 daemon。
///
/// `@unchecked Sendable` 依据：init 后全部属性不可变（注入闭包与常量），
/// 探测过程不持有跨调用状态，可安全在后台队列复用同一实例。
public final class DaemonProbe: @unchecked Sendable {

    /// 传输注入点：把请求字节发给 daemon 并返回完整响应数据；失败/超时返回 nil。
    public typealias Transport = (_ socketPath: String, _ request: Data) -> Data?
    public typealias FileExists = (_ path: String) -> Bool

    /// 原始会话注入点：三态结局（`waitForHello` 为 false 时只验证"有没有监听者接这个
    /// 连接"，不等回音——见 `liveness`）。护栏走这里，面板仍走 `Transport`。
    public typealias RawTransport =
        (_ socketPath: String, _ request: Data, _ waitForHello: Bool) -> RawOutcome

    /// 一次有界会话的三种真实结局。
    public enum RawOutcome: Equatable {
        /// 对端在时限内回了字节（内容是否合规由调用方解析）。
        case answered(Data)
        /// 这个名字后面没有监听者：文件不存在、ECONNREFUSED、ENOTSOCK，或路径根本
        /// 装不进 sockaddr_un。清掉这种残留文件不会抢占任何进程。
        case noListener(reason: String)
        /// 连接建立但没拿到回音（卡死的 daemon，或不回话的另一种监听者），或者因
        /// EACCES/EAGAIN/时限到而**判不出来**：一律按"有人占着"处理。
        case occupied(reason: String)
    }

    /// 启动护栏的判定输入：`RawOutcome` 加一层 hello 解析。
    public enum Liveness: Equatable {
        case answered(Summary)
        case noListener(reason: String)
        /// 有人听着但不开口：可能是卡死的 daemon，也可能是**不回 hello 的另一种
        /// 监听者**——probe.sock 说的是探针协议，活着的它也永远不会回话（A-18）。
        case presentButNotAnswering(reason: String)
    }

    /// 护栏结论（纯函数产物，见 `takeoverDecision`）。
    public enum TakeoverDecision: Equatable {
        /// 名字无主（不存在或只是残留文件）：可以 unlink+bind。
        case bind
        /// 有主，但运维用显式 flag 要求抢占（--force-socket / --force-probe-socket）。
        case preempt(incumbent: String)
        /// 有主且未被明确要求抢占：拒绝，不得动这个文件。
        case refuse(incumbent: String)
    }

    public struct Summary: Equatable {
        public let version: String
        public let protocolVersion: String
        public let pid: Int
        /// daemon 自报的授权主体（`hello.identity`）；旧 daemon 不上报时为 nil
        /// ——面板据此显示"未验证"，不猜测（P1 v1.2 §11.2）。
        public let subject: PermissionSubject?
        /// daemon 自身的四类席位（`hello.permissions`）；缺失即空字典。
        public let permissions: [PermissionKind: PermissionStatus]

        public init(
            version: String,
            protocolVersion: String,
            pid: Int,
            subject: PermissionSubject? = nil,
            permissions: [PermissionKind: PermissionStatus] = [:]
        ) {
            self.version = version
            self.protocolVersion = protocolVersion
            self.pid = pid
            self.subject = subject
            self.permissions = permissions
        }
    }

    /// 3 秒超时（P1 spec v1.2 §6.3 / §9.2）——**整个会话**的绝对时限，
    /// 不是单次 read 的超时。
    public static let helloTimeoutSeconds: TimeInterval = 3

    /// hello 响应的字节上限（R5-07：旧读环无上限）。daemon 的 hello 带 identity +
    /// 四类席位，实测远小于此；超上限即视为对端不合规并断开，绝不无限收。
    public static let maxHelloResponseBytes = 64 * 1024

    private let transport: Transport
    private let fileExists: FileExists
    private let rawTransport: RawTransport

    public init(
        transport: @escaping Transport = DaemonProbe.defaultTransport,
        fileExists: @escaping FileExists = { FileManager.default.fileExists(atPath: $0) },
        rawTransport: @escaping RawTransport = DaemonProbe.defaultRawTransport
    ) {
        self.transport = transport
        self.fileExists = fileExists
        self.rawTransport = rawTransport
    }

    /// socket 文件是否存在（**不等于** daemon 存活：残留文件也在。存活判定见
    /// `liveness(socketPath:)`）。
    public func reachable(socketPath: String) -> Bool {
        fileExists(socketPath)
    }

    /// 发起一次性 `hello` 会话，成功返回 (version, protocolVersion, pid)；
    /// socket 缺失、无响应或响应不合规时返回 nil。
    ///
    /// 注意 nil 的三种成因（缺文件 / 没人听 / 有人听但不开口）在这里被折叠成同一个
    /// 值——**启动护栏不得用它做判据**（R2-02 的成因正是"3s 没回音"被当成"没
    /// daemon"），护栏请用 `liveness(socketPath:)`。
    public func helloSummary(socketPath: String) -> Summary? {
        guard reachable(socketPath: socketPath) else { return nil }
        let request = Data("{\"id\":0,\"method\":\"hello\"}\n".utf8)
        guard let response = transport(socketPath, request) else { return nil }
        return Self.parseHelloResponse(response)
    }

    /// 这个名字后面到底有没有活着的监听者？三态如实返回，不折叠。
    ///
    /// - engine.sock：`waitForHello: true`，能解析出 hello 才算"活着的 daemon"。
    /// - probe.sock：`waitForHello: false`——探针监听者按协议永不回话，连接能被
    ///   建立本身就证明名字有主（A-18）。
    public func liveness(socketPath: String, waitForHello: Bool = true) -> Liveness {
        guard fileExists(socketPath) else {
            return .noListener(reason: "no socket file at \(socketPath)")
        }
        let request = Data("{\"id\":0,\"method\":\"hello\"}\n".utf8)
        switch rawTransport(socketPath, request, waitForHello) {
        case .noListener(let reason):
            return .noListener(reason: reason)
        case .occupied(let reason):
            return .presentButNotAnswering(reason: reason)
        case .answered(let data):
            guard let summary = Self.parseHelloResponse(data) else {
                return .presentButNotAnswering(
                    reason: "answered \(data.count) byte(s) that are not a compliant hello"
                )
            }
            return .answered(summary)
        }
    }

    /// 单实例护栏真值表（P1 v1.2 §11.1）。放在引擎库里而不是 main.swift 里是为了
    /// 能被单测钉住（executable target 不可测）。默认行为只有一条不变：**除非名字
    /// 确实无主，否则必须拿到显式 flag 才动它**。
    public static func takeoverDecision(_ liveness: Liveness, force: Bool) -> TakeoverDecision {
        switch liveness {
        case .noListener:
            return .bind
        case .answered(let summary):
            let incumbent = "pid \(summary.pid), version \(summary.version) answers hello"
            return force ? .preempt(incumbent: incumbent) : .refuse(incumbent: incumbent)
        case .presentButNotAnswering(let reason):
            let incumbent = "a listener owns the name but did not answer hello (\(reason))"
            return force ? .preempt(incumbent: incumbent) : .refuse(incumbent: incumbent)
        }
    }

    /// 解析 `{"result":{...},"id":0}` 形态的 hello 响应（纯逻辑，独立可测）。
    ///
    /// 与既有口径一致，解析层只认字段形状（`engine` 名不在此层硬校验，见
    /// `EngineP1Batch3Tests.testDaemonProbeHelloSummaryRejectsWrongEngine`）。
    ///
    /// `identity` / `permissions` 为 P1 v1.2 §11.2 的增量字段：旧 daemon 不带
    /// 这两个字段时仍解析成功（subject=nil、permissions=[:]），面板据此显示
    /// "未验证"，绝不以面板进程自身的权限冒充 daemon 的席位。
    public static func parseHelloResponse(_ data: Data) -> Summary? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let result = object["result"] as? [String: Any],
              let version = result["version"] as? String,
              let protocolVersion = result["protocolVersion"] as? String,
              let pid = result["pid"] as? Int
        else {
            return nil
        }
        return Summary(
            version: version,
            protocolVersion: protocolVersion,
            pid: pid,
            subject: PermissionSubject.from(wireValue: result["identity"] as? [String: Any]),
            permissions: DaemonPermissionSnapshot.statuses(from: result["permissions"] as? [String: Any])
        )
    }

    // MARK: - Default transport (POSIX Unix domain socket, fully bounded)

    /// 默认传输：连接 → 发送 → 半关闭写端 → 读到 EOF。
    ///
    /// 三段共用 `helloTimeoutSeconds` 这一个**绝对**时限，读环另有
    /// `maxHelloResponseBytes` 上限；任何一步越界都返回 nil（不抛、不挂）。
    public static func defaultTransport(_ socketPath: String, _ request: Data) -> Data? {
        guard case .answered(let data) = defaultRawTransport(
            socketPath: socketPath, request: request, waitForHello: true
        ) else {
            return nil
        }
        return data
    }

    /// `defaultTransport` 的三态形态（护栏用）。见 `boundedSession`。
    public static func defaultRawTransport(
        socketPath: String,
        request: Data,
        waitForHello: Bool
    ) -> RawOutcome {
        boundedSession(
            socketPath: socketPath,
            request: request,
            waitForHello: waitForHello,
            timeoutSeconds: helloTimeoutSeconds,
            maxResponseBytes: maxHelloResponseBytes
        )
    }

    /// 一次有界的 unix socket 会话（R2-03/R5-07）。三条界：
    /// 1. **绝对时限** `SocketDeadline` 罩住整个读环；connect 用非阻塞模式（unix 流
    ///    套接字上是同步返回），write/read 用 `SO_SNDTIMEO`/`SO_RCVTIMEO` 封顶单次
    ///    syscall。滴字节的对端每轮都在重置 SO_RCVTIMEO，但推不动绝对时限，最多把
    ///    会话拖到 deadline + 一次 syscall（旧实现只有 SO_RCVTIMEO，无任何总量）；
    /// 2. **字节上限**，对端狂发不合规数据吃不光调用方内存；
    /// 3. connect 的 errno 区分"没人听"（ECONNREFUSED/ENOENT/ENOTSOCK）与
    ///    "判不出来"（EACCES/EAGAIN/时限到），后者按"有主"处理。
    static func boundedSession(
        socketPath: String,
        request: Data,
        waitForHello: Bool,
        timeoutSeconds: TimeInterval,
        maxResponseBytes: Int
    ) -> RawOutcome {
        let deadline = SocketDeadline(seconds: timeoutSeconds)
        func classify(_ code: Int32, _ operation: String) -> RawOutcome {
            BoundedSocket.isNoListener(errno: code)
                ? .noListener(reason: "\(operation): \(BoundedSocket.errnoText(code))")
                : .occupied(reason: "\(operation): \(BoundedSocket.errnoText(code))")
        }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            return .occupied(reason: "socket(): \(BoundedSocket.errnoText(errno))")
        }
        defer { close(fd) }
        // 面板进程不会 SIG_IGN SIGPIPE（daemon 才会），对已关连接写东西会直接杀死
        // 宿主；这里自己把 SIGPIPE 转成 write 的 EPIPE。
        var noSigpipe: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let copied = socketPath.withCString { source -> Bool in
            withUnsafeMutableBytes(of: &address.sun_path) { destination in
                guard let base = destination.baseAddress else { return false }
                _ = strncpy(base.assumingMemoryBound(to: CChar.self), source, destination.count)
                return true
            }
        }
        guard copied else {
            // 路径连 sockaddr_un 都装不下，这个名字后面不可能有监听者。
            return .noListener(reason: "socket path does not fit sockaddr_un: \(socketPath)")
        }

        // unix 流套接字的 connect() 是同步的，所以非阻塞模式下返回值本身就是答案：
        // 没有监听者立刻 ECONNREFUSED/ENOENT；backlog 满则 EAGAIN/EINPROGRESS（= 有
        // 活监听者，只是接不下新连接，按有主处理）。旧实现是阻塞 connect()，单客户端
        // daemon 的 backlog 一满调用方就永久挂在里面（R2-03）。
        let flags = fcntl(fd, F_GETFL)
        if flags >= 0 { _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK) }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                connect(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if connected != 0 {
            return classify(errno, "connect(\(socketPath))")
        }
        guard waitForHello else {
            // 连接建立 = 名字有主；探针监听者不回话，等 hello 只是白等 3s。
            return .occupied(reason: "listener accepted the connection (probe.sock never answers hello)")
        }

        // 恢复阻塞语义：此后每个 syscall 由 SO_*TIMEO 兜住，会话总时长由绝对时限兜。
        if flags >= 0 { _ = fcntl(fd, F_SETFL, flags) }
        var socketTimeout = timeval(tv_sec: Int(timeoutSeconds), tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &socketTimeout, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &socketTimeout, socklen_t(MemoryLayout<timeval>.size))

        // 发送：部分写继续（旧实现一次 write 定生死），阻塞由 SO_SNDTIMEO 封顶。
        var sent = 0
        while sent < request.count {
            let written = request.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Int in
                guard let base = raw.baseAddress else { return -1 }
                return write(fd, base.advanced(by: sent), request.count - sent)
            }
            if written > 0 {
                sent += written
                continue
            }
            let code = errno
            if code == EINTR { continue }
            if code == EAGAIN || code == EWOULDBLOCK {
                return .occupied(reason: "peer stopped draining the socket at \(sent)/\(request.count) request bytes (send timeout \(Int(timeoutSeconds))s)")
            }
            return classify(code, "write")
        }
        // 半关闭写端：daemon 读到 EOF 后关闭连接，读循环据此退出（不占长连接）。
        shutdown(fd, SHUT_WR)

        var budget = ResponseBudget(maxBytes: maxResponseBytes)
        var response = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = read(fd, &buffer, Swift.min(buffer.count, budget.remainingBytes))
            if count > 0 {
                budget.accept(count)
                response.append(contentsOf: buffer[0..<count])
                if budget.isFull {
                    return .occupied(reason: "peer sent \(budget.receivedBytes) bytes with no compliant answer (cap \(maxResponseBytes))")
                }
                continue
            }
            let code = errno
            if count == 0 { break } // EOF：对端说完了
            if code == EINTR { continue }
            if code == EAGAIN || code == EWOULDBLOCK {
                // 单次读超时：只在绝对时限内继续等。滴字节的对端每轮都让 SO_RCVTIMEO
                // 重新计时，但推不动 deadline，所以最多拖到 timeout + 一次 syscall。
                if deadline.expired() {
                    return .occupied(reason: "peer dribbled \(budget.receivedBytes) byte(s) past the absolute \(timeoutSeconds)s deadline")
                }
                continue
            }
            return classify(code, "read")
        }
        return response.isEmpty
            ? .occupied(reason: "listener closed the connection without answering")
            : .answered(response)
    }
}

// MARK: - Bounded socket primitives (shared with SocketServer)

/// poll() 的三态封装 + 两个纯预算类型。绝对时限是刻意的：`SO_RCVTIMEO`/
/// `SO_SNDTIMEO` 都是**单次 syscall** 的超时且每轮重置，滴字节的对端永远碰不到
/// 它们（R5-07 实测面）。
public enum BoundedSocket {

    public enum Readiness: Equatable {
        case ready
        case timedOut
        case failed(errno: Int32)
    }

    /// 等到 fd 可读/可写，或绝对时限到。EINTR 继续等，仍受同一时限约束。
    @discardableResult
    public static func wait(
        _ fd: Int32,
        events: Int16,
        deadline: SocketDeadline
    ) -> Readiness {
        while true {
            if deadline.expired() { return .timedOut }
            var descriptor = pollfd(fd: fd, events: events, revents: 0)
            let polled = poll(&descriptor, 1, deadline.pollMillis())
            if polled > 0 { return .ready }
            if polled == 0 { return .timedOut }
            let interrupted = errno
            if interrupted == EINTR { continue }
            return .failed(errno: interrupted)
        }
    }

    /// connect() 的这些 errno 才等于"名字后面没有监听者"；其余一律按有主处理。
    public static func isNoListener(errno code: Int32) -> Bool {
        code == ECONNREFUSED || code == ENOENT || code == ENOTSOCK
    }

    public static func errnoText(_ code: Int32) -> String {
        String(cString: strerror(code))
    }
}

/// 绝对时限：一次会话从头到尾的总预算。
public struct SocketDeadline {
    public let seconds: TimeInterval
    private let start: TimeInterval
    private let clock: () -> TimeInterval

    public init(seconds: TimeInterval, now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }) {
        self.seconds = seconds
        self.clock = now
        self.start = now()
    }

    public func elapsed() -> TimeInterval { Swift.max(0, clock() - start) }
    public func remaining() -> TimeInterval { Swift.max(0, seconds - elapsed()) }
    public func expired() -> Bool { elapsed() >= seconds }

    /// poll() 的毫秒超时：已过期返回 0（poll 立即返回），否则向上取整且至少 1ms，
    /// 避免"还剩 0.4ms"被截成 0 而变成非阻塞轮询。
    public func pollMillis() -> Int32 {
        if expired() { return 0 }
        return Int32(Swift.max(1, (remaining() * 1000).rounded(.up)))
    }
}

/// 读环字节上限（R5-07：旧读环既无上限也无绝对时限）。
public struct ResponseBudget {
    public let maxBytes: Int
    public private(set) var receivedBytes = 0

    public init(maxBytes: Int) {
        self.maxBytes = maxBytes
    }

    public var remainingBytes: Int { Swift.max(0, maxBytes - receivedBytes) }
    public var isFull: Bool { receivedBytes >= maxBytes }

    /// 计入本轮读到的字节，返回**实际接受**的条数（越界部分不计，读尺寸本就按
    /// `remainingBytes` 申请，这里只是把不变量写死）。
    @discardableResult
    public mutating func accept(_ count: Int) -> Int {
        let accepted = Swift.max(0, Swift.min(count, remainingBytes))
        receivedBytes += accepted
        return accepted
    }
}