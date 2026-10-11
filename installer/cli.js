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
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import net from 'node:net'

// 显式常量，避免散落魔法字符串。
export const MIN_NODE_MAJOR = 18
export const SOCKET_DIR_NAME = '.glasspane'
export const SOCKET_FILE_NAME = 'engine.sock'
export const DAEMON_LOG_NAME = 'installer-daemon.log'
/** daemon 作业名。**真源是 updater 的 `DAEMON_JOB_LABEL`**（规格 §2/§3 都在那边用它）；
 *  这里保留一份同值常量是因为安装器必须能脱离 updater/ 独立 import（npx 形态、旧
 *  checkout），而 `test/auto-update.test.mjs` 把两者钉成相等——改任何一边都会红。 */
export const LAUNCHD_LABEL = 'com.glasspane.daemon'
export const LAUNCHD_DIR_NAME = 'Library/LaunchAgents'
export const LAUNCHD_FILE_NAME = `${LAUNCHD_LABEL}.plist`

/** 安装树里 updater 各模块的相对位置（规格 §7：指针与定时代理都必须指向**安装产物里**
 *  的那一份 CLI，而不是 installer 自己旁边的副本）。 */
export const UPDATER_CLI_SEGMENTS = ['updater', 'cli.js']
export const UPDATER_STATE_SEGMENTS = ['updater', 'lib', 'state.js']
export const UPDATER_LAUNCHD_SEGMENTS = ['updater', 'lib', 'launchd.js']
export const UPDATER_CODES_SEGMENTS = ['updater', 'lib', 'codes.js']

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
export const RELEASE_VERSION = '1.10.0'
/** 发布 ref（tag 名）。GLASSPANE_REF 环境变量可覆盖（追主干用 `main`）。 */
export const REPO_REF = `v${RELEASE_VERSION}`

/** 发布签名公钥的 key id（下面那块公钥注释里的同一串）。拒绝文案要点名它，
 *  人要拿它去 `gpg --list-keys` / GitHub 上比对指纹（审计轮 3 finding 2）。 */
export const GLASSPANE_SIGNING_KEY_ID = '0929EA31DF4F7429F63FC53189D88B1D043A1298'

/** 发布公钥的 uid（同一块公钥注释里的另一串）：拒绝文案里 key id 与 uid 要成对出现，
 *  读者才知道自己该比对的是哪一把钥匙。 */
export const GLASSPANE_SIGNING_KEY_UID = 'jingzhao-l (sign-github) <ET_lin@outlook.com>'

/** 发布签名公钥（GPG，key 0929EA31DF4F7429F63FC53189D88B1D043A1298，uid
 *  jingzhao-l (sign-github) <ET_lin@outlook.com>）。与 npm 安装链的 Integrity 不同，
 *  GPG 校验的是"来源/作者身份"而不是"内容哈希"：clone 到的发布 tag 若带 GPG 签名，
 *  用这把公钥验签通过，才能确证源码出自发布者之手（而非同名 tag 或中间人）。
 *  恒为 best-effort 的是**缺签名**那一档：未签名/不可用只告警不阻断，因为 HTTPS clone
 *  + tag 钉版本已保证内容完整性，GPG 是额外的一层来源证明。而"tag 带签名却验不过"
 *  （`invalid`）不是缺证明，是正面篡改证据——那一档是硬拒，判据与文案都在 `tagVerifyDecision`。 */
export const GLASSPANE_SIGNING_PUBLIC_KEY = [
  '-----BEGIN PGP PUBLIC KEY BLOCK-----',
  '',
  'mQINBGq45VQBEACdjAoLYyfgPpHjvscmGqxlSsBkcBvSAoGHdCI0p2Rn5cBDaPie',
  'oPU17VmUiK4FBZf8FcaX0L+EeMRO4Bcj5NgoFaSgQPK0YarvoPssClNiWf71hDlg',
  'QmC5IlwM4WuVUeKi3+YoPmRSf0sYHzSYM7vEIoCFzEilYi4iEK/NMihNSktlUsQx',
  'jhIaXtnVJi+7GkO+dhckKmIHhcR76dUfIAsS/R0RzzH4ZXfuKi+B94mfCntURpM4',
  'G+NrxZx7Xv5UDpv9XsrmiWKzNpT+Th9GbNQREjrT1mmKbMEOmD/PWTqxNycJfgdW',
  'hWA++1oassOib3jd44+z5f7FKpp//C+SK8V7vuxNI0jRM/VYrbyrfON30hHwtbFM',
  '0J/quDsAUzlOBNzNVPAyvGsOuSEULFtjaJ2q+JYjF+ZKDPy+lyY8V9sbYrqCCUb9',
  'v3wPn4tDvat30Q0A0rheMZPTMO7tRNSzFOd25H0w3ZF3F5Np8D/aX9VHMkA12xTm',
  'l7gpb1OIEJ1vdQl0twiF6SDz5jsteHfdUXha6CtM7tv7IZ4MIZi/qPkvv4zOKmsE',
  'utLUs1alD671Eez2sQow8NO5IXfd7bX2d34kU5JiM1tF9qhBxOZlpzd/Vm8FZS4V',
  'URF6Y7myW4ildqBeMzLt0to8WjHnHoV4v9rh5581qWEqvNIJ4/R3lKRhxwARAQAB',
  'tC1qaW5nemhhby1sIChzaWduLWdpdGh1YikgPEVUX2xpbkBvdXRsb29rLmNvbT6J',
  'Am0EEwEIAFcWIQQJKeox3090KfY/xTGJ2IsdBDoSmAUCarjlVBsUgAAAAAAEAA5t',
  'YW51MiwyLjUrMS4xMiwwLDMCGwMFCwkIBwICIgIGFQoJCAsCBBYCAwECHgcCF4AA',
  'CgkQidiLHQQ6EpharQ//VhcNiug3cHsgvb/tTqWp1CQV8heSfqoKrW51RPhcGAHW',
  'VMHpbPRO0wBKKE5mybyGAWhGDhh5mZt1MxnBN3lC7RsWBLEaXyJAqW4UPjR5LN8Q',
  'scapkCzFwrF5lisELdqKqkd/ACKR8h6U/fBf0eKE+TMDSrXZ/LkRcFRJErfsC7rx',
  'hy1WQnzQBT2+86HmfW9rrw5RSyCp8MZ0TJhYr0ZdgB4zvLwvVYQCnlRaskkLjGrh',
  '6vUHAjDCUwoDFEpecadCJg34cOEAMRjnTt6Q0t8SnVHDH9PLq1MwGON2VzuSp5rY',
  'rthT3+VRzbzGpBu4wl4/GJiWJMfGTusEu8Ver6MTwHx9pFBDtH3cawIB5BT1RrXk',
  'cYdhtjzJ61RXIrSCeD8yoxEgDOj73Ll6oQ4+fJ+EpOc+SvP9FREeQ4k/uc8MpwtV',
  'YyD/6EPJu1lLMAzgd2Xm2ljokTRhm/Blft9Y0OEEWzsoDGv+jr3Jb3Dgw62OuL6B',
  'pLiZ5XNCYBHYhQhtleGnSpJtD9ooi1UUTbVZftunzYGKafMCgc9nnzPIGVtlzX+d',
  'K10CtPOX7ylS+lKukaIOSStGGSl3I2Fd66yb3ujIH6n/KAKLfMmmy48pxB3+t6WW',
  'StdD7QEASWIyW2wTrq7RyDwmzWMSFtgPzCOWFmcQfFykkvvQEqxMeyCrcPY6ZIy5',
  'Ag0EarjlVAEQAOjPGVDb8zGIc7XQelHhjyd8yLCVpNBWwYLmaSLfI+EQsfVVDJqT',
  'VAAeO82woHELPun06lbJRW59eH8BkVgzGhNkb5vKhrdvmZydYElC1NuRB9ag6/k/',
  '0IaLwedKZscy1k3oG2LqsayzUO3L2d8BxO8zdLEmIl7FqtTdsYwj6DDRgZdA4Aj0',
  'VoUXOgWaR+7qA9GHnnucrE5n0zhrTd7F3mtZErWr6Edo/V9EHQ1PszsQTVH2artr',
  'lYJWjSsAv/ajEvAjaZ1mJoDvz/UzUk7hCCPeNcpy41SpDb3uey38qqxLYOGVgEeD',
  '7JTrhC51VNHj2CCxSgyrlvED+resJtgWnE65Sa8g9cGAVpXlOBRQrPZGMHS+BcAg',
  '9lQExMGrWt76ZPgT5Gygzj09oGx1q6/IyATphit4TblFGl2z1JDnlUQqfz/aCmZN',
  'Vg+fKBPQ93dLLGPKpmY022X3abJ197VaQ0WWB2cA8pcrcfJ8GY7Lm8xjm6nY/cER',
  'RQl72dE1NJsPGrp3Ad/s7fAJuEdR8UmMUPLDQRpiNRTcK6RC2AaRD7wpdyG/1csF',
  'P30IIY97aVSjD5nnkrHxNQKZ17yPef+bFIoJ7OS+WhLZKcr7P0DfgJoTbKc6GK6M',
  'ScQm5N7lRJ9Mfzu4R6576hDrgb3fmgflmpKOIVrZ6GkTGDvQ/FE16QdrABEBAAGJ',
  'AlIEGAEIADwWIQQJKeox3090KfY/xTGJ2IsdBDoSmAUCarjlVBsUgAAAAAAEAA5t',
  'YW51MiwyLjUrMS4xMiwwLDMCGwwACgkQidiLHQQ6Epi4aw//Qu00vxGtvRb+VQl9',
  'lMZLwIP2AgB0lAgKAqYeK6jZh/15GAKJqRh0u2jdgqXj2Sfm79X7Qwn7wAuFUAmx',
  'D1eegOtdAnEP6O8DUtZWWmy2TSRIqjfTcGXlZ12WHiOwwdG5VOUZERWi/rPj0zTs',
  '5V1H4qyPOqgrFx9nNvavzo3zeJVpwYuuFkT2Ne0cZLXGglCQ6MJtuK0Qwk6iYsvy',
  'p3eZ1YCKmAi1v0UFojtFHqJEAsc3PnZb+48veE9b2whrL9DIIkNrrFlfFC1cjm7T',
  'wuRQuH6aYyrRoZiLxgwkW5xmc1Biitw7bMIX6eqYVn8hb1lQUKhTL8aZ2xQa6IsJ',
  'RHIJFYeEIEUtIl/GKQ3MeHQlJrXsfnZ1e8MHgwgMw3o4Nq4xww3Ch0pddYhBskmV',
  '/QUaOHVqmuur9dnRvx9L+FGbzHEjvYDr0MkSe30hUhyBIg1uOLd2elATB/wg33Ow',
  'vcdqgewqpYdSg6g6KZYl6NhmWWNEMgX8KITUXFoTiV5CrSsrptBPJWsyIq+CuseL',
  'CKFdMHrkzbjFLGfdiPqykwttwHBAEk01aWArDP65gXRXmxGzDHVkA7Px1hdo/kMo',
  'Ouw6bEGpHtx7UJJMSMA9ywbTrOyaG4xzVDa7ixUslFtgxts1R/eLoC4I11grxE50',
  'YVXa4IEQs7aBxKO+n+T2AvUYiKQ=',
  '=DYXk',
  '-----END PGP PUBLIC KEY BLOCK-----',
].join('\n')

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
    autoUpdate: true,
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
      case '--no-auto-update':
        // 规格 §5：默认开，一键关。关掉 = 不注册每日代理 + 状态里记 disabled=true
        // （由 updater 自己的 writer 写，面板才会显示"自动更新已关闭"而不是"从未检查"）。
        opts.autoUpdate = false
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

/** 需要"探测命令本身跑成功"的工具（审计轮 3 finding 6）。
 *
 *  macOS 把 `/usr/bin/swift` 与 `/usr/bin/git` 装成 **Command Line Tools 的 shim**：文件
 *  确实在、也确实可执行（`accessSync(..., X_OK)` 通过），但 CLT 不在的时候它们**一跑就失败**
 *  （xcode-select 报 "no developer tools were found"）。所以"文件在"对这两个工具不构成
 *  存在性证明——旧实现据此把预检报成"依赖齐全"，然后死在真正的 `swift build` 上。
 *  对这些工具只认探测命令自己的退出码，不做 `/usr/bin/<bin>` 文件退化检查。 */
