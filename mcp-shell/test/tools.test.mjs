import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { TOOL_SPECS, TOOL_BY_NAME, executeTool, trailScopedTool } from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { canonicalJson } from "../dist/canonical.js";
import { FORCE_OVERWRITE_ENV } from "../dist/project-registry.js";
import { makeEngine } from "./helpers.mjs";

test("tools/list shape: sixteen tools with expected names and methods", () => {
  const names = TOOL_SPECS.map((spec) => spec.name);
  assert.deepEqual(names, [
    "gp_attach",
    "gp_observe",
    "gp_act",
    "gp_assert_element",
    "gp_audit_ui",
    "gp_capture_view",
    "gp_diagnose",
    "gp_last_evidence",
    "gp_snapshot",
    "gp_restore",
    "gp_probe_status",
    "gp_export_evidence",
    "gp_recent_reports",
    "gp_project_list",
    "gp_project_set",
    "gp_project_get",
  ]);
  assert.equal(TOOL_BY_NAME.size, 16);
  assert.deepEqual(
    TOOL_SPECS.map((s) => s.engineMethod),
    ["attach", "observe", "act", "assert_element", "audit_ui", "capture_view", "diagnose", "last_evidence", "snapshot", "restore", "probe_status", "export_evidence", "recent_reports", "project_list", "project_set", "project_get"],
  );
  assert.equal(TOOL_SPECS.every((s) => s.name.startsWith("gp_")), true);
});

test("input schemas expose required fields in JSON-Schema form", () => {
  const act = TOOL_BY_NAME.get("gp_act").inputSchema;
  assert.deepEqual(act.required, ["selector", "action"]);
  assert.ok(act.properties.selector);
  const attach = TOOL_BY_NAME.get("gp_attach").inputSchema;
  assert.ok(attach.oneOf);
});

test("gp_act exposes the degrade option its remedy promises", () => {
  const act = TOOL_BY_NAME.get("gp_act").inputSchema;
  assert.deepEqual(act.properties.degrade, { type: "boolean" });
  assert.ok(!act.required.includes("degrade"), "degrade must stay optional");
});

test("gp_act forwards degrade and rejects a non-boolean value", async () => {
  const { engine, io } = makeEngine();
  const act = TOOL_BY_NAME.get("gp_act");
  const promise = executeTool(
    act,
    { selector: { role: "button", title: "Submit" }, action: "press", degrade: true },
    engine
  );
  const frame = io.lastFrame();
  assert.equal(frame.params.degrade, true);
  io.respond({ operationId: "op_0123456789ABCDEFGHJKMNPQRS", actConfirmed: true });
  assert.equal((await promise).isError, false);

  const bad = await executeTool(
    act,
    { selector: { role: "button" }, action: "press", degrade: "yes" },
    engine
  );
  assert.equal(bad.isError, true);
  assert.ok(bad.content[0].text.startsWith("GP_E_BAD_PARAMS"));
});

test("executeTool rejects invalid arguments as GP_E_BAD_PARAMS isError", async () => {
  const { engine } = makeEngine();
  const act = TOOL_BY_NAME.get("gp_act");
  const outcome = await executeTool(act, { selector: { role: "button" } }, engine); // missing action
  assert.equal(outcome.isError, true);
  const text = outcome.content[0].text;
  assert.ok(text.startsWith("GP_E_BAD_PARAMS"));
  assert.ok(text.includes("remedy"));
  // Nothing was forwarded to the engine.
  assert.equal(engine.io.sent.length, 0);
});

test("executeTool forwards valid arguments and returns canonical JSON result", async () => {
  const { engine, io } = makeEngine();
  const result = { operationId: "op_0123456789ABCDEFGHJKMNPQRS", actConfirmed: true };
  const act = TOOL_BY_NAME.get("gp_act");
  const promise = executeTool(act, { selector: { role: "button", title: "Submit" }, action: "press" }, engine);
  const frame = io.lastFrame();
  assert.equal(frame.method, "act");
  assert.equal(frame.params.selector.title, "Submit");
  io.respond(result);
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.equal(outcome.content.length, 1);
  assert.equal(outcome.content[0].text, canonicalJson(result));
});

test("executeTool maps an engine error frame to isError with GP_E prefix", async () => {
  const { engine, io } = makeEngine();
  const diag = TOOL_BY_NAME.get("gp_diagnose");
  const promise = executeTool(diag, {}, engine);
  io.respondError({ code: "GP_E_NOT_ATTACHED", message: "no app attached", remedy: "call attach first" });
  const outcome = await promise;
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_NOT_ATTACHED"));
  assert.ok(outcome.content[0].text.includes("| remedy: call attach first"));
});

test("last_evidence passes through a valid evidence pack (spec §6.3)", async () => {
  const { engine, io } = makeEngine();
  const lv = TOOL_BY_NAME.get("gp_last_evidence");
  const promise = executeTool(lv, {}, engine);
  io.respond({
    evidencePack: {
      schemaVersion: "glasspane.evidence/0.1",
      operationId: "op_0123456789ABCDEFGHJKMNPQRS",
      createdAt: "2026-09-15T00:00:00.000Z",
      attribution: { level: "soft", contaminated: false },
      circuitBreaker: { level: 0 },
      signals: {
        act: { selector: { role: "AXButton" }, action: "press", actConfirmed: true },
        axEvent: { axChanged: false, latencyMs: 9, nodeCount: 42,
          treeDigestBefore: "a".repeat(32), treeDigestAfter: "b".repeat(32) },
        handlerProbe: null,
        stateDiff: null,
      },
      assertion: null,
      diagnosis: null,
    },
  });
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.equal(outcome.content.length, 1);
});

