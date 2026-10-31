/**
 * Spec §2: the only judgement that says "you may touch the running daemon", so
 * it is written to fail closed.
 *
 * The daemon serves one connection and answers requests in arrival order (P0 §6).
 * A probe that gets an answer therefore proves there was nothing queued in
 * front of it — i.e. no action is in flight on the user's screen. Everything
 * else is "busy":
 *
 *   - connect refused / no listener           -> busy-or-unreachable
 *   - connected but no reply before deadline  -> busy-or-unreachable
 *   - reply is not one complete JSON line     -> busy-or-unreachable
 *   - reply carries an `error` frame          -> busy-or-unreachable
 *   - reply for a different request id        -> busy-or-unreachable
 *
 * An unanswered probe is **never** read as "the daemon is dead, restart it".
 * This project has already fixed that confusion three times: `kickstart -k`
 * cancels and rolls back the action that is in flight. So the object this
 * function returns also carries `mayRestart: false` on every non-idle verdict,
 * and `apply` refuses before it reaches any launchd call.
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { CODES } from './codes.js'
import { updaterCommand } from './invocation.js'
import { stateDirFromArgs } from './policy.js'

export const PROBE_METHOD = 'probe_status'
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000

/** Frame the daemon understands: one NDJSON request. */
export function probeFrame(id = 1) {
  return `${JSON.stringify({ id, method: PROBE_METHOD })}\n`
}

/**
 * Verdict on a reply's first line. Pure so the "answered with an error frame"
 * and "answered for another request id" branches are reachable without a
 * socket, while `probeIdle` is exercised against a real one.
 */
export function judgeProbeReply(line, { id }) {
  const text = String(line ?? '').trim()
  if (text === '') return { answered: false, reason: 'the probe got an empty reply' }
  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    return { answered: false, reason: `the probe reply was not one JSON frame (${text.slice(0, 80)})` }
  }
  if (frame === null || typeof frame !== 'object') {
    return { answered: false, reason: 'the probe reply was not a JSON object' }
  }
  if (frame.id !== id) {
    return { answered: false, reason: `the probe reply carries id ${JSON.stringify(frame.id)}, not the ${id} that was asked` }
  }
  if (frame.error !== undefined) {
    return { answered: false, reason: `the daemon answered the probe with an error (${frame.error?.message ?? 'no message'})` }
  }
  if (frame.result === undefined) {
    return { answered: false, reason: 'the probe reply names neither a result nor an error' }
  }
  return { answered: true, reason: null, frame }
}

/**
 * Send `probe_status` to `socketPath` and wait for one complete line.
 * Never throws: a failed probe is a verdict, not an exception.
 */
