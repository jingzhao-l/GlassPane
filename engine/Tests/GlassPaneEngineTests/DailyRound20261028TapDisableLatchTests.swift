import XCTest
@testable import GlassPaneEngine

/// tap 掉过一次又装回来，窗口必须折成"没测全程"（每日任务 2026-10-28，缺陷
/// 「`CGEventInputMonitor.disabledSinceLastCheck()` 只有测试在读 ⇒ 归因把没人看的那段
/// 发布成 watched for the whole operation window」）。
///
/// 修的那件事：`AttributionGuard` 折的是**采样时刻**的两个事实——`isMonitoringInput`
/// 与缓冲区截短位。tap 在两次采样之间被系统停用、又在下一次采样前重装成功时，
/// `tapAlive` 回到 true（`CGEventInputMonitor.swift:252`），两个采样点都读到"在测"，
/// `humanEvents` 也照样为空。而掉线期间投进来的事件不会补投，所以那段恰好是"人类输入
/// 最可能来过、而通道没看见"的那一段。裁决于是发布
/// `EngineCore.swift` 里那句 "the input stream was watched for the whole operation
/// window"，把没兑现的主张写进档案。本文件那个读清位（`disabledSinceLastCheck()`）从前
/// 只有两条单元测试在读，而 `CGEventInputMonitor.swift` 自己的注释写着"读者只有一个：
/// `AttributionGuard` 的采样点"——那是一条没有实现的主张。
///
/// 折叠照抄既有那一条，不新发明：掉线-重装与缓冲区截短是同一级事实缺口，走同一个
/// `monitored: false` + 具名 `monitoringFault`，由裁决点
/// `contaminated: !monitored || !humanEvents.isEmpty` 保证它不可能判成干净。
///
/// 为什么运行时能测一半、另一半钉文本：真 tap 要 Input Monitoring 席位，单元测试进程
/// 一律不装（同 `InputLivenessAndHandleScanTests` 那条约束）。守卫怎么折叠可以纯逻辑喂；
/// "生产那个 monitor 有没有把自己那个读清位接到协议这一问上"只能按文本钉。
final class DailyRound20261028TapDisableLatchTests: XCTestCase {

    // MARK: - 守卫：三问合起来才回答"这段有人看着吗"

    /// 原缺陷本体：持有期间掉过一次、下一次采样前又装回来。存活位为真、集合为空，
    /// 而窗口不许发布成干净。
    /// REVERSE：删掉 `sampleMonitoring()` 里的 `noteTapDisabled()` → 本条前三断言红；
    /// 把协议那一问的默认实现改成 true → 对照那条（`testSourceThatNeverDroppedTheTap…`）红。
    func testMidWindowDisableCannotReleaseACleanWindow() throws {
        let source = DisableCapableSource()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        source.armDisable()          // act 进行中：系统把 tap 停了，随后又重装成功
        guard_.monitorInput()

        let verdict = guard_.releaseOperationRight()
        XCTAssertTrue(verdict.humanEvents.isEmpty, "这条用例测的就是空集合那一支")
        XCTAssertFalse(verdict.monitored,
                       "掉过一次的窗口不算全程在测：monitored 就是这个字段该承担的")
        XCTAssertTrue(verdict.contaminated,
                      "未监测折算出的保守值——没人看着的那段不许被发布成干净")
        let fault = try XCTUnwrap(verdict.monitoringFault)
        for marker in ["disabled", "re-armed", "not replayed", "does not mean"] {
            XCTAssertTrue(fault.contains(marker),
                          "原因串要写出哪一段不知道，缺 \(marker)：\(fault)")
        }
    }

    /// 掉线发生在上一次采样之后、release 之前也必须被抓到：收尾那一次采样是唯一能
    /// 看到它的地方（与 R2-05 断链、2026-10-22 溢出同一条判据）。
    /// REVERSE：删掉 `releaseOperationRight` 开头的 `sampleMonitoring()` → 红。
    func testDisableIsCaughtByTheClosingSampleEvenWithoutMonitorInput() {
        let source = DisableCapableSource()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        source.armDisable()
        let verdict = guard_.releaseOperationRight()
        XCTAssertFalse(verdict.monitored)
        XCTAssertTrue(verdict.contaminated)
        XCTAssertTrue(verdict.humanEvents.isEmpty)
    }

