import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseEvidencePack,
  parseDecisionLogEntry,
  parseRecipeConfig,
} from "@iterate/kernel";

import { canonicalJson } from "../dist/canonical.js";
import { TOOL_BY_NAME, executeTool } from "../dist/tools.js";
import { makeEngine } from "./helpers.mjs";

/**
 * C28/C35 consumer consistency (spec v3.0 §21–§22, R33/R34).
 *
 * The MCP shell is a real kernel consumer: at runtime its glue
 * (gp_last_evidence → parseEvidenceFrame → kernel parseEvidencePack →
 * canonicalJson) is the boundary where a Swift↔TS schema drift surfaces as
 * GP_E_INTERNAL ("assertion C35"). This suite reads the SAME truth fixtures
 * the kernel and the engine-side Swift tests consume, and runs three layers:
 *
 *   kernel-api      — fixture parses through the kernel API and re-encodes
 *                     canonically through the shell's own canonicalizer;
 *   consumer-glue   — evidence fixtures survive the gp_last_evidence tool
 *                     path end to end without drift;
 *   failure triage  — a failed assertion attributes to one of
 *                     kernel-api / consumer-glue / fixture-upstream (R34).
 *
 * fixture-upstream means the fixture itself cannot be read (missing/broken
 * file) — validation of the shared truth set, not of any consumer.
 */

function fixture(relativePath) {
  return JSON.parse(
    readFileSync(new URL(`../../kernel/fixtures/${relativePath}`, import.meta.url), "utf8"),
  );
}

const FIXTURE_MATRIX = [
  { file: "evidence-pack.ok-01.json", parse: parseEvidencePack },
  { file: "evidence-pack.ok-02.json", parse: parseEvidencePack },
  { file: "decision-log-entry.ok-01.json", parse: parseDecisionLogEntry },
  { file: "recipe-config.ok-01.json", parse: parseRecipeConfig },
];

const EVIDENCE_FIXTURES = ["evidence-pack.ok-01.json", "evidence-pack.ok-02.json"];

/* ------------------------------------------------------------------ *
 * Layer 1 — kernel API: parse → canonicalize → compare fixture form.
 * ------------------------------------------------------------------ */

for (const { file, parse } of FIXTURE_MATRIX) {
  test(`kernel-api ${file}: kernel parse roundtrips canonically through the shell canonicalizer`, () => {
    const value = fixture(file);
    const parsed = parse(value);
    assert.equal(canonicalJson(parsed), canonicalJson(value));
  });
}

/* ------------------------------------------------------------------ *
 * Layer 2 — consumer glue: gp_last_evidence end to end on truth fixtures.
 * ------------------------------------------------------------------ */

for (const file of EVIDENCE_FIXTURES) {
  test(`consumer-glue ${file}: gp_last_evidence end-to-end preserves the fixture canonical form`, async () => {
    const { engine, io } = makeEngine();
    const value = fixture(file);
    const tool = TOOL_BY_NAME.get("gp_last_evidence");
    const promise = executeTool(tool, {}, engine);
    // The daemon wraps the pack body in the last_evidence result frame.
    io.respond({ evidencePack: value });
    const outcome = await promise;
    assert.equal(outcome.isError, false);
    assert.equal(outcome.content.length, 1);
    assert.equal(outcome.content[0].text, canonicalJson({ evidencePack: value }));
  });
}

/* ------------------------------------------------------------------ *
 * Layer 3 — failure attribution (R34): kernel-api / consumer-glue /
 * fixture-upstream each fails with a distinguishable, attributable shape.
 * ------------------------------------------------------------------ */

test("failure/kernel-api: a schema-violating pack body fails zod with the C35 remedy", async () => {
  const { engine, io } = makeEngine();
  const tool = TOOL_BY_NAME.get("gp_last_evidence");
  const promise = executeTool(tool, {}, engine);
  io.respond({ evidencePack: { operationId: "bad" } });
  const outcome = await promise;
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_INTERNAL"));
  // zod-level attribution: the issue names the missing pack field.
  assert.ok(outcome.content[0].text.includes("schemaVersion"));
  assert.ok(outcome.content[0].text.includes("assertion C35"));
});

test("failure/consumer-glue: a structurally broken frame fails the shell envelope check", async () => {
  const { engine, io } = makeEngine();
  const tool = TOOL_BY_NAME.get("gp_last_evidence");
  const promise = executeTool(tool, {}, engine);
  io.respond({ evidencePack: "not-an-object" });
  const outcome = await promise;
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_INTERNAL"));
  // glue-level attribution: the envelope guard, not the pack schema, rejects.
  assert.ok(outcome.content[0].text.includes("missing evidencePack field"));
});

test("failure/fixture-upstream: an unreadable fixture surfaces as an upstream read error", () => {
  // Triage boundary: a broken shared fixture must fail loudly at read time
  // (ENOENT), never masquerade as a consumer regression.
  assert.throws(() => fixture("evidence-pack.does-not-exist.json"));
});