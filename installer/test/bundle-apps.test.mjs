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
  nextStepsText,
  parseArgs,
  launchdPlistString,
  LAUNCHD_LABEL,
  APPS_DIR_NAME,
  DAEMON_APP_NAME,
  DAEMON_EXE_NAME,
  PANEL_EXE_NAME,
  SETTINGS_APP_NAME,
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
  const existsSources = new Set([plan.builtSettingsApp]) // 只有面板产物存在
  const installed = installBundles({
    plan,
    exists: (p) => existsSources.has(p),
    remove: (target) => removed.push(target),
    copy: (source, target) => copied.push([source, target]),
    mkdir: () => {},
  })
  assert.deepEqual(installed, [plan.settingsApp])
  assert.deepEqual(removed, [plan.settingsApp], '覆盖安装：先删旧目标再拷')
  assert.deepEqual(copied, [[plan.builtSettingsApp, plan.settingsApp]])
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
  const first = installBundles({ plan })
  assert.deepEqual(first, [plan.settingsApp])
  const second = installBundles({ plan })
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

test('nextStepsText: bundle 形态与裸二进制形态的条目名各自如实', () => {
  const plan = bundlePlan({ homeDir: '/Users/dev', buildDir: BUILD_DIR })
  const bundled = nextStepsText({
    rootDir: '/repo',
    socketPath: '/s.sock',
    guiOpened: true,
    daemon: { path: plan.daemonExecutable, viaBundle: true },
    settingsApp: plan.settingsApp,
  })
  assert.ok(bundled.includes('GlassPane Daemon'), 'bundle 形态应给出带图标的条目名')
  assert.ok(bundled.includes('面板已打开'))
  assert.ok(bundled.includes('授权勾选必须人工'), '诚实边界：TCC 不程序化')
  assert.ok(bundled.includes(plan.daemonExecutable), '给出 --permissions 验证命令的完整路径')
  assert.ok(bundled.includes('--permissions'))

  const bare = nextStepsText({
    rootDir: '/repo',
    socketPath: '/s.sock',
    guiOpened: false,
    daemon: { path: '/repo/engine/.build/release/glasspaned', viaBundle: false },
  })
  assert.ok(bare.includes('裸二进制形态'), '裸二进制必须如实说明条目只显示文件名')
  assert.ok(bare.includes('glasspaned'))
  assert.ok(bare.includes('open "'), '未开面板时给出打开指引')
  assert.ok(bare.includes(SETTINGS_APP_NAME))
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
