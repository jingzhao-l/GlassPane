import Foundation

/// Unix-domain socket server: creates the socket with 0600 permissions
/// inside a 0700 parent directory, unlinks stale files before binding, and
/// serves one connection at a time with newline-delimited JSON frames
/// (P0 spec §3.1). The socket never leaves the local machine; there is no
/// network surface.
public final class SocketServer {

    public let socketPath: String
    private let dispatcher: Dispatcher
    private let log: EngineLog
    private var listenFD: Int32 = -1
    private var didUnlinkOnExit = false

    public init(socketPath: String, dispatcher: Dispatcher, log: EngineLog) {
        self.socketPath = socketPath
        self.dispatcher = dispatcher
        self.log = log
    }

    public func run() throws {
        try prepareSocketDirectory()
        unlink(socketPath)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw SocketServerError.system(errno, "socket()")
        }
        listenFD = fd

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
            throw SocketErrorResponse.invalidPath(socketPath)
        }

        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            close(fd)
            throw SocketErrorResponse.system(errno, "bind(\(socketPath))")
        }
        guard chmod(socketPath, 0o600) == 0 else {
            close(fd)
            throw SocketErrorResponse.system(errno, "chmod(0600)")
        }
        guard listen(fd, 1) == 0 else {
            close(fd)
            throw SocketErrorResponse.system(errno, "listen()")
        }
        didUnlinkOnExit = true
        log.info("listening on \(socketPath)")

        // Accept loop: one client at a time; P0 has a single engine consumer.
        while !dispatcher.core.shutdownRequested {
            let clientFD = accept(fd, nil, nil)
            guard clientFD >= 0 else {
                if errno == EINTR { continue }
                throw SocketErrorResponse.system(errno, "accept()")
            }
            serve(clientFD: clientFD)
            close(clientFD)
        }

        close(listenFD)
        listenFD = -1
        unlink(socketPath)
        didUnlinkOnExit = false
        log.info("shutdown complete")
    }

    /// Best-effort cleanup for early exits; a stale file is harmless because
    /// run() unlinks before binding anyway.
    public func cleanup() {
        if listenFD >= 0 {
            close(listenFD)
            listenFD = -1
        }
        if didUnlinkOnExit {
            unlink(socketPath)
            didUnlinkOnExit = false
        }
    }

    // MARK: - Internals

    private func prepareSocketDirectory() throws {
        let directory = (socketPath as NSString).deletingLastPathComponent
        guard !directory.isEmpty else { return }
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
    }

    private func serve(clientFD: Int32) {
        var codec = FrameCodec()
        var buffer = [UInt8](repeating: 0, count: 65536)
        while !dispatcher.core.shutdownRequested {
            let readCount = read(clientFD, &buffer, buffer.count)
            guard readCount > 0 else {
                if readCount == 0 { log.info("client disconnected") }
                return
            }
            let events = codec.append(Data(buffer[0..<readCount]))
            for event in events {
                let response = dispatcher.handle(event)
                guard writeAll(clientFD, response) else { return }
            }
        }
    }

    private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        var offset = data.startIndex
        while offset < data.endIndex {
            let written = data.withUnsafeBytes { raw -> Int in
                let base = raw.baseAddress!.advanced(by: data.distance(from: data.startIndex, to: offset))
                return write(fd, base, data.distance(from: offset, to: data.endIndex))
            }
            if written <= 0 {
                if errno == EINTR { continue }
                return false
            }
            offset = data.index(offset, offsetBy: written)
        }
        return true
    }
}

public enum SocketErrorResponse: Error, CustomStringConvertible {
    case system(Int32, String)
    case invalidPath(String)

    public var description: String {
        switch self {
        case .system(let code, let operation):
            return "\(operation) failed: \(String(cString: strerror(code)))"
        case .invalidPath(let path):
            return "socket path too long or invalid: \(path)"
        }
    }
}

/// Legacy-compatible error name.
typealias SocketServerError = SocketErrorResponse
