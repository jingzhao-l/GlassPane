import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createTrackedMcpServer,
  McpServer,
  MCP_PROTOCOL_VERSION,
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../dist/dispatch.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { OrderedReplyQueue } from "../dist/io.js";
import { makeEngine } from "./helpers.mjs";

const enq = (obj) => JSON.stringify(obj);

function makeServer(timeoutMs = 500) {
  const { engine, io } = makeEngine({ timeoutMs });
  const server = new McpServer({ engine, session: new EvidenceAuditSession() });
  return { server, engine, io };
}

/**
 * One initialize frame; `params === undefined` omits params entirely. There is
 * deliberately no seam for injecting a version list: B-08 removed it, so an
 * echo can only pass by the shipped `SUPPORTED_PROTOCOL_VERSIONS` actually
 * implementing the version it returns.
 */
async function initialize(server, params, id = 1) {
  const frame = { jsonrpc: "2.0", id, method: "initialize" };
  if (params !== undefined) {
    frame.params = params;
  }
  return server.handleLine(enq(frame));
}

/** The handshake fields that version negotiation must never touch. */
function assertHandshakeShape(result) {
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(result.serverInfo, SERVER_INFO);
}

test("initialize handshake returns capabilities and server info", async () => {
  const { server } = makeServer();
  const request = enq({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  const response = await server.handleLine(request);
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(response.result.serverInfo, SERVER_INFO);
});

// Spec P0 §6.1 版本协商：回显客户端版本，不识别时回落本常量。
test("the shipped list holds more than the fallback, so negotiation can answer", () => {
  // The set used to be `[MCP_PROTOCOL_VERSION]`, which made the echo a tautology.
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.length > 1, SUPPORTED_PROTOCOL_VERSIONS.join(","));
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(MCP_PROTOCOL_VERSION));
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    // Nothing newer than this shell's own revision is claimed.
    assert.ok(version <= MCP_PROTOCOL_VERSION, `newer than the fallback: ${version}`);
  }
});

