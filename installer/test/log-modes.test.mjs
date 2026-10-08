/**
 * 状态根目录与 `installer-daemon.log` 的模式（SECURITY.md 记的"量到而未修"那一条）。
 *
 * 两个缺陷都在这里：
 *  1) `ensureLogDir` 的 `mkdirSync(dir, {recursive:true})` 没带 mode，且 mode 也只会作用在
 *     **新建**的那一层——上一轮安装留下的 `~/.glasspane` 是 0755，这一轮一个字都不改。
 *  2) `startDetached` 的 `fs.openSync(logPath, 'a')` 同样没有 mode（新建即 0644），而且它不会
 *     改**已存在**文件的模式。daemon 的启动清扫（engine/Sources/GlassPaneEngine/StateRoot.swift
 *     的 tighten 那一段）从前收紧 registry / approvals / evidence，唯独不碰这个日志——
 *     写侧由本文件管，别人（launchd）创建的那一份由最后那条跨语言漂移闸保证仍被扫到。
 *
 * 判据沿用本仓库既有的那一条（`updater/lib/fsutil.js` 的 `tightenMode` 与 release-archive 的
 * 同名测试）：**没落住的 chmod 按写失败报告**，不是"至少我们试过了"。
 *
 * REVERSE MUTATION：把 `ensureLogDir` 里的 `chmod(dir, STATE_DIR_MODE)` 与读回比对删掉 →
 * 第二、第三条红；把 `openPrivateLog` 的 `fchmodSync` + `fstatSync` 读回删掉 → 第五、第六条红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DAEMON_LOG_NAME,
  SOCKET_DIR_NAME,
  STATE_DIR_MODE,
  STATE_FILE_MODE,
  ensureLogDir,
  openPrivateLog,
  startDetached,
} from '../cli.js'

// 更新器那份日志的名字必须从**它自己的真源**读，不能在测试里再抄一遍字面量——
// 抄了就等于用第二个副本去验第一个副本。
import { AGENT_LOG_NAME } from '../../updater/lib/launchd.js'

const modeOf = (target) => fs.statSync(target).mode & 0o777

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gp-logmode-${label}-`))
}

test('ensureLogDir: 0700 是被**要求**的，也是被**读回验证**的', () => {
  const root = tempRoot('request')
  const logPath = path.join(root, SOCKET_DIR_NAME, DAEMON_LOG_NAME)
  const asked = { mkdir: [], chmod: [] }
  const result = ensureLogDir(logPath, {
    mkdir: (dir, options) => { asked.mkdir.push(options); fs.mkdirSync(dir, options) },
    chmod: (dir, mode) => { asked.chmod.push(mode); fs.chmodSync(dir, mode) },
  })
  try {
    assert.equal(result.ok, true, result.error ?? '')
    assert.equal(asked.mkdir[0]?.mode, 0o700, 'mkdir 要带 mode：默认那次 mkdir 交出来的是 0755')
    assert.deepEqual(asked.chmod, [0o700], '目录可能早就存在（上一轮的 0755），mkdir 救不了这一枪，必须补 chmod')
    assert.equal(modeOf(result.dir), 0o700, '读回来必须是 0700')
    assert.equal(result.mode, 0o700, '结论里要带着验证过的那个数')
    assert.equal(STATE_DIR_MODE, 0o700)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('ensureLogDir: 上一轮留下的 0755 状态根，这一轮要被收紧到 0700', () => {
  const root = tempRoot('loose')
  const dir = path.join(root, SOCKET_DIR_NAME)
  fs.mkdirSync(dir)
  fs.chmodSync(dir, 0o755)
  try {
    assert.equal(modeOf(dir), 0o755, '前置：这台机器上它确实是别人可读的')
    const result = ensureLogDir(path.join(dir, DAEMON_LOG_NAME))
    assert.equal(result.ok, true, result.error ?? '')
    assert.equal(modeOf(dir), 0o700, 'socket / 审批 / 证据 / 日志同目录：这一轮不许把旧模式带过去')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('ensureLogDir: chmod 没落住 = 写失败，不许继续当成功', () => {
  const result = ensureLogDir('/Users/dev/.glasspane/installer-daemon.log', {
    mkdir: () => {},
    chmod: () => {}, // 卷答应得很快，就是不存权限位
    statMode: () => 0o755,
  })
  assert.equal(result.ok, false, '「我们至少 chmod 过了」不是一句可以说成功的话')
  assert.equal(result.mode, 0o755)
  assert.equal(result.dir, '/Users/dev/.glasspane')
  assert.match(result.error, /0755/, result.error)
  assert.match(result.error, /chmod\(0700\)/, result.error)
  assert.ok(!/EACCES|No such file/.test(result.error), '这不是"目录建不出来"，是"权限存不住"，两句话必须能分开')
})

test('openPrivateLog: 新建的日志就是 0600，已存在的 0644 被收紧', () => {
  const root = tempRoot('log')
  const logPath = path.join(root, DAEMON_LOG_NAME)
  try {
    const created = openPrivateLog(logPath)
    assert.equal(created.ok, true, created.error ?? '')
    fs.writeSync(created.fd, 'line\n')
    fs.closeSync(created.fd)
    assert.equal(modeOf(logPath), 0o600, 'SECURITY.md 量到的那个 0644 就是从这条 openSync 出来的')

    fs.chmodSync(logPath, 0o644) // 上一轮留下的模式
    const reopened = openPrivateLog(logPath)
    assert.equal(reopened.ok, true, reopened.error ?? '')
    assert.equal(modeOf(logPath), 0o600, "'a' 不改已存在文件的模式，所以这里必须 fchmod 并读回")
    fs.closeSync(reopened.fd)
    assert.equal(STATE_FILE_MODE, 0o600)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('openPrivateLog: chmod 不生效时拒绝，并且把打开的 fd 关掉', () => {
  const closed = []
  const result = openPrivateLog('/Users/dev/.glasspane/installer-daemon.log', {
    open: () => 7,
    chmod: () => {},
    fstat: () => ({ mode: 0o100644 }),
    close: (fd) => closed.push(fd),
  })
  assert.equal(result.ok, false, '一份 0644 的 daemon 日志（里面有审批与证据线索）不是可以放行的形态')
  assert.match(result.error, /0644/, result.error)
  assert.match(result.error, /chmod\(0600\)/, result.error)
  assert.match(result.error, /installer-daemon\.log/, '要说清是哪个文件')
  assert.deepEqual(closed, [7], '失败也要把已经拿到的 fd 还回去')
})

test('openPrivateLog: 打不开时如实说打不开，不冒充模式问题', () => {
  const result = openPrivateLog('/Users/dev/.glasspane/installer-daemon.log', {
    open: () => { throw new Error('EACCES: permission denied') },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /日志文件打不开/, result.error)
  assert.match(result.error, /EACCES/, result.error)
})

test('startDetached: 真的起一次，日志按 0600 落地', async () => {
  const root = tempRoot('spawn')
  const logPath = path.join(root, SOCKET_DIR_NAME, DAEMON_LOG_NAME)
  try {
    const started = await startDetached('/bin/sh', ['-c', 'echo detached-child-output'], logPath, { settleMs: 250 })
    assert.equal(started.ok, true, started.error ?? '')
    assert.equal(modeOf(logPath), 0o600, '启动路径上的日志模式必须由 openPrivateLog 定住，不是由 umask 随手决定')
    assert.equal(modeOf(path.dirname(logPath)), 0o700, '兜底 mkdir 也走同一口径（直接调用方/单测路径）')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('startDetached: 日志模式做不到时不启动子进程', async () => {
  const root = tempRoot('refuse')
  const marker = path.join(root, 'should-not-exist')
  try {
    const started = await startDetached('/bin/sh', ['-c', `touch ${marker}`], path.join(root, 'daemon.log'), {
      settleMs: 50,
      openLog: () => ({ ok: false, fd: null, mode: 0o644, error: '日志文件 installer-daemon.log 在 chmod(0600) 之后仍是 0644' }),
    })
    assert.equal(started.ok, false)
    assert.equal(started.pid, null, 'ok:false 一律不回 PID')
    assert.match(started.error, /chmod\(0600\) 之后仍是 0644/, started.error)
    assert.equal(fs.existsSync(marker), false, '拒绝必须发生在 spawn 之前，而不是之后补一句警告')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('跨语言漂移闸：daemon 的启动扫描必须认这两份 launchd 日志的同一个名字', () => {
  // 这一条不是装饰。写侧各有一个名字（安装器的 `DAEMON_LOG_NAME`、更新器的
  // `AGENT_LOG_NAME`），而**别人**（launchd 自己）按 umask 创建的那一份要靠 daemon 的
  // `StateRoot.tightenPermissions` 收紧。两边各写一个文件名字面量，任何一侧改名都会让
  // 另一侧静默失效——那正是"SECURITY.md 里那条已被覆盖"变成谎话的形状，所以名字必须
  // 被两头核，而且必须核到**那张被收紧的表**里，不是只核到一个属性定义了它。
  //
  // `update.log` 是这一轮补进来的第二份：它和 `installer-daemon.log` 同病（launchd 建、
  // 走 umask、0644），内容却是这台机器装了什么、更新到哪一步、每次拒绝的理由。
  const here = path.dirname(fileURLToPath(import.meta.url))
  const stateRoot = fs.readFileSync(
    path.join(here, "..", "..", "engine", "Sources", "GlassPaneEngine", "StateRoot.swift"),
    "utf8",
  )
  const swept = /\bfiles\s*=\s*\[([^\]]*)\]/.exec(stateRoot)
  assert.ok(swept, "StateRoot.swift 里找不到那张被收紧的文件表，这条闸已经不作数了")

  const pairs = [
    { leaf: DAEMON_LOG_NAME, swift: 'installerDaemonLogFile' },
    { leaf: AGENT_LOG_NAME, swift: 'updateLogFile' },
  ]
  for (const { leaf, swift } of pairs) {
    assert.match(stateRoot, new RegExp(`child\\("${leaf}"\\)`),
      `engine/Sources/GlassPaneEngine/StateRoot.swift 里找不到 child("${leaf}")：扫描不再覆盖这份日志`)
    assert.ok(
      swept[1].split(',').map((name) => name.trim()).includes(swift),
      `${swift} 只定义了一个属性、却没进被收紧的那张表（表里是 ${swept[1].trim()}）`,
    )
  }
  assert.notEqual(DAEMON_LOG_NAME, AGENT_LOG_NAME,
    "两份 launchd 日志若同名，上面那张表就只剩一条真正被核过")
})