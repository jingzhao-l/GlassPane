import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Agent } from "@/agent/agent"
import * as Truncate from "@/tool/truncate"
import { Effect, Layer, Schema } from "effect"

import { AttachParams, ObserveParams, engineBody, glasspaneDefs, present, refused, requireCapability } from "../../src/tool/glasspane/index"
import type { Context as ToolContext } from "../../src/tool/tool"
import { DIMENSION_ID_LIMITS, validateDimension, validateSelector } from "../../src/tool/glasspane/kernel"
import * as Daemon from "../../src/tool/glasspane/daemon"

/**
 * M1 fixed points — the contract the tool surface has with the host and the model.
 *
 * Four invariants, each of which has already failed somewhere in this project's
 * history, so each gets its own assertion instead of prose:
 *  - ids arrive raw and unique (E2: upstream does not namespace them — and a
 *    duplicated id would silently shadow one of the six);
 *  - a failure's message *and* remedy live in `output`, because the model only
 *    reads `output` (E6 measured this: a metadata-only remedy is invisible);
 *  - the daemon's error frame is exactly `{code, message, remedy}` with a
 *    non-empty remedy — the shape every shell renders;
 *  - a refusal the surface renders is the engine's, field for field. Relabelling one
 *    (a busy daemon reported as "capability unavailable") answers a question the
 *    engine never asked, and throws away the remedy it attached.
 *
 * Deliberately not asserted: *which* methods the engine supports. That list is
 * read from `hello.capabilities` at call time precisely because it grows
 * (`audit_ui` arrived after this file was written); pinning it here would
 * recreate the stale copy the design forbids.
 */

describe("what the registry receives", () => {
  // `loadDefs` is module-level: the guard-order tests drive the same defs these id/description
  // assertions read, and two loaders would be two things to keep in agreement.
  test("every def is a unique raw gp_* id with a description and a parser", async () => {
    const defs = await loadDefs()
    const ids = defs.map((def) => def.id)
    // The exact surface, not "more than zero". `defs.length > 0` was satisfied by one
    // surviving def, so a `glasspaneDefs` that dropped five of the six — the five that carry
    // the permission patterns, the declared-dimension parameter and the evidence citation —
    // stayed green while the product lost most of its tools. The set is `glasspaneDefs`'s
    // own list (src/tool/glasspane/index.ts): the six `gp_*` tools this fork ships.
    expect([...ids].sort()).toEqual([
      "gp_act",
      "gp_attach",
      "gp_diagnose",
      "gp_last_evidence",
      "gp_observe",
      "gp_probe_status",
    ])
    expect(new Set(ids).size).toBe(ids.length)
    for (const def of defs) {
      expect(def.id.startsWith("gp_")).toBe(true)
      expect(def.id.length).toBeGreaterThan("gp_".length)
      expect(def.description.length).toBeGreaterThan(0)
      expect(def.parameters).toBeDefined()
    }
  })

  test("gp_probe_status exists — every remedy this surface emits names it", async () => {
    const defs = await loadDefs()
    expect(defs.map((def) => def.id)).toContain("gp_probe_status")
  })

  test("gp_probe_status's description reports the permission seats without copying the engine's set", async () => {
    // The description used to read "the four macOS permission seats (accessibility, input
    // monitoring, screen recording, developer tools)". The transport never validates a
    // count: `daemon.ts`'s `probeCapabilities` hands `permissions` straight out of `hello`
    // as an open record, so the day the engine adds or renames a seat that sentence lies to
    // the model about what the tool reports. Same reason `requireCapability` above asks
    // `hello.capabilities` instead of carrying a method table — the harness does not restate
    // the engine's sets in its own text.
    const defs = await loadDefs()
    const description = defs.find((def) => def.id === "gp_probe_status")?.description ?? ""
    expect(description.length).toBeGreaterThan(0)
    expect(description).toContain("permission seats")
    // no count in front of the seats, written as a digit…
    expect(description).not.toMatch(/\b\d+\s+(?:[\w-]+\s+)*permission seat/i)
    // …or spelled as a word, and no closed enumeration after the phrase
    expect(description).not.toMatch(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:[\w-]+\s+)*permission seat/i)
    expect(description).not.toMatch(/permission seat\w*\s*\(/i)
    for (const seat of ["input monitoring", "screen recording", "developer tools"]) {
      expect(description, `the description enumerates the engine's seats: ${seat}`).not.toContain(seat)
    }
  })

  test("observe's depth is bounded by the schema, not by the description", async () => {
    // The "1-10" used to live only in the description string. An agent that asked
    // for maxDepth=100000 got a request the daemon had to answer with a
    // payload error — a wasted round trip, and a context lever pointed at the
    // model's own tool call. The bound is now the schema, so the model is
    // corrected before anything leaves the process.
    const { ObserveParams } = await import("../../src/tool/glasspane/index")
    const { Schema } = await import("effect")
    const decode = Schema.decodeUnknownEffect(ObserveParams)
    expect(Effect.runSync(decode({ maxDepth: "6" })).maxDepth).toBe(6)
    for (const bad of ["0", "11", "100000", "-1"]) {
      let rejected = false
      try {
        Effect.runSync(decode({ maxDepth: bad }))
      } catch {
        rejected = true
      }
      expect(rejected).toBe(true)
    }
  })
})

describe("what the model reads on the failure path", () => {
  test("message and remedy go into output, not only into metadata", () => {
    const reply: Daemon.DaemonReply = {
      ok: false,
      error: { code: "GP_E_NO_EVIDENCE", message: "the archive is empty", remedy: "call gp_last_evidence" },
    }
    const result = present("gp_last_evidence", "last_evidence", reply, () => "unreachable")
    expect(result.output).toContain("the archive is empty")
    expect(result.output).toContain("remedy: call gp_last_evidence")
    expect(result.output).not.toBe("unreachable") // the summary never replaces a failure
    expect(result.metadata).toMatchObject({
      ok: false,
      method: "last_evidence",
      code: "GP_E_NO_EVIDENCE",
      result: null,
    })
  })

  test("a refusal carries the engine's three fields, and nothing this surface invented", () => {
    const error: Daemon.DaemonError = { code: "GP_E_NO_EVIDENCE", message: "the archive is empty", remedy: "call gp_last_evidence" }
    const result = refused("gp_last_evidence", "last_evidence", error)
    expect(result.output).toBe("the archive is empty\nremedy: call gp_last_evidence")
    expect(result.metadata).toMatchObject({
      ok: false,
      code: "GP_E_NO_EVIDENCE",
      message: "the archive is empty",
      remedy: "call gp_last_evidence",
      result: null,
    })
  })
})

describe("what the model reads on the success path", () => {
  test("the summary is the engine's, and the metadata shape is fixed", () => {
    const reply: Daemon.DaemonReply = { ok: true, result: { pid: 4242 } }
    const result = present("gp_probe_status", "probe_status", reply, () => "engine said so")
    expect(result.output).toBe("engine said so")
    expect(result.metadata).toMatchObject({
      ok: true,
      method: "probe_status",
      code: null,
      message: null,
      remedy: null,
      result: { pid: 4242 },
    })
  })

  test("a transport that got an answer titles it answered, not ok", () => {
    // `metadata.ok` is a fact about this call: the engine sent a frame and did not send an
    // error frame. The title is read by the TUI row and by the transcript line, and it used
    // to spell that fact `${tool}: ${method} ok` — so a reply whose own payload reads
    // `actConfirmed: false` (the engine's verdict: the click did not take) displayed beside a
    // word that means the opposite. Deciding what the payload means is the Swift engine's job
    // and nothing in this fork may synthesize it, including here: the row now says only what
    // this layer observed.
    const reply: Daemon.DaemonReply = {
      ok: true,
      result: { operationId: "op_AAAAAAAAAAAAAAAAAAAAAAAAAA", actConfirmed: false, axChanged: false, pixelChanged: false },
    }
    const row = present("gp_act", "act", reply, (result) => JSON.stringify(result, null, 2))
    expect(row.title).toBe("gp_act: act answered")
    expect(row.title).not.toMatch(/\bok\b/i)
    // The engine's verdict survives untouched in the payload the agent reads.
    expect(row.output).toContain('"actConfirmed": false')
    expect((row.metadata as { result: Record<string, unknown> }).result.actConfirmed).toBe(false)
  })
})

describe("the daemon's error frame, measured against a real dead socket", () => {
  test("an unreachable socket still answers {code,message,remedy} — never a raised defect", async () => {
    const previous = process.env.GLASSPANE_SOCKET
    process.env.GLASSPANE_SOCKET = path.join(tmpdir(), "gp-m1-no-such-daemon.sock")
    try {
      const reply = await Effect.runPromise(Daemon.call("hello", {}, 2_000))
      expect(reply.ok).toBe(false)
      if (reply.ok) return
      expect(reply.error.code).toBe("GP_E_ENGINE_UNREACHABLE")
      expect(reply.error.message.length).toBeGreaterThan(0)
      expect(reply.error.remedy.length).toBeGreaterThan(0)
    } finally {
      if (previous === undefined) delete process.env.GLASSPANE_SOCKET
      else process.env.GLASSPANE_SOCKET = previous
    }
  })
})

/**
 * `resolveSocket` answers "where is the engine"; these are the cases for "may this process believe
 * what answers there". Every refusal shape is produced on a real inode where a real inode is
 * possible, and the one that is not — a socket owned by another account — is fed the numbers a real
 * `stat` returns rather than a mocked call, because an unprivileged test cannot create another
 * uid's file and a rule only ever exercised by the friendly input has not been exercised.
 */
