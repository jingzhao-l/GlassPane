/**
 * The post-swap handshake's MCP half (spec §3.3): after the daemon answers
 * `hello` with the right version, the outward MCP surface has to still work —
 * `glasspane-mcp` answering `tools/list` is the cheapest proof that the
 * forwarding layer installed on this machine agrees with the daemon it talks
 * to.
 *
 * A real stdio JSON-RPC conversation: `initialize`, `notifications/initialized`,
 * then `tools/list`, over newline-delimited frames. Anything short of a
 * `result.tools` array is "not available" — the caller treats that as a failed
 * handshake and rolls back.
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

import { binaryNotFoundDetail, candidateDirsFor, childSpawnEnv, interpreterMissingDetail, isInterpreterMissing, resolveBinary } from './binaries.js'

export const MCP_BIN_DEFAULT = 'glasspane-mcp'
export const PROTOCOL_VERSION = '2024-11-05'

function frame(message) {
  return JSON.stringify(message) + '\n'
}

/**
 * Where a `glasspane-mcp` may still live when it is not on PATH.
 *
 * Same class as `signature.js`'s gpg search, measured for this machine in `lib/binaries.js`: the command is
 * installed by `npm install -g`, so it sits in the npm prefix bin (`/usr/local/bin` here), while a launchd
 * job is handed `/usr/bin:/bin:/usr/sbin:/sbin`. Before this, `apply`'s §3.3 MCP half died on
 * `glasspane-mcp could not run (ENOENT)` on exactly the machines that have it installed — and that answer
 * gates a rollback, so a PATH fact was costing the machine a swap.
 *
 * The search is filesystem-only (no probe spawn), so asking is cheap and a test can drive it by naming the
 * directories to look in. It runs when the *real* process selector is in use, or when a caller asks for a
 * search by name (`dirs`/`env`); a caller that handed in its own `spawnFn` has chosen the process already,
 * and this module must not go reading the developer's machine on top of that.
 */
export function resolveMcpBinary({ name = MCP_BIN_DEFAULT, env = process.env, dirs = null, exists, canExec, isFile } = {}) {
  return resolveBinary(name, { env, dirs: dirs ?? candidateDirsFor(name, { env }), exists, canExec, isFile })
}

/**
 * Ask a `glasspane-mcp`-shaped server for its tool list.
 * `spawnFn` is injectable for *process selection*; the framing, the reply
 * matching and the timeout are the real ones (see `test/apply.test.mjs`, which
 * drives this against a child process running a minimal server fixture).
 *
 * Every reason this function returns names the command it tried, and a command that could not be found at
 * all is answered here rather than by a doomed spawn: "not found on these searched paths" is a different
 * repair from "it ran and refused".
 *
 * The child is spawned with `childSpawnEnv(bin)`, not with the inherited environment. This command is a
 * `npm install -g` script whose first line is `#!/usr/bin/env node` (measured:
 * `/usr/local/bin/glasspane-mcp`), so a spawn that inherits the daily job's
 * `/usr/bin:/bin:/usr/sbin:/sbin` execs it, `env` cannot find node, and the handshake dies at 127 — which
 * §3.3 reads as a failed handshake and pays for with a rollback of a swap that worked.
 */
