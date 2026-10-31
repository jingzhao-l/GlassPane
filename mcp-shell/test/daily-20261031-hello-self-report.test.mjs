/**
 * 2026-10-31 · lane E, item 1 — 重连之后不许继续报上一个 daemon 的自报值。
 *
 * `EngineJsonRpcClient` 把 `hello` 里的 `stateRoot` 与 `version` 存成两份缓存，读出来是
 * `reportedStateRoot` / `reportedEngineVersion`。这两个键在真 daemon 那一侧是**条件键**
 * （`EngineCore.hello()` 用 `if let stateRootPath` 写，1.15.0 之前的二进制根本没有这一行），
 * 而 `verifyIdentity()` 的规矩是"缺席就保持缺席"。两条规矩叠在一起的结果是：daemon 重启或
 * 换成另一个 build 之后，如果新连接的 `hello` 不带 `stateRoot`，那份缓存**永远不清零**——
 * 于是壳拿着一个已经不存在的进程自报的根去决定 `projects.json` 往哪儿写，provider 归属行
 * 报出一个本进程从没听过的版本号。这是"把没测的说成测过的"。
 *
 * 修法：连接的 `onOpen` 里把两份缓存复位为 null。null 在这些 getter 的文档里就是"这一条连接
 * 上没测到"，既不抛也不猜。
 *
 * 夹具形状一律来自真 `hello` 帧：`fakeHelloResult()` 的键集由 `test/fixture-daemon-shape.test.mjs`
 * 从 `EngineCore.hello()` 派生并把关，带不带 `stateRoot` 走的都是 daemon 自己的那一句
 * `if let`。本文件不自己编帧。
 *
 * REVERSE MUTATION（本机验证，跑完 `cp` 备份还原并核对 sha256）：
 *  · 删掉 `src/engine-client.ts` `onOpen` 里的 `this.helloStateRoot = null;` /
 *    `this.helloVersion = null;` 两行 ⇒ 用例「重连后的 hello 不带 stateRoot…」报出上一个
 *    daemon 的根、用例「重连打开的那一刻…」在 open 那一刻就读到非空，两条当场变红；
 *  · 把两个 getter 写死成 `return null`（把修复做成残废的另一种写法）⇒ 对照用例
 *    「复位之后新 daemon 报了根，读侧照样把根读回来」变红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Duplex } from "node:stream";

import { EngineCallError, unixSocketEngineClient } from "../dist/engine-client.js";
import { GP_E_ENGINE_UNREACHABLE } from "../dist/errors.js";
import { fakeHelloResult, startFakeDaemon } from "./support/fake-daemon.mjs";
import { privateSandbox } from "./support/sandbox.mjs";

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ *
 * 一、真 socket：daemon 换了人，第二个 hello 没报根
 * ------------------------------------------------------------------ */

const FIRST_VERSION = "1.30.0-reported-by-first-daemon";
const SECOND_VERSION = "1.31.0-reported-by-second-daemon";

/** The `hello` result of a daemon that measured a root: the fixture's builder, plus its key. */
function helloResultWithRoot(root) {
  // The frame a 1.15.0-and-later daemon actually sends: the fixture's own builder plus the
  // conditional `stateRoot` key it writes when it has a root to name.
  return fakeHelloResult({ stateRoot: root, version: FIRST_VERSION });
}

/**
 * Wait until this client has processed the `hello` its own connection wrote.
 *
 * The caller's reply lands **before** the handshake's: the transport is opened by the first
 * `call()`, the `connect` event fires after that write is queued, and `hello` is therefore
 * the second frame on the wire. So `await client.call(...)` returning does not yet mean the
 * self-report has been read, and an assertion written there would be measuring the scheduler
 * rather than the reset. The predicate is the *version*, because `version` is an
 * unconditional key of `EngineCore.hello()` — every daemon that answers at all answers it.
 */
async function helloProcessed(client, version) {
  for (let guard = 0; guard < 400; guard += 1) {
    if (client.reportedEngineVersion === version) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("这条连接的 hello 始终没被处理："
    + `等的是 '${version}'，读到的是 '${String(client.reportedEngineVersion)}'`
    + " — 夹具没走通，后面的断言无从谈起");
}

/**
 * Get one answer out of the daemon that is listening *now*.
 *
 * `stop()` destroys the fixture's live peer, and the client notices that on its own clock: a
 * call issued in the same tick can still be handed the socket that is already being torn
 * down, which fails with `GP_E_ENGINE_UNREACHABLE` — a true statement about the transport
 * that just died, and not the thing under test. The retry is bounded, and any rejection that
 * is *not* the transport-death one is rethrown, so a real defect cannot be swallowed here.
 */
async function callThroughFreshTransport(client, method) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await client.call(method);
    } catch (error) {
      if (!(error instanceof EngineCallError) || error.code !== GP_E_ENGINE_UNREACHABLE) {
        throw error;
      }
      await nextTick();
    }
  }
  throw new Error("换了 daemon 之后这条壳始终连不上新的进程：夹具没走通，断言无从谈起");
}

