/**
 * 2026-10-24 unattended review — mcp-shell lane, advice and fan-out half.
 *
 * Three findings, all "two faces of one fact giving two answers":
 *
 * B3 — `gp_recent_reports`'s all-`GP_E_NO_EVIDENCE` branch counted `ids.length`, which
 *        includes the malformed ids this shell *refused to send*, and said each of them
 *        "was answered GP_E_NO_EVIDENCE". `rejected` disappears from that branch
 *        entirely. The call never asked, so it cannot report what was answered.
 * B4 — the too-large-reply advice told `gp_snapshot` to "retry with a smaller maxDepth"
 *        while the timeout advice for the same method refuses a re-send, because a second
 *        accepted snapshot appends to the daemon's bounded ring and can evict the baseline
 *        an earlier snapshot returned. One method, two opposite instructions.
 * B5/B6 — `GET /v1/evidence?ids=` dropped every pack it had already rendered when a later
 *        id hard-failed or answered an unrenderable frame, while this file's own header
 *        promises an unreached id is "never dropped from it" and the MCP half renders the
 *        packs it has with a failure note. Same construction on both faces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TOOL_BY_NAME,
  executeTool,
  oversizedReplyAdvice,
} from "../dist/tools.js";
import * as tools from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { EngineCallError } from "../dist/engine-client.js";
import { MAX_FRAME_BYTES, OversizeFrameError } from "../dist/io.js";
import { GP_E_NO_EVIDENCE, GP_E_PAYLOAD_TOO_LARGE } from "../dist/errors.js";
import { createHttpGateway } from "../dist/http-gateway.js";
import { makeEngine, FakeLineIo } from "./helpers.mjs";

const OP_A = "op_0123456789ABCDEFGHJKMNPQRS";
const OP_B = "op_123456789ABCDEFGHJKMNPQRST";
/** Shaped like an operationId this shell would refuse to send. */
const MALFORMED_ID = "op_not-an-operation-id";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function evidenceFrame(operationId) {
  return {
    evidencePack: {
      schemaVersion: "glasspane.evidence/0.1",
      operationId,
      createdAt: "2026-10-24T00:00:00.000Z",
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
      diagnosis: null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * B3 — the denominator is what was actually asked.
 * ------------------------------------------------------------------ */

test("gp_recent_reports counts only the ids it sent when every answer is no-evidence", async () => {
  // MUTATION THIS PINS (red against the reviewed implementation): the branch read
  // `for any of the ${ids.length} operations this shell asked about: each was answered
  // GP_E_NO_EVIDENCE`, with `ids` = sendable + rejected. One malformed id in the trail
  // therefore turned "this shell asked once and was told no both times" into a report of a
  // daemon answer that was never received — and `rejected` said nothing about it here.
  const { engine, io } = makeEngine();
  const session = new EvidenceAuditSession();
  session.record({ operationId: MALFORMED_ID });
  session.record({ operationId: OP_B });

  const promise = executeTool(TOOL_BY_NAME.get("gp_recent_reports"), { limit: 5 }, engine, session);
  await flush();
  io.respondError({ code: GP_E_NO_EVIDENCE, message: "no pack in the daemon history", remedy: "read it by id" });

  const text = (await promise).content[0].text;
  assert.ok(text.startsWith(`${GP_E_NO_EVIDENCE}:`), text.slice(0, 200));
  assert.match(text, /any of the 1 operation this shell sent/, `分母是真发出去的条数：${text.slice(0, 260)}`);
  assert.doesNotMatch(text, /the 2 (?:operations|entries)/, "没问过的那一条不许算进\"each was answered\"");
  assert.match(text, /rejected 1 trail entry/, `被拒未发的 id 必须挂在同一帧上：${text.slice(0, 260)}`);
  assert.match(text, /GP_E_BAD_PARAMS|not one this shell sends|was not sent/i, "被拒的要说是被拒，不是 daemon 的答复");
});

test("a trail of only malformed ids still says nothing was sent", async () => {
  // The neighbouring branch, kept as the control for the denominator rule: it already
  // counts what it measured, and the fix must not move it.
  const { engine } = makeEngine();
  const session = new EvidenceAuditSession();
  session.record({ operationId: MALFORMED_ID });
  const text = (await executeTool(TOOL_BY_NAME.get("gp_recent_reports"), { limit: 5 }, engine, session)).content[0].text;
  assert.match(text, /all 1 id in this session's trail/, text.slice(0, 260));
  assert.equal(engine.io.sent.length, 0, "被拒的 id 一个都不许发出去");
});

/* ------------------------------------------------------------------ *
 * B4 — overflow advice obeys the same criterion as the timeout advice.
 * ------------------------------------------------------------------ */

/** Drive one tool to the "reply did not fit" path and hand back its answer text. */
async function oversizedThrough(name, args) {
  const { io, engine } = makeEngine();
  const spec = TOOL_BY_NAME.get(name);
  const session = new EvidenceAuditSession();
  const call = executeTool(spec, args, engine, session);
  for (let i = 0; i < 20 && io.sent.length === 0; i++) await flush();
  assert.ok(io.sent.length > 0, `${name} 根本没发出帧，这条扫描是空的`);
  const frame = JSON.parse(io.sent[io.sent.length - 1]);
  io.emitError(new OversizeFrameError(MAX_FRAME_BYTES + 1, `{"id":${frame.id},"result":{"blob":`));
  const outcome = await call;
  assert.equal(outcome.isError, true);
  assert.ok(outcome.content[0].text.startsWith(`${GP_E_PAYLOAD_TOO_LARGE}:`), outcome.content[0].text.slice(0, 200));
  return outcome.content[0].text;
}

test("an oversized snapshot reply is not answered by a command the timeout answer forbids", async () => {
  // MUTATION THIS PINS (red against the reviewed implementation): the overflow branch was
  // gated on `isReplayUnsafeMethod` only, so `snapshot` — which the transport's own
  // `STATE_CHANGING_ON_RETRY_METHOD_NAMES` and `tools.ts`'s `NOT_NARROWABLE_BY_RETRY` both
  // call unsafe to re-send — still got "retry with a smaller maxDepth".
  const text = await oversizedThrough("gp_snapshot", { maxDepth: 6 });
  assert.doesNotMatch(text, /\bretry with\b/, `同一个方法的另一面说的是不许重发：${text.slice(0, 300)}`);
  assert.doesNotMatch(text, /send it again/i, text.slice(0, 300));
  assert.match(text, /snapshot ring/, `要把第二条为什么贵说出来：${text.slice(0, 300)}`);
  assert.match(text, /evict/, text.slice(0, 300));
  assert.match(text, /maxDepth/, "旋钮本身还是要点名，只是它不再是一道重发令");
  assert.match(text, /the connection is intact/, "超帧这一面的事实要说全");
});

test("an oversized read reply keeps its own knob advice", async () => {
  // The control on the other side of the same predicate: `observe` is narrowable by retry,
  // and stripping its knob advice would be the old mistake in new clothes.
  const text = await oversizedThrough("gp_observe", { maxDepth: 6 });
  assert.match(text, /retry with a smaller maxDepth \(this tool advertises 1…10\)/, text.slice(0, 300));
});

test("the overflow gate asks the transport's own question, not a third name list", () => {
  // The judgement is one predicate, read the same way the timeout path reads it, and it is
  // reachable without driving a frame: read it here so a future edit cannot re-split the
  // two faces by giving the transport-death path and the advice path different lists.
  const gate = tools.payloadOverflowAdvice;
  assert.equal(typeof gate, "function", "overflow 建议没有单一的派生点，两面就还是各写一份判据");
  assert.equal(
    gate(TOOL_BY_NAME.get("gp_observe"), "observe", {}),
    oversizedReplyAdvice(TOOL_BY_NAME.get("gp_observe"), {}),
  );
  assert.match(gate(TOOL_BY_NAME.get("gp_snapshot"), "snapshot", {}), /snapshot ring/);
  assert.match(
    gate(TOOL_BY_NAME.get("gp_act"), "act", { selector: { role: "AXButton" }, action: "press" }),
    /do not re-issue this request/,
  );
});

/* ------------------------------------------------------------------ *
 * B6 — the HTTP aggregate keeps what it rendered.
 * ------------------------------------------------------------------ */

const TEST_TOKEN = "test-bearer-token-0123456789abcdef";

class FakeGatewayClient {
  constructor() {
    this.calls = [];
    this.handlers = new Map();
  }

  call(method, params) {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    return Promise.resolve().then(() => (handler ? handler(params) : {}));
  }

  onEngineNote() {}

  onLateReply() {}

  get reportedEngineVersion() {
    return "1.20.1";
  }

  get reportedStateRoot() {
    return null;
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }
}

async function startGateway(fake) {
  const gw = createHttpGateway({
    socketPath: "/tmp/fake-engine.sock",
    token: TEST_TOKEN,
    port: 0,
    connectController: () => fake,
  });
  await new Promise((resolve) => gw.server.once("listening", resolve));
  return { gw, base: `http://127.0.0.1:${gw.server.address().port}` };
}

const auth = () => ({ Authorization: `Bearer ${TEST_TOKEN}` });

function fixturePack() {
  return JSON.parse(
    readFileSync(new URL("../../kernel/fixtures/evidence-pack.ok-03.json", import.meta.url), "utf8"),
  );
}

test("GET /v1/evidence?ids= keeps the packs it rendered when a later id hard-fails", async () => {
  // MUTATION THIS PINS (red against the reviewed implementation): the aggregate loop
  // `return`ed straight to an error response, dropping `blocks` — while this file's own
  // header promises an id is "never dropped from it" and `tools.ts`'s MCP half renders what
  // it has with a failure note. Two faces, two answers, one fact.
  const FAIL_ID = "op_0PAAAABBBBCCCCDDDDEEEEFFFX";
  const fake = new FakeGatewayClient();
  fake.on("last_evidence", (params) => {
    if (params.operationId === FAIL_ID) {
      throw new EngineCallError("GP_E_INTERNAL", "the daemon could not serialize this pack", "read it again by id");
    }
    return { evidencePack: fixturePack() };
  });
  const { gw, base } = await startGateway(fake);
  try {
    for (const format of ["markdown", "html"]) {
      const res = await fetch(`${base}/v1/evidence?ids=${OP_A},${FAIL_ID}&format=${format}`, { headers: auth() });
      const body = await res.json();
      assert.equal(res.status, 200, `${format}: 已经渲染好的 pack 不许跟着一条失败一起丢：${JSON.stringify(body).slice(0, 240)}`);
      assert.equal(body.ok, true, format);
      assert.deepEqual(body.result.renderedIds, [OP_A], format);
      assert.deepEqual(body.result.failed, [FAIL_ID], format);
      assert.match(body.result.report, /GlassPane evidence reports \(1\)/, format);
      assert.match(body.result.report, new RegExp(FAIL_ID), `${format}: 失败的那一条要点名`);
      assert.match(body.result.report, /failed with/, `${format}: 要说它答了什么：${body.result.report.slice(0, 300)}`);
      assert.match(body.result.report, /GP_E_INTERNAL/, format);
    }
    // Two formats × two ids = four reads: the good id and the failing one, each asked once
    // per request, and the fan-out stops at the failure rather than racing on to a third.
    assert.equal(fake.calls.filter((call) => call.method === "last_evidence").length, 4, "两种格式各自把两条都问过了");
  } finally {
    await gw.close();
  }
});

test("GET /v1/evidence?ids= keeps the packs it rendered when a later frame cannot be read", async () => {
  // The second drop site in the same loop: a frame whose shape this gateway refuses.
  const BAD_FRAME_ID = "op_0PAAAABBBBCCCCDDDDEEEEFFFY";
  const fake = new FakeGatewayClient();
  fake.on("last_evidence", (params) => {
    if (params.operationId === BAD_FRAME_ID) {
      return { evidencePack: { schemaVersion: "glasspane.evidence/0.1", operationId: BAD_FRAME_ID } };
    }
    return { evidencePack: fixturePack() };
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/evidence?ids=${OP_A},${BAD_FRAME_ID}&format=markdown`, { headers: auth() });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body).slice(0, 240));
    assert.deepEqual(body.result.renderedIds, [OP_A]);
    assert.deepEqual(body.result.failed, [BAD_FRAME_ID]);
    assert.match(body.result.report, new RegExp(BAD_FRAME_ID), body.result.report.slice(0, 300));
    assert.match(body.result.report, /cannot render|does not match the engine contract/i, body.result.report.slice(0, 400));
  } finally {
    await gw.close();
  }
});

test("an aggregate that rendered nothing still answers as an error frame", async () => {
  // Control: the fix is about the packs in hand, not about turning a total failure into a
  // fake success. Nothing rendered, so the daemon's own answer is the whole of it.
  const fake = new FakeGatewayClient();
  fake.on("last_evidence", () => {
    throw new EngineCallError("GP_E_INTERNAL", "the daemon could not serialize this pack", "read it again by id");
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/evidence?ids=${OP_A}&format=markdown`, { headers: auth() });
    const body = await res.json();
    assert.equal(res.status, 500, JSON.stringify(body).slice(0, 200));
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "GP_E_INTERNAL");
  } finally {
    await gw.close();
  }
});

/* ------------------------------------------------------------------ *
 * The HTTP half of B4, at the same boundary.
 * ------------------------------------------------------------------ */

test("POST /v1/tools/snapshot answers an oversized reply with the same fact the timeout answer states", async () => {
  const fake = new FakeGatewayClient();
  fake.on("snapshot", () => {
    throw new EngineCallError(
      GP_E_PAYLOAD_TOO_LARGE,
      "the engine's reply exceeded the frame cap and was dropped; the connection is intact",
      "IGNORED: the daemon's own line",
    );
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/snapshot`, { method: "POST", headers: auth(), body: JSON.stringify({ maxDepth: 6 }) });
    const body = await res.json();
    assert.equal(res.status, 502, JSON.stringify(body).slice(0, 200));
    assert.equal(body.error.code, GP_E_PAYLOAD_TOO_LARGE);
    assert.doesNotMatch(body.error.remedy, /\bretry with\b/, `curl 面也不许收到一条重发令：${body.error.remedy.slice(0, 300)}`);
    assert.match(body.error.remedy, /snapshot ring|writes daemon state again/, body.error.remedy.slice(0, 300));
    assert.ok(!/gp_[a-z_]+/.test(body.error.remedy), `curl 读者叫不出 gp_* 工具：${body.error.remedy}`);
  } finally {
    await gw.close();
  }
});
