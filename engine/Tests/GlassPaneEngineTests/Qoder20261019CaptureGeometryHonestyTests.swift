import XCTest
import CoreGraphics
import ScreenCaptureKit
@testable import GlassPaneEngine

/// Items 2 and 3 (2026-10-19 lane) — capture geometry honesty.
///
/// ## What this file proves, and what it deliberately does not
///
/// **Proved here: the RECT MATH and the PIXEL-SIZE MATH only.** Every case drives a
/// pure helper (`SCKCapturer.cropRect`, `SCKCapturer.outputPixels`) or the single
/// shared `SCStreamConfiguration` construction point, with rectangles handed in as
/// data. No SCK session is started, no frame is captured.
///
/// **NOT proved here — recorded as 未观测 (not observed), not as verified:** the
/// *on-device consequence* of the item-2 defect, i.e. that a display whose origin is
/// not `(0,0)` makes ScreenCaptureKit sample a different screen area and the result
/// is then returned labelled as that window's pixels. Stating that needs a real
/// two-display machine (one non-primary display with a non-zero origin, a window on
/// it, and a comparison of the produced image against the window's own surface). This
/// machine has one display at origin (0,0) — measured on 2026-10-19 with
/// `NSScreen.screens.map(\.frame)` → exactly one entry, `(0.0, 0.0, 1440.0, 900.0)` —
/// so the rig does not exist here and
/// the consequence cannot be measured. What *is* measured on this machine is the
/// contradiction the code itself rests on: `SCKCapturer` compares `context.window.frame`
/// against `display.frame` (`selectDisplayIndex`), which only makes sense in one
/// coordinate space, and the repo's own P1 spec states `sourceRect` is
/// display-logical (`specs/GlassPane_P1_实施规格_v1.0_SCK迁移.md:37`).
///
/// One more limit, stated so nobody reads more into this file than is in it: the
/// `surfacePlan` wiring (the fallback candidate that now carries the converted crop,
/// plus the refusal branch when `cropRect` returns nil) needs a real `SCDisplay` and
/// `SCContentFilter`, and neither has a public initialiser — so that hop is covered by
/// the two call sites in `SCKCapturer.swift`, not by a test. What reaches
/// `config.sourceRect` *is* pinned below, at the single construction point both OS
/// capture paths now share.
///
/// ## The two shapes being refused
///  1. `config.sourceRect` ← the window's **global** frame, while the SDK wants
///     **display-local** coordinates. On a secondary display these name different
///     areas of the world; on the primary display origin `(0,0)` they coincide, which
///     is exactly why a one-display machine never noticed.
///  2. A sub-pixel region + `max(1, ceil(region × scale))` manufactures the
///     "legal but blank 1×1 capture" that the adjacent comment claims the code
///     refuses, and feeds a one-pixel "ratio" into the evidence chain. The fix refuses
///     and says so; it never produces an image.
final class Qoder20261019CaptureGeometryHonestyTests: XCTestCase {

