/**
 * Spec §3: what a swap actually does, in the order that keeps a failure
 * survivable.
 *
 *     backup → prove the backup → build from the staged tree → swap the two
 *     bundles → kickstart → read the version back (socket `hello` + MCP
 *     `tools/list`) → npm global packages → only then publish `current`.
 *
 * Two rules hold the whole thing together:
 *
 * 1. Nothing in `~/Applications` is replaced before a backup has been *read
 *    back* and compared file-by-file against the source (`manifestTree`). "The
 *    copy command exited 0" is not proof on a volume that lies about writes, and
 *    neither is "the directory exists": a backup is proven by a sha256 per
 *    relative path, recorded in `backup-manifest.json`, and the restore is
 *    proven by walking the *landed* bundle against that same list.
 * 2. Every path the swap touches is dependency-injected (`appsDir`,
 *    `backupRoot`, `stagedTree`), so tests run against a temp directory and the
 *    suite can never write into a developer's real home. The default `appsDir`
 *    is computed by the CLI, not by this module.
 *
 * A failed handshake restores the backup and restarts again (`rolled-back`,
 * exit 4). A restore that cannot be verified is the one outcome that must reach
 * a human: `rollback-failed`, exit 5. Verification is therefore never "best
 * effort" — a backup that carries no manifest, or a bundle the manifest does not
 * name, is a failed restore, not a warning.
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { CODES } from './codes.js'
import { sha256FileSync } from './digest.js'
import { UpdaterError, canonicalPath, ensurePrivateDir, removeTreeWithin, resolveWithin, tightenMode, writableRoots, writePrivateFile } from './fsutil.js'
import { probeIdle } from './idle.js'
import { kickstartJob, readRunningJob } from './launchd.js'
import { mcpToolsList } from './mcp.js'
import { refreshRuntime, undoHandover } from './runtime.js'
import { bumpKind, parsePlainVersion } from './version.js'
import { decideSwapPermission, foreignStateDir } from './policy.js'
import { authorshipNote } from './signature.js'
import { loadState, nextState, readPointer, saveState } from './state.js'
import { stagedTreePresent } from './staging.js'

/** §3.3: the daemon gets this long to answer before the swap is undone. */
export const HANDSHAKE_BUDGET_MS = 15_000

/** The two bundles this project installs, with the executables inside them. */
export const DEFAULT_BUNDLES = Object.freeze([
  { name: 'GlassPane.app', executable: path.join('Contents', 'MacOS', 'GlassPane Settings') },
  { name: 'GlassPane Daemon.app', executable: path.join('Contents', 'MacOS', 'glasspaned') },
])

/* ------------------------------------------------------------------ backup */

/** Name of the per-file content list a verified backup carries (§3.1). */
export const BACKUP_MANIFEST_NAME = 'backup-manifest.json'

/** Deterministic content snapshot of a directory tree: relative path -> size. */
export function snapshotDir(dir) {
  const out = {}
  const walk = (current, rel) => {
    for (const entry of sortedEntries(current)) {
      const abs = path.join(current, entry.name)
      const key = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, key)
      else if (entry.isFile()) out[key] = fs.statSync(abs).size
      else out[key] = 'special'
    }
  }
  walk(dir, '')
  return out
}

/**
 * The proof used for every copy this module makes: one entry per *relative
 * path*, and for a regular file the sha256 of the bytes that are actually on
 * disk. A length-only walk lets two trees of identical byte counts and different
 * content compare equal; this one does not.
 */
export function manifestTree(dir) {
  const out = {}
  const walk = (current, rel) => {
    for (const entry of sortedEntries(current)) {
      const abs = path.join(current, entry.name)
      const key = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        out[key] = { kind: 'dir' }
        walk(abs, key)
      } else if (entry.isSymbolicLink()) {
        out[key] = { kind: 'symlink', target: fs.readlinkSync(abs) }
      } else if (entry.isFile()) {
        out[key] = { kind: 'file', sha256: sha256FileSync(abs), size: fs.statSync(abs).size }
      } else {
        out[key] = { kind: 'special' }
      }
    }
  }
  walk(dir, '')
  return out
}

function sortedEntries(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
}

function manifestsEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false
  return true
}

/** Relative paths that disagree, in a stable order, capped so a message reads. */
function firstDifferences(a, b, limit = 5) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  return keys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).slice(0, limit)
}

/**
 * Copy the installed bundles into `<backupRoot>/<stamp>/` and *verify* the copy
 * byte-for-byte against the live tree, then record what the backup holds. Throws
 * `backup-failed` otherwise — the caller must not touch the live bundles when it
 * does.
 */
export function backupBundles({ appsDir, backupRoot, bundles = DEFAULT_BUNDLES, stamp = new Date().toISOString().replace(/[:.]/g, '-'), copyFn = defaultCopy, marker = {} }) {
  const root = canonicalPath(backupRoot)
  ensurePrivateDir(root)
  const dest = resolveWithin(root, path.join(root, stamp), 'backup directory')
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 })
  // A backup is a copy of somebody's whole install, so its mode is part of the
  // promise rather than a chmod that "probably worked" (see `fsutil.tightenMode`).
  tightenMode(dest, 0o700, 'backup directory')
  const recorded = []
  const manifestBundles = {}
  for (const bundle of bundles) {
    const source = path.join(appsDir, bundle.name)
    if (!fs.existsSync(source)) {
      throw new UpdaterError(
        CODES.backupFailed,
        `${source} is not installed, so there is nothing to back up before a swap: run the GlassPane installer instead of updating`,
      )
    }
    const target = path.join(dest, bundle.name)
    copyFn(source, target)
    const before = manifestTree(source)
    const after = manifestTree(target)
    if (!manifestsEqual(before, after)) {
      throw new UpdaterError(
        CODES.backupFailed,
        `the backup copy of ${bundle.name} does not match what is installed (differences: ${firstDifferences(before, after).join(', ')}): nothing was replaced`,
      )
    }
    manifestBundles[bundle.name] = before
    recorded.push({ name: bundle.name, files: Object.keys(before).length, digest: manifestDigest(before) })
  }
  const manifest = { at: new Date().toISOString(), stamp, bundles: manifestBundles }
  writePrivateFile(path.join(dest, BACKUP_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n')
  const markerBody = { at: new Date().toISOString(), ...marker, bundles: recorded, sourceAppsDir: appsDir }
  writePrivateFile(path.join(dest, 'backup-marker.json'), JSON.stringify(markerBody, null, 2) + '\n')
  return { dir: dest, stamp, marker: markerBody, manifest }
}

/** One digest for the whole file list, so a marker can name what it holds. */
function manifestDigest(manifest) {
  const lines = Object.keys(manifest)
    .sort()
    .map((key) => `${key}=${manifest[key]?.sha256 ?? manifest[key]?.target ?? manifest[key]?.kind ?? ''}`)
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** Read the manifest a backup carries. `null` when it has none or a broken one. */
export function readBackupManifest(backupDir) {
  const file = path.join(backupDir, BACKUP_MANIFEST_NAME)
  if (!fs.existsSync(file)) return { ok: false, manifest: null, reason: `${file} does not exist` }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return { ok: false, manifest: null, reason: `${file} is not readable JSON (${error.message})` }
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.bundles || typeof parsed.bundles !== 'object') {
    return { ok: false, manifest: null, reason: `${file} names no bundle file list` }
  }
  return { ok: true, manifest: parsed, reason: null }
}

/**
 * Put a backup back and *prove* it landed: each bundle is checked against the
 * manifest recorded when the backup was made, first as the bytes sitting in the
 * backup (a bundle that no longer matches its own record is not restored over a
 * live one), then as the bytes that came back. Names the bundle and the
 * relative paths that disagree; never reports success on "the directory exists".
 */
export function restoreBackup({ backupDir, appsDir, bundles = DEFAULT_BUNDLES, copyFn = defaultCopy, manifest = null }) {
  const wanted = manifest ?? readBackupManifest(backupDir)
  if (wanted.ok === false) {
    return {
      ok: false,
      message: `restore did not verify: ${backupDir} cannot be proven to hold the previous version (${wanted.reason}), so nothing more was replaced and a person has to re-run the GlassPane installer`,
    }
  }
  const expected = wanted.manifest.bundles ?? {}
  const mismatches = []
  for (const bundle of bundles) {
    const source = path.join(backupDir, bundle.name)
    const record = expected[bundle.name]
    if (!record) {
      mismatches.push(`${bundle.name} is named by no file list in the backup manifest`)
      continue
    }
    if (!fs.existsSync(source)) {
      mismatches.push(`${bundle.name} is missing from the backup`)
      continue
    }
    const inBackup = manifestTree(source)
    if (!manifestsEqual(record, inBackup)) {
      mismatches.push(`${bundle.name} read back different (${firstDifferences(record, inBackup).join(', ')}) in the backup; the live copy was left as it is`)
      continue
    }
    try {
      copyFn(source, path.join(appsDir, bundle.name))
    } catch (error) {
      mismatches.push(`${bundle.name} read back different (the copy failed: ${error.message}) after the restore`)
      continue
    }
    const landed = manifestTree(path.join(appsDir, bundle.name))
    if (!manifestsEqual(record, landed)) {
      mismatches.push(`${bundle.name} read back different (${firstDifferences(record, landed).join(', ')}) after the restore`)
    }
  }
  if (mismatches.length > 0) {
    return { ok: false, message: `restore did not verify: ${mismatches.join('; ')}` }
  }
  return { ok: true, message: 'the previous version is back in place and verified file-by-file' }
}

function defaultCopy(source, target) {
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true, dereference: false })
}

