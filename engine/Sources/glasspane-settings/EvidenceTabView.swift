import SwiftUI
import AppKit
import GlassPaneEngine

/// 证据档案浏览器（控制台「证据」页）。
///
/// 数据来自磁盘上已落盘的档案（P1 v1.5），面板只读不写：列表用摘要，
/// 详情按需解码整包。三件事必须如实区分——档案目录不存在、目录在但是空的、
/// 有文件解不开。
struct EvidenceTabView: View {
    @EnvironmentObject private var model: ConsoleModel

    var body: some View {
        HSplitView {
            listPane
                .frame(minWidth: 250, idealWidth: 300, maxWidth: 420)
            detailPane
                .frame(minWidth: 300, maxWidth: .infinity, maxHeight: .infinity)
        }
        .toolbar { toolbarContent }
    }

    // MARK: - 列表

    private var listPane: some View {
        VStack(spacing: 0) {
            PageTitleView(title: "证据档案", systemImage: "doc.text.magnifyingglass")
            filterBar
            EvidenceStatsView()
            Divider()
            content
        }
    }

    private var filterBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Menu {
                    Picker("筛选", selection: $model.filter) {
                        ForEach(EvidenceFilter.allCases) { option in
                            Text(option.title).tag(option)
                        }
                    }
                    .pickerStyle(.inline)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "line.3.horizontal.decrease.circle")
                        Text(model.filter.title).font(.callout)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.primary.opacity(0.06), in: Capsule())
                }
                .menuStyle(.borderlessButton)
                .fixedSize()

                Spacer()

                Text(summaryLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            TextField("搜索 operationId 或控件标题", text: $model.searchText)
                .textFieldStyle(.roundedBorder)
                .font(.callout)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private func clearFilters() {
        model.filter = .all
        model.searchText = ""
    }

    private var summaryLine: String {
        if !model.unreadableFiles.isEmpty {
            return "\(model.summaries.count) 条 · \(model.unreadableFiles.count) 个文件读不开"
        }
        return "\(model.summaries.count) 条 · \(ConsoleTheme.bytes(model.archiveTotalBytes))"
    }

    @ViewBuilder
    private var content: some View {
        switch model.evidenceState {
        case .loading, .idle:
            VStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("正在读取档案……").font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                title: "档案读不了",
                message: message,
                actionTitle: "重试",
                action: { model.reloadEvidence() }
            )
        case .loaded:
            if !model.archiveExists {
                EmptyStateView(
                    systemImage: "tray",
                    title: "还没有证据档案",
                    message: "每次操作确认后都会在这里留下一条可回放的档案。档案目录：\(model.evidenceDirectoryPath)",
                    actionTitle: "重新检查",
                    action: { model.reloadEvidence() }
                )
            } else if model.filteredSummaries.isEmpty {
                EmptyStateView(
                    systemImage: "magnifyingglass",
                    title: "没有符合条件的记录",
                    message: model.summaries.isEmpty
                        ? "档案目录是空的。"
                        : "共 \(model.summaries.count) 条记录，换一个筛选或搜索词试试。",
                    actionTitle: model.summaries.isEmpty ? nil : "清除筛选",
                    action: { self.clearFilters() }
                )
            } else {
                List(selection: selectedIds) {
                    ForEach(model.filteredSummaries) { summary in
                        EvidenceRowView(summary: summary)
                            .tag(summary.operationId)
                            .listRowInsets(EdgeInsets(top: 5, leading: 8, bottom: 5, trailing: 8))
                            .listRowSeparator(.hidden)
                    }
                }
                .listStyle(.inset(alternatesRowBackgrounds: true))
                .background(Color.clear)
            }
        }
    }

    /// List 的单选自绑定（选中即回写模型，模型是详情的唯一驱动源）。
    private var selectedIds: Binding<Set<String>> {
        Binding(
            get: { Set(model.selectedOperationId.map { [$0] } ?? []) },
            set: { model.select(operationId: $0.first) }
        )
    }

    // MARK: - 工具栏

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .automatic) {
            Button {
                model.reloadEvidence()
            } label: {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            .help("重新扫描档案目录")
            .accessibilityIdentifier("gp-refresh-evidence")
            .disabled(model.evidenceState == .loading)

            Button {
                revealInFinder()
            } label: {
                Label("档案目录", systemImage: "folder")
            }
            .help("在访达中打开 \(model.evidenceDirectoryPath)")
            .disabled(!model.archiveExists)
        }
    }

    private func revealInFinder() {
        NSWorkspace.shared.selectFile(
            nil, inFileViewerRootedAtPath: model.evidenceDirectoryPath
        )
    }

    // MARK: - 详情

    @ViewBuilder
    private var detailPane: some View {
        if let summary = currentSummary {
            ScrollView {
                VStack(alignment: .leading, spacing: ConsoleTheme.gap) {
                    EvidenceDetailView(summary: summary, pack: model.selectedPack)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color(nsColor: .textBackgroundColor).opacity(0.35))
        } else {
            EmptyStateView(
                systemImage: "doc.viewfinder",
                title: "选择一条记录",
                message: "左侧列表里点一条证据，这里会展开它的完整信号链。"
            )
        }
    }

    private var currentSummary: EvidenceSummary? {
        guard let id = model.selectedOperationId else { return nil }
        return model.summaries.first { $0.operationId == id }
    }
}

