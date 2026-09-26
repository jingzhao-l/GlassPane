import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  CALLER_VISIBLE_CEILING_MS,
  ENGINE_DEADLINES_MS,
  ENGINE_SOCKET_ENV,
  EngineJsonRpcClient,
  REPLAY_UNSAFE_METHOD_NAMES,
  callerDeadlineMs,
  defaultSocketPath,
  engineClientOver,
  engineDeadlineMs,
  RESTORE_BASE_DEADLINE_MS,
  slowEngineRemedy,
  unixSocketEngineClient,
} from "../dist/engine-client.js";
import { engineWithPayloadAdvice, oversizedReplyAdvice, TOOL_BY_NAME, TOOL_SPECS } from "../dist/tools.js";
import {
  AUDIT_HISTORY_LIMIT,
  EvidenceAuditSession,
  TRAIL_PROVENANCE_NOTES,
  UNKNOWN_GENERATION,
  operationIds,
} from "../dist/audit-session.js";
import { MAX_FRAME_BYTES, OversizeFrameError } from "../dist/io.js";
import { FakeLineIo } from "./helpers.mjs";
import { createTrackedMcpServer } from "../dist/dispatch.js";
import { executableSource } from "./support/source.mjs";

test("call resolves when a matching success frame arrives", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io);
  const promise = client.call("hello");
  const frame = io.lastFrame();
  assert.equal(frame.method, "hello");
  io.respond({ engine: "glasspaned", version: "0.1.0", protocolVersion: "0" });
  const result = await promise;
  assert.equal(result.engine, "glasspaned");
});

test("call rejects with EngineCallError when the daemon returns an error frame", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io);
  const promise = client.call("observe", { maxDepth: 6 });
  io.respondError({ code: "GP_E_NOT_ATTACHED", message: "no app attached", remedy: "call attach first" });
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, "GP_E_NOT_ATTACHED");
    assert.equal(err.remedy, "call attach first");
    return true;
  });
});

test("call rejects on transport error as GP_E_ENGINE_UNREACHABLE", async () => {
  const io = new FakeLineIo();
  const client = engineClientOver(io, 500);
  const promise = client.call("act", {});
  io.emitError(new Error("socket refused"));
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, "GP_E_ENGINE_UNREACHABLE");
    return true;
  });
});

test("a deadline overrun settles the call with a diagnosis", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 30); // short timeout
  await assert.rejects(client.call("diagnose"), (err) => {
    // R4-04: this used to be GP_E_ENGINE_UNREACHABLE plus a restart remedy.
    // A daemon that is still working is neither, and its reply may still land.
    assert.equal(err.code, "GP_E_ENGINE_TIMEOUT");
    assert.ok(err.message.includes("30ms"));
    return true;
  });
});

test("frames with mismatched ids are dropped, later frames still resolve", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io);
  const promise = client.call("hello");
  const frame = io.lastFrame();
  // Unsolicited/out-of-order frame for a different id must be ignored.
  io.send(JSON.stringify({ id: frame.id + 999, result: { junk: true } }));
  io.respond({ engine: "glasspaned" });
  const result = await promise;
  assert.equal(result.engine, "glasspaned");
});
test("unreachable-daemon remedy is an executable restore command (P6 §11 audit 4)", async () => {
  const { daemonUnreachableRemedy } = await import("../dist/engine-client.js");
  const remedy = daemonUnreachableRemedy();
  assert.match(remedy, /--restore-launchd/, "remedy must name the machine-verified restore command, not prose");
});

/**
 * The in-process timeout test above cannot see the real defect: the test
 * runner keeps its own handles alive, so an unreferenced timer still fires.
 * In a bare process the opposite happens — the loop drains, Node exits with
 * an unsettled promise, and the caller never gets a diagnosis at all.
 * CI's first real run (Node 20) cancelled exactly these tests; this proves
 * the settle guarantee in the only environment where it can be observed.
 */
