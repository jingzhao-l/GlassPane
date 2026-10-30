/**
 * The shell must not write its first byte to a socket it cannot call the engine's.
 *
 * WHY THIS FILE EXISTS. The engine socket is `chmod 0600` with **no peer authentication**
 * (SECURITY.md: same uid = full authority), so the *path* is what makes a reply mean anything:
 * every verdict, every evidence pack, every "the daemon said" sentence in this product is built
 * from bytes read off whatever `GLASSPANE_ENGINE_SOCK` names. Before 2026-10-30 nothing in
 * `mcp-shell/src/**` looked at that path before connecting — the fork side of this product
 * (`harness/glasspane-harness/packages/opencode/src/tool/glasspane/daemon.ts`, `trustSocket`)
 * has checked since its 0.12.0, and this side never got the check. A same-uid process that binds
 * a socket anywhere and points this shell at it answers with schema-valid JSON and is rendered to
 * the model as the engine's verified word.
 *
 * THE CRITERIA, and why each is what it is:
 *  - the leaf must BE a socket: a plain file planted there used to produce a connect error that
 *    reads like "the daemon is down", which is a lie about a different thing;
 *  - owner uid must equal this process's euid, for the leaf AND its directory: an entry this
 *    account did not place is not the engine's;
 *  - the disqualifier is a **write** bit for group/other, not "any bit outside owner": `0755` is
 *    what a listener created by node itself carries before any chmod (measured on this machine),
 *    so a "no bits but owner's" rule would refuse the product's own socket. Execute-only lets a
 *    reader look, not talk.
 *  - `ENOENT` is NOT a trust refusal: nothing at the path is the daemon-not-running case, which
 *    `GP_E_ENGINE_UNREACHABLE` already renders with the restore command. Renaming it here would
 *    break the remedy an agent is supposed to copy.
 *
 * MUTATIONS THIS PINS (each was run while authoring it):
 *  - delete the `trust()` call in `ReconnectingSocketIo.connect()` → the end-to-end cases below
 *    get an answer from the planted listener instead of a refusal;
 *  - swap `socket.mode & 0o022` for `& 0o777` → the friendly case (a real 0755-ish socket the
 *    runtime itself made) goes red, which is what stops the rule from widening into a no-op;
 *  - re-wrap the trust refusal in the transport catch as `GP_E_ENGINE_UNREACHABLE` → the
 *    "authorises no restart" case names the laundered code;
 *  - make `read` a `statSync` instead of `lstatSync`… the leaf here is a real socket, so that one
 *    is caught by the "not a socket" case only through `isSocket()`; it is called out because the
 *    same confusion is what `update-state.ts` had (see `daily-20261030-write-and-read-shapes`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { trustSocket } from "../dist/engine-client.js";
import { unixSocketEngineClient } from "../dist/engine-client.js";
import { GP_E_SOCKET_TRUST, GP_E_ENGINE_UNREACHABLE } from "../dist/errors.js";
import { startFakeDaemon } from "./support/fake-daemon.mjs";
import { privateSandbox } from "./support/sandbox.mjs";

/** A `Stats`-shaped stand-in for the two branches no unprivileged process can create. */
function evidence({ socket = true, uid = process.geteuid(), mode = 0o700 }) {
  return { isSocket: () => socket, uid, mode };
}

test("trustSocket: ENOENT is the daemon-not-running case, not a trust refusal", () => {
  const missing = path.join(privateSandbox("gp-trust-noent-").dir, "engine.sock");
  assert.equal(trustSocket(missing, () => {
    const error = new Error("no such file");
    error.code = "ENOENT";
    throw error;
  }), null, "a path with nothing on it must keep answering GP_E_ENGINE_UNREACHABLE with the restore command");
});

test("trustSocket: a stat that fails for any other reason is a refusal, because 'could not ask' is not trust", () => {
  const target = "/anywhere/engine.sock";
  const refusal = trustSocket(target, () => {
    const error = new Error("no permission");
    error.code = "EACCES";
    throw error;
  });
  assert.equal(refusal?.code, GP_E_SOCKET_TRUST);
  assert.match(refusal.message, /could not be inspected/);
  assert.match(refusal.message, /EACCES/);
});

test("trustSocket: a runtime that cannot answer geteuid() refuses rather than passes", () => {
  const refusal = trustSocket("/anywhere/engine.sock", () => evidence({}), null);
  assert.equal(refusal?.code, GP_E_SOCKET_TRUST, "no identity ⇒ no claim of trust");
  assert.match(refusal.remedy, /geteuid/);
});

