import SwiftUI
import GlassPaneEngine

/// 设置面板状态模型：聚合四类权限探针与 daemon 探测，提供一次性快照供
/// UI 渲染。状态判定全部在 engine 库探针层，本层仅做编排与缓存
/// （P1 spec v1.2 §9.3：SwiftUI 壳不做逻辑单测）。
@MainActor
final class SettingsModel: ObservableObject {

    /// 单权限条目（供卡片渲染）。
    struct PermissionEntry: Identifiable {
        let kind: PermissionKind
        let descriptor: PermissionDescriptor
        var status: PermissionStatus
        var id: PermissionKind { kind }
    }

    /// daemon 状态卡内容。
    struct DaemonEntry {
        var socketPath: String
        var reachable: Bool
        var version: String?
        var protocolVersion: String?
        var pid: Int?
    }

    @Published var entries: [PermissionEntry] = []
    @Published var daemon: DaemonEntry
    @Published var isRefreshing = false
    @Published var lastRefreshError: String?
    /// 拖拽引导状态：最近一次落点的权限类别（nil = 无进行中的引导）。
    @Published var pendingGuideKind: PermissionKind?
    /// 拖拽引导文案（`PermissionGuide.instruction` 或手动按钮引导文案）。
    @Published var pendingGuideText: String?

    private let accessibilityProbe: AccessibilityPermissionProbe
    private let inputMonitoringProbe: InputMonitoringPermissionProbe
    private let screenRecordingProbe: ScreenCapturePermissionProbe
    private let developerToolsProbe: DeveloperToolsPermissionProbe
    private let daemonProbe: DaemonProbe

    /// 与 daemon 默认一致的 socket 路径。
    public static func defaultSocketPath() -> String {
        NSHomeDirectory() + "/.glasspane/engine.sock"
    }

    init(socketPath: String? = nil, refreshOnAppear: Bool = true) {
        let resolvedSocketPath = socketPath ?? Self.defaultSocketPath()
        accessibilityProbe = AccessibilityPermissionProbe()
        inputMonitoringProbe = InputMonitoringPermissionProbe()
        screenRecordingProbe = ScreenCapturePermissionProbe()
        developerToolsProbe = DeveloperToolsPermissionProbe()
        daemonProbe = DaemonProbe()
        daemon = DaemonEntry(socketPath: resolvedSocketPath, reachable: false, version: nil, protocolVersion: nil, pid: nil)
        entries = PermissionDescriptor.all.map { descriptor in
            PermissionEntry(kind: descriptor.kind, descriptor: descriptor, status: .notDetermined)
        }
        if refreshOnAppear {
            refresh()
        }
    }

    /// 手动按钮引导（保持卡片按钮语义）：notDetermined → 系统授权+pane；
    /// denied → 仅打开 pane；granted → no-op。触发后立即重查刷新状态。
    func guideAccessibility() {
        guard !accessibilityProbe.isTrusted() else {
            pendingGuideKind = nil
            pendingGuideText = nil
            return
        }
        setPendingGuide(.accessibility, droppedName: nil)
        accessibilityProbe.promptAndOpenPane()
        refreshEntriesOnly()
    }

    func guideInputMonitoring() {
        setPendingGuide(.inputMonitoring, droppedName: nil)
        _ = inputMonitoringProbe.requestAccess()
        refreshEntriesOnly()
    }

    func guideScreenRecording() {
        switch screenRecordingProbe.state {
        case .granted:
            break
        case .notDetermined, .denied:
            setPendingGuide(.screenRecording, droppedName: nil)
            _ = screenRecordingProbe.guideAccess()
            let paneURL = PermissionGuide.systemPaneURL(for: .screenRecording)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = [paneURL]
            try? process.run()
            refreshEntriesOnly()
        }
    }

    func guideDeveloperTools() {
        setPendingGuide(.developerTools, droppedName: nil)
        developerToolsProbe.openPane()
    }

