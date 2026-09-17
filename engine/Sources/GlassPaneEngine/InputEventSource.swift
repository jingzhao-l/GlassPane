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
    func peekAvailable() -> [InputEvent]
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

    /// 默认实现：不具备非破坏性快照能力的事件源在空闲检测时拿不到未消费事件，
    /// 视为"无已知输入"（acquire 保守放行，污染由持有期间的 drain 如实判定）。
    public func peekAvailable() -> [InputEvent] {
        []
    }
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