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
    /// 这一轮里源有没有把自己的事件队列挤掉过投递（读后清零的观测位，形状同
    /// `CGEventInputMonitor.disabledSinceLastCheck()`）。
    ///
    /// true ⇒ 队列的**头部**没了：守卫随后 drain 到的 `humanEvents == []` 只说明
    /// "队尾没迟到者"，不说明"这段没人碰机器"。它和"通道断了"是同一级事实缺口，
    /// 所以走同一条折叠（见 `noteDroppedEvents`）。
    ///
    /// 声明成协议成员**并在扩展里给默认实现**，而不是给 conformer 加一个必须实现
    /// 的成员：没有事件队列的源（两个测试脚本源）逐字维持今天的行为——对它们来说
    /// "没挤掉"就是真话，而要求它们各自写一遍 false 只会让下一个 conformer 忘了写。
    func inputEventsDroppedSinceLastCheck() -> Bool
    /// 这一轮里源有没有**自己掉过一次、又装回来了**（读清位，形状同上两条：一位读者
    /// 问"自上次以来发生过吗"，次数在 `CGEventInputMonitor.tapDisableCount` 上）。
    ///
    /// 这一问不能被前两问代替，因为前两问都是**采样时刻**的：tap 在两次采样之间被系统
    /// 停用又在下一次采样前装回来时，`isMonitoringInput` 采到的仍是真，`humanEvents`
    /// 也照样为空——而那段没人看的时间恰好是最早那几条人类输入最可能落在的地方。裁决
    /// 里那句 "the input stream was watched for the whole operation window"
    /// （`EngineCore`）说的就是"全程"，缺这一问它就是没被兑现的主张。
    ///
    /// 同一条折叠规则：声明成协议成员 + 扩展里给默认实现，没有"掉过又装回"这种状态的源
    /// （测试脚本源）逐字维持今天的行为。
    func inputTapDisabledSinceLastCheck() -> Bool
}

public extension InputSourceMonitoring {
    /// 缺省答案：**没有投递被挤掉**。只在源自己没有队列时才是缺省值——有队列的
    /// 源必须覆盖它，否则"缓冲区溢过"这件事又一次无人知晓。
    func inputEventsDroppedSinceLastCheck() -> Bool { false }
    /// 缺省答案：**没有停用发生过**。同上——只对着"没有重装这回事"的源才成立。
    func inputTapDisabledSinceLastCheck() -> Bool { false }
}

/// 一次操作持有操作权后的污染裁决。
public struct OperationRightVerdict: Equatable {
    /// 持有期间是否检测到任意 `.human` 输入事件；**通道未监测时这是保守值
    /// true**，不是"看到了人类输入"的结论（见 `monitored`）。
    public let contaminated: Bool
    /// 持有的 `.human` 事件（进证据报告/日志，用于审计而非垄断 evidence）。
    /// 未监测时它如实为空——空集合是"没抓到事件"，不是"没发生"。
    public let humanEvents: [InputEvent]
    /// 本次持有期间输入通道是否**全程**在监测、且这一段观测没被截短（队列挤掉过
    /// 投递就不算全程）。false ⇒ `contaminated` 是"未测量"
    /// 折算出的保守值，裁决不承载任何肯定结论。
    public let monitored: Bool
    /// `monitored == false` 时源给出的原因串（CGEvent tap 停用/权限掉线/缓冲区
    /// 把这一轮最早的投递挤掉了…）。
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
///
/// 观测被截短（每日任务 2026-10-22）：同一个折叠也接住"源在测、但把这一轮最早
/// 的那批投递挤掉了"（`inputEventsDroppedSinceLastCheck()`）。此时 `humanEvents`
/// 照样为空，而那个空是残缺队列的尾部，不是一次测量——所以本窗口同样判
/// `monitored: false` + `contaminated: true`，`monitoringFault` 具名写清不知道的是
/// 哪一件事。默认实现回 false 的源逐字不变。
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
    /// 缓冲区把这一轮的事件挤掉了也记在这里：那同样是"这一段没测完"的一条原因。
    private var holdMonitoringFault: String?

