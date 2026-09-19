import Foundation

/// Listener for probe connections (P6 spec v6.0 §2): runs an accept loop on
/// a dedicated thread, serves *many* concurrent probe clients (one reader
/// thread each), decodes NDJSON with FrameCodec and feeds ProbeInbox. Unlike
/// engine.sock this socket has no request/response promise — daemon→probe
/// frames are whitelist commands issued through the inbox `sender` hook.
public final class ProbeSocketServer {

    public let socketPath: String
    public let inbox: ProbeInbox
    private let log: EngineLog
    private var listenFD: Int32 = -1
    private var running = false
    private let clientLock = NSLock()
    private var clientFDs: [Int32: Int32] = [:] // probe pid -> fd

    public init(socketPath: String, inbox: ProbeInbox, log: EngineLog) {
        self.socketPath = socketPath
        self.inbox = inbox
        self.log = log
    }

    /// Bind + listen and start the accept thread. Failure throws with errno.
    public func start() throws {
        let directory = (socketPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        unlink(socketPath)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ProbeServerError.system(errno, "socket()") }
        listenFD = fd

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let pathCopied = socketPath.withCString { source in
            withUnsafeMutableBytes(of: &address.sun_path) { destination in
                guard let base = destination.baseAddress else { return false }
                _ = strncpy(base.assumingMemoryBound(to: CChar.self), source, destination.count)
                return true
            }
        }
        guard pathCopied else { close(fd); throw ProbeServerError.invalidPath(socketPath) }

        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else { close(fd); throw ProbeServerError.system(errno, "bind(\(socketPath))") }
        _ = chmod(socketPath, 0o600)
        guard listen(fd, 8) == 0 else {
            close(fd)
            throw ProbeServerError.system(errno, "listen()")
        }

        inbox.sender = { [weak self] pid, data in
            self?.writeToClient(pid: pid, data: data)
        }
        running = true
        let thread = Thread { [weak self] in self?.acceptLoop() }
        thread.name = "glasspane.probe-socket"
        thread.start()
        log.info("probe socket listening on \(socketPath)")
    }

    public func stop() {
        running = false
        if listenFD >= 0 {
            close(listenFD)
            listenFD = -1
        }
        clientLock.lock()
        let fds = Array(clientFDs.values)
        clientFDs.removeAll()
        clientLock.unlock()
        fds.forEach { close($0) }
        unlink(socketPath)
    }

    // MARK: - Internals

    private func acceptLoop() {
        while running {
            let clientFD = accept(listenFD, nil, nil)
            guard clientFD >= 0 else {
                if errno == EINTR { continue }
                if running { log.error("probe accept failed: errno \(errno)") }
                return
            }
            let reader = Thread { [weak self] in self?.serve(clientFD: clientFD) }
            reader.name = "glasspane.probe-client"
            reader.start()
        }
        close(listenFD)
    }

    private func serve(clientFD: Int32) {
        var codec = FrameCodec()
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: 64 * 1024, alignment: 16)
        defer { buffer.deallocate() }
        var boundPid: Int32?
        defer {
            if let boundPid {
                inbox.disconnect(pid: boundPid)
                clientLock.lock()
                if clientFDs[boundPid] == clientFD { clientFDs.removeValue(forKey: boundPid) }
                clientLock.unlock()
            }
            close(clientFD)
        }
        while running {
            let received = read(clientFD, buffer, 64 * 1024)
            if received <= 0 { return }
            let data = Data(bytes: buffer, count: received)
            for event in codec.append(data) {
                switch event {
                case .oversize:
                    log.error("probe frame oversize; dropping line")
                case .frame(let payload):
                    if case .hello(let hello) = ProbeWire.decode(payload) {
                        inbox.register(hello)
                        boundPid = hello.pid
                        clientLock.lock()
                        clientFDs[hello.pid] = clientFD
                        clientLock.unlock()
                        inbox.sendCommand("hello_ack", ["maxEventRate": 1000], to: hello.pid)
                        log.info("probe connected: \(hello.appName) pid \(hello.pid) v\(hello.probeVersion)")
                        continue
                    }
                    guard let pid = boundPid else { continue } // pre-hello frames ignored
                    let frame = ProbeWire.decode(payload)
                    if case .malformed(let reason) = frame {
                        log.error("probe frame malformed from pid \(pid): \(reason)")
                        continue
                    }
                    inbox.ingest(pid: pid, frame: frame)
                }
            }
        }
    }

    private func writeToClient(pid: Int32, data: Data) {
        clientLock.lock()
        let fd = clientFDs[pid]
        clientLock.unlock()
        guard let fd else { return }
        data.withUnsafeBytes { raw in
            var offset = 0
            let total = raw.count
            while offset < total {
                let written = write(fd, raw.baseAddress!.advanced(by: offset), total - offset)
                if written <= 0 { return }
                offset += written
            }
        }
    }
}

public enum ProbeServerError: Error, CustomStringConvertible {
    case system(Int32, String)
    case invalidPath(String)

    public var description: String {
        switch self {
        case .system(let code, let where_): return "probe socket \(where_) failed: errno \(code)"
        case .invalidPath(let path): return "invalid probe socket path: \(path)"
        }
    }
}
