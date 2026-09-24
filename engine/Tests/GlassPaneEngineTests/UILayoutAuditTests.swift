import XCTest
@testable import GlassPaneEngine

/// 界面可操作性审计的纯逻辑测试。
///
/// 这一层刻意不依赖任何活的 AX 目标：输入是合成的几何节点，所以规则本身、
/// 覆盖率语义和判定降级都能在 CI 里跑绿（真机面在 engine/smoke.md 另算）。
final class UILayoutAuditTests: XCTestCase {

    private func node(
        _ path: String,
        role: String,
        frame: AxFrame? = AxFrame(x: 10, y: 10, width: 120, height: 44),
        title: String? = nil
    ) -> AxGeometryNode {
        let read: GeometryRead
        if let frame { read = .measured(frame) }
        else { read = .absent }
        return AxGeometryNode(path: path, role: role, title: title, geometry: read)
    }

    private func unread(_ path: String, role: String) -> AxGeometryNode {
        AxGeometryNode(path: path, role: role, geometry: .unread(reason: "the accessibility ping timed out"))
    }

    private func snapshot(_ nodes: [AxGeometryNode], window: AxFrame? = AxFrame(x: 0, y: 0, width: 800, height: 600)) -> AxGeometrySnapshot {
        AxGeometrySnapshot(nodes: nodes, window: window, latencyMs: 1)
    }

    // MARK: - 通过的样子

    func testCleanLayoutPassesWithFullCoverage() {
        let result = UILayoutAudit.audit(snapshot([
            node("0", role: "AXButton", frame: AxFrame(x: 20, y: 20, width: 120, height: 44)),
            node("1", role: "AXCheckBox", frame: AxFrame(x: 20, y: 80, width: 200, height: 18)),
            node("2", role: "AXSlider", frame: AxFrame(x: 20, y: 120, width: 300, height: 20)),
        ]))
        // 18pt 高的复选框低于 44pt 习惯值，所以这里不该是 pass 而该是 advisory——
        // 反过来讲：能报 pass 的，只有全部达标的一屏。
        XCTAssertEqual(result.verdict, .advisory)
        XCTAssertEqual(result.coverage.measured, 3)
        XCTAssertEqual(result.coverage.ratio, 1.0, accuracy: 0.0001)
        XCTAssertTrue(result.findings.contains { $0.rule == "tinyHitTarget" })
    }

    func testEverythingAtOrAboveMinimumPasses() {
        let result = UILayoutAudit.audit(snapshot([
            node("0", role: "AXButton", frame: AxFrame(x: 20, y: 20, width: 120, height: 44)),
            node("1", role: "AXCheckBox", frame: AxFrame(x: 20, y: 80, width: 60, height: 60)),
        ]))
        XCTAssertEqual(result.verdict, .pass, "全部达标且覆盖率满，才允许 pass: \(result.findings)")
        XCTAssertTrue(result.findings.isEmpty)
    }

    func testUnknownRoleNeverGetsHitTargetComplaint() {
        // 一个 8×8 的 AXGroup 本来就不可点，报它"目标太小"是拿结构冒充可用性。
        let result = UILayoutAudit.audit(snapshot([
            node("0", role: "AXGroup", frame: AxFrame(x: 5, y: 5, width: 8, height: 8), title: "容器"),
            node("1", role: "AXButton", frame: AxFrame(x: 20, y: 20, width: 88, height: 44)),
        ]))
        XCTAssertFalse(result.findings.contains { $0.rule == "tinyHitTarget" && $0.elementPath == "0" })
    }

    // MARK: - 阻塞级问题

    func testZeroSizedInteractiveIsBlocking() {
        let result = UILayoutAudit.audit(snapshot([
            node("0", role: "AXButton", frame: AxFrame(x: 20, y: 20, width: 0, height: 44)),
        ]))
        XCTAssertEqual(result.verdict, .blocking)
        guard let finding = result.findings.first(where: { $0.rule == "zeroSizedInteractive" }) else {
            return XCTFail("零尺寸的可交互元素必须被点名: \(result.findings)")
        }
        XCTAssertEqual(finding.severity, .blocking)
        XCTAssertEqual(finding.measured["width"], 0)
    }

    func testCenterOutsideWindowIsBlocking() {
        let result = UILayoutAudit.audit(snapshot(
            [node("0", role: "AXButton", frame: AxFrame(x: 5000, y: 5000, width: 120, height: 44))],
            window: AxFrame(x: 0, y: 0, width: 800, height: 600)
        ))
        XCTAssertEqual(result.verdict, .blocking)
        XCTAssertTrue(result.findings.contains { $0.rule == "outsideWindow" })
    }

