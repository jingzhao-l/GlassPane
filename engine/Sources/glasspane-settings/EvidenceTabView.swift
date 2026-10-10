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
                // `idealWidth` 必须写死：不写时这一栏的理想宽度由内容决定，而详情页
                // 那排带 `fixedSize` 的标签加起来要 518pt。NavigationSplitView 按理想
                // 尺寸排整条分栏，窗口只有 900，结果左侧导航被整体挤出窗口——
                // 实测分栏组 987 宽、左移 44pt，"首次使用"只剩"使用"、图标全部看不见。
                .frame(minWidth: 300, idealWidth: 380, maxWidth: .infinity, maxHeight: .infinity)
        }
        .toolbar { toolbarContent }
    }

    // MARK: - 列表

    /// 列表那一栏：标题与筛选固定在顶部，**趋势卡与档案列表之间是一条可拖的分隔线**。
    ///
    /// 此前趋势卡被钉在 `VStack` 顶部且没有任何高度上限：档案一多（真机 582 条、
    /// 七个诊断分类加七天产量）它自己就要八百多点高，而窗口只有六百一十二点——
    /// 结果档案列表被整个挤到窗口下沿之外（实测列表滚动区落在 y=797，窗口底在 y=760），
    /// 用户看到的是"列表不见了"，而那张卡又无处可缩。
    private var listPane: some View {
        VStack(spacing: 0) {
            PageTitleView(title: "证据档案", systemImage: "doc.text.magnifyingglass")
            filterBar
            VSplitView {
                EvidenceStatsView()
                    .frame(minHeight: 90, idealHeight: 210)
                content
                    .frame(minHeight: 120)
            }
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
                // 与权限页、更新页同一套收口：先给一个可读的行宽上限，再把剩余空间
                // 让给窗口。少了上面那一条，长句（"结构摘要是整棵界面树的指纹…"）
                // 会把这一栏的*理想宽度*撑到整句那么宽，NavigationSplitView 就按理想
                // 尺寸排整条分栏，症状是左侧导航被挤出窗口、只剩半截字。
                .frame(maxWidth: 760, alignment: .leading)
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
            ChipRowLayout(spacing: 5, lineSpacing: 4) {
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
    /// 动作结论的唯一出口：报告写不成要把原因交给控制台那一条横幅，
    /// 而不是 `return` 掉——"点了没反应"正是这一面修过的那类缺陷。
    @EnvironmentObject private var model: ConsoleModel
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
                unmeasuredCard(key: "state", title: "内部状态", systemImage: "number.square", reason: reason)
            }
            if let crash = pack.signals.crash {
                aliveSection(crash)
            } else if let reason = PanelChannelFields.reason(for: "crash") {
                unmeasuredCard(key: "alive", title: "进程存活", systemImage: "heart.circle", reason: reason)
            }
            if let probe = pack.signals.handlerProbe {
                probeSection(probe)
            } else if let reason = PanelChannelFields.reason(for: "handlerProbe") {
                unmeasuredCard(key: "probe", title: "探针命中", systemImage: "antenna.radiowaves.left.and.right", reason: reason)
            }
            if let responsiveness = pack.signals.responsiveness {
                responsivenessSection(responsiveness)
            } else if let reason = PanelChannelFields.reason(for: "responsiveness") {
                unmeasuredCard(key: "responsiveness", title: "响应性", systemImage: "gauge.with.dots.needle.50percent", reason: reason)
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
            .help("用浏览器打开这条证据的报告：会在系统临时目录写一份 0600 的副本，看完可自行删除")
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
        DetailCard(key: "act", title: "操作", systemImage: "cursorarrow.click") {
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
            DetailCard(key: "structure", title: "界面结构", systemImage: "list.bullet.indent",
                           summary: ax.axChanged ? "结构有变化" : "结构未见变化") {
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
            unmeasuredCard(key: "structure", title: "界面结构", systemImage: "list.bullet.indent",
                           reason: "这次操作没有读到界面树（通道未启用或读取失败）。")
        }
    }

    @ViewBuilder
    private func pixelSection(_ pack: EvidencePack) -> some View {
        if let pixel = pack.signals.pixelDiff {
            DetailCard(key: "pixel", title: "画面像素", systemImage: "photo",
                       summary: String(format: "变化 %.4f%%", pixel.changedPixelRatio * 100)) {
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
            unmeasuredCard(key: "pixel", title: "画面像素", systemImage: "photo",
                           reason: "屏幕录制未授予或本次未捕获，画面通道没有数据。")
        }
    }

    private func attributionSection(_ pack: EvidencePack) -> some View {
        DetailCard(key: "attribution", title: "归因", systemImage: "person.2",
                   summary: "归因 \(EvidenceCopy.attribution(pack.attribution.level.rawValue))") {
            DetailRowView(label: "强度", value: EvidenceCopy.attribution(pack.attribution.level.rawValue))
            DetailRowView(
                label: "人机污染",
                value: EvidenceCopy.contamination(
                    contaminated: pack.attribution.contaminated,
                    breakerReason: pack.circuitBreaker.reason
                ),
                valueColor: pack.attribution.contaminated ? .orange : .secondary
            )
            Text("归因回答的是「这次界面变化是不是这次操作造成的」；弱归因表示证据不足以断定。")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func breakerSection(_ pack: EvidencePack) -> some View {
        DetailCard(
            key: "breaker", title: "性能熔断",
            systemImage: "gauge.with.dots.needle.bottom.verylow",
            tint: pack.circuitBreaker.level.rawValue >= 3 ? .red : .orange,
            summary: EvidenceCopy.breakerLevel(pack.circuitBreaker.level.rawValue)
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
            key: "assertion", title: "断言",
            systemImage: assertion.passed ? "checkmark.circle" : "xmark.circle",
            tint: assertion.passed ? .green : .red,
            summary: assertion.passed ? "断言通过" : "断言未通过"
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
        DetailCard(key: "diagnosis", title: "诊断", systemImage: "stethoscope", tint: .purple,
                     summary: "分类 \(diagnosis.class.rawValue)") {
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
        DetailCard(key: "state", title: "内部状态", systemImage: "number.square",
                   summary: stateDiff.changed ? "状态有变化" : "状态未见变化") {
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
            key: "alive", title: "进程存活",
            systemImage: crash.processAliveAfter ? "heart.circle" : "heart.circle.slash",
            tint: crash.processAliveAfter ? .green : .red,
            summary: crash.processAliveAfter ? "操作后仍存活" : "操作后已退出"
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
        DetailCard(key: "probe", title: "探针命中", systemImage: "antenna.radiowaves.left.and.right",
                     summary: "命中 \(probe.hitCount) 次") {
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
            key: "responsiveness", title: "响应性",
            systemImage: "gauge.with.dots.needle.50percent",
            tint: responsiveness.responsive ? .green : .orange,
            summary: String(format: "往返 %.1f ms", responsiveness.pingMs)
        ) {
            DetailRowView(
                label: "是否响应",
                value: responsiveness.responsive ? "是" : "否",
                valueColor: responsiveness.responsive ? .green : .orange
            )
            DetailRowView(label: "往返耗时", value: String(format: "%.1f ms", responsiveness.pingMs))
        }
    }

    private func unmeasuredCard(key: String, title: String, systemImage: String, reason: String) -> some View {
        DetailCard(key: key, title: title, systemImage: systemImage, summary: "未测量") {
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
    ///
    /// 落盘判定在引擎里（`writePrivateHTMLReport`）：0600、独占创建、不跟 symlink，
    /// 且只往一个属于本用户、同组/其他人写不动的目录里写。从前这里是一句
    /// `try? data.write(to:)`——umask 给 0644、名字人人可猜，写坏了还不吭声。
    /// 写不成必须把原因说出来：把「没写成」演成「已经打开了」是这一面修过的那类缺陷。
    private func openHTMLReport() {
        guard let pack else { return }
        let html = EvidenceReportGenerator.renderHTML(pack: pack, diagnostics: nil)
        switch EvidenceReportGenerator.writePrivateHTMLReport(html, operationId: pack.operationId) {
        case .written(let path):
            // 落盘这件事要交代去哪儿了：这一份在状态根之外，任何清理扫描都够不着，
            // 不说的话它就永远是屏幕上看不见的一个残留。
            model.lastActionMessage = "报告已写入 \(path)（0600，只有你能读）。它在状态根之外，不会被自动清理——看完请自行删除。"
            NSWorkspace.shared.open(URL(fileURLWithPath: path))
        case .directoryUnusable(let defect):
            model.lastActionMessage = "报告没有写出来：\(defect)。下一步：确认系统临时目录归当前用户且同组/其他人不可写（ls -ld 那个目录）。"
        case .refused:
            model.lastActionMessage = "报告没有写出来：独占创建试了 16 次都没能在临时目录里占住一个名字。下一步：腾出可写的临时目录，或直接从 MCP 侧用 gp_export_evidence 取文本。"
        }
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
/// 一条通道的卡片。可折叠，折叠状态按 `key` 记在本机设置里。
///
/// 一条证据最多摊开十一张这样的卡，而一次核对通常只关心其中两三张
/// （"结构动没动"、"像素动没动"）。其余九张占着的高度把真正要看的那张
/// 挤到窗口外面去——这就是"各种卡片无法调节"在这一页的形状。
///
/// `summary` 是折叠后仍要露出来的那一行结论。没有它，折叠就把"这条通道说了什么"
/// 一起收进了要点开才知道——而卡片标题本身不承载任何结论。
struct DetailCard<Content: View>: View {
    let key: String
    let title: String
    let systemImage: String
    var tint: Color? = nil
    var summary: String? = nil
    @ViewBuilder let content: Content

    var body: some View {
        PanelCard(key: key, title: title, systemImage: systemImage, tint: tint, summary: summary) {
            content
        }
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

    /// 无监视的两个标签（EngineCore 写进 `circuitBreaker.reason` 的同名串，
    /// 由 `EngineCoreTests` 按包内实值钉住）。
    static let monitorAbsenceLabels = [
        "input-contamination-not-monitored", "input-contamination-monitor-lost",
    ]

    /// 这个窗口有没有真的被看守过。冻结的证据 schema 里没有 monitor 字段，唯一
    /// 还活着的记录就是上面那两个标签：EngineCore 在无监视时**必定**写它
    /// （`testDaemonAlwaysStatesAReasonWhenNoMonitorRuns` 钉的就是这条）。
    static func wasWatched(breakerReason: String?) -> Bool {
        guard let reason = breakerReason else { return true }
        return !monitorAbsenceLabels.contains { reason.contains($0) }
    }

    /// 污染行的措辞。`attribution.contaminated` 是**结论**，不是测量：EngineCore
    /// 在没人看守这个窗口时按保守判 true（见其 contaminationBasis 那段），从前这里
    /// 对 true 一律印"期间检测到本人操作"——面板于是替引擎声称了一次引擎刻意拒绝
    /// 做出的测量，比错字严重一档。判净的一侧同理：无人看守时的 false 是声明。
    static func contamination(contaminated: Bool, breakerReason: String?) -> String {
        guard contaminated else {
            return wasWatched(breakerReason: breakerReason)
                ? "未检测到本人操作"
                : "未监测（无人看守该窗口，判净出自声明而非测量）"
        }
        return wasWatched(breakerReason: breakerReason)
            ? "期间检测到本人操作"
            : "未监测（无人看守该窗口，按保守判污）"
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
