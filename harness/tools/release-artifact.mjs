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
 * CALIBER
 *   Two tree hashes fetched from the split repository named by
 *   `harness/glasspane-harness/product.json` -> `repoUrl` — `refs/heads/main` and
 *   `refs/tags/v<product.json version>` — each peeled to `^{tree}` (the tags are annotated, so
 *   the ref object is not the commit), compared against `HEAD:harness/glasspane-harness`. The
 *   operand is trunk's COMMITTED subtree: a dirty subtree is not a state anyone released, so it
 *   is refused rather than measured.
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
 * Exit codes: 0 agree, 1 disagreement (named rule + which side holds the bytes), 2 cannot
 * measure (no product.json, no subtree in HEAD, dirty subtree, or the split remote did not
 * answer). A refusal never buys exit 0.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const SUBTREE = "harness/glasspane-harness"
const MAX_LISTED = 12

// Paths that RECORD a release rather than being one. A round cannot write "the registry answered
// 0.8.1, the assets verified, the run was green" into a tree the tag has not yet cut, so the
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
    repoRoot = path.resolve(argv[i + 1] ?? cannot("--repo needs a path"))
    i += 1
    continue
  }
  if (flag === "--record") cannot("--record is not a mode of this tool: the artifact either equals trunk's bytes or it does not, and there is nothing to baseline")
  cannot(`unknown flag ${flag} (this tool answers --check, optionally --repo <path>)`)
}

