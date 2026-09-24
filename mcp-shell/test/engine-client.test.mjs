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
  unixSocketEngineClient,
} from "../dist/engine-client.js";
import { MAX_FRAME_BYTES, OversizeFrameError } from "../dist/io.js";
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
  const other = new EngineJsonRpcClient(new FakeLineIo(), 30);
  await assert.rejects(other.call("observe"), (err) => {
    assert.match(err.remedy, /retry this read narrower/);
    return true;
  });
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
    assert.match(err.remedy, /smaller maxDepth/);
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
