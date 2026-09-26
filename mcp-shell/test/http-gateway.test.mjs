import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

import { assertLoopbackHost, createHttpGateway, GLASSPANE_HTTP_TOKEN_ENV, MIN_TOKEN_CHARS, MIN_TOKEN_DISTINCT_CHARS } from "../dist/http-gateway.js";
import { EngineCallError, slowEngineRemedy } from "../dist/engine-client.js";
import { replayUnsafePayloadAdvice, TOOL_SPECS } from "../dist/tools.js";
import * as errorCodes from "../dist/errors.js";
import {
  GP_E_BAD_PARAMS,
  GP_E_ENGINE_UNREACHABLE,
  GP_E_INTERNAL,
  GP_E_NO_EVIDENCE,
  GP_E_PAYLOAD_TOO_LARGE,
} from "../dist/errors.js";

/**
 * A token that satisfies the gateway's own credential policy (see
 * `MIN_TOKEN_CHARS`): 34 characters over more than a dozen distinct ones. It used
 * to be `"test-bearer-token-12345"`, which the policy now refuses — a fixture is
 * allowed to follow a rule the product gained; the assertions are untouched.
 */
const TEST_TOKEN = "test-bearer-token-0123456789abcdef";

/** The compiled CLI, spawned for the two paths only a process can show. */
const CLI_PATH = fileURLToPath(new URL("../dist/http-gateway-cli.js", import.meta.url));

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
    assert.equal(res.status, 504, "a request this shell stopped waiting for is a 504, not a 502: the gateway is not the part that failed");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "GP_E_ENGINE_TIMEOUT");
    assert.ok(body.error.remedy.includes("do NOT re-issue act"));
  } finally {
    await gw.close();
  }
});

test("createHttpGateway refuses an empty token (security red line)", async () => {
  // Whatever this starts gets closed even though it is expected to throw: with the
  // check removed the call returns a live listener, and an unreferenced server on
  // the event loop turns "the guard was deleted" into a suite that hangs instead
  // of going red (found by running exactly that mutation).
  let started = null;
  try {
    assert.throws(() => {
      started = createHttpGateway({ socketPath: "/tmp/x.sock", token: "", port: 0 });
    });
  } finally {
    if (started !== null && typeof started.close === "function") {
      await started.close().catch(() => {});
    }
  }
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
    // 504, not 502: `GP_E_ENGINE_TIMEOUT` is this shell's own deadline on the
    // daemon's behalf, and a 502 told the caller its gateway had broken.
    assert.equal(res.status, 504, body);
    assert.ok(!body.includes("gp_recent_reports"),
      `HTTP 调用方没有这个工具可调：${body.slice(0, 240)}`);
    assert.ok(body.includes("/v1/evidence/"), `要给出它真能走的那条路：${body.slice(0, 240)}`);
  } finally {
    await gw.close();
  }
});

/* ------------------------------------------------------------------ *
 * R9-高1: the module doc promised "127.0.0.1 only (never a wildcard)" while
 * `createHttpGateway` handed `options.host` straight to `listen()`. This module is
 * a published npm export (`./http-gateway`), so one option value could put the
 * whole act/restore surface on a routable address behind one bearer token with no
 * TLS. Reverse mutation: pass `options.host` through again (or delete
 * `assertLoopbackHost`) and every test in this block goes red.
 * ------------------------------------------------------------------ */

