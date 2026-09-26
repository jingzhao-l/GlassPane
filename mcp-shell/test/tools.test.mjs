import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attachIdentityOf, TOOL_SPECS, TOOL_BY_NAME, executeTool, trailScopedTool } from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { canReceiveDaemonReply, methodsSentByShell } from "./support/wire-surface.mjs";
import { canonicalJson } from "../dist/canonical.js";
import { FORCE_OVERWRITE_ENV, MAX_PROJECTS } from "../dist/project-registry.js";
import { createTrackedMcpServer } from "../dist/dispatch.js";
import { EngineJsonRpcClient, CALLER_VISIBLE_CEILING_MS, slowEngineRemedy } from "../dist/engine-client.js";
import { FakeLineIo } from "./helpers.mjs";
import { MAX_FRAME_BYTES, OversizeFrameError } from "../dist/io.js";
import { makeEngine } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
  // The message states which side rejected the pack (this shell's read rules) and
  // carries the zod detail; it does not blame the daemon or order a restart.
  assert.ok(outcome.content[0].text.includes("this shell's read rules reject"));
  assert.ok(outcome.content[0].text.includes("restore-launchd") === false);
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
  // Not `makeEngine()`: this asserts *ordering*, and the 500 ms in that helper is
  // a caller deadline. At the load this machine has been sitting at today (load
  // average 210 = 26 per core, another project's Swift build) the deadline fired
  // before the trail turn came around and the test went red for a scheduling
  // reason — a control that only fails when the machine is busy tells you nothing
  // about ordering, in either direction. The table's own bound keeps the
  // assertion honest: an act admitted before the read must still be fetched.
  const io = new FakeLineIo();
  const engine = new EngineJsonRpcClient(io);
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
/* ------------------------------------------------------------------ *
 * R8-高3: the product path the sink exists for. An `act` whose reply lands
 * after the caller was told to wait must still show up in
 * `gp_recent_reports`; otherwise the answer the agent gets is
 * "GP_E_NO_EVIDENCE ... run gp_act first" for a click that already
 * happened on the user's screen, and the remedy's promise ("its operationId
 * is recorded in this session's trail") is decoration.
 *
 * Driven through `createTrackedMcpServer` — the same seam index.ts uses —
 * because a test that rebuilt the wiring here would pass against an
 * un-wired production server.
 * ------------------------------------------------------------------ */

test("an act answered after its timeout still lands in gp_recent_reports", async () => {
  const { io, engine } = makeEngine();
  const notes = [];
  const { session } = createTrackedMcpServer(engine, (note) => notes.push(note));

  const act = TOOL_BY_NAME.get("gp_act");
  const recent = TOOL_BY_NAME.get("gp_recent_reports");
  const OP_LATE = "op_99999999999999999999999999";

  const timedOut = await executeTool(act, { selector: { role: "AXButton" }, action: "press" }, engine, session);
  assert.equal(timedOut.isError, true, "调用方应先拿到超时诊断");
  assert.ok(timedOut.content[0].text.startsWith("GP_E_ENGINE_TIMEOUT"), timedOut.content[0].text);
  assert.deepEqual(session.recentIds(20), [], "超时本身不得编造一次操作");

  // The daemon frees up and answers the request it never forgot.
  const actFrame = JSON.parse(io.sent[io.sent.length - 1]);
  assert.equal(actFrame.method, "act");
  io.send(JSON.stringify({ id: actFrame.id, result: { operationId: OP_LATE, actConfirmed: true } }));
  await flush();
  assert.deepEqual(session.recentIds(20), [OP_LATE], "迟到回复的 operationId 必须进链");

  const promise = executeTool(recent, { limit: 5 }, engine, session);
  await flush();
  const evidenceFrameSent = JSON.parse(io.sent[io.sent.length - 1]);
  assert.equal(evidenceFrameSent.method, "last_evidence");
  assert.equal(evidenceFrameSent.params.operationId, OP_LATE,
    "gp_recent_reports 必须去取那次迟到操作，而不是回 GP_E_NO_EVIDENCE");
  io.respond(evidenceFrame(OP_LATE, T3_DIAGNOSIS));

  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(outcome.content[0].text.includes(`# ${OP_LATE} · T3 · normal`),
    outcome.content[0].text.slice(0, 300));
});

test("the trail turn a late reply takes does not block the calls behind it", async () => {
  const { io, engine } = makeEngine();
  const { session } = createTrackedMcpServer(engine, () => undefined);
  const act = TOOL_BY_NAME.get("gp_act");
  const OP_LATE = "op_88888888888888888888888888";

  await executeTool(act, { selector: { role: "AXButton" }, action: "press" }, engine, session);
  const actFrame = JSON.parse(io.sent[io.sent.length - 1]);
  io.send(JSON.stringify({ id: actFrame.id, result: { operationId: OP_LATE } }));

  // A late arrival claims a turn on the way in. If it ever failed to release,
  // the next trail-scoped call would sit on its 500 ms engine deadline instead
  // of being answered, so this asserts the following call completes and sees it.
  const second = executeTool(act, { selector: { role: "AXButton", title: "Two" }, action: "press" }, engine, session);
  await flush();
  io.respond({ operationId: "op_after_late", actConfirmed: true });
  await second;
  await flush();
  assert.deepEqual(session.recentIds(20), [OP_LATE, "op_after_late"]);
});

/* ------------------------------------------------------------------ *
 * R8-高3 / R8b-高1: which trail a late reply may be written into.
 *
 * The arrival-time turn gives a late reply the only honest position left, but
 * position is not *attribution*: an operation from before a re-attach belongs to
 * the previous app's history, and the daemon agrees — it clears its own history
 * exactly when the attached app changes. So the reply has to carry the trail
 * generation it was admitted under, and the wiring has to refuse a mismatch
 * rather than either losing it silently or leaking it into a new session.
 * ------------------------------------------------------------------ */

