import SwiftUI
import GlassPaneEngine

/// 控制台根视图：左侧导航 + 右侧内容。
///
/// 信息架构上分两组：
///  - **首次使用**：权限（onboarding 是面板的原始职责，也是默认落点）；
///  - **日常审计**：证据档案 / 项目 / 审批台账——这些数据早就落盘了，
///    此前只有 daemon CLI 读得到，人没有界面可看；
///  - **这台机器**：更新（装的版本新不新、到点没检查成、现在能不能手动来一次）。
///
/// 默认选中"权限"，因此 P1-C6 真机冒烟读到的仍是权限页那套结构。
struct ConsoleRootView: View {
    @EnvironmentObject private var settings: SettingsModel
    @EnvironmentObject private var console: ConsoleModel
    @EnvironmentObject private var updates: UpdateModel

    /// 侧栏条目。`id` 同时用作恢复选中的稳定标识。
    enum ConsoleSection: String, CaseIterable, Identifiable {
        case permissions
        case evidence
        case projects
        case approvals
        case recipes
        case updates

        var id: String { rawValue }

        var title: String {
            switch self {
            case .permissions: return "权限"
            case .evidence: return "证据档案"
            case .projects: return "项目"
            case .approvals: return "审批台账"
            case .recipes: return "配方"
            case .updates: return "更新"
            }
        }

        var systemImage: String {
            switch self {
            case .permissions: return "lock.shield"
            case .evidence: return "doc.text.magnifyingglass"
            case .projects: return "square.stack.3d.up"
            case .approvals: return "checkmark.seal"
            case .recipes: return "scroll"
            case .updates: return "arrow.triangle.2.circlepath"
            }
        }
    }

