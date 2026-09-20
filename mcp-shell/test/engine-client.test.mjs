import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EngineJsonRpcClient, engineClientOver } from "../dist/engine-client.js";
import { FakeLineIo } from "./helpers.mjs";

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

test("call rejects on timeout with a diagnosis remedy", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 30); // short timeout
  await assert.rejects(client.call("diagnose"), (err) => {
    assert.equal(err.code, "GP_E_ENGINE_UNREACHABLE");
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
 * an unsettled promise, and the caller never gets a GP_E_ENGINE_UNREACHABLE.
 * CI's first real run (Node 20) cancelled exactly these tests; this proves
 * the settle guarantee in the only environment where it can be observed.
 */
test("a pending call's timeout is delivered even when nothing else keeps the event loop alive", () => {
  const probe = fileURLToPath(new URL("./fixtures/timeout-loop.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 15_000 });
  const stdout = (result.stdout ?? "").trim();
  assert.equal(
    stdout,
    "REJECTED GP_E_ENGINE_UNREACHABLE",
    `timeout must settle the call in its own process (exit=${result.status} stderr=${(result.stderr ?? "").trim()})`,
  );
  assert.equal(result.status, 0);
});
