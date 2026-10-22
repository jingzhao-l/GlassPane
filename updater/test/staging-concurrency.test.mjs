/**
 * Defect 2 (P2, 2026-10-15): the staging directory was shared, the discard lied, and a successful apply
 * retired only its own generation.
 *
 * Machine evidence read before writing this file (`ls -la ~/.glasspane/update-staging/`, 2026-10-15):
 *   · `1.5.1/` — a full 25 MB `archive.tar.gz` plus its `tree/`, from Oct 1, under a state file that had
 *     already stamped `applied` and moved on three versions;
 *   · `1.12.0/` — an **empty** directory from Oct 11, whose state row is `check-failed /
 *     version-line-broken`: a refusal that claimed to discard its tree and left the directory standing,
 *     which is what `lib/check.js`'s `catch {}` ("nothing there to discard") made invisible.
 *
 * REVERSE MUTATIONS, each named at the test it reddens:
 *   · `writeArchive` back to the fixed `${target}.part` name —
 *     `two processes staging the same release do not share one temp file` goes red: the second `renameSync`
 *     answers `ENOENT … rename '<…>.part' -> '<…>.tar.gz'` about a temp the first had already moved.
 *   · `check.js`'s discard back to `try { discardStaging(…) } catch {}` —
 *     `a discard that did not delete is reported as a discard that did not delete` goes red: the sentence
 *     loses the leftover while the record keeps claiming the tree was thrown away.
 *   · `discardStaging` back to returning whatever `removeTreeWithin` answered —
 *     `a removal that fails comes back as data, with the bytes it left named` goes red (it throws).
 *   · apply's retirement back to `removeTreeWithin(roots.staging, staged.dir)` —
 *     `a successful apply retires the sibling generations the state no longer references` goes red (the
 *     stale `1.3.9/` stays), and `a sibling the sweep could not delete is stated, not swallowed` goes red
 *     (the swap gets reported as if the disk had been cleaned).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  ARCHIVE_FILE_NAME,
  discardStaging,
  retireStaleGenerations,
  writeArchive,
} from '../lib/staging.js'
import { runCheck } from '../lib/check.js'
import { applyUpdate } from '../lib/apply.js'
import { CODES } from '../lib/codes.js'
import { writableRoots } from '../lib/fsutil.js'
import { sha256Bytes } from '../lib/digest.js'
import { packTarGz } from '../lib/tar.js'
import { makeBytesFetcher, makeFetcher } from '../lib/source.js'
import { emptyState, loadState, nextState, saveState } from '../lib/state.js'
import { localVersion } from '../lib/version.js'
import {
  PINNED_PATH,
  TMP_PREFIX,
  bytesResponse,
  defaultTreeFiles,
  fakeGpg,
  jsonResponse,
  makeDaemonBinary,
  makeFakeApp,
  removeDir,
  shortSocketPath,
  startServer,
  startSocketDaemon,
  tempDir,
} from './helpers.mjs'

const NOW = new Date('2026-09-27T12:00:00.000Z')
const RACER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'staging-racer.mjs')
const GREEN_RUNS = {
  workflow_runs: [{ id: 42, name: 'CI', conclusion: 'success', status: 'completed', html_url: 'https://github.com/o/r/actions/runs/42' }],
  }
const NO_RUNS = { workflow_runs: [] }
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/* --------------------------------------------------------------- A: one shared temp */

