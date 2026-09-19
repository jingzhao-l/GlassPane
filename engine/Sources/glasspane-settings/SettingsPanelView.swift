import SwiftUI
import UniformTypeIdentifiers
import GlassPaneEngine

/// 设置面板主窗口（P1 spec v1.2 §6.2）。
///
/// 布局：拖拽引导条（可拖动的 app 图标 + 操作说明）→ 权限清单逐项卡片（图标/
/// 名称/用途/状态徽标/引导按钮，卡片即落点）→ daemon 状态卡（socket 路径、
/// 存活、协议版本）→ 拒绝降级形态说明折叠区。窗口打开后每 1s 轮询一次权限
/// 实测状态，授权完成即自动点亮（拖拽只能打开系统面板，授权动作由用户在系统
/// 设置里完成，本面板只是替用户精确导航）。
struct SettingsPanelView: View {
    @EnvironmentObject private var model: SettingsModel

    /// 权限轮询定时器（1s 间隔；全部达成 granted/unverifiable 或窗口关闭即停）。
    @State private var pollTimer: Timer?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                DragGuideBannerView()
                if let guideText = model.pendingGuideText {
                    GuideBannerView(kind: model.pendingGuideKind, text: guideText) {
                        model.pendingGuideKind = nil
                        model.pendingGuideText = nil
                    }
                }
                permissionSection
                daemonSection
                degradationSection
            }
            .padding(20)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear(perform: startPolling)
        .onDisappear(perform: stopPolling)
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
                PermissionCardView(
                    entry: entry,
                    onGuide: { kind in runGuide(for: kind) },
                    onDropApp: { kind, droppedName in
                        model.handleDrop(kind: kind, droppedName: droppedName)
                    }
                )
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

    /// 启动 1s 权限轮询：拖拽只负责导航，是否授权由用户在系统面板完成，
    /// UI 通过轮询实测状态自动点亮。全部权限达成（granted 或 unverifiable）
    /// 即自停。AX trust / preflight 均为廉价本地查询，1s 间隔不构成负担。
    private func startPolling() {
        stopPolling()
        let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            Task { @MainActor in
                if model.pollPermissions() {
                    stopPolling()
                }
            }
        }
        pollTimer = timer
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }
}

/// 拖拽引导条：顶部可拖动的 app 图标 + 说明（拖 → 打开系统面板 → 授权后自动
/// 点亮）。整个横幅都可作为拖拽源，provider 提供纯文本 "GlassPane"（二进制
/// 直跑时无 .app bundle 路径，落点按文本名识别）。
struct DragGuideBannerView: View {
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "app")
                .font(.system(size: 30))
                .foregroundStyle(Color.accentColor)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.accentColor.opacity(0.12)))
                .help("按住并拖到此页下方的权限卡上")

            VStack(alignment: .leading, spacing: 3) {
                Text(PermissionGuide.bannerTitle)
                    .font(.callout.bold())
                Text(PermissionGuide.bannerHint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.accentColor.opacity(0.35), lineWidth: 1)
        )
        .onDrag {
            NSItemProvider(object: "GlassPane" as NSString)
        }
    }
}

/// 引导进行中横幅：展示最近一次落点/按钮触发的引导文案与所属权限，可手动关闭。
struct GuideBannerView: View {
    let kind: PermissionKind?
    let text: String
    let onDismiss: () -> Void

    private var tint: Color {
        guard let kind else { return .accentColor }
        switch kind {
        case .accessibility:
            return .blue
        case .inputMonitoring:
            return .orange
        case .screenRecording:
            return .purple
        case .developerTools:
            return .gray
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(tint)
            Text(text)
                .font(.callout)
                .textSelection(.enabled)
            Spacer()
            Button("关闭") {
                onDismiss()
            }
            .controlSize(.small)
        }
        .padding(10)
        .background(tint.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

/// 单权限卡片。整卡作为拖拽落点：接受 app bundle（fileURL）或纯文本
/// （顶部拖拽源），落下后交给 `onDropApp`（内部打开对应系统面板并记录引导
/// 状态）。落点悬停时高亮描边。
struct PermissionCardView: View {
    let entry: SettingsModel.PermissionEntry
    let onGuide: (PermissionKind) -> Void
    let onDropApp: (PermissionKind, String?) -> Void

    @State private var isDropTargeted = false

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
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(isDropTargeted ? Color.accentColor : Color.clear, lineWidth: 2)
        )
        .onDrop(
            of: [UTType.fileURL, UTType.plainText],
            delegate: PermissionCardDropDelegate(
                kind: entry.kind,
                onDrop: onDropApp,
                isTargeted: $isDropTargeted
            )
        )
    }
}

/// 卡片落点的 DropDelegate：同时接受 .app bundle（fileURL，解析 bundle 名）
/// 与纯文本（顶部拖拽源）。解析结果在后台队列产生，完成后跳到主队列再回调
/// `onDrop`（宿主的 SettingsModel 是 @MainActor，不能在后台线程触碰）。
struct PermissionCardDropDelegate: DropDelegate {
    let kind: PermissionKind
    let onDrop: (PermissionKind, String?) -> Void
    @Binding var isTargeted: Bool

    func dropEntered(info: DropInfo) {
        isTargeted = true
    }

    func dropExited(info: DropInfo) {
        isTargeted = false
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .copy)
    }

    func performDrop(info: DropInfo) -> Bool {
        isTargeted = false
        let providers = info.itemProviders(for: [UTType.fileURL, UTType.plainText])
        guard let provider = providers.first else {
            return false
        }

        let kind = self.kind
        let onDrop = self.onDrop

        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                let name: String?
                if let data = item as? Data,
                   let urlString = String(data: data, encoding: .utf8),
                   let url = URL(string: urlString) {
                    name = Self.resolveDroppedName(from: url)
                } else if let url = item as? URL {
                    name = Self.resolveDroppedName(from: url)
                } else {
                    name = nil
                }
                DispatchQueue.main.async {
                    onDrop(kind, name)
                }
            }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
                let name: String?
                if let string = item as? String {
                    name = string
                } else if let data = item as? Data, let string = String(data: data, encoding: .utf8) {
                    name = string
                } else {
                    name = nil
                }
                DispatchQueue.main.async {
                    onDrop(kind, name)
                }
            }
        }
        return true
    }

    /// 从 bundle URL 解析可读名：.app 优先读 Info.plist 的 CFBundleDisplayName/
    /// CFBundleName（系统设置面板按可读名展示条目），否则退化到去掉扩展名的
    /// 最后一节。非 .app（如普通文件）同样取 lastPathComponent。
    static func resolveDroppedName(from url: URL) -> String? {
        if url.pathExtension == "app" {
            let infoPlistURL = url.appendingPathComponent("Contents/Info.plist")
            if let data = try? Data(contentsOf: infoPlistURL),
               let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
               let dict = plist as? [String: Any],
               let bundleName = dict["CFBundleDisplayName"] as? String ?? dict["CFBundleName"] as? String {
                return bundleName
            }
        }
        return url.deletingPathExtension().lastPathComponent
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