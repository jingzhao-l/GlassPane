/**
 * 每日更新作业的那份日志（`update.log`）。
 *
 * 立这一条的原因：launchd 打开 `StandardOutPath` 时走的是**进程 umask**，实测 0644，
 * 而这个文件的内容是更新器每次 check/apply 的 JSON——已装版本、暂存路径、摘要、tag、
 * GPG 判定与每一次拒绝的理由。本包对自己写的所有文件都收紧（`fsutil.writePrivateFile`），
 * 唯独这个文件不是它写的。安装器早就按同一个形状修过它的兄弟（`installer-daemon.log`：
 * 建的时候 0600 + 读回比对，chmod 落不住按写失败报告），这里补第二份。
 *
 * REVERSE MUTATION：
 *  - 把 `registerAgent` 里那段 `prepareLog` 判定删掉 → 第 3、4 条红（注册照旧成功，
 *    日志回到 0644，且"做不到 owner-only 也要注册"这条拒绝整条消失）；
 *  - 把 `preparePrivateLogFile` 的 `fstat` 读回比对删掉 → 第 2 条红；
 *  - 让 `renderAgentPlist` 与 `agentLogPath` 各写一个文件名字面量 → 第 5 条红。
 *
 * `launchctl` 在这里从不真跑：注入的 `run` 回的是记录好的输出，被测的解析与判定都是真代码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  AGENT_LABEL,
  AGENT_LOG_NAME,
  agentLogPath,
  preparePrivateLogFile,
  registerAgent,
  renderAgentPlist,
} from '../lib/launchd.js'
import { CODES } from '../lib/codes.js'
import { modeOf } from '../lib/fsutil.js'
import { removeDir, tempDir, TMP_PREFIX } from './helpers.mjs'

const printFor = (cliPath) => [
  `gui/501/${AGENT_LABEL} = {`,
  '    arguments = {',
  `        "${cliPath}"`,
  '    }',
  '}',
].join('\n')

test('preparePrivateLogFile: 新建的日志就是 0600，已存在的 0644 被收紧且字节不动', () => {
  const dir = tempDir(`${TMP_PREFIX}agentlog-create-`)
  try {
    const fresh = path.join(dir, 'a', 'update.log')
    fs.mkdirSync(path.dirname(fresh), { recursive: true })
    const first = preparePrivateLogFile(fresh)
    assert.equal(first.ok, true, first.error)
    assert.ok(fs.existsSync(fresh), '收紧不等于创建：这条只声明"文件在"，内容归 launchd 写')
    assert.equal(modeOf(fresh), 0o600, `新建的日志必须是 owner-only，实际 ${modeOf(fresh).toString(8)}`)

    // 上一轮（或 launchd 自己）留下的 0644：模式要改，已有的行一句不许丢。
    const prior = path.join(dir, 'b', 'update.log')
    fs.mkdirSync(path.dirname(prior), { recursive: true })
    fs.writeFileSync(prior, 'check: 1.8.2 apply: refused (unsigned)\n', { mode: 0o644 })
    assert.equal(modeOf(prior), 0o644)
    const again = preparePrivateLogFile(prior)
    assert.equal(again.ok, true, again.error)
    assert.equal(modeOf(prior), 0o600)
    assert.equal(
      fs.readFileSync(prior, 'utf8'),
      'check: 1.8.2 apply: refused (unsigned)\n',
      '收紧是 chmod，不是重写——审计线索一个字都不许动',
    )
  } finally {
    removeDir(dir)
  }
})

test('preparePrivateLogFile: chmod 没落住 = 失败，不许报成"至少试过了"', () => {
  const dir = tempDir(`${TMP_PREFIX}agentlog-noop-`)
  try {
    const target = path.join(dir, AGENT_LOG_NAME)
    fs.writeFileSync(target, '', { mode: 0o644 })
    let closed = 0
    const result = preparePrivateLogFile(target, {
      open: () => fs.openSync(target, 'a'),
      chmod: () => {},                      // 一台不保存权限位的卷
      fstat: (fd) => fs.fstatSync(fd),
      close: (fd) => { closed += 1; fs.closeSync(fd) },
    })
    assert.equal(result.ok, false, '卷存不住权限位时，owner-only 的日志就是做不到')
    assert.match(result.error, /still 644 after chmod\(0600\)/, result.error)
    assert.equal(closed, 1, '决定失败也要把打开的 fd 关掉')
  } finally {
    removeDir(dir)
  }
})

test('registerAgent: 把定义交给 launchd 之前，作业日志已经落成 0600', () => {
  const dir = tempDir(`${TMP_PREFIX}agentlog-register-`)
  try {
    const stateRoot = path.join(dir, 'state')
    fs.mkdirSync(stateRoot, { recursive: true })
    const logPath = agentLogPath(stateRoot)
    const cliPath = '/Users/dev/.glasspane/runtime/1.8.2/updater/cli.js'
    const calls = []
    const outcome = registerAgent({
      label: AGENT_LABEL,
      plistPath: path.join(dir, 'LaunchAgents', `${AGENT_LABEL}.plist`),
      plistText: renderAgentPlist({ cliPath, stateRoot }),
      cliPath,
      uid: '501',
      logPath,
      run: (bin, args) => {
        calls.push(args[0])
        return args[0] === 'print'
          ? { status: 0, stdout: printFor(cliPath), stderr: '' }
          : { status: 0, stdout: '', stderr: '' }
      },
    })
    assert.equal(outcome.ok, true, outcome.message)
    assert.ok(calls.includes('bootstrap'), '这一条走的是真注册路径')
    assert.equal(modeOf(logPath), 0o600, 'launchd 打开它之前，写侧就得把模式定下来')
  } finally {
    removeDir(dir)
  }
})

test('registerAgent: 日志做不到 owner-only 就不注册，并且一次 launchctl 都不碰', () => {
  // 拒绝分支必须真的能拒。这道闸要防的是"注册成功、日志 0644、没人说过"——
  // 那正是本仓在 installer-daemon.log 上栽过的那个形状。
  const dir = tempDir(`${TMP_PREFIX}agentlog-refuse-`)
  try {
    const logPath = agentLogPath(path.join(dir, 'state'))
    const calls = []
    const outcome = registerAgent({
      label: AGENT_LABEL,
      plistPath: path.join(dir, 'LaunchAgents', `${AGENT_LABEL}.plist`),
      plistText: '<plist>rendered</plist>',
      cliPath: '/Users/dev/.glasspane/runtime/1.8.2/updater/cli.js',
      uid: '501',
      logPath,
      prepareLog: () => ({ ok: false, mode: 0o644, error: 'this volume does not hold permission bits' }),
      run: (bin, args) => { calls.push(args[0]); return { status: 0, stdout: '', stderr: '' } },
    })
    assert.equal(outcome.ok, false, '做不到 owner-only 的日志，不能带着定义交给 launchd')
    assert.equal(outcome.code, CODES.stateWriteUnverified, JSON.stringify(outcome))
    assert.match(outcome.message, /does not hold permission bits/, '拒绝的理由要原样带出去')
    assert.deepEqual(calls, [], '拒绝必须发生在任何 bootout/bootstrap 之前——否则机器上少了一个作业')
  } finally {
    removeDir(dir)
  }
})

test('注册用的日志名与写进 plist 的那一份同源，一次调用里不许出现两个名字', () => {
  // 漂移的形状很具体：`StandardOutPath` 是一个推导，收紧用的是另一个字面量。
  // 两边不一致时，被扫的文件根本不是 launchd 打开的那个。
  const stateRoot = '/Users/dev/.glasspane'
  const rendered = renderAgentPlist({
    cliPath: '/Users/dev/.glasspane/runtime/1.8.2/updater/cli.js',
    stateRoot,
  })
  const inPlist = [...rendered.matchAll(/<key>Standard(?:Out|Error)Path<\/key>\s*<string>([^<]+)<\/string>/g)]
    .map((m) => m[1])
  assert.equal(inPlist.length, 2, 'stdout 与 stderr 都指向同一个文件，这一条才谈得上"同源"')
  assert.deepEqual([...new Set(inPlist)], [agentLogPath(stateRoot)])
  assert.equal(path.basename(agentLogPath(stateRoot)), AGENT_LOG_NAME)
  assert.equal(agentLogPath(''), null, '没有状态根就没有日志名，不许编一个默认路径')
})
