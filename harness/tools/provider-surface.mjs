#!/usr/bin/env node
/**
 * provider-surface.mjs — the two tool surfaces' provider registrations, reconciled.
 *
 * WHY. 综述 §8.5 row 5 (R40 场景⑤) promises "AE 判定按 kernel provider 注册契约注册，两侧 harness
 * 以同一契约消费". Both halves exist and both are consumed on their own surface —
 * `packages/opencode/src/tool/glasspane/providers.ts` (面 B) and
 * `mcp-shell/src/providers.ts` (面 A) each build a registry through the kernel
 * (`parseProviderRegistration` → `registerProvider`), and each surface's own tests only ever
 * compare it against itself. That leaves the one relationship the scenario is actually about
 * unguarded: the claims the two surfaces make **about the same provider method** are typed twice,
 * by hand, in two files, in two languages of build. Nothing noticed when a `requires` list moves
 * on one side, and nothing would notice a new judgment method appearing on one surface only.
 *
 * WHAT IT MEASURES. Not text — the drafts the kernel accepts, emitted by
 * `harness/tools/provider-surface-runner.ts` importing both modules. A grep would agree with a
 * draft the kernel refuses to register, and would break on a reformat that changes no claim.
 * The version string is normalised to `"probe"` because the two products release on separate
 * version lines; comparing those numbers would go red every release for no reason.
 *
 * RULES (calibre recorded in the golden so a re-record is reviewable):
 *   provider-identity   both surfaces must register the same set of provider ids. Different ids
 *                       means two different producers claim to be GlassPane's AE, which the
 *                       kernel contract cannot express and the reader cannot recover.
 *   overlap-agreement   for every (provider id, method) declared on BOTH surfaces, the
 *                       prerequisite list must be the same set. This is the duplicated half —
 *                       the drift the file's existence is justified by.
 *   asymmetry-ledger    methods declared on exactly one surface are legal (面 B forwards
 *                       `diagnose-pixel`/`diagnose-probed`; 面 A does not), but the *list* is
 *                       pinned here. A new one-sided method is red until recorded, because the
 *                       day the surfaces split further is the day a reader stops being able to
 *                       tell "deliberate" from "forgotten".
 *
 * EXIT 2, NOT EXIT 1, WHEN IT CANNOT MEASURE. No bun, no runner, or a runner that failed to
 * import either surface means this ruler observed nothing. A guard that reports "no divergence"
 * for a measurement that never happened is the failure shape this repo has been fined for
 * repeatedly, so it says `NOT OBSERVED` and leaves.
 *
 * Run from the repository root: `node harness/tools/provider-surface.mjs --check`.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const goldenFile = path.join(repoRoot, "harness", "contracts", "provider-surface.json")
const runner = path.join(here, "provider-surface-runner.ts")
const mode = process.argv.includes("--record") ? "record" : "check"

const NOTE =
  "Golden for `harness/tools/provider-surface.mjs`. Emitted by running both surfaces' provider code, not by reading their text: see that file's header for the three rules and for why the version string is normalised away. oneSided is the deliberate asymmetry ledger."
const NOTE_CHECK = "the golden records the tables and the deliberate asymmetry; see harness/tools/provider-surface.mjs"

const SURFACE_FILES = {
  harness: "harness/glasspane-harness/packages/opencode/src/tool/glasspane/providers.ts",
  shell: "mcp-shell/src/providers.ts",
}

const exitWith = (code, lines) => {
  for (const line of lines) console.log(line)
  process.exit(code)
}
const die = (code, message) => exitWith(code, [`provider-surface: ${message}`])

/** One surface's table, keyed `providerId/method` — the unit the two files duplicate. */
function index(table) {
  const byKey = new Map()
  for (const provider of table) {
    for (const method of provider.methods) {
      byKey.set(`${provider.id}/${method.name}`, {
        providerId: provider.id,
        kind: provider.kind,
        origin: provider.origin,
        method: method.name,
        requires: [...method.requires].sort(),
      })
    }
  }
  return byKey
}

function runBun(...args) {
  return execFileSync("bun", args, { cwd: repoRoot, encoding: "utf8" })
}

let measured
try {
  if (!existsSync(runner)) die(2, `NOT OBSERVED — no runner at ${path.relative(repoRoot, runner)}`)
  const stdout = runBun("run", path.relative(repoRoot, runner))
  measured = JSON.parse(stdout)
  for (const surface of ["harness", "shell"]) {
    if (!Array.isArray(measured[surface])) throw new Error(`surface '${surface}' is absent from the runner output`)
  }
} catch (error) {
  const detail = String(error && error.message ? error.message : error).split("\n").slice(0, 3).join(" / ")
  die(2, `NOT OBSERVED — the provider tables could not be read (${detail}). remedy: from the repository root run \`bun run harness/tools/provider-surface-runner.ts\` and read the import error; this ruler compares what the kernel accepts, so it has no text-scanning fallback and will not pretend to.`)
}

const surfaces = { harness: index(measured.harness), shell: index(measured.shell) }
const idsOf = (table) => [...new Set([...table.values()].map((entry) => entry.providerId))].sort()

const problems = []

