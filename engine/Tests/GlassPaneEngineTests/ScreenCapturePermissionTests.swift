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
        // 请求后 preflight 仍 false，这句只支持"系统还没答应"，不支持"系统拒绝了"。
        // 从前这里断言 `.denied`，而 `--permissions`/面板把 `.denied` 渲染成「已拒绝」
        // （`SettingsPanelView.swift:789`）——一个 TCC 没有做过的决定被写成了事实。
        // 保护意图原样留着：没量到正解时不许点亮成 granted；对外发的那一面也不
        // 许再说"未请求"（刚问过），它只能说"未验证"。
        var requestCount = 0
        let probe = makeProbe(preflight: { false }, requestAccess: { requestCount += 1 })
        let outcome = probe.guideAccess()
        XCTAssertNotEqual(outcome, .granted, "预检仍然 false，请求没有被回答时不许点亮")
        XCTAssertNotEqual(outcome, .denied, "没人回答的询问不是一次拒绝")
        XCTAssertEqual(outcome, .notDetermined,
                       "granted/denied/notDetermined 三态里，\"系统尚未决定\"就是 notDetermined")
        XCTAssertEqual(requestCount, 1)
        XCTAssertNotEqual(probe.state, .granted)
        XCTAssertNotEqual(probe.state, .denied)
        XCTAssertEqual(probe.panelStatus, .unverifiable,
                       "面板读的那一面既不能是「已拒绝」也不能是「未请求」：已请求、未回答 → 未验证")
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
        // 这条单调性是真实缺陷的记忆，原话保留：问过之后还对读者说"未请求"，就是
        // 把这次询问抹掉了。它原来钉的值是 `denied`，而那个值从没有人量到过——所以
        // 这里把它钉在面板真正读的那一面（`panelStatus`）上：未请求 → 未验证，且
        // 后续每次观测都停在未验证，不回退、也不冒充拒绝。
        var allowed = false
        var requested = false
        let probe = makeProbe(
            preflight: { allowed },
            requestAccess: { requested = true }
        )
        XCTAssertEqual(probe.state, .notDetermined)
        XCTAssertEqual(probe.panelStatus, .notDetermined, "还没问过：\"未请求\"在这里是实话")
        _ = probe.guideAccess()
        XCTAssertTrue(requested)
        XCTAssertNotEqual(probe.panelStatus, .denied, "没有一次观测到的拒绝，就不许说已拒绝")
        XCTAssertEqual(probe.panelStatus, .unverifiable)
        XCTAssertEqual(probe.panelStatus, .unverifiable, "状态必须单调，不得回退为 notDetermined")
    }

    func testRawValuesAreStable() {
        // 机器可读三态字符串是 CLI 输出契约，必须稳定。
        XCTAssertEqual(ScreenCapturePermissionState.granted.rawValue, "granted")
        XCTAssertEqual(ScreenCapturePermissionState.denied.rawValue, "denied")
        XCTAssertEqual(ScreenCapturePermissionState.notDetermined.rawValue, "notDetermined")
    }
}