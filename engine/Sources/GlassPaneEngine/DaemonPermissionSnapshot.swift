import Foundation
import ApplicationServices

// MARK: - TCC 授权主体（P1 v1.2 §11 权限主体修正）

/// 一次 TCC 席位判定所依附的**进程身份**。
///
/// 系统按「每个客户端身份」分别记账，客户端身份由可执行文件解析而来：
///  - bundle 身份（`.app` 内、`Info.plist` 被签名绑定）→ 系统设置里显示为
///    bundle 可读名并带图标，可用「+」选择或从 Finder 拖入；
///  - 裸二进制（无 bundle / `Info.plist=not bound`）→ 无展示名与图标可解析，
///    条目以可执行文件名单独呈现，且**当父进程为 GUI app 时授权判定会继承
///    父 app 的席位**（真机实测：同一未授权副本从已授权终端启动时
///    `CGPreflightListenEventAccess()` 返回 true，改由 launchd 起则为
///    notDetermined）。
///
/// 结论：权限只能由「真正使用该权限的那个进程」自己测量与申请。daemon 的
/// 席位必须由 daemon 上报（`hello.permissions`），申请动作也必须由 daemon
/// 以自身上下文发起（见 `PermissionGuide.daemonRequestCommand`）。
public struct PermissionSubject: Equatable, Sendable {
    /// daemon 可执行文件的绝对路径（TCC 按路径记账时即为该值）。
    public let binaryPath: String
    /// 所属 bundle 的标识符；裸二进制为 nil（= 无 bundle 身份）。
    public let bundleIdentifier: String?
    /// 所属 bundle 路径；裸二进制为 nil。
    public let bundlePath: String?

    public init(binaryPath: String, bundleIdentifier: String? = nil, bundlePath: String? = nil) {
        self.binaryPath = binaryPath
        self.bundleIdentifier = bundleIdentifier
        self.bundlePath = bundlePath
    }

    /// 是否具备 bundle 身份（决定系统设置面板里能否显示可读名与图标）。
    public var hasBundleIdentity: Bool { bundleIdentifier != nil && bundlePath != nil }

    /// 系统设置权限列表里该主体**实际会显示**的条目名：bundle 身份取 bundle
    /// 目录名（去 `.app`，与 CFBundleDisplayName 同源），裸二进制取文件名。
    public var tccEntryName: String {
        if let bundlePath, hasBundleIdentity {
            return URL(fileURLWithPath: bundlePath).deletingPathExtension().lastPathComponent
        }
        return URL(fileURLWithPath: binaryPath).lastPathComponent
    }

    /// 本进程身份（默认解析路径允许注入，便于单测覆盖裸二进制/bundle 两态）。
    public static func current(
        binaryPath: String? = nil,
        bundle: Bundle = .main
    ) -> PermissionSubject {
        let resolvedBinary = binaryPath
            ?? bundle.executableURL?.path
            ?? bundle.bundlePath + "/Contents/MacOS/unknown"
        let bundleIdentifier = bundle.bundleIdentifier
        // 只有当 bundleURL 确实是 .app 目录时才算 bundle 身份：SwiftPM 裸二进制的
        // Bundle.main 会指向当前目录，不能误判为 bundle。
        let bundlePath = bundle.bundleURL.pathExtension == "app" ? bundle.bundlePath : nil
        return PermissionSubject(
            binaryPath: resolvedBinary,
            bundleIdentifier: bundlePath == nil ? nil : bundleIdentifier,
            bundlePath: bundlePath
        )
    }

    /// `hello` 线上的 `identity` 字典（nil 字段如实省略，不留假值）。
    public var wireValue: [String: Any] {
        var value: [String: Any] = ["binaryPath": binaryPath]
        if let bundleIdentifier { value["bundleIdentifier"] = bundleIdentifier }
        if let bundlePath { value["bundlePath"] = bundlePath }
        value["hasBundleIdentity"] = hasBundleIdentity
        return value
    }

    /// 从 `hello` 的 `identity` 字典还原（字段缺失时返回 nil，供调用方判定
    /// "旧 daemon 不上报身份"）。
    public static func from(wireValue value: [String: Any]?) -> PermissionSubject? {
        guard let value, let binaryPath = value["binaryPath"] as? String else { return nil }
        return PermissionSubject(
            binaryPath: binaryPath,
            bundleIdentifier: value["bundleIdentifier"] as? String,
            bundlePath: value["bundlePath"] as? String
        )
    }
}