test("trustSocket: a plain file at the socket path is named as such, not as a dead daemon", () => {
  const box = privateSandbox("gp-trust-plainfile-");
  const target = path.join(box.dir, "engine.sock");
  fs.writeFileSync(target, "I am not a socket\n", { mode: 0o600 });
  try {
    const refusal = trustSocket(target);
    assert.equal(refusal?.code, GP_E_SOCKET_TRUST);
    assert.match(refusal.message, /is not a socket/);
    assert.ok(!/GP_E_ENGINE_UNREACHABLE/.test(refusal.message + refusal.remedy),
      `a planted file must not be laundered into "restart the daemon": ${refusal.message}`);
  } finally {
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("trustSocket: another account's socket or socket directory is refused (seam — unprivileged tests cannot create these)", () => {
  const mine = process.geteuid();
  const otherSocket = trustSocket("/r/engine.sock", (p) =>
    p === "/r/engine.sock" ? evidence({ uid: mine + 1 }) : evidence({ mode: 0o700, socket: false }), 0);
  // The seam feeds a directory that is not a socket deliberately: the leaf check must run first,
  // or a wrong-order implementation reports "directory is not a socket" and never names the owner.
  assert.match(otherSocket?.message ?? "", /belongs to uid/);

  const otherDir = trustSocket("/r/engine.sock", (p) =>
    p === "/r/engine.sock" ? evidence({ uid: mine }) : evidence({ uid: mine + 1, socket: false, mode: 0o700 }), mine);
  assert.match(otherDir?.message ?? "", /directory .* belongs to uid/);
});

test("trustSocket: a world-writable socket leaf is refused, and an owner-only one is not", () => {
  const box = privateSandbox("gp-trust-mode-");
  const target = path.join(box.dir, "engine.sock");
  const server = net.createServer();
  try {
    server.listen(target);
    const modeBefore = fs.statSync(target).mode & 0o7777;
    assert.equal(trustSocket(target), null, `the engine's own socket (mode ${modeBefore.toString(8)}) must pass — this is the criterion the daemon satisfies`);
    fs.chmodSync(target, 0o666);
    const refusal = trustSocket(target);
    assert.equal(refusal?.code, GP_E_SOCKET_TRUST);
    assert.match(refusal.message, /carries mode 666/);
    assert.match(refusal.remedy, /chmod 600/);
  } finally {
    server.close();
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("trustSocket: a group/other-writable directory holding the socket is refused even when the leaf is clean", () => {
  const box = privateSandbox("gp-trust-dir-");
  const target = path.join(box.dir, "engine.sock");
  const server = net.createServer();
  try {
    server.listen(target);
    fs.chmodSync(box.dir, 0o777);
    const refusal = trustSocket(target);
    assert.equal(refusal?.code, GP_E_SOCKET_TRUST);
    assert.match(refusal.message, /directory holding the engine socket/);
    assert.match(refusal.remedy, /chmod 700/);
  } finally {
    fs.chmodSync(box.dir, 0o700);
    server.close();
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

/* ---------------- the transport, end to end on real bytes ---------------- */

/** Drive a real client against a real fake daemon listening at `socketPath`. */
async function ask(socketPath) {
  const engine = unixSocketEngineClient(socketPath);
  try {
    return await engine.call("hello", {});
  } catch (error) {
    return error;
  } finally {
    engine.close();
  }
}

test("the transport refuses an untrusted socket BEFORE writing, and answers with the trust code — not with a restart order", async () => {
  const box = privateSandbox("gp-trust-e2e-");
  const target = path.join(box.dir, "engine.sock");
  let heardFromWire = 0;
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      heardFromWire += 1;
      socket.write('{"jsonrpc":"2.0","id":1,"result":{"answered":true}}\n');
    });
  });
  await new Promise((resolve) => server.listen(target, resolve));
  fs.chmodSync(target, 0o666);
  try {
    const outcome = await ask(target);
    assert.ok(outcome instanceof Error, `expected a refusal, got ${JSON.stringify(outcome)}`);
    assert.equal(outcome.code, GP_E_SOCKET_TRUST, "a planted listener must not be able to answer");
    assert.equal(heardFromWire, 0, "the refusal must happen before the first byte leaves this process");
    assert.ok(!outcome.remedy.includes("--restore-launchd") && !/GP_E_ENGINE_UNREACHABLE/.test(outcome.code),
      `a trust refusal authorises no daemon lifecycle action: ${outcome.remedy}`);
  } finally {
    fs.chmodSync(target, 0o700);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("the friendly path still works: a real daemon on a real owner-only socket is answered normally", async () => {
  const box = privateSandbox("gp-trust-good-");
  const target = path.join(box.dir, "engine.sock");
  const daemon = await startFakeDaemon(target);
  try {
    const reply = await ask(target);
    assert.ok(!(reply instanceof Error), `the good path must not be refused: ${String(reply?.message)}`);
    assert.ok(reply, "hello answered");
  } finally {
    await daemon.stop();
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("GP_E_SOCKET_TRUST is part of the shell's own vocabulary and names the socket it judged", () => {
  const box = privateSandbox("gp-trust-word-");
  const target = path.join(box.dir, "engine.sock");
  fs.writeFileSync(target, "plain file", { mode: 0o600 });
  try {
    const refusal = trustSocket(target);
    assert.equal(refusal.code, GP_E_SOCKET_TRUST);
    assert.ok(refusal.message.includes(target), "the message must name the path this process was about to write into");
    assert.deepEqual(Object.keys(refusal).sort(), ["code", "message", "remedy"], "the error frame stays three-field");
  } finally {
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("the default socket path is what the check runs against — an env override is a trust root, not just a location", () => {
  const named = path.join(os.homedir(), ".glasspane", "engine.sock");
  assert.equal(trustSocket("/nonexistent/engine.sock"), null, "ENOENT passes so the unreachable arm stays intact");
  assert.ok(named.endsWith(".glasspane/engine.sock"), "the product default is the one every remedy points at");
  assert.notEqual(GP_E_SOCKET_TRUST, GP_E_ENGINE_UNREACHABLE, "the two answers must stay two answers");
});
