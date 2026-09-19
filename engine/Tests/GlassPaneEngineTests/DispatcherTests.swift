import XCTest
@testable import GlassPaneEngine

/// A4: dispatcher-level protocol behavior — every request frame gets exactly
/// one structured response frame, errors carry GP_E codes + remedies.
final class DispatcherTests: XCTestCase {

    private var channel: ScriptedChannel!
    private var dispatcher: Dispatcher!

    override func setUp() {
        super.setUp()
        channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        dispatcher = Dispatcher(core: EngineCore(channel: channel, settle: {}))
    }

    /// Sends one JSON request line; returns the decoded response object.
    private func perform(_ json: String) throws -> [String: Any] {
        let response = dispatcher.handle(.frame(Data(json.utf8)))
        let object = try JSONSerialization.jsonObject(with: response, options: [])
        return try XCTUnwrap(object as? [String: Any])
    }

    private func error(of response: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap(response["error"] as? [String: Any])
    }

    private func attach() throws {
        let response = try perform("{\"id\":1,\"method\":\"attach\",\"params\":{\"bundleId\":\"com.example.app\"}}")
        XCTAssertEqual(response["id"] as? Int, 1)
        XCTAssertNotNil(response["result"])
    }

    func testHelloRespondsWithCapabilities() throws {
        let response = try perform("{\"id\":42,\"method\":\"hello\"}")
        XCTAssertEqual(response["id"] as? Int, 42)
        let result = try XCTUnwrap(response["result"] as? [String: Any])
        XCTAssertEqual(result["engine"] as? String, "glasspaned")
        XCTAssertEqual(result["protocolVersion"] as? String, "0")
        // P6 §5.3: capabilities gained "probe" (6 → 7).
        XCTAssertEqual((result["capabilities"] as? [String])?.count, 7)
    }

    func testAttachWithBothBundleIdAndPidFails() throws {
        let response = try perform(
            "{\"id\":2,\"method\":\"attach\",\"params\":{\"bundleId\":\"a\",\"pid\":123}}"
        )
        XCTAssertEqual(try error(of: response)["code"] as? String, "GP_E_BAD_PARAMS")
        XCTAssertNotNil(try error(of: response)["remedy"] as? String)
    }

    func testAttachWithNeitherBundleIdNorPidFails() throws {
        let response = try perform("{\"id\":2,\"method\":\"attach\",\"params\":{}}")
        XCTAssertEqual(try error(of: response)["code"] as? String, "GP_E_BAD_PARAMS")
    }

    func testActBeforeAttachFails() throws {
        let response = try perform(
            "{\"id\":3,\"method\":\"act\",\"params\":{\"selector\":{\"role\":\"AXButton\",\"title\":\"Submit\"},\"action\":\"press\"}}"
        )
        XCTAssertEqual(try error(of: response)["code"] as? String, "GP_E_NOT_ATTACHED")
    }

    func testObserveDepthOutOfRangeFails() throws {
        try attach()
        for badDepth in [0, 11, -1, 100] {
            let response = try perform(
                "{\"id\":4,\"method\":\"observe\",\"params\":{\"maxDepth\":\(badDepth)}}"
            )
            XCTAssertEqual(
                try error(of: response)["code"] as? String, "GP_E_BAD_PARAMS",
                "maxDepth \(badDepth) must be rejected"
            )
        }
    }

    func testObserveWithFloatDepthFails() throws {
        try attach()
        let response = try perform(
            "{\"id\":4,\"method\":\"observe\",\"params\":{\"maxDepth\":6.5}}"
        )
        XCTAssertEqual(try error(of: response)["code"] as? String, "GP_E_BAD_PARAMS")
    }

    func testActWithUnknownActionFails() throws {
        try attach()
        let response = try perform(
            "{\"id\":5,\"method\":\"act\",\"params\":{\"selector\":{\"role\":\"AXButton\"},\"action\":\"defenestrate\"}}"
        )
        XCTAssertEqual(try error(of: response)["code"] as? String, "GP_E_BAD_PARAMS")
    }

    func testActWithOversizedSelectorFails() throws {
        try attach()
        let longTitle = String(repeating: "t", count: 513)
        let response = try perform(
            "{\"id\":5,\"method\":\"act\",\"params\":{\"selector\":{\"role\":\"AXButton\",\"title\":\"\(longTitle)\"},\"action\":\"press\"}}"
        )
        XCTAssertEqual(try error(of: response)["code"] as? String, "GP_E_BAD_PARAMS")
    }

