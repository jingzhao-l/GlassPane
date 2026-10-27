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
import { spawnSync } from 'node:child_process'

export const VERBS = Object.freeze(['update', 'doctor', 'status', 'help'])
/** 用法里的同义写法：读不出"同一条命令的两种问法"就没有可比性，所以别名是一张明面上的表。 */
export const VERB_ALIASES = Object.freeze({ '-h': 'help', '--help': 'help' })
export const DAEMON_JOB_LABEL = 'com.glasspane.daemon'
export const NPM_PACKAGES = Object.freeze(['glasspane-mcp', 'glasspane-install'])
/** The three answers a read may give. `unverified` is the one that used to be missing everywhere. */
export const READS = Object.freeze({ available: 'available', absent: 'absent', unverified: 'unverified' })

const POINTER_NAME = 'update-install.json'
const STATE_NAME = 'update-state.json'

/** Where this machine keeps GlassPane's state, and who said so. */
export function stateRootOf({ env = process.env, homeDir = null } = {}) {
  const named = String(env.GLASSPANE_STATE_DIR ?? '').trim()
  if (named !== '') return { stateRoot: path.resolve(named), source: 'GLASSPANE_STATE_DIR' }
  const home = String(homeDir ?? (typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : safeHomedir()) ?? '').trim()
  if (home === '') return { stateRoot: null, source: '读不到家目录（HOME 未设置，os.homedir() 也没答）' }
  return { stateRoot: path.join(home, '.glasspane'), source: '默认（<HOME>/.glasspane）' }
}

function safeHomedir() {
  try {
    return os.homedir()
  } catch {
    return null
  }
}

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
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  exists = (p) => fs.existsSync(p),
  spawn = spawnSync,
  execPath = process.execPath,
  uid = null,
  runLaunchctl = null,
} = {}) {
  const { stateRoot, source } = stateRootOf({ env, homeDir })
  const out = []

  out.push(stateRoot === null
    ? { name: '状态根', read: READS.unverified, detail: source, remedy: 'export HOME=/Users/<你> 后重跑（这个产品把状态放在家目录下是刻意的）。' }
    : { name: '状态根', read: READS.available, detail: `${stateRoot}（${source}）`, remedy: null })

  const pointer = readInstallPointer({ stateRoot, readFile, exists })
  out.push({
    name: '安装指针',
    read: pointer.read,
    detail: pointer.read === READS.available
      ? `${pointer.updaterCli}（安装根 ${pointer.installRoot ?? '未记'}）`
      : pointer.reason,
    remedy: pointer.remedy ?? (pointer.read === READS.unverified ? '这一份是安装器写的 JSON，读不出来通常意味着它被手改过：重跑安装程序覆盖它。' : null),
  })

  if (pointer.read !== READS.available) {
    out.push({ name: '更新器状态', read: READS.unverified, detail: '没有可跑的更新脚本，这一格没问', remedy: '先把上面那一格修好。' })
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
    ? { read: READS.unverified, detail: '没有状态根，socket 路径无从得出' }
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
    out.push({
      name: '全局 npm 包',
      read: missing.length === 0 ? READS.available : READS.absent,
      detail: seen.join(' '),
      remedy: missing.length === 0 ? null
        : `补法（不需要权限，取的是 registry 的发布物）：npm install -g ${NPM_PACKAGES.map((n) => `${n}@<版本>`).join(' ')}`,
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

export async function main({ argv = process.argv.slice(2), env = process.env, spawn = spawnSync, write = (line) => process.stdout.write(`${line}\n`), fail = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const parsed = parseVerb(argv)
  if (parsed.error) {
    fail(`${parsed.error}。\n\n${usageText()}`)
    return 2
  }
  if (parsed.verb === 'help') {
    write(usageText())
    return 0
  }
  const { stateRoot } = stateRootOf({ env })
  const pointer = readInstallPointer({ stateRoot, readFile: (p) => fs.readFileSync(p, 'utf8'), exists: (p) => fs.existsSync(p) })
  if (parsed.verb === 'doctor') {
    const report = doctorReport(doctorReadings({ env, spawn }))
    write(report.text)
    return report.ok ? 0 : 3
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

const invokedDirectly = process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code
  }, (error) => {
    process.stderr.write(`glasspane 自己出了错：${error?.message ?? String(error)}\n`)
    process.exitCode = 3
  })
}
