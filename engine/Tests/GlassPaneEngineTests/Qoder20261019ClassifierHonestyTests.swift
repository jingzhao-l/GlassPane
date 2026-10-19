import XCTest
@testable import GlassPaneEngine

/// Evidence-honesty defects in `Classifier`'s probe-signal branch (P6 spec v6.0 §3.2).
///
/// `Classifier.swift:75` folded an **unmeasured** pixel channel into "pixels did not
/// change" (`(pack.signals.pixelDiff?.changedPixelRatio ?? 0) > 0`) and that boolean
/// then fed T4, T5 and T7. The same file refuses exactly this inference twice:
/// `stateChanged` is tri-state (`pack.signals.stateDiff.map { $0.changed }`) and T4
/// demands measured-false, and the black-box T6 path guards `let pixelDiff … else
/// inconclusive`. `pixelClause(pack)` even has the wording for the缺席 channel
/// ("pixels not measured") — while the judgement next to it used it as a negative
/// measurement. Consequence: a pack whose pixel channel never answered could be
/// classified as a SwiftUI dependency loss (T5), and the report's own anomaly line
/// then *quoted* `pixels not measured` as if it were the evidence.
///
/// Fixtures are shaped as real probe-window packs (handlerProbe + stateDiff +
/// axEvent, the shape `engine/.p6_smoke.py` archives), never invented ones. The
/// second half of every pair is the control that keeps the fix from simply
/// disabling the rule.
final class Qoder20261019ClassifierHonestyTests: XCTestCase {

    private let selector = Selector(role: "AXButton", title: "Submit")

    /// One pack with every channel the probe-signal branches read, each of which can
    /// be measured / unmeasured independently — that independence is the whole defect.
    private func pack(
        hitCount: Int,
        stateChanged: Bool?,
        axChanged: Bool,
        pixelRatio: Double?
    ) -> EvidencePack {
        EvidencePack(
            operationId: "op_0123456789ABCDEFGHJKMNPQRS",
            createdAt: "2026-10-19T12:00:00.000Z",
            attribution: Attribution(level: .strong, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(selector: selector, action: .press, actConfirmed: true),
                axEvent: AxEventSignal(
                    treeDigestBefore: "aa", treeDigestAfter: axChanged ? "bb" : "aa",
                    nodeCount: 12, axChanged: axChanged, latencyMs: 4
                ),
                handlerProbe: HandlerProbeSignal(
                    probeVersion: "z5-0.1.0",
                    hitCount: hitCount,
                    handlers: hitCount > 0 ? [HandlerRef(file: "ViewModel.swift", line: 88)] : [],
                    lateCount: 0
                ),
                stateDiff: stateChanged.map { changed in
                    StateDiffSignal(
                        source: .z2Mirror,
                        changed: changed,
                        entries: [StateEntry(key: "count", before: changed ? "4" : "4",
                                             after: changed ? "5" : "4")]
                    )
                },
                pixelDiff: pixelRatio.map { ratio in
                    PixelDiffSignal(
                        changedPixelRatio: ratio,
                        bounds: ratio > 0 ? Bounds(x: 0, y: 0, width: 4, height: 4) : nil,
                        windowId: 12
                    )
                },
                responsiveness: ResponsivenessSignal(responsive: true, pingMs: 3),
                crash: CrashSignal(processAliveBefore: true, processAliveAfter: true)
            )
        )
    }

    // MARK: - T5: the branch the defect was live on

    /// A pixel channel that never answered is not "pixels did not change". With
    /// handler hits + measured state change + silent AX, T5 (SwiftUI dependency loss)
    /// may only be claimed when the pixel channel actually measured no change.
    func testUnmeasuredPixelChannelDoesNotCarryTheDependencyLossVerdict() {
        let (diagnosisClass, report) = Classifier.classify(
            pack(hitCount: 2, stateChanged: true, axChanged: false, pixelRatio: nil)
        )
        XCTAssertNotEqual(
            diagnosisClass, .t5,
            "T5 was claimed on a pixel channel that never answered: \(report.anomaly)"
        )
        XCTAssertNotEqual(diagnosisClass, .t4, "same fold, other branch")
        // And the withheld verdict must say *why* it is withheld, in the file's own
        // wording for an unmeasured pixel channel — not pretend another channel decided.
        XCTAssertEqual(diagnosisClass, .inconclusive)
        XCTAssertTrue(
            report.anomaly.contains("pixels not measured"),
            "the report must name the channel it could not use: \(report.anomaly)"
        )
    }

    /// The control that keeps the fix from being "disable T5": the identical pack with
    /// a *measured* zero pixel change still lands on T5.
    func testMeasuredZeroPixelChangeStillYieldsDependencyLoss() {
        let (diagnosisClass, report) = Classifier.classify(
            pack(hitCount: 2, stateChanged: true, axChanged: false, pixelRatio: 0)
        )
        XCTAssertEqual(diagnosisClass, .t5, report.anomaly)
        XCTAssertTrue(report.anomaly.contains("pixels unchanged"), report.anomaly)
    }

    /// A measured *changed* pixel channel must not be swallowed either: the branch
    /// needs "pixels did not change", so a measurement that says they did rules T5 out
    /// (and the view channel followed, which is T7's shape).
    func testMeasuredPixelChangeIsNotReadAsSilence() {
        let (diagnosisClass, _) = Classifier.classify(
            pack(hitCount: 2, stateChanged: true, axChanged: false, pixelRatio: 0.05)
        )
        XCTAssertNotEqual(diagnosisClass, .t5)
    }

