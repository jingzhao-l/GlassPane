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
                        // 走模型那一个出口：它同时把"这一次引导"作废，迟到的提交
                        // 结局才不会把一条刚被关掉的横幅再画回来。
                        model.dismissPendingGuide()
                    }
                }
                permissionSection
                daemonSection
                degradationSection
            }
            .panelColumn()
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
    ///
    /// 判据来自 `SettingsModel.PermissionOverview`（与侧栏标记同一份），这里只负责画：
    /// 一条自报席位都没读到的时候，这一行说"还没上报"，不报数也不报"没授权"——
    /// 那样的一句是对本机 TCC 的一次没测过的断言，而它下面四张卡自己写着"读不到"。
    private var overviewStrip: some View {
        let overview = model.permissionOverview
        let color: Color?
        switch overview.tone {
        case .unmeasured: color = nil
        case .granted: color = .green
        case .pending: color = .orange
        }
        return HStack(spacing: 10) {
            Image(systemName: overview.icon)
                .font(.title3)
                .foregroundStyle(color ?? Color.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(overview.headline)
                    .font(.callout.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(overview.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(12)
        .consoleCard(tint: color)
        .accessibilityIdentifier(Self.overviewStripIdentifier(for: overview))
    }

    /// 总览那一行的机器可读出口：三种结局各一个标识，自动化才读得出
    /// "此刻屏幕上说的到底是哪一种"，而不是靠中文文案猜。
    nonisolated static func overviewStripIdentifier(
        for overview: SettingsModel.PermissionOverview
    ) -> String {
        switch overview {
        case .awaitingDaemonReport: return "gp-permission-overview-awaiting-report"
        case .allGranted: return "gp-permission-overview-all-granted"
        case .measured: return "gp-permission-overview-pending"
        }
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
            //
            // 显示条件不是 `kindsNeedingRestart`：按下那一枚按钮的那一刻 `reprobed`
            // 就被清空（重启之后不许再信旧的重探），那张表于是变空，而按钮与
            // `gp-permission-restart-outcome` 这一行都长在它里面——用同一个条件就等于
            // 这一次点击把自己的读数从屏幕上抹掉。横幅改由"在途 or 已有结论 or
            // 确实有待重启的权限"三者任一撑着（判据在 `SettingsModel.showsRestartBanner`）。
            if model.showsRestartBanner {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "arrow.triangle.2.circlepath.circle")
                            .foregroundStyle(.orange)
                        Text(model.restartHint)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button("重启后台服务") { model.restartDaemon() }
                            .controlSize(.small)
                            .disabled(model.isRestartInFlight)
                            .accessibilityIdentifier(PermissionGuide.restartDaemonIdentifier)
                            .help(model.isRestartInFlight
                                ? "上一次重启还在等后台服务回话"
                                : "立即重启后台服务（会打断正在执行的操作）")
                    }
                    // 实测结论：换过进程号才算重启成，读不到就留在屏幕上说读不到。
                    if let outcome = model.restartOutcomeText {
                        Text(outcome)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("gp-permission-restart-outcome")
                    }
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
        PanelCard(
            key: "permissions-daemon",
            title: "后台服务",
            systemImage: "desktopcomputer",
            summary: SettingsModel.daemonSummaryLine(model.daemon),
            // 刷新必须待在折叠按钮外面：一张收起来的卡如果连"重新测一次"都收进去了，
            // 收起就等于停用了这一页唯一的主动作。
            accessory: AnyView(
                HStack(spacing: 5) {
                    if model.isRefreshing {
                        ProgressView().controlSize(.small)
                        Text("检测中").font(.caption).foregroundStyle(.secondary)
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
            )
        ) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    StatusDotView(tone: model.daemonTone)
                    Text(model.daemonCaption)
                        .font(.callout.weight(.medium))
                        .accessibilityIdentifier(model.daemonLivenessIdentifier)
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
                // "有人应门但没回话"是第三种实测结局，不是"运行中"的另一种写法：
                // 这一支必须自己说清下一步做什么，否则用户只能对着橙色点猜。
                if case .presentButSilent(let reason) = model.daemon.liveness {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(SettingsModel.silentDaemonReportNote + "：先点「刷新」再实测一次；"
                             + "一直如此说明占着这个名字的进程已经不应门了，需要手动把它结束掉。")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("实测到的原因：\(reason)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("gp-daemon-silent-reason")
                    }
                }
                PathRowView(label: "Socket", path: model.daemon.socketPath, identifierKey: "socket")
                // 那一行印的是一个路径，而"这一个路径是谁点名的"才是操作者判断
                // 「我连的是不是我要看的那一个实例」需要的信息：daemon 用自己的
                // `--state-dir` 起时，屏幕上"后台服务"与"状态根"必须说得出出处，
                // 否则两行并排而看不出它们不是同一个实例（与项目页那行同一条口径）。
                Text(model.daemonSocketOriginCaption)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("gp-daemon-socket-origin")
                if let subject = model.daemon.subject {
                    PathRowView(
                        label: "程序",
                        path: subject.hasBundleIdentity
                            ? (subject.bundlePath ?? subject.binaryPath)
                            : subject.binaryPath,
                        identifierKey: "binary"
                    )
                }
                // 这里原来还有一行红的"刷新失败"：它读的是 `lastRefreshError`，而那个
                // 状态只被赋过 nil，所以这一行永远画不出来。上面那一枚点与它下面那句
                // 「应门不回话」已经把"这一次没测到"说完了，两处说法留一个（见
                // `QoderPanel20261019ControlHonestyTests.testTheErrorRowThatCouldNeverLightIsGone`）。
            }
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
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
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

    /// 徽标一次算全：文字、形状图标、无障碍标识必须来自**同一个** status。
    /// 这一枚说的是 daemon 在 `hello` 里自报的席位——每张卡恒画它，其余卡也只有它。
    /// 从前文字跟着实测状态走、图标与标识跟着自报席位走，于是一张卡说了两件事。
    private var badge: PermissionBadge {
        PermissionBadge.make(kind: entry.kind, reported: entry.status)
    }

    /// 只有开发者工具卡会有第二枚：那一次「验证调试能力」是**另一个进程**量到的
    /// （`glasspaned --check-developer-tools` 的一过性任务）。它必须留在屏幕上——
    /// 系统没有查询接口 ≠ 不能实测，实测结论不该永远灰在"未验证"里——但它讲的
    /// 不是 daemon 的席位，所以走自己那一族标识（`PermissionBadge.measuredIdentifier`），
    /// 与上面那一枚并排各说各话，谁也不替谁背书。
    private var measuredBadge: PermissionBadge? {
        guard let verifiedStatus else { return nil }
        return PermissionBadge.make(
            kind: entry.kind, reported: entry.status, measured: verifiedStatus
        )
    }

    /// 一枚徽标的颜色只由它自己那个 status 折算（形状与颜色一致，色盲可用）。
    private func badgeColor(for status: PermissionStatus) -> Color {
        switch status {
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

    private var badgeColor: Color { badgeColor(for: badge.status) }

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
                        text: badge.text,
                        color: badgeColor,
                        statusIcon: badge.icon,
                        statusIdentifier: badge.identifier
                    )
                    // 实测那一枚与自报席位并排，不覆盖它：两张卡说的是两个来源，
                    // 合并成一枚就必然有一件事实没有出口。
                    if let measuredBadge {
                        BadgeView(
                            text: measuredBadge.text,
                            color: badgeColor(for: measuredBadge.status),
                            statusIcon: measuredBadge.icon,
                            statusIdentifier: measuredBadge.identifier
                        )
                    }
                    if entry.statusNote != nil {
                        Image(systemName: "arrow.clockwise.circle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .accessibilityIdentifier(PermissionGuide.restartPendingIdentifier(kind: entry.kind))
                            .help("系统里已授权，重启 daemon 后生效")
                    }
                }
                PermissionExplain(
                    kind: entry.kind,
                    purpose: entry.descriptor.purposeText,
                    degradation: entry.descriptor.degradationText
                )
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

/// 权限卡里那两行说明（用途 + 缺了会怎样），可以收起来。
///
/// 权限页是面板的默认落点，四张卡各摊两到三行说明，一屏装不下真正要看的东西。
/// 这里刻意**只**收这两行：徽标、状态注记、实测结论行与那两个按钮都留在卡面上——
/// 收起说明不该顺手把状态或动作也收掉，而 `Image(systemName: iconName)` 是
/// P1-C6 真机冒烟定位卡片用的无障碍标识，动它就动了一条不许回退的闸门。
///
/// 默认展开：这一页的原文案是给人做"勾或不勾"决定用的，不该由一次改版悄悄藏起来。
private struct PermissionExplain: View {
    let kind: PermissionKind
    let purpose: String
    let degradation: String
    @AppStorage private var collapsed: Bool

    init(kind: PermissionKind, purpose: String, degradation: String) {
        self.kind = kind
        self.purpose = purpose
        self.degradation = degradation
        // 键走 daemon CLI 与面板共用的那份 `cliValue`（ASCII、kebab-case）：
        // 标识里放中文自动化按不动，而拿枚举名自己拼一套又会与 CLI 字面量漂移。
        self._collapsed = AppStorage(wrappedValue: false, "glasspane.card.perm-\(kind.cliValue).explainer")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Button {
                collapsed.toggle()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: collapsed ? "plus.circle" : "minus.circle")
                        .font(.caption2)
                    Text(collapsed ? "这项是干什么的、缺了会怎样" : "收起说明")
                        .font(.caption2)
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("gp-perm-explainer-\(kind.cliValue)")
            if !collapsed {
                Text(purpose)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("缺少时：" + degradation)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
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

/// 一枚权限徽标的全部表达，一次算全。
///
/// 三件东西（给人读的文字、表达形状的图标、给自动化读的标识）必须由**同一个**
/// 状态折算出来：从前文字读实测结论、图标与标识读 daemon 自报席位，人看到的
/// "可用（实测）"与冒烟脚本读到的 `gp-perm-developer-tools-unverifiable`
/// 是同一张卡上的两个答案——按标识判读的那一方会以为这张卡什么都没说。
///
/// 但"同一个状态"不等于"同一个标识"。开发者工具这一张按设计恒为未验证
/// （`engine/smoke.md` 记的就是这一条：系统不提供查询接口），而「验证调试能力」
/// 那一次是**另一个进程**量的——`glasspaned --check-developer-tools` 起的一过性
/// 任务（`main.swift` 里那条命令自己）。把它的读数挂进
/// `gp-perm-developer-tools-<state>` 那一族标识，C6 冒烟就会把"某个一次性任务能
/// 附加调试器"读成"daemon 自己有这个席位"，而那张卡真正的自报席位还在下面那一枚
/// `unverifiable` 上。所以实测结论保留它自己的文字与形状，标识走
/// `measuredIdentifier`——一眼看得出它是量过的，也绝不会与 daemon 自报那一族混读。
struct PermissionBadge: Equatable {
    let status: PermissionStatus
    let text: String
    let icon: String
    let identifier: String

    /// 这一枚徽标说的是 daemon 自报的席位，还是另一个进程的一次性实测。
    let source: BadgeSource

    enum BadgeSource: Equatable {
        /// daemon 在 `hello` 里自报的席位（`gp-perm-<kind>-<state>` 那一族）。
        case daemonReported
        /// 面板起的一过性实测（`glasspaned --check-developer-tools`）。
        case oneShotMeasurement
    }

    /// 实测结论专用的标识：与自报席位那一族**形状不同**，自动化才不会拿它去判
    /// daemon 的席位（C6 的 `gp-perm-<kind>-(granted|denied|notDetermined|unverifiable)`
    /// 恰好一枚的闸就是靠这个形状数的）。
    static func measuredIdentifier(
        kind: PermissionKind, status: PermissionStatus
    ) -> String {
        "gp-perm-\(kind.cliValue)-measured-\(status.rawValue)"
    }

    static func make(
        kind: PermissionKind,
        reported: PermissionStatus,
        measured: PermissionStatus? = nil
    ) -> PermissionBadge {
        let status = measured ?? reported
        let measuredText: Bool = measured != nil
        let text: String
        switch status {
        case .granted: text = measuredText ? "可用（后台服务实测）" : "已授权"
        case .denied: text = measuredText ? "被拒绝（后台服务实测）" : "已拒绝"
        case .notDetermined: text = "未请求"
        case .unverifiable: text = "未验证"
        }
        return PermissionBadge(
            status: status,
            text: text,
            icon: PermissionGuide.statusIcon(for: status),
            identifier: measuredText
                ? measuredIdentifier(kind: kind, status: status)
                : PermissionGuide.statusIdentifier(kind: kind, status: status),
            source: measuredText ? .oneShotMeasurement : .daemonReported
        )
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
