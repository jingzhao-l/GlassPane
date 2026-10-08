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
 *             of a surface cannot be attributed at all
 *
 * This is a ratchet, not a ban: growing a surface is allowed, doing it
 * *unnoticed* is not. `--record` in the same commit is the remedy, and the
 * commit is where the growth gets justified.
 *
 * Exit codes: 0 ok, 1 grew past baseline / crossed the limit, 2 cannot measure.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const goldenFile = path.join(repoRoot, "harness", "contracts", "tool-surface.json")
const forkDiffGolden = path.join(repoRoot, "harness", "contracts", "fork-diff.json")
const pinFile = path.join(repoRoot, "harness", "upstream.json")
const mode = process.argv.includes("--record") ? "record" : "check"

const LIMIT = 0.1 // "<10% 代码量", one of the three architecture iron laws
const LIMIT_SOURCE = "三条架构铁律（specs/GlassPane_Design_Decisions.md）"
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
 * Provenance of the vendored kernel inside the fork. Vendored third-party source
 * is a **dependency**, so its lines do not count as our tool surface — but only
 * while the vendored-kernel manifest declares each file. The manifest is resolved
 * at run time from two candidate locations and the path actually used is printed
 * with the exclusion numbers (`observed.surfaces.fork.vendorManifest`), because
 * naming a path that does not exist is how a provenance claim goes unverifiable.
 * A file that lives under the vendor directory without being declared is counted
 * as ours, so "the fork grew its own kernel file" cannot hide behind this exclusion.
 */
