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

    // MARK: - 没量到授权（unverifiable）

    /// 2026-10-30 S1-3 之前这条叫 `testNotDeterminedBeforeAnyRequest`，钉的是"没问过 ⇒
    /// notDetermined"。那句是一个关于历史的陈述，而本探针只有一个布尔：false 同样装着"上一次
    /// 运行被拒"（TCC 持久，`hasRequestedThisRun` 每进程）。意图原样保留——**不许点亮成 granted，
    /// 也不许替系统作判决**——钉的值换成产品对"没量到"的既有说法。
    func testUnverifiableBeforeAnyRequest() {
        let probe = makeProbe(preflight: { false }, requestAccess: {})
        XCTAssertEqual(probe.state, .unverifiable)
        XCTAssertFalse(probe.hasPendingRequestThisRun, "措辞那一面仍然要说这次没问过")
    }

    /// 请求后 preflight 仍 false，这句只支持"这次没量到授权"，不支持"系统拒绝了"，也不支持
    /// "系统还没决定"。从前这里断言 `.denied`（一个 TCC 没做过的决定被写成事实，面板据此打
    /// 「已拒绝」），2026-10-19 那轮把它救到 `notDetermined`，本轮把同一枚布尔撑不起的第二句
    /// （"尚未决定"／「未请求」）也救掉。保护意图一条没动：没量到正解时不许点亮成 granted，
    /// 对外发的那一面也不许说"未请求"或"已拒绝"。
    func testUnverifiableAfterRequestWhenNobodyAnswered() {
        var requestCount = 0
        let probe = makeProbe(preflight: { false }, requestAccess: { requestCount += 1 })
        let outcome = probe.guideAccess()
        XCTAssertNotEqual(outcome, .granted, "预检仍然 false，请求没有被回答时不许点亮")
        XCTAssertNotEqual(outcome, .denied, "没人回答的询问不是一次拒绝")
        XCTAssertNotEqual(outcome, .notDetermined, "「系统尚未决定」同样是一次没做过的测量")
        XCTAssertEqual(outcome, .unverifiable, "产品对「没量到」的说法就是这一个值")
        XCTAssertEqual(requestCount, 1)
        XCTAssertNotEqual(probe.state, .granted)
        XCTAssertNotEqual(probe.state, .denied)
        XCTAssertEqual(probe.panelStatus, .unverifiable,
                       "面板读的那一面既不能是「已拒绝」也不能是「未请求」")
    }

    // MARK: - 边界：请求后授权成功

    func testGrantedAfterGuideAccessWhenRequestEnablesPermission() {
        // 授权弹窗确认后 preflight 翻转 true → guideAccess 返回 granted。
        // 起点从前钉 `notDetermined`（「未请求」）——那是替读者断言一段历史，而
        // `CGPreflightScreenCaptureAccess()` 的一个 false 分不清"没问过 / 问过还在等 /
        // 早前被拒 / 条目被删"（2026-10-30 S1-3，与 `AccessibilityPermissionProbe` 同一
        // 条理由）。这一支现在钉的是探针真正答得出的那一句。
        var granted = false
        let probe = makeProbe(
            preflight: { granted },
            requestAccess: { granted = true }
        )
        XCTAssertEqual(probe.state, .unverifiable)
        XCTAssertEqual(probe.guideAccess(), .granted)
        XCTAssertEqual(probe.state, .granted)
    }

    func testStateTransitionNotDeterminedToDeniedPersists() {
        // 同一实例多次观测：请求后 preflight 维持 false 时不许回落到"这次没问过"。
        // 这条单调性是真实缺陷的记忆，原话保留：问过之后还对读者说"未请求"，就是
        // 把这次询问抹掉了。它原来钉的值是 `denied`，而那个值从没有人量到过——所以
        // 这里把它钉在面板真正读的那一面（`panelStatus`）上。2026-10-30 S1-3 把起点
        // 也一起改了：一个 false 分不清"没问过 / 早前被拒 / 条目被删"，因此未请求那一档
        // 同样是 `unverifiable`；`notDetermined` 从这里开始不再由预检产生。
        var allowed = false
        var requested = false
        let probe = makeProbe(
            preflight: { allowed },
            requestAccess: { requested = true }
        )
        XCTAssertEqual(probe.state, .unverifiable)
        XCTAssertEqual(probe.panelStatus, .unverifiable,
                       "还没问过：一个布尔撑不起\"没问过\"这段历史，诚实值是未验证")
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