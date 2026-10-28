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
    /// 本实例 bind 成功那一刻 socket 的 (st_dev, st_ino)。上面文件头那句"never unlink a
    /// socket file this instance did not create"从前只由 `didUnlinkOnExit` 这一个布尔撑着，
    /// 而它证明的是"我删过/我打算删"，不是"这个名字还指着我的 socket"——`--force-socket`
    /// 让前任与继任握着同一个路径字符串，于是它成了一条没有实现的主张（本轮修的缺陷）。
    private var boundInode: SocketInode?

    /// A client that stops mid-line may not pin the single-client daemon
    /// forever (B-12): this is the absolute budget for one *incomplete* frame.
    /// Silent periods between complete frames are never timed out — a
    /// long-lived session legitimately idles between calls.
    static let partialLineTimeoutSeconds: TimeInterval = 60

    /// 一条连接**一个字节都没发过**的绝对预算。它不是上面那条规则里的"空闲"：
    /// 空闲说的是**完整帧之间**的安静，而这里连第一帧都不曾开始过，会话还不存在。
    /// 产品里没有任何"连上却不说话"的正经用途——生产的传输是"有请求才连、连上就写"
    /// （`mcp-shell/src/engine-client.ts` 的 `ReconnectingSocketIo.writeLine` 先
    /// `connect()` 再 `writeLine`），daemon 自己的单实例探针也先写 hello 再等回应
    /// （`DaemonProbe.liveness`）。所以能被这条时限命中的只有一种对端：同机任意进程
    /// `connect()` 之后一字不发。从前那样的对端能把这个只有单一客户端位置的 daemon
    /// 钉死在第一次 `read()` 上（B-12 读侧最左的一格）：真正的 agent 永远排不进来，
    /// 而 `serve()` 回不到循环顶部，`shutdownRequested` 也永远无从被看见。
    static let firstByteTimeoutSeconds: TimeInterval = 10

    /// 会话空闲期回头看 `shutdownRequested` 的轮询切片。**不是**超时策略：切片到点
    /// 什么都不丢（判据见 `silenceTimeoutAction`），它只是把一次可能永不返回的
    /// `read()` 换成有界的 `poll()`，让"对端一直安静"时循环顶部那条判据仍然被执行。
    /// 空闲语义本身照旧：长期会话在两次调用之间可以一直等着。
    static let idlePollSliceSeconds: TimeInterval = 0.5

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
        // 只删自己那一个 inode（见 `SocketNameOwnership`）：`--force-socket` 之后这个
        // 字符串可能正指着继任者**正在监听**的 socket。
        if SocketNameOwnership.removeIfOurs(recorded: boundInode, atPath: socketPath) {
            log.info("socket removed \(socketPath)")
        } else {
            log.info("left \(socketPath) in place: the name no longer points at the socket this instance bound")
        }
        didUnlinkOnExit = false
        boundInode = nil
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
            SocketNameOwnership.removeIfOurs(recorded: boundInode, atPath: socketPath)
            didUnlinkOnExit = false
            boundInode = nil
        }
    }

    // MARK: - Bind

    /// socket → bind → chmod → listen, with at most one evidence-based unlink
    /// retry. Every failure path closes only the descriptor it created and
    /// throws, and none of them touches `listenFD`.
    private func openListenSocket() throws -> Int32 {
        if preemptsExistingSocket {
            // --force-socket: main.swift has already named the incumbent this
            // run is displacing, so removing a live *socket* is the intent. It is
            // never an intent to delete somebody's file: the flag says "take this
            // name over", and a regular file / directory / symlink under that name
            // is not a name the daemon ever owned. Same lstat as the stale-socket
            // path below, applied before the unlink instead of after a failed bind.
            guard DaemonProbe.nameIsClearableSocketName(socketPath) else {
                throw SocketErrorResponse.nameOccupied(DaemonProbe.nonSocketNameDescription(socketPath))
            }
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
                // "没有 daemon 在应答" 不等于 "这是个可以删的残留 socket"。ENOTSOCK 也被算进
                // noListener，而普通文件/目录/FIFO/悬空链接都回它——这一眼 lstat 是本方法与
                // 文件头那句承诺（只在"确实证明无主"时才移除）之间唯一的差别。
                guard DaemonProbe.nameIsClearableSocketName(socketPath) else {
                    throw SocketErrorResponse.nameOccupied(DaemonProbe.nonSocketNameDescription(socketPath))
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
        // `bind()` follows a symlink in the leaf: `~/.glasspane/engine.sock -> /elsewhere/x`
        // creates the listener at the target, the 0600 chmod acts through the link, and the
        // unlink on shutdown removes the link. Neither of the two existing name guards can
        // see it — they both run on an EADDRINUSE path, and this shape binds successfully.
        // The name the daemon publishes has to be one it owns, measured before the bind.
        guard DaemonProbe.nameIsClearableSocketName(socketPath) else {
            throw SocketErrorResponse.nameOccupied(DaemonProbe.nonSocketNameDescription(socketPath))
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw SocketErrorResponse.system(errno, "socket()")
        }

        // 容量判定在 `UnixSocketAddress` 里：`strncpy` 对超长名字是静默截断，
        // 截断后 bind() 会成功，但绑的是**另一个**名字——随后 chmod/unlink 打在
        // 全名上双双 ENOENT，而这条路径原本承诺回 `invalidPath`。
        guard var address = UnixSocketAddress.address(for: socketPath) else {
            close(fd)
            throw SocketErrorResponse.invalidPath(socketPath)
        }

        // 名字以 `0777 & ~umask` 创建，所以 0600 这条硬不变量要从 bind 那一刻就成立，
        // 不能等下面那句 chmod 去补（`SocketBindGuard` 记了为什么）。
        let bindResult = SocketBindGuard.bindWithPrivateMode {
            withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                    bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
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
        // 记下"这个名字此刻是我这个 socket"的那对 (st_dev, st_ino)——bind 刚成功时取
        // `lstat`，记下的就是本实例建的那个 inode（`SocketNameOwnership` 记了为什么不能用
        // `fstat`）。`--force-socket` 让两个实例握着同一个路径字符串，而下面每一处 unlink
        // 都是按字符串动手的。
        boundInode = SocketNameOwnership.currentInode(atPath: socketPath)
        guard chmod(socketPath, 0o600) == 0 else {
            let code = errno
            close(fd)
            SocketNameOwnership.removeIfOurs(recorded: boundInode, atPath: socketPath)
            didUnlinkOnExit = false
            boundInode = nil
            throw SocketErrorResponse.system(code, "chmod(0600)")
        }
        guard listen(fd, 1) == 0 else {
            let code = errno
            close(fd)
            SocketNameOwnership.removeIfOurs(recorded: boundInode, atPath: socketPath)
            didUnlinkOnExit = false
            boundInode = nil
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
        let home = NSHomeDirectory()
        if directory != home, !directory.hasPrefix(home + "/") {
            log.info("socket directory \(directory) is outside \(home) — isolating it by ownership, not by home scope")
        }
        // 判据本体在 `SocketDirectoryRule`，与探针监听者共用一份（X-25）：两条路过去各
        // 写一遍，探针那份连 chmod 都没有。
        if let defect = SocketDirectoryRule.enforce(directory: directory) {
            throw SocketErrorResponse.insecureDirectory(directory, defect)
        }
    }

    // MARK: - Connection service

    /// Serve one connection. Three bounds keep a misbehaving client from pinning
    /// the single-client daemon (B-12): an absolute budget on the connection's
    /// **first byte**, an absolute deadline on an *incomplete* line, and
    /// `SO_SNDTIMEO` on the writes going back. A connection that has already
    /// spoken and is resting between complete frames is timed out by none of
    /// them — it is only polled in slices, so `shutdownRequested` stays
    /// observable through a silent period (see `clientReadPlan`).
    ///
    /// 不是 `private`：首字节时限与空闲切片这两条判据必须能在**真 socketpair** 上被
    /// 确定性验红（"沉默的对端到点被拒"与"空闲的会话不许被踢"都藏在控制流里，藏在
    /// private 里就没人测得到）。理由与 `writeBounded`/`writeAll` 那条一样：`@testable`
    /// 只到 internal。两个预算参数默认取生产常量，测试把首字节预算调小才等得起
    /// （`writeAll` 的 `budgetSeconds:` 是同一条先例）。
    func serve(
        clientFD: Int32,
        firstByteBudget: TimeInterval = SocketServer.firstByteTimeoutSeconds,
        idleSlice: TimeInterval = SocketServer.idlePollSliceSeconds
    ) {
        var sendTimeout = timeval(tv_sec: Int(Self.clientSendTimeoutSeconds), tv_usec: 0)
        _ = setsockopt(
            clientFD, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout,
            socklen_t(MemoryLayout<timeval>.size)
        )

        var codec = FrameCodec()
        var buffer = [UInt8](repeating: 0, count: 65536)
        var lineDeadline: SocketDeadline?
        var firstByteDeadline: SocketDeadline?
        var spokeOnce = false
        while !dispatcher.core.shutdownRequested {
            // 武装与判据都在轮询之前取：一轮只问一次，避免"武装规则"和"等待规则"
            // 各说各话（半帧挂起却没被计时，或空闲会话被当成沉默的新连接踢掉）。
            let plan = Self.clientReadPlan(
                codec: codec,
                spokeOnce: spokeOnce,
                existingLineDeadline: lineDeadline,
                existingFirstByteDeadline: firstByteDeadline,
                firstByteBudget: firstByteBudget,
                idleSliceSeconds: idleSlice
            )
            lineDeadline = plan.lineDeadline
            firstByteDeadline = plan.firstByteDeadline

            switch BoundedSocket.wait(clientFD, events: Int16(POLLIN), deadline: plan.wait.deadline) {
            case .ready:
                break
            case .timedOut:
                switch Self.silenceTimeoutAction(for: plan.wait, codec: codec) {
                case .close(let reason):
                    log.error(reason)
                    return
                case .keepWaiting:
                    // 空闲切片到头。这条连接什么都不知道，我们只是回头看了它一眼
                    // `shutdownRequested`——绝不允许在这里关闭：长期会话就靠这一句活着。
                    continue
                }
            case .failed(let code):
                log.error("client poll failed: \(BoundedSocket.errnoText(code)) (errno \(code)) — closing connection")
                return
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
            // 走到这里，这条连接已经开过口了：它从此是"会话"，受空闲语义保护，
            // 不再受首字节预算的约束（判据在 `firstByteDeadline`）。
            spokeOnce = true
            let events = codec.append(Data(buffer[0..<readCount]))
            for event in events {
                let response = dispatcher.handle(event)
                guard writeAll(clientFD, response) else { return }
            }
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

    /// 首字节时限的武装判据，形状与 `partialLineDeadline` 一致（纯函数，假时钟可驱动）。
    /// 与它不同的一点：这里问的是"这条连接开过口没有"，而不是"buffer 里有没有货"——
    /// 半帧的预算按帧计，首字节的预算按**连接**计，一次都不许多给。
    /// `existing ?? …`：装好之后不被顶掉，否则滴一个字节的对端每轮把时钟拨回原点，
    /// 绝对时限就退化成了一次 syscall 的超时（R5-07 那一课，见 `writeBounded` 的注释）。
    static func firstByteDeadline(
        spokeOnce: Bool,
        existing: SocketDeadline?,
        budgetSeconds: TimeInterval = SocketServer.firstByteTimeoutSeconds,
        now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) -> SocketDeadline? {
        guard !spokeOnce else { return nil }
        return existing ?? SocketDeadline(seconds: budgetSeconds, now: now)
    }

    /// 这一轮 POLLIN 的等待属于哪一段安静。三段必须**带着身份**返回，因为它们的到点
    /// 处置不一样：两段关闭（各自有绝对预算），一段什么都不丢（空闲切片）。
    enum ClientReadWait {
        /// 连接还没发过一个字节：`firstByteTimeoutSeconds` 的绝对预算。
        case firstByte(SocketDeadline)
        /// 一帧写了一半挂着：`partialLineTimeoutSeconds` 的绝对预算。
        case partialLine(SocketDeadline)
        /// 已开过口的会话停在帧与帧之间：只有切片，安静本身不是罪。
        case idleSlice(SocketDeadline)

        var deadline: SocketDeadline {
            switch self {
            case .firstByte(let deadline), .partialLine(let deadline), .idleSlice(let deadline):
                return deadline
            }
        }
    }

    /// 到点之后这段安静意味着什么。抽成纯函数的理由是那条老规矩：`serve` 里的控制流
    /// 测不到，而"空闲不许踢、沉默的新连接要拒"这件事恰恰只能由判据本身钉住。
    enum SilenceTimeoutAction: Equatable {
        case close(reason: String)
        case keepWaiting
    }

    /// 读侧一轮的完整计划：武装两条绝对预算，再决定这一轮该怎么等。
    /// 武装与判据同出一处，所以两者不可能分叉——半帧一定会被计时，开过口的空闲会话
    /// 永远不会被当成沉默的新连接。`serve()` 每轮从这里取，测试用假时钟驱动它。
    static func clientReadPlan(
        codec: FrameCodec,
        spokeOnce: Bool,
        existingLineDeadline: SocketDeadline?,
        existingFirstByteDeadline: SocketDeadline?,
        firstByteBudget: TimeInterval = SocketServer.firstByteTimeoutSeconds,
        idleSliceSeconds: TimeInterval = SocketServer.idlePollSliceSeconds,
        now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) -> (wait: ClientReadWait, lineDeadline: SocketDeadline?, firstByteDeadline: SocketDeadline?) {
        let line = partialLineDeadline(for: codec, existing: existingLineDeadline, now: now)
        let firstByte = firstByteDeadline(
            spokeOnce: spokeOnce, existing: existingFirstByteDeadline, budgetSeconds: firstByteBudget, now: now
        )
        let wait: ClientReadWait
        if codec.awaitsNewline, let line {
            wait = .partialLine(line)
        } else if !spokeOnce, let firstByte {
            wait = .firstByte(firstByte)
        } else {
            wait = .idleSlice(SocketDeadline(seconds: idleSliceSeconds, now: now))
        }
        return (wait: wait, lineDeadline: line, firstByteDeadline: firstByte)
    }

    /// 一次超时到点的处置。`.idleSlice` 一律 `keepWaiting`：它是"多久回头看一次
    /// `shutdownRequested`"的切片，不是会话的死刑。
    static func silenceTimeoutAction(
        for wait: ClientReadWait,
        codec: FrameCodec
    ) -> SilenceTimeoutAction {
        switch wait {
        case .partialLine(let deadline):
            // 丢弃超长帧时 pendingBytes 恒为 0，照原样打印就成了"客户端
            // 一个字节都没发却卡住了我们"——原因恰恰在它发了太多字节。
            let buffered = codec.isDiscardingOversizeFrame
                ? "an oversize frame being discarded"
                : "\(codec.pendingBytes) buffered byte(s)"
            return .close(reason: "client left an incomplete line (\(buffered)) with no newline within \(Int(deadline.seconds))s — closing the connection instead of waiting forever")
        case .firstByte(let deadline):
            return .close(reason: "client connected and never sent a single byte within \(Int(deadline.seconds))s — closing the connection: a peer that has not spoken is not an idle session, and letting it hold the only client slot would lock every real agent out (B-12)")
        case .idleSlice:
            return .keepWaiting
        }
    }

    /// 一次回包的**总**预算。`SO_SNDTIMEO` 是单次 syscall 的超时并且每轮重置，所以从前
    /// 一个每 29s 读走 1 字节的对端可以把这个只有单一客户端的 daemon  indefinitely 钉在
    /// 同一条回包里——读侧早就有绝对时限（`partialLineDeadline`），写侧没有。30s 与
    /// `SO_SNDTIMEO` 同值：那条继续负责"这一笔 syscall 愿意等多久"，这条负责"这次回复
    /// 一共允许花多久"。
    static let replyWriteBudgetSeconds: TimeInterval = 30

    /// 把 `data` 写进 `fd`，只允许在 `deadline` 之前写完。**这是判据本体**：抽成不带实例的
    /// 静态函数，是为了让它能被真 socketpair + 假时钟确定性验红（"另一端不读时必须到点就停"
    /// 这件事，藏在实例方法里就没人测得到）。返回 false 意味着这一帧没写完，调用方必须
    /// 关掉这条连接——继续等下去就是把单客户端的位置交给一个不读的对端。
    static func writeBounded(
        _ fd: Int32,
        _ data: Data,
        deadline: SocketDeadline,
        budgetSeconds: TimeInterval,
        note: (String) -> Void = { _ in }
    ) -> Bool {
        var offset = data.startIndex
        func gaveUp(_ why: String, _ sent: Int) -> Bool {
            note("reply not fully sent \(why) after \(sent)/\(data.count) bytes within \(budgetSeconds)s of absolute budget — closing connection rather than holding the single client slot")
            return false
        }
        while offset < data.endIndex {
            let sent = data.distance(from: data.startIndex, to: offset)
            if deadline.expired() { return gaveUp("stalled", sent) }
            switch BoundedSocket.wait(fd, events: Int16(POLLOUT), deadline: deadline) {
            case .ready:
                break
            case .timedOut:
                return gaveUp("waiting for writability", sent)
            case .failed(let code):
                return gaveUp("after poll(POLLOUT) failed (\(BoundedSocket.errnoText(code)))", sent)
            }
            let written = data.withUnsafeBytes { raw -> Int in
                let base = raw.baseAddress!.advanced(by: data.distance(from: data.startIndex, to: offset))
                return write(fd, base, data.distance(from: offset, to: data.endIndex))
            }
            if written <= 0 {
                let code = errno
                if code == EINTR { continue }
                // 单次 syscall 到点（`SO_SNDTIMEO`）不再算失败：回到 poll 继续等，
                // 但等的是同一个绝对预算——这正是"串行化不等于有界"要补的那一课。
                if code == EAGAIN || code == EWOULDBLOCK { continue }
                note("write failed: \(BoundedSocket.errnoText(code)) (errno \(code)) — reply not fully sent, closing connection")
                return false
            }
            offset = data.index(offset, offsetBy: written)
        }
        return true
    }

    /// 不是 `private`：绝对预算这条判据必须能被确定性验红（真 socketpair + 不读的那一端），
    /// 而 `@testable` 只到 internal。
    func writeAll(_ fd: Int32, _ data: Data, budgetSeconds: TimeInterval = SocketServer.replyWriteBudgetSeconds) -> Bool {
        SocketServer.writeBounded(fd, data,
                                 deadline: SocketDeadline(seconds: budgetSeconds),
                                 budgetSeconds: budgetSeconds,
                                 note: { message in self.log.error(message) })
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
