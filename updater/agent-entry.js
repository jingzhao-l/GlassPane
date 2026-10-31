#!/usr/bin/env node
/**
 * The update agent's stable entry point — 与版本无关的那一个路径。
 *
 * 为什么要有这个文件：launchd 的作业定义里写着它要执行的那条命令，而"谁在跑更新"这件事由
 * `<状态根>/update-install.json` 的 `updaterCli` 决定（§7）。以前这两件事是同一个字符串——每次换版
 * 都要把 plist 重新渲染、`bootout` 再 `bootstrap` 才能把作业搬到新那份代码上。于是
 * "定时作业自己换自己"这件事在结构上就不可能一次做完：`bootout` 会把正在跑这次换版的作业拆掉。
 * 上一次的处理办法是让定时那一次只换代码与指针、把注册留给**人**去翻一次开关（§11 原第 6 条的
 * `skipped`）——那等于把"修更新器的那次发版"重新变成一次人工动作，正是这一整节要消灭的东西。
 *
 * 现在作业永远指向这里，这里再去读指针。换版剩下的动作就只有"写一个文件"：指针翻过去，明早的作业
 * 自然跑新那份代码，不需要重新注册，也不存在"作业指着已被删掉的目录"这一整类形状。
 *
 * 这个文件**不 import 本仓任何东西**（它被复制到状态根里独立运行，跟着 `updater/` 的版本走就等于
 * 又回到原点），并且只用 node 内置模块。它做三件事：
 *   1. 按 CLI 自己的优先级认状态根：`--state-root`/`--state-dir` → `GLASSPANE_STATE_DIR` → `~/.glasspane`；
 *   2. 读指针拿 `updaterCli`；读不出、文件不在 ⇒ 一句带 remedy 的拒绝（非 0 退出），
 *      而不是让 node 抛 `Cannot find module` 混进日志；
 *   3. 把**收到的参数原样**交给那份 CLI，stdio 继承，退出码原样转达。
 *
 * 信任边界要说清（这是设计的一部分，不是实现细节）：今天"改指针"还需要一次注册动作做中介；从这里
 * 起，指针一改，下一次定时作业就跑新那份代码。写得到状态根的人本来就能改指针、换 `runtime/` 下的树、
 * 或改这份入口文件自己（同用户可写），所以这条没有把攻击面从"同用户"放大，它只是把**中介步骤**去掉
 * 了。作业定义仍然是 0600、由本工具渲染，`launchctl print` 也仍然是核对"注册没被人换走"的手段。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Exported only so `test/agent-entry.test.mjs` can pin them against their real sources
 * (`lib/fsutil.js`'s pointer name and `lib/policy.js`'s flag spellings). This file is copied into the
 * state root and imports nothing from the repo — so these two literals exist twice by design, and the
 * parity assertion is the only reader that can see them drift.
 */
export const POINTER_FILE_NAME = 'update-install.json'
export const STATE_FLAGS = ['--state-root', '--state-dir']

/**
 * Which home the fallback root hangs off — the same split-brain `updater/cli.js:226-247`
 * closes for the CLI, now pinned for this file too. `os.homedir()` reads `$HOME`, a
 * **caller-controlled variable**; `os.userInfo().homedir` reads the **password record**, which
 * is what the panel (`NSHomeDirectory()`) and the daemon (`StateRoot.homeDefault()`) use. A
 * scheduled launchd job whose `$HOME` differs from the record — a sandboxed job, an
 * `env -u HOME` invocation, both shapes this repo has measured — would otherwise read the
 * installer pointer from a root the installer never wrote: `installer-pointer-unreadable`,
 * exit 3, every day, while the panel and the CLI disagree about which install exists. Same
 * class as the daemon's `NSHomeDirectory()`-vs-`$HOME` rule pinned by
 * `mcp-shell/test/path-consistency.test.mjs`, and the reverse mutation (`os.homedir()`) is
 * reddened by `test/daily-20261022-updater.test.mjs`.
 * `os.userInfo()` throws when there is no record to ask; the CLI's named refusal is
 * `CODES.homeRecordUnavailable` (`home-record-unavailable`), mirrored here as
 * `NO_USER_RECORD_CODE` — the daily job must print a one-line refusal and exit 3, never a
 * stack trace into a log nobody reads.
 */
export const NO_USER_RECORD_CODE = 'home-record-unavailable'

export function entryHomeDir() {
  try {
    return os.userInfo().homedir
  } catch {
    throw Object.assign(
      new Error('this process has no password-database record, so the state root cannot be named; pass --state-dir'),
      { code: NO_USER_RECORD_CODE },
    )
  }
}

/**
 * The precedence `updater/cli.js` uses, reimplemented here on purpose: no shared module to import
 * (this file is copied into the state root and runs alone). The fallback `~` is the **password-record
 * home** (`entryHomeDir`, matching `cli.js`'s `recordHomeDir`), never `$HOME`/`os.homedir()`.
 * `homeDir` is injectable so a test can arrange the no-record shape this machine cannot.
 */
export function resolveEntryStateRoot(argv, env, { homeDir = entryHomeDir } = {}) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i])
    for (const flag of STATE_FLAGS) {
      if (token === flag) {
        const value = argv[i + 1]
        if (typeof value === 'string' && value !== '' && !value.startsWith('-')) return value
      } else if (token.startsWith(`${flag}=`)) {
        return token.slice(flag.length + 1)
      }
    }
  }
  if (typeof env.GLASSPANE_STATE_DIR === 'string' && env.GLASSPANE_STATE_DIR !== '') return env.GLASSPANE_STATE_DIR
  return path.join(homeDir(), '.glasspane')
}

