import XCTest
@testable import GlassPaneEngine
@testable import glasspane_settings

/// 归因卡"人机污染"那一行的措辞（纯函数，视图只负责把 pack 的两个字段递进来）。
///
/// `attribution.contaminated` 是引擎给出的**结论**，而结论是怎么来的——是量到了
/// 本人输入，还是因为没人看守这个窗口才保守判污——冻结 schema 里没有第三个字段，
/// 只有 `circuitBreaker.reason` 上那两个 `input-contamination-*` 标签还记着。
/// 从前这一行对 true 一律印"期间检测到本人操作"：面板替引擎声称了一次引擎刻意
/// 拒绝做出的测量（本仓库的第一诚实不变量）。
final class EvidenceAttributionCopyTests: XCTestCase {

    private let notMonitored = "input-contamination-not-monitored: the CGEvent input tap could not be created"
    private let monitorLost = "input-contamination-monitor-lost: tap disabled mid-window"

    /// 无人看守 + 保守判污：必须说"未监测"，不是"检测到本人操作"。
    func testConservativeContaminationWithoutAMonitorIsNeverClaimedAsDetected() {
        for reason in [notMonitored, monitorLost] {
            let text = EvidenceCopy.contamination(contaminated: true, breakerReason: reason)
            XCTAssertTrue(text.contains("未监测"), "\(reason) → \(text)")
            XCTAssertFalse(text.contains("检测到"), "没有监视就不许说检测到：\(text)")
        }
    }

    /// 真看守过又判污：这才是"检测到本人操作"那句的时刻。
    func testDetectedInputIsOnlyClaimedWhenTheWindowWasWatched() {
        XCTAssertEqual(
            EvidenceCopy.contamination(contaminated: true, breakerReason: nil),
            "期间检测到本人操作"
        )
        XCTAssertEqual(
            EvidenceCopy.contamination(contaminated: true, breakerReason: "performance|handler-not-run"),
            "期间检测到本人操作", "别的成因不得被读成\"没人看守\""
        )
    }

    /// 判净的一侧同理：无人看守时的 false 出自 `--unattended-window` 这类声明。
    func testCleanVerdictWithoutAMonitorSaysItIsADeclaration() {
        let text = EvidenceCopy.contamination(contaminated: false, breakerReason: notMonitored)
        XCTAssertTrue(text.contains("未监测"), text)
        XCTAssertTrue(text.contains("声明"), text)
        XCTAssertEqual(
            EvidenceCopy.contamination(contaminated: false, breakerReason: nil),
            "未检测到本人操作"
        )
    }

    /// 判据只认那两个标签：把标签换个写法就要重新对齐（与 EngineCore 同源）。
    func testWatchedJudgementKeysOffTheEngineLabelsOnly() {
        XCTAssertTrue(EvidenceCopy.wasWatched(breakerReason: nil))
        XCTAssertFalse(EvidenceCopy.wasWatched(breakerReason: notMonitored))
        XCTAssertFalse(EvidenceCopy.wasWatched(breakerReason: "x; \(monitorLost); y"))
        XCTAssertTrue(EvidenceCopy.wasWatched(breakerReason: "input-monitoring-granted"))
        XCTAssertEqual(EvidenceCopy.monitorAbsenceLabels.count, 2)
    }

    /// 端到端一节：pack 里那个标签确实是引擎写的形状，卡片读的是它。
    func testPackFieldsFeedTheWordingExactly() throws {
        let pack = EvidencePack(
            operationId: "OP_TEST",
            createdAt: "2026-09-23T00:00:00.000Z",
            attribution: Attribution(level: .weak, contaminated: true),
            circuitBreaker: CircuitBreaker(level: .normal, reason: notMonitored),
            signals: Signals(
                act: ActSignal(selector: Selector(role: "AXButton"), action: .press, actConfirmed: true)
            )
        )
        XCTAssertTrue(pack.attribution.contaminated)
        XCTAssertEqual(
            EvidenceCopy.contamination(
                contaminated: pack.attribution.contaminated,
                breakerReason: pack.circuitBreaker.reason
            ),
            "未监测（无人看守该窗口，按保守判污）"
        )
    }
}
