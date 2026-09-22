import Foundation

/// 操作权获取结果（P2 spec v2.0 §15.3）。
public enum OperationRightAcquisition: Equatable {
    /// 输入空闲窗口内无真实用户输入，成功独占操作权。
    case acquired
    /// 空闲窗口内仍有真实用户输入，不能独占操作（调用方等待后重试）。
    case idleNotMet
}

/// 可选能力：事件源自报"现在还在不在测"。`InputEventSource` 本身只描述事件流，
/// 而"零事件"既可能是"没人碰机器"也可能是"通道断了"——只有源自己分得清。
/// 声明在这里而不是 `InputEventSource.swift`（协议面属他人文件，本轮不动）。
///
/// 不实现本协议的源（如测试用的 `ScriptedInputEventSource`）按**在测**处理：
/// 它们的事件是显式喂进队列的，不存在"通道悄悄掉了"这种状态。
public protocol InputSourceMonitoring: AnyObject {
    /// 当前是否真的在投递事件。false ⇒ 本窗口的"零事件"不构成观测结论。
    var isMonitoringInput: Bool { get }
    /// 不在测的原因（在测时应为 nil）；只进日志/诊断，不改冻结的证据形状。
    var inputMonitoringFault: String? { get }
}

/// 一次操作持有操作权后的污染裁决。
public struct OperationRightVerdict: Equatable {
    /// 持有期间是否检测到任意 `.human` 输入事件；**通道未监测时这是保守值
    /// true**，不是"看到了人类输入"的结论（见 `monitored`）。
    public let contaminated: Bool
    /// 持有的 `.human` 事件（进证据报告/日志，用于审计而非垄断 evidence）。
    /// 未监测时它如实为空——空集合是"没抓到事件"，不是"没发生"。
    public let humanEvents: [InputEvent]
    /// 本次持有期间输入通道是否始终在监测。false ⇒ `contaminated` 是"未测量"
    /// 折算出的保守值，裁决不承载任何肯定结论。
    public let monitored: Bool
    /// `monitored == false` 时源给出的原因串（CGEvent tap 停用/权限掉线…）。
    public let monitoringFault: String?

    public init(
        contaminated: Bool,
        humanEvents: [InputEvent],
        monitored: Bool = true,
        monitoringFault: String? = nil
    ) {
        self.contaminated = contaminated
        self.humanEvents = humanEvents
        self.monitored = monitored
        self.monitoringFault = monitoringFault
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
///
/// 通道存活（R2-05）：源实现 `InputSourceMonitoring` 且自报"没在测"时，本窗口
/// 判 `monitored: false` 并取保守的 `contaminated: true` —— 零投递不再是"没人碰
/// 机器"的证据。未实现该协议的源（测试脚本源）视为在测，判定语义逐字不变。
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
    /// 本次持有期间通道是否**一直**在监测（acquire 起每轮采样取与）。
    private var holdMonitored = true
    /// 第一次采样到"没在测"时原因串（后续故障不覆盖，留因果那一条）。
    private var holdMonitoringFault: String?

    /// 源是否自报存活。未实现 `InputSourceMonitoring` 的源视为在测。
    private func currentMonitoring() -> (monitored: Bool, fault: String?) {
        guard let source = inputSource as? InputSourceMonitoring else { return (true, nil) }
        return (source.isMonitoringInput, source.inputMonitoringFault)
    }

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
    ///
    /// `degradeOnBusy`（R21 可声明降级，P6 §11 审计落实）：窗口忙时**照样**
    /// 获取操作权并放行，但把持有起点回拨到空闲窗口起点——触发忙碌的那批
    /// human 事件在 release 时如实体现在污染裁决里（weak + contaminated=true），
    /// 绝不静默冒充干净。
    public func acquireOperationRight(degradeOnBusy: Bool = false) -> OperationRightAcquisition {
        guard !holding else { return .idleNotMet }
        let now = clock().timeIntervalSince1970
        let pending = inputSource.peekAvailable()
        let busyEvents = pending.filter { event in
            guard event.source == .human else { return false }
            return event.timestamp <= now && event.timestamp >= now - idleWindowSeconds
        }
        if !busyEvents.isEmpty && !degradeOnBusy {
            return .idleNotMet
        }
        holding = true
        // Clean acquisition starts the hold now; a degraded one backdates to the
        // window start so the busy human events are charged into the verdict.
        holdStartTimestamp = busyEvents.isEmpty ? now : now - idleWindowSeconds
        collectedEvents.removeAll()
        // 通道不存活时**照样**放行获取：互斥功能仍然成立，而且拒绝获取会把 act
        // 永久打死（没有第二条输入通道可等），那是假保险。诚实改在 release 侧
        // 兑现——见 releaseOperationRight 里的裁决决定点。
        let sample = currentMonitoring()
        holdMonitored = sample.monitored
        holdMonitoringFault = sample.monitored ? nil : sample.fault
        return .acquired
    }

    /// 轮询事件源，把持有期间到达的事件累积进污染证据集合。
    public func monitorInput() {
        guard holding else { return }
        sampleMonitoring()
        collectedEvents.append(contentsOf: inputSource.drain())
    }

    /// 采样通道存活位：一旦掉过就固定在"未监测"，原因保留第一条。
    private func sampleMonitoring() {
        let sample = currentMonitoring()
        guard !sample.monitored else { return }
        if holdMonitoringFault == nil {
            holdMonitoringFault = sample.fault
        }
        holdMonitored = false
    }

    /// 结束持有并裁决：排空剩余事件，统计持有起点之后到达的 `.human` 事件。
    public func releaseOperationRight() -> OperationRightVerdict {
        // 收尾再采样一次：tap 可能在 act 进行中途断掉而 caller 没调 monitorInput。
        sampleMonitoring()
        let monitored = holdMonitored
        let monitoringFault = monitored ? nil : holdMonitoringFault
        guard holding else {
            // 未持有 = 没有测量窗口。通道断了同样不能报"干净"。
            return OperationRightVerdict(
                contaminated: !monitored,
                humanEvents: [],
                monitored: monitored,
                monitoringFault: monitoringFault
            )
        }
        holding = false
        collectedEvents.append(contentsOf: inputSource.drain())
        let holdStart = holdStartTimestamp
        let humanEvents = collectedEvents.filter { event in
            event.source == .human && event.timestamp >= holdStart
        }
        // ★ 裁决决定点（R2-05）：**未监测窗口不得判成干净**。CGEvent tap 被系统
        // 停用后通道零投递，而"零投递"与"这段时间确实没人碰机器"在事件流里无法
        // 区分。既有类型里唯一保守的取值就是 `contaminated: true` —— EngineCore
        // 据此走 `.weak`（永不升级 `.strong`），也就是宁可放弃归因强度，也不把
        // "没测到"当"没发生"。`monitored: false` + `monitoringFault` 说明这个
        // true 来自通道断了而不是来自抓到的人类输入；`humanEvents` 仍如实为空。
        let verdict = OperationRightVerdict(
            contaminated: !monitored || !humanEvents.isEmpty,
            humanEvents: humanEvents,
            monitored: monitored,
            monitoringFault: monitoringFault
        )
        collectedEvents.removeAll()
        holdMonitored = true
        holdMonitoringFault = nil
        return verdict
    }

    /// 当前是否持有操作权。
    public var isHolding: Bool { holding }
}