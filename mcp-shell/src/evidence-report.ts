import type { EvidencePack, HandlerProbeSignal, StateDiffSignal } from "@iterate/kernel";

/**
 * What a report may be handed: a validated pack, or the same structure with
 * `schemaVersion` widened so it can carry provenance text
 * (`glasspane.evidence/0.1-draft (read as glasspane.evidence/0.1)`). Every
 * `EvidencePack` is assignable here; only the renderer's own first line reads
 * the widened field, so no consumer of the strict type sees this shape.
 */
export type EvidencePackReportView = Omit<EvidencePack, "schemaVersion"> & {
  schemaVersion: string;
};

/**
 * Type-mirrored renderer of the engine's `EvidenceReportGenerator`
 * (engine/Sources/GlassPaneEngine/EvidenceReportGenerator.swift): same title,
 * same summary-line order (attribution / breaker / assert / act / axEvent /
 * handlerProbe / stateDiff / pixelDiff / responsiveness / crash), same
 * escaping, same placeholder semantics (P1 spec v1.3 §10.2).
 *
 * The mirror is guarded by a shared golden, not by this comment:
 * `kernel/fixtures/report.ok-01.md` / `.html` hold the byte-exact output for
 * the pack both suites call `goldenPack()`. `test/evidence-report.test.mjs`
 * compares this side, `EngineP1Batch4Tests` the engine side, so a one-sided
 * change fails a golden (spec v1.3 §12 P1-D1, §13.5 同一 commit 双改).
 */

export interface ReportSection {
  title: string;
  body: string;
  preformatted: boolean;
}

export const PLACEHOLDER = "—";
export const SECTION_TITLES = ["PATH", "ANOMALY", "EVIDENCE", "NEXT"] as const;

/** `operationId · measure · level`, mirroring the engine's reportTitle. */
export function reportTitle(pack: EvidencePackReportView): string {
  return `${pack.operationId} · ${measureLabel(pack)} · ${levelLabel(pack.circuitBreaker.level)}`;
}

/** Attribution / contamination / circuit-breaker / signal summary lines. */
export function evidenceSummaryLines(pack: EvidencePackReportView): string[] {
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
  if (pack.signals.axEvent !== undefined && pack.signals.axEvent !== null) {
    const ax = pack.signals.axEvent;
    lines.push(`axEvent: changed=${ax.axChanged} nodes=${ax.nodeCount} latencyMs=${doubleText(ax.latencyMs)}`);
  } else {
    lines.push(AX_EVENT_NOT_MEASURED);
  }
  // P6 §3.1 promotes both probe channels to first-class signals, and T4/T5/
  // T7/T8 rest on them: a report that stops at the black-box signals cannot
  // justify `attribution: strong`. A null channel renders a "not measured"
  // line, never a gap that reads as "nothing happened" — for all six channels,
  // which is what the engine side says too (see the mirrored constants below).
  lines.push(
    pack.signals.handlerProbe !== undefined && pack.signals.handlerProbe !== null
      ? handlerProbeText(pack.signals.handlerProbe)
      : HANDLER_PROBE_NOT_MEASURED,
  );
  lines.push(
    pack.signals.stateDiff !== undefined && pack.signals.stateDiff !== null
      ? stateDiffText(pack.signals.stateDiff)
      : STATE_DIFF_NOT_MEASURED,
  );
  if (pack.signals.pixelDiff !== undefined && pack.signals.pixelDiff !== null) {
    const px = pack.signals.pixelDiff;
    let line = `pixelDiff: changedRatio=${doubleText(px.changedPixelRatio)} windowId=${px.windowId}`;
    if (px.bounds !== null) {
      const b = px.bounds;
      line += ` bounds=${doubleText(b.x)},${doubleText(b.y)},${doubleText(b.width)},${doubleText(b.height)}`;
    }
    lines.push(line);
  } else {
    lines.push(PIXEL_DIFF_NOT_MEASURED);
  }
  if (pack.signals.responsiveness !== undefined && pack.signals.responsiveness !== null) {
    const r = pack.signals.responsiveness;
    lines.push(`responsiveness: responsive=${r.responsive} pingMs=${doubleText(r.pingMs)}`);
  } else {
    lines.push(RESPONSIVENESS_NOT_MEASURED);
  }
  if (pack.signals.crash !== undefined && pack.signals.crash !== null) {
    const c = pack.signals.crash;
    lines.push(`crash: aliveBefore=${c.processAliveBefore} aliveAfter=${c.processAliveAfter}`);
  } else {
    lines.push(CRASH_NOT_MEASURED);
  }
  return lines;
}

