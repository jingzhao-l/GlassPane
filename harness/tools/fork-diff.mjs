#!/usr/bin/env node
/**
 * fork-diff.mjs — measure how far the glasspane-harness fork has drifted from
 * its upstream base, exactly, on every run.
 *
 * WHY. The iterate-side harness fork documents "8 fixed-point modifications"
 * while 144 of its 194 shared files actually differ from upstream, and nothing
 * in the repository could notice. Customizing a fork is a legitimate choice;
 * not knowing the size of the customization is the failure. This tool makes the
 * divergence a checked number instead of a paragraph of prose.
 *
 * HOW. Compare every file in the fork tree against the pinned upstream clone by
 * **git blob hash** — identical hash means byte-identical content, so symlink
 * targets and file modes are covered too and "changed whitespace only" cannot
 * hide. Four buckets: identical / edited / added / deleted. Edited files are
 * additionally pinned by *both* hashes in the golden (upstream's and ours), so
 * growth inside an already-declared patch cannot pass unnoticed either.
 *
 * MODES
 *   --record  write harness/contracts/fork-diff.json (the declared divergence)
 *   --check   fail if the tree's actual divergence differs from that record
 *
 * With the reference clone absent, --check still verifies OUR side of the
 * record (fork-side hashes of edited files + presence of added ones) and prints
 * that upstream bytes were not re-measured. A clone-free lane that checks
 * nothing must not exit 0.
 *
 * Exit codes: 0 ok (including a loud offline partial check), 1 divergence
 * differs from the record, 2 the tool could not measure (missing pin, missing
 * reference for a mode that needs one).
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync, mkdirSync, readlinkSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const pinFile = path.join(repoRoot, "harness", "upstream.json")
const goldenFile = path.join(repoRoot, "harness", "contracts", "fork-diff.json")
const mode = process.argv.includes("--record") ? "record" : "check"

function die(code, msg) {
  console.error(`fork-diff: ${msg}`)
  process.exit(code)
}
if (!existsSync(pinFile)) die(2, `missing ${path.relative(repoRoot, pinFile)}`)
const pin = JSON.parse(readFileSync(pinFile, "utf8"))
if (!pin.tag) die(2, "upstream.json missing \"tag\"")
const forkRel = pin.fork?.path
const refRel = pin.fork?.referenceClone
if (!forkRel || !refRel) die(2, 'upstream.json missing fork.path / fork.referenceClone')

const forkDir = path.join(repoRoot, forkRel)
const forkPrefix = forkRel.replace(/\/$/, "") + "/"
const refDir = path.join(repoRoot, refRel)
if (!existsSync(forkDir)) die(2, `fork tree not found at ${forkRel}`)

/** Walk a tree, returning relative paths; symlinks are entries, never followed. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules" || entry === "dist") continue
    const full = path.join(dir, entry)
    const rel = path.relative(base, full).split(path.sep).join("/")
    if (lstatSync(full).isDirectory()) {
      if (ignoredDirs.has(rel)) continue
      walk(full, base, out)
      continue
    }
    // An ignored *file* (a tsbuildinfo, a log) is the same false positive as an
    // ignored directory, so both come out of the walk.
    if (ignoredDirs.has(rel)) continue
    const st = lstatSync(full)
    if (st.isFile() || st.isSymbolicLink()) out.push(rel)
  }
  return out
}

/**
 * Directories git ignores, collapsed (`--directory`), computed in ONE call.
 *
 * WHY: gitignored build output is not a candidate for "present on disk but missing
 * from the release", and listing it was a false positive that trains people to
 * ignore this tool (found 2026-09-25, when a turbo log made the ruler red on a
 * clean tree). A per-path `check-ignore` is correct but costs one subprocess per
 * entry — thousands for this tree — so the set is asked for once and whole
 * subtrees are pruned. A *tracked* file is never in this set by construction.
 */
const ignoredDirs = new Set(
  execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--", forkRel], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean)
    .map((p) => (p.startsWith(forkPrefix) ? p.slice(forkPrefix.length) : p).replace(/\/$/, "")),
)

