#!/usr/bin/env node
/**
 * glasspane-install — 一键安装 CLI（零第三方依赖，Node >= 18）。
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
 *
 * 对外契约：退出码是脚本/agent 唯一机器可读的结论——0 = 产物就位**且**daemon 实测
 * 应答过 hello（或本轮按要求压根不该起 daemon），1 = 未通过校验或构建/注册失败，
 * 2 = 参数错误。install.sh 以 exec 委托，退出码原样透传。口径详见 usageText。
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

/** 分离启动后的**有界观察窗口**：spawn 失败（ENOENT、参数被拒）以异步 error 事件
 *  落地，`/usr/bin/open` 目标缺失则以非零退出落地，两者都发生在启动后的几百毫秒
 *  内，所以窗口要给足才能真的看见失败（旧值 150ms 常常在 `open` 退出前就收工，
 *  等于那道退出码分支没有触发路径）。窗口外的崩溃仍然看不到——存活判定的真源
 *  始终是收尾那次 socket hello 校验，不是这里。 */
export const LAUNCH_SETTLE_MS = 600

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
/** 发布线锚点（版本真源 = 根 package.json，由 scripts/set-version.mjs 统一改写，
 *  勿手改）：npx 形态下本地没有仓库时，引导 clone 的就是这个 tag，与 install.sh
 *  的 `GLASSPANE_RELEASE` 同值——两条一键入口必须拿到同一份源码。 */
export const RELEASE_VERSION = '1.3.0'
/** 发布 ref（tag 名）。GLASSPANE_REF 环境变量可覆盖（追主干用 `main`）。 */
export const REPO_REF = `v${RELEASE_VERSION}`

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
    restoreLaunchd: false,
    bootstrap: true,
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
      case '--no-bootstrap':
        // 无仓库时不自动 clone，直接给三条路径指引（离线/内网场景）。
        opts.bootstrap = false
        break
      case '--restore-launchd':
        opts.restoreLaunchd = true
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
  // 覆盖 launchd 起栈时间（kickstart 后仍需等 socket 真的可用）。
  { timeoutMs = 12000, intervalMs = 500, probe = socketReachable, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
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

/** launchd 主动接管（重启）已注册作业的参数（纯函数）。
 *  为什么需要它而不是等 launchd 自动重拉：KeepAlive 采用 SuccessfulExit=false，
 *  即"只有异常退出才重启"；daemon 修好 SIGTERM 收尾后是 clean exit 0（P1-S15），
 *  按该语义 launchd 本就不该复活它——收拢旧实例后要拿到 launchd 托管形态，
 *  必须显式 kickstart。 */
export function launchdKickstartArgs({ label, uid }) {
  return ['kickstart', '-k', `gui/${uid}/${label}`]
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

/** 从 `launchctl print` 输出里取已加载作业的 `program`（纯函数，解析友好）。 */
export function loadedLaunchdProgram(printOutput) {
  const match = /(?:^|\n)\s*program = (.*)/.exec(String(printOutput ?? ''))
  return match ? match[1].trim() : null
}

/** 是否需要重新注册（bootout + bootstrap）——比的是**已加载的作业定义**与本次要
 *  安装的程序路径，而不是 plist 文件文本。
 *  launchd 缓存的是 **bootstrap 时读到的作业定义**：原地重写 plist（例如 daemon 从
 *  裸二进制换成 bundle 内可执行）后，已加载作业仍按旧定义 spawn——真机表现为
 *  `launchctl print` 里 `last exit code = 78: EX_CONFIG`，kickstart 也永远起不来
 *  （socket 因此轮不到 launchd 接管）。只比 plist 文本不够：上一轮安装留下的陈旧
 *  定义对本轮而言文本可能完全一致。因此比 `program` 路径，且读不到定义时一律重来。 */
export function launchdNeedsReregister({ alreadyLoaded, loadedProgram = null, desiredProgram }) {
  if (!alreadyLoaded) return false
  if (!loadedProgram) return true
  return loadedProgram !== String(desiredProgram ?? '')
}

/** 注册 launchd 用户代理（幂等）：已加载则跳过，未加载则 bootstrap
 *  gui/<uid>。返回 { ok, already, message }，失败携带真实 stderr。 */
export function launchctlBootstrap(label, plistPath, { desiredProgram = null } = {}) {
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim()
  if (!uid) {
    return { ok: false, already: false, message: '无法解析当前 uid（id -u 失败），跳过 launchd 注册' }
  }
  const domain = `gui/${uid}`
  const probe = spawnSync('launchctl', ['print', domain + '/' + label], { encoding: 'utf8' })
  const needsReregister = launchdNeedsReregister({
    alreadyLoaded: probe.status === 0,
    loadedProgram: loadedLaunchdProgram(probe.stdout),
    desiredProgram,
  })
  if (probe.status === 0 && !needsReregister) {
    return { ok: true, already: true, message: `launchd 已加载 ${label}（${domain}），跳过 bootstrap` }
  }
  if (probe.status === 0) {
    // 定义变了：先卸掉旧作业，否则新 plist 不生效（真机 EX_CONFIG 的来路）。
    spawnSync('launchctl', ['bootout', domain + '/' + label])
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

/** 以 daemon 自身席位重启已加载的 launchd 作业（`kickstart -k`）。恢复流程里
 *  只在"作业已加载但自报非 granted"时调用——此时 daemon 本就不可用，中断
 *  面为零；TCC 判定按进程缓存，勾选授权后必须新进程才看得到（P1 v1.2 §11）。 */
export function launchctlKickstart(label) {
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim()
  if (!uid) {
    return { ok: false, message: '无法解析当前 uid（id -u 失败），跳过 kickstart' }
  }
  const kick = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { encoding: 'utf8' })
  const stderr = (kick.stderr ?? '').trim()
  if (kick.status === 0) {
    return { ok: true, message: `launchd 已重启作业（gui/${uid}/${label}）` }
  }
  return { ok: false, message: stderr || `launchctl kickstart 失败，退出码 ${kick.status}` }
}

/** 向 daemon socket 发一行 hello（NDJSON 单行协议，与 FrameCodec 对齐），返回
 *  解析后的 result；不可达/超时/坏响应一律 null——恢复判定必须把"拿不到"
 *  如实降级为未验证，不得冒充 granted。 */
export function socketHello(
  socketPath,
  { timeoutMs = 3000, connect = (opts, onData) => { const c = net.createConnection(opts); c.on('data', onData); return c } } = {},
) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; try { client.destroy() } catch {} ; resolve(value) } }
    let buffer = ''
    const client = connect({ path: socketPath }, (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      try {
        const frame = JSON.parse(buffer.slice(0, newline))
        finish(frame.result ?? null)
      } catch {
        finish(null)
      }
    })
    client.setTimeout(timeoutMs, () => finish(null))
    client.on('error', () => finish(null))
    client.on('connect', () => {
      client.write('{"id":1,"method":"hello"}\n')
    })
  })
}

