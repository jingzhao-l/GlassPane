import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createHttpGateway } from "../dist/http-gateway.js";
import { EngineCallError } from "../dist/engine-client.js";
import { GP_E_NO_EVIDENCE } from "../dist/errors.js";

const TEST_TOKEN = "test-bearer-token-12345";

/**
 * In-memory engine client injected through `connectController`, so these tests
 * exercise a real HTTP server (node:http, 127.0.0.1, port 0) end to end without
 * ever opening a Unix socket to the daemon.
 */
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

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  invoked(method) {
    return this.calls.filter((call) => call.method === method);
  }
}

/** A valid evidence pack (the shared cross-language fixture), reused verbatim. */
function fixturePack() {
  return JSON.parse(
    readFileSync(new URL("../../kernel/fixtures/evidence-pack.ok-03.json", import.meta.url), "utf8"),
  );
}

const ID = "op_0PAAAABBBBCCCCDDDDEEEEFFFF";
const MISSING_ID = "op_0PAAAABBBBCCCCDDDDEEEEFFFG";

function auth(token = TEST_TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

async function startGateway(fake, token = TEST_TOKEN) {
  const gw = createHttpGateway({
    socketPath: "/tmp/fake-engine.sock", // never touched: connectController replaces the connector
    token,
    port: 0,
    connectController: () => fake,
  });
  await new Promise((resolve) => gw.server.once("listening", resolve));
  return { gw, base: `http://127.0.0.1:${gw.server.address().port}` };
}

test("GET /v1/hello returns the daemon hello result", async () => {
  const fake = new FakeGatewayClient();
  fake.on("hello", () => ({ engine: "glasspaned", version: "0.1.0", protocolVersion: "0" }));
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/hello`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.protocolVersion, "0");
    assert.equal(body.result.engine, "glasspaned");
  } finally {
    await gw.close();
  }
});

test("GET /v1/evidence/:operationId renders a single pack as html", async () => {
  const fake = new FakeGatewayClient();
  fake.on("last_evidence", () => ({ evidencePack: fixturePack() }));
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/evidence/${ID}?format=html`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.operationId, ID);
    assert.equal(body.result.format, "html");
    assert.ok(body.result.report.includes('<div class="gp-evidence"'));
    assert.ok(body.result.report.includes(ID));
    assert.ok(!body.result.report.includes("skipped"), "a single pack must not fabricate a skip note");
  } finally {
    await gw.close();
  }
});

test("GET /v1/evidence?ids= renders packs and marks a missing one skipped, not failed", async () => {
  const fake = new FakeGatewayClient();
  fake.on("last_evidence", (params) => {
    if (params.operationId === MISSING_ID) {
      throw new EngineCallError(GP_E_NO_EVIDENCE, `no evidence for ${MISSING_ID}`, "re-run an act to regenerate evidence");
    }
    return { evidencePack: fixturePack() };
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/evidence?ids=${ID},${MISSING_ID}&format=markdown`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.format, "markdown");
    assert.deepEqual(body.result.renderedIds, [ID]);
    assert.deepEqual(body.result.skipped, [MISSING_ID]);
    assert.ok(body.result.report.includes("# GlassPane evidence reports (1)"));
    assert.ok(body.result.report.includes("skipped 1 unreachable entry"));
    assert.equal(fake.invoked("last_evidence").length, 2);
  } finally {
    await gw.close();
  }
});

test("GET /v1/evidence with all ids missing fails honestly (no fake render)", async () => {
  const fake = new FakeGatewayClient();
  fake.on("last_evidence", (params) => {
    throw new EngineCallError(GP_E_NO_EVIDENCE, `no evidence for ${params.operationId}`, "re-run an act to regenerate evidence");
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/evidence?ids=${MISSING_ID}&format=html`, { headers: auth() });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, GP_E_NO_EVIDENCE);
  } finally {
    await gw.close();
  }
});

test("401 without a bearer token", async () => {
  const fake = new FakeGatewayClient();
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/hello`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "GP_HTTP_UNAUTHORIZED");
    assert.ok(body.error.remedy.includes("Authorization"));
  } finally {
    await gw.close();
  }
});

test("401 with a wrong bearer token", async () => {
  const fake = new FakeGatewayClient();
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/hello`, { headers: auth("definitely-not-the-token") });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "GP_HTTP_UNAUTHORIZED");
  } finally {
    await gw.close();
  }
});

test("POST /v1/tools/:name returns 404 for a method outside the whitelist", async () => {
  const fake = new FakeGatewayClient();
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/recent_reports`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "GP_HTTP_NOT_FOUND");
    assert.equal(fake.invoked("recent_reports").length, 0);
  } finally {
    await gw.close();
  }
});

test("POST /v1/tools/act with a non-JSON body returns 400", async () => {
  const fake = new FakeGatewayClient();
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/act`, {
      method: "POST",
      headers: auth(),
      body: "this is definitely not json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "GP_HTTP_BAD_REQUEST");
    assert.equal(fake.invoked("act").length, 0, "a bad body must never reach the engine");
  } finally {
    await gw.close();
  }
});

test("POST /v1/tools/act forwards valid params and returns the engine result", async () => {
  const fake = new FakeGatewayClient();
  fake.on("act", (params) => ({ operationId: ID, actConfirmed: true, selector: params.selector }));
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/act`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ selector: { role: "button", title: "OK" }, action: "press" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.actConfirmed, true);
    assert.equal(body.result.selector.title, "OK");
  } finally {
    await gw.close();
  }
});

test("POST /v1/tools/act surfaces the engine's no-replay remedy on error", async () => {
  const fake = new FakeGatewayClient();
  fake.on("act", () => {
    throw new EngineCallError("GP_E_ENGINE_TIMEOUT", "engine is still working on 'act'", "do NOT re-issue act");
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/act`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ selector: { role: "button" }, action: "press" }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "GP_E_ENGINE_TIMEOUT");
    assert.ok(body.error.remedy.includes("do NOT re-issue act"));
  } finally {
    await gw.close();
  }
});

test("createHttpGateway refuses an empty token (security red line)", () => {
  assert.throws(() => createHttpGateway({ socketPath: "/tmp/x.sock", token: "" }));
});