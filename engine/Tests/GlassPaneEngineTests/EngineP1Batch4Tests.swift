import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// P1 batch 4 (spec v1.3 §12): evidence review UX — the deterministic
/// report renderer (HTML/Markdown goldens,缺省容错, injection escaping) and
/// the GP_E_NO_EVIDENCE lookup contract. All pure logic; no GUI permission.
final class EngineP1Batch4Tests: XCTestCase {

    private static let fixtureOperationId = "op_0123456789ABCDEFGHJKMNPQRS"
    private static let fixtureCreatedAt = "2026-09-16T04:00:00.000Z"

    // MARK: - Fixtures

    /// Fully populated pack: every optional signal, an assertion, a
    /// diagnosis report and a degraded circuit breaker with a reason.
    private static func fullPack() -> EvidencePack {
        EvidencePack(
            operationId: fixtureOperationId,
            createdAt: fixtureCreatedAt,
            attribution: Attribution(level: .soft, contaminated: true),
            circuitBreaker: CircuitBreaker(
                level: .degraded,
                reason: "performance-act-latency-over-budget: 12345ms > 10000ms"
            ),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: "Submit", identifier: "submit-button"),
                    action: .press,
                    actConfirmed: true
                ),
                axEvent: AxEventSignal(
                    treeDigestBefore: String(repeating: "a", count: 32),
                    treeDigestAfter: String(repeating: "b", count: 32),
                    nodeCount: 42,
                    axChanged: true,
                    latencyMs: 9
                ),
                pixelDiff: PixelDiffSignal(
                    changedPixelRatio: 0.25,
                    bounds: Bounds(x: 0, y: 0, width: 32, height: 32),
                    windowId: 12
                ),
                responsiveness: ResponsivenessSignal(responsive: true, pingMs: 3),
                crash: CrashSignal(processAliveBefore: true, processAliveAfter: true)
            ),
            assertion: Assertion(
                selector: Selector(role: "AXButton", title: "Submit"),
                property: .title,
                expected: .string("Submitted"),
                actual: .string("Submit"),
                passed: false
            ),
            diagnosis: Diagnosis(
                class: .t3,
                report: DiagnosisReport(
                    path: "submit flow: press Submit → title unchanged",
                    anomaly: "expected retitle after press; title stayed 'Submit'",
                    evidence: "axEvent.changed=true, nodeCount=42; assertion title expected=Submitted actual=Submit",
                    next: "check the button's action wiring or re-run assert after settle"
                )
            )
        )
    }

    /// Minimal pack: only the required fields, a rejected act, normal breaker.
    private static func minimalPack() -> EvidencePack {
        EvidencePack(
            operationId: fixtureOperationId,
            createdAt: fixtureCreatedAt,
            attribution: Attribution(level: .weak, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton"),
                    action: .confirm,
                    actConfirmed: false
                )
            )
        )
    }

    /// Pack whose pack-owned strings carry HTML metacharacters (injection).
    private static func injectionPack() -> EvidencePack {
        EvidencePack(
            operationId: fixtureOperationId,
            createdAt: fixtureCreatedAt,
            attribution: Attribution(level: .strong, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal, reason: "a&b\"c'd<e>"),
            signals: Signals(
                act: ActSignal(
                    selector: Selector(role: "AXButton", title: "<script>alert(\"x&y\")</script>"),
                    action: .press,
                    actConfirmed: true
                )
            ),
            diagnosis: Diagnosis(
                class: .inconclusive,
                report: DiagnosisReport(
                    path: "p <q> & \"r\" 's'",
                    anomaly: "a<b",
                    evidence: "c&d",
                    next: "e>f"
                )
            )
        )
    }

    // MARK: - P1-D1: determinism & four sections

    func testRenderMarkdownGolden() {
        let markdown = EvidenceReportGenerator.renderMarkdown(
            pack: Self.fullPack(), diagnostics: nil
        )
        XCTAssertTrue(markdown.contains("# \(Self.fixtureOperationId) · T3 · degraded"))
        XCTAssertTrue(markdown.contains("**operationId**: \(Self.fixtureOperationId)"))
        XCTAssertTrue(markdown.contains("**createdAt**: \(Self.fixtureCreatedAt)"))
        XCTAssertTrue(markdown.contains("## PATH"))
        XCTAssertTrue(markdown.contains("## ANOMALY"))
        XCTAssertTrue(markdown.contains("## EVIDENCE"))
        XCTAssertTrue(markdown.contains("## NEXT"))
        XCTAssertTrue(markdown.contains("submit flow: press Submit → title unchanged"))
        XCTAssertTrue(markdown.contains("* attribution: soft | contaminated=true"))
        XCTAssertTrue(markdown.contains(
            "* circuitBreaker: level 1 (degraded) | reason: performance-act-latency-over-budget: 12345ms > 10000ms"
        ))
        XCTAssertTrue(markdown.contains(
            "* assert title on AXButton \"Submit\": expected=Submitted actual=Submit passed=false"
        ))
        XCTAssertTrue(markdown.contains("* act press AXButton \"Submit\" #submit-button: confirmed"))
        XCTAssertTrue(markdown.contains("* axEvent: changed=true nodes=42 latencyMs=9"))
        XCTAssertTrue(markdown.contains("* pixelDiff: changedRatio=0.25 windowId=12 bounds=0,0,32,32"))
        XCTAssertTrue(markdown.contains("* responsiveness: responsive=true pingMs=3"))
        XCTAssertTrue(markdown.contains("* crash: aliveBefore=true aliveAfter=true"))
    }

    func testRenderHTMLGolden() {
        let html = EvidenceReportGenerator.renderHTML(
            pack: Self.fullPack(), diagnostics: nil
        )
        XCTAssertTrue(html.contains("<div class=\"gp-evidence\" id=\"\(Self.fixtureOperationId)\">"))
        XCTAssertTrue(html.contains("<h1>\(Self.fixtureOperationId) · T3 · degraded</h1>"))
        XCTAssertTrue(html.contains("<dt>operationId</dt><dd>\(Self.fixtureOperationId)</dd>"))
        XCTAssertTrue(html.contains("<h2>PATH</h2>"))
        XCTAssertTrue(html.contains("<h2>ANOMALY</h2>"))
        XCTAssertTrue(html.contains("<h2>EVIDENCE</h2>"))
        XCTAssertTrue(html.contains("<h2>NEXT</h2>"))
        XCTAssertTrue(html.contains("<p>submit flow: press Submit → title unchanged</p>"))
        XCTAssertTrue(html.contains("attribution: soft | contaminated=true"))
        XCTAssertTrue(html.contains("circuitBreaker: level 1 (degraded)"))
        XCTAssertTrue(html.contains("</div>"))
    }

    func testRenderDeterminism() {
        let a = Self.fullPack()
        XCTAssertEqual(
            EvidenceReportGenerator.renderHTML(pack: a, diagnostics: nil),
            EvidenceReportGenerator.renderHTML(pack: a, diagnostics: nil)
        )
        XCTAssertEqual(
            EvidenceReportGenerator.renderMarkdown(pack: a, diagnostics: nil),
            EvidenceReportGenerator.renderMarkdown(pack: a, diagnostics: nil)
        )
        XCTAssertNotEqual(
            EvidenceReportGenerator.renderHTML(pack: a, diagnostics: nil),
            EvidenceReportGenerator.renderHTML(pack: Self.minimalPack(), diagnostics: nil)
        )
    }

    // MARK: - P1-D2: missing-field tolerance

    func testMissingFieldsRenderToPlaceholderWithoutThrowing() {
        let pack = Self.minimalPack()
        let markdown = EvidenceReportGenerator.renderMarkdown(pack: pack, diagnostics: nil)
        let html = EvidenceReportGenerator.renderHTML(pack: pack, diagnostics: nil)

        XCTAssertTrue(markdown.contains("## PATH"))
        XCTAssertTrue(markdown.contains("—"))
        XCTAssertTrue(markdown.contains("## EVIDENCE"))
        XCTAssertTrue(markdown.contains("## NEXT"))

        XCTAssertTrue(html.contains("<h2>ANOMALY</h2>"))
        XCTAssertTrue(html.contains("—"))
        // No assertion/axEvent/pixelDiff/responsiveness/crash lines.
        XCTAssertFalse(markdown.contains("* assert "))
        XCTAssertFalse(markdown.contains("* axEvent:"))
        XCTAssertFalse(markdown.contains("* pixelDiff:"))
    }

    func testReportTitleFallsBackToAssertionProperty() {
        let withAssertion = EvidencePack(
            operationId: Self.fixtureOperationId,
            createdAt: Self.fixtureCreatedAt,
            attribution: Attribution(level: .soft, contaminated: false),
            circuitBreaker: CircuitBreaker(level: .normal),
            signals: Signals(
                act: ActSignal(selector: Selector(role: "AXButton"), action: .press, actConfirmed: true)
            ),
            assertion: Assertion(
                selector: Selector(role: "AXButton"),
                property: .enabled,
                expected: .bool(true),
                actual: .bool(false),
                passed: false
            )
        )
        XCTAssertEqual(
            EvidenceReportGenerator.reportTitle(pack: withAssertion),
            "\(Self.fixtureOperationId) · enabled · normal"
        )
    }

    func testReportTitleFallsBackToAction() {
        let pack = Self.minimalPack()
        XCTAssertEqual(
            EvidenceReportGenerator.reportTitle(pack: pack),
            "\(Self.fixtureOperationId) · confirm · normal"
        )
    }

    func testDiagnosticsFallbackOnlyWhenReportAbsent() {
        let noReport = Self.minimalPack()
        let markdown = EvidenceReportGenerator.renderMarkdown(
            pack: noReport, diagnostics: "provisional text from the caller\nsecond line"
        )
        XCTAssertTrue(markdown.contains("## EVIDENCE"))
        XCTAssertTrue(markdown.contains("provisional text from the caller\nsecond line"))
        // PATH/ANOMALY/NEXT stay placeholder when there is no report.
        XCTAssertTrue(markdown.contains("## PATH\n\n—"))

        let withReport = Self.fullPack()
        let withReportMarkdown = EvidenceReportGenerator.renderMarkdown(
            pack: withReport, diagnostics: "provisional text from the caller"
        )
        XCTAssertTrue(withReportMarkdown.contains("axEvent.changed=true, nodeCount=42"))
        XCTAssertFalse(withReportMarkdown.contains("provisional text from the caller"))

        let html = EvidenceReportGenerator.renderHTML(
            pack: noReport, diagnostics: "provisional text from the caller"
        )
        XCTAssertTrue(html.contains("<pre>provisional text from the caller</pre>"))
    }

    // MARK: - P1-D1: HTML injection escaping

    func testHTMLDoesNotEmitUnescapedInjectedMarkup() {
        let html = EvidenceReportGenerator.renderHTML(
            pack: Self.injectionPack(), diagnostics: nil
        )
        // Raw metacharacters must never survive.
        XCTAssertFalse(html.contains("<script>"))
        XCTAssertFalse(html.contains("<q>"))
        XCTAssertFalse(html.contains("<b>"))
        // Escaped forms are present.
        XCTAssertTrue(html.contains("&lt;script&gt;"))
        XCTAssertTrue(html.contains("alert(&quot;x&amp;y&quot;)"))
        XCTAssertTrue(html.contains("a&amp;b&quot;c&#39;d&lt;e&gt;"))
        XCTAssertTrue(html.contains("p &lt;q&gt; &amp; &quot;r&quot; &#39;s&#39;"))
    }

    // MARK: - P1-D4: GP_E_NO_EVIDENCE lookup contract

    func testLastEvidenceUnknownOperationIdThrowsNoEvidence() throws {
        let core = EngineCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard), settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertThrowsGPError(.noEvidence) {
            _ = try core.lastEvidence(operationId: Self.fixtureOperationId)
        }
    }

    func testLastEvidenceEmptyHistoryThrowsNoEvidence() throws {
        let core = EngineCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard), settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertThrowsGPError(.noEvidence) {
            _ = try core.lastEvidence(operationId: nil)
        }
    }

    func testDiagnoseUnknownOperationStillThrowsNoOperation() throws {
        let core = EngineCore(channel: ScriptedChannel(fallbackTree: TestTrees.standard), settle: {})
        _ = try core.attach(bundleId: "com.example.app", pid: nil)
        XCTAssertThrowsGPError(.noOperation) {
            _ = try core.diagnose(operationId: Self.fixtureOperationId)
        }
    }
}