    // MARK: - T4: same fold, the logic-bug branch

    func testUnmeasuredPixelChannelDoesNotCarryTheLogicBugVerdict() {
        let (diagnosisClass, report) = Classifier.classify(
            pack(hitCount: 3, stateChanged: false, axChanged: false, pixelRatio: nil)
        )
        XCTAssertNotEqual(
            diagnosisClass, .t4,
            "T4 claims \"state and AX tree silent, pixels not measured\": \(report.anomaly)"
        )
    }

    func testMeasuredSilentChannelsStillYieldTheLogicBug() {
        let (diagnosisClass, report) = Classifier.classify(
            pack(hitCount: 3, stateChanged: false, axChanged: false, pixelRatio: 0)
        )
        XCTAssertEqual(diagnosisClass, .t4, report.anomaly)
    }

    // MARK: - T7: the branch that needs "pixels DID change"

    /// T7 is decided by a *measured positive* on either view channel, so an unmeasured
    /// pixel channel does not withhold it when the tree moved — and a nil pixel channel
    /// alone must not be read as the positive either.
    func testT7StillFiresOnMeasuredTreeMovement() {
        let (diagnosisClass, report) = Classifier.classify(
            pack(hitCount: 2, stateChanged: false, axChanged: true, pixelRatio: nil)
        )
        XCTAssertEqual(diagnosisClass, .t7, report.anomaly)
    }

    func testT7IsNotFiredOnAnUnmeasuredPixelChannel() {
        let (diagnosisClass, report) = Classifier.classify(
            pack(hitCount: 2, stateChanged: false, axChanged: false, pixelRatio: nil)
        )
        XCTAssertNotEqual(diagnosisClass, .t7, report.anomaly)
    }

    /// Control for the pair above: a measured pixel change with silent state really is
    /// the decoupling shape.
    func testT7FiresOnMeasuredPixelChangeWithSilentState() {
        let (diagnosisClass, _) = Classifier.classify(
            pack(hitCount: 2, stateChanged: false, axChanged: false, pixelRatio: 0.05)
        )
        XCTAssertEqual(diagnosisClass, .t7)
    }

    // MARK: - the branches that never read the pixel channel

    /// T8 reads `stateChanged` and `lateCount` only; withholding on the pixel channel
    /// must not reach it (this is the control that keeps the fix from being a blanket
    /// "no probe verdicts while pixels are unmeasured").
    func testAsyncTimingBranchIsUntouchedByThePixelHonesty() {
        let late = EvidencePack(
            operationId: "op_0123456789ABCDEFGHJKMNPQRS",
            createdAt: "2026-10-19T12:00:00.000Z",
            attribution: Attribution(level: .strong, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(selector: selector, action: .press, actConfirmed: true),
                axEvent: AxEventSignal(
                    treeDigestBefore: "aa", treeDigestAfter: "aa",
                    nodeCount: 12, axChanged: false, latencyMs: 4
                ),
                handlerProbe: HandlerProbeSignal(
                    probeVersion: "z5-0.1.0", hitCount: 0, handlers: [], lateCount: 2
                ),
                stateDiff: StateDiffSignal(
                    source: .z2Mirror, changed: false,
                    entries: [StateEntry(key: "count", before: "4", after: "4")]
                )
            )
        )
        let (diagnosisClass, report) = Classifier.classify(late)
        XCTAssertEqual(diagnosisClass, .t8, report.anomaly)
    }

    /// The black-box (no probe) paths are byte-for-byte unchanged by this fix, including
    /// the one that already refuses to infer from a missing pixel channel.
    func testBlackBoxBranchesKeepTheirShape() {
        let probeless = EvidencePack(
            operationId: "op_0123456789ABCDEFGHJKMNPQRS",
            createdAt: "2026-10-19T12:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(selector: selector, action: .press, actConfirmed: true),
                axEvent: AxEventSignal(
                    treeDigestBefore: "aa", treeDigestAfter: "bb",
                    nodeCount: 12, axChanged: true, latencyMs: 4
                ),
                responsiveness: ResponsivenessSignal(responsive: true, pingMs: 3),
                crash: CrashSignal(processAliveBefore: true, processAliveAfter: true)
            )
        )
        XCTAssertEqual(Classifier.classify(probeless).class, .inconclusive)

        let deadClick = EvidencePack(
            operationId: "op_0123456789ABCDEFGHJKMNPQRS",
            createdAt: "2026-10-19T12:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(selector: selector, action: .press, actConfirmed: true),
                axEvent: AxEventSignal(
                    treeDigestBefore: "aa", treeDigestAfter: "aa",
                    nodeCount: 12, axChanged: false, latencyMs: 4
                ),
                pixelDiff: PixelDiffSignal(changedPixelRatio: 0, bounds: nil, windowId: 12),
                responsiveness: ResponsivenessSignal(responsive: true, pingMs: 3),
                crash: CrashSignal(processAliveBefore: true, processAliveAfter: true)
            )
        )
        XCTAssertEqual(Classifier.classify(deadClick).class, .t3)
    }
}