test('two processes staging the same release do not share one temp file', async () => {
  const dir = tempDir(`${TMP_PREFIX}race-archive-`)
  try {
    const roots = writableRoots(dir)
    fs.mkdirSync(roots.staging, { recursive: true, mode: 0o700 })
    const archivePath = path.join(roots.staging, ARCHIVE_FILE_NAME)
    const markers = path.join(dir, 'markers')
    fs.mkdirSync(markers, { recursive: true })

    // The second process first: it writes its temp, announces that it did, and refuses to rename until this
    // process says its own rename is done. Real `node`, real files, real `renameSync`, no timing assumption —
    // every step is a file this test waits on, with a bounded wait that reports what it could not see.
    // (`spawn`, not `spawnSync`: the parent has to be able to write while the child is holding its temp.)
    const child = spawn(process.execPath, [RACER, roots.staging, archivePath, 'R', markers, 'P-renamed'], {
      env: { ...process.env, GP_RACE_BYTES: '3000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childOut = ''
    child.stdout.on('data', (chunk) => { childOut += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { childOut += chunk.toString('utf8') })
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))

    let childWrote = false
    for (let i = 0; i < 3_000 && !childWrote; i += 1) {
      childWrote = fs.existsSync(path.join(markers, 'R-wrote'))
      if (!childWrote) nap(10)
    }
    assert.ok(childWrote, `the second process never got as far as writing its temp: ${childOut}`)

    // Now this process writes the same target. With one shared temp name this write truncates the file the
    // other process is still holding, and the rename below moves it out from under it.
    writeArchive(archivePath, Buffer.from('P'.repeat(3000)), {
      stagingRoot: roots.staging,
      token: 'P',
      beforeRename: () => fs.writeFileSync(path.join(markers, 'P-writing'), 'x\n'),
    })
    fs.writeFileSync(path.join(markers, 'P-renamed'), 'renamed\n')
    const exit = await exited

    let verdict = null
    for (let i = 0; i < 3_000 && verdict === null; i += 1) {
      const file = path.join(markers, 'R-verdict.json')
      if (fs.existsSync(file)) {
        try {
          verdict = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch {
          verdict = null
        }
      } else nap(10)
    }
    assert.ok(verdict, `the second process never reported (exit ${JSON.stringify(exit)}): ${childOut}`)
    assert.equal(verdict.ok, true, `另一个进程把同一个版本暂存两次时被拒了，理由是一场文件竞态：${JSON.stringify(verdict)} / exit ${JSON.stringify(exit)}`)

    // What landed is one whole payload, not a splice of two writers, and no temp outlived either run.
    const bytes = fs.readFileSync(archivePath)
    assert.equal(bytes.length, 3000, 'no half archive')
    assert.ok(/^P+$/.test(bytes.toString('utf8')) || /^R+$/.test(bytes.toString('utf8')), `归档是两个人的一半：${bytes.slice(0, 40).toString('utf8')}…`)
    const strays = fs.readdirSync(roots.staging).filter((name) => name.includes('.part'))
    assert.deepEqual(strays, [], `两个进程各自没回收自己的临时文件：${strays.join(', ')}`)
  } finally {
    removeDir(dir)
  }
})

/* ------------------------------------------------------ B: the discard that claimed it worked */

test('a removal that fails comes back as data, with the bytes it left named', () => {
  const dir = tempDir(`${TMP_PREFIX}discard-data-`)
  try {
    const roots = writableRoots(dir)
    fs.mkdirSync(path.join(roots.staging, '1.4.1'), { recursive: true })
    fs.writeFileSync(path.join(roots.staging, '1.4.1', ARCHIVE_FILE_NAME), 'bytes')
    const gone = discardStaging({ stateRoot: dir, dir: path.join(roots.staging, '1.4.1') })
    assert.equal(gone.ok, true, JSON.stringify(gone))
    assert.equal(gone.leftBehind, false)
    assert.equal(fs.existsSync(path.join(roots.staging, '1.4.1')), false)

    // A removal that did not happen is an answer, not an exception: the caller has to be able to say it.
    // The directory is really there first, so `leftBehind: true` is read off the disk rather than asserted.
    fs.mkdirSync(path.join(roots.staging, '1.4.2'), { recursive: true })
    fs.writeFileSync(path.join(roots.staging, '1.4.2', ARCHIVE_FILE_NAME), 'bytes')
    const stuck = discardStaging({
      stateRoot: dir,
      dir: path.join(roots.staging, '1.4.2'),
      remove: () => { throw new Error('EBUSY: resource busy or locked') },
    })
    assert.equal(stuck.ok, false, JSON.stringify(stuck))
    assert.equal(stuck.leftBehind, true, '它没删掉，就得说它还在')
    assert.match(stuck.reason, /EBUSY/, stuck.reason)
    assert.match(stuck.reason, /still on disk/, stuck.reason)
    assert.equal(fs.existsSync(path.join(roots.staging, '1.4.2')), true, '注入的失败没有真的删东西')

    // A removal that "succeeded" and left the directory standing is still a failure.
    const lied = discardStaging({
      stateRoot: dir,
      dir: path.join(roots.staging, '1.4.3'),
      remove: () => path.join(roots.staging, '1.4.3'),
      existsFn: () => true,
    })
    assert.equal(lied.ok, false, JSON.stringify(lied))
    assert.match(lied.reason, /still on disk/, lied.reason)

    // The guard still guards: a target outside the staging root is a refusal to touch anything, and it
    // throws (the shape `test/tar.test.mjs` pins) rather than pretending to have deleted.
    assert.throws(() => discardStaging({ stateRoot: dir, dir: path.join(dir, '..') }), (error) => error.code === CODES.stagingEscape)
  } finally {
    removeDir(dir)
  }
})

test('a discard that did not delete is reported as a discard that did not delete', async () => {
  // Real permissions, not a stub: a directory this account cannot write into cannot have its entries
  // unlinked, so `fs.rmSync(recursive)` fails and the staged bytes stay exactly where they are. `check` used
  // to `catch {}` that and the record went on saying the tree had been discarded.
  const machine = makeMachine('discard-stuck')
  const src = await startSource({ version: '1.4.1', treeFiles: defaultTreeFiles('1.4.1', { guardExit: 1 }), runs: GREEN_RUNS })
  const target = path.join(machine.stagingOf('1.4.1'), 'locked')
  let premise = null
  try {
    const result = await runCheck({
      stateRoot: machine.dir,
      env: { GLASSPANE_UPDATE_BASE: src.server.origin },
      now: NOW,
      local: machine.local(),
      trigger: 'manual',
      fetchJson: makeFetcher(),
      fetchBytes: makeBytesFetcher(),
      signatureOpts: { runner: fakeGpg().runGpg },
      // The planting moment is the CI gate's own log line: the archive is on disk and the tree has not been
      // extracted yet, so the directory that must be deleted at the end already holds something undeletable.
      log: (line) => {
        if (!String(line).startsWith('ci run') || premise !== null) return
        fs.mkdirSync(path.join(target, 'inner'), { recursive: true })
        fs.writeFileSync(path.join(target, 'inner', 'held'), 'x')
        fs.chmodSync(target, 0o500)
        // The premise has to be checked, not assumed: if this account can still write there, there is no
        // stuck discard to be had and the test says so instead of passing on a fiction.
        try {
          fs.accessSync(target, fs.constants.W_OK)
          premise = 'writable'
        } catch {
          premise = 'locked'
        }
      },
    })
    assert.equal(premise, 'locked', '这台机器让本账号往一个 0500 目录里写，所以这里造不出一次删不掉的暂存')
    assert.equal(result.ok, false, 'the guard script above refuses this release')
    assert.equal(result.code, CODES.versionLineBroken, result.message)
    assert.match(result.message, /could not throw its own staged bytes away/, result.message)
    assert.ok(result.message.includes(machine.stagingOf('1.4.1')), `句子要点名留下来的那个目录：${result.message}`)
    assert.match(result.message, /still on disk/, result.message)
    assert.ok(fs.existsSync(machine.stagingOf('1.4.1')), '前提：那些字节确实还在磁盘上')
    const state = loadState(machine.dir).state
    assert.equal(state.staged, null, '报价仍然被清掉了——要诚实的是磁盘，不是留一个死指针')
    assert.match(state.lastError.message, /could not throw its own staged bytes away/, '面板原样印的是记录里的那一句')
  } finally {
    try {
      fs.chmodSync(target, 0o700)
    } catch {
      /* never planted, or already removed */
    }
    await src.server.close()
    machine.cleanup()
  }
})

/* ------------------------------------------------- C: two checks of one release, at once */

test('two concurrent checks of one release both land, or the one that refused names a real gate', async () => {
  const machine = makeMachine('concurrent-check')
  const src = await startSource({ version: '1.4.1', runs: GREEN_RUNS })
  try {
    const one = () => runCheck({
      stateRoot: machine.dir,
      env: { GLASSPANE_UPDATE_BASE: src.server.origin },
      now: NOW,
      local: machine.local(),
      trigger: 'manual',
      fetchJson: makeFetcher(),
      fetchBytes: makeBytesFetcher(),
      signatureOpts: { runner: fakeGpg().runGpg },
      log: () => {},
    })
    // The panel's button and the daily job: same release, same staging directory, same moment.
    const both = await Promise.all([one(), one()])
    // Measured over four rounds of this exact arrangement: **both land** — the archive temp, the keyring and
    // the version directory are each run's own, so neither run has to throw the other's bytes away. The
    // assertions below stay tolerant of the remaining windows (a run can still be refused by the other's
    // discard) and grade what must be true either way: no phantom cause, no dangling offer, no orphan temp.
    assert.ok(both.filter((r) => r.ok === true).length >= 1, `两次都没把这一版暂存下来：${JSON.stringify(both.map((r) => r.message))}`)
    const refused = both.filter((r) => r.ok !== true)
    for (const r of refused) {
      const text = String(r.message)
      // Either a gate named its own reason, or the shared-directory race is named as the cause — a bare
      // errno on a path inside `update-staging/` is the shape that used to be reported as the finding.
      assert.match(
        text,
        /version line|CI|not green|digest|checksum|signature|could not be reached|no longer|guard|could not|second update run|denied by the filesystem/,
        `一次拒绝有没有说出它自己那一道门：${JSON.stringify(r)}`,
      )
      if (/ENOENT|ENOTDIR|EEXIST/.test(text)) {
        assert.match(text, /second update run/, `一个裸 errno 不是原因，它得被说成一次可执行的下一步：${text}`)
      }
      // `EPERM`/`EACCES` is a *denied* syscall, and a denial has more than one author: blaming the second
      // run for it is the unmeasured cause (finding 7). Those must name the errno, the path, the two
      // possibilities, and the command that tells them apart.
      if (/EPERM|EACCES/.test(text)) {
        assert.doesNotMatch(text, /the usual author of that is a second update run/, `权限被拒不许被说成"多半是另一趟运行"：${text}`)
        assert.match(text, /ls -lO/, `要点名的分辨命令：${text}`)
      }
      assert.match(text, /updater check|Install update|nothing was|Nothing was/, `拒绝要留下下一步：${text}`)
    }
    // Whatever the two runs decided, the document and the disk may not disagree.
    const state = loadState(machine.dir).state
    if (state.staged) {
      assert.equal(state.staged.digest, src.digest, '记录里的摘要就是这台机器下载到的那一份')
      assert.ok(fs.existsSync(path.join(state.staged.dir, 'tree')), `状态说有一个暂存的树，而它不在磁盘上：${state.staged.dir}`)
    }
    const strays = fs.readdirSync(writableRoots(machine.dir).staging).filter((name) => name.includes('.part'))
    assert.deepEqual(strays, [], `两个并发下载各留了自己的临时文件：${strays.join(', ')}`)
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('a refused check leaves no version directory behind', async () => {
  // The shape the empty `~/.glasspane/update-staging/1.12.0/` contradicts: after a refusal the staging root
  // holds nothing at all — no directory, no archive, no temp.
  const machine = makeMachine('refuse-clean')
  const src = await startSource({ version: '1.4.1', runs: NO_RUNS })
  try {
    const result = await runCheck({
      stateRoot: machine.dir,
      env: { GLASSPANE_UPDATE_BASE: src.server.origin },
      now: NOW,
      local: machine.local(),
      trigger: 'manual',
      fetchJson: makeFetcher(),
      fetchBytes: makeBytesFetcher(),
      signatureOpts: { runner: fakeGpg().runGpg },
      log: () => {},
    })
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, CODES.ciUnverified, result.message)
    assert.deepEqual(fs.readdirSync(writableRoots(machine.dir).staging), [], 'the staging root is empty after a refusal')
    assert.equal(fs.existsSync(machine.stagingOf('1.4.1')), false)
    assert.equal(loadState(machine.dir).state.staged, null)
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

/* --------------------------------------------- D: the generations an apply owns */

test('a successful apply retires the sibling generations the state no longer references', async () => {
  const fx = stagedFixture('retire-siblings')
  const staging = writableRoots(fx.dir).staging
  // An older generation left by an earlier release, and a newer one that is somebody else's live offer.
  for (const other of ['1.3.9', '1.4.0', '1.5.0']) {
    fs.mkdirSync(path.join(staging, other, 'tree'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(staging, other, ARCHIVE_FILE_NAME), 'stale bytes')
  }
  fs.writeFileSync(path.join(staging, 'not-a-version'), 'a stray file')
  const socketPath = shortSocketPath(fx.dir, 'ok.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  try {
    const result = await applyUpdate({
      ...applyDeps(fx),
      socketPath,
      probe: { socketPath, timeoutMs: 1_000 },
    })
    assert.equal(result.status, 'applied', result.message)
    const left = fs.readdirSync(staging).sort()
    assert.ok(!left.includes('1.3.9'), `older generation still on disk: ${left.join(', ')}`)
    assert.ok(!left.includes('1.4.0'), `the version that was replaced is still on disk: ${left.join(', ')}`)
    assert.ok(!left.includes('1.4.1'), `the generation this apply installed is still on disk: ${left.join(', ')}`)
    assert.ok(left.includes('1.5.0'), `a newer offer another run may be writing must survive the sweep: ${left.join(', ')}`)
    assert.ok(left.includes('not-a-version'), 'this sweep is not a rm -rf of a directory it has not read')
    assert.doesNotMatch(String(result.message), /NOT thrown away/, result.message)
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('a sibling the sweep could not delete is stated, not swallowed', async () => {
  const fx = stagedFixture('retire-stuck')
  const staging = writableRoots(fx.dir).staging
  const socketPath = shortSocketPath(fx.dir, 'ok.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  try {
    const result = await applyUpdate({
      ...applyDeps(fx),
      socketPath,
      probe: { socketPath, timeoutMs: 1_000 },
      // The seam is the disk saying no; the verdict under test is that the record says it too.
      retireStaged: () => ({
        ok: false,
        removed: [],
        failed: [{ dir: path.join(staging, '1.3.9'), reason: 'EBUSY: resource busy or locked' }],
        skipped: [],
      }),
    })
    assert.equal(result.status, 'applied', `一次删不掉暂存目录的失败，不许把已经换好的版说成回滚：${result.message}`)
    assert.equal(result.code, null, '磁盘上的残留不是版本问题，不许改 `code`，也不新增一档退出码')
    assert.match(result.message, /were NOT thrown away/, result.message)
    assert.match(result.message, /EBUSY/, result.message)
    const state = loadState(fx.dir).state
    assert.equal(state.status, 'applied')
    assert.equal(state.current, '1.4.1')
    assert.equal(state.code, null, '一台机器上残留了几十个字节，不是一次版本问题，不该改 `code` 也不该多出一种退出码')
    // The sentence rides on the answer the command prints (`cli.js` puts it in both the plain line and the
    // `--json` line), which is where the existing §11 `kept`/`skipped` notes live too; a successful swap
    // keeps `applied` + `code: null`, and inventing a code for disk junk is out of scope here.
    assert.equal(state.lastError, null, '换版成功了，记录不该挂上一条拒绝')
    assert.equal(fs.existsSync(path.join(staging, '1.4.1')), true, '这一条测的就是"删不掉"，目录必须还在')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

test('the sweep itself: equal and older go, newer stays, and nothing outside the rule is touched', () => {
  const dir = tempDir(`${TMP_PREFIX}sweep-`)
  const staging = writableRoots(dir).staging
  try {
    for (const name of ['1.4.1', '1.4.0', '0.9.9', '1.5.0', '2.0.0', 'not-a-version']) {
      fs.mkdirSync(path.join(staging, name), { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(staging, name, ARCHIVE_FILE_NAME), 'bytes')
    }
    fs.writeFileSync(path.join(staging, 'stray.txt'), 'x')
    const seen = []
    const outcome = retireStaleGenerations({
      stateRoot: dir,
      appliedVersion: '1.4.1',
      remove: ({ dir: target }) => {
        seen.push(target)
        return { ok: true, dir: target, leftBehind: false, reason: null }
      },
    })
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.deepEqual([...seen].sort(), [
      path.join(staging, '0.9.9'),
      path.join(staging, '1.4.0'),
      path.join(staging, '1.4.1'),
    ].sort(), `相等或更老的才归它删：${seen.join(', ')}`)
    assert.ok(outcome.skipped.some((s) => s.includes('1.5.0')), `更新的暂存可能是别人正在写的报价，必须留下并且说出来：${JSON.stringify(outcome.skipped)}`)
    assert.ok(outcome.skipped.some((s) => s.includes('not-a-version')), JSON.stringify(outcome.skipped))

    // A sweep that could not decide says so as data rather than deleting by feel.
    const undecided = retireStaleGenerations({
      stateRoot: dir,
      appliedVersion: 'not-a-version',
      remove: () => ({ ok: true, dir: 'x', leftBehind: false, reason: null }),
    })
    assert.equal(undecided.ok, false, JSON.stringify(undecided))
    assert.deepEqual(undecided.removed, [], '判不出老幼就不许删')

    // A generation that could not be removed is a failed sweep, named.
    const stuck = retireStaleGenerations({
      stateRoot: dir,
      appliedVersion: '1.4.1',
      remove: ({ dir: target }) => ({ ok: false, dir: target, leftBehind: true, reason: 'EBUSY: resource busy or locked' }),
    })
    assert.equal(stuck.ok, false)
    assert.equal(stuck.failed.length, 3, JSON.stringify(stuck.failed))
    assert.match(stuck.failed[0].reason, /EBUSY/, JSON.stringify(stuck.failed))
  } finally {
    removeDir(dir)
  }
})

/* --------------------------------------------------------------------- fixtures */

const BUNDLES = [
  { name: 'GlassPane.app', executable: path.join('Contents', 'MacOS', 'glasspane-settings') },
  { name: 'GlassPane Daemon.app', executable: path.join('Contents', 'MacOS', 'glasspaned') },
]

/** The 127.0.0.1 release source, in the shape `test/check.test.mjs` builds. */
async function startSource({ version, treeFiles = null, runs = GREEN_RUNS }) {
  const files = treeFiles ?? defaultTreeFiles(version)
  const archive = packTarGz(files)
  const digest = sha256Bytes(archive)
  const tarballName = `GlassPane-${version}.tar.gz`
  const sumsName = `SHA256SUMS-${version}.txt`
  const sumsText = `${digest}  ${tarballName}\n`
  const signatureName = `${sumsName}.asc`
  const signatureBytes = Buffer.from('-----BEGIN PGP SIGNATURE-----\n\nfake armored body\n-----END PGP SIGNATURE-----\n')
  const routes = {
    [`${PINNED_PATH}/releases/latest`]: (req, res) => {
      const origin = `http://${req.headers.host}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        tag_name: `v${version}`,
        target_commitish: 'f'.repeat(40),
        assets: [
          { name: tarballName, browser_download_url: `${origin}/${tarballName}`, size: archive.length },
          { name: sumsName, browser_download_url: `${origin}/${sumsName}`, size: Buffer.byteLength(sumsText) },
          { name: signatureName, browser_download_url: `${origin}/${signatureName}`, size: signatureBytes.length },
        ],
      }))
    },
    [`/${tarballName}`]: bytesResponse(archive),
    [`/${sumsName}`]: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(sumsText)
    },
    [`/${signatureName}`]: bytesResponse(signatureBytes),
    [`${PINNED_PATH}/actions/runs`]: jsonResponse(runs),
  }
  const server = await startServer(routes)
  return { server, digest }
}

/** A machine with `currentVersion` installed, under a temp directory. */
function makeMachine(label, currentVersion = '1.4.0') {
  const dir = tempDir(`${TMP_PREFIX}check-${label}-`)
  const appsDir = path.join(dir, 'Applications')
  makeFakeApp(appsDir, 'GlassPane.app', currentVersion)
  makeFakeApp(appsDir, 'GlassPane Daemon.app', currentVersion)
  const daemonBin = makeDaemonBinary(appsDir, currentVersion)
  return {
    dir,
    appsDir,
    local: () => localVersion({
      appsDir,
      daemonExecutable: daemonBin,
      settingsAppName: 'GlassPane.app',
      daemonAppName: 'GlassPane Daemon.app',
    }),
    stagingOf: (version) => path.join(dir, 'update-staging', version),
    cleanup: () => removeDir(dir),
  }
}

/** A machine with 1.4.0 installed and 1.4.1 staged, ready for a real apply. */
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
  return { dir, appsDir, builtDir, stagingDir, cleanup: () => removeDir(dir) }
}

/**
 * The apply call with the two steps that would touch a real machine replaced: the build (a `swift build`
 * of a tree that is not a release) and the npm layer. Everything else — the re-proof of the staged bytes,
 * the backup, the copy, the swap, the read-back, the state write — runs for real.
 */
function applyDeps(fx) {
  return {
    stateRoot: fx.dir,
    appsDir: fx.appsDir,
    bundles: BUNDLES,
    now: NOW,
    currentVersion: '1.4.0',
    job: { ok: true, args: ['glasspaned', '--socket-path', '/tmp/unused.sock'] },
    build: () => ({ ok: true, builtDir: fx.builtDir, message: null }),
    kickstart: async () => ({ ok: true, message: 'restarted' }),
    toolsList: async () => ({ ok: true, count: 16, tools: ['gp_probe_status'] }),
    npm: () => ({ ok: true, code: null, message: null, packed: [], original: {}, installed: {}, wanted: {} }),
    refreshRuntimeImpl: () => ({
      record: {
        status: 'refreshed',
        version: '1.4.1',
        cliPath: '/var/tmp/gp/runtime/1.4.1/updater/cli.js',
        previousCliPath: null,
        agentVerified: true,
        at: NOW.toISOString(),
        code: null,
        detail: null,
      },
    }),
  }
}
