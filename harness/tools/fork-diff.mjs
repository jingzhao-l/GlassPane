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
 * hide. Four buckets: identical / edited / added / deleted.
 *
 * MODES
 *   --record  write harness/contracts/fork-diff.json (the declared divergence)
 *   --check   fail if the tree's actual divergence differs from that record
 *
 * Exit codes: 0 ok (including a loud offline skip), 1 divergence differs from
 * the record, 2 the tool could not measure (missing pin, missing reference).
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
const refDir = path.join(repoRoot, refRel)
if (!existsSync(forkDir)) die(2, `fork tree not found at ${forkRel}`)

/** Walk a tree, returning relative paths; symlinks are entries, never followed. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules" || entry === "dist") continue
    const full = path.join(dir, entry)
    const rel = path.relative(base, full).split(path.sep).join("/")
    const st = lstatSync(full)
    if (st.isDirectory()) walk(full, base, out)
    else if (st.isFile() || st.isSymbolicLink()) out.push(rel)
  }
  return out
}

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

const fork = observeFork()
const ref = observeReference()

if (!ref) {
  if (mode === "record") die(2, `--record needs the reference clone at ${refRel} (git clone --branch ${pin.tag})`)
  if (!existsSync(goldenFile)) die(2, `no golden at ${path.relative(repoRoot, goldenFile)} and no reference clone`)
  const golden = JSON.parse(readFileSync(goldenFile, "utf8"))
  console.log(`fork-diff: reference clone absent (${refRel}) — upstream NOT re-measured in this run.`)
  console.log(`  recorded divergence against ${golden.baseTag}: ${golden.counts.edited} edited, ${golden.counts.added} added, ${golden.counts.deleted} deleted, ${golden.counts.identical} identical`)
  console.log("  OK (offline). Re-record with the clone present; CI lanes must not pretend to measure.")
  process.exit(0)
}

const identical = []
const edited = []
const added = []
const deleted = []
for (const [rel, f] of fork) {
  const r = ref.get(rel)
  if (!r) added.push(rel)
  else if (r.hash !== f.hash || r.mode !== f.mode) edited.push(rel)
  else identical.push(rel)
}
for (const rel of ref.keys()) if (!fork.has(rel)) deleted.push(rel)

const observed = {
  baseTag: pin.tag,
  forkPath: forkRel,
  referenceClone: refRel,
  observedAt: new Date().toISOString().slice(0, 10),
  counts: { identical: identical.length, edited: edited.length, added: added.length, deleted: deleted.length },
  edited: edited.sort(),
  added: added.sort(),
  deleted: deleted.sort(),
}

const total = ref.size + added.length
console.log(`fork-diff vs ${pin.tag}: ${identical.length}/${total} byte-identical, ${edited.length} edited, ${added.length} added, ${deleted.length} deleted`)

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

if (drift > 0) {
  console.error(`fork-diff: the fork's actual divergence no longer matches ${path.relative(repoRoot, goldenFile)}.`)
  console.error("  Either the change was intended (re-record and commit the new golden in the same commit,")
  console.error("  so the diff surface is reviewed) or it was not (find out what touched the vendored tree).")
  process.exit(1)
}
console.log("fork-diff: divergence matches the recorded surface")