test("last_evidence passes through a probe-carrying pack (P6 §3.1 null→object)", async () => {
  const { engine, io } = makeEngine();
  const lv = TOOL_BY_NAME.get("gp_last_evidence");
  const promise = executeTool(lv, {}, engine);
  io.respond({
    evidencePack: {
      schemaVersion: "glasspane.evidence/0.1",
      operationId: "op_0123456789ABCDEFGHJKMNPQRS",
      createdAt: "2026-09-19T00:00:00.000Z",
      attribution: { level: "strong", contaminated: false },
      circuitBreaker: { level: 0 },
      signals: {
        act: { selector: { role: "AXButton" }, action: "press", actConfirmed: true },
        handlerProbe: {
          probeVersion: "gp-probe/0.1.0",
          hitCount: 1,
          handlers: [{ file: "probe-demo/ProbeDemoApp.swift", line: 64 }],
          lateCount: 0,
        },
        stateDiff: { source: "z3-kvc", changed: true, entries: [{ key: "demo.count", before: "0", after: "1" }] },
      },
      assertion: null,
      diagnosis: null,
    },
  });
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(outcome.content[0].text.includes("gp-probe/0.1.0"));
});

test("gp_probe_status forwards an argument-less probe_status call (P6 §5.4)", async () => {
  const { engine, io } = makeEngine();
  const tool = TOOL_BY_NAME.get("gp_probe_status");
  const promise = executeTool(tool, {}, engine);
  const frame = io.lastFrame();
  assert.equal(frame.method, "probe_status");
  io.respond({ probes: [{ pid: 4242, appName: "probe-demo", probeVersion: "gp-probe/0.1.0", capabilities: ["z1", "z3", "checkpoint"], eventsSeen: 7 }], attachedHasProbe: true });
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(outcome.content[0].text.includes("attachedHasProbe"));
});

test("last_evidence rejects a schema-violating pack as isError (spec §6.3)", async () => {
  const { engine, io } = makeEngine();
  const lv = TOOL_BY_NAME.get("gp_last_evidence");
  const promise = executeTool(lv, {}, engine);
  // operationId violates the op_ pattern and createdAt is not ISO-8601 UTC.
  io.respond({ evidencePack: { schemaVersion: "nope", operationId: "bad", createdAt: "x", attribution: {}, circuitBreaker: {}, signals: {} } });
  const outcome = await promise;
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_INTERNAL"));
  assert.ok(outcome.content[0].text.includes("invalid evidence pack"));
});

test("last_evidence rejects a malformed frame (no evidencePack) as isError", async () => {
  const { engine, io } = makeEngine();
  const lv = TOOL_BY_NAME.get("gp_last_evidence");
  const promise = executeTool(lv, {}, engine);
  io.respond({ unexpected: true });
  const outcome = await promise;
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_INTERNAL"));
});

test("gp_snapshot forwards maxDepth and returns the snapshot result", async () => {
  const { engine, io } = makeEngine();
  const snap = TOOL_BY_NAME.get("gp_snapshot");
  const result = { snapshotId: "snap_0123456789ABCDEFGHJKMNPQRS", treeDigest: "d".repeat(32), nodeCount: 12, capturedAt: "2026-09-16T00:00:00.000Z", latencyMs: 3 };
  const promise = executeTool(snap, { maxDepth: 4 }, engine);
  const frame = io.lastFrame();
  assert.equal(frame.method, "snapshot");
  assert.equal(frame.params.maxDepth, 4);
  io.respond(result);
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.equal(outcome.content[0].text, canonicalJson(result));
});

test("gp_snapshot rejects out-of-range maxDepth as GP_E_BAD_PARAMS", async () => {
  const { engine, io } = makeEngine();
  const snap = TOOL_BY_NAME.get("gp_snapshot");
  const outcome = await executeTool(snap, { maxDepth: 11 }, engine);
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"));
  assert.equal(engine.io.sent.length, 0);
});

test("gp_restore forwards snapshotId, steps and mode, returning restore result", async () => {
  const { engine, io } = makeEngine();
  const restore = TOOL_BY_NAME.get("gp_restore");
  const result = { snapshotId: "snap_0123456789ABCDEFGHJKMNPQRS", baselineTreeDigest: "d".repeat(32), steps: [{ selector: { role: "AXButton" }, action: "press", actConfirmed: true, operationId: "op_0123456789ABCDEFGHJKMNPQRS" }], confirmed: 1, total: 1 };
  const promise = executeTool(restore, {
    snapshotId: "snap_0123456789ABCDEFGHJKMNPQRS",
    steps: [{ selector: { role: "AXButton" }, action: "press" }],
  }, engine);
  const frame = io.lastFrame();
  assert.equal(frame.method, "restore");
  assert.equal(frame.params.snapshotId, "snap_0123456789ABCDEFGHJKMNPQRS");
  assert.equal(frame.params.steps.length, 1);
  io.respond(result);
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.equal(outcome.content[0].text, canonicalJson(result));
});

