/**
 * Defects 3 and 4 (P2, 2026-10-15) in the apply sequence:
 *
 * 3. `verifyStagedBytes` read the staged archive **outside** the surrounding try, so an `EACCES` on a file
 *    that is there and unreadable threw out of the proof step instead of returning `{ok:false, reason}` like
 *    every other reason in that function — and the `return` after the `try/finally` was unreachable.
 * 4. History rows were stamped with the run-start clock while `freshestBase` merges a handover child's rows
 *    onto the same document, so the appended trail runs backwards. Proof on this machine, read from
 *    `~/.glasspane/update-state.json`:
 *      `{ at: 2026-10-03T08:44:15.959Z, action: apply, result: applied }`   ← written *after* the row below
 *      `{ at: 2026-10-03T08:47:51.731Z, action: enable, result: enabled }`  ← the handover child's own start
 *    so a reader taking the last N events sees the agent being enabled before the apply that enabled it.
 *
 * REVERSE MUTATIONS, each named at the test it reddens:
 *   · put `readArchive(archivePath)` back above the `try` —
 *     `a staged archive this run cannot read is a reason, not an exception` goes red on the throw, and
 *     `an unreadable staged archive refuses the apply in data` goes red because the refusal escapes to
 *     `cli.js`'s generic handler instead of landing as `deferred` / exit 3.
 *   · restore the unreachable `return { ok: true, … }` after the `finally` — the second test reddens on the
 *     `dead-code count` assertion in this file, which keeps the removed line from coming back.
 *   · drop the write-time `at` from `stampOnto` (the old shape, where the run clock stamps both) —
 *     `the history of a parent run and its handover child appends in the order the writes happened` goes red
 *     on the decreasing pair, with `updatedAt` still on the run clock in the passing shape.
 *   · stamp `rollbackToBackup`'s two rows with `now` again (finding 3, the same shape one function away) —
 *     `a rollback's history row is stamped at the moment it was written, not at the run's start` and
 *     `a rollback that failed still writes its row at the moment of the write` both go red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { applyUpdate, BACKUP_MANIFEST_NAME, backupBundles, rollbackToBackup, verifyStagedBytes } from '../lib/apply.js'
import { CODES, EXIT, exitCodeFor } from '../lib/codes.js'
import { ARCHIVE_FILE_NAME } from '../lib/staging.js'
import { writableRoots } from '../lib/fsutil.js'
import { sha256Bytes } from '../lib/digest.js'
import { packTarGz } from '../lib/tar.js'
import { emptyState, loadState, nextState, saveState } from '../lib/state.js'
import {
  TMP_PREFIX,
  makeFakeApp,
  removeDir,
  shortSocketPath,
  startSocketDaemon,
  tempDir,
} from './helpers.mjs'

const NOW = new Date('2026-09-27T12:00:00.000Z')
const BUNDLES = [
  { name: 'GlassPane.app', executable: path.join('Contents', 'MacOS', 'glasspane-settings') },
  { name: 'GlassPane Daemon.app', executable: path.join('Contents', 'MacOS', 'glasspaned') },
]

/** A machine with 1.4.0 installed and 1.4.1 staged: a real archive, a real tree, a real digest. */
function stagedFixture(label) {
  const dir = tempDir(`${TMP_PREFIX}${label}-`)
  const appsDir = path.join(dir, 'Applications')
  makeFakeApp(appsDir, 'GlassPane.app', '1.4.0', { marker: 'installed' })
  makeFakeApp(appsDir, 'GlassPane Daemon.app', '1.4.0', { marker: 'installed' })
  const stagingDir = path.join(writableRoots(dir).staging, '1.4.1')
  const treePath = path.join(stagingDir, 'tree')
  fs.mkdirSync(treePath, { recursive: true, mode: 0o700 })
  const treeFiles = [{ name: 'package.json', content: JSON.stringify({ version: '1.4.1' }) }]
  for (const file of treeFiles) fs.writeFileSync(path.join(treePath, file.name), file.content)
  const archive = packTarGz(treeFiles)
  fs.writeFileSync(path.join(stagingDir, ARCHIVE_FILE_NAME), archive)
  const builtDir = path.join(dir, 'built')
  for (const bundle of BUNDLES) makeFakeApp(builtDir, bundle.name, '1.4.1', { marker: 'NEW' })
  saveState(dir, nextState(emptyState({ now: NOW }), {
    status: 'staged',
    code: null,
    current: '1.4.0',
    latest: '1.4.1',
    lastCheckAt: NOW.toISOString(),
    staged: { version: '1.4.1', dir: stagingDir, digest: sha256Bytes(archive), at: NOW.toISOString() },
  }, { now: NOW }), { now: NOW })
  return {
    dir,
    appsDir,
    builtDir,
    stagingDir,
    treePath,
    archivePath: path.join(stagingDir, ARCHIVE_FILE_NAME),
    staged: loadState(dir).state.staged,
    installedBytes: () => fs.readFileSync(path.join(appsDir, 'GlassPane Daemon.app', 'Contents', 'MacOS', 'binary'), 'utf8'),
    cleanup: () => removeDir(dir),
  }
}

