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
  callerDeadlineMs,
  defaultSocketPath,
  engineClientOver,
  engineDeadlineMs,
  RESTORE_BASE_DEADLINE_MS,
  slowEngineRemedy,
  unixSocketEngineClient,
} from "../dist/engine-client.js";
import { TOOL_SPECS } from "../dist/tools.js";
import { MAX_FRAME_BYTES, OversizeFrameError } from "../dist/io.js";
import { FakeLineIo } from "./helpers.mjs";
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
  // R9-中3: the narrowing advice is per method family, so `observe` keeps it and
  // names the parameter it really has. The mutation this pins is the single
  // generic tail coming back — then this line passes and the family assertions
  // below ("attach", "diagnose", "capture_view", the schema cross-check) go red.
  const other = new EngineJsonRpcClient(new FakeLineIo(), 30);
  await assert.rejects(other.call("observe"), (err) => {
    assert.match(err.remedy, /re-send the same request with a smaller maxDepth/);
    return true;
  });
});

/* ------------------------------------------------------------------ *
 * R9-中3: `slowEngineRemedy`'s tail used to be one sentence for every
 * method that is not `act`/`restore`/`probe_status` — "retry this read
 * narrower (smaller maxDepth / a tighter selector) — that is safe for a
 * read". It was sent to `attach` (a daemon-state change that can discard
 * the trail), to the operation reads (which have no knob to turn), and to
 * `capture_view` (whose knob is `scale`). Both halves are pinned: the
 * family wording, and — against `TOOL_SPECS` — that no remedy names a
 * parameter the method's own schema does not have.
 * ------------------------------------------------------------------ */

/** Which parameter names each method's timeout remedy is allowed to name. */
const NARROWING_KNOBS = {
  observe: ["maxDepth"],
  snapshot: ["maxDepth"],
  audit_ui: ["maxDepth"],
  assert_element: ["selector"],
  capture_view: ["scale"],
  diagnose: [],
  last_evidence: [],
  attach: [],
  act: [],
  restore: [],
};

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

test("no timeout remedy names a parameter the method's schema does not have", () => {
  const named = ["maxDepth", "selector", "scale"];
  for (const [method, allowed] of Object.entries(NARROWING_KNOBS)) {
    const tail = tailOf(slowEngineRemedy(method));
    for (const knob of named) {
      if (allowed.includes(knob)) {
        assert.ok(tail.includes(knob), `${method} should be pointed at its own ${knob}`);
        // …and the schema has to still carry it, or the advice is stale.
        assert.ok(schemaProperties(method).includes(knob),
          `${method}'s remedy names ${knob}, which its tool schema does not advertise`);
      } else {
        assert.ok(!tail.includes(knob),
          `${method}'s remedy names ${knob}, which its schema does not have: ${tail.slice(0, 200)}`);
      }
    }
  }
});

test("a read with nothing to narrow says so instead of implying a safe retry", () => {
  for (const method of ["diagnose", "last_evidence"]) {
    const tail = tailOf(slowEngineRemedy(method));
    assert.match(tail, /re-send it unchanged/, `${method}: no parameter controls the work`);
    assert.match(tail, /nothing to narrow/, `${method}: the honest sentence is "there is nothing to narrow"`);
  }
  // A method this shell has no family for gets no invented knob, and no
  // blanket promise that re-sending is safe: whether a call changes anything is
  // stated by its own tool description, not by this file.
  const unknown = tailOf(slowEngineRemedy("recent_reports"));
  assert.ok(!/maxDepth|tighter selector/.test(unknown), unknown.slice(0, 200));
  assert.match(unknown, /only if it changes or records nothing/);
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
  assert.equal(probeState.value, "pending");
  assert.match(notes.find((note) => /late engine reply for 'act'/.test(note)) ?? "", /attributed by arrival order/);
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
