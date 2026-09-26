#!/usr/bin/env node
/**
 * kernel-vendor.mjs — the provenance and integrity check for the kernel source
 * vendored into the opencode fork (`harness/glasspane-harness/packages/kernel`).
 *
 * WHY. The recorded decision is that @iterate/kernel is not published separately
 * (P6 §13 — a `file:` dep leaks out of a published manifest, so mcp-shell inlines
 * it; P4 §33.2 — registry publishing follows the iterate monorepo's policy). The
 * fork still must not grow its own copy of the semantic contract, and a
 * subtree-split fork cannot reach `../../kernel`. So the fork carries vendored
 * source, and *this* tool is what keeps "vendored" from silently becoming "ours":
 * every file is pinned by sha256, and any edit inside the vendor directory turns
 * red — in CI, from the manifest alone, no canonical checkout required.
 *
 * The accounting consequence is enforced elsewhere: `tool-surface.mjs` reads this
 * manifest and counts these files as a dependency, not as our tool surface.
 *
 * MODES
 *   --record <canonical-checkout> <canonical-version>   (run by tools/sync-kernel.sh --target=fork)
 *   --check                                             (run locally and in CI)
 *   --probe                                             (scheduled: has the canonical kernel moved?)
 *
 * WHY A PROBE. "One kernel, N consumers" is only a fact while somebody checks. We
 * pin a ref; if the iterate side moves the branch, the only symptom would be a
 * scenario that quietly stops agreeing. The probe compares our pinned ref against
 * the canonical branch head and reports drift — the same shape as fork-diff's
 * upstream probe, and it needs no registry publication to be useful. It observes;
 * it does not fetch, sync or rewrite anything.
 *
 * Exit codes: 0 ok, 1 the vendor no longer matches its provenance, 2 cannot measure.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, lstatSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const manifestFile = path.join(repoRoot, "harness", "contracts", "kernel-vendor.json")
const vendorRel = "packages/opencode/vendor/kernel" // inside the fork tree
const SUBDIRS = ["src", "schemas", "fixtures"]

const argv = process.argv.slice(2)
const mode = argv[0]
if (mode !== "--record" && mode !== "--check" && mode !== "--probe") {
  console.error("usage: kernel-vendor.mjs --record <canonical-checkout> <canonical-version> | --check | --probe")
  process.exit(2)
}

function die(code, msg) {
  console.error(`kernel-vendor: ${msg}`)
  process.exit(code)
}

function walk(dir, base = dir, out = []) {
  for (const entry of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (entry === ".git" || entry === "node_modules" || entry === "dist") continue
    const full = path.join(dir, entry)
    const st = lstatSync(full)
    if (st.isDirectory()) walk(full, base, out)
    else if (st.isFile()) out.push(full)
  }
  return out
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")

function vendorDir() {
  const pin = JSON.parse(readFileSync(path.join(repoRoot, "harness", "upstream.json"), "utf8"))
  const forkRel = pin?.fork?.path
  if (!forkRel) die(2, 'upstream.json missing fork.path — cannot locate the vendor')
  return { forkRel, dir: path.join(repoRoot, forkRel, vendorRel) }
}

/** Files of the vendored subset, as `packages/kernel/<rel>` paths inside the fork. */
function vendoredFiles(dir) {
  const out = []
  for (const sub of SUBDIRS) {
    const full = path.join(dir, sub)
    if (!existsSync(full)) continue
    for (const file of walk(full)) out.push(path.relative(dir, file).split(path.sep).join("/"))
  }
  return out.sort()
}

/**
 * Has the canonical kernel moved past the ref we pinned?
 *
 * Read-only: one `git ls-remote` against the canonical repo. It reports, it does
 * not fetch, sync or rewrite. Exit 0 with a "DRIFTED" line is a finding for a human
 * (or a scheduled job) to act on, not a CI failure — the vendored bytes are still
 * exactly what the manifest says they are, which is what --check enforces.
 */
/**
 * The declared mode must be the real one. `product.json → kernel.mode` says how this
 * product gets the kernel; if the tree disagrees with the declaration, the declaration
 * is the thing that is wrong — and a mode that is only prose drifts the moment
 * somebody publishes or re-vendors.
 */
