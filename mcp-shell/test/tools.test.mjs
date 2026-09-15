import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_SPECS, TOOL_BY_NAME, executeTool } from "../dist/tools.js";
import { canonicalJson } from "../dist/canonical.js";
import { makeEngine } from "./helpers.mjs";

test("tools/list shape: six tools with expected names and methods", () => {
  const names = TOOL_SPECS.map((spec) => spec.name);
  assert.deepEqual(names, [
    "gp_attach",
    "gp_observe",
    "gp_act",
    "gp_assert_element",
    "gp_diagnose",
    "gp_last_evidence",
  ]);
  assert.equal(TOOL_BY_NAME.size, 6);
  assert.deepEqual(
    TOOL_SPECS.map((s) => s.engineMethod),
    ["attach", "observe", "act", "assert_element", "diagnose", "last_evidence"],
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