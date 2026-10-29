import XCTest
@testable import GlassPaneEngine

/// S3-1（每日 2026-10-29，泳道 3）：输入通道在窗口内掉线（`monitored == false`）**且**
/// drain 同时交回了 ≥1 条 `.human` 事件时，`contaminationBasis`（`EngineCore.swift:1378-1379`）
/// 仍断言"contaminated=true 的依据是没人在看通道，不是观测到的输入"——而同一帧旁边就挂着
/// `humanInputEventCount`/`humanInputEvents`。这句话还随 `circuitBreaker.reason` 进档案，
/// 事后只剩"没人碰过机器"一种读法，代理会把根因归到通道而不是那条真实点击。
///
/// 修法按 `observedHumanInput` 分支出两句，各自只说自己那半。对照臂（只有掉线、没有观测
/// 输入）**必须保住今天那句话**——负例表不许只收能过的样本。
///
/// REVERSE（反向变异自证）：把 1379 的 observedHumanInput 分支删回单句 →
/// `testMonitorLostWithObservedInputDoesNotClaimNoObservedInput` 的 basis 与 reason 两组
/// 断言同时红；把对照臂那句也改掉 → `testMonitorLostWithoutObservedInputKeepsAbsenceBasis` 红。
final class DailyRound20261029Swift2ContaminationBasisTests: XCTestCase {

    /// 脚本化的可掉线输入源：队列里的事件按 `nextEvent()` 消费，`isMonitoringInput`
    /// 由测试手动翻转——"先 push 一条 `.human` 再翻 monitored=false"就是缺陷场景本身。
    private final class SwitchableMonitorSource: InputEventSource, InputSourceMonitoring {
        private var queue: [InputEvent] = []
        var monitored = true
        let fault = "the scripted monitor was switched off inside this window"

        func push(_ event: InputEvent) { queue.append(event) }
        func nextEvent() -> InputEvent? { queue.isEmpty ? nil : queue.removeFirst() }
        func peekAvailable() -> [InputEvent] { queue }
        var isMonitoringInput: Bool { monitored }
        var inputMonitoringFault: String? { monitored ? nil : fault }
    }

    private func makeCore(source: SwitchableMonitorSource) throws
        -> (EngineCore, ScriptedChannel)
    {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let guard_ = AttributionGuard(inputSource: source)
        let core = EngineCore(channel: channel, settle: {}, attributionGuard: guard_)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        return (core, channel)
    }

    /// 缺陷本体：掉线 + 抓到一条人类输入时，basis 与 `circuitBreaker.reason` 都不许再说
    /// "不是观测到的输入"，且必须把那一条观测到的输入自己说出来（各自只说自己那半）。
    func testMonitorLostWithObservedInputDoesNotClaimNoObservedInput() throws {
        let source = SwitchableMonitorSource()
        let (core, _) = try makeCore(source: source)

        source.push(InputEvent(timestamp: Date().timeIntervalSince1970, source: .human))
        source.monitored = false  // 通道在窗口内掉线
        let result = try core.act(
            selector: Selector(role: "AXButton", title: "Submit"),
            action: .press,
            degrade: true
        )

        // 夹具自检：这一帧确实同时带着"抓到过输入"与"通道没了"两个事实。
        XCTAssertEqual(result["humanInputEventCount"] as? Int, 1,
                       "夹具必须造出'drain 交回一条 .human'的窗口，否则这条测不到任何东西")
        XCTAssertEqual(result["contaminationMonitored"] as? Bool, false)
        XCTAssertEqual(result["contaminationBasis"] != nil, true)

        let basis = try XCTUnwrap(result["contaminationBasis"] as? String)
        XCTAssertFalse(
            basis.contains("not an observed input"),
            "同帧挂着 humanInputEventCount==1 时，basis 不许再断言'依据不是观测到的输入'：\(basis)"
        )
        XCTAssertTrue(
            basis.contains("human input event"),
            "掉线分支的观测输入那一半必须自己被说出来，而不是只靠旁边的计数：\(basis)"
        )

        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertTrue(pack.attribution.contaminated)
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.contains("input-contamination-monitor-lost"),
                      "掉线标签不许丢：\(reason)")
        XCTAssertFalse(reason.contains("not an observed input"),
                       "circuitBreaker.reason 与 basis 用同一判据：同一条件下不许断言相反的话：\(reason)")
        XCTAssertTrue(reason.contains("human input event"),
                      "进档案那半也必须点名观测到的输入，否则事后只剩'没人碰过机器'一种读法：\(reason)")
    }

    /// 对照臂（负例不许只收能过的样本）：只有掉线、没有任何观测输入时，今天那句话必须
    /// 逐字保住——"contaminated=true 的依据是没人在看通道"在这一支是真话。
    func testMonitorLostWithoutObservedInputKeepsAbsenceBasis() throws {
        let source = SwitchableMonitorSource()
        let (core, _) = try makeCore(source: source)

        source.monitored = false  // 掉线，但队列里一条事件都没有
        let result = try core.act(
            selector: Selector(role: "AXButton", title: "Submit"),
            action: .press,
            degrade: true
        )

        XCTAssertNil(result["humanInputEventCount"],
                     "没有观测输入时不许凭空出一个计数")
        let basis = try XCTUnwrap(result["contaminationBasis"] as? String)
        XCTAssertEqual(
            basis,
            "the input monitor stopped reporting inside this window: \(source.fault) — "
                + "the contaminated=true verdict is the absence of a watching channel, not an observed input",
            "对照臂必须保住今天那句话——删断言换绿不算修"
        )
    }
}
