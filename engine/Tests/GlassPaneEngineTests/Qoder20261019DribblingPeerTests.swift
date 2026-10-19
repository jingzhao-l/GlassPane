import XCTest
import Foundation
@testable import GlassPaneEngine

/// Item 1 (2026-10-19 lane): the **absolute session deadline** in
/// `DaemonProbe.boundedSession`'s read loop was consulted only in the
/// `EAGAIN`/`EWOULDBLOCK` branch (`DaemonProbe.swift:385-391` before this batch).
/// A peer that hands over at least one byte inside every `SO_RCVTIMEO` window never
/// lets that branch run, so the session is bounded only by `maxResponseBytes`: the
/// comment's claim that such a peer is capped at "deadline + 一次 syscall" is false,
/// and the startup guard — which runs behind the signal mask and therefore cannot be
/// interrupted — stays open until 64 KiB arrive. At 20 byte/s that is ~55 minutes.
///
/// Why the pre-existing pure-helper test could not see this
/// (`HumanInterventionAuditTests.swift:277`
/// `testSocketDeadlineBoundsADribblingPeerWherePerSyscallTimeoutCannot`): it drives
/// `SocketDeadline` and `ResponseBudget` directly with an injected clock and
/// re-implements the loop **in the test body** (`while !bounded.expired() { … }`).
/// That loop is the test's own, not the production one. It proves the deadline type
/// expires and the budget type counts — both were already true — and says nothing
/// about whether the production `while true { read(...) }` asks the deadline on the
/// `count > 0` path. Only running that loop against a socket that really dribbles
/// can show it, so every case here uses a real `AF_UNIX` listener: no transport
/// stub, no injected `RawTransport`, no fake clock.
final class Qoder20261019DribblingPeerTests: XCTestCase {

    /// The defect, measured on a real socket: one byte every 50 ms against a 1 s
    /// absolute deadline. The session must close on the deadline, not on the cap.
    func testRealDribblingPeerIsBoundedByTheAbsoluteDeadlineNotTheByteCap() throws {
        let peer = try DribblingPeer(intervalMillis: 50)
        defer { peer.shutdown() }

        // 200 byte at 20 byte/s = 10 s of dribble. The production cap is 64 KiB
        // (~55 min of the same peer); a smaller cap keeps the red run at 10 s instead
        // of an hour, and the assertion below is about *which* bound closed the session.
        let cap = 200
        let start = Date()
        let outcome = DaemonProbe.boundedSession(
            socketPath: peer.path,
            request: Data("{\"id\":0,\"method\":\"hello\"}\n".utf8),
            waitForHello: true,
            timeoutSeconds: 1,
            maxResponseBytes: cap
        )
        let elapsed = Date().timeIntervalSince(start)

        guard case .occupied(let reason) = outcome else {
            return XCTFail("一个滴字节越过绝对时限的对端不是 answered: \(outcome)")
        }
        XCTAssertTrue(reason.contains("deadline"),
                      "拒绝必须指名**绝对时限**；说成 syscall 超时会把人引向「调大 SO_RCVTIMEO」这个错方向: \(reason)")
        XCTAssertFalse(reason.contains("cap \(cap)"),
                       "会话不得靠字节上限收口（那条文案是 cap 分支的）: \(reason)")
        let received = try XCTUnwrap(Self.firstInteger(in: reason),
                                     "拒绝文案要带上实际滴到的字节数，否则这条断言没根: \(reason)")
        XCTAssertGreaterThan(received, 0, "对端确实在滴字节——本用例不是空跑")
        XCTAssertLessThan(received, cap, "必须**远早于**字节上限就收口（cap \(cap)，实收 \(received)）")
        XCTAssertLessThan(elapsed, 2.5,
                          "1s 绝对时限 + 至多一次 syscall；实测 \(String(format: "%.2f", elapsed))s")
    }

