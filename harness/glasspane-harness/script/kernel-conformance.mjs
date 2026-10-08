#!/usr/bin/env bun
// kernel-conformance — does the kernel we install answer the questions the contract
// says it answers?
//
// WHY THIS EXISTS. `kernel-pin.mjs --check` proves the installed bytes are the bytes we
// recorded. Bytes are not behaviour: the thing the two shells depend on is that the same
// fixture produces the same verdict, the same transcription and the same chain hash —
// because that answer is also what iterate-harness (Python) and the Swift engine reproduce
// from the same corpus. So this lane *runs* the corpus through the kernel and compares.
//
// The corpus is no longer mirrored into this repo. It ships inside `iterate-kernel`
// (`fixtures/`), pinned by sha256 in `contracts/kernel-pin.json` — a mirror was a second
// source of truth, and it had already drifted (9 files here, 11 published).
//
// RUN WITH BUN, not node: a second implementation may be TypeScript *source* (a canonical
// kernel checkout without a build), which only bun can import directly.
//
//   bun harness/glasspane-harness/script/kernel-conformance.mjs
//       The identity we make today: the installed package against its own shipped corpus.
//       Needs nothing but this repo.
//
//   bun harness/glasspane-harness/script/kernel-conformance.mjs --impl /path/to/kernel
//       A second implementation (a canonical checkout with src/, or another build). Every
//       fixture must produce a byte-identical answer in both, or this fails — that is the
//       check to run *before* bumping the kernel version.
//

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Root discovery, same rule as kernel-pin.mjs: walk up to the directory that holds
// product.json, so the same file works from the product repo and from the monorepo.
const here = path.dirname(fileURLToPath(import.meta.url))
let repoRoot = here
for (let i = 0; i < 6 && !existsSync(path.join(repoRoot, "product.json")); i++) {
  repoRoot = path.dirname(repoRoot)
}
if (!existsSync(path.join(repoRoot, "product.json"))) {
  console.error(`kernel-conformance: cannot find product.json above ${here}`)
  process.exit(2)
}

/** The installed `iterate-kernel`: bun hoists, so it may sit at either level. */
function installedKernel() {
  const candidates = [
    path.join(repoRoot, "node_modules/iterate-kernel"),
    path.join(repoRoot, "packages/opencode/node_modules/iterate-kernel"),
  ]
  const found = candidates.filter((dir) => existsSync(path.join(dir, "package.json")))
  if (found.length === 0) {
    console.error(
      "kernel-conformance: iterate-kernel is not installed — run `bun install`. This lane must not fall back to a local copy: the point is to measure what the product actually resolves.",
    )
    process.exit(2)
  }
  if (found.length > 1 && readFileSync(path.join(found[0], "package.json"), "utf8") !== readFileSync(path.join(found[1], "package.json"), "utf8")) {
    console.error(`kernel-conformance: two different iterate-kernel installs (${found.join(", ")}) — which one does the product resolve?`)
    process.exit(2)
  }
  return found[0]
}

const kernelDir = installedKernel()
const kernelVersion = JSON.parse(readFileSync(path.join(kernelDir, "package.json"), "utf8")).version
const fixturesDir = path.join(kernelDir, "fixtures")

/** Canonical JSON: keys sorted, no insignificant whitespace. Byte equality or nothing. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
}

const sha = (text) => createHash("sha256").update(text).digest("hex")

/** Load one implementation's modules. A directory with src/ is source; dist/ is built. */
async function loadImpl(label, dir) {
  const sub = (m) =>
    existsSync(path.join(dir, "src", `${m}.ts`)) ? `${dir}/src/${m}.ts` : `${dir}/dist/${m}.js`
  return {
    label,
    evidencePack: await import(sub("evidence-pack")),
    parse: await import(sub("parse")),
    decisionEntry: await import(sub("decision-log-entry")),
    decisionLog: await import(sub("decision-log")),
    evidenceDecision: await import(sub("evidence-decision")),
    dimension: await import(sub("dimension-context")),
  }
}

