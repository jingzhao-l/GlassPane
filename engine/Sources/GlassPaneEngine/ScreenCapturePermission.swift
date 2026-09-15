import Foundation
import CoreGraphics

/// 屏幕录制权限三态（P1 spec §3.1 状态模型）。
///
/// CG 仅暴露 `CGPreflightScreenCaptureAccess()` 布尔，`notDetermined` 与
/// `denied` 无法由 CG 直接区分。按 spec §3.1 约定：
///  - `granted`           ⇔ preflight == true；
///  - `notDetermined`     ⇔ preflight == false 且本次进程尚未发出过授权请求
///    （此为「从未请求」的前态，调用 `guideAccess()` 会弹出系统授权）；
///  - `denied`            ⇔ preflight == false 且已发出过授权请求仍被拒。
///
/// 诚实边界：该近似以「本进程本次运行是否请求过」为信号，跨进程的 TCC
/// 历史状态无法观测；若用户在之前的进程里已被系统拒绝，本模型首检仍会
/// 呈现 `notDetermined`，此时 `--guide-screen-permission` 可重新唤起系统
/// 授权弹窗修正之（与 spec §3.1 文档一致）。
public enum ScreenCapturePermissionState: String, Equatable, Sendable {
    case granted
    case denied
    case notDetermined
}

/// 屏幕录制权限探针：观察与引导三态，注入式钩子便于单测（P1-A5）。
public final class ScreenCapturePermissionProbe {
    public typealias Preflight = () -> Bool
    public typealias RequestAccess = () -> Void

    private let preflight: Preflight
    private let requestAccess: RequestAccess
    private var hasRequestedThisRun = false

    public init(
        preflight: @escaping Preflight = { CGPreflightScreenCaptureAccess() },
        requestAccess: @escaping RequestAccess = { _ = CGRequestScreenCaptureAccess() }
    ) {
        self.preflight = preflight
        self.requestAccess = requestAccess
    }

    /// 当前观测状态（见 `ScreenCapturePermissionState` 的约定与边界）。
    public var state: ScreenCapturePermissionState {
        if preflight() {
            return .granted
        }
        return hasRequestedThisRun ? .denied : .notDetermined
    }

    /// 触发系统授权请求。已授权时短路返回 `.granted`，不调用 `requestAccess`
    /// （spec §3.2：进程已授权则 no-op）。返回请求后最新观测状态。
    @discardableResult
    public func guideAccess() -> ScreenCapturePermissionState {
        if preflight() {
            return .granted
        }
        hasRequestedThisRun = true
        requestAccess()
        return preflight() ? .granted : .denied
    }
}