#!/usr/bin/env node
/**
 * tool-surface.mjs — measure the tool surfaces against the Swift engine, every run.
 *
 * WHY. One of the three architecture iron laws says a tool surface must stay
 * under 10% of the codebase. Measured on 2026-09-24 the MCP shell sits at
 * 17.78% (3,719 / (17,197 + 3,719)) and nothing in the repository could notice
 * — the law existed only as a sentence in the design docs. The fork adds a
 * second tool surface, so the same silent drift now has two candidates.
 * specs/GlassPane_Harness_Fork_调研与方案_v0.1.md §9-4 resolved this as: keep the
 * documented limit, enforce it as a ratchet, and never redefine the number to
 * make a check pass.
 *
 * CALIBER (recorded in the golden so the number is reproducible, not vibes):
 *   engine    lines of every *.swift under engine/Sources (the judgement layer)
 *   surface A lines of every *.ts under mcp-shell/src   (the MCP shell)
 *   surface B lines we authored inside the fork: files `fork-diff` lists as
 *             `added`, plus the `+` lines of every `edited` vendored file;
 *             *.md excluded — docs are not a code surface
 *   ratio     surface / (engine + surfaceA + surfaceB)
 *             i.e. share of the whole measured codebase, which is what "<10%
 *             代码量" says. Note this denominator is one term bigger than the
 *             day-0 figure written in specs §3 (engine + surface A only), so
 *             surface A reads 17.34% here against 17.78% there. Same numerator,
 *             deliberately stricter question: the fork is part of the surface now.
 *
 * MODES
 *   --record  write harness/contracts/tool-surface.json (the baseline)
 *   --check   fail if a surface grew past its recorded baseline, or if a surface
 *             that is not yet over the documented limit crosses it, or if part
 *             of a surface cannot be attributed at all, or if the set of files
 *             actually MEASURED is smaller than the set the golden records (a
 *             measurement that quietly got smaller is not a smaller surface), or
 *             if a measured set came back empty (then no percentage is compared)
 *
 * This is a ratchet, not a ban: growing a surface is allowed, doing it
 * *unnoticed* is not. `--record` in the same commit is the remedy, and the
 * commit is where the growth gets justified.
 *
 * Exit codes: 0 ok, 1 grew past baseline / crossed the limit / measured less than
 * the record says it measures, 2 cannot measure.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readRefBlobs } from "./ref-batch.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const goldenFile = path.join(repoRoot, "harness", "contracts", "tool-surface.json")
const forkDiffGolden = path.join(repoRoot, "harness", "contracts", "fork-diff.json")
const pinFile = path.join(repoRoot, "harness", "upstream.json")
const mode = process.argv.includes("--record") ? "record" : "check"

// One private scratch dir per run. The `.before` snapshots used to sit at
// `tmpdir()/tool-surface-<rel>.before` — deterministic per file, so every concurrent run of
// this ruler wrote and unlinked the SAME paths: one run's cleanup deleted another's live
// snapshot, its `diff` read a missing operand, exited 2, and the run died reporting
// "refusing to bill" for a race, not a measurement (measured 2026-10-26: two parallel runs,
// one rc=2 every round, 8/8). This project runs rulers concurrently — CI has nine
// concurrent tool-surface runs — so the scratch must be per-run. mkdtemp gives each run its
// own; it is removed recursively when the process exits, on every path including die(2).
const scratchDir = mkdtempSync(path.join(tmpdir(), "tool-surface-"))
process.on("exit", () => rmSync(scratchDir, { recursive: true, force: true }))

const LIMIT = 0.1 // "<10% 代码量", one of the three architecture iron laws
// The specs file this pointed at never existed (a decision record named in a string, never opened
// by anything); the 2026-10-19 review of the other line found it and handed the fix over, because
// nothing in the docs lane reads `harness/`, so a ruler's own provenance pointer was the one link
// nobody checked. The iron laws live in §4.2 of the current 综述 (5.8), and `check-doc-links`
// now resolves every provenance field in `harness/contracts/*.json` against the tree.
const LIMIT_SOURCE = "三条架构铁律（specs/GlassPane_5.8_项目综述文档.md §4.2）"

/**
 * What each counted number means. Named so `--check` can compare it against the golden
 * before anything is measured: the golden records the caliber it was measured under, and
 * a caliber that moved silently is a different number wearing the same name.
 */
const CALIBER = {
  engine: "lines of every *.swift under engine/Sources",
  mcpShell: "lines of every *.ts under mcp-shell/src",
  fork: "fork-diff `added` files + authored (`+`) lines of `edited` vendored files, docs excluded; a hunk that differs only by a brand token is a rebranding and is not counted, and one deleted line excuses at most one re-added line (pairing is one-to-one, so 40 copies of a rebranded line bill 39)",
  ratio: "surface / (engine + mcp-shell + fork)",
}
const REF_EXTS = [".ts", ".tsx", ".js", ".mjs", ".sh"] // surface B counts code only

function die(code, msg) {
  console.error(`tool-surface: ${msg}`)
  process.exit(code)
}

/** Line count, `wc -l` semantics (newline-terminated lines) — the same caliber
 *  the day-0 measurements in the specs used, so the numbers stay comparable. */
