import { describe, expect, test } from "bun:test"
import { readFileSync, unlinkSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Agent } from "@/agent/agent"
import * as Truncate from "@/tool/truncate"
import { Effect, Layer } from "effect"

import { glasspaneDefs, present, refused, requireCapability } from "../../src/tool/glasspane/index"
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
  // `Tool.define` needs these two services to construct an info at all; neither
  // is exercised by an id/description assertion, so both are faked the same way
  // `test/tool/code-mode.test.ts` fakes them (upstream's own precedent).
  const loadDefs = () =>
    Effect.runPromise(
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

  test("every def is a unique raw gp_* id with a description and a parser", async () => {
    const defs = await loadDefs()
    expect(defs.length).toBeGreaterThan(0)
    const ids = defs.map((def) => def.id)
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
 * A real unix-socket peer, because the rules below live in the client's byte loop
 * and in the call sites that read its replies: a fabricated `DaemonReply` would only
 * re-state the test's own fixture. `run` is whatever talks to the peer — a raw
 * `Daemon.call` for the transport cases, the capability gate for the refusal cases.
 */
async function withDaemonPeer<T>(
  name: string,
  serve: (conn: net.Socket, request: string) => void,
  run: () => Promise<T>,
): Promise<T> {
  const socket = path.join(tmpdir(), `gp-m1-frame-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`)
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
  withDaemonPeer(name, serve, () => Effect.runPromise(requireCapability("gp_act", "act", "act")))

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

  test("an explicit null result is still an answer", async () => {
    // Presence is the question, not truthiness: "no evidence pack for this id" is a
    // real result the engine sends, and refusing it would invent a failure.
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
      const blocked = await Effect.runPromise(requireCapability("gp_act", "act", "act"))
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
})

describe("bounds the surface puts on itself", () => {
  test("an over-sized engine frame is refused in-band with a remedy — never a raised defect", async () => {
    // A real unix-socket peer is used on purpose: the cap is enforced in the
    // client's byte loop, so a fake `DaemonReply` would test nothing. The peer
    // answers with a single 5 MiB line (over MAX_FRAME_BYTES) and never a newline,
    // which is exactly what a runaway tree or a mis-chewed pack looks like.
    const socket = path.join(tmpdir(), `gp-m1-oversize-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`)
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