function checkDeclaredMode() {
  const productFile = path.join(repoRoot, "harness", "glasspane-harness", "product.json")
  if (!existsSync(productFile)) return 0
  const product = JSON.parse(readFileSync(productFile, "utf8"))
  const declared = product?.kernel?.mode
  if (!declared) {
    console.error("  ✗ product.json has no kernel.mode — the distribution form of the shared kernel must be declared")
    return 1
  }
  const { dir } = vendorDir()
  const vendored = existsSync(dir)
  if (declared === "vendored" && !vendored) {
    console.error(`  ✗ product.json declares kernel.mode=vendored but ${path.relative(repoRoot, dir)} is absent`)
    return 1
  }
  if (declared === "npm" && vendored) {
    console.error("  ✗ product.json declares kernel.mode=npm while vendored source is still in the tree — one form at a time")
    return 1
  }
  console.log(`kernel-vendor: declared mode '${declared}' matches the tree${declared === "vendored" ? ` (${path.relative(repoRoot, dir)})` : ""}`)
  return 0
}

if (mode === "--probe") {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
  const canonical = manifest.canonical ?? {}
  if (!canonical.repo) die(2, "manifest has no canonical.repo — nothing to probe")
  let head
  try {
    head = execFileSync("git", ["ls-remote", `https://github.com/${canonical.repo}.git`, `refs/heads/${canonical.branch}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    console.log(`kernel-vendor: could not reach ${canonical.repo} (offline?) — probe skipped, not a failure`)
    process.exit(0)
  }
  const remote = head.split(/\s+/)[0]
  const pinned = canonical.ref ?? ""

  // Is the commit we pinned still *there*? This is a different failure from "the
  // branch moved", and a worse one: with a moved branch we can re-sync; with an
  // unreachable anchor the manifest can no longer prove that our bytes are anybody
  // else's bytes, and --check can only prove they have not changed *since*.
  let anchorAlive = true
  try {
    execFileSync("git", ["ls-remote", `https://github.com/${canonical.repo}.git`, pinned], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || (anchorAlive = false)
  } catch {
    anchorAlive = false
  }
  if (!remote) {
    console.log(`kernel-vendor: branch ${canonical.branch} not found in ${canonical.repo} — no drift signal; checking the anchor only`)
  }
  if (!anchorAlive) {
    console.log(`kernel-vendor: ANCHOR UNREACHABLE — ${canonical.repo} cannot resolve our pinned ref ${pinned.slice(0, 12)}`)
    console.log("  The vendored bytes still match the manifest (--check proves they never changed), but the")
    console.log("  provenance chain to canonical is broken: we can no longer prove these ARE its bytes, only")
    console.log("  that they have not changed since we recorded them. This is a finding, not a pass.")
    console.log("  Fix: re-anchor the manifest to a reachable ref after backflow (tools/sync-kernel.sh --target=fork).")
    process.exit(1)
  }

  if (!remote) process.exit(0) // anchor is alive (we got here), nothing else to say
  if (remote === pinned) {
    console.log(`kernel-vendor: canonical ${canonical.branch} @ ${pinned.slice(0, 12)} — no drift (${canonical.version})`)
    process.exit(0)
  }
  // Is our pin an ancestor of the branch head? That needs the objects, so this is
  // reported as "unknown" rather than guessed — a guess here would be the exact
  // kind of unmeasured claim this project refuses to make.
  console.log(`kernel-vendor: DRIFTED — canonical ${canonical.branch} head is ${remote.slice(0, 12)}, we pin ${pinned.slice(0, 12)} (${canonical.version})`)
  console.log("  Our vendored bytes are still exactly what the manifest declares (--check proves that),")
  console.log("  but the shared kernel has moved. To take it: KERNEL_SRC=/path/to/iterate-skill tools/sync-kernel.sh --target=fork")
  process.exit(0)
}

if (mode === "--record") {
  const [checkout, canonicalVersion] = [argv[1], argv[2]]
  if (!checkout || !canonicalVersion) die(2, "--record needs <canonical-checkout> <canonical-version>")
  const srcKernel = path.join(checkout, "kernel")
  if (!existsSync(path.join(srcKernel, "package.json"))) die(2, `${srcKernel} is not a kernel checkout`)
  const dirty = execFileSync("git", ["-C", checkout, "status", "--porcelain", "--", "kernel"], { encoding: "utf8" }).trim()
  if (dirty) die(1, `canonical ${srcKernel} has uncommitted changes — record provenance from a committed state`)
  const ref = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const branch = execFileSync("git", ["-C", checkout, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()

  const { dir } = vendorDir()
  const files = vendoredFiles(dir)
  if (!files.length) die(2, `nothing vendored at ${path.relative(repoRoot, dir)} — run tools/sync-kernel.sh --target=fork first`)

  // Every recorded hash is taken from the *canonical* bytes, and the vendor copy
  // must equal them right now — otherwise the manifest would bless a divergence
  // the moment it is written.
  const entries = files.map((rel) => {
    const canonicalFile = path.join(srcKernel, rel)
    if (!existsSync(canonicalFile)) die(1, `the vendor has '${rel}' but canonical does not — refusing to record provenance for it`)
    const canonicalBytes = readFileSync(canonicalFile)
    const vendorBytes = readFileSync(path.join(dir, rel))
    if (!canonicalBytes.equals(vendorBytes)) {
      die(1, `the vendor's '${rel}' is not byte-identical to canonical ${ref} — fix the copy or the edit, do not record it`)
    }
    return { file: rel, sha256: sha256(canonicalBytes), bytes: canonicalBytes.length }
  })

  const manifest = {
    _comment:
      "Provenance of the @iterate/kernel source vendored into the opencode fork. Written by tools/sync-kernel.sh --target=fork; check with harness/tools/kernel-vendor.mjs --check. Do not hand-edit, and do not edit files under packages/kernel inside the fork — the canonical home is iterate-skill/kernel.",
    canonical: {
      repo: "jingzhao-l/iterate-skill",
      path: "kernel",
      branch,
      ref,
      version: canonicalVersion,
    },
    vendoredAt: new Date().toISOString().slice(0, 10),
    forkPath: path.join(vendorDir().forkRel, vendorRel),
    subdirs: SUBDIRS,
    files: entries,
    totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
  }
  mkdirSync(path.dirname(manifestFile), { recursive: true })
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n")
  console.log(`kernel-vendor: recorded ${entries.length} files (${manifest.totalBytes} bytes) @ ${ref.slice(0, 7)} (${branch})`)
  process.exit(0)
}

// --check
if (!existsSync(manifestFile)) die(2, `no manifest at ${path.relative(repoRoot, manifestFile)} — run tools/sync-kernel.sh --target=fork`)
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"))
const { dir } = vendorDir()
if (!existsSync(dir)) die(2, `vendor directory ${path.relative(repoRoot, dir)} is missing`)

const recorded = new Map(manifest.files.map((f) => [f.file, f]))
const actual = vendoredFiles(dir)
let bad = 0

for (const rel of actual) {
  const want = recorded.get(rel)
  if (!want) {
    console.error(`  ✗ '${rel}' exists in the vendor but not in the manifest — the fork grew its own kernel file`)
    bad++
    continue
  }
  const got = sha256(readFileSync(path.join(dir, rel)))
  if (got !== want.sha256) {
    console.error(`  ✗ '${rel}' no longer matches its provenance (${want.sha256.slice(0, 12)} → ${got.slice(0, 12)})`)
    bad++
  }
}
for (const rel of recorded.keys()) {
  if (!actual.includes(rel)) {
    console.error(`  ✗ '${rel}' is declared vendored but is absent from the tree`)
    bad++
  }
}

// Optional stronger form: when a canonical checkout is available, re-verify the
// bytes against it and that the recorded ref is still the checkout's kernel.
const checkout = process.env.KERNEL_SRC
if (checkout) {
  const srcKernel = path.join(checkout, "kernel")
  if (!existsSync(path.join(srcKernel, "package.json"))) {
    console.error(`  ✗ KERNEL_SRC=${checkout} has no kernel/ — cannot honour the stronger check`)
    bad++
  } else {
    let drifted = 0
    for (const [rel, want] of recorded) {
      const canonicalFile = path.join(srcKernel, rel)
      if (!existsSync(canonicalFile)) {
        console.error(`  ✗ canonical no longer has '${rel}' — the vendor is ahead of canonical (backflow or drop it)`)
        drifted++
        continue
      }
      if (sha256(readFileSync(canonicalFile)) !== want.sha256) {
        console.error(`  ✗ canonical's '${rel}' differs from the manifest: the vendor is STALE, re-run --target=fork`)
        drifted++
      }
    }
    bad += drifted
    console.log(`kernel-vendor: ${recorded.size} files cross-checked against ${checkout} (canonical @ ${manifest.canonical.ref.slice(0, 7)})`)
  }
} else {
  console.log(`kernel-vendor: ${recorded.size} files checked against the manifest; canonical bytes NOT re-read (KERNEL_SRC unset) — a vendor that is stale-but-untouched is caught by the fork sync, not here`)
}

bad += checkDeclaredMode()

if (bad > 0) {
  console.error(`kernel-vendor: ${bad} problem(s). The vendored kernel is the canonical package's bytes or it is nothing.`)
  console.error("  Remedy: edit canonical (iterate-skill/kernel), run its gate there, then")
  console.error("    KERNEL_SRC=/path/to/iterate-skill tools/sync-kernel.sh --target=fork")
  console.error("  Never edit files under packages/kernel inside the fork.")
  process.exit(1)
}
console.log(`kernel-vendor: the vendor matches its provenance (${manifest.canonical.repo}@${manifest.canonical.ref.slice(0, 7)}, ${manifest.files.length} files, ${manifest.totalBytes} bytes)`)
