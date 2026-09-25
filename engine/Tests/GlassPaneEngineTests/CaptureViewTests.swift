import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import GlassPaneEngine

/// 视觉审查通道的编码与接线测试。
///
/// 全部用内存里合成的 CGImage，不依赖屏幕录制授权：这条通路的正确性（编码、尺寸
/// 上限、降采样、错误出口、引擎返回形状）本来就不需要真屏幕。
final class CaptureViewTests: XCTestCase {

    private func makeImage(width: Int, height: Int) throws -> CGImage {
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(
            CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                      bytesPerRow: 0, space: space,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        )
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try XCTUnwrap(context.makeImage())
    }

    /// 噪声图：PNG 对纯色几乎不花字节，那样"字节数随面积走"的前提不成立，
    /// 重试能否装下也就测不出真话。
    private func makeNoisyImage(width: Int, height: Int) throws -> CGImage {
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(
            CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                      bytesPerRow: 0, space: space,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        )
        guard let base = context.data else {
            return try makeImage(width: width, height: height)
        }
        let pointer = base.assumingMemoryBound(to: UInt8.self)
        for i in 0..<(context.bytesPerRow * height) { pointer[i] = UInt8.random(in: 0...255) }
        return try XCTUnwrap(context.makeImage())
    }

    // MARK: - PNG 编码层

    func testEncodeProducesDecodablePngWithinBudget() throws {
        let result = try PngEncoding.encode(try makeImage(width: 64, height: 64))
        let data = try XCTUnwrap(Data(base64Encoded: result.base64))
        XCTAssertGreaterThan(result.byteCount, 0)
        XCTAssertEqual(data.count, result.byteCount)
        // PNG 签名：任何号称是 PNG 的字节流都得先证明自己。
        XCTAssertEqual(Array(data.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        // 不只看签名：真解回一张图，并核对像素维度与自报一致。
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.png.identifier)
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(decoded.width, result.pixelWidth)
        XCTAssertEqual(decoded.height, result.pixelHeight)
        XCTAssertEqual(decoded.width, 64)
    }

    func testScaleReducesPixelSize() throws {
        let image = try makeImage(width: 200, height: 100)
        let half = try PngEncoding.encode(image, scale: 0.5)
        XCTAssertEqual(half.pixelWidth, 100)
        XCTAssertEqual(half.pixelHeight, 50)
        let same = try PngEncoding.encode(image, scale: 1)
        XCTAssertEqual(same.pixelWidth, 200)
    }

    func testOverBudgetRefusesAndNamesSuggestedScale() throws {
        let image = try makeImage(width: 400, height: 400)
        do {
            _ = try PngEncoding.encode(image, maxBytes: 200)
            XCTFail("超出帧预算必须拒，不能悄悄压分辨率")
        } catch let error as PngEncoding.EncodingError {
            guard case let .tooLarge(bytes, limit, suggested) = error else {
                return XCTFail("必须是 tooLarge，实际 \(error)")
            }
            XCTAssertGreaterThan(bytes, limit)
            XCTAssertLessThanOrEqual(suggested, 0.9)
            XCTAssertGreaterThan(suggested, 0)
        }
    }

    /// 建议倍率的算术：这条断言必须能红。旧写法 `.rounded(.down) * 10 / 10` 先把
    /// 0.45 取整成 0 再乘回来，于是任何 <1 的建议都塌成下界 0.1 —— 而"重试请缩到 10%"
    /// 和"缩到 40%"是两个完全不同的下一步。
    func testSuggestedScaleTruncatesToOneDecimalAndClamps() {
        // 需要 4 倍面积压缩 → sqrt(0.25)=0.5，打 0.9 折正好 0.45：向下取整到 0.4，
        // 四舍五入会给出 0.5，而 0.5 面积是 0.25 的 4 倍＝正好放回超界的原图。
        XCTAssertEqual(PngEncoding.suggestedScale(byteCount: 4000, limit: 1000), 0.4, accuracy: 0.0001)
        // 刚超一点：也不许建议 1.0（那等于让调用方原样重试一次）。
        XCTAssertEqual(PngEncoding.suggestedScale(byteCount: 1050, limit: 1000), 0.8, accuracy: 0.0001)
        XCTAssertEqual(PngEncoding.suggestedScale(byteCount: 3000, limit: 1000), 0.5, accuracy: 0.0001)
        // 远超预算时钳到下界，而不是给出 0（0 的语义是"发一张没有像素的图"）。
        XCTAssertEqual(PngEncoding.suggestedScale(byteCount: 100_000_000, limit: 1000), 0.1, accuracy: 0.0001)
        XCTAssertEqual(PngEncoding.suggestedScale(byteCount: 0, limit: 1000), 0.1, accuracy: 0.0001)
    }

    /// 因果验证：按它自己给的建议倍率重试，必须真的放得下。
    /// 只断言"建议值在 0...1 之间"是不能红的——随便一个数都能过。
    func testSuggestedScaleActuallyFitsOnRetry() throws {
        let image = try makeNoisyImage(width: 300, height: 300)
        let full = try PngEncoding.encode(image)
        let budget = max(1, full.byteCount / 3)
        do {
            _ = try PngEncoding.encode(image, maxBytes: budget)
            return XCTFail("1/3 预算放不下原图（\(full.byteCount) 字节），这条对照本身坏了")
        } catch let error as PngEncoding.EncodingError {
            guard case let .tooLarge(bytes, limit, suggested) = error else {
                return XCTFail("必须是 tooLarge，实际 \(error)")
            }
            XCTAssertEqual(bytes, full.byteCount, "报出去的字节数必须是实测算出来的那个")
            XCTAssertEqual(limit, budget)
            XCTAssertLessThan(suggested, 1, "建议 1.0 等于让调用方原样重试一次")
            XCTAssertNoThrow(
                try PngEncoding.encode(image, scale: suggested, maxBytes: budget),
                "按建议倍率重试仍然超限：这个出口是假的（suggested=\(suggested)）"
            )
        }
    }

    /// 上限与 socket 帧上限的关系必须成立：base64 放大 4/3 后仍要留得下 JSON 信封。
    func testDefaultBudgetFitsInsideFrameLimit() {
        let base64Growth = 4.0 / 3.0
        let worstCase = Double(PngEncoding.defaultMaxBytes) * base64Growth
        XCTAssertLessThan(worstCase, Double(FrameCodec.maxFrameBytes),
                          "PNG 预算必须容得下 base64 膨胀与 JSON 信封")
    }

    // MARK: - 引擎接线

    func testCaptureViewReturnsImagePayloadAndSaysItPersistedNothing() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = try makeImage(width: 48, height: 32)
        let core = EngineCore(channel: channel, evidenceStore: nil, approvalGate: nil)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)

