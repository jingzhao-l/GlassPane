import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { GlasspaneDecisionLogPlugin, decisionLogWarning, recordToolExecution } from "../../src/plugin/glasspane-decision-log"
import { verifyLedger } from "../../src/tool/glasspane/kernel"

import { kernelFixturesDir } from "../lib/kernel-contract"

/**
 * M2 fixed points — the evidence plugin's contract with the ledger.
 *
 * The behaviour under test is a trade, and both sides of it have to be able to
 * fail: an evidence-bearing `gp_*` result must reach the chain, and the model's
 * view of the same result must not move by a single byte. A plugin that quietly
 * improves the audit trail by editing what the agent saw would be worse than one
 * that logs nothing.
 */

// The contract corpus ships inside the installed kernel; the path is resolved by
// walking up (see test/lib/kernel-contract.ts) rather than hard-coded into a tree that
// no longer exists.
const FIXTURES = kernelFixturesDir(import.meta.dir)
const pack = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, `evidence-pack.${name}.json`), "utf8"))

function ledgerEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), "gp-fork-plugin-"))
  return { dir, env: { GLASSPANE_DECISION_LOG: path.join(dir, "decisions.jsonl"), HOME: dir } }
}

function toolResult(result: unknown, ok = true) {
  return {
    title: "gp_observe: observe ok",
    output: "observed 1 window; no anomaly",
    metadata: ok ? { ok: true, method: "observe", code: null, message: null, remedy: null, result } : {
      ok: false,
      method: "observe",
      code: "GP_E_NOT_ATTACHED",
      message: "no window is attached",
      remedy: "call gp_attach first",
      result: null,
    },
  }
}

const input = (tool: string) => ({ tool, sessionID: "ses_test", callID: "call_test" })

describe("what the plugin records", () => {
  test("a gp_* result carrying an evidence pack lands in the chain", () => {
    const { env } = ledgerEnv()
    const output = toolResult({ evidencePack: pack("ok-01") })
    const before = output.output
    const note = recordToolExecution(input("gp_observe"), output, env)

    expect(note).toBeDefined()
    expect(note?.status).toBe("logged")
    if (note?.status !== "logged") return
    expect(note.outcome).toBe("pass")
    expect(note.sequence).toBe(0)
    expect(output.output).toBe(before) // the model's view did not move
  })

  test("two calls link, so the ledger is a chain and not a pile", () => {
    const { env, dir } = ledgerEnv()
    const ledger = path.join(dir, "decisions.jsonl")
    const first = recordToolExecution(input("gp_observe"), toolResult({ evidencePack: pack("ok-01") }), env)
    const second = recordToolExecution(input("gp_diagnose"), toolResult({ evidencePack: pack("ok-05-pixelbounds-null") }), env)
    expect(first?.status).toBe("logged")
    expect(second?.status).toBe("logged")
    if (first?.status !== "logged" || second?.status !== "logged") return
    expect(second.sequence).toBe(1)

    const lines = readFileSync(ledger, "utf8").trimEnd().split("\n")
    expect(JSON.parse(lines[1]).prevEntryHash.length).toBe(64)
    expect(verifyLedger(ledger)).toMatchObject({ ok: true, entries: 2 })
    const entry = JSON.parse(lines[1])
    expect(entry.summary).toContain("gp_diagnose in session ses_test")
    expect(entry.summary).toContain("diagnosis T2")
    expect(statSync(ledger).mode & 0o777).toBe(0o600)
  })

  test("the outcome is the engine's, never the plugin's", () => {
    const { env } = ledgerEnv()
    for (const [name, want] of [
      ["ok-01", "pass"],
      ["ok-02", "inconclusive"],
      ["ok-05-pixelbounds-null", "fail"],
    ] as const) {
      const note = recordToolExecution(input("gp_observe"), toolResult({ evidencePack: pack(name) }), env)
      expect(note?.status).toBe("logged")
      if (note?.status !== "logged") return
      expect(note.outcome).toBe(want)
    }
  })
})

