import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// The occlusion count decides whether the display-region crop is offered, and
/// offering it while something covers the target measures somebody else's pixels
/// and reports them as the app's appearance (R6-11). The count now takes the
/// window list as an argument, so the neighbours a live window server cannot be
/// asked to produce on demand — a missing layer, a window below the desktop
/// level, unreadable bounds — are tested as behaviour.
final class OcclusionCountParsingTests: XCTestCase {

    private let target = 100
    private let targetFrame = CGRect(x: 10, y: 10, width: 200, height: 200)

    private func window(
        _ number: Int?, layer: Int?, x: CGFloat = 0, y: CGFloat = 0,
        width: CGFloat = 400, height: CGFloat = 400
    ) -> [String: Any] {
        var entry: [String: Any] = [
            kCGWindowBounds as String: [
                "X": x, "Y": y, "Width": width, "Height": height
            ]
        ]
        if let number { entry[kCGWindowNumber as String] = number }
        if let layer { entry[kCGWindowLayer as String] = layer }
        return entry
    }

    private func counted(_ list: [[String: Any]]) -> [Int]? {
        SCKCapturer.occludingWindows(in: list, inFrontOf: target, frame: targetFrame)
    }

    func testOverlappingWindowAheadOfTheTargetIsNamed() {
        let list = [window(7, layer: 0), window(target, layer: 0)]
        XCTAssertEqual(counted(list), [7], "the window in front and overlapping must be reported")
    }

    func testNonOverlappingWindowAheadIsNotAccused() {
        let list = [window(7, layer: 0, x: 5_000, y: 5_000, width: 10, height: 10), window(target, layer: 0)]
        XCTAssertEqual(counted(list) ?? [0], [], "a window in front but nowhere near the target covers nothing")
    }

    func testNegativeLayerIsBehindAndLeavesTheCountTrustworthy() {
        // Wallpaper / dock backing genuinely sit behind app content: skipping them
        // is a measurement, not silence.
        let list = [window(7, layer: -1), window(target, layer: 0)]
        XCTAssertEqual(counted(list), [], "a layer below the desktop level does not cover the target")
    }

    func testMissingLayerRefusesTheCountInsteadOfCallingTheNeighbourBehind() {
        let list = [window(7, layer: nil), window(target, layer: 0)]
        XCTAssertNil(
            counted(list),
            "no layer entry means nothing was learned about that window; answering \"nothing covers it\" is R6-11"
        )
    }

    func testUnreadableBoundsRefuseTheCount() {
        let broken: [String: Any] = [
            kCGWindowNumber as String: 7,
            kCGWindowLayer as String: 0,
            kCGWindowBounds as String: ["X": 0, "Y": 0]
        ]
        XCTAssertNil(counted([broken, window(target, layer: 0)]))
    }

    func testWindowWithoutANumberRefusesTheCount() {
        XCTAssertNil(counted([window(nil, layer: 0), window(target, layer: 0)]))
    }

    func testTargetAbsentFromTheListRefusesTheCount() {
        XCTAssertNil(
            counted([window(7, layer: 0)]),
            "the list never reached the target, so what sits above it is unknown"
        )
    }

    func testWindowsAfterTheTargetAreBehindItAndIgnored() {
        let list = [
            window(7, layer: 0),
            window(target, layer: 0),
            window(9, layer: 0)
        ]
        XCTAssertEqual(counted(list), [7], "the list is front-to-back: only entries before the target are above it")
    }
}
