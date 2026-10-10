import SwiftUI
import GlassPaneEngine

/// 证据「趋势 / 统计」区块（证据档案页顶部的紧凑只读卡）。
///
/// 数据源分两类，**来源必须分开标注，绝不混为一谈**：
///  - daemon 统计：经 `--evidence-stats` 一次性 CLI 拿到的是整个档案目录的
///    `{count, totalBytes, listFailure, dir}`（那一侧由 `ConsoleModel` 发起并解析，
///    这一张卡只负责如实呈现）。它没有按 level / class / 时间分布的字段，
///    所以那些分布不能从 daemon 造出来，只能标注来源为本地扫描。
///  - 本地扫描：ConsoleModel 已把本地 evidence 目录聚合进 `summaries`；熔断级别、
///    诊断分类、按天产量从本地摘要如实聚合，标注"本地扫描"。
///
/// 诚实口径：还没问过 daemon → 显示"还没实测过"，不写成"不可达"；daemon 不可达 /
/// 超时 → "未测得"；daemon 报了 `listFailure`（档案读不了）→ "未测得" + 原因，
/// 绝不把两个零当"空档案"。
struct EvidenceStatsView: View {
    @EnvironmentObject private var model: ConsoleModel

    /// 标题钉在卡片顶部，正文自己滚。
    ///
    /// 这一栏现在由外层 `VSplitView` 决定给多高（可拖），所以正文必须能在更矮的
    /// 高度里活下来：没有这层 ScrollView 时，把分隔线拖小只会把分布条裁掉。
    var body: some View {
        VStack(alignment: .leading, spacing: ConsoleTheme.gap) {
            SectionHeader(
                title: "趋势 / 统计",
                subtitle: "数据来源分开核实：daemon 统计 与 本地扫描",
                systemImage: "chart.bar.xaxis"
            )
            ScrollView {
                VStack(alignment: .leading, spacing: ConsoleTheme.gap) {
                    daemonCard
                    localCard
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: .infinity)
        }
        .consoleCard()
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
        // 进这一页时问一次；路径到了或换了由模型自己重问（见
        // `ConsoleModel.adoptDaemonReport`）——从前只有这一句 `.onAppear`，而那次
        // 触发时 hello 还没落地、程序路径还是 nil，这一栏就永远停在"不可达"。
        .onAppear { model.refreshDaemonStats() }
    }

    // MARK: - daemon 来源

    @ViewBuilder
    private var daemonCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            headerRow(title: "档案目录统计", source: "daemon --evidence-stats", systemImage: "server.rack", tint: .blue)
            switch model.daemonStats {
            case .notAsked:
                unmeasuredLine("还没向后台服务问过：它的程序路径还没实测到。点「刷新」恢复连接后这一栏才会实起来。")
                retryButton
            case .asking:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在向后台服务请求统计……")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            case .unreachable:
                unmeasuredLine("后台服务不可达或超时，未从 daemon 测得统计。")
                retryButton
            case .loaded(let count, let totalBytes, let listFailure, let dir):
                if let listFailure {
                    unmeasuredLine("后台服务读不了档案：\(listFailure)")
                    retryButton
                } else if let count {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        StatValueView(label: "档案条数", value: "\(count)")
                        if let totalBytes {
                            StatValueView(label: "总字节", value: ConsoleTheme.bytes(totalBytes))
                        }
                    }
                    if let dir, !dir.isEmpty {
                        Text("目录：\(dir)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(dir)
                    }
                } else {
                    unmeasuredLine("后台服务返回的统计为空（count 未测得）。")
                    retryButton
                }
            }
        }
    }

    /// 每一句"没测得"后面都跟着一个做得动的动作：只报失败而不给重试，
    /// 用户能做的就只有把这页关掉再开一次。
    private var retryButton: some View {
        Button {
            model.refreshDaemonStats()
        } label: {
            Label("重新问一次", systemImage: "arrow.clockwise")
        }
        .controlSize(.small)
        .accessibilityIdentifier("gp-refresh-daemon-stats")
    }

    // MARK: - 本地扫描来源（分布）

    @ViewBuilder
    private var localCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            headerRow(title: "分布", source: "本地扫描（按已读摘要聚合）", systemImage: "opticaldisc", tint: .secondary)
            if case .failed(let message) = model.evidenceState {
                // 读不出条数与"这里没有档案"是两件事：把前者印成"目录是空的"，
                // 这张分布条就替一次失败的读取报了平安。
                unmeasuredLine("本地扫描没有可聚合的摘要，而这不是空目录：\(message)")
            } else if !model.archiveExists {
                unmeasuredLine("本地证据目录不存在，无摘要可聚合。")
            } else if model.summaries.isEmpty {
                unmeasuredLine("本地证据目录是空的，无分布可统计。")
            } else {
                levelDistribution
                if !EvidenceStatsAggregator.classCounts(from: model.summaries).isEmpty {
                    classDistribution
                }
                dayDistribution
            }
        }
    }

    @ViewBuilder
    private var levelDistribution: some View {
        let summaries = model.summaries
        let rows = EvidenceStatsAggregator.levelCounts(from: summaries)
        VStack(alignment: .leading, spacing: 4) {
            Text("熔断级别分布").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(rows, id: \.label) { row in
                DistributionBarView(
                    label: row.label,
                    count: row.count,
                    maxCount: EvidenceStatsAggregator.maxRowCount(rows),
                    tint: levelColor(row.label)
                )
            }
            // 有越界值时明示：只标记"无法识别"，不代测其含义，且分布总和与 count 对齐。
            let unrecognized = EvidenceStatsAggregator.unrecognizedLevelCount(from: summaries)
            if unrecognized > 0 {
                HStack(spacing: 6) {
                    Image(systemName: "questionmark.circle")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text("\(unrecognized) 条 circuitBreaker level 无法识别")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var classDistribution: some View {
        let rows = EvidenceStatsAggregator.classCounts(from: model.summaries)
        VStack(alignment: .leading, spacing: 4) {
            Text("诊断分类分布").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(rows, id: \.label) { row in
                DistributionBarView(
                    label: row.label,
                    count: row.count,
                    maxCount: EvidenceStatsAggregator.maxRowCount(rows),
                    tint: .purple
                )
            }
        }
    }

    @ViewBuilder
    private var dayDistribution: some View {
        let rows = EvidenceStatsAggregator.recentDayCounts(from: model.summaries)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("近 7 天每日产量").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(rows, id: \.label) { row in
                    DistributionBarView(
                        label: row.label,
                        count: row.count,
                        maxCount: EvidenceStatsAggregator.maxRowCount(rows),
                        tint: .blue
                    )
                }
            }
        }
    }

    private func levelColor(_ label: String) -> Color {
        switch label {
        case "0 正常": return .green
        case "1 降级": return .orange
        case "2 未确认": return .orange
        case "3 通道故障": return .red
        default: return .secondary
        }
    }

    /// 来源那一行单独占一行。
    ///
    /// 原先它和标题挤在同一条 `HStack` 的两端，窄栏里被中段裁成 "dae…tats"——
    /// 而"这一栏的数字是从哪来的"恰恰是这张卡最需要读得清的一句。
    private func headerRow(title: String, source: String, systemImage: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.callout)
                    .foregroundStyle(tint)
                Text(title).font(.callout.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(source)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private func unmeasuredLine(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "questionmark.circle")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("gp-daemon-stats-unmeasured")
        }
    }
}

