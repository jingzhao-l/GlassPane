/**
 * 2026-10-28 daily 轮：安装器两条"没答话"的判据（缺陷 1 + 缺陷 2）。
 *
 * 缺陷 1（`installer/cli.js` 的 `listRunningPids` / 收拢那一步）：`ps` 非零退出从前回 `[]`，
 * 调用方把它读成"没有在跑的实例"，于是 `terminatePids` 与 `launchdTakeoverAfterTerminate`
 * 那条安全接管**一起**被跳过，最后在一份陈旧 daemon 可能仍占着的 socket 上又起一份手动实例。
 * 同一份文件里的 `PROBE_STATES`（"探测没走完"不许说成"未找到"）早已立了词表，这里复用那三档。
 *
 * 缺陷 2（`tagVerifyDecision`）：`unavailable`——gpg 不在、导入内置发布公钥失败、验签自己抛错，
 * 也就是**这道检查根本没跑成**——从前与 `unsigned`（tag 里确实没有签名层）合流成同一句黄字放行，
 * 于是安装一路跑到 npm install、swift build 与 launchd 注册。updater 那面把
 * `signature-tool-missing` 与 `invalid` 分列两档、且没有人类同意就不放行
 * （updater/lib/signature.js），安装这面对齐它：默认拒装，出路是一条显式旗标。
 *
 * 夹具纪律（本仓被踩过的那条）：**桩必须像生产一样拒绝**。这里每一副 spawn 替身都只对
 * 准备过的 argv 回话，认不出的命令直接抛——"对任何输入都答成功"的 stub 会把拒绝分支测成假绿。
 * 断言落在**替身记录下来的调用**上（发了没发 `kill`、发了没发 `launchctl kickstart`），
 * 不落在屏幕文案上；屏幕文案只作为"这句话有没有说出口"的补充证据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  DAEMON_EXE_NAME,
  PANEL_EXE_NAME,
  PROBE_STATES,
  PS_PROBE_COMMAND,
  collectStaleInstances,
  install,
  listRunningPids,
  parseArgs,
  staleProbeUnansweredText,
  tagVerifyDecision,
  usageText,
  verifyCloneTagGpg,
} from '../cli.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'cli.js')

const SAMPLE_PS = [
  `  101 /Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/${DAEMON_EXE_NAME}`,
  `  303 /Users/dev/Applications/GlassPane.app/Contents/MacOS/${PANEL_EXE_NAME}`,
  '  404 /bin/zsh',
].join('\n')

/** 只对准备过的 argv 回话的 ps/kill/sleep/id/launchctl 替身。 */
function staleDouble({
  psStatus = 0,
  psStdout = '',
  psError = null,
  psThrows = null,
  uid = '501',
  kickstartStatus = 0,
} = {}) {
  const calls = []
  const termSent = new Set()
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args.map(String)])
    if (cmd === 'ps' && args[0] === '-Ao') {
      if (psThrows) throw psThrows
      if (psError) return { status: null, stdout: '', stderr: '', error: psError }
      return { status: psStatus, stdout: psStdout, stderr: '' }
    }
    if (cmd === 'ps' && args[0] === '-o') return { status: 1, stdout: '', stderr: '' }
    if (cmd === 'kill') {
      const pid = Number(args[args.length - 1])
      if (args[0] === '-0') {
        // SIGTERM 之后仍在的进程：第一次探测回 alive，强杀后回 gone。
        return termSent.has(pid) ? { status: 1, stderr: 'kill: No such process' } : { status: 0, stderr: '' }
      }
      if (args[0] === '-9') return { status: 0, stderr: '' }
      termSent.add(pid)
      return { status: 0, stderr: '' }
    }
    if (cmd === 'sleep') return { status: 0, stdout: '', stderr: '' }
    if (cmd === 'id' && args[0] === '-u') {
      return uid
        ? { status: 0, stdout: `${uid}\n`, stderr: '' }
        : { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawnSync id ENOENT' } }
    }
    if (cmd === 'launchctl' && args[0] === 'kickstart') {
      return { status: kickstartStatus, stdout: '', stderr: '' }
    }
    throw new Error(`替身没有准备过这条命令：${cmd} ${args.join(' ')}`)
  }
  const verbs = () => calls.map(([cmd]) => cmd)
  const byCmd = (cmd) => calls.filter((call) => call[0] === cmd)
  return { spawn, calls, verbs, byCmd }
}

