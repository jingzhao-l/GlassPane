/**
 * 2026-10-24 无人值守 · installer/updater/install.sh 修复泳道（updater 侧）。
 *
 *  - C5 `readBundleVersion` 走会 throw 的 `parsePlainVersion`，而 `readLocal()` 在
 *    `runCommand` 的 switch 里没有 try：半装/手改的 `Info.plist`（`1.20`、`1.20.1-beta`、
 *    空串）抛到 `main()` 兜底——只打 stderr、退 3、**不写状态**，面板与 gp_diagnose 读
 *    `lastError` 永远看不到这个理由。文件头的契约是 "Never throws: refusals are data"。
 *  - C6 `defaultRun` 的 `status: res.status ?? 1` 把"没答话"折成 exit 1，`stderr` 那一行
 *    在 stderr 是空白时丢掉 error 消息 → `readRunningJob` 把未观测写成未加载。
 *  - C7 探活 5s 无应答的理由句写死 "so something is queued in front of it"（一个未量到的
 *    归因），且这条 deferred 拒绝没有任何下一步。
 *  - C10 `pendingMode` 恒为 null（死分支）；重复项守卫漏掉 link。
 *  - C11 权限读数 `(mode & 0o777).toString(8)` 少前导零，与 installer 的 `formatMode()`
 *    两套读数。
 *
 * 一律注入 stub run/spawn，不调真 launchctl、不写 ~/.glasspane。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as LAUNCHD from '../lib/launchd.js'
import * as UPDATER_CLI from '../cli.js'
import { CODES, EXIT } from '../lib/codes.js'
import { UpdaterError } from '../lib/fsutil.js'
import { decideSwapPermission } from '../lib/policy.js'
import { extractTarGz, packTarGz, readTarGz } from '../lib/tar.js'
import { localVersion, readBundleVersion } from '../lib/version.js'
import { probeIdle } from '../lib/idle.js'
import { loadState } from '../lib/state.js'
import { removeDir, shortSocketPath, startSocketDaemon, tempDir, TMP_PREFIX } from './helpers.mjs'
import { formatMode as installerFormatMode } from '../../installer/cli.js'

const capture = (fn) => {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

const PLIST = (value) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key>\n<string>${value}</string>\n</dict></plist>\n`

/* ------------------------------------------------------------------ C5 */

test('C5 一份读不出的 Info.plist 是"没有读数"，不是把整条命令炸掉', () => {
  for (const value of ['1.20', '1.20.1-beta', '', 'unreleased', '  1.20.1  ']) {
    const got = capture(() => readBundleVersion('/apps/GlassPane.app', { readFile: () => PLIST(value) }))
    assert.equal(got, null, `parsePlainVersion 的 throw 逃到了读数层（${JSON.stringify(value)}）：${value}`)
  }
  assert.equal(readBundleVersion('/apps/GlassPane.app', { readFile: () => PLIST('1.20.1') }), '1.20.1')
})

test('C5 半装的机器：localVersion 回 refusal 数据并点名 installer，不抛', () => {
  const thrown = capture(() => {
    const verdict = localVersion({
      appsDir: '/apps',
      daemonExecutable: '/apps/glasspaned',
      settingsAppName: 'GlassPane.app',
      daemonAppName: 'GlassPane Daemon.app',
      run: () => ({ ok: false, status: null, stdout: '', stderr: '' }),
      readFile: (p) => (String(p).includes('Daemon.app') ? PLIST('1.20') : PLIST('1.20.1')),
    })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, CODES.versionMismatchLocal)
    assert.match(verdict.message, /installer/i, verdict.message)
  })
  assert.equal(thrown, null, `readLocal 的 throw 逃逸就是契约违约：${thrown?.message}`)
})

