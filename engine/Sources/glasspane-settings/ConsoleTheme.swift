import SwiftUI
import AppKit
import GlassPaneEngine

/// 控制台共用视觉件（对齐 macOS 系统设置的观感：语义色 + 卡片 + 一致间距）。
///
/// 这里只放"怎么长"，不放"是什么状态"——状态判定一律留在 engine 层，
/// 面板只渲染（P1 v1.2 §9.3 的分工不变）。
enum ConsoleTheme {
    static let cardRadius: CGFloat = 10
    static let cardPadding: CGFloat = 14
    static let gap: CGFloat = 12

    /// 卡片底：用语义色，暗色/亮色与"增强对比度"都自动跟随。
    static var cardBackground: Color { Color(nsColor: .controlBackgroundColor) }
    static var cardStroke: Color { Color.primary.opacity(0.08) }
    static var insetBackground: Color { Color(nsColor: .windowBackgroundColor) }

    /// 统一的时间呈现：ISO-8601 → 本地 `MM-dd HH:mm:ss`；解析不出来就原样给回，
    /// 绝不编一个看起来合理的时间。
    static func timestamp(_ iso: String) -> String {
        LocalArchive.displayTimestamp(iso8601: iso)
    }

    static func bytes(_ value: Int) -> String {
        LocalArchive.displayBytes(value)
    }
}

/// 卡片容器样式。
struct CardStyle: ViewModifier {
    var tint: Color? = nil
    var padding: CGFloat = ConsoleTheme.cardPadding

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ConsoleTheme.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: ConsoleTheme.cardRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: ConsoleTheme.cardRadius, style: .continuous)
                    .stroke(tint.map { $0.opacity(0.45) } ?? ConsoleTheme.cardStroke, lineWidth: 1)
            )
    }
}

extension View {
    func consoleCard(tint: Color? = nil, padding: CGFloat = ConsoleTheme.cardPadding) -> some View {
        modifier(CardStyle(tint: tint, padding: padding))
    }

    /// 页面正文那一列。
    ///
    /// 从前每一页各自写死 `.frame(maxWidth: 760)` 再 `maxWidth: .infinity` 左对齐：
    /// 窗口拉大时正文一点不长，右边空出一大片死白，而用户没有任何办法把那块空间要回来
    /// ——"适应性很差"说的就是这个。现在这一列跟着窗口长到可读上限为止。
    func panelColumn() -> some View {
        modifier(PanelColumn())
    }
}

/// 可以收起来的卡片：标题栏常驻，正文按 key 记住开合。
///
/// 面板原先每一张卡都是"要么全占着、要么没有"，一屏里真正要读的常常只有一两张
/// （权限页四张卡 + 拖拽引导 + 后台服务 + 降级说明；更新页六张卡）。
/// 收起不读的那几张，比把想读的那张挤到窗口外面去便宜得多——证据页今天就是这么
/// 把档案列表整个挤出窗口的。
///
/// 折叠状态记在本机设置里、按卡片的稳定 key 存：面板重开一次不该把人自己
/// 收拾好的版面重置掉。折叠时标题与状态色仍在，收起来不等于看不见这件事。
struct PanelCard<Content: View>: View {
    let key: String
    let title: String
    var subtitle: String? = nil
    var systemImage: String? = nil
    var tint: Color? = nil
    /// 折叠后仍要露出来的那一行结论（不传就只有标题）。诚实要求：收起正文
    /// 不能顺手把结论也收起——状态点与这一行始终在。
    var summary: String? = nil
    @AppStorage private var collapsed: Bool
    @ViewBuilder var content: Content

