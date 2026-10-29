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
import { statSync, type Stats } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

/**
 * Request timeouts per method, keyed by the method's wire name.
 *
 * Two rules hold this table honest, and both are pinned in
 * `test/tool/glasspane-surface.test.ts`:
 *  - every entry names a method a call site in this package sends. The engine's table
 *    (`FrameCodec.swift`'s `EngineMethod`) accepts more than this surface uses:
 *    `restore`, `snapshot`, `audit_ui`, `capture_view` and `assert_element` are on the
 *    wire and are driven by the *other* shell, which keeps its own budgets
 *    (`mcp-shell/src/engine-client.ts`: `ENGINE_DEADLINES_MS`, plus
 *    `RESTORE_BASE_DEADLINE_MS` for `restore`, which really does replay UI steps). None
 *    of them is reachable from a `gp_*` tool here, so none of them has a number here:
 *    the sentence that used to sit on this table ("`restore` replays UI steps, so it
 *    gets more") described a call this file never makes, and `shutdown: 5_000` had no
 *    reader anywhere — a budget nobody spends is a budget nobody re-measures;
 *  - no call site in `src/tool/glasspane/` brings its own number. `call` looks the
 *    method up here, so the table is the only place a budget is written down; a method
 *    that is not in it gets `default` and says so in this sentence rather than in a
 *    magic number at the call site.
 */
export const TIMEOUT_MS = {
  default: 30_000,
  hello: 5_000,
  probe_status: 8_000,
  observe: 30_000,
  act: 60_000,
} as const

/** The budget for one method: its own entry if it has one, `default` if it has not. */
export function timeoutFor(method: string): number {
  // Own-property lookup only. A bracket read walks the prototype, so `constructor`, `toString`
  // and `valueOf` came back as FUNCTIONS — and `setTimeout(fn, fn)` coerces to NaN, which fires
  // in about a millisecond: that method would have reported GP_E_ENGINE_TIMEOUT for a daemon that
  // was answering perfectly. `?? default` cannot catch it, because a function is not nullish.
  return Object.prototype.hasOwnProperty.call(TIMEOUT_MS, method)
    ? (TIMEOUT_MS as Readonly<Record<string, number>>)[method]
    : TIMEOUT_MS.default
}

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
 * Marks a tool result this surface produced by actually calling `glasspaned`.
 *
 * The audit ledger used to decide "is this ours" from the tool NAME (`gp_*`), and the registry
 * auto-imports a project's own `tool/gp_whatever.ts` files — so any repo-committed tool that
 * returned a kernel-shaped `{ok:true, result:{evidencePack}}` minted a chain entry for a verdict
 * that never crossed the socket. Shape validation cannot see that: a forged pack and an engine pack
 * parse the same. This marker is what makes the claim mean something: it is set in exactly one
 * place — `present` in `index.ts`, downstream of `Daemon.call` — so recording a decision
 * requires either coming through that path or importing this module's private symbol deliberately.
 * `refused` deliberately carries nothing: a refusal mints no ledger entry, and half of them
 * (`GP_E_ENGINE_UNREACHABLE`, the capability gate, `GP_E_SOCKET_TRUST`) are written by this file
 * before any byte crossed the socket, so marking them would make the symbol mean "something came
 * out of this module" instead of "this reply came off the engine".
 * It is not a signature — the daemon signs nothing — it is the difference between "any tool that
 * calls itself gp_" and "this surface's own reply".
 */
export const DAEMON_ORIGIN = Symbol("glasspane.daemon-origin")

export function fromDaemonSurface(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null) return false
  return (metadata as Record<symbol, unknown>)[DAEMON_ORIGIN] === true
}

/** What one engine-facing location rule answers: `{code, message, remedy}`. */
export interface LocationRejection {
  readonly code: string
  readonly message: string
  readonly remedy: string
}

/**
 * The three facts about an inode that decide whether this client may believe it. A structural
 * type rather than `Stats` so a test can hand over the numbers a real `stat` would have returned
 * without forging an entire inode — the ownership branches cannot be produced by an unprivileged
 * process, and a rule whose only exercised path is the friendly one has not been tested.
 */
export type SocketEvidence = Pick<Stats, "uid" | "mode" | "isSocket">

export type SocketLocation =
  | { readonly ok: true; readonly socket: string; readonly stateRoot: string }
  | { readonly ok: false; readonly error: LocationRejection }

