/**
 * kernel.ts — the fork's only doorway to `iterate-kernel` (M3), plus the
 * decision-ledger plumbing the evidence plugin builds on (M2).
 *
 * WHY ONE FILE. Everything that touches the shared kernel goes through this module,
 * so the kernel's delivery form is somebody else's decision. It used to be vendored
 * source under `packages/opencode/vendor/kernel`, pinned per file by
 * `script/kernel-vendor.mjs`, because the recorded release policy was "not published
 * separately; consumers inline it" (P6 §13, P4 §33.2). That policy was reversed on the
 * iterate side: the kernel is `iterate-kernel` on npm, and this file now resolves it as
 * a semver dependency (the pinned version is whatever `contracts/kernel-pin.json` says — 0.1.7 as this line was written 2026-10-14, and the number lives in that file, not here). The switch was
 * one import line here — which is the claim this comment used to make as a hope and can
 * now make as a fact.
 *
 * WHAT THIS MODULE MAY NOT DO. It transcribes; it never judges. The outcome and
 * the summary it reports come from `decisionOutcomeFromEvidence` /
 * `decisionSummaryFromEvidence` *in the kernel*, which themselves only read
 * fields the Swift engine already decided. No attribution, no threshold, no
 * "looks fine" logic may be added here — that is the architecture iron law, and
 * the reason the mapping lives in the kernel rather than in each shell.
 *
 * The ledger location rule is here too, and it is a refusal, not a fallback:
 * the engine owns `~/.glasspane`. A harness ledger inside another process's
 * state root is how `projects.json` ended up with two writers (the TS/Swift
 * double-write that produced audit findings B-1 and A-15 — one defect, two
 * copies, fixed twice).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { Global } from "@opencode-ai/core/global"

import { stateRootOf } from "./daemon"

// Per-module imports, NOT the kernel's `index` barrel — and that is a product
// requirement, not a style choice. The barrel re-exports `schemas`, which loads the
// three JSON Schemas at module init through `createRequire(import.meta.url)`: a
// *runtime file read* next to the module. That works from a directory install and
// cannot work in the single-file binary the release ships — the product died at
// startup with `Cannot find module '../schemas/evidence-pack.schema.json'`, found by
// script/build.ts's own smoke test. Every export used below lives in its own subpath
// export (`iterate-kernel/parse` and friends), and `schemas` is reachable only through
// the barrel, which we do not import. `test/tool/glasspane-kernel.test.ts` pins that
// this import shape stays this way; `script/kernel-pin.mjs` pins the version and the
// contract corpus we resolve against.
import { KernelSchemaError } from "iterate-kernel/errors"
import type { EvidencePack } from "iterate-kernel/evidence-pack"
import { decisionOutcomeFromEvidence, decisionSummaryFromEvidence } from "iterate-kernel/evidence-decision"
import {
  appendDecisionLogEntry,
  decisionLogEntryHash,
  newDecisionEntryId,
  readDecisionLog,
  verifyDecisionLogText,
  KernelDecisionLogError,
} from "iterate-kernel/decision-log"
import type { DecisionLogEntry, DecisionOutcome } from "iterate-kernel/decision-log-entry"
import { parseEvidencePackRead, parseRunPlan } from "iterate-kernel/parse"
import { plannedIds, runPlanDigest } from "iterate-kernel/run-plan"
import { dimensionContext, formatDimensionContext, DIMENSION_ID_MAX_LENGTH, DIMENSION_ID_PATTERN } from "iterate-kernel/dimension-context"
import type {
  DimensionContext,
  DimensionContextInput,
  DimensionStatus,
} from "iterate-kernel/dimension-context"

export type { DecisionLogEntry, DecisionOutcome, EvidencePack }
export type { DimensionContext, DimensionContextInput, DimensionStatus }

/**
 * The dimension coverage of a run, computed by the kernel (M4).
 *
 * WHY THIS IS A PASS-THROUGH AND NOT A WRAPPER. The arithmetic — which planned
 * dimensions the engine actually recorded a decision for, and which recorded
 * dimensions nobody planned — is the kernel's, so both shells report the same
 * numbers for the same run. This module's only job is to make the kernel's
 * function reachable under the subpath import the product binary requires (see
 * the barrel note above) and to re-export its types.
 *
 * The dimension ids are NOT defined here either. The kernel validates their
 * shape and never enumerates them; the nine canonical ids belong to the iterate
 * config, locked across six sources by `tests/test_dimension_lock.py`. A
 * session that was never told which dimensions it was reviewing still gets an
 * answer — one that says nothing was verified, which is the point.
 */
