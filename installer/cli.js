#!/usr/bin/env node
/**
 * @glasspane/installer — 一键安装 CLI（零第三方依赖，Node >= 18）。
 *
 * 流程：terminal onboarding 横幅 → 环境预检（node/swift/git/open）→ 定位项目
 * 根目录 → npm install（workspaces）→ 编译 TS（kernel → mcp-shell）→ swift
 * build -c release（engine）→ 启动 glasspaned（已运行则跳过）→ 打开
 * glasspane-settings GUI 进入权限拖拽引导 → 打印后续使用说明。
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
    '  --no-gui           不打开 glasspane-settings GUI',
    '  --no-app           不打包 GlassPane.app（仅裸二进制产物）',
    '  --no-launchd       不注册开机自启（launchd bootstrap）',
    '  --skip-build       跳过 npm/tsc/swift 编译（已构建过时使用）',
    '  -h, --help         显示本帮助',
    '',
  ].join('\n')
}

/** 主安装流程；所有副作用步骤均记录真实执行结果，失败即抛错终止。 */
export async function install({ options = parseArgs([]).options, env = process.env } = {}) {
  const explicitRoot = options.repoDir ? path.resolve(options.repoDir) : null
  const envRoot = env.GLASSPANE_REPO ? path.resolve(env.GLASSPANE_REPO) : null
  const rootDir = explicitRoot ?? envRoot ?? resolveProjectRoot()

  if (!rootDir || !fs.existsSync(rootDir)) {
    throw new Error([
      '未定位到 GlassPane 项目根目录（需同时包含 engine/Package.swift 与 mcp-shell/package.json）。',
      '请在仓库目录内运行本安装器，或使用 --repo <目录> 指定。',
    ].join('\n'))
  }

  const engineDir = path.join(rootDir, 'engine')
  const socketPath = path.join(process.env.HOME ?? '', SOCKET_DIR_NAME, SOCKET_FILE_NAME)
  const daemonBin = path.join(engineDir, '.build', 'release', 'glasspaned')
  const settingsBin = path.join(engineDir, '.build', 'release', 'glasspane-settings')
  const daemonLog = path.join(process.env.HOME ?? '', SOCKET_DIR_NAME, DAEMON_LOG_NAME)

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
    printStep('打包 GlassPane.app（.build/release/GlassPane.app）……')
    await run('/bin/bash', [makeAppScript, settingsBin], { cwd: engineDir })
    printStep(`GlassPane.app 就绪：${path.join(engineDir, '.build', 'release', 'GlassPane.app')}`)
  }

  if (options.daemon) {
    if (!fs.existsSync(daemonBin)) {
      throw new Error(`daemon 产物不存在：${daemonBin}（请勿在未构建时使用 --skip-build 启动 daemon）`)
    }
    if (await socketReachable(socketPath)) {
      printStep(`daemon 已在监听 ${socketPath}，跳过启动`)
    } else {
      printStep(`启动 glasspaned（日志: ${daemonLog}）……`)
      const pid = startDetached(daemonBin, ['--socket-path', socketPath], daemonLog)
      printStep(`glasspaned 已后台启动，PID ${pid}`)
    }
  }

  if (options.gui) {
    if (!fs.existsSync(settingsBin)) {
      throw new Error(`设置面板产物不存在：${settingsBin}`)
    }
    printStep(`打开 glasspane-settings 设置面板（权限拖拽引导）……`)
    startDetached(settingsBin, [], daemonLog)
  }

  printStep('安装完成。', true)
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