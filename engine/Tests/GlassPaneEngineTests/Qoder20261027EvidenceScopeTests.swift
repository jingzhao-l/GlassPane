import XCTest
import Foundation
@testable import GlassPaneEngine

/// 2026-10-27 每日审查落进 Swift 的四条判据（A1、A2、A4、A5）加一条回音（A3）。
///
/// 这一族共同的主题是证据诚实性：一个数要么是量出来的，要么就自带「没量出来」的说明；
/// 而「量的是哪个对象」属于这个数的一部分。
///
///  · A1 快照基线不带被测身份 —— `attach(A) → snapshot() → attach(B) → restore(id)`
///    拿 B 的当前树去比 A 的基线，还回 `consistent: true`（两棵树恰好摘要相同时真会成立）。
///    `attach` 早就在切应用时清了 `history` 与降级窗口（§18.3），归档包也早有
///    `archivedUnderApp`（Defect 6），只有快照这一张脸没扫到 —— 半修。
///  · A2 `endWindow` 在宽限期还开着的时候写 `lateCount: 0`，自己的注释都说不是最终答案，
///    而那句撤回的话只有 `diagnose` 会写。一份没人 diagnose 过的包于是被
///    `gp_last_evidence`、面板证据页、HTML 报告、mcp-shell 的 evidence-report 各自读成
///    「没有迟到事件」。
///  · A3 `diagnose` 的回包只有 `class` 与 `report`，不答它判的是哪一个操作；而不归档的
///    失败（act 抛 `GP_E_AX_UNAVAILABLE`）使「最新那一份」是上一次的动作。
///    被调查过、**没有**跟着改的另一半：没关的窗口对任何读者都不可见
///    （`eventsEvictedDuringWindow` 只回 `eventsEvicted`，`statusJSON` 根本不读窗口），
///    补 `defer` 只是加一条测不到的分支 —— 按本仓的规矩那叫修在跑不到的路径上。
///  · A4 `latencyMs`/`pingMs` 用挂钟算，NTP/睡眠回拨会算出负数，而冻结 schema 写着
///    `minimum: 0`（axEvent L109-112、responsiveness L152-159）。旧代码只在 ping 超时
///    那一档 `max(0, …)`；`ArchiveFieldBounds` 给长度定的「在字节产生的地方收口」从没管过时长。
///  · A6 迟到计数的宽限期只数了"到点还在环里的那些"：`eventsEvicted` 是**关闭时**的差值，
///    `(t1, t1+2s]` 那一段里 daemon 自己丢掉的事件没人看着。于是 bursts 把最早的迟到事件
///    挤出环之后 `late` 读回来偏低，而一旦它恰好等于存着的 `lateCount`，
///    `refreshLateCount` 就答 `.confirmed` = "这个数是终态"，EngineCore 随之**撤掉**那句
///    "没量过"——用一条没人测量过的尾巴认证了一次"没有迟到"。
///  · A7c `EvidenceStore.stats()` 里 `if let size = try? …` 把问不出尺寸的档案静默丢掉，
///    总数少一截而 `listFailure` 还是 nil —— R6-08 反对的正是"把读不懂的归档报成空的"，
///    这是同一句话的另一半：把只数了一半的字节报成一个实测的总量。
///  · A5 `PixelDiffSignal` 有自定义 encoder（nil 写成显式 null），却用合成的 decoder ——
///    于是**缺席**的 `bounds` 被读成 `nil`，而本文件把 nil 定义成「量过：一个像素都没变」；
///    `diagnose → replace → persist` 还会把这份缺键的包重写成 `"bounds": null`。
///    修法不是拒读：冻结 schema 里 `bounds` 是 `oneOf [object, null]`，**没有**"缺席"这一格，
///    而 `EvidenceStore` 是审计面 —— 因为代码变进而让老档案读不出，正是本仓反复拒绝的
///    "cannot prove ⇒ refuse"。改成：读得出、认得出（`boundsWasAbsentInArchive`），
///    并在读回来的那一刻把来历写进 `circuitBreaker.reason`（与 `late-arrivals-unmeasured`
///    同一个归宿、同一条理由）。
///
/// 另两条同轮落地的判据在 `Qoder20261027StatsRecoveryTests.swift`（面板那张统计卡的
/// "下一步"按钮，E1）与本文件的 `testDiagnoseEchoes…`（A3）。
///
/// REVERSE（每条都在本机实测过红）：
///  · 删掉 `scopedSnapshot` 里的身份比对 ⇒ 第 1 条与第 3 条红；
///  · 删掉 act 期写 basis 那一步 ⇒ 第 4 条红；
///  · 把 `clampElapsedMs` 退回原样返回 ⇒ 第 6/7 条红；
///  · 把 `PixelDiffSignal.init(from:)` 里的 `!container.contains(.bounds)` 认源改成 `false`
///    ⇒ 第 12/13 条红（缺键的档案又没人知道它是缺键的，`markingMissingBoundsProvenance` 就永不说话）；
///  · 把 `EvidenceStore.read` 末尾那句 `markingMissingBoundsProvenance()` 删掉 ⇒ 第 13 条红；
///  · 把写侧的 `encodeNil(forKey: .bounds)` 改回省略键 ⇒ 第 12 条与 ok-05 那条红。
final class Qoder20261027EvidenceScopeTests: XCTestCase {

