/**
 * §6 row "握手不符即回滚" (§3's backup / swap / handshake / rollback sequence).
 *
 * REVERSE MUTATION: delete the `restoreBackup(...)` call on the failed-handshake
 * path — `a daemon that does not report the new version is rolled back, and the
 * exit code says 4` goes red: the new binary stays in place, the status is not
 * `rolled-back`, and `exitCodeFor` answers 5 instead of 4.
 * Second mutation: publish `current` right after the swap instead of only after
 * a full success — `a failed handshake leaves the recorded current version
 * alone` goes red.
 *
 * The backup/swap/restore half is real filesystem work against a temp `appsDir`
 * (dependency-injected, so this suite can never write into ~/Applications); the
 * version read-back goes through a real unix socket; `tools/list` through a real
 * child process speaking MCP over stdio.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CODES, EXIT, exitCodeFor } from '../lib/codes.js'
import { refreshRuntime } from '../lib/runtime.js'
import { AGENT_LABEL } from '../lib/launchd.js'
import { readPointer, writePointer } from '../lib/state.js'
import {
  BACKUP_MANIFEST_NAME,
  applyUpdate,
  backupBundles,
  buildStagedTree,
  handshakeVerify,
  installNpmPackages,
  manifestTree,
  newestBackup,
  restoreBackup,
  rollbackToBackup,
  snapshotDir,
} from '../lib/apply.js'
import { mcpToolsList } from '../lib/mcp.js'
import { emptyState, loadState, nextState, saveState, updateSummary } from '../lib/state.js'
import { writableRoots } from '../lib/fsutil.js'
import { fakeMcpPeer, makeDaemonBinary, makeFakeApp, removeDir, shortSocketPath, startSocketDaemon, tempDir, TMP_PREFIX } from './helpers.mjs'

const NOW = new Date('2026-09-27T12:00:00.000Z')
const BUNDLES = [
  { name: 'GlassPane.app', executable: path.join('Contents', 'MacOS', 'GlassPane Settings') },
  { name: 'GlassPane Daemon.app', executable: path.join('Contents', 'MacOS', 'glasspaned') },
]
const MCP_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-stub.mjs')

const daemonBinary = (appsDir) => path.join(appsDir, 'GlassPane Daemon.app', 'Contents', 'MacOS', 'binary')

/** A machine with 1.4.0 installed and 1.4.1 staged, all under a temp directory. */
function fixture(label, { staged = true, currentVersion = '1.4.0', stagedVersion = '1.4.1' } = {}) {
  const dir = tempDir(`${TMP_PREFIX}apply-${label}-`)
  const appsDir = path.join(dir, 'Applications')
  makeFakeApp(appsDir, 'GlassPane.app', currentVersion, { marker: 'installed' })
  makeFakeApp(appsDir, 'GlassPane Daemon.app', currentVersion, { marker: 'installed' })
  const daemonBin = makeDaemonBinary(appsDir, currentVersion)

  const stagingDir = path.join(writableRoots(dir).staging, stagedVersion)
  const treePath = path.join(stagingDir, 'tree')
  fs.mkdirSync(treePath, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(treePath, 'package.json'), JSON.stringify({ version: stagedVersion }))

  const builtDir = path.join(dir, 'built')
  for (const bundle of BUNDLES) makeFakeApp(builtDir, bundle.name, stagedVersion, { marker: 'NEW' })

  saveState(dir, nextState(emptyState({ now: NOW }), {
    status: staged ? 'staged' : 'up-to-date',
    code: null,
    current: currentVersion,
    latest: stagedVersion,
    lastCheckAt: NOW.toISOString(),
    staged: staged ? { version: stagedVersion, dir: stagingDir, digest: 'd'.repeat(64), at: NOW.toISOString() } : null,
  }, { now: NOW }), { now: NOW })

  return {
    dir,
    stateRoot: dir,
    appsDir,
    daemonBin,
    treePath,
    builtDir,
    stagingDir,
    installedBytes: () => fs.readFileSync(daemonBinary(appsDir), 'utf8'),
    cleanup: () => removeDir(dir),
  }
}

const okBuild = (builtDir) => () => ({ ok: true, builtDir, message: null })
const okNpm = () => ({ ok: true, code: null, message: null, packed: [], original: { 'glasspane-mcp': '1.4.0', 'glasspane-install': '1.4.0' } })
const okTools = async () => ({ ok: true, count: 16, tools: ['gp_probe_status'] })
const okKick = async () => {
  const calls = []
  return { calls, fn: async (opts) => { calls.push(opts); return { ok: true, message: 'restarted' } } }
}

/**
 * §11's step is injected here so these tests keep measuring what they were written to measure (the
 * backup → swap → handshake → publish order). The real `refreshRuntime` gets its own file
 * (`runtime.test.mjs`) plus `a swap also moves the updater's own copy` below, which drives the real
 * sequencing with only the two external facts (spawn, launchctl) replaced.
 */
function refreshedRuntime(version) {
  return () => ({
    record: {
      status: 'refreshed',
      version,
      cliPath: '/var/tmp/st/runtime/' + version + '/updater/cli.js',
      previousCliPath: '/var/tmp/st/updater/cli.js',
      agentVerified: true,
      at: NOW.toISOString(),
      code: null,
      detail: null,
    },
    restored: { attempted: false, ok: true },
  })
}

test('a successful apply backs up, swaps, and only then publishes the new current', async () => {
  const fx = fixture('happy')
  const kick = await okKick()
  const socketPath = shortSocketPath(fx.dir, 'ok.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 1_000 },
      job: { ok: true, args: ['glasspaned', '--socket-path', socketPath] },
      build: okBuild(fx.builtDir),
      kickstart: kick.fn,
      toolsList: okTools,
      npm: okNpm,
      refreshRuntimeImpl: refreshedRuntime('1.4.1'),
    })
    assert.equal(result.status, 'applied', result.message)
    assert.equal(result.code, null)
    assert.equal(result.runtime.status, 'refreshed', JSON.stringify(result.runtime))
    assert.equal(exitCodeFor(result), EXIT.OK)
    assert.match(fx.installedBytes(), /NEW/)
    const state = loadState(fx.stateRoot).state
    assert.equal(state.current, '1.4.1')
    assert.equal(state.status, 'applied')
    assert.equal(state.staged, null)
    assert.ok(!fs.existsSync(fx.stagingDir), 'the staged tree is retired after a successful swap')
    assert.equal(loadState(fx.stateRoot).state.runtime.status, 'refreshed', '记录必须落进状态文件，面板才看得见')
    assert.equal(kick.calls.length, 1, 'exactly one restart')
    const backup = newestBackup(writableRoots(fx.stateRoot).backup)
    assert.ok(backup, 'a backup exists under <stateRoot>/update-backup')
    const marker = JSON.parse(fs.readFileSync(path.join(backup, 'backup-marker.json'), 'utf8'))
    assert.equal(marker.version, '1.4.0')
    assert.equal(marker.targetVersion, '1.4.1')
    assert.deepEqual(marker.bundles.map((b) => b.name), BUNDLES.map((b) => b.name))
    assert.equal(fs.statSync(backup).mode & 0o777, 0o700, 'a backup holds another user\'s whole install: owner-only')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

/**
 * §1 gate 8's record has to outlive the thing it describes. `staged` is cleared by
 * a successful swap, so without `authorship` the machine would be left holding an
 * `applied` row that reads exactly like the one for a signed release — and the one
 * surface that quotes freshness to an agent (`gp_diagnose`) prints `lastError`, so
 * clearing `code` on success would delete the sentence "this was installed without
 * proof of who published it".
 *
 * REVERSE MUTATION: hard-code the success stamp to `code: null` (the previous
 * shape) — the first test below goes red on both the record and the sentence; stamp
 * the note unconditionally instead, and the *second* test goes red, because a
 * verified release would start carrying a warning that never happened.
 */
async function applyWithAuthorship(label, authorship) {
  const fx = fixture(label)
  const kick = await okKick()
  const socketPath = shortSocketPath(fx.dir, 'ok.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  try {
    if (authorship !== null) {
      const seeded = loadState(fx.stateRoot).state
      saveState(fx.stateRoot, nextState(seeded, { authorship }, { now: NOW }), { now: NOW })
    }
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 1_000 },
      job: { ok: true, args: ['glasspaned', '--socket-path', socketPath] },
      build: okBuild(fx.builtDir),
      kickstart: kick.fn,
      toolsList: okTools,
      npm: okNpm,
      refreshRuntimeImpl: refreshedRuntime('1.4.1'),
    })
    return { result, state: loadState(fx.stateRoot).state }
  } finally {
    await daemon.close()
    fx.cleanup()
  }
}

test('a swap whose release had no authorship proof still says so after it is installed', async () => {
  const { result, state } = await applyWithAuthorship('applied-unsigned', {
    version: '1.4.1',
    signature: 'unsigned-release',
    signedAsset: null,
    keyFingerprint: null,
    consented: true,
    at: NOW.toISOString(),
  })
  assert.equal(result.status, 'applied', result.message)
  assert.equal(exitCodeFor(result), EXIT.OK, 'the warning is a sentence, not a refusal: the swap did happen')
  assert.match(result.message, /without authorship proof/, 'the human running apply hears it in this run, not only later')
  assert.equal(state.staged, null, 'the offer is retired…')
  assert.equal(state.authorship.signature, 'unsigned-release', '…the proof gap is not: it is the only record left')
  assert.equal(state.code, CODES.releaseUnsigned)
  assert.equal(state.lastError.code, CODES.releaseUnsigned)
  assert.match(state.lastError.message, /was applied without authorship proof/)
  assert.match(state.lastError.message, /--consent unsigned-release/)
  assert.equal(updateSummary(state).authorship, 'unsigned-release', 'gp_diagnose reads the summary, so it has to be in it')
})

