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
const surfaceALoc = surfaceAFiles.reduce((s, f) => s + loc(f), 0)

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
 * while `harness/contracts/kernel-vendor.json` declares each file. A file that
 * lives under the vendor directory without being declared is counted as ours, so
 * "the fork grew its own kernel file" cannot hide behind this exclusion.
 */
function readVendorExclusion(forkRel) {
  const manifestFile = path.join(repoRoot, "harness", "contracts", "kernel-vendor.json")
  if (!existsSync(manifestFile)) return { prefix: null, declared: new Set() }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
  const forkPath = manifest?.forkPath
  if (typeof forkPath !== "string" || !Array.isArray(manifest?.files)) {
    return { prefix: null, declared: new Set() }
  }
  // The manifest stores repo-relative paths; fork-diff lists fork-relative ones.
  // Compare in one space, not two — that mismatch alone would silently disable
  // the exclusion and start counting vendored lines as our own.
  const relTo = forkPath.startsWith(`${forkRel}/`) ? forkPath.slice(forkRel.length + 1) : forkPath
  const prefix = relTo.endsWith("/") ? relTo : `${relTo}/`
  return { prefix, declared: new Set(manifest.files.map((f) => `${prefix}${f.file}`)) }
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
    files.push({ file: rel, kind: undeclared ? "undeclared-vendor" : "added", lines: loc(abs) })
  }

  const prevEdited = new Map(
    (golden?.surfaces?.fork?.files ?? []).filter((f) => f.kind === "edited").map((f) => [f.file, f.lines]),
  )
  for (const rel of fd.edited ?? []) {
    if (!REF_EXTS.includes(path.extname(rel))) continue
    const abs = path.join(forkDir, rel)
    if (!existsSync(abs)) return fail(`fork-diff says '${rel}' is edited but it is not in the tree`)
    if (!hasRef) {
      const was = prevEdited.get(rel)
      if (was === undefined) return fail(`no reference clone and no baseline for edited file '${rel}' — cannot attribute surface B`)
      unmeasured.push(rel)
      files.push({ file: rel, kind: "edited", lines: was })
      continue
    }
    const n = addedLinesAgainstRef(refDir, rel, abs)
    if (!Number.isFinite(n)) return fail(`reference clone at ${refRel} has no '${rel}' at HEAD — cannot attribute surface B`)
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

  const carried = unmeasured.length
    ? `reference clone absent (${refRel}): lines attributed to ${unmeasured.join(", ")} are the previous run's, NOT re-measured`
    : null
  return { files, carried, note: null, excluded: vendor.excluded, tests: excludedTests }
}

const fail = (note) => ({ files: [], carried: null, note, excluded: [], tests: [] })

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
    return diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
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
      fork: "fork-diff `added` files + `+` lines of `edited` vendored files, docs excluded",
      ratio: "surface / (engine + mcp-shell + fork)",
    },
    observedAt: new Date().toISOString().slice(0, 10),
    engineLoc,
    engineFiles: engineFiles.length,
    surfaces: {
      mcpShell: { loc: surfaceALoc, files: surfaceAFiles.length, ratio: ratio(surfaceALoc) },
      fork: {
        loc: forkLoc,
        files: fork.files,
        ratio: ratio(forkLoc),
        vendorExcluded: vendorSummary(fork.excluded),
        testsExcluded: vendorSummary(fork.tests),
      },
    },
    totalToolSurfaceLoc: surfaceALoc + forkLoc,
    note: fork.note,
    carried: fork.carried,
  }
}

const golden = existsSync(goldenFile) ? JSON.parse(readFileSync(goldenFile, "utf8")) : null
const observed = build(golden)

const show = (name, s) =>
  console.log(`  ${name}: ${s.loc} LOC, ${(s.ratio * 100).toFixed(2)}% (documented limit ${(observed.limit * 100).toFixed(0)}%)`)

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
  console.log(`  vendored dependency excluded from surface B per harness/contracts/kernel-vendor.json: ${observed.surfaces.fork.vendorExcluded.files} files, ${observed.surfaces.fork.vendorExcluded.lines} lines (not our surface; kernel-vendor.mjs owns their integrity)`)
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
  mkdirSync(path.dirname(goldenFile), { recursive: true })
  writeFileSync(goldenFile, JSON.stringify(observed, null, 2) + "\n")
  console.log(`recorded -> ${path.relative(repoRoot, goldenFile)}`)
  process.exit(0)
}

if (!golden) die(2, `no golden at ${path.relative(repoRoot, goldenFile)} — run --record`)
if (!golden.surfaces?.mcpShell || !golden.surfaces?.fork) die(2, "golden is missing a surface — re-record")

let red = 0
for (const [name, now, was] of [
  ["surface A (mcp-shell/src)", observed.surfaces.mcpShell, golden.surfaces.mcpShell],
  ["surface B (fork, ours)", observed.surfaces.fork, golden.surfaces.fork],
]) {
  if (now.loc > was.loc) {
    console.error(`  ✗ ${name} grew: ${was.loc} recorded → ${now.loc} LOC (+${now.loc - was.loc})`)
    red++
  }
  if (was.ratio <= golden.limit && now.ratio > observed.limit) {
    console.error(`  ✗ ${name} crossed the documented limit: ${(was.ratio * 100).toFixed(2)}% → ${(now.ratio * 100).toFixed(2)}% (> ${(observed.limit * 100).toFixed(0)}%)`)
    red++
  }
}

if (observed.surfaces.mcpShell.ratio > observed.limit) {
  console.log(`  ! surface A is already over the documented limit (${(observed.surfaces.mcpShell.ratio * 100).toFixed(2)}% > ${(observed.limit * 100).toFixed(0)}%).`)
  console.log("    Known and tolerated: the limit predates the measurement. The gate stops it growing further.")
}

if (observed.note) {
  console.error(`  ✗ surface B cannot be attributed (${observed.note}) — an unmeasured surface cannot be declared within limits.`)
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