/// 列表行：时间 + 操作 + 结论标签。状态由文字与图标共同表达，不只靠颜色。
struct EvidenceRowView: View {
    let summary: EvidenceSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text(ConsoleTheme.timestamp(summary.createdAt))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .fixedSize()
                Spacer(minLength: 4)
                if summary.isLegacySchema {
                    ChipView(text: "旧版格式", color: .secondary, systemImage: "clock.arrow.circlepath")
                }
                if !summary.actConfirmed {
                    ChipView(text: "未确认", color: .red, systemImage: "xmark")
                }
            }
            HStack(spacing: 6) {
                Text(actionLabel)
                    .font(.callout.weight(.medium))
                    .fixedSize()
                Text(targetText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            HStack(spacing: 5) {
                if summary.contaminated {
                    ChipView(text: "有人同时操作", color: .orange, systemImage: "hand.raised")
                }
                if summary.circuitBreakerLevel > 0 {
                    ChipView(
                        text: "降级 \(summary.circuitBreakerLevel)",
                        color: summary.circuitBreakerLevel >= 3 ? .red : .orange,
                        systemImage: "gauge.with.dots.needle.bottom.verylow"
                    )
                }
                if let cls = summary.diagnosisClass {
                    ChipView(text: "诊断 \(cls)", color: .purple, systemImage: "stethoscope")
                }
                if summary.assertionPassed == false {
                    ChipView(text: "断言未过", color: .red, systemImage: "exclamationmark.circle")
                }
                if let ratio = summary.pixelRatio {
                    ChipView(
                        text: "画面 \(String(format: "%.2f%%", ratio * 100))",
                        color: ratio > 0 ? .blue : .secondary,
                        systemImage: "photo"
                    )
                }
            }
        }
        .padding(.vertical, 3)
        .lineLimit(1)
        .contentShape(Rectangle())
    }

    private var actionLabel: String {
        EvidenceCopy.action(summary.action)
    }

    private var targetText: String {
        if let title = summary.selectorTitle, !title.isEmpty { return title }
        return summary.selectorRole
    }
}

/// 详情页：一条证据能证明什么，就完整摊开什么；未测量的通道明说"未测量"。
struct EvidenceDetailView: View {
    let summary: EvidenceSummary
    let pack: EvidencePack?