test("createHttpGateway refuses every host that is not loopback, naming the value and the reason", async () => {
  const rejected = [
    "0.0.0.0", "::", "", "   ", "192.168.1.10", "10.0.0.1", "127.0.0.256",
    "localhost.localdomain", "127.0.0.1.attacker.example", "127.0.0.1:8787", "example.com",
  ];
  let clientsOpened = 0;
  // Anything this loop *does* start gets closed: were the guard removed, a test
  // that only asserts the refusal would leave eleven wildcard listeners holding
  // the event loop, and the mutation check would hang instead of going red.
  const started = [];
  try {
    for (const host of rejected) {
      let error = null;
      try {
        started.push(createHttpGateway({
          socketPath: "/tmp/never-opened.sock",
          token: TEST_TOKEN,
          port: 0,
          host,
          connectController: () => {
            clientsOpened += 1;
            return new FakeGatewayClient();
          },
        }));
      } catch (thrown) {
        error = thrown;
      }
      assert.ok(error instanceof Error, `host '${host}' 必须被拒绝，不能被悄悄绑上去`);
      assert.ok(error.message.includes(`'${host}'`), `拒绝必须点名被拒的 host：${error.message}`);
      assert.match(error.message, /loopback/i, `拒绝必须说出为什么：${error.message}`);
      assert.match(error.message, /act\/restore/, `拒绝必须说出被保护的是什么：${error.message}`);
    }
    assert.equal(clientsOpened, 0, "被拒绝的 bind 不得先开一个 engine client 再抛");
    assert.equal(started.length, 0, "被拒绝的 host 不得留下一个 listening 的 server");
  } finally {
    for (const gw of started) {
      gw.server.removeAllListeners("error");
      gw.server.on("error", () => {});
      await gw.close().catch(() => {});
    }
  }
});

test("the loopback spellings an operator may actually write are accepted", () => {
  for (const host of ["127.0.0.1", "127.5.6.7", "::1", "[::1]", "localhost", "LOCALHOST", "::ffff:127.0.0.1"]) {
    assert.equal(assertLoopbackHost(host), host.trim(), `'${host}' 是本机回环，必须放行`);
  }
  // The refused half of the same function, so a widening of the accepted set here
  // cannot pass by only ever being tested against values it already allows.
  assert.throws(() => assertLoopbackHost("0.0.0.0"), /loopback/);
  assert.throws(() => assertLoopbackHost("169.254.1.1"), /loopback/);
});

test("a refused bind never reaches the socket, and an accepted one is loopback", async () => {
  const fake = new FakeGatewayClient();
  let error = null;
  let started = null;
  try {
    started = createHttpGateway({ socketPath: "/tmp/x.sock", token: TEST_TOKEN, port: 0, host: "0.0.0.0" });
  } catch (thrown) {
    error = thrown;
  }
  try {
    assert.ok(error instanceof Error, "0.0.0.0 必须被拒绝");
    assert.equal(started, null, "被拒绝的 bind 不能返回一个 server");
  } finally {
    if (started !== null) {
      started.server.removeAllListeners("error");
      started.server.on("error", () => {});
      await started.close().catch(() => {});
    }
  }
  const { gw, base } = await startGateway(fake);
  try {
    assert.equal(gw.server.address().address, "127.0.0.1", "默认 bind 必须是回环地址本身");
    assert.ok(base.startsWith("http://127.0.0.1"));
  } finally {
    await gw.close();
  }
});

/* ------------------------------------------------------------------ *
 * R9-高2: the bearer token was checked for one thing — being non-empty — so
 * `GLASSPANE_HTTP_TOKEN=a` guarded the act/restore surface, and any local process
 * could try the rest at loopback speed. Reverse mutation: delete the length /
 * distinctness arms (or drop the CLI's own check) and both tests here go red.
 * ------------------------------------------------------------------ */

