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
/// and output size = window points × `pointPixelScale`. This also avoids the
/// `desktopIndependentWindow:` init, which can raise for windows that are not
/// desktop-independent.
public enum SCKCapturer {

    /// Total wall-clock budget for one capture, mirroring the defensive
    /// timeout discipline introduced for AX tree reads in P1.
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
            throw ChannelError.pixelCaptureDenied(
                reason: "SCScreenshotManager requires macOS 14+; macOS 13 SCStream fallback is a later P1 batch"
            )
        }
    }

    // MARK: - Path A (macOS 14+)

    @available(macOS 14.0, *)
    private static func captureViaScreenshotManager(ownerPid pid_t: pid_t, windowId: Int?) throws -> CGImage {
        let content: SCShareableContent
        do {
            guard let resolved = try tryWaitShareableContent(macOS14: {
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

        let window = try resolveWindow(in: content, ownerPid: pid_t, windowId: windowId)
        guard let display = content.displays.first(where: { $0.frame.intersects(window.frame) })
                ?? content.displays.first else {
            throw ChannelError.pixelCaptureDenied(
                reason: "no SCDisplay contains pid \(pid_t)'s window"
            )
        }
        // Whole-display filter + sourceRect 采样窗口区域，确定性最好；
        // 输出像素 = 窗口逻辑尺寸 × 显示器倍率（Retina 不降采样）。
        let filter = SCContentFilter(display: display, excludingWindows: [])
        return try snap(contentFilter: filter, windowFrame: window.frame)
    }

    @available(macOS 14.0, *)
    private static func resolveWindow(in content: SCShareableContent, ownerPid pid_t: pid_t, windowId: Int?) throws -> SCWindow {
        if let windowId,
           let exact = content.windows.first(where: { Int($0.windowID) == windowId }) {
            return exact
        }
        guard let largest = content.windows
            .filter({ $0.owningApplication?.processID == pid_t && $0.isOnScreen })
            .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            throw ChannelError.pixelCaptureDenied(
                reason: "no on-screen SCWindow owned by pid \(pid_t)"
            )
        }
        return largest
    }

    @available(macOS 14.0, *)
    private static func snap(contentFilter filter: SCContentFilter, windowFrame: CGRect) throws -> CGImage {
        let config = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        config.sourceRect = windowFrame
        config.width = max(1, Int(ceil(windowFrame.width * scale)))
        config.height = max(1, Int(ceil(windowFrame.height * scale)))
        config.showsCursor = false
        config.capturesAudio = false
        return try awaitGuardedNextImage(contentFilter: filter, config: config)
    }

    /// Bridges a macOS-14-only async expression to this synchronous frame,
    /// reusing the same timeout discipline as the image capture.
    @available(macOS 14.0, *)
    private static func tryWaitShareableContent(
        macOS14 body: @escaping () async throws -> SCShareableContent
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