/// 一条分布（标签 + 计数），本地聚合的可读形态。
struct EvidenceCountRow: Equatable {
    let label: String
    let count: Int
}

/// 本地扫描的纯聚合逻辑，独立函数便于复核；是否为最新以模型状态为准。
enum EvidenceStatsAggregator {
    /// 熔断级别 0–3 的计数（正常/降级/未确认/通道故障）＋越界值并入"其他(不识别)"
    /// 档，使各档之和恒等于 summaries.count（任何越界都不再静默丢失）。
    static func levelCounts(from summaries: [EvidenceSummary]) -> [EvidenceCountRow] {
        let recognized = [0, 1, 2, 3].map { level in
            EvidenceCountRow(label: "\(level) \(levelName(level))",
                             count: summaries.filter { $0.circuitBreakerLevel == level }.count)
        }
        let unrecognized = unrecognizedLevelCount(from: summaries)
        guard unrecognized > 0 else { return recognized }
        return recognized + [EvidenceCountRow(label: "其他(不识别)", count: unrecognized)]
    }

    /// 越界（<0 或 >3）熔断级别条数。只统计，不代测其含义。
    static func unrecognizedLevelCount(from summaries: [EvidenceSummary]) -> Int {
        summaries.filter { !isRecognizedLevel($0.circuitBreakerLevel) }.count
    }

