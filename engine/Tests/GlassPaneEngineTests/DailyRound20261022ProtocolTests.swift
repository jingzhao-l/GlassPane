import XCTest
@testable import GlassPaneEngine

/// 2026-10-22 协议轮：两条已核实的 daemon 缺陷。逐条写明"破坏哪一句会让它变红"。
///
/// **缺陷 1（被忽略的参数替调用方回答了另一个操作）**
/// `ParamValidation.optOperationId` 对缺键回 nil，`Dispatcher.handleDiagnose`/
/// `handleLastEvidence` 于是回答"最近那一个包"。方法层没有 per-method 白名单，所以
/// `{"operationid":"op_…"}`（大小写错了）拿到的是**别的操作**的证据包与针对它的诊断，
/// 却挂在调用方自己点名的那个 id 下面；拼错的 `degrade`、`maxDepth`、`mode` 同一类。
/// 修复是 `Dispatcher.acceptedParamKeys`（逐 handler 反查出来的接受集）+
/// `ParamValidation.requireOnlyKnownKeys`，在 `dispatch` 里、handler 之前拒。
///
/// **缺陷 2（只装了一半的拒绝）**
/// `glasspaned --project-prune` 的回读拒绝条件是 `verified.loadFailed && !dryRun`，
/// 于是面板用来预览的那条 `--dry-run` 绕过拒绝，走到下面把
/// `"loadFailed": false, "remaining": verified.all.count` 发出去——`all` 之所以空，
/// 正是因为这次加载失败了。修复：判据挪进 `ProjectRegistry.pruneReadBackRefusal`
/// （两种模式同一条），载荷的 `dryRun` 改由调用方说。
///
/// 两条都配正反两面的闸：白名单方向（多余键必拒）与宽容方向（每个方法带着它自己读的
/// 键必须仍然答得出），后者不在的话，一条过度严格的表也能把闸喂饱。
final class DailyRound20261022ProtocolTests: XCTestCase {

    private var channel: ScriptedChannel!
    private var dispatcher: Dispatcher!

    override func setUp() {
        super.setUp()
        channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        dispatcher = Dispatcher(core: EngineCore(channel: channel, settle: {}))
    }

    // MARK: - 帧面夹具（与 `DispatcherTests` 同一套形状）