    private static let clockStart = Date(timeIntervalSince1970: 1_761_600_000)

    private final class TimeBox {
        var now = Qoder20261027EvidenceScopeTests.clockStart
    }

    private func hello(pid: Int32 = 4242, capabilities: [String] = ["z1", "z2"]) -> ProbeHello {
        ProbeHello(
            pid: pid, bundleId: "com.example.app", appName: "Example",
            probeVersion: "gp-probe/0.1.0", capabilities: capabilities
        )
    }

    private func makeCore(
        time: TimeBox,
        inbox: ProbeInbox? = nil,
        label: String
    ) throws -> (core: EngineCore, channel: ScriptedChannel, store: EvidenceStore) {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        let store = TestSandbox.evidenceStore(at: TestSandbox.directory(label))
        let core = EngineCore(
            channel: channel, clock: { time.now }, settle: {},
            evidenceStore: store, probeInbox: inbox
        )
        return (core, channel, store)
    }

    private func actOn(_ core: EngineCore, title: String = "Submit") throws -> String {
        let result = try core.act(selector: Selector(role: "AXButton", title: title), action: .press)
        return try XCTUnwrap(result["operationId"] as? String)
    }

    // MARK: - A1: 基线属于哪一个应用

    func testSnapshotBaselineFromAnotherAppIsRefusedInsteadOfCompared() throws {
        let time = TimeBox()
        let (core, channel, _) = try makeCore(time: time, label: "gp-a1-cross-app")
        channel.app = AttachedApp(pid: 4242, bundleId: "com.example.first", appName: "First")
        _ = try core.attach(bundleId: "com.example.first", pid: 4242)
        let snapshotId = try XCTUnwrap(try core.snapshot(maxDepth: 6)["snapshotId"] as? String)

        // 换到另一个应用：`ScriptedChannel.app` 就是被 attach 的那个进程，树的内容照旧 ——
        // 正因为两棵树相同，旧代码那句 `consistent` 才是货真价实的假绿灯。
        channel.app = AttachedApp(pid: 9001, bundleId: "com.example.second", appName: "Second")
        _ = try core.attach(bundleId: "com.example.second", pid: 9001)

        let treesBefore = channel.treeCallCount
        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: nil, mode: nil)) { error in
            let gp = error as! GPError
            XCTAssertEqual(gp.code, .restoreUnsupported, "跨应用比对不是「不知道这个快照」：它知道，只是那份基线不属于这次挂载")
            XCTAssertTrue(gp.message.contains("com.example.first"), gp.message)
            XCTAssertTrue(gp.message.contains("Second"), gp.message)
            XCTAssertTrue(gp.message.contains("measures nothing"), gp.message)
            XCTAssertFalse(gp.remedy.isEmpty, "拒绝要给人做得动的下一步")
        }
        XCTAssertEqual(
            channel.treeCallCount, treesBefore,
            "拒绝必须发生在任何一次树读取之前：比了再说等于已经拿别人的基线答过一次话"
        )
    }

    func testRestoreForTheSameAppStillComparesAndAnswers() throws {
        // 上一条的控制：身份闸不许把合法的同一应用回滚一起拒掉，否则它就是条恒拒。
        let time = TimeBox()
        let (core, _, _) = try makeCore(time: time, label: "gp-a1-same-app")
        _ = try core.attach(bundleId: "com.example.app", pid: 4242)
        let snapshotId = try XCTUnwrap(try core.snapshot(maxDepth: 6)["snapshotId"] as? String)
        let result = try core.restore(snapshotId: snapshotId, steps: nil, mode: nil)
        XCTAssertEqual(result["consistent"] as? Bool, true)
        XCTAssertNotNil(result["baselineTreeDigest"])
        XCTAssertNotNil(result["targetDigest"])
    }

    func testRollbackFullFaceRefusesTheSameCrossAppBaseline() throws {
        // 半修的定义就是改了一张脸。tier-1 那一支读同一张快照表，必须走同一条闸。
        let time = TimeBox()
        let (core, channel, _) = try makeCore(time: time, label: "gp-a1-rollback-full")
        channel.app = AttachedApp(pid: 4242, bundleId: "com.example.first", appName: "First")
        _ = try core.attach(bundleId: "com.example.first", pid: 4242)
        let snapshotId = try XCTUnwrap(try core.snapshot(maxDepth: 6)["snapshotId"] as? String)
        channel.app = AttachedApp(pid: 9001, bundleId: "com.example.second", appName: "Second")
        _ = try core.attach(bundleId: "com.example.second", pid: 9001)
        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")) { error in
            let gp = error as! GPError
            XCTAssertEqual(gp.code, .restoreUnsupported, "同一份判据、两张脸：\(gp.code.rawValue)")
            XCTAssertTrue(gp.message.contains("com.example.first"), gp.message)
        }
    }

    func testSnapshotCarriesTheAttachmentItWasTakenUnder() throws {
        // 那条判据的数据来源要能被间接问到：换回原应用时它必须还能用（证明字段真装了东西，
        // 而不是恒拒——恒拒的闸与本仓反对的"没闸"是同一枚硬币的两面）。
        let time = TimeBox()
        let (core, channel, _) = try makeCore(time: time, label: "gp-a1-field")
        channel.app = AttachedApp(pid: 4242, bundleId: "com.example.first", appName: "First")
        _ = try core.attach(bundleId: "com.example.first", pid: 4242)
        let snapshotId = try XCTUnwrap(try core.snapshot(maxDepth: 6)["snapshotId"] as? String)
        channel.app = AttachedApp(pid: 9001, bundleId: "com.example.second", appName: "Second")
        _ = try core.attach(bundleId: "com.example.second", pid: 9001)
        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: nil, mode: nil))
        channel.app = AttachedApp(pid: 4242, bundleId: "com.example.first", appName: "First")
        _ = try core.attach(bundleId: "com.example.first", pid: 4242)
        let back = try core.restore(snapshotId: snapshotId, steps: nil, mode: nil)
        XCTAssertEqual(back["snapshotId"] as? String, snapshotId, "回到那个应用之后同一份基线照旧可用——闸只挡跨应用")
    }

    // MARK: - A3: diagnose 要答得出它判的是哪一个操作

    func testDiagnoseEchoesTheOperationIdItClassified() throws {
        let time = TimeBox()
        let (core, _, store) = try makeCore(time: time, label: "gp-a3-echo")
        _ = try core.attach(bundleId: "com.example.app", pid: 4242)
        let first = try actOn(core, title: "Submit")
        time.now = time.now.addingTimeInterval(1)
        let second = try actOn(core, title: "Cancel")
        XCTAssertNotEqual(first, second)

        let unnamed = try core.diagnose(operationId: nil)
        XCTAssertEqual(
            unnamed["operationId"] as? String, second,
            "不带 id 的 diagnose 判的是最新那一份；不把那个 id 交出去，调用方无从知道自己被告知的是哪一次动作"
        )
        let named = try core.diagnose(operationId: first)
        XCTAssertEqual(named["operationId"] as? String, first)
        XCTAssertNotNil(store.read(operationId: second))
    }

    // MARK: - A2: 没量完的迟到计数从落盘那一刻起就要自带说明

    func testArchivedLateCountCarriesTheUnmeasuredMarkWithoutAnyDiagnose() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.sender = { _, _ in true }
        inbox.register(hello())
        let (core, _, store) = try makeCore(time: time, inbox: inbox, label: "gp-a2-at-birth")
        _ = try core.attach(bundleId: "com.example.app", pid: 4242)
        let opId = try actOn(core)

        let pack = try XCTUnwrap(store.read(operationId: opId), "面板与 gp_last_evidence 读的是落盘那一份")
        XCTAssertEqual(pack.signals.handlerProbe?.lateCount, 0)
        XCTAssertTrue(
            pack.circuitBreaker.reason?.contains(EngineCore.lateArrivalsUnmeasuredLabel) == true,
            "REVERSE: 一个没量完的 0 又安静地落盘了 —— \(pack.circuitBreaker.reason ?? "nil")"
        )
        XCTAssertTrue(
            pack.circuitBreaker.reason?.contains("YET") == true,
            "要说清 0 的含义是「还没到」，不是「没迟到」：\(pack.circuitBreaker.reason ?? "nil")"
        )
    }

    func testDiagnoseAfterTheGraceStillSettlesTheMarkItWasBornWith() throws {
        // 控制：出生时就写的那句不许变成永久拒绝 —— 宽限期走完、数落定之后要撤掉。
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.sender = { _, _ in true }
        inbox.register(hello())
        let (core, _, store) = try makeCore(time: time, inbox: inbox, label: "gp-a2-settled")
        _ = try core.attach(bundleId: "com.example.app", pid: 4242)
        let opId = try actOn(core)
        let born = try XCTUnwrap(store.read(operationId: opId))
        XCTAssertTrue(born.circuitBreaker.reason?.contains(EngineCore.lateArrivalsUnmeasuredLabel) == true)

        time.now = time.now.addingTimeInterval(ProbeInbox.lateGraceSeconds + 0.5)
        _ = try core.diagnose(operationId: opId)
        let settled = try XCTUnwrap(store.read(operationId: opId))
        XCTAssertNotNil(settled.signals.handlerProbe)
        XCTAssertNil(
            settled.circuitBreaker.reason.flatMap { $0.contains(EngineCore.lateArrivalsUnmeasuredLabel) ? $0 : nil },
            "数落定了，那句「还没量」就成了假话"
        )
    }

    // MARK: - A4: 挂钟回拨不许留下负数，也不许把 0 冒成测量

    func testWallClockStepBackArchivesTheFloorAndSaysSo() throws {
        // 递减的钟：`started` 是第一读，之后的每一读都比它早，于是时长算出来是负的 ——
        // 这就是 NTP 校时或睡眠回拨落在一次 act 中间时发生的事。
        var ticks = 0
        let start = Qoder20261027EvidenceScopeTests.clockStart
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        let dir = TestSandbox.directory("gp-a4-step")
        let store = TestSandbox.evidenceStore(at: dir)
        let core = EngineCore(
            channel: channel,
            clock: {
                ticks += 1
                return start.addingTimeInterval(-Double(ticks))
            },
            settle: {}, evidenceStore: store, probeInbox: nil
        )
        _ = try core.attach(bundleId: "com.example.app", pid: 4242)
        let opId = try actOn(core)
        let pack = try XCTUnwrap(store.read(operationId: opId))
        XCTAssertEqual(pack.signals.axEvent?.latencyMs ?? 0, 0, "schema 写的是 minimum: 0，负数不许落盘")
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.contains(EngineCore.clockStepUnmeasuredLabel), reason)
        XCTAssertTrue(reason.contains("axEvent.latencyMs"), "要点名是哪一路被收口：\(reason)")
    }

    func testNegativePingFromTheChannelIsClampedAndNamed() throws {
        let time = TimeBox()
        let (core, channel, store) = try makeCore(time: time, label: "gp-a4-ping")
        channel.pingResult = .success(-5)
        _ = try core.attach(bundleId: "com.example.app", pid: 4242)
        let opId = try actOn(core)
        let pack = try XCTUnwrap(store.read(operationId: opId))
        XCTAssertEqual(try XCTUnwrap(pack.signals.responsiveness).pingMs, 0, "pingMs 的 schema 下限是 0")
        XCTAssertTrue(try XCTUnwrap(pack.signals.responsiveness).responsive, "只收数值，不改判")
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.contains(EngineCore.clockStepUnmeasuredLabel), reason)
        XCTAssertTrue(reason.contains("responsiveness.pingMs"), "要点名是哪一路被收口：\(reason)")
        XCTAssertFalse(reason.contains("axEvent.latencyMs"), "这一趟挂钟没回拨，不许顺带点名另一路：\(reason)")
    }

    func testClampHelperCoversNonFiniteAndLeavesCleanValuesAlone() {
        XCTAssertEqual(EngineCore.clampElapsedMs(-0.1).ms, 0)
        XCTAssertEqual(EngineCore.clampElapsedMs(-0.1).clamped, true)
        XCTAssertEqual(EngineCore.clampElapsedMs(0).clamped, false)
        XCTAssertEqual(EngineCore.clampElapsedMs(12.5).ms, 12.5)
        XCTAssertEqual(EngineCore.clampElapsedMs(12.5).clamped, false)
        XCTAssertEqual(EngineCore.clampElapsedMs(.nan).clamped, true)
        XCTAssertEqual(EngineCore.clampElapsedMs(.infinity).clamped, true)
        // basis 只许一条：diagnose 会在同一份包上跑第二遍。
        let once = EngineCore.appendingClockStepBasis(nil, channels: ["responsiveness.pingMs"])
        let twice = EngineCore.appendingClockStepBasis(once, channels: ["axEvent.latencyMs"])
        XCTAssertEqual(once, twice, "同一件事的第二种说法不该再叠一遍")
        XCTAssertEqual(EngineCore.appendingClockStepBasis("other", channels: []), "other",
            "没有通道被收口时不许动别人的句子")
    }

    // MARK: - A5: 缺席的 bounds 要留下出处，但不许把老档案读成没有

    func testAbsentBoundsKeyDecodesAndIsFlaggedWhileExplicitNullIsNot() throws {
        let decoder = JSONDecoder()
        let withNull = #"{"changedPixelRatio":0,"bounds":null,"windowId":12}"#
        let nullSignal = try decoder.decode(PixelDiffSignal.self, from: Data(withNull.utf8))
        XCTAssertNil(nullSignal.bounds)
        XCTAssertFalse(
            nullSignal.boundsWasAbsentInArchive,
            "显式 null 就是 P0 §4.2 那一次「一个像素都没变」的测量，不许被打上出处标记"
        )

        let absent = #"{"changedPixelRatio":0,"windowId":12}"#
        let legacy = try decoder.decode(PixelDiffSignal.self, from: Data(absent.utf8))
        XCTAssertTrue(legacy.boundsWasAbsentInArchive, "缺键的老档案必须被认出来，否则它下一次落盘就成了 null 那句结论")

        let text = String(
            decoding: try JSONEncoder().encode(PixelDiffSignal(changedPixelRatio: 0, bounds: nil, windowId: 12)),
            as: UTF8.self
        )
        XCTAssertTrue(text.contains(#""bounds":null"#), "写侧那条规矩不许被读侧改动带跑：\(text)")

        // 出处是读时注解，不是第三个测量值：同一份测量的两种来历必须仍然相等，
        // 否则每一条比较 `pixelDiff` 的既有用例都会因这次改动假红。
        XCTAssertEqual(legacy, nullSignal, "相等判据只看三个测量字段；把出处塞进去等于改写别人的断言")
    }

    func testMarkingMissingBoundsProvenanceStacksTheSentenceOnce() throws {
        let time = TimeBox()
        let (core, _, store) = try makeCore(time: time, label: "gp-a5-pack")
        _ = try core.attach(bundleId: "com.example.app", pid: 4242)
        let opId = try actOn(core)
        let pack = try XCTUnwrap(store.read(operationId: opId))
        let data = try XCTUnwrap(pack.jsonData())
        XCTAssertNoThrow(try EvidencePack.decodeAndValidate(data), "前提：这一批字节的真包读得动")
        let json = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(json.contains(#""bounds""#), json)

        // 从真包字节出发，抠掉那一个键 —— 唯一变量就是这一个键的缺席。
        let mutated = json.replacingOccurrences(of: #""bounds":null,"#, with: "")
        XCTAssertNotEqual(mutated, json, "REVERSE 夹具：没把那个键抠掉，这条控制就是空的")
        let legacy = try EvidencePack.decodeAndValidate(Data(mutated.utf8))
        XCTAssertEqual(legacy.signals.pixelDiff?.boundsWasAbsentInArchive, true)

        let marked = legacy.markingMissingBoundsProvenance()
        let reason = try XCTUnwrap(marked.circuitBreaker.reason)
        XCTAssertTrue(reason.contains(EvidencePack.pixelDiffBoundsNotArchivedLabel), reason)
        XCTAssertTrue(reason.contains("inherited blank"), reason)
        XCTAssertEqual(
            marked.markingMissingBoundsProvenance().circuitBreaker.reason, reason,
            "同一份包被读第二遍（diagnose 会跑两次）不许叠出第二句"
        )
        // 干净的一份包不许被这条闸碰到：那条句子是别人（性能/污染/迟到）的账。
        XCTAssertEqual(
            pack.markingMissingBoundsProvenance().circuitBreaker.reason,
            pack.circuitBreaker.reason,
            "写侧带键的包不该多出这句话"
        )
    }

    func testStoreReadsAPreFixArchiveAndNamesTheBlank() throws {
        // 端到端那一层：老档案**照旧读得出**（`EvidenceStore` 是审计面，不因代码变进而收窄），
        // 但交回来的那一份必须自带「这个 null 是继承来的空白」那句话 —— 否则
        // `diagnose → replace → persist` 下一次落盘时，缺席就被铸成了「量过：没变」。
        let time = TimeBox()
        let (core, _, store) = try makeCore(time: time, label: "gp-a5-store")
        _ = try core.attach(bundleId: "com.example.app", pid: 4242)
        let opId = try actOn(core)
        let pack = try XCTUnwrap(store.read(operationId: opId))
        XCTAssertNotNil(store.lastOnDisk(), "前提：包真的落盘了")

        let dir = TestSandbox.directory("gp-a5-store-copy")
        let copy = TestSandbox.evidenceStore(at: dir)
        let json = String(decoding: try XCTUnwrap(pack.jsonData()), as: UTF8.self)
        let mutated = json.replacingOccurrences(of: #""bounds":null,"#, with: "")
        XCTAssertNotEqual(mutated, json, "夹具没改成就没有可测的东西")
        let written = URL(fileURLWithPath: dir).appendingPathComponent("\(opId).json")
        try Data(mutated.utf8).write(to: written, options: .atomic)

        let readBack = try XCTUnwrap(copy.read(operationId: opId), "REVERSE: 老档案读不出了 —— 审计面被代码变进收窄")
        XCTAssertNil(readBack.signals.pixelDiff?.bounds)
        XCTAssertTrue(
            readBack.circuitBreaker.reason?.contains(EvidencePack.pixelDiffBoundsNotArchivedLabel) == true,
            "读得出却没说出这一格的来历，就等于把它当成测量交出去：\(readBack.circuitBreaker.reason ?? "nil")"
        )
        // 同一份新写的档案不该带上这句话。
        XCTAssertFalse(
            pack.circuitBreaker.reason?.contains(EvidencePack.pixelDiffBoundsNotArchivedLabel) ?? false,
            pack.circuitBreaker.reason ?? "nil"
        )
    }

    // MARK: - A7c: 数不出尺寸的档案不许被折进一个"看着像测量"的总数

    func testStatsRefusesToCertifyATotalWhenAnEntryWouldNotReportASize() throws {
        let time = TimeBox()
        let (core, _, store) = try makeCore(time: time, label: "gp-a7c-stats")
        _ = try core.attach(bundleId: "com.example.app", pid: 4242)
        _ = try actOn(core, title: "Submit")
        _ = try actOn(core, title: "Cancel")

        // 控制：两条真档案、真读尺寸 —— 这条路必须给出完整的数字。
        let clean = store.stats()
        XCTAssertEqual(clean.count, 2)
        XCTAssertNil(clean.listFailure, clean.listFailure ?? "nil")
        XCTAssertGreaterThan(clean.totalBytes, 0, "两条真包不可能合出 0 字节")

        // 缺陷那一支：其中一条问不出尺寸。旧写法 `if let size = try? …` 把它静默丢了，
        // 总数少一截而 `listFailure` 还是 nil —— 调用方于是把"部分加出来的数"
        // 当成整个档案的实测总量（R6-08 反对的正是这件事）。
        var answers = 0
        let knownBytes = clean.totalBytes
        let partial = store.stats(sizeOf: { _ in
            answers += 1
            return answers == 1 ? nil : knownBytes
        })
        XCTAssertEqual(answers, 2, "夹具必须真的问过两条档案的尺寸，否则下面那些断言是空的")
        let failure = try XCTUnwrap(
            partial.listFailure,
            "一条量不出尺寸时不许交出一个更小的总数——那一趟没量到，就得说没量到"
        )
        XCTAssertTrue(failure.contains("1 of 2"), failure)
        XCTAssertTrue(failure.contains("not obtained"), failure)
        XCTAssertEqual(partial.totalBytes, 0, "未测得的合计在 --evidence-stats 那一侧是 null，不是半截数")
        XCTAssertEqual(partial.count, 2, "列目录这一趟是真成功的，条数这个事实不许被牵连")
    }

    // MARK: - A6: 宽限期里的环丢失不许被认证成"没有迟到"

    /// 一份带 handlerProbe 的包，形状就是 act 落盘时那一种（迟到计数取自 `endWindow`）。
    private func packWith(
        opId: String,
        signals: (handlerProbe: HandlerProbeSignal?, stateDiff: StateDiffSignal?)
    ) -> EvidencePack {
        let base = TestTrees.standard
        return EvidencePack(
            operationId: opId,
            createdAt: "2026-10-27T00:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal, reason: nil),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: "Submit"), action: .press, actConfirmed: true
                ),
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

    func testGraceWindowRingLossIsNotCertifiedAsAnAnswer() throws {
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello())
        inbox.beginWindow(pid: 4242, opId: "op_a6_grace_evict")
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_a6_grace_evict"))
        let target = packWith(opId: "op_a6_grace_evict", signals: signals)
        XCTAssertEqual(signals.handlerProbe?.lateCount, 0)

        // 宽限期内把这枚环灌爆：daemon 自己扔掉的那些事件，正是这一格该数却已经看不见的。
        for index in 0..<(ProbeInbox.eventRingCapacity + 7) {
            inbox.ingest(pid: 4242, frame: .handler(file: "Late\(index).swift", line: index, ts: 0, durationNs: nil))
        }
        time.now = time.now.addingTimeInterval(ProbeInbox.lateGraceSeconds + 0.5)

        guard case let .unmeasurable(reason) = inbox.refreshLateCount(for: target) else {
            return XCTFail("宽限期内丢过事件的环不许回答 .confirmed/.measured —— 那是一次认证")
        }
        XCTAssertTrue(reason.contains("lower bound"), reason)
        XCTAssertTrue(reason.contains("dropped 7"), "要把丢了几个说出来：\(reason)")
        XCTAssertNil(inbox.lateCount(opId: "op_a6_grace_evict"), "量不出就是量不出，不是 0")

        // 三种成因不许共用一句话：这一条既不是"宽限期还没走完"，也不是"窗口出环"。
        XCTAssertFalse(reason.contains("still open"), reason)
        XCTAssertFalse(reason.contains("no longer in the probe inbox"), reason)
    }

    func testGraceWindowWithoutRingLossStillReachesTheHonestVerdicts() throws {
        // 控制：这条闸不许变成恒拒。环没溢出时，宽限期走完就该给出能用的答案。
        let time = TimeBox()
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello())
        inbox.beginWindow(pid: 4242, opId: "op_a6_clean")
        let signals = try XCTUnwrap(inbox.endWindow(pid: 4242, opId: "op_a6_clean"))
        let target = packWith(opId: "op_a6_clean", signals: signals)
        time.now = time.now.addingTimeInterval(ProbeInbox.lateGraceSeconds + 0.5)
        switch inbox.refreshLateCount(for: target) {
        case .confirmed, .measured:
            break
        case let .unmeasurable(reason):
            return XCTFail("没有丢失的一格又不该被拒绝：\(reason)")
        case .notCarried:
            return XCTFail("这份包带着 handlerProbe")
        }
        XCTAssertEqual(inbox.lateCount(opId: "op_a6_clean"), 0, "环没溢出时，量完的 0 就是一次测量")
    }
}