test("initialize echoes an older client protocolVersion this server implements", async () => {
  const { server } = makeServer();
  const response = await initialize(server, {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  });
  assert.equal(response.error, undefined);
  assert.equal(response.id, 1);
  // 回显的是客户端那一个，不是本 shell 的常量
  assert.notEqual(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(response.result.protocolVersion, "2024-11-05");
  assertHandshakeShape(response.result);
});

test("initialize echoes its own constant when the client asks for exactly that", async () => {
  const { server } = makeServer();
  const response = await initialize(server, { protocolVersion: MCP_PROTOCOL_VERSION });
  assert.equal(response.error, undefined);
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assertHandshakeShape(response.result);
});

test("initialize falls back to its own constant on an unimplemented client version", async () => {
  const { server } = makeServer();
  // A revision newer than anything the shell claims; "2024-11-05" moved into the
  // implemented set with B-08, which is what the test above now pins.
  const response = await initialize(server, {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  });
  assert.equal(response.error, undefined);
  assert.notEqual(response.result.protocolVersion, "2025-11-25");
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assertHandshakeShape(response.result);
});

test("initialize answers a version-less handshake instead of crashing", async () => {
  const { server } = makeServer();
  const response = await initialize(server, { capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(response.error, undefined);
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assertHandshakeShape(response.result);
});

test("initialize never rejects a garbage protocolVersion, it falls back", async () => {
  const { server } = makeServer();
  const malformed = [
    undefined, // params 整体省略 —— 合法 MCP 形状
    null, // params 为 null
    {}, // 有 params 但没有 protocolVersion
    { protocolVersion: null },
    { protocolVersion: 20250618 }, // 非字符串
    { protocolVersion: true },
    { protocolVersion: ["2025-06-18"] },
    { protocolVersion: { version: "2025-06-18" } },
    { protocolVersion: "" }, // 字符串但没人实现它
    "2025-06-18", // params 根本不是对象
    [], // 也不是
  ];
  for (const params of malformed) {
    const response = await initialize(server, params);
    const label = JSON.stringify(params) ?? "omitted params";
    assert.equal(response.error, undefined, `handshake must not be rejected: ${label}`);
    assert.equal(response.id, 1);
    assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION, `fallback expected: ${label}`);
    assertHandshakeShape(response.result);
  }
});

test("notifications/initialized yields no response", async () => {
  const { server } = makeServer();
  const response = await server.handleLine(enq({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(response, null);
});

test("ping returns empty result", async () => {
  const { server } = makeServer();
  const response = await server.handleLine(enq({ jsonrpc: "2.0", id: 2, method: "ping" }));
  assert.deepEqual(response.result, {});
});

test("tools/list returns the sixteen tools", async () => {
  const { server } = makeServer();
  const response = await server.handleLine(enq({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
  const names = response.result.tools.map((tool) => tool.name);
  assert.equal(names.length, 16);
  assert.ok(names.includes("gp_attach"));
  assert.ok(names.includes("gp_snapshot"));
  assert.ok(names.includes("gp_restore"));
  assert.ok(names.includes("gp_audit_ui"));
  assert.ok(names.includes("gp_capture_view"));
  assert.ok(names.includes("gp_probe_status"));
  assert.ok(names.includes("gp_export_evidence"));
  assert.ok(names.includes("gp_recent_reports"));
  assert.ok(names.includes("gp_project_list"));
  assert.ok(names.includes("gp_project_set"));
  assert.ok(names.includes("gp_project_get"));
  assert.ok(response.result.tools.every((tool) => tool.inputSchema !== undefined));
});

test("tools/call forwards to the engine and relays success", async () => {
  const { server, io } = makeServer();
  const request = enq({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "gp_attach", arguments: { bundleId: "com.example.app" } },
  });
  const promise = server.handleLine(request);
  const frame = io.lastFrame();
  assert.equal(frame.method, "attach");
  assert.equal(frame.params.bundleId, "com.example.app");
  io.respond({ pid: 4242, bundleId: "com.example.app", appName: "Example" });
  const response = await promise;
  assert.equal(response.id, 4);
  assert.equal(response.result.isError, false);
  assert.equal(JSON.parse(response.result.content[0].text).pid, 4242);
});

test("tools/call invalid arguments become isError with GP_E_BAD_PARAMS", async () => {
  const { server, engine } = makeServer();
  const request = enq({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "gp_act", arguments: { selector: { role: "button" } } }, // missing action
  });
  const response = await server.handleLine(request);
  assert.equal(response.id, 5);
  assert.equal(response.result.isError, true);
  assert.ok(response.result.content[0].text.startsWith("GP_E_BAD_PARAMS"));
  assert.equal(engine.io.sent.length, 0);
});

test("gp_audit_ui forwards the audit_ui method with its parameters", async () => {
  const { server, engine } = makeServer();
  const promise = server.handleLine(
    enq({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "gp_audit_ui", arguments: { maxDepth: 4, minHitTargetPt: 28 } },
    }),
  );
  await Promise.resolve();
  const frame = engine.io.lastFrame();
  assert.equal(frame.method, "audit_ui");
  assert.deepEqual(frame.params, { maxDepth: 4, minHitTargetPt: 28 });
  engine.io.respond({ verdict: "advisory", findings: [], coverage: { total: 2, measured: 2, absent: 0, unread: 0, ratio: 1 } });
  const response = await promise;
  assert.equal(response.result.isError, false);
});

test("gp_audit_ui rejects an out-of-range hit target before touching the engine", async () => {
  const { server, engine } = makeServer();
  for (const bad of [0, 401, "44", true]) {
    const response = await server.handleLine(
      enq({
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: { name: "gp_audit_ui", arguments: { minHitTargetPt: bad } },
      }),
    );
    assert.equal(response.result.isError, true, `minHitTargetPt=${JSON.stringify(bad)} 应在本地被拒`);
    assert.ok(response.result.content[0].text.startsWith("GP_E_BAD_PARAMS"));
  }
  assert.equal(engine.io.sent.length, 0, "本地就该拦下，不能把越界值转给引擎");
});

test("gp_audit_ui refuses unknown parameters instead of silently ignoring them", async () => {
  const { server, engine } = makeServer();
  const response = await server.handleLine(
    enq({
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: { name: "gp_audit_ui", arguments: { screenshot: true } },
    }),
  );
  assert.equal(response.result.isError, true);
  assert.ok(response.result.content[0].text.startsWith("GP_E_BAD_PARAMS"));
  assert.equal(engine.io.sent.length, 0);
});

test("gp_capture_view returns one image part plus a text summary that states it persisted nothing", async () => {
  const { server, engine } = makeServer();
  const promise = server.handleLine(
    enq({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "gp_capture_view", arguments: { scale: 0.6 } },
    }),
  );
  await Promise.resolve();
  const frame = engine.io.lastFrame();
  assert.equal(frame.method, "capture_view");
  assert.deepEqual(frame.params, { scale: 0.6 });
  engine.io.respond({
    pngBase64: "iVBORw0KGgo=",
    mimeType: "image/png",
    byteCount: 12,
    pixelWidth: 864,
    pixelHeight: 540,
    scale: 0.6,
    windowId: 12,
    pointSize: { width: 1440, height: 900 },
    persisted: false,
  });
  const response = await promise;
  assert.equal(response.result.isError, false);
  const [image, summary] = response.result.content;
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, "iVBORw0KGgo=");
  // 摘要不是装饰：模型只看图时没人记得这张图被 0.6 缩过，而"我看清了"与
  // "我看清的是缩过的版本"是两个结论；"有没有落盘"同样必须随图一起说。
  const stated = JSON.parse(summary.text);
  assert.equal(stated.scale, 0.6);
  assert.equal(stated.persisted, false);
  assert.equal(stated.pixelWidth, 864);
});

test("gp_capture_view relays the engine's refusal instead of inventing an empty image", async () => {
  const { server, engine } = makeServer();
  const promise = server.handleLine(
    enq({ jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "gp_capture_view", arguments: {} } }),
  );
  await Promise.resolve();
  engine.io.respondError({
    code: "GP_E_PIXEL_CAPTURE_DENIED",
    message: "screen recording is not granted to the daemon",
    remedy: "tick it for GlassPane Daemon in the settings panel",
  });
  const response = await promise;
  assert.equal(response.result.isError, true);
  const text = response.result.content[0].text;
  assert.ok(text.includes("GP_E_PIXEL_CAPTURE_DENIED"), text);
  assert.equal(response.result.content.some((part) => part.type === "image"), false,
    "被拒时绝不能返回一张空白图");
});

test("gp_capture_view refuses an engine frame that carries no image", async () => {
  const { server, engine } = makeServer();
  const promise = server.handleLine(
    enq({ jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "gp_capture_view", arguments: {} } }),
  );
  await Promise.resolve();
  engine.io.respond({ mimeType: "image/png", byteCount: 0 });
  const response = await promise;
  assert.equal(response.result.isError, true);
  assert.ok(response.result.content[0].text.startsWith("GP_E_INTERNAL"), response.result.content[0].text);
});

test("gp_capture_view rejects a scale that would produce unreadable pixels", async () => {
  const { server, engine } = makeServer();
  for (const bad of [0, 0.05, 1.5, "0.6"]) {
    const response = await server.handleLine(
      enq({
        jsonrpc: "2.0",
        id: 34,
        method: "tools/call",
        params: { name: "gp_capture_view", arguments: { scale: bad } },
      }),
    );
    assert.equal(response.result.isError, true, `scale=${JSON.stringify(bad)} 应在本地被拒`);
  }
  assert.equal(engine.io.sent.length, 0, "越界 scale 不该被转给引擎");
});

test("gp_capture_view refuses a frame that never said it persisted nothing", async () => {
  const { server, engine } = makeServer();
  const promise = server.handleLine(
    enq({ jsonrpc: "2.0", id: 35, method: "tools/call", params: { name: "gp_capture_view", arguments: {} } }),
  );
  await Promise.resolve();
  // 引擎这次没回答"有没有落盘"。壳层不许替它答 `false`：那会把"没回答"洗成
  // "保证没存"，而 SECURITY.md 对外说的就是这句话。
  const { persisted, ...withoutClaim } = {
    pngBase64: "iVBORw0KGgo=",
    mimeType: "image/png",
    byteCount: 12,
    pixelWidth: 864,
    pixelHeight: 540,
    scale: 1,
    appliedScale: 1,
    windowId: 12,
    pointSize: { width: 1440, height: 900 },
    persisted: false,
  };
  engine.io.respond(withoutClaim);
  const response = await promise;
  assert.equal(response.result.isError, true, "缺 persisted:false 的帧必须被拒");
  assert.equal(response.result.content.some((part) => part.type === "image"), false,
    "既然主张没被确认，就不该把这张图交进会话");
  assert.ok(response.result.content[0].text.includes("persisted"), response.result.content[0].text);
});

test("gp_capture_view states the applied scale and trusts the engine's mime type", async () => {
  const { server, engine } = makeServer();
  const promise = server.handleLine(
    enq({ jsonrpc: "2.0", id: 36, method: "tools/call", params: { name: "gp_capture_view", arguments: { scale: 0.6 } } }),
  );
  await Promise.resolve();
  // 请求 0.6、实际只缩到 0.9（降采样失败时就会这样）：两个数都必须出现在摘要里，
  // 否则模型以为自己在看 0.6 的版本。
  engine.io.respond({
    pngBase64: "iVBORw0KGgo=",
    mimeType: "image/png",
    byteCount: 12,
    pixelWidth: 1296,
    pixelHeight: 810,
    scale: 0.6,
    appliedScale: 0.9,
    windowId: 12,
    pointSize: { width: 1440, height: 900 },
    persisted: false,
  });
  const response = await promise;
  assert.equal(response.result.isError, false);
  const [image, summary] = response.result.content;
  const stated = JSON.parse(summary.text);
  assert.equal(stated.scale, 0.6);
  assert.equal(stated.appliedScale, 0.9, "appliedScale 必须原样转达，不能由请求值代替");
  assert.equal(image.mimeType, stated.mimeType, "图像部分的 mime 必须与摘要同源，不能一边硬编码");
});

test("tools/call engine error maps to isError with GP_E prefix", async () => {
  const { server, io } = makeServer();
  const request = enq({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "gp_observe", arguments: {} },
  });
  const promise = server.handleLine(request);
  io.respondError({ code: "GP_E_AX_UNAVAILABLE", message: "no accessibility permission", remedy: "glasspaned --grant-accessibility" });
  const response = await promise;
  assert.equal(response.result.isError, true);
  assert.ok(response.result.content[0].text.startsWith("GP_E_AX_UNAVAILABLE"));
  assert.ok(response.result.content[0].text.includes("--grant-accessibility"));
});