export const SHIM_PROBE_COMMANDS = {
  swift: { cmd: 'xcode-select', args: ['-p'] },
  git: { cmd: 'git', args: ['--version'] },
}

/** 检查命令是否存在：优先 `<bin> --version`；shim 易感工具（swift/git）改由
 *  SHIM_PROBE_COMMANDS 里那条探测命令的退出码决定；其余（open 等不支持 --version）
 *  才退化到 /usr/bin 下的可执行文件。真实探测，不伪造。 */
export function commandAvailable(bin, {
  spawn = spawnSync,
  access = (file) => fs.accessSync(file, fs.constants.X_OK),
} = {}) {
  const succeeds = (cmd, args) => {
    try {
      return spawn(cmd, args, { stdio: 'ignore', timeout: 5000 }).status === 0
    } catch {
      return false
    }
  }
  if (succeeds(bin, ['--version'])) {
    return true
  }
  const probe = SHIM_PROBE_COMMANDS[bin]
  if (probe) {
    // 到这一支为止：文件存在对 shim 易感工具不构成证据（见 SHIM_PROBE_COMMANDS 注释）。
    return succeeds(probe.cmd, probe.args)
  }
  try {
    access(path.join('/usr/bin', bin))
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

/** 判一次 `kill` 的失败到底是"进程不在了"还是"我没权动它"（finding 5）。
 *  `/bin/kill` 对两者都给退出码 1，能分开的只有 stderr 文案：
 *  `Operation not permitted` = EPERM（进程活着、属于别人，典型就是 root 拉起的老 daemon）。
 *  认不出来的失败按"不在"处理（与旧实现 `status === 0` 才算活着同向），因为真正的兜底闸
 *  是收尾那次 hello 版本核对——旧进程只要还在服务 socket，那里就会把它露出来。 */
export function classifyKillResult({ status, stderr = '', error = null } = {}) {
  if (error) return 'unknown'
  if (status === 0) return 'alive'
  // 连退出码都没有（kill 自己没跑成、或被信号打死）= **没观测到这个进程**，不许当成"不在了"。
  if (status === null || status === undefined) return 'unknown'
  const text = String(stderr ?? '')
  if (/not permitted|permission denied|eperm/i.test(text)) return 'denied'
  // /bin/kill 对"进程不存在"必定打印 No such process；认不出的失败按"不在"处理（与旧实现
  // 同向），真正的兜底闸是收尾那次版本核对——旧进程只要还在服务 socket，那里就会把它露出来。
  return 'gone'
}

/** 这个 pid 是不是**僵尸**（已死、等父进程回收）：`kill -0` 对僵尸回 0，光靠信号探测会把
 *  一个已经不服务 socket 的进程报成"还活着、请你 sudo kill"。状态读不出来时保守回 false
 *  （宁可多报一个幸存者，也不放走真的还在跑的进程）。 */
export function isZombiePid(pid, { spawn = spawnSync } = {}) {
  try {
    const res = spawn('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' })
    return String(res?.stdout ?? '').trim().startsWith('Z')
  } catch {
    return false
  }
}

/** 向指定 PID 发 SIGTERM（daemon 侧装有信号处理 → 清理 socket 后退出；
 *  launchd 托管时异常退出会按新 plist 重新拉起）。1s 后仍存活的补 SIGKILL：
 *  实测存在收不到/不响应 SIGTERM 的旧 daemon 实例（主循环未跑起来时
 *  SIG_IGN 生效而 handler 永不执行），它们占着 socket 却是死身份，必须清掉。
 *
 *  结论口径（finding 5）：**只有 SIGKILL 之后再探一次仍不在，才算结束**。
 *  旧实现把 kill 的退出码全丢掉、直接 `terminated: [...pids]`，于是安装器无权发信号的
 *  进程（root 所有的陈旧 daemon，`kill` 与 `kill -0` 都回 EPERM）被报成"已结束既有实例"，
 *  而它还在服务同一个 socket。这类 pid 现在进 `survivors`，调用方必须按失败说。 */
export function terminatePids(pids, { spawn = spawnSync, sleepMs = 1000, reprobeMs = 150, sleep = null } = {}) {
  const run = (args) => {
    try {
      return spawn('kill', args, { encoding: 'utf8' })
    } catch (error) {
      return { status: null, stderr: error?.message ?? String(error), error }
    }
  }
  const signal = (pid, sig) => run(sig ? ['-' + sig, String(pid)] : [String(pid)])
  const state = (pid) => classifyKillResult(signal(pid, '0'))
  const terminated = []
  const forced = []
  const survivors = []
  for (const pid of pids) signal(pid)
  // 给 SIGTERM 一个收尾窗口（daemon 侧 handler 会清 socket 再退出）。可注入 sleep，
  // 免得单测每跑一次真等一秒；默认仍是旧的 /bin/sleep 有界等待。
  if (sleep) sleep(sleepMs)
  else spawn('sleep', [String(Math.ceil(sleepMs / 1000))], { encoding: 'utf8' })
  for (const pid of pids) {
    const before = state(pid)
    if (before === 'denied') {
      survivors.push({ pid, reason: 'SIGTERM 被拒（EPERM）：该进程不属于当前用户，安装器无权结束它' })
      continue
    }
    if (before === 'gone') {
      terminated.push(pid)
      continue
    }
    forced.push(pid)
    signal(pid, '9')
    let after = state(pid)
    if (after !== 'gone') {
      // 刚被 SIGKILL 的进程要等它的父进程回收（父进程正 `wait` 着的话是毫秒级）；
      // 立刻探一次会把它读成"还活着"，于是红字让人去 sudo kill 一个已经没了的 pid。
      // 给一次**有界**的再探窗口，只有窗口过后还在的才算幸存者。
      if (sleep) sleep(reprobeMs)
      else spawn('sleep', [String(reprobeMs / 1000)], { encoding: 'utf8' })
      after = state(pid)
      // 还"活着"但状态是 Z = 它已经死了，只差父进程 wait() 收尸：这种东西不持有 socket、
      // 不需要人去 sudo kill，报成幸存者就是把人支到一条没用的命令上。
      if (after === 'alive' && isZombiePid(pid, { spawn })) after = 'gone'
    }
    if (after === 'gone') {
      terminated.push(pid)
    } else if (after === 'denied') {
      survivors.push({ pid, reason: 'SIGKILL 被拒（EPERM）：该进程不属于当前用户，安装器无法结束它' })
    } else {
      survivors.push({ pid, reason: `SIGKILL 后再探一次（+${reprobeMs}ms）它仍存在（${after}）` })
    }
  }
  return { terminated, forced, survivors }
}

/** 幸存者（安装器发不动信号的进程）的红字（finding 5，纯函数）。
 *  这里给的必须是**人能直接执行**的动作，而不是"请检查权限"：安装器没有 root 权限，
 *  所以只有坐在键盘前的这个人能 `sudo kill -9`；他知道 pid、知道为什么必须他做、
 *  也知道做完要重跑什么。socket 还挂在这些 pid 上，所以本轮的产物从未接管——
 *  收尾那次版本核对（daemonVersionVerdict）会把这件事再钉一次。 */
export function survivorText(survivors, { socketPath } = {}) {
  const pids = survivors.map((entry) => entry.pid).join(' ')
  return [
    `未能结束既有实例（它仍在服务 ${socketPath ?? 'engine.sock'}）：`
    + survivors.map((entry) => `pid ${entry.pid} — ${entry.reason}`).join('；'),
    `安装器无权向这些进程发信号（它们不属于当前账号，典型是 root 拉起的旧 daemon）。`
    + `上面"已结束"那句只对确实已经不在的 pid 成立，不含这些。`,
    `由人来收尾：先看清是谁起的 \`ps -o pid=,user=,lstart=,command= -p ${pids}\`，`
    + `再 \`sudo kill -9 ${pids}\`，然后重跑本安装器并加 --replace-daemon。`,
  ].join('\n')
}

/** 把 make-app.sh 的两个 bundle 安置到 ~/Applications（覆盖式，幂等）。
 *  返回 `{ installed, declined }`（finding 11）：
 *  - `installed` = 本轮真的写进去的条目；
 *  - `declined` = 目标**已存在**而 `allowReplace=false`（人回答 n，或非交互环境没给
 *    `--no-prompt`）因此没有覆盖的条目——留着的是上一轮的旧 bundle，daemon 启动路径
 *    会照旧选中它。这不是"无所谓"的分支：收尾那次版本核对（见 daemonVersionVerdict）
 *    正是靠它拦住"装了新版、跑的还是旧版"。
 *  源缺失即跳过（--no-app 或构建产物不全时不报错）。 */
export function installBundles({
  plan,
  exists = fs.existsSync,
  remove = fs.rmSync,
  copy = fs.cpSync,
  mkdir = fs.mkdirSync,
  allowReplace = true,
} = {}) {
  const installed = []
  const declined = []
  if (!plan?.appsDir) return { installed, declined }
  mkdir(plan.appsDir, { recursive: true })
  const pairs = [
    [plan.builtSettingsApp, plan.settingsApp],
    [plan.builtDaemonApp, plan.daemonApp],
  ]
  for (const [source, target] of pairs) {
    if (!source || !target || !exists(source)) continue
    if (exists(target) && !allowReplace) {
      declined.push(target)
      continue
    }
    remove(target, { recursive: true, force: true })
    copy(source, target, { recursive: true })
    installed.push(target)
  }
  return { installed, declined }
}

/** 本轮会覆盖掉哪些**已存在**的 bundle（install() 拿这份清单去问人，findings 11）。
 *  纯函数：只查文件系统，不做任何写入。 */
export function bundlesToReplace({ plan, exists = fs.existsSync } = {}) {
  if (!plan?.appsDir) return []
  return [
    [plan.builtSettingsApp, plan.settingsApp],
    [plan.builtDaemonApp, plan.daemonApp],
  ]
    .filter(([source, target]) => source && target && exists(source) && exists(target))
    .map(([, target]) => target)
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

/** 把 plist 文本里的转义还原回真实路径（与 launchdPlistString 的 escapeXml 反向）。
 *  顺序要紧：先解 &lt;/&gt;，最后才解 &amp;，否则 `&amp;lt;` 会被多解一层。 */
function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 从 plist 文本取本次要装的程序路径：`Program` 单值，或 `ProgramArguments` 的首项。
 *  `launchctl print` 报的 `program =` 就是这一个值，所以两边必须同源于渲染出来的 plist——
 *  restore 路径手上只有 plist 文件，拿不到"我想装什么"。 */
export function launchdProgramFromPlistText(xml) {
  const text = String(xml ?? '')
  const single = /<key>Program<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text)
  if (single) return unescapeXml(single[1]).trim()
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)
  if (!args) return null
  const first = /<string>([\s\S]*?)<\/string>/.exec(args[1])
  return first ? unescapeXml(first[1]).trim() : null
}

/** plist 读不回东西时回 null：`launchdNeedsReregister` 把"读不到定义"一律判成要重来，这是
 *  保守方向（宁可重注册，也不要在旧定义上假装成功），所以这里不许编一个路径出来。 */
function readPlistProgram(readFile, plistPath) {
  try {
    return launchdProgramFromPlistText(readFile(plistPath))
  } catch {
    return null
  }
}

/** 只读探测：launchd 此刻 holding 的是哪个定义、本轮的 plist 是否需要重新注册
 *  （= bootstrap 之前先问一句"这一步会不会打断一个健康作业"，finding 11）。
 *  读不到 uid 时按"不需要"回——那是 launchctlBootstrap 自己会如实报的分支。 */
export function launchdReregisterProbe(desiredProgram, { label = LAUNCHD_LABEL, spawn = spawnSync } = {}) {
  const uid = String(spawn('id', ['-u'], { encoding: 'utf8' })?.stdout ?? '').trim()
  if (!uid) return { loaded: false, program: null, uid: null, needsReregister: false }
  const probe = spawn('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8' })
  const loaded = probe.status === 0
  const program = loadedLaunchdProgram(probe.stdout)
  return {
    loaded,
    program,
    uid,
    needsReregister: launchdNeedsReregister({
      alreadyLoaded: loaded,
      loadedProgram: program,
      desiredProgram,
    }),
  }
}