test("createHttpGateway refuses a token under either stated arm of the policy", async () => {
  const underLength = "a1b2c3d4e5f6g7h8i9j0k".slice(0, 21) + "-xyz";
  const underEntropy = "q".repeat(MIN_TOKEN_CHARS + 12);
  const cases = [
    { token: underLength, arm: /character\(s\)/, stated: String(underLength.length) },
    { token: underEntropy, arm: /distinct/, stated: "1" },
  ];
  for (const { token, arm, stated } of cases) {
    let error = null;
    let opened = null;
    try {
      opened = createHttpGateway({ socketPath: "/tmp/x.sock", token, port: 0, connectController: () => new FakeGatewayClient() });
    } catch (thrown) {
      error = thrown;
    }
    try {
      assert.ok(error instanceof Error, `${token.length} 字符的 token 必须被拒绝`);
      assert.match(error.message, new RegExp(GLASSPANE_HTTP_TOKEN_ENV), "拒绝理由要说出是哪个环境变量");
      assert.match(error.message, arm, `拒绝理由要指出触发了哪一条：${error.message}`);
      assert.ok(error.message.includes(stated), `拒绝理由要报出实测到的数字 ${stated}：${error.message}`);
      assert.ok(error.message.includes(String(MIN_TOKEN_CHARS)), "门槛数字要说出来，不能让人猜");
      assert.ok(error.message.includes(String(MIN_TOKEN_DISTINCT_CHARS)), "门槛数字要说出来，不能让人猜");
      assert.match(error.message, /openssl rand -hex/, "要给一条做得到的生成命令");
    } finally {
      // Same reason as the loopback block: if the policy arm is deleted, this call
      // returns a listener, and a held event loop makes the reverse mutation hang
      // the suite instead of reddening it.
      if (opened !== null && typeof opened.close === "function") {
        await opened.close().catch(() => {});
      }
    }
  }
  // The positive half: a token at the policy's other side starts a real gateway,
  // so the two arms above are the difference and not an unstartable factory.
  const started = createHttpGateway({
    socketPath: "/tmp/x.sock",
    token: TEST_TOKEN,
    port: 0,
    connectController: () => new FakeGatewayClient(),
  });
  started.server.on("error", () => {});
  await new Promise((resolve) => started.server.once("listening", resolve));
  await started.close();
});

test("the CLI states the token policy in its help and refuses to start under it", () => {
  const help = spawnSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes(String(MIN_TOKEN_CHARS)), "usage 要写明长度门槛");
  assert.ok(help.stdout.includes(String(MIN_TOKEN_DISTINCT_CHARS)), "usage 要写明熵门槛");
  assert.match(help.stdout, /openssl rand -hex/);

  const short = spawnSync(process.execPath, [CLI_PATH, "--port", "0"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, [GLASSPANE_HTTP_TOKEN_ENV]: "hunter2", GLASSPANE_ENGINE_SOCK: "/tmp/gp-absent.sock" },
  });
  assert.equal(short.status, 2, short.stderr);
  assert.match(short.stderr, new RegExp(String(MIN_TOKEN_CHARS)), "拒绝要报出门槛数字");
  // The CLI's own sentence, not the library's exception arriving through the
  // `failed to start` catch: the operator reading a terminal needs the rule and
  // the command that satisfies it, and a refusal routed through a thrown Error
  // is the shape that lets the check be deleted while this still looks green.
  assert.match(short.stderr, /refusing to start with a credential under the/, short.stderr);
  assert.match(short.stderr, /openssl rand -hex/, short.stderr);
  assert.ok(!short.stderr.includes("failed to start the HTTP gateway"), short.stderr);
  assert.ok(!short.stderr.includes("listening on"), "低于门槛的 token 不得先把端口绑上");

  const missing = spawnSync(process.execPath, [CLI_PATH, "--port", "0"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, [GLASSPANE_HTTP_TOKEN_ENV]: "" },
  });
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /not set or is empty/);
});

/* ------------------------------------------------------------------ *
 * R9-中3: a failed bind was logged and the process carried on. A gateway that is
 * not listening is not serving, so the port's real owner answered everything —
 * including this gateway's bearer token, replayed back at any client its own
 * remedy text sent to stderr — while the process looked alive and exited 0.
 * Reverse mutation: log-and-continue in the `error` listener (the old shape) and
 * the exit code / FATAL / not-serving assertions below all go red at once.
 * ------------------------------------------------------------------ */

test("the CLI exits with a named reason when the port cannot be bound", async () => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const port = holder.address().port;
  try {
    const res = spawnSync(process.execPath, [CLI_PATH, "--port", String(port)], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        [GLASSPANE_HTTP_TOKEN_ENV]: TEST_TOKEN,
        GLASSPANE_ENGINE_SOCK: "/tmp/gp-absent.sock",
      },
    });
    assert.notEqual(res.status, 0, `绑不上端口还退 0 的进程看起来像在服务：${res.stderr}`);
    assert.equal(res.status, 3, "绑定失败要有自己的退出码，配置错误是另一个");
    assert.match(res.stderr, /EADDRINUSE/, "要报出真实错误码，不能只写一句 server error");
    assert.match(res.stderr, /FATAL/);
    assert.ok(res.stderr.includes(String(port)), `要报出是哪个端口：${res.stderr}`);
    assert.match(res.stderr, /not serving/, "要说清这个进程没有在服务");
    assert.ok(!res.stderr.includes("listening on"), "没有 listening 事件就不得打印 listening");
    assert.ok(!/--restore-launchd/.test(res.stderr), "端口冲突不得把调用方支去重启 daemon");
  } finally {
    holder.close();
  }
});