test("gp_restore rejects a malformed snapshotId as GP_E_BAD_PARAMS", async () => {
  const { engine, io } = makeEngine();
  const restore = TOOL_BY_NAME.get("gp_restore");
  const outcome = await executeTool(restore, { snapshotId: "op_0123456789ABCDEFGHJKMNPQRS" }, engine);
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"));
  assert.equal(engine.io.sent.length, 0);
});

test("gp_restore rejects steps beyond 64 entries as GP_E_BAD_PARAMS", async () => {
  const { engine, io } = makeEngine();
  const restore = TOOL_BY_NAME.get("gp_restore");
  const steps = Array.from({ length: 65 }, () => ({ selector: { role: "AXButton" }, action: "press" }));
  const outcome = await executeTool(restore, { snapshotId: "snap_0123456789ABCDEFGHJKMNPQRS", steps }, engine);
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"));
  assert.equal(engine.io.sent.length, 0);
});

/* ------------------------------------------------------------------ *
 * P1 batch 4 audit tools (spec v1.3 §10.3): gp_export_evidence and
 * gp_recent_reports.
 * ------------------------------------------------------------------ */

const OP_A = "op_0123456789ABCDEFGHJKMNPQRS";
const OP_B = "op_123456789ABCDEFGHJKMNPQRST";

function evidenceFrame(operationId, diagnosis = null) {
  return {
    evidencePack: {
      schemaVersion: "glasspane.evidence/0.1",
      operationId,
      createdAt: "2026-09-15T00:00:00.000Z",
      attribution: { level: "soft", contaminated: false },
      circuitBreaker: { level: 0 },
      signals: {
        act: { selector: { role: "AXButton", title: "Submit" }, action: "press", actConfirmed: true },
        axEvent: {
          axChanged: false, latencyMs: 9, nodeCount: 42,
          treeDigestBefore: "a".repeat(32), treeDigestAfter: "b".repeat(32),
        },
        handlerProbe: null,
        stateDiff: null,
      },
      assertion: null,
      diagnosis,
    },
  };
}

const T3_DIAGNOSIS = {
  class: "T3",
  report: {
    path: "submit flow: press Submit → title unchanged",
    anomaly: "expected retitle after press; title stayed 'Submit'",
    evidence: "assert title expected=Submitted actual=Submit",
    next: "check the button's action wiring",
  },
};

test("gp_export_evidence renders the four-section markdown report", async () => {
  const { engine, io } = makeEngine();
  const exportTool = TOOL_BY_NAME.get("gp_export_evidence");
  const promise = executeTool(exportTool, { operationId: OP_A }, engine);
  const frame = io.lastFrame();
  assert.equal(frame.method, "last_evidence");
  assert.equal(frame.params.operationId, OP_A);
  io.respond(evidenceFrame(OP_A, T3_DIAGNOSIS));
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  const text = outcome.content[0].text;
  assert.ok(text.includes(`# ${OP_A} · T3 · normal`));
  for (const section of ["## PATH", "## ANOMALY", "## EVIDENCE", "## NEXT"]) {
    assert.ok(text.includes(section));
  }
  assert.ok(text.includes("attribution: soft | contaminated=false"));
  assert.ok(text.includes("circuitBreaker: level 0 (normal)"));
});

test("gp_export_evidence renders HTML when format=html", async () => {
  const { engine, io } = makeEngine();
  const exportTool = TOOL_BY_NAME.get("gp_export_evidence");
  const promise = executeTool(exportTool, { operationId: OP_A, format: "html" }, engine);
  io.respond(evidenceFrame(OP_A, T3_DIAGNOSIS));
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(outcome.content[0].text.includes(`<div class="gp-evidence" id="${OP_A}">`));
  assert.ok(outcome.content[0].text.includes("<h2>PATH</h2>"));
  assert.ok(outcome.content[0].text.includes("<h2>EVIDENCE</h2>"));
});

test("gp_export_evidence rejects a malformed operationId as GP_E_BAD_PARAMS", async () => {
  const { engine } = makeEngine();
  const exportTool = TOOL_BY_NAME.get("gp_export_evidence");
  const outcome = await executeTool(exportTool, { operationId: "nope" }, engine);
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"));
  assert.equal(engine.io.sent.length, 0);
});

test("gp_export_evidence rejects an unknown format as GP_E_BAD_PARAMS", async () => {
  const { engine } = makeEngine();
  const exportTool = TOOL_BY_NAME.get("gp_export_evidence");
  const outcome = await executeTool(exportTool, { operationId: OP_A, format: "pdf" }, engine);
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"));
  assert.equal(engine.io.sent.length, 0);
});

test("gp_export_evidence maps engine GP_E_NO_EVIDENCE through to the agent", async () => {
  const { engine, io } = makeEngine();
  const exportTool = TOOL_BY_NAME.get("gp_export_evidence");
  const promise = executeTool(exportTool, { operationId: OP_A }, engine);
  io.respondError({ code: "GP_E_NO_EVIDENCE", message: "unknown operationId op_...", remedy: "check the operationId" });
  const outcome = await promise;
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_NO_EVIDENCE"));
});