test("a pending call's timeout is delivered even when nothing else keeps the event loop alive", () => {
  const probe = fileURLToPath(new URL("./fixtures/timeout-loop.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 15_000 });
  const stdout = (result.stdout ?? "").trim();
  assert.equal(
    stdout,
    "REJECTED GP_E_ENGINE_TIMEOUT",
    `timeout must settle the call in its own process (exit=${result.status} stderr=${(result.stderr ?? "").trim()})`,
  );
  assert.equal(result.status, 0);
});

/* ------------------------------------------------------------------ *
 * R4-04 / B-4 / R4-05 / B-5 / A-16 / R4-06
 * ------------------------------------------------------------------ */

test("every method's deadline clears the daemon's own worst case", () => {
  // The daemon flags one act at 10s internally, gives a tree walk 10s of its
  // own, and lets an ffwd restore replay up to 64 steps inside one reply.
  for (const [method, deadline] of Object.entries(ENGINE_DEADLINES_MS)) {
    assert.ok(deadline > 10_000, `${method}: ${deadline}ms must beat the 10s internal budget`);
  }
  assert.ok(ENGINE_DEADLINES_MS.act > 2_000 + 2 * 10_000, "act: ping + a tree walk before and after");
  assert.equal(engineDeadlineMs("recent_reports"), 30_000, "unlisted method still has a deadline");
  assert.equal(engineDeadlineMs("restore"), RESTORE_BASE_DEADLINE_MS);
  assert.equal(
    engineDeadlineMs("restore", { steps: new Array(64).fill({}) }),
    RESTORE_BASE_DEADLINE_MS + 64 * ENGINE_DEADLINES_MS.act,
  );
});

test("a deadline overrun says slow, not unreachable, and forbids replaying act", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 30);
  await assert.rejects(client.call("act", {}), (err) => {
    assert.equal(err.code, "GP_E_ENGINE_TIMEOUT");
    assert.ok(err.message.includes("30ms"));
    assert.match(err.message, /still working/);
    assert.match(err.message, /not an unreachable one/);
    assert.match(err.remedy, /gp_probe_status/);
    assert.match(err.remedy, /do NOT re-issue act/);
    return true;
  });
  // R10-高1 re-pins this line. What it used to assert —
  // /re-send the same request with a smaller maxDepth/ — *is* the defect: the
  // transport named a knob and a direction for a request that may already have
  // sent that knob's own schema floor, so the retry it ordered was rejected by the
  // schema it was supposed to help. The equivalent claim now is that a read caller
  // is told to wait rather than to send another copy, and that the narrowing
  // question is pointed at the surface that owns the schema. The guard below, the
  // schema cross-check, and the source scan carry the rest of what this test used
  // to pin.
  const other = new EngineJsonRpcClient(new FakeLineIo(), 30);
  await assert.rejects(other.call("observe", { maxDepth: 1 }), (err) => {
    assert.match(err.remedy, /rather than sending this request again/);
    assert.match(err.remedy, /queues behind the one still running/);
    assert.doesNotMatch(err.remedy, /re-send the same request with a smaller/);
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * R9-中3 found that `slowEngineRemedy`'s tail was one sentence for every
 * method that is not `act`/`restore`/`probe_status` — "retry this read
 * narrower (smaller maxDepth / a tighter selector) — that is safe for a
 * read" — and that it was sent to `attach`, to the operation reads, and to
 * `capture_view`, none of which it describes. Round 9 fixed the *wrong
 * method* half and left the *wrong surface* half in place: the per-family
 * branch still named a knob and a direction, which is R10-高1 — a caller that
 * had already sent the schema's own floor was ordered below it and answered by
 * `GP_E_BAD_PARAMS` from this shell's own zod.
 *
 * What is pinned here is the split, in both directions:
 *  - the transport names no schema-bound parameter next to a narrowing
 *    direction, in its composed answer or in its own source text (`SCAN`);
 *  - the tool layer still does, and must, because that is where the schema is
 *    (`oversizedReplyAdvice` is asserted to violate the transport's rule).
 * ------------------------------------------------------------------ */

/**
 * The parameter names every tool schema in this shell advertises, read off the
 * contract rather than typed out here: a guard whose knob list is a literal in
 * the test can be satisfied by naming a knob the list forgot.
 */
const SCHEMA_PARAMETERS = [...new Set(TOOL_SPECS.flatMap(
  (spec) => Object.keys(spec.inputSchema.properties ?? {}),
))].sort();

/**
 * Verbs whose object is a request parameter. Deliberately a *phrase* list rather
 * than the three words from the bug report, so that "use a tighter selector",
 * "reduce the limit" and "cut your maxDepth down" all read as the same defect.
 */
const NARROWING_DIRECTION = /\b(?:small(?:er|est)|low(?:er|est)?(?:ed)?|tight(?:er)?|narrow(?:s|ed|ing)?|reduc(?:e|es|ed)|shr(?:ink|inks|inking)|shorter|fewer|decreas(?:e|es|ed)|(?:cut|turn|dial|tone)\b[^.;]{0,40}\bdown\b)/i;

/** Any camelCase name: how a knob that no schema in `TOOL_SPECS` has yet still gets caught. */
const CAMEL_NAME = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;

/** Sentence-sized pieces of an agent-facing string. */
function clauses(text) {
  return text.split(/[.;:—!?]+/);
}

/**
 * The pairing rule: a narrowing direction and a parameter named in the same
 * sentence. Naming a reply field in prose (`the operationId it carries`) is not
 * the defect and must stay green, or the guard would be answered by deleting the
 * sentence rather than by moving the claim to the layer that owns it.
 */
function narrowingPairings(text) {
  const offenders = [];
  for (const clause of clauses(text)) {
    if (!NARROWING_DIRECTION.test(clause)) {
      continue;
    }
    for (const name of SCHEMA_PARAMETERS) {
      if (new RegExp(`\\b${name}\\b`, "i").test(clause)) {
        offenders.push(`${name} in "${clause.trim().slice(0, 160)}"`);
      }
    }
    for (const camel of clause.match(CAMEL_NAME) ?? []) {
      offenders.push(`${camel} in "${clause.trim().slice(0, 160)}"`);
    }
  }
  return offenders;
}

/**
 * Every string-literal chain in `src/engine-client.ts`, with comments removed and
 * `${…}` expressions taken out. A chain is the text the transport actually says,
 * including the fragments it writes on separate lines: scanning each quoted
 * fragment on its own would be dodged by putting the knob in the next fragment.
 */
function transportLiteralChains(source) {
  const code = executableSource(source);
  const literal = /"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'/g;
  const chains = [];
  let current = null;
  let last = 0;
  for (const match of code.matchAll(literal)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "")
      .replace(/\$\{[^{}]*\}/g, " ")
      .replace(/\\(["'`\\])/g, "$1");
    const gap = code.slice(last, match.index).replace(/\$\{[^{}]*\}/g, " ");
    const glued = current !== null && /^[\s+]*$/u.test(gap);
    if (glued) {
      current += raw;
    } else {
      if (current !== null) chains.push(current);
      current = raw;
    }
    last = match.index + match[0].length;
  }
  if (current !== null) chains.push(current);
  return chains;
}

/** The round-9 sentence, and the wordings a re-wording would reach for. */
const KNOWN_DEFECT_TEXTS = [
  "then re-send the same request with a smaller maxDepth: these three walk the accessibility tree",
  "then re-send it at a lower scale: this is the capture-and-encode path",
  "use a tighter selector and retry",
  "reduce the limit before sending it again",
  "cut your maxDepth down and re-send",
  // A knob this shell's schemas do not even have yet: the camelCase half is what
  // keeps the rule from being a list of the three names in the bug report.
  "retry with a smaller walkDepth",
];

/** Text that must stay green, so the rule is about the pairing and not about size. */
const ALLOWED_TEXTS = [
  "the operationId it carries can be read off that line and fetched with GET /v1/evidence/<operationId>",
  "What is worth narrowing here, and whether it can still be narrowed at the values this request already sent, is a fact about a schema",
  "narrow this request or ask for less of it; the tool's own schema names the parameters that can shrink a reply",
];

test("the guard's own predicate still sees the defect it was written for", () => {
  // MUTATION THIS PINS: relaxing `narrowingPairings` until it reports nothing,
  // which is how a source-scan gate becomes decoration. Each known-bad wording
  // must produce an offender, each allowed wording must produce none, and the
  // knob vocabulary must come from schemas that still have knobs.
  assert.ok(SCHEMA_PARAMETERS.length >= 15,
    `只解析出 ${SCHEMA_PARAMETERS.length} 个 schema 参数名，词汇表已经不看任何东西了`);
  assert.ok(SCHEMA_PARAMETERS.includes("maxDepth") && SCHEMA_PARAMETERS.includes("scale"),
    `schema 词汇里没有 maxDepth/scale：${SCHEMA_PARAMETERS.join(", ")}`);
  for (const text of KNOWN_DEFECT_TEXTS) {
    assert.ok(narrowingPairings(text).length > 0, `这条旧缺陷文案没有被判定：${text}`);
  }
  for (const text of ALLOWED_TEXTS) {
    assert.deepEqual(narrowingPairings(text), [], `不该被判定的话被判定为缺陷：${text}`);
  }
});

test("the transport's composed timeout answer names no parameter and no direction for one", () => {
  const methods = [...new Set([
    ...Object.keys(ENGINE_DEADLINES_MS),
    ...TOOL_SPECS.map((spec) => spec.engineMethod),
    ...REPLAY_UNSAFE_METHOD_NAMES,
    "recent_reports",
    "a_method_this_shell_has_never_seen",
  ])];
  const offenders = [];
  for (const method of methods) {
    for (const surface of ["mcp", "http"]) {
      for (const pairing of narrowingPairings(slowEngineRemedy(method, surface))) {
        offenders.push(`${method}/${surface}: ${pairing}`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join(" | "));
});

test("src/engine-client.ts says nothing narrower than the answer it composes", () => {
  // MUTATION THIS PINS: putting the knob back in the transport — in a fragment of
  // a chain, or in a sentence that never reaches `slowEngineRemedy` in a test.
  const source = fs.readFileSync(
    fileURLToPath(new URL("../src/engine-client.ts", import.meta.url)),
    "utf8",
  );
  const chains = transportLiteralChains(source);
  assert.ok(chains.length >= 30, `只读出 ${chains.length} 段文本，扫描方式已经对不上这里的写法`);
  // The positive half has to survive the same strip, or an over-eager parse turns
  // this green by reading nothing.
  assert.ok(chains.some((text) => text.includes("do NOT re-issue")),
    "扫描没有读到超时 remedy 的正文，这条闸就成了空转");
  assert.ok(chains.some((text) => /the tool's own schema names the parameters/.test(text)),
    "扫描没有读到超帧 remedy 的那句分权文本，它已经换了写法");
  const offenders = chains.flatMap((text, index) => narrowingPairings(text).map((p) => `#${index}: ${p}`));
  assert.deepEqual(offenders, [], offenders.join(" | "));
});

/**
 * The other half of the split, asserted as a *contrast*: the layer that owns the
 * schema does name knobs and directions, and this shell's guard is not a ban on
 * the sentence. `oversizedReplyAdvice` is the tool layer's exported composer; if
 * it ever stops naming a knob, the transport's deferral points at an answer that
 * is no longer there, and this test is what notices.
 */
test("the tool layer is the one that names knobs, and the transport rule would flag it", () => {
  const observe = TOOL_BY_NAME.get("gp_observe");
  assert.ok(observe, "gp_observe 不在了，这条对照就没有对照物");
  const advice = oversizedReplyAdvice(observe, {});
  assert.ok(narrowingPairings(advice).length > 0,
    `工具层的窄化建议不再点名参数，分权就成了空话：${advice}`);
  assert.match(advice, /maxDepth/, advice);
});

/**
 * The properties every tool that forwards this engine method advertises — the
 * intersection, because advice addressed to a method is read by the caller of
 * whichever tool sent it, and a knob only one of them has is not advice the
 * other can execute.
 */
function schemaProperties(engineMethod) {
  const specs = TOOL_SPECS.filter((spec) => spec.engineMethod === engineMethod);
  assert.ok(specs.length >= 1, `${engineMethod} is forwarded by no tool, so this check has no schema to read`);
  const lists = specs.map((spec) => Object.keys(spec.inputSchema.properties ?? {}));
  return lists[0].filter((name) => lists.every((list) => list.includes(name)));
}

/** The part of the remedy that carries the wait/retry instruction. */
const WAIT_CLAUSE = "still working on this one, so ";
function tailOf(remedy) {
  const at = remedy.indexOf(WAIT_CLAUSE);
  assert.notEqual(at, -1, `remedy has no wait clause to read: ${remedy.slice(0, 160)}`);
  return remedy.slice(at + WAIT_CLAUSE.length);
}

test("the re-issue ban covers the methods that change state, each with its own reason", () => {
  for (const method of ["act", "restore", "attach"]) {
    const remedy = slowEngineRemedy(method);
    assert.match(remedy, new RegExp(`do NOT re-issue ${method}`),
      `${method} must be told not to re-issue: its reply is not a read`);
    assert.ok(!/maxDepth|tighter selector|narrower/.test(tailOf(remedy)),
      `${method}'s remedy must not read as a narrowing retry`);
  }
  // `attach` is the one this defect was about: the reason has to name what it
  // actually does, or the sentence is a prohibition with no explanation.
  assert.match(slowEngineRemedy("attach"), /re-point the daemon at another app/);
  assert.match(slowEngineRemedy("attach"), /discard the trail/);
  assert.match(slowEngineRemedy("act"), /take effect on the user's screen/);
});

test("no timeout remedy names a parameter at all, whatever its method's schema has", () => {
  // R10-高1 re-pins the round-9 cross-check. That test asserted, per family, that
  // the remedy named *its own* knob (`observe` -> `maxDepth`, `capture_view` ->
  // `scale`) and that the knob existed in the schema; the claim that survives is
  // the stricter one — the transport names none — while the schema still has to
  // carry the knobs the tool layer will name, or the deferral points at nothing.
  const families = ["observe", "snapshot", "audit_ui", "assert_element", "capture_view", "diagnose", "last_evidence"];
  for (const method of families) {
    const tail = tailOf(slowEngineRemedy(method));
    const advertised = schemaProperties(method);
    for (const knob of SCHEMA_PARAMETERS) {
      assert.ok(!new RegExp(`\\b${knob}\\b`, "i").test(tail),
        `${method}'s remedy names ${knob}, a parameter the transport has no schema to read: ${tail.slice(0, 200)}`);
    }
    // The deferral has to land somewhere real: the tool that can be told to
    // narrow still advertises the knob the transport refuses to name.
    assert.ok(advertised.length >= 1, `${method} 的工具 schema 一个参数都没有，分权就没有对象`);
  }
  for (const method of ["observe", "snapshot", "audit_ui"]) {
    assert.ok(schemaProperties(method).includes("maxDepth"),
      `${method} 的 schema 不再 advertise maxDepth，工具层的窄化建议就失去了出处`);
  }
  assert.ok(schemaProperties("capture_view").includes("scale"),
    "capture_view 的 schema 不再 advertise scale，同上");
});

test("the timeout answer keeps the facts it can see and hands the rest over", () => {
  // What replaced "re-send it unchanged / there is nothing to narrow" (a schema
  // claim) and "re-send only if it changes or records nothing" (a *method* name an
  // MCP caller cannot call, and a safety promise about a call this layer cannot
  // classify). The transport states its own deadline was spent, says the daemon is
  // still working on this request, tells the caller not to queue a second copy —
  // and per surface names where the narrowing question is actually answered.
  const facts = [
    /rather than sending this request again/,
    /queues behind the one still running/,
    /is a fact about a schema/,
  ];
  for (const method of ["diagnose", "last_evidence", "recent_reports", "a_method_this_shell_has_never_seen"]) {
    const remedy = slowEngineRemedy(method, "mcp");
    // The two facts this layer can actually see: the wait is spent, and the daemon
    // is working on *this* request. Everything else in the answer is a pointer.
    assert.match(remedy, /still working on this one/);
    const tail = tailOf(remedy);
    for (const fact of facts) {
      assert.match(tail, fact, `${method} 的出路不再说这句它看得到的事实：${tail.slice(0, 240)}`);
    }
    // The MCP caller is pointed at the tool list it actually holds, and the
    // promise that a re-send is safe is gone: whether a call changes anything is
    // stated by its own tool description, not by this file.
    assert.match(tail, /gp_\*/);
    assert.ok(!/do NOT re-issue/.test(tail),
      "可重放的一支不得借用 no-replay 的标记，否则 tools.test.mjs 的对照失去区分");
  }
  const http = tailOf(slowEngineRemedy("observe", "http"));
  assert.match(http, /this gateway publishes no parameter listing/);
  assert.ok(!/gp_\*/.test(http), `curl 调用方手上没有 gp_* 可调：${http.slice(0, 200)}`);
});

test("a timed-out call keeps its entry so the late reply is still delivered", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 30);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));

  const promise = client.call("observe", { maxDepth: 10 });
  const frame = io.lastFrame();
  await assert.rejects(promise, (err) => err.code === "GP_E_ENGINE_TIMEOUT");
  assert.ok(notes.some((note) => /still in flight/.test(note)), notes.join(" | "));

  // The daemon finishes the work after the shell already answered: the real
  // result must reach the log instead of being dropped on the floor, and a
  // later call on the same client must still work.
  io.send(JSON.stringify({ id: frame.id, result: { tree: "the-real-answer" } }));
  const late = notes.find((note) => /late engine reply/.test(note));
  assert.ok(late, `expected a late-reply note, saw: ${notes.join(" | ")}`);
  assert.match(late, /'observe'/);
  assert.match(late, /the-real-answer/);

  const survivor = client.call("snapshot");
  io.respond({ snapshotId: "snap_OK" });
  assert.deepEqual(await survivor, { snapshotId: "snap_OK" });
});

test("an id-less error frame surfaces the daemon's real code, not a restart story", async () => {
  const io = new FakeLineIo();
  const client = engineClientOver(io, 5_000);
  const promise = client.call("observe", { maxDepth: 10 });
  // The daemon's own oversize answer loses the request id; the serialization
  // fallback answer omits the key entirely. Both must reach the caller.
  io.send(JSON.stringify({
    id: null,
    error: {
      code: "GP_E_PAYLOAD_TOO_LARGE",
      message: "frame exceeds 4194304 bytes",
      remedy: "reduce observe maxDepth or narrow the selector scope",
    },
  }));
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, "GP_E_PAYLOAD_TOO_LARGE");
    assert.equal(err.remedy, "reduce observe maxDepth or narrow the selector scope");
    assert.match(err.message, /frame exceeds 4194304 bytes/);
    // The attribution is an inference and says so.
    assert.match(err.message, /carried no request id/);
    assert.match(err.message, /method 'observe'/);
    return true;
  });

  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  const other = client.call("attach", { bundleId: "com.example.app" });
  const frame = io.lastFrame();
  io.send(JSON.stringify({ id: frame.id + 500, error: { code: "GP_E_X", message: "m", remedy: "r" } }));
  let state = "pending";
  other.then(() => { state = "resolved"; }, () => { state = "rejected"; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state, "pending", "a frame for an id we never issued must not settle another call");
  assert.ok(notes.some((note) => /never issued/.test(note)), notes.join(" | "));
  io.respond({ attached: true });
  assert.deepEqual(await other, { attached: true });
});

test("an oversized reply fails only the call it belonged to", async () => {
  const io = new FakeLineIo();
  const client = engineClientOver(io, 5_000);
  const doomed = client.call("observe", { maxDepth: 10 });
  const doomedId = io.lastFrame().id;
  const survivor = client.call("probe_status");

  io.emitError(new OversizeFrameError(MAX_FRAME_BYTES + 1, `{"id":${doomedId},"result":{"tree":`));
  await assert.rejects(doomed, (err) => {
    assert.equal(err.code, "GP_E_PAYLOAD_TOO_LARGE");
    assert.match(err.message, /connection is intact/);
    assert.doesNotMatch(err.message, /carried no request id/, "the id was recovered, so no inference");
    // The transport states the fact and points at the schema; it no longer
    // guesses which knobs this particular method has (R8d-高2 — that guess made
    // `gp_observe` with a default maxDepth get told it had nothing to narrow).
    // The concrete advice is composed by the tool layer and asserted there.
    assert.match(err.remedy, /the tool's own schema names the parameters/);
    return true;
  });
  io.respond({ connected: false });
  assert.deepEqual(await survivor, { connected: false });
});

test("an oversized reply with an unreadable head is attributed by arrival order", async () => {
  const io = new FakeLineIo();
  const client = engineClientOver(io, 5_000);
  const first = client.call("observe");
  const second = client.call("snapshot");
  io.emitError(new OversizeFrameError(MAX_FRAME_BYTES + 9, "xxxx"));
  await assert.rejects(first, (err) => {
    assert.equal(err.code, "GP_E_PAYLOAD_TOO_LARGE");
    assert.match(err.message, /carried no request id/);
    assert.match(err.message, /method 'observe'/);
    return true;
  });
  io.respond({ snapshotId: "snap_OK" });
  assert.deepEqual(await second, { snapshotId: "snap_OK" });
});

test("a settled call leaves no deadline timer behind", async () => {
  const DEADLINE = 4321;
  const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const live = [];
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = real.set.call(globalThis, fn, ms, ...args);
    if (ms === DEADLINE) {
      live.push(handle);
    }
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    const index = live.indexOf(handle);
    if (index !== -1) {
      live.splice(index, 1);
    }
    return real.clear.call(globalThis, handle);
  };
  try {
    const io = new FakeLineIo();
    const client = new EngineJsonRpcClient(io, DEADLINE);
    const promise = client.call("hello");
    assert.equal(live.length, 1, "an outstanding request holds its deadline handle");
    io.respond({ engine: "glasspaned" });
    await promise;
    assert.equal(live.length, 0, "the success path must clear the timer");

    const second = client.call("hello");
    io.close(); // transport teardown is the other settle path
    await assert.rejects(second, (err) => err.code === "GP_E_ENGINE_UNREACHABLE");
    assert.equal(live.length, 0, "the close path must clear it too");
  } finally {
    globalThis.setTimeout = real.set;
    globalThis.clearTimeout = real.clear;
  }
});

test("close() settles an outstanding call instead of leaking it", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 4321);
  const promise = client.call("observe");
  client.close();
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, "GP_E_ENGINE_UNREACHABLE");
    assert.match(err.message, /client closed/);
    return true;
  });
});

/* ------------------------------- A-16 ------------------------------- */

/** Duplex whose write side never loops back into its read side. */
class FakeEngineSocket extends Duplex {
  sent = [];

  _write(chunk, _encoding, callback) {
    this.sent.push(chunk.toString());
    callback();
  }

  _read() {}

  deliver(object) {
    this.push(JSON.stringify(object) + "\n");
  }

  frames() {
    return this.sent.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
}

function socketBackedClient(identity, callerCeilingMs) {
  const sockets = [];
  const client = unixSocketEngineClient("/tmp/glasspane-fake-engine.sock", {
    identity,
    ...(callerCeilingMs === undefined ? {} : { callerCeilingMs }),
    open: () => {
      const socket = new FakeEngineSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { client, sockets };
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("nothing connects until the daemon is actually asked for something", async () => {
  const { client, sockets } = socketBackedClient();
  assert.equal(sockets.length, 0, "construction must not connect");
  const promise = client.call("probe_status");
  assert.equal(sockets.length, 1, "the first call opens exactly one connection");
  assert.deepEqual(sockets[0].frames(), [{ id: 0, method: "probe_status" }]);
  sockets[0].deliver({ id: 0, result: { connected: false } });
  assert.deepEqual(await promise, { connected: false });
  client.close();
});

test("after the daemon closes the socket the next call reconnects and succeeds", async () => {
  const { client, sockets } = socketBackedClient();
  const first = client.call("observe", { maxDepth: 2 });
  sockets[0].deliver({ id: 0, result: { tree: [] } });
  assert.deepEqual(await first, { tree: [] });

  sockets[0].destroy(); // the daemon restarts: the reason --restore-launchd exists
  await nextTick();

  const second = client.call("snapshot");
  assert.equal(sockets.length, 2, "a closed connection is replaced, never reused");
  const frame = sockets[1].frames()[0];
  assert.equal(frame.method, "snapshot");
  sockets[1].deliver({ id: frame.id, result: { snapshotId: "snap_OK" } });
  assert.deepEqual(await second, { snapshotId: "snap_OK" });
  client.close();
});

test("a refused connection settles its waiter and is retried on the next call", async () => {
  const { client, sockets } = socketBackedClient();
  const waiting = client.call("attach", { bundleId: "com.example.app" });
  sockets[0].destroy(new Error("ECONNRESET"));
  await assert.rejects(waiting, (err) => {
    assert.equal(err.code, "GP_E_ENGINE_UNREACHABLE");
    assert.match(err.message, /ECONNRESET/);
    assert.match(err.remedy, /--restore-launchd/);
    return true;
  });
  const retry = client.call("attach", { bundleId: "com.example.app" });
  assert.equal(sockets.length, 2);
  sockets[1].deliver({ id: sockets[1].frames()[0].id, result: { attached: true } });
  assert.deepEqual(await retry, { attached: true });
  client.close();
});

/* ------------------------------- B-02 ------------------------------- */

/**
 * The R4-04 deadlines were written against the *daemon's* worst case, which is
 * longer than an MCP client's own request timeout: the client gave up, the agent
 * got no code and no remedy, and it re-issued the act — the same click on the
 * user's screen a second time. The caller's wait is capped, and the entry stays
 * registered so the real reply is still reported.
 */
test("the caller's wait is capped below a client's patience for every method", () => {
  assert.ok(
    CALLER_VISIBLE_CEILING_MS >= 45_000 && CALLER_VISIBLE_CEILING_MS <= 55_000,
    `ceiling ${CALLER_VISIBLE_CEILING_MS}ms must sit inside a client-safe 45–55 s`,
  );
  assert.ok(
    ENGINE_DEADLINES_MS.act > CALLER_VISIBLE_CEILING_MS,
    "act's own deadline is the case the ceiling exists to cap",
  );
  assert.equal(callerDeadlineMs("act"), CALLER_VISIBLE_CEILING_MS);
  assert.equal(
    callerDeadlineMs("restore", { steps: new Array(64).fill({}) }),
    CALLER_VISIBLE_CEILING_MS,
    "a 64-step ffwd restore must not hold a client for two hours",
  );
  assert.equal(
    callerDeadlineMs("probe_status"),
    ENGINE_DEADLINES_MS.probe_status,
    "a method already inside the ceiling keeps its own deadline",
  );
  assert.ok(callerDeadlineMs("recent_reports") <= CALLER_VISIBLE_CEILING_MS, "unlisted methods are capped too");
  for (const method of Object.keys(ENGINE_DEADLINES_MS)) {
    assert.ok(callerDeadlineMs(method) <= CALLER_VISIBLE_CEILING_MS, `${method} exceeds the ceiling`);
  }
});

test("an act that outlives the ceiling is answered with the timeout code and remedy, and stays tracked", async () => {
  const { client, sockets } = socketBackedClient(undefined, 30); // 30 ms ceiling
  const notes = [];
  client.onEngineNote((note) => notes.push(note));

  await assert.rejects(
    client.call("act", { selector: { role: "AXButton" }, action: "press" }),
    (err) => {
      assert.equal(err.code, "GP_E_ENGINE_TIMEOUT");
      assert.match(err.message, /no reply after 30ms/);
      // The daemon's own worst case is still stated: the request was not
      // abandoned, only the caller's wait was ended.
      assert.match(err.message, /30ms while the daemon gets up to 120000ms for 'act'/);
      assert.match(err.remedy, /do NOT re-issue act/);
      assert.match(err.remedy, /gp_probe_status/);
      return true;
    },
  );
  assert.ok(notes.some((note) => /still in flight/.test(note)), notes.join(" | "));

  // Answering early must not throw the reply away — this is where an agent (or
  // a human reading the log) finds out what the click actually did.
  const actFrame = sockets[0].frames()[0];
  sockets[0].deliver({ id: actFrame.id, result: { operationId: "op_X", actConfirmed: true } });
  const late = notes.find((note) => /late engine reply for 'act'/.test(note));
  assert.ok(late, `expected a late-reply note, saw: ${notes.join(" | ")}`);
  assert.match(late, /actConfirmed/);

  // And the same client keeps serving cheap calls after the capped one settled.
  const status = client.call("probe_status");
  const statusFrame = sockets[0].frames()[1];
  assert.equal(statusFrame.method, "probe_status");
  sockets[0].deliver({ id: statusFrame.id, result: { connected: true } });
  assert.deepEqual(await status, { connected: true });
  client.close();
});

/* ------------------------------- R4-06 ------------------------------ */

test("each fresh connection handshakes and reports what it measured", async () => {
  const { client, sockets } = socketBackedClient({ version: "9.9.9" });
  const notes = [];
  client.onEngineNote((note) => notes.push(note));

  const promise = client.call("observe");
  sockets[0].emit("connect");
  const hello = sockets[0].frames().find((frame) => frame.method === "hello");
  assert.ok(hello, "the shell must ask the daemon what it speaks, once per connection");

  sockets[0].deliver({ id: hello.id, result: { engine: "glasspaned", version: "1.1.0", protocolVersion: "9" } });
  await nextTick();
  assert.match(notes.join(" | "), /protocol mismatch/);
  assert.doesNotMatch(notes.join(" | "), /version mismatch/, "a protocol mismatch is reported first");

  sockets[0].deliver({ id: sockets[0].frames()[0].id, result: { tree: [] } });
  await promise;
  client.close();

  // A matching protocol still compares versions, and a self-report without one
  // is stated as unmeasured rather than assumed compatible.
  const ok = socketBackedClient({ version: "9.9.9" });
  const okNotes = [];
  ok.client.onEngineNote((note) => okNotes.push(note));
  const second = ok.client.call("observe");
  ok.sockets[0].emit("connect");
  const okHello = ok.sockets[0].frames().find((frame) => frame.method === "hello");
  ok.sockets[0].deliver({ id: okHello.id, result: { engine: "glasspaned", version: "1.1.0", protocolVersion: "0" } });
  await nextTick();
  assert.match(okNotes.join(" | "), /version mismatch/);
  assert.doesNotMatch(okNotes.join(" | "), /protocol mismatch/);
  ok.sockets[0].deliver({ id: ok.sockets[0].frames()[0].id, result: { tree: [] } });

  const silent = socketBackedClient();
  const silentNotes = [];
  silent.client.onEngineNote((note) => silentNotes.push(note));
  const third = silent.client.call("observe");
  silent.sockets[0].emit("connect");
  const silentHello = silent.sockets[0].frames().find((frame) => frame.method === "hello");
  silent.sockets[0].deliver({ id: silentHello.id, result: { engine: "glasspaned" } });
  await nextTick();
  assert.match(silentNotes.join(" | "), /has no protocolVersion/);

  silent.sockets[0].deliver({ id: silent.sockets[0].frames()[0].id, result: { tree: [] } });
  await Promise.all([second, third]);
  ok.client.close();
  silent.client.close();
});

/* ------------------------------------------------------------------ *
 * Where the daemon socket is (A-1 family: the default is a guess, and
 * saying so is the fix — the shell cannot ask a daemon it has not met).
 * ------------------------------------------------------------------ */

test("the default socket path is a $HOME guess, and its own text says which guess", () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, ENGINE_SOCKET_ENV);
  const saved = process.env[ENGINE_SOCKET_ENV];
  try {
    // The override is the route that works under a redirected HOME, so it is
    // the behaviour worth pinning: honoured, and ahead of the guess.
    process.env[ENGINE_SOCKET_ENV] = "/tmp/gp-sock-env/engine.sock";
    assert.equal(defaultSocketPath(), "/tmp/gp-sock-env/engine.sock");

    delete process.env[ENGINE_SOCKET_ENV];
    const fallback = defaultSocketPath();
    assert.equal(
      fallback,
      path.join(os.homedir(), ".glasspane", "engine.sock"),
      "with nothing set the default is the folder under the HOME this process sees",
    );
    assert.ok(
      fallback.startsWith(`${os.homedir()}/`),
      `${fallback}: outside its own home the default would be a different guess`,
    );

    // Honest-by-construction: the divergence to `NSHomeDirectory()`, and the
    // `--state-dir` case the guess can never reach, have to be written down at
    // the definition — a caller reading the help text is the only defence here.
    const source = fs.readFileSync(
      fileURLToPath(new URL("../src/engine-client.ts", import.meta.url)),
      "utf8",
    );
    const at = source.indexOf("export function defaultSocketPath");
    assert.notEqual(at, -1, "defaultSocketPath must stay the one place the default is resolved");
    const doc = source.slice(0, at).split("/**").pop();
    assert.ok(doc.includes(ENGINE_SOCKET_ENV), "the override must be named by its value, not by a re-typed string");
    assert.match(doc, /NSHomeDirectory/, "the other side's home lookup must be named");
    assert.match(doc, /\$HOME/, "the fact that this side reads the HOME variable must be stated");
    assert.match(doc, /daemon\.sock|--state-dir/, "the state-dir socket the default can never find must be stated");
  } finally {
    if (had) process.env[ENGINE_SOCKET_ENV] = saved;
    else delete process.env[ENGINE_SOCKET_ENV];
  }
});

/** The built CLI's `--help`, i.e. the text an agent reads when the socket is wrong. */
function usageText() {
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `--help exited ${result.status}: ${(result.stderr ?? "").trim()}`);
  return result.stdout;
}

test("usage names the two routes an agent can run itself and does not promise HOME matches", () => {
  const text = usageText();
  // The true property is not a phrasing: it is that both exits — and the shape
  // each needs — are in the text, because either one alone leaves the agent
  // asking a human where the daemon is.
  assert.ok(text.includes(ENGINE_SOCKET_ENV), `usage must name the env override (${ENGINE_SOCKET_ENV})`);
  assert.match(text, /--socket-path\s*[<=]/, "usage must give --socket-path in a copyable shape");
  // The case no HOME value can reach, so naming it is what keeps this from
  // being a choice between two guesses.
  assert.match(text, /daemon\.sock/, "the --state-dir daemon's socket name must appear");
  // And how to find the live value without deriving anything: a command.
  assert.match(text, /launchctl print/, "usage must give the command that reads the socket the daemon is on");
  // The claim that made the default a trap was that $HOME is how the daemon
  // picks too. It has to read as this shell's guess instead.
  assert.doesNotMatch(
    text,
    /the daemon socket defaults to|daemon[^\n]{0,40}defaults? to \$HOME/i,
    "usage must not present the $HOME guess as the daemon's own default",
  );
  assert.match(text, /guess/, "the default has to be called what it is: a guess this process makes");
});

/* ------------------------------------------------------------------ *
 * R8-高3: the late-reply sink. A reply that lands after its caller was
 * answered names an operation that really ran; logging it is not enough,
 * because the operationId has to reach the session trail that
 * `gp_recent_reports` reads (see tools.test.mjs for the product path).
 * ------------------------------------------------------------------ */

test("a late reply hands its result body to the registered sink", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 20);
  const seen = [];
  client.onLateReply((reply) => seen.push(reply));

  const promise = client.call("act", {}).catch(() => undefined);
  const frame = io.lastFrame();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await promise;
  assert.equal(seen.length, 0, "没有回复就不该有 sink 调用");

  io.send(JSON.stringify({ id: frame.id, result: { operationId: "op_late_1", actConfirmed: true } }));
  assert.equal(seen.length, 1, "迟到回复必须交给 sink");
  assert.equal(seen[0].method, "act");
  assert.equal(seen[0].result.operationId, "op_late_1");
  // This frame echoed the id `call()` sent, so the attribution is confirmed and the
  // sink is told so: R10-中2's whole point is that the trail can tell this case from
  // the arrival-order one below.
  assert.equal(seen[0].attribution, "echoed-id");
  // The correlation is what lets the caller tell "this belongs to the trail I am
  // writing now" from "this belongs to a superseded attach" (R8b-高1); a call
  // that passed none reads back as none.
  assert.equal(seen[0].correlation, undefined);
  client.close();
});

test("a late error frame and an evicted entry reach no sink", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 20);
  const seen = [];
  client.onLateReply((reply) => seen.push(reply));

  const errorPromise = client.call("act", {}).catch(() => undefined);
  const errorFrame = io.lastFrame();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await errorPromise;
  io.send(JSON.stringify({
    id: errorFrame.id,
    error: { code: "GP_E_ACT_FAILED", message: "no such element", remedy: "re-observe" },
  }));
  assert.equal(seen.length, 0, "错误帧里没有 operationId，不该冒充一次记录");

  // The retention window is what bounds this tracking; past it the entry is gone
  // and the sink cannot be called — which is why the eviction is logged.
  const dropped = [];
  client.onEngineNote((note) => dropped.push(note));
  const first = client.call("act", {}).catch(() => undefined);
  const firstFrame = io.lastFrame();
  for (let i = 0; i < 20; i++) {
    await client.call("probe_status", {}).catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  await first;
  io.send(JSON.stringify({ id: firstFrame.id, result: { operationId: "op_evicted" } }));
  assert.equal(seen.length, 0, "被保留窗挤掉的条目不得再写链");
  assert.ok(dropped.some((note) => note.includes("retention cap")),
    "挤掉必须自己说出来");
  client.close();
});

