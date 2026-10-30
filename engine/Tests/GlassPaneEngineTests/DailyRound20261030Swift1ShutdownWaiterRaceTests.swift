import XCTest
import Foundation
@testable import GlassPaneEngine

/// 每日任务 2026-10-30 · 泳道 1 · 缺陷 2：SIGTERM/SIGINT 收尾线程**无同步地**读
/// `glasspaned` 主线程正在写的那一个 `var daemonCore: EngineCore?`。
///
/// 危害。`main.swift:1983` 先把消费线程起起来（R6-07：遮罩点上去了就必须立刻有人消费，
/// 否则信号挂在队列里、daemon 读起来像"杀不掉"），而 `var daemonCore: EngineCore?` 声明在
/// `:2024`、写在 `:2070`。落在那段窗口里的一次 SIGTERM 让消费线程在主线程写同一个 Optional
/// 时读它——`Optional<引用>` 是引用 + payload，不是原子量：轻则收尾那一句"这份证据没进档案是
/// 被 interrupted、不是没产出"报上错误的号，重则读到半个对象（main 在 store **之后**还要
/// `core.stateRootPath = …`）。同一类缺陷在下一层已经修过一次：`EngineCore.swift:272-277`
/// （S3-2）把 `activeOperationId` / `shutdownRequested` 收进 `crossThreadStateLock`，TSan 实测
/// 两条 race —— 但**指向核心的那一个引用本身**一直是裸的。
///
/// 修法不动的那一条性质：`startShutdownWaiter` 仍然排在最前面（`main.swift:1973-1982` 记的就是
/// "遮罩先于慢事，消费线程先于一切能慢的东西"）。收进锁的是那个盒子，不是启动顺序。
///
/// REVERSE：把 waiter 的读数改回 `daemonCore?.inFlightOperationId()` → 第一条红；把盒子换成裸
/// `var`（去掉锁）→ 第三条红；把 `startShutdownWaiter` 挪回最后一行 → 第二条（顺序闸）红。
final class DailyRound20261030Swift1ShutdownWaiterRaceTests: XCTestCase {

    // MARK: - 源码对照夹具（本仓先例：接线在可执行目标的顶层代码里，import 不动，只能数代码行）

    private func engineSource(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/\(relative)")
        // 缺文件是一次**失败**而不是跳过：这条闸的对照物一旦被整块搬走，静默通过就等于没有闸。
        return try XCTUnwrap(
            try? String(contentsOf: url, encoding: .utf8),
            "读不到 \(url.path)——这一条源码对照没有对照物了"
        )
    }

