#!/usr/bin/env node
/**
 * `updater` — the single entry point the panel's two buttons and the launchd
 * agent both call (spec §7). One implementation of download, verification and
 * swap; the panel gets no second copy of that logic and neither does the agent.
 *
 * Contract the callers rely on:
 *   · exit 0 success, 2 usage, 3 refused, 4 swapped-then-rolled-back,
 *     5 swap failed and the rollback did not succeed (a person is required);
 *   · with `--json`, stdout is **exactly one line** of JSON matching
 *     `schema/update-state.schema.json` (plus `command`/`exitCode`/`message`);
 *   · every human sentence and diagnostic goes to stderr.
 *
 * Run with `--help` for the subcommands. This file has no side effects at
 * import time: `main()` is only called from the executable guard at the bottom,
 * so `test/cli.test.mjs` can drive it in-process with injected dependencies.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { CODES, EXIT, exitCodeFor } from './lib/codes.js'
import { UpdaterError, canonicalPath } from './lib/fsutil.js'
import { effectiveStatus, isOverdue, loadState, nextState, readPointer, saveState, updateSummary } from './lib/state.js'
import { runCheck } from './lib/check.js'
import { applyUpdate, buildStagedTree, DEFAULT_BUNDLES, rollbackToBackup } from './lib/apply.js'
import { probeIdle, resolveEngineSocket } from './lib/idle.js'
import { AGENT_LABEL, DAEMON_JOB_LABEL, DEFAULT_HOUR, DEFAULT_MINUTE, agentPlistPath, readRunningJob, registerAgent, renderAgentPlist, unregisterAgent } from './lib/launchd.js'
import { localVersion } from './lib/version.js'
import { CONSENT_KINDS } from './lib/policy.js'
import { makeBytesFetcher, makeFetcher, resolveBase } from './lib/source.js'
import { RELATIVE_RELEASE_PATH } from './lib/check.js'
import { CA_ENV_VAR, caBundlePath, describeCa, exportCaBundle, usableBundle } from './lib/ca-bundle.js'

export const SUBCOMMANDS = ['check', 'apply', 'status', 'rollback', 'enable', 'disable']
// 防循环标记：重跑的那一次带着它，于是它自己的 TLS 失败只会如实报出原因，不再往上叠一层子进程。
export const REEXEC_MARKER = 'GLASSPANE_CA_REEXEC'

/**
 * §9.8 那一次真机探测要打的 URL。单独成一个函数，是因为 `resolveBase()` 返回的是
 * `{base, origin, overridden}` —— 第一次我把它整个插进模板字符串，探测就打到了
 * `[object Object]/releases/latest`，于是每台机器的 `caRoots` 都记成 `probe-failed`
 * （真机日志里那句 `REJECT TypeError ERR_INVALID_URL` 就是它）。一个能红的小函数
 * 比一次"看起来合理"的拼接便宜得多。
 */
export function releaseProbeUrl(env = {}) {
  return `${resolveBase(env).base}${RELATIVE_RELEASE_PATH}`
}

export const USAGE = `usage: node updater/cli.js <command> [options]

commands
  check       fetch the latest release, run the eight trust gates, stage it
  apply       swap the staged version in, but only when the daemon is idle
  status      print the recorded state plus the overdue judgement (no network)
  rollback    restore the newest verified backup and restart the daemon
  enable      register the daily launchd agent (default schedule 12:00)
  disable     remove the agent and record disabled=true (manual runs still work)

options
  --state-dir <path>   state root (same meaning as the daemon's flag);
                       defaults to $GLASSPANE_STATE_DIR, then ~/.glasspane
  --apps-dir <path>    where the .app bundles live (default ~/Applications)
  --daemon-bin <path>  glasspaned executable used for the version read-back
  --socket <path>      daemon socket to probe (default: read off the job)
  --json               one line of JSON on stdout, everything else to stderr
  --consent <kind>     record a human decision: "major", "state-dir", or
                       "unsigned-release" — stage a release that carries no
                       verifiable GPG signature (or that this machine could not
                       check). It accepts a *missing* proof only: a signature that
                       is published and does not check is refused no matter what is
                       passed here. The state file keeps reporting an accepted
                       release as "applied without authorship proof".
  --auto               mark the call as the scheduled run (never a person
                       pressed a button): majors, a disabled state root and an
                       unsigned release all refuse
  --at <iso>           override "now" (tests and repro)
  --hour/--minute      schedule for enable (local time, one run per day)
  --disable            alias of the "disable" subcommand; --enable likewise.
                       They refuse to sit next of a different command — a switch that
                       promises safety and does nothing is worse than not having it.
  -h, --help
`

