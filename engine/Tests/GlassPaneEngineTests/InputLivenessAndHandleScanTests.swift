import XCTest
import Darwin
@testable import GlassPaneEngine

/// Regression pins for the two fixes that landed this round with no coverage
/// (their authors were not allowed to touch test files).
///
/// * R2-14 `ProcessMetricsProbe` —— `proc_pidinfo` 的 -1 曾被折成 "0 句柄"，
///   造出"进程活着但一个 fd 都没有"这条不可能的样本；它在退化曲线上是一根
///   真实的下降斜率。三态只存在于纯函数 `interpretFDScan` 里（"fd 表在两次调用
///   之间变了一半"没法按需让真进程演出来），所以按表钉、不碰真进程。
/// * R2-05 `AttributionGuard` × `CGEventInputMonitor` —— 被 macOS 停用
///   （`tapDisabledByTimeout` / `tapDisabledByUserInput`）的 tap 零投递，裁决却
///   照旧报 `contaminated: false`：把"没测到"当成"没发生"。修法是源自报存活
///   (`InputSourceMonitoring`) + 守卫的 `as?` 发现。单元测试进程里没有真 tap，
///   所以钉的是发现与折叠这一层，装 tap 路径一律不调用。
final class InputLivenessAndHandleScanTests: XCTestCase {

    // MARK: - R2-14 handle scan: pure three-state fold

    /// 原缺陷的那一条分支：错误返回被折成 0 句柄。今天必须是 `.failed`，
    /// 且绝不进样本池（`count == nil`）。
    func testErrorReturnIsNeverFoldedIntoZeroHandles() {
        let scan = ProcessMetricsProbe.interpretFDScan(
            sizeProbe: 100, readResult: -1, recordStride: 8
        )
        XCTAssertEqual(scan, .failed(errno: -1))
        XCTAssertNil(scan.count, "一次失败的读取不得进 DegradationSample.handleCount")
        XCTAssertNotEqual(scan, .measured(0), "就是这条等式造出了\"进程活着但 0 个 fd\"")
    }

    private enum ScanExpectation {
        case scan(HandleScan)
        /// 必须落到 `.indeterminate`，且原因串含这个分支标识词。
        case indeterminate(reasonMarker: String)
    }