/**
 * Drive one fixture through an implementation and return the answer as text.
 *
 * Every call here is a pure function. Nothing reads a clock, generates an id, or
 * touches the filesystem — otherwise two runs of the same implementation would
 * disagree with each other and the comparison would prove nothing.
 */
function drive(impl, fixture, kind) {
  const out = []
  if (kind === "evidence-pack") {
    // The read-side parser is the contract the product actually consumes: evidence lands
    // on disk from the Swift engine and is re-read through it (readEvidenceFrame does
    // exactly this). The strict parser refuses two of the shipped fixtures for reasons
    // that are the point of those fixtures — a draft schemaVersion and a null pixel
    // bounds — so driving it here would pin "rejected" and call that conformance.
    const parsed = impl.parse.parseEvidencePackRead(fixture)
    out.push(canonical(parsed))
    // The transcription is the part this product actually depends on: engine verdict
    // in, decision outcome and human summary out.
    out.push(impl.evidenceDecision.decisionOutcomeFromEvidence(parsed))
    out.push(impl.evidenceDecision.decisionSummaryFromEvidence(parsed))
  } else if (kind === "recipe-config") {
    out.push(canonical(impl.parse.parseRecipeConfig(fixture)))
  } else if (kind === "decision-log-entry") {
    const entry = impl.parse.parseDecisionLogEntry(fixture)
    out.push(canonical(entry))
    // Determinism stated as an invariant rather than a hope: the serialized bytes of
    // an entry ARE its canonical form, because a line's hash is what the next entry
    // chains onto.
    out.push(impl.decisionLog.serializeDecisionLogEntry(entry))
    out.push(impl.decisionLog.decisionLogEntryHash(entry))
  } else if (kind === "dimension-context") {
    // The fork renders this into a compacted session, and iterate-harness re-implements
    // the same arithmetic in Python. Both must land on the same line, so the answer here
    // is the structure *and* the sentence.
    const context = impl.dimension.dimensionContext(fixture.input)
    out.push(canonical(context))
    out.push(impl.dimension.formatDimensionContext(context))
    out.push(context.totals.verified + context.totals.unverified === context.totals.planned ? "totals-consistent" : "totals-BROKEN")
  } else if (kind === "evidence-decision") {
    // A case list: each entry is a pack plus the outcome and sentence the transcription
    // must produce. Driving all of them into the answer is what makes the digest protective;
    // the fixture's own expectations are asserted separately as an oracle below.
    for (const item of fixture.cases) {
      const pack = impl.parse.parseEvidencePackRead(item.input)
      out.push(`${item.name}\t${impl.evidenceDecision.decisionOutcomeFromEvidence(pack)}`)
      out.push(`${item.name}\t${impl.evidenceDecision.decisionSummaryFromEvidence(pack)}`)
    }
  } else if (kind === "decision-log-chain") {
    // The fixture is a cross-implementation anchor: `lines` are canonical entries and
    // `hashes` are their chain hashes. Re-deriving both is what proves an
    // implementation agrees with the anchor — including the prevEntryHash linkage.
    let prev = ""
    fixture.lines.forEach((line, i) => {
      const entry = impl.parse.parseDecisionLogEntry(JSON.parse(line))
      const recomputed = impl.decisionLog.decisionLogEntryHash(entry)
      if (recomputed !== fixture.hashes[i]) out.push(`hash[${i}]=${recomputed}`)
      if (entry.prevEntryHash !== prev) out.push(`link[${i}]=${entry.prevEntryHash}`)
      out.push(impl.decisionLog.serializeDecisionLogEntry(entry))
      prev = recomputed
    })
  }
  return out.join("\n")
}

/**
 * Which fixtures this lane drives, in prefix order. A shipped fixture that matches no kind
 * here is a contract nobody checks — which is exactly how `dimension-context` sat unused for
 * a release, so the corpus count in `kernel-pin.json` and the driven count printed below are
 * compared on every run rather than trusted to line up.
 */
