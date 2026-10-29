#!/usr/bin/env node
/**
 * The repo mirror's contract corpus must be the corpus the pin describes.
 *
 * WHY THIS EXISTS (measured, not theoretical). `engine/Tests/GlassPaneEngineTests/TestSupport.swift`
 * loads the C35 shared-truth fixtures straight out of `kernel/fixtures/`, and
 * `engine/Sources/glasspane-settings/RecipesTabView.swift` reads a schema out of `kernel/schemas/`
 * at runtime. Meanwhile `harness/glasspane-harness/script/kernel-pin.mjs` records the sha256 of
 * the corpus that the *published* `iterate-kernel` ships. Those two facts had never been joined:
 * the mirror drifted to a two-week-old set of files, and the first thing it did was make a new
 * Swift round-trip test fail with "file does not exist" — so the engine leg of the dual-binding
 * contract was silently blind to every contract published after the mirror's last sync, while the
 * fork's own CI stayed green (it reads the installed package).
 *
 * This gate closes that hole: the bytes in the tree must equal the bytes the pin records, checked
 * in both directions, so a corpus file added to the mirror without being pinned is as red as a
 * pinned file missing from it.
 *
 * What the installed-package leg measures (D2, 2026-10-24). It used to probe ONLY
 * `harness/glasspane-harness/node_modules`, a directory CI never has — while the one lane that runs
 * this gate (`install-gate`, .github/workflows/ci.yml) does `npm ci` at the repository root first, so
 * `node_modules/iterate-kernel` is measurably present there and was never looked at. The leg therefore
 * printed "未观测" and exited 0: a gate that never speaks is not a gate, and this file's own argument
 * above ("a corpus file added to the mirror without being pinned is as red as a pinned file missing
 * from it" — nothing that was not measured may be stamped onto the green baseline) applies here
 * exactly as much. So: the repository root's `node_modules/iterate-kernel` is now the FIRST candidate,
 * and having nothing to compare against is red — exit 2 when no candidate dir exists at all, exit 1
 * when installs exist but none carries the version the pin records. Once a version-matched package is
 * found, every corpus file is hashed against the pin *inside that package* too, so the pin's bytes are
 * measured against the artifact the registry served instead of merely being re-quoted at the mirror.
 * A machine that genuinely has no install may say so out loud with `GLASSPANE_KERNEL_CORPUS_ALLOW_SKIP=1`
 * (the shape `engine/.signal_smoke.py`'s `GLASSPANE_SMOKE_ALLOW_SKIP` already established); it excuses
 * "nothing to compare against", never a byte that disagrees and never an install that carries another
 * version than the pin, and must never be set in CI.
 *
 * The third leg (check mode, always) asks the question a mirror cannot answer by itself: does the
 * version `mcp-shell` bundles equal the version the fork pins? That is where the two consumers of
 * this contract are proved to consume the *same* one — see "the shell's leg" below the check.
 *
 *   node scripts/check-kernel-corpus.mjs            # check (exit 1 = disagreement, 2 = cannot measure)
 *   node scripts/check-kernel-corpus.mjs --record   # rewrite the mirror from the pinned package
 *   node scripts/check-kernel-corpus.mjs --help     # legs, exit codes, and the allow-skip switch
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pinPath = join(root, 'harness/glasspane-harness/contracts/kernel-pin.json')
const mirror = join(root, 'kernel')
const SUBDIRS = ['fixtures', 'schemas']
const PACKAGE_NAME = 'iterate-kernel'
/** Escape hatch for a machine that has no install at all — opt-in, loud, never set in CI. */
const ALLOW_SKIP_ENV = 'GLASSPANE_KERNEL_CORPUS_ALLOW_SKIP'

function die(code, message, remedy) {
  console.error(`kernel-corpus: ${message}`)
  console.error(`  Remedy: ${remedy}`)
  process.exit(code)
}