/** Pure argument parse. Returns `{ ok:false, reason }` for anything unusable. */
export function parseArgs(argv) {
  const flags = { json: false, auto: false, help: false, consents: [] }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i])
    if (token === '-h' || token === '--help') flags.help = true
    else if (token === '--json') flags.json = true
    else if (token === '--auto') flags.auto = true
    else if (token === '--disable') flags.disable = true // 选子命令，见下面 parseArgs 末尾的别名处理
    else if (token === '--enable') flags.enable = true   // 同上；两者同时给是用法错误
    else if (token === '--consent') {
      const value = argv[(i += 1)]
      if (!value) return { ok: false, reason: `--consent needs a value (${CONSENT_KINDS.join(' | ')})` }
      flags.consents.push(value)
    } else if (token.startsWith('--consent=')) flags.consents.push(token.slice('--consent='.length))
    else if (['--state-dir', '--state-root', '--apps-dir', '--daemon-bin', '--socket', '--at', '--hour', '--minute'].includes(token)) {
      const value = argv[(i += 1)]
      if (value === undefined) return { ok: false, reason: `${token} needs a value` }
      // Onto `flags` itself, keyed by the bare option name — which is exactly how every
      // consumer reads it (`flags['state-dir']`, `flags.at`, `flags.hour`, `flags.socket`).
      // These used to land in a separate `flags.overrides` bag that nothing ever read, so
      // **all six of these CLI options were silently ignored**: `check --state-dir /tmp/x`
      // resolved the state root to the live `~/.glasspane` and wrote the staged release
      // *there* (found by running it, 2026-09-29). A documented flag that does nothing is
      // worse than an absent one — the caller believes they are working on a copy.
      flags[token.replace(/^--/, '')] = value
    } else if (token.startsWith('--')) {
      return { ok: false, reason: `unknown option ${token}` }
    } else {
      positional.push(token)
    }
  }
  if (positional.length > 1) return { ok: false, reason: `expected one command, got ${positional.join(' ')}` }
  if (flags.disable && flags.enable) {
    return { ok: false, reason: '--disable and --enable contradict each other; pick one' }
  }
  let command = positional[0] ?? null
  // `--disable` used to be documented as "a no-op alias of disable". A flag that promises
  // safety and does nothing is worse than not having it — nobody types `updater disable`
  // afterwards because they believe the switch already fired. It is now a real alias:
  // it selects the subcommand, and it refuses to sit next of a different one.
  if (flags.disable || flags.enable) {
    const alias = flags.disable ? 'disable' : 'enable'
    if (command !== null && command !== alias) {
      return { ok: false, reason: `--${alias} cannot be combined with the command ${JSON.stringify(command)}; run "updater ${alias}" on its own` }
    }
    command = alias
  }
  if (command !== null && !SUBCOMMANDS.includes(command)) {
    return { ok: false, reason: `unknown command ${JSON.stringify(command)}; try ${SUBCOMMANDS.join(' | ')}` }
  }
  if (!command && !flags.help) return { ok: false, reason: 'no command given' }
  return { ok: true, command, flags }
}

/** State root resolution: flag, then env, then the daemon's per-user default. */
/**
 * The home this tool writes into. `os.homedir()` reads `$HOME`, which is a
 * caller-controlled variable; `os.userInfo().homedir` reads the password record,
 * which is what `NSHomeDirectory()` (the settings panel) and the daemon's
 * `StateRoot.homeDefault()` both use. The updater and the panel must land on the
 * same `~/.glasspane` or the panel shows "never checked" while a real state file
 * sits in another directory — the same two-writers-one-value split this repo has
 * already lost data over, so this defaults to the record and refuses when there is
 * no record to ask. The reverse mutation is `homeDir = os.homedir()`, which
 * `test/home.test.mjs` reddens.
 */
