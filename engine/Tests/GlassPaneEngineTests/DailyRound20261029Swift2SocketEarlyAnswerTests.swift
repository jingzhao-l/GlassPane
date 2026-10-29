import Testing
import Foundation
import Darwin
@testable import GlassPaneEngine

/// S3-3（每日 2026-10-29，泳道 3）：`SocketServer.serve` 对"写半行就 EOF"与
/// "写了 >4 MiB 不写换行后断开"这两种对端，今天只写一条 stderr 日志就 return，
/// **线上没有任何回帧**——`FrameCodec`/`Dispatcher` 承诺的 `GP_E_PAYLOAD_TOO_LARGE`
/// 永远发不出去（`.oversize` 只在见换行时产出），调用方只能把自己的超时读成
/// "daemon 挂了"。
///
/// 修法：退出前问一次 codec（`isDiscardingOversizeFrame` 或 `awaitsNewline`），
/// 先 `writeAll(clientFD, …)` 回一帧再 return。错误帧恒三字段 `{code,message,remedy}`，
/// code ∈ {GP_E_PAYLOAD_TOO_LARGE, GP_E_BAD_REQUEST}。
///
/// 对照臂（既有语义必须保住，`SilentClientDeadlineTests` 同款形状）：
///   · 沉默到点的**空闲会话**不许被踢、也不许收到任何未索回的帧；
///   · 干净 EOF（没欠着半行）依旧静默关闭。
///
/// REVERSE：把 `serve` 里两处回帧调用删掉 → 前两条断言红（修前形态，即本轮的
/// "能红"证据：读到 0 字节）；把空闲切片到点也回帧/关闭 → 对照臂红。
@Suite("S3-3: an undeliverable half-open request must be answered before serve returns")
struct DailyRound20261029Swift2SocketEarlyAnswerTests {

    // MARK: - 夹具（与 SilentClientDeadlineTests 同一先例，那边是 private 故此处自带一份）

    private static let helloFrame = Data("{\"id\":0,\"method\":\"hello\"}\n".utf8)

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