test("the correlation a call was given comes back with its late reply", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 20);
  const seen = [];
  client.onLateReply((reply) => seen.push(reply));

  const promise = client.call("act", {}, 7).catch(() => undefined);
  const frame = io.lastFrame();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await promise;
  io.send(JSON.stringify({ id: frame.id, result: { operationId: "op_gen_7" } }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].correlation, 7,
    "客户端把链纪元交给我们，迟到回复时必须原样还回来，否则接线方无从判断该不该写");
  client.close();
});

test("a sink that throws is reported and keeps the transport alive", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 20);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  client.onLateReply(() => {
    throw new Error("sink exploded");
  });

  const promise = client.call("act", {}).catch(() => undefined);
  const frame = io.lastFrame();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await promise;
  io.send(JSON.stringify({ id: frame.id, result: { operationId: "op_x" } }));
  assert.ok(notes.some((note) => note.includes("late-reply sink failed") && note.includes("sink exploded")),
    `sink 抛错必须被点名，而不是静默或炸掉连接：${JSON.stringify(notes)}`);

  // The connection is still usable afterwards.
  const next = client.call("diagnose");
  io.respond({ class: "T1", report: {} });
  assert.deepEqual(await next, { class: "T1", report: {} });
  client.close();
});

/* ------------------------------------------------------------------ *
 * R9-高1 — arrival-order attribution.
 *
 * The daemon answers in the order it received requests, so the request an
 * id-less frame belongs to is the oldest one this client still *tracks* —
 * including one whose caller was already answered at the deadline. Attributing
 * by "oldest the caller is still waiting on" instead handed that other
 * request's failure to the next caller, deleted the entry its own reply was
 * still tracked under, and made the reply that then landed read as a frame
 * this client never issued. Every test in this block reddens on exactly that
 * swap (`oldestTracked` back to `oldestOpen`).
 * ------------------------------------------------------------------ */

