import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// macOS 13 像素通道的倍率来源闸（每日任务 2026-10-22，缺陷「量不到就假设 2x」）。
///
/// 修的那件事：`streamPixelScale` 从前在挑不到屏幕时 `?? 2.0`。一次没量到就替用户的
/// 显示器宣布它是 Retina，产出的图是插值过的，而那张图会作为**测量值**进证据档案——
/// 与本文件 :15/:163/:518 已经写下的"任何未测量都走 pixelCaptureDenied"相反。
///
/// 判据抽成纯函数是因为 `SCStream` 需要真实窗口与屏幕录制席位（`SCKCapturerDiagnosticTests`
/// 因此一直是 opt-in），而"相交到哪一块屏"这件事在本机一块屏上永远只有一种答案。
final class DailyRound20261022CaptureScaleTests: XCTestCase {

    private let window = CGRect(x: 100, y: 100, width: 400, height: 300)

    private func screen(_ frame: CGRect, _ scale: CGFloat) -> (frame: CGRect, scale: CGFloat) {
        (frame, scale)
    }

    /// 唯一一块与窗口相交的屏幕：它的倍率就是这一趟的读数，两种倍率都必须照实传下去。
    func testSingleOverlappingScreenIsTheOnlyUnambiguousReading() {
        let one = SCKCapturer.pixelScale(
            from: [screen(CGRect(x: 0, y: 0, width: 1440, height: 900), 2.0)], windowFrame: window)
        XCTAssertEqual(one, 2.0)
        let square = SCKCapturer.pixelScale(
            from: [screen(CGRect(x: 0, y: 0, width: 1440, height: 900), 1.0)], windowFrame: window)
        XCTAssertEqual(square, 1.0,
                       "1x 显示器不是拒绝的理由：把 1.0 折成 2.0 才是那条缺陷")
    }

    /// 一块都不相交：没有读数，不许编一个。
    func testNoOverlappingScreenRefusesInsteadOfAssuming() {
        XCTAssertNil(SCKCapturer.pixelScale(
            from: [screen(CGRect(x: 5000, y: 5000, width: 800, height: 600), 2.0)],
            windowFrame: window))
        XCTAssertNil(SCKCapturer.pixelScale(from: [], windowFrame: window),
                     "屏幕列表为空（无窗口会话、登出中的 Aqua session）同样不许落到一个默认倍率")
    }

    /// 两块都相交：Cocoa 左下全局空间与 SCK/CG 左上全局空间不是同一套坐标，
    /// 多屏时这个挑法可能挑到另一块屏——歧义就是不测量，不是二选一。
    func testAmbiguousOverlapIsNotAMeasurement() {
        XCTAssertNil(SCKCapturer.pixelScale(from: [
            screen(CGRect(x: 0, y: 0, width: 1440, height: 900), 2.0),
            screen(CGRect(x: 1440, y: 0, width: 2560, height: 1440), 1.0),
        ], windowFrame: window))
    }

    /// 读数本身不成数（0、负、NaN、inf）时不算一块有效屏幕：要么剩下唯一一块，要么是拒绝。
    func testUnusableScaleValuesAreNotCandidates() {
        for bogus: CGFloat in [0.0, -2.0, .nan, .infinity] {
            XCTAssertNil(SCKCapturer.pixelScale(from: [
                screen(CGRect(x: 0, y: 0, width: 1440, height: 900), bogus),
            ], windowFrame: window), "\(bogus) 不能当成一次倍率测量")
        }
        XCTAssertEqual(SCKCapturer.pixelScale(from: [
            screen(CGRect(x: 5000, y: 5000, width: 800, height: 600), .nan),
            screen(CGRect(x: 0, y: 0, width: 1440, height: 900), 2.0),
        ], windowFrame: window), 2.0,
                       "不成数的那一块本来就不该参与计数，把唯一一块合格的屏判成歧义是另一种假拒绝")
    }

    /// 拒绝必须真的接到采集上：`snapViaStream` 里量不到倍率的那一臂要抛 `pixelCaptureDenied`，
    /// 而不是继续往下走。这条静态闸防的是"纯函数修好了、调用点又把它折回一个默认值"。
    /// REVERSE：把 `guard let scale = streamPixelScale` 换回 `streamPixelScale(for:) ?? 2.0` → 红。
    func testCallerRefusesRatherThanFillingInAScale() throws {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/GlassPaneEngine/SCKCapturer.swift")
        let source = try String(contentsOf: path, encoding: .utf8)
        XCTAssertFalse(source.contains("?? 2.0"),
                       "倍率上又出现了一个假设值：这一条就是被修掉的那个默认值")
        XCTAssertTrue(source.contains("guard let scale = streamPixelScale(for: windowFrame) else"),
                      "调用点没有把「量不到」当成拒绝，倍率的纯函数闸就只是摆设")
    }
}
