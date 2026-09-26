import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CALLER_VISIBLE_CEILING_MS,
  ENGINE_DEADLINES_MS,
  EngineJsonRpcClient,
  LIVENESS_PROBE_OUTCOMES,
  REPLAY_UNSAFE_METHOD_NAMES,
  callerDeadlineMs,
  engineDeadlineMs,
  isReplayUnsafeMethod,
  livenessProbeDecision,
  slowEngineRemedy,
} from "../dist/engine-client.js";
import { TOOL_SPECS } from "../dist/tools.js";
import { FakeLineIo } from "./helpers.mjs";

/**
 * R8-高1. The daemon answers one request at a time, so `gp_probe_status` is
 * queued behind the very request the agent is standing over — and
 * `slowEngineRemedy` tells the agent to send that probe *during* an outstanding
 * `act`. With a 15 s window it expired against a busy daemon, and the wording
 * then read "restart only if gp_probe_status times out too", i.e. an act longer
 * than 15 s was guaranteed to produce an instruction to `--restore-launchd` a
 * daemon that is mid-action on the user's screen (SIGTERM cancels and rolls that
 * act back). These three gates hold the two halves of the fix: the probe's
 * window, and the fact that an unanswered probe authorises nothing.
 */

const RESTORE_COMMAND = "--restore-launchd";

/** Was the promise settled? (mocked timers make the settle synchronous-ish) */
async function settledInFlight() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("a probe of a busy daemon is given the whole client-safe window, not 15 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io);

  let outcome = null;
  const probe = client.call("probe_status").then(
    () => { outcome = "answered"; },
    (error) => { outcome = error.code; },
  );

  // The scenario the old numbers got wrong: an `act` that legitimately takes
  // 30 s of daemon time. At 15 s+1 ms the probe must still be in flight.
  t.mock.timers.tick(15_001);
  await settledInFlight();
  assert.equal(outcome, null, "15 s 就判定探针失败 = 旧缺陷：把在干的活当成死");

  // The daemon frees up and answers the queued probe at 30 s.
  io.respond({ probes: [], attachedHasProbe: false });
  await probe;
  assert.equal(outcome, "answered");
});

test("an unanswered probe still settles at the ceiling rather than hanging", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io);

  let outcome = null;
  const probe = client.call("probe_status").then(
    () => { outcome = "answered"; },
    (error) => { outcome = error.code; },
  );
  t.mock.timers.tick(CALLER_VISIBLE_CEILING_MS - 1);
  await settledInFlight();
  assert.equal(outcome, null, "到点之前不得先结算");
  t.mock.timers.tick(1);
  await probe;
  assert.equal(outcome, "GP_E_ENGINE_TIMEOUT", "探针必须仍然会结算，否则它自己成了挂死");
});

/**
 * Every method whose *daemon-side* worst case outruns the probe's window. Each
 * one is survivable only because its caller is answered at the ceiling anyway,
 * which is the case `livenessProbeDecision("timed-out")` exists to disarm, and
 * because the deadline table says `act`'s 120 s is deliberate. The list is the
 * point: a method that joins it has to be added here on purpose, and a probe
 * window that shrinks puts every existing member in front of the same assertion.
 */
const DAEMON_SIDE_OUTLIVES_PROBE = ["act", "assert_element", "last_evidence", "snapshot"];

test("no engine method can outlive the probe meant to diagnose it", () => {
  const methods = [...new Set([
    ...Object.keys(ENGINE_DEADLINES_MS),
    ...TOOL_SPECS.map((spec) => spec.engineMethod),
  ])];
  // `callerDeadlineMs` cannot carry this gate, and the version of this test that
  // used it was decoration: both sides of that comparison pass through the same
  // ceiling, so `callerDeadlineMs(m) > callerDeadlineMs("probe_status")` is false
  // for every m whatever the table says. Compare the daemon-side numbers, where
  // the two quantities can really differ, and require the set to stay exactly the
  // one reasoned about above. Reverse mutations that this reddens on:
  // `probe_status` given a shorter window (the 15 s that made the probe a trap),
  // or any other method raised above it without being named in the list.
  const probeWindow = engineDeadlineMs("probe_status");
  const outrunning = methods.filter((method) => engineDeadlineMs(method) > probeWindow).sort();
  assert.deepEqual(outrunning, [...DAEMON_SIDE_OUTLIVES_PROBE].sort(),
    `这些方法在 daemon 侧比探针更久，而清单只列了 ${DAEMON_SIDE_OUTLIVES_PROBE.join(", ")}`);

  // The probe has to be given the whole client-safe window *on its own terms*,
  // not by being one of several numbers the ceiling happens to flatten: with the
  // ceiling removed from the arithmetic this is the shape the fix has.
  assert.equal(probeWindow, CALLER_VISIBLE_CEILING_MS,
    "探针自己的期限短于客户端耐性，就必然先于它在诊断的请求超时");
  assert.equal(callerDeadlineMs("probe_status"), CALLER_VISIBLE_CEILING_MS);

  // The comparison has to be load-bearing: `act` really does run past the probe's
  // old 15 s on the daemon side, which is what made the old window a trap.
  assert.ok(methods.length > 5, "方法清单空了，这条闸就只是装饰");
  assert.ok(engineDeadlineMs("act") > 15_000, "act 的 daemon 侧最坏值必须仍在 15 s 之上");
  assert.ok(DAEMON_SIDE_OUTLIVES_PROBE.includes("act"),
    "act 是这条闸存在的理由；它不在清单里说明清单是被改出来的，不是推出来的");
});