test("gp_export_evidence rejects a schema-violating pack as GP_E_INTERNAL", async () => {
  const { engine, io } = makeEngine();
  const exportTool = TOOL_BY_NAME.get("gp_export_evidence");
  const promise = executeTool(exportTool, { operationId: OP_A }, engine);
  io.respond({ evidencePack: { operationId: "bad", createdAt: "x", attribution: {}, circuitBreaker: {}, signals: {} } });
  const outcome = await promise;
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_INTERNAL"));
});

test("default tools record operationIds into the session trail", async () => {
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  const act = TOOL_BY_NAME.get("gp_act");
  const promise = executeTool(act, { selector: { role: "AXButton" }, action: "press" }, engine, session);
  io.respond({ operationId: OP_A, actConfirmed: true, evidenceId: OP_A });
  await promise;
  assert.deepEqual(session.recentIds(20), [OP_A]);
});

test("gp_attach resets the session trail", async () => {
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  const act = TOOL_BY_NAME.get("gp_act");
  const actPromise = executeTool(act, { selector: { role: "AXButton" }, action: "press" }, engine, session);
  io.respond({ operationId: OP_A, actConfirmed: true });
  await actPromise;
  assert.equal(session.recentIds(20).length, 1);

  const attach = TOOL_BY_NAME.get("gp_attach");
  const attachPromise = executeTool(attach, { bundleId: "com.example.app" }, engine, session);
  io.respond({ pid: 4242, bundleId: "com.example.app", appName: "Example" });
  await attachPromise;
  assert.deepEqual(session.recentIds(20), []);
});

/* ------------------------------------------------------------------ *
 * B-02 follow-up: the audit trail keeps *request* order even though the
 * replies no longer do.
 *
 * Since B-02 an outstanding engine call cannot hold back `ping`, `tools/list`
 * or `gp_probe_status`, which also means two pipelined tool calls apply their
 * `session.reset()` / `session.record()` in whichever order the daemon answered.
 * Pipelining is legal and the timeout remedy tells the agent to do it, so the
 * trail either kept an act across a re-attach (evidence of the app the attach
 * replaced) or lost it ("no operations recorded in this session" → the agent
 * re-performs the act on the user's screen). tools.ts claims a trail turn
 * before its first await, so the outcome below is the request-order one no
 * matter which reply lands first — and the two tests are the same pair of
 * calls with the replies swapped, which is exactly the thing that used to flip.
 * ------------------------------------------------------------------ */

/** Answer one specific outstanding engine frame, out of the order they went out. */
function respondTo(io, frame, result) {
  io.send(JSON.stringify({ id: frame.id, result }));
}

/** The engine frames a shell call has put on the wire, in the order it sent them. */
function framesSent(io) {
  return io.sent.map((line) => JSON.parse(line));
}

