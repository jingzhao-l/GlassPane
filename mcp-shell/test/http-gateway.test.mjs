import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

import { createHttpGateway } from "../dist/http-gateway.js";
import { EngineCallError, slowEngineRemedy } from "../dist/engine-client.js";
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

  /** Captured by the gateway; see R8b-高3 (a bridge must write down what no
   * HTTP response carries). */
  onEngineNote(handler) {
    this.noteHandler = handler;
  }

  onLateReply(handler) {
    this.lateHandler = handler;
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

async function startGateway(fake, token = TEST_TOKEN, extra = {}) {
  const gw = createHttpGateway({
    socketPath: "/tmp/fake-engine.sock", // never touched: connectController replaces the connector
    token,
    port: 0,
    connectController: () => fake,
    ...extra,
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


/* ------------------------------------------------------------------ *
 * A: GET /v1/evidence?ids= caps the id count at 20 (no request amplification)
 * ------------------------------------------------------------------ */

test("GET /v1/evidence?ids= rejects more than 20 ids with 400 before touching the daemon", async () => {
  const fake = new FakeGatewayClient();
  fake.on("last_evidence", () => ({ evidencePack: fixturePack() }));
  const { gw, base } = await startGateway(fake);
  try {
    const ids = Array.from({ length: 21 }, (_, i) => `op_0PAAAA${String(i).padStart(20, "0")}`).join(",");
    const res = await fetch(`${base}/v1/evidence?ids=${ids}`, { headers: auth() });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "GP_HTTP_BAD_REQUEST");
    assert.ok(body.error.message.includes("20"), "the message must name the ceiling");
    assert.equal(fake.invoked("last_evidence").length, 0, "over-limit ids must never reach the daemon");
  } finally {
    await gw.close();
  }
});

/* ------------------------------------------------------------------ *
 * B: token length/prefix cannot take a shortcut branch (constant-time compare)
 * ------------------------------------------------------------------ */

test("401 for tokens shorter, longer or equal-but-different from the real token", async () => {
  const fake = new FakeGatewayClient();
  const { gw, base } = await startGateway(fake);
  try {
    const candidates = ["", "t", "short", "x".repeat(64), TEST_TOKEN.slice(0, -1) + "Z"];
    for (const token of candidates) {
      const res = await fetch(`${base}/v1/hello`, {
        headers: token === "" ? {} : { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 401, `token of length ${token.length} must yield 401, not pass a length branch`);
      const body = await res.json();
      assert.equal(body.error.code, "GP_HTTP_UNAUTHORIZED");
    }
  } finally {
    await gw.close();
  }
});

/* ------------------------------------------------------------------ *
 * C: surplus path segments are a 404, never a silently-trimmed route
 * ------------------------------------------------------------------ */

test("an extra path segment after a real route returns 404 (no silent trimming)", async () => {
  const fake = new FakeGatewayClient();
  fake.on("act", () => ({ operationId: ID, actConfirmed: true }));
  fake.on("last_evidence", () => ({ evidencePack: fixturePack() }));
  const { gw, base } = await startGateway(fake);
  try {
    const cases = [
      { url: `${base}/v1/hello/x`, method: "GET" },
      { url: `${base}/v1/evidence/${ID}/junk`, method: "GET" },
      {
        url: `${base}/v1/tools/act/junk`,
        method: "POST",
        body: JSON.stringify({ selector: { role: "button" }, action: "press" }),
      },
    ];
    for (const c of cases) {
      const res = await fetch(c.url, { method: c.method, headers: auth(), body: c.body });
      assert.equal(res.status, 404, `expected 404 for ${c.url}`);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "GP_HTTP_NOT_FOUND");
    }
    assert.equal(fake.invoked("act").length, 0, "/v1/tools/act/junk must not dispatch the real act");
  } finally {
    await gw.close();
  }
});

/* ------------------------------------------------------------------ *
 * D: POST /v1/tools/last_evidence runs the same contract validation as the
 *    evidence GET and MCP paths (a daemon frame that does not parse is never
 *    passed through as trusted evidence)
 * ------------------------------------------------------------------ */

test("POST /v1/tools/last_evidence does not pass through an unparseable frame", async () => {
  const fake = new FakeGatewayClient();
  fake.on("last_evidence", () => ({ notEvidence: true }));
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/last_evidence`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ operationId: ID }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false, "an unparseable frame must never be echoed as ok:true");
    assert.equal(body.error.code, "GP_E_INTERNAL");
    assert.ok(body.error.message.includes("evidencePack"), "the message must call out the missing contract");
  } finally {
    await gw.close();
  }
});

test("POST /v1/tools/last_evidence passes a parseable frame through honestly", async () => {
  const fake = new FakeGatewayClient();
  const raw = { evidencePack: fixturePack() };
  fake.on("last_evidence", () => raw);
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/last_evidence`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ operationId: ID }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.result.evidencePack, "a parseable frame is echoed");
  } finally {
    await gw.close();
  }
});

/* ------------------------------------------------------------------ *
 * E: daemon-CLI-only capabilities answer honestly (never a fabricated success)
 * ------------------------------------------------------------------ */

test("GET /v1/stats answers honestly that stats are not on the socket protocol", async () => {
  const fake = new FakeGatewayClient();
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/stats`, { headers: auth() });
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "GP_HTTP_NOT_PROVIDED");
    assert.ok(body.error.remedy.includes("--evidence-stats"), "must point at the daemon CLI");
    assert.equal(fake.calls.length, 0, "no daemon method is invented for stats");
  } finally {
    await gw.close();
  }
});

test("POST /v1/recipes/validate answers honestly that validation is not on the socket protocol", async () => {
  const fake = new FakeGatewayClient();
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/recipes/validate`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "demo-recipe" }),
    });
    assert.equal(res.status, 501);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "GP_HTTP_NOT_PROVIDED");
    assert.ok(body.error.remedy.includes("--recipe-validate"), "must point at the daemon CLI");
    assert.equal(fake.calls.length, 0, "recipe validation must not dispatch any daemon call");
  } finally {
    await gw.close();
  }
});

