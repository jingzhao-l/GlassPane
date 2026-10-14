import Testing
import Foundation
import Darwin
@testable import GlassPaneEngine

/// B-12 读侧的第一格：一条**一个字节都没发过**的连接，不许把这个只有单一客户端位置的
/// daemon 钉在它自己的第一次 `read()` 上。
///
/// 修的两件事各有能红的对照：
///   1. 首字节绝对预算（`SocketServer.firstByteDeadline` / `.clientReadPlan` /
///      `.silenceTimeoutAction`）——沉默的对端到点被拒，`serve` 返回，accept 循环
///      （`SocketServer.run`）才重新拿到那个位置；
///   2. 空闲期的有界轮询切片——会话安静时 `dispatcher.core.shutdownRequested` 仍然被
///      回头看（`serve` 每轮循环顶部的判据），而**切片到点什么都不丢**：帧与帧之间的
///      安静照旧永不超时（`SocketServer` 类型注释里那条 `partialLineTimeoutSeconds` 语义）。
///
/// 两套工具分工明确：时间是判据，用假时钟驱动（`partialLineDeadline` 抽成纯函数就是为
/// 这个，见 `FrameCodecTests`）；"对端确实一个字没发 / 确实还在服务"是事实，用真
/// socketpair（`DailyRound20261012Tests` 的 `writeBounded` 是同一先例：真 socketpair
/// 加会跳的假时钟）。
@Suite("B-12 read side: a client that never speaks cannot hold the only slot")
struct SilentClientDeadlineTests {

    // MARK: - 夹具

    /// daemon 自己那条单实例探针发的就是这一行（`DaemonProbe.liveness`），所以这是最省的
    /// **合法**帧：本文件的靶子是发不出声的那种对端，不是这一种。
    private static let helloFrame = Data("{\"id\":0,\"method\":\"hello\"}\n".utf8)

    /// 日志的落笔处被换成一个可读数组的 `EngineLog`，**quiet: true**——即发布形态。
    /// 这里顺带钉住另一件事：`EngineLog` 从前把 ERROR 与 INFO 一起被 quiet 吞掉，那样
    /// 下面每一条"这句 ERROR 必须出现"的断言都会红。ERROR 可见性不是这些断言的顺手
    /// 副产品，而是它们的前提。
    private final class CapturedEngineLog: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [String] = []

        var log: EngineLog {
            EngineLog(quiet: true, sink: { data in
                self.lock.lock()
                self.storage.append(String(decoding: data, as: UTF8.self))
                self.lock.unlock()
            })
        }

        var lines: [String] {
            lock.lock(); defer { lock.unlock() }
            return storage
        }

