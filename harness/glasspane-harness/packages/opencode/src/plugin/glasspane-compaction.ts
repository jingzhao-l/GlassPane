import type { Hooks, PluginInput } from "@opencode-ai/plugin"

import { readEvidenceFrame } from "../tool/glasspane/kernel"

/**
 * M4 — the fork's compaction plugin: when a session that used the GlassPane tool
 * surface is compacted, the evidence anchors that surface produced are injected
 * back into the compaction prompt, so summarising cannot silently drop the
 * session's on-ramp into the decision-log audit chain.
 *
 * WHY THIS EXISTS. A `gp_*` session's meaning lives in four fields that prose
 * loses first: the operationId, the engine's outcome, and the ledger sequence +
 * entry hash (M2 writes those into `metadata.decisionLog`). Upstream compaction
 * summarises the conversation like any other; a summariser that keeps the story
 * but drops the hashes leaves a session whose claims can no longer be tied to
 * the chain. This hook is the fork-side half of 综述 §8.5's "上下文压缩钩子无法
 * 感知审查维度上下文" loss: the compression step must at least *know* what the
 * session verified.
 *
 * WHAT THIS MODULE MAY NOT DO.
 *  - It may not re-judge. Every anchor field is transcribed from something the
 *    engine wrote (`metadata.result`) or the kernel wrote (`decisionLog` note,
 *    chained through `kernel.ts`). No thresholds, no pass/fail synthesis, no
 *    "looks verified" — the iron law, same as M1/M2.
 *  - It may not invent dimensions. The kernel's dimension system
 *    (`dimensionContext()`, 综述 §8.5 / PRD §8.5) does not exist at this pin —
 *    it is an iterate-side roadmap item, and the vendored kernel's export
 *    surface was measured to confirm that (no dimension export). So M4 does not
 *    guess a dimension ontology: it preserves what exists (evidence anchors)
 *    and states absence by arithmetic (calls vs recorded decisions) rather than
 *    by prose that could go stale. When the kernel grows the API, the injection
 *    point below is where it gets wired — the seam is the hook, not a fake call.
 *  - It may not break compaction. A failed message pull appends a visible note
 *    and returns; it never throws into the host's compaction path, and it never
 *    replaces `output.prompt` (replacing it would silently discard the default
 *    summarisation instruction — appending is the only edit upstream's shape
 *    makes safe: `compacting.prompt ?? [...context]`).
 *
 * Upstream shape being coded against (`v1.18.32`, `session/compaction.ts:374`):
 * `trigger("experimental.session.compacting", { sessionID }, { context: [], prompt: undefined })`.
 * The hook receives only the session id, so the messages must be pulled — this
 * module therefore takes a `pull` function, and the host client lives in the
 * binding below, not in the logic.
 */

const GLASSPANE_TOOL_PREFIX = "gp_"
/** Anchors are a pointer into the chain, not a copy of it; the ledger keeps the rest. */
const MAX_ANCHORS = 20

/** One transcribed decision. Undefined fields were absent — never filled in by guessing. */
export type EvidenceAnchor = {
  method: string
  operationId?: string
  outcome?: string
  ledgerLine?: number
  ledgerHash?: string
  ledgerPath?: string
}

export type AnchorCollection = {
  /** gp_* calls that are settled history (completed or failed); a running part is not yet history. */
  calls: number
  /** Recorded decisions, in conversation order. */
  anchors: EvidenceAnchor[]
  withoutDecision: number
}

export type CompactionNote =
  | { status: "injected"; calls: number; anchors: number; target: "context" | "prompt"; block: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; code: string; message: string; remedy: string }

export type PullSessionMessages = (sessionID: string) => Promise<unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return text(error) ?? "unknown error"
}


/**
 * Walk a `client.session.messages` reply and transcribe the decisions it holds.
 * Pure: no client, no filesystem, no clock. Exported because the fixed-point
 * tests drive it with message fixtures rather than a live host.
 */
export function collectEvidenceAnchors(messages: unknown): AnchorCollection {
  const list = Array.isArray(messages) ? messages : []
  const anchors: EvidenceAnchor[] = []
  let calls = 0

  for (const item of list) {
    const parts = isRecord(item) && Array.isArray(item.parts) ? item.parts : []
    for (const part of parts) {
      if (!isRecord(part) || part.type !== "tool") continue
      const tool = text(part.tool)
      if (!tool?.startsWith(GLASSPANE_TOOL_PREFIX)) continue
      const state = isRecord(part.state) ? part.state : undefined
      const status = state ? text(state.status) : undefined
      // A pending/running part is a call that has not settled: at compaction time
      // it is not history yet and has no outcome to preserve.
      if (status !== "completed" && status !== "error") continue
      calls += 1
      if (status !== "completed" || !state) continue

      const metadata = isRecord(state.metadata) ? state.metadata : {}
      const method = text(metadata.method) ?? tool.slice(GLASSPANE_TOOL_PREFIX.length)
      const note = isRecord(metadata.decisionLog) ? metadata.decisionLog : undefined
      // The note is M2's ledger receipt. No receipt = the chain holds no entry for
      // this call (status-only method, or a call the engine refused) — that is
      // counted, not papered over with a guessed outcome.
      if (!note || note.status !== "logged") continue

      // operationId is the only field read from the pack itself; optional because
      // the receipt can outlive a body the kernel's read-side parser rejects.
      const read = readEvidenceFrame(metadata.result)
      anchors.push({
        method,
        operationId: read.ok ? read.pack.operationId : undefined,
        outcome: text(note.outcome),
        ledgerLine: numberOf(note.line),
        ledgerHash: text(note.hash),
        ledgerPath: text(note.path),
      })
    }
  }

  return { calls, anchors, withoutDecision: calls - anchors.length }
}

