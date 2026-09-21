import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { TOOL_SPECS, TOOL_BY_NAME, executeTool } from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { canonicalJson } from "../dist/canonical.js";
import { makeEngine } from "./helpers.mjs";

test("tools/list shape: eleven tools with expected names and methods", () => {
  const names = TOOL_SPECS.map((spec) => spec.name);
  assert.deepEqual(names, [
    "gp_attach",
    "gp_observe",
    "gp_act",
    "gp_assert_element",
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
  assert.equal(TOOL_BY_NAME.size, 14);
  assert.deepEqual(
    TOOL_SPECS.map((s) => s.engineMethod),
    ["attach", "observe", "act", "assert_element", "diagnose", "last_evidence", "snapshot", "restore", "probe_status", "export_evidence", "recent_reports", "project_list", "project_set", "project_get"],
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

  io.respond(evidenceFrame(OP_A, T3_DIAGNOSIS));
  await new Promise((resolve) => setImmediate(resolve));
  io.respond(evidenceFrame(OP_B, T3_DIAGNOSIS));

  const outcome = await promise;
  assert.equal(outcome.isError, false);
  const text = outcome.content[0].text;
  assert.ok(text.includes("# GlassPane recent reports (2)"));
  assert.ok(text.includes(`# ${OP_A} · T3 · normal`));
  assert.ok(text.includes(`# ${OP_B} · T3 · normal`));
  assert.ok(text.includes("---"));
});

test("gp_recent_reports skips evicted entries with a note", async () => {
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  session.record({ operationId: OP_A });
  session.record({ operationId: OP_B });

  const recent = TOOL_BY_NAME.get("gp_recent_reports");
  const promise = executeTool(recent, { limit: 5 }, engine, session);

  io.respondError({ code: "GP_E_NO_EVIDENCE", message: "unknown operationId", remedy: "check the operationId" });
  await new Promise((resolve) => setImmediate(resolve));
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
  io.respond(evidenceFrame(OP_A, T3_DIAGNOSIS));
  await new Promise((resolve) => setImmediate(resolve));
  io.respond(evidenceFrame(OP_B, T3_DIAGNOSIS));

  const outcome = await promise;
  assert.equal(outcome.isError, false);
  const text = outcome.content[0].text;
  assert.ok(text.includes("<h1>GlassPane recent reports (2)</h1>"));
  assert.ok(text.includes("<hr>"));
  assert.ok(text.includes(`<h1>${OP_A} · T3 · normal</h1>`));
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