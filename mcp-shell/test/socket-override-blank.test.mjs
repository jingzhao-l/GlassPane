/**
 * D3 — an empty socket override is not a socket.
 *
 * `defaultSocketPath()` read the env override with `??`, and `""` is not nullish, so
 * `GLASSPANE_ENGINE_SOCK=""` (what `export GLASSPANE_ENGINE_SOCK=` actually produces,
 * and what a launcher that means "unset" produces) reached `net.connect` as a literal
 * path. Measured on the delivered artifact: `gp_probe_status` answered
 * `GP_E_ENGINE_UNREACHABLE` with Node's internals — "Port should be >= 0 and < 65536.
 * Received type string ('')" — and the remedy fell back to generic daemon-restart
 * wording, i.e. a variable this shell was never given was reported as a fault of the
 * user's daemon.
 *
 * The two entry points now disagree on purpose:
 *   - the **env** override: blank or whitespace-only reads as "no name here", so the
 *     fallback guess answers it (`engine-client.ts`).
 *   - the **flag**: an empty `--socket-path` is a usage error naming the flag,
 *     because dropping it silently would connect the operator to a daemon they did
 *     not pick (`index.ts`, `http-gateway-cli.ts`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINE_SOCKET_ENV, defaultSocketPath } from "../dist/engine-client.js";
import { FAKE_PROBE_BUNDLE_ID, startFakeDaemon } from "./support/fake-daemon.mjs";

const MCP_CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const HTTP_CLI = fileURLToPath(new URL("../dist/http-gateway-cli.js", import.meta.url));

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "gp-socket-blank-"));
test.after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function withEnv(body) {
  const saved = Object.getOwnPropertyDescriptor(process.env, ENGINE_SOCKET_ENV);
  try {
    return body();
  } finally {
    if (saved === undefined) {
      delete process.env[ENGINE_SOCKET_ENV];
    } else {
      process.env[ENGINE_SOCKET_ENV] = saved.value;
    }
  }
}

const FALLBACK = path.join(os.homedir(), ".glasspane", "engine.sock");

test("a blank GLASSPANE_ENGINE_SOCK is treated as unset, and a named one still wins", () => {
  for (const blank of ["", " ", "   ", "\t", "\n"]) {
    process.env[ENGINE_SOCKET_ENV] = blank;
    assert.equal(
      defaultSocketPath(),
      FALLBACK,
      `GLASSPANE_ENGINE_SOCK=${JSON.stringify(blank)} is not a socket; it must fall back, not be honoured`,
    );
  }
  delete process.env[ENGINE_SOCKET_ENV];
  assert.equal(defaultSocketPath(), FALLBACK, "unset still falls back (control)");

  // CONTROL, the other half: a real path still beats the default, so the fix cannot
  // be "ignore the override".
  process.env[ENGINE_SOCKET_ENV] = "/tmp/gp-named-elsewhere/engine.sock";
  assert.equal(defaultSocketPath(), "/tmp/gp-named-elsewhere/engine.sock");

  // And a path that merely *contains* spaces is still somebody's socket: the rule is
  // "names nothing", not "trim what you were given".
  process.env[ENGINE_SOCKET_ENV] = "/tmp/ gp two /engine.sock";
  assert.equal(defaultSocketPath(), "/tmp/ gp two /engine.sock");
});

/**
 * Spawn a CLI, feed it framed stdin, and collect what came back.
 *
 * Stdin is held open until the session has actually answered (`holdUntil` appears in
 * stdout) and only then closed: the shell queues `shutdown()` behind the replies it
 * already took, so closing immediately tears the session down while the daemon round
 * trip is still outstanding and the caller sees the `initialize` reply and nothing
 * else. That is the shell behaving correctly, and a fixture that tripped over it
 * would be measuring its own teardown.
 */