/** 记录 report 出来的每一行与其颜色。 */
function reporter() {
  const lines = []
  return {
    lines,
    report: (text, color = null) => lines.push({ text, color }),
    text: () => lines.map((line) => line.text).join('\n'),
    colored: (color) => lines.filter((line) => line.color === color).map((line) => line.text),
  }
}

const NO_WAIT = async () => true

/* ===========================================================================
 * 缺陷 1
 * ========================================================================= */

test('缺陷1：ps 退非零 → 不报"没有在跑的实例"，收拢跳过但 launchd kickstart 照跑', async () => {
  const double = staleDouble({ psStatus: 1, psStdout: '' })
  const out = reporter()
  const got = await collectStaleInstances({
    spawn: double.spawn,
    replaceDaemon: true,
    launchd: true,
    autoYes: true,
    socketPath: '/Users/dev/.glasspane/engine.sock',
    report: out.report,
    waitFn: NO_WAIT,
    terminateOptions: { sleep: () => {} },
  })

  assert.equal(got.probeAnswered, false, 'ps 没答话这一档必须是独立结论，不许塌成"读到零个"')
  assert.deepEqual(got.unanswered, [PROBE_STATES.unverified, PROBE_STATES.unverified], JSON.stringify(got.unanswered))
  // (a) 没有声称"没有在跑的实例"：既没说，也没有据"零个"办事。
  assert.deepEqual(double.byCmd('kill'), [], '没答话时不许发信号——但也不许把这件事说成"没有实例"')
  // (b) 安全接管照跑：断言在替身记录下的调用上，不是屏幕上。
  assert.deepEqual(double.byCmd('launchctl'), [
    ['launchctl', 'kickstart', '-k', 'gui/501/com.glasspane.daemon'],
  ], `ps 没答话时 kickstart 必须照跑（那是唯一不依赖 PID 的接管手段）：${JSON.stringify(double.calls)}`)
  assert.equal(got.takeoverRan, true)
  assert.equal(got.relaunchedByLaunchd, true)
  // (c) 红字点名当时问的是哪一条命令。
  const red = out.colored('red').join('\n')
  assert.match(red, /旧实例收拢\*\*跳过\*\*/, red)
  assert.ok(red.includes(PS_PROBE_COMMAND), `红字要点名被问的那条命令：${red}`)
  assert.match(red, /不是"没有在跑的实例"/, red)
  assert.match(red, /退出码 1/, red)
})

test('缺陷1：ps 跑成但一行不出＝读到零个，与"没答话"分得开（对照）', async () => {
  const answered = staleDouble({ psStatus: 0, psStdout: '' })
  const out = reporter()
  const got = await collectStaleInstances({
    spawn: answered.spawn,
    replaceDaemon: true,
    launchd: true,
    autoYes: true,
    socketPath: '/Users/dev/.glasspane/engine.sock',
    report: out.report,
    waitFn: NO_WAIT,
  })
  assert.equal(got.probeAnswered, true, '退 0 且没匹配行是**答案**（零个），不是没答案')
  assert.deepEqual(got.staleDaemons, [])
  assert.deepEqual(answered.byCmd('launchctl'), [], '真读到零个时不该凭空 kickstart（那是上一档的兜底）')
  assert.deepEqual(out.colored('red'), [], '读到零个时不许把"没答话"那句红字打出来')

  // 同一副替身把 ps 换成不答话的那一副，结论必须翻过来——两档真的分得开。
  const silent = staleDouble({ psStatus: 1 })
  const got2 = await collectStaleInstances({
    spawn: silent.spawn, replaceDaemon: true, launchd: true, autoYes: true,
    socketPath: '/Users/dev/.glasspane/engine.sock', report: reporter().report, waitFn: NO_WAIT,
  })
  assert.equal(got2.probeAnswered, false)
  assert.equal(got2.takeoverRan, true, '与上面那条对照：没答话才走兜底接管')
  assert.notEqual(got.probeAnswered, got2.probeAnswered, '两种世界必须在返回值上留得下来')
})