const ATTACH_A = { pid: 1111, bundleId: "com.example.a", appName: "A" };
const ATTACH_B = { pid: 2222, bundleId: "com.example.b", appName: "B" };

async function admitAct(io, engine, session) {
  const act = TOOL_BY_NAME.get("gp_act");
  const outcome = await executeTool(act, { selector: { role: "AXButton" }, action: "press" }, engine, session);
  assert.equal(outcome.isError, true, "act 先按 deadline 拿到超时诊断");
  return JSON.parse(io.sent[io.sent.length - 1]);
}

test("a late reply from a superseded attach is refused, and says so", async () => {
  const { io, engine } = makeEngine();
  const notes = [];
  const { session } = createTrackedMcpServer(engine, (note) => notes.push(note));
  const attach = TOOL_BY_NAME.get("gp_attach");
  const OP_BEFORE = "op_77777777777777777777777777";

  const actFrame = await admitAct(io, engine, session);
  const late = () => io.send(JSON.stringify({ id: actFrame.id, result: { operationId: OP_BEFORE } }));

  // Attach to a *different* app: the daemon drops its history here, so the act
  // that is about to be answered belongs to a session that no longer exists.
  const attachPromise = executeTool(attach, { bundleId: ATTACH_B.bundleId }, engine, session);
  await flush();
  io.respond(ATTACH_B);
  await attachPromise;

  late();
  await flush();
  assert.deepEqual(session.recentIds(20), [],
    "上一个 app 的操作不得出现在新 app 的链里");
  const refusal = notes.find((note) => note.includes("superseded attach"));
  assert.ok(refusal, `被拒的迟到回复必须自陈，而不是静静消失：${JSON.stringify(notes)}`);
  assert.ok(refusal.includes(OP_BEFORE), "拒绝要说出被丢掉的是哪个操作，否则代理无从回查");
  assert.ok(refusal.includes("gp_last_evidence"), "还要给出还能把它取回来的那条路");
});

test("an idempotent re-attach to the same app keeps a late-recorded operation", async () => {
  const { io, engine } = makeEngine();
  const notes = [];
  const { session } = createTrackedMcpServer(engine, (note) => notes.push(note));
  const attach = TOOL_BY_NAME.get("gp_attach");
  const act = TOOL_BY_NAME.get("gp_act");
  const recent = TOOL_BY_NAME.get("gp_recent_reports");
  const OP_LATE = "op_66666666666666666666666666";

  // Attach first, so the trail has an owner: the act is admitted under it.
  let attachPromise = executeTool(attach, { bundleId: ATTACH_A.bundleId }, engine, session);
  await flush();
  io.respond(ATTACH_A);
  await attachPromise;

  const actFrame = await admitAct(io, engine, session);
  io.send(JSON.stringify({ id: actFrame.id, result: { operationId: OP_LATE } }));
  await flush();
  assert.deepEqual(session.recentIds(20), [OP_LATE]);
  assert.equal(notes.length, 0, `同纪元的不该被拒：${JSON.stringify(notes)}`);

  // The agent re-attaches the same app (idempotent: the daemon keeps its
  // history). This used to wipe the trail and send it back to "run gp_act
  // first" for a click that had already happened.
  attachPromise = executeTool(attach, { bundleId: ATTACH_A.bundleId }, engine, session);
  await flush();
  io.respond(ATTACH_A);
  await attachPromise;
  assert.deepEqual(session.recentIds(20), [OP_LATE],
    "幂等 re-attach 之后链必须还在——否则又回到诱导重复点击的那个答案");

  const promise = executeTool(recent, { limit: 5 }, engine, session);
  await flush();
  io.respond(evidenceFrame(OP_LATE, T3_DIAGNOSIS));
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.ok(outcome.content[0].text.includes(`# ${OP_LATE} · T3 · normal`));
  assert.equal(act.name, "gp_act");
});

test("gp_attach refuses a bundleId and a pid together rather than attaching the one the daemon prefers", async () => {
  const { io, engine } = makeEngine();
  const { session } = createTrackedMcpServer(engine, () => undefined);
  const attach = TOOL_BY_NAME.get("gp_attach");

  const outcome = await executeTool(
    attach,
    { bundleId: "com.example.a", pid: 4242 },
    engine,
    session,
  );
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_BAD_PARAMS"), outcome.content[0].text);
  assert.equal(io.sent.length, 0,
    "两个身份都必须拦在壳层：daemon 收到两个字段时按 pid 优先、静默忽略 bundleId");
  assert.deepEqual(attach.inputSchema.oneOf, [{ required: ["bundleId"] }, { required: ["pid"] }],
    "advertising 的 oneOf 就是恰好一个，zod 不得比它宽松");
});