    func testClippedButReachableIsAdvisoryNotBlocking() {
        let result = UILayoutAudit.audit(snapshot(
            [node("0", role: "AXButton", frame: AxFrame(x: 700, y: 100, width: 150, height: 44))],
            window: AxFrame(x: 0, y: 0, width: 800, height: 600)
        ))
        // 中心还在窗口内：能点到，只是被裁了。判成 blocking 就是把"不漂亮"说成"用不了"。
        XCTAssertNotEqual(result.verdict, .blocking)
        guard let finding = result.findings.first(where: { $0.rule == "clippedByWindow" }) else {
            return XCTFail("被裁切的元素应给出 advisory: \(result.findings)")
        }
        XCTAssertEqual(finding.severity, .advisory)
        XCTAssertLessThan(finding.measured["visibleRatio"] ?? 1, 1)
    }

    func testMissingWindowNeverInventsOutOfBoundsFindings() {
        let result = UILayoutAudit.audit(snapshot(
            [node("0", role: "AXButton", frame: AxFrame(x: 5000, y: 5000, width: 120, height: 44))],
            window: nil
        ))
        XCTAssertFalse(result.findings.contains { $0.rule == "outsideWindow" }, "不知道窗口在哪，就无权判越界")
        XCTAssertFalse(result.findings.contains { $0.rule == "clippedByWindow" })
    }

    // MARK: - 诚实性：没量到就不许"通过"

    func testUnreadGeometryDropsVerdictToInsufficient() {
        let result = UILayoutAudit.audit(snapshot([
            node("0", role: "AXButton", frame: AxFrame(x: 20, y: 20, width: 120, height: 44)),
            unread("1", role: "AXCheckBox"),
        ]))
        XCTAssertNotEqual(result.verdict, .pass, "有一条几何没读到，结论不能是 pass")
        XCTAssertEqual(result.coverage.unread, 1)
        XCTAssertTrue(result.findings.contains { $0.rule == "geometryUnread" })
    }

    func testLowCoverageFromAbsentGeometryIsInsufficient() {
        // 20 个容器类元素明确不给几何 + 1 个量到的按钮：覆盖率 1/21。
        var nodes: [AxGeometryNode] = [node("0", role: "AXButton", frame: AxFrame(x: 20, y: 20, width: 120, height: 44))]
        for index in 1 ... 20 { nodes.append(node("\(index)", role: "AXGroup", frame: nil)) }
        let result = UILayoutAudit.audit(snapshot(nodes))
        XCTAssertEqual(result.verdict, .insufficient)
        XCTAssertLessThan(result.coverage.ratio, UILayoutAudit.passCoverageRatio)
    }

    func testEmptyTreeIsReportedAsUnmeasuredNotClean() {
        let result = UILayoutAudit.audit(snapshot([]))
        XCTAssertEqual(result.verdict, .insufficient, "一棵空树不是干净，是没量到东西")
        XCTAssertEqual(result.coverage.total, 0)
    }

    func testNoInteractiveElementsIsAdvisoryNotBlocking() {
        let result = UILayoutAudit.audit(snapshot([
            node("0", role: "AXStaticText", frame: AxFrame(x: 20, y: 20, width: 200, height: 20)),
        ]))
        guard let finding = result.findings.first(where: { $0.rule == "noInteractiveElements" }) else {
            return XCTFail("纯静态界面要提示，但不能武断判死")
        }
        XCTAssertEqual(finding.severity, .advisory)
    }

    // MARK: - 重叠与截断

    func testSeverelyOverlappingTargetsAreAdvisory() {
        let result = UILayoutAudit.audit(snapshot([
            node("0", role: "AXButton", frame: AxFrame(x: 20, y: 20, width: 120, height: 44)),
            node("1", role: "AXCheckBox", frame: AxFrame(x: 24, y: 24, width: 112, height: 40)),
        ]))
        XCTAssertTrue(
            result.findings.contains { $0.rule == "overlappingInteractiveTargets" },
            "近乎重合的两个目标必须被指出来: \(result.findings.map(\.rule))"
        )
    }

    func testTruncatedOverlapScanCannotClaimClean() {
        var nodes: [AxGeometryNode] = []
        for index in 0 ... UILayoutAudit.overlapPairBudget {
            nodes.append(node("\(index)", role: "AXButton", frame: AxFrame(x: Double(index) * 200, y: 20, width: 120, height: 44)))
        }
        let result = UILayoutAudit.audit(snapshot(nodes))
        XCTAssertTrue(result.overlapScanTruncated, "超过配对预算就该如实说自己没扫完")
        XCTAssertNotEqual(result.verdict, .pass, "没扫完的扫描不能换来一句通过")
        XCTAssertTrue(result.findings.contains { $0.rule == "overlapScanTruncated" })
    }