// `git` returns the trimmed stdout, or null when the command itself fails. Callers decide
// whether a failure is a disagreement (never for git errors) or an inability to measure.
const git = (...args) => {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim()
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

// One ls-remote answers both questions — does the remote exist at all, and which of the two
// refs it publishes. A remote that will not answer is "cannot measure"; a remote that answers
// "no such tag" is a disagreement this tool has to say out loud.
const listed = git("ls-remote", splitUrl, "refs/heads/main", `refs/tags/${tagName}`)
if (listed === null) cannot(`git ls-remote ${splitUrl} failed — the published repository could not be reached, so neither the artifact nor the 搬运 branch was observed`)
const shaOf = (ref) => {
  const line = listed.split("\n").find((l) => l.split("\t")[1] === ref)
  return line ? line.split("\t")[0] : null
}
const mainSha = shaOf("refs/heads/main")
const tagSha = shaOf(`refs/tags/${tagName}`) || shaOf(`refs/tags/${tagName}^{}`)

// FETCH_HEAD is a moving pointer, so the tree is read immediately after each fetch: a stale
// FETCH_HEAD from the previous fetch would let the second rule compare the first ref's bytes.
const treeAt = (ref) => {
  if (git("fetch", "--no-tags", "--depth", "1", splitUrl, ref) === null) return null
  return git("rev-parse", "FETCH_HEAD^{tree}")
}

// Paths inside the subtree, split by which side holds them. `--no-renames` is deliberate: a
// rename would otherwise be reported as neither added nor deleted, and "who lost which bytes"
// is the only question this breakdown exists to answer. `--numstat` then says, for a path both
// sides carry, how many lines each side holds that the other does not — a file listed as
// "edited" is exactly where a blind re-split destroys published bytes without any path changing
// sides, which is the shape the `draft=false` line was lost in.
const breakdown = (remoteTree) => {
  const raw = git("diff", "--name-status", "--no-renames", trunkTree, remoteTree)
  if (raw === null) return null
  const onlyTrunk = []
  const onlyRemote = []
  const edited = []
  for (const line of raw.split("\n")) {
    if (line === "") continue
    const [status, ...paths] = line.split("\t")
    if (status === "D") onlyTrunk.push(paths[0])
    else if (status === "A") onlyRemote.push(paths[paths.length - 1])
    else edited.push(paths[0])
  }
  const counts = new Map()
  const num = git("diff", "--numstat", "--no-renames", trunkTree, remoteTree)
  if (num !== null) {
    for (const line of num.split("\n")) {
      if (line === "") continue
      const [added, deleted, file] = line.split("\t")
      counts.set(file, { added, deleted })
    }
  }
  // `+N` is the count a re-split destroys: lines the published bytes hold and trunk does not.
  // Binary files report "-" for both sides, which stays unknown rather than becoming a zero.
  const editedFiles = edited.map((p) => ({ path: p, added: counts.get(p)?.added ?? "?", deleted: counts.get(p)?.deleted ?? "?" }))
  return { onlyTrunk, onlyRemote, edited: editedFiles }
}

const report = (rule, remoteLabel, remoteTree, diff, remedy) => {
  const lines = [
    `${rule}: ${remoteLabel} is ${remoteTree} but trunk's ${SUBTREE} is ${trunkTree} — ${
      rule === "artifact"
        ? "what users install is not what this repository says it shipped. The version-check anchor proved the equality at tag time; the gap opened afterwards."
        : "the next `git subtree split` would either drop trunk's work or overwrite the split's."
    }`,
  ]
  const edited = diff.edited.map((e) => `${e.path} (+${e.added} remote-only line(s) / -${e.deleted} trunk-only line(s))`)
  const section = (label, paths) =>
    paths.length === 0 ? `      ${label}: none` : `      ${label}: ${paths.length}\n${paths.slice(0, MAX_LISTED).map((p) => `        ${p}`).join("\n")}${paths.length > MAX_LISTED ? `\n        … ${paths.length - MAX_LISTED} more` : ""}`
  lines.push(section("trunk-only, i.e. absent from the published bytes", diff.onlyTrunk))
  lines.push(section("published-only, i.e. a whole file trunk does not have", diff.onlyRemote))
  lines.push(section("edited on both sides (+remote-only lines / -trunk-only lines)", edited))
  // The direction that loses work silently: a file both sides carry, where the published copy
  // holds lines trunk no longer does. Whole-file additions are visible as a path on one side;
  // this one is invisible until the split push has already overwritten it — the exact shape
  // `draft=false` was lost in.
  const remoteLines = diff.edited.reduce((n, e) => n + (/^\d+$/.test(e.added) ? Number(e.added) : 0), 0)
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
  const mainTree = treeAt("refs/heads/main")
  if (mainTree === null) cannot(`fetching refs/heads/main from ${splitUrl} did not materialize a tree — the split repository was not observed`)
  measured += 1
  const diff = breakdown(mainTree)
  if (mainTree === trunkTree) agreements.push(`split-main: split refs/heads/main ${mainTree} == trunk's ${SUBTREE} tree`)
  else
    problems.push(
      report(
        "split-main",
        "the published repository's main",
        mainTree,
        diff,
        `reconcile trunk so it holds every published-only line above, then \`git subtree split --prefix=${SUBTREE} -b split/glasspane-harness\` and fast-forward push (docs/release.md step 3).`,
      ),
    )
}

if (tagSha === null) {
  problems.push(`artifact: ${splitUrl} has no tag ${tagName}, but ${SUBTREE}/product.json declares version ${version} — this version has never been released, so no user can have the bytes trunk holds`)
} else {
  const tagTree = treeAt(`refs/tags/${tagName}`)
  if (tagTree === null) cannot(`fetching ${tagName} from ${splitUrl} did not materialize a tree — the released artifact was not observed`)
  measured += 1
  const diff = breakdown(tagTree)
  if (tagTree === trunkTree) agreements.push(`artifact: ${tagName} ${tagTree} == trunk's ${SUBTREE} tree`)
  else {
    // Classify before deciding: a difference is only tolerable when it is the release's own
    // ledger, and only in the direction of the artifact not yet having it.
    const paths = [...diff.onlyTrunk, ...diff.onlyRemote, ...diff.edited.map((e) => e.path)]
    const outside = paths.filter((p) => !LEDGER.has(p))
    const leadLines = linesOf(diff.edited.filter((e) => LEDGER.has(e.path)).map((e) => e.added)) + diff.onlyRemote.filter((p) => LEDGER.has(p)).length
    const lagLines = linesOf(diff.edited.filter((e) => LEDGER.has(e.path)).map((e) => e.deleted))
    const lagFiles = diff.edited.filter((e) => LEDGER.has(e.path)).map((e) => e.path)
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

if (measured === 0) cannot(`neither refs/heads/main nor ${tagName} could be read from ${splitUrl} — nothing was measured, and exit 0 would be a claim about a comparison that never ran`)

console.log(`release-artifact — ${agreements.length} agreement(s) held, ${notes.length} tolerated lag(s), ${problems.length} problem(s) [trunk ${trunkTree}]`)
for (const a of agreements) console.log(`  ✓ ${a}`)
for (const n of notes) console.log(`  △ ${n}`)
for (const p of problems) console.error(`  ✗ ${p}`)
if (problems.length > 0) {
  console.error(`release-artifact: trunk and the published repository are not the same bytes (${splitUrl} @ ${tagName}).`)
  process.exit(1)
}
console.log(
  notes.length === 0
    ? `release-artifact: ${product.name}@${version} — split main and the released ${tagName} are both trunk's ${SUBTREE} tree`
    : `release-artifact: ${product.name}@${version} — split main is trunk's ${SUBTREE} tree, and the released ${tagName} differs from it only by the ledger named above`,
)