    /// 源是否自报存活。未实现 `InputSourceMonitoring` 的源视为在测。
    private func currentMonitoring() -> (monitored: Bool, fault: String?) {
        guard let source = inputSource as? InputSourceMonitoring else { return (true, nil) }
        return (source.isMonitoringInput, source.inputMonitoringFault)
    }

    /// 观测被截短的那条具名原因：写清**不知道的是哪一件事实**，而不是只说"丢了
    /// 几个事件"。挤掉的是队首，所以窗口最早的那批投递无从复原；不写条数是因为
    /// 这一位读者手里只有"掉过/没掉过"，条数在源的累计观测面上
    /// （`CGEventInputMonitor.droppedEventCount`）——编一个看不到的数字进来，
    /// 就是本文件反复在拆的那类假精度。
    private static let droppedEventsFault =
        "input event buffer overflowed during this window: the oldest delivered events were evicted "
        + "before the guard drained the queue, so what happened at the start of the window is unknown "
        + "and an empty humanEvents here measures nothing"

    /// 掉线-重装那一问的具名原因：说清**不知道的是哪一段**——停用与重装之间的事件不会
    /// 补投，而重装后的存活位看不出那段空档存在过。
    private static let tapDisabledFault =
        "the input tap was disabled and re-armed inside this window: events delivered while it was "
        + "down are not replayed, so the channel being alive at both samples does not mean it watched "
        + "the interval between them"

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
        // acquire 这一采也问一次截短：此刻位上若还挂着"上一段里溢过"，被挤掉的
        // 那批正是上面 `peekAvailable()` 读过头部的队列，而本次持有的起点还可能
        // 回拨到那段里（`degradeOnBusy`）——这段的开头同样没人知道，不是冤枉账。
        noteDroppedEvents()
        noteTapDisabled()
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
        if !sample.monitored {
            if holdMonitoringFault == nil {
                holdMonitoringFault = sample.fault
            }
            holdMonitored = false
        }
        // 存活位为真不等于这一轮**测全了**：队列还在投、但最早那几条已经被容量
        // 挤掉，drain 出来的 `humanEvents` 照样为空；tap 也可能在两次采样之间掉了
        // 又装回来，两次采样都读到真。三次提问合起来才回答"这个窗口有人看着吗"，
        // 缺一条都得把窗口折成未监测。
        noteDroppedEvents()
        noteTapDisabled()
    }

    /// 源这一轮挤掉过投递 ⇒ 把本窗口按监测故障折叠：`holdMonitored = false` +
    /// 具名 `holdMonitoringFault`，于是裁决点（`contaminated: !monitored ||
    /// !humanEvents.isEmpty`）不可能把这段发布成干净，归因停在 `.weak`，档案里
    /// 的 `contaminationBasis` 带着"哪一段观测没了"这句话。
    /// 未实现 `InputSourceMonitoring` 的源、以及落在默认实现上的源逐字不变。
    private func noteDroppedEvents() {
        guard let source = inputSource as? InputSourceMonitoring else { return }
        guard source.inputEventsDroppedSinceLastCheck() else { return }
        holdMonitored = false
        if holdMonitoringFault == nil {
            holdMonitoringFault = Self.droppedEventsFault
        }
    }

    /// 掉线-重装同样按监测故障折叠（与 `noteDroppedEvents` 同一条裁决通路、同一个理由）：
    /// 存活位为真只说明**采样那一刻**有人看着。落在这段之间的那次停用，正是"零投递"与
    /// "没人碰机器"无法区分的另一种来历，所以窗口照样折成未监测、`contaminated` 照样取
    /// 保守的 true。未实现 `InputSourceMonitoring` 的源与落在默认实现上的源逐字不变。
    private func noteTapDisabled() {
        guard let source = inputSource as? InputSourceMonitoring else { return }
        guard source.inputTapDisabledSinceLastCheck() else { return }
        holdMonitored = false
        if holdMonitoringFault == nil {
            holdMonitoringFault = Self.tapDisabledFault
        }
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