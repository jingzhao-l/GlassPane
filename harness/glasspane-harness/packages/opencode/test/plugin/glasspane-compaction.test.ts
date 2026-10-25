import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import {
  GlasspaneCompactionPlugin,
  MAX_ANCHORS,
  collectEvidenceAnchors,
  injectEvidenceAnchors,
  renderAnchorBlock,
  renderDimensionCoverage,
  selectAnchors,
} from "../../src/plugin/glasspane-compaction"

import { kernelFixturesDir } from "../lib/kernel-contract"

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

// The contract corpus ships inside the installed kernel; the path is resolved by
// walking up (see test/lib/kernel-contract.ts) rather than hard-coded into a tree that
// no longer exists.
const FIXTURES = kernelFixturesDir(import.meta.dir)
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

  test("the dimension the caller declared is what coverage counts, and nothing else is", () => {
    // The carry-through is the point of the tool parameter: a call recorded without a
    // dimension contributes to no dimension, and one recorded with a bad name is refused
    // upstream rather than silently matching a planned id.
    const collected = collectEvidenceAnchors([
      message("gp_act", { metadata: okMetadata({ method: "act", dimension: "security", decisionLog: receipt() }) }),
      message("gp_observe", { metadata: okMetadata({ decisionLog: receipt() }) }),
    ])
    expect(collected.anchors[0]?.dimension).toBe("security")
    expect(collected.anchors[1]?.dimension).toBeUndefined()
    const line = renderDimensionCoverage({
      calls: collected.calls,
      anchors: collected.anchors,
      withoutDecision: collected.withoutDecision,
      plannedDimensions: ["security", "ui-ux"],
    })
    // One decision, not two: the kernel counts decisions per dimension, and a call that
    // declared no dimension contributes nothing to the arithmetic. Saying "2" here would
    // make an unattributed call read as coverage of something.
    expect(line).toBe("1/2 dimensions verified, 1 unverified (ui-ux), 1 decision")
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

  test("what the production path actually reaches, so the dimension lane is not claimed twice", () => {
    // The coverage-line tests below hand-build an `AnchorCollection` with
    // `plannedDimensions` and per-anchor `dimension`. On the real path an anchor exists only
    // where M2 recorded a decision, and a declared dimension is transcribed only onto one:
    // the engine emits an `evidencePack` on one method, `last_evidence`
    // (`Dispatcher.swift:156`), so a dimension declared on `gp_act` / `gp_observe` /
    // `gp_attach` / `gp_diagnose` sits on a call that produces no anchor at all — see the
    // pair pinned in "only a call that recorded a decision can move the coverage counter",
    // and the count that reports it in "how many declarations the surface actually lost".
    //
    // The collector is the half that stays plan-free by design: a plan reaches the block only
    // through `renderAnchorBlock`'s plan argument, which the host binding fills from
    // `readRunPlan(process.env, input.directory)`. A collection that quietly grew a plan would
    // let one session's plan leak into another's summary, so `plannedDimensions` stays
    // undefined here no matter what the transcript declares — that is what the first
    // assertion below is the ratchet for.
    const collected = collectEvidenceAnchors([
      message("gp_act", { metadata: okMetadata({ method: "act", decisionLog: receipt() }) }),
      message("gp_observe", { metadata: okMetadata({ decisionLog: receipt() }) }),
    ])
    expect(collected.plannedDimensions).toBeUndefined()
    const block = renderAnchorBlock(collected)
    expect(block).toBeDefined()
    expect(block).toContain("decisions recorded: 2")
    expect(block).not.toContain("dimension coverage:")
    // Same transcript, plan supplied: the line now exists, and nothing else about the block
    // changed. This is the production shape — `injectEvidenceAnchors` passes `readPlan()`.
    // Note what the kernel says about decisions: 2 anchors recorded, 0 of them attributable to
    // a dimension, so the line reads "0 decisions". A decision that names no dimension is real
    // history in the chain and still zero coverage — the two numbers are not the same count and
    // a reader who conflated them would call this session verified.
    const planned = renderAnchorBlock(collected, {
      ok: true,
      plan: { path: "/var/tmp/plan.json", digest: "rp_a".repeat(8).slice(0, 67), ids: ["security"], source: "project" },
    })
    expect(planned).toContain("dimension coverage: 0/1 dimensions verified, 1 unverified (security), 0 decisions")
    expect(planned).toContain("decisions recorded: 2")
  })

  test("only a call that recorded a decision can move the coverage counter", () => {
    // DEFECT 5's fixed point, measured as behavior rather than as prose. The engine's act
    // reply is the flat operation dict (`EngineCore.swift:1275-1300`) — it carries no
    // `evidencePack`, so M2 has nothing to chain and records `skipped`, and compaction sees
    // a call without a decision. Declaring a dimension on such a call cannot make it
    // verified, and the line has to say the dimension is unverified rather than go quiet.
    const actReply = {
      operationId: OP_OK,
      actConfirmed: true,
      latencyMs: 12,
      evidenceId: OP_OK,
      contaminationMonitored: true,
      contaminationBasis: "watched",
    }
    const declaredOnAct = collectEvidenceAnchors([
      message("gp_act", {
        metadata: okMetadata({
          method: "act",
          dimension: "security",
          result: actReply,
          decisionLog: { status: "skipped", reason: "this gp_* method returns no evidence frame" },
        }),
      }),
    ])
    expect(declaredOnAct.calls).toBe(1)
    expect(declaredOnAct.anchors).toEqual([])
    expect(declaredOnAct.withoutDecision).toBe(1)
    expect(
      renderDimensionCoverage({
        calls: declaredOnAct.calls,
        anchors: declaredOnAct.anchors,
        withoutDecision: declaredOnAct.withoutDecision,
        plannedDimensions: ["security"],
      }),
    ).toBe("0/1 dimensions verified, 1 unverified (security), 0 decisions")

    // The same session, and the same dimension declared on the one method whose reply the
    // engine does archive: now there is a decision to attribute, and the counter moves.
    const declaredOnLastEvidence = collectEvidenceAnchors([
      message("gp_act", {
        metadata: okMetadata({
          method: "act",
          dimension: "security",
          result: actReply,
          decisionLog: { status: "skipped", reason: "this gp_* method returns no evidence frame" },
        }),
      }),
      message("gp_last_evidence", {
        metadata: okMetadata({ method: "last_evidence", dimension: "security", decisionLog: receipt() }),
      }),
    ])
    expect(declaredOnLastEvidence.calls).toBe(2)
    expect(declaredOnLastEvidence.withoutDecision).toBe(1)
    expect(declaredOnLastEvidence.anchors.map((anchor) => anchor.dimension)).toEqual(["security"])
    expect(
      renderDimensionCoverage({
        calls: declaredOnLastEvidence.calls,
        anchors: declaredOnLastEvidence.anchors,
        withoutDecision: declaredOnLastEvidence.withoutDecision,
        plannedDimensions: ["security"],
      }),
    ).toContain("1/1 dimensions verified")

    // And the block says the first call had no decision record, so a reader cannot infer
    // coverage from the number of gp_* calls it can see.
    expect(renderAnchorBlock(declaredOnAct)).toContain("decisions recorded: 0 · without a decision record: 1")
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

describe("how many declarations the surface actually lost", () => {
  // ②'s remaining asymmetry, turned from a paragraph in the module header into a number the
  // block prints. The engine emits an evidence pack on `last_evidence` only, so a dimension
  // declared anywhere else has no decision to ride into the summary. Whether that happened in
  // *this* session is measurable; a comment can only assert it forever.
  const actReply = {
    operationId: OP_OK,
    actConfirmed: true,
    latencyMs: 12,
    evidenceId: OP_OK,
    contaminationMonitored: true,
    contaminationBasis: "watched",
  }
  const noPack = (dimension?: string) =>
    message("gp_act", {
      metadata: okMetadata({
        method: "act",
        ...(dimension === undefined ? {} : { dimension }),
        result: actReply,
        decisionLog: { status: "skipped", reason: "this gp_* method returns no evidence frame" },
      }),
    })

  test("a declaration on a method that records no decision is counted", () => {
    const collected = collectEvidenceAnchors([noPack("security"), noPack("correctness")])
    expect(collected.calls).toBe(2)
    expect(collected.anchors).toEqual([])
    expect(collected.declaredWithoutAnchor).toBe(2)
    expect(renderAnchorBlock(collected)).toContain(
      "dimension declarations that reached no anchor: 2 — those calls recorded no decision, so the dimension they named cannot be shown as verified here",
    )
  })

  test("a call that lost no declaration is not counted, so the number is the subset and not the total", () => {
    // The distinction this test exists for: `withoutDecision` already counts every call with no
    // anchor. If the new number were that same count, the block would report a lost dimension for
    // every status-only call that never declared one, and the reader could not tell a narrow
    // emitting surface from a session that simply did not name dimensions.
    const collected = collectEvidenceAnchors([noPack(), noPack(), message("gp_probe_status", { metadata: { ok: true, method: "probe_status", result: { version: "0.1.0" } } })])
    expect(collected.withoutDecision).toBe(3)
    expect(collected.declaredWithoutAnchor).toBe(0)
    expect(renderAnchorBlock(collected)).not.toContain("reached no anchor")
  })

  test("a declaration that did reach an anchor is not a loss", () => {
    const collected = collectEvidenceAnchors([
      message("gp_last_evidence", { metadata: okMetadata({ method: "last_evidence", dimension: "security", decisionLog: receipt() }) }),
      noPack("correctness"),
    ])
    expect(collected.anchors.length).toBe(1)
    expect(collected.declaredWithoutAnchor).toBe(1)
    // Both readings in one block: what was lost, and what the kernel says about coverage.
    const block = renderAnchorBlock(collected, {
      ok: true,
      plan: { path: "/var/tmp/plan.json", digest: "rp_a".repeat(8).slice(0, 67), ids: ["security", "correctness"], source: "project" },
    })
    expect(block).toContain("dimension declarations that reached no anchor: 1")
    expect(block).toContain("1/2 dimensions verified, 1 unverified (correctness)")
  })

  test("a failed call that declared a dimension is a lost declaration too", () => {
    // The shell echoes the declared dimension in the result metadata, and a rejected call still
    // carries it — the caller asked for that dimension to be on the record and nothing got there.
    const collected = collectEvidenceAnchors([
      message("gp_act", { status: "error", metadata: { ok: false, method: "act", code: "GP_E_NOT_ATTACHED", dimension: "security" } }),
    ])
    expect(collected.calls).toBe(1)
    expect(collected.withoutDecision).toBe(1)
    expect(collected.declaredWithoutAnchor).toBe(1)
  })

  test("a running call is not settled, so it neither counts as a call nor as a loss", () => {
    const collected = collectEvidenceAnchors([
      message("gp_act", { status: "running", metadata: okMetadata({ method: "act", dimension: "security", decisionLog: receipt() }) }),
    ])
    expect(collected.calls).toBe(0)
    expect(collected.declaredWithoutAnchor).toBe(0)
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
    // The whole shape, not a field at a time: `collectEvidenceAnchors` always reports the
    // declaration count, and a collector that stopped filling it would leave the block silent
    // about a gap that was never measured.
    expect(collected).toEqual({ calls: 0, anchors: [], withoutDecision: 0, declaredWithoutAnchor: 0 })
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


describe("dimension coverage, computed by the kernel (M4)", () => {
  const anchors = (dimensions: (string | undefined)[]) =>
    dimensions.map((dimension, index) => ({
      method: index % 2 === 0 ? "observe" : "act",
      ...(dimension !== undefined ? { dimension } : {}),
      operationId: `op_${index}`,
    }))

  test("a planned dimension with no decision is reported unverified, not dropped", () => {
    // The sentence this whole structure exists to produce: the summariser must
    // be able to learn what was NOT checked without anyone interpreting evidence.
    const line = renderDimensionCoverage({
      calls: 5,
      anchors: anchors(["correctness", "correctness", "ui-ux"]),
      withoutDecision: 2,
      plannedDimensions: ["correctness", "security", "ui-ux"],
    })
    expect(line).toBe("2/3 dimensions verified, 1 unverified (security), 3 decisions")
  })

  test("a session with a plan and no decisions at all still produces a line", () => {
    const line = renderDimensionCoverage({
      calls: 0,
      anchors: [],
      withoutDecision: 0,
      plannedDimensions: ["security", "correctness"],
    })
    expect(line).toBe("0/2 dimensions verified, 2 unverified (security, correctness), 0 decisions")
  })

  test("a decision recorded against a dimension nobody planned is surfaced", () => {
    // The engine checked something the run never declared. Silently accepting it
    // would be the drift the kernel's `unplanned` status exists to prevent.
    const line = renderDimensionCoverage({
      calls: 1,
      anchors: anchors(["concurrency"]),
      withoutDecision: 0,
    })
    expect(line).toBe("0/0 dimensions verified, 1 unplanned (concurrency), 1 decision")
  })

  test("the declared plan, not the host's field, decides what was planned", () => {
    // Scenario 2's shared channel: the plan file is what both shells read, so the
    // coverage line must follow it even when the host attached no dimensions.
    const line = renderDimensionCoverage(
      { calls: 2, anchors: anchors(["security"]), withoutDecision: 1 },
      { ok: true, plan: { path: "/var/tmp/plan.json", digest: "rp_a".repeat(8).slice(0, 67), ids: ["security", "correctness"], source: "env" } },
    )
    expect(line).toContain("1/2 dimensions verified, 1 unverified (correctness), 1 decision")
    expect(line).toContain("[plan rp_")
    expect(line).toContain("/var/tmp/plan.json")
  })

  test("a plan the fork could not read is said out loud, not rendered as zero coverage", () => {
    // "no plan" and "your plan is unreadable" are different facts; collapsing them
    // turns a broken channel into an unreviewed session.
    const line = renderDimensionCoverage(
      { calls: 1, anchors: anchors(["security"]), withoutDecision: 0, plannedDimensions: ["security"] },
      { ok: false, error: { code: "GP_E_RUN_PLAN_SCHEMA", message: "dimensions.0.id: bad", remedy: "regenerate the plan" } },
    )
    expect(line).toContain("dimension coverage NOT computed")
    expect(line).toContain("GP_E_RUN_PLAN_SCHEMA")
    expect(line).not.toMatch(/verified/)
  })

  test("a method name is never mistaken for a dimension", () => {
    // "observe" is a method. Treating it as a dimension would invent an
    // ontology this fork does not own.
    const line = renderDimensionCoverage({
      calls: 1,
      anchors: [{ method: "observe" }],
      withoutDecision: 1,
      plannedDimensions: ["security"],
    })
    expect(line).toBe("0/1 dimensions verified, 1 unverified (security), 0 decisions")
  })

  test("no plan and nothing recorded yields no line rather than an invented one", () => {
    expect(
      renderDimensionCoverage({ calls: 1, anchors: [{ method: "observe" }], withoutDecision: 1 }),
    ).toBeUndefined()
  })

  test("the injected block carries the coverage line", () => {
    const block = renderAnchorBlock({
      calls: 3,
      anchors: anchors(["correctness", "correctness", "security"]),
      withoutDecision: 0,
      plannedDimensions: ["correctness", "security"],
    })
    expect(block).toContain("dimension coverage:")
    expect(block).toContain("2/2 dimensions verified")
  })

  // One `try` around pull + collect + render used to call every internal defect "could not
  // read this session's messages", which sent the reader to the client/server pair for a bug
  // in this file. The two stages now say which one broke — and the CODE is what a summary is
  // grouped and matched by (the module's own rationale for putting a code in the sentence),
  // so both directions are pinned below: prose alone would let two stages share one bucket.
  test("a defect in the renderer is not reported as a message-pull failure", async () => {
    const output: { context: string[]; prompt?: string } = { context: [] }
    const note = await injectEvidenceAnchors(
      "ses_1",
      output,
      async () => [message("gp_observe", { metadata: okMetadata({ decisionLog: receipt() }) })],
      () => {
        throw new TypeError("readPlan is not a function")
      },
    )
    expect(note.status).toBe("failed")
    if (note.status !== "failed") return
    expect(note.code).toBe("GP_E_COMPACTION_RENDER")
    expect(note.code).not.toBe("GP_E_COMPACTION_MESSAGES")
    expect(note.message).toContain("could not build the block")
    expect(note.message).toContain("readPlan is not a function")
    expect(note.message).not.toContain("could not read this session")
    expect(note.remedy).toContain("this plugin's renderer")
    expect(note.remedy).not.toContain("client/server pair")
    expect(output.context[0]).toContain("evidence anchors NOT preserved")
  })

  test("and a genuine pull failure still says it was the pull", async () => {
    const output: { context: string[]; prompt?: string } = { context: [] }
    const note = await injectEvidenceAnchors("ses_1", output, async () => {
      throw new Error("Session not found")
    })
    expect(note.status).toBe("failed")
    if (note.status !== "failed") return
    expect(note.code).toBe("GP_E_COMPACTION_MESSAGES")
    expect(note.code).not.toBe("GP_E_COMPACTION_RENDER")
    expect(note.message).toContain("could not read this session's messages")
    expect(note.message).not.toContain("could not build the block")
  })

  test("the two stages answer to two codes, in both directions", async () => {
    // The shape the file's own rationale demands: a code travels with the sentence so the
    // sentences can be grouped. With one code for both stages, "the host could not read the
    // session" and "this plugin could not build the block" counted as the same failure no
    // matter which one a run hit.
    const pull = await injectEvidenceAnchors("ses_1", { context: [] }, async () => {
      throw new Error("Session not found")
    })
    const render = await injectEvidenceAnchors(
      "ses_1",
      { context: [] },
      async () => [message("gp_observe", { metadata: okMetadata({ decisionLog: receipt() }) })],
      () => {
        throw new TypeError("renderer exploded")
      },
    )
    if (pull.status !== "failed" || render.status !== "failed") throw new Error("both stages must report a failure note")
    expect(pull.code).not.toBe(render.code)
    expect(new Set([pull.code, render.code])).toEqual(new Set(["GP_E_COMPACTION_MESSAGES", "GP_E_COMPACTION_RENDER"]))
  })

})

describe("which anchors the cap drops (scenario 2, the compression half)", () => {
  /** `count` anchors whose declared dimensions come from `pattern` cyclically. */
  function many(count: number, pattern: (string | undefined)[]) {
    return Array.from({ length: count }, (_, index) => {
      const dimension = pattern[index % pattern.length]
      return {
        method: "observe",
        ...(dimension === undefined ? {} : { dimension }),
        operationId: `op_${String(index).padStart(26, "0")}`,
      }
    })
  }

  const planFor = (ids: string[]) => ({
    ok: true as const,
    plan: { path: "/var/tmp/run-plan.json", digest: `rp_${"a".repeat(64)}`, ids, source: "project" as const },
  })

  /**
   * Transcript order read back off the operationIds. The length check is what makes the read
   * honest: `operationId` is optional on an anchor, so a plain `.map(id => …)` would either be a
   * type error (the one this helper replaces) or, if written to satisfy the compiler with a
   * default, a sorted-check over a list that silently lost the anchors without ids.
   */
  const transcriptOrder = (shown: readonly { operationId?: string }[]) => {
    const ids = shown.flatMap((anchor) => (anchor.operationId === undefined ? [] : [Number(anchor.operationId.slice(-2))]))
    expect(ids.length).toBe(shown.length)
    return ids
  }

  test("nothing is dropped below the cap, and the rule says so", () => {
    const collected = { calls: MAX_ANCHORS, anchors: many(MAX_ANCHORS, ["security"]), withoutDecision: 0 }
    const selection = selectAnchors(collected, planFor(["security"]))
    expect(selection.rule).toBe("all")
    expect(selection.dropped).toBe(0)
    expect(selection.shown).toEqual(collected.anchors)
  })

  test("with no plan the drop is pure recency — the behaviour that predates the plan channel", () => {
    const collected = { calls: 30, anchors: many(30, ["security"]), withoutDecision: 0 }
    const selection = selectAnchors(collected)
    expect(selection.rule).toBe("recency")
    expect(selection.shown).toEqual(collected.anchors.slice(-MAX_ANCHORS))
    expect(selection.dropped).toBe(30 - MAX_ANCHORS)
  })

  test("an unreadable plan does not silently switch the rule to dimension ranking", () => {
    // A refusal to read the plan is "no plan" for ordering purposes, and the block must say
    // recency rather than claiming a ranking it could not compute.
    const collected = { calls: 30, anchors: many(30, ["security"]), withoutDecision: 0 }
    const broken = { ok: false as const, error: { code: "GP_E_RUN_PLAN_READ", message: "m", remedy: "r" } }
    const selection = selectAnchors(collected, broken)
    expect(selection.rule).toBe("recency")
    expect(selection.shown).toEqual(collected.anchors.slice(-MAX_ANCHORS))
  })

  test("history of a dimension this run never planned goes first, even when it is the newest", () => {
    // The load-bearing case: recency alone would keep the last MAX_ANCHORS anchors, which here
    // are all `stray` (planned by nobody). Ranking must cost those five first and keep the older
    // planned history instead — which is exactly "优先压缩无关维度历史", and nothing else in this
    // file expresses it.
    const collected = {
      calls: MAX_ANCHORS + 5,
      anchors: many(MAX_ANCHORS + 5, ["security", "security", "security", "security", "stray"]),
      withoutDecision: 0,
    }
    const selection = selectAnchors(collected, planFor(["security"]))
    expect(selection.rule).toBe("dimension")
    expect(selection.dropped).toBe(5)
    expect(selection.unplannedDropped).toBe(5)
    expect(selection.shown.every((anchor) => anchor.dimension === "security")).toBe(true)
    // Survivors stay in transcript order; a reordered block would read as a different session.
    const indices = transcriptOrder(selection.shown)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  test("unattributed history is dropped only after unrelated history", () => {
    // 30 anchors over 25 slots: 6 of a dimension nobody planned, 6 with no recorded dimension,
    // 18 planned. Ten have to go, and the order is the scenario's: unplanned first, then
    // unattributed, planned last. A flat recency rule would instead keep the newest six —
    // which here are precisely the unplanned and unattributed ones.
    const collected = {
      calls: 30,
      anchors: many(30, ["security", "security", "security", "stray", undefined]),
      withoutDecision: 0,
    }
    const selection = selectAnchors(collected, planFor(["security"]))
    expect(selection.rule).toBe("dimension")
    expect(selection.dropped).toBe(10)
    expect(selection.unplannedDropped).toBe(6)
    expect(selection.shown.filter((anchor) => anchor.dimension === undefined).length).toBe(2)
    expect(selection.shown.filter((anchor) => anchor.dimension === "security").length).toBe(18)
    expect(selection.shown.some((anchor) => anchor.dimension === "stray")).toBe(false)
    // The two ranks that survive have to be handed back in transcript order, not rank order: the
    // unattributed pair here sits at indices 24 and 29, so a rank-ordered block would open with
    // them and put the session's earliest planned calls at the end.
    const indices = transcriptOrder(selection.shown)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
    expect(indices.slice(0, 2)).toEqual([0, 1])
  })

  test("the block names the rule it used, and never claims recency when it did not", () => {
    const stray = { calls: MAX_ANCHORS + 5, anchors: many(MAX_ANCHORS + 5, ["security", "stray"]), withoutDecision: 0 }
    const ranked = renderAnchorBlock(stray, planFor(["security"])) ?? ""
    expect(ranked).toContain("dropped by review dimension")
    expect(ranked).not.toContain("showing the most recent")

    const plain = renderAnchorBlock(stray) ?? ""
    expect(plain).toContain("showing the most recent")
    expect(plain).not.toContain("dropped by review dimension")
  })

  test("a plan that names no dimensions leaves the ranking on recency", () => {
    // `ids: []` is a plan document the kernel accepts only as an empty set; either way there is
    // no "unrelated" to compute, and inventing one would rank against nothing.
    const collected = { calls: 30, anchors: many(30, ["security", "stray"]), withoutDecision: 0 }
    const selection = selectAnchors(collected, planFor([]))
    expect(selection.rule).toBe("recency")
  })
})


