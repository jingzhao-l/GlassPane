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

/**
 * The kernel modules this lane needs, keyed by the name the driver uses. One table for
 * both the existence check below and the imports: the guard and the import could
 * otherwise drift apart, and the drift is the bug — an implementation missing a module
 * used to die in `import()` with a bare ERR_MODULE_NOT_FOUND *before* the "this kernel
 * is missing X" report at the bottom of the file could run. So the one message that
 * explains what is wrong was unreachable exactly when it was needed. Measured: pointing
 * `--impl` at a canonical checkout whose branch predates these modules produced
 * `Cannot find module '…/kernel/dist/decision-log.js'` and nothing else.
 */
const MODULES = {
  evidencePack: "evidence-pack",
  parse: "parse",
  decisionEntry: "decision-log-entry",
  decisionLog: "decision-log",
  evidenceDecision: "evidence-decision",
  dimension: "dimension-context",
  runPlan: "run-plan",
  invariantReport: "invariant-report",
  convergence: "convergence",
  provider: "provider-registration",
}

/** A directory with src/ is source; dist/ is built. Same rule for every module. */
function modulePath(dir, mod) {
  return existsSync(path.join(dir, "src", `${mod}.ts`)) ? `${dir}/src/${mod}.ts` : `${dir}/dist/${mod}.js`
}