export function recordHomeDir() {
  try {
    return os.userInfo().homedir
  } catch {
    throw new UpdaterError(
      CODES.homeRecordUnavailable,
      'this process has no password-database record, so the state root cannot be named; pass --state-dir',
    )
  }
}

export function resolveStateRoot({ flags = {}, env = process.env, homeDir = recordHomeDir() } = {}) {
  const named = flags['state-dir'] ?? flags['state-root'] ?? env.GLASSPANE_STATE_DIR
  if (typeof named === 'string' && named.trim() !== '') return canonicalPath(named)
  return path.join(homeDir, '.glasspane')
}

export function resolveAppsDir({ flags = {}, env = process.env, homeDir = recordHomeDir() } = {}) {
  const named = flags['apps-dir'] ?? env.GLASSPANE_APPS_DIR
  if (typeof named === 'string' && named.trim() !== '') return canonicalPath(named)
  return path.join(homeDir, 'Applications')
}

/**
 * The default wiring: real HTTP, real processes, real sockets. Tests pass
 * their own `deps` so the suite never touches a developer's home or the
 * internet.
 */
export function defaultDeps({ stateRoot, appsDir, env, flags, exportCa = exportCaBundle } = {}) {
  const daemonBin = flags['daemon-bin'] ?? env.GLASSPANE_DAEMON_BIN ?? path.join(appsDir, 'GlassPane Daemon.app', 'Contents', 'MacOS', 'glasspaned')
  return {
    env,
    appsDir,
    daemonBin,
    bundles: DEFAULT_BUNDLES,
    readLocal: () =>
      localVersion({
        appsDir,
        daemonExecutable: daemonBin,
        settingsAppName: 'GlassPane.app',
        daemonAppName: 'GlassPane Daemon.app',
      }),
    // A TLS failure is reported with the bundle this machine *should* be handed, so
    // the remedy names a path instead of a theory (§9.6).
    fetchJson: makeFetcher(globalThis.fetch, { caBundlePath: caBundlePath(stateRoot) }),
    fetchBytes: makeBytesFetcher(globalThis.fetch, { caBundlePath: caBundlePath(stateRoot) }),
    probeIdle,
    readRunningJob,
    build: buildStagedTree,
    registerAgent,
    unregisterAgent,
    renderAgentPlist,
    agentPlistPath,
    // §9: the root bundle node needs on a TLS-intercepting machine, exported by
    // this module alone and refreshed at the two points that can do it without a
    // person in the loop — registering the agent, and finishing a swap.
    refreshCaBundle: () => exportCa({ stateRoot, probeUrl: releaseProbeUrl(env) }),
    usableCaBundle: () => usableBundle(caBundlePath(stateRoot)),
    now: () => new Date(),
  }
}

