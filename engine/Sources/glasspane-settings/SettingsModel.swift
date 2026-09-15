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

    /// 触发引导动作（spec §6.2 按钮语义）：notDetermined → 系统授权+pane；
    /// denied → 仅 openPane；granted → no-op。触发后立即重查刷新状态。
    func guideAccessibility() {
        guard !accessibilityProbe.isTrusted() else { return }
        accessibilityProbe.promptAndOpenPane()
        Task { await Task.yield() }
        refresh()
    }

    func guideInputMonitoring() {
        _ = inputMonitoringProbe.requestAccess()
        refresh()
    }

    func guideScreenRecording() {
        switch screenRecordingProbe.state {
        case .granted:
            break
        case .notDetermined, .denied:
            _ = screenRecordingProbe.guideAccess()
            refresh()
        }
    }

    func guideDeveloperTools() {
        developerToolsProbe.openPane()
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