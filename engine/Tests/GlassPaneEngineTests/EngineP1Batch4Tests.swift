import XCTest
import CoreGraphics
@testable import GlassPaneEngine

/// P1 batch 4 (spec v1.3 §12): evidence review UX — the deterministic
/// report renderer (HTML/Markdown goldens,缺省容错, injection escaping) and
/// the GP_E_NO_EVIDENCE lookup contract. All pure logic; no GUI permission.
/// The `testSharedGolden*` cases are the cross-language half of §13.5: they
/// compare this renderer against `kernel/fixtures/report.ok-01.md` / `.html`,
/// the same files `mcp-shell/test/evidence-report.test.mjs` uses.
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
        // An absent assertion section renders no line at all: there is nothing to
        // report on an operation that made no assertion.
        XCTAssertFalse(markdown.contains("* assert "))
        // R6-09 changed what an absent *channel* renders. These two lines used to
        // read `XCTAssertFalse(contains("* axEvent:"))` and
        // `XCTAssertFalse(contains("* pixelDiff:"))`, which pinned the behaviour
        // this round removed: a channel that was never measured left no line, so
        // "the UI did not change" and "nothing was measured" produced the same
        // report. The tolerance claim of this case (nothing throws, the sections
        // still render) is unchanged; the channel lines are now required by name in
        // `testEveryAbsentChannelNamesItselfInOrder`.
        XCTAssertTrue(markdown.contains("* axEvent: not measured"), markdown)
        XCTAssertTrue(markdown.contains("* pixelDiff: not measured"), markdown)
        XCTAssertTrue(markdown.contains("* responsiveness: not measured"), markdown)
        XCTAssertTrue(markdown.contains("* crash: not measured"), markdown)
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

    // MARK: - Shared cross-language golden (spec v1.3 §12 P1-D1, §13.5)

    /// The pack behind `kernel/fixtures/report.ok-01.md` / `.html`: the P6
    /// probe fixture `evidence-pack.ok-03.json` with the same four overrides
    /// the TS suite applies. Both suites compare their own renderer against
    /// those two files, so the "same golden" claim in both renderer headers
    /// is checked rather than asserted.
    private static func goldenPack(latencyMs: Double = 1234.5678) throws -> EvidencePack {
        var pack = try EvidencePack.decodeAndValidate(
            try KernelFixtures.data("evidence-pack.ok-03.json")
        )
        pack.signals.axEvent = pack.signals.axEvent.map {
            AxEventSignal(
                treeDigestBefore: $0.treeDigestBefore, treeDigestAfter: $0.treeDigestAfter,
                nodeCount: $0.nodeCount, axChanged: $0.axChanged, latencyMs: latencyMs
            )
        }
        pack.signals.handlerProbe = pack.signals.handlerProbe.map {
            HandlerProbeSignal(
                probeVersion: $0.probeVersion, hitCount: $0.hitCount,
                handlers: $0.handlers, lateCount: 1
            )
        }
        pack.signals.stateDiff = pack.signals.stateDiff.map {
            StateDiffSignal(
                source: $0.source, changed: $0.changed,
                entries: $0.entries + [StateEntry(key: "demo.label", before: "idle", after: "pressed")]
            )
        }
        pack.signals.pixelDiff = pack.signals.pixelDiff.map {
            PixelDiffSignal(changedPixelRatio: 0.1234567, bounds: $0.bounds, windowId: $0.windowId)
        }
        // Fail here, not inside a golden diff, if the shipped fixture stops
        // carrying the shape this golden is derived from.
        XCTAssertEqual(pack.signals.axEvent?.latencyMs, latencyMs)
        XCTAssertEqual(pack.signals.handlerProbe?.lateCount, 1)
        XCTAssertEqual(pack.signals.stateDiff?.entries.map(\.key), ["demo.count", "demo.label"])
        XCTAssertEqual(pack.signals.pixelDiff?.changedPixelRatio, 0.1234567)
        return pack
    }

    /// ok-02: required members only, explicit null probe channels, no diagnosis.
    private static func z5Pack() throws -> EvidencePack {
        try EvidencePack.decodeAndValidate(try KernelFixtures.data("evidence-pack.ok-02.json"))
    }

    private static func kernelGolden(_ name: String) throws -> String {
        try XCTUnwrap(
            String(data: KernelFixtures.data(name), encoding: .utf8),
            "kernel/fixtures/\(name) is not readable UTF-8"
        )
    }

    /// The single summary line a channel renders to, or nil when none matches.
    private static func summaryLine(_ pack: EvidencePack, _ prefix: String) -> String? {
        EvidenceReportGenerator.evidenceSummaryLines(pack: pack).first { $0.hasPrefix(prefix) }
    }

    func testSharedGoldenMarkdown() throws {
        XCTAssertEqual(
            EvidenceReportGenerator.renderMarkdown(pack: try Self.goldenPack(), diagnostics: nil),
            try Self.kernelGolden("report.ok-01.md"),
            "the Swift renderer drifted from kernel/fixtures/report.ok-01.md"
        )
    }

    func testSharedGoldenHTML() throws {
        XCTAssertEqual(
            EvidenceReportGenerator.renderHTML(pack: try Self.goldenPack(), diagnostics: nil),
            try Self.kernelGolden("report.ok-01.html"),
            "the Swift renderer drifted from kernel/fixtures/report.ok-01.html"
        )
    }

    /// R4-10 / R6-16: a null probe channel names the missing measurement. The
    /// populated lines (and their position) are pinned byte-for-byte by the
    /// golden above.
    func testNullProbeChannelsNameTheirAbsence() throws {
        let z5Lines = EvidenceReportGenerator.evidenceSummaryLines(pack: try Self.z5Pack())
        XCTAssertTrue(z5Lines.contains(
            "handlerProbe: not measured (no probe connection served this act window)"
        ), "\(z5Lines)")
        XCTAssertTrue(z5Lines.contains(
            "stateDiff: not measured (the probe reported no state channel)"
        ), "\(z5Lines)")
    }

    /// R6-09: the same rule applied to all six channels. Four of them
    /// (`axEvent`, `pixelDiff`, `responsiveness`, `crash`) used to be *dropped*
    /// from the report when the pack carried no reading for them, so a reader of
    /// the console or an exported report could not tell "the UI did not change"
    /// from "nothing was measured" — the shape this project's classifier was
    /// fixed for, in the human-facing view. Order is part of the contract (both
    /// renderer headers name it), so this asserts the six lines as a sequence.
    func testEveryAbsentChannelNamesItselfInOrder() throws {
        var pack = try Self.z5Pack()
        pack.signals.axEvent = nil
        let lines = EvidenceReportGenerator.evidenceSummaryLines(pack: pack)
        let channelLines = lines.filter { line in
            ["axEvent:", "handlerProbe:", "stateDiff:", "pixelDiff:", "responsiveness:", "crash:"]
                .contains { line.hasPrefix($0) }
        }
        XCTAssertEqual(channelLines, [
            "axEvent: not measured (this pack carries no AX tree digest)",
            "handlerProbe: not measured (no probe connection served this act window)",
            "stateDiff: not measured (the probe reported no state channel)",
            "pixelDiff: not measured (this pack carries no pixel comparison)",
            "responsiveness: not measured (this pack carries no responsiveness round trip)",
            "crash: not measured (this pack carries no process liveness sample)",
        ], "\(channelLines)")
    }

    /// The control that keeps the case above from being a wish: a pack that
    /// *did* measure all six renders none of those strings. This is also the
    /// reason the shared golden did not have to move when the four absence lines
    /// landed — `goldenPack()` carries every channel.
    func testMeasuredChannelsNeverRenderAnAbsenceLine() throws {
        let lines = EvidenceReportGenerator.evidenceSummaryLines(pack: try Self.goldenPack())
        for line in lines {
            XCTAssertFalse(line.contains("not measured"), "measured pack: \(line)")
        }
        for prefix in ["axEvent:", "handlerProbe:", "stateDiff:", "pixelDiff:", "responsiveness:", "crash:"] {
            XCTAssertTrue(
                lines.contains { $0.hasPrefix(prefix) },
                "\(prefix) missing from a pack that measures it: \(lines)"
            )
        }
    }

    /// Empty lists say so; long ones are bounded with the elided count.
    func testProbeListsAreBoundedAndEmptyListsAreNamed() throws {
        var pack = try Self.goldenPack()
        pack.signals.handlerProbe = HandlerProbeSignal(
            probeVersion: "gp-probe/0.1.0", hitCount: 9,
            handlers: (0..<9).map { HandlerRef(file: "lane\($0).swift", line: $0 + 1) },
            lateCount: 0
        )
        pack.signals.stateDiff = StateDiffSignal(
            source: .z3KVC, changed: true,
            entries: (0..<9).map { StateEntry(key: "k\($0)", before: "0", after: "1") }
        )
        XCTAssertTrue((Self.summaryLine(pack, "handlerProbe:") ?? "").hasSuffix("lane7.swift:8, +1 more]"))
        XCTAssertFalse((Self.summaryLine(pack, "handlerProbe:") ?? "").contains("lane8"))
        XCTAssertTrue((Self.summaryLine(pack, "stateDiff:") ?? "").hasSuffix("k7 \"0\" -> \"1\", +1 more]"))
        XCTAssertFalse((Self.summaryLine(pack, "stateDiff:") ?? "").contains("k8"))

        pack.signals.handlerProbe = HandlerProbeSignal(
            probeVersion: "gp-probe/0.1.0", hitCount: 0, handlers: [], lateCount: 0
        )
        pack.signals.stateDiff = StateDiffSignal(source: .z2Mirror, changed: false, entries: [])
        XCTAssertTrue((Self.summaryLine(pack, "handlerProbe:") ?? "").hasSuffix("handlers=[no localized hits]"))
        XCTAssertTrue((Self.summaryLine(pack, "stateDiff:") ?? "").hasSuffix("entries=[no key changes]"))
    }

    /// B-9: the number rule is `%g` (six significant digits), shared with the
    /// TS mirror — whose table marks which of these rows the two rules disagree
    /// on. The last assertion pins the disagreement for Swift's plain print.
    func testDoublesFollowThePercentGRule() throws {
        let rows: [(Double, String)] = [
            (42, "42"), (0.25, "0.25"), (0.014, "0.014"), (1e21, "1e+21"),
            (1234.5678, "1234.57"), (0.1234567, "0.123457"), (123456.7, "123457"),
            (999999.5, "1e+06"), (1234567, "1.23457e+06"), (0.00001234567, "1.23457e-05"),
        ]
        for (value, expected) in rows {
            let line = Self.summaryLine(try Self.goldenPack(latencyMs: value), "axEvent:") ?? ""
            XCTAssertEqual(line, "axEvent: changed=true nodes=24 latencyMs=\(expected)", "%g for \(value)")
        }
        XCTAssertNotEqual("\(1234.5678)", "1234.57", "%g is a different rule from plain print")
    }

    /// R4-14: "no diagnosis" and "diagnosis with an empty section" must not
    /// read the same — four bare `—` look like a clean run.
    func testMissingDiagnosisIsSpelledOutNotEmptySectionIsNot() throws {
        let markdown = EvidenceReportGenerator.renderMarkdown(pack: try Self.z5Pack(), diagnostics: nil)
        for title in ["PATH", "ANOMALY", "EVIDENCE", "NEXT"] {
            XCTAssertTrue(
                markdown.contains("## \(title)\n\n— (no diagnosis recorded:"),
                "\(title) must name the missing diagnosis"
            )
        }
        XCTAssertTrue(markdown.contains("run gp_diagnose for this operationId"))

        var emptyReport = try Self.z5Pack()
        emptyReport.diagnosis = Diagnosis(
            class: .inconclusive,
            report: DiagnosisReport(path: "", anomaly: "", evidence: "", next: "")
        )
        let emptied = EvidenceReportGenerator.renderMarkdown(pack: emptyReport, diagnostics: nil)
        XCTAssertTrue(emptied.contains("## PATH\n\n—\n"))
        XCTAssertFalse(emptied.contains("no diagnosis recorded"))
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