describe("which socket this process may believe", () => {
  /** A state root in the shape the shipped engine leaves: a fresh 0700 directory, owner = us. */
  const stateRoot = () => mkdtempSync(path.join(tmpdir(), "gp-trust-"))

  const listen = async (socket: string) => {
    const server = net.createServer(() => {})
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socket, resolve)
    })
    return server
  }

  const close = (server: net.Server, dir: string) => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }

  /** The uid this process really is. `process.geteuid` is optional in the types because Windows
   * has no such call; this product ships macOS only, so a runtime that cannot answer here is a
   * broken test host and must not be papered over with a plausible-looking `?? 0`. */
  const thisEuid = (): number => {
    const id = process.geteuid?.()
    if (id === undefined) throw new Error("no geteuid on this runtime — the ownership cases cannot be driven here")
    return id
  }

  test("a runtime that cannot say which account it is gets a refusal, not a pass", () => {
    // `process.geteuid` is optional in Node's own types. Falling back to a number would have made
    // every ownership check compare against a fiction.
    const dir = stateRoot()
    const socket = path.join(dir, "engine.sock")
    const evidence = { uid: 501, mode: 0o600, isSocket: () => true }
    try {
      const refusal = Daemon.trustSocket(socket, () => evidence, null)
      expect(refusal, "a runtime with no uid was trusted").not.toBeNull()
      if (!refusal) return
      expect(refusal.code).toBe("GP_E_SOCKET_TRUST")
      expect(refusal.message).toContain("geteuid")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the socket this product's engine actually binds is judged as it is found", () => {
    const located = Daemon.resolveSocket({})
    expect(located.ok, JSON.stringify(located)).toBe(true)
    if (!located.ok) return
    const verdict = Daemon.trustSocket(located.socket)
    // Two live states on any machine running this, both asserted rather than skipped: an engine
    // that is up must pass the rule exactly as the product leaves it (measured here: `~/.glasspane`
    // is drwx------ and `engine.sock` is srw-------, both owned by the uid running the harness —
    // if the rule ever refuses that, every `gp_*` tool is dead for every user), and no engine at
    // all is the daemon-not-running answer, which belongs to the transport, not to this rule.
    if (existsSync(located.socket)) {
      expect(verdict, `the live engine socket ${located.socket} was refused: ${JSON.stringify(verdict)}`).toBeNull()
      return
    }
    expect(verdict).toBeNull()
  })

  test("a socket that only its owner may talk to is trusted, whatever its read and execute bits", async () => {
    // A listener created without a chmod carries `0755` here (measured), which is the shape every
    // transport test in this file binds. The rule is about WRITE — the bit that lets another
    // account send requests — so `0755` must pass and `0666` must not. Requiring mode 0600 would
    // have refused this file's own fixtures, and in CI (`TMPDIR=/tmp`) it would have refused them
    // for a reason that looks like a code defect.
    const dir = stateRoot()
    const socket = path.join(dir, "engine.sock")
    const server = await listen(socket)
    try {
      expect(statSync(dir).mode & 0o777, "mkdtemp is 0700 by POSIX").toBe(0o700)
      expect(statSync(socket).mode & 0o022, "no write bit for group or other").toBe(0)
      expect(Daemon.trustSocket(socket)).toBeNull()
    } finally {
      close(server, dir)
    }
  })

  test("a socket other accounts may write to is refused by its own mode", async () => {
    const dir = stateRoot()
    const socket = path.join(dir, "engine.sock")
    const server = await listen(socket)
    try {
      chmodSync(socket, 0o666)
      expect(statSync(socket).mode & 0o777).toBe(0o666)
      const refusal = Daemon.trustSocket(socket)
      expect(refusal, "a 0666 engine socket was accepted").not.toBeNull()
      if (!refusal) return
      expect(refusal.code).toBe("GP_E_SOCKET_TRUST")
      expect(refusal.message).toContain("666")
      expect(refusal.remedy.length).toBeGreaterThan(0)
    } finally {
      close(server, dir)
    }
  })

  test("a socket sitting in a directory other accounts may create files in is refused", async () => {
    // `/tmp`-shaped: the socket's own bits are perfect, the hole is the directory next to it —
    // another account can replace the entry between one request and the next.
    const dir = stateRoot()
    const socket = path.join(dir, "engine.sock")
    const server = await listen(socket)
    try {
      chmodSync(dir, 0o777)
      const refusal = Daemon.trustSocket(socket)
      expect(refusal, "a socket in a 0777 directory was accepted").not.toBeNull()
      if (!refusal) return
      expect(refusal.code).toBe("GP_E_SOCKET_TRUST")
      expect(refusal.message).toContain(dir)
      expect(refusal.message).toContain("777")
    } finally {
      chmodSync(dir, 0o700)
      close(server, dir)
    }
  })

  test("a plain file at the socket path is named as not a socket, not as an engine that is down", () => {
    const dir = stateRoot()
    const target = path.join(dir, "engine.sock")
    writeFileSync(target, "not a socket\n")
    try {
      const refusal = Daemon.trustSocket(target)
      expect(refusal, "a regular file was accepted as an engine socket").not.toBeNull()
      if (!refusal) return
      expect(refusal.message).toContain("not a socket")
      expect(refusal.remedy).toContain("launchctl")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("nothing at the path is the daemon-not-running answer, which this rule does not own", () => {
    // ENOENT deliberately answers "nothing to say": the transport renders it as
    // GP_E_ENGINE_UNREACHABLE with the restart command, and the three tests above that pin that
    // frame depend on it. Turning it into a trust refusal here would rename a known condition and
    // bury the remedy the agent is supposed to copy.
    const dir = stateRoot()
    try {
      expect(Daemon.trustSocket(path.join(dir, "absent.sock"))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a socket or directory owned by another account is refused even when every bit is right", () => {
    // The one case no unprivileged process can bind, so it is handed the numbers a real `stat`
    // returns — `uid: 0` with `0600`/`0700` is root's own socket, which is exactly what an
    // attacker with any write path would leave behind, and what the shipped daemon never is.
    const dir = stateRoot()
    const socket = path.join(dir, "engine.sock")
    const me = thisEuid()
    const foreign = (target: string): Daemon.SocketEvidence =>
      target === dir
        ? { uid: 0, mode: 0o700, isSocket: () => false }
        : { uid: 0, mode: 0o600, isSocket: () => true }
    try {
      const refusal = Daemon.trustSocket(socket, foreign, me)
      expect(refusal, "a socket owned by uid 0 was accepted").not.toBeNull()
      if (!refusal) return
      expect(refusal.code).toBe("GP_E_SOCKET_TRUST")
      expect(refusal.message).toContain("uid 0")
      expect(refusal.message).toContain(`uid ${me}`)
      // The directory being the foreign one is a separate verdict, naming the directory.
      const dirOnly = (target: string): Daemon.SocketEvidence =>
        target === dir
          ? { uid: 0, mode: 0o700, isSocket: () => false }
          : { uid: me, mode: 0o600, isSocket: () => true }
      const byDir = Daemon.trustSocket(socket, dirOnly, me)
      expect(byDir, "a socket in a directory owned by uid 0 was accepted").not.toBeNull()
      if (!byDir) return
      expect(byDir.message).toContain(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a stat that cannot be taken is a refusal, never a pass", () => {
    // "Could not ask" is the shape this repository has been caught reporting as green more than
    // once. EACCES on the socket, and EACCES on the directory holding it, both answer.
    const dir = stateRoot()
    const socket = path.join(dir, "engine.sock")
    const me = thisEuid()
    const denied = (target: string): Daemon.SocketEvidence => {
      if (target === socket) throw Object.assign(new Error("denied"), { code: "EACCES" })
      return { uid: me, mode: 0o700, isSocket: () => false }
    }
    const deniedDir = (target: string): Daemon.SocketEvidence => {
      if (target === dir) throw Object.assign(new Error("denied"), { code: "EACCES" })
      return { uid: me, mode: 0o600, isSocket: () => true }
    }
    try {
      const socketDenied = Daemon.trustSocket(socket, denied, me)
      expect(socketDenied, "a socket that could not be stat-ed was accepted").not.toBeNull()
      if (!socketDenied) return
      expect(socketDenied.message).toContain("could not be inspected")
      const dirDenied = Daemon.trustSocket(socket, deniedDir, me)
      expect(dirDenied, "a directory that could not be stat-ed was accepted").not.toBeNull()
      if (!dirDenied) return
      expect(dirDenied.message).toContain(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("and the refusal reaches the model as the same three-field frame the engine's errors use", async () => {
    // Driven end to end, not by calling the predicate: the wiring in `rawRequest` is the half that
    // can rot. A real listener, its socket loosened to 0666, `Daemon.call` asked to believe it.
    const dir = stateRoot()
    const socket = path.join(dir, "engine.sock")
    const server = await listen(socket)
    chmodSync(socket, 0o666)
    const previous = process.env.GLASSPANE_SOCKET
    process.env.GLASSPANE_SOCKET = socket
    try {
      const reply = await Effect.runPromise(Daemon.call("hello", {}, 5_000))
      expect(reply.ok).toBe(false)
      if (reply.ok) return
      expect(reply.error.code).toBe("GP_E_SOCKET_TRUST")
      expect(reply.error.message.length).toBeGreaterThan(0)
      expect(reply.error.remedy.length).toBeGreaterThan(0)
      // No byte was written: refusing to trust is not a timeout, and the request never left.
      expect(reply.error.message).not.toContain("within")
    } finally {
      if (previous === undefined) delete process.env.GLASSPANE_SOCKET
      else process.env.GLASSPANE_SOCKET = previous
      close(server, dir)
    }
  })
})

/**
 * A real unix-socket peer, because the rules below live in the client's byte loop
 * and in the call sites that read its replies: a fabricated `DaemonReply` would only
 * re-state the test's own fixture. `run` is whatever talks to the peer — a raw
 * `Daemon.call` for the transport cases, the capability gate for the refusal cases.
 *
 * The socket is bound inside a fresh `mkdtemp` directory rather than loose in `tmpdir()`,
 * because `trustSocket` refuses a socket whose directory other accounts may write to — and
 * that is the production shape, not an accommodation: the daemon's own state root is
 * `drwx------` (measured `~/.glasspane`, mode 700, owner = the uid running the harness).
 * On this machine `tmpdir()` happens to be 0700 so a loose socket would pass by luck; in CI
 * `TMPDIR=/tmp` is 01777 and the same fixture would be refused for a reason that is the rule
 * working. `mkdtempSync` is 0700 by POSIX, so the fixture carries the shape it is testing.
 */
async function withDaemonPeer<T>(
  name: string,
  serve: (conn: net.Socket, request: string) => void,
  run: () => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), `gp-m1-frame-${name}-`))
  const socket = path.join(dir, "engine.sock")
  const server = net.createServer((conn) => {
    conn.once("data", (chunk) => serve(conn, chunk.toString("utf8")))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, resolve)
  })
  const previous = process.env.GLASSPANE_SOCKET
  process.env.GLASSPANE_SOCKET = socket
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.GLASSPANE_SOCKET
    else process.env.GLASSPANE_SOCKET = previous
    server.close()
    try {
      unlinkSync(socket)
    } catch {
      // best effort, as above
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort: a leftover 0700 directory under tmpdir is not worth failing over
    }
  }
}

const withPeer = (
  name: string,
  serve: (conn: net.Socket, request: string) => void,
  check: (reply: Daemon.DaemonReply) => void,
  timeoutMs = 8_000,
) => withDaemonPeer(name, serve, () => Effect.runPromise(Daemon.call("act", {}, timeoutMs))).then(check)

/** The capability gate `gp_act` runs before it sends anything, against `serve`. */
const withGate = (name: string, serve: (conn: net.Socket, request: string) => void) =>
  withDaemonPeer(name, serve, () => Effect.runPromise(requireCapability("gp_act", "act")))

const refusal = (reply: Daemon.DaemonReply, code: string) => {
  expect(reply.ok).toBe(false)
  if (reply.ok) return
  expect(reply.error.code).toBe(code)
  expect(reply.error.message.length).toBeGreaterThan(0)
  expect(reply.error.remedy.length).toBeGreaterThan(0)
}

describe("what the transport accepts as an answer", () => {
  // Every case here is a frame the *engine* could send and the client must not
  // launder into success.

  test("a frame with neither result nor error is a refusal, not a success", async () => {
    // The shape that used to resolve `{ok: true, result: undefined}` and render as
    // "gp_act: act ok" — the model reading that the click happened when the engine
    // answered nothing.
    await withPeer("empty", (conn) => conn.write(`${JSON.stringify({ id: 1 })}\n`), (reply) => refusal(reply, "GP_E_INTERNAL"))
  })

  test("a frame whose error is a bare string is an error, and is not blamed for lacking one", async () => {
    // `{"error": "<string>"}` used to slip past the error branch (it only accepted an
    // object) and land in the "neither a result nor an error" refusal: right call,
    // wrong charge, and the engine's own words were dropped on the floor.
    await withPeer("string-error", (conn) => conn.write(`${JSON.stringify({ id: 1, error: "the engine is mid-restore" })}\n`), (reply) => {
      expect(reply.ok).toBe(false)
      if (reply.ok) return
      expect(reply.error.message).toBe("the engine is mid-restore")
      expect(reply.error.message).not.toContain("neither a result nor an error")
      expect(reply.error.code).toBe("GP_E_INTERNAL") // no code in the frame; say which field is missing rather than guess one
      expect(reply.error.remedy).toContain("no remedy")
    })
  })

  test("a transport-level probe of a frame shape the engine does not emit", async () => {
    // LABELLED AS WHAT IT IS. This is not "a real result the engine sends": measured
    // against the engine, `lastEvidence(operationId:)` THROWS `GP_E_NO_EVIDENCE` for both
    // the with-id and no-id lookup when there is nothing to hand back
    // (`EngineCore.swift:1631-1644`), and `Dispatcher.swift:156` wraps the pack in an
    // object — no method answers with a bare `result: null`. What the case does measure is
    // the client's own rule: presence, not truthiness, decides "the daemon answered", so a
    // frame this shape must not be laundered into a refusal at the transport while a
    // different one is invented into success.
    //
    // Downstream is where the honesty lives, and it is pinned there rather than asserted
    // from here: `readEvidenceFrame` answers `GP_E_EVIDENCE_FRAME` for this value
    // (test/tool/glasspane-kernel.test.ts) and the M2 hook records `status: "failed"` with
    // a remedy the agent can actually run (test/plugin/glasspane-decision-log.test.ts).
    // The tool row itself still reads ok — the transport did get an answer — which is
    // exactly why the failure has to be said by the layer that reads the frame.
    await withPeer("null-result", (conn) => conn.write(`${JSON.stringify({ id: 1, result: null })}\n`), (reply) => {
      expect(reply.ok).toBe(true)
      if (!reply.ok) return
      expect(reply.result).toBeNull()
    })
  })

  test("a frame that is not an object is a refusal", async () => {
    await withPeer("bare", (conn) => conn.write("123\n"), (reply) => refusal(reply, "GP_E_INTERNAL"))
    await withPeer("nullish", (conn) => conn.write("null\n"), (reply) => refusal(reply, "GP_E_INTERNAL"))
  })

  test("an answer for another request id is not this call's result", async () => {
    await withPeer("wrong-id", (conn) => conn.write(`${JSON.stringify({ id: 7, result: { clicked: true } })}\n`), (reply) =>
      refusal(reply, "GP_E_INTERNAL"),
    )
  })

  test("a peer that hangs up without answering fails fast, as unreachable", async () => {
    // The daemon serves one connection at a time; closing it is a reachable state, and
    // the old code waited out the whole timeout and then blamed a busy input window.
    await withPeer(
      "hangup",
      (conn) => {
        conn.destroy()
      },
      (reply) => refusal(reply, "GP_E_ENGINE_UNREACHABLE"),
      8_000,
    )
  })

  test("a multi-byte title split across data events survives intact", async () => {
    // "窗口" in UTF-8 straddles the chunk boundary on purpose. Per-chunk
    // `chunk.toString("utf8")` cut it into replacement characters, which then either
    // failed JSON.parse (reported as the daemon sending invalid JSON) or reached the
    // model as a corrupted window title.
    const frame = `${JSON.stringify({ id: 1, result: { title: "GlassPane 验收窗口 — 设置" } })}\n`
    const bytes = Buffer.from(frame, "utf8")
    const marker = Buffer.from("窗", "utf8")
    const at = bytes.indexOf(marker)
    // Cut one byte into a three-byte sequence: the first chunk ends mid-character.
    const split = bytes.subarray(0, at + 1)
    const rest = bytes.subarray(at + 1)
    await withPeer("utf8-boundary", (conn) => {
      conn.write(split)
      setTimeout(() => conn.write(rest), 10)
    }, (reply) => {
      expect(reply.ok).toBe(true)
      if (!reply.ok) return
      expect((reply.result as { title?: string }).title).toBe("GlassPane 验收窗口 — 设置")
    })
  })
})

describe("what the capability gate says when hello could not answer", () => {
  // The gate refuses a method the engine has not announced. That refusal is a claim
  // about the engine, so it may only be made from what the engine actually said:
  // these cases drove the *same* code path with a busy daemon, a timed-out daemon and
  // an empty self-report, and all three used to come back as
  // "the background service did not report capabilities" with a hardcoded
  // GP_E_CAPABILITY_UNAVAILABLE and a hardcoded instruction to restart a service that
  // was running fine. Availability is still read from `hello.capabilities` — nothing
  // below asserts a method list, which is exactly what the design forbids copying.
  const helloAdvertises = (result: Record<string, unknown>) => (conn: net.Socket) =>
    conn.write(`${JSON.stringify({ id: 1, result })}\n`)

  test("a daemon holding its single connection slot is unreachable, not capability-unavailable", async () => {
    // The reachable busy state: the daemon serves one connection at a time and hangs
    // up on the second one, which is what every hello looks like while another client
    // is driving the engine.
    const blocked = await withGate("busy-slot", (conn) => conn.destroy())
    expect(blocked?.metadata).toMatchObject({ ok: false, code: "GP_E_ENGINE_UNREACHABLE" })
    expect(blocked?.output).toContain("single connection slot") // the engine's remedy survives
    expect(blocked?.output).not.toContain("did not report capabilities")
    expect(blocked?.output).not.toContain("does not advertise")
  })

  test("an engine that answers hello with its own timeout is quoted, not re-coded", async () => {
    const blocked = await withGate(
      "engine-timeout",
      (conn) =>
        conn.write(
          `${JSON.stringify({
            id: 1,
            error: { code: "GP_E_ENGINE_TIMEOUT", message: "the engine's own words", remedy: "the engine's own remedy" },
          })}\n`,
        ),
    )
    expect(blocked?.metadata).toMatchObject({
      ok: false,
      code: "GP_E_ENGINE_TIMEOUT",
      message: "the engine's own words",
      remedy: "the engine's own remedy",
      result: null,
    })
    expect(blocked?.output).toBe("the engine's own words\nremedy: the engine's own remedy")
    expect(blocked?.title).toBe("gp_act: GP_E_ENGINE_TIMEOUT")
  })

  test("a dead socket still reaches the model as three populated fields", async () => {
    const previous = process.env.GLASSPANE_SOCKET
    process.env.GLASSPANE_SOCKET = path.join(tmpdir(), "gp-m1-gate-no-such-daemon.sock")
    try {
      const blocked = await Effect.runPromise(requireCapability("gp_act", "act"))
      expect(blocked?.metadata).toMatchObject({ ok: false, code: "GP_E_ENGINE_UNREACHABLE" })
      if (!blocked) return
      expect(blocked.output.split("\n")).toHaveLength(2) // message and remedy, always both
      expect(blocked.output).toContain("remedy: ")
    } finally {
      if (previous === undefined) delete process.env.GLASSPANE_SOCKET
      else process.env.GLASSPANE_SOCKET = previous
    }
  })

  test("only a hello that advertised a list can say the capability is missing", async () => {
    const blocked = await withGate(
      "advertised-without-act",
      helloAdvertises({ version: "0.9.1", protocolVersion: "1", capabilities: ["observe"], permissions: {} }),
    )
    expect(blocked?.metadata).toMatchObject({ ok: false, code: "GP_E_CAPABILITY_UNAVAILABLE" })
    expect(blocked?.output).toContain('engine 0.9.1 does not advertise the "act" capability')
    expect(blocked?.output).toContain("gp_probe_status") // the surface's own remedy names a real next step
  })

  test("the capability the gate asks for is the method's own wire name", async () => {
    // Regression. `gp_attach` used to be gated on `"observe"`: an engine advertising
    // observe-without-attach was waved through to a method it does not have, and an engine
    // advertising attach-without-observe was refused one it does. The separate capability
    // argument is gone from the signature (the typechecker now refuses a call site that
    // names anything but the method), and this case pins both directions of the mismatch.
    const refusedNoAttach = await withDaemonPeer(
      "attach-not-advertised",
      helloAdvertises({ version: "0.9.1", protocolVersion: "1", capabilities: ["observe"], permissions: {} }),
      () => Effect.runPromise(requireCapability("gp_attach", "attach")),
    )
    expect(refusedNoAttach?.metadata).toMatchObject({ ok: false, code: "GP_E_CAPABILITY_UNAVAILABLE" })
    expect(refusedNoAttach?.output).toContain('does not advertise the "attach" capability')

    const allowed = await withDaemonPeer(
      "attach-advertised",
      helloAdvertises({ version: "0.9.1", protocolVersion: "1", capabilities: ["attach"], permissions: {} }),
      () => Effect.runPromise(requireCapability("gp_attach", "attach")),
    )
    expect(allowed).toBeUndefined()
  })

  test("an advertised list that carries the capability lets the call through", async () => {
    // The other half of the same rule: the gate is not a blanket refusal, and a list
    // naming the capability must not produce one.
    const blocked = await withGate(
      "advertised-act",
      helloAdvertises({ version: "0.9.1", protocolVersion: "1", capabilities: ["observe", "act"], permissions: {} }),
    )
    expect(blocked).toBeUndefined()
  })

  test("a hello that answered without a capability list refuses without claiming one", async () => {
    // The engine replied, and the reply said nothing about capabilities. Nothing is
    // established about `act`, so the refusal describes the reply it got.
    const blocked = await withGate("no-list", helloAdvertises({ version: "0.9.1" }))
    expect(blocked?.metadata).toMatchObject({ ok: false, code: "GP_E_INTERNAL" })
    expect(blocked?.output).toContain("without a capability list")
    expect(blocked?.output).not.toContain("does not advertise")
    if (!blocked) return
    expect(blocked.output.split("\n")).toHaveLength(2)
  })

  test("an advertised list carrying an unreadable entry claims nothing, in either direction", async () => {
    // `probeCapabilities` used to `filter` the advertised list down to its string entries and
    // hand the survivor to the gate as the engine's word. Both directions were wrong, and this
    // fixture pins both: an `act` gate facing `["observe", {…}]` asserted `engine <ver> does
    // not advertise the "act" capability` — a negative statement about the engine manufactured
    // out of our own decode — and a gate facing `["act", {…}]` let the call through while the
    // same decode had just discarded an advertised entry, endorsing a capability list it could
    // not read. The refusal now says the list could not be read, and neither affirms nor denies
    // any method.
    const absentAfterDecode = await withGate(
      "junk-entry-absent",
      helloAdvertises({ version: "0.9.1", protocolVersion: "1", capabilities: ["observe", { method: "act" }], permissions: {} }),
    )
    expect(absentAfterDecode?.metadata).toMatchObject({ ok: false, code: "GP_E_INTERNAL" })
    expect(absentAfterDecode?.output).toContain("cannot read")
    expect(absentAfterDecode?.output).toContain("not strings")
    expect(absentAfterDecode?.output).not.toContain("does not advertise")

    const presentAfterDecode = await withGate(
      "junk-entry-present",
      helloAdvertises({ version: "0.9.1", protocolVersion: "1", capabilities: ["act", { method: "actv2" }], permissions: {} }),
    )
    expect(presentAfterDecode, "a capability list with an unreadable entry let the call through").toBeDefined()
    expect(presentAfterDecode?.metadata).toMatchObject({ ok: false, code: "GP_E_INTERNAL" })
    expect(presentAfterDecode?.output).not.toContain("does not advertise")
  })

  test("a capability refusal still says which dimension the call declared", async () => {
    // The refusal half of the audit trail. A call that declared `security` and was stopped at
    // the gate rendered `dimension: null` — on the ledger of the session, a call that declared
    // nothing — while `gp_diagnose`'s refusals carried theirs. Both gate branches (the engine's
    // own failed hello, and the measured "does not advertise") take the declared id now, and
    // the call sites validate it before `hello` is asked to spend the daemon's single slot.
    const unadvertised = await withDaemonPeer(
      "gate-dimension-refusal",
      helloAdvertises({ version: "0.9.1", protocolVersion: "1", capabilities: ["observe"], permissions: {} }),
      () => Effect.runPromise(requireCapability("gp_act", "act", "security")),
    )
    expect(unadvertised?.metadata).toMatchObject({ ok: false, code: "GP_E_CAPABILITY_UNAVAILABLE", dimension: "security" })

    const busy = await withDaemonPeer(
      "gate-dimension-busy",
      (conn) => conn.destroy(),
      () => Effect.runPromise(requireCapability("gp_observe", "observe", "spec-compliance")),
    )
    expect(busy?.metadata).toMatchObject({ ok: false, code: "GP_E_ENGINE_UNREACHABLE", dimension: "spec-compliance" })

    // The three gated tools hand the gate their declared parameter, and validate it first:
    // an unvalidated id must not reach metadata, and a malformed call must not spend a hello.
    const source = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "tool", "glasspane", "index.ts"), "utf8")
    for (const [tool, method] of [["gp_attach", "attach"], ["gp_observe", "observe"], ["gp_act", "act"]] as const) {
      expect(source, `${tool} must pass its declared dimension to the gate`).toContain(`requireCapability("${tool}", "${method}", params.dimension ?? null)`)
      const at = source.indexOf(`requireCapability("${tool}", "${method}", params.dimension ?? null)`)
      const guard = source.lastIndexOf("const declared = validateDimension(params.dimension)", at)
      expect(guard, `${tool} must validate the dimension before the gate spends a hello`).toBeGreaterThan(-1)
      expect(guard).toBeLessThan(at)
    }
  })
})

describe("the seat report is read, not asserted", () => {
  // `probeCapabilities` used to end with `permissions: (report.permissions ?? {}) as Record<string, string>`.
  // An `as` on a daemon reply is this surface claiming knowledge the engine did not give it, and the
  // object it produces is printed straight into `gp_probe_status` for the model to read as the
  // engine's permission state. A seat carrying `1`, `null` or `{state:"granted"}` therefore reached
  // the transcript as if it were a verdict — which is the fork's first rule inverted.
  const seatHello = (permissions: unknown) => {
    const dir = mkdtempSync(path.join(tmpdir(), "gp-m1-seats-"))
    const socket = path.join(dir, "engine.sock")
    const server = net.createServer((conn) => {
      conn.once("data", () => {
        conn.write(`${JSON.stringify({ id: 1, result: { version: "1.23.0", protocolVersion: "1", capabilities: ["observe"], permissions } })}\n`)
      })
    })
    return { dir, socket, serve: () => new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve) }), stop: () => server.close() }
  }

  test("a string seat passes through untouched", async () => {
    const peer = seatHello({ accessibility: "granted", developerTools: "unverifiable" })
    await peer.serve()
    const previous = process.env.GLASSPANE_SOCKET
    process.env.GLASSPANE_SOCKET = peer.socket
    try {
      const probe = await Effect.runPromise(Daemon.probeCapabilities())
      expect(probe.ok).toBe(true)
      if (!probe.ok) return
      expect(probe.report.permissions).toEqual({ accessibility: "granted", developerTools: "unverifiable" })
    } finally {
      if (previous === undefined) delete process.env.GLASSPANE_SOCKET
      else process.env.GLASSPANE_SOCKET = previous
      peer.stop()
      rmSync(peer.dir, { recursive: true, force: true })
    }
  })

  test("a non-string seat keeps its name and says it could not be read", async () => {
    const peer = seatHello({ accessibility: 1, developerTools: null, screenCapture: { state: "granted" }, input: ["a", "b"] })
    await peer.serve()
    const previous = process.env.GLASSPANE_SOCKET
    process.env.GLASSPANE_SOCKET = peer.socket
    try {
      const probe = await Effect.runPromise(Daemon.probeCapabilities())
      expect(probe.ok).toBe(true)
      if (!probe.ok) return
      const seats = probe.report.permissions
      // Every named seat survives — deleting it would make the report claim the engine has fewer
      // seats than it adverted, which is a different false statement, not a lesser one.
      expect(Object.keys(seats).sort()).toEqual(["accessibility", "developerTools", "input", "screenCapture"])
      for (const seat of Object.keys(seats)) {
        expect(seats[seat]).toStartWith("unreadable:")
        expect(seats[seat]).not.toContain("granted")
      }
    } finally {
      if (previous === undefined) delete process.env.GLASSPANE_SOCKET
      else process.env.GLASSPANE_SOCKET = previous
      peer.stop()
      rmSync(peer.dir, { recursive: true, force: true })
    }
  })
})

