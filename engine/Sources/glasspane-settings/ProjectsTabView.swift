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
            detailPane.frame(minWidth: 300, maxWidth: .infinity, maxHeight: .infinity)
        }
        .toolbar { toolbarContent }
        .sheet(isPresented: $model.isPruneSheetPresented) { pruneSheet }
    }

    // MARK: - 列表

    private var listPane: some View {
        VStack(spacing: 0) {
            PageTitleView(title: "项目", systemImage: "square.stack.3d.up")
            if model.testResidueCount > 0 {
                residueBanner
            }
            if model.pruneNeedsRestart {
                restartBanner
            }
            content
        }
    }

    /// 测试残留提示：说清是什么、有多少、能一键清掉。
    private var residueBanner: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "trash.circle").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(model.testResidueCount) 条注册项指向系统临时目录")
                    .font(.callout.weight(.medium))
                Text("这些是引擎自检过程留下的示例项目，不是你注册的应用。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("清理") { model.previewTestResiduePrune() }
                .controlSize(.small)
                .accessibilityIdentifier("gp-prune-projects")
        }
        .padding(10)
        .background(Color.orange.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(10)
    }

    private var restartBanner: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(.blue)
            Text("注册表已改动，重启后台服务后它才会用新表。")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button("重启后台服务") {
                settings.restartDaemon()
                model.pruneNeedsRestart = false
            }
            .controlSize(.small)
            .accessibilityIdentifier("gp-restart-after-prune")
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

                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader(title: "路径", systemImage: "folder")
                        PathRowView(label: "证据目录", path: entry.evidenceStoragePath ?? "未配置（用默认目录）")
                        PathRowView(label: "配方配置", path: entry.recipeConfigPath ?? "未配置")
                        PathRowView(label: "校准资源", path: entry.calibrationAssetsPath ?? "未配置")
                        HStack(spacing: 6) {
                            Button("在访达中打开证据目录") {
                                openInFinder(entry.evidenceStoragePath ?? EvidenceStore.defaultDirectory)
                            }
                            .controlSize(.small)
                            Button("复制项目 ID") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(entry.projectId, forType: .string)
                            }
                            .controlSize(.small)
                        }
                        .padding(.top, 2)
                    }
                    .consoleCard()
                }
                .padding(14)
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

    private func evidenceCountText(_ projectId: String) -> String {
        switch model.projectEvidenceCounts[projectId] ?? nil {
        case .none: return "证据目录不存在"
        case .some(let count): return "\(count) 条"
        }
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
                Button(model.prunePreview.isEmpty ? "知道了" : "清理 \(model.prunePreview.count) 条") {
                    model.confirmPrune()
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(model.prunePreview.isEmpty)
                .accessibilityIdentifier("gp-confirm-prune")
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
                    Text(evidenceCount.map { "\($0) 条证据" } ?? "证据目录已清理")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}
