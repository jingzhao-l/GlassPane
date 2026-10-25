/**
 * 2026-10-24 unattended review — mcp-shell lane, transport half.
 *
 * Three findings, all in `engine-client.ts`:
 *
 * B2 — `verifyIdentity` returned on the protocol arms *before* storing `hello.stateRoot`,
 *        so a daemon whose protocol number disagrees (or who answers without one) left
 *        `reportedStateRoot` null. The project tools then wrote the home default and the
 *        reply claimed "this daemon's hello reported no stateRoot" — it did report one;
 *        this shell did not keep it.
 * B7 — `transportDeathRemedy` stated, for every outstanding request, that "this request
 *        had already left this shell when its transport died". On the lazy reconnecting
 *        transport the first write into a socket that never reached `connect` sits in
 *        this process's own write buffer: nothing left. The answer an agent then gets
 *        forbids the one move that is safe (a retry of a request the daemon never saw).
 * B8 — `Pending.params` was documented as "the only honest basis for 'narrow this'" while
 *        nothing in the repository reads it; the judgement moved to
 *        `tools.ts`'s `engineWithPayloadAdvice` (which is composed from the *tool's*
 *        advertised schema plus the caller's own arguments, not the frame's params).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CALLER_VISIBLE_CEILING_MS,
  ENGINE_PROTOCOL_VERSION,
  EngineJsonRpcClient,
  daemonUnreachableRemedy,
} from "../dist/engine-client.js";
import { TOOL_BY_NAME, executeTool } from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { PROJECTS_FILE_ENV } from "../dist/project-registry.js";
import { FakeLineIo } from "./helpers.mjs";
import { privateSandbox } from "./support/sandbox.mjs";
import { executableSource } from "./support/source.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * `FakeLineIo` plus the one hook the real adapter has: `onOpen`.
 *
 * `verifyIdentity` is reached from `handshake()`, and `handshake()` fires when the transport
 * says the connection opened (`engine-client.ts`'s `this.io.onOpen?.(() => …)`). A test that
 * instead sends its own `call("hello")` never runs the code under test — it answers a caller,
 * not the handshake, and would stay red for reasons that have nothing to do with the product.
 * The socket-backed suite (`engine-client.test.mjs`) drives this path through a fake `Duplex`;
 * this file drives it through the same fact one layer up, and names it.
 */
class OpenableLineIo extends FakeLineIo {
  #openHandler = null;
  /** The adapter's hook: the client asks for it once, at construction. */
  onOpen(handler) {
    this.#openHandler = handler;
  }
  /** Test-side "the socket came up". */
  fireOpen() {
    if (this.#openHandler === null) {
      throw new Error("the client never registered an onOpen handler — the handshake path is not wired");
    }
    this.#openHandler();
  }
}

function client(overrides = {}) {
  const io = new OpenableLineIo();
  const notes = [];
  const engine = new EngineJsonRpcClient(
    io,
    60_000,
    overrides.identity ?? null,
    CALLER_VISIBLE_CEILING_MS,
    overrides.surface ?? "mcp",
    overrides.expectedDaemonMethods ?? [],
  );
  engine.onEngineNote((note) => notes.push(note));
  return { io, engine, notes, open: () => io.fireOpen() };
}

/* ------------------------------------------------------------------ *
 * B2 — store what the daemon reported before deciding about it.
 * ------------------------------------------------------------------ */

test("a hello whose protocol disagrees still leaves the reported state root recorded", async () => {
  // MUTATION THIS PINS (red against the reviewed implementation): `verifyIdentity`
  // stored `helloVersion` first and put the `helloStateRoot` assignment *after* the two
  // protocol arms, both of which `return`. A daemon answering `protocolVersion: "9"` with
  // a `stateRoot` therefore left `reportedStateRoot` null.
  const { io, engine, notes, open } = client();
  open();
  io.respond({
    engine: "glasspaned",
    version: "1.19.0",
    protocolVersion: "9-never-this-shell",
    stateRoot: "/Volumes/Eng-Dev/daemon-reported-root",
    capabilities: ["observe"],
  });
  await tick();

  assert.equal(
    engine.reportedStateRoot,
    "/Volumes/Eng-Dev/daemon-reported-root",
    "daemon 报了根，壳没记下来就是壳的缺陷，不能说成它没报",
  );
  assert.equal(engine.reportedEngineVersion, "1.19.0", "version 一栏本来就是先存后判的规格");
  assert.match(notes.join("\n"), /protocol mismatch/, "先存不等于不判：协议不合仍然要说");
});