    /// 拖拽落点入口：被拖入 bundle 的名称（缺失时缺省）→ 打开对应系统面板
    /// 并记录引导状态；状态检测交给周期性 `pollPermissions()`（自动点亮）。
    /// 返回引导文案供 UI 展示。`droppedName` 从 bundle URL 解析，nil 表示
    /// 未识别到名称（此时用缺省 GlassPane）。
    @discardableResult
    func handleDrop(kind: PermissionKind, droppedName: String?) -> String {
        let name = droppedName?.isEmpty == false ? droppedName! : "GlassPane"
        setPendingGuide(kind, droppedName: name)
        switch kind {
        case .accessibility:
            accessibilityProbe.promptAndOpenPane()
        case .inputMonitoring:
            _ = inputMonitoringProbe.requestAccess()
        case .screenRecording:
            _ = screenRecordingProbe.guideAccess()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = [PermissionGuide.systemPaneURL(for: .screenRecording)]
            try? process.run()
        case .developerTools:
            developerToolsProbe.openPane()
        }
        refreshEntriesOnly()
        return PermissionGuide.instruction(for: kind, droppedName: name)
    }

    /// 周期性权限状态检测（拖拽后自动点亮）：只重查四类权限，不做 daemon
    /// 探测（socket hello 有 3s 超时，不能在轮询里阻塞）。所有权限达成
    /// granted/unverifiable 时返回 true，供 UI 停表。
    func pollPermissions() -> Bool {
        refreshEntriesOnly()
        return entries.allSatisfy { $0.status == .granted || $0.status == .unverifiable }
    }

    /// 仅重查权限条目（同步、轻量；AX trust/preflight 均为廉价的本地查询）。
    /// 直接取实测状态，不粘滞历史值——用户在中途撤销授权也应如实反映。
    private func refreshEntriesOnly() {
        let accessibility = accessibilityProbe.isTrusted()
        let inputMonitoring = inputMonitoringProbe.state
        let screenRecording = screenRecordingProbe.state.panelStatus
        let developerTools = developerToolsProbe.status
        for index in entries.indices {
            switch entries[index].kind {
            case .accessibility:
                entries[index].status = accessibility ? .granted : .notDetermined
            case .inputMonitoring:
                entries[index].status = inputMonitoring
            case .screenRecording:
                entries[index].status = screenRecording
            case .developerTools:
                entries[index].status = developerTools
            }
        }
    }

    private func setPendingGuide(_ kind: PermissionKind, droppedName: String?) {
        pendingGuideKind = kind
        pendingGuideText = PermissionGuide.instruction(for: kind, droppedName: droppedName ?? "GlassPane")
    }

    /// 重查全部权限与 daemon 状态（耗时探测放后台，不阻塞主线程）。
    func refresh() {
        isRefreshing = true
        lastRefreshError = nil
        let socketPath = daemon.socketPath

        let accessibility = accessibilityProbe.isTrusted()
        let inputMonitoring = inputMonitoringProbe.state
        let screenRecording = screenRecordingProbe.state.panelStatus
        let developerTools = developerToolsProbe.status

        for index in entries.indices {
            switch entries[index].kind {
            case .accessibility:
                entries[index].status = accessibility ? .granted : .notDetermined
            case .inputMonitoring:
                entries[index].status = inputMonitoring
            case .screenRecording:
                entries[index].status = screenRecording
            case .developerTools:
                entries[index].status = developerTools
            }
        }

        // daemon 探测走后台队列：hello 一次性会话有 3s 超时，不能阻塞 UI。
        let transport = daemonProbe
        Task.detached(priority: .userInitiated) {
            let reachable = transport.reachable(socketPath: socketPath)
            let summary = transport.helloSummary(socketPath: socketPath)
            Task { @MainActor in
                self.daemon = DaemonEntry(
                    socketPath: socketPath,
                    reachable: reachable,
                    version: summary?.version,
                    protocolVersion: summary?.protocolVersion,
                    pid: summary?.pid
                )
                self.isRefreshing = false
            }
        }
    }
}