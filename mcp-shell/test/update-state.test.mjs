import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readUpdateState, runtimeIsUsable, updateStateFile, STATE_DIR_ENV, CA_ROOTS_STATUSES, RUNTIME_STATUSES } from "../dist/update-state.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
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
 *
 * `runtime` — whether the **updater's own installed copy** moved with the last
 * successful swap — is held to the same rules, and it decides a different question:
 * *which code tomorrow's scheduled check runs*. A machine can show `up-to-date` forever
 * while its job keeps executing the copy the installer first cloned, so a release that
 * fixes the updater never lands there. Hence: the four documented states each get their
 * own consequence plus one action; an unknown state, an undeclared key (the schema closes
 * the object with `additionalProperties: false`) or a malformed field reddens the whole
 * file instead of defaulting to `refreshed`; absent and explicit `null` both decode as
 * `recorded: false` — said as "this install never went through a swap that tried", never
 * as fine — while `writtenAsNull` keeps the two routes apart for the caller; and a
 * `refreshed` whose `agentVerified` is not `true` still decodes, because the missing
 * read-back is something the reader must act on rather than something to discard.
 */

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gp-update-state-"));
}

/** A path used inside a `new RegExp` has to be a literal path, not a pattern that happens to match anything. */
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const promise = executeTool(spec, {}, engine, new EvidenceAuditSession());
    io.lastFrame();
    io.respond({ class: "T1", summary: "ok" });
    const outcome = await promise;
    assert.equal(outcome.content.length, 2,
      `the daemon reply plus one update block, got ${JSON.stringify(outcome.content.map((c) => c.text.slice(0, 60)))}`);
    assert.deepEqual(JSON.parse(outcome.content[0].text), { class: "T1", summary: "ok" },
      "the daemon's reply is passed through byte-for-byte, CA bundle line or not");
    const text = outcome.content[1].text;
    const lines = text.split("\n");
    return {
      root,
      bundlePath: path.join(root, "ca-roots.pem"),
      text,
      caLine: lines[1] ?? "",
      // The updater self-update line is the third one: the block's order is what makes
      // `caLine` above the bundle line, so a new paragraph appended by a later change would
      // silently renumber every assertion below it.
      runtimeLine: lines[2] ?? "",
      lineCount: lines.length,
      // The self-update paragraph is information, not a tool failure: `isError` must stay
      // false for every state, including a file this shell could not decode.
      isError: outcome.isError,
      reading: readUpdateState({}, root),
    };
  } finally {
    if (saved === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The same seam with `runtime` as the field under test: the record goes into the state file
 * through the real reader and the real tool, because what an agent pastes from `gp_diagnose`
 * is the contract, not whatever `decodeRuntime` returns.
 */
async function diagnoseWithRuntime(runtime, extra = {}) {
  return diagnoseWithCaRoots(undefined, { runtime, ...extra });
}

/** Every state that is not "the new copy is running" must hand the reader something to do. */
function assertRuntimeAction(runtimeLine, status) {
  assert.match(runtimeLine, new RegExp(`^updater self-update: ${status}`),
    `the line must name its own state, not ${status} rendered as something else: ${runtimeLine}`);
  assert.match(runtimeLine, /Remedy:/, `a stale updater without an action reads as an updater that is fine: ${runtimeLine}`);
  assert.equal(runtimeLine.includes("is in place and the loaded launchd job was read back"), false,
    `${status} must never be rendered as the confirmed-copy sentence: ${runtimeLine}`);
}

/** The four documented states, as a closed list read off the module rather than retyped here. */
const RUNTIME_ROOT = "/Users/x/.glasspane/runtime/1.5.2/updater/cli.js";
const PREV_ROOT = "/Users/x/GlassPane/updater/cli.js";

/**
 * A record shaped the way `updater/lib/runtime.js` writes one: every documented key present,
 * with the fields each state is defined by overridable. A record missing a key is built
 * explicitly by the tests that care about it — that is the point of those tests.
 */
function runtimeRecord(status, over = {}) {
  return {
    status,
    version: status === "refreshed" || status === "kept" || status === "failed" ? "1.5.2" : null,
    cliPath: RUNTIME_ROOT,
    previousCliPath: PREV_ROOT,
    agentVerified: status === "refreshed" ? true : false,
    at: "2026-09-30T01:02:03.000Z",
    code: null,
    detail: null,
    ...over,
  };
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
  assert.match(caLine, /node \/[^`\s]+\/updater\/cli\.js enable/,
    "review 2026-10-09 finding 12: the enable step has to be an absolute path, not `node updater/cli.js` resolved against whatever directory the reader is standing in");
  assert.doesNotMatch(caLine, /`node updater\/cli\.js/, caLine);
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
  assert.match(caLine, /node \/[^`\s]+\/updater\/cli\.js enable/,
    "review 2026-10-09 finding 12: the enable step has to be an absolute path, not `node updater/cli.js` resolved against whatever directory the reader is standing in");
  assert.doesNotMatch(caLine, /`node updater\/cli\.js/, caLine);
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

test("runtime: refreshed with the job read back is the one usable state, and it names the copy", async () => {
  const { runtimeLine, lineCount, caLine, reading } = await diagnoseWithRuntime(runtimeRecord("refreshed"));
  assert.equal(reading.kind, "read");
  assert.equal(reading.runtime.recorded, true);
  assert.equal(reading.runtime.status, "refreshed");
  assert.equal(reading.runtime.agentVerified, true);
  assert.equal(reading.runtime.version, "1.5.2");
  assert.equal(reading.runtime.cliPath, RUNTIME_ROOT);
  assert.equal(reading.runtime.previousCliPath, PREV_ROOT);
  assert.equal(reading.runtime.code, null);
  assert.equal(reading.runtime.detail, null);
  assert.equal(runtimeIsUsable(reading.runtime), true, "refreshed plus a read-back job is the only pair that is usable");
  // The paragraph order is part of the block: the summary leads, the bundle line second.
  assert.equal(lineCount, 3, `summary + bundle line + self-update line: ${JSON.stringify(caLine)}`);
  assert.match(caLine, /^ca trust bundle: this install has never recorded/);
  assert.match(runtimeLine, /^updater self-update: refreshed — /);
  assert.match(runtimeLine, new RegExp(RUNTIME_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the installed copy is named by the path the record wrote, not by a description of one");
  assert.match(runtimeLine, /the loaded launchd job was read back and seen to go through the stable entry/);
  assert.match(runtimeLine, /recorded at 2026-09-30T01:02:03\.000Z/, "the stamp is the reader's only age signal");
  assert.match(runtimeLine, /without anyone reinstalling/);
});

test("runtime: a refreshed whose agentVerified is not true is decoded, never usable, never read as delivered", async () => {
  // Three shapes of "the read-back never happened": recorded false, recorded null, and the
  // key missing altogether. All three decode — the record still says what it attempted — and
  // none of them may be rendered as the confirmed-copy sentence.
  const shapes = [
    ["agentVerified: false", runtimeRecord("refreshed", { agentVerified: false }), false],
    ["agentVerified: null", runtimeRecord("refreshed", { agentVerified: null }), null],
  ];
  for (const [label, record, expectedAgent] of shapes) {
    const { runtimeLine, reading } = await diagnoseWithRuntime(record);
    assert.equal(reading.runtime.recorded, true, `${label} is still a record`);
    assert.equal(reading.runtime.status, "refreshed", `${label} must not be remapped to another state`);
    assert.equal(reading.runtime.agentVerified, expectedAgent, label);
    assert.equal(runtimeIsUsable(reading.runtime), false, `${label} cannot be claimed usable`);
    assert.match(runtimeLine, /^updater self-update: refreshed, but not confirmed — /);
    assert.match(runtimeLine, /never read back going through that entry/);
    assert.match(runtimeLine, /may still execute the previous one/);
    assert.match(runtimeLine, /Remedy:/);
    assert.equal(runtimeLine.includes("is in place and the loaded launchd job was read back and seen to go through"), false,
      `${label} must not print the confirmed sentence: ${runtimeLine}`);
  }
  // The key absent is the fourth shape: the record has nothing to report, so it reads as
  // "not verified" rather than as a malformed file.
  const noKey = { ...runtimeRecord("refreshed") };
  delete noKey.agentVerified;
  const { runtimeLine, reading } = await diagnoseWithRuntime(noKey);
  assert.equal(reading.runtime.recorded, true);
  assert.equal(reading.runtime.agentVerified, null, "an absent read-back is 'not verified', not false, and never true");
  assert.equal(runtimeIsUsable(reading.runtime), false);
  assert.match(runtimeLine, /but not confirmed/);
});

test("runtime: failed says the update installed and the updater itself did not, with the commands that end it", async () => {
  const { runtimeLine, reading, root } = await diagnoseWithRuntime(runtimeRecord("failed", {
    agentVerified: null,
    code: "runtime-stale",
    detail: "the loaded job still names the old command line",
  }));
  assert.equal(reading.runtime.status, "failed");
  assert.equal(reading.runtime.code, "runtime-stale");
  assert.equal(reading.runtime.detail.includes("the loaded job still names the old command line"), true);
  assert.equal(runtimeIsUsable(reading.runtime), false);
  assert.match(runtimeLine, /^updater self-update: failed — /);
  assert.match(runtimeLine, /the update itself installed/);
  // §11.4: this is a stated degradation on a swap that *succeeded*. Either collapse sends the
  // reader to the wrong door — "update failed" hides the installed version, "fine" hides this.
  assert.match(runtimeLine, /This is NOT "the update failed"/);
  assert.match(runtimeLine, /the previous copy still does/);
  assert.match(runtimeLine, /node \/[^`\s]+\/installer\/cli\.js/,
    "the reinstall has to be the command, not a promise — and an absolute one (review 2026-10-09 finding 12)");
  // The re-register command is built from the record's own script path and the state root
  // this shell actually resolved, so what an agent pastes is a command for this machine.
  assert.match(runtimeLine, new RegExp(`node ${escapeRe(RUNTIME_ROOT)} enable --state-dir ${escapeRe(root)} --json`),
    runtimeLine);
  assert.match(runtimeLine, /gate code: runtime-stale/);
  assert.match(runtimeLine, /recorded reason: the loaded job still names the old command line/);
});

test("runtime: a failed record with no path names no command it cannot mean", async () => {
  const { runtimeLine, reading } = await diagnoseWithRuntime(runtimeRecord("failed", {
    version: null, cliPath: null, previousCliPath: null, agentVerified: null, code: "installer-pointer-missing",
  }));
  assert.equal(reading.runtime.cliPath, null);
  assert.equal(runtimeIsUsable(reading.runtime), false);
  assert.match(runtimeLine, /^updater self-update: failed — /);
  assert.match(runtimeLine, /names no new copy at all, so the installer is the only way out/);
  assert.equal(runtimeLine.includes("enable --state-dir"), false,
    `no enable command may be printed without a script to run: ${runtimeLine}`);
  assert.match(runtimeLine, /the record names neither a version nor a path/);
});

test("runtime: kept is the machine's own switch, not a failure and not a delivered update", async () => {
  const { runtimeLine, reading } = await diagnoseWithRuntime(runtimeRecord("kept", {
    agentVerified: false, code: "auto-disabled",
    detail: "automatic update is switched off on this machine, so no launchd job was registered",
  }));
  assert.equal(reading.runtime.status, "kept");
  assert.equal(reading.runtime.agentVerified, false);
  assert.equal(reading.runtime.code, "auto-disabled");
  assert.equal(runtimeIsUsable(reading.runtime), false, "a copy nothing will run on its own is not a usable one");
  assert.match(runtimeLine, /^updater self-update: kept — /);
  assert.match(runtimeLine, /automatic update is switched off on this machine/);
  assert.match(runtimeLine, /no launchd job was registered/);
  assert.match(runtimeLine, /not a failure/);
  assert.match(runtimeLine, /switch automatic update back on/);
  // The two things `kept` must never borrow: the failed sentence (it is not a broken swap)
  // and the refreshed sentence (nothing was registered, so nothing was proven).
  assert.equal(runtimeLine.includes("did not move"), false, runtimeLine);
  assert.equal(runtimeLine.includes("was read back and seen to go through the stable entry"), false, runtimeLine);
  assert.match(runtimeLine, new RegExp(RUNTIME_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runtime: skipped says the code and the entry landed and one migration is owed, not that nothing ran", async () => {
  const { runtimeLine, reading } = await diagnoseWithRuntime(runtimeRecord("skipped", {
    version: null, cliPath: null, agentVerified: null,
  }));
  assert.equal(reading.runtime.status, "skipped");
  assert.equal(reading.runtime.version, null);
  assert.equal(reading.runtime.cliPath, null);
  assert.equal(runtimeIsUsable(reading.runtime), false);
  assert.match(runtimeLine, /^updater self-update: skipped — /);
  // 稳定入口之后这一支的真实内容：代码、指针、入口都落了，缺的只是把作业挪到入口上。旧句子
  // "did not attempt the updater's own swap" 在这台机器上是假的——它会把人支着去等下一轮，而那一步从来不会自己来。
  assert.match(runtimeLine, /the updater's code, the installer pointer and the stable agent entry all moved/);
  assert.match(runtimeLine, /owes one migration/);
  assert.match(runtimeLine, /would unregister the job that is running it/);
  assert.match(runtimeLine, /rather than as current/);
  assert.match(runtimeLine, /Remedy/);
  // "一次"必须是句子的一部分：不这么说，读者会以为每一轮都欠这一次人工动作。
  assert.match(runtimeLine, /Remedy \(one time\)/);
  assert.match(runtimeLine, /no future release will ask for this step/);
  assert.equal(runtimeLine.includes("updater self-update: refreshed"), false, runtimeLine);
  // 没有新路径时不许凭空印一个
  assert.equal(/the copy that would run next is (null|undefined)/.test(runtimeLine), false, runtimeLine);
});

test("runtime: absent and explicit null both read as 'never recorded', and the caller can tell them apart", async () => {
  const absent = await diagnoseWithCaRoots(undefined, {});
  const nulled = await diagnoseWithCaRoots(undefined, { runtime: null });
  assert.equal(absent.reading.runtime.recorded, false, "no key is 'never recorded', not a default state");
  assert.equal(absent.reading.runtime.writtenAsNull, false);
  assert.equal(nulled.reading.runtime.recorded, false);
  assert.equal(nulled.reading.runtime.writtenAsNull, true, "a recorded null is a different route and stays visible");
  assert.equal("status" in absent.reading.runtime, false,
    "a record that was never written carries no self-update state, not a default one");
  for (const { reading } of [absent, nulled]) {
    assert.equal(runtimeIsUsable(reading.runtime), false);
  }
  assert.match(absent.runtimeLine, /^updater self-update: this install has never recorded/);
  assert.match(absent.runtimeLine, /carries no "runtime" record at all/);
  assert.match(nulled.runtimeLine, /^updater self-update: this install has never recorded/);
  assert.match(nulled.runtimeLine, /carries "runtime": null/);
  assert.notEqual(absent.runtimeLine, nulled.runtimeLine, "the two routes are said differently");
  for (const line of [absent.runtimeLine, nulled.runtimeLine]) {
    assert.match(line, /NOT the same as/);
    assert.match(line, /node \/[^`\s]+\/installer\/cli\.js/,
      "one manual reinstall is the only thing that ends this, so the line has to name a runnable absolute command");
    assert.doesNotMatch(line, /`node installer\/cli\.js/, line);
    assert.match(line, /predates|never recorded/);
    assert.equal(line.includes("updater self-update: refreshed"), false, line);
  }
});

test("runtime: a record this shell cannot decode reddens the whole file instead of defaulting to refreshed", async () => {
  const cases = [
    // An unknown state: quoted back, never mapped onto the nearest known one.
    { runtime: runtimeRecord("refreshed", { status: "self-updated" }), expect: /runtime\.status "self-updated" is not one of refreshed, failed, kept, skipped/ },
    { runtime: { ...runtimeRecord("refreshed"), status: undefined }, expect: /runtime\.status null is not one of/ },
    { runtime: runtimeRecord(["refreshed"]), expect: /runtime\.status \["refreshed"\] is not one of/ },
    // `additionalProperties: false` is part of the contract, so an undeclared key is a
    // record from a writer this shell does not have — not extra information to ignore.
    { runtime: { ...runtimeRecord("refreshed"), drift: true }, expect: /runtime carries "drift", a key the state schema does not declare/ },
    // Wrong-typed and malformed fields: each one leaves the reader unable to name the copy.
    { runtime: runtimeRecord("refreshed", { agentVerified: "true" }), expect: /runtime\.agentVerified is string instead of true, false or null/ },
    { runtime: runtimeRecord("refreshed", { version: "1.5" }), expect: /runtime\.version "1\.5" is not a version/ },
    { runtime: runtimeRecord("refreshed", { cliPath: "   " }), expect: /runtime\.cliPath is blank/ },
    { runtime: runtimeRecord("refreshed", { cliPath: 7 }), expect: /runtime\.cliPath is number/ },
    { runtime: runtimeRecord("failed", { code: "RUNTIME-STALE" }), expect: /runtime\.code "RUNTIME-STALE" is not a gate code/ },
    { runtime: runtimeRecord("refreshed", { at: 1234 }), expect: /runtime\.at is number/ },
    { runtime: [], expect: /runtime is an array instead of the object/ },
    { runtime: "refreshed", expect: /runtime is string instead of the object/ },
  ];
  for (const { runtime, expect } of cases) {
    const { text, runtimeLine, reading } = await diagnoseWithCaRoots(undefined, { runtime });
    assert.equal(reading.kind, "unreadable", `${JSON.stringify(runtime)} must not decode as a readable state`);
    assert.match(reading.summary, expect, JSON.stringify(runtime));
    assert.match(reading.summary, /unknown/, `an undecodable self-update record leaves the running copy unknown: ${reading.summary}`);
    assert.match(reading.summary, /re-run the GlassPane installer/, "the refusal still says what ends it");
    assert.equal(runtimeLine, "", `no self-update line is claimed for a file that cannot be read: ${text}`);
    assert.equal(text.includes("updater self-update: refreshed"), false, JSON.stringify(runtime));
    assert.equal(text.includes("ca trust bundle"), false, "an unreadable file renders no paragraph at all");
  }
});

test("runtime: the self-update line names a real path or names none, never a template, never a tool failure", async () => {
  const shapes = [
    ["refreshed", runtimeRecord("refreshed")],
    ["refreshed unconfirmed", runtimeRecord("refreshed", { agentVerified: false })],
    ["failed", runtimeRecord("failed", { code: "runtime-stale" })],
    ["failed with no path", runtimeRecord("failed", { version: null, cliPath: null, previousCliPath: null })],
    ["kept", runtimeRecord("kept", { code: "auto-disabled" })],
    ["skipped", runtimeRecord("skipped", { version: null, cliPath: null })],
    ["absent", undefined],
    ["null", null],
    // A record that cannot be decoded renders no paragraph at all, so the checks below run
    // against the summary — which is what makes "unreadable, and here is the raw value" the
    // only thing the reader gets instead of a friendly default.
    ["unreadable", runtimeRecord("refreshed", { status: "self-updated" })],
  ];
  for (const [label, record] of shapes) {
    const { text, runtimeLine, isError, reading } = await diagnoseWithCaRoots(undefined, { runtime: record });
    assert.equal(isError, false, `${label} is a fact about the machine, not a tool failure: ${text}`);
    const line = reading.kind === "read" ? runtimeLine : reading.summary;
    assert.equal(line.includes("<"), false, `${label} left an angle-bracket template where a real path belongs: ${line}`);
    assert.equal(line.includes(">"), false, `${label} left an angle-bracket template where a real path belongs: ${line}`);
    assert.equal(line.includes("stateRoot"), false, `${label} named an internal variable instead of a file: ${line}`);
    assert.equal(line.includes("cliPath"), false, `${label} named the field instead of the path it holds: ${line}`);
  }
});

test("the shell's runtime vocabulary is the updater's", async () => {
  // Imported from the sibling package on purpose, like the state-root cross-check above:
  // a fourth status added on the writer's side must redden here rather than be silently
  // decoded as unreadable data by a shell that never heard of it.
  const { RUNTIME_STATUSES: updaterStatuses } = await import("../../updater/lib/runtime.js");
  assert.deepEqual([...RUNTIME_STATUSES], [...updaterStatuses],
    "the panel, gp_diagnose and the updater read one closed vocabulary");
  assert.deepEqual([...RUNTIME_STATUSES], ["refreshed", "failed", "kept", "skipped"]);
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
    const promise = executeTool(spec, {}, engine, new EvidenceAuditSession());
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
  const promise = executeTool(spec, { maxDepth: 2 }, engine, new EvidenceAuditSession());
  io.lastFrame();
  io.respond({ tree: {} });
  const outcome = await promise;
  assert.equal(outcome.content.length, 1, JSON.stringify(outcome.content));
  assert.equal(outcome.content[0].text.includes("update state"), false);
});

/* -------- 没记着 ≠ 记着"开着"：autoUpdate 与 lastError 的两处编造 -------- */

/**
 * 从前是 `disabled === true ? "off" : autoApply === true ? "on" : "on-by-default"`：
 * 两个字段都不在盘上时，它替这台机器宣布自动更新是开着的。本文件开头给自己立的
 * 规矩恰恰相反——absent 必须读成自己的那一态，"猜信任的壳比说读不到的壳更糟"。
 *
 * 反向变异：把 `unknown(...)` 那一支改回 `"on-by-default"`，第一条变红。
 */
function stateSummaryWith(state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-auto-"));
  try {
    fs.writeFileSync(path.join(root, "update-state.json"), JSON.stringify(state));
    return readUpdateState({}, root).summary ?? "";
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("an unrecorded auto-update switch is stated as unknown, never as on", () => {
  const bare = stateSummaryWith({ schemaVersion: 1, status: "up-to-date", current: "1.6.2", latest: "1.6.2" });
  assert.ok(bare.includes("autoUpdate=unknown"), `两个字段都没记着时必须说 unknown：${bare}`);
  assert.equal(bare.includes("on-by-default"), false, `"on-by-default" 是从缺席里编出来的正面主张：${bare}`);
});

test("an explicit disabled:false is the record speaking, and reads as on", () => {
  const said = stateSummaryWith({ schemaVersion: 1, status: "up-to-date", disabled: false, autoApply: false });
  assert.ok(said.includes("autoUpdate=on"), `记录明写了没关，就该读成 on：${said}`);
  assert.ok(stateSummaryWith({ schemaVersion: 1, status: "up-to-date", disabled: true }).includes("autoUpdate=off"));
});

/** 只有 code 没有 message 也要说出来：丢掉 code 就是把唯一可核对的事实扔掉。 */
test("a lastError with a code and no message still names the code", () => {
  const out = stateSummaryWith({
    schemaVersion: 1, status: "check-failed",
    lastError: { code: "release-unreachable", message: null },
  });
  assert.ok(out.includes("release-unreachable"), `code 不许因为缺句子就被丢：${out}`);
});