test("a hello with no protocolVersion at all still leaves the reported state root recorded", async () => {
  const { io, engine, notes, open } = client();
  open();
  io.respond({ engine: "glasspaned", version: "1.18.0", stateRoot: "/Volumes/Eng-Dev/second-root" });
  await tick();
  assert.equal(engine.reportedStateRoot, "/Volumes/Eng-Dev/second-root");
  assert.match(notes.join("\n"), /no protocolVersion/, "缺协议号这一支同样不许把已报的根丢掉");
});

test("a daemon that reports no state root is still answered with \"not reported\"", async () => {
  // The control: the fix must not turn an absent key into a guessed root.
  const { io, engine } = client();
  const hello = engine.call("hello");
  io.respond({ engine: "glasspaned", version: "1.20.1", protocolVersion: ENGINE_PROTOCOL_VERSION });
  await hello;
  await tick();
  assert.equal(engine.reportedStateRoot, null, "没报就是没报，不许拿 home 默认冒充");
});

test("the project notice stops claiming a root this daemon did report", async () => {
  // The downstream harm, driven through the real client: the tools read
  // `context.engine.reportedStateRoot`, and with the field dropped on the mismatch path a
  // registration went to the home default while the reply told the agent the handshake
  // had named nothing.
  const sandbox = privateSandbox("gp-shell-b2-root-");
  const previous = process.env[PROJECTS_FILE_ENV];
  delete process.env[PROJECTS_FILE_ENV];
  try {
    const { io, engine, open } = client();
    open();
    io.respond({
      engine: "glasspaned",
      version: "1.20.0",
      protocolVersion: "9-never-this-shell",
      stateRoot: sandbox.dir,
    });
    await tick();

    const outcome = await executeTool(
      TOOL_BY_NAME.get("gp_project_set"),
      { displayName: "B2", bundleId: "test.b2.app" },
      engine,
      new EvidenceAuditSession(),
    );
    assert.equal(outcome.isError, false, outcome.content[0]?.text ?? "");
    const notice = JSON.parse(outcome.content[0].text).project.daemonRestartNotice;
    assert.match(notice, /the state root the running daemon reported/, notice);
    assert.doesNotMatch(notice, /reported no stateRoot/, `它报了，是壳没记：${notice}`);
    assert.ok(fs.existsSync(path.join(sandbox.dir, "projects.json")), "注册要落在 daemon 报的那个根里");
  } finally {
    if (previous !== undefined) process.env[PROJECTS_FILE_ENV] = previous;
    sandbox.dispose();
  }
});

/* ------------------------------------------------------------------ *
 * B7 — "the transport died" is not evidence that the request left.
 * ------------------------------------------------------------------ */

/**
 * A transport that reports its own write buffer, the way a `net.Socket` does: a frame
 * written before `connect` stays in `writableLength` — this process's memory, not the
 * daemon's queue.
 */
class QueuingIo extends FakeLineIo {
  #queued = 0;

  writeLine(line) {
    // The socket is not established: the bytes are buffered here and nothing is read.
    this.#queued += line.length + 1;
    super.writeLine(line);
  }

  bufferedBytes() {
    return this.#queued;
  }
}

/** The same transport after the connection landed: writes go out and the queue is empty. */
class EstablishedIo extends FakeLineIo {
  /** Reports an empty write buffer: whatever was written left this process. */
  bufferedBytes() {
    return 0;
  }
}

async function deathOfOutstanding(io, method) {
  const notes = [];
  const engine = new EngineJsonRpcClient(io, 60_000, null, CALLER_VISIBLE_CEILING_MS, "mcp", []);
  engine.onEngineNote((note) => notes.push(note));
  const outstanding = engine.call(method, method === "act"
    ? { selector: { role: "AXButton" }, action: "press" }
    : {});
  io.emitError(new Error("connect ECONNREFUSED /var/run/glasspane/engine.sock"));
  const error = await outstanding.then(() => null, (caught) => caught);
  assert.ok(error, `'${method}' 没有被传输层的死亡结算`);
  return { error, engine, notes };
}

