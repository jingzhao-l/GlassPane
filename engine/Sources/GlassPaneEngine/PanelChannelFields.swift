import Foundation

/// 面板人读面（EvidenceTabView 详情页）六通道的缺席/已测判定与缺席文案。
///
/// 报告面（`EvidenceReportGenerator`）已经给每个未测通道打一行 `not measured`
/// （R6-04 修齐六条）；面板详情面此前只在“测得时”渲染卡片，缺席的
/// `stateDiff`/`crash`/`handlerProbe` 直接整块消失，`responsiveness` 更是从未渲染——
/// 就是“没测到长得像没事”。这里把“这个通道测到了没有 + 没测到时看什么”抽成
/// 可测纯函数，面板对六个可选通道逐一渲染“已测数值”或“缺席不可用标记”，
/// 与报告面语义对齐（缺席必须被说出，缺席 ≠ 零命中/无变化）。
public enum PanelChannelFields {

    /// 六个可选通道在面板上的标题、图标与缺席理由。
    /// 缺席理由的语义与报告面 `* : not measured` 对齐，措辞换成中文给人看。
    public struct Entry: Equatable, Sendable {
        public let key: String
        public let title: String
        public let systemImage: String
        public let unmeasuredReason: String
    }

    public static let all: [Entry] = [
        Entry(
            key: "axEvent",
            title: "界面结构",
            systemImage: "list.bullet.indent",
            unmeasuredReason: "这次操作没有读到界面树（通道未启用或读取失败）。"
        ),
        Entry(
            key: "pixelDiff",
            title: "画面像素",
            systemImage: "photo",
            unmeasuredReason: "屏幕录制未授予或本次未捕获，画面通道没有数据。"
        ),
        Entry(
            key: "handlerProbe",
            title: "探针命中",
            systemImage: "antenna.radiowaves.left.and.right",
            unmeasuredReason: "这次操作没有收到探针上报（没有探针连接服务这段操作窗口）。"
        ),
        Entry(
            key: "stateDiff",
            title: "内部状态",
            systemImage: "number.square",
            unmeasuredReason: "这次操作没有读到内部状态（探针未上报状态通道）。"
        ),
        Entry(
            key: "responsiveness",
            title: "响应性",
            systemImage: "gauge.with.dots.needle.50percent",
            unmeasuredReason: "这次操作没有读到响应性往返（通道未启用或没有样本）。"
        ),
        Entry(
            key: "crash",
            title: "进程存活",
            systemImage: "heart.circle",
            unmeasuredReason: "这次操作没有读到进程存活样本（通道未启用）。"
        )
    ]

    /// 某通道在这一档信号里是否真的测到了（而不是缺席）。
    public static func isMeasured(_ entry: Entry, in signals: Signals) -> Bool {
        switch entry.key {
        case "axEvent": return signals.axEvent != nil
        case "pixelDiff": return signals.pixelDiff != nil
        case "handlerProbe": return signals.handlerProbe != nil
        case "stateDiff": return signals.stateDiff != nil
        case "responsiveness": return signals.responsiveness != nil
        case "crash": return signals.crash != nil
        default: return false
        }
    }

    /// 缺席通道的可读理由（没测到就要说出来，不渲染成空白）。
    public static func unmeasuredReasons(in signals: Signals) -> [String] {
        all.filter { !isMeasured($0, in: signals) }.map(\.unmeasuredReason)
    }

    /// 已测通道数 / 可选通道总数（一档里一共六条可选通道）。
    public static func measuredCount(in signals: Signals) -> Int {
        all.filter { isMeasured($0, in: signals) }.count
    }

    /// 六条可选通道的固定总数。
    public static var totalCount: Int { all.count }

    /// 按 key 取缺席理由（面板渲染缺席页签时用）。
    public static func reason(for key: String) -> String? {
        all.first { $0.key == key }?.unmeasuredReason
    }
}