export function dimensionCoverage(input: DimensionContextInput): DimensionContext {
  return dimensionContext(input)
}

/** The one-line form for a compaction block or report header. */
export function describeDimensionCoverage(context: DimensionContext): string {
  return formatDimensionContext(context)
}

/** The three-field failure shape every tool surface in this repo already uses. */
export interface KernelRejection {
  readonly code: string
  readonly message: string
  readonly remedy: string
}

export interface LedgerRef {
  readonly path: string
  readonly source: "env" | "default"
}

/**
 * The daemon's evidence frame is `{evidencePack: {…}}` (`Dispatcher.swift:156`).
 * The envelope is checked here; the body goes to the kernel's **read-side**
 * parser, which still accepts archives the engine legitimately wrote before the
 * schema froze. The label measured off the wire is returned alongside, because
 * folding it silently would make the harness claim a conformance the bytes do
 * not have (the same B-09 lesson mcp-shell encodes at `tools.ts:780-803`).
 */
export function readEvidenceFrame(
  frame: unknown
): { ok: true; pack: EvidencePack; measuredSchemaVersion: string } | { ok: false; error: KernelRejection } {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return {
      ok: false,
      error: {
        code: "GP_E_EVIDENCE_FRAME",
        message: "the engine reply is not an object, so no evidence pack can be read from it",
        // Non-circular on purpose. The frame that lands here can be the reply of
        // `gp_last_evidence` itself, and telling the agent to call that and pass its
        // reply would send it back to the call that just failed. What is still
        // executable is reading the engine's own self-report and recording the absence.
        remedy: "run gp_probe_status once and cite its reply beside this operation, then report this call as having produced no evidence — re-issuing the call is not the next step, because it is the frame it answered with that cannot be read",
      },
    }
  }
  const body = (frame as Record<string, unknown>).evidencePack
  if (body === undefined) {
    return {
      ok: false,
      error: {
        code: "GP_E_NO_EVIDENCE",
        message: "the reply carries no evidencePack field",
        remedy: "this operation produced no evidence frame — gp_last_evidence returns the most recent pack the engine actually archived",
      },
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      error: {
        code: "GP_E_EVIDENCE_FRAME",
        message: "the evidencePack field is not an object",
        remedy: "do not retry blindly: the engine emitted a frame this contract cannot read, so report it with gp_diagnose",
      },
    }
  }
  try {
    const pack = parseEvidencePackRead(body)
    const measured = (body as Record<string, unknown>).schemaVersion
    return { ok: true, pack, measuredSchemaVersion: typeof measured === "string" ? measured : pack.schemaVersion }
  } catch (error) {
    if (error instanceof KernelSchemaError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: `${error.message} — the kernel's read-side contract refused the engine's frame`,
          remedy: "Swift and TypeScript have drifted out of agreement (C35): run gp_probe_status and keep its reply beside this entry, then leave this call's dimension unverified in whatever you report — re-issuing the call cannot make the two agree",
        },
      }
    }
    throw error
  }
}

export function outcomeOf(pack: EvidencePack): DecisionOutcome {
  return decisionOutcomeFromEvidence(pack)
}

export function summaryOf(pack: EvidencePack): string {
  return decisionSummaryFromEvidence(pack)
}

/** The engine's own state root, which the harness must not write into. */
type StateRoot = { ok: true; path: string } | { ok: false; error: KernelRejection }

/**
 * One rule, one place: the answer comes from the same resolution the transport uses
 * to decide which daemon it is calling (`daemon.ts`'s `resolveSocket`), because a
 * second copy here is how the harness ended up treating its own working directory as
 * the engine's state root when `GLASSPANE_SOCKET` named a relative file — refusing
 * every ledger path inside a directory the engine never wrote to, while talking to a
 * daemon that lives somewhere else. An unusable setting is a refusal, not a guess.
 */
function engineStateRoot(env: NodeJS.ProcessEnv): StateRoot {
  return stateRootOf(env)
}

/** Whether one resolved path is the engine's root or something under it. */
function insideStateRoot(candidate: string, state: string): boolean {
  return candidate === state || candidate.startsWith(state + path.sep)
}

