import XCTest
@testable import GlassPaneEngine

/// A2/A4: protocol framing and request parsing (P0 spec §3.1/§3.2).
final class FrameCodecTests: XCTestCase {

    // MARK: - Framing

    func testSingleFrameInOneAppend() {
        var codec = FrameCodec()
        let events = codec.append(Data("{\"id\":1}\n".utf8))
        XCTAssertEqual(events.count, 1)
        if case .frame(let data) = events[0] {
            XCTAssertEqual(String(data: data, encoding: .utf8), "{\"id\":1}")
        } else {
            XCTFail("expected frame event, got \(events[0])")
        }
        XCTAssertEqual(codec.pendingBytes, 0)
    }

    func testFrameSplitAcrossAppends() {
        var codec = FrameCodec()
        XCTAssertTrue(codec.append(Data("{\"id\":".utf8)).isEmpty)
        XCTAssertTrue(codec.append(Data("1}".utf8)).isEmpty)
        let events = codec.append(Data("\n".utf8))
        XCTAssertEqual(events.count, 1)
        if case .frame(let data) = events[0] {
            XCTAssertEqual(String(data: data, encoding: .utf8), "{\"id\":1}")
        } else {
            XCTFail("expected frame event, got \(events[0])")
        }
    }

    func testTwoFramesOneAppend() {
        var codec = FrameCodec()
        let events = codec.append(Data("a\nb\n".utf8))
        XCTAssertEqual(events.count, 2)
        guard case .frame(let first) = events[0], case .frame(let second) = events[1] else {
            return XCTFail("expected two frame events")
        }
        XCTAssertEqual(String(data: first, encoding: .utf8), "a")
        XCTAssertEqual(String(data: second, encoding: .utf8), "b")
    }

    func testPartialFrameStaysPending() {
        var codec = FrameCodec()
        XCTAssertTrue(codec.append(Data("no-newline".utf8)).isEmpty)
        XCTAssertEqual(codec.pendingBytes, "no-newline".utf8.count)
    }

    func testOversizeFrameIsDiscardedAndConnectionStaysOpen() {
        var codec = FrameCodec()
        let payload = [UInt8](repeating: 0x61, count: FrameCodec.maxFrameBytes + 1)
        let events = codec.append(Data(payload) + Data([0x0A]))
        XCTAssertEqual(events, [.oversize])
        // The codec stays usable after an oversize frame.
        let followUp = codec.append(Data("ok\n".utf8))
        guard case .frame(let data) = followUp[0] else {
            return XCTFail("codec unusable after oversize frame")
        }
        XCTAssertEqual(String(data: data, encoding: .utf8), "ok")
    }

    func testEmptyLineYieldsEmptyFrame() {
        var codec = FrameCodec()
        let events = codec.append(Data("\n".utf8))
        guard case .frame(let data) = events[0] else {
            return XCTFail("expected frame event")
        }
        XCTAssertTrue(data.isEmpty)
        // The empty payload is rejected downstream by the parser.
        if case .failure(let failure) = RequestParser.parse(data) {
            XCTAssertEqual(failure.error.code, .badRequest)
        } else {
            XCTFail("empty frame must fail parsing")
        }
    }

    // MARK: - 半行超时（B-12：超长丢弃态也是"还在同一行里"）

    /// 丢弃超长帧时 buffer 已被清空，所以"还有没有半行"绝不能只问 pendingBytes。
    func testCodecReportsTheDiscardingStateWhileAnOversizeLineIsUnterminated() {
        var codec = FrameCodec()
        let events = codec.append(Data(repeating: 0x61, count: FrameCodec.maxFrameBytes + 1))
        XCTAssertTrue(events.isEmpty, "没有换行就没有事件：这一行还悬着")
        XCTAssertEqual(codec.pendingBytes, 0, "丢弃时 buffer 被清空——旧读环据此认定没有半行")
        XCTAssertTrue(codec.isDiscardingOversizeFrame, "得能问出「正在丢弃超长帧」这个状态")
        XCTAssertTrue(codec.awaitsNewline, "对端确实还停在同一行里")

        XCTAssertTrue(codec.append(Data(repeating: 0x62, count: 4_096)).isEmpty)
        XCTAssertTrue(codec.awaitsNewline, "继续滴字节仍然是同一行，不是新的一行")

        XCTAssertEqual(codec.append(Data("\n".utf8)), [.oversize])
        XCTAssertFalse(codec.isDiscardingOversizeFrame, "换行到了，丢弃结束")
        XCTAssertFalse(codec.awaitsNewline)
    }

    /// 写 >maxFrameBytes 然后停手的对端必须在绝对时限里被断开：daemon 一次只服务
    /// 一个客户端，没有这条时限就是拿整机的一次性通道赌对端的自觉。
    func testOversizeStreamWithNoNewlineIsTimedOutByThePartialLineDeadline() throws {
        var codec = FrameCodec()
        var fakeNow: TimeInterval = 1_000
        let clock: () -> TimeInterval = { fakeNow }

        _ = codec.append(Data(repeating: 0x61, count: FrameCodec.maxFrameBytes + 1))
        let deadline = try XCTUnwrap(
            SocketServer.partialLineDeadline(for: codec, existing: nil, now: clock),
            "超长丢弃态也必须武装绝对时限"
        )

        // 对端接着滴字节：每轮都仍在同一行，时限不得被顶后（那是空闲计时器的语义）。
        for round in 1...10 {
            fakeNow += 5
            _ = codec.append(Data(repeating: 0x62, count: 4_096))
            let held = try XCTUnwrap(
                SocketServer.partialLineDeadline(for: codec, existing: deadline, now: clock)
            )
            XCTAssertEqual(held.elapsed(), TimeInterval(round * 5), accuracy: 1e-9,
                           "预算按总时长走，不按每轮重置")
            XCTAssertFalse(held.expired(), "\(SocketServer.partialLineTimeoutSeconds)s 预算还没用完")
        }

        fakeNow += SocketServer.partialLineTimeoutSeconds
        XCTAssertNotNil(SocketServer.partialLineDeadline(for: codec, existing: deadline, now: clock))
        XCTAssertTrue(deadline.expired(), "无换行的超长流最终必须到期，而不是等对端良心发现")
        XCTAssertEqual(deadline.pollMillis(), 0, "到期后 poll 立即返回，读环据此收口")

        // 对照：一个正常停在半行的对端同样武装（这条旧实现本来就对）。
        var plain = FrameCodec()
        _ = plain.append(Data("{\"id\":1".utf8))
        XCTAssertNotNil(SocketServer.partialLineDeadline(for: plain, existing: nil, now: clock))
    }

