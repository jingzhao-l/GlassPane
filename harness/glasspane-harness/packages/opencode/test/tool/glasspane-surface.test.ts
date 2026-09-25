import { describe, expect, test } from "bun:test"
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
