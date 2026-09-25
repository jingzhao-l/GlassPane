import XCTest
@testable import GlassPaneEngine

/// P1 面板人读面缺席渲染：面板详情面必须对“缺失/未测量”的六通道显式说出缺席，
/// 而不是让卡片直接消失（“没测到长得像没事”）。判定与缺席理由集中在
/// `PanelChannelFields`（纯函数），这里的用例钉住“缺席时出不可用标记”与
/// “已测时出数值”两种形状。
final class PanelChannelFieldsTests: XCTestCase {

    /// 六条可选通道缺席时：每条都给了可读理由，且一档里 0 个已测。
    func testAllChannelsAbsentRenderUnmeasuredMarkers() {
        let signals = Signals(act: .init(
            selector: Selector(role: "AXButton"),
            action: .press,
            actConfirmed: true
        ))

        XCTAssertEqual(PanelChannelFields.measuredCount(in: signals), 0, "全缺席时应 0 已测")
        XCTAssertEqual(PanelChannelFields.totalCount, 6, "六条可选通道")
        let reasons = PanelChannelFields.unmeasuredReasons(in: signals)
        XCTAssertEqual(reasons.count, 6, "缺席的每条通道都要说出理由")
        for entry in PanelChannelFields.all {
            XCTAssertTrue(
                reasons.contains(entry.unmeasuredReason),
                "通道 \(entry.key) 的缺席理由应出现在不可用标记里；实测缺席理由：\(reasons)"
            )
        }
    }

    /// 六条通道全部测到：不应再报任何缺席理由，已测数应等于总数。
    func testAllChannelsMeasuredNeverRenderAnAbsenceMarker() {
        let signals = Signals(
            act: .init(selector: Selector(role: "AXButton"), action: .press, actConfirmed: true),
            axEvent: .init(
                treeDigestBefore: String(repeating: "a", count: 32),
                treeDigestAfter: String(repeating: "b", count: 32),
                nodeCount: 3, axChanged: true, latencyMs: 9
            ),
            handlerProbe: .init(probeVersion: "1", hitCount: 1, handlers: [], lateCount: 0),
            stateDiff: .init(source: .z1Macro, changed: true, entries: []),
            pixelDiff: .init(changedPixelRatio: 0.25, bounds: nil, windowId: 12),
            responsiveness: .init(responsive: true, pingMs: 3),
            crash: .init(processAliveBefore: true, processAliveAfter: true)
        )

        XCTAssertEqual(PanelChannelFields.measuredCount(in: signals), PanelChannelFields.totalCount)
        XCTAssertTrue(
            PanelChannelFields.unmeasuredReasons(in: signals).isEmpty,
            "全测到的档案不应渲染缺席标记"
        )
    }

    /// 已测数应只计真测到的通道，缺席判定与具体通道一一对应。
    func testMeasuredCountTracksOnlyTheChannelsActuallyPresent() {
        let signals = Signals(
            act: .init(selector: Selector(role: "AXButton"), action: .press, actConfirmed: true),
            stateDiff: .init(source: .z2Mirror, changed: false, entries: []),
            crash: .init(processAliveBefore: true, processAliveAfter: true)
        )

        XCTAssertEqual(PanelChannelFields.measuredCount(in: signals), 2)
        let reasons = PanelChannelFields.unmeasuredReasons(in: signals)
        // 剩下的四条（axEvent/pixelDiff/handlerProbe/responsiveness）应缺席。
        XCTAssertEqual(reasons.count, 4, "缺席通道应正好是 6 - 2 = 4 条")
        XCTAssertFalse(reasons.contains(PanelChannelFields.reason(for: "stateDiff") ?? ""))
        XCTAssertFalse(reasons.contains(PanelChannelFields.reason(for: "crash") ?? ""))
    }
}