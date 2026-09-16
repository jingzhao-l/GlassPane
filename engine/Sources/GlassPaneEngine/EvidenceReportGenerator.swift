import Foundation

// MARK: - Evidence review renderer (P1 spec v1.3 §10.2)

/// Deterministic human-readable renderer for `EvidencePack` (综述 §5.14 /
/// PRD US-10 evidence 审查 UX). Pure functions: the same pack in, the same
/// string out — no timestamps are synthesized (capturedAt is echoed as-is),
/// no randomness, no state. All pack-owned values are rendered verbatim;
/// missing optional fields degrade to the "—" placeholder instead of
/// throwing (spec v1.3 §10.5 缺省安全性).
///
/// The mcp-shell side keeps a type-mirrored implementation
/// (`mcp-shell/src/evidence-report.ts`) with the same structural contract;
/// both are tested against the same golden expectations (spec v1.3 §12.1)
/// so a future change must be applied to both sides in the same commit.
public enum EvidenceReportGenerator {

    /// `operationId · measure · level`, the one-line audit title. `measure`
    /// falls back from diagnosis class → assertion property → performed
    /// action so a pack without diagnosis still gets a readable title.
    public static func reportTitle(pack: EvidencePack) -> String {
        let measure = measureLabel(pack)
        let level = levelLabel(pack.circuitBreaker.level)
        return "\(pack.operationId) · \(measure) · \(level)"
    }

    /// Attribution / contamination / circuit-breaker / signal summary lines.
    /// Shared verbatim by the HTML and Markdown views so the two can't drift.
    public static func evidenceSummaryLines(pack: EvidencePack) -> [String] {
        var lines: [String] = []
        lines.append(
            "attribution: \(pack.attribution.level.rawValue) | contaminated=\(pack.attribution.contaminated)"
        )
        let reason = pack.circuitBreaker.reason.map { " | reason: \($0)" } ?? ""
        lines.append(
            "circuitBreaker: level \(pack.circuitBreaker.level.rawValue) (\(levelLabel(pack.circuitBreaker.level)))\(reason)"
        )
        if let assertion = pack.assertion {
            lines.append(
                "assert \(assertion.property.rawValue) on \(selectorText(assertion.selector)): "
                    + "expected=\(valueText(assertion.expected)) actual=\(valueText(assertion.actual)) passed=\(assertion.passed)"
            )
        }
        let act = pack.signals.act
        lines.append(
            "act \(act.action.rawValue) \(selectorText(act.selector)): \(act.actConfirmed ? "confirmed" : "rejected")"
        )
        if let axEvent = pack.signals.axEvent {
            lines.append(
                "axEvent: changed=\(axEvent.axChanged) nodes=\(axEvent.nodeCount) latencyMs=\(doubleText(axEvent.latencyMs))"
            )
        }
        if let pixelDiff = pack.signals.pixelDiff {
            var line = "pixelDiff: changedRatio=\(doubleText(pixelDiff.changedPixelRatio)) windowId=\(pixelDiff.windowId)"
            if let bounds = pixelDiff.bounds {
                line += " bounds=\(doubleText(bounds.x)),\(doubleText(bounds.y)),\(doubleText(bounds.width)),\(doubleText(bounds.height))"
            }
            lines.append(line)
        }
        if let responsiveness = pack.signals.responsiveness {
            lines.append(
                "responsiveness: responsive=\(responsiveness.responsive) pingMs=\(doubleText(responsiveness.pingMs))"
            )
        }
        if let crash = pack.signals.crash {
            lines.append(
                "crash: aliveBefore=\(crash.processAliveBefore) aliveAfter=\(crash.processAliveAfter)"
            )
        }
        return lines
    }

    /// Compact Markdown view: title + key fields + summary bullets + the four
    /// diagnosis sections. Terminal / dialog friendly.
    public static func renderMarkdown(pack: EvidencePack, diagnostics: String?) -> String {
        var out: [String] = []
        out.append("# \(reportTitle(pack: pack))")
        out.append("")
        out.append("**operationId**: \(pack.operationId)")
        out.append("**createdAt**: \(pack.createdAt)")
        out.append("**schemaVersion**: \(pack.schemaVersion)")
        out.append(contentsOf: evidenceSummaryLines(pack: pack).map { "* \($0)" })
        out.append("")
        for section in sections(pack: pack, diagnostics: diagnostics) {
            out.append("## \(section.title)")
            out.append("")
            out.append(section.body)
            out.append("")
        }
        return out.joined(separator: "\n")
    }

