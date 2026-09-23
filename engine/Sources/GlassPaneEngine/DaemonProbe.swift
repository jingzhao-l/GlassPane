import Foundation

/// daemon 只读状态探测（P1 spec v1.2 §6.3）。
///
/// 面板对 daemon 的唯一协议调用是 `hello`（已存在于方法表），一次性会话、
/// 3s 超时后关闭，不占用连接（SocketServer 单客户端语义不变）。
///
/// `@unchecked Sendable` 依据：init 后全部属性不可变（注入闭包与常量），
/// 探测过程不持有跨调用状态，可安全在后台队列复用同一实例。
public final class DaemonProbe: @unchecked Sendable {

    /// 传输注入点：把请求字节发给 daemon 并返回完整响应数据；失败/超时返回 nil。
    public typealias Transport = (_ socketPath: String, _ request: Data) -> Data?
    public typealias FileExists = (_ path: String) -> Bool

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

    /// 3 秒超时（P1 spec v1.2 §6.3 / §9.2）。
    public static let helloTimeoutSeconds: TimeInterval = 3

    /// daemon socket 的默认路径——**唯一真源**。daemon 的 CLI 默认值、设置面板
    /// 的探测路径与安装器写入的 plist 都必须引用它；此前这三处各写了一遍字面量
    /// （main.swift / SettingsModel.swift / 帮助文本），任何一处改动都会让面板
    /// 探到一个不存在的 socket 并恒显"未运行"。
    public static let defaultSocketPath = NSHomeDirectory() + "/.glasspane/engine.sock"

    /// 探针监听的默认路径——**唯一真源**（同上）。探针 SDK 一侧
    /// （`engine/probe/Sources/GlassPaneProbe`）是另一个 SPM 包、无法引用这里的
    /// 常量，所以它自己那份默认值必须由跨包断言钉住一致，而不是靠人记
    /// （见 `ProjectRegistryIsolationTests.testProbeSocketDefaultsAgreeAcrossPackages`）。
    public static let defaultProbeSocketPath = NSHomeDirectory() + "/.glasspane/probe.sock"

    private let transport: Transport
    private let fileExists: FileExists

    public init(
        transport: @escaping Transport = DaemonProbe.defaultTransport,
        fileExists: @escaping FileExists = { FileManager.default.fileExists(atPath: $0) }
    ) {
        self.transport = transport
        self.fileExists = fileExists
    }

    /// socket 文件是否存在（不等于 daemon 存活；存活判定见 `helloSummary`）。
    public func reachable(socketPath: String) -> Bool {
        fileExists(socketPath)
    }

    /// 发起一次性 `hello` 会话，成功返回 (version, protocolVersion, pid)；
    /// socket 缺失、无响应或响应不合规时返回 nil。
    public func helloSummary(socketPath: String) -> Summary? {
        guard reachable(socketPath: socketPath) else { return nil }
        let request = Data("{\"id\":0,\"method\":\"hello\"}\n".utf8)
        guard let response = transport(socketPath, request) else { return nil }
        return Self.parseHelloResponse(response)
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

    // MARK: - Default transport (POSIX Unix domain socket)

    /// 默认传输：连接 daemon socket → 发送请求 → 半关闭写端 → 读取至 EOF。
    /// 3s 读超时（`SO_RCVTIMEO`）；任何一步失败都返回 nil。
    public static func defaultTransport(_ socketPath: String, _ request: Data) -> Data? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }

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
            close(fd)
            return nil
        }

        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                connect(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            close(fd)
            return nil
        }

        var timeout = timeval(tv_sec: Int(Self.helloTimeoutSeconds), tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        let wrote = request.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Int in
            guard let base = raw.baseAddress else { return 0 }
            return write(fd, base, raw.count)
        }
        guard wrote == request.count else {
            close(fd)
            return nil
        }
        // 半关闭写端：daemon 读到 EOF 后关闭连接，客户端得以读到 EOF 退出
        // 读循环（不占用长连接）。
        shutdown(fd, SHUT_WR)

        var response = Data()
        var buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = read(fd, &buffer, buffer.count)
            if count > 0 {
                response.append(contentsOf: buffer[0..<count])
            } else {
                break
            }
        }
        close(fd)
        return response.isEmpty ? nil : response
    }
}