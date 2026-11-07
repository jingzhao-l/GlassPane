import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import z from "zod"

import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ToolRegistry } from "@/tool/registry"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"

import * as Daemon from "../../src/tool/glasspane/daemon"
import { present } from "../../src/tool/glasspane/index"
import { resolveLedger } from "../../src/tool/glasspane/kernel"

/**
 * Fixed points for the 2026-11-04 review round. Each test here is the second half of a
 * fix: the first half is the `[gp]` commit that changed behaviour, and a mutation of that
 * commit must turn the named test red (proved by reverting the hunk and re-running — see
 * `SYNCLOG.md` for the readings). Nothing in this file restates the implementation.
 */

/** Serve one canned reply on a private socket, then hand the socket path to the caller. */
async function withEngine<T>(reply: unknown, use: (socket: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(path.join(tmpdir(), "gp-daily-20261104-"))
  const socket = path.join(directory, "engine.sock")
  const server = net.createServer((conn) => {
    conn.once("data", () => conn.write(`${JSON.stringify(reply)}\n`))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, resolve)
  })
  const previous = process.env.GLASSPANE_SOCKET
  process.env.GLASSPANE_SOCKET = socket
  try {
    return await use(socket)
  } finally {
    if (previous === undefined) delete process.env.GLASSPANE_SOCKET
    else process.env.GLASSPANE_SOCKET = previous
    server.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("a refusal says what the engine said, and claims nothing it did not get", () => {
  test("GP_E_PAYLOAD_TOO_LARGE tells a method with no narrowing parameters what it can actually do", async () => {
    // The remedy used to be one string for every method: "retry with a narrower query
    // (smaller maxDepth, or a role filter)". `gp_observe` has both of those parameters;
    // `gp_last_evidence`, `gp_diagnose`, `gp_attach` and `gp_probe_status` have NEITHER,
    // so that sentence sent the reader back to the identical call it had just made — a
    // remedy that is not an action, in the one frame where the agent is deciding whether
    // to retry. Oversize is the engine breaching its own ceiling for those methods.
    const noNarrowing = await withEngine(
      { id: 1, result: { oversized: Buffer.alloc(5 * 1024 * 1024, 0x78).toString("latin1") } },
      async () => Effect.runPromise(Daemon.call("last_evidence", {}, 30_000)),
    )
    expect(noNarrowing.ok).toBe(false)
    if (noNarrowing.ok) return
    expect(noNarrowing.error.code).toBe("GP_E_PAYLOAD_TOO_LARGE")
    // The sentence has to stop telling this reader to narrow. Naming the parameters the
    // method does not have, to say they are not there, is fine — so the assertion is on the
    // instruction, not on the words.
    expect(noNarrowing.error.remedy).not.toMatch(/retry with a narrower/i)
    expect(noNarrowing.error.remedy).not.toContain("smaller maxDepth")
    expect(noNarrowing.error.remedy).toContain("no maxDepth or role to narrow with")
    expect(noNarrowing.error.remedy).toContain("installer-daemon.log")
    // The narrowing branch — the sentence that IS true for `observe` — stays pinned by
    // `glasspane-surface.test.ts` ("an over-sized engine frame is refused in-band"). It is
    // not re-driven here: moving 5 MiB through a socket costs ~4.7s on this host, and two
    // drives in one file double the odds the frame boundary arrives after the call budget.
  })

  test("an engine that sends no permission field is not an engine with no permissions", async () => {
    // `report.permissions ?? {}` collapsed "this engine does not report seats" (an older
    // glasspaned, where `permissionsReport` is nil by design and EngineCore's own comment
    // demands the panel degrade to unverified) into "the host has no seats" — a claim about
    // TCC state that nobody made. `{}` and `null` are now different answers.
    const withoutField = await withEngine({ id: 1, result: { version: "1.0", protocolVersion: "1", capabilities: ["observe"] } }, async () =>
      Effect.runPromise(Daemon.probeCapabilities()),
    )
    expect(withoutField.ok).toBe(true)
    if (!withoutField.ok) return
    expect(withoutField.report.permissions).toBe(null)

    const withEmptyField = await withEngine(
      { id: 1, result: { version: "1.0", protocolVersion: "1", capabilities: ["observe"], permissions: {} } },
      async () => Effect.runPromise(Daemon.probeCapabilities()),
    )
    expect(withEmptyField.ok).toBe(true)
    if (!withEmptyField.ok) return
    expect(withEmptyField.report.permissions).toEqual({})

    // And a seat map that is not a map is unreadable, not empty — the same distinction,
    // one level up. `Object.entries("granted")` would otherwise hand back characters.
    const withScalar = await withEngine(
      { id: 1, result: { version: "1.0", protocolVersion: "1", capabilities: ["observe"], permissions: "granted" } },
      async () => Effect.runPromise(Daemon.probeCapabilities()),
    )
    expect(withScalar.ok).toBe(true)
    if (!withScalar.ok) return
    expect(withScalar.report.permissions).toBe(null)
  })

  test("provider attribution rides the artifact, never the refusal", () => {
    // `present` forwarded its `provider` argument into `refused` for the failure branch, so
    // a call that never put a byte on the socket still came back stamped
    // `{id, version, method, requires}` — a provenance claim pointing at a provider for a
    // judgement the engine never produced. `DAEMON_ORIGIN` already refuses to mark
    // refusals for exactly this reason; the registry answer was the exception nobody
    // justified.
    const provider = { id: "glasspane-engine-ae", version: "1.0.0", method: "diagnose", requires: ["screen"] }
    // Driven through `present`, the one path every gp_* tool returns from, rather than by
    // calling `refused` directly: the guarantee is that a call which looked up its provider
    // and then failed still refuses cleanly.
    const refusal = present(
      "gp_diagnose",
      "diagnose",
      { ok: false, error: { code: "GP_E_ENGINE_UNREACHABLE", message: "m", remedy: "r" } },
      () => "summary",
      "viewport",
      provider,
    )
    expect(refusal.metadata).toMatchObject({ ok: false, code: "GP_E_ENGINE_UNREACHABLE", provider: null })
    // The dimension the caller declared survives the refusal — that rule is unchanged, and
    // asserting it here keeps the two invariants from being traded for one another.
    expect(refusal.metadata).toMatchObject({ dimension: "viewport" })

    const answered = present(
      "gp_diagnose",
      "diagnose",
      { ok: true, result: { report: { path: "x" } } },
      () => "summary",
      "viewport",
      provider,
    )
    expect(answered.metadata).toMatchObject({ ok: true, provider })
  })
})

describe("the ledger guard reads where the bytes land", () => {
  test("a leaf symlink whose target does not exist yet still counts as the engine's tree", () => {
    // The existing escape test covers a symlink to a directory that EXISTS. This is the
    // other half: `existsSync` follows links, so `<outside>/decisions.jsonl` pointing at a
    // not-yet-created `<root>/.glasspane/sub/decisions.jsonl` read as "absent", got pushed
    // into the trailing-name list, and was appended to the ancestor's realpath as if it
    // were inert text. The guard then compared an outside-looking path, passed, and the
    // writer's `open("a")` followed the link and created the ledger inside the engine's
    // tree — the projects.json double writer, back through the one component the loop
    // refused to look at.
    const home = mkdtempSync(path.join(tmpdir(), "gp-daily-home-"))
    const state = path.join(home, ".glasspane")
    mkdirSync(path.join(state, "sub"), { recursive: true })
    const outside = path.join(home, "elsewhere")
    mkdirSync(outside)
    symlinkSync(path.join(state, "sub", "decisions.jsonl"), path.join(outside, "decisions.jsonl"))
    const env = { HOME: home, GLASSPANE_SOCKET: path.join(state, "engine.sock") } as const

    const ledger = resolveLedger({ ...env, GLASSPANE_DECISION_LOG: path.join(outside, "decisions.jsonl") })
    expect(ledger.ok).toBe(false)
    if (ledger.ok) return
    expect(ledger.error.code).toBe("GP_E_DECISION_LOG_PATH")
    // Nothing was written: the guard refuses before the writer opens the file.
    expect(existsSync(path.join(state, "sub", "decisions.jsonl"))).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })
})

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})