/* ------------------------------------------------------------------ *
 * R9-高4: every daemon code but GP_E_NO_EVIDENCE was mapped to 502, so a request
 * the daemon had answered about the caller's own input looked like a gateway
 * failure — and 502 is the answer an HTTP client or a cautious agent reads as
 * "send it again", which on `act` is a second click. Non-engine failures were
 * reported as "engine transport error … ensure the daemon is running, then retry"
 * — a restart order for a daemon that had, in every reachable case, just answered.
 * Reverse mutation: restore `error.code === GP_E_NO_EVIDENCE ? 404 : 502` or the
 * old fall-through text, and the sweep and both wording tests below go red.
 * ------------------------------------------------------------------ */

/** Every code the daemon's own enum declares, read out of the Swift source. */
function daemonErrorCodeSet() {
  const file = path.resolve(MCP_SHELL_ROOT, "..", "engine", "Sources", "GlassPaneEngine", "ProtocolErrors.swift");
  const block = /public enum GPErrorCode: String, Codable, CaseIterable \{([\s\S]*?)\n\}/.exec(readFileSync(file, "utf8"));
  assert.ok(block, "读不到 GPErrorCode 枚举，这条分族断言就没有对照物");
  const codes = new Set();
  for (const raw of block[1].split("\n")) {
    const declared = /=\s*"(GP_E_[A-Z_]+)"/.exec(raw.replace(/\/\/.*$/, ""));
    if (declared) {
      codes.add(declared[1]);
    }
  }
  assert.ok(codes.size >= 15, `只解析出 ${codes.size} 个 daemon 错误码，扫描方式已经对不上写法`);
  return codes;
}

test("a code the daemon authored is never answered as a gateway failure", async () => {
  const codes = [...daemonErrorCodeSet()];
  let current = codes[0];
  const fake = new FakeGatewayClient();
  fake.on("observe", () => {
    throw new EngineCallError(current, `the daemon refused with ${current}`, "the daemon's own remedy, passed through unchanged");
  });
  const { gw, base } = await startGateway(fake);
  // Only the two codes that describe a reply this gateway could not deliver are
  // an upstream fault, and both are shared with the daemon by `errors.ts`.
  const upstreamFault = new Set([GP_E_INTERNAL, GP_E_PAYLOAD_TOO_LARGE]);
  const seen = new Map();
  try {
    for (const code of codes) {
      current = code;
      const res = await fetch(`${base}/v1/tools/observe`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ maxDepth: 2 }),
      });
      const body = await res.json();
      assert.equal(body.error.code, code, `状态映射改了错误码：${code}`);
      seen.set(code, res.status);
      assert.ok(res.status < 500 || upstreamFault.has(code),
        `${code} 是 daemon 亲口回答过的请求，被报成 ${res.status}＝"网关坏了，再发一次"`);
      assert.ok(res.status >= 400 && res.status <= 504, `${code} → ${res.status} 不在任何一个错误族里`);
    }
  } finally {
    await gw.close();
  }
  assert.equal(seen.size, codes.length, "每个 daemon 错误码都要真的被问到一次");
  // The two named in the finding, pinned to their number.
  assert.equal(seen.get("GP_E_NOT_FOUND"), 404);
  assert.equal(seen.get("GP_E_BUSY_INPUT"), 422, "输入被占用是 daemon 答复过的冲突，不是 502");
  assert.equal(seen.get(GP_E_NO_EVIDENCE), 404);
  assert.equal(seen.get(GP_E_BAD_PARAMS), 400);
});

