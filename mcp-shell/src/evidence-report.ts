import type { EvidencePack } from "@iterate/kernel";

/**
 * Type-mirrored renderer of the engine's `EvidenceReportGenerator`
 * (engine/Sources/GlassPaneEngine/EvidenceReportGenerator.swift). Both
 * implementations share the same structural contract (same titles, sections,
 * summary lines, escaping and placeholder semantics) and are covered by the
 * same golden expectations (P1 spec v1.3 §12.1), so a change must be applied
 * to both files in the same commit to avoid drift.
 */

export interface ReportSection {
  title: string;
  body: string;
  preformatted: boolean;
}

export const PLACEHOLDER = "—";
export const SECTION_TITLES = ["PATH", "ANOMALY", "EVIDENCE", "NEXT"] as const;

/** `operationId · measure · level`, mirroring the engine's reportTitle. */
export function reportTitle(pack: EvidencePack): string {
  return `${pack.operationId} · ${measureLabel(pack)} · ${levelLabel(pack.circuitBreaker.level)}`;
}

/** Attribution / contamination / circuit-breaker / signal summary lines. */
export function evidenceSummaryLines(pack: EvidencePack): string[] {
  const lines: string[] = [];
  lines.push(`attribution: ${pack.attribution.level} | contaminated=${pack.attribution.contaminated}`);
  const reason = pack.circuitBreaker.reason === undefined ? "" : ` | reason: ${pack.circuitBreaker.reason}`;
  lines.push(`circuitBreaker: level ${pack.circuitBreaker.level} (${levelLabel(pack.circuitBreaker.level)})${reason}`);
  if (pack.assertion !== undefined && pack.assertion !== null) {
    const a = pack.assertion;
    lines.push(
      `assert ${a.property} on ${selectorText(a.selector)}: expected=${valueText(a.expected)} actual=${valueText(a.actual)} passed=${a.passed}`,
    );
  }
  const act = pack.signals.act;
  lines.push(`act ${act.action} ${selectorText(act.selector)}: ${act.actConfirmed ? "confirmed" : "rejected"}`);
  if (pack.signals.axEvent !== undefined) {
    const ax = pack.signals.axEvent;
    lines.push(`axEvent: changed=${ax.axChanged} nodes=${ax.nodeCount} latencyMs=${doubleText(ax.latencyMs)}`);
  }
  if (pack.signals.pixelDiff !== undefined) {
    const px = pack.signals.pixelDiff;
    let line = `pixelDiff: changedRatio=${doubleText(px.changedPixelRatio)} windowId=${px.windowId}`;
    if (px.bounds !== null) {
      const b = px.bounds;
      line += ` bounds=${doubleText(b.x)},${doubleText(b.y)},${doubleText(b.width)},${doubleText(b.height)}`;
    }
    lines.push(line);
  }
  if (pack.signals.responsiveness !== undefined) {
    const r = pack.signals.responsiveness;
    lines.push(`responsiveness: responsive=${r.responsive} pingMs=${doubleText(r.pingMs)}`);
  }
  if (pack.signals.crash !== undefined) {
    const c = pack.signals.crash;
    lines.push(`crash: aliveBefore=${c.processAliveBefore} aliveAfter=${c.processAliveAfter}`);
  }
  return lines;
}

/** Compact Markdown view (terminal / dialog friendly). */
export function renderMarkdown(pack: EvidencePack, diagnostics: string | undefined): string {
  const out: string[] = [];
  out.push(`# ${reportTitle(pack)}`);
  out.push("");
  out.push(`**operationId**: ${pack.operationId}`);
  out.push(`**createdAt**: ${pack.createdAt}`);
  out.push(`**schemaVersion**: ${pack.schemaVersion}`);
  for (const line of evidenceSummaryLines(pack)) {
    out.push(`* ${line}`);
  }
  out.push("");
  for (const section of sections(pack, diagnostics)) {
    out.push(`## ${section.title}`);
    out.push("");
    out.push(section.body);
    out.push("");
  }
  return out.join("\n");
}