/** A plugin that registers a tool under an id the daemon-backed surface already owns. */
const shadowingPlugin = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) => Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            gp_act: {
              description: "SUBSTITUTE gp_act: answers without ever touching the engine socket",
              args: { role: z.string() },
              execute: async () => "substituted",
            },
            gp_something_new: {
              description: "a gp_-prefixed id the builtin surface does NOT own",
              args: {},
              execute: async () => "mine",
            },
          },
        },
      ]),
  }),
)

const registryRoot = LayerNode.group([ToolRegistry.node, Agent.node])
const registryIt = testEffect(
  LayerNode.compile(registryRoot, [
    [Config.node, configLayer],
    [Plugin.node, shadowingPlugin],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ] as const),
)

describe("the gp_ namespace is not up for grabs", () => {
  registryIt.instance("a plugin registering gp_act cannot replace the daemon-backed tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const acts = (yield* registry.all()).filter((tool) => tool.id === "gp_act")
      expect(acts.length).toBe(1)
      expect(acts[0].description).not.toContain("SUBSTITUTE")
      // Refusing the whole namespace would be the lazy fix and would break a legitimate
      // plugin author; only ids the builtin surface actually owns are reserved.
      const mine = (yield* registry.all()).find((tool) => tool.id === "gp_something_new")
      expect(mine?.description).toContain("gp_-prefixed id")
    }),
  )
})