/** git's blob hash: sha1("blob <len>\0" + content); symlink content is its target. */
function blobHash(abs) {
  const st = lstatSync(abs)
  const body = st.isSymbolicLink() ? Buffer.from(readlinkSync(abs)) : readFileSync(abs)
  const header = Buffer.from(`blob ${body.length}\0`)
  return createHash("sha1").update(Buffer.concat([header, body])).digest("hex")
}

function observeFork() {
  const map = new Map()
  for (const rel of walk(forkDir)) {
    const abs = path.join(forkDir, rel)
    const st = lstatSync(abs)
    map.set(rel, { hash: blobHash(abs), mode: st.isSymbolicLink() ? "120000" : (st.mode & 0o111 ? "100755" : "100644") })
  }
  return map
}

/**
 * The fork side as **git has it**, not as the disk has it.
 *
 * WHY this exists (found by its own failure, 2026-09-25): the four buckets used
 * to compare the fork's *working tree* against the reference's *git index*. A
 * file that sits on disk but was never committed therefore looked byte-identical
 * to upstream — and the first release CI run on the split repo failed with
 * `ENOENT ... @opencode-ai/client@file:vendor/...tgz` because exactly seven
 * upstream files (including that vendored tarball) were physically present but
 * absent from our history. "Faithful import" has to be measured in the same
 * place a release reads from: the committed tree.
 */
