/**
 * Lane 1 fixes for the 2026-10-29 ledger (S1-1 … S1-4), mcp-shell TypeScript.
 *
 * Each test names the mutation it reddens before the fix:
 *  - S1-1: `entry.handedOff` was decided once, at write time, from the
 *    `bufferedBytes()` diff; a frame that sat in the local send queue *then*
 *    drained *then* saw its transport die was still answered with
 *    NEVER_LEFT_TRANSPORT and a "then retry" — the same button pressed twice.
 *  - S1-2: an oversized reply attributed by arrival order deleted its entry,
 *    so the daemon's real echo-id reply read as "a frame this client never
 *    issued" — while the settled side of the same guess already kept the entry
 *    (finding 中-4's rule).
 *  - S1-3: the timeout frame's `capped` clause told a `curl` caller of the HTTP
 *    gateway that this shell stopped waiting for *an MCP client's* sake.
 *  - S1-4: `this.pending.delete(id)` ran before `this.pending.set(id, entry)` —
 *    on a `nextId++` id, a no-op shaped like a guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import {
  CALLER_VISIBLE_CEILING_MS,
  EngineJsonRpcClient,
  daemonUnreachableRemedy,
} from "../dist/engine-client.js";
import { MAX_FRAME_BYTES, OversizeFrameError, StreamLineIo } from "../dist/io.js";
import { createHttpGateway } from "../dist/http-gateway.js";
import { FakeLineIo } from "./helpers.mjs";
import { executableSource } from "./support/source.mjs";

const TEST_TOKEN = "test-bearer-token-0123456789abcdef";

/* ------------------------------------------------------------------ *
 * S1-1 — the write callback is the temporal half of the hand-off verdict.
 * ------------------------------------------------------------------ */

/**
 * A transport shaped like a `net.Socket` before connect: at `writeLine` time it
 * reports the frame's bytes in its own queue (the static criterion says
 * "still here"), and it stores the hand-off callback the client passes. The
 * bytes only leave when `drain()` runs — which fires every stored callback,
 * the way the stream's write callback fires on flush.
 */
class DrainingHandoffIo extends FakeLineIo {
  #queued = 0;
  #callbacks = [];

  writeLine(line, onHandedOff) {
    this.#queued += Buffer.byteLength(line, "utf8") + 1;
    super.writeLine(line);
    this.#callbacks.push(onHandedOff ?? null);
  }

  bufferedBytes() {
    return this.#queued;
  }

  /** The queue flushes: the bytes leave this process and the callbacks fire. */
  drain() {
    this.#queued = 0;
    const callbacks = this.#callbacks;
    this.#callbacks = [];
    for (const callback of callbacks) {
      callback?.();
    }
  }
}

/** B7's silent queue-reporter: bytes counted, a flush never confirmed. */
class SilentQueueIo extends FakeLineIo {
  #queued = 0;

  writeLine(line) {
    this.#queued += Buffer.byteLength(line, "utf8") + 1;
    super.writeLine(line);
  }

  bufferedBytes() {
    return this.#queued;
  }
}

async function deathAfter(io, method, params) {
  const engine = new EngineJsonRpcClient(io, 60_000, null, CALLER_VISIBLE_CEILING_MS, "mcp", []);
  const outstanding = engine.call(method, params);
  io.emitError(new Error("socket hang up"));
  const error = await outstanding.then(() => null, (caught) => caught);
  assert.ok(error, `'${method}' was not settled by the transport's death`);
  return error;
}