/**
 * Where the decision ledger lives. `GLASSPANE_DECISION_LOG` must be absolute and
 * outside the engine's state root; with no override, the fork's own data
 * directory is used (the same `Global.Path.data` every other persisted
 * opencode artifact uses — never the CWD, which is how a "harness state file"
 * ends up committed inside someone's repository).
 *
 * The engine-root guard runs on BOTH branches, and the refusal names the root it
 * measured rather than a spelled-in-home `~/.glasspane` — a `GLASSPANE_SOCKET`
 * elsewhere moves the engine's tree, and a remedy pointing at a directory that is not
 * the one being refused sends the reader to the wrong tree. The default path is not
 * outside the engine's root by definition: it is outside it by today's
 * `XDG_DATA_HOME`, so an operator who points the state root at the harness's own data
 * directory would otherwise get a second writer in it without a check firing.
 */
export function resolveLedger(env: NodeJS.ProcessEnv = process.env): { ok: true; ledger: LedgerRef } | { ok: false; error: KernelRejection } {
  const state = engineStateRoot(env)
  if (!state.ok) return state
  const override = env.GLASSPANE_DECISION_LOG
  if (typeof override === "string" && override.length > 0) {
    if (!path.isAbsolute(override)) {
      return {
        ok: false,
        error: {
          code: "GP_E_DECISION_LOG_PATH",
          message: `GLASSPANE_DECISION_LOG='${override}' is not absolute`,
          remedy: "point it at an absolute path (e.g. /Users/you/.local/state/glasspane-harness/decisions.jsonl); a relative one lands wherever the agent happened to be",
        },
      }
    }
    const resolved = path.resolve(override)
    if (insideStateRoot(resolved, state.path)) {
      return {
        ok: false,
        error: {
          code: "GP_E_DECISION_LOG_PATH",
          message: `GLASSPANE_DECISION_LOG='${resolved}' is inside the engine's state root ${state.path}`,
          remedy: `choose a path outside ${state.path} (the engine's state root — ~/.glasspane unless GLASSPANE_SOCKET names another) — the engine owns that tree, and a second writer in it is the projects.json failure all over again`,
        },
      }
    }
    return { ok: true, ledger: { path: resolved, source: "env" } }
  }
  const fallback = path.join(Global.Path.data, "glasspane-harness", "decisions.jsonl")
  if (insideStateRoot(fallback, state.path)) {
    return {
      ok: false,
      error: {
        code: "GP_E_DECISION_LOG_PATH",
        message: `the harness's default ledger location '${fallback}' is inside the engine's state root ${state.path}`,
        remedy: `the engine's state root and the harness's data directory are the same tree — move GLASSPANE_SOCKET, or point GLASSPANE_DECISION_LOG at a path outside ${state.path}`,
      },
    }
  }
  return { ok: true, ledger: { path: fallback, source: "default" } }
}

export interface LoggedDecision {
  readonly entry: DecisionLogEntry
  readonly hash: string
  readonly line: number
  readonly path: string
}

/** What the tool surface accepts as a declared review dimension. */
export const DIMENSION_ID_LIMITS = {
  pattern: DIMENSION_ID_PATTERN,
  maxLength: DIMENSION_ID_MAX_LENGTH,
}

/**
 * Validate one declared dimension.
 *
 * WHY THIS EXISTS AT ALL. `dimensionContext` counts a planned dimension as verified only
 * when a recorded decision carries that id, and the recorder here is the tool call: an
 * agent says which dimension a call was serving, the shell echoes it into the tool
 * result's metadata, and compaction turns the pair into "2/3 verified". Only a call whose
 * engine reply carries an evidence pack produces the decision half of that pair — today
 * that is `last_evidence` and nothing else (`Dispatcher.swift:156`) — so a dimension
 * declared on `gp_act`, `gp_observe`, `gp_attach` or `gp_diagnose` is recorded nowhere and
 * its dimension stays reported unverified. The shape is validated for every method that
 * accepts it, because a declaration that reaches the ledger malformed is the lying case;
 * an honest but unread one is merely blind — which is exactly why the absence is accepted.
 * A declared-but-malformed id is not: it would be counted as an *unplanned* dimension, and
 * a typo that silently renames a dimension is a false statement about what this session
 * covered.
 *
 * The shape is the kernel's, not a local guess: `DIMENSION_ID_PATTERN` is what
 * `PlannedDimensionSchema` validates plan ids against, so a plan and a declaration cannot
 * be spelled two ways. What the id *means* still belongs to whoever configured the run —
 * this refuses malformed tokens, it does not know or check the nine canonical names.
 */