test("only an unreachable daemon authorises a restart, and the remedy ships that table", () => {
  const restarters = LIVENESS_PROBE_OUTCOMES.filter((outcome) =>
    livenessProbeDecision(outcome).includes(RESTORE_COMMAND));
  assert.deepEqual(restarters, ["unreachable"],
    "重启指令只能挂在 GP_E_ENGINE_UNREACHABLE 上；别处出现就等于把忙判定为死");

  const timedOut = livenessProbeDecision("timed-out");
  assert.match(timedOut, /NOT evidence that the daemon is down/);
  assert.match(timedOut, /do not run the restore command on this answer alone/);
  assert.match(timedOut, /GP_E_ENGINE_TIMEOUT/, "结局必须点回它对应的那个错误码");

  // The table is what the agent actually receives, not a parallel copy of it.
  for (const method of ["act", "restore", "observe", "snapshot", "assert_element"]) {
    const remedy = slowEngineRemedy(method);
    for (const outcome of LIVENESS_PROBE_OUTCOMES) {
      assert.ok(remedy.includes(livenessProbeDecision(outcome)),
        `${method} 的 remedy 没有渲染 ${outcome} 这条判据，表就成了没人读的文档`);
    }
  }
});

test("a probe that itself timed out is not told to send a probe", () => {
  const remedy = slowEngineRemedy("probe_status");
  assert.ok(!remedy.includes("gp_probe_status goes out immediately"),
    "探针超时的建议不得再让代理去探针（循环指引）");
  assert.ok(!remedy.includes(RESTORE_COMMAND),
    "探针自己没答上，不得在任何位置给出重启命令");
  assert.ok(remedy.includes("GP_E_ENGINE_UNREACHABLE"),
    "要给出路：真断了会由哪个错误码点名重启命令");
});

/**
 * R8b-高4's own gate. Mutation run 2026-09-26 caught that this fix had **no** red
 * behind it: the liveness table was pinned, `hello` was not. The handshake is the
 * one comparison that catches "an old daemon is under this shell" (R4-06), and
 * `ReconnectingSocketIo` writes the frame that *triggers* the connection before
 * the `connect` event fires `hello` — so on a session whose first request is an
 * `act`, `hello` is queued behind it and a 15 s handshake window expires against
 * a healthy daemon, silently dropping the version/protocol check.
 */

/** A fake transport that can report "connected", which `FakeLineIo` never does. */
class OpenableIo extends FakeLineIo {
  #openHandler = null;

  onOpen(handler) {
    this.#openHandler = handler;
  }

  fireOpen() {
    this.#openHandler?.();
  }
}

test("the hello handshake outlives the request that triggered the connection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const io = new OpenableIo();
  const client = new EngineJsonRpcClient(io);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));

  // The frame that opens the connection goes out first, then `connect` fires and
  // the handshake writes `hello` behind it — the real production order.
  const act = client.call("act", { selector: { role: "AXButton" }, action: "press" }).catch(() => "timed out");
  io.fireOpen();
  const helloFrame = io.lastFrame();
  assert.equal(helloFrame.method, "hello", "connect 之后必须立刻发起握手");

  // 15 s is the window this used to have; the comparison must not be over yet.
  t.mock.timers.tick(15_001);
  await settledInFlight();
  io.respond({ engine: "glasspaned", version: "1.2.0", protocolVersion: "9-not-this-shell" });
  await settledInFlight();

  assert.ok(
    notes.some((note) => note.includes("protocol mismatch")),
    `握手的版本比对没跑起来（多半是 hello 先超时了）：${JSON.stringify(notes)}`,
  );
  assert.ok(
    !notes.some((note) => note.includes("did not answer the hello handshake")),
    `hello 被自己的期限判死，R4-06 的比对就永久丢失：${JSON.stringify(notes)}`,
  );

  // The act in front of it still gets its own honest answer at the ceiling.
  t.mock.timers.tick(CALLER_VISIBLE_CEILING_MS);
  assert.equal(await act, "timed out");
});

