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
            "act", "assert_element", "attach", "diagnose", "hello",
            "last_evidence", "observe", "restore", "shutdown", "snapshot",
        ])
    }
}
