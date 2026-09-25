import SwiftUI
import GlassPaneEngine

/// 控制台根视图：左侧导航 + 右侧内容。
///
/// 信息架构上分两组：
///  - **首次使用**：权限（onboarding 是面板的原始职责，也是默认落点）；
///  - **日常审计**：证据档案 / 项目 / 审批台账——这些数据早就落盘了，
///    此前只有 daemon CLI 读得到，人没有界面可看。
///
/// 默认选中"权限"，因此 P1-C6 真机冒烟读到的仍是权限页那套结构。
struct ConsoleRootView: View {
    @EnvironmentObject private var settings: SettingsModel
    @EnvironmentObject private var console: ConsoleModel

    /// 侧栏条目。`id` 同时用作恢复选中的稳定标识。
    enum ConsoleSection: String, CaseIterable, Identifiable {
        case permissions
        case evidence
        case projects
        case approvals
        case recipes

        var id: String { rawValue }

        var title: String {
            switch self {
            case .permissions: return "权限"
            case .evidence: return "证据档案"
            case .projects: return "项目"
            case .approvals: return "审批台账"
            case .recipes: return "配方"
            }
        }

        var systemImage: String {
            switch self {
            case .permissions: return "lock.shield"
            case .evidence: return "doc.text.magnifyingglass"
            case .projects: return "square.stack.3d.up"
            case .approvals: return "checkmark.seal"
            case .recipes: return "scroll"
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
        }
        // 窗口标题的唯一落点：各页不得再设 navigationTitle，否则会把
        // "GlassPane 设置" 顶掉（P1-C6 真机冒烟按窗口标题定位面板）。
        .navigationTitle("GlassPane 设置")
        .onAppear(perform: syncFromSettings)
        .onChange(of: settings.daemon.subject?.binaryPath) { _ in syncFromSettings() }
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
            }
        }
    }

    private func syncFromSettings() {
        if console.daemonBinaryPath == nil {
            console.daemonBinaryPath = settings.daemon.subject?.binaryPath
        }
    }

    // MARK: - 侧栏

    /// 侧栏用显式按钮而不是 `List(selection:)`：SwiftUI 的侧栏行在无障碍树里
    /// 是 AXStaticText，`act` 按标识选不中也按不动——页签必须能被自动化驱动，
    /// 否则新页面就成了只有人手才能进的死角。
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 2) {
            sidebarGroupTitle("首次使用")
            ForEach(ConsoleSection.allCases) { section in
                sidebarButton(section)
            }
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
    private func badgeText(for section: ConsoleSection) -> String? {
        switch section {
        case .permissions:
            let pending = settings.entries.filter {
                $0.kind != .developerTools && $0.status != .granted
            }.count
            return pending > 0 ? "\(pending) 项待处理" : nil
        case .evidence:
            return console.summaries.isEmpty ? nil : "\(console.summaries.count)"
        case .projects:
            return console.projects.isEmpty ? nil : "\(console.projects.count)"
        case .approvals:
            let count = console.approvalReport?.records.count ?? 0
            return count == 0 ? nil : "\(count)"
        case .recipes:
            return nil
        }
    }

    /// 侧栏底部：后台服务的存活状态。面板不猜——读不到就是读不到。
    private var daemonFooter: some View {
        HStack(spacing: 7) {
            StatusDotView(tone: settings.daemon.reachable ? .good : .bad)
            VStack(alignment: .leading, spacing: 1) {
                Text(settings.daemon.reachable ? "后台服务运行中" : "后台服务未运行")
                    .font(.caption)
                if let version = settings.daemon.version {
                    Text("glasspaned \(version)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button {
                settings.refresh()
                console.refreshAll()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
            .help("重新检测权限与档案")
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
        }
    }
}