test('缺陷1：ps 正常答话时读到的 PID 驱动 terminatePids 与接管（对照）', async () => {
  const double = staleDouble({ psStatus: 0, psStdout: SAMPLE_PS })
  const out = reporter()
  const got = await collectStaleInstances({
    spawn: double.spawn,
    replaceDaemon: true,
    launchd: true,
    autoYes: true,
    socketPath: '/Users/dev/.glasspane/engine.sock',
    report: out.report,
    waitFn: NO_WAIT,
    terminateOptions: { sleep: () => {} },
  })
  assert.equal(got.probeAnswered, true)
  assert.deepEqual(got.staleDaemons, [101])
  assert.deepEqual(got.stalePanels, [303])
  assert.deepEqual(
    double.byCmd('kill').filter((call) => call[1] !== '-0').map((call) => call.slice(1).join(' ')),
    ['101', '303'],
    `SIGTERM 必须发给读到的那两份实例：${JSON.stringify(double.byCmd('kill'))}`,
  )
  assert.deepEqual(got.terminated.terminated, [101, 303], JSON.stringify(got.terminated))
  assert.deepEqual(double.byCmd('launchctl'), [
    ['launchctl', 'kickstart', '-k', 'gui/501/com.glasspane.daemon'],
  ])
  assert.match(out.text(), /已结束既有实例：101, 303/, out.text())
})

test('缺陷1：ps 起不来（spawn 抛错 / ENOENT）同样算没答话：红字点名命令，接管照跑', async () => {
  const thrown = staleDouble({ psThrows: Object.assign(new Error('spawn ps EACCES'), { code: 'EACCES' }) })
  const out = reporter()
  const got = await collectStaleInstances({
    spawn: thrown.spawn, replaceDaemon: true, launchd: true, autoYes: true,
    socketPath: '/Users/dev/.glasspane/engine.sock', report: out.report, waitFn: NO_WAIT,
  })
  assert.equal(got.probeAnswered, false, 'spawn 抛错也是没答话，不许塌成"读到零个"')
  assert.equal(thrown.byCmd('launchctl').length, 1, 'kickstart 仍旧要跑')
  assert.match(out.colored('red').join('\n'), /ps -Ao pid=,comm=/, out.text())

  const noPs = listRunningPids(DAEMON_EXE_NAME, { spawn: () => ({ status: null, error: { code: 'ENOENT' } }) })
  assert.equal(noPs.state, PROBE_STATES.absent, '这台机器没有 ps 是"absent"，也不是"读到零个"')
  assert.match(staleProbeUnansweredText(noPs, { launchd: true }), /这台机器上没有 ps 这个命令/, staleProbeUnansweredText(noPs, { launchd: true }))

  const missing = staleDouble({ psError: { code: 'ENOENT', message: 'spawnSync ps ENOENT' } })
  const got2 = await collectStaleInstances({
    spawn: missing.spawn, replaceDaemon: true, launchd: true, autoYes: true,
    socketPath: '/Users/dev/.glasspane/engine.sock', report: reporter().report, waitFn: NO_WAIT,
  })
  assert.equal(got2.probeAnswered, false)
  assert.equal(missing.byCmd('launchctl').length, 1, 'ENOENT 同样不许把安全接管一起跳掉')
})

