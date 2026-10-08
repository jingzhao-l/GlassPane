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

/** One request per connection, so the id is a constant — and it is echoed back to us. */
const REQUEST_ID = 1

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
    // The socket is created unconnected on purpose: `connect` runs *after* the
    // listeners below exist (see the comment at the bottom of this function).
    const socket = new net.Socket()
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
      socket.write(`${JSON.stringify({ id: REQUEST_ID, method, params })}\n`)
    })

    // Decoding is the socket's job, not ours per chunk. `chunk.toString("utf8")` on
    // every data event splits a multi-byte sequence that straddles the boundary, and
    // the daemon writes application titles and AX labels — CJK is ordinary input here.
    // The mangled bytes then either fail `JSON.parse` (reported as the daemon sending
    // invalid JSON, blaming the engine for our decoder) or parse with U+FFFD baked
    // into a title the agent reads back as fact.
    socket.setEncoding("utf8")

    // The daemon serves one connection at a time (SocketServer.swift). When it closes
    // the pipe without answering, `data` never fires and nothing else does either —
    // so the request used to sit until the 30s (or 60s) timer expired, then advise the
    // agent to "stop moving the mouse and keyboard", pointing at an input window for
    // what was a connection the server had already hung up.
    socket.on("close", () => {
      if (buffer.length === 0 || buffer.indexOf("\n") < 0) {
        finish(
          failure(
            "GP_E_ENGINE_UNREACHABLE",
            `the background service closed the connection before answering "${method}"`,
            `another client may hold the daemon's single connection slot; check with \`launchctl print gui/$(id -u)/com.glasspane.daemon\` and retry ${method} once it is free`,
          ),
        )
      }
    })
    socket.on("end", () => {
      if (buffer.length === 0 || buffer.indexOf("\n") < 0) {
        finish(
          failure(
            "GP_E_ENGINE_UNREACHABLE",
            `the background service closed the connection before answering "${method}"`,
            `another client may hold the daemon's single connection slot; check with \`launchctl print gui/$(id -u)/com.glasspane.daemon\` and retry ${method} once it is free`,
          ),
        )
      }
    })

    socket.on("data", (chunk: string) => {
      buffer += chunk
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
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        finish(
          failure(
            "GP_E_INTERNAL",
            `the daemon answered "${method}" with something that is not a frame: ${JSON.stringify(parsed)?.slice(0, 160) ?? String(parsed)}`,
            "the engine's reply is a JSON object carrying `result` or `error`; read ~/.glasspane/installer-daemon.log — this tool will not report success on a frame it cannot read",
          ),
        )
        return
      }
      const reply = parsed as { id?: unknown; result?: unknown; error?: unknown }
      if (reply.id !== REQUEST_ID) {
        finish(
          failure(
            "GP_E_INTERNAL",
            `the daemon answered id ${JSON.stringify(reply.id)} while this request was id ${REQUEST_ID} ("${method}")`,
            "the frame in hand is not the answer to this call; reading it as if it were would attribute one method's result to another",
          ),
        )
        return
      }
      // The contract says `error` is an object with three fields, and `FrameCodec`
      // writes it that way. A bare string is a degraded error frame, and it is still
      // an error: it used to fall past this branch into the "neither a result nor an
      // error" refusal below, which told the reader the frame carried no error when
      // the engine had put one in it. The engine's text survives; only the missing
      // fields are named as missing.
      if (reply.error !== undefined && reply.error !== null) {
        const error: Partial<DaemonError> = typeof reply.error === "string" ? { message: reply.error } : reply.error
        const code = typeof error.code === "string" ? error.code : "GP_E_INTERNAL"
        finish({
          ok: false,
          error: {
            code,
            message: typeof error.message === "string" ? error.message : "the daemon reported an error without a message",
            // A missing remedy is an engine-side contract violation, and the
            // agent reading this needs to know who to blame, so say so.
            remedy:
              typeof error.remedy === "string" && error.remedy.length > 0
                ? error.remedy
                : `the daemon sent ${code} with no remedy — the failure is in the background service, not in this tool call; read ~/.glasspane/installer-daemon.log`,
          },
        })
        return
      }
      // `{id, result}` or `{id, error}` — and `result` may legitimately be `null`
      // ("no evidence pack for this id"), so presence is the question, not truthiness.
      // A frame carrying neither was, until now, resolved as `{ok: true, result:
      // undefined}`, which the tool layer renders as "gp_act: act ok": the model reads
      // that the click happened when the engine answered nothing at all. A transport
      // that manufactures success out of an empty response is a false green inside the
      // one component whose whole job is to carry the engine's verdict unchanged.
      if (!Object.prototype.hasOwnProperty.call(reply, "result")) {
        finish(
          failure(
            "GP_E_INTERNAL",
            `the daemon answered "${method}" with neither a result nor an error`,
            "the engine's frame contract is `{id, result}` or `{id, error}`; a frame with neither is an engine-side defect — read ~/.glasspane/installer-daemon.log, and do not treat this call as having done anything",
          ),
        )
        return
      }
      finish({ ok: true, result: reply.result })
    })

    // Connect only after every listener exists. A pipe that does not exist can
    // fail while `connect()` itself is still running, and an 'error' emitted
    // with no listener is thrown as an uncaught exception instead of becoming
    // the reply the model reads — measured under `bun test`: the same dead
    // socket resolved as GP_E_ENGINE_UNREACHABLE in one run and rejected with
    // a raw ENOENT in the next. With the listeners in place first, the outcome
    // is the reply either way.
    socket.connect(target)
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
 * What a capability check can learn from `hello`, with the two answers kept apart:
 * the engine advertised a list, or the engine did not answer that question. A
 * caller that collapses these into `Capabilities | null` cannot tell "the running
 * engine does not support this method" from "the engine was busy", and the second
 * one is not a statement about the method.
 */
export type CapabilityProbe = { readonly ok: true; readonly report: Capabilities } | { readonly ok: false; readonly error: DaemonError }

/**
 * Read the daemon's self-report. A failed `hello` returns the engine's own
 * `{code, message, remedy}` rather than `null`: the daemon serves one connection at
 * a time, so a timed-out or hung-up hello is a busy service talking, and its remedy
 * ("the slot is taken, retry once it is free") is the one the agent should get.
 */
export function probeCapabilities() {
  return Effect.map(hello(), (reply): CapabilityProbe => {
    if (!reply.ok) return { ok: false, error: reply.error }
    if (typeof reply.result !== "object" || reply.result === null) return { ok: false, error: noCapabilityList(reply.result) }
    const report = reply.result as Partial<Capabilities>
    if (!Array.isArray(report.capabilities)) return { ok: false, error: noCapabilityList(report) }
    return {
      ok: true,
      report: {
        version: typeof report.version === "string" ? report.version : "unknown",
        protocolVersion: typeof report.protocolVersion === "string" ? report.protocolVersion : "unknown",
        capabilities: report.capabilities.filter((item): item is string => typeof item === "string"),
        permissions: (report.permissions ?? {}) as Record<string, string>,
      },
    }
  })
}

/** `hello` answered but not with a capability list. The engine said nothing about
 *  what it supports, so nothing has been established about any method — say what
 *  the reply was, never what it means for the capability being asked about. */
function noCapabilityList(given: unknown): DaemonError {
  return {
    code: "GP_E_INTERNAL",
    message: `the background service answered hello without a capability list: ${JSON.stringify(given)?.slice(0, 160) ?? String(given)}`,
    remedy: "run gp_probe_status to read the engine's self-report, and read ~/.glasspane/installer-daemon.log if it is empty — no capability is assumed until hello advertises one",
  }
}
