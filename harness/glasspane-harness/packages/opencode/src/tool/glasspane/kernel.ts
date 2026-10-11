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
 * a semver dependency (`0.1.2`, pinned by `contracts/kernel-pin.json`). The switch was
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
import os from "node:os"
import path from "node:path"

import { Global } from "@opencode-ai/core/global"

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
import { dimensionContext, formatDimensionContext } from "iterate-kernel/dimension-context"
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
        remedy: "call gp_last_evidence and pass its reply; if this repeats, run gp_probe_status and report the engine version",
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
          remedy: "Swift and TypeScript have drifted out of agreement (C35): capture gp_probe_status plus this reply and treat the run as unverified rather than retrying",
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
function engineStateRoot(env: NodeJS.ProcessEnv): string {
  const socket = env.GLASSPANE_SOCKET
  if (typeof socket === "string" && socket.length > 0) return path.dirname(path.resolve(socket))
  return path.join(env.HOME ?? os.homedir(), ".glasspane")
}

/**
 * Where the decision ledger lives. `GLASSPANE_DECISION_LOG` must be absolute and
 * outside the engine's state root; with no override, the fork's own data
 * directory is used (the same `Global.Path.data` every other persisted
 * opencode artifact uses — never the CWD, which is how a "harness state file"
 * ends up committed inside someone's repository).
 */
export function resolveLedger(env: NodeJS.ProcessEnv = process.env): { ok: true; ledger: LedgerRef } | { ok: false; error: KernelRejection } {
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
    const state = engineStateRoot(env)
    const resolved = path.resolve(override)
    if (resolved === state || resolved.startsWith(state + path.sep)) {
      return {
        ok: false,
        error: {
          code: "GP_E_DECISION_LOG_PATH",
          message: `GLASSPANE_DECISION_LOG='${resolved}' is inside the engine's state root ${state}`,
          remedy: "choose a path outside ~/.glasspane — the engine owns that tree, and a second writer in it is the projects.json failure all over again",
        },
      }
    }
    return { ok: true, ledger: { path: resolved, source: "env" } }
  }
  return { ok: true, ledger: { path: path.join(Global.Path.data, "glasspane-harness", "decisions.jsonl"), source: "default" } }
}

export interface LoggedDecision {
  readonly entry: DecisionLogEntry
  readonly hash: string
  readonly line: number
  readonly path: string
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
  const resolved = path.resolve(override)
  if (resolved === state || resolved.startsWith(state + path.sep)) {
    return {
      ok: false,
      error: {
        code: "GP_E_RUN_PLAN_PATH",
        message: `GLASSPANE_RUN_PLAN='${resolved}' is inside the engine's state root ${state}`,
        remedy: "choose a path outside ~/.glasspane — the engine owns that tree, and the plan belongs to whoever configured the run",
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
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
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