    /// Full HTML view: `<div id="<operationId>">` anchor, summary `<dl>`,
    /// and the four diagnosis `<section>`s. All values HTML-escaped (spec
    /// v1.3 §10.5, no injection); no script is emitted.
    public static func renderHTML(pack: EvidencePack, diagnostics: String?) -> String {
        var out: [String] = []
        out.append("<div class=\"gp-evidence\" id=\"\(escapeHTML(pack.operationId))\">")
        out.append("<h1>\(escapeHTML(reportTitle(pack: pack)))</h1>")
        out.append("<dl class=\"gp-summary\">")
        out.append("<dt>operationId</dt><dd>\(escapeHTML(pack.operationId))</dd>")
        out.append("<dt>createdAt</dt><dd>\(escapeHTML(pack.createdAt))</dd>")
        out.append("<dt>schemaVersion</dt><dd>\(escapeHTML(pack.schemaVersion))</dd>")
        for line in evidenceSummaryLines(pack: pack) {
            out.append("<dt class=\"gp-line\">·</dt><dd>\(escapeHTML(line))</dd>")
        }
        out.append("</dl>")
        for section in sections(pack: pack, diagnostics: diagnostics) {
            out.append("<section class=\"gp-section\">")
            out.append("<h2>\(escapeHTML(section.title))</h2>")
            if section.preformatted {
                out.append("<pre>\(escapeHTML(section.body))</pre>")
            } else {
                let bodyLines = escapeHTML(section.body)
                    .replacingOccurrences(of: "\n", with: "<br>")
                out.append("<p>\(bodyLines)</p>")
            }
            out.append("</section>")
        }
        out.append("</div>")
        return out.joined(separator: "\n")
    }

    // MARK: - Private

    private struct ReportSection {
        let title: String
        let body: String
        let preformatted: Bool

        init(title: String, body: String, preformatted: Bool = false) {
            self.title = title
            self.body = body
            self.preformatted = preformatted
        }
    }

    private static let placeholder = "—"

    /// The four diagnosis sections (PATH/ANOMALY/EVIDENCE/NEXT, FR-04).
    /// Source of truth is `pack.diagnosis?.report`; when the pack has no
    /// embedded diagnosis, a caller-supplied `diagnostics` string is shown
    /// in the EVIDENCE section as a preformatted block (honest fallback),
    /// and every other section degrades to the "—" placeholder.
    private static func sections(pack: EvidencePack, diagnostics: String?) -> [ReportSection] {
        let report = pack.diagnosis?.report
        let hasDiagnosticsText = !(diagnostics ?? "").isEmpty

        let path = report?.path.nonEmpty ?? placeholder
        let anomaly = report?.anomaly.nonEmpty ?? placeholder
        let next = report?.next.nonEmpty ?? placeholder

        let evidence: String
        let evidencePreformatted: Bool
        if let reportEvidence = report?.evidence.nonEmpty {
            evidence = reportEvidence
            evidencePreformatted = false
        } else if hasDiagnosticsText, let diagnostics {
            evidence = diagnostics
            evidencePreformatted = true
        } else {
            evidence = placeholder
            evidencePreformatted = false
        }

        return [
            ReportSection(title: "PATH", body: path),
            ReportSection(title: "ANOMALY", body: anomaly),
            ReportSection(title: "EVIDENCE", body: evidence, preformatted: evidencePreformatted),
            ReportSection(title: "NEXT", body: next),
        ]
    }

    private static func measureLabel(_ pack: EvidencePack) -> String {
        if let diagnosisClass = pack.diagnosis?.class {
            return diagnosisClass.rawValue
        }
        if let property = pack.assertion?.property {
            return property.rawValue
        }
        return pack.signals.act.action.rawValue
    }

    private static func levelLabel(_ level: CircuitBreakerLevel) -> String {
        switch level {
        case .normal: return "normal"
        case .degraded: return "degraded"
        case .actFailedChannelAlive: return "act_failed_channel_alive"
        case .channelFault: return "channel_fault"
        }
    }

    private static func selectorText(_ selector: Selector) -> String {
        var text = selector.role
        if let title = selector.title?.nonEmpty {
            text += " \"\(title)\""
        }
        if let identifier = selector.identifier?.nonEmpty {
            text += " #\(identifier)"
        }
        return text
    }

    private static func valueText(_ value: StringOrBool) -> String {
        switch value {
        case .string(let string): return string
        case .bool(let bool): return "\(bool)"
        }
    }

    /// IEEE doubles rendered without a spurious ".0" (9 → "9", 0.25 → "0.25"),
    /// keeping the two-language mirrors byte-compatible for golden tests.
    private static func doubleText(_ value: Double) -> String {
        String(format: "%g", value)
    }

    /// HTML-escapes every value that crosses into a report (spec v1.3 §10.5).
    private static func escapeHTML(_ value: String) -> String {
        var out = ""
        out.reserveCapacity(value.unicodeScalars.count)
        for scalar in value.unicodeScalars {
            switch scalar {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out
    }
}

private extension String {
    /// Non-empty self, or nil — shared by all "render or default" decisions.
    var nonEmpty: String? {
        isEmpty ? nil : self
    }
}