/** The apply call with the two steps that would touch a real machine replaced. */
function applyDeps(fx, extra = {}) {
  const socketPath = shortSocketPath(fx.dir, 'ok.sock')
  return {
    stateRoot: fx.dir,
    appsDir: fx.appsDir,
    bundles: BUNDLES,
    now: NOW,
    currentVersion: '1.4.0',
    socketPath,
    probe: { socketPath, timeoutMs: 1_000 },
    job: { ok: true, args: ['glasspaned', '--socket-path', socketPath] },
    build: () => ({ ok: true, builtDir: fx.builtDir, message: null }),
    kickstart: async () => ({ ok: true, message: 'restarted' }),
    toolsList: async () => ({ ok: true, count: 16, tools: ['gp_probe_status'] }),
    npm: () => ({ ok: true, code: null, message: null, packed: [], original: {}, installed: {}, wanted: {} }),
    refreshRuntimeImpl: undefined,
    ...extra,
  }
}

/* ------------------------------------------------------------------- defect 3 */

test('a staged archive this run cannot read is a reason, not an exception', async () => {
  const fx = stagedFixture('proof-eacces')
  try {
    const error = Object.assign(new Error(`EACCES: permission denied, open '${fx.archivePath}'`), { code: 'EACCES' })
    const verdict = await verifyStagedBytes({
      stateRoot: fx.dir,
      staged: fx.staged,
      rootPath: fx.treePath,
      readArchive: () => { throw error },
    })
    assert.equal(verdict.ok, false, JSON.stringify(verdict))
    assert.match(verdict.reason, /re-reading the staged archive failed \(EACCES/, verdict.reason)
    assert.match(verdict.reason, new RegExp(fx.archivePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '要点名读不动的那个文件')
    // The scratch copy this step makes is inside the staging directory: a refused proof must not cost disk.
    assert.deepEqual(fs.readdirSync(fx.stagingDir).filter((n) => n.includes('apply-verify')), [])
  } finally {
    fx.cleanup()
  }
})

test('an unreadable staged archive refuses the apply in data, with exit 3 and nothing swapped', async () => {
  const fx = stagedFixture('proof-eacces-apply')
  const socketPath = shortSocketPath(fx.dir, 'ok.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  const kicks = []
  let built = 0
  try {
    const error = Object.assign(new Error(`EACCES: permission denied, open '${fx.archivePath}'`), { code: 'EACCES' })
    const result = await applyUpdate(applyDeps(fx, {
      kickstart: async () => { kicks.push(1); return { ok: true, message: 'restarted' } },
      build: () => { built += 1; return { ok: true, builtDir: fx.builtDir, message: null } },
      readArchive: () => { throw error },
    }))
    assert.equal(result.ok, false)
    assert.equal(result.status, 'deferred', JSON.stringify(result))
    assert.equal(result.code, CODES.digestMismatch, result.message)
    assert.equal(exitCodeFor(result), EXIT.REFUSED, '什么都没换 ⇒ §7 的 3：一次读不动的暂存文件不是"换坏了再回滚"')
    assert.equal(built, 0, '证明没过就不许起构建')
    assert.deepEqual(kicks, [], '也不许重启 daemon')
    assert.match(fx.installedBytes(), /installed/, '装着的还是原来那一份')
    assert.equal(fs.existsSync(writableRoots(fx.dir).backup), false, '连备份都不该建')
    assert.match(result.message, /no longer the bytes "check" verified/, result.message)
    assert.match(result.message, /EACCES/, result.message)
    const state = loadState(fx.dir).state
    assert.equal(state.status, 'deferred')
    assert.equal(state.current, '1.4.0', '记录里的版本没有动')
    assert.equal(state.staged?.version, '1.4.1', '报价还在：这是这台机器读不动，不是这份发布坏了')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('the proof has no unreachable tail return left behind', () => {
  // The `return { ok: true, … }` after the `finally` was dead code: every path out of that function already
  // returned. Pinned textually because a dead `ok: true` after a `catch` is exactly the shape that comes
  // back to life when the block is moved again — and it would certify bytes that were never read.
  const raw = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib', 'apply.js'), 'utf8')
  const from = raw.indexOf('export async function verifyStagedBytes')
  assert.ok(from > 0, '找不到 verifyStagedBytes')
  const body = raw.slice(from, from + 4_000)
  const end = body.indexOf('\n}')
  assert.ok(end > 0, '函数体没抠出来，这条闸已经不作数了')
  const after = body.slice(end + 2).split('\n').slice(1, 4).join('\n')
  assert.doesNotMatch(after, /return \{ ok: true/, `try/finally 之后不该再有第二句"证明过了"：${after}`)
  // The single read of the archive sits inside the try that turns errors into data.
  const readLine = body.indexOf('archiveBytes = readArchive(archivePath)')
  const tryLine = body.indexOf('  try {')
  assert.ok(readLine > tryLine, 'readArchive 必须落在 try 里面，否则一次 EACCE 就逃出了这一步')
})

/* ------------------------------------------------------------------- defect 4 */

test('the history of a parent run and its handover child appends in the order the writes happened', async () => {
  const fx = stagedFixture('history-order')
  const socketPath = shortSocketPath(fx.dir, 'ok.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  // The machine's shape: the run's own clock is the moment it *started*, the handover child stamps its own
  // start, and the parent's last write happens later than both.
  const childClock = new Date(NOW.getTime() + 240_000)
  const writeClock = new Date(NOW.getTime() + 300_000)
  let childWrote = 0
  try {
    const result = await applyUpdate(applyDeps(fx, {
      writeClock: () => writeClock,
      refreshRuntimeImpl: () => {
        // What §11's `enable` really does: it is another process, and it writes this very file.
        const fresh = loadState(fx.dir).state
        childWrote += 1
        saveState(fx.dir, nextState(fresh, {
          historyEntry: { action: 'enable', result: 'enabled', digest: null, code: null },
        }, { now: childClock }), { now: childClock })
        return {
          record: {
            status: 'refreshed',
            version: '1.4.1',
            cliPath: '/var/tmp/gp/runtime/1.4.1/updater/cli.js',
            previousCliPath: null,
            agentVerified: true,
            at: childClock.toISOString(),
            code: null,
            detail: null,
          },
        }
      },
    }))
    assert.equal(result.status, 'applied', result.message)
    assert.equal(childWrote, 1, '交接那一次要真的写过状态文件，否则这条测的是别的东西')
    const state = loadState(fx.dir).state
    const rows = state.history.map((row) => ({ at: row.at, action: row.action, result: row.result }))
    assert.deepEqual(rows.map((r) => r.action), ['enable', 'apply'], `两行都该在，且按写的先后排：${JSON.stringify(rows)}`)
    const times = rows.map((r) => Date.parse(r.at))
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i] >= times[i - 1], `读最后 N 条的人拿到的顺序必须是写的顺序：${JSON.stringify(rows)}`)
    }
    const applied = rows.at(-1)
    assert.equal(applied.at, writeClock.toISOString(), '换版那一行的时间是这一次写落盘的时刻，不是这趟跑起来的时刻')
    assert.equal(state.history.at(-2).at, childClock.toISOString(), '子进程那一行保留它自己写下的时刻')
    assert.equal(state.updatedAt, NOW.toISOString(), 'updatedAt 仍然是这次运行的时钟：它说的是"这个记录描述的是哪一刻"')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a refusal in the same run also stamps its row with the clock of the write', async () => {
  // The gates before the swap all write a history row too, and they are the ones that can sit minutes
  // behind a `--at`-pinned run clock; a trail that puts them before the previous run's rows is the same bug.
  const fx = stagedFixture('history-refusal')
  const socketPath = shortSocketPath(fx.dir, 'ok.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  const writeClock = new Date(NOW.getTime() + 60_000)
  try {
    const result = await applyUpdate(applyDeps(fx, {
      writeClock: () => writeClock,
      npm: () => ({ ok: false, code: CODES.npmVersionMismatch, message: 'npm install -g refused: the global prefix belongs to another account' }),
    }))
    assert.equal(result.ok, false)
    assert.equal(result.status, 'rolled-back', result.message)
    assert.equal(result.code, CODES.npmVersionMismatch, '这一条走的是 npm 那一步的拒绝，不是读回版本失败')
    const rows = loadState(fx.dir).state.history
    const last = rows.at(-1)
    assert.equal(last.at, writeClock.toISOString(), `拒绝的那一行也要写在真正写下的时刻：${JSON.stringify(rows)}`)
    assert.equal(loadState(fx.dir).state.updatedAt, NOW.toISOString(), '而 updatedAt 不动')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

/* ------------------------------- finding 3: the rollback path, one function away */

/**
 * `rollbackToBackup` writes its history rows at the end of a run that restored two bundles, re-probed the
 * daemon, restarted it and waited for a handshake — the longest window in this file. Stamping those rows with
 * the *run* clock (`now`, which `cli.js` may have pinned with `--at`) put them before every row written while
 * it worked: the same non-monotonic trail defect 4 was fixed for, one function away.
 *
 * REVERSE MUTATION: put `now.toISOString()` back in either row (`lib/apply.js`'s rollback-failed row and its
 * rolled-back row) and the two tests below go red on the decreasing pair.
 */
test('a rollback\'s history row is stamped at the moment it was written, not at the run\'s start', async () => {
  const fx = stagedFixture('history-rollback')
  const socketPath = shortSocketPath(fx.dir, 'rb.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.0' })
  const runClock = NOW
  const duringClock = new Date(NOW.getTime() + 120_000)
  const writeClock = new Date(NOW.getTime() + 300_000)
  try {
    const made = backupBundles({
      appsDir: fx.appsDir,
      backupRoot: writableRoots(fx.dir).backup,
      bundles: BUNDLES,
      marker: { version: '1.4.0' },
    })
    for (const bundle of BUNDLES) makeFakeApp(fx.appsDir, bundle.name, '1.4.1', { marker: 'NEW' })
    // A row that landed while this rollback was working — what the panel's reader sees *after* it.
    saveState(fx.dir, nextState(loadState(fx.dir).state, {
      historyEntry: { at: duringClock.toISOString(), action: 'check', result: 'staged', digest: null, code: null },
    }, { now: duringClock }), { now: duringClock })

    const result = await rollbackToBackup({
      stateRoot: fx.dir,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      backupDir: made.dir,
      socketPath,
      now: runClock,
      writeClock: () => writeClock,
      toolsList: async () => ({ ok: true, count: 16, tools: ['gp_probe_status'] }),
    })
    assert.equal(result.status, 'rolled-back', result.message)
    const rows = loadState(fx.dir).state.history
    const times = rows.map((row) => Date.parse(row.at))
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i] >= times[i - 1], `读最后 N 条的人拿到的顺序必须是写的顺序：${JSON.stringify(rows.map((r) => r.at))}`)
    }
    assert.equal(rows.at(-1).action, 'rollback', JSON.stringify(rows.at(-1)))
    assert.equal(rows.at(-1).at, writeClock.toISOString(), '回滚那一行的时刻是它落盘的时刻，不是这趟跑起来的时刻')
    assert.ok(Date.parse(rows.at(-1).at) > Date.parse(rows.at(-2).at), '它必须排在会话中间那一行之后')
    assert.equal(loadState(fx.dir).state.updatedAt, runClock.toISOString(), 'updatedAt 仍是运行时钟：它回答的是另一个问题')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a rollback that failed still writes its row at the moment of the write', async () => {
  const fx = stagedFixture('history-rollback-failed')
  const writeClock = new Date(NOW.getTime() + 300_000)
  const duringClock = new Date(NOW.getTime() + 120_000)
  try {
    const made = backupBundles({
      appsDir: fx.appsDir,
      backupRoot: writableRoots(fx.dir).backup,
      bundles: BUNDLES,
      marker: { version: '1.4.0' },
    })
    // The restore's own refusal: a backup this tool cannot read is the `rollback-failed` row, and that row
    // used to carry the run clock like the success did.
    fs.rmSync(path.join(made.dir, BACKUP_MANIFEST_NAME))
    saveState(fx.dir, nextState(loadState(fx.dir).state, {
      historyEntry: { at: duringClock.toISOString(), action: 'check', result: 'staged', digest: null, code: null },
    }, { now: duringClock }), { now: duringClock })
    const result = await rollbackToBackup({
      stateRoot: fx.dir,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      backupDir: made.dir,
      socketPath: null,
      now: NOW,
      writeClock: () => writeClock,
      probe: async () => ({ answered: true }),
    })
    assert.equal(result.status, 'rollback-failed', result.message)
    const rows = loadState(fx.dir).state.history
    assert.equal(rows.at(-1).action, 'rollback', JSON.stringify(rows.at(-1)))
    assert.equal(rows.at(-1).at, writeClock.toISOString(), `失败的一行也要写在真正写下的时刻：${JSON.stringify(rows)}`)
    const times = rows.map((row) => Date.parse(row.at))
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i] >= times[i - 1], `审计读者拿到的顺序必须是写的顺序：${JSON.stringify(rows.map((r) => r.at))}`)
    }
  } finally {
    fx.cleanup()
  }
})
