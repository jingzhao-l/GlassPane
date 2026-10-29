/**
 * Lane 8 of the 2026-10-29 ledger, all four in `updater/lib/apply.js`. Every fixture here is real bytes on
 * real disks, a real unix socket, or a real child process — and each test names the shape it refuses to
 * invent:
 *
 * · **S8-1** `backupBundles` writes `sourceAppsDir` into the marker and `applyUpdate` writes `fromStateRoot`,
 *   and nothing in the repository had ever read either field (measured: `grep -rn 'sourceAppsDir\|fromStateRoot'`
 *   over the whole tree returns the two writes and zero readers). So a `GLASSPANE_APPS_DIR=A updater apply`
 *   followed by a plain `updater rollback` restored A's old bytes into the *default* `~/Applications`,
 *   kickstarted the real daemon and answered "restored X and the daemon reports it". `restoreBackup` proves
 *   bytes; it cannot tell whose install they came from. Now the marker is read for ownership *before* the
 *   idle probe, so a refusal restarts nothing.
 * · **S8-2** nine post-window writes used `stamp(...)` — the document this run read at its own start, whole
 *   file, as the base. There is no cross-process lock anywhere in this repo (measured: no `lock`/`flock`
 *   primitive in `updater/lib`, `installer/` or `mcp-shell/src`), and between that read and those writes sits
 *   `swift build` at fifteen minutes. `freshestBase` already existed and its own comment stated the rule;
 *   only the successful apply followed it.
 * · **S8-3** `renameDirectoryIntoPlace` returned a note about an `.old-<pid>` it could not delete, and both
 *   call sites dropped the return value; `sweepStaleCopies` recognised only `.new-`, so the deleted comment's
 *   promise that "the next run's cleanup takes it" was false, and a recycled pid made the next swap's
 *   `renameSync` answer `ENOTEMPTY` on a directory it did not create.
 * · **S8-4** `defaultRun` folded every other `spawnSync` error into `{status:127}` — the one number
 *   `lib/binaries.js` spends its whole existence keeping free of "did not run" meanings. Both result shapes
 *   the tests below pin were measured on this machine with real children.
 *
 * REVERSE MUTATIONS (each named at the test it reddens, run against `apply.js` restored from
 * `/var/tmp/glasspane-main-check/2026-10-29-main/lane8/`):
 *   · delete the ownership gate in `rollbackToBackup` → `a backup made for a different --apps-dir refuses the
 *     rollback instead of restoring it here` and `… a backup made under a different state root …` go red on
 *     a *successful* restore.
 *   · put those five rollback writes (and the build-failed one) back on `stamp(...)` →
 *     `a check that landed during the build is still in the record after a rolled-back apply` and
 *     `a build that failed after a concurrent check keeps that check's own record` go red on `lastCheckAt`.
 *   · `return null` from the `rmSync` catch and drop the `.old-` arm of the sweep →
 *     `an .old- copy the disk will not give up is in the apply record, by name` and
 *     `the sweep takes an .old- copy that duplicates what is installed and keeps one it cannot prove spare`.
 *   · fold `ETIMEDOUT` back into the `{status:127}` line → all three S8-4 tests go red on `127`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import {
  backupBundles,
  backupOwnership,
  buildStagedTree,
  defaultCopy,
  defaultRun,
  installBundles,
  applyUpdate,
  rollbackToBackup,
} from '../lib/apply.js'
import { CODES, EXIT, exitCodeFor } from '../lib/codes.js'
import { writableRoots } from '../lib/fsutil.js'
import { ARCHIVE_FILE_NAME } from '../lib/staging.js'
import { emptyState, loadState, nextState, saveState } from '../lib/state.js'
import { sha256Bytes } from '../lib/digest.js'
import { packTarGz } from '../lib/tar.js'
import { makeFakeApp, removeDir, shortSocketPath, startSocketDaemon, tempDir, TMP_PREFIX } from './helpers.mjs'

const NOW = new Date('2026-09-27T12:00:00.000Z')
const BUNDLES = [
  { name: 'GlassPane.app', executable: path.join('Contents', 'MacOS', 'glasspane-settings') },
  { name: 'GlassPane Daemon.app', executable: path.join('Contents', 'MacOS', 'glasspaned') },
]

/** A temp dir with two installed bundle sets, the way `--apps-dir` gives a machine two installs. */
function appsDirWith(root, name, version, marker) {
  const dir = path.join(root, name)
  for (const bundle of BUNDLES) makeFakeApp(dir, bundle.name, version, { marker })
  return dir
}

/** Undo whatever mode this file's fixtures set, so `removeDir` can take the tree with it. */
function unlockTree(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      try { fs.chmodSync(abs, 0o700) } catch { /* already gone */ }
      unlockTree(abs)
    }
  }
  try { fs.chmodSync(dir, 0o700) } catch { /* already gone */ }
}