    /// 帧写完（含超长帧的换行到了）时限就撤销——静默的长会话不该被踢。
    func testPartialLineDeadlineIsWithdrawnOnceTheLineIsComplete() throws {
        var codec = FrameCodec()
        let armed = SocketDeadline(seconds: 1)
        _ = codec.append(Data(repeating: 0x61, count: FrameCodec.maxFrameBytes + 1) + Data("\n".utf8))
        XCTAssertNil(SocketServer.partialLineDeadline(for: codec, existing: armed))
        _ = codec.append(Data("{\"id\":2,\"method\":\"hello\"}\n".utf8))
        XCTAssertNil(SocketServer.partialLineDeadline(for: codec, existing: armed),
                     "完整帧之间的静默期从不计时，这是既有语义")
    }

    // MARK: - Request parsing

    private func parse(_ json: String) -> Result<ParsedRequest, ParseFailure> {
        RequestParser.parse(Data(json.utf8))
    }

    func testParseValidRequestWithParams() throws {
        let result = parse("{\"id\":7,\"method\":\"observe\",\"params\":{\"maxDepth\":3}}")
        let request = try result.get()
        XCTAssertEqual(request.id, 7)
        XCTAssertEqual(request.method, .observe)
        XCTAssertEqual(request.params["maxDepth"] as? Int, 3)
    }

    func testParseDefaultsParamsToEmptyObject() throws {
        let request = try parse("{\"id\":0,\"method\":\"hello\"}").get()
        XCTAssertEqual(request.id, 0)
        XCTAssertTrue(request.params.isEmpty)
    }

    func testParseRejectsBadJSON() {
        if case .failure(let failure) = parse("{not json") {
            XCTAssertNil(failure.id)
            XCTAssertEqual(failure.error.code, .badRequest)
        } else {
            XCTFail("bad JSON must fail")
        }
    }

    func testParseRejectsNonObjectFrame() {
        if case .failure(let failure) = parse("[1,2,3]") {
            XCTAssertEqual(failure.error.code, .badRequest)
        } else {
            XCTFail("non-object frame must fail")
        }
    }

    func testParseRejectsMissingId() {
        if case .failure(let failure) = parse("{\"method\":\"hello\"}") {
            XCTAssertNil(failure.id)
            XCTAssertEqual(failure.error.code, .badRequest)
        } else {
            XCTFail("missing id must fail")
        }
    }

    func testParseRejectsNegativeId() {
        if case .failure(let failure) = parse("{\"id\":-1,\"method\":\"hello\"}") {
            XCTAssertEqual(failure.error.code, .badRequest)
        } else {
            XCTFail("negative id must fail")
        }
    }

    func testParseRejectsBooleanId() {
        if case .failure(let failure) = parse("{\"id\":true,\"method\":\"hello\"}") {
            XCTAssertEqual(failure.error.code, .badRequest)
        } else {
            XCTFail("boolean id must fail")
        }
    }

    func testParseRejectsFractionalId() {
        if case .failure(let failure) = parse("{\"id\":3.5,\"method\":\"hello\"}") {
            XCTAssertEqual(failure.error.code, .badRequest)
        } else {
            XCTFail("fractional id must fail")
        }
    }

    func testParseRejectsFloatTokenId() {
        // JSON "3.0" is a float token — not an integer.
        if case .failure(let failure) = parse("{\"id\":3.0,\"method\":\"hello\"}") {
            XCTAssertEqual(failure.error.code, .badRequest)
        } else {
            XCTFail("float-token id must fail")
        }
    }

    func testParseRejectsUnknownMethod() {
        if case .failure(let failure) = parse("{\"id\":5,\"method\":\"teleport\"}") {
            XCTAssertEqual(failure.id, 5)
            XCTAssertEqual(failure.error.code, .methodNotFound)
        } else {
            XCTFail("unknown method must fail")
        }
    }

    func testParseRejectsNonObjectParams() {
        if case .failure(let failure) = parse("{\"id\":5,\"method\":\"hello\",\"params\":[1]}") {
            XCTAssertEqual(failure.id, 5)
            XCTAssertEqual(failure.error.code, .badParams)
        } else {
            XCTFail("non-object params must fail")
        }
    }

    func testMethodWhitelistMatchesWireNames() {
        XCTAssertEqual(EngineMethod.allCases.map(\.rawValue).sorted(), [
            "act", "assert_element", "attach", "audit_ui", "capture_view", "diagnose", "hello",
            "last_evidence", "observe", "probe_status", "restore", "shutdown", "snapshot",
        ])
    }
}