test("tools/call engine unreachable maps to isError with GP_E_ENGINE_UNREACHABLE", async () => {
  const { server, engine } = makeServer();
  const request = enq({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "gp_attach", arguments: { bundleId: "com.example.app" } },
  });
  const promise = server.handleLine(request);
  engine.io.emitError(new Error("connect ECONNREFUSED"));
  const response = await promise;
  assert.equal(response.result.isError, true);
  assert.ok(response.result.content[0].text.startsWith("GP_E_ENGINE_UNREACHABLE"));
});

test("unknown tool name yields invalid params", async () => {
  const { server } = makeServer();
  const res = await server.handleLine(enq({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "nope" } }));
  assert.equal(res.error.code, -32602);
});

test("unknown method yields method not found", async () => {
  const { server } = makeServer();
  const res = await server.handleLine(enq({ jsonrpc: "2.0", id: 9, method: "bogus" }));
  assert.equal(res.error.code, -32601);
});

test("bad JSON yields parse error (-32700)", async () => {
  const { server } = makeServer();
  const res = await server.handleLine("{not json");
  assert.equal(res.error.code, -32700);
  assert.equal(res.id, null);
});

test("non-object frame / array yields invalid request (-32600)", async () => {
  const { server } = makeServer();
  const res = await server.handleLine("[1,2,3]");
  assert.equal(res.error.code, -32600);
});