/**
 * Let every pending microtask run before answering the fake engine.
 *
 * `gp_recent_reports` is the one tool whose *first* engine frame sits behind an
 * `await`: it reads the trail before it asks the daemon, and that read waits for
 * its turn (tools.ts trail ordering). So its frame is not on the wire in the
 * call's own tick, unlike every other tool driven in this file. A `setImmediate`
 * tick drains the microtask queue, so this waits for scheduling only — never
 * for a 500ms engine deadline.
 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("an act admitted after an attach keeps its trail entry when the act replies first", async () => {
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  const attach = TOOL_BY_NAME.get("gp_attach");
  const act = TOOL_BY_NAME.get("gp_act");

  const attachPromise = executeTool(attach, { bundleId: "com.example.app" }, engine, session);
  const actPromise = executeTool(act, { selector: { role: "AXButton" }, action: "press" }, engine, session);
  // B-02 still holds: the trail is queued, the daemon requests are not.
  assert.equal(io.sent.length, 2, "the act reaches the engine without waiting for the attach");
  const [attachFrame, actFrame] = framesSent(io);

  // Out of order: the act answers first, the attach's reply arrives later.
  respondTo(io, actFrame, { operationId: OP_A, actConfirmed: true });
  respondTo(io, attachFrame, { pid: 4242, bundleId: "com.example.app", appName: "Example" });
  await Promise.all([attachPromise, actPromise]);

  // Request order is attach → act, so the reset precedes the record: the act is
  // in the trail the next gp_recent_reports / gp_export_evidence reads.
  assert.deepEqual(session.recentIds(20), [OP_A]);
});

test("an act admitted before an attach is cleared by it when the attach replies first", async () => {
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  const attach = TOOL_BY_NAME.get("gp_attach");
  const act = TOOL_BY_NAME.get("gp_act");

  const actPromise = executeTool(act, { selector: { role: "AXButton" }, action: "press" }, engine, session);
  const attachPromise = executeTool(attach, { bundleId: "com.example.app" }, engine, session);
  const [actFrame, attachFrame] = framesSent(io);

  // The opposite interleaving of the test above: the attach answers first.
  respondTo(io, attachFrame, { pid: 4242, bundleId: "com.example.app", appName: "Example" });
  respondTo(io, actFrame, { operationId: OP_A, actConfirmed: true });
  await Promise.all([actPromise, attachPromise]);

  // Request order is act → attach, and a successful attach restarts the trail
  // (`audit-session.ts`), so the act is gone — deterministically, not because
  // the attach's reply happened to win the race.
  assert.deepEqual(session.recentIds(20), []);
});

test("two pipelined acts record in request order when the daemon answers them out of order", async () => {
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  const act = TOOL_BY_NAME.get("gp_act");

  const first = executeTool(act, { selector: { role: "AXButton", title: "One" }, action: "press" }, engine, session);
  const second = executeTool(act, { selector: { role: "AXButton", title: "Two" }, action: "press" }, engine, session);
  const [firstFrame, secondFrame] = framesSent(io);

  respondTo(io, secondFrame, { operationId: OP_B, actConfirmed: true });
  respondTo(io, firstFrame, { operationId: OP_A, actConfirmed: true });
  await Promise.all([first, second]);

  assert.deepEqual(session.recentIds(20), [OP_A, OP_B]);
});

test("gp_recent_reports admitted behind an outstanding act reports that act", async () => {
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  const act = TOOL_BY_NAME.get("gp_act");
  const recent = TOOL_BY_NAME.get("gp_recent_reports");

  const actPromise = executeTool(act, { selector: { role: "AXButton" }, action: "press" }, engine, session);
  const recentPromise = executeTool(recent, { limit: 5 }, engine, session);
  const actFrame = framesSent(io)[0];

  respondTo(io, actFrame, { operationId: OP_A, actConfirmed: true });
  await new Promise((resolve) => setImmediate(resolve));

  // The read waited for the record, so it now has an operation to fetch. Answer
  // from an empty trail and this reports GP_E_NO_EVIDENCE — which is the
  // message that tells the agent to click again.
  assert.ok(io.sent.length >= 2, "gp_recent_reports fetched evidence for the act admitted before it");
  assert.equal(framesSent(io)[1].method, "last_evidence");
  assert.equal(framesSent(io)[1].params.operationId, OP_A);
  io.respond(evidenceFrame(OP_A, T3_DIAGNOSIS));

  const outcome = await recentPromise;
  assert.equal(outcome.isError, false);
  assert.ok(outcome.content[0].text.includes(`# ${OP_A} · T3 · normal`));
  await actPromise;
});

test("gp_probe_status and gp_observe are answered while a gp_act is still outstanding", async () => {
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  const act = TOOL_BY_NAME.get("gp_act");

  const actPromise = executeTool(act, { selector: { role: "AXButton" }, action: "press" }, engine, session);
  const statusPromise = executeTool(TOOL_BY_NAME.get("gp_probe_status"), {}, engine, session);
  const observePromise = executeTool(TOOL_BY_NAME.get("gp_observe"), {}, engine, session);
  const [actFrame, statusFrame, observeFrame] = framesSent(io);

  // `slowEngineRemedy` sends the agent to gp_probe_status *during* an
  // outstanding act, and gp_observe/gp_snapshot/gp_probe_status frames carry no
  // operationId for the trail, so none of them may queue behind it.
  respondTo(io, statusFrame, { probes: [], attachedHasProbe: false });
  respondTo(io, observeFrame, { axTree: [], nodeCount: 0, digest: "d".repeat(32), latencyMs: 4 });
  const status = await statusPromise;
  const observe = await observePromise;
  assert.equal(status.isError, false, "gp_probe_status answered with the act outstanding");
  assert.equal(observe.isError, false, "gp_observe answered with the act outstanding");

  respondTo(io, actFrame, { operationId: OP_A, actConfirmed: true });
  await actPromise;
  // Excluded from the trail order does not mean excluded from the trail.
  assert.deepEqual(session.recentIds(20), [OP_A]);
});

test("the trail-ordered set is the tools whose frames build the trail", () => {
  // `gp_observe` / `gp_snapshot` / `gp_probe_status` are absent because their
  // result frames carry no `operationId`/`evidenceId` to record (see
  // `trailScopedTool`), and `gp_probe_status` in particular must keep answering
  // during an outstanding act. A new engine method that starts answering with an
  // operationId has to be added to that list, and this assertion is where the
  // omission surfaces.
  assert.deepEqual(
    TOOL_SPECS.filter(trailScopedTool).map((spec) => spec.name),
    [
      "gp_attach",
      "gp_act",
      "gp_assert_element",
      "gp_diagnose",
      "gp_last_evidence",
      "gp_restore",
      "gp_export_evidence",
      "gp_recent_reports",
    ],
  );
});

test("gp_recent_reports with no recorded operations is GP_E_NO_EVIDENCE", async () => {
  const { engine } = makeEngine();
  const recent = TOOL_BY_NAME.get("gp_recent_reports");
  const outcome = await executeTool(recent, {}, engine);
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_NO_EVIDENCE"));
  assert.equal(engine.io.sent.length, 0);
});

test("gp_recent_reports limits out of 1–20 as GP_E_BAD_PARAMS", async () => {
  const { engine } = makeEngine();
  const recent = TOOL_BY_NAME.get("gp_recent_reports");
  const outcome = await executeTool(recent, { limit: 0 }, engine);
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"));
  const outcomeMax = await executeTool(recent, { limit: 21 }, engine);
  assert.equal(outcomeMax.isError, true);
  assert.ok(outcomeMax.content[0].text.startsWith("GP_E_BAD_PARAMS"));
});

test("gp_recent_reports aggregates the recorded operations into one report", async () => {
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  session.record({ operationId: OP_A });
  session.record({ operationId: OP_B });

  const recent = TOOL_BY_NAME.get("gp_recent_reports");
  const promise = executeTool(recent, { limit: 5 }, engine, session);
  await flush();

  io.respond(evidenceFrame(OP_A, T3_DIAGNOSIS));
  await flush();
  io.respond(evidenceFrame(OP_B, T3_DIAGNOSIS));

  const outcome = await promise;
  assert.equal(outcome.isError, false);
  const text = outcome.content[0].text;
  assert.ok(text.includes("# GlassPane recent reports (2)"));
  assert.ok(text.includes(`# ${OP_A} · T3 · normal`));
  assert.ok(text.includes(`# ${OP_B} · T3 · normal`));
  assert.ok(text.includes("---"));
});

test("gp_recent_reports skips entries the daemon cannot answer for, with a note", async () => {
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  session.record({ operationId: OP_A });
  session.record({ operationId: OP_B });

  const recent = TOOL_BY_NAME.get("gp_recent_reports");
  const promise = executeTool(recent, { limit: 5 }, engine, session);
  await flush();

  io.respondError({ code: "GP_E_NO_EVIDENCE", message: "unknown operationId", remedy: "check the operationId" });
  await flush();
  io.respond(evidenceFrame(OP_B, T3_DIAGNOSIS));

  const outcome = await promise;
  assert.equal(outcome.isError, false);
  const text = outcome.content[0].text;
  assert.ok(text.includes("# GlassPane recent reports (1)"));
  assert.ok(text.includes("skipped 1 unreachable entry"));
  assert.ok(text.includes(`# ${OP_B} · T3 · normal`));
  // OP_A is only mentioned by the skip note, never rendered as a report.
  assert.ok(!text.includes(`# ${OP_A} · T3 · normal`));
});

test("gp_recent_reports renders HTML aggregation when format=html", async () => {
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  session.record({ operationId: OP_A });
  session.record({ operationId: OP_B });

  const recent = TOOL_BY_NAME.get("gp_recent_reports");
  const promise = executeTool(recent, { format: "html", limit: 5 }, engine, session);
  await flush();
  io.respond(evidenceFrame(OP_A, T3_DIAGNOSIS));
  await flush();
  io.respond(evidenceFrame(OP_B, T3_DIAGNOSIS));

  const outcome = await promise;
  assert.equal(outcome.isError, false);
  const text = outcome.content[0].text;
  assert.ok(text.includes("<h1>GlassPane recent reports (2)</h1>"));
  assert.ok(text.includes("<hr>"));
  assert.ok(text.includes(`<h1>${OP_A} · T3 · normal</h1>`));
});

/* ------------------------------------------------------------------ *
 * The two properties the trail queue rests on: it orders by *claim*, and
 * the wait it imposes is bounded.
 * ------------------------------------------------------------------ */