test('C5 readLocal 抛出时 runCommand 仍回一条 refusal 并把它落进状态（面板读得到的那一半）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-qoder20261024-c5-'))
  const sink = { lines: [], write(line) { this.lines.push(line); return true } }
  try {
    const outcome = await UPDATER_CLI.runCommand({
      command: 'check',
      flags: { 'state-dir': root },
      env: {},
      stderr: sink,
      deps: {
        homeDir: root,
        readLocal: () => {
          throw new UpdaterError(CODES.versionMismatchLocal, 'the installed bundle says 1.20 and nothing else answered')
        },
      },
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.exitCode, EXIT.REFUSED)
    assert.match(String(outcome.message), /1\.20/, JSON.stringify(outcome))
    const { state } = loadState(root)
    assert.ok(state?.lastError, `这条拒绝必须写进状态，否则面板与 gp_diagnose 读不到理由：${JSON.stringify(state)}`)
    assert.match(state.lastError.message, /1\.20/, state.lastError.message)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ C6 */

test('C6 defaultRun 不许把"launchctl 压根没答话"折成 exit 1，也不许丢掉 error 原话', () => {
  assert.equal(typeof LAUNCHD.defaultRun, 'function', 'defaultRun 要能被单读出来测它的三档')
  const silence = LAUNCHD.defaultRun('launchctl', ['print', 'gui/501/x'], {
    // 实测形状：超时被信号打断的 spawnSync——error 有话、status 是 null、stderr 是空白。
    spawn: () => ({ status: null, signal: 'SIGTERM', error: new Error('spawnSync launchctl ETIMEDOUT'), stdout: '', stderr: '   ' }),
  })
  assert.equal(silence.answered, false, JSON.stringify(silence))
  assert.equal(silence.status, null, `未答话不是退出码 1：${JSON.stringify(silence)}`)
  assert.match(silence.stderr, /ETIMEDOUT/, `stderr 空白时 error 的原话被丢了：${JSON.stringify(silence)}`)
})

test('C6 读不到 launchctl 的回答 = unverified，不是"作业未加载"', () => {
  const quiet = LAUNCHD.readRunningJob({ uid: '501', run: () => ({ status: null, stdout: '', stderr: '   ', answered: false, error: 'spawnSync launchctl ETIMEDOUT' }) })
  assert.equal(quiet.unknown, true)
  assert.equal(quiet.read, LAUNCHD.JOB_READS.unverified, JSON.stringify(quiet))
  assert.doesNotMatch(quiet.reason, /is not loaded/, `把未观测写成未加载：${quiet.reason}`)
  assert.match(quiet.reason, /没有回答|did not answer|could not be consulted/i, quiet.reason)
  assert.match(quiet.reason, /launchctl print|updater status/, `拒绝要给一条真能跑的动作：${quiet.reason}`)

  const gone = LAUNCHD.readRunningJob({
    uid: '501',
    run: () => ({ status: 113, stdout: '', stderr: 'Could not find service "com.glasspane.daemon" in domain for user gui: 501', answered: true }),
  })
  assert.equal(gone.read, LAUNCHD.JOB_READS.absent, 'launchd 明说没有这个服务，才是 absent')
  assert.equal(gone.loaded, false)

  const here = LAUNCHD.readRunningJob({
    uid: '501',
    run: () => ({ status: 0, stdout: ['gui/501/com.glasspane.daemon = {', '  program = /x/glasspaned', '  arguments = {', '    "/x/glasspaned"', '  }', '}'].join('\n'), stderr: '', answered: true }),
  })
  assert.equal(here.read, LAUNCHD.JOB_READS.available, JSON.stringify(here))
})

/* ------------------------------------------------------------------ C11 */

test('C11 拒绝里的八进制模式要能和 stat -f %Lp / ls 的读数对上（与 installer formatMode 同源）', () => {
  const dir = tempDir(`${TMP_PREFIX}c11-`)
  try {
    const target = path.join(dir, 'agent.log')
    fs.writeFileSync(target, '', { mode: 0o644 })
    const result = LAUNCHD.preparePrivateLogFile(target, {
      open: () => fs.openSync(target, 'a'),
      chmod: () => {},
      fstat: (fd) => fs.fstatSync(fd),
      close: (fd) => fs.closeSync(fd),
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /still 0644/, `少前导零的读数和 installer 那一份对不上：${result.error}`)
  } finally {
    removeDir(dir)
  }
  // installer 那份是这条判据的原主（`formatMode` 就是为了"拒绝里的数要能和 ls -l 对上"
  // 存在的）；实现里不许 import，测试里拿它当对照基准——同仓 `signature.test.mjs`、
  // `review-2026-10-09.test.mjs` 已经是这个形状。
  for (const mode of [0o644, 0o755, 0o600, 0o40, 0o777]) {
    assert.equal(LAUNCHD.formatMode(mode), installerFormatMode(mode), `同一份权限两套读数：0o${mode.toString(8)}`)
  }
})

/* ------------------------------------------------------------------ C7 */

test('C7 探活无应答的理由只说量到的事，并列可能，并给一条真能跑的动作', async () => {
  const dir = tempDir(`${TMP_PREFIX}c7-`)
  try {
    const socketPath = shortSocketPath(dir, 'silent.sock')
    const daemon = await startSocketDaemon(socketPath, { behaviour: 'silence' })
    try {
      const verdict = await probeIdle({ socketPath, timeoutMs: 250 })
      assert.equal(verdict.answered, false)
      assert.doesNotMatch(verdict.reason, /so something is queued/, `未量到的归因写成了结论：${verdict.reason}`)
      assert.match(verdict.reason, /cannot (tell|rule out)|分不开|无法区分|可能/, verdict.reason)
      assert.match(verdict.reason, /--restore-launchd|updater status|launchctl print/, `这条 deferred 要给下一步：${verdict.reason}`)
      assert.ok(daemon.requests.length === 1, '请求真的送到监听者手里了')
    } finally {
      await daemon.close()
    }
  } finally {
    removeDir(dir)
  }
})

test('C7 探活结论缺理由时的兜底那句也必须带下一步', () => {
  const decision = decideSwapPermission({ probe: { answered: false, reason: null }, jobArgs: [], ourStateRoot: '/Users/dev/.glasspane' })
  assert.equal(decision.status, 'deferred')
  assert.match(decision.reason, /updater|installer|launchctl print/, `三道门里这一道从前什么都没给：${decision.reason}`)
})

/* ------------------------------------------------------------------ C10 */

test('C10 pax 的 mode= 记录要么真的支持，要么别装出支持的样子', () => {
  const entries = readTarGz(packTarGz([
    { name: './PaxHeaders.0/run.sh', flag: 'x', content: '13 mode=0755\n' },
    { name: 'run.sh', content: '#!/bin/sh\n', mode: 0o644 },
  ]))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].mode, 0o755, `pax 声明的 mode 被丢掉了（pendingMode 恒为 null 的那条死分支）：${JSON.stringify(entries[0])}`)

  const masked = extractDirModes(packTarGz([
    { name: './PaxHeaders.0/wide', flag: 'x', content: '13 mode=4777\n' },
    { name: 'wide', content: 'x', mode: 0o644 },
  ]), 'wide')
  assert.equal(masked & 0o7000, 0, `pax 想把 setuid 带进来：0o${masked.toString(8)}`)
  assert.equal(masked & 0o022, 0, `组/其他可写位不该由档案说了算：0o${masked.toString(8)}`)

  const bogus = capture(() => readTarGz(packTarGz([
    { name: './PaxHeaders.0/a', flag: 'x', content: '12 mode=9999\n' },
    { name: 'a', content: 'x' },
  ])))
  assert.ok(bogus, '非八进制的 pax mode 必须被拒，不能静默回退')
  assert.equal(bogus.code, CODES.archiveUnreadable, bogus?.message)
})

test('C10 同一路径的重复项一律拒——link 也算一份，它会盖掉前一份字节', () => {
  const dir = tempDir(`${TMP_PREFIX}c10-dup-`)
  try {
    const dest = path.join(dir, 'tree')
    fs.mkdirSync(dest, { recursive: true })
    const fileThenLink = packTarGz([
      { name: 'icon.png', content: 'FIRST' },
      { name: 'sub/icon.png', content: 'SECOND' },
      { name: 'sub/icon.png', type: 'link', link: '../icon.png' },
    ])
    const error = capture(() => extractTarGz(fileThenLink, dest, { allowedRoot: dir }))
    assert.ok(error, '同一路径先 file 后 link 现在不报错，还把 file 那份字节覆盖掉了')
    assert.equal(error.code, CODES.archiveEntryUnsafe, error.message)
    assert.match(error.message, /two entries/, error.message)

    const linkThenLink = packTarGz([
      { name: 'icon.png', content: 'FIRST' },
      { name: 'sub/icon.png', type: 'link', link: '../icon.png' },
      { name: 'sub/icon.png', type: 'link', flag: '1', link: 'icon.png' },
    ])
    const second = capture(() => extractTarGz(linkThenLink, dest, { allowedRoot: dir }))
    assert.ok(second, '两条 link 指同一路径同样是"第二份盖第一份"')
    assert.equal(second.code, CODES.archiveEntryUnsafe, second.message)

    const legit = extractTarGz(packTarGz([
      { name: 'GlassPane-1.4.0/apple-touch-icon.png', content: 'PNG' },
      { name: 'GlassPane-1.4.0/sub/early.png', type: 'link', link: '../apple-touch-icon.png' },
    ]), dest, { allowedRoot: dir })
    assert.equal(fs.readFileSync(path.join(dest, 'GlassPane-1.4.0/sub/early.png'), 'utf8'), 'PNG', '正常的一文件一 link 不许被新守卫挡掉')
    assert.ok(legit.written.length > 0)
  } finally {
    removeDir(dir)
  }
})

function extractDirModes(bytes, name) {
  const dir = tempDir(`${TMP_PREFIX}c10-mode-`)
  try {
    extractTarGz(bytes, path.join(dir, 'tree'), { allowedRoot: dir })
    return fs.statSync(path.join(dir, 'tree', name)).mode & 0o7777
  } finally {
    removeDir(dir)
  }
}
