import Foundation

/// 开发者工具权限探针（P1 spec v1.2 §6.1 诚实边界）。
///
/// listening / developer-tools TCC 服务无公开查询 API，故这类权限不伪造
/// 授权态，恒定呈现 `unverifiable`（UI 显示"未验证（无公开查询接口）"），
/// 仅提供打开系统设置面板的引导。
public final class DeveloperToolsPermissionProbe {
    public typealias OpenPane = () -> Void

    public static let unavailableText = "未验证（无公开查询接口）"

    private let openPaneAction: OpenPane

    public init(openPane: @escaping OpenPane = { DeveloperToolsPermissionProbe.openSystemPane() }) {
        self.openPaneAction = openPane
    }

    /// 恒为 `unverifiable`：不伪造 granted/denied 判定。
    public var status: PermissionStatus { .unverifiable }

    /// 展示文案（单一真源）。
    public var availabilityText: String { Self.unavailableText }

    /// 打开系统设置开发者工具面板深链（尽力而为）。
    public func openPane() {
        openPaneAction()
    }

    public static func openSystemPane() {
        let paneURL = "x-apple.systempreferences:com.apple.preference.security?Privacy_DeveloperTools"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = [paneURL]
        try? process.run()
    }
}