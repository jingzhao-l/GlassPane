import Foundation
import ApplicationServices

/// 辅助功能权限探针（P1 spec v1.2 §6.3）。
///
/// 注入式钩子便于单测（P1-C1）：`trustCheck` 注入 fake 后不触发任何真实
/// 系统调用；`openPane` 注入 fake 后不依赖 real 的 System Settings 跳转。
public final class AccessibilityPermissionProbe {
    public typealias TrustCheck = () -> Bool
    public typealias Prompt = () -> Void
    public typealias OpenPane = () -> Void

    private let trustCheck: TrustCheck
    private let prompt: Prompt
    private let openPane: OpenPane

    public init(
        trustCheck: @escaping TrustCheck = { AXIsProcessTrusted() },
        prompt: @escaping Prompt = {
            let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            let promptOptions = [promptKey: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(promptOptions)
        },
        openPane: @escaping OpenPane = { AccessibilityPermissionProbe.openSystemPane() }
    ) {
        self.trustCheck = trustCheck
        self.prompt = prompt
        self.openPane = openPane
    }

    /// 当前是否已获得辅助功能权限。
    public func isTrusted() -> Bool {
        trustCheck()
    }

    /// 触发系统授权提示并打开「隐私与安全性 > 辅助功能」设置面板。
    /// 已授权时仍调用（系统提示会 no-op），返回值不依赖 UI。
    public func promptAndOpenPane() {
        prompt()
        openPane()
    }

    /// 只唤起系统授权提示（不跳面板）。面板已由调用方打开时使用——关键是
    /// 它**以当前进程身份**登记 TCC 席位（P1 v1.2 §11.2：daemon 自己申请，
    /// 不由设置面板代申请）。
    public func requestPrompt() {
        prompt()
    }

    /// 由面板状态推导出的展示态。
    ///
    /// AX 只给一个布尔（`AXIsProcessTrusted`）：它在名单里被关掉、从来不在名单里、
    /// 名单条目被删掉，三种情况都回 false。从前这里回 `.notDetermined`，等于替读者
    /// 断言"这次运行还没问过系统"——面板把它渲染成「未请求」
    /// （`SettingsPanelView.swift:787`），而枚举与卡片图标本来把 granted / denied /
    /// notDetermined / unverifiable 四个状态分开，正是为了不把"不知道"冒充成三者之一。
    /// 产品的"未测量"值是 `.unverifiable`（卡片文案「未验证」，图标
    /// `questionmark.circle`，identifier `gp-perm-accessibility-unverifiable`），
    /// 引导按钮在该态仍然给出「授权」这个可动作用，所以诚实值不会变成一个死路。
    /// `.granted` 是这条布尔唯一支持的正向结论。
    public func displayStatus() -> PermissionStatus {
        isTrusted() ? .granted : .unverifiable
    }

    /// 打开系统设置辅助功能面板（`x-apple.systempreferences:` 深链）。
    public static func openSystemPane() {
        let paneURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = [paneURL]
        try? process.run()
    }
}