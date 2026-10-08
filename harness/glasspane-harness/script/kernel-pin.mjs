#!/usr/bin/env node
/*
 * kernel-pin — the fork consumes the shared kernel as a published dependency; this
 * tool is what keeps "a dependency" from silently becoming "whatever we picked up
 * today".
 *
 * WHAT CHANGED. The kernel used to be vendored into `packages/opencode/vendor/kernel`
 * and pinned file-by-file by sha256 (`kernel-vendor.mjs`, retired with this rewrite).
 * It is now `iterate-kernel` from the registry, resolved through the fork's lockfile.
 * Immutability moved from "our vendor tree equals our manifest" to "the artifact npm
 * served for this version is the artifact we recorded" — which is a stronger statement
 * only if somebody checks it, so this tool checks three separate things:
 *
 *   1. the *installed* version is the pinned version, and it was resolved from the
 *      registry (a `file:` or `link:` resolution would mean the product is shipping a
 *      local directory it cannot install anywhere else);
 *   2. the lockfile's integrity hash for that resolution is the pinned hash, so a
 *      dependency-confusion or a swapped artifact turns red rather than running;
 *   3. the contract corpus that ships inside the package (`fixtures/`, `schemas/`)
 *      hashes to what the manifest says — because the cross-language contract IS those
 *      bytes, and a kernel that publishes a different corpus than it says it does has
 *      broken every consumer that cannot import TypeScript.
 *
 * MODES
 *   --record                       (run when deliberately bumping the kernel version)
 *   --check                        (local and CI)
 *   --probe                        (scheduled: has the registry published a newer one?)
 *
 * WHY A PROBE. The dependency line pins an exact version, so nothing moves on its own.
 * The thing that goes stale is the *ecology*: iterate ships a kernel that answers a
 * scenario better than ours does, and if nobody looks, the two harnesses quietly stop
 * sharing a contract. The probe asks the registry for the latest version, reports drift,
 * and changes nothing. It is a finding for a human, not a CI failure — our bytes are
 * exactly what the manifest declares, which is what --check enforces.
 *
 * Exit codes: 0 ok, 1 the installed kernel no longer matches its provenance, 2 cannot
 * measure (no lockfile, no installed package, no registry reach).
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE = "iterate-kernel"
const CORPUS_DIRS = ["fixtures", "schemas"]

// Root discovery, same rule kernel-vendor.mjs used: walk up to the tree that holds
// product.json, so one file serves both the product repo and the monorepo around it.
const here = path.dirname(fileURLToPath(import.meta.url))
const productRoot = (() => {
  let dir = here
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "product.json"))) return dir
    dir = path.dirname(dir)
  }
  die(2, `cannot find product.json above ${here} — run this from inside the product tree`)
})()

const manifestFile = path.join(productRoot, "contracts", "kernel-pin.json")
const lockFile = path.join(productRoot, "bun.lock")

function die(code, msg) {
  console.error(`kernel-pin: ${msg}`)
  process.exit(code)
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

/** Locate the installed package: bun hoists, so it may sit at either level. */
function installedDirs() {
  return [
    path.join(productRoot, "node_modules", PACKAGE),
    path.join(productRoot, "packages", "opencode", "node_modules", PACKAGE),
  ].filter((dir) => existsSync(path.join(dir, "package.json")))
}

function corpusFiles(dir, prefix = "", out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry)
    const stat = lstatSync(full)
    if (stat.isDirectory()) corpusFiles(full, `${prefix}${entry}/`, out)
    else if (stat.isFile()) out.push(`${prefix}${entry}`)
  }
  return out
}

/** Everything the manifest states about the kernel we are shipping right now. */
function collectInstalled() {
  const dirs = installedDirs()
  if (dirs.length === 0) {
    die(2, `${PACKAGE} is not installed — run \`bun install\` in ${productRoot} before measuring`)
  }
  const packageJson = JSON.parse(readFileSync(path.join(dirs[0], "package.json"), "utf8"))
  const version = packageJson.version
  const files = []
  for (const subdir of CORPUS_DIRS) {
    const dir = path.join(dirs[0], subdir)
    if (!existsSync(dir)) {
      die(1, `${PACKAGE}@${version} does not ship ${subdir}/ — the published artifact cannot anchor the contract`)
    }
    for (const rel of corpusFiles(dir)) {
      files.push({ file: `${subdir}/${rel}`, sha256: sha256(path.join(dir, rel)) })
    }
  }
  return { dir: dirs[0], version, files, name: packageJson.name }
}

/**
 * The lockfile entry: `["iterate-kernel@0.1.2", "", {...}, "sha512-…"]`.
 * A registry resolution has an empty specifier as its second element; `file:`/`link:`
 * resolutions carry the path there. That distinction is the whole point of this check.
 *
 * `bun.lock` is JSONC — comments and trailing commas — so it is not `JSON.parse`-able as
 * a whole. Each package entry sits on one line and that line's array is plain JSON, so
 * the entry is pulled out by key and parsed on its own. Anchoring on the exact key keeps
 * a nested `iterate-kernel/...` resolution from being mistaken for the top-level one.
 */