const KINDS = [
  "dimension-context",
  "evidence-decision",
  "evidence-pack",
  "recipe-config",
  "decision-log-chain",
  "decision-log-entry",
]

const kindOf = (name) => KINDS.find((kind) => name.startsWith(kind)) ?? null

const args = process.argv.slice(2)
const mode = args.includes("--record") ? "record" : "check"
const extra = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === "--impl") extra.push(args[++i])
  else if (a === "--record") continue
  else {
    console.error(`kernel-conformance: unknown argument ${a}`)
    process.exit(2)
  }
}

// WHY A GOLDEN. Without --impl there is exactly one implementation on the table, and
// comparing its answers to itself is a tautology: `agree` was always true, and that is how
// this lane ran in CI while being unable to fail (a 2026-10-09 review named it). The fix is
// not more prose — it is to record what the answers were and demand the same answers next
// time. A kernel that changes behaviour then shows up as a digest mismatch at the version
// bump, instead of as a green check that measured nothing.
const goldenFile = path.join(repoRoot, "contracts", "kernel-conformance.json")

/**
 * Expectations a fixture carries by itself. `dimension-context` states `expected` and
 * `expectedLine`; `evidence-decision` states a `cases[]` list of packs with the outcome and
 * sentence each must transcribe to. Those are oracles — an implementation is compared against
 * a stated answer, not against its own yesterday.
 */
function oracleFailures(impl, fixture, kind) {
  const bad = []
  let checked = 0
  if (kind === "dimension-context" && (fixture.expected || fixture.expectedLine)) {
    checked++
    const context = impl.dimension.dimensionContext(fixture.input)
    if (fixture.expected && canonical(context) !== canonical(fixture.expected)) {
      bad.push("dimension-context structure != the fixture's own `expected`")
    }
    if (fixture.expectedLine && impl.dimension.formatDimensionContext(context) !== fixture.expectedLine) {
      bad.push(`rendered line != expectedLine:\n      got      ${impl.dimension.formatDimensionContext(context)}\n      expected ${fixture.expectedLine}`)
    }
  }
  if (kind === "evidence-decision" && Array.isArray(fixture.cases)) {
    checked += fixture.cases.length
    for (const item of fixture.cases) {
      const pack = impl.parse.parseEvidencePackRead(item.input)
      const outcome = impl.evidenceDecision.decisionOutcomeFromEvidence(pack)
      const summary = impl.evidenceDecision.decisionSummaryFromEvidence(pack)
      if (outcome !== item.expectedOutcome) bad.push(`${item.name}: outcome ${outcome} != ${item.expectedOutcome}`)
      if (summary !== item.expectedSummary) bad.push(`${item.name}: summary differs\n      got      ${summary}\n      expected ${item.expectedSummary}`)
    }
  }
  return { checked, violations: bad }
}

const impls = [{ label: `installed (iterate-kernel@${kernelVersion}, dist)`, dir: kernelDir, primary: true }]
for (const dir of extra) {
  if (!existsSync(dir)) {
    console.error(`kernel-conformance: --impl ${dir} does not exist`)
    process.exit(2)
  }
  impls.push({ label: `second implementation (${dir})`, dir, primary: false })
}

// The APIs this lane drives. Named here so that an implementation which does not
// have one is reported as what it is — a kernel whose layout moved or whose build is
// broken — instead of surfacing as a TypeError from a call site and being blamed on
// the driver.
const REQUIRED = {
  parse: ["parseEvidencePack", "parseEvidencePackRead", "parseRecipeConfig", "parseDecisionLogEntry"],
  decisionLog: ["serializeDecisionLogEntry", "decisionLogEntryHash"],
  evidenceDecision: ["decisionOutcomeFromEvidence", "decisionSummaryFromEvidence"],
  dimension: ["dimensionContext", "formatDimensionContext"],
}

