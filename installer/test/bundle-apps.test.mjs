import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  bundlePlan,
  daemonLaunchPath,
  settingsLaunchPath,
  pidsFromPs,
  daemonPidsFromPs,
  panelPidsFromPs,
  listRunningPids,
  terminatePids,
  waitForSocket,
  launchdKickstartArgs,
  launchdNeedsReregister,
  loadedLaunchdProgram,
  bundleLaunchArgs,
  daemonStartCommand,
  guiStartCommand,
  installBundles,
  bundlesToReplace,
  panelOpenHint,
  nextStepsText,
  startDetached,
  ensureLogDir,
  installOutcome,
  verificationFailureText,
  parseArgs,
  launchdPlistString,
  LAUNCHD_LABEL,
  LAUNCH_SETTLE_MS,
  APPS_DIR_NAME,
  DAEMON_APP_NAME,
  DAEMON_EXE_NAME,
  PANEL_EXE_NAME,
  SETTINGS_APP_NAME,
  SOCKET_DIR_NAME,
  SOCKET_FILE_NAME,
  DAEMON_LOG_NAME,
} from '../cli.js'

// ---------------------------------------------------------------------------
// P1 v1.2 §11.1 打包/安置层：bundle 计划、启动路径选择、陈旧实例识别、文案。
// 全部纯函数或注入式 fs，不触碰真实 ~/Applications。
// ---------------------------------------------------------------------------

const BUILD_DIR = '/repo/engine/.build/release'

test('bundlePlan: 默认安置到 ~/Applications，给出 bundle 内可执行路径', () => {
  const plan = bundlePlan({ homeDir: '/Users/dev', buildDir: BUILD_DIR })
  assert.equal(plan.appsDir, path.join('/Users/dev', APPS_DIR_NAME))
  assert.equal(plan.settingsApp, path.join('/Users/dev', APPS_DIR_NAME, SETTINGS_APP_NAME))
  assert.equal(plan.daemonApp, path.join('/Users/dev', APPS_DIR_NAME, DAEMON_APP_NAME))
  assert.equal(
    plan.daemonExecutable,
    path.join('/Users/dev', APPS_DIR_NAME, DAEMON_APP_NAME, 'Contents', 'MacOS', 'glasspaned'),
  )
  assert.equal(plan.builtDaemonApp, path.join(BUILD_DIR, DAEMON_APP_NAME))
})

test('bundlePlan: --no-app（appPackaged=false）时不给出任何 bundle 路径', () => {
  const plan = bundlePlan({ homeDir: '/Users/dev', buildDir: BUILD_DIR, appPackaged: false })
  assert.equal(plan.daemonExecutable, null)
  assert.equal(plan.settingsExecutable, null)
  assert.equal(plan.settingsApp, null)
  assert.equal(plan.daemonApp, null)
})

test('daemonLaunchPath: bundle 就位优先 bundle，缺失才回退裸二进制', () => {
  const plan = bundlePlan({ homeDir: '/Users/dev', buildDir: BUILD_DIR })
  const withBundle = daemonLaunchPath({ plan, bareBin: '/bare/glasspaned', exists: (p) => p === plan.daemonExecutable })
  assert.deepEqual(withBundle, { path: plan.daemonExecutable, viaBundle: true })

  const bareOnly = daemonLaunchPath({ plan, bareBin: '/bare/glasspaned', exists: () => false })
  assert.deepEqual(bareOnly, { path: '/bare/glasspaned', viaBundle: false })

  const noPlan = daemonLaunchPath({ plan: null, bareBin: '/bare/glasspaned', exists: () => true })
  assert.equal(noPlan.viaBundle, false, '无安置计划时不得假装 bundle 形态')
})

test('settingsLaunchPath: 与 daemon 同口径（bundle 优先、裸二进制兜底）', () => {
  const plan = bundlePlan({ homeDir: '/Users/dev', buildDir: BUILD_DIR })
  assert.equal(
    settingsLaunchPath({ plan, bareBin: '/bare/glasspane-settings', exists: () => true }).path,
    plan.settingsExecutable,
  )
  assert.equal(
    settingsLaunchPath({ plan, bareBin: '/bare/glasspane-settings', exists: () => false }).path,
    '/bare/glasspane-settings',
  )
})