test("a request that never left this process is not answered as though the daemon saw it", async () => {
  // MUTATION THIS PINS (red against the reviewed implementation): `transportDeathRemedy`
  // asserted "this request had already left this shell when its transport died" for every
  // method, on every transport, including the lazy one whose first write was still sitting
  // in this process's own socket buffer when `connect` failed. The honest answer for that
  // request is the existing unreachable remedy — nothing reached the daemon, so a retry
  // performs nothing a second time.
  const io = new QueuingIo();
  const { error } = await deathOfOutstanding(io, "act");
  assert.equal(error.code, "GP_E_ENGINE_UNREACHABLE", error.message);
  assert.doesNotMatch(error.remedy, /had already left/, `这一条根本没出门：${error.remedy.slice(0, 240)}`);
  assert.doesNotMatch(error.remedy, /Do NOT re-issue 'act'/, `没出门的请求不存在"再按一次"：${error.remedy.slice(0, 240)}`);
  assert.equal(
    error.remedy,
    daemonUnreachableRemedy(),
    "这一支复用已有的 daemonUnreachable 措辞，一个字都不许多",
  );
});

test("a request that did go out on an established connection keeps the no-reissue answer", async () => {
  // The other face, and the control that keeps the fix from becoming a blanket "retry":
  // a transport that reports its write buffer drained says the same thing a connected
  // `net.Socket` does — the bytes left this process — and then the reviewed text is the
  // true one. `test/daily-20261022-shell-remedies.test.mjs` pins its per-method arms.
  const io = new EstablishedIo();
  const { error } = await deathOfOutstanding(io, "act");
  assert.match(error.remedy, /had already left this shell/, error.remedy.slice(0, 240));
  assert.match(error.remedy, /Do NOT re-issue 'act'/, error.remedy.slice(0, 240));
});

test("a snapshot whose transport never came up is not answered with the ring ban either", async () => {
  // The same fact for the ring-writing method: the daemon never saw the request, so the
  // "a second copy would evict your own baseline" clause has no first copy to protect.
  const io = new QueuingIo();
  const { error } = await deathOfOutstanding(io, "snapshot");
  assert.equal(error.code, "GP_E_ENGINE_UNREACHABLE", error.message);
  assert.doesNotMatch(error.remedy, /had already left/, error.remedy.slice(0, 240));
  assert.doesNotMatch(error.remedy, /Do NOT send a second 'snapshot'/, `没出门的请求没有第二条要禁：${error.remedy.slice(0, 240)}`);
  assert.equal(error.remedy, daemonUnreachableRemedy());
});

/* ------------------------------------------------------------------ *
 * B8 — a declared field nobody reads.
 * ------------------------------------------------------------------ */

test("the pending-request record declares no field the transport does not read", () => {
  // MUTATION THIS PINS (red against the reviewed implementation): `Pending.params` was
  // documented as "the only honest basis for 'narrow this'" while no reader of it exists —
  // the narrowing judgement is composed in `tools.ts`'s `engineWithPayloadAdvice` from the
  // tool's advertised schema and the caller's own arguments. A field that only the past
  // reads is how the next reader trusts a basis nothing uses.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = executableSource(fs.readFileSync(path.resolve(here, "..", "src/engine-client.ts"), "utf8"));
  const declaration = /type Pending = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(declaration, "Pending 的形状变了，这条闸要重新指认它");
  const body = declaration[1] ?? "";
  const declared = [...body.matchAll(/^\s{2}(\w+)[?]?\s*:/gm)].map((match) => match[1]);
  assert.ok(declared.includes("correlation"), "对照面：仍然被读的一栏必须还在，否则是抽取得不对");
  assert.ok(declared.includes("settled"), "对照面：同上");
  // A field is read when the transport names it off a pending entry (`entry.params` is the
  // reviewed shape's only declaration-without-reader). The two controls below keep an
  // over-eager extraction from turning this gate green by deleting the population.
  const unread = declared.filter((field) => !new RegExp(`\\bentry\\.${field}\\b`).test(source));
  assert.deepEqual(unread, [], `Pending 里没人读的栏位：${unread.join(", ")}`);
  assert.ok(/entry\.correlation\b/.test(source) && /entry\.settled\b/.test(source),
    "判据本身：被读的栏位确实以 entry.<field> 的形式出现在这份源码里");
});