/* ------------------------------------------------------------------- build */

/**
 * Build the two bundles from the staged tree. Default implementation runs the
 * project's own commands; `applyUpdate` refuses to swap when it fails, which
 * leaves the live bundles untouched (§3.2 `staged-build-failed`).
 */
export function buildStagedTree(stagedTree, { run = defaultRun, timeoutMs = 15 * 60_000 } = {}) {
  const engineDir = path.join(stagedTree, 'engine')
  if (!fs.existsSync(engineDir)) {
    return { ok: false, builtDir: null, message: `the staged tree has no engine/ directory: ${stagedTree}` }
  }
  const build = run('swift', ['build', '-c', 'release', '--package-path', engineDir], { cwd: stagedTree, timeoutMs })
  if (build.status !== 0) {
    return { ok: false, builtDir: null, message: `swift build -c release exited ${build.status}: ${(build.stderr || build.stdout || '').trim().slice(-400)}` }
  }
  const makeApp = path.join(engineDir, 'scripts', 'make-app.sh')
  if (!fs.existsSync(makeApp)) {
    return { ok: false, builtDir: null, message: `the staged tree has no engine/scripts/make-app.sh` }
  }
  const pack = run('/bin/sh', [makeApp], { cwd: stagedTree, timeoutMs })
  if (pack.status !== 0) {
    return { ok: false, builtDir: null, message: `make-app.sh exited ${pack.status}: ${(pack.stderr || pack.stdout || '').trim().slice(-400)}` }
  }
  const builtDir = path.join(engineDir, '.build', 'release')
  for (const bundle of DEFAULT_BUNDLES) {
    if (!fs.existsSync(path.join(builtDir, bundle.name))) {
      return { ok: false, builtDir: null, message: `the build finished but ${bundle.name} is not in ${builtDir}` }
    }
  }
  return { ok: true, builtDir, message: null }
}

function defaultRun(bin, args, { cwd, timeoutMs } = {}) {
  const res = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs ?? 120_000 })
  if (res.error && res.status === null) {
    return { status: 127, stdout: '', stderr: String(res.error.message) }
  }
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Move built bundles into `appsDir`, verifying each one after the copy. */
export function installBundles({ builtDir, appsDir, bundles = DEFAULT_BUNDLES, copyFn = defaultCopy }) {
  const failures = []
  for (const bundle of bundles) {
    const source = path.join(builtDir, bundle.name)
    const target = path.join(appsDir, bundle.name)
    try {
      copyFn(source, target)
      const expected = manifestTree(source)
      const landed = manifestTree(target)
      if (!manifestsEqual(expected, landed)) {
        failures.push(`${bundle.name} did not read back identically after install (${firstDifferences(expected, landed).join(', ')})`)
      }
    } catch (error) {
      failures.push(`${bundle.name}: ${error.message}`)
    }
  }
  return { ok: failures.length === 0, failures }
}

/* -------------------------------------------------------------- handshake */

/** One NDJSON round trip against the daemon socket. Never throws. */
export function socketCall({ socketPath, request, timeoutMs = 5_000, connect = (options) => net.createConnection(options) }) {
  return new Promise((resolve) => {
    let buffer = ''
    let settled = false
    let socket
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.destroy()
      } catch {
        /* already gone */
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish({ answered: false, reason: `no reply within ${timeoutMs}ms` }), timeoutMs)
    try {
      socket = connect({ path: socketPath })
    } catch (error) {
      finish({ answered: false, reason: `connect failed (${error.message})` })
      return
    }
    socket.on('error', (error) => finish({ answered: false, reason: `socket error (${error.code ?? error.message})` }))
    socket.on('close', () => finish({ answered: false, reason: 'socket closed before replying' }))
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      try {
        finish({ answered: true, frame: JSON.parse(buffer.slice(0, newline)) })
      } catch (error) {
        finish({ answered: false, reason: `reply was not one JSON frame (${error.message})` })
      }
    })
  })
}

/**
 * §3.3's version read-back, and it is *two* readings: the socket's `hello` has
 * to answer with *this* version, and `glasspane-mcp` has to answer `tools/list`.
 * One without the other is not a verified swap — a daemon that reports 1.4.1
 * while the MCP forwarding layer is dead is exactly the half-installed machine
 * this section exists to catch — so both halves are asked on every poll and the
 * verdict only turns `ok` when both agree in the same poll. Retries until the
 * budget runs out, because a launchd restart takes a moment to serve.
 *
 * `daemonVersionVerify` is the same loop with the MCP reading left out, and it exists because of a real
 * machine (2026-10-01): the MCP half asks a **global** `glasspane-mcp` binary to answer, while a
 * checkout install only ever ran `npm install` in the workspaces — that global package is what **this very
 * `apply`** installs, two steps later. Requiring both readings before that step existed made `apply`
 * unsatisfiable on such a machine: the answer was always `hello said "1.5.1" … the MCP layer answered
 * "unavailable: glasspane-mcp could not run (ENOENT)"`, in a rollback sentence that contradicts itself.
 * The pair is still the proof that gates `current`; what moved is the MCP half, to the point where it
 * measures the artifact that has actually been installed.
 */