/* ------------------------------------------------------------------ S8-1 */

test('a backup made for a different --apps-dir refuses the rollback instead of restoring it here', async () => {
  const root = tempDir(`${TMP_PREFIX}lane8-owner-`)
  const stateRoot = path.join(root, 'state')
  const a = appsDirWith(root, 'A', '1.4.0', 'A-installed')
  const b = appsDirWith(root, 'B', '1.4.1', 'B-current')
  saveState(stateRoot, nextState(emptyState({ now: NOW }), { current: '1.4.1', status: 'applied', code: null }, { now: NOW }), { now: NOW })
  // The backup of A, made by `GLASSPANE_APPS_DIR=A updater apply` — the marker says so, in both fields.
  const made = backupBundles({
    appsDir: a,
    backupRoot: writableRoots(stateRoot).backup,
    bundles: BUNDLES,
    stamp: '2026-09-27T11-00-00-000Z',
    marker: { version: '1.4.0', targetVersion: '1.4.1', fromStateRoot: stateRoot },
  })
  const probes = []
  const kicks = []
  const socketPath = shortSocketPath(root, 'owner.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  try {
    let result = null
    // The plain shell's `updater rollback`: default appsDir = B, same state root, so `newestBackup` picks
    // A's backup and `restoreBackup` finds nothing wrong with its bytes.
    result = await rollbackToBackup({
      stateRoot,
      appsDir: b,
      bundles: BUNDLES,
      backupDir: made.dir,
      socketPath,
      now: NOW,
      probe: async () => { probes.push(1); return { answered: true } },
      kickstart: async () => { kicks.push(1); return { ok: true } },
      toolsList: async () => ({ ok: true, count: 16, tools: ['gp_probe_status'] }),
    })
    assert.equal(result.ok, false, `A 的备份不许被当成 B 的恢复点：${result.message}`)
    assert.equal(result.status, 'deferred', JSON.stringify(result))
    assert.equal(result.code, CODES.backupFailed, JSON.stringify(result))
    assert.equal(exitCodeFor(result), EXIT.REFUSED, '一个字节都没动的拒绝是 §7 的 3，不是 4/5')
    assert.match(result.message, new RegExp(path.basename(a)), `句子必须点名那两份目录：${result.message}`)
    assert.match(result.message, /--apps-dir/, `必须给出能走到 A 那份的那条命令：${result.message}`)
    assert.ok(result.message.includes(a) && result.message.includes(b), `两个路径都要在句子里，读的人才知道是谁和谁：${result.message}`)
    assert.deepEqual(probes, [], '归属核对在 idle 探针之前：一次拒不改这台机器的运行状态')
    assert.deepEqual(kicks, [], '更不重启 daemon')
    assert.match(fs.readFileSync(path.join(b, 'GlassPane.app', 'Contents', 'MacOS', 'binary'), 'utf8'), /B-current/, 'B 一份字节都没被换掉')
    assert.match(fs.readFileSync(path.join(a, 'GlassPane.app', 'Contents', 'MacOS', 'binary'), 'utf8'), /A-installed/, 'A 也还是原样')
    assert.equal(loadState(stateRoot).state.current, '1.4.1', '记录里也不能出现一次没发生的回滚')
  } finally {
    await daemon.close()
    removeDir(root)
  }
})

test('the same backup still restores when the rollback is pointed at the install it came from', async () => {
  const root = tempDir(`${TMP_PREFIX}lane8-match-`)
  const stateRoot = path.join(root, 'state')
  const a = appsDirWith(root, 'A', '1.4.1', 'A-current')
  saveState(stateRoot, nextState(emptyState({ now: NOW }), { current: '1.4.1', status: 'applied', code: null }, { now: NOW }), { now: NOW })
  const made = backupBundles({
    appsDir: a,
    backupRoot: writableRoots(stateRoot).backup,
    bundles: BUNDLES,
    stamp: '2026-09-27T11-00-00-000Z',
    marker: { version: '1.4.0', fromStateRoot: stateRoot },
  })
  for (const bundle of BUNDLES) makeFakeApp(a, bundle.name, '1.4.2', { marker: 'A-too-new' })
  const socketPath = shortSocketPath(root, 'match.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  try {
    const result = await rollbackToBackup({
      stateRoot,
      appsDir: a,
      bundles: BUNDLES,
      backupDir: made.dir,
      socketPath,
      now: NOW,
      toolsList: async () => ({ ok: true, count: 16, tools: ['gp_probe_status'] }),
    })
    assert.equal(result.status, 'rolled-back', `归属对得上就必须照旧放行（这条是对照，不是宽容）：${result.message}`)
    assert.match(fs.readFileSync(path.join(a, 'GlassPane.app', 'Contents', 'MacOS', 'binary'), 'utf8'), /A-current/)
  } finally {
    await daemon.close()
    removeDir(root)
  }
})