function lockEntry() {
  if (!existsSync(lockFile)) die(2, `no bun.lock at ${lockFile} — cannot verify how the kernel was resolved`)
  const lock = readFileSync(lockFile, "utf8")
  const match = lock.match(new RegExp(`^\\s*"${PACKAGE}":\\s*(\\[[^\\n]*\\]),?$`, "m"))
  if (!match) die(1, `${PACKAGE} is missing from bun.lock — the dependency line was never resolved`)
  let parsed
  try {
    parsed = JSON.parse(match[1])
  } catch {
    die(2, `could not read the ${PACKAGE} entry in bun.lock — the lockfile layout changed`)
  }
  const [key, specifier, _deps, integrity] = parsed
  return { key, specifier: specifier ?? "", integrity: integrity ?? "" }
}

const argv = process.argv.slice(2)
const mode = argv[0]
if (mode !== "--record" && mode !== "--check" && mode !== "--probe") {
  console.error("usage: kernel-pin.mjs --record | --check | --probe")
  process.exit(2)
}

const installed = ["--record", "--check"].includes(mode) ? collectInstalled() : null
const lock = ["--record", "--check"].includes(mode) ? lockEntry() : null

if (mode === "--record") {
  const manifest = {
    _comment:
      "Provenance of the iterate-kernel dependency this fork ships. Written by script/kernel-pin.mjs --record when the version is deliberately bumped; checked by --check in CI. The kernel's canonical home is iterate-skill/kernel, published as `iterate-kernel`; the vendored mirror under packages/opencode/vendor/kernel was retired with this file.",
    package: PACKAGE,
    version: installed.version,
    resolution: { from: "registry", lockKey: lock.key, specifier: lock.specifier, integrity: lock.integrity },
    canonical: {
      repo: "jingzhao-l/iterate-skill",
      path: "kernel",
      branch: "main",
      npmPublish: "npm publish from the kernel/ directory of that repo",
    },
    recordedAt: new Date().toISOString().slice(0, 10),
    corpus: installed.files,
  }
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(
    `kernel-pin: recorded ${PACKAGE}@${installed.version} (${installed.files.length} contract file(s)) into contracts/kernel-pin.json`,
  )
  process.exit(0)
}

const manifest = existsSync(manifestFile)
  ? JSON.parse(readFileSync(manifestFile, "utf8"))
  : die(1, `no contracts/kernel-pin.json — run kernel-pin.mjs --record after installing the kernel`)

if (mode === "--check") {
  const problems = []
  if (installed.name !== PACKAGE) problems.push(`installed package name is ${installed.name}, expected ${PACKAGE}`)
  if (installed.version !== manifest.version)
    problems.push(`installed ${installed.version} but the manifest pins ${manifest.version}`)
  if (lock.key !== manifest.resolution?.lockKey)
    problems.push(`bun.lock resolved ${lock.key}, manifest pins ${manifest.resolution?.lockKey}`)
  if (lock.specifier) {
    // An empty specifier is a plain registry resolution. Anything else — a path, `file:`,
    // `link:` — means the product ships a local directory no install can fetch.
    problems.push(`bun.lock resolves ${PACKAGE} from ${JSON.stringify(lock.specifier)}, not the registry`)
  }
  if (lock.integrity !== manifest.resolution?.integrity)
    problems.push(
      `bun.lock integrity ${lock.integrity.slice(0, 18)}… != manifest ${String(manifest.resolution?.integrity).slice(0, 18)}…`,
    )

  const pinned = new Map((manifest.corpus ?? []).map((e) => [e.file, e.sha256]))
  const seen = new Set()
  for (const entry of installed.files) {
    seen.add(entry.file)
    const expected = pinned.get(entry.file)
    if (expected === undefined) problems.push(`${entry.file} is in the installed package but not pinned`)
    else if (expected !== entry.sha256) problems.push(`${entry.file} sha256 ${entry.sha256} != pinned ${expected}`)
  }
  for (const file of pinned.keys()) if (!seen.has(file)) problems.push(`${file} is pinned but the package does not ship it`)

  if (problems.length > 0) {
    for (const problem of problems) console.error(`kernel-pin: ${problem}`)
    console.error(`\n  Remedy: if the kernel version was moved on purpose, re-record with \`bun install\` then`)
    console.error(`  \`node script/kernel-pin.mjs --record\` and commit the manifest with the code that needs it.`)
    process.exit(1)
  }
  console.log(
    `kernel-pin: ${PACKAGE}@${manifest.version} matches its lock integrity and ${pinned.size} pinned contract file(s).`,
  )
  process.exit(0)
}

// --probe: has the registry published a newer kernel than the one we pinned?
let latest
try {
  latest = execFileSync("npm", ["view", PACKAGE, "version"], { encoding: "utf8" }).trim()
} catch {
  console.log(`kernel-pin: could not reach the registry for ${PACKAGE} — probe skipped, not a failure`)
  process.exit(0)
}
if (!latest) {
  console.log(`kernel-pin: registry answered nothing for ${PACKAGE} — probe skipped, not a failure`)
  process.exit(0)
}
if (latest === manifest.version) {
  console.log(`kernel-pin: ${PACKAGE}@${manifest.version} is the published latest.`)
} else {
  console.log(`kernel-pin: DRIFTED — ${PACKAGE} publishes ${latest}, we pin ${manifest.version}`)
  console.log(
    "  Our installed bytes are still exactly what the manifest declares (--check proves that), but the\n" +
      "  shared kernel has moved. To take the move: bump the dependency line, `bun install`, then\n" +
      "  `node script/kernel-pin.mjs --record` and run script/kernel-conformance.mjs.",
  )
}
process.exit(0)