describe("bounds the surface puts on itself", () => {
  test("an over-sized engine frame is refused in-band with a remedy — never a raised defect", async () => {
    // A real unix-socket peer is used on purpose: the cap is enforced in the
    // client's byte loop, so a fake `DaemonReply` would test nothing. The peer
    // answers with a single 5 MiB line (over MAX_FRAME_BYTES) and never a newline,
    // which is exactly what a runaway tree or a mis-chewed pack looks like.
    const oversizeDir = mkdtempSync(path.join(tmpdir(), "gp-m1-oversize-"))
    const socket = path.join(oversizeDir, "engine.sock")
    const server = net.createServer((conn) => {
      conn.once("data", () => {
        // 5 MiB with no frame boundary in sight.
        conn.write(Buffer.alloc(5 * 1024 * 1024, 0x78))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socket, resolve)
    })
    const previous = process.env.GLASSPANE_SOCKET
    process.env.GLASSPANE_SOCKET = socket
    try {
      // The peer answers with 5 MiB, and moving 5 MiB through a unix socket costs
      // real time on a loaded macOS laptop (measured ~4.7s here). The cap is
      // enforced correctly in either case, but a 5s *call* budget left no headroom,
      // so the call timed out first and the test reported GP_E_ENGINE_TIMEOUT for a
      // frame that is actually refused in-band. The budget now matches the fixed-point
      // lane's own 30s contract; what this test asserts is unchanged.
      const reply = await Effect.runPromise(Daemon.call("observe", {}, 30_000))
      expect(reply.ok).toBe(false)
      if (reply.ok) return
      expect(reply.error.code).toBe("GP_E_PAYLOAD_TOO_LARGE")
      expect(reply.error.remedy.length).toBeGreaterThan(0)
      expect(reply.error.remedy).toContain("maxDepth")
    } finally {
      if (previous === undefined) delete process.env.GLASSPANE_SOCKET
      else process.env.GLASSPANE_SOCKET = previous
      server.close()
      try {
        unlinkSync(socket)
      } catch {
        // best effort: a leftover socket under tmpdir is not worth failing over
      }
      try {
        rmSync(oversizeDir, { recursive: true, force: true })
      } catch {
        // best effort, as above
      }
    }
  })

  test("the registry's own visibility filter cannot hide a gp_* tool", () => {
    // Structural, and honestly labelled as such: building the whole registry needs
    // the full service graph, so this pins the *shape* of the one upstream line
    // that could swallow builtins (the code-mode `visible` filter) and the one
    // list code mode is actually scoped to (MCP tools). If either changes, this
    // test names the change instead of letting the surface disappear silently.
    const source = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "tool", "registry.ts"), "utf8")
    const visible = /const visible = filtered\.filter\(\(tool\) => tool\.id !== "execute" \|\| codeModeDescription\)/.test(
      source,
    )
    expect(visible).toBe(true)
    // Code mode only ever rewrites the visibility of the `execute` wrapper tool; no
    // gp_ id is named in any visibility predicate.
    const gpVisibilityRules = [...source.matchAll(/\(tool\)\s*=>[^\n]*gp_/g)]
    expect(gpVisibilityRules.length).toBe(0)
    // The code-mode catalog is built from MCP tools only, so turning the flag on
    // cannot fold the gp_* builtins into an MCP-only description.
    const codeMode = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "tool", "code-mode.ts"), "utf8")
    expect(/export function describeCatalog\(mcpTools: Record<string, MCP\.McpTool>/.test(codeMode)).toBe(true)
  })
})