    /// 三态折叠的全表。表里的字节数都以真实的 `proc_fdinfo` 记录宽度为单位，
    /// 所以条数在任何平台上都是精确的。`measured(0)` 的来路只有一条：尺寸
    /// 探测自己报出 0 字节的合法空表——循环末尾对这条不变式再兜一次底。
    func testFDScanThreeStateTable() {
        let rec = ProcessMetricsProbe.fdRecordStride
        XCTAssertGreaterThanOrEqual(rec, 4, "一条 proc_fdinfo 记录至少 4 字节，下面的分表依赖它")
        let b = Int32(rec)

        let cases: [(name: String, probe: Int32, read: Int32?, stride: Int, expect: ScanExpectation)] = [
            // —— 错误返回：本次没有测量 ——
            ("尺寸探测报错（-1）→ failed", -1, nil, rec, .scan(.failed(errno: -1))),
            ("尺寸探测报错优先于一个像样的读值", -1, b * 10, rec, .scan(.failed(errno: -1))),
            ("原始负返回按值透传（不是真 errno）", -2, nil, rec, .scan(.failed(errno: -2))),
            ("读阶段报错（R2-14 缺陷位）→ failed", b * 10, -1, rec, .scan(.failed(errno: -1))),
            // —— 合法空表：0 只从这里来 ——
            ("探测报 0 字节 = 真的空表 → measured(0)", 0, nil, rec, .scan(.measured(0))),
            ("空表分支优先于读值（读根本没发生）", 0, -1, rec, .scan(.measured(0))),
            // —— 完整/短读，整条数 ——
            ("满读 10 条 → measured(10)", b * 10, b * 10, rec, .scan(.measured(10))),
            ("短读但整条数：4 条 → measured(4)", b * 10, b * 4, rec, .scan(.measured(4))),
            ("短读到恰好一条 → measured(1)", b * 8, b, rec, .scan(.measured(1))),
            ("末尾残缺记录不连累已完整的 4 条", b * 10, b * 4 + Int32(rec / 2), rec,
             .scan(.measured(4))),
            // —— 推不出条数：未测量，绝不是 0 ——
            ("探到字节数却一个字节没读出来 → indeterminate", b * 10, 0, rec,
             .indeterminate(reasonMarker: "read produced none")),
            ("短读到不足一条 → indeterminate", b * 10, b - 1, rec,
             .indeterminate(reasonMarker: "less than one \(rec)-byte fd record")),
            ("探测为正却没有第二次读 → indeterminate", b * 10, nil, rec,
             .indeterminate(reasonMarker: "no read followed")),
            ("stride 为 0 → indeterminate", b * 10, b * 10, 0,
             .indeterminate(reasonMarker: "non-positive fd record stride 0")),
            ("stride 为负 → indeterminate", b * 10, b * 10, -8,
             .indeterminate(reasonMarker: "non-positive fd record stride -8"))
        ]

        for testCase in cases {
            let scan = ProcessMetricsProbe.interpretFDScan(
                sizeProbe: testCase.probe,
                readResult: testCase.read,
                recordStride: testCase.stride
            )
            switch testCase.expect {
            case .scan(let expected):
                XCTAssertEqual(scan, expected, testCase.name)
            case .indeterminate(let marker):
                guard case .indeterminate(let reason) = scan else {
                    XCTFail("\(testCase.name)：期望 .indeterminate，实得 \(scan)")
                    continue
                }
                XCTAssertTrue(reason.contains(marker),
                    "\(testCase.name)：原因串 \"\(reason)\" 没写清是哪一种未测量")
            }
            // 三态里只有 .measured 是观测值。
            if case .measured = scan {
                XCTAssertNotNil(scan.count, testCase.name)
            } else {
                XCTAssertNil(scan.count, "\(testCase.name)：非观测态不得给出句柄数")
            }
            // R2-14 不变式：0 句柄只能来自"探测自己报出 0 字节"，永远不能来自
            // 错误返回或短读——那正是假下降斜率的来源。
            if testCase.probe != 0 {
                XCTAssertNotEqual(scan, .measured(0), "\(testCase.name)：折成了假的 0 句柄")
            }
        }
    }

    /// `interpretFDScan` 的两次返回值都以 `proc_fdinfo` 记录为单位，单位常量
    /// 变了整张表就跟着变——把它钉在这里。
    func testFDRecordStrideIsTheUnitTheFoldInterprets() {
        XCTAssertEqual(ProcessMetricsProbe.fdRecordStride, MemoryLayout<proc_fdinfo>.stride)
        XCTAssertGreaterThan(ProcessMetricsProbe.fdRecordStride, 0)
    }

    // MARK: - R2-05 guard × source liveness: unmonitored never reads clean

