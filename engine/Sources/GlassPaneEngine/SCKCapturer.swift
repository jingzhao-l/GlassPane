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
/// SDK reality note (P1 spec §2 已同步): there is no `SCContentFilter(window:)`
/// initializer, but `SCContentFilter(desktopIndependentWindow:)` exists and is the
/// **only** filter that captures a window's own surface. Until R6-11 this file used
/// the display filter plus a `sourceRect` crop exclusively, which samples the screen
/// region — measured: with another window on top, the crop returned that window's
/// pixels, so a real UI change was published as `changedPixelRatio = 0`. The capture
/// now prefers the window-scoped filter, keeps the display crop purely as a fallback,
/// and refuses to measure at all when the fallback would be needed under an overlap.
///
/// Pixel scale source differs per branch: macOS 14+ reads
/// `SCContentFilter.pointPixelScale`; macOS 13 lacks that property, so path B falls back to
/// the backing scale of the **one** screen whose frame overlaps the window — and refuses
/// when that reading is ambiguous or absent, because `NSScreen.frame` is Cocoa's bottom-left
/// global space while `SCWindow.frame` is SCK/CG's top-left one (see `streamPixelScale`).
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

    // MARK: - R6-11: which surface is being captured, and what may be said about it

    /// One capture candidate: a filter, plus the crop that goes with it.
    ///
    /// `sourceRect == nil` means the filter is the **window's own surface** — the
    /// compositor keeps one, so that picture is the target even when another window
    /// covers it on screen. `sourceRect != nil` is the older shape: sample the
    /// display, crop to the window's frame. That crop contains whatever is *on top*.
    ///
    /// Measured 2026-09-25 (`PixelOcclusionDiagnosticTests`, real window server,
    /// opt-in): a 320x200 target with its background changed under a floating
    /// cover produced `changedPixelRatio = 0.0` and a centre pixel of the cover's
    /// green (r 0.01 / g 1.0 / b 0.0), while the same change with nothing on top
    /// produced `ratio = 1.0`. So a covered window's pixel evidence said "the
    /// interface did not change visually" about an interface that did — and the
    /// classifier, believing the channel, blamed the app's render layer (T6).
    /// That is the "absence dressed as a measurement" shape, one level worse than
    /// not measuring.
    private struct SurfaceCapture {
        let filter: SCContentFilter
        let sourceRect: CGRect?
        let label: String
    }

    /// What the capture may try, plus the fact needed to explain a refusal.
    ///
    /// `occludedBy` is not decoration: without it the only thing a failed capture
    /// can say is "no capture surface available", and the label layer then files it
    /// under "the app owns no on-screen window" — a fact this file already knows to
    /// be false, because it resolved the window before getting here. The advice that
    /// follows from a false label ("unminimise or reopen it") cannot work, so the
    /// refusal has to carry the true cause.
    private struct SurfacePlan {
        var candidates: [SurfaceCapture] = []
        var occludedBy: [Int] = []
        /// 邻居到底**没数出来**（`occludingWindows` 回了 nil）：不知道有没有东西
        /// 盖着，也就不能把"没有东西盖着"当成默认值去重新允许那张会撒谎的裁剪。
        var occlusionUncountable = false
        /// 裁剪矩形换算不出来的时候（窗口 frame 落不进所选显示器的本地坐标系）：
        /// 整屏那条候选直接不收，理由原样带进拒绝文案，不许悄悄少一条候选再让人
        /// 以为"两条都试过了"。
        var cropRefusal: String?
    }

    /// On-screen windows in front of `targetNumber` whose bounds intersect its frame,
    /// or `nil` when that set could not be counted — the window list itself was
    /// unreadable, a neighbour's bounds could not be placed, or the target never
    /// appeared in the list (then nothing is known about what sits above it).
    ///
    /// `CGWindowListCopyWindowInfo` is ordered front-to-back, so everything before
    /// the target's own number sits above it. Negative layers (wallpaper, dock
    /// backing, menu-bar shadows) are ignored: they do not cover an app window's
    /// content. An entry whose bounds cannot be parsed is skipped *and* makes the
    /// count unreliable: this decides whether to offer the display crop, and the
    /// `?? 0` it replaces answered "nothing covers it" from a window this file never
    /// placed — the lie R6-11 exists to refuse. Skipping it without naming it keeps
    /// an unmeasured neighbour out of `occludedBy`, so a refusal never accuses a
    /// window it did not measure.
    static func occludingWindows(inFrontOf targetNumber: Int, frame: CGRect) -> [Int]? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        return occludingWindows(in: list, inFrontOf: targetNumber, frame: frame)
    }

    /// The count over a list the caller hands in, so the cases this machine's
    /// window server cannot be asked to produce on demand — a neighbour with no
    /// layer entry, a neighbour below the desktop level, a neighbour whose bounds
    /// will not parse — are exercised as behaviour instead of as source text.
    static func occludingWindows(
        in list: [[String: Any]], inFrontOf targetNumber: Int, frame: CGRect
    ) -> [Int]? {
        var inFront: [Int] = []
        var foundTarget = false
        var countable = true
        for entry in list {
            // An entry this file cannot even identify is not evidence that
            // nothing covers the target: it is the same "could not tell" that an
            // unreadable bound already answers with.
            guard let number = entry[kCGWindowNumber as String] as? Int else {
                countable = false
                continue
            }
            if number == targetNumber {
                foundTarget = true
                break
            }
            guard number > 0 else {
                countable = false
                continue
            }
            // A layer present but negative (wallpaper, dock backing, menu-bar
            // shadow) genuinely sits behind the target, so it is skipped and the
            // count stays trustworthy. A layer that is *absent* says nothing, and
            // answering "not in front" from silence is the R6-11 lie in a new
            // costume.
            if let layer = entry[kCGWindowLayer as String] as? Int {
                if layer < 0 { continue }
            } else {
                countable = false
                continue
            }
            guard let raw = entry[kCGWindowBounds as String] as? [String: Any],
                  let x = raw["X"] as? CGFloat, let y = raw["Y"] as? CGFloat,
                  let width = raw["Width"] as? CGFloat, let height = raw["Height"] as? CGFloat else {
                countable = false
                continue
            }
            if CGRect(x: x, y: y, width: width, height: height).intersects(frame) { inFront.append(number) }
        }
        guard foundTarget, countable else { return nil }
        return inFront
    }

    /// The candidates, best first. The display crop is offered **only when nothing
    /// covers the target**: with something on top, the two candidates would disagree
    /// about the app's appearance and the fallback is the one that lies, so nothing
    /// is measured at all and the refusal names what is in the way. The same rule
    /// makes an *uncountable* neighbour set refuse the crop: "could not tell" is not
    /// "told: nothing".
    private static func surfacePlan(
        context: (window: SCWindow, display: SCDisplay)
    ) -> SurfacePlan {
        var plan = SurfacePlan(
            candidates: [SurfaceCapture(
                filter: SCContentFilter(desktopIndependentWindow: context.window),
                sourceRect: nil, label: "window-surface"
            )]
        )
        guard let covered = occludingWindows(inFrontOf: Int(context.window.windowID), frame: context.window.frame) else {
            // 窗口自己的面照旧可试（那不是裁剪，不会替别人说话）；这里只把整屏
            // 裁剪那条候选收回来，并把"数不出来"这件事写成拒绝的理由。
            plan.occlusionUncountable = true
            let note = "glasspaned: pixel capture of window " + String(context.window.windowID)
                + " could not count the windows in front of it (the CG window list held no such window, or a neighbour's bounds were unreadable), so no display-region crop is offered (R6-11)\n"
            FileHandle.standardError.write(Data(note.utf8))
            return plan
        }
        plan.occludedBy = covered
        if covered.isEmpty {
            // sourceRect 必须是**显示器本地**逻辑坐标（specs/GlassPane_P1_实施规格
            // _v1.0_SCK迁移.md:37），窗口 frame 是全局的：原判据 `context.window.frame`
            // 只在主屏原点恰为 (0,0) 时才碰巧相等。换算不了就一次都不许裁。
            guard let crop = cropRect(window: context.window.frame, display: context.display.frame) else {
                plan.cropRefusal = "window \(context.window.windowID) frame "
                    + "\(context.window.frame.width)x\(context.window.frame.height)"
                    + "@(\(context.window.frame.minX),\(context.window.frame.minY)) cannot be expressed inside display "
                    + "\(context.display.frame.width)x\(context.display.frame.height)"
                    + "@(\(context.display.frame.minX),\(context.display.frame.minY))'s local coordinates"
                let note = "glasspaned: pixel capture of window " + String(context.window.windowID)
                    + " lost its display-region fallback: " + plan.cropRefusal!
                    + "; that crop would be a different screen area than the window, so it is refused (R6-12)\n"
                FileHandle.standardError.write(Data(note.utf8))
                return plan
            }
            plan.candidates.append(SurfaceCapture(
                filter: SCContentFilter(display: context.display, excludingWindows: []),
                sourceRect: crop, label: "display-region"
            ))
        } else {
            let names = covered.map { String($0) }.joined(separator: ", ")
            let note = "glasspaned: pixel capture of window " + String(context.window.windowID)
                + " needs a display crop while " + String(covered.count)
                + " window(s) are on top of it (" + names
                + "); that region is not the target surface, so no pixel ratio is measured (R6-11)\n"
            FileHandle.standardError.write(Data(note.utf8))
        }
        return plan
    }

    /// The refusal text for "no candidate produced an image", worded to the facts
    /// the plan has: an occluded target is a different problem from a window that
    /// is not on screen at all, and the caller's next step differs accordingly.
    private static func noSurfaceReason(
        context: (window: SCWindow, display: SCDisplay), plan: SurfacePlan
    ) -> String {
        let window = String(context.window.windowID)
        if plan.occlusionUncountable {
            return "no capture surface available for window " + window
                + "; whether another window covers it could not be counted (the CG window list did not contain the target, or a neighbour's bounds were unreadable), so no display crop was offered (R6-11)"
        }
        guard !plan.occludedBy.isEmpty else {
            if let cropRefusal = plan.cropRefusal {
                return "no capture surface available for window " + window
                    + "; the display-region fallback was refused because " + cropRefusal
                    + " (a crop in the wrong coordinate space is a different screen area, not this window)"
            }
            return "no capture surface available for window " + window
                + " (neither its own surface nor a display crop produced an image)"
        }
        return "window " + window + " is on screen but is covered by "
            + String(plan.occludedBy.count) + " window(s) ("
            + plan.occludedBy.map { String($0) }.joined(separator: ", ")
            + "), and its own surface could not be captured either"
    }

    /// 采集配置的共同决定点：**两条 OS 分支（SCScreenshotManager / SCStream）都只经
    /// 过这里**，所以"像素尺寸从哪来""sourceRect 从哪来"只有一个答案，不会一条路修好、
    /// 另一条路继续按旧算式产出图片。
    ///
    /// 两种结局互不折叠：拿到配置 = 真的会产出一张有定义域的图；`refused` = 一次显式
    /// 未测量，调用方必须把它抛成 `pixelCaptureDenied`，不许拿任何图当替代。
    enum ConfigurationOutcome {
        case configured(SCStreamConfiguration)
        case refused(ChannelError)
    }

    /// - Parameters:
    ///   - region: 要采的那块区域（窗口自己的面 = 窗口 frame；整屏裁剪 = 裁剪矩形）。
    ///   - displayLocalCrop: 已经换算成**显示器本地**逻辑坐标的裁剪矩形；nil 表示
    ///     filter 本身就是窗口面，绝不能再挂一个 sourceRect 上去。
    ///   - scale: `filter.pointPixelScale`（13 那条路用 `NSScreen.backingScaleFactor`）。
    ///
    /// 这里**不**管 `pixelFormat`：SCStream 那条要自己点名（见 `snapViaStream`），
    /// 那条声明不能由公共构造点替它说——它钉的是"这条路按 BGRA 抄缓冲"这个假设。
    static func configuration(
        region: CGRect,
        displayLocalCrop: CGRect?,
        scale: CGFloat
    ) -> ConfigurationOutcome {
        // 尺寸算不出一张有定义域的图 ⇒ 一次显式拒绝，绝不返回一个把边长凑到 1 px 的
        // 配置。旧写法 `config.width = max(1, ceil(region.width * scale))` 就干过这件事：
        // 一个亚像素区域拿到 1×1，注释却说这条路径拒绝"合法但空白的 1×1 采集"，随后
        // 那一个像素的"比率"被当成测量发进证据链（R6-12）。
        guard let pixels = outputPixels(region: region, scale: scale) else {
            return .refused(.pixelCaptureDenied(reason:
                "a \(region.width)x\(region.height) pt region at \(scale)x would produce "
                + "\(Swift.max(1, Int(ceil(region.width * scale))))x\(Swift.max(1, Int(ceil(region.height * scale)))) pixel output;"
                + " a capture with a one-pixel (or degenerate) side is not a measurement of any interface,"
                + " so no image is produced here and no pixel difference is reported (refused rather than manufactured)"
            ))
        }
        let config = SCStreamConfiguration()
        // A window-scoped filter is already the window: setting a display-space
        // sourceRect on it would crop the wrong thing entirely.
        if let rect = displayLocalCrop { config.sourceRect = rect }
        config.width = pixels.width
        config.height = pixels.height
        config.showsCursor = false
        config.capturesAudio = false
        return .configured(config)
    }

    /// 输出像素尺寸（`config.width` / `config.height` 的**唯一**来源）。
    ///
    /// 返回 nil 表示"这个区域不可能被诚实采成一个二维图像"：亚像素、非有限、倍率不可用，
    /// 以及任何一条边只有 1 像素的输出。调用方必须据此拒绝，不得 `max(1, …)` 凑数——
    /// 凑出来的图会带着一个看起来像测量结论的像素差进档案。
    static func outputPixels(region: CGRect, scale: CGFloat) -> (width: Int, height: Int)? {
        guard scale.isFinite, scale > 0 else { return nil }
        guard region.width.isFinite, region.height.isFinite,
              region.width > 0, region.height > 0 else { return nil }
        guard let width = pixelSpan(points: region.width, scale: scale),
              let height = pixelSpan(points: region.height, scale: scale) else { return nil }
        guard width > 1, height > 1 else { return nil }
        return (width, height)
    }

    /// `ceil(points × scale)` without letting an overflow become a negative dimension.
    private static func pixelSpan(points: CGFloat, scale: CGFloat) -> Int? {
        let scaled = points * scale
        guard scaled.isFinite, scaled <= CGFloat(Int.max) else { return nil }
        return Int(ceil(scaled))
    }

    /// `SCStreamConfiguration.sourceRect` 的单位是**显示器本地逻辑坐标**
    /// （`specs/GlassPane_P1_实施规格_v1.0_SCK迁移.md:37`：「显示器逻辑坐标系，单位
    /// point」），而 `SCWindow.frame` 是全局桌面坐标。本文件自己就把这两个量放在一起比
    /// （`selectDisplayIndex` 拿 `window.frame` 与 `display.frame` 求相交），这只有在两者
    /// 同属全局坐标时才有意义——所以旧写法把 `context.window.frame` 原样交给 sourceRect
    /// 是自相矛盾的：原点恰为 (0,0) 的那块屏上两个数字碰巧相等，别的屏上它们指的是世界里
    /// 的两块不同区域，而采回来的图仍然被贴上"这个窗口的像素"的标签（R6-12）。
    ///
    /// 返回 nil = **拒绝裁剪**：窗口与这块显示器不相交（或矩形退化/非有限）时，减去显示器
    /// 原点得到的矩形既不在窗口上也不在这块屏上，那不是裁剪而是另采一处。
    ///
    /// 边界如实记下：跨两块屏的窗口（与所选显示器只**部分**相交）这里按相交部分给出本地
    /// 矩形，落在显示器外的部分由 SDK 决定它怎么裁——那一格的真机行为本机量不到
    /// （只有一块原点 (0,0) 的屏），属 未观测，不是已验证。
    static func cropRect(window: CGRect, display: CGRect) -> CGRect? {
        let coordinates = [
            window.minX, window.minY, window.width, window.height,
            display.minX, display.minY, display.width, display.height,
        ]
        guard coordinates.allSatisfy({ $0.isFinite }) else { return nil }
        guard window.width > 0, window.height > 0, display.width > 0, display.height > 0 else {
            return nil
        }
        guard display.intersects(window) else { return nil }
        return window.offsetBy(dx: -display.minX, dy: -display.minY)
    }

    // MARK: - Path A (macOS 14+, SCScreenshotManager)

    @available(macOS 14.0, *)
    private static func captureViaScreenshotManager(ownerPid pid_t: pid_t, windowId: Int?) throws -> Capture {
        let context = try resolveCaptureContext(ownerPid: pid_t, windowId: windowId)
        // 先取窗口自己的面；整屏裁剪只在 `surfacePlan` 判定没有东西盖住时才会进候选。
        // 输出像素 = 区域尺寸 × 倍率（Retina 不降采样）。
        let plan = surfacePlan(context: context)
        var lastError: Error?
        for surface in plan.candidates {
            do {
                return Capture(
                    image: try snapViaScreenshotManager(contentFilter: surface.filter,
                                                        sourceRect: surface.sourceRect,
                                                        windowFrame: context.window.frame),
                    windowId: Int(context.window.windowID),
                    frame: context.window.frame
                )
            } catch {
                lastError = error
            }
        }
        throw lastError ?? ChannelError.pixelCaptureDenied(reason: noSurfaceReason(context: context, plan: plan))
    }

    @available(macOS 14.0, *)
    private static func snapViaScreenshotManager(contentFilter filter: SCContentFilter,
                                                 sourceRect: CGRect?,
                                                 windowFrame: CGRect) throws -> CGImage {
        let scale = CGFloat(filter.pointPixelScale)
        let config: SCStreamConfiguration
        switch configuration(
            region: sourceRect ?? windowFrame,
            displayLocalCrop: sourceRect,
            scale: scale
        ) {
        case .configured(let built):
            config = built
        case .refused(let error):
            throw error
        }
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
        var lastError: Error?
        let plan = surfacePlan(context: context)
        for surface in plan.candidates {
            do {
                return Capture(
                    image: try snapViaStream(contentFilter: surface.filter,
                                             sourceRect: surface.sourceRect,
                                             windowFrame: context.window.frame),
                    windowId: Int(context.window.windowID),
                    frame: context.window.frame
                )
            } catch {
                lastError = error
            }
        }
        throw lastError ?? ChannelError.pixelCaptureDenied(reason: noSurfaceReason(context: context, plan: plan))
    }

    @available(macOS 13.0, *)
    private static func snapViaStream(contentFilter filter: SCContentFilter,
                                      sourceRect: CGRect?,
                                      windowFrame: CGRect) throws -> CGImage {
        // 像素格式在这里点名，不交给默认值：下面的转换是按单平面 BGRA 写的，
        // 而 `SCStreamConfiguration.pixelFormat` 的默认值不是这条契约的一部分。
        // 13 那条流路径在本仓历史上从来没产出过帧（帧输出从前没登记），所以这个假设
        // 从未在那条路上被运行验证过；让它显式，是"证据不能建在一个没核过的默认值上"。
        let region = sourceRect ?? windowFrame
        // 倍率量不到就拒绝这次采集，而不是拿一个假设的倍率产图：见 `streamPixelScale`。
        guard let scale = streamPixelScale(for: windowFrame) else {
            throw ChannelError.pixelCaptureDenied(reason:
                "the macOS 13 capture path cannot measure the pixel scale for a window at "
                + "\(windowFrame): this release has no `SCContentFilter.pointPixelScale`, and the "
                + "screen-overlap reading is either absent or ambiguous (the screen frames and the "
                + "window frame are named in two different global coordinate spaces). A scale is "
                + "not something this channel may assume — an assumed 2x would put interpolated "
                + "pixels into the archived diff as if they had been measured."
            )
        }
        let config: SCStreamConfiguration
        switch configuration(
            region: region,
            displayLocalCrop: sourceRect,
            scale: scale
        ) {
        case .configured(let built):
            config = built
        case .refused(let error):
            throw error
        }
        config.pixelFormat = kCVPixelFormatType_32BGRA

        let bridge = StreamFrameBridge(timeout: .now() + captureTimeoutSeconds)
        let stream = SCStream(filter: filter, configuration: config, delegate: bridge)
        // 资源释放从 stream 存在的那一刻起登记：start 抛错或超时时采集会话已经建好，
        // 登记在 awaitStreamStart 之后就等于 macOS 13 路径每次失败泄漏一个 SCStream。
        defer { stream.stopCapture(completionHandler: { _ in }) }
        // `delegate` 只收流的生命周期回调（停止/出错），**不**收帧。帧要靠
        // `addStreamOutput(_:type:)` 登记成一个 `SCStreamOutput`；从前这一句不存在，
        // 于是 `bridge` 永远收不到帧、`waitForFirstFrame()` 每次都把
        // `captureTimeoutSeconds` 烧完再回 nil，macOS 13 的像素通道因此**永远**抛
        // `pixelCaptureDenied("SCStream first frame timed out…")`。方向和诚实性都对
        // （没测到就说不测到），但这条通道一次也没被测到过，而每次 act 都要为它付
        // 5s × 候选窗口 × before/after 的等待。登记必须在 start 之前，这是 API 的顺序。
        do {
            try addStreamOutput(bridge, to: stream)
        } catch {
            // 帧输出没挂上，就永远不会有第一帧——继续等 `captureTimeoutSeconds`
            // 只是把一个已经知道的原因伪装成一次超时。
            throw ChannelError.pixelCaptureDenied(
                reason: "SCStream frame output could not be attached: \(error.localizedDescription); no frame can arrive on this path"
            )
        }
        try awaitStreamStart(of: stream)
        let firstFrame = bridge.waitForFirstFrame()
        // 帧是流内部的对象，而 `bridge` 在这个作用域末尾就死了；`stopCapture` 是异步
        // 的，所以最后一帧可能在 bridge 看起来无人引用之后才落到它身上。显式把寿命延长到
        // 这段判定结束，不去赌 SCStream 是不是强持有它的输出。
        return try withExtendedLifetime(bridge) {
            switch firstFrame {
            case .image(let image):
                return image
            case .timedOut:
                throw ChannelError.pixelCaptureDenied(
                    reason: "SCStream first frame timed out after \(captureTimeoutSeconds)s or stream stopped"
                )
            case .unexpectedFormat(let fourCC):
                // 一个非 BGRA 的缓冲**不能**悄悄按 BGRA 抄一遍：那会得到一张绿色/噪声图，
                // 再把它的像素差当成一次真实测量写进证据包。宁可拒测。
                throw ChannelError.pixelCaptureDenied(
                    reason: "SCStream delivered a \(fourCC) buffer; this capture path converts single-planar BGRA only, and a wrong-format copy would be a fabricated pixel diff"
                )
            case .conversionFailed(let fourCC):
                throw ChannelError.pixelCaptureDenied(
                    reason: "SCStream delivered a \(fourCC) buffer that could not be converted into an image"
                )
            }
        }
    }

    /// 把帧输出登记到流上。`SCStream(delegate:)` 只收生命周期回调，**不收帧**：
    /// 这一句从前不存在，于是 `waitForFirstFrame()` 每次只能等到超时，macOS 13 的
    /// 像素通道一次也没有被测到过（方向和诚实性都对——没测到就说不测到，但每次
    /// act 都要为它付 5s × 候选窗口 × before/after 的等待）。登记须在 start 之前。
    @available(macOS 13.0, *)
    private static func addStreamOutput(_ bridge: StreamFrameBridge, to stream: SCStream) throws {
        try stream.addStreamOutput(
            bridge, type: .screen,
            sampleHandlerQueue: DispatchQueue(label: "glasspane.sck.stream-output")
        )
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

    /// macOS 13 无 `pointPixelScale`，能用的读数只有「这块窗口落在**恰好一块**屏幕上」
    /// 那一种无歧义情形。为什么只信那一种：`NSScreen.frame` 站在 Cocoa 的**左下**原点
    /// 全局空间，`SCWindow.frame` 站在 SCK/CG 的**左上**原点全局空间（本文件 `cropRect`
    /// 一节 :582-595 就是按后者写的），所以多屏时按 `intersects` 挑屏挑到的可能是另一块
    /// ——倍率拿错，产出的是插值图，而那张图会被当**测量值**归档。单屏时 y 翻转不改变
    /// "相交/不相交"的答案，这个读数才站得住。
    ///
    /// 从前这里在挑不到屏幕时 `?? 2.0`：一次没量到就替用户的显示器宣布它是 Retina。
    /// 与本文件 :15/:163/:518 同一条规矩——量不到就走 `pixelCaptureDenied`，不许拿一个
    /// 假设的值当证据。
    static func pixelScale(from screens: [(frame: CGRect, scale: CGFloat)],
                           windowFrame: CGRect) -> CGFloat? {
        let hits = screens.filter {
            $0.frame.intersects(windowFrame) && $0.scale.isFinite && $0.scale > 0
        }
        guard hits.count == 1 else { return nil }
        return hits[0].scale
    }

    @available(macOS 13.0, *)
    private static func streamPixelScale(for windowFrame: CGRect) -> CGFloat? {
        pixelScale(
            from: NSScreen.screens.map { ($0.frame, $0.backingScaleFactor) },
            windowFrame: windowFrame
        )
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

        /// 首帧的三种结局。**"没等到"与"等到了但这条路转不了"必须分开说**：把后者报成
        /// 一次超时，就是拿一个已知原因去伪装计时抖动，而读的人会去加超时——那是往错的
        /// 方向修。三种都在这里判，调用方没有机会把格式问题读成慢。
        enum FirstFrame {
            case image(CGImage)
            case timedOut
            case unexpectedFormat(fourCC: String)
            case conversionFailed(fourCC: String)
        }

        func waitForFirstFrame() -> FirstFrame {
            _ = signal.wait(timeout: timeout)
            lock.lock()
            defer { lock.unlock() }
            guard let buffer = frame else { return .timedOut }
            let fourCC = Self.fourCC(CVPixelBufferGetPixelFormatType(buffer))
            guard CVPixelBufferGetPixelFormatType(buffer) == FourCharCode(kCVPixelFormatType_32BGRA) else {
                return .unexpectedFormat(fourCC: fourCC)
            }
            guard let image = Self.image(from: buffer) else {
                return .conversionFailed(fourCC: fourCC)
            }
            return .image(image)
        }

        /// 一个 fourCC 要能被抄进 issue：`1145396224` 这种十进制没人查得动。
        private static func fourCC(_ code: UInt32) -> String {
            let characters = [
                Character(UnicodeScalar((code >> 24) & 0xFF) ?? "?"),
                Character(UnicodeScalar((code >> 16) & 0xFF) ?? "?"),
                Character(UnicodeScalar((code >> 8) & 0xFF) ?? "?"),
                Character(UnicodeScalar(code & 0xFF) ?? "?"),
            ]
            return String(characters)
        }

        /// 把**单平面 BGRA** 像素缓冲拷贝进位图上下文，生成独立生命周期的 CGImage，
        /// 避免持有流内部缓冲。格式由 `waitForFirstFrame` 在调用之前核过：这条拷贝
        /// 对任何别的格式都会得出一张错的图，而错的图会带着一个看似真实的像素差进档案。
        private static func image(from buffer: CVPixelBuffer) -> CGImage? {
            let width = CVPixelBufferGetWidth(buffer)
            let height = CVPixelBufferGetHeight(buffer)
            guard width > 0, height > 0 else { return nil }
            CVPixelBufferLockBaseAddress(buffer, [])
            defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
            guard let baseAddress = CVPixelBufferGetBaseAddress(buffer) else { return nil }
            let sourceStride = CVPixelBufferGetBytesPerRow(buffer)
            let colorSpace = CGColorSpaceCreateDeviceRGB()
            // PremultipliedFirst + little-endian == BGRA。这一句只在调用方已经核过
            // `CVPixelBufferGetPixelFormatType` 时成立——`waitForFirstFrame` 就是那道核。
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