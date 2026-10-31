/**
 * 2026-10-24 无人值守 · installer/updater/install.sh 修复泳道（installer 侧）。
 *
 * 三条缺陷，各配一条在未改实现上必然变红的用例：
 *  - C3 `restoreLaunchd` 调 `bootstrapFn(label, resolvedPlist)` 时不传 `allowBootout`
 *    （默认 true），于是 `--restore-launchd`——产品交给 agent 的"daemon 不可达"补救命令——
 *    可以在用户应用正在 act 中途卸掉一个已加载作业且一句不问，而 `install()` 对同一个
 *    bootout 是有 `confirm` 门的。
 *  - C4 `usageText` 与两处注释仍承诺"install.sh 在 stdin 非 TTY 时已经自动补上
 *    `--no-prompt`"，而 install.sh 已改为**不代答**（review-2026-10-09.test.mjs:884 钉着）。
 *  - C9 `installBundles` 先 `remove(target)` 再 `copy`：`cpSync` 中途 ENOSPC/EACCES 就
 *    变成"旧的没了、新的是半棵"，报错只有 errno、没有下一步、没有回滚。
 *
 * 一律注入 stub spawn，不调真 launchctl / id；不落任何真实 ~/Applications。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LAUNCHD_LABEL,
  bundlePlan,
  installBundles,
  launchdPlistString,
  launchctlBootstrap,
  restoreLaunchd,
  usageText,
} from '../cli.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI_SOURCE = fs.readFileSync(path.join(HERE, '..', 'cli.js'), 'utf8')
const INSTALL_SH_SOURCE = fs.readFileSync(path.join(HERE, '..', '..', 'install.sh'), 'utf8')

const NEW_BIN = '/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned'
const OLD_BIN = '/Users/dev/previous-build/glasspaned'
const BUILD_DIR = '/repo/engine/.build/release'

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gp-qoder20261024-${label}-`))
}

function writePlist(dir, daemonBin = NEW_BIN) {
  const file = path.join(dir, `${LAUNCHD_LABEL}.plist`)
  fs.writeFileSync(file, launchdPlistString({
    label: LAUNCHD_LABEL,
    daemonBin,
    socketPath: path.join(dir, 'engine.sock'),
    logPath: path.join(dir, 'installer-daemon.log'),
  }))
  return file
}

/** `id` / `launchctl` 的替身：argv 与退出码都是测试摆出来的事实，一个真的都不发。 */
function fakeLaunchctl({ loadedProgram = OLD_BIN } = {}) {
  const calls = []
  const spawn = (bin, args) => {
    calls.push([bin, ...args])
    if (bin === 'id') return { status: 0, stdout: '501\n', stderr: '' }
    if (args[0] === 'print') {
      if (loadedProgram === null) return { status: 113, stdout: '', stderr: 'Could not find service' }
      return {
        status: 0,
        stdout: [`gui/501/${LAUNCHD_LABEL} = {`, '    state = running', `    program = ${loadedProgram}`, '  }', '}'].join('\n'),
        stderr: '',
      }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { spawn, calls, verbs: () => calls.map((c) => (c[0] === 'id' ? 'id' : c[1])) }
}

/** 把真 `launchctlBootstrap` 接到假 spawn 上：同意门要验的是**它自己**那条 bootout 判据。 */
const bootstrapThrough = (spawn) => (label, plist, opts = {}) => launchctlBootstrap(label, plist, { ...opts, spawn })

const ANSWERED_GRANTED = async () => ({ pid: 4242, version: 'v1.20.1', permissions: { accessibility: 'granted' } })

function restoreArgs(dir, plist, fake, extra = {}) {
  return {
    plistPath: plist,
    socketPath: path.join(dir, 'engine.sock'),
    existsFn: () => true,
    bootstrapFn: bootstrapThrough(fake.spawn),
    kickstartFn: () => ({ ok: true, message: 'kicked' }),
    waitFn: async () => true,
    helloFn: ANSWERED_GRANTED,
    ...extra,
  }
}

/** `confirm` 的同形替身：`autoYes` 就是它自己短路放行那一档（不落到"问人"），
 *  只有真要问人才会进 `asked`——照抄 `installer/cli.js` 里那三档的判据。 */
const consentStub = (autoYes) => {
  const asked = []
  return {
    asked,
    confirmFn: async (question, opts = {}) => {
      if (opts.autoYes === true) return true
      asked.push(question)
      return false
    },
  }
}

/* ------------------------------------------------------------------ C3 */

test('C3 --restore-launchd：需要 bootout 时先过同一道同意门——没拿到同意就一次 bootout 都不发', async () => {
  const dir = tempRoot('c3-decline')
  try {
    const plist = writePlist(dir, NEW_BIN)
    const fake = fakeLaunchctl({ loadedProgram: OLD_BIN })
    const consent = consentStub(false)
    const got = await restoreLaunchd(restoreArgs(dir, plist, fake, {
      autoYes: false,
      confirmFn: consent.confirmFn,
    }))
    assert.ok(!fake.verbs().includes('bootout'),
      `未同意就卸了已加载的健康作业（会打断正在跑的 act）：${JSON.stringify(fake.verbs())}`)
    assert.ok(!fake.verbs().includes('bootstrap'), `未同意就不该把新定义推上去：${JSON.stringify(fake.verbs())}`)
    assert.equal(got.ok, false, got.message)
    assert.equal(got.action, 'bootout-declined', `这一档要能被分开认（不是 bootstrap-failed）：${got.action}`)
    assert.equal(consent.asked.length, 1, `同意门必须问一次：${JSON.stringify(consent.asked)}`)
    assert.match(consent.asked[0], /打断/, `问句要说清代价：${consent.asked[0]}`)
    assert.match(got.message, /--restore-launchd/, `拒绝要给确切命令：${got.message}`)
    assert.match(got.message, /--no-prompt/, `非交互调用方要给旗标那条：${got.message}`)
    assert.match(got.message, /什么都没改|没被动过/, `要说清零改动：${got.message}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C3 --restore-launchd：非交互调用方显式给了 --no-prompt 就照旧换定义（一次性门，不静默）', async () => {
  const dir = tempRoot('c3-autoyes')
  try {
    const plist = writePlist(dir, NEW_BIN)
    const fake = fakeLaunchctl({ loadedProgram: OLD_BIN })
    const consent = consentStub(true)
    const got = await restoreLaunchd(restoreArgs(dir, plist, fake, {
      autoYes: true,
      confirmFn: consent.confirmFn,
    }))
    assert.deepEqual(fake.verbs().filter((v) => v === 'bootout' || v === 'bootstrap'), ['bootout', 'bootstrap'],
      `放行后必须真的换定义：${JSON.stringify(fake.verbs())}`)
    assert.equal(got.ok, true, got.message)
    assert.equal(consent.asked.length, 0, '--no-prompt 就是那一句显式放行，不该再问人')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C3 --restore-launchd：人在终端回答继续 → bootout 恰好一次，恢复照旧闭环', async () => {
  const dir = tempRoot('c3-consent')
  try {
    const plist = writePlist(dir, NEW_BIN)
    const fake = fakeLaunchctl({ loadedProgram: OLD_BIN })
    const got = await restoreLaunchd(restoreArgs(dir, plist, fake, {
      confirmFn: async () => true,
    }))
    assert.equal(got.ok, true, got.message)
    assert.equal(fake.verbs().filter((v) => v === 'bootout').length, 1, '同意之后只许卸一次')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C3 --restore-launchd：作业已加载且定义一致时一个字都不动，也不问', async () => {
  const dir = tempRoot('c3-healthy')
  try {
    const plist = writePlist(dir, NEW_BIN)
    const fake = fakeLaunchctl({ loadedProgram: NEW_BIN })
    let asked = 0
    const got = await restoreLaunchd(restoreArgs(dir, plist, fake, {
      confirmFn: async () => { asked += 1; return false },
    }))
    assert.equal(got.ok, true, got.message)
    assert.equal(asked, 0, '不需要 bootout 就不许问——问了就是把人当一次决策的资源')
    assert.ok(!fake.verbs().includes('bootout'), JSON.stringify(fake.verbs()))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C3 入口把 --no-prompt 交给恢复路径的同意门（不传就等于非交互永远拒）', () => {
  const body = CLI_SOURCE.slice(CLI_SOURCE.indexOf('} else if (decision.kind === \'restore-launchd\') {'))
  assert.match(body, /restoreLaunchd\(\{[\s\S]{0,200}autoYes: options\.prompt === false/,
    `main() 里那次 restoreLaunchd() 必须把 --no-prompt 传给同意门：${body.slice(0, 400)}`)
})

/* ------------------------------------------------------------------ C4 */

test('C4 usage 不再承诺 install.sh 会代答 --no-prompt，并把"自己带旗标"说成调用方的动作', () => {
  const usage = usageText()
  assert.doesNotMatch(usage, /install\.sh[^\n]{0,40}(自动补|已经补|本来就会补)/,
    `文档承诺与实际同意档位相反：${usage}`)
  assert.match(usage, /不代答/,
    `usage 要说清"入口脚本不替你决定"：${usage}`)
  // 两处注释同罪：confirm 的定义处与 install() 的覆盖门。
  assert.doesNotMatch(CLI_SOURCE, /现在由入口脚本在非 TTY 时\s*\n?\s*显式补 `--no-prompt`/, 'confirm 的头不许再写"入口脚本代补"')
  assert.doesNotMatch(CLI_SOURCE, /install\.sh 在 stdin 非 TTY 时本来就会补 --no-prompt/, '覆盖门的注释不许再写"本来就会补"')
  assert.match(INSTALL_SH_SOURCE, /本脚本不替你决定这件事/, 'install.sh 那句"不代答"必须还在（闸的对照组）')
})

/* ------------------------------------------------------------------ C9 */

function c9Plan() {
  return bundlePlan({ homeDir: '/Users/dev', buildDir: BUILD_DIR })
}

/** 一个记账的假 fs：`exists` 跟着 copy/remove/rename 走，这样"回滚"这件事是被观测的，
 *  不是测试里写死的一个 Set。 */
function c9Fs({ present, ops, failCopy = null, failRename = null }) {
  const state = { present: new Set(present), ops }
  return {
    state,
    exists: (p) => state.present.has(p),
    remove: (p) => { ops.push(['remove', p]); state.present.delete(p) },
    copy: (source, dest) => {
      ops.push(['copy', source, dest])
      if (failCopy !== null && (failCopy === true || failCopy === dest)) {
        throw Object.assign(new Error(failCopy === true ? 'ENOSPC: no space left on device, copyfile' : 'ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' })
      }
      state.present.add(dest)
    },
    rename: (from, to) => {
      ops.push(['rename', from, to])
      if (failRename !== null && failRename === from) {
        throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' })
      }
      if (state.present.has(from)) {
        state.present.delete(from)
        state.present.add(to)
      }
    },
    mkdir: () => {},
    token: 'tok',
  }
}

test('C9 installBundles：新的一份先落到 .tmp- 再改名就位——旧 bundle 在被替换前一个字节都不动', () => {
  const plan = c9Plan()
  const ops = []
  const fs2 = c9Fs({ present: [plan.builtSettingsApp, plan.settingsApp], ops })
  const got = installBundles({ plan, ...fs2 })
  const staged = `${plan.settingsApp}.tmp-tok`
  const retired = `${plan.settingsApp}.old-tok`
  assert.deepEqual(ops, [
    ['copy', plan.builtSettingsApp, staged],
    ['rename', plan.settingsApp, retired],
    ['rename', staged, plan.settingsApp],
    ['remove', retired],
  ], `安置一份 bundle 的全部磁盘动作，顺序就是"原子"的定义：${JSON.stringify(ops)}`)
  assert.deepEqual(got.installed, [plan.settingsApp])
  assert.deepEqual(got.leftovers, [], '备份删掉了就不该报残骸')
})

test('C9 installBundles：cpSync 中途 ENOSPC → 旧 bundle 没被删、没被挪走，报错给确切下一步', () => {
  const plan = c9Plan()
  const ops = []
  const fs2 = c9Fs({ present: [plan.builtSettingsApp, plan.settingsApp], ops, failCopy: true })
  let thrown = null
  try {
    installBundles({ plan, ...fs2 })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, '拷贝失败不许被吞成"已安置"')
  assert.deepEqual(ops.filter(([verb, a]) => (verb === 'remove' || verb === 'rename') && a === plan.settingsApp), [],
    `旧的 bundle 被动了：${JSON.stringify(ops)}`)
  assert.match(thrown.message, /ENOSPC/, `要带上 syscall 的原话：${thrown.message}`)
  assert.match(thrown.message, /原件还在原位/, `要说清旧 bundle 还在：${thrown.message}`)
  assert.match(thrown.message, /df -h|ls -ld/, `要给能照着跑的下一步：${thrown.message}`)
})

test('C9 installBundles：落位那一步失败就把旧的一份放回原位', () => {
  const plan = c9Plan()
  const ops = []
  const staged = `${plan.settingsApp}.tmp-tok`
  const retired = `${plan.settingsApp}.old-tok`
  const fs2 = c9Fs({ present: [plan.builtSettingsApp, plan.settingsApp], ops, failRename: staged })
  let thrown = null
  try {
    installBundles({ plan, ...fs2 })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, '落位失败必须报出来')
  assert.ok(ops.some(([verb, from, to]) => verb === 'rename' && from === retired && to === plan.settingsApp),
    `旧 bundle 没被放回原位：${JSON.stringify(ops)}`)
  assert.equal(fs2.state.present.has(plan.settingsApp), true, '报错之后机器上仍然有一份完整 bundle')
  assert.match(thrown.message, /EACCES/, thrown.message)
  assert.match(thrown.message, /ls -ld|权限/, `要说清这是权限问题并给查它的命令：${thrown.message}`)
})

test('C9 installBundles：真 fs 上重跑幂等，且安置过程中不留 .tmp- 残骸', () => {
  const root = tempRoot('c9-real')
  try {
    const buildDir = path.join(root, 'build')
    const appsDir = path.join(root, 'Apps')
    const sourceApp = path.join(buildDir, 'GlassPane.app')
    fs.mkdirSync(path.join(sourceApp, 'Contents', 'MacOS'), { recursive: true })
    fs.writeFileSync(path.join(sourceApp, 'Contents', 'Info.plist'), '<plist/>')
    fs.writeFileSync(path.join(sourceApp, 'Contents', 'MacOS', 'glasspane-settings'), 'v1')
    const plan = bundlePlan({ homeDir: root, buildDir, appsDir })
    assert.deepEqual(installBundles({ plan }).installed, [plan.settingsApp])
    assert.deepEqual(installBundles({ plan }).installed, [plan.settingsApp], '重跑幂等')
    assert.equal(fs.readFileSync(path.join(plan.settingsApp, 'Contents', 'MacOS', 'glasspane-settings'), 'utf8'), 'v1')
    assert.deepEqual(fs.readdirSync(appsDir).filter((n) => n.includes('.tmp-') || n.includes('.old-')), [],
      `安置完不该留下暂存残骸：${JSON.stringify(fs.readdirSync(appsDir))}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ C8 */

const REPO_ROOT = path.join(HERE, '..', '..')
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh')

/** 只跑 dry-run：脚本在委托之前 `exit 0`，一个 node、一次 launchctl、一个字节都不写。 */
function runDry(extraEnv = {}, { cwd = REPO_ROOT, repo = REPO_ROOT } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-qoder20261024-sh-'))
  try {
    const env = {
      ...process.env,
      HOME: home,
      GLASSPANE_INSTALL_DRY_RUN: '1',
      GLASSPANE_REPO: repo,
      ...extraEnv,
    }
    if (!('GLASSPANE_REF' in extraEnv)) delete env.GLASSPANE_REF
    if (!('GLASSPANE_REPO_URL' in extraEnv)) delete env.GLASSPANE_REPO_URL
    const got = spawnSync('/bin/sh', [INSTALL_SH], { env, cwd, input: '', encoding: 'utf8' })
    return { ...got, stdout: got.stdout ?? '', stderr: got.stderr ?? '' }
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

test('C8 定位到本地仓库的那一趟也过两个覆盖位的形状闸（dry-run 不豁免，rc 不是 0）', () => {
  const bad = runDry({ GLASSPANE_REF: '+bad' })
  assert.notEqual(bad.status, 0, `坏 ref 在本地仓库这一支一步闸都没过就回了 0：${bad.stdout}`)
  assert.match(bad.stderr, /GLASSPANE_REF/, bad.stderr)
  assert.ok(!/将执行/.test(bad.stdout), `被拒的值不许走到委托那一行：${bad.stdout}`)

  const badUrl = runDry({ GLASSPANE_REPO_URL: 'ext::sh -c /usr/bin/touch /tmp/qoder-pwned' })
  assert.notEqual(badUrl.status, 0, `ext:: 形状的 URL 在本地仓库这一支也被放行：${badUrl.stdout}`)
  assert.match(badUrl.stderr, /scheme|开头|传输扩展名/, badUrl.stderr)
  assert.ok(!fs.existsSync('/tmp/qoder-pwned'), '被拒的 ext:: 值不许留下被执行过的痕迹')

  const good = runDry({ GLASSPANE_REF: 'main' })
  assert.equal(good.status, 0, `好值不许被新位置误伤：${good.stderr}`)
  assert.match(good.stdout, /将执行/, good.stdout)
})

test('C8 同一条坏值在 clone 那一趟与本地那一趟给出同一句拒绝（两条入口一个答案）', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-qoder20261024-bare-'))
  try {
    const local = runDry({ GLASSPANE_REF: 'v1:2' })
    const clone = runDry({ GLASSPANE_REF: 'v1:2' }, { cwd: bare, repo: '' })
    assert.notEqual(local.status, 0, local.stdout)
    assert.notEqual(clone.status, 0, clone.stdout)
    const line = (text) => String(text).split('\n').find((l) => /GLASSPANE_REF/.test(l)) ?? ''
    assert.equal(line(local.stderr), line(clone.stderr), '同一事实两套读数：形状闸的句子按入口不同而不同')
  } finally {
    fs.rmSync(bare, { recursive: true, force: true })
  }
})