    func testFullLoopOverFrames() throws {
        try attach()

        let actResponse = try perform(
            "{\"id\":10,\"method\":\"act\",\"params\":{\"selector\":{\"role\":\"AXButton\",\"title\":\"Submit\"},\"action\":\"press\"}}"
        )
        let actResult = try XCTUnwrap(actResponse["result"] as? [String: Any])
        XCTAssertEqual(actResult["actConfirmed"] as? Bool, true)
        let operationId = try XCTUnwrap(actResult["operationId"] as? String)
        XCTAssertTrue(operationId.hasPrefix("op_"))

        let observeResponse = try perform("{\"id\":11,\"method\":\"observe\",\"params\":{\"maxDepth\":6}}")
        let observeResult = try XCTUnwrap(observeResponse["result"] as? [String: Any])
        XCTAssertEqual(observeResult["nodeCount"] as? Int, 4)

        let assertResponse = try perform(
            "{\"id\":12,\"method\":\"assert_element\",\"params\":{\"selector\":{\"role\":\"AXButton\",\"title\":\"Submit\"},\"property\":\"enabled\",\"expected\":true}}"
        )
        let assertResult = try XCTUnwrap(assertResponse["result"] as? [String: Any])
        XCTAssertEqual(assertResult["passed"] as? Bool, true)

        let diagnoseResponse = try perform("{\"id\":13,\"method\":\"diagnose\"}")
        let diagnoseResult = try XCTUnwrap(diagnoseResponse["result"] as? [String: Any])
        XCTAssertEqual(diagnoseResult["class"] as? String, "T3")

        let evidenceResponse = try perform(
            "{\"id\":14,\"method\":\"last_evidence\",\"params\":{\"operationId\":\"\(operationId)\"}}"
        )
        let evidenceResult = try XCTUnwrap(evidenceResponse["result"] as? [String: Any])
        let pack = try XCTUnwrap(evidenceResult["evidencePack"] as? [String: Any])
        XCTAssertEqual(pack["operationId"] as? String, operationId)
        XCTAssertEqual(pack["schemaVersion"] as? String, "glasspane.evidence/0.1-draft")
    }

    func testUnknownMethodReturnsMethodNotFoundWithId() throws {
        let response = try perform("{\"id\":6,\"method\":\"teleport\"}")
        XCTAssertEqual(response["id"] as? Int, 6)
        XCTAssertEqual(try error(of: response)["code"] as? String, "GP_E_METHOD_NOT_FOUND")
    }

    func testBadJSONReturnsBadRequestWithNullId() throws {
        let response = dispatcher.handle(.frame(Data("{not json".utf8)))
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: response, options: []) as? [String: Any]
        )
        XCTAssertTrue(object["id"] is NSNull)
        let error = try XCTUnwrap(object["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "GP_E_BAD_REQUEST")
        XCTAssertNotNil(error["remedy"] as? String)
    }

    func testOversizeFrameReturnsPayloadTooLarge() throws {
        let response = dispatcher.handle(.oversize)
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: response, options: []) as? [String: Any]
        )
        let error = try XCTUnwrap(object["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "GP_E_PAYLOAD_TOO_LARGE")
    }

    func testErrorResponseCarriesRemedyGuidance() throws {
        let response = try perform("{\"id\":7,\"method\":\"observe\",\"params\":{}}")
        let error = try self.error(of: response)
        XCTAssertEqual(error["code"] as? String, "GP_E_NOT_ATTACHED")
        let remedy = try XCTUnwrap(error["remedy"] as? String)
        XCTAssertEqual(remedy, "call attach first")
    }

    func testEveryRequestProducesExactlyOneResponseFrame() throws {
        let one = dispatcher.handle(.frame(Data("{\"id\":1,\"method\":\"hello\"}\n".utf8)))
        // The trailing newline is part of the frame payload; the parser is
        // whitespace-tolerant, so this still answers exactly once.
        XCTAssertEqual(one.count { $0 == 0x0A }, 1)
        let twoFrames = dispatcher.handle(
            .frame(Data("{\"id\":1,\"method\":\"hello\"}".utf8))
        ) + dispatcher.handle(
            .frame(Data("{\"id\":2,\"method\":\"hello\"}".utf8))
        )
        XCTAssertEqual(twoFrames.count { $0 == 0x0A }, 2)
    }

    func testShutdownRespondsBye() throws {
        let response = try perform("{\"id\":99,\"method\":\"shutdown\"}")
        let result = try XCTUnwrap(response["result"] as? [String: Any])
        XCTAssertEqual(result["bye"] as? Bool, true)
        XCTAssertTrue(dispatcher.core.shutdownRequested)
    }
}