describe("the declared review dimension (scenario 2, recorded half)", () => {
  test("the ids a run plan uses are the ids a call may declare", () => {
    // One vocabulary, checked against the other side's own validator: coverage only
    // counts a planned dimension when a recorded decision carries the same id, so two
    // spellings of the shape would report a verified session as 0 verified. These ids
    // are the published run-plan fixture's own.
    for (const id of ["correctness", "security", "spec-compliance", "style-tests", "frontend-backend", "ui-ux"]) {
      const read = validateDimension(id)
      expect(read.ok, `${id} should be a well-formed dimension id`).toBe(true)
      if (read.ok) expect(read.dimension).toBe(id)
    }
  })

  test("a malformed id is refused with the surface's own three fields", () => {
    for (const bad of ["Security", "SPEC", "spec_compliance", "spec compliance", "spec--compliance", "-security", "security-", "x".repeat(65), 42, {}, []]) {
      const read = validateDimension(bad)
      expect(read.ok, `${JSON.stringify(bad)} should not be accepted`).toBe(false)
      if (read.ok) continue
      expect(read.error.code).toBe("GP_E_DIMENSION")
      // Actionable, not descriptive: the caller has to be able to fix the call from this
      // text without opening the source.
      expect(read.error.remedy.length).toBeGreaterThan(20)
    }
  })

  test("absent means absent, and is never read as a dimension", () => {
    for (const absent of [undefined, null]) {
      const read = validateDimension(absent)
      expect(read.ok).toBe(true)
      if (read.ok) expect(read.dimension).toBeUndefined()
    }
  })

  test("present() puts the declaration where the transcript will keep it", () => {
    const reply: Daemon.DaemonReply = { ok: true, result: { operationId: "op_AAAAAAAAAAAAAAAAAAAAAAAAAA" } }
    const declared = present("gp_act", "act", reply, () => "ok", "security")
    expect((declared.metadata as Record<string, unknown>).dimension).toBe("security")
    const undeclared = present("gp_act", "act", reply, () => "ok")
    expect((undeclared.metadata as Record<string, unknown>).dimension).toBeNull()
  })

  test("the model-facing parameter schema takes the id and drops an absent one", async () => {
    // This is the boundary the model actually hits, so it is asserted at the schema and
    // not only at validateDimension: a declaration the host cannot even carry is a
    // parameter that exists in prose only.
    const { Schema } = await import("effect")
    const { ActParams } = await import("../../src/tool/glasspane/index")
    const decode = Schema.decodeUnknownSync(ActParams)
    const declared = decode({ selector: { role: "AXButton" }, action: "press", dimension: "spec-compliance" })
    expect((declared as { dimension?: string }).dimension).toBe("spec-compliance")
    const absent = decode({ selector: { role: "AXButton" }, action: "press" })
    expect((absent as { dimension?: string }).dimension).toBeUndefined()
  })

  test("a malformed id never reaches the model-facing schema as a valid call", async () => {
    // The annotation is optional, so the schema cannot reject a bad id by itself — which
    // is exactly why validateDimension sits in front of every daemon call instead of the
    // model being trusted to spell it right. Pinned here so the two halves are not
    // mistaken for one another.
    const { Schema } = await import("effect")
    const { ActParams } = await import("../../src/tool/glasspane/index")
    const decode = Schema.decodeUnknownSync(ActParams)
    expect(() => decode({ selector: { role: "AXButton" }, action: "press", dimension: "Spec Compliance" })).not.toThrow()
    expect(validateDimension("Spec Compliance").ok).toBe(false)
  })

  test("every refusal this file renders keeps the declared dimension", () => {
    // The rule `index.ts` states beside `requireCapability` is about EVERY refusal the file
    // writes, not about the two gate branches. The scan that used to sit here checked only
    // `requireCapability("gp_x", "x", params.dimension ?? null)`, so the next refusal added to
    // the same call site — the `validateSelector` one, which is exactly what happened — rendered
    // `dimension: null` for a call that had declared an id, and the file stayed green.
    //
    // A call site is therefore parsed, not pattern-matched: `callSites` splits the balanced
    // argument list, and the owning block decides whether the tool accepts a declaration at all.
    const source = surfaceIndexSource()
    const sites = refusalSites(source)
    // Non-vacuity: the shape this scan reads exists in the file eight times today (the five
    // dimension guards, the selector guard, and the two provider lookups). A scanner that found
    // nothing would grade nothing, so the floor is asserted by name rather than assumed.
    expect(sites.length, "the refused( scan found no call sites — it is measuring itself, not the source").toBeGreaterThanOrEqual(8)

    const offenders = refusalOffenders(source)
    expect(
      offenders.map((site) => ({ target: site.target, error: site.error, given: site.given })),
      `refusals that drop the declared dimension: ${JSON.stringify(offenders.map((site) => site.target))}`,
    ).toEqual([])

    // The same rule, measured rather than scraped: a declared id refused by the selector guard
    // still reaches the model's metadata. Pinned beside the scan because the scan can only check
    // what the source says, not what the rendered row holds.
    const row = refused("gp_act", "act", { code: "GP_E_SELECTOR", message: "m", remedy: "r" }, "security")
    expect((row.metadata as Record<string, unknown>).dimension).toBe("security")
  })

  test("the metadata shape stays one shape, refusal included", () => {
    // Upstream infers the tool's metadata type from what `execute` returns, so a key
    // present on one branch and absent on the other becomes a union the registry cannot
    // carry — the failure this file already pins for the other six fields.
    const ok = present("gp_act", "act", { ok: true, result: {} }, () => "ok", "security")
    const bad = refused("gp_act", "act", { code: "GP_E_TEST", message: "m", remedy: "r" }, "security")
    expect(Object.keys(ok.metadata as object).sort()).toEqual(Object.keys(bad.metadata as object).sort())
  })

  test("the engine is never told about our annotation", () => {
    const body = engineBody({ selector: { role: "AXButton" }, action: "press", degrade: true, dimension: "security" })
    expect(Object.keys(body).sort()).toEqual(["action", "degrade", "selector"])
    expect(JSON.stringify(body)).not.toContain("security")
    // Stripping must not eat a real parameter either.
    expect((body.selector as { role: string }).role).toBe("AXButton")
  })

  test("every tool that can yield a decision declares the parameter, and the one that cannot does not", () => {
    // gp_probe_status returns a self-report with no evidence frame, so no decision can
    // ever be attributed to it; a parameter nobody can read is how a surface starts
    // claiming coverage it does not have.
    const source = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "tool", "glasspane", "index.ts"), "utf8")
    for (const name of ["AttachParams", "ObserveParams", "ActParams", "DiagnoseParams", "LastEvidenceParams"]) {
      expect(structBody(source, name), `${name} must accept a declared dimension`).toContain("dimension: DimensionArg")
    }
    expect(structBody(source, "ProbeStatusParams")).not.toContain("DimensionArg")

    // And each of the five validates before the daemon is asked to do anything: a call
    // that reached the engine with a bad id would produce evidence attributed to nothing.
    for (const method of ["attach", "observe", "act", "diagnose", "last_evidence"]) {
      const at = source.indexOf(`Daemon.call("${method}"`)
      expect(at, `${method} call site not found`).toBeGreaterThan(-1)
      const guard = source.lastIndexOf(`if (!declared.ok) return refused("gp_${method}"`, at)
      expect(guard, `${method} must validate the dimension before calling the daemon`).toBeGreaterThan(-1)
      expect(guard).toBeLessThan(at)
    }
  })

  test("the annotation is validated against the kernel, not a local copy of its regex", () => {
    // The pattern's owner is the kernel's dimension contract; a local regex is a second
    // source that can drift, and the drift shows up as declarations that never match a
    // plan rather than as an error.
    const source = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "tool", "glasspane", "index.ts"), "utf8")
    expect(source).toContain('import { DIMENSION_ID_LIMITS, validateDimension')
    const binding = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "tool", "glasspane", "kernel.ts"), "utf8")
    expect(binding).toContain("DIMENSION_ID_MAX_LENGTH, DIMENSION_ID_PATTERN } from \"iterate-kernel/dimension-context\"")
    expect(DIMENSION_ID_LIMITS.pattern.source).toBe("^[a-z0-9]+(?:-[a-z0-9]+)*$")
    expect(DIMENSION_ID_LIMITS.maxLength).toBe(64)
  })
})

