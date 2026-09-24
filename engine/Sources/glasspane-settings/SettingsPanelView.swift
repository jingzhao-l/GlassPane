import SwiftUI
import UniformTypeIdentifiers
import GlassPaneEngine

/// 权限页（P1 spec v1.2 §6.2 的 onboarding 面，控制台默认落点）。
///
/// 布局：状态总览 → 拖拽引导条（可拖动的后台服务图标）→ 引导横幅 →
/// 权限清单逐项卡片（卡片即落点）→ 后台服务卡 → 拒绝降级形态折叠区。
///
/// 呈现纪律（与 §11.7 同源，改动时三条都不能破）：
///  1. 每张卡的前导图标仍是 `Image(systemName: iconName)`——它的符号名就是
///     P1-C6 真机冒烟用来定位卡片的无障碍标识，换符号等于换掉闸门；
///  2. 状态由"形状 + 带标识的图标"双表达，不依赖颜色（色盲可用）；
///  3. 状态真源是 daemon 自报席位，面板不代测；读不到就显示"未验证"。
struct SettingsPanelView: View {
    @EnvironmentObject private var model: SettingsModel

    /// 权限轮询定时器（1s 间隔；全部达成 granted/unverifiable 或窗口关闭即停）。
    @State private var pollTimer: Timer?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                overviewStrip
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
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear(perform: startPolling)
        .onDisappear(perform: stopPolling)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("权限")
                .font(.title2.bold())
            Text("这几项要你在系统设置里勾选。每张卡写明它的用途和缺少时的表现；状态自动检测，改动后点「刷新」。")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// 一眼能看懂的总览：还差几项、差哪几项。省掉"逐张卡看一遍"的负担。
    private var overviewStrip: some View {
        let pending = model.entries.filter { $0.kind != .developerTools && $0.status != .granted }
        return HStack(spacing: 10) {
            Image(systemName: pending.isEmpty ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .font(.title3)
                .foregroundStyle(pending.isEmpty ? Color.green : Color.orange)
            VStack(alignment: .leading, spacing: 3) {
                Text(pending.isEmpty ? "必备权限已全部授权" : "还有 \(pending.count) 项必备权限没授权")
                    .font(.callout.weight(.semibold))
                Text(pending.isEmpty
                     ? "开发者工具是可选的深度调试通道，不影响日常使用。"
                     : pending.map { $0.descriptor.displayName }.joined(separator: "、")
                     + " 缺得越多，能验证的通道越少。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(12)
        .consoleCard(tint: pending.isEmpty ? .green : .orange)
    }

    private var permissionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(
                title: "权限清单",
                subtitle: subjectLine,
                systemImage: "lock.shield"
            )
            // 授权已落但运行实例读不到（TCC 判定按进程缓存）→ 给出重启入口。
            // 不自动重启：那会中断正在进行的 act，必须由用户点。
            if !model.kindsNeedingRestart.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "arrow.triangle.2.circlepath.circle")
                        .foregroundStyle(.orange)
                    Text(model.restartHint)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("重启后台服务") { model.restartDaemon() }
                        .controlSize(.small)
                        .accessibilityIdentifier(PermissionGuide.restartDaemonIdentifier)
                        .help("立即重启后台服务（会打断正在执行的操作）")
                }
                .padding(10)
                .background(Color.orange.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            ForEach(model.entries) { entry in
                PermissionCardView(
                    entry: entry,
                    capabilityLine: capabilityLine(for: entry.kind),
                    verifiedStatus: entry.kind == .developerTools
                        ? model.developerToolsCapability?.status
                        : nil,
                    onVerifyCapability: entry.kind == .developerTools
                        ? { Task { await model.verifyDeveloperTools() } }
                        : nil,
                    capabilityBusy: model.isProbingDeveloperTools,
                    capabilityMarker: model.capabilityMarker,
                    onGuide: { kind in runGuide(for: kind) },
                    onDropApp: { kind, droppedName in
                        model.handleDrop(kind: kind, droppedName: droppedName)
                    }
                )
            }
        }
    }

    /// 开发者工具卡下方的机器探测行（其余权限卡无此项）。
    private func capabilityLine(for kind: PermissionKind) -> String? {
        guard kind == .developerTools else { return nil }
        if model.isProbingDeveloperTools {
            return "正在实测调试能力……通常约 1 分钟，首次启动调试器可能更久"
        }
        if let error = model.developerToolsProbeError { return error }
        return model.developerToolsCapability?.summaryText()
    }

    /// 授权主体一行话：daemon 自报身份（含是否 bundle 身份）+ 面板主体免责。
    private var subjectLine: String {
        guard let subject = model.daemon.subject else {
            return PermissionGuide.daemonOfflineText + "；" + PermissionGuide.panelSubjectDisclaimer
        }
        let identity = subject.hasBundleIdentity ? "已打包应用" : "未打包（系统设置列表内只显示文件名）"
        return "授权主体：\(subject.tccEntryName)（\(identity)）"
    }

    private var daemonSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                SectionHeader(title: "后台服务", systemImage: "desktopcomputer")
                Spacer()
                if model.isRefreshing {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.small)
                        Text("检测中").font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    Button {
                        model.refresh()
                    } label: {
                        Label("刷新", systemImage: "arrow.clockwise")
                    }
                    .controlSize(.small)
                    .accessibilityIdentifier(PermissionGuide.refreshIdentifier)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    StatusDotView(tone: model.daemon.reachable ? .good : .bad)
                    Text(model.daemon.reachable ? "运行中" : "未运行")
                        .font(.callout.weight(.medium))
                    if let version = model.daemon.version {
                        ChipView(text: "glasspaned \(version)", color: .secondary)
                    }
                    if let protocolVersion = model.daemon.protocolVersion {
                        ChipView(text: "协议 \(protocolVersion)", color: .secondary)
                    }
                    if let pid = model.daemon.pid {
                        ChipView(text: "PID \(pid)", color: .secondary, systemImage: "number")
                    }
                    Spacer()
                }
                PathRowView(label: "Socket", path: model.daemon.socketPath, identifierKey: "socket")
                if let subject = model.daemon.subject {
                    PathRowView(
                        label: "程序",
                        path: subject.hasBundleIdentity
                            ? (subject.bundlePath ?? subject.binaryPath)
                            : subject.binaryPath,
                        identifierKey: "binary"
                    )
                }
                if let error = model.lastRefreshError {
                    HStack(spacing: 5) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.red)
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                }
            }
            .consoleCard()
        }
    }

    private var degradationSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("不勾选会怎样").font(.headline)
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(model.entries) { entry in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.descriptor.displayName)
                                .font(.callout.weight(.medium))
                            Text("缺少时：" + entry.descriptor.degradationText)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 8)
            } label: {
                Text("每一项都写明缺少该权限时的实际表现，便于你决定勾或不勾。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(12)
            .consoleCard()
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

/// 拖拽引导条：顶部可拖动的后台服务图标 + 说明（拖 → 打开系统面板 → 授权后自动
/// 点亮）。拖拽源由 `PermissionGuide.dragSource(for:)` 决定（P1 v1.2 §11.3）：
/// daemon 有 bundle 身份时提供 **daemon 真身 .app 的 fileURL**（可直接拖进系统
/// 设置权限列表，条目带可读名与图标）；裸二进制形态下只能提供纯文本导航。
struct DragGuideBannerView: View {
    @EnvironmentObject private var model: SettingsModel

    var body: some View {
        HStack(spacing: 12) {
            dragIcon
                .help("按住并拖到此页下方的权限卡上")

            VStack(alignment: .leading, spacing: 3) {
                Text(PermissionGuide.bannerTitle)
                    .font(.callout.bold())
                Text(model.dragSourceHint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: ConsoleTheme.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: ConsoleTheme.cardRadius, style: .continuous)
                .stroke(Color.accentColor.opacity(0.30), lineWidth: 1)
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

    /// 图标用后台服务自己的真实 app 图标。此前固定用 SF Symbol "app"，
    /// 它渲染成一个空框，用户看到的就是"一个坏掉的方块要我拖"。
    private var dragIcon: some View {
        let bundlePath = model.daemon.subject?.bundlePath
        return Group {
            if let icon = AppIconLoader.icon(forPath: bundlePath) {
                Image(nsImage: icon)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else {
                Image(systemName: "app.dashed")
                    .font(.system(size: 24))
                    .foregroundStyle(Color.accentColor)
            }
        }
        .frame(width: 38, height: 38)
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.accentColor.opacity(0.12)))
    }
}

/// 引导进行中横幅：展示最近一次落点/按钮触发的引导文案与所属权限，可手动关闭。
struct GuideBannerView: View {
    let kind: PermissionKind?
    let text: String
    let onDismiss: () -> Void

    private var tint: Color {
        guard let kind else { return .accentColor }
        return PermissionTint.color(for: kind)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "arrow.forward.circle.fill")
                .foregroundStyle(tint)
            Text(text)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .help("关闭这条提示")
            .accessibilityLabel("关闭引导提示")
        }
        .padding(10)
        .background(tint.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(tint.opacity(0.25), lineWidth: 1)
        )
        .accessibilityIdentifier("gp-guide-banner")
    }
}

/// 四类权限的固定配色（横幅与卡片共用，避免两处各写一遍 switch）。
enum PermissionTint {
    static func color(for kind: PermissionKind) -> Color {
        switch kind {
        case .accessibility: return .blue
        case .inputMonitoring: return .orange
        case .screenRecording: return .purple
        case .developerTools: return .gray
        }
    }
}

/// 单权限卡片。整卡作为拖拽落点：接受 app bundle（fileURL）或纯文本
/// （顶部拖拽源），落下后交给 `onDropApp`（内部打开对应系统面板并记录引导
/// 状态）。落点悬停时高亮描边。
struct PermissionCardView: View {
    let entry: SettingsModel.PermissionEntry
    /// 机器探测行（仅开发者工具卡使用：受限 lldb 实测结论）。
    var capabilityLine: String? = nil
    /// 实测结论折算的状态（仅开发者工具卡；有值时徽标按实测状态显示）。
    var verifiedStatus: PermissionStatus? = nil
    /// 「验证调试能力」动作；nil 表示该卡不提供机器探测。
    var onVerifyCapability: (() -> Void)? = nil
    /// 探测在途：按钮禁点，避免叠加 launchd 任务。
    var capabilityBusy: Bool = false
    /// 结论行的状态标记（在途/失败阶段/已出结论；nil = 尚无标记）。
    var capabilityMarker: PermissionGuide.CapabilityMarker? = nil
    let onGuide: (PermissionKind) -> Void
    let onDropApp: (PermissionKind, String?) -> Void

    @State private var isDropTargeted = false

    /// 开发者工具卡：一旦有"验证调试能力"的实测结论，徽标改按实测状态显示
    /// （系统没有查询接口 ≠ 不能实测；实测结论必须让用户看得见，而不是永远
    /// 灰在"未验证"）。其余卡恒按 daemon 自报席位。
    private var displayStatus: PermissionStatus { verifiedStatus ?? entry.status }

    private var badgeColor: Color {
        switch displayStatus {
        case .granted:
            return .green
        case .denied:
            return .red
        case .notDetermined:
            return .secondary
        case .unverifiable:
            return .secondary
        }
    }

    private var badgeText: String {
        switch displayStatus {
        case .granted:
            return verifiedStatus != nil ? "可用（实测）" : "已授权"
        case .denied:
            return verifiedStatus != nil ? "被拒绝（实测）" : "已拒绝"
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

    /// 探测按钮标题：未探过 = 验证；已探过 = 重新验证。
    private var modelButtonTitle: String {
        // 结构体内不便取模型状态，标题以"是否已有结论行"为准。
        capabilityLine == nil ? "验证调试能力" : "重新验证"
    }

    /// 结论行是否失败态（失败阶段进 identifier，形状与颜色一致）。
    private var capabilityIsFailure: Bool {
        if case .failed = capabilityMarker { return true }
        return false
    }

    /// 结论行的形状：在途沙漏、失败告警、有结论用对应状态图标。
    private var capabilityIconName: String {
        switch capabilityMarker {
        case .pending:
            return "hourglass"
        case .failed:
            return "exclamationmark.triangle"
        case .concluded(let status):
            return PermissionGuide.statusIcon(for: status)
        case nil:
            return "circle"
        }
    }

    /// 引导按钮标题。已授权时不再显示一个"灰掉的已授权"——那既重复徽标信息，
    /// 又让人以为界面坏了；改成仍然有效的动作：跳到系统设置里那一行。
    private var buttonTitle: String {
        switch entry.status {
        case .granted:
            return "在系统设置中查看"
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
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(badgeColor)
                .frame(width: 22, height: 22)
                .padding(9)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(badgeColor.opacity(0.10))
                )

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(entry.descriptor.displayName).font(.callout.bold())
                    BadgeView(
                        text: badgeText,
                        color: badgeColor,
                        statusIcon: PermissionGuide.statusIcon(for: entry.status),
                        statusIdentifier: PermissionGuide.statusIdentifier(
                            kind: entry.kind, status: entry.status
                        )
                    )
                    if entry.statusNote != nil {
                        Image(systemName: "arrow.clockwise.circle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .accessibilityIdentifier(PermissionGuide.restartPendingIdentifier(kind: entry.kind))
                            .help("系统里已授权，重启 daemon 后生效")
                    }
                }
                Text(entry.descriptor.purposeText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("缺少时：" + entry.descriptor.degradationText)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                if let capabilityLine {
                    // 带时刻的探测结论，与实时席位分列，不互相冒充。结论旁边放一枚
                    // 带标识的图标：Text 内容不进 AXTitle（P6 §0 F6），"到底渲染成
                    // 什么"只有靠 identifier 才机器可读。
                    HStack(spacing: 4) {
                        Image(systemName: capabilityIconName)
                            .font(.caption2)
                            .foregroundStyle(capabilityIsFailure ? Color.orange : Color.secondary)
                            .accessibilityIdentifier(PermissionGuide.capabilityIdentifier(
                                capabilityMarker ?? .concluded(.unverifiable)
                            ))
                        Text(capabilityLine)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 1)
                }
                if let statusNote = entry.statusNote {
                    // 状态来源注记：daemon 未上报席位时如实说明，不冒充已测。
                    Text(statusNote)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 8)

            HStack(spacing: 6) {
                if onVerifyCapability != nil {
                    Button(modelButtonTitle) {
                        onVerifyCapability?()
                    }
                    .controlSize(.small)
                    .accessibilityIdentifier(PermissionGuide.verifyCapabilityIdentifier)
                    .disabled(capabilityBusy)
                }
                // 已授权时用次要样式，未授权时用主行动样式；两种 ButtonStyle
                // 类型不同，不能三元合并，只能分支渲染。
                Group {
                    if entry.status == .granted {
                        Button(buttonTitle) { onGuide(entry.kind) }
                            .buttonStyle(.bordered)
                    } else {
                        Button(buttonTitle) { onGuide(entry.kind) }
                            .buttonStyle(.borderedProminent)
                    }
                }
                .controlSize(.small)
                // 控件标识：按钮标题不进 AXTitle，按标题 act 选不中元素。
                .accessibilityIdentifier(PermissionGuide.guideIdentifier(for: entry.kind))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: ConsoleTheme.cardRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: ConsoleTheme.cardRadius, style: .continuous)
                .stroke(isDropTargeted ? Color.accentColor : ConsoleTheme.cardStroke,
                        lineWidth: isDropTargeted ? 2 : 1)
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

/// 状态徽标：文字 + 一枚表达状态的图标，图标带无障碍标识供自动化判读
/// （形状而非颜色承载状态，色盲可用）。三态着色 + unverifiable 灰描边。
struct BadgeView: View {
    let text: String
    let color: Color
    /// 状态图标（SF Symbol 名）；nil 时不渲染图标。
    var statusIcon: String? = nil
    /// 图标上的无障碍标识（`PermissionGuide.statusIdentifier`）。
    var statusIdentifier: String? = nil

    var body: some View {
        HStack(spacing: 3) {
            if let statusIcon {
                Image(systemName: statusIcon)
                    .font(.system(size: 9, weight: .bold))
                    .modifier(BadgeIdentifier(identifier: statusIdentifier))
            }
            Text(text)
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .foregroundStyle(color)
        .background(color.opacity(0.10))
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(color.opacity(0.55), lineWidth: 1)
        )
    }
}

/// 状态图标必须始终挂上标识（缺标识时 §11.7 的机器判读就断了），
/// 但仍要求显式给值，避免误挂到别的徽标上。
private struct BadgeIdentifier: ViewModifier {
    let identifier: String?
    func body(content: Content) -> some View {
        if let identifier {
            content.accessibilityIdentifier(identifier)
        } else {
            content
        }
    }
}
