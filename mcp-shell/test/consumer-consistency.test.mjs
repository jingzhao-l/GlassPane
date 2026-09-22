import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseEvidencePack,
  parseEvidencePackRead,
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
 * (gp_last_evidence → parseEvidenceFrame → kernel parse* → canonicalJson) is
 * the boundary where a Swift↔TS drift surfaces as GP_E_INTERNAL. This suite
 * reads the SAME truth fixtures the kernel and the engine-side Swift tests
 * consume, and runs three layers:
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
 *
 * The kernel offers two parsers on purpose: the strict write-side one (what
 * any pack the engine may store must satisfy) and the read-side one, which
 * additionally accepts the archives the engine itself produced before the
 * schema froze (legacy `0.1-draft` label, `pixelDiff.bounds` omitted instead of
 * null). Both are exercised here, because the shell's job is to let a user read
 * their own audit trail *and* to refuse off-contract bodies.
 */

function fixture(relativePath) {
  return JSON.parse(
    readFileSync(new URL(`../../kernel/fixtures/${relativePath}`, import.meta.url), "utf8"),
  );
}

const FIXTURE_MATRIX = [
  { file: "evidence-pack.ok-01.json", parse: parseEvidencePack },
  { file: "evidence-pack.ok-02.json", parse: parseEvidencePack },
  // R4-12: the P6 probe-carrying form is a truth fixture on both other sides;
  // leaving it out of this matrix meant the shell's glue never saw it.
  { file: "evidence-pack.ok-03.json", parse: parseEvidencePack },
  { file: "decision-log-entry.ok-01.json", parse: parseDecisionLogEntry },
  { file: "recipe-config.ok-01.json", parse: parseRecipeConfig },
];

/** Legacy archive shapes: readable through the shell, never writable. */
const READ_ONLY_EVIDENCE_FIXTURES = [
  "evidence-pack.ok-04-legacy-draft.json",
  "evidence-pack.ok-05-pixelbounds-null.json",
];

const EVIDENCE_FIXTURES = [
  "evidence-pack.ok-01.json",
  "evidence-pack.ok-02.json",
  "evidence-pack.ok-03.json",
  ...READ_ONLY_EVIDENCE_FIXTURES,
];

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