/**
 * Where the daemon's socket lives, and the state root it sits in — the fork's ONE
 * resolution rule for both, consulted by this module before it connects and by
 * `kernel.ts` before it refuses to write next to the engine.
 *
 * Deliberately NOT a copy of the engine's constant: the MCP shell reads the same env
 * var, and the default path follows the documented convention, so neither surface
 * carries a hard-coded path that can drift from the other.
 *
 * A relative `GLASSPANE_SOCKET` is refused rather than resolved. `glasspaned` passes
 * `--socket-path` straight through (`StateRoot.engineSocketPath`), so a relative name
 * is bound wherever *the daemon* was standing; `path.resolve` would put it wherever
 * *this* process is standing instead. Two answers to "which engine is this" is how the
 * harness ends up treating its own working directory as the engine's state root —
 * refusing every ledger path inside it while talking to a daemon that lives elsewhere.
 *
 * The default branch is refused by the SAME rule, because it can produce the same
 * relative answer: `HOME` counts as unset when it is empty as well as when it is absent,
 * and a `HOME` that names a relative directory is a refusal rather than a path to join.
 */
export function resolveSocket(env: NodeJS.ProcessEnv = process.env): SocketLocation {
  const fromEnv = env.GLASSPANE_SOCKET
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (!path.isAbsolute(fromEnv)) {
      return {
        ok: false,
        error: {
          code: "GP_E_SOCKET_PATH",
          message: `GLASSPANE_SOCKET='${fromEnv}' is not absolute, so this process cannot say which engine it would talk to`,
          remedy: `point GLASSPANE_SOCKET at the absolute path glasspaned bound (e.g. ${path.join(os.homedir(), ".glasspane", "engine.sock")}) — the daemon binds a relative name wherever it was started, and this harness would resolve the same string against its own working directory and read a different file`,
        },
      }
    }
    return { ok: true, socket: fromEnv, stateRoot: path.dirname(fromEnv) }
  }
  // `||`, not `??`: with `HOME=''` — a real shape, e.g. `env -i` or a `launchd` plist that
  // exports an empty HOME — `??` kept the empty string and `path.join("", ".glasspane")`
  // returned the RELATIVE `".glasspane"`. Measured: `resolveSocket({HOME: ""})` gave
  // `.glasspane/engine.sock`. Two consequences, both the failure this function exists to
  // refuse: which engine this process talks to depends on the working directory, and
  // `kernel.ts`'s `insideStateRoot` compares ABSOLUTE ledger candidates against that
  // relative root, so the engine-root guard never matches and a second writer gets into
  // the real `~/.glasspane`.
  const home = env.HOME || os.homedir()
  const root = path.join(home, ".glasspane")
  if (!path.isAbsolute(root)) {
    return {
      ok: false,
      error: {
        code: "GP_E_STATE_ROOT",
        message: `the default engine state root is '${root}', which is not absolute (HOME='${env.HOME ?? ""}'), so this process cannot say which engine it would talk to`,
        remedy: `set HOME to the absolute directory \`echo $HOME\` reports, or point GLASSPANE_SOCKET at the absolute path glasspaned bound (confirm it with \`launchctl print gui/\$(id -u)/com.glasspane.daemon\`, e.g. ${path.join(os.homedir(), ".glasspane", "engine.sock")}) — a relative state root makes this harness answer "which engine" from its own working directory and stops the guard that refuses ledger paths inside the engine's tree`,
      },
    }
  }
  return { ok: true, socket: path.join(root, "engine.sock"), stateRoot: root }
}

/** The engine's state root under the one rule above; refused when the socket cannot be located. */
export function stateRootOf(env: NodeJS.ProcessEnv = process.env): { ok: true; path: string } | { ok: false; error: LocationRejection } {
  const located = resolveSocket(env)
  if (!located.ok) return { ok: false, error: located.error }
  return { ok: true, path: located.stateRoot }
}

function failure(code: string, message: string, remedy: string): DaemonReply {
  return { ok: false, error: { code, message, remedy } }
}

