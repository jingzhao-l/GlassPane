import XCTest
@testable import GlassPaneEngine

/// A2: classifier full-branch coverage — every decidable class plus both
/// INCONCLUSIVE families and NO_ANOMALY (5.8 §5.3, P0 spec §7.1).
final class ClassifierTests: XCTestCase {

    private func makePack(
        actConfirmed: Bool = true,
        axChanged: Bool? = true,
        pixelRatio: Double? = 0.1,
        responsive: Bool? = true,
        aliveBefore: Bool = true,
        aliveAfter: Bool = true,
        breakerLevel: CircuitBreakerLevel = .normal,
        assertionPassed: Bool? = nil
    ) -> EvidencePack {
        let selector = Selector(role: "AXButton", title: "Submit")
        let axEvent: AxEventSignal?
        if let axChanged {
            axEvent = AxEventSignal(
                treeDigestBefore: "aa", treeDigestAfter: axChanged ? "bb" : "aa",
                nodeCount: 10, axChanged: axChanged, latencyMs: 5
            )
        } else {
            axEvent = nil
        }
        let pixelDiff: PixelDiffSignal?
        if let pixelRatio {
            pixelDiff = PixelDiffSignal(
                changedPixelRatio: pixelRatio,
                bounds: pixelRatio > 0 ? Bounds(x: 1, y: 1, width: 2, height: 2) : nil,
                windowId: 12
            )
        } else {
            pixelDiff = nil
        }
        let assertion: Assertion?
        if let assertionPassed {
            assertion = Assertion(
                selector: selector, property: .enabled,
                expected: .bool(true), actual: .bool(assertionPassed),
                passed: assertionPassed
            )
        } else {
            assertion = nil
        }
        return EvidencePack(
            operationId: "op_0123456789ABCDEFGHJKMNPQRS",
            createdAt: "2026-09-14T12:00:00.000Z",
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: breakerLevel),
            signals: Signals(
                act: ActSignal(selector: selector, action: .press, actConfirmed: actConfirmed),
                axEvent: axEvent,
                pixelDiff: pixelDiff,
                responsiveness: responsive.map {
                    ResponsivenessSignal(responsive: $0, pingMs: 3)
                },
                crash: CrashSignal(processAliveBefore: aliveBefore, processAliveAfter: aliveAfter)
            ),
            assertion: assertion
        )
    }

    private func assertClass(
        _ expected: DiagnosisClass,
        actConfirmed: Bool = true,
        axChanged: Bool? = true,
        pixelRatio: Double? = 0.1,
        responsive: Bool? = true,
        aliveBefore: Bool = true,
        aliveAfter: Bool = true,
        breakerLevel: CircuitBreakerLevel = .normal,
        assertionPassed: Bool? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let pack = makePack(
            actConfirmed: actConfirmed, axChanged: axChanged, pixelRatio: pixelRatio,
            responsive: responsive, aliveBefore: aliveBefore, aliveAfter: aliveAfter,
            breakerLevel: breakerLevel, assertionPassed: assertionPassed
        )
        let (diagnosisClass, report) = Classifier.classify(pack)
        XCTAssertEqual(diagnosisClass, expected, file: file, line: line)
        for field in [report.path, report.anomaly, report.evidence, report.next] {
            XCTAssertFalse(field.isEmpty, file: file, line: line)
        }
    }

    func testT1ProcessExited() {
        assertClass(.t1, aliveBefore: true, aliveAfter: false)
    }

    func testT0ChannelFault() {
        assertClass(.t0, breakerLevel: .channelFault)
    }

    func testT2Unresponsive() {
        assertClass(.t2, responsive: false)
    }

    func testActRejectedYieldsInconclusive() {
        assertClass(.inconclusive, actConfirmed: false)
    }

    func testMissingAxSignalYieldsInconclusive() {
        assertClass(.inconclusive, axChanged: nil)
    }

    func testTreeChangedWithoutPixelSignalYieldsInconclusive() {
        // P0 spec §9: screen-recording denied makes T6 undecidable.
        assertClass(.inconclusive, axChanged: true, pixelRatio: nil)
    }

    func testT6TreeChangedPixelsDidNot() {
        assertClass(.t6, axChanged: true, pixelRatio: 0)
    }

    func testNoAnomalyTreeAndPixelsChanged() {
        assertClass(.noAnomaly, axChanged: true, pixelRatio: 0.05)
    }

    func testAssertionFailedWithNormalSignalsYieldsInconclusive() {
        assertClass(.inconclusive, axChanged: true, pixelRatio: 0.05, assertionPassed: false)
    }

    func testPixelsChangedTreeDidNotYieldsInconclusive() {
        assertClass(.inconclusive, axChanged: false, pixelRatio: 0.05)
    }

    func testT3DeadClick() {
        assertClass(.t3, axChanged: false, pixelRatio: 0)
    }

    func testT3RemainsDecidableWithoutPixelSignal() {
        // P0 spec §9: T3 relies on tree + operation confirmation only.
        assertClass(.t3, axChanged: false, pixelRatio: nil)
    }

    func testT3WithFailedAssertion() {
        assertClass(.t3, axChanged: false, pixelRatio: 0, assertionPassed: false)
    }

    func testReportPathDescribesTheSignalPipeline() {
        let (_, report) = Classifier.classify(makePack())
        XCTAssertEqual(report.path, "act.press -> ax-confirm -> tree-digest -> pixel-diff")
    }
}
