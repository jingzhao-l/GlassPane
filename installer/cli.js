#!/usr/bin/env node
/**
 * @glasspane/installer — 一键安装 CLI（零第三方依赖，Node >= 18）。
 *
 * 流程：terminal onboarding 横幅 → 环境预检（node/swift/git/open）→ 定位项目
 * 根目录 → npm install（workspaces）→ 编译 TS（kernel → mcp-shell）→ swift
 * build -c release（engine）→ make-app.sh 打包**并签名**两个 .app → 安置到
 * ~/Applications → 以 bundle 内可执行注册 launchd 自启并启动 daemon → 打开
 * GlassPane.app 设置面板进入权限引导（授权对象是 daemon，见 P1 v1.2 §11）→
 * 打印后续使用说明（含 MCP 客户端接入配置片段）。用户侧一键入口为仓库根
 * install.sh（源码定位/clone 后委托本文件）。
 *
 * 所有辅助函数均具名导出，供 node:test 单测（test/cli.test.mjs），主流程通过
 * import.meta.url 守卫隔离，测试导入不会触发安装动作。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import net from 'node:net'

// 显式常量，避免散落魔法字符串。
export const MIN_NODE_MAJOR = 18
export const SOCKET_DIR_NAME = '.glasspane'
export const SOCKET_FILE_NAME = 'engine.sock'
export const DAEMON_LOG_NAME = 'installer-daemon.log'
export const LAUNCHD_LABEL = 'com.glasspane.daemon'
export const LAUNCHD_DIR_NAME = 'Library/LaunchAgents'
export const LAUNCHD_FILE_NAME = `${LAUNCHD_LABEL}.plist`

/** bundle 安置目录与产物名（P1 v1.2 §11.1：daemon 必须有 bundle 身份，系统设置
 *  的权限列表才会显示可读名与图标，「+」选择器也才找得到它。安置在
 *  ~/Applications 而非 `.build` 隐藏目录，同一理由）。 */
export const APPS_DIR_NAME = 'Applications'
export const SETTINGS_APP_NAME = 'GlassPane.app'
export const DAEMON_APP_NAME = 'GlassPane Daemon.app'
export const DAEMON_EXE_NAME = 'glasspaned'
export const PANEL_EXE_NAME = 'glasspane-settings'

/** 源码仓库公共地址（install.sh  clone 与"未找到仓库"指引共用同一真源）。 */
export const REPO_URL = 'https://github.com/jingzhao-l/GlassPane.git'
/** 一键安装入口脚本的 raw 地址（用户侧 curl 指引真源）。 */
export const INSTALL_SH_URL =
  'https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh'

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
}

/** 简单着色工具（非 TTY 时自动降级为纯文本）。 */
export function paint(text, color, enabled = process.stdout.isTTY) {
  return enabled ? `${ANSI[color] ?? ''}${text}${ANSI.reset}` : text
}

// ---------------------------------------------------------------------------
// 纯逻辑层（可单测）
// ---------------------------------------------------------------------------

/** 解析 CLI 参数；未知/带值参数缺参时返回 { error }。 */
export function parseArgs(argv) {
  const defaults = {
    repoDir: null,
    prompt: true,
    gui: true,
    daemon: true,
    app: true,
    launchd: true,
    replaceDaemon: false,
    skipBuild: false,
    help: false,
  }
  const opts = { ...defaults }
  const rest = [...argv]
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--repo':
        index += 1
        if (index >= rest.length || rest[index].startsWith('--')) {
          return { options: defaults, error: '--repo 需要一个目录参数' }
        }
        opts.repoDir = rest[index]
        break
      case '--no-prompt':
        opts.prompt = false
        break
      case '--no-gui':
        opts.gui = false
        break
      case '--no-app':
        opts.app = false
        break
      case '--no-launchd':
        opts.launchd = false
        break
      case '--no-daemon':
        opts.daemon = false
        break
      case '--replace-daemon':
        opts.replaceDaemon = true
        break
      case '--skip-build':
        opts.skipBuild = true
        break
      default:
        return { options: defaults, error: `未知参数：${arg}（--help 查看用法）` }
    }
  }
  return { options: opts, error: null }
}