test("blank line yields no response", async () => {
  const { server } = makeServer();
  assert.equal(await server.handleLine(""), null);
  assert.equal(await server.handleLine("   "), null);
});

/* ------------------------------------------------------------------ *
 * B-02 — an outstanding engine call must not stop the shell from serving
 * anything else. index.ts wires the server with `queue.pushDelivery(
 * server.handleLine(line), writeResponse)` (reproduced below, because index.ts
 * runs main() at import time): the request starts at once and only the write of
 * its finished frame joins the serial chain.
 * ------------------------------------------------------------------ */

/**
 * Await the queue until `done()` holds: a delivery step joins the chain one
 * microtask after its request resolves, and each write below yields a macrotask, so
 * a single `drained()` can return too early.
 *
 * The loop is bounded by *rounds of the queue settling*, not by a wall-clock slice:
 * the fixed-6-round version of this helper used to be followed by an exact-list
 * assertion whose answer the 500 ms engine deadline could change (see the test's own
 * note), and a helper that cannot tell "the shell never got here" from "the machine
 * was slow" is what made that control unfixable. `rounds` is a guard against
 * spinning forever on a shell that genuinely does not answer: when it runs out, the
 * caller's assertion reads the state and goes red — it does not time out, and it
 * does not pass.
 */
async function drainUntil(queue, done, rounds = 24) {
  for (let round = 0; round < rounds; round++) {
    await queue.drained();
    if (done()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Both outrunner frames written, whatever the act is doing. */
const answeredBothOutrunners = (written) => written.filter((r) => r.id === 101 || r.id === 102).length === 2;

test("an outstanding gp_act does not hold back ping or tools/list", async (t) => {
  /*
   * MUTATION THIS PINS, and the reason the clock is mocked: the act's engine
   * deadline is a real `setTimeout` armed inside `EngineJsonRpcClient.call()`
   * (`engine-client.ts:842`) at the fixture's 500 ms, and the whole question "is the
   * act still outstanding?" used to be decided by the scheduler. Measured on this
   * machine at load 160–200, this test went red at 562 ms with
   * `AssertionError: ping and tools/list are answered while the act is still
   * outstanding` and `actual: [101, 102, 100]` — the act's own *timeout* reply had
   * landed during the drain. The same output proved the property under test (the act
   * answered last, after both outran it), so the red was the control measuring the
   * scheduler, not a head-of-line-blocking defect in the shell. Verified separately:
   * with `pushDelivery` replaced by the old `queue.push(server.handleLine(...))`,
   * ping is genuinely held back, and the assertions below go red — this is a real
   * gate, not a timing artefact.
   *
   * Fixed through the seams that already exist: `timeoutMs` is the caller's own bound
   * (`engine-client.ts:823-827`) and `t.mock.timers` is how this suite already drives
   * deadline-backed behaviour (`engine-client.test.mjs`, "the real MCP wiring files an
   * id-less late reply…"). Here nothing is *supposed* to be answered by the deadline,
   * so the tick that would fire it is simply never taken, and the act can only settle
   * when the test hands it a frame. The real-clock half is the next test.
   */
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { server, io } = makeServer();
  const written = [];
  const reported = [];
  const queue = new OrderedReplyQueue((error) => reported.push(error));
  let writesInFlight = 0;
  let writesMostInFlight = 0;
  const write = async (response) => {
    writesInFlight += 1;
    writesMostInFlight = Math.max(writesMostInFlight, writesInFlight);
    await new Promise((resolve) => setImmediate(resolve)); // a blocked stdout
    writesInFlight -= 1;
    if (response !== null) {
      written.push(response);
    }
  };
  const ask = (frame) => queue.pushDelivery(server.handleLine(enq(frame)), write);

  ask({
    jsonrpc: "2.0",
    id: 100,
    method: "tools/call",
    params: { name: "gp_act", arguments: { selector: { role: "button" }, action: "press" } },
  });
  assert.equal(io.sent.length, 1, "the act reaches the engine at once");
  assert.deepEqual(written, [], "and nothing is answerable yet");

  ask({ jsonrpc: "2.0", id: 101, method: "ping" });
  ask({ jsonrpc: "2.0", id: 102, method: "tools/list" });
  await drainUntil(queue, () => answeredBothOutrunners(written));
  assert.deepEqual(written.map((r) => r.id), [101, 102],
    "ping and tools/list are answered while the act is still outstanding");
  assert.equal(written[1].result.tools.length, 16);
  assert.equal(writesMostInFlight, 1, "frames still go out one at a time");

  io.respond({ operationId: "op_0123456789ABCDEFGHJKMNPQRS", actConfirmed: true });
  await drainUntil(queue, () => written.length === 3);
  assert.deepEqual(written.map((r) => r.id), [101, 102, 100], "the outrun reply is not lost");
  assert.equal(written[2].result.isError, false);
  assert.deepEqual(reported, [], "no reply failed on the way out");

  // A request that rejects is reported through the queue (never an unhandled
  // rejection while the chain is busy), and a failing write cannot poison it.
  queue.pushDelivery(Promise.reject(new Error("handleLine blew up")), async () => {
    throw new Error("must not run: there is no value");
  });
  queue.pushDelivery(Promise.resolve({ jsonrpc: "2.0", id: 7, result: {} }), async () => {
    throw new Error("stdout rejected");
  });
  let reached = false;
  queue.push(async () => {
    reached = true;
  });
  // Both halves are waited for, and that matters: a delivery that joins the chain
  // from a microtask (`pushDelivery` of an already-resolved value) can land *after*
  // a `push` made synchronously ahead of it, so a predicate on `reached` alone
  // returns while `stdout rejected` is still queued behind it.
  await drainUntil(queue, () => reached && reported.length === 2);
  assert.deepEqual(reported.map((e) => e.message), ["handleLine blew up", "stdout rejected"]);
  assert.equal(reached, true, "a poisoned chain would stop every later reply");
});

test("the same outrun holds on the real clock, with no mocked timer in sight", async () => {
  /*
   * The real-timing case, kept on purpose: a mocked clock proves the ordering
   * logic but cannot show that a live shell answers `ping` before its own daemon
   * reply arrives. Two things make this one honest rather than load-sensitive:
   *
   * - the act is answered by a **frame**, never by its deadline, and the deadline is
   *   pushed far past anything the drain can take (`timeoutMs` is the caller's own
   *   bound, injected through the existing `makeEngine` seam). Nothing here *waits*
   *   for it, so raising it buys no wall-clock slice and removes the only way the
   *   machine's speed could change this answer. The act is settled by `io.respond`
   *   below and its timer is cleared, so the pending deadline cannot hold the test
   *   process open either.
   * - the property is read from a snapshot taken **inside the write**, so it says
   *   "answered while the act was outstanding" as a measurement, not as an inference
   *   from a list length.
   */
  const { server, io } = makeServer(60_000);
  const written = [];
  let actSettled = false;
  const queue = new OrderedReplyQueue(() => undefined);
  const write = async (response) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (response !== null) {
      written.push({ id: response.id, actSettled });
    }
  };

  const actInFlight = server.handleLine(enq({
    jsonrpc: "2.0",
    id: 100,
    method: "tools/call",
    params: { name: "gp_act", arguments: { selector: { role: "button" }, action: "press" } },
  }));
  // Registered before the delivery is queued, so the flag is true by the time the
  // act's own frame is written and false for everything that outran it.
  void actInFlight.then(() => {
    actSettled = true;
  });
  queue.pushDelivery(actInFlight, write);

  for (const frame of [
    { jsonrpc: "2.0", id: 101, method: "ping" },
    { jsonrpc: "2.0", id: 102, method: "tools/list" },
  ]) {
    queue.pushDelivery(server.handleLine(enq(frame)), write);
  }

  await drainUntil(queue, () => answeredBothOutrunners(written));
  // Named first, and not as a formality: under head-of-line blocking these two
  // replies are never written at all, and the snapshot loop below would read an
  // empty list and pass.
  assert.deepEqual(written.map((r) => r.id), [101, 102],
    "ping and tools/list got answered at all while the act's own reply had not arrived");
  for (const record of written) {
    assert.equal(record.actSettled, false,
      `reply ${record.id} was written only after the act had settled — that is head-of-line blocking, not a slow machine`);
  }

  io.respond({ operationId: "op_0123456789ABCDEFGHJKMNPQRS", actConfirmed: true });
  await drainUntil(queue, () => written.length === 3);
  assert.deepEqual(written.map((r) => r.id), [101, 102, 100]);
  assert.equal(written[2].actSettled, true, "and the act's own reply is the one that settled it");
});
/* ------------------------------------------------------------------ *
 * R8-中5: a notification gets no answer per JSON-RPC, which is exactly why it
 * needs a log line — otherwise `notifications/cancelled` (a client saying it has
 * given up) disappears while the daemon request it refers to keeps acting on the
 * user's screen.
 * ------------------------------------------------------------------ */

test("notifications/cancelled is reported, and still gets no response frame", async () => {
  const { engine } = makeEngine();
  const notes = [];
  const server = createTrackedMcpServer(engine, (note) => notes.push(note)).server;

  const response = await server.handleLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 7, reason: "user stopped it" },
  }));
  assert.equal(response, null, "notification 不得有回复帧");
  assert.equal(notes.length, 1, `撤销通知一条日志都没有：${JSON.stringify(notes)}`);
  assert.ok(notes[0].includes("notifications/cancelled") && notes[0].includes("7"), notes[0]);
  assert.match(notes[0], /cannot cancel what the daemon is already doing/);
  assert.match(notes[0], /A cancel is not an undo/);
});