    private func decode(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data, options: []) as? [String: Any])
    }

    @discardableResult
    private func performRaw(
        _ frame: String, on target: Dispatcher? = nil
    ) throws -> Data {
        (target ?? dispatcher).handle(.frame(Data(frame.utf8)))
    }

    private func perform(_ frame: String, on target: Dispatcher? = nil) throws -> [String: Any] {
        try decode(try performRaw(frame, on: target))
    }

    private func perform(_ object: [String: Any], on target: Dispatcher? = nil) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        return try decode((target ?? dispatcher).handle(.frame(data)))
    }

    private func error(of response: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap(response["error"] as? [String: Any], "这一帧没有回结构化错误：\(response)")
    }

    private func code(of response: [String: Any]) throws -> String {
        try XCTUnwrap(error(of: response)["code"] as? String)
    }

    private func message(of response: [String: Any]) throws -> String {
        try XCTUnwrap(error(of: response)["message"] as? String)
    }

    /// 对照的一半：坏在这里时，后面每一条"被正确拒绝"的断言都只是"整条通路坏了"。
    private func attachOrFail() throws {
        let response = try perform(
            #"{"id":1,"method":"attach","params":{"bundleId":"com.example.app"}}"#
        )
        XCTAssertNotNil(response["result"], "attach 的对照形状坏了：\(response)")
    }

    private func actOnce(_ id: Int, degrade: Bool) throws -> String {
        let frame = #"{"id":\#(id),"method":"act","params":{"selector":{"role":"AXButton","title":"Submit"},"action":"press","degrade":\#(degrade ? "true" : "false")}}"#
        let response = try perform(frame)
        let result = try XCTUnwrap(response["result"] as? [String: Any], "act 的对照形状坏了：\(response)")
        return try XCTUnwrap(result["operationId"] as? String)
    }

    private func snapshotId(depth: Int) throws -> String {
        let response = try perform(
            #"{"id":19,"method":"snapshot","params":{"maxDepth":\#(depth)}}"#
        )
        let result = try XCTUnwrap(response["result"] as? [String: Any], "snapshot 的对照形状坏了：\(response)")
        return try XCTUnwrap(result["snapshotId"] as? String)
    }

    private func evidencePack(of response: [String: Any]) -> [String: Any]? {
        (response["result"] as? [String: Any])?["evidencePack"] as? [String: Any]
    }

    // MARK: - 缺陷 1，方向 (a)：每个方法带着它自己读的键必须仍然答得出

    /// 表必须覆盖线表里每一个方法：少一个键名＝那个方法重新变成"静默忽略所有 params"，
    /// 多一个（比如把 `hello` 拉进表）＝今天能用的 caller 被拒。
    /// REVERSE：从 `Dispatcher.acceptedParamKeys` 里删掉 `.lastEvidence` 那一条 → 红；
    /// 加上 `.hello: []` → 第二条断言红。
    func testEveryDispatchedMethodIsClassifiedInTheWhitelist() {
        var expected = Set(EngineMethod.allCases)
        expected.remove(.hello)
        expected.remove(.shutdown)
        let covered = Set(Dispatcher.acceptedParamKeys.keys)
        XCTAssertEqual(
            covered,
            expected,
            "线表里每一个方法都要被分类：读 `params` 的进表，不读的留在豁免名单里"
        )
        XCTAssertFalse(
            covered.contains(.hello) || covered.contains(.shutdown),
            "`hello`/`shutdown` 今天带任何 params 都被忽略，这一条修复不许改它们的形状"
        )
    }

    /// (a)：表里 11 个方法各带**它自己读的键**、外加 `hello`/`shutdown` 两个豁免项，用
    /// 现有 `DispatcherTests` 的那批请求形状发出去，都必须拿到 `result` 而不是一次拒绝。
    /// 这条是**反方向**的闸——没有它，一张过度严格的表也能把下面的拒绝测试喂饱。
    /// REVERSE：从表里删掉一个真键（例如 `observe` 的 `role`、`audit_ui` 的
    /// `minHitTargetPt`）→ 对应那一例红；把某个键从表里挪到别的方法名下 → 同样红。
    func testWhitelistedMethodsStillAnswerTheKeysTheyRead() throws {
        // `attach` 的两个形状先跑（`bundleId` 见 `attachOrFail`，`projectId` 见
        // `testAttachStillAcceptsProjectId`，这里是 `pid`）：重挂同一个 app 不清历史，
        // 但把读操作排在后面就不该依赖这一点。
        let byPid = try perform(#"{"id":2,"method":"attach","params":{"pid":4242}}"#)
        XCTAssertNil(byPid["error"], "attach 带它读的 `pid` 却被拒：\(byPid["error"] ?? "nil")")
        XCTAssertNotNil(byPid["result"])

        try attachOrFail()
        let operationId = try actOnce(3, degrade: false)
        let snap = try snapshotId(depth: 6)

        let cases: [(String, String)] = [
            ("act(selector,action,degrade)",
             #"{"id":4,"method":"act","params":{"selector":{"role":"AXButton","title":"Submit"},"action":"press","degrade":true}}"#),
            ("observe(maxDepth,role)",
             #"{"id":5,"method":"observe","params":{"maxDepth":6,"role":"AXButton"}}"#),
            ("assert_element(selector,property,expected)",
             #"{"id":6,"method":"assert_element","params":{"selector":{"role":"AXButton","title":"Submit"},"property":"enabled","expected":true}}"#),
            ("diagnose(operationId)",
             #"{"id":7,"method":"diagnose","params":{"operationId":"\#(operationId)"}}"#),
            ("last_evidence(operationId)",
             #"{"id":8,"method":"last_evidence","params":{"operationId":"\#(operationId)"}}"#),
            ("snapshot(maxDepth)", #"{"id":9,"method":"snapshot","params":{"maxDepth":4}}"#),
            ("restore(snapshotId,mode)",
             #"{"id":10,"method":"restore","params":{"snapshotId":"\#(snap)","mode":"compare"}}"#),
            ("capture_view(scale)", #"{"id":11,"method":"capture_view","params":{"scale":0.5}}"#),
            ("audit_ui(maxDepth,minHitTargetPt)",
             #"{"id":12,"method":"audit_ui","params":{"maxDepth":6,"minHitTargetPt":24}}"#),
            ("probe_status(不读键)", #"{"id":13,"method":"probe_status"}"#),
            ("hello(不读键)", #"{"id":14,"method":"hello"}"#),
            ("shutdown(不读键)", #"{"id":15,"method":"shutdown"}"#),
        ]
        for (what, frame) in cases {
            let response = try perform(frame)
            if let error = response["error"] as? [String: Any] {
                XCTFail(
                    "\(what) 带着它自己读的键却被拒了：\(error["code"] ?? "?") — \(error["message"] ?? "")"
                )
            } else {
                XCTAssertNotNil(response["result"], "\(what) 没有交出 result：\(response)")
            }
        }
    }

    /// `restore` 的第三个键 `steps` 单独驱动：一次 ffwd 重演在 ScriptedChannel 上是
    /// 真执行的，这里要钉的是它**不许被表外键吃掉**（参数判据之外的那条路）。
    /// REVERSE：把 `steps` 从 `.restore` 的接受集里去掉 → 红（回的是 GP_E_BAD_PARAMS）。
    func testRestoreStillAcceptsItsStepsArray() throws {
        try attachOrFail()
        _ = try actOnce(2, degrade: false)
        let snap = try snapshotId(depth: 6)
        let response = try perform(
            #"{"id":20,"method":"restore","params":{"snapshotId":"\#(snap)","steps":[{"selector":{"role":"AXButton","title":"Submit"},"action":"press"}],"mode":"ffwd"}}"#
        )
        let code = (response["error"] as? [String: Any])?["code"] as? String
        XCTAssertNotEqual(
            code, "GP_E_BAD_PARAMS",
            "`steps` 被白名单吃掉了：\((response["error"] as? [String: Any])?["message"] ?? "nil")"
        )
    }

    /// `attach` 的第三个键 `projectId`：表里有它，就必须仍然进得了 `core.attach`。
    /// REVERSE：从 `.attach` 的接受集里去掉 `projectId` → 红（这里回的是 GP_E_BAD_PARAMS
    /// 而不是注册表那条 `unknown projectId`）。
    func testAttachStillAcceptsProjectId() throws {
        let registry = TestSandbox.projectRegistry("whitelist-attach-project")
        let entry = try registry.create(displayName: "Target", bundleId: "com.example.app")
        let core = EngineCore(channel: channel, settle: {}, projectRegistry: registry)
        let scoped = Dispatcher(core: core)
        let response = try perform(
            #"{"id":1,"method":"attach","params":{"bundleId":"com.example.app","projectId":"\#(entry.projectId)"}}"#,
            on: scoped
        )
        XCTAssertNil(response["error"], "带 projectId 的 attach 被拒了：\(response["error"] ?? "nil")")
        XCTAssertNotNil(response["result"])
    }

    /// 宽容方向的第二半：**缺键**仍然走文档化的默认（`optOperationId` 回 nil →
    /// "最近那一个"）。白名单只管读不到的键，不许把"没给"也变成错误。
    /// REVERSE：让 `requireOnlyKnownKeys` 对缺键也抛 → 这条红。
    func testOmittedOptionalKeysStillAnswerTheDocumentedLatest() throws {
        try attachOrFail()
        let operationId = try actOnce(2, degrade: false)
        let latest = try perform(#"{"id":3,"method":"last_evidence"}"#)
        let pack = try XCTUnwrap(
            evidencePack(of: latest), "不带 operationId 的 last_evidence 从前答最近那一个，现在也必须答：\(latest)"
        )
        XCTAssertEqual(pack["operationId"] as? String, operationId)
        let diagnose = try perform(#"{"id":4,"method":"diagnose","params":{}}"#)
        XCTAssertNotNil(diagnose["result"], "空 params 的 diagnose 被拒了：\(diagnose["error"] ?? "nil")")
    }

    // MARK: - 缺陷 1，方向 (b)：拼错的 operationId 必拒，且不许带出任何包

    /// REVERSE：把 `.diagnose` 从表里删掉（回到"静默忽略"）→ 第一条断言红。
    func testTypoOperationIdOnDiagnoseRefusesTheKeyAndAnswersNothing() throws {
        try attachOrFail()
        let earlier = try actOnce(2, degrade: false)
        let later = try actOnce(3, degrade: false)
        XCTAssertNotEqual(earlier, later, "夹具要给出两个不同的操作，否则下面测不出\"答的是哪一个\"")

        let response = try perform(
            #"{"id":4,"method":"diagnose","params":{"operationid":"\#(earlier)"}}"#
        )
        XCTAssertEqual(try code(of: response), "GP_E_BAD_PARAMS")
        let refusalText = try message(of: response)
        XCTAssertTrue(refusalText.contains("operationid"), "拒绝没点名被拒的键：\(refusalText)")
        XCTAssertTrue(refusalText.contains("operationId"), "拒绝没列出这个方法读的键：\(refusalText)")
        XCTAssertNil(response["result"], "拒绝同时交出了一个诊断：\(response["result"] ?? "nil")")

        // 对照：拼写正确时它答的是**点名的那一个**，不是最近的那一个。
        let asked = try perform(
            #"{"id":5,"method":"diagnose","params":{"operationId":"\#(earlier)"}}"#
        )
        XCTAssertNotNil(asked["result"], "同一条命令的正确拼写被拒了：\(asked["error"] ?? "nil")")
    }

    /// (b) 的"assert the absence"那一半：从前这一帧拿到的是 `later` 的证据包并挂在
    /// `earlier` 的名字下——现在它一帧包都不许发。
    /// REVERSE：把 `.lastEvidence` 从表里删掉 → 前两条断言红，第三条（无包）也红。
    func testTypoOperationIdOnLastEvidenceRefusesAndPublishesNoPack() throws {
        try attachOrFail()
        let earlier = try actOnce(2, degrade: false)
        let later = try actOnce(3, degrade: false)

        let raw = try performRaw(
            #"{"id":4,"method":"last_evidence","params":{"operationid":"\#(earlier)"}}"#
        )
        let response = try decode(raw)
        XCTAssertEqual(try code(of: response), "GP_E_BAD_PARAMS")
        XCTAssertTrue(try message(of: response).contains("operationid"))
        XCTAssertNil(response["result"], "拒绝里仍然带着 result：\(response["result"] ?? "nil")")
        XCTAssertNil(evidencePack(of: response), "拒绝的 result 里带出了一份证据包")
        let frameText = String(data: raw, encoding: .utf8) ?? ""
        XCTAssertFalse(
            frameText.contains("evidencePack"),
            "整帧里没有证据包才对——从前这一帧发的就是 `\(later)` 的包：\(frameText)"
        )

        // 对照：拼对了拿到的是**点名的**那一个，而不是最近的那一个。
        let asked = try perform(
            #"{"id":5,"method":"last_evidence","params":{"operationId":"\#(earlier)"}}"#
        )
        let pack = try XCTUnwrap(
            evidencePack(of: asked), "正确拼写没拿到包：\(asked["error"] ?? "nil")"
        )
        XCTAssertEqual(pack["operationId"] as? String, earlier)
        XCTAssertNotEqual(pack["operationId"] as? String, later, "夹具坏了：最近的那一个必须与点名的那一个不同")
    }

    // MARK: - 缺陷 1，方向 (c)：act 的多余键被拒且什么都没执行

    /// REVERSE：把 `.act` 从表里删掉 → 回的是执行过的 result，第一条断言红；
    /// 把白名单挪到 `core.act` 之后 → `actionCallCount` 那条红。
    func testExtraUnknownKeyOnActIsRefusedAndNothingExecutes() throws {
        try attachOrFail()
        let before = channel.actionCallCount
        let response = try perform(
            #"{"id":2,"method":"act","params":{"selector":{"role":"AXButton","title":"Submit"},"action":"press","degraded":true}}"#
        )
        XCTAssertEqual(try code(of: response), "GP_E_BAD_PARAMS")
        let refusalText = try message(of: response)
        XCTAssertTrue(refusalText.contains("degraded"), "拒绝没点名多余的键：\(refusalText)")
        XCTAssertTrue(refusalText.contains("degrade"), "拒绝没列出真键（大小写/拼法差一点的那个）：\(refusalText)")
        XCTAssertNil(response["result"], "被拒的 act 同时执行了：\(response["result"] ?? "nil")")
        XCTAssertEqual(channel.actionCallCount, before, "手指已经落在用户屏幕上：拒绝发生在执行之后")

        // 对照：拼对的 `degrade` 必须仍然执行，否则这条修复只是把 act 关掉。
        let ok = try perform(
            #"{"id":3,"method":"act","params":{"selector":{"role":"AXButton","title":"Submit"},"action":"press","degrade":true}}"#
        )
        XCTAssertNotNil(ok["result"], "正确的 degrade 被拒了：\(ok["error"] ?? "nil")")
        XCTAssertEqual(channel.actionCallCount, before + 1)
    }

    /// 拒绝文本自己的两条要求：说出**每一个**被拒的键（漏一个就是让调用方猜还剩哪些
    /// 被吞了），以及回显必须封顶——键名是调用方给的（`RecipeLoader.capped` 同一条：
    /// 一句错误里的 4 KiB 键名会变成读者终端上的一屏）。
    /// REVERSE：把 `cappedParamKey` 换成裸键名 → 最后一组断言红；
    /// 把消息改成只报第一个被拒键 → 前两条断言红。
    func testRefusalNamesEveryRejectedKeyAndCapsTheEchoOfAHostileOne() throws {
        try attachOrFail()
        let two = try perform(
            #"{"id":2,"method":"observe","params":{"maxDepth":6,"roleX":1,"depth":2}}"#
        )
        let refusalText = try message(of: two)
        XCTAssertTrue(refusalText.contains("'depth'"), "两个被拒的键只报了一个：\(refusalText)")
        XCTAssertTrue(refusalText.contains("'roleX'"), "两个被拒的键只报了一个：\(refusalText)")
        XCTAssertTrue(refusalText.contains("maxDepth, role"), "没列出这个方法读的键：\(refusalText)")

        let hostile = String(repeating: "x", count: 4_000)
        let big = try perform(["id": 3, "method": "observe", "params": [hostile: 1]])
        let bigMessage = try message(of: big)
        XCTAssertTrue(bigMessage.contains("4000 code points total"), "截断没说自己是截断：\(bigMessage.count) 字")
        XCTAssertFalse(bigMessage.contains(String(repeating: "x", count: 200)), "4 KiB 的键名被整段回显")
        XCTAssertLessThan(bigMessage.count, 1_000, "一句参数拒绝成了终端的一屏：\(bigMessage.count) 字")
    }

    /// 豁免名单的正反两面：`hello`/`shutdown` 带着不读的键仍照今天那样答；
    /// `probe_status` 在同一条注释里被分类为"不读任何键"，但它的发布面
    /// (`ProbeStatusArgs = z.strictObject({})`) 已经拒了，所以 daemon 这边必须拒。
    /// REVERSE：把 `.hello: []` 加进表 → 第一条红；把 `.probeStatus` 从表里删掉 → 第三条红。
    func testHelloAndShutdownStayOpenWhileProbeStatusMatchesItsPublishedSchema() throws {
        let hello = try perform(
            #"{"id":1,"method":"hello","params":{"capabilities":{"caller":"panel"},"anything":1}}"#
        )
        XCTAssertNil(hello["error"], "hello 被收紧了：\(hello["error"] ?? "nil")")
        XCTAssertEqual((hello["result"] as? [String: Any])?["engine"] as? String, "glasspaned")

        let shutdown = try perform(#"{"id":2,"method":"shutdown","params":{"reason":"panel closing"}}"#)
        XCTAssertEqual((shutdown["result"] as? [String: Any])?["bye"] as? Bool, true)

        let extra = try perform(#"{"id":3,"method":"probe_status","params":{"pid":4242}}"#)
        XCTAssertEqual(try code(of: extra), "GP_E_BAD_PARAMS")
        let probeMessage = try message(of: extra)
        XCTAssertTrue(
            probeMessage.contains("reads no `params` keys at all"),
            "空接受集要能说出来：\(probeMessage)"
        )
    }

    /// 表的**反向**闸：handler 里如果新读了一个键而表没跟着改，这条红——那正是"白名单
    /// 吃掉一个真在用的 caller"的形状，而它只会在线上咬人，所以钉在源码上。
    /// REVERSE：在任一 handler 里加 `ParamValidation.optString(params, "newKey", maxLength: 8)`
    /// 而不动表 → 红；新加一个 `ParamValidation.` helper 而不登记它读的键 → 第二条红。
    func testWhitelistListsEveryKeyTheDispatcherReadsFromParams() throws {
        let source = try strippedSource(at: dispatcherPath)
        let labeled = Set(try captures(in: source, pattern: "ParamValidation\\.[A-Za-z]+\\(\\s*params\\s*,\\s*\"([A-Za-z]+)\""))
        XCTAssertFalse(labeled.isEmpty, "没读到任何带键名的调用：这条对照已经不作数")
        let union = Set(Dispatcher.acceptedParamKeys.values.flatMap { $0 })
        for key in labeled.sorted() {
            XCTAssertTrue(union.contains(key), "handler 读了 '\(key)' 而接受表里没有它：白名单会拒掉一个正常的 caller")
        }

        // 只按 helper 名隐含键的那批（requireSelector→selector、optOperationId→operationId…）：
        // 出现新名字就必须在这里登记它读哪个键，否则新加的读取会静默落到表外。
        XCTAssertEqual(
            Set(try captures(in: source, pattern: "ParamValidation\\.([A-Za-z]+)\\(")),
            [
                "optString", "optInt", "optBool", "optDouble",
                "optOperationId", "optRestoreMode", "optSteps",
                "requireSelector", "requireAction", "requireProperty", "requireExpected",
                "requireSnapshotId",
                // 白名单自己的入口：它读的是 `accepted:` 那份表，不是某个键。
                "requireOnlyKnownKeys",
            ],
            "handler 里出现了新的（或旧的被移走的）ParamValidation 调用"
        )
        for implied in ["selector", "action", "property", "expected", "operationId", "snapshotId", "steps", "mode"] {
            XCTAssertTrue(union.contains(implied), "helper 隐含的键 '\(implied)' 不在接受表里")
        }
    }

    // MARK: - 缺陷 2：回读读不开时的拒绝，两种模式同一条判据

    /// REVERSE：把库里的 guard 改回 `readBackLoadFailed && !dryRun` → 预览那一轮红；
    /// 把载荷里加回 `remaining`/`projects` → 中间两条断言红。
    func testPruneRefusesAnUnreadableReadBackInBothModes() throws {
        for dryRun in [false, true] {
            let refusal = try XCTUnwrap(
                ProjectRegistry.pruneReadBackRefusal(
                    total: 7, matched: 3, dryRun: dryRun,
                    registryPath: "/tmp/x/projects.json", readBackLoadFailed: true
                ),
                "dryRun=\(dryRun) 时回读读不开却没有拒绝——预览会替一份打不开的文件报数"
            )
            XCTAssertEqual(refusal["loadFailed"] as? Bool, true)
            XCTAssertEqual(refusal["dryRun"] as? Bool, dryRun, "`dryRun` 这个键从前写死 false，在预览的答复里是否认那是预览")
            XCTAssertEqual(refusal["command"] as? String, "--project-prune")
            XCTAssertNil(refusal["remaining"], "看不见这张表的时候报不出\"表里剩几条\"")
            XCTAssertNil(refusal["projects"], "同理：读不回的表不得作为空表交出去")
            XCTAssertEqual(refusal["pruned"] as? Int, 0, "没有任何一条被确认删掉，这是真话")
            XCTAssertEqual(refusal["registryPath"] as? String, "/tmp/x/projects.json")
        }
        // 对照：回读成功时这条判据不许凭空拒绝（否则预览永远报不出剩余条数）。
        XCTAssertNil(
            ProjectRegistry.pruneReadBackRefusal(
                total: 7, matched: 3, dryRun: false,
                registryPath: "/tmp/x/projects.json", readBackLoadFailed: false
            ),
            "回读成功却被拒——拒绝退化成了\"逢答必拒\""
        )
        XCTAssertNil(
            ProjectRegistry.pruneReadBackRefusal(
                total: 7, matched: 3, dryRun: true,
                registryPath: "/tmp/x/projects.json", readBackLoadFailed: false
            )
        )
    }

    /// 载荷除了 `remaining`/`projects` 之外还不许发明别的数：预览那一趟一次删除都没被
    /// 派过，所以 `failed` 是 0、`failures` 是空的、`requiresDaemonRestart` 是 false
    /// （同 CLI 正常答复里 `requiresDaemonRestart: pruned > 0` 的口径），error 也不能
    /// 说"这次写把它弄坏了"——预览没写。
    /// REVERSE：把 `failed`/`failures`/`requiresDaemonRestart` 改回无条件 `matched`/
    /// 一行"after the write"/`true` → 前三条断言红。
    func testPruneReadBackPayloadMakesNoWriteClaimInPreviewMode() throws {
        let preview = try XCTUnwrap(ProjectRegistry.pruneReadBackRefusal(
            total: 7, matched: 3, dryRun: true,
            registryPath: "/tmp/x/projects.json", readBackLoadFailed: true
        ))
        XCTAssertEqual(preview["failed"] as? Int, 0, "预览一次删除都没派过，\"失败 3 条\"没被测量过")
        XCTAssertEqual((preview["failures"] as? [Any])?.count, 0, "一行\"after the write\"的失败是预览编出来的")
        XCTAssertEqual(preview["requiresDaemonRestart"] as? Bool, false, "一次没改过任何东西的跑不该造一个\"要重启\"的待办")
        XCTAssertTrue((preview["failures"] as? [Any])?.isEmpty ?? true)
        let error = try XCTUnwrap(preview["error"] as? String)
        XCTAssertFalse(error.contains("the write left"), "预览的答复说这次写弄坏了文件：\(error)")
        XCTAssertTrue(error.contains("no count"), "拒绝要说出它为什么没有计数：\(error)")
        XCTAssertTrue((preview["next"] as? String)?.contains("/tmp/x/projects.json") == true, "下一步要点名是哪份文件")

        // 对照：真删那一趟的口径不变（3 条命中 0 条确认，就是 3 条没做成）。
        let written = try XCTUnwrap(ProjectRegistry.pruneReadBackRefusal(
            total: 7, matched: 3, dryRun: false,
            registryPath: "/tmp/x/projects.json", readBackLoadFailed: true
        ))
        XCTAssertEqual(written["failed"] as? Int, 3)
        XCTAssertEqual(written["requiresDaemonRestart"] as? Bool, true)
        XCTAssertEqual((written["failures"] as? [Any])?.count, 1)
        XCTAssertEqual(
            written["error"] as? String,
            "the write left projects.json unreadable; the daemon must not keep running on its in-memory copy"
        )
    }

    /// 三参数的旧形状仍然要说得出非预览的事实（`DailyRound20261012Tests` 钉的就是它）。
    /// REVERSE：把那条转发里的 `dryRun: false` 改成 `true` → 红。
    func testTheNonPreviewSpellingStillPublishesADryRunFalseRefusal() {
        let payload = ProjectRegistry.pruneUnreadablePayload(
            total: 7, matched: 3, registryPath: "/tmp/x/projects.json"
        )
        XCTAssertEqual(payload["dryRun"] as? Bool, false, "非预览形状的 `dryRun` 必须由签名说，而不是靠调用方记得")
        XCTAssertEqual(payload["loadFailed"] as? Bool, true)
        XCTAssertNil(payload["remaining"])
    }

    /// 判据落点的闸：`main.swift` 是顶层代码、没人能 import，所以这一条只能钉源码形状
    /// （本仓对 `--list-projects` / `--active-project` 的同一条约束用同样办法）。
    /// REVERSE：把条件改回 `if verified.loadFailed && !dryRun` 并手拼载荷 → 三条全红。
    func testMainPruneReadBackArmIsNotConditionedOnTheMode() throws {
        let source = try strippedSource(at: mainSwiftPath)
        let arm = try body(
            of: source, startsAt: "private func runProjectPrune", stopsAt: "private func runProjectRemove"
        )
        XCTAssertFalse(
            arm.contains("verified.loadFailed &&"),
            "回读拒绝又带上了模式条件：`--dry-run` 会重新念出一个从打不开的文件里数出来的 remaining"
        )
        XCTAssertTrue(
            arm.contains("readBackLoadFailed: verified.loadFailed"),
            "判据不在库里这一条上——两种模式共用一条判据是这次修复的全部内容"
        )
        XCTAssertTrue(arm.contains("ProjectRegistry.pruneReadBackRefusal("), "载荷又被搬回 CLI 里手拼")
        XCTAssertTrue(arm.contains("dryRun: dryRun"), "预览的模式事实没交给载荷")
        XCTAssertLessThan(
            try XCTUnwrap(arm.range(of: "pruneReadBackRefusal")).lowerBound,
            try XCTUnwrap(arm.range(of: #""remaining": verified.all.count"#)).lowerBound,
            "拒绝必须发生在发布带 `remaining` 的那份答复之前，否则先发出去的那个 0 才是读者拿到的"
        )
    }

    /// 真二进制 + 真坏文件。这一条落在 `--project-prune --dry-run` 上，走的是**加载时**
    /// 那条臂：回读那一臂要求两次加载之间真的有一个写者（`DailyRound20261011Batch2Tests`
    /// 的头注就是这条约束——跑不出确定性就不冒充端到端证据），它的正反两面由上面
    /// 两条库内闸与一条源码闸钉住。这一条要钉的是端到端的那句承诺：预览一份打不开
    /// 的表是非零退出，且 stdout/stderr 里没有一个 `remaining`。
    /// REVERSE：把加载时的拒绝改成带 `remaining` 的载荷 → 红。
    func testRealDaemonRefusesAPreviewOfAnUnreadableRegistryWithoutARemaining() throws {
        XCTAssertTrue(FileManager.default.fileExists(atPath: daemonBinary), "真二进制不在：\(daemonBinary)")
        let root = TestSandbox.directory("prune-dryrun-unreadable")
        let projects = root + "/projects.json"
        try Data("{ this is not json ".utf8).write(to: URL(fileURLWithPath: projects))
        XCTAssertTrue(
            ProjectRegistry(filePath: projects).loadFailed,
            "夹具没能让注册表真的读不开——这份文件会被解码，判据就测不到"
        )

        let result = try run([daemonBinary, "--state-dir", root, "--project-prune", "--dry-run"])
        XCTAssertNotEqual(result.status, 0, "预览一份打不开的表不是成功：exit \(result.status)")
        XCTAssertEqual(result.status, 1, "与 --project-prune 的其它拒绝同口径：\(result.stdout)|\(result.stderr)")
        let payload = try XCTUnwrap(
            json(result.stderr), "拒绝的报文走 stderr 且必须是一份 JSON：\(result.stdout)|\(result.stderr)"
        )
        XCTAssertEqual(payload["loadFailed"] as? Bool, true)
        XCTAssertEqual(payload["dryRun"] as? Bool, true, "预览的模式事实要如实报出去")
        XCTAssertNil(payload["remaining"], "`remaining: 0` 是从这份谁也打不开的文件里数出来的")
        XCTAssertNil(payload["projects"], "看不见的表不得作为空表交出去")
        XCTAssertTrue(result.stdout.isEmpty, "stdout 不许留半份答案：\(result.stdout)")
    }

    // MARK: - 夹具：源码形状与真进程

    private var engineDir: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { url.deleteLastPathComponent() }
        return url.path
    }

    private var daemonBinary: String { engineDir + "/.build/debug/glasspaned" }
    private var mainSwiftPath: String { engineDir + "/Sources/glasspaned/main.swift" }
    private var dispatcherPath: String { engineDir + "/Sources/GlassPaneEngine/Dispatcher.swift" }

    /// 注释里写满了"从前那句错的写法"长什么样（`verified.loadFailed && !dryRun` 此刻就
    /// 在我新加的注释里），负向断言必须只扫代码。剥离法与 `MainRegistryRefusalBranchTests` 同。
    private func strippedSource(at path: String) throws -> String {
        let text = try String(contentsOfFile: path, encoding: .utf8)
        var out = text
        while let open = out.range(of: "/*") {
            guard let close = out.range(of: "*/", range: open.upperBound..<out.endIndex) else { break }
            out.removeSubrange(open.lowerBound..<close.upperBound)
        }
        return out
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.drop(while: { $0 == " " || $0 == "\t" }).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// 有界的窗口：两个边界都要能在文件里找到，否则断言会落在整个文件上。
    private func body(
        of source: String, startsAt start: String, stopsAt end: String
    ) throws -> String {
        let from = try XCTUnwrap(source.range(of: start), "\(start) 不见了：这条闸钉的就是它")
        let to = try XCTUnwrap(
            source.range(of: end, range: from.upperBound..<source.endIndex),
            "窗口右边界 \(end) 不见了：没有界的窗口会让断言在整个文件尾巴上成立"
        )
        return String(source[from.lowerBound..<to.lowerBound])
    }

    private func captures(in text: String, pattern: String) throws -> [String] {
        let regex = try NSRegularExpression(pattern: pattern)
        let full = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: full).compactMap { match in
            guard let range = Range(match.range(at: 1), in: text) else { return nil }
            return String(text[range])
        }
    }

    private struct CLI {
        let status: Int32
        let stdout: String
        let stderr: String
    }

    /// 先读到 EOF 再等退出（`RegistryCliRefusalShapeTests` 的同一条理由：反过来的话，
    /// 输出超过管道缓冲的子进程会卡在这里）。
    private func run(_ arguments: [String]) throws -> CLI {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: daemonBinary)
        process.arguments = arguments
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()
        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        process.waitUntilExit()
        return CLI(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }

    private func json(_ text: String) -> [String: Any]? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return object
    }
}
