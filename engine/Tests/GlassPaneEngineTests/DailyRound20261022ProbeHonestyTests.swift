import XCTest
@testable import GlassPaneEngine

/// 2026-10-22 每日轮 · 探针诚实性三处已核实缺陷。
///
/// 三处都是同一个形状：**一条没有测完的通道被说成测过了**。
///   1. `ProbeInbox.lateCount(opId:)` 只看"哪些事件已经到了"，不看"宽限期是否已经
///      走完"，于是 act 后 0.3 s 的 diagnose 得到 `late = 0`，`refreshLateCount` 见
///      `0 == stored.lateCount` 答 `.confirmed`（"无需改写"），归档里留下一个冒充
///      测量的 `lateCount: 0`，T8 对这份档案永远无法变红。
///   2. `Classifier` 的 T8 用 `(stateChanged ?? false)` 把**没有 state 通道**折成
///      "state 没变"，而同文件上面刚刚谴责过像素通道的同一种折法。
///   3. daemon 侧 512 事件环溢出丢事件既不计数也不上报，`hitCount: N` 与截短的
///      `handlers` 就被当成完整测量发出。
///
/// 用例的事件形状取自真实帧（`.handler(file:line:ts:durationNs:)` /
/// `.state(key:before:after:source:ts:)`，`EngineP6ProbeTests` 的用法），档案形状取自
/// `endWindow` 真输出的信号，不是手造的 dict。注释里的 `REVERSE:` 写明退回哪一处修复
/// 会让这一条变红。
final class DailyRound20261022ProbeHonestyTests: XCTestCase {

    private static let clockStart = Date(timeIntervalSince1970: 1_758_300_000)

    /// 两个标签都按字面量写死：它们是档案读者要匹配的字符串，生产者改名时这里必须
    /// 断掉，而不是跟着一起编译通过。
    private static let unmeasuredLabel = "late-arrivals-unmeasured"
    private static let evictedLabel = "probe-events-evicted"
    /// The remedy both refusal sentences have to point at — *after* the grace.
    private static let afterGraceAdvice = "diagnose only after the grace has elapsed"

    private final class TimeBox {
        var now = DailyRound20261022ProbeHonestyTests.clockStart
    }

    private func hello(pid: Int32 = 4242, capabilities: [String] = ["z1", "z2"]) -> ProbeHello {
        ProbeHello(
            pid: pid, bundleId: "com.example.app", appName: "Example",
            probeVersion: "gp-probe/0.1.0", capabilities: capabilities
        )
    }

    /// A pack carrying exactly the signals one real window closed with — the shape
    /// `Classifier` and `diagnose` actually consume.
    private func pack(
        opId: String,
        signals: (handlerProbe: HandlerProbeSignal?, stateDiff: StateDiffSignal?),
        reason: String? = nil
    ) -> EvidencePack {
        let base = TestTrees.standard
        return EvidencePack(
            operationId: opId,
            createdAt: "2026-10-22T00:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal, reason: reason),
            signals: Signals(
                act: ActSignal(selector: Selector(role: "AXButton", title: "Submit"), action: .press, actConfirmed: true),
                axEvent: AxEventSignal(
                    treeDigestBefore: base.digest, treeDigestAfter: base.digest,
                    nodeCount: base.nodeCount, axChanged: false, latencyMs: 20
                ),
                handlerProbe: signals.handlerProbe,
                stateDiff: signals.stateDiff,
                pixelDiff: PixelDiffSignal(changedPixelRatio: 0, bounds: nil, windowId: 12),
                responsiveness: ResponsivenessSignal(responsive: true, pingMs: 3),
                crash: CrashSignal(processAliveBefore: true, processAliveAfter: true)
            )
        )
    }