test('a backup made under a different state root is refused for that reason, by name', async () => {
  const root = tempDir(`${TMP_PREFIX}lane8-root-`)
  const home = path.join(root, 'state')
  const other = path.join(root, 'other-state')
  fs.mkdirSync(other, { recursive: true, mode: 0o700 })
  const apps = appsDirWith(root, 'Apps', '1.4.0', 'installed')
  saveState(home, nextState(emptyState({ now: NOW }), { current: '1.4.0', status: 'applied', code: null }, { now: NOW }), { now: NOW })
  const made = backupBundles({
    appsDir: apps,
    backupRoot: writableRoots(home).backup,
    bundles: BUNDLES,
    stamp: '2026-09-27T11-00-00-000Z',
    marker: { version: '1.4.0', fromStateRoot: other },
  })
  try {
    const refusal = await rollbackToBackup({
      stateRoot: home,
      appsDir: apps,
      bundles: BUNDLES,
      backupDir: made.dir,
      now: NOW,
      probe: async () => ({ answered: true }),
      kickstart: async () => ({ ok: true }),
      helloCall: async () => ({ answered: true, frame: { id: 1, result: { version: '1.4.0' } } }),
      toolsList: async () => ({ ok: true, count: 16, tools: ['x'] }),
    })
    assert.equal(refusal.ok, false, refusal.message)
    assert.equal(refusal.code, CODES.backupFailed, refusal.message)
    assert.match(refusal.message, /state root/, `状态根那条归属必须单独说：${refusal.message}`)
    assert.ok(refusal.message.includes(other) && refusal.message.includes(home), `两份根都要点名：${refusal.message}`)
    assert.match(refusal.message, /--state-dir/, `出路必须给得出：${refusal.message}`)
  } finally {
    removeDir(root)
  }
})

test('the ownership judgement reads a marker, and a marker that says nothing is unknown rather than innocent', () => {
  const mine = { sourceAppsDir: '/Users/dev/A', fromStateRoot: '/Users/dev/.glasspane' }
  assert.deepEqual(backupOwnership(mine, { appsDir: '/Users/dev/A', stateRoot: '/Users/dev/.glasspane' }), {
    ok: true, unknown: false, problems: [], wantAppsDir: '/Users/dev/A', wantStateRoot: '/Users/dev/.glasspane',
  }, '对得上就是对上，不许顺手加一句警告')
  assert.equal(backupOwnership({ ...mine, sourceAppsDir: '/Volumes/Other/A' }, { appsDir: '/Users/dev/A', stateRoot: '/Users/dev/.glasspane' }).ok, false, '换了目录必须判不成')
  const legacy = backupOwnership({ version: '1.4.0' }, { appsDir: '/Users/dev/A', stateRoot: '/Users/dev/.glasspane' })
  assert.equal(legacy.ok, true, '旧备份没有这两个字段：归属未知，不是冒充别人')
  assert.equal(legacy.unknown, true, '而未知必须读得出来，否则下一次改这段的人会把它当"核对通过"')
})

/* ------------------------------------------------------------------ S8-2 */

/** A machine with 1.4.0 installed and 1.4.1 staged, with a real archive behind the offer. */
function stagedFixture(label, { stagedVersion = '1.4.1' } = {}) {
  const dir = tempDir(`${TMP_PREFIX}${label}-`)
  const appsDir = path.join(dir, 'Applications')
  makeFakeApp(appsDir, 'GlassPane.app', '1.4.0', { marker: 'installed' })
  makeFakeApp(appsDir, 'GlassPane Daemon.app', '1.4.0', { marker: 'installed' })
  const stagingDir = path.join(writableRoots(dir).staging, stagedVersion)
  const treePath = path.join(stagingDir, 'tree')
  fs.mkdirSync(treePath, { recursive: true, mode: 0o700 })
  const treeFiles = [{ name: 'package.json', content: JSON.stringify({ version: stagedVersion }) }]
  for (const file of treeFiles) fs.writeFileSync(path.join(treePath, file.name), file.content)
  const archive = packTarGz(treeFiles)
  fs.writeFileSync(path.join(stagingDir, ARCHIVE_FILE_NAME), archive)
  const builtDir = path.join(dir, 'built')
  for (const bundle of BUNDLES) makeFakeApp(builtDir, bundle.name, stagedVersion, { marker: 'NEW' })
  saveState(dir, nextState(emptyState({ now: NOW }), {
    status: 'staged',
    code: null,
    current: '1.4.0',
    latest: stagedVersion,
    lastCheckAt: NOW.toISOString(),
    staged: { version: stagedVersion, dir: stagingDir, digest: sha256Bytes(archive), at: NOW.toISOString() },
  }, { now: NOW }), { now: NOW })
  return {
    dir,
    stateRoot: dir,
    appsDir,
    builtDir,
    stagingDir,
    treePath,
    installedBytes: () => fs.readFileSync(path.join(appsDir, 'GlassPane Daemon.app', 'Contents', 'MacOS', 'binary'), 'utf8'),
    cleanup: () => removeDir(dir),
  }
}