/** One command, one outcome object. Never throws: refusals are data. */
export async function runCommand({ command, flags, env = process.env, deps = {}, stdout = null, stderr = null }) {
  const stateRoot = resolveStateRoot({ flags, env, homeDir: deps.homeDir ?? recordHomeDir() })
  const appsDir = resolveAppsDir({ flags, env, homeDir: deps.homeDir ?? recordHomeDir() })
  const now = flags.at ? new Date(flags.at) : (deps.now ? deps.now() : new Date())
  if (Number.isNaN(now.getTime())) {
    return { status: null, code: null, usageError: true, message: `--at ${flags.at} is not a date` }
  }
  const write = (line) => (stderr ?? process.stderr).write(line.endsWith('\n') ? line : `${line}\n`)
  const envDisabled = env.GLASSPANE_UPDATE_DISABLE === '1'
  const merged = { ...defaultDeps({ stateRoot, appsDir, env, flags }), ...deps }
  let cachedContext = null
  /**
   * Which socket to probe, and what the running job looks like. Both are read
   * only for the commands that can touch the daemon: `status` must work with no
   * daemon at all, and `launchctl print` on every read would make the panel's
   * refresh spawn a system binary.
   */
  const daemonContext = () => {
    if (cachedContext) return cachedContext
    let job = deps.job
    if (job === undefined) {
      try {
        job = merged.readRunningJob({ label: merged.daemonLabel ?? DAEMON_JOB_LABEL })
      } catch (error) {
        job = { unknown: true, reason: `launchctl print failed (${error.message})` }
      }
    }
    const socket = flags.socket ?? resolveEngineSocket({
      env,
      jobArgs: job?.args ?? [],
      stateRoot,
      homeDir: deps.homeDir ?? recordHomeDir(),
    })
    cachedContext = { job, socketPath: socket }
    return cachedContext
  }

  switch (command) {
    case 'check': {
      const local = merged.readLocal()
      const result = await runCheck({
        stateRoot,
        env,
        now,
        local,
        consents: flags.consents,
        trigger: flags.auto ? 'auto' : 'manual',
        autoApply: envDisabled ? false : null,
        fetchJson: merged.fetchJson,
        fetchBytes: merged.fetchBytes,
        log: write,
      })
      if (!local.ok) write(local.message)
      return { ...result, command, exitCode: exitCodeFor({ status: result.status }) }
    }
    case 'apply': {
      if (flags.auto && envDisabled) {
        return {
          ok: false,
          status: 'deferred',
          code: CODES.autoDisabled,
          message: 'GLASSPANE_UPDATE_DISABLE=1 switched automatic update off, so the scheduled run applied nothing',
          command,
          exitCode: EXIT.REFUSED,
        }
      }
      const local = merged.readLocal()
      if (local.ok !== true) {
        // A machine whose two version readings disagree is half-installed; the
        // answer is the installer, not a swap.
        return {
          ok: false,
          status: 'check-failed',
          code: local.code ?? CODES.versionMismatchLocal,
          message: local.message ?? 'the installed version could not be read; no swap was attempted',
          command,
          exitCode: EXIT.REFUSED,
        }
      }
      const context = daemonContext()
      const result = await applyUpdate({
        stateRoot,
        appsDir,
        bundles: merged.bundles,
        // §11: the updater's own copy moves with a successful swap, and whether a launchd job may be
        // (re-)registered is this run's answer, not something the step may decide for itself.
        env,
        autoDisabled: envDisabled,
        now,
        consents: flags.consents,
        trigger: flags.auto ? 'auto' : 'manual',
        currentVersion: local.version,
        socketPath: context.socketPath,
        probe: { socketPath: context.socketPath, timeoutMs: merged.probeTimeoutMs },
        job: context.job,
        build: merged.build,
        kickstart: merged.kickstart,
        helloCall: merged.helloCall,
        toolsList: merged.toolsList,
        npm: merged.npm,
        copyFn: merged.copyFn,
        refreshCa: merged.refreshCaBundle,
      })
      return { ...result, command, exitCode: exitCodeFor(result) }
    }
    case 'status': {
      const pointer = readPointer(stateRoot)
      const { state } = loadState(stateRoot)
      const status = effectiveStatus(state, now)
      const payload = { ...state, status, overdue: isOverdue(state, now), summary: updateSummary(state, now) }
      if (!pointer.ok && state.lastCheckAt === null) {
        payload.status = statusFromPointerFailure(pointer.code)
        payload.code = pointer.code
        payload.message = pointer.message
      }
      // Reading the state *succeeded*, so this answers 0 even when the state it
      // reports is somebody's refusal: the panel has to be able to tell "the
      // machine declined an update" from "I cannot read anything here", and a
      // non-zero code is what makes it show the latter.
      return { ok: true, status: payload.status, code: payload.code, message: payload.message ?? humanLine(payload), state: payload, command, exitCode: EXIT.OK }
    }
    case 'rollback': {
      const context = daemonContext()
      const result = await rollbackToBackup({
        stateRoot,
        appsDir,
        bundles: merged.bundles,
        socketPath: context.socketPath,
        now,
        copyFn: merged.copyFn,
        kickstart: merged.kickstart,
        helloCall: merged.helloCall,
        toolsList: merged.toolsList,
        probe: (opts) => merged.probeIdle(opts),
      })
      return { ...result, command, exitCode: exitCodeFor(result) }
    }
    case 'enable':
    case 'disable': {
      const disable = command === 'disable'
      const { state } = loadState(stateRoot)
      let agent = { ok: true, message: 'the launchd agent was not touched' }
      // 只有注册成功那一条路会赋值；下面的状态写入因此不需要再判一次 agent.ok ——
      // 判了两次反而让人以为失败路径也会写状态。
      let exportedCa = null
      if (disable) {
        agent = merged.unregisterAgent({ label: AGENT_LABEL, plistPath: merged.agentPlistPath({ homeDir: deps.homeDir ?? recordHomeDir() }), uid: merged.uid, run: merged.runLaunchctl })
      } else if (envDisabled) {
        // §7: the env switch is a *hard* off — enabling from a shell that
        // carries it would register an agent the user has already disowned.
        agent = {
          ok: false,
          code: CODES.autoDisabled,
          message: `GLASSPANE_UPDATE_DISABLE=1 is set, so the update agent was not registered. Unset it (or run "updater enable" from a shell without it) to switch automatic update back on.`,
        }
      } else {
        // §9: the agent is the thing that must carry the bundle, so this is where
        // the bundle gets exported — a job registered without it would fail its
        // first network gate every day and still look like a running agent.
        const caRoots = merged.refreshCaBundle()
        const bundle = merged.usableCaBundle()
        const plistText = merged.renderAgentPlist({
          cliPath: merged.cliPath ?? fileURLToPath(import.meta.url),
          stateRoot,
          hour: Number(flags.hour ?? DEFAULT_HOUR),
          minute: Number(flags.minute ?? DEFAULT_MINUTE),
          label: AGENT_LABEL,
          // The *file* decides what the job is handed, not this run's export record:
          // an export that produced nothing keeps the previous bundle in place, and
          // that bundle is still the trust this machine has.
          caBundle: bundle.usable ? caBundlePath(stateRoot) : null,
        })
        agent = merged.registerAgent({
          label: AGENT_LABEL,
          plistPath: merged.agentPlistPath({ homeDir: deps.homeDir ?? recordHomeDir() }),
          plistText,
          uid: merged.uid,
          run: merged.runLaunchctl,
        })
        if (agent.ok) exportedCa = caRoots
      }
      if (!agent.ok) {
        return {
          ok: false,
          status: 'check-failed',
          code: agent.code ?? CODES.busyOrUnreachable,
          message: agent.message,
          command,
          exitCode: EXIT.REFUSED,
        }
      }
      const next = nextState(state, {
        disabled: disable,
        autoApply: !disable,
        status: disable ? 'disabled' : (state.status === 'disabled' ? 'up-to-date' : state.status),
        code: null,
        ...(exportedCa ? { caRoots: exportedCa } : {}),
        historyEntry: { action: disable ? 'disable' : 'enable', result: disable ? 'disabled' : 'enabled', digest: null, code: null },
      }, { now })
      const saved = saveState(stateRoot, next, { now })
      // A bundle this machine could not produce is not a reason to refuse the
      // registration — an un-intercepted network works fine without it. It *is* a
      // reason to say so here, because the alternative is a daily job that fails
      // its first gate while the panel reads "automatic update is on".
      const ca = exportedCa && exportedCa.status !== 'ok' ? describeCa(exportedCa) : null
      return {
        ok: true,
        status: saved.state.status,
        code: null,
        message: disable
          ? `automatic update is off${agent.message ? ` (${agent.message})` : ''}: "updater check" and "updater apply" still work by hand`
          : `automatic update is on${agent.message ? ` (${agent.message})` : ''}${ca ? `; ${ca.summary} — ${ca.remedy}` : ''}`,
        state: saved.state,
        command,
        exitCode: EXIT.OK,
      }
    }
    default:
      return { status: null, code: null, usageError: true, message: `unknown command ${JSON.stringify(command)}` }
  }
}

