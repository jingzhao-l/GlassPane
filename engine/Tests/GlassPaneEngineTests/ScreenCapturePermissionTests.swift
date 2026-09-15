import XCTest
@testable import GlassPaneEngine

/// P1 §3/§4 P1-A5：屏幕录制权限三态观察与引导流程。
/// 通过注入式 fake 探针覆盖真实 TCC 不可达的路径，不触碰系统授权。
final class ScreenCapturePermissionTests: XCTestCase {

    private func makeProbe(preflight: @escaping () -> Bool, requestAccess: @escaping () -> Void) -> ScreenCapturePermissionProbe {
        ScreenCapturePermissionProbe(preflight: preflight, requestAccess: requestAccess)
    }

    // MARK: - 正常路径

    func testGrantedWhenPreflightReturnsTrue() {
        // 已授权：无论是否请求过，状态一律 granted。
        let probe = makeProbe(preflight: { true }, requestAccess: {})
        XCTAssertEqual(probe.state, .granted)
        probe.guideAccess()
        XCTAssertEqual(probe.state, .granted)
    }

    func testGuideAccessIsNoOpWhenGranted() {
        // 已授权时本次进入守卫即 return，requestAccess 不应被调用。
        var requestCount = 0
        let probe = makeProbe(preflight: { true }, requestAccess: { requestCount += 1 })
        probe.guideAccess()
        XCTAssertEqual(requestCount, 0, "granted 时不应触发授权请求")
        XCTAssertEqual(probe.state, .granted)
    }

    // MARK: - 前态（notDetermined）

    func testNotDeterminedBeforeAnyRequest() {
        // 未被授权、本次进程尚未请求 → notDetermined（spec §3.1 前态）。
        let probe = makeProbe(preflight: { false }, requestAccess: {})
        XCTAssertEqual(probe.state, .notDetermined)
    }

    func testDeniedAfterRequestWhenStillRejected() {
        // 请求后 preflight 仍 false → denied，且后续 state() 保持 denied。
        var requestCount = 0
        let probe = makeProbe(preflight: { false }, requestAccess: { requestCount += 1 })
        let outcome = probe.guideAccess()
        XCTAssertEqual(outcome, .denied)
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(probe.state, .denied)
    }

    // MARK: - 边界：请求后授权成功

    func testGrantedAfterGuideAccessWhenRequestEnablesPermission() {
        // 授权弹窗确认后 preflight 翻转 true → guideAccess 返回 granted。
        var granted = false
        let probe = makeProbe(
            preflight: { granted },
            requestAccess: { granted = true }
        )
        XCTAssertEqual(probe.state, .notDetermined)
        XCTAssertEqual(probe.guideAccess(), .granted)
        XCTAssertEqual(probe.state, .granted)
    }

    func testStateTransitionNotDeterminedToDeniedPersists() {
        // 同一实例多次观测：请求后 preflight 维持 false 时不再回落 notDetermined。
        var allowed = false
        var requested = false
        let probe = makeProbe(
            preflight: { allowed },
            requestAccess: { requested = true }
        )
        XCTAssertEqual(probe.state, .notDetermined)
        _ = probe.guideAccess()
        XCTAssertTrue(requested)
        XCTAssertEqual(probe.state, .denied)
        XCTAssertEqual(probe.state, .denied, "状态必须单调，不得回退为 notDetermined")
    }

    func testRawValuesAreStable() {
        // 机器可读三态字符串是 CLI 输出契约，必须稳定。
        XCTAssertEqual(ScreenCapturePermissionState.granted.rawValue, "granted")
        XCTAssertEqual(ScreenCapturePermissionState.denied.rawValue, "denied")
        XCTAssertEqual(ScreenCapturePermissionState.notDetermined.rawValue, "notDetermined")
    }
}