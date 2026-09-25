import Foundation

/// Unix-domain socket server: creates the socket with 0600 permissions
/// inside a 0700 parent directory and serves one connection at a time with
/// newline-delimited JSON frames (P0 spec §3.1). The socket never leaves the
/// local machine; there is no network surface.
///
/// Binding deliberately does **not** unlink first (R2-02/A-18): an unconditional
/// unlink+bind is how a second daemon silently steals the name while the first
/// one keeps serving nobody, splitting attribution across two processes. An
/// existing name is only removed when it demonstrably has no listener behind it,
/// or when the operator passed the explicit force flag (`preemptsExistingSocket`,
/// wired from `--force-socket`).
public final class SocketServer {

    public let socketPath: String
    /// Take the name over even from a live listener. Explicit operator intent
    /// only; the default path never pre-empts.
    public let preemptsExistingSocket: Bool
    private let dispatcher: Dispatcher
    private let log: EngineLog
    /// The descriptor `cleanup()` is allowed to close. Assigned only once a
    /// socket is fully bound *and* listening, so no failure path can leave a
    /// descriptor number here that another subsystem has since reused (R2-09).
    private var listenFD: Int32 = -1
    private var didUnlinkOnExit = false

    /// A client that stops mid-line may not pin the single-client daemon
    /// forever (B-12): this is the absolute budget for one *incomplete* frame.
    /// Silent periods between complete frames are never timed out — a
    /// long-lived session legitimately idles between calls.
    static let partialLineTimeoutSeconds: TimeInterval = 60

    /// Bounds `write()` against a client that stops reading (the other half of
    /// B-12: without it a non-draining client wedges the daemon in writeAll).
    private static let clientSendTimeoutSeconds: Int32 = 30

    public init(
        socketPath: String,
        dispatcher: Dispatcher,
        log: EngineLog,
        preemptsExistingSocket: Bool = false
    ) {
        self.socketPath = socketPath
        self.dispatcher = dispatcher
        self.log = log
        self.preemptsExistingSocket = preemptsExistingSocket
    }

    /// Called once, immediately after **this** instance's bind succeeded and before
    /// the accept loop. R6-07: the daemon registers its socket with the shutdown
    /// waiter through this hook, because the waiter thread is now created at the top
    /// of startup (before any listener exists) and must not unlink a name the process
    /// never owned. `bindAndListen()` throws on every failure path, so reaching this
    /// callback means the file at `socketPath` is ours.
    public var onBound: (() -> Void)?