test("an abandoned trail turn does not let a report overtake an outstanding act", async () => {
  // The middle call claims a trail turn and hands it back without touching the
  // trail (its engine call failed), so releases are *not* in claim order here.
  // The report has to wait for every turn that was open when it claimed, not
  // just for the previous one — otherwise it reads the trail before the act
  // writes it and tells the agent the act never happened, which is the harm the
  // queue exists to prevent.
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  const act = TOOL_BY_NAME.get("gp_act");
  const lastEvidence = TOOL_BY_NAME.get("gp_last_evidence");
  const recent = TOOL_BY_NAME.get("gp_recent_reports");

  const actPromise = executeTool(act, { selector: { role: "AXButton" }, action: "press" }, engine, session);
  const abandonedPromise = executeTool(lastEvidence, {}, engine, session);
  const reportPromise = executeTool(recent, { limit: 5 }, engine, session);
  await flush();
  assert.equal(
    framesSent(io).length,
    2,
    "the two engine calls went out at once; only the report is queued",
  );

  // The last_evidence frame is the one on the wire, so this answers the middle
  // call — the act stays outstanding.
  io.respondError({ code: "GP_E_NO_EVIDENCE", message: "no evidence recorded", remedy: "run gp_act first" });
  assert.equal((await abandonedPromise).isError, true);

  // Only now does the act answer, and it records into the trail.
  const [actFrame] = framesSent(io);
  respondTo(io, actFrame, { operationId: OP_A, actConfirmed: true });
  await actPromise;

  await flush();
  const reportFrame = framesSent(io)[2];
  assert.equal(reportFrame.method, "last_evidence");
  assert.equal(
    reportFrame.params.operationId,
    OP_A,
    "the report read the trail *after* the act that was still outstanding when it claimed its turn",
  );
  io.respond(evidenceFrame(OP_A, T3_DIAGNOSIS));
  const report = await reportPromise;
  assert.equal(report.isError, false);
  assert.ok(report.content[0].text.includes(`# ${OP_A} · T3 · normal`));
});