test('daemonPidsFromPs: 只认 glasspaned，跳过表头/空行与自身', () => {
  const ps = [
    '  PID COMM',
    '  101 /Volumes/Eng-Dev/GlassPane/engine/.build/release/glasspaned',
    '  202 /Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned',
    '  303 /Users/dev/Applications/GlassPane.app/Contents/MacOS/glasspane-settings',
    '  404 /bin/zsh',
    '',
  ].join('\n')
  assert.deepEqual(daemonPidsFromPs(ps, { selfPid: 999 }), [101, 202])
  assert.deepEqual(daemonPidsFromPs(ps, { selfPid: 202 }), [101], '自身 PID 不得进入清理名单')
  assert.deepEqual(daemonPidsFromPs('', { selfPid: 1 }), [])
  assert.deepEqual(daemonPidsFromPs(undefined, { selfPid: 1 }), [])
})

test('installBundles: 覆盖式安置两个 .app，源缺失即跳过且不报错', () => {
  const plan = bundlePlan({ homeDir: '/Users/dev', buildDir: BUILD_DIR })
  const removed = []
  const copied = []
  const existsSources = new Set([plan.builtSettingsApp, plan.settingsApp]) // 只有面板产物存在（且目标已有一份旧的）
  const { installed, declined } = installBundles({
    plan,
    exists: (p) => existsSources.has(p),
    remove: (target) => removed.push(target),
    copy: (source, target) => copied.push([source, target]),
    mkdir: () => {},
  })
  assert.deepEqual(installed, [plan.settingsApp])
  assert.deepEqual(declined, [], 'allowReplace 默认放行：覆盖是既有语义')
  assert.deepEqual(removed, [plan.settingsApp], '覆盖安装：先删旧目标再拷')
  assert.deepEqual(copied, [[plan.builtSettingsApp, plan.settingsApp]])
})

test('installBundles: allowReplace=false 时目标已存在的那一份不被动，并如实进 declined', () => {
  const plan = bundlePlan({ homeDir: '/Users/dev', buildDir: BUILD_DIR })
  const removed = []
  const copied = []
  const existsSources = new Set([plan.builtSettingsApp, plan.settingsApp])
  const { installed, declined } = installBundles({
    plan,
    allowReplace: false,
    exists: (p) => existsSources.has(p),
    remove: (target) => removed.push(target),
    copy: (source, target) => copied.push([source, target]),
    mkdir: () => {},
  })
  assert.deepEqual(installed, [])
  assert.deepEqual(declined, [plan.settingsApp], '没拿到替换许可必须被点名，而不是静默跳过')
  assert.deepEqual(removed, [], 'rm 一次都没执行')
  assert.deepEqual(copied, [])
  assert.deepEqual(bundlesToReplace({ plan, exists: (p) => existsSources.has(p) }), [plan.settingsApp],
    '安装器就是靠这份清单决定要不要问人——问的和覆盖的必须是同一份')
})

test('installBundles: 真实临时目录落盘可复核（幂等重跑）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-bundles-'))
  const buildDir = path.join(root, 'build')
  const appsDir = path.join(root, 'Apps')
  fs.mkdirSync(buildDir, { recursive: true })
  const sourceApp = path.join(buildDir, SETTINGS_APP_NAME)
  fs.mkdirSync(path.join(sourceApp, 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(sourceApp, 'Contents', 'Info.plist'), '<plist/>')

  const plan = bundlePlan({ homeDir: root, buildDir, appsDir })
  const first = installBundles({ plan }).installed
  assert.deepEqual(first, [plan.settingsApp])
  const second = installBundles({ plan }).installed
  assert.deepEqual(second, [plan.settingsApp], '重跑幂等')
  assert.ok(fs.existsSync(path.join(plan.settingsApp, 'Contents', 'MacOS')), 'bundle 结构完整')
  fs.rmSync(root, { recursive: true, force: true })
})

