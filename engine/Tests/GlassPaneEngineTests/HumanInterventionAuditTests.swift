import XCTest
@testable import GlassPaneEngine

/// Human-intervention audit batch (P6 spec §11, item ①): the GP_E_BUSY_INPUT
/// remedy used to promise a "degrade mode" that did not exist. These tests pin
/// the real `degrade` parameter end-to-end: AttributionGuard degraded
/// acquisition (backdated hold start charges the busy window into the
/// contamination verdict), EngineCore.act(degrade:) admission, and Dispatcher
/// parameter routing/validation. No AX dependency.
///
/// Same charter, round 1 (R2-13/R2-16/R6-06/R5-03/R2-02/R2-03/R5-07): no remedy
/// may name a command the surface doesn't parse, no CLI line may read as a state
/// change that no code performs, no agent-authored string may reach the terminal
/// unescaped, and the startup guard's own helpers must actually bound what they
/// claim to bound.
final class HumanInterventionAuditTests: XCTestCase {

    // MARK: - Helpers

    private func makeCore(
        channel: ScriptedChannel,
        guard source: InputEventSource,
        now: Date = Date(timeIntervalSince1970: 1_000)
    ) -> (EngineCore, AttributionGuard) {
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { now },
            idleWindowSeconds: 0.5
        )
        let core = EngineCore(channel: channel, clock: { now }, attributionGuard: guard_)
        return (core, guard_)
    }

    private func pressSubmit(_ core: EngineCore, degrade: Bool = false) throws -> [String: Any] {
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        return try core.act(
            selector: Selector(role: "AXButton", title: "Submit"),
            action: .press,
            degrade: degrade
        )
    }

    // MARK: - AttributionGuard degraded acquisition

    func testDegradeAcquireAdmitsBusyWindowAndChargesContamination() {
        // One human event 0.1s before `now`: inside the 0.5s idle window, so
        // the normal acquire refuses. The degraded acquire admits, and the
        // backdated hold start must charge this event into the verdict.
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.9, source: .human)
        ])
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) },
            idleWindowSeconds: 0.5
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .idleNotMet)
        XCTAssertEqual(guard_.acquireOperationRight(degradeOnBusy: true), .acquired)
        XCTAssertTrue(guard_.isHolding)
        guard_.monitorInput()
        let verdict = guard_.releaseOperationRight()
        XCTAssertTrue(verdict.contaminated,
            "a degraded admission over a busy window must never look clean")
        XCTAssertEqual(verdict.humanEvents.map(\.timestamp), [999.9])
    }

    func testDegradeAcquireOnQuietWindowStaysClean() {
        // degrade:true on an idle window is just a normal acquisition —
        // no phantom contamination, and the out-of-window human event (999.0,
        // before the un-backdated hold start of 1000.0) stays uncharged.
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.0, source: .human)
        ])
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) },
            idleWindowSeconds: 0.5
        )
        XCTAssertEqual(guard_.acquireOperationRight(degradeOnBusy: true), .acquired)
        let verdict = guard_.releaseOperationRight()
        XCTAssertFalse(verdict.contaminated)
        XCTAssertTrue(verdict.humanEvents.isEmpty)
    }

    func testDegradeAcquireWhileHoldingIsIdleNotMet() {
        let source = ScriptedInputEventSource(events: [])
        let guard_ = AttributionGuard(
            inputSource: source,
            clock: { Date(timeIntervalSince1970: 1_000) },
            idleWindowSeconds: 0.5
        )
        XCTAssertEqual(guard_.acquireOperationRight(), .acquired)
        XCTAssertEqual(guard_.acquireOperationRight(degradeOnBusy: true), .idleNotMet)
        _ = guard_.releaseOperationRight()
    }

    // MARK: - EngineCore.act(degrade:)

    func testActDegradeAdmitsBusyWindowAsWeakContaminatedEvidence() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.9, source: .human)
        ])
        let (core, _) = makeCore(channel: channel, guard: source)
        let result = try pressSubmit(core, degrade: true)
        XCTAssertEqual(result["actConfirmed"] as? Bool, true)
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertEqual(pack.attribution.level, .weak)
        XCTAssertTrue(pack.attribution.contaminated,
            "degrade admits the act but the busy window must be recorded, never silently clean")
    }

    func testActWithoutDegradeStillRefusesBusyWindow() throws {
        // Regression: the default path is byte-for-byte the old semantics —
        // bounded retries, then GP_E_BUSY_INPUT and no evidence recorded.
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(128)
        let source = ScriptedInputEventSource(events: [
            InputEvent(timestamp: 999.9, source: .human)
        ])
        let (core, _) = makeCore(channel: channel, guard: source)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertThrowsError(
            try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        ) { error in
            guard let gpError = error as? GPError else {
                return XCTFail("expected GPError, got \(error)")
            }
            XCTAssertEqual(gpError.code, .busyInput)
            XCTAssertTrue(gpError.remedy.contains("\"degrade\": true"),
                "the remedy must point at the parameter that actually exists")
        }
        XCTAssertThrowsError(try core.lastEvidence(operationId: nil))
    }

    // MARK: - Dispatcher parameter routing

    private func makeDispatcher() -> (ScriptedChannel, Dispatcher) {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        return (channel, Dispatcher(core: EngineCore(channel: channel, settle: {})))
    }

    private func perform(_ dispatcher: Dispatcher, _ json: String) throws -> [String: Any] {
        let response = dispatcher.handle(.frame(Data(json.utf8)))
        let object = try JSONSerialization.jsonObject(with: response, options: [])
        return try XCTUnwrap(object as? [String: Any])
    }

    func testDispatcherAcceptsDegradeBoolean() throws {
        let (_, dispatcher) = makeDispatcher()
        _ = try perform(dispatcher, "{\"id\":1,\"method\":\"attach\",\"params\":{\"bundleId\":\"com.example.app\"}}")
        let response = try perform(dispatcher,
            "{\"id\":2,\"method\":\"act\",\"params\":{\"selector\":{\"role\":\"AXButton\",\"title\":\"Submit\"},\"action\":\"press\",\"degrade\":true}}"
        )
        let result = try XCTUnwrap(response["result"] as? [String: Any])
        XCTAssertEqual(result["actConfirmed"] as? Bool, true)
    }

    func testDispatcherRejectsNonBooleanDegrade() throws {
        let (_, dispatcher) = makeDispatcher()
        _ = try perform(dispatcher, "{\"id\":1,\"method\":\"attach\",\"params\":{\"bundleId\":\"com.example.app\"}}")
        let response = try perform(dispatcher,
            "{\"id\":2,\"method\":\"act\",\"params\":{\"selector\":{\"role\":\"AXButton\",\"title\":\"Submit\"},\"action\":\"press\",\"degrade\":\"yes\"}}"
        )
        let error = try XCTUnwrap(response["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "GP_E_BAD_PARAMS")
    }

    // MARK: - Remedy 文案只指真存在的命令（R2-13：幻影 remedy）

    /// main.swift / cli.js 是 executable 与 node 脚本，测试进程拿不到它们的解析器，
    /// 所以把源码本身读进来当契约核对：remedy 里点名的每个 flag 都必须真的被解析。
    private func repoSource(_ relativePath: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests/GlassPaneEngineTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // engine
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func flags(after marker: String, in text: String) -> [String] {
        var found: [String] = []
        var search = Substring(text)
        while let range = search.range(of: marker) {
            search = search[range.upperBound...]
            let token = search.prefix { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
            if token.hasPrefix("--") { found.append(String(token)) }
        }
        return found
    }

    func testEveryRemedyFlagIsParsedByTheSurfaceItNames() throws {
        let daemonSource = try repoSource("engine/Sources/glasspaned/main.swift")
        let installerSource = try repoSource("installer/cli.js")
        var checked = 0
        for code in GPErrorCode.allCases {
            let remedy = GPError.remedy(for: code)
            for flag in flags(after: "glasspaned ", in: remedy) {
                XCTAssertTrue(daemonSource.contains("case \"\(flag)\":"),
                    "\(code.rawValue) 的 remedy 指向 glasspaned \(flag)，但解析器里没有这个 case：\(remedy)")
                checked += 1
            }
            for flag in flags(after: "installer/cli.js ", in: remedy) {
                XCTAssertTrue(installerSource.contains("case '\(flag)':"),
                    "\(code.rawValue) 的 remedy 指向 installer \(flag)，但 cli.js 不解析它：\(remedy)")
                checked += 1
            }
        }
        XCTAssertGreaterThan(checked, 1, "扫描器必须真的抓到东西，否则这条闸是空跑")
    }

    func testAccessibilityRemedyActsOnTheDaemonIdentityNotTheCaller() throws {
        let remedy = GPError.remedy(for: .axUnavailable)
        XCTAssertTrue(remedy.contains("--restore-launchd"),
            "remedy 必须指向真正读 daemon 自报席位并换进程复验的路径")
        XCTAssertTrue(remedy.contains("kickstart"),
            "daemon 身份生效靠 launchctl kickstart -k（见 PermissionGuide.daemonRestartCommand）")
        // --grant-accessibility 仍然存在于 CLI，但它申请的是调用方的席位：只允许
        // 出现在"别这么干"的否定语里（P1 v1.2 §11.4 的借来席位=假绿灯）。
        let lowered = remedy.lowercased()
        if let at = lowered.range(of: "--grant-accessibility") {
            XCTAssertTrue(lowered[lowered.startIndex..<at.lowerBound].contains("do not"),
                "remedy 不得再把 --grant-accessibility 当作修 daemon 的办法推荐")
        }
        XCTAssertTrue(lowered.contains("inconclusive"),
            "拿不到 daemon 席位时必须表达为不确定，而不是让 agent 盲目重试")
    }

    // MARK: - --active-project 不得读成状态变更（R2-16/R6-06/R5-03）

    func testActiveProjectSurfaceReportsInsteadOfClaimingAWrite() throws {
        let source = try repoSource("engine/Sources/glasspaned/main.swift")
        XCTAssertFalse(source.contains("Set the active project ID"),
            "帮助文案不得再声称这条命令会设置活跃项目")
        let blockStart = try XCTUnwrap(
            source.range(of: "if let activeId = options.activeProjectId"),
            "--active-project 的处理块不见了"
        )
        let blockEnd = try XCTUnwrap(
            source.range(of: "if let recipePath"),
            "--recipe-validate 的处理块不见了（切片锚点）"
        )
        let block = source[blockStart.lowerBound..<blockEnd.lowerBound]
        XCTAssertTrue(block.contains("\"stateChanged\": false"),
            "输出必须显式否认状态变更，否则退出码 0 + 确认行就是幻影控制面")
        XCTAssertTrue(block.contains("writeJSON("),
            "displayName 是 agent 自撰内容，只能经 JSON 转义出口离开进程")
        XCTAssertFalse(block.contains("active project: "),
            "旧那行 `active project: X (Y)` 原文打印既没转义又暗示写入")
        XCTAssertFalse(block.contains("Data(\""),
            "不得再手拼字面向标准流写字节")
        // 同一口径的另一半：CLI 里不许再出现手拼的 JSON 错误帧（recipe-validate
        // 与 --prune-evidence 曾经各自 `Data("{..."}")` 插值路径/projectId）。
        XCTAssertFalse(source.contains("Data(\"{"),
            "手拼 JSON 的错误帧会把未转义的路径/projectId 直接吐给终端（R5-03）")
    }

    func testAgentTextEscapesTerminalControlSequencesAndRoundTrips() throws {
        let hostile = "count\u{1b}]52;c;Y3VybA==\u{7}\ntwo\"quoted\"lines"
        let line = try XCTUnwrap(AgentText.jsonLine(["displayName": hostile]))
        XCTAssertTrue(line.hasSuffix("\n"), "一行一条，供 CLI 直接 write")
        XCTAssertFalse(AgentText.containsTerminalControlText(String(line.dropLast())),
            "ESC/BEL/NUL/换行不得以原字节离开进程——只能以转义序列出现")
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        )
        XCTAssertEqual(decoded["displayName"] as? String, hostile,
            "转义必须无损：核验报告读回来还是那个名字")
    }

    // MARK: - 有界探测预算（R2-03/R5-07：滴字节的对端与不排水的对端）

    func testSocketDeadlineBoundsADribblingPeerWherePerSyscallTimeoutCannot() {
        var fakeNow = 1_000
        let deadline = SocketDeadline(seconds: 3, now: { TimeInterval(fakeNow) })
        XCTAssertEqual(deadline.pollMillis(), 3_000)
        fakeNow += 2
        XCTAssertEqual(deadline.pollMillis(), 1_000, "剩余预算取整到毫秒，不得为负")
        fakeNow += 2
        XCTAssertTrue(deadline.expired(), "对端每次都在单次 SO_RCVTIMEO 内滴 1 字节，但绝对时限会到")
        XCTAssertEqual(deadline.pollMillis(), 0, "过期后必须是 0（poll 立即返回）而不是 -1（无限阻塞）")
        XCTAssertEqual(deadline.remaining(), 0, "剩余量不得为负")

        // 旧读环的形状：每轮读到 1 字节、每次都不触发单次超时 → 无界。
        var budget = ResponseBudget(maxBytes: 4_096)
        fakeNow = 1_000
        let bounded = SocketDeadline(seconds: 3, now: { TimeInterval(fakeNow) })
        var reads = 0
        while !bounded.expired() {
            reads += 1
            budget.accept(1)
            fakeNow += 1
            XCTAssertLessThan(reads, 10, "绝对时限必须自己收口，不能靠对端配合")
        }
        XCTAssertEqual(reads, 3, "3s 预算 = 3 轮，第 4 轮进不来")
        XCTAssertEqual(budget.receivedBytes, 3)
    }

    func testResponseBudgetStopsABlastingPeerAtTheByteCap() {
        var budget = ResponseBudget(maxBytes: 8)
        XCTAssertEqual(budget.remainingBytes, 8)
        XCTAssertEqual(budget.accept(5), 5)
        XCTAssertFalse(budget.isFull)
        XCTAssertEqual(budget.accept(99), 3, "超出上限的部分不计入，读尺寸按 remainingBytes 申请")
        XCTAssertTrue(budget.isFull)
        XCTAssertEqual(budget.accept(1), 0)
        XCTAssertEqual(budget.receivedBytes, 8, "计数永不超过上限")
        XCTAssertEqual(budget.remainingBytes, 0)
    }

    // MARK: - 单实例护栏真值表（R2-02/A-18：不许默认抢占）

    func testTakeoverDecisionNeverPreemptsWithoutAnExplicitFlag() {
        let summary = DaemonProbe.Summary(version: "1.1.0", protocolVersion: "0", pid: 4242)
        let wedged = DaemonProbe.Liveness.presentButNotAnswering(reason: "no reply within 3s")
        // 旧护栏用 helloSummary，这一格等于"没有 daemon"→ 直接 unlink+bind 覆盖活实例。
        XCTAssertEqual(
            DaemonProbe.takeoverDecision(wedged, force: false),
            .refuse(incumbent: "a listener owns the name but did not answer hello (no reply within 3s)")
        )
        XCTAssertEqual(
            DaemonProbe.takeoverDecision(.answered(summary), force: false),
            .refuse(incumbent: "pid 4242, version 1.1.0 answers hello")
        )
        XCTAssertEqual(
            DaemonProbe.takeoverDecision(.answered(summary), force: true),
            .preempt(incumbent: "pid 4242, version 1.1.0 answers hello")
        )
        XCTAssertEqual(
            DaemonProbe.takeoverDecision(.noListener(reason: "connection refused"), force: false),
            .bind, "只有确实无主的名字才默认放行（清残留文件）"
        )
    }

    func testLivenessKeepsMissingStaleAndWedgedNamesApart() {
        // 回了字节但不是合规 hello：仍然是"有人听但不开口"，不能当成没有 daemon。
        let garbage = DaemonProbe(
            fileExists: { _ in true },
            rawTransport: { _, _, _ in .answered(Data("nope".utf8)) }
        )
        XCTAssertEqual(
            garbage.liveness(socketPath: "/tmp/gp/engine.sock"),
            .presentButNotAnswering(reason: "answered 4 byte(s) that are not a compliant hello")
        )
        // probe.sock 的监听者按协议永不回话：连接能建立就等于名字有主（A-18），
        // 所以护栏对它用 waitForHello: false —— 否则每个第二次启动的 daemon 都会
        // 白等 3s 再把名字抢走。
        var sawWaitForHello: Bool?
        let recorder: DaemonProbe.RawTransport = { _, _, waitForHello in
            sawWaitForHello = waitForHello
            return .occupied(reason: "listener accepted the connection")
        }
        let probeName = DaemonProbe(fileExists: { _ in true }, rawTransport: recorder)
            .liveness(socketPath: "/tmp/gp/probe.sock", waitForHello: false)
        XCTAssertEqual(sawWaitForHello, false)
        XCTAssertEqual(
            DaemonProbe.takeoverDecision(probeName, force: false),
            .refuse(incumbent: "a listener owns the name but did not answer hello (listener accepted the connection)"),
            "第二个 daemon 不得静默抢走 probe.sock，把归因面劈成两个进程"
        )
        // 文件都不存在时根本不该去 connect：原因串必须来自缺文件分支。
        let absent = DaemonProbe(
            fileExists: { _ in false },
            rawTransport: { _, _, _ in .answered(Data("should never be consulted".utf8)) }
        )
        XCTAssertEqual(
            absent.liveness(socketPath: "/tmp/gp/none.sock"),
            .noListener(reason: "no socket file at /tmp/gp/none.sock")
        )
    }
}
