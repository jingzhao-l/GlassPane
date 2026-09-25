import Foundation

// MARK: - Evidence review renderer (P1 spec v1.3 §10.2)

/// Deterministic human-readable renderer for `EvidencePack` (综述 §5.14 /
/// PRD US-10 evidence 审查 UX). Pure functions: the same pack in, the same
/// string out — no timestamps are synthesized (capturedAt is echoed as-is),
/// no randomness, no state. All pack-owned values are rendered verbatim; an
/// absent optional field renders as the "—" placeholder, and every one of the
/// six signal channels renders a line whether or not it was measured: absence
/// is named on its own line rather than shown as a missing line (spec v1.3
/// §10.2 缺省安全性, §13.1 如实声明).
///
/// The mcp-shell type mirror (`mcp-shell/src/evidence-report.ts`) is checked
/// by a real shared golden, not by this comment: `kernel/fixtures/
/// report.ok-01.md` / `.html` hold the byte-exact output for the pack both
/// suites call `goldenPack()` (`evidence-pack.ok-03.json` plus the overrides
/// that helper names). `EngineP1Batch4Tests` compares this renderer against
/// those files, `test/evidence-report.test.mjs` the TS one, so a one-sided
/// change fails a golden (spec v1.3 §12 P1-D1, §13.5 双语言渲染镜像防漂移).
public enum EvidenceReportGenerator {

    /// `operationId · measure · level`, the one-line audit title. `measure`
    /// falls back from diagnosis class → assertion property → performed
    /// action so a pack without diagnosis still gets a readable title.
    public static func reportTitle(pack: EvidencePack) -> String {
        let measure = measureLabel(pack)
        let level = levelLabel(pack.circuitBreaker.level)
        return "\(pack.operationId) · \(measure) · \(level)"
    }