function usage() {
  console.log(`usage: node scripts/check-kernel-corpus.mjs [--record | --help]

legs, in check mode (exit 0 only when every one of them is measured AND agrees):
  mirror ↔ pin        every file under kernel/{${SUBDIRS.join(',')}} must hash to what
                      ${relative(root, pinPath)} records, in both directions (1 = disagreement).
  installed ↔ pin     the installed ${PACKAGE_NAME} must exist, carry the pinned version, and hash
                      to the pin file-by-file. 2 = nothing installed in any candidate dir,
                      1 = an install exists but disagrees with the pin.
  mcp-shell ↔ pin     the version the shell bundles must equal the pin (1 = two ecosystems, one name).

candidate install dirs, in order (the repository root first — CI's install-gate runs npm ci there):
  node_modules/${PACKAGE_NAME}
  harness/glasspane-harness/node_modules/${PACKAGE_NAME}
  harness/glasspane-harness/packages/opencode/node_modules/${PACKAGE_NAME}

  ${ALLOW_SKIP_ENV}=1   excuses the installed ↔ pin leg on a machine that has NO install to
                        compare against (prints a SKIP line and continues). It never excuses a
                        byte that disagrees, and neither does it excuse an install that carries a
                        different version than the pin — that is a measured disagreement, red with
                        the flag set or not. It must not be set in CI — that is where this
                        leg exists. Without it the leg is RED by default.`)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * What a mirror entry actually IS, as a short phrase, or `null` when it is a regular file.
 *
 * `lstat`, not `stat`: a symlink resolves to a regular file under `stat`, and the pin describes
 * corpus *bytes committed to this tree* — it says nothing about whatever a stray link points at, so
 * pruning one would follow a claim the pin never made. The answer is a noun for the message, not a
 * boolean, because a refusal that only says "not a file" sends the reader off to guess.
 */
function nonRegularKind(abs) {
  let stat
  try {
    stat = lstatSync(abs)
  } catch {
    return 'unreadable (lstat failed)'
  }
  if (stat.isFile()) return null
  if (stat.isDirectory()) return 'directory'
  if (stat.isSymbolicLink()) return 'symbolic link'
  if (stat.isFIFO()) return 'FIFO'
  if (stat.isSocket()) return 'socket'
  return 'special file (block/character device)'
}

/**
 * Every candidate dir that actually carries a manifest. The repository root's own
 * `node_modules/iterate-kernel` is FIRST: `install-gate` does `npm ci` at the root and mcp-shell
 * declares `iterate-kernel` at one exact version, so that path is the one a green CI run always has.
 * The two product-tree dirs (the ones `harness/glasspane-harness/script/kernel-pin.mjs` probes) exist
 * on a maintenance machine with a bun install, and are a fallback here, not the only probe.
 */
function installedKernelCandidates() {
  const productRoot = join(root, 'harness/glasspane-harness')
  return [
    join(root, 'node_modules', PACKAGE_NAME),
    join(productRoot, 'node_modules', PACKAGE_NAME),
    join(productRoot, 'packages/opencode/node_modules', PACKAGE_NAME),
  ].filter((dir) => existsSync(join(dir, 'package.json')))
}

/** The version the installed package states, or null when there is nothing to read. */
function installedVersion(dir) {
  if (!dir) return null
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? 'unreadable'
  } catch {
    return 'unreadable'
  }
}

// --help answers the question a reader of a red CI step asks: which leg, which exit code, and is
// there a switch. It is handled before any read so it works on a checkout that has no harness product
// next door — and it writes nothing.
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage()
  process.exit(0)
}

// A pin that is absent or unparseable has not been measured against. That is a different fact
// from "the mirror drifted", and the header documents 2 as "cannot measure"; until now the bare
// readFileSync threw ENOENT and the process exited 1, so a checkout without the harness product
// next door reported corpus drift and told the reader to sync bytes that were already correct.
if (!existsSync(pinPath)) {
  die(2, `${relative(root, pinPath)} does not exist`, 'the pin lives in the harness product; check out/fetch it, or run this gate where it exists — the mirror cannot be judged without it')
}
let pin
try {
  pin = JSON.parse(readFileSync(pinPath, 'utf8'))
} catch (error) {
  die(2, `${relative(root, pinPath)} is not readable JSON: ${error.message}`, 'repair or re-record the pin; an unparseable pin is not evidence of drift')
}
if (!Array.isArray(pin.corpus) || pin.corpus.length === 0) {
  die(2, `${relative(root, pinPath)} carries no corpus list`, 'run harness/glasspane-harness/script/kernel-pin.mjs --record first')
}