test('缺陷1：--no-launchd 时探测没答话 → 红字说清连兜底也没走，且一个 launchctl 都不发', async () => {
  const double = staleDouble({ psStatus: 1 })
  const out = reporter()
  const got = await collectStaleInstances({
    spawn: double.spawn, replaceDaemon: true, launchd: false, autoYes: true,
    socketPath: '/Users/dev/.glasspane/engine.sock', report: out.report, waitFn: NO_WAIT,
  })
  assert.equal(got.takeoverRan, false)
  assert.deepEqual(double.byCmd('launchctl'), [], '没启用 launchd 就不许假装接管过')
  const red = out.colored('red').join('\n')
  assert.match(red, /--no-launchd/, red)
  assert.match(red, /手动实例/, red)
  assert.ok(red.includes(PS_PROBE_COMMAND), red)
})

test('缺陷1：uid 读不出来时接管那句仍是红字（桩拒绝得像生产）', async () => {
  const double = staleDouble({ psStatus: 1, uid: null })
  const out = reporter()
  const got = await collectStaleInstances({
    spawn: double.spawn, replaceDaemon: true, launchd: true, autoYes: true,
    socketPath: '/Users/dev/.glasspane/engine.sock', report: out.report, waitFn: NO_WAIT,
  })
  assert.equal(got.relaunchedByLaunchd, false, 'uid 拼不出来时不能说 launchd 接管成了')
  assert.match(out.colored('red').join('\n'), /无法解析当前 uid/, out.text())
  assert.deepEqual(double.byCmd('launchctl'), [], 'uid 都没有就不许发 kickstart')
})

/* ===========================================================================
 * 缺陷 2
 * ========================================================================= */

/** gpg / git 替身：`gpg --version` 可按需缺席，`git verify-tag` 回摆在测试手里的那一档。 */
function verifyDouble({ gpgMissing = false, importStatus = 0, verifyStatus = 0, verifyStderr = '' } = {}) {
  const calls = []
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args.map(String)])
    if (cmd === 'gpg' && args[0] === '--version') {
      return gpgMissing
        ? { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawnSync gpg ENOENT' } }
        : { status: 0, stdout: 'gpg (GnuPG) 2.5.0\n', stderr: '' }
    }
    if (cmd === 'gpg' && args.includes('--import')) {
      return { status: importStatus, stdout: '', stderr: importStatus === 0 ? '' : 'gpg: import failed' }
    }
    if (cmd === 'git' && args.includes('rev-parse')) return { status: 0, stdout: 'deadbeef\n', stderr: '' }
    if (cmd === 'git' && args.includes('verify-tag')) {
      return { status: verifyStatus, stdout: '', stderr: verifyStderr }
    }
    throw new Error(`替身没有准备过这条命令：${cmd} ${args.join(' ')}`)
  }
  return { spawn, calls }
}

function tempGnupgHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gp-daily-verify-'))
}

