import Foundation
import CoreGraphics

/// 输入监控权限探针（P1 spec v1.2 §6.3）。
///
/// CG 仅暴露布尔预检（`CGPreflightListenEventAccess`），所以本探针能**观测**的只有
/// "给了" 与 "还没给" 两件事：
///  - `granted`         ⇔ preflight == true（这是观测）；
///  - `notDetermined`   ⇔ preflight == false 且本进程尚未发出过授权请求（前态，
///    没有任何一次询问发生过的说法可以由 preflight==false 支撑）；
///  - `unverifiable`    ⇔ preflight == false 且本次运行**已经发起过请求**。
///
/// 第三条从前是 `denied`。那是一个决定，而 TCC 还没有做这个决定：用户此刻大概率正看着
/// 那个弹窗，而 `--permissions`/面板把 `denied` 渲染成「已拒绝」
/// （`SettingsPanelView.swift:786`）。预检在请求之后仍回 false 只说明"还没答应"，
/// 不说明"被拒绝"——产品对"没量到"的既有说法是 `PermissionStatus.unverifiable`
/// （面板文案「未验证」），这里就用它，不再新造一个词。
///
/// 诚实边界：该近似的跨进程局限与 `ScreenCapturePermissionProbe` 一致（见 P1 v1.0 §5.1）。
/// 真正观测到的拒绝（例如 daemon 自己上报的 denied 席位、或系统给出可读的拒绝原因）
/// 仍由 `PermissionStatus.denied` 表达——本探针没有观测到它，所以不再输出它。
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

    /// 本次运行已发起过授权请求（面板据此把同一句话讲成"已请求，等待系统决定"，
    /// 而不是"未请求"）。只读，不改判定。
    public var hasPendingRequestThisRun: Bool { hasRequestedThisRun }

    /// 当前观测状态（见类注释的约定与边界）。
    public var state: PermissionStatus {
        if preflight() {
            return .granted
        }
        return hasRequestedThisRun ? .unverifiable : .notDetermined
    }

    /// 触发系统授权请求；已授权时短路返回 `.granted`。返回请求后的观测状态：
    /// 预检仍为 false 时是"未测量"，不是"被拒绝"。
    @discardableResult
    public func requestAccess() -> PermissionStatus {
        if preflight() {
            return .granted
        }
        hasRequestedThisRun = true
        requestAction()
        openPaneAction()
        return preflight() ? .granted : .unverifiable
    }

    /// 只发起系统授权请求（不跳面板），并记录"本次运行已请求过"用于三态近似
    /// （P1 v1.2 §11.2：daemon 以自身身份申请时用它，面板跳转由 GUI 侧负责）。
    public func requestOnly() {
        guard !preflight() else { return }
        hasRequestedThisRun = true
        requestAction()
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