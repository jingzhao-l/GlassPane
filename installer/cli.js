#!/usr/bin/env node
/**
 * glasspane-install — 一键安装 CLI（零第三方依赖，Node >= 18）。
 *
 * 流程：terminal onboarding 横幅 → 环境预检（node/swift/git/open）→ 定位项目
 * 根目录 → npm 依赖（有 package-lock.json 走 npm ci，见 npmDepsCommand）→ 编译 TS
 * （mcp-shell；内核是已发布的 `iterate-kernel` 依赖，捆进它的 bundle，不再是仓内 workspace）→ swift
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
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import net from 'node:net'

/**
 * One value, quoted as one shell word — the installer-side copy of the product rule.
 *
 * The rule already has three executable bodies in this product (`mcp-shell/src/errors.ts`'s
 * `quoteShellArg`, `engine/Sources/GlassPaneEngine/StateRoot.swift`'s `RemedyCommand.quote`,
 * `updater/lib/shell-quote.js`), and a fourth is legitimate here for the same reason the third
 * one is: this package ships standalone — `installer/package.json`'s `files` is `cli.js` +
 * `glasspane.js`, and `npx glasspane-install` installs nothing beside it, so importing
 * `mcp-shell/dist` from here is impossible. What the packages share is therefore the *gate*:
 * `mcp-shell/test/remedy-shell-quoting.test.mjs` scans `installer/*.js` with the same
 * argument-position judgement it applies to `src/` and `updater/`, so a bare interpolation at a
 * command operand reddens all three sides in one run, and `installer/test/shell-quoting.test.mjs`
 * pins this table against the shipped behaviour.
 *
 * Why it was needed at all: every one of these commands interpolates a path this process did
 * not author — `tree.cli` / `update.updaterCli` come from `--repo`, `GLASSPANE_REPO` and
 * `GLASSPANE_INSTALL_DIR` — and they were wrapped in DOUBLE quotes. Double quotes are not inert:
 * `$(` and a backtick still expand inside them, so "run this restore command" became "run what
 * the directory name says", with the agent's own privileges.
 */

/** Characters a shell cannot act on inside an unquoted word. */
const SHELL_INERT_WORD = /^[A-Za-z0-9@%+=:,./_-]+$/

/**
 * `value` as one shell word: left bare when it is made only of characters a shell cannot act on,
 * single-quoted with `'\''` splices for anything else — a space, a quote, a dollar sign, a glob,
 * the empty string (an argument that vanished is a different command line), or a leading hyphen
 * (read as an option otherwise). Same table as `updater/lib/shell-quote.js` and
 * `mcp-shell/src/errors.ts`.
 */
export function quoteShellArg(value) {
  const text = String(value)
  return SHELL_INERT_WORD.test(text) && !text.startsWith('-')
    ? text
    : `'${text.split("'").join("'\\''")}'`
}

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
export const RELEASE_VERSION = '1.27.0'
/** 发布 ref（tag 名）。GLASSPANE_REF 环境变量可覆盖（追主干用 `main`）。 */
export const REPO_REF = `v${RELEASE_VERSION}`

/** 发布公钥的 key id 与 uid：拒绝文案里两者要成对出现，读者才知道要比对的是**哪一把**
 *  钥匙——"随便一把签过名的钥匙"不算证据。 */
export const GLASSPANE_SIGNING_KEY_ID = '0929EA31DF4F7429F63FC53189D88B1D043A1298'
export const GLASSPANE_SIGNING_KEY_UID = 'jingzhao-l (sign-github) <ET_lin@outlook.com>'

/** 发布签名公钥（GPG，key 0929EA31DF4F7429F63FC53189D88B1D043A1298，uid
 *  jingzhao-l (sign-github) <ET_lin@outlook.com>）。与 npm 安装链的 Integrity 不同，
 *  GPG 校验的是"来源/作者身份"而不是"内容哈希"：clone 到的发布 tag 若带 GPG 签名，
 *  用这把公钥验签通过，才能确证源码出自发布者之手（而非同名 tag 或中间人）。
 *  恒为 best-effort：未签名/不可用只告警不阻断，因为 HTTPS clone + tag 钉版本已保证
 *  内容完整性，GPG 是额外的一层来源证明。 */
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

/** 解析 CLI 参数；未知/带值参数缺参时返回 `{ error, errorKind }`。
 *
 * 返回的 `options` 是**已经读到的那一部分**（不是 defaults）——入口要在"--help 与用法错同时
 * 出现时谁赢"这条规则上看得见 help 有没有被真的给出来（2026-10-31 P1）。
 * `errorKind` 也只有两个取值：`'repo-value'`＝这一层自己就说不通的用法错（`--repo` 没接到取值、
 * 或取值是旗标形状），`'unknown'`＝只有本文件认得的旗标清单才能判定的错。两个 kind 与
 * `--help` 的先后关系不同，规则写在入口的 `if (isMain)` 那一块上面。
 */
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
    acceptUnverifiedSignature: false,
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
      case '--repo': {
        // 取值的两条判据与 install.sh 的 2c' 同一句，且**不以 `--` 为界**：单横线的 `-x` 同样是
        // 一面旗标的形状。从前这里只否 `--` 前缀，于是 `--repo -x` 被当成一个目录收下继续跑，
        // 而同一个文件的 unsafeArgvValue 对 clone 目标却否 `-` 前缀——一处两套口径（2026-10-31 P1）。
        const value = rest[index + 1]
        if (value === undefined) {
          return { options: opts, error: '--repo 需要一个目录参数（后面没有取值）', errorKind: 'repo-value' }
        }
        if (value.startsWith('-')) {
          return { options: opts, error: `--repo 需要一个目录参数（收到的是旗标：${value}）`, errorKind: 'repo-value' }
        }
        index += 1
        opts.repoDir = value
        break
      }
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
      case '--accept-unverified-signature':
        // 只覆盖 `unavailable` 那一档（验签没跑成）；`invalid` 在它面前仍旧是硬拒。
        // 与 updater 的 `--consent unsigned-release` 同一形态：批的是"缺证明"，不是"签不上"。
        opts.acceptUnverifiedSignature = true
        break
      default:
        return { options: opts, error: `未知参数：${arg}（--help 查看用法）`, errorKind: 'unknown' }
    }
  }
  return { options: opts, error: null, errorKind: null }
}

/** "这一棵是不是 GlassPane 仓库"的**唯一一份**判据（两个 marker 的相对路径）。
 *  install.sh 的 `looks_like_repo` 测的就是这两个路径，两处由
 *  `installer/test/daily-20261029-installer-lane7.test.mjs` 逐值对照——在那之前"两条入口的判据
 *  同源"只是两句注释互相指认，脚本里那份是没人对照的第二份抄本。 */
export const REPO_MARKERS = Object.freeze(['engine/Package.swift', 'mcp-shell/package.json'])

/** 只问**这一层目录**，一律不向上走：`looksLikeRepoHere(<外层repo>/vendored)` 答 false，
 *  而 {@link resolveProjectRoot} 会答出外层那一棵。S7-1（2026-10-29，P0）修的就是这个差别——
 *  判断"目标是不是仓库"时向上走，别人的仓库子目录就被读成"既有 clone"，随后 fetch/checkout
 *  动的是外层那棵树。 */
export function looksLikeRepoHere(dir) {
  if (typeof dir !== 'string' || dir === '') return false
  return REPO_MARKERS.every((rel) => fs.existsSync(path.join(dir, rel)))
}

/** 显式定位位（`--repo` / `GLASSPANE_REPO`）交进来的那一条路径的**第一字节之前的闸**（纯函数）。
 *
 * 存在的理由（2026-10-31 P0，实测）：`install()` 从前对这两个值只测 `fs.existsSync`，于是
 * `npx glasspane-install --repo <一个存在的非仓库目录>` 真的把那个目录当项目根——`npm install`
 * 以它为 cwd 跑起来（往里写 `node_modules`），一路撞到 `swift build` 才回 1。同一串输入
 * `install.sh` 在 2e 那一支回 1 且"没有 clone、没有写入任何东西"。两条一键入口对同一串 argv
 * 必须同判，而"先写再拒"本身就违背本仓的规矩：能拒绝的守卫要在第一字节之前拒
 * （同一族的先例：`GP_E_SOCKET_TRUST` 写在写位之前、`install.sh` 的 `looks_like_repo`）。
 *
 * 判据两条，拒时都要点名（缺了哪一条也要点名，否则读者不知道该补什么）：
 *  1. 目录存在；
 *  2. 目录里同时有 {@link REPO_MARKERS} 那两个文件（与 `install.sh` 的 `looks_like_repo` 同一份）。
 * 文案与 `install.sh` 的 2e/2f 两支逐句对齐，由 `installer/test/daily-20261030-entry-parity.test.mjs`
 * 按同一串输入逐值对照——那句"两条入口同答"从前只写在注释里。
 *
 * @returns {string|null} 拒绝正文（调用方抛错即可，一条字节都不必已经写出）；放行时是 null。
 */
export function locatedRootRefusal({ label, dir, ref = '' }) {
  if (typeof dir !== 'string' || dir === '') return null
  const exists = fs.existsSync(dir)
  if (exists && looksLikeRepoHere(dir)) return null
  const missing = REPO_MARKERS.filter((rel) => !fs.existsSync(path.join(dir, rel)))
  return [
    `${label} 给了这个目录，而它不合判据：${dir}`,
    `  判据（两条都要在，与 looks_like_repo 同一份）：目录要存在；目录里要同时有 ${REPO_MARKERS.join(' 与 ')}。`,
    `  现在缺的是：${exists ? `${missing.join('、')} 不在` : '目录不存在'}`,
    // 这一句是这条闸的**承诺**，不是装饰：它排在 ensureLogDir 与 npm 之前，所以拒绝之后
    // 家目录里不会多出 .glasspane，指定目录里不会多出 node_modules。
    '本轮没有 clone、没有写入任何东西。',
    `下一步：${label} 指一棵真的仓库（上面两条判据都在），或去掉 ${label} 让它 clone 一份${ref ? `（ref: ${ref}）` : ''}。`,
  ].join('\n')
}

