import Foundation
import CoreGraphics
import ScreenCaptureKit
import AppKit

/// ScreenCaptureKit pixel capture for Z5's pixel-diff signal.
///
/// Replaces the deprecated `CGWindowListCreateImage` path (P0, macOS 14 起
/// 弃用) per P1 spec §2/§225. Two in-band branches:
///  - macOS 14+: `SCScreenshotManager.captureImage` — one-shot, synchronous.
///  - macOS 13  : `SCStream` single-frame bridge via a semaphore (async→sync).
///
/// The channel contract stays `captureWindow() throws -> WindowCapture`; the
/// caller (AXChannel) is unchanged. Any permission or capture failure is
/// surfaced as `ChannelError.pixelCaptureDenied` so evidence downgrades
/// exactly as P0 §8 specifies.
///
/// SDK reality note (P1 spec §2 已同步): this SDK does NOT expose a
/// `SCContentFilter(window:)` initializer. The deterministic window capture
/// is built from `SCContentFilter(display:excludingWindows:)` plus
/// `SCStreamConfiguration.sourceRect` (points, display-logical coordinates)
/// and output size = window points × pixel scale. This also avoids the
/// `desktopIndependentWindow:` init, which can raise for windows that are not
/// desktop-independent.
///
/// Pixel scale source differs per branch: macOS 14+ reads
/// `SCContentFilter.pointPixelScale`; macOS 13 lacks that property, so path B
/// falls back to the containing `NSScreen.backingScaleFactor` (AppKit logical
/// frame coordinates match SCK's display-logical space).
public enum SCKCapturer {

    /// Total wall-clock budget for one capture, mirroring the defensive
    /// timeout discipline introduced for AX tree reads in P1.
    /// Enforced across the content query, the screenshot manager call and the
    /// SCStream first-frame wait.
    private static let captureTimeoutSeconds: TimeInterval = 5.0

