import SwiftUI
import AppKit
import GlassPaneEngine

/// 项目注册表页（控制台「项目」页）。
///
/// 读：直接读 daemon 写的同一份 projects.json。
/// 写：一律经 daemon 一次性 CLI（`--project-prune` / `--project-remove`）——
/// 运行中的 daemon 内存里持有一份注册表，面板直接覆写会被它下一次写盘冲掉，
/// 所以面板改完必须如实提示"要重启后台服务才生效"。
struct ProjectsTabView: View {
    @EnvironmentObject private var model: ConsoleModel
    @EnvironmentObject private var settings: SettingsModel

    var body: some View {
        HSplitView {
            listPane.frame(minWidth: 250, idealWidth: 300, maxWidth: 400)
            detailPane.frame(minWidth: 300, idealWidth: 380, maxWidth: .infinity, maxHeight: .infinity)
        }
        .toolbar { toolbarContent }
        .sheet(isPresented: $model.isPruneSheetPresented) { pruneSheet }
    }

    // MARK: - 列表

    private var listPane: some View {
        VStack(spacing: 0) {
            PageTitleView(title: "项目", systemImage: "square.stack.3d.up")
            // 这一枚**永远画出来**：有没有得清只有后台服务的 --project-prune --dry-run
            // 答得出，面板本地的计数不是把它收起来的理由（读失败时那个数是 0，
            // 于是 daemon 一次都没被问过）。按不动时理由与下一步写在它自己身上。
            pruneControlRow
            if model.pruneNeedsRestart {
                restartBanner
            }
            content
        }
        // "需要重启"的提示只在实测到进程号换过之后才收起：从前点一下就清旗，
        // 于是 kickstart 失败与重启成功在屏幕上长成同一个样子。
        .onChange(of: settings.restartOutcome) { outcome in
            if SettingsModel.pruneBannerCleared(by: outcome) { model.pruneNeedsRestart = false }
        }
        // 回到这一页时补一次同一句判据：`onChange` 不会为"这一页不在屏上时发生的变化"补发，
        // 于是重启成功后再切回来，屏上会同时留着两句互相矛盾的话（E2）。
        .onAppear {
            if SettingsModel.pruneBannerCleared(by: settings.restartOutcome) { model.pruneNeedsRestart = false }
        }
    }