/** `installer-pointer-stale` / missing pointer, mapped onto the closed enum. */
export function statusFromPointerFailure(code) {
  if (code === CODES.pointerStale || code === CODES.pointerMissing) return 'installer-pointer-stale'
  return 'check-failed'
}

/** The one line a human (or a panel log) sees for `status`. */
export function humanLine(payload) {
  const summary = payload.summary ?? {}
  const bits = [`status=${payload.status}`]
  if (summary.current) bits.push(`current=${summary.current}`)
  if (summary.latest) bits.push(`latest=${summary.latest}`)
  if (payload.code) bits.push(`code=${payload.code}`)
  if (payload.lastCheckAt) bits.push(`lastCheckAt=${payload.lastCheckAt}`)
  if (summary.overdue) bits.push('check is overdue: press Check now')
  if (payload.staged?.digest) bits.push(`staged sha256=${payload.staged.digest}`)
  // Gate 8 on the plain-text line: an accepted-unsigned install must not read as a
  // clean one to whoever is tailing it.
  if (payload.authorship && payload.authorship.signature && payload.authorship.signature !== 'verified') {
    bits.push(`authorship=${payload.authorship.signature}${payload.authorship.consented === true ? ' (consented, unproven)' : ''}`)
  }
  return bits.join(' ')
}