function runCli(cli, args, { env = {}, stdin = "", holdUntil = null, holdTimeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    let closed = false;
    const finish = (code) => setTimeout(() => resolve({ code, out, err }), 120);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (!closed && holdUntil !== null && out.includes(holdUntil)) {
        closed = true;
        child.stdin.end();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => finish(code));
    child.stdin.write(stdin);
    if (holdUntil === null) {
      child.stdin.end();
    } else {
      // A ceiling on the wait, not on the assertion: if the session never answers,
      // closing stdin lets the process exit and the assertions below read what did
      // arrive instead of hanging the suite.
      const timer = setTimeout(() => {
        if (!closed) {
          closed = true;
          child.stdin.end();
        }
      }, holdTimeoutMs);
      timer.unref();
    }
  });
}

test("glasspane-mcp refuses --socket-path= as a usage error naming the flag", async () => {
  // The message names the flag *as the operator spelled it* (`-s` stays `-s`), which
  // is the only version of this they can act on.
  const cases = [
    { args: ["--socket-path="], flag: "--socket-path" },
    { args: ["--socket-path", ""], flag: "--socket-path" },
    { args: ["-s", ""], flag: "-s" },
  ];
  for (const { args, flag } of cases) {
    const run = await runCli(MCP_CLI, args);
    assert.equal(run.code, 2, `${JSON.stringify(args)} must be a usage refusal (exit 2), got ${run.code}: ${run.err.slice(0, 200)}`);
    assert.ok(run.err.includes(`${flag} requires a value`),
      `the refusal must name ${flag}, for ${JSON.stringify(args)}: ${run.err.slice(0, 300)}`);
    // It says why an empty value is not a socket, and gives the next move: the usage
    // block with the command that reads the live socket.
    assert.match(run.err, /an empty path is not a socket/);
    assert.match(run.err, /usage: glasspane-mcp/);
    assert.match(run.err, /launchctl print/);
    assert.equal(run.out, "", "a refused start must not put a frame on stdout");
  }
});

test("glasspane-http refuses --socket-path= the same way", async () => {
  // The sibling binary has the same parser and the same failure; fixing one and not
  // the other is how the class survives a "fix". One spawn carries the behaviour (the
  // per-case detail is `glasspane-mcp`'s above, and both go through the same exported
  // helper), and the helper call is pinned by shape in both files so a rewrite that
  // drops it is caught without another 40 s of process startup on a loaded machine.
  const run = await runCli(HTTP_CLI, ["--socket-path="], { env: { GLASSPANE_HTTP_TOKEN: "test-bearer-token-0123456789abcdef" } });
  assert.equal(run.code, 2, `--socket-path= must be refused with exit 2, got ${run.code}`);
  assert.match(run.err, /--socket-path requires a value/, run.err.slice(0, 400));
  assert.match(run.err, /usage: glasspane-http/);
  for (const file of ["index.ts", "stdio-session.ts", "http-gateway-cli.ts"]) {
    const source = fs.readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), "utf8");
    if (!source.includes("socket-path")) {
      continue;
    }
    assert.match(source, /refuseEmptySocketPath\(value, /,
      `${file} parses --socket-path without going through the shared refusal`);
  }
});

