#!/usr/bin/env node
/**
 * `glasspane` — the one command an installed machine should need.
 *
 * Why this file exists. Until 2026-10-26 the machine had two ways to update itself and neither was a
 * command a person would remember: the settings panel's button (which runs the updater as the *GUI's*
 * child, and whose failure this package could not distinguish from the daemon's refusal to be restarted),
 * and `node <那个 checkout>/updater/cli.js apply` (which needs the install root, which is exactly the
 * thing people lose track of). The other complaint measured the same day: `npx glasspane-install` re-ran
 * `git clone` into `~/glasspane`, git said "destination path … already exists", and the reader was told
 * to change directory — forever, because the next run would look in the same place.
 *
 * So this is a *thin* bin, added to the same package that already owns the one-command install (adding a
 * third bare-name package would be a third thing to version, sign and keep in step):
 *
 *   glasspane update   ask for an update and run it, through the updater this machine is already
 *                      installed with — never through a copy guessed from the current directory
 *   glasspane doctor   read the machine: install pointer, updater state, the loaded daemon job, the
 *                      socket, and the two global npm packages. Reads only; every line answers
 *                      available / absent / unverified, because "I could not look" is not "there is
 *                      nothing there" (`installer/cli.js`'s PROBE_STATES is the same rule)
 *   glasspane status   the updater's own one-line summary, verbatim
 *
 * What it deliberately does not do: no `sudo`, no npm escalation, no deleting anything. Where a repair
 * needs a person, it prints the tool and the two directories involved, the same way the updater's remedy
 * sentences do (SECURITY.md §3: a remedy may name a tool, it may not hand out an executable escalation).
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const VERBS = Object.freeze(['update', 'doctor', 'status', 'help'])
/** 用法里的同义写法：读不出"同一条命令的两种问法"就没有可比性，所以别名是一张明面上的表。 */
export const VERB_ALIASES = Object.freeze({ '-h': 'help', '--help': 'help' })
export const DAEMON_JOB_LABEL = 'com.glasspane.daemon'
export const NPM_PACKAGES = Object.freeze(['glasspane-mcp', 'glasspane-install'])
/**
 * The one line the npm remedy prints. It carries **no version placeholder on purpose**: the previous
 * shape pinned each package to a version written inside angle brackets, and that opening bracket is a
 * shell redirection — `/bin/sh -c '<那整行>'` fails with a syntax error (measured 2026-10-29, exit 2),
 * so an agent copying the remedy could not even start the command. No version means "the registry's
 * latest", which is what a missing package wants; pinning is a separate, explicit step
 * (`npm view <pkg> versions`), and the remedy says so in prose instead of shipping an uncopyable token.
 * Named and exported so a test can assert that *what is printed* is *what runs* — never a second copy
 * of the command living in a template string.
 */
export const NPM_GLOBAL_INSTALL_CMD = `npm install -g ${NPM_PACKAGES.join(' ')}`
/** The three answers a read may give. `unverified` is the one that used to be missing everywhere. */
export const READS = Object.freeze({ available: 'available', absent: 'absent', unverified: 'unverified' })

/** 要印进"可照抄的一行"里的原文，先剥掉 shell 元字符：npm 自己的原话带着 `'`、`<`、`|` 时，
 *  那句话就不再能被 /bin/sh 解析了（S7-5 测的正是这一族）。裁的是元字符，不是信息。 */
