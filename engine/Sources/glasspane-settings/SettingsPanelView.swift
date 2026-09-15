import SwiftUI
import GlassPaneEngine

/// 设置面板主窗口（P1 spec v1.2 §6.2）。
///
/// 布局：权限清单逐项卡片（图标/名称/用途/状态徽标/引导按钮）+
/// daemon 状态卡（socket 路径、存活、协议版本）+ 拒绝降级形态说明折叠区。
struct SettingsPanelView: View {
    @EnvironmentObject private var model: SettingsModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                permissionSection
                daemonSection
                degradationSection
            }
            .padding(20)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("GlassPane 设置")
                .font(.title2.bold())
            Text("首次运行权限引导，逐项声明用途与拒绝降级形态。所有状态实时检测，修改后点击刷新。")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private var permissionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("权限").font(.headline)
            ForEach(model.entries) { entry in
                PermissionCardView(entry: entry) { kind in
                    runGuide(for: kind)
                }
            }
        }
    }

    private var daemonSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Daemon 状态").font(.headline)
                Spacer()
                if model.isRefreshing {
                    ProgressView().controlSize(.small)
                } else {
                    Button("刷新") { model.refresh() }.controlSize(.small)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                statusRow("Socket", model.daemon.socketPath)
                statusRow("存活", model.daemon.reachable ? "运行中" : "未运行")
                if let version = model.daemon.version {
                    statusRow("版本", "glasspaned \(version)")
                }
                if let protocolVersion = model.daemon.protocolVersion {
                    statusRow("协议", protocolVersion)
                }
                if let pid = model.daemon.pid {
                    statusRow("PID", "\(pid)")
                }
                if let error = model.lastRefreshError {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
            .padding(12)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var degradationSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("拒绝降级形态").font(.headline)
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(model.entries) { entry in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.descriptor.displayName).font(.callout.bold())
                            Text(entry.descriptor.degradationText)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 4)
                    }
                }
                .padding(.top, 8)
            } label: {
                Text("权限被拒绝后的行为遵循综述 §5.14 降级口径")
                    .font(.callout)
            }
        }
    }

    private func statusRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 56, alignment: .leading)
            Text(value)
                .font(.callout.monospaced())
                .textSelection(.enabled)
            Spacer()
        }
    }

    /// 引导动作：notDetermined → 触发系统授权并打开对应 pane；denied → 仅打开 pane。
    private func runGuide(for kind: PermissionKind) {
        switch kind {
        case .accessibility:
            model.guideAccessibility()
        case .inputMonitoring:
            model.guideInputMonitoring()
        case .screenRecording:
            model.guideScreenRecording()
        case .developerTools:
            model.guideDeveloperTools()
        }
    }
}

/// 单权限卡片。
struct PermissionCardView: View {
    let entry: SettingsModel.PermissionEntry
    let onGuide: (PermissionKind) -> Void

    private var badgeColor: Color {
        switch entry.status {
        case .granted:
            return .green
        case .denied:
            return .red
        case .notDetermined:
            return .gray
        case .unverifiable:
            return .gray
        }
    }

    private var badgeText: String {
        switch entry.status {
        case .granted:
            return "已授权"
        case .denied:
            return "已拒绝"
        case .notDetermined:
            return "未请求"
        case .unverifiable:
            return "未验证"
        }
    }

    private var iconName: String {
        switch entry.kind {
        case .accessibility:
            return "accessibility"
        case .inputMonitoring:
            return "cursorarrow.click.2"
        case .screenRecording:
            return "rectangle.on.rectangle"
        case .developerTools:
            return "hammer"
        }
    }

    private var buttonTitle: String {
        switch entry.status {
        case .granted:
            return "已授权"
        case .denied:
            return "打开系统设置"
        case .notDetermined:
            return "授权"
        case .unverifiable:
            return "打开系统设置"
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: iconName)
                .font(.title3)
                .foregroundStyle(badgeColor)
                .frame(width: 32)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(entry.descriptor.displayName).font(.callout.bold())
                    BadgeView(text: badgeText, color: badgeColor)
                }
                Text(entry.descriptor.purposeText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button(buttonTitle) {
                onGuide(entry.kind)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(entry.status == .granted)
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

/// 状态徽标（三态着色 + unverifiable 灰描边）。
struct BadgeView: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(color.opacity(0.6), lineWidth: 1)
            )
    }
}