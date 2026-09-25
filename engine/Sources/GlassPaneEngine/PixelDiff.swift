import Foundation
import CoreGraphics

/// Pure pixel-diff logic: compares two window captures in normalized RGBA8
/// space and reports the changed-pixel ratio plus the bounding box of the
/// changed region. Used by the act pipeline (Z5 channel, P0 spec §5.3/§5.5).
public struct PixelDiffOutcome: Equatable {
    /// Fraction of pixels whose channels differ beyond tolerance (0...1).
    public let changedPixelRatio: Double
    /// Bounding box of changed pixels in image coordinates (row 0 = top of
    /// the normalized bitmap); nil when nothing changed.
    public let bounds: PixelRect?
}

public struct PixelRect: Equatable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public enum PixelDiffError: Error, Equatable {
    /// The comparison could not be performed (bitmap normalization failed).
    case bitmapUnavailable
    /// 两张图的像素尺寸不同，逐像素比对没有共同定义域。
    ///
    /// 这里曾经直接返回 `changedPixelRatio = 1`（"整屏都变了"）：一个 0...1 之间的
    /// 数字，`bounds` 却是 nil，看起来完全像一次测完的结论。窗口在操作中间被 resized
    /// 是很正常的结局，"界面确实变了"成立，但"100% 的像素变了"是**没测过的事实**——
    /// 它会喂给分类器、写进证据包、出现在报告里。未测量必须由调用方显式表达，
    /// 不能由差分函数替它编一个极值。
    case geometryChanged(beforeWidth: Int, beforeHeight: Int, afterWidth: Int, afterHeight: Int)
}

public enum PixelDiffer {

    /// Per-channel absolute tolerance: differences at or below this value are
    /// treated as unchanged (antialiasing/compression noise).
    public static let channelTolerance = 8

    public static func diff(before: CGImage, after: CGImage) throws -> PixelDiffOutcome {
        let beforeBitmap = try rgba8Bitmap(of: before)
        let afterBitmap = try rgba8Bitmap(of: after)

        // Mismatched dimensions mean there is no common domain to compare over:
        // that is an explicit "not measured", not a ratio. See `geometryChanged`.
        guard beforeBitmap.width == afterBitmap.width,
              beforeBitmap.height == afterBitmap.height else {
            throw PixelDiffError.geometryChanged(
                beforeWidth: beforeBitmap.width, beforeHeight: beforeBitmap.height,
                afterWidth: afterBitmap.width, afterHeight: afterBitmap.height
            )
        }

        let width = beforeBitmap.width
        let height = beforeBitmap.height
        let total = width * height
        guard total > 0 else {
            return PixelDiffOutcome(changedPixelRatio: 0, bounds: nil)
        }

        var changedCount = 0
        var minX = Int.max, minY = Int.max, maxX = Int.min, maxY = Int.min
        for y in 0..<height {
            for x in 0..<width {
                let offset = (y * width + x) * 4
                if pixelChanged(beforeBitmap.pixels, afterBitmap.pixels, offset) {
                    changedCount += 1
                    minX = min(minX, x); maxX = max(maxX, x)
                    minY = min(minY, y); maxY = max(maxY, y)
                }
            }
        }

        guard changedCount > 0 else {
            return PixelDiffOutcome(changedPixelRatio: 0, bounds: nil)
        }
        let bounds = PixelRect(
            x: Double(minX),
            y: Double(minY),
            width: Double(maxX - minX + 1),
            height: Double(maxY - minY + 1)
        )
        return PixelDiffOutcome(
            changedPixelRatio: Double(changedCount) / Double(total),
            bounds: bounds
        )
    }

    // MARK: - Internals

    private static func pixelChanged(_ before: [UInt8], _ after: [UInt8], _ offset: Int) -> Bool {
        channelDiffers(before[offset], after[offset])
            || channelDiffers(before[offset + 1], after[offset + 1])
            || channelDiffers(before[offset + 2], after[offset + 2])
            || channelDiffers(before[offset + 3], after[offset + 3])
    }

    private static func channelDiffers(_ a: UInt8, _ b: UInt8) -> Bool {
        abs(Int(a) - Int(b)) > channelTolerance
    }

    private struct RGBA8Bitmap {
        let pixels: [UInt8]
        let width: Int
        let height: Int
    }

    /// Normalizes any CGImage to a tightly-packed premultiplied RGBA8 bitmap.
    private static func rgba8Bitmap(of image: CGImage) throws -> RGBA8Bitmap {
        let width = image.width
        let height = image.height
        guard width > 0, height > 0 else { throw PixelDiffError.bitmapUnavailable }

        let bytesPerRow = width * 4
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        )
        guard let context else { throw PixelDiffError.bitmapUnavailable }
        context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return RGBA8Bitmap(pixels: pixels, width: width, height: height)
    }
}