export function validateDimension(
  value: unknown
): { ok: true; dimension?: string } | { ok: false; error: KernelRejection } {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== "string") {
    return {
      ok: false,
      error: {
        code: "GP_E_DIMENSION",
        message: `dimension must be a string, got ${typeof value}`,
        remedy: "pass one kebab-case id like 'security' or 'spec-compliance', or omit the argument",
      },
    }
  }
  if (value.length > DIMENSION_ID_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        code: "GP_E_DIMENSION",
        message: `dimension '${value}' is ${value.length} characters, over the kernel's ${DIMENSION_ID_MAX_LENGTH}`,
        remedy: "shorten the id; it is a dimension name, not a description of what was checked",
      },
    }
  }
  if (!DIMENSION_ID_PATTERN.test(value)) {
    return {
      ok: false,
      error: {
        code: "GP_E_DIMENSION",
        message: `dimension '${value}' is not a kebab-case id`,
        remedy: "lowercase letters, digits and single hyphens (the same shape the run plan uses); 'Spec Compliance' and 'spec_compliance' are both refused and neither would ever match a planned dimension",
      },
    }
  }
  return { ok: true, dimension: value }
}

/**
 * The accessibility role `gp_act` is about to be authorized under.
 *
 * `gp_act`'s permission pattern is `act:<role>:<action>`, and `Wildcard.match` reads the
 * *stored rule's* pattern as the glob — so the role is not only a selector for the engine, it
 * is half of the key the authorization decision is looked up by. A role of `*` matches an
 * allow rule the user granted for a different element; a `:` moves the boundary between the
 * role and the action, so `role: "AXButton:press\", {action:"*"` reads as a different request
 * than the one being made. No AX role contains either character, so refusing them costs no
 * legitimate call. This is argument validation, not judgement: the engine still decides
 * whether the action happened.
 */
const SELECTOR_FORBIDDEN = /[*?:[\]\\]/

export function validateSelector(role: string): { ok: true } | { ok: false; error: KernelRejection } {
  if (!SELECTOR_FORBIDDEN.test(role)) return { ok: true }
  return {
    ok: false,
    error: {
      code: "GP_E_SELECTOR",
      message: `selector.role '${role}' would change which permission rule gp_act is evaluated against`,
      remedy:
        "pass the role exactly as the observed tree reports it (e.g. 'AXButton'); '*', '?', '[' ']' ':' and '\\\\' are glob or separator characters inside the permission pattern 'act:<role>:<action>'",
    },
  }
}

/**
 * The run plan this session was configured with, read through the kernel.
 *
 * WHY A FILE AND NOT AN ENVIRONMENT VALUE FULL OF IDS. The plan is not one string:
 * it is ids, optional labels, per-dimension focus text, and a declared source, and
 * `dimensionContext` refuses to invent any of it. Whoever configures the run owns
 * that vocabulary (locked across six sources by `test_dimension_lock.py` on the
 * iterate side); this side only reads what it was handed. `GLASSPANE_RUN_PLAN` is
 * therefore a path, following the same rule as `GLASSPANE_DECISION_LOG`: absolute,
 * and outside the engine's state root, because a second writer in `~/.glasspane` is
 * the projects.json failure again.
 *
 * WHY ABSENT IS NOT AN ERROR. A session that was never given a plan has no coverage
 * to claim, and `renderDimensionCoverage` says exactly that. Silently substituting a
 * default plan would render "0/9 verified" against a plan nobody ran — a number that
 * looks like a measurement. So the refusal shape is reserved for a plan that WAS
 * declared and cannot be honoured: unreadable, or not conforming to the contract.
 */
export interface RunPlanRef {
  readonly path: string
  readonly digest: string
  readonly ids: readonly string[]
}