async function verifyAfterRestart({
  socketPath,
  wantVersion,
  budgetMs = HANDSHAKE_BUDGET_MS,
  pollMs = 500,
  call = socketCall,
  toolsList = null,
  deadline = Date.now() + budgetMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const seen = { hello: null, mcp: toolsList ? null : undefined }
  while (Date.now() < deadline) {
    const remaining = Math.max(50, deadline - Date.now())
    const hello = await call({ socketPath, request: '{"id":1,"method":"hello"}\n', timeoutMs: Math.min(2_000, remaining) })
    seen.hello = hello.answered ? (hello.frame?.result?.version ?? null) : `unanswered: ${hello.reason}`
    const helloOk = hello.answered === true && hello.frame?.result?.version === wantVersion
    let mcpOk = true
    if (toolsList) {
      const mcp = await toolsList({})
      seen.mcp = mcp.ok ? `${mcp.count} tools` : `unavailable: ${mcp.reason}`
      mcpOk = mcp.ok === true
    }
    if (helloOk && mcpOk) {
      return { ok: true, version: wantVersion, seen, message: null }
    }
    await sleep(pollMs)
  }
  const halves = toolsList
    ? `does not report ${wantVersion} (hello said ${JSON.stringify(seen.hello)}) and the MCP layer answered "${seen.mcp ?? 'not tried'}"`
    : `does not report ${wantVersion} (hello said ${JSON.stringify(seen.hello)})`
  return { ok: false, version: wantVersion, seen, message: `after ${budgetMs}ms the daemon at ${socketPath} ${halves}` }
}

export function handshakeVerify(options = {}) {
  return verifyAfterRestart({ toolsList: mcpToolsList, ...options })
}

/** §3.3's first half alone: the daemon is back up and reports the version that was just installed. */
export function daemonVersionVerify(options = {}) {
  return verifyAfterRestart(options)
}

/* -------------------------------------------------------------- npm layer */

/**
 * §1's last bullet: the two npm packages come **from the verified staged tree**
 * (`npm pack` there), never from the registry, so the bytes that were checked
 * are the bytes that get installed. §3.4: the previously installed version is
 * recorded, **the installed version is read back afterwards**, and a read-back
 * mismatch puts the recorded one back.
 *
 * The read-back is the gate; `install` returning `ok` is only "npm exited 0",
 * which this machine has already been shown not to mean anything on its own (a
 * failed resolution, a cache hit of an older tarball, a `--force` in somebody's
 * `.npmrc` all answer 0). `defaultReadGlobalVersion` is `npm ls -g --depth=0
 * --json`, i.e. what the global prefix actually holds. Reverse mutation: delete
 * the `wanted`/`disagreed` comparison below — `the npm read-back is the gate: a
 * version that did not land is rolled back` goes red.
 */
export function installNpmPackages({
  stagedTree,
  packageDirs = ['mcp-shell', 'installer'],
  run = defaultRun,
  readGlobalVersion = defaultReadGlobalVersion,
  install = defaultNpmInstall,
  restore = defaultNpmRestore,
  readStagedPackageJson = defaultReadStagedPackageJson,
} = {}) {
  const packed = []
  /** name -> the version the verified staged tree claims, and the tgz holding it. */
  const wanted = []
  for (const rel of packageDirs) {
    const dir = path.join(stagedTree, rel)
    if (!fs.existsSync(dir)) return { ok: false, code: CODES.npmVersionMismatch, message: `the staged tree has no ${rel}: cannot produce its tarball` }
    const claim = readStagedPackageJson(dir)
    if (!claim || !claim.name || !claim.version) {
      return { ok: false, code: CODES.npmVersionMismatch, message: `${path.join(dir, 'package.json')} names no package or carries no version: nothing from it can be installed or verified afterwards` }
    }
    const res = run('npm', ['pack', '--ignore-scripts'], { cwd: dir, timeoutMs: 180_000 })
    const file = (res.stdout ?? '').trim().split('\n').filter(Boolean).pop()
    if (res.status !== 0 || !file || !file.endsWith('.tgz')) {
      return { ok: false, code: CODES.npmVersionMismatch, message: `npm pack in ${dir} failed (exit ${res.status}): ${(res.stderr ?? '').trim().slice(0, 200)}` }
    }
    const tgz = path.join(dir, file)
    packed.push(tgz)
    wanted.push({ name: claim.name, version: claim.version, dir, tgz })
  }
  const original = {}
  for (const pkg of wanted) original[pkg.name] = readGlobalVersion(pkg.name)
  for (const pkg of wanted) {
    const result = install(pkg.tgz)
    if (!result.ok) {
      return { ok: false, code: CODES.npmVersionMismatch, message: `npm install -g ${pkg.tgz} failed: ${result.message}`, original, installed: [] }
    }
  }
  // §3.4's read-back: every package the staged tree shipped has to answer with
  // the version that tree was verified against.
  const installedNow = {}
  for (const pkg of wanted) installedNow[pkg.name] = readGlobalVersion(pkg.name)
  const disagreed = wanted.filter((pkg) => installedNow[pkg.name] !== pkg.version)
  if (disagreed.length > 0) {
    const repairs = restoreNpmPackages({
      original,
      only: Object.fromEntries(disagreed.map((pkg) => [pkg.name, pkg.version])),
      restore,
    }).map((r) => ({ name: r.name, ok: r.ok, message: r.message }))
    const allBack = repairs.every((r) => r.ok)
    const detail = disagreed.map((pkg) => `${pkg.name} reads back ${JSON.stringify(installedNow[pkg.name])} after installing ${pkg.version}`).join('; ')
    return {
      ok: false,
      code: CODES.npmVersionMismatch,
      message: `${detail}; the packages were ${allBack ? 'put back at the versions recorded before the install' : `NOT all put back (${repairs.filter((r) => !r.ok).map((r) => `${r.name}: ${r.message}`).join('; ')}) — re-run "npm install -g" for the GlassPane packages`}`,
      original,
      installed: installedNow,
      wanted: Object.fromEntries(wanted.map((pkg) => [pkg.name, pkg.version])),
      repairs,
    }
  }
  return { ok: true, code: null, message: null, packed, original, installed: installedNow, wanted: Object.fromEntries(wanted.map((pkg) => [pkg.name, pkg.version])) }
}

/**
 * Put the global npm layer back at the versions recorded before an install.
 *
 * Exported because there are now two places that must do it: `installNpmPackages` itself, when a package
 * reads back a different version than the verified tree claimed, and `apply`'s post-swap gate when the
 * freshly installed `glasspane-mcp` still cannot answer `tools/list`. Two authors of that repair is how
 * one of them ends up not rolling back, so the second caller reuses this one.
 *
 * A package with no recorded original is *not* silently uninstalled: "this machine had none" and "this
 * machine had one we cannot name" are different answers, and the second one has to be said out loud
 * rather than fixed by removing something the person may still be using.
 */
export function restoreNpmPackages({ original = {}, wanted = {}, only = null, restore = defaultNpmRestore } = {}) {
  // `wanted` is normally the set just installed; a caller that only knows what it recorded (the shape
  // `apply`'s npm step hands back) still has to get every one of those packages put back, so an empty
  // `wanted` falls through to `original` rather than quietly restoring nothing.
  const explicit = only ?? wanted
  const targets = Object.keys(explicit ?? {}).length > 0 ? explicit : original
  const out = []
  for (const name of Object.keys(targets)) {
    const from = original[name] ?? null
    if (!from) {
      out.push({ name, ok: false, message: 'the version this machine had before is unknown, so it cannot be put back' })
      continue
    }
    const back = restore(name, from)
    out.push({ name, ok: back?.ok === true, message: back?.ok === true ? null : (back?.message ?? 'npm restore returned nothing') })
  }
  return out
}

/** The `package.json` of one staged package: the name and version that were verified. */
function defaultReadStagedPackageJson(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return { name: parsed?.name ?? null, version: parsed?.version ?? null }
  } catch {
    return null
  }
}

function defaultNpmInstall(tgz) {
  const res = defaultRun('npm', ['install', '-g', tgz], { timeoutMs: 300_000 })
  return res.status === 0 ? { ok: true, message: null } : { ok: false, message: (res.stderr || res.stdout || 'no output').trim().slice(0, 300) }
}

/**
 * §3.4's "装回原版本". The only bytes that carry "the version this machine had"
 * are the ones npm has: the staged tree holds the NEW version by definition, and
 * §1's no-registry rule is about what gets installed as the *update* — a repair
 * back to a recorded version is a different question, and the answer that exists
 * offline is npm's own prefix cache. A person reading the panel's sentence can
 * always re-run the installer, which is the documented fallback.
 */
function defaultNpmRestore(name, version) {
  const res = defaultRun('npm', ['install', '-g', `${name}@${version}`], { timeoutMs: 300_000 })
  return res.status === 0 ? { ok: true, message: null } : { ok: false, message: (res.stderr || res.stdout || 'no output').trim().slice(0, 300) }
}