/** Answers `promise` in the background and reports which way it settled. */
function track(promise) {
  const state = { value: "pending" };
  promise.then(() => { state.value = "resolved"; }, () => { state.value = "rejected"; });
  return state;
}

/** Lets a frame handler and a rejected sink run, without advancing any timer. */
async function flush() {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Every test below drives the first request's deadline with `t.mock.timers`, so
 * the *second* request's deadline cannot expire underneath it: with real timers
 * a 20 ms window under a loaded runner let the queued request time out between
 * two `setImmediate`s, and the test then failed on the harness instead of on the
 * code.
 */
function timedOutClient(t, io, deadlineMs) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return new EngineJsonRpcClient(io, deadlineMs);
}

/**
 * Fires the deadline of the request that is outstanding right now. Every caller
 * below is `.catch()`-ed *before* this runs: the tick rejects it synchronously,
 * and a rejection with no handler attached yet is an unhandled rejection that
 * fails the file for the wrong reason.
 */
async function expire(t, deadlineMs) {
  t.mock.timers.tick(deadlineMs);
  await flush();
}

test("an id-less error belongs to the request that timed out, not to the caller still waiting", async (t) => {
  const io = new FakeLineIo();
  const client = timedOutClient(t, io, 20);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  const seen = [];
  client.onLateReply((reply) => seen.push(reply));

  const act = client.call("act", { selector: { role: "AXButton" }, action: "press" }).catch((err) => err.code);
  await expire(t, 20);
  assert.equal(await act, "GP_E_ENGINE_TIMEOUT");
  const probe = client.call("probe_status");
  const probeState = track(probe);

  // The daemon's failure for the *act*, with the id lost on its way out.
  io.send(JSON.stringify({
    id: null,
    error: { code: "GP_E_ACT_FAILED", message: "the element moved", remedy: "re-observe and press again" },
  }));
  await flush();

  assert.equal(probeState.value, "pending",
    "a frame answering a request whose caller already gave up must not settle the next caller");
  assert.ok(!notes.some((note) => /no request in flight/.test(note)),
    `a request was tracked, so the note may not claim none was: ${JSON.stringify(notes)}`);
  const late = notes.find((note) => /late engine reply for 'act'/.test(note));
  assert.ok(late, `expected the act's late error to be reported as its own: ${JSON.stringify(notes)}`);
  assert.match(late, /GP_E_ACT_FAILED/);
  assert.match(late, /is an error frame/);
  assert.match(late, /no operationId/);
  assert.match(late, /attributed by arrival order/);
  assert.equal(seen.length, 0, "an error frame names no operationId, so it may not be recorded as an operation");

  // The tracked entry the frame answered is gone; the probe's real reply, by
  // its own id, is still delivered normally.
  io.respond({ connected: true });
  assert.deepEqual(await probe, { connected: true });

  // And only now, with nothing tracked, is "no request in flight" the truth.
  io.send(JSON.stringify({ id: null, error: { code: "GP_E_X", message: "m", remedy: "r" } }));
  assert.ok(notes.some((note) => /with no request in flight: /.test(note)), JSON.stringify(notes));
  client.close();
});

