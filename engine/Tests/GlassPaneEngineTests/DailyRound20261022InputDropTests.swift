import XCTest
@testable import GlassPaneEngine

/// 输入缓冲区的丢失必须有计数，而守卫必须看得见它（每日任务 2026-10-22，缺陷
/// 「溢出无人知晓 ⇒ 没测完的窗口被发布成干净窗口」）。
///
/// 修的那件事：`LockedEventBuffer.push` 有界 4096 条，超了就把**最老**的挤掉
/// （`buffer.removeFirst(...)`），而这件事从前既不计数也不上报。探针侧的丢失都有公开
/// 计数（`droppedEvents` / `droppedWrites` / `truncatedValues`），输入缓冲区这一种却没
/// 有一个。后果不是少一个数字：一次长 `act` 或一段飞快的 typing
/// 在 `AttributionGuard` 排空之前把队首挤掉，守卫排到的是一条**头部没了**的队列，
/// `humanEvents` 于是为空，`contaminated` 于是为 false，归因照旧 `.soft`/`.strong`
/// ——一个「观测不完整却写着没人碰机器」的窗口进了档案。
///
/// 折叠选的是本文件已有的那一条，不是新发明：缓冲区截短与「通道断了」是同一级事实
/// 缺口，所以走同一个 `monitored: false` + 具名 `monitoringFault`，由裁决点
/// `contaminated: !monitored || !humanEvents.isEmpty` 保证它不可能判成干净。
///
/// 为什么这里能全用纯逻辑：真 tap 需要 Input Monitoring 席位，单元测试进程一律不装
/// （`InputLivenessAndHandleScanTests` 同一条约束）。守卫与缓冲区都不需要它——事件按
/// `InputEvent` 直接喂，缓冲区按 `LockedEventBuffer(capacity:)` 直接喂。只有「生产那个
/// monitor 有没有把自己那块缓冲区接到协议第三问上」接不上运行时，那一半由
/// `testMonitorWiresItsOwnBufferLossToTheProtocol` 按文本钉。
final class DailyRound20261022InputDropTests: XCTestCase {

    private func event(_ timestamp: Double, _ source: InputSource = .human) -> InputEvent {
        InputEvent(timestamp: timestamp, source: source)
    }

    // MARK: - 缓冲区：挤掉要落在账上

    /// 原缺陷本体：溢出被做完就没人记账。计数、读清位、剩下的队尾与顺序必须同时成立
    /// ——容量本身不许动（有界是这一段的用途），事件次序也不许动。
    /// REVERSE：删掉 `push` 里的 `droppedCount += evicted` → 计数与读清位两条红；
    /// 只删 `dropPendingReport = true` → 读清位红；把挤掉改成从尾部删 → 快照那条红。
    func testEvictionIsCountedAndNeverMerelyPerformed() {
        let buffer = LockedEventBuffer(capacity: 3)
        for timestamp in [1_000.0, 1_000.1, 1_000.2] {
            buffer.push(event(timestamp))
        }
        XCTAssertEqual(buffer.droppedEventCount, 0, "还没到容量：0 是一次真实测量，不是缺席")
        XCTAssertFalse(buffer.droppedSinceLastCheck())

        buffer.push(event(1_000.3))
        buffer.push(event(1_000.4))
        XCTAssertEqual(buffer.droppedEventCount, 2, "两条最老的被挤掉了，账上必须有 2")
        XCTAssertTrue(buffer.droppedSinceLastCheck(), "读清位要报告掉过")
        XCTAssertFalse(buffer.droppedSinceLastCheck(), "读过一次就清零，不许自己变回来")

        // 剩下的是队尾，而且顺序不变：计数不许以重排为代价。
        XCTAssertEqual(buffer.snapshot().map(\.timestamp), [1_000.2, 1_000.3, 1_000.4])
        XCTAssertEqual(buffer.pop(), event(1_000.2), "pop 仍按先进先出，队首是活下来的那一条")

        buffer.push(event(1_000.5))
        buffer.push(event(1_000.6))
        buffer.push(event(1_000.7))
        XCTAssertEqual(
            buffer.droppedEventCount, 4,
            "累计面是**累计**的：读清位被读走之后条数照样在长（形状同 `tapDisableCount`）"
        )
        XCTAssertTrue(buffer.droppedSinceLastCheck(), "第二次溢出同样要报告一次")
        XCTAssertEqual(buffer.snapshot().map(\.timestamp), [1_000.5, 1_000.6, 1_000.7],
                       "活下来的永远是最新的 capacity 条，顺序不变")
    }