test('launchd plist 指向 bundle 内可执行时路径原样写入（授权主体即该路径）', () => {
  const plan = bundlePlan({ homeDir: '/Users/dev', buildDir: BUILD_DIR })
  const xml = launchdPlistString({
    label: LAUNCHD_LABEL,
    daemonBin: plan.daemonExecutable,
    socketPath: '/Users/dev/.glasspane/engine.sock',
    logPath: '/Users/dev/.glasspane/installer-daemon.log',
  })
  assert.ok(xml.includes(`<string>${plan.daemonExecutable}</string>`))
  assert.ok(!xml.includes(BUILD_DIR), '开机自启不得再指向 .build 隐藏目录')
})

/** 从说明文本里抠出所有被双引号包住的绝对路径（finding 8 的闸：印出来的必须真存在）。 */
function quotedPaths(text) {
  return [...String(text).matchAll(/"(\/[^"]*)"/g)].map((m) => m[1])
}

test('nextStepsText: bundle 形态与裸二进制形态的条目名各自如实，且印出的路径真的存在', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-panel-text-'))
  const barePanelBin = path.join(root, 'glasspane-settings')
  fs.writeFileSync(barePanelBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const realApp = path.join(root, SETTINGS_APP_NAME)
  fs.mkdirSync(path.join(realApp, 'Contents', 'MacOS'), { recursive: true })
  const emptyDir = path.join(root, 'never-built') // 刻意不创建：这就是 --no-app 那一档

  const plan = bundlePlan({ homeDir: '/Users/dev', buildDir: BUILD_DIR })
  const bundled = nextStepsText({
    rootDir: '/repo',
    socketPath: '/s.sock',
    guiOpened: true,
    daemon: { path: plan.daemonExecutable, viaBundle: true },
    settingsApp: plan.settingsApp,
    panel: { viaBundle: true, executable: barePanelBin, app: realApp, exists: true },
  })
  assert.ok(bundled.includes('GlassPane Daemon'), 'bundle 形态应给出带图标的条目名')
  assert.ok(bundled.includes('面板已打开'))
  assert.ok(bundled.includes('未报错退出'), '"面板已打开"必须自带口径边界（观测到的是命令未报错，不是窗口在屏）')
  assert.ok(bundled.includes('授权勾选必须人工'), '诚实边界：TCC 不程序化')
  assert.ok(bundled.includes(plan.daemonExecutable), '给出 --permissions 验证命令的完整路径')
  assert.ok(bundled.includes('--permissions'))
  assert.ok(bundled.includes(`open "${realApp}"`), 'bundle 形态的再起一次命令要指向那个 .app')
  for (const p of quotedPaths(bundled).filter((x) => x.endsWith('.app'))) {
    assert.ok(fs.existsSync(p), `说明里印给读者的 open 目标必须存在：${p}`)
  }

  const bare = nextStepsText({
    rootDir: '/repo',
    socketPath: '/s.sock',
    guiOpened: false,
    daemon: { path: '/repo/engine/.build/release/glasspaned', viaBundle: false },
    // finding 8：说明里的面板路径来自 settingsLaunchPath 的结果，测试保证它**真的存在**。
    panel: { viaBundle: false, executable: barePanelBin, app: null, exists: true },
  })
  assert.ok(bare.includes('裸二进制形态'), '裸二进制必须如实说明条目只显示文件名')
  assert.ok(bare.includes('glasspaned'))
  assert.ok(bare.includes(barePanelBin), `应把面板裸二进制路径交给读者：${bare}`)
  assert.ok(fs.existsSync(barePanelBin), '前置条件：这条路径确实存在')

  // 什么都没安置（--no-app，或 make-app.sh 没产出 bundle）时不许印一条没人能跑的 open。
  const nothing = nextStepsText({
    rootDir: '/repo',
    socketPath: '/s.sock',
    guiOpened: false,
    daemon: { path: '/repo/engine/.build/release/glasspaned', viaBundle: false },
    panel: { viaBundle: false, executable: path.join(emptyDir, PANEL_EXE_NAME), app: path.join(emptyDir, SETTINGS_APP_NAME), exists: false },
  })
  assert.ok(!/open "/.test(nothing), `没有可执行面板产物时不许印 open "…"：${nothing}`)
  assert.ok(nothing.includes('没有可执行的面板产物'), '必须明说这一步没有可执行的指引')
  assert.ok(nothing.includes(path.join(emptyDir, PANEL_EXE_NAME)), '要把查过的那个路径点出来')
  fs.rmSync(root, { recursive: true, force: true })
})

test('parseArgs: --replace-daemon 默认关闭、显式可开', () => {
  assert.equal(parseArgs([]).options.replaceDaemon, false)
  assert.equal(parseArgs(['--replace-daemon']).options.replaceDaemon, true)
  assert.equal(parseArgs(['--replace-daemon']).error, null)
})

const SAMPLE_PS = [
  '  101 /Volumes/Eng-Dev/GlassPane/engine/.build/release/glasspaned',
  '  202 /Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned',
  '  303 /Users/dev/Applications/GlassPane.app/Contents/MacOS/glasspane-settings',
  '  404 /bin/zsh',
].join('\n')

test('pidsFromPs: 按可执行名分流 daemon 与设置面板', () => {
  assert.deepEqual(pidsFromPs(SAMPLE_PS, { exeName: DAEMON_EXE_NAME, selfPid: 1 }), [101, 202])
  assert.deepEqual(pidsFromPs(SAMPLE_PS, { exeName: PANEL_EXE_NAME, selfPid: 1 }), [303])
  assert.deepEqual(panelPidsFromPs(SAMPLE_PS, { selfPid: 303 }), [], '自身 PID 不进清理名单')
})

test('listRunningPids: ps 执行失败一律视为无实例（不因探测中断安装）', () => {
  const ok = listRunningPids(DAEMON_EXE_NAME, {
    spawn: () => ({ status: 0, stdout: SAMPLE_PS }),
  })
  assert.deepEqual(ok, [101, 202])
  assert.deepEqual(listRunningPids(DAEMON_EXE_NAME, { spawn: () => ({ status: 1, stdout: '' }) }), [])
})

test('terminatePids: SIGTERM 后仍存活者补 SIGKILL 并回报 forced', () => {
  const calls = []
  const alive = new Set([202]) // 101 正常退出，202 对 SIGTERM 无响应
  const result = terminatePids([101, 202], {
    spawn: (cmd, args) => {
      calls.push([cmd, args])
      const pid = Number(args[args.length - 1])
      if (args.includes('-0')) return { status: alive.has(pid) ? 0 : 1 }
      if (args.includes('-9')) alive.delete(pid)
      return { status: 0 }
    },
  })
  assert.deepEqual(result.terminated, [101, 202])
  assert.deepEqual(result.forced, [202], '只有确实存活的需要强杀')
  assert.deepEqual(calls.filter(([cmd, args]) => cmd === 'kill' && !args.includes('-0')).map(([, args]) => args.join(' ')), [
    '101',
    '202',
    '-9 202',
  ])
})

test('waitForSocket: 命中即返回 true，超时返回 false（launchd 重拉窗口）', async () => {
  let probes = 0
  const hit = await waitForSocket('/s.sock', {
    timeoutMs: 3000,
    intervalMs: 500,
    probe: async () => ++probes >= 3,
    sleep: async () => {},
  })
  assert.equal(hit, true)
  assert.equal(probes, 3)

  const miss = await waitForSocket('/s.sock', {
    timeoutMs: 10,
    intervalMs: 1,
    probe: async () => false,
    sleep: async () => {},
  })
  assert.equal(miss, false)
})

test('bundleLaunchArgs: -g 不抢焦点、-n 不复用旧实例、参数走 --args', () => {
  assert.deepEqual(
    bundleLaunchArgs({ appPath: '/Apps/GlassPane Daemon.app', args: ['--socket-path', '/s.sock'] }),
    ['-g', '-n', '-a', '/Apps/GlassPane Daemon.app', '--args', '--socket-path', '/s.sock'],
  )
  assert.deepEqual(
    bundleLaunchArgs({ appPath: '/Apps/GlassPane.app' }),
    ['-g', '-n', '-a', '/Apps/GlassPane.app'],
    '无参数时不得留下空的 --args 尾',
  )
  assert.deepEqual(
    bundleLaunchArgs({ appPath: '/Apps/A.app', background: false }),
    ['-n', '-a', '/Apps/A.app'],
  )
})

test('daemonStartCommand / guiStartCommand: bundle 经 open，裸二进制直接 exec', () => {
  const plan = bundlePlan({ homeDir: '/Users/dev', buildDir: BUILD_DIR })
  const bundled = daemonStartCommand({
    daemonLaunch: { path: plan.daemonExecutable, viaBundle: true },
    daemonApp: plan.daemonApp,
    socketPath: '/s.sock',
  })
  assert.equal(bundled.launchPath, '/usr/bin/open')
  assert.deepEqual(bundled.args, ['-g', '-n', '-a', plan.daemonApp, '--args', '--socket-path', '/s.sock'])

  const bare = daemonStartCommand({
    daemonLaunch: { path: '/build/glasspaned', viaBundle: false },
    daemonApp: plan.daemonApp,
    socketPath: '/s.sock',
  })
  assert.deepEqual(bare, { launchPath: '/build/glasspaned', args: ['--socket-path', '/s.sock'] })

  const guiBundled = guiStartCommand({
    guiLaunch: { path: plan.settingsExecutable, viaBundle: true },
    settingsApp: plan.settingsApp,
  })
  assert.deepEqual(guiBundled, { launchPath: '/usr/bin/open', args: ['-g', '-n', '-a', plan.settingsApp] })
  const guiBare = guiStartCommand({ guiLaunch: { path: '/build/glasspane-settings', viaBundle: false } })
  assert.deepEqual(guiBare, { launchPath: '/build/glasspane-settings', args: [] })
})

test('launchdKickstartArgs：收拢旧实例后由 launchd 接管（不靠 KeepAlive 自动复活）', () => {
  assert.deepEqual(
    launchdKickstartArgs({ label: 'com.glasspane.daemon', uid: '501' }),
    ['kickstart', '-k', 'gui/501/com.glasspane.daemon'],
  )
})

test('loadedLaunchdProgram：从 launchctl print 取已加载作业路径', () => {
  const sample = [
    '\t\tpath = /Users/dev/Library/LaunchAgents/com.glasspane.daemon.plist',
    '\t\tstate = spawn scheduled',
    '\t\tprogram = /Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned',
    '\t\tlast exit code = 78: EX_CONFIG',
  ].join('\n')
  assert.equal(loadedLaunchdProgram(sample),
    '/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned')
  assert.equal(loadedLaunchdProgram(''), null)
  assert.equal(loadedLaunchdProgram(undefined), null)
})

test('launchdNeedsReregister：比对已加载 program，而非 plist 文本', () => {
  assert.equal(launchdNeedsReregister({ alreadyLoaded: false, loadedProgram: null, desiredProgram: '/a' }), false,
    '未加载时走常规 bootstrap')
  assert.equal(launchdNeedsReregister({ alreadyLoaded: true, loadedProgram: '/a', desiredProgram: '/a' }), false,
    '定义一致就别动已加载作业')
  assert.equal(launchdNeedsReregister({ alreadyLoaded: true, loadedProgram: '/old/glasspaned', desiredProgram: '/a' }), true,
    '换 bundle 路径必须 bootout + bootstrap')
  assert.equal(launchdNeedsReregister({ alreadyLoaded: true, loadedProgram: null, desiredProgram: '/a' }), true,
    '读不到定义一律重来（陈旧定义的真机形态：EX_CONFIG）')
})

// ---------------------------------------------------------------------------
// 安装收尾的诚实性：daemon 没实测应答就不许说"安装完成"，启动失败不许说 PID。
// ---------------------------------------------------------------------------

test('nextStepsText: daemon 未通过 hello 校验时先给失败告警与补救命令', () => {
  const unverified = nextStepsText({
    rootDir: '/repo',
    socketPath: '/s.sock',
    guiOpened: true,
    daemonVerified: false,
    daemon: { path: '/repo/glasspaned', viaBundle: true },
  })
  assert.ok(unverified.includes('未通过 hello 校验'), '未校验通过必须显式告警')
  assert.ok(unverified.includes('--restore-launchd'), '告警必须带可执行的补救命令')
  assert.ok(
    unverified.includes('node "/repo/installer/cli.js" --restore-launchd'),
    '补救命令必须是拼好的真实路径，印 "<仓库目录>" 占位符等于没给可执行的东西',
  )

  const verified = nextStepsText({
    rootDir: '/repo',
    socketPath: '/s.sock',
    guiOpened: true,
    daemonVerified: true,
    daemon: { path: '/repo/glasspaned', viaBundle: true },
  })
  assert.ok(!verified.includes('未通过 hello 校验'), '校验通过时不该出现告警')
})

test('nextStepsText: 面板没打开时给的是**真能跑**的打开命令（不是字面量 open）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-panel-open-'))
  const app = path.join(root, SETTINGS_APP_NAME)
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })

  const text = nextStepsText({
    rootDir: '/repo',
    socketPath: '/s.sock',
    guiOpened: false,
    daemon: { path: '/repo/glasspaned', viaBundle: true },
    panel: { viaBundle: true, executable: path.join(app, 'Contents', 'MacOS', PANEL_EXE_NAME), app, exists: true },
  })
  assert.ok(!text.includes('面板已打开'))
  const command = /open "([^"]+)"/.exec(text)
  assert.ok(command, `应给出一条 open 命令：${text}`)
  assert.ok(fs.existsSync(command[1]), `open 的目标必须真的存在，实为 ${command[1]}`)

  // 产物不存在时换成裸二进制说明，而不是把不存在的路径塞进 open。
  const missing = nextStepsText({
    rootDir: '/repo',
    socketPath: '/s.sock',
    guiOpened: false,
    daemon: { path: '/repo/glasspaned', viaBundle: true },
    panel: { viaBundle: true, executable: null, app: path.join(root, '缺失.app'), exists: false },
  })
  assert.ok(!/open "/.test(missing), '没有产物时不许印 open')
  assert.ok(missing.includes('没有可执行的面板产物'), missing)
  fs.rmSync(root, { recursive: true, force: true })
})

