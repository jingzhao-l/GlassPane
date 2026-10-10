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
///
/// "No listener" is **not** the same claim as "safe to remove" (X-24): a regular
/// file, a directory or a symlink also has no listener behind it — a regular file
/// answers `connect()` with ECONNREFUSED/ENOTSOCK, which is exactly what
/// `DaemonProbe` classifies as `.noListener`. So every unlink site here is
/// preceded by an `lstat` that requires `S_ISSOCK`; anything else is a fatal
/// refusal that names the path and says what it is, and is never removed.
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
        // X-24 (P0): measure the name **before** any path that can remove it,
        // including the force path — `--force-socket` is intent to displace a
        // *listener*, not intent to delete whatever happens to live here.
        try SocketServer.refuseNonSocketNameAtTakeover(site: socketPath)
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
                // Re-measured at the unlink site on purpose: `takeoverDecision`
                // maps `.noListener` to `.bind`, and a *regular file* answers a
                // connect with ECONNREFUSED/ENOTSOCK — so "no listener" is a
                // statement about listeners, never permission to delete an inode.
                try SocketServer.refuseNonSocketNameAtTakeover(site: socketPath)
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

    /// Enforce the 0700 isolation this type's documentation claims. This call
    /// site is a thin wrapper over `ensureIsolatedSocketDirectory`, which
    /// `ProbeSocketServer` runs through the same rules (X-25).
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
        try SocketServer.ensureIsolatedSocketDirectory(
            directory: (socketPath as NSString).deletingLastPathComponent,
            log: log
        )
    }

    /// The one implementation of the socket-directory rule set (R5-04), shared
    /// with `ProbeSocketServer` instead of copied into it (X-25).
    ///
    /// Why this is a **refusal** and not a best-effort chmod: a probe listener
    /// sitting in a directory another account can write to is not merely
    /// observable, it is *hijackable* — that account can unlink `probe.sock`
    /// and bind the name itself, so the app-under-test's probe stream goes to
    /// the attacker while the daemon keeps reporting "no probe attached",
    /// silently disabling attribution and checkpoint rollback. Serving from such
    /// a directory is therefore worse than not binding it.
    static func ensureIsolatedSocketDirectory(directory: String, log: EngineLog) throws {
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
            let code = errno
            // Still measure the directory: "chmod failed" alone leaves the reader
            // guessing whether this is a 0755 folder or someone else's.
            throw SocketErrorResponse.insecureDirectory(
                directory,
                "chmod(0700) failed: \(String(cString: strerror(code))); permission is \(measuredPermission(of: directory)) and cannot be set to 0700"
            )
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

    /// The permission bits actually on disk, as measured — never as intended.
    private static func measuredPermission(of path: String) -> String {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let mode = (attributes[.posixPermissions] as? NSNumber)?.int16Value else {
            return "unreadable"
        }
        return String(format: "%04o", Int(mode))
    }

    // MARK: - Takeover measurement (X-24)

    /// What is actually sitting at `path`, or nil when the name is free or is
    /// genuinely a socket.
    ///
    /// `lstat`, not `stat`: a **symlink** has to answer as itself. Following it
    /// would let a planted link resolve to some other account's socket, which is
    /// exactly the object the takeover must never unlink.
    ///
    /// An `lstat` that fails for any reason other than "no such file" also
    /// answers non-nil (with the errno, so the reader can tell a permission
    /// problem from a missing directory): undetermined means unprotected, and
    /// the only safe action for a name we cannot classify is to leave it alone.
    public static func nonSocketInodeKind(at path: String) -> String? {
        var info = stat()
        guard lstat(path, &info) == 0 else {
            let code = errno
            if code == ENOENT { return nil }
            return "a name that cannot be inspected (lstat: \(String(cString: strerror(code))))"
        }
        // `S_IFMT`/`S_IF*` come in as `Int32` on Darwin while `st_mode` is a
        // `mode_t` (`UInt16`), so the masking is done in `Int` — the widths only
        // line up that way (verified against a standalone `lstat` fixture).
        let inodeType = Int(info.st_mode) & Int(S_IFMT)
        switch inodeType {
        case Int(S_IFSOCK): return nil
        case Int(S_IFDIR): return "a directory"
        case Int(S_IFLNK): return "a symlink"
        case Int(S_IFREG): return "a regular file"
        case Int(S_IFCHR): return "a character device"
        case Int(S_IFBLK): return "a block device"
        case Int(S_IFIFO): return "a FIFO"
        default: return "a non-socket inode (S_IFMT 0o\(String(inodeType, radix: 8)))"
        }
    }

    /// The guard in front of **every** unlink of a name this run is about to
    /// take over: a regular file, a directory, a symlink or anything else that
    /// is not a socket is a fatal refusal, and it is never removed.
    ///
    /// The reachable defect this closes is not theoretical — `installer/cli.js`
    /// writes a caller-supplied `--socket-path` straight into the launchd plist,
    /// so `glasspaned --socket-path ~/.ssh/id_rsa` used to reach
    /// `DaemonProbe`'s "no listener" verdict (a regular file answers connect
    /// with ECONNREFUSED/ENOTSOCK, which is precisely what that classification
    /// accepts), unlink the private key and bind a socket in its place. The
    /// shutdown `sigwait` path unlinked it again.
    static func refuseNonSocketNameAtTakeover(site path: String) throws {
        guard let kind = SocketServer.nonSocketInodeKind(at: path) else { return }
        throw SocketErrorResponse.notASocket(path, kind)
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
                    // 丢弃超长帧时 pendingBytes 恒为 0，照原样打印就成了"客户端
                    // 一个字节都没发却卡住了我们"——原因恰恰在它发了太多字节。
                    let buffered = codec.isDiscardingOversizeFrame
                        ? "an oversize frame being discarded"
                        : "\(codec.pendingBytes) buffered byte(s)"
                    log.error("client left an incomplete line (\(buffered)) with no newline within \(Int(Self.partialLineTimeoutSeconds))s — closing the connection instead of waiting forever")
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
            lineDeadline = Self.partialLineDeadline(for: codec, existing: lineDeadline)
        }
    }

    /// 半行绝对时限的武装判据（纯函数：假时钟可驱动，不必开真 socket）。
    /// 用 `codec.awaitsNewline` 而不是 `pendingBytes > 0`：超长帧丢弃期间 buffer
    /// 是空的，对端却确实还停在同一行里。已武装的时限不被后续字节顶掉——那是
    /// **一次未完成帧的总预算**，不是空闲计时器（见 FrameCodec.awaitsNewline）。
    static func partialLineDeadline(
        for codec: FrameCodec,
        existing: SocketDeadline?,
        now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) -> SocketDeadline? {
        guard codec.awaitsNewline else { return nil }
        return existing ?? SocketDeadline(seconds: partialLineTimeoutSeconds, now: now)
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
    /// The name we would have to remove in order to bind is **not a socket**
    /// (X-24). Removing it is deleting a file the daemon was never given.
    case notASocket(String, String)

    public var description: String {
        switch self {
        case .system(let code, let operation):
            return "\(operation) failed: \(String(cString: strerror(code)))"
        case .invalidPath(let path):
            return "socket path too long or invalid: \(path)"
        case .nameOccupied(let detail):
            return "socket name in use: \(detail) — refusing to unlink a live socket; pass --force-socket to pre-empt explicitly"
        case .insecureDirectory(let path, let detail):
            return "socket directory \(path) is not isolated: \(detail) — refusing to serve from it, because evidence archives, the approval chain and the project registry would be readable by other accounts and a socket name in a directory somebody else can write is a name they can unlink and rebind for themselves"
        case .notASocket(let path, let kind):
            return "socket path \(path) is \(kind), not a socket — refusing to remove it and refusing to bind here. Nothing was unlinked; move this run's --socket-path to a name that is free, or remove \(path) yourself."
        }
    }
}