    /// Attribution / contamination / circuit-breaker / signal summary lines,
    /// in the order attribution, breaker, assertion, act, axEvent,
    /// handlerProbe, stateDiff, pixelDiff, responsiveness, crash. Shared
    /// verbatim by both views here, and line-for-line by the TS mirror.
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
        } else {
            lines.append(axEventNotMeasured)
        }
        // P6 §3.1 promotes both probe channels to first-class signals, and
        // T4/T5/T7/T8 rest on them: a report that stops at the black-box
        // signals cannot justify `attribution: strong`. A null channel renders
        // a "not measured" line, never a gap that reads as "nothing happened".
        // That rule used to be written here and obeyed by two of the six
        // channels only — `axEvent`, `pixelDiff`, `responsiveness` and `crash`
        // silently dropped their line, which is the same defect the classifier
        // was fixed for (a report where an unmeasured channel and an
        // unremarkable measurement look alike).
        if let handlerProbe = pack.signals.handlerProbe {
            lines.append(handlerProbeText(handlerProbe))
        } else {
            lines.append(handlerProbeNotMeasured)
        }
        if let stateDiff = pack.signals.stateDiff {
            lines.append(stateDiffText(stateDiff))
        } else {
            lines.append(stateDiffNotMeasured)
        }
        if let pixelDiff = pack.signals.pixelDiff {
            var line = "pixelDiff: changedRatio=\(doubleText(pixelDiff.changedPixelRatio)) windowId=\(pixelDiff.windowId)"
            if let bounds = pixelDiff.bounds {
                line += " bounds=\(doubleText(bounds.x)),\(doubleText(bounds.y)),\(doubleText(bounds.width)),\(doubleText(bounds.height))"
            }
            lines.append(line)
        } else {
            lines.append(pixelDiffNotMeasured)
        }
        if let responsiveness = pack.signals.responsiveness {
            lines.append(
                "responsiveness: responsive=\(responsiveness.responsive) pingMs=\(doubleText(responsiveness.pingMs))"
            )
        } else {
            lines.append(responsivenessNotMeasured)
        }
        if let crash = pack.signals.crash {
            lines.append(
                "crash: aliveBefore=\(crash.processAliveBefore) aliveAfter=\(crash.processAliveAfter)"
            )
        } else {
            lines.append(crashNotMeasured)
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
    /// v1.3 §13.4, the five-character escape set); no script is emitted.
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

    /// Two absences a reader must be able to tell apart (spec v1.3 §13.1
    /// 如实声明): an empty section of a diagnosis that ran keeps the `—`
    /// placeholder of §10.2; a pack that carries no diagnosis at all says so
    /// and names the tool — `gp_export_evidence` only fetches evidence, so
    /// `act → export` lands here, and four bare `—` read as a clean run.
    private static let noDiagnosisText =
        "— (no diagnosis recorded: this pack carries none; run gp_diagnose for this operationId, then gp_export_evidence again)"

    /// Null probe channels: named absence, not silence (P6 §3.1).
    private static let handlerProbeNotMeasured =
        "handlerProbe: not measured (no probe connection served this act window)"
    private static let stateDiffNotMeasured =
        "stateDiff: not measured (the probe reported no state channel)"

    /// The four black-box channels, in the same shape. Each line says what the
    /// pack does *not* carry; none of them guesses why, because the pack records
    /// no reason and an invented one is how a broken capture channel spent ten
    /// days reading as a quiet UI.
    private static let axEventNotMeasured =
        "axEvent: not measured (this pack carries no AX tree digest)"
    private static let pixelDiffNotMeasured =
        "pixelDiff: not measured (this pack carries no pixel comparison)"
    private static let responsivenessNotMeasured =
        "responsiveness: not measured (this pack carries no responsiveness round trip)"
    private static let crashNotMeasured =
        "crash: not measured (this pack carries no process liveness sample)"

    /// Render caps: a pack may legally carry 32 handlers / 64 state entries.
    private static let maxHandlersShown = 8
    private static let maxEntriesShown = 8

    /// The four diagnosis sections (PATH/ANOMALY/EVIDENCE/NEXT, FR-04) come
    /// from `pack.diagnosis?.report`; a caller-supplied `diagnostics` string
    /// is the preformatted EVIDENCE fallback when the report is absent
    /// (§10.2 设计缺口补述 2).
    private static func sections(pack: EvidencePack, diagnostics: String?) -> [ReportSection] {
        let report = pack.diagnosis?.report
        let absent = pack.diagnosis == nil ? noDiagnosisText : placeholder

        let evidence: String
        let evidencePreformatted: Bool
        if let reportEvidence = report?.evidence.nonEmpty {
            evidence = reportEvidence
            evidencePreformatted = false
        } else if let diagnostics, !diagnostics.isEmpty {
            evidence = diagnostics
            evidencePreformatted = true
        } else {
            evidence = absent
            evidencePreformatted = false
        }

        return [
            ReportSection(title: "PATH", body: report?.path.nonEmpty ?? absent),
            ReportSection(title: "ANOMALY", body: report?.anomaly.nonEmpty ?? absent),
            ReportSection(title: "EVIDENCE", body: evidence, preformatted: evidencePreformatted),
            ReportSection(title: "NEXT", body: report?.next.nonEmpty ?? absent),
        ]
    }

    /// Mirrors the Classifier's own channel wording (`handlerProbe hitCount=N
    /// late=M [file:line, …]`, empty list reading "no localized hits") so the
    /// two views of one pack cannot describe the probe differently.
    private static func handlerProbeText(_ handlerProbe: HandlerProbeSignal) -> String {
        var refs = handlerProbe.handlers.prefix(maxHandlersShown).map { "\($0.file):\($0.line)" }
        let hidden = handlerProbe.handlers.count - refs.count
        if hidden > 0 {
            refs.append("+\(hidden) more")
        }
        let list = refs.isEmpty ? "no localized hits" : refs.joined(separator: ", ")
        return "handlerProbe: probeVersion=\(handlerProbe.probeVersion)"
            + " hitCount=\(handlerProbe.hitCount) late=\(handlerProbe.lateCount) handlers=[\(list)]"
    }

    /// The state channel in the same shape, with `key "before" -> "after"`
    /// entries bounded to `maxEntriesShown` and the elided count spelled out.
    private static func stateDiffText(_ stateDiff: StateDiffSignal) -> String {
        var rendered = stateDiff.entries.prefix(maxEntriesShown).map {
            "\($0.key) \"\($0.before)\" -> \"\($0.after)\""
        }
        let hidden = stateDiff.entries.count - rendered.count
        if hidden > 0 {
            rendered.append("+\(hidden) more")
        }
        let list = rendered.isEmpty ? "no key changes" : rendered.joined(separator: ", ")
        return "stateDiff: source=\(stateDiff.source.rawValue)"
            + " changed=\(stateDiff.changed) entries=[\(list)]"
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

    /// The number rule both languages share: `%g` with its default six
    /// significant digits (spec v1.3 §10.2), so 9 → "9", 0.25 → "0.25",
    /// 1234.5678 → "1234.57", 1234567 → "1.23457e+06". The TS mirror
    /// re-implements this rule rather than `String(n)`, which keeps up to 17
    /// digits and would print "1234.5678" where the panel prints "1234.57".
    private static func doubleText(_ value: Double) -> String {
        String(format: "%g", value)
    }

    /// HTML-escapes every value that crosses into a report (spec v1.3 §13.4).
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