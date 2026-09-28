import type { Hooks, PluginInput } from "@opencode-ai/plugin"

import { logDecision, readEvidenceFrame } from "../tool/glasspane/kernel"

/**
 * M2 — the fork's evidence plugin: every `gp_*` call that comes back carrying a
 * real evidence pack gets one decision-log entry, written through the kernel's
 * chain (`kernel.ts`, vendored kernel in `vendor/kernel`).
 *
 * Why it lives here rather than inside each tool: the tools' job is to answer
 * the model, and their tests assert that answer. A ledger is a *record of the
 * run*, so it must not be able to change the answer — the hooks run against the
 * same mutable `output` object the model reads, and this plugin only ever adds
 * `metadata.decisionLog`, never `output`. The failure mode being designed
 * against is an audit trail that quietly alters what was verified.
 *
 * What this module is forbidden to do:
 *  - decide anything. Outcome and summary come from the pack via the kernel's
 *    transcription; the engine already attributed and diagnosed.
 *  - assume which engine methods emit a pack. It doesn't keep a list — a list
 *    would go stale the way the hard-coded capability list did (`audit_ui` and
 *    `capture_view` both arrived after). If a frame has no `evidencePack`, there
 *    is nothing to record, and that is reported, not guessed.
 *  - write into the engine's state root, or silently skip a failed write. Both
 *    are refused/reported by `kernel.ts`, and the report is put where the model
 *    can see it: metadata alone is invisible to a model (measured in
 *    `harness/spike`: the model reads `output`, so a remedy that lives only in
 *    `metadata` is not delivered).
 *
 * Disabling is upstream's own switch (`OPENCODE_DISABLE_DEFAULT_PLUGINS`), which
 * gates every internal plugin at `plugin/index.ts`; there is no second,
 * plugin-private off button.
 */

const GLASSPANE_TOOL_PREFIX = "gp_"

/** What the ledger said, mirrored into the tool result so it is auditable later. */
export type DecisionLogNote =
  | { status: "logged"; path: string; sequence: number; hash: string; outcome: string; line: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; code: string; message: string; remedy: string }

/**
 * The hook body, exported separately so the fixed-point tests can drive it
 * without standing up a plugin host. Returns the note it attached (undefined when
 * the call was not ours to record at all).
 */
export function recordToolExecution(
  input: { tool: string; sessionID: string; callID: string },
  output: { title: string; output: string; metadata: unknown },
  env: NodeJS.ProcessEnv = process.env,
): DecisionLogNote | undefined {
  if (!input.tool.startsWith(GLASSPANE_TOOL_PREFIX)) return undefined

  const metadata = output.metadata as
    | { ok?: boolean; method?: string; code?: string; message?: string; remedy?: string; result?: unknown }
    | undefined

  // A failed tool call is not a decision about the app — the engine never got to
  // produce evidence. Recording "fail" here would mix transport failures into
  // the audit chain that is supposed to say what the interface did.
  if (!metadata || metadata.ok !== true) {
    return { status: "skipped", reason: `gp call did not succeed (${metadata?.code ?? "no metadata"})` }
  }

  const read = readEvidenceFrame(metadata.result)
  if (!read.ok) {
    // `GP_E_NO_EVIDENCE` is the ordinary case for tools that return a status
    // rather than a pack (gp_attach, gp_probe_status, gp_shutdown).
    if (read.error.code === "GP_E_NO_EVIDENCE") {
      return { status: "skipped", reason: "this gp_* method returns no evidence frame" }
    }
    return { status: "failed", ...read.error }
  }

  const logged = logDecision(read.pack, {
    env,
    extraSummary: `${input.tool} in session ${input.sessionID}`,
  })
  if (!logged.ok) return { status: "failed", ...logged.error }
  return {
    status: "logged",
    path: logged.logged.path,
    sequence: logged.logged.entry.sequence,
    hash: logged.logged.hash,
    outcome: logged.logged.entry.outcome,
    line: logged.logged.line,
  }
}

/** Line appended to `output` when a ledger write could not be trusted. */
export function decisionLogWarning(note: DecisionLogNote): string | undefined {
  if (note.status !== "failed") return undefined
  return `decision log NOT written: ${note.code} — ${note.message} remedy: ${note.remedy}`
}

export async function GlasspaneDecisionLogPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "tool.execute.after": async (toolInput, toolOutput) => {
      const note = recordToolExecution(
        { tool: toolInput.tool, sessionID: toolInput.sessionID, callID: toolInput.callID },
        toolOutput,
      )
      if (!note) return
      const target = toolOutput as unknown as { metadata?: Record<string, unknown> }
      if (target.metadata && typeof target.metadata === "object") {
        target.metadata.decisionLog = note
      }
      const warning = decisionLogWarning(note)
      if (warning) {
        // Visible to the model, because a silently-absent audit entry is exactly
        // the failure the ledger exists to prevent. It is appended, never
        // substituted: the tool's own conclusion must survive.
        toolOutput.output = `${toolOutput.output}\n${warning}`
      }
    },
  }
}