test("a frame that drained out of the local queue before its transport died is not answered as one that never left", async () => {
  const io = new DrainingHandoffIo();
  const engine = new EngineJsonRpcClient(io, 60_000, null, CALLER_VISIBLE_CEILING_MS, "mcp", []);
  const outstanding = engine.call("act", { selector: { role: "AXButton" }, action: "press" });
  // The write happened while the bytes were queued (static criterion ⇒ false),
  // then they flushed out (the hand-off callback ⇒ true), *then* the transport died.
  io.drain();
  io.emitError(new Error("socket hang up"));
  const real = await outstanding.then(() => null, (caught) => caught);
  assert.ok(real, "the outstanding act was not settled by the transport's death");
  assert.equal(real.code, "GP_E_ENGINE_UNREACHABLE", real.message);
  assert.doesNotMatch(real.message, /never left this process/,
    `字节已经排空出门，这一句在替 daemon 开脱：${real.message.slice(0, 240)}`);
  assert.doesNotMatch(real.message, /nothing was performed/, real.message);
  assert.match(real.remedy, /had already left this shell/, real.remedy.slice(0, 240));
  assert.match(real.remedy, /Do NOT re-issue 'act'/,
    `已经出门的 act 死在途上，答复禁的是重发，不是 "then retry"：${real.remedy.slice(0, 240)}`);
  assert.doesNotMatch(real.remedy, /then retry/, real.remedy.slice(0, 240));
});

test("a transport that never confirms the flush keeps the buffered-bytes verdict (B7 static criterion intact)", async () => {
  // The control S1-1 must not silently become "always handed off": a transport
  // that reports its queue and never calls the callback still gets the honest
  // "nothing left this process" answer and the plain "then retry" remedy.
  const error = await deathAfter(new SilentQueueIo(), "act", { selector: { role: "AXButton" }, action: "press" });
  assert.equal(error.code, "GP_E_ENGINE_UNREACHABLE", error.message);
  assert.match(error.message, /never left this process/, error.message.slice(0, 240));
  assert.match(error.message, /nothing was performed/, error.message.slice(0, 240));
  assert.equal(error.remedy, daemonUnreachableRemedy(),
    "没出门的 act 复用 daemonUnreachable 那一条，一个字都不许多");
});