const record = process.argv.includes('--record')
const candidates = installedKernelCandidates()
// Recording and the check leg both want *the pinned artifact*, so prefer the candidate that states the
// pinned version rather than the first directory found — a stale install must not become the source.
const pinnedInstall = candidates.find((dir) => installedVersion(dir) === pin.version) ?? null
const recordSource = pinnedInstall ?? candidates[0] ?? null
if (record && recordSource === null) {
  die(2, `cannot record: no installed ${PACKAGE_NAME} in any candidate dir`,
    `npm ci at the repository root (node_modules/${PACKAGE_NAME}) or bun install in harness/glasspane-harness, `
      + 'or run without --record to only check')
}
if (record) {
  const installed = recordSource
  const pinned = new Set(pin.corpus.map((e) => e.file))
  // Pruning is PLANNED here, before the first byte is copied, and an entry the pin does not describe
  // is refused rather than removed. `rmSync(..., { force: true })` only swallows ENOENT: one stray
  // DIRECTORY under kernel/fixtures or kernel/schemas makes it throw ERR_FS_EISDIR, and until
  // 2026-10-28 that throw landed after the copy loop below had already written the corpus — so a
  // single unpinned directory produced a half-recorded mirror plus a stack trace instead of an
  // answer. Detect everything first, then write; a refusal writes nothing at all.
  // Deleting recursively is the worse "fix": the mirror is a claim about contract bytes, and this
  // command may only replace claims it can read. A tree the pin never described is not this
  // command's evidence to destroy.
  const notRegular = []
  const prune = []
  for (const sub of SUBDIRS) {
    const dir = join(mirror, sub)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const rel = `${sub}/${name}`
      if (pinned.has(rel)) continue
      const abs = join(dir, name)
      const kind = nonRegularKind(abs)
      if (kind !== null) {
        notRegular.push({ rel, kind })
        continue
      }
      prune.push(rel)
    }
  }
  if (notRegular.length > 0) {
    const named = notRegular.map((e) => `${e.rel} [${e.kind}]`).join(', ')
    die(1, `--record refused: ${notRegular.length} unpinned ${notRegular.length === 1 ? 'entry' : 'entries'} under ${relative(root, mirror)} ${notRegular.length === 1 ? 'is' : 'are'} not a regular file: ${named}`,
      `no corpus file was copied and nothing was pruned — move that ${notRegular[0].kind} out of the mirror yourself (`
        + `it is not a contract file the pin describes, so decide what it is before deleting it), then re-run `
        + 'node scripts/check-kernel-corpus.mjs --record. This gate prunes files only, on purpose: silently '
        + 'removing a directory tree the pin never named would launder an unknown tree into a green mirror.')
  }
  // Recording means copying the *installed, pinned* bytes in — never re-stamping the pin from
  // whatever the mirror happens to hold, which would launder drift into "expected".
  // Detect-then-write, the same discipline as the prune check above: a pinned destination that is
  // already a directory (or a symlink/FIFO) used to be met inside the copy loop, where
  // `writeFileSync` throws ERR_FS_EISDIR *after* earlier entries were written — a half-recorded
  // mirror plus a stack trace. Refuse with nothing written instead.
  const blockedDestinations = pin.corpus
    .map((entry) => ({ rel: entry.file, dst: join(mirror, entry.file) }))
    .filter((e) => nonRegularKind(e.dst) !== null)
    .map((e) => ({ ...e, kind: nonRegularKind(e.dst) }))
  if (blockedDestinations.length > 0) {
    const named = blockedDestinations.map((e) => `${e.rel} [${e.kind}]`).join(', ')
    die(1, `--record refused: ${blockedDestinations.length} pinned ${blockedDestinations.length === 1 ? 'corpus path lands on' : 'corpus paths land on'} something that is not a regular file: ${named}`,
      'no corpus file was copied — the pin describes bytes committed to this tree, so a directory or a link '
        + `sitting where ${blockedDestinations[0].rel} belongs has to be moved away first, then re-run `
        + 'node scripts/check-kernel-corpus.mjs --record. Deleting it from here is not the remedy: only the '
        + 'prune pass removes mirror entries, and it refuses non-regular ones on purpose.')
  }
  for (const entry of pin.corpus) {
    const src = join(installed, entry.file)
    if (!existsSync(src)) die(2, `the installed package lacks ${entry.file}`, 're-run kernel-pin.mjs --record against a real install')
    if (sha256(src) !== entry.sha256) {
      die(1, `${entry.file}: installed bytes (${sha256(src).slice(0, 12)}…) do not match the pin (${entry.sha256.slice(0, 12)}…)`,
        'the package on disk is not the artifact the pin recorded — check the lock integrity before syncing anything')
    }
    const dst = join(mirror, entry.file)
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, readFileSync(src))
  }
  // Pruning stays in record mode (not check mode): check calls an unpinned extra red, so recording
  // without removing them left the next check failing on files this command had just declined to
  // touch. The pin is the source of truth, so a corpus file outside it is not "also fine". Every
  // entry here already passed the non-regular check above, so this loop cannot meet a directory.
  for (const rel of prune) rmSync(join(mirror, rel), { force: true })
  console.log(`kernel-corpus: refreshed ${pin.corpus.length} file(s) into kernel/ from ${relative(root, installed)} (iterate-kernel@${pin.version})`
    + (prune.length ? `; pruned ${prune.length} unpinned file(s): ${prune.join(', ')}` : '; no unpinned extras to prune'))
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
  // readdirSync is flat by design: a nested directory shows up as one entry that is neither a
  // pinned file nor a readable corpus file, so it lands in `drift` as an unpinned extra instead
  // of being silently skipped the way a recursive walk would skip an empty directory.
  for (const name of readdirSync(dir)) {
    const rel = `${sub}/${name}`
    if (!expected.has(rel)) {
      drift.push(`${rel}: present in the mirror, not pinned — an unpinned corpus file is a contract nothing verifies`)
      continue
    }
    present.add(rel)
    // The same `nonRegularKind()` probe the --record branches use, on the check side too (the
    // 2026-10-28 fix put "detect-then-say-a-sentence" in the record path only). A pinned name that lands on a
  //   DIRECTORY — a leftover `kernel/fixtures/c35/`, a directory someone made to stage files — used to
  //   be met inside `sha256()`'s `readFileSync`, which throws ERR_FS_EISDIR with a stack and kills the
  //   gate mid-loop: the remaining corpus files, the installed-package leg and the shell leg never ran,
  //   and the reader got a trace instead of the one sentence this file's own rule demands ("一条拒该是
  //   一句话，不是一个栈"). Name the kind, keep counting.
    const kind = nonRegularKind(join(dir, name))
    if (kind !== null) {
      drift.push(`${rel}: the pin describes bytes here, but this path is a ${kind} — there is nothing to hash, and the Swift C35 leg reads it as a contract file. Move that ${kind} out of the mirror (deleting it from here is not this gate's call, same as --record), then re-run --record.`)
      continue
    }
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

// ---- the installed package's leg --------------------------------------------
// Reaching this line means the mirror agrees with the pin. That is still only half the contract: the
// pin is a *claim about the published artifact*, and the artifact is what a fresh install serves. The
// old probe looked only inside the harness product, so on the one lane that runs this gate in CI it
// found nothing, printed "未观测" and exited 0 — the file's header argument that a thing not looked at
// may not be stamped onto the green baseline applies here, so the leg is red by default now.
if (pinnedInstall === null) {
  const found = candidates.map((dir) => `${relative(root, dir)}@${installedVersion(dir)}`).join(', ')
  // The flag is gated on `candidates.length === 0` and on nothing else, because that is the only
  // claim it is allowed to make ("this machine has nothing comparable"). `pinnedInstall === null`
  // holds for BOTH "no install at all" and "installs exist, none carries the pinned version", and
  // testing the flag first let the second case out through the first door — an escape hatch that
  // excuses a stale install is a way to turn a measured disagreement green with an environment
  // variable. This file's own non-skip branch calls that case "a disagreement, not a skip", and the
  // header limits the flag to "本机没有可比的东西"; the code now says the same thing.
  if (candidates.length === 0 && process.env[ALLOW_SKIP_ENV] === '1') {
    console.log(`  installed-package leg: SKIP（${ALLOW_SKIP_ENV}=1 显式要求）：三个候选位里一份已安装的 ${PACKAGE_NAME} 都没有`
      + '（一份都没有）——这条腿默认是红的；开关只豁免"本机没有可比的东西"，'
      + '不豁免对不上的字节，也不豁免装了别的版本，CI 里设它等于把这条闸关掉。')
  } else if (candidates.length === 0) {
    die(2, `no installed ${PACKAGE_NAME} found in any candidate dir — the pin's bytes were never compared with the artifact the registry served`,
      `run npm ci at the repository root (its node_modules/${PACKAGE_NAME} is the first candidate and the shape CI's install-gate has); `
        + `a machine with no install at all may set ${ALLOW_SKIP_ENV}=1, and CI must not`)
  } else {
    die(1, `the installed ${PACKAGE_NAME} is not the version the pin records: found ${found}, pin is ${pin.version}`,
      `install ${pin.version} (npm ci at the repository root, or bump the shell's dependency and re-record the pin in the same batch); `
        + `a stale install is a disagreement, not a skip — ${ALLOW_SKIP_ENV}=1 exists only for a machine with no install at all`)
  }
} else {
  const installedProblems = []
  for (const entry of pin.corpus) {
    const src = join(pinnedInstall, entry.file)
    if (!existsSync(src)) {
      installedProblems.push(`${entry.file}: the pin and the mirror both carry it, the installed package does not`)
      continue
    }
    const actual = sha256(src)
    if (actual !== entry.sha256) {
      installedProblems.push(`${entry.file}: installed ${actual.slice(0, 12)}… != pinned ${entry.sha256.slice(0, 12)}…`)
    }
  }
  if (installedProblems.length > 0) {
    die(1, `${installedProblems.length} file(s) disagree with the pin inside ${relative(root, pinnedInstall)} (iterate-kernel@${pin.version}):\n`
      + installedProblems.map((line) => `  ✗ ${line}`).join('\n')
      + '\n  The mirror matching the pin is not a pass while the installed artifact disagrees — the pin would be recording bytes nobody can install.',
      'check the install (a swapped registry artifact, a hand-edited node_modules, a half run of npm ci); re-install from the lock before re-recording the pin')
  }
  console.log(`  installed-package leg: 逐文件核过 ${pin.corpus.length} 份，${relative(root, pinnedInstall)} 装的正是 ${pin.version} ——`
    + ' mirror ↔ pin ↔ 已安装包三份字节同源。')
}

// ---- the shell's leg ------------------------------------------------------
// `mcp-shell` bundles the kernel into its own artifact, so the version it declares is the
// version living inside the published `glasspane-mcp` tarball. Two consumers of one contract
// is the entire premise of a shared kernel: a bump that reaches the fork's pin and not the
// shell's manifest — or the other way round — is two ecosystems wearing one name, and nothing
// else in this repository would notice. `scripts/bundle-kernel-schemas.mjs` asks the same
// question at bundle time; this asks it on every CI run, including the ones that never bundle.
const shellPath = join(root, 'mcp-shell', 'package.json')
if (!existsSync(shellPath)) {
  die(2, 'mcp-shell/package.json does not exist', 'this leg reads the shell manifest to answer for the published artifact; run it from a GlassPane checkout')
}
let shell
try {
  shell = JSON.parse(readFileSync(shellPath, 'utf8'))
} catch (error) {
  die(2, `mcp-shell/package.json is not readable JSON: ${error.message}`, 'repair the manifest; a shell that cannot be read cannot be held to a version')
}
const shellSpec = shell?.dependencies?.['iterate-kernel'] ?? shell?.devDependencies?.['iterate-kernel']
if (typeof shellSpec !== 'string' || shellSpec === '') {
  die(1, 'mcp-shell/package.json declares no iterate-kernel', 'the shell bundles the kernel and imports it as `iterate-kernel/<module>`; declaring it in nothing means the artifact records no provenance for the contract inside it')
}
if (!/^\d+\.\d+\.\d+$/.test(shellSpec)) {
  die(1, `mcp-shell declares iterate-kernel as "${shellSpec}" — not one exact version`, 'the bundle inlines the package, so the version is a fact about the published bytes; a range makes those bytes depend on what the registry served that day')
}
if (shellSpec !== pin.version) {
  die(1, `the shell bundles iterate-kernel@${shellSpec} while the fork pins ${pin.version}`, 'one kernel per ecosystem: bump mcp-shell/package.json and re-record the pin in the same batch, then re-sync this mirror (--record)')
}
console.log(`  mcp-shell leg: glasspane-mcp 捆的是 iterate-kernel@${shellSpec}，与 pin 同号。`)