    /// Captures the frontmost on-screen window owned by `pid`, cropped to
    /// its frame. When `windowId` is provided (AX channel resolves it from
    /// `CGWindowList`), the same-pid window is matched exactly; otherwise the
    /// largest on-screen window of `pid` is used.
    public static func captureWindow(ownerPid pid_t: pid_t, windowId: Int?) throws -> CGImage {
        guard CGPreflightScreenCaptureAccess() else {
            throw ChannelError.pixelCaptureDenied(
                reason: "screen recording permission not granted (P1 onboarding: glasspaned --guide-screen-permission)"
            )
        }

        if #available(macOS 14.0, *) {
            return try captureViaScreenshotManager(ownerPid: pid_t, windowId: windowId)
        } else {
            return try captureViaStream(ownerPid: pid_t, windowId: windowId)
        }
    }

    // MARK: - Shared context resolution (macOS 13+, both branches)

    /// 解析目标窗口及其所在显示器。优先按 AX 传入的 windowId 精确匹配，
    /// 未命中则回退 pid 属主 + 最大面积屏幕内窗口。
    @available(macOS 13.0, *)
    private static func resolveCaptureContext(ownerPid pid_t: pid_t, windowId: Int?) throws -> (window: SCWindow, display: SCDisplay) {
        let content: SCShareableContent
        do {
            guard let resolved = try tryWaitShareableContent(macOS13: {
                try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            }) else {
                throw ChannelError.pixelCaptureDenied(
                    reason: "SCShareableContent query returned no content"
                )
            }
            content = resolved
        } catch let failure as ChannelError {
            throw failure
        } catch {
            throw ChannelError.pixelCaptureDenied(
                reason: "SCShareableContent query failed: \(error.localizedDescription)"
            )
        }

        let window: SCWindow
        if let windowId,
           let exact = content.windows.first(where: { Int($0.windowID) == windowId }) {
            window = exact
        } else {
            guard let largest = content.windows
                .filter({ $0.owningApplication?.processID == pid_t && $0.isOnScreen })
                .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
                throw ChannelError.pixelCaptureDenied(
                    reason: "no on-screen SCWindow owned by pid \(pid_t)"
                )
            }
            window = largest
        }

        guard let display = content.displays.first(where: { $0.frame.intersects(window.frame) })
                ?? content.displays.first else {
            throw ChannelError.pixelCaptureDenied(
                reason: "no SCDisplay contains pid \(pid_t)'s window"
            )
        }
        return (window, display)
    }

    /// Bridges a macOS-13+ async expression to this synchronous frame,
    /// reusing the same timeout discipline as the image capture.
    @available(macOS 13.0, *)
    private static func tryWaitShareableContent(
        macOS13 body: @escaping () async throws -> SCShareableContent
    ) throws -> SCShareableContent? {
        let semaphore = DispatchSemaphore(value: 0)
        let box = AsyncBox<SCShareableContent>()
        let task = Task {
            do {
                box.value = try await body()
            } catch {
                box.thrown = error
            }
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + captureTimeoutSeconds)
        task.cancel()
        if let thrown = box.thrown {
            throw thrown
        }
        return box.value
    }

    // MARK: - Path A (macOS 14+, SCScreenshotManager)

    @available(macOS 14.0, *)
    private static func captureViaScreenshotManager(ownerPid pid_t: pid_t, windowId: Int?) throws -> CGImage {
        let context = try resolveCaptureContext(ownerPid: pid_t, windowId: windowId)
        // Whole-display filter + sourceRect 采样窗口区域，确定性最好；
        // 输出像素 = 窗口逻辑尺寸 × SCContentFilter 倍率（Retina 不降采样）。
        let filter = SCContentFilter(display: context.display, excludingWindows: [])
        return try snapViaScreenshotManager(contentFilter: filter, windowFrame: context.window.frame)
    }

    @available(macOS 14.0, *)
    private static func snapViaScreenshotManager(contentFilter filter: SCContentFilter, windowFrame: CGRect) throws -> CGImage {
        let config = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        config.sourceRect = windowFrame
        config.width = max(1, Int(ceil(windowFrame.width * scale)))
        config.height = max(1, Int(ceil(windowFrame.height * scale)))
        config.showsCursor = false
        config.capturesAudio = false
        return try awaitGuardedNextImage(contentFilter: filter, config: config)
    }

    @available(macOS 14.0, *)
    private static func awaitGuardedNextImage(contentFilter filter: SCContentFilter, config: SCStreamConfiguration) throws -> CGImage {
        let semaphore = DispatchSemaphore(value: 0)
        let box = AsyncBox<CGImage>()
        let task = Task {
            do {
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                box.value = image
                semaphore.signal()
            } catch {
                box.thrown = error
                semaphore.signal()
            }
        }
        let timedOut = semaphore.wait(timeout: .now() + captureTimeoutSeconds)
        task.cancel()
        if timedOut == .timedOut {
            throw ChannelError.pixelCaptureDenied(
                reason: "SCScreenshotManager timed out after \(captureTimeoutSeconds)s"
            )
        }
        if let thrown = box.thrown {
            // Mirror the P0 vocabulary: any capture failure downgrades to
            // pixelCaptureDenied so evidence handles it uniformly.
            throw ChannelError.pixelCaptureDenied(
                reason: "screen capture failed: \(thrown.localizedDescription)"
            )
        }
        guard let image = box.value else {
            throw ChannelError.pixelCaptureDenied(reason: "screen capture returned no image")
        }
        return image
    }

    // MARK: - Path B (macOS 13, SCStream first-frame bridge)

    @available(macOS 13.0, *)
    private static func captureViaStream(ownerPid pid_t: pid_t, windowId: Int?) throws -> CGImage {
        let context = try resolveCaptureContext(ownerPid: pid_t, windowId: windowId)
        let filter = SCContentFilter(display: context.display, excludingWindows: [])
        return try snapViaStream(contentFilter: filter, windowFrame: context.window.frame)
    }

    @available(macOS 13.0, *)
    private static func snapViaStream(contentFilter filter: SCContentFilter, windowFrame: CGRect) throws -> CGImage {
        let config = SCStreamConfiguration()
        let scale = streamPixelScale(for: windowFrame)
        config.sourceRect = windowFrame
        config.width = max(1, Int(ceil(windowFrame.width * scale)))
        config.height = max(1, Int(ceil(windowFrame.height * scale)))
        config.showsCursor = false
        config.capturesAudio = false

        let bridge = StreamFrameBridge(timeout: .now() + captureTimeoutSeconds)
        let stream = SCStream(filter: filter, configuration: config, delegate: bridge)
        do {
            // 启动是异步回调；bridge 到同步帧并带上超时。startCapture 的 async
            // 重载仅在 Task 内调用，避免 SDK 里 completion 版与 async 版的解析歧义。
            try awaitStreamStart(of: stream)
        } catch {
            throw ChannelError.pixelCaptureDenied(
                reason: "SCStream start failed: \(error.localizedDescription)"
            )
        }
        // 首帧到手或超时后无条件停流，资源必须释放。
        defer { stream.stopCapture(completionHandler: { _ in }) }
        guard let image = bridge.waitForFirstFrame() else {
            throw ChannelError.pixelCaptureDenied(
                reason: "SCStream first frame timed out after \(captureTimeoutSeconds)s or stream stopped"
            )
        }
        return image
    }

    @available(macOS 13.0, *)
    private static func awaitStreamStart(of stream: SCStream) throws {
        let semaphore = DispatchSemaphore(value: 0)
        let box = AsyncBox<Bool>()
        let task = Task {
            do {
                try await stream.startCapture()
                box.value = true
            } catch {
                box.thrown = error
            }
            semaphore.signal()
        }
        let timedOut = semaphore.wait(timeout: .now() + captureTimeoutSeconds)
        task.cancel()
        if timedOut == .timedOut {
            throw ChannelError.pixelCaptureDenied(
                reason: "SCStream start timed out after \(captureTimeoutSeconds)s"
            )
        }
        if let thrown = box.thrown {
            throw thrown
        }
    }

    /// macOS 13 无 `pointPixelScale`，取包含窗口的屏幕倍率（AppKit 与 SCK
    /// 的逻辑坐标系一致）；找不到时保守用 2x。
    @available(macOS 13.0, *)
    private static func streamPixelScale(for windowFrame: CGRect) -> CGFloat {
        NSScreen.screens.first(where: { $0.frame.intersects(windowFrame) })?.backingScaleFactor ?? 2.0
    }

    /// 单帧捕获桥：首帧 `CVPixelBuffer` 到达即唤醒等待方；`didStopWithError`
    /// 同样唤醒以避免永久阻塞。线程安全由 NSLock 保证。
    @available(macOS 13.0, *)
    private final class StreamFrameBridge: NSObject, SCStreamOutput, SCStreamDelegate {
        private let signal: DispatchSemaphore
        private let lock = NSLock()
        private let timeout: DispatchTime
        private var frame: CVPixelBuffer?
        private var didStop = false

        init(timeout: DispatchTime) {
            self.timeout = timeout
            self.signal = DispatchSemaphore(value: 0)
            super.init()
        }

        func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
            lock.lock()
            defer { lock.unlock() }
            guard frame == nil, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            frame = buffer
            signal.signal()
        }

        func stream(_ stream: SCStream, didStopWithError error: Error) {
            lock.lock()
            didStop = true
            lock.unlock()
            signal.signal()
        }

        /// 阻塞等待首帧并转换为 CGImage；超时或提前停止返回 nil。
        func waitForFirstFrame() -> CGImage? {
            _ = signal.wait(timeout: timeout)
            lock.lock()
            defer { lock.unlock() }
            guard let buffer = frame else { return nil }
            return Self.image(from: buffer)
        }

        /// 把 BGRA(YCbCr 转出后的标准 4 通道)像素缓冲拷贝进位图上下文，生成
        /// 独立生命周期的 CGImage，避免持有流内部缓冲。
        private static func image(from buffer: CVPixelBuffer) -> CGImage? {
            let width = CVPixelBufferGetWidth(buffer)
            let height = CVPixelBufferGetHeight(buffer)
            guard width > 0, height > 0 else { return nil }
            CVPixelBufferLockBaseAddress(buffer, [])
            defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
            guard let baseAddress = CVPixelBufferGetBaseAddress(buffer) else { return nil }
            let sourceStride = CVPixelBufferGetBytesPerRow(buffer)
            let colorSpace = CGColorSpaceCreateDeviceRGB()
            // PremultipliedFirst + little-endian == BGRA，与 SCK 默认输出一致。
            let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
            guard let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: colorSpace,
                bitmapInfo: bitmapInfo
            ), let target = context.data else { return nil }
            let copyStride = min(sourceStride, width * 4)
            for row in 0..<height {
                memcpy(target.advanced(by: row * width * 4), baseAddress.advanced(by: row * sourceStride), copyStride)
            }
            return context.makeImage()
        }
    }

    /// Minimal thread-safe box for handoff from the actor-isolated Task
    /// back to this synchronous frame.
    private final class AsyncBox<Value> {
        var value: Value?
        var thrown: Error?
    }
}

// MARK: - ChannelError convenience (kept here so the capturer owns its errors)

extension SCKCapturer {
    /// Helper to keep the ax-channel error vocabulary single-sourced.
    static func denied(_ message: String) -> Error {
        ChannelError.pixelCaptureDenied(reason: message)
    }
}