    func testUnmonitoredWindowIsNeverJudgedClean() {
        let fault = "tapDisabledByTimeout: re-arm budget exhausted, tap left disabled"
        let source = ToggleableLivenessSource(alive: false, fault: fault)
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) },
            idleWindowSeconds: 0.5
        )
        // 通道断了照样放行获取：互斥仍成立，拒绝获取只会把 act 永久打死。
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        XCTAssertTrue(guard_.isHolding)
        XCTAssertEqual(
            guard_.releaseOperationRight(),
            OperationRightVerdict(
                contaminated: true, humanEvents: [], monitored: false, monitoringFault: fault
            ),
            "零投递必须折成保守的 contaminated:true，而不是干净结论"
        )
    }

    func testReleaseWithoutHoldOnDeadChannelIsNotClean() {
        let source = ToggleableLivenessSource(alive: false, fault: "no pump, no events")
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertFalse(guard_.isHolding)
        XCTAssertEqual(
            guard_.releaseOperationRight(),
            OperationRightVerdict(
                contaminated: true, humanEvents: [], monitored: false,
                monitoringFault: "no pump, no events"
            ),
            "没有测量窗口同样不能报 contaminated:false"
        )
    }

    /// tap 在 act 进行中途断掉、而调用方一次 `monitorInput()` 都没调：release
    /// 前的收尾采样是唯一能抓到它的地方。
    func testTapDyingMidHoldRetroactivelyUnmonitorsTheWindow() {
        let source = ToggleableLivenessSource(alive: true)
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        source.alive = false
        source.fault = "tapDisabledByUserInput: CGEventTapEnable did not revive the tap"
        let verdict = guard_.releaseOperationRight()
        XCTAssertFalse(verdict.monitored)
        XCTAssertTrue(verdict.contaminated)
        XCTAssertTrue(verdict.humanEvents.isEmpty)
        XCTAssertEqual(verdict.monitoringFault, source.fault)
    }

    /// 掉过一次就固定在"未监测"，原因留第一条（因果那条）；但**下一**窗口
    /// 复位——不能把上一轮的断链永久粘在守卫上。
    func testLivenessOnceLostLatchesForTheWindowAndResetsForTheNext() {
        let source = ToggleableLivenessSource(alive: false, fault: "fault A")
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        source.alive = true
        source.fault = "fault B"
        guard_.monitorInput()
        let first = guard_.releaseOperationRight()
        XCTAssertFalse(first.monitored, "装回来了也不改变本窗口从未测过的事实")
        XCTAssertTrue(first.contaminated)
        XCTAssertEqual(first.monitoringFault, "fault A", "后续故障不得覆盖因果那一条")

        let second = guard_.acquireOperationRight()
        XCTAssertEqual(second, .acquired)
        let next = guard_.releaseOperationRight()
        XCTAssertEqual(next, OperationRightVerdict(contaminated: false, humanEvents: []),
            "通道回来了，新窗口就该重新测")
    }

    /// 未监测只影响"零投递能不能算结论"，不该吞掉真的抓到的事件。
    func testUnmonitoredWindowStillChargesRealHumanEvents() {
        let event = InputEvent(timestamp: 1_000.1, source: .human)
        let source = ToggleableLivenessSource(events: [event], alive: false, fault: "tap disabled")
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) },
            idleWindowSeconds: 0.5
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        guard_.monitorInput()
        XCTAssertEqual(
            guard_.releaseOperationRight(),
            OperationRightVerdict(
                contaminated: true, humanEvents: [event], monitored: false,
                monitoringFault: "tap disabled"
            )
        )
    }

    /// 存活位为真时，源顺带报出的陈旧故障串不得漏进裁决（`monitoringFault`
    /// 的定义域是 `monitored == false`）。
    func testAliveSourceWithAStaleFaultStringReportsNoFault() {
        let source = ToggleableLivenessSource(alive: true, fault: "stale fault from an older window")
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        XCTAssertEqual(
            guard_.releaseOperationRight(),
            OperationRightVerdict(contaminated: false, humanEvents: [])
        )
    }

    /// 钉住"每一段都重新采样"：acquire / monitorInput / release 各采一次。少
    /// 任何一次，该段里发生的停用就看不见。
    func testGuardSamplesLivenessAtEveryStageOfAWindow() {
        let source = ToggleableLivenessSource(alive: true)
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(source.livenessSampleCount, 0)
        _ = guard_.acquireOperationRight()
        XCTAssertEqual(source.livenessSampleCount, 1, "acquire 要采一次")
        guard_.monitorInput()
        XCTAssertEqual(source.livenessSampleCount, 2, "每轮 monitorInput 要采一次")
        _ = guard_.releaseOperationRight()
        XCTAssertEqual(source.livenessSampleCount, 3, "release 的收尾采样是唯一能抓到断链的地方")
    }

    /// 回归闸：不实现 `InputSourceMonitoring` 的源（所有既有脚本源）语义逐字
    /// 不变——默认"在测"，`monitored: true`、`monitoringFault: nil`。
    func testNonConformingSourceKeepsTodaysVerdictShape() {
        let event = InputEvent(timestamp: 1_000.1, source: .human)
        let scripted: InputEventSource = ScriptedInputEventSource(events: [])
        XCTAssertNil(scripted as? InputSourceMonitoring,
            "脚本源不该悄悄获得自报能力")

        let clean = AttributionGuard(
            inputSource: ScriptedInputEventSource(events: []),
            clock: { Date(timeIntervalSince1970: 1_000) }
        )
        _ = clean.acquireOperationRight()
        XCTAssertEqual(clean.releaseOperationRight(),
                       OperationRightVerdict(contaminated: false, humanEvents: []))

        let busy = AttributionGuard(
            inputSource: ScriptedInputEventSource(events: [event]),
            clock: { Date(timeIntervalSince1970: 1_000) }
        )
        _ = busy.acquireOperationRight()
        busy.monitorInput()
        XCTAssertEqual(busy.releaseOperationRight(),
                       OperationRightVerdict(contaminated: true, humanEvents: [event]))

        let neverHeld = AttributionGuard(
            inputSource: ScriptedInputEventSource(events: [event]),
            clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(neverHeld.releaseOperationRight(),
                       OperationRightVerdict(contaminated: false, humanEvents: []),
                       "未持有的窗口对脚本源仍是干净的（事件留在队列里没被消费）")
    }

    // MARK: - R2-05 the concrete monitor's liveness surface (no tap installed)

    /// 单元测试进程里没有真 tap：能钉的是"没装成 = 公开说没在测"，也就是
    /// 存活位的默认值与只读账目。装 tap 的路径（`start()` /
    /// `startOnBackgroundRunLoop()`）这里一律不碰。
    func testUninstalledMonitorPublishesNotMonitoringAndZeroAccounting() {
        let monitor = CGEventInputMonitor(log: EngineLog(quiet: true))
        XCTAssertFalse(monitor.isMonitoringInput)
        XCTAssertFalse(monitor.isTapAlive)
        XCTAssertNil(monitor.inputMonitoringFault, "从未尝试安装：没有原因可报")
        XCTAssertNil(monitor.lastTapFault)
        XCTAssertEqual(monitor.tapDisableCount, 0)
        XCTAssertEqual(monitor.tapReArmCount, 0)
        XCTAssertEqual(monitor.tapReArmFailureCount, 0)
        XCTAssertFalse(monitor.disabledSinceLastCheck())
        XCTAssertFalse(monitor.disabledSinceLastCheck(), "没有停用发生过：读清位不得自己变真")
        XCTAssertTrue(monitor.peekAvailable().isEmpty)
        XCTAssertNil(monitor.nextEvent())
        monitor.stop()  // 无 tap 的拆卸路径必须也只是把状态留在"没在测"
        XCTAssertFalse(monitor.isTapAlive)
        XCTAssertNil(monitor.lastTapFault)
    }

    /// 守卫对**真实生产类型**的发现：`CGEventInputMonitor` 确实通过 `as?`
    /// 暴露成 `InputSourceMonitoring`，所以没装 tap 的 monitor 作为源时，裁决
    /// 走未监测分支而不是"干净"。
    func testGuardDiscoversTheConcreteMonitorViaTheOptionalProtocol() {
        let monitor: InputEventSource = CGEventInputMonitor(log: EngineLog(quiet: true))
        XCTAssertNotNil(monitor as? InputSourceMonitoring,
            "conformance 掉了，守卫的 as? 就会把静默 tap 当成在测")

        let guard_ = AttributionGuard(
            inputSource: monitor, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        _ = guard_.acquireOperationRight()
        let verdict = guard_.releaseOperationRight()
        XCTAssertFalse(verdict.monitored)
        XCTAssertTrue(verdict.contaminated, "沉默的 tap 不是\"没人碰机器\"的证据")
        XCTAssertTrue(verdict.humanEvents.isEmpty)
        XCTAssertNil(verdict.monitoringFault, "tap 从未安装，原因串确实为空")
    }
}

/// 可手工拨动存活位的输入源：同时实现 `InputEventSource` 与
/// `InputSourceMonitoring`，守卫发现它的方式与发现 `CGEventInputMonitor`
/// 完全一致——协议发现与折叠这一层因此不需要真 tap 就能钉。
private final class ToggleableLivenessSource: InputEventSource, InputSourceMonitoring {

    private var queue: [InputEvent]
    var alive: Bool
    var fault: String?
    /// 守卫每采一次存活位记一条。
    private(set) var livenessSampleCount = 0

    init(events: [InputEvent] = [], alive: Bool = true, fault: String? = nil) {
        self.queue = events
        self.alive = alive
        self.fault = fault
    }

    func nextEvent() -> InputEvent? {
        guard !queue.isEmpty else { return nil }
        return queue.removeFirst()
    }

    func peekAvailable() -> [InputEvent] {
        queue
    }

    var isMonitoringInput: Bool {
        livenessSampleCount += 1
        return alive
    }

    var inputMonitoringFault: String? {
        fault
    }
}
