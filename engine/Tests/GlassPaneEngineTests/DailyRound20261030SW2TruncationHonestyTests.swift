import XCTest
@testable import GlassPaneEngine

/// 每日轮 2026-10-30 · SW2 缺陷 1（P1）：归档侧的**静默截断**。
///
/// 形状与 2026-10-22 那一轮修的环溢出是同一族，但发生在更里一层：
/// `HandlerProbeSignal.init`（`EvidenceModels.swift:314`）与 `StateDiffSignal.init`
/// （`:352`）把窗口里的清单各自截到 32 / 64 条，**截掉的那几条没有任何一处说出来**。
/// 证据 schema 是 `additionalProperties: false` 且数组带 `maxItems`（见
/// `kernel/schemas/evidence-pack.schema.json` 的 `handlerProbeSignal.handlers` /
/// `stateDiffSignal.entries`），所以这份实话没有新键可装——它只能走
/// `circuitBreaker.reason`，也就是 `probe-events-evicted`（`EngineCore.swift:1268-1283`）
/// 已经在用的那个家。生产端与文案端各错一半：
///   1. 生产端：40 条不同 handler 进、32 条归档，档案读起来就是"一共 32 条"。
///   2. 文案端：`EvidenceReportGenerator.handlerProbeText` 算的
///      `hidden = handlerProbe.handlers.count - refs.count`，于是 40 进 32 归档时报告
///      写下 `+24 more`——那是一个**漏掉了 8 条**的数字（不是少说一个数，是说了一个
///      假数：8 shown + 24 more = 32 被当作全体）。
///
/// 三条守卫一起写：截断必须具名、`+N more` 必须能读出它是"归档里还剩几条没念"、
/// 而 ≤cap 的窗口必须**什么都不多说**（一个到处 firing 的守卫等于没有守卫）。
///
/// `REVERSE:` 写明退回哪一处修复会让对应那条变红。
final class DailyRound20261030SW2TruncationHonestyTests: XCTestCase {

    private static let clockStart = Date(timeIntervalSince1970: 1_762_700_000)

    /// 标签按字面量写死：这两句是档案读者要匹配的字符串，生产者改写时这里必须断。
    private static let handlerTruncationLabel = "handler-list-truncated"
    private static let stateTruncationLabel = "state-entries-truncated"

    private final class TimeBox {
        var now = DailyRound20261030SW2TruncationHonestyTests.clockStart
    }

    private func hello(pid: Int32 = 4242, capabilities: [String] = ["z1", "z3"]) -> ProbeHello {
        ProbeHello(
            pid: pid, bundleId: "com.example.app", appName: "Example",
            probeVersion: "gp-probe/0.1.0", capabilities: capabilities
        )
    }

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