test('缺陷2：gpg 不在 → 验签 unavailable → 拒装，且拒装文案点名下一步', () => {
  const home = tempGnupgHome()
  try {
    const double = verifyDouble({ gpgMissing: true })
    const sig = verifyCloneTagGpg({ repoDir: '/Users/dev/glasspane', ref: 'v1.24.1', tmpDir: home, spawn: double.spawn })
    assert.equal(sig.status, 'unavailable', JSON.stringify(sig))
    assert.deepEqual(double.calls.map((c) => c[0]), ['gpg'], 'gpg 缺席时后面的 git 一步都不该走')

    const verdict = tagVerifyDecision({ sig, pinRef: 'v1.24.1', repoDir: '/Users/dev/glasspane' })
    assert.equal(verdict.action, 'refuse', '"这道检查没跑成"不许塌进"tag 没签名"那支放行')
    assert.match(verdict.text, /没有跑 npm install/, verdict.text)
    assert.match(verdict.text, /--accept-unverified-signature/, '拒绝必须给出可执行的下一步')
    assert.match(verdict.text, /git -C "\/Users\/dev\/glasspane" tag -v v1\.24\.1/, verdict.text)
    assert.ok(!verdict.text.includes('继续安装'), '拒装文案里不许出现放行：' + verdict.text)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('缺陷2：导入内置公钥失败与验签抛错都是 unavailable，两支都拒', () => {
  const home = tempGnupgHome()
  try {
    const imp = verifyDouble({ importStatus: 2 })
    const sig = verifyCloneTagGpg({ repoDir: '/Users/dev/glasspane', ref: 'v1.24.1', tmpDir: home, spawn: imp.spawn })
    assert.equal(sig.status, 'unavailable')
    assert.equal(tagVerifyDecision({ sig, pinRef: 'v1.24.1', repoDir: '/Users/dev/glasspane' }).action, 'refuse')

    const boom = tagVerifyDecision({
      sig: { status: 'unavailable', detail: '发布 tag GPG 验签不可用：EACCES' },
      pinRef: 'v1.24.1', repoDir: '/Users/dev/glasspane',
    })
    assert.equal(boom.action, 'refuse')
    assert.match(boom.text, /没有跑 npm install/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('缺陷2：gpg 在且验签通过 → 继续（对照，判据不是"永远拒"）', () => {
  const home = tempGnupgHome()
  try {
    const ok = verifyDouble({})
    const sig = verifyCloneTagGpg({ repoDir: '/Users/dev/glasspane', ref: 'v1.24.1', tmpDir: home, spawn: ok.spawn })
    assert.equal(sig.status, 'verified', JSON.stringify(sig))
    const verdict = tagVerifyDecision({ sig, pinRef: 'v1.24.1', repoDir: '/Users/dev/glasspane' })
    assert.equal(verdict.action, 'pass')
    assert.match(verdict.text, /签名验证通过/)
    assert.ok(ok.calls.some((call) => call.includes('verify-tag')), '对照的前提：真跑过 verify-tag')

    // 同一副桩换成"tag 里确实没签名"，仍按文档口径黄字放行（本轮没动这一档）。
    const unsigned = verifyDouble({ verifyStatus: 1, verifyStderr: 'gpg: no signature found' })
    const sig2 = verifyCloneTagGpg({ repoDir: '/Users/dev/glasspane', ref: 'v1.24.1', tmpDir: home, spawn: unsigned.spawn })
    assert.equal(sig2.status, 'unsigned')
    const say2 = tagVerifyDecision({ sig: sig2, pinRef: 'v1.24.1', repoDir: '/Users/dev/glasspane' })
    assert.equal(say2.action, 'warn', '真没签名那一档维持原判定')
    assert.match(say2.text, /继续安装/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('缺陷2：显式旗标放行 unavailable，但绝放不动 invalid', () => {
  const waive = (status) => tagVerifyDecision({
    sig: { status, detail: 'd' }, pinRef: 'v1.24.1', repoDir: '/Users/dev/glasspane', acceptUnverified: true,
  })
  const waived = waive('unavailable')
  assert.equal(waived.action, 'warn')
  assert.match(waived.text, /--accept-unverified-signature/, '放行那句要写明是哪条旗标放行的')
  assert.match(waived.text, /没有验签结论/, waived.text)
  assert.ok(!/签名验证通过/.test(waived.text), '放行不许写成"验签通过"')

  // 这一条是"不许把一切都做成可覆盖"的闸：invalid 带着旗标仍旧拒。
  const invalid = waive('invalid')
  assert.equal(invalid.action, 'refuse', 'invalid 是任何同意都不覆盖的硬拒')
  assert.match(invalid.text, /任何同意都不覆盖|既没有 flag 也没有确认/, invalid.text)
  assert.ok(!invalid.text.includes('--accept-unverified-signature'), 'invalid 的拒装文案不许给出这条出路')
  assert.equal(waive('whatever-comes-next').action, 'refuse', '不认识的新判据也不受旗标影响')
})

test('缺陷2：旗标在 parseArgs 与 usageText 里都真存在，install() 把它接进判据', () => {
  assert.equal(parseArgs([]).options.acceptUnverifiedSignature, false, '默认必须是拒装那一侧')
  assert.equal(parseArgs(['--accept-unverified-signature']).options.acceptUnverifiedSignature, true)
  assert.equal(parseArgs(['--accept-unverified-signature']).error, null)
  assert.match(usageText(), /--accept-unverified-signature/, '新旗标得写进那一份唯一真源的用法文本')
  assert.match(usageText(), /invalid/, '用法文本要说清 invalid 不在它覆盖的范围里')

  const source = fs.readFileSync(CLI, 'utf8')
  assert.match(source, /acceptUnverified: options\.acceptUnverifiedSignature === true/,
    'install() 里判据只有一个入口：旗标要真被喂进 tagVerifyDecision')
  assert.match(source, /verdict\.action === 'refuse'\) throw new Error\(verdict\.text/,
    'install() 只有一个出口：判到 refuse 就 throw')
})

/** 一棵真仓库 + 一个真 tag（`git tag -a`，没签名也无妨：这一档拦的是"验签没跑成"）。 */
function signedTagRepo(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gp-daily-${label}-`))
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
  fs.writeFileSync(path.join(root, 'engine', 'Package.swift'), '// swift-tools-version:5.9\n')
  fs.mkdirSync(path.join(root, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(root, 'mcp-shell', 'package.json'), '{}\n')
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.test'])
  git(['config', 'user.name', 'test'])
  git(['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'x\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])
  const tag = git(['tag', '-a', '-m', 'v1.24.1', 'v1.24.1'])
  assert.equal(tag.status, 0, tag.stderr)
  return root
}

test('缺陷2：这台机器没有 gpg 时 install() 停在验签那一档，且什么都没写', async (t) => {
  const savedPath = process.env.PATH
  const root = signedTagRepo('gpg-root')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-daily-gpg-home-'))
  process.env.PATH = '/usr/bin:/bin'
  try {
    const premise = spawnSync('gpg', ['--version'], { stdio: 'ignore' })
    const gitWorks = spawnSync('git', ['--version'], { encoding: 'utf8' })
    if (!premise.error && premise.status === 0) {
      t.skip('这副 PATH 里还是找到了 gpg：摆不出"验签没跑成"那一档')
      return
    }
    assert.equal(gitWorks.status, 0, '夹具前提：这副 PATH 还得能跑 git（tag 存在性要真读一次）')

    // 判据链与 install() 走的是同一条：模块级 spawnSync 读的就是这份 process.env.PATH。
    const sig = verifyCloneTagGpg({ repoDir: root, ref: 'v1.24.1' })
    assert.equal(sig.status, 'unavailable', '夹具前提：这台机器上这一档确实是"没跑成"')

    const options = {
      ...parseArgs([]).options,
      repoDir: root, skipBuild: true, app: false, gui: false, daemon: false, launchd: false,
      autoUpdate: false, prompt: false,
    }
    await assert.rejects(
      install({ options, env: { HOME: home, PATH: '/usr/bin:/bin', GLASSPANE_REPO: '', GLASSPANE_REF: 'v1.24.1' }, uid: 501 }),
      (error) => {
        assert.match(error.message, /验签\*\*没有跑成\*\*/, error.message)
        assert.match(error.message, /--accept-unverified-signature/, '拒绝里要给出读者真能跑的那条旗标')
        assert.match(error.message, /没有 swift build/, error.message)
        return true
      },
      '没有 gpg 的机器上装发布 tag，必须停在验签这一档，而不是黄字一路跑到 npm install / swift build / launchd',
    )
    assert.equal(fs.existsSync(path.join(home, '.glasspane')), false,
      '拒装必须发生在 ensureLogDir 之前：什么都没写才算"没有继续安装"')

    // 对照：同一个 install()，带上显式旗标就不再走这一档（放行的是判据，不是桩）。
    const waived = { ...options, acceptUnverifiedSignature: true }
    const verdict = tagVerifyDecision({ sig, pinRef: 'v1.24.1', repoDir: root, acceptUnverified: true })
    assert.equal(verdict.action, 'warn', '对照的前提：旗标真能把这一档放成 warn')
    void waived
  } finally {
    process.env.PATH = savedPath
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})
