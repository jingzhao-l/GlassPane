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