/** Compact Markdown view (terminal / dialog friendly). */
export function renderMarkdown(pack: EvidencePackReportView, diagnostics: string | undefined): string {
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
export function renderHTML(pack: EvidencePackReportView, diagnostics: string | undefined): string {
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
 * §13.4, the five-character escape set, no injection). Shared so aggregation
 * headers escape too.
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

/** The two absences: the `—` placeholder means "measured, nothing to say",
 * this line means "never diagnosed". `gp_export_evidence` only fetches
 * evidence, so `act → gp_export_evidence` lands here (spec v1.3 §13.1). */
const NO_DIAGNOSIS_TEXT =
  "— (no diagnosis recorded: this pack carries none; run gp_diagnose for this operationId, then gp_export_evidence again)";

/** Null probe channels: named absence, not silence (P6 §3.1). */
const HANDLER_PROBE_NOT_MEASURED = "handlerProbe: not measured (no probe connection served this act window)";
const STATE_DIFF_NOT_MEASURED = "stateDiff: not measured (the probe reported no state channel)";

/**
 * The four black-box channels, worded exactly as the engine words them, and for
 * the same reason: each line says what the pack does not carry and guesses at no
 * cause. `test/evidence-report.test.mjs` compares these six strings against
 * `EvidenceReportGenerator.swift`'s own literals, so a one-sided rewording fails
 * there instead of quietly splitting the two views of one pack.
 */
const AX_EVENT_NOT_MEASURED = "axEvent: not measured (this pack carries no AX tree digest)";
const PIXEL_DIFF_NOT_MEASURED = "pixelDiff: not measured (this pack carries no pixel comparison)";
const RESPONSIVENESS_NOT_MEASURED = "responsiveness: not measured (this pack carries no responsiveness round trip)";
const CRASH_NOT_MEASURED = "crash: not measured (this pack carries no process liveness sample)";

/** Render caps: a pack may legally carry 32 handlers / 64 state entries. */
const MAX_HANDLERS_SHOWN = 8;
const MAX_ENTRIES_SHOWN = 8;

/**
 * The four sections come from `pack.diagnosis?.report` only (FR-04); a
 * caller-supplied `diagnostics` string is the preformatted EVIDENCE fallback
 * when the report is absent (§10.2 设计缺口补述 2).
 */
function sections(pack: EvidencePackReportView, diagnostics: string | undefined): ReportSection[] {
  const report = pack.diagnosis?.report;
  const hasDiagnosticsText = diagnostics !== undefined && diagnostics !== "";
  const reportEvidence = nonEmpty(report?.evidence);
  const absent = pack.diagnosis === null || pack.diagnosis === undefined ? NO_DIAGNOSIS_TEXT : PLACEHOLDER;

  return [
    { title: "PATH", body: nonEmpty(report?.path) ?? absent, preformatted: false },
    { title: "ANOMALY", body: nonEmpty(report?.anomaly) ?? absent, preformatted: false },
    {
      title: "EVIDENCE",
      body: reportEvidence ?? (hasDiagnosticsText && diagnostics !== undefined ? diagnostics : absent),
      preformatted: reportEvidence === undefined && hasDiagnosticsText,
    },
    { title: "NEXT", body: nonEmpty(report?.next) ?? absent, preformatted: false },
  ];
}

/**
 * Mirrors the Classifier's own channel wording (`handlerProbe hitCount=N
 * late=M [file:line, …]`, empty list reading "no localized hits") so the two
 * views of one pack cannot describe the probe differently.
 */
function handlerProbeText(handlerProbe: HandlerProbeSignal): string {
  const refs = handlerProbe.handlers.slice(0, MAX_HANDLERS_SHOWN).map((ref) => `${ref.file}:${ref.line}`);
  const hidden = handlerProbe.handlers.length - refs.length;
  if (hidden > 0) {
    refs.push(`+${hidden} more`);
  }
  const list = refs.length === 0 ? "no localized hits" : refs.join(", ");
  return `handlerProbe: probeVersion=${handlerProbe.probeVersion} hitCount=${handlerProbe.hitCount}`
    + ` late=${handlerProbe.lateCount} handlers=[${list}]`;
}

/**
 * `stateDiff: source=… changed=… entries=[key "before" -> "after", …]`,
 * bounded to `MAX_ENTRIES_SHOWN` with the count of the rest spelled out.
 */
function stateDiffText(stateDiff: StateDiffSignal): string {
  const rendered = stateDiff.entries
    .slice(0, MAX_ENTRIES_SHOWN)
    .map((entry) => `${entry.key} "${entry.before}" -> "${entry.after}"`);
  const hidden = stateDiff.entries.length - rendered.length;
  if (hidden > 0) {
    rendered.push(`+${hidden} more`);
  }
  const list = rendered.length === 0 ? "no key changes" : rendered.join(", ");
  return `stateDiff: source=${stateDiff.source} changed=${stateDiff.changed} entries=[${list}]`;
}

/** Non-empty self, or undefined — mirrors the engine's `nonEmpty` rule. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function measureLabel(pack: EvidencePackReportView): string {
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

/**
 * The one number rule both renderers share: C `%g` with its default 6
 * significant digits, i.e. `String(format: "%g", …)` on the engine side
 * (spec v1.3 §10.2). JS `String(n)` is a different rule — up to 17 digits,
 * exponent only outside 1e-6..1e21 — which is how `latencyMs=1234.5678` read
 * "1234.5678" here against "1234.57" in the panel (B-9). `%g` rounds to 6
 * significant digits first and picks the style from the exponent of *that*
 * value, so both come from one shared digit string (`toFixed` would re-round
 * and let 999999.5 escape into 7 digits). Non-finite doubles cannot reach a
 * renderer through JSON, so those spellings are C-compatible but untested.
 */
function doubleText(value: number): string {
  if (Number.isNaN(value)) {
    return "nan";
  }
  if (value === Number.POSITIVE_INFINITY) {
    return "inf";
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return "-inf";
  }
  const exponential = value.toExponential(G_SIG_DIGITS - 1);
  const marker = exponential.indexOf("e");
  const mantissa = exponential.slice(0, marker);
  const power = Number(exponential.slice(marker + 1));
  // The six significant digits, with the exponent of the rounded value: fixed
  // style inside [-4, 6), exponent style outside it (C's `%g` rule).
  const digits = mantissa.replace("-", "").replace(".", "");
  const body = power >= -4 && power < G_SIG_DIGITS
    ? fixedFromDigits(digits, power)
    : exponentialFromDigits(digits, power);
  return mantissa.startsWith("-") ? `-${body}` : body;
}

/** `%g`'s default precision, in significant digits. */
const G_SIG_DIGITS = 6;

/** Fixed style: the decimal point lands after `power + 1` significant digits. */
function fixedFromDigits(digits: string, power: number): string {
  const point = power + 1;
  const intPart = point <= 0 ? "0" : digits.slice(0, point);
  const rawFraction = point <= 0 ? `${"0".repeat(-point)}${digits}` : digits.slice(point);
  const fraction = rawFraction.replace(/0+$/, "");
  return fraction === "" ? intPart : `${intPart}.${fraction}`;
}

/** Exponent style: `d[.ddddd]e±EE`, at least two exponent digits, zeros stripped. */
function exponentialFromDigits(digits: string, power: number): string {
  const head = digits.slice(0, 1);
  const tail = digits.slice(1).replace(/0+$/, "");
  const mantissa = tail === "" ? head : `${head}.${tail}`;
  return `${mantissa}e${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
}
