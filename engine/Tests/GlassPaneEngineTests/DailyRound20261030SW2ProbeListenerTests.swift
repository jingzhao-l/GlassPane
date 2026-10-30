import XCTest
@testable import GlassPaneEngine

/// 每日轮 2026-10-30 · SW2 缺陷 2（P1）：`probe_status` 把"这一面根本不存在"
/// 发成一个测量结果。
///
/// `EngineCore.swift:1900-1906` 无条件把 `probes` / `attachedHasProbe` 放进载荷。
/// 没有 inbox 的时候（`--no-probe`；`main.swift:1955-1962` 的 A-18 因为 probe.sock
/// 这个名字被别的监听者占着而拒绝起监听；`server.start()` 在 :2046 抛）这两项
/// 逐字节等于"监听者在、但被测 app 没接探针"的回话。于是 agent 被指去
/// "给 app 接上 GlassPaneProbe"，而这一个实例里**没有任何 socket 能接受它**——
/// 一句指向不可达之处的指引。同一段下面的四个兄弟键（`disconnections`、
/// `recentDisconnections`、`unmapableStateFrames`、`ringEvictedEventsTotal`）
/// 在没有 inbox 时是**故意省略**的，:1926-1928 把规矩写得很清楚：
/// "`--no-probe` is the absence of the surface, and a measured zero needs something
/// that measures"。规矩在，只是 `probes`/`attachedHasProbe` 被漏在规矩之外。
///
/// 另一半：`ProtocolErrors.swift:26` 声明 `GP_E_PROBE_UNAVAILABLE`、:122 给它写了
/// remedy，`EngineCore.swift:1898` 宣称 agent 用 `probe_status` 去 surface the
/// GP_E_PROBE_UNAVAILABLE remedy——但 `git grep -c "code: \.probeUnavailable"
/// -- engine/Sources` 是 0：没有任何一处把它产出来。一个有 remedy 没人产的码是
/// 死契约。量过的答案是 `restore(mode: rollback_full)`：一份 `gpz1-json-v1` 档 1
/// 检查点**只有**一条活探针连接能执行它（`EngineCore.swift:2380`），连接没了
/// 时它不拒绝，而是回 `planValid:true` + `consistent:true` + `rollbackExecuted:false`
/// 那一份成功形状的载荷。
final class DailyRound20261030SW2ProbeListenerTests: XCTestCase {

    private static let clockStart = Date(timeIntervalSince1970: 1_762_700_000)

    private final class TimeBox {
        var now = DailyRound20261030SW2ProbeListenerTests.clockStart
    }

    private func hello(pid: Int32 = 4242, capabilities: [String]) -> ProbeHello {
        ProbeHello(
            pid: pid, bundleId: "com.example.app", appName: "Example",
            probeVersion: "gp-probe/0.1.0", capabilities: capabilities
        )
    }