describe("the order the guards run in, and what each one costs", () => {
  /**
   * A daemon peer that answers only what the test tells it to advertise, and records every frame
   * it received. Both halves are load-bearing: the refusal tests need to count the connections
   * the surface spends, and a stub that answered every method would be endorsing a capability
   * the run never advertised — so an unadvertised method comes back as the engine's own
   * unknown-method frame.
   */
  function enginePeer(advertised: string[]) {
    const frames: { method: string }[] = []
    const serve = (conn: net.Socket, request: string) => {
      const parsed = JSON.parse(request.trim()) as { id: number; method: string }
      frames.push(parsed)
      if (parsed.method === "hello") {
        conn.write(
          `${JSON.stringify({ id: parsed.id, result: { version: "1.23.0", protocolVersion: "1", capabilities: advertised, permissions: { accessibility: "granted" } } })}\n`,
        )
        return
      }
      if (!advertised.includes(parsed.method)) {
        conn.write(
          `${JSON.stringify({ id: parsed.id, error: { code: "GP_E_UNKNOWN_METHOD", message: `the engine has no method ${parsed.method}`, remedy: "run gp_probe_status and read the advertised capabilities" } })}\n`,
        )
        return
      }
      // `act` answers with the flat operation dict (`EngineCore.swift:1275-1300`), which carries
      // no evidence pack — the shape `gp_act` renders and the ledger plugin refuses to record.
      conn.write(
        `${JSON.stringify({ id: parsed.id, result: { operationId: "op_AAAAAAAAAAAAAAAAAAAAAAAAAA", actConfirmed: true, axChanged: true, pixelChanged: false, latencyMs: 12 } })}\n`,
      )
    }
    return { frames, serve }
  }

  const actOf = async (defs: Awaited<ReturnType<typeof loadDefs>>) => {
    const act = defs.find((def) => def.id === "gp_act")
    if (!act) throw new Error("gp_act is not in the surface — a test that cannot find it proves nothing")
    return act
  }

  test("a gp_act this surface refuses locally spends neither the daemon's slot nor a human's answer", async () => {
    // The order of the guards is a claim about cost, written in `index.ts` as "the local refusal
    // costs no connection", and it was broken twice over: the selector guard sat *after*
    // `requireCapability`, so a call this file refuses on sight still paid for a `hello` off the
    // daemon's single connection slot, and the refusal it rendered dropped the declared dimension.
    const defs = await loadDefs()
    const act = await actOf(defs)

    for (const [label, params, code] of [
      ["a role that would pick a different permission rule", { selector: { role: "AX*Button" }, action: "press", dimension: "security" }, "GP_E_SELECTOR"],
      ["a malformed dimension", { selector: { role: "AXButton" }, action: "press", dimension: "Spec Compliance" }, "GP_E_DIMENSION"],
    ] as const) {
      const peer = enginePeer(["act"])
      const context = stubContext()
      const row = await withDaemonPeer(`cost-${code}`, peer.serve, () => Effect.runPromise(act.execute(params, context.ctx)))
      expect(row.metadata, label).toMatchObject({ ok: false, code })
      // The declared id survives the selector refusal and is absent (never invented) for the
      // dimension guard's own refusal, where nothing well-formed was ever declared.
      expect(row.metadata, label).toMatchObject({
        dimension: code === "GP_E_SELECTOR" ? "security" : null,
      })
      expect(peer.frames, `${label}: a local refusal opened the daemon's single connection slot`).toEqual([])
      expect(context.seen, `${label}: a local refusal reached the permission plane`).toEqual([])
    }

    // The control: the same fixture, one legal role, does reach the engine — so the two empty
    // readings above are about the refusal and not about a peer that never answers.
    const passing = enginePeer(["act"])
    const passContext = stubContext()
    const ok = await withDaemonPeer("cost-pass", passing.serve, () =>
      Effect.runPromise(act.execute({ selector: { role: "AXButton" }, action: "press", dimension: "security" }, passContext.ctx)),
    )
    expect(ok.metadata).toMatchObject({ ok: true, method: "act", dimension: "security" })
    expect(passing.frames.map((frame) => frame.method)).toEqual(["hello", "act"])
    expect(passContext.seen).toEqual([
      { kind: "metadata", value: { dimension: "security" } },
      { kind: "ask", value: ["act:AXButton:press"] },
    ])
  })

  test("the declaration is streamed onto the running part before the prompt is asked", async () => {
    // A rejected prompt fails the call, and the part the host then keeps carries ONLY what was
    // streamed while it ran (`session/processor.ts`'s `failToolCall`:
    // `metadata: match.part.state.metadata`). Without the `ctx.metadata` write, a session whose
    // user vetoed five `security` clicks reports "dimension declarations that reached no anchor:
    // 0" — the audit says nothing was declared. That is the shape
    // `glasspane-compaction.ts`'s `declaredWithoutAnchor` branch reads, so the write has to
    // happen before the ask: after it, nothing below runs.
    const defs = await loadDefs()
    const act = await actOf(defs)
    const context = stubContext({ reject: "Permission rejected by user" })
    const peer = enginePeer(["act"])
    const exit = await withDaemonPeer("prompt-reject", peer.serve, () =>
      Effect.runPromise(Effect.exit(act.execute({ selector: { role: "AXButton" }, action: "press", dimension: "security" }, context.ctx))),
    )
    expect(exit._tag).toBe("Failure")
    expect(context.seen).toEqual([
      { kind: "metadata", value: { dimension: "security" } },
      { kind: "ask", value: ["act:AXButton:press"] },
    ])

    // A call that declared nothing writes `null` rather than inventing an id, and still writes it
    // before asking — the order is the same whether or not there is a declaration to carry.
    const undeclared = stubContext({ reject: "Permission rejected by user" })
    await withDaemonPeer("prompt-reject-none", enginePeer(["act"]).serve, () =>
      Effect.runPromise(Effect.exit(act.execute({ selector: { role: "AXButton" }, action: "press" }, undeclared.ctx))),
    )
    expect(undeclared.seen).toEqual([
      { kind: "metadata", value: { dimension: null } },
      { kind: "ask", value: ["act:AXButton:press"] },
    ])

    // And every tool that accepts a declaration streams it, not just `gp_act`: the scan reads the
    // same blocks as the refusal scan above, in the same order-by-position way.
    const source = surfaceIndexSource()
    for (const [tool, method] of [
      ["gp_attach", "attach"],
      ["gp_observe", "observe"],
      ["gp_act", "act"],
      ["gp_diagnose", "diagnose"],
      ["gp_last_evidence", "last_evidence"],
    ] as const) {
      const at = source.indexOf(`refused("${tool}", "${method}"`)
      expect(at, `${tool} has no refusal this scan can anchor to`).toBeGreaterThan(-1)
      const stream = source.indexOf(`declareDimension(ctx, params.dimension ?? null)`, at)
      expect(stream, `${tool} must stream the declaration onto the running part`).toBeGreaterThan(-1)
      const prompt = source.indexOf("ctx.ask(", stream)
      expect(prompt, `${tool} has no prompt to order the stream against`).toBeGreaterThan(-1)
      expect(stream, `${tool} streams the declaration after the prompt`).toBeLessThan(prompt)
    }
  })

  test("a refusal this file renders keeps the result shape it was given", () => {
    // `present` used to write `result: reply.result as object`, the same shape-assertion defect
    // `daemon.ts` calls out for `permissions`: an `as` on `unknown` says the shape is known when
    // it is not. It also made `{id, result: null}` — a frame `rawRequest` deliberately passes
    // through by *presence*, not truthiness — look like an answer that held `{}`, which is
    // precisely the difference `readEvidenceFrame` refuses on ("no evidence pack" vs "an empty
    // one"), and what `test/tool/glasspane-surface.test.ts`'s own null-result transport case says
    // the transport must hand up unchanged.
    const nullReply: Daemon.DaemonReply = { ok: true, result: null }
    const nullRow = present("gp_last_evidence", "last_evidence", nullReply, () => "answered")
    expect((nullRow.metadata as Record<string, unknown>).result).toBeNull()
    expect(nullRow.title).toBe("gp_last_evidence: last_evidence answered")

    const objectRow = present("gp_observe", "observe", { ok: true, result: { nodeCount: 3 } }, () => "3")
    expect((objectRow.metadata as Record<string, unknown>).result).toEqual({ nodeCount: 3 })

    // A scalar answer is passed as the scalar it is, not boxed or defaulted.
    expect((present("gp_diagnose", "diagnose", { ok: true, result: 0 }, () => "0").metadata as Record<string, unknown>).result).toBe(0)

    // The shape assertion is gone from the source, in both spellings the file used for it.
    expect(surfaceIndexSource()).not.toMatch(/reply\.result\s+as\s+(object|Record)/)
  })
})

