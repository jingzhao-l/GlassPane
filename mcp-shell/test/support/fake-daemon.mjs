/**
 * A daemon stand-in on a real Unix socket, speaking the framed newline protocol the
 * engine daemon actually uses (`io.ts` §3.1: one JSON object per line).
 *
 * It exists so a test can drive a *process* — the published bundle, the stdio shell —
 * against bytes on a socket instead of against an in-memory transport, which is the
 * only way to exercise a socket path a defect like an empty `--socket-path` lives on.
 * It answers `hello` (the handshake every connection gets) and `probe_status` (the read
 * a session can make without attaching), and refuses anything else instead of replying
 * `{}` to it: a fixture that answered every method would endorse a capability the
 * daemon in the test does not have.
 *
 * **The two replies are the real responder's key set, not a convenience shape.** This
 * file is imported by every test that runs a session end to end, so an invented key
 * here is a key the shell was then measured "accepting" while no daemon has ever sent
 * it — which is exactly how `daemonMarker` survived: `tools.ts` answers `gp_probe_status`
 * with `canonicalJson(raw)`, an echo, so *any* object passed for the shell and the tests
 * that asserted on it proved only that the echo works. `test/fixture-daemon-shape.test.mjs`
 * reads the allowed keys out of `EngineCore.hello()` / `EngineCore.probeStatus()` and
 * reddens this file the moment a reply grows or loses one, and the row shapes are the ones
 * `ProbeInbox.statusJSON()` / `recentDisconnectionsJSON()` write (`connected: true` on a
 * live registration only, drop history under its own key, ISO-8601 timestamps in the
 * daemon's own format).
 */
import net from "node:net";
import fs from "node:fs";

import { SERVER_INFO } from "../../dist/dispatch.js";
import { ENGINE_PROTOCOL_VERSION } from "../../dist/engine-client.js";

/**
 * The fixture's probe registration: a `com.example.*` bundle id is what a daemon row
 * carries, and this one is unique enough that a test can prove the bytes it asserted
 * came off *this* socket rather than from an echo of something else.
 */
export const FAKE_PROBE_BUNDLE_ID = "com.example.gp-fake-daemon";
export const FAKE_PROBE_PID = 4242;

/** `ProbeInbox.iso8601` format: `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`, UTC. */
const DAEMON_TIMESTAMP = "2026-10-15T07:33:12.480Z";
const DAEMON_DROP_TIMESTAMP = "2026-10-15T07:33:44.020Z";

/**
 * The capability names this fixture advertises: a **literal**, on purpose.
 *
 * It used to be `[...DAEMON_FORWARDED_METHODS]` — the very set this fixture exists to
 * reconcile against — so an end-to-end test could never observe the two drifting: the
 * stand-in advertised exactly what the shell forwarded, by construction, and
 * `describeCapabilityDrift`'s reconciliation had nothing to disagree with. The same
 * failure the `hello` key set above was locked against, in a different file.
 *
 * `test/fixture-daemon-shape.test.mjs` now reddens this list whenever it stops matching
 * either the daemon's own table (read out of `engine/Sources/GlassPaneEngine/FrameCodec.swift`
 * — `EngineMethod`'s cases minus its `transportMethods`) or the shell's forwarded set, so a
 * divergence between the two products is a failing test rather than a fixture that follows
 * whichever side moved.
 */
export const FAKE_DAEMON_CAPABILITIES = Object.freeze([
  "attach",
  "act",
  "observe",
  "assert_element",
  "diagnose",
  "last_evidence",
  "snapshot",
  "restore",
  "audit_ui",
  "capture_view",
  "probe_status",
]);

/**
 * The `hello` result, in the key set `EngineCore.hello()` publishes
 * (`engine`, `version`, `protocolVersion`, `pid`, `capabilities`; `stateRoot`,
 * `approvalPersistFailed`, `identity` and `permissions` are conditional and are
 * *absent* here, which is the daemon's own way of saying it did not measure them).
 *
 * `capabilities` defaults to {@link FAKE_DAEMON_CAPABILITIES}, the pinned literal; a test
 * that wants capability drift passes its own list.
 *
 * `stateRoot` is written the way the daemon writes it — `if let stateRootPath` — so it is
 * present exactly when the caller names one and absent otherwise. That conditional is the
 * whole shape a reconnecting transport has to get right: a daemon predating 1.15.0 (and
 * `glasspaned --approval-verify`, which has no root to name) omits the key, so a shell that
 * keeps the *previous* connection's value would be reporting a root this process never
 * heard. Omitting the option is how a test asks for that frame; passing it is how a test
 * asks for the 1.15.0-and-later frame.
 */
export function fakeHelloResult({
  version = SERVER_INFO.version,
  protocolVersion = ENGINE_PROTOCOL_VERSION,
  capabilities = [...FAKE_DAEMON_CAPABILITIES],
  pid = process.pid,
  stateRoot,
} = {}) {
  return {
    engine: "glasspaned",
    version,
    protocolVersion,
    pid,
    capabilities,
    // Absent, not `undefined`: the daemon's own reply frame omits the key, and a test that
    // reads this object back has to see the same difference between "not reported" and
    // "reported blank" that `EngineCore.hello()` writes on the wire.
    ...(typeof stateRoot === "string" && stateRoot.trim() !== "" ? { stateRoot } : {}),
  };
}