test('a swap of a release that verified against the embedded key stays a clean success', async () => {
  const { result, state } = await applyWithAuthorship('applied-verified', {
    version: '1.4.1',
    signature: 'verified',
    signedAsset: 'SHA256SUMS-1.4.1.txt.asc',
    keyFingerprint: '09'.repeat(20),
    consented: false,
    at: NOW.toISOString(),
  })
  assert.equal(result.status, 'applied', result.message)
  assert.equal(result.code, null, 'a proven release must not be warned about, or the warning stops meaning anything')
  assert.equal(state.code, null)
  assert.equal(state.lastError, null)
  assert.equal(state.authorship.signature, 'verified', 'the positive record is what stays')
  assert.equal(updateSummary(state).authorshipConsented, false)
})

test('a daemon that does not report the new version is rolled back, and the exit code says 4', async () => {
  const fx = fixture('handshake')
  const kick = await okKick()
  // The socket answers — with the OLD version. That is precisely "the files were
  // swapped but the running daemon did not change".
  const socketPath = shortSocketPath(fx.dir, 'stale.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500, handshakeBudgetMs: 400 },
      job: { ok: true, args: [] },
      build: okBuild(fx.builtDir),
      kickstart: kick.fn,
      toolsList: okTools,
      npm: okNpm,
    })
    assert.equal(result.status, 'rolled-back', result.message)
    assert.equal(result.code, CODES.rolledBack)
    assert.equal(exitCodeFor(result), EXIT.ROLLED_BACK, 'spec 7: swapped + bad handshake + successful rollback = 4')
    assert.equal(result.rollback.ok, true)
    assert.equal(result.rollback.performed, true)
    assert.match(fx.installedBytes(), /installed/, 'the backup went back in')
    assert.doesNotMatch(fx.installedBytes(), /NEW/)
    assert.match(result.message, /does not report 1\.4\.1/)
    assert.equal(kick.calls.length, 2, 'the daemon was restarted again after the restore')
    assert.equal(loadState(fx.stateRoot).state.status, 'rolled-back')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a failed handshake leaves the recorded current version alone', async () => {
  const fx = fixture('current')
  const socketPath = shortSocketPath(fx.dir, 'stale2.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500, handshakeBudgetMs: 300 },
      job: { ok: true, args: [] },
      build: okBuild(fx.builtDir),
      kickstart: async () => ({ ok: true }),
      toolsList: okTools,
      npm: okNpm,
    })
    assert.equal(result.status, 'rolled-back')
    const state = loadState(fx.stateRoot).state
    assert.equal(state.current, '1.4.0', 'current moves only on a full success')
    assert.equal(state.status, 'rolled-back')
    assert.equal(state.lastError.code, CODES.rolledBack)
    assert.equal(state.history.at(-1).action, 'rollback')
    assert.equal(state.history.at(-1).digest, 'd'.repeat(12), 'history stores the leading 12 digest characters')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a busy daemon means nothing is swapped, nothing is built, nothing is restarted', async () => {
  const fx = fixture('busy')
  const kick = await okKick()
  const socketPath = shortSocketPath(fx.dir, 'busy.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'silence' })
  let buildCalls = 0
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 300 },
      job: { ok: true, args: [] },
      build: () => {
        buildCalls += 1
        return { ok: true, builtDir: fx.builtDir }
      },
      kickstart: kick.fn,
      npm: okNpm,
    })
    assert.equal(result.status, 'deferred')
    assert.equal(result.code, CODES.busyOrUnreachable)
    assert.equal(exitCodeFor(result), EXIT.REFUSED)
    assert.equal(buildCalls, 0, 'the refusal comes before any work')
    assert.equal(kick.calls.length, 0, 'a daemon that did not answer is never kickstarted')
    assert.match(fx.installedBytes(), /installed/)
    assert.ok(!fs.existsSync(writableRoots(fx.stateRoot).backup), 'no backup was made because nothing was about to change')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a build failure leaves the installed bundles untouched (staged-build-failed)', async () => {
  const fx = fixture('buildfail')
  const kick = await okKick()
  const socketPath = shortSocketPath(fx.dir, 'bf.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  try {
    const before = snapshotDir(fx.appsDir)
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500 },
      job: { ok: true, args: [] },
      build: () => ({ ok: false, builtDir: null, message: 'swift build -c release exited 1: error: cannot find type' }),
      kickstart: kick.fn,
      npm: okNpm,
    })
    assert.equal(result.status, 'staged-build-failed')
    assert.equal(result.code, CODES.stagedBuildFailed)
    assert.equal(exitCodeFor(result), EXIT.REFUSED, 'the live install never changed, so this is not the "human needed" band')
    assert.deepEqual(snapshotDir(fx.appsDir), before)
    assert.equal(kick.calls.length, 0)
    assert.match(result.message, /the installed 1\.4\.0 is still in place/)
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a backup that cannot be verified stops the swap', async () => {
  const fx = fixture('backupfail')
  const socketPath = shortSocketPath(fx.dir, 'bk.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  let buildCalls = 0
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500 },
      job: { ok: true, args: [] },
      build: () => {
        buildCalls += 1
        return { ok: true, builtDir: fx.builtDir }
      },
      // A copy that silently drops one file: the snapshot comparison must catch it.
      copyFn: (source, target) => {
        fs.cpSync(source, target, { recursive: true })
        if (target.includes('update-backup') && target.endsWith('GlassPane.app')) {
          fs.rmSync(path.join(target, 'Contents', 'Info.plist'), { force: true })
        }
      },
      kickstart: async () => ({ ok: true }),
      npm: okNpm,
    })
    assert.equal(result.status, 'apply-failed')
    assert.equal(result.code, CODES.backupFailed)
    assert.equal(buildCalls, 0, 'the build never starts: the backup gate is first')
    assert.match(result.message, /does not match what is installed/)
    assert.match(result.message, /the installed version 1\.4\.0 is untouched/)
    assert.equal(exitCodeFor(result), EXIT.REFUSED)
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a restore that cannot be verified is the one outcome that demands a person (exit 5)', async () => {
  const fx = fixture('rollbackfail')
  const socketPath = shortSocketPath(fx.dir, 'rf.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500, handshakeBudgetMs: 300 },
      job: { ok: true, args: [] },
      build: okBuild(fx.builtDir),
      kickstart: async () => ({ ok: true }),
      toolsList: okTools,
      npm: okNpm,
      copyFn: (source, target) => {
        if (source.includes('update-backup')) {
          // The volume refuses to give the bundle back: the restore lands wrong.
          fs.rmSync(target, { recursive: true, force: true })
          fs.mkdirSync(target, { recursive: true })
          fs.writeFileSync(path.join(target, 'CORRUPT'), 'restore did not land')
          return
        }
        fs.cpSync(source, target, { recursive: true })
      },
    })
    assert.equal(result.status, 'rollback-failed', result.message)
    assert.equal(result.code, CODES.rollbackFailed)
    assert.equal(exitCodeFor(result), EXIT.ROLLBACK_FAILED, 'spec 7: swap failed AND rollback did not = 5')
    assert.equal(result.rollback.ok, false)
    assert.match(result.message, /re-run the GlassPane installer/i)
    assert.equal(loadState(fx.stateRoot).state.status, 'rollback-failed')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('the major gate refuses before anything is swapped', async () => {
  const fx = fixture('major', { stagedVersion: '2.0.0' })
  const socketPath = shortSocketPath(fx.dir, 'major.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  let buildCalls = 0
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500 },
      job: { ok: true, args: [] },
      build: () => {
        buildCalls += 1
        return { ok: true, builtDir: fx.builtDir }
      },
      kickstart: async () => ({ ok: true }),
      npm: okNpm,
    })
    assert.equal(result.status, 'needs-consent')
    assert.equal(result.code, CODES.consentRequired)
    assert.equal(exitCodeFor(result), EXIT.REFUSED)
    assert.equal(buildCalls, 0)
    assert.match(fx.installedBytes(), /installed/)
    assert.match(result.message, /major upgrade/)
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('the scheduled run refuses when automatic update is off; a manual one proceeds', async () => {
  const fx = fixture('autoswitch')
  const socketPath = shortSocketPath(fx.dir, 'auto.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  try {
    saveState(fx.stateRoot, nextState(loadState(fx.stateRoot).state, { disabled: true, autoApply: false }, { now: NOW }), { now: NOW })
    const common = {
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500 },
      job: { ok: true, args: [] },
      build: okBuild(fx.builtDir),
      kickstart: async () => ({ ok: true }),
      toolsList: okTools,
      npm: okNpm,
    }
    const automatic = await applyUpdate({ ...common, trigger: 'auto' })
    assert.equal(automatic.status, 'deferred')
    assert.equal(automatic.code, CODES.autoDisabled)
    assert.equal(exitCodeFor(automatic), EXIT.REFUSED)
    assert.match(automatic.message, /switched off/)

    // §5: manual apply stays available while automatic update is off.
    const manual = await applyUpdate({ ...common, trigger: 'manual' })
    assert.equal(manual.status, 'applied', manual.message)
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('npm packages come from the staged tree, and a read-back mismatch rolls back', async () => {
  const fx = fixture('npm')
  const socketPath = shortSocketPath(fx.dir, 'npm.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  const packed = []
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500 },
      job: { ok: true, args: [] },
      build: okBuild(fx.builtDir),
      kickstart: async () => ({ ok: true }),
      toolsList: okTools,
      npm: ({ stagedTree }) => {
        packed.push(stagedTree)
        return { ok: false, code: CODES.npmVersionMismatch, message: 'npm ls -g reports glasspane-mcp 1.4.0 after installing 1.4.1' }
      },
    })
    assert.deepEqual(packed, [fx.treePath], 'npm pack runs inside the verified staged tree, never against the registry')
    assert.equal(result.status, 'rolled-back')
    assert.equal(result.code, CODES.npmVersionMismatch)
    assert.equal(exitCodeFor(result), EXIT.ROLLED_BACK)
    assert.match(fx.installedBytes(), /installed/)
    assert.equal(loadState(fx.stateRoot).state.current, '1.4.0')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('installNpmPackages packs the staged tree and records the versions it replaced', () => {
  const dir = tempDir(`${TMP_PREFIX}npmpack-`)
  try {
    const stagedTree = path.join(dir, 'tree')
    for (const rel of ['mcp-shell', 'installer']) {
      fs.mkdirSync(path.join(stagedTree, rel), { recursive: true })
      fs.writeFileSync(
        path.join(stagedTree, rel, 'package.json'),
        JSON.stringify({ name: rel === 'mcp-shell' ? 'glasspane-mcp' : 'glasspane-install', version: '1.4.1' }),
      )
    }
    const seen = []
    // What the global prefix holds, as a *mutable* fact: `npm install -g` is the
    // only thing that changes it, so the read-back after the install is the read
    // of a state the install really moved. A constant fake here would make the
    // gate unreachable, which is the hole this fixture used to have.
    const prefix = { 'glasspane-mcp': '1.4.0', 'glasspane-install': '1.4.0' }
    const result = installNpmPackages({
      stagedTree,
      run: (bin, args, opts) => {
        seen.push([bin, ...args])
        if (args[0] === 'pack') {
          const file = 'glasspane-pkg-1.4.1.tgz'
          fs.writeFileSync(path.join(opts.cwd, file), 'tarball bytes')
          return { status: 0, stdout: file + '\n', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      readGlobalVersion: (pkg) => prefix[pkg] ?? null,
      install: (tgz) => {
        seen.push(['install-from', tgz])
        for (const pkg of Object.keys(prefix)) prefix[pkg] = '1.4.1'
        return { ok: true, message: null }
      },
      restore: () => {
        throw new Error('the read-back matched, so nothing is being rolled back')
      },
    })
    assert.equal(result.ok, true, result.message)
    assert.deepEqual(result.original, { 'glasspane-mcp': '1.4.0', 'glasspane-install': '1.4.0' }, 'the versions replaced are recorded before anything is installed')
    assert.deepEqual(result.installed, { 'glasspane-mcp': '1.4.1', 'glasspane-install': '1.4.1' }, 'and the versions that landed are read back afterwards')
    assert.ok(seen.some(([bin, arg]) => bin === 'npm' && arg === 'pack'))
    const installs = seen.filter(([bin]) => bin === 'install-from')
    assert.equal(installs.length, 2)
    assert.ok(installs.every(([, tgz]) => tgz.startsWith(stagedTree)), 'every install names a file inside the staged tree')
    assert.ok(!seen.flat().some((arg) => String(arg).includes('registry.npmjs.org')), 'nothing is fetched from the registry')
  } finally {
    removeDir(dir)
  }
})

// REVERSE MUTATION (fix 3, lib/apply.js `installNpmPackages`): delete the
// `disagreed` comparison (return success straight after the installs). The
// read-back then has no consequence: this test's prefix still says 1.4.0, `ok`
// comes back true, no rollback is attempted, and every assertion below goes red.
// The point is §1.6's "读回不符就装回原版本" — `npm install -g` exiting 0 is not
// evidence about what is installed, and this is the gate the spec asks for.
test('the npm read-back is the gate: a version that did not land is rolled back', () => {
  const dir = tempDir(`${TMP_PREFIX}npmreadback-`)
  try {
    const stagedTree = path.join(dir, 'tree')
    for (const rel of ['mcp-shell', 'installer']) {
      fs.mkdirSync(path.join(stagedTree, rel), { recursive: true })
      fs.writeFileSync(
        path.join(stagedTree, rel, 'package.json'),
        JSON.stringify({ name: rel === 'mcp-shell' ? 'glasspane-mcp' : 'glasspane-install', version: '1.4.1' }),
      )
    }
    const prefix = { 'glasspane-mcp': '1.4.0', 'glasspane-install': '1.4.0' }
    const restored = []
    const result = installNpmPackages({
      stagedTree,
      run: (bin, args, opts) => {
        if (args[0] === 'pack') {
          const file = 'glasspane-pkg-1.4.1.tgz'
          fs.writeFileSync(path.join(opts.cwd, file), 'tarball bytes')
          return { status: 0, stdout: file + '\n', stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      // Every install "succeeds" and changes nothing: the stale 1.4.0 is still
      // what the prefix holds when it is read back.
      readGlobalVersion: (pkg) => prefix[pkg] ?? null,
      install: () => ({ ok: true, message: null }),
      restore: (pkg, version) => {
        restored.push([pkg, version])
        prefix[pkg] = version
        return { ok: true, message: null }
      },
    })
    assert.equal(result.ok, false, 'a package that did not change is a failed update, not a successful one')
    assert.equal(result.code, CODES.npmVersionMismatch)
    assert.deepEqual(result.installed, { 'glasspane-mcp': '1.4.0', 'glasspane-install': '1.4.0' })
    assert.deepEqual(result.wanted, { 'glasspane-mcp': '1.4.1', 'glasspane-install': '1.4.1' })
    assert.match(result.message, /glasspane-mcp reads back "1\.4\.0" after installing 1\.4\.1/)
    assert.deepEqual(restored, [['glasspane-mcp', '1.4.0'], ['glasspane-install', '1.4.0']], '§3.4: the recorded versions are put back')
    assert.match(result.message, /put back at the versions recorded before the install/)
  } finally {
    removeDir(dir)
  }
})

// REVERSE MUTATION (fix 3): make the unknown-original case continue (treat "we
// never recorded a version" as "nothing to roll back, carry on") — `ok` becomes
// true and the message never names the installer, so both assertions go red.
test('an npm rollback nobody can perform says so instead of answering success', () => {
  const dir = tempDir(`${TMP_PREFIX}npmnorecord-`)
  try {
    const stagedTree = path.join(dir, 'tree')
    fs.mkdirSync(path.join(stagedTree, 'mcp-shell'), { recursive: true })
    fs.writeFileSync(path.join(stagedTree, 'mcp-shell', 'package.json'), JSON.stringify({ name: 'glasspane-mcp', version: '1.4.1' }))
    const result = installNpmPackages({
      stagedTree,
      packageDirs: ['mcp-shell'],
      run: (bin, args, opts) => {
        const file = 'glasspane-mcp-1.4.1.tgz'
        fs.writeFileSync(path.join(opts.cwd, file), 'tarball bytes')
        return { status: 0, stdout: file + '\n', stderr: '' }
      },
      readGlobalVersion: () => null,
      install: () => ({ ok: true, message: null }),
      restore: () => ({ ok: true, message: null }),
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /the version this machine had before is unknown/)
    assert.equal(result.repairs[0].ok, false)
  } finally {
    removeDir(dir)
  }
})

test('a staged tree that is no longer on disk defers instead of swapping', async () => {
  const fx = fixture('missingtree')
  fs.rmSync(fx.stagingDir, { recursive: true, force: true })
  const socketPath = shortSocketPath(fx.dir, 'gone.sock')
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 200 },
      job: { ok: true, args: [] },
      build: okBuild(fx.builtDir),
      kickstart: async () => ({ ok: true }),
      npm: okNpm,
    })
    assert.equal(result.status, 'deferred')
    assert.equal(result.code, CODES.notStaged)
    assert.equal(exitCodeFor(result), EXIT.REFUSED)
    assert.match(result.message, /run "updater check" first/)
  } finally {
    fx.cleanup()
  }
})

test('rollbackToBackup restores the newest marked backup and reads the version back over a real socket', async () => {
  const fx = fixture('rollback')
  const socketPath = shortSocketPath(fx.dir, 'rb.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  try {
    const made = backupBundles({
      appsDir: fx.appsDir,
      backupRoot: writableRoots(fx.stateRoot).backup,
      bundles: BUNDLES,
      stamp: '2026-09-27T11-00-00-000Z',
      marker: { version: '1.4.0' },
    })
    for (const bundle of BUNDLES) makeFakeApp(fx.appsDir, bundle.name, '1.4.1', { marker: 'NEW' })
    const result = await rollbackToBackup({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      backupDir: made.dir,
      socketPath,
      now: NOW,
      toolsList: okTools,
    })
    assert.equal(result.status, 'rolled-back')
    assert.equal(exitCodeFor(result), EXIT.ROLLED_BACK)
    assert.match(fx.installedBytes(), /installed/)
    assert.equal(loadState(fx.stateRoot).state.current, '1.4.0')
    assert.equal(result.code, null, `the daemon really reported the restored version: ${result.message}`)
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('rollback with no backup, or a busy daemon, refuses without touching anything', async () => {
  const fx = fixture('rb-refuse')
  const socketPath = shortSocketPath(fx.dir, 'rb2.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'silence' })
  try {
    const nothing = await rollbackToBackup({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      socketPath,
      now: NOW,
      probe: async () => ({ answered: true }),
    })
    assert.equal(nothing.status, 'deferred')
    assert.equal(nothing.code, CODES.backupFailed)
    assert.match(nothing.message, /nothing to roll back to/)

    const made = backupBundles({
      appsDir: fx.appsDir,
      backupRoot: writableRoots(fx.stateRoot).backup,
      bundles: BUNDLES,
      marker: { version: '1.4.0' },
    })
    const busy = await rollbackToBackup({ stateRoot: fx.stateRoot, appsDir: fx.appsDir, bundles: BUNDLES, backupDir: made.dir, socketPath, now: NOW })
    assert.equal(busy.status, 'deferred')
    assert.equal(busy.code, CODES.busyOrUnreachable)
    assert.match(busy.message, /was not restarted and nothing was rolled back/)
    assert.match(fx.installedBytes(), /installed/)
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('restoreBackup reports which bundle did not come back', () => {
  const fx = fixture('restore-detail')
  try {
    const made = backupBundles({
      appsDir: fx.appsDir,
      backupRoot: writableRoots(fx.stateRoot).backup,
      bundles: BUNDLES,
      marker: { version: '1.4.0' },
    })
    fs.rmSync(path.join(made.dir, 'GlassPane.app', 'Contents', 'Info.plist'))
    const outcome = restoreBackup({ backupDir: made.dir, appsDir: fx.appsDir, bundles: BUNDLES })
    assert.equal(outcome.ok, false)
    assert.match(outcome.message, /GlassPane\.app read back different/)
  } finally {
    fx.cleanup()
  }
})

test('handshakeVerify needs both the socket version and a working tools/list, over real processes', async () => {
  const fx = fixture('handshake2')
  const socketPath = shortSocketPath(fx.dir, 'h1.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  // The ONE test here that boots a real child, because a real pipe is part of the
  // contract (framing over an OS pipe, not just an EventEmitter). Its budgets are
  // minutes: measured on 2026-09-27 a `node` child took 5.7–11.1 s to answer under
  // load average 223, and a 400 ms allowance measures the scheduler, not the code.
  // The verdicts stay logical — 'never answers' never answers however long we wait.
  const liveTools = () => mcpToolsList({ command: process.execPath, args: [MCP_FIXTURE, 'answer'], timeoutMs: 90_000 })
  try {
    const both = await handshakeVerify({
      socketPath,
      wantVersion: '1.4.1',
      budgetMs: 120_000,
      pollMs: 100,
      toolsList: liveTools,
    })
    assert.equal(both.ok, true, both.message)
    assert.match(both.seen.mcp, /16 tools/)

    // The MCP layer answers nothing: tools/list unavailable means "not verified".
    const dead = await handshakeVerify({
      socketPath,
      wantVersion: '1.4.1',
      budgetMs: 30_000,
      pollMs: 100,
      toolsList: () => mcpToolsList({ command: process.execPath, args: [MCP_FIXTURE, 'silence'], timeoutMs: 5_000 }),
    })
    assert.equal(dead.ok, false)
    assert.match(dead.message, /unavailable/)

    // A server that answers tools/list with garbage frames.
    const garbage = await mcpToolsList({ command: process.execPath, args: [MCP_FIXTURE, 'garbage'], timeoutMs: 90_000 })
    assert.equal(garbage.ok, false)
    assert.match(garbage.reason, /non-JSON line/)

    // Right tools, wrong version on the socket.
    const wrong = await handshakeVerify({ socketPath, wantVersion: '9.9.9', budgetMs: 120_000, pollMs: 100, toolsList: liveTools })
    assert.equal(wrong.ok, false)
    assert.match(wrong.message, /hello said "1\.4\.1"/)
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('the build step names the two commands the project uses and refuses when a bundle is missing', () => {
  const dir = tempDir(`${TMP_PREFIX}build-`)
  try {
    const staged = path.join(dir, 'tree')
    fs.mkdirSync(path.join(staged, 'engine', 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(staged, 'engine', 'scripts', 'make-app.sh'), '#!/bin/sh\nexit 0\n')
    const calls = []
    const outcome = buildStagedTree(staged, {
      run: (bin, args) => {
        calls.push([bin, ...args])
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    assert.deepEqual(calls[0], ['swift', 'build', '-c', 'release', '--package-path', path.join(staged, 'engine')])
    assert.equal(calls[1][0], '/bin/sh')
    assert.match(calls[1][1], /make-app\.sh$/)
    assert.equal(outcome.ok, false, 'no .app in .build/release is a failed build, not a success')
    assert.match(outcome.message, /is not in/)

    const failing = buildStagedTree(staged, { run: () => ({ status: 1, stdout: '', stderr: 'error: emit-module command failed' }) })
    assert.equal(failing.ok, false)
    assert.match(failing.message, /emit-module command failed/)

    const noEngine = buildStagedTree(dir, { run: () => ({ status: 0, stdout: '', stderr: '' }) })
    assert.equal(noEngine.ok, false)
    assert.match(noEngine.message, /has no engine/)
  } finally {
    removeDir(dir)
  }
})

/* --------------------------------------------------------------------------
 * The four gaps closed after the first pass: `lastError` publication (spec §4),
 * the exit-5 sentence, content-level backup/restore verification (§3.1/§3.3),
 * and a handshake that requires *both* readings (§3.3). Each block names the
 * mutation that reddens it.
 * ------------------------------------------------------------------------ */

/** Same length, different bytes: the case a length-only comparison lets through. */
function flipOneByte(file) {
  const bytes = fs.readFileSync(file)
  bytes[0] = bytes[0] === 0x41 ? 0x42 : 0x41
  fs.writeFileSync(file, bytes)
}

// REVERSE MUTATION (fix 1, lib/state.js `nextState`): delete the `else if ('code' in
// source)` branch so only an explicit `error` fills `lastError` — the three
// `lastError` assertions below read `null` and go red, and so does
// `a rolled-back apply writes both versions into lastError`. Second mutation: spread
// the whole patch instead of filtering it through the shipped schema's field list —
// `saveState` then refuses with "property message is not allowed by the schema".
test('a stamped code publishes lastError, and no non-field of the patch reaches the document', () => {
  const dir = tempDir(`${TMP_PREFIX}lasterror-`)
  try {
    const bare = nextState(emptyState({ now: NOW }), { status: 'rollback-failed', code: CODES.rollbackFailed }, { now: NOW })
    assert.equal(bare.code, CODES.rollbackFailed)
    assert.equal(bare.lastError.code, CODES.rollbackFailed, 'spec 4: every refusal carries lastError, because the panel prints it verbatim')
    assert.match(bare.lastError.message, /rollback-failed/, 'with no caller sentence the record still says what stopped')
    assert.equal(bare.lastError.at, NOW.toISOString())

    const worded = nextState(emptyState({ now: NOW }), {
      status: 'apply-failed',
      code: CODES.swapFailed,
      message: 'the daemon answered 1.4.0 after the swap; 1.3.9 was restored and verified',
      details: { probe: 'busy-or-unreachable' },
      historyEntry: { action: 'apply', result: 'apply-failed', digest: null, code: CODES.swapFailed },
    }, { now: NOW })
    assert.equal(worded.lastError.message, 'the daemon answered 1.4.0 after the swap; 1.3.9 was restored and verified', "the caller's sentence, not a paraphrase of it")
    assert.equal(worded.lastError.details, JSON.stringify({ probe: 'busy-or-unreachable' }))
    for (const key of ['message', 'details', 'historyEntry', 'error']) {
      assert.ok(!(key in worded), `${key} is an instruction to nextState, not a field of the state document`)
    }
    saveState(dir, worded, { now: NOW })
    assert.equal(loadState(dir).state.lastError.code, CODES.swapFailed, 'it survives the schema and the round trip')

    assert.equal(nextState(worded, { status: 'applied', code: null }, { now: NOW }).lastError, null, 'a success clears the standing reason')
    assert.equal(nextState(worded, { status: 'disabled', disabled: true }, { now: NOW }).lastError.code, CODES.swapFailed, 'a patch that stamps no code leaves the standing reason alone')
    // REVERSE MUTATION: delete the "a patch that only refines the wording" branch of
    // nextState — the new sentence never reaches the record, so this reads the old one.
    const reworded = nextState(worded, { status: 'apply-failed', message: 'a clearer sentence for the same refusal' }, { now: NOW })
    assert.equal(reworded.lastError.message, 'a clearer sentence for the same refusal')
    assert.equal(reworded.lastError.code, CODES.swapFailed, 'the code it explains does not change')
  } finally {
    removeDir(dir)
  }
})

// REVERSE MUTATION (fix 1, lib/apply.js): drop `message` from the rolled-back stamp
// — `lastError.message` falls back to the generic sentence and both version
// assertions below go red.
test('a rolled-back apply writes both versions into lastError, the way §3.3 asks', async () => {
  const fx = fixture('lasterror-apply')
  const socketPath = shortSocketPath(fx.dir, 'le.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500, handshakeBudgetMs: 300 },
      job: { ok: true, args: [] },
      build: okBuild(fx.builtDir),
      kickstart: async () => ({ ok: true }),
      toolsList: okTools,
      npm: okNpm,
    })
    assert.equal(result.status, 'rolled-back', result.message)
    const state = loadState(fx.stateRoot).state
    assert.equal(state.current, '1.4.0')
    assert.equal(state.lastError.code, CODES.rolledBack)
    assert.match(state.lastError.message, /does not report 1\.4\.1/, 'the version that was put on disk')
    assert.match(state.lastError.message, /hello said "1\.4\.0"/, 'the version that is actually running')
    assert.deepEqual(JSON.parse(state.lastError.details), { wantVersion: '1.4.1', hello: '1.4.0', mcp: '16 tools' })
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

// REVERSE MUTATION (fix 2, lib/apply.js): restore the old `${appsDir} needs the
// GlassPane installer re-run.` wording, or drop `message` from the rollback-failed
// stamp — the /re-run the GlassPane installer/i match and the lastError assertion
// both go red. exitCodeFor's 5 is asserted here as well as in the apply test, on an
// independent path to the same outcome.
test('a rollback this tool cannot prove exits 5 and names the repair', async () => {
  const fx = fixture('rb-exit5')
  try {
    const made = backupBundles({ appsDir: fx.appsDir, backupRoot: writableRoots(fx.stateRoot).backup, bundles: BUNDLES, marker: { version: '1.4.0' } })
    fs.rmSync(path.join(made.dir, BACKUP_MANIFEST_NAME))
    const result = await rollbackToBackup({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      backupDir: made.dir,
      socketPath: null,
      now: NOW,
      probe: async () => ({ answered: true }),
    })
    assert.equal(result.status, 'rollback-failed')
    assert.equal(exitCodeFor(result), EXIT.ROLLBACK_FAILED, 'spec 7: swap failed AND rollback not proven = 5')
    assert.match(result.message, /re-run the GlassPane installer/i, 'the sentence a person can act on, not a code')
    assert.match(result.message, /backup-manifest\.json/)
    const state = loadState(fx.stateRoot).state
    assert.equal(state.lastError.code, CODES.rollbackFailed)
    assert.match(state.lastError.message, /re-run the GlassPane installer/i, 'the panel shows lastError verbatim, so it has to carry the repair too')
  } finally {
    fx.cleanup()
  }
})

// REVERSE MUTATION (fix 3, lib/apply.js): compare `snapshotDir` lengths instead of
// `manifestTree` digests — both bundles below have the same byte counts before and
// after the flip, so `restoreBackup` returns ok:true and this test goes red.
test('restore verification reads bytes, not byte counts', () => {
  const fx = fixture('restore-bytes')
  try {
    const made = backupBundles({ appsDir: fx.appsDir, backupRoot: writableRoots(fx.stateRoot).backup, bundles: BUNDLES, marker: { version: '1.4.0' } })
    const before = manifestTree(made.dir)
    assert.ok(Object.values(before).every((entry) => entry?.sha256 || entry?.kind), 'a manifest records content, not size')
    const outcome = restoreBackup({
      backupDir: made.dir,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      copyFn: (source, target) => {
        fs.rmSync(target, { recursive: true, force: true })
        fs.cpSync(source, target, { recursive: true })
        if (target.startsWith(fx.appsDir)) flipOneByte(path.join(target, 'Contents', 'Info.plist'))
      },
    })
    assert.equal(outcome.ok, false, 'a restore that lands one wrong byte is not a verified restore')
    assert.match(outcome.message, /GlassPane\.app read back different/)
    assert.match(outcome.message, /Contents\/Info\.plist/, 'it names the file, not just the bundle')
    assert.match(outcome.message, /after the restore/)
    for (const bundle of BUNDLES) {
      const landed = manifestTree(path.join(fx.appsDir, bundle.name))
      const sameLengths = Object.keys(landed).every((key) => landed[key].size === made.manifest.bundles[bundle.name][key]?.size)
      assert.ok(sameLengths, 'the fixture really is a same-length, different-content landing (a length check would pass it)')
    }
  } finally {
    fx.cleanup()
  }
})

// REVERSE MUTATION (fix 3): have `restoreBackup` fall back to copying when the
// manifest cannot be read ("best effort") — `ok` becomes true, the bundles get
// replaced, and all three assertions below go red.
test('a backup that carries no manifest restores nothing, because it cannot be proven', () => {
  const fx = fixture('restore-nomanifest')
  try {
    const made = backupBundles({ appsDir: fx.appsDir, backupRoot: writableRoots(fx.stateRoot).backup, bundles: BUNDLES, marker: { version: '1.4.0' } })
    assert.ok(fs.existsSync(path.join(made.dir, BACKUP_MANIFEST_NAME)), 'a verified backup records the bytes it holds')
    fs.rmSync(path.join(made.dir, BACKUP_MANIFEST_NAME))
    const before = snapshotDir(fx.appsDir)
    const outcome = restoreBackup({ backupDir: made.dir, appsDir: fx.appsDir, bundles: BUNDLES })
    assert.equal(outcome.ok, false)
    assert.match(outcome.message, /restore did not verify/)
    assert.deepEqual(snapshotDir(fx.appsDir), before, 'an unprovable backup replaces nothing')
  } finally {
    fx.cleanup()
  }
})

// REVERSE MUTATION (fix 3): drop the pre-copy comparison of the backup against its
// own manifest — the tampered bundle below would be restored over the live one and
// only the post-copy check would fire, so `/left as it is/` goes red.
test('a bundle that no longer matches its own record is not restored over a live one', () => {
  const fx = fixture('restore-tampered')
  try {
    const made = backupBundles({ appsDir: fx.appsDir, backupRoot: writableRoots(fx.stateRoot).backup, bundles: BUNDLES, marker: { version: '1.4.0' } })
    flipOneByte(path.join(made.dir, 'GlassPane.app', 'Contents', 'Info.plist'))
    const live = fs.readFileSync(path.join(fx.appsDir, 'GlassPane.app', 'Contents', 'Info.plist'), 'utf8')
    const outcome = restoreBackup({ backupDir: made.dir, appsDir: fx.appsDir, bundles: BUNDLES })
    assert.equal(outcome.ok, false)
    assert.match(outcome.message, /GlassPane\.app read back different \(Contents\/Info\.plist\) in the backup/)
    assert.equal(fs.readFileSync(path.join(fx.appsDir, 'GlassPane.app', 'Contents', 'Info.plist'), 'utf8'), live, 'the live bundle was left as it is')
  } finally {
    fx.cleanup()
  }
})

// REVERSE MUTATION (fix 3, backupBundles): compare sizes instead of digests — the
// copy below is one byte wrong at the same length, so `backupBundles` would report
// a verified backup and the throw this test asserts never happens.
test('a backup that changes one byte at the same length is refused before the swap', () => {
  const fx = fixture('backup-byte')
  try {
    assert.throws(
      () => backupBundles({
        appsDir: fx.appsDir,
        backupRoot: writableRoots(fx.stateRoot).backup,
        bundles: BUNDLES,
        marker: { version: '1.4.0' },
        copyFn: (source, target) => {
          fs.rmSync(target, { recursive: true, force: true })
          fs.cpSync(source, target, { recursive: true })
          if (target.includes('update-backup')) flipOneByte(path.join(target, 'Contents', 'Info.plist'))
        },
      }),
      (error) => error.code === CODES.backupFailed
        && /does not match what is installed/.test(error.message)
        && /Contents\/Info\.plist/.test(error.message),
    )
  } finally {
    fx.cleanup()
  }
})

// REVERSE MUTATION (fix 4, handshakeVerify): move the `toolsList` call back inside
// the `hello` match (the shape that ignored the MCP half whenever the version was
// wrong) — `versionWrong.seen.mcp` becomes null and this goes red.
test('handshakeVerify asks both halves on every poll, so the record names the one that broke', async () => {
  const fx = fixture('halves')
  const socketPath = shortSocketPath(fx.dir, 'halves.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  // The allowances below are sized for *what this test decides*, not for how fast a
  // `node` child happens to boot: 400 ms was measured failing when another process
  // was compiling in the same box, which is a load artefact and not a verdict. The
  // refusals being asserted are logical (a wrong version, a half that never
  // answers), so a generous budget cannot make them pass by accident — the named
  // reverse mutation above still reddens with these numbers.
  const liveTools = () => mcpToolsList({ spawnFn: fakeMcpPeer('answer'), timeoutMs: 250 })
  try {
    const versionWrong = await handshakeVerify({ socketPath, wantVersion: '1.4.1', budgetMs: 6_000, pollMs: 100, toolsList: liveTools })
    assert.equal(versionWrong.ok, false)
    assert.equal(versionWrong.seen.hello, '1.4.0')
    assert.match(versionWrong.seen.mcp, /16 tools/, 'the MCP half is asked even when the socket already failed: an old daemon and a broken tool surface are different repairs')
    assert.match(versionWrong.message, /hello said "1\.4\.0"/)

    const toolsBroken = await handshakeVerify({
      socketPath,
      wantVersion: '1.4.0',
      budgetMs: 6_000,
      pollMs: 100,
      // `slow` never answers at all, so the refusal below is produced by the
      // client's own timeout rather than by how fast a child happens to boot.
      toolsList: () => mcpToolsList({ spawnFn: fakeMcpPeer('slow'), timeoutMs: 300 }),
    })
    assert.equal(toolsBroken.ok, false, 'a socket that reports the wanted version is not, by itself, a verified swap')
    assert.equal(toolsBroken.seen.hello, '1.4.0')
    assert.match(toolsBroken.seen.mcp, /^unavailable: /)
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

// REVERSE MUTATION (lib/mcp.js): accept any `tools/list` answer (`if (message.id ===
// 2) finish({ok:true})`) — the two refusals below both report success. The fixture's
// `garbage` mode really emits a non-JSON line, which is what §3.3's "tools/list
// available" judgement is made of; `bad-tools` keeps the *other* refusal reachable.
test('the MCP half refuses a non-JSON line, a wrong-shaped tool list, and a refusal', async () => {
  const modes = async (mode, timeoutMs = 1_500) => mcpToolsList({ spawnFn: fakeMcpPeer(mode), timeoutMs })
  const garbage = await modes('garbage')
  assert.equal(garbage.ok, false)
  assert.match(garbage.reason, /non-JSON line/)
  const wrongShape = await modes('bad-tools')
  assert.equal(wrongShape.ok, false)
  assert.match(wrongShape.reason, /without a tool list/)
  const refused = await modes('refuse')
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /refused initialize/)
  const answered = await modes('answer')
  assert.equal(answered.ok, true, answered.reason)
  assert.equal(answered.count, 16)
})


/* ------------------------------------------------ §9: the bundle a swap inherits */

test('a successful swap re-exports the root bundle the new agent runs on', async () => {
  const fx = fixture('ca-refresh')
  const kick = await okKick()
  const socketPath = shortSocketPath(fx.dir, 'ca.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  const calls = []
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 1_000 },
      job: { ok: true, args: ['glasspaned', '--socket-path', socketPath] },
      build: okBuild(fx.builtDir),
      kickstart: kick.fn,
      toolsList: okTools,
      npm: okNpm,
      refreshCa: () => {
        calls.push('refresh')
        return { status: 'ok', certs: 163, path: path.join(fx.stateRoot, 'ca-roots.pem'), exportedAt: NOW.toISOString(), detail: null }
      },
    })
    assert.equal(result.status, 'applied', result.message)
    assert.deepEqual(calls, ['refresh'], 'the interception root rotates; a bundle exported at install time is not permanently valid')
    const state = loadState(fx.stateRoot).state
    assert.equal(state.caRoots.status, 'ok')
    assert.equal(state.caRoots.certs, 163)
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a refresh that could not produce a bundle does not turn a finished swap into a failure', async () => {
  const fx = fixture('ca-empty')
  const kick = await okKick()
  const socketPath = shortSocketPath(fx.dir, 'ca2.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 1_000 },
      job: { ok: true, args: ['glasspaned', '--socket-path', socketPath] },
      build: okBuild(fx.builtDir),
      kickstart: kick.fn,
      toolsList: okTools,
      npm: okNpm,
      refreshCa: () => ({ status: 'probe-failed', certs: 4, path: path.join(fx.stateRoot, 'ca-roots.pem'), exportedAt: NOW.toISOString(), detail: 'still intercepted' }),
    })
    assert.equal(result.status, 'applied', 'the version really did change; the CA gap is a next step, not a rollback trigger')
    assert.equal(loadState(fx.stateRoot).state.caRoots.status, 'probe-failed', '…and it stays on disk, so the panel can keep saying it')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a refused apply refreshes nothing on disk', async () => {
  const fx = fixture('ca-refused', { staged: false })
  const calls = []
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath: shortSocketPath(fx.dir, 'ca3.sock'),
      probe: { socketPath: shortSocketPath(fx.dir, 'ca3.sock'), timeoutMs: 200 },
      job: { ok: true, args: ['glasspaned'] },
      build: okBuild(fx.builtDir),
      kickstart: async () => ({ ok: true }),
      toolsList: okTools,
      npm: okNpm,
      refreshCa: () => {
        calls.push('refresh')
        return { status: 'ok', certs: 1, path: '/x', exportedAt: NOW.toISOString(), detail: null }
      },
    })
    assert.notEqual(result.status, 'applied', result.message)
    assert.deepEqual(calls, [], 'nothing was swapped, so the machine the agent runs on did not change either')
  } finally {
    fx.cleanup()
  }
})

/* ------------------------------------------------------------------ §11 接线 */

/**
 * The two tests here use the **real** `refreshRuntime`; only the two facts that touch this machine
 * (the `enable` spawn and `launchctl print`) are replaced. That distinction is the point: an earlier
 * round found the asset gate, the archive's symlinks and six dead CLI flags all green because a stub
 * stood where production runs.
 */
function loadedWithCli(cli) {
  return { ok: true, args: ['/bin/sh', '-c', '"$0" "$1" check "$2" "$3" --json', cli] }
}

/**
 * The two §11 integration tests used to plant the previous install in a sibling directory
 * (`<tmp>/previous-install`), so `runtimeVersionOf` answered null for it and **no prune could ever
 * reach it** — "the old copy is still on disk" was unfalsifiable by the mechanism it named. Now the
 * previous generation is a real generation of the runtime root, and an orphan newer than it (but
 * older than this run's version by no accident) is planted alongside: the fix under test is that the
 * pointed-at generation survives while the orphan goes, and a string-ordered prune would do the
 * opposite.
 */
/**
 * §11 has two shapes on a real machine, and the integration tests have to say which one they are
 * pretending to be:
 *
 *  · **migrated** — the registered definition already goes through `runtime/agent-entry.js`, so a
 *    version move is a pointer write and *nothing* spawns an `enable`. This is the common case from
 *    here on, and the one that had a manual step in it before.
 *  · **pre-entry** — the job still names a versioned script (every machine installed before this
 *    release). Then the move does need one registration, done by the new copy, and it is the last
 *    version that will ever ask.
 *
 * `entryMigrated` picks between them by deciding what the fake `launchctl print` answers.
 */
/** The registered job naming the stable entry — the shape that needs no re-registration. */
function loadedWithEntry(stateRoot) {
  return loadedWithArgs([path.join(writableRoots(stateRoot).runtime, 'agent-entry.js')])
}

function loadedWithArgs(args) {
  return { ok: true, args: ['/bin/sh', '-c', '"$0" "$1" check "$2" "$3" --json', process.execPath, ...args] }
}

async function applyWithRealRuntime(label, { enableOk = true, loaded = null, disabled = false, trigger = 'manual', enableWritesState = null, extraDeps = {}, orphanGenerations = ['1.4.9'], entryMigrated = true, undoLoaded = null, undoEnableOk = true } = {}) {
  const fx = fixture(label)
  const kick = await okKick()
  const socketPath = shortSocketPath(fx.dir, 'ok.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  const previousRoot = path.join(fx.stateRoot, 'runtime', '1.4.0')
  const previousCli = path.join(previousRoot, 'updater', 'cli.js')
  fs.mkdirSync(path.dirname(previousCli), { recursive: true })
  fs.writeFileSync(previousCli, 'PREVIOUS UPDATER\n')
  for (const orphan of orphanGenerations) {
    const dir = path.join(fx.stateRoot, 'runtime', orphan, 'updater')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'cli.js'), 'ORPHAN COPY\n')
  }
  writePointer(fx.stateRoot, { updaterCli: previousCli, installRoot: previousRoot, agentLabel: AGENT_LABEL }, { now: NOW })
  fs.mkdirSync(path.join(fx.treePath, 'updater'), { recursive: true })
  fs.writeFileSync(path.join(fx.treePath, 'updater', 'cli.js'), 'NEW UPDATER\n')
  const enableCalls = []
  const undoEnableCalls = []
  // `undoLoaded` is what the *rollback* is told the loaded job names, and it is deliberately a separate
  // knob from `loaded`: the forward step and the undo read the same launchd database at two different
  // moments, and one constant for both cannot express "the book went unreadable between them" — the case
  // the conservative restore exists for. With no override the honest default is that nothing re-registered
  // in between, so the undo sees what the forward step saw.
  const shapeAnswer = () => (entryMigrated ? loadedWithEntry(fx.stateRoot) : loadedWithArgs([previousCli]))
  const readRunningJobImpl = () => undoLoaded ?? loaded ?? shapeAnswer()
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 1_000 },
      job: { ok: true, args: ['glasspaned', '--socket-path', socketPath] },
      build: okBuild(fx.builtDir),
      kickstart: kick.fn,
      toolsList: okTools,
      npm: okNpm,
      autoDisabled: disabled,
      trigger,
      readRunningJobImpl,
      runEnableImpl: ({ cliPath }) => {
        undoEnableCalls.push(cliPath)
        return undoEnableOk ? { ok: true, message: null, parsed: { ok: true } } : { ok: false, message: 'the previous updater refused to register' }
      },
      ...extraDeps,
      refreshRuntimeImpl: (options) => refreshRuntime({
        ...options,
        runEnable: ({ cliPath }) => {
          enableCalls.push(cliPath)
          // 真的 `enable` 会写状态（history + caRoots）。要测的就是这一步与父进程那一次写的先后。
          // 状态根由这里给：测试体里的 `fx` 在 `await` 之前还没初始化，闭包直接引用它只会拿到 TDZ。
          if (enableWritesState) enableWritesState({ stateRoot: fx.stateRoot })
          return enableOk ? { ok: true, message: null, parsed: { ok: true } } : { ok: false, message: 'the new updater said no' }
        },
        readRunningJob: () => {
          if (loaded !== null) return loaded
          if (entryMigrated) return loadedWithEntry(fx.stateRoot)
          // Pre-entry: the book keeps naming the versioned script until a registration happens, then
          // it names the entry — which is the only honest way to let the read-back pass.
          // A failed registration does not move the book; pretending otherwise is how a fixture lets a
          // broken path look fine.
          return enableCalls.length === 0 || !enableOk ? loadedWithArgs([previousCli]) : loadedWithEntry(fx.stateRoot)
        },
      }),
    })
    return { result, fx, previousCli, previousRoot, enableCalls, undoEnableCalls, pointer: readPointer(fx.stateRoot) }
  } finally {
    await daemon.close()
  }
}

test('a swap also moves the updater\'s own copy, and the pointer names a file that exists', async () => {
  const { result, fx, previousCli, previousRoot, enableCalls, pointer } = await applyWithRealRuntime('runtime-happy')
  try {
    assert.equal(result.status, 'applied', result.message)
    assert.equal(result.code, null, `换版本身干净：${result.message}`)
    assert.equal(result.runtime.status, 'refreshed', JSON.stringify(result.runtime))
    assert.equal(result.runtime.agentVerified, true)
    assert.equal(fs.existsSync(fx.stagingDir), false, '暂存树仍然要退场')
    assert.equal(pointer.pointer.updaterCli, result.runtime.cliPath)
    assert.equal(fs.existsSync(pointer.pointer.updaterCli), true, '指针必须指到一个真在盘上的脚本')
    assert.equal(fs.readFileSync(pointer.pointer.updaterCli, 'utf8'), 'NEW UPDATER\n',
      '落地的那份必须是被八道校验放过的树里的字节，不是旧安装里翻出来的')
    assert.deepEqual(enableCalls, [],
      '作业已经走稳定入口：这次换版就该只有一次指针写，不该再有注册')
    assert.equal(fs.existsSync(path.join(fx.stateRoot, 'runtime', 'agent-entry.js')), true,
      '入口不落地，指针翻了也没人执行它')
    assert.equal(fs.readFileSync(previousCli, 'utf8'), 'PREVIOUS UPDATER\n', '旧那份不许被就地覆盖——回滚还要靠它')
    assert.equal(fs.existsSync(previousRoot), true,
      '被指针指过的那一代是**在册清理够得到**的（它就住在 runtime/ 里），所以这条断言真的有牙齿')
    assert.equal(fs.existsSync(path.join(fx.stateRoot, 'runtime', '1.4.9')), false,
      '没人指的那一代要清掉；钉住"上一代"不等于不再回收')
    assert.equal(loadState(fx.stateRoot).state.runtime.status, 'refreshed', '面板读的是状态文件，不是返回值')
    fx.cleanup()
  } finally {
    fx.cleanup()
  }
})

test('a machine whose job predates the entry is migrated during the swap, and a migration that fails is a stated degradation', async () => {
  const { result, fx, previousCli, enableCalls, pointer } = await applyWithRealRuntime('runtime-fails', { enableOk: false, entryMigrated: false })
  try {
    assert.equal(result.status, 'applied', ' bundles did change — this is not a rolled-back apply')
    assert.equal(result.code, CODES.runtimeStale, `更新器自己没换上必须留下稳定的码：${result.code}`)
    assert.equal(exitCodeFor(result), EXIT.OK, '退出码是面板与 launchd 唯一的数字契约，不该被一句降级改掉')
    assert.match(result.message, /did not move/, result.message)
    assert.equal(pointer.pointer.updaterCli, previousCli, '指针必须回到旧那份，否则下一次作业会跑一个没注册过的脚本')
    assert.deepEqual(enableCalls, [result.runtime.cliPath, previousCli],
      `新那份注册失败之后，要用旧那份把作业指回去：${JSON.stringify(enableCalls)}`)
    const state = loadState(fx.stateRoot).state
    assert.equal(state.runtime.status, 'failed')
    assert.equal(state.runtime.agentVerified, false, JSON.stringify(state.runtime))
    fx.cleanup()
  } finally {
    fx.cleanup()
  }
})

test('a switched-off machine moves the code and pointer but registers nothing', async () => {
  const { result, fx, enableCalls, pointer } = await applyWithRealRuntime('runtime-kept', { disabled: true })
  try {
    assert.equal(result.status, 'applied', result.message)
    assert.equal(result.code, null, '§11.6 的 skipped 不是降级：交接留给下一次 enable，这次没失败')
    assert.equal(result.runtime.status, 'kept', JSON.stringify(result.runtime))
    assert.deepEqual(enableCalls, [], '关掉自动更新的机器上，这一步绝不注册')
    assert.equal(fs.existsSync(pointer.pointer.updaterCli), true, '面板跑的就是指针那份，也要真在盘上')
    fx.cleanup()
  } finally {
    fx.cleanup()
  }
})

test('a scheduled swap on a migrated machine is a completed swap: no pending code, no handover owed', async () => {
  // This is what the entry design bought. Before it, *every* scheduled version move left the machine
  // running the previous updater until a person flipped the switch, which is the same failure §11
  // exists to remove — a release that fixes the updater would keep not arriving.
  const { result, fx, enableCalls, pointer } = await applyWithRealRuntime('runtime-auto-steady')
  try {
    assert.equal(result.status, 'applied', result.message)
    assert.equal(result.code, null, `定时那一次也不再留待办：${result.code} / ${result.message}`)
    assert.equal(result.runtime.status, 'refreshed', JSON.stringify(result.runtime))
    assert.equal(result.runtime.agentVerified, true, JSON.stringify(result.runtime))
    assert.deepEqual(enableCalls, [], '定时作业里绝不许出现 bootout/bootstrap：那是在半路拆掉自己')
    assert.equal(fs.existsSync(pointer.pointer.updaterCli), true, '新那份代码要在指针说的位置上')
  } finally {
    fx.cleanup()
  }
})

test('a scheduled swap on a pre-entry machine is the one-time migration, said as one-time', async () => {
  const { result, fx, previousCli, enableCalls, pointer } = await applyWithRealRuntime('runtime-auto', { trigger: 'auto', entryMigrated: false })
  try {
    assert.equal(result.status, 'applied', result.message)
    assert.equal(result.code, null, '换了代不等于失败：这条是"注册待迁移"，不是换版降级')
    assert.equal(result.runtime.status, 'skipped', JSON.stringify(result.runtime))
    assert.equal(result.runtime.agentVerified, false)
    assert.deepEqual(enableCalls, [], '注册留到人工那一次：这次运行就是那个作业')
    assert.equal(fs.readFileSync(previousCli, 'utf8'), 'PREVIOUS UPDATER\n', '旧那份仍完整：作业还指着它')
    assert.equal(fs.existsSync(pointer.pointer.updaterCli), true, '新那份也要真在盘上，下一次 enable 才有的可指')
    assert.match(result.message, /no future version needs it/, `要说清这只发生一次：${result.message}`)
  } finally {
    fx.cleanup()
  }
})

test('a rollback that happens after the handover takes the pointer and the job back too', async () => {
  // §11 moves the updater's own copy *before* apply is finished: re-exporting the root bundle and
  // retiring the staging tree still sit after it. Either of those can throw, and apply's catch then
  // restores the two `.app` bundles. If nothing else moved back, the machine ends up on `baseline`
  // while `update-install.json` and launchd name the version that was just rolled out — and the record
  // reads "restored and verified", which is true of the app and false of the updater.
  const fx = fixture('runtime-undo-')
  const kick = await okKick()
  const socketPath = shortSocketPath(fx.dir, 'undo.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  const previousRoot = path.join(fx.dir, 'previous-install')
  const previousCli = path.join(previousRoot, 'updater', 'cli.js')
  fs.mkdirSync(path.dirname(previousCli), { recursive: true })
  fs.writeFileSync(previousCli, 'PREVIOUS UPDATER\n')
  writePointer(fx.stateRoot, { updaterCli: previousCli, installRoot: previousRoot, agentLabel: AGENT_LABEL }, { now: NOW })
  fs.mkdirSync(path.join(fx.treePath, 'updater'), { recursive: true })
  fs.writeFileSync(path.join(fx.treePath, 'updater', 'cli.js'), 'NEW UPDATER\n')
  const entry = path.join(writableRoots(fx.stateRoot).runtime, 'agent-entry.js')
  const enableCalls = []
  const undoEnableCalls = []
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 1_000 },
      job: { ok: true, args: ['glasspaned', '--socket-path', socketPath] },
      build: okBuild(fx.builtDir),
      kickstart: kick.fn,
      toolsList: okTools,
      npm: okNpm,
      // 交接成功之后才炸的那一步：§9 重新导出根证书束。
      refreshCa: () => { throw new Error('ca-roots.pem could not be written: the volume refuses chmod') },
      // 这台机器的作业已经走稳定入口：回滚要做的那一件事就是把指针写回去，入口明天自然照它跑旧那份。
      // 正反两读都答"在册的是入口"，于是任何一次多余的注册都会在这里露出来。
      readRunningJobImpl: () => loadedWithCli(entry),
      runEnableImpl: ({ cliPath }) => {
        undoEnableCalls.push(cliPath)
        return { ok: true, message: null, parsed: { ok: true } }
      },
      refreshRuntimeImpl: (options) => refreshRuntime({
        ...options,
        runEnable: ({ cliPath }) => {
          enableCalls.push(cliPath)
          return { ok: true, message: null, parsed: { ok: true } }
        },
        readRunningJob: () => loadedWithCli(entry),
      }),
    })
    assert.ok(['rolled-back', 'rollback-failed'].includes(result.status), `交接之后才炸，答案要落在 §7 的 4/5 段：${result.status}`)
    assert.equal(result.code, CODES.postSwapFailed, `换的是 .app，回退也要按 §7 的 4/5 段报：${result.code}`)
    assert.equal(result.ok, false)
    assert.deepEqual(enableCalls, [], `作业走的是稳定入口，换版不该再注册一次：${JSON.stringify(enableCalls)}`)
    assert.deepEqual(undoEnableCalls, [],
      `回滚同样不该注册——指针写回去就够了，多出来的那一次是没必要的动作：${JSON.stringify(undoEnableCalls)}`)
    const back = readPointer(fx.stateRoot)
    assert.equal(back.pointer.updaterCli, previousCli, JSON.stringify(back))
    assert.match(result.message, /the pointer is back at/, `句子里要看得见指针回去了：${result.message}`)
    assert.match(result.message, /goes through the stable entry/, `还要看得见为什么不必重新注册：${result.message}`)
    const state = loadState(fx.stateRoot).state
    assert.equal(state.runtime.status, 'failed', JSON.stringify(state.runtime))
    assert.equal(state.runtime.agentVerified, true, '在册作业核对过：它走稳定入口，入口照回去的指针跑旧那一份')
    assert.equal(state.current, '1.4.0', '回退之后 current 要跟着回去')
    assert.match(fx.installedBytes(), /installed/,
      '先证明 .app 真的被换回去了（装回的是备份那份）——不然这条控制测的是回滚以外的东西')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a rollback of a deferred handover puts the pointer back without registering: that run *is* the job', async () => {
  // §11.12's scheduled shape, which is what a daily apply actually produces on a machine that has not
  // been migrated yet. The forward step stopped at the pointer *because* registering from inside the
  // daily job means `bootout` of the process doing the update, so the loaded definition still names the
  // previous generation. The undo must not repair that by making the call the forward step refused: it
  // puts the pointer back, leaves the book alone, and lets the read-back decide whether the machine is
  // consistent rather than asserting that it is.
  const { result, fx, previousCli, undoEnableCalls, enableCalls, pointer } = await applyWithRealRuntime('runtime-undo-defer', {
    trigger: 'auto',
    entryMigrated: false,
    extraDeps: { refreshCa: () => { throw new Error('ca-roots.pem could not be written: the volume refuses chmod') } },
  })
  try {
    assert.equal(result.code, CODES.postSwapFailed, result.message)
    assert.equal(result.runtime.status, 'failed', JSON.stringify(result.runtime))
    assert.deepEqual(enableCalls, [], '定时那一次正反两趟都不许注册：那是在半路拆掉自己')
    assert.deepEqual(undoEnableCalls, [],
      `回滚更不许：唯一能在这里注册的理由，就是刚刚被拒绝的那个理由：${JSON.stringify(undoEnableCalls)}`)
    assert.equal(pointer.pointer.updaterCli, previousCli, JSON.stringify(pointer))
    assert.equal(fs.readFileSync(previousCli, 'utf8'), 'PREVIOUS UPDATER\n',
      '在册作业还指着那一代，所以它必须在盘上——回滚把没人指的代删掉就是明天早上的 Cannot find module')
    assert.match(result.message, /nothing was re-registered/, `要看得见这一步是有意跳过的：${result.message}`)
    assert.match(result.message, /generation 1\.4\.0/, `在册的那一代要写进句子，读者才知道作业还指着谁：${result.message}`)
    assert.equal(result.runtime.agentVerified, true,
      '作业没被换过，而它指的就是指针回去的那一份——这是读回来的，不是假设的')
    assert.equal(loadState(fx.stateRoot).state.runtime.agentVerified, true, '面板读状态文件，也要读到同一句话')
  } finally {
    fx.cleanup()
  }
})

test('an undo whose book went unreadable hands the definition back instead of assuming the entry', async () => {
  // The conservative half of §11.12. The forward step proved the job goes through the entry; then
  // `launchctl print` stops answering — a domain that is not booted, a job somebody unloaded — and not
  // knowing what is loaded is not evidence that it is the entry. Saying "the pointer is back, so the
  // entry will pick it up" about a book that never answered would be the exact lie this function exists
  // to prevent, so the previous copy is asked to register itself and the record says it could not verify.
  const unreadable = { ok: false, unknown: true, code: CODES.busyOrUnreachable, reason: 'launchctl print gui/501/com.glasspane.update answered 113: Could not find service' }
  const { result, fx, previousCli, undoEnableCalls, pointer } = await applyWithRealRuntime('runtime-undo-blind', {
    undoLoaded: unreadable,
    extraDeps: { refreshCa: () => { throw new Error('ca-roots.pem could not be written: the volume refuses chmod') } },
  })
  try {
    assert.equal(result.code, CODES.postSwapFailed, result.message)
    assert.deepEqual(undoEnableCalls, [previousCli],
      `读不到在册作业时的出路是让旧那份自己重注册：${JSON.stringify(undoEnableCalls)}`)
    assert.equal(pointer.pointer.updaterCli, previousCli, JSON.stringify(pointer))
    assert.match(result.message, /re-registered the job/, `那一次注册要在句子里看得见：${result.message}`)
    assert.equal(result.runtime.agentVerified, false,
      '读不回来就不能声称核对过——这条控制的全部意义是"未读"和"已核对"是两个答案')
    assert.match(result.message, /was not read back/, `还要把读不回来这件事说出来：${result.message}`)
  } finally {
    fx.cleanup()
  }
})

test('an undo on a switched-off machine registers nothing, because the job it would hand back does not exist', async () => {
  // The forward step's `kept` record says no job was registered, and the machine is that way because the
  // owner switched automatic update off. `enable` is the one call that would give it a job again — so a
  // rollback that "restores the agent" here silently turns the user's switch back on and writes a history
  // row that says they turned it on themselves.
  const { result, fx, previousCli, undoEnableCalls, pointer } = await applyWithRealRuntime('runtime-undo-off', {
    disabled: true,
    extraDeps: { refreshCa: () => { throw new Error('ca-roots.pem could not be written: the volume refuses chmod') } },
  })
  try {
    assert.equal(result.code, CODES.postSwapFailed, result.message)
    assert.deepEqual(undoEnableCalls, [],
      `关了自动更新的机器上，回滚这一趟也不许注册：${JSON.stringify(undoEnableCalls)}`)
    assert.equal(pointer.pointer.updaterCli, previousCli, '面板跑的就是指针那一份，它照样得回去')
    assert.match(result.message, /switched off on this machine/, `句子要说清为什么没注册：${result.message}`)
    assert.equal(result.runtime.agentVerified, false, '没有作业可读，就没有核过')
    assert.equal(fs.readFileSync(previousCli, 'utf8'), 'PREVIOUS UPDATER\n')
  } finally {
    fx.cleanup()
  }
})

test('the handover child writes state, and the parent does not overwrite it', async () => {
  // 生产里 `enable` 会 saveState（它写自己的 history 行，也写它刷新过的 caRoots）。父进程若在交接
  // 之后拿"交接前那一刻读到的状态"去 stamp applied，子进程那一行就被无声抹掉了——而那几行是一个人在
  // 面板与日志里唯一能核对"交接到底发生过没有"的痕迹。所以交接之后的那一次写必须先重新读一遍。
  //
  // 状态根要从回调的参数拿，不能从测试体的 `fx` 拿：`fx` 在这次 `await` 返回之前还没初始化，闭包里
  // 直接引用它只会抛 TDZ，于是这一条测的根本不是丢更新（第一版就是这样"红得像是证明了什么"）。
  const wrote = []
  const { result, fx, enableCalls } = await applyWithRealRuntime('runtime-lostupdate', {
    entryMigrated: false,
    enableWritesState: ({ stateRoot }) => {
      const fresh = loadState(stateRoot).state
      wrote.push(saveState(stateRoot, nextState(fresh, {
        historyEntry: { action: 'enable', result: 'enabled', digest: null, code: null },
      }, { now: NOW }), { now: NOW }).path)
    },
  })
  try {
    assert.equal(result.status, 'applied', result.message)
    assert.equal(wrote.length, 1, '交接那一次注册要真的写过状态文件，否则这条测的是别的东西')
    assert.equal(enableCalls.length, 1, JSON.stringify(result.runtime))
    assert.equal(result.runtime?.status, 'refreshed', JSON.stringify(result.runtime))
    const state = loadState(fx.stateRoot).state
    const actions = state.history.map((row) => `${row.action}:${row.result}`)
    assert.ok(actions.includes('enable:enabled'), `交接那一次写进状态的行被父进程抹掉了：${JSON.stringify(actions)}`)
    assert.ok(actions.includes('apply:applied'), `换版本身的行也要在：${JSON.stringify(actions)}`)
    assert.ok(actions.indexOf('enable:enabled') < actions.indexOf('apply:applied'),
      `两行的先后就是这两次写的先后：${JSON.stringify(actions)}`)
    assert.equal(state.status, 'applied', '父进程的那一次写仍然要赢在版本与状态上')
    assert.equal(state.current, '1.4.1')
    assert.equal(state.runtime.status, 'refreshed', JSON.stringify(state.runtime))
  } finally {
    fx.cleanup()
  }
})
