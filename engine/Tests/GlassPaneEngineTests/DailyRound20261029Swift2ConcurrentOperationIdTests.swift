import XCTest
@testable import GlassPaneEngine

/// S3-2（每日 2026-10-29，泳道 3）：`EngineCore.activeOperationId`（声明 :270，写 :895/:906）
/// 被 SIGTERM waiter 线程与 service 线程**无同步地**读写 ⇒ 数据竞争。轻则那条"这份证据
/// 没进档案是被打断、不是没产出"的唯一陈述报上一个操作号或 nil，重则读到刚释放的 buffer、
/// 收尾变 SIGSEGV——把"退出码 0 + socket unlink"那条真机承诺换掉。
///
/// 控制形状：线程 A 反复 `act`，线程 B 反复读并把非 nil 值按 `op_` + 26 位 Crockford
/// base32 校验（台账口述的 `[0-9A-F]{26}` 装不下真 id——ULID 字母表超出十六进制，
/// 严格照抄会让修后的绿也红，这里按 `OperationID.crockfordAlphabet` 取全集）。
/// 修前在 `--sanitize=thread` 下必须报 data race（能红的证据），修后 TSan 干净。
///
/// 既有同线程用例 `DailyRound20261028UsageAndHonestyTests.testActiveOperationIdIsVisibleDuringActAndClearedAfter`
/// 保持绿：对外读数面（属性）逐字不变，收敛的只是同步原语。
///
/// REVERSE：把锁摘掉（读写回裸存储）→ TSan 复跑立刻报回 data race；把 waiter 取值方法
/// 接错（`inFlightOperationId()` 恒 nil / 恒读上一号）→ `testAccessorsAgreeWithTheProperty`
/// 与收尾文本闸红。
final class DailyRound20261029Swift2ConcurrentOperationIdTests: XCTestCase {

    /// 非 nil 观测值必须永远是一个**完整成形**的本次 operationId：形状合法、不是撕裂
    /// 指针读出来的乱码，也不是半释放的 buffer。
    private func isValid(_ id: String) -> Bool {
        guard id.hasPrefix(OperationID.prefix),
              id.count == OperationID.prefix.count + OperationID.totalLength else {
            return false
        }
        let allowed = Set(OperationID.crockfordAlphabet)
        return id.dropFirst(OperationID.prefix.count).allSatisfy { allowed.contains($0) }
    }

    func testConcurrentReaderNeverTearsTheInFlightOperationId() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let selector = Selector(role: "AXButton", title: "Submit")

        let lock = NSLock()
        var malformed: [String] = []
        var validNonNilReads = 0
        var totalReads = 0
        var stop = false

        func stopFlag() -> Bool {
            lock.lock(); defer { lock.unlock() }
            return stop
        }

        let validate = isValid

        let reader = Thread {
            while !stopFlag() {
                // 读的是对外属性面本身——修前它是 `public private(set) var`（无锁），
                // 修后是走锁的计算属性；两条路这里都不许 TSan 报这个属性。
                if let id = core.activeOperationId {
                    lock.lock()
                    totalReads += 1
                    if validate(id) { validNonNilReads += 1 } else { malformed.append(id) }
                    lock.unlock()
                } else {
                    lock.lock(); totalReads += 1; lock.unlock()
                }
            }
        }
        reader.start()

        let actRounds = 120
        for _ in 0..<actRounds {
            _ = try core.act(selector: selector, action: .press)
        }

        lock.lock(); stop = true; lock.unlock()
        // 等读者退出：1s 的 poll 粒度下它最多再跑一圈。
        var waited = 0.0
        while reader.isExecuting, waited < 5 {
            Thread.sleep(forTimeInterval: 0.01); waited += 0.01
        }

        XCTAssertEqual(malformed, [], "读到过形状不对的 id（撕裂/陈旧 buffer 的读数）：\(malformed)")
        XCTAssertGreaterThan(
            validNonNilReads, 0,
            "读者一次都没撞上在途 id ⇒ 这条并发用例什么都没测（夹具失效，不是通过）"
        )
        XCTAssertNil(core.activeOperationId, "全部 act 收完之后必须没有残留在途 id")
    }

    /// 修后的取值方法面：waiter（`glasspaned/main.swift` 的 SIGTERM 收尾）从此走
    /// `inFlightOperationId()`，与属性读数在同一个事实源上——两问答案不许分叉；
    /// 正常返回与抛错两条出路都必须清空（与 2026-10-28 同线程用例同一判据，这里
    /// 验的是方法面本身）。
    func testAccessorsAgreeWithTheProperty() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertNil(core.inFlightOperationId(), "没在途 act 时取值方法不许凭空有一个 id")
        XCTAssertEqual(core.inFlightOperationId(), core.activeOperationId)

        var seenByHook: String?
        channel.onPerformAction = { seenByHook = core.inFlightOperationId() }
        _ = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(seenByHook, pack.operationId, "act 在途时取值方法必须点名这一次的 id")
        XCTAssertNil(core.inFlightOperationId(), "返回后必须清空")

        channel.actionError = .actRejected(reason: "scripted refusal")
        XCTAssertThrowsError(try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press))
        XCTAssertNil(core.inFlightOperationId(), "抛错路径留着 id = 下一个窗口替一次没发生的 act 说话")
    }

    /// `shutdownRequested`（S3-2 同批被跨线程读的字段）：写只经 `shutdown()`，读走锁。
    /// 修前 TSan 红里的第二条 race 就是 `shutdown()`(:1960) vs `SocketServer.serve`(:305)。
    func testShutdownRequestedReadIsSynchronizedToo() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, settle: {})
        XCTAssertFalse(core.shutdownRequested)
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            _ = core.shutdown()
            finished.signal()
        }
        var seen = false
        let spinUntil = Date().addingTimeInterval(2)
        while Date() < spinUntil {
            if core.shutdownRequested { seen = true; break }
            if finished.wait(timeout: .now()) == .success { break }
        }
        if !seen { _ = finished.wait(timeout: .now() + 2) }
        XCTAssertTrue(core.shutdownRequested, "shutdown() 写过之后读数必须为真")
    }
}