describe("what the permission plane is handed", () => {
  const surface = readFileSync(path.join(import.meta.dirname, "..", "..", "src", "tool", "glasspane", "index.ts"), "utf8")

  test("no read-only tool mints a rule over the whole glasspane namespace", () => {
    // The six gp_* tools share one permission namespace, so `always` is not "always this call":
    // it is the pattern list that gets stored as an allow rule for `glasspane`. A `*` there also
    // answers gp_act's `act:<role>:<action>`, and the user who clicked "Always allow" on a
    // self-report would never be asked before the harness drove a real app again.
    expect(surface).not.toContain(`always: ["*"]`)
    for (const method of ["probe_status", "attach", "observe", "diagnose", "last_evidence"]) {
      expect(surface, `${method} must scope always to its own pattern`).toContain(
        `patterns: ["${method}"], always: ["${method}"]`,
      )
    }
    // gp_act scopes `always` to its own pattern too. It used to be `always: []` with a comment
    // claiming that was the cautious choice, but the emptiness was the defect: the TUI builds the
    // "This will allow the following patterns…" list from this array and appends rules from it, so
    // an accepted Always answer stored no rule and re-asked the identical action forever.
    expect(surface).toContain("patterns: [`act:${params.selector.role}:${params.action}`],")
    expect(surface).toContain("always: [`act:${params.selector.role}:${params.action}`],")
    expect(surface).not.toContain("always: [],")
  })

  test("the model cannot pick which rule gp_act is evaluated against", () => {
    // The permission key is `act:<role>:<action>` and Wildcard.match reads the stored rule as the
    // glob, so a role holding `*` or `:` is not a typo — it chooses the rule the request matches.
    expect(validateSelector("AXButton").ok).toBe(true)
    for (const role of ["*", "AX*", "AXButton:press", "a?b", "x[y]", "a\\b"]) {
      const read = validateSelector(role)
      expect(read.ok, `${role} must be refused`).toBe(false)
      if (!read.ok) expect(read.error.code).toBe("GP_E_SELECTOR")
    }
    // refused before the human is asked, and before the engine is called
    const guard = surface.indexOf("validateSelector(params.selector.role)")
    const key = surface.indexOf("patterns: [`act:")
    const call = surface.indexOf('Daemon.call("act"')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(key)
    expect(guard).toBeLessThan(call)
  })
})

/** The inside of a string literal, or `undefined` when the text is not one. */
function literalText(argument: string | undefined): string | undefined {
  const text = (argument ?? "").trim()
  const quote = text[0]
  if (quote !== '"' && quote !== "`" && quote !== "'") return undefined
  if (text.length < 2 || text[text.length - 1] !== quote) return undefined
  return text.slice(1, -1)
}

/**
 * The shipped surface, as one named read. Several tests below are about the source text itself
 * (a call site's order, a refusal's arguments); they must all read the SAME file, and a test that
 * re-derives the path is a test that can silently read nothing.
 */
function surfaceIndexSource(): string {
  return readFileSync(path.join(import.meta.dirname, "..", "..", "src", "tool", "glasspane", "index.ts"), "utf8")
}

/**
 * The six defs as the registry would receive them.
 *
 * `Tool.define` needs the truncate and agent services to construct an info at all; neither is
 * exercised by what these tests read off a def, so both are faked the same way
 * `test/tool/code-mode.test.ts` fakes them (upstream's own precedent). Module-level because two
 * describes need it: the id/description contract, and the guard-order tests that drive a real
 * `execute`.
 */
function loadDefs() {
  return Effect.runPromise(
    glasspaneDefs.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Truncate.Service, {
            output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
          }),
          Layer.mock(Agent.Service, {
            get: () => Effect.succeed({ name: "build", permission: [] } as never),
          }),
        ),
      ),
    ),
  )
}

/**
 * A `Tool.Context` that records what the surface handed the host, in the order it handed it.
 *
 * `ask` is the human's prompt and `metadata` is the running part's stream: the two side effects a
 * `gp_*` call has outside its own return value, and the ones whose ORDER decides whether a
 * rejected prompt leaves anything readable behind.
 */
function stubContext(options: { reject?: string } = {}) {
  const seen: { kind: "ask" | "metadata"; value: unknown }[] = []
  const ctx = {
    sessionID: "ses_surface",
    messageID: "msg_surface",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: (input: { metadata?: unknown }) =>
      Effect.sync(() => {
        seen.push({ kind: "metadata", value: input.metadata })
      }),
    ask: (request: { patterns?: string[] }) =>
      Effect.flatMap(
        Effect.sync(() => {
          seen.push({ kind: "ask", value: request.patterns })
        }),
        () => (options.reject ? Effect.fail(new Error(options.reject)) : Effect.void),
      ),
  }
  return { ctx: ctx as unknown as ToolContext, seen }
}

/**
 * The top-level argument list of every `callee(...)` in a source, brace- and paren-matched,
 * with quote awareness. A regex over `callee\([^)]*\)` cannot see past the first nested `)` —
 * which is how the timeout scan below missed every `Daemon.call("act", engineBody(params))`
 * in the shipped surface, and how a refusal scan would read a call site it never parsed.
 */
function callSites(source: string, callee: string): { at: number; args: string[] }[] {
  const found: { at: number; args: string[] }[] = []
  for (const match of source.matchAll(new RegExp(`\\b${callee}\\(`, "g"))) {
    const start = (match.index ?? 0) + match[0].length
    const args: string[] = []
    let current = ""
    let depth = 1
    let quote: string | null = null
    for (let i = start; i < source.length; i++) {
      const ch = source[i]
      if (quote !== null) {
        current += ch
        if (ch === "\\") current += source[++i] ?? ""
        else if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "`" || ch === "'") {
        quote = ch
        current += ch
        continue
      }
      if (ch === "{" || ch === "(" || ch === "[") depth++
      else if (ch === "}" || ch === ")" || ch === "]") {
        depth--
        if (depth === 0) {
          args.push(current)
          break
        }
      }
      if (ch === "," && depth === 1) {
        args.push(current)
        current = ""
        continue
      }
      current += ch
    }
    found.push({ at: match.index ?? 0, args: args.map((arg) => arg.trim()) })
  }
  return found
}

