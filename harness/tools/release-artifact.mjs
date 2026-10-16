#!/usr/bin/env node
/**
 * release-artifact.mjs — is what users install byte-for-byte what trunk holds?
 *
 * WHY
 *   The published repository is a `git subtree split` of `harness/glasspane-harness`, and the
 *   release is whatever the tag points at. `release.yml`'s `version-check` step already proves
 *   that equality, but only at the moment of a release: between "trunk received a commit that
 *   touches the subtree" and "the next tag was cut", nothing measures it, and the gap is real.
 *   Measured 2026-10-16 with every parent-side lane green: trunk's subtree tree was `c21d9e4b`
 *   while the `v0.8.0` tag's tree (and split `main`) was `8620e992` — the 0.8.0 closeout notes
 *   (74 lines of SYNCLOG.md) lived only in trunk, so the shipped archive did not carry the
 *   record of its own release. The same comparison surfaced the other direction too, which is
 *   the dangerous one: trunk had LOST a line the split still held (`draft=false` → `draft=`),
 *   so a re-split performed blindly would have deleted correct bytes from the published repo.
 *
 *   It also taught a second lesson, about this tool's own shape: fetching the published
 *   repository into the object store of the repository being measured appends the fetched tip to
 *   `.git/shallow`, and a shallow marker truncates history traversal — which silently falsifies
 *   every `git merge-base --is-ancestor` a subtree push leans on. Measured the same day: nine
 *   spurious markers, each with all of its parents present locally, one of them making a
 *   already-published 搬运 branch look un-landed. So the remote side is fetched into a scratch
 *   object store and the two trees are compared by what they hold; nothing in the measured
 *   repository is written, and battery K in the selftest holds that line.
 *
 * CALIBER
 *   Two tree hashes read out of the split repository named by
 *   `harness/glasspane-harness/product.json` -> `repoUrl` — `refs/heads/main` and
 *   `refs/tags/v<product.json version>` — each peeled to `^{tree}` (those tags are annotated, so
 *   the ref names a tag object), compared against `HEAD:harness/glasspane-harness`. Per-path
 *   blob hashes say who holds which file; a path both sides hold gets its line counts from a
 *   `git diff --no-index` over the two materialized blobs. The operand is trunk's COMMITTED
 *   subtree: a dirty subtree is not a state anyone released, so it is refused, not measured.
 *
 * RULES
 *   split-main   split `refs/heads/main` tree == trunk's subtree tree, strictly, in either
 *                direction, naming which side holds the differing bytes. Pushing the 搬运 branch
 *                costs no version, so there is no state in which lagging is acceptable.
 *   artifact     split `refs/tags/v<version>` tree == trunk's subtree tree. Red when a version
 *                trunk declares was never tagged, when anything outside SYNCLOG.md/CHANGELOG.md
 *                differs, or when the artifact LEADS trunk on those. The one tolerated state —
 *                printed as `△`, never as a silent pass — is the artifact not yet carrying its own
 *                release record, because that record cannot describe a tree that did not exist
 *                when it was written.
 *
 * MODES
 *   --check (default)  both rules must hold. There is no `--record`: an agreement is not a
 *   number to baseline, and a golden here would let a stale artifact be recorded as expected.
 *   --repo <path>      measure a repository other than this one (the selftest points it at
 *   file:// fixtures; production runs never pass it).
 *
 * Exit codes: 0 agree (a tolerated `△` is still 0, and it is printed), 1 disagreement (named rule
 * + which side holds the bytes), 2 cannot measure (no product.json, no subtree in HEAD, dirty
 * subtree, or the split remote did not answer). A refusal never buys exit 0.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const SUBTREE = "harness/glasspane-harness"
const MAX_LISTED = 12

// Paths that RECORD a release rather than being one. A round cannot write "the registry answered
// 0.8.2, the assets verified, the run was green" into a tree the tag has not yet cut, so the
// tagged artifact is permitted to lag trunk by these files' additions — said out loud, never
// silently, and carried by the next tag. It is never permitted to LEAD (bytes trunk lost), and no
// other path is tolerated in either direction. `split-main` takes no such allowance: pushing the
// 搬运 branch costs no version, so it has to be current the moment trunk moves.
const LEDGER = new Set(["SYNCLOG.md", "CHANGELOG.md"])
const linesOf = (values) => values.reduce((n, v) => n + (/^\d+$/.test(v) ? Number(v) : 0), 0)

const cannot = (detail) => {
  console.error(`release-artifact: CANNOT MEASURE — ${detail}`)
  process.exit(2)
}

const argv = process.argv.slice(2)
let repoRoot = path.resolve(here, "..", "..")
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i]
  if (flag === "--check") continue
  if (flag === "--repo") {
    const value = argv[i + 1]
    if (!value) cannot("--repo needs a path")
    repoRoot = path.resolve(value)
    i += 1
    continue
  }
  if (flag === "--record") cannot("--record is not a mode of this tool: the artifact either equals trunk's bytes or it does not, and there is nothing to baseline")
  cannot(`unknown flag ${flag} (this tool answers --check, optionally --repo <path>)`)
}

// `git` reads/writes the measured repository; `gitIn` is for the scratch object store. Both return
// trimmed stdout, or null when the command itself failed — callers decide whether that is a
// disagreement (never for a git error) or an inability to measure.
const git = (...args) => {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim()
  } catch {
    return null
  }
}
const gitIn = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim()
  } catch {
    return null
  }
}

const productPath = path.join(repoRoot, SUBTREE, "product.json")
if (!existsSync(productPath)) cannot(`no ${SUBTREE}/product.json under ${repoRoot} — the version line and the split repository URL both come from it`)
const product = JSON.parse(readFileSync(productPath, "utf8"))
const version = product.version
const splitUrl = product.repoUrl
if (typeof version !== "string" || version === "") cannot(`${productPath} carries no usable "version"`)
if (typeof splitUrl !== "string" || splitUrl === "") cannot(`${productPath} carries no usable "repoUrl" — without the published repository named by the product there is nothing to compare against`)

const tagName = `v${version}`

// The subtree has to be committed: measuring a working-tree state against a released tag would
// report agreement about two things that are neither of them.
const dirty = git("status", "--porcelain", "--", SUBTREE)
if (dirty === null) cannot(`git status failed in ${repoRoot}`)
if (dirty !== "") cannot(`${SUBTREE} has uncommitted changes — the anchor compares committed bytes:\n${dirty}`)

const trunkTree = git("rev-parse", `HEAD:${SUBTREE}`)
if (trunkTree === null) cannot(`HEAD has no ${SUBTREE} tree in ${repoRoot}`)

// One ls-remote answers both questions — can the remote be reached at all, and which of the two
// refs it publishes. A remote that will not answer is "cannot measure"; a remote that answers
// "no such tag" is a disagreement this tool has to say out loud.
const listed = git("ls-remote", splitUrl, "refs/heads/main", `refs/tags/${tagName}`)
if (listed === null) cannot(`git ls-remote ${splitUrl} failed — the published repository could not be reached, so neither the artifact nor the 搬运 branch was observed`)
const shaOf = (ref) => {
  const line = listed.split("\n").find((l) => l.split("\t")[1] === ref)
  return line ? line.split("\t")[0] : null
}
const mainSha = shaOf("refs/heads/main")
const tagSha = shaOf(`refs/tags/${tagName}`)

// A bare scratch store: the remote's objects land here, never in the measured repository, and the
// directory is removed on every exit path below.
const scratch = mkdtempSync(path.join(tmpdir(), `release-artifact-${process.pid}-`))
const scratchRepo = path.join(scratch, "remote.git")
const cleanup = () => rmSync(scratch, { recursive: true, force: true })

const finish = (code) => {
  cleanup()
  process.exit(code)
}

if (git("--version") === null) cannot("git is not runnable")
mkdirSync(scratchRepo, { recursive: true })
if (gitIn(scratchRepo, "init", "-q", "--bare") === null) cannot(`could not initialize the scratch object store in ${scratch}`)

// `--depth 1` because the published repository's history is irrelevant here: only each tip's tree
// is read. BOTH refs are negotiated in one fetch — a second depth-limited fetch into a store that
// already holds a shallow boundary cannot extend it and fails, which is exactly how a tag pointing
// at an older commit than `main` (the normal end-of-round state) used to answer "cannot measure".
// The refs are named inside the scratch store, so nothing in the measured repository moves.
const refspecs = []
if (mainSha !== null) refspecs.push("refs/heads/main:refs/artifact/main")
if (tagSha !== null) refspecs.push(`refs/tags/${tagName}:refs/artifact/tag`)
if (refspecs.length > 0) {
  if (gitIn(scratchRepo, "fetch", "-q", "--no-tags", "--depth", "1", splitUrl, ...refspecs) === null) {
    cleanup()
    cannot(`fetching ${refspecs.map((r) => r.split(":")[0]).join(" and ")} from ${splitUrl} did not materialize — neither the 搬运 branch nor the released artifact was observed`)
  }
}
const treeAt = (name) => gitIn(scratchRepo, "rev-parse", `refs/artifact/${name}^{tree}`)

// A path listing per side: an object store that holds one tree also holds every blob under it, so
// `ls-tree -r` answers "which paths, with which content" without a checkout.
const listing = (dir, tree) => {
  const raw = gitIn(dir, "ls-tree", "-r", tree)
  if (raw === null) return null
  const map = new Map()
  for (const line of raw.split("\n")) {
    if (line === "") continue
    const [meta, file] = line.split("\t")
    const fields = meta.split(" ")
    map.set(file, fields[2])
  }
  return map
}

const trunkFiles = listing(repoRoot, trunkTree)
if (trunkFiles === null) cannot(`could not list trunk's ${SUBTREE} tree ${trunkTree}`)

// Line counts for a path both sides hold. `+N` is what a re-split destroys: lines the published
// bytes hold and trunk does not. `--no-index` compares two loose files, so this needs neither
// repository and materializes nothing into either. The blobs are read as BYTES, not through the
// trimming helper: dropping a file's final newline makes the last line compare as modified, so a
// one-line append is reported as +2/-1 instead of +1/-0 — enough to turn a tolerated ledger lag into
// a red, and enough to invent a RE-SPLIT RISK that is not there.
const blobAt = (dir, hash) => {
  try {
    return execFileSync("git", ["-C", dir, "cat-file", "blob", hash], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 })
  } catch {
    return null
  }
}
const lineDelta = (trunkBlob, remoteBlob) => {
  const a = path.join(scratch, "trunk-side")
  const b = path.join(scratch, "remote-side")
  const left = blobAt(repoRoot, trunkBlob)
  const right = blobAt(scratchRepo, remoteBlob)
  if (left === null || right === null) return { added: "?", deleted: "?" }
  writeFileSync(a, left)
  writeFileSync(b, right)
  let out = null
  try {
    out = execFileSync("git", ["diff", "--no-index", "--numstat", "--", a, b], { encoding: "utf8", cwd: scratch })
  } catch (e) {
    out = `${e.stdout ?? ""}`
  }
  const fields = (out ?? "").split("\n").find((l) => l !== "")?.split("\t")
  if (!fields || fields.length < 2) return { added: "?", deleted: "?" }
  return { added: fields[0], deleted: fields[1] }
}

const breakdown = (remoteTree) => {
  const remoteFiles = listing(scratchRepo, remoteTree)
  if (remoteFiles === null) return null
  const onlyTrunk = []
  const onlyRemote = []
  const edited = []
  for (const [file, blob] of trunkFiles) {
    if (!remoteFiles.has(file)) onlyTrunk.push(file)
    else if (remoteFiles.get(file) !== blob) edited.push({ path: file, ...lineDelta(blob, remoteFiles.get(file)) })
  }
  for (const file of remoteFiles.keys()) if (!trunkFiles.has(file)) onlyRemote.push(file)
  return { onlyTrunk, onlyRemote, edited }
}

const report = (rule, remoteLabel, remoteTree, diff, remedy) => {
  const lines = [
    `${rule}: ${remoteLabel} is ${remoteTree} but trunk's ${SUBTREE} is ${trunkTree} — ${
      rule === "artifact"
        ? "what users install is not what this repository says it shipped. The version-check anchor proved the equality at tag time; the gap opened afterwards."
        : "the next `git subtree split` would either drop trunk's work or overwrite the split's."
    }`,
  ]
  const section = (label, paths) =>
    paths.length === 0 ? `      ${label}: none` : `      ${label}: ${paths.length}\n${paths.slice(0, MAX_LISTED).map((p) => `        ${p}`).join("\n")}${paths.length > MAX_LISTED ? `\n        … ${paths.length - MAX_LISTED} more` : ""}`
  const edited = diff.edited.map((e) => `${e.path} (+${e.added} remote-only line(s) / -${e.deleted} trunk-only line(s))`)
  lines.push(section("trunk-only, i.e. absent from the published bytes", diff.onlyTrunk))
  lines.push(section("published-only, i.e. a whole file trunk does not have", diff.onlyRemote))
  lines.push(section("edited on both sides (+remote-only lines / -trunk-only lines)", edited))
  // The direction that loses work silently: a file both sides carry, where the published copy
  // holds lines trunk no longer does. Whole-file additions show as a path on one side; this one is
  // invisible until the split push has already overwritten it — the shape `draft=false` was lost in.
  const remoteLines = linesOf(diff.edited.map((e) => e.added))
  const riskFiles = diff.edited.filter((e) => /^\d+$/.test(e.added) && Number(e.added) > 0).length
  if (remoteLines > 0 || diff.onlyRemote.length > 0)
    lines.push(`      ⚠ RE-SPLIT RISK: the published bytes hold ${remoteLines} line(s) in ${riskFiles} file(s) plus ${diff.onlyRemote.length} whole file(s) that trunk does not — \`git subtree split\` from trunk today overwrites them. Land every one of those in trunk first, then split.`)
  lines.push(`      remedy: ${remedy}`)
  return lines.join("\n")
}

const problems = []
const agreements = []
const notes = []
let measured = 0

if (mainSha === null) {
  problems.push(`split-main: ${splitUrl} publishes no refs/heads/main — the 搬运 branch that a subtree push is supposed to fast-forward is gone, so nothing downstream of it can be trusted to equal trunk`)
} else {
  const mainTree = treeAt("main")
  if (mainTree === null) {
    cleanup()
    cannot(`refs/heads/main was advertised by ${splitUrl} but no tree could be read for it`)
  }
  measured += 1
  if (mainTree === trunkTree) agreements.push(`split-main: split refs/heads/main ${mainTree} == trunk's ${SUBTREE} tree`)
  else
    problems.push(
      report(
        "split-main",
        "the published repository's main",
        mainTree,
        breakdown(mainTree),
        `reconcile trunk so it holds every published-only line above, then \`git subtree split --prefix=${SUBTREE} -b split/glasspane-harness\` and fast-forward push (docs/release.md step 3).`,
      ),
    )
}

if (tagSha === null) {
  problems.push(`artifact: ${splitUrl} has no tag ${tagName}, but ${SUBTREE}/product.json declares version ${version} — this version has never been released, so no user can have the bytes trunk holds`)
} else {
  const tagTree = treeAt("tag")
  if (tagTree === null) {
    cleanup()
    cannot(`${tagName} was advertised by ${splitUrl} but no tree could be read for it (annotated tags are peeled; a tag object that points at nothing is not a measurement)`)
  }
  measured += 1
  const diff = breakdown(tagTree)
  if (tagTree === trunkTree) agreements.push(`artifact: ${tagName} ${tagTree} == trunk's ${SUBTREE} tree`)
  else {
    // Classify before deciding: a difference is only tolerable when it is the release's own
    // ledger, and only in the direction of the artifact not yet having it.
    const paths = [...diff.onlyTrunk, ...diff.onlyRemote, ...diff.edited.map((e) => e.path)]
    const outside = paths.filter((p) => !LEDGER.has(p))
    const ledgerEdited = diff.edited.filter((e) => LEDGER.has(e.path))
    const leadLines = linesOf(ledgerEdited.map((e) => e.added)) + diff.onlyRemote.filter((p) => LEDGER.has(p)).length
    const lagLines = linesOf(ledgerEdited.map((e) => e.deleted))
    const lagFiles = ledgerEdited.map((e) => e.path)
    if (outside.length > 0 || leadLines > 0)
      problems.push(
        report(
          "artifact",
          `the tree behind the released ${tagName}`,
          tagTree,
          diff,
          `land trunk's side of every difference above, re-split, and cut the next patch so the tagged tree is trunk's (docs/release.md steps 3-4). ${outside.length} of the differing path(s) are not the release ledger, so no allowance applies. A tag that has already been published is never moved.`,
        ),
      )
    else notes.push(`artifact: ${tagName} lags trunk by ${lagLines} line(s) of ${lagFiles.join(", ")} — the record of the release itself, which cannot describe a tree the tag had not yet cut. Named here rather than hidden; the next tag carries it. (Nothing outside the ledger differs: ${paths.length} path(s), all ledger.)`)
  }
}

if (measured === 0) {
  cleanup()
  cannot(`neither refs/heads/main nor ${tagName} could be read from ${splitUrl} — nothing was measured, and exit 0 would be a claim about a comparison that never ran`)
}

console.log(`release-artifact — ${agreements.length} agreement(s) held, ${notes.length} tolerated lag(s), ${problems.length} problem(s) [trunk ${trunkTree}]`)
for (const a of agreements) console.log(`  ✓ ${a}`)
for (const n of notes) console.log(`  △ ${n}`)
for (const p of problems) console.error(`  ✗ ${p}`)
if (problems.length > 0) {
  console.error(`release-artifact: trunk and the published repository are not the same bytes (${splitUrl} @ ${tagName}).`)
  finish(1)
}
console.log(
  notes.length === 0
    ? `release-artifact: ${product.name}@${version} — split main and the released ${tagName} are both trunk's ${SUBTREE} tree`
    : `release-artifact: ${product.name}@${version} — split main is trunk's ${SUBTREE} tree, and the released ${tagName} differs from it only by the ledger named above`,
)
finish(0)
