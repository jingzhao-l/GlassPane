/**
 * CLI 选项必须**走到用它的那行代码**，不是走到一个没人读的袋子里。
 *
 * 真机 2026-09-29 查出来的第四条：`parseArgs` 把 `--state-dir`、`--apps-dir`、`--daemon-bin`、
 * `--socket`、`--at`、`--hour`、`--minute` 全写进 `flags.overrides`，而每个消费者读的是
 * `flags['state-dir']` / `flags.at` / `flags.hour`……那个袋子**没有任何一处读过**。
 * 于是这六个参数在命令行上全部静默失效：`check --state-dir /var/tmp/x` 解析出的状态根仍是
 * 活的 `~/.glasspane`，它把整份暂存 release 写进了那里（我就是这么发现的——自己跑真机验收）。
 *
 * 单元测试为什么全绿：它们调 `runCommand({flags: {...}})` 时**直接构造**消费者读的那个形状，
 * 从没经过 `parseArgs`。缺的正是"从命令行进来"这一段，所以这一节一半的用例是**起真子进程**。
 *
 * 反向变异：把 `flags[name] = value` 放回 `flags.overrides[name]` ⇒ 第 1、2、3、4 条全红；
 * 删掉 `--at` 那一段 ⇒ 第 3 条红；`hour/minute` 不传给渲染器 ⇒ 第 4 条红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseArgs, runCommand } from '../cli.js'
import { emptyState, nextState, saveState } from '../lib/state.js'
import { DEFAULT_HOUR, DEFAULT_MINUTE } from '../lib/launchd.js'
import { TMP_PREFIX, removeDir, tempDir } from './helpers.mjs'

const CLI = path.join(import.meta.dirname, '..', 'cli.js')

function scratch(label) {
  return fs.realpathSync(tempDir(`${TMP_PREFIX}options-${label}-`))
}

function runCli(args, { env = {} } = {}) {
  const got = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  })
  return { status: got.status, stdout: String(got.stdout ?? ''), stderr: String(got.stderr ?? '') }
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

test('every documented option lands on the key its consumer reads', () => {
  const parsed = parseArgs([
    'check', '--state-dir', '/var/tmp/a', '--state-root', '/var/tmp/a', '--apps-dir', '/var/tmp/b',
    '--daemon-bin', '/var/tmp/c', '--socket', '/var/tmp/d', '--at', '2026-01-01T00:00:00Z',
    '--hour', '3', '--minute', '15', '--json',
  ])
  assert.equal(parsed.ok, true, parsed.reason)
  for (const [key, value] of Object.entries({
    'state-dir': '/var/tmp/a', 'state-root': '/var/tmp/a', 'apps-dir': '/var/tmp/b',
    'daemon-bin': '/var/tmp/c', socket: '/var/tmp/d', at: '2026-01-01T00:00:00Z', hour: '3', minute: '15',
  })) {
    assert.equal(parsed.flags[key], value, `--${key} 必须落在 flags.${key} 上（消费者读的就是这个键）`)
  }
  assert.equal('overrides' in parsed.flags, false,
    'flags.overrides 是一个没人读过的袋子：留着它，下一次又会把参数塞进没人读的地方')
})

test('the CLI as a process: --state-dir keeps the whole run off this machine\'s live state root', () => {
  const sandbox = scratch('live-')
  const liveFile = path.join(os.homedir(), '.glasspane', 'update-state.json')
  const liveBefore = fs.existsSync(liveFile) ? sha256(liveFile) : null
  try {
    const got = runCli(['status', '--state-dir', sandbox, '--json'])
    assert.equal(got.status, 0, `status 在沙盒状态下应正常回答：${got.stderr}`)
    const line = got.stdout.trim().split('\n')
    assert.equal(line.length, 1, `--json 那一行必须恰好一行，实到 ${line.length} 行：${got.stdout}`)
    const parsed = JSON.parse(line[0])
    const text = JSON.stringify(parsed)
    assert.ok(text.includes(sandbox), `报告里的路径必须是那个沙盒，实到：${text.slice(0, 200)}`)
    if (liveBefore !== null) {
      assert.ok(!text.includes(liveFile), `传了 --state-dir 却把活的状态文件路径端出来：${text.slice(0, 200)}`)
      assert.equal(sha256(liveFile), liveBefore, '一次带 --state-dir 的调用不许动这台机器的活状态——这正是 09-29 那次真机验收发生的事')
    }
    // 沙盒里没写过东西才算隔离成立：`status` 只读，但它若解析错根就会落到别处。
    assert.deepEqual(fs.readdirSync(sandbox), [], 'status 不该在沙盒里造文件')
  } finally {
    removeDir(sandbox)
  }
})

test('--at moves the clock the overdue judgement uses (process level)', () => {
  const sandbox = scratch('at-')
  try {
    const checkedAt = '2026-09-20T00:00:00.000Z'
    // 用生产写器与生产的形状造状态：手搓一个"差不多"的 JSON 会被 schema 拒，
    // 而绕过 schema 写出来的状态文件证明不了任何真机路径。
    const seed = nextState(emptyState({ now: new Date(checkedAt) }), {
      lastCheckAt: checkedAt, current: '1.5.0', latest: '1.5.1', status: 'up-to-date',
    }, { now: new Date(checkedAt) })
    saveState(sandbox, seed, { now: new Date(checkedAt) })
    const overdueOf = (at) => {
      const got = runCli(['status', '--state-dir', sandbox, '--json', ...(at ? ['--at', at] : [])])
      assert.equal(got.status, 0, got.stderr)
      return JSON.parse(got.stdout.trim()).state.overdue
    }
    // 36 小时是规格里的界线：+1h 不算过期，+40h 必须算。两个值都从 `--at` 进来。
    assert.equal(overdueOf('2026-09-20T01:00:00.000Z'), false, '检查过 1 小时就报过期，是把机器每次开机都写成事故')
    assert.equal(overdueOf('2026-09-21T16:00:00.000Z'), true, '40 小时没检查仍报不过期，那这条判据就是装饰')
  } finally {
    removeDir(sandbox)
  }
})

test('--hour and --minute reach the agent that gets registered (not just the parser)', async () => {
  const render = async (flags) => {
    const sandbox = scratch('hour-')
    const seen = []
    try {
      const outcome = await runCommand({
        command: 'enable',
        flags: { 'state-dir': sandbox, ...flags },
        env: { GLASSPANE_UPDATE_DISABLE: '' },
        deps: {
          homeDir: sandbox,
          uid: '501',
          refreshCaBundle: () => ({ status: 'ok', certs: 1, path: path.join(sandbox, 'ca-roots.pem'), exportedAt: 'now', detail: null }),
          usableCaBundle: () => ({ usable: true, certs: 1, reason: null }),
          runLaunchctl: () => ({ status: 0, stdout: '', stderr: '' }),
          registerAgent: ({ plistText }) => {
            seen.push(plistText)
            return { ok: true, message: 'registered' }
          },
        },
      })
      assert.equal(outcome.ok, true, JSON.stringify(outcome))
      assert.equal(seen.length, 1, '注册只该渲染一次')
      return seen[0]
    } finally {
      removeDir(sandbox)
    }
  }
  assert.equal(typeof DEFAULT_HOUR, 'number', '默认时刻得是真的默认值，不是测试里的字面量')
  const custom = await render({ hour: '3', minute: '15' })
  assert.match(custom, /<key>Hour<\/key>\s*<integer>3<\/integer>/, `--hour 3 没进到注册的那份 plist：\n${custom.slice(0, 400)}`)
  assert.match(custom, /<key>Minute<\/key>\s*<integer>15<\/integer>/, '--minute 15 没进到注册的那份 plist')
  const fallback = await render({})
  assert.match(fallback, new RegExp(`<key>Hour</key>\\s*<integer>${DEFAULT_HOUR}</integer>`), '不传时要用规格的默认时刻')
  assert.match(fallback, new RegExp(`<key>Minute</key>\\s*<integer>${DEFAULT_MINUTE}</integer>`), '不传时要用规格的默认分钟')
})

test('--disable / --enable are real aliases for the subcommands, not decorative switches', () => {
  assert.equal(parseArgs(['--disable', '--json']).command, 'disable', '一个承诺关掉的开关必须真的走到那条命令')
  assert.equal(parseArgs(['--enable']).command, 'enable')
  assert.equal(parseArgs(['disable', '--disable']).command, 'disable', '同一件事写两遍不是矛盾')
  assert.equal(parseArgs(['check', '--disable']).ok, false, '与别的命令同时给必须是用法错误，不能静默按其中一个办')
  assert.match(parseArgs(['check', '--disable']).reason, /cannot be combined/)
  assert.equal(parseArgs(['--disable', '--enable']).ok, false, '同时关和开不能都生效')
  assert.equal(parseArgs([]).ok, false, '光有 --json 仍然要报"没给命令"')
})

test('the process honours --disable: it writes disabled=true into the state it was pointed at', (t) => {
  const sandbox = scratch('disable-')
  const stateFile = path.join(sandbox, 'update-state.json')
  try {
    // `disable` 会 bootout 那个作业——这里用 GLASSPANE_UPDATE_DISABLE 之外的路数没法完全离线，
    // 所以只断言它**走到了那条命令**：状态文件出现在沙盒里、且写着 disabled=true。
    const got = runCli(['disable', '--state-dir', sandbox, '--json'])
    if (process.platform !== 'darwin') {
      // CI 的这台 ubuntu 上没有 `launchctl`，所以这里要断言的是**另一件事**，而且必须是真的一件事：
      // 卸不掉作业的机器不许把 `disabled=true` 写进状态然后自称关掉了。曾经这条在 Linux 上直接要求
      // `status === 0`，于是"本地绿、CI 红"——那条断言测的从来不是 `--state-dir`，而是跑它的那台机器
      // 是不是 macOS。
      assert.notEqual(got.status, 0, `没有 launchd 的机器上 disable 必须拒绝，而不是假装已经卸下作业：${got.stdout} ${got.stderr}`)
      const wrote = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null
      assert.ok(!wrote || wrote.disabled !== true,
        `拒绝的那一次不许留下一个写着"已关闭"的状态文件：${JSON.stringify(wrote).slice(0, 200)}`)
      t.skip('这一条真正要验的"状态写进 --state-dir 指的那个根"需要 launchd，CI 的 Linux 上只验到拒绝这一半')
      return
    }
    assert.equal(got.status, 0, `disable 在沙盒里应成功：${got.stderr}`)
    const parsed = JSON.parse(got.stdout.trim())
    assert.equal(parsed.command, 'disable')
    assert.equal(parsed.state.disabled, true, JSON.stringify(parsed).slice(0, 200))
    assert.ok(fs.existsSync(stateFile), '状态必须落在 --state-dir 指的那个根')
  } finally {
    removeDir(sandbox)
  }
})

/**
 * `apply` 这一条路上，"这台机器关了自动更新"与"用哪个 env 起子进程"必须由 CLI 交给 §11 那一步。
 * 这一步在单测里是被直接调用的（`apply.test.mjs` 自己传 `autoDisabled`），所以 CLI 少传一个参数
 * 不会有任何测试变红——而那正是 §11.7 唯一的执行现场。按源码形状闸住，理由与 `fileURLToPath`
 * 那一处同形：这种接线只在真跑一次换版时才露面，而换版要动这台机器。
 */
test('the apply path hands the runtime refresh the machine answer it needs', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'cli.js'), 'utf8')
  const start = source.indexOf('await applyUpdate({')
  assert.notEqual(start, -1, '找不到 apply 那一条 applyUpdate 调用（结构变了就来看这条闸是否还有效）')
  const call = source.slice(start, source.indexOf('\n      })', start))
  assert.ok(call.length > 40 && call.length < 2000, `这一段形状不对，测不到东西：${call.length} 字符`)
  assert.match(call, /\n\s*env,\n/, '§11 的注册子进程要用这次调用的 env，不是 process.env 的猜测')
  assert.match(call, /autoDisabled: envDisabled,/,
    '关掉自动更新的机器必须被说出来，否则换版顺手注册一个刚被主人取消的作业')
})