test('panelOpenHint: bundle/裸二进制两形态与"什么都没有"那一档分得清', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-panel-hint-'))
  const bin = path.join(root, PANEL_EXE_NAME)
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const bare = panelOpenHint({ panel: { viaBundle: false, executable: bin, app: null, exists: fs.existsSync(bin) } })
  assert.equal(bare.runnable, true)
  assert.ok(bare.text.includes(bin), '裸二进制形态给的是**直接执行**那条，不是 open')
  assert.ok(!bare.text.startsWith('open '), '裸二进制不经 open')
  const gone = panelOpenHint({ panel: { viaBundle: false, executable: path.join(root, 'nope'), app: null, exists: false } })
  assert.equal(gone.runnable, false)
  assert.ok(!gone.text.includes('open "'), '没东西可开时不许印 open')
  fs.rmSync(root, { recursive: true, force: true })
})

test('startDetached: 启动器不存在时报错，而不是打印 PID undefined', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-detach-'))
  const result = await startDetached(
    path.join(dir, 'definitely-not-here'), [], path.join(dir, 'log.txt'),
    { settleMs: 250 },
  )
  assert.equal(result.ok, false)
  assert.equal(result.pid, null)
  assert.ok(result.error && result.error.length > 0, '失败必须带原因')
})

test('startDetached: 日志目录不存在时先建目录再启动', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-detach2-'))
  const logPath = path.join(dir, 'nested', 'missing', 'daemon.log')
  const result = await startDetached('/bin/sleep', ['0.2'], logPath, { settleMs: 250 })
  assert.equal(result.ok, true, `应启动成功：${result.error ?? ''}`)
  assert.ok(typeof result.pid === 'number')
  assert.ok(fs.existsSync(logPath), '日志文件（含父目录）必须由安装器负责创建')
})