    @State private var selection: ConsoleSection? = .permissions

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 250)
        } detail: {
            detail
                .environmentObject(settings)
                .environmentObject(console)
                .environmentObject(updates)
                // 这一栏必须**自己**声明"我可以被压到 0"。不声明时它把内容的理想
                // 尺寸当作最小尺寸交给分栏：证据页实测 987×612、审批页 900×1090，
                // 而窗口只有 900×612 —— 分栏按那个尺寸排完再被窗口裁掉，
                // 症状是左侧导航整条被挤出左边界（"首次使用"只剩"使用"、图标全不见）。
                // 收在这里而不是每一页各修各的，是因为每一页的内容形状都会变。
                .frame(minWidth: 0, idealWidth: 400, maxWidth: .infinity,
                       minHeight: 0, idealHeight: 400, maxHeight: .infinity)
                .safeAreaInset(edge: .top, spacing: 0) { actionOutcomeStrip }
        }
        // 窗口标题的唯一落点：各页不得再设 navigationTitle，否则会把
        // "GlassPane 设置" 顶掉（P1-C6 真机冒烟按窗口标题定位面板）。
        .navigationTitle("GlassPane 设置")
        .onAppear { syncFromSettings(liveness: settings.daemon.liveness) }
        // 每一帧实测的 hello 都要重新对一次账：后台服务重装/重开之后自报了新的
        // 程序路径，控制台的清理/删除/校验/统计必须跟着换，否则一直在 exec 那份
        // 已经退役的二进制；"注册表改动要重启才生效"只等**实测到换个进程号**才撤——
        // 同一个进程再答一次不算重启过。
        .onChange(of: settings.daemon.liveness) { liveness in
            syncFromSettings(liveness: liveness)
        }
        // 状态根换一个 daemon 就能在**同一档 liveness** 下变（重装后仍"运行中"，只是
        // --state-dir 指到别处）。只挂 liveness 会漏掉这一帧，于是这一页继续按旧根读、
        // 旧根写——正是这条缺陷的形状。
        .onChange(of: settings.daemon.stateRoot) { _ in
            syncFromSettings(liveness: settings.daemon.liveness)
        }
        // 进程号换过一个 daemon 也能在**同一档 liveness 与同一个根**下发生（重启快、
        // 轮询没抓到空隙）。这一页收起「注册表已改动，重启后才会用新表」那句的依据就是
        // 这一个实测，所以它自己也必须是一个采纳点——只挂 liveness/根会把"量到新进程"
        // 这一帧漏掉，那句话就永远挂着一个已经完成的补救。
        .onChange(of: settings.daemon.pid) { _ in
            syncFromSettings(liveness: settings.daemon.liveness)
        }
        .onChange(of: selection) { section in
            // 进某一页时按需重读该页数据：档案是外部进程随时会写的，
            // 但也不该在用户没看的时候反复扫盘。
            guard let section else { return }
            switch section {
            case .permissions: break
            case .evidence: console.reloadEvidence()
            case .projects: console.reloadProjects()
            case .approvals: console.reloadApprovals()
            case .recipes: break
            // 更新状态是更新器写在盘上的，进这一页时重读一次（不联网）。
            case .updates: updates.refresh()
            }
        }
    }

    private func syncFromSettings(liveness: SettingsModel.DaemonLiveness) {
        let answered = liveness == .answering
        console.adoptDaemonReport(
            binaryPath: settings.daemon.subject?.binaryPath,
            daemonStateRoot: settings.daemon.stateRoot,
            reportedPid: settings.daemon.pid,
            answered: answered
        )
        // 更新页也要跟着同一帧实测走：它的指针与根证书束都落在状态根下，从前这一页
        // 只按 `GLASSPANE_STATE_DIR`/家目录自己算一个根，于是 daemon 带着 `--state-dir`
        // 起时，「自动更新」的开关写的是**默认家目录那一份真状态**，而屏幕上写的是沙箱
        // （`ConsoleModel.swift:148-152` 把这个形状记成它修掉的 P1——只修了自己一页
        // 就是半修）。
        updates.adoptDaemonReport(daemonStateRoot: settings.daemon.stateRoot, answered: answered)
    }

    // MARK: - 动作结论

    /// 上一次动作的结论挂在页签之外：清理、删除、导出报告都从这一行说话。
    /// 它存在的原因是一次静默失效——`ConsoleModel.lastActionMessage` 把每种结果
    /// 都算好了，却没有任何视图读它，于是"确认清理"点下去只是关掉确认表。
    /// 图标取中性：这一行既装"删了 3 条"也装"没删成"，按文案猜成败等于把判定
    /// 交给字符串匹配。
    @ViewBuilder
    private var actionOutcomeStrip: some View {
        if let message = console.lastActionMessage {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "info.circle").foregroundStyle(.secondary)
                Text(message)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
                Button("关闭") { console.dismissActionMessage() }
                    .controlSize(.small)
                    .accessibilityIdentifier("gp-dismiss-action-message")
            }
            .padding(10)
            .background(Color(nsColor: .windowBackgroundColor))
            .accessibilityIdentifier("gp-action-message")
        }
    }

    // MARK: - 侧栏

    /// 侧栏用显式按钮而不是 `List(selection:)`：SwiftUI 的侧栏行在无障碍树里
    /// 是 AXStaticText，`act` 按标识选不中也按不动——页签必须能被自动化驱动，
    /// 否则新页面就成了只有人手才能进的死角。
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 2) {
            sidebarGroupTitle("首次使用")
            ForEach(ConsoleSection.allCases.filter { $0 != .updates }) { section in
                sidebarButton(section)
            }
            sidebarGroupTitle("这台机器")
            sidebarButton(.updates)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
        .safeAreaInset(edge: .bottom) { daemonFooter }
    }

    private func sidebarGroupTitle(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.top, 10)
            .padding(.bottom, 3)
    }

    private func sidebarButton(_ section: ConsoleSection) -> some View {
        let isSelected = (selection ?? .permissions) == section
        return Button {
            selection = section
        } label: {
            HStack(spacing: 8) {
                Image(systemName: section.systemImage)
                    .font(.callout)
                    .frame(width: 16)
                Text(section.title)
                    .font(.callout.weight(isSelected ? .semibold : .regular))
                Spacer(minLength: 4)
                if let badge = badgeText(for: section) {
                    Text(badge)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isSelected ? Color.accentColor.opacity(0.16) : Color.clear)
        )
        .accessibilityIdentifier("gp-nav-\(section.rawValue)")
    }

    /// 侧栏上的待处理标记：权限没齐就在"权限"那一行给出数字，
    /// 让人不用点进去也知道该去哪儿。
    ///
    /// 数字只能来自读到过的自报席位。第一帧 hello 之前四张卡全是 `unverifiable`，
    /// 那一支从前在这里数成「3 项待处理」——对一台从没问过的机器报一次 TCC 结论，
    /// 与同一屏页脚那句"还没实测过"当面打脸。判据收在 `SettingsModel`，与权限页
    /// 顶部总览共用同一份（两处各数一遍正是这类分歧的由来）。
    private func badgeText(for section: ConsoleSection) -> String? {
        switch section {
        case .permissions:
            return SettingsModel.sidebarPermissionBadge(entries: settings.entries)
        case .evidence:
            return console.summaries.isEmpty ? nil : "\(console.summaries.count)"
        case .projects:
            return console.projects.isEmpty ? nil : "\(console.projects.count)"
        case .approvals:
            let count = console.approvalReport?.records.count ?? 0
            return count == 0 ? nil : "\(count)"
        case .recipes:
            return nil
        case .updates:
            // 有版本等着装、或到点没检查成，才在侧栏上给标记。
            return updates.offersUpdate ? "待更新" : nil
        }
    }

    /// 侧栏底部：后台服务的**实测**存活结局（一次 hello 握手）。面板不猜——
    /// 没实测过就说没实测过，应门不回话就说应门不回话。
    private var daemonFooter: some View {
        HStack(spacing: 7) {
            StatusDotView(tone: settings.daemonTone)
            VStack(alignment: .leading, spacing: 1) {
                Text(settings.daemonFooterCaption)
                    .font(.caption)
                    .accessibilityIdentifier(settings.daemonLivenessIdentifier)
                if let version = settings.daemon.version {
                    Text("glasspaned \(version)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(settings.daemonStateRootCaption)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("gp-daemon-state-root")
                } else if case .presentButSilent = settings.daemon.liveness {
                    Text(SettingsModel.silentDaemonReportNote)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
                // 拒掉的那一条必须与"程序路径"那一行同屏说出来：`adoptDaemonReport` 拒了一个
                // 不合规格的自报路径后，`daemonBinaryPath` 保持原值（常常是 nil），页面上
                // 只剩"没问"——而事实是"有人报了一个不能信的路径、这一侧拒了"。两句都是
                // 事实，只印前一句就是替后一句遮掉。措辞与提交那条腿同源（`SettingsModel`
                // 的「不能被提交：它不是这个账号拥有的普通文件——<路径>」）。
                if console.refusedDaemonBinaryPath != nil {
                    Text(console.refusedDaemonBinaryPathCaption)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("gp-daemon-refused-binary")
                }
            }
            Spacer()
            Button {
                settings.refresh()
                console.refreshAll()
                updates.refresh()
            } label: {
                // 实测 9×10pt：整页唯一的"全部重测"入口，却小到点不中。
                Image(systemName: "arrow.clockwise")
                    .font(.caption)
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .help("重新检测权限、档案与更新状态")
            // 标识与权限页里的「刷新」分开：同一个 identifier 出现在两处，
            // 自动化按标识 act 时会选不中唯一元素。
            .accessibilityIdentifier("gp-refresh-all")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(.bar)
    }

    // MARK: - 内容

    @ViewBuilder
    private var detail: some View {
        switch selection ?? .permissions {
        case .permissions:
            SettingsPanelView()
        case .evidence:
            EvidenceTabView()
        case .projects:
            ProjectsTabView()
        case .approvals:
            ApprovalsTabView()
        case .recipes:
            RecipesTabView()
        case .updates:
            UpdateTabView()
        }
    }
}
