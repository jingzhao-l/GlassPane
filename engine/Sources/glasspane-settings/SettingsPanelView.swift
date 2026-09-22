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
            Text(SettingsPanelScene.title)
                .font(.title2.bold())
            Text("这些权限需要你在系统设置里勾选。每张卡说明它的用途和缺少时的表现；状态自动检测，改动后点「刷新」。")
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
            // 需要用户动手重启的两种成因共用这一个控件：授权已落但运行实例读不到；
            // 后台服务压根没应答（这时"待重启席位"恒为空，旧实现把按钮只挂在那个
            // 集合上，结果 daemon 一死面板里连一个能自救的按钮都没有）。
            // 不自动重启：那会中断正在进行的 act，必须由用户点。
            if let attention = model.daemonAttentionText {
                HStack(alignment: .top, spacing: 8) {
                    Text(attention)
                        .font(.caption)
                        .foregroundStyle(.orange)
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
                    // 徽标措辞是否带"（实测）"：与 `entry.status` 同源，
                    // 不允许徽标与标识各读各的值。
                    badgeComesFromMeasurement: entry.kind == .developerTools
                        && model.liveDeveloperToolsReport != nil,
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
        if let report = model.liveDeveloperToolsReport { return report.summaryText() }
        if model.developerToolsCapability != nil {
            // 结论还在，但它归属的那个进程不再答话：说清楚为什么这张卡是灰的。
            return "后台服务当前没有应答：上次实测的结论不再代表现状，恢复连接后重新验证"
        }
        return nil
    }

    /// 授权主体一行话：daemon 自报身份（含是否 bundle 身份）+ 面板主体免责。
    /// 读不到身份时的三种成因各说各话——"没在跑"、"跑了但不答话"、"答了但没上报
    /// 身份"不是一回事，混成一句就是把没测到的事说成测到的。
    private var subjectLine: String {
        let disclaimer = "；" + PermissionGuide.panelSubjectDisclaimer
        if let subject = model.daemon.subject {
            let identity = subject.hasBundleIdentity ? "已打包应用" : "未打包（系统设置列表内只显示文件名）"
            return "授权主体：\(subject.tccEntryName)（\(identity)）· \(subject.binaryPath)"
        }
        switch model.daemon.liveness {
        case .running:
            // 有回音，但回音里没带身份字段（不上报这一栏的旧版本）。
            return "后台服务有回应，但它没有上报自己的授权身份：卡片只能显示未验证" + disclaimer
        case .presentButSilent:
            return "后台服务没有回应（socket 文件还在）：授权跟着进程走，此刻读不到它的席位，本卡不做代替显示" + disclaimer
        case .absent:
            return PermissionGuide.daemonOfflineText + disclaimer
        case .notMeasured:
            return "还没向后台服务打过招呼：点「刷新」读它自报的席位" + disclaimer
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
                    Button("刷新") { model.refresh() }
                        .controlSize(.small)
                        .accessibilityIdentifier(PermissionGuide.refreshIdentifier)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                statusRow("Socket", model.daemon.socketPath)
                statusRow("存活", daemonLivenessText)
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
                // 动作失败与读取失败分列两行：前者是"你要的事没办成"，
                // 后者是"我这次没读到"，共用一行会互相抹掉。
                if let error = model.lastActionError {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
            .padding(12)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    /// 存活一行：**只**由 `hello` 有没有回音决定。socket 文件存在不等于后台服务
    /// 在跑（进程被强杀后文件留在原地），所以"文件在、没人答话"单独成一态，
    /// 既不说"运行中"也不说"未运行"。没回音时上面的版本/PID/协议/主体行一并清空，
    /// 不留一个不答话进程的自报当现状。
    private var daemonLivenessText: String {
        switch model.daemon.liveness {
        case .running:
            return "运行中（刚刚回应了查询）"
        case .presentButSilent:
            return "没有回应（socket 文件还在）"
        case .absent:
            return "没有服务在监听（socket 文件不在）"
        case .notMeasured:
            return "还没测过"
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
                Text("下面的每一项都标了缺少该权限时的实际表现，便于你决定勾或不勾。")
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
    /// 定时器挂进 `.common` 模式：只挂默认模式时，拖动窗口/打开菜单期间轮询
    /// 整个停摆，用户在系统设置里勾完回来卡片不会自己变绿。
    private func startPolling() {
        stopPolling()
        let timer = Timer(timeInterval: 1, repeats: true) { _ in
            Task { @MainActor in
                if await model.pollPermissions() {
                    stopPolling()
                }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
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
    /// 机器探测行（仅开发者工具卡使用：受限 lldb 实测结论）。
    var capabilityLine: String? = nil
    /// 徽标措辞是否带"（实测）"：调用方给的必须与 `entry.status` 同源
    /// （状态本身已经由 `SettingsModel` 按实测结论折算，这里只决定说法）。
    var badgeComesFromMeasurement: Bool = false
    /// 「验证调试能力」动作；nil 表示该卡不提供机器探测。
    var onVerifyCapability: (() -> Void)? = nil
    /// 探测在途：按钮禁点，避免叠加 launchd 任务。
    var capabilityBusy: Bool = false
    /// 结论行的状态标记（在途/失败阶段/已出结论；nil = 尚无标记）。
    var capabilityMarker: PermissionGuide.CapabilityMarker? = nil
    let onGuide: (PermissionKind) -> Void
    let onDropApp: (PermissionKind, String?) -> Void

    @State private var isDropTargeted = false

    /// 卡片状态：可见徽标与机器可读标识**共用的唯一来源**。此前徽标读实测值、
    /// 标识读 `entry.status`，于是撤销授权后重新验证失败时，卡片一边挂着绿色
    /// "可用（实测）"、一边报 `gp-perm-developer-tools-unverifiable`，两面互相
    /// 冒充；实测结论现在已在模型侧折算进 `entry.status`。
    private var displayStatus: PermissionStatus { entry.status }

    private var badgeColor: Color {
        switch displayStatus {
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
        switch displayStatus {
        case .granted:
            return badgeComesFromMeasurement ? "可用（实测）" : "已授权"
        case .denied:
            return badgeComesFromMeasurement ? "被拒绝（实测）" : "已拒绝"
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

    private var buttonTitle: String {
        // 开发者工具卡的按钮只是"打开对应系统面板"的导航：实测结论不改变它要干什么。
        if entry.kind == .developerTools { return "打开系统设置" }
        switch displayStatus {
        case .granted:
            return "已授权"
        case .denied:
            return "打开系统设置"
        case .notDetermined:
            return "授权"
        case .unverifiable:
            // 必备权限取不到 daemon 自报席位时按钮仍有效：点击即让 daemon 重新
            // 申请并跳转面板。
            return "授权"
        }
    }

    /// 引导按钮何时禁用：仅"已授权、不必再跳系统面板"的三类。开发者工具即使实测
    /// 可用也保留入口——系统里的勾与"能不能调试"不是一回事，用户仍可能要回去改设置。
    private var guideButtonDisabled: Bool {
        entry.kind != .developerTools && displayStatus == .granted
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
                    // 机器核验面：observe 读到该 identifier 即证明卡片确实按此状态
                    // 渲染（形状本身表达状态，不靠颜色）。
                    Image(systemName: PermissionGuide.statusIcon(for: displayStatus))
                        .font(.caption)
                        .foregroundStyle(badgeColor)
                        .accessibilityIdentifier(
                            PermissionGuide.statusIdentifier(kind: entry.kind, status: displayStatus)
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
                    }
                }
                if let statusNote = entry.statusNote {
                    // 状态来源注记：daemon 未上报席位时如实说明，不冒充已测。
                    Text(statusNote)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }

            Spacer()

            HStack(spacing: 6) {
                if onVerifyCapability != nil {
                    Button(modelButtonTitle) {
                        onVerifyCapability?()
                    }
                    .controlSize(.small)
                    .accessibilityIdentifier(PermissionGuide.verifyCapabilityIdentifier)
                    .disabled(capabilityBusy)
                }
                Button(buttonTitle) {
                    onGuide(entry.kind)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                // 控件标识：按钮标题不进 AXTitle，按标题 act 选不中元素。
                .accessibilityIdentifier(PermissionGuide.guideIdentifier(for: entry.kind))
                .disabled(guideButtonDisabled)
            }
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