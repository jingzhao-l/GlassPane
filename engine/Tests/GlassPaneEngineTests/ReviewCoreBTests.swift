import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// 2026-10-09 复审 B 批：七条已核实结论的对照用例。
///
/// 每条都写清了"撤掉修复这一条就红"是哪一句——本仓的诚实不变量是"没测到的通道
/// 必须缺席、且必须被点名"，而下面这几条的共同失效形态都是**绿着撒谎**：撤掉判据
/// 之后没有一个断言会自己变红，除非用例本身就盯着那个标签。
final class ReviewCoreBTests: XCTestCase {

    private var submitSelector: Selector {
        Selector(role: "AXButton", title: "Submit")
    }

    private func makeChannel() -> ScriptedChannel {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackCapture = TestImages.solid(100)
        return channel
    }

    /// 每次调用前进 `stepMs` 的时钟：`EngineCore` 的实测时长全部出自 `clock()`，
    /// 固定时钟会让"量到了多久"这一类断言退化成 0。
    private func steppingClock(start: TimeInterval = 0, stepMs: Double) -> () -> Date {
        var current = start
        return {
            let now = Date(timeIntervalSince1970: current)
            current += stepMs / 1000
            return now
        }
    }

    // MARK: - 1: windowId 相同、采集区域被拖走

    /// 只比 `windowId` 的那道闸认不出"同一个窗口被拖走了"：`WindowCapture.bounds`
    /// 是每次采集各自解析的 frame，SCKCapturer 在没有遮挡时按它裁屏，于是两张图是
    /// 两块不同屏幕区域的裁剪。比出来的 0.25 会被 `signals.pixelDiff` 当成"界面
    /// 变了 25%"发出去——那是伪造的证据。
    /// REVERSE：撤掉 `captureBoundsMatch` 那道判据 → 两帧真能比出一个 0.25，
    /// 本条的 `XCTAssertNil(pack.signals.pixelDiff)` 与 `pixel-capture-window-moved`
    /// 两句同时变红。
    func testWindowMovedBetweenCapturesIsNotPublishedAsAPixelMeasurement() throws {
        let channel = BoundsScriptedChannel(
            tree: TestTrees.standard,
            captures: [
                (image: TestImages.solid(100), bounds: Bounds(x: 100, y: 100, width: 32, height: 32)),
                (
                    image: TestImages.quadrantChanged(base: 100, delta: 120),
                    bounds: Bounds(x: 640, y: 100, width: 32, height: 32)
                ),
            ]
        )
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.act(selector: submitSelector, action: .press)

        XCTAssertNil(result["pixelChanged"] as? Bool, "两块不同区域的差别不是一次像素测量")
        let pack = try core.lastEvidence(operationId: nil)
        XCTAssertNil(pack.signals.pixelDiff, "未同域比较就没有 ratio 可发：\(String(describing: pack.signals.pixelDiff))")
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.contains("pixel-capture-window-moved"), reason)
        XCTAssertTrue(
            reason.contains("100.0,100.0") && reason.contains("640.0,100.0"),
            "成因里要带前后两块区域，否则分不清是被拖走还是被盖住：\(reason)"
        )
        XCTAssertFalse(reason.contains("screen-recording-denied"), "移动不是席位问题：\(reason)")
        XCTAssertEqual(pack.circuitBreaker.level, .degraded)

        // 结构半边：新标签与它那条出路必须同源（mcp-shell 的 remedy-surface 闸
        // 只看两边的集合相等，这里盯的是它自己会不会说反话）。
        let movedReason = "the capture area of window 12 moved between the two captures "
            + "(window moved, same size): before=32.0x32.0 at 100.0,100.0, after=32.0x32.0 at 640.0,100.0"
        XCTAssertEqual(EngineCore.pixelCaptureFailureLabel(reason: movedReason), "pixel-capture-window-moved")
        let mapped = EngineCore.map(.pixelCaptureDenied(reason: movedReason))
        XCTAssertTrue(mapped.message.contains("pixel-capture-window-moved"), mapped.message)
        XCTAssertFalse(mapped.remedy.lowercased().contains("grant screen recording"), mapped.remedy)
        XCTAssertFalse(mapped.remedy.contains("restart the daemon"), mapped.remedy)
        // 分类器现在认得这个新标签，那条出路必须说"把窗口按住别动"，既不能把人支去
        // 授予屏幕录制席位（移动不是席位问题），也不能塌回 resize 那句话。
        let next = Classifier.pixelAbsentNextStep(reason: reason)
        XCTAssertFalse(next.lowercased().contains("grant"), next)
        XCTAssertTrue(next.lowercased().contains("moved"), next)
        XCTAssertFalse(next.contains("changed size"), "移动不是缩放：\(next)")
        // 认不出的成因仍然得落到"读 reason 原文"——新增成因不许新增一句假指引。
        let unknown = Classifier.pixelAbsentNextStep(reason: "pixel-capture-something-nobody-wrote: x")
        XCTAssertTrue(unknown.contains("circuitBreaker.reason"), unknown)
        XCTAssertFalse(unknown.lowercased().contains("grant"), unknown)