const loaded = []
for (const i of impls) {
  const impl = await loadImpl(i.label, i.dir)
  const missing = Object.entries(REQUIRED).flatMap(([mod, names]) =>
    names.filter((n) => typeof impl[mod]?.[n] !== "function").map((n) => `${mod}.${n}`),
  )
  if (missing.length > 0) {
    console.error(`kernel-conformance: ${i.label} is missing ${missing.join(", ")}`)
    console.error("  Either the kernel moved a function, or this is a broken/incomplete build.")
    process.exit(3)
  }
  loaded.push({ ...i, impl })
}

const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && kindOf(f)).sort()
if (files.length === 0) {
  console.error(`kernel-conformance: no contract fixtures found in ${fixturesDir} — this lane would run green while measuring nothing`)
  process.exit(1)
}

const golden = existsSync(goldenFile) ? JSON.parse(readFileSync(goldenFile, "utf8")) : null
if (mode === "check" && !golden) {
  console.error(`kernel-conformance: no golden at ${goldenFile}. With one implementation there is nothing to`)
  console.error("  compare against, and running anyway would be a green that proves nothing. Run --record once,")
  console.error("  on a kernel you have reviewed, and commit the file with the dependency bump that needs it.")
  process.exit(1)
}

const recorded = {}
const failures = []
let compared = 0
for (const file of files) {
  const fixture = JSON.parse(readFileSync(path.join(fixturesDir, file), "utf8"))
  const kind = kindOf(file)
  const answers = []
  const oracle = []
  for (const entry of loaded) {
    try {
      answers.push([entry.label, entry.dir, drive(entry.impl, fixture, kind), null])
      oracle.push([entry.label, oracleFailures(entry.impl, fixture, kind)])
    } catch (e) {
      const message = String(e?.message ?? e)
      // A TypeError here means *this tool* called something that does not exist —
      // which is what happened first (parseDecisionLogEntry lives in parse.ts, not
      // decision-log-entry.ts). Two implementations failing the same way in my driver
      // is not agreement; treating it as a verdict turned a broken lane green.
      if (e instanceof TypeError) {
        console.error(`kernel-conformance: ${entry.label} — the DRIVER is wrong, not the kernel: ${message}`)
        process.exit(3)
      }
      // The *verdict* is "this fixture is rejected, and for this field". The prose
      // after the field path is zod's, and zod's prose differs between majors — see the
      // divergence note below. Comparing prose would make the lane fail on a wording
      // change while saying nothing about the semantics.
      const verdict = `REJECTED ${e?.name ?? "Error"}` + (message.match(/^[^:]+: ((?:[A-Za-z0-9_.\[]]+: )+)/)?.[0] ?? "")
      answers.push([entry.label, entry.dir, verdict, message])
      oracle.push([entry.label, []])
    }
  }
  const [primaryLabel, primaryDir, primaryAnswer, primaryError] = answers[0]
  const digest = sha(primaryAnswer).slice(0, 12)
  const rejected = primaryError !== null
  const oracles = oracle.filter(([, r]) => r.checked > 0)
  const oracleViolations = oracles.flatMap(([, r]) => r.violations)
  const disagree = answers.slice(1).filter(([, , a]) => a !== primaryAnswer)

  // What gets asserted depends on what the fixture can assert. An oracle is a stated
  // answer; a golden is yesterday's answer; a second implementation is somebody else's
  // answer today. Saying "ok" without one of those three is the tautology this rewrite
  // exists to remove, so the line names which of the three it checked.
  const basis = oracles.length > 0 ? "oracle" : golden?.answers?.[file] ? "golden" : "none"
  const marks = []
  if (oracles.length > 0) marks.push("oracle")
  if (golden?.answers?.[file]) marks.push("golden")
  if (answers.length > 1) marks.push(`impl×${answers.length}`)
  const verdictTag = rejected ? "rejected" : "answered"
  console.log(
    `  ${(oracles.length === 0 && basis !== "golden" ? "?!" : "  ok").padEnd(3)} ${file.padEnd(42)} ${kind.padEnd(20)} ${digest}  ${verdictTag} [${marks.join("+") || "nothing"}]`,
  )
  compared++
  recorded[file] = { kind, digest, verdict: rejected ? "rejected" : "answered" }

  for (const [label, result] of oracles)
    for (const v of result.violations) failures.push(`${file}: ${label} violates the fixture's own expectations — ${v}`)
  if (golden && mode === "check") {
    const was = golden.answers?.[file]
    if (!was) failures.push(`${file}: present in the package but not in the golden — a new fixture is unpinned`)
    else if (was.digest !== digest) failures.push(`${file}: digest ${digest} != recorded ${was.digest} (${was.verdict} ${was.kind}) — behaviour moved`)
    else if (was.verdict !== recorded[file].verdict) failures.push(`${file}: verdict changed (${was.verdict} → ${recorded[file].verdict}) at the same digest — impossible, investigate`)
  }
  for (const [label, , answer] of disagree) {
    failures.push(`${file}: ${label} disagrees with the installed kernel\n    installed: ${String(primaryAnswer).split("\n")[0]}…\n    ${label}: ${String(answer).split("\n")[0]}…`)
  }
  if (answers.length > 1) {
    // Same verdict, different words. Worth saying out loud: the kernel's error text rides
    // on whatever zod version the consumer resolves, so a consumer that matches on kernel
    // error text breaks when the delivery form changes the zod major.
    const prose = answers.map(([, , , m]) => m).filter(Boolean)
    if (prose.length === answers.length && new Set(prose).size > 1) {
      console.log(
        `      note: identical verdict, different error prose — the delivery form resolves a different\n` +
          `            zod major, and the kernel does not normalise zod's wording:`,
      )
      for (const m of prose) console.log(`              ${m.split("\n")[0]}`)
    }
  }
}