    private static func isRecognizedLevel(_ level: Int) -> Bool {
        (0...3).contains(level)
    }

    /// 诊断分类计数（nil 的分类不算，表示"未诊断"）。
    static func classCounts(from summaries: [EvidenceSummary]) -> [EvidenceCountRow] {
        let counted = Dictionary(grouping: summaries.compactMap(\.diagnosisClass), by: { $0 })
            .mapValues { $0.count }
        return counted.sorted { $0.value > $1.value }
            .map { EvidenceCountRow(label: $0.key, count: $0.value) }
    }

    /// 近 7 天的每日产量（ISO 前 10 位为日期；宁可不足 7 天，也不造"0"空日）。
    static func recentDayCounts(from summaries: [EvidenceSummary], days: Int = 7) -> [EvidenceCountRow] {
        let counted = Dictionary(grouping: summaries.map { dayKey($0.createdAt) }, by: { $0 })
            .mapValues { $0.count }
        let sorted = counted.sorted { $0.key < $1.key }
        return sorted.suffix(days).map { EvidenceCountRow(label: shortDay($0.key), count: $0.value) }
    }

    static func maxRowCount(_ rows: [EvidenceCountRow]) -> Int {
        rows.map(\.count).max() ?? 1
    }

    private static func levelName(_ level: Int) -> String {
        switch level {
        case 0: return "正常"
        case 1: return "降级"
        case 2: return "未确认"
        case 3: return "通道故障"
        default: return "?"
        }
    }

    private static func dayKey(_ iso: String) -> String {
        // ISO-8601 `yyyy-MM-ddTHH:mm:ss.zzzZ` 的前 10 位即日期。
        guard let end = index(iso, offset: 10) else { return iso }
        return String(iso[..<end])
    }

    private static func shortDay(_ yyyyMMdd: String) -> String {
        guard yyyyMMdd.count >= 10,
              let dateStart = yyyyMMdd.index(yyyyMMdd.startIndex, offsetBy: 5, limitedBy: yyyyMMdd.endIndex)
        else {
            return yyyyMMdd
        }
        return String(yyyyMMdd[dateStart...])
    }

    private static func index(_ s: String, offset: Int) -> String.Index? {
        guard s.count >= offset, offset >= 0 else { return nil }
        return s.index(s.startIndex, offsetBy: offset)
    }
}

/// 一格统计值（数字 + 标签）。
private struct StatValueView: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.title3.weight(.semibold))
                .monospacedDigit()
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

/// 一条横向比例条：宽度按 `count / maxCount` 折算，`count` 恒为实读值。
private struct DistributionBarView: View {
    let label: String
    let count: Int
    let maxCount: Int
    let tint: Color

    var body: some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                // 原先写死 72pt 宽：诊断分类里的 `INCONCLUSIVE` 被裁成 "INCONCLU…"，
                // 而这一栏正是靠这个标签区分分类的——裁掉就等于少了一类。
                // `fixedSize` 让它按需要占宽，条子那一段自己收窄（GeometryReader 读实际宽度）。
                .fixedSize()
                .frame(minWidth: 72, alignment: .leading)
                .help(label)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(tint.opacity(0.12))
                    Capsule()
                        .fill(tint)
                        .frame(width: max(CGFloat(2), CGFloat(count) / CGFloat(max(1, maxCount)) * proxy.size.width))
                }
            }
            .frame(height: 7)
            Text("\(count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 30, alignment: .trailing)
        }
    }
}
