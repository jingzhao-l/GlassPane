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
        // P6 §5.3: capabilities gained "probe" (6 → 7); audit_ui → 8; capture_view → 9。
        // 这条计数是对外协商面：hello 里报的能力少一项，客户端就会去调一个不存在的方法。
        XCTAssertEqual((result["capabilities"] as? [String])?.count, 9)
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
        XCTAssertEqual(pack["schemaVersion"] as? String, "glasspane.evidence/0.1")
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

    // MARK: - attach.pid range (R2-01)

    /// A `pid` of 3000000000 passes the integrality check but traps the
    /// `pid_t` (Int32) narrowing conversion in the dispatcher: one advertised
    /// frame shape used to kill glasspaned. It must answer, not die.
    func testAttachWithOutOfRangePidAnswersBadParams() throws {
        for badPid in [0, -1, 2_147_483_648, 3_000_000_000, 9_223_372_036_854_775_806] {
            let response = try perform(
                "{\"id\":2,\"method\":\"attach\",\"params\":{\"pid\":\(badPid)}}"
            )
            let error = try self.error(of: response)
            XCTAssertEqual(
                error["code"] as? String, "GP_E_BAD_PARAMS",
                "pid \(badPid) is out of the pid_t range and must be rejected"
            )
            XCTAssertEqual(
                response["id"] as? Int, 2,
                "the rejection still has to answer the requesting frame"
            )
        }
    }

    /// The range guard must not swallow legitimate pids.
    func testAttachWithInBoundsPidStillWorks() throws {
        let response = try perform("{\"id\":2,\"method\":\"attach\",\"params\":{\"pid\":4242}}")
        XCTAssertNotNil(response["result"])
        XCTAssertNil(response["error"])
        XCTAssertEqual(channel.attachCallCount, 1)
    }

    // MARK: - operationId shape (B-10)

    /// `operationId` names an on-disk evidence file downstream; snapshot ids
    /// were pattern-checked, this one was only length-checked.
    func testOperationIdMustMatchTheOpUlidShape() throws {
        try attach()
        let traversal = "../../../../etc/passwd"
        let evidence = try perform(
            "{\"id\":14,\"method\":\"last_evidence\",\"params\":{\"operationId\":\"\(traversal)\"}}"
        )
        let evidenceError = try error(of: evidence)
        XCTAssertEqual(evidenceError["code"] as? String, "GP_E_BAD_PARAMS")
        XCTAssertTrue(
            (evidenceError["message"] as? String)?.contains("operationId") == true,
            "the message has to name the offending field: \(evidenceError["message"] ?? "nil")"
        )

        let diagnose = try perform(
            "{\"id\":13,\"method\":\"diagnose\",\"params\":{\"operationId\":\"op_1\"}}"
        )
        XCTAssertEqual(try error(of: diagnose)["code"] as? String, "GP_E_BAD_PARAMS")
    }

    /// Ids the daemon mints itself must keep round-tripping through the gate.
    func testGeneratedOperationIdStillRoundTripsThroughValidation() throws {
        try attach()
        let actResponse = try perform(
            "{\"id\":10,\"method\":\"act\",\"params\":{\"selector\":{\"role\":\"AXButton\",\"title\":\"Submit\"},\"action\":\"press\"}}"
        )
        let actResult = try XCTUnwrap(actResponse["result"] as? [String: Any])
        let operationId = try XCTUnwrap(actResult["operationId"] as? String)

        let evidence = try perform(
            "{\"id\":14,\"method\":\"last_evidence\",\"params\":{\"operationId\":\"\(operationId)\"}}"
        )
        XCTAssertNil(evidence["error"])
        let pack = try XCTUnwrap((evidence["result"] as? [String: Any])?["evidencePack"] as? [String: Any])
        XCTAssertEqual(pack["operationId"] as? String, operationId)

        let diagnose = try perform(
            "{\"id\":13,\"method\":\"diagnose\",\"params\":{\"operationId\":\"\(operationId)\"}}"
        )
        XCTAssertNotNil(diagnose["result"])
    }

    // MARK: - assert expected cap (R5-05)

    /// `expected` is persisted into every evidence pack and re-emitted by
    /// exports; every sibling field had a length cap except this one.
    func testAssertExpectedHonorsTheSelectorLengthCap() throws {
        try attach()
        let seed = try perform(
            "{\"id\":10,\"method\":\"act\",\"params\":{\"selector\":{\"role\":\"AXButton\",\"title\":\"Submit\"},\"action\":\"press\"}}"
        )
        XCTAssertNotNil(seed["result"])

        let atCap = String(repeating: "e", count: ParamValidation.expectedMaxLength)
        let overCap = String(repeating: "e", count: ParamValidation.expectedMaxLength + 1)
        let accepted = try perform(
            "{\"id\":12,\"method\":\"assert_element\",\"params\":{\"selector\":{\"role\":\"AXButton\"},\"property\":\"title\",\"expected\":\"\(atCap)\"}}"
        )
        XCTAssertNotNil(accepted["result"], "\(atCap.count) characters must still pass")

        let rejected = try perform(
            "{\"id\":12,\"method\":\"assert_element\",\"params\":{\"selector\":{\"role\":\"AXButton\"},\"property\":\"title\",\"expected\":\"\(overCap)\"}}"
        )
        XCTAssertEqual(try error(of: rejected)["code"] as? String, "GP_E_BAD_PARAMS")
    }

    // MARK: - restore.mode closed set (R5-08)

    func testRestoreRejectsModesTheDaemonDoesNotImplement() throws {
        try attach()
        let snapshotId = try takeSnapshotId()
        for bogusMode in ["full-snapshot", "compare-and-restore", "human-approved 2026-09-22"] {
            let response = try perform(
                "{\"id\":20,\"method\":\"restore\",\"params\":{\"snapshotId\":\"\(snapshotId)\",\"mode\":\"\(bogusMode)\"}}"
            )
            XCTAssertEqual(
                try error(of: response)["code"] as? String, "GP_E_BAD_PARAMS",
                "mode '\(bogusMode)' is not one the daemon implements"
            )
        }
    }

    /// The whitelist must not eat the spec'd honest boundaries: the two
    /// implemented tier-1 modes still reach EngineCore and still answer
    /// GP_E_RESTORE_UNSUPPORTED (no probe payload in this core).
    func testRestoreKeepsTheImplementedModesHonest() throws {
        try attach()
        let snapshotId = try takeSnapshotId()
        for mode in ["restore_snapshot", "rollback_full"] {
            let response = try perform(
                "{\"id\":20,\"method\":\"restore\",\"params\":{\"snapshotId\":\"\(snapshotId)\",\"mode\":\"\(mode)\"}}"
            )
            XCTAssertEqual(
                try error(of: response)["code"] as? String, "GP_E_RESTORE_UNSUPPORTED",
                "mode '\(mode)' must stay a restore verdict, not a params verdict"
            )
        }
        let compare = try perform(
            "{\"id\":21,\"method\":\"restore\",\"params\":{\"snapshotId\":\"\(snapshotId)\",\"mode\":\"compare\"}}"
        )
        XCTAssertNotNil(compare["result"])
    }

    // MARK: - outbound frame cap (R6-02 / B-13)

    /// The 4 MiB cap covers both directions (P0 §3.1). An oversized observe
    /// answer must come back as GP_E_PAYLOAD_TOO_LARGE carrying the real
    /// request id — never as an over-cap line that desynchronizes the shell.
    func testOversizedResponseAnswersPayloadTooLargeWithRealId() throws {
        try attach()
        let heavyLeaf = AxNode(role: "AXStaticText", title: String(repeating: "x", count: 12_000))
        channel.fallbackTree = TestTrees.snapshot([
            AxNode(role: "AXWindow", title: "Big", children: Array(repeating: heavyLeaf, count: 400))
        ])

        let raw = dispatcher.handle(
            .frame(Data("{\"id\":77,\"method\":\"observe\",\"params\":{\"maxDepth\":10}}".utf8))
        )
        XCTAssertLessThanOrEqual(
            raw.count, FrameCodec.maxFrameBytes,
            "the daemon must never emit a frame past the cap"
        )
        XCTAssertEqual(raw.count { $0 == 0x0A }, 1, "exactly one answer line")

        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: raw, options: []) as? [String: Any]
        )
        XCTAssertEqual(object["id"] as? Int, 77, "the fallback frame must carry the request id")
        let error = try XCTUnwrap(object["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "GP_E_PAYLOAD_TOO_LARGE")
        let message = try XCTUnwrap(error["message"] as? String)
        XCTAssertTrue(
            message.contains("maxDepth"),
            "the agent needs the shrink instruction, not just a size: \(message)"
        )
        XCTAssertEqual(error["remedy"] as? String, GPError.remedy(for: .payloadTooLarge))
    }

    /// A response that fits is untouched by the cap check.
    func testInBoundsResponseStillCarriesItsResult() throws {
        try attach()
        let response = try perform("{\"id\":78,\"method\":\"observe\",\"params\":{\"maxDepth\":10}}")
        XCTAssertEqual(response["id"] as? Int, 78)
        let result = try XCTUnwrap(response["result"] as? [String: Any])
        XCTAssertEqual(result["nodeCount"] as? Int, 4)
        XCTAssertNil(response["error"])
    }

    private func takeSnapshotId() throws -> String {
        let response = try perform("{\"id\":19,\"method\":\"snapshot\",\"params\":{\"maxDepth\":6}}")
        let result = try XCTUnwrap(response["result"] as? [String: Any])
        return try XCTUnwrap(result["snapshotId"] as? String)
    }
}
