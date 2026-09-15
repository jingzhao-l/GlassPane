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

    /// 由面板状态推导出的展示态（AX 仅有布尔可见性，无三态）。
    public func displayStatus() -> PermissionStatus {
        isTrusted() ? .granted : .notDetermined
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