/**
 * What `updater check` writes when it finishes inside another run's window, as a real write: a real 1.4.2
 * tree, a real archive, the sha256 of those bytes, and the row `check` appends. Reusing `nextState` +
 * `saveState` (not a hand-made object) is what makes this a third-party write and not a fixture talking to
 * itself.
 */
function concurrentCheck(fx, at) {
  const version = '1.4.2'
  const stagingDir = path.join(writableRoots(fx.stateRoot).staging, version)
  const treePath = path.join(stagingDir, 'tree')
  fs.mkdirSync(treePath, { recursive: true, mode: 0o700 })
  const files = [{ name: 'package.json', content: JSON.stringify({ version }) }]
  for (const one of files) fs.writeFileSync(path.join(treePath, one.name), one.content)
  const archive = packTarGz(files)
  fs.writeFileSync(path.join(stagingDir, ARCHIVE_FILE_NAME), archive)
  const digest = sha256Bytes(archive)
  saveState(fx.stateRoot, nextState(loadState(fx.stateRoot).state, {
    status: 'staged',
    code: null,
    latest: version,
    lastCheckAt: at.toISOString(),
    staged: { version, dir: stagingDir, digest, at: at.toISOString() },
    historyEntry: { action: 'check', result: 'staged', digest, code: null },
  }, { now: at }), { now: at })
  // The other half of what a real check does: the offer it replaced is thrown away with its tree.
  fs.rmSync(fx.stagingDir, { recursive: true, force: true })
  return { version, dir: stagingDir, digest }
}

test('a check that landed during the build is still in the record after a rolled-back apply', async () => {
  const fx = stagedFixture('lane8-concurrent')
  const socketPath = shortSocketPath(fx.dir, 'rb.sock')
  // A daemon that answers a *different* version over a real socket: the swap rolls back for real.
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '9.9.9' })
  const buildAt = new Date(NOW.getTime() + 600_000)
  let offer = null
  try {
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500, handshakeBudgetMs: 300 },
      job: { ok: true, args: ['glasspaned', '--socket-path', socketPath] },
      build: () => {
        offer = concurrentCheck(fx, buildAt)
        return { ok: true, builtDir: fx.builtDir, message: null }
      },
      kickstart: async () => ({ ok: true, message: 'restarted' }),
      toolsList: async () => ({ ok: true, count: 16, tools: ['gp_probe_status'] }),
      npm: () => ({ ok: true, code: null, message: null, packed: [], original: {}, installed: {}, wanted: {} }),
      refreshRuntimeImpl: null, // §11 的那一步会 spawn 新 updater 并改 pointer：这一条测的是 apply，不是它

    })
    assert.equal(result.status, 'rolled-back', `这条走的是握手不符的真回滚：${result.message}`)
    assert.equal(exitCodeFor(result), EXIT.ROLLED_BACK)
    const state = loadState(fx.stateRoot).state
    assert.equal(state.current, '1.4.0', '回滚把版本写回 baseline，这一半原来就是对的')
    assert.equal(state.lastCheckAt, buildAt.toISOString(), `build 那几分钟里那次 check 的时刻不能被开跑时的旧文档洗掉：${state.lastCheckAt}`)
    assert.equal(state.staged?.version, offer?.version, '新报价必须在：洗掉它等于让面板丢掉一个活的升级')
    assert.equal(state.staged?.digest, offer?.digest, '报价连着它自己的 digest，不是只留个版本号')
    assert.equal(String(state.staged?.dir ?? '') === fx.stagingDir, false, '被 sweep 删掉树的旧报价不许复活')
    assert.equal(fs.existsSync(fx.stagingDir), false, '旧那份树确实不在盘上了（这条断言让上一条不是空话）')
    const rows = state.history.map((row) => `${row.action}:${row.result}`)
    assert.ok(rows.some((row) => row === 'check:staged'), `那一次 check 的行不能被抹掉：${JSON.stringify(rows)}`)
    assert.ok(rows.some((row) => row === 'rollback:rolled-back'), `这一次的行也要在：${JSON.stringify(rows)}`)
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a build that failed after a concurrent check keeps that check\'s own record', async () => {
  const fx = stagedFixture('lane8-buildfail')
  const socketPath = shortSocketPath(fx.dir, 'bf.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  const buildAt = new Date(NOW.getTime() + 900_000)
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
      build: () => {
        concurrentCheck(fx, buildAt)
        return { ok: false, builtDir: null, message: 'swift build -c release exited 1: a compiler error' }
      },
      kickstart: async () => ({ ok: true }),
      npm: () => ({ ok: true, code: null, message: null, packed: [], original: {}, installed: {}, wanted: {} }),
      refreshRuntimeImpl: null, // §11 的那一步会 spawn 新 updater 并改 pointer：这一条测的是 apply，不是它

    })
    assert.equal(result.status, 'staged-build-failed', result.message)
    const state = loadState(fx.stateRoot).state
    assert.equal(state.status, 'staged-build-failed')
    assert.equal(state.lastCheckAt, buildAt.toISOString(), `失败的那一行也是回写：它同样坐在 build 窗口后面（${state.lastCheckAt}）`)
    assert.equal(state.staged?.version, '1.4.2', '那份新报价也不能被这份旧文档整档覆盖掉')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