// ---------------------------------------------------------------------------
// 审计轮 2 的三条：① 退出码必须反映收尾校验（install.sh exec 透传，agent 只读得到
// 退出码）；② 观察窗口之后子进程已退出/被信号终止不许再报 ok:true；③ 全新机器的
// ~/.glasspane 必须在写 plist 之前由安装器建好——launchd 的 RunAtLoad 才是第一个
// 往那里写的 spawner。
// ---------------------------------------------------------------------------

test('installOutcome: daemon 未实测应答 hello → 退出码非零', () => {
  const failed = installOutcome({ verified: false, daemonExpected: true })
  assert.equal(failed.ok, false)
  assert.equal(failed.exitCode, 1, '未通过校验不得退出 0——否则 install.sh 与调用方一起把半成品安装报成成功')
  assert.equal(failed.verified, false)

  const passed = installOutcome({ verified: true, daemonExpected: true })
  assert.deepEqual({ ok: passed.ok, exitCode: passed.exitCode }, { ok: true, exitCode: 0 })
})

test('installOutcome: 本轮本就不该起 daemon（--no-daemon 且 --no-launchd）时不做失败判定', () => {
  assert.equal(installOutcome({ verified: false, daemonExpected: false }).exitCode, 0,
    '用户显式不要 daemon，"没验到"不是故障')
  // --no-daemon 但保留默认 launchd 时，bootstrap 的 RunAtLoad 已经把 daemon 拉起来了：
  // 这一格必须仍按"该有 daemon"算，否则未启动的 daemon 会被静默放走。
  assert.equal(installOutcome({ verified: false, daemonExpected: true }).exitCode, 1)
})