        // 撤掉新分支也不许把 resize 抢走：resized 的判据仍是原来那一句。
        XCTAssertEqual(
            EngineCore.pixelCaptureFailureLabel(
                reason: "the two captures have no common pixel domain (before=32x32, after=16x32)"
            ),
            "pixel-capture-window-resized"
        )
    }

    // MARK: - 2: 两条通道同时坏时必须各点名一次

    /// 邻居注释写的是"每个未测量的通道独立点名"，而像素那一句从前多了半个条件
    /// `treeBefore != nil`：树也失败时，席位被拒/超时/取不到图那句**整条消失**，
    /// 证据里只剩 `ax-tree-capture-failed`——读的人会以为像素通道没出过事。
    /// REVERSE：把 `treeBefore != nil` 加回去 → 下面 `contains("screen-recording-denied")`
    /// 那句变红（`reason` 只剩 ax 那一条）。
    func testPixelAndTreeCaptureBothFailingNameBothChannels() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.treeResults = [
            .failure(.treeCaptureFailed(reason: "root children exceeded the capture budget"))
        ]
        channel.captureResults = [
            .failure(.pixelCaptureDenied(reason: "screen recording permission not granted"))
        ]
        // fallbackCapture 保持 nil：after 那次采集同样失败，两条通道都没测到。
        let core = EngineCore(channel: channel, settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        _ = try core.act(selector: submitSelector, action: .press)

        let pack = try core.lastEvidence(operationId: nil)
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.contains("screen-recording-denied"), "像素通道的成因必须留下：\(reason)")
        XCTAssertTrue(reason.contains("ax-tree-capture-failed"), "树通道的名字不能被挤掉：\(reason)")
        XCTAssertNil(pack.signals.pixelDiff)
        XCTAssertEqual(pack.circuitBreaker.level, .degraded)
    }

    // MARK: - 3: observe 的角色拼法必须与选择器同一套判据

    /// `gp_observe {role:"button"}` 从前按字面比较：选择器认这个拼法、这里不认，
    /// 于是一棵满是按钮的树被回答成 `axTree: []` + `nodeCount: 0`，还附一个"空树"
    /// 的摘要——一句凭空造出的"这里没有按钮"。
    /// REVERSE：把 `AXChannel.roleMatches` 换回 `node.role == role` → 前两个拼法
    /// 立刻数到 0 个节点，本条变红。
    func testObserveRoleSpellingAcceptedBySelectorsNeverAnswersAnEmptyTree() throws {
        let core = EngineCore(channel: makeChannel(), settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        for spelling in ["button", "Button", "AXButton"] {
            let result = try core.observe(maxDepth: 6, role: spelling)
            let nodes = try XCTUnwrap(result["axTree"] as? [Any], spelling)
            XCTAssertFalse(nodes.isEmpty, "\(spelling) 这个拼法选择器认，observe 就不许答空树")
            XCTAssertEqual(result["nodeCount"] as? Int, 1, "\(spelling): 那一个按钮就是全部命中")
        }
    }

    // MARK: - 4: 过滤后的摘要必须属于过滤后的那棵树

    /// `digest` 与 `nodeCount`/`axTree` 是同一个标签下的同一棵树。从前那句
    /// `(try? TreeDigest.digest(roots)) ?? snapshot.digest` 在算不出来时把
    /// **未过滤**树的摘要递出去，于是两个字段描述两棵树。
    /// 行为半边：摘要必须等于过滤树的摘要、且不等于整棵树的摘要。
    /// REVERSE：改回 `try?` + 借用 → 源码半边变红；行为半边说明的是同一条口径，
    /// 但 `AxNode` 编不出会失败的 JSON，没有输入能走到那个 fallback，所以单靠
    /// 行为断言撤修复不会红——形状半边就是为这一点存在的。
    func testRoleFilteredObserveDigestsTheFilteredTreeOnly() throws {
        let core = EngineCore(channel: makeChannel(), settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let result = try core.observe(maxDepth: 6, role: "button")
        let digest = try XCTUnwrap(result["digest"] as? String)
        let expected = try TreeDigest.digest([
            AxNode(role: "AXButton", title: "Submit", identifier: "submit-button")
        ])
        XCTAssertEqual(digest, expected, "digest 说的必须是返回的那棵树")
        XCTAssertNotEqual(digest, TestTrees.standard.digest, "整棵树的摘要不能顶替过滤后的摘要")

        let source = try engineCoreSource()
        XCTAssertFalse(
            source.contains("try? TreeDigest.digest(roots) ?? snapshot.digest"),
            "observe 又把未过滤树的摘要当 fallback 借回来了"
        )
        XCTAssertTrue(
            source.contains("digest = try TreeDigest.digest(roots)"),
            "过滤树的摘要必须由这一句算出并如实抛出"
        )
    }

    // MARK: - 5: 超时那次量到的是多久就说多久

    /// 从前超时时把**预算**（2000）写进 `pingMs`，而分类器把这个字段印成"这个应用
    /// 答了多久"——应用一次也没答。真实值就在 ping 的两侧，扔掉它再抄一个常数，
    /// 是给一个没发生的测量填数。
    /// REVERSE：把 `pingMs: Self.pingTimeoutMs` 写回去 → 本条得到 2000，
    /// "不等于预算"与"= 2400"两句一起变红。
    func testPingTimeoutReportsMeasuredElapsedRatherThanTheBudgetConstant() throws {
        let channel = makeChannel()
        channel.pingResult = .failure(.pingTimeout)
        let core = EngineCore(
            channel: channel,
            clock: steppingClock(stepMs: 2_400),
            settle: {}
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertThrowsGPError(.actFailed) {
            _ = try core.act(selector: submitSelector, action: .press)
        }
        let pack = try core.lastEvidence(operationId: nil)
        let responsiveness = try XCTUnwrap(pack.signals.responsiveness)
        XCTAssertEqual(responsiveness.responsive, false)
        XCTAssertNotEqual(
            responsiveness.pingMs, EngineCore.pingTimeoutMs,
            "pingMs 是实测回答用时；超时那次没有回答，就更不能填预算"
        )
        XCTAssertEqual(responsiveness.pingMs, 2_400, accuracy: 1, "这次量到的是 2400ms")

        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.contains("ax-ping-timeout"), reason)
        XCTAssertTrue(reason.contains("2400ms"), "实测值要能被读到：\(reason)")
        XCTAssertTrue(
            reason.contains("\(Int(EngineCore.pingTimeoutMs))ms budget"),
            "预算留在标签里，否则 2400 读起来只是一次普通过慢回答：\(reason)"
        )
        XCTAssertEqual(Classifier.classify(pack).0, .t2, "超时仍是 T2，措辞不改归类")
    }

    // MARK: - 6: 性能升级不许把量到的那句耗时丢掉

    /// 已有通道原因时，从前整句被换成裸前缀 `performance|`，于是"这一轮跑了
    /// 15000ms、超 10000ms 预算"这件**实测**的事实从证据里消失。前缀按 v1.1 §2
    /// 保留，数字也必须保留。
    /// REVERSE：把拼接换回 `"performance|" + $0` → `contains("15000ms")` 与
    /// `contains("performance-act-latency-over-budget")` 两句变红。
    func testPerformanceEscalationKeepsTheMeasuredLatencySentence() throws {
        let channel = makeChannel()
        channel.captureResults = [
            .failure(.pixelCaptureDenied(reason: "screen recording permission not granted"))
        ]
        channel.fallbackCapture = nil
        let core = EngineCore(
            channel: channel,
            clock: steppingClock(stepMs: 15_000),
            settle: {}
        )
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        _ = try core.act(selector: submitSelector, action: .press)
        let pack = try core.lastEvidence(operationId: nil)
        let reason = try XCTUnwrap(pack.circuitBreaker.reason)
        XCTAssertTrue(reason.hasPrefix("performance|"), "v1.1 的可解析前缀要留住：\(reason)")
        XCTAssertTrue(
            reason.contains("performance-act-latency-over-budget: 15000ms > 10000ms"),
            "量到的那句耗时不许被前缀顶替：\(reason)"
        )
        XCTAssertTrue(reason.contains("screen-recording-denied"), "通道原因也不能被性能句顶替：\(reason)")
    }

    // MARK: - 7: restore 台账与选择器回显

    /// compare-only 那一步也没回滚，链上却写 "restore executed: compare"，而隔壁
    /// 档 1 写的是 "planned only (no execution surface)"。
    /// REVERSE：`outcome` 改回 `"executed"` → 前缀与"不含 executed: compare"两句变红。
    func testCompareOnlyRestoreLedgerNamesWhatActuallyRan() throws {
        let gate = ApprovalGate()
        let core = EngineCore(channel: makeChannel(), settle: {}, approvalGate: gate)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let snapshotId = try XCTUnwrap(
            try core.snapshot(maxDepth: 6)["snapshotId"] as? String
        )
        let result = try core.restore(snapshotId: snapshotId, steps: nil, mode: nil)
        XCTAssertEqual(result["confirmed"] as? Int, 0)
        XCTAssertEqual(result["total"] as? Int, 0)

        let reason = try XCTUnwrap(gate.chain().first?.reason)
        XCTAssertTrue(
            reason.hasPrefix("restore compared only, no step rolled back:"),
            "一步也没回滚就不能写 executed：\(reason)"
        )
        XCTAssertFalse(reason.contains("executed: compare"), reason)
        XCTAssertTrue(gate.verifyChain().valid)
    }

    /// 选择器里没给的字段是"没有这条约束"；`?? ""` 把它写成了一个**被断言的空值**。
    /// REVERSE：把 `title ?? ""` / `identifier ?? ""` 写回去 → 两个 `XCTAssertNil`
    /// 变红（键又出现了，且值是空串）。
    func testRestoreStepEchoOmitsSelectorFieldsThatWereNeverGiven() throws {
        let core = EngineCore(channel: makeChannel(), settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        let snapshotId = try XCTUnwrap(
            try core.snapshot(maxDepth: 6)["snapshotId"] as? String
        )
        let result = try core.restore(
            snapshotId: snapshotId,
            steps: [
                (Selector(role: "AXButton"), .press),
                (Selector(role: "AXButton", title: "Submit", identifier: "submit-button"), .press),
            ],
            mode: nil
        )
        let steps = try XCTUnwrap(result["steps"] as? [[String: Any]])
        XCTAssertEqual(steps.count, 2)

        let bare = try XCTUnwrap(steps[0]["selector"] as? [String: Any])
        XCTAssertEqual(bare["role"] as? String, "AXButton")
        XCTAssertFalse(bare.keys.contains("title"), "省略的字段不许被写成断言过的空串：\(bare)")
        XCTAssertFalse(bare.keys.contains("identifier"), "同上：\(bare)")

        let full = try XCTUnwrap(steps[1]["selector"] as? [String: Any])
        XCTAssertEqual(full["title"] as? String, "Submit")
        XCTAssertEqual(full["identifier"] as? String, "submit-button")
    }

    // MARK: - 形状闸的读源码半边（与 CaptureChannelShapeTests 同一取路方式）

    private var repoRoot: String {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.path
    }

    private func engineCoreSource() throws -> String {
        let path = repoRoot + "/engine/Sources/GlassPaneEngine/EngineCore.swift"
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw XCTSkip("读不到 EngineCore.swift；这一条形状对照在没有该文件的环境里不作数")
        }
        // 注释先剥掉：形状闸不该红在自己的说明文字上。
        return text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.drop(while: { $0 == " " || $0 == "\t" }).hasPrefix("//") }
            .joined(separator: "\n")
    }
}