/** 注册 launchd 用户代理（幂等）：已加载则跳过，未加载则 bootstrap
 *  gui/<uid>。返回 { ok, already, message }，失败携带真实 stderr。
 *
 *  `allowBootout=false`（finding 11：bootout 会打断一个正在跑的健康作业）时**什么都不做**
 *  并回 `bootoutDeclined`——绝不"先卸了再问"，也绝不在旧定义还挂着的时候假装注册上了。
 *  默认 true：`--restore-launchd` 那条机器化补救路径不受确认门影响（它本身就是安装器
 *  交给 agent 的命令，把它改成需要人工回答等于给 remedy 加一条走不通的路）。
 *
 *  `desiredProgram` 缺失时**自己从 plist 读**：调用方之一是 `--restore-launchd`，它手里只有
 *  plist 路径，而它偏偏是安装器交给 agent 的"daemon 不可达"补救命令。以前不传就等于跟 ''
 *  比，任何已加载作业都被判成"定义变了"→ bootout 一个健康作业（打断正在跑的 act）。 */
export function launchctlBootstrap(label, plistPath, {
  desiredProgram = null,
  spawn = spawnSync,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  allowBootout = true,
} = {}) {
  const uid = spawn('id', ['-u'], { encoding: 'utf8' }).stdout.trim()
  if (!uid) {
    return { ok: false, already: false, message: '无法解析当前 uid（id -u 失败），跳过 launchd 注册' }
  }
  const domain = `gui/${uid}`
  const probe = spawn('launchctl', ['print', domain + '/' + label], { encoding: 'utf8' })
  const wantProgram = desiredProgram ?? readPlistProgram(readFile, plistPath)
  const needsReregister = launchdNeedsReregister({
    alreadyLoaded: probe.status === 0,
    loadedProgram: loadedLaunchdProgram(probe.stdout),
    desiredProgram: wantProgram,
  })
  if (probe.status === 0 && !needsReregister) {
    return { ok: true, already: true, message: `launchd 已加载 ${label}（${domain}），跳过 bootstrap` }
  }
  if (probe.status === 0) {
    if (!allowBootout) {
      return {
        ok: false,
        already: false,
        bootoutDeclined: true,
        message: `没有卸载已加载的 ${label}（本轮未获得确认，${domain}）：launchd 里现在跑的是 ${loadedLaunchdProgram(probe.stdout) ?? '（未读到）'}，本轮要装的定义是 ${wantProgram ?? '（读不到）'}，两者不一致而 bootout 是破坏性动作——因此**没有**写新 plist 也**没有**继续 bootstrap，什么都没改。要让新定义生效：在交互终端重跑本命令并回答继续，或在脚本/自动化里显式加 --no-prompt。`,
      }
    }
    // 定义变了：先卸掉旧作业，否则新 plist 不生效（真机 EX_CONFIG 的来路）。
    // bootout 的退出码必须判：它失败时紧随的 bootstrap 只会回 5 / "already loaded"，
    // 而那一支被下面映射成 ok:true —— 于是安装器打印"开机自启已注册"，launchd 却还在
    // 按旧定义 spawn（正是 L519-525 那段注释说这次设计要消灭的 EX_CONFIG 陷阱）。
    const out = spawn('launchctl', ['bootout', domain + '/' + label], { encoding: 'utf8' })
    const outStatus = out?.status ?? null
    const outError = String(out?.stderr ?? '').trim()
    if (outStatus !== 0) {
      return {
        ok: false,
        already: false,
        bootoutFailed: true,
        message: `launchctl bootout ${domain}/${label} 未成功（退出码 ${outStatus}${outError ? `：${outError}` : ''}），旧作业仍挂在 launchd 上，因此没有继续 bootstrap——此刻在跑的仍是旧定义 ${loadedLaunchdProgram(probe.stdout) ?? '（未读到）'}，而新 plist 写的是 ${wantProgram ?? '（读不到）'}。请按顺序手工执行：launchctl bootout ${domain}/${label}（仍失败就换 launchctl remove ${label}），确认 launchctl print ${domain}/${label} 报 Could not find service，然后重跑 install.sh（或 node installer/cli.js --restore-launchd）。`,
      }
    }
  }
  const boot = spawn('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' })
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
  env = process.env,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  plistPath = null,
  socketPath = null,
  bootstrapFn = launchctlBootstrap,
  kickstartFn = launchctlKickstart,
  waitFn = waitForSocket,
  helloFn = socketHello,
  existsFn = (p) => fs.existsSync(p),
  serveTimeoutMs = 10000,
} = {}) {
  // finding 4：这条路径也是拿 HOME 拼出来的（旧代码在参数默认值里读 process.env.HOME ?? ''，
  // HOME 缺失时它变成 `Library/LaunchAgents/…` 这种相对位置，然后照实去 bootstrap 一个
  // StandardOutPath 是相对路径的作业）。显式传了 plistPath/socketPath 的调用方（单测、
  // 以及任何知道自己要修哪个文件的人）不受这条闸影响。
  const paths = installGuard({ home: env.HOME ?? '', uid })
  const resolvedPlist = plistPath ?? (paths.ok ? path.join(paths.home, ...LAUNCHD_DIR_NAME.split('/'), LAUNCHD_FILE_NAME) : null)
  const resolvedSocket = socketPath ?? (paths.ok ? path.join(paths.home, SOCKET_DIR_NAME, SOCKET_FILE_NAME) : null)
  if (!resolvedPlist || !resolvedSocket) {
    return { ok: false, action: 'bad-home', verified: null, message: paths.error ?? '无法确定 plist/socket 路径（HOME 不可用且未显式传入）' }
  }
  if (!existsFn(resolvedPlist)) {
    return {
      ok: false,
      action: 'missing-plist',
      message: `launchd plist 不存在（${resolvedPlist}）：从未安装或已被删除，请重跑 install.sh 完整安装`,
    }
  }
  const boot = bootstrapFn(label, resolvedPlist)
  if (!boot.ok) {
    // 两种"没注册上"要分开说：bootout 失败意味着旧作业还在跑旧定义（agent 下一步是把它卸掉），
    // bootstrap 失败才是"卸干净了但装不上"。合成一句会把人支到错的那条命令上去。
    return {
      ok: false,
      action: boot.bootoutFailed ? 'bootout-failed' : 'bootstrap-failed',
      message: boot.bootoutFailed ? boot.message : `bootstrap 失败：${boot.message}`,
    }
  }
  const verify = async () => {
    if (!(await waitFn(resolvedSocket, { timeoutMs: serveTimeoutMs }))) {
      return { reachable: false, accessibility: null, pid: null, version: null }
    }
    const result = await helloFn(resolvedSocket)
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
      message: `launchd 作业就位（${boot.message}），但 ${serveTimeoutMs}ms 内 daemon socket 未服务/未回 hello（${resolvedSocket}）`,
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

/** 判定 `git verify-tag` 结果的语义（纯函数，可单测）。
 *  git 对"未签名 tag"与"签名无效"都返回退出码 1，必须靠 stderr 里的
 *  "no signature found" 区分——前者是"本来就没签"（未签名），后者才是"签名对不上"
 *  （invalid）。退出码 0 = 用已导入的发布公钥验签通过。 */
export function classifyTagVerify({ status, stdout = '', stderr = '' } = {}) {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`
  // `raw` 是 git/gpg 的原话，硬拒那条要引用它（finding 2）：结论之外还得给读者可复核的
  // 一手证据，只留一句"签名无法确证"等于让人去猜是 BAD signature 还是公钥没找到。
  const raw = text.trim()
  if (status === 0) {
    return { status: 'verified', detail: '发布 tag 的 GPG 签名有效，出自发布者私钥', raw }
  }
  if (/no signature found/i.test(text)) {
    return { status: 'unsigned', detail: '该发布 tag 未做 GPG 签名（不是内容被篡改，只是缺签名层）', raw }
  }
  return { status: 'invalid', detail: `git verify-tag 失败（退出码 ${status}），签名无法确证`, raw }
}

/**
 * 验签结论怎么落成安装动作。三种结局各说各话：
 *  - `verified`   绿字继续；
 *  - `unsigned` / `unavailable`  黄字继续——缺的是来源证明的**增量**：被验的 tag 与
 *    装进构建的源码是同一个 ref，HTTPS + tag 钉版本已经保证内容完整；
 *  - `invalid`    签名在、验不过，那说的不是"缺证明"而是"这份字节不是发布者签过的
 *    那一份"，必须**停下**。自动更新那一面对它是硬拒且 `--consent` 洗不掉
 *    （updater/lib/check.js 的门 8）；安装这一面从前只黄字一句"继续安装"就往下跑
 *    npm install、swift build 并注册 launchd——同一件事在两条路上按两种诚实度处理，
 *    而安装是更不可逆的那条。
 * 判据放在纯函数里：这一段从前埋在 main() 的 if 里，没有一条测试能指到它。
 */
export function tagVerifyDecision({ sig, pinRef, repoDir }) {
  if (sig.status === 'verified') {
    return { action: 'pass', text: `发布 tag ${pinRef} GPG 签名验证通过` }
  }
  if (sig.status === 'invalid') {
    return {
      action: 'refuse',
      text: `发布 tag ${pinRef} 带着 GPG 签名，但签名验不过：${sig.detail}\n`
        + (String(sig.raw ?? '').trim()
          ? `git verify-tag 原话：${String(sig.raw).trim()}\n`
          : '（git verify-tag 没有留下原话；上面那句是判据本身）\n')
        + '这不是"没签名"。签名在而校验失败，说明眼前这份 tag 指向的字节不是发布者签过的那一份。'
        + '安装到此为止：没有跑 npm install，没有 swift build，没有注册 launchd 作业。\n'
        + `内置公钥：key ${GLASSPANE_SIGNING_KEY_ID}（uid ${GLASSPANE_SIGNING_KEY_UID}），`
        + '就是本文件里那份 GLASSPANE_SIGNING_PUBLIC_KEY——要比对的是这一把，不是随便哪把签过名的。\n'
        + `下一步：核对远端与这个 tag（git -C "${repoDir}" remote -v；git -C "${repoDir}" tag -v ${pinRef}）；`
        + '确认仓库与发布者公钥都无误后改用更新的发布 tag（GLASSPANE_REF=v<版本> 重跑）。'
        + '要装开发主线用 GLASSPANE_REF=main（那条路不做 tag 验签，会如实告警）。\n'
        + '该看的地方：SECURITY.md 的 "What the checks prove, and what they do not"——'
        + '这一档写明是"任何同意都不覆盖的硬拒"，所以这里既没有 flag 也没有确认能放行。',
    }
  }
  if (sig.status === 'unsigned' || sig.status === 'unavailable') {
    return {
      action: 'warn',
      text: `发布 tag ${pinRef} 没有可核验的 GPG 签名（${sig.status}：${sig.detail}）`
        + '——继续安装：缺的是来源证明的增量，不是篡改迹象',
    }
  }
  // 没见过的新判据一律停下：把"不认识"当成"没签名"放过，等于每加一种失败模式
  // 就自动退回成"继续安装"。
  return {
    action: 'refuse',
    text: `发布 tag ${pinRef} 的验签回了一个安装器不认识的判据（${sig.status}：${sig.detail}）。`
      + '安装到此为止：不认识的判据不许当成"没签名"放过。\n'
      + `下一步：手动核对（git -C "${repoDir}" tag -v ${pinRef}），确认无误后重新安装。`,
  }
}

/** 仓库里是否存在指定 tag ref（IO 探测，纯判定）。 */
export function repoHasRef(repoDir, ref, { spawn = spawnSync } = {}) {
  return spawn('git', ['-C', repoDir, 'rev-parse', '--verify', `refs/tags/${ref}`], { stdio: 'ignore' }).status === 0
}

/** 对 clone 下来的发布 tag 做 GPG 验签（best-effort，不抛错）。
 *  隔离 GNUPGHOME 并临时导入发布公钥，`git verify-tag` 只看退出码与 stderr；不动
 *  用户钥匙环、无网络依赖。返回 classifyTagVerify 的口径（verified/unsigned/invalid/
 *  unavailable）。不能确证来源时不阻断——被验的 tag 与安装用的源码是同一个 ref，
 *  HTTPS + tag 钉版本已保证内容完整。 */
export function verifyCloneTagGpg({
  repoDir,
  ref,
  tmpDir = null,
  spawn = spawnSync,
  mkdtemp = fs.mkdtempSync,
  remove = fs.rmSync,
} = {}) {
  const gpgVersion = spawn('gpg', ['--version'], { encoding: 'utf8' })
  if (gpgVersion.error || gpgVersion.status !== 0) {
    return { status: 'unavailable', detail: 'gpg 不可用，跳过发布 tag GPG 验签' }
  }
  if (!repoHasRef(repoDir, ref, { spawn })) {
    return { status: 'unavailable', detail: `仓库中不存在 tag ${ref}，跳过验签` }
  }
  let gnupgHome = tmpDir
  let created = false
  try {
    if (!gnupgHome) {
      gnupgHome = mkdtemp(path.join(os.tmpdir(), 'glasspane-gnupg-'))
      created = true
    }
    fs.mkdirSync(gnupgHome, { recursive: true })
    const keyPath = path.join(gnupgHome, 'publish-key.asc')
    fs.writeFileSync(keyPath, GLASSPANE_SIGNING_PUBLIC_KEY, 'utf8')
    const imp = spawn('gpg', ['--homedir', gnupgHome, '--batch', '--import', keyPath], { encoding: 'utf8' })
    if (imp.status !== 0) {
      return { status: 'unavailable', detail: '导入发布公钥失败，跳过验签' }
    }
    const res = spawn('git', ['-C', repoDir, 'verify-tag', ref], {
      encoding: 'utf8',
      env: { ...process.env, GNUPGHOME: gnupgHome },
    })
    return classifyTagVerify({ status: res.status, stdout: res.stdout, stderr: res.stderr })
  } catch (error) {
    return { status: 'unavailable', detail: `发布 tag GPG 验签不可用：${error.message}` }
  } finally {
    if (created) {
      try { remove(gnupgHome, { recursive: true, force: true }) } catch { /* 临时目录清理失败不致命 */ }
    }
  }
}

// ---------------------------------------------------------------------------
// 自动更新接线（规格 2026-09-27 §5「默认开、一键关」+ §7「指针文档」）
//
// 这里**不**渲染 plist、**不**拼 LaunchAgents 路径、**不**自己实现 0600 writer、
// **不**再判一次"用环境变量关掉自动更新"那个开关：四样都从安装树里的 updater 模块取
// （`renderAgentPlist` / `registerAgent` / `agentPlistPath` / `AGENT_LABEL` /
// `writePointer` / `resolveStateRoot` / `runCommand`）。注册与卸载走
// `runCommand('enable'|'disable')`——与面板按钮、与定时代理跑的是同一条实现
// （§7「一处实现，一处真相」），也因此那个环境开关只由 updater 自己读一次：它答
// "环境已经关了"（返回 auto-disabled 这个 code，安装器读的是它的**结论**而不是变量本身），
// 安装器就再请它执行自己的 disable，好让状态里落下与 --no-auto-update 同样的
// disabled=true，而不是在 installer 里做第二套解读。
// 选择"import 模块并调 runCommand"而不是"spawn node <root>/updater/cli.js enable"：
// 后者无法在不碰真实 ~/Library/LaunchAgents 的前提下被单测驱动（updater 自己的
// cli.test.mjs 只能跑 status/usage 这类无副作用子命令）。注入 deps 里的
// `runLaunchctl`/`uid`/`homeDir` 就能把整条注册链留在临时 HOME 内，这正是本仓
// 测试一直在用的口径。
// ---------------------------------------------------------------------------

/** 安装树里 updater 各入口的绝对路径（指针 §7 要写的就是这一份的位置）。 */
export function updaterTreePaths(rootDir) {
  return {
    cli: path.join(rootDir, ...UPDATER_CLI_SEGMENTS),
    state: path.join(rootDir, ...UPDATER_STATE_SEGMENTS),
    launchd: path.join(rootDir, ...UPDATER_LAUNCHD_SEGMENTS),
    codes: path.join(rootDir, ...UPDATER_CODES_SEGMENTS),
  }
}

/**
 * 安装树里没有更新脚本（旧 checkout / 未打包 updater/）时的文案（纯函数，可单测）。
 * 三件事必须说齐：缺的是**哪个文件的绝对路径**、因此没写成什么、用户因此失去什么。
 * 刻意不写代理标签——那个名字只存在于 updater 的常量里，此处读不到，宁可说"每日
 * 定时更新代理"也不在 installer 里抄一份（抄了就是改名时会漂移的第二真源）。
 */
export function autoUpdateMissingText({ updaterCli, rootDir, detail = null } = {}) {
  return [
    `自动更新未接线：安装树里找不到更新脚本 ${updaterCli}`,
    `（${rootDir} 这份源码缺 updater/ 目录——旧 checkout，或安装产物里没打包该目录。）`,
    '本轮因此**没有**写安装指针，也**没有**注册每日定时更新代理。你失去：每日定时的自动检查与',
    '换版、设置面板的「立即检查 / 安装更新」两个按钮（面板读不到安装指针会显示"读不到更新状态"，',
    '不会假装成功）、以及 gp_diagnose 响应里的 update 摘要。',
    'daemon 与开机自启不受影响，安装结论仍由收尾的 hello 校验决定；要拿回自动更新：',
    '把源码更新到含 updater/ 的版本后重跑安装器（它会补写指针并注册代理）。',
    ...(detail ? [`（读取 ${updaterCli} 时的原始错误：${detail}）`] : []),
  ].join('\n')
}

/**
 * 取安装树里的 updater 模块。文件不存在、或它自己的依赖不在（ERR_MODULE_NOT_FOUND/
 * ENOENT）→ `{ missing, detail }`，由调用方**如实打印**后跳过；其它加载错误一律抛——
 * 把"坏了"说成"没有"是本仓禁止的那类静默。
 */
async function importUpdaterModule(file, { exists }) {
  if (!exists(file)) return { missing: file, detail: '文件不存在' }
  try {
    return { module: await import(pathToFileURL(file).href) }
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ENOENT') {
      return { missing: file, detail: error.message }
    }
    throw new Error(`安装树里的更新脚本无法加载：${file}（${error?.message ?? String(error)}）`)
  }
}

/**
 * 写 §7 的指针文档并注册/卸载每日代理。
 *
 * 三个注入位是给单测留的（`homeDir`/`uid`/`runLaunchctl`）：整条注册链——plist 落盘、
 * `launchctl bootout/bootstrap`——都留在临时 HOME 里，开发机的 `~/Library/LaunchAgents`
 * 一个字节都不动，口径与 test/cli.test.mjs 的 restoreLaunchd 假件、
 * updater/test/launchd.test.mjs 的 `run` 注入一致。真实安装只传 `rootDir/env/autoUpdate`。
 *
 * 幂等：指针是整份覆盖写（`writePointer` 临时文件 + rename + 读回校验 mode），代理
 * 那边 `registerAgent` 先 `bootout` 再 `bootstrap`——重跑安装既不会留下两个作业，也
 * 不会留下指向已挪走 checkout 的旧 plist（launchd 缓存 bootstrap 时读到的定义，
 * 这正是本仓 EX_CONFIG 栽过两轮的坑）。
 *
 * 返回的是给使用说明与调用方读的结论；`state: 'missing'` 是**已如实打印告警**的跳过
 * （安装继续、退出码不受影响），其余失败一律抛给 install() 走非零退出——静默跳过是
 * 本仓禁止的失败形态。
 */
export async function registerAutoUpdate({
  rootDir,
  env = process.env,
  homeDir = null,
  uid = null,
  runLaunchctl = null,
  autoUpdate = true,
  now = new Date(),
  exists = fs.existsSync,
  say = (line) => printStep(line),
  // §9：注册那一趟现在会导出系统根证书束并起子进程探测一次 release 端点。
  // 单测必须能替换掉这两件事——否则 `npm test` 变成一次联网测试，慢且不稳。
  updaterDeps = {},
} = {}) {
  const tree = updaterTreePaths(rootDir)
  const modules = {}
  for (const [key, file] of [['cli', tree.cli], ['state', tree.state], ['launchd', tree.launchd], ['codes', tree.codes]]) {
    const got = await importUpdaterModule(file, { exists })
    if (got.missing) {
      for (const line of autoUpdateMissingText({ updaterCli: file, rootDir, detail: got.detail }).split('\n')) {
        say(paint(line, 'yellow'))
      }
      return {
        ok: true,
        registered: false,
        state: 'missing',
        reason: 'updater-missing',
        agentLabel: null,
        schedule: null,
        stateRoot: null,
        updaterCli: file,
        pointer: null,
        pointerPath: null,
        detail: got.detail,
      }
    }
    modules[key] = got.module
  }
  const { cli, state, launchd, codes } = modules

  // 状态根只由 updater 的 resolveStateRoot 决定（flag → GLASSPANE_STATE_DIR → 家目录
  // /.glasspane）；homeDir 为空时不传，让它按自己的口径取口令记录里的那个家。
  const homeArgs = homeDir ? { homeDir } : {}
  const stateRoot = cli.resolveStateRoot({ flags: {}, env, ...homeArgs })
  const agentLabel = launchd.AGENT_LABEL

  // §7 指针四字段，写盘用 updater 自己的 writer（0600 + 临时文件 + rename + 读回校验）。
  const written = state.writePointer(
    stateRoot,
    { updaterCli: tree.cli, installRoot: rootDir, agentLabel },
    { now },
  )
  const readBack = state.readPointer(stateRoot)
  if (!readBack.ok) {
    throw new Error(`自动更新指针写完读不回来（${readBack.code}）：${readBack.message}`)
  }

  const flags = { json: false, auto: false, help: false, consents: [], overrides: {}, 'state-dir': stateRoot }
  const deps = { cliPath: tree.cli, ...homeArgs, ...updaterDeps }
  if (uid !== null && uid !== undefined) deps.uid = String(uid)
  if (runLaunchctl) deps.runLaunchctl = runLaunchctl

  let outcome = await cli.runCommand({ command: autoUpdate ? 'enable' : 'disable', flags, env, deps })
  let switchedOffByEnv = false
  if (autoUpdate && outcome.code === codes.CODES.autoDisabled) {
    // updater 自己读了那个环境变量并拒绝注册。安装器不重复解读它，只把它的原话留着，
    // 再请它跑自己的 disable——这样面板读到的是 disabled=true（"自动更新已关闭"），
    // 而不是"从未检查"。
    const updaterSentence = outcome.message
    const second = await cli.runCommand({ command: 'disable', flags, env, deps })
    if (!second.ok) {
      throw new Error(`自动更新状态卸载写入失败：${second.message ?? '未知原因'}（updater 关于环境变量的一手原话：${updaterSentence}）`)
    }
    outcome = { ...second, message: `${updaterSentence}｜${second.message}` }
    switchedOffByEnv = true
  }
  if (!outcome.ok) {
    throw new Error(`${autoUpdate ? '自动更新代理注册' : '自动更新代理卸载'}失败：${outcome.message ?? '未知原因'}`)
  }

  const registered = autoUpdate && !switchedOffByEnv
  const schedule = `${launchd.DEFAULT_HOUR}:${String(launchd.DEFAULT_MINUTE).padStart(2, '0')}`
  const summary = {
    ok: true,
    registered,
    state: registered ? 'registered' : 'off',
    reason: switchedOffByEnv ? 'env' : (autoUpdate ? null : 'flag'),
    agentLabel,
    schedule,
    stateRoot,
    updaterCli: tree.cli,
    pointer: written.pointer,
    pointerPath: written.path,
    message: outcome.message,
    // updater 有没有把在册作业读回来核对过。`false` 不是失败（作业确实装载了），但也确实没人证明
    // launchd 手里的是这一份；安装日志要说的是这两者之中的那一个，而不是"已注册"三个字。
    agentVerified: outcome.agentVerified ?? null,
    // `undefined`（这份 updater 根本不回报）与 `null`（回报了但没有束）对读者是同一句话：
    // 没有证据。合成一个形状，下游就不必为两种"没有"各写一条分支——而两种分支里，
    // 漏掉一种就是崩溃。
    caRoots: outcome.state && outcome.state.caRoots ? outcome.state.caRoots : null,
  }
  if (registered) {
    say(`每日自动更新已注册（${agentLabel}，默认 ${schedule}，状态根 ${stateRoot}；指针 ${written.path}）——一键关：node "${tree.cli}" disable`)
    // "已注册"这三个字的证据是 updater 把在册作业读回来核对过。launchd 装载成功但读不回在册作业时，
    // 这句话只能算一半成立，而那另一半（原话）必须跟着说出来——否则这台机器看起来有每日作业，实际
    // 有没有人跑没人知道。措辞仍来自唯一作者 outcome.message，这里只转述。
    //
    // 只此一处：`summary.agentVerified` 就是 `outcome.agentVerified` 的副本，两处判断同一个值就会
    // 打两行近乎相同的告警，而"两行"在这种机器上读起来像两件不同的事出了问题。
    if (summary.agentVerified === false) {
      say(paint(`注意（每日作业还没被核对过）：${outcome.message}`, 'yellow'))
      say('   这一步只说明 launchd 接受了装载；这条命令之后有没有真的成为在册作业，上面的原话里说了为什么读不出来。')
    }
    // §9.8：node 不读 macOS 信任库，装了 HTTPS 中间人的机器上这件事只有 updater 自己能发现。
    // 安装日志必须把它说出来——否则每天失败的是一个看起来在正常工作的代理。措辞与 remedy
    // 都来自 outcome.message（唯一作者），这里只转述，不重写。
    const ca = summary.caRoots
    if (ca && ca.status === 'ok') {
      say(`node 的系统根证书束：已导出 ${ca.certs} 张 → ${ca.path}，并已写进该作业的 NODE_EXTRA_CA_CERTS`)
    } else if (ca) {
      say(paint(`注意（自动更新的网络这一跳）：${outcome.message}`, 'yellow'))
    } else {
      say(paint(`注意：这份 updater 没有回报根证书束的导出结果（旧版本）；若本机 HTTPS 被中间人替换，每日检查会在第一道校验上失败，跑 node "${tree.cli}" enable 可重新导出。`, 'yellow'))
    }
  } else {
    say(
      `自动更新已关闭（${switchedOffByEnv ? 'updater 报环境变量已关，见下面它自己的原话' : '--no-auto-update'}）：`
      + `${agentLabel} 未注册/已卸载，状态里记 disabled=true——面板显示"自动更新已关闭（上次检查 …）"而不是"从未检查"。`
      + `手动 node "${tree.cli}" check / apply 仍可用；重开：node "${tree.cli}" enable。`
      + `（updater 原话：${outcome.message}）`,
    )
  }
  return summary
}

/**
 * §5 在「后续使用说明」里的落点：把代理名、时刻、状态根与**真路径**的开关命令写清楚。
 * `update` 缺省（老调用方）时一行不出，以免给没接线的环境编出一段说明。
 * 末行是卸载口径——移除 daemon 作业的那些手工命令必须同时移除这个更新代理，
 * 否则装完再删的用户会留下一个每天照跑、却没有界面入口的定时作业。
 */
export function updateGuidanceText(update) {
  if (!update) return []
  if (update.state === 'missing') {
    return [
      `6. 自动更新：本轮未接线（安装树缺 ${update.updaterCli}，详见上面那条告警）。`,
      '   这一份装出来的 GlassPane 不会自己更新，面板上的两个更新按钮也读不到状态；',
      '   把源码更新到含 updater/ 的版本后重跑安装器即可补上（指针 + 每日代理）。',
    ]
  }
  if (update.state === 'registered') {
    const ca = update.caRoots
    const caLine = !ca
      ? `   ⚠ 这份 updater 没有回报 node 要用的系统根证书束（旧版本）；本机 HTTPS 若被中间人替换，每日检查会在第一道校验上失败。补上：node "${update.updaterCli}" enable。`
      : ca.status === 'ok'
        ? `   node 用本机导出的系统根证书束 ${ca.certs} 张（${ca.path}，已写进作业的 NODE_EXTRA_CA_CERTS）。`
        : `   ⚠ 本机没能导出 node 要用的系统根证书束（${ca.status}）；HTTPS 被中间人替换的机器上，每日检查会在第一道校验上失败，`
          + '面板与 gp_diagnose 会一直显示这句话，修复办法是它给的那条。'
    return [
      `6. 自动更新：默认开。launchd 每日 ${update.schedule} 跑 "${update.updaterCli}" check && apply`,
      `   （作业 ${update.agentLabel}，RunAtLoad=false，日志 ${update.stateRoot}/update.log）；`,
      '   只在 daemon 空闲应答探针、且规格 §1 八道校验全过时才换版，major 永远等人点按钮。',
      ...(caLine ? [caLine] : []),
      `   一键关：node "${update.updaterCli}" disable（卸该作业 + 状态记 disabled=true）；重开：enable。`,
      `   卸载本机安装时：bootout daemon 作业的同时**也必须** bootout ${update.agentLabel} 并删它的 plist。`,
    ]
  }
  return [
    `6. 自动更新：已关闭（${update.reason === 'env' ? 'updater 判定环境变量为关，安装器没有第二套解读' : '--no-auto-update'}）。`,
    `   ${update.agentLabel} 未注册，状态记 disabled=true：面板显示"自动更新已关闭（上次检查 …）"，`,
    '   不会静默消失；手动检查/安装仍是同一条 CLI（面板上那两个按钮也是它）。',
    `   重开：node "${update.updaterCli}" enable${update.reason === 'env' ? '（先把那个环境变量去掉，否则 updater 按 §7 拒绝注册）' : ''}。`,
    `   它也负责卸载：bootout ${update.agentLabel} + 删 ~/Library/LaunchAgents 下那份 plist。`,
  ]
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

/** 破坏性步骤的人工确认（finding 11）。三档，缺一不可：
 *  1) `--no-prompt`（→ autoYes）：**显式**放弃确认，直接放行。脚本/CI/`curl | sh` 走
 *     这一档（install.sh 在 stdin 非 TTY 时就是来补这个 flag 的）。
 *  2) 交互终端：真的问一句 `(Enter 继续 / n 跳过)`。
 *  3) 非交互**且没有** `--no-prompt`：回 false —— 既不阻塞（管道里 question() 永远
 *     等不到答案），也不"默认同意"（那等于把 `--no-prompt` 的语义白送给没传它的人）。
 *     调用方必须跳过这一步并打印"要显式加 --no-prompt"。
 *
 *  旧实现是 `autoYes || !isTTY → true`，而且**生产路径一次都没调用过它**：于是
 *  README 与 `--help` 承诺的"跳过每步确认"对应的活代码不存在，install.sh 的
 *  `[ -t 0 ]` 也跟着失去意义。现在被它拦住的是两件破坏性动作：卸载 launchd 上
 *  **已加载**的 daemon 作业（会打断正在跑的 act），以及覆盖 ~/Applications 里
 *  **已存在**的 .app。 */
export async function confirm(question, {
  autoYes = false,
  interactive = Boolean(process.stdin.isTTY),
  ask = null,
} = {}) {
  if (autoYes) {
    return true
  }
  if (!interactive) {
    return false
  }
  if (ask) {
    return Boolean(await ask(question))
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${question} (Enter 继续 / n 跳过) `)
    return !/^n/i.test(answer.trim())
  } finally {
    rl.close()
  }
}