        var text: String { lines.joined() }
    }

    /// 一次后台 `serve`。判据失效时这条测试要回一个**具名的失败**（"没在 X 秒内返回"），
    /// 而不是把整个套件挂在那次无界的 `read()` 上——`ReviewLifecycleTests` 记过这笔账
    /// （删掉守卫的读数必须是 red，不是 stuck）。
    private final class ServingConnection: @unchecked Sendable {
        private let lock = NSLock()
        private var returned = false
        private let finished = DispatchSemaphore(value: 0)
        private let work: () -> Void

        init(_ work: @escaping () -> Void) { self.work = work }

        func start() {
            DispatchQueue.global(qos: .userInitiated).async {
                self.work()
                self.lock.lock()
                self.returned = true
                self.lock.unlock()
                self.finished.signal()
            }
        }

        /// 已经回来了吗。用来表达"不该回来的现在不许回来"。
        var hasReturned: Bool {
            lock.lock(); defer { lock.unlock() }
            return returned
        }

        @discardableResult
        func waitForReturn(within limit: TimeInterval) -> Bool {
            finished.wait(timeout: .now() + limit) == .success
        }
    }

    /// 真 socketpair：`daemonFD` 交给 `serve` 当作已 accept 的那一手，`peerFD` 是对端。
    /// 开不了就当场失败——"socketpair 没成就跳过"会让这一条永远绿。
    private static func openSocketPair() throws -> (daemonFD: Int32, peerFD: Int32) {
        var pair: [Int32] = [0, 0]
        try #require(
            socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0,
            "夹具要能真开一对 socket（errno \(errno)）"
        )
        return (daemonFD: pair[0], peerFD: pair[1])
    }

    /// `serve()` 不 bind、也不碰 `socketPath`，这个名字只是这台 server 的名片；沙箱外的
    /// 一处名字不许出现在测试树里（`TestIsolationGateTests`）。通道用测试树里那套
    /// `ScriptedChannel`，与 `ReviewLifecycleTests.makeServer` 同一形状——`hello` 一句
    /// 都不问通道，所以这里不给它配任何它用不上的答案。
    private static func makeServedPair(log: EngineLog) -> (server: SocketServer, core: EngineCore) {
        let core = EngineCore(
            channel: ScriptedChannel(fallbackTree: TestTrees.standard),
            settle: {}
        )
        let server = SocketServer(
            socketPath: TestSandbox.pendingDirectory("serve") + "/daemon.sock",
            dispatcher: Dispatcher(core: core, log: log),
            log: log
        )
        return (server: server, core: core)
    }

    private static func writeFrame(_ data: Data, from fd: Int32) throws {
        var offset = data.startIndex
        while offset < data.endIndex {
            let written = data.withUnsafeBytes { raw in
                write(fd, raw.baseAddress!.advanced(by: data.distance(from: data.startIndex, to: offset)),
                      data.distance(from: offset, to: data.endIndex))
            }
            try #require(
                written > 0,
                "对端这一侧写不出去（errno \(errno)）：这一轮根本没把帧交给 daemon，夹具自己就没成立"
            )
            offset = data.index(offset, offsetBy: written)
        }
    }

    /// 从对端读回**一整行**（有界）。返回 nil 说的是"到点也没有回包"，不是"回包是空的"——
    /// 在这一面这是两种失败：后者由调用方的断言点名。
    private static func readReplyLine(from fd: Int32, within limit: TimeInterval) -> String? {
        let deadline = SocketDeadline(seconds: limit)
        var received = Data()
        while true {
            switch BoundedSocket.wait(fd, events: Int16(POLLIN), deadline: deadline) {
            case .ready:
                var chunk = [UInt8](repeating: 0, count: 4096)
                let count = read(fd, &chunk, chunk.count)
                guard count > 0 else { return nil }  // EOF 或错误：这条连接已经没了
                received.append(contentsOf: chunk[0..<count])
                if let newline = received.firstIndex(of: UInt8(ascii: "\n")) {
                    return String(decoding: received[received.startIndex...newline], as: UTF8.self)
                }
            case .timedOut, .failed:
                return nil
            }
        }
    }

    /// 到点处置要么关闭并给出那句话，要么继续等。测试按这两种**形态**断言，再检查句子
    /// 自己点名它关掉的是什么——改文案不该让判据变红，指错对象该。
    private static func closeReason(of action: SocketServer.SilenceTimeoutAction) -> String? {
        if case .close(let reason) = action { return reason }
        return nil
    }

    // MARK: - 判据：首字节预算（假时钟）

    @Test("A connection that has not sent a byte is armed with the named first-byte budget, and it expires on its own")
    func silentConnectionIsArmedWithAnAbsoluteFirstByteBudget() throws {
        var fakeNow: TimeInterval = 1_000
        let clock: () -> TimeInterval = { fakeNow }
        let codec = FrameCodec()  // 一个字节都还没读进来

        let plan = SocketServer.clientReadPlan(
            codec: codec,
            spokeOnce: false,
            existingLineDeadline: nil,
            existingFirstByteDeadline: nil,
            now: clock
        )
        guard case .firstByte(let deadline) = plan.wait else {
            Issue.record("一字未发的连接必须落在 .firstByte 上，拿到的是 \(plan.wait)——判据没武装，serve() 的第一次 read() 就还是无界阻塞")
            return
        }
        #expect(deadline.seconds == SocketServer.firstByteTimeoutSeconds,
                "预算必须取自那条具名常量，不是随手写的字面量")
        #expect(!deadline.expired(), "刚武装的时候不该已经到期")
        #expect(deadline.pollMillis() > 0, "未到期就该真的等，而不是退化成一次非阻塞轮询")

        // 对端始终一个字都不发：预算按**总时长**走到点，不需要任何一字节来提醒它。
        fakeNow += SocketServer.firstByteTimeoutSeconds
        let later = SocketServer.clientReadPlan(
            codec: codec,
            spokeOnce: false,
            existingLineDeadline: plan.lineDeadline,
            existingFirstByteDeadline: plan.firstByteDeadline,
            now: clock
        )
        guard case .firstByte(let held) = later.wait else {
            Issue.record("预算用完后仍该停在 .firstByte 这一段上，拿到的是 \(later.wait)")
            return
        }
        #expect(held.expired(), "沉默到点必须到期，而不是等对端良心发现")
        #expect(held.pollMillis() == 0, "到点之后 poll 立即返回，serve() 据此收口")
    }

    @Test("The first-byte budget is absolute: a later round may not re-arm it")
    func firstByteBudgetIsNotReArmedByThePassageOfTime() throws {
        var fakeNow: TimeInterval = 2_000
        let clock: () -> TimeInterval = { fakeNow }

        let armed = try #require(
            SocketServer.firstByteDeadline(spokeOnce: false, existing: nil, now: clock),
            "沉默的新连接必须有一条预算可武装"
        )
        fakeNow += 4
        let held = try #require(
            SocketServer.firstByteDeadline(spokeOnce: false, existing: armed, now: clock),
            "还没开口：这条预算继续有效"
        )
        // 关键的一条：elapsed 走的是总时长。写成"每轮重武装"的实现这里会读到 0，
        // 而那等于把绝对时限降级成一次 syscall 的超时（R5-07 那一课）。假时钟给的
        // 都是整数值，所以这里按精确相等断言，不需要容差。
        #expect(held.elapsed() == 4, "已武装的预算不许被后续轮次顶掉")
        #expect(held.seconds == SocketServer.firstByteTimeoutSeconds)

        fakeNow += SocketServer.firstByteTimeoutSeconds
        #expect(armed.expired(), "同一条绝对预算最终必须到期")
    }

    @Test("The sentence written when the first-byte budget expires names a connection that never sent a byte")
    func firstByteExpiryNamesTheSilentConnection() throws {
        let plan = SocketServer.clientReadPlan(
            codec: FrameCodec(),
            spokeOnce: false,
            existingLineDeadline: nil,
            existingFirstByteDeadline: nil,
            firstByteBudget: 10,
            now: { 7_000 }
        )
        let reason = try #require(
            Self.closeReason(of: SocketServer.silenceTimeoutAction(for: plan.wait, codec: FrameCodec())),
            "首字节预算到点必须是一次关闭：沉默的对端占着唯一的客户端位置就是 B-12 本体的第一格"
        )
        #expect(reason.contains("never sent a single byte"), "句子要说清是哪种对端：\(reason)")
        #expect(reason.contains("within 10s"), "句子要报真正到期的那条预算：\(reason)")
        #expect(reason.contains("not an idle session"),
                "句子要把\"这不是空闲会话\"说明白，否则下一个读者会以为安静本身被超时了：\(reason)")
    }

    // MARK: - 判据：既有的两条不许被顶掉（假时钟）

    @Test("A peer that sent half a line keeps the existing partial-line budget")
    func halfLineKeepsThePartialLineBudget() throws {
        var codec = FrameCodec()
        _ = codec.append(Data("{\"id\":1,\"method\":\"ac".utf8))
        #expect(codec.awaitsNewline, "夹具自检：这确实是停在半行的一帧")
        #expect(codec.pendingBytes > 0, "夹具自检：半行有缓冲可报")

        let plan = SocketServer.clientReadPlan(
            codec: codec,
            spokeOnce: true,
            existingLineDeadline: nil,
            existingFirstByteDeadline: nil,
            now: { 5_000 }
        )
        guard case .partialLine(let deadline) = plan.wait else {
            Issue.record("半帧必须落在 .partialLine 上，拿到的是 \(plan.wait)——新加的首字节/空闲判据不许把既有的半行预算顶掉")
            return
        }
        #expect(deadline.seconds == SocketServer.partialLineTimeoutSeconds,
                "半行的预算仍取自那条具名常量（60s），不是首字节那条")
        // 同源对照：这条判据本来就存在（FrameCodecTests 钉着它），本轮只要求它继续生效。
        let rearmed = SocketServer.partialLineDeadline(for: codec, existing: nil, now: { 5_000 })
        #expect(rearmed?.seconds == SocketServer.partialLineTimeoutSeconds,
                "既有的半行判据必须仍武装同一条 60s 预算")

        let reason = try #require(
            Self.closeReason(of: SocketServer.silenceTimeoutAction(for: plan.wait, codec: codec))
        )
        #expect(reason.contains("incomplete line"), "\(reason)")
        #expect(reason.contains("\(codec.pendingBytes) buffered byte(s)"),
                "半行要说得出它缓冲了多少：\(reason)")
    }

    @Test("An oversize frame under discard is still timed out, and is not mis-described as a silent peer")
    func oversizeDiscardStillTimesOutAndSaysWhy() throws {
        var codec = FrameCodec()
        _ = codec.append(Data(repeating: 0x61, count: FrameCodec.maxFrameBytes + 1))
        #expect(codec.isDiscardingOversizeFrame, "夹具自检：超长帧正在丢弃")
        #expect(codec.pendingBytes == 0, "丢弃期 buffer 是空的——句子照抄 pendingBytes 就会说成\"一个字节都没发\"")

        let plan = SocketServer.clientReadPlan(
            codec: codec,
            spokeOnce: true,
            existingLineDeadline: nil,
            existingFirstByteDeadline: nil,
            now: { 6_000 }
        )
        guard case .partialLine = plan.wait else {
            Issue.record("丢弃超长帧期间对端仍停在同一行里，必须继续按半行计时，拿到的是 \(plan.wait)")
            return
        }
        let reason = try #require(
            Self.closeReason(of: SocketServer.silenceTimeoutAction(for: plan.wait, codec: codec))
        )
        #expect(reason.contains("an oversize frame being discarded"),
                "发了太多字节的对端不能被写成没发言：\(reason)")
        #expect(!reason.contains("0 buffered byte(s)"), "这条句子的老毛病正是拿空的 buffer 当\"没发过字节\"：\(reason)")
    }

    @Test("An established session resting between complete frames is polled in slices, and a slice expiry closes nothing")
    func idleEstablishedSessionIsPolledInSlicesAndNeverClosed() throws {
        var codec = FrameCodec()
        _ = codec.append(Self.helloFrame)
        #expect(!codec.awaitsNewline, "夹具自检：完整帧已经读完，没有半行挂着")

        var fakeNow: TimeInterval = 8_000
        let clock: () -> TimeInterval = { fakeNow }
        let plan = SocketServer.clientReadPlan(
            codec: codec,
            spokeOnce: true,
            existingLineDeadline: nil,
            existingFirstByteDeadline: nil,
            idleSliceSeconds: 0.5,
            now: clock
        )
        guard case .idleSlice(let slice) = plan.wait else {
            Issue.record("开过口且没有半行的会话必须落在 .idleSlice 上，拿到的是 \(plan.wait)")
            return
        }
        #expect(slice.seconds == SocketServer.idlePollSliceSeconds, "切片取自具名常量")
        #expect(SocketServer.silenceTimeoutAction(for: plan.wait, codec: codec) == .keepWaiting,
                "空闲切片的到点不许关闭任何会话：那是\"多久回头看一次 shutdownRequested\"，不是死刑")

        // 二十个切片的安静也不许变成死刑：每一次到点都只是回看一眼。
        var previous = plan
        for round in 1...20 {
            fakeNow += 0.5
            let again = SocketServer.clientReadPlan(
                codec: codec,
                spokeOnce: true,
                existingLineDeadline: previous.lineDeadline,
                existingFirstByteDeadline: previous.firstByteDeadline,
                idleSliceSeconds: 0.5,
                now: clock
            )
            guard case .idleSlice = again.wait else {
                Issue.record("第 \(round) 轮安静之后仍该是空闲切片，拿到的是 \(again.wait)")
                return
            }
            #expect(SocketServer.silenceTimeoutAction(for: again.wait, codec: codec) == .keepWaiting)
            previous = again
        }

        // 首字节预算在开过口之后必须撤销：否则一条长期空闲的会话会被"新连接"的预算踢掉。
        if SocketServer.firstByteDeadline(
            spokeOnce: true,
            existing: SocketDeadline(seconds: SocketServer.firstByteTimeoutSeconds, now: clock),
            now: clock
        ) != nil {
            Issue.record("开过口的会话必须交还首字节预算——否则空闲语义就没了")
        }
    }

    // MARK: - 端到端（真 socketpair）

    @Test("Real socketpair: a peer that never sends a byte is refused once the budget expires, naming what it saw")
    func silentPeerIsRefusedOnceTheFirstByteBudgetExpires() throws {
        let (daemonFD, peerFD) = try Self.openSocketPair()
        defer { close(daemonFD); close(peerFD) }

        let capture = CapturedEngineLog()
        let (server, _) = Self.makeServedPair(log: capture.log)
        let serving = ServingConnection {
            server.serve(clientFD: daemonFD, firstByteBudget: 1, idleSlice: 0.05)
        }
        serving.start()

        // 对端一个字都不发——真实世界里这就是"同机进程 connect 之后占着不放"。
        // `run()` 的 accept 循环里 `serve(clientFD:)` 一返回就 `close(clientFD)` 并回到
        // accept，所以"serve 返回"就是那个唯一的客户端位置被交回来的那一刻。
        #expect(
            serving.waitForReturn(within: 5),
            "沉默的对端必须被首字节时限放掉：serve() 没在 5s 内返回，说明第一次 read() 还是无界阻塞，真正的 agent 永远排不进来（B-12）"
        )

        let logged = capture.text
        #expect(
            logged.contains("never sent a single byte"),
            "到点关闭时得说出它看到的是什么（只有首字节这一条分支会说这句话，所以这一条同时排除了\"因为别的原因提前 return\"）：\(logged.isEmpty ? "（一个字都没写）" : logged)"
        )
        #expect(logged.contains("within 1s"), "句子要报本轮真正到期的那条预算：\(logged)")
    }

    @Test("Real socketpair: an idle session survives many slice expiries and still answers its next call")
    func idleSessionStillAnswersAfterManySliceExpiries() throws {
        let (daemonFD, peerFD) = try Self.openSocketPair()
        defer { close(daemonFD); close(peerFD) }

        let capture = CapturedEngineLog()
        let (server, core) = Self.makeServedPair(log: capture.log)
        // 首字节预算给 1s，且会话在下文里安静 1.5s：一个"开过口却不撤销首字节预算"的
        // 实现会在这里把会话当沉默的新连接踢掉，而这正是空闲语义被回归的样子。
        let serving = ServingConnection {
            server.serve(clientFD: daemonFD, firstByteBudget: 1, idleSlice: 0.05)
        }
        serving.start()

        try Self.writeFrame(Self.helloFrame, from: peerFD)
        let first = try #require(
            Self.readReplyLine(from: peerFD, within: 3),
            "第一次 hello 没有得到回包：夹具没把帧交给 daemon，这一条测不到任何东西"
        )
        #expect(first.contains("\"result\""), "回包必须是真答复：\(first)")

        Thread.sleep(forTimeInterval: 1.5)  // ≈30 个空闲切片到点
        #expect(!serving.hasReturned,
                "空闲的会话被自己的空闲切片踢掉了：\"帧与帧之间永不超时\"这条文档语义被回归")

        try Self.writeFrame(Self.helloFrame, from: peerFD)
        // 安静了一阵之后这条会话必须还能接下一个调用——长期会话就是靠这一点活着。
        let second = try #require(Self.readReplyLine(from: peerFD, within: 3))
        #expect(second.contains("\"result\""), "空闲期后仍要能接调用：\(second)")
        #expect(!capture.text.contains("never sent a single byte"),
                "开过口的会话不该被写成沉默的新连接：\(capture.text)")

        // 收口：让后台线程自己结束，不要在它还在读的时候关 fd。
        _ = core.shutdown()
        #expect(serving.waitForReturn(within: 3), "停机之后这一手该自己结束")
    }

    @Test("Real socketpair: shutdownRequested during a silent period ends serve instead of waiting for the peer to speak")
    func shutdownRequestedDuringSilenceEndsServing() throws {
        let (daemonFD, peerFD) = try Self.openSocketPair()
        defer { close(daemonFD); close(peerFD) }

        let capture = CapturedEngineLog()
        let (server, core) = Self.makeServedPair(log: capture.log)
        // 首字节预算给 60s：这条时限在本测试里永远到不了点，所以 serve() 要是回来了，
        // 只能是空闲切片让它看见了 shutdownRequested。
        let serving = ServingConnection {
            server.serve(clientFD: daemonFD, firstByteBudget: 60, idleSlice: 0.05)
        }
        serving.start()

        try Self.writeFrame(Self.helloFrame, from: peerFD)
        // 夹具自检：这条连接已经开过口，是个会话了。
        let reply = try #require(Self.readReplyLine(from: peerFD, within: 3))
        #expect(reply.contains("\"result\""), "夹具自检的回包形状：\(reply)")

        // 对端接着沉默。`run()` 的 accept 循环只在 `serve(clientFD:)` 返回之后才会重看
        // `dispatcher.core.shutdownRequested`：从前那一次无界的 read() 让它永不执行——
        // 停机请求只能等对端再发一个字节才被看见。
        _ = core.shutdown()

        #expect(
            serving.waitForReturn(within: 3),
            "沉默期间 shutdownRequested 没被回头看：serve() 仍卡在那次无界的 read() 上（B-12：唯一的客户端位置被安静地占死）"
        )
        #expect(capture.lines.isEmpty,
                "这一次是停机收口，不是对端的错——一个字都不该写成 ERROR：\(capture.text)")
    }
}