test("an id-less reply for a request the caller gave up on still reaches the trail sink", async (t) => {
  const io = new FakeLineIo();
  const client = timedOutClient(t, io, 20);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  const seen = [];
  client.onLateReply((reply) => seen.push(reply));

  const act = client.call("act", {}).catch(() => undefined);
  await expire(t, 20);
  await act;
  const probe = client.call("probe_status");
  const probeState = track(probe);
  io.send(JSON.stringify({ id: undefined, result: { operationId: "op_idless", actConfirmed: true } }));
  await flush();

  assert.equal(seen.length, 1, "a result frame with an operationId is exactly what the sink exists for");
  assert.equal(seen[0].method, "act", "it belongs to the act, not to the request queued behind it");
  assert.equal(seen[0].result.operationId, "op_idless");
  // R10-中2: the frame echoed no id, so *which request* this answers is a guess, and
  // the guess has to travel with the body instead of being smoothed over on the way
  // to the trail. MUTATION THIS PINS: `reportLateReply(target, frame, true)` going
  // back to the default (the id-less path claiming a confirmed attribution).
  assert.equal(seen[0].attribution, "arrival-order",
    "没有回显 id 的迟到回复，不得以'已确认'的身份进 sink");
  assert.equal(probeState.value, "pending");
  const idLessNote = notes.find((note) => /late engine reply for 'act'/.test(note)) ?? "";
  assert.match(idLessNote, /attributed by arrival order/);
  assert.match(idLessNote, /echoed no request id/, "note 必须说清这是猜的，没有任何回显 id 证实它");
  assert.match(idLessNote, /inferred/);
  io.respond({ connected: false });
  assert.deepEqual(await probe, { connected: false });
  client.close();
});

