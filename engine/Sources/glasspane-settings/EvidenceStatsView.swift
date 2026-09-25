import SwiftUI
import GlassPaneEngine

/// 证据「趋势 / 统计」区块（证据档案页顶部的紧凑只读卡）。
///
/// 数据源分两类，**来源必须分开标注，绝不混为一谈**：
///  - daemon 统计：经 `--evidence-stats` 一次性 CLI 拿到的是整个档案目录的
///    `{count, totalBytes, listFailure, dir}`（见 main.swift 里 `--evidence-stats`
///    的实现）。它没有按 level / class / 时间分布的字段，所以那些分布不能从
///    daemon 造出来，只能标注来源为本地扫描。
///  - 本地扫描：ConsoleModel 已把本地 evidence 目录聚合进 `summaries`；熔断级别、
///    诊断分类、按天产量从本地摘要如实聚合，标注"本地扫描"。
///
/// 诚实口径：daemon 不可达 / 超时 → 显示"未测得"，不折算成零；daemon 报了
/// `listFailure`（档案读不了）→ 同样显示"未测得" + 原因，绝不把两个零当"空档案"。
struct EvidenceStatsView: View {
    @EnvironmentObject private var model: ConsoleModel

    /// daemon `--evidence-stats` 的结果。nil = 尚未发起请求。
    @State private var daemonResult: DaemonStatsResult?

    enum DaemonStatsResult: Equatable {
        /// 已连上并拿到 JSON，但档案读不了（`listFailure` 非空）或读到实数。
        case loaded(count: Int?, totalBytes: Int?, listFailure: String?, dir: String?)
        /// daemon 起不来 / 超时 / 输出不是约定的 JSON 形状。
        case unreachable
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ConsoleTheme.gap) {
            SectionHeader(
                title: "趋势 / 统计",
                subtitle: "数据来源分开核实：daemon 统计 与 本地扫描",
                systemImage: "chart.bar.xaxis"
            )
            daemonCard
            localCard
        }
        .consoleCard()
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
        .onAppear(perform: refreshDaemonStats)
    }

    // MARK: - daemon 来源

    @ViewBuilder
    private var daemonCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            headerRow(title: "档案目录统计", source: "daemon --evidence-stats", systemImage: "server.rack", tint: .blue)
            switch daemonResult {
            case .none:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在向后台服务请求统计……")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            case .unreachable:
                unmeasuredLine("后台服务不可达或超时，未从 daemon 测得统计。")
            case .loaded(let count, let totalBytes, let listFailure, let dir):
                if let listFailure {
                    unmeasuredLine("后台服务读不了档案：\(listFailure)")
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
                }
            }
        }
    }

    // MARK: - 本地扫描来源（分布）

    @ViewBuilder
    private var localCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            headerRow(title: "分布", source: "本地扫描（按已读摘要聚合）", systemImage: "opticaldisc", tint: .secondary)
            if !model.archiveExists {
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
        let rows = EvidenceStatsAggregator.levelCounts(from: model.summaries)
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

    private func headerRow(title: String, source: String, systemImage: String, tint: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.callout)
                .foregroundStyle(tint)
            Text(title).font(.callout.weight(.semibold))
            Spacer(minLength: 4)
            Text(source)
                .font(.caption2)
                .foregroundStyle(.tertiary)
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
        }
    }

    // MARK: - 触发

    private func refreshDaemonStats() {
        let binary = model.daemonBinaryPath
        daemonResult = .none
        Task.detached(priority: .userInitiated) {
            let run = ConsoleModel.runDaemonCLI(binary: binary, arguments: ["--evidence-stats"])
            let result: DaemonStatsResult
            if let run {
                result = Self.parseDaemonStats(run.output)
            } else {
                result = .unreachable
            }
            await MainActor.run { self.daemonResult = result }
        }
    }

    /// 解析 `--evidence-stats` 的 JSON（字段名以 main.swift 的实现为准，严禁猜）。
    nonisolated private static func parseDaemonStats(_ text: String) -> DaemonStatsResult {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .unreachable
        }
        return .loaded(
            count: object["count"] as? Int,
            totalBytes: object["totalBytes"] as? Int,
            listFailure: object["listFailure"] as? String,
            dir: object["dir"] as? String
        )
    }
}

/// 一条分布（标签 + 计数），本地聚合的可读形态。
struct EvidenceCountRow: Equatable {
    let label: String
    let count: Int
}

/// 本地扫描的纯聚合逻辑，独立函数便于复核；是否为最新以模型状态为准。
enum EvidenceStatsAggregator {
    /// 熔断级别 0–3 的计数（正常/降级/未确认/通道故障）。
    static func levelCounts(from summaries: [EvidenceSummary]) -> [EvidenceCountRow] {
        [0, 1, 2, 3].map { level in
            EvidenceCountRow(label: "\(level) \(levelName(level))",
                             count: summaries.filter { $0.circuitBreakerLevel == level }.count)
        }
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
                .frame(width: 72, alignment: .leading)
                .lineLimit(1)
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
