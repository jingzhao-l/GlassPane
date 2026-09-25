#!/usr/bin/env node
/**
 * surface-semantics.mjs — the grep-able half of the iron law that LOC alone
 * cannot express: a tool surface must not *judge* evidence.
 *
 * WHY. specs/GlassPane_Harness_Fork_调研与方案_v0.1.md §3-1 measured that the
 * "<10% code" law had no meter, and fixed that with `tool-surface.mjs`. But the
 * same section recorded the other half as still open (§9-6): the law's semantic
 * content — "工具面不得自行判定证据语义" — where a surface that computes its own
 * threshold, its own pixel verdict, or its own pass/fail string has moved the
 * judgement out of the engine and into a shell. That failure is invisible to
 * every existing gate: the code compiles, the tests pass, and the surface just
 * grew a second source of truth.
 *
 * CALIBER (recorded in the golden so the check is reproducible):
 *   surface A  every *.ts under mcp-shell/src
 *   surface B  the fork's evidence-handling files: packages/opencode/src/tool/
 *              glasspane/** plus packages/opencode/src/plugin/glasspane-*.ts
 *              (the plugin layer transcribes engine/kernel facts — a verdict
 *              synthesized there is the same defect one layer later)
 *   comments   stripped before matching (prose may discuss pass/fail; code may not
 *              *compute* it)
 *   strings    kept for the verdict-literal rule, stripped for the comparison
 *              rules — a number written in a sentence is documentation, a
 *              comparison in code against a decimal is a threshold
 *
 * RULES
 *   threshold-comparison    `<`/`<=`/`>`/`>=` against a decimal literal
 *   verdict-synthesis       pass/fail chosen by a ternary or an equality test in
 *                           code (an object field like `status: "failed"` is a
 *                           write's own status, not a verdict about the app)
 *   evidence-field-compare  a comparison involving an engine evidence field
 *                           (pixel ratio, attribution, circuit breaker, …);
 *                           `!== undefined`/`!= null` presence checks stay legal
 *
 * MODES
 *   --record  write harness/contracts/surface-semantics.json (the baseline)
 *   --check   fail if any (file, rule) count grew past the baseline, or if a
 *             file that is not in the baseline carries hits, or if the scan
 *             found nothing to scan
 *
 * This is a ratchet, not a ban: a legitimate hit can be recorded in the same
 * commit and is then visible in review. Removing hits is always allowed.
 *
 * Exit codes: 0 ok, 1 drift, 2 cannot measure.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const goldenFile = path.join(repoRoot, "harness", "contracts", "surface-semantics.json")
const mode = process.argv.includes("--record") ? "record" : "check"

const RULES = [
  {
    id: "threshold-comparison",
    scope: "arithmetic",
    why: "a decimal literal on the other side of a comparison is a threshold; thresholds belong to the engine",
    count: (text) => (text.match(/(?:[<>]=?|===?\s*)[\s]*\d*\.\d+/g) ?? []).length,
  },
  {
    id: "verdict-synthesis",
    scope: "code",
    why: "pass/fail chosen by a ternary or an equality test is a verdict the surface synthesized; subjects named status/state (a write's own bookkeeping) are excluded, and engine-provided verdict fields are covered by evidence-field-compare's transcription exception instead",
    count: (text) => countVerdictSynthesis(text),
  },
  {
    id: "evidence-field-compare",
    scope: "arithmetic",
    why: "comparing an engine evidence field moves its interpretation into the shell (`!== undefined` is a presence check and is excluded — absence must stay sayable)",
    count: (text) => countEvidenceCompare(text),
  },
]

/** Field-vs-value comparisons, with the value in hand so presence checks (`undefined`/`null`) can be excluded honestly. */
function countEvidenceCompare(text) {
  const re =
    /(?:changedPixelRatio|pixelDiff|pixelChanged|actConfirmed|axChanged|attribution|circuitBreaker|confidence|outcome)\s*(?:[<>]=?|={2,3}|!={1,2})\s*([^\n;,)]*)/g
  let count = 0
  let match
  while ((match = re.exec(text)) !== null) {
    if (/^(?:undefined|null)\b/.test(match[1].trim())) continue
    count++
  }
  return count
}