/** The exactly-one-line JSON document `--json` prints. */
export function jsonLine(outcome) {
  const base = outcome.state && typeof outcome.state === 'object' ? outcome.state : {}
  const line = {
    command: outcome.command ?? null,
    status: outcome.status ?? null,
    code: outcome.code ?? null,
    exitCode: outcome.exitCode ?? EXIT.REFUSED,
    ok: outcome.ok === true,
    message: outcome.message ?? null,
    reason: outcome.reason ?? outcome.details?.probe ?? null,
    state: base,
  }
  return JSON.stringify(line)
}

/**
 * §9.10：证书类失败时重导一次束，并**带着它把自己重跑一次**。
 *
 * 为什么必须有这一条：束只在 `enable` 与 `apply` 成功后刷新，而一次 TLS 失败永远走不到
 * `apply`。于是"这台机器后来装了新代理"是一个会**永久卡住**的状态——每天定时跑、每天在同一
 * 道门上失败，而它看起来像"没有可用更新"。这是真机跑出来的形状，不是假设。
 *
 * 三条边界，都是为了不把"追加信任"变成"擅自改信任"：
 *   · 只在调用方**没有**给 `NODE_EXTRA_CA_CERTS` 时介入。人在终端上自己指了一份，方向就归他；
 *   · 只重来一次（`GLASSPANE_CA_REEXEC=1` 是防循环标记，子进程带着它就不会再套一层）；
 *   · 导不出可用的束就不重跑：把这次的导出结果写进状态，原来的拒绝照常返回。
 *
 * 返回 null 表示"没有恢复、请按原样输出"；返回数字表示"子进程已经替我把 stdout/退出码
 * 演完了"——`--json` 那一行也只由子进程写一次，契约不被复制第二遍。
 */