test("a late reply that arrives while an attach is in flight cannot overtake its reset", async () => {
  const { io, engine } = makeEngine();
  const notes = [];
  const { session } = createTrackedMcpServer(engine, (note) => notes.push(note));
  const attach = TOOL_BY_NAME.get("gp_attach");
  const OP_BEFORE_B = "op_55555555555555555555555555";

  // Session belongs to A.
  let p1 = executeTool(attach, { bundleId: ATTACH_A.bundleId }, engine, session);
  await flush();
  io.respond(ATTACH_A);
  await p1;

  // An act under A, answered only after its deadline (that is the late-reply case).
  const actFrame = await admitAct(io, engine, session);

  // Re-attach to B, admitted and **not yet answered**: its trail turn is open, and
  // the reset happens when its reply lands.
  const attachB = executeTool(attach, { bundleId: ATTACH_B.bundleId }, engine, session);
  await flush();

  // The late reply lands in this window. Its epoch still matches at arrival — the
  // only honest check is the epoch **after** the write acquires its turn, because
  // the turn is what orders it against the reset.
  io.send(JSON.stringify({ id: actFrame.id, result: { operationId: OP_BEFORE_B } }));
  await flush();

  const attachFrame = JSON.parse(io.sent[io.sent.length - 1]);
  assert.equal(attachFrame.method, "attach");
  io.respond(ATTACH_B);
  await attachB;
  await flush();

  assert.deepEqual(
    session.recentIds(20), [],
    "A 的操作不得越过 B 的 attach 落进新链：纪元复查必须发生在取得 trail turn 之后",
  );
  // 两条拒绝路径（到达时就发现 / 等到 turn 之后才发现）措辞不同，但都必须说得出
  // "没写进去"并且点名被丢掉的操作，否则代理只会看到一个凭空消失的动作。
  const refusal = notes.find((note) => note.includes("not recorded"));
  assert.ok(refusal, `拒绝必须说出口，不能静默写入也不能静默丢弃：${JSON.stringify(notes)}`);
  assert.ok(refusal.includes(OP_BEFORE_B), "要说清楚丢掉的是哪个操作");
  assert.match(refusal, /superseded attach|chain restarted/, `必须说清被谁取代：${refusal}`);
});

/* ------------------------------------------------------------------ *
 * R8d-高1: the late-reply path had a whole branch missing. `restart()` — the
 * thing that decides which app a trail belongs to — was reachable only from the
 * in-time attach path, so an attach whose *own* caller had already been given a
 * timeout never restarted anything: the generation never moved, every epoch gate
 * added to catch the cross-app leak was dead in exactly the busiest case, and the
 * daemon's history clear (`EngineCore.attach`, on app change) had no mirror here.
 * ------------------------------------------------------------------ */

test("an attach that answers after its own caller timed out still restarts the trail", async () => {
  const { io, engine } = makeEngine();
  const notes = [];
  const { session } = createTrackedMcpServer(engine, (note) => notes.push(note));
  const attach = TOOL_BY_NAME.get("gp_attach");
  const OP_UNDER_A = "op_44444444444444444444444444";

  const first = executeTool(attach, { bundleId: ATTACH_A.bundleId }, engine, session);
  await flush();
  io.respond(ATTACH_A);
  await first;
  assert.equal(session.attachedApp, attachIdentityOf(ATTACH_A), "第一次 attach 建立了归属");
  const generationAfterA = session.generation;

  // A records under A.
  const actFrame = await admitAct(io, engine, session);
  io.send(JSON.stringify({ id: actFrame.id, result: { operationId: OP_UNDER_A } }));
  await flush();
  assert.deepEqual(session.recentIds(20), [OP_UNDER_A]);

  // Now the second attach, which will be answered late — after its caller has
  // already been answered with a timeout.
  const lateAttach = executeTool(attach, { bundleId: ATTACH_B.bundleId }, engine, session);
  const lateFrame = JSON.parse(io.sent[io.sent.length - 1]);
  assert.equal(lateFrame.method, "attach");
  const timedOut = await lateAttach;
  assert.equal(timedOut.isError, true, "调用方先拿到超时诊断");
  assert.ok(timedOut.content[0].text.startsWith("GP_E_ENGINE_TIMEOUT"));
  assert.equal(session.attachedApp, attachIdentityOf(ATTACH_A),
    "回复还没落地之前，归属当然还属于 A");

  io.send(JSON.stringify({ id: lateFrame.id, result: ATTACH_B }));
  await flush();

  assert.equal(session.attachedApp, attachIdentityOf(ATTACH_B),
    "迟到的 attach 回复必须照样换掉归属：daemon 在这一刻清的是它自己的历史");
  assert.ok(session.generation > generationAfterA, "纪元必须前进，否则后续所有纪元判据都是死的");
  assert.deepEqual(session.recentIds(20), [], "A 的操作不得留在 B 的链里");
  assert.ok(
    notes.some((note) => note.includes("late attach reply") && note.includes(String(ATTACH_B.pid))),
    `这条链的换主必须留下痕迹：${JSON.stringify(notes)}`,
  );

  // And an operation admitted before that restart stays refused afterwards.
  io.send(JSON.stringify({ id: actFrame.id, result: { operationId: "op_too_late" } }));
  await flush();
  assert.equal(session.recentIds(20).includes("op_too_late"), false,
    "纪元复判必须对已被换主的会话仍然有效");
});

/* ------------------------------------------------------------------ *
 * R8d-高2: "narrow this reply" is a claim about the *tool*, so it is composed
 * where the tool's schema is. The transport used to guess from the params that
 * happened to be sent, which got both directions wrong: `gp_observe` with the
 * default depth was told it had nothing to shrink (it advertises `maxDepth`
 * 1…10), and `capture_view`'s scale branch could never be reached because the
 * PNG budget already sits under the frame cap.
 * ------------------------------------------------------------------ */

async function oversizedAdviceThrough(specName, args, { seedTrail = false } = {}) {
  const { io, engine } = makeEngine();
  const spec = TOOL_BY_NAME.get(specName);
  const session = new EvidenceAuditSession();
  // The two audit tools read the trail before they ask the daemon, so with an
  // empty trail they answer `GP_E_NO_EVIDENCE` and never put a frame on the wire
  // at all — the sweep would then be silently skipping them. One recorded id is
  // what makes them reach the transport, which is the thing under test.
  if (seedTrail) {
    session.record({ operationId: OP_A });
  }
  const call = executeTool(spec, args, engine, session);
  for (let i = 0; i < 20 && io.sent.length === 0; i++) {
    await flush();
  }
  assert.ok(io.sent.length > 0, `${specName} never reached the transport`);
  const frame = JSON.parse(io.sent[io.sent.length - 1]);
  io.emitError(new OversizeFrameError(MAX_FRAME_BYTES + 1, `{"id":${frame.id},"result":{"blob":`));
  const outcome = await call;
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith("GP_E_PAYLOAD_TOO_LARGE"), outcome.content[0].text);
  return outcome.content[0].text;
}