    /// 没有丢失时的读数：0 与 false 都是「测过且没掉」，不是「没测」。这一条是上一
    /// 条的反面闸——把读清位写成常量 true，这里就红。
    func testBufferWithoutOverflowReportsNoLoss() {
        let buffer = LockedEventBuffer(capacity: 3)
        buffer.push(event(1_000.0))
        buffer.push(event(1_000.1))
        _ = buffer.pop()
        _ = buffer.pop()
        XCTAssertEqual(buffer.droppedEventCount, 0, "pop 掉的不是溢出，不许记进丢失账")
        XCTAssertFalse(buffer.droppedSinceLastCheck())
        XCTAssertFalse(buffer.droppedSinceLastCheck())
        XCTAssertTrue(buffer.snapshot().isEmpty)
    }

    /// 生产类型自己的观测面：新装好的 monitor 一个事件都没投递过，两个读数都必须
    /// 是「没掉」，而协议那一问必须能从 monitor 上读到（`as?` 掉不了）。
    /// REVERSE：这一条钉的是「缺席时不编数」，摘掉 conformer 的覆盖会退回默认值
    /// false 因而仍绿——真正的接线由
    /// `testMonitorWiresItsOwnBufferLossToTheProtocol` 负责。
    func testUninstalledMonitorStartsWithAZeroDropAccount() {
        let monitor = CGEventInputMonitor(log: EngineLog(quiet: true))
        XCTAssertEqual(monitor.droppedEventCount, 0, "没投递过就是没掉过：0 是实测值")
        XCTAssertFalse(monitor.eventsDroppedSinceLastCheck())
        XCTAssertFalse(monitor.eventsDroppedSinceLastCheck(), "读清位不许自己变真")
        XCTAssertFalse(monitor.inputEventsDroppedSinceLastCheck())
        XCTAssertNotNil((monitor as InputEventSource) as? InputSourceMonitoring,
                        "conformance 掉了，守卫就再也问不到缓冲区这一层")
    }

    // MARK: - 守卫：把「掉过」折成一次监测故障

    /// 缺陷成立的那一条路径：持有期间溢出，drain 出来的 `humanEvents` 为空。空集合
    /// 是残缺队列的尾部，不是一次测量 ⇒ 本窗口必须按未监测折叠，并具名说清不知道的
    /// 是哪一件事。
    /// REVERSE：删掉 `sampleMonitoring()` 末尾的 `noteDroppedEvents()` → 红
    /// （`monitored` 回 true、`contaminated` 回 false，正是原缺陷的读数）。
    func testOverflowDuringHoldCannotReleaseACleanWindow() throws {
        let source = DropCapableLivenessSource()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        source.armDrops()          // act 进行中：一次长 act、或一段飞快的 typing
        guard_.monitorInput()

        let verdict = guard_.releaseOperationRight()
        XCTAssertTrue(verdict.humanEvents.isEmpty, "这条用例测的就是空集合那一支")
        XCTAssertFalse(verdict.monitored,
                       "队首没了的窗口不算全程在测：monitored 就是这个字段该承担的")
        XCTAssertTrue(verdict.contaminated,
                      "未监测折算出的保守值——观测过人类输入的窗口不许被发布成干净")
        let fault = try XCTUnwrap(verdict.monitoringFault)
        for marker in ["overflowed", "oldest", "start of the window is unknown",
                       "measures nothing"] {
            XCTAssertTrue(fault.contains(marker),
                          "原因串要写出哪一件事实不知道，缺 \(marker)：\(fault)")
        }
    }