test("hello is given the same wait as the probe, not a shorter one", () => {
  // The arithmetic form of the same rule: whichever request a connection starts
  // with, the handshake behind it must not be the first thing to expire.
  assert.equal(callerDeadlineMs("hello"), CALLER_VISIBLE_CEILING_MS,
    "hello 的期限短于客户端耐性 ⇒ 首请求较慢时版本比对必然丢失");
});

/* ------------------------------------------------------------------ *
 * R10-低 — `REPLAY_UNSAFE_METHOD_NAMES` was exported "for gates that must see
 * the set change on purpose", and no gate read it: a name claiming a reader that
 * does not exist is how a membership list drifts while its export looks lived-upto.
 * It gets one here, and the reader is behavioural — the set is compared against
 * the answer the transport actually hands a caller, in both directions, so the
 * export cannot be a copy of the table and the table cannot grow a silent member.
 * ------------------------------------------------------------------ */

/** The transport's own no-replay marker, as `tools.test.mjs` reads it too. */
const NO_REPLAY_MARKER = /do NOT re-issue/;

/** Every engine method a timeout can be reported for, from the tables themselves. */
const ALL_ENGINE_METHODS = [...new Set([
  ...Object.keys(ENGINE_DEADLINES_MS),
  ...TOOL_SPECS.map((spec) => spec.engineMethod),
  ...REPLAY_UNSAFE_METHOD_NAMES,
  // A method with no deadline entry and no tool: the fallback branch has to be in
  // the comparison too, or the set could be "complete" only over the listed ones.
  "recent_reports",
  "a_method_this_shell_has_never_seen",
])];

test("the exported replay-unsafe set is exactly the set whose answer forbids re-issue", () => {
  const marked = ALL_ENGINE_METHODS.filter((method) => ["mcp", "http"].every(
    (surface) => NO_REPLAY_MARKER.test(slowEngineRemedy(method, surface)),
  ));
  assert.ok(marked.length >= 3,
    `只有 ${marked.length} 个方法的答复禁止重发，这套对照已经没有对象了`);
  // Direction 1: nothing the transport forbids is missing from the export.
  // Direction 2: nothing the export names is unforbidden — an extra member would be
  // a read told never to re-issue, which is its own unusable instruction.
  assert.deepEqual([...REPLAY_UNSAFE_METHOD_NAMES].sort(), marked.sort(),
    `导出清单与 remedy 文本里的 no-replay 判据不再同一：清单 ${REPLAY_UNSAFE_METHOD_NAMES.join(",")} / 文本 ${marked.join(",")}`);
  // The predicate the other layers branch on has to agree with the exported names:
  // `Object.keys` versus a hand-written array is exactly the drift this export
  // exists to make visible.
  assert.deepEqual(
    ALL_ENGINE_METHODS.filter((method) => isReplayUnsafeMethod(method)).sort(),
    [...REPLAY_UNSAFE_METHOD_NAMES].sort(),
    "isReplayUnsafeMethod 与 REPLAY_UNSAFE_METHOD_NAMES 给出两份成员表，消费方就会各信一边",
  );
  // `hasOwnProperty`-backed membership, so an inherited name cannot join the set.
  assert.equal(isReplayUnsafeMethod("constructor"), false,
    "原型链上的名字不得被当成不可重放的方法");

  // And the set itself, written out. The export's stated purpose is that a gate sees
  // a membership change *on purpose*, so a change is only allowed to go through by
  // editing this line too — which is where the reasoning for the new member has to be
  // written down (each reason's source is `REPLAY_UNSAFE_REASONS`' own comment).
  // Reverse mutation this pins: `act: … restore: … attach: …` gaining `observe`, or
  // losing `attach`; both leave the two equality checks above green because both
  // sides move together.
  assert.deepEqual([...REPLAY_UNSAFE_METHOD_NAMES].sort(), ["act", "attach", "restore"],
    `不可重放的方法集变了：现在是 ${REPLAY_UNSAFE_METHOD_NAMES.join(", ")}`);

  // The real control for R10-高1's rewrite: inside the set the answer carries the
  // explicit ban and the method's own reason; outside it, the answer defers to the
  // tool layer and must not borrow the ban's marker (which is what makes the marker
  // a discriminator rather than a slogan).
  for (const method of marked) {
    assert.match(slowEngineRemedy(method), new RegExp(`do NOT re-issue ${method}, because`),
      `${method} 的禁令没有配上它自己的理由，成了一句话纪律`);
  }
  for (const method of ALL_ENGINE_METHODS.filter((m) => !marked.includes(m) && m !== "probe_status")) {
    const remedy = slowEngineRemedy(method, "mcp");
    assert.ok(!NO_REPLAY_MARKER.test(remedy), `${method} 不是不可重放的方法，却领到了 no-replay 禁令`);
    assert.match(remedy, /is a fact about a schema/,
      `${method} 的出路不再把窄化问题交给持有 schema 的一层：${remedy.slice(0, 200)}`);
  }
});