/* ------------------------------------------------------------------ S8-3 */

/** A pid that is certainly gone: a real child this test spawned and that really exited. */
/** Is this pid certainly gone, by the same probe the sweep itself uses? */
function pidIsDead(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/**
 * A pid that is certainly dead: a real child this test spawned and that really exited, verified with `ESRCH`
 * (so the fixture is a fact about the machine, not a number this file invented). `skip` walks past pids the
 * caller already used, because the tests need two distinct ones.
 */
async function aDeadPid(skip = []) {
  const child = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' })
  const born = child.pid
  await new Promise((resolve) => child.on('exit', resolve))
  let pid = born
  while (skip.includes(pid) || !pidIsDead(pid)) pid += 1
  assert.ok(pidIsDead(pid), `夹具必须交出一个真的没了的 pid：${pid}`)
  return pid
}

test('an .old- copy the disk will not give up is in the apply record, by name', async () => {
  const fx = stagedFixture('lane8-residue')
  const socketPath = shortSocketPath(fx.dir, 'ok.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  try {
    // A permission state a real install can reach (an interrupted chmod, a read-only subvolume): entries
    // inside the previous bundle's `Contents` cannot be unlinked, so the post-swap `rmSync` fails. No
    // injected fs, no monkey-patched `rmSync` — the EACCES comes off the syscall.
    fs.chmodSync(path.join(fx.appsDir, 'GlassPane.app', 'Contents'), 0o500)
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500, handshakeBudgetMs: 300 },
      job: { ok: true, args: ['glasspaned', '--socket-path', socketPath] },
      build: () => ({ ok: true, builtDir: fx.builtDir, message: null }),
      kickstart: async () => ({ ok: true, message: 'restarted' }),
      toolsList: async () => ({ ok: true, count: 16, tools: ['gp_probe_status'] }),
      npm: () => ({ ok: true, code: null, message: null, packed: [], original: {}, installed: {}, wanted: {} }),
      refreshRuntimeImpl: null, // §11 的那一步会 spawn 新 updater 并改 pointer：这一条测的是 apply，不是它

    })
    assert.equal(result.status, 'applied', `换版本身是成功的，残留是磁盘事实不是判决：${result.message}`)
    assert.match(fx.installedBytes(), /NEW/, '新的一份确实装着')
    const aside = fs.readdirSync(fx.appsDir).filter((name) => /^GlassPane\.app\.old-\d+/.test(name))
    assert.equal(aside.length, 1, `那一份旧的必须还在盘上（这条断言让下面两句不是空话）：${fs.readdirSync(fx.appsDir).join(', ')}`)
    assert.match(result.message, new RegExp(aside[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `apply 的答复里必须读得到残留名：${result.message}`)
    assert.match(result.message, /could not be removed/, `要说清是哪一步没成：${result.message}`)
    // …and it must not *cost* the swap: a complete landed bundle is a success whatever the leftover costs.
    const state = loadState(fx.stateRoot).state
    assert.equal(state.status, 'applied', JSON.stringify(state))
    assert.equal(state.code, null, '一份删不掉的旧副本不是拒绝，也不许是一个新判决码')
    assert.equal(state.current, '1.4.1', '版本记录照旧前进')
  } finally {
    unlockTree(fx.dir)
    await daemon.close()
    fx.cleanup()
  }
})

