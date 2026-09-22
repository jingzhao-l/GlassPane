import Foundation

/// Listener for probe connections (P6 spec v6.0 §2): one accept thread, a
/// bounded number of concurrent probe clients (one reader thread each), NDJSON
/// through FrameCodec into ProbeInbox. Unlike engine.sock there is no
/// request/response promise — daemon→probe frames are whitelist commands
/// issued through the inbox `sender` hook, and that hook answers whether the
/// bytes really left.
///
/// Two invariants hold this file together:
///   * **Peer identity** (§2.1 security boundary): a hello's self-declared pid
///     is honoured only when the kernel's view of the accepted descriptor
///     (`getpeereid` uid + `LOCAL_PEERPID`) matches it. `inbox.register` is
///     exactly what EngineCore reads as "this pid has a probe", so an
///     unverified peer never reaches it and cannot forge rollback or
///     attribution evidence (R5-01).
///   * **Single-owner descriptors** (A-17, R2-04): `stateLock` guards
///     `running`, `listenFD`, `ownedFDs`, `clientFDs`; a descriptor is closed
///     once by the thread that drops its ownership token, and command writes
///     hold that same lock, so a close cannot race a write.
public final class ProbeSocketServer {

    /// Concurrent probe clients, authenticated or not: beyond this a fresh
    /// connection is refused without a reader thread or a read buffer, so no
    /// peer can grow the daemon's thread count (R5-06). Refusal rather than
    /// eviction — an established probe is an evidence source, and closing one
    /// to admit a stranger would silently destroy a live act window (§5.2).
    public static let maxConcurrentClients = 8
    /// Read deadline before an authenticated hello: a silent peer cannot hold a
    /// thread plus a 64 KiB buffer indefinitely (R5-06).
    public static let preHelloReadTimeoutSeconds = 10
    /// Read deadline after registration. A unix socket reports peer death as
    /// EOF/ECONNRESET, so this only reaps half-open peers; it stays long
    /// enough that an idle-but-live app is never mistaken for one.
    public static let idleReadTimeoutSeconds = 900
    /// Budget for one command write, partial-write resumption included.
    public static let commandWriteTimeoutSeconds = 2
    static let listenBacklog = 8
    static let readerBufferSize = 64 * 1024

    public let socketPath: String
    public let inbox: ProbeInbox
    /// Fail-closed switch for peer authentication. Nothing in the daemon turns
    /// it off; it exists so an opt-out is a deliberate decision rather than a
    /// silent fallback path inside the reader.
    public let requireVerifiedPeer: Bool
    /// Take the probe name over even when a live listener owns it. Explicit
    /// operator intent only (`--force-probe-socket`); the default path never
    /// pre-empts, mirroring `SocketServer` (A-18).
    public let preemptsExistingSocket: Bool
    private let log: EngineLog
    /// Tri-state view of an occupied name (DaemonProbe.liveness with
    /// `waitForHello: false` by default — a probe listener never answers
    /// hello). Injected so the pre-emption decision is unit-testable without
    /// racing a real listener.
    private let livenessProbe: (String) -> DaemonProbe.Liveness

    private let stateLock = NSLock()
    private var running = false
    private var listenFD: Int32 = -1
    /// Every descriptor still owned: the listener plus accepted clients.
    /// Membership is the single ownership token (A-17).
    private var ownedFDs: Set<Int32> = []
    /// Authenticated probe pid -> fd.
    private var clientFDs: [Int32: Int32] = [:]

    public init(
        socketPath: String,
        inbox: ProbeInbox,
        log: EngineLog,
        requireVerifiedPeer: Bool = true,
        preemptsExistingSocket: Bool = false,
        livenessProbe: ((String) -> DaemonProbe.Liveness)? = nil
    ) {
        self.socketPath = socketPath
        self.inbox = inbox
        self.log = log
        self.requireVerifiedPeer = requireVerifiedPeer
        self.preemptsExistingSocket = preemptsExistingSocket
        self.livenessProbe = livenessProbe ?? { path in
            DaemonProbe().liveness(socketPath: path, waitForHello: false)
        }
    }