// MARK: - 采集区域可逐次编排的通道

/// `ScriptedChannel` 把 `WindowCapture.bounds` 写死成 (0,0,32,32)，所以"同一个窗口、
/// 两块采集区域"这一形态在它上面**永远跑不到**。真机上窗口被拖走是完全正常的事，
/// 而判据只在 bounds 上，不在 image 上——没有这个替身，第 1 条结论就只能被读代码看见。
final class BoundsScriptedChannel: RuntimeChannel {

    private let app = AttachedApp(pid: 4242, bundleId: "com.example.app", appName: "Example")
    private let tree: AxTreeSnapshot
    private let captures: [(image: CGImage, bounds: Bounds)]
    private var captureIndex = 0

    init(tree: AxTreeSnapshot, captures: [(image: CGImage, bounds: Bounds)]) {
        self.tree = tree
        self.captures = captures
    }

    func attach(bundleId: String?, pid: pid_t?) throws -> AttachedApp { app }

    func ping() throws -> Double { 3 }

    func treeSnapshot(maxDepth: Int) throws -> AxTreeSnapshot { tree }

    func geometrySnapshot(maxDepth: Int) throws -> AxGeometrySnapshot {
        AxGeometrySnapshot(nodes: [], window: nil, latencyMs: 0)
    }

    func performAction(selector: Selector, action: Action) throws {}

    func readProperty(selector: Selector, property: AssertionProperty) throws -> StringOrBool {
        .bool(true)
    }

    func isProcessAlive() -> Bool { true }

    func captureWindow() throws -> WindowCapture {
        defer { captureIndex += 1 }
        guard captureIndex < captures.count else {
            throw ChannelError.pixelCaptureDenied(reason: "no capture scripted")
        }
        let scripted = captures[captureIndex]
        return WindowCapture(windowId: 12, bounds: scripted.bounds, image: scripted.image)
    }
}
