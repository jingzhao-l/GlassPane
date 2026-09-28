import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import {
  GlasspaneCompactionPlugin,
  collectEvidenceAnchors,
  injectEvidenceAnchors,
  renderAnchorBlock,
} from "../../src/plugin/glasspane-compaction"

/**
 * M4 fixed points — the compaction hook's contract with the audit chain.
 *
 * Both halves of the trade have to be able to fail: a session that produced
 * decisions must get them injected, and the injected text must not contain a
 * single field the engine or the kernel did not write. A hook that "improves"
 * the summary by interpreting the evidence would be worse than one that injects
 * nothing — the same trade M2 makes for the ledger, one turn earlier in the
 * session's life.
 */

const FIXTURES = path.join(import.meta.dir, "..", "..", "vendor", "kernel", "fixtures")
const pack = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, `evidence-pack.${name}.json`), "utf8"))

const OP_OK = "op_0123456789ABCDEFGHJKMNPQRS"
const HASH = "a".repeat(64)

/** M2's ledger receipt, the strongest anchor a message can carry. */
const receipt = (over: Record<string, unknown> = {}) => ({
  status: "logged",
  path: "/tmp/gp-ledger/decisions.jsonl",
  sequence: 0,
  hash: HASH,
  outcome: "pass",
  line: 1,
  ...over,
})