    var body: some View {
        header
        if let pack {
            actSection(pack)
            structureSection(pack)
            pixelSection(pack)
            attributionSection(pack)
            if pack.circuitBreaker.level.rawValue > 0 || pack.circuitBreaker.reason != nil {
                breakerSection(pack)
            }
            if let assertion = pack.assertion { assertionSection(assertion) }
            if let diagnosis = pack.diagnosis { diagnosisSection(diagnosis) }
            if let stateDiff = pack.signals.stateDiff {
                stateSection(stateDiff)
            } else if let reason = PanelChannelFields.reason(for: "stateDiff") {
                unmeasuredCard(title: "内部状态", systemImage: "number.square", reason: reason)
            }
            if let crash = pack.signals.crash {
                aliveSection(crash)
            } else if let reason = PanelChannelFields.reason(for: "crash") {
                unmeasuredCard(title: "进程存活", systemImage: "heart.circle", reason: reason)
            }
            if let probe = pack.signals.handlerProbe {
                probeSection(probe)
            } else if let reason = PanelChannelFields.reason(for: "handlerProbe") {
                unmeasuredCard(title: "探针命中", systemImage: "antenna.radiowaves.left.and.right", reason: reason)
            }
            if let responsiveness = pack.signals.responsiveness {
                responsivenessSection(responsiveness)
            } else if let reason = PanelChannelFields.reason(for: "responsiveness") {
                unmeasuredCard(title: "响应性", systemImage: "gauge.with.dots.needle.50percent", reason: reason)
            }
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("正在读取这条档案……").font(.callout).foregroundStyle(.secondary)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .consoleCard()
        }
    }