test("重连后的 hello 不带 stateRoot ⇒ reportedStateRoot 答'不知道'，不沿用上一个 daemon 的根", async () => {
  const box = privateSandbox("gp-hello-root-swap-");
  const socketPath = path.join(box.dir, "engine.sock");
  const firstRoot = path.join(box.dir, "root-of-first-daemon");
  const client = unixSocketEngineClient(socketPath);
  let daemon = null;
  try {
    daemon = await startFakeDaemon(socketPath, { stateRoot: firstRoot, version: FIRST_VERSION });
    await client.call("probe_status");
    await helloProcessed(client, FIRST_VERSION);
    assert.equal(client.reportedStateRoot, firstRoot, "第一个 daemon 自报了根，这条要读得到");
    assert.equal(client.reportedEngineVersion, FIRST_VERSION);

    // Replace the producer: the same socket path, a daemon that does not answer `stateRoot`
    // (a binary predating 1.15.0 — the exact shape `EngineCore.hello()`'s `if let` omits).
    await daemon.stop();
    daemon = await startFakeDaemon(socketPath, { version: SECOND_VERSION });
    assert.equal("stateRoot" in daemon.hello, false,
      "对照必须成立：第二个夹具的 hello 确实没有报根，否则这条用例没在称重连");

    await callThroughFreshTransport(client, "probe_status");
    await helloProcessed(client, SECOND_VERSION);
    assert.equal(client.reportedStateRoot, null,
      "新 daemon 没报根，壳就得答'不知道'——替它沿用上一个进程的根，等于替一个不存在的进程写盘");
    // 归属行报的是**现在**这个 producer 的数，不是上一个的。
    assert.equal(client.reportedEngineVersion, SECOND_VERSION);
    // 读到不到是一句"不知道"，不是一次抛错：调用方拿到的还是同一个形状。
    assert.doesNotThrow(() => client.reportedStateRoot);
    assert.doesNotThrow(() => client.reportedEngineVersion);
  } finally {
    client.close();
    if (daemon !== null) await daemon.stop();
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("对照：复位之后新 daemon 报了根，读侧照样把根读回来", async () => {
  // 复位不是把功能关掉：新 daemon 报了根，读侧就得再拿到它。这条同时挡住"把 getter 写死成
  // null"这种把修复做成残废的写法。
  const box = privateSandbox("gp-hello-root-again-");
  const socketPath = path.join(box.dir, "engine.sock");
  const root = path.join(box.dir, "root-reported-both-times");
  const client = unixSocketEngineClient(socketPath);
  let daemon = null;
  try {
    daemon = await startFakeDaemon(socketPath, { stateRoot: root, version: FIRST_VERSION });
    await client.call("probe_status");
    await helloProcessed(client, FIRST_VERSION);
    assert.equal(client.reportedStateRoot, root);
    await daemon.stop();
    daemon = await startFakeDaemon(socketPath, { stateRoot: root, version: SECOND_VERSION });
    await callThroughFreshTransport(client, "probe_status");
    await helloProcessed(client, SECOND_VERSION);
    assert.equal(client.reportedStateRoot, root, "复位之后 hello 又报了根，这条要重新读得到");
  } finally {
    client.close();
    if (daemon !== null) await daemon.stop();
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 二、可注入 transport：打开的那一刻，缓存就已经是空的
 * ------------------------------------------------------------------ */

/** A peer whose read side never loops back: the test delivers every reply itself. */
class SeamSocket extends Duplex {
  chunks = [];

  _write(chunk, _encoding, callback) {
    this.chunks.push(chunk.toString());
    callback();
  }

  _read() {}

  frames() {
    return this.chunks.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  /** Reply to the newest written frame for `method`, whatever its id turned out to be. */
  answer(method, result) {
    const frame = [...this.frames()].reverse().find((f) => f.method === method);
    if (frame === undefined) {
      throw new Error(`this peer never wrote a '${method}' frame: ${JSON.stringify(this.frames())}`);
    }
    this.push(`${JSON.stringify({ id: frame.id, result })}\n`);
  }
}

test("重连打开的那一刻，两份自报缓存就是空的——新 daemon 还没答过任何一句话", async () => {
  // The transport here is a seam, so nothing is ever opened at this path and the trust gate
  // is handed nothing to stat; the box exists so the name lives on a private tree rather
  // than in a shared scratch directory.
  const box = privateSandbox("gp-hello-open-seam-");
  const sockets = [];
  const client = unixSocketEngineClient(path.join(box.dir, "engine.sock"), {
    open: () => {
      const socket = new SeamSocket();
      sockets.push(socket);
      return socket;
    },
    // The seam socket is not a filesystem object, so the trust gate has nothing to stat; it
    // is refused nothing and answers "trusted" exactly as the seam is documented to.
    trust: () => null,
  });
  try {
    const first = client.call("probe_status");
    sockets[0].emit("connect");
    sockets[0].answer("hello", helloResultWithRoot("/var/root/first-daemon-said-so"));
    sockets[0].answer("probe_status", { connected: true });
    await first;
    await helloProcessed(client, FIRST_VERSION);
    assert.equal(client.reportedStateRoot, "/var/root/first-daemon-said-so");
    assert.equal(client.reportedEngineVersion, FIRST_VERSION);

    // The producer goes away; the next call opens a fresh transport.
    sockets[0].destroy();
    await nextTick();
    const second = client.call("probe_status");
    assert.equal(sockets.length, 2, "对照：这一条确实在开第二条连接");
    sockets[1].emit("connect");
    // `onOpen` resets before it handshakes, so the gap between "connected" and "the new
    // daemon has answered" reports nothing about the daemon that is no longer there.
    assert.equal(client.reportedStateRoot, null,
      "新连接还没听到任何 hello，壳却还在报上一个 daemon 的根——这条就是在抓这一刻");
    assert.equal(client.reportedEngineVersion, null,
      "同上：版本是 producer 自报的测量，本连接没测到就得答不知道");

    sockets[1].answer("hello", fakeHelloResult({ stateRoot: "/var/root/second-daemon-said-so", version: SECOND_VERSION }));
    sockets[1].answer("probe_status", { connected: true });
    await second;
    await helloProcessed(client, SECOND_VERSION);
    assert.equal(client.reportedStateRoot, "/var/root/second-daemon-said-so", "新 daemon 报了根，读侧要拿到新根");
    assert.equal(client.reportedEngineVersion, SECOND_VERSION);
  } finally {
    client.close();
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});
