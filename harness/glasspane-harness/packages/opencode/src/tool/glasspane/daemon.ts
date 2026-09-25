/**
 * GlassPane daemon client for the harness.
 *
 * Scope rule (the reason this file is small): this module moves bytes to and
 * from `glasspaned` and shapes them for the agent. It never interprets them.
 * "Did this change come from this action", "is the UI correct" and every other
 * judgement belongs to the Swift engine — the same rule the MCP shell obeys, so
 * the harness cannot become a second implementation of the engine's conclusions.
 *
 * Frame contract (P0 spec §3, `FrameCodec.swift`): newline-delimited JSON over
 * a unix socket, one request per line, one response per line, 4 MiB per frame.
 * A response is either `{id, result}` or `{id, error:{code, message, remedy}}`.
 */
import { Effect } from "effect"
import net from "node:net"
import os from "node:os"
import path from "node:path"

/** Request timeouts per method. `restore` replays UI steps, so it gets more. */
export const TIMEOUT_MS = {
  default: 30_000,
  act: 60_000,
  observe: 30_000,
  shutdown: 5_000,
} as const

export const MAX_FRAME_BYTES = 4 * 1024 * 1024

export interface DaemonError {
  code: string
  message: string
  remedy: string
}

export type DaemonReply = { ok: true; result: unknown } | { ok: false; error: DaemonError }

/**
 * Where the daemon's socket lives. Deliberately NOT a copy of the engine's
 * constant: the MCP shell reads the same env var, and the default path follows
 * the documented convention, so neither surface carries a hard-coded path that
 * can drift from the other.
 */
export function socketPath(): string {
  const fromEnv = process.env.GLASSPANE_SOCKET
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), ".glasspane", "engine.sock")
}

function failure(code: string, message: string, remedy: string): DaemonReply {
  return { ok: false, error: { code, message, remedy } }
}

function rawRequest(method: string, params: object, timeoutMs: number): Promise<DaemonReply> {
  return new Promise((resolve) => {
    const target = socketPath()
    const socket = net.createConnection(target)
    let buffer = ""
    let settled = false

    const finish = (reply: DaemonReply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(reply)
    }

    const timer = setTimeout(() => {
      finish(
        failure(
          "GP_E_ENGINE_TIMEOUT",
          `the background service did not answer "${method}" within ${timeoutMs}ms`,
          `check it is running with \`launchctl print gui/$(id -u)/com.glasspane.daemon\`, or restart it with \`launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon\`; a busy input window also stalls the accessibility plane, so stop moving the mouse and keyboard and retry`,
        ),
      )
    }, timeoutMs)

    socket.on("error", (error: NodeJS.ErrnoException) => {
      const why = error.code === "ENOENT" ? `no socket at ${target} (the daemon is not running)` : `${error.code ?? ""} ${error.message}`
      finish(
        failure(
          "GP_E_ENGINE_UNREACHABLE",
          `cannot reach the background service over ${target}: ${why}`,
          `start it with \`node <glasspane repo>/installer/cli.js\` (or open the GlassPane panel and press the restart button), then retry ${method}`,
        ),
      )
    })

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method, params })}\n`)
    })

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        finish(failure("GP_E_PAYLOAD_TOO_LARGE", `the daemon sent more than ${MAX_FRAME_BYTES} bytes before a frame boundary`, "retry with a narrower query (smaller maxDepth, or a role filter)"))
        return
      }
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      const frame = buffer.slice(0, newline)
      let parsed: unknown
      try {
        parsed = JSON.parse(frame)
      } catch {
        finish(failure("GP_E_INTERNAL", `the daemon sent a frame that is not valid JSON: ${frame.slice(0, 160)}`, "read the daemon log at ~/.glasspane/installer-daemon.log and report the line to the maintainers — the shell cannot repair this"))
        return
      }
      const reply = parsed as { id?: unknown; result?: unknown; error?: Partial<DaemonError> }
      if (reply && typeof reply.error === "object" && reply.error) {
        finish({
          ok: false,
          error: {
            code: typeof reply.error.code === "string" ? reply.error.code : "GP_E_INTERNAL",
            message: typeof reply.error.message === "string" ? reply.error.message : "the daemon reported an error without a message",
            // A missing remedy is an engine-side contract violation, and the
            // agent reading this needs to know who to blame, so say so.
            remedy:
              typeof reply.error.remedy === "string" && reply.error.remedy.length > 0
                ? reply.error.remedy
                : `the daemon sent ${reply.error.code ?? "an unnamed"} error with no remedy — the failure is in the background service, not in this tool call; read ~/.glasspane/installer-daemon.log`,
          },
        })
        return
      }
      finish({ ok: true, result: reply?.result })
    })
  })
}

/**
 * One call. Total by construction: `Tool.Def.execute` has no error channel, so a
 * transport problem must come back as a *reply* the agent can read, never as a
 * raised defect that disappears into the tool runtime. `rawRequest` never
 * rejects — every failure path resolves a `DaemonReply` — which is what lets
 * this stay `Effect.promise` instead of a try/catch wrapper.
 */
export function call(method: string, params: object = {}, timeoutMs: number = TIMEOUT_MS.default) {
  return Effect.promise(() => rawRequest(method, params, timeoutMs))
}

/** `hello` is the only place capabilities and versions come from. */
export function hello() {
  return call("hello", {}, 5_000)
}

export interface Capabilities {
  version: string
  protocolVersion: string
  capabilities: string[]
  permissions: Record<string, string>
}

/**
 * Read the daemon's self-report. Returning `null` (rather than assuming) is what
 * lets a tool say "the engine did not tell me it supports this" instead of
 * pretending the call will work.
 */
export function probeCapabilities() {
  return Effect.map(hello(), (reply) => {
    if (!reply.ok || typeof reply.result !== "object" || reply.result === null) return null
    const report = reply.result as Partial<Capabilities>
    if (!Array.isArray(report.capabilities)) return null
    return {
      version: typeof report.version === "string" ? report.version : "unknown",
      protocolVersion: typeof report.protocolVersion === "string" ? report.protocolVersion : "unknown",
      capabilities: report.capabilities.filter((item): item is string => typeof item === "string"),
      permissions: (report.permissions ?? {}) as Record<string, string>,
    } satisfies Capabilities
  })
}