test("the too-large advice names the knobs the tool itself advertises", async () => {
  const observe = await oversizedAdviceThrough("gp_observe", {});
  assert.match(observe, /smaller maxDepth/, `observe 明明 advertise 了 maxDepth，却被说成没有可缩的参数：${observe}`);
  assert.match(observe, /advertises 1…10/, "界值要来自它自己广告出去的 schema，不能另抄一份");

  const audit = await oversizedAdviceThrough("gp_audit_ui", {});
  assert.match(audit, /smaller maxDepth/);

  const capture = await oversizedAdviceThrough("gp_capture_view", { scale: 1 });
  assert.match(capture, /smaller scale/, `capture_view 的 scale 是唯一旋钮：${capture}`);
  assert.match(capture, /currently 1/);
});

test("a knob already at its advertised floor is never described as shrinkable", async () => {
  const text = await oversizedAdviceThrough("gp_capture_view", { scale: 0.1 });
  assert.match(text, /already at this tool's floor \(0\.1\)/,
    `0.1 是 schema 的下界，再叫它调小就是给出一条会被自己拒掉的指令：${text}`);
  assert.ok(!/retry with a smaller scale/.test(text), text);
  assert.match(text, /ask a smaller question/, "到界之后必须给出真正还能做的事，而不是停在\"没有旋钮\"");
});

test("no advice names a parameter the tool does not advertise", async () => {
  // The property that makes the helper worth having: it may only point at knobs
  // this very tool publishes. Advice that names anything else sends an agent to a
  // parameter the shell would then reject with GP_E_BAD_PARAMS — the same family
  // of mistake R8d-高2 found in the old transport-level guess, pointing the other
  // way (there it invented nothing but named a knob the *request* hadn't sent).
  //
  // Scope is derived, not typed out: a tool can only be told how to shrink a
  // reply if a reply can reach it at all, and the registry trio answers out of
  // `projects.json` and never writes a frame. The same derivation
  // `test/method-table.test.mjs` uses decides it (one rule, shared), and the
  // argument table below is run through `spec.validate`, so a tool that gains a
  // required field makes this red with a pointer instead of sliding out of the
  // sweep unnoticed.
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const sent = methodsSentByShell(TOOL_SPECS, path.resolve(HERE, "..", "src"));
  const swept = TOOL_SPECS.filter((spec) => canReceiveDaemonReply(spec, sent));
  const excluded = TOOL_SPECS.filter((spec) => !canReceiveDaemonReply(spec, sent)).map((spec) => spec.name);
  const sweepArgs = {
    gp_attach: { bundleId: "com.example.sweep" },
    gp_act: { selector: { role: "AXButton" }, action: "press" },
    gp_assert_element: { selector: { role: "AXButton" }, property: "title", expected: "Submit" },
    gp_restore: { snapshotId: "snap_0123456789ABCDEFGHJKMNPQRS" },
    gp_export_evidence: { operationId: OP_A, format: "markdown" },
  };
  // Coverage without a name list: a forwarded tool always gets a reply, so one
  // missing from the sweep means the derivation is broken; and nothing that
  // reaches the daemon may be excluded.
  const forwarded = TOOL_SPECS.filter((spec) => spec.execute === undefined);
  assert.deepEqual(
    forwarded.filter((spec) => !swept.includes(spec)).map((spec) => spec.name), [],
    "被转发的工具没进扫描——它必然收得到回复，是推导坏了",
  );
  assert.deepEqual(
    excluded.filter((name) => TOOL_SPECS.find((spec) => spec.name === name)?.execute === undefined), [],
    `一个被转发的工具被判成"够不到 daemon"：${excluded.join(", ")}`,
  );
  assert.ok(swept.length >= 10, `只扫了 ${swept.length} 个工具，这条闸的覆盖已经不作数`);

  const offenders = [];
  const skipped = [];
  for (const spec of swept) {
    const args = sweepArgs[spec.name] ?? {};
    const checked = spec.validate(args);
    if (!checked.ok) {
      skipped.push(`${spec.name} 过不了自己的校验: ${checked.issues}`);
      continue;
    }
    let text;
    try {
      text = await oversizedAdviceThrough(spec.name, args, { seedTrail: true });
    } catch (error) {
      skipped.push(`${spec.name}: ${String(error).slice(0, 90)}`);
      continue;
    }
    const advertised = new Set(Object.keys(spec.inputSchema?.properties ?? {}));
    for (const knob of ["maxDepth", "scale", "limit", "selector", "role", "title", "property"]) {
      const claims = new RegExp(`smaller ${knob}\\b|\\b${knob} is already|tighter ${knob}\\b`, "");
      if (claims.test(text) && !advertised.has(knob)) {
        offenders.push(`${spec.name} 点了自己广告里没有的 \`${knob}\`: ${text.slice(0, 150)}`);
      }
    }
  }
  assert.deepEqual(skipped, [], `这些工具本该被扫到却没有：${skipped.join("; ")}`);
  assert.deepEqual(offenders, [], offenders.join("; "));
});