        let payload = try core.captureView(scale: 1)
        XCTAssertEqual(payload["mimeType"] as? String, "image/png")
        XCTAssertEqual(payload["pixelWidth"] as? Int, 48)
        XCTAssertEqual(payload["persisted"] as? Bool, false,
                       "这条通道的对外主张就是引擎不落盘；改了主张必须改这条断言")
        let encodedLength = (payload["pngBase64"] as? String)?.count ?? 0
        XCTAssertGreaterThan(encodedLength, 0)
        XCTAssertNotNil((payload["pngBase64"] as? String)?.count)
        XCTAssertEqual(channel.captureCallCount, 1)
    }

    func testCaptureViewSurfacesCaptureDenialInsteadOfAnEmptyImage() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        // 没有编排任何捕获：真机上等价于"这个进程没有屏幕录制授权"。
        let core = EngineCore(channel: channel, evidenceStore: nil, approvalGate: nil)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        do {
            _ = try core.captureView(scale: 1)
            XCTFail("捕获被拒时必须抛错，不能回一张空白图像")
        } catch let error as GPError {
            XCTAssertTrue(error.code.rawValue.hasPrefix("GP_E_"))
            XCTAssertFalse(error.remedy.isEmpty, "错误必须带下一步")
            // 口径断言：`degradation` 参数只有一个调用方换过它，另一条通路换不了。
            XCTAssertFalse(error.remedy.contains("pixelDiff"),
                "视觉通道没有 pixelDiff 可降级；这句话出现在这里是 gp_verify 的口径，会误导重试：\(error.remedy)")
            XCTAssertTrue(error.remedy.contains("did not happen"),
                "必须给出视觉通道自己的诚实出口：\(error.remedy)")
        }
        // 对照组：同一次失败在 gp_verify 的映射里仍然要说 pixelDiff，
        // 否则上面那条"没说"只是因为两边都丢了这句话。
        let verifyShape = EngineCore.map(ChannelError.pixelCaptureDenied(reason: "permission not granted"))
        XCTAssertTrue(verifyShape.remedy.contains("pixelDiff"), verifyShape.remedy)
    }

    func testDispatcherRejectsScaleOutOfRange() throws {
        // scale 越界在参数校验层就拒：0.05 的图发给模型是"看起来看过、其实满屏马赛克"。
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = try makeImage(width: 16, height: 16)
        let core = EngineCore(channel: channel, evidenceStore: nil, approvalGate: nil)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        do {
            _ = try ParamValidation.optDouble(["scale": 0.02], "scale", range: 0.1...1.0)
            XCTFail("越界 scale 必须被拒")
        } catch let error as GPError {
            XCTAssertEqual(error.code, .badParams)
        }
        XCTAssertNoThrow(try ParamValidation.optDouble(["scale": 0.5], "scale", range: 0.1...1.0))
    }
}