test("an unimplemented notification is reported as dropped, initialized excluded", async () => {
  const { engine } = makeEngine();
  const notes = [];
  const server = createTrackedMcpServer(engine, (note) => notes.push(note)).server;

  assert.equal(await server.handleLine(JSON.stringify({
    jsonrpc: "2.0", method: "notifications/initialized",
  })), null);
  assert.deepEqual(notes, [], "initialized 是本壳预期内的通知，不该制造噪音");

  assert.equal(await server.handleLine(JSON.stringify({
    jsonrpc: "2.0", method: "notifications/progress", params: {},
  })), null);
  assert.equal(notes.length, 1, `未实现的通知必须留下痕迹：${JSON.stringify(notes)}`);
  assert.ok(notes[0].includes("notifications/progress") && notes[0].includes("dropped"), notes[0]);
});

test("a protocol-level tools/call refusal carries a remedy naming published tools", async () => {
  // MUTATION THIS PINS: `McpServer.callTool`'s three protocol refusals (`dispatch.ts`),
  // which answered with a bare message and no remedy at all. The rule this product holds
  // is that an error is the triple {code, message, remedy} and that the remedy is
  // executable by the agent reading it: "Unknown tool: gp_acti" says what is wrong and
  // nothing about what to do, so the caller's next move is to guess a name again. The
  // names it is offered come from this server's own published list — the same list
  // `tools/list` just answered with — because a suggestion the caller cannot call is
  // worse than no suggestion.
  const { server } = makeServer();
  const listed = await server.handleLine(enq({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const published = new Set(listed.result.tools.map((tool) => tool.name));
  assert.ok(published.size >= 10, `这条闸要有可比的对象，tools/list 只回了 ${published.size} 个`);

  const res = await server.handleLine(enq({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "gp_acti", arguments: {} },
  }));
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /Unknown tool: gp_acti/, res.error.message);
  assert.match(res.error.message, /\| remedy: /, `协议拒绝也要带出路：${res.error.message}`);

  // Names *offered* as the way out must be callable — the echoed offending input is not an
  // offer, and the assertion above already pins that the message says what arrived.
  const remedyClause = res.error.message.slice(res.error.message.indexOf("| remedy: "));
  assert.ok(remedyClause.length > "| remedy: ".length, `出路部分是空的：${res.error.message}`);
  const offered = [...remedyClause.matchAll(/gp_[a-z_]+/g)].map((match) => match[0]);
  assert.ok(offered.length >= 1, `出路里一个已发布的工具名都没有：${res.error.message}`);
  for (const name of offered) {
    assert.ok(published.has(name), `出路点名了一个这个面上不存在的工具 ${name}：${res.error.message}`);
  }
  // The typo's own nearest neighbour is the useful one, and it is in the list.
  assert.ok(offered.includes("gp_act"), `拼错 gp_act 的人要拿到 gp_act：${res.error.message}`);
  assert.equal(res.error.message.includes("TOOL_SPECS"), false, "JSON-RPC 读者打不开一个源码符号");

  // The two sibling refusals are the same class of caller: a body shaped wrong, and no
  // idea what a right one looks like.
  const wrongParams = await server.handleLine(enq({ jsonrpc: "2.0", id: 3, method: "tools/call", params: "gp_observe" }));
  assert.match(wrongParams.error.message, /\| remedy: /, wrongParams.error.message);
  for (const name of [...wrongParams.error.message.matchAll(/gp_[a-z_]+/g)].map((m) => m[0])) {
    assert.ok(published.has(name), `params 形状的出路点名了不存在的 ${name}：${wrongParams.error.message}`);
  }
  const wrongName = await server.handleLine(enq({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: 7 } }));
  assert.match(wrongName.error.message, /\| remedy: /, wrongName.error.message);
  for (const name of [...wrongName.error.message.matchAll(/gp_[a-z_]+/g)].map((m) => m[0])) {
    assert.ok(published.has(name), `name 形状的出路点名了不存在的 ${name}：${wrongName.error.message}`);
  }
  // And the refusals that only appear when a caller is talking to a *shrunken* server: the
  // example baked into the two shape refusals is not allowed to name a tool this server does
  // not answer. Without this case the sentence could advertise a tool that only exists in the
  // full TOOL_SPECS list and leave every check above green.
  const subset = new McpServer({
    engine: makeEngine().engine,
    session: new EvidenceAuditSession(),
    specs: [{ name: "gp_probe_status", description: "d",
      inputSchema: { type: "object", properties: {} },
      // ToolSpec 的必填面：出路现在按 `spec.validate({})` 选例子，夹具就得是一个真 spec。
      validate: () => ({ ok: true, value: {} }) }],
  });
  for (const [id, params] of [[11, "gp_observe"], [12, { name: 7 }]]) {
    const shape = await subset.handleLine(enq({ jsonrpc: "2.0", id, method: "tools/call", params }));
    assert.match(shape.error.message, /\| remedy: /, shape.error.message);
    for (const name of [...shape.error.message.matchAll(/gp_[a-z_]+/g)].map((m) => m[0])) {
      assert.equal(name, "gp_probe_status",
        `一个只发布 gp_probe_status 的面上，出路点名了 ${name}：${shape.error.message}`);
    }
  }
});