test("an unanswered act releases the trail when the engine deadline settles it", async () => {
  // Every trail-scoped call can be made to wait behind another, so the wait has
  // to be bounded: a turn is outstanding only while its `executeTool` promise
  // is, and `engine.call` always settles — here on its deadline. If it did not,
  // one dropped daemon frame would wedge `gp_recent_reports`,
  // `gp_export_evidence` and every later evidence tool for the life of the
  // process, which is a worse failure than the interleaving the queue fixes.
  const { engine, io } = makeEngine({ timeoutMs: 30 });
  const session = new EvidenceAuditSession();
  const act = TOOL_BY_NAME.get("gp_act");
  const recent = TOOL_BY_NAME.get("gp_recent_reports");

  const actPromise = executeTool(act, { selector: { role: "AXButton" }, action: "press" }, engine, session);
  await flush();
  assert.equal(framesSent(io).length, 1, "the act is on the wire and nothing answered it");

  const report = await Promise.race([
    executeTool(recent, { limit: 5 }, engine, session),
    new Promise((resolve) => setTimeout(() => resolve("wedged"), 1000)),
  ]);
  assert.notEqual(report, "wedged", "the report must not outlive the act's 30 ms engine deadline");
  assert.equal(report.isError, true);
  assert.ok(report.content[0].text.startsWith("GP_E_NO_EVIDENCE"));

  const actOutcome = await actPromise;
  assert.equal(actOutcome.isError, true, "the unanswered act itself surfaces as an engine error");
});

/* ------------------------------------------------------------------ *
 * P1 batch 5 project tools (spec v1.4 §4): file-level registry access.
 * ------------------------------------------------------------------ */

function withProjectsFile(t) {
  const tmp = new URL(`./tmp-project-${process.pid}.json`, import.meta.url).pathname;
  process.env.GLASSPANE_PROJECTS_FILE = tmp;
  return Promise.resolve(t()).finally(() => {
    delete process.env.GLASSPANE_PROJECTS_FILE;
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  });
}

test("gp_project_list returns an empty registry", async () => {
  const { engine } = makeEngine();
  await withProjectsFile(async () => {
    const tool = TOOL_BY_NAME.get("gp_project_list");
    const outcome = await executeTool(tool, {}, engine);
    assert.equal(outcome.isError, false);
    const parsed = JSON.parse(outcome.content[0].text);
    assert.deepEqual(parsed.projects, []);
    // file-level tool: nothing forwarded to the engine
    assert.equal(engine.io.sent.length, 0);
  });
});

test("gp_project_set creates a project and gp_project_get / list read it back", async () => {
  const { engine } = makeEngine();
  await withProjectsFile(async () => {
    const setTool = TOOL_BY_NAME.get("gp_project_set");
    const setOutcome = await executeTool(setTool, { displayName: "Notes", bundleId: "com.notes" }, engine);
    assert.equal(setOutcome.isError, false);
    const setParsed = JSON.parse(setOutcome.content[0].text);
    const project = setParsed.project;
    assert.match(project.projectId, /^prj_[0-9A-HJKMNP-TV-Z]{26}$/);

    const getTool = TOOL_BY_NAME.get("gp_project_get");
    const getOutcome = await executeTool(getTool, { projectId: project.projectId }, engine);
    assert.equal(getOutcome.isError, false);
    const getParsed = JSON.parse(getOutcome.content[0].text);
    assert.equal(getParsed.project.displayName, "Notes");
    assert.equal(getParsed.project.bundleId, "com.notes");

    const listOutcome = await executeTool(TOOL_BY_NAME.get("gp_project_list"), {}, engine);
    const listParsed = JSON.parse(listOutcome.content[0].text);
    assert.equal(listParsed.projects.length, 1);
  });
});

test("gp_project_set updates an existing project by projectId", async () => {
  const { engine } = makeEngine();
  await withProjectsFile(async () => {
    const setTool = TOOL_BY_NAME.get("gp_project_set");
    const created = await executeTool(setTool, { displayName: "A", pid: 111 }, engine);
    const { projectId } = JSON.parse(created.content[0].text).project;

    const updated = await executeTool(setTool, { projectId, displayName: "A2", pid: 222 }, engine);
    const updatedProject = JSON.parse(updated.content[0].text).project;
    assert.equal(updatedProject.displayName, "A2");
    assert.equal(updatedProject.pid, 222);

    const get = await executeTool(TOOL_BY_NAME.get("gp_project_get"), { projectId }, engine);
    assert.equal(JSON.parse(get.content[0].text).project.displayName, "A2");
  });
});

test("gp_project_get unknown id maps to GP_E_NOT_FOUND", async () => {
  const { engine } = makeEngine();
  await withProjectsFile(async () => {
    const getTool = TOOL_BY_NAME.get("gp_project_get");
    const outcome = await executeTool(getTool, { projectId: "prj_99999999999999999999999999" }, engine);
    assert.equal(outcome.isError, true);
    assert.ok(outcome.content[0].text.startsWith("GP_E_NOT_FOUND"));
  });
});