function shellSafe(text) {
  return String(text ?? '').replace(/[\n\r]/g, ' ').replace(/[<>&|;'"`\\$()]/g, '')
}

/**
 * Is this machine's global npm prefix writable by *this* user? Three answers, same rule as READS:
 * the claim printed in the remedy ("不需要权限") used to be backed by no probe at all — neither
 * `npm prefix -g` nor a W_OK check happened anywhere in this file (or in the whole installer shard).
 * `unverified` is therefore an answer of its own: "I could not look" is not "you do not need permission",
 * and it is certainly not an escalation command.
 */
export function probeGlobalNpmPrefix({
  spawn = spawnSync,
  exists = (p) => fs.existsSync(p),
  writable = (p) => {
    try {
      fs.accessSync(p, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  },
} = {}) {
  const res = spawn('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 30_000 })
  const status = typeof res?.status === 'number' ? res.status : null
  if (status !== 0) {
    return {
      read: READS.unverified,
      prefix: null,
      target: null,
      writable: null,
      reason: status === null
        ? `npm prefix -g 没答话（${res?.error?.message ?? String(res?.error ?? '没有退出码')}）`
        : `npm prefix -g 退出 ${status}`,
    }
  }
  const prefix = String(res.stdout ?? '').trim()
  if (prefix === '') return { read: READS.unverified, prefix: null, target: null, writable: null, reason: 'npm prefix -g 退 0 而答案是空的' }
  // npm 真正落包的是 `<prefix>/lib/node_modules`；那一级不存在时退到 `lib`、再退到前缀本身——
  // 要判的是"这一趟能不能写进去"，所以问的是盘上真在的那一级。
  const target = [path.join(prefix, 'lib', 'node_modules'), path.join(prefix, 'lib'), prefix].find((p) => exists(p)) ?? null
  if (target === null) {
    return { read: READS.unverified, prefix, target: null, writable: null, reason: `全局前缀 ${prefix} 在盘上不存在（lib/node_modules、lib、前缀本身三级都没读到目录）` }
  }
  return { read: READS.available, prefix, target, writable: writable(target) === true, reason: null }
}

/**
 * The remedy line, composed from the probe's answer (pure: the three shapes are unit-testable without
 * touching a machine). Never an escalation: when the prefix is not ours to write, the sentence names the
 * prefix and the directory that refused W_OK and points at moving the prefix under the user — it does
 * not hand out a privileged command (SECURITY.md §3, and this file's own header).
 */
export function npmGlobalRemedy({ missing = [], prefixState } = {}) {
  const named = missing.map((name) => shellSafe(name)).join(' ')
  const cmd = NPM_GLOBAL_INSTALL_CMD
  if (!prefixState || prefixState.read !== READS.available) {
    const why = prefixState?.reason ?? '这一问没有答案'
    return `补法（全局 npm 前缀的可写性**未验证**——${shellSafe(why)}；这一问没答案，所以这一条不替你保证免权限）：`
      + `先让 npm prefix -g 能答话，再照这一行装 ${cmd}。不带版本号=取 registry 最新发布物，`
      + `要钉版本先跑 npm view glasspane-mcp versions。缺的是 ${named || '（没读出来）'}。`
  }
  if (prefixState.writable === true) {
    return `补法（不需要权限——本机探测过：全局前缀 ${shellSafe(prefixState.target)} 对本账号可写 W_OK）：${cmd}。`
      + `不带版本号=取 registry 最新发布物，要钉版本先跑 npm view glasspane-mcp versions。缺的是 ${named}。`
  }
  return `补法（**不给升权命令**：这台机器的全局 npm 前缀不可写——前缀 ${shellSafe(prefixState.prefix)}，`
    + `探测的是 ${shellSafe(prefixState.target)}，它对 W_OK 答"不可写"）。装进系统前缀不是这一层能替你做的事。`
    + `下一步：先 npm config set prefix 指到一个你自己可写的目录（或用一个自带前缀的 Node 版本，nvm 就是这一档），`
    + `再跑 ${cmd}（不带版本号=取 registry 最新发布物，要钉版本先跑 npm view glasspane-mcp versions）。缺的是 ${named}。`
}


const POINTER_NAME = 'update-install.json'
const STATE_NAME = 'update-state.json'

/**
 * Where this machine keeps GlassPane's state, and who said so.
 *
 * 顺序只有两级：`GLASSPANE_STATE_DIR`，然后是**口令档案**（`os.userInfo().homedir`）里的家目录。
 * 中间没有 `$HOME`：`os.homedir()` 与 `$HOME` 都是调用方手里的那个变量，而这条产品的每一条入口
 * 读的都是档案那一份——面板的 `NSHomeDirectory()`、daemon 的 `StateRoot.homeDefault()`、更新器的
 * `recordHomeDir()`（`updater/cli.js` 里那句 "this process has no password-database record, so the
 * state root cannot be named; pass --state-dir"）、`mcp-shell` 的 `recordHome()`。一个被重定向的
 * `$HOME` 在这里意味着读一份"谁都不认识的机器"的状态：doctor 会对着一台装好的机器说指针缺席,
 * `gp_diagnose` 点的是另一个文件，`runUpdate` 则把 `--state-dir <错根>` 交给真正的更新器去写。
 * 档案读不到就是**拒绝**（`stateRoot: null`），不回退 `$HOME`、也不回退 `os.homedir()`——与
 * `update-state.ts` 的 `recordHome()` 同一条规矩，同一个理由。
 * `homeDir` 与 `readRecord` 是调用方/测试的注入口（`readRecord` 默认读真实档案），不是第三级优先级。
 */
export function stateRootOf({ env = process.env, homeDir = null, readRecord = passwdHome } = {}) {
  const named = String(env.GLASSPANE_STATE_DIR ?? '').trim()
  if (named !== '') return { stateRoot: path.resolve(named), source: 'GLASSPANE_STATE_DIR' }
  const home = String(homeDir ?? readRecord() ?? '').trim()
  if (home === '') {
    return { stateRoot: null, source: '读不到口令档案里的家目录（os.userInfo() 没答或答了空的），而本产品不用 $HOME' }
  }
  return { stateRoot: path.join(home, '.glasspane'), source: '默认（口令档案的家目录/.glasspane）' }
}

/** 口令档案里的那个家目录；读不到（没有档案的进程、root 起的 daemon）就是 null，不猜。 */
function passwdHome() {
  try {
    const info = os.userInfo()
    const home = typeof info?.homedir === 'string' ? info.homedir.trim() : ''
    return home === '' ? null : home
  } catch {
    return null
  }
}

/**
 * 根读不出时唯一做得动的下一步。写 `--state-dir` 是因为那是更新器自己收的那面旗
 * （`updater/cli.js` 的用法里就有它），而 `glasspane` 这一条不收；`export HOME=…` 那句是从前
 * 印上去的假补救——它把裂缝制度化，改的变量没有一处在读。
 */
export const STATE_ROOT_REMEDY = '这一格答的是"读不出"，不是"没有"。下一步二选一：把根点名给更新器自己那支'
  + '（`node <update-install.json 里那份 cli.js> status|check|apply --json --state-dir <状态根>`，别把 `--state-dir null` 交给它），'
  + '或修好这个账号的口令档案（`dscl . -read /Users/<账号> NFSHomeDirectory`）。重定向 `$HOME` 不改变这里的答案。'

/**
 * The install pointer: the one file that says which updater this machine is installed with. Three states,
 * because the remedy differs: absent (never installed / a state root that isn't ours), unreadable (a file
 * that exists and does not parse — a person's problem, not a re-install's), and a pointer whose
 * `updaterCli` no longer exists on disk (a moved or deleted checkout — §11's whole reason the pointer
 * exists, and the case where "run the installer again" is the honest answer).
 */
export function readInstallPointer({ stateRoot, readFile = (p) => fs.readFileSync(p, 'utf8'), exists = (p) => fs.existsSync(p) } = {}) {
  if (!stateRoot) return { read: READS.unverified, reason: '没有状态根可读', pointerPath: null }
  const pointerPath = path.join(stateRoot, POINTER_NAME)
  let text = null
  try {
    text = readFile(pointerPath)
  } catch (error) {
    const missing = error?.code === 'ENOENT'
    return {
      read: missing ? READS.absent : READS.unverified,
      reason: missing ? `${pointerPath} 不存在` : `${pointerPath} 读不出来（${error?.message ?? String(error)}）`,
      pointerPath,
    }
  }
  let pointer = null
  try {
    pointer = JSON.parse(text)
  } catch (error) {
    return { read: READS.unverified, reason: `${pointerPath} 不是合法 JSON（${error.message}）`, pointerPath }
  }
  const updaterCli = typeof pointer?.updaterCli === 'string' && pointer.updaterCli !== '' ? pointer.updaterCli : null
  if (updaterCli === null) return { read: READS.unverified, reason: `${pointerPath} 里没有 updaterCli 这一项`, pointerPath, pointer }
  if (!exists(updaterCli)) {
    return {
      read: READS.absent,
      reason: `指针指向的更新脚本不在盘上：${updaterCli}（那份 checkout 被移动或删除了）`,
      remedy: '重跑一次安装程序（node installer/cli.js 或 curl -fsSL <安装脚本> | sh），它会重写指针并把代理指回稳定入口。',
      pointerPath,
      pointer,
      updaterCli,
    }
  }
  return { read: READS.available, reason: null, pointerPath, pointer, updaterCli, installRoot: pointer?.installRoot ?? null }
}

/** One child process, answered as data: did it run, what did it print, what did it exit with. */
export function spawnJson(bin, args, { spawn = spawnSync, timeoutMs = 120_000 } = {}) {
  const res = spawn(bin, args, { encoding: 'utf8', timeout: timeoutMs })
  const status = typeof res?.status === 'number' ? res.status : null
  const stdout = String(res?.stdout ?? '')
  const stderr = String(res?.stderr ?? '').trim()
  // Two documents, two shapes, and getting this wrong reads a healthy machine as a silent one:
  // the updater CLI answers **one line** of JSON (its contract with the panel and `gp_diagnose`), while
  // `npm ls -g --json` answers **pretty-printed multi-line JSON** (measured here against npm 11). A
  // reader that took the last line got `}` and reported "npm 答的不是那份 JSON" about a prefix that
  // named every package on the machine. So: the whole document first, the last line only as a fallback
  // for a stream that carried a log line before the answer.
  const parse = (text) => {
    const trimmed = String(text ?? '').trim()
    if (trimmed === '') return null
    try {
      return JSON.parse(trimmed)
    } catch {
      /* not the whole document */
    }
    const last = trimmed.split('\n').filter((line) => line !== '').pop()
    try {
      return JSON.parse(last)
    } catch {
      return null
    }
  }
  const json = parse(stdout)
  return {
    read: status === null ? READS.unverified : READS.available,
    status,
    json,
    stdout,
    stderr,
    reason: status === null
      ? `${bin} 没答话（${res?.error?.message ?? String(res?.error ?? '没有退出码')}）`
      : json === null && stdout.trim() !== ''
        ? `${bin} 答的不是那份 JSON（前 120 字：${stdout.trim().slice(0, 120)}）`
        : null,
  }
}

/**
 * The doctor's six readings. Each returns `{ name, read, detail, remedy }`, and `remedy` is only ever the
 * command this tool can already see working — never an invented path, never an escalation.
 */
export function doctorReadings({
  env = process.env,
  homeDir = null,
  readRecord = passwdHome,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  exists = (p) => fs.existsSync(p),
  spawn = spawnSync,
  execPath = process.execPath,
  uid = null,
  runLaunchctl = null,
} = {}) {
  const { stateRoot, source } = stateRootOf({ env, homeDir, readRecord })
  const rootUnknown = stateRoot === null
  const out = []

  out.push(rootUnknown
    ? { name: '状态根', read: READS.unverified, detail: `这一格是未验证（unverified）：${source}`, remedy: STATE_ROOT_REMEDY }
    : { name: '状态根', read: READS.available, detail: `${stateRoot}（${source}）`, remedy: null })

  const pointer = readInstallPointer({ stateRoot, readFile, exists })
  out.push({
    name: '安装指针',
    read: pointer.read,
    detail: pointer.read === READS.available
      ? `${pointer.updaterCli}（安装根 ${pointer.installRoot ?? '未记'}）`
      : rootUnknown
        // 根没读出来时就只到这一步：那句"update-install.json 不存在"是对着一台装好的机器说的假缺席。
        ? `状态根没读出来（${source}），所以没有去查 ${POINTER_NAME}——这一格是未验证（unverified），不是"这台机器没装"。`
        : pointer.reason,
    remedy: pointer.remedy ?? (rootUnknown
      ? STATE_ROOT_REMEDY
      : pointer.read === READS.unverified ? '这一份是安装器写的 JSON，读不出来通常意味着它被手改过：重跑安装程序覆盖它。' : null),
  })

  if (pointer.read !== READS.available) {
    out.push({
      name: '更新器状态',
      read: READS.unverified,
      detail: rootUnknown ? '状态根没读出来，所以没问更新器——问它也要给它 `--state-dir`。' : '没有可跑的更新脚本，这一格没问',
      remedy: rootUnknown ? STATE_ROOT_REMEDY : '先把上面那一格修好。',
    })
    out.push({ name: '定时代理', read: READS.unverified, detail: '同上', remedy: null })
  } else {
    const status = spawnJson(execPath, [pointer.updaterCli, 'status', '--json', '--state-dir', stateRoot], { spawn })
    // `status --json` 的那一份文档把状态**整体**放在 `state` 里（顶层只有 command/status/code/
    // message/exitCode）。在本机量过一次：按顶层读 `current` 得到的是空,于是 doctor 对着一台装着
    // 1.6.2、最新 1.21.0 的机器答"装着=?"——一个读错字段的读数比不读更容易骗人。
    const doc = status.json?.state ?? status.json ?? {}
    out.push(status.read === READS.available && status.json
      ? {
        name: '更新器状态',
        read: READS.available,
        detail: `status=${status.json.status ?? '?'} 装着=${doc.current ?? '?'} 最新=${doc.latest ?? '未查'} `
          + `待装=${doc.staged?.version ?? '没有'} code=${status.json.code ?? '无'}`,
        // 状态里挂着的代号是这台机器**现在**的降级原因（`npm-not-refreshed`、`runtime-stale` 这一类）。
        // 只把 message 摘要抄过来是不够的：读 doctor 的人要先知道是哪一格,才有办法决定去不去读原话。
        remedy: status.json.code
          ? `这一格挂在状态里的代号是 ${status.json.code}：${String(status.json.message ?? status.json.lastError?.message ?? '（没给原话）').slice(0, 200)}`
          : null,
      }
      : { name: '更新器状态', read: READS.unverified, detail: status.reason ?? `${pointer.updaterCli} status 退出 ${status.status}：${status.stderr.slice(0, 160)}`, remedy: null })

    const launchctl = runLaunchctl ?? ((args) => {
      const res = spawn('launchctl', args, { encoding: 'utf8', timeout: 15_000 })
      return { status: typeof res?.status === 'number' ? res.status : null, stdout: res?.stdout ?? '', stderr: String(res?.stderr ?? '') + (res?.error ? ` ${res.error.message ?? res.error}` : '') }
    })
    const who = uid ?? (typeof process.getuid === 'function' ? String(process.getuid()) : null)
    const job = who === null
      ? { read: READS.unverified, detail: '读不到 uid（id -u 没答），所以没问 launchd' }
      : (() => {
        const res = launchctl(['print', `gui/${who}/${DAEMON_JOB_LABEL}`])
        const text = String(res?.stdout ?? '')
        if (res?.status === 0) {
          const state = /(?:^|\n)\s*state\s*=\s*(\S+)/.exec(text)
          return { read: READS.available, detail: `在册作业装载着，state=${state ? state[1] : '未给出'}` }
        }
        if (res?.status === 113 || /could not find service|does not exist/i.test(String(res?.stderr ?? ''))) {
          return { read: READS.absent, detail: `launchd 说它没有 gui/${who}/${DAEMON_JOB_LABEL} 这个作业`, remedy: '重跑安装程序（node installer/cli.js）——它会重新注册 daemon 作业，并在动手前问一句。' }
        }
        // 答不了就是答不了：这一支从前把 launchd 的沉默写成"没这个作业"，于是 daemon 明明在册、
        // doctor 却说它缺席——缺席与不知道是两件事，补救也不同（一个是重装，一个是先让这一问能问出去）。
        return { read: READS.unverified, detail: `launchctl print 退出 ${String(res?.status ?? 'null')}：${String(res?.stderr ?? '').trim().slice(0, 160) || '没有 stderr'}` }
      })()
    out.push({ name: '定时代理', read: job.read, detail: job.detail, remedy: job.remedy ?? null })
  }

  const socketPath = stateRoot ? path.join(stateRoot, 'engine.sock') : null
  const socket = socketPath === null
    ? { read: READS.unverified, detail: `状态根没读出来（${source}），socket 路径无从得出——没查过盘，所以不说它不在` }
    : exists(socketPath)
      ? { read: READS.available, detail: socketPath }
      : { read: READS.absent, detail: `${socketPath} 不在：daemon 没在跑（或这台机器上它注册在别的状态根）` }
  out.push({ name: '引擎 socket', read: socket.read, detail: socket.detail, remedy: socket.read === READS.absent ? '启动 daemon：open "GlassPane Daemon.app"，或重跑安装程序最后那一支。' : null })

  const npm = spawnJson('npm', ['ls', '-g', '--depth=0', '--json'], { spawn })
  if (npm.read !== READS.available || npm.json === null) {
    out.push({
      name: '全局 npm 包',
      read: READS.unverified,
      detail: npm.reason ?? `npm ls -g 退出 ${npm.status}：${npm.stderr.slice(0, 120) || '没有 stderr'}`,
      remedy: '够不着 npm 时，这一格只能答"不知道"；先确认这个账号能跑到 npm。',
    })
  } else {
    const deps = npm.json.dependencies ?? {}
    const seen = NPM_PACKAGES.map((name) => `${name}=${deps[name]?.version ?? '没装'}`)
    const missing = NPM_PACKAGES.filter((name) => !deps[name])
    // 缺包时要不要说"不需要权限"，由这台机器答，不由这句话答（S7-5）：先探一次全局前缀。
    // 探测排在读完全局包之后、只在真要给出补法时才问——都在位时没人需要这一行。
    out.push({
      name: '全局 npm 包',
      read: missing.length === 0 ? READS.available : READS.absent,
      detail: seen.join(' '),
      remedy: missing.length === 0 ? null
        : npmGlobalRemedy({ missing, prefixState: probeGlobalNpmPrefix({ spawn, exists }) }),
    })
  }

  return out
}

/** The shape of `glasspane doctor`'s answer: one line per reading, plus the exit-code rule. */
export function doctorReport(readings) {
  const lines = readings.map((one) => `· ${one.name}：${one.detail}${one.remedy ? `\n    下一步：${one.remedy}` : ''}`)
  const unhealthy = readings.filter((one) => one.read !== READS.available)
  const verdict = unhealthy.length === 0
    ? '六格都答了话且都在位。'
    : `${unhealthy.length}/${readings.length} 格不在位或答不了话：${unhealthy.map((one) => `${one.name}(${one.read})`).join('、')}`
  return { text: `${lines.join('\n')}\n${verdict}`, ok: unhealthy.length === 0 }
}

export function usageText() {
  return [
    '用法：glasspane <命令>',
    '',
    '  update    问一次有没有新版本，有就装（走这台机器已经装着的那个更新器）',
    '  status    把更新器自己的那一行结论原样打出来',
    '  doctor    读这台机器的安装状态（安装指针、更新器、daemon 作业、socket、全局 npm 包）——只读，不写',
    '  help      这一页（`-h`、`--help` 同义）',
    '',
    '退出码：0 = 成/都在位；2 = 用法错；3 = 被拒或有一格不在位（doctor 用它表示"有东西要看上面那几行"）；',
    '4/5 来自 update（换版后回退 / 回退也没成），与更新器本身的口径一致。',
    '本命令不 sudo、不删东西：需要人做的那一步只会把工具名与目录写出来，不会给成可照抄的升权命令。',
  ].join('\n')
}

export function parseVerb(argv) {
  const first = String(argv?.[0] ?? '')
  if (argv.length === 0) return { verb: null, error: '没给命令' }
  // `-h` / `--help` 与 `help` 同义：这条命令是本产品给 agent 的入口，而 agent 的第一反应就是
  // `--help`。2026-10-27 用发布物实测：`/usr/local/bin/glasspane --help` 回"不认得命令「--help」"
  // 且退出 2——同产品的 `installer/cli.js` 认 `--help`，两条入口对同一种问法给两种答案。
  const verb = VERB_ALIASES[first] ?? first
  if (!VERBS.includes(verb)) return { verb: null, error: `不认得命令「${first}」` }
  return { verb, error: null, rest: argv.slice(1) }
}

/**
 * `update` = the updater's own two steps, in its own words. It runs `check` first (an update has to be
 * staged before `apply` will move anything), and hands the *updater's* exit code back: 3 from `check`
 * means "nothing staged / unreachable", which is a refusal, not a failure — and this command has no
 * business re-interpreting that as its own verdict.
 */
export async function runUpdate({ execPath = process.execPath, updaterCli, stateRoot, spawn = spawnSync, write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  // 状态根读不出来时不能把 `--state-dir null` 交给更新器：那个字符串会被拼成一个名叫 `null` 的目录
  // （或按更新器的口径拒掉），两种都不是"这台机器的根"——写进去的那一份没有别的读者。一个子进程都不起。
  if (typeof stateRoot !== 'string' || stateRoot.trim() === '') {
    write(`没有状态根，更新器无从知道往哪儿写：这一趟一次子进程都没起。${STATE_ROOT_REMEDY}`)
    return { exitCode: 3, stage: 'state-root' }
  }
  const check = spawnJson(execPath, [updaterCli, 'check', '--json', '--state-dir', stateRoot], { spawn })
  if (check.read !== READS.available || check.json === null) {
    write(`检查没答话：${check.reason ?? `退出 ${check.status}：${check.stderr.slice(0, 200)}`}`)
    return { exitCode: check.status ?? 3, stage: 'check' }
  }
  write(`检查：${check.json.message ?? check.json.status}`)
  if (check.json.status === 'up-to-date') {
    write('已经是最新，没有要装的东西。')
    return { exitCode: 0, stage: 'check' }
  }
  // 检查这一格的非零退出就是"这一趟停在这里"：`deferred`/`needs-consent`/`check-failed` 都带着它自己的
  // 原因与代号。从前这里读的是一个不存在的字段（`exitCode`，而子进程答的是 `status`），于是条件恒假,
  // 一次"daemon 正忙"的拒绝被接着送去 apply，屏幕上就多出一条没做过的安装。
  if (check.status !== 0) {
    write(`检查停在 ${check.json.status}（code=${check.json.code ?? '未给出'}，退出码 ${check.status}），没有进入安装。`)
    return { exitCode: check.status ?? 3, stage: 'check', json: check.json }
  }
  const apply = spawnJson(execPath, [updaterCli, 'apply', '--json', '--state-dir', stateRoot], { spawn })
  if (apply.read !== READS.available || apply.json === null) {
    write(`安装没答话：${apply.reason ?? `退出 ${apply.status}：${apply.stderr.slice(0, 200)}`}`)
    return { exitCode: apply.status ?? 3, stage: 'apply' }
  }
  write(`安装：${apply.json.message ?? apply.json.status}`)
  if (apply.json.code) write(`（这一格的代号：${apply.json.code}——它挂在状态里，面板与 gp_diagnose 也读得到。）`)
  return { exitCode: apply.status ?? 0, stage: 'apply', json: apply.json }
}

export async function main({ argv = process.argv.slice(2), env = process.env, readRecord = passwdHome, spawn = spawnSync, write = (line) => process.stdout.write(`${line}\n`), fail = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const parsed = parseVerb(argv)
  if (parsed.error) {
    fail(`${parsed.error}。\n\n${usageText()}`)
    return 2
  }
  if (parsed.verb === 'help') {
    write(usageText())
    return 0
  }
  const { stateRoot, source } = stateRootOf({ env, readRecord })
  const pointer = readInstallPointer({ stateRoot, readFile: (p) => fs.readFileSync(p, 'utf8'), exists: (p) => fs.existsSync(p) })
  if (parsed.verb === 'doctor') {
    const report = doctorReport(doctorReadings({ env, readRecord, spawn }))
    write(report.text)
    return report.ok ? 0 : 3
  }
  // `doctor` 可以在读不出根的时候照常出六格（每格答自己的"不知道"），`update` 与 `status` 不行:
  // 它们要把这一问交给更新器，而交出去的 `--state-dir` 需要一个真的根。放在指针那一问之前,
  // 是为了让屏幕上的原因停在"根读不出"这一件事实上，而不是停在一个跟着来的假缺席。
  if (stateRoot === null) {
    fail(`读不出这台机器的状态根（${source}），所以更新器要写哪儿我们不知道：这一趟没动手。\n${STATE_ROOT_REMEDY}`)
    return 3
  }
  if (pointer.read !== READS.available) {
    fail(`这台机器的安装指针读不出可用的一份更新器：${pointer.reason}\n${pointer.remedy ?? ''}`)
    return 3
  }
  if (parsed.verb === 'status') {
    const status = spawnJson(process.execPath, [pointer.updaterCli, 'status', '--json', '--state-dir', stateRoot], { spawn })
    if (status.read !== READS.available || status.json === null) {
      fail(`更新器没答话：${status.reason ?? status.stderr.slice(0, 200)}`)
      return 3
    }
    const doc = status.json.state ?? status.json
    write(`${status.json.status}｜装着 ${doc.current ?? '?'}｜最新 ${doc.latest ?? '未查'}｜待装 ${doc.staged?.version ?? '没有'}｜代号 ${status.json.code ?? '无'}`)
    if (status.json.message) write(status.json.message)
    return status.status ?? 0
  }
  const result = await runUpdate({ updaterCli: pointer.updaterCli, stateRoot, spawn, write })
  return result.exitCode
}

// Both sides must be realpath-resolved, not merely resolved against the cwd, and the comparison is
// wrapped because `realpathSync` throws for paths that do not exist yet — this runs at import time, so
// an uncomparable pair means "not invoked as a command", never "crash the entry". The URL is decoded
// with `fileURLToPath`, not read through `.pathname`: `.pathname` leaves a path containing a space or a
// CJK character percent-encoded (`/Users/John%20Smith/…`), which names no existing file, so the guard
// threw and `glasspane <任何动词>` died with a stack trace for every account whose home needs encoding.
// `updater/agent-entry.js` carries the same rule; this file was the face that never got it.
function invokedAsCommand() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedAsCommand()) {
  main().then((code) => {
    process.exitCode = code
  }, (error) => {
    process.stderr.write(`glasspane 自己出了错：${error?.message ?? String(error)}\n`)
    process.exitCode = 3
  })
}
