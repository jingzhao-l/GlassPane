/**
 * `launchctlBootstrap` 的注册/重注册判据（P6 §11 审计项④的机器化那一半）。
 *
 * 这一层以前只有 `launchdNeedsReregister` 这个纯函数被测过：真正拿着 `launchctl` 说话的那段
 * 没有注入口，于是两个缺陷一起藏在里面——
 *  1) `restoreLaunchd` 调用时不传 `desiredProgram`，比对落到 `''`，**任何**已加载作业都被判成
 *     "定义变了"→ bootout 一个健康作业（打断正在跑的 `act`），而 `boot.already` 那条快路径
 *     永远走不到。`--restore-launchd` 偏偏是安装器交给 agent 的"daemon 不可达"补救命令。
 *  2) bootout 的退出码没人看：它失败后紧随的 bootstrap 回 5 / "already loaded"，而那一支被映射
 *     成 ok:true —— 安装器于是打印"开机自启已注册"，launchd 还在按**旧定义** spawn（正是
 *     cli.js 里 EX_CONFIG 那段注释说这次设计要消灭的形态）。
 *
 * REVERSE MUTATION：把 `launchctlBootstrap` 的 `desiredProgram ?? readPlistProgram(...)` 改回
 * `desiredProgram`（旧形状）→ 第一条测试红；把 bootout 的退出码判断删掉 → 第三、第四条红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  LAUNCHD_LABEL,
  launchctlBootstrap,
  launchctlKickstart,
  launchdProgramFromPlistText,
  launchdPlistString,
  launchdTakeoverAfterTerminate,
  readCurrentUid,
  restoreLaunchd,
} from '../cli.js'

const NEW_BIN = '/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned'

function plistFile(dir, daemonBin = NEW_BIN) {
  const file = path.join(dir, `${LAUNCHD_LABEL}.plist`)
  fs.writeFileSync(file, launchdPlistString({
    label: LAUNCHD_LABEL,
    daemonBin,
    socketPath: '/Users/dev/.glasspane/engine.sock',
    logPath: '/Users/dev/.glasspane/installer-daemon.log',
  }))
  return file
}

/** `launchctl` / `id` 的替身：只替换**进程选择**，argv 与退出码都是测试自己摆出来的事实。 */
function fakeLaunchctl({
  loaded = true,
  loadedProgram = NEW_BIN,
  bootoutStatus = 0,
  bootoutStderr = '',
  bootstrapStatus = 0,
  bootstrapStderr = '',
} = {}) {
  const calls = []
  const spawn = (bin, args) => {
    calls.push([bin, ...args])
    if (bin === 'id') return { status: 0, stdout: '501\n', stderr: '' }
    if (args[0] === 'print') {
      if (!loaded) return { status: 113, stdout: '', stderr: 'Could not find service' }
      return { status: 0, stdout: [`gui/501/${LAUNCHD_LABEL} = {`, '    state = running', `    program = ${loadedProgram}`, '  }', '}'].join('\n'), stderr: '' }
    }
    if (args[0] === 'bootout') return { status: bootoutStatus, stdout: '', stderr: bootoutStderr }
    if (args[0] === 'bootstrap') return { status: bootstrapStatus, stdout: '', stderr: bootstrapStderr }
    return { status: 0, stdout: '', stderr: '' }
  }
  const verbs = () => calls.map((call) => (call[0] === 'id' ? 'id' : call[1]))
  return { spawn, calls, verbs }
}

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gp-launchd-${label}-`))
}

test('launchctlBootstrap: 调用方没给 desiredProgram 时，它自己从本次的 plist 读', () => {
  const dir = tempRoot('derive')
  try {
    const got = launchctlBootstrap(LAUNCHD_LABEL, plistFile(dir), { spawn: fakeLaunchctl({}).spawn })
    assert.equal(got.ok, true, got.message)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('launchctlBootstrap: 定义已与 plist 一致 → 不 bootout、不 bootstrap（already 快路径可达）', () => {
  const dir = tempRoot('match')
  const fake = fakeLaunchctl({ loadedProgram: NEW_BIN })
  try {
    // 关键形状：这就是 `restoreLaunchd` 的调用方式——只给 label 与 plistPath。
    const got = launchctlBootstrap(LAUNCHD_LABEL, plistFile(dir), { spawn: fake.spawn })
    assert.deepEqual(fake.verbs(), ['id', 'print'], '一个健康的作业一个字都不许动：bootout 会打断正在跑的 act')
    assert.equal(got.ok, true, got.message)
    assert.equal(got.already, true, 'already=true 是"什么都不用做"的那个答案')
    assert.match(got.message, /已加载/, got.message)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('launchctlBootstrap: 定义不同 → 先 bootout 再 bootstrap，两者都发生', () => {
  const dir = tempRoot('differ')
  const fake = fakeLaunchctl({ loadedProgram: '/old/build/glasspaned' })
  try {
    const got = launchctlBootstrap(LAUNCHD_LABEL, plistFile(dir), { spawn: fake.spawn })
    assert.deepEqual(fake.verbs(), ['id', 'print', 'bootout', 'bootstrap'], '真机 EX_CONFIG 那一枪：旧定义必须被卸掉才谈得上新 plist')
    assert.equal(got.ok, true, got.message)
    assert.equal(got.bootoutFailed, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('launchctlBootstrap: bootout 失败就拒绝，绝不带着旧作业去 bootstrap', () => {
  const dir = tempRoot('bootout-fail')
  const fake = fakeLaunchctl({ loadedProgram: '/old/build/glasspaned', bootoutStatus: 3, bootoutStderr: 'Boot-out failed: 3: No such process' })
  try {
    const got = launchctlBootstrap(LAUNCHD_LABEL, plistFile(dir), { spawn: fake.spawn })
    assert.equal(got.ok, false, '旧作业还在跑旧定义时，"bootstrap 回 5／already loaded"不是成功')
    assert.equal(got.bootoutFailed, true, '失败的种类要能被调用方分开说')
    assert.ok(!fake.verbs().includes('bootstrap'), `一次失败的 bootout 之后不许再 bootstrap：${JSON.stringify(fake.verbs())}`)
    assert.match(got.message, /bootout gui\/501\/com\.glasspane\.daemon/, got.message)
    assert.match(got.message, /退出码 3/, got.message)
    assert.match(got.message, /No such process/, 'launchctl 的 stderr 要原样带出来')
    // 可执行的下一步：卸干净 → 确认 print 报找不到服务 → 再重跑，三个动作都点名。
    assert.match(got.message, /launchctl print gui\/501\/com\.glasspane\.daemon/, got.message)
    assert.match(got.message, /Could not find service/, got.message)
    assert.match(got.message, /install\.sh|--restore-launchd/, got.message)
    assert.match(got.message, /旧定义/, got.message)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('launchctlBootstrap: plist 读不回来时按保守方向走（宁可重注册，不假装一致）', () => {
  const dir = tempRoot('unreadable')
  const fake = fakeLaunchctl({ loadedProgram: NEW_BIN })
  try {
    const got = launchctlBootstrap(LAUNCHD_LABEL, path.join(dir, 'does-not-exist.plist'), { spawn: fake.spawn })
    assert.deepEqual(fake.verbs(), ['id', 'print', 'bootout', 'bootstrap'], '读不到本次要装的程序路径，就不能说"已经对了"')
    assert.equal(got.ok, true, got.message)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('launchdProgramFromPlistText: 认 ProgramArguments 首项、认 Program，并把 XML 转义还原', () => {
  const rendered = launchdPlistString({
    label: LAUNCHD_LABEL,
    daemonBin: '/Users/a b/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned',
    socketPath: '/x/y.sock',
    logPath: '/x/y.log',
  })
  assert.equal(launchdProgramFromPlistText(rendered), '/Users/a b/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned')
  assert.equal(launchdProgramFromPlistText(rendered.replace(/<key>ProgramArguments<\/key>[\s\S]*?<\/array>/, '<key>Program</key>\n    <string>/single/bin</string>')), '/single/bin',
    '两种 plist 写法都得认：launchd 的 program = 报的就是这一个值')
  assert.equal(launchdProgramFromPlistText('<plist><dict></dict></plist>'), null, '读不出就是读不出，不许编一个路径')
  assert.equal(launchdProgramFromPlistText(null), null)
  const escaped = launchdPlistString({ label: LAUNCHD_LABEL, daemonBin: '/tmp/a&amp;b', socketPath: '/s', logPath: '/l' })
  assert.equal(launchdProgramFromPlistText(escaped), '/tmp/a&amp;b', '与 escapeXml 严格反序：&amp; 最后解，否则 &amp;lt; 会被多解一层')
})

test('restoreLaunchd: bootout 失败与 bootstrap 失败分开报，agent 拿到的下一步不是错的命令', async () => {
  const base = {
    plistPath: '/fake/com.glasspane.daemon.plist',
    socketPath: '/fake/engine.sock',
    existsFn: () => true,
    kickstartFn: () => ({ ok: true, message: 'kicked' }),
    waitFn: async () => true,
    helloFn: async () => ({ pid: 1, version: 'v', permissions: { accessibility: 'granted' } }),
  }
  const bo = await restoreLaunchd({
    ...base,
    bootstrapFn: () => ({
      ok: false,
      bootoutFailed: true,
      message: 'launchctl bootout gui/501/com.glasspane.daemon 未成功（退出码 3）：请手工 bootout 后重跑',
    }),
  })
  assert.equal(bo.ok, false)
  assert.equal(bo.action, 'bootout-failed', '这一档的动作是"把旧作业卸掉"，不是"再 bootstrap 一次"')
  assert.match(bo.message, /bootout gui\/501/, bo.message)
  assert.ok(!/^bootstrap 失败/.test(bo.message), '不许把 bootout 的失败套进 bootstrap 那句')

  const bf = await restoreLaunchd({ ...base, bootstrapFn: () => ({ ok: false, message: '5: Input/output error' }) })
  assert.equal(bf.action, 'bootstrap-failed', '旧的 bootstrap 那一档形状不变')
  assert.match(bf.message, /bootstrap 失败/, bf.message)
})

/* ===========================================================================
 * 2026-10-15 修复轮（installer P2 #3）：三处 `spawn('id', ['-u']).stdout.trim()`
 *
 * spawnSync 在**起不来**时给的是 `{error, status: null, stdout: undefined}`（下面那个
 * 夹具是真跑一次不存在的可执行文件照下来的，不是编的），于是 `.stdout.trim()` 抛
 * TypeError——紧跟其后那句"无法解析当前 uid（id -u 失败）…"的补救话**永远跑不到**，
 * 屏幕上只剩一个未捕获异常。同一条判据在 launchdReregisterProbe 里早就写了 `?? ""`，
 * 三处不对称。四个调用点（bootstrap / kickstart / install() 的 launchd 接管 / 只读探测）
 * 各自测一遍：注入失败探测 → 拿到那句拒绝，且一个 launchctl 都不发。
 *
 * REVERSE MUTATION：把任一处还原成 `.stdout.trim()`（不带保护）→ 对应那条测试红
 * （红的方式正是那个 TypeError，也就是缺陷本身）。
 * ========================================================================= */

/** 真 spawnSync 起不来时的那副形状：跑一次**不存在**的 `/usr/bin/id`，照它的字段做替身。
 *  断言的是前提本身——stdout 是 undefined 而不是空串，否则 `.trim()` 根本不会抛，
 *  这条缺陷就不成立（那样的话测试该在这里响，而不是在别处假装通过）。 */
function realSpawnFailureShape() {
  const ghost = spawnSync('/nonexistent/glasspane-id-probe', ['-u'], { encoding: 'utf8' })
  assert.equal(ghost.error?.code, 'ENOENT', `前提：真失败要给 error，实得 ${JSON.stringify(ghost)}`)
  // 两种平台给法都不一样，而对 `.trim()` 来说它们是同一件事：Linux 上 spawnSync 失败回
  // `stdout: null`，macOS 回 `undefined`——两者都不是字符串，`.trim()` 一样抛。
  // 钉死其中一种会让另一个平台上的这条闸整体红（CI 的 ubuntu runner 实测如此），
  // 而那与"旧写法死在 .trim() 上"这条缺陷没有任何关系。
  assert.ok(ghost.stdout === undefined || ghost.stdout === null,
    `前提：真失败时 stdout 不该是个字符串，否则 .trim() 不会抛：${JSON.stringify(ghost.stdout)}`)
  assert.equal(ghost.status, null, '前提：连退出码都没有，不能拿它当"跑过了"')
  return ghost
}

/** 只对**准备过的 argv** 回话的 id/launchctl 替身；认不出的命令直接抛——
 *  "对任何输入都答成功"的 stub 会把拒绝分支测成假绿，所以这里不留兜底。 */
function launchctlDouble({ id, print, bootout, bootstrap, kickstart } = {}) {
  const calls = []
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'id' && args.length === 1 && args[0] === '-u') {
      return id ?? { status: 0, stdout: '501\n', stderr: '' }
    }
    if (cmd === 'launchctl' && args[0] === 'print') {
      return print ?? { status: 0, stdout: `    program = ${NEW_BIN}`, stderr: '' }
    }
    if (cmd === 'launchctl' && args[0] === 'bootout') return bootout ?? { status: 0, stdout: '', stderr: '' }
    if (cmd === 'launchctl' && args[0] === 'bootstrap') return bootstrap ?? { status: 0, stdout: '', stderr: '' }
    if (cmd === 'launchctl' && args[0] === 'kickstart' && args[1] === '-k') {
      return kickstart ?? { status: 0, stdout: '', stderr: '' }
    }
    throw new Error(`替身没有准备过这条命令：${cmd} ${args.join(' ')}`)
  }
  return {
    spawn,
    calls,
    verbs: () => calls.map((call) => (call[0] === 'id' ? 'id' : `${call[1]}`)),
  }
}

test('readCurrentUid: id 起不来时回 uid:null + 原因，不抛（三处调用点共用的那一条判据）', () => {
  const failure = realSpawnFailureShape()
  const double = launchctlDouble({ id: failure })
  let got
  assert.doesNotThrow(() => { got = readCurrentUid({ spawn: double.spawn }) })
  assert.equal(got.uid, null, '读不出来就是 null，不许编一个 0 或 501 出来')
  assert.match(String(got.reason), /ENOENT/, '原因要带着真错误，供调用点拼那句补救')
  // 对照：同一副替身把 id 换成能跑出的那一副，就必须读到 501（判据不是"永远拒"）。
  const ok = readCurrentUid({ spawn: launchctlDouble({}).spawn })
  assert.equal(ok.uid, '501', JSON.stringify(ok))
  assert.equal(ok.reason, null)
})

test('launchctlBootstrap: id -u 起不来 → 拿到那句拒绝，且一个 launchctl 都不发', () => {
  const dir = tempRoot('uid-boot')
  const double = launchctlDouble({ id: realSpawnFailureShape() })
  try {
    let got
    assert.doesNotThrow(
      () => { got = launchctlBootstrap(LAUNCHD_LABEL, plistFile(dir), { spawn: double.spawn }) },
      'id 起不来必须是**一次拒绝**，不是把整条命令炸成一个未捕获 TypeError',
    )
    assert.equal(got.ok, false)
    assert.equal(got.uidUnresolved, true, '这一档要能被调用方和 bootout 失败分开')
    assert.match(got.message, /无法解析当前 uid（id -u 失败：/, got.message)
    assert.match(got.message, /gui\/<uid>\/com\.glasspane\.daemon/, '要说清拼不出的是哪个席位')
    assert.match(got.message, /没有.*launchd.*什么都没改|没有动 launchd/, got.message)
    assert.match(got.message, /xcode-select --install|ls -l \/usr\/bin\/id/, '补救必须是坐在键盘前能跑的命令')
    assert.deepEqual(double.verbs(), ['id'], 'uid 都没读出来就不许碰 launchctl（bootstrap 会拿一个空域去注册）')
    // 对照：同一个函数、同一副替身，只把 id 换回可读的那一份 → 走到 print 那一步。
    const healthy = launchctlDouble({})
    const passed = launchctlBootstrap(LAUNCHD_LABEL, plistFile(dir), { spawn: healthy.spawn })
    assert.equal(passed.ok, true, passed.message)
    assert.deepEqual(healthy.verbs(), ['id', 'print'], '对照：uid 读得到时判据照常往下走')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('launchctlKickstart: id -u 起不来 → 拒绝里有补救，不带空域去 kickstart', () => {
  const double = launchctlDouble({ id: realSpawnFailureShape() })
  let got
  assert.doesNotThrow(
    () => { got = launchctlKickstart(LAUNCHD_LABEL, { spawn: double.spawn }) },
    '这一处的 .stdout.trim() 从前会把 --restore-launchd 那条补救命令整个炸掉',
  )
  assert.equal(got.ok, false)
  assert.equal(got.uidUnresolved, true)
  assert.match(got.message, /无法解析当前 uid（id -u 失败：/, got.message)
  assert.match(got.message, /重跑本命令/, got.message)
  assert.deepEqual(double.verbs(), ['id'], 'kickstart 的域是 gui/<uid>/<label>，uid 没有就没法发')
  // 对照：uid 读得到时照常发 kickstart，且发的就是这个域。
  const healthy = launchctlDouble({})
  const passed = launchctlKickstart(LAUNCHD_LABEL, { spawn: healthy.spawn })
  assert.equal(passed.ok, true, passed.message)
  assert.deepEqual(healthy.calls, [['id', '-u'], ['launchctl', 'kickstart', '-k', `gui/501/${LAUNCHD_LABEL}`]])
})

test('launchdTakeoverAfterTerminate: id -u 起不来 → 红字那句而不是静默跳过，且不等 socket', async () => {
  const waited = []
  const waitFn = async () => { waited.push('wait'); return true }
  const double = launchctlDouble({ id: realSpawnFailureShape() })
  let got
  await assert.doesNotReject(async () => {
    got = await launchdTakeoverAfterTerminate({ socketPath: '/fake/engine.sock', spawn: double.spawn, waitFn })
  }, '接管那一步也一样：id 起不来是拒绝，不是异常')
  assert.equal(got.uid, null, 'uid:null 就是"这一轮 launchd 没接管"这个事实')
  assert.equal(got.relaunched, false)
  assert.match(got.message, /无法解析当前 uid/, got.message)
  assert.deepEqual(double.verbs(), ['id'], '没有 uid 就没有 kickstart 命令可发')
  assert.deepEqual(waited, [], '没发 kickstart 就不该去等一个不会来的接管（那是在假装有希望）')
  // 对照：uid 读得到 → 发 kickstart 并如实回报有没有接管上。
  const healthy = launchctlDouble({})
  const passed = await launchdTakeoverAfterTerminate({ socketPath: '/fake/engine.sock', spawn: healthy.spawn, waitFn })
  assert.equal(passed.uid, '501')
  assert.equal(passed.relaunched, true)
  assert.equal(passed.message, 'launchd 已按新配置接管 daemon（kickstart）')
  assert.deepEqual(healthy.calls[1], ['launchctl', 'kickstart', '-k', `gui/501/${LAUNCHD_LABEL}`])
  assert.deepEqual(waited, ['wait'], '对照：真发过 kickstart 才去等 socket')
})