/** 状态根/日志目录与其里那份日志的模式（与 updater 的 fsutil 同一组数：0700 / 0600）。
 *  installer 是零依赖单文件，所以这里自己写死，不去 import updater/lib/fsutil.js。 */
export const STATE_DIR_MODE = 0o700
export const STATE_FILE_MODE = 0o600

/** 把人话版的八进制模式写全前导零：0o755 打出来是 `0755` 而不是 `755`，拒绝里出现的数
 *  要能被直接拿去和 ls -l 的答案对。 */
export function formatMode(mode) {
  return `0${(Number(mode ?? 0) & 0o777).toString(8).padStart(3, '0')}`
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
export function ensureLogDir(logPath, { mkdir = fs.mkdirSync, chmod = fs.chmodSync, statMode = (p) => fs.statSync(p).mode & 0o777 } = {}) {
  const dir = path.dirname(logPath)
  try {
    // mode 只作用在**新建**的那一层、还要被 umask 削一刀；目录已经存在时（上一轮安装留下的
    // 0755）mkdirSync 一个字都不改。这个目录里放着 socket、审批记录、证据和 installer-daemon.log，
    // 所以 0700 是要求而不是建议：补一次 chmod，再把模式读回来。
    mkdir(dir, { recursive: true, mode: STATE_DIR_MODE })
    chmod(dir, STATE_DIR_MODE)
    const mode = statMode(dir)
    if (mode !== STATE_DIR_MODE) {
      // 没落住的 chmod 按**写失败**报告，而不是"我们至少试过了"——与 updater/fsutil.tightenMode
      // 同一个判据（卷不保存权限位时，owner-only 这件事在这里就做不到）。
      return {
        ok: false,
        dir,
        mode,
        error: `日志/socket 目录 ${dir} 在 chmod(0700) 之后仍是 ${formatMode(mode)}：这台机器的卷不保存权限位，owner-only 的 socket 目录做不到，安装在这里中止（不是继续写进去）`,
      }
    }
    return { ok: true, dir, mode, error: null }
  } catch (error) {
    return { ok: false, dir, error: `日志/socket 目录不可用：${dir}（${error.message}）` }
  }
}

/** 以 owner-only(0600) 打开或创建 daemon 日志，并把模式**读回来**。
 *
 *  为什么不能只 `openSync(logPath, 'a')`：那条口令既没有 mode（新建文件因此拿到 0644 & ~umask），
 *  也不改**已存在**文件的模式（上一轮安装留下的 0644 就这么留着）。这份日志里是审批与证据线索，
 *  而 daemon 的启动清扫只收紧 registry/approvals/evidence（engine StateRoot.swift 的那一段），
 *  从不碰它——SECURITY.md 记的正是这条"量到而未修"。chmod 没落住按写失败报告。 */
export function openPrivateLog(logPath, {
  open = (file) => fs.openSync(file, 'a', STATE_FILE_MODE),
  chmod = fs.fchmodSync,
  fstat = fs.fstatSync,
  close = fs.closeSync,
} = {}) {
  let fd
  try {
    fd = open(logPath)
  } catch (error) {
    return { ok: false, fd: null, mode: null, error: `日志文件打不开：${error.message}` }
  }
  try {
    chmod(fd, STATE_FILE_MODE)
    const mode = Number(fstat(fd).mode ?? 0) & 0o777
    if (mode !== STATE_FILE_MODE) {
      try { close(fd) } catch { /* 已经决定失败了 */ }
      return {
        ok: false,
        fd: null,
        mode,
        error: `日志文件 ${logPath} 在 chmod(0600) 之后仍是 ${formatMode(mode)}：这台机器的卷不保存权限位，owner-only 的日志做不到（同一次写按失败算，不当成功报告）`,
      }
    }
    return { ok: true, fd, mode, error: null }
  } catch (error) {
    try { close(fd) } catch { /* 已经决定失败了 */ }
    return { ok: false, fd: null, mode: null, error: `日志文件打不开：${error.message}` }
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
export async function startDetached(binPath, args, logPath, { settleMs = LAUNCH_SETTLE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), openLog = openPrivateLog } = {}) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: STATE_DIR_MODE })
    fs.chmodSync(path.dirname(logPath), STATE_DIR_MODE)
  } catch (error) {
    return { ok: false, pid: null, error: `日志目录不可用：${error.message}`, exit: null }
  }
  const opened = openLog(logPath)
  if (!opened.ok) {
    return { ok: false, pid: null, error: opened.error, exit: null }
  }
  const logStream = opened.fd
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
    '  --no-prompt        跳过破坏性步骤的确认（脚本/自动化场景）。被它拦住的是三件：',
    '                     ① bootout 已加载的 launchd daemon 作业（会打断正在跑的 act）；',
    '                     ② 覆盖 ~/Applications 里已存在的 .app；③ --replace-daemon 结束',
    '                     已在跑的实例。交互终端会逐条问；非交互（stdin 不是终端）**且没给**本 flag 时',
    '                     这三步一律不执行（不阻塞等待、也不默认同意）并打印红字说明——',
    '                     所以 CI / e2e / `curl | sh` 这类调用必须显式带 --no-prompt',
    '                     （install.sh 在 stdin 非 TTY 时已经自动补上）。',
    '  --no-daemon        不启动 glasspaned',
    '  --replace-daemon   先结束已在跑的 glasspaned 实例（旧构建的 daemon 会继续占',
    '                     socket，让系统设置里的授权条目与实际服务实例对不上）',
    '  --no-gui           不打开 glasspane-settings GUI',
    '  --no-app           不打包/安置 .app（仅裸二进制产物；权限条目将只显示文件',
    '                     名且无图标，见 P1 v1.2 §11.1）',
    '  --no-launchd       不注册开机自启（launchd bootstrap）',
    '  --no-auto-update   不注册每日自动更新代理（规格 2026-09-27 §5）：卸载该代理并在',
    '                     状态里记 disabled=true，面板显示"自动更新已关闭"而不是"从未',
    '                     检查"；手动 check/apply 仍可用。等价的环境开关由 updater 自己',
    '                     判定（本安装器不重复解读那个环境变量）',
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
  panel = null,
  update = null,
}) {
  // finding 8：面板那一句"再打开一次"必须落在**真存在**的东西上。旧写法在这里另拼一个
  // `~/Applications/GlassPane.app`（--no-app 时根本没安置）或
  // `<rootDir>/engine/.build/release/GlassPane.app`（make-app.sh 的产物在 .build 里，
  // 从没构建过时它不存在），于是 `open "…"` 是一条没人能跑通的命令，而
  // bundle-apps.test.mjs 只断言字面量 `open "` 出现过——测试跟着文案一起撒了谎。
  const panelHint = panelOpenHint({ panel, rootDir, settingsApp })
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
      `   到，所以没看到窗口属正常（-g 不抢焦点），再起一次：${panelHint.text}${panelHint.runnable ? '' : '（本轮没有可重开的产物，见下一条）'}）。`,
      '   点权限卡「授权」会让 daemon 以自身身份发起申请并跳转到对应系统面板。',
    ] : panelHint.runnable ? [
      `   打开面板：${panelHint.text}（点权限卡「授权」即由 daemon 自身发起申请）。`,
    ] : [
      `   ${panelHint.text}`,
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
    ...updateGuidanceText(update),
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
  // finding 3：GLASSPANE_REPO_URL / GLASSPANE_REF 是文档里的覆盖位，值直接进 git argv。
  // 不校验就等于把"clone 时执行任意命令"交给一个环境变量（`ext::sh -c …` /
  // 以 `-` 开头的 ref 被 git 当选项，如 --upload-pack=…）。
  const clone = safeGitCloneArgs({ repoUrl, ref, targetDir })
  if (clone.error) {
    return { error: `${clone.error}` }
  }
  return {
    targetDir,
    ref: clone.ref,
    repoUrl: clone.url,
    gitArgs: clone.args,
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

/** GLASSPANE_REF 的唯一口径（finding 10，与 install.sh 同源）：**未设置**与**显式置空**
 *  都钉发布 tag；要追主干必须显式写 `main`。旧行为是 install.sh 把空值读成 `main`、
 *  本文件把同一个空值读成 tag——同一条 `GLASSPANE_REF=` 在两条一键入口上会拿到两份源码，
 *  而 install-sh.test.mjs 那条用例的标题还写着"与 installer 常量同源"。 */
export function resolvePinRef(env = process.env) {
  const raw = env?.GLASSPANE_REF
  if (raw === undefined || raw === null) return REPO_REF
  const trimmed = String(raw).trim()
  return trimmed ? trimmed : REPO_REF
}

/** 允许的 clone 地址前缀（finding 3）。`https://` 是文档里那条一键安装；`ssh://` 给
 *  自带镜像的人；`file://` 保留 specs 里记着的离线/本地 clone 用法（P4-J3）。
 *  刻意**不**收 scp 式 `git@host:path`——它没有 scheme，正好和 `ext::sh -c …` 落在同一
 *  个无法白名单判定的形状里，需要它的人改写成 `ssh://git@host/path` 即可。 */
export const ALLOWED_GIT_URL_PREFIXES = ['https://', 'ssh://', 'file://']

/** ref / URL / 目录三类"要被拼进 git argv"的值的形状检查（纯函数）。
 *  拒绝的正是两类注入：以 `-` 开头（被 git 当成选项，`--upload-pack=…` 直接起进程），
 *  以及不带 scheme 的 `ext::sh -c …`（git 的 ext 传输执行任意命令）。 */
function unsafeArgvValue(value, label) {
  const text = String(value ?? '')
  if (!text) return `${label} 为空`
  if (text.startsWith('-')) return `${label} 以 "-" 开头，会被 git 当成命令行选项而不是值：${text}`
  if (/[\s\u0000-\u001f]/.test(text)) return `${label} 含空白/控制字符：${JSON.stringify(text)}`
  if (text.startsWith('+')) return `${label} 以 "+" 开头（强推语义），这里不收：${text}`
  return null
}

export function validateGitRepoUrl(repoUrl) {
  const text = String(repoUrl ?? '')
  // 顺序按"读者的病因"排：以 - 开头是选项注入、不带 scheme 是 ext:: 执行入口——这两条才是
  // 拒绝的理由。空白/控制字符只是同一批病因的**手段**，排在它们后面才不会把 `ext::sh -c …`
  // 报成一句"含空白字符"，让读者看不出真正被挡的是 ext 传输。
  if (!text) {
    return { ok: false, error: `GLASSPANE_REPO_URL 为空。只接受这些地址形式：${ALLOWED_GIT_URL_PREFIXES.join('、')}` }
  }
  if (text.startsWith('-')) {
    return { ok: false, error: `GLASSPANE_REPO_URL 以 "-" 开头，会被 git 当成命令行选项而不是值：${text}` }
  }
  const lower = text.toLowerCase()
  if (!ALLOWED_GIT_URL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return {
      ok: false,
      error: `GLASSPANE_REPO_URL 必须以 ${ALLOWED_GIT_URL_PREFIXES.join('、')} 之一开头（实为「${text}」）。`
        + '不带 scheme 的值会被 git 当成传输扩展名（`ext::…` 会直接执行后面的命令），因此一律拒绝；'
        + '本地/镜像 clone 请写 file:///<绝对路径>，scp 式 git@host:path 请写 ssh://git@host/path。',
    }
  }
  if (/[\s\u0000-\u001f]/.test(text)) {
    return { ok: false, error: `GLASSPANE_REPO_URL 含空白/控制字符：${JSON.stringify(text)}` }
  }
  return { ok: true, url: text }
}

export function validateGitRef(ref) {
  const shape = unsafeArgvValue(ref, 'GLASSPANE_REF')
  if (shape) return { ok: false, error: `${shape}。ref 只能是 tag/分支名字面量（要追主干就写 main）` }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(String(ref))) {
    return { ok: false, error: `GLASSPANE_REF 含不被接受的字符：${JSON.stringify(String(ref))}` }
  }
  return { ok: true, ref: String(ref) }
}

/** 拼一条**不会被选项注入**的 `git clone` 参数（finding 3）：三个位置参数前面都放 `--`。
 *  返回 `{ args }` 或 `{ error }`——error 里带着是哪一个值、为什么。 */
export function safeGitCloneArgs({ repoUrl = REPO_URL, ref = REPO_REF, targetDir } = {}) {
  const urlCheck = validateGitRepoUrl(repoUrl)
  if (!urlCheck.ok) return { error: urlCheck.error }
  const refCheck = validateGitRef(ref)
  if (!refCheck.ok) return { error: refCheck.error }
  const dirCheck = unsafeArgvValue(targetDir, 'clone 目标目录')
  if (dirCheck) return { error: `${dirCheck}（GLASSPANE_INSTALL_DIR/--repo 指定的目录不能以 "-" 开头）` }
  return {
    args: ['clone', '--branch', refCheck.ref, '--depth', '1', '--', urlCheck.url, String(targetDir)],
    ref: refCheck.ref,
    url: urlCheck.url,
  }
}

/** 开跑前的两条硬闸（finding 4）。旧代码把 `process.env.HOME ?? ''` 直接拼进每一条路径：
 *  HOME 没设置时状态根变成 `./.glasspane`、LaunchAgents 的 plist 落进当前目录，而 launchd
 *  会拒收相对的 StandardOutPath；`sudo` 下整棵安装无声无息落进 /var/root（授权主体、
 *  socket、面板产物没有一样在用户手里）。两条都必须在**任何写入之前**拒绝。 */
export function installGuard({ home = '', uid = null } = {}) {
  const homeText = String(home ?? '')
  if (!homeText) {
    return {
      ok: false,
      error:
        'HOME 未设置：安装产物、socket 与 ~/Library/LaunchAgents 的路径全部由它拼出来，'
        + '缺了它这些会落到**当前目录**的相对位置（./.glasspane、./Library/LaunchAgents/…），'
        + '而 launchd 直接拒收相对的 StandardOutPath——本轮没有写入任何东西。'
        + '补救：在自己的登录 shell 里重跑（必要时 export HOME=/Users/<你>）；'
        + '不要用 `sudo -u 某用户` / `env -u HOME` 这类形态起安装器。',
    }
  }
  if (!path.isAbsolute(homeText)) {
    return {
      ok: false,
      error: `HOME 必须是绝对路径，实为「${homeText}」：相对 HOME 会把状态根拼成 ${path.join(homeText, SOCKET_DIR_NAME)}，`
        + 'plist 里的 StandardOutPath 也是相对的，launchd 不会收。补救：export HOME 成绝对路径后重跑。',
    }
  }
  if (uid !== null && uid !== undefined && Number(uid) === 0) {
    return {
      ok: false,
      error:
        '当前是 uid 0（root / sudo）：GlassPane 是**用户级** launchd 代理与 TCC 授权，整棵安装会以 root 身份'
        + '落进 /var/root（产物、socket、plist 都不是你登录账号的那一份），辅助功能授权主体也永远对不上。'
        + '本安装不需要 sudo。补救：去掉 sudo 直接重跑同一条命令'
        + '（curl -fsSL https://raw.githubusercontent.com/jingzhao-l/GlassPane/main/install.sh | sh，'
        + '或 node installer/cli.js）。',
    }
  }
  return { ok: true, home: homeText }
}

/** 读**本轮装出来的这一份**二进制自报的版本（finding 1）。
 *  `glasspaned --version` 从 1.9.0 起存在，打印 `glasspaned <version>`，与 hello 帧里的
 *  `version` 同源（engine/EngineCore.buildVersion，见 DaemonVersionFlagTests 的对称性闸）。
 *  只传 `--version`：真二进制对别的参数回 `unknown argument` + 退出码 64，夹具必须一样。
 *  有界超时（默认 5s）——读不到就如实说读不到，绝不编一个版本号。 */
export function daemonBinaryVersion(binPath, { spawn = spawnSync, timeoutMs = 5000 } = {}) {
  if (!binPath) return { ok: false, version: null, error: '没有可执行文件路径可查（产物缺失？）' }
  let result
  try {
    result = spawn(binPath, ['--version'], { encoding: 'utf8', timeout: timeoutMs })
  } catch (error) {
    return { ok: false, version: null, error: `执行 ${binPath} --version 抛出 ${error?.message ?? error}` }
  }
  if (result?.error) {
    return { ok: false, version: null, error: `执行 ${binPath} --version 失败（${result.error.code ?? result.error.message}）` }
  }
  if (result?.status !== 0) {
    const first = String(result?.stderr ?? '').trim().split('\n')[0] || String(result?.stdout ?? '').trim().split('\n')[0] || '（无输出）'
    return {
      ok: false,
      version: null,
      error: `退出码 ${result?.status ?? 'null'}：${first}`
        + '（1.9.0 之前的 glasspaned 不认 --version，正是这个形状——它报的 64 就是"unknown argument"）',
    }
  }
  const line = String(result.stdout ?? '').trim()
  const match = /^glasspaned\s+(\S+)$/.exec(line) ?? /^(\S+)$/.exec(line)
  if (!match) {
    return { ok: false, version: null, error: `${binPath} --version 的输出里读不出版本号：${JSON.stringify(line)}` }
  }
  return { ok: true, version: match[1], raw: line, binPath }
}

/** 收尾校验的真判据（finding 1）：**应答 hello 的那个 daemon 必须就是本轮装出来的这一份**。
 *  旧判据 `Boolean(arrived && hello?.version)` 对"陈旧 daemon 还占着 engine.sock"这件事
 *  完全失明——那正是 `--replace-daemon` 文档里描述的场景：安装器打印"daemon 已在监听…跳过启动"，
 *  hello.version 非空，于是打印"安装完成（退出码 0）"，而刚构建的那份从未起过。 */
export function daemonVersionVerdict({ arrived = false, hello = null, binary = null } = {}) {
  const helloVersion = hello?.version ?? null
  if (!arrived || !helloVersion) {
    return { verified: false, kind: 'no-hello', helloVersion, binaryVersion: binary?.version ?? null }
  }
  if (!binary?.ok) {
    return { verified: false, kind: 'uncheckable', helloVersion, binaryVersion: null, detail: binary?.error ?? '未知原因' }
  }
  if (String(binary.version) !== String(helloVersion)) {
    return { verified: false, kind: 'mismatch', helloVersion, binaryVersion: String(binary.version) }
  }
  return { verified: true, kind: 'match', helloVersion, binaryVersion: String(binary.version) }
}

/** 判据 → 屏幕上的话（纯函数）。三种"没通过"各说各的，措辞里不许有"通过"两个字。 */
export function daemonVersionText({ kind, helloVersion, binaryVersion, detail, socketPath, daemonBin, cliPath, exitCode = 1 } = {}) {
  const code = `本命令退出码 ${exitCode}：install.sh 与调用它的脚本/agent 按安装失败处理。`
  if (kind === 'mismatch') {
    return [
      `安装未完成：应答 hello 的 daemon 自报 version=${helloVersion}，`
      + `而本轮装出来的可执行文件 ${daemonBin} 自报 ${binaryVersion}——两者不是同一份产物。`,
      `也就是说 ${socketPath} 上还挂着一个**旧构建**的 daemon，本轮构建/安置的那份从未接管。`,
      `补救（先收拢旧实例，再让本轮产物接管）：node "${cliPath}" --replace-daemon`,
      code,
    ].join('\n')
  }
  if (kind === 'uncheckable') {
    return [
      `无法核对版本：应答 hello 的 daemon 自报 version=${helloVersion}，`
      + `但本轮产物 ${daemonBin} 的 --version 读不出来（${detail}）。`,
      '这一项检查**没有做成**，因此本轮不算校验通过——这不是"通过"，也不是"没通过"，是"没人验过"。',
      `先确认产物：ls -l "${daemonBin}" 与 "${daemonBin}" --version（应打印 glasspaned <版本>），`
      + `修好后重跑：node "${cliPath}" --replace-daemon`,
      code,
    ].join('\n')
  }
  return null
}

/** daemon 的 LaunchAgents plist 按 updater 同规格写：owner-only + 模式读回（finding 7）。
 *  旧写法 0644 把同一份文件（里面是本机装了哪些可执行、日志与 socket 的确切路径）摊给
 *  同机所有账号读；`updater/lib/launchd.js` 给自己的代理 plist 早就写 0600 并读回核对。
 *  chmod 没落住按**写失败**处理（与 ensureLogDir/openPrivateLog、updater 的 tightenMode 同一判据）。 */
export function writePrivatePlist(plistPath, xml, {
  write = (file, text) => fs.writeFileSync(file, text, { mode: STATE_FILE_MODE }),
  chmod = fs.chmodSync,
  statMode = (file) => fs.statSync(file).mode & 0o777,
} = {}) {
  try {
    write(plistPath, xml)
    chmod(plistPath, STATE_FILE_MODE)
    const mode = statMode(plistPath)
    if (mode !== STATE_FILE_MODE) {
      return {
        ok: false,
        mode,
        error: `${plistPath} 在 chmod(0600) 之后仍是 ${formatMode(mode)}：这台机器的卷不保存权限位，`
          + 'owner-only 的 LaunchAgent 做不到（同一次写按失败算，不当成功报告）',
      }
    }
    return { ok: true, mode, error: null }
  } catch (error) {
    return { ok: false, mode: null, error: `launchd plist 写不进去：${plistPath}（${error.message}）` }
  }
}

/** 面板那一句"再起一次"必须落在真存在的东西上（finding 8）。
 *  `panel` 由 install() 用**已经算好的** settingsLaunchPath 结果传进来：
 *  `{ viaBundle, executable, app, exists }`。缺省时这里按同一口径自己去文件系统查一次——
 *  不是为了兼容旧调用方而放宽，而是因为"印一条没人能跑的 open"本身就是这条要修的 bug。 */
export function panelOpenHint({ panel, rootDir, settingsApp = null, exists = (p) => fs.existsSync(p) } = {}) {
  const fallbackExecutable = path.join(rootDir ?? '', 'engine', '.build', 'release', PANEL_EXE_NAME)
  const fallbackApp = settingsApp ?? path.join(rootDir ?? '', 'engine', '.build', 'release', SETTINGS_APP_NAME)
  const info = panel ?? {
    viaBundle: Boolean(settingsApp),
    executable: fallbackExecutable,
    app: settingsApp ?? fallbackApp,
  }
  const target = info.viaBundle ? (info.app ?? fallbackApp) : (info.executable ?? fallbackExecutable)
  const there = info.exists ?? Boolean(target && exists(target))
  if (!there) {
    return {
      runnable: false,
      target,
      looked: [info.app ?? fallbackApp, info.executable ?? fallbackExecutable],
      text: `本轮没有可执行的面板产物：找过 ${info.app ?? fallbackApp}（GlassPane.app）与 `
        + `${info.executable ?? fallbackExecutable}（裸二进制 glasspane-settings），两个都不存在——`
        + `没有 open 命令可给（用了 --no-app，或 make-app.sh 没有产出 bundle）。`
        + '去掉 --no-app 重跑安装即可得到面板；在那之前权限引导只能人工在系统设置里做。',
    }
  }
  return {
    runnable: true,
    target,
    text: info.viaBundle
      ? `open "${target}"`
      : `直接执行裸二进制面板："${target}"（当前没有 .app bundle，所以不经 open、没有 bundle 身份）`,
  }
}

/** clone 失败的归因（finding 9）：把 **git 自己的原话**交给读者，而不是把任何非零退出
 *  都算成"网络不可达或该发布 tag 不存在"。"destination path … already exists and is not an
 *  empty directory" 是真能走到的（bootstrapPlan 只拒绝"存在且父目录也不是仓库"的那种），
 *  被归因成网络问题时读者会一直重试一条永远不通的路。 */
export function cloneFailureText({ ref, status, stderr = '', targetDir }) {
  const detail = String(stderr ?? '').trim()
  const head = `git clone 失败（ref '${ref}'，目标 ${targetDir}，退出码 ${status ?? 'null'}）。`
  if (/already exists and is not an empty directory/i.test(detail)) {
    return [
      head,
      `git 的原话：${detail}`,
      `原因不是网络：目标目录已存在且不是空目录（${targetDir}）。`,
      `补救：换目标目录（GLASSPANE_INSTALL_DIR=<空目录>，或 installer 用 --repo <目录>）重跑；`
        + '确认该目录可以删除后再自行清理。',
    ].join('\n')
  }
  if (detail) {
    return [
      head,
      `git 的原话：${detail}`,
      `（ref '${ref}' 不存在或网络不可达只是这份原话**可能**的成因之一，以原话为准。）`,
    ].join('\n')
  }
  return [
    head,
    'git 没有留下 stderr，无法进一步归因；按 ref 不存在 / 网络不可达 / 目标目录不可写三条依次排查。',
    `可用 GLASSPANE_REF=main 追主干，或 GLASSPANE_REF=<tag> 指定发布版。`,
  ].join('\n')
}

/** 主安装流程；所有副作用步骤均记录真实执行结果，失败即抛错终止。
 *  返回值是收尾校验结论（`installOutcome`），入口守卫据此设退出码。
 *
 *  `uid` / `home` 是**测试接缝**（finding 4）：真实调用读 `process.getuid()` 与
 *  `env.HOME`；单测注入 uid=0 就能在不真的当 root 的前提下走同一条拒绝分支——
 *  这也是唯一能让"sudo 下静默装进 /var/root"这条可单测的地方。 */
export async function install({
  options = parseArgs([]).options,
  env = process.env,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {

  const explicitRoot = options.repoDir ? path.resolve(options.repoDir) : null
  const envRoot = env.GLASSPANE_REPO ? path.resolve(env.GLASSPANE_REPO) : null

  // finding 4：在任何写入/clone 之前先闸掉两种 HOME/uid 形态。旧代码直接把
  // `process.env.HOME ?? ''` 拼进每一条路径，HOME 缺失或相对时状态根成了
  // `./.glasspane`、plist 落进当前目录（launchd 拒收相对 StandardOutPath），
  // 而 sudo 下整棵安装无声无息落进 /var/root。
  const guard = installGuard({ home: env.HOME ?? '', uid })
  if (!guard.ok) {
    throw new Error(guard.error)
  }
  const homeDir = guard.home
  const pinRef = resolvePinRef(env)

  let rootDir = explicitRoot ?? envRoot ?? resolveProjectRoot()

  if (!rootDir || !fs.existsSync(rootDir)) {
    if (options.bootstrap === false) {
      throw new Error(repoMissingText())
    }
    const plan = bootstrapPlan({
      homeDir,
      installDir: env.GLASSPANE_INSTALL_DIR ?? null,
      repoUrl: env.GLASSPANE_REPO_URL ?? REPO_URL,
      ref: pinRef,
    })
    if (plan.error) {
      throw new Error(`${plan.error}\n\n${repoMissingText()}`)
    }
    printStep(`未定位到本地仓库，引导 clone：${plan.targetDir}（ref: ${plan.ref}）……`)
    // stderr 要留着归因（finding 9）：任何非零都算"网络不可达或 tag 不存在"会把
    // "目标目录已存在且非空"这类本地故障说成网络问题，读者据此一直重试同一条死路。
    const clone = spawnSync('git', plan.gitArgs, {
      stdio: ['inherit', 'inherit', 'pipe'],
      encoding: 'utf8',
    })
    if (clone.status !== 0) {
      throw new Error(
        `${cloneFailureText({
          ref: plan.ref,
          status: clone.status,
          stderr: clone.stderr ?? clone.error?.message ?? '',
          targetDir: plan.targetDir,
        })}\n\n${repoMissingText()}`,
      )
    }
    if (resolveProjectRoot(plan.targetDir) === null) {
      throw new Error(`clone 完成但目录结构不完整：${plan.targetDir}\n\n${repoMissingText()}`)
    }
    rootDir = plan.targetDir
  }

  // 发布 tag GPG 验签：动作怎么落由 `tagVerifyDecision` 判（纯函数，有单测）。
  // `pinRef` 沿用上面 `resolvePinRef(env)` 那一次读取——合并时这里曾各自再读一遍
  // （`env.GLASSPANE_REF || REPO_REF`），那份把"置空 GLASSPANE_REF"读成追主干，与
  // install.sh 侧不同源；一个事实只留一处读法。
  if (pinRef !== 'main' && repoHasRef(rootDir, pinRef)) {
    const sig = verifyCloneTagGpg({ repoDir: rootDir, ref: pinRef })
    const verdict = tagVerifyDecision({ sig, pinRef, repoDir: rootDir })
    if (verdict.action === 'refuse') throw new Error(verdict.text)
    printStep(paint(verdict.text, verdict.action === 'pass' ? 'green' : 'yellow'))
  }

  const engineDir = path.join(rootDir, 'engine')
  const buildDir = path.join(engineDir, '.build', 'release')
  const socketPath = path.join(homeDir, SOCKET_DIR_NAME, SOCKET_FILE_NAME)
  const daemonBin = path.join(buildDir, DAEMON_EXE_NAME)
  const settingsBin = path.join(buildDir, PANEL_EXE_NAME)
  const daemonLog = path.join(homeDir, SOCKET_DIR_NAME, DAEMON_LOG_NAME)
  // bundle 安置计划（P1 v1.2 §11.1）：--no-app 时 appPackaged=false，后续一律
  // 回退裸二进制并如实告警。路径一律用**闸过的** homeDir（旧代码在这里和 1630 行
  // 各读一次 process.env.HOME，与上面 env.HOME 的 clone 口径是三套）。
  const plan = bundlePlan({
    homeDir,
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
    //
    // finding 12：`rm -rf ~/Applications/GlassPane*.app` 是本流程里两件破坏性动作之一
    // （另一件是结束在跑的实例 / bootout 已加载作业）。`--no-prompt` 过去是**惰性**的
    // ——confirm() 没有任何调用方，README 与 --help 却写着"跳过每步确认"。现在它真的有
    // 一档可跳过：交互终端里会问一句；`--no-prompt` 直接放行；非交互又没给 flag 则不覆盖
    // （install.sh 在 stdin 非 TTY 时本来就会补 --no-prompt，CI/e2e 与 `curl | sh` 行为不变）。
    const replaceTargets = bundlesToReplace({ plan })
    let allowReplace = true
    if (replaceTargets.length > 0) {
      allowReplace = await confirm(
        `将用本轮产物覆盖已存在的 .app：${replaceTargets.join('、')}`,
        { autoYes: options.prompt === false },
      )
      if (!allowReplace) {
        printStep(paint('未确认覆盖：保留现有 .app，本轮不安置新 bundle（脚本场景请加 --no-prompt）', 'yellow'))
      }
    }
    const bundles = installBundles({ plan, allowReplace })
    for (const app of bundles.installed) {
      printStep(`已安置：${app}`)
    }
    for (const app of bundles.declined) {
      printStep(paint(`未覆盖（回答跳过）：${app}——里面还是上一轮的产物`, 'yellow'))
    }
    if (bundles.installed.length === 0 && bundles.declined.length === 0) {
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
    const launchAgentsDir = path.join(homeDir, ...LAUNCHD_DIR_NAME.split('/'))
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
    // finding 12：bootout 一个**已加载且健康**的作业会打断它正在跑的 act，这一步和
    // 覆盖 .app 一样是破坏性的。先只读探一次（launchdReregisterProbe），只有真的会
    // 卸掉在跑的东西才问；不需要 bootout 的常规 bootstrap 照旧不问。
    // **顺序要紧**：确认在写盘之前。反过来先写 plist 再问，人回答"跳过"之后磁盘上就是
    // 新定义、launchd 里还是旧定义——那正是本文件 L~620 注释里 EX_CONFIG 的来路，而
    // bootoutDeclined 那句"什么都没改"也会当场变成假话。
    let allowBootout = true
    const probe = launchdReregisterProbe(daemonLaunch.path)
    if (probe.loaded && probe.needsReregister) {
      allowBootout = await confirm(
        `launchd 里已加载 ${LAUNCHD_LABEL}（程序：${probe.program ?? '（未读到）'}），`
        + '卸载它才能换新定义——这会打断正在跑的 daemon',
        { autoYes: options.prompt === false },
      )
      if (!allowBootout) {
        throw new Error(`开机自启未重注册，且**没有**改写 ${plistPath}：未确认 bootout 已加载的 `
          + `${LAUNCHD_LABEL}（launchd 里跑的还是 ${probe.program ?? '（未读到）'}）。`
          + '要保留旧作业就什么都不用做；要让新定义生效，在交互终端重跑本命令并回答继续，'
          + '或在脚本/自动化里显式加 --no-prompt。')
      }
    }
    // finding 7：这份 plist 写的是本机装了哪些可执行、socket 与日志的确切路径，
    // 过去以 0644 落在 ~/Library/LaunchAgents（同机任何账号可读），而
    // updater/lib/launchd.js 给自己的代理 plist 早就写 0600 并把模式读回。
    // 现在同规格：0600 + 读回核对，读不回来说的是**实际模式**而不是"应该已经私有"。
    const plistWrite = writePrivatePlist(plistPath, plistXml)
    if (!plistWrite.ok) {
      printStep(paint(`launchd plist 未能写成 owner-only：${plistWrite.error}`, 'red'))
    }
    const bootstrapResult = launchctlBootstrap(LAUNCHD_LABEL, plistPath, {
      desiredProgram: daemonLaunch.path,
      allowBootout,
    })
    if (!bootstrapResult.ok) {
      throw new Error(
        bootstrapResult.bootoutDeclined
          ? `launchd 未重注册（未确认 bootout）：${bootstrapResult.message}`
          : `launchd 注册失败：${bootstrapResult.message}`,
      )
    }
    printStep(bootstrapResult.already ? bootstrapResult.message : `开机自启已注册（${plistPath}）`)
  }

  // 自动更新接线（规格 2026-09-27 §5/§7）：daemon 作业注册之后就做，且**不**因为
  // --no-launchd 而跳过——每日定时代理与开机自启是两件事（前者 RunAtLoad=false）。
  // 装树里没有 updater/ 时是"如实告警 + 不写指针 + 安装继续"；其余失败（指针读不回、
  // launchctl 拒绝 bootstrap、状态写不进）一律抛出 → 退出码 1，绝不静默跳过。
  //
  // 这里**不**传 homeDir：状态根与代理 plist 的落点都由 updater 自己算（状态根取口令
  // 记录里的家目录，见 updater/cli.js 的 recordHomeDir 注释与它的 home.test.mjs），
  // 安装器其余路径仍按 process.env.HOME 拼——那是 SECURITY §2.5 记着的已知未闭口，
  // 本轮不给它再添第三种家目录口径；只保证"指针落在 `updater enable` 会落的那一处"。
  const update = await registerAutoUpdate({
    rootDir,
    env,
    autoUpdate: options.autoUpdate,
  })

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
        // finding 12：结束在跑的实例是第二件破坏性动作（它会打断正在进行的 act，
        // 而 daemon 侧的 SIGTERM 收尾是"清理 socket 后退出"）。`--no-prompt` 放行、
        // 交互终端问一句、非交互且没给 flag 则不动别人的进程。
        const mayTerminate = await confirm(
          `将结束已在跑的实例（${summary}），其间正在执行的 act 会被打断`,
          { autoYes: options.prompt === false },
        )
        if (!mayTerminate) {
          printStep(paint('未确认：没有结束任何在跑的实例（脚本场景请加 --no-prompt）', 'yellow'))
        } else {
          const result = terminatePids([...staleDaemons, ...stalePanels])
          // finding 5：`terminated` 现在只含**SIGKILL 之后再探一次确实不在**的 pid。
          // 旧实现把每条 kill 的退出码丢掉、直接报"已结束既有实例：<全部 pid>"，于是
          // root 所有的陈旧 daemon（kill 与 kill -0 都回 EPERM）被说成已经结束，而它还在
          // 服务同一个 socket。这类 pid 进 survivors，必须单独用红字点名。
          printStep(
            result.forced.length > 0
              ? `既有实例已收拢（SIGTERM 未生效、已强杀：${result.forced.join(', ')}）`
              : `已结束既有实例：${result.terminated.join(', ')}`,
          )
          if (result.survivors.length > 0) {
            for (const line of survivorText(result.survivors, { socketPath }).split('\n')) {
              printStep(paint(line, 'red'))
            }
          }
          // 收拢旧实例后主动让 launchd 接管：TERM 现在是 clean exit 0，KeepAlive
          // (SuccessfulExit=false) 语义下 launchd 不会自动复活，必须 kickstart。
          // 不这么做就会退化成"手动实例持有 socket"，开机自启那份配置形同虚设。
          if (staleDaemons.length > 0 && options.launchd) {
            const runUid = String(spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim())
            if (runUid) {
              spawnSync('launchctl', launchdKickstartArgs({ label: LAUNCHD_LABEL, uid: runUid }))
              relaunchedByLaunchd = await waitForSocket(socketPath)
              printStep(relaunchedByLaunchd
                ? 'launchd 已按新配置接管 daemon（kickstart）'
                : 'launchd 未在时限内接管，改由安装器直接启动')
            }
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

  // 面板的真实落点（finding 8）：bundle 优先/裸二进制兜底**在这里**算一次，GUI 启动与
  // 「后续使用说明」共用这一份结论。旧代码只在 options.gui 分支里算，说明文本另拼一个
  // `~/Applications/GlassPane.app` 或从没构建过的 `.build/release/GlassPane.app`——
  // `--no-app`/什么都没安置时印出来的那句 `open "…"` 指的是一条不存在的路径。
  const guiLaunch = settingsLaunchPath({ plan, bareBin: settingsBin })
  const panel = {
    viaBundle: guiLaunch.viaBundle,
    executable: guiLaunch.path,
    app: plan.settingsApp,
    exists: Boolean(guiLaunch.path) && fs.existsSync(guiLaunch.path),
  }

  let guiOpened = false
  if (options.gui) {
    if (!panel.exists) {
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
  // finding 1（P0）：`Boolean(arrived && hello?.version)` 对"陈旧 daemon 还占着 socket"
  // 完全失明——那正是 --replace-daemon 文档里描述的场景：hello.version 非空 → 打印
  // "安装完成（退出码 0）"，而本轮刚构建的那份从未起过。现在拿**本轮产物自己**当对照：
  // `glasspaned --version` 打印的就是 hello 帧里那个 version（同源于 EngineCore.buildVersion），
  // 两者不一致 = 服务 socket 的不是这一份 → verified=false。产物跑不起来时说的是
  // "这项检查没做成"，同样 verified=false，绝不把它当成通过。
  const binaryProbe = arrived && hello?.version
    ? daemonBinaryVersion(daemonLaunch.path)
    : { ok: false, version: null, error: 'socket 没人应答 hello，没有可对照的另一边' }
  const verdict = daemonVersionVerdict({ arrived, hello, binary: binaryProbe })
  const verified = verdict.verified
  const outcome = installOutcome({ verified, daemonExpected })
  const cliPath = path.join(rootDir, 'installer', 'cli.js')
  if (verified) {
    printStep(`实测校验通过：daemon 在 ${socketPath} 应答 hello（version=${hello.version}，与本轮产物 ${daemonLaunch.path} 自报的 ${verdict.binaryVersion} 一致${hello.pid ? `，pid=${hello.pid}` : ''}）`)
    printStep(`安装完成（退出码 ${outcome.exitCode}）。`)
  } else if (daemonExpected && (verdict.kind === 'mismatch' || verdict.kind === 'uncheckable')) {
    for (const line of daemonVersionText({
      kind: verdict.kind,
      helloVersion: verdict.helloVersion,
      binaryVersion: verdict.binaryVersion,
      detail: verdict.detail,
      socketPath,
      daemonBin: daemonLaunch.path,
      cliPath,
      exitCode: outcome.exitCode,
    }).split('\n')) {
      printStep(paint(line, 'red'))
    }
  } else if (daemonExpected) {
    for (const line of verificationFailureText({
      arrived,
      socketPath,
      daemonLog,
      cliPath,
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
    // finding 8：面板那句"再起一次 open …"必须落在真的存在的东西上。这里给的是
    // **已经算好的** settingsLaunchPath 结果（bundle 优先、裸二进制兜底 + 实测存在），
    // 不是猜出来的路径。
    panel,
    update,
  })}\n`)
  return outcome
}

/** 入口守卫：直接用 node 运行本文件时才走安装流程（测试导入仅取函数）。 */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  // 入口的**每一条**退出都交给事件循环，没有例外。`curl | sh` 是文档里的调用形态，
  // stdout 接的是管道：`process.exit()` 抢在 flush 之前退，会把刚写出去的那几行
  // （usage、预检清单、restore 的判定句）连根截掉——而失败时用户能读的正是这几行。
  // 上一轮只把 install 的 .catch 改成了 `process.exitCode`，参数错误／--help／
  // --restore-launchd／环境预检这四条还留着 `process.exit()`；Linux runner 上就是
  // 从这里现形的（那台机器没有 swift，预检拒绝必然走到，而测试原本指望走到 install
  // 的拒绝分支——一条依赖机器状态的断言）。
  const { options, error } = parseArgs(process.argv.slice(2))
  if (error) {
    process.stderr.write(`\n${paint(`参数错误：${error}`, 'red')}\n\n`)
    process.stderr.write(usageText())
    process.exitCode = 2
  } else if (options.help) {
    process.stdout.write(usageText())
    process.exitCode = 0
  } else if (options.restoreLaunchd) {
    // 审计项④：恢复 + 校验全机器化，退出码即判定（0=daemon 就位且已按实际
    // 自报如实报告；1=作业/服务面失败），agent 可直接执行并按 message 续办。
    const result = await restoreLaunchd()
    process.stdout.write(`${result.message}\n`)
    process.exitCode = result.ok ? 0 : 1
  } else {
    const env = checkEnvironment()
    const issues = preflightIssues(env)
    if (issues.length > 0) {
      process.stderr.write(paint('\n环境预检未通过：\n', 'red'))
      for (const issue of issues) {
        process.stderr.write(`  - ${issue}\n`)
      }
      process.stderr.write('\n修复后重新运行即可。\n')
      process.exitCode = 1
    } else {
      install({ options })
        .then((outcome) => {
          process.stdout.write('\n')
          // 退出码 = 收尾校验结论。用 process.exitCode 而不是 process.exit()：让上面的
          // 说明文本先冲干净（`curl | sh` 常接管道，截断会把"下一步怎么办"整段吃掉）。
          process.exitCode = outcome.exitCode
        })
        .catch((installError) => {
          process.stderr.write(paint(`\n安装失败：${installError.message}\n`, 'red'))
          // 与成功路径同一套：用 process.exitCode，不用 process.exit()。`curl | sh` 是文档里的调用
          // 形态，stdout 接的是管道——exit() 会把还排在队列里的步骤输出连根截掉，而那正是用户
          // 唯一需要读的一段（哪一步炸的、下一步跑什么）。
          process.exitCode = 1
        })
    }
  }
}