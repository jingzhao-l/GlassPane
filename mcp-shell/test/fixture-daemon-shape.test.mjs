/**
 * A test fixture may not invent a daemon frame.
 *
 * `test/support/fake-daemon.mjs` is the daemon that process-level tests run against —
 * the published bundle, the stdio CLI — and `gp_probe_status` answers with
 * `canonicalJson(raw)`: an *echo*. An echo accepts anything, so for as long as the
 * fixture answered `{attachedApp, uptimeSeconds, daemonMarker}` every "the bytes came
 * from the daemon on this socket" assertion in the suite proved only that the shell
 * forwards JSON, and a second copy in `test/socket-override-blank.test.mjs` had drifted
 * to a third marker of its own. `EngineCore.probeStatus()` publishes
 * `probes` / `attachedHasProbe` / `disconnections` / `recentDisconnections` /
 * `unmapableStateFrames` (plus a conditional `degradation`) and has never published a
 * marker of any kind.
 *
 * So the allowed key sets are **derived from the Swift that publishes them** here, the
 * same way `probe-status-surface.test.mjs` derives the documented key list: the fixture
 * replies' keys must be a subset of what the responder writes, and must cover the keys
 * the responder writes unconditionally. Row shapes are checked the same way against
 * `ProbeInbox.statusJSON()` / `recentDisconnectionsJSON()`. Adding a key the daemon does
 * not publish — or deleting one it does — reddens this file, and the vacuity controls at
 * the bottom prove the checker reports rather than merely passing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FAKE_PROBE_BUNDLE_ID,
  FAKE_PROBE_PID,
  fakeHelloResult,
  fakeProbeStatusResult,
  startFakeDaemon,
} from "./support/fake-daemon.mjs";
import { SERVER_INFO } from "../dist/dispatch.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, "..", "..", "engine", "Sources", "GlassPaneEngine");
const ENGINE_CORE = path.join(ENGINE, "EngineCore.swift");
const PROBE_INBOX = path.join(ENGINE, "ProbeInbox.swift");

/** One Swift function's body: from its signature to the next member at the same indent. */
function swiftBody(source, signature, where) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} is gone from ${where}: this gate read the daemon's key set out of it`);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n {4}(?:public |private |fileprivate |internal )?(?:static )?(?:func|var) /);
  const body = next === -1 ? rest : rest.slice(0, next);
  assert.ok(body.length > 80, `${signature} in ${where} extracted an implausibly short body (${body.length} chars)`);
  return body;
}

/**
 * The keys a Swift responder publishes: those in its `var payload: [String: Any] = [...]`
 * literal (unconditional) plus those assigned as `payload["x"] = …` afterwards
 * (conditional, an absence that means "not wired" rather than "measured zero").
 */
function publishedKeys(body, where) {
  const literal = /var \w+: \[String: Any\] = \[([\s\S]*?)\n {8}\]/.exec(body);
  assert.ok(literal !== null, `${where}: no ` + "`var payload: [String: Any] = [...]`" + ` literal was found — re-read how it builds its reply`);
  const unconditional = [...literal[1].matchAll(/^\s+"([A-Za-z][A-Za-z0-9]*)":\s/gm)].map((m) => m[1]);
  const conditional = [...body.matchAll(/\bpayload\["([A-Za-z][A-Za-z0-9]*)"\]\s*=/g)].map((m) => m[1]);
  const optional = conditional.filter((k) => !unconditional.includes(k));
  // A plausibility bound on the extraction, not on the product: a responder that
  // publishes two keys and a regex that found neither look the same otherwise, and the
  // subset check below would then pass against nothing.
  assert.ok(
    unconditional.length >= 2 && unconditional.length + optional.length >= 5,
    `${where}: extracted ${unconditional.length} unconditional + ${optional.length} conditional keys (${JSON.stringify([...unconditional, ...optional])}) — that is not this responder's surface, re-read it`,
  );
  return { unconditional, optional };
}

const engineCoreSource = fs.readFileSync(ENGINE_CORE, "utf8");
const inboxSource = fs.readFileSync(PROBE_INBOX, "utf8");

const HELLO_KEYS = publishedKeys(swiftBody(engineCoreSource, "public func hello() -> [String: Any] {", "EngineCore.swift"), "EngineCore.hello()");
const PROBE_STATUS_KEYS = publishedKeys(
  swiftBody(engineCoreSource, "public func probeStatus() -> [String: Any] {", "EngineCore.swift"),
  "EngineCore.probeStatus()",
);

