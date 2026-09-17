import Foundation

/// 操作权获取结果（P2 spec v2.0 §15.3）。
public enum OperationRightAcquisition: Equatable {
    /// 输入空闲窗口内无真实用户输入，成功独占操作权。
    case acquired
    /// 空闲窗口内仍有真实用户输入，不能独占操作（调用方等待后重试）。
    case idleNotMet
}

/// 一次操作持有操作权后的污染裁决。
public struct OperationRightVerdict: Equatable {
    /// 持有期间是否检测到任意 `.human` 输入事件。
    public let contaminated: Bool
    /// 持有的 `.human` 事件（进证据报告/日志，用于审计而非垄断 evidence）。
    public let humanEvents: [InputEvent]

    public init(contaminated: Bool, humanEvents: [InputEvent]) {
        self.contaminated = contaminated
        self.humanEvents = humanEvents
    }
}

/// 纯逻辑：输入空闲检测 + 操作权互斥 + 污染判定（C33 判定性核心）。
/// 可注入时钟与事件源，无 AX 依赖，100% 单测可覆盖（P2 spec v2.0 §15.3）。
///
/// 时间语义（与脚本化事件源配合精确构造"并行用户输入"）：
/// - **空闲检测**把 `acquire` 时刻已到达（`timestamp <= now`）且在空闲窗口内
///   （`now - idleWindowSeconds <= timestamp`）的 `.human` 事件视为"输入忙碌"；
/// - **污染判定**只统计持有期间到达的事件：`acquire` 时刻之后（`timestamp >= holdStart`）
///   的 `.human` 事件。因此脚本源可以预先排队一个时间戳在 `now` 之后的事件来精确
///   模拟"用户恰好在 act 进行中按下鼠标"。
public final class AttributionGuard {

    /// 默认输入空闲窗口：最近 500ms 内无真实输入视为可独占操作。
    public static let defaultIdleWindowSeconds: Double = 0.5

    private let inputSource: InputEventSource
    private let clock: () -> Date
    private let idleWindowSeconds: Double

    /// 当前是否持有操作权（并发防护的互斥状态）。
    private var holding = false
    /// 持有起点时间戳（epoch 秒）：污染只统计该时刻之后的 `.human` 事件。
    private var holdStartTimestamp: Double = 0
    /// 持有期间收集到的输入事件（monitorInput/release 累积）。
    private var collectedEvents: [InputEvent] = []

    public init(
        inputSource: InputEventSource,
        clock: @escaping () -> Date = { Date() },
        idleWindowSeconds: Double = AttributionGuard.defaultIdleWindowSeconds
    ) {
        self.inputSource = inputSource
        self.clock = clock
        self.idleWindowSeconds = idleWindowSeconds
    }

    /// 输入空闲检测：**非破坏性**快照事件源，若此刻已到达且落在空闲窗口内的
    /// `.human` 事件则拒绝获取；否则开始持有操作权并返回 `.acquired`。
    /// 已被持有期间重复调用返回 `.idleNotMet`。
    /// 注意：空闲检测不消费事件——时间戳在未来（act 进行中才到达）的事件会保留
    /// 在队列中，供 monitorInput/release 消费并如实计入污染裁决。
    public func acquireOperationRight() -> OperationRightAcquisition {
        guard !holding else { return .idleNotMet }
        let now = clock().timeIntervalSince1970
        let pending = inputSource.peekAvailable()
        let busy = pending.contains { event in
            guard event.source == .human else { return false }
            return event.timestamp <= now && event.timestamp >= now - idleWindowSeconds
        }
        if busy {
            return .idleNotMet
        }
        holding = true
        holdStartTimestamp = now
        collectedEvents.removeAll()
        return .acquired
    }

    /// 轮询事件源，把持有期间到达的事件累积进污染证据集合。
    public func monitorInput() {
        guard holding else { return }
        collectedEvents.append(contentsOf: inputSource.drain())
    }

    /// 结束持有并裁决：排空剩余事件，统计持有起点之后到达的 `.human` 事件。
    public func releaseOperationRight() -> OperationRightVerdict {
        guard holding else {
            return OperationRightVerdict(contaminated: false, humanEvents: [])
        }
        holding = false
        collectedEvents.append(contentsOf: inputSource.drain())
        let holdStart = holdStartTimestamp
        let humanEvents = collectedEvents.filter { event in
            event.source == .human && event.timestamp >= holdStart
        }
        let verdict = OperationRightVerdict(
            contaminated: !humanEvents.isEmpty,
            humanEvents: humanEvents
        )
        collectedEvents.removeAll()
        return verdict
    }

    /// 当前是否持有操作权。
    public var isHolding: Bool { holding }
}