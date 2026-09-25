import { test } from "node:test";
import assert from "node:assert/strict";

import {
  McpServer,
  MCP_PROTOCOL_VERSION,
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../dist/dispatch.js";
import { OrderedReplyQueue } from "../dist/io.js";
import { makeEngine } from "./helpers.mjs";

const enq = (obj) => JSON.stringify(obj);

function makeServer(timeoutMs = 500) {
  const { engine, io } = makeEngine({ timeoutMs });
  const server = new McpServer({ engine });
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
 * Await the queue until nothing is queued *or* about to be queued: a delivery
 * step joins the chain one microtask after its request resolves, and each write
 * below yields a macrotask, so a single `drained()` can return too early.
 */
async function drainAll(queue) {
  for (let round = 0; round < 6; round++) {
    await queue.drained();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("an outstanding gp_act does not hold back ping or tools/list", async () => {
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
  await drainAll(queue);
  assert.deepEqual(written.map((r) => r.id), [101, 102],
    "ping and tools/list are answered while the act is still outstanding");
  assert.equal(written[1].result.tools.length, 16);
  assert.equal(writesMostInFlight, 1, "frames still go out one at a time");

  io.respond({ operationId: "op_0123456789ABCDEFGHJKMNPQRS", actConfirmed: true });
  await drainAll(queue);
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
  await drainAll(queue);
  assert.deepEqual(reported.map((e) => e.message), ["handleLine blew up", "stdout rejected"]);
  assert.equal(reached, true, "a poisoned chain would stop every later reply");
});