export function recoverFromTlsFailure({ outcome, argv, env, refresh, spawnChild, onRecord, stderr = null } = {}) {
  // 只读结构化事实。匹配我自己写的句子＝文案一改判据就失效，那正是这一路要避免的形状。
  if (!outcome || outcome.tlsVerification !== true) return null
  if (String(env[REEXEC_MARKER] ?? '') === '1') return null
  if (typeof refresh !== 'function' || typeof spawnChild !== 'function') return null

  const record = refresh()
  // 写状态失败不能顺手取消重跑，但也不能吞掉：那句话并进结果消息里，读的人看得见"这次没落盘"。
  let recorded = true
  if (typeof onRecord === 'function') {
    try {
      onRecord(record)
    } catch (error) {
      recorded = false
      record.recordWriteError = String(error?.message ?? error)
    }
  }
  if (!record || record.status !== 'ok' || !record.path) return null
  const wanted = String(env[CA_ENV_VAR] ?? '')
  if (wanted !== '' && wanted !== record.path) {
    // 操作者自己指到别处的束：重跑只会用他那一份，我们刷新不了他的信任，就不代为决定。
    // 等号那一侧不是可有可无：终端里照着 remedy 设过同一份路径的人，等的就是这次恢复。
    return null
  }
  const child = spawnChild([...argv], { ...env, [CA_ENV_VAR]: record.path, [REEXEC_MARKER]: '1' })
  if (!recorded) {
    // 重跑照做（那才是用户要的恢复），但"这次没能在状态里留下证据"必须说出来 ——
    // 只写 stderr，`--json` 那一行仍然恰好一行、且只由子进程写。
    stderrFor(stderr).write(`updater: 证书恢复已重跑，但导出结果没能写进状态文件（${record.recordWriteError ?? '原因未知'}）；`
      + `下一次 \`updater enable\` 之前，面板与 gp_diagnose 看到的 caRoots 仍是上一次的记录。\n`)
  }
  const status = child && typeof child.status === 'number' ? child.status : null
  if (status === null) {
    // 被信号打断或压根没起来：绝不退 0。一个"看起来完成了每日检查"的 0 会把这次事故抹掉。
    return EXIT.REFUSED
  }
  return status
}

export async function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, deps = {} } = {}) {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    stderr.write(`${parsed.reason}\n${USAGE}`)
    return EXIT.USAGE
  }
  if (parsed.flags.help || parsed.command === null) {
    stderr.write(USAGE)
    return EXIT.OK
  }
  let outcome
  try {
    outcome = await runCommand({ command: parsed.command, flags: parsed.flags, env, deps, stderr })
  } catch (error) {
    // Anything that escapes a gate still has to answer with a code and one
    // line, or the panel shows a silent failure.
    const code = error instanceof UpdaterError ? error.code : 'internal'
    outcome = {
      ok: false,
      status: 'check-failed',
      code,
      message: error.message,
      command: parsed.command,
      exitCode: EXIT.REFUSED,
      state: null,
    }
    stderr.write(`updater: ${error.message}\n`)
  }
  if (!outcome.ok && outcome.tlsVerification === true) {
    const root = resolveStateRoot({ flags: parsed.flags, env, homeDir: deps.homeDir ?? recordHomeDir() })
    const recovered = recoverFromTlsFailure({
      outcome,
      argv,
      env,
      stateRoot: root,
      refresh: deps.refreshCaBundle ?? (() => exportCaBundle({ stateRoot: root, probeUrl: releaseProbeUrl(env) })),
      spawnChild: deps.spawnChild
        ?? ((childArgs, childEnv) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...childArgs], { env: childEnv, stdio: 'inherit' })),
      stderr,
      onRecord: (record) => {
        // 导不出也要留痕：面板与 gp_diagnose 靠这条说话，否则这台机器的失败只剩一句猜测。
        const stamp = new Date()
        const { state } = loadState(root)
        saveState(root, nextState(state, { caRoots: record }, { now: stamp }), { now: stamp })
      },
    })
    if (recovered !== null) return recovered
  }
  const code = outcome.exitCode ?? exitCodeFor(outcome)
  if (parsed.flags.json) {
    stdout.write(`${jsonLine({ ...outcome, exitCode: code })}\n`)
  } else {
    const text = outcome.message ?? outcome.reason ?? humanLine(outcome.state ?? {})
    stderr.write(`${parsed.command}: ${text}\n`)
  }
  return code
}

// `realpathSync` throws when the entry path does not exist yet, and this guard
// runs at import time — so it is wrapped: an unreadable comparison means "not
// invoked directly", never "crash the module". Without the guard clause every
// `node cli.js …` died at import (found by `test/cli.test.mjs`, which runs the
// CLI as a real subprocess instead of importing it).
let invokedDirectly = false
try {
  invokedDirectly = Boolean(process.argv[1])
    && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
} catch {
  invokedDirectly = false
}
if (invokedDirectly) {
  const env = process.env
  main({ env })
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`updater crashed: ${error?.stack ?? error}\n`)
      process.exitCode = EXIT.REFUSED
    })
}