function observeForkCommitted() {
  const raw = execFileSync("git", ["ls-tree", "-r", "HEAD", "--", forkRel], { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  const prefix = forkRel.replace(/\/$/, "") + "/"
  const map = new Map()
  for (const line of raw.split("\n")) {
    if (!line) continue
    const match = /^(\d+)\s+blob\s+([0-9a-f]{40})\t(.*)$/.exec(line)
    if (!match) continue
    const rel = match[3].startsWith(prefix) ? match[3].slice(prefix.length) : match[3]
    map.set(rel, { hash: match[2], mode: match[1] })
  }
  if (!map.size) die(2, `git ls-tree found nothing under ${forkRel} — cannot measure the committed fork tree`)
  return map
}

function observeReference() {
  if (!existsSync(path.join(refDir, ".git"))) return null
  const version = execFileSync("git", ["-C", refDir, "describe", "--tags"], { encoding: "utf8" }).trim()
  if (version !== pin.tag) die(2, `reference clone is ${version}, upstream.json pins ${pin.tag} — refuse to compare across bases`)
  const raw = execFileSync("git", ["-C", refDir, "ls-files", "-s"], { encoding: "utf8" })
  const map = new Map()
  for (const line of raw.split("\n")) {
    if (!line) continue
    const [meta, ...rest] = line.split("\t")
    const [md, hash] = meta.split(" ")
    const rel = rest.join("\t")
    // git stores symlinks as mode 120000 with the blob of their target string,
    // which is exactly what blobHash() reproduces above.
    map.set(rel.replace(/^"|"$/g, ""), { hash, mode: md })
  }
  return map
}

const forkCommitted = observeForkCommitted()
const fork = observeFork()
const ref = observeReference()
// Files on disk that git does not have (inside the fork subtree). They are not
// "ours" in any shipped sense — they are invisible to a release — so they are
// reported by name instead of being silently counted as identical.
const uncommitted = [...fork.keys()].filter((rel) => !forkCommitted.has(rel)).sort()
const missingFromWorktree = [...forkCommitted.keys()].filter((rel) => !fork.has(rel)).sort()
// Tracked, present on both sides, and *different*: neither of the two lists above catches it, so
// this is the third way the working tree can disagree with the tree a release ships.
const dirty = [...forkCommitted.keys()].filter((rel) => {
  const disk = fork.get(rel)
  return disk !== undefined && disk.hash !== forkCommitted.get(rel).hash
}).sort()

if (!ref) {
  if (mode === "record") die(2, `--record needs the reference clone at ${refRel} (git clone --branch ${pin.tag})`)
  if (!existsSync(goldenFile)) die(2, `no golden at ${path.relative(repoRoot, goldenFile)} and no reference clone`)
  const golden = JSON.parse(readFileSync(goldenFile, "utf8"))
  if (golden.baseTag !== pin.tag) die(1, `golden recorded at ${golden.baseTag}, pin says ${pin.tag} — refusing to compare across bases`)
  console.log(`fork-diff: reference clone absent (${refRel}) — upstream bytes NOT re-measured in this run.`)
  console.log(`  recorded divergence against ${golden.baseTag}: ${golden.counts.edited} edited, ${golden.counts.added} added, ${golden.counts.deleted} deleted, ${golden.counts.identical} identical`)

  // What a clone-free lane CAN still check is **our** side of the divergence:
  // every edited vendored file carries the fork-side hash recorded when the
  // clone was present. Without this, a CI lane would print "offline, OK" while
  // the patched files accumulated changes nobody could see — the iterate-side
  // failure, reproduced with extra steps.
  const detail = golden.editedDetail ?? []
  const wantEdited = (golden.edited ?? []).length
  // The expectation comes from the golden's *name list*, not from `counts.edited` — a number in
  // the very file being stripped. With both keys cut together this lane used to exit 0 while
  // printing that it had hash-checked nothing.
  if (detail.length !== wantEdited) {
    die(1, `golden declares ${wantEdited} edited file(s) but carries content hashes for ${detail.length} — this lane has nothing meaningful to check. Re-run --record with the reference clone present.`)
  }
  const addedDetail = golden.addedDetail ?? []
  const wantAdded = (golden.added ?? []).length
  if (addedDetail.length !== wantAdded) {
    die(1, `golden declares ${wantAdded} of our file(s) but carries content hashes for ${addedDetail.length} — re-run --record with the reference clone present.`)
  }
  let offlineDrift = 0
  for (const d of detail) {
    const now = forkCommitted.get(d.file)
    if (!now) {
      console.error(`  ✗ '${d.file}' is declared edited but is missing from the fork tree`)
      offlineDrift++
      continue
    }
    if (now.hash !== d.forkHash) {
      console.error(`  ✗ '${d.file}': our content moved (${d.forkHash.slice(0, 8)} → ${now.hash.slice(0, 8)}) — re-record with the clone present so the divergence is reviewed`)
      offlineDrift++
    }
  }
  for (const d of addedDetail) {
    const now = forkCommitted.get(d.file)
    if (!now) {
      console.error(`  ✗ '${d.file}' is declared as ours but is not committed in the fork tree`)
      offlineDrift++
      continue
    }
    if (now.hash !== d.forkHash) {
      console.error(`  ✗ '${d.file}': our own file moved (${d.forkHash.slice(0, 8)} → ${now.hash.slice(0, 8)}) — re-record with the clone present so the change is reviewed`)
      offlineDrift++
    }
  }
  for (const rel of golden.added ?? []) {
    if (!forkCommitted.has(rel)) {
      console.error(`  ✗ '${rel}' is declared as ours but is not committed in the fork tree`)
      offlineDrift++
    }
  }
  for (const rel of uncommitted) {
    console.error(`  ✗ '${rel}' exists on disk but is not committed — a release would not ship it`)
    offlineDrift++
  }
  if (offlineDrift > 0) {
    console.error(`fork-diff: ${offlineDrift} mismatch(es) between the tree and ${path.relative(repoRoot, goldenFile)} (our side).`)
    process.exit(1)
  }
  console.log(`  our side matches the record: ${detail.length} edited file(s) hash-checked, ${addedDetail.length} added file(s) hash-checked (both lists match the golden's name lists exactly)`)
  console.log("  OK (offline). Upstream bytes are checked by the local/pre-release full run and by harness-contract.yml, not here.")
  process.exit(0)
}

const identical = []
const edited = []
const added = []
const deleted = []
for (const [rel, f] of forkCommitted) {
  const r = ref.get(rel)
  if (!r) added.push(rel)
  else if (r.hash !== f.hash || r.mode !== f.mode) edited.push(rel)
  else identical.push(rel)
}
for (const rel of ref.keys()) if (!forkCommitted.has(rel)) deleted.push(rel)

const observed = {
  baseTag: pin.tag,
  forkPath: forkRel,
  referenceClone: refRel,
  observedAt: new Date().toISOString().slice(0, 10),
  counts: { identical: identical.length, edited: edited.length, added: added.length, deleted: deleted.length },
  edited: edited.sort(),
  added: added.sort(),
  deleted: deleted.sort(),
  // Content, not just names. A divergence declared by filename alone is blind to
  // the file that is already on the list growing another hundred lines — the
  // exact way the iterate-side fork lost control of its own patch surface. So
  // every edited file is pinned by both hashes: what upstream has, and what we
  // put in its place.
  //
  // `forkCommitted`, never `fork`: the contract describes what a release ships. A tracked file
  // that is merely *modified* appears in both maps, so reading the disk copy here stamped
  // whatever the working tree happened to hold — measured 2026-10-13, +44 uncommitted lines sat
  // inside the fork's tool surface while this lane stayed green and `--record` would have
  // laundered them into the contract.
  editedDetail: edited
    .map((rel) => ({ file: rel, upstreamHash: ref.get(rel).hash, forkHash: forkCommitted.get(rel).hash }))
    .sort((a, b) => a.file.localeCompare(b.file)),
  // Our own files are pinned by content too, for the same reason. Before this, the 82 `added`
  // entries — which include the whole `gp_*` tool surface, i.e. most of what this fork exists to
  // carry — were declared by name only, so any edit to them was invisible to this ruler.
  addedDetail: added
    .map((rel) => ({ file: rel, forkHash: forkCommitted.get(rel).hash }))
    .sort((a, b) => a.file.localeCompare(b.file)),
}

const total = ref.size + added.length
console.log(`fork-diff vs ${pin.tag}: ${identical.length}/${total} byte-identical, ${edited.length} edited, ${added.length} added, ${deleted.length} deleted`)

if (dirty.length && mode === "record") {
  for (const rel of dirty.slice(0, 20)) console.error(`  ✗ tracked but modified in the working tree, not yet in any commit: ${rel}`)
  if (dirty.length > 20) console.error(`      … ${dirty.length - 20} more`)
  console.error("fork-diff: refusing to record. The golden pins the committed tree, so a recording run")
  console.error("  that reads uncommitted bytes would write a contract no commit satisfies. Commit the")
  console.error("  source change first, then re-record and fold the golden into that same commit:")
  console.error("    git add <the files you changed> && git commit -F <msg>")
  console.error("    node harness/tools/fork-diff.mjs --record")
  console.error("    git add harness/contracts/fork-diff.json && git commit --amend --no-edit")
  process.exit(1)
}
if (dirty.length) {
  // In --check this is a fact about the working tree, not about the contract: the verdict below
  // reads commits, so these lines are reported and do not turn the lane red.
  console.log(`  note: ${dirty.length} tracked file(s) carry uncommitted edits in this worktree (not measured against the golden)`)
}

if (uncommitted.length || missingFromWorktree.length) {
  for (const rel of uncommitted) console.error(`  ✗ on disk but not committed: ${rel}`)
  for (const rel of missingFromWorktree) console.error(`  ✗ committed but absent from the worktree: ${rel}`)
  console.error("fork-diff: the working tree and the committed fork tree disagree.")
  console.error("  A release ships the committed tree, so a file that only exists on disk is")
  console.error("  invisible to users (this is how seven upstream files were dropped from the")
  console.error("  import while looking byte-identical). Commit them (git add -f if ignored)")
  console.error("  or delete them, then run again.")
  if (mode === "record") {
    console.error("  Refusing to record over a tree that is not what a release would ship.")
    process.exit(1)
  }
  process.exit(1)
}

if (mode === "record") {
  mkdirSync(path.dirname(goldenFile), { recursive: true })
  writeFileSync(goldenFile, JSON.stringify(observed, null, 2) + "\n")
  console.log(`recorded -> ${path.relative(repoRoot, goldenFile)}`)
  process.exit(0)
}

if (!existsSync(goldenFile)) die(2, `no golden at ${path.relative(repoRoot, goldenFile)} — run --record`)
const golden = JSON.parse(readFileSync(goldenFile, "utf8"))
if (golden.baseTag !== observed.baseTag) die(1, `golden recorded at ${golden.baseTag}, pin says ${observed.baseTag}`)

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
let drift = 0
for (const key of ["edited", "added", "deleted"]) {
  const now = observed[key]
  const was = golden[key]
  const newOnes = now.filter((f) => !was.includes(f))
  const gone = was.filter((f) => !now.includes(f))
  if (newOnes.length || gone.length) {
    console.error(`  ✗ ${key} list changed (${was.length} recorded → ${now.length} actual)`)
    newOnes.slice(0, 10).forEach((f) => console.error(`      + ${f}`))
    gone.slice(0, 10).forEach((f) => console.error(`      - ${f}`))
    if (newOnes.length + gone.length > 20) console.error(`      … ${(newOnes.length + gone.length) - 20} more`)
    drift++
  }
}
if (!same(observed.edited, golden.edited) || !same(observed.added, golden.added) || !same(observed.deleted, golden.deleted)) drift ||= 1

// Content drift inside the declared surface: the file name was already on the
// list, so the bucket comparison above cannot see it. Compare the pinned hashes.
const wasDetail = new Map((golden.editedDetail ?? []).map((d) => [d.file, d]))
for (const d of observed.editedDetail) {
  const was = wasDetail.get(d.file)
  if (!was) {
    console.error(`  ✗ '${d.file}' is edited but has no recorded content hash (golden predates hash recording) — re-run --record`)
    drift++
    continue
  }
  if (was.upstreamHash !== d.upstreamHash) {
    console.error(`  ✗ '${d.file}': the REFERENCE moved (${was.upstreamHash.slice(0, 8)} → ${d.upstreamHash.slice(0, 8)}) — the clone at ${refRel} is no longer ${pin.tag} for this path`)
    drift++
  }
  if (was.forkHash !== d.forkHash) {
    console.error(`  ✗ '${d.file}': our content moved (${was.forkHash.slice(0, 8)} → ${d.forkHash.slice(0, 8)}) — the file is already in the declared divergence, so the name-list check alone would have called this clean`)
    drift++
  }
}
for (const file of wasDetail.keys()) {
  if (!observed.edited.includes(file)) {
    console.error(`  ✗ '${file}' was declared edited but no longer differs from upstream — re-record`)
    drift++
  }
}

// The golden must describe the whole declared surface, not a subset of it. Compared against the
// *name lists* (also in the golden, but stripped only together with them), so a golden edited
// down to `editedDetail: []` with `counts.edited` left intact cannot walk this lane away claiming
// it hash-checked nothing.
if (observed.editedDetail.length !== observed.edited.length) {
  console.error(`  ✗ ${observed.edited.length} file(s) are declared edited but only ${observed.editedDetail.length} carry content hashes — re-run --record`)
  drift++
}
if (observed.addedDetail.length !== observed.added.length) {
  console.error(`  ✗ ${observed.added.length} file(s) are declared added but only ${observed.addedDetail.length} carry content hashes — re-run --record`)
  drift++
}
const wasAddedDetail = new Map((golden.addedDetail ?? []).map((d) => [d.file, d]))
for (const d of observed.addedDetail) {
  const was = wasAddedDetail.get(d.file)
  if (!was) {
    console.error(`  ✗ '${d.file}' is one of our files but has no recorded content hash (golden predates added-file hashing) — re-run --record`)
    drift++
    continue
  }
  if (was.forkHash !== d.forkHash) {
    console.error(`  ✗ '${d.file}': our own file moved (${was.forkHash.slice(0, 8)} → ${d.forkHash.slice(0, 8)}) — it is not upstream's bytes in either direction, so this is our surface changing; re-record so the change is reviewed`)
    drift++
  }
}

if (drift > 0) {
  console.error(`fork-diff: the fork's actual divergence no longer matches ${path.relative(repoRoot, goldenFile)}.`)
  console.error("  Either the change was intended (re-record and commit the new golden in the same commit,")
  console.error("  so the diff surface is reviewed) or it was not (find out what touched the vendored tree).")
  process.exit(1)
}
console.log("fork-diff: divergence matches the recorded surface")