/** Verdict literals, judged by their *subject*: `x.status !== "failed"` is bookkeeping, `ok ? "pass" : "fail"` is synthesis. */
function countVerdictSynthesis(code) {
  const re = /(?:\?\s*|===?\s*|!==?\s*)(["'`])([Pp][Aa][Ss][Ss](?:[Ee][Dd])?|[Ff][Aa][Ii][Ll](?:[Ee][Dd])?)\1/g
  let count = 0
  let match
  while ((match = re.exec(code)) !== null) {
    const before = code.slice(0, match.index)
    const subject = (before.match(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/)?.[1] ?? "").replace(/\s+/g, "")
    if (subject === "status" || subject === "state" || subject.endsWith(".status") || subject.endsWith(".state")) continue
    count++
  }
  return count
}

function die(code, msg) {
  console.error(`surface-semantics: ${msg}`)
  process.exit(code)
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir).sort()) {
    if (entry === "node_modules" || entry === "dist") continue
    const full = path.join(dir, entry)
    if (lstatSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** Comments carry the *rules*; only code can break them. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

/** For comparison rules, literals are documentation, not arithmetic. */
function stripStrings(text) {
  return text.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, "``")
}

const surfaces = {
  mcpShell: {
    caliber: "every *.ts under mcp-shell/src",
    files: walk(path.join(repoRoot, "mcp-shell", "src")).filter((f) => f.endsWith(".ts")),
  },
  fork: {
    caliber: "fork evidence-handling files: src/tool/glasspane/** + src/plugin/glasspane-*.ts",
    files: [
      ...walk(path.join(repoRoot, "harness", "glasspane-harness", "packages", "opencode", "src", "tool", "glasspane")),
      ...walk(path.join(repoRoot, "harness", "glasspane-harness", "packages", "opencode", "src", "plugin")).filter(
        (f) => path.basename(f).startsWith("glasspane-") && f.endsWith(".ts"),
      ),
    ].filter((f) => f.endsWith(".ts")),
  },
}

if (!surfaces.mcpShell.files.length) die(2, "no *.ts under mcp-shell/src — the scan found nothing to check")
if (!surfaces.fork.files.length) die(2, "no fork evidence files found — the scan found nothing to check")

function scan() {
  const out = {}
  for (const [name, surface] of Object.entries(surfaces)) {
    const hits = []
    for (const file of surface.files) {
      const raw = readFileSync(file, "utf8")
      const code = stripComments(raw)
      const arithmetic = stripStrings(code)
      for (const rule of RULES) {
        const count = rule.count(rule.scope === "code" ? code : arithmetic)
        if (count > 0) hits.push({ file: path.relative(repoRoot, file), rule: rule.id, count })
      }
    }
    out[name] = { caliber: surface.caliber, filesScanned: surface.files.length, hits }
  }
  return out
}

const observed = {
  observedAt: new Date().toISOString().slice(0, 10),
  source: "specs/GlassPane_Harness_Fork_调研与方案_v0.1.md §9-6（可 grep 的那半个铁律）",
  rules: RULES.map((rule) => ({ id: rule.id, why: rule.why })),
  surfaces: scan(),
}
observed.totalHits = Object.values(observed.surfaces).reduce(
  (sum, surface) => sum + surface.hits.reduce((s, hit) => s + hit.count, 0),
  0,
)
observed.filesScanned = Object.values(observed.surfaces).reduce((sum, surface) => sum + surface.filesScanned, 0)

for (const [name, surface] of Object.entries(observed.surfaces)) {
  console.log(`surface-semantics — ${name}: ${surface.filesScanned} file(s) scanned, ${surface.hits.length} file/rule hit(s)`)
  for (const hit of surface.hits) console.log(`    ${hit.rule} ×${hit.count}  ${hit.file}`)
}
console.log(
  `surface-semantics — ${observed.totalHits} hit(s) across ${observed.filesScanned} file(s); rules: ${RULES.map((r) => r.id).join(", ")}`,
)

if (mode === "record") {
  mkdirSync(path.dirname(goldenFile), { recursive: true })
  writeFileSync(goldenFile, JSON.stringify(observed, null, 2) + "\n")
  console.log(`recorded -> ${path.relative(repoRoot, goldenFile)}`)
  process.exit(0)
}

if (!existsSync(goldenFile)) die(2, `no golden at ${path.relative(repoRoot, goldenFile)} — run --record`)

const golden = JSON.parse(readFileSync(goldenFile, "utf8"))
const baseline = new Map()
for (const [name, surface] of Object.entries(golden.surfaces ?? {})) {
  for (const hit of surface.hits) baseline.set(`${name}|${hit.file}|${hit.rule}`, hit.count)
}

let red = 0
for (const [name, surface] of Object.entries(observed.surfaces)) {
  for (const hit of surface.hits) {
    const was = baseline.get(`${name}|${hit.file}|${hit.rule}`) ?? 0
    if (hit.count > was) {
      console.error(
        `  ✗ ${name}: ${hit.file} — ${hit.rule} ×${was === 0 ? hit.count : `${was} → ${hit.count}`}${was === 0 ? " (not in the baseline)" : ""}`,
      )
      red++
    }
  }
}

if (red > 0) {
  console.error("surface-semantics: a tool surface started judging evidence (or judging more of it).")
  console.error("  The iron law is 工具面不得自行判定证据语义: thresholds, pixel verdicts and pass/fail")
  console.error("  literals belong to the engine (or to the kernel), never to a shell.")
  console.error("  If the new hit is legitimate, record it in the same commit and say why there:")
  console.error("    node harness/tools/surface-semantics.mjs --record")
  process.exit(1)
}
const fewer = Object.entries(observed.surfaces).filter(([name, surface]) =>
  surface.hits.some((hit) => (baseline.get(`${name}|${hit.file}|${hit.rule}`) ?? 0) > hit.count),
)
if (fewer.length) console.log("  note: some recorded hits are gone — re-record to tighten the baseline")
console.log("surface-semantics: no surface started judging evidence past the recorded baseline")