for (const file of READ_ONLY_EVIDENCE_FIXTURES) {
  test(`kernel-api(read) ${file}: the read path parses it, the write path refuses it`, () => {
    const value = fixture(file);
    assert.doesNotThrow(() => parseEvidencePackRead(value));
    // Nothing may be archived in a legacy shape: the strict parser still
    // rejects it, so the shell can read history without extending it.
    assert.throws(() => parseEvidencePack(value));
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
 * R4-16: "the pack body breaks the contract" and "the daemon never sent a
 * pack body" are different causes and must not share one remedy.
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
  // A body violation is not a dead daemon: no restart guidance on this path.
  assert.ok(!outcome.content[0].text.includes("restore-launchd"));
});

test("failure/consumer-glue: a structurally broken frame is not reported as fixture drift", async () => {
  const brokenFrames = [
    [{ evidencePack: "not-an-object" }, "evidencePack field is not an object"],
    [{ evidencePack: null }, "evidencePack field is not an object"],
    [{}, "missing evidencePack field in last_evidence result"],
  ];
  for (const [frame, detail] of brokenFrames) {
    const { engine, io } = makeEngine();
    const tool = TOOL_BY_NAME.get("gp_last_evidence");
    const promise = executeTool(tool, {}, engine);
    io.respond(frame);
    const outcome = await promise;
    assert.equal(outcome.isError, true);
    assert.ok(outcome.content[0].text.startsWith("GP_E_INTERNAL"));
    // glue-level attribution: the envelope guard, not the pack schema, rejects —
    // and it names which part of the envelope is wrong.
    assert.ok(
      outcome.content[0].text.includes("without an evidencePack object"),
      `frame ${JSON.stringify(frame)} must name the envelope as the cause`,
    );
    assert.ok(
      outcome.content[0].text.includes(detail),
      `frame ${JSON.stringify(frame)} must report "${detail}"`,
    );
    // The C35 remedy sent agents off to edit shared truth files that were never
    // involved; the frame carried no pack at all.
    assert.ok(!outcome.content[0].text.includes("assertion C35"));
    assert.ok(!outcome.content[0].text.includes("drifted"));
    // and the remedy it does carry is an executable one.
    assert.ok(outcome.content[0].text.includes("retry gp_last_evidence"));
    assert.ok(outcome.content[0].text.includes("restore-launchd"));
  }
});

test("consumer-glue keeps the legacy archive byte-for-byte in the agent's answer", async () => {
  // Reading normalises for validation only: what the agent gets back is the
  // daemon's frame, so an archived pack keeps its own label and key set.
  const { engine, io } = makeEngine();
  const value = fixture("evidence-pack.ok-04-legacy-draft.json");
  const tool = TOOL_BY_NAME.get("gp_last_evidence");
  const promise = executeTool(tool, {}, engine);
  io.respond({ evidencePack: value });
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(outcome.content[0].text.includes("glasspane.evidence/0.1-draft"));
});

test("consumer-glue gp_export_evidence renders a pack whose pixelDiff has no bounds key", async () => {
  // R1-02: "no pixel change" is the commonest outcome, and the renderer reads
  // `bounds !== null` — an omitted key used to blow up here and surface as an
  // unrelated shell error.
  const { engine, io } = makeEngine();
  const value = fixture("evidence-pack.ok-05-pixelbounds-null.json");
  const tool = TOOL_BY_NAME.get("gp_export_evidence");
  const promise = executeTool(tool, { operationId: value.operationId }, engine);
  io.respond({ evidencePack: value });
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(outcome.content[0].text.includes("pixelDiff: changedRatio=0 windowId=12"));
  assert.ok(!outcome.content[0].text.includes("bounds="));
  assert.ok(outcome.content[0].text.includes("**schemaVersion**: glasspane.evidence/0.1"));
});

test("a legacy pack renders, and its report names the frozen const it satisfies", async () => {
  // The read path folds the pre-freeze label onto the frozen const, so a
  // derived report says which contract the pack meets; the archive itself keeps
  // its own label (asserted above through gp_last_evidence).
  const { engine, io } = makeEngine();
  const value = fixture("evidence-pack.ok-04-legacy-draft.json");
  const promise = executeTool(
    TOOL_BY_NAME.get("gp_export_evidence"),
    { operationId: value.operationId },
    engine,
  );
  io.respond({ evidencePack: value });
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(outcome.content[0].text.includes("**schemaVersion**: glasspane.evidence/0.1\n"));
  assert.ok(!outcome.content[0].text.includes("0.1-draft"));
});

test("failure/fixture-upstream: an unreadable fixture surfaces as an upstream read error", () => {
  // Triage boundary: a broken shared fixture must fail loudly at read time
  // (ENOENT), never masquerade as a consumer regression.
  assert.throws(() => fixture("evidence-pack.does-not-exist.json"));
});

/* ------------------------------------------------------------------ *
 * R4-01 — the shell is the last consumer in front of the daemon's `pid_t`
 * narrowing: `pid_t(3000000000)` traps the daemon while it decodes the frame,
 * and a pid that large stored in projects.json makes Swift fail to decode the
 * whole registry file. So the value must die here, and tools/list must say so.
 * ------------------------------------------------------------------ */

const PID_INT32_MAX = 2_147_483_647;

test("gp_attach refuses pids outside the daemon's Int32 domain without a frame", async () => {
  const spec = TOOL_BY_NAME.get("gp_attach");
  for (const pid of [0, -1, 1.5, PID_INT32_MAX + 1, 3_000_000_000]) {
    const { engine, io } = makeEngine();
    const outcome = await executeTool(spec, { pid }, engine);
    assert.equal(outcome.isError, true, `pid ${pid} must not reach the daemon`);
    assert.ok(
      outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"),
      `pid ${pid} reported as ${outcome.content[0].text}`,
    );
    assert.equal(io.sent.length, 0, `pid ${pid} was forwarded over the socket`);
  }
});

test("gp_attach accepts the boundary pids the daemon can hold", async () => {
  const spec = TOOL_BY_NAME.get("gp_attach");
  for (const pid of [1, PID_INT32_MAX]) {
    const { engine, io } = makeEngine();
    const promise = executeTool(spec, { pid }, engine);
    io.respond({ pid, bundleId: "com.example.app", appName: "Example" });
    const outcome = await promise;
    assert.equal(outcome.isError, false, `pid ${pid} is inside Int32`);
    assert.equal(io.sent.length, 1);
  }
});

test("the advertised pid schemas state the domain the validators enforce", () => {
  for (const toolName of ["gp_attach", "gp_project_set"]) {
    const properties = TOOL_BY_NAME.get(toolName).inputSchema.properties;
    assert.deepEqual(properties.pid, { type: "integer", minimum: 1, maximum: PID_INT32_MAX });
  }
});