test("StreamLineIo calls the hand-off callback only when the stream's write flushes without error", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const sink = new PassThrough();
  output.pipe(sink);
  sink.resume();
  const io = new StreamLineIo(input, output);
  let handedOffCalls = 0;
  io.writeLine('{"n":1}', () => {
    handedOffCalls += 1;
  });
  assert.equal(handedOffCalls, 0, "the callback is a flush fact, not a synchronous promise");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(handedOffCalls, 1, "bytes flushed to the destination must confirm the hand-off");

  const dead = new PassThrough();
  dead.on("error", () => {});
  dead.destroy(new Error("write target gone"));
  const io2 = new StreamLineIo(new PassThrough(), dead);
  let confirmedAfterError = 0;
  io2.writeLine('{"n":2}', () => {
    confirmedAfterError += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(confirmedAfterError, 0, "an errored write has handed nothing off");

  input.destroy();
  output.destroy();
  sink.destroy();
  dead.destroy();
});

/* ------------------------------------------------------------------ *
 * S1-2 — the inferred oversize verdict keeps its entry.
 * ------------------------------------------------------------------ */

test("an oversized reply guessed onto a request by arrival order keeps that entry for the daemon's echoed reply", async () => {
  const io = new FakeLineIo();
  const engine = new EngineJsonRpcClient(io, 60_000, null, CALLER_VISIBLE_CEILING_MS, "mcp", []);
  const notes = [];
  const late = [];
  engine.onEngineNote((note) => notes.push(note));
  engine.onLateReply((reply) => late.push(reply));

  const first = engine.call("observe", { maxDepth: 2 });
  const firstId = io.lastFrame().id;
  const second = engine.call("snapshot");

  // A frame whose 512-byte head carries no readable id: attribution is a guess.
  io.emitError(new OversizeFrameError(MAX_FRAME_BYTES + 9, "x".repeat(512)));
  const error = await first.then(() => null, (caught) => caught);
  assert.equal(error.code, "GP_E_PAYLOAD_TOO_LARGE", error?.message ?? "first call must fail oversized");
  assert.match(error.message, /carried no request id/, "the inference says so to the caller");

  // The daemon then answers for real, echoing this request's id. It must find
  // the entry it belongs to and take the late-reply path — not "never issued".
  io.send(JSON.stringify({ id: firstId, result: { tree: [], operationId: "op_ran_after_all" } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.length, 1, notes.join(" | "));
  assert.equal(late[0].method, "observe");
  assert.equal(late[0].attribution, "echoed-id", notes.join(" | "));
  assert.ok(notes.some((note) => /late engine reply for 'observe'/.test(note)), notes.join(" | "));
  assert.doesNotMatch(notes.join(" || "), /never issued/,
    "猜出去的结算不许把真回复读成没发过的请求");

  // The untouched second request still gets its own answer.
  io.respond({ snapshotId: "snap_OK" });
  assert.deepEqual(await second, { snapshotId: "snap_OK" });
  engine.close();
});

/* ------------------------------------------------------------------ *
 * S1-3 — the timeout frame speaks to the surface it is answering.
 * ------------------------------------------------------------------ */

test("the HTTP gateway does not tell a curl caller the shell stopped waiting for an MCP client", async () => {
  const io = new FakeLineIo();
  // A real engine client with a 40 ms caller ceiling and the http surface; the
  // fake daemon never answers, so the deadline's `capped` clause is what fires.
  const engine = new EngineJsonRpcClient(io, undefined, null, 40, "http", []);
  const gw = createHttpGateway({
    socketPath: "/tmp/lane1-never-opens.sock",
    token: TEST_TOKEN,
    port: 0,
    connectController: () => engine,
    report: () => {},
  });
  await new Promise((resolve) => gw.server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${gw.server.address().port}/v1/tools/act`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ selector: { role: "button", title: "OK" }, action: "press" }),
    });
    assert.equal(res.status, 504, "an un-answered act is the caller's wait spent, not a gateway fault");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "GP_E_ENGINE_TIMEOUT");
    assert.doesNotMatch(body.error.message, /MCP/i,
      `对 curl 说"替 MCP 客户端停止等待"不是它那面的事实：${body.error.message}`);
    assert.match(body.error.message, /stops waiting for an HTTP caller's sake/,
      `子句要按表面重写，而不是被整句删掉：${body.error.message}`);
  } finally {
    await gw.close();
  }
});

test("the MCP surface still says it stops waiting for an MCP client's sake", async () => {
  // The control: S1-3 is a per-surface rewrite, not a blanket removal.
  const io = new FakeLineIo();
  const engine = new EngineJsonRpcClient(io, undefined, null, 40, "mcp", []);
  const error = await engine.call("act", { selector: { role: "button" }, action: "press" })
    .then(() => null, (caught) => caught);
  assert.ok(error, "the call was settled by its deadline");
  assert.equal(error.code, "GP_E_ENGINE_TIMEOUT");
  assert.match(error.message, /stops waiting for an MCP client's sake/, error.message);
  engine.close();
});

/* ------------------------------------------------------------------ *
 * S1-4 — the backlog refusal deletes nothing it has not registered yet.
 * ------------------------------------------------------------------ */

test("the backlog refusal runs before the pending registration, so it keeps no delete, and the write-failure catch keeps its real one", () => {
  // Shape pin (the behaviour is identical either way — that is what "dead"
  // means), same style as the B8 "declares no field the transport does not
  // read" gate: the mutation this reddens is re-adding
  // `this.pending.delete(id)` to the backlog branch, on the strength of
  // `state.nextId++` alone.
  const source = executableSource(
    readFileSync(new URL("../dist/engine-client.js", import.meta.url), "utf8"),
  );
  const gate = source.indexOf("if (backlog > ENGINE_WRITE_BACKLOG_BYTES)");
  const set = source.indexOf("this.pending.set(id, entry)");
  assert.notEqual(gate, -1, "the backlog gate must exist to be inspected");
  assert.notEqual(set, -1, "the pending registration must exist to be inspected");
  assert.ok(gate < set, "the refusal still runs before the registration");
  assert.doesNotMatch(source.slice(gate, set), /this\.pending\.delete/,
    "S1-4: deleting an id that has not been set (and never will be, nextId++ is monotonic) is a no-op shaped like a guard");
  // The positive half: the catch arm sits *after* the set, and its delete is
  // the real thing — a fix that deleted both is red here.
  const unreachable = source.indexOf("daemonUnreachableRemedy()", set);
  assert.notEqual(unreachable, -1, "the write-failure catch must exist to be inspected");
  assert.match(source.slice(set, unreachable), /this\.pending\.delete\(id\)/,
    "catch 里那一句删的是已经 set 过的真条目，它不许跟着 S1-4 一起消失");
});