/** Load one implementation's modules. Call `requireModules` first — this assumes they are there. */
async function loadImpl(label, dir) {
  const sub = (m) => modulePath(dir, m)
  const impl = { label }
  for (const [key, mod] of Object.entries(MODULES)) impl[key] = await import(sub(mod))
  return impl
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
  } else if (kind === "run-plan") {
    // A plan is only useful across the two shells if its digest is reproducible: the
    // ledger records the digest, so a consumer that computes a different one for the
    // same bytes breaks the audit link. Planned order is part of the answer, not
    // incidental — sorting it here would let a re-ordered plan pass as the same plan.
    const plan = impl.runPlan.RunPlanSchema.parse(fixture.input)
    out.push(impl.runPlan.runPlanDigest(plan))
    out.push(impl.runPlan.plannedIds(plan).join(","))
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
  } else if (kind === "invariant-report") {
    // Scenario 1's artifact: the report the other harness reads when a claim breaks.
    // The digest is the answer that matters across the boundary — a re-verification
    // cites the failure by digest — so it is driven, along with the verdict of every
    // case the fixture states (the refusals included: they are the contract's teeth).
    const report = impl.invariantReport.InvariantReportSchema.parse(fixture.input)
    out.push(impl.invariantReport.invariantReportDigest(report))
    out.push(impl.invariantReport.failingChecks(report).join(","))
    for (const item of fixture.cases ?? []) {
      let error = null
      let digest = ""
      try {
        const parsed = impl.invariantReport.InvariantReportSchema.parse(item.input)
        digest = impl.invariantReport.invariantReportDigest(parsed)
      } catch (caught) {
        error = caught
      }
      out.push(`${item.name}\t${error === null ? "accepted" : "refused"}${digest}`)
    }
    for (const item of fixture.reverificationCases ?? []) {
      let verdict = "accepted"
      let targets = ""
      try {
        const request = impl.invariantReport.reVerificationRequestFrom(report, item.targets)
        targets = request === null ? "null" : canonical(request.targets)
      } catch {
        verdict = "refused"
      }
      out.push(`${item.name}\t${verdict}${targets}`)
    }
  } else if (kind === "convergence") {
    // Scenario 4's rules. The point is that two harnesses agree on what happens next,
    // so every case's action AND reason are in the answer: the same action for a
    // different reason is a different decision, and a loop that disagrees about the
    // reason will disagree about the next round too.
    out.push(canonical(impl.convergence.convergenceDecision(fixture.input)))
    for (const item of fixture.cases ?? []) {
      let answer = ""
      try {
        answer = canonical(impl.convergence.convergenceDecision(item.state))
      } catch {
        answer = "refused"
      }
      out.push(`${item.name}\t${answer}`)
    }
  } else if (kind === "provider-registration") {
    // Scenario 5's metadata. Registration *semantics* are driven, not just the shape:
    // refusing an overwrite, refusing to guess on resolve, and the ids two harnesses
    // share are exactly the things that would otherwise drift per product.
    const provider = impl.provider.ProviderRegistrationSchema.parse(fixture.input)
    out.push(canonical(provider))
    for (const item of fixture.cases ?? []) {
      let verdict = "accepted"
      try {
        impl.provider.ProviderRegistrationSchema.parse(item.input)
      } catch {
        verdict = "refused"
      }
      out.push(`${item.name}\t${verdict}`)
    }
    const reg = fixture.registry ?? {}
    const build = (list) =>
      (list ?? []).reduce((acc, p) => impl.provider.registerProvider(acc, p), impl.provider.emptyProviderRegistry())
    const glasspane = build(reg.glasspane)
    const iterate = build(reg.iterate)
    out.push(`disjoint\t${impl.provider.providerIdsInCommon(glasspane, iterate).join(",")}`)
    const a = build(reg.collision?.a)
    const b = build(reg.collision?.b)
    out.push(`collision\t${impl.provider.providerIdsInCommon(a, b).join(",")}`)
    out.push(
      `offers\t${impl.provider.requireMethod(a, "glasspane-ae", "diagnose").requires.join(",")}|${impl.provider.requireMethod(b, "glasspane-ae", "diagnose").requires.join(",")}`,
    )
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
  "run-plan",
  "evidence-decision",
  "evidence-pack",
  "recipe-config",
  "decision-log-chain",
  "decision-log-entry",
  "invariant-report",
  "convergence",
  "provider-registration",
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
  if (kind === "run-plan" && (fixture.expectedDigest || fixture.expectedIds)) {
    checked++
    const plan = impl.runPlan.RunPlanSchema.parse(fixture.input)
    if (fixture.expectedDigest && impl.runPlan.runPlanDigest(plan) !== fixture.expectedDigest) {
      bad.push(`digest ${impl.runPlan.runPlanDigest(plan)} != the fixture's own ${fixture.expectedDigest}`)
    }
    if (fixture.expectedIds && impl.runPlan.plannedIds(plan).join(",") !== fixture.expectedIds.join(",")) {
      bad.push(`planned ids ${impl.runPlan.plannedIds(plan).join(",")} != ${fixture.expectedIds.join(",")}`)
    }
    for (const item of fixture.cases ?? []) {
      let error = null
      try {
        impl.runPlan.RunPlanSchema.parse(item.input)
      } catch (caught) {
        error = caught
      }
      if (item.expect === "refused" && error === null) bad.push(`${item.name}: accepted, the contract says refuse`)
      if (item.expect === "accepted" && error !== null) bad.push(`${item.name}: refused (${String(error?.message ?? error).slice(0, 80)})`)
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
  if (kind === "invariant-report") {
    // The fixture states its own answers for the reference report and for each case;
    // those are the oracle, so this lane can fail with no golden and no second
    // implementation present.
    if (fixture.expectedDigest || fixture.expectedFailingChecks || Array.isArray(fixture.cases)) {
      checked++
      const report = impl.invariantReport.InvariantReportSchema.parse(fixture.input)
      if (fixture.expectedDigest && impl.invariantReport.invariantReportDigest(report) !== fixture.expectedDigest) {
        bad.push(`digest ${impl.invariantReport.invariantReportDigest(report)} != the fixture's own ${fixture.expectedDigest}`)
      }
      if (fixture.expectedFailingChecks && impl.invariantReport.failingChecks(report).join(",") !== fixture.expectedFailingChecks.join(",")) {
        bad.push(`failing checks ${impl.invariantReport.failingChecks(report).join(",")} != ${fixture.expectedFailingChecks.join(",")}`)
      }
      if (fixture.passDigest && impl.invariantReport.invariantReportDigest(impl.invariantReport.InvariantReportSchema.parse(fixture.passInput)) !== fixture.passDigest) {
        bad.push("the passing report's digest moved")
      }
      if (fixture.errorDigest && impl.invariantReport.invariantReportDigest(impl.invariantReport.InvariantReportSchema.parse(fixture.errorInput)) !== fixture.errorDigest) {
        bad.push("the erroring report's digest moved")
      }
      for (const item of fixture.cases ?? []) {
        let error = null
        let parsed = null
        try {
          parsed = impl.invariantReport.InvariantReportSchema.parse(item.input)
        } catch (caught) {
          error = caught
        }
        if (item.expect === "refused" && error === null) bad.push(`${item.name}: accepted, the contract says refuse`)
        if (item.expect === "accepted" && error !== null) bad.push(`${item.name}: refused (${String(error?.message ?? error).slice(0, 80)})`)
        if (item.expect === "accepted" && parsed !== null && item.digest) {
          if (impl.invariantReport.invariantReportDigest(parsed) !== item.digest) bad.push(`${item.name}: digest moved`)
        }
        if (item.expect === "accepted" && parsed !== null && item.failingChecks) {
          if (impl.invariantReport.failingChecks(parsed).join(",") !== item.failingChecks.join(",")) bad.push(`${item.name}: failing checks differ`)
        }
      }
      // A pass must schedule nothing, and an error must refuse rather than launder.
      const passReport = impl.invariantReport.InvariantReportSchema.parse(fixture.passInput)
      if (impl.invariantReport.reVerificationRequestFrom(passReport, { dimensions: ["security"] }) !== null) {
        bad.push("a passing report produced a re-verification request")
      }
      let errored = null
      let threw = null
      try {
        errored = impl.invariantReport.reVerificationRequestFrom(impl.invariantReport.InvariantReportSchema.parse(fixture.errorInput), { dimensions: ["security"] })
      } catch (caught) {
        threw = caught
      }
      if (errored !== null || threw === null) bad.push("an error report did not refuse with a named code")
      if (threw !== null && threw.code !== "KERNEL_E_REVERIFY_UNMEASURED") bad.push(`error report refused with ${threw.code}, not KERNEL_E_REVERIFY_UNMEASURED`)
      for (const item of fixture.reverificationCases ?? []) {
        let error = null
        try {
          impl.invariantReport.reVerificationRequestFrom(report, item.targets)
        } catch (caught) {
          error = caught
        }
        if (item.expect === "refused" && error === null) bad.push(`target set ${item.name}: accepted, the contract says refuse`)
        if (item.expect === "accepted" && error !== null) bad.push(`target set ${item.name}: refused`)
      }
      if (fixture.request) {
        const built = impl.invariantReport.reVerificationRequestFrom(report, fixture.request.targets)
        if (canonical(built) !== canonical(fixture.request)) bad.push("the request the fixture states is not the request built from it")
      }
    }
  }
  if (kind === "convergence") {
    checked++
    const decision = impl.convergence.convergenceDecision(fixture.input)
    if (fixture.expectedDecision && canonical(decision) !== canonical(fixture.expectedDecision)) {
      bad.push(`decision ${canonical(decision)} != the fixture's own ${canonical(fixture.expectedDecision)}`)
    }
    for (const item of fixture.cases ?? []) {
      if (item.expect === "refused") {
        let error = null
        try {
          impl.convergence.convergenceDecision(item.state)
        } catch (caught) {
          error = caught
        }
        if (error === null) bad.push(`${item.name}: accepted, the contract says refuse`)
        continue
      }
      let answer = null
      try {
        answer = canonical(impl.convergence.convergenceDecision(item.state))
      } catch (caught) {
        bad.push(`${item.name}: refused (${String(caught?.message ?? caught).slice(0, 80)})`)
        continue
      }
      if (answer !== canonical(item.expect)) bad.push(`${item.name}: ${answer} != ${canonical(item.expect)}`)
    }
    // Completeness, not prose: every reason the rules can give must be exercised.
    const seen = new Set((fixture.cases ?? []).filter((c) => c.expect !== "refused").map((c) => c.expect.reason))
    if (fixture.expectedDecision) seen.add(fixture.expectedDecision.reason)
    const documented = Object.values(impl.convergence.CONVERGENCE_REASONS ?? {})
    if (documented.length === 0) bad.push("CONVERGENCE_REASONS is not exported, so completeness cannot be checked")
    const untested = documented.filter((r) => !seen.has(r))
    if (untested.length > 0) bad.push(`reasons with no case: ${untested.join(", ")}`)
  }
  if (kind === "provider-registration") {
    checked++
    const provider = impl.provider.ProviderRegistrationSchema.parse(fixture.input)
    if (fixture.expectedMethods && provider.methods.map((m) => m.name).join(",") !== fixture.expectedMethods.join(",")) {
      bad.push(`methods ${provider.methods.map((m) => m.name).join(",")} != ${fixture.expectedMethods.join(",")}`)
    }
    for (const item of fixture.cases ?? []) {
      let error = null
      try {
        impl.provider.ProviderRegistrationSchema.parse(item.input)
      } catch (caught) {
        error = caught
      }
      if (item.expect === "refused" && error === null) bad.push(`${item.name}: accepted, the contract says refuse`)
      if (item.expect === "accepted" && error !== null) bad.push(`${item.name}: refused (${String(error?.message ?? error).slice(0, 80)})`)
    }
    const reg = fixture.registry ?? {}
    const build = (list) =>
      (list ?? []).reduce((acc, p) => impl.provider.registerProvider(acc, p), impl.provider.emptyProviderRegistry())
    if (reg.glasspane && reg.iterate) {
      const common = impl.provider.providerIdsInCommon(build(reg.glasspane), build(reg.iterate))
      if (common.join(",") !== (reg.idsInCommon ?? []).join(",")) bad.push(`ids in common ${common.join(",")} != ${reg.idsInCommon?.join(",")}`)
      // The refusal has to be the *named* one, or "it threw something" would pass.
      let dup = null
      try {
        impl.provider.registerProvider(build(reg.glasspane), reg.glasspane[0])
      } catch (caught) {
        dup = caught
      }
      if (dup?.code !== impl.provider.PROVIDER_CODES.duplicateId) bad.push("re-registering an id did not raise KERNEL_E_PROVIDER_DUPLICATE")
    }
    if (reg.collision) {
      const common = impl.provider.providerIdsInCommon(build(reg.collision.a), build(reg.collision.b))
      if (common.join(",") !== reg.collision.expect.join(",")) bad.push(`collision ids ${common.join(",")} != ${reg.collision.expect.join(",")}`)
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
  parse: [
    "parseEvidencePack",
    "parseEvidencePackRead",
    "parseRecipeConfig",
    "parseDecisionLogEntry",
    "parseInvariantReport",
    "parseReverificationRequest",
    "parseRoundState",
    "parseProviderRegistration",
  ],
  decisionLog: ["serializeDecisionLogEntry", "decisionLogEntryHash"],
  evidenceDecision: ["decisionOutcomeFromEvidence", "decisionSummaryFromEvidence"],
  dimension: ["dimensionContext", "formatDimensionContext"],
  runPlan: ["plannedIds", "runPlanDigest"],
  invariantReport: ["invariantReportDigest", "failingChecks", "reVerificationRequestFrom"],
  convergence: ["convergenceDecision"],
  provider: ["emptyProviderRegistry", "registerProvider", "resolveProvider", "requireMethod", "providerIdsInCommon"],
}

/**
 * Things a module must also expose that are not functions. Kept apart from REQUIRED
 * because the two are checked differently: a zod schema is an object carrying `parse`,
 * and asking whether it `typeof === "function"` reports a working build as broken.
 */
const REQUIRED_SCHEMAS = {
  runPlan: ["RunPlanSchema"],
  invariantReport: ["InvariantReportSchema"],
  convergence: ["RoundStateSchema"],
  provider: ["ProviderRegistrationSchema"],
}

/**
 * Third kind of requirement: the constant maps an oracle iterates over. Neither a
 * function nor a schema, so they get their own check — otherwise a kernel that renamed
 * one surfaces as a TypeError and the driver gets blamed for the kernel's move.
 */
const REQUIRED_CONSTS = {
  convergence: ["CONVERGENCE_REASONS"],
  provider: ["PROVIDER_CODES"],
  invariantReport: ["REVERIFICATION_CODES"],
}

const loaded = []
for (const i of impls) {
  // Existence first, and out loud. Without this the run dies inside `import()` with a
  // bare ERR_MODULE_NOT_FOUND, which is the only form of failure that the "this kernel
  // is missing X" report below cannot reach.
  const absent = Object.values(MODULES).filter((mod) => !existsSync(modulePath(i.dir, mod)))
  if (absent.length > 0) {
    console.error(`kernel-conformance: ${i.label} does not provide these kernel modules: ${absent.join(", ")}`)
    console.error(`  looked under ${i.dir} for src/<module>.ts or dist/<module>.js`)
    console.error(`  The pinned artifact (iterate-kernel@${kernelVersion}) does ship them — a checkout that`)
    console.error("  lacks them is on a ref from before them, so it is not a second implementation of what")
    console.error("  the product depends on, and comparing it would prove nothing. contracts/kernel-pin.json")
    try {
      const pin = JSON.parse(readFileSync(path.join(repoRoot, "contracts", "kernel-pin.json"), "utf8"))
      console.error(`  records canonical ${pin.canonical?.repo}:${pin.canonical?.branch} for ${pin.version}; if this`)
      console.error(`  checkout is that ref, the pin's coordinates are not where the artifact was built,`)
      console.error(`  and that is the thing to fix before re-running the comparison.`)
    } catch {
      console.error("  records no readable contracts/kernel-pin.json, so which ref published the artifact is unknown.")
    }
    console.error("  Remedy: build the ref that published the pinned version and point --impl at that kernel/")
    console.error("  directory, or run this lane without --impl (the golden carries the recorded answers).")
    process.exit(3)
  }
  const impl = await loadImpl(i.label, i.dir)
  const missing = Object.entries(REQUIRED).flatMap(([mod, names]) =>
    names.filter((n) => typeof impl[mod]?.[n] !== "function").map((n) => `${mod}.${n}`),
  )
  // parseRunPlan is the entry point consumers actually call; assert it exists so a
  // kernel that ships the schema but forgets the parse wrapper cannot pass.
  if (typeof impl.parse?.parseRunPlan !== "function") missing.push("parse.parseRunPlan")
  const missingSchemas = Object.entries(REQUIRED_SCHEMAS).flatMap(([mod, names]) =>
    names.filter((n) => typeof impl[mod]?.[n]?.parse !== "function").map((n) => `${mod}.${n}.parse`),
  )
  const missingConsts = Object.entries(REQUIRED_CONSTS).flatMap(([mod, names]) =>
    names.filter((n) => impl[mod]?.[n] === undefined || typeof impl[mod][n] !== "object").map((n) => `${mod}.${n}`),
  )
  missing.push(...missingSchemas, ...missingConsts)
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