/* ------------------------------------------------------------------ *
 * Round-9 MCP review: advice an agent can follow without being refused
 * by the next call, and without being sent to destroy something.
 *
 * Four shapes, all of them the same mistake in different clothes: copy that
 * names an action the surface does not offer (a knob at its floor, a delete that
 * does not exist, a restart on a path where a frame arrived), and copy written
 * for the developer who wrote it rather than for the caller reading it.
 * ------------------------------------------------------------------ */

/** Drive a tool to the "reply did not fit" path and hand back its answer text. */
async function evidenceReadFailureText(frame) {
  const { engine, io } = makeEngine();
  const tool = TOOL_BY_NAME.get("gp_last_evidence");
  const promise = executeTool(tool, {}, engine);
  io.respond(frame);
  const outcome = await promise;
  assert.equal(outcome.isError, true);
  return outcome.content[0].text;
}

test("a knob at its advertised floor is refused for every kind that advertises one", async () => {
  // MUTATION THIS PINS: the floor filter in `oversizedReplyAdvice` going back to
  // `knob.kind === "scale"` only (mcp-shell/src/tools.ts). `gp_observe` with
  // `maxDepth: 1` then reads "retry with a smaller maxDepth (this tool advertises
  // 1…10)" — and zod's `min(1)` answers that retry with GP_E_BAD_PARAMS, so the
  // advice is a command this shell refuses to carry out. `gp_audit_ui`,
  // `gp_snapshot` and `gp_recent_reports`'s `limit` are the same shape.
  const observe = await oversizedAdviceThrough("gp_observe", { maxDepth: 1 });
  assert.match(observe, /maxDepth is already at this tool's floor \(1\)/,
    `已在下界的 maxDepth 不得再被说成可缩：${observe}`);
  assert.ok(!/smaller maxDepth/.test(observe), observe);
  // …and the knob that genuinely is still open gets named, by the name this tool
  // publishes (it has `role`, not `selector`).
  assert.match(observe, /retry with a tighter role filter/, observe);

  const snapshot = await oversizedAdviceThrough("gp_snapshot", { maxDepth: 1 });
  assert.match(snapshot, /maxDepth is already at this tool's floor \(1\)/, snapshot);
  assert.ok(!/smaller maxDepth/.test(snapshot), snapshot);
  assert.match(snapshot, /nothing left to narrow on this request/, snapshot);

  const recent = await oversizedAdviceThrough("gp_recent_reports", { limit: 1 }, { seedTrail: true });
  assert.match(recent, /limit is already at this tool's floor \(1\)/, recent);
  assert.ok(!/smaller limit/.test(recent), recent);
  // The second half of the same mistake: `gp_recent_reports` asks the daemon for
  // `last_evidence {operationId}` per id, so an advice built from the *frame's*
  // params never sees the `limit` the caller sent and offers to lower a number
  // that is already at its floor.
  assert.ok(recent.includes("last_evidence"), `发出的帧是 last_evidence，说明参数与工具参数不是同一份：${recent}`);

  // Above the floor the same sentence stays an instruction that works, with the
  // bounds read out of the advertised schema rather than typed a second time.
  const deep = await oversizedAdviceThrough("gp_observe", { maxDepth: 4 });
  assert.match(deep, /retry with a smaller maxDepth \(this tool advertises 1…10\)/, deep);
});

test("an oversized reply to a replay-unsafe tool forbids the retry instead of ordering one", async () => {
  // MUTATION THIS PINS: the `isReplayUnsafeMethod` branch in
  // `engineWithPayloadAdvice` (mcp-shell/src/tools.ts). `gp_act` advertises
  // `selector`, so the narrowing advice on that path reads "retry with a more
  // specific selector" — an instruction to perform the same change on the user's
  // screen a second time, when the dropped reply is proof the request *was*
  // answered. The transport refuses to replay these methods on its own; the
  // advice must not order by hand what the transport will not do.
  const act = await oversizedAdviceThrough("gp_act", { selector: { role: "AXButton" }, action: "press" });
  assert.match(act, /do not re-issue this request/, act);
  assert.ok(!/\bretry with\b/.test(act), `不可重放的工具不得收到"重试"：${act}`);
  // The fact the sentence rests on, stated rather than assumed.
  assert.match(act, /already reached the daemon and was answered/, act);
  assert.match(act, /'gp_act'/, "要说清是哪一次请求，而不是引擎方法名");
  assert.match(act, /it changes the user's screen/);
  // The trail is the route it does get, and every tool it names exists.
  assert.match(act, /gp_recent_reports lists/);
  assert.match(act, /gp_last_evidence \{operationId\}/);
  assert.match(act, /gp_observe \/ gp_assert_element/);
  assert.match(act, /gp_probe_status answers on the same connection/);
  // A knob is still named for the case where the reading says the change never
  // took effect — and only ever one `gp_act` publishes.
  assert.match(act, /a more specific selector/);

  const restore = await oversizedAdviceThrough("gp_restore", { snapshotId: "snap_0123456789ABCDEFGHJKMNPQRS" });
  assert.match(restore, /do not re-issue this request/, restore);
  assert.ok(!/\bretry with\b/.test(restore), restore);
  assert.match(restore, /it replays recorded steps onto the user's screen/);
  // `restore` advertises no knob that shrinks a reply, so none may be invented.
  assert.ok(!/smaller (maxDepth|scale|limit)|tighter (role|title)/.test(restore), restore);
  assert.match(restore, /no parameter that shrinks a reply/);

  const attach = await oversizedAdviceThrough("gp_attach", { bundleId: "com.example.sweep" });
  assert.match(attach, /do not re-issue this request/, attach);
  assert.match(attach, /re-points the daemon at another app/);
  assert.ok(!/\bretry with\b/.test(attach), attach);

  // A read keeps the narrowing advice: refusing to re-issue a read would be its
  // own unusable instruction.
  const observe = await oversizedAdviceThrough("gp_observe", {});
  assert.match(observe, /retry with a smaller maxDepth/, observe);
  assert.ok(!/do not re-issue this request/.test(observe), observe);
});

/**
 * The transport's replay verdict, read from its behaviour instead of its
 * spelling: `slowEngineRemedy` carries the no-replay clause for exactly the
 * methods the transport will not replay, and that is the same decision table the
 * payload advice has to agree with. Reading the source text for a private
 * constant would break on the next rename; this breaks only if the decision
 * itself stops being observable, which the guard below notices.
 */
function transportForbidsReplay(method) {
  return /do NOT re-issue/.test(slowEngineRemedy(method, "mcp"));
}

test("the no-retry advice covers exactly the methods the transport refuses to replay", async () => {
  // MUTATION THIS PINS: any drift between the tool layer's list of non-replayable
  // methods and the transport's. Add one there and not here → that tool's advice
  // reads "retry with …" and the agent re-performs a screen change; remove one
  // and a plain read gets told never to re-issue. Both directions, over every
  // tool that can receive a reply.
  const markerVisible = /do NOT re-issue/.test(slowEngineRemedy("act", "mcp"))
    && !/do NOT re-issue/.test(slowEngineRemedy("observe", "mcp"));
  assert.ok(markerVisible,
    "slowEngineRemedy 已不再把可重放与不可重放分开——这条对照就没有对照物了");

  const sweepArgs = {
    gp_attach: { bundleId: "com.example.sweep" },
    gp_act: { selector: { role: "AXButton" }, action: "press" },
    gp_assert_element: { selector: { role: "AXButton" }, property: "title", expected: "Submit" },
    gp_capture_view: { scale: 1 },
    gp_restore: { snapshotId: "snap_0123456789ABCDEFGHJKMNPQRS" },
    gp_export_evidence: { operationId: OP_A, format: "markdown" },
    gp_recent_reports: { limit: 2 },
  };
  const drift = [];
  for (const spec of TOOL_SPECS) {
    if (spec.name.startsWith("gp_project_")) continue; // answered from the file, never a frame
    const forbids = transportForbidsReplay(spec.engineMethod);
    let text;
    try {
      text = await oversizedAdviceThrough(spec.name, sweepArgs[spec.name] ?? {}, { seedTrail: true });
    } catch (error) {
      drift.push(`${spec.name}: ${String(error).slice(0, 90)}`);
      continue;
    }
    const advised = /do not re-issue this request/.test(text);
    if (advised !== forbids) {
      drift.push(`${spec.name} (${spec.engineMethod}): transport forbids replay = ${forbids}, advice forbids retry = ${advised}`);
    }
  }
  assert.deepEqual(drift, [], drift.join("; "));
});

test("a frame that arrived without a pack does not order a restart of what sent it", async () => {
  // MUTATION THIS PINS: `daemonUnreachableRemedy()` back into the
  // `mapEvidenceReadError` GP_E_INTERNAL remedy. A frame demonstrably came off
  // this socket, so the service is up; `--restore-launchd` bootstraps it over,
  // which takes down a daemon that may be holding an act already applied to the
  // user's screen. The remedy must state the fact (something answered, not with
  // the engine contract) and hand over a check that only reads.
  const text = await evidenceReadFailureText({ unexpected: true });
  assert.ok(text.startsWith("GP_E_INTERNAL"), text);
  assert.match(text, /without an evidencePack object/);
  assert.match(text, /do not restart anything on this answer/i,
    `重启必须被点名反对，而不是悄悄不提——agent 手边就有那条命令：${text}`);
  const at = text.indexOf("--restore-launchd");
  assert.ok(at > 0, `--restore-launchd 要出现在文案里并被禁掉：${text}`);
  assert.match(text.slice(Math.max(0, at - 160), at), /do not|wrong move/i,
    `重启命令只能出现在禁令里，出现在动作里就是下一次点击的元凶：${text}`);
  // The non-destructive discriminator, offered by this very surface, plus the
  // one command that reads which service is behind this socket.
  assert.match(text, /gp_probe_status/);
  assert.match(text, /launchctl print/);
  assert.ok(text.includes("GLASSPANE_ENGINE_SOCK"), "判别要给出它读的那条 socket 是从哪来的");
});

test("the schema-rejection remedy states the disagreement and names no assertion id", async () => {
  // MUTATION THIS PINS: "engine and kernel schema drifted; fix the common
  // fixtures (assertion C35)". The assertion id is a row in a document the agent
  // cannot open, and "drifted" reads as an invitation to go edit one side.
  const text = await evidenceReadFailureText({ evidencePack: { operationId: "bad" } });
  assert.ok(text.startsWith("GP_E_INTERNAL"), text);
  assert.match(text, /this shell's read rules reject/);
  assert.ok(!/\bassertion C\d+\b/.test(text), `agent -facing 文案里不得出现断言编号：${text}`);
  assert.ok(!/\bC35\b/.test(text), text);
  assert.ok(!/spec v|§/.test(text), text);
  // A pack did arrive and was rejected: nothing here is down, so no restart.
  assert.ok(!text.includes("restore-launchd"), text);
  assert.match(text, /gp_last_evidence \{operationId\}/, "要给出还能读的那条路");
});

test("no tools/list description carries a spec section or an assertion id", () => {
  // MUTATION THIS PINS: "(P1 spec v1.4)" back into `gp_project_list`'s
  // description. `tools/list` is the contract an agent reads to decide what to
  // call; a document version it cannot open is not a fact about the tool.
  const offenders = [];
  for (const spec of TOOL_SPECS) {
    const hit = [/\bspec\b/i, /§/, /\bassertion C\d+/i].filter((re) => re.test(spec.description));
    if (hit.length > 0) {
      offenders.push(`${spec.name} [${hit.join(",")}]: ${spec.description.slice(0, 100)}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("; "));
  // The sweep has to be looking at something: every description is read, and one
  // is long enough that a truncated copy of this gate would pass it vacuously.
  assert.equal(TOOL_SPECS.length, 16);
  assert.ok(TOOL_SPECS.every((spec) => typeof spec.description === "string" && spec.description.length > 10));
});

/** The `glasspaned --flag` names the daemon's own argument parser accepts. */
function daemonCliFlags() {
  const source = fs.readFileSync(
    path.resolve(HERE, "..", "..", "engine", "Sources", "glasspaned", "main.swift"),
    "utf8",
  );
  const flags = new Set();
  for (const match of source.matchAll(/case\s+"(--[a-z-]+)"/g)) {
    flags.add(match[1]);
  }
  assert.ok(flags.size >= 15, `只解析出 ${flags.size} 个 daemon CLI 开关，这条对照已经不作数`);
  return flags;
}

test("the project-limit remedy orders only actions this surface can perform", async () => {
  // MUTATION THIS PINS: `return "delete unused projects first (\`glasspaned
  // --list-projects\` prints the registered set), then retry"` in
  // `projectErrorRemedy`. Nothing in this project removes a registration — the
  // three `gp_project_*` tools read, `gp_project_set` creates or patches, and the
  // daemon CLI parses no delete flag — so the sentence ordered an action no caller
  // has, and quoted a flag that only prints.
  await withProjectsFile(async () => {
    const { engine } = makeEngine();
    const setTool = TOOL_BY_NAME.get("gp_project_set");
    for (let i = 0; i < MAX_PROJECTS; i++) {
      const filled = await executeTool(setTool, { displayName: `Filler ${i}`, bundleId: `com.filler.${i}` }, engine);
      assert.equal(filled.isError, false, `第 ${i} 次注册必须成功，否则这条闸测的不是上限：${filled.content[0].text}`);
    }
    const outcome = await executeTool(
      setTool, { displayName: "The one that does not fit", bundleId: "com.real.newapp" }, engine,
    );
    assert.equal(outcome.isError, true);
    const text = outcome.content[0].text;
    assert.ok(text.startsWith("GP_E_PROJECT_LIMIT"), text);
    assert.ok(!/delete unused projects/i.test(text), text);
    assert.ok(/this surface offers no delete/i.test(text),
      `上限的出路必须承认这里没有删除动作：${text}`);
    assert.ok(text.includes(`(${MAX_PROJECTS})`), `上限要说成可核对的数字：${text}`);
    // The two moves that do exist are named, by their real tool names.
    assert.ok(text.includes("gp_project_list") && text.includes("gp_project_set"), text);
    assert.match(text, /patches that entry and leaves the count/);
    // Anything the remedy tells the agent to run must be a command the shipped
    // binary accepts: `--project-remove` would have read perfectly and answered
    // "unknown argument".
    const flags = daemonCliFlags();
    const quoted = [...text.matchAll(/glasspaned\s+(--[a-z-]+)/g)].map((match) => match[1]);
    assert.ok(quoted.length > 0, "remedy 引用了 CLI 却没有可核对的开关，这条断言就成了空的");
    assert.deepEqual(quoted.filter((flag) => !flags.has(flag)), [],
      `remedy 报了 daemon 不解析的开关：${quoted.join(", ")}`);
  });
});

test("the limit the remedy quotes is the limit the daemon enforces", () => {
  // The remedy states `MAX_PROJECTS`; the number that actually refuses the write
  // lives in Swift, so quoting it here is a claim about another process.
  const source = fs.readFileSync(
    path.resolve(HERE, "..", "..", "engine", "Sources", "GlassPaneEngine", "ProjectModels.swift"),
    "utf8",
  );
  const declared = /static let maxProjects\s*=\s*(\d+)/.exec(source);
  assert.ok(declared, "读不到 daemon 的 maxProjects——这条对照就没有对照物了");
  assert.equal(MAX_PROJECTS, Number(declared[1]), "两侧的上限已经不同：remedy 报的数会是真的错数");
});

/* ------------------------------------------------------------------ *
 * R9-中4: `gp_recent_reports` fans out one `last_evidence` per trail id.
 * Each fetch is capped by the caller-visible ceiling, so an unbounded loop is
 * `limit` × that ceiling of held client — on the one tool that exists to stop a
 * duplicate click. The fan-out therefore spends ONE budget, and says which ids
 * it could not reach.
 * ------------------------------------------------------------------ */

/** The `last_evidence` frames a call has put on the wire, in order. */
function evidenceFrames(io) {
  return framesSent(io).filter((frame) => frame.method === "last_evidence");
}

test("gp_recent_reports stops at its own budget and names the ids it never fetched", async (t) => {
  // MUTATION THIS PINS: the `budget.spent` guard before each fetch. Without it
  // the loop asks for all four ids however long each one takes, and the header
  // claims a report the agent has to wait out entry by entry.
  t.mock.timers.enable({ apis: ["Date"] });
  const { engine, io } = makeEngine({ timeoutMs: 5_000 });
  const session = new EvidenceAuditSession();
  const ids = [OP_A, OP_B, "op_22222222222222222222222222", "op_33333333333333333333333333"];
  for (const id of ids) {
    session.record({ operationId: id });
  }
  assert.equal(session.recentIds(4).length, 4, "premise: 链里要有四条，才测得出第四条取不到");

  const promise = executeTool(TOOL_BY_NAME.get("gp_recent_reports"), { limit: 4 }, engine, session);
  const answered = [];
  for (let i = 0; i < 3; i++) {
    await flush();
    const frames = evidenceFrames(io);
    assert.equal(frames.length, i + 1, `第 ${i + 1} 次取证的请求应当已经发出`);
    const frame = frames[frames.length - 1];
    respondTo(io, frame, evidenceFrame(frame.params.operationId, T3_DIAGNOSIS));
    answered.push(frame.params.operationId);
    // Each answer costs a third of the whole budget: the fourth can never fit.
    t.mock.timers.tick(Math.ceil(CALLER_VISIBLE_CEILING_MS / 3));
  }
  const outcome = await promise;

  assert.equal(outcome.isError, false, outcome.content[0].text);
  const text = outcome.content[0].text;
  const unfetched = ids.filter((id) => !answered.includes(id));
  assert.equal(unfetched.length, 1, "premise: 应当恰好剩一条");
  assert.ok(text.includes(`# GlassPane recent reports (${answered.length})`),
    `标题的份数必须是真取到的那份：${text.slice(0, 200)}`);
  assert.ok(!text.includes(`recent reports (${ids.length})`), "部分报告不得冒充完整报告");
  assert.match(text, new RegExp(`not fetched within this report's ${CALLER_VISIBLE_CEILING_MS}ms wait`));
  assert.ok(text.includes(unfetched[0]), `没取的 id 必须点名，不能静默消失：${text.slice(0, 300)}`);
  assert.ok(!text.includes("unreachable"), "预算到点不等于 daemon 没有这条证据，两种事实不得混写");
  // The bound is what this asserts, not the answer's wording alone: the fourth
  // request must never have gone out at all.
  assert.equal(evidenceFrames(io).length, 3, "预算用完后不得再发出请求");
});

test("an unanswered last_evidence cannot hold gp_recent_reports past its budget", async (t) => {
  // MUTATION THIS PINS: the `Promise.race` against `budget.expired`. A daemon
  // that stops answering the second id then holds this tool for the whole
  // transport ceiling of that one call, per id — which is the wait the agent
  // cannot outlast, and the one it answers by clicking again.
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  // A far larger per-call deadline than the budget: only the budget can save this
  // call, which is the situation under test.
  const { engine, io } = makeEngine({ timeoutMs: CALLER_VISIBLE_CEILING_MS * 10 });
  const session = new EvidenceAuditSession();
  session.record({ operationId: OP_A });
  session.record({ operationId: OP_B });

  const promise = executeTool(TOOL_BY_NAME.get("gp_recent_reports"), { limit: 2 }, engine, session);
  await flush();
  const [first] = evidenceFrames(io);
  const fetchedId = first.params.operationId;
  respondTo(io, first, evidenceFrame(fetchedId, T3_DIAGNOSIS));
  await flush();
  assert.equal(evidenceFrames(io).length, 2, "premise: 第二条请求已发出且无人回答");
  const leftBehind = [OP_A, OP_B].find((id) => id !== fetchedId);

  t.mock.timers.tick(CALLER_VISIBLE_CEILING_MS);
  for (let i = 0; i < 20; i++) {
    await flush();
  }
  const outcome = await Promise.race([promise, Promise.resolve("NOT ANSWERED")]);
  assert.notEqual(outcome, "NOT ANSWERED", "预算到点，工具必须自己给出答案，而不是等那条没人答的请求");

  assert.equal(outcome.isError, false, outcome.content[0].text);
  const text = outcome.content[0].text;
  assert.ok(text.includes("# GlassPane recent reports (1)"), text.slice(0, 200));
  assert.match(text, /not fetched within this report's 50000ms wait: 1 entry left unanswered/);
  assert.ok(text.includes(leftBehind), "在途那条要按没取到报出来：它确实没有被等到");
  assert.equal(evidenceFrames(io).length, 2, "到点之后不得再发第三条");
});

test("gp_recent_reports with nothing fetched inside budget is a timeout, not 'no evidence'", async (t) => {
  // MUTATION THIS PINS: letting the empty-pack case fall through to
  // GP_E_NO_EVIDENCE. "no evidence is reachable" tells the agent its actions
  // produced nothing, which is the one reading that makes it re-run the act —
  // here the actions are in the trail and only the fetch ran out of time.
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const { engine, io } = makeEngine({ timeoutMs: CALLER_VISIBLE_CEILING_MS * 10 });
  const session = new EvidenceAuditSession();
  session.record({ operationId: OP_A });
  session.record({ operationId: OP_B });

  const promise = executeTool(TOOL_BY_NAME.get("gp_recent_reports"), { limit: 2 }, engine, session);
  await flush();
  t.mock.timers.tick(CALLER_VISIBLE_CEILING_MS);
  for (let i = 0; i < 20; i++) {
    await flush();
  }
  const outcome = await Promise.race([promise, Promise.resolve("NOT ANSWERED")]);
  assert.notEqual(outcome, "NOT ANSWERED", "一条都没取到时同样不得悬着调用方");

  assert.equal(outcome.isError, true);
  const text = outcome.content[0].text;
  assert.ok(text.startsWith("GP_E_ENGINE_TIMEOUT"), text);
  assert.ok(!text.startsWith("GP_E_NO_EVIDENCE"), text);
  assert.match(text, /the operations are recorded/);
  assert.match(text, /a smaller limit \(gp_recent_reports advertises 1…20\)/);
  assert.match(text, /gp_last_evidence \{operationId\}/);
  assert.ok(/do not re-run gp_act/i.test(text), `超预算的文案不得把"再来一次动作"当成出路：${text}`);
});