// MARK: - daemon 自身权限席位快照

/// daemon 四类权限席位 + 身份（P1 v1.2 §11.2：权限状态的**唯一真源**）。
///
/// 探针全部走注入式钩子，因此在无 TCC / 无 GUI 环境下可直接单测；真机上
/// 由 daemon 进程自身求值，面板经 `hello` 取回，绝不由面板进程代测。
public struct DaemonPermissionSnapshot: Equatable, Sendable {
    public let subject: PermissionSubject
    public let statuses: [PermissionKind: PermissionStatus]

    public init(subject: PermissionSubject, statuses: [PermissionKind: PermissionStatus]) {
        self.subject = subject
        self.statuses = statuses
    }

    public func status(for kind: PermissionKind) -> PermissionStatus {
        statuses[kind] ?? .unverifiable
    }

    /// `hello` 线上的 `permissions` 字典（kind.rawValue → status.rawValue）。
    public var permissionsWire: [String: String] {
        var value: [String: String] = [:]
        for (kind, status) in statuses {
            value[kind.rawValue] = status.rawValue
        }
        return value
    }

    /// 从 `hello` 响应还原四类席位；缺失或非法值一律跳过（旧 daemon 兼容）。
    public static func statuses(from wire: [String: Any]?) -> [PermissionKind: PermissionStatus] {
        guard let wire else { return [:] }
        var result: [PermissionKind: PermissionStatus] = [:]
        for kind in PermissionKind.allCases {
            if let raw = wire[kind.rawValue] as? String, let status = PermissionStatus(rawValue: raw) {
                result[kind] = status
            }
        }
        return result
    }
}

/// 权限探针聚合器：把四类探针折叠成一份快照，并提供"以本进程身份发起申请"
/// 的统一入口（daemon 侧 `--request-permission <kind>` 与单测共用）。
public final class PermissionProbeSet {
    public let accessibility: AccessibilityPermissionProbe
    public let inputMonitoring: InputMonitoringPermissionProbe
    public let screenRecording: ScreenCapturePermissionProbe
    public let developerTools: DeveloperToolsPermissionProbe
    private let subjectProvider: () -> PermissionSubject

    public init(
        accessibility: AccessibilityPermissionProbe = AccessibilityPermissionProbe(),
        inputMonitoring: InputMonitoringPermissionProbe = InputMonitoringPermissionProbe(),
        screenRecording: ScreenCapturePermissionProbe = ScreenCapturePermissionProbe(),
        developerTools: DeveloperToolsPermissionProbe = DeveloperToolsPermissionProbe(),
        subjectProvider: @escaping () -> PermissionSubject = { PermissionSubject.current() }
    ) {
        self.accessibility = accessibility
        self.inputMonitoring = inputMonitoring
        self.screenRecording = screenRecording
        self.developerTools = developerTools
        self.subjectProvider = subjectProvider
    }

    /// 当前快照（本进程身份下的四类席位）。
    public func snapshot() -> DaemonPermissionSnapshot {
        DaemonPermissionSnapshot(
            subject: subjectProvider(),
            statuses: [
                .accessibility: accessibility.displayStatus(),
                .inputMonitoring: inputMonitoring.state,
                .screenRecording: screenRecording.state.panelStatus,
                .developerTools: developerTools.status,
            ]
        )
    }

    /// 以**本进程身份**发起一型权限申请：只唤起系统申请面（弹窗 / TCC 登记），
    /// 不跳系统面板、不轮询等待——面板由调用方（设置 GUI）打开，申请结果由
    /// 调用方重新 `snapshot()` 观测。返回值是申请发起后的即时观测状态，
    /// `denied` / `notDetermined` 不代表失败：用户可能稍后才在系统面板里勾选。
    @discardableResult
    public func request(_ kind: PermissionKind) -> PermissionStatus {
        switch kind {
        case .accessibility:
            accessibility.requestPrompt()
            return accessibility.displayStatus()
        case .inputMonitoring:
            inputMonitoring.requestOnly()
            return inputMonitoring.state
        case .screenRecording:
            screenRecording.requestOnly()
            return screenRecording.state.panelStatus
        case .developerTools:
            // 无系统总开关、无公开查询 API：不伪造申请动作，恒为 unverifiable。
            return developerTools.status
        }
    }
}
