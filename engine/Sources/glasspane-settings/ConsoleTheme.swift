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
                Image(systemName: "doc.on.doc")
                    .font(.caption2)
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
