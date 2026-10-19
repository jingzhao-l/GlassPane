import Foundation
import CoreGraphics

/// 屏幕录制权限三态（P1 spec §3.1 状态模型）。
///
/// CG 仅暴露 `CGPreflightScreenCaptureAccess()` 布尔，它能**观测**的只有"给了"与
/// "还没给"。按 spec §3.1 的约定，"还没给"再分两态：
///  - `granted`           ⇔ preflight == true（观测）；
///  - `notDetermined`     ⇔ preflight == false 且系统尚未做出可读到的决定 —— 含
///    "本次进程已发起请求、预检仍回 false" 这一种：用户此刻正看着弹窗，TCC 还没有
///    回答。**这不再是 `denied`**（见 `ScreenCapturePermissionProbe.state` 那段）；
///  - `denied`            ⇔ 真正观测到的拒绝（本探针拿不到，故不再由它输出；
///    daemon 上报的席位、调试能力实测那一类**观测到的**拒绝仍走这个值）。
///
/// 诚实边界：跨进程的 TCC 历史无法观测（P1 v1.0 §5.1）；"未请求"与"已请求但未决定"
/// 在这个三态里同为 `notDetermined`，两者在面板上的文案却不同，所以区分它们的责任在
/// `ScreenCapturePermissionProbe.panelStatus`（daemon 快照/`--permissions` 读的那一面）。
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

    /// 本次运行是否已发起过系统授权请求（只读；判定不依赖它，文案依赖它）。
    public var hasPendingRequestThisRun: Bool { hasRequestedThisRun }

    /// 当前观测状态（见 `ScreenCapturePermissionState` 的约定与边界）。
    public var state: ScreenCapturePermissionState {
        if preflight() {
            return .granted
        }
        // 从前这里是 `hasRequestedThisRun ? .denied : .notDetermined`：一次还没被回答的
        // 询问被写成一个决定，而面板把 `denied` 渲染成「已拒绝」
        // （`SettingsPanelView.swift:786`）。预检 false 只支持"系统尚未决定"这一句。
        return .notDetermined
    }

    /// 面板 / `hello.permissions` / `--permissions` 读的那一面（`PermissionStatus`）。
    ///
    /// 为什么需要一个单独的出口：`state` 的三态里"从未请求"与"已请求、等待回答"是同
    /// 一个词，而面板的文案不是——`notDetermined` 写「未请求」。刚发起过请求的席位不能
    /// 被说成"没问过"，也不能被说成"被拒绝"，产品的诚实值是 `unverifiable`（「未验证」）。
    public var panelStatus: PermissionStatus {
        switch state {
        case .granted:
            return .granted
        case .denied:
            return .denied
        case .notDetermined:
            return hasRequestedThisRun ? .unverifiable : .notDetermined
        }
    }

    /// 触发系统授权请求。已授权时短路返回 `.granted`，不调用 `requestAccess`
    /// （spec §3.2：进程已授权则 no-op）。返回请求后的观测状态：请求没有被回答时是
    /// "尚未决定"，不是"被拒绝"。
    @discardableResult
    public func guideAccess() -> ScreenCapturePermissionState {
        if preflight() {
            return .granted
        }
        hasRequestedThisRun = true
        requestAccess()
        return state
    }

    /// 只发起系统授权请求（不跳面板、不改观测语义），供 daemon 以自身身份
    /// 登记 TCC 席位使用（P1 v1.2 §11.2）。
    public func requestOnly() {
        guard !preflight() else { return }
        hasRequestedThisRun = true
        requestAccess()
    }
}