    /// 溢出发生在上一次采样之后、release 之前也必须被抓到：`releaseOperationRight`
    /// 收尾那一次采样是唯一能看到它的地方（与 R2-05 的断链同一条判据）。
    /// REVERSE：删掉 release 开头那次 `sampleMonitoring()` → 红。
    func testOverflowIsCaughtByTheClosingSampleEvenWithoutMonitorInput() {
        let source = DropCapableLivenessSource()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        source.armDrops()
        let verdict = guard_.releaseOperationRight()
        XCTAssertFalse(verdict.monitored)
        XCTAssertTrue(verdict.contaminated)
        XCTAssertTrue(verdict.humanEvents.isEmpty)
    }

    /// acquire 这一次采样也在问：位上挂着「上一段里溢过」时，被挤掉的那批正是本次
    /// 空闲检测 `peekAvailable()` 读过头部的队列，而 `degradeOnBusy` 还会把持有起点
    /// 回拨进那段——这段的开头同样没人知道，所以记在本窗口头上不是冤枉账。
    /// REVERSE：删掉 `acquireOperationRight` 里的 `noteDroppedEvents()` → 红
    /// （这一支之后没人再置位，另两次问到的都是 false）。
    func testDropQueuedBeforeAcquireFaultsTheWindowItTruncated() {
        let source = DropCapableLivenessSource()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        source.armDrops()
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        guard_.monitorInput()
        let verdict = guard_.releaseOperationRight()
        XCTAssertFalse(verdict.monitored, "acquire 没问这一次，这个窗口就被当成全程在测了")
        XCTAssertTrue(verdict.contaminated)
    }

    /// 截短不吞掉真的抓到的事件：抓到的 `.human` 照样进裁决（与
    /// `testUnmonitoredWindowStillChargesRealHumanEvents` 同一件事，换成溢出这一因）。
    /// REVERSE：把折叠写成顺手丢掉 `collectedEvents` → 红。
    func testDroppedBufferStillChargesTheHumanEventsItKept() {
        let kept = event(1_000.2)
        let source = DropCapableLivenessSource(events: [kept])
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        source.armDrops()
        let verdict = guard_.releaseOperationRight()
        XCTAssertEqual(verdict.humanEvents, [kept], "活下来那一条仍然是观测到的输入")
        XCTAssertFalse(verdict.monitored)
        XCTAssertTrue(verdict.contaminated)
    }

    /// ★ 反「一刀切拒绝」的回归闸：**同一个源**、没有溢出，今天的判定逐字不变。
    /// 这条存在是因为折叠很容易写成「只要问一次就永久未监测」，那是另一种假保险
    /// （真干净的窗口再也拿不到 `.soft`/`.strong`）。
    /// REVERSE：把 `noteDroppedEvents()` 改成无条件置故障 → 红；把缓冲区的读清位
    /// 写成粘住不清（`dropPendingReport` 永不归 false）→ 第二个窗口就红。
    func testSameSourceWithoutOverflowKeepsTodaysVerdictShape() {
        let source = DropCapableLivenessSource()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        for window in 1...3 {
            XCTAssertEqual(guard_.acquireOperationRight(), .acquired, "第 \(window) 个窗口")
            guard_.monitorInput()
            XCTAssertEqual(
                guard_.releaseOperationRight(),
                OperationRightVerdict(contaminated: false, humanEvents: []),
                "没掉过事件的窗口不许被折成未监测（第 \(window) 个）"
            )
        }
    }

    /// 一次截短只管它所在的那一个窗口：下一个窗口重新测。
    /// REVERSE：删掉 `releaseOperationRight` 末尾对 `holdMonitored`/
    /// `holdMonitoringFault` 的复位 → 红。
    func testDroppedWindowDoesNotLatchIntoTheNextOne() {
        let source = DropCapableLivenessSource()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        source.armDrops()
        let first = guard_.releaseOperationRight()
        XCTAssertFalse(first.monitored)
        XCTAssertTrue(first.contaminated)

        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        let second = guard_.releaseOperationRight()
        XCTAssertEqual(second, OperationRightVerdict(contaminated: false, humanEvents: []),
                       "上一段丢过事件不能永久粘在守卫上")
    }

