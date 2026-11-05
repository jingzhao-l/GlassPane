import XCTest
import Foundation
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 每日任务 2026-11-05 · 复审泳道交回的判定层缺陷，逐条回代码复核后修完。
///
/// 这一族是同一句话的两种写法：**没量到的东西被写成量到了**。
///   R-11 `EvidenceStore.read` 把"这份文件打不开 / 解不开 / 挂的是别人的号"与"这份文件不在"
///        一同回 nil，`EngineCore` 于是把一次失败的读念成 `GP_E_NO_EVIDENCE`（"这台机器上没有
///        这一条的证据"）；`lastOnDisk()` 同理把列不出目录念成"档案是空的"。
///   R-12 `gp_observe` 走到 `maxDepth` 那一档就停，交出去的树与"这棵子树真是叶子"同形。
///   R-13 `ownabilityDefect` 在 `.ownerAccountID` 缺席时打印 `uid -1`——一个从没读过的数。
///   R-15 `removeExpired` 把删除失败吃进 `(try? …) != nil`：dry-run 报 10、真跑删 7、CLI 报
///        `pruned: 7` 并退 0，一次部分成功被写成圆满成功。
///   R-10 授权台账"文件不在"与"文件里零条"交出逐字节相同的回话。
///   R-17 `RecipeLoader` 用 `Dispatcher.acceptedParamKeys[method] ?? []` 把"这张表没covering它"
///        念成"它一个键都不读"，而运行期那一侧遇到同一种缺席是直接返回。
///   M    daemon 在 `--evidence-stats` 里发 `ageRetention`，面板这一侧从没读过它。
///
/// REVERSE（每条在本机都跑红过，读数见本轮汇报）：
///   · `read` 的 open 失败那一支改回 `guard let data = try? … else { return nil }`
///     ⇒ `testAnUnopenableEntryIsNotAnAbsentEntry` 红（nil 而 readFailure 也是 nil）。
///   · `observe` 那两枚新键删掉 ⇒ `testTheHorizonTravelsWithTheTree` 红。
///   · `owner?.intValue ?? -1` 那一形改回来 ⇒ `testNoOwnabilitySentencePrintsAFabricatedUid` 红。
///   · `removeExpired` 改回吞掉失败 ⇒ `testARefusedDeletionIsNamedNotSilent` 红。
///   · CLI 载荷里删掉 `ledgerPresent` ⇒ `testAbsentAndEmptyAreToldApart` 红。
///   · `if let accepted = …` 改回 `?? []` ⇒ `testTheValidatorAndTheRuntimeAnswerTheSameWay` 红。
///   · `parseDaemonStats` 里删掉 `ageRetention:` 那一行 ⇒ `testThePanelReadsTheRetentionLine…` 红。
final class DailyRound20261105ArchiveAndTableHonestyTests: XCTestCase {

    private let probeOperation = "op_CCCCCCCCCCCCCCCCCCCCCCCCCC"  // op_ + 26，合法档案名（`entryNamePattern`）

    // MARK: - helpers
    // 直接写字节而不是走 `store.write`：要测的是"盘上有这么一份文件，而它读不出来 /
    // 解不开 / 挂的是别人的号"，写侧那道隔离闸会把这三种形状都挡在外面。

