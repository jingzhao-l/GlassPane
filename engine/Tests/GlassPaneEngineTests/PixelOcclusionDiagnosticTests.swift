import XCTest
import Foundation
import ScreenCaptureKit
@testable import GlassPaneEngine

/// R6-11 的归因装置，独立成类：它不依赖辅助功能席位、也不要求屏幕上恰好有别人的
/// 前台应用，只需要屏幕录制 + 一个窗口服务器会话——挂在别的光诊断类上就会被那些
/// 与它无关的前置条件跳过，而这条实验一旦跳过就等于没跑。
final class PixelOcclusionDiagnosticTests: XCTestCase {

    override func setUpWithError() throws {
        try super.setUpWithError()
        guard ProcessInfo.processInfo.environment["GLASSPANE_SCK_DIAG"] == "1" else {
            throw XCTSkip("opt-in real-device occlusion experiment; set GLASSPANE_SCK_DIAG=1")
        }
        guard CGPreflightScreenCaptureAccess() else {
            throw XCTSkip("screen recording permission not granted in this context")
        }
    }

    /// R6-11 归因实验：一个**被完全遮住**的窗口改了颜色，像素通路看得见吗？
    ///
    /// 起因是 `.p6_smoke.py` 连着两次红：5 枚证据档案的 `changedPixelRatio` 恒为 0，
    /// 而同一时间 `handlerProbe.hitCount=1`、`stateDiff.changed=true`、`axChanged=true`
    /// 都在说"界面确实变了"，`pingMs` 只有 0.2–0.5 ms（不是主线程饿死、也不是采集哑火）。
    /// 今天低负载时这条闸是绿的，所以怀疑的是**窗口层叠**：另一会话把窗口压在上面时，
    /// 采集拿到的到底是这块窗口的面，还是盖在它上面那块屏幕区域。
    ///
    /// 这里一次测三件事，两个读数就够定性：
    ///   * **对照**（没有遮挡）：改色后 ratio 必须显著大于 0，否则这个实验装置自己就是坏的；
    ///   * **遮挡 + 中心像素颜色**：蓝 ⇒ 拿到的正是被遮的那块窗口面（产品行为正确，
    ///     p6 的红要另找原因）；绿 ⇒ 拿到的是盖在上面的窗口（像素证据会在窗口被遮时
    ///     把"变了"说成"没变"，那是发布面的谎，必须修）；红 ⇒ 拿到的是过期帧。
    /// 前置条件也是测出来的：先用 CGWindowList 证明遮挡窗口确实在目标之上、且完全覆盖目标中心。
    func testPixelDiffOfAWindowHiddenBehindAnotherWindow() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["GLASSPANE_SCK_DIAG"] == "1",
            "opt-in real-device occlusion experiment"
        )
        try XCTSkipUnless(CGPreflightScreenCaptureAccess(), "no screen recording seat in this context")

        let app = NSApplication.shared
        let previousPolicy = app.activationPolicy()
        app.setActivationPolicy(.accessory)
        defer { app.setActivationPolicy(previousPolicy) }

        let frame = NSRect(x: 120, y: 120, width: 320, height: 200)
        let target = NSWindow(contentRect: frame, styleMask: [.borderless],
                              backing: .buffered, defer: false)
        target.isOpaque = true
        target.hasShadow = false
        target.level = .normal
        target.backgroundColor = NSColor(srgbRed: 1, green: 0, blue: 0, alpha: 1)

        let cover = NSWindow(contentRect: NSRect(x: frame.minX - 40, y: frame.minY - 40,
                                                 width: frame.width + 80, height: frame.height + 80),
                             styleMask: [.borderless], backing: .buffered, defer: false)
        cover.isOpaque = true
        cover.hasShadow = false
        cover.level = .floating
        cover.backgroundColor = NSColor(srgbRed: 0, green: 1, blue: 0, alpha: 1)

        defer {
            cover.orderOut(nil)
            target.orderOut(nil)
        }
        target.orderFrontRegardless()
        target.display()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))

        // ---- control: no occluder yet — a colour change must be a big ratio ----
        let pid = getpid()
        let unoccludedBefore = try SCKCapturer.captureWindow(ownerPid: pid, windowId: target.windowNumber)
        target.backgroundColor = NSColor(srgbRed: 0, green: 0, blue: 1, alpha: 1)
        target.display()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        let unoccludedAfter = try SCKCapturer.captureWindow(ownerPid: pid, windowId: target.windowNumber)
        let controlRatio = try PixelDiffer.diff(before: unoccludedBefore.image,
                                                after: unoccludedAfter.image).changedPixelRatio
        print("DIAG OCCLUSION CONTROL window=\(target.windowNumber) ratio=\(controlRatio)")
        XCTAssertGreaterThan(controlRatio, 0.5,
                             "实验装置自己是坏的：没有遮挡时改色也量不出变化，那后面的读数什么都不能说明")

        // ---- the actual case: cover it, prove the cover is really on top ----
        target.backgroundColor = NSColor(srgbRed: 1, green: 0, blue: 0, alpha: 1)
        target.display()
        cover.orderFrontRegardless()
        cover.display()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        let centre = CGPoint(x: frame.midX, y: frame.midY)
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                              kCGNullWindowID) as? [[String: Any]]) ?? []
        let ids = list.reduce(into: [Int: (layer: Int, owner: Int)]()) { acc, one in
            guard let number = one[kCGWindowNumber as String] as? Int,
                  let layer = one[kCGWindowLayer as String] as? Int,
                  let owner = one[kCGWindowOwnerPID as String] as? Int else { return }
            acc[number] = (layer, owner)
        }
        guard let targetInfo = ids[target.windowNumber], let coverInfo = ids[cover.windowNumber] else {
            return XCTFail("两个窗口并没有都在屏：target=\(String(describing: ids[target.windowNumber])) "
                + "cover=\(String(describing: ids[cover.windowNumber])) — 前置条件不成立，读数无意义")
        }
        XCTAssertGreaterThan(coverInfo.layer, targetInfo.layer,
                             "遮挡窗口不在目标之上，实验没有测到任何东西")
        print("DIAG OCCLUSION SETUP targetLayer=\(targetInfo.layer) coverLayer=\(coverInfo.layer) centre=\(centre)")

        let hiddenBefore = try SCKCapturer.captureWindow(ownerPid: pid, windowId: target.windowNumber)
        target.backgroundColor = NSColor(srgbRed: 0, green: 0, blue: 1, alpha: 1)
        target.display()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        let hiddenAfter = try SCKCapturer.captureWindow(ownerPid: pid, windowId: target.windowNumber)
        let hiddenRatio = try PixelDiffer.diff(before: hiddenBefore.image,
                                               after: hiddenAfter.image).changedPixelRatio
        let centrePixel = try Self.centrePixel(of: try PngEncoding.encode(hiddenAfter.image, scale: 1))
        print("DIAG OCCLUSION RESULT hiddenRatio=\(hiddenRatio) centrePixel=\(centrePixel)")

        // 三个读数是三种不同的缺陷，这里一次分开：
        //   蓝(b 高) ⇒ 截到的是被遮窗口自己的面：产品没错，p6 的红要往别处查；
        //   绿(g 高) ⇒ 截到的是盖在上面的那块屏幕区域 ⇒ 窗口被遮时像素证据会把"变了"说成"没变"；
        //   红(r 高) ⇒ 两帧都是过期画面 ⇒ 采集返回了缓存。
        if centrePixel.green > 0.5 {
            return XCTFail("拿到的是遮挡窗口的内容（屏幕区域）而不是目标窗口的面："
                + "窗口被遮时 changedPixelRatio 会把真实界面变化说成没变，这正是发布面不能有的谎。centre=\(centrePixel)")
        }
        if centrePixel.red > 0.5 && hiddenRatio == 0 {
            return XCTFail("两帧都是同一张过期画面（中心仍是改色前的红）：采集返回了缓存帧。"
                + "hiddenRatio=\(hiddenRatio) centre=\(centrePixel)")
        }
        XCTAssertGreaterThan(hiddenRatio, 0.5,
                             "遮挡条件下没测到变化，但中心像素既不是绿也不是红：读数落进未预期的一档 \(centrePixel)")
    }


    /// 读回 PNG 的中心像素（RGBA8 自己数，不猜通道顺序）。
    private static func centrePixel(of png: PngEncoding.Result) throws -> (red: Double, green: Double, blue: Double) {
        let bytes = try XCTUnwrap(Data(base64Encoded: png.base64))
        let source = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(
            CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                      bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        )
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let base = context.data else { return (-1, -1, -1) }
        let pointer = base.assumingMemoryBound(to: UInt8.self)
        let offset = (image.height / 2) * context.bytesPerRow + (image.width / 2) * 4
        return (Double(pointer[offset]) / 255, Double(pointer[offset + 1]) / 255, Double(pointer[offset + 2]) / 255)
    }
}