test("an id-less result is never guessed onto a caller that is still waiting", async () => {
  const io = new FakeLineIo();
  const client = engineClientOver(io, 5_000);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  const observe = client.call("observe", { maxDepth: 10 });
  const state = track(observe);

  io.send(JSON.stringify({ id: null, result: { tree: "belongs to someone else" } }));
  await flush();
  assert.equal(state.value, "pending",
    "the daemon's id-less answers are error frames; a result with no id is not this caller's answer");
  assert.ok(notes.some((note) => /was not delivered to any caller/.test(note)), JSON.stringify(notes));
  assert.ok(notes.some((note) => /'observe' \(id 0\) is still waiting/.test(note)), JSON.stringify(notes));

  io.respond({ tree: [] });
  assert.deepEqual(await observe, { tree: [] });
  client.close();
});

test("an oversized frame with no readable id skips a settled request only to its own caller", async (t) => {
  const io = new FakeLineIo();
  const client = timedOutClient(t, io, 20);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  const observe = client.call("observe", { maxDepth: 10 }).catch(() => undefined);
  await expire(t, 20);
  await observe;
  const snapshot = client.call("snapshot");
  const state = track(snapshot);
  io.emitError(new OversizeFrameError(MAX_FRAME_BYTES + 9, "xxxx"));
  await flush();

  assert.equal(state.value, "pending", "the oversized frame is the observe's late reply, not the snapshot's");
  assert.ok(notes.some((note) => /late reply to 'observe'/.test(note)
    && /attributed by arrival order/.test(note)), JSON.stringify(notes));
  io.respond({ snapshotId: "snap_OK" });
  assert.deepEqual(await snapshot, { snapshotId: "snap_OK" });
  client.close();
});

/* ------------------------------------------------------------------ *
 * R9-中1 — the tracking window has an end, and it has to say so. `onDeadline`
 * tells the caller the request "stays registered" and `lateReplyRoute` points
 * at that registration; a transport that goes away first deletes the entries
 * that promise was standing on. Silent here meant an agent reading the log for
 * an operation that really ran could not tell "not tracked anymore" from
 * "never happened" — the difference that decides whether it clicks again.
 * The mutation: drop the teardown note and keep the silent `pending.clear()`.
 * ------------------------------------------------------------------ */

test("the transport going away reports the late replies it stopped tracking", async (t) => {
  const io = new FakeLineIo();
  const client = timedOutClient(t, io, 20);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  const seen = [];
  client.onLateReply((reply) => seen.push(reply));

  for (const method of ["act", "observe"]) {
    const call = client.call(method, {}).catch((err) => err.code);
    await expire(t, 20);
    assert.equal(await call, "GP_E_ENGINE_TIMEOUT", `${method} must be settled and still tracked`);
  }
  const waiting = client.call("snapshot");
  client.close();
  await assert.rejects(waiting, (err) => err.code === "GP_E_ENGINE_UNREACHABLE");

  const note = notes.find((line) => /late-reply tracking ended for 2 request/.test(line));
  assert.ok(note, `teardown must name how many tracked requests it discarded: ${JSON.stringify(notes)}`);
  assert.match(note, /'act' id 0/);
  assert.match(note, /'observe' id 1/);
  assert.match(note, /not attributed/);
  assert.match(note, /engine client closed/, "it has to say what ended the window");

  // The reported window really is closed: the same reply now reads as untracked.
  io.send(JSON.stringify({ id: 0, result: { operationId: "op_too_late" } }));
  assert.equal(seen.length, 0);
  assert.ok(notes.some((line) => /never issued/.test(line)), JSON.stringify(notes));
});

test("a teardown with nothing tracked claims no discarded requests", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 20);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  const answered = client.call("observe");
  io.respond({ tree: [] });
  await answered;
  client.close();
  assert.ok(!notes.some((note) => /late-reply tracking ended/.test(note)),
    `the count has to be measured, not asserted up front: a teardown that reports discards it did not make is the same failure in the right shape: ${JSON.stringify(notes)}`);
});

/* ------------------------------------------------------------------ *
 * R9-中2 — an `async` sink type-checks against `(reply) => void`, so its
 * rejection is invisible to the `try`/`catch` around the call and escapes as an
 * unhandled rejection: the MCP process dies with every request still pending.
 * The mutation: delete the promise branch and leave the sync `catch` as the
 * whole guard (this test then fails on the missing note, and on the unhandled
 * rejection that node reports for the file).
 * ------------------------------------------------------------------ */