    // MARK: - 角色归一与阈值

    func testRoleNormalizationAcceptsAllSpellings() {
        for raw in ["AXButton", "button", "Button", "  AXButton  "] {
            XCTAssertEqual(UILayoutAudit.normalizedRole(raw), "button", "\(raw) 应归一到 button")
            XCTAssertTrue(UILayoutAudit.isInteractive(AxGeometryNode(path: "0", role: raw, geometry: .absent)))
        }
        XCTAssertFalse(UILayoutAudit.isInteractive(AxGeometryNode(path: "0", role: "AXStaticText", geometry: .absent)))
    }

    func testCustomHitTargetThresholdIsHonored() {
        let nodes = [node("0", role: "AXButton", frame: AxFrame(x: 20, y: 20, width: 30, height: 30))]
        XCTAssertEqual(UILayoutAudit.audit(snapshot(nodes), minHitTargetPt: 28).verdict, .pass)
        XCTAssertEqual(UILayoutAudit.audit(snapshot(nodes), minHitTargetPt: 44).verdict, .advisory)
    }

    // MARK: - 三态几何读数

    func testGeometryReadKeepsAbsentAndUnreadApart() {
        // "应用说不给" 与 "我们没读到" 必须编码成不同值：混成一个 nil，
        // 审计就会把没看到的算成没毛病。
        let data = try! JSONEncoder().encode([
            AxGeometryNode(path: "0", role: "AXGroup", geometry: .absent),
            AxGeometryNode(path: "1", role: "AXButton", geometry: .unread(reason: "timeout")),
            AxGeometryNode(path: "2", role: "AXButton", geometry: .measured(AxFrame(x: 0, y: 0, width: 10, height: 10))),
        ])
        let decoded = try! JSONDecoder().decode([AxGeometryNode].self, from: data)
        XCTAssertEqual(decoded[0].geometry, .absent)
        XCTAssertEqual(decoded[1].geometry, .unread(reason: "timeout"))
        XCTAssertEqual(decoded[2].geometry.frame?.width, 10)
    }

    // MARK: - 引擎接线（走 ScriptedChannel，不碰真实 AX）

    func testEngineAuditUiReturnsVerdictAndCoverage() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.fallbackGeometry = AxGeometrySnapshot(
            nodes: [
                AxGeometryNode(
                    path: "0", role: "AXButton",
                    geometry: .measured(AxFrame(x: 4000, y: 4000, width: 88, height: 44))
                ),
            ],
            window: AxFrame(x: 0, y: 0, width: 640, height: 480),
            latencyMs: 3
        )
        let core = EngineCore(channel: channel, evidenceStore: nil, approvalGate: nil)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)

        let payload = try core.auditUI(maxDepth: 6, minHitTargetPt: nil)
        XCTAssertEqual(payload["verdict"] as? String, "blocking")
        XCTAssertEqual(channel.geometryCallCount, 1)
        XCTAssertEqual(payload["windowKnown"] as? Bool, true)
        XCTAssertNotNil(payload["coverage"])
        XCTAssertNotNil(payload["findings"])
    }

    func testEngineAuditUiMapsChannelFailureInsteadOfReportingPass() throws {
        let channel = ScriptedChannel(fallbackTree: TestTrees.standard)
        channel.geometryResults = [
            .failure(.treeCaptureFailed(reason: "the 10.0s accessibility budget ran out"))
        ]
        let core = EngineCore(channel: channel, evidenceStore: nil, approvalGate: nil)
        _ = try core.attach(bundleId: "com.example.app", pid: nil)

        do {
            _ = try core.auditUI(maxDepth: 6, minHitTargetPt: nil)
            XCTFail("几何遍历失败必须抛出，不能返回一个看起来干净的审计")
        } catch let error as GPError {
            XCTAssertFalse(error.message.isEmpty)
        }
    }

    func testFrameGeometryMathMatchesScreenSemantics() {
        let window = AxFrame(x: 0, y: 0, width: 100, height: 100)
        XCTAssertTrue(AxFrame(x: 10, y: 10, width: 20, height: 20).contained(in: window))
        XCTAssertFalse(AxFrame(x: 90, y: 10, width: 20, height: 20).contained(in: window))
        XCTAssertTrue(AxFrame(x: 90, y: 10, width: 20, height: 20).centerInside(window))
        XCTAssertEqual(AxFrame(x: -50, y: 0, width: 50, height: 10).intersectionArea(with: window), 0)
        XCTAssertEqual(AxFrame(x: 0, y: 0, width: 10, height: 0).area, 0)
    }
}