/**
 * Read the pointer the same way the CLI does, and refuse in data rather than in a stack trace.
 * `null` means "there is no updater this machine can run", which is exactly the case the daily job
 * used to answer with `Cannot find module` in a log nobody reads.
 */
export function resolveUpdaterCli(stateRoot) {
  const file = path.join(stateRoot, POINTER_FILE_NAME)
  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, code: 'installer-pointer-unreadable', file, cli: null }
  }
  const cli = typeof parsed?.updaterCli === 'string' ? parsed.updaterCli : null
  if (!cli) return { ok: false, code: 'installer-pointer-unreadable', file, cli: null }
  if (!fs.existsSync(cli)) return { ok: false, code: 'installer-pointer-stale', file, cli }
  return { ok: true, code: null, file, cli }
}

/** What the job's log sees when there is nothing to run. One line, a code, and a next step. */
export function refusalLine({ code, stateRoot, cli, json }) {
  const message = `the GlassPane update agent could not start: the installer pointer ${path.join(stateRoot, POINTER_FILE_NAME)}`
    + (cli ? ` names ${cli}, which is not on disk` : ' is missing or unreadable')
    + ` (state root ${stateRoot}). Nothing was checked or installed. Remedy: re-run the GlassPane installer`
    + ` (it rewrites the pointer and re-registers this job), or run the updater's \`enable\` step from a working`
    // 这里**不**印一条 `node <路径> enable`：走到这一支恰恰是因为指针读不到、`cli` 不在盘上
    // （`resolveUpdaterCli` 的两种失败），此时任何"照抄这条命令"都是发明一个不存在的路径。
    // 而 `agent-entry.js` 是被 launchd 指向的一份**独立拷贝**（见 test/agent-entry.test.mjs 的
    // dirlink 那一组：把这一个文件搬进沙箱它必须还能跑），所以它也不许 import `lib/`——
    // 一条 import 就能让在册作业在真机上 ERR_MODULE_NOT_FOUND 而死。
    + ' copy of the repository.'
  if (!json) return `updater/agent-entry: ${message}\n`
  return `${JSON.stringify({
    command: null,
    ok: false,
    status: 'check-failed',
    code,
    message,
    // The code `updater/cli.js` would have answered with, so a reader that parses one shape does not
    // have to learn a second one for the entry point.
    exitCode: 3,
  })}\n`
}

/**
 * What the job's log sees when this process has no password record, so even the fallback
 * state root cannot be named. Mirrors the CLI's named refusal (`CODES.homeRecordUnavailable`,
 * message wording kept in step with `recordHomeDir` in `updater/cli.js`): a code, one line,
 * a next step, exit 3 — never the `os.userInfo()` stack trace this replaces.
 */
export function homeRefusalLine({ json }) {
  const message = 'the GlassPane update agent could not start: this process has no password-database record, so the default state root cannot be named. '
    + 'Nothing was checked or installed. Remedy: give the job an explicit --state-dir naming the state root the installer wrote, '
    + 'or run this under the account that has the record.'
  if (!json) return `updater/agent-entry: ${message}\n`
  return `${JSON.stringify({
    command: null,
    ok: false,
    status: 'check-failed',
    code: NO_USER_RECORD_CODE,
    message,
    // Same shape `refusalLine` prints, so one reader parses both.
    exitCode: 3,
  })}\n`
}

export function main(argv = process.argv.slice(2), { env = process.env, spawn = spawnSync, execPath = process.execPath, write = (s) => process.stdout.write(s), homeDir = entryHomeDir } = {}) {
  const json = argv.includes('--json')
  let stateRoot
  try {
    stateRoot = resolveEntryStateRoot(argv, env, { homeDir })
  } catch (error) {
    if (error && error.code === NO_USER_RECORD_CODE) {
      write(homeRefusalLine({ json }))
      return 3
    }
    throw error
  }
  const pointer = resolveUpdaterCli(stateRoot)
  if (!pointer.ok) {
    write(refusalLine({ code: pointer.code, stateRoot, cli: pointer.cli, json }))
    return 3
  }
  const child = spawn(execPath, [pointer.cli, ...argv], { stdio: 'inherit' })
  if (child.error) {
    write(refusalLine({ code: 'agent-entry-spawn-failed', stateRoot, cli: pointer.cli, json }))
    return 3
  }
  // 被信号打死与"子进程自己拒了"是两件事，但共同点是都不能退 0：一个退 0 的每日作业会把这次事故从
  // 所有读者的眼里抹掉。
  if (typeof child.status === 'number') return child.status
  return 3
}

// Run only when executed as a command, so the tests can drive `main` without a process each time.
//
// Both sides must be realpath-resolved, not merely resolved against the cwd. node loads an ESM entry
// by its real path, while `process.argv[1]` keeps whatever spelling the caller used — and the caller
// here is launchd, whose `ProgramArguments` entry is the path the installer wrote. If any component of
// the state root is a symlink (`/var/…`, a home or volume mounted through a link), the two strings
// differ and the whole block is skipped: the daily job exits 0 having resolved no pointer, exec'd
// nothing, and written nothing. A silently inert updater is worse than a failing one, because exit 0
// is what every reader here treats as "this morning's update ran". realpathSync throws for paths that
// do not exist yet, and this runs at import time, so the comparison is wrapped: uncomparable means
// "not invoked as a command", never "crash the entry". The URL is decoded with `fileURLToPath` rather
// than read through `.pathname`, which leaves a state root containing a space or a CJK character
// percent-encoded (`…/%E5%BC%A0…`) and therefore never equal to the path launchd passed in.
function invokedAsCommand() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedAsCommand()) {
  process.exitCode = main()
}
