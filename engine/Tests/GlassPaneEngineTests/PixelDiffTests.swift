import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// A5: pixel diff on synthetic bitmaps (P0 spec §5.5).
final class PixelDiffTests: XCTestCase {

    func testIdenticalImagesYieldZeroRatio() throws {
        let before = TestImages.solid(128)
        let after = TestImages.solid(128)
        let outcome = try PixelDiffer.diff(before: before, after: after)
        XCTAssertEqual(outcome.changedPixelRatio, 0, accuracy: 1e-12)
        XCTAssertNil(outcome.bounds)
    }

    func testLeftHalfChangeYieldsHalfRatioAndColumnBounds() throws {
        let before = TestImages.solid(100)
        let after = TestImages.image { x, _ in
            x < 16 ? (220, 100, 100, 255) : (100, 100, 100, 255)
        }
        let outcome = try PixelDiffer.diff(before: before, after: after)
        // Exactly the left half of the pixels changed.
        XCTAssertEqual(outcome.changedPixelRatio, 0.5, accuracy: 1e-9)
        let bounds = try XCTUnwrap(outcome.bounds)
        // The changed region is a full-height column at the left edge; only
        // the x/width facts are orientation-independent.
        XCTAssertEqual(bounds.x, 0, accuracy: 1e-9)
        XCTAssertEqual(bounds.width, 16, accuracy: 1e-9)
        XCTAssertEqual(bounds.height, 32, accuracy: 1e-9)
    }

    func testDeltaAtToleranceIsUnchanged() throws {
        // channelTolerance = 8: a delta of exactly 8 is within tolerance.
        let before = TestImages.solid(100)
        let after = TestImages.quadrantChanged(base: 100, delta: Int(PixelDiffer.channelTolerance))
        let outcome = try PixelDiffer.diff(before: before, after: after)
        XCTAssertEqual(outcome.changedPixelRatio, 0, accuracy: 1e-12)
    }

    func testDeltaJustAboveToleranceIsChanged() throws {
        let before = TestImages.solid(100)
        let after = TestImages.quadrantChanged(base: 100, delta: Int(PixelDiffer.channelTolerance) + 1)
        let outcome = try PixelDiffer.diff(before: before, after: after)
        XCTAssertGreaterThan(outcome.changedPixelRatio, 0)
        XCTAssertNotNil(outcome.bounds)
    }

    /// 尺寸不同＝没有共同定义域可比。旧实现在这里返回 `changedPixelRatio = 1`
    /// （"整屏都变了"）：一个像极了的测量值，实际一个像素都没比过。窗口在操作中间
    /// 被 resize 是常见结局，"界面变了"成立，"100% 像素变了"不成立——未测量必须由
    /// 调用方显式说，不能由差分函数替它编极值。
    func testMismatchedDimensionsRefuseToInventARatio() {
        let before = TestImages.solid(100, width: 32, height: 32)
        let after = TestImages.solid(100, width: 16, height: 32)
        XCTAssertThrowsError(try PixelDiffer.diff(before: before, after: after)) { error in
            XCTAssertEqual(
                error as? PixelDiffError,
                .geometryChanged(beforeWidth: 32, beforeHeight: 32, afterWidth: 16, afterHeight: 32),
                "错误里必须带上两个尺寸，否则调用方无从知道是'变了大小'而不是'编码器坏了'"
            )
        }
    }

    func testTinyAlphaDifferenceBelowToleranceIsUnchanged() throws {
        // 8-bit alpha noise under the channel tolerance must not register.
        let before = TestImages.solid(200)
        let after = TestImages.image { _, _ in (200, 200, 200, 255 - 4) }
        let outcome = try PixelDiffer.diff(before: before, after: after)
        XCTAssertEqual(outcome.changedPixelRatio, 0, accuracy: 1e-12)
    }
}
