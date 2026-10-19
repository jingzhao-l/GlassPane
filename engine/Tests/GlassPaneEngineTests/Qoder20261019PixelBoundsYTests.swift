import XCTest
import CoreGraphics
import ImageIO
import AppKit
@testable import GlassPaneEngine

/// `PixelRect.y`'s coordinate origin, pinned against an external ground truth.
///
/// **This batch did not change `PixelDiff` — the reported defect did not reproduce,
/// measured on this machine.** The report claimed `bounds.y` was a bottom-origin bitmap
/// row index because `rgba8Bitmap` normalizes through a `CGContext` (whose user space is
/// lower-left). Three measurements say otherwise:
///  1. `CGContext.draw(image, in: CGRect(0,0,w,h))` — the exact call `rgba8Bitmap` makes
///     — is **index preserving**: a `CGDataProvider` image whose row 0 is red lands with
///     red at normalized buffer row 0 (`/var/tmp/gp-main-20261019/exp/differrows.swift`).
///  2. That same image, written to PNG through ImageIO, has red as the **first scanline**,
///     which the PNG format defines as the top row; an external reader (Pillow) reports
///     `pixel(0,0) == (255,0,0,255)` and `pixel(0,h-1) == (0,0,255,255)`
///     (`/var/tmp/gp-main-20261019/exp/topdown.swift`). So CGImage data row 0 is the
///     picture's top, not its bottom.
///  3. `NSBitmapImageRep(cgImage:)` reports the same row 0.
/// Chain (1)+(2): normalized row index 0 == picture top, so `bounds.y == 0` already means
/// what `PixelDiff.swift:10-11` documents ("row 0 = top"). Flipping `y` would have made
/// the number wrong and broken the contract the report line
/// (`EvidenceReportGenerator.swift:84`) and the panel row ("变化区域") publish.
///
/// What this file *is*: the regression net `PixelDiffTests:26` admitted it could not
/// write ("only the x/width facts are orientation-independent"). It pins the y-axis
/// orientation against a fixture whose top is defined outside CoreGraphics.
///
/// Fixture note: `TestImages.image` builds its `CGImage` from a `CGContext` and hands
/// `paint(x, y)` the buffer index directly — usable here only after (2) proves which end
/// of that buffer is the picture's top, so this file goes one level lower, straight to
/// `CGDataProvider`, whose row order is fixed by (2) against the PNG format itself.
final class Qoder20261019PixelBoundsYTests: XCTestCase {

    private let width = 32
    private let height = 32