/**
 * Render the injected block, or `undefined` when the session never touched the
 * GlassPane surface (nothing to preserve, nothing to say). A session that *did*
 * touch it always gets a block — including "decisions recorded: 0", because an
 * absent record must be readable as absent, not left to be assumed absent.
 */
export function renderAnchorBlock(collected: AnchorCollection): string | undefined {
  if (collected.calls === 0) return undefined

  const shown = collected.anchors.slice(-MAX_ANCHORS)
  const omitted = collected.anchors.length - shown.length
  const lines = [
    "## GlassPane evidence anchors (M4)",
    "",
    "This session used the GlassPane tool surface. The lines below are transcribed verbatim",
    "from records the engine wrote and the kernel chained; this harness does not re-judge",
    "them, and nothing here is a verdict on the interface. Keep the anchors when",
    "summarising — they are the session's on-ramp into the decision-log audit chain.",
    "",
    `gp_* calls: ${collected.calls} · decisions recorded: ${collected.anchors.length} · without a decision record: ${collected.withoutDecision}`,
  ]
  if (collected.withoutDecision > 0) {
    lines.push(
      "- calls without a decision record are status-only or failed calls (not every engine method emits an evidence pack) — counted, not guessed",
    )
  }
  if (omitted > 0) {
    lines.push(`- showing the most recent ${shown.length} anchors; ${omitted} older anchor(s) omitted — the ledger below has the full chain`)
  }
  for (const anchor of shown) {
    const bits = [
      anchor.method,
      anchor.operationId ? `op ${anchor.operationId}` : undefined,
      anchor.outcome ? `outcome ${anchor.outcome}` : undefined,
      anchor.ledgerLine !== undefined ? `ledger #${anchor.ledgerLine}` : undefined,
      anchor.ledgerHash ? `entry sha256 ${anchor.ledgerHash.slice(0, 16)}…` : undefined,
    ].filter((bit): bit is string => bit !== undefined)
    lines.push(`- ${bits.join(" · ")}`)
  }
  if (collected.anchors.length === 0) {
    lines.push("- no decision-log entries were recorded in this session")
  }
  const ledgerPath = [...collected.anchors].reverse().find((anchor) => anchor.ledgerPath !== undefined)?.ledgerPath
  if (ledgerPath) lines.push("", `ledger: ${ledgerPath}`)
  return lines.join("\n")
}

/**
 * Where an appended block goes. Upstream computes
 * `nextPrompt = compacting.prompt ?? [defaultPrompt, ...compacting.context]`, so a
 * `prompt` someone else already set makes `context` dead letter. Append to the
 * prompt in that case (never replace it), and to context otherwise.
 *
 * Known boundary, stated rather than papered over: if another plugin sets
 * `prompt` *after* this hook runs, the context array it just wrote is dropped by
 * upstream's `??`. Nothing in this fork sets `prompt` (measured: no other plugin
 * or feature touches this hook), so today the context lane is the one that runs;
 * a future plugin that replaces the prompt must append its blocks itself.
 */
function appendBlock(output: { context: string[]; prompt?: string }, block: string): "context" | "prompt" {
  if (output.prompt !== undefined) {
    output.prompt = `${output.prompt}\n\n${block}`
    return "prompt"
  }
  output.context.push(block)
  return "context"
}

/**
 * The hook body, exported separately so the fixed-point tests can drive it with
 * a fake `pull`. Returns the note it produced; the host hook ignores the return.
 */
export async function injectEvidenceAnchors(
  sessionID: string,
  output: { context: string[]; prompt?: string },
  pull: PullSessionMessages,
): Promise<CompactionNote> {
  try {
    const messages = await pull(sessionID)
    const collected = collectEvidenceAnchors(messages)
    const block = renderAnchorBlock(collected)
    if (!block) return { status: "skipped", reason: "no gp_* tool calls in this session" }
    const target = appendBlock(output, block)
    return { status: "injected", calls: collected.calls, anchors: collected.anchors.length, target, block }
  } catch (error) {
    // An absent audit trail must be visible in the same place a present one
    // would have been. Compaction itself is never failed by this plugin.
    const message = `could not read this session's messages (${errorText(error)})`
    const remedy =
      "compact anyway (the chain is on disk), then check the harness client/server pair; anchors were NOT preserved in this summary"
    appendBlock(output, `GlassPane compaction note: evidence anchors NOT preserved — ${message}. remedy: ${remedy}`)
    return { status: "failed", code: "GP_E_COMPACTION_MESSAGES", message, remedy }
  }
}

export async function GlasspaneCompactionPlugin(input: PluginInput): Promise<Hooks> {
  return {
    "experimental.session.compacting": async (hookInput, output) => {
      await injectEvidenceAnchors(hookInput.sessionID, output, async (sessionID) => {
        const result = await input.client.session.messages({ path: { id: sessionID } })
        if (result.error !== undefined) throw new Error(describeSdkError(result.error))
        return result.data
      })
    },
  }
}

function describeSdkError(error: unknown): string {
  if (isRecord(error) && isRecord(error.data)) {
    const message = text(error.data.message)
    if (message) return `the host rejected the message pull: ${message}`
  }
  const message = isRecord(error) ? text(error.message) : undefined
  return `the host rejected the message pull: ${message ?? text(error) ?? "no message in the error payload"}`
}