    /// An engine + archive wired to one inbox, on the shared frozen clock.
    private func makeCore(
        time: TimeBox, inbox: ProbeInbox, label: String
    ) throws -> (core: EngineCore, store: EvidenceStore) {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        let store = TestSandbox.evidenceStore(at: TestSandbox.directory(label))
        let core = EngineCore(
            channel: channel, clock: { time.now }, settle: {},
            evidenceStore: store, probeInbox: inbox
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        return (core, store)
    }

    @discardableResult
    private func act(_ core: EngineCore) throws -> String {
        let result = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        return try XCTUnwrap(result["operationId"] as? String)
    }

    // MARK: - Defect 1: a late count that cannot be final yet

    /// REVERSE: 删掉 `lateReading` 里 `elapsed > lateGraceSeconds` 那道闸（退回"只看
    /// 已经到达的事件"），第一条断言就红 —— 宽限期还剩 1.5 s 时它会读出 1。
    func testLateCountIsNilWhileTheGracePeriodHasNotClosed() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_grace_open")
        XCTAssertNotNil(inbox.endWindow(pid: 4242, opId: "op_grace_open"))

        time.now = time.now.addingTimeInterval(0.5)
        inbox.ingest(pid: 4242, frame: .handler(file: "Async.swift", line: 7, ts: 0, durationNs: nil))
        XCTAssertNil(
            inbox.lateCount(opId: "op_grace_open"),
            "宽限期还没走完，这个数就不是迟到达的计数，而是「到目前为止到了几个」"
        )

        // Control: the same read after the grace closes is a real measurement.
        time.now = time.now.addingTimeInterval(ProbeInbox.lateGraceSeconds)
        XCTAssertEqual(
            inbox.lateCount(opId: "op_grace_open"), 1,
            "修复不能变成「宽限期内永远读不出数」——走完之后就是一次真测量"
        )
    }