if (golden && mode === "check") {
  const undriven = readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && !kindOf(f))
  for (const f of undriven) {
    if (f === "manifest.json") continue
    failures.push(`${f}: shipped by the package but this lane drives no kind for it — add the prefix to KINDS or say why not`)
  }
  for (const file of Object.keys(golden.answers ?? {})) {
    if (!recorded[file]) failures.push(`${file}: in the golden but no longer shipped by the package — the corpus shrank`)
  }
}

if (mode === "record") {
  const body = {
    _comment:
      "What the shipped kernel answers, per contract fixture. Written by script/kernel-conformance.mjs --record and asserted by the default (CI) mode. A digest mismatch is not automatically a regression: it means the answer moved, and the person bumping the kernel decides whether that is the point. What this file makes impossible is the lane running green while comparing an implementation to itself.",
    kernel: { package: "iterate-kernel", version: kernelVersion, pinnedBy: "contracts/kernel-pin.json" },
    answers: recorded,
  }
  if (failures.length > 0) {
    console.error("\nkernel-conformance: refusing to record while the fixture's own expectations are violated:")
    for (const f of failures) console.error(`  ✗ ${f}`)
    process.exit(1)
  }
  writeFileSync(goldenFile, `${JSON.stringify(body, null, 2)}\n`)
  console.log(`\nkernel-conformance: recorded ${compared} fixture(s) against iterate-kernel@${kernelVersion}.`)
  process.exit(0)
}

if (failures.length > 0) {
  console.error(`\nkernel-conformance: ${failures.length} problem(s) across ${compared} fixture(s).`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error("\n  If a behaviour change is intended, review it and re-record: bun script/kernel-conformance.mjs --record")
  process.exit(1)
}

const oraclesChecked = files.length
console.log(
  `\nkernel-conformance: ${oraclesChecked} fixture(s) through ${loaded.length} implementation(s) against the golden at ${path.relative(repoRoot, goldenFile)}.`,
)
console.log("kernel-conformance: every shipped fixture answered as recorded, and every stated expectation held.")