/** The same sites, without the positions — what a scan over one callee usually wants. */
function callArguments(source: string, callee: string): string[][] {
  return callSites(source, callee).map((site) => site.args)
}

/**
 * Every `refused(...)` call site in `index.ts` that sits inside a tool accepting a declared
 * dimension — i.e. every refusal this surface renders where there IS a declaration to carry.
 */
function refusalSites(source: string) {
  return callSites(source, "refused")
    .filter((site) => blockOf(source, site.at).includes("params.dimension"))
    .map((site) => ({
      target: literalText(site.args[0]) ?? "<unparsed target>",
      error: site.args[2] ?? "",
      given: site.args[3] ?? "",
      args: site.args,
    }))
}

/**
 * The sites that break the rule `index.ts` states beside `requireCapability`: a refusal renders
 * the call's declared dimension, and the one exception is the dimension validator's own refusal,
 * where the id that arrived was malformed and echoing it would put an unplanned dimension on the
 * record.
 */
function refusalOffenders(source: string) {
  return refusalSites(source).filter((site) =>
    site.error === "declared.error" ? site.given !== "null" : site.given !== "params.dimension ?? null",
  )
}

/**
 * The source of one `export const …` block, up to the next top-level `export const`.
 * Used to ask "in which tool's body does this call site live", because the rule a call site
 * obeys is a rule about the tool it belongs to.
 */
function blockOf(source: string, at: number): string {
  const heads = [...source.matchAll(/^export (?:const|function) /gm)].map((m) => m.index)
  const owner = heads.filter((index) => index <= at).pop()
  if (owner === undefined) return ""
  const next = heads.find((index) => index > owner)
  return source.slice(owner, next ?? source.length)
}

