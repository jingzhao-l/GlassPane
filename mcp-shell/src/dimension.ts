/**
 * dimension.ts — 面 A's declared review dimension, shape-checked by the kernel (场景② 的对称半边).
 *
 * WHY THIS FILE EXISTS. The fork surface (面 B) has carried this argument since the run-plan
 * work: an agent says which dimension a call was serving, the shell refuses a malformed id
 * before the daemon sees anything, strips the annotation from the engine frame, and echoes the
 * declaration back as its own content item. This shell is the other doorway to the same engine,
 * and until now it had no such slot — so a run driven through `glasspane-mcp` could not say what
 * a call was for, and the compaction account could only ever read coverage from the fork's own
 * calls. That asymmetry is the whole reason the dimension counter looked healthy in one harness
 * and empty in the other.
 *
 * WHAT THIS IS NOT. The shape comes from `iterate-kernel/dimension-context`
 * (`DIMENSION_ID_PATTERN` / `DIMENSION_ID_MAX_LENGTH`) — the same constants the run plan is
 * validated against — so a plan id and a declaration cannot be spelled two ways. Nothing here
 * knows what a dimension *means*: it refuses malformed tokens and never checks a name against a
 * list, because the list belongs to whoever configured the run.
 *
 * WHY A MALFORMED ID IS REFUSED AND AN ABSENT ONE IS NOT. `dimensionContext` counts a planned
 * dimension as verified only when a recorded decision carries that id. A declaration that reaches
 * the ledger malformed is therefore the lying case — it would be counted as an *unplanned*
 * dimension and silently rename what the session claims it covered. An honest but unread
 * declaration is merely blind, so absence is legitimate and means "this call served no declared
 * dimension"; compaction then reports that dimension as unverified rather than inventing one.
 *
 * Only `gp_last_evidence`'s reply carries an evidence pack, and a pack is what a decision is
 * recorded from (`Dispatcher.swift:156`), so a dimension declared on `gp_attach`, `gp_observe`,
 * `gp_act` or `gp_diagnose` records nothing and its dimension stays reported unverified. It is
 * still accepted and still echoed on those calls, for the reason in the paragraph above: a
 * refused-but-unreadable declaration is a lie, an echoed-but-unrecorded one is a fact the model
 * can see. The echo is a separate content item so `content[0]` stays the daemon's frame byte for
 * byte — the same rule the provider attribution line follows, and the reason the Python relay can
 * classify per item instead of reading a joined string.
 */

import { DIMENSION_ID_MAX_LENGTH, DIMENSION_ID_PATTERN } from "iterate-kernel/dimension-context";

import { GP_E_DIMENSION, type ToolErrorText } from "./errors.js";

/**
 * The advertised half of the kernel's rule, for the JSON Schemas in `tools.ts`.
 * `test/dimension.test.mjs` compares it against the published
 * `kernel/schemas/*.schema.json` and against 面 B's own copy, so no side can be tightened or
 * loosened alone.
 */
export const DIMENSION_ID_LIMITS = {
  pattern: DIMENSION_ID_PATTERN,
  maxLength: DIMENSION_ID_MAX_LENGTH,
} as const;

export function validateDimension(
  value: unknown,
): { ok: true; dimension?: string } | { ok: false; error: ToolErrorText } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string") {
    return {
      ok: false,
      error: {
        code: GP_E_DIMENSION,
        message: `dimension must be a string, got ${typeof value}`,
        remedy: "pass one kebab-case id like 'security' or 'spec-compliance', or omit the argument",
      },
    };
  }
  if (value.length > DIMENSION_ID_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        code: GP_E_DIMENSION,
        message: `dimension '${value}' is ${value.length} characters, over the kernel's ${DIMENSION_ID_MAX_LENGTH}`,
        remedy: "shorten the id; it is a dimension name, not a description of what was checked",
      },
    };
  }
  if (!DIMENSION_ID_PATTERN.test(value)) {
    return {
      ok: false,
      error: {
        code: GP_E_DIMENSION,
        message: `dimension '${value}' is not a kebab-case id`,
        remedy:
          "lowercase letters, digits and single hyphens (the same shape the run plan uses); " +
          "'Spec Compliance' and 'spec_compliance' are both refused and neither would ever match a planned dimension",
      },
    };
  }
  return { ok: true, dimension: value };
}

/**
 * Drop the shell-side annotation from what the daemon is asked to do. The engine has no
 * `dimension` parameter and never learns the word; exported so the fixed-point test can name the
 * invariant "the engine never sees our annotation" rather than infer it from a passing call.
 */
export function engineBody(params: Record<string, unknown>): Record<string, unknown> {
  const { dimension: _dimension, ...rest } = params;
  return rest;
}

/**
 * The echo line — one content item, its own prefix, and it claims only what this shell knows.
 * `none` is never printed: an undeclared call keeps the reply byte-identical.
 */
export function dimensionAttributionLine(dimension: string): string {
  return (
    `dimension: ${dimension} | declared by this call; this shell records no decision, so the` +
    " ledger gains an attribution only where a decision is written for this operation"
  );
}