/** One assistant message holding one tool part; the shape `session.messages` returns. */
function message(tool: string, options: { status?: string; metadata?: Record<string, unknown> } = {}) {
  return {
    info: { id: "msg_1", role: "assistant" },
    parts: [
      {
        id: "part_1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool",
        callID: "call_1",
        tool,
        state: {
          status: options.status ?? "completed",
          input: {},
          output: "…",
          title: tool,
          metadata: options.metadata ?? {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  }
}

const okMetadata = (over: Record<string, unknown> = {}) => ({
  ok: true,
  method: "observe",
  code: null,
  message: null,
  remedy: null,
  result: { evidencePack: pack("ok-01") },
  ...over,
})

describe("what the hook preserves", () => {
  test("a receipted gp_* call becomes one anchor using the engine's and kernel's fields", () => {
    const collected = collectEvidenceAnchors([message("gp_observe", { metadata: okMetadata({ decisionLog: receipt() }) })])
    expect(collected.calls).toBe(1)
    expect(collected.withoutDecision).toBe(0)
    expect(collected.anchors).toEqual([
      {
        method: "observe",
        operationId: OP_OK,
        outcome: "pass",
        ledgerLine: 1,
        ledgerHash: HASH,
        ledgerPath: "/tmp/gp-ledger/decisions.jsonl",
      },
    ])
  })

  test("the rendered block quotes those fields and points back at the ledger", () => {
    const collected = collectEvidenceAnchors([message("gp_observe", { metadata: okMetadata({ decisionLog: receipt() }) })])
    const block = renderAnchorBlock(collected)
    expect(block).toBeDefined()
    expect(block).toContain(`- observe · op ${OP_OK} · outcome pass · ledger #1 · entry sha256 ${HASH.slice(0, 16)}…`)
    expect(block).toContain("gp_* calls: 1 · decisions recorded: 1 · without a decision record: 0")
    expect(block).toContain("ledger: /tmp/gp-ledger/decisions.jsonl")
    expect(block).toContain("does not re-judge")
  })

  test("the block is appended to the context array, and the note names the target", async () => {
    const output: { context: string[]; prompt?: string } = { context: [] }
    const note = await injectEvidenceAnchors("ses_1", output, async () => [
      message("gp_observe", { metadata: okMetadata({ decisionLog: receipt() }) }),
    ])
    expect(note.status).toBe("injected")
    if (note.status !== "injected") return
    expect(note.target).toBe("context")
    expect(note.anchors).toBe(1)
    expect(output.context.length).toBe(1)
    expect(output.context[0]).toContain("## GlassPane evidence anchors (M4)")
  })

  test("a glasspane session with no receipts says so by arithmetic, not by silence", async () => {
    const output: { context: string[]; prompt?: string } = { context: [] }
    const note = await injectEvidenceAnchors("ses_1", output, async () => [
      message("gp_probe_status", { metadata: { ok: true, method: "probe_status", result: { version: "0.1.0" } } }),
    ])
    expect(note.status).toBe("injected")
    expect(output.context[0]).toContain("gp_* calls: 1 · decisions recorded: 0 · without a decision record: 1")
    expect(output.context[0]).toContain("no decision-log entries were recorded in this session")
    expect(output.context[0]).toContain("status-only or failed calls")
  })

  test("the ledger line follows the most recent anchor, not the first", () => {
    const first = collectEvidenceAnchors([
      message("gp_observe", { metadata: okMetadata({ decisionLog: receipt({ path: "/tmp/old/decisions.jsonl" }) }) }),
    ])
    const second = message("gp_diagnose", {
      metadata: okMetadata({ decisionLog: receipt({ line: 2, path: "/tmp/new/decisions.jsonl" }) }),
    })
    const merged = collectEvidenceAnchors([
      message("gp_observe", { metadata: okMetadata({ decisionLog: receipt({ path: "/tmp/old/decisions.jsonl" }) }) }),
      second,
    ])
    expect(first.anchors.length).toBe(1)
    expect(merged.anchors.length).toBe(2)
    expect(renderAnchorBlock(merged)).toContain("ledger: /tmp/new/decisions.jsonl")
  })
})

describe("what the hook refuses to invent", () => {
  test("a session with no gp_* calls gets no block and an untouched context", async () => {
    const output: { context: string[]; prompt?: string } = { context: [] }
    const note = await injectEvidenceAnchors("ses_1", output, async () => [message("bash", { metadata: {} })])
    expect(note).toEqual({ status: "skipped", reason: "no gp_* tool calls in this session" })
    expect(output.context).toEqual([])
    expect(renderAnchorBlock(collectEvidenceAnchors(undefined))).toBeUndefined()
  })

  test("a failed call is counted but never given an outcome", () => {
    const collected = collectEvidenceAnchors([
      message("gp_observe", { status: "error", metadata: { ok: false, method: "observe", code: "GP_E_NOT_ATTACHED" } }),
    ])
    expect(collected.calls).toBe(1)
    expect(collected.anchors).toEqual([])
    expect(collected.withoutDecision).toBe(1)
  })

  test("a running call is not history yet", () => {
    const collected = collectEvidenceAnchors([
      message("gp_observe", { status: "running", metadata: okMetadata({ decisionLog: receipt() }) }),
    ])
    expect(collected).toEqual({ calls: 0, anchors: [], withoutDecision: 0 })
  })

  test("a receipt whose pack no longer parses keeps the kernel's fields and no invented operationId", () => {
    const broken = okMetadata({
      decisionLog: receipt(),
      result: { evidencePack: { ...(pack("ok-01") as object), attribution: { level: "telepathic", contaminated: false } } },
    })
    const collected = collectEvidenceAnchors([message("gp_observe", { metadata: broken })])
    expect(collected.anchors.length).toBe(1)
    expect(collected.anchors[0].operationId).toBeUndefined()
    const block = renderAnchorBlock(collected)
    expect(block).toContain("- observe · outcome pass · ledger #1")
    expect(block).not.toContain("op ")
  })

  test("garbage in the receipt never becomes a string in the block", () => {
    const garbage = okMetadata({ decisionLog: receipt({ outcome: 42, hash: { nested: true }, line: "7" }) })
    const collected = collectEvidenceAnchors([message("gp_observe", { metadata: garbage })])
    const block = renderAnchorBlock(collected)
    expect(block).toBeDefined()
    expect(block).toContain("- observe · op " + OP_OK)
    expect(block).not.toContain("42")
    expect(block).not.toContain("[object Object]")
    expect(block).not.toContain("nested")
  })

  test("old anchors are capped and the omission is stated with a number", () => {
    const messages = Array.from({ length: 25 }, (_, index) =>
      message("gp_observe", {
        metadata: okMetadata({ decisionLog: receipt({ line: index + 1, outcome: index % 2 === 0 ? "pass" : "fail" }) }),
      }),
    )
    const block = renderAnchorBlock(collectEvidenceAnchors(messages))
    expect(block).toContain("gp_* calls: 25 · decisions recorded: 25 · without a decision record: 0")
    expect(block).toContain("showing the most recent 20 anchors; 5 older anchor(s) omitted")
    expect(block).toContain("entry sha256")
  })
})


describe("where the block goes, and what happens when the pull fails", () => {
  test("a prompt another plugin already replaced wins over context — the block is appended to it", async () => {
    const output: { context: string[]; prompt?: string } = { context: [], prompt: "EXISTING COMPACTION PROMPT" }
    const note = await injectEvidenceAnchors("ses_1", output, async () => [
      message("gp_observe", { metadata: okMetadata({ decisionLog: receipt() }) }),
    ])
    expect(note.status).toBe("injected")
    if (note.status !== "injected") return
    // Upstream computes `prompt ?? [...context]`, so context would be dead letter here.
    expect(note.target).toBe("prompt")
    expect(output.context).toEqual([])
    expect(output.prompt?.startsWith("EXISTING COMPACTION PROMPT")).toBe(true)
    expect(output.prompt).toContain("## GlassPane evidence anchors (M4)")
  })

  test("a pull that throws is reported in-band and never thrown at the host", async () => {
    const output: { context: string[]; prompt?: string } = { context: [] }
    const note = await injectEvidenceAnchors("ses_1", output, async () => {
      throw new Error("socket closed")
    })
    expect(note.status).toBe("failed")
    if (note.status !== "failed") return
    expect(note.code).toBe("GP_E_COMPACTION_MESSAGES")
    expect(note.message).toContain("socket closed")
    expect(output.context.length).toBe(1)
    expect(output.context[0]).toContain("evidence anchors NOT preserved")
    expect(output.context[0]).toContain("remedy:")
    expect(output.context[0]).not.toContain("## GlassPane evidence anchors")
  })

  test("the host plugin exposes exactly the compaction hook", async () => {
    const hooks = await GlasspaneCompactionPlugin({
      client: {} as never,
      project: {} as never,
      directory: process.cwd(),
      worktree: process.cwd(),
      experimental_workspace: { register: () => undefined },
      $: undefined as never,
    } as never)
    expect(Object.keys(hooks)).toEqual(["experimental.session.compacting"])
  })

  test("driven through the host hook, the SDK's reply feeds the same pipeline end to end", async () => {
    const asked: string[] = []
    const client = {
      session: {
        messages: async (options: { path: { id: string } }) => {
          asked.push(options.path.id)
          return { data: [message("gp_observe", { metadata: okMetadata({ decisionLog: receipt() }) })] }
        },
      },
    }
    const hooks = await GlasspaneCompactionPlugin({ client } as never)
    const output: { context: string[]; prompt?: string } = { context: [] }
    await hooks["experimental.session.compacting"]?.({ sessionID: "ses_42" }, output)
    expect(asked).toEqual(["ses_42"])
    expect(output.context.length).toBe(1)
    expect(output.context[0]).toContain(`op ${OP_OK}`)
  })

  test("an SDK error object becomes a failure note, not a silent no-op", async () => {
    const client = {
      session: { messages: async () => ({ error: { data: { message: "Session not found" } } }) },
    }
    const hooks = await GlasspaneCompactionPlugin({ client } as never)
    const output: { context: string[]; prompt?: string } = { context: [] }
    await hooks["experimental.session.compacting"]?.({ sessionID: "ses_404" }, output)
    expect(output.context.length).toBe(1)
    expect(output.context[0]).toContain("evidence anchors NOT preserved")
    expect(output.context[0]).toContain("the host rejected the message pull: Session not found")
  })
})