/** 从起始目录向上逐级寻找含 engine/Package.swift 与 mcp-shell/package.json 的根目录。 */
export function resolveProjectRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir)
  while (true) {
    const hasEngine = fs.existsSync(path.join(dir, 'engine', 'Package.swift'))
    const hasShell = fs.existsSync(path.join(dir, 'mcp-shell', 'package.json'))
    if (hasEngine && hasShell) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

/** 解析 `node --version` 输出的主版本号；不可解析/执行失败返回 0。 */
export function nodeMajorVersion(nodePath = process.execPath) {
  try {
    const result = spawnSync(nodePath, ['--version'], { encoding: 'utf8', timeout: 5000 })
    if (result.status !== 0) {
      return 0
    }
    const match = /^v(\d+)\./.exec((result.stdout ?? '').trim())
    return match ? Number(match[1]) : 0
  } catch {
    return 0
  }
}

/** 检查命令是否存在：优先 `<bin> --version`，失败时退化检查 /usr/bin/<bin>
 *  可执行文件（覆盖 open 等不支持 --version 的命令）。真实探测，不伪造。 */
export function commandAvailable(bin) {
  const byVersion = (() => {
    try {
      const result = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000 })
      return result.status === 0
    } catch {
      return false
    }
  })()
  if (byVersion) {
    return true
  }
  try {
    const absolute = path.join('/usr/bin', bin)
    fs.accessSync(absolute, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 环境预检快照，返回每种依赖的可用状态（真实探测，不伪造）。 */
export function checkEnvironment({ nodePath = process.execPath } = {}) {
  return {
    nodeMajor: nodeMajorVersion(nodePath),
    nodeOk: nodeMajorVersion(nodePath) >= MIN_NODE_MAJOR,
    npm: commandAvailable('npm'),
    swift: commandAvailable('swift'),
    git: commandAvailable('git'),
    open: commandAvailable('open'),
  }
}

/** 汇总预检结果：缺项按严重程度排序返回可读描述（空数组 = 全部通过）。 */
export function preflightIssues(env) {
  const issues = []
  if (env.nodeMajor === 0) {
    issues.push(`无法解析 Node.js 版本（${env.nodeMajor === 0 ? '执行失败' : ''}）`)
  } else if (!env.nodeOk) {
    issues.push(`Node.js 需要 >= ${MIN_NODE_MAJOR}，当前为 ${env.nodeMajor}`)
  }
  if (!env.npm) {
    issues.push('未找到 npm')
  }
  if (!env.swift) {
    issues.push('未找到 swift（需安装 Xcode Command Line Tools：xcode-select --install）')
  }
  if (!env.git) {
    issues.push('未找到 git')
  }
  if (!env.open) {
    issues.push('未找到 open（本安装器面向 macOS）')
  }
  return issues
}

/** 探测 unix socket 是否已有 daemon 在监听；连接超时 800ms 视为不可达。 */
export function socketReachable(socketPath) {
  return new Promise((resolve) => {
    const client = net.connect({ path: socketPath })
    const onDone = (ok) => {
      client.removeAllListeners()
      client.destroy()
      resolve(ok)
    }
    client.setTimeout(800, () => onDone(false))
    client.on('connect', () => onDone(true))
    client.on('timeout', () => onDone(false))
    client.on('error', () => onDone(false))
  })
}

/** 等待 socket 重新可达（kill 之后 launchd 会按 ThrottleInterval 延迟重拉）；
 *  超时返回 false，调用方按"未接管"继续走手动启动分支。 */
export async function waitForSocket(
  socketPath,
  { timeoutMs = 8000, intervalMs = 500, probe = socketReachable, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(socketPath)) return true
    await sleep(intervalMs)
  }
  return false
}

/** bundle 安装计划（纯函数，P1 v1.2 §11.1）：构建目录里的 .app → 安置到
 *  ~/Applications（可见、稳定、非隐藏），并给出 launchd/GUI 应使用的路径。
 *  `appsDir` 显式传入时覆盖默认（测试与非标准安装位置用）。 */
export function bundlePlan({ homeDir, buildDir, appsDir = null, appPackaged = true } = {}) {
  const targetAppsDir = appsDir ?? path.join(homeDir ?? '', APPS_DIR_NAME)
  const bundled = (name) => path.join(targetAppsDir, name)
  return {
    appsDir: targetAppsDir,
    // 构建产物（make-app.sh 的输出位置）
    builtSettingsApp: path.join(buildDir, SETTINGS_APP_NAME),
    builtDaemonApp: path.join(buildDir, DAEMON_APP_NAME),
    // 安置后的位置
    settingsApp: appPackaged ? bundled(SETTINGS_APP_NAME) : null,
    daemonApp: appPackaged ? bundled(DAEMON_APP_NAME) : null,
    daemonExecutable: appPackaged
      ? path.join(bundled(DAEMON_APP_NAME), 'Contents', 'MacOS', DAEMON_EXE_NAME)
      : null,
    settingsExecutable: appPackaged
      ? path.join(bundled(SETTINGS_APP_NAME), 'Contents', 'MacOS', PANEL_EXE_NAME)
      : null,
  }
}

/** 选择 daemon 启动路径：bundle 就位 → 用 bundle 内可执行（权限条目才带名字
 *  与图标）；否则退回裸二进制并如实告警（`viaBundle=false`）。纯函数，
 *  文件系统可达性由注入的 `exists` 决定，便于单测。 */
export function daemonLaunchPath({ plan, bareBin, exists = fs.existsSync } = {}) {
  const bundled = plan?.daemonExecutable ?? null
  if (bundled && exists(bundled)) {
    return { path: bundled, viaBundle: true }
  }
  return { path: bareBin, viaBundle: false }
}

/** 设置面板启动路径：同上，优先 bundle。 */
export function settingsLaunchPath({ plan, bareBin, exists = fs.existsSync } = {}) {
  const bundled = plan?.settingsExecutable ?? null
  if (bundled && exists(bundled)) {
    return { path: bundled, viaBundle: true }
  }
  return { path: bareBin, viaBundle: false }
}

/** 从 `ps -Ao pid=,comm=` 文本里挑出指定可执行名的进程 PID（纯函数）。
 *  TCC 席位按进程身份记账，多实例并存时"系统设置里看到的条目"与"实际服务
 *  socket 的实例"可能不是同一个进程——旧构建实例必须先收拢再授权。 */
export function pidsFromPs(psOutput, { exeName, selfPid = process.pid } = {}) {
  const pids = []
  for (const line of String(psOutput ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf(' ')
    if (separator <= 0) continue
    const pid = Number(trimmed.slice(0, separator))
    const command = trimmed.slice(separator + 1).trim()
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (pid === selfPid) continue
    if (path.basename(command) === exeName) pids.push(pid)
  }
  return pids
}

export function daemonPidsFromPs(psOutput, { selfPid = process.pid } = {}) {
  return pidsFromPs(psOutput, { exeName: DAEMON_EXE_NAME, selfPid })
}

export function panelPidsFromPs(psOutput, { selfPid = process.pid } = {}) {
  return pidsFromPs(psOutput, { exeName: PANEL_EXE_NAME, selfPid })
}

/** 按可执行名列出在跑的进程 PID（副作用层：读 `ps`，解析交给纯函数）。 */
export function listRunningPids(exeName, { spawn = spawnSync } = {}) {
  const result = spawn('ps', ['-Ao', 'pid=,comm='], { encoding: 'utf8' })
  if (result.status !== 0) {
    return []
  }
  return pidsFromPs(result.stdout, { exeName })
}

/** 向指定 PID 发 SIGTERM（daemon 侧装有信号处理 → 清理 socket 后退出；
 *  launchd 托管时异常退出会按新 plist 重新拉起）。1s 后仍存活的补 SIGKILL：
 *  实测存在收不到/不响应 SIGTERM 的旧 daemon 实例（主循环未跑起来时
 *  SIG_IGN 生效而 handler 永不执行），它们占着 socket 却是死身份，必须清掉。 */
export function terminatePids(pids, { spawn = spawnSync } = {}) {
  const kill = (pid, signal) => spawn('kill', signal ? ['-' + signal, String(pid)] : [String(pid)])
  for (const pid of pids) kill(pid)
  spawn('sleep', ['1'])
  const forced = []
  for (const pid of pids) {
    if (kill(pid, '0').status === 0) {
      kill(pid, '9')
      forced.push(pid)
    }
  }
  return { terminated: [...pids], forced }
}

/** 把 make-app.sh 的两个 bundle 安置到 ~/Applications（覆盖式，幂等）。
 *  返回实际安置的条目；源缺失即跳过（--no-app 或构建产物不全时不报错）。 */
export function installBundles({ plan, exists = fs.existsSync, remove = fs.rmSync, copy = fs.cpSync, mkdir = fs.mkdirSync } = {}) {
  const installed = []
  if (!plan?.appsDir) return installed
  mkdir(plan.appsDir, { recursive: true })
  const pairs = [
    [plan.builtSettingsApp, plan.settingsApp],
    [plan.builtDaemonApp, plan.daemonApp],
  ]
  for (const [source, target] of pairs) {
    if (!source || !target || !exists(source)) continue
    remove(target, { recursive: true, force: true })
    copy(source, target, { recursive: true })
    installed.push(target)
  }
  return installed
}

/** 生成 launchd 用户代理 plist（纯函数，零副作用；XML 转义防路径注入）。
 *  KeepAlive 采用 SuccessfulExit=false：仅异常退出时由 launchd 重启，
 *  避免正常 shutdown 也被反复拉起。 */
export function launchdPlistString({ label, daemonBin, socketPath, logPath }) {
  const escapeXml = (value) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const argumentNode = (value) => `      <string>${escapeXml(value)}</string>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    `    <key>Label</key>`,
    `    <string>${escapeXml(label)}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    argumentNode(daemonBin),
    argumentNode('--socket-path'),
    argumentNode(socketPath),
    '    </array>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
    '    <key>KeepAlive</key>',
    '    <dict>',
    '      <key>SuccessfulExit</key>',
    '      <false/>',
    '    </dict>',
    '    <key>ThrottleInterval</key>',
    '    <integer>5</integer>',
    '    <key>StandardOutPath</key>',
    `    <string>${escapeXml(logPath)}</string>`,
    '    <key>StandardErrorPath</key>',
    `    <string>${escapeXml(logPath)}</string>`,
    '  </dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** 注册 launchd 用户代理（幂等）：已加载则跳过，未加载则 bootstrap
 *  gui/<uid>。返回 { ok, already, message }，失败携带真实 stderr。 */
export function launchctlBootstrap(label, plistPath) {
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim()
  if (!uid) {
    return { ok: false, already: false, message: '无法解析当前 uid（id -u 失败），跳过 launchd 注册' }
  }
  const probe = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8' })
  if (probe.status === 0) {
    return { ok: true, already: true, message: `launchd 已加载 ${label}（gui/${uid}），跳过 bootstrap` }
  }
  const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' })
  const stderr = (boot.stderr ?? '').trim()
  const status = boot.status
  if (status === 0 || status === 5 || /already/i.test(stderr)) {
    return {
      ok: true,
      already: status !== 0,
      message: stderr || `launchctl bootstrap 完成（gui/${uid}/${label}）`,
    }
  }
  return {
    ok: false,
    already: false,
    message: stderr || `launchctl bootstrap 失败，退出码 ${status}（gui/${uid}/${label}）`,
  }
}

// ---------------------------------------------------------------------------
// 执行层
// ---------------------------------------------------------------------------

/** 前台运行命令并透传输出；非零退出码 → reject 携带清晰描述。 */
export function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', (error) => reject(new Error(`${cmd} 启动失败：${error.message}`)))
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${cmd} 失败，退出码 ${code}`))
      }
    })
  })
}

/** 暂停询问；非 TTY 或 --no-prompt 时自动视为同意（不阻塞自动化）。 */
export async function confirm(question, { autoYes = false } = {}) {
  if (autoYes || !process.stdin.isTTY) {
    return true
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question} (Enter 继续 / n 跳过) `)
    return !/^n/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** 后台分离启动长驻进程（daemon / GUI），日志追加写盘，返回 PID。 */
export function startDetached(binPath, args, logPath) {
  const logStream = fs.openSync(logPath, 'a')
  const child = spawn(binPath, args, {
    detached: true,
    stdio: ['ignore', logStream, logStream],
  })
  child.unref()
  return child.pid
}

/** bundle 形态的 `open` 参数（纯函数）。
 *  为什么走 `open -a`：把进程登记为那个 .app 的主进程（LaunchServices 里有
 *  这条记录，系统设置的「+」选择器与拖拽才认它），并且
 *  `-g` = 不抢焦点（安装不该把窗口顶到用户面前），`-n` = 绕开"同 bundle 复用
 *  已运行实例"，确保起的是刚安置好的这份产物。
 *  如实边界：条目在权限列表里的具体渲染（名字/图标）仍需真机目视确认，
 *  本函数只保证启动路径与 bundle 身份一致。 */
export function bundleLaunchArgs({ appPath, args = [], background = true }) {
  return [
    ...(background ? ['-g'] : []),
    '-n',
    '-a',
    appPath,
    ...(args.length > 0 ? ['--args', ...args] : []),
  ]
}

/** daemon 启动命令（纯函数）：bundle 形态经 open，裸二进制形态直接 exec。 */
export function daemonStartCommand({ daemonLaunch, daemonApp = null, socketPath }) {
  const socketArgs = ['--socket-path', socketPath]
  if (daemonLaunch.viaBundle && daemonApp) {
    return {
      launchPath: '/usr/bin/open',
      args: bundleLaunchArgs({ appPath: daemonApp, args: socketArgs }),
    }
  }
  return { launchPath: daemonLaunch.path, args: socketArgs }
}

/** 设置面板启动命令（纯函数），口径同 daemon。 */
export function guiStartCommand({ guiLaunch, settingsApp = null }) {
  if (guiLaunch.viaBundle && settingsApp) {
    return {
      launchPath: '/usr/bin/open',
      args: bundleLaunchArgs({ appPath: settingsApp }),
    }
  }
  return { launchPath: guiLaunch.path, args: [] }
}

/** 打印安装历史步骤日志（消歧：与 daemon 日志文件区分）。 */
export function printStep(message, pending = false) {
  const prefix = pending ? paint('⣾  ', 'cyan') : paint('✔  ', 'green')
  process.stdout.write(`${prefix}${message}\n`)
}

/** --help 用法文本（单一真源，主流程与 parseArgs 共用）。 */
export function usageText() {
  return [
    paint('GlassPane 一键安装器', 'bold'),
    '',
    '用法: node installer/cli.js [选项]',
    '',
    '选项:',
    '  --repo <目录>      指定项目根目录（默认自动向上查找）',
    '  --no-prompt        跳过每步确认（脚本/自动化场景）',
    '  --no-daemon        不启动 glasspaned',
    '  --replace-daemon   先结束已在跑的 glasspaned 实例（旧构建的 daemon 会继续占',
    '                     socket，让系统设置里的授权条目与实际服务实例对不上）',
    '  --no-gui           不打开 glasspane-settings GUI',
    '  --no-app           不打包/安置 .app（仅裸二进制产物；权限条目将只显示文件',
    '                     名且无图标，见 P1 v1.2 §11.1）',
    '  --no-launchd       不注册开机自启（launchd bootstrap）',
    '  --skip-build       跳过 npm/tsc/swift 编译（已构建过时使用）',
    '  -h, --help         显示本帮助',
    '',
  ].join('\n')
}

/** 生成 MCP 客户端接入配置片段（纯函数）：mcp-shell 以仓库内构建产物直连，
 *  与 §33.2 决策链一致——npx 发布形态挂 Phase B，本地安装即所得。
 *  socketPath 为 daemon 默认路径时仍显式写入 env，避免读者误以为不可配置。 */
export function mcpClientConfigSnippet({ rootDir, socketPath }) {
  return JSON.stringify(
    {
      mcpServers: {
        glasspane: {
          command: 'node',
          args: [path.join(rootDir, 'mcp-shell', 'dist', 'index.js')],
          env: { GLASSPANE_ENGINE_SOCK: socketPath },
        },
      },
    },
    null,
    2,
  )
}

/** 安装完成后的使用说明（§34.2 步骤 8：mcp-shell 接入 + 授权/维护提示）。
 *  `daemon` 描述实际启动形态（P1 v1.2 §11.1）：bundle 形态下系统设置权限列表里
 *  出现带图标的「GlassPane Daemon」，裸二进制形态只出现文件名——文案必须与真实
 *  形态一致，否则用户会在面板里找一个不存在的条目。 */
export function nextStepsText({
  rootDir,
  socketPath,
  guiOpened,
  daemon = { viaBundle: false, path: null },
  settingsApp = null,
}) {
  const settingsAppHint =
    settingsApp ?? path.join(rootDir, 'engine', '.build', 'release', SETTINGS_APP_NAME)
  const entryName = daemon.viaBundle ? 'GlassPane Daemon' : 'glasspaned'
  return [
    paint('后续使用说明', 'bold'),
    '',
    '1. MCP 客户端（Claude Desktop / Cursor / 任意 MCP host）接入配置片段：',
    '',
    mcpClientConfigSnippet({ rootDir, socketPath }),
    '',
    '2. TCC 权限（辅助功能/输入监控/屏幕录制/开发者工具）：授权对象是 **daemon 进程**',
    '   而不是设置窗口；授权勾选必须人工完成，无程序化路径（P1 v1.2 §10.1 / §11.2）。',
    daemon.viaBundle
      ? '   在系统设置的对应权限列表里应能看到「GlassPane Daemon」（带图标，可用「+」选择或从 Finder 拖入）。'
      : '   当前 daemon 是裸二进制形态，权限列表里只会显示文件名「glasspaned」（无图标，「+」选择器看不到隐藏目录）；重跑安装（默认打包 .app）可获得带图标的条目。',
    guiOpened
      ? '   面板已打开：点权限卡「授权」会让 daemon 以自身身份发起申请并跳转到对应系统面板。'
      : `   打开面板：open "${settingsAppHint}"（点权限卡「授权」即由 daemon 自身发起申请）。`,
    `   验证 daemon 自报的席位与主体：${daemon.path ?? path.join(rootDir, 'engine', '.build', 'release', DAEMON_EXE_NAME)} --permissions`,
    '3. daemon 已注册 launchd 开机自启（--no-launchd 可跳过）；维护命令：',
    '   glasspaned --approval-audit / --approval-verify / --prune-evidence / --evidence-stats',
    `4. entryName 核对：设置面板「Daemon 状态 → 主体」应与上面「${entryName}」一致；不一致说明连到了别的构建实例。`,
    '5. registry 发布形态（npx glasspane-mcp）挂 kernel Phase B（P4 §33.2 决策链），当前以本仓库产物为准。',
    '',
  ].join('\n')
}

/** 未定位到仓库时的指引文本（纯函数，可单测）。 */
export function repoMissingText() {
  return [
    '未定位到 GlassPane 项目根目录（需同时包含 engine/Package.swift 与 mcp-shell/package.json）。',
    '可选路径：',
    `  a) 一键安装（自动 clone 源码后进入本流程）：curl -fsSL ${INSTALL_SH_URL} | sh`,
    `  b) 手工 clone：git clone ${REPO_URL} && cd GlassPane && node installer/cli.js`,
    '  c) 已在本仓库其他位置：--repo <目录> 或 GLASSPANE_REPO 环境变量指定根目录。',
  ].join('\n')
}

/** 主安装流程；所有副作用步骤均记录真实执行结果，失败即抛错终止。 */
export async function install({ options = parseArgs([]).options, env = process.env } = {}) {
  const explicitRoot = options.repoDir ? path.resolve(options.repoDir) : null
  const envRoot = env.GLASSPANE_REPO ? path.resolve(env.GLASSPANE_REPO) : null
  const rootDir = explicitRoot ?? envRoot ?? resolveProjectRoot()

  if (!rootDir || !fs.existsSync(rootDir)) {
    throw new Error(repoMissingText())
  }

  const engineDir = path.join(rootDir, 'engine')
  const buildDir = path.join(engineDir, '.build', 'release')
  const socketPath = path.join(process.env.HOME ?? '', SOCKET_DIR_NAME, SOCKET_FILE_NAME)
  const daemonBin = path.join(buildDir, 'glasspaned')
  const settingsBin = path.join(buildDir, 'glasspane-settings')
  const daemonLog = path.join(process.env.HOME ?? '', SOCKET_DIR_NAME, DAEMON_LOG_NAME)
  // bundle 安置计划（P1 v1.2 §11.1）：--no-app 时 appPackaged=false，后续一律
  // 回退裸二进制并如实告警。
  const plan = bundlePlan({
    homeDir: process.env.HOME ?? '',
    buildDir,
    appPackaged: options.app,
  })

  printStep(`项目根目录: ${rootDir}`)

  if (!options.skipBuild) {
    printStep('安装 npm 依赖（workspaces: kernel / mcp-shell / installer）……')
    await run('npm', ['install'], { cwd: rootDir })

    printStep('编译 kernel……')
    await run('npm', ['run', 'build', '--workspace', '@iterate/kernel'], { cwd: rootDir })

    printStep('编译 mcp-shell……')
    await run('npm', ['run', 'build', '--workspace', '@glasspane/mcp-shell'], { cwd: rootDir })

    printStep('编译 Swift engine（glasspaned + glasspane-settings，release）……')
    await run('swift', ['build', '-c', 'release'], { cwd: engineDir })
  }

  if (options.app) {
    const makeAppScript = path.join(engineDir, 'scripts', 'make-app.sh')
    if (!fs.existsSync(makeAppScript)) {
      throw new Error(`.app 打包脚本缺失：${makeAppScript}（仓库结构不完整）`)
    }
    if (!fs.existsSync(settingsBin)) {
      throw new Error(`设置面板产物不存在：${settingsBin}（可用 --no-app 跳过 .app 打包）`)
    }
    printStep('打包并签名 .app（GlassPane.app + GlassPane Daemon.app）……')
    await run('/bin/bash', [
      makeAppScript,
      '--settings-bin', settingsBin,
      '--daemon-bin', daemonBin,
      '--out', buildDir,
    ], { cwd: engineDir })
    // 安置到 ~/Applications：TCC 条目要能被用户在系统设置的「+」选择器与
    // Finder 里找到，隐藏目录 `.build` 里的产物做不到这一点（P1 v1.2 §11.1）。
    const installed = installBundles({ plan })
    for (const app of installed) {
      printStep(`已安置：${app}`)
    }
    if (installed.length === 0) {
      printStep('未安置任何 .app（make-app.sh 未产出 bundle），后续按裸二进制形态运行')
    }
  }

  // daemon 实际启动路径：bundle 优先，裸二进制兜底（两者授权主体不同，
  // 混用会让用户在系统设置里找不到对应条目）。
  const daemonLaunch = daemonLaunchPath({ plan, bareBin: daemonBin })
  if (!daemonLaunch.viaBundle) {
    printStep(
      paint(
        '提醒：daemon 以裸二进制运行——系统设置权限列表里只会显示文件名「glasspaned」，'
        + '无图标且「+」选择器看不到隐藏目录（去掉 --no-app 重跑可获得带图标的「GlassPane Daemon」）',
        'yellow',
      ),
    )
  }

  // 开机自启先于手工启动注册：bootstrap 触发 RunAtLoad 会立即拉起 daemon，
  // 随后手工启动步骤发现 socket 已可达即跳过——避免两个实例抢 socket。
  if (options.launchd) {
    const launchAgentsDir = path.join(process.env.HOME ?? '', ...LAUNCHD_DIR_NAME.split('/'))
    const plistPath = path.join(launchAgentsDir, LAUNCHD_FILE_NAME)
    fs.mkdirSync(launchAgentsDir, { recursive: true })
    if (!fs.existsSync(daemonLaunch.path)) {
      throw new Error(`daemon 产物不存在：${daemonLaunch.path}（开机自启指向的可执行缺失）`)
    }
    const plistXml = launchdPlistString({
      label: LAUNCHD_LABEL,
      daemonBin: daemonLaunch.path,
      socketPath,
      logPath: daemonLog,
    })
    fs.writeFileSync(plistPath, plistXml, { mode: 0o644 })
    const bootstrapResult = launchctlBootstrap(LAUNCHD_LABEL, plistPath)
    if (!bootstrapResult.ok) {
      throw new Error(`launchd 注册失败：${bootstrapResult.message}`)
    }
    printStep(bootstrapResult.already ? bootstrapResult.message : `开机自启已注册（${plistPath}）`)
  }

  if (options.daemon) {
    if (!fs.existsSync(daemonLaunch.path)) {
      throw new Error(`daemon 产物不存在：${daemonLaunch.path}（请勿在未构建时使用 --skip-build 启动 daemon）`)
    }
    let relaunchedByLaunchd = false
    const staleDaemons = listRunningPids(DAEMON_EXE_NAME)
    const stalePanels = listRunningPids(PANEL_EXE_NAME)
    if (staleDaemons.length > 0 || stalePanels.length > 0) {
      const summary = `daemon ${staleDaemons.join(',') || '无'}｜面板 ${stalePanels.join(',') || '无'}`
      if (options.replaceDaemon) {
        const result = terminatePids([...staleDaemons, ...stalePanels])
        printStep(
          result.forced.length > 0
            ? `既有实例已收拢（SIGTERM 未生效、已强杀：${result.forced.join(', ')}）`
            : `已结束既有实例：${result.terminated.join(', ')}`,
        )
        // launchd 托管时异常退出会按新 plist 重拉（ThrottleInterval 最长 5s）。
        // 必须等它把 socket 接回去再决定要不要手动起——否则会同时存在两个
        // daemon 身份（真机踩过：launchd 实例与被抢走 socket 的手动实例并存）。
        if (staleDaemons.length > 0 && options.launchd) {
          relaunchedByLaunchd = await waitForSocket(socketPath)
          if (relaunchedByLaunchd) {
            printStep('launchd 已按新配置重新拉起 daemon')
          }
        }
      } else {
        printStep(
          paint(
            `检测到旧实例在跑（${summary}）：多实例会让系统设置里的授权条目与实际服务实例对不上；`
            + '加 --replace-daemon 可一并收拢',
            'yellow',
          ),
        )
      }
    }
    if (relaunchedByLaunchd || await socketReachable(socketPath)) {
      printStep(`daemon 已在监听 ${socketPath}，跳过启动（若为旧构建实例，用 --replace-daemon 重跑）`)
    } else {
      const start = daemonStartCommand({ daemonLaunch, daemonApp: plan.daemonApp, socketPath })
      printStep(`启动 glasspaned（${daemonLaunch.viaBundle ? 'bundle 形态，经 open 登记主进程' : '裸二进制形态'}，日志: ${daemonLog}）……`)
      const pid = startDetached(start.launchPath, start.args, daemonLog)
      printStep(`glasspaned 启动命令已发出，PID ${pid}`)
    }
  }

  let guiOpened = false
  if (options.gui) {
    const guiLaunch = settingsLaunchPath({ plan, bareBin: settingsBin })
    if (!fs.existsSync(guiLaunch.path)) {
      throw new Error(`设置面板产物不存在：${guiLaunch.path}`)
    }
    const guiStart = guiStartCommand({ guiLaunch, settingsApp: plan.settingsApp })
    printStep(`打开设置面板（${guiLaunch.viaBundle ? 'GlassPane.app，经 open 登记主进程' : '裸二进制'}，权限引导）……`)
    startDetached(guiStart.launchPath, guiStart.args, daemonLog)
    guiOpened = true
  }

  printStep('安装完成。')
  process.stdout.write(`\n${nextStepsText({
    rootDir,
    socketPath,
    guiOpened,
    daemon: daemonLaunch,
    settingsApp: plan.settingsApp ?? undefined,
  })}\n`)
}

/** 入口守卫：直接用 node 运行本文件时才走安装流程（测试导入仅取函数）。 */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const { options, error } = parseArgs(process.argv.slice(2))
  if (error) {
    process.stderr.write(`\n${paint(`参数错误：${error}`, 'red')}\n\n`)
    process.stderr.write(usageText())
    process.exit(2)
  }
  if (options.help) {
    process.stdout.write(usageText())
    process.exit(0)
  }

  const env = checkEnvironment()
  const issues = preflightIssues(env)
  if (issues.length > 0) {
    process.stderr.write(paint('\n环境预检未通过：\n', 'red'))
    for (const issue of issues) {
      process.stderr.write(`  - ${issue}\n`)
    }
    process.stderr.write('\n修复后重新运行即可。\n')
    process.exit(1)
  }

  install({ options })
    .then(() => {
      process.stdout.write('\n')
    })
    .catch((installError) => {
      process.stderr.write(paint(`\n安装失败：${installError.message}\n`, 'red'))
      process.exit(1)
    })
}