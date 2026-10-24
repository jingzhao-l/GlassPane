#!/usr/bin/env node
/**
 * provider-surface-selftest.mjs — can the provider reconciliation gate still go red?
 *
 * Four controls, each one a different rule of `provider-surface.mjs`, driven by writing a real
 * mutation into a real tracked file, running the real ruler, requiring the *named* message, and
 * restoring by sha256. An exit code alone is not evidence: a ruler that fails for "cannot measure"
 * and a ruler that fails for "the surfaces diverged" would both answer non-zero, and only control 4
 * separates them — it deliberately breaks the runner's import so the measurement cannot happen, and
 * requires exit 2 with `NOT OBSERVED`. That is the same distinction this repo had to learn twice
 * (kernel-pin's exit-2 lane, and the 2026-10-16 incident where a green-looking lane had never
 * installed what the ruler reads).
 *
 * WHY ITS OWN FILE, AND WHY IT RUNS AFTER `bun install`. `rulers-selftest.mjs` runs before the fork
 * workspace is installed; a control that needs `bun` and a resolvable `iterate-kernel` would get
 * exit 2 there and be reported as a broken ruler rather than a passing control. So this battery is
 * a step of its own, placed right after the install steps that make the measurement possible —
 * which is exactly the ordering the redirect-policy selftest records in its own comment.
 *
 * Run from the repository root: `node harness/tools/provider-surface-selftest.mjs`.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")

const RULER = "harness/tools/provider-surface.mjs"
const SURFACE_A = "mcp-shell/src/providers.ts"
const SURFACE_B = "harness/glasspane-harness/packages/opencode/src/tool/glasspane/providers.ts"
const GOLDEN = "harness/contracts/provider-surface.json"
const RUNNER = "harness/tools/provider-surface-runner.ts"

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex")

// The battery edits tracked files. Refusing a dirty tree is not ceremony: a half-finished edit
// from another lane would be restored over by this script's `finally`, and the loss would look
// like it came from the test.
const dirty = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
if (dirty.length > 0) {
  console.error("provider-surface-selftest: refusing to start — this battery mutates tracked files and the worktree is not clean.")
  console.error(`  dirty: ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? " …" : ""}`)
  process.exit(2)
}

let failures = 0
const bad = (message) => {
  console.error(`FAIL ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok    ${message}`)

function runRuler() {
  try {
    return { rc: 0, text: execFileSync(process.execPath, [RULER, "--check"], { cwd: repoRoot, encoding: "utf8" }) }
  } catch (error) {
    return { rc: error.status ?? 1, text: `${error.stdout ?? ""}${error.stderr ?? ""}` }
  }
}

function mustGoRed(label, file, find, replace, expectRc, names, mustNot = []) {
  const abs = path.join(repoRoot, file)
  if (!existsSync(abs)) {
    bad(`${label}: ${file} is not in the tree — the control measured nothing`)
    return
  }
  const original = readFileSync(abs)
  const before = sha(original)
  const started = failures
  const text = original.toString("utf8")
  if (!text.includes(find)) {
    bad(`${label}: anchor '${find.slice(0, 60)}' is not in ${file} — the mutation never landed, so a green here would be a lie`)
    return
  }
  try {
    writeFileSync(abs, text.replace(find, replace))
    const got = runRuler()
    if (got.rc !== expectRc) bad(`${label}: exited ${got.rc}, expected ${expectRc}\n${got.text.slice(0, 900)}`)
    for (const needle of names) {
      if (!got.text.includes(needle)) bad(`${label}: exited ${got.rc} but never named "${needle}" — a red that does not name its rule is not a control\n${got.text.slice(0, 900)}`)
    }
    for (const needle of mustNot) {
      if (got.text.includes(needle)) bad(`${label}: also reported "${needle}", so the two rules are not answering independently`)
    }
    if (failures === started) ok(`${label}: exit ${got.rc}, named as expected`)
  } finally {
    writeFileSync(abs, original)
    if (sha(readFileSync(abs)) !== before) bad(`${label}: RESTORE FAILED — ${file} is not the bytes this control found`)
  }
}

console.log("provider-surface-selftest — each rule is driven once, named, and restored by sha256")

const baseline = runRuler()
if (baseline.rc !== 0) {
  bad(`baseline: provider-surface --check exited ${baseline.rc} on an unmutated tree — the controls below cannot be attributed to their mutations\n${baseline.text.slice(0, 900)}`)
} else {
  ok("baseline: exit 0 on the unmutated tree")
}

// 1. overlap-agreement — the duplicated half of the claim drifting on one surface.
mustGoRed(
  "overlap-agreement",
  SURFACE_A,
  '{ name: "diagnose", requires: ["ax-event", "attribution", "circuit-breaker"] }',
  '{ name: "diagnose", requires: ["ax-event", "attribution"] }',
  1,
  ["overlap-agreement: 'glasspane-engine-ae/diagnose'"],
  ["provider-identity", "asymmetry-ledger"],
)

// 2. provider-identity — the two surfaces stop naming the same producer.
mustGoRed(
  "provider-identity",
  SURFACE_B,
  'export const GLASSPANE_AE_PROVIDER_ID = "glasspane-engine-ae"',
  'export const GLASSPANE_AE_PROVIDER_ID = "harness-engine-ae"',
  1,
  ["provider-identity"],
)

// 3. asymmetry-ledger — the golden claims a one-sided method that is not there.
mustGoRed(
  "asymmetry-ledger",
  GOLDEN,
  '"harness:glasspane-engine-ae/diagnose-pixel"',
  '"harness:glasspane-engine-ae/diagnose-pixel", "shell:glasspane-evidence/selftest-ghost"',
  1,
  ["asymmetry-ledger"],
)

// 4. cannot-measure-is-not-a-pass — the runner stops resolving one surface: exit 2, and it must
// NOT answer as if it had compared anything.
mustGoRed(
  "cannot-measure-is-not-a-pass",
  RUNNER,
  "shellProviderDrafts",
  "shellProviderDraftsRenamedBySelftest",
  2,
  ["NOT OBSERVED"],
  ["no divergence", "the two surfaces' provider registrations no longer reconcile"],
)

if (failures > 0) {
  console.error(`provider-surface-selftest: ${failures} control(s) failed to behave as claimed`)
  process.exit(1)
}
console.log("provider-surface-selftest: every rule named its own reason; the unmeasurable case refuses rather than passing")