/** One framed request per line, the way the daemon's own reader wants them. */
function framed(...objects) {
  return objects.map((o) => `${JSON.stringify(o)}\n`).join("");
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const PROBE = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gp_probe_status", arguments: {} } };

/**
 * The daemon on a real Unix socket is `test/support/fake-daemon.mjs` — the one fixture
 * every process-level session in this directory uses. It used to be a second copy here
 * with its own invented `probe_status` reply (`attachedApp` / `uptimeSeconds` /
 * `daemonProbeMarker`, none of which `EngineCore.probeStatus()` publishes), and the two
 * copies drifted: a session measured against the shell passed while answering a frame no
 * daemon has ever sent. One producer, and `test/fixture-daemon-shape.test.mjs` pins its
 * replies against the Swift that writes them.
 */
test("a real --socket-path still wins over the env override and the default", async () => {
  const real = path.join(SANDBOX, "named-engine.sock");
  const daemon = await startFakeDaemon(real);
  try {
    const run = await runCli(MCP_CLI, ["--socket-path", real], {
      // A *wrong* value in the environment: the flag is the higher-precedence name, so
      // the call must reach the real daemon anyway. Without this control the fix could
      // pass by ignoring the override entirely.
      env: { [ENGINE_SOCKET_ENV]: path.join(SANDBOX, "wrong-engine.sock") },
      stdin: framed(INITIALIZE, { jsonrpc: "2.0", method: "notifications/initialized" }, PROBE),
      holdUntil: '"id":2',
    });
    assert.equal(run.code, 0, `the session should end cleanly: ${run.err.slice(0, 300)}`);
    const frames = run.out.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
    assert.equal(frames.find((f) => f.id === 1)?.result?.serverInfo?.name, "glasspane-mcp");
    const probe = frames.find((f) => f.id === 2);
    assert.ok(probe, `the probe never got an answer; stdout was: ${run.out.slice(0, 300)}`);
    const text = probe.result.content[0].text;
    assert.equal(probe.result.isError, false, text.slice(0, 400));
    assert.match(text, new RegExp(FAKE_PROBE_BUNDLE_ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the bytes must come from the daemon on the named socket");
    // And what came back is a reply the daemon really answers, not a marker key: the
    // live-registration list is `probe_status`'s own surface.
    const answered = JSON.parse(text);
    assert.equal(answered.attachedHasProbe, true, text.slice(0, 400));
    assert.equal(answered.probes[0].connected, true, text.slice(0, 400));
  } finally {
    await daemon.stop();
  }
});

test("GLASSPANE_ENGINE_SOCK= no longer turns into Node's port error, and names the socket it fell back to", async () => {
  // The measured symptom, end to end on the delivered CLI: blank env + a HOME whose
  // default has nothing behind it must read as "nothing is listening on this path",
  // with the path in the message — not as a Node argument fault, and not as a
  // generic order to restart the daemon.
  const home = path.join(SANDBOX, "home");
  fs.mkdirSync(home, { recursive: true });
  const expected = path.join(home, ".glasspane", "engine.sock");
  const run = await runCli(MCP_CLI, [], {
    env: { [ENGINE_SOCKET_ENV]: "", HOME: home },
    stdin: framed(INITIALIZE, { jsonrpc: "2.0", method: "notifications/initialized" }, PROBE),
    holdUntil: '"id":2',
  });
  const frames = run.out.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  const probe = frames.find((f) => f.id === 2);
  assert.ok(probe, `no answer for the probe; stdout: ${run.out.slice(0, 300)} stderr: ${run.err.slice(0, 300)}`);
  const text = probe.result.content[0].text;
  assert.match(text, /GP_E_ENGINE_UNREACHABLE/, text.slice(0, 300));
  assert.equal(text.includes("Port should be >= 0"), false,
    `the Node internals message is back — something is still connecting to a blank path: ${text.slice(0, 300)}`);
  assert.equal(text.includes("Received type string ('')"), false, text.slice(0, 300));
  assert.ok(text.includes(expected),
    `the answer must name the socket it actually tried (${expected}): ${text.slice(0, 400)}`);
});

test("a blank env on the HTTP gateway path does not reach net.connect either", async () => {
  // `glasspane-http` resolves the same default, so the same blank value must not be
  // honoured there either: with a whitespace-only socket override it still starts
  // normally, and the refusal it makes is the token policy's — a real one, naming the
  // variable the operator has to set, and not a socket fault dressed up as one.
  const run = await runCli(HTTP_CLI, [], { env: { [ENGINE_SOCKET_ENV]: "   ", GLASSPANE_HTTP_TOKEN: "" } });
  assert.equal(run.code, 2, `an unauthenticated start must be refused: exit ${run.code}`);
  assert.match(run.err, /GLASSPANE_HTTP_TOKEN is not set or is empty/,
    `the refusal should be the token policy, not a socket fault: ${run.err.slice(0, 300)}`);
  assert.equal(run.err.includes("Port should be >= 0"), false, run.err.slice(0, 300));
});
