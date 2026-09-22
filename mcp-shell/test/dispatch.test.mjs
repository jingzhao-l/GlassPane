import { test } from "node:test";
import assert from "node:assert/strict";

import {
  McpServer,
  MCP_PROTOCOL_VERSION,
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../dist/dispatch.js";
import { makeEngine } from "./helpers.mjs";

const enq = (obj) => JSON.stringify(obj);

function makeServer(timeoutMs = 500) {
  const { engine, io } = makeEngine({ timeoutMs });
  const server = new McpServer({ engine });
  return { server, engine, io };
}

/**
 * Server for the initialize version negotiation (spec P0 §6.1). Passing
 * `supportedVersions` injects a version set that differs from the shipped one —
 * without that seam an "echo" assertion would be indistinguishable from the
 * always-answer-our-own-constant behaviour this fix removed.
 */
function makeVersionServer(supportedVersions) {
  const { engine } = makeEngine({ timeoutMs: 500 });
  const deps = { engine };
  if (supportedVersions !== undefined) {
    deps.supportedProtocolVersions = supportedVersions;
  }
  return new McpServer(deps);
}

/** One initialize frame; `params === undefined` omits params entirely. */
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
test("initialize echoes a client protocolVersion this server implements", async () => {
  const server = makeVersionServer(["2024-11-05", MCP_PROTOCOL_VERSION]);
  const response = await initialize(server, {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  });
  assert.equal(response.error, undefined);
  assert.equal(response.id, 1);
  // 回显的是客户端那一个，不是本 shell 的常量
  assert.equal(response.result.protocolVersion, "2024-11-05");
  assertHandshakeShape(response.result);
});

test("initialize echoes its own constant when the client asks for exactly that", async () => {
  const server = makeVersionServer(); // shipped default set, no injection
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(MCP_PROTOCOL_VERSION));
  const response = await initialize(server, { protocolVersion: MCP_PROTOCOL_VERSION });
  assert.equal(response.error, undefined);
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assertHandshakeShape(response.result);
});

test("initialize falls back to its own constant on an unimplemented client version", async () => {
  const server = makeVersionServer(); // ships only MCP_PROTOCOL_VERSION
  const response = await initialize(server, {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  });
  assert.equal(response.error, undefined);
  assert.notEqual(response.result.protocolVersion, "2024-11-05");
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assertHandshakeShape(response.result);
});

test("initialize answers a version-less handshake instead of crashing", async () => {
  const server = makeVersionServer();
  const response = await initialize(server, { capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(response.error, undefined);
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assertHandshakeShape(response.result);
});

test("initialize never rejects a garbage protocolVersion, it falls back", async () => {
  const server = makeVersionServer();
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

test("tools/list returns the fourteen tools", async () => {
  const { server } = makeServer();
  const response = await server.handleLine(enq({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
  const names = response.result.tools.map((tool) => tool.name);
  assert.equal(names.length, 14);
  assert.ok(names.includes("gp_attach"));
  assert.ok(names.includes("gp_snapshot"));
  assert.ok(names.includes("gp_restore"));
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