    /// 钉住「每一段都问一次」：acquire / monitorInput / release 各一问，与存活位那
    /// 三个采样点对称。少任何一问，那一段里的溢出就看不见。
    /// REVERSE：把三处 `noteDroppedEvents()` 里的任意一处删掉 → 对应那条断言红。
    func testGuardAsksTheDropQuestionAtEveryStageOfAWindow() {
        let source = DropCapableLivenessSource()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(source.dropQuestionCount, 0)
        _ = guard_.acquireOperationRight()
        XCTAssertEqual(source.dropQuestionCount, 1, "acquire 要问一次")
        guard_.monitorInput()
        XCTAssertEqual(source.dropQuestionCount, 2, "每轮 monitorInput 要问一次")
        _ = guard_.releaseOperationRight()
        XCTAssertEqual(source.dropQuestionCount, 3, "release 的收尾采样要问最后一次")
    }

    // MARK: - 协议默认实现：既有 conformer 一行都不许改行为

    /// 落在默认实现上的 conformer（覆盖前两问、不覆盖第三问）与完全不实现协议的
    /// 脚本源，判定必须与今天逐字相同：`monitored: true` + `monitoringFault: nil`。
    /// 这条同时是「默认值方向」的闸：默认写成 true 就等于替每个没带缓冲区的源承认
    /// 它溢出过。
    /// REVERSE：把扩展里的默认值改成 `true` → 红；把成员变成没有默认实现的必需成员
    /// 是编译错误而不是红用例，所以这一条只钉方向。
    func testDefaultAnswerKeepsNonBufferedSourcesExactlyAsToday() {
        let conforming: InputSourceMonitoring = LegacyLivenessSource()
        XCTAssertFalse(conforming.inputEventsDroppedSinceLastCheck(),
                       "默认实现必须答没掉过——这些源根本没有可掉的队列")

        let guard_ = AttributionGuard(
            inputSource: LegacyLivenessSource(), clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        guard_.monitorInput()
        XCTAssertEqual(guard_.releaseOperationRight(),
                       OperationRightVerdict(contaminated: false, humanEvents: []))

        let scripted = AttributionGuard(
            inputSource: ScriptedInputEventSource(events: []),
            clock: { Date(timeIntervalSince1970: 1_000) }
        )
        _ = scripted.acquireOperationRight()
        XCTAssertEqual(scripted.releaseOperationRight(),
                       OperationRightVerdict(contaminated: false, humanEvents: []),
                       "不实现协议的源（含全部既有脚本源）语义逐字不变")
    }

    // MARK: - 生产接线（单元测试溢不出真缓冲区，所以这一半只能钉文本）

    /// `CGEventInputMonitor` 必须把**自己那块缓冲区**的读清位接到协议第三问上，并把
    /// 累计值发布成与 `tapDisableCount` 同一条形状的观测面。协议默认实现是 false，
    /// 接线一旦断掉就等于「生产永远没掉过」，而运行时没有第二条路能看见这件事（真
    /// tap 要 Input Monitoring 席位，`eventsBuffer` 是 private、`enqueue` 是
    /// fileprivate），所以按文本钉：手法同 DailyRound20261022CaptureScaleTests 里的
    /// `testCallerRefusesRatherThanFillingInAScale`。
    /// REVERSE：把第三问的函数体改成 false → witness body 那条红；删掉
    /// `droppedCount += evicted` → 计数那条红；改容量或改成无界 → 最后两条红。
    func testMonitorWiresItsOwnBufferLossToTheProtocol() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/GlassPaneEngine/CGEventInputMonitor.swift")
        let source = try String(contentsOf: url, encoding: .utf8)

        XCTAssertTrue(source.contains("droppedCount += evicted"),
                      "挤掉又不记账了：整条缺陷就在这个符号上")
        XCTAssertTrue(source.contains("buffer.removeFirst(evicted)"),
                      "溢出仍然是有界地删最老的，不许改成不删或删队尾")
        XCTAssertTrue(source.contains("dropPendingReport = true"),
                      "读清位没人置位，协议那一问就永远回 false")

        let body = try XCTUnwrap(
            declarationBody(of: "func inputEventsDroppedSinceLastCheck() -> Bool", in: source),
            "协议第三问没有了，默认实现的那个 false 就成了生产答案"
        )
        XCTAssertTrue(
            body.contains("DroppedSinceLastCheck") || body.contains("droppedSinceLastCheck"),
            "第三问没有转发到自己那块缓冲区，它报的是默认值：" + body
        )
        XCTAssertTrue(source.contains("public func eventsDroppedSinceLastCheck() -> Bool"),
                      "读清观测面（形状同 disabledSinceLastCheck）不见了")
        XCTAssertTrue(source.contains("public var droppedEventCount: Int"),
                      "累计观测面（形状同 tapDisableCount）不见了")
        XCTAssertTrue(source.contains("eventsBuffer.droppedEventCount"),
                      "累计面有没有接在自己那块缓冲区上？")
        XCTAssertTrue(source.contains("init(capacity: Int = 4096)"),
                      "容量不是这一轮的变量：有界是这一段的用途")
    }

