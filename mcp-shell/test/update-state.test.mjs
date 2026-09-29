import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readUpdateState, updateStateFile, STATE_DIR_ENV, CA_ROOTS_STATUSES } from "../dist/update-state.js";
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
 *
 * `caRoots` — the record of the machine's exported TLS roots — is held to the same
 * two rules, and it is the field that decides whether the updater on this machine can
 * reach a release at all. A host whose HTTPS is re-signed locally fails every check
 * before any of the content-level verification runs, and until the shell says so the
 * failure is indistinguishable from an updater with nothing new to do. So: the five
 * documented states each get their own consequence plus one action the reader can
 * take; a value outside that set reddens the whole file rather than defaulting to the
 * friendly state; and a record that is absent says "this install never exported",
 * which is not "fine".
 */

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gp-update-state-"));
}

/**
 * Write a state file carrying `caRoots`, run `gp_diagnose` over the fake engine, and
 * hand back the reading, the update block, and the bundle path the state root implies.
 * The diagnosis goes through the real tool seam because the contract under test is
 * what an agent receives, not what an internal function returns.
 */
async function diagnoseWithCaRoots(caRoots, extra = {}) {
  const root = tempRoot();
  const saved = process.env[STATE_DIR_ENV];
  process.env[STATE_DIR_ENV] = root;
  try {
    const body = {
      schemaVersion: "1",
      status: "needs-consent",
      current: "1.3.1",
      latest: "1.4.0",
      updatedAt: "2026-09-29T04:00:00.000Z",
      ...extra,
    };
    // `undefined` is the missing-field case; `null` is its own recorded value.
    if (caRoots !== undefined) body.caRoots = caRoots;
    fs.writeFileSync(path.join(root, "update-state.json"), JSON.stringify(body), { mode: 0o600 });
    const spec = TOOL_BY_NAME.get("gp_diagnose");
    const { engine, io } = makeEngine();
    const promise = executeTool(spec, {}, engine);
    io.lastFrame();
    io.respond({ class: "T1", summary: "ok" });
    const outcome = await promise;
    assert.equal(outcome.content.length, 2,
      `the daemon reply plus one update block, got ${JSON.stringify(outcome.content.map((c) => c.text.slice(0, 60)))}`);
    assert.deepEqual(JSON.parse(outcome.content[0].text), { class: "T1", summary: "ok" },
      "the daemon's reply is passed through byte-for-byte, CA bundle line or not");
    const text = outcome.content[1].text;
    return { root, bundlePath: path.join(root, "ca-roots.pem"), text, caLine: text.split("\n")[1] ?? "", reading: readUpdateState({}, root) };
  } finally {
    if (saved === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Every non-`ok` state must hand the reader something to do, not just a bad adjective. */
function assertHasAction(caLine, status) {
  assert.match(caLine, new RegExp(`^ca trust bundle: ${status} `),
    `the bundle line must name its own state, not ${status} rendered as something else: ${caLine}`);
  assert.match(caLine, /Remedy:/, `a dead updater without an action reads as an updater that is fine: ${caLine}`);
  assert.equal(caLine.includes("node will use this exported root bundle"), false,
    `${status} must never be rendered as the usable-bundle sentence: ${caLine}`);
}

test("caRoots: ok decodes as usable and the diagnosis names the bundle node will use", async () => {
  const recorded = "/var/glasspane-shared/ca-roots.pem";
  const { caLine, reading } = await diagnoseWithCaRoots({
    status: "ok", certs: 163, path: recorded, exportedAt: "2026-09-29T10:00:00.000Z",
  });
  assert.equal(reading.kind, "read");
  assert.equal(reading.ca.recorded, true);
  assert.equal(reading.ca.status, "ok");
  assert.equal(reading.ca.certs, 163);
  assert.equal(reading.ca.recordedPath, recorded);
  assert.match(caLine, /^ca trust bundle: ok /);
  assert.match(caLine, /node will use this exported root bundle \(163 certificates at/);
  assert.match(caLine, new RegExp(recorded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the path the exporter recorded is the path the agent must point at");
  assert.match(caLine, /re-signed certificate chain/);
  assert.match(caLine, /exported 2026-09-29T10:00:00\.000Z/, "the stamp is the reader's only age signal");
  // Reverse mutation this catches: printing the derived path while the record names a
  // different file, which sends `NODE_EXTRA_CA_CERTS` at a bundle nobody exported.
  assert.equal(caLine.includes(reading.ca.bundlePath), false,
    `the recorded path wins over the derived one: ${caLine}`);
});

test("caRoots: probe-failed says the bundle landed and still could not reach a release", async () => {
  const { caLine, reading } = await diagnoseWithCaRoots({
    status: "probe-failed", certs: 163, path: "/Users/x/.glasspane/ca-roots.pem",
    detail: "GET https://api.github.com/... failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  });
  assert.equal(reading.ca.status, "probe-failed");
  assert.equal(reading.ca.detail.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), true);
  assertHasAction(caLine, "probe-failed");
  assert.match(caLine, /reaching the release endpoint through them still failed/);
  assert.match(caLine, /does not contain the root that re-signs/);
  assert.match(caLine, /recorded reason: .*UNABLE_TO_VERIFY_LEAF_SIGNATURE/, "the real cause, not just the state name");
  // §6 of the update spec: a remedy that is wrong for the state becomes a new source of
  // misdirection. Telling this reader to export the variable would be exactly that.
  assert.match(caLine, /changes nothing while the signing root is missing/);
  assert.match(caLine, /node updater\/cli\.js enable/);
});

test("caRoots: empty with a bundle kept from an earlier export says the bundle is stale, not missing", async () => {
  const keptPath = "/Users/x/.glasspane/ca-roots.pem";
  const { caLine, reading } = await diagnoseWithCaRoots({
    status: "empty", certs: 0, path: keptPath, detail: "neither keychain produced a PEM certificate",
  });
  assert.equal(reading.ca.status, "empty");
  assert.equal(reading.ca.certs, 0, "a zero count is data for `empty`, not a contract violation");
  assertHasAction(caLine, "empty");
  assert.match(caLine, /produced 0 certificates/);
  assert.match(caLine, new RegExp(`the bundle already at ${keptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} was kept`));
  assert.match(caLine, /is still what the agent and the panel hand to node/);
  assert.match(caLine, /a check can pass today while this machine's current roots go unrecorded/);
  assert.match(caLine, /security dump-keychain/, "the reader's next real step is to find out why the dump was empty");
  assert.match(caLine, /recorded reason: neither keychain produced a PEM certificate/);
  // The false half of this sentence is the point: an empty export on a machine that still
  // has a usable bundle must not be reported as having nothing there.
  assert.equal(caLine.includes("nothing is at"), false, caLine);
});

test("caRoots: empty with nothing kept says every check fails from here", async () => {
  const { caLine, bundlePath } = await diagnoseWithCaRoots({
    status: "empty", certs: 0, path: null, detail: "neither keychain produced a PEM certificate",
  });
  assert.match(caLine, /^ca trust bundle: empty /);
  assert.match(caLine, new RegExp(`nothing is at ${bundlePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} either`),
    "with no recorded path the state root is what names the missing file");
  assert.match(caLine, /every check fails certificate verification/);
  assert.match(caLine, /Remedy:/);
  assert.equal(caLine.includes("was kept"), false, `nothing was kept: ${caLine}`);
  assert.equal(caLine.includes("node will use this exported root bundle"), false);
});

test("caRoots: unavailable names the missing exporter and hands over the substitute", async () => {
  const { caLine, reading, bundlePath } = await diagnoseWithCaRoots({ status: "unavailable", path: null });
  assert.equal(reading.ca.status, "unavailable");
  assert.equal(reading.ca.recordedPath, null);
  assertHasAction(caLine, "unavailable");
  assert.match(caLine, /`security` tool was not found/);
  // No recorded path, so the state root is what names the file — the same root the state
  // file itself was resolved from, not a second guess.
  assert.match(caLine, new RegExp(bundlePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(caLine, /export NODE_EXTRA_CA_CERTS=/);
});

test("caRoots: write-unverified says the bytes on disk are not the bytes that were written", async () => {
  const { caLine, reading } = await diagnoseWithCaRoots({
    status: "write-unverified", certs: 163, path: "/Users/x/.glasspane/ca-roots.pem",
  });
  assert.equal(reading.ca.status, "write-unverified");
  assertHasAction(caLine, "write-unverified");
  assert.match(caLine, /were not the bytes the exporter wrote/);
  assert.match(caLine, /163 certificates/);
  assert.match(caLine, /re-run the GlassPane installer/);
  assert.match(caLine, /must stay off until that is fixed/,
    "a repeated unverifiable write must not be read as a working updater");
});

test("caRoots: null reads as this install never exported, never as fine", async () => {
  const { caLine, reading, bundlePath } = await diagnoseWithCaRoots(null);
  assert.equal(reading.kind, "read", "a null field is in contract; only an undecodable one reddens the file");
  assert.equal(reading.ca.recorded, false);
  assert.equal("status" in reading.ca, false,
    "a record that was never written carries no bundle state, not a default one");
  assert.match(caLine, /^ca trust bundle: this install has never recorded/);
  assert.match(caLine, /NOT the same as "the bundle is fine"/);
  assert.match(caLine, /every auto-update run fails certificate verification/);
  assert.match(caLine, /Remedy:/);
  assert.match(caLine, /node updater\/cli\.js enable/);
  assert.match(caLine, new RegExp(`export NODE_EXTRA_CA_CERTS=${bundlePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    "the terminal remedy has to name the file it would point at");
  assert.match(caLine, /before node starts/,
    "a variable node only reads at process start is not a remedy without that order stated");
  assert.equal(caLine.includes("node will use this exported root bundle"), false);
});

test("a state file with no caRoots field is not read as an ok bundle", async () => {
  // The same meaning as `null` by a different route, and the case an old install is in:
  // it wrote no such field because the field did not exist. Folding it into "ok" is the
  // exact mistake this whole surface exists to stop.
  const { caLine, reading, text } = await diagnoseWithCaRoots(undefined);
  assert.equal(reading.kind, "read");
  assert.equal(reading.ca.recorded, false);
  assert.match(text, /^update state: status=needs-consent/, "the freshness line still leads the block");
  assert.match(caLine, /^ca trust bundle: this install has never recorded/);
  assert.equal(/\bok\b/.test(caLine), false, `an absent record must not print a verdict of ok: ${caLine}`);
});

test("caRoots.status outside the five states reddens the whole file instead of defaulting to ok", async () => {
  const cases = [
    { caRoots: { status: "fine", certs: 3 }, expect: /caRoots\.status "fine" is not one of ok, probe-failed, empty, unavailable, write-unverified/ },
    { caRoots: { certs: 163 }, expect: /caRoots\.status null is not one of/ },
    { caRoots: { status: ["ok"], certs: 163 }, expect: /caRoots\.status \["ok"\] is not one of/ },
    { caRoots: [], expect: /caRoots is an array instead of the object/ },
    { caRoots: "ok", expect: /caRoots is string instead of the object/ },
    // `ok` is defined as a non-empty bundle that passed a probe, so an `ok` that carries
    // no positive count is the file claiming a measurement it did not take.
    { caRoots: { status: "ok", certs: 0 }, expect: /caRoots\.status says ok but it records 0 certificates/ },
    { caRoots: { status: "ok" }, expect: /caRoots\.status says ok but it records null certificates/ },
    { caRoots: { status: "ok", certs: "163" }, expect: /caRoots\.certs is string/ },
    { caRoots: { status: "ok", certs: 1.5 }, expect: /is not a certificate count/ },
    { caRoots: { status: "ok", certs: 163, path: "   " }, expect: /caRoots\.path is blank/ },
  ];
  for (const { caRoots, expect } of cases) {
    const { text, caLine, reading } = await diagnoseWithCaRoots(caRoots);
    assert.equal(reading.kind, "unreadable", `${JSON.stringify(caRoots)} must not decode as a readable state`);
    assert.match(reading.summary, expect, JSON.stringify(caRoots));
    assert.match(reading.summary, /unknown/, `an undecodable bundle leaves the reachability unknown: ${reading.summary}`);
    assert.equal(caLine, "", `no bundle line is claimed for a file that cannot be read: ${text}`);
    assert.equal(text.includes("ca trust bundle: ok"), false, JSON.stringify(caRoots));
  }
});

test("an unreadable state file claims nothing about the CA bundle", () => {
  // The refusal has to stay a refusal: a second block that fills the bundle line in from
  // a default would hand back the all-clear the unreadable file withheld.
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "update-state.json"), "{not json", { mode: 0o600 });
    const reading = readUpdateState({}, root);
    assert.equal(reading.kind, "unreadable");
    assert.equal("ca" in reading, false, "no CA reading exists when the file did not parse");
    assert.equal(reading.summary.includes("ca trust bundle: ok"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