/**
 * The `probe_status` result, in the key set `EngineCore.probeStatus()` publishes.
 *
 * One live registration (every `probes` row is `connected: true` — a dropped probe is
 * *absent* from this list, not flagged inside it), one row in the drop history that
 * carries `disconnectedAt`/`disconnectReason`/`drops`, the since-start `disconnections`
 * count, and `unmapableStateFrames`: the last three exist only when an inbox is wired,
 * and this fixture runs with one. `degradation` is deliberately absent — it is absent
 * exactly when the daemon runs without the T9 tracker wired, which is the honest reading
 * for a stand-in that measures nothing.
 *
 * What is *not* here is the point as much as what is: no `attachedApp` (the daemon
 * answers `attach` for that) and no `uptimeSeconds`, neither of which `probe_status`
 * has ever published.
 */
export function fakeProbeStatusResult() {
  return {
    probes: [{
      pid: FAKE_PROBE_PID,
      appName: "GPFakeDaemonApp",
      probeVersion: "gp-probe/0.1.0",
      capabilities: ["z1"],
      connectedAt: DAEMON_TIMESTAMP,
      eventsSeen: 3,
      connected: true,
      bundleId: FAKE_PROBE_BUNDLE_ID,
    }],
    // 与 `EngineCore.probeStatus()` 同键集（`fixture-daemon-shape` 从 Swift 里派生那份表）：
    // "没有监听者"与"有监听者、这个 app 没接探针"必须是两种回话，夹具不能只回其中一半。
    probeListener: "live",
    attachedHasProbe: true,
    disconnections: 1,
    recentDisconnections: [{
      pid: 4101,
      appName: "GPFakeDaemonApp",
      probeVersion: "gp-probe/0.1.0",
      capabilities: ["z1"],
      connectedAt: DAEMON_TIMESTAMP,
      eventsSeen: 0,
      connected: false,
      disconnectedAt: DAEMON_DROP_TIMESTAMP,
      disconnectReason: "connection closed",
      drops: 1,
    }],
    unmapableStateFrames: 0,
    // 同一个 `if let inbox` 块里的另两把总数（`EngineCore.probeStatus()` 2026-10-22 加的
    // defect3 读数）。这份夹具是**接了 inbox** 的那一档（上面三把键都在），所以这两把也必须在：
    // 少发一键，e2e 就永远测不到 daemon 会发它，而读侧的缺省分支会替它编一个 0。
    ringEvictedEventsTotal: 0,
    durationOverflowFramesTotal: 0,
  };
}

/**
 * @param socketPath      where to listen; removed first, created by `listen`
 * @param options.version  the daemon's self-report (defaults to the shell's own, so
 *                         the handshake's version comparison passes and the test is
 *                         not reading a mismatch note it did not ask for)
 * @param options.protocolVersion / options.capabilities  same idea: what the fixture
 *                         claims, with sane defaults
 * @param options.splitFrames  write every reply in two socket chunks, so the reader
 *                         under test has to reassemble a frame across a boundary
 * @param options.stateRoot  the `hello.stateRoot` this stand-in reports; left unset it
 *                         omits the key exactly as a daemon that did not measure a root
 *                         does (`EngineCore.hello()` writes it under `if let stateRootPath`)
 */
export async function startFakeDaemon(socketPath, {
  version,
  protocolVersion,
  capabilities,
  splitFrames = false,
  stateRoot,
} = {}) {
  const hello = fakeHelloResult({ version, protocolVersion, capabilities, stateRoot });
  // Live peer connections, so `stop()` can end them the way a daemon process exiting does.
  // `server.close()` alone keeps established connections open and only stops accepting new
  // ones, so a test that "restarts the daemon" by stopping this fixture and listening again
  // at the same path would leave its client attached to the *first* daemon's socket — the
  // reconnect path the test is written to exercise would never run.
  const peers = new Set();
  const server = net.createServer((conn) => {
    peers.add(conn);
    conn.on("close", () => peers.delete(conn));
    conn.setEncoding("utf8");
    // The shell hangs up as soon as its stdin ends, which can land between a request
    // and the reply being written. A dead peer is not a defect in the answer.
    conn.on("error", () => undefined);
    const send = (body) => {
      if (!conn.writable) {
        return;
      }
      const text = `${JSON.stringify(body)}\n`;
      if (!splitFrames) {
        conn.write(text);
        return;
      }
      const cut = Math.max(1, Math.floor(text.length / 2));
      conn.write(text.slice(0, cut));
      conn.write(text.slice(cut));
    };

    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") {
          continue;
        }
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          send({
            id: null,
            error: { code: "GP_E_BAD_PARAMS", message: "the daemon received a frame that is not JSON", remedy: "send one JSON object per line" },
          });
          continue;
        }
        if (frame.method === "hello") {
          send({ id: frame.id, result: hello });
        } else if (frame.method === "probe_status") {
          send({ id: frame.id, result: fakeProbeStatusResult() });
        } else {
          send({
            id: frame.id,
            error: {
              code: "GP_E_BAD_PARAMS",
              message: `this daemon stand-in answers hello and probe_status only, not '${frame.method}'`,
              remedy: "send one of the two methods this fixture exists to serve",
            },
          });
        }
      }
    });
  });
  server.on("error", (error) => {
    throw error;
  });
  fs.rmSync(socketPath, { force: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    hello,
    stop: () => new Promise((resolve) => {
      server.close(() => {
        fs.rmSync(socketPath, { force: true });
        resolve(undefined);
      });
      // End every live peer first, or `close`'s callback waits for a connection that
      // only the client decides to drop — and a client that never learns the daemon is
      // gone cannot be used to test what happens when it is.
      for (const peer of peers) {
        peer.destroy();
      }
    }),
  };
}