    public func run() throws {
        try prepareSocketDirectory()
        // `listenFD` is assigned only for a socket that is bound *and* listening:
        // `bindAndListen()` owns the descriptor until then and closes it itself
        // on every failure path (R2-09).
        listenFD = try openListenSocket()
        onBound?()
        log.info("listening on \(socketPath)")

        // Accept loop: one client at a time; P0 has a single engine consumer.
        while !dispatcher.core.shutdownRequested {
            let clientFD = accept(listenFD, nil, nil)
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

    /// Best-effort cleanup for early exits. Because `listenFD` is only assigned
    /// for a socket this instance still owns, closing it here can never hit a
    /// descriptor number the probe listener or a file handle has been given in
    /// the meantime (R2-09).
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

    // MARK: - Bind

    /// socket → bind → chmod → listen, with at most one evidence-based unlink
    /// retry. Every failure path closes only the descriptor it created and
    /// throws, and none of them touches `listenFD`.
    private func openListenSocket() throws -> Int32 {
        if preemptsExistingSocket {
            // --force-socket: main.swift has already named the incumbent this
            // run is displacing, so removing a live name *is* the intent.
            unlink(socketPath)
            return try bindAndListen()
        }
        do {
            return try bindAndListen()
        } catch SocketErrorResponse.nameOccupied(let detail) {
            let incumbent = DaemonProbe().liveness(socketPath: socketPath)
            switch DaemonProbe.takeoverDecision(incumbent, force: false) {
            case .bind:
                guard case .noListener(let reason) = incumbent else {
                    throw SocketErrorResponse.nameOccupied(detail)
                }
                log.info("removing stale socket \(socketPath) (\(reason))")
                unlink(socketPath)
                // One retry only: a second EADDRINUSE is a real race with
                // another starting daemon, not a stale file.
                return try bindAndListen()
            case .refuse(let description):
                throw SocketErrorResponse.nameOccupied(description)
            case .preempt(let description):
                // Unreachable without the force flag; never pre-empt silently.
                throw SocketErrorResponse.nameOccupied(description)
            }
        }
    }

    private func bindAndListen() throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw SocketErrorResponse.system(errno, "socket()")
        }

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
            let code = errno
            close(fd)
            throw code == EADDRINUSE
                ? SocketErrorResponse.nameOccupied("bind(\(socketPath)): name already bound")
                : SocketErrorResponse.system(code, "bind(\(socketPath))")
        }
        // From here the name belongs to this fd; later failures remove it again.
        didUnlinkOnExit = true
        guard chmod(socketPath, 0o600) == 0 else {
            let code = errno
            close(fd)
            unlink(socketPath)
            didUnlinkOnExit = false
            throw SocketErrorResponse.system(code, "chmod(0600)")
        }
        guard listen(fd, 1) == 0 else {
            let code = errno
            close(fd)
            unlink(socketPath)
            didUnlinkOnExit = false
            throw SocketErrorResponse.system(code, "listen()")
        }
        return fd
    }

    // MARK: - Directory isolation (R5-04)

    /// Enforce the 0700 isolation this type's documentation claims.
    ///
    /// `createDirectory(attributes:)` only applies to directories **this call
    /// creates**; ~/.glasspane is normally already there (the mcp-shell registry
    /// and EvidenceStore both create it with the default mode), so without an
    /// explicit chmod the documented "0700 parent directory" is silently false
    /// and every evidence archive, approval chain and registry entry becomes
    /// readable from other accounts on the machine.
    ///
    /// Enforcement is scoped to **ownership, not home membership**: the checks
    /// below (`chmod`, owner, resulting mode) are what decide it, and all
    /// three answer correctly for a directory outside home. The rule used to
    /// exempt paths outside `NSHomeDirectory()` — and since `--state-dir` lets a
    /// run place its sockets anywhere, that exemption was the one shape most in
    /// need of isolation (a maintenance run under `/var/folders` or `/tmp`)
    /// skipping it while still binding the socket.
    private func prepareSocketDirectory() throws {
        let directory = (socketPath as NSString).deletingLastPathComponent
        guard !directory.isEmpty else { return }
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let home = NSHomeDirectory()
        if directory != home, !directory.hasPrefix(home + "/") {
            log.info("socket directory \(directory) is outside \(home) — isolating it by ownership, not by home scope")
        }
        guard chmod(directory, 0o700) == 0 else {
            throw SocketErrorResponse.system(errno, "chmod(0700) \(directory)")
        }
        let attributes = (try? FileManager.default.attributesOfItem(atPath: directory)) ?? [:]
        guard !attributes.isEmpty else {
            throw SocketErrorResponse.insecureDirectory(directory, "attributes unreadable after chmod")
        }
        guard attributes[.type] as? FileAttributeType == .typeDirectory else {
            throw SocketErrorResponse.insecureDirectory(directory, "not a directory")
        }
        let owner = attributes[.ownerAccountName] as? String ?? "an unknown account"
        guard owner == NSUserName() else {
            // Someone else planted the directory we are about to publish into.
            throw SocketErrorResponse.insecureDirectory(directory, "owned by \(owner), not \(NSUserName())")
        }
        let mode = (attributes[.posixPermissions] as? NSNumber)?.int16Value ?? -1
        guard mode == 0o700 else {
            // chmod claimed success yet the directory is still reachable by
            // group/other (read-only volume, immutable flag, ACL override):
            // serving from it would publish evidence to other accounts.
            throw SocketErrorResponse.insecureDirectory(
                directory, "permission is \(String(format: "%04o", Int(mode))) and cannot be set to 0700")
        }
    }

    // MARK: - Connection service

    /// Serve one connection. Two bounds keep a misbehaving client from pinning
    /// the single-client daemon (B-12): an absolute deadline on an *incomplete*
    /// line, and `SO_SNDTIMEO` on the writes going back.
    private func serve(clientFD: Int32) {
        var sendTimeout = timeval(tv_sec: Int(Self.clientSendTimeoutSeconds), tv_usec: 0)
        _ = setsockopt(
            clientFD, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout,
            socklen_t(MemoryLayout<timeval>.size)
        )

        var codec = FrameCodec()
        var buffer = [UInt8](repeating: 0, count: 65536)
        var lineDeadline: SocketDeadline?
        while !dispatcher.core.shutdownRequested {
            if let lineDeadline {
                // Only armed while a frame is half-received.
                switch BoundedSocket.wait(clientFD, events: Int16(POLLIN), deadline: lineDeadline) {
                case .ready:
                    break
                case .timedOut:
                    log.error("client sent \(codec.pendingBytes) byte(s) with no newline within \(Int(Self.partialLineTimeoutSeconds))s — closing the connection instead of waiting forever")
                    return
                case .failed(let code):
                    log.error("client poll failed: \(BoundedSocket.errnoText(code)) (errno \(code)) — closing connection")
                    return
                }
            }
            let readCount = read(clientFD, &buffer, buffer.count)
            if readCount < 0 {
                let code = errno
                if code == EINTR { continue }
                if code == EAGAIN || code == EWOULDBLOCK { continue }
                // R2-17: this is NOT a clean disconnect. ECONNRESET and friends
                // mean responses that were queued but never written are lost,
                // so say so instead of folding it into "client disconnected".
                log.error("client read error: \(BoundedSocket.errnoText(code)) (errno \(code)) — connection aborted; any unanswered requests were lost (not a clean EOF)")
                return
            }
            if readCount == 0 {
                log.info("client disconnected")
                return
            }
            let events = codec.append(Data(buffer[0..<readCount]))
            for event in events {
                let response = dispatcher.handle(event)
                guard writeAll(clientFD, response) else { return }
            }
            lineDeadline = codec.pendingBytes > 0
                ? (lineDeadline ?? SocketDeadline(seconds: Self.partialLineTimeoutSeconds))
                : nil
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
                let code = errno
                if code == EINTR { continue }
                log.error("write failed: \(BoundedSocket.errnoText(code)) (errno \(code)) — reply not fully sent, closing connection")
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
    /// Another listener already owns the name and was not forcibly displaced.
    case nameOccupied(String)
    /// The socket directory cannot be brought to (or kept at) 0700.
    case insecureDirectory(String, String)

    public var description: String {
        switch self {
        case .system(let code, let operation):
            return "\(operation) failed: \(String(cString: strerror(code)))"
        case .invalidPath(let path):
            return "socket path too long or invalid: \(path)"
        case .nameOccupied(let detail):
            return "socket name in use: \(detail) — refusing to unlink a live socket; pass --force-socket to pre-empt explicitly"
        case .insecureDirectory(let path, let detail):
            return "socket directory \(path) is not isolated: \(detail) — refusing to serve, because evidence archives, the approval chain and the project registry would be readable by other accounts"
        }
    }
}

/// Legacy-compatible error name.
typealias SocketServerError = SocketErrorResponse
