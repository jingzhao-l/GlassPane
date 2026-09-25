import { describe, expect, test } from "bun:test"
import { readFileSync, unlinkSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Agent } from "@/agent/agent"
import * as Truncate from "@/tool/truncate"
import { Effect, Layer } from "effect"

import { glasspaneDefs, present, unavailable } from "../../src/tool/glasspane/index"
import * as Daemon from "../../src/tool/glasspane/daemon"

/**
 * M1 fixed points — the contract the tool surface has with the host and the model.
 *
 * Three invariants, each of which has already failed somewhere in this project's
 * history, so each gets its own assertion instead of prose:
 *  - ids arrive raw and unique (E2: upstream does not namespace them — and a
 *    duplicated id would silently shadow one of the six);
 *  - a failure's message *and* remedy live in `output`, because the model only
 *    reads `output` (E6 measured this: a metadata-only remedy is invisible);
 *  - the daemon's error frame is exactly `{code, message, remedy}` with a
 *    non-empty remedy — the shape every shell renders.
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

  test("a method the running engine never announced is refused with an executable remedy", () => {
    const result = unavailable("audit_ui", "the engine does not advertise audit_ui")
    expect(result.output).toContain("gp_probe_status") // the remedy names a real next step
    expect(result.metadata).toMatchObject({ ok: false, code: "GP_E_CAPABILITY_UNAVAILABLE", result: null })
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
      const reply = await Effect.runPromise(Daemon.call("observe", {}, 5_000))
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

