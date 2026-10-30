import Foundation
import CoreGraphics

/// 输入监控权限探针（P1 spec v1.2 §6.3）。
///
/// CG 仅暴露布尔预检（`CGPreflightListenEventAccess`），所以本探针能**观测**的只有两件事：
///  - `granted`        ⇔ preflight == true（这是观测）；
///  - `unverifiable`   ⇔ preflight == false（除此之外什么都没说）。
///
/// 从前 false 那一支还分两种词：`hasRequestedThisRun ? .unverifiable : .notDetermined`。后半个
/// 主张的是**历史**——"这一次运行之前没人问过"——而 TCC 的判定是持久的、`hasRequestedThisRun`
/// 是每进程的：上一次运行被拒的席位，这次新进程读出来就是 `.notDetermined`，面板据此写
/// 「未请求」（`PermissionBadge.make`）。那句话没有量过。2026-10-19 那一轮已经把"问过没答"从
/// `denied` 救出来（一个决定，在系统还没做决定的时候说出口），本轮把同一枚布尔撑不起的第二句
/// 也救出来，口径与辅助功能那一席完全一致（`AccessibilityPermissionProbe.displayStatus`：
/// true → `.granted`，其余 → `.unverifiable`）。
///
/// `hasRequestedThisRun` 仍然留着，但它只管**措辞**：`hasPendingRequestThisRun` 说得出"这次运行
/// 问过"，说得出这一句的地方（引导文案、卡片注记）就说这一句；判定层一个字都不读它。
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
    /// 而不是"未验证"了事）。只读，**不改判定**：判定只看预检，历史由这一句措辞承担。
    public var hasPendingRequestThisRun: Bool { hasRequestedThisRun }

    /// 当前观测状态（见类注释的约定与边界）：预检 true 是观测到的 `granted`，预检 false 最多
    /// 支持"这一次没量到授权"，也就是 `.unverifiable`——它分不出"没问过 / 问过挂着 / 问过被拒 /
    /// 上次被拒"，所以一个词都不替它们说。
    public var state: PermissionStatus {
        preflight() ? .granted : .unverifiable
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

    /// 只发起系统授权请求（不跳面板），并记录"本次运行已请求过"供**措辞**使用（P1 v1.2 §11.2：
    /// daemon 以自身身份申请时用它，面板跳转由 GUI 侧负责）。判定不受它影响。
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