    /// acquire 这一次问也在问：位上挂着"上一段里掉过"时，被停掉的那段可能正盖住本次
    /// 持有起点回拨进来的那一段（`degradeOnBusy`），记在本窗口头上不是冤枉账。
    /// REVERSE：删掉 `acquireOperationRight` 里的 `noteTapDisabled()` → 红（本条之后
    /// 再没有置位的机会，另两次问到的都是 false）。
    func testDisableQueuedBeforeAcquireFaultsTheWindowItCovered() {
        let source = DisableCapableSource()
        source.armDisable()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        let verdict = guard_.releaseOperationRight()
        XCTAssertFalse(verdict.monitored, "起点之前那次停用照样折进本窗口")
        XCTAssertTrue(verdict.contaminated)
    }

    /// ★ 对照（必须能失败的那一支）：全程没掉过的源，裁决形状逐字不变。
    /// 没有这一支，上面三条红的可能只是"折叠被写成了恒真"。
    /// REVERSE：把 `noteTapDisabled()` 改成无条件折叠 → 本条红。
    func testSourceThatNeverDroppedTheTapKeepsTodaysVerdictShape() throws {
        let source = DisableCapableSource()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        guard_.monitorInput()
        let verdict = guard_.releaseOperationRight()
        XCTAssertTrue(verdict.monitored, "没掉过就该报全程在测")
        XCTAssertFalse(verdict.contaminated)
        XCTAssertNil(verdict.monitoringFault)
    }

    /// 读清位不许粘到下一个窗口：报过一次就清零，否则第一次掉线会把之后每个窗口都
    /// 折成未监测——那是把"测不到"换成另一种假话。
    func testDisableDoesNotLatchIntoTheNextWindow() {
        let source = DisableCapableSource()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        source.armDisable()
        XCTAssertFalse(guard_.releaseOperationRight().monitored, "premise：第一窗折了")

        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        let second = guard_.releaseOperationRight()
        XCTAssertTrue(second.monitored, "第二位读者该看到清零后的答案：没掉过")
        XCTAssertFalse(second.contaminated)
    }