        var text: String {
            lock.lock(); defer { lock.unlock() }
            return storage.joined()
        }
    }

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

        var hasReturned: Bool {
            lock.lock(); defer { lock.unlock() }
            return returned
        }

        @discardableResult
        func waitForReturn(within limit: TimeInterval) -> Bool {
            finished.wait(timeout: .now() + limit) == .success
        }
    }

    private static func openSocketPair() throws -> (daemonFD: Int32, peerFD: Int32) {
        var pair: [Int32] = [0, 0]
        try #require(
            socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0,
            "夹具要能真开一对 socket（errno \(errno)）"
        )
        return (daemonFD: pair[0], peerFD: pair[1])
    }

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
                "对端这一侧写不出去（errno \(errno)）：夹具自己就没成立"
            )
            offset = data.index(offset, offsetBy: written)
        }
    }

    /// 从对端读回一整行（有界）。nil = 到点也没有回包。
    private static func readReplyLine(from fd: Int32, within limit: TimeInterval) -> String? {
        let deadline = SocketDeadline(seconds: limit)
        var received = Data()
        while true {
            switch BoundedSocket.wait(fd, events: Int16(POLLIN), deadline: deadline) {
            case .ready:
                var chunk = [UInt8](repeating: 0, count: 65536)
                let count = read(fd, &chunk, chunk.count)
                guard count > 0 else { return nil }
                received.append(contentsOf: chunk[0..<count])
                if let newline = received.firstIndex(of: UInt8(ascii: "\n")) {
                    return String(decoding: received[received.startIndex...newline], as: UTF8.self)
                }
            case .timedOut, .failed:
                return nil
            }
        }
    }

    /// 错误帧形状闸：恰好 `error:{code,message,remedy}` 三字段，code 落在两条承诺的
    /// 错误码之一。断在解析后的字典上，不 substring 匹配。返回 code 供更窄的断言用。
    @discardableResult
    private static func requireWellFormedErrorFrame(_ line: String) throws -> String {
        let data = Data(line.utf8)
        let top = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any],
            "回帧必须是 JSON 对象：\(line)"
        )
        let error = try #require(
            top["error"] as? [String: Any],
            "错误帧必须有 error 对象：\(line)"
        )
        #expect(
            Set(error.keys) == ["code", "message", "remedy"],
            "错误帧恒三字段（P0 §3.2.1），拿到的是 \(Array(error.keys).sorted())：\(line)"
        )
        let code = try #require(error["code"] as? String)
        #expect(
            code == GPErrorCode.payloadTooLarge.rawValue || code == GPErrorCode.badRequest.rawValue,
            "半行/超长这类没被解析的请求只允许这两条具名错误码，拿到的是 \(code)：\(line)"
        )
        let remedy = try #require(error["remedy"] as? String)
        #expect(!remedy.isEmpty, "remedy 不许是空话：\(line)")
        return code
    }

    // MARK: - 缺陷本体

    @Test("Real socketpair: a half-written line ending in EOF gets an error frame before serve returns")
    func halfLineEofGetsAnswered() throws {
        let (daemonFD, peerFD) = try Self.openSocketPair()
        defer { close(daemonFD); close(peerFD) }

        let capture = CapturedEngineLog()
        let (server, core) = Self.makeServedPair(log: capture.log)
        // 首字节/半行预算都给足：这条测的是 EOF 那一格，不是时限那一格。
        let serving = ServingConnection {
            server.serve(clientFD: daemonFD, firstByteBudget: 60, idleSlice: 0.05)
        }
        serving.start()

        // 对端写半行（无换行）后关闭写端——今天这正是"日志里一句 client disconnected、
        // 线上 0 字节"的形状。
        try Self.writeFrame(Data("{\"id\":7,\"method\":\"hello".utf8), from: peerFD)
        shutdown(peerFD, SHUT_WR)

        let line = try #require(
            Self.readReplyLine(from: peerFD, within: 3),
            "半行 EOF 必须在 3s 内拿到一份回帧：今天读到的是 0 字节，调用方只能把自己的超时读成\"daemon 挂了\""
        )
        try Self.requireWellFormedErrorFrame(line)

        #expect(serving.waitForReturn(within: 3), "EOF 之后 serve() 该收口")
        _ = core.shutdown()
    }

    @Test("Real socketpair: more than 4 MiB with no newline, then EOF, gets GP_E_PAYLOAD_TOO_LARGE")
    func oversizeWithoutNewlineEofGetsAnswered() throws {
        let (daemonFD, peerFD) = try Self.openSocketPair()
        defer { close(daemonFD); close(peerFD) }

        let capture = CapturedEngineLog()
        let (server, core) = Self.makeServedPair(log: capture.log)
        let serving = ServingConnection {
            server.serve(clientFD: daemonFD, firstByteBudget: 60, idleSlice: 0.05)
        }
        serving.start()

        // 比上限多一字节且不写换行——`.oversize` 只在见换行时产出，对端不写了。
        let payload = Data(repeating: UInt8(ascii: "x"), count: FrameCodec.maxFrameBytes + 1)
        try Self.writeFrame(payload, from: peerFD)
        shutdown(peerFD, SHUT_WR)

        let line = try #require(
            Self.readReplyLine(from: peerFD, within: 5),
            ">4 MiB 无换行后 EOF 必须拿到回帧：今天同样 0 字节，GP_E_PAYLOAD_TOO_LARGE 永远发不出去"
        )
        let code = try Self.requireWellFormedErrorFrame(line)
        #expect(
            code == GPErrorCode.payloadTooLarge.rawValue,
            "超长那一条必须落在具名的 GP_E_PAYLOAD_TOO_LARGE 上：\(line)"
        )

        #expect(serving.waitForReturn(within: 3))
        _ = core.shutdown()
    }

    // MARK: - 对照臂（既有语义不许被修法撞坏）

    @Test("Real socketpair: a silent idle session is neither kicked nor fed unsolicited frames")
    func idleSessionStaysQuietAndAlive() throws {
        let (daemonFD, peerFD) = try Self.openSocketPair()
        defer { close(daemonFD); close(peerFD) }

        let capture = CapturedEngineLog()
        let (server, core) = Self.makeServedPair(log: capture.log)
        // 首字节预算 1s、会话随后安静 1.5s：一个"沉默到点就回帧/关闭"的过头修法会在这里现形。
        let serving = ServingConnection {
            server.serve(clientFD: daemonFD, firstByteBudget: 1, idleSlice: 0.05)
        }
        serving.start()

        try Self.writeFrame(Self.helloFrame, from: peerFD)
        let first = try #require(Self.readReplyLine(from: peerFD, within: 3), "夹具自检：第一帧要有回包")
        #expect(first.contains("\"result\""), "自检的回包必须是真答复：\(first)")

        // 安静期：不许多出任何未索回的字节（`awaitsNewline == false` 时退出前回帧那一步
        // 不该被触发，循环里的空闲切片更不该回帧）。
        let silence = Self.readReplyLine(from: peerFD, within: 1.5)
        #expect(silence == nil, "空闲会话的安静期不许收到任何帧，收到的是：\(silence ?? "")")
        #expect(!serving.hasReturned, "空闲会话被踢：\"帧与帧之间永不超时\"这条语义被撞坏了")

        try Self.writeFrame(Self.helloFrame, from: peerFD)
        let second = try #require(Self.readReplyLine(from: peerFD, within: 3), "安静一阵后这条会话必须还能接调用")
        #expect(second.contains("\"result\""), "第二帧的回包：\(second)")
        #expect(!capture.text.contains("never sent a single byte"),
                "开过口的会话不该被写成沉默的新连接：\(capture.text)")

        _ = core.shutdown()
        #expect(serving.waitForReturn(within: 3), "停机之后这一手该自己结束")
    }

    @Test("Real socketpair: a clean EOF (nothing owed) still closes without inventing a frame")
    func cleanEofStaysSilent() throws {
        let (daemonFD, peerFD) = try Self.openSocketPair()
        defer { close(daemonFD); close(peerFD) }

        let capture = CapturedEngineLog()
        let (server, core) = Self.makeServedPair(log: capture.log)
        let serving = ServingConnection {
            server.serve(clientFD: daemonFD, firstByteBudget: 60, idleSlice: 0.05)
        }
        serving.start()

        try Self.writeFrame(Self.helloFrame, from: peerFD)
        let first = try #require(Self.readReplyLine(from: peerFD, within: 3), "夹具自检：要有正常回包")
        #expect(first.contains("\"result\""))

        // 完整帧之后 EOF：codec 不欠任何东西（pendingBytes == 0 且不在丢弃超长帧），
        // 这条连接没问过任何问题 ⇒ 一个字都不许多发。
        shutdown(peerFD, SHUT_WR)
        #expect(serving.waitForReturn(within: 3), "干净 EOF 后 serve() 该收口")
        let extra = Self.readReplyLine(from: peerFD, within: 1)
        #expect(extra == nil, "没欠半行时 EOF 不许凭空造帧，多余字节：\(extra ?? "")")

        _ = core.shutdown()
        #expect(capture.text.isEmpty,
                "干净断开没有对端的错——发布形态（quiet）下不该出现任何 ERROR：\(capture.text)")
    }
}