test('verificationFailureText: 失败提示带退出码 + 真实路径的补救命令', () => {
  const noSocket = verificationFailureText({
    arrived: false,
    socketPath: '/Users/dev/.glasspane/engine.sock',
    daemonLog: '/Users/dev/.glasspane/installer-daemon.log',
    cliPath: '/repo/installer/cli.js',
    exitCode: 1,
  })
  assert.ok(noSocket.includes('安装未完成'), '先说结论')
  assert.ok(noSocket.includes('退出码 1'), '必须点明退出码：脚本调用方只读得到这个')
  assert.ok(noSocket.includes('node "/repo/installer/cli.js" --restore-launchd'),
    '补救命令必须是拼好的真实路径，用户/agent 直接可执行')
  assert.ok(noSocket.includes('/Users/dev/.glasspane/installer-daemon.log'), '必须指向日志')
  assert.ok(noSocket.includes('engine.sock'), '必须指向没等到应答的 socket')

  const badHello = verificationFailureText({
    arrived: true, socketPath: '/s.sock', daemonLog: '/l.log', cliPath: '/c.js', exitCode: 1,
  })
  assert.ok(badHello.includes('socket 在'), 'socket 在但不应答是另一种故障，文案必须分开')
  assert.ok(!badHello.includes('没有等到 daemon 在 /s.sock'), '两种故障不得混成一句')
})