/// Legacy-compatible error name.
typealias SocketServerError = SocketErrorResponse

/// The `--socket-path` / `--probe-socket-path` value rule (X-22's sibling for
/// named sockets).
///
/// Why the *parser* has to decide this, before any directory is touched: a
/// socket path is a path whose **parent this run chmods to 0700**
/// (`SocketServer.ensureIsolatedSocketDirectory`). A relative value therefore
/// tightens whatever directory the daemon happened to be started in —
/// `glasspaned --socket-path ./s.sock` from ~/Documents chmods ~/Documents to
/// 0700 — and that chmod **survives** the later bind failure and the exit, so
/// the user is left with a locked-down Documents folder and no daemon. Same
/// reason `--state-dir` has demanded an absolute path since X-22: a relative
/// location means "wherever this process was started from", which is not a
/// location anybody named.
///
/// The rule set is `StateRootArgument`'s, deliberately: the two spellings of a
/// named location must not be able to disagree about what counts as a path, so
/// this type only forwards and never re-states the checks. Exposed as a pure
/// function because `main.swift` is an executable target a unit test cannot
/// reach — the daemon calls it and the test calls the same code.
public enum SocketPathArgument {

    /// Why `raw` cannot name a socket path, or nil when it can. The reason is
    /// phrased to follow the flag name, exactly like `--state-dir`'s.
    public static func rejection(for raw: String?) -> String? {
        StateRootArgument.rejection(for: raw)
    }
}