    /// Honest shape that must survive the fix: a daemon that answers in time still
    /// reads as answered — the deadline must not eat a real reply.
    func testRealPeerThatAnswersInTimeStillReadsAsAnswered() throws {
        let hello = Data(#"{"result":{"version":"1.1.0","protocolVersion":"0","pid":4242},"id":0}"#.utf8)
        let listener = try RealUnixListener { fd in
            _ = hello.withUnsafeBytes { raw in write(fd, raw.baseAddress, raw.count) }
            close(fd)   // EOF is the read loop's normal exit
        }
        defer { listener.shutdown() }

        let outcome = DaemonProbe.boundedSession(
            socketPath: listener.path,
            request: Data("{\"id\":0,\"method\":\"hello\"}\n".utf8),
            waitForHello: true,
            timeoutSeconds: 3,
            maxResponseBytes: DaemonProbe.maxHelloResponseBytes
        )
        guard case .answered(let data) = outcome else {
            return XCTFail("按时回话的 daemon 必须读成 answered，实际 \(outcome)")
        }
        XCTAssertEqual(DaemonProbe.parseHelloResponse(data)?.pid, 4242,
                       "answered 的内容必须仍能被护栏解析成同一个 daemon")
    }

    /// Honest shape 2: a listener that accepts and never speaks — the branch that
    /// already worked (`EAGAIN` → deadline). It must keep the same wording, so this
    /// fix does not move the goalposts on a silent peer.
    func testRealSilentPeerStillClosesOnTheExistingDeadlineBranch() throws {
        let listener = try RealUnixListener { _ in }   // accept, then silence
        defer { listener.shutdown() }

        let outcome = DaemonProbe.boundedSession(
            socketPath: listener.path,
            request: Data("{\"id\":0,\"method\":\"hello\"}\n".utf8),
            waitForHello: true,
            timeoutSeconds: 1,
            maxResponseBytes: DaemonProbe.maxHelloResponseBytes
        )
        guard case .occupied(let reason) = outcome else {
            return XCTFail("一个字都不发的对端不是 answered: \(outcome)")
        }
        XCTAssertTrue(reason.contains("absolute") && reason.contains("deadline"),
                      "既有 EAGAIN 分支的形状不能变: \(reason)")
        XCTAssertEqual(Self.firstInteger(in: reason), 0, "一个字都没收到，计数必须是 0 而不是猜一个")
    }

    /// The first integer in a refusal sentence — used instead of parsing prose by hand
    /// at three call sites.
    private static func firstInteger(in text: String) -> Int? {
        var digits = ""
        for character in text {
            if character.isNumber {
                digits.append(character)
            } else if !digits.isEmpty {
                break
            }
        }
        return digits.isEmpty ? nil : Int(digits)
    }
}

// MARK: - Real sockets, no stubs

/// A real `AF_UNIX` stream listener on a scratch path, dribbling one byte every
/// `intervalMillis` to the first accepted client and never closing it.
private final class DribblingPeer {
    let path: String
    private let backlogFD: Int32
    private var thread: Thread?
    private let lock = NSLock()
    private var stopped = false
    private var clientFD: Int32 = -1

    init(intervalMillis: Int) throws {
        // Inside `TestSandbox`: process-private, and the isolation gate in this suite
        // forbids a test from composing a scratch path out of the shared temp location.
        path = TestSandbox.pendingDirectory("dribble") + "/s.sock"
        try FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        unlink(path)
        backlogFD = try RealUnixListener.makeListeningSocket(at: path)
        thread = Thread { [weak self] in
            guard let self else { return }
            let accepted = accept(self.backlogFD, nil, nil)
            guard accepted >= 0 else { return }
            // The probe closes its end the moment the session ends; a write into the
            // void must cost this test thread an EPIPE, not the whole xctest process a
            // SIGPIPE (that is exactly the trap `boundedSession` sets SO_NOSIGPIPE for).
            RealUnixListener.ignoreSigPipe(accepted)
            self.lock.lock(); self.clientFD = accepted; self.lock.unlock()
            var byte: UInt8 = 0x7B   // '{' — a first byte, never a compliant hello
            while true {
                self.lock.lock()
                let halted = self.stopped
                self.lock.unlock()
                if halted { break }
                _ = write(accepted, &byte, 1)
                usleep(UInt32(max(1, intervalMillis)) * 1_000)
            }
        }
        thread?.start()
    }

    func shutdown() {
        lock.lock(); stopped = true; let client = clientFD; lock.unlock()
        if client >= 0 { close(client) }
        close(backlogFD)
        unlink(path)
    }
}

/// A real `AF_UNIX` listener that runs a caller-supplied handler for each accepted
/// client on a background thread.
final class RealUnixListener {
    let path: String
    private let backlogFD: Int32
    private var thread: Thread?
    private let lock = NSLock()
    private var stopped = false

    init(_ handler: @escaping (Int32) -> Void) throws {
        path = TestSandbox.pendingDirectory("listen") + "/s.sock"
        try FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        unlink(path)
        backlogFD = try Self.makeListeningSocket(at: path)
        thread = Thread { [weak self] in
            guard let self else { return }
            while true {
                let accepted = accept(self.backlogFD, nil, nil)
                if accepted < 0 { return }
                Self.ignoreSigPipe(accepted)
                self.lock.lock()
                let halted = self.stopped
                self.lock.unlock()
                if halted { close(accepted); return }
                handler(accepted)
            }
        }
        thread?.start()
    }

    /// Turns SIGPIPE into an EPIPE return value on `fd`, so a handler that writes
    /// after the probe hung up cannot kill the test process.
    static func ignoreSigPipe(_ fd: Int32) {
        var enabled: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
    }

    /// Binds a listening socket at `path`; the caller owns accept(). Named apart
    /// from `Darwin.bind` so the syscall call inside it stays unambiguous.
    static func makeListeningSocket(at path: String) throws -> Int32 {
        guard let address = UnixSocketAddress.address(for: path) else {
            throw NSError(domain: "GlassPaneTest", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "socket path does not fit sockaddr_un: \(path)"])
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw lastError() }
        let bound = withUnsafePointer(to: address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else { close(fd); unlink(path); throw lastError() }
        guard listen(fd, 8) == 0 else { close(fd); unlink(path); throw lastError() }
        return fd
    }

    private static func lastError() -> NSError {
        NSError(domain: "GlassPaneTest", code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey: "socket setup failed: \(String(cString: strerror(errno)))"])
    }

    func shutdown() {
        lock.lock(); stopped = true; lock.unlock()
        close(backlogFD)
        unlink(path)
    }
}