    /// 每一段都要问：acquire / 每次 monitorInput / release 收尾。只在一处问等于另两处
    /// 的掉线没人记账（与 `testGuardAsksTheDropQuestionAtEveryStageOfAWindow` 同一条）。
    func testGuardAsksTheDisableQuestionAtEveryStageOfAWindow() {
        let source = DisableCapableSource()
        let guard_ = AttributionGuard(
            inputSource: source, clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(source.disableQuestionCount, 0)
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        XCTAssertEqual(source.disableQuestionCount, 1, "acquire 问一次")
        guard_.monitorInput()
        XCTAssertEqual(source.disableQuestionCount, 2, "每次采样问一次")
        _ = guard_.releaseOperationRight()
        XCTAssertEqual(source.disableQuestionCount, 3, "release 收尾再问一次")
    }

    /// 只覆盖前两问的 conformer（既有两个测试桩就是这个形状）必须逐字维持今天的语义：
    /// 协议默认值 false 就是它们那一边界的真话。
    func testDefaultAnswerKeepsNonTogglingSourcesExactlyAsToday() {
        let guard_ = AttributionGuard(
            inputSource: LegacyShapeSource(), clock: { Date(timeIntervalSince1970: 1_000) }
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        guard_.monitorInput()
        let verdict = guard_.releaseOperationRight()
        XCTAssertTrue(verdict.monitored, "没有重装这回事的源，第三问不该凭空折它")
        XCTAssertFalse(verdict.contaminated)
    }

    // MARK: - 生产接线（真 tap 装不上，所以这一半只能钉文本）

    /// `CGEventInputMonitor` 必须把**自己那个**读清位接到协议这一问上，而
    /// `AttributionGuard` 必须是它在生产里的读者——本缺陷的全部原因就是"位有人置、
    /// 没人问"。协议默认实现是 false，接线一断就等于"生产从没掉过"，运行时没有第二条
    /// 路能看见这件事（`disablePendingReport` 是 private，真 tap 又装不上）。
    /// REVERSE：把那一问的函数体改成 `false` → witness body 那条红；删掉守卫里的
    /// `noteTapDisabled()` 方法体 → 读者那两条红。
    func testMonitorWiresItsOwnDisableLatchToAProductionReader() throws {
        let monitorURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/GlassPaneEngine/CGEventInputMonitor.swift")
        let monitor = try String(contentsOf: monitorURL, encoding: .utf8)
        let guardURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/GlassPaneEngine/AttributionGuard.swift")
        let guardSource = try String(contentsOf: guardURL, encoding: .utf8)

        XCTAssertTrue(
            monitor.contains("public func inputTapDisabledSinceLastCheck() -> Bool"),
            "协议这一问在生产 monitor 上没有了实现，默认 false 就成了生产答案"
        )
        let bodyRange = try XCTUnwrap(
            monitor.range(of: "public func inputTapDisabledSinceLastCheck() -> Bool"),
            "接线声明不见了"
        )
        let after = monitor[bodyRange.upperBound...]
        XCTAssertTrue(
            after.hasPrefix(" {\n        disabledSinceLastCheck()\n    }"),
            "那一问没有转发到自己那个读清位，它报的是默认值：\(after.prefix(120))"
        )
        // 停用要真的置位，否则读清位恒 false——本文件测的是折叠，置位在这里钉。
        XCTAssertTrue(monitor.contains("disablePendingReport = true"),
                      "掉线不再置位：这一问就永远回 false，缺陷换个位置回来")

        XCTAssertTrue(guardSource.contains("source.inputTapDisabledSinceLastCheck()"),
                      "守卫没问这一问：读清位又只剩测试在读，就是本轮修的那件事")
        XCTAssertTrue(guardSource.contains("noteTapDisabled()"),
                      "折叠那一支没有了")
        let callCount = guardSource.components(separatedBy: "noteTapDisabled()").count - 1
        XCTAssertEqual(callCount, 3, "acquire / 采样 / 方法定义——少于三处就有某个阶段没人问")
        XCTAssertTrue(guardSource.contains("tapDisabledFault"),
                      "具名原因没有了，档案里就只剩一个没有解释的 monitored:false")
    }
}

/// 有"掉过一次又装回来"语义的注入源：实现 `InputEventSource` + `InputSourceMonitoring`
/// 并覆盖第三问，守卫发现它的方式与发现 `CGEventInputMonitor` 完全一致。置位一次只报
/// 一次（读后清零），照抄 `disabledSinceLastCheck()` 的语义——这样用例测的是守卫怎么
/// 折叠，而不是桩自己怎么粘。存活位恒为真：本缺陷的形状就是"两次采样都读到在测"。
private final class DisableCapableSource: InputEventSource, InputSourceMonitoring {
    private var disablePending = false
    private(set) var disableQuestionCount = 0

    func armDisable() { disablePending = true }

    func nextEvent() -> InputEvent? { nil }

    func peekAvailable() -> [InputEvent] { [] }

    var isMonitoringInput: Bool { true }

    var inputMonitoringFault: String? { nil }

    func inputTapDisabledSinceLastCheck() -> Bool {
        disableQuestionCount += 1
        let seen = disablePending
        disablePending = false
        return seen
    }
}

/// 只覆盖协议前两问的 conformer：第三问走扩展里的默认实现。既有测试桩就是这个形状，
/// 它不改一行也必须继续编译、继续按今天判定。
private final class LegacyShapeSource: InputEventSource, InputSourceMonitoring {
    var isMonitoringInput: Bool { true }
    var inputMonitoringFault: String? { nil }
    func nextEvent() -> InputEvent? { nil }
    func peekAvailable() -> [InputEvent] { [] }
}
