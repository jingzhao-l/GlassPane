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
            HStack(spacing: 8) {
                Text("权限").font(.headline)
                Spacer()
            }
            // 主体声明（P1 v1.2 §11.2）：状态真源是 daemon 自报席位，面板不代测。
            Text(subjectLine)
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            // 授权已落但运行实例读不到（TCC 判定按进程缓存，§11.4）→ 给出重启入口。
            // 不自动重启：那会中断正在进行的 act，必须由用户点。
            if !model.kindsNeedingRestart.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Text(model.restartHint)
                        .font(.caption)
                        .foregroundStyle(.orange)
                    Spacer()
                    Button("重启 daemon") { model.restartDaemon() }
                        .controlSize(.small)
                        .help("launchctl kickstart -k \(SettingsModel.launchdLabel)：会中断正在进行的 act")
                }
                .padding(10)
                .background(Color.orange.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
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

    /// 授权主体一行话：daemon 自报身份（含是否 bundle 身份）+ 面板主体免责。
    private var subjectLine: String {
        guard let subject = model.daemon.subject else {
            return PermissionGuide.daemonOfflineText + "；" + PermissionGuide.panelSubjectDisclaimer
        }
        let identity = subject.hasBundleIdentity ? "bundle 身份" : "裸二进制（列表内只显示文件名）"
        return "授权主体：\(subject.tccEntryName)（\(identity)）· \(subject.binaryPath)"
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
                if let subject = model.daemon.subject {
                    statusRow("主体", subject.tccEntryName)
                    statusRow("主体路径", subject.hasBundleIdentity ? (subject.bundlePath ?? subject.binaryPath) : subject.binaryPath)
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

    /// 启动 1s 权限轮询：拖拽/按钮只负责导航与"让 daemon 自己申请"，是否授权
    /// 由用户在系统面板完成，UI 通过向 daemon 打 `hello` 读它自报的席位自动点亮
    /// （必备三类全部 granted 才停表；daemon 不可达不停表——见 P1 v1.2 §11.2）。
    private func startPolling() {
        stopPolling()
        let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            Task { @MainActor in
                if await model.pollPermissions() {
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
/// 点亮）。拖拽源由 `PermissionGuide.dragSource(for:)` 决定（P1 v1.2 §11.3）：
/// daemon 有 bundle 身份时提供 **daemon 真身 .app 的 fileURL**（可直接拖进系统
/// 设置权限列表，条目带可读名与图标）；裸二进制形态下只能提供纯文本导航。
struct DragGuideBannerView: View {
    @EnvironmentObject private var model: SettingsModel

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
                Text(model.dragSourceHint)
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
            switch model.dragSource {
            case .bundleURL(let bundlePath):
                return NSItemProvider(item: URL(fileURLWithPath: bundlePath) as NSURL,
                                      typeIdentifier: UTType.fileURL.identifier)
            case .plainText(let name):
                return NSItemProvider(object: name as NSString)
            }
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
            // 必备权限取不到 daemon 自报席位时按钮仍有效：点击即让 daemon 重新
            // 申请并跳转面板；开发者工具无申请接口，只跳面板。
            return entry.kind == .developerTools ? "打开系统设置" : "授权"
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
                if let statusNote = entry.statusNote {
                    // 状态来源注记：daemon 未上报席位时如实说明，不冒充已测。
                    Text(statusNote)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
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