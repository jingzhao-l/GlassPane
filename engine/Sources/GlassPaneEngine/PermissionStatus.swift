import Foundation

/// 权限状态枚举（P1 spec v1.2 §6.1）。
///
/// 四类权限共享该状态面：辅助功能/输入监控/屏幕录制为三态（granted/denied/
/// notDetermined），开发者工具因无公开 TCC 查询 API 恒为 unverifiable。
public enum PermissionStatus: String, Equatable, Sendable, CaseIterable {
    case granted
    case denied
    case notDetermined
    case unverifiable
}

/// 权限类别（P1 spec v1.2 §6.1 权限清单的单一真源）。
public enum PermissionKind: String, Equatable, Sendable, CaseIterable {
    case accessibility
    case inputMonitoring
    case screenRecording
    case developerTools
}

/// 权限静态文案（displayName / purposeText / degradationText 单一真源，
/// 供 SwiftUI 卡片与拒绝降级形态折叠区消费）。
public struct PermissionDescriptor: Equatable, Sendable {
    public let kind: PermissionKind
    public let displayName: String
    public let purposeText: String
    public let degradationText: String

    public init(kind: PermissionKind, displayName: String, purposeText: String, degradationText: String) {
        self.kind = kind
        self.displayName = displayName
        self.purposeText = purposeText
        self.degradationText = degradationText
    }

    /// 全量权限清单（综述 §5.14 / PRD US-01）。
    public static let all: [PermissionDescriptor] = [
        PermissionDescriptor(
            kind: .accessibility,
            displayName: "辅助功能",
            purposeText: "读取并操作被测应用的 AX 树（observe/act 主通道）",
            degradationText: "完全不可用：GP_E_AX_UNAVAILABLE，验证循环无法运行"
        ),
        PermissionDescriptor(
            kind: .inputMonitoring,
            displayName: "输入监控",
            purposeText: "C33 并发污染检测所需的 CGEvent 输入流监控",
            degradationText: "降级为纯操作权互斥，污染标注禁用"
        ),
        PermissionDescriptor(
            kind: .screenRecording,
            displayName: "屏幕录制",
            purposeText: "像素 diff 通道（T6/T7 视觉断言）",
            degradationText: "pixelDiff=null + circuitBreaker.level=1，T6 判定退化为 INCONCLUSIVE"
        ),
        PermissionDescriptor(
            kind: .developerTools,
            displayName: "开发者工具",
            purposeText: "LLDB attach（Z1–Z4.5 探针通道）",
            degradationText: "探针通道不可用（P1 默认不启用该通道）"
        ),
    ]

    public static func descriptor(for kind: PermissionKind) -> PermissionDescriptor {
        all.first { $0.kind == kind } ?? PermissionDescriptor(kind: kind, displayName: kind.rawValue, purposeText: "", degradationText: "")
    }
}

// MARK: - ScreenCapturePermissionState → PermissionStatus（统一 UI 状态面）

extension ScreenCapturePermissionState {
    /// 映射到面板通用状态枚举（P1 spec v1.2 §6.1，单一真源）。
    public var panelStatus: PermissionStatus {
        switch self {
        case .granted:
            return .granted
        case .denied:
            return .denied
        case .notDetermined:
            return .notDetermined
        }
    }
}

// MARK: - 权限引导：系统面板深链与引导文案（P1 v1.2 拖拽引导单一真源）

/// 拖拽引导的纯逻辑层：把权限类别映射到系统设置深链面板与引导文案。
/// 不触碰系统 API（Process / AX / CG 全部由注入的闭包承担），因此可在
/// 无 TCC、无 GUI 环境下直接单测（P1 v1.2 拖拽引导验收）。
public enum PermissionGuide {
    /// 系统设置面板深链（x-apple.systempreferences 协议）。
    /// 开发者工具（Automation）以 `Privacy_Automation` 为准；诚实边界：
    /// 该面板专用于 Apple Events，UI 恒为 unverifiable（无公开查询接口）。
    public static func systemPaneURL(for kind: PermissionKind) -> String {
        switch kind {
        case .accessibility:
            return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .inputMonitoring:
            return "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        case .screenRecording:
            return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        case .developerTools:
            return "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
        }
    }

    /// 打开系统面板深链（尽力而为，失败静默——面板打开失败时引导文案仍可见）。
    public static func openSystemPane(for kind: PermissionKind) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = [systemPaneURL(for: kind)]
        try? process.run()
    }

    /// 拖拽落点后的引导文案；`droppedName` 为被拖入 bundle 的可读名
    /// （缺省用 GlassPane）。文案承担两类边界：
    ///  - 目标入口名可能不是 "GlassPane"（如二进制直跑时是 glasspaned）；
    ///  - 开发者工具恒为 unverifiable，只给 Apple Events 触发说明。
    public static func instruction(for kind: PermissionKind, droppedName: String = "GlassPane") -> String {
        switch kind {
        case .accessibility:
            return "已打开「辅助功能」面板：请为 \(droppedName) 打开开关。开启后本窗口会自动变绿。"
        case .inputMonitoring:
            return "已打开「输入监控」面板：请为 \(droppedName) 打开开关。开启后本窗口会自动变绿（首次需重启该 app 生效）。"
        case .screenRecording:
            return "已打开「屏幕录制」面板：请为 \(droppedName) 打开开关。开启后本窗口会自动变绿。"
        case .developerTools:
            return "开发者工具（Apple Events）无系统总开关，由触发动作自动弹窗申请：运行需要 LLDB attach 的操作时，系统询问是否允许控制，选允许即可。"
        }
    }

    /// 拖拽引导条标题（诚实呈现可自动检测的子集）。
    public static let bannerTitle = "拖拽引导：把窗口顶部的 GlassPane 图标拖到下方权限卡上，直接打开对应的系统设置面板"
    public static let bannerHint = "授权后本窗口自动检测并点亮；开发者工具无系统总开关，按卡片文案触发即可。"
}