    private func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
        CGRect(x: x, y: y, width: w, height: h)
    }

    // MARK: - Item 2: sourceRect is display-LOCAL, not the window's global frame

    /// The degenerate case that hid the defect: on a primary display at origin (0,0)
    /// the global frame and the display-local rect are the same numbers.
    func testPrimaryDisplayAtOriginLeavesTheCropUnchanged() throws {
        let window = rect(120, 80, 640, 480)
        let display = rect(0, 0, 1920, 1080)
        XCTAssertEqual(
            try XCTUnwrap(SCKCapturer.cropRect(window: window, display: display)),
            window,
            "原点是 (0,0) 时换算必须是恒等，否则这次修复本身引入了新的错位"
        )
    }

    /// Left-of-primary: a negative display origin. The window's global x is negative;
    /// the display-local x is `window.minX - display.minX`, and it has to land inside
    /// the display's own extent.
    func testCropSubtractsANegativeDisplayOrigin() throws {
        let display = rect(-1920, 0, 1920, 1080)      // left of primary
        let window = rect(-1500, 200, 400, 300)       // 420 pt from that display's own left edge
        let crop = try XCTUnwrap(SCKCapturer.cropRect(window: window, display: display))
        XCTAssertEqual(crop.origin, CGPoint(x: 420, y: 200),
                       "裁剪必须落在这块屏自己的坐标系里 (x = -1500 - (-1920))")
        XCTAssertEqual(crop.size, window.size, "尺寸不能被换算动过")
        // 校验对象是**这块屏的本地范围** (0,0,w,h)，不是 `display.frame`：拿全局矩形去
        // contains 一个本地矩形，正是这条缺陷犯的同一类错。
        XCTAssertTrue(CGRect(origin: .zero, size: display.size).contains(crop),
                      "换算后的矩形必须在这块屏的本地范围内，否则它不是这块屏上的窗口")
    }

    /// Right-of-primary: a positive display origin (the common second-monitor case).
    func testCropSubtractsAPositiveDisplayOrigin() throws {
        let display = rect(1920, 0, 1920, 1080)
        let window = rect(2000, 100, 640, 480)
        let crop = try XCTUnwrap(SCKCapturer.cropRect(window: window, display: display))
        XCTAssertEqual(crop.origin, CGPoint(x: 80, y: 100))
        XCTAssertEqual(crop.size, window.size)
        XCTAssertTrue(CGRect(origin: .zero, size: display.size).contains(crop),
                      "同样是与这块屏的**本地**范围比对，不是全局 display.frame")
        XCTAssertNotEqual(crop, window,
                          "全局 frame 原样交给 sourceRect 就是这条缺陷本身：两个数字不同才叫换算过")
    }

    /// Vertical offset too — menus/scaler origins put secondary displays off the x axis.
    func testCropSubtractsBothAxes() throws {
        let display = rect(0, -360, 1440, 900)
        let window = rect(100, -260, 300, 200)
        let crop = try XCTUnwrap(SCKCapturer.cropRect(window: window, display: display))
        XCTAssertEqual(crop.origin, CGPoint(x: 100, y: 100))
    }

    /// A window that does not overlap the chosen display must be **refused**, not
    /// cropped to nonsense: subtracting an unrelated display origin would produce a
    /// rectangle that is inside neither the window nor that screen.
    func testWindowOutsideTheChosenDisplayIsRefusedNotCropped() {
        XCTAssertNil(
            SCKCapturer.cropRect(window: rect(5000, 5000, 200, 120), display: rect(0, 0, 1920, 1080)),
            "不相交 ⇒ 没有可诚实表达的裁剪，返回 nil 让调用方拒绝，而不是给一个数字"
        )
        XCTAssertNil(
            SCKCapturer.cropRect(window: rect(-3000, 0, 200, 120), display: rect(0, 0, 1920, 1080)),
            "负方向的离屏窗口同样只能拒绝"
        )
    }

    /// Degenerate inputs are refusals too: a null/empty rect has no crop, and
    /// `CGRect.intersects` answers `true` for an empty rect sitting inside a display
    /// (which is how the old 1×1 path got in at all).
    ///
    /// Honest correction made while writing this: `CGRect(x:100, y:100, w:400, h:-1)`
    /// does **not** keep a negative height — CoreGraphics normalises it on construction
    /// to `(100, 99, 400, 1)`. So "negative size" is not a shape this guard can ever be
    /// handed, and asserting a refusal there would be testing an impossible input; the
    /// last case pins what the normalisation actually produces instead.
    func testEmptyAndNonFiniteWindowsAreRefused() {
        let display = rect(0, 0, 1920, 1080)
        XCTAssertNil(SCKCapturer.cropRect(window: .zero, display: display))
        XCTAssertNil(SCKCapturer.cropRect(window: rect(100, 100, 0, 400), display: display))
        XCTAssertNil(SCKCapturer.cropRect(window: rect(100, 100, 400, 0), display: display))
        XCTAssertNil(SCKCapturer.cropRect(window: rect(100, 100, .nan, 400), display: display))
        XCTAssertNil(SCKCapturer.cropRect(window: rect(100, 100, .infinity, 400), display: display))
        XCTAssertNil(SCKCapturer.cropRect(window: rect(100, 100, 400, 300), display: .null))
        // CG 把负高度规范化成 1 pt 高的矩形；这条不是"拒绝"，是"照它变成的样子裁"。
        XCTAssertEqual(
            SCKCapturer.cropRect(window: rect(100, 100, 400, -1), display: display),
            rect(100, 99, 400, 1)
        )
        // 而 1 pt 高的区域仍然会采出 1 px 的一条边 —— 那一格由 `outputPixels` 拒绝。
        XCTAssertNil(SCKCapturer.outputPixels(region: rect(100, 99, 400, 1), scale: 1))
    }

    /// The wiring, not just the arithmetic: the rect that reaches
    /// `SCStreamConfiguration.sourceRect` must be the **converted** one. This is the
    /// single construction point both OS paths go through, so one assertion here
    /// covers `snapViaScreenshotManager` and `snapViaStream` alike.
    func testConfigurationHandsSourceRectTheDisplayLocalCropNotTheGlobalFrame() throws {
        let display = rect(1920, 0, 1920, 1080)
        let window = rect(2000, 100, 640, 480)
        let crop = try XCTUnwrap(SCKCapturer.cropRect(window: window, display: display))
        guard case .configured(let config) = SCKCapturer.configuration(
            region: crop, displayLocalCrop: crop, scale: 2
        ) else {
            return XCTFail("640x480 的正常窗口 @2x 不该被拒绝——它是这条换算的对照组")
        }
        XCTAssertEqual(config.sourceRect, crop,
                       "sourceRect 收到的是换算后的矩形；收到全局 frame 就是缺陷本身")
        XCTAssertNotEqual(config.sourceRect, window,
                          "config.sourceRect == 窗口全局 frame ⇒ 采到的是另一块屏上的同一串坐标")
    }

    // MARK: - Item 3: never manufacture a sub-pixel picture

    /// A sub-pixel region must not become "1 pixel of somebody else's screen".
    func testSubPixelRegionIsRefusedInsteadOfManufacturedOnePixelImage() {
        for region in [rect(0, 0, 0.4, 300), rect(0, 0, 640, 0.3), rect(0, 0, 0.4, 0.4)] {
            XCTAssertNil(
                SCKCapturer.outputPixels(region: region, scale: 2),
                "\(region.width)x\(region.height) pt @2x 会凑成 1 px 的一条边——那必须是一次拒绝，不是一个尺寸"
            )
        }
        // The exact boundary the old `max(1, ceil(…))` turned into a picture:
        XCTAssertNil(SCKCapturer.outputPixels(region: rect(0, 0, 0.5, 0.5), scale: 2),
                     "ceil(0.5×2) == 1：正是那条注释声称它拒绝的「合法但空白的 1×1」")
        XCTAssertNil(SCKCapturer.outputPixels(region: rect(0, 0, 1, 400), scale: 1),
                     "1 pt @1x 同样只有一条像素，不足以成为一次像素差")
    }

    /// Control: a normal window still gets its real output size through the **same**
    /// function — the refusal above is not a blanket failure.
    func testNormalRegionStillGetsItsRealPixelSize() throws {
        let pixels = try XCTUnwrap(SCKCapturer.outputPixels(region: rect(0, 0, 640, 480), scale: 2))
        XCTAssertEqual(pixels.width, 1280)
        XCTAssertEqual(pixels.height, 960)
        // Retina sub-point rounding must not be pushed down to 1 px either way:
        let odd = try XCTUnwrap(SCKCapturer.outputPixels(region: rect(0, 0, 100.5, 80), scale: 2))
        XCTAssertEqual(odd.width, 201, "半 pt 向上取整保留（不降采样这条既有语义不变）")
        XCTAssertEqual(odd.height, 160)
    }

    /// Garbage in, refusal out: a non-positive or non-finite scale cannot produce a
    /// picture either.
    func testUnusableScaleIsRefused() {
        XCTAssertNil(SCKCapturer.outputPixels(region: rect(0, 0, 640, 480), scale: 0))
        XCTAssertNil(SCKCapturer.outputPixels(region: rect(0, 0, 640, 480), scale: -2))
        XCTAssertNil(SCKCapturer.outputPixels(region: rect(0, 0, 640, 480), scale: .nan))
    }

    /// The refusal has to *reach the caller* as a refusal. `captureConfiguration` is
    /// the only place both paths build their config, so this is where "1 px" becomes
    /// an error instead of a `SCStreamConfiguration` — and the wording must not read
    /// as a measurement outcome ("no change", "blank", a ratio).
    func testConfigurationRefusesSubPixelRegionWithAStatedReason() throws {
        let outcome = SCKCapturer.configuration(
            region: rect(0, 0, 0.4, 300), displayLocalCrop: rect(0, 0, 0.4, 300),
            scale: 2
        )
        guard case .refused(let error) = outcome else {
            return XCTFail("亚像素区域必须被拒绝，实际拿到了一个配置对象 = 一张会进证据包的图")
        }
        guard case .pixelCaptureDenied(let reason) = error else {
            return XCTFail("必须是 pixelCaptureDenied（P0 §8 的未测量通道），实际 \(error)")
        }
        XCTAssertFalse(reason.isEmpty)
        XCTAssertTrue(reason.contains("no image is produced"),
                      "拒绝必须明说「不产图」，否则读的人会以为只是采到了别的东西: \(reason)")
        XCTAssertTrue(reason.contains("1"),
                      "拒绝要带上算出来的像素尺寸，否则无从复核: \(reason)")
        for banned in ["no change", "not changed", "unchanged", "未变", "没变", "did not change"] {
            XCTAssertFalse(reason.lowercased().contains(banned),
                           "拒绝不能写成测量结论（\"\(banned)\"）：未测量 ≠ 没变化 \(reason)")
        }
    }

    /// Control for the same path: a normal region yields a config, and the config's
    /// dimensions are the honest pixel count.
    func testConfigurationProducesAConfigForANormalWindow() throws {
        guard case .configured(let config) = SCKCapturer.configuration(
            region: rect(0, 0, 640, 480), displayLocalCrop: rect(80, 100, 640, 480), scale: 2
        ) else {
            return XCTFail("正常窗口必须照常拿到配置（对照组），实际拿不到")
        }
        XCTAssertEqual(config.width, 1280)
        XCTAssertEqual(config.height, 960)
        XCTAssertEqual(config.sourceRect, rect(80, 100, 640, 480))
    }

    /// The shared construction point owns **only** the geometry: it must not silently
    /// name a pixel format (the SCStream branch declares its own — that declaration is
    /// what `CaptureChannelShapeTests.testFirstFrameFormatIsDeclaredAndCheckedNotAssumed`
    /// pins, and moving it here would take it off the path that needs it), and it must
    /// not attach a sourceRect to a window-surface filter.
    func testConfigurationLeavesPixelFormatAndSourceRectAloneForWindowSurface() throws {
        guard case .configured(let config) = SCKCapturer.configuration(
            region: rect(0, 0, 640, 480), displayLocalCrop: nil, scale: 2
        ) else {
            return XCTFail("640x480 @2x 不该被拒绝")
        }
        XCTAssertEqual(config.pixelFormat, SCStreamConfiguration().pixelFormat,
                       "构造点不得替 SCStream 那条点名格式，也不得改动另一条的默认值")
        XCTAssertEqual(config.sourceRect, SCStreamConfiguration().sourceRect,
                       "窗口自己的面不许挂 sourceRect——那是把显示器坐标系的矩形裁到窗口流上")
        XCTAssertEqual(config.sourceRect, .zero)
    }
}