    /// An opaque RGB image whose **data row 0 is its top row** — the convention verified
    /// against ImageIO's PNG output and an external PNG reader above.
    private func image(changedRows: ClosedRange<Int>) -> CGImage {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for row in 0..<height {
            let changed = changedRows.contains(row)
            for column in 0..<width {
                let offset = (row * width + column) * 4
                pixels[offset] = changed ? 240 : 60          // R
                pixels[offset + 1] = 60                      // G
                pixels[offset + 2] = 60                      // B
                pixels[offset + 3] = 255                     // A (opaque: a zero alpha
            }                                                  // would draw as nothing)
        }
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        return CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )!
    }

    private func uniformImage() -> CGImage {
        image(changedRows: 1000...1000)   // no row matches: every row is the base gray
    }

    /// The top of the picture is `bounds.y == 0`: a change confined to the picture's top
    /// rows must not be reported as a change near the bottom (row 28 of 32).
    func testChangeAtTheTopOfThePictureReportsTopOriginY() throws {
        let outcome = try PixelDiffer.diff(before: uniformImage(), after: image(changedRows: 0...3))
        XCTAssertEqual(outcome.changedPixelRatio, 4.0 / 32.0, accuracy: 1e-9)
        let bounds = try XCTUnwrap(outcome.bounds)
        XCTAssertEqual(bounds.y, 0, accuracy: 1e-9, "row 0 = top is the documented contract")
        XCTAssertEqual(bounds.height, 4, accuracy: 1e-9)
    }

    /// The mirror case, which is what makes the pair above a test rather than a tautology:
    /// a change confined to the **bottom** rows is the last rows of a top-origin
    /// rectangle. Negating `y` instead of flipping inside the height turns this red, and
    /// so does "always report 0".
    func testChangeAtTheBottomOfThePictureReportsTheLastRows() throws {
        let outcome = try PixelDiffer.diff(
            before: uniformImage(),
            after: image(changedRows: (height - 4)...(height - 1))
        )
        let bounds = try XCTUnwrap(outcome.bounds)
        XCTAssertEqual(bounds.y, Double(height - 4), accuracy: 1e-9,
                       "the bottom 4 rows of a 32-row top-origin image start at row 28")
        XCTAssertEqual(bounds.height, 4, accuracy: 1e-9)
    }

    /// A band in the middle pins the index to the row itself rather than to either edge:
    /// rows 8...11 counted from the top stay at y = 8.
    func testMiddleBandKeepsItsTopOriginRow() throws {
        let outcome = try PixelDiffer.diff(before: uniformImage(), after: image(changedRows: 8...11))
        let bounds = try XCTUnwrap(outcome.bounds)
        XCTAssertEqual(bounds.y, 8, accuracy: 1e-9)
        XCTAssertEqual(bounds.height, 4, accuracy: 1e-9)
    }

    /// The facts the old test could already pin survive the fixture change
    /// (`PixelDiffTests:26` called x/width orientation-independent — they still are).
    func testXAndWidthAreUntouchedByTheFixture() throws {
        var pixels = [UInt8](repeating: 60, count: width * height * 4)
        for row in 0..<height {
            for column in 0..<8 {
                pixels[(row * width + column) * 4] = 240
            }
            for column in 0..<width {
                pixels[(row * width + column) * 4 + 3] = 255
            }
        }
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        let after = CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        )!
        let bounds = try XCTUnwrap(PixelDiffer.diff(before: uniformImage(), after: after).bounds)
        XCTAssertEqual(bounds.x, 0, accuracy: 1e-9)
        XCTAssertEqual(bounds.width, 8, accuracy: 1e-9)
        XCTAssertEqual(bounds.height, Double(height), accuracy: 1e-9,
                       "a full-height change keeps the full height")
    }

    // MARK: - The fixture's "top" defined outside CoreGraphics

    /// The claim the whole `bounds.y` dispute rests on is that a `CGDataProvider`
    /// image's **data row 0 is the picture's top row**. That is a fact about a format,
    /// not about CoreGraphics, so it is pinned here with two witnesses that are not
    /// `CGContext`:
    ///  - `NSBitmapImageRep` documents its row order as top-down (AppKit), and reports
    ///    row 0 = the row `CGDataProvider` was handed first;
    ///  - the same image written to PNG through ImageIO and read back through a PNG
    ///    *decoder* has that row as the first scanline — and PNG's first scanline is
    ///    the top row **by format definition** (ISO/IEC 15948).
    ///
    /// Cross-checked on this machine outside the suite, against a reader that shares no
    /// code with Apple's frameworks (run from `/var/tmp/gp-main-20261019/exp4`):
    /// `python3 -c "from PIL import Image; …"` reported `pixel(0,0) == (255,0,0,255)`
    /// and `pixel(0,h-1) == (0,0,255,255)` for exactly this fixture shape.
    ///
    /// With "row 0 == top" settled, the three orientation cases above mean what they
    /// say, and `bounds.y` is already top-origin: item 4's claimed inversion does not
    /// reproduce on this machine, and flipping `y` would have made the published number
    /// wrong.
    func testFixtureRowZeroIsThePictureTopByContractsOutsideCoreGraphics() throws {
        let red = image(changedRows: 0...0)   // data row 0 red, everything else blue-ish
        let rep = try XCTUnwrap(NSBitmapImageRep(cgImage: red),
                                "AppKit 的解码路径拿不到这张 CGImage")
        XCTAssertEqual(rep.colorAt(x: 0, y: 0)?.redComponent ?? -1, 240.0 / 255.0, accuracy: 1.0 / 255.0,
                       "NSBitmapImageRep 行序是文档化的自上而下：row 0 就是图的顶行")
        XCTAssertEqual(rep.colorAt(x: 0, y: height - 1)?.blueComponent ?? -1, 60.0 / 255.0, accuracy: 2.0 / 255.0,
                       "底行是 CGDataProvider 的最后一行")

        // PNG round trip: encode, then decode as PNG (a format reader) and look at the
        // first scanline. ImageIO's PNG encoder writes data row 0 as scanline 0, and the
        // format defines scanline 0 as the top row.
        // Written inside `TestSandbox` — the isolation gate in this suite bans a test
        // from peeking at the shared temp location by hand.
        let url = URL(fileURLWithPath: TestSandbox.directory("pngground") + "/rowground.png")
        defer { try? FileManager.default.removeItem(at: url) }
        let destination = try XCTUnwrap(
            CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
        )
        CGImageDestinationAddImage(destination, red, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination), "PNG 写盘失败，这条断言就没有依据")

        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil), "写出来的不是 PNG")
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil), "PNG 解不回来")
        let decodedRep = try XCTUnwrap(NSBitmapImageRep(cgImage: decoded))
        XCTAssertEqual(decodedRep.colorAt(x: 0, y: 0)?.redComponent ?? -1, 240.0 / 255.0, accuracy: 1.0 / 255.0,
                       "PNG 顶行读回来还是 CGDataProvider 的 row 0")
    }
}
