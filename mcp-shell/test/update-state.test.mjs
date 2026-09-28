import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readUpdateState, updateStateFile, STATE_DIR_ENV } from "../dist/update-state.js";
import { executeTool, TOOL_BY_NAME } from "../dist/tools.js";
import { makeEngine } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The shell reads what the updater writes. Two rules hold that together:
 *  - the two resolve the same state root from the same inputs (drift test below),
 *    or the shell would answer "never checked" about a machine that updated minutes
 *    ago — and the panel would show a different truth to the human in front of it;
 *  - a missing / unreadable / out-of-contract file is stated, never collapsed into
 *    silence, because "no data" is what an agent reads as "up to date".
 */

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gp-update-state-"));
}

test("the shell and the updater resolve the same state file for the same inputs", async () => {
  // Imported from the sibling workspace on purpose: this is the cross-check that
  // keeps the two resolutions from drifting, and it can only do that if it reads
  // the real one rather than a copy of its logic.
  const { resolveStateRoot } = await import("../../updater/cli.js");
  const cases = [
    { env: {}, override: undefined },
    { env: { [STATE_DIR_ENV]: "/tmp/gp-case-a" }, override: undefined },
    { env: {}, override: "/tmp/gp-case-b" },
    { env: { [STATE_DIR_ENV]: "/tmp/gp-case-a", HOME: "/tmp/home-redirect" }, override: undefined },
  ];
  for (const { env, override } of cases) {
    const updaterRoot = resolveStateRoot({
      flags: override !== undefined ? { "state-dir": override } : {},
      env,
      // The updater's own default is the password record; pass the same default the
      // shell uses so the comparison measures the rule, not a stubbed argument.
      homeDir: os.userInfo().homedir,
    });
    const shell = updateStateFile(env, override);
    assert.equal(shell, path.join(updaterRoot, "update-state.json"),
      `env=${JSON.stringify(env)} override=${override}: shell ${shell} ≠ updater ${updaterRoot}`);
  }
  // And neither follows $HOME: a redirected HOME must not move the answer.
  const redirected = { [STATE_DIR_ENV]: "", HOME: "/tmp/gp-definitely-not-home" };
  const viaRecord = updateStateFile(redirected);
  assert.equal(String(viaRecord).includes("gp-definitely-not-home"), false,
    `the state root followed $HOME: ${viaRecord}`);
});

test("a machine that never ran the updater is reported as unknown, not as current", () => {
  const root = tempRoot();
  try {
    const reading = readUpdateState({}, root);
    assert.equal(reading.kind, "absent");
    assert.match(reading.summary, /never run/);
    assert.equal(/up[- ]to[- ]date/i.test(reading.summary), false,
      `an absent file must not read as current: ${reading.summary}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt, unreadable or out-of-contract state file names its own failure", () => {
  const cases = [
    { write: "{not json", expect: /not valid JSON/ },
    { write: JSON.stringify({ status: "banana", current: "1.4.0" }), expect: /not a status this shell knows/ },
    { write: JSON.stringify({ current: "1.4.0" }), expect: /not a status this shell knows/ },
  ];
  for (const { write, expect } of cases) {
    const root = tempRoot();
    try {
      fs.writeFileSync(path.join(root, "update-state.json"), write, { mode: 0o600 });
      const reading = readUpdateState({}, root);
      assert.equal(reading.kind, "unreadable");
      assert.match(reading.summary, expect);
      assert.match(reading.summary, /unknown/, "every one of these must still say freshness is unknown");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a readable state renders the facts an agent can quote", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "update-state.json"), JSON.stringify({
      status: "rolled-back",
      current: "1.3.1",
      latest: "1.4.0",
      updatedAt: "2026-09-27T04:00:00.000Z",
      autoApply: true,
      disabled: false,
      staged: { version: "1.4.0", digest: "a1b2c3d4e5f607080910a1b2c3d4e5f607080910" },
      lastError: { code: "handshake-failed", message: "daemon still reported 1.3.1 after restart" },
    }), { mode: 0o600 });
    const reading = readUpdateState({}, root);
    assert.equal(reading.kind, "read");
    for (const fragment of ["status=rolled-back", "current=1.3.1", "latest=1.4.0",
      "lastError=handshake-failed", "staged=1.4.0 (a1b2c3d4e5f6"]) {
      assert.ok(reading.summary.includes(fragment), `missing ${fragment}: ${reading.summary}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gp_diagnose carries the update state as a separate block, leaving the JSON reply untouched", async () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "update-state.json"), JSON.stringify({
      status: "up-to-date", current: "1.4.0", latest: "1.4.0", updatedAt: "2026-09-27T04:00:00.000Z",
    }), { mode: 0o600 });
    // The shell reads the state root off the environment (same rule as the daemon's
    // `--state-dir`), so the test steers that variable rather than a second seam.
    const saved = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = root;
    const { engine, io } = makeEngine();
    const spec = TOOL_BY_NAME.get("gp_diagnose");
    const promise = executeTool(spec, {}, engine);
    io.lastFrame();
    io.respond({ class: "T1", summary: "ok" });
    const outcome = await promise;
    assert.equal(outcome.content.length, 2, `diagnose must answer plus one update block: ${JSON.stringify(outcome.content)}`);
    assert.deepEqual(JSON.parse(outcome.content[0].text), { class: "T1", summary: "ok" },
      "the daemon's reply is passed through byte-for-byte, update block or not");
    assert.match(outcome.content[1].text, /^update state: status=up-to-date/);
    if (saved === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = saved;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("gp_observe does not gain the update block", async () => {
  // The block belongs to the tool where the freshness question is asked. Without
  // this half, "append it to every forwarded reply" would pass the test above.
  const { engine, io } = makeEngine();
  const spec = TOOL_BY_NAME.get("gp_observe");
  const promise = executeTool(spec, { maxDepth: 2 }, engine);
  io.lastFrame();
  io.respond({ tree: {} });
  const outcome = await promise;
  assert.equal(outcome.content.length, 1, JSON.stringify(outcome.content));
  assert.equal(outcome.content[0].text.includes("update state"), false);
});
