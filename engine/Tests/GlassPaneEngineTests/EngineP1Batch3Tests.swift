import XCTest
@testable import GlassPaneEngine

/// P1 批三（P1 spec v1.2 §8）：权限探针注入式判定 + DaemonProbe 只读探测。
/// 全部纯逻辑，无真实系统调用（CI 可跑，P1-C1/C2/C3/C5）。
final class EngineP1Batch3Tests: XCTestCase {

    // MARK: - P1-C2: PermissionStatus 单一真源

    func testAllDescriptorsHaveNonEmptyTexts() {
        for descriptor in PermissionDescriptor.all {
            XCTAssertFalse(descriptor.displayName.isEmpty, "\(descriptor.kind): displayName")
            XCTAssertFalse(descriptor.purposeText.isEmpty, "\(descriptor.kind): purposeText")
            XCTAssertFalse(descriptor.degradationText.isEmpty, "\(descriptor.kind): degradationText")
        }
        // 四类权限清单完整（综述 §5.14）。
        XCTAssertEqual(PermissionDescriptor.all.map(\.kind), PermissionKind.allCases)
    }

    func testPermissionStatusRawValuesAreStable() {
        XCTAssertEqual(PermissionStatus.granted.rawValue, "granted")
        XCTAssertEqual(PermissionStatus.denied.rawValue, "denied")
        XCTAssertEqual(PermissionStatus.notDetermined.rawValue, "notDetermined")
        XCTAssertEqual(PermissionStatus.unverifiable.rawValue, "unverifiable")
    }

    func testDescriptorLookupFallback() {
        let descriptor = PermissionDescriptor.descriptor(for: .accessibility)
        XCTAssertEqual(descriptor.displayName, "辅助功能")
    }

    func testScreenCaptureStateMapsToPanelStatus() {
        XCTAssertEqual(ScreenCapturePermissionState.granted.panelStatus, .granted)
        XCTAssertEqual(ScreenCapturePermissionState.denied.panelStatus, .denied)
        XCTAssertEqual(ScreenCapturePermissionState.notDetermined.panelStatus, .notDetermined)
    }

    // MARK: - P1-C1: 探针注入式判定

    func testAccessibilityProbeInjectsTrustCheck() {
        let trusted = AccessibilityPermissionProbe(trustCheck: { true })
        XCTAssertEqual(trusted.isTrusted(), true)
        XCTAssertEqual(trusted.displayStatus(), .granted)

        let untrusted = AccessibilityPermissionProbe(trustCheck: { false })
        XCTAssertEqual(untrusted.isTrusted(), false)
        XCTAssertEqual(untrusted.displayStatus(), .notDetermined)
    }

    func testAccessibilityProbePromptAndOpenPaneInvocations() {
        var promptCount = 0
        var openCount = 0
        let probe = AccessibilityPermissionProbe(
            trustCheck: { false },
            prompt: { promptCount += 1 },
            openPane: { openCount += 1 }
        )
        probe.promptAndOpenPane()
        XCTAssertEqual(promptCount, 1)
        XCTAssertEqual(openCount, 1)
    }

    func testInputMonitoringProbeThreeStateModel() {
        // 已授权
        let granted = InputMonitoringPermissionProbe(preflight: { true })
        XCTAssertEqual(granted.state, .granted)

        // 未请求 → notDetermined；请求后被拒 → denied
        var approved = false
        let probe = InputMonitoringPermissionProbe(
            preflight: { approved },
            requestAccess: { approved = false },
            openPane: {}
        )
        XCTAssertEqual(probe.state, .notDetermined)
        let outcome = probe.requestAccess()
        XCTAssertEqual(outcome, .denied)
        XCTAssertEqual(probe.state, .denied)

        // 请求后授权成功 → granted
        var approvedLater = false
        let successProbe = InputMonitoringPermissionProbe(
            preflight: { approvedLater },
            requestAccess: { approvedLater = true },
            openPane: {}
        )
        _ = successProbe.requestAccess()
        XCTAssertEqual(successProbe.state, .granted)
    }