test("gp_project_set rejects missing bundleId/pid as GP_E_BAD_PARAMS", async () => {
  const { engine } = makeEngine();
  await withProjectsFile(async () => {
    const setTool = TOOL_BY_NAME.get("gp_project_set");
    const outcome = await executeTool(setTool, { displayName: "No Target" }, engine);
    assert.equal(outcome.isError, true);
    assert.ok(outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"));
    assert.equal(engine.io.sent.length, 0);
  });
});

test("gp_project_set rejects empty displayName as GP_E_BAD_PARAMS", async () => {
  const { engine } = makeEngine();
  await withProjectsFile(async () => {
    const setTool = TOOL_BY_NAME.get("gp_project_set");
    const outcome = await executeTool(setTool, { displayName: "", bundleId: "com.x" }, engine);
    assert.equal(outcome.isError, true);
    assert.ok(outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"));
  });
});

test("gp_project_get rejects malformed projectId as GP_E_BAD_PARAMS", async () => {
  const { engine } = makeEngine();
  await withProjectsFile(async () => {
    const getTool = TOOL_BY_NAME.get("gp_project_get");
    const outcome = await executeTool(getTool, { projectId: "op_0123456789ABCDEFGHJKMNPQRS" }, engine);
    assert.equal(outcome.isError, true);
    assert.ok(outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"));
    assert.equal(engine.io.sent.length, 0);
  });
});

/* ------------------------------------------------------------------ *
 * Unreadable registry through the tool surface (B-1 shell half).
 *
 * `projectList()`/`projectGet()` now throw instead of answering "0 projects"
 * when projects.json cannot be read or decoded. Both handlers used to have no
 * try/catch, and a tool's `execute` runs *outside* `executeTool`'s own
 * try/catch, so the throw escaped as a rejected promise → JSON-RPC -32603
 * "internal error" with no GP_E_ code, no cause and no remedy.
 * ------------------------------------------------------------------ */

const CORRUPT_REGISTRY = '[{"projectId":"prj_0123456789ABCDEFGHJKMNPQRS","displayName":"A","pid":not-a-number}]\n';

function withCorruptRegistry(t) {
  const tmp = new URL(`./tmp-corrupt-${process.pid}.json`, import.meta.url).pathname;
  fs.writeFileSync(tmp, CORRUPT_REGISTRY, "utf8");
  const previousForce = process.env[FORCE_OVERWRITE_ENV];
  delete process.env[FORCE_OVERWRITE_ENV]; // the refusal under test needs no escape hatch
  process.env.GLASSPANE_PROJECTS_FILE = tmp;
  return Promise.resolve(t(tmp)).finally(() => {
    delete process.env.GLASSPANE_PROJECTS_FILE;
    if (previousForce !== undefined) process.env[FORCE_OVERWRITE_ENV] = previousForce;
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  });
}

test("gp_project_list answers an unreadable registry as a structured GP_E_INTERNAL", async () => {
  const { engine } = makeEngine();
  await withCorruptRegistry(async (tmp) => {
    const outcome = await executeTool(TOOL_BY_NAME.get("gp_project_list"), {}, engine);
    assert.equal(outcome.isError, true, "the tool must answer, never reject");
    const text = outcome.content[0].text;
    assert.ok(text.startsWith("GP_E_INTERNAL"), text);
    assert.ok(text.includes(tmp), `the message must name the damaged file: ${text}`);
    assert.match(text, /is not valid JSON|cannot be read/, "the cause is the file, not the arguments");
    assert.ok(!text.includes('"projects"'), "an unreadable registry is never listed as zero projects");
    assert.equal(engine.io.sent.length, 0, "a file-level tool never touches the engine");
  });
});

test("the list remedy repairs the file instead of sending the agent to the logs", async () => {
  const { engine } = makeEngine();
  await withCorruptRegistry(async (tmp) => {
    const text = (await executeTool(TOOL_BY_NAME.get("gp_project_list"), {}, engine)).content[0].text;
    const remedy = text.slice(text.indexOf("| remedy:"));
    assert.ok(remedy.includes("python3 -m json.tool"), remedy);
    assert.ok(remedy.includes(FORCE_OVERWRITE_ENV), `the documented escape hatch must be named: ${remedy}`);
    assert.ok(!remedy.includes("MCP server logs"), `the old default remedy points away from the damage: ${remedy}`);
    assert.ok(!remedy.includes("input schema"), `a read failure is not a parameter problem: ${remedy}`);
  });
});

test("gp_project_get maps the unreadable registry the same way", async () => {
  const { engine } = makeEngine();
  await withCorruptRegistry(async () => {
    const outcome = await executeTool(
      TOOL_BY_NAME.get("gp_project_get"),
      { projectId: "prj_0123456789ABCDEFGHJKMNPQRS" },
      engine,
    );
    assert.equal(outcome.isError, true);
    const text = outcome.content[0].text;
    assert.ok(text.startsWith("GP_E_INTERNAL"), text);
    assert.ok(!text.startsWith("GP_E_NOT_FOUND"), "an unreadable file must not read as an absent project");
  });
});

test("gp_project_set refuses the overwrite through the tool surface and leaves the file intact", async () => {
  const { engine } = makeEngine();
  await withCorruptRegistry(async (tmp) => {
    const outcome = await executeTool(
      TOOL_BY_NAME.get("gp_project_set"),
      { displayName: "Notes", bundleId: "com.notes" },
      engine,
    );
    assert.equal(outcome.isError, true);
    assert.ok(outcome.content[0].text.startsWith("GP_E_INTERNAL"), outcome.content[0].text);
    assert.equal(
      fs.readFileSync(tmp, "utf8"),
      CORRUPT_REGISTRY,
      "nothing was written while the registry is unreadable (and no escape hatch was set)",
    );
    assert.deepEqual(siblingsOf(tmp, ".unreadable-"), [], "the file is not moved aside without the flag");
  });
});

function siblingsOf(filePath, suffix) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return fs.readdirSync(dir).filter((name) => name.startsWith(`${base}${suffix}`));
}