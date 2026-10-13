#!/usr/bin/env node
/**
 * The repo mirror's contract corpus must be the corpus the pin describes.
 *
 * WHY THIS EXISTS (measured, not theoretical). `engine/Tests/GlassPaneEngineTests/TestSupport.swift`
 * loads the C35 shared-truth fixtures straight out of `kernel/fixtures/`, and
 * `engine/Sources/glasspane-settings/RecipesTabView.swift` reads a schema out of
 * `kernel/schemas/` at runtime. Meanwhile `harness/glasspane-harness/script/kernel-pin.mjs`
 * records the sha256 of the corpus that the *published* `iterate-kernel` ships. Those two facts
 * had never been joined: the mirror drifted to a two-week-old set of files, and the first thing
 * it did was make a new Swift round-trip test fail with "file does not exist" — so the engine
 * leg of the dual-binding contract was silently blind to every contract published after the
 * mirror's last sync, while the fork's own CI stayed green (it reads the installed package).
 *
 * This gate closes that hole: the bytes in the tree must equal the bytes the pin says the
 * installed package has. It is checked in both directions, so a corpus file added to the mirror
 * without being pinned is as red as a pinned file missing from it.
 *
 *   node scripts/check-kernel-corpus.mjs            # check (exit 1 = drift, 2 = cannot measure)
 *   node scripts/check-kernel-corpus.mjs --record   # rewrite the mirror from the pinned package
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pinPath = join(root, 'harness/glasspane-harness/contracts/kernel-pin.json')
const mirror = join(root, 'kernel')
const SUBDIRS = ['fixtures', 'schemas']

function die(code, message, remedy) {
  console.error(`kernel-corpus: ${message}`)
  console.error(`  Remedy: ${remedy}`)
  process.exit(code)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Where the published package sits, using the same two candidates `kernel-pin.mjs` probes. */
function installedKernel() {
  const productRoot = join(root, 'harness/glasspane-harness')
  for (const dir of [join(productRoot, 'node_modules/iterate-kernel'), join(productRoot, 'packages/opencode/node_modules/iterate-kernel')]) {
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  return null
}

const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
if (!Array.isArray(pin.corpus) || pin.corpus.length === 0) {
  die(2, `${relative(root, pinPath)} carries no corpus list`, 'run harness/glasspane-harness/script/kernel-pin.mjs --record first')
}

const record = process.argv.includes('--record')
const installed = installedKernel()
if (record && installed === null) {
  die(2, 'cannot record: the pinned package is not installed', 'bun install in harness/glasspane-harness, or run without --record to only check')
}
if (record) {
  // Recording means copying the *installed, pinned* bytes in — never re-stamping the pin from
  // whatever the mirror happens to hold, which would launder drift into "expected".
  for (const entry of pin.corpus) {
    const src = join(installed, entry.file)
    if (!existsSync(src)) die(2, `the installed package lacks ${entry.file}`, 're-run kernel-pin.mjs --record against a real install')
    if (sha256(src) !== entry.sha256) {
      die(1, `${entry.file}: installed bytes (${sha256(src).slice(0, 12)}…) do not match the pin (${entry.sha256.slice(0, 12)}…)`,
        'the package on disk is not the artifact the pin recorded — check the lock integrity before syncing anything')
    }
    const dst = join(mirror, entry.file)
    mkdirSync(dirname(dst), { recursive: true })
    const bytes = readFileSync(src)
    writeFileSync(dst, bytes)
  }
  console.log(`kernel-corpus: refreshed ${pin.corpus.length} file(s) into kernel/ from iterate-kernel@${pin.version}.`)
  process.exit(0)
}

// ---- check mode -----------------------------------------------------------
const expected = new Map(pin.corpus.map((e) => [e.file, e.sha256]))
const present = new Set()
const drift = []
const missing = []
for (const sub of SUBDIRS) {
  const dir = join(mirror, sub)
  if (!existsSync(dir)) {
    die(2, `kernel/${sub} does not exist`, 'the Swift C35 leg reads its corpus from here; restore it (node scripts/check-kernel-corpus.mjs --record)')
  }
  for (const name of readdirSync(dir)) {
    const rel = `${sub}/${name}`
    if (!expected.has(rel)) {
      drift.push(`${rel}: present in the mirror, not pinned — an unpinned corpus file is a contract nothing verifies`)
      continue
    }
    present.add(rel)
    const actual = sha256(join(dir, name))
    if (actual !== expected.get(rel)) {
      drift.push(`${rel}: mirror ${actual.slice(0, 12)}… != pinned ${expected.get(rel).slice(0, 12)}…`)
    }
  }
}
for (const file of expected.keys()) {
  if (!present.has(file)) missing.push(`${file}: pinned but absent from the mirror`)
}

if (drift.length + missing.length > 0) {
  console.error(`kernel-corpus: ${drift.length + missing.length} problem(s) against the pin (iterate-kernel@${pin.version}).`)
  for (const line of [...drift, ...missing]) console.error(`  ✗ ${line}`)
  console.error('\n  The Swift C35 leg reads kernel/fixtures and kernel/schemas straight off this tree:')
  console.error('  a corpus that lags the pin means the engine silently tests against old contracts.')
  console.error('  Sync it with: node scripts/check-kernel-corpus.mjs --record')
  process.exit(1)
}
console.log(`kernel-corpus: ${expected.size} corpus file(s) match the pin (iterate-kernel@${pin.version}).`)