test("a late-reply sink that rejects asynchronously is reported, not left unhandled", async (t) => {
  const io = new FakeLineIo();
  const client = timedOutClient(t, io, 20);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  client.onLateReply(async () => {
    throw new Error("sink rejected");
  });

  const promise = client.call("act", {}).catch(() => undefined);
  const frame = io.lastFrame();
  await expire(t, 20);
  await promise;
  io.send(JSON.stringify({ id: frame.id, result: { operationId: "op_x" } }));
  await flush();

  assert.ok(notes.some((note) => note.includes("late-reply sink failed") && note.includes("sink rejected")),
    `an async sink's rejection must be named like a sync throw, not left to kill the process: ${JSON.stringify(notes)}`);
  const next = client.call("diagnose");
  io.respond({ class: "T1", report: {} });
  assert.deepEqual(await next, { class: "T1", report: {} });
  client.close();
});

/* ------------------------------------------------------------------ *
 * R8-中9: this shell resolves "the user's home" two different ways, on purpose.
 * A future reader who "makes these consistent" would either turn every
 * `$HOME`-sandboxed process into a client of the user's live daemon (socket
 * side), or make the shell write a projects file the daemon cannot load
 * (registry side). Both are product defects, so the split is asserted rather
 * than commented.
 * ------------------------------------------------------------------ */