    /// 测试残留那一行：说清面板本地读到多少，并把「清理」递出去。
    /// 计数为 0 时它说的是"面板读到 0 条"，不是"后台服务说没有"——两个数各归各。
    private var pruneControlRow: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "trash.circle")
                .foregroundStyle(model.canPreviewTestResiduePrune ? Color.orange : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.pruneControlBanner)
                    .font(.callout.weight(.medium))
                Text(model.pruneControlHelp)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                // 在途的那一趟必须自己上屏。从前 `isRunningPrune`/`isPreparingPrunePreview`
                // 只被模型自己读过（`guard !isRunningPrune`），而那一枚 `guard` 是闸门不是
                // 读者：真删最长 20 秒里这一枚已经回到 .ready，第二次点击就是一次对着
                // 正在被改写的注册表起的 dry-run。沙漏 + 一句"哪一趟在跑"让这一步在屏幕
                // 上看得见，判据与禁用理由仍是模型那一个 `pruneControl`。
                if model.isRunningPrune || model.isPreparingPrunePreview {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.small)
                        Text(model.isRunningPrune
                             ? "后台服务正在删注册项（--project-prune），这一趟还没回话"
                             : "后台服务正在给清单（--project-prune --dry-run），这一趟还没回话")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("gp-prune-in-flight")
                    }
                }
            }
            Spacer()
            Button("清理") { model.previewTestResiduePrune() }
                .controlSize(.small)
                .disabled(!model.canPreviewTestResiduePrune)
                .help(model.pruneControlHelp)
                .accessibilityIdentifier("gp-prune-projects")
        }
        .padding(10)
        .background(Color.orange.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(10)
    }

    private var restartBanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(.blue)
                Text("注册表已改动，重启后台服务后它才会用新表。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("重启后台服务") {
                    settings.restartDaemon()
                }
                .controlSize(.small)
                .disabled(settings.isRestartInFlight)
                .help(settings.isRestartInFlight ? "上一次重启还在等后台服务回话" : "让后台服务重新加载注册表")
                .accessibilityIdentifier("gp-restart-after-prune")
            }
            // 重启的实测结论就在横幅里，收起横幅的条件由它决定：失败时横幅留着，
            // 并把下一步（核对作业 / 手动退出重开）写在同一屏上。
            if let outcome = settings.restartOutcomeText {
                Text(outcome)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("gp-restart-outcome")
            }
        }
        .padding(10)
        .background(Color.blue.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 10)
        .padding(.bottom, 4)
    }

    @ViewBuilder
    private var content: some View {
        switch model.projectsState {
        case .loading, .idle:
            ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                Text(message).font(.callout).foregroundStyle(.secondary)
                Button("重试") { model.reloadProjects() }.controlSize(.small)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
        case .loaded:
            if model.projects.isEmpty {
                EmptyStateView(
                    systemImage: "square.stack.3d.up",
                    title: "还没有注册项目",
                    message: "项目由 MCP 侧的 gp_project_set 注册，这里列出它们与各自的证据目录。"
                )
            } else {
                List(selection: selectedProjectBinding) {
                    ForEach(model.projects, id: \.projectId) { entry in
                        ProjectRowView(
                            entry: entry,
                            evidenceCount: model.projectEvidenceCounts[entry.projectId] ?? nil,
                            isResidue: LocalArchive.isTestResidue(entry)
                        )
                        .tag(entry.projectId)
                        .listRowInsets(EdgeInsets(top: 5, leading: 8, bottom: 5, trailing: 8))
                    }
                }
                .listStyle(.inset(alternatesRowBackgrounds: true))
            }
        }
    }

    private var selectedProjectBinding: Binding<String?> {
        Binding(
            get: { model.selectedProjectId },
            set: { model.selectedProjectId = $0 }
        )
    }

    // MARK: - 工具栏

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .automatic) {
            Button {
                model.reloadProjects()
            } label: {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            .help("重新读取注册表")
            .accessibilityIdentifier("gp-refresh-projects")
        }
    }

    // MARK: - 详情

    @ViewBuilder
    private var detailPane: some View {
        if let entry = currentEntry {
            ScrollView {
                VStack(alignment: .leading, spacing: ConsoleTheme.gap) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            Text(entry.displayName).font(.title3.weight(.semibold))
                            if LocalArchive.isTestResidue(entry) {
                                ChipView(text: "测试残留", color: .orange, systemImage: "trash")
                            }
                            Spacer()
                            Button(role: .destructive) {
                                model.removeProject(entry.projectId)
                            } label: {
                                Text("删除这个项目")
                            }
                            .controlSize(.small)
                            .accessibilityIdentifier("gp-remove-project")
                        }
                        DetailRowView(label: "项目 ID", value: entry.projectId)
                        DetailRowView(label: "被测应用", value: entry.bundleId ?? "按进程号挂接")
                        DetailRowView(label: "注册时间", value: ConsoleTheme.timestamp(entry.createdAt))
                        DetailRowView(
                            label: "证据条数",
                            value: evidenceCountText(entry.projectId)
                        )
                    }
                    .consoleCard()

                    PanelCard(
                        key: "project-paths",
                        title: "路径",
                        systemImage: "folder",
                        summary: pathsSummary(entry),
                        // 两个动作待在折叠按钮外面：收起一张卡不该把它的动词一起收掉。
                        accessory: AnyView(
                            HStack(spacing: 6) {
                                Button("在访达中打开证据目录") {
                                    // 注册项没写目录时，这一枚开的是**本页在读的那一份**，
                                    // 不再是家目录默认根：那个根在这台机器上可能根本没人用
                                    // （`GLASSPANE_STATE_DIR` / `--state-dir` 挪过根），
                                    // 于是它展示的是另一份档案，而屏幕上写的是这一份。
                                    openInFinder(entry.evidenceStoragePath ?? model.evidenceDirectoryPath)
                                }
                                .controlSize(.small)
                                // 按不动时它得自己说清为什么、以及下一步做什么：这一页
                                // 已经量过那个去处不在盘上，`selectFile` 对不存在的位置
                                // 什么都不做——一句"打开了"都没有，正是这一产品里的静默失效。
                                .disabled(!evidenceDirectoryEnabled(entry))
                                .help(evidenceDirectoryHelp(entry))
                                .accessibilityIdentifier("gp-open-evidence-directory")
                                Button("复制项目 ID") {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(entry.projectId, forType: .string)
                                }
                                .controlSize(.small)
                            }
                        )
                    ) {
                        PathRowView(label: "证据目录", path: entry.evidenceStoragePath ?? "未配置（这个项目自己没有档案目录）",
                                    identifierKey: "project-evidence", isPlaceholder: entry.evidenceStoragePath == nil)
                        PathRowView(label: "配方配置", path: entry.recipeConfigPath ?? "未配置",
                                    identifierKey: "project-recipe", isPlaceholder: entry.recipeConfigPath == nil)
                        PathRowView(label: "校准资源", path: entry.calibrationAssetsPath ?? "未配置",
                                    identifierKey: "project-calibration", isPlaceholder: entry.calibrationAssetsPath == nil)
                    }
                }
                .padding(14)
                // 与证据页同一条收口：不限行宽时长路径会把这一栏的理想宽度撑爆，
                // 左侧导航就会被挤出窗口。
                .frame(maxWidth: 760, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color(nsColor: .textBackgroundColor).opacity(0.35))
        } else {
            EmptyStateView(
                systemImage: "square.stack.3d.up.slash",
                title: "选择一个项目",
                message: "左侧点一个项目，这里显示它的注册信息与证据目录。"
            )
        }
    }

    private var currentEntry: ProjectEntry? {
        guard let id = model.selectedProjectId else { return nil }
        return model.projects.first { $0.projectId == id }
    }

    /// 折叠后仍要说的那一句：配了几条路径。"未配置"是事实，不是缺省值——
    /// 三条路径全空与三条都配好，收起后必须还能一眼分开。
    private func pathsSummary(_ entry: ProjectEntry) -> String {
        let set = [entry.evidenceStoragePath, entry.recipeConfigPath, entry.calibrationAssetsPath]
            .filter { ($0 ?? "").isEmpty == false }.count
        return set == 0 ? "三条路径都未配置" : "已配 \(set)／3 条路径"
    }

    private func evidenceCountText(_ projectId: String) -> String {
        ConsoleModel.evidenceCountReadout(model.projectEvidenceCounts[projectId] ?? nil)
    }

    /// 「在访达中打开证据目录」这一枚的**唯一**判据（与证据页那枚同一条口径）：
    /// 这一页量到过它要打开的那个去处，它才按得动；按不动时那句话就是理由 + 下一步。
    /// 从前它永远可用，注册项没写目录、而本页在读的那一份又被量到不在盘上时，
    /// 按下只是让 `NSWorkspace` 对着一个不存在的位置什么都不做。
    private func evidenceDirectoryControl(_ entry: ProjectEntry) -> ConsoleModel.PanelControl {
        model.projectEvidenceDirectoryControl(for: entry)
    }

    private func evidenceDirectoryEnabled(_ entry: ProjectEntry) -> Bool {
        evidenceDirectoryControl(entry).enabled
    }

    /// 那一枚说的是哪一份档案：注册项自己写过就点它，没写过就明说开的是本页在读的
    /// 那一份共用档案——那句必须写在控件上，因为这一页同时报得出"这个项目没测量"。
    private func evidenceDirectoryHelp(_ entry: ProjectEntry) -> String {
        evidenceDirectoryControl(entry).help
    }

    private func openInFinder(_ path: String) {
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    }

    // MARK: - 清理确认

    /// 删除前先摊开清单：让人看清"要删的是这 N 条"，而不是一个按钮直接抹。
    private var pruneSheet: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("确认清理测试残留项目")
                .font(.headline)
            Text(model.prunePreview.isEmpty
                 ? "没有符合测试残留判据的注册项：被测标识是示例应用，且证据目录落在系统临时目录里。"
                 : "将删除 \(model.prunePreview.count) 条注册项。只删注册表里的这一行，不动任何证据档案。")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            // 面板读到的条数与后台服务答复的清单不一致时，两个数都留在屏幕上，
            // 并说清以哪一份为准——不许悄悄用一个覆盖另一个。
            if !model.prunePreview.isEmpty, model.prunePreview.count != model.testResidueCount {
                Text("面板在这台机器上读到 \(model.testResidueCount) 条，后台服务的预览答 \(model.prunePreview.count) 条；以下这张表是后台服务自己的答复，删除也按它执行。")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("gp-prune-count-disagrees")
            }

            if !model.prunePreview.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(model.prunePreview, id: \.projectId) { entry in
                            HStack(spacing: 8) {
                                Text(entry.displayName).font(.callout.weight(.medium))
                                Text(entry.bundleId ?? "—")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text(entry.evidenceStoragePath ?? "—")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 200)
                .padding(10)
                .background(Color(nsColor: .windowBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            HStack {
                Spacer()
                Button("取消") { model.isPruneSheetPresented = false }
                    .keyboardShortcut(.cancelAction)
                // 一份可清理的都没有时，这一枚不能是一个"灰掉的破坏性动作"还写着
                // 一句收下了的话：那读起来像是已经处理过了，而其实什么都没发生。
                // 死路那一支给的是"关掉这一屏"，它按得动，也只关掉这一屏。
                if model.prunePreview.isEmpty {
                    Button("知道了") { model.isPruneSheetPresented = false }
                        .keyboardShortcut(.defaultAction)
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("gp-prune-sheet-close")
                } else {
                    Button("清理 \(model.prunePreview.count) 条") { model.confirmPrune() }
                        .keyboardShortcut(.defaultAction)
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("gp-confirm-prune")
                }
            }
        }
        .padding(18)
        .frame(width: 520)
    }
}

/// 项目列表行。
struct ProjectRowView: View {
    let entry: ProjectEntry
    let evidenceCount: Int?
    let isResidue: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: isResidue ? "shippingbox" : "square.stack.3d.up")
                .font(.callout)
                .foregroundStyle(isResidue ? Color.orange : Color.accentColor)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(entry.displayName).font(.callout.weight(.medium))
                    if isResidue {
                        ChipView(text: "残留", color: .orange)
                    }
                }
                HStack(spacing: 6) {
                    Text(entry.bundleId ?? "按进程号")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("·").font(.caption).foregroundStyle(.tertiary)
                    // 与详情那一行同一句、同一判据：从前这里的 nil 写「证据目录已清理」
                    // ——一件没有任何东西观测过的事——而详情对同一个 nil 写「不存在」。
                    Text(ConsoleModel.evidenceCountReadout(evidenceCount))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}