test('the same residue is in the record when the run ends in a code the panel quotes', async () => {
  const fx = stagedFixture('lane8-residue-rollback')
  const socketPath = shortSocketPath(fx.dir, 'bad.sock')
  // A daemon that answers a different version: the run ends `rolled-back`, which does carry `lastError`.
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '9.9.9' })
  try {
    fs.chmodSync(path.join(fx.appsDir, 'GlassPane.app', 'Contents'), 0o500)
    const result = await applyUpdate({
      stateRoot: fx.stateRoot,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 500, handshakeBudgetMs: 300 },
      job: { ok: true, args: ['glasspaned', '--socket-path', socketPath] },
      build: () => ({ ok: true, builtDir: fx.builtDir, message: null }),
      kickstart: async () => ({ ok: true, message: 'restarted' }),
      toolsList: async () => ({ ok: true, count: 16, tools: ['gp_probe_status'] }),
      npm: () => ({ ok: true, code: null, message: null, packed: [], original: {}, installed: {}, wanted: {} }),
      refreshRuntimeImpl: null, // §11 的那一步会 spawn 新 updater 并改 pointer：这一条测的是 apply，不是它

    })
    assert.equal(result.status, 'rolled-back', result.message)
    const aside = fs.readdirSync(fx.appsDir).filter((name) => /^GlassPane\.app\.old-\d+/.test(name))
    assert.ok(aside.length > 0, `这一份的 rm 失败要被说出来：${fs.readdirSync(fx.appsDir).join(', ')}`)
    const quoted = aside[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(result.message, new RegExp(quoted), `答复里两个事实都要在：${result.message}`)
    const lastError = loadState(fx.stateRoot).state.lastError
    assert.ok(lastError, 'rolled-back 是带 code 的记录，面板逐字印的就是这一句')
    assert.match(String(lastError.message), new RegExp(quoted), `记录里也要有：${JSON.stringify(lastError)}`)
  } finally {
    unlockTree(fx.dir)
    await daemon.close()
    fx.cleanup()
  }
})

test('the sweep takes an .old- copy that duplicates what is installed and keeps one it cannot prove spare', async () => {
  const root = tempDir(`${TMP_PREFIX}lane8-sweep-`)
  const appsDir = path.join(root, 'Applications')
  for (const bundle of BUNDLES) makeFakeApp(appsDir, bundle.name, '1.4.0', { marker: 'installed' })
  const built = path.join(root, 'built')
  for (const bundle of BUNDLES) makeFakeApp(built, bundle.name, '1.4.1', { marker: 'NEW' })
  const dead = await aDeadPid([process.pid])
  const other = await aDeadPid([dead, process.pid])
  assert.ok(dead !== other && other !== process.pid && dead !== process.pid, `三个名字必须是三个进程：${dead} ${other} ${process.pid}`)
  const notes = []
  const liveBundle = path.join(appsDir, 'GlassPane.app')
  try {
    // (a) byte-identical to the live name ⇒ spare, goes.
    const redundant = path.join(appsDir, `GlassPane.app.old-${dead}`)
    fs.cpSync(liveBundle, redundant, { recursive: true })
    // (b) different bytes ⇒ possibly the only copy of something, stays and is named.
    const unique = path.join(appsDir, `GlassPane.app.old-${other}`)
    fs.cpSync(liveBundle, unique, { recursive: true })
    fs.writeFileSync(path.join(unique, 'Contents', 'MacOS', 'binary'), 'the only copy of something older')
    // (c) a live pid ⇒ somebody could be mid-swap right now, stays and is named.
    const living = path.join(appsDir, `GlassPane.app.old-${process.pid}`)
    fs.cpSync(liveBundle, living, { recursive: true })
    const outcome = installBundles({ builtDir: built, appsDir, bundles: BUNDLES, copyFn: defaultCopy, copyNotes: notes })
    assert.equal(outcome.ok, true, JSON.stringify(outcome.failures))
    assert.equal(fs.existsSync(redundant), false, '和现装的那份逐字节相同的 .old- 就是多出来的一份，清扫必须带走它')
    assert.equal(fs.existsSync(unique), true, '内容不同的一份不能删：它可能是这台机器上唯一还留着旧字节的地方')
    assert.equal(fs.existsSync(living), true, '还活着的那一份是别人正要用它')
    const text = notes.join('\n')
    assert.match(text, new RegExp(`GlassPane\\.app\\.old-${other}`), `留下来的那些要点名：${text}`)
    assert.match(text, new RegExp(`GlassPane\\.app\\.old-${process.pid}`), `活着的那一份也要点名：${text}`)
    assert.doesNotMatch(text, new RegExp(`GlassPane\\.app\\.old-${dead}(?!\\d)`), '删掉了的不许再报一遍')
    assert.match(fs.readFileSync(path.join(liveBundle, 'Contents', 'MacOS', 'binary'), 'utf8'), /NEW/, '清扫不许把换版本身拖下水')
  } finally {
    removeDir(root)
  }
})