export function readRunPlan(
  env: NodeJS.ProcessEnv = process.env
): { ok: true; plan: RunPlanRef | null } | { ok: false; error: KernelRejection } {
  const override = env.GLASSPANE_RUN_PLAN
  if (typeof override !== "string" || override.length === 0) return { ok: true, plan: null }
  if (!path.isAbsolute(override)) {
    return {
      ok: false,
      error: {
        code: "GP_E_RUN_PLAN_PATH",
        message: `GLASSPANE_RUN_PLAN='${override}' is not absolute`,
        remedy: "point it at an absolute path to the plan file the runner wrote (iterate-harness writes one with `write_run_plan`); a relative one is read wherever the agent happened to be",
      },
    }
  }
  const state = engineStateRoot(env)
  if (!state.ok) return state
  const resolved = path.resolve(override)
  if (insideStateRoot(resolved, state.path)) {
    return {
      ok: false,
      error: {
        code: "GP_E_RUN_PLAN_PATH",
        message: `GLASSPANE_RUN_PLAN='${resolved}' is inside the engine's state root ${state.path}`,
        remedy: `choose a path outside ${state.path} (the engine's state root — ~/.glasspane unless GLASSPANE_SOCKET names another) — the engine owns that tree, and the plan belongs to whoever configured the run`,
      },
    }
  }
  let raw: string
  try {
    raw = readFileSync(resolved, "utf8")
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "GP_E_RUN_PLAN_READ",
        message: `cannot read the run plan at ${resolved} (${(error as Error).message})`,
        remedy: "write the plan before the session starts, or unset GLASSPANE_RUN_PLAN so coverage is reported as unplanned rather than half-read",
      },
    }
  }
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "GP_E_RUN_PLAN_JSON",
        message: `${resolved} is not JSON (${(error as Error).message})`,
        remedy: "the plan file is the kernel's `iterate.run-plan/0.1` document; emit it with JSON.stringify, not as YAML or prose",
      },
    }
  }
  try {
    const plan = parseRunPlan(document)
    return { ok: true, plan: { path: resolved, digest: runPlanDigest(plan), ids: plannedIds(plan) } }
  } catch (error) {
    if (error instanceof KernelSchemaError) {
      return {
        ok: false,
        error: {
          code: "GP_E_RUN_PLAN_SCHEMA",
          message: `${resolved} is not a run plan the kernel accepts (${error.issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ")})`,
          remedy: "regenerate the plan from the config it came from; do not hand-edit it — the digest both shells compare is computed over these exact bytes",
        },
      }
    }
    throw error
  }
}

/**
 * The ledger's `createdAt`, as one named function so its shape is testable.
 *
 * The kernel's schema demands `…T{HH}:{mm}:{ss}.{ms}Z` — three digits, any value — and
 * `Date#toISOString` always emits exactly that. This used to overwrite those three digits
 * with `000`, which the schema accepts but which is a *fabricated* field: it claimed a
 * precision the code had just thrown away, and two decisions taken in the same second
 * carried identical stamps, so the chain could not order them. The rule for this module is
 * transcribe, never invent.
 */
export function decisionStamp(at: Date): string {
  return at.toISOString()
}

/**
 * Append one decision for an evidence pack. The chain fields and the entry id
 * come from the kernel + ledger; the outcome and summary come from the pack. The
 * caller cannot supply either, which is what keeps two shells from writing the
 * same run two different ways.
 */
export function logDecision(
  pack: EvidencePack,
  options: { readonly env?: NodeJS.ProcessEnv; readonly extraSummary?: string } = {}
): { ok: true; logged: LoggedDecision } | { ok: false; error: KernelRejection } {
  const resolved = resolveLedger(options.env ?? process.env)
  if (!resolved.ok) return resolved
  const ledger = resolved.ledger.path
  const summary = options.extraSummary ? `${decisionSummaryFromEvidence(pack)}; ${options.extraSummary}` : decisionSummaryFromEvidence(pack)

  // The kernel refuses to create state directories; this module owns that step,
  // and owns it loudly (0700, because the file is an audit trail).
  try {
    mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 })
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "GP_E_DECISION_LOG_LOCATION",
        message: `cannot create ${path.dirname(ledger)} (${(error as Error).message})`,
        remedy: "point GLASSPANE_DECISION_LOG at a directory you can create, or fix the permissions on the harness data directory",
      },
    }
  }

  try {
    const appended = appendDecisionLogEntry(ledger, {
      entryId: newDecisionEntryId(),
      operationId: pack.operationId,
      summary: summary.slice(0, 2048),
      outcome: decisionOutcomeFromEvidence(pack),
      createdAt: decisionStamp(new Date()),
    })
    return {
      ok: true,
      logged: { entry: appended.entry, hash: appended.hash, line: appended.line, path: ledger },
    }
  } catch (error) {
    if (error instanceof KernelDecisionLogError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: `${error.message}${error.line !== undefined ? ` (line ${error.line})` : ""}`,
          remedy: error.remedy,
        },
      }
    }
    throw error
  }
}

/** Re-verify a ledger from disk. Used by the tool surface and by the fixed-point tests. */
export function verifyLedger(ledgerPath: string): { ok: boolean; entries: number; firstBrokenLine?: number; reason?: string } {
  if (!existsSync(ledgerPath)) return { ok: true, entries: 0 }
  const verified = readDecisionLog(ledgerPath)
  return {
    ok: verified.ok,
    entries: verified.entries.length,
    firstBrokenLine: verified.firstBrokenLine,
    reason: verified.reason,
  }
}

/** Re-exported so a consumer can prove a chain link without importing the kernel package directly. */
export const entryHashOf = decisionLogEntryHash
export const verifyLedgerText = verifyDecisionLogText