test('ensureLogDir: 全新机器的 ~/.glasspane 可一次递归建立（落点不变，幂等）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-logdir-'))
  const home = path.join(root, 'home')
  const logPath = path.join(home, SOCKET_DIR_NAME, DAEMON_LOG_NAME)
  assert.equal(fs.existsSync(path.join(home, SOCKET_DIR_NAME)), false, '前置：目录原本不存在')

  const first = ensureLogDir(logPath)
  assert.equal(first.ok, true, first.error ?? '')
  assert.equal(first.dir, path.join(home, SOCKET_DIR_NAME))
  assert.ok(fs.existsSync(first.dir), 'launchd StandardOutPath 的目录必须已就位')
  const again = ensureLogDir(logPath)
  assert.equal(again.ok, true, '幂等：重跑安装不报错')
  assert.equal(
    path.dirname(path.join(home, SOCKET_DIR_NAME, SOCKET_FILE_NAME)),
    first.dir,
    'socket 与日志同父目录：这一次 mkdir 同时覆盖两个落点',
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('ensureLogDir: 建不出来时返回原因，让 install() 在写 plist 之前就中止', () => {
  const failed = ensureLogDir('/Users/dev/.glasspane/installer-daemon.log', {
    mkdir: () => { throw new Error('EACCES: permission denied') },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.dir, '/Users/dev/.glasspane')
  assert.ok(failed.error.includes('EACCES'), '失败必须带真实原因，供 install() 抛错')
  assert.ok(failed.error.includes('/Users/dev/.glasspane'), '原因必须点出是哪个目录')
})

test('startDetached: 窗口内非零退出/被信号终止 → ok:false，不再带着作废 PID 报成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-lateexit-'))
  const logPath = path.join(dir, 'daemon.log')

  const exited = await startDetached('/bin/sh', ['-c', 'exit 7'], logPath, { settleMs: 400 })
  assert.equal(exited.ok, false, `秒退的子进程不得报成功：${exited.error ?? ''}`)
  assert.equal(exited.pid, null, 'ok:false 一律不回 PID（那是个已经作废的数字）')
  assert.deepEqual(exited.exit, { code: 7, signal: null }, '观察到的退出状态要如实回传')
  assert.ok(exited.error.includes('7'), '原因必须带上真实退出码')
  assert.ok(exited.error.includes('有界观察'), '必须说明这是有界观察而非存活证明')

  const signalled = await startDetached('/bin/sh', ['-c', 'kill -TERM $$'], logPath, { settleMs: 400 })
  assert.equal(signalled.ok, false, '被 SIGTERM 打掉的子进程同样不是成功')
  assert.equal(signalled.pid, null)
  assert.ok(signalled.exit, '必须观察到"命令已经退出"这个事实')
  assert.ok(
    signalled.exit.signal === 'SIGTERM'
      || (signalled.exit.code !== null && signalled.exit.code !== 0),
    `退出原因必须是信号或非零码，实测到的是 ${JSON.stringify(signalled.exit)}`,
  )

  fs.rmSync(dir, { recursive: true, force: true })
})

test('startDetached: 窗口内 0 退出算命令被受理（`open` 的正常形态），窗口外不作存活结论', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-exit0-'))
  const logPath = path.join(dir, 'daemon.log')

  // /usr/bin/open 提交给 LaunchServices 后就是 0 退出；把它判成失败属于过度修复，
  // 但调用方必须能从 `exit` 读到"命令已退出"这个事实（install() 据此改口）。
  const clean = await startDetached('/bin/sh', ['-c', 'exit 0'], logPath, { settleMs: 400 })
  assert.equal(clean.ok, true, clean.error ?? '')
  assert.deepEqual(clean.exit, { code: 0, signal: null })

  const alive = await startDetached('/bin/sleep', ['1'], logPath, { settleMs: 150 })
  assert.equal(alive.ok, true, alive.error ?? '')
  assert.equal(alive.exit, null, '窗口结束时仍在跑：exit 只能是"未观察到退出"')
  assert.ok(Number.isInteger(alive.pid) && alive.pid > 0)

  assert.ok(LAUNCH_SETTLE_MS >= 400,
    '窗口要给足，否则 `/usr/bin/open` 的非零退出（目标缺失）根本没机会被观察到')
  fs.rmSync(dir, { recursive: true, force: true })
})