    init(
        key: String,
        title: String,
        subtitle: String? = nil,
        systemImage: String? = nil,
        tint: Color? = nil,
        summary: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.key = key
        self.title = title
        self.subtitle = subtitle
        self.systemImage = systemImage
        self.tint = tint
        self.summary = summary
        self._collapsed = AppStorage(wrappedValue: false, "glasspane.card.\(key).collapsed")
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                collapsed.toggle()
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(width: 10, alignment: .center)
                    if let systemImage {
                        Image(systemName: systemImage)
                            .font(.callout)
                            .foregroundStyle(tint ?? Color.secondary)
                    }
                    Text(title).font(.callout.weight(.semibold))
                    if collapsed, let summary {
                        Text(summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("gp-card-toggle-\(key)")
            .help(collapsed ? "展开这一栏" : "收起这一栏")
            if !collapsed {
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                content
            }
        }
        .consoleCard(tint: tint)
    }
}

/// 正文列宽：跟着窗口长，最宽到可读上限。
private struct PanelColumn: ViewModifier {
    /// 1000pt 是这一列愿意长到的上限。再宽下去一行中文要跨整屏找回，
    /// 那不是"适应窗口"，那是把人赶去读一条没有边际的线。
    static let readableMaximum: Double = 1000

    func body(content: Content) -> some View {
        content
            .padding(20)
            .frame(maxWidth: Self.readableMaximum, alignment: .leading)
            .frame(maxWidth: .infinity)
    }
}

/// 小圆角标签（状态、风险等级、schema 版本）。形状 + 文字表达状态，
/// 颜色只作辅助——色盲用户读到的信息不缺。
struct ChipView: View {
    let text: String
    var color: Color = .secondary
    var systemImage: String? = nil
    var identifier: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 9, weight: .bold))
            }
            Text(text)
                .font(.caption2.weight(.semibold))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2.5)
        .foregroundStyle(color)
        .background(color.opacity(0.10))
        .clipShape(Capsule())
        .overlay(Capsule().stroke(color.opacity(0.35), lineWidth: 0.5))
        .fixedSize()
        .modifier(OptionalIdentifier(identifier: identifier))
    }
}

/// 只有给了 identifier 才挂上去，避免给无关视图造出空标识。
private struct OptionalIdentifier: ViewModifier {
    let identifier: String?
    func body(content: Content) -> some View {
        if let identifier {
            content.accessibilityIdentifier(identifier)
        } else {
            content
        }
    }
}

/// 存活指示点（绿=运行中，灰=未知，红=未运行）。
struct StatusDotView: View {
    enum Tone { case good, warning, bad, neutral }
    let tone: Tone

    private var color: Color {
        switch tone {
        case .good: return .green
        case .warning: return .orange
        case .bad: return .red
        case .neutral: return .secondary
        }
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .overlay(Circle().stroke(color.opacity(0.35), lineWidth: 3).opacity(0.35))
    }
}

/// 路径行：中段截断（保住开头与文件名可读）+ 复制按钮。
/// 此前面板把整条路径按 monospaced 全量铺开，长路径换行后把卡片撑得很难看。
struct PathRowView: View {
    let label: String
    let path: String
    var monospaced: Bool = true
    /// 复制按钮的稳定标识键（ASCII）：标识里放中文，自动化按标识选不中。
    var identifierKey: String = "path"

    var body: some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 52, alignment: .leading)
            Text(path)
                .font(monospaced ? .caption.monospaced() : .caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .help(path)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(path, forType: .string)
            } label: {
                // 命中区要明显大于字形：这里原先只有一枚 `.font(.caption2)` 的图标，
                // 实测无障碍尺寸 10×12pt，人手基本点不中（面板自己的 UILayoutAudit
                // 会把这种目标报成 smallHitTarget）。字形保持小，可点区域撑到 20×20。
                Image(systemName: "doc.on.doc")
                    .font(.caption2)
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .help("复制路径")
            .accessibilityIdentifier("gp-copy-\(identifierKey)")
        }
    }
}

/// 标签 + 值的一行（详情页用）。
struct DetailRowView: View {
    let label: String
    let value: String
    var valueColor: Color = .primary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 92, alignment: .leading)
            Text(value)
                .font(.callout)
                .foregroundStyle(valueColor)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .help(value)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
        }
    }
}

/// "未测量"与"没有"必须长得不一样：前者是通道缺失，后者是确实为零。
enum Measured<T: Equatable> {
    case value(T)
    case notMeasured

    var text: String {
        switch self {
        case .value(let v): return "\(v)"
        case .notMeasured: return "未测量"
        }
    }