/**
 * 审计项④（launchd 恢复靠人 → 机器化）：检测 + 恢复 + 校验一条龙，用户剩余
 * 唯一动作 = 在系统设置里勾选（TCC 无程序化路径，P1 v1.2 §10.1）。
 *
 * 状态机（对 agent 可执行、对结果不撒谎）：
 *  - plist 缺失 → 不猜，指回完整安装；
 *  - 作业未加载（booted-out，等授权期间常发生）→ bootstrap，新起的 daemon
 *    自报即真值；
 *  - 作业已加载且自报 granted → 无需任何动作，如实报告；
 *  - 已加载但自报非 granted（含 permissions 缺失）→ TCC 按进程缓存，
 *    kickstart -k 换一个新判定进程再验——勾完框重跑本命令即可闭环。
 */
export async function restoreLaunchd({
  label = LAUNCHD_LABEL,
  plistPath = path.join(process.env.HOME ?? '', ...LAUNCHD_DIR_NAME.split('/'), LAUNCHD_FILE_NAME),
  socketPath = path.join(process.env.HOME ?? '', SOCKET_DIR_NAME, SOCKET_FILE_NAME),
  bootstrapFn = launchctlBootstrap,
  kickstartFn = launchctlKickstart,
  waitFn = waitForSocket,
  helloFn = socketHello,
  existsFn = (p) => fs.existsSync(p),
  serveTimeoutMs = 10000,
} = {}) {
  if (!existsFn(plistPath)) {
    return {
      ok: false,
      action: 'missing-plist',
      message: `launchd plist 不存在（${plistPath}）：从未安装或已被删除，请重跑 install.sh 完整安装`,
    }
  }
  const boot = bootstrapFn(label, plistPath)
  if (!boot.ok) {
    return { ok: false, action: 'bootstrap-failed', message: `bootstrap 失败：${boot.message}` }
  }
  const verify = async () => {
    if (!(await waitFn(socketPath, { timeoutMs: serveTimeoutMs }))) {
      return { reachable: false, accessibility: null, pid: null, version: null }
    }
    const result = await helloFn(socketPath)
    return {
      reachable: result != null,
      accessibility: result?.permissions?.accessibility ?? null,
      pid: result?.pid ?? null,
      version: result?.version ?? null,
    }
  }
  let checked = await verify()
  if (!checked.reachable) {
    return {
      ok: false,
      action: boot.already ? 'already-loaded' : 'bootstrapped',
      verified: checked,
      message: `launchd 作业就位（${boot.message}），但 ${serveTimeoutMs}ms 内 daemon socket 未服务/未回 hello（${socketPath}）`,
    }
  }
  let restarted = false
  if (checked.accessibility !== 'granted' && boot.already) {
    // 已加载 + 非 granted：可能刚勾完框但旧进程缓存着未授权判定——换新进程再验。
    const kick = kickstartFn(label)
    if (kick.ok) {
      restarted = true
      checked = await verify()
    }
  }
  const granted = checked.accessibility === 'granted'
  const action = restarted ? 'restarted-for-grant' : boot.already ? 'already-loaded' : 'bootstrapped'
  return {
    ok: true,
    action,
    verified: checked,
    message: granted
      ? `daemon 已由 launchd 服务且自报辅助功能 granted（pid ${checked.pid}，version ${checked.version}）——无人工动作剩余`
      : `daemon 已就位，自报辅助功能为 ${checked.accessibility ?? 'unknown'}；唯一剩余人工动作 = 系统设置>隐私与安全性>辅助功能 勾选 daemon，然后重跑本命令复验（届时会自动换进程取新判定）`,
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

/** 创建日志/socket 目录（`~/.glasspane`），一次性、幂等（A-8 的后半段）。
 *
 *  为什么必须由安装器在**写 plist 之前**做，而不是等 startDetached 顺手 mkdir：
 *  `~/.glasspane` 同时是三样东西的落点——socket、launchd plist 的
 *  StandardOutPath/StandardErrorPath、手动启动的日志。默认注册 launchd
 *  （parseArgs 的 launchd 默认 true）时 bootstrap 的 RunAtLoad 会在安装器自己
 *  那次 startDetached **之前**就把 daemon 拉起来，而后面"socket 已可达即跳过手动
 *  启动"那条分支让手动分支根本不执行——于是全新机器上第一个进场的 spawner 是
 *  launchd，而它要写的目录还不存在。startDetached 里的 mkdirSync 救不了这一枪。
 *
 *  不改变任何文件位置：只建目录，路径口径与 install() 里算出来的完全一致。 */
export function ensureLogDir(logPath, { mkdir = fs.mkdirSync } = {}) {
  const dir = path.dirname(logPath)
  try {
    mkdir(dir, { recursive: true })
    return { ok: true, dir, error: null }
  } catch (error) {
    return { ok: false, dir, error: `日志/socket 目录不可用：${dir}（${error.message}）` }
  }
}

/** 后台分离启动长驻进程（daemon / GUI），日志追加写盘。
 *
 *  返回 `{ ok, pid, error, exit }` 而不是裸 PID：spawn 的失败是**异步** error 事件，
 *  此前函数只回 `child.pid`，于是"日志目录不存在 / 启动器路径不存在"这类
 *  故障会先打印一句 `PID undefined`，再抛未捕获异常——用户看到的是一次成功
 *  输出加一个崩溃栈。这里等一小段时间把 error 事件收进来。
 *
 *  窗口之后还有一件确定可观测的事：子进程是否**已经退出**。`child.on('error')`
 *  只把失败写进一个没人读的变量，而秒退的子进程（参数被拒、bundle 校验失败、
 *  日志写不进去）在窗口内收不到任何 error 事件，旧实现于是带着一个已经作废的
 *  PID 返回 ok:true。现在读 `child.exitCode`/`child.signalCode`：非零退出或被
 *  信号终止 → ok:false 并给出原因；退出码 0 仍算命令被受理（`/usr/bin/open`
 *  就是"提交给 LaunchServices 后立刻 0 退出"的形态，把它判成失败是过度修复），
 *  但窗口内观察到的退出状态会通过 `exit` 字段如实回传，调用方不得再说"进程在跑"。
 *
 *  如实边界：这是一次**有界观察**，不是存活证明——窗口外的崩溃、窗口之后才到的
 *  error 事件都看不见；daemon 到底活没活，只有收尾那次 socket hello 校验说了算。
 *
 *  日志目录（`~/.glasspane`）由 install() 在建 plist、bootstrap 之前一次性创建
 *  （见 ensureLogDir）；这里的 mkdirSync 只是给直接调用方与单测留的兜底。 */
export async function startDetached(binPath, args, logPath, { settleMs = LAUNCH_SETTLE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
  } catch (error) {
    return { ok: false, pid: null, error: `日志目录不可用：${error.message}`, exit: null }
  }
  let logStream
  try {
    logStream = fs.openSync(logPath, 'a')
  } catch (error) {
    return { ok: false, pid: null, error: `日志文件打不开：${error.message}`, exit: null }
  }
  const child = spawn(binPath, args, {
    detached: true,
    stdio: ['ignore', logStream, logStream],
  })
  let failure = null
  child.on('error', (error) => { failure = `${error.message}` })
  child.unref()
  // 给 spawn 的 error 事件一个落地窗口（ENOENT 在下一 tick 才到）。
  await sleep(settleMs)
  if (child.pid == null) {
    return { ok: false, pid: null, error: failure ?? '子进程未起来（拿不到 PID）', exit: null }
  }
  // 'exit' 事件会在窗口内把 exitCode/signalCode 填上；两者都为 null 才是"窗口
  // 结束时仍在运行"。（detached + unref 不影响 exitCode 的记账。）
  const exit = child.exitCode !== null || child.signalCode !== null
    ? { code: child.exitCode, signal: child.signalCode }
    : null
  if (failure) {
    return { ok: false, pid: null, error: `${failure}`, exit }
  }
  if (exit && (exit.code !== 0 || exit.signal !== null)) {
    const how = exit.signal ? `被信号 ${exit.signal} 终止` : `以退出码 ${exit.code} 结束`
    return {
      ok: false,
      pid: null,
      error: `子进程 ${child.pid} 在 ${settleMs}ms 观察窗口内就${how}，回传的是作废的 PID。`
        + `注意：窗口外的崩溃与 error 事件看不到，本结论是有界观察而非存活证明。`,
      exit,
    }
  }
  return { ok: true, pid: child.pid, error: null, exit }
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
    '  --restore-launchd  只做 launchd 恢复：检测作业被 bootout → bootstrap → hello',
    '                     校验 daemon 自报席位（勾完 TCC 框后重跑即自动换进程复验）',
    '  --skip-build       跳过 npm/tsc/swift 编译（已构建过时使用）',
    '  --no-bootstrap     本地找不到仓库时不自动 clone，改为打印定位指引',
    '  -h, --help         显示本帮助',
    '',
    '退出码（脚本/agent 调用方读这个，别读屏幕文案）:',
    '  0  安装完成且 daemon 实测应答 hello；或本轮按要求压根不该有 daemon',
    '     （--no-daemon 且 --no-launchd）',
    '  1  收尾未通过 hello 校验（daemon 没起来/不应答），或构建/产物/launchd 出错',
    '  2  命令行参数错误',
    '  注：install.sh 用 exec 委托本文件，退出码原样透传，所以 `curl | sh` 的',
    '      $? 就是这里的结论。',
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
  daemonVerified = true,
  daemon = { viaBundle: false, path: null },
  settingsApp = null,
}) {
  const settingsAppHint =
    settingsApp ?? path.join(rootDir, 'engine', '.build', 'release', SETTINGS_APP_NAME)
  const entryName = daemon.viaBundle ? 'GlassPane Daemon' : 'glasspaned'
  return [
    paint('后续使用说明', 'bold'),
    '',
    // daemon 没实测应答时，后面所有"已装好"的措辞都不成立——把这条摆在最前面，
    // 而不是让人照着说明接完 MCP 才发现连不上。补救命令必须是**真路径**（本函数
    // 已经拿到 rootDir），印 "<仓库目录>" 占位符等于没给可执行的东西。
    ...(daemonVerified ? [] : [
      paint('⚠ 后台服务未通过 hello 校验：下面第 1 步接好的 MCP 客户端会连不上 daemon。', 'red'),
      `   先修这一步：node "${path.join(rootDir, 'installer', 'cli.js')}" --restore-launchd`,
      '',
    ]),
    '1. MCP 客户端（Claude Desktop / Cursor / 任意 MCP host）接入配置片段：',
    '',
    mcpClientConfigSnippet({ rootDir, socketPath }),
    '',
    '2. TCC 权限（辅助功能/输入监控/屏幕录制/开发者工具）：授权对象是 **daemon 进程**',
    '   而不是设置窗口；授权勾选必须人工完成，无程序化路径（P1 v1.2 §10.1 / §11.2）。',
    daemon.viaBundle
      ? '   在系统设置的对应权限列表里应能看到「GlassPane Daemon」（带图标，可用「+」选择或从 Finder 拖入）。'
      : '   当前 daemon 是裸二进制形态，权限列表里只会显示文件名「glasspaned」（无图标，「+」选择器看不到隐藏目录）；重跑安装（默认打包 .app）可获得带图标的条目。',
    // guiOpened 的口径 = 启动命令被受理且未报错退出（bundle 形态经 `/usr/bin/open`，
    // 目标缺失/被 LaunchServices 拒绝时它返回非零 → 走下面那条手工指引）。窗口是否
    // 真出现在屏幕上没实测过，而且 `-g` 本就不抢焦点，得把这层边界写在话里。
    ...(guiOpened ? [
      '   面板已打开（口径：启动命令已发出且在观察窗口内未报错退出——bundle 形态走的',
      '   `open` 在目标 bundle 缺失时会非零退出，未报错即产物确实在；窗口外的失败看不',
      `   到，所以没看到窗口属正常（-g 不抢焦点），再起一次：open "${settingsAppHint}"）。`,
      '   点权限卡「授权」会让 daemon 以自身身份发起申请并跳转到对应系统面板。',
    ] : [
      `   打开面板：open "${settingsAppHint}"（点权限卡「授权」即由 daemon 自身发起申请）。`,
    ]),
    `   验证 daemon 自报的席位与主体：${daemon.path ?? path.join(rootDir, 'engine', '.build', 'release', DAEMON_EXE_NAME)} --permissions`,
    '   口径提醒：daemon 必须由 launchd/登录项拉起，权限自报才等于真实席位；从终端或',
    '   GUI 手动起的实例会继承启动者 app 的判定（真机实测：同 bundle 两种起法读数不同）。',
    '3. daemon 已注册 launchd 开机自启（--no-launchd 可跳过）；维护命令：',
    '   glasspaned --approval-audit / --approval-verify / --prune-evidence / --evidence-stats',
    `   作业被 bootout（等授权期间常发生）后的恢复**不需要手敲 launchctl**：`,
    `   node "${path.join(rootDir, 'installer', 'cli.js')}" --restore-launchd`,
    `   （检测→bootstrap→hello 校验自报席位；勾完 TCC 框重跑即自动换进程复验）`,
`4. entryName 核对：设置面板「Daemon 状态 → 主体」应与上面「${entryName}」一致；不一致说明连到了别的构建实例。`,
    '5. registry 发布形态：MCP 服务器已可独立安装（`npm i -g glasspane-mcp`，命令名',
    '   glasspane-mcp）；但它只是转发层，daemon 与权限仍由本次安装产出，缺 daemon 时',
    '   工具调用会返回带补救步骤的结构化错误。',
    '',
  ].join('\n')
}

/**
 * 无本地仓库时的源码引导计划（纯函数，可单测）。与 install.sh 的源码定位策略
 * 同构：clone 发布 tag 到 ~/glasspane，两条一键入口拿到同一份源码。
 * npx glasspane-install 靠它兑现"一条命令完整安装"的承诺——此前该命令在没有
 * 仓库时直接报错，README 却写着"完整安装"。
 */
export function bootstrapPlan({
  homeDir = '',
  repoUrl = REPO_URL,
  ref = REPO_REF,
  installDir = null,
} = {}) {
  if (!homeDir) {
    return { error: '无法确定用户主目录（HOME 为空），不知道把源码 clone 到哪里' }
  }
  const targetDir = installDir || path.join(homeDir, 'glasspane')
  if (fs.existsSync(targetDir) && resolveProjectRoot(targetDir) === null) {
    return {
      error: `目标目录已存在且不是 GlassPane 仓库：${targetDir}（用 --repo 指定仓库，或清理该目录后重试）`,
    }
  }
  return {
    targetDir,
    ref,
    gitArgs: ['clone', '--branch', ref, '--depth', '1', repoUrl, targetDir],
  }
}

/** 未定位到仓库时的指引文本（纯函数，可单测）。 */
export function repoMissingText() {
  return [
    '未定位到 GlassPane 项目根目录（需同时包含 engine/Package.swift 与 mcp-shell/package.json）。',
    `本应自动引导 clone 源码（ref: ${REPO_REF}），但该路径不可用。可选路径：`,
    `  a) 一键安装（自动 clone 源码后进入本流程）：curl -fsSL ${INSTALL_SH_URL} | sh`,
    `  b) 手工 clone：git clone --branch ${REPO_REF} ${REPO_URL} && cd GlassPane && node installer/cli.js`,
    '  c) 已在本仓库其他位置：--repo <目录> 或 GLASSPANE_REPO 环境变量指定根目录。',
    `  d) 追主干而非发布版：GLASSPANE_REF=main 重跑（不推荐，主干非固定产物）。`,
  ].join('\n')
}

/** 收尾判定 → 对外结论（纯函数）。
 *  退出码是本 CLI 唯一**机器可读**的结论：install.sh 是 `exec node cli.js` 委托，
 *  `curl | sh` 与按退出码办事的 agent 都只看到它，看不到屏幕上那句"安装未完成"。
 *  所以 daemon 没实测应答 hello 就必须非零，否则半成品安装会被报成成功。
 *  例外：本次安装本就不该留下 daemon（--no-daemon 且 --no-launchd）时，"没验到"
 *  是用户的选择而不是故障，退出码保持 0（告警文案照给，nextStepsText 也照警告）。 */
export function installOutcome({ verified = false, daemonExpected = true } = {}) {
  const ok = Boolean(verified) || !daemonExpected
  return { ok, exitCode: ok ? 0 : 1, verified: Boolean(verified), daemonExpected }
}

/** 未通过校验时的提示行（纯函数，可单测）。必须自带**用户真能执行**的补救命令，
 *  并点明退出码非零——只说"安装未完成"的话，脚本调用方什么也拿不到。 */
export function verificationFailureText({
  arrived = false,
  socketPath,
  daemonLog,
  cliPath,
  exitCode = 1,
} = {}) {
  return [
    arrived
      ? `安装未完成：socket 在（${socketPath}），但 daemon 没有正确应答 hello——见 ${daemonLog}`
      : `安装未完成：没有等到 daemon 在 ${socketPath} 应答 hello——见 ${daemonLog}`,
    `本命令退出码 ${exitCode}：install.sh 与调用它的脚本/agent 按安装失败处理，先别接 MCP。`,
    `补救（不需要手敲 launchctl）：node "${cliPath}" --restore-launchd`,
    '修好后重跑安装器即可（它会覆盖式重建产物与 plist）。',
  ].join('\n')
}

/** 主安装流程；所有副作用步骤均记录真实执行结果，失败即抛错终止。
 *  返回值是收尾校验结论（`installOutcome`），入口守卫据此设退出码。 */
export async function install({ options = parseArgs([]).options, env = process.env } = {}) {
  const explicitRoot = options.repoDir ? path.resolve(options.repoDir) : null
  const envRoot = env.GLASSPANE_REPO ? path.resolve(env.GLASSPANE_REPO) : null
  let rootDir = explicitRoot ?? envRoot ?? resolveProjectRoot()

  if (!rootDir || !fs.existsSync(rootDir)) {
    if (options.bootstrap === false) {
      throw new Error(repoMissingText())
    }
    const plan = bootstrapPlan({
      homeDir: env.HOME ?? process.env.HOME ?? '',
      installDir: env.GLASSPANE_INSTALL_DIR ?? null,
      ref: env.GLASSPANE_REF || REPO_REF,
    })
    if (plan.error) {
      throw new Error(`${plan.error}\n\n${repoMissingText()}`)
    }
    printStep(`未定位到本地仓库，引导 clone：${plan.targetDir}（ref: ${plan.ref}）……`)
    const clone = spawnSync('git', plan.gitArgs, { stdio: 'inherit' })
    if (clone.status !== 0) {
      throw new Error(
        `git clone 失败（ref '${plan.ref}'，退出码 ${clone.status ?? 'null'}）：`
        + '网络不可达或该发布 tag 不存在。\n\n' + repoMissingText(),
      )
    }
    if (resolveProjectRoot(plan.targetDir) === null) {
      throw new Error(`clone 完成但目录结构不完整：${plan.targetDir}\n\n${repoMissingText()}`)
    }
    rootDir = plan.targetDir
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

  // 审计 A-8 的后半段：`~/.glasspane` 在全新机器上并不存在，而它同时是 socket、
  // launchd plist 的 StandardOutPath/StandardErrorPath 与手动启动日志三者的父目录。
  // 必须**在这里**建——路径刚定、plist 还没写、还没 bootstrap。默认就注册 launchd
  // （options.launchd 默认 true），bootstrap 的 RunAtLoad 会先于安装器自己那次
  // startDetached 把 daemon 拉起来，之后"socket 已可达即跳过手动启动"，所以靠
  // startDetached 内部 mkdir 永远慢一步：首跑真正要进这个目录的 spawner 是 launchd。
  // 只建目录，不改变任何文件的落点。
  const logDir = ensureLogDir(daemonLog)
  if (!logDir.ok) {
    throw new Error(`${logDir.error}——plist 与产物均未写入，安装在此中止`)
  }
  printStep(`日志与 socket 目录就位：${logDir.dir}`)

  if (!options.skipBuild) {
    printStep('安装 npm 依赖（workspaces: kernel / mcp-shell / installer）……')
    await run('npm', ['install'], { cwd: rootDir })

    printStep('编译 kernel……')
    await run('npm', ['run', 'build', '--workspace', '@iterate/kernel'], { cwd: rootDir })

    printStep('编译 mcp-shell……')
    await run('npm', ['run', 'build', '--workspace', 'glasspane-mcp'], { cwd: rootDir })

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
  // 前置条件：daemonLog 的父目录（= socket 目录）已在上面 ensureLogDir 建好——
  // 下面这份 plist 的 StandardOutPath/StandardErrorPath 就写在那个目录里，而
  // RunAtLoad 让 launchd 成为第一个往那里写的 spawner（全新机器上目录原本不存在）。
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
    const bootstrapResult = launchctlBootstrap(LAUNCHD_LABEL, plistPath, {
      desiredProgram: daemonLaunch.path,
    })
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
        // 收拢旧实例后主动让 launchd 接管：TERM 现在是 clean exit 0，KeepAlive
        // (SuccessfulExit=false) 语义下 launchd 不会自动复活，必须 kickstart。
        // 不这么做就会退化成"手动实例持有 socket"，开机自启那份配置形同虚设。
        if (staleDaemons.length > 0 && options.launchd) {
          const uid = String(spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim())
          if (uid) {
            spawnSync('launchctl', launchdKickstartArgs({ label: LAUNCHD_LABEL, uid }))
            relaunchedByLaunchd = await waitForSocket(socketPath)
            printStep(relaunchedByLaunchd
              ? 'launchd 已按新配置接管 daemon（kickstart）'
              : 'launchd 未在时限内接管，改由安装器直接启动')
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
      const started = await startDetached(start.launchPath, start.args, daemonLog)
      if (!started.ok) {
        printStep(paint(`glasspaned 启动命令失败：${started.error}`, 'red'))
      } else if (started.exit) {
        // 窗口内启动命令就已退出 0：经 open 时是"已提交给 LaunchServices"的正常
        // 形态，裸二进制形态则意味着 daemon 自己秒退。两种情况都不能说"进程在跑"
        // ——那只有下面收尾的 socket hello 校验才配说。
        printStep(paint(
          `glasspaned 启动命令已执行完毕并退出（码 ${started.exit.code}，PID ${started.pid}）；`
          + '这不代表 daemon 在跑，存活与否以下面的 hello 校验为准',
          'yellow',
        ))
      } else {
        printStep(`glasspaned 启动命令已发出且观察窗口内未退出，PID ${started.pid}`)
      }
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
    const gui = await startDetached(guiStart.launchPath, guiStart.args, daemonLog)
    // "面板已打开"只能是实测结论。startDetached 现在会把 `open` 的非零退出（目标
    // bundle 缺失、被 LaunchServices 拒绝）与窗口内被信号终止都判成 ok:false，
    // 所以 gui.ok 的口径是"启动命令被受理且未报错退出"，不是"窗口已在屏幕上"
    // （bundle 形态带 -g，本就不抢焦点）——文案里把这层边界写明，见 nextStepsText。
    guiOpened = gui.ok
    if (!gui.ok) {
      printStep(paint(`设置面板没能打开：${gui.error}`, 'yellow'))
    }
  }

  // 收尾校验：socket 到位 + 一次 hello 真握手。安装器此前无条件打印"安装完成。"，
  // 而且**无论校没校验过都退出 0**——install.sh 是 exec 委托，`curl | sh` 和按退出
  // 码办事的 agent 只看到 0，于是半成品安装被报成成功。现在结论同时进文案与退出码。
  // 本轮是否**应该**留下一个在跑的 daemon：--no-daemon 但注册了 launchd 时，
  // bootstrap 的 RunAtLoad 已经把它拉起来了，同样要等要验（旧代码只看 options.daemon，
  // 于是这种组合下 timeoutMs=1ms，必然"没验到"）。
  const daemonExpected = Boolean(options.daemon || options.launchd)
  const arrived = await waitForSocket(socketPath, { timeoutMs: daemonExpected ? 12000 : 1 })
  const hello = arrived ? await socketHello(socketPath) : null
  const verified = Boolean(arrived && hello?.version)
  const outcome = installOutcome({ verified, daemonExpected })
  if (verified) {
    printStep(`实测校验通过：daemon 在 ${socketPath} 应答 hello（version=${hello.version}${hello.pid ? `，pid=${hello.pid}` : ''}）`)
    printStep(`安装完成（退出码 ${outcome.exitCode}）。`)
  } else if (daemonExpected) {
    for (const line of verificationFailureText({
      arrived,
      socketPath,
      daemonLog,
      cliPath: path.join(rootDir, 'installer', 'cli.js'),
      exitCode: outcome.exitCode,
    }).split('\n')) {
      printStep(paint(line, 'red'))
    }
  } else {
    printStep(paint(
      `本次按要求没有起 daemon（--no-daemon 且 --no-launchd），未做 hello 校验，退出码 ${outcome.exitCode}；`
      + '接 MCP 前先自行启动 daemon，否则客户端连不上。',
      'yellow',
    ))
  }
  process.stdout.write(`\n${nextStepsText({
    rootDir,
    socketPath,
    guiOpened,
    daemonVerified: verified,
    daemon: daemonLaunch,
    settingsApp: plan.settingsApp ?? undefined,
  })}\n`)
  return outcome
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

  if (options.restoreLaunchd) {
    // 审计项④：恢复 + 校验全机器化，退出码即判定（0=daemon 就位且已按实际
    // 自报如实报告；1=作业/服务面失败），agent 可直接执行并按 message 续办。
    const result = await restoreLaunchd()
    process.stdout.write(`${result.message}\n`)
    process.exit(result.ok ? 0 : 1)
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
    .then((outcome) => {
      process.stdout.write('\n')
      // 退出码 = 收尾校验结论。用 process.exitCode 而不是 process.exit()：让上面的
      // 说明文本先冲干净（`curl | sh` 常接管道，截断会把"下一步怎么办"整段吃掉）。
      process.exitCode = outcome.exitCode
    })
    .catch((installError) => {
      process.stderr.write(paint(`\n安装失败：${installError.message}\n`, 'red'))
      process.exit(1)
    })
}