describe("what the plugin refuses to invent", () => {
  test("a non-glasspane tool is not ours to record", () => {
    const { env, dir } = ledgerEnv()
    const note = recordToolExecution(input("read"), toolResult({ evidencePack: pack("ok-01") }), env)
    expect(note).toBeUndefined()
    expect(verifyLedger(path.join(dir, "decisions.jsonl"))).toEqual({ ok: true, entries: 0 })
  })

  test("a failed gp_* call writes no decision — the engine never got to evidence anything", () => {
    const { env, dir } = ledgerEnv()
    const note = recordToolExecution(input("gp_observe"), toolResult(null, false), env)
    expect(note?.status).toBe("skipped")
    expect(verifyLedger(path.join(dir, "decisions.jsonl")).entries).toBe(0)
  })

  test("a result with no evidence frame is reported, not guessed at", () => {
    const { env, dir } = ledgerEnv()
    const note = recordToolExecution(input("gp_attach"), toolResult({ attached: { pid: 4242 } }), env)
    expect(note?.status).toBe("skipped")
    if (note?.status !== "skipped") return
    expect(note.reason).toContain("no evidence frame")
    expect(verifyLedger(path.join(dir, "decisions.jsonl")).entries).toBe(0)
  })

  test("the engine's real act reply records no decision, dimension declared or not", () => {
    // Measured against the engine, this is the ordinary case and not a degraded one:
    // `act` answers with the flat operation dict (`EngineCore.swift:1275-1300`), and the
    // one reply that carries an `evidencePack` is `last_evidence` (`Dispatcher.swift:156`).
    // A dimension declared on `gp_act` therefore has nothing to be recorded against —
    // which is the fact the tool surface's own parameter text now states.
    const { env, dir } = ledgerEnv()
    const actReply = { operationId: "op_0123456789ABCDEFGHJKMNPQRS", actConfirmed: true, latencyMs: 12, evidenceId: "op_0123456789ABCDEFGHJKMNPQRS" }
    for (const metadata of [actReply, { ...actReply, dimension: "security" }]) {
      const note = recordToolExecution(input("gp_act"), toolResult(metadata), env)
      expect(note?.status).toBe("skipped")
    }
    expect(verifyLedger(path.join(dir, "decisions.jsonl")).entries).toBe(0)
  })

  test("a frame the engine does not emit fails loudly, with a remedy that is not a loop", () => {
    // `result: null` is a transport-level shape, not an engine answer — `lastEvidence`
    // throws GP_E_NO_EVIDENCE when there is nothing to hand back (`EngineCore.swift:1631-1644`)
    // and `Dispatcher.swift:156` always wraps the pack in an object. The transport still
    // hands it up unchanged (pinned in test/tool/glasspane-surface.test.ts), so this is the
    // layer that has to say what it means: no decision, and a next step the agent can run
    // even when the call that just failed WAS `gp_last_evidence`.
    const { env, dir } = ledgerEnv()
    const output = toolResult(null)
    const note = recordToolExecution(input("gp_last_evidence"), output, env)
    expect(note?.status).toBe("failed")
    if (note?.status !== "failed") return
    expect(note.code).toBe("GP_E_EVIDENCE_FRAME")
    expect(note.remedy).not.toContain("call gp_last_evidence")
    expect(note.remedy).not.toContain("gp_last_evidence and pass its reply")
    // Executable, and not about the call that just failed.
    expect(note.remedy).toContain("gp_probe_status")
    expect(note.remedy).toContain("no evidence")
    expect(verifyLedger(path.join(dir, "decisions.jsonl")).entries).toBe(0)
    // The row still reads as a transport success (the daemon did answer), so the failure
    // only reaches the model through the appended warning — that is the divergence, and it
    // is pinned rather than smoothed over.
    expect(output.metadata).toMatchObject({ ok: true })
    expect(decisionLogWarning(note)).toContain("decision log NOT written")
  })

  test("a frame that fails the kernel's contract is a loud failure, not a silent gap", () => {
    const { env, dir } = ledgerEnv()
    const broken = { evidencePack: { ...(pack("ok-01") as object), attribution: { level: "telepathic", contaminated: false } } }
    const note = recordToolExecution(input("gp_observe"), toolResult(broken), env)
    expect(note?.status).toBe("failed")
    if (note?.status !== "failed") return
    expect(note.code).toBe("KERNEL_E_SCHEMA")
    expect(note.remedy.length).toBeGreaterThan(10)
    expect(verifyLedger(path.join(dir, "decisions.jsonl")).entries).toBe(0)
    expect(decisionLogWarning(note)).toContain("decision log NOT written")
  })

  test("its prose names only tools this surface defines", () => {
    // A method the fork does not have, written into an explanatory comment, is the same
    // defect as a method the engine does not have: the next person reads the comment as a
    // list of what exists. `gp_shutdown` lived in this file's skip-list comment for that
    // long — there is no such tool here, and the engine's `shutdown` is excluded from the
    // capabilities `hello` advertises (`FrameCodec.swift`'s `capabilityMethods`).
    const surface = readFileSync(path.join(import.meta.dir, "..", "..", "src", "tool", "glasspane", "index.ts"), "utf8")
    const defined = new Set([...surface.matchAll(/Tool\.define\(\s*"([a-z_]+)"/g)].map((m) => m[1]))
    expect(defined.size, "the tool surface defines no tools — this scan is measuring an empty set").toBeGreaterThan(5)
    for (const file of ["glasspane-decision-log.ts", "glasspane-compaction.ts"]) {
      const text = readFileSync(path.join(import.meta.dir, "..", "..", "src", "plugin", file), "utf8")
      for (const name of new Set([...text.matchAll(/\bgp_[a-z_]+/g)].map((m) => m[0]))) {
        expect([...defined].sort(), `${file} names ${name}, which no Tool.define registers`).toContain(name)
      }
    }
  })
})

describe("what the plugin does when the ledger cannot be trusted", () => {
  test("a corrupt tail surfaces through the hook, and the tool result still reaches the model intact", async () => {
    const { env, dir } = ledgerEnv()
    const ledger = path.join(dir, "decisions.jsonl")
    writeFileSync(ledger, "the previous writer truncated this line mid-byte\n")
    const hooks = await GlasspaneDecisionLogPlugin({} as never)
    const hook = hooks["tool.execute.after"]
    if (!hook) throw new Error("the plugin must expose tool.execute.after")
    const output = toolResult({ evidencePack: pack("ok-01") })
    const untouched = output.output
    // The hook reads the ledger path from the environment; that is the only
    // runtime input it has, so the test sets exactly that.
    const previous = process.env.GLASSPANE_DECISION_LOG
    process.env.GLASSPANE_DECISION_LOG = env.GLASSPANE_DECISION_LOG
    try {
      await hook({ tool: "gp_observe", sessionID: "ses_test", callID: "call_test", args: {} }, output)
    } finally {
      if (previous === undefined) delete process.env.GLASSPANE_DECISION_LOG
      else process.env.GLASSPANE_DECISION_LOG = previous
    }

    const note = (output.metadata as { decisionLog?: { status: string; code?: string } }).decisionLog
    expect(note?.status).toBe("failed")
    expect(note?.code).toBe("KERNEL_E_DECISION_LOG_CORRUPT")
    expect(output.output.startsWith(untouched)).toBe(true) // appended, never replaced
    expect(output.output).toContain("decision log NOT written")
    expect(output.output).toContain("remedy:")
    expect(verifyLedger(ledger).firstBrokenLine).toBe(1)
  })

  test("the warning rule is quiet for the states that need no alarm", () => {
    expect(decisionLogWarning({ status: "skipped", reason: "x" })).toBeUndefined()
    expect(
      decisionLogWarning({ status: "logged", path: "/tmp/x", sequence: 0, hash: "h", outcome: "pass", line: 1 }),
    ).toBeUndefined()
  })
})

describe("the plugin's shape as the host sees it", () => {
  test("it declares exactly one hook, and that hook mutates only metadata + the warning line", async () => {
    const hooks = await GlasspaneDecisionLogPlugin({
      client: {} as never,
      project: {} as never,
      directory: process.cwd(),
      worktree: process.cwd(),
      experimental_workspace: { register: () => undefined },
      // The plugin never touches $ or the server URL, so the host input it needs
      // is empty; asserting the key list here is what stops a future edit from
      // quietly starting to depend on things this hook cannot have.
      $: undefined as never,
    } as never)
    expect(Object.keys(hooks)).toEqual(["tool.execute.after"])
  })
})
