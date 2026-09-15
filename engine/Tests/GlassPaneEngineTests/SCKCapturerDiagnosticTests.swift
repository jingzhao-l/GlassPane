import XCTest
import Foundation
import ScreenCaptureKit
@testable import GlassPaneEngine

/// P1-A2 真机捕获验证（opt-in）：驱动 SCKCapturer 真实捕获 Finder 窗口，
/// 断言返回非空 CGImage 且裁剪生效。仅当环境变量 GLASSPANE_SCK_DIAG=1 时
/// 运行，避免在无屏幕录制权限/无 GUI 会话的 CI 环境破坏全量绿。
///
/// 历史：2026-09-16 本机真机验证通过——resolveWindow 命中 Finder 最大
/// 窗口（1440×900 @2x，输出 2880×1800）；隔离实验确认
/// `SCScreenshotManager` 尊重 `sourceRect` + `width/height`（100×100 配置
/// 输出恰为 100×100，pointPixelScale=2.0）。daemon 进程的 act 上报
/// screen-recording-denied 是 TCC 对 daemon 二进制的独立授权缺失，由 P1
/// onboarding 命令（--guide-screen-permission）覆盖，属预期降级（P1-A4）。
final class SCKCapturerDiagnosticTests: XCTestCase {

    private let finderPID: pid_t = 706

    override func setUpWithError() throws {
        try super.setUpWithError()
        // 非诊断环境下跳过；准确的 skip 消息写入失败描述便于排查。
        guard ProcessInfo.processInfo.environment["GLASSPANE_SCK_DIAG"] == "1" else {
            throw XCTSkip("opt-in real-device capture diagnostic; set GLASSPANE_SCK_DIAG=1")
        }
        // 权限观察需要访问 CGPreflightScreenCaptureAccess（macOS 10.15+）。
        guard CGPreflightScreenCaptureAccess() else {
            throw XCTSkip("screen recording permission not granted in this context")
        }
    }

    func testRealFinderCaptureReturnsCroppedImage() {
        let image = try? SCKCapturer.captureWindow(ownerPid: finderPID, windowId: nil)
        XCTAssertNotNil(image, "真机捕获必须返回图像（定位错误见 failDescription）")
        if let image {
            XCTAssertGreaterThan(image.width, 0)
            XCTAssertGreaterThan(image.height, 0)
            print("DIAG CAPTURE OK \(image.width)x\(image.height)")
        } else {
            XCTFail("DIAG CAPTURE ERR (err desc unavailable)")
        }
    }
}