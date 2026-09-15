import Foundation
import CoreGraphics

/// 输入监控权限探针（P1 spec v1.2 §6.3）。
///
/// CG 仅暴露布尔预检（`CGPreflightListenEventAccess`），notDetermined 与
/// denied 无法直接区分，沿用 P1 §3.1 屏幕录制三态模型的近似约定：
///  - `granted`         ⇔ preflight == true；
///  - `notDetermined`   ⇔ preflight == false 且本进程尚未发出过授权请求；
///  - `denied`          ⇔ preflight == false 且已发出过授权请求仍被拒。
///
/// 诚实边界：该近似的跨进程局限与 `ScreenCapturePermissionProbe` 一致
/// （见 P1 v1.0 §5.1），面板如实呈现为「未验证态」场景由 UI 层文案承接。
public final class InputMonitoringPermissionProbe {
    public typealias Preflight = () -> Bool
    public typealias RequestAccess = () -> Void
    public typealias OpenPane = () -> Void

    private let preflight: Preflight
    private let requestAction: RequestAccess
    private let openPaneAction: OpenPane
    private var hasRequestedThisRun = false

    public init(
        preflight: @escaping Preflight = { CGPreflightListenEventAccess() },
        requestAccess: @escaping RequestAccess = { CGRequestListenEventAccess() },
        openPane: @escaping OpenPane = { InputMonitoringPermissionProbe.openSystemPane() }
    ) {
        self.preflight = preflight
        self.requestAction = requestAccess
        self.openPaneAction = openPane
    }

    /// 当前观测状态（见类注释的约定与边界）。
    public var state: PermissionStatus {
        if preflight() {
            return .granted
        }
        return hasRequestedThisRun ? .denied : .notDetermined
    }

    /// 触发系统授权请求；已授权时短路返回 `.granted`。返回请求后最新状态。
    @discardableResult
    public func requestAccess() -> PermissionStatus {
        if preflight() {
            return .granted
        }
        hasRequestedThisRun = true
        requestAction()
        openPaneAction()
        return preflight() ? .granted : .denied
    }

    /// 打开系统设置输入监控面板深链。
    public static func openSystemPane() {
        let paneURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = [paneURL]
        try? process.run()
    }
}