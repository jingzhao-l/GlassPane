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

export const MCP_BIN_DEFAULT = 'glasspane-mcp'
export const PROTOCOL_VERSION = '2024-11-05'

function frame(message) {
  return JSON.stringify(message) + '\n'
}

/**
 * Ask a `glasspane-mcp`-shaped server for its tool list.
 * `spawnFn` is injectable for *process selection*; the framing, the reply
 * matching and the timeout are the real ones (see `test/apply.test.mjs`, which
 * drives this against a child process running a minimal server fixture).
 */
export function mcpToolsList({
  command = MCP_BIN_DEFAULT,
  args = [],
  timeoutMs = 10_000,
  spawnFn = spawn,
  clientInfo = { name: 'glasspane-updater', version: 'handshake' },
} = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, reason: `starting ${command} failed (${error.message})` })
      return
    }
    let buffer = ''
    let settled = false
    let tools = null
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
    const timer = setTimeout(() => finish({ ok: false, reason: `${command} did not answer tools/list within ${timeoutMs}ms` }), timeoutMs)

    child.on('error', (error) => finish({ ok: false, reason: `${command} could not run (${error.code ?? error.message})` }))
    child.stderr?.on('data', () => { /* server logs are not the handshake */ })
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
          finish({ ok: false, reason: `${command} emitted a non-JSON line: ${line.slice(0, 80)}` })
          return
        }
        if (message.id === 1) {
          if (message.error) {
            finish({ ok: false, reason: `${command} refused initialize: ${message.error?.message ?? 'no message'}` })
            return
          }
          child.stdin?.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }))
          child.stdin?.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))
          continue
        }
        if (message.id === 2) {
          if (message.error || !Array.isArray(message.result?.tools)) {
            finish({ ok: false, reason: `${command} answered tools/list without a tool list` })
            return
          }
          finish({ ok: true, tools: message.result.tools.map((t) => t?.name).filter(Boolean), count: message.result.tools.length })
        }
      }
    })
    child.on('close', (code) => {
      if (tools === null && !settled) finish({ ok: false, reason: `${command} exited with code ${code} before answering tools/list` })
    })
    child.stdin?.write(frame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo },
    }))
  })
}