/* ------------------------------------------------------------------ *
 * F/G: release wiring and bundle keep the http-gateway importable (smoke gate)
 * ------------------------------------------------------------------ */

const MCP_SHELL_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Recursively copy a directory tree (schema fixtures) using the platform `cp`. */
function copyRecursive(src, dest) {
  const res = spawnSync("cp", ["-R", `${src}/.`, dest], { encoding: "utf8" });
  assert.equal(res.status, 0, `schema copy failed: ${res.stderr}`);
}


test("release bundle preserves a resolvable http-gateway entry and the publish wiring", async () => {
  const pkg = JSON.parse(readFileSync(path.join(MCP_SHELL_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.bin["glasspane-mcp"], "dist/index.js");
  assert.equal(pkg.bin["glasspane-http"], "dist/http-gateway-cli.js", "bin must expose the CLI entry");
  assert.ok(pkg.exports["./http-gateway"], "exports must surface ./http-gateway");

  // The bundle script must multi-enter the library AND the CLI entry, and its
  // dist clean-up must whitelist both http-gateway.js and http-gateway-cli.js
  // so the release bundle is not silently dropped (the regression this gates).
  assert.match(pkg.scripts.bundle, /src\/http-gateway\.ts/);
  assert.match(pkg.scripts.bundle, /src\/http-gateway-cli\.ts/);
  assert.match(pkg.scripts.bundle, /dist\/http-gateway\.js/);
  assert.match(pkg.scripts.bundle, /dist\/http-gateway-cli\.js/);
  const findDelete = /find dist[^&]*? -delete/.exec(pkg.scripts.bundle);
  assert.ok(findDelete, "bundle script must keep a dist clean-up step");
  assert.match(findDelete[0], /! -name 'http-gateway\.js'/);
  assert.match(findDelete[0], /! -name 'http-gateway-cli\.js'/);

  // Prove createHttpGateway stays importable from an actual esbuild bundle.
  const dir = mkdtempSync(path.join(os.tmpdir(), "gp-bundle-smoke-"));
  try {
    // The library bundle reads evidence-pack.schema.json from a sibling
    // `schemas/` at import time (mirroring the published `schemas/` copy the
    // bundle script makes). Recreate that layout so the bundle is importable.
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    mkdirSync(path.join(dir, "schemas"), { recursive: true });
    copyRecursive(
      path.join(MCP_SHELL_ROOT, "..", "kernel", "schemas"),
      path.join(dir, "schemas"),
    );
    buildSync({
      entryPoints: [path.join(MCP_SHELL_ROOT, "src", "http-gateway.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      // No externals: the temp bundle has no node_modules, so it must be
      // self-contained to be importable at all.
      outfile: path.join(dir, "dist", "http-gateway.js"),
      logLevel: "silent",
    });
    const bundled = await import(pathToFileURL(path.join(dir, "dist", "http-gateway.js")).href);
    assert.equal(typeof bundled.createHttpGateway, "function", "bundled http-gateway must export createHttpGateway");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * R8b-高3: this gateway hands out the engine client's timeout remedy, which
 * tells a caller to go read *this process's* stderr. That promise was false
 * twice over: nothing registered for the engine notes or late replies, and the
 * remedy text named `gp_recent_reports` — a tool the HTTP surface does not
 * expose (`FORWARDABLE_TOOLS` skips every tool with its own `execute`).
 * ------------------------------------------------------------------ */

test("the gateway registers for engine notes and late replies and writes them to its report sink", async () => {
  const fake = new FakeGatewayClient();
  const notes = [];
  const { gw, base } = await startGateway(fake, TEST_TOKEN, { report: (note) => notes.push(note) });
  try {
    assert.ok(base, "the server is up");
    assert.equal(typeof fake.noteHandler, "function", "没有 onEngineNote 注册，日志承诺就是空的");
    assert.equal(typeof fake.lateHandler, "function", "没有 onLateReply 注册同上");

    fake.noteHandler("engine sent a frame for request id 3, which this client never issued");
    assert.ok(notes.some((line) => line.includes("never issued")), JSON.stringify(notes));

    fake.lateHandler({ method: "act", result: { operationId: "op_http_late" } });
    const late = notes.find((line) => line.includes("late engine reply"));
    assert.ok(late, `迟到回复必须带正文落地，operationId 才取得到：${JSON.stringify(notes)}`);
    assert.ok(late.includes("op_http_late"));
  } finally {
    await gw.close();
  }
});

test("the gateway's timeout remedy routes to its own route, not to an MCP tool", async () => {
  const fake = new FakeGatewayClient();
  fake.on("act", () => Promise.reject(new EngineCallError(
    "GP_E_ENGINE_TIMEOUT",
    "engine is still working on 'act': no reply after 50000ms",
    slowEngineRemedy("act", "http"),
  )));
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/act`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ selector: { role: "AXButton" }, action: "press" }),
    });
    const body = await res.text();
    assert.equal(res.status, 502, body);
    assert.ok(!body.includes("gp_recent_reports"),
      `HTTP 调用方没有这个工具可调：${body.slice(0, 240)}`);
    assert.ok(body.includes("/v1/evidence/"), `要给出它真能走的那条路：${body.slice(0, 240)}`);
  } finally {
    await gw.close();
  }
});