export function mcpToolsList({
  command = MCP_BIN_DEFAULT,
  args = [],
  timeoutMs = 10_000,
  spawnFn = spawn,
  clientInfo = { name: 'glasspane-updater', version: 'handshake' },
  env = process.env,
  dirs = null,
  exists,
  canExec,
  isFile,
  resolveBin,
} = {}) {
  const search = resolveBin !== undefined
    ? resolveBin
    : (spawnFn === spawn || dirs !== null || exists !== undefined || canExec !== undefined || isFile !== undefined)
      ? resolveMcpBinary
      : null
  let bin = command
  let tried = null
  if (search && !String(command ?? '').includes('/')) {
    const found = search({ name: command, env, dirs, exists, canExec, isFile })
    tried = found.tried
    if (!found.bin) {
      return Promise.resolve({
        ok: false,
        notFound: true,
        tried,
        blocked: found.blocked ?? null,
        reason: binaryNotFoundDetail({
          name: String(command),
          tried,
          pathValue: env?.PATH,
          blocked: found.blocked,
          blockedWhy: found.blockedWhy ?? null,
        }),
      })
    }
    bin = found.bin
  }
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childSpawnEnv(bin, { env }) })
    } catch (error) {
      resolve({ ok: false, reason: `starting ${bin} failed (${error.message})`, tried })
      return
    }
    let buffer = ''
    let settled = false
    let tools = null
    // The first lines of the child's stderr, kept for one purpose: `env: node: No such file or directory` is
    // the only evidence that distinguishes "the runtime is unreachable" from "the server answered rubbish".
    let errorTail = ''
    // Writes to a child that has stopped listening are EPIPEs on `child.stdin`, and node throws an unrouted
    // stream error. Under CI load the child dies between a write being dispatched and its completion, so the
    // updater lost the whole process mid-update (2026-10-16, CI run 38842800885) to a pipe error that is only
    // the echo of a state this function can already name: the server is either gone or deaf. Recorded, never
    // rethrown, and folded into whichever verdict arrives first.
    let stdinFailure = null
    const noteStdinFailure = (error) => {
      if (stdinFailure === null) stdinFailure = String(error?.code ?? error?.message ?? 'write failed')
    }
    child.stdin?.on('error', noteStdinFailure)
    const stdinClause = () => (stdinFailure === null ? '' : `; writing to its stdin had already failed (${stdinFailure})`)
    const writeFrame = (message) => {
      if (settled || !child.stdin || child.stdin.destroyed) return
      try {
        child.stdin.write(frame(message))
      } catch (error) {
        noteStdinFailure(error)
      }
    }
    const finish = (verdict) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve(verdict)
    }
    const timer = setTimeout(
      () => finish({ ok: false, reason: `${bin} did not answer tools/list within ${timeoutMs}ms${stdinClause()}`, tried }),
      timeoutMs,
    )

    child.on('error', (error) => finish({
      ok: false,
      tried,
      // A spawn that never started. `notFound` is set only when this call actually searched and found
      // nothing to run — "it is not here" and "it ran badly" are different repairs.
      reason: `${bin} could not be run (${error.code ?? error.message})${tried ? ` — searched: ${tried.join(', ')}` : ''}`,
    }))
    child.stderr?.on('data', (chunk) => {
      if (errorTail.length < 400) errorTail += chunk.toString('utf8').slice(0, 400 - errorTail.length)
    })
    child.stdout?.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === '') continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          finish({ ok: false, reason: `${bin} emitted a non-JSON line: ${line.slice(0, 80)}`, tried })
          return
        }
        if (message.id === 1) {
          if (message.error) {
            finish({ ok: false, reason: `${bin} refused initialize: ${message.error?.message ?? 'no message'}`, tried })
            return
          }
          writeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' })
          writeFrame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
          continue
        }
        if (message.id === 2) {
          if (message.error || !Array.isArray(message.result?.tools)) {
            finish({ ok: false, reason: `${bin} answered tools/list without a tool list`, tried })
            return
          }
          finish({ ok: true, bin, tools: message.result.tools.map((t) => t?.name).filter(Boolean), count: message.result.tools.length })
        }
      }
    })
    child.on('close', (code) => {
      if (tools === null && !settled) {
        // 127 plus an `env: …: No such file or directory` line is not "the server behaved badly": it is the
        // runtime the script's shebang asks for being unreachable from the environment this run handed the
        // child. Said as that, because the repair is different (see `lib/binaries.js`'s `childSpawnEnv`).
        finish({
          ok: false,
          tried,
          interpreterMissing: isInterpreterMissing({ status: code, stderr: errorTail }),
          reason: isInterpreterMissing({ status: code, stderr: errorTail })
            ? interpreterMissingDetail({ name: String(command), bin, stderr: errorTail, searched: childSpawnEnv(bin, { env }).PATH })
            : `${bin} exited with code ${code} before answering tools/list${errorTail.trim() ? `; its stderr said: ${errorTail.trim().slice(0, 200)}` : ''}${stdinClause()}`,
        })
      }
    })
    writeFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo },
    })
  })
}