test("a code the daemon does not declare is never answered as the caller's bad request", async () => {
  // The other direction of the same mapping: the shell-only codes in `errors.ts`
  // (`GP_E_ENGINE_TIMEOUT`, `GP_E_ENGINE_UNREACHABLE`, `GP_E_UNKNOWN`,
  // `GP_E_NO_USER_RECORD`) describe this process's side of the boundary, so none
  // of them may land on the 4xx arm the daemon-authored codes default to. A 4xx
  // for one of those tells a caller its request was wrong when the real answer is
  // "this gateway did not finish it" — the same misdirection the 502-on-everything
  // rule produced, pointing the other way.
  const daemon = daemonErrorCodeSet();
  const shellOnly = [...new Set(Object.values(errorCodes)
    .filter((value) => typeof value === "string" && value.startsWith("GP_E_") && !daemon.has(value)))];
  assert.ok(shellOnly.length >= 4, `只认出 ${shellOnly.length} 个 shell-only 错误码，扫描方式已经跟不上 errors.ts`);
  let current = shellOnly[0];
  const fake = new FakeGatewayClient();
  fake.on("observe", () => {
    throw new EngineCallError(current, `this shell raised ${current}`, "the shell's own remedy, passed through unchanged");
  });
  const { gw, base } = await startGateway(fake);
  try {
    for (const code of shellOnly) {
      current = code;
      const res = await fetch(`${base}/v1/tools/observe`, { method: "POST", headers: auth(), body: "{}" });
      const body = await res.json();
      assert.equal(body.error.code, code);
      assert.ok(res.status >= 500, `${code} 是 daemon 词表之外的码，被答成了 ${res.status}（调用方的错）`);
    }
  } finally {
    await gw.close();
  }
});

test("GP_E_ENGINE_UNREACHABLE keeps its 5xx and stays the one answer allowed to name a restart", async () => {
  const fake = new FakeGatewayClient();
  fake.on("observe", () => {
    throw new EngineCallError(
      GP_E_ENGINE_UNREACHABLE,
      "engine transport closed",
      'run "node installer/cli.js --restore-launchd" (auto-restores and verifies the launchd-managed daemon), then retry',
    );
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/observe`, { method: "POST", headers: auth(), body: "{}" });
    const text = await res.text();
    assert.equal(res.status, 503, text);
    assert.ok(text.includes("--restore-launchd"), "唯一该点名重启的那条被抹掉了：" + text);
  } finally {
    await gw.close();
  }
});

test("a gateway-side failure on a read says so, and orders neither a restart nor a blind retry", async () => {
  const fake = new FakeGatewayClient();
  fake.on("observe", () => {
    throw new Error("the reply could not be encoded");
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/observe`, { method: "POST", headers: auth(), body: "{}" });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error.code, GP_E_INTERNAL);
    assert.ok(!body.error.message.includes("engine transport error"),
      `这条不是传输层的事实：${body.error.message}`);
    assert.match(body.error.message, /this gateway/i, "要说清失败发生在网关这一侧");
    assert.ok(!/ensure the glasspane daemon is running/i.test(body.error.remedy), body.error.remedy);
    assert.ok(!body.error.remedy.includes("--restore-launchd"), body.error.remedy);
    assert.ok(!/\bretry\b/i.test(body.error.remedy), `未分条件的"retry"不得出现在这个答复里：${body.error.remedy}`);
    assert.ok(body.error.remedy.includes("/v1/tools/"), "要给出这条面上真能走的路");
  } finally {
    await gw.close();
  }
});

