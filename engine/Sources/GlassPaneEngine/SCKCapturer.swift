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

    /// Wall-clock budget for ONE stage of one capture, not for the capture as a
    /// whole (A-13 — the comment used to claim "total", which no code enforced).
    /// Same shape as the defensive per-call discipline P1 introduced for AX tree
    /// reads: each stage ends a different async call and nothing can be cancelled
    /// mid-stage, so each gets its own fresh budget — the
    /// `SCShareableContent` query, the `SCScreenshotManager` call or the
    /// `SCStream` start, and on the macOS 13 path the first-frame wait as well.
    /// The constant keeps its name because P1 spec §2 cites `captureTimeoutSeconds`
    /// as this 5 s figure; only the budget's stated scope was wrong.
    ///
    /// Worst case is therefore 10 s on the macOS 14 path (query + capture) and
    /// 15 s on the macOS 13 path (query + stream start + first frame). A capture
    /// that burns the full budget on a wedged window server can on its own
    /// exceed `EngineCore.performanceLatencyBudgetMs` (10 s) and trip the act's
    /// performance circuit breaker — that is the honest reading of what the
    /// channel did, and shortening the per-stage budget to hide it would turn a
    /// slow-but-real capture into `pixelCaptureDenied` on healthy machines.
    private static let captureTimeoutSeconds: TimeInterval = 5.0

    /// 一次采集的三个事实：图像、**真正被截的那个窗口**的 id 与 frame。
    ///
    /// 为什么身份要由采集方给出：`selectWindowIndex` 在精确 id 不命中时按既有语义
    /// 回退到"该 pid 最大的在屏窗口"（windowID 会被系统回收复用，回退是必要的）。
    /// 如果调用方继续拿自己**请求**的 id 去标注这张图，就会出现"报告 12 号窗口、
    /// 像素其实是 13 号"——前后两次各截一个窗口时，跨窗口的像素差还会被当成一次
    /// 测量。身份由这里给，调用方比的就是实际截到的那两个窗口。
    public struct Capture {
        public let image: CGImage
        public let windowId: Int
        public let frame: CGRect
    }

    /// Captures the frontmost on-screen window owned by `pid`, cropped to
    /// its frame. When `windowId` is provided (AX channel resolves it from
    /// `CGWindowList`), the same-pid window is matched exactly; otherwise the
    /// largest on-screen window of `pid` is used.
    public static func captureWindow(ownerPid pid_t: pid_t, windowId: Int?) throws -> Capture {
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
    /// 未命中则回退 pid 属主 + 最大面积屏幕内窗口。两条分支共用同一属主判据
    /// （见 `selectWindowIndex`），显示器判据见 `selectDisplayIndex`。
    @available(macOS 13.0, *)
    private static func resolveCaptureContext(ownerPid pid_t: pid_t, windowId: Int?) throws -> (window: SCWindow, display: SCDisplay) {
        // 三种结局（超时 / 查询抛错 / 没有结果）在 tryWaitShareableContent 里已经
        // 各自成文为 pixelCaptureDenied，这里不再二次包装错误文本。
        let content = try tryWaitShareableContent(macOS13: {
            try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        })

        // 判定抽成纯函数（两条 OS 分支共用、可脱离真机采集测试）。投影保持
        // content 的原顺序，所以返回的下标直接回指 SCWindow / SCDisplay。
        let windows = content.windows.map { window in
            WindowCandidate(
                windowId: Int(window.windowID),
                ownerPid: window.owningApplication?.processID,
                isOnScreen: window.isOnScreen,
                frame: window.frame
            )
        }
        let displays = content.displays.map { display in DisplayCandidate(frame: display.frame) }

        let windowIndex: Int
        let displayIndex: Int
        do {
            windowIndex = try selectWindowIndex(candidates: windows, exactWindowId: windowId, ownerPid: pid_t)
            let chosen = windows[windowIndex]
            displayIndex = try selectDisplayIndex(
                displays: displays,
                windowFrame: chosen.frame,
                windowId: chosen.windowId,
                ownerPid: pid_t
            )
        } catch let failure as ContextError {
            throw channelError(for: failure)
        }
        return (content.windows[windowIndex], content.displays[displayIndex])
    }

    // MARK: - Capture-context selection (pure, both OS branches)

    /// `SCWindow` 的可测投影：只带选择判据用到的四个事实。
    struct WindowCandidate: Equatable {
        let windowId: Int
        let ownerPid: pid_t?
        let isOnScreen: Bool
        let frame: CGRect
    }

    /// `SCDisplay` 的可测投影。
    struct DisplayCandidate: Equatable {
        let frame: CGRect
    }

    /// 采集上下文判定的失败原因。每个 case 都是一次"未测量"，由
    /// `channelError(for:)` 原样转成 `pixelCaptureDenied`，绝不降级成替代窗口
    /// 或替代显示器。
    enum ContextError: Error, Equatable {
        /// 目标 pid 当前没有任何在屏窗口。
        case noOnScreenWindow(ownerPid: pid_t)
        /// 选中窗口的 frame 不与任何显示器相交，采集区域落在全部屏幕之外。
        /// 这里曾经回落 `displays.first` + 越界 sourceRect，采回一张合法但空白的
        /// 主屏图，让上层把"没测到"读成"像素没变"。
        case windowOutsideEveryDisplay(ownerPid: pid_t, windowId: Int, frame: CGRect, displayCount: Int)

        /// 面向证据/诊断的事实描述：谁、哪个窗口、哪个区域、查到了几块屏。
        var reason: String {
            switch self {
            case .noOnScreenWindow(let pid):
                return "no on-screen SCWindow owned by pid \(pid)"
            case .windowOutsideEveryDisplay(let pid, let windowId, let frame, let displayCount):
                let area = "\(frame.width)x\(frame.height)@(\(frame.minX),\(frame.minY))"
                return "no SCDisplay intersects pid \(pid)'s window \(windowId) frame \(area) among \(displayCount) enumerated display(s)"
            }
        }
    }

    /// 判定失败 → 通道错误：任何"未测量"都走 pixelCaptureDenied，与 P0 §8 的
    /// 降级口径一致（EngineCore 据此把 pixelDiff 记为缺失而不是零变化）。
    static func channelError(for failure: ContextError) -> ChannelError {
        .pixelCaptureDenied(reason: failure.reason)
    }

    /// 选窗口。**两条分支同一属主判据**：windowID 会被系统回收后复用给别的进程，
    /// 所以"ID 命中"本身不能证明画面属于目标 pid——精确匹配同样要求
    /// `owningApplication.processID == pid` 且在屏（回退分支一直是这么做的）。
    /// 精确匹配不成立时按既有语义回退到该 pid 最大的在屏窗口；无可选窗口即抛错。
    /// - Returns: `candidates` 中被选中窗口的下标。
    static func selectWindowIndex(
        candidates: [WindowCandidate],
        exactWindowId: Int?,
        ownerPid pid_t: pid_t
    ) throws -> Int {
        if let exactWindowId,
           let exact = candidates.firstIndex(where: {
               $0.windowId == exactWindowId && $0.ownerPid == pid_t && $0.isOnScreen
           }) {
            return exact
        }
        // 面积最大者胜出；同面积保留先出现者（与 `max(by:)` 的既有语义一致）。
        var bestIndex: Int?
        var bestArea: CGFloat = -1
        for (index, candidate) in candidates.enumerated() {
            guard candidate.ownerPid == pid_t, candidate.isOnScreen else { continue }
            let area = candidate.frame.width * candidate.frame.height
            guard area > bestArea else { continue }
            bestArea = area
            bestIndex = index
        }
        guard let bestIndex else { throw ContextError.noOnScreenWindow(ownerPid: pid_t) }
        return bestIndex
    }

    /// 选显示器：只接受与窗口 frame 相交的那一块。不相交（或一块都没枚举到）就是
    /// 一次显式的未测量，绝不拿 `displays.first` 当替身。
    /// - Returns: `displays` 中被选中显示器的下标。
    static func selectDisplayIndex(
        displays: [DisplayCandidate],
        windowFrame: CGRect,
        windowId: Int,
        ownerPid pid_t: pid_t
    ) throws -> Int {
        // A zero-area (or null) window is not "inside" a display: CGRect.intersects
        // answers true for a 0×0 rect sitting in a display's bounds, which used to
        // produce a legal-but-blank 1×1 capture and then a "pixels did not change"
        // conclusion. Same not-measured outcome as an off-display window.
        guard windowFrame.width > 0, windowFrame.height > 0 else {
            throw ContextError.windowOutsideEveryDisplay(
                ownerPid: pid_t,
                windowId: windowId,
                frame: windowFrame,
                displayCount: displays.count
            )
        }
        guard let index = displays.firstIndex(where: { $0.frame.intersects(windowFrame) }) else {
            throw ContextError.windowOutsideEveryDisplay(
                ownerPid: pid_t,
                windowId: windowId,
                frame: windowFrame,
                displayCount: displays.count
            )
        }
        return index
    }

    /// Bridges a macOS-13+ async expression to this synchronous frame,
    /// reusing the same timeout discipline as the image capture. The three
    /// outcomes (timeout / thrown / no value) stay three distinct facts: a
    /// timeout is never reported as "query returned no content", and a timed-out
    /// result is never read out of the box while the cancelled task may still be
    /// writing it.
    @available(macOS 13.0, *)
    private static func tryWaitShareableContent(
        macOS13 body: @escaping () async throws -> SCShareableContent
    ) throws -> SCShareableContent {
        switch resolveWait(
            waitForAsync(timeout: captureTimeoutSeconds, body: body),
            subject: "SCShareableContent query",
            timeoutSeconds: captureTimeoutSeconds
        ) {
        case .value(let content):
            return content
        case .failure(let error):
            throw error
        }
    }

    // MARK: - async → sync bridge (shared by all three capture waits)

    /// 一次性 async 取值拉到同步帧后的三种结局。超时是独立结局：被取消但仍在跑
    /// 的任务之后还会往盒里写，所以它的任何值都不采信。
    enum WaitOutcome<Value> {
        case timedOut
        case finished(value: Value?, error: Error?)
    }

    /// 桥结局归一成的两种事实：取到值，或一条 pixelCaptureDenied。
    /// Mirror the P0 vocabulary: any capture failure downgrades to
    /// pixelCaptureDenied so evidence handles it uniformly.
    enum WaitResolution<Value> {
        case value(Value)
        case failure(ChannelError)
    }

    static func waitForAsync<Value>(
        timeout: TimeInterval,
        body: @escaping () async throws -> Value
    ) -> WaitOutcome<Value> {
        let semaphore = DispatchSemaphore(value: 0)
        let box = AsyncBox<Value>()
        let task = Task {
            do {
                let result = try await body()
                box.setValue(result)
            } catch {
                box.setThrown(error)
            }
            semaphore.signal()
        }
        let waited = semaphore.wait(timeout: .now() + timeout)
        task.cancel()
        if waited == .timedOut {
            return .timedOut
        }
        let snapshot = box.snapshot()
        return .finished(value: snapshot.value, error: snapshot.thrown)
    }

    /// 三种结局逐条成文，互不折叠（超时不是"查无内容"，抛错不是"取到空值"）。
    static func resolveWait<Value>(
        _ outcome: WaitOutcome<Value>,
        subject: String,
        timeoutSeconds: TimeInterval
    ) -> WaitResolution<Value> {
        switch outcome {
        case .timedOut:
            return .failure(.pixelCaptureDenied(
                reason: "\(subject) timed out after \(timeoutSeconds)s (not measured; the cancelled task may still be running)"
            ))
        case .finished(let value, let error):
            if let error {
                return .failure(.pixelCaptureDenied(reason: "\(subject) failed: \(error.localizedDescription)"))
            }
            guard let value else {
                return .failure(.pixelCaptureDenied(reason: "\(subject) returned no result"))
            }
            return .value(value)
        }
    }

    // MARK: - Path A (macOS 14+, SCScreenshotManager)

    @available(macOS 14.0, *)
    private static func captureViaScreenshotManager(ownerPid pid_t: pid_t, windowId: Int?) throws -> Capture {
        let context = try resolveCaptureContext(ownerPid: pid_t, windowId: windowId)
        // Whole-display filter + sourceRect 采样窗口区域，确定性最好；
        // 输出像素 = 窗口逻辑尺寸 × SCContentFilter 倍率（Retina 不降采样）。
        let filter = SCContentFilter(display: context.display, excludingWindows: [])
        return Capture(
            image: try snapViaScreenshotManager(contentFilter: filter, windowFrame: context.window.frame),
            windowId: Int(context.window.windowID),
            frame: context.window.frame
        )
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
        switch resolveWait(
            waitForAsync(timeout: captureTimeoutSeconds) {
                try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            },
            subject: "SCScreenshotManager capture",
            timeoutSeconds: captureTimeoutSeconds
        ) {
        case .value(let image):
            return image
        case .failure(let error):
            throw error
        }
    }

    // MARK: - Path B (macOS 13, SCStream first-frame bridge)

    @available(macOS 13.0, *)
    private static func captureViaStream(ownerPid pid_t: pid_t, windowId: Int?) throws -> Capture {
        let context = try resolveCaptureContext(ownerPid: pid_t, windowId: windowId)
        let filter = SCContentFilter(display: context.display, excludingWindows: [])
        return Capture(
            image: try snapViaStream(contentFilter: filter, windowFrame: context.window.frame),
            windowId: Int(context.window.windowID),
            frame: context.window.frame
        )
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
        // 资源释放从 stream 存在的那一刻起登记：start 抛错或超时时采集会话已经建好，
        // 登记在 awaitStreamStart 之后就等于 macOS 13 路径每次失败泄漏一个 SCStream。
        defer { stream.stopCapture(completionHandler: { _ in }) }
        try awaitStreamStart(of: stream)
        guard let image = bridge.waitForFirstFrame() else {
            throw ChannelError.pixelCaptureDenied(
                reason: "SCStream first frame timed out after \(captureTimeoutSeconds)s or stream stopped"
            )
        }
        return image
    }

    /// 启动是异步回调；bridge 到同步帧并带上超时。startCapture 的 async 重载只在
    /// `waitForAsync` 的 Task 内调用，避免 SDK 里 completion 版与 async 版的解析歧义。
    /// 失败即抛已成文的 `pixelCaptureDenied`：ChannelError 不是 LocalizedError，
    /// 调用方再包一层 `localizedDescription` 只会把上面的事实抹掉。
    @available(macOS 13.0, *)
    private static func awaitStreamStart(of stream: SCStream) throws {
        switch resolveWait(
            waitForAsync(timeout: captureTimeoutSeconds) { try await stream.startCapture() },
            subject: "SCStream start",
            timeoutSeconds: captureTimeoutSeconds
        ) {
        case .value:
            return
        case .failure(let error):
            throw error
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
    /// back to this synchronous frame. 交接的一对值由 NSLock 保护（与
    /// `StreamFrameBridge` 同口径）：超时后 `waitForAsync` 只 cancel 不等待，
    /// 仍在跑的任务会与同步侧读者并发读写同一个盒。
    final class AsyncBox<Value> {
        private let lock = NSLock()
        private var storedValue: Value?
        private var storedError: Error?

        func setValue(_ value: Value) {
            lock.lock()
            defer { lock.unlock() }
            storedValue = value
        }

        func setThrown(_ error: Error) {
            lock.lock()
            defer { lock.unlock() }
            storedError = error
        }

        /// 同一把锁下取出的一对值。
        func snapshot() -> (value: Value?, thrown: Error?) {
            lock.lock()
            defer { lock.unlock() }
            return (storedValue, storedError)
        }
    }
}

// MARK: - ChannelError convenience (kept here so the capturer owns its errors)

extension SCKCapturer {
    /// Helper to keep the ax-channel error vocabulary single-sourced.
    static func denied(_ message: String) -> Error {
        ChannelError.pixelCaptureDenied(reason: message)
    }
}