/**
 * Which socket this process is allowed to believe, asked before a byte is written to it.
 *
 * `resolveSocket` answers "where is the engine". It is a string operation, so it cannot answer
 * "who put that file there" — and every reply this surface forwards is treated as the engine's
 * word: window titles, AX labels, `actConfirmed`. A path that another account created, or one that
 * anyone on the machine may talk to, is not a trust anchor; it is a channel into the model's
 * context from wherever the socket came. `GLASSPANE_SOCKET` is therefore a trust root, not just a
 * location, and the same rule applies to the default path: the daemon binds it, so it can be
 * replaced by anything that can write the directory.
 *
 * The three facts that make an answer trustworthy, measured against the daemon this product ships
 * (`launchctl` job `com.glasspane.daemon`, engine running as the invoking user):
 *  - `~/.glasspane` is `drwx------` and `engine.sock` is `srw-------`, both owned by the uid that
 *    runs the harness. A socket nobody but its owner may write to, sitting in a directory nobody
 *    but its owner may create files in, cannot have been bound by a second account;
 *  - the inode at the path is a socket, so a plain file planted there is named as such instead of
 *    producing a connect error that reads like "the daemon is down";
 *  - write bits for group or other are the disqualifier, not every permission bit: a listener that
 *    grants `0666` is advertising itself to the machine, and this product's engine never does.
 *
 * `ENOENT` deliberately returns "nothing to say": no file at the path is the daemon-not-running
 * case, which `rawRequest` already renders as `GP_E_ENGINE_UNREACHABLE` with the restart command.
 * Turning it into a trust refusal here would rename a known condition and break the remedy the
 * agent is supposed to copy. A stat that fails for any OTHER reason is a refusal, because
 * "could not ask" is not evidence of trust.
 *
 * `read` and `euid` are seams, not abstractions: the ownership branches cannot be produced by an
 * unprivileged test process, and a check whose only exercised path is the friendly one has not been
 * tested. Every other case runs against a real socket on a real filesystem. `euid` is `null` when
 * the runtime cannot answer which account it is — that is a refusal too, not a free pass.
 */