test("a gateway-side failure on act forbids the re-send it used to invite", async () => {
  const fake = new FakeGatewayClient();
  fake.on("act", () => {
    throw new Error("socket vanished while the reply was being read");
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/act`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ selector: { role: "AXButton" }, action: "press" }),
    });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.match(body.error.remedy, /do not re-send/, body.error.remedy);
    assert.ok(body.error.remedy.includes("POST /v1/tools/observe"), "要指出不改变的读法：" + body.error.remedy);
    assert.ok(!/\bretry\b/i.test(body.error.remedy), body.error.remedy);
    assert.ok(!/gp_[a-z_]+/.test(body.error.remedy), `HTTP 面上没有 gp_* 可调：${body.error.remedy}`);
    assert.match(body.error.remedy, /bounded|no operation trail/, "不得无条件承诺迟到的回复一定被记录");
  } finally {
    await gw.close();
  }
});

test("an unparseable evidence frame is answered as a frame problem on both evidence routes", async () => {
  const fake = new FakeGatewayClient();
  fake.on("last_evidence", () => ({ notEvidence: true }));
  const { gw, base } = await startGateway(fake);
  try {
    const routes = [`${base}/v1/evidence/${ID}`, `${base}/v1/evidence?ids=${ID}&format=html`];
    for (const url of routes) {
      const res = await fetch(url, { headers: auth() });
      const body = await res.json();
      assert.equal(res.status, 502, `${url}: ${JSON.stringify(body)}`);
      assert.equal(body.error.code, GP_E_INTERNAL);
      assert.ok(body.error.message.includes("evidencePack"), "message 要点名缺的契约");
      assert.ok(!/ensure the glasspane daemon is running/i.test(body.error.remedy), body.error.remedy);
      assert.ok(!/reenact/i.test(body.error.remedy), `"reenact the operation" 就是让用户再点一次：${body.error.remedy}`);
      assert.ok(!/retry act/i.test(body.error.remedy), body.error.remedy);
      assert.ok(body.error.remedy.includes("POST /v1/tools/observe"), body.error.remedy);
    }
    assert.equal(fake.invoked("last_evidence").length, 2);
  } finally {
    await gw.close();
  }
});

/* ------------------------------------------------------------------ *
 * R9-高5: the too-large reply path called `oversizedReplyAdvice` for every tool,
 * so a `POST /v1/tools/act` whose reply overflowed was told to "retry with a more
 * specific selector" — a second click on the user's screen, ordered by an answer
 * that proves the first one landed. `tools.ts` applies the no-replay split on the
 * MCP path; this pins the same decision here. Reverse mutation: drop the
 * `isReplayUnsafeEngineMethod` branch (call `oversizedReplyAdvice` for everything,
 * the old shape) and the act test below goes red; forward it verbatim to
 * `replayUnsafePayloadAdvice` and the `gp_` assertion goes red.
 * ------------------------------------------------------------------ */

const FRAME_TOO_LARGE = "the engine's reply exceeded the frame cap and was dropped; the connection is intact";

test("an oversized reply to act is answered with a no-replay advice, not a narrowing retry", async () => {
  const fake = new FakeGatewayClient();
  fake.on("act", () => {
    throw new EngineCallError(GP_E_PAYLOAD_TOO_LARGE, FRAME_TOO_LARGE, "IGNORED: the daemon's own line");
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/act`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ selector: { role: "AXButton" }, action: "press" }),
    });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.error.code, GP_E_PAYLOAD_TOO_LARGE);
    assert.match(body.error.remedy, /^do not re-send this request on this answer\./, body.error.remedy);
    assert.match(body.error.remedy, /too large for one frame/, "超帧这个事实要说出来");
    assert.ok(body.error.remedy.includes("POST /v1/tools/observe"), "要给出面上可读的路");
    assert.ok(!/gp_[a-z_]+/.test(body.error.remedy), `curl 调用方手上没有 gp_* 可调：${body.error.remedy}`);
    assert.match(body.error.remedy, /no operation trail/, "不得承诺这个面没有的东西");
  } finally {
    await gw.close();
  }
});