test('a recycled pid cannot make the next swap die on ENOTEMPTY', async () => {
  const root = tempDir(`${TMP_PREFIX}lane8-pid-`)
  const appsDir = path.join(root, 'Applications')
  for (const bundle of BUNDLES) makeFakeApp(appsDir, bundle.name, '1.4.0', { marker: 'installed' })
  const built = path.join(root, 'built')
  for (const bundle of BUNDLES) makeFakeApp(built, bundle.name, '1.4.1', { marker: 'NEW' })
  const notes = []
  try {
    // The exact collision pid reuse produces: an `.old-<this pid>` an earlier run of this same pid left
    // behind, holding different bytes so the sweep may not delete it. Before the aside name had a tail, the
    // swap's own `renameSync(target, aside)` died here with ENOTEMPTY on a directory this run did not make.
    const stale = path.join(appsDir, `GlassPane.app.old-${process.pid}`)
    fs.cpSync(path.join(appsDir, 'GlassPane.app'), stale, { recursive: true })
    fs.writeFileSync(path.join(stale, 'Contents', 'MacOS', 'binary'), 'left behind by the recycled number')
    const outcome = installBundles({ builtDir: built, appsDir, bundles: BUNDLES, copyFn: defaultCopy, copyNotes: notes })
    assert.deepEqual(outcome.failures, [], `改名撞上别人留下的那一份不是安装失败：${JSON.stringify(outcome.failures)}`)
    assert.match(fs.readFileSync(path.join(appsDir, 'GlassPane.app', 'Contents', 'MacOS', 'binary'), 'utf8'), /NEW/)
    assert.equal(fs.existsSync(stale), true, '那一份旧的还在（内容不同，清扫无权删）')
    assert.match(notes.join('\n'), /GlassPane\.app\.old-/, `而它必须被说出来，不是留在盘上没人知道：${notes.join(' | ')}`)
    // …and the swap that could not delete it landed under a *second* name, so the next run has a free aside.
    assert.equal(fs.readdirSync(appsDir).filter((n) => /^GlassPane\.app\.old-\d+$/.test(n)).length, 1, notes.join(' | '))
  } finally {
    removeDir(root)
  }
})

/**
 * The sweep's other half of the same housekeeping, kept as its own test because it is the one behaviour of
 * the *old* code this rewrite must not lose: a `.new-` this very pid left behind is a half tree, and copying
 * a second bundle into a name that already holds one is the half-bundle outcome the whole function refuses.
 */
test('a .new- copy left by this same pid is swept, not copied into', async () => {
  const root = tempDir(`${TMP_PREFIX}lane8-inflight-`)
  const appsDir = path.join(root, 'Applications')
  for (const bundle of BUNDLES) makeFakeApp(appsDir, bundle.name, '1.4.0', { marker: 'installed' })
  const built = path.join(root, 'built')
  for (const bundle of BUNDLES) makeFakeApp(built, bundle.name, '1.4.1', { marker: 'NEW' })
  try {
    const half = path.join(appsDir, `GlassPane.app.new-${process.pid}`)
    fs.cpSync(path.join(appsDir, 'GlassPane.app'), half, { recursive: true })
    fs.writeFileSync(path.join(half, 'Contents', 'from-the-interrupted-copy.txt'), 'a half copy')
    defaultCopy(path.join(built, 'GlassPane.app'), path.join(appsDir, 'GlassPane.app'))
    assert.equal(fs.existsSync(half), false, '自己这一份没跑完的拷贝要被清扫带走')
    const landed = fs.readdirSync(path.join(appsDir, 'GlassPane.app', 'Contents'))
    assert.deepEqual(landed.filter((n) => n.includes('from-the-interrupted')), [], `装好的那份里不许有半份的东西：${landed}`)
    assert.match(fs.readFileSync(path.join(appsDir, 'GlassPane.app', 'Contents', 'MacOS', 'binary'), 'utf8'), /NEW/)
  } finally {
    removeDir(root)
  }
})

/* ------------------------------------------------------------------ S8-4 */

test('a real child that runs past its budget is a timeout, and says how long it got', () => {
  // No stub anywhere in this test: a real `/bin/sh` child, `spawnSync`'s own timeout, the shape the OS
  // answers with. Measured here (node v26) before writing the assertion:
  //   {status:null, signal:'SIGTERM', error:{code:'ETIMEDOUT'}}
  const got = defaultRun('/bin/sh', ['-c', 'sleep 30'], { timeoutMs: 300 })
  assert.equal(got.timedOut, true, JSON.stringify(got))
  assert.equal(got.status, null, `超时不是 127：${JSON.stringify(got)}`)
  assert.equal(got.notFound, undefined, '更不许被读成"命令找不到"')
  assert.equal(got.timedOutMs, 300, JSON.stringify(got))
  assert.equal(got.killed, 'SIGTERM', `要说清终止了哪一层（实测的形状）：${JSON.stringify(got)}`)
  assert.match(got.stderr, /300ms/, `跑了多久必须读得出来：${got.stderr}`)
  assert.match(got.stderr, /without answering/, got.stderr)
  assert.doesNotMatch(got.stderr, /exited 127|127/, `不许出现那个哨兵数：${got.stderr}`)
  assert.match(got.stderr, /may still be running|may still be holding/, `它自己起的子进程活没活著要说出来：${got.stderr}`)
})

