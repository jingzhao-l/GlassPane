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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  LAUNCHD_LABEL,
  launchctlBootstrap,
  launchdProgramFromPlistText,
  launchdPlistString,
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