function defaultReadGlobalVersion(pkg) {
  const res = defaultRun('npm', ['ls', '-g', '--depth=0', '--json'], { timeoutMs: 60_000 })
  if (res.status !== 0 && !res.stdout) return null
  try {
    const parsed = JSON.parse(res.stdout || '{}')
    return parsed?.dependencies?.[pkg]?.version ?? null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------- the sequence */

/**
 * Can this account actually put a package where npm's global prefix points?
 *
 * Why this is asked *before* the swap and not at the npm step: `apply` replaces the two `.app` bundles,
 * restarts the daemon and waits for a handshake, and only then runs `npm install -g`. On a machine whose
 * global directory belongs to root (measured on a real install on 2026-10-01: `/usr/local/lib/node_modules`
 * is `root:wheel`, and this account has never installed a GlassPane package at all), that last step fails
 * with EACCES — and the failure is *after* the machine changed. The answer comes back `post-swap-failed`,
 * the bundles get restored, the daemon restarts a second time, and the same thing happens tomorrow at the
 * same minute. A refusal that costs one `npm config` call beats a swap-and-rollback that costs two daemon
 * restarts and never lands a version.
 *
 * `fs.W_OK` on the directory is the whole question — npm creates package directories inside it, and a
 * missing `lib/node_modules` under a writable prefix is npm's to make.
 */
export function checkNpmPrefix({ run = defaultRun, fsImpl = fs } = {}) {
  let got = null
  try {
    got = run('npm', ['config', 'get', 'prefix'], { timeoutMs: 30_000 })
  } catch (error) {
    return { ok: false, prefix: null, dir: null, reason: `asking npm for its global prefix threw (${error?.message ?? String(error)})` }
  }
  const prefix = String(got?.stdout ?? '').trim()
  if (got?.status !== 0 || prefix === '' || prefix.startsWith('-')) {
    return {
      ok: false,
      prefix: prefix === '' ? null : prefix,
      dir: null,
      reason: `npm config get prefix answered ${String(got?.status)}${(got?.stderr ?? '').trim() ? `: ${String(got.stderr).trim().slice(0, 160)}` : ''}`,
    }
  }
  const globalModules = path.join(prefix, 'lib', 'node_modules')
  const dir = fsImpl.existsSync(globalModules) ? globalModules : prefix
  if (!fsImpl.existsSync(dir)) {
    return { ok: false, prefix, dir, reason: `${dir} does not exist, so there is nowhere for a global package to land` }
  }
  try {
    fsImpl.accessSync(dir, fsImpl.constants.W_OK)
  } catch (error) {
    return { ok: false, prefix, dir, reason: `${dir} is not writable by this account (${error?.code ?? error?.message})` }
  }
  return { ok: true, prefix, dir, reason: null }
}

/**
 * `updater apply`. Everything that can be decided *before* touching the live
 * bundles comes first, so the common refusals (busy, needs consent, stale
 * pointer, missing staged tree) never reach a swap.
 */
export async function applyUpdate({
  stateRoot,
  appsDir,
  bundles = DEFAULT_BUNDLES,
  now = new Date(),
  consents = [],
  trigger = 'manual',
  currentVersion = null,
  probe = {},
  job = {},
  build = buildStagedTree,
  copyFn = defaultCopy,
  kickstart = kickstartJob,
  helloCall = socketCall,
  toolsList = mcpToolsList,
  npm = installNpmPackages,
  // The npm pre-flight runs only when the npm step is the real one. A caller that injects `npm` has
  // taken responsibility for that layer (that is what tests of the *sequence* do), and letting the
  // default here shell out to a real `npm config` would make every one of those tests read the
  // developer's machine instead of the code under test.
  preflightNpm = npm === installNpmPackages ? checkNpmPrefix : () => ({ ok: true, prefix: null, dir: null, reason: null }),
  /**
   * The undo for the npm layer, through the same seam as its install.
   *
   * Without this the rollback path below reaches for the module's own `defaultNpmRestore`, and a test of
   * `apply`'s *sequence* — which injects `npm` but says nothing about restoring — ends up running real
   * `npm install -g` against the developer's machine. That happened: the run died in `/usr/local/bin`
   * with EACCES while pretending to test a rollback. A caller that injects `npm` owns that layer, so the
   * default here answers "restored" and touches nothing; production gets the real one because it does not
   * inject `npm`.
   */
  restoreNpm = npm === installNpmPackages
    ? (info) => restoreNpmPackages({ original: info?.original, wanted: info?.wanted })
    : () => [{ ok: true, message: null }],
  socketPath = null,
  writeState = true,
  refreshCa = null,
  // §11: the updater's own copy. `env`/`autoDisabled` decide whether a job may be registered at all,
  // and the whole step is injectable because it spawns a process and reads launchd's answer.
  env = process.env,
  autoDisabled = false,
  readRunningJobImpl = readRunningJob,
  refreshRuntimeImpl = refreshRuntime,
  undoHandoverImpl = undoHandover,
  // The same registration step §11's forward path uses, given to the undo as well. Without it the
  // rollback path could only be driven by spawning a real `node`, which is not what a test of the
  // sequence is for.
  runEnableImpl = undefined,
} = {}) {
  const roots = writableRoots(stateRoot)
  const { state } = loadState(stateRoot)
  // Read *before* §11 gets the chance to move it: the pointer is the only document that says which
  // updater this machine was running, and once the handover has flipped it no later read can answer
  // that question. A rollback that runs after the handover needs the answer.
  const pointerRead = typeof refreshRuntimeImpl === 'function' ? readPointer(stateRoot) : { ok: false, pointer: null }
  const pointerBefore = pointerRead.ok ? pointerRead.pointer : null
  /**
   * Whether this run may touch launchd, decided once and given to both halves of §11.
   *
   * The forward step and the undo have to agree, or a rollback of a scheduled run would make the call the
   * forward step refused: `bootout` of the job that is running this very process, leaving the machine with
   * a rolled-back bundle set and no agent at all until the next manual `enable`.
   */
  const handoverMode = trigger === 'auto' ? 'defer' : 'now'
  /** Merge `patch` onto `base` and publish it. `stamp` is the ordinary case: this run's own read. */
  function stampOnto(base, patch) {
    const next = nextState(base, patch, { now })
    if (writeState) saveState(stateRoot, next, { now })
    return next
  }
  function stamp(patch) {
    return stampOnto(state, patch)
  }
  /**
   * The base used for the *last* write of a successful apply — after §11's handover.
   *
   * `enable` in the new copy is a separate process, and it writes this very file: its own history row
   * and, when it re-exports the root bundle, a newer `caRoots`. Merging the applied patch onto the
   * document read before the swap deletes whatever that child recorded, and the history is the only
   * thing the panel's two buttons and `gp_diagnose` can quote. So the base is re-read.
   *
   * A file that cannot be re-read is not a reason to undo a swap that happened, and it is not a
   * reason to pretend either: the run falls back to its own earlier read and says so in the record.
   */
  function freshestBase(notes) {
    try {
      return loadState(stateRoot).state
    } catch (error) {
      notes.push(`the state file could not be re-read before the final write (${error?.message ?? String(error)}), so this record was merged onto `
        + 'the state read at the start of the run: a row the new updater wrote during the handover may be missing from the history')
      return state
    }
  }
  // What §11's handover may have written that this run cannot see from its own read. Kept as a list so
  // the catch below can say it too, and never folded into a status by itself.
  const handoverNotes = []
  // Only true once the new copy has been asked to register itself: before that, nothing but this
  // function has touched the state file, and a re-read would only add a claim that is not earned.
  let handoverRan = false
  const fail = (status, code, message, extra = {}) => {
    // §4: the panel prints `lastError` verbatim, so the sentence that comes back
    // from the gate is stamped into the state file alongside the code — a code
    // alone is not something a person can act on.
    const saved = stamp({
      status,
      code,
      message,
      details: extra.details ?? null,
      // A refusal that invalidates the staged offer has to say so in the
      // document too: leaving `staged` standing is what lets a stale tree be
      // applied minutes later against a version nobody checked it against.
      ...(extra.clearStaged ? { staged: null } : {}),
      historyEntry: { action: 'apply', result: status, digest: state.staged?.digest ?? null, code },
    })
    return { ok: false, status, code, message, state: saved, rollback: extra.rollback ?? { ok: true, performed: false }, details: extra.details ?? null }
  }

  // Gate: something must be staged, and the tree must still be there.
  const staged = stagedTreePresent({ stateRoot, staged: state.staged })
  if (!staged.ok) {
    return fail('deferred', CODES.notStaged, `nothing is staged for update (${staged.reason}): run "updater check" first, and press Install update when it reports a version.`)
  }
  const wantVersion = state.staged.version
  const appliedDigest = state.staged.digest
  const baseline = currentVersion ?? state.current
  if (!baseline) {
    return fail('deferred', CODES.versionMismatchLocal, 'this machine has no recorded current version, so an update cannot be judged: reinstall GlassPane first')
  }

  // Gate: consent. A major never applies without a person.
  const kind = bumpKind(parsePlainVersion(wantVersion), parsePlainVersion(baseline))
  if (kind !== 'major' && kind !== 'minor' && kind !== 'patch') {
    // §7's `apply` means "put the staged version in", and "staged" is an
    // *offer*, not a licence: a check that refused half-way leaves its
    // `staged` tree in place, so without this gate a hand-installed 1.5.0 can
    // be auto-downgraded to whatever was staged against the older version. The
    // comparison is made against the version installed *at apply time*, never
    // against the one recorded at check time. Reverse mutation: drop this
    // branch — `an equal or older staged tree is refused instead of swapped in`
    // goes red on a swapped-in 1.3.9.
    return fail('deferred', CODES.stagedNotNewer, `${describeKind(kind, wantVersion, baseline)}. Nothing was swapped, and the staged tree was dropped from the state: run "updater check" again against the version this machine actually runs.`, {
      details: { kind, wantVersion, baseline },
      clearStaged: true,
    })
  }
  if (kind === 'major' && !consents.includes('major')) {
    return fail('needs-consent', CODES.consentRequired, `version ${wantVersion} is a major upgrade from ${baseline}. Press "Install update" in the GlassPane panel to confirm you want it.`)
  }
  if (trigger === 'auto' && (state.disabled === true || state.autoApply === false)) {
    // §5: the switch really stops the swap. A manual invocation (the panel
    // button, an operator at a terminal) is still allowed when it is off.
    return fail('deferred', CODES.autoDisabled, 'automatic update is switched off, so nothing was applied. Press "Install update" in the GlassPane panel to do it by hand.')
  }

  // Gate §2: idle. Answered probe only. Nothing is restarted on a refusal.
  const verdict = await probeIdle({ socketPath: socketPath ?? probe.socketPath, timeoutMs: probe.timeoutMs })
  if (job.unknown === true) {
    return fail('deferred', CODES.busyOrUnreachable, `the running daemon job could not be identified (${job.reason}), so no version was swapped`)
  }
  const permission = decideSwapPermission({ probe: verdict, jobArgs: job.args, ourStateRoot: stateRoot, consented: consents })
  if (permission.status !== 'allowed') {
    return fail(permission.status === 'deferred' ? 'deferred' : 'needs-consent', permission.code, permission.reason, { details: { probe: verdict.reason } })
  }

  // §3.5's pre-flight, placed here because everything below this line can change the live machine.
  // The npm step is the last one and the only one that can need root; finding that out after the
  // bundles were swapped buys a rollback, two daemon restarts and a version that never lands.
  const npmReady = preflightNpm()
  if (!npmReady.ok) {
    const remedy = npmReady.dir
      // The two ways out both need a person (a password, or a PATH change), so the sentence says which
      // one it is recommending and what to press afterwards — an agent can run the chown only if a human
      // authorized it, and it must not be left guessing between two different fixes.
      ? `A person has to do one of these once: hand that directory to this account with `
        + '`sudo chown -R "$(whoami)" ' + npmReady.dir + '`'
        + ', or move npm\'s prefix under the home directory (`npm config set prefix ~/.npm-global`, put '
        + '`~/.npm-global/bin` on PATH, then re-run the GlassPane installer so the launcher points at the new one). '
        + 'After that, press "Install update" again.'
      : 'Check `npm config get prefix` from this account — the updater will not ask for a password.'
    return fail('deferred', CODES.npmPrefixUnwritable,
      'automatic update cannot finish on this machine: '
      + (npmReady.reason ?? 'the npm global prefix could not be checked')
      + '. Nothing was replaced and the daemon was not restarted: the two packages `glasspane-mcp` and '
      + '`glasspane-install` are installed with `npm install -g` *after* the bundles swap, and this account '
      + 'cannot write where npm would put them. ' + remedy,
      { details: { prefix: npmReady.prefix, dir: npmReady.dir } })
  }

  // From here on the live bundles may change: back them up first.
  let backup = null
  try {
    backup = backupBundles({
      appsDir,
      backupRoot: roots.backup,
      bundles,
      marker: { version: baseline, targetVersion: wantVersion, fromStateRoot: stateRoot },
      copyFn,
    })
  } catch (error) {
    return fail('apply-failed', error.code ?? CODES.backupFailed, `${error.message}; the installed version ${baseline} is untouched`, { rollback: { ok: true, performed: false, reason: 'nothing was replaced' } })
  }

  // §1.6/§3.2's paths are all *relative to the release root*, which for this
  // project's archive is one folder below `tree/`. Building out of `tree/`
  // directly is how a correctly staged release reads as "no engine/ directory".
  const built = build(staged.rootPath, {})
  if (!built.ok) {
    // §3.2: the build failed before anything moved — site untouched.
    const message = `${built.message}; the installed ${baseline} is still in place because nothing was swapped`
    const saved = stamp({
      status: 'staged-build-failed',
      code: CODES.stagedBuildFailed,
      message,
      historyEntry: { action: 'apply', result: 'staged-build-failed', digest: state.staged.digest, code: CODES.stagedBuildFailed },
    })
    return {
      ok: false,
      status: 'staged-build-failed',
      code: CODES.stagedBuildFailed,
      message,
      state: saved,
      rollback: { ok: true, performed: false, reason: 'build failed before the swap' },
    }
  }

  /**
   * §2's idle evidence has a shelf life, and this is the place it expires: the
   * probe above was answered *before* a build that can run for minutes, and a
   * mutation started during it is exactly what `kickstart -k` cancels. So every
   * restart below re-asks first and refuses when the second answer does not
   * come. Reverse mutation: replace `restartIfIdle()` with a bare
   * `kickstart({})` — `a daemon that goes busy during the build is never
   * restarted` goes red on a recorded kickstart call.
   */
  const restartIfIdle = async () => {
    const again = await probeIdle({ socketPath: socketPath ?? probe.socketPath, timeoutMs: probe.timeoutMs })
    if (!again.answered) return { restarted: false, reason: again.reason, verdict: again }
    try {
      const result = await kickstart({})
      return { restarted: true, reason: null, verdict: again, result }
    } catch (error) {
      // A restart that fails is reported, never swallowed: §2's "answered"
      // evidence held, so the refusal to restart is not the reason the caller
      // sees.
      return { restarted: false, reason: `launchctl kickstart failed (${error.message})`, verdict: again }
    }
  }

  const installed = installBundles({ builtDir: built.builtDir, appsDir, bundles, copyFn })
  if (!installed.ok) {
    const restored = restoreBackup({ backupDir: backup.dir, appsDir, bundles, copyFn })
    if (!restored.ok) {
      // §7's exit 5: the swap did not land *and* the way back is gone. The
      // sentence has to tell a person what to do, not what the code says.
      const message = `installing the new bundles failed (${installed.failures.join('; ')}) and the previous version could not be put back (${restored.message}): re-run the GlassPane installer to put ${appsDir} back, and do not press "Install update" again until you have`
      const saved = stamp({ status: 'rollback-failed', code: CODES.rollbackFailed, message, historyEntry: { action: 'apply', result: 'rollback-failed', digest: state.staged.digest, code: CODES.rollbackFailed } })
      return {
        ok: false,
        status: 'rollback-failed',
        code: CODES.rollbackFailed,
        message,
        state: saved,
        rollback: { ok: false, performed: true, reason: restored.message },
      }
    }
    const restart = await restartIfIdle()
    return fail(
      'apply-failed',
      CODES.swapFailed,
      `the new bundles could not be installed (${installed.failures.join('; ')}); version ${baseline} was restored and verified${restartLine(restart)}`,
      { rollback: { ok: true, performed: true } },
    )
  }

  // Declared before the post-swap region, not inside it: the catch at the bottom has to be able to see
  // whether §11 already handed the machine over, because a rollback that runs *after* a successful
  // handover is only a rollback if the pointer and the loaded job go back with the bundles. An earlier
  // version of this declared `runtime` inside the try, so that catch threw a ReferenceError instead —
  // the undo could never run, and the throw escaped to `cli.js`'s generic handler, which answers exit 3
  // ("nothing changed") about a machine whose bundles had just been swapped and swapped back.
  let runtime = null

  /* ---------------------------------------------------------------- post-swap
   * Everything from here on runs with the NEW bundles already in
   * `appsDir`, so a throw that escaped this region reached `cli.js`'s generic
   * handler and was stamped `check-failed` / exit 3 — "nothing changed", which
   * is the one sentence that is false about this machine. The whole region is
   * wrapped so the answer names the swap and what failed after it, and lands in
   * §7's 4/5 band. Reverse mutation: delete the try/catch (let the `npm` call
   * throw) — `a throw after the swap still says the swap happened` goes red on
   * exit 3 / `check-failed`.
   */
  try {
    // Re-probe before the first restart: the build ran, the user may not be idle.
    const firstRestart = await restartIfIdle()
    if (!firstRestart.restarted) {
      const restored = restoreBackup({ backupDir: backup.dir, appsDir, bundles, copyFn })
      if (!restored.ok) {
        const message = `the daemon stopped answering the idle probe while the new version was being built (${firstRestart.reason}), so it was not restarted, and the previous version could not be put back (${restored.message}): re-run the GlassPane installer to put ${appsDir} back`
        const saved = stamp({ status: 'rollback-failed', code: CODES.rollbackFailed, message, details: { reason: firstRestart.reason }, historyEntry: { action: 'rollback', result: 'rollback-failed', digest: state.staged.digest, code: CODES.rollbackFailed } })
        return {
          ok: false,
          status: 'rollback-failed',
          code: CODES.rollbackFailed,
          message,
          state: saved,
          rollback: { ok: false, performed: true, reason: restored.message },
          restart: firstRestart,
        }
      }
      // Nothing was restarted (the point of §2), and the new bundles are gone
      // again: this is the "refused, nothing of yours changed" band, exit 3.
      return fail(
        'deferred',
        CODES.busyOrUnreachable,
        `the daemon did not answer the idle probe a second time before the restart (${firstRestart.reason}), so it was not restarted and ${baseline} was put back and verified; nothing was swapped in`,
        { rollback: { ok: true, performed: true } },
      )
    }

    /**
     * §3.3's **first** reading, taken before the npm layer exists on this machine.
     *
     * The pair used to be read together here, and on a checkout-installed machine that made `apply`
     * unsatisfiable: `glasspane-mcp` is a global binary, the installer never installs it globally, and the
     * step that would (the one below) sat behind the gate that asks for it. Every scheduled run swapped the
     * bundles, restarted the daemon, watched `hello` answer the new version, failed on `ENOENT` from a
     * binary that cannot exist yet, and rolled the machine back — with a sentence that said both the new
     * version was running *and* the update failed. Measured on a real machine on 2026-10-01.
     */
    const daemonUp = await daemonVersionVerify({
      socketPath: socketPath ?? probe.socketPath,
      wantVersion,
      budgetMs: probe.handshakeBudgetMs ?? HANDSHAKE_BUDGET_MS,
      call: helloCall,
    })
    if (!daemonUp.ok) {
      const restored = restoreBackup({ backupDir: backup.dir, appsDir, bundles, copyFn })
      const sides = `installed ${wantVersion}, running daemon reports ${JSON.stringify(daemonUp.seen?.hello ?? null)}`
      if (!restored.ok) {
        const message = `${daemonUp.message}; and the backup could not be restored (${restored.message}): re-run the GlassPane installer to put ${appsDir} back`
        const saved = stamp({
          status: 'rollback-failed',
          code: CODES.rollbackFailed,
          message,
          details: { wantVersion, hello: daemonUp.seen?.hello ?? null, mcp: null },
          historyEntry: { action: 'rollback', result: 'rollback-failed', digest: state.staged.digest, code: CODES.rollbackFailed },
        })
        return {
          ok: false,
          status: 'rollback-failed',
          code: CODES.rollbackFailed,
          message,
          state: saved,
          rollback: { ok: false, performed: true, reason: restored.message },
          handshake: daemonUp,
        }
      }
      // §2 again, on the *second* restart: the daemon that just failed its version read-back may have
      // taken work in the meantime, and a busy `kickstart` cancels it. Files back, restart deferred, and
      // the sentence says so.
      const restart = await restartIfIdle()
      const message = `${daemonUp.message}; ${sides}; ${baseline} was restored and verified${restartLine(restart, 'the daemon was restarted again')}. The npm layer was never touched, so nothing was installed or removed there.`
      const saved = stamp({
        status: 'rolled-back',
        code: CODES.rolledBack,
        message,
        details: { wantVersion, hello: daemonUp.seen?.hello ?? null, mcp: null },
        current: baseline,
        historyEntry: { action: 'rollback', result: 'rolled-back', digest: state.staged.digest, code: CODES.handshakeFailed },
      })
      return {
        ok: false,
        status: 'rolled-back',
        code: CODES.rolledBack,
        message,
        state: saved,
        rollback: { ok: true, performed: true },
        handshake: daemonUp,
        restart,
      }
    }

    // §3.4: record the original version, install from the verified tree, read the installed version back,
    // put the recorded one back if it disagrees.
    const npmResult = await npm({ stagedTree: staged.rootPath, copyFn })
    if (npmResult?.ok === false) {
      const restored = restoreBackup({ backupDir: backup.dir, appsDir, bundles, copyFn })
      const restart = await restartIfIdle()
      const status = restored.ok ? 'rolled-back' : 'rollback-failed'
      const message = `${npmResult.message}; the bundles were ${restored.ok ? `restored to ${baseline}${restartLine(restart, 'and the daemon restarted again')}` : `NOT restorable (${restored.message}) — re-run the GlassPane installer`}`
      const saved = stamp({ status, code: npmResult.code, message, historyEntry: { action: 'rollback', result: status, digest: state.staged.digest, code: npmResult.code } })
      return {
        ok: false,
        status,
        code: npmResult.code,
        message,
        state: saved,
        rollback: { ok: restored.ok, performed: true },
        npm: npmResult,
        restart,
      }
    }

    /**
     * §3.3's **second** reading, taken where it can only measure what this swap installed: the MCP
     * forwarding layer is now the version packed from the verified tree. Both halves are still required
     * before `current` moves — a daemon on the new version with a forwarding layer that cannot answer
     * `tools/list` is the half-installed machine this section exists to refuse — but refusing it now also
     * has to undo the npm layer, which the old ordering could never reach.
     */
    const handshake = await handshakeVerify({
      socketPath: socketPath ?? probe.socketPath,
      wantVersion,
      budgetMs: probe.handshakeBudgetMs ?? HANDSHAKE_BUDGET_MS,
      call: helloCall,
      toolsList,
    })
    if (!handshake.ok) {
      const restored = restoreBackup({ backupDir: backup.dir, appsDir, bundles, copyFn })
      const npmBack = restoreNpm(npmResult ?? {})
      const npmBackLine = npmBack.length === 0
        ? 'no global package was recorded before this install, so the npm layer was left empty'
        : npmBack.every((r) => r.ok)
          ? `the npm packages were put back at ${Object.entries(npmResult?.original ?? {}).map(([k, v]) => `${k}@${v}`).join(', ')}`
          : `the npm packages were NOT all put back (${npmBack.filter((r) => !r.ok).map((r) => `${r.name}: ${r.message}`).join('; ')}) — run "npm install -g" for those by hand`
      const sides = `installed ${wantVersion}, running daemon reports ${JSON.stringify(handshake.seen?.hello ?? null)}`
      if (!restored.ok) {
        const message = `${handshake.message}; ${npmBackLine}; and the backup could not be restored (${restored.message}): re-run the GlassPane installer to put ${appsDir} back`
        const saved = stamp({
          status: 'rollback-failed',
          code: CODES.rollbackFailed,
          message,
          details: { wantVersion, hello: handshake.seen?.hello ?? null, mcp: handshake.seen?.mcp ?? null },
          historyEntry: { action: 'rollback', result: 'rollback-failed', digest: state.staged.digest, code: CODES.rollbackFailed },
        })
        return {
          ok: false,
          status: 'rollback-failed',
          code: CODES.rollbackFailed,
          message,
          state: saved,
          rollback: { ok: false, performed: true, reason: restored.message },
          handshake,
          npm: { ...npmResult, restored: npmBack },
        }
      }
      const restart = await restartIfIdle()
      const message = `${handshake.message}; ${sides}; ${npmBackLine}; ${baseline} was restored and verified${restartLine(restart, 'the daemon was restarted again')}`
      const saved = stamp({
        status: 'rolled-back',
        code: CODES.rolledBack,
        message,
        details: { wantVersion, hello: handshake.seen?.hello ?? null, mcp: handshake.seen?.mcp ?? null },
        current: baseline,
        historyEntry: { action: 'rollback', result: 'rolled-back', digest: state.staged.digest, code: CODES.handshakeFailed },
      })
      return {
        ok: false,
        status: 'rolled-back',
        code: CODES.rolledBack,
        message,
        state: saved,
        rollback: { ok: true, performed: true },
        handshake,
        npm: { ...npmResult, restored: npmBack },
        restart,
      }
    }

    // §3.5: only a full success moves `current`, and the staging tree is retired.
    //
    // §11 first, while that verified tree still exists: the updater's own copy has to move with the
    // swap, or a release that fixes the updater can never reach the machine it fixes. The source is
    // exactly the tree the eight gates passed, copied into a fresh version directory before the
    // staging tree is retired below — never an overwrite of the code that is running this function.
    runtime = state.runtime ?? null
    if (typeof refreshRuntimeImpl === 'function') {
      handoverRan = true
      try {
        const outcome = await refreshRuntimeImpl({
          stateRoot,
          version: wantVersion,
          sourceTree: staged.rootPath,
          env,
          disabled: autoDisabled === true || state.disabled === true,
          readRunningJob: readRunningJobImpl,
          ...(runEnableImpl === undefined ? {} : { runEnable: runEnableImpl }),
          handover: handoverMode,
          now: () => now,
        })
        runtime = outcome?.record ?? outcome ?? null
      } catch (error) {
        // The swap already happened; a throw here must not rewrite that verdict (§11.4). It becomes a
        // stated failure of the updater's own move instead.
        runtime = {
          status: 'failed',
          version: String(wantVersion),
          cliPath: null,
          previousCliPath: state.runtime?.cliPath ?? null,
          agentVerified: null,
          at: now.toISOString(),
          code: CODES.runtimeStale,
          detail: `refreshing the updater's own copy threw (${error?.message ?? String(error)}); the bundles did change, so this is not a rolled-back apply`,
        }
      }
    }
    const runtimeStalled = runtime?.status === 'failed'
    removeTreeWithin(roots.staging, staged.dir)
    // Gate 8's answer is *not* retired with it. `check` wrote `authorship` for the
    // release it staged, `nextState` carries untouched fields through, so this is
    // the one record left on the machine saying whether what is now installed came
    // with proof of who published it. When it did not, the success is stamped with
    // the standing note rather than a clean `code: null` — a swap that cleared the
    // warning would leave the panel and `gp_diagnose` reporting a plain "up to
    // date" about an unproven release.
    const standing = authorshipNote(state.authorship, 'applied')
    const swapped = `updated ${baseline} -> ${wantVersion}`
    // §11.4: a swap that did not move the updater's own copy stays a *stated* degradation, exactly the
    // way an unproven authorship does. Cleaning it to `code: null` would let the panel say "up to date"
    // about an install whose daily job is still running the code that failed to update itself.
    const runtimeNote = runtimeStalled
      ? `the update installed, but the updater itself did not move (${runtime?.detail ?? 'no reason recorded'}): re-run the GlassPane installer to put the new updater in place`
      : runtime?.status === 'kept'
        ? 'automatic update is switched off here, so no job was registered; the updater code and pointer did move'
        : runtime?.status === 'skipped'
          // A owed registration has to reach the sentence, not only the state file: the person reading
          // `updater apply`'s answer is the only one who can do the step, and a clean "applied" with no
          // mention of it is how a pending thing stays pending forever. The wording says one time,
          // because with the stable entry that is literally true — this is the last version that asks.
          ? 'the updater code, the pointer, and the stable entry all moved, but the registered job still names its own path, so this machine owes one migration: flip "automatic update" off and on once (or run "updater enable"); after that single step, no future version needs it'
          : null
    // The document the applied patch merges onto is re-read here and nowhere else in this function:
    // this is the one write that runs after another process (`enable`) may have written the file.
    const base = freshestBase(handoverNotes)
    const message = [swapped + (standing ? `. ${standing.message}` : ''), runtimeNote, ...handoverNotes].filter(Boolean).join('. ')
    // §9: a swap replaces the very bundles the agent runs from, so the root bundle
    // node is handed has to be re-exported with it. Without this, a rotated
    // interception root turns the daily job dead under an install that just
    // succeeded, and "applied" is the last honest thing the state file says.
    const caRoots = refreshCa ? refreshCa() : base.caRoots ?? null
    const code = standing?.code ?? (runtimeStalled ? CODES.runtimeStale : null)
    const saved = stampOnto(base, {
      status: 'applied',
      code,
      message: code !== null || handoverNotes.length > 0 ? message : null,
      current: wantVersion,
      latest: base.latest,
      staged: null,
      caRoots,
      runtime,
      lastError: null,
      // The digest of *this* run's offer, read before the swap: `base.staged` belongs to whatever the
      // handover child left behind, and a history row has to name what was actually put in.
      historyEntry: { action: 'apply', result: 'applied', digest: appliedDigest, code },
    })
    return {
      ok: true,
      status: 'applied',
      code,
      message,
      state: saved,
      runtime,
      rollback: { ok: true, performed: false },
      backup: { dir: backup.dir, marker: backup.marker },
    }
  } catch (error) {
    const what = `${error?.code ? error.code + ': ' : ''}${error?.message ?? String(error)}`
    let restored = null
    let restoreNote = null
    try {
      restored = restoreBackup({ backupDir: backup.dir, appsDir, bundles, copyFn })
    } catch (restoreError) {
      restored = { ok: false, message: `the restore itself threw (${restoreError.message})` }
      restoreNote = `restoreBackup threw: ${restoreError.stack ?? restoreError.message}`
    }
    /**
     * §11 ran, and this throw came after it. Restoring the two bundles is only half the machine going
     * back: the pointer and the loaded job were handed to the new copy by that step, so without this the
     * record would read "`baseline` restored and verified" while `update-install.json` names the version
     * that was just rolled out of `~/Applications`. Undoing it is best effort, and its own failure is
     * put into the sentence rather than into a second throw.
     */
    let undo = null
    if (handoverRan && runtime && runtime.status !== 'failed') {
      try {
        undo = await undoHandoverImpl({
          stateRoot,
          previousPointer: pointerBefore,
          version: wantVersion,
          env,
          readRunningJob: readRunningJobImpl,
          handover: handoverMode,
          disabled: autoDisabled === true || state.disabled === true,
          ...(runEnableImpl === undefined ? {} : { runEnable: runEnableImpl }),
          now: () => now,
        })
      } catch (undoError) {
        undo = {
          ok: false,
          record: {
            status: 'failed',
            version: String(wantVersion),
            cliPath: null,
            previousCliPath: runtime.previousCliPath ?? null,
            agentVerified: false,
            at: now.toISOString(),
            code: CODES.runtimeStale,
            detail: `putting the updater back after the rollback threw (${undoError?.message ?? String(undoError)}): the pointer may still name the version that was rolled out, so re-run the GlassPane installer`,
          },
        }
      }
    }
    const status = restored.ok ? 'rolled-back' : 'rollback-failed'
    // The same re-read as the success path, and only when the handover ran: a throw that lands here
    // *after* §11 means the new copy already wrote its own row, and merging onto this run's read would
    // delete it while the record says the machine went back.
    const failedBase = handoverRan ? freshestBase(handoverNotes) : state
    const undoLine = undo ? ` ${undo.record.detail}.` : ''
    const message = [`the new bundles were already installed when "${what}" failed; ${baseline} was ${restored.ok ? 'restored and verified' : `NOT restorable (${restored.message}) — re-run the GlassPane installer to put ${appsDir} back`}.${undoLine}${handoverNotes.length ? ` ${handoverNotes.join('. ')}` : ''}`]
      .filter(Boolean)
      .join('')
      .trim()
    // A record this machine cannot accept is not a reason to throw away the answer: the bundles *did*
    // change, and an exception escaping here would reach `cli.js`'s generic handler and print exit 3
    // ("nothing changed") about a machine that was just rolled back.
    let saved = null
    let writeFailure = null
    try {
      saved = stampOnto(failedBase, {
        status,
        code: CODES.postSwapFailed,
        message,
        details: { stage: 'post-swap', error: what, ...(restoreNote ? { restoreNote } : {}) },
        ...(restored.ok ? { current: baseline } : {}),
        ...(undo ? { runtime: undo.record } : {}),
        historyEntry: { action: 'rollback', result: status, digest: appliedDigest, code: CODES.postSwapFailed },
      })
    } catch (writeError) {
      writeFailure = `update-state.json could not be written after the rollback (${writeError?.message ?? String(writeError)}): read "updater status" again once the disk is writable, and treat ${baseline} as the version on disk`
    }
    return {
      ok: false,
      status,
      code: CODES.postSwapFailed,
      message: writeFailure ? `${message} ${writeFailure}` : message,
      state: saved,
      runtime: undo?.record ?? runtime ?? null,
      rollback: { ok: restored.ok === true, performed: true, reason: restored.message ?? null },
      error: what,
    }
  }
}

/**
 * The clause every post-swap outcome appends about the restart: §2 can honestly
 * forbid a restart the caller expected, and "it was not restarted" has to be in
 * the sentence the panel shows rather than only in a return field.
 */
function restartLine(restart, done = 'the daemon was restarted') {
  if (!restart) return ''
  if (restart.restarted) return `, and ${done}`
  return `, but the daemon was NOT restarted because it no longer answered the idle probe (${restart.reason}); restart it when GlassPane is idle`
}

/** What a non-upgrade staged tree means, in the sentence the panel shows. */
function describeKind(kind, wantVersion, baseline) {
  if (kind === 'none') {
    return `the staged version ${wantVersion} is the version this machine already runs, so applying it would only churn the install`
  }
  return `the staged version ${wantVersion} is older than the ${baseline} installed here, so applying it would downgrade this machine`
}

/**
 * `updater rollback`: put the newest verified backup back and prove the daemon
 * reports the version it holds. Used by the panel's "restore previous version".
 */
export async function rollbackToBackup({
  stateRoot,
  appsDir,
  bundles = DEFAULT_BUNDLES,
  backupDir = null,
  socketPath = null,
  now = new Date(),
  copyFn = defaultCopy,
  kickstart = kickstartJob,
  helloCall = socketCall,
  toolsList = mcpToolsList,
  probe = probeIdle,
} = {}) {
  const roots = writableRoots(stateRoot)
  const { state } = loadState(stateRoot)
  const dir = backupDir ?? newestBackup(roots.backup)
  if (!dir) {
    return { ok: false, status: 'deferred', code: CODES.backupFailed, message: `no backup under ${roots.backup}: nothing to roll back to` }
  }
  let marker = null
  try {
    marker = JSON.parse(fs.readFileSync(path.join(dir, 'backup-marker.json'), 'utf8'))
  } catch {
    return { ok: false, status: 'deferred', code: CODES.backupFailed, message: `${dir} carries no readable backup-marker.json, so it is not a backup this tool made` }
  }
  // Same §2 rule as apply: never restart a daemon that might be mid-action.
  const verdict = await probe({ socketPath })
  if (!verdict.answered) {
    return { ok: false, status: 'deferred', code: CODES.busyOrUnreachable, message: `the daemon did not answer the idle probe (${verdict.reason}), so it was not restarted and nothing was rolled back` }
  }
  const restored = restoreBackup({ backupDir: dir, appsDir, bundles, copyFn })
  if (!restored.ok) {
    const saved = nextState(state, {
      status: 'rollback-failed',
      code: CODES.rollbackFailed,
      message: `${restored.message}: re-run the GlassPane installer to put a working version back into ${appsDir}`,
      historyEntry: { at: now.toISOString(), action: 'rollback', result: 'rollback-failed', digest: null, code: CODES.rollbackFailed },
    }, { now })
    saveState(stateRoot, saved, { now })
    return { ok: false, status: 'rollback-failed', code: CODES.rollbackFailed, message: saved.lastError.message, state: saved }
  }
  /**
   * §2 holds for this restart too: the probe above was answered before the
   * restore walked two bundles back into `appsDir`, which is time. A second
   * probe answers here or `kickstart` is not called.
   */
  const restartAfterRestore = async () => {
    const again = await probe({ socketPath })
    if (again?.answered !== true) return { restarted: false, reason: again?.reason ?? 'the idle probe answered nothing' }
    try {
      await kickstart({})
      return { restarted: true, reason: null }
    } catch (error) {
      return { restarted: false, reason: `launchctl kickstart failed (${error.message})` }
    }
  }
  const restart = await restartAfterRestore()
  const wantVersion = marker.version ?? null
  const handshake = restart.restarted
    ? (wantVersion
      ? await handshakeVerify({ socketPath, wantVersion, call: helloCall, toolsList })
      : { ok: false, message: 'the backup marker names no version' })
    : { ok: false, message: `the daemon was not restarted (${restart.reason}), so the version it is running was not read back` }
  /**
   * The two outcomes are different answers, and they were the same word: an
   * unverified manual rollback still reached the panel as `rolled-back` / exit 4,
   * i.e. "back on the previous version", when nothing on this machine proves
   * that. §7 reserves 5 for "a person is required", which is exactly what an
   * unproven rollback is. Reverse mutation: write
   * `handshake.ok ? 'rolled-back' : 'rolled-back'` again —
   * `a manual rollback nobody could verify answers 5, not 4` goes red.
   */
  const status = handshake.ok ? 'rolled-back' : 'rollback-failed'
  const saved = nextState(
    state,
    {
      status,
      code: handshake.ok ? null : CODES.handshakeFailed,
      current: wantVersion,
      staged: null,
      historyEntry: { at: now.toISOString(), action: 'rollback', result: handshake.ok ? 'rolled-back' : 'rolled-back-unverified', digest: null, code: handshake.ok ? null : CODES.handshakeFailed },
    },
    { now },
  )
  saveState(stateRoot, saved, { now })
  return {
    ok: handshake.ok,
    status,
    code: handshake.ok ? null : CODES.handshakeFailed,
    message: handshake.ok
      ? `restored ${wantVersion} from ${dir} and the daemon reports it`
      : `restored ${wantVersion} from ${dir} on disk and verified the files, but the running daemon did not confirm it: ${handshake.message}. Restart it when GlassPane is idle ("updater rollback" again), and if it still does not report ${wantVersion} re-run the GlassPane installer`,
    state: saved,
    rollback: { ok: true, performed: true },
    restart,
  }
}

/** Newest backup directory that carries a marker. */
export function newestBackup(backupRoot) {
  if (!fs.existsSync(backupRoot)) return null
  const dirs = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(backupRoot, entry.name, 'backup-marker.json')))
    .map((entry) => entry.name)
    .sort()
  return dirs.length ? path.join(backupRoot, dirs[dirs.length - 1]) : null
}

export { foreignStateDir }