    /// The §2.2 entry/duration pairing still holds for late frames — one slow
    /// invocation is two frames and one late count. Read after the grace closes,
    /// which is the only moment that count is final (defect 1).
    /// REVERSE: 去掉 `lateCount` 循环里的 `countsAsInvocation` 判定 → 读出 2 → 这条红。
    func testLateDurationPairIsCountedOnceOnceTheGraceCloses() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_late_pair_final")
        XCTAssertNotNil(inbox.endWindow(pid: 4242, opId: "op_late_pair_final"))
        time.now = time.now.addingTimeInterval(0.4)
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 88, ts: 0, durationNs: nil))
        inbox.ingest(pid: 4242, frame: .handler(file: "View.swift", line: 88, ts: 0, durationNs: 3_000_000))
        time.now = time.now.addingTimeInterval(ProbeInbox.lateGraceSeconds)
        XCTAssertEqual(
            inbox.lateCount(opId: "op_late_pair_final"), 1,
            "一次慢调用 = 一条入口帧 + 一条时长帧，宽限期走完后仍是 1"
        )
    }

    /// Two opposite refusals used to share one sentence. `refreshLateCount` now has
    /// to say which one it is, or the caller is told to re-run an act that could
    /// merely have waited.
    /// REVERSE: 让 `.graceOpen` 复用窗口已出环那句（旧的单一 reason），第一条红；把
    /// 宽限期分支整个去掉（退回 `.unmeasurable` 只剩一种成因），第二条红。
    func testRefreshLateCountDistinguishesAnUnelapsedGraceFromAGoneWindow() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_two_refusals")
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_two_refusals"))
        let stored = try XCTUnwrap(signals.handlerProbe)
        let target = pack(opId: "op_two_refusals", signals: (handlerProbe: stored, stateDiff: signals.stateDiff))

        time.now = time.now.addingTimeInterval(0.5)
        guard case let .unmeasurable(graceReason) = inbox.refreshLateCount(for: target) else {
            return XCTFail("宽限期未走完时必须拒绝认证这个数，而不是 .confirmed")
        }
        XCTAssertTrue(graceReason.contains("still open"), graceReason)
        XCTAssertTrue(graceReason.contains("1.50"), "要把还剩多少秒说出来：\(graceReason)")
        XCTAssertFalse(graceReason.contains("no longer in the probe inbox"), graceReason)

        // The other cause: the window record itself left the 16-entry ring.
        for index in 0..<ProbeInbox.windowHistoryLimit {
            let filler = "op_filler_\(index)"
            inbox.beginWindow(pid: 4242, opId: filler)
            XCTAssertNotNil(inbox.endWindow(pid: 4242, opId: filler))
        }
        guard case let .unmeasurable(goneReason) = inbox.refreshLateCount(for: target) else {
            return XCTFail("窗口已经出环，同样不能认证")
        }
        XCTAssertTrue(goneReason.contains("no longer in the probe inbox"), goneReason)
        XCTAssertFalse(goneReason.contains("still open"), "两种成因不许共用一句话：\(goneReason)")
    }

    /// The advice sentence used to send callers *into* the one interval in which the
    /// count cannot be known ("re-run the act, then diagnose within 2 s of it").
    /// REVERSE: 把两句里的方向词改回 `then diagnose within \(grace)s of it`，两条都红。
    func testUnmeasurableReasonsPointAfterTheGraceNeverInsideIt() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_advice")
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_advice"))
        let target = pack(opId: "op_advice", signals: signals)

        time.now = time.now.addingTimeInterval(0.3)
        let grace = inbox.refreshLateCount(for: target)
        guard case let .unmeasurable(graceReason) = grace else {
            return XCTFail("宽限期内应当拒绝：\(grace)")
        }
        XCTAssertTrue(graceReason.contains(Self.afterGraceAdvice), graceReason)
        XCTAssertFalse(graceReason.contains("then diagnose within"), graceReason)

        for index in 0..<ProbeInbox.windowHistoryLimit {
            let filler = "op_advice_filler_\(index)"
            inbox.beginWindow(pid: 4242, opId: filler)
            _ = inbox.endWindow(pid: 4242, opId: filler)
        }
        guard case let .unmeasurable(goneReason) = inbox.refreshLateCount(for: target) else {
            return XCTFail("出环之后同样要拒绝")
        }
        XCTAssertTrue(goneReason.contains(Self.afterGraceAdvice), goneReason)
        XCTAssertFalse(goneReason.contains("then diagnose within"), goneReason)
    }

    /// The P1 shape end to end: act, diagnose 0.3 s later (the normal agent rhythm).
    /// Before the fix the refresh saw `0 == stored.lateCount`, answered `.confirmed`,
    /// and the archived pack kept a `lateCount: 0` that nobody ever measured.
    /// REVERSE: 去掉 `lateCount(opId:)` 的宽限期闸 → `.confirmed` → reason 里没有那句
    /// 拒绝，第一条红（这条同时是 defect 1 的总闸）。
    func testFastDiagnoseRefusesToCertifyAnUnfinishedLateCount() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.sender = { _, _ in true }
        inbox.register(hello())
        let (core, store) = try makeCore(time: time, inbox: inbox, label: "gp-fast-diagnose")
        let operationId = try act(core)

        time.now = time.now.addingTimeInterval(0.3)
        _ = try core.diagnose(operationId: operationId)
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.signals.handlerProbe?.lateCount, 0)
        XCTAssertNotNil(
            pack.circuitBreaker.reason,
            "REVERSE: `late = 0 == stored.lateCount` 又被当成测量了 —— 一个没测完的数必须自带说明"
        )
        XCTAssertTrue(
            pack.circuitBreaker.reason?.contains(Self.unmeasuredLabel) == true,
            pack.circuitBreaker.reason ?? "nil"
        )
        XCTAssertTrue(
            pack.circuitBreaker.reason?.contains("still open") == true,
            "要说清是宽限期没走完，不是窗口没了：\(pack.circuitBreaker.reason ?? "nil")"
        )
        XCTAssertNotEqual(
            try XCTUnwrap(core.diagnose(operationId: operationId)["class"] as? String), "T8",
            "计数还没测完，T8 不能凭它成立"
        )
        let archived = try XCTUnwrap(store.read(operationId: operationId))
        XCTAssertTrue(
            archived.circuitBreaker.reason?.contains(Self.unmeasuredLabel) == true,
            "落盘的那份才是面板与 gp_export_evidence 读的：\(archived.circuitBreaker.reason ?? "nil")"
        )
    }

    /// Defect 1(d): the second diagnose, once the grace has closed, really measures —
    /// and then the earlier "this count can never be verified" sentence is a false
    /// claim about the pack and must not be left behind.
    /// REVERSE: 删掉 `.measured` 分支里的 `removingLateArrivalsBasis` → 标签留在档案里
    /// → 第二条红；把宽限期闸去掉 → 第一步没人写标签，第三条断言（late=1 之前不该有
    /// 标签）读起来仍绿，所以 defect 1 本体由上一条把守。
    func testDiagnoseAfterTheGraceMeasuresTheLateCountAndClearsTheStaleRefusal() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.sender = { _, _ in true }
        inbox.register(hello())
        let (core, store) = try makeCore(time: time, inbox: inbox, label: "gp-late-after-grace")
        let operationId = try act(core)

        time.now = time.now.addingTimeInterval(0.3)
        _ = try core.diagnose(operationId: operationId)
        XCTAssertTrue(
            try core.lastEvidence(operationId: operationId).circuitBreaker.reason?
                .contains(Self.unmeasuredLabel) == true,
            "前提：宽限期内的诊断写下了那句拒绝"
        )

        // The late arrival lands *inside* the grace (that is what makes it late);
        // the read that can call it final happens after the grace has closed.
        time.now = time.now.addingTimeInterval(0.2)
        inbox.ingest(pid: 4242, frame: .handler(file: "Async.swift", line: 21, ts: 0, durationNs: nil))
        time.now = time.now.addingTimeInterval(ProbeInbox.lateGraceSeconds)
        let diagnosis = try core.diagnose(operationId: operationId)
        XCTAssertEqual(diagnosis["class"] as? String, "T8")
        let refreshed = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(refreshed.signals.handlerProbe?.lateCount, 1)
        XCTAssertNil(
            refreshed.circuitBreaker.reason,
            "计数已经量到了，档案里不能再留着「这个数无法验证」：\(refreshed.circuitBreaker.reason ?? "nil")"
        )
        let archived = try XCTUnwrap(store.read(operationId: operationId))
        XCTAssertFalse(
            archived.circuitBreaker.reason?.contains(Self.unmeasuredLabel) ?? false,
            "落盘的那份也要把拒绝撤掉：\(archived.circuitBreaker.reason ?? "nil")"
        )
    }

    /// `.confirmed` is now only reachable after the grace elapsed, which makes it a
    /// measurement of "no late arrivals" — the stale refusal has to go here too, not
    /// only when a non-zero count arrives.
    /// REVERSE: 把 `.confirmed` 分支退回 `case .confirmed, .notCarried: break` → 第三条红。
    func testConfirmedNoLateArrivalsAfterTheGraceClearsTheStaleRefusal() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.sender = { _, _ in true }
        inbox.register(hello())
        let (core, store) = try makeCore(time: time, inbox: inbox, label: "gp-late-confirmed")
        let operationId = try act(core)

        time.now = time.now.addingTimeInterval(0.3)
        _ = try core.diagnose(operationId: operationId)
        XCTAssertTrue(
            try core.lastEvidence(operationId: operationId).circuitBreaker.reason?
                .contains(Self.unmeasuredLabel) == true,
            "前提：宽限期内的诊断写下了那句拒绝"
        )

        time.now = time.now.addingTimeInterval(ProbeInbox.lateGraceSeconds)
        _ = try core.diagnose(operationId: operationId)
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(pack.signals.handlerProbe?.lateCount, 0)
        XCTAssertNil(
            pack.circuitBreaker.reason,
            "宽限期走完后 0 是一次真测量，档案不能再声称它无从验证：\(pack.circuitBreaker.reason ?? "nil")"
        )
        let archived = try XCTUnwrap(store.read(operationId: operationId))
        XCTAssertNil(
            archived.circuitBreaker.reason,
            "落盘的那份也要把这句过期的拒绝撤掉：\(archived.circuitBreaker.reason ?? "nil")"
        )
    }

    /// The strip is segment-scoped: it may only remove *this label's own* sentence.
    /// `act` joins one segment per channel with `"; "`, and `diagnose` writes its
    /// basis without a `"; ` inside it, which is what makes the split lossless.
    /// REVERSE: 把 filter 的条件放宽成 `contains(label)` 之外还吃别的段，或整个改成
    /// `nil`（"清空 reason"）→ 第一条红；改成返回 `""` 而不是 nil → 第二条红。
    func testTheLateArrivalsStripLeavesOtherChannelsSentencesIntact() {
        let stacked = "pixel-capture-no-onscreen-window: nothing to capture; "
            + "\(Self.unmeasuredLabel): the 2s grace period after op_X closed is still open"
        XCTAssertEqual(
            EngineCore.removingLateArrivalsBasis(from: stacked),
            "pixel-capture-no-onscreen-window: nothing to capture",
            "别的通道说过的话不归它删"
        )
        XCTAssertNil(
            EngineCore.removingLateArrivalsBasis(from: "\(Self.unmeasuredLabel): only ours"),
            "只剩自己那句时要回到「没有原因」，而不是留一个空字符串冒充有原因"
        )
        XCTAssertEqual(
            EngineCore.removingLateArrivalsBasis(from: "ax-tree-capture-failed"),
            "ax-tree-capture-failed",
            "没有我们的标签时一个字节都不许动"
        )
        XCTAssertNil(EngineCore.removingLateArrivalsBasis(from: nil))
    }

    // MARK: - Defect 2: T8 folding an unanswered state channel into "state did not change"

    /// A z1-only probe has no state lane at all, so `stateDiff` is absent — and T8's
    /// "state did not change" premise was therefore never measured. Nothing later in
    /// `Classifier` catches `hitCount == 0` with `stateChanged == nil`: without the
    /// honest-gap arm the pack falls through to the black-box T3 ("dead click"),
    /// which contradicts the probe's own late arrivals.
    /// REVERSE: 把 T8 的条件退回 `(stateChanged ?? false) == false` → 判成 T8 → 第一条红。
    func testLateArrivalsWithoutAStateChannelDoNotClaimAsyncTiming() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.sender = { _, _ in true }
        inbox.register(hello(capabilities: ["z1"]))
        let (core, _) = try makeCore(time: time, inbox: inbox, label: "gp-t8-no-state")
        let operationId = try act(core)

        // The arrival is late but inside the grace; the read happens once the grace
        // has closed, so what withholds the verdict here is the missing state
        // channel and nothing else.
        time.now = time.now.addingTimeInterval(0.5)
        inbox.ingest(pid: 4242, frame: .handler(file: "Async.swift", line: 44, ts: 0, durationNs: nil))
        time.now = time.now.addingTimeInterval(ProbeInbox.lateGraceSeconds)
        let diagnosis = try core.diagnose(operationId: operationId)
        let diagnosisClass = try XCTUnwrap(diagnosis["class"] as? String)
        XCTAssertNotEqual(diagnosisClass, "T8", "state 通道从没答过，T8 的前提就是一次假设")
        XCTAssertNotEqual(diagnosisClass, "T3", "迟到事件已经证明 handler 跑过，黑盒的「点击没生效」与探针自相矛盾")
        XCTAssertEqual(diagnosisClass, "INCONCLUSIVE")
        let report = try XCTUnwrap(diagnosis["report"] as? [String: Any])
        let anomaly = try XCTUnwrap(report["anomaly"] as? String)
        XCTAssertTrue(
            anomaly.contains("no state channel"),
            "拒判要说清缺的是哪条通道：\(anomaly)"
        )
    }

    /// The control that keeps the fix from being "disable T8": the identical flow with
    /// a state channel that measured "no change" still lands on T8 with the refreshed
    /// late count.
    /// REVERSE: 若把三态写成 `stateChanged != nil`（或任何让 T8 永不成立的形式）→ 这条红。
    func testLateArrivalsWithAMeasuredQuietStateStillClaimT8() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.sender = { _, _ in true }
        inbox.register(hello(capabilities: ["z1", "z2"]))
        let (core, _) = try makeCore(time: time, inbox: inbox, label: "gp-t8-with-state")
        let operationId = try act(core)
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(
            pack.signals.stateDiff?.changed, false,
            "前提：state 通道真的量过并回答「没变」（有通道的空条目表是一次测量）"
        )

        time.now = time.now.addingTimeInterval(0.5)
        inbox.ingest(pid: 4242, frame: .handler(file: "Async.swift", line: 45, ts: 0, durationNs: nil))
        time.now = time.now.addingTimeInterval(ProbeInbox.lateGraceSeconds)
        let diagnosis = try core.diagnose(operationId: operationId)
        XCTAssertEqual(diagnosis["class"] as? String, "T8")
        XCTAssertEqual(try core.lastEvidence(operationId: operationId).signals.handlerProbe?.lateCount, 1)
    }

    // MARK: - Defect 3: daemon-side probe-event eviction was silent and uncounted

    /// REVERSE: `trimEvents` 不再累加 `ringEvictions`/`ringEvictionTotal` → 三条断言全红；
    /// 只留计数、不发布 `statusJSON` 的行键 → 第二条红。
    func testRingOverflowIsCountedPerPidAndPublishedOnTheStatusRow() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1"]))
        inbox.beginWindow(pid: 4242, opId: "op_overflow")
        let emitted = ProbeInbox.eventRingCapacity + 88
        for index in 0..<emitted {
            inbox.ingest(pid: 4242, frame: .handler(file: "Busy.swift", line: index, ts: 0, durationNs: nil))
        }
        let evicted = emitted - ProbeInbox.eventRingCapacity
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_overflow"))
        XCTAssertEqual(
            signals.handlerProbe?.hitCount, ProbeInbox.eventRingCapacity,
            "被丢掉的事件不会进 hitCount —— 这个数就是下界本身"
        )
        XCTAssertEqual(inbox.eventsEvictedDuringWindow(opId: "op_overflow"), evicted)
        let row = try XCTUnwrap(inbox.statusJSON().first)
        XCTAssertEqual(row["ringEvictedEvents"] as? Int, evicted, "\(row)")
        XCTAssertEqual(inbox.ringEvictionCount, evicted)
    }

    /// A fresh pid has not lost anything: the eviction tally belongs to the process
    /// that overflowed, the same rule `disconnect` already applies to the probe's
    /// self-reported counters and the A-09 tally.
    /// REVERSE: `disconnect` 里去掉 `ringEvictions.removeValue(forKey:)` → 第二条红
    /// （新进程替上一个进程背锅，一个"干净"的行被编出来）。
    func testDisconnectClearsTheEvictionTallyForTheNextProcess() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1"]))
        for index in 0..<(ProbeInbox.eventRingCapacity + 40) {
            inbox.ingest(pid: 4242, frame: .handler(file: "Busy.swift", line: index, ts: 0, durationNs: nil))
        }
        XCTAssertTrue(
            (inbox.statusJSON().first?["ringEvictedEvents"] as? Int) != nil,
            "前提：溢出确实被记了下来"
        )
        inbox.disconnect(pid: 4242, reason: "peer closed the connection (EOF)")
        inbox.register(hello(capabilities: ["z1"]))
        XCTAssertNil(
            inbox.statusJSON().first?["ringEvictedEvents"],
            "新进程还没丢过任何事件，不能继承上一个进程的账"
        )
        XCTAssertEqual(
            inbox.ringEvictionCount, 40,
            "单调总数留着历史，只是不记到后来那个 pid 头上"
        )
    }

    /// A busy window measured through the real act: the pack that carries the
    /// truncated `hitCount` has to say so, because the evidence schema is
    /// `additionalProperties: false` and `circuitBreaker.reason` is this pack's
    /// existing home for "a channel that could not complete" (the precedent defect 1
    /// uses for the late count).
    /// REVERSE: 去掉 act 里 `probe-events-evicted` 那段 `reasons.append` → 第二条红；
    /// 去掉 `eventsEvictedDuringWindow` 的接线（永远读不到数）→ 同样红。
    func testActOverARingOverflowSaysTheHandlerCountIsATruncatedMeasurement() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1"]))
        // A probe that streams its handlers: it answers `op_end` by reporting more
        // events than the daemon's ring holds — the shape that silently truncated
        // `hitCount` while the loss itself had no counter at all.
        inbox.sender = { pid, data in
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if object?["t"] as? String == "op_end" {
                for index in 0..<(ProbeInbox.eventRingCapacity + 60) {
                    inbox.ingest(pid: pid, frame: .handler(file: "Busy.swift", line: index, ts: 0, durationNs: nil))
                }
            }
            return true
        }
        let (core, store) = try makeCore(time: time, inbox: inbox, label: "gp-act-evicted")
        let operationId = try act(core)
        let pack = try core.lastEvidence(operationId: operationId)
        XCTAssertEqual(inbox.eventsEvictedDuringWindow(opId: operationId), 60)
        XCTAssertTrue(
            pack.circuitBreaker.reason?.contains(Self.evictedLabel) == true,
            "档案里的 hitCount 是下界，这个事实必须随档案走：\(pack.circuitBreaker.reason ?? "nil")"
        )
        XCTAssertEqual(pack.circuitBreaker.level, .degraded)
        XCTAssertEqual(pack.signals.handlerProbe?.hitCount, ProbeInbox.eventRingCapacity)
        // The number reaches an agent, not only the pack: per-pid on the live row and
        // process-wide on `probe_status`, mirroring `stateFramesUnmappedSource` /
        // `unmapableStateFrames`.
        let status = core.probeStatus()
        let rows = try XCTUnwrap(status["probes"] as? [[String: Any]])
        XCTAssertEqual(rows.first?["ringEvictedEvents"] as? Int, 60)
        XCTAssertEqual(status["ringEvictedEventsTotal"] as? Int, 60)
        XCTAssertTrue(
            try XCTUnwrap(store.read(operationId: operationId)).circuitBreaker.reason?
                .contains(Self.evictedLabel) == true,
            "落盘的那份也要带着这句话"
        )
    }

    /// Defect 1(d) and defect 3 share one string, so the strip must be segment-scoped
    /// in the real flow: the eviction sentence outlives a late-count refusal that a
    /// later diagnose took back.
    /// REVERSE: 让 `removingLateArrivalsBasis` 清空整个 reason（而不是只删自己那段）→
    /// 第二条红。
    func testEvictionSentenceSurvivesTheLateCountRefresh() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1"]))
        inbox.sender = { pid, data in
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if object?["t"] as? String == "op_end" {
                for index in 0..<(ProbeInbox.eventRingCapacity + 12) {
                    inbox.ingest(pid: pid, frame: .handler(file: "Busy.swift", line: index, ts: 0, durationNs: nil))
                }
            }
            return true
        }
        let (core, _) = try makeCore(time: time, inbox: inbox, label: "gp-evict-plus-late")
        let operationId = try act(core)

        time.now = time.now.addingTimeInterval(0.3)
        _ = try core.diagnose(operationId: operationId)
        var reason = try XCTUnwrap(core.lastEvidence(operationId: operationId).circuitBreaker.reason)
        XCTAssertTrue(reason.contains(Self.evictedLabel), reason)
        XCTAssertTrue(reason.contains(Self.unmeasuredLabel), reason)

        time.now = time.now.addingTimeInterval(ProbeInbox.lateGraceSeconds)
        _ = try core.diagnose(operationId: operationId)
        reason = try XCTUnwrap(core.lastEvidence(operationId: operationId).circuitBreaker.reason)
        XCTAssertFalse(reason.contains(Self.unmeasuredLabel), "计数已经定下来了：\(reason)")
        XCTAssertTrue(
            reason.contains(Self.evictedLabel),
            "别人的通道没测完，不是这一句该管的：\(reason)"
        )
        XCTAssertEqual(
            reason.components(separatedBy: Self.unmeasuredLabel).count, 1,
            "重复诊断不许把拒绝叠成两遍：\(reason)"
        )
    }
}