function readVendorExclusion(forkRel) {
  // The kernel-vendor manifest lives with the product it describes, i.e. inside the
  // fork subtree — it is what the subtree split carries, and `kernel-vendor.mjs`
  // reads the same file from there. This function used to look for it at
  // `harness/contracts/kernel-vendor.json`, which does not exist; the `existsSync`
  // guard below therefore returned `prefix: null, declared: empty` and the vendored
  // kernel was silently counted as our own surface B. It surfaced the moment a new
  // vendored file appeared (`vendor/kernel/src/errors.ts`, +5 LOC) — the exclusion
  // had been dead the whole time and nothing had disturbed the total enough to be
  // worth re-reading it.
  //
  // Both locations are accepted so a moved manifest cannot silently disable the
  // exclusion again: the one inside the fork wins, because that is the copy that
  // travels with the product.
  const candidates = [
    path.join(repoRoot, "harness", "glasspane-harness", "contracts", "kernel-vendor.json"),
    path.join(repoRoot, "harness", "contracts", "kernel-vendor.json"),
  ]
  const manifestFile = candidates.find((f) => existsSync(f))
  if (!manifestFile) {
    // Say so out loud. A silently absent exclusion is exactly the failure mode
    // this comment exists to prevent, and this tool's own header argues for
    // printing exclusions so a caliber change cannot go unnoticed.
    console.error("tool-surface: no kernel-vendor manifest found — vendored kernel lines WILL be counted as our surface B")
    return { prefix: null, declared: new Set(), manifest: null }
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
  const forkPath = manifest?.forkPath
  if (typeof forkPath !== "string" || !Array.isArray(manifest?.files)) {
    return { prefix: null, declared: new Set(), manifest: manifestFile }
  }
  // The manifest stores repo-relative paths; fork-diff lists fork-relative ones.
  // Compare in one space, not two — that mismatch alone would silently disable
  // the exclusion and start counting vendored lines as our own.
  const relTo = forkPath.startsWith(`${forkRel}/`) ? forkPath.slice(forkRel.length + 1) : forkPath
  const prefix = relTo.endsWith("/") ? relTo : `${relTo}/`
  return { prefix, declared: new Set(manifest.files.map((f) => `${prefix}${f.file}`)), manifest: manifestFile }
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
  const vendor = { ...readVendorExclusion(forkRel), excluded: [] }

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
    if (vendor.declared.has(rel)) {
      vendor.excluded.push({ file: rel, lines: loc(abs) })
      continue
    }
    if (isTest(rel)) {
      excludedTests.push({ file: rel, lines: loc(abs) })
      continue
    }
    const undeclared = vendor.prefix !== null && rel.startsWith(vendor.prefix)
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
    if (isPureRename(refDir, abs, rel, fd)) {
      renamed.push({ file: rel, lines: loc(abs) })
      continue
    }
    files.push({ file: rel, kind: undeclared ? "undeclared-vendor" : "added", lines: loc(abs) })
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
    const n = addedLinesAgainstRef(refDir, rel, abs)
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

  // A rule that excludes everything is indistinguishable from a measurement of
  // zero, so refuse instead: `(^|\/test\/)` once matched the empty string at
  // position 0 and classified every single file as a test, which reported
  // surface B as 14 LOC and looked like a plausible number.
  const codeish = (fd.added ?? []).filter((rel) => REF_EXTS.includes(path.extname(rel)) && !vendor.declared.has(rel))
  if (codeish.length > 0 && files.length === 0) {
    return fail(`${codeish.length} fork file(s) are ours to measure but every one was excluded — the exclusion rules are wrong, not the surface empty`)
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
  return { files, carried, note: null, excluded: vendor.excluded, tests: excludedTests, manifest: vendor.manifest }
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

function addedLinesAgainstRef(refDir, rel, forkAbs) {
  let before
  try {
    before = execFileSync("git", ["-C", refDir, "show", `HEAD:${rel}`], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 })
  } catch {
    return NaN
  }
  const tmp = path.join(tmpdir(), `tool-surface-${rel.replace(/[^A-Za-z0-9]+/g, "_")}.before`)
  writeFileSync(tmp, before)
  try {
    let diff = ""
    try {
      execFileSync("diff", ["-u", tmp, forkAbs], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 })
    } catch (err) {
      diff = typeof err?.stdout === "string" ? err.stdout : "" // diff exits 1 when files differ: normal
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
function isPureRename(refDir, abs, rel, fd) {
  if (!refDir || !existsSync(path.join(refDir, ".git"))) return false
  const here = createHash("sha256").update(readFileSync(abs)).digest("hex")
  for (const gone of fd.deleted ?? []) {
    if (path.extname(gone) !== path.extname(rel)) continue
    let before
    try {
      before = execFileSync("git", ["-C", refDir, "show", `HEAD:${gone}`], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 })
    } catch {
      continue
    }
    if (createHash("sha256").update(before).digest("hex") === here) return true
  }
  return false
}

function build(golden) {
  const fork = measureFork(golden)
  const forkLoc = fork.files.reduce((s, f) => s + f.lines, 0)
  const denom = engineLoc + surfaceALoc + forkLoc
  const ratio = (n) => Math.round((n / denom) * 10000) / 10000
  return {
    limit: LIMIT,
    limitSource: LIMIT_SOURCE,
    caliber: {
      engine: "lines of every *.swift under engine/Sources",
      mcpShell: "lines of every *.ts under mcp-shell/src",
      fork: "fork-diff `added` files + authored (`+`) lines of `edited` vendored files, docs excluded; a hunk that differs only by a brand token is a rebranding and is not counted, and one deleted line excuses at most one re-added line (pairing is one-to-one, so 40 copies of a rebranded line bill 39)",
      ratio: "surface / (engine + mcp-shell + fork)",
    },
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
        // The path that was ACTUALLY read, repo-relative, so the exclusion line
        // cannot name a manifest that does not exist. Null when nothing was found.
        vendorManifest: fork.manifest ? path.relative(repoRoot, fork.manifest).split(path.sep).join("/") : null,
      },
    },
    totalToolSurfaceLoc: surfaceALoc + forkLoc,
    note: fork.note,
    carried: fork.carried,
  }
}

const golden = existsSync(goldenFile) ? JSON.parse(readFileSync(goldenFile, "utf8")) : null
const observed = build(golden)

// The limit is a documented number, so a surface sitting over it is a fact the
// report must state whatever it is doing — not a fact only surface A gets to say.
const pct = (n) => `${(n * 100).toFixed(2)}%`
const overLimit = (s) => s.ratio > observed.limit
const show = (name, s) =>
  console.log(
    `  ${name}: ${s.loc} LOC, ${pct(s.ratio)} (documented limit ${(observed.limit * 100).toFixed(0)}%)${overLimit(s) ? "  ← OVER LIMIT" : ""}`,
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
  // Name the manifest that was actually resolved, not a hardcoded path: a wrong
  // provenance string is unfalsifiable by reading, and the reader cannot tell a
  // live exclusion from a dead one.
  const manifest = observed.surfaces.fork.vendorManifest ?? "no manifest resolved"
  console.log(`  vendored dependency excluded from surface B per ${manifest} (the manifest resolved on this run): ${observed.surfaces.fork.vendorExcluded.files} files, ${observed.surfaces.fork.vendorExcluded.lines} lines (not our surface; kernel-vendor.mjs owns their integrity)`)
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
  mkdirSync(path.dirname(goldenFile), { recursive: true })
  // Saying it before writing it: the golden about to be written blesses a surface
  // that is over the documented limit, and from that commit the crossing check for
  // it is spent. The record is still allowed (this is a ratchet, not a ban) — but
  // not silently.
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
    const before = was.byFile
    const after = now.byFile
    if (before && after) {
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

if (red > 0) {
  console.error("tool-surface: the tool surface moved since the last record.")
  console.error("  This is a ratchet, not a ban. If the growth is intended, run")
  console.error("    node harness/tools/tool-surface.mjs --record")
  console.error("  and commit the new golden WITH the code, so the ratio change is reviewed.")
  console.error("  If it is not intended, find out what added lines to a tool surface.")
  process.exit(1)
}
console.log("tool-surface: no growth past the recorded baseline")