test("an oversized reply to a read keeps the narrowing advice its own schema advertises", async () => {
  const fake = new FakeGatewayClient();
  fake.on("observe", () => {
    throw new EngineCallError(GP_E_PAYLOAD_TOO_LARGE, FRAME_TOO_LARGE, "IGNORED");
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/observe`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ maxDepth: 10 }),
    });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.ok(!/do not re-send/.test(body.error.remedy), "读请求不需要 no-replay 文案：" + body.error.remedy);
    assert.match(body.error.remedy, /retry with/i, "读请求要拿到它自己的旋钮");
    assert.ok(body.error.remedy.includes("maxDepth"), body.error.remedy);
  } finally {
    await gw.close();
  }
});

test("this file's replay-unsafe method set matches the tool contract's own classification", () => {
  // The HTTP side keeps its own copy of the set because neither producer exports a
  // predicate (see the BLOCKED-ON-lane-B note in `http-gateway.ts`). This is the
  // drift pin: `replayUnsafePayloadAdvice` is lane B's exported function, and the
  // generic harm it falls back to is reached only for a method its own table does
  // not list — so the two classifications are compared in both directions here
  // rather than trusted to a comment.
  const httpSideUnsafe = new Set(["act", "restore", "attach"]);
  let unsafeSeen = 0;
  let safeSeen = 0;
  for (const spec of TOOL_SPECS) {
    const advice = replayUnsafePayloadAdvice(spec, spec.engineMethod, {});
    const contractSaysUnsafe = !advice.includes("it changes daemon state");
    assert.equal(httpSideUnsafe.has(spec.engineMethod), contractSaysUnsafe,
      `'${spec.engineMethod}'：HTTP 侧的集合与 tools.ts 的归类已经分叉了`);
    if (contractSaysUnsafe) {
      unsafeSeen += 1;
    } else {
      safeSeen += 1;
    }
  }
  assert.ok(unsafeSeen > 0 && safeSeen > 0, `两侧都没有任何一边可比（${unsafeSeen}/${safeSeen}），这条闸已经不看东西了`);
});

/* ------------------------------------------------------------------ *
 * R9-中6: the "all items skipped" branch and the unknown-tool branch sent a curl
 * caller to `gp_act` / `gp_assert_element` / `TOOL_SPECS` — none of which exist on
 * this surface, and in the skipped case the acts named had already run. Reverse
 * mutation: write a literal route list (or a `gp_*` name) back into either remedy
 * and the sweep below goes red, because it asks every route an error names.
 * ------------------------------------------------------------------ */

test("no error this gateway raises names an MCP tool, and every route it names answers", async () => {
  const fake = new FakeGatewayClient();
  fake.on("act", () => {
    throw new EngineCallError(GP_E_PAYLOAD_TOO_LARGE, FRAME_TOO_LARGE, "IGNORED");
  });
  fake.on("last_evidence", () => {
    throw new EngineCallError(GP_E_NO_EVIDENCE, "no evidence", "IGNORED");
  });
  const { gw, base } = await startGateway(fake);
  const bodies = [];
  try {
    const requests = [
      { url: `${base}/v1/hello`, init: undefined },
      { url: `${base}/v1/nope`, init: { headers: auth() } },
      { url: `${base}/v1/tools/recent_reports`, init: { method: "POST", headers: auth(), body: "{}" } },
      { url: `${base}/v1/tools/capture_view`, init: { method: "POST", headers: auth(), body: "{}" } },
      { url: `${base}/v1/evidence/not-an-id`, init: { headers: auth() } },
      { url: `${base}/v1/evidence/${ID}?format=json`, init: { headers: auth() } },
      { url: `${base}/v1/evidence?ids=${ID},${MISSING_ID}`, init: { headers: auth() } },
      { url: `${base}/v1/evidence?ids=${ID}`, init: { headers: auth() } },
      { url: `${base}/v1/tools/act`, init: { method: "POST", headers: auth(), body: JSON.stringify({ selector: { role: "AXButton" }, action: "press" }) } },
    ];
    for (const { url, init } of requests) {
      const res = await fetch(url, init);
      const text = await res.text();
      assert.ok(res.status >= 400, `这条用例本就要造一个错误答复：${url} → ${res.status}`);
      bodies.push({ url, text });
    }
    assert.equal(bodies.length, requests.length);

    const named = new Set();
    for (const { url, text } of bodies) {
      assert.ok(!/gp_[a-z_]+/.test(text), `这个面上不存在 gp_* 工具（${url}）：${text.slice(0, 200)}`);
      for (const match of text.matchAll(/POST \/v1\/tools\/([a-z_]+)/g)) {
        named.add(match[1]);
      }
    }
    // The sweep has to be looking at something, or it is decoration again.
    assert.ok(named.size >= 5, `只扫出 ${named.size} 条被点名的路由，这条闸已经没有读者`);
    for (const method of named) {
      const res = await fetch(`${base}/v1/tools/${method}`, {
        method: "POST",
        headers: auth(),
        body: "{}",
      });
      const body = await res.json();
      // `GP_HTTP_NOT_FOUND` is this gateway's own "no such route" code. A 404 that
      // carries a *daemon* code (`GP_E_NO_EVIDENCE` for the fake configured here)
      // is an answer, not a missing route, so the code is what this asserts on.
      assert.notEqual(body.error?.code, "GP_HTTP_NOT_FOUND",
        `错误文案把调用方支到一条这条网关不认识的路由：POST /v1/tools/${method}`);
    }
  } finally {
    await gw.close();
  }
});

test("the all-skipped aggregate points at reading, not at an act that already ran", async () => {
  const fake = new FakeGatewayClient();
  fake.on("last_evidence", () => {
    throw new EngineCallError(GP_E_NO_EVIDENCE, "no evidence in the daemon history", "IGNORED");
  });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/evidence?ids=${ID},${MISSING_ID}&format=markdown`, { headers: auth() });
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.error.code, GP_E_NO_EVIDENCE);
    assert.ok(!/re-run|rerun|gp_/i.test(body.error.remedy),
      `这些 act 已经跑过了，不能再被支去"重跑"：${body.error.remedy}`);
    assert.ok(body.error.remedy.includes("GET /v1/evidence/<operationId>"), body.error.remedy);
    assert.ok(body.error.remedy.includes("POST /v1/tools/observe"), body.error.remedy);
    assert.ok(body.error.remedy.includes("no operation trail"), "要说明这个面列不出跑过什么");
    assert.equal(fake.invoked("last_evidence").length, 2);
  } finally {
    await gw.close();
  }
});