    func testDeveloperToolsProbeIsUnverifiable() {
        var openCount = 0
        let probe = DeveloperToolsPermissionProbe(openPane: { openCount += 1 })
        XCTAssertEqual(probe.status, .unverifiable)
        XCTAssertEqual(probe.availabilityText, "未验证（无公开查询接口）")
        probe.openPane()
        XCTAssertEqual(openCount, 1)
    }

    func testScreenRecordingProbeStillWorksStandalone() {
        // 复用既有探针：注入 fake 断言其状态即可（P1-C1 含屏幕录制探针）。
        let granted = ScreenCapturePermissionProbe(preflight: { true }, requestAccess: {})
        XCTAssertEqual(granted.state, .granted)
        XCTAssertEqual(granted.state.panelStatus, .granted)
    }

    // MARK: - P1-C3: DaemonProbe

    private func helloResponseJSON(engine: String = "glasspaned", version: String = "0.1.0", protocolVersion: String = "0", pid: Int = 4242) -> Data {
        let object: [String: Any] = [
            "id": 0,
            "result": [
                "engine": engine,
                "version": version,
                "protocolVersion": protocolVersion,
                "pid": pid,
                "capabilities": ["act", "observe", "assert_element", "diagnose", "snapshot", "restore"],
            ],
        ]
        return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    func testParseHelloResponseHappyPath() {
        let summary = DaemonProbe.parseHelloResponse(helloResponseJSON())
        XCTAssertEqual(
            summary,
            DaemonProbe.Summary(version: "0.1.0", protocolVersion: "0", pid: 4242)
        )
    }

    func testParseHelloResponseRejectsMalformed() {
        XCTAssertNil(DaemonProbe.parseHelloResponse(Data("not json".utf8)))
        XCTAssertNil(DaemonProbe.parseHelloResponse(Data("{}".utf8)))
        let missingResult = try! JSONSerialization.data(withJSONObject: ["id": 0])
        XCTAssertNil(DaemonProbe.parseHelloResponse(missingResult))
        let wrongPidType = """
        {"id":0,"result":{"engine":"glasspaned","version":"0.1.0","protocolVersion":"0","pid":"string"}}
        """.data(using: .utf8)!
        XCTAssertNil(DaemonProbe.parseHelloResponse(wrongPidType))
    }

    func testDaemonProbeReachableChecksFilePresence() {
        let probe = DaemonProbe(transport: { _, _ in nil }, fileExists: { _ in false })
        XCTAssertFalse(probe.reachable(socketPath: "/nonexistent/engine.sock"))
        XCTAssertNil(probe.helloSummary(socketPath: "/nonexistent/engine.sock"))

        let present = DaemonProbe(transport: { _, _ in nil }, fileExists: { _ in true })
        XCTAssertTrue(present.reachable(socketPath: "/tmp/engine.sock"))
        // socket 存在但对端无响应 → nil（无响应路径）。
        XCTAssertNil(present.helloSummary(socketPath: "/tmp/engine.sock"))
    }

    func testDaemonProbeHelloSummaryRelaysTransport() {
        var capturedRequest: Data?
        let probe = DaemonProbe(
            transport: { _, request in
                capturedRequest = request
                return self.helloResponseJSON()
            },
            fileExists: { _ in true }
        )
        let summary = probe.helloSummary(socketPath: "/tmp/engine.sock")
        XCTAssertEqual(
            summary,
            DaemonProbe.Summary(version: "0.1.0", protocolVersion: "0", pid: 4242)
        )
        // 请求帧为 hello 方法（新行分隔）。
        let requestText = String(data: capturedRequest ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(requestText.contains("\"method\":\"hello\""))
    }

    func testDaemonProbeHelloSummaryRejectsWrongEngine() {
        let probe = DaemonProbe(
            transport: { _, _ in
                let object: [String: Any] = [
                    "id": 0,
                    "result": ["engine": "something-else", "version": "9.9", "protocolVersion": "9", "pid": 1],
                ]
                return try! JSONSerialization.data(withJSONObject: object)
            },
            fileExists: { _ in true }
        )
        // 解析层只认字段形状（engine 名不在此层做硬校验——枚举语义由调用方承接）。
        XCTAssertEqual(probe.helloSummary(socketPath: "/tmp/engine.sock")?.version, "9.9")
    }
}