import Foundation

/// `glasspaned` 那一个 `EngineCore` 的**带锁盒子**：主线程写、SIGTERM/SIGINT 收尾线程读。
///
/// 为什么必须存在（每日 2026-10-30，S1-2）。收尾 waiter 线程在 `main.swift` 里排在最前面创建
/// （R6-07：遮罩点上去了就必须立刻有人消费，否则信号挂在队列里、daemon 读起来像"杀不掉"），
/// 而核心要等探针监听、输入监控与 `EngineCore` 接线之后才存在。从前这里靠一个裸的
/// `var daemonCore: EngineCore?`：waiter 的闭包 `daemonCore?.inFlightOperationId()` 与主线程的
/// `daemonCore = core` 落在同一份**非原子**存储上（引用 + payload），一次落在那段窗口里的
/// SIGTERM 就是数据竞争——轻则收尾那句"这份证据没进档案是被打断、不是没产出"报上一个错的号，
/// 重则读到半个对象（`main.swift` 在 store **之后**还要 `core.stateRootPath = …`）。
/// 同一类缺陷在下一层已经修过一次：`EngineCore.swift:272-277`（S3-2）把 `activeOperationId` /
/// `shutdownRequested` 收进 `crossThreadStateLock`，TSan 实测两条 race；这次轮到指向核心的
/// 那一个引用本身。
///
/// 盒子只解决一件事：**读到的要么是"还没接好"（nil），要么是一个完整的、被写进去的核心**。
/// 它不改变启动顺序——`startShutdownWaiter` 仍旧排在一切可能慢的事情之前，这正是它存在的理由。
///
/// `@unchecked Sendable` 依据：唯一的存储 `_core` 的读写都在 `crossThreadStateLock` 里，
/// 与 `EngineCore` 的 S3-2 形状同一把锁、同一个规矩。
public final class DaemonCoreHolder: @unchecked Sendable {

    private let crossThreadStateLock = NSLock()
    private var _core: EngineCore?

    public init() {}

    /// 主线程唯一的写：核心接好了，收尾线程从此问得出在途的那一次 act。
    public func store(_ core: EngineCore) {
        crossThreadStateLock.lock()
        _core = core
        crossThreadStateLock.unlock()
    }

    /// 当前那个核心；nil 说的是"这一趟还没接好核心"——它是一个测量，不是一次猜测。
    public func current() -> EngineCore? {
        crossThreadStateLock.lock()
        defer { crossThreadStateLock.unlock() }
        return _core
    }

    /// 收尾 waiter 唯一需要的那一个读数：没有核心时 nil（这一次运行确实还没有任何 act 握着
    /// 操作权），有核心时转读那一个核心自己的锁保护面（`EngineCore.inFlightOperationId()`）。
    /// 两层锁顺序是 holder → core，反向路径不存在，所以不会成环。
    public func inFlightOperationId() -> String? {
        current()?.inFlightOperationId()
    }
}