    /// Bind + listen and start the accept thread. Failure throws with errno.
    ///
    /// A-18: binding no longer unlinks first. An unconditional unlink+bind is
    /// how a second daemon stole probe.sock while the first kept serving
    /// engine.sock, splitting attribution across two processes. An occupied
    /// name is removed only when the tri-state probe demonstrates nobody owns
    /// it (stale file), or when `preemptsExistingSocket` carries explicit
    /// operator intent (`--force-probe-socket`, wired in main.swift).
    public func start() throws {
        let directory = (socketPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        if preemptsExistingSocket {
            // --force-probe-socket: main.swift has already named the incumbent
            // this run is displacing, so removing a live name *is* the intent.
            unlink(socketPath)
        }
        let fd: Int32
        do {
            fd = try bindListener()
        } catch ProbeServerError.nameOccupied(let bindDetail) {
            fd = try rebindAfterOwnershipCheck(bindDetail: bindDetail)
        }
        // 0600 is a hard security invariant (P6 §2.1, P0 §3.5): a probe socket
        // left on the umask lets any local process inject hello/handler/state
        // frames the daemon then upgrades into strong attribution. engine.sock
        // treats the identical failure as fatal, so this listener must too
        // (R6-09).
        guard chmod(socketPath, 0o600) == 0 else {
            let code = errno
            abandonListen(fd)
            unlink(socketPath)
            throw ProbeServerError.system(code, "chmod(0600)")
        }
        guard listen(fd, Int32(ProbeSocketServer.listenBacklog)) == 0 else {
            let code = errno
            abandonListen(fd)
            unlink(socketPath)
            throw ProbeServerError.system(code, "listen()")
        }

        inbox.sender = { [weak self] pid, data in
            guard let self else { return false }
            return self.writeToClient(pid: pid, data: data)
        }
        stateLock.lock()
        running = true
        stateLock.unlock()
        let thread = Thread { [weak self] in self?.acceptLoop() }
        thread.name = "glasspane.probe-socket"
        thread.start()
        log.info(
            "probe socket listening on \(socketPath) (peer credentials required="
                + "\(requireVerifiedPeer), max \(ProbeSocketServer.maxConcurrentClients) concurrent probes)"
        )
    }

    /// socket() + bind() with the descriptor-ownership dance: the fd lands in
    /// `listenFD`/`ownedFDs` before bind so every failure path reaps it
    /// through `abandonListen` (A-17). EADDRINUSE is reported as
    /// `.nameOccupied`, the fact `rebindAfterOwnershipCheck` decides on.
    private func bindListener() throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ProbeServerError.system(errno, "socket()") }
        stateLock.lock()
        listenFD = fd
        ownedFDs.insert(fd)
        stateLock.unlock()
        guard let address = socketAddress() else {
            abandonListen(fd)
            throw ProbeServerError.invalidPath(socketPath)
        }
        let bound = ProbeSocketServer.withReboundAddress(address) { pointer, length in
            bind(fd, pointer, length)
        }
        guard bound == 0 else {
            let code = errno
            abandonListen(fd)
            throw code == EADDRINUSE
                ? ProbeServerError.nameOccupied("bind(\(socketPath)): name already bound")
                : ProbeServerError.system(code, "bind(\(socketPath))")
        }
        return fd
    }

    /// The name was taken at bind time: clear it only when the tri-state
    /// probe demonstrates no owner (stale file). Same shape as
    /// `SocketServer.openListenSocket` — one retry, never a silent pre-empt.
    private func rebindAfterOwnershipCheck(bindDetail: String) throws -> Int32 {
        let incumbent = livenessProbe(socketPath)
        switch DaemonProbe.takeoverDecision(incumbent, force: false) {
        case .bind:
            guard case .noListener(let reason) = incumbent else {
                throw ProbeServerError.nameOccupied(bindDetail)
            }
            log.info("removing stale probe socket \(socketPath) (\(reason))")
            unlink(socketPath)
            // One retry only: a second EADDRINUSE is a real race with
            // another starting daemon, not a stale file.
            return try bindListener()
        case .refuse(let description):
            throw ProbeServerError.nameOccupied(description)
        case .preempt(let description):
            // Unreachable without the force flag (this call passes false);
            // the force path unlinks before the first bind instead.
            throw ProbeServerError.nameOccupied(description)
        }
    }

    public func stop() {
        stateLock.lock()
        running = false
        let listener = listenFD
        let clients = ownedFDs.filter { $0 != listener }
        stateLock.unlock()
        // Wake the reader threads and let each close *its own* descriptor on
        // the way out: stop() never closes a descriptor another thread may be
        // inside, which is the fd-reuse race main.swift's shutdown doctrine
        // calls out and what double-closed these descriptors before (A-17).
        for fd in clients { shutdown(fd, SHUT_RDWR) }
        wakeAccept(listener: listener)
        unlink(socketPath)
    }

    /// Unblock the accept thread without closing the descriptor it is blocked
    /// on: a self-connect makes `accept()` return a socket the loop refuses and
    /// closes, and the loop then reaps the listener itself. When no handshake is
    /// possible nobody is parked on it, so the listener is reaped right here.
    private func wakeAccept(listener: Int32) {
        guard listener >= 0 else { return }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            abandonListen(listener)
            return
        }
        defer { close(fd) }
        guard let address = socketAddress() else {
            abandonListen(listener)
            return
        }
        let connected = ProbeSocketServer.withReboundAddress(address) { pointer, length in
            connect(fd, pointer, length)
        }
        if connected != 0 {
            abandonListen(listener)
        }
    }

    // MARK: - Internals

    private func acceptLoop() {
        while true {
            stateLock.lock()
            let isRunning = running
            let listener = listenFD
            stateLock.unlock()
            guard isRunning, listener >= 0 else {
                abandonListen(listener)
                return
            }

            let clientFD = accept(listener, nil, nil)
            if clientFD < 0 {
                let code = errno
                stateLock.lock()
                let stillRunning = running
                stateLock.unlock()
                if code == EINTR, stillRunning { continue }
                if stillRunning {
                    log.error("probe accept failed: errno \(code) (\(ProbeSocketServer.systemMessage(code)))")
                }
                // This thread owns the listener, so this thread closes it;
                // whoever already took the `listenFD` slot is a no-op (R2-04).
                abandonListen(listener)
                return
            }

            stateLock.lock()
            let refused = !running || ownedFDs.count >= ProbeSocketServer.maxConcurrentClients
            if !refused { ownedFDs.insert(clientFD) }
            stateLock.unlock()
            if refused {
                log.error(
                    "probe connection refused: already owning \(ProbeSocketServer.maxConcurrentClients)"
                        + " clients (fd \(clientFD) closed unread, no thread started)"
                )
                close(clientFD)
                continue
            }
            let reader = Thread { [weak self] in self?.serve(clientFD: clientFD) }
            reader.name = "glasspane.probe-client"
            reader.start()
        }
    }

    private func serve(clientFD: Int32) {
        // The kernel's view of the peer, read once before any frame is trusted.
        let peer = ProbeSocketServer.peerIdentity(of: clientFD)
        var boundPID: Int32?
        var ignoredPreHello = 0
        var rejectedFrames = 0
        var readTimeoutSeconds = ProbeSocketServer.preHelloReadTimeoutSeconds
        configureClientSocket(clientFD, readTimeoutSeconds: readTimeoutSeconds, stage: "pre-hello")
        var codec = FrameCodec()
        let bufferSize = ProbeSocketServer.readerBufferSize
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: bufferSize, alignment: 16)
        defer { buffer.deallocate() }

        // One exit path for every disconnect: it records *why* in the inbox
        // (R2-18) and releases the descriptor exactly once (A-17).
        func detach(_ reason: String) {
            if let pid = boundPID {
                stateLock.lock()
                let ownsRegistration = (clientFDs[pid] ?? clientFD) == clientFD
                stateLock.unlock()
                if ownsRegistration {
                    inbox.disconnect(pid: pid, reason: reason)
                    log.info("probe pid \(pid) dropped: \(reason)")
                } else {
                    // A newer hello took this pid (§2.2 replacement): the old
                    // connection must not unregister the live one.
                    log.info("probe fd \(clientFD) superseded for pid \(pid); live registration kept (\(reason))")
                }
            } else {
                log.info("probe connection dropped before registration: \(reason)")
            }
            if ignoredPreHello > 0 {
                log.error(
                    "probe fd \(clientFD) sent \(ignoredPreHello) frame(s) ahead of an"
                        + " authenticated hello; none were ingested"
                )
            }
            if rejectedFrames > 0 {
                log.error("probe fd \(clientFD) had \(rejectedFrames) frame(s) rejected")
            }
            closeOwned(clientFD)
        }

        // Who ended the connection is measured at the moment of the hangup:
        // stop() shuts descriptors down and the reader wakes with EOF or
        // ECONNRESET, which looks exactly like a peer hanging up.
        func hangupReason(_ peerReason: String) -> String {
            stateLock.lock()
            let isRunning = running
            stateLock.unlock()
            return isRunning ? peerReason : "daemon stopped the probe listener"
        }

        while true {
            stateLock.lock()
            let isRunning = running
            stateLock.unlock()
            guard isRunning else {
                detach("daemon stopped the probe listener")
                return
            }

            let received = read(clientFD, buffer, bufferSize)
            if received == 0 {
                detach(hangupReason("peer closed the connection (EOF)"))
                return
            }
            if received < 0 {
                // EOF, an interrupted read, an expired deadline and a failed
                // read are four different facts (R2-18).
                let code = errno
                if code == EINTR { continue }
                if code == EAGAIN || code == EWOULDBLOCK {
                    detach("read deadline of \(readTimeoutSeconds)s expired without data")
                    return
                }
                detach(hangupReason("read failed: errno \(code) (\(ProbeSocketServer.systemMessage(code)))"))
                return
            }

            for event in codec.append(Data(bytes: buffer, count: received)) {
                guard case .frame(let payload) = event else {
                    log.error("probe frame oversize; dropping line")
                    continue
                }
                let frame = ProbeWire.decode(payload)
                if case .hello(let hello) = frame {
                    if let reason = acceptHello(hello, peer: peer, clientFD: clientFD, alreadyBoundTo: boundPID) {
                        detach(reason)
                        return
                    }
                    boundPID = hello.pid
                    readTimeoutSeconds = ProbeSocketServer.idleReadTimeoutSeconds
                    configureClientSocket(clientFD, readTimeoutSeconds: readTimeoutSeconds, stage: "post-hello")
                    continue
                }
                guard let pid = boundPID else {
                    // Not ingested, but counted and logged at close, so a probe
                    // that never got authenticated is not silently ignored.
                    ignoredPreHello += 1
                    continue
                }
                if case .malformed(let reason) = frame {
                    log.error("probe frame malformed from pid \(pid): \(reason)")
                    rejectedFrames += 1
                    continue
                }
                inbox.ingest(pid: pid, frame: frame)
            }
        }
    }

    /// Authenticate one hello and admit it. Returns nil when the connection may
    /// start streaming, otherwise the reason the connection is dropped: an
    /// unverified or over-capacity peer is never half-trusted.
    private func acceptHello(
        _ hello: ProbeHello,
        peer: ProbeSocketServer.PeerIdentity,
        clientFD: Int32,
        alreadyBoundTo boundPID: Int32?
    ) -> String? {
        if let boundPID, boundPID != hello.pid {
            // One connection is one peer process. A second hello naming a
            // different pid would let a single socket accumulate registrations
            // without bound and hide another process's events behind this
            // connection's identity (R5-06).
            return "hello rejected: it claims pid \(hello.pid) but this connection is authenticated as pid \(boundPID)"
        }
        if requireVerifiedPeer,
           let rejection = ProbeSocketServer.helloRejectionReason(
                claimedPID: hello.pid, peer: peer, daemonUID: ProbeSocketServer.daemonUID
           ) {
            log.error("probe hello rejected (app \(hello.appName) v\(hello.probeVersion)): \(rejection)")
            return "peer credential check failed: \(rejection)"
        }
        guard inbox.register(hello) else {
            return "registration refused: \(ProbeInbox.maxRegisteredProbes) distinct probe pids already registered"
        }
        stateLock.lock()
        guard ownedFDs.contains(clientFD) else {
            // Defensive: only this thread closes a client descriptor, so this
            // fires if that ever stops being true. Undo the registration we
            // just made — a closed connection must not read as connected.
            stateLock.unlock()
            inbox.disconnect(pid: hello.pid, reason: "connection closed while its hello was being admitted")
            return "connection was closed while its hello was being admitted"
        }
        clientFDs[hello.pid] = clientFD
        stateLock.unlock()
        let uidText = peer.uid.map { "\($0)" } ?? "unreadable"
        log.info(
            "probe connected: \(hello.appName) pid \(hello.pid) v\(hello.probeVersion)"
                + " caps [\(hello.capabilities.joined(separator: ","))] — peer uid \(uidText) authenticated"
        )
        // No `hello_ack`: the §2.1 command whitelist has no ack frame and
        // nothing enforced the rate it advertised, so the frame only implied a
        // control that does not exist (R6-13).
        return nil
    }

    // MARK: - Descriptor ownership (A-17, R2-04)

    /// Reap the listening descriptor exactly once. The `listenFD` slot is the
    /// ownership token: whoever nulls it closes it, so a stale or already-reaped
    /// value can never close a recycled descriptor (R2-04).
    private func abandonListen(_ fd: Int32) {
        guard fd >= 0 else { return }
        stateLock.lock()
        defer { stateLock.unlock() }
        guard listenFD == fd else { return }
        listenFD = -1
        ownedFDs.remove(fd)
        close(fd)
    }

    /// Close one owned client descriptor. Membership of `ownedFDs` is the
    /// ownership token, so a descriptor already closed by its own reader is not
    /// closed again; its pid route goes away with it.
    private func closeOwned(_ fd: Int32) {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard ownedFDs.remove(fd) != nil else { return }
        for pid in clientFDs.filter({ $0.value == fd }).map({ $0.key }) {
            clientFDs.removeValue(forKey: pid)
        }
        close(fd)
    }

    /// Per-connection socket options: `SO_NOSIGPIPE` so a write towards a probe
    /// that already hung up cannot kill the daemon, and `SO_RCVTIMEO` so an idle
    /// peer cannot pin a reader thread (R5-06). Failures are reported with their
    /// errno, never swallowed — an unbounded read or a fatal pipe signal is the
    /// fact an operator needs.
    private func configureClientSocket(_ fd: Int32, readTimeoutSeconds: Int, stage: String) {
        var noSigPipe: Int32 = 1
        if setsockopt(
            fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size)
        ) != 0 {
            let code = errno
            log.error("probe \(stage) SO_NOSIGPIPE not applied to fd \(fd): errno \(code)"
                + " (\(ProbeSocketServer.systemMessage(code)))")
        }
        var timeout = timeval(tv_sec: readTimeoutSeconds, tv_usec: 0)
        if setsockopt(
            fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)
        ) != 0 {
            let code = errno
            log.error("probe \(stage) SO_RCVTIMEO(\(readTimeoutSeconds)s) not applied to fd \(fd): errno \(code)"
                + " (\(ProbeSocketServer.systemMessage(code))) — reader may block")
        }
    }

    /// Write one command line to an authenticated probe. `stateLock` is held for
    /// the whole write so the descriptor cannot be closed underneath it (A-17),
    /// and the write is bounded by `commandWriteTimeoutSeconds` so a probe that
    /// stopped draining cannot pin a dispatcher thread. Every failure path logs
    /// its errno and returns false: a command that never left the daemon is
    /// reported, never presented as the probe falling silent (R2-07; mirrors
    /// SocketServer.writeAll, EINTR retry included).
    private func writeToClient(pid: Int32, data: Data) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard let fd = clientFDs[pid], ownedFDs.contains(fd) else {
            log.error("probe command not sent to pid \(pid): no live connection")
            return false
        }
        guard !data.isEmpty else { return true }
        let deadline = Date().addingTimeInterval(Double(ProbeSocketServer.commandWriteTimeoutSeconds))
        let total = data.count
        var offset = 0
        while offset < total {
            if let blocked = ProbeSocketServer.waitWritable(fd, deadline: deadline) {
                log.error("probe command for pid \(pid) NOT DELIVERED: fd \(fd) \(blocked),"
                    + " wrote \(offset)/\(total) bytes")
                return false
            }
            let written = data.withUnsafeBytes { raw -> Int in
                guard let base = raw.baseAddress else { return -1 }
                return write(fd, base.advanced(by: offset), total - offset)
            }
            if written <= 0 {
                let code = errno
                if code == EINTR { continue }
                log.error("probe command for pid \(pid) NOT DELIVERED after \(offset)/\(total) bytes:"
                    + " errno \(code) (\(ProbeSocketServer.systemMessage(code)))")
                return false
            }
            offset += written
        }
        return true
    }

    /// Wait for write-readiness against an absolute deadline: nil means
    /// writable, a string says why it is not — a stalled peer, an expired
    /// budget and a failed `poll` stay three different facts. Needed because a
    /// blocking write to a peer that stopped reading would otherwise hold the
    /// descriptor lock for the kernel's own unbounded timeout.
    private static func waitWritable(_ fd: Int32, deadline: Date) -> String? {
        let writableFlag = Int16(POLLOUT)
        while true {
            let remainingMs = Int(deadline.timeIntervalSinceNow * 1000)
            if remainingMs <= 0 {
                return "not writable within \(ProbeSocketServer.commandWriteTimeoutSeconds)s (peer stopped draining)"
            }
            var waiter = pollfd(fd: fd, events: writableFlag, revents: 0)
            let ready = poll(&waiter, 1, Int32(min(remainingMs, 1000)))
            if ready > 0 {
                if (waiter.revents & writableFlag) != 0 { return nil }
                return "poll reports revents \(waiter.revents) (peer gone)"
            }
            if ready < 0 {
                let code = errno
                if code == EINTR { continue }
                return "poll failed: errno \(code) (\(ProbeSocketServer.systemMessage(code)))"
            }
            // Slice elapsed: loop on, the deadline check above tops it up.
        }
    }

    /// `sockaddr_un` for this server's path, nil when the path does not fit.
    private func socketAddress() -> sockaddr_un? {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let copied = socketPath.withCString { source in
            withUnsafeMutableBytes(of: &address.sun_path) { destination in
                guard let base = destination.baseAddress else { return false }
                _ = strncpy(base.assumingMemoryBound(to: CChar.self), source, destination.count)
                return true
            }
        }
        return copied ? address : nil
    }

    /// bind() at startup and connect() at shutdown need the same sockaddr
    /// rebound dance — one copy, so the two paths cannot drift apart.
    private static func withReboundAddress(
        _ address: sockaddr_un, _ apply: (UnsafePointer<sockaddr>, socklen_t) -> Int32
    ) -> Int32 {
        withUnsafePointer(to: address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { rebound in
                apply(rebound, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
    }

    // MARK: - Peer credentials (R5-01)

    /// The kernel's own view of the process on the other end of an accepted
    /// descriptor. A nil field means the syscall failed or returned nothing
    /// usable — callers must read that as *unverified*, never as a guess.
    public struct PeerIdentity: Equatable {
        public let pid: Int32?
        public let uid: uid_t?
        public let pidErrno: Int32?
        public let uidErrno: Int32?
    }

    /// uid of the running daemon: the only peer uid a probe hello may carry.
    static let daemonUID: uid_t = geteuid()

    /// Peer credentials of an accepted socket: `getpeereid` for the uid and
    /// `LOCAL_PEERPID` at `SOL_LOCAL` for the pid.
    static func peerIdentity(of fd: Int32) -> PeerIdentity {
        var uidValue: uid_t?
        var uidErrnoValue: Int32?
        var uid = uid_t(0)
        var gid = gid_t(0)
        if getpeereid(fd, &uid, &gid) == 0 {
            uidValue = uid
        } else {
            uidErrnoValue = errno
        }

        var pidValue: Int32?
        var pidErrnoValue: Int32?
        var peerPID = pid_t(0)
        var length = socklen_t(MemoryLayout<pid_t>.size)
        let pidCall = withUnsafeMutablePointer(to: &peerPID) { pointer in
            getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pointer, &length)
        }
        if pidCall != 0 {
            pidErrnoValue = errno
        } else if peerPID <= 0 {
            pidErrnoValue = EINVAL
        } else {
            pidValue = peerPID
        }
        return PeerIdentity(pid: pidValue, uid: uidValue, pidErrno: pidErrnoValue, uidErrno: uidErrnoValue)
    }

    /// Pure authentication decision, extracted so the rejection path is unit
    /// testable without a live socket pair. nil means the hello may be honoured;
    /// any string is the reason it is refused. Fail-closed on unreadable
    /// credentials: an unverified peer must not become evidence that "the
    /// handler really ran" (R5-01).
    public static func helloRejectionReason(
        claimedPID: Int32, peer: PeerIdentity, daemonUID: uid_t
    ) -> String? {
        guard let peerUID = peer.uid else {
            let code = peer.uidErrno.map { "\($0)" } ?? "n/a"
            return "peer uid unreadable (getpeereid errno \(code))"
        }
        guard let peerPID = peer.pid else {
            let code = peer.pidErrno.map { "\($0)" } ?? "n/a"
            return "peer pid unreadable (LOCAL_PEERPID errno \(code))"
        }
        if peerUID != daemonUID {
            return "peer uid \(peerUID) is not the daemon uid \(daemonUID)"
        }
        if peerPID != claimedPID {
            return "hello declares pid \(claimedPID) but the socket peer is pid \(peerPID)"
        }
        return nil
    }

    private static func systemMessage(_ code: Int32) -> String {
        String(cString: strerror(code))
    }
}

public enum ProbeServerError: Error, CustomStringConvertible {
    case system(Int32, String)
    case invalidPath(String)
    /// Another listener owns the name and was not forcibly displaced (A-18).
    case nameOccupied(String)

    public var description: String {
        switch self {
        case .system(let code, let where_): return "probe socket \(where_) failed: errno \(code)"
        case .invalidPath(let path): return "invalid probe socket path: \(path)"
        case .nameOccupied(let detail):
            return "probe socket name in use: \(detail) — refusing to unlink a name a live listener owns; pass --force-probe-socket to pre-empt explicitly"
        }
    }
}