    /// 只数代码行：注释里提一次函数名不算一次调用（`DailyRound20261029Swift3` 同一判据）。
    private func codeOnly(_ text: String) -> String {
        text.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.hasPrefix("//") && !$0.hasPrefix("/*") && !$0.hasPrefix("*") }
            .joined(separator: "\n")
    }

    // MARK: - 闸

    /// 消费线程不许再读那一个裸 Optional：`main.swift` 里既不能再有 `var daemonCore: EngineCore?`
    /// 的声明，也不能再有 `daemonCore?.…` 的读法——两侧任一处退回裸引用，两个线程就又在读同一个
    /// 没有同步的存储上。
    func testWaiterNeverReadsABareOptionalDaemonCore() throws {
        let code = codeOnly(try engineSource("glasspaned/main.swift"))
        XCTAssertNil(code.range(of: "var daemonCore: EngineCore?"),
                     "那个裸盒子又回来了：主线程在写、waiter 线程在读同一个非原子 Optional")
        XCTAssertNil(code.range(of: "daemonCore?"),
                     "waiter 又在按可选链读裸引用（\(code.range(of: "daemonCore?").map { String(code[$0]).prefix(80) } ?? "")）")
        XCTAssertNotNil(code.range(of: "daemonCore.inFlightOperationId()"),
                        "收尾线程的读数必须走盒子的取值方法——那是它唯一的读者")
        XCTAssertNotNil(code.range(of: "daemonCore.store("),
                        "主线程的写必须走盒子的 setter，否则锁根本没接上")
    }

    /// 顺序性质一条不许退化：消费线程仍旧在核心被建出来**之前**起（R6-07 的整条理由）。
    func testWaiterStillStartsBeforeTheCoreExists() throws {
        let code = codeOnly(try engineSource("glasspaned/main.swift"))
        let waiter = try XCTUnwrap(code.range(of: "startShutdownWaiter(registry:"),
                                          "收尾消费线程的启动点不见了")
        let store = try XCTUnwrap(code.range(of: "daemonCore.store(", range: waiter.upperBound..<code.endIndex),
                                  "找不到那次 store：waiter 起在写之前这条对照没有对照物")
        XCTAssertTrue(waiter.lowerBound < store.lowerBound,
                      "waiter 又被挪到最后才起了：遮罩与 store 之间那段窗口里 SIGTERM 无人消费")
    }

    /// 盒子住在被 import 的那一侧（可执行目标的顶层代码 import 不动，判据因此必须落在库里才能
    /// 直接跑），而且读写共用同一把锁——`EngineCore` 的 S3-2 形状就是这里的先例。
    func testHolderSynchronisesStoreAndReadOnOneLock() throws {
        let code = codeOnly(try engineSource("GlassPaneEngine/DaemonCoreHolder.swift"))
        XCTAssertFalse(code.isEmpty, "盒子不在库里：两个线程又在各读各的存储上")
        XCTAssertNotNil(code.range(of: "NSLock"), "没有锁——那只是一个换了名字的裸 var")
        let write = try XCTUnwrap(code.range(of: "func store("), "找不到 setter")
        let read = try XCTUnwrap(code.range(of: "func current()"), "找不到 getter")
        for (name, site) in [("store", write), ("current", read)] {
            let limit = code.index(site.upperBound, offsetBy: 400, limitedBy: code.endIndex) ?? code.endIndex
            let tail = code[site.lowerBound..<limit]
            XCTAssertTrue(tail.contains(".lock()"), "\(name) 没有取锁：\(String(tail.prefix(200)))")
        }
    }

    // MARK: - 盒子本体：并发写读下不许出现半个核心、凭空一个号

    /// 非 nil 读数必须永远是一个**完整成形**的本次 operationId：形状合法，不是撕裂指针读出来的
    /// 乱码，也不是半释放的 buffer（判据与 `DailyRound20261029Swift2ConcurrentOperationIdTests`
    /// 同源——`[0-9A-F]{26}` 装不下真 id，这里按 `OperationID.crockfordAlphabet` 取全集）。
    private func isValid(_ id: String) -> Bool {
        guard id.hasPrefix(OperationID.prefix),
              id.count == OperationID.prefix.count + OperationID.totalLength else { return false }
        let allowed = Set(OperationID.crockfordAlphabet)
        return id.dropFirst(OperationID.prefix.count).allSatisfy { allowed.contains($0) }
    }

    func testHolderAnswersNilBeforeAnyCoreIsStored() {
        let holder = DaemonCoreHolder()
        XCTAssertNil(holder.current(), "没写过时不许凭空有一个核心")
        XCTAssertNil(holder.inFlightOperationId(), "没有核心时那句「没在途 act」是一次测量，不是猜出来的号")
    }

    func testStoredCoreIsTheOneTheWaiterReads() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, settle: {})
        let holder = DaemonCoreHolder()
        XCTAssertTrue(holder.current() == nil)
        holder.store(core)
        XCTAssertTrue(holder.current() === core, "读出来的必须是写进去的那一个")
        XCTAssertNil(holder.inFlightOperationId(), "没在途 act 时读数仍是 nil")
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        var seenByWaiter: String?
        channel.onPerformAction = { seenByWaiter = holder.inFlightOperationId() }
        _ = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(seenByWaiter, pack.operationId,
                       "接好之后收尾线程问得出的就是那一次 act 的号——它是那句「被打断」的唯一读数")
        XCTAssertNil(holder.inFlightOperationId(), "act 收完之后必须清空")
    }

    /// 线程 1 跑 act（在途号在 nil ↔ 号 之间来回写），线程 2 在两个核心之间来回 store，线程 3
    /// 死读盒子的两个出口。三条不变量：读到的核心必须是被写进去过的**那一个**（不是半个引用）、
    /// 读到的号必须是某一次**真跑过**的 act 的号、形状必须完整。
    /// 修前这里读的是裸 `Optional`（写者正在装引用与 payload、读者同时取），与 S3-2 在
    /// `EngineCore` 里那两条 TSan race 同一类；锁收进来之后同一段跑法干净。
    func testConcurrentStoreAndReadNeverTearsTheCore() throws {
        let busy = ScriptedChannel(fallbackTree: TestTrees.standard)
        let coreA = EngineCore(channel: busy, settle: {})
        let idle = ScriptedChannel(fallbackTree: TestTrees.standard)
        let coreB = EngineCore(channel: idle, settle: {})
        _ = try coreA.attach(bundleId: "com.example.app", pid: nil)

        let holder = DaemonCoreHolder()
        let gate = NSLock()
        var stored: Set<ObjectIdentifier> = []
        var observed: [ObjectIdentifier] = []
        var readIds: [String] = []
        var ranIds: Set<String> = []
        var malformed: [String] = []
        var stop = false
        func stopped() -> Bool { gate.lock(); defer { gate.unlock() }; return stop }
        let validate = isValid

        let reader = Thread {
            while !stopped() {
                if let core = holder.current() {
                    gate.lock(); observed.append(ObjectIdentifier(core)); gate.unlock()
                }
                if let id = holder.inFlightOperationId() {
                    gate.lock()
                    readIds.append(id)
                    if validate(id) { } else { malformed.append(id) }
                    gate.unlock()
                }
            }
        }
        let swapper = Thread {
            var flip = false
            while !stopped() {
                let core = flip ? coreB : coreA
                holder.store(core)
                gate.lock(); stored.insert(ObjectIdentifier(core)); gate.unlock()
                flip.toggle()
            }
        }
        reader.start()
        swapper.start()

        let selector = Selector(role: "AXButton", title: "Submit")
        for _ in 0..<120 {
            let result = try coreA.act(selector: selector, action: .press)
            if let id = result["operationId"] as? String {
                gate.lock(); ranIds.insert(id); gate.unlock()
            }
        }
        gate.lock(); stop = true; gate.unlock()
        var waited = 0.0
        while reader.isExecuting || swapper.isExecuting, waited < 5 {
            Thread.sleep(forTimeInterval: 0.01); waited += 0.01
        }

        XCTAssertFalse(observed.isEmpty, "读者一次都没撞上核心 ⇒ 这条并发用例什么都没测（夹具失效，不是通过）")
        XCTAssertFalse(readIds.isEmpty, "读者一次都没撞上在途号 ⇒ 同上")
        XCTAssertEqual(malformed, [], "读到过形状不对的 id（撕裂 / 陈旧 buffer 的读数）：\(malformed)")
        for identity in Set(observed) {
            XCTAssertTrue(stored.contains(identity),
                          "读到过一个从未被 store 过的核心引用——那正是裸 Optional 上会撕出来的半个对象")
        }
        let invented = Set(readIds).subtracting(ranIds)
        XCTAssertEqual(invented, [], "收尾那句「被打断」报过一次没有人跑过的号：\(invented)")
    }
}
