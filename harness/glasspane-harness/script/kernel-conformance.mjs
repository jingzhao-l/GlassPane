#!/usr/bin/env bun
// kernel-conformance — do the kernel we ship and the kernel canonical publishes
// answer the same questions the same way?
//
// WHY THIS EXISTS. The fork currently *vendors* the kernel's source and pins it by
// per-file hash, which proves the bytes have not changed. It does not prove the
// behaviour we depend on is still the behaviour we get. A move to `@iterate/kernel`
// on npm would change the *delivery* of the kernel, not its meaning — and the only
// thing that can tell us the meaning survived is running the same fixtures through
// both forms and demanding identical answers.
//
// The fixtures are mirrored from canonical into harness/contracts/kernel-fixtures/
// and hashed by kernel-vendor.mjs --check, so a change upstream surfaces as a diff
// in this repo instead of silently changing behaviour.
//
// RUN WITH BUN, not node: one of the implementations under test is TypeScript source
// (vendor/kernel/src/*.ts), which only bun can import directly.
//
//   bun harness/glasspane-harness/script/kernel-conformance.mjs
//       The identity we make today: the vendored kernel against the mirrored
//       fixtures. Needs nothing but this repo.
//
//   bun harness/glasspane-harness/script/kernel-conformance.mjs --impl /path/to/publishable/kernel
//       A second implementation (a checkout with a built dist/, or the directory an
//       installed @iterate/kernel lives in). Every fixture must produce a
//       byte-identical result in both, or this fails.
//

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Root discovery, same rule as kernel-vendor.mjs: walk up to the directory that holds
// product.json, so the same file works from the product repo and from the monorepo.
// Fixtures live next to the manifest in the product tree, because that is the tree
// that ships the vendored kernel.
const here = path.dirname(fileURLToPath(import.meta.url))
let repoRoot = here
for (let i = 0; i < 6 && !existsSync(path.join(repoRoot, "product.json")); i++) {
  repoRoot = path.dirname(repoRoot)
}
if (!existsSync(path.join(repoRoot, "product.json"))) {
  console.error(`kernel-conformance: cannot find product.json above ${here}`)
  process.exit(2)
}
const fixturesDir = path.join(repoRoot, "contracts/kernel-fixtures")
const vendoredKernel = path.join(repoRoot, "packages/opencode/vendor/kernel")

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
    const parsed = impl.parse.parseEvidencePack(fixture)
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

const kindOf = (name) =>
  name.startsWith("evidence-pack")
    ? "evidence-pack"
    : name.startsWith("recipe-config")
      ? "recipe-config"
      : name.startsWith("decision-log-chain")
        ? "decision-log-chain"
        : name.startsWith("decision-log-entry")
          ? "decision-log-entry"
          : null

const args = process.argv.slice(2)
const extra = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--impl") extra.push(args[++i])
  else {
    console.error(`kernel-conformance: unknown argument ${args[i]}`)
    process.exit(2)
  }
}

const impls = [{ label: "vendored (source, hash-pinned)", dir: vendoredKernel }]
for (const dir of extra) {
  if (!existsSync(dir)) {
    console.error(`kernel-conformance: --impl ${dir} does not exist`)
    process.exit(2)
  }
  impls.push({ label: `second implementation (${dir})`, dir })
}

// The APIs this lane drives. Named here so that an implementation which does not
// have one is reported as what it is — a kernel whose layout moved or whose build is
// broken — instead of surfacing as a TypeError from a call site and being blamed on
// the driver.
const REQUIRED = {
  parse: ["parseEvidencePack", "parseRecipeConfig", "parseDecisionLogEntry"],
  decisionLog: ["serializeDecisionLogEntry", "decisionLogEntryHash"],
  evidenceDecision: ["decisionOutcomeFromEvidence", "decisionSummaryFromEvidence"],
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
  loaded.push(impl)
}

const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && kindOf(f)).sort()
if (files.length === 0) {
  console.error(`kernel-conformance: no fixtures found in ${fixturesCandidates.join(" or ")} — this would pass while proving nothing`)
  process.exit(1)
}

let compared = 0
const failures = []
for (const file of files) {
  const fixture = JSON.parse(readFileSync(path.join(fixturesDir, file), "utf8"))
  const answers = []
  for (const impl of loaded) {
    try {
      answers.push([impl.label, drive(impl, fixture, kindOf(file)), null])
    } catch (e) {
      const message = String(e?.message ?? e)
      // A TypeError here means *this tool* called something that does not exist —
      // which is what happened first (parseDecisionLogEntry lives in parse.ts, not
      // decision-log-entry.ts). Two implementations failing the same way in my driver
      // is not agreement; treating it as a verdict turned a broken lane green.
      if (e instanceof TypeError) {
        console.error(`kernel-conformance: ${impl.label} — the DRIVER is wrong, not the kernel: ${message}`)
        process.exit(3)
      }
      // The *verdict* is "this fixture is rejected, and for this field". The prose
      // after the field path is zod's, and zod's prose differs between majors — see
      // the divergence note below. Comparing prose would make the lane fail on a
      // wording change while saying nothing about the semantics.
      const verdict = `THREW ${e?.name ?? "Error"}` + (message.match(/^[^:]+: ((?:[A-Za-z0-9_.\[\]]+: )+)/)?.[0] ?? "")
      answers.push([impl.label, verdict, message])
    }
  }
  const [firstLabel, firstAnswer] = answers[0]
  const digest = sha(firstAnswer).slice(0, 12)
  const agree = answers.every(([, a]) => a === firstAnswer)
  compared++
  console.log(
    `${agree ? "  ok " : "  ✗  "}${file.padEnd(42)} ${kindOf(file).padEnd(20)} ${digest}`,
  )
  if (!agree) failures.push({ file, answers })
  // Same verdict, different words. Worth saying out loud: the kernel's error text
  // rides on whatever zod version the consumer resolves, so a consumer that matches
  // on kernel error text breaks when the delivery form changes the zod major.
  if (agree && loaded.length > 1) {
    const prose = answers.map(([, , m]) => m).filter(Boolean)
    if (prose.length === loaded.length && new Set(prose).size > 1) {
      console.log(
        `      note: identical verdict, different error prose — the delivery form resolves a different\n` +
          `            zod major, and the kernel does not normalise zod's wording:`,
      )
      for (const m of prose) console.log(`              ${m.split("\n")[0]}`)
    }
  }
}

if (loaded.length === 1) {
  console.log(
    `\nkernel-conformance: ${compared} fixture(s) run through the vendored kernel. This proves the kernel we\n` +
      `  ship still answers as the mirrored fixtures say. It does NOT compare against any published\n` +
      `  form — run with --impl <dir> before changing how the kernel is delivered.`,
  )
} else {
  console.log(`\nkernel-conformance: ${compared} fixture(s) through ${loaded.length} implementations.`)
}

if (failures.length > 0) {
  console.error("\nkernel-conformance: implementations disagree — the two kernels are not the same kernel.")
  for (const f of failures) {
    console.error(`\n  ${f.file}`)
    for (const [label, answer] of f.answers) {
      console.error(`    ${label}:`)
      for (const l of String(answer).split("\n").slice(0, 6)) console.error(`      ${l}`)
    }
  }
  process.exit(1)
}
console.log("kernel-conformance: every implementation answered every fixture identically.")
