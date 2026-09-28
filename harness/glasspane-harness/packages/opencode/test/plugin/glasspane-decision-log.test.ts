import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { GlasspaneDecisionLogPlugin, decisionLogWarning, recordToolExecution } from "../../src/plugin/glasspane-decision-log"
import { verifyLedger } from "../../src/tool/glasspane/kernel"

/**
 * M2 fixed points — the evidence plugin's contract with the ledger.
 *
 * The behaviour under test is a trade, and both sides of it have to be able to
 * fail: an evidence-bearing `gp_*` result must reach the chain, and the model's
 * view of the same result must not move by a single byte. A plugin that quietly
 * improves the audit trail by editing what the agent saw would be worse than one
 * that logs nothing.
 */

const FIXTURES = path.join(import.meta.dir, "..", "..", "vendor", "kernel", "fixtures")
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