test("the socket guess and the daemon's own file are derived from different homes, deliberately", async () => {
  const { daemonProjectsPath } = await import("../dist/project-registry.js");
  const sandbox = path.join(os.tmpdir(), `gp-home-split-${process.pid}`);
  const savedHome = process.env.HOME;
  const savedSocket = process.env[ENGINE_SOCKET_ENV];
  delete process.env[ENGINE_SOCKET_ENV];
  fs.mkdirSync(sandbox, { recursive: true });
  try {
    process.env.HOME = sandbox;
    // The socket follows `$HOME`: a private HOME stays a private boundary, and
    // connecting to the real daemon has to be an act of naming, not an accident.
    assert.equal(defaultSocketPath(), path.join(sandbox, ".glasspane", "engine.sock"),
      "socket 回落若改成 passwd 的 home，$HOME 沙箱里的进程就会静默接上用户的真 daemon");
    // The registry follows the *daemon*: it must keep naming the file the service
    // actually loads, whichever `$HOME` the caller exported.
    const real = daemonProjectsPath();
    assert.ok(!real.startsWith(`${sandbox}/`),
      `projects 文件的路径若改成 $HOME，写出去的就是 daemon 永远不会加载的文件：${real}`);
    assert.notEqual(real, path.join(sandbox, ".glasspane", "projects.json"));
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedSocket === undefined) delete process.env[ENGINE_SOCKET_ENV];
    else process.env[ENGINE_SOCKET_ENV] = savedSocket;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the two lookups are each spelled in exactly one source file", () => {
  // One seam per rule, or the split stops being a decision and becomes an accident.
  // The counts are taken over `executableSource`, i.e. code rather than prose:
  // these very files *explain* the wrong lookup in their comments, and a gate
  // that matched raw text would report the documentation as the defect.
  const read = (name) => executableSource(
    fs.readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8"),
  );
  const registry = read("project-registry.ts");
  assert.equal((registry.match(/os\.homedir\(/g) ?? []).length, 0,
    "project-registry.ts 里再出现 os.homedir() 就是第二处 home 解析");
  assert.equal((registry.match(/os\.userInfo\(/g) ?? []).length, 1,
    "daemon 侧 home 只有一个出口（systemHome），否则两处可以解析出不同目录");
  const client = read("engine-client.ts");
  const at = client.indexOf("export function defaultSocketPath");
  assert.notEqual(at, -1);
  const body = client.slice(at);
  assert.equal((body.match(/os\.homedir\(/g) ?? []).length, 1,
    "socket 猜测也必须只有一个出口");
  assert.equal((body.match(/os\.userInfo\(/g) ?? []).length, 0,
    "socket 回落不得改用 passwd 记录 —— 见 defaultSocketPath 的 R8-中9 注释");
});

/* ------------------------------------------------------------------ *
 * R10-中2 — an id-less frame's attribution is a guess, and the trail has to
 * carry the guess with the id.
 *
 * With a *result* (not an error) and no id, the transport deletes the settled
 * entry and routes the body to the late-reply sink, which records its
 * operationIds into this session's trail. `gp_recent_reports` then lists them as
 * operations that ran. The attribution is by arrival order — the daemon answers
 * in the order it received requests — and nothing on the wire confirms it, so the
 * entry may be filed under an operation that belongs to the request queued behind
 * it. Dropping the id would be the worse lie ("no such operation ran" is what an
 * agent acts on), so it is kept and labelled: `provenanceOf` is what lets the
 * listing say *inferred* instead of *verified*.
 * ------------------------------------------------------------------ */

const OP_IN_ORDER = "op_000000000000000000000000inorder";
const OP_LATE_CONFIRMED = "op_0000000000000000000000lateok";
const OP_LATE_GUESSED = "op_0000000000000000000000lateguess";

test("the trail records how each id arrived, and an inferred one is not verified", async () => {
  const session = new EvidenceAuditSession();
  // Nothing recorded yet: the answer is "this trail does not hold that id", not a
  // default that could be rendered as a claim.
  assert.equal(session.provenanceOf(OP_IN_ORDER), null);

  // The in-time path: a call that held its own trail turn, answered by the frame
  // that echoed its id. This is the only entry the trail may call verified.
  session.record({ operationId: OP_IN_ORDER });
  assert.equal(session.provenanceOf(OP_IN_ORDER), "in-order");
  assert.deepEqual(session.inferredIds(), []);

  // A late reply whose frame echoed the id: late (its position in request order is
  // arranged on arrival), but the operation is the daemon's own.
  await session.recordLateArrival(
    (trail) => trail.record({ operationId: OP_LATE_CONFIRMED }),
    session.generation,
    "echoed-id",
  );
  assert.equal(session.provenanceOf(OP_LATE_CONFIRMED), "late");
  assert.deepEqual(session.inferredIds(), [], "只有回显 id 的迟到回复不得被标成猜的");

  // The frame this defect is about: a *result* with no id at all.
  await session.recordLateArrival(
    (trail) => trail.record({ operationId: OP_LATE_GUESSED }),
    session.generation,
    "arrival-order",
  );
  assert.equal(session.provenanceOf(OP_LATE_GUESSED), "late-inferred");
  assert.deepEqual(session.inferredIds(), [OP_LATE_GUESSED]);
  assert.deepEqual(session.recentIds(20), [OP_IN_ORDER, OP_LATE_CONFIRMED, OP_LATE_GUESSED],
    "标注归属方式不得改变链的内容或顺序——迟到操作仍要在链里，否则 agent 会以为它没跑");

  const note = TRAIL_PROVENANCE_NOTES["late-inferred"];
  assert.match(note, /arrival order/, "note 必须说清归属是按到达顺序推的");
  assert.match(note, /could not be confirmed by an echoed id/, "note 必须说清没有任何回显 id 证实它");
  assert.match(note, /not as verified|never as verified/, "它不得被读成已核实");

  // A second arrival of the same id — this time in order — must not upgrade the
  // record: nothing about the guessed frame became confirmable.
  session.record({ operationId: OP_LATE_GUESSED });
  assert.equal(session.provenanceOf(OP_LATE_GUESSED), "late-inferred",
    "再见到同一个 id 不得把猜的升格成核实过的");
});

test("a late arrival is never filed as verified even when the sink cannot say more", async () => {
  // MUTATION THIS PINS: `recordLateArrival` dropping `this.lateWindow = attribution`
  // (or defaulting it to the in-order path). The sink in `dispatch.ts` records with a
  // bare `trail.record(result)`; the mechanism has to be visible from inside this
  // session, or a guessed frame reads as a confirmed one whenever the caller forgets
  // to pass a flag.
  const session = new EvidenceAuditSession();
  await session.recordLateArrival(
    (trail) => trail.record({ operationId: OP_LATE_GUESSED }),
    session.generation,
  );
  assert.equal(session.provenanceOf(OP_LATE_GUESSED), "late",
    "迟到的写入至少必须是 late，不得因为调用方没带标注就升格成 in-order");
  assert.ok(session.provenanceOf(OP_LATE_GUESSED) !== "in-order");

  // The window closes with the write, so the next ordinary record is in-order again.
  session.record({ operationId: OP_IN_ORDER });
  assert.equal(session.provenanceOf(OP_IN_ORDER), "in-order");

  // And a refused late write leaves no provenance behind: the id is not in the trail,
  // so the trail may not describe how it arrived.
  const other = new EvidenceAuditSession();
  const outcome = await other.recordLateArrival(
    (trail) => trail.record({ operationId: OP_LATE_CONFIRMED }),
    UNKNOWN_GENERATION,
    "arrival-order",
  );
  assert.equal(outcome.written, false);
  assert.deepEqual(other.recentIds(20), []);
  assert.equal(other.provenanceOf(OP_LATE_CONFIRMED), null,
    "没写进链的 id 不得留下归属记录，否则读起来像链里有一个被标了注的操作");
});

test("provenance is trimmed and cleared with the trail it describes", () => {
  // MUTATION THIS PINS: dropping the `provenance.delete` in the eviction, or the
  // `provenance.clear()` in `restart()`. A stale entry under an id the trail no longer
  // holds reads as "recorded, with a caveat" for an operation the trail does not list.
  const session = new EvidenceAuditSession();
  const first = operationIds({ operationId: OP_IN_ORDER })[0];
  session.record({ operationId: first });
  for (let i = 0; i < AUDIT_HISTORY_LIMIT + 2; i++) {
    session.record({ operationId: `op_fill_${String(i).padStart(2, "0")}` });
  }
  assert.equal(session.recentIds(AUDIT_HISTORY_LIMIT * 2).length, AUDIT_HISTORY_LIMIT);
  assert.equal(session.provenanceOf(first), null, "被保留窗挤出的 id 必须连同归属一起消失");
  assert.equal(session.inferredIds().length, 0);
  // An id the trim *kept*, so the next assertion cannot pass by accident: it is the
  // restart that has to forget it. MUTATION THIS PINS: `restart()` without
  // `provenance.clear()` — the ids are gone, and a stale label on a gone id reads as
  // "this trail lists it, with a caveat" the moment the app is re-attached.
  const survivor = `op_fill_${String(AUDIT_HISTORY_LIMIT + 1).padStart(2, "0")}`;
  assert.equal(session.provenanceOf(survivor), "in-order");

  session.restart("com.example.app pid=1");
  assert.deepEqual(session.recentIds(20), []);
  assert.equal(session.provenanceOf(survivor), null, "换主之后旧链的归属不得留下");
});

test("the real MCP wiring files an id-less late reply as a late arrival, never as verified", async (t) => {
  // The end-to-end half of R10-中2, driven through `createTrackedMcpServer`'s sink so
  // this is the wiring an MCP client actually gets. What is asserted is the floor that
  // holds with the sink unchanged: an operation written from a late frame is not filed
  // as an in-order one. The `late-inferred` label needs the sink to forward
  // `reply.attribution` (one line in `dispatch.ts`, a different lane's file); the
  // transport already hands it over, and the unit test above pins what the session
  // does with it.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 20);
  const { session } = createTrackedMcpServer(client, () => undefined);

  const act = client.call("act", { selector: { role: "AXButton" }, action: "press" }, session.generation)
    .catch((error) => error.code);
  t.mock.timers.tick(20);
  assert.equal(await act, "GP_E_ENGINE_TIMEOUT");

  io.send(JSON.stringify({ id: null, result: { operationId: OP_LATE_GUESSED } }));
  await flush();

  assert.deepEqual(session.recentIds(20), [OP_LATE_GUESSED],
    "迟到的操作必须仍然进链：抹掉它是让用户再点一次");
  // R10-中2 的另一半（dispatch 现在把 `reply.attribution` 转交下来）：无 id 的帧的归属
  // 是按到达顺序**猜**的，链上必须写成 `late-inferred`。反向变异：拿掉 dispatch.ts 里
  // 的第三参数（回到默认 `unknown` → `late`）即红——这条盯的是"那根线接上了没有"，
  // 不只是 session 会不会打标。
  assert.equal(session.provenanceOf(OP_LATE_GUESSED), "late-inferred",
    "无 id 的迟到帧不得读成已核实，也不得读成按 id 确认过的迟到");
  client.close();
});

test("a late reply that echoed its request id is filed as late, not as inferred", async (t) => {
  // 上一条的对照：同一根线、同样迟到，唯一差别是帧带了客户端发出的那个 id。
  // 没有这一半，"一律写 inferred"也能过上一条。
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 20);
  const { session } = createTrackedMcpServer(client, () => undefined);

  const act = client.call("act", { selector: { role: "AXButton" }, action: "press" }, session.generation)
    .catch((error) => error.code);
  t.mock.timers.tick(20);
  assert.equal(await act, "GP_E_ENGINE_TIMEOUT");

  const frame = io.lastFrame();
  io.send(JSON.stringify({ id: frame.id, result: { operationId: OP_LATE_GUESSED } }));
  await flush();

  assert.deepEqual(session.recentIds(20), [OP_LATE_GUESSED]);
  assert.equal(session.provenanceOf(OP_LATE_GUESSED), "late",
    "带 id 的迟到回复是按 id 确认的，不该被降级成猜测");
  client.close();
});

/* ------------------------------------------------------------------ *
 * R10-中4 — `tools.ts` hands each tool an `Object.create(engine)` shadow with
 * `call` shadowed, so methods the tool layer does *not* shadow run with the
 * shadow as `this`. A field write there lands on the shadow: `close()` marked
 * the shadow closed and left the client sending requests on a transport it had
 * been told to end. The fix is one shared state box
 * (`EngineJsonRpcClient.state`), and these tests drive the tool layer's real
 * wrapper rather than a copy of it.
 * ------------------------------------------------------------------ */

test("closing the tool layer's shadow closes the client behind it", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 20);
  const shadow = engineWithPayloadAdvice(client, TOOL_BY_NAME.get("gp_observe"), {});
  assert.notEqual(shadow, client, "对照物必须是那个 shadow，而不是 client 本身");
  assert.equal(shadow.isClosed(), false);
  assert.equal(client.isClosed(), false);

  shadow.close();

  assert.equal(client.isClosed(), true,
    "close() 写的是 shadow 自己的字段的话，真 client 还在发请求——这就是 round 9 记下的那条");
  assert.equal(shadow.isClosed(), true);

  // The observable behaviour, not the flag: a closed client answers at once and
  // says which thing ended, instead of writing a frame no daemon will ever answer.
  for (const [label, target] of [["client", client], ["shadow", shadow]]) {
    await assert.rejects(target.call("observe", { maxDepth: 1 }), (error) => {
      assert.equal(error.code, "GP_E_ENGINE_UNREACHABLE", `${label} 关闭后不得再发`);
      assert.match(error.message, /was closed/, `${label} 的答复必须说清是客户端关了：${error.message}`);
      assert.doesNotMatch(error.message, /GP_E_ENGINE_TIMEOUT/);
      // Nothing was sent, so nothing about the daemon was measured: the one answer
      // that authorises a restart is `GP_E_ENGINE_UNREACHABLE` from a *failed*
      // transport, and a locally closed client must not borrow its command.
      assert.doesNotMatch(error.remedy, /--restore-launchd|launchctl/,
        `${label} 的出路不得把本机关闭写成该重启 daemon：${error.remedy}`);
      assert.match(error.remedy, /no restart is authorised/i);
      return true;
    }, `${label} 在 client 关闭后仍被接受`);
  }

  // Outstanding requests still get their honest answer, and the sinks registered
  // through the shadow are the client's: `onEngineNote` writes state too.
  const io2 = new FakeLineIo();
  const client2 = new EngineJsonRpcClient(io2, 20);
  const notes = [];
  engineWithPayloadAdvice(client2, TOOL_BY_NAME.get("gp_observe"), {}).onEngineNote((note) => notes.push(note));
  client2.call("observe", { maxDepth: 1 }).catch(() => undefined);
  io2.send(JSON.stringify({ id: 9999, result: {} }));
  assert.ok(notes.some((note) => /never issued/.test(note)),
    `shadow 上注册的 sink 必须真的接到 client 身上：${JSON.stringify(notes)}`);
});

/* ------------------------------------------------------------------ *
 * R10-中5 — 探针在两个接入面上名字不同，而超时 remedy 是在传输层写成的。
 * 给 curl 调用方留一个 `gp_probe_status`，它只能瞎猜一条本网关根本不提供的路由。
 * 反向变异：把任一面写死（另一面的断言红），或去掉替换让两面都说 gp_probe_status。
 * ------------------------------------------------------------------ */

test("the timeout remedy names the probe of the surface it is delivered on", () => {
  const mcp = slowEngineRemedy("observe", "mcp");
  const http = slowEngineRemedy("observe", "http");

  assert.ok(mcp.includes("gp_probe_status"), `MCP 面要给出 MCP 的名字：${mcp}`);
  assert.equal(http.includes("gp_probe_status"), false,
    `curl 调用方拿不到 gp_ 这个名字，只能瞎猜路由：${http}`);
  assert.ok(http.includes("POST /v1/tools/probe_status"),
    `HTTP 面要指出这条路由真的存在：${http}`);

  // 对称的一半：MCP 文案里不得出现 HTTP 路由，否则这条闸可以靠"两边都写满"通过。
  assert.equal(/POST \/v1\//.test(mcp), false, `MCP 面不得出现 HTTP 路由：${mcp}`);
});