const harnessIds = idsOf(surfaces.harness)
const shellIds = idsOf(surfaces.shell)
if (harnessIds.join(",") !== shellIds.join(",")) {
  problems.push(
    `provider-identity: 面 B registers [${harnessIds.join(", ")}] and 面 A registers [${shellIds.join(", ")}]. ` +
      "The same producer has to carry the same id on both surfaces or the registry question " +
      "`which provider answers this method?` has two different answers. " +
      `remedy: align the ids in ${SURFACE_FILES.harness} and ${SURFACE_FILES.shell}, or record the split here with a reason.`,
  )
}

for (const key of [...surfaces.harness.keys()].sort()) {
  if (!surfaces.shell.has(key)) continue
  const b = surfaces.harness.get(key)
  const a = surfaces.shell.get(key)
  if (b.requires.join(",") !== a.requires.join(",")) {
    problems.push(
      `overlap-agreement: '${key}' is declared on both surfaces with different prerequisites — ` +
        `面 B [${b.requires.join(", ")}] vs 面 A [${a.requires.join(", ")}]. A caller that satisfies one ` +
        "list does not satisfy the other, so 'both harnesses consume one contract' stops being true. " +
        `remedy: fix the side that drifted (${SURFACE_FILES.harness} / ${SURFACE_FILES.shell}); if the ` +
        "divergence is intended, say so in the provider file's own comment before re-recording this golden.",
    )
  }
  if (b.kind !== a.kind || b.origin !== a.origin) {
    problems.push(
      `overlap-agreement: '${key}' differs outside its prerequisite list (kind ${b.kind} vs ${a.kind}, ` +
        `origin ${b.origin} vs ${a.origin}). The identity of a provider is one claim, not two.`,
    )
  }
}

const oneSided = [
  ...[...surfaces.harness.keys()].filter((key) => !surfaces.shell.has(key)).map((key) => `harness:${key}`),
  ...[...surfaces.shell.keys()].filter((key) => !surfaces.harness.has(key)).map((key) => `shell:${key}`),
].sort()

const snapshot = {
  surfaces: {
    harness: Object.fromEntries([...surfaces.harness].sort(([x], [y]) => x.localeCompare(y))),
    shell: Object.fromEntries([...surfaces.shell].sort(([x], [y]) => x.localeCompare(y))),
  },
  oneSided,
  counts: {
    harnessMethods: surfaces.harness.size,
    shellMethods: surfaces.shell.size,
    overlap: [...surfaces.harness.keys()].filter((key) => surfaces.shell.has(key)).length,
  },
}

if (mode === "record") {
  // Same discipline as fork-diff: a golden written from uncommitted bytes is a contract no commit
  // satisfies, and two lanes editing providers.ts concurrently would wash one lane's work into
  // the other's baseline.
  const dirty = execFileSync("git", ["diff", "--name-only", "HEAD", "--", ...Object.values(SURFACE_FILES)], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
  if (dirty.length > 0) {
    die(1, ["refusing to record while a provider file carries uncommitted edits:", ...dirty.map((file) => `  ✗ ${file}`)].join("\n") +
      "\nCommit the registration change first, then re-record and fold the golden into that same commit.")
  }
  writeFileSync(goldenFile, JSON.stringify({ ...snapshot, note: NOTE }, null, 2) + "\n")
  die(0, [
    `recorded -> ${path.relative(repoRoot, goldenFile)}`,
    `  面 B ${snapshot.counts.harnessMethods} method(s), 面 A ${snapshot.counts.shellMethods}, overlap ${snapshot.counts.overlap}, one-sided ${oneSided.length}`,
  ])
}

if (!existsSync(goldenFile)) die(2, `no golden at ${path.relative(repoRoot, goldenFile)} — run --record`)
const golden = JSON.parse(readFileSync(goldenFile, "utf8"))
const goldenOneSided = [...(golden.oneSided ?? [])].sort()
if (goldenOneSided.join(",") !== oneSided.join(",")) {
  const added = oneSided.filter((entry) => !goldenOneSided.includes(entry))
  const gone = goldenOneSided.filter((entry) => !oneSided.includes(entry))
  problems.push(
    `asymmetry-ledger: the one-sided method list moved — ${added.length ? `now one-sided: ${added.join(", ")}` : "nothing new"}; ` +
      `${gone.length ? `no longer one-sided: ${gone.join(", ")}` : "nothing retired"}. ` +
      "A method existing on only one surface is legal; it becoming that way silently is not. " +
      `remedy: if intended, re-record this golden in the same commit as the registration (${NOTE_CHECK}).`,
  )
}
for (const surface of ["harness", "shell"]) {
  const goldenCount = golden?.counts?.[`${surface}Methods`]
  if (goldenCount !== undefined && goldenCount !== snapshot.counts[`${surface}Methods`]) {
    problems.push(
      `asymmetry-ledger: ${surface} declares ${snapshot.counts[`${surface}Methods`]} method(s), golden records ${goldenCount}. ` +
        "Whichever side moved, this golden is the place the count is reviewed.",
    )
  }
}

if (problems.length > 0) {
  exitWith(1, ["provider-surface: the two surfaces' provider registrations no longer reconcile.", ...problems.map((problem) => `  ✗ ${problem}`)])
}

exitWith(0, [
  `provider-surface: both surfaces register the same ids, every shared method carries the same prerequisites, and the asymmetry is the recorded one.`,
  `  面 B ${snapshot.counts.harnessMethods} method(s) · 面 A ${snapshot.counts.shellMethods} · overlap ${snapshot.counts.overlap} · one-sided ${oneSided.length}${oneSided.length ? ` (${oneSided.join(", ")})` : ""}`,
])
