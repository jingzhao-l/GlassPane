import Foundation

/// 输入事件来源类别（P2 spec v2.0 §15.2）。
/// `.agent` = AX 合成事件（agent 自身操作）；`.human` = CGEvent 全局捕获的真实用户输入。
public enum InputSource: String, Codable, Equatable {
    case agent
    case human
}

/// 一次输入事件：时间戳（epoch 秒，可注入时钟）+ 来源类别。
public struct InputEvent: Codable, Equatable {
    public let timestamp: Double
    public let source: InputSource

    public init(timestamp: Double, source: InputSource) {
        self.timestamp = timestamp
        self.source = source
    }
}

/// 输入事件源抽象：daemon 在持有操作权期间轮询的全局输入流。
public protocol InputEventSource: AnyObject {
    /// 取下一个尚未消费的输入事件；无事件时返回 nil（非阻塞轮询语义）。
    func nextEvent() -> InputEvent?
    /// 排空当前可消费的全部事件（用于 acquire 前/后的扫描窗口判定）。
    func drain() -> [InputEvent]
    /// 非破坏性快照：返回当前尚未消费的全部事件（不消费）。
    /// 空闲检测用它判断"此刻输入是否忙碌"，同时让时间戳在未来
    /// （即 act 进行中才到达）的事件保留在队列中，供 monitor/release 消费。
    ///
    /// **这里没有默认实现**（A10）。从前扩展里有一条 `[]`，语义是"没有已知输入"，
    /// 于是任何忘记覆盖它的 conformer 拿到的是一条**静默失效的忙碌闸**：
    /// `AttributionGuard.acquireOperationRight` 看到的 pending 永远为空，
    /// `GP_E_BUSY_INPUT` 永不触发，act 立刻获取操作权——而同一趟 act 写进证据包的
    /// `contaminationBasis` 仍然说"the input stream was watched for the whole
    /// operation window"（`EngineCore.swift:1309-1312`）。"读不到"被发布成了"没人在场"，
    /// 那是本仓反复在拆的形状（R2-05 对 `isMonitoringInput` 的同一件事）。
    ///
    /// 实测复核：daemon 生产路径**没有**依赖默认实现的 conformer——
    /// `main.swift:1601` 把 `AttributionGuard` 建在 `CGEventInputMonitor` 上，而它自己
    /// 实现了 `peekAvailable()`（`CGEventInputMonitor.swift:290`，读 `eventsBuffer.snapshot()`）；
    /// 仓内其余 conformer（`ScriptedInputEventSource` 与 5 个测试源）也各自实现。所以
    /// 这条默认实现唯一的作用是替**下一个**外部嵌入者把闸关掉。去掉它之后，"能不能
    /// 快照"必须是写在源里的一个决定；给不出诚实快照的源走下面那条登记路线。
    func peekAvailable() -> [InputEvent]
}

/// 没有非破坏性快照能力的源的**唯一**登记处（A10 的"否则如实记录"那一半）。
///
/// 一个只能给 `nextEvent()` 的源（只有消费式读法、或压根没有队列的桩）不能靠返回
/// `[]` 说自己空闲——那是把"读不到"变成"通过"。它也不该伪造一条 `.human` 事件来
/// 让闸拒绝：`AttributionGuard.swift:116-124` 对"编一个看不到的数字"写过判据，
/// 而一条假的按键同样会进 `humanEvents` 的读者面。
///
/// 真有一条诚实的路，而且已经在跑：`AttributionGuard` 每次 acquire/release 都问一次
/// `InputSourceMonitoring`（`AttributionGuard.swift:111-114`、裁决决定点 :247-253），
/// 答"没在测"就把这个窗口折成 `monitored: false` + `contaminated: true`，归因停在
/// `.weak`、永不升 `.strong`，并把具名原因写进 `contaminationBasis`。继承下面这组
/// 默认实现就等于**申报**："我这边的忙碌闸未启用，因为这条流给不出未消费快照"——
/// 于是证据说的是一句量到的话，而不是"整段都有人看着"。
///
/// 名字里带上"WithoutIdlePeek"是为了让读代码的人看见这是一条声明，不是一个开关。
public protocol InputEventSourceWithoutIdlePeek: InputEventSource, InputSourceMonitoring {
    /// 为什么这条流给不出非破坏性快照（进 `contaminationBasis`，具名、可追）。
    var idlePeekUnavailableReason: String { get }
}

public extension InputEventSourceWithoutIdlePeek {
    /// 没有快照能力，所以**不碰队列**：忙碌闸这一段无话可说，队列原样留给
    /// `drain()`，持有期间的污染判定（那是另一条测量）逐字不受影响。
    func peekAvailable() -> [InputEvent] { [] }

    /// 诚实的那一半：这一族的源自报"没有在测"，理由就是它答不了空闲问题。
    /// 守卫据此把窗口折成未监测，`EngineCore` 的 basis 落到
    /// "the input monitor stopped reporting inside this window: …" 那一条分支。
    var isMonitoringInput: Bool { false }

    var inputMonitoringFault: String? {
        "the idle-input gate is not enabled for this source: it cannot answer what is un-consumed right now (\(idlePeekUnavailableReason)), so an empty busy check here measures nothing and is not reported as an unattended-free window"
    }
}

extension InputEventSource {
    /// 默认实现：反复 nextEvent() 直至 nil。
    public func drain() -> [InputEvent] {
        var collected: [InputEvent] = []
        while let event = nextEvent() {
            collected.append(event)
        }
        return collected
    }

    /// A10：这里从前是 `peekAvailable() -> [InputEvent] { [] }`，也就是"没有已知输入"。
    /// 它已被删除——协议要求每个源自己回答这个问题；答不了的源必须声明
    /// `InputEventSourceWithoutIdlePeek`（上面那个协议会把"忙碌闸未启用"如实折进
    /// 污染裁决），而不是继承一句"没人在碰机器"。
}

/// 脚本化事件源：按预置队列回放，供单元测试精确构造"并行用户输入"场景。
public final class ScriptedInputEventSource: InputEventSource {
    private var queue: [InputEvent]

    public init(events: [InputEvent]) {
        self.queue = events
    }

    public func nextEvent() -> InputEvent? {
        guard !queue.isEmpty else { return nil }
        return queue.removeFirst()
    }

    public func peekAvailable() -> [InputEvent] {
        queue
    }
}