export function trustSocket(
  target: string,
  read: (p: string) => SocketEvidence = statSync,
  euid: number | null = process.geteuid?.() ?? null,
): LocationRejection | null {
  if (euid === null) {
    return {
      code: "GP_E_SOCKET_TRUST",
      message: `this runtime answers no geteuid(), so it cannot say whether the engine socket at ${target} belongs to the account running it`,
      remedy: `run the harness under node or bun on macOS or Linux (the platforms this product ships on); the product's own installer checks with \`node -e 'console.log(process.geteuid())'\``,
    }
  }

  let socket: SocketEvidence
  try {
    socket = read(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    return {
      code: "GP_E_SOCKET_TRUST",
      message: `the engine socket at ${target} could not be inspected (${(error as NodeJS.ErrnoException).code ?? "unknown error"}), so this process cannot say whether the thing listening there is the engine`,
      remedy: `make the path readable for a stat with \`ls -ld ${target}\`; if the background service owns it, bring it up with \`launchctl kickstart -k gui/\$(id -u)/com.glasspane.daemon\` and retry`,
    }
  }

  if (!socket.isSocket()) {
    return {
      code: "GP_E_SOCKET_TRUST",
      message: `${target} is not a socket, so nothing can answer as the engine from it`,
      remedy: `bring the background service up with \`launchctl kickstart -k gui/\$(id -u)/com.glasspane.daemon\`, confirm what is at that path with \`ls -l ${target}\`, and point GLASSPANE_SOCKET at the socket the daemon binds if it lives elsewhere`,
    }
  }

  const directory = path.dirname(target)
  let dir: SocketEvidence
  try {
    dir = read(directory)
  } catch (error) {
    return {
      code: "GP_E_SOCKET_TRUST",
      message: `the directory holding the engine socket (${directory}) could not be inspected (${(error as NodeJS.ErrnoException).code ?? "unknown error"}), so this process cannot say who may replace ${target}`,
      remedy: `make it readable with \`ls -ld ${directory}\`, or bring the background service up with \`launchctl kickstart -k gui/\$(id -u)/com.glasspane.daemon\` so it re-creates its state root at the default path`,
    }
  }

  const unowned = [
    [socket, target, "socket"],
    [dir, directory, "directory"],
  ] as const
  for (const [entry, where, kind] of unowned) {
    if (entry.uid === euid) continue
    return {
      code: "GP_E_SOCKET_TRUST",
      message: `the engine ${kind} ${where} belongs to uid ${entry.uid}, not to this process (uid ${euid}), so whatever listens there was not placed there by this account`,
      remedy: `run the harness as the account that owns \`glasspaned\`, or point GLASSPANE_SOCKET at the socket that account bound (default ${path.join(os.homedir(), ".glasspane", "engine.sock")}); check the owner with \`ls -ld ${where}\``,
    }
  }

  // Write is the bit that matters: on a socket it grants the ability to send, on a directory the
  // ability to create or replace the entry. Execute-only for others (`0755`, which is what a
  // listener created by node itself carries before any chmod) lets a reader *look*, not talk.
  if (socket.mode & 0o022) {
    return {
      code: "GP_E_SOCKET_TRUST",
      message: `the engine socket ${target} carries mode ${(socket.mode & 0o7777).toString(8)}, which lets another account send requests to it — an answer from there is not evidence of what the engine said`,
      remedy: `tighten it to owner-only with \`chmod 600 ${target}\` and restart the background service with \`launchctl kickstart -k gui/\$(id -u)/com.glasspane.daemon\` so it binds its own socket`,
    }
  }
  if (dir.mode & 0o022) {
    return {
      code: "GP_E_SOCKET_TRUST",
      message: `the directory holding the engine socket (${directory}) carries mode ${(dir.mode & 0o7777).toString(8)}, so another account can create or replace ${target}; this process cannot tell the engine's socket from one planted next to it`,
      remedy: `make it owner-only with \`chmod 700 ${directory}\` and bring the background service up with \`launchctl kickstart -k gui/\$(id -u)/com.glasspane.daemon\``,
    }
  }
  return null
}

function rawRequest(method: string, params: object, timeoutMs: number): Promise<DaemonReply> {
  return new Promise((resolve) => {
    const located = resolveSocket()
    if (!located.ok) {
      // Total by construction, like every other path here: an unusable setting is a
      // reply the agent can read, not an exception the tool runtime swallows.
      resolve(failure(located.error.code, located.error.message, located.error.remedy))
      return
    }
    const target = located.socket
    // Trust before traffic: everything below treats a reply as the engine's word, and a
    // socket someone else created or anyone may write to cannot carry that claim. A refusal
    // here is the same three-field frame the engine's own errors arrive in, so the agent reads
    // it as a verdict with a remedy rather than as a crash.
    const untrusted = trustSocket(target)
    if (untrusted) {
      resolve(failure(untrusted.code, untrusted.message, untrusted.remedy))
      return
    }
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
          `start it with \`launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon\`, confirm it came up with \`launchctl print gui/$(id -u)/com.glasspane.daemon\`, then retry ${method}`,
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
        finish(failure("GP_E_INTERNAL", `the daemon sent a frame that is not valid JSON: ${frame.slice(0, 160)}`, "run gp_probe_status once to see whether the daemon still answers; if it does, repeat this call once. If the frame is malformed again, read the daemon's own tail with `tail -n 20 ~/.glasspane/installer-daemon.log` — and treat this operation as having NO evidence rather than an unknown one: do not retry it in a loop, and do not report anything it would have verified"))
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
      // `{id, result}` or `{id, error}`, and the question here is presence, not
      // truthiness: `result: null` is a frame the client must still hand up rather than
      // turn into a failure it did not see. It is NOT a frame the engine emits —
      // `lastEvidence(operationId:)` throws `GP_E_NO_EVIDENCE` when there is nothing to
      // give back (`EngineCore.swift:1631-1644`) and every other method answers with an
      // object — so nothing downstream may read `null` as "the engine said something".
      // A frame carrying neither field was, until now, resolved as `{ok: true, result:
      // undefined}`, which the tool layer then rendered as a call that went through: the
      // model read that the click happened when the engine answered nothing at all. A transport
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
 *
 * The budget comes from `TIMEOUT_MS` by method name. A caller may still pass one
 * (the offline E7/E8 measurements wait longer than the tool surface does), but no
 * call site in `src/tool/glasspane/` does — that is what keeps the table and the
 * surface from drifting apart, and the surface test pins it.
 */
export function call(method: string, params: object = {}, timeoutMs: number = timeoutFor(method)) {
  return Effect.promise(() => rawRequest(method, params, timeoutMs))
}

/** `hello` is the only place capabilities and versions come from. */
export function hello() {
  return call("hello")
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
        // The daemon's permission seats are strings ("granted" / "denied" / "unverifiable"), and
        // `gp_probe_status` hands this object straight to the model as the engine's seat report.
        // `as Record<string, string>` asserted that shape instead of reading it: a seat carrying a
        // number, a nested object or an array reached the transcript looking like a verdict, which
        // is the one thing this surface must not do — decide what a permission state means.
        // A seat this layer cannot read keeps its NAME (dropping it would make the report say the
        // engine has fewer seats than it adverted) and gets a value that says what went wrong.
        permissions: Object.fromEntries(
          Object.entries(report.permissions ?? {}).map(([seat, state]) => [
            seat,
            typeof state === "string" ? state : `unreadable: the engine sent ${state === null ? "null" : typeof state}, not a state string`,
          ]),
        ) as Record<string, string>,
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
