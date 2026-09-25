import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// 把一次窗口捕获编码成 PNG 并转 base64，供 MCP 以 image content 交给**用户自己的**模型。
///
/// 刻意**不写磁盘**，也没有 `path` 之类的落盘参数：这套引擎此前对外的承诺是"证据包里
/// 只有测量数字，没有原始截图"，而一个由模型输出决定的文件写入口会把这条承诺变成漏洞。
/// 图像只穿过 socket 与 MCP 帧，然后停在调用方的上下文里；要留档由使用者自己从会话里存。
public enum PngEncoding {
    /// 编码后字节上限。真正的硬约束是 socket 帧上限 `FrameCodec.maxFrameBytes = 4 MB`，
    /// 而 base64 要把字节数放大 4/3 —— 所以这里必须给 JSON 信封留出余量，
    /// 不是"想传多大就多大"。超限一律**拒**并给出降采样出口，不悄悄丢分辨率也不悄悄丢帧。
    public static let defaultMaxBytes = 2_400_000

    public struct Result: Equatable {
        public let base64: String
        public let byteCount: Int
        public let pixelWidth: Int
        public let pixelHeight: Int
        /// **实际**应用的缩放倍率。与请求值可以不同：`downscaled` 拿不到上下文时
        /// 会原样返回原图，那时报告请求值就是撒谎——模型会以为自己在看缩略图，
        /// 而它看的其实是全尺寸（反过来也一样：以为看清了细节，其实被缩过）。
        public let appliedScale: Double
    }

    public enum EncodingError: Error, Equatable {
        /// 图像太大。带数字与可执行出口，因为"太大了"这种报错对调用方没有下一步。
        case tooLarge(byteCount: Int, limit: Int, suggestedScale: Double)
        case encoderUnavailable
    }

    /// 等比降采样。scale >= 1 时原样返回（不制造无谓的位图拷贝）。
    public static func downscaled(_ image: CGImage, scale: Double) -> CGImage {
        guard scale < 1 else { return image }
        let width = max(1, Int((Double(image.width) * scale).rounded()))
        let height = max(1, Int((Double(image.height) * scale).rounded()))
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: nil, width: width, height: height,
                  bitsPerComponent: 8, bytesPerRow: 0,
                  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            return image
        }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage() ?? image
    }

    /// 超限时给调用方的建议倍率：PNG 字节数近似随像素面积变化，所以按面积开方折算，
    /// 再打一个 0.9 的折扣（编码器的滤镜/元数据开销不是严格随面积走的），最后**向下**
    /// 取到一位小数——向上取整等于建议一个仍然放不下的倍率。
    /// 下界 0.1：更小的图对视觉模型没有意义，那条路应该是"分窗口/分区域再看"。
    public static func suggestedScale(byteCount: Int, limit: Int) -> Double {
        guard byteCount > 0, limit > 0 else { return 0.1 }
        let ratio = Double(limit) / Double(byteCount)
        let tenths = (ratio.squareRoot() * 0.9 * 10).rounded(.down)
        return min(1, max(0.1, tenths / 10))
    }

    public static func encode(
        _ image: CGImage,
        scale: Double = 1,
        maxBytes: Int = defaultMaxBytes
    ) throws -> Result {
        let target = downscaled(image, scale: scale)
        let sink = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            sink, UTType.png.identifier as CFString, 1, nil
        ) else {
            throw EncodingError.encoderUnavailable
        }
        CGImageDestinationAddImage(destination, target, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw EncodingError.encoderUnavailable
        }
        let count = sink.length
        guard count <= maxBytes else {
            throw EncodingError.tooLarge(
                byteCount: count, limit: maxBytes,
                suggestedScale: suggestedScale(byteCount: count, limit: maxBytes)
            )
        }
        // 实际倍率从"图真的变成了多大"倒推，而不是把请求值抄一遍。
        let applied = image.width > 0 ? Double(target.width) / Double(image.width) : scale
        return Result(
            base64: sink.base64EncodedString(options: []),
            byteCount: count,
            pixelWidth: target.width,
            pixelHeight: target.height,
            appliedScale: applied
        )
    }
}