    /// 取某个声明从 `{` 到配对 `}` 之间的正文。只用于本文件那种一层大括号的
    /// 单表达式访问器，不打算当通用解析器用。
    private func declarationBody(of declaration: String, in text: String) -> String? {
        guard let found = text.range(of: declaration),
              let open = text[found.upperBound...].firstIndex(of: "{") else { return nil }
        var depth = 0
        var index = open
        while index < text.endIndex {
            switch text[index] {
            case "{": depth += 1
            case "}":
                depth -= 1
                if depth == 0 { return String(text[text.index(after: open)..<index]) }
            default: break
            }
            index = text.index(after: index)
        }
        return nil
    }
}

/// 有缓冲区语义的注入源：实现 `InputEventSource` + `InputSourceMonitoring` 并覆盖第三
/// 问，守卫发现它的方式与发现 `CGEventInputMonitor` 完全一致。置位一次只报一次（读后
/// 清零），照抄 `disabledSinceLastCheck()` 的语义——这样这些用例测的是守卫怎么折叠，
/// 而不是桩自己怎么粘。
private final class DropCapableLivenessSource: InputEventSource, InputSourceMonitoring {
    private var queue: [InputEvent]
    private var dropsPending = false
    /// 守卫每问一次截短记一条（与 `ToggleableLivenessSource.livenessSampleCount` 对称）。
    private(set) var dropQuestionCount = 0

    init(events: [InputEvent] = []) {
        self.queue = events
    }

    /// 模拟一次容量溢出：下一次被问到时报「掉过」，并报完即清。
    func armDrops() { dropsPending = true }

    func nextEvent() -> InputEvent? {
        guard !queue.isEmpty else { return nil }
        return queue.removeFirst()
    }

    func peekAvailable() -> [InputEvent] { queue }

    var isMonitoringInput: Bool { true }
    var inputMonitoringFault: String? { nil }

    func inputEventsDroppedSinceLastCheck() -> Bool {
        dropQuestionCount += 1
        let seen = dropsPending
        dropsPending = false
        return seen
    }
}

/// 只覆盖协议前两问的 conformer：第三问走扩展里的默认实现。既有两个测试桩
/// （`ToggleableLivenessSource`、`ScriptedMonitoringSource`）就是这个形状——它们不改
/// 一行也必须继续编译、继续按今天判定。
private final class LegacyLivenessSource: InputEventSource, InputSourceMonitoring {
    var isMonitoringInput: Bool { true }
    var inputMonitoringFault: String? { nil }
    func nextEvent() -> InputEvent? { nil }
    func peekAvailable() -> [InputEvent] { [] }
}