test("a spec without a callable validate is refused at construction, not mid-request", () => {
  const { engine } = makeEngine();
  // `callShapeRemedy()` runs the same `validate` the call path runs (that is the 2026-10-29
  // fix: picking the example off the JSON Schema's `required` advertised a call the daemon
  // would refuse). A spec missing it therefore used to surface as
  // `Internal error: TypeError: spec.validate is not a function` **on the wire, inside a
  // caller's error frame** — a contract mistake by the embedding code, answered as a mystery.
  assert.throws(
    () => new McpServer({
      engine,
      session: new EvidenceAuditSession(),
      specs: [{ name: "gp_probe_status", description: "d", inputSchema: { type: "object", properties: {} } }],
    }),
    /gp_probe_status" has no callable validate/,
  );
  // …and the refusal names the seam to fix, not just the symptom.
  assert.throws(
    () => new McpServer({ engine, session: new EvidenceAuditSession(), specs: [{ name: "gp_x", description: "d" }] }),
    /TOOL_SPECS/,
  );
});

test("a fault inside the shell is answered wire-safe: type on the frame, detail on stderr, remedy on both", async () => {
  const { engine } = makeEngine();
  const LEAKED = "EPHEMERAL /Users/someone/.glasspane/engine.sock could not be opened";
  const server = new McpServer({
    engine,
    session: new EvidenceAuditSession(),
    specs: [{
      name: "gp_probe_status",
      description: "d",
      inputSchema: { type: "object", properties: {} },
      validate: () => { throw new Error(LEAKED); },
    }],
  });
  const written = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return true;
  };
  let frame;
  try {
    frame = await server.handleLine(enq({ jsonrpc: "2.0", id: 99, method: "tools/call", params: "gp_probe_status" }));
  } finally {
    process.stderr.write = realWrite;
  }
  const log = written.join("");
  assert.ok(log.includes(LEAKED), `内部的失败描述没进本进程的 stderr——它现在无处可去了：${log}`);
  assert.match(log, /withheld from the stdio frame/, "stderr 那一行必须说清为什么不上线");
  assert.equal(frame.error.code, -32603);
  assert.ok(!frame.error.message.includes(LEAKED),
    `内部描述被印到线上（这是 HTTP 半边早已禁止的形状）：${frame.error.message}`);
  assert.match(frame.error.message, /\| remedy: /, frame.error.message);
  assert.match(frame.error.message, /this shell faulted/);
  // 出路必须点名"这条面上的读者真能做的动作"，而不是"再发一次"：gp_probe_status 是只读的，
  // `shellFaultRemedy` 对可重发与不可重发两类分别说话，这里钉的是它被真的调用过。
  assert.match(frame.error.message, /gp_last_evidence|gp_recent_reports|stderr/,
    `出路没有点名任何一条读者做得动的读取：${frame.error.message}`);
});

test("a session-less McpServer is refused at runtime, not just in types", () => {
  const { engine } = makeEngine();
  // The types make `session` required; these tests are JavaScript, and so is
  // every real consumer of `dist`. Without a runtime check, `new McpServer({
  // engine })` would build a server whose trail is a fresh object per call —
  // operations vanish and nothing is reported.
  assert.throws(() => new McpServer({ engine }), /requires a shared EvidenceAuditSession/);
  assert.throws(
    () => new McpServer({ engine, session: undefined }),
    /createTrackedMcpServer/,
    "拒绝信息必须点名该用哪个接缝",
  );
});