test("the unknown-tool answer lists the routes that exist instead of a source symbol", async () => {
  const fake = new FakeGatewayClient();
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/tools/definitely_not_a_tool`, {
      method: "POST",
      headers: auth(),
      body: "{}",
    });
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.ok(!body.error.remedy.includes("TOOL_SPECS"), "curl 读者打不开一个源码符号");
    assert.ok(body.error.remedy.includes("POST /v1/tools/observe"), body.error.remedy);
    assert.ok(body.error.remedy.includes("POST /v1/tools/last_evidence"), body.error.remedy);
    assert.equal(fake.calls.length, 0, "未知工具不得被转发给 daemon");
  } finally {
    await gw.close();
  }
});

/* ------------------------------------------------------------------ *
 * R9-中7: the late-reply note stringified the whole body with no cap while the
 * MCP path truncates at 64 KiB and marks the cut — and the body on this surface is
 * raw UI-tree content. Reverse mutation: hand `JSON.stringify(result)` to `report`
 * again and the cap, the marker and the "not redacted" clause all go red.
 * ------------------------------------------------------------------ */

test("a late reply note is capped, says what it capped, and survives an unserialisable body", async () => {
  const fake = new FakeGatewayClient();
  const notes = [];
  const { gw } = await startGateway(fake, TEST_TOKEN, { report: (note) => notes.push(note) });
  try {
    fake.lateHandler({ method: "observe", result: { tree: "x".repeat(100_000) } });
    const big = notes.find((line) => line.includes("late engine reply to 'observe'"));
    assert.ok(big, "迟到回复必须落一行");
    assert.ok(big.length < 70_000, `未设上限的正文有 ${big.length} 字符`);
    assert.match(big, /reply body truncated: \d+ of \d+ chars not written/, "截断要说截了多少");
    assert.match(big, /not redacted/, "正文是原始 UI 树内容，不能不声明");

    fake.lateHandler({ method: "act", result: { operationId: "op_http_small" } });
    const small = notes.find((line) => line.includes("late engine reply to 'act'"));
    assert.ok(small.includes('{"operationId":"op_http_small"}'), "没超限的正文要原样落地");
    assert.ok(!/truncated/.test(small), small);

    const circular = {};
    circular.self = circular;
    const before = notes.length;
    assert.doesNotThrow(() => fake.lateHandler({ method: "diagnose", result: circular }));
    assert.equal(notes.length, before + 1, "序列化不了的正文仍要留下一行，不能让 sink 自己抛掉这条事实");
    assert.match(notes[notes.length - 1], /late engine reply to 'diagnose'/);
  } finally {
    await gw.close();
  }
});
