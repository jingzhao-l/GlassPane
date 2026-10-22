import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DIMENSION_ID_LIMITS, dimensionAttributionLine, engineBody, validateDimension } from "../dist/dimension.js";
import { TOOL_BY_NAME, TOOL_SPECS, executeTool } from "../dist/tools.js";
import { canonicalJson } from "../dist/canonical.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { makeEngine, FakeLineIo } from "./helpers.mjs";
import { DIMENSION_ID_MAX_LENGTH, DIMENSION_ID_PATTERN } from "iterate-kernel/dimension-context";

/**
 * Fixed-point tests for 面 A's declared review dimension (specs §8.5 / R40 scenario ②).
 *
 * The fork's half is pinned by `packages/opencode/test/tool/glasspane-surface.test.ts`; these are
 * the same questions asked of the *other* surface — the one that ships as `glasspane-mcp`. Three
 * claims hold this file together, and each is a different failure mode:
 *
 *  1. the shape is the **kernel's**, not a local guess — asserted against the installed package's
 *     own exported constants, the same source `scripts/check-kernel-corpus.mjs` proves equal to the
 *     shipped mirror;
 *  2. the annotation never reaches the **daemon**, and the reply's first content item stays the
 *     daemon's frame byte for byte, because that frame is the engine's contract and this shell does
 *     not own it;
 *  3. the live guard is **reachable**: zod deliberately does not enforce the pattern, so a
 *     malformed declaration is refused by `validateDimension` and not by the schema layer. A change
 *     that "tightened" zod instead would leave a named refusal no caller could ever hit, which this
 *     project counts as undelivered rather than conservative — the leg below is the gate on that.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORK_TOOLS = path.resolve(
  TEST_DIR,
  "../../harness/glasspane-harness/packages/opencode/src/tool/glasspane/index.ts",
);

/** The five tools that carry the slot on this surface, read off the tool table itself. */
function dimensionToolsOn(surface) {
  if (surface === "shell") {
    return TOOL_SPECS.filter((spec) => spec.inputSchema.properties?.dimension !== undefined)
      .map((spec) => spec.name)
      .sort();
  }
  const src = fs.readFileSync(FORK_TOOLS, "utf8");
  const found = [];
  const openRe = /export const (\w+)Params = Schema\.Struct\(\{/g;
  for (const match of src.matchAll(openRe)) {
    let i = match.index + match[0].length;
    let depth = 1;
    while (depth > 0 && i < src.length) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") depth -= 1;
      i += 1;
    }
    const body = src.slice(match[0].length + match.index, i - 1);
    if (body.includes("dimension: DimensionArg")) {
      // `LastEvidenceParams` names the tool `gp_last_evidence`: the params struct is CamelCase,
      // the tool name is snake_case, and neither has anything to do with the kebab-case rule the
      // dimension *ids* follow.
      found.push(`gp_${match[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}`);
    }
  }
  return found.sort();
}

test("the two surfaces carry the dimension slot on exactly the same tools", () => {
  const shell = dimensionToolsOn("shell");
  const fork = dimensionToolsOn("fork");
  assert.deepEqual(
    shell,
    fork,
    `the dimension slot moved on one surface only: shell=${shell.join(",")} fork=${fork.join(",")}`,
  );
  assert.deepEqual(shell, [
    "gp_act",
    "gp_attach",
    "gp_diagnose",
    "gp_last_evidence",
    "gp_observe",
  ]);
});

test("the advertised shape and the live guard read the same kernel constants", () => {
  assert.equal(DIMENSION_ID_LIMITS.maxLength, DIMENSION_ID_MAX_LENGTH);
  assert.equal(DIMENSION_ID_LIMITS.pattern.source, DIMENSION_ID_PATTERN.source);
  for (const name of dimensionToolsOn("shell")) {
    const advertised = TOOL_BY_NAME.get(name).inputSchema.properties.dimension;
    assert.equal(advertised.pattern, DIMENSION_ID_PATTERN.source, `${name}: advertised pattern`);
    assert.equal(advertised.maxLength, DIMENSION_ID_MAX_LENGTH, `${name}: advertised maxLength`);
  }
});

test("the live guard refuses exactly what the kernel pattern refuses", () => {
  const long = "a".repeat(DIMENSION_ID_MAX_LENGTH + 1);
  for (const bad of ["Spec Compliance", "spec_compliance", "security ", long, 7, {}, []]) {
    const result = validateDimension(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} was accepted by the guard`);
    assert.equal(result.error.code, "GP_E_DIMENSION");
    assert.ok(result.error.remedy.length > 0, "a remedy an agent can act on is not optional");
  }
  for (const good of ["security", "spec-compliance", "ui-ux", "a"]) {
    assert.deepEqual(validateDimension(good), { ok: true, dimension: good });
  }
  for (const absent of [undefined, null]) {
    assert.deepEqual(validateDimension(absent), { ok: true }, "absence is legitimate, not an error");
  }
});

test("a declared dimension never reaches the daemon frame", async () => {
  const { engine, io } = makeEngine();
  const promise = executeTool(
    TOOL_BY_NAME.get("gp_observe"),
    { maxDepth: 4, dimension: "security" },
    engine,
    new EvidenceAuditSession(),
  );
  const frame = io.lastFrame();
  assert.deepEqual(frame.params, { maxDepth: 4 });
  assert.ok(!("dimension" in frame.params));
  io.respond({ tree: { role: "AXWindow" } });
  assert.equal((await promise).isError, false);
});

test("engineBody drops only the annotation", () => {
  assert.deepEqual(engineBody({ operationId: "op_1", dimension: "security" }), { operationId: "op_1" });
  assert.deepEqual(engineBody({ dimension: "security" }), {});
  assert.deepEqual(engineBody({ maxDepth: 2 }), { maxDepth: 2 });
});

test("the declaration is echoed as its own item and the frame item does not move", async () => {
  const reply = { operationId: "op_0123456789ABCDEFGHJKMNPQRS", diagnosis: { class: "T0" } };
  const plain = makeEngine();
  const plainPromise = executeTool(TOOL_BY_NAME.get("gp_diagnose"), { operationId: reply.operationId }, plain.engine, new EvidenceAuditSession());
  plain.io.respond(reply);
  const plainResult = await plainPromise;

  const declaredEngine = makeEngine();
  const declaredPromise = executeTool(
    TOOL_BY_NAME.get("gp_diagnose"),
    { operationId: reply.operationId, dimension: "spec-compliance" },
    declaredEngine.engine,
    new EvidenceAuditSession(),
  );
  declaredEngine.io.respond(reply);
  const declaredResult = await declaredPromise;

  assert.equal(declaredResult.isError, false);
  assert.equal(declaredResult.content.length, plainResult.content.length + 1);
  for (let index = 0; index < plainResult.content.length; index += 1) {
    assert.equal(declaredResult.content[index].text, plainResult.content[index].text);
  }
  assert.equal(declaredResult.content[0].text, canonicalJson(reply));
  assert.ok(
    declaredResult.content[declaredResult.content.length - 1].text.startsWith("dimension: spec-compliance"),
    "the echo must name the declaration it echoes",
  );
  const line = dimensionAttributionLine("security");
  assert.ok(line.includes("records no decision"), "the echo claims only what this shell can back");
});

test("a malformed declaration is refused before a frame is written", async () => {
  const { engine, io } = makeEngine();
  const result = await executeTool(
    TOOL_BY_NAME.get("gp_act"),
    { selector: { role: "button" }, action: "press", dimension: "Spec Compliance" },
    engine,
    new EvidenceAuditSession(),
  );
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.startsWith("GP_E_DIMENSION:"), result.content[0].text);
  assert.ok(result.content[0].text.includes("remedy:"), "a refusal without a remedy is a dead end");
  assert.equal(io.sent.length, 0, "a refused call must be a call that never was");
});

test("zod leaves the shape to the guard, so the guard is the live one", async () => {
  const { engine } = makeEngine();
  const result = await executeTool(
    TOOL_BY_NAME.get("gp_last_evidence"),
    { dimension: "spec_compliance" },
    engine,
    new EvidenceAuditSession(),
  );
  assert.equal(result.isError, true);
  // GP_E_BAD_PARAMS would mean the schema layer refused it and validateDimension never ran —
  // the guard would still read green in every other test while being unreachable in production.
  assert.ok(result.content[0].text.startsWith("GP_E_DIMENSION:"), result.content[0].text);
});

test("an undeclared call keeps the ordinary reply shape", async () => {
  const { engine, io } = makeEngine();
  const promise = executeTool(TOOL_BY_NAME.get("gp_attach"), { pid: 4242 }, engine, new EvidenceAuditSession());
  io.respond({ attached: "com.example.App" });
  const result = await promise;
  assert.equal(result.content.length, 1);
  assert.ok(!result.content.some((item) => item.text.startsWith("dimension:")));
});

test("the shell refuses a dimension on a tool that does not carry the slot", async () => {
  const { engine, io } = makeEngine();
  const result = await executeTool(
    TOOL_BY_NAME.get("gp_snapshot"),
    { maxDepth: 3, dimension: "security" },
    engine,
    new EvidenceAuditSession(),
  );
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.startsWith("GP_E_BAD_PARAMS"), result.content[0].text);
  assert.equal(io.sent.length, 0);
});

test("the fake transport used above is the shape the shell really writes", () => {
  const io = new FakeLineIo();
  io.writeLine('{"method":"observe"}');
  assert.equal(io.sent.length, 1);
  assert.throws(() => new FakeLineIo().lastFrame(), /no frame written/);
});