    var isMeasured: Bool {
        if case .value = self { return true }
        return false
    }
}

/// 页标题：每个页面左上角那一级标题（窗口标题恒为 "GlassPane 设置"，
/// 页名只能在页内表达）。
struct PageTitleView: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.title3.weight(.semibold))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.top, 12)
        .padding(.bottom, 6)
        .accessibilityAddTraits(.isHeader)
    }
}

/// 区块标题（页面内分段）。
struct SectionHeader: View {
    let title: String
    var subtitle: String? = nil
    var systemImage: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                if let systemImage {
                    Image(systemName: systemImage).font(.callout).foregroundStyle(.secondary)
                }
                Text(title).font(.headline)
            }
            if let subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    // 副标题必须能换行。窄栏里（证据页左栏最窄 250pt）它原先被裁成
                    // "数据来源分开核实：daemon 统计 与 本地…"，那句话恰好是这张卡
                    // 唯一说明"两个来源不是一回事"的地方。
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityAddTraits(.isHeader)
    }
}

/// 空状态：说清楚为什么是空的、去哪儿看、怎么刷新。
struct EmptyStateView: View {
    let systemImage: String
    let title: String
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 30))
                .foregroundStyle(.tertiary)
            Text(title).font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}

/// 一行放不下就换行的横向排布（标签条专用）。
///
/// 证据列表那一栏最窄只有 250pt，而一条记录最多能同时挂上五枚标签（有人同时操作 /
/// 降级 3 / 诊断 T5 / 断言未过 / 画面 0.00%）。它们原先挤在同一条 `HStack` 里，
/// 每枚又各自 `fixedSize`——放不下的那几枚不是变小，是被整枚裁掉。
/// 标签是"颜色之外"的第二种状态表达，裁掉就等于这个状态没有呈现。
struct ChipRowLayout: Layout {
    var spacing: CGFloat = 5
    var lineSpacing: CGFloat = 4

    /// 换行计算本身：给定每枚标签的尺寸与可用宽度，算出整条要多高、每一枚摆在哪。
    ///
    /// 抽成纯函数是为了能被直接验红——视图层进不了单测，而"一枚都不能丢"这条
    /// 不变式只有在这里才守得住。
    static func place(sizes: [CGSize], maxWidth: CGFloat, spacing: CGFloat, lineSpacing: CGFloat)
        -> (size: CGSize, frames: [CGRect]) {
        var frames: [CGRect] = []
        frames.reserveCapacity(sizes.count)
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for size in sizes {
            // 只在"这一行已经有东西"时才折行：一枚本身就比可用宽度还长的标签
            // 也必须被摆出来，否则它就从界面上消失了。
            if x > 0, x + size.width > maxWidth {
                widest = max(widest, x - spacing)
                x = 0
                y += rowHeight + lineSpacing
                rowHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        widest = max(widest, x - spacing)
        return (CGSize(width: max(0, widest), height: sizes.isEmpty ? 0 : y + rowHeight), frames)
    }

    private func measure(_ subviews: Subviews, _ maxWidth: CGFloat)
        -> (size: CGSize, frames: [CGRect]) {
        Self.place(
            sizes: subviews.map { $0.sizeThatFits(ProposedViewSize(width: nil, height: nil)) },
            maxWidth: maxWidth, spacing: spacing, lineSpacing: lineSpacing
        )
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
        measure(subviews, proposal.width ?? .greatestFiniteMagnitude).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
        let placed = measure(subviews, bounds.width)
        for (index, frame) in placed.frames.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading, proposal: ProposedViewSize(frame.size)
            )
        }
    }
}

/// 取一个 app/二进制的真实图标。面板此前用 SF Symbol "app" 占位，
/// 结果顶部那个"要拖的东西"看着像一个渲染坏掉的空框。
enum AppIconLoader {
    static func icon(forPath path: String?) -> NSImage? {
        guard let path, !path.isEmpty else { return nil }
        let icon = NSWorkspace.shared.icon(forFile: path)
        // 缺失文件也会返回一个通用图标；size 为 0 才当作拿不到。
        return icon.size == .zero ? nil : icon
    }
}