    private func makeDirectory(_ label: String) throws -> String {
        let directory = TestSandbox.directory(label)
        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: directory), withIntermediateDirectories: true)
        return directory
    }

    @discardableResult
    private func entryPath(directory: String, operationId: String, contents: String) throws -> String {
        let path = "\(directory)/\(operationId).json"
        try Data(contents.utf8).write(to: URL(fileURLWithPath: path))
        return path
    }

    private func store(at directory: String) -> EvidenceStore {
        EvidenceStore(directory: directory)
    }

    private func source(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - R-11：读不出来 ≠ 没有

    func testAnUnopenableEntryIsNotAnAbsentEntry() throws {
        let directory = try makeDirectory("archive-honesty-unopenable")
        let path = try entryPath(directory: directory, operationId: probeOperation, contents: "{}")
        let unreadable = store(at: directory)
        // 让这一枚文件打不开：只改它自己的模式（000），不动目录，列举照旧走得动。
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path) }
        XCTAssertNil(unreadable.read(operationId: probeOperation), "打不开的那一枚不能被交出去")
        let reason = try XCTUnwrap(unreadable.readFailure,
            "read 回 nil 却没留下理由，调用方只能把它念成「查无此档」")
        XCTAssertTrue(reason.contains("could not open"), reason)

        // 对照：真的没有这一条时 `readFailure` 必须留在 nil——否则"缺席"也被说成"读不出"。
        let absent = store(at: directory)
        XCTAssertNil(absent.read(operationId: "op_ABSENTABSENTABSENTABSENT0000"))
        XCTAssertNil(absent.readFailure,
            "一条没点过的档案不许留下一次失败的影子：\(absent.readFailure ?? "nil")")
    }

    func testACorruptEntryNamesItselfAsCorrupt() throws {
        let directory = try makeDirectory("archive-honesty-corrupt")
        let body = "not an evidence pack at all"
        try entryPath(directory: directory, operationId: probeOperation, contents: body)
        let unreadable = store(at: directory)
        XCTAssertNil(unreadable.read(operationId: probeOperation))
        let reason = try XCTUnwrap(unreadable.readFailure, "解不开的档案必须说出它解不开")
        XCTAssertTrue(reason.contains("do not decode"), reason)
        XCTAssertTrue(reason.contains("\(body.utf8.count) bytes"), reason)
    }

    func testAMisfiledEntryIsNotSilenceEither() throws {
        let directory = try makeDirectory("archive-honesty-misfiled")
        // 形状来自真产物：先让引擎自己写一份档案，再把那一份的字节改名放到另一号上——
        // 这就是"文件名说 A、正文说 B"在生产里长什么样（手拼的 JSON 会在解码那一层就死掉，
        // 测不到这一支）。
        let writer = store(at: directory)
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        let core = EngineCore(channel: channel, settle: {}, evidenceStore: writer)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let acted = try core.act(selector: Selector(role: "AXButton", title: "Submit"), action: .press)
        let written = try XCTUnwrap(acted["operationId"] as? String)
        let misfitId = "op_MISFILEDMISFILEDMISFILLED1"
        try FileManager.default.copyItem(
            atPath: "\(directory)/\(written).json", toPath: "\(directory)/\(misfitId).json")

        let reader = store(at: directory)
        XCTAssertNil(reader.read(operationId: misfitId))
        let reason = try XCTUnwrap(reader.readFailure,
            "名字与正文不合的档案从前只写进日志，回给调用方的是一句 nil")
        XCTAssertTrue(reason.contains("carries operationId"), reason)
        XCTAssertTrue(reason.contains(written), "要说得出它带的究竟是谁的号：\(reason)")
    }

    func testTheEngineRefusesToCallAFailedReadAnAbsence() throws {
        let directory = try makeDirectory("archive-honesty-engine")
        let path = try entryPath(directory: directory, operationId: probeOperation, contents: "{}")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path) }
        let store = store(at: directory)
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, settle: {}, evidenceStore: store)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)

        XCTAssertThrowsError(try core.lastEvidence(operationId: probeOperation)) { error in
            let gp = error as? GPError
            XCTAssertNotNil(gp, "引擎这一路只能交结构化错误")
            XCTAssertEqual(gp?.code, .internalError,
                "打不开的档案被念成了 \(gp?.code.rawValue ?? "?")——那句是在说这台机器没有这一条的证据")
            XCTAssertTrue(gp?.message.contains("could not read") ?? false, gp?.message ?? "")
            XCTAssertTrue(gp?.remedy.contains("--evidence-stats") ?? false,
                          "出路必须给一条做得动的读法：\(gp?.remedy ?? "")")
        }

        // 对照必须能过：这一号真不在盘上时答案仍是"查无此档"（GP_E_NO_EVIDENCE）。
        XCTAssertThrowsError(try core.lastEvidence(operationId: "op_NOTHINGLIKEIT000000000000")) { error in
            XCTAssertEqual((error as? GPError)?.code, .noEvidence,
                "缺席就是缺席，这条对照不许被新的拒绝形状吃掉")
        }
    }

    func testAnUnlistableArchiveIsNotReportedAsEmpty() throws {
        let directory = try makeDirectory("archive-honesty-unlistable")
        try entryPath(directory: directory, operationId: probeOperation, contents: "{}")
        // 目录本身收成不可读（0100：只留 owner 的执行位）——列举必然失败。
        try FileManager.default.setAttributes([.posixPermissions: 0o100], ofItemAtPath: directory)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory) }
        let store = store(at: directory)
        XCTAssertNil(store.lastOnDisk())
        let listing = try XCTUnwrap(store.listingFailure,
            "lastOnDisk 回 nil 而 listingFailure 是 nil，等于宣布「这个目录里没有档案」")
        XCTAssertTrue(listing.contains("cannot list"), listing)
    }

    // MARK: - R-12：这一趟走到哪一档停了，要跟着树一起交出去

    func testNodesAtDepthCountsTheHorizon() {
        func chain(_ depth: Int) -> AxNode {
            depth == 0 ? AxNode(role: "AXLeaf") : AxNode(role: "AXGroup", children: [chain(depth - 1)])
        }
        XCTAssertEqual(TreeDigest.nodesAtDepth([chain(4)], depth: 2), 1, "停在第 2 档的那一枚正好一枚")
        XCTAssertEqual(TreeDigest.nodesAtDepth([chain(2)], depth: 7), 0,
                       "上限比树还深时不许凭空数出东西——那会把读完的树说成截断过")
        let two = AxNode(role: "AXWindow", children: [AxNode(role: "AXButton"), AxNode(role: "AXButton")])
        XCTAssertEqual(TreeDigest.nodesAtDepth([two], depth: 1), 2, "数的是节点，不是深度")
        XCTAssertEqual(TreeDigest.nodesAtDepth([two], depth: 0), 1, "上限为 0 时根节点自己就是那一档")
    }

    func testTheHorizonTravelsWithTheTree() throws {
        let store = TestSandbox.evidenceStore(at: TestSandbox.directory("observe-horizon"))
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        let core = EngineCore(channel: channel, settle: {}, evidenceStore: store)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let payload = try core.observe(maxDepth: 3, role: nil)
        XCTAssertEqual(payload["depthLimit"] as? Int, 3,
            "回话里没跟着这一趟真正走到的那一档：\(payload.keys.sorted())")
        let unexpanded = try XCTUnwrap(payload["unexpandedAtDepthLimit"] as? Int,
            "没有「停在何处」的读数，调用方只能把空 children 读成叶子")
        XCTAssertGreaterThanOrEqual(unexpanded, 0)
        // 摘要与计数说的是同一棵树——这一条不能被新键带走。
        _ = try XCTUnwrap(payload["digest"] as? String)
        _ = try XCTUnwrap(payload["nodeCount"] as? Int)
    }

    // MARK: - R-13：不许造一个没读到的 uid

    func testNoOwnabilitySentencePrintsAFabricatedUid() throws {
        let text = try source("Sources/GlassPaneEngine/EngineCore.swift")
        XCTAssertTrue(text.contains("guard let owner = attributes[.ownerAccountID] as? NSNumber else"),
            "主人读不出来那一支不见了，`?? -1` 随时可能回来")
        XCTAssertFalse(text.contains("owner?.intValue ?? -1"), "又把一个没量过的 uid 折成了确定值")
        // 行为的一格：对真存在的每一处，这一路要么说"没问题"，要么说得出是谁的，永远不该有 -1。
        let directory = try makeDirectory("ownability-real-paths")
        let file = "\(directory)/evidence.json"
        try Data("x".utf8).write(to: URL(fileURLWithPath: file))
        var measured = 0
        for probe in [directory, file, "\(file).missing", "/private/tmp"] {
            measured += 1
            guard let verdict = EngineCore.ownabilityDefect(path: probe) else { continue }
            XCTAssertFalse(verdict.contains("uid -1"),
                "\(probe) 这一句印出了一个从没读到的主人号：\(verdict)")
        }
        XCTAssertEqual(measured, 4, "对照只走了 \(measured) 个位置，这条闸在空转")
    }

    // MARK: - R-15：删不动的那几枚必须点名，部分成功不是成功

    func testARefusedDeletionIsNamedNotSilent() throws {
        let directory = try makeDirectory("prune-refused")
        let old = Date(timeIntervalSince1970: 1_000_000)  // 远早于任何"天"档
        for name in ["op_AAAAAAAAAAAAAAAAAAAAAAAAAA", "op_BBBBBBBBBBBBBBBBBBBBBBBBBB"] {
            let path = try entryPath(directory: directory, operationId: name, contents: "{}")
            try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: path)
        }
        let store = store(at: directory)
        XCTAssertEqual(store.countExpired(olderThanDays: 1), 2, "先确认这一趟本来要删两枚")
        // 让两枚都删不动：目录收成只读（列举仍走得动，unlink 走不动）。
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory) }
        let removed = store.prune(olderThanDays: 1)
        XCTAssertEqual(store.pruneFailureTotal, 2, "两枚都删不动，而失败那一格是 \(store.pruneFailureTotal)")
        XCTAssertEqual(removed + store.pruneFailureTotal, 2,
            "报出去的删除数与删不掉的枚数加起来不等于本来要删的数：\(removed) + \(store.pruneFailureTotal)")
        XCTAssertEqual(store.pruneFailures.count, 2)
        XCTAssertTrue(store.pruneFailures.allSatisfy { $0["reason"] != nil && $0["file"] != nil },
                      "点名要有点名该有的两样：\(store.pruneFailures)")
        let payload = EvidencePruneReport.payload(
            pruned: removed, dryRun: false, project: nil, dir: directory, listFailure: nil,
            failures: store.pruneFailures, failureTotal: store.pruneFailureTotal)
        XCTAssertEqual(payload["failed"] as? Int, 2, "载荷里必须看得见删不掉的枚数")
        XCTAssertNotNil(payload["failures"] as? [[String: String]])
    }

    func testDryRunReportsNoFailuresBecauseItDeletesNothing() throws {
        let directory = try makeDirectory("prune-dryrun-failures")
        let path = try entryPath(directory: directory, operationId: probeOperation, contents: "{}")
        // 让它真的过龄：预览要数到它，否则这一条只量到"目录里有一枚未来的文件"。
        try FileManager.default.setAttributes(
            [.modificationDate: Date(timeIntervalSince1970: 1_000_000)], ofItemAtPath: path)
        let store = store(at: directory)
        XCTAssertEqual(store.countExpired(olderThanDays: 1), 1)
        XCTAssertTrue(store.pruneFailures.isEmpty, "预览这一路一次都没删，不该有删除失败")
        XCTAssertEqual(store.pruneFailureTotal, 0)
    }

    // MARK: - R-10：台账"不在"与"空"是两件事

    func testAbsentAndEmptyAreToldApart() throws {
        let directory = try makeDirectory("approval-presence")
        let path = "\(directory)/approvals.json"

        let absent = ApprovalGate(path: path)
        let absentPresent = absent.ledgerPresent  // 先取读数：这一枚是"核验那一刻文件在不在"
        XCTAssertFalse(absentPresent, "文件还没写，这一枚必须是 false")
        XCTAssertEqual(absent.count, 0)

        try Data("[]".utf8).write(to: URL(fileURLWithPath: path))
        let empty = ApprovalGate(path: path)
        XCTAssertTrue(empty.ledgerPresent, "文件在、里面零条——与上面那一档必须分得开")
        XCTAssertEqual(empty.count, 0)
        XCTAssertEqual(empty.verifyChain().valid, true, "空链本身是合法的，这一格不许改判")
        XCTAssertNotEqual(absentPresent, empty.ledgerPresent,
            "缺席与空表在这一枚键上还是一样的，读者分不开")

        // CLI 那一面的读者靠的是载荷里的键名，这里把它钉住（删掉即红）。
        let text = try source("Sources/glasspaned/main.swift")
        XCTAssertTrue(text.contains("\"ledgerPresent\": gate.ledgerPresent"),
            "--approval-verify 的载荷不再交这一枚，缺席与空表就又逐字节一样了")
    }

    // MARK: - R-17：校验层与运行期对同一种缺席必须同答

    func testTheValidatorAndTheRuntimeAnswerTheSameWay() throws {
        var compared = 0
        for (kind, method) in RecipeLoader.stepKindMethods {
            compared += 1
            let params: [String: Any] = ["gpProbeBogusKey": 1]
            let runtimeRefuses: Bool
            do {
                try Dispatcher.requireOnlyReadParamKeys(method: method, params: params)
                runtimeRefuses = false
            } catch is GPError {
                runtimeRefuses = true
            }
            let step: [String: Any] = ["kind": kind, "params": params]
            let data = try JSONSerialization.data(withJSONObject: ["steps": [step]])
            let result = RecipeLoader.validate(data)
            let validatorRefuses = result.errors.contains { $0.contains("does not read") }
            XCTAssertEqual(validatorRefuses, runtimeRefuses,
                "`\(kind)` → `\(method.rawValue)`：校验层 \(validatorRefuses ? "拒" : "放")、运行期 \(runtimeRefuses ? "拒" : "放")——两个门面对同一帧说两种话")
        }
        XCTAssertGreaterThanOrEqual(compared, 4, "只比了 \(compared) 个 kind，这条对照在空转")
        // 表的覆盖本身要看得见：漏一个方法时上面那条对照会一起退化，所以单独数一次。
        XCTAssertGreaterThanOrEqual(Dispatcher.acceptedParamKeys.count, 8,
            "参数表只剩 \(Dispatcher.acceptedParamKeys.count) 枚方法，这条对照看不到东西了")
        let unmapped = Set(RecipeLoader.stepKindMethods.values.map { $0.rawValue })
            .subtracting(Dispatcher.acceptedParamKeys.keys.map { $0.rawValue })
        XCTAssertEqual(unmapped, [], "配方能写的 kind 里有点名不在参数表上的方法：\(unmapped)")
    }

    // MARK: - 候选 M：发布出去的那一格必须有读者

    func testThePanelReadsTheRetentionLineTheDaemonPublishes() throws {
        // 判据形状来自 `--evidence-stats` 真发的这几个键（`main.swift` 的载荷），不是手拼。
        let withRetention = try XCTUnwrap(ConsoleModel.parseDaemonStats(
            #"{"count":3,"totalBytes":42,"listFailure":null,"dir":"/tmp/e","ageRetention":"no age gate is configured"}"#))
        guard case let .loaded(_, _, _, _, ageRetention) = withRetention else {
            return XCTFail("解析没走进 loaded，这一格没被读到")
        }
        XCTAssertEqual(ageRetention, "no age gate is configured",
            "daemon 早就在发这一句，面板这一侧从前没读（候选 M）")

        // 对照：旧 daemon 不带这一格时读成 nil，面板那一行跟着说"没报"，不许替它编一句。
        let legacy = try XCTUnwrap(ConsoleModel.parseDaemonStats(
            #"{"count":0,"totalBytes":0,"dir":"/x"}"#))
        guard case let .loaded(_, _, _, _, legacyRetention) = legacy else {
            return XCTFail("缺 ageRetention 键时整条解析都不该退化")
        }
        XCTAssertNil(legacyRetention, "缺键不许被折成一句结论")

        // 视图那一半必须真把它印出来（只解析不上屏就是又一次"发布了却没读者"）。
        let view = try source("Sources/glasspane-settings/EvidenceStatsView.swift")
        XCTAssertTrue(view.contains("ageRetention"),
            "EvidenceStatsView 不再读这一格，这一枚键就又没人看了")
        XCTAssertTrue(view.contains("gp-daemon-age-retention"),
            "上屏那一行要有自己的 AX 标识，真机走查才点得到它")
    }
}