/** The row keys `ProbeInbox` builds, literal-only: its two producers have one dict each. */
function inboxRowKeys(signature, where) {
  const body = swiftBody(inboxSource, signature, where);
  const literal = /var entry: \[String: Any\] = \[([\s\S]*?)\n {12}\]/.exec(body);
  const keys = literal
    ? [...literal[1].matchAll(/^\s+"([A-Za-z][A-Za-z0-9]*)":\s/gm)].map((m) => m[1])
    : [...body.matchAll(/^\s+"([A-Za-z][A-Za-z0-9]*)":\s/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 5, `${where}: only ${keys.length} row keys extracted: ${JSON.stringify(keys)}`);
  const optional = [...body.matchAll(/\bentry\["([A-Za-z][A-Za-z0-9]*)"\]\s*=/g)].map((m) => m[1]);
  return { keys, optional };
}

const LIVE_ROW = inboxRowKeys("public func statusJSON() -> [[String: Any]] {", "ProbeInbox.swift");
const DROPPED_ROW = inboxRowKeys("public func recentDisconnectionsJSON() -> [[String: Any]] {", "ProbeInbox.swift");

/** Every key of `reply` outside `allowed`, named rather than tolerated. */
function inventedKeys(reply, allowed, label) {
  const extra = Object.keys(reply).filter((key) => !allowed.includes(key));
  assert.deepEqual(extra, [], `${label} answers ${JSON.stringify(extra)}, which the daemon's own responder never publishes`);
  return extra;
}

/** Keys the responder publishes that the reply drops — reported, never assumed away. */
function missingKeys(reply, required) {
  return required.filter((key) => !Object.prototype.hasOwnProperty.call(reply, key));
}

test("the fixture's hello reply is the daemon's hello key set, and covers what is unconditional", () => {
  const hello = fakeHelloResult();
  inventedKeys(hello, [...HELLO_KEYS.unconditional, ...HELLO_KEYS.optional], "hello");
  assert.deepEqual(
    missingKeys(hello, HELLO_KEYS.unconditional),
    [],
    `hello must answer every unconditional key (EngineCore.hello() writes them before any conditional): ${JSON.stringify(HELLO_KEYS.unconditional)}`,
  );
});

test("the fixture's probe_status reply is the daemon's probe_status key set", () => {
  const status = fakeProbeStatusResult();
  inventedKeys(status, [...PROBE_STATUS_KEYS.unconditional, ...PROBE_STATUS_KEYS.optional], "probe_status");
  assert.deepEqual(
    missingKeys(status, PROBE_STATUS_KEYS.unconditional),
    [],
    `probe_status must answer the unconditional keys, not only the interesting one: ${JSON.stringify(PROBE_STATUS_KEYS.unconditional)}`,
  );
  // The three that exist only when a probe inbox is wired: this fixture runs with one,
  // so answering `probes` alone would let a session "pass" against a daemon shape that
  // cannot tell a live registration from a dropped one (A-10).
  for (const key of ["disconnections", "recentDisconnections", "unmapableStateFrames"]) {
    assert.ok(
      PROBE_STATUS_KEYS.optional.includes(key) || PROBE_STATUS_KEYS.unconditional.includes(key),
      `the daemon no longer publishes ${key} from probeStatus() — re-read this fixture against the new responder`,
    );
    assert.ok(Object.prototype.hasOwnProperty.call(status, key), `the fixture drops the inbox-conditional key ${key}`);
  }
});

test("the fixture's probe rows are ProbeInbox's rows", () => {
  const status = fakeProbeStatusResult();
  assert.equal(status.probes.length, 1, "this fixture is written to answer exactly one live registration");
  for (const [row, shape, label] of [
    [status.probes[0], LIVE_ROW, "probes[]"],
    [status.recentDisconnections[0], DROPPED_ROW, "recentDisconnections[]"],
  ]) {
    const extra = Object.keys(row).filter((key) => !shape.keys.includes(key) && !shape.optional.includes(key));
    assert.deepEqual(extra, [], `${label} carries ${JSON.stringify(extra)}, which ProbeInbox never writes on a row`);
    const missing = shape.keys.filter((key) => !(key in row));
    assert.deepEqual(missing, [], `${label} must carry every mandatory row key ProbeInbox builds (${JSON.stringify(missing)} missing)`);
  }
  // A-10's frozen meaning: `probes` is live registrations only. A row here that could be
  // read as "this pid has a probe" while the history says it dropped is the exact
  // confusion that made an act's `hitCount: 0` read as a measurement.
  assert.equal(status.probes[0].connected, true, "a live registration row is connected: true");
  assert.equal(status.recentDisconnections[0].connected, false, "a drop-history row says it is not connected");
  assert.equal(status.recentDisconnections[0].pid !== status.probes[0].pid, true,
    "a pid that re-registered is a live row and is not repeated in the drop history");
  assert.match(status.probes[0].connectedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "timestamps are ProbeInbox.iso8601's own format, not a local ISO string");
});

test("the answer on the socket is the fixture's documented reply, through the daemon's framing", async () => {
  // The fixture refuses what it was not written to answer instead of replying `{}` — a
  // stand-in that answered every method would endorse a capability no daemon in the test
  // has, and a caller would read the empty object as a successful reply.
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gp-fixture-shape-")), "engine.sock");
  const daemon = await startFakeDaemon(socketPath);
  try {
    const reply = await ask(socketPath, { id: 1, method: "attach", params: {} });
    assert.ok(reply.error, `an unserved method must be refused, not answered: ${JSON.stringify(reply)}`);
    assert.equal(typeof reply.error.code, "string", "the daemon's error frame carries its own code names");
    assert.ok(reply.error.message.includes("'attach'"), JSON.stringify(reply.error));
    assert.ok(typeof reply.error.remedy === "string" && reply.error.remedy.length > 0, JSON.stringify(reply.error));

    const hello = await ask(socketPath, { id: 2, method: "hello" });
    assert.deepEqual(hello.result, fakeHelloResult(), "the wire reply is the documented one, keys and all");

    const status = await ask(socketPath, { id: 3, method: "probe_status" });
    assert.deepEqual(status.result, fakeProbeStatusResult());
  } finally {
    await daemon.stop();
  }
});

test("hello's version really defaults to the shell's own, as this file documents", async () => {
  // The doc promised this default and `startFakeDaemon` did not have it: `version` was
  // `undefined`, `JSON.stringify` dropped the key, and the shell's
  // `verifyIdentity` silently skipped the comparison it was supposed to make.
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gp-fixture-version-")), "engine.sock");
  const daemon = await startFakeDaemon(socketPath);
  try {
    const hello = await ask(socketPath, { id: 1, method: "hello" });
    assert.equal("version" in hello.result, true, "the default dropped the key off the wire entirely");
    assert.equal(hello.result.version, SERVER_INFO.version, JSON.stringify(hello.result));
    assert.equal(hello.result.protocolVersion, fakeHelloResult().protocolVersion);
  } finally {
    await daemon.stop();
  }
});

/* ------------------------------------------------------------------ *
 * Vacuity controls: a checker that cannot report is not a checker.
 * ------------------------------------------------------------------ */

test("the key-set check does report an invented frame, a dropped key, and a broken extraction", () => {
  const allowed = [...PROBE_STATUS_KEYS.unconditional, ...PROBE_STATUS_KEYS.optional];
  // The exact shape this file exists to refuse: the marker the fixture used to answer.
  assert.throws(
    () => inventedKeys({ probes: [], attachedHasProbe: false, daemonMarker: "FAKE-DAEMON-ON-A-REAL-SOCKET" }, allowed, "probe_status"),
    /daemonMarker/,
    "an invented key must be named, not tolerated",
  );
  // A real reply dropping a key the responder writes is the other half: the coverage
  // check names the absence instead of letting a thinner fixture pass the subset check.
  assert.deepEqual(missingKeys({ probes: [], attachedHasProbe: true }, ["probes", "attachedHasProbe"]), []);
  assert.deepEqual(missingKeys({ probes: [] }, ["probes", "attachedHasProbe"]), ["attachedHasProbe"]);

  // And the extraction itself is checked: it found the keys the daemon is known to
  // publish, so a regex that quietly matched nothing cannot pass these gates.
  for (const key of ["engine", "version", "protocolVersion", "capabilities"]) {
    assert.ok(HELLO_KEYS.unconditional.includes(key), `hello extraction lost ${key}: ${JSON.stringify(HELLO_KEYS)}`);
  }
  for (const key of ["probes", "attachedHasProbe"]) {
    assert.ok(PROBE_STATUS_KEYS.unconditional.includes(key), `probe_status extraction lost ${key}: ${JSON.stringify(PROBE_STATUS_KEYS)}`);
  }
  assert.ok(PROBE_STATUS_KEYS.optional.includes("degradation"),
    `probe_status extraction lost the conditional degradation block: ${JSON.stringify(PROBE_STATUS_KEYS.optional)}`);
  assert.ok(LIVE_ROW.optional.includes("bundleId"), `statusJSON extraction lost its conditional bundleId: ${JSON.stringify(LIVE_ROW)}`);
  assert.ok(DROPPED_ROW.keys.includes("disconnectReason"), `recentDisconnectionsJSON extraction lost disconnectReason: ${JSON.stringify(DROPPED_ROW)}`);

  // The fixture's own discriminator: a unique `com.example.*` bundle id on a real key,
  // so "these bytes came from this socket" needs no invented key to be provable.
  assert.equal(fakeProbeStatusResult().probes[0].bundleId, FAKE_PROBE_BUNDLE_ID);
  assert.equal(fakeProbeStatusResult().probes[0].pid, FAKE_PROBE_PID);
});

/** One framed request to the fixture, one framed reply back: the daemon's own protocol. */
function ask(socketPath, frame) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("error", reject);
    conn.on("data", (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl === -1) {
        return;
      }
      const line = buffer.slice(0, nl);
      conn.end();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`the fixture answered a non-JSON line (${JSON.stringify(line)}): ${error}`));
      }
    });
    conn.write(`${JSON.stringify(frame)}\n`);
  });
}