export function probeIdle({
  socketPath,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  connect = (options) => net.createConnection(options),
  startedAt = Date.now(),
} = {}) {
  return new Promise((resolve) => {
    const finish = (verdict) => {
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
      resolve({
        ...verdict,
        code: verdict.answered === true ? null : CODES.busyOrUnreachable,
        idle: verdict.answered === true,
        mayRestart: verdict.answered === true,
        socketPath,
        elapsedMs: Date.now() - startedAt,
      })
    }
    if (!socketPath) {
      finish({ answered: false, code: CODES.busyOrUnreachable, reason: 'no daemon socket is configured for this state root' })
      return
    }
    if (!fs.existsSync(socketPath)) {
      // No listener at that name at all: still not "the daemon is dead and can
      // be restarted", because another daemon may own a differently named
      // socket. Deferred, nothing swapped.
      finish({ answered: false, code: CODES.busyOrUnreachable, reason: `nothing is listening at ${socketPath}; the daemon was not restarted on that guess` })
      return
    }
    let buffer = ''
    let settled = false
    const socket = connect({ path: socketPath })
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      finish({
        answered: false,
        code: CODES.busyOrUnreachable,
        // Finding C7 (2026-10-24). This sentence used to name a cause: "so something
        // is queued in front of it". Nothing measured that — the one fact is *no reply
        // within ${timeoutMs}ms*, and `check.js`'s own rule for an errno says a cause
        // nobody measured is not allowed to be told as a diagnosis. A queued act, a
        // wedged daemon and a different service owning this socket all produce exactly
        // this observation, and they are not the same next step for a person.
        // It also used to carry **no action at all** while the other three refusal
        // gates each hand the reader a command (`policy.js`'s rule), and this string is
        // what lands in `lastError.message` — the sentence the panel prints verbatim.
        reason: `the daemon did not answer the idle probe within ${timeoutMs}ms, so nothing was swapped and the daemon was not restarted. `
          + `What this run measured is only "no reply on ${socketPath} in ${timeoutMs}ms"; it cannot tell apart an act queued in front of the reply, `
          + 'a daemon that stopped taking connections, and something else owning that socket name. '
          + 'What distinguishes them, in order: `launchctl print gui/$(id -u)/com.glasspane.daemon` shows whether launchd holds the job and with which '
          + `--socket-path; \`${updaterCommand('status', '--json')}\` shows what the last recorded run saw without touching the network; `
          + 'and a daemon that answers nothing is repaired by the installer\'s `node installer/cli.js --restore-launchd` '
          + '(it asks before unloading a job that is loaded, so an act in flight is not cancelled by it). '
          + `Re-run \`${updaterCommand('apply')}\` once the probe is answered — until then the swap stays refused, which is the safe side.`,
      })
    }, timeoutMs)
    const settleOnce = (verdict) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      finish(verdict)
    }
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      settleOnce(judgeProbeReply(buffer.slice(0, newline), { id: 1 }))
    })
    socket.on('error', (error) => {
      settleOnce({ answered: false, code: CODES.busyOrUnreachable, reason: `connecting to ${socketPath} failed (${error.code ?? error.message})` })
    })
    socket.on('close', () => {
      settleOnce({ answered: false, code: CODES.busyOrUnreachable, reason: `the socket at ${socketPath} closed before answering the probe` })
    })
    socket.on('connect', () => {
      socket.write(probeFrame(1))
    })
  })
}

/**
 * Which socket to probe, in the order the daemon itself resolves it:
 * explicit env, the running job's `--socket-path`, a named state root's
 * `daemon.sock`, then the historic home-derived `engine.sock`.
 * (Mirrors `StateRoot.engineSocketPath` in the engine; see README.)
 *
 * The state root is read with `lib/policy.js`'s `stateDirFromArgs`, **not** with a local
 * `args.includes('--state-dir')`: `STATE_ROOT_FLAGS` freezes two spellings and
 * `renderAgentPlist`'s default `daemonFlag` is `--state-root`, so a reader that knows one spelling
 * probes *this run's* socket about a job registered with the other one — an idle verdict about a
 * daemon that was never asked. (`main.swift` parses `--state-dir`; `--state-root` is the spelling this
 * repository writes into the plist.)
 */
export function resolveEngineSocket({ env = process.env, jobArgs = [], stateRoot = null, homeDir = null } = {}) {
  const fromEnv = env.GLASSPANE_ENGINE_SOCK
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const args = Array.isArray(jobArgs) ? jobArgs : []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--socket-path' && typeof args[i + 1] === 'string') return args[i + 1]
    if (String(args[i]).startsWith('--socket-path=')) return String(args[i]).slice('--socket-path='.length)
  }
  const named = stateDirFromArgs(args)
  const root = typeof named === 'string' && named !== '' ? named : stateRoot
  if (typeof root === 'string' && root !== '') {
    return path.join(root.replace(/\/+$/, ''), 'daemon.sock')
  }
  if (typeof homeDir === 'string' && homeDir !== '') {
    return path.join(homeDir, '.glasspane', 'engine.sock')
  }
  return null
}
