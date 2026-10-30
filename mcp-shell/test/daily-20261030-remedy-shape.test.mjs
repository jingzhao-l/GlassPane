/**
 * A remedy must be a step the caller can actually take.
 *
 * Two defects this file keeps from coming back, both measured on the delivered artifact:
 *
 *  1. `tools/call` **shape** refusals named a tool that this same shell refuses. The example was
 *     picked by reading `required` off the advertised JSON Schema, but `gp_attach` publishes
 *     `oneOf: [{required:[bundleId]}, {required:[pid]}]` with **no top-level `required`** — so the
 *     schema read called it "takes nothing" while `AttachArgs.refine` answers `{}` with
 *     `GP_E_BAD_PARAMS: attach takes exactly one of bundleId or pid`. Reproduced before the fix:
 *     the remedy of one refusal was a request guaranteed to produce the next one. Now the example
 *     is chosen by running the same `validate` the call path runs.
 *  2. `GP_E_STATE_ROOT_REFUSED`'s remedy told the agent to ask `glasspaned --permissions` which
 *     root the service resolved. Measured on this machine, that command's JSON is
 *     `{subject, permissions, verdict, verdictSeats, verdictExcludes, seatsNotGranted, next}` —
 *     **no state root anywhere** — so the turn the refusal told the agent to spend buys nothing.
 *     The sentence now names two things that do answer: the refused root is already in the
 *     message, and `--evidence-stats` echoes the run's `dir` under the root it resolved.
 *
 * MUTATIONS THIS PINS: put the `required`-reading filter back → case 1 names `gp_attach` and the
 * "answers `{}`" assertion reddens; delete the validate-based filter entirely (fall back to
 * `specs[0]`) → the same case reddens, because `gp_attach` is `TOOL_SPECS[0]`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTrackedMcpServer } from "../dist/dispatch.js";
import { TOOL_BY_NAME, projectErrorRemedy } from "../dist/tools.js";
import { makeEngine } from "./helpers.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Drive the shipped dispatcher the way a JSON-RPC reader does: one bad `params`, read the remedy. */
async function shapeRefusal(params) {
  const { server } = createTrackedMcpServer(makeEngine().engine, () => {});
  await server.handleLine(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  }));
  const response = await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params }));
  return response?.error?.message ?? "";
}

test("the tool named in a tools/call shape remedy answers an empty arguments object", async () => {
  for (const bad of ["gp_observe", null, 42, ["gp_observe"]]) {
    const message = await shapeRefusal(bad);
    if (!/remedy: send \{"name":"/.test(message)) continue;
    const named = message.match(/"name":"(gp_[a-z_]+)"/)?.[1];
    assert.ok(named, `no tool named in: ${message}`);
    const spec = TOOL_BY_NAME.get(named);
    assert.ok(spec, `${named} is not published on this surface`);
    const verdict = spec.validate({});
    assert.equal(verdict.ok, true,
      `the remedy sends {"name":"${named}","arguments":{}} and this shell answers it: ${JSON.stringify(verdict)}`);
  }
});

test("the shape remedy is not the params refusal of the tool it recommends (regression of the artifact repro)", async () => {
  const message = await shapeRefusal("gp_observe");
  const named = message.match(/"name":"(gp_[a-z_]+)"/)?.[1];
  assert.equal(named, "gp_observe", `the example should be a tool that really takes nothing, got ${named}`);
  // And the call the sentence recommends must not come back as GP_E_BAD_PARAMS.
  const { server } = createTrackedMcpServer(makeEngine().engine, () => {});
  await server.handleLine(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  }));
  const follow = await server.handleLine(JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: named, arguments: {} },
  }));
  const text = follow?.result?.content?.[0]?.text ?? "";
  assert.ok(!/GP_E_BAD_PARAMS/.test(text), `following the remedy produced a params refusal: ${text}`);
});

test("GP_E_STATE_ROOT_REFUSED's remedy names no command that fails to answer the question it asks", () => {
  const remedy = projectErrorRemedy("GP_E_STATE_ROOT_REFUSED");
  assert.ok(remedy.length > 0, "the arm must still say something");
  assert.ok(!/--permissions[^\n]*prints its own reading/.test(remedy),
    `--permissions does not print a state root; measured keys are subject/permissions/verdict/verdictSeats/verdictExcludes/seatsNotGranted/next: ${remedy}`);
  assert.ok(/launchctl print/.test(remedy), "the read-only job inspection is the executable half");
  assert.ok(/--evidence-stats/.test(remedy), "the daemon-side command that really echoes a path under the root is named");
});

test("the daemon side backs that claim: --permissions emits no state root and --evidence-stats does emit a path", () => {
  const main = fs.readFileSync(path.join(REPO, "engine", "Sources", "glasspaned", "main.swift"), "utf8");
  const snapshot = fs.readFileSync(
    path.join(REPO, "engine", "Sources", "GlassPaneEngine", "DaemonPermissionSnapshot.swift"), "utf8",
  );
  assert.ok(!/case "stateRoot"/.test(snapshot) && !/"stateRoot": /.test(snapshot),
    "if the permissions snapshot ever starts publishing a state root, the remedy may name it again — re-read this arm then");
  assert.ok(/--evidence-stats/.test(main) && /"dir"/.test(main),
    "the command the remedy points at must exist and print the path key the sentence promises");
});

test("every `glasspaned --<flag>` a remedy names is a flag the daemon parses", () => {
  const main = fs.readFileSync(path.join(REPO, "engine", "Sources", "glasspaned", "main.swift"), "utf8");
  const parsed = new Set([...main.matchAll(/case "--([a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(parsed.size > 10, `the parser table was not found in main.swift (got ${parsed.size} flags) — this control is reading nothing`);
  const tools = fs.readFileSync(path.join(REPO, "mcp-shell", "src", "tools.ts"), "utf8");
  const named = [...tools.matchAll(/glasspaned --([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(named.length > 0, "no remedy names a glasspaned flag — this control is reading nothing");
  for (const flag of new Set(named)) {
    assert.ok(parsed.has(flag), `a remedy names \`glasspaned --${flag}\`, which the daemon does not parse`);
  }
});