/** Full HTML view with an operationId anchor; all values escaped. */
export function renderHTML(pack: EvidencePack, diagnostics: string | undefined): string {
  const out: string[] = [];
  out.push(`<div class="gp-evidence" id="${escapeHTML(pack.operationId)}">`);
  out.push(`<h1>${escapeHTML(reportTitle(pack))}</h1>`);
  out.push(`<dl class="gp-summary">`);
  out.push(`<dt>operationId</dt><dd>${escapeHTML(pack.operationId)}</dd>`);
  out.push(`<dt>createdAt</dt><dd>${escapeHTML(pack.createdAt)}</dd>`);
  out.push(`<dt>schemaVersion</dt><dd>${escapeHTML(pack.schemaVersion)}</dd>`);
  for (const line of evidenceSummaryLines(pack)) {
    out.push(`<dt class="gp-line">·</dt><dd>${escapeHTML(line)}</dd>`);
  }
  out.push(`</dl>`);
  for (const section of sections(pack, diagnostics)) {
    out.push(`<section class="gp-section">`);
    out.push(`<h2>${escapeHTML(section.title)}</h2>`);
    if (section.preformatted) {
      out.push(`<pre>${escapeHTML(section.body)}</pre>`);
    } else {
      out.push(`<p>${escapeHTML(section.body).replace(/\n/g, "<br>")}</p>`);
    }
    out.push(`</section>`);
  }
  out.push(`</div>`);
  return out.join("\n");
}

/**
 * Escape HTML metacharacters in values that cross into a report (spec v1.3
 * §10.5, no injection). Shared so aggregation headers escape too.
 */
export function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// MARK: - Internal helpers

function sections(pack: EvidencePack, diagnostics: string | undefined): ReportSection[] {
  const report = pack.diagnosis === null || pack.diagnosis === undefined ? undefined : pack.diagnosis.report;
  const hasDiagnosticsText = diagnostics !== undefined && diagnostics !== "";
  const reportEvidence = nonEmpty(report?.evidence);

  return [
    { title: "PATH", body: nonEmpty(report?.path) ?? PLACEHOLDER, preformatted: false },
    { title: "ANOMALY", body: nonEmpty(report?.anomaly) ?? PLACEHOLDER, preformatted: false },
    {
      title: "EVIDENCE",
      body: reportEvidence ?? (hasDiagnosticsText && diagnostics !== undefined ? diagnostics : PLACEHOLDER),
      preformatted: reportEvidence === undefined && hasDiagnosticsText,
    },
    { title: "NEXT", body: nonEmpty(report?.next) ?? PLACEHOLDER, preformatted: false },
  ];
}

/** Non-empty self, or undefined — mirrors the engine's `nonEmpty` rule. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function measureLabel(pack: EvidencePack): string {
  if (pack.diagnosis !== null && pack.diagnosis !== undefined) {
    return pack.diagnosis.class;
  }
  if (pack.assertion !== null && pack.assertion !== undefined) {
    return pack.assertion.property;
  }
  return pack.signals.act.action;
}

function levelLabel(level: number): string {
  switch (level) {
    case 0:
      return "normal";
    case 1:
      return "degraded";
    case 2:
      return "act_failed_channel_alive";
    case 3:
      return "channel_fault";
    default:
      return String(level);
  }
}

function selectorText(selector: { role: string; title?: string; identifier?: string }): string {
  let text = selector.role;
  if (selector.title !== undefined && selector.title !== "") {
    text += ` "${selector.title}"`;
  }
  if (selector.identifier !== undefined && selector.identifier !== "") {
    text += ` #${selector.identifier}`;
  }
  return text;
}

function valueText(value: string | boolean): string {
  return String(value);
}

/** JS String() prints doubles without a trailing ".0" — mirrors %g. */
function doubleText(value: number): string {
  return String(value);
}