/** 从起始目录向上逐级寻找含 engine/Package.swift 与 mcp-shell/package.json 的根目录。 */
export function resolveProjectRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir)
  while (true) {
    if (looksLikeRepoHere(dir)) {
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

/** 探测一次命令：返回三档判定，而不是把"没答话"和"不在"混成一件事。
 *
 *  2026-10-23（缺陷 2）实测到的形状：整套件并发跑时 `git --version` 在 5 秒内没回来，旧实现把
 *  `status !== 0`（超时是 `null`）当成"未找到"，于是①对用户说"未找到 git（xcode-select --install）"
 *  ——这台机器上 git 好好的；②`installer/test/review-2026-10-09.test.mjs` 那条按"预检挡了"跳过的
 *  真机用例静默不跑，整条正向分支（退出码 0 + "安装完成" + "实测校验通过"）在本机一次也没被测过。
 *  单独跑这条又恒过——所以红看不见、跳过也看不见。
 *
 *  三档：`available`（探测命令自己退 0）/ `absent`（ENOENT，或答了但退非 0：CLT shim 就是这一档，
 *  此时"装它"这条建议仍然成立）/ `unverified`（探测没走完：超时或 spawn 起了但没结果——这一档
 *  **不能**说成"未找到"）。 */
export const PROBE_STATES = Object.freeze({ available: 'available', absent: 'absent', unverified: 'unverified' })

/** 探测预算。第一次 5s；只有"没答话"才补一次宽的（这是区分"没答"与"答了不要"，不是给计时假红加超时）。 */
export const PROBE_TIMEOUT_MS = 5000
export const PROBE_RETRY_TIMEOUT_MS = 20000

function probeOnce(spawn, cmd, args, timeoutMs) {
  try {
    return spawn(cmd, args, { stdio: 'ignore', timeout: timeoutMs })
  } catch {
    return { status: null, error: { code: 'EPARSE_SPAWN_THROW' } }
  }
}

/** 一次判定的三档结果；`access` 只用于不支持 `--version` 的命令（open）。 */
export function commandProbe(bin, {
  spawn = spawnSync,
  access = (file) => fs.accessSync(file, fs.constants.X_OK),
  timeoutMs = PROBE_TIMEOUT_MS,
  retryTimeoutMs = PROBE_RETRY_TIMEOUT_MS,
} = {}) {
  const judge = (cmd, args, budget) => {
    const res = probeOnce(spawn, cmd, args, budget)
    if (res.status === 0) return PROBE_STATES.available
    const code = res.error && res.error.code
    if (code === 'ENOENT') return PROBE_STATES.absent
    // 夹具里注入的假 spawn 只给 {status}：非 0 退出＝它答过了，答案是"不行"。
    if (code === undefined || code === null) return PROBE_STATES.absent
    return PROBE_STATES.unverified
  }
  const first = judge(bin, ['--version'], timeoutMs)
  if (first === PROBE_STATES.available) return first
  const second = first === PROBE_STATES.unverified
    ? judge(bin, ['--version'], retryTimeoutMs)
    : first
  if (second !== PROBE_STATES.absent) return second
  const probe = SHIM_PROBE_COMMANDS[bin]
  if (probe) {
    // 到这一支为止：文件存在对 shim 易感工具不构成证据（见 SHIM_PROBE_COMMANDS 注释）。
    const shim = judge(probe.cmd, probe.args, timeoutMs)
    if (shim === PROBE_STATES.available) return shim
    return shim === PROBE_STATES.unverified
      ? judge(probe.cmd, probe.args, retryTimeoutMs)
      : shim
  }
  try {
    access(path.join('/usr/bin', bin))
    return PROBE_STATES.available
  } catch {
    return PROBE_STATES.absent
  }
}

/** 检查命令是否存在：优先 `<bin> --version`；shim 易感工具（swift/git）改由
 *  SHIM_PROBE_COMMANDS 里那条探测命令的退出码决定；其余（open 等不支持 --version）
 *  才退化到 /usr/bin 下的可执行文件。真实探测，不伪造。
 *  `spawn`/`access` 是测试接缝：这一条判据的正反两面都得由假探测跑出来，真机上
 *  "装了 Xcode 的机器"永远只能给出正面一半。
 *  布尔只是三档判定的"可用"那一格；预检的**文案**要区分"没有"与"没确认"，见 `checkEnvironment`。 */
export function commandAvailable(bin, opts = {}) {
  return commandProbe(bin, opts) === PROBE_STATES.available
}


/**
 * 预检**真的**去问主机的那些命令。这一行是文档侧那句数量主张的真源：
 * `README.md` / `README.zh-CN.md` 的「它确实探测的这五项」由 `scripts/check-doc-links.mjs`
 * 从这里的数组字面量算出来比对（从前那句写的是"四行"，而表里一共五行、代码探五项——
 * 三个数字各说各话，没人核过；2026-10-22 那轮实测到 npm/swift/launchd 真的在开发者 HOME 上
 * 跑起来之后才发现文档与代码已经漂了两个刻度）。
 *
 * 它同时是 `checkEnvironment()` 的探测面清单：新增一项却不加探测，由
 * `installer/test/daily-20261022-preflight-claim.test.mjs` 的那张映射表抓红。
 */
export const PREFLIGHT_PROBED_COMMANDS = Object.freeze(['node', 'npm', 'swift', 'git', 'open'])

/** 环境预检快照，返回每种依赖的可用状态（真实探测，不伪造）。
 *
 *  `unverified` 记的是"探测没走完"那几项命令名（见 `commandProbe` 的三档）。它不是一个新命令，
 *  而是同一批读数的第二种答案：`git: false` 说的是"这次没确认成"，`unverified` 说得出**为什么**
 *  不能写成"未找到"。预检的文案靠它分流，拒绝本身照旧发生——确认不了的依赖不假装齐。 */
export function checkEnvironment({ nodePath = process.execPath, probe = commandProbe } = {}) {
  const states = {
    npm: probe('npm'),
    swift: probe('swift'),
    git: probe('git'),
    open: probe('open'),
  }
  return {
    nodeMajor: nodeMajorVersion(nodePath),
    nodeOk: nodeMajorVersion(nodePath) >= MIN_NODE_MAJOR,
    npm: states.npm === PROBE_STATES.available,
    swift: states.swift === PROBE_STATES.available,
    git: states.git === PROBE_STATES.available,
    open: states.open === PROBE_STATES.available,
    unverified: Object.entries(states)
      .filter(([, state]) => state === PROBE_STATES.unverified)
      .map(([name]) => name),
  }
}

/**
 * 这台主机能不能装 GlassPane——判据是 node 向主机问来的 `process.platform`，不是 PATH 上
 * 任何一个可以被换掉的程序。
 *
 * 为什么这一条必须住在 cli.js 里：`install.sh` 的 macOS 闸从前只挡"要 clone 的那一趟"，
 * 源码在手边（指定仓库、当前目录、既有 clone）时根本不经过它，而它的注释写着"交给 installer
 * 自己去说平台"——installer 里当时一个字都没有。实测代价（2026-10-22）：把 `uname` 桩成 Linux
 * 再从仓库根跑真装，npm ci、tsc、swift build 与 launchd 注册全部真的发生，HOME 是开发者自己的。
 * 一条依赖机器状态、且会**改**机器状态的"拒绝分支"不是护栏。
 *
 * 纯函数 + 可注入的 platform，为的是这条判据能被测试指到，而不是只在某台 runner 上碰巧走到。
 */
export function platformRefusal(platform = process.platform) {
  if (platform === 'darwin') return null
  return '这个产品只支持 macOS（本机 platform 不是 darwin）：Swift/XCTest、launchd 与 TCC 席位都在 macOS 这一侧。'
    + '本轮没有跑 npm ci、没有 swift build、没有注册 launchd 作业，也没有写进任何应用目录。'
    + '要在别的系统上用 GlassPane，等它把引擎搬到那一侧再说——现在这一步没有可绕的旗标。'
}

/** 汇总预检结果：缺项按严重程度排序返回可读描述（空数组 = 全部通过）。 */
export function preflightIssues(env) {
  const issues = []
  // 每一行都要带上"下一步能跑的动作"：`未找到 npm` 单独一句是把诊断交给读者，而预检失败
  // 时汇总只补一句通用的"修复后重新运行即可"——四行里只有 swift 那条说得出该装什么。
  if (env.nodeMajor === 0) {
    issues.push('无法解析 Node.js 版本（`node --version` 跑不起来）：装一个 >= 18 的 Node（brew install node，或 nvm install --lts 后 nvm use）再重跑')
  } else if (!env.nodeOk) {
    issues.push(`Node.js 需要 >= ${MIN_NODE_MAJOR}，当前为 ${env.nodeMajor}：换够格的 Node 版本再重跑（brew upgrade node 或 nvm use 22）`)
  }
  // "没答话"不等于"没有"。这两句话给的动作不一样（一个是装它，一个是看它卡在哪），
  // 写成一句就是把读者支去 `xcode-select --install` 而机器本来就是好的。
  const absentLine = {
    npm: '未找到 npm（它随 Node 一起装：brew install node）',
    swift: '未找到 swift（需安装 Xcode Command Line Tools：xcode-select --install）',
    git: '未找到 git（xcode-select --install 会带上它，或 brew install git）',
    open: '未找到 open（本安装器面向 macOS：Linux/Windows 上没有可装的东西，请在 macOS 14+ 上重跑）',
  }
  for (const name of ['npm', 'swift', 'git', 'open']) {
    if (env[name]) continue
    if (Array.isArray(env.unverified) && env.unverified.includes(name)) {
      issues.push(`${name} 未能确认：探测命令（\`${name} --version\`）在 ${PROBE_TIMEOUT_MS / 1000}s、补一次的 ${PROBE_RETRY_TIMEOUT_MS / 1000}s 内都没有答话。`
        + `这不是"未安装"——先手动跑 \`${name} --version\` 看它卡在哪；若只是本机负载高，重跑一次安装即可。`)
      continue
    }
    issues.push(absentLine[name])
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

/** `ps` 那一探测的命令面：红字要点名"问的是哪一条命令"，所以命令本身是一个值。 */
export const PS_PROBE_ARGS = Object.freeze(['-Ao', 'pid=,comm='])
export const PS_PROBE_COMMAND = `ps ${PS_PROBE_ARGS.join(' ')}`

/** 按可执行名列出在跑的进程 PID（副作用层：读 `ps`，解析交给纯函数）。
 *
 *  返回 `{state, pids, …}` 而不是裸数组（2026-10-28 缺陷 1）。旧实现写的是
 *  `if (result.status !== 0) return []`——把"ps 没答话"与"ps 答了：一个也没有"压成
 *  同一个值。调用方按"数组为空＝没有在跑的实例"办事，于是既跳过了 `terminatePids`，
 *  也跳过了 `launchdTakeoverAfterTerminate` 那条安全接管，最后在一份陈旧 daemon 可能
 *  仍然占着的 socket 上又起一份手动实例。本文件上方的 `PROBE_STATES`（"没答话"不许说成
 *  "未找到"）已经立了这套词表，同一份文件里不能两套口径：这里复用它的三档，不发明第四种形状。
 *  - `available`  ：ps 退 0，`pids` 就是它的答案（空数组是**读到的零个**，不是没读到）
 *  - `absent`     ：ENOENT，这台机器没有 ps 这个命令
 *  - `unverified` ：ps 起了没答话／非零退出／spawn 抛错——一律是"没读到" */
export function listRunningPids(exeName, { spawn = spawnSync } = {}) {
  let result = null
  let thrown = null
  try {
    result = spawn('ps', [...PS_PROBE_ARGS], { encoding: 'utf8' })
  } catch (error) {
    thrown = error
  }
  const code = thrown?.code ?? result?.error?.code ?? null
  if (thrown || !result || result.status !== 0) {
    return {
      state: code === 'ENOENT' ? PROBE_STATES.absent : PROBE_STATES.unverified,
      pids: [],
      command: PS_PROBE_COMMAND,
      exitCode: thrown ? null : (result ? result.status : null),
      reason: thrown?.message ?? result?.error?.message ?? result?.error?.code ?? null,
    }
  }
  return {
    state: PROBE_STATES.available,
    pids: pidsFromPs(result.stdout, { exeName }),
    command: PS_PROBE_COMMAND,
    exitCode: 0,
    reason: null,
  }
}

/** 探测没答话时那行红字（纯函数）：说的是"没读到"，永远不是"没有在跑的实例"。 */
export function staleProbeUnansweredText(probe, { launchd = true } = {}) {
  const why = probe.state === PROBE_STATES.absent
    ? '这台机器上没有 ps 这个命令'
    : `ps 这一趟没有答话（退出码 ${probe.exitCode === null ? '无（命令没跑成）' : probe.exitCode}`
      + `${probe.reason ? `，${probe.reason}` : ''}）`
  return `旧实例收拢**跳过**：${why}。当时问的是这一条命令：${probe.command}。\n`
    + '这句是"没读到"，不是"没有在跑的实例"——本轮因此**没有**结束任何进程，'
    + (launchd
      ? '改走 launchd 主动接管（kickstart）这条安全兜底，它不依赖读到 PID。'
      : '而本轮没有启用 launchd（--no-launchd），连那条安全兜底也没有：'
        + '若有陈旧 daemon 仍占着 socket，接下来起来的会是一份手动实例。')
    + `\n人工核对：${probe.command} | grep -E '${DAEMON_EXE_NAME}|${PANEL_EXE_NAME}'`
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
  // 同向），真正的兜底闸是收尾那次版本核对。
  return 'gone'
}

/** 这个 pid 是不是**僵尸**（已死、等父进程回收）：`kill -0` 对僵尸回 0，光靠信号探测会把
 *  一个已经不服务 socket 的进程报成"还活着、请你去收尾"。状态读不出来时保守回 false
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
      // 立刻探一次会把它读成"还活着"，于是红字让人去收尾一个已经没了的 pid。
      // 给一次**有界**的再探窗口，只有窗口过后还在的才算幸存者。
      if (sleep) sleep(reprobeMs)
      else spawn('sleep', [String(reprobeMs / 1000)], { encoding: 'utf8' })
      after = state(pid)
      // 还"活着"但状态是 Z = 它已经死了，只差父进程 wait() 收尸：这种东西不持有 socket、
      // 不需要人去做任何收尾动作，报成幸存者就是把人支到一条没用的命令上。
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

/** 幸存者（安装器收不掉的进程）的红字（finding 5，纯函数）。
 *  这里给的必须是**能直接执行**的动作，而不是"请检查权限"；而本产品的红线是：
 *  补救文案一律不发提权命令。发信号这条本来就分两档，两档都如实写出来——
 *  ① 当前账号自己就能做的 `/bin/kill -9 <pid>`（安装器已经试过 TERM 与 KILL，
 *     再报一次只是给人一个能手敲的等价动作，它不越权）；
 *  ② 它被 EPERM 拒掉 = 这些 pid 不属于当前账号，那一步**只有坐在键盘前的这个人
 *     能做**。这一步归人，不归脚本：本产品保留给真人的就是这种物理动作。
 *  socket 还挂在这些 pid 上，所以本轮的产物从未接管——收尾那次版本核对会把这件
 *  事再钉一次。退出码契约不变（调用方仍按失败说）。 */
export function survivorText(survivors, { socketPath } = {}) {
  const pids = survivors.map((entry) => entry.pid).join(' ')
  return [
    `未能结束既有实例（它仍在服务 ${socketPath ?? 'engine.sock'}）：`
    + survivors.map((entry) => `pid ${entry.pid} — ${entry.reason}`).join('；'),
    `安装器无权向这些进程发信号（它们不属于当前账号，典型是 root 拉起的旧 daemon）。`
    + `上面"已结束"那句只对确实已经不在的 pid 成立，不含这些。`,
    `先试当前账号自己就能做的那条（不提权）：\`/bin/kill -9 ${pids}\`。`
    + `它若仍被拒，就只能由坐在键盘前的人来结束这些进程——本安装器不发放提权命令，`
    + `这一步归人。先看清是谁起的 \`ps -o pid=,user=,lstart=,command= -p ${pids}\`，`
    + `由本人结束它们，然后重跑本安装器并加 --replace-daemon。`,
  ].join('\n')
}

/** 目标已存在、这一轮**真的会覆盖掉**的 bundle 清单（纯函数）。确认门问的就是这份清单，
 *  所以它必须与 installBundles 走的判断是同一份——否则问的是 A、覆盖的是 B。 */
export function bundlesToReplace({ plan, exists = fs.existsSync } = {}) {
  if (!plan?.appsDir) return []
  return [
    [plan.builtSettingsApp, plan.settingsApp],
    [plan.builtDaemonApp, plan.daemonApp],
  ]
    .filter(([source, target]) => source && target && exists(source) && exists(target))
    .map(([, target]) => target)
}

/** 安置一份 bundle 时那条"没落地"的拒绝：说清动到哪一步、旧的一份还在不在、下一步跑什么。
 *  finding C9（2026-10-24）：从前这里只把 `cpSync` 的 errno 原样抛出去——读的人既不知道
 *  旧 bundle 是否还在（旧实现是先 `rm -rf` 再拷，中途失败就是"旧的没了、新的是半棵"），
 *  也没有一句下一步。现在每一种失败各自点名"原件在不在"，并给一条真能跑的命令。 */
export function bundlePlacementFailureText({ source, target, staged, retired, error, step, stagedRemoved = true }) {
  const raw = String(error?.message ?? error)
  const errno = error?.code && !raw.startsWith(String(error.code)) ? `${error.code}: ${raw}` : raw
  const head = `安置 ${target} 失败（来源 ${source}）：${errno}`
  // 命令位上的每一份路径都**就地**走本包自己的 `quoteShellArg`（2026-10-31：这里原来是一个
  // `const dir = JSON.stringify(...)` 与一个 `q = (p) => JSON.stringify(p)`——那是双引号，
  // `$(` 与反引号在双引号里照常展开，"照着这条命令修磁盘"就变成"照着目录名执行"。判据在
  // `installer/test/shell-quoting.test.mjs` 的行为半边与
  // `mcp-shell/test/remedy-shell-quoting.test.mjs` 的参数位扫描里；扫描按**名字**放行，所以
  // 这里不保留 `dir`/`q` 这类别名：一个别名就是一次让闸看不见这处调用的改写。）
  if (step === 'copy' || step === 'retire') {
    return `${head}\n`
      + `新的一份只走到暂存位置就断了，原件还在原位——${target} 仍是上一轮那份**完整**的 bundle，`
      + `本轮没有任何一步动过它的内容。下一步：空间不够看 \`df -h ${quoteShellArg(path.dirname(target))}\`，权限/旗标看 `
      + `\`ls -ld ${quoteShellArg(path.dirname(target))}\` 与 \`ls -lO ${quoteShellArg(target)}\`（macOS 的 immutable 旗标 uchg 会让改名与覆盖都失败），`
      + `腾出来或修好之后重跑 install.sh。`
      + (stagedRemoved
        ? `本轮的暂存副本 ${staged} 已删，不需要手工清理。`
        : `本轮的暂存副本 ${staged} 没能删掉（同一个错误也挡住了它），重跑前手工 \`rm -rf ${quoteShellArg(staged)}\` 即可。`)
  }
  if (step === 'restore') {
    return `${head}\n`
      + `这一步之后本机已经没有 ${target} 了：新的一份在 ${staged}，上一轮那份完整的备份在 ${retired}，`
      + `而把它们放回原位的改名也被同一个错误挡住。这一步归人（安装器不发放提权命令）：`
      + `先 \`mv ${quoteShellArg(retired)} ${quoteShellArg(target)}\` 把旧的一份放回原位，`
      + `或 \`mv ${quoteShellArg(staged)} ${quoteShellArg(target)}\` 用本轮新的一份；`
      + `两个都跑不通就是 ${path.dirname(target)} 的权限问题，看 \`ls -ld ${quoteShellArg(path.dirname(target))}\`，修好后重跑 install.sh。`
  }
  // step === 'place'：新的一份没能落位，旧的一份已经被挪回原位——机器上此刻仍是完整的一版。
  return `${head}\n`
    + `${target} 已经放回上一轮那一份（先把备份 ${retired} 挪回原位再报错），本轮新的一份留在 ${staged}——`
    + `本机现在不是"半棵"，是旧的那版在位。下一步：\`ls -ld ${quoteShellArg(path.dirname(target))}\` 看这个目录当前账号能不能写`
    + `（EACCES 通常是目录属主不是您，或这卷不保存权限位），修好后重跑 install.sh；`
    + `两处残留 ${staged} 与 ${retired} 想清就 \`rm -rf\`，留着也不影响下一轮。`
}

/** 把 make-app.sh 的两个 bundle 安置到 ~/Applications（覆盖式，幂等）。
 *  返回 `{ installed, declined, leftovers }`（finding 11）：
 *  - `installed` = 本轮真的写进去的条目；
 *  - `declined` = 目标**已存在**而 `allowReplace=false`（人回答 n，或非交互环境没给
 *    `--no-prompt`）因此没有覆盖的条目——留着的是上一轮的旧 bundle，daemon 启动路径
 *    会照旧选中它。这不是"无所谓"的分支：收尾那次版本核对正是靠它拦住"装了新版、
 *    跑的还是旧版"。
 *  - `leftovers` = 没能删干净的暂存/备份目录（磁盘动作失败不影响安置结论，但要如实报出来）。
 *  源缺失即跳过（--no-app 或构建产物不全时不报错）。
 *
 *  finding C9（2026-10-24）的**顺序**就是修复本身。从前是 `remove(target)` → `copy(source,
 *  target)`：`cpSync` 在中途 ENOSPC/EACCES 就留下"旧的没了、新的是半棵"——一个既不能跑也
 *  没法回滚的目录，而报错只有 errno。现在四步，每一步失败时机器上的 bundle 都是完整的：
 *   1. 新的一份整体拷到 `${target}.tmp-<token>`（旧目标还好好在原位）；
 *   2. 旧的一份**改名**到 `${target}.old-<token>`（不是删除，所以随时能放回原位）；
 *   3. 把暂存的一份**改名**到目标——同目录内的 rename 是原子的，目标要么整个是旧的、
 *      要么整个是新的，"半棵"这一档压根不存在；
 *   4. 删掉备份位（这一步失败只是留个残骸，进 `leftovers`，不算安置失败）。
 *  第 2/3 步抛出时先把旧的一份放回原位，再带着"动到哪一步 + 原件在不在 + 下一步跑什么"报出去。 */
export function installBundles({
  plan,
  exists = fs.existsSync,
  remove = fs.rmSync,
  copy = fs.cpSync,
  mkdir = fs.mkdirSync,
  rename = fs.renameSync,
  token = `${process.pid}-${Date.now().toString(36)}`,
  allowReplace = true,
} = {}) {
  const installed = []
  const declined = []
  const leftovers = []
  if (!plan?.appsDir) return { installed, declined, leftovers }
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
    const staged = `${target}.tmp-${token}`
    const retired = `${target}.old-${token}`
    let step = 'copy'
    let stagedRemovalFailed = false
    try {
      // 上一轮被打断留下的同名暂存位先清掉，否则本轮的拷贝会落在一棵半截树上面。
      if (exists(staged)) remove(staged, { recursive: true, force: true })
      copy(source, staged, { recursive: true })
      if (exists(target)) {
        step = 'retire'
        rename(target, retired)
      }
      step = 'place'
      rename(staged, target)
      step = 'cleanup'
      try {
        remove(retired, { recursive: true, force: true })
      } catch {
        leftovers.push(retired)
      }
      installed.push(target)
    } catch (error) {
      if (step === 'place' || step === 'retire') {
        // 目标此刻是空的（旧的挪走了、新的没落位）——把旧的一份放回原位。
        try {
          if (exists(retired) && !exists(target)) rename(retired, target)
        } catch (restoreError) {
          throw new Error(bundlePlacementFailureText({
            source, target, staged, retired, error: restoreError, step: 'restore',
          }), { cause: restoreError })
        }
      } else {
        try {
          remove(staged, { recursive: true, force: true })
        } catch {
          leftovers.push(staged)
          stagedRemovalFailed = true
        }
      }
      throw new Error(bundlePlacementFailureText({
        source, target, staged, retired, error, step, stagedRemoved: !stagedRemovalFailed,
      }), { cause: error })
    }
  }
  return { installed, declined, leftovers }
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

/** 当前 uid 的**唯一**读法（四处调用点共用：launchdReregisterProbe、launchctlBootstrap、
 *  launchctlKickstart、install() 里收拢旧实例后的 launchd 接管）。
 *
 *  为什么要单独抽出来：`spawnSync('id', ['-u'])` 在**起不来**时给的是
 *  `{ error, status: null, stdout: undefined }`，而那三处从前写的都是
 *  `.stdout.trim()`——TypeError 不是拒绝：它把紧跟其后那句"无法解析当前 uid（id -u 失败）…"
 *  的补救话连同整条命令的退出码一起吞掉，屏幕上只剩一个未捕获异常的栈。判据（"读不到
 *  就不猜 uid"）一直是对的，可达性没了；只有 launchdReregisterProbe 一处早写了 `?? ""`。
 *  这里统一成带保护的读法，并把失败原因带出来，供调用点拼那句可执行的补救。 */
export function readCurrentUid({ spawn = spawnSync } = {}) {
  const probe = spawn('id', ['-u'], { encoding: 'utf8' })
  const uid = String(probe?.stdout ?? '').trim()
  const reason = probe?.error?.message
    ?? (probe?.signal ? `被信号 ${probe.signal} 终止` : null)
    ?? (uid ? null : '没有给出可解析的 uid')
  return { uid: uid || null, reason }
}

/** uid 读不出来时那句拒绝的**共同骨架**：说清哪一步没做、为什么本轮什么都没改、下一步跑什么。 */
function uidUnresolvedText({ action, label, reason }) {
  return `无法解析当前 uid（id -u 失败：${reason ?? '没有输出'}）：launchd 的席位是 gui/<uid>/${label} 这个域，`
    + `uid 拼不出来就${action}不了 ${label}——本轮**没有**动 launchd，什么都没改。`
    + '补救：先让 `/usr/bin/id -u` 在本机能跑出一个数字（`ls -l /usr/bin/id` 看它在不在，'
    + '缺了就 `xcode-select --install` 修 Command Line Tools），再在自己的登录 shell 里重跑本命令；'
    + '不要用 `sudo -u 某用户` / `env -u …` 这类形态起安装器。'
}

/** 只读探一次"重注册会不会动到在跑的东西"（纯函数，供确认门用）。
 *  确认必须发生在**写盘之前**：先写 plist 再问，人回答"跳过"之后磁盘上是新定义、
 *  launchd 里还是旧定义，而 `bootoutDeclined` 那句"什么都没改"会当场变成假话。 */
export function launchdReregisterProbe(desiredProgram, { label = LAUNCHD_LABEL, spawn = spawnSync } = {}) {
  const uid = readCurrentUid({ spawn }).uid ?? ''
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
 *  `desiredProgram` 缺失时**自己从 plist 读**：调用方之一是 `--restore-launchd`，它手里只有
 *  plist 路径，而它偏偏是安装器交给 agent 的"daemon 不可达"补救命令。以前不传就等于跟 ''
 *  比，任何已加载作业都被判成"定义变了"→ bootout 一个健康作业（打断正在跑的 act）。 */
export function launchctlBootstrap(label, plistPath, {
  desiredProgram = null,
  spawn = spawnSync,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  allowBootout = true,
} = {}) {
  const uidProbe = readCurrentUid({ spawn })
  if (!uidProbe.uid) {
    return {
      ok: false,
      already: false,
      uidUnresolved: true,
      message: uidUnresolvedText({ action: '注册', label, reason: uidProbe.reason }),
    }
  }
  const uid = uidProbe.uid
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
      // 没拿到确认就一个字节都不动：不写新 plist、不 bootout、不 bootstrap。
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
export function launchctlKickstart(label, { spawn = spawnSync } = {}) {
  const uidProbe = readCurrentUid({ spawn })
  if (!uidProbe.uid) {
    return {
      ok: false,
      uidUnresolved: true,
      message: uidUnresolvedText({ action: '重启', label, reason: uidProbe.reason }),
    }
  }
  const uid = uidProbe.uid
  const kick = spawn('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { encoding: 'utf8' })
  const stderr = (kick.stderr ?? '').trim()
  if (kick.status === 0) {
    return { ok: true, message: `launchd 已重启作业（gui/${uid}/${label}）` }
  }
  return { ok: false, message: stderr || `launchctl kickstart 失败，退出码 ${kick.status}` }
}

/** 收拢旧实例后让 launchd 按新配置接管（kickstart -k）+ 有界等 socket。
 *
 *  为什么 TERM 之后还要主动 kickstart：daemon 的 SIGTERM 收尾是 clean exit 0，而 plist 里
 *  KeepAlive 用的是 SuccessfulExit=false——按那个语义 launchd 本就不该复活它。不接管就退化
 *  成"手动实例持有 socket"，开机自启那份配置形同虚设。
 *
 *  uid 读不出来这一支必须**说出来**：它从前是 `if (runUid) {...}` 的静默跳过（而它上面那句
 *  `.stdout.trim()` 在 `id` 起不来时直接抛 TypeError——同一个缺陷的两种表现），跳过之后
 *  安装器会自己启动一份手动实例，屏幕上却没有一句"launchd 这次没接管"，读者会以为开机自启
 *  已经按新配置在跑。返回 `{relaunched, uid, message}`，`uid === null` 就是那一次没做成。 */
export async function launchdTakeoverAfterTerminate({
  label = LAUNCHD_LABEL,
  socketPath,
  spawn = spawnSync,
  waitFn = waitForSocket,
} = {}) {
  const uidProbe = readCurrentUid({ spawn })
  if (!uidProbe.uid) {
    return { relaunched: false, uid: null, message: uidUnresolvedText({ action: '重启', label, reason: uidProbe.reason }) }
  }
  spawn('launchctl', launchdKickstartArgs({ label, uid: uidProbe.uid }))
  const relaunched = await waitFn(socketPath)
  return {
    relaunched,
    uid: uidProbe.uid,
    message: relaunched
      ? 'launchd 已按新配置接管 daemon（kickstart）'
      : 'launchd 未在时限内接管，改由安装器直接启动',
  }
}

/** 收拢旧实例这一步（原样埋在 install() 的 if 里，没有一条测试能指到它）。
 *
 *  为什么要抽出来：`listRunningPids` 从前返回裸数组，非零退出也是 `[]`，于是这里的
 *  `staleDaemons.length > 0 || stalePanels.length > 0` 把"ps 没答话"读成"没有在跑的实例"，
 *  **同时**跳过了 `terminatePids` 与 `launchdTakeoverAfterTerminate` 那条安全接管。
 *  现在探测回三档：没答话时既不声称"没有实例"，也照走 kickstart（它不需要 PID），
 *  并且把"收拢被跳过"用红字说给人听。`spawn`/`report`/`confirm`/`terminate`/`takeoverFn`/
 *  `waitFn` 全是测试接缝——这一段判据只能由假探测跑出来，真机上永远只有一半天数。
 */
export async function collectStaleInstances({
  spawn = spawnSync,
  replaceDaemon = false,
  launchd = true,
  autoYes = false,
  socketPath = null,
  report = (text, color = null) => printStep(color ? paint(text, color) : text),
  confirm: askPerson = confirm,
  terminate = terminatePids,
  takeoverFn = launchdTakeoverAfterTerminate,
  waitFn = waitForSocket,
  terminateOptions = {},
  exeNames = { daemon: DAEMON_EXE_NAME, panel: PANEL_EXE_NAME },
} = {}) {
  const daemonProbe = listRunningPids(exeNames.daemon, { spawn })
  const panelProbe = listRunningPids(exeNames.panel, { spawn })
  const unanswered = [daemonProbe, panelProbe].filter((probe) => probe.state !== PROBE_STATES.available)
  const staleDaemons = daemonProbe.pids
  const stalePanels = panelProbe.pids
  let relaunchedByLaunchd = false
  let takeoverRan = false
  const runTakeover = async () => {
    if (!launchd || takeoverRan) return
    takeoverRan = true
    const got = await takeoverFn({ socketPath, spawn, waitFn })
    if (got.uid === null) {
      report(got.message, 'red')
    } else {
      relaunchedByLaunchd = got.relaunched
      report(got.message)
    }
  }

  if (unanswered.length > 0) {
    for (const probe of unanswered) report(staleProbeUnansweredText(probe, { launchd }), 'red')
    await runTakeover()
    return {
      probeAnswered: false,
      unanswered: unanswered.map((probe) => probe.state),
      staleDaemons,
      stalePanels,
      terminated: null,
      takeoverRan,
      relaunchedByLaunchd,
    }
  }

  let terminated = null
  if (staleDaemons.length > 0 || stalePanels.length > 0) {
    const summary = `daemon ${staleDaemons.join(',') || '无'}｜面板 ${stalePanels.join(',') || '无'}`
    if (replaceDaemon) {
      // finding 12：结束在跑的实例是第三件破坏性动作（它会打断正在进行的 act，
      // 而 daemon 侧的 SIGTERM 收尾是"清理 socket 后退出"）。`--no-prompt` 放行、
      // 交互终端问一句、非交互且没给 flag 则不动别人的进程。
      const mayTerminate = await askPerson(
        `将结束已在跑的实例（${summary}），其间正在执行的 act 会被打断`,
        { autoYes },
      )
      if (!mayTerminate) {
        report('未确认：没有结束任何在跑的实例（脚本场景请加 --no-prompt）', 'yellow')
      } else {
        terminated = terminate([...staleDaemons, ...stalePanels], { spawn, ...terminateOptions })
        report(
          terminated.forced.length > 0
            ? `既有实例已收拢（SIGTERM 未生效、已强杀：${terminated.forced.join(', ')}）`
            : `已结束既有实例：${terminated.terminated.join(', ')}`,
        )
        // finding 5：`terminated`/`forced` 只覆盖确实已经不在了的 pid。安装器发不动
        // 信号的进程（root 拉起的旧 daemon）必须单独用红字点名——它还在服务同一个
        // socket，"已收拢"那句话对它不成立。
        if (terminated.survivors.length > 0) {
          for (const line of survivorText(terminated.survivors, { socketPath }).split('\n')) {
            report(line, 'red')
          }
        }
        // 收拢旧实例后主动让 launchd 接管：TERM 现在是 clean exit 0，KeepAlive
        // (SuccessfulExit=false) 语义下 launchd 不会自动复活，必须 kickstart。
        // 不这么做就会退化成"手动实例持有 socket"，开机自启那份配置形同虚设。
        // uid 读不出来时**红字说出来**（判据与句子见 launchdTakeoverAfterTerminate），
        // 静默跳过会让读者以为开机自启已经按新配置在跑。
        if (staleDaemons.length > 0) await runTakeover()
      }
    } else {
      report(
        `检测到旧实例在跑（${summary}）：多实例会让系统设置里的授权条目与实际服务实例对不上；`
        + '加 --replace-daemon 可一并收拢',
        'yellow',
      )
    }
  }
  return {
    probeAnswered: true,
    unanswered: [],
    staleDaemons,
    stalePanels,
    terminated,
    takeoverRan,
    relaunchedByLaunchd,
  }
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
 *
 * finding C3（2026-10-24）：上面那条"作业已加载但定义变了"的路要 **bootout** 一个
 * 已加载作业，而 install() 对同一个动作是有 `confirm` 门的（autoYes 只由 `--no-prompt`
 * 决定）。本命令从前调 `bootstrapFn(label, resolvedPlist)` 时不传 `allowBootout`，默认
 * true ——于是 `--restore-launchd`（产品交给 agent 的"daemon 不可达"补救命令，
 * `mcp-shell/src/tools.ts` 甚至专门叮嘱过"这一步别重启东西，在飞的 act 会被打断"）
 * 可以在用户应用正在 act 中途卸掉一个健康作业且一句不问。现在复用同一道门：
 * 先按"不许 bootout"探一次（`launchctlBootstrap` 的 `bootoutDeclined` 那一支就是为此
 * 存在的只读答案，一次 launchctl 都不多写），真需要 bootout 才问；非交互且没给
 * `--no-prompt` 就回拒，且磁盘与 launchd 都没被动过。
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
  confirmFn = confirm,
  autoYes = false,
  serveTimeoutMs = 10000,
} = {}) {
  // finding 4：这条路径也是拿 HOME 拼出来的（旧代码在参数默认值里读
  // `process.env.HOME ?? ''`，HOME 缺失时它变成 `Library/LaunchAgents/…` 这种相对位置，
  // 然后照实去 bootstrap 一个 StandardOutPath 是相对路径的作业）。显式传了
  // plistPath/socketPath 的调用方（单测、以及任何知道自己要修哪个文件的人）不受这条闸影响。
  const paths = installGuard({ home: env.HOME ?? '', uid })
  const resolvedPlist = plistPath ?? (paths.ok ? path.join(paths.home, ...LAUNCHD_DIR_NAME.split('/'), LAUNCHD_FILE_NAME) : null)
  const resolvedSocket = socketPath ?? (paths.ok ? path.join(paths.home, SOCKET_DIR_NAME, SOCKET_FILE_NAME) : null)
  if (!resolvedPlist || !resolvedSocket) {
    return {
      ok: false,
      action: 'bad-home',
      verified: null,
      message: paths.error ?? '无法确定 plist/socket 路径（HOME 不可用且未显式传入）',
    }
  }
  if (!existsFn(resolvedPlist)) {
    return {
      ok: false,
      action: 'missing-plist',
      message: `launchd plist 不存在（${resolvedPlist}）：从未安装或已被删除，请重跑 install.sh 完整安装`,
    }
  }
  // 第一趟一律按"不许 bootout"问：需要卸掉已加载作业时它回 `bootoutDeclined` 且一个字节
  // 都不动，这就是"要不要问人"的那个只读答案；不需要 bootout 的常规路径（未加载 →
  // bootstrap，或已加载且定义一致 → already）照旧一次问都不问。
  let boot = bootstrapFn(label, resolvedPlist, { allowBootout: false })
  let bootoutDeclined = false
  if (boot.ok !== true && boot.bootoutDeclined === true) {
    const allowBootout = await confirmFn(
      `${label} 已加载且跑的是旧定义，而 ${resolvedPlist} 写的是另一份——卸载它才能换新定义，`
      + '这会打断 daemon 正在替用户执行的 act',
      { autoYes },
    )
    if (allowBootout) {
      boot = bootstrapFn(label, resolvedPlist, { allowBootout: true })
    } else {
      bootoutDeclined = true
    }
  }
  if (!boot.ok) {
    if (bootoutDeclined) {
      return {
        ok: false,
        action: 'bootout-declined',
        verified: null,
        message: `没有卸载已加载的 ${label}（本轮未获得确认），因此也没有 bootstrap——launchd 与磁盘都没被动过，什么都没改。`
          + `现况：${boot.message}\n`
          + '下一步（三选一，没有一项会静动别人的作业）：① 在自己的交互终端里重跑 '
          + 'node installer/cli.js --restore-launchd 并回答继续；'
          + '② 脚本/自动化里显式带上放行旗标：node installer/cli.js --restore-launchd --no-prompt'
          + '（带上就等于允许这一步 bootout 已加载的作业）；'
          + `③ 不想换新定义就什么都不用做——launchd 仍在按它手里那份旧定义服务，${resolvedPlist} 也没被改写。`,
      }
    }
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
  if (status === 0) {
    return { status: 'verified', detail: '发布 tag 的 GPG 签名有效，出自发布者私钥' }
  }
  if (/no signature found/i.test(text)) {
    return { status: 'unsigned', detail: '该发布 tag 未做 GPG 签名（不是内容被篡改，只是缺签名层）' }
  }
  return { status: 'invalid', detail: `git verify-tag 失败（退出码 ${status}），签名无法确证` }
}

/**
 * 验签结论怎么落成安装动作。四种结局各说各话：
 *  - `verified`   绿字继续；
 *  - `unsigned`   黄字继续——tag 里**确实**没有签名层，缺的是来源证明的增量：
 *    被验的 tag 与装进构建的源码是同一个 ref，HTTPS + tag 钉版本已经保证内容完整；
 *  - `unavailable` **拒绝**（2026-10-28 缺陷 2）。这一档从前与 `unsigned` 合流，可它
 *    说的根本不是"这个 tag 没签名"——是"这道验签在本机没跑成"（没有 gpg / 导入内置
 *    公钥失败 / 验签自己抛错）。把"没跑成的检查"讲成"检查过了、答案是没签名"，等于
 *    让人以为有一道门把过关。自动更新那面对它是 `signature-tool-missing`，与
 *    `invalid` 分列两档，且**没有**人类同意就不放行（updater/lib/signature.js 的
 *    `signature-tool-missing` 那句）；本文件的注释从前把这条跨渠道不对称点名成缺陷，
 *    上一轮只把 `invalid` 并了进来，`unavailable` 还留在放行那一支。
 *    放行只走显式旗标 `--accept-unverified-signature`（对应 updater 的
 *    `--consent unsigned-release`），放行后仍要如实打出"这一版是缺验签结论装上的"；
 *  - `invalid`    签名在、验不过，那说的不是"缺证明"而是"这份字节不是发布者签过的
 *    那一份"，必须**停下**，且任何旗标都不覆盖。
 * 判据放在纯函数里：这一段从前埋在 main() 的 if 里，没有一条测试能指到它。
 */
export function tagVerifyDecision({ sig, pinRef, repoDir, acceptUnverified = false }) {
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
  if (sig.status === 'unavailable') {
    // 这道检查**没跑成**，不是跑成了且答案是"没签名"。默认拒装：不给"没人验过"这件事
    // 放行，就不许往下跑 npm install、swift build 与 launchd 注册。
    if (!acceptUnverified) {
      return {
        action: 'refuse',
        text: `发布 tag ${pinRef} 的 GPG 验签**没有跑成**（${sig.status}：${sig.detail}）。\n`
          + '这一档说的不是"这个 tag 没签名"，而是"这道检查在本机没做成"——这台机器现在对'
          + `${pinRef} 的作者身份一无所知。安装到此为止：没有跑 npm install，没有 swift build，`
          + '没有注册 launchd 作业。\n'
          + `内置公钥：key ${GLASSPANE_SIGNING_KEY_ID}（uid ${GLASSPANE_SIGNING_KEY_UID}），`
          + '就是本文件里那份 GLASSPANE_SIGNING_PUBLIC_KEY。\n'
          + `下一步（先自己把这道检查跑一遍，看清缺的是哪一样）：`
          + `gpg --version；git -C "${repoDir}" rev-parse --verify refs/tags/${pinRef}；`
          + `git -C "${repoDir}" tag -v ${pinRef}\n`
          + '确实在没有 gpg 的机器上要装，就修好工具链再重跑（`brew install gnupg` 或 `xcode-select --install`）；'
          + '理解风险、决定就在这一档缺结论的情况下继续，才显式带上放行旗标重跑：\n'
          + `  node installer/cli.js --repo ${quoteShellArg(repoDir)} --accept-unverified-signature\n`
          + `  curl -fsSL ${INSTALL_SH_URL} | sh -s -- --accept-unverified-signature\n`
          + '它与 updater 的 `--consent unsigned-release` 同一形态：只批"缺证明"，'
          + '签名存在而验不过（invalid）永不被它覆盖；`--no-prompt` 也不是这里说的同意。',
      }
    }
    return {
      action: 'warn',
      text: `发布 tag ${pinRef} 的 GPG 验签没有跑成（${sig.status}：${sig.detail}），`
        + '本轮由 --accept-unverified-signature 显式放行：这一版是在**没有验签结论**的情况下装上的，'
        + '不是"验签通过"，也不是"确认它没签名"。',
    }
  }
  if (sig.status === 'unsigned') {
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

/**
 * 要构建的这棵树，是不是被验签的那个 tag 本身（IO 探测，纯判定）。
 *
 * 存在的理由：`rootDir` 可以来自 `--repo`、`GLASSPANE_REPO`、当前目录或既有 clone，而
 * `install.sh` 自己就写着"既有 clone 不会被自动切到 $REF"。那条绿字说的若是
 * "签名验证通过"，它证明的却只是 *tag 对象* 的签名——签的不是 HEAD 加一堆本地改动。
 * 签名与产物之间这层对应关系一旦断，绿字就成了对没签过的字节作保。
 */
export function tagTreeAgreement({ repoDir, ref, spawn = spawnSync } = {}) {
  const head = spawn('git', ['-C', repoDir, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' })
  const tagged = spawn('git', ['-C', repoDir, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' })
  if (head.status !== 0 || tagged.status !== 0) {
    return { ok: false, same: false, changed: null, head: null, tagCommit: null }
  }
  const work = spawn('git', ['-C', repoDir, 'status', '--porcelain'], { encoding: 'utf8' })
  const changed = String(work.stdout ?? '').split('\n').filter((line) => line !== '').length
  const headSha = String(head.stdout ?? '').trim()
  const tagSha = String(tagged.stdout ?? '').trim()
  return { ok: true, same: headSha === tagSha && changed === 0, changed, head: headSha, tagCommit: tagSha }
}

/**
 * "签名有效" 与 "要装的就是被签的那棵树" 是两件事，绿字必须两件事都说得出。
 * 树对不上时不拒装（装开发主线本来就合法），但绝不能沿用那句"验证通过"。
 */
export function tagVerifyAgainstTree({ verdict, tree, pinRef, repoDir }) {
  if (verdict.action !== 'pass') return verdict
  if (tree.ok && tree.same) return verdict
  const why = !tree.ok
    ? '读不出这棵树的 HEAD 与该 tag 指向的 commit'
    : `HEAD 是 ${String(tree.head ?? '').slice(0, 7)}，tag 指向 ${String(tree.tagCommit ?? '').slice(0, 7)}，另有 ${tree.changed} 处未提交改动`
  return {
    action: 'warn',
    text: `发布 tag ${pinRef} 的 GPG 签名有效，但它签的不是本次要装的这棵树：${why}。\n`
      + '安装继续，装出来的是这棵树的内容，不是那个已签名发布的内容——这句不说清楚，屏幕上那行绿字就是替没验过的字节作保。\n'
      + `下一步（要装被签的那一版）：git -C "${repoDir}" checkout ${pinRef} 后重跑，或用一键安装脚本从发布 tag 另起一份：`
      + `curl -fsSL ${INSTALL_SH_URL} | sh`,
  }
}

/** 对 clone 下来的发布 tag 做 GPG 验签（探测本身 best-effort，不抛错）。
 *  隔离 GNUPGHOME 并临时导入发布公钥，`git verify-tag` 只看退出码与 stderr；不动
 *  用户钥匙环、无网络依赖。返回 classifyTagVerify 的口径（verified/unsigned/invalid/
 *  unavailable）。这里只负责**读出哪一档**；落成什么动作由 `tagVerifyDecision` 判——
 *  `unavailable`（检查没跑成）默认拒装，不再与"这个 tag 没签名"合流放行。 */
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
  // 「每日几点」这句实话的唯一来源，是 updater 从**在册作业**里读回来的那个 interval
  // （`outcome.agentSchedule`，2026-10-27 finding C4）。从前这里直接拼 `launchd.DEFAULT_*` 那两个常量：
  // 装过 `updater enable --hour 3` 的机器被重装之后，作业照旧 3:00 跑（`enable` 故意保住在册时刻，
  // updater/cli.js:583），而安装日志与 nextSteps 交给读者的那句却写成"每日 12:00"——一个默认值
  // 冒充了一次实测，而面板与 gp_diagnose 的读者信的那句就是这个。读不回来时不猜，改口说清。
  const held = outcome.agentSchedule ?? null
  const scheduleMeasured = !!held && Number.isInteger(held.hour) && Number.isInteger(held.minute)
  const defaultSchedule = `${launchd.DEFAULT_HOUR}:${String(launchd.DEFAULT_MINUTE).padStart(2, '0')}`
  const schedule = scheduleMeasured ? `${held.hour}:${String(held.minute).padStart(2, '0')}` : defaultSchedule
  const summary = {
    ok: true,
    registered,
    state: registered ? 'registered' : 'off',
    reason: switchedOffByEnv ? 'env' : (autoUpdate ? null : 'flag'),
    agentLabel,
    schedule,
    // 「这个数是读回来的还是默认值」本身要成为数据：只把 schedule 交给读者的话，两种来源在下游
    // 长成同一个样子，而这两种说法对人是完全不同的。
    scheduleMeasured,
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
    say(`每日自动更新已注册（${agentLabel}，${summary.scheduleMeasured ? `在册作业跑在 ${schedule}` : `默认 ${schedule}——这一档没能从在册作业读回实际时刻，所以下一句是默认值而不是实测`}，状态根 ${stateRoot}；指针 ${written.path}）——一键关：node ${quoteShellArg(tree.cli)} disable`)
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
      say(paint(`注意：这份 updater 没有回报根证书束的导出结果（旧版本）；若本机 HTTPS 被中间人替换，每日检查会在第一道校验上失败，跑 node ${quoteShellArg(tree.cli)} enable 可重新导出。`, 'yellow'))
    }
  } else {
    say(
      `自动更新已关闭（${switchedOffByEnv ? 'updater 报环境变量已关，见下面它自己的原话' : '--no-auto-update'}）：`
      + `${agentLabel} 未注册/已卸载，状态里记 disabled=true——面板显示"自动更新已关闭（上次检查 …）"而不是"从未检查"。`
      + `手动 node ${quoteShellArg(tree.cli)} check / apply 仍可用；重开：node ${quoteShellArg(tree.cli)} enable。`
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
      ? `   ⚠ 这份 updater 没有回报 node 要用的系统根证书束（旧版本）；本机 HTTPS 若被中间人替换，每日检查会在第一道校验上失败。补上：node ${quoteShellArg(update.updaterCli)} enable。`
      : ca.status === 'ok'
        ? `   node 用本机导出的系统根证书束 ${ca.certs} 张（${ca.path}，已写进作业的 NODE_EXTRA_CA_CERTS）。`
        : `   ⚠ 本机没能导出 node 要用的系统根证书束（${ca.status}）；HTTPS 被中间人替换的机器上，每日检查会在第一道校验上失败，`
          + '面板与 gp_diagnose 会一直显示这句话，修复办法是它给的那条。'
    return [
      `6. 自动更新：默认开。launchd 每日 ${update.schedule}${update.scheduleMeasured ? '' : '（默认值——在册作业没读回实际时刻，这一句不是实测）'} 跑 "${update.updaterCli}" check && apply`,
      `   （作业 ${update.agentLabel}，RunAtLoad=false，日志 ${update.stateRoot}/update.log）；`,
      '   只在 daemon 空闲应答探针、且候选发布版的八道校验全部通过时才换版，major 永远等人点按钮。',
      ...(caLine ? [caLine] : []),
      `   一键关：node ${quoteShellArg(update.updaterCli)} disable（卸该作业 + 状态记 disabled=true）；重开：enable。`,
      `   卸载本机安装时：bootout daemon 作业的同时**也必须** bootout ${update.agentLabel} 并删它的 plist。`,
    ]
  }
  return [
    `6. 自动更新：已关闭（${update.reason === 'env' ? 'updater 判定环境变量为关，安装器没有第二套解读' : '--no-auto-update'}）。`,
    `   ${update.agentLabel} 未注册，状态记 disabled=true：面板显示"自动更新已关闭（上次检查 …）"，`,
    '   不会静默消失；手动检查/安装仍是同一条 CLI（面板上那两个按钮也是它）。',
    `   重开：node ${quoteShellArg(update.updaterCli)} enable${update.reason === 'env' ? '（先把那个环境变量去掉，否则 updater 会拒绝注册）' : ''}。`,
    `   它也负责卸载：bootout ${update.agentLabel} + 删 ~/Library/LaunchAgents 下那份 plist。`,
  ]
}

// ---------------------------------------------------------------------------
// 执行层
// ---------------------------------------------------------------------------

/** 装之前"这一次到底验没验签"的门（纯函数，可单测）。
 *
 *  从前这里是 `pinRef !== 'main' && repoHasRef(...)` 一条静默的 `&&`：条件不满足时整块被
 *  跳过、安装照旧跑完，而输出里没有一句"没验过"。`--repo <本地目录>` 与 `GLASSPANE_REF=main`
 *  都是文档里在用的路径，那些树本来就没有发布 tag 可验——所以这里**不拒**（拒会把受支持的
 *  离线/开发安装打断），但必须把"没验签"这件事说出来：担保没生效时，屏幕不能装作担保生效。
 *
 *  唯一真拒的是形状不安全的值：它会被原样拼进 `git verify-tag` / `git rev-parse`，以 `-`
 *  开头是选项注入的入口，含空白是 `ext::sh -c …` 那一类。`validateGitRef` 过去只守 clone
 *  那一条路，这里是第二条入口。 */
export function tagVerifyGate({ pinRef, hasRef }) {
  const check = validateGitRef(pinRef)
  if (!check.ok) {
    return {
      action: 'refuse',
      text: `GLASSPANE_REF 形状不安全，安装中止（不是"跳过验签继续装"）：${check.error}`,
    }
  }
  if (pinRef === 'main') {
    return {
      action: 'skip',
      text: '未做 GPG 验签：GLASSPANE_REF=main，分支头没有发布 tag 的签名可验。要装被签的发布物就别设这个环境变量。',
    }
  }
  if (!hasRef) {
    return {
      action: 'skip',
      text: `未做 GPG 验签：这棵树里找不到 ${pinRef}（本地 --repo 或浅取种的树本来就没有那个 tag）。`
        + '本轮安装没有任何签名担保——装的是你交给它的那棵树。',
    }
  }
  return { action: 'verify', text: null }
}

/** 钉住的 tag 那棵树**依赖安装**用哪条命令：仓库里有 `package-lock.json` 就走 `npm ci`。
 *
 * WHY（不是口味问题）。CI 的根 workspace 门（`.github/workflows/ci.yml` 的 install-gate：
 * `npm ci`）、发布作业（`release.yml` 的 `npm ci --no-audit --no-fund`）与 updater 的树守卫
 * 量的都是**提交过的那份 lockfile**——"CI 绿"这句 attest 说的就是那棵树。安装器却跑
 * `npm install`，它会重新解析浮动传递依赖：装出来的 app 依赖树可以与被 attest 的那棵不同，
 * 而屏幕上仍然写着"CI 全绿的发布 tag"。判据放成纯函数是为了可测——这一段从前埋在
 * `install()` 里，没有任何一条测试能指到它（与 `tagVerifyDecision` 同一条理由）。
 * 没有 lockfile 的树（浅 clone 之外的手工目录、老 tag）仍要能装，故保留 `npm install` 退路。 */
export function npmDepsCommand({ hasLockfile = false } = {}) {
  return hasLockfile ? ['ci', '--no-audit', '--no-fund'] : ['install']
}

/** 前台运行命令并透传输出；非零退出码 → reject 携带清晰描述。 */
export function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    // `shell: true` 在任何平台上都是"把 cmd 与 args 拼成一条 shell 命令行"，而这个产品的
    // 一切输入都来自外部（仓库 URL、ref、目录）。它是树里唯一一处 shell:true，而 macOS 上
    // 一个用 `win32` 当条件的开关永远为真地不起作用——留着只会让人以为 Windows 是被支持的
    // 交付面（README 与 install.sh 都写明 macOS）。要真支持 Windows，正确做法是把
    // `npm.cmd` 解析成绝对路径后仍走 argv，而不是打开 shell 解析。
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' })
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

/** 破坏性动作前的确认（finding 11/12）。三档，且**默认不做事**：
 *  - `autoYes`（`--no-prompt`）：显式放行；
 *  - 交互终端：问一句，回车继续、`n` 跳过；
 *  - 非交互又没给 flag：**回 false**，不阻塞、也不"替用户同意"。
 *  旧实现在这里把非 TTY 当成"自动同意"，于是 `curl | sh`（管道里没有终端）替每一条
 *  破坏性动作点了"是"——而 `install.sh` 正是文档里那条命令。现在入口脚本**不代答**：
 *  它在非 TTY 时只说明"这一趟会跳过什么、怎么放行"（`sh -s -- --no-prompt`），放行这件事
 *  是一条写在调用行里的、可被读到的决定，而不是一个藏在脚本里的默认值。
 *  （从前这里写的是"由入口脚本在非 TTY 时显式补 `--no-prompt`（install.sh 的 SILENT）"——
 *  那个代答在 2026-10-20 被废，SILENT 变量也已经由 review-2026-10-09.test.mjs 钉死不许回来。
 *  `interactive`/`ask` 是测试接缝：没有它们这三档只能靠真终端验。） */
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
 *  （见 ensureLogDir）；这里的 mkdirSync 只是给直接调用方与单测留的兜底。
 *
 *  `sleep(settleMs, child)` 的第二个参数：窗口的**长度**由注入的实现决定，所以它需要知道
 *  自己等的是哪个子进程。默认实现按真实时间等 settleMs（产品语义一字未改：有界窗口、
 *  窗口结束后采样一次退出状态）；测试可以注入"子进程一报退出就收窗、最长不超过某个上界"
 *  的那一档——在高负载的机器上，"400ms 内排得上一次 fork + exit"并不是事实，拿它当判据的
 *  控制只在机器空时成立（这类控制会在CI上随机红，也会在真出问题时随机绿）。 */
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
  await sleep(settleMs, child)
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
    '  --repo <目录>      指定项目根目录（默认自动向上查找）。这一枚与 GLASSPANE_REPO 都要先过',
    '                     判据（目录存在 + 目录里同时有 engine/Package.swift 与 mcp-shell/package.json）：',
    '                     不合就当场拒绝，且拒在任何写入之前——从前它只测"目录在不在"，于是',
    '                     一个存在的非仓库目录会被当成项目根去跑 npm install（2026-10-31 修）',
    '  --no-prompt        跳过破坏性步骤的确认（脚本/自动化场景）。被它拦住的是三件：',
    '                     ① bootout 已加载的 launchd daemon 作业（会打断正在跑的 act；',
    '                     install 与 --restore-launchd 走的是同一道门）；',
    '                     ② 覆盖 ~/Applications 里已存在的 .app；③ --replace-daemon 结束',
    '                     已在跑的实例。交互终端会逐条问；非交互（stdin 不是终端）**且没给**本 flag 时',
    '                     这三步一律不执行（不阻塞等待、也不默认同意）并打印说明——',
    '                     所以 CI / e2e / `curl | sh` 这类调用必须显式带 --no-prompt。',
    '                     入口脚本 install.sh 不代答：stdin 不是终端时它只说明这一趟会跳过',
    '                     什么、怎么放行，把决定留给敲命令的人。',
    '  --no-daemon        不启动 glasspaned',
    '  --replace-daemon   先结束已在跑的 glasspaned 实例（旧构建的 daemon 会继续占',
    '                     socket，让系统设置里的授权条目与实际服务实例对不上）',
    '  --no-gui           不打开 glasspane-settings GUI',
    '  --no-app           不打包/安置 .app（仅裸二进制产物；权限条目将只显示文件',
    '                     名且无图标，系统设置的列表里只能按文件名认 daemon；去掉本 flag 重跑安装',
    '                     可拿回带图标的条目）',
    '  --no-launchd       不注册开机自启（launchd bootstrap）',
    '  --no-auto-update   不注册每日自动更新代理：卸载该代理并在',
    '                     状态里记 disabled=true，面板显示"自动更新已关闭"而不是"从未',
    '                     检查"；手动 check/apply 仍可用。等价的环境开关由 updater 自己',
    '                     判定（本安装器不重复解读那个环境变量）',
    '  --restore-launchd  只做 launchd 恢复：检测作业被 bootout → bootstrap → hello',
    '                     校验 daemon 自报席位（勾完 TCC 框后重跑即自动换进程复验）；',
    '                     恢复要换的是**已加载**作业的定义时，它和 install 一样先过 ① 那道门',
    '  --skip-build       跳过 npm/tsc/swift 编译（已构建过时使用）',
    '  --accept-unverified-signature  放行**一档**验签结论：发布 tag 的 GPG 验签在本机没跑成',
    '                     （unavailable：没有 gpg、导入内置发布公钥失败、或验签命令自己抛错）。',
    '                     默认是拒装——"没跑成的检查"不许被讲成"检查过了、答案是没签名"。',
    '                     带上本 flag 才继续，并在屏幕上如实打出"这一版是在没有验签结论的情况下',
    '                     装上的"。形态与 updater 的 `--consent unsigned-release` 一致：它只批',
    '                     "缺证明"那一面——签名存在而验不过（invalid）是任何同意都不覆盖的硬拒，',
    '                     `--no-prompt` 在这里也不算同意。',
    '  --no-bootstrap     本地找不到仓库时不自动 clone，改为打印定位指引',
    '  -h, --help         显示本帮助',
    '',
    '退出码（脚本/agent 调用方读这个，别读屏幕文案）:',
    '  0  安装完成且 daemon 实测应答 hello；或本轮按要求压根不该有 daemon',
    '     （--no-daemon 且 --no-launchd）',
    '  1  收尾未通过 hello 校验（daemon 没起来/不应答），或构建/产物/launchd 出错；',
    '     也包括这两条**什么都没构建就停下**的支路——它们同样回 1，按 rc 分叉的调用方别把 1',
    '     读成"跑过但没成"：① 平台拒绝（`process.platform` 不是 darwin，见 platformRefusal），',
    '     ② 环境预检未通过（缺 node/swift/npm 那一族，`checkEnvironment` 报的每条都列在输出里）。',
    '     这两条的正文各自点名了下一步，读正文才知道该装什么。',
    '  2  命令行参数错误',
    '     用法错与 --help 同时出现时谁赢（install.sh 的 2c\' 那一节写的是同一份规则）：',
    '     `--repo` 没接到取值、或接到的是旗标（`-` 开头，单双横线都算）——这一类**先赢**，仍旧退 2；',
    '     "未知参数"这一类**让位**：给了 --help 就打这一页并退 0，因为入口脚本没有本文件的旗标',
    '     清单、判不出"未知"，抄一份就是下一处没人对照的孪生抄本。',
    '  跨二进制的用法错对照（**这是在记录一处已知分歧，不是修它**——那些码都是发出去的契约，',
    '     本轮一个都没改）：同样是"命令行参数错误"，`node updater/cli.js` 回 2（与本文件一致），',
    '     后台服务 `glasspaned` 回 64（并把整块用法打出去）。按 rc 分支的脚本要把 2 与 64 都当用法错。',
    '  注：install.sh 用 exec 委托本文件，所以**脚本自己跑完了**之后，退出码原样透传。',
    '      但 `curl … | sh` 的 $? 只在 curl 成功时才是这里的结论：curl 取不到脚本时 sh 读到的',
    '      是空输入，直接 EOF 退 0（本机实测 curl 退 7、管道退 0）；中途断流时 sh 只执行了',
    '      收到的前半截，回的是最后一条命令的状态。要拿退出码当结论就分两步跑，且落点必须是',
    '      一次性文件（`/tmp` 是 1777：sticky 只挡住别人删你的目录项，挡不住他先建一个',
    '      `/tmp/gp-install.sh -> ~/.bashrc`，而 curl -o 会跟随那个符号链接、以你的 uid 截断覆写它）：',
    '      GP="$(mktemp "${TMPDIR:-/tmp/}gp-install.XXXXXXXX")" && curl -fsSL <install.sh> -o "$GP" && sh "$GP" && rm -f "$GP"',
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
  // finding 8：面板那句"再打开一次"必须落在**真存在**的东西上。旧写法在这里另拼一个
  // `~/Applications/GlassPane.app`（--no-app 时根本没安置）或
  // `<rootDir>/engine/.build/release/GlassPane.app`（从没构建过时它不存在），于是
  // `open "…"` 是一条没人能跑通的命令，而测试只断言字面量 `open "` 出现过。
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
      `   先修这一步：node ${quoteShellArg(path.join(rootDir, 'installer', 'cli.js'))} --restore-launchd`,
      '',
    ]),
    '1. MCP 客户端（Claude Desktop / Cursor / 任意 MCP host）接入配置片段：',
    '',
    mcpClientConfigSnippet({ rootDir, socketPath }),
    '',
    '2. TCC 权限（辅助功能/输入监控/屏幕录制/开发者工具）：授权对象是 **daemon 进程**',
    '   而不是设置窗口；授权勾选必须人工完成，macOS 没有程序化授予这些权限的接口，所以这一步',
    '   没有命令行代做的方法，只能在系统设置里点。',
    daemon.viaBundle
      ? '   在系统设置的对应权限列表里应能看到「GlassPane Daemon」（带图标，可用「+」选择或从 Finder 拖入）。'
      : '   当前 daemon 是裸二进制形态，权限列表里只会显示文件名「glasspaned」（无图标，「+」选择器看不到隐藏目录）；重跑安装（默认打包 .app）可获得带图标的条目。',
    // guiOpened 的口径 = 启动命令被受理且未报错退出（bundle 形态经 `/usr/bin/open`，
    // 目标缺失/被 LaunchServices 拒绝时它返回非零 → 走下面那条手工指引）。窗口是否
    // 真出现在屏幕上没实测过，而且 `-g` 本就不抢焦点，得把这层边界写在话里。
    ...(guiOpened ? [
      '   面板已打开（口径：启动命令已发出且在观察窗口内未报错退出——bundle 形态走的',
      '   `open` 在目标 bundle 缺失时会非零退出，未报错即产物确实在；窗口外的失败看不',
      `   到，所以没看到窗口属正常（-g 不抢焦点），再起一次：${panelHint.text}${panelHint.runnable ? '' : '（本轮没有可重开的产物，见上一条）'}）。`,
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
    `   node ${quoteShellArg(path.join(rootDir, 'installer', 'cli.js'))} --restore-launchd`,
    `   （检测→bootstrap→hello 校验自报席位；勾完 TCC 框重跑即自动换进程复验）`,
`4. 主体名核对：设置面板「Daemon 状态 → 主体」应与上面「${entryName}」一致；不一致说明连到了别的构建实例。`,
    '5. registry 发布形态：MCP 服务器已可独立安装（`npm i -g glasspane-mcp`，命令名',
    '   glasspane-mcp）；但它只是转发层，daemon 与权限仍由本次安装产出，缺 daemon 时',
    '   工具调用会返回带补救步骤的结构化错误。',
    ...updateGuidanceText(update),
    '',
  ].join('\n')
}

/** GLASSPANE_REF 的唯一口径（finding 10，与 install.sh 同源）：**未设置**与**显式置空**
 *  都钉发布 tag；要追主干必须显式写 `main`。旧行为是 install.sh 把空值读成 `main`、
 *  本文件把同一个空值读成 tag——同一条 `GLASSPANE_REF=` 在两条一键入口上会拿到两份源码。
 *  合并时这里一度退回成 `env.GLASSPANE_REF || REPO_REF` 的内联写法：判据本身对，但
 *  install.sh 里那句"与 installer/cli.js 的 resolvePinRef 同源"就指向了一个不存在的东西，
 *  而这条口径再没有别的读者。 */
export function resolvePinRef(env = process.env) {
  const raw = env?.GLASSPANE_REF
  if (raw === undefined || raw === null) return REPO_REF
  const trimmed = String(raw).trim()
  return trimmed ? trimmed : REPO_REF
}

/** 允许的 clone 地址前缀（finding 3）。`https://` 是文档里那条一键安装；`ssh://` 给
 *  自带镜像的人；`file://` 保留 specs 里记着的离线/本地 clone 用法（P4-J3）。
 *  刻意**不**收 scp 式 `git@host:path`——它没有 scheme，正好和 `ext::sh -c …` 落在同一
 *  个无法白名单判定的形状里，需要它的人改写成 `ssh://git@host/path`。 */
export const ALLOWED_GIT_URL_PREFIXES = ['https://', 'ssh://', 'file://']

/** 要被拼进 git argv 的三类值（ref / URL / 目录）的共同形状检查。
 *  拒绝的正是两类注入：以 `-` 开头（被 git 当成选项，`--upload-pack=…` 直接起进程），
 *  以及靠空白字符起 shell 的 `ext::sh -c …`。 */
function unsafeArgvValue(value, label) {
  const text = String(value ?? '')
  if (!text) return `${label} 为空`
  if (text.startsWith('-')) return `${label} 以 "-" 开头，会被 git 当成命令行选项而不是值：${text}`
  if (/[\s\u0000-\u001f]/.test(text)) return `${label} 含空白/控制字符：${JSON.stringify(text)}`
  if (text.startsWith('+')) return `${label} 以 "+" 开头（强推语义），这里不收：${text}`
  return null
}

/** clone 地址的形状检查（纯函数）。顺序按"读者的病因"排：以 - 开头是选项注入、不带 scheme
 *  是 ext:: 执行入口——这两条才是拒绝的理由。空白/控制字符只是同一批病因的手段，排在它们
 *  后面才不会把 `ext::sh -c …` 报成一句"含空白字符"，让读者看不出真正被挡的是 ext 传输。 */
export function validateGitRepoUrl(repoUrl) {
  const text = String(repoUrl ?? '')
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

/** ref 的形状检查：除通用形状外，还要落在"tag/分支名字面量"的字符集里（要追主干就写 main）。 */
export function validateGitRef(ref) {
  const shape = unsafeArgvValue(ref, 'GLASSPANE_REF')
  if (shape) return { ok: false, error: `${shape}。ref 只能是 tag/分支名字面量（要追主干就写 main）` }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(String(ref))) {
    return { ok: false, error: `GLASSPANE_REF 含不被接受的字符：${JSON.stringify(String(ref))}` }
  }
  return { ok: true, ref: String(ref) }
}

/** 拼一条**不会被选项注入**的 `git clone` 参数（finding 3）：位置参数前面放 `--`。
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
        // 补救从前那句是让操作者"必要时给 HOME 赋一个绝对路径再重跑"。它教的这个动作对不上本产品的
        // 读法：状态根读的是**口令档案里的家目录**（`installer/glasspane.js` 的 `stateRootOf`、
        // `updater/cli.js` 的 `recordHomeDir`、`mcp-shell/src/update-state.ts` 的 `recordHome`），
        // 改 `$HOME` 只挪得动命令行这一头，挪不动 daemon 与设置面板读的那一份——把一次性的
        // 变量覆盖写成正式补救，等于把这条裂缝制度化。所以这里只点名真正生效的开关。
        + '补救：状态根要用 `--state-dir <路径>` 点名（更新器 `node updater/cli.js … --state-dir <路径>`、'
        + '后台服务 `glasspaned --state-dir <路径>` 都收这一面旗），或设 `GLASSPANE_STATE_DIR=<路径>`'
        + '（更新器与 `glasspane` 这条命令都读它）。这两条是 daemon、面板、更新器一起认的那一个根，'
        + '它读的是**口令档案里的家目录**（`dscl . -read /Users/<账号> NFSHomeDirectory` 问的就是这一个）；'
        + '改 `$HOME` 不改变它们读到的状态根。'
        + '本安装器自己拼的那几条路径（socket 与 ~/Library/LaunchAgents）仍然读 $HOME，'
        + '所以这一趟要在自己的登录 shell 里重跑；不要用 `sudo -u 某用户` / `env -u HOME` 这类形态起安装器。',
    }
  }
  if (!path.isAbsolute(homeText)) {
    return {
      ok: false,
      error: `HOME 必须是绝对路径，实为「${homeText}」：相对 HOME 会把状态根拼成 ${path.join(homeText, SOCKET_DIR_NAME)}，`
        // 同上一条：这里原来写的补救是"把 HOME 设成绝对路径再重跑"，而那个变量不是状态根的读法
        // （读的是口令档案），照它做的人会把 CLI 挪走、把 daemon 留在原地。生效的开关是下面那两条。
        + 'plist 里的 StandardOutPath 也是相对的，launchd 不会收。补救：本安装器自己拼的这几条路径读 $HOME，'
        + '所以在 $HOME 为绝对路径的那个登录 shell 里重跑同一条命令即可；状态根那一头不要靠 $HOME——它读口令档案，'
        + '改 $HOME 不改变 daemon 与设置面板读到的那一份。要指名状态根就用 `--state-dir <路径>`'
        + '（`node updater/cli.js … --state-dir <路径>`、`glasspaned --state-dir <路径>`），'
        + '或 `GLASSPANE_STATE_DIR=<路径>`（更新器与 `glasspane` 这条命令读它）。',
    }
  }
  if (uid !== null && uid !== undefined && Number(uid) === 0) {
    return {
      ok: false,
      error:
        '当前是 uid 0（root / sudo）：GlassPane 是**用户级** launchd 代理与 TCC 授权，整棵安装会以 root 身份'
        + '落进 /var/root（产物、socket、plist 都不是你登录账号的那一份），辅助功能授权主体也永远对不上。'
        + '本安装不需要 sudo。补救：去掉 sudo 直接重跑同一条命令'
        // 这条补救话里的 URL **必须是那个常量的插值**。写第二份字面量就是仓库改名/换 org 时
        // 唯一不会被任何闸发现的复制品：`installer/test/install-sh.test.mjs` 按这条断言，
        // 而它测的是这段拒绝文本真的带着 INSTALL_SH_URL。
        + `（curl -fsSL ${INSTALL_SH_URL} | sh，`
        + '或 node installer/cli.js）。',
    }
  }
  return { ok: true, home: homeText }
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

/** clone 失败的归因（finding 9）：把 **git 自己的原话**交给读者，而不是把任何非零退出
 *  都算成"网络不可达或该发布 tag 不存在"。"destination path … already exists and is not an
 *  empty directory" 是真能走到的（bootstrapPlan 只拒绝"这一层目录自己不是 GlassPane 仓库"的那种，
 *  判据见 looksLikeRepoHere），被归因成网络问题时读者会一直重试一条永远不通的路。 */
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
  // 只读探针：注入它，这条纯函数才能被"目录已经存在且是一棵 GlassPane 仓库"这一支单测覆盖。
  readCloneState = null,
} = {}) {
  if (!homeDir) {
    return { error: '无法确定用户主目录（HOME 为空），不知道把源码 clone 到哪里' }
  }
  const targetDir = installDir || path.join(homeDir, 'glasspane')
  // 只问这一层，不向上走（S7-1，2026-10-29 P0）。这里从前用的是 `resolveProjectRoot(targetDir)`，
  // 而它会一路向上找到外层的仓库：`<外层repo>/vendored` 于是"是一个仓库"，躲过这条拒绝，
  // 后面的 fetch/checkout 就全落在外层那一棵上（同一条输入 install.sh 的答案是"目标目录已存在
  // 且不是 GlassPane 仓库"+ rc 1——两条一键入口对着同一个目录给两种结论，修的就是这一类）。
  if (fs.existsSync(targetDir) && !looksLikeRepoHere(targetDir)) {
    return {
      error: `目标目录已存在且不是 GlassPane 仓库：${targetDir}（用 --repo 指定仓库，或清理该目录后重试）`,
    }
  }
  // 目录存在**且是一棵 GlassPane 仓库**：这一支从前直接往下走 `git clone`，于是产品自己的安装位置
  // （`~/glasspane`）里那份旧 clone 换来的是 git 的 "destination path … already exists and is not an
  // empty directory"——读者按提示"换个目录"重跑，下一次又落在同一个地方。现在它前进那棵树，或说清
  // 为什么不动它（判据见 `existingCloneDecision`）。
  if (fs.existsSync(targetDir) && typeof readCloneState === 'function') {
    const state = readCloneState({ targetDir, ref })
    const decision = existingCloneDecision({ targetDir, ref, ...state })
    if (decision.action !== 'advance') {
      return { use: decision.action === 'use', targetDir, refuse: decision.action === 'refuse' ? decision : null, decision }
    }
    return { advance: { targetDir, ref, decision } }
  }
  // 三个值都会进 git argv：ref 来自 GLASSPANE_REF、目录来自 GLASSPANE_INSTALL_DIR，
  // 都是文档里写明的覆盖口子。判据与 install.sh 的 assert_ref/assert_repo_url 同源。
  const clone = safeGitCloneArgs({ repoUrl, ref, targetDir })
  if (clone.error) return { error: clone.error }
  return {
    targetDir,
    ref: clone.ref,
    gitArgs: clone.args,
  }
}

/**
 * 两条路径是不是同一个东西。`git rev-parse --show-toplevel` 打的是**物理路径**（macOS 上
 * `/var` → `/private/var`、家目录里的软链都会被解开），所以两侧都要过一遍 realpath 才可比；
 * 路径不存在时 realpathSync 抛，退回 `path.resolve`——不存在的那一侧本来就答不出仓库根。
 */
function canonicalPath(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** 问一次「这一带最近的仓库根在哪」，把答案作为数据交回去（不判定）。 */
export function readRepoToplevel({ dir, spawn = spawnSync } = {}) {
  const res = spawn('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  const answer = String(res?.stdout ?? '').trim()
  if (res?.status !== 0 || answer === '') {
    return { read: false, toplevel: null }
  }
  return { read: true, toplevel: answer }
}

/**
 * 纯判定：要动手的那一棵，是不是说话人指的那一棵？（S7-1，2026-10-29，P0）
 * `git -C <dir>` 对**任何**目录都按"离它最近的那棵树"答话，所以 `git -C <外层repo>/vendored
 * status` 与 `checkout --detach` 动的都是外层那棵树——本轮实测把外层 main detach 了。
 * 只答两种"不是同一棵"：答不出（`unreadable`，那目录不是任何仓库的一部分，或 git 没答话），
 * 与答的是别处（`outside`）。相等就回 null。
 */
export function toplevelProblemFor({ targetDir, toplevel = null, readOk = false } = {}) {
  if (!readOk) return { kind: 'unreadable' }
  if (canonicalPath(toplevel) === canonicalPath(targetDir)) return null
  return { kind: 'outside', toplevel }
}

/** 两种"不是同一棵"各说一句；两处调用（纯判据、IO 步）共用这一份，不发明第二套说法。 */
export function toplevelRefuseText({ targetDir, problem }) {
  if (problem?.kind === 'outside') {
    return `${targetDir} 自己不是一棵 git 仓库的根：git 说这一带最近的根在 **${problem.toplevel}**。`
      + `\n本轮要是动手，动的就是 ${problem.toplevel} 那一棵，而不是你指的 ${targetDir}——那是别人的仓库，`
      + '安装器不在它上面 fetch、不切它的分支、不碰它的工作树。'
      + `\n下一步（两条都做得动，且不销毁任何东西）：`
      + `\n  a) 换一处不属于任何仓库的落点：GLASSPANE_INSTALL_DIR=<空目录> 重跑一键安装`
      + '（那个目录自己要能让 git -C <目录> rev-parse --show-toplevel 答不出才算它自己）；'
      + `\n  b) 要装的那一棵在别处就用 --repo / GLASSPANE_REPO 指过去，指的目录必须自己就是仓库根。`
  }
  return `${targetDir} 答不出 git 仓库根（这一带它不是 git 仓库，或 git 本身没答话）：`
    + '连"要动的是哪一棵"都判不出来，就不动它，也不装它。'
    + `\n下一步：确认 ${targetDir} 是一棵 git 仓库（git -C "${targetDir}" rev-parse --show-toplevel 能不能答话）；`
    + '要一份全新的 clone 就 GLASSPANE_INSTALL_DIR=<空目录> 重跑一键安装。'
}

/**
 * 既有 clone 的结论（纯判定，可单测）。
 *
 * 为什么这一格不能像以前那样"提示一句就照用"：`~/glasspane` 是产品自己的安装位置，`install.sh` 与
 * `npx glasspane-install` 都往那里 clone。上一版在这里只打印"既有 clone 不会被自动切到 v1.21.0"，
 * 然后**照用那棵树**去构建——2026-10-26 这台机器上那是 v1.5.0 的 clone，于是"一键安装"把一个 1.5.0
 * 的产物当成新装交出去，而 `npx` 那条路更糟：它直接对已存在目录跑 `git clone`，被 git 以
 * "destination path … already exists and is not an empty directory" 拒掉，读者只剩"换目录"这一条死路。
 *
 * 判据按那个人 2026-10-26 选的形状：
 *   · 先问「要动的是不是这一棵」（`toplevelProblem`，见 `readRepoToplevel`）：答不出或答的是
 *     别处 ⇒ 拒绝，点名要动的到底是哪一棵——这一问排在脏/干净之前，因为"这棵树干净"是对着
 *     别人的仓库说的结论（S7-1，2026-10-29 P0）；
 *   · 干净（`git status --porcelain` 空）且 HEAD 已经是那个 tag ⇒ 就用；
 *   · 干净但不是那个 tag ⇒ 前进（fetch + detached checkout —— 这是移动**产品自己的 clone**，
 *     不是移动任何人的工作树）；
 *   · 脏 ⇒ 拒绝，点名前 10 个挡路的路径，并给一条不销毁任何东西的出路（换一个空目录）；
 *   · HEAD 读不出 ⇒ 拒绝。"判不出来"永远不许变成"那就照用/那就切过去"。
 *
 * **"该 tag 本地读不出"不是一条拒绝**，2026-10-27 在本机被实测推翻的正是这一格。旧写法把它和
 * "HEAD 读不出"并成同一句"判不出来就拒"，于是 `~/glasspane`（v1.5.0 的 clone，本地 tag 只到
 * v1.2.0）在 npm 那条入口上**永远**走到 refuse：`bootstrapPlan` 先问判据、判据先拒，而那一步
 * 之后**会 fetch 这个 tag 的代码（`advanceExistingClone`）根本轮不到执行**。`install.sh` 那一支
 * 是对的（先 fetch 再判），两条一键入口对同一棵树给出两种答案——finding 10 那族的老形状。
 * 现在 tag 缺席归到"前进"里：fetch 不成仍由 `advanceExistingClone` 拒，并交出 git 的原话；
 * HEAD 读不出照旧是拒。前者是能补的事实缺口，后者是判据本身没了。
 */
export function existingCloneDecision({ targetDir, ref, head = null, tagCommit = null, blocking = [], toplevelProblem = null }) {
  // 「要动的是哪一棵」问在「这棵树脏不脏」之前：判不出对象的时候，后面每一条结论都是对着
  // 别人的仓库说的（S7-1 的实测形状：外层 main 被 detach，然后回一句 advance: use）。
  if (toplevelProblem) {
    return {
      action: 'refuse',
      blocking: [],
      toplevelProblem,
      text: toplevelRefuseText({ targetDir, problem: toplevelProblem }),
    }
  }
  const dirty = blocking.map((line) => String(line).trim()).filter((line) => line !== '')
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 10)
    return {
      action: 'refuse',
      blocking: dirty,
      text: `${targetDir} 有 ${dirty.length} 处未提交改动，安装器不会切走它（切走会把别人的工作当成构建源码）：\n`
        + shown.map((line) => `    ${line}`).join('\n')
        + (dirty.length > shown.length ? `\n    …另有 ${dirty.length - shown.length} 处` : '')
        + `\n下一步（不销毁任何东西，两条都做得动）：`
        // 建议的目录必须从**被拒的那棵树**推出来，不能写死 `~/glasspane-<ref>`：GLASSPANE_INSTALL_DIR
        // 指到 /Volumes/src/gp 时被拒的是那棵树，而句子里给的是家目录里另一条从没存在过的路径——
        // 两条一键入口同源的那条规矩（判据不许指向一个与本次无关的位置）。路径带空格时必须加引号，
        // 否则这句照抄进去的是两个词，clone 落在 `/Users/John` 而 `Smith/…` 变成一条命令。
        + `\n  a) 换一处干净的家再跑一键安装：GLASSPANE_INSTALL_DIR="${String(targetDir)}-${String(ref).replace(/[^A-Za-z0-9._+-]/g, '_')}" `
        + `sh install.sh（或 npx glasspane-install）；`
        + `\n  b) 自己收着这些改动：在 ${targetDir} 里把它们提交或转移到别处，再重跑本命令——`
        + '安装器不替你决定这些文件去哪。',
    }
  }
  if (!head) {
    return {
      action: 'refuse',
      blocking: [],
      text: `${targetDir} 读不出 HEAD（不是 git 仓库、那目录没有一次提交，或 git 本身答不了）：`
        + '连"这棵树在哪"都判不出来，就不动它，也不装它。'
        + `\n下一步：确认 ${targetDir} 是一棵 git 仓库（git -C "${targetDir}" rev-parse HEAD 能不能答话）；`
        + '要一份全新的 clone 就 GLASSPANE_INSTALL_DIR=<空目录> 重跑一键安装。',
    }
  }
  if (tagCommit && head === tagCommit) {
    return { action: 'use', blocking: [], head, text: `${targetDir} 已经在 ${ref}（${String(head).slice(0, 7)}），直接用它构建。` }
  }
  if (!tagCommit) {
    return {
      action: 'advance',
      blocking: [],
      head,
      tagCommit: null,
      needsFetch: true,
      text: `${targetDir} 是干净的 clone（HEAD 在 ${String(head).slice(0, 7)}），但本地没有 ${ref} 这个 tag`
        + '（旧 clone 的 tag 表停在更早的一版，浅历史也会这样）：前进那一步先 fetch 它再切。'
        + `fetch 不成就是拒——${targetDir} 原地不动，本轮不构建。`,
    }
  }
  return {
    action: 'advance',
    blocking: [],
    head,
    tagCommit,
    text: `${targetDir} 是干净的 clone，HEAD 在 ${String(head).slice(0, 7)} 而要装的是 ${ref}（${String(tagCommit).slice(0, 7)}）——`
      + '把它前进到那一个 tag 再构建。',
  }
}

/**
 * 一棵既有 clone 的四份事实（IO 读，不判定）：HEAD 指向的 commit、`ref^{commit}`、
 * `git status --porcelain` 的行，以及这份 clone 是不是浅仓。判据一律在 `existingCloneDecision`，
 * 两处调用（bootstrap 的纯计划、前进这一步的复判）共用同一份读数，避免出现第二个"什么算脏"的说法。
 *
 * 这四份事实之前还有一问：`rev-parse --show-toplevel`——它决定"这四份事实到底是谁的事实"。
 * 答不出或答的是别处时**一份都不给**（见上面的 S7-1 注释），调用方拿到的就是 head=null。
 *
 * `shallow` 是给 fetch 挑形状的：`--depth 1` 会把一棵**完整**的 clone 变成浅仓（`.git/shallow`
 * 一旦落下，之后的遍历都撞上人为边界，要恢复得 `git fetch --unshallow`）。旧写法对任何树都带
 * `--depth 1`，而注释写的是"只往 .git 里加对象"——那句话对完整 clone 不成立，它加的是一个边界。
 * 只有 git 亲口答 `true` 才用 `--depth 1`；答不出来（老 git、不是仓库）按完整仓对待，宁可多取
 * 一点也不给人家的历史加边界。
 */
export function readCloneFacts({ targetDir, ref, spawn = spawnSync, fetchHead = false } = {}) {
  // 开头先问「要动的是不是这一棵」（S7-1）。`git -C <dir>` 对别人仓库的子目录一样答话，
  // 所以后面的 status / rev-parse 读回来的其实是**外层那棵树**的事实：外层干净、外层 HEAD 在
  // 某一笔上，于是这一棵被读成"干净的既有 clone"，下一步 fetch/checkout 就 detach 了外层的 main。
  // 答不出或答的是别处 ⇒ 一条事实也不给（head 为 null），判据那一侧只能落到"拒"。
  const top = readRepoToplevel({ dir: targetDir, spawn })
  const toplevelProblem = toplevelProblemFor({ targetDir, toplevel: top.toplevel, readOk: top.read })
  if (toplevelProblem) {
    return { head: null, tagCommit: null, blocking: [], shallow: null, toplevelProblem, toplevel: top.toplevel }
  }
  const read = (args) => spawn('git', ['-C', targetDir, ...args], { encoding: 'utf8' })
  const sha = (what) => {
    const res = read(['rev-parse', '--verify', what])
    return res.status === 0 ? String(res.stdout ?? '').trim() : null
  }
  const status = read(['status', '--porcelain'])
  const shallow = read(['rev-parse', '--is-shallow-repository'])
  // 按 tag 建的浅 clone 里**根本没有 refs/heads/**（`git clone --branch v1.23.0` 只配了那一个 tag
  // 的 refspec）。所以对 `GLASSPANE_REF=main` 这种追主干的用法，`main^{commit}` 在本地永远读不出，
  // 而紧跟其后的 `git fetch --tags origin main` **退 0 却不落下名为 main 的 ref**——它只写 FETCH_HEAD。
  // 实测（真 git，一棵按 tag 建的浅 clone）：fetch 前后 `rev-parse --verify main^{commit}` 都回
  // `fatal: Needed a single revision`，而 `checkout --detach main` 回
  // `fatal: git checkout: --detach does not take a path argument 'main'`。旧代码把这两句都当成
  // "网络或该 tag 有问题"，于是文档里写明的追主干口径在这两条一键入口上是**永久死路**。
  // `fetchHead` 只在"这一趟自己刚 fetch 过那个 ref"之后打开：FETCH_HEAD 就是那次 fetch 的答案，
  // 拿它当 ref 的落点比猜一个不存在的 ref 诚实；不由判据那一侧默认打开，否则上一趟别人 fetch 的
  // 残留会被读成"这一版就在它指的地方"。
  const refCommit = sha(`${ref}^{commit}`) ?? (fetchHead ? sha('FETCH_HEAD^{commit}') : null)
  return {
    head: sha('HEAD'),
    tagCommit: refCommit,
    // `git status` 答非零时这里得到空数组，读起来是"干净"——那棵树随后会因为 `head` 读不出而被拒，
    // 所以"判不出来"走的是拒绝那一支，不是"那就切过去"。
    blocking: status.status === 0 ? String(status.stdout ?? '').split('\n').filter((line) => line !== '') : [],
    shallow: shallow.status === 0 ? String(shallow.stdout ?? '').trim() === 'true' : null,
  }
}

/**
 * 这棵 clone 该从哪个远端取（纯判定，可单测）。
 *
 * 旧写法把 `origin` 写死在 fetch 与诊断两处。一棵用 `git clone --origin up` 建的树、或把 origin
 * 改指镜像的树，走到的是同一条拒绝，而那句拒绝让人去 `git ls-remote --tags origin <ref>`——**同一条
 * 用错名字的命令**，照抄也只会再失败一次。判据只读事实：有 origin 用它；只有一个远端就用那一个；
 * 一个都没有、或多个而没有 origin，都是"答不出该从哪取"，不猜。
 */
export function resolveRemoteName({ remotes = [] } = {}) {
  const list = remotes.map((name) => String(name).trim()).filter((name) => name !== '')
  if (list.includes('origin')) return { remote: 'origin' }
  if (list.length === 1) return { remote: list[0] }
  if (list.length === 0) {
    return { error: '这棵树里一个远端都没有（git remote 答空）：fetch 无处可取，这里也不替它猜一个名字。' }
  }
  return {
    error: `这棵树里有 ${list.length} 个远端（${list.join('、')}）而没有名为 origin 的那个：`
      + '不猜该从哪一个取。下一步：把要用的那个远端改名成 origin，或直接 git fetch <那个远端> <ref> 之后重跑。',
  }
}

/**
 * 把既有 clone 前进到钉住的 ref（IO 步；判据全在 `existingCloneDecision` 里）。
 *
 * 只有这几种 git 动作：开头一次 `rev-parse --show-toplevel`（问"要动的是不是这一棵"，见下面的
 * S7-1 注释）、`status --porcelain`、`remote`、几次 `rev-parse --verify`、`rev-parse
 * --is-shallow-repository`（全是读），`fetch --tags [remote <ref>]`（只往 .git 里加对象；
 * 带不带 `--depth 1` 由 git 自己答的那句"是不是浅仓"决定，见 `readCloneFacts`），以及
 * `checkout --detach <那个 commit 的 sha>`（只在树干净时执行）。没有 `-f`、没有 `stash`、没有
 * `clean`、没有 `reset --hard`：一个 installer 不该有能把别人的未提交工作抹掉的那一格。
 *
 * 切的是 **sha 而不是那个名字**：按 tag 建的 clone 里没有 refs/heads/*，`main` 这个名字 fetch 之后
 * 仍然不是一个 ref，`git checkout --detach main` 被 git 以"--detach does not take a path argument"
 * 拒绝；而那次 fetch 的落点（FETCH_HEAD）就是一个 sha，切它才是这一句本来的意思。
 */
export function advanceExistingClone({ repoDir, ref, spawn = spawnSync } = {}) {
  // 第一件事不是"这棵树脏不脏"，而是"要动的是不是这一棵"（S7-1，2026-10-29 P0）：
  // `git -C <dir> …` 会落到离它最近的那棵树，所以从前这一支对着 `<外层repo>/vendored` 跑
  // `checkout --detach` 时，切走的是**外层的 main**（本轮实测：detach 完还回一句 advance: use）。
  // 这一问在这里独立跑一次，不靠 `readCloneFacts` 内部那道——两个函数都可能被单独调用，
  // 守卫住在各自开头才算各自守得住。
  const top = readRepoToplevel({ dir: repoDir, spawn })
  const toplevelProblem = toplevelProblemFor({ targetDir: repoDir, toplevel: top.toplevel, readOk: top.read })
  if (toplevelProblem) {
    return {
      action: 'refuse',
      blocking: [],
      toplevelProblem,
      toplevel: top.toplevel,
      text: toplevelRefuseText({ targetDir: repoDir, problem: toplevelProblem }),
    }
  }
  const read = (args) => spawn('git', ['-C', repoDir, ...args], { encoding: 'utf8' })
  const remoteNames = () => {
    const res = read(['remote'])
    return res.status === 0 ? String(res.stdout ?? '').split('\n').filter((line) => line !== '') : null
  }
  let facts = readCloneFacts({ targetDir: repoDir, ref, spawn })
  if (facts.blocking.length === 0 && facts.head && !facts.tagCommit) {
    // 该 ref 在本地读不出（旧 clone 的 tag 表停在更早一版、浅 clone、按 tag 建的 clone 里没有
    // refs/heads/*）：先把它取回来，再判。fetch 失败不改任何东西。
    const remotes = remoteNames()
    const remote = remotes === null ? null : resolveRemoteName({ remotes })
    if (!remote || !remote.remote) {
      return {
        action: 'refuse',
        blocking: [],
        text: `${repoDir} 里没有 ${ref} 这个引用，而这一趟连"该从哪个远端取"都答不出来：`
          + `${remote?.error ?? 'git remote 本身没答话。'}\n`
          + `${repoDir} 原地不动，没有 fetch、没有切分支、没有构建任何东西。`,
      }
    }
    const fetchArgs = facts.shallow === true
      ? ['fetch', '--tags', '--depth', '1', remote.remote, ref]
      : ['fetch', '--tags', remote.remote, ref]
    const fetched = read(fetchArgs)
    if (fetched.status !== 0) {
      return {
        action: 'refuse',
        blocking: [],
        fetchArgs,
        remote: remote.remote,
        text: `${repoDir} 里没有 ${ref} 这个引用，而 `
          + `git -C "${repoDir}" ${fetchArgs.join(' ')} 退出 ${String(fetched.status ?? 'null')}：`
          + `${String(fetched.stderr ?? '').trim().split('\n')[0] || '（git 没有留下 stderr）'}。\n`
          + '没有 clone、没有切分支、没有写入任何东西。下一步：确认网络与该引用存在（'
          + `git ls-remote ${remote.remote} ${ref}），或 GLASSPANE_INSTALL_DIR=<空目录> 换一处全新的 clone。`,
      }
    }
    facts = readCloneFacts({ targetDir: repoDir, ref, spawn, fetchHead: true })
  }
  let decision = existingCloneDecision({ targetDir: repoDir, ref, ...facts })
  if (decision.action !== 'advance') return decision
  const targetCommit = facts.tagCommit
  if (!targetCommit) {
    // 这一支不是"生产会走到的判断"，而是一条**构造性的护栏**：git 在这台机器上对一个远端不存在
    // 的引用答的是退出 128（本机实测：`fatal: couldn't find remote ref nosuchbranch`），所以
    // fetch 退 0 而落点读不出这种形状没人给过。但 `checkout --detach` 的实参只许是一个读到的
    // commit —— 把 null 拼进 argv 会让 git 报一条与本轮结论无关的错，而那正是"切了个不存在的东西"
    // 的另一种写法。判据照旧是"不切就停下"，由上面那条 decision 说话。
    return decision
  }
  const out = read(['checkout', '--detach', targetCommit])
  if (out.status !== 0) {
    return {
      action: 'refuse',
      blocking: readCloneFacts({ targetDir: repoDir, ref, spawn, fetchHead: true }).blocking,
      text: `切到 ${ref}（${String(targetCommit).slice(0, 7)}）没成（git checkout --detach 退出 ${String(out.status ?? 'null')}）：`
        + `${String(out.stderr ?? '').trim().split('\n')[0] || '（git 没有留下 stderr）'}。\n`
        + `${repoDir} 仍在 ${String(facts.head ?? '读不出').slice(0, 7)}，本轮没有构建任何东西。`,
    }
  }
  // 切完再读一次：判据要落在**切换之后**的事实上，不是落在命令的退出码上。
  const after = readCloneFacts({ targetDir: repoDir, ref, spawn, fetchHead: true })
  const recheck = existingCloneDecision({ targetDir: repoDir, ref, ...after })
  if (recheck.action !== 'use') {
    return {
      action: 'refuse',
      blocking: after.blocking,
      text: `切完之后 ${repoDir} 还不是 ${ref}（HEAD=${String(after.head ?? '读不出').slice(0, 7)}，`
        + `tag=${String(after.tagCommit ?? '读不出').slice(0, 7)}，另有 ${after.blocking.length} 处改动）：本轮不拿它构建。`,
    }
  }
  return {
    ...recheck,
    advanced: true,
    from: facts.head,
    text: `${repoDir} 从 ${String(facts.head ?? '读不出').slice(0, 7)} 前进到 ${ref}（${String(after.head).slice(0, 7)}），用它构建。`,
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

/**
 * 收尾那句"实测校验通过"到底能说什么，取决于两件事：有没有 daemon 应答，以及应答的那一份
 * **是不是本轮刚构建的产物**。从前这里只看 `hello?.version` 有没有值——旧实例占着 socket 时
 * （上面那条"daemon 已在监听…跳过启动"分支）应答的是上一版构建，新构建从未被启动也从未被验证，
 * 安装器却打印"实测校验通过…安装完成"并退 0，而 `install.sh` 是 exec 委托：按退出码办事的
 * agent 只看到 0。
 *
 * `declinedBundles`（2026-10-15 补的那一格）：`installBundles` 有一条"目标已存在而覆盖被
 * 回答跳过"的路（finding 11），跳过时**磁盘上留的是上一轮的 bundle**，daemon 的启动路径也
 * 照旧选中它。于是"同版本号"这件事再也分不出字节是谁家的：本轮重建了产物却没装上，
 * hello 应答的版本号与 `glasspaned --version` 一模一样，收尾却要说"实测校验通过…
 * 本轮构建产物=<v>"——那句在这一层无从验证，写出来就是把未验证写成已验证。
 * 所以 declined 非空时 verified 只能是 false。
 */
export function installVerification({
  arrived = false,
  helloVersion = null,
  builtVersion = null,
  servedByEarlierInstance = false,
  declinedBundles = [],
} = {}) {
  if (!arrived || !helloVersion) return { verified: false, note: null }
  if (!builtVersion) {
    return {
      verified: false,
      note: '读不出本轮构建产物的版本（`glasspaned --version` 没给出可解析的一行），'
        + '所以无法证明应答 hello 的那一份就是本轮构建——本次不算校验通过。',
    }
  }
  if (helloVersion !== builtVersion) {
    return {
      verified: false,
      note: `应答 hello 的 daemon 自报 ${helloVersion}，本轮构建产物是 ${builtVersion}：socket 被旧实例占着，`
        + '这一轮的构建从未被验证。用 --replace-daemon 重跑（它会先收拢在跑的实例）。',
    }
  }
  const declined = (Array.isArray(declinedBundles) ? declinedBundles : []).filter(Boolean)
  if (declined.length > 0) {
    return {
      verified: false,
      note: `应答 hello 的 daemon 自报 ${helloVersion}，与本轮构建产物同号——但这一轮的 .app 覆盖被回答跳过：`
        + `${declined.join('、')} 里装的还是**上一轮**的产物，daemon 启动路径也照旧选中它。`
        + '同号只可能是同一版本的两份字节，这一层分不出来，所以"应答的就是本轮构建"这句话没有依据——'
        + '按"不得把未验证写成已验证"，本轮不算校验通过（磁盘上的 bundle 不是本轮构建的那一份）。'
        + '补救：在交互终端重跑本命令，并对"将用本轮产物覆盖已存在的 .app"回答继续；'
        + '脚本/自动化里显式加 --no-prompt。',
    }
  }
  if (servedByEarlierInstance) {
    return {
      verified: true,
      note: `版本号一致（${builtVersion}），但应答的实例在本次安装之前就已经在服务：同一版本号只能说明它是`
        + '同一版本，不能证明它是本轮构建出来的那一份。要确证，用 --replace-daemon 重跑一次。',
    }
  }
  return { verified: true, note: null }
}

/** 本轮构建产物自报的版本（`glasspaned --version` 那一行）；读不出返回 null，不猜。
 *  探测必须带**有界**超时：一个卡死的产物会把整次安装挂在这一步，而它已经在
 *  launchd 之后、收尾校验之前——没有超时的话连"安装失败"这句都说不到。 */
export function builtDaemonVersion({ daemonBin, spawn = spawnSync, timeoutMs = 5000 } = {}) {
  if (!daemonBin) return null
  let res
  try {
    res = spawn(daemonBin, ['--version'], { encoding: 'utf8', timeout: timeoutMs })
  } catch {
    return null
  }
  if (res.error || res.status !== 0) return null
  // 真产物这一行是 `glasspaned 1.11.0`（`DaemonVersionFlagTests` 钉的就是这个形状），
  // 不是裸版本号：按 `^<数字>` 找行的实现对本机每一份真 daemon 都读不出，于是
  // "本轮构建产物未被验证"这句话每次安装都得说一遍，退出码恒 1。取行里那个版本记号，
  // 并要求它是独立的一个词（不把 `v1.2.3`、`1.2.3.4` 之类读成版本）。
  const match = String(res.stdout ?? '')
    .split('\n')
    .map((text) => text.trim())
    .find((text) => /(?:^|\s)\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?(?=$|\s)/.test(text))
    ?.match(/(?:^|\s)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)(?=$|\s)/)
  return match ? match[1] : null
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
      ? `open ${quoteShellArg(target)}`
      : `直接执行裸二进制面板："${target}"（当前没有 .app bundle，所以不经 open、没有 bundle 身份）`,
  }
}

/** 未通过校验时的提示行（纯函数，可单测）。必须自带**用户真能执行**的补救命令，
 *  并点明退出码非零——只说"安装未完成"的话，脚本调用方什么也拿不到。 */
export function verificationFailureText({
  arrived = false,
  socketPath,
  daemonLog,
  cliPath,
  exitCode = 1,
  declinedBundles = [],
} = {}) {
  const declined = (Array.isArray(declinedBundles) ? declinedBundles : []).filter(Boolean)
  if (declined.length > 0) {
    // 这一档的病因不是"hello 没答上来"，也不是 launchd 作业没注册——是**本轮产物压根没装上盘**。
    // 把 --restore-launchd 那条补救派给它是误归因（它修注册，不覆盖 bundle），所以单独一支。
    return [
      `安装未完成：daemon 在 ${socketPath} 应答了 hello，但这一轮的 .app 覆盖被回答跳过——`
        + `${declined.join('、')} 里还是上一轮的产物，本轮构建的字节没被装上，也就没被验证。`,
      `本命令退出码 ${exitCode}：install.sh 与调用它的脚本/agent 按安装失败处理，先别接 MCP。`,
      '补救：在交互终端重跑本命令，并对"将用本轮产物覆盖已存在的 .app"回答继续；'
        + '脚本/自动化里显式加 --no-prompt。（--restore-launchd 修的是作业注册，不覆盖 bundle，这条用不上。）',
      `对照口径：本轮构建产物自己报的版本取自 ${daemonLog} 同一次安装的 glasspaned --version；装上盘才算数。`,
    ].join('\n')
  }
  return [
    arrived
      ? `安装未完成：socket 在（${socketPath}），但 daemon 没有正确应答 hello——见 ${daemonLog}`
      : `安装未完成：没有等到 daemon 在 ${socketPath} 应答 hello——见 ${daemonLog}`,
    `本命令退出码 ${exitCode}：install.sh 与调用它的脚本/agent 按安装失败处理，先别接 MCP。`,
    `补救（不需要手敲 launchctl）：node ${quoteShellArg(cliPath)} --restore-launchd`,
    '修好后重跑安装器即可（它会覆盖式重建产物与 plist）。',
  ].join('\n')
}

/** 主安装流程；所有副作用步骤均记录真实执行结果，失败即抛错终止。
 *  返回值是收尾校验结论（`installOutcome`），入口守卫据此设退出码。
 *
 *  `uid` 是**测试接缝**（finding 4）：真实调用读 `process.getuid()`，单测注入 uid=0
 *  就能在不真的当 root 的前提下走同一条拒绝分支——这也是唯一能让"sudo 下静默装进
 *  /var/root"这条可单测的地方。 */
export async function install({
  options = parseArgs([]).options,
  env = process.env,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const explicitRoot = options.repoDir ? path.resolve(options.repoDir) : null
  const envRoot = env.GLASSPANE_REPO ? path.resolve(env.GLASSPANE_REPO) : null

  // finding 4：在任何写入/clone 之前先闸掉 HOME 缺失、相对 HOME 与 uid 0 三种形态。
  // 旧代码把 `process.env.HOME ?? ''` 直接拼进每一条路径：状态根成了 `./.glasspane`、
  // plist 落进当前目录（launchd 拒收相对的 StandardOutPath），sudo 下整棵安装无声无息
  // 落进 /var/root。
  const guard = installGuard({ home: env.HOME ?? '', uid })
  if (!guard.ok) throw new Error(guard.error)
  const homeDir = guard.home
  const pinRef = resolvePinRef(env)

  // 2026-10-31 P0：两个**显式**定位位排在 `fs.existsSync` 之前先过 looksLikeRepoHere。
  // 从前这里只问"在不在"，于是一个存在的非仓库目录会被当成项目根交给 npm（见
  // locatedRootRefusal 的注释），而同一串 argv 在 install.sh 那一头回 1 且一个字节都没写。
  // 两条一键入口对同一串输入必须同判，且"能拒的守卫要在第一字节之前拒"是本仓的规矩。
  for (const located of [
    { label: '--repo', dir: explicitRoot },
    { label: 'GLASSPANE_REPO', dir: envRoot },
  ]) {
    const refusal = locatedRootRefusal({ ...located, ref: pinRef })
    if (refusal) throw new Error(refusal)
  }

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
      readCloneState: ({ targetDir, ref }) => readCloneFacts({ targetDir, ref }),
    })
    if (plan.error) {
      throw new Error(`${plan.error}\n\n${repoMissingText()}`)
    }
    // 目录里已经有一棵 GlassPane 仓库：要么用它（已经在钉的那个 tag 上），要么前进它，要么说清为什么
    // 不动它。三条都是**结论**，没有一条是"那就 clone 试试，让 git 去报错"。
    if (plan.refuse) {
      throw new Error(`${plan.refuse.text}\n\n${repoMissingText()}`)
    }
    if (plan.use) {
      printStep(plan.decision.text)
      rootDir = plan.targetDir
    } else if (plan.advance) {
      printStep(plan.advance.decision.text)
      const advanced = advanceExistingClone({ repoDir: plan.advance.targetDir, ref: plan.advance.ref })
      if (advanced.action !== 'use') {
        throw new Error(`${advanced.text}\n\n${repoMissingText()}`)
      }
      printStep(advanced.text)
      rootDir = advanced.targetDir ?? plan.advance.targetDir
    } else {
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
      // 核对的也是**这一层**：clone 出来的目录自己得有 marker。从前这里用 resolveProjectRoot，
      // 它会向上走，于是一棵内容不完整的 clone 只要落在某个仓库里就能被判成"结构完整"。
      if (!looksLikeRepoHere(plan.targetDir)) {
        throw new Error(`clone 完成但目录结构不完整：${plan.targetDir}\n\n${repoMissingText()}`)
      }
      rootDir = plan.targetDir
    }
  }

  // 发布 tag GPG 验签：先过"这次到底验不验"的门（形状/存在性），再判动作，两条判据都是纯函数。
  const gate = tagVerifyGate({ pinRef, hasRef: repoHasRef(rootDir, pinRef) })
  if (gate.action === 'refuse') throw new Error(gate.text)
  if (gate.action === 'skip') {
    printStep(paint(gate.text, 'yellow'))
  } else {
    const sig = verifyCloneTagGpg({ repoDir: rootDir, ref: pinRef })
    // 先判"签名对不对"，再判"要装的是不是被签的那棵树"——两问分开，绿字才只在对得上时出现。
    const verdict = tagVerifyAgainstTree({
      verdict: tagVerifyDecision({
        sig,
        pinRef,
        repoDir: rootDir,
        acceptUnverified: options.acceptUnverifiedSignature === true,
      }),
      tree: tagTreeAgreement({ repoDir: rootDir, ref: pinRef }),
      pinRef,
      repoDir: rootDir,
    })
    if (verdict.action === 'refuse') throw new Error(verdict.text)
    printStep(paint(verdict.text, verdict.action === 'pass' ? 'green' : 'yellow'))
  }

  const engineDir = path.join(rootDir, 'engine')
  const buildDir = path.join(engineDir, '.build', 'release')
  const socketPath = path.join(homeDir, SOCKET_DIR_NAME, SOCKET_FILE_NAME)
  const daemonBin = path.join(buildDir, 'glasspaned')
  const settingsBin = path.join(buildDir, 'glasspane-settings')
  const daemonLog = path.join(homeDir, SOCKET_DIR_NAME, DAEMON_LOG_NAME)
  // 收尾那句"实测校验通过"要说实话，就得知道应答的实例是不是本次安装启动/重启的那一份。
  let servedByEarlierInstance = false
  // 本轮**没有**覆盖掉的 bundle（覆盖被回答跳过时磁盘上留的是上一轮的产物）：收尾的版本核对
  // 需要它，否则"同版本号"会被当成"就是本轮构建"（见 installVerification 的 declinedBundles）。
  let declinedBundles = []
  // bundle 安置计划（P1 v1.2 §11.1）：--no-app 时 appPackaged=false，后续一律
  // 回退裸二进制并如实告警。
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
    // 装的是钉住的 tag 那棵树：有提交过的 lockfile 就必须 `npm ci`，与被 CI/release 门
    // attest 的依赖树同一份（判据与理由见 npmDepsCommand）。
    const hasLockfile = fs.existsSync(path.join(rootDir, 'package-lock.json'))
    const depsCmd = npmDepsCommand({ hasLockfile })
    printStep(hasLockfile
      ? '安装 npm 依赖（workspaces: mcp-shell / installer / updater）——按提交过的 package-lock.json 走 npm ci……'
      : '安装 npm 依赖（workspaces: mcp-shell / installer / updater）——该树没有 package-lock.json，退回 npm install（依赖树未经 CI 那一份 lock 的 attest）……')
    await run('npm', depsCmd, { cwd: rootDir })

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
    // finding 11/12：`rm -rf ~/Applications/GlassPane*.app` 是本流程里的破坏性动作之一
    // （另有 bootout 已加载作业、结束在跑的实例）。`--no-prompt` 过去是**惰性**的——
    // confirm() 没有任何调用方，README 与 --help 却写着"跳过每步确认"。现在它真的有
    // 一档可跳过：交互终端里会问一句；`--no-prompt` 直接放行；非交互又没给 flag 则不覆盖
    // （install.sh 在 stdin 非 TTY 时**不代答**，它只把"这一趟会跳过什么"说出来——CI / e2e /
    //  `curl | sh` 要放行就自己带上 --no-prompt，见 install.sh 末节与 install-sh 那组用例）。
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
    declinedBundles = bundles.declined
    for (const app of bundles.installed) {
      printStep(`已安置：${app}`)
    }
    for (const app of bundles.declined) {
      printStep(paint(`未覆盖（回答跳过）：${app}——里面还是上一轮的产物`, 'yellow'))
    }
    // 备份位删不掉不是安置失败（新的一份已经在位），但也不能不说：它是个看得见、
    // 没人认领的目录，留在 ~/Applications 里下一次安装还得再挪一次。
    for (const leftover of bundles.leftovers ?? []) {
      printStep(paint(`已安置，但备份没能删净：${leftover}——手工 \`rm -rf\` 掉它即可，本轮结论不受影响`, 'yellow'))
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
    // **顺序要紧**：确认在写盘之前（见 launchdReregisterProbe 的注释）。
    let allowBootout = true
    const reregister = launchdReregisterProbe(daemonLaunch.path)
    if (reregister.loaded && reregister.needsReregister) {
      allowBootout = await confirm(
        `launchd 里已加载 ${LAUNCHD_LABEL}（程序：${reregister.program ?? '（未读到）'}），`
        + '卸载它才能换新定义——这会打断正在跑的 daemon',
        { autoYes: options.prompt === false },
      )
      if (!allowBootout) {
        throw new Error(`开机自启未重注册，且**没有**改写 ${plistPath}：未确认 bootout 已加载的 `
          + `${LAUNCHD_LABEL}（launchd 里跑的还是 ${reregister.program ?? '（未读到）'}）。`
          + '要保留旧作业就什么都不用做；要让新定义生效，在交互终端重跑本命令并回答继续，'
          + '或在脚本/自动化里显式加 --no-prompt。')
      }
    }
    // finding 7：这份 plist 写的是本机装了哪些可执行、socket 与日志的确切路径，
    // 过去以 0644 落在 ~/Library/LaunchAgents（同机任何账号可读），而
    // updater/lib/launchd.js 给自己的代理 plist 早就写 0600 并把模式读回。
    const plistWrite = writePrivatePlist(plistPath, plistXml)
    if (!plistWrite.ok) {
      throw new Error(`launchd plist 没能按 owner-only 落盘：${plistWrite.error}`)
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
    // 收拢旧实例这一步的全部判据在 `collectStaleInstances`（那里才有测试可指；
    // 从前这一段埋在 if 里，`ps` 没答话被当成"没有在跑的实例"，terminate 与
    // launchd 接管两道一起被跳过）。
    const stale = await collectStaleInstances({
      replaceDaemon: options.replaceDaemon,
      launchd: options.launchd,
      autoYes: options.prompt === false,
      socketPath,
    })
    const relaunchedByLaunchd = stale.relaunchedByLaunchd
    if (relaunchedByLaunchd || await socketReachable(socketPath)) {
      // launchd 刚 kickstart 起来的那一份算"本次重启的"；纯粹是 socket 早就有人听着，
      // 就是别人（很可能是上一版）在服务。
      servedByEarlierInstance = !relaunchedByLaunchd
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
  const builtVersion = builtDaemonVersion({ daemonBin })
  const { verified, note } = installVerification({
    arrived,
    helloVersion: hello?.version ?? null,
    builtVersion,
    servedByEarlierInstance,
    declinedBundles,
  })
  const outcome = installOutcome({ verified, daemonExpected })
  if (verified) {
    printStep(`实测校验通过：daemon 在 ${socketPath} 应答 hello（version=${hello.version}${hello.pid ? `，pid=${hello.pid}` : ''}，本轮构建产物=${builtVersion}）`)
    if (note) printStep(paint(note, 'yellow'))
    printStep(`安装完成（退出码 ${outcome.exitCode}）。`)
  } else if (daemonExpected) {
    if (note) printStep(paint(note, 'red'))
    for (const line of verificationFailureText({
      arrived,
      socketPath,
      daemonLog,
      cliPath: path.join(rootDir, 'installer', 'cli.js'),
      exitCode: outcome.exitCode,
      declinedBundles,
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

/** 入口守卫：直接用 node 运行本文件时才走安装流程（测试导入仅取函数）。
 *
 * 两侧都必须 realpath。`npm install -g` 和 `npx` 交付的是**符号链接**形式的 bin
 * （`<prefix>/bin/glasspane-install` → `../lib/node_modules/glasspane-install/cli.js`），
 * 而 node 把 ESM 入口按 realpath 载入，于是 `import.meta.url` 是被链接的那份、
 * `process.argv[1]` 是链接本身。只比 `pathToFileURL(process.argv[1]).href` 时两者恒不相等，
 * 下面整块 `if (isMain)` 一步都不走——退出码 0、stdout 与 stderr 全空：一条 README 里写着
 * "一键安装"的命令，在 npm/npx 这两条文档路径上安静地什么都不做。
 * realpathSync 对不存在的路径会抛，而这段在 import 期就执行，所以包起来：比不成＝
 * "不是被直接运行"，不是"崩掉整个模块"。
 */
function invokedAsEntrypoint() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

const isMain = invokedAsEntrypoint()

if (isMain) {
  // 入口的**每一条**退出都交给事件循环，没有例外。`curl | sh` 是文档里的调用形态，
  // stdout 接的是管道：`process.exit()` 抢在 flush 之前退，会把刚写出去的那几行
  // （usage、预检清单、restore 的判定句）连根截掉——而失败时用户能读的正是这几行。
  // 上一轮只把 install 的 .catch 改成了 `process.exitCode`，参数错误／--help／
  // --restore-launchd／环境预检这四条还留着 `process.exit()`；Linux runner 上就是
  // 从这里现形的（那台机器没有 swift，预检拒绝必然走到，而测试原本指望走到 install
  // 的拒绝分支——一条依赖机器状态的断言）。
  const { options, error, errorKind } = parseArgs(process.argv.slice(2))
  // **两入口对同一串 argv 的用法错规则**（2026-10-31 P1；同一份规则写在 install.sh 的 2c' 上面）：
  //   1. `--repo` 没接到取值、或接到的是一面旗标（`-` 开头，单双横线都算）——这是"这一层自己就
  //      说不通"的用法错，**先于 --help**：两条入口都退 2、都说那一句、都随后打 usage 页。
  //      带 --help 也一样退 2，因为 argv 在 --repo 那一枚上根本没写完。
  //   2. "未知参数"只有读了本文件的旗标清单才判得出来，而 install.sh 没有那份清单（也不许抄一份，
  //      那正是本仓反复修的"两份抄本没人对照"）。所以这一档在 --help 面前**让位**：给了 --help
  //      就是要这一页，两条入口都退 0 并打出各自那一页；没给 --help 时由这里退 2。
  //   3. 单独的 --help / -h 仍旧退 0（CI 的 install-gate 与两份 README 钉的就是那个 0）。
  // 从前这里是 `else if (error)` 排在 `else if (options.help)` 前面，两个 kind 一起压过 help，
  // 于是 `--help --no-such-flag` 在这一头退 2、在 install.sh 那一头退 0（实测）——同一串 argv
  // 两个码，而按 rc 分叉的调用方读到的"2 = 命令行写错了"在两条入口之间漂移。
  // 平台判据住在 cli.js 这一侧才是权威的：`uname` 是 PATH 上一个可以被换掉的程序（本轮实测：
  // 桩一个 `uname` 说 Linux，install.sh 那一道只管挡"要 clone 的那一趟"，源码在手边时一路走到
  // `exec node cli.js`，npm ci / tsc / swift build / launchd 注册全部真的发生），而
  // `process.platform` 是 node 向主机问来的，桩不掉。放在 --help / 参数错误 / --restore-launchd
  // 之后判：CI 的 install-gate 那一格跑在非 macOS 上，它读的正是 usage 与预检那几句。
  const refusal = (error || options.help || options.restoreLaunchd) ? null : platformRefusal()
  if (refusal) {
    process.stderr.write(paint(`\n${refusal}\n`, 'red'))
    process.exitCode = 1
  } else if (errorKind === 'repo-value') {
    process.stderr.write(`\n${paint(`参数错误：${error}`, 'red')}\n\n`)
    process.stderr.write(usageText())
    process.exitCode = 2
  } else if (options.help) {
    process.stdout.write(usageText())
    process.exitCode = 0
  } else if (error) {
    process.stderr.write(`\n${paint(`参数错误：${error}`, 'red')}\n\n`)
    process.stderr.write(usageText())
    process.exitCode = 2
  } else if (options.restoreLaunchd) {
    // 审计项④：恢复 + 校验全机器化，退出码即判定（0=daemon 就位且已按实际
    // 自报如实报告；1=作业/服务面失败），agent 可直接执行并按 message 续办。
    // finding C3：这一支也可能 bootout 一个已加载作业，所以它读同一个同意门——
    // `--no-prompt` 是唯一的显式放行，交互终端问一句，非交互又没给旗标就拒且零改动。
    const result = await restoreLaunchd({ autoYes: options.prompt === false })
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