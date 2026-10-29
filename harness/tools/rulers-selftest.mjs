#!/usr/bin/env node
/**
 * Fixed-point battery for the guards added to the six rulers on 2026-10-19.
 *
 * WHY THIS FILE EXISTS. Every one of these guards was written to close a specific way a gate can
 * be green while measuring nothing: a recorded field no line of code reads back (`brand-surface`'s
 * `productFiles`, `tool-surface`'s `engineLoc`/`kernel`), two lengths of the SAME object compared
 * to each other (`fork-diff`'s detail guards), a `--record` that stamps another lane's uncommitted
 * bytes into a permissive baseline, a reference clone read as upstream no matter what was edited in
 * it. A guard of that shape is worthless until someone proves it fires — "the lane is green" is not
 * evidence about a branch that has never been taken. Each control below therefore mutates ONE
 * input, runs the real ruler, and requires the *named* message: an exit code without the rule's
 * name is a red that could be anything, and a restored file whose bytes were never checked is a
 * control that may have left the repository changed.
 *
 * Safety: it refuses to start on a dirty worktree (it is about to modify tracked files, and a
 * parallel lane's work must not be its collateral), it restores every byte it touched from an
 * in-memory copy verified by sha256, and it removes its scratch files in a `finally`.
 *
 * Run from the repository root: `node harness/tools/rulers-selftest.mjs`. Wired into
 * `.github/workflows/ci.yml`'s `harness-rulers` job, because a test nobody runs is not a control.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const fork = path.join(repoRoot, "harness", "glasspane-harness")
const failures = []
const ok = (label) => console.log(`ok    ${label}`)
const bad = (label) => {
  failures.push(label)
  console.error(`MISS  ${label}`)
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()

// The reference clone is a git checkout on some machines and a symlink into another worktree's on
// others; the cleanliness guards below need its real path.
const refDir = path.join(repoRoot, ".external", "opencode")

const GUARD_RANGES = ["harness/contracts/", "harness/glasspane-harness/", ".external/"]
{
  const dirty = git("-c", "core.quotepath=off", "diff", "--name-only", "HEAD", "-z").split("\0").filter((rel) => rel && GUARD_RANGES.some((p) => rel.startsWith(p)))
  if (dirty.length) {
    for (const rel of dirty.slice(0, 10)) console.error(`  ✗ ${rel}`)
    console.error("rulers-selftest: refusing to start — this battery mutates tracked files and the worktree is not clean.")
    console.error("  Commit or move the batch first. Running here would restore someone else's bytes over their work.")
    process.exit(2)
  }
}

/** Run a ruler from the repository root and capture exit code plus both streams. */
const run = (rel, args = ["--check"]) => {
  try {
    return { rc: 0, text: execFileSync(process.execPath, [rel, ...args], { cwd: repoRoot, encoding: "utf8" }) }
  } catch (e) {
    return { rc: e.status ?? 1, text: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

/**
 * One control: write `mutation` into `rel`, run the ruler, require exit + every named message,
 * restore, and prove the restore byte-for-byte. A control that cannot prove it put the file back is
 * not a control — it is a half-finished edit left in the product.
 */
function mustGoRed(rel, label, mutation, tool, toolArgs, expectRc, names, mustNot = []) {
  const abs = path.join(repoRoot, rel)
  const original = readFileSync(abs)
  const before = sha(original)
  const started = failures.length
  try {
    writeFileSync(abs, mutation(original.toString("utf8")))
    const got = run(tool, toolArgs)
    if (got.rc !== expectRc) bad(`${label}: exited ${got.rc}, expected ${expectRc}\n${got.text.slice(0, 800)}`)
    for (const needle of names) if (!got.text.includes(needle)) bad(`${label}: exited ${got.rc} but never named "${needle}" — a red that does not name its rule is not a control\n${got.text.slice(0, 800)}`)
    for (const needle of mustNot) if (got.text.includes(needle)) bad(`${label}: also reported "${needle}", so the two rules are not answering independently`)
    if (failures.length === started) ok(`${label}: exit ${got.rc}, named as expected`)
  } finally {
    writeFileSync(abs, original)
    if (sha(readFileSync(abs)) !== before) bad(`${label}: RESTORE FAILED — ${rel} is not the byte sequence this control found (${before.slice(0, 12)} → ${sha(readFileSync(abs)).slice(0, 12)})`)
  }
}

/** Same, for a guard that must REFUSE an action rather than report a divergence. */
const mustRefuse = (rel, label, mutation, tool, toolArgs, names) => mustGoRed(rel, label, mutation, tool, toolArgs, 1, names)

const json = (text, edit) => {
  const parsed = JSON.parse(text)
  edit(parsed)
  return JSON.stringify(parsed, null, 2) + "\n"
}

console.log("rulers-selftest — each guard is driven once, named, and restored by sha256")

// 1. brand-surface: the remembered product-file list must have a reader.
mustGoRed(
  "harness/contracts/brand-surface.json",
  "brand-surface: product-file scan set moved is red",
  (text) => json(text, (g) => (g.productFiles = g.productFiles - 1)),
  "harness/tools/brand-surface.mjs",
  ["--check"],
  1,
  ["product-file scan set moved"],
  ["no unrecorded brand drift"],
)

// 2. brand-surface: the README pair is compared by name now, not only counted.
mustGoRed(
  "harness/contracts/brand-surface.json",
  "brand-surface: doc-file scan set moved is red",
  (text) => json(text, (g) => (g.docFiles = ["README.md"])),
  "harness/tools/brand-surface.mjs",
  ["--check"],
  1,
  ["doc-file scan set moved"],
)

// 3-5. the three `--record` paths that read a working tree must refuse an uncommitted batch.
// A permissive baseline (surface-semantics records ALLOWED judgements) is the worst of them: a
// laundered hit raises that file's ceiling, so the committed tree can never be red for it again.
{
  // The probe must be a TRACKED file modified in place: `git diff --name-only HEAD` — the command
  // all three guards run — does not list untracked paths, so a brand-new file is invisible to them
  // and this control would pass vacuously. (It did exactly that on its first run: three `--record`
  // calls exited 0 and rewrote the goldens, which is also how the closure check below earned its
  // keep.) The appended line carries no brand token, and the original bytes are restored by sha.
  const probeRel = "harness/glasspane-harness/CONTEXT.md"
  const probe = path.join(repoRoot, probeRel)
  const original = readFileSync(probe)
  const before = sha(original)
  try {
    writeFileSync(probe, `${original.toString("utf8")}\n<!-- rulers-selftest dirty probe -->\n`)
    for (const [tool, name] of [
      ["harness/tools/surface-semantics.mjs", "surface-semantics"],
      ["harness/tools/brand-surface.mjs", "brand-surface"],
      ["harness/tools/tool-surface.mjs", "tool-surface"],
    ]) {
      const got = run(tool, ["--record"])
      if (got.rc !== 1) bad(`${name} --record over a dirty tree exited ${got.rc}; refusing is the only correct answer\n${got.text.slice(0, 400)}`)
      else if (!got.text.includes(probeRel) || !got.text.includes("refusing to record"))
        bad(`${name} --record refused without naming the file or the refusal:\n${got.text.slice(0, 400)}`)
      else ok(`${name}: --record refuses a tracked-but-modified tree and names ${probeRel}`)
    }
  } finally {
    writeFileSync(probe, original)
    if (sha(readFileSync(probe)) !== before) bad(`3: RESTORE FAILED — ${probeRel} is not the bytes this control found`)
  }
}

// 6. tool-surface: the denominator of the 10% rule must travel with the record.
mustGoRed(
  "harness/contracts/tool-surface.json",
  "tool-surface: a moved engine baseline is red",
  (text) => json(text, (g) => (g.engineLoc = g.engineLoc - 1)),
  "harness/tools/tool-surface.mjs",
  ["--check"],
  1,
  ["the denominator moved"],
)

// 7. tool-surface: the kernel attribution is a caliber, not a caption.
mustGoRed(
  "harness/contracts/tool-surface.json",
  "tool-surface: a moved kernel attribution is red",
  (text) => json(text, (g) => (g.surfaces.fork.kernel = { package: "iterate-kernel", version: "0.0.0-selftest" })),
  "harness/tools/tool-surface.mjs",
  ["--check"],
  1,
  ["the kernel attribution moved"],
)

// 8. fork-diff: the detail guards used to compare two fields of one object; prove they read the
// golden now by emptying the golden's hash list and leaving its name list intact. The needle is
// the substring BOTH lane wordings share — clone-present prints "carries content hashes for only
// N" (fork-diff:405) and the offline lane prints "carries content hashes for N" (fork-diff:208,
// no "only"). Pinning the "only" form alone false-reds this battery on a machine without
// `.external/opencode`, where control 8 legitimately drives the offline lane.
mustGoRed(
  "harness/contracts/fork-diff.json",
  "fork-diff: a golden whose hash list was stripped is red",
  (text) => json(text, (g) => (g.editedDetail = [])),
  "harness/tools/fork-diff.mjs",
  ["--check"],
  1,
  ["edited file(s) but carries content hashes for"],
)

// 8b. the offline lane, driven legitimately rather than asserted from source text: fork-diff
// reads its reference path from `harness/upstream.json` → fork.referenceClone (fork-diff:52),
// so pointing that existing knob at a non-existent directory IS the no-clone condition on a
// clone-present machine. With the golden's hash list also emptied, the offline detail guard
// (fork-diff:207-208) must die with its OWN wording — "this lane has nothing meaningful to
// check", a string that exists nowhere in the clone-present lane — which also proves the lane
// that ran was the offline one.
{
  const knobRel = "harness/upstream.json"
  const goldenRel = "harness/contracts/fork-diff.json"
  const knobAbs = path.join(repoRoot, knobRel)
  const goldenAbs = path.join(repoRoot, goldenRel)
  const knobOriginal = readFileSync(knobAbs)
  const goldenOriginal = readFileSync(goldenAbs)
  const knobBefore = sha(knobOriginal)
  const goldenBefore = sha(goldenOriginal)
  const started = failures.length
  try {
    writeFileSync(knobAbs, json(knobOriginal.toString("utf8"), (u) => (u.fork.referenceClone = ".external/rulers-selftest-no-such-clone")))
    writeFileSync(goldenAbs, json(goldenOriginal.toString("utf8"), (g) => (g.editedDetail = [])))
    const got = run("harness/tools/fork-diff.mjs", ["--check"])
    if (got.rc !== 1) bad(`8b: fork-diff's offline lane exited ${got.rc}, expected 1\n${got.text.slice(0, 800)}`)
    for (const needle of ["reference clone absent", "edited file(s) but carries content hashes for", "this lane has nothing meaningful to check"]) {
      if (!got.text.includes(needle)) bad(`8b: exited ${got.rc} but never named "${needle}" — the offline detail guard did not fire under its own name\n${got.text.slice(0, 800)}`)
    }
    if (failures.length === started) ok("8b: fork-diff: upstream.json's referenceClone knob reaches the offline lane and its detail guard goes red by name")
  } finally {
    writeFileSync(knobAbs, knobOriginal)
    writeFileSync(goldenAbs, goldenOriginal)
    if (sha(readFileSync(knobAbs)) !== knobBefore) bad(`8b: RESTORE FAILED — ${knobRel} is not the byte sequence this control found`)
    if (sha(readFileSync(goldenAbs)) !== goldenBefore) bad(`8b: RESTORE FAILED — ${goldenRel} is not the byte sequence this control found`)
  }
}

// 9-10. the reference clone is read as upstream's bytes; an edited or dirty clone must stop the
// measurement, not silently attribute the local edit to upstream.
if (existsSync(path.join(refDir, ".git"))) {
  const probe = path.join(refDir, "RULERS-SELFTEST-PROBE.txt")
  const probeRel = path.relative(process.cwd(), probe)
  if (existsSync(probe)) bad(`9: ${probeRel} already exists — this battery expects to own that path`)
  else {
    try {
      writeFileSync(probe, "not upstream\n")
      for (const [tool, name, needle] of [
        ["harness/tools/hook-liveness.mjs", "hook-liveness", "is not clean"],
        ["harness/tools/fork-diff.mjs", "fork-diff", "is not clean"],
      ]) {
        const got = run(tool, ["--check"])
        if (got.rc !== 2) bad(`${name}: a dirty reference clone exited ${got.rc}, expected 2 (refuse to measure)\n${got.text.slice(0, 500)}`)
        else if (!got.text.includes(needle)) bad(`${name}: exited 2 without naming "${needle}":\n${got.text.slice(0, 500)}`)
        else ok(`${name}: an edited reference clone is refused, not attributed to upstream`)
      }
    } finally {
      rmSync(probe, { force: true })
      if (existsSync(probe)) bad(`9: the clone probe survived the finally block`)
    }
  }
} else {
  console.log(`note  9-10 NOT OBSERVED: no git reference clone at ${path.relative(repoRoot, refDir)} — the clone-cleanliness guards could not be driven here. This is not a pass.`)
}

// 11-12. product-surface's two new rules must fire on their own accident, not only sit in the
// file: a catalog that vanished (the build would silently fall back to fetching it), and a declared
// tree that is not on disk (the accident `packages/web` actually caused).
mustGoRed(
  "harness/glasspane-harness/packages/opencode/script/generate.ts",
  "product-surface: a build that stopped naming the committed catalog is red",
  (text) => text.replace(`"models-catalog.json"`, `"models-catalog-moved.json"`),
  "harness/tools/product-surface.mjs",
  ["--check"],
  1,
  ["script/generate.ts no longer reads the committed catalog by name"],
)
mustGoRed(
  "harness/glasspane-harness/product.json",
  "product-surface: a declared path that is not on disk is red",
  // The first version of this control inserted a made-up package name into `deletedFromTree` —
  // and passed with exit 0, because that list asserts the path is ABSENT, so a nonexistent name is
  // the correct answer. The accident the rule exists for is the opposite one (a deleted-list naming
  // a directory that is still there, which is what `packages/web` was), so the probe has to declare
  // a real, present package as deleted.
  (text) => text.replace(`"packages/stats"`, `"packages/desktop"`),
  "harness/tools/product-surface.mjs",
  ["--check"],
  1,
  ["packages/desktop is declared under deletedFromTree"],
)

// 13. causality, not coincidence: with the brand guard removed, control 1 goes green. That is the
// difference between "the lane happens to be red" and "this code is what makes it red".
{
  const toolPath = "harness/tools/brand-surface.mjs"
  const abs = path.join(repoRoot, toolPath)
  const source = readFileSync(abs)
  const neuteredFile = "harness/tools/rulers-selftest-neutered.mjs"
  const neuteredAbs = path.join(repoRoot, neuteredFile)
  const marker = "if (golden.productFiles !== observed.productFiles) {"
  const cut = source.indexOf(marker)
  if (cut === -1) bad("11: the product-file guard cannot be located in brand-surface.mjs — this control would prove nothing")
  else {
    try {
      writeFileSync(neuteredAbs, source.toString("utf8").replace(marker, "if (false) {"))
      const goldenAbs = path.join(repoRoot, "harness", "contracts", "brand-surface.json")
      const original = readFileSync(goldenAbs)
      try {
        writeFileSync(goldenAbs, json(original.toString("utf8"), (g) => (g.productFiles = g.productFiles - 1)))
        const got = run(neuteredFile, ["--check"])
        if (got.text.includes("product-file scan set moved")) bad("11: the neutered copy still reports the guard, so the control is not neutered")
        else ok("11 control live: removing the guard makes the same mutation green — the red in control 1 comes from this code")
      } finally {
        writeFileSync(goldenAbs, original)
      }
    } finally {
      rmSync(neuteredAbs, { force: true })
      if (existsSync(neuteredAbs)) bad(`11: the neutered copy was not removed (${neuteredFile})`)
    }
  }
}

// 14. brand-surface: the lineage corpus is TRACKED files, not whatever an installer left on disk.
// Measured failing on 2026-10-24: an installer run dropped two manifest files into the product's own
// project-config directory (git-ignored by the self-ignoring ruleset committed inside it), and the
// filesystem walk summed them into the bloodline count — 9607 → 9615 — so a local run of a commit and
// CI's run of the same commit reported different numbers, and the ratchet reddened on nobody's text.
// The differential is the assertion: a git-ignored probe holding brand tokens must not move the
// observed sum by even one. The probe path is assembled from parts so this file never names a path
// that only exists while the control runs (the provenance rule in scripts/check-doc-links.mjs reads
// path-shaped tokens as claims about the tree, and a transient file is not such a claim).
{
  const probeRel = ["harness", "glasspane-harness", "tmp", "rulers-selftest-lineage-probe.md"].join(path.sep)
  const probe = path.join(repoRoot, probeRel)
  const parse = (text) => Number((text.match(/lineage (\d+) occurrence\(s\)/) ?? [])[1])
  const clean = run("harness/tools/brand-surface.mjs", ["--check"])
  if (!Number.isFinite(parse(clean.text))) bad(`14: could not read the occurrence count from brand-surface — this control would prove nothing\n${clean.text.slice(0, 300)}`)
  else {
    mkdirSync(path.dirname(probe), { recursive: true })
    writeFileSync(probe, "# rulers-selftest lineage probe\n\nopencode opencode opencode opencode\n")
    try {
      const ignored = (() => {
        try {
          execFileSync("git", ["check-ignore", "-q", "--", probeRel], { cwd: repoRoot })
          return true
        } catch {
          return false
        }
      })()
      if (!ignored) bad(`14: ${probeRel} is not git-ignored, so this control would compare the wrong class of file`)
      else {
        const withProbe = run("harness/tools/brand-surface.mjs", ["--check"])
        const moved = parse(withProbe.text) - parse(clean.text)
        if (!Number.isFinite(parse(withProbe.text))) bad(`14: brand-surface stopped reporting a count with the probe present\n${withProbe.text.slice(0, 300)}`)
        else if (moved !== 0)
          bad(`14: a git-ignored file moved the lineage sum by ${moved} — the corpus is tracked files, not the working directory (${parse(clean.text)} → ${parse(withProbe.text)})`)
        else if (withProbe.rc !== clean.rc)
          bad(`14: the ignored probe changed the exit code (${clean.rc} → ${withProbe.rc}) without naming a tracked change\n${withProbe.text.slice(0, 400)}`)
        else ok(`14: brand-surface: a git-ignored file with four brand tokens moved the sum by 0 (both ${parse(clean.text)})`)
      }
    } finally {
      rmSync(probe, { force: true })
      if (existsSync(probe)) bad(`14: RESTORE FAILED — ${probeRel} is still on disk`)
      else rmSync(path.dirname(probe), { recursive: true, force: true })
    }
  }
}

// 15. brand-surface: the RULES array itself must have a reader. Deleting an entry makes its hits
// simply stop existing, and the hit loop in `--check` iterates OBSERVED hits against the golden —
// a vanished rule is invisible to it, so the gate printed green over a ruler that lost a mark
// (the same "recorded field no line of code reads back" shape as control 1, one layer up). The
// rule-set comparison (mirrored from surface-semantics:297-300) plus the per-rule zero-scan
// report must name the deletion.
mustGoRed(
  "harness/tools/brand-surface.mjs",
  "brand-surface: a rule deleted from RULES is red",
  (text) => {
    const block = /\n  \{\n    id: "upstream-registry",\n    [\s\S]*?\n  \},/.exec(text)
    return block ? text.replace(block[0], "") : text
  },
  "harness/tools/brand-surface.mjs",
  ["--check"],
  1,
  ["the rule set no longer matches the record", "rule upstream-registry: the golden records it, this run scanned zero files with it"],
  ["no unrecorded brand drift"],
)

// 16. product-surface's selftest-wired rule: a step that only NAMES a fixed-point test must not
// count as wiring it. The rule used to be `corpus.includes(basename)` over whole step bodies, so
// an `echo` or a remedy string holding the path satisfied "a selftest nobody runs is not a
// control" — the wiring degraded to prose. This mutates ci.yml's kernel-pin step from `node …`
// to `echo …`: the basename is still on the line, the invocation is gone, and the rule must say
// so by name.
mustGoRed(
  ".github/workflows/ci.yml",
  "product-surface: an echo-only step is not wiring",
  (text) => text.replace("node harness/tools/kernel-pin-selftest.mjs", "echo harness/tools/kernel-pin-selftest.mjs"),
  "harness/tools/product-surface.mjs",
  ["--check"],
  1,
  ["[selftest-wired] harness/tools/kernel-pin-selftest.mjs is invoked by NO workflow step"],
)

// 15-19. the four guards this batch added to the rulers must each be able to go red, by name.
// A guard that only ever prints a green line is the defect class this battery exists for: it reads
// as coverage while measuring nothing, and the next person trusts it. Each control below attacks the
// guard's own input — the golden, or the comparison — and demands the diagnosis this batch wrote.
mustGoRed(
  "harness/contracts/brand-surface.json",
  "brand-surface: a golden that stopped carrying shippedFiles is red, not waived",
  (text) => json(text, (g) => {
    delete g.shippedFiles
  }),
  "harness/tools/brand-surface.mjs",
  ["--check"],
  1,
  ["shipped-file scan count: the golden does not carry it"],
)
mustGoRed(
  "harness/contracts/brand-surface.json",
  "brand-surface: the shipped-source directory list has a reader",
  (text) => json(text, (g) => {
    g.shippedSrc = g.shippedSrc + 1
  }),
  "harness/tools/brand-surface.mjs",
  ["--check"],
  1,
  ["shipped-source directory list moved"],
)
// The five shipped-code rules were added to `observed.rules` precisely because they had no reader;
// this is the proof they now have one. It cannot reuse control 6 (which deletes from the `RULES`
// array) — these five are literals outside `RULES`, so a `RULES`-only probe would pass while the
// new entries stayed unguarded.
mustGoRed(
  "harness/tools/brand-surface.mjs",
  "brand-surface: removing a shipped-code rule from the recorded set is red",
  (text) => text.replace(`    { id: "removed-tree", why: `, `    // removed by rulers-selftest\n    { id: "removed-tree-disabled", why: `),
  "harness/tools/brand-surface.mjs",
  ["--check"],
  1,
  ["the rule set no longer matches the record", "removed-tree"],
)
// hook-liveness: `kind` is a count, the fire-site file set is the fact. Moving the recorded site
// without moving the kind is exactly the accident that used to read as "no drift".
mustGoRed(
  "harness/contracts/hook-liveness.json",
  "hook-liveness: a recorded dispatch site that moved is red even while kind still says live",
  (text) => json(text, (g) => {
    const live = g.hooks.find((h) => h.kind === "live" && Array.isArray(h.fireSites) && h.fireSites.length)
    if (live) live.fireSites = live.fireSites.map((s) => ({ ...s, file: s.file.replace(/\/[^/]+$/, "/moved-out-of-the-engine-path.ts") }))
  }),
  "harness/tools/hook-liveness.mjs",
  ["--check"],
  1,
  ["the dispatch sites moved"],
)
// surface-semantics: coverage compared counts, so a same-length substitution was green. Two probes —
// a golden that stopped carrying names, and one whose names are foreign but the same length.
mustGoRed(
  "harness/contracts/surface-semantics.json",
  "surface-semantics: a golden with no file-name list cannot claim to have cleared the surface",
  (text) => json(text, (g) => {
    for (const surface of Object.values(g.surfaces ?? {})) delete surface.files
  }),
  "harness/tools/surface-semantics.mjs",
  ["--check"],
  1,
  ["the golden carries no file-name list"],
)
mustGoRed(
  "harness/contracts/surface-semantics.json",
  "surface-semantics: a same-count substitution of the scan set is red by name",
  (text) => json(text, (g) => {
    for (const surface of Object.values(g.surfaces ?? {})) {
      if (Array.isArray(surface.files) && surface.files.length)
        surface.files = surface.files.map((f, i) => (i === 0 ? `${f}`.replace(/[^/]+$/, "somewhere-else.ts") : f))
    }
  }),
  "harness/tools/surface-semantics.mjs",
  ["--check"],
  1,
  ["the scan set changed identity"],
)

if (git("status", "--porcelain").split("\n").filter((l) => l && !l.startsWith("??")).length > 0) {
  bad("closure: the battery left tracked files modified in the worktree:\n" + git("status", "--porcelain"))
} else ok("closure: no tracked file left modified")

if (failures.length) {
  console.error(`rulers-selftest: ${failures.length} control(s) failed to behave as claimed`)
  process.exit(1)
}
// provider-surface's own controls live in `harness/tools/provider-surface-selftest.mjs`, a separate
// step placed AFTER `bun install` in this job. They cannot live here: this battery runs with no fork
// workspace installed, so a ruler that reads two resolved `providers.ts` files would answer exit 2
// ("NOT OBSERVED") and the control would be reporting the absence of a dependency rather than the
// presence of a guard — the ordering lesson `kernel-pin` and the redirect-policy selftest each
// already carry a comment about.

console.log("rulers-selftest: every guard named its own rule, every mutation was restored by sha256")
