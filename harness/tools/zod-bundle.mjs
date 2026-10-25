#!/usr/bin/env node
/*
 * zod-bundle — which zod copies reach the shipped bundle, and is each one accounted for?
 *
 * WHY. The dependency bump that closed the two GlassPane Dependabot alerts (GHSA-mrhx-c7xc-m3w5,
 * fixed only in zod 4.6.6) moved the copy our code imports. It did not move the copies the bundle
 * still carries: measured 2026-10-24 with `zod-bundle-probe.ts`, the release graph bundles
 * `zod@3.25.76` (through `gitlab-ai-provider`, which pins `^3.25.76`) and `zod@4.4.3` (through
 * `@modelcontextprotocol/sdk`, whose range is `^3.25 || ^4.0`) beside `zod@4.6.7`. Both are inside
 * the advisory's `< 4.6.6`. The sentence "those are not the copy we import" is true and incomplete:
 * bundling makes them part of what ships, because `script/build.ts` bundles everything but
 * `node-gyp` and the provider is imported by a literal specifier.
 *
 * WHAT THIS GATE DOES AND DOES NOT DECIDE. It does not force a third-party package onto a zod major
 * it did not declare — that is a runtime-shape decision about someone else's code, and the provider's
 * own tests are network-red on this machine, so it could not be verified here. What it does is make
 * the exposure a measured quantity with named causes, so:
 *   · a NEW zod copy entering the bundle is red until it is attributed with a reason;
 *   · every run states how many bundled copies are below the fixed version, so the number cannot be
 *     quietly re-baselined by whoever finds it annoying;
 *   · a copy leaving the bundle is NOT red (that is the fix landing) but is reported, because an
 *     out-of-date account is how the next person misreads the graph.
 *
 * Exit codes: 0 accounted for, 1 an unattributed copy (or a stale account the run flags),
 * 2 cannot measure — no bun, the probe refused, or no contract to compare against.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
// Two seams, both so the verdict logic can be driven without touching the tree or rebuilding: a
// reading may be supplied from a file, and the contract it is compared against may be pointed at.
// The defaults are the real ones — CI and a reader on a checkout pass neither.
const jsonArg = argv.indexOf("--reading")
const contractArg = argv.indexOf("--contract")
const contractPath = contractArg === -1 ? path.join(here, "..", "contracts", "zod-bundle.json") : path.resolve(argv[contractArg + 1] ?? "")
const probePath = path.join(here, "zod-bundle-probe.ts")
const check = argv.includes("--check") || jsonArg === -1

function refuse(message) {
  console.error(`zod-bundle: CANNOT MEASURE — ${message}`)
  process.exit(2)
}

let reading
if (jsonArg !== -1) {
  const file = argv[jsonArg + 1]
  if (!file || !existsSync(file)) refuse(`--check/--reading names no file (${file ?? "(nothing)"}), so no bundle was observed`)
  reading = readFileSync(file, "utf8")
} else {
  if (!existsSync(probePath)) refuse(`${path.relative(here, probePath)} is not in the tree — there is nothing to ask`)
  const bun = spawnSync("bun", [probePath], { encoding: "utf8", cwd: here })
  if (bun.error && bun.error.code === "ENOENT") refuse("`bun` is not on PATH; the bundle question can only be asked of bun's bundler — run this in the `harness-rulers` job, which installs the pinned bun")
  const out = (bun.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{"))
  if (!out.length) refuse(`the probe returned no reading (rc=${bun.status}): ${(bun.stderr ?? "").trim().split("\n").slice(-3).join(" / ")}`)
  reading = out[out.length - 1]
}

let observed
try {
  observed = JSON.parse(reading)
} catch (cause) {
  refuse(`the probe's reading is not JSON (${String(cause).split("\n")[0]})`)
}
if (!observed.copies || typeof observed.copies !== "object" || Object.keys(observed.copies).length === 0) {
  refuse("the reading carries no zod copies — the probe measured a graph without zod, which is not this product")
}
if (!existsSync(contractPath)) refuse(`${path.relative(here, contractPath)} is not in the tree — with nothing recorded, every copy would look like a new one`)
const contract = JSON.parse(readFileSync(contractPath, "utf8"))
const fixedIn = contract.advisory?.fixedIn
if (!/^\d+\.\d+\.\d+$/.test(String(fixedIn))) refuse("the contract names no `advisory.fixedIn`, so \"vulnerable\" would be an opinion rather than a comparison")

const below = (version) => {
  const nums = /^zod@(\d+)\.(\d+)\.(\d+)/.exec(version)
  const want = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(fixedIn))
  if (!nums || !want) return null
  const a = nums.slice(1).map(Number)
  const b = want.slice(1).map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return false
}

const recorded = new Map((contract.copies ?? []).map((c) => [c.copy, c]))
const seen = Object.keys(observed.copies)
let failures = 0
const flagged = []

for (const copy of seen) {
  const entry = recorded.get(copy)
  const vulnerable = below(copy)
  if (vulnerable === null) {
    failures += 1
    console.log(`FAIL  ${copy} is not a version this gate can order against ${fixedIn} — a copy it cannot rank is not a copy it can excuse`)
    continue
  }
  if (!entry) {
    failures += 1
    console.log(`FAIL  ${copy} reaches the bundle and is not attributed in harness/contracts/zod-bundle.json (${observed.copies[copy]} module file(s)) — name which package pulls it in and why it is allowed to ship, or take it out of the graph`)
    continue
  }
  if (entry.vulnerable !== vulnerable) {
    failures += 1
    console.log(`FAIL  ${copy} is recorded with vulnerable=${entry.vulnerable} but compares against the fixed version ${fixedIn} as ${vulnerable} — the account and the arithmetic disagree`)
    continue
  }
  if (entry.modules !== observed.copies[copy]) {
    flagged.push(`${copy}: recorded ${entry.modules} module file(s), now ${observed.copies[copy]} (growth is the graph moving; the set of copies is what this gate holds)`)
  }
}
for (const copy of recorded.keys()) {
  if (seen.includes(copy)) continue
  flagged.push(`${copy}: the contract still accounts for it and the bundle no longer carries it — that is the fix landing; update the record so it stops describing a graph that is gone`)
}

const vulnerableShipped = seen.filter((c) => below(c))
console.log(`zod-bundle — ${seen.length} zod copy(ies) reach the bundle: ${seen.map((c) => `${c} (${observed.copies[c]})`).join(", ")}`)
console.log(`  advisory ${contract.advisory?.id ?? "(unnamed)"}: fixed in ${fixedIn}; ${vulnerableShipped.length} bundled copy(ies) below it${vulnerableShipped.length ? `: ${vulnerableShipped.join(", ")}` : ""}`)
console.log(`  inputs: entrypoints ${JSON.stringify(observed.entrypoints)}; dropped ${JSON.stringify(observed.dropped)}; external ${JSON.stringify(observed.external)}`)
for (const line of flagged) console.log(`  △ ${line}`)
if (failures > 0) {
  console.error(`zod-bundle: ${failures} unattributed or contradictory copy(ies) — ${check ? "this is the verdict, not a warning" : ""}`)
  process.exit(1)
}
if (vulnerableShipped.length > 0) {
  console.log(`zod-bundle: accounted for, not clean — ${vulnerableShipped.length} vulnerable copy(ies) ship because removing them means deciding a third party's zod major. Reasons are in the contract.`)
  process.exit(0)
}
console.log("zod-bundle: every zod copy in the bundle is attributed and none is below the fixed version")
process.exit(0)