function loc(abs) {
  const buf = readFileSync(abs)
  let n = 0
  for (const b of buf) if (b === 0x0a) n++
  return n
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === ".git" || entry === "node_modules" || entry === "dist") continue
    const full = path.join(dir, entry)
    if (lstatSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function listUnder(dir, exts) {
  if (!existsSync(dir)) return []
  return walk(dir).filter((f) => exts.includes(path.extname(f))).sort()
}

const engineFiles = listUnder(path.join(repoRoot, "engine", "Sources"), [".swift"])
const surfaceAFiles = listUnder(path.join(repoRoot, "mcp-shell", "src"), [".ts"])
if (!engineFiles.length) die(2, "no *.swift under engine/Sources — caliber broken, refusing to report a ratio")
if (!surfaceAFiles.length) die(2, "no *.ts under mcp-shell/src — caliber broken, refusing to report a ratio")

const engineLoc = engineFiles.reduce((s, f) => s + loc(f), 0)
// Surface A's per-file line counts are kept so a ratchet trip can name the file
// that grew. Without them the message was `surface A grew: 8455 → 8510 (+55)`,
// which says nothing about *whose* change tripped it — on a branch several people
// push to, that turns "acknowledge this growth" into a git archaeology exercise.
// Surface B already attributes per file (that is what the fork-diff golden is for);
// surface A had no equivalent, and the asymmetry is what made it the harder one to
// act on. Sorted by size so the largest movers are visible without scrolling.
const surfaceAByFile = new Map(surfaceAFiles.map((f) => [path.relative(repoRoot, f).split(path.sep).join("/"), loc(f)]))
const surfaceALoc = [...surfaceAByFile.values()].reduce((s, n) => s + n, 0)

/**
 * Surface B: our own lines inside the fork. Needs the fork-diff golden (which
 * files are ours) and, for `edited` vendored files, the reference clone to diff
 * against. When the clone is absent the previous run's numbers are carried
 * forward and the run says so out loud — silently skipping a measurement is how
 * the 17.78% happened in the first place.
 */
/**
 * The kernel is a **dependency** now: `iterate-kernel`, resolved through the fork's own
 * lockfile, with its version, integrity and contract corpus pinned by
 * `contracts/kernel-pin.json`. There are therefore no vendored kernel lines left to
 * exclude from surface B — the exclusion this function used to implement is gone by design.
 *
 * What remains of its job, in the same spirit as the vendor era: the manifest path that
 * was actually read is printed with the dependency line (`observed.surfaces.fork.kernelPin`),
 * because naming a path that does not exist is how a provenance claim goes unverifiable
 * (that is exactly how the old exclusion sat dead while naming `harness/contracts/…`), and
 * the failure mode inverted — kernel source re-appearing under `packages/opencode/vendor/kernel`
 * would now drop several thousand dependency lines into *our* authorship count with nothing
 * left to exclude them, so `measureFork` refuses that tree outright.
 */
function readKernelDependency() {
  const candidates = [
    path.join(repoRoot, "harness", "glasspane-harness", "contracts", "kernel-pin.json"),
    path.join(repoRoot, "harness", "contracts", "kernel-pin.json"),
  ]
  const manifestFile = candidates.find((f) => existsSync(f))
  if (!manifestFile) {
    console.error(
      "tool-surface: no contracts/kernel-pin.json — the kernel dependency cannot be attributed; run script/kernel-pin.mjs --record",
    )
    return null
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
  if (manifest?.package !== "iterate-kernel" || typeof manifest?.version !== "string") {
    console.error(`tool-surface: ${manifestFile} does not describe an iterate-kernel pin`)
    return { manifestFile }
  }
  return { package: manifest.package, version: manifest.version, manifestFile }
}

function measureFork(golden) {
  if (!existsSync(forkDiffGolden)) return fail("fork-diff golden absent — surface B cannot be attributed")
  if (!existsSync(pinFile)) return fail("harness/upstream.json absent — fork location unknown")
  const fd = JSON.parse(readFileSync(forkDiffGolden, "utf8"))
  const pin = JSON.parse(readFileSync(pinFile, "utf8"))
  const forkRel = pin?.fork?.path
  const refRel = pin?.fork?.referenceClone ?? ".external/opencode"
  if (!forkRel) return fail('upstream.json missing fork.path — surface B cannot be attributed')
  const forkDir = path.join(repoRoot, forkRel)
  if (!existsSync(forkDir)) return fail(`fork tree not found at ${forkRel}`)
  const refDir = path.join(repoRoot, refRel)
  const hasRef = existsSync(path.join(refDir, ".git"))
  const kernel = readKernelDependency()
  // Kernel provenance is part of the caliber, not a label: the golden pins
  // `kernel: iterate-kernel@<version>` precisely because the vendored-source exclusion was
  // retired with it. Both failure paths used to print an error and return, leaving the run to
  // report a green verdict over a surface whose dependency it had just announced it could not
  // attribute. Refusing to measure is the only honest answer here, and it blocks `--record` too.
  if (!kernel) return fail("no contracts/kernel-pin.json — the kernel dependency cannot be attributed, so the bytes this rule excludes from surface B are unverifiable; run `node harness/glasspane-harness/script/kernel-pin.mjs --record`")
  if (!kernel.version) return fail(`the manifest at ${kernel.manifestFile} does not describe an iterate-kernel version — attribute the dependency before measuring`)
  // Every upstream blob this measurement can ask about, in one pass. The set is a superset
  // on purpose: all `edited` files plus all `deleted` files that carry a counted extension,
  // whether or not the loops below end up probing them. Narrowing it to the exact probes
  // would make the read depend on the classification, and a spec missing from the map reads
  // as "upstream has no such file" — which under-bills authorship instead of refusing.
  let blobs = new Map()
  if (hasRef) {
    const specs = [...new Set([...(fd.edited ?? []), ...(fd.deleted ?? [])].filter((rel) => REF_EXTS.includes(path.extname(rel))))]
    try {
      blobs = readRefBlobs(refDir, specs)
    } catch (err) {
      return fail(`upstream reference could not be read: ${err.message}`)
    }
    const read = [...blobs.values()].filter((b) => b !== null).length
    process.stderr.write(`  surface B: ${read}/${blobs.size} upstream blobs read in one git pass\n`)
  }
  if (existsSync(path.join(forkDir, "packages", "opencode", "vendor", "kernel"))) {
    return fail(
      "packages/opencode/vendor/kernel exists again — the kernel ships as the iterate-kernel dependency; delete the tree or re-record the pin with a documented reason",
    )
  }

  // Surface A is measured as `mcp-shell/src`, tests excluded. Counting B's tests
  // would compare two different things, so test files are excluded here too —
  // and reported, because an exclusion that is not printed is how a measurement
  // quietly becomes unfalsifiable.
  const isTest = (rel) => /(^|\/)test\//.test(rel) || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")
  const excludedTests = []

  const files = []
  let unmeasured = []
  const renamed = []
  for (const rel of fd.added ?? []) {
    if (!REF_EXTS.includes(path.extname(rel))) continue
    const abs = path.join(forkDir, rel)
    if (!existsSync(abs)) return fail(`fork-diff says '${rel}' is ours but it is not in the tree`)
    if (isTest(rel)) {
      excludedTests.push({ file: rel, lines: loc(abs) })
      continue
    }
    // A pure rename is not authorship. When a file is relocated (upstream's
    // `.opencode/plugins/x.tsx` becoming `.glasspane-harness/plugins/x.tsx` in the
    // private-isation) the diff sees delete + add, and the whole upstream file would
    // land in "lines we wrote" — 1,019 lines of somebody else's code counted as ours.
    // So: if the bytes match a file upstream deleted, it is a move, and it counts 0.
    //
    // There is no clone-free form of that test, and carrying the golden's numbers does
    // not help because a rename is precisely what the golden does *not* contain. So the
    // offline lane cannot attribute surface B at all, and `observed.carried` below makes
    // it say so and refuse instead of printing a number inflated by other people's code.
    if (isPureRename(blobs, abs, rel, fd)) {
      renamed.push({ file: rel, lines: loc(abs) })
      continue
    }
    files.push({ file: rel, kind: "added", lines: loc(abs) })
  }

  const prevEdited = new Map((golden?.surfaces?.fork?.files ?? []).filter((f) => f.kind === "edited").map((f) => [f.file, f.lines]))
  for (const rel of fd.edited ?? []) {
    if (!REF_EXTS.includes(path.extname(rel))) continue
    const abs = path.join(forkDir, rel)
    if (!existsSync(abs)) return fail(`fork-diff says '${rel}' is edited but it is not in the tree`)
    if (!hasRef) {
      const was = prevEdited.get(rel)
      // An edited TEST file is excluded, never measured — that is the declared
      // caliber ("tests excluded"), and it must hold on the no-clone path too.
      // This check used to sit *after* the baseline lookup, so an edited test with
      // no recorded baseline aborted the whole gate: CI (which has no reference
      // clone) could not run `tool-surface --check` at all, while the same tree
      // measured clean locally. Excluding tests needs no reference and no
      // baseline, so ask that question first and only then look up the baseline.
      if (isTest(rel)) {
        if (was !== undefined) excludedTests.push({ file: rel, lines: was })
        continue
      }
      if (was === undefined) return fail(`no reference clone and no baseline for edited file '${rel}' — cannot attribute surface B`)
      unmeasured.push(rel)
      files.push({ file: rel, kind: "edited", lines: was })
      continue
    }
    const n = addedLinesAgainstRef(blobs, rel, abs)
    if (!Number.isFinite(n)) return fail(`reference clone at ${refRel} has no '${rel}' at HEAD — cannot attribute surface B`)
    if (isTest(rel)) {
      // An edited TEST file is excluded exactly like an added one: the caliber
      // says "tests excluded" and means it, whichever fork-diff bucket the file
      // arrived in. Before M5 no edited file was a test, so this path never fired
      // and an edited test's `+` lines leaked into surface B while the report
      // went on printing "tests excluded".
      excludedTests.push({ file: rel, lines: n })
      continue
    }
    files.push({ file: rel, kind: "edited", lines: n })
  }

  // The measured set must be non-empty, and (asserted below, against the golden) as large
  // as the set the record says this rule measures. The old form of this guard asked the
  // *same golden it was guarding* how many files there were to measure:
  // `(fd.added ?? []).filter(...)` — so emptying `fork-diff.json`'s `added` made the guard
  // vacuous instead of making the shrink visible. Measured 2026-10-16 with that golden's
  // `added`/`edited`/`addedDetail`/`editedDetail` emptied (counts left untouched):
  // surface B went 8,275 LOC / 216 files → 0 LOC, `--check` printed
  // "no growth past the recorded baseline" and exited 0, and the same run moved surface A
  // from 21.66% → 26.63% while A's own LOC did not change — one surface shrinking
  // relabelled the other. An emptied list, a narrowed `REF_EXTS`, a widened `isTest` or a
  // renamed bucket all shrink B that way and could then be `--record`ed as the new baseline.
  // So: an empty measured set refuses here (no percentage is computed over it, and
  // `--record` cannot stamp it because `note` is set), and any shrink against the recorded
  // file list is red in the coverage section below.
  if (files.length === 0) {
    return fail(
      `surface B measured 0 file(s): the fork-diff golden's \`added\`/\`edited\` lists carry ${(fd.added ?? []).length} + ${(fd.edited ?? []).length} file(s) while its own \`counts\` still declares ${fd.counts?.edited ?? "?"} edited / ${fd.counts?.added ?? "?"} added. An emptied list, a narrowed REF_EXTS, a widened isTest or a renamed bucket all look exactly like this — refusing to report a percentage over an empty measured set`,
    )
  }

  // Only the lane that lacks the clone carries. Writing this unconditionally makes the
  // refusal bite the measuring lane too — caught the first time `--record` was run against
  // a tree that *does* have `.external/opencode`, which is exactly the shape of the
  // "guard that fires on the healthy path" defect this file exists to catch.
  const carriedParts = []
  if (unmeasured.length) carriedParts.push(`lines attributed to ${unmeasured.length} edited file(s) are the previous run's`)
  // The added bucket is named because it is the one that cannot be salvaged: an edited
  // file carried forward still measured *something* last time, while an added file in a
  // lane with no clone has never been distinguished from a brand rename at all.
  if (!hasRef) carriedParts.push("added files have never been checked against upstream, so a rename would be billed as authorship")
  const carried = carriedParts.length
    ? `reference clone absent (${refRel}): ${carriedParts.join("; ")} — NOT re-measured`
    : null
  return { files, carried, note: null, excluded: [], tests: excludedTests, kernel }
}

const fail = (note) => ({ files: [], carried: null, note, excluded: [], tests: [], manifest: null })

/**
 * Lines of *authorship*, not lines of difference.
 *
 * WHY (measured 2026-09-26): the private-isation replaced the upstream name inside 63
 * vendored locale files — 2,700+ lines that are a find-and-replace, not code anybody
 * wrote. Counting them as surface B pushed the fork's own surface from 10% to 24% and
 * would, over a few more renames, have started pushing *against* doing the
 * private-isation correctly. A hunk whose only difference is the brand token is a
 * rebranding; it is excluded. Everything else — a new function, a changed branch, a new
 * comment explaining a decision — is counted exactly as before.
 */
const BRAND_TOKENS = [
  /opencode/gi,
  /Opencode/g,
  /OpenCode/g,
  /OPENCODE/g,
  /opncd/g,
  /glasspane[-_ ]?harness/gi,
  /GlassPane[- ]?Harness/g,
  /GLASSPANE_HARNESS/g,
  /opencode-ai/g,
  /anomalyco/g,
  /models\.opencode\.ai/g,
]

/** A brand token, normalized away, so two lines that differ only by it compare equal. */
function debrand(text) {
  let out = text
  for (const token of BRAND_TOKENS) out = out.replace(token, "§BRAND§")
  return out.replace(/\s+/g, " ").trim()
}

function countAuthoredLines(diff) {
  const lines = diff.split("\n")
  // One-to-one pairing, spent as a *count*. Each removal excuses at most one
  // addition: a hunk that deletes one line and re-adds it 40 times with the brand
  // swapped is 39 lines of copy-paste, not a rebranding. The previous form kept a
  // `ri` cursor that was initialised and never advanced, so `removed.slice(ri)`
  // was the whole removal set for every addition and a single deleted line excused
  // an unlimited number of added ones (that shape billed 40 copies as 0 authored).
  // Pairing is still per-file rather than per-hunk, exactly as before — only the
  // "each removal is consumed once" part changes.
  const excusable = new Map()
  for (const line of lines) {
    if (!line.startsWith("-") || line.startsWith("---")) continue
    const key = debrand(line.slice(1))
    excusable.set(key, (excusable.get(key) ?? 0) + 1)
  }
  let authored = 0
  for (const line of lines) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    const added = debrand(line.slice(1))
    const left = excusable.get(added)
    if (left) {
      excusable.set(added, left - 1)
      continue
    }
    authored += 1
  }
  return authored
}

function addedLinesAgainstRef(blobs, rel, forkAbs) {
  const before = blobs.get(rel)
  if (before === undefined || before === null) return NaN
  const tmp = path.join(scratchDir, `tool-surface-${rel.replace(/[^A-Za-z0-9]+/g, "_")}.before`)
  writeFileSync(tmp, before.toString("utf8"))
  try {
    let diff = ""
    try {
      diff = execFileSync("diff", ["-u", tmp, forkAbs], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 })
    } catch (err) {
      // diff's exit code IS the measurement: 0 = identical (empty stdout, counted above),
      // 1 = there is a difference and stdout carries it, anything else = the comparison
      // never happened. Swallowing every non-zero exit made exit 2 (an operand diff could
      // not read) and ENOBUFS (stdout truncated past maxBuffer, which keeps a *partial*
      // diff) indistinguishable from "no differences" — countAuthoredLines then billed 0,
      // the one under-count direction the LOC ratchet is blind to: a growing surface
      // reported as unchanged. Die loudly, naming both operands, instead.
      const firstLine = String(err.stderr ?? err.message ?? "").trim().split("\n")[0]
      if (err.code === "ENOBUFS") {
        die(2, `diff output for '${rel}' exceeded its 512MB buffer and was truncated — the partial diff would bill fewer authored lines than the real one. operands: upstream snapshot ${tmp} vs fork file ${forkAbs}`)
      }
      if (err.status !== 1 || typeof err.stdout !== "string") {
        die(2, `diff of '${rel}' failed with exit ${err.status ?? `signal ${err.signal}`} (only exit 1 means 'files differ') — refusing to bill an unmeasured file as zero authored lines. operands: upstream snapshot ${tmp} vs fork file ${forkAbs}. diff said: ${firstLine}`)
      }
      diff = err.stdout
    }
    return countAuthoredLines(diff)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Summarise what the provenance manifest took out of surface B, so the number
 *  stays explainable: dependency lines are not our lines, but they are counted. */
function vendorSummary(excluded) {
  if (!excluded.length) return { files: 0, lines: 0 }
  return { files: excluded.length, lines: excluded.reduce((sum, f) => sum + f.lines, 0) }
}

/** Does this "added" file have identical bytes to something upstream deleted? */
function isPureRename(blobs, abs, rel, fd) {
  if (blobs.size === 0) return false
  const here = createHash("sha256").update(readFileSync(abs)).digest("hex")
  for (const gone of fd.deleted ?? []) {
    if (path.extname(gone) !== path.extname(rel)) continue
    const before = blobs.get(gone)
    if (before === undefined || before === null) continue
    if (createHash("sha256").update(before).digest("hex") === here) return true
  }
  return false
}

function build(golden) {
  const fork = measureFork(golden)
  const forkLoc = fork.files.reduce((s, f) => s + f.lines, 0)
  const denom = engineLoc + surfaceALoc + forkLoc
  // A percentage is only comparable when every term of its denominator was measured.
  // With one surface at 0 files the other's share moves without its own code moving
  // (measured 2026-10-16: B 8,275 → 0 LOC pushed A from 21.66% to 26.63% at an unchanged
  // 9,609 LOC), so when a measured set comes back empty the ratio is reported as *not
  // measured* instead of as a number two runs can compare.
  // Surface A's and the engine's emptiness are already refused at :110-111 (exit 2, before any
  // ratio exists), and `surfaceAFiles` is a const that nothing reassigns — so the only empty
  // set this can ever describe is surface B's. The previous middle branch ("surface A measured
  // 0 file(s)") was unreachable code posing as a refusal.
  const unmeasured = fork.files.length === 0 ? "surface B measured 0 file(s)" : null
  const ratio = (n) => (unmeasured ? null : Math.round((n / denom) * 10000) / 10000)
  return {
    limit: LIMIT,
    limitSource: LIMIT_SOURCE,
    caliber: CALIBER,
    observedAt: new Date().toISOString().slice(0, 10),
    engineLoc,
    engineFiles: engineFiles.length,
    surfaces: {
      mcpShell: {
        loc: surfaceALoc,
        files: surfaceAFiles.length,
        ratio: ratio(surfaceALoc),
        // Per-file baseline so a growth trip names the file (see surfaceAByFile above).
        byFile: Object.fromEntries([...surfaceAByFile.entries()].sort((a, b) => b[1] - a[1])),
      },
      fork: {
        loc: forkLoc,
        files: fork.files,
        ratio: ratio(forkLoc),
        vendorExcluded: vendorSummary(fork.excluded),
        testsExcluded: vendorSummary(fork.tests),
        // The path that was ACTUALLY read, repo-relative, so the dependency line
        // cannot name a manifest that does not exist. Null when nothing was found.
        kernelPin: fork.kernel?.manifestFile ? path.relative(repoRoot, fork.kernel.manifestFile).split(path.sep).join("/") : null,
        kernel: fork.kernel?.package ? { package: fork.kernel.package, version: fork.kernel.version } : null,
      },
    },
    totalToolSurfaceLoc: surfaceALoc + forkLoc,
    note: fork.note,
    carried: fork.carried,
  }
}

const golden = existsSync(goldenFile) ? JSON.parse(readFileSync(goldenFile, "utf8")) : null

// The documented limit, its cited source, and the caliber are constants *in this file*,
// and the golden carries the ones that were in force when the baseline was recorded.
// Nothing compared the two, so `LIMIT = 0.1` → `0.25` was a green commit: both over-limit
// surfaces became "legal" and the `← OVER LIMIT` announcements disappeared with the
// honesty that came with them. A measurement script does not get to redefine the
// architecture law it guards — that number lives in LIMIT_SOURCE, and changing it is a
// decision for the owner, not a side effect of editing a ruler. Checked before `build()`
// because a guard that costs a full tree walk is a guard people route around.
if (golden && mode === "check") {
  if (golden.limit !== LIMIT) {
    die(
      1,
      `the documented limit moved without a re-record: golden ${(golden.limit * 100).toFixed(0)}% → code ${(LIMIT * 100).toFixed(0)}%. ` +
        `Its source is ${LIMIT_SOURCE}; if that document genuinely changed, change it first, then run --record.`,
    )
  }
  if (golden.limitSource !== LIMIT_SOURCE) {
    die(1, `the limit's cited source moved: golden "${golden.limitSource}" → code "${LIMIT_SOURCE}" — a ratchet that cites a different document is measuring a different claim.`)
  }
  const caliberMoved = Object.keys(CALIBER).filter((k) => golden.caliber?.[k] !== CALIBER[k])
  if (caliberMoved.length) {
    die(1, `the measurement caliber changed (${caliberMoved.join(", ")}) while the golden still records the old one. ` +
      "A different caliber is a different number: restate what the surface is, then --record with the code.")
  }
}

const observed = build(golden)

// The only measured set whose emptiness can reach a refusal here is surface B's: surface A and
// the engine are refused at :110-111 (exit 2) before any ratio is built, and both readers of
// this string (`show` and the not-comparable check below) only print it when a ratio is
// non-finite, which `build()` makes equivalent to `fork.files.length === 0`. The old else-arm
// — "surface A measured 0 file(s)" — was a refusal string no reachable run could print
// truthfully; on every healthy run it evaluated to a statement that this lane had measured
// nothing, sitting one code move away from being printed.
const percentageRefusal = "surface B measured 0 file(s), so it contributes nothing to the denominator and surface A's share would move on its own code doing nothing"

/**
 * How many files the surface actually measured, versus how many the record says it
 * measures. The golden's own recorded set is the only honest yardstick here — the
 * fork-diff lists cannot be, because they are the input this rule reads and emptying
 * them is the very mutation that made surface B disappear (see the note in measureFork).
 * Same discipline as `surface-semantics.mjs` (filesScanned vs the recorded scan set) and
 * `brand-surface.mjs` (lineage coverage): a measurement set that got smaller is a change
 * of caliber, not a smaller surface, and "we measured nothing" must never read as
 * "nothing grew".
 */
const recordedCount = (surf) =>
  Array.isArray(surf?.files) ? surf.files.length : typeof surf?.files === "number" ? surf.files : Object.keys(surf?.byFile ?? {}).length

function coverageProblems(golden) {
  const problems = []
  for (const [name, now, was] of [
    ["surface A (mcp-shell/src)", observed.surfaces.mcpShell.files, golden?.surfaces?.mcpShell],
    ["surface B (fork, ours)", observed.surfaces.fork.files.length, golden?.surfaces?.fork],
  ]) {
    if (!was) {
      problems.push(`${name}: the golden has no such surface — this rule cannot prove it measured anything`)
      continue
    }
    const recorded = recordedCount(was)
    if (!Number.isFinite(recorded) || recorded === 0) {
      const shape = was?.files === undefined ? (was?.byFile === undefined ? "absent from the golden" : `only byFile (${Object.keys(was.byFile).length} keys)`) : JSON.stringify(was.files)
      problems.push(`${name}: the golden stopped carrying the file list this rule compares (its \`files\` field is ${shape}) — a ratchet with no recorded measurement set cannot notice the set disappearing. Re-record against the tree so the number of files measured is on the record.`)
      continue
    }
    if (now < recorded) {
      problems.push(
        `${name}: the baseline measured ${recorded} file(s), this run measures ${now} — ${recorded - now} file(s) left the MEASURED set. That is a caliber change (an emptied fork-diff list, a narrowed REF_EXTS, a widened isTest, a renamed bucket), not a smaller surface: LOC that is not measured cannot grow. Restore what the rule reads, or --record in the same commit and say why those files are no longer part of the surface.`,
      )
    }
  }
  return problems
}

function reportCoverage(golden) {
  for (const [name, now, was] of [
    ["surface A (mcp-shell/src)", observed.surfaces.mcpShell.files, golden?.surfaces?.mcpShell],
    ["surface B (fork, ours)", observed.surfaces.fork.files.length, golden?.surfaces?.fork],
  ]) {
    const recorded = was ? recordedCount(was) : null
    if (!Number.isFinite(recorded)) {
      console.log(`  ${name} coverage: this run measured ${now} file(s); the baseline carries no measurement set, so it cannot be compared`)
      continue
    }
    const delta = now - recorded
    console.log(
      `  ${name} coverage: recorded ${recorded} file(s) → now ${now} file(s)${delta === 0 ? "" : ` (${delta > 0 ? "grew" : "SHRANK"} ${Math.abs(delta)}) — the LOC figure is a sum over ${now} file(s)`}`,
    )
  }
}

// The limit is a documented number, so a surface sitting over it is a fact the
// report must state whatever it is doing — not a fact only surface A gets to say.
const pct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : "not measured")
const overLimit = (s) => Number.isFinite(s.ratio) && s.ratio > observed.limit
const show = (name, s) =>
  console.log(
    `  ${name}: ${s.loc} LOC, ${Number.isFinite(s.ratio) ? pct(s.ratio) : `ratio REFUSED (${percentageRefusal})`} (documented limit ${(observed.limit * 100).toFixed(0)}%)${overLimit(s) ? "  ← OVER LIMIT" : ""}`,
  )

/**
 * Announce every surface that is over the documented limit, with its recorded ratio
 * next to the current one, and say whether the *crossing* check for that surface is
 * still live or already spent. The crossing check (`recorded <= limit && now > limit`)
 * can fire once per surface, ever: a baseline that was already over the limit makes it
 * permanently false, which is exactly the "gate that cannot go red" shape. The number
 * of the ratchet is unchanged here — this is reporting, not a new verdict.
 */
function announceOverLimit(pairs) {
  for (const [name, now, was] of pairs) {
    if (!overLimit(now)) continue
    console.log(`  ! ${name} is over the documented limit: recorded ${was ? pct(was.ratio) : "(no baseline yet)"} → now ${pct(now.ratio)} (> ${(observed.limit * 100).toFixed(0)}%).`)
    if (was && overLimit(was)) {
      console.log(`    The crossing check for this surface is ALREADY SPENT: the baseline itself sits over the limit, so "was within, now crossed" can never fire for it again. What still guards it is the LOC ratchet (any growth past the recorded baseline is red) — nothing here makes the surface legal.`)
    } else if (was && now.ratio > was.ratio) {
      console.log(`    The crossing check for this surface is LIVE and fired on this run — it is reported red above.`)
    } else {
      console.log(`    Known and tolerated: the limit predates the measurement. The gate stops it growing further.`)
    }
  }
}

console.log(`tool-surface — engine ${observed.engineLoc} LOC across ${observed.engineFiles} files`)
show("surface A  mcp-shell/src", observed.surfaces.mcpShell)
show("surface B  fork (ours)", observed.surfaces.fork)
if (observed.surfaces.fork.files.length) {
  for (const f of observed.surfaces.fork.files) console.log(`    ${f.kind.padEnd(6)} ${f.file}  ${f.lines}`)
}
if (observed.surfaces.fork.testsExcluded.files > 0) {
  console.log(`  tests excluded from surface B (surface A is measured as src/ only): ${observed.surfaces.fork.testsExcluded.files} files, ${observed.surfaces.fork.testsExcluded.lines} lines — counted out loud so the caliber can be audited`)
}
if (observed.surfaces.fork.vendorExcluded.files > 0) {
  // Nothing should land here now — the exclusion list is empty by construction. If it
  // ever is not, a vendored tree came back, and the number says so in the open.
  console.log(`  files excluded from surface B: ${observed.surfaces.fork.vendorExcluded.files} files, ${observed.surfaces.fork.vendorExcluded.lines} lines`)
}
if (observed.surfaces.fork.kernel) {
  // Name the manifest actually resolved, not a hardcoded path: a wrong provenance string
  // is unfalsifiable by reading, and the reader cannot tell a live pin from a dead one.
  const manifest = observed.surfaces.fork.kernelPin ?? "no pin resolved"
  console.log(
    `  kernel is a dependency, not our surface: ${observed.surfaces.fork.kernel.package}@${observed.surfaces.fork.kernel.version}, pinned by ${manifest} (version, lock integrity and the shipped contract corpus; the vendored-source exclusion was retired with vendor/kernel)`,
  )
}
if (observed.carried) console.log(`  note: ${observed.carried}`)
if (observed.note) console.log(`  note: ${observed.note}`)

if (mode === "record") {
  // Recording is only allowed over a measurement that exists. Writing a golden
  // while attribution failed would freeze a *wrong* baseline (surface B at 0 LOC
  // happened exactly this way once: a moved vendor directory left the golden
  // naming files that were no longer there), and the next --check would then
  // compare future runs against a number that was never measured.
  if (observed.note) {
    console.error(`tool-surface: refusing to record — ${observed.note}`)
    console.error("  Fix the attribution first (fork-diff --record declares which files exist).")
    process.exit(1)
  }
  // The other way a measurement does not exist is quieter: with no reference clone,
  // every `edited` file's line count is *carried* from the previous golden instead of
  // being re-derived from the blobs. --check handles that honestly (it says
  // NOT re-measured), but --record used to stamp it anyway — and a golden made of
  // carried numbers can never be grown past: each later run compares the tree against
  // the figure it just copied, so real growth on an edited file stops being able to go
  // red on exactly the machines that lack the clone.
  if (observed.carried) {
    console.error(`tool-surface: refusing to record — ${observed.carried}`)
    console.error("  A carried baseline reuses the previous golden's line counts instead of measuring them.")
    console.error("  Record where the reference clone exists (`harness/upstream.json.checkout`), then --check can re-measure everywhere.")
    process.exit(1)
  }
  // A dirty worktree is the third way a measurement does not exist. This ruler reads the
  // disk, so recording while another lane has uncommitted lines in `mcp-shell/src` (the
  // 07:30 line works in that tree, and 2026-10-14 found it dirty again) writes THAT lane's
  // lines into OUR baseline — the golden then blesses bytes no commit contains, and the
  // next clean `--check` goes red for a change nobody made. fork-diff already refuses on
  // this; surface A had no equivalent guard.
  const dirtyScope = ["mcp-shell/src/", "harness/glasspane-harness/", "engine/"]
  // `cwd: repoRoot` because repoRoot comes from THIS FILE's location, not the process's:
  // run from any other directory, git would read whatever repository (if any) surrounds the
  // invocation and the refusal below would describe the wrong tree — or throw outside one.
  // Same rule fork-diff.mjs applies to its git reads.
  const dirty = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((rel) => rel && dirtyScope.some((prefix) => rel.startsWith(prefix)))
    .sort()
  if (dirty.length) {
    for (const rel of dirty.slice(0, 20)) console.error(`  ✗ tracked but modified in the working tree, not yet in any commit: ${rel}`)
    if (dirty.length > 20) console.error(`      … ${dirty.length - 20} more`)
    console.error("tool-surface: refusing to record — the golden would carry uncommitted lines from another lane.")
    console.error("  Commit the source change first (or record from a clean worktree of that commit), then")
    console.error("  re-record and fold the golden into that same commit.")
    process.exit(1)
  }
  mkdirSync(path.dirname(goldenFile), { recursive: true })
  // Saying it before writing it: the golden about to be written blesses a surface
  // that is over the documented limit, and from that commit the crossing check for
  // it is spent. The record is still allowed (this is a ratchet, not a ban) — but
  // not silently. The coverage line above it does the same job for the measurement
  // SET: a record that quietly measures fewer files than its predecessor turns the
  // ratchet into a no-op, so the move is printed in the same breath as the number.
  reportCoverage(golden)
  announceOverLimit([
    ["surface A (mcp-shell/src)", observed.surfaces.mcpShell, golden?.surfaces?.mcpShell ?? null],
    ["surface B (fork, ours)", observed.surfaces.fork, golden?.surfaces?.fork ?? null],
  ])
  writeFileSync(goldenFile, JSON.stringify(observed, null, 2) + "\n")
  console.log(`recorded -> ${path.relative(repoRoot, goldenFile)}`)
  process.exit(0)
}

if (!golden) die(2, `no golden at ${path.relative(repoRoot, goldenFile)} — run --record`)
if (!golden.surfaces?.mcpShell || !golden.surfaces?.fork) die(2, "golden is missing a surface — re-record")

let red = 0

// Coverage first, before any number is compared: a surface that stopped being measured
// cannot be cleared by the comparison that depends on measuring it.
for (const problem of coverageProblems(golden)) {
  console.error(`  ✗ coverage: ${problem}`)
  red++
}
reportCoverage(golden)
// No percentage is emitted over an empty measured set (build() returns null for it), and
// the refusal is itself a verdict: a run that could not measure is not a run that passed.
if (!Number.isFinite(observed.surfaces.fork.ratio) || !Number.isFinite(observed.surfaces.mcpShell.ratio)) {
  console.error(`  ✗ percentages are not comparable this run: ${percentageRefusal} — the ratio's denominator lost a term, so every share printed against it would be a different measurement wearing the same name.`)
  red++
}

const pairs = [
  ["surface A (mcp-shell/src)", observed.surfaces.mcpShell, golden.surfaces.mcpShell],
  ["surface B (fork, ours)", observed.surfaces.fork, golden.surfaces.fork],
]
for (const [name, now, was] of pairs) {
  if (now.loc > was.loc) {
    console.error(`  ✗ ${name} grew: ${was.loc} recorded → ${now.loc} LOC (+${now.loc - was.loc})`)
    // Name the movers when the baseline knows them. "grew by 55" alone makes the
    // reader go and diff the tree to find out whose change did it; the whole point of
    // a ratchet is that a person acknowledges the growth, and you cannot acknowledge
    // what the message will not identify. Falls back to nothing (rather than
    // guessing) when the recorded baseline predates per-file data.
    // Surface A records `byFile`; surface B records a `files` list of
    // `{file, kind, lines}`. Reading only `byFile` meant surface B — the one that is
    // *ours*, and the one a reader most needs attributed — grew with no name attached,
    // while the comment above this block claimed surface B was already attributed.
    // Both shapes are normalized into one map here rather than duplicating the diff.
    const asMap = (surf) =>
      surf?.byFile ??
      Object.fromEntries((surf?.files ?? []).map((f) => [`${f.kind} ${f.file}`, f.lines]))
    const before = asMap(was)
    const after = asMap(now)
    if (Object.keys(before).length > 0 && Object.keys(after).length > 0) {
      const moved = []
      for (const [file, lines] of Object.entries(after)) {
        const was0 = before[file]
        if (was0 === undefined) moved.push([file, lines, "new file"])
        else if (lines > was0) moved.push([file, lines - was0, `+${lines - was0}`])
      }
      for (const file of Object.keys(before)) {
        if (after[file] === undefined) moved.push([file, 0, "deleted"])
      }
      moved.sort((a, b) => b[1] - a[1])
      for (const [file, , how] of moved) console.error(`      ${how.padStart(8)}  ${file}`)
      if (moved.length === 0) console.error("      (no single file grew — the baseline has no per-file data for this surface)")
    }
    red++
  }
  // Fires only while the recorded baseline is *within* the limit: once a surface has
  // been recorded over it, this check is spent for that surface forever. That is not
  // changed here (it would change what counts as red); it is stated out loud by
  // announceOverLimit below so the reader is not left thinking the crossing guard is
  // still protecting a surface it can no longer reach.
  if (was.ratio <= golden.limit && now.ratio > observed.limit) {
    console.error(`  ✗ ${name} crossed the documented limit: ${(was.ratio * 100).toFixed(2)}% → ${(now.ratio * 100).toFixed(2)}% (> ${(observed.limit * 100).toFixed(0)}%)`)
    red++
  }
}

announceOverLimit(pairs)

if (observed.note) {
  console.error(`  ✗ surface B cannot be attributed (${observed.note}) — an unmeasured surface cannot be declared within limits.`)
  red++
}

// `.github/workflows/ci.yml` states this contract in its own comment: without the
// reference clone the tool "故意拒绝", because it cannot tell 1,019 lines of upstream
// code that we renamed a directory around from 1,019 lines we wrote. The printed number
// still shows what was counted (and what was carried), but the verdict is a refusal with
// a remedy, not a green lane over a measurement that does not exist.
if (observed.carried) {
  console.error(`  ✗ surface B is not a measurement in this lane: ${observed.carried}`)
  console.error("    An unattributable surface will not be declared within limits, in either direction.")
  console.error("    Remedy (documented in harness/README.md):")
  console.error("      git clone --branch <upstream.json.tag> --depth 1 https://github.com/anomalyco/opencode.git .external/opencode")
  red++
}

// The denominator of the share this ratchet owns. `engineFiles`/`engineLoc` have been written to
// the golden since 2026-09 and read back by nothing: renaming or emptying `engine/Sources` moves
// both percentages with neither tool surface changing a single line, and the LOC ratchet compares
// only A and B, so it cannot see it. The iron law is "工具面 <10% 代码量" — a ratio over a
// different denominator is a different claim, so the denominator travels with the record.
if (golden && Number.isFinite(golden.engineLoc) && Number.isFinite(golden.engineFiles)) {
  if (observed.engineFiles !== golden.engineFiles || observed.engineLoc !== golden.engineLoc) {
    console.error(`  ✗ the denominator moved: engine ${golden.engineFiles} file(s) / ${golden.engineLoc} LOC → ${observed.engineFiles} / ${observed.engineLoc}. The limit is a SHARE of engine code, so a percentage measured over a different engine is not the same rule: re-record with the change and say which files moved.`)
    red++
  }
} else {
  console.error(`  ✗ the golden carries no readable engine baseline (engineLoc ${JSON.stringify(golden?.engineLoc)}, engineFiles ${JSON.stringify(golden?.engineFiles)}) — both percentages compare against nothing, so this lane cannot declare anything within limits; re-record`)
  red++
}
const wasKernel = golden?.surfaces?.fork?.kernel
const nowKernel = observed.surfaces?.fork?.kernel
if (JSON.stringify(wasKernel) !== JSON.stringify(nowKernel) || golden?.surfaces?.fork?.kernelPin !== observed.surfaces?.fork?.kernelPin) {
  console.error(`  ✗ the kernel attribution moved: golden ${JSON.stringify(wasKernel)} (pinned by ${JSON.stringify(golden?.surfaces?.fork?.kernelPin)}) → this run ${JSON.stringify(nowKernel)} (pinned by ${JSON.stringify(observed.surfaces?.fork?.kernelPin)}). Surface B excludes that dependency's bytes on the strength of this manifest, so taking a new kernel version is a caliber change and is recorded with the bump, not past it.`)
  red++
}

if (red > 0) {
  console.error("tool-surface: the tool surface moved since the last record.")
  console.error("  This is a ratchet, not a ban. If the growth is intended, run")
  console.error("    node harness/tools/tool-surface.mjs --record")
  console.error("  and commit the new golden WITH the code, so the ratio change is reviewed.")
  console.error("  If it is not intended, find out what added lines to a tool surface.")
  process.exit(1)
}
console.log("tool-surface: no growth past the recorded baseline")