    private func makeCore(time: TimeBox, inbox: ProbeInbox?) throws -> EngineCore {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(120)
        let core = EngineCore(
            channel: channel, clock: { time.now }, settle: {}, probeInbox: inbox
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        return core
    }

    /// 一个会答 `checkpoint_export` 与 `checkpoint_restore` 的探针：
    /// 与真 GlassPaneProbe 在 socket 上做的事一致。
    private func scriptedCheckpoint(
        inbox: ProbeInbox, domains: [String: [String: String]]
    ) {
        let digest = ProbeWire.sha256Hex(ProbeWire.checkpointCanonical(domains))
        inbox.sender = { pid, data in
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            guard let type = object?["t"] as? String else { return true }
            if type == "checkpoint_export" {
                let ref = object?["ref"] as? String ?? ""
                inbox.ingest(pid: pid, frame: .checkpoint(ref: ref, domains: domains, digest: digest, error: nil))
            }
            if type == "checkpoint_restore" {
                inbox.ingest(pid: pid, frame: .result(ok: true, postStateDigest: digest, error: nil))
            }
            return true
        }
    }

    /// 带 gpz1（或 z5）载荷的快照，用 P5 的注入口造：`checkpointFormat` 决定了
    /// `restore` 那一路有没有执行面。
    private func envelope(
        format: String, domains: [String], probeVersion: String = "gp-probe/0.1.0"
    ) -> SnapshotProbeInfo {
        let draft = SnapshotProbeInfo(
            probeVersion: probeVersion, exportedDomains: domains, stateDigest: "",
            checkpointFormat: format, capturedAt: "2026-10-30T00:00:00.000Z"
        )
        return SnapshotProbeInfo(
            probeVersion: draft.probeVersion, exportedDomains: draft.exportedDomains,
            stateDigest: RestorePipeline.envelopeDigest(of: draft),
            checkpointFormat: draft.checkpointFormat, capturedAt: draft.capturedAt
        )
    }

    /// `probes` 的读法：它必须还是数组（壳侧的说明文档写的是列表）。
    private func probeRows(in status: [String: Any]) throws -> [[String: Any]] {
        try XCTUnwrap(
            status["probes"] as? [[String: Any]],
            "`probes` 必须还在，还是那个形状：\(status.keys.sorted())"
        )
    }

    private func engineWithInjected(
        time: TimeBox, probe: SnapshotProbeInfo, inbox: ProbeInbox? = nil
    ) throws -> EngineCore {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(120)
        let core = EngineCore(
            channel: channel, clock: { time.now }, settle: {},
            snapshotProbe: { probe }, probeInbox: inbox
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        return core
    }

    // MARK: - (a) 监听者状态必须自己说话

    /// 没有 inbox 时 `probeListener` 必须在，并且把「没有监听者」这件事说出来。
    /// REVERSE: 修复前红——载荷里根本没有 `probeListener` 这个键，取到 nil。
    func testProbeStatusNamesTheListenerAsAbsentWhenNoInboxIsWired() throws {
        let time = TimeBox()
        let status = try makeCore(time: time, inbox: nil).probeStatus()

        let listener = try XCTUnwrap(
            status["probeListener"] as? String,
            "没有监听者也是一件量到的事实，它必须有一个键：\(status.keys.sorted())"
        )
        XCTAssertTrue(listener.hasPrefix("absent"), "得能一眼看出这是缺席：\(listener)")
        XCTAssertTrue(
            listener.contains("no probe listener"),
            "缺席的一侧要把话说全，不能只留一个词：\(listener)"
        )
        // 冻结的两项一个字不许改：面板与 shell 的说明文档写的就是它们。
        XCTAssertTrue(try probeRows(in: status).isEmpty)
        XCTAssertEqual(status["attachedHasProbe"] as? Bool, false)
    }

    /// 核心形状：`--no-probe` 的回话与「监听者活着、app 没接探针」的回话必须可分辨。
    /// REVERSE: 修复前红——两份载荷逐字节相同（`probes=[]` + `attachedHasProbe=false`），
    /// 下面那条 `XCTAssertNotEqual` 直接失败。
    func testALiveListenerWithAnUninstrumentedAppIsNotTheSameAsNoListener() throws {
        let time = TimeBox()
        let noListener = try makeCore(time: time, inbox: nil).probeStatus()
        let liveListenerEmpty = try makeCore(time: time, inbox: ProbeInbox(now: { time.now })).probeStatus()

        // 两侧共同的前提：app 没接探针，所以 `probes` 是空的。
        XCTAssertTrue(try probeRows(in: noListener).isEmpty)
        XCTAssertTrue(try probeRows(in: liveListenerEmpty).isEmpty)
        XCTAssertEqual(noListener["attachedHasProbe"] as? Bool, false)
        XCTAssertEqual(liveListenerEmpty["attachedHasProbe"] as? Bool, false)

        // 而这两件事本身不一样：一个是「这一面不存在」，一个是「这一面在，没人接」。
        XCTAssertEqual(liveListenerEmpty["probeListener"] as? String, "live")
        XCTAssertTrue((noListener["probeListener"] as? String)?.hasPrefix("absent") == true)
        XCTAssertNotEqual(
            noListener as NSDictionary, liveListenerEmpty as NSDictionary,
            "agent 读到两份一样的字节就会去给 app 接探针，而这边根本没有能接受它的 socket"
        )
    }

    /// 缺席的一侧不许顺手编出「测到的零」：四个兄弟键的省略规矩（:1914 那道闸）
    /// 一个都不许因为新增的键被带走。`ProbeCounterTests.swift:171-178` 与
    /// `EngineCoreTests.swift:1179` 钉的是同一件事，这一条是它在新键下的护栏。
    /// REVERSE: 把 `if let inbox` 那道闸去掉（`disconnections` 变成 0）→ 红。
    func testAbsentListenerStillPublishesNoMeasuredZeros() throws {
        let time = TimeBox()
        let status = try makeCore(time: time, inbox: nil).probeStatus()
        for key in ["disconnections", "recentDisconnections", "unmapableStateFrames", "ringEvictedEventsTotal"] {
            XCTAssertNil(status[key], "\(key): 没有量它的东西，就不能有一个数：\(status[key] ?? "nil")")
        }
        let live = try makeCore(time: time, inbox: ProbeInbox(now: { time.now })).probeStatus()
        XCTAssertEqual(live["disconnections"] as? Int, 0, "有监听者时 0 是一次真测量")
        XCTAssertEqual(live["unmapableStateFrames"] as? Int, 0)
    }

    // MARK: - (b) 让 GP_E_PROBE_UNAVAILABLE 有一个产地

    /// 生产上真能撞到的形状：快照是在探针活着时取的（`gpz1-json-v1`），
    /// restore 之前 app 退出、连接掉了。档 1 检查点只有那条连接能执行，
    /// 于是这一趟没有可执行面——从前它回的是成功形状。
    /// REVERSE: 去掉新增的拒绝（退回落到 planned-only 那份载荷）→ 红：
    /// 不抛异常，且 `planValid:true` / `consistent:true` /
    /// `executionSurface:"z5-probe-runtime"`（一个这台机器上不存在的运行时）。
    func testRollbackFullAfterTheProbeDroppedRefusesWithProbeUnavailable() throws {
        let time = TimeBox()
        let domains = ["counter": ["value": "3"]]
        let inbox = ProbeInbox(now: { time.now })
        inbox.register(hello(capabilities: ["z1", "z2", "checkpoint"]))
        scriptedCheckpoint(inbox: inbox, domains: domains)
        let core = try makeCore(time: time, inbox: inbox)

        let snapshotId = try XCTUnwrap(core.snapshot(maxDepth: 4)["snapshotId"] as? String)
        // 前提：这条活连接确实把 gpz1 检查点导出来了，执行面真的存在过。
        let executed = try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")
        XCTAssertEqual(executed["rollbackExecuted"] as? Bool, true)
        XCTAssertEqual(executed["executionSurface"] as? String, "gp-probe")

        inbox.disconnect(pid: 4242, reason: "peer closed the connection (EOF)")
        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")) { error in
            let gpError = error as? GPError
            XCTAssertEqual(gpError?.code, .probeUnavailable, "拒绝必须是点名的那个码：\(error)")
            let message = gpError?.message ?? ""
            XCTAssertTrue(message.contains("4242"), "要说清是哪一条连接没了：\(message)")
            XCTAssertTrue(
                message.lowercased().contains("connection"),
                "「掉线」与「这一面从来不存在」是两件事：\(message)"
            )
            // 发布出去的 remedy 必须还是声明过的那一条，不许换成一句新的。
            XCTAssertTrue(
                gpError?.remedy.hasPrefix(GPError.remedy(for: .probeUnavailable)) == true,
                "remedy 的前半必须是表里那一句：\(gpError?.remedy ?? "nil")"
            )
        }
    }

    /// 另一半形状：这一份引擎**从来没有**监听者，手里却有一份 gpz1 载荷。
    /// 没有监听者时不许说成「某条连接断了」，也不许把计划说成可执行。
    /// REVERSE: 新加的拒绝只覆盖连接掉线那一支 → 这一条红（落回 planned-only）。
    func testRollbackFullWithNoListenerAtAllRefusesWithProbeUnavailable() throws {
        let time = TimeBox()
        let core = try engineWithInjected(
            time: time, probe: envelope(format: "gpz1-json-v1", domains: ["counter"]), inbox: nil
        )
        let snapshotId = try XCTUnwrap(core.snapshot(maxDepth: 4)["snapshotId"] as? String)

        XCTAssertThrowsError(try core.restore(snapshotId: snapshotId, steps: nil, mode: "rollback_full")) { error in
            let gpError = error as? GPError
            XCTAssertEqual(gpError?.code, .probeUnavailable, "\(error)")
            XCTAssertTrue(
                (gpError?.message ?? "").contains("no probe listener"),
                "这一面不存在时不许说成某条连接断了：\(gpError?.message ?? "nil")"
            )
        }
    }

    /// 一个从未接通过探针的窗口通道不许被这个新码顺手接管：`z5-json-v1`
    /// （这台机器上从来没有执行面的那种载荷）照旧回 planned-only，一个字都不许多。
    /// REVERSE: 新加的拒绝写成「凡 rollback_full 都要活探针」→ 这一条红。
    func testTheOlderZ5PayloadKeepsItsPlanOnlyAnswer() throws {
        let time = TimeBox()
        let core = try engineWithInjected(
            time: time, probe: envelope(format: "z5-json-v1", domains: ["objc"], probeVersion: "z5-0.1.0")
        )
        let snapshot = try core.snapshot(maxDepth: 4)
        let result = try core.restore(
            snapshotId: try XCTUnwrap(snapshot["snapshotId"] as? String), steps: nil, mode: "rollback_full"
        )
        XCTAssertEqual(result["planValid"] as? Bool, true)
        XCTAssertEqual(result["rollbackExecuted"] as? Bool, false)
        XCTAssertEqual(result["executionSurface"] as? String, "z5-probe-runtime")
    }

    /// 为什么没有监听者，只有起 daemon 的那一段知道（`--no-probe` 还是 A-18 拒绑）。
    /// 引擎量不到自己没被起来的原因，所以这一句由启动方**申报**——与
    /// `inputMonitorAbsenceReason` 同一个形状；没申报时只能说量到的那一句。
    /// 申报只解释「缺席」，不许把活着的监听者说成缺席——那是另一种假数。
    /// （这一条要新钩子才编得动，因此它的「修复前红」由上面两条承担：键不存在、
    /// 两份载荷逐字节相同；它钉的是新入参的词表与优先级。）
    func testTheLauncherCanNameWhichKindOfAbsenceItStarted() throws {
        let time = TimeBox()
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let declared = EngineCore(
            channel: channel, clock: { time.now }, settle: {},
            probeInbox: nil, probeListenerAbsence: .noProbeFlag
        )
        XCTAssertEqual(declared.probeStatus()["probeListener"] as? String, "absent (--no-probe)")
        let occupied = EngineCore(
            channel: channel, clock: { time.now }, settle: {},
            probeInbox: nil, probeListenerAbsence: .nameOwnedByAnotherListener
        )
        XCTAssertEqual(
            occupied.probeStatus()["probeListener"] as? String,
            "absent (name owned by another listener)"
        )
        // 实测优先于申报：有一条监听者时，那句「--no-probe」不能把它抹掉。
        let live = EngineCore(
            channel: channel, clock: { time.now }, settle: {},
            probeInbox: ProbeInbox(now: { time.now }), probeListenerAbsence: .noProbeFlag
        )
        XCTAssertEqual(live.probeStatus()["probeListener"] as? String, "live")
    }
}