function structBody(source: string, name: string): string {
  // Brace-matched, not "up to the first `})`": a one-line `Schema.Struct({})` would
  // otherwise be read through the next struct, and the assertion would be measuring
  // this helper instead of the source.
  const head = `export const ${name} = Schema.Struct({`
  const start = source.indexOf(head)
  expect(start, `${name} is not declared where this test expects`).toBeGreaterThan(-1)
  let depth = 1
  for (let i = start + head.length; i < source.length; i++) {
    const ch = source[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`${name}: unbalanced Schema.Struct`)
}

describe("what a numeric argument does", () => {
  // `Schema.NumberFromString` alone rejects a JSON number, so the two parameters typed that
  // way refused the natural call: measured 2026-10-14, `gp_observe({maxDepth: 6})` and
  // `gp_attach({pid: 1234})` — the documented way to say which of several running instances
  // to look at — both died as InvalidArgumentsError before anything reached the engine.
  // Strings must keep working too: every existing caller, and the fixed points below, send
  // them. The bound is what the first fix added, so out-of-range stays refused in both shapes.
  const decode = (schema: any, value: unknown) => () => Schema.decodeUnknownSync(schema)(value)

  test("a numeric maxDepth decodes to a number", () => {
    expect(Schema.decodeUnknownSync(ObserveParams)({ maxDepth: 6 })).toEqual({ maxDepth: 6 })
  })

  test("and a string maxDepth still decodes", () => {
    expect(Schema.decodeUnknownSync(ObserveParams)({ maxDepth: "6" })).toEqual({ maxDepth: 6 })
  })

  test("while the bound still refuses, whichever shape it arrives in", () => {
    expect(decode(ObserveParams, { maxDepth: 100000 })).toThrow()
    expect(decode(ObserveParams, { maxDepth: "100000" })).toThrow()
    expect(decode(ObserveParams, { maxDepth: 0 })).toThrow()
  })

  test("a numeric pid is accepted — the disambiguation path has to be callable", () => {
    expect(Schema.decodeUnknownSync(AttachParams)({ pid: 1234 })).toEqual({ pid: 1234 })
    expect(Schema.decodeUnknownSync(AttachParams)({ pid: "1234" })).toEqual({ pid: 1234 })
  })
})

describe("what a remedy is allowed to say", () => {
  /**
   * Every remedy string the surface emits, pulled out of the source as a literal — not
   * scraped from comments, because a scan that flags prose gets "fixed" by deleting the
   * prose. An agent that is told to "report the line to the maintainers" has been handed a
   * dead end: nobody is reading, and the turn ends with a claim it cannot act on.
   *
   * Three shapes, because the surface writes remedies in three shapes:
   *  - `remedy: <literal>` in an error object (kernel.ts, providers.ts, the ledger plugin's
   *    `ledgerFault` note, the inline daemon frame guard),
   *  - the third positional argument of `failure(code, message, remedy)` (daemon.ts builds
   *    every transport remedy that way),
   *  - a staged `const …remedy… = <literal>` where a file assembles its own refusal before
   *    returning it (glasspane-compaction.ts's `const remedy`, index.ts's
   *    `const CAPABILITY_REMEDY` — neither has a `remedy:` key at all).
   * A scanner that read only the first shape measured 1 remedy in daemon.ts where 10 are
   * built, and 0 in the compaction plugin — and the aggregate guard below could not see
   * either file going dark, which is why each file's own count is asserted by name.
   */
  const remediesIn = (file: string) => {
    const source = readFileSync(path.join(import.meta.dir, "../..", file), "utf8")
    const keyed = [...source.matchAll(/remedy:\s*(?:"([^"]*)"|`([^`]*)`)/g)].map((m) => m[1] ?? m[2] ?? "")
    // `\w*remedy\w*`, not `remedy`: the tool surface stages its one remedy as
    // `const CAPABILITY_REMEDY = ...`, and a scan keyed to the lowercase name read 0 remedies
    // in index.ts — the file that writes the remedy a model sees when the engine has not
    // advertised a method. Any wording that file chose was unscanned.
    const staged = [...source.matchAll(/\bconst\s+\w*remedy\w*\s*=\s*(?:"([^"]*)"|`([^`]*)`)/gi)].map((m) => m[1] ?? m[2] ?? "")
    const positional = callArguments(source, "failure")
      .map((args) => literalText(args[2]))
      .filter((text): text is string => text !== undefined)
    return { keyed, staged, positional }
  }
  const remedyLiterals = (file: string) => Object.values(remediesIn(file)).flat()
  const files = [
    "src/tool/glasspane/daemon.ts",
    "src/tool/glasspane/kernel.ts",
    "src/tool/glasspane/index.ts",
    "src/tool/glasspane/providers.ts",
    "src/plugin/glasspane-compaction.ts",
    // The ledger plugin writes its own remedy at `ledgerFault` — a hand-written one, in the
    // same shape as every other file above. Left out of this list, the aggregate scan could
    // not see the file going dark, which is exactly what the note above says this list exists
    // to prevent: a plugin remedy that stopped being scanned is a remedy nobody re-measures.
    "src/plugin/glasspane-decision-log.ts",
  ]

  test("the scan finds the remedies it claims to scan, file by file", () => {
    // The aggregate guard this replaced (`found.length > 3` over all three files) was
    // satisfied by one file while the other two contributed nothing, so a file could stop
    // being scanned without anything going red — and the shapes each file builds its
    // remedies in are stated here as facts about those files, not measured off the scan,
    // so the scan cannot grade its own work.
    const shapes: Record<string, keyof ReturnType<typeof remediesIn>> = {
      // The transport hands every remedy to `failure(code, message, remedy)`.
      "src/tool/glasspane/daemon.ts": "positional",
      // The kernel module writes its refusals as `remedy:` error-object fields.
      "src/tool/glasspane/kernel.ts": "keyed",
      // The tool surface stages its one remedy as a named const, and gates every `gp_*` call
      // with it.
      "src/tool/glasspane/index.ts": "staged",
      // The provider doorway writes its one refusal as a `remedy:` field.
      "src/tool/glasspane/providers.ts": "keyed",
      // The compaction stage assembles its note before returning it, as `const remedy`.
      "src/plugin/glasspane-compaction.ts": "staged",
      // The ledger plugin hands its fault remedy to the `failed` note as a `remedy:` field.
      "src/plugin/glasspane-decision-log.ts": "keyed",
    }
    for (const file of files) {
      const found = remediesIn(file)
      const shape = shapes[file]!
      expect(
        found[shape].length,
        `${file} builds its remedies as ${shape === "positional" ? "the third argument of failure(...)" : shape === "staged" ? "`const remedy = ...`" : "`remedy:` object fields"}, and the scan finds ${found[shape].length} of them`,
      ).toBeGreaterThan(0)
      expect(remedyLiterals(file).length, `${file} contributes no remedies to the scan`).toBeGreaterThan(0)
      for (const remedy of remedyLiterals(file)) expect(remedy.length, `${file} yielded an empty remedy`).toBeGreaterThan(0)
    }
  })

  test("no remedy sends the agent to a human", () => {
    for (const file of files) {
      for (const remedy of remedyLiterals(file)) {
        expect(`${file}: ${remedy}`).not.toInclude("maintainers")
        expect(`${file}: ${remedy}`).not.toInclude("report the line")
        expect(`${file}: ${remedy}`).not.toInclude("client/server pair")
        expect(remedy.length).toBeGreaterThan(0)
      }
    }
  })

  /** A human's hands. An agent reading this has no way to finish the sentence. */
  const GUI_ACTION = /\bpress(?:ing)?\s+(?:the|a|it)?\s*[\w-]*\s*button\b|\bclick\s+(?:the|on)\b|\bopen\s+the\s+[\w\s-]{0,30}panel\b|\bask\s+(?:a|the)\s+(?:human|user|operator)\b|\btell\s+the\s+user\s+to\b|\bmanually\b/i
  /** A `<…>` used as a path segment: a hole the reader is expected to fill from nowhere. */
  const PLACEHOLDER_PATH = /<[a-z][a-z ]*>[/\\]/i
  /** Told to bring the service back, given no command that does it. */
  const SERVICE_WITHOUT_COMMAND = /\b(?:start|restart|update)\b[^\n]{0,60}background\s+service/i

  test("and no remedy names a GUI action, a placeholder path, or a service start with no command", () => {
    // The rule every remedy has to satisfy is that the reader can RUN it. Three shapes break
    // it, and all three were live in this surface at the same time:
    //  - daemon.ts told the unreachable-engine reader to "open the GlassPane panel and press
    //    the restart button" — a GUI action, for a reader with no GUI and no hands;
    //  - the same remedy said `node <glasspane repo>/installer/cli.js`, a path with a hole in
    //    it that nobody running a tool call can fill;
    //  - index.ts's capability remedy said "start or update the GlassPane background service"
    //    and stopped, in a file the scanner did not even read (its remedy is a named const,
    //    not a `remedy:` field — see `remediesIn`).
    // What replaces them is the launchd job this product already names in its own timeouts:
    // `launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon`.
    for (const file of files) {
      for (const remedy of remedyLiterals(file)) {
        const label = `${file}: ${remedy}`
        expect(label, `a remedy names a GUI action an agent cannot perform: ${remedy.slice(0, 120)}`).not.toMatch(GUI_ACTION)
        expect(label, `a remedy carries an unresolved placeholder path: ${remedy.slice(0, 120)}`).not.toMatch(PLACEHOLDER_PATH)
        if (SERVICE_WITHOUT_COMMAND.test(remedy))
          expect(label, `a remedy orders the reader to bring the background service back without naming the command: ${remedy.slice(0, 120)}`).toMatch(/\blaunchctl\b/)
      }
    }
  })

  test("the unreachable-daemon remedy is the restart command, measured over a real dead socket", async () => {
    // Driven, not scraped: this is the frame the agent actually receives when nothing is
    // listening, and the assertion is about the text it can copy into a shell.
    const previous = process.env.GLASSPANE_SOCKET
    process.env.GLASSPANE_SOCKET = path.join(tmpdir(), "gp-m1-restart-remedy-no-such-daemon.sock")
    try {
      const reply = await Effect.runPromise(Daemon.call("attach", {}, 5_000))
      expect(reply.ok).toBe(false)
      if (reply.ok) return
      expect(reply.error.code).toBe("GP_E_ENGINE_UNREACHABLE")
      expect(reply.error.remedy).toContain("launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon")
      expect(reply.error.remedy).not.toMatch(GUI_ACTION)
      expect(reply.error.remedy).not.toMatch(PLACEHOLDER_PATH)
    } finally {
      if (previous === undefined) delete process.env.GLASSPANE_SOCKET
      else process.env.GLASSPANE_SOCKET = previous
    }
  })

  test("and the capability gate's own remedy carries the same command, measured at the gate", async () => {
    // index.ts writes this one string itself, and it is the only remedy the gate can give for
    // "the engine does not advertise this method" — so it is asserted off the rendered row
    // rather than off the source.
    const blocked = await withGate("capability-remedy", (conn) =>
      conn.write(`${JSON.stringify({ id: 1, result: { version: "0.9.1", protocolVersion: "1", capabilities: ["observe"], permissions: {} } })}\n`),
    )
    expect(blocked?.metadata).toMatchObject({ ok: false, code: "GP_E_CAPABILITY_UNAVAILABLE" })
    expect(blocked?.output).toContain("launchctl kickstart -k gui/$(id -u)/com.glasspane.daemon")
    expect(blocked?.output).not.toMatch(GUI_ACTION)
    expect(blocked?.output).not.toMatch(PLACEHOLDER_PATH)
  })

  test("and the malformed-frame remedy names a call to make, not a person to find", async () => {
    // Driven over a real unix socket rather than scraped: the assertion is about the frame
    // the agent actually receives. A source scan for "maintainers" would be satisfied by
    // deleting the phrase from a comment and keeping it in the string.
    await withDaemonPeer("malformed-json", (conn) => conn.write("this is not json\n"), async () => {
      const reply = await Effect.runPromise(Daemon.call("observe", {}, 5_000))
      expect(reply.ok).toBe(false)
      if (reply.ok) return
      expect(reply.error.code).toBe("GP_E_INTERNAL")
      expect(reply.error.remedy).toContain("gp_probe_status")
      expect(reply.error.remedy).toContain("tail -n 20 ~/.glasspane/installer-daemon.log")
      expect(reply.error.remedy).not.toInclude("maintainers")
      expect(reply.error.remedy).not.toInclude("report the line")
    })
  })
})

/**
 * The engine's method table, read from the contract the published repository carries.
 *
 * It is NOT read out of `engine/Sources/.../FrameCodec.swift` here, even though that file is what
 * decides "is this method callable": the engine lives in the parent repository and never enters the
 * subtree split, so a test that walked up looking for it passed on a maintainer machine and died in
 * the split repo's CI on the missing file (measured 2026-10-15, both method-table assertions). The
 * list travels as `contracts/engine-methods.json`; the rule that keeps it honest — re-parsing the
 * Swift enum and refusing any drift — is `product-surface.mjs` rule `engine-methods`, which only
 * runs where the Swift source actually is. Copying the list into this file would be the stale-copy
 * failure the surface itself refuses (`requireCapability` asks `hello`, it does not carry a table).
 */
function engineMethodNames(): string[] {
  const contract = path.join(import.meta.dir, "..", "..", "..", "..", "contracts", "engine-methods.json")
  if (!existsSync(contract)) {
    throw new Error(`${contract} is missing — the engine's method table cannot be checked without it, and a test that skips that check is a green light for a wrong timeout table`)
  }
  const parsed = JSON.parse(readFileSync(contract, "utf8")) as { methods?: unknown }
  if (!Array.isArray(parsed.methods) || parsed.methods.length === 0) {
    throw new Error(`${contract} carries no method list — refusing to treat "empty contract" as "everything is allowed"`)
  }
  return parsed.methods.filter((m): m is string => typeof m === "string")
}

describe("the timeout table and the call sites that read it", () => {
  /**
   * Both directions are pinned from the shipped source (the offline scripts and these
   * tests may pass their own budgets; `src/tool/glasspane/` may not), and the expected
   * values are read off the call sites and off the engine — never off the table, which
   * would be the table grading its own work.
   */
  const files = ["src/tool/glasspane/daemon.ts", "src/tool/glasspane/index.ts"]
  const surfaceSource = files.map((file) => readFileSync(path.join(import.meta.dir, "../..", file), "utf8"))
  const methodsSent = () => [...new Set(surfaceSource.flatMap((s) => [...s.matchAll(/\bcall\("([a-z_]+)"/g)].map((m) => m[1]!)))]

  test("every method this surface sends is one the engine accepts", () => {
    const callable = engineMethodNames()
    for (const method of methodsSent()) {
      expect(callable, `this surface sends "${method}", which is not in the engine's method table`).toContain(method)
    }
  })

  test("no table entry is spent by a call nobody makes", () => {
    // The `shutdown: 5_000` case: an entry with no reader anywhere in the tree.
    for (const key of Object.keys(Daemon.TIMEOUT_MS)) {
      if (key === "default") continue
      expect(methodsSent(), `TIMEOUT_MS.${key} has no call site — an entry with no reader is a budget nobody re-measures`).toContain(key)
    }
  })

  /**
   * Every `call(...)` in a source whose third top-level argument is a numeric literal, i.e. a
   * budget written at the call site instead of taken from `TIMEOUT_MS`.
   *
   * The scan is the parser above, not a regex, and that is the fix: the pattern used to be
   * `/\bcall\("[a-z_]+",\s*[^)]*?,\s*[\d_]+\s*\)/`, and `[^)]*?` cannot cross the `)` of
   * `engineBody(params)` — so the four sites that actually talk to the engine were outside its
   * range, and its "0 found" meant "nothing was read" rather than "nothing is wrong".
   */
  function hardCodedTimeouts(source: string) {
    return callSites(source, "call")
      .map((site) => ({ at: site.at, method: literalText(site.args[0]), args: site.args }))
      .filter((site) => site.method !== undefined && site.args.length >= 3 && /^[\d_]+$/.test(site.args[2] ?? ""))
  }

  test("no call site in the surface brings its own number", () => {
    // `hello()` hard-coding 5_000 and `gp_probe_status` hard-coding 8000 were the other
    // half of the defect: the table was not where the product's timings lived.
    for (const [file, source] of files.map((file, i) => [file, surfaceSource[i]!] as const)) {
      const offenders = hardCodedTimeouts(source)
      expect(offenders.length, `${file} passes a hard-coded timeout instead of the table: ${JSON.stringify(offenders.map((o) => o.args))}`).toBe(0)
    }
  })

  test("and that scan reaches the call sites the surface actually has", () => {
    // THE CONTROL FOR THE SCAN ITSELF, kept because the scan is what was broken. A reader of the
    // test above cannot tell "no offenders" from "no sites read", so the coverage is stated off the
    // shipped source, and the shape the old pattern missed is shown caught here.
    const seen = callSites(surfaceIndexSource(), "call")
      .map((site) => literalText(site.args[0]))
      .filter((method): method is string => method !== undefined)
      .sort()
    expect(seen).toEqual(["act", "attach", "diagnose", "last_evidence", "observe", "probe_status"])

    // A literal budget written behind a nested call is caught — and the pattern this replaced
    // (`/\bcall\("[a-z_]+",\s*[^)]*?,\s*[\d_]+\s*\)/`) finds nothing in the same text, because
    // `[^)]*?` cannot cross the `)` of `engineBody(params)`. The four sites that actually talk to
    // the engine are written that way, so "0 found" used to mean "nothing was read".
    const wrapped = `Daemon.call("act", engineBody(params), 60_000)`
    expect(hardCodedTimeouts(wrapped).map((site) => [site.method, site.args[2]])).toEqual([["act", "60_000"]])
    expect(/call\("[a-z_]+",\s*[^)]*?,\s*[\d_]+\s*\)/.exec(wrapped)).toBeNull()
    // The same site without the number is clean, so the control measures the number, not the nesting.
    expect(hardCodedTimeouts(`Daemon.call("act", engineBody(params))`)).toEqual([])
    // A non-literal third argument — the table lookup in `call`'s own signature — is not a site budget.
    expect(hardCodedTimeouts(`function call(method: string, params: object = {}, timeoutMs: number = timeoutFor(method)) {}`)).toEqual([])
  })

  test("a method this surface does not send falls through to the default, by measurement", () => {
    // `restore` really is an engine method and really does replay UI steps, and the MCP
    // shell does drive it — under its own deadline table (`mcp-shell/src/engine-client.ts`).
    // Nothing here calls it, so nothing here may carry a number or a promise for it;
    // saying otherwise was the claim this fix removed.
    expect(engineMethodNames()).toContain("restore")
    expect(methodsSent()).not.toContain("restore")
    expect(Daemon.timeoutFor("restore")).toBe(Daemon.TIMEOUT_MS.default)
  })

  test("an inherited key is not a budget", () => {
    // The bracket read walked the prototype, so `constructor` / `toString` / `valueOf` returned
    // FUNCTIONS from a table of numbers, and `?? default` cannot catch that — a function is not
    // nullish. `setTimeout(fn, fn)` coerces the delay to NaN and fires within a millisecond, so
    // a method named after an Object key would report GP_E_ENGINE_TIMEOUT against a daemon that
    // was answering. The declared `number` return was the part nobody could see at runtime.
    for (const key of ["constructor", "toString", "valueOf", "__proto__"]) {
      const budget = Daemon.timeoutFor(key)
      expect(typeof budget, `timeoutFor("${key}") returned ${typeof budget}, not a number`).toBe("number")
      expect(budget).toBe(Daemon.TIMEOUT_MS.default)
      expect(Number.isInteger(budget)).toBe(true)
    }
  })
})