    /// A probe that streams `count` distinct handler sites while the window is open.
    /// The `op_end` hook is the shape a real probe has: it answers the close command
    /// by flushing what it measured.
    private func streamingInbox(
        time: TimeBox, handlers: Int, stateKeys: Int = 0, capabilities: [String] = ["z1", "z3"]
    ) -> ProbeInbox {
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: capabilities))
        inbox.sender = { pid, data in
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if object?["t"] as? String == "op_end" {
                for index in 0..<handlers {
                    inbox.ingest(pid: pid, frame: .handler(file: "H\(index).swift", line: index, ts: 0, durationNs: nil))
                }
                for index in 0..<stateKeys {
                    inbox.ingest(pid: pid, frame: .state(
                        key: "k\(index)", before: "0", after: "1", source: StateDiffSource.z3KVC.rawValue, ts: 0
                    ))
                }
            }
            return true
        }
        return inbox
    }

    private func pack(signals: (handlerProbe: HandlerProbeSignal?, stateDiff: StateDiffSignal?)) -> EvidencePack {
        let base = TestTrees.standard
        return EvidencePack(
            operationId: "op_render",
            createdAt: "2026-10-30T00:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal, reason: nil),
            signals: Signals(
                act: ActSignal(selector: Selector(role: "AXButton", title: "Submit"), action: .press, actConfirmed: true),
                handlerProbe: signals.handlerProbe,
                stateDiff: signals.stateDiff
            )
        )
    }

    private func handlerRefs(_ count: Int) -> [HandlerRef] {
        (0..<count).map { HandlerRef(file: "H\($0).swift", line: $0) }
    }

    private func stateEntries(_ count: Int) -> [StateEntry] {
        (0..<count).map { StateEntry(key: "k\($0)", before: "0", after: "1") }
    }

    private func handlerProbeLine(_ signal: HandlerProbeSignal) throws -> String {
        let lines = EvidenceReportGenerator.evidenceSummaryLines(pack: pack(signals: (signal, nil)))
        return try XCTUnwrap(lines.first { $0.hasPrefix("handlerProbe:") })
    }

    private func stateDiffLine(_ signal: StateDiffSignal) throws -> String {
        let lines = EvidenceReportGenerator.evidenceSummaryLines(pack: pack(signals: (nil, signal)))
        return try XCTUnwrap(lines.first { $0.hasPrefix("stateDiff:") })
    }

    // MARK: - 1. 生产端：pack 层必须具名说出截断

    /// 一次真 act、一个真窗口：40 个不同 handler 站点进来，归档只留 32 个。
    /// REVERSE: 删掉 `act` 里新增的 `handler-list-truncated` 那段 `reasons.append`
    /// → 这一条红（`reason` 回到 nil，因为环没溢出、其余通道全测到了）。
    func testAWindowOf40DistinctHandlersNamesTheArchiveTruncation() throws {
        let time = TimeBox()
        let inbox = streamingInbox(time: time, handlers: 40)
        let (core, store) = try makeCore(time: time, inbox: inbox, label: "sw2-handler-truncated")
        let operationId = try act(core)
        let pack = try core.lastEvidence(operationId: operationId)

        // 前提：这一趟确实被截了，而且**不是**因为环溢出——512 的容量装得下 40 条，
        // 所以这一条测的是纯归档截断，与 `probe-events-evicted` 那句无关。
        XCTAssertEqual(pack.signals.handlerProbe?.handlers.count, HandlerProbeSignal.maxHandlers)
        XCTAssertEqual(inbox.eventsEvictedDuringWindow(opId: operationId), 0)

        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(
            reason.contains(Self.handlerTruncationLabel),
            "40 条进、32 条归档，这件事必须随档案走：\(reason)"
        )
        XCTAssertTrue(
            reason.contains("32 of 40"),
            "截断句要同时给出留下的数与窗口量到的数，只给一个仍是假数：\(reason)"
        )
        XCTAssertEqual(pack.circuitBreaker.level, .degraded)
        // 落盘那一份同样带着：报告与 `gp_export_evidence` 读的是磁盘上的 pack。
        XCTAssertTrue(
            try XCTUnwrap(store.read(operationId: operationId)).circuitBreaker.reason?
                .contains(Self.handlerTruncationLabel) == true,
            "落盘的那份也要带着这句话"
        )
    }

    /// 一个只装下 20 条的窗口不许产生任何截断句——守卫不能到处 firing。
    /// REVERSE: 把判据写成 `>=` 或无条件 append → 这一条红。
    func testAWindowThatFitsTheCapSaysNothingAboutTruncation() throws {
        let time = TimeBox()
        let inbox = streamingInbox(time: time, handlers: 20)
        let (core, _) = try makeCore(time: time, inbox: inbox, label: "sw2-handler-fits")
        let operationId = try act(core)
        let pack = try core.lastEvidence(operationId: operationId)

        XCTAssertEqual(pack.signals.handlerProbe?.handlers.count, 20)
        // 这一趟别的通道确实有话要说（act 时刻的迟到数还不可测），所以 `reason` 非空
        // 是常态——守卫的判据是**不许多这一句**，不是"reason 必须为空"。
        XCTAssertTrue(
            pack.circuitBreaker.reason?.contains(Self.handlerTruncationLabel) == false,
            "什么都没截的时候不能有一句截断声明：\(pack.circuitBreaker.reason ?? "nil")"
        )
        XCTAssertFalse(
            pack.circuitBreaker.reason?.contains(Self.stateTruncationLabel) == true,
            "state 通道同理：\(pack.circuitBreaker.reason ?? "nil")"
        )
        XCTAssertEqual(pack.circuitBreaker.level, .normal)
    }

    /// 64 个以上变更键的同一形状。
    /// REVERSE: 删掉 `state-entries-truncated` 那段 `reasons.append` → 红。
    func testAWindowOf70ChangedKeysNamesTheEntryTruncation() throws {
        let time = TimeBox()
        let inbox = streamingInbox(time: time, handlers: 1, stateKeys: 70)
        let (core, _) = try makeCore(time: time, inbox: inbox, label: "sw2-state-truncated")
        let operationId = try act(core)
        let pack = try core.lastEvidence(operationId: operationId)

        XCTAssertEqual(pack.signals.stateDiff?.entries.count, StateDiffSignal.maxEntries)
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(
            reason.contains(Self.stateTruncationLabel),
            "70 个键变了、档案只留 64 个，只说 changed:true 是把它说成一件小事：\(reason)"
        )
        XCTAssertTrue(reason.contains("64 of 70"), reason)
    }

    /// ≤64 个键的窗口不许有那句声明。
    /// REVERSE: 无条件 append → 红。
    func testAWindowOfTenChangedKeysSaysNothingAboutTruncation() throws {
        let time = TimeBox()
        let inbox = streamingInbox(time: time, handlers: 1, stateKeys: 10)
        let (core, _) = try makeCore(time: time, inbox: inbox, label: "sw2-state-fits")
        let operationId = try act(core)
        let pack = try core.lastEvidence(operationId: operationId)

        XCTAssertEqual(pack.signals.stateDiff?.entries.count, 10)
        XCTAssertTrue(
            pack.circuitBreaker.reason?.contains(Self.stateTruncationLabel) == false,
            "什么都没截的时候不能有一句截断声明：\(pack.circuitBreaker.reason ?? "nil")"
        )
    }

    // MARK: - 2. 文案端：`+N more` 不许被读成"这就是全部"

    /// 40 条量到 / 32 条归档 / 报告念 8 条。整句逐字钉住：`+24 more` 说的是"归档里
    /// 还有 24 条没念"，而"归档总共只有 32 条、窗口量到 40 条"必须写在同一行里。
    /// REVERSE: 删掉文案端新增的截断从句 → 第二、第三条红；把 `+24 more` 改成按窗口
    /// 总数算（`+32 more`）→ 第一条红（那是另一种假数：它宣称念出的 8 条之外还有 32 条
    /// 在这个 pack 里，而档案里只有 32 条）。
    func testReportTextFor40In32ArchivedSpellsBothTotals() throws {
        let signal = HandlerProbeSignal(
            probeVersion: "p", hitCount: 40, handlers: handlerRefs(40), lateCount: 0
        )
        let line = try handlerProbeLine(signal)
        XCTAssertEqual(
            line,
            "handlerProbe: probeVersion=p hitCount=40 late=0 "
                + "handlers=[H0.swift:0, H1.swift:1, H2.swift:2, H3.swift:3, H4.swift:4, H5.swift:5, H6.swift:6, H7.swift:7, +24 more]"
                + " — handlers[] holds 32 of the 40 distinct handlers this window measured, 8 are not in this pack (archive cap 32)"
        )
        // 三个数各自的意义都要在句子里出现，缺一个这句话就还能被读成完整的。
        XCTAssertTrue(line.contains("+24 more"), line)
        XCTAssertTrue(line.contains("32 of the 40"), line)
        XCTAssertTrue(line.contains("8 are not in this pack"), line)
    }

    /// stateDiff 的同一形状（70 键量到 / 64 归档 / 念 8 条）。
    func testStateDiffTextFor70In64ArchivedSpellsBothTotals() throws {
        let signal = StateDiffSignal(source: .z3KVC, changed: true, entries: stateEntries(70))
        let line = try stateDiffLine(signal)
        XCTAssertTrue(line.contains("+56 more"), line)
        XCTAssertTrue(line.contains("64 of the 70 changed keys"), line)
        XCTAssertTrue(line.contains("6 are not in this pack"), line)
    }

    /// 守卫不能到处 firing：32 条以内（念 8 条）与正好 8 条（一个都不藏）两种窗口
    /// 都不许多出截断从句。
    /// REVERSE: 把从句的判据写成 `handlers.count > maxHandlersShown` → 第一条红。
    func testReportTextStaysQuietWhenNothingWasDropped() throws {
        let archivedWhole = HandlerProbeSignal(
            probeVersion: "p", hitCount: 30, handlers: handlerRefs(30), lateCount: 0
        )
        let line = try handlerProbeLine(archivedWhole)
        XCTAssertEqual(
            line,
            "handlerProbe: probeVersion=p hitCount=30 late=0 "
                + "handlers=[H0.swift:0, H1.swift:1, H2.swift:2, H3.swift:3, H4.swift:4, H5.swift:5, H6.swift:6, H7.swift:7, +22 more]"
        )
        let exactlyShown = HandlerProbeSignal(
            probeVersion: "p", hitCount: 8, handlers: handlerRefs(8), lateCount: 0
        )
        let quiet = try handlerProbeLine(exactlyShown)
        XCTAssertFalse(quiet.contains("not in this pack"), quiet)
        XCTAssertFalse(quiet.contains("+0 more"), quiet)

        let fittingState = StateDiffSignal(source: .z1Macro, changed: true, entries: stateEntries(9))
        let stateLine = try stateDiffLine(fittingState)
        XCTAssertTrue(stateLine.contains("+1 more"), stateLine)
        XCTAssertFalse(stateLine.contains("not in this pack"), stateLine)
    }

    /// 从磁盘读回来的 pack 只有 32 条可念：那一句实话此时来自
    /// `circuitBreaker.reason`（持久的那一份），文案不许凭空造一个窗口总数。
    /// 这一条同时钉住编码面：新增的窗口总数是 Swift 侧的来源信息，**不是** schema 的
    /// 第 5 个键——`handlerProbeSignal` 是 strictObject，多写一个键这份档案就被发布侧拒收。
    /// REVERSE: 让新字段参与编码（删掉显式 `encode(to:)`）→ 第二条红。
    func testRoundTrippedPackKeepsTheSentenceInItsReasonAndNotInItsKeys() throws {
        let signal = HandlerProbeSignal(
            probeVersion: "p", hitCount: 40, handlers: handlerRefs(40), lateCount: 0
        )
        var original = pack(signals: (signal, nil))
        original.circuitBreaker.reason = "handler-list-truncated: 32 of 40 distinct handlers kept"
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(original)
        let decoded = try JSONDecoder().decode(EvidencePack.self, from: data)

        XCTAssertEqual(decoded.signals.handlerProbe?.handlers.count, 32)
        XCTAssertEqual(
            decoded.circuitBreaker.reason, original.circuitBreaker.reason,
            "持久的那一句才是读者能复查的来源：它必须随档案走"
        )
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let handlerProbe = try XCTUnwrap(
            ((json?["signals"] as? [String: Any])?["handlerProbe"]) as? [String: Any]
        )
        XCTAssertEqual(
            Set(handlerProbe.keys), ["probeVersion", "hitCount", "handlers", "lateCount"],
            "冻结的 handlerProbeSignal 只认这四个键"
        )
        let stateDiff = StateDiffSignal(source: .z3KVC, changed: true, entries: stateEntries(70))
        let stateObject = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(stateDiff))
        let stateJSON = try XCTUnwrap(stateObject as? [String: Any])
        XCTAssertEqual(
            Set(stateJSON.keys).sorted(), ["changed", "entries", "source"],
            "stateDiffSignal 同样只认这三个键"
        )
    }
}
