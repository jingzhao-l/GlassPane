import Foundation
import CoreGraphics

/// 屏幕录制权限席位状态（P1 spec §3.1 状态模型，2026-10-30 起加 `unverifiable`）。
///
/// CG 仅暴露 `CGPreflightScreenCaptureAccess()` 布尔，它能**观测**的只有"给了"与"这次没量到
/// 给"。所以：
///  - `granted`           ⇔ preflight == true（观测）；
///  - `unverifiable`      ⇔ preflight == false。这是产品对"没量到"的既有说法，也是本探针在
///    false 时**唯一**说得出口的值：一次布尔分不出"从没问过 / 问过还挂着 / 问过被拒 / 上一次
///    运行被拒"，而 `"还没决定"` 与 `"未请求"` 两句都是替系统声明一段它没量过的历史；
///  - `notDetermined`     ⇔ 「系统尚未做出决定」这一次**读得到**的观察。与 `denied` 同一条规矩：
///    本探针拿不到这种读数（CG 没有这个接口），所以它不再是探针的输出，只为 spec §3.1 那个
///    状态模型的名字与 `PermissionStatus.notDetermined` 那条线路保留——后者仍会从一个旧 daemon
///    的 `hello`/`--permissions` 里解出来（`DaemonPermissionSnapshot.statuses(from:)`），面板据此
///    渲染的那张卡也还在；
///  - `denied`            ⇔ 真正观测到的拒绝（本探针同样拿不到，见 `PermissionStatus.swift`
///    顶部那一段；daemon 上报的席位、调试能力实测那一类**观测到的**拒绝仍走这个值）。
///
/// 诚实边界：跨进程的 TCC 历史无法观测（P1 v1.0 §5.1）。"未请求"与"已请求但未决定"在措辞上
/// 是两句话，而它们不是两个判定——承担措辞的是 `ScreenCapturePermissionProbe.hasPendingRequestThisRun`，
/// 不是状态值本身。
public enum ScreenCapturePermissionState: String, Equatable, Sendable {
    case granted
    case denied
    case notDetermined
    case unverifiable
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

    /// 本次运行是否已发起过系统授权请求（只读；**判定不依赖它，文案依赖它**）。
    /// 说得出"这一次问过了"的地方（引导回执、卡片注记）就说这一句；它不把状态改成别的词——
    /// 状态只有一个来源，就是那个布尔。
    public var hasPendingRequestThisRun: Bool { hasRequestedThisRun }

    /// 当前观测状态（见 `ScreenCapturePermissionState` 的约定与边界）。
    ///
    /// 从前这里是 `hasRequestedThisRun ? .denied : .notDetermined`：一次还没被回答的询问被写成
    /// 一个决定，而面板把 `denied` 渲染成「已拒绝」。2026-10-19 那一轮改成一律
    /// `.notDetermined`，注释写"预检 false 只支持'系统尚未决定'这一句"——那一句仍然是超额主张：
    /// false 同样支持"已经决定：拒绝"，而且 TCC 是持久的，`hasRequestedThisRun` 是每进程的，
    /// 于是上一次运行被拒的席位这次又被说成"系统还没决定"（面板：「未请求」）。布尔最多支持
    /// "granted 或没量到 granted"，所以这里只回这两个值。
    public var state: ScreenCapturePermissionState {
        preflight() ? .granted : .unverifiable
    }

    /// 面板 / `hello.permissions` / `--permissions` 读的那一面（`PermissionStatus`）。
    ///
    /// 与 `state` 同一个事实源、同一个答案：从前这里要靠 `hasRequestedThisRun` 在
    /// `.notDetermined` 与 `.unverifiable` 之间分一次，分出来的那个词（「未请求」）说的是一段
    /// 探针量不到的历史。问过没答的那句话仍然要说得出，但它住在
    /// `hasPendingRequestThisRun` 的**措辞**里，不在判定里——与辅助功能那一席同一个形状。
    public var panelStatus: PermissionStatus { state.panelStatus }

    /// 触发系统授权请求。已授权时短路返回 `.granted`，不调用 `requestAccess`
    /// （spec §3.2：进程已授权则 no-op）。返回请求后的观测状态：没被回答时是"这次没量到授权"，
    /// 既不是"被拒绝"也不是"还没决定"。
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