test('a real child that ignores the kill is still a timeout, and is named as still running', () => {
  // The second measured shape, from `sh -c 'trap "" TERM; sleep 3'`:
  //   {status:0, signal:null, error:{code:'ETIMEDOUT'}}
  // i.e. `spawnSync` gave up on a child that is alive and answered nothing. Reading its exit code as an
  // answer is the other half of the old bug, so this test runs the survivor on purpose.
  const got = defaultRun('/bin/sh', ['-c', 'trap "" TERM; sleep 3'], { timeoutMs: 300 })
  assert.equal(got.timedOut, true, JSON.stringify(got))
  assert.equal(got.status, null, `一个从没答话的进程退出码不算答案：${JSON.stringify(got)}`)
  assert.equal(got.killed, null, `没终止成就是没终止成，不许假裝发了信号：${JSON.stringify(got)}`)
  assert.match(got.stderr, /did not answer the kill|may still be running/, got.stderr)
})

test('the shape the ledger names, injected at the spawn seam, is a timeout at every call site', () => {
  // The stub answers exactly one argv — the real `sh -c sleep` call `buildStagedTree` makes below — and
  // refuses anything else, so it cannot endorse a path it was not built for.
  const calls = []
  const stub = (command, args, options) => {
    calls.push({ command, args, timeout: options.timeout })
    if (command !== '/bin/sh' || args[0] !== '-c' || args[1] !== 'sleep 99') {
      throw new Error(`this stub answers one spawn only, got ${command} ${JSON.stringify(args)}`)
    }
    return { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync /bin/sh ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }
  }
  const root = tempDir(`${TMP_PREFIX}lane8-build-`)
  try {
    const stagedTree = path.join(root, 'GlassPane-1.4.1')
    fs.mkdirSync(path.join(stagedTree, 'engine', 'scripts'), { recursive: true })
    const got = buildStagedTree(stagedTree, {
      run: (bin, args, options) => {
        if (bin === 'swift') return defaultRun('/bin/sh', ['-c', 'sleep 99'], { ...options, spawn: stub })
        throw new Error(`this test builds nothing past the compiler: ${bin}`)
      },
      timeoutMs: 900_000,
    })
    assert.equal(calls.length, 1, '那一次 spawn 必须真的发生在这个调用路径上')
    assert.equal(got.ok, false, JSON.stringify(got))
    assert.match(got.message, /did not finish in this run.s time/, `构建超时要说成超时：${got.message}`)
    assert.match(got.message, /15 minutes/, `预算要说出来（buildStagedTree 给的是 15 分钟）：${got.message}`)
    assert.doesNotMatch(got.message, /127/, `判决里不许有那个数：${got.message}`)
    assert.doesNotMatch(got.message, /not found|could not be started/, `一条跑了十五分钟的命令不是"找不到 swift"：${got.message}`)
  } finally {
    removeDir(root)
  }
})

test('an unrecognised spawn error stops borrowing the not-found sentinel', () => {
  // The `{status:127}` line also swallowed every other spawn error (`E2BIG`, `ENOEXEC`, `EMFILE`). One
  // measured case for each is not the point of this test; the point is that a code this file does not know
  // cannot be reported as a code that means something else.
  const stub = (command, args) => {
    if (command !== '/bin/echo') throw new Error(`this stub answers /bin/echo only, got ${command} ${JSON.stringify(args)}`)
    return { status: null, signal: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync /bin/echo EMFILE'), { code: 'EMFILE' }) }
  }
  const got = defaultRun('/bin/echo', ['x'], { spawn: stub })
  assert.equal(got.status, null, JSON.stringify(got))
  assert.equal(got.notFound, undefined, '起不来不是找不到：这句话以前是 127，正是 binaries.js 整篇反对的读法')
  assert.equal(got.spawnFailed, true, JSON.stringify(got))
  assert.equal(got.spawnErrorCode, 'EMFILE', JSON.stringify(got))
  assert.match(got.stderr, /EMFILE/, got.stderr)
})

/* ------------------------------------------------- a fixture guard, on purpose */

test('these fixtures never write into a real home or a real Applications directory', () => {
  // Every temp root this file makes comes from `tempDir` with the suite's own prefix, and `removeDir`
  // refuses anything outside it. Pinned here because a lane that adds `os.tmpdir()`/`homeDir` by hand would
  // otherwise test against the developer's own `~/Applications`.
  assert.ok(TMP_PREFIX.startsWith('/tmp/'), TMP_PREFIX)
  assert.equal(path.basename(os.homedir()), process.env.USER ?? 'unknown')
  const probe = tempDir(`${TMP_PREFIX}lane8-guard-`)
  try {
    assert.ok(probe.startsWith(TMP_PREFIX), probe)
  } finally {
    removeDir(probe)
  }
})