    // MARK: 头部

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: verdictIcon)
                    .font(.title2)
                    .foregroundStyle(verdictColor)
                    .frame(width: 30)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verdictTitle)
                        .font(.title3.weight(.semibold))
                    Text(verdictLine)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                actionButtons
            }
            HStack(spacing: 6) {
                ChipView(
                    text: "已测量通道 \(measuredChannels)／\(totalChannels)",
                    color: .secondary,
                    systemImage: "checklist"
                )
                ChipView(text: summary.schemaVersion, color: summary.isLegacySchema ? .orange : .secondary)
                ChipView(text: ConsoleTheme.bytes(summary.fileBytes), color: .secondary)
            }
        }
        .consoleCard()
    }

    private var actionButtons: some View {
        HStack(spacing: 6) {
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(summary.operationId, forType: .string)
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .help("复制 operationId")
            .accessibilityIdentifier("gp-copy-operation-id")

            Button {
                revealFile()
            } label: {
                Image(systemName: "folder")
            }
            .help("在访达中显示这个档案")

            Button {
                openHTMLReport()
            } label: {
                Image(systemName: "doc.richtext")
            }
            .help("用浏览器打开这条证据的报告")
            .disabled(pack == nil)
            .accessibilityIdentifier("gp-open-evidence-report")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private var verdictTitle: String {
        if !summary.actConfirmed { return "操作未确认" }
        if summary.contaminated { return "已确认，但期间有人操作" }
        return "操作已确认"
    }

    private var verdictColor: Color {
        if !summary.actConfirmed { return .red }
        if summary.contaminated { return .orange }
        if summary.circuitBreakerLevel >= 3 { return .red }
        if summary.circuitBreakerLevel > 0 { return .orange }
        return .green
    }

    private var verdictIcon: String {
        if !summary.actConfirmed { return "xmark.circle.fill" }
        if summary.contaminated { return "exclamationmark.triangle.fill" }
        return "checkmark.seal.fill"
    }

    /// 一句话结论：把"测到了什么"说全，没测的通道明说没测。
    private var verdictLine: String {
        var parts: [String] = []
        parts.append("\(EvidenceCopy.action(summary.action)) \(summary.selectorTitle ?? summary.selectorRole)")
        parts.append(summary.axChanged == true ? "界面结构有变化"
            : (summary.axChanged == false ? "界面结构未见变化" : "结构通道未测量"))
        if let ratio = summary.pixelRatio {
            parts.append(ratio > 0
                ? "画面变化 \(String(format: "%.2f%%", ratio * 100))"
                : "画面未见变化")
        } else {
            parts.append("画面通道未测量")
        }
        parts.append("归因 \(EvidenceCopy.attribution(summary.attributionLevel))")
        return parts.joined(separator: " · ")
    }

    /// 分母是详情页**真的渲染的六条可选通道**，不是摘要里那三个数值字段。
    /// 以前写死 3（只数界面结构／像素／内部状态），于是探针、响应性、进程存活全缺席时
    /// 也能显示"已测量通道 3／3"——把"没测到"算进"测完了"，正是这张卡片要说出的事。
    /// 判定复用 `PanelChannelFields`（纯函数、有单测），视图不再自己数。
    private var measuredChannels: Int {
        if let pack { return PanelChannelFields.measuredCount(in: pack.signals) }
        return [summary.axChanged != nil, summary.pixelRatio != nil, summary.stateChanged != nil]
            .filter { $0 }.count
    }

    private var totalChannels: Int { PanelChannelFields.totalCount }

    // MARK: 各通道

    private func actSection(_ pack: EvidencePack) -> some View {
        DetailCard(title: "操作", systemImage: "cursorarrow.click") {
            DetailRowView(label: "动作", value: EvidenceCopy.action(pack.signals.act.action.rawValue))
            DetailRowView(label: "目标控件", value: selectorText(pack.signals.act.selector))
            if let identifier = pack.signals.act.selector.identifier {
                DetailRowView(label: "控件标识", value: identifier)
            }
            DetailRowView(
                label: "执行确认",
                value: pack.signals.act.actConfirmed ? "已确认" : "未确认",
                valueColor: pack.signals.act.actConfirmed ? .green : .red
            )
        }
    }

    @ViewBuilder
    private func structureSection(_ pack: EvidencePack) -> some View {
        if let ax = pack.signals.axEvent {
            DetailCard(title: "界面结构", systemImage: "list.bullet.indent") {
                DetailRowView(label: "变化", value: ax.axChanged ? "有" : "无",
                              valueColor: ax.axChanged ? .blue : .secondary)
                DetailRowView(label: "节点数", value: "\(ax.nodeCount)")
                DetailRowView(label: "耗时", value: String(format: "%.1f ms", ax.latencyMs))
                DetailRowView(label: "操作前摘要", value: shortDigest(ax.treeDigestBefore))
                DetailRowView(label: "操作后摘要", value: shortDigest(ax.treeDigestAfter))
                Text("结构摘要是整棵界面树的指纹，两次不同即代表界面确实变了。")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        } else {
            unmeasuredCard(title: "界面结构", systemImage: "list.bullet.indent",
                           reason: "这次操作没有读到界面树（通道未启用或读取失败）。")
        }
    }

    @ViewBuilder
    private func pixelSection(_ pack: EvidencePack) -> some View {
        if let pixel = pack.signals.pixelDiff {
            DetailCard(title: "画面像素", systemImage: "photo") {
                DetailRowView(
                    label: "变化比例",
                    value: String(format: "%.4f%%", pixel.changedPixelRatio * 100),
                    valueColor: pixel.changedPixelRatio > 0 ? .blue : .secondary
                )
                DetailRowView(label: "窗口", value: "\(pixel.windowId)")
                if let bounds = pixel.bounds {
                    DetailRowView(
                        label: "变化区域",
                        value: "x \(Int(bounds.x)) · y \(Int(bounds.y)) · \(Int(bounds.width))×\(Int(bounds.height))"
                    )
                }
            }
        } else {
            unmeasuredCard(title: "画面像素", systemImage: "photo",
                           reason: "屏幕录制未授予或本次未捕获，画面通道没有数据。")
        }
    }

    private func attributionSection(_ pack: EvidencePack) -> some View {
        DetailCard(title: "归因", systemImage: "person.2") {
            DetailRowView(label: "强度", value: EvidenceCopy.attribution(pack.attribution.level.rawValue))
            DetailRowView(
                label: "人机污染",
                value: pack.attribution.contaminated ? "期间检测到本人操作" : "未检测到本人操作",
                valueColor: pack.attribution.contaminated ? .orange : .secondary
            )
            Text("归因回答的是「这次界面变化是不是这次操作造成的」；弱归因表示证据不足以断定。")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func breakerSection(_ pack: EvidencePack) -> some View {
        DetailCard(
            title: "性能熔断",
            systemImage: "gauge.with.dots.needle.bottom.verylow",
            tint: pack.circuitBreaker.level.rawValue >= 3 ? .red : .orange
        ) {
            DetailRowView(
                label: "等级",
                value: EvidenceCopy.breakerLevel(pack.circuitBreaker.level.rawValue),
                valueColor: pack.circuitBreaker.level.rawValue >= 3 ? .red : .orange
            )
            if let reason = pack.circuitBreaker.reason {
                DetailRowView(label: "原因", value: reason)
            }
        }
    }

    private func assertionSection(_ assertion: Assertion) -> some View {
        DetailCard(
            title: "断言",
            systemImage: assertion.passed ? "checkmark.circle" : "xmark.circle",
            tint: assertion.passed ? .green : .red
        ) {
            DetailRowView(label: "对象", value: selectorText(assertion.selector))
            DetailRowView(label: "属性", value: EvidenceCopy.property(assertion.property.rawValue))
            DetailRowView(label: "期望", value: assertion.expected.displayText)
            DetailRowView(label: "实际", value: assertion.actual.displayText)
            DetailRowView(label: "结果", value: assertion.passed ? "通过" : "未通过",
                          valueColor: assertion.passed ? .green : .red)
        }
    }

    private func diagnosisSection(_ diagnosis: Diagnosis) -> some View {
        DetailCard(title: "诊断", systemImage: "stethoscope", tint: .purple) {
            DetailRowView(label: "分类", value: diagnosis.class.rawValue)
            DetailRowView(label: "异常", value: diagnosis.report.anomaly)
            DetailRowView(label: "依据", value: diagnosis.report.evidence)
            DetailRowView(label: "下一步", value: diagnosis.report.next)
            Text(diagnosis.report.path)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func stateSection(_ stateDiff: StateDiffSignal) -> some View {
        DetailCard(title: "内部状态", systemImage: "number.square") {
            DetailRowView(label: "来源", value: stateDiff.source.rawValue)
            DetailRowView(label: "变化", value: stateDiff.changed ? "有" : "无")
            if stateDiff.entries.isEmpty {
                Text("没有记录到具体字段变化。").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(stateDiff.entries, id: \.key) { entry in
                    HStack(spacing: 8) {
                        Text(entry.key).font(.caption.monospaced()).foregroundStyle(.secondary)
                        Text(entry.before).font(.caption.monospaced()).strikethrough()
                            .foregroundStyle(.secondary)
                        Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.tertiary)
                        Text(entry.after).font(.caption.monospaced())
                    }
                }
            }
        }
    }

    private func aliveSection(_ crash: CrashSignal) -> some View {
        DetailCard(
            title: "进程存活",
            systemImage: crash.processAliveAfter ? "heart.circle" : "heart.circle.slash",
            tint: crash.processAliveAfter ? .green : .red
        ) {
            DetailRowView(label: "操作前", value: crash.processAliveBefore ? "存活" : "未存活")
            DetailRowView(
                label: "操作后",
                value: crash.processAliveAfter ? "存活" : "已退出",
                valueColor: crash.processAliveAfter ? .green : .red
            )
        }
    }

    private func probeSection(_ probe: HandlerProbeSignal) -> some View {
        DetailCard(title: "探针命中", systemImage: "antenna.radiowaves.left.and.right") {
            DetailRowView(label: "命中次数", value: "\(probe.hitCount)")
            DetailRowView(label: "迟到", value: "\(probe.lateCount)")
            if !probe.handlers.isEmpty {
                Text(probe.handlers.map { "\($0.file):\($0.line)" }.joined(separator: "\n"))
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    private func responsivenessSection(_ responsiveness: ResponsivenessSignal) -> some View {
        DetailCard(
            title: "响应性",
            systemImage: "gauge.with.dots.needle.50percent",
            tint: responsiveness.responsive ? .green : .orange
        ) {
            DetailRowView(
                label: "是否响应",
                value: responsiveness.responsive ? "是" : "否",
                valueColor: responsiveness.responsive ? .green : .orange
            )
            DetailRowView(label: "往返耗时", value: String(format: "%.1f ms", responsiveness.pingMs))
        }
    }

    private func unmeasuredCard(title: String, systemImage: String, reason: String) -> some View {
        DetailCard(title: title, systemImage: systemImage) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "questionmark.circle")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text(reason)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: 动作

    private func revealFile() {
        guard !summary.filePath.isEmpty else { return }
        NSWorkspace.shared.selectFile(summary.filePath, inFileViewerRootedAtPath: "")
    }

    /// 用引擎里同一份渲染器出 HTML 报告（与 MCP 侧导出同源，两侧不会长得不一样）。
    private func openHTMLReport() {
        guard let pack else { return }
        let html = EvidenceReportGenerator.renderHTML(pack: pack, diagnostics: nil)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("glasspane-evidence-\(pack.operationId).html")
        guard let data = html.data(using: .utf8), (try? data.write(to: url)) != nil else { return }
        NSWorkspace.shared.open(url)
    }

    private func selectorText(_ selector: GlassPaneEngine.Selector) -> String {
        var text = selector.role
        if let title = selector.title, !title.isEmpty { text += " · \(title)" }
        if let identifier = selector.identifier, !identifier.isEmpty { text += " · \(identifier)" }
        return text
    }

    private func shortDigest(_ digest: String) -> String {
        guard digest.count > 18 else { return digest }
        return digest.prefix(10) + "…" + digest.suffix(6)
    }
}

/// 通用详情卡。
struct DetailCard<Content: View>: View {
    let title: String
    let systemImage: String
    var tint: Color? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.callout)
                    .foregroundStyle(tint ?? Color.secondary)
                Text(title).font(.callout.weight(.semibold))
            }
            content
        }
        .consoleCard(tint: tint)
    }
}

/// 引擎枚举值 → 中文标签。放在面板侧是因为这些只是显示用词，
/// 引擎里存的是协议值，不能改。
enum EvidenceCopy {
    static func action(_ raw: String) -> String {
        switch raw {
        case "press": return "点击"
        case "increment": return "增一档"
        case "decrement": return "减一档"
        case "showMenu": return "打开菜单"
        case "confirm": return "确认"
        case "cancel": return "取消"
        case "pick": return "选中"
        default: return raw
        }
    }

    static func attribution(_ raw: String) -> String {
        switch raw {
        case "soft": return "弱"
        case "strong": return "强"
        case "weak": return "很弱"
        default: return raw
        }
    }

    static func breakerLevel(_ raw: Int) -> String {
        switch raw {
        case 0: return "正常"
        case 1: return "1 级 · 画面通道降级"
        case 2: return "2 级 · 操作未确认"
        case 3: return "3 级 · 通道故障"
        default: return "\(raw) 级"
        }
    }

    static func property(_ raw: String) -> String {
        switch raw {
        case "title": return "标题"
        case "value": return "取值"
        case "role": return "角色"
        case "enabled": return "可用"
        case "focused": return "聚焦"
        default: return raw
        }
    }
}

extension StringOrBool {
    /// 断言里的期望/实际值：布尔与字符串两种形态都要能读成人话。
    var displayText: String {
        switch self {
        case .string(let value): return value
        case .bool(let value): return value ? "真" : "假"
        }
    }
}
