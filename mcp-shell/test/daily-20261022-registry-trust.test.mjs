import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FORCE_OVERWRITE_ENV,
  PROJECTS_FILE_ENV,
  ProjectRegistryError,
  daemonProjectsPath,
  daemonRestartNotice,
  projectList,
  projectSet,
} from "../dist/project-registry.js";
import {
  GP_E_BAD_PARAMS,
  GP_E_INTERNAL,
  GP_E_REGISTRY_DRIFT,
  GP_E_STATE_ROOT_REFUSED,
} from "../dist/errors.js";
import { privateSandbox } from "./support/sandbox.mjs";

const REGISTRY_SOURCE = new URL("../src/project-registry.ts", import.meta.url);

/**
 * 2026-10-22 每日轮 · the registry's trust boundary and its lost-update window.
 *
 * Three verified defects in `mcp-shell/src/project-registry.ts`, all of them the same
 * species — a promise this module makes about a file it shares with three other writers:
 *
 * 1. `projectSet` read the table and *then* recorded the file's identity, so a concurrent
 *    writer that landed between those two steps was folded into the baseline: the drift
 *    guard compared the other writer's result against the other writer's result, passed,
 *    and this call renamed a stale table over it while reporting success.
 * 2. `hello.stateRoot` is a peer's statement about its own filesystem, `engine.sock` has no
 *    peer authentication, and `saveProjects` `mkdir`s and `chmod 0700`s whatever directory
 *    its path resolves to. A reply naming `/Users/<you>` or `/` therefore made *this* shell
 *    re-permission the account's home directory.
 * 3. `assertSingleIdentity` ran on the merged entry and blamed the caller for a registry
 *    another writer had already damaged.
 *
 * Every fixture here is a real file: the bytes are either what this module's own writer
 * publishes ({@link writerBytes}) or a mutation of those bytes, and the refusals come out
 * of the real `projectSet`/`projectList` path. The only stubs are the two this repository
 * already stubs elsewhere — `fs.readFileSync` inside a bounded, asserted-restored window,
 * and `os.userInfo` to make a scratch directory *be* the account's home so a refused root
 * can be pointed at something this suite can afford to have damaged. Neither stub ever
 * answers for code under test: the controlled read is the read `loadRegistry` itself
 * performs, and the guard's read goes to the real file.
 */

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const ALPHA = { displayName: "Alpha", bundleId: "com.example.alpha" };
const BETA = { displayName: "Beta", bundleId: "com.example.beta" };

function digestOf(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function expectRegistryError(fn, code, note) {
  let thrown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ProjectRegistryError, `${note}: expected a ProjectRegistryError, got ${thrown}`);
  assert.equal(thrown.code, code, `${note}: unexpected code ${thrown.code} — ${thrown.message}`);
  return thrown.message;
}

function siblings(dir, substring) {
  return fs.readdirSync(dir).filter((name) => name.includes(substring));
}

function modeOf(target) {
  return fs.statSync(target).mode & 0o777;
}

/**
 * A registry file inside a private sandbox, pointed at by `GLASSPANE_PROJECTS_FILE` for the
 * duration, exactly the way `project-registry.test.mjs` does it. Note the direction that
 * preference cuts: `projectsPath` honours the variable *before* any reported root, so the
 * root-facing tests have to take it away ({@link withoutProjectsFile}) or they would be
 * judging a path the reported root never reached.
 */
function useRegistry() {
  const sandbox = privateSandbox("gp-trust-");
  const filePath = path.join(sandbox.dir, "projects.json");
  const previousFile = process.env[PROJECTS_FILE_ENV];
  const previousForce = process.env[FORCE_OVERWRITE_ENV];
  process.env[PROJECTS_FILE_ENV] = filePath;
  delete process.env[FORCE_OVERWRITE_ENV];
  return {
    root: sandbox.dir,
    filePath,
    dispose() {
      if (previousFile === undefined) delete process.env[PROJECTS_FILE_ENV];
      else process.env[PROJECTS_FILE_ENV] = previousFile;
      if (previousForce === undefined) delete process.env[FORCE_OVERWRITE_ENV];
      else process.env[FORCE_OVERWRITE_ENV] = previousForce;
      sandbox.dispose();
    },
  };
}

/** Run `body` with no `GLASSPANE_PROJECTS_FILE`, so a reported root really is the path used. */
function withoutProjectsFile(body) {
  const previous = process.env[PROJECTS_FILE_ENV];
  delete process.env[PROJECTS_FILE_ENV];
  try {
    return body();
  } finally {
    if (previous !== undefined) process.env[PROJECTS_FILE_ENV] = previous;
  }
}

/**
 * The bytes this module's own writer publishes for one entry, in a scratch file that is
 * *not* the registry under test. Returns the entry it wrote as well, so a test can name the
 * fields it expects to find on the disk. Nothing below fabricates a registry shape.
 */
function writerBytes(dir, label, args) {
  const file = path.join(dir, `${label}-registry.json`);
  const previous = process.env[PROJECTS_FILE_ENV];
  process.env[PROJECTS_FILE_ENV] = file;
  try {
    const entry = projectSet(args);
    return { file, entry, bytes: fs.readFileSync(file) };
  } finally {
    if (previous === undefined) delete process.env[PROJECTS_FILE_ENV];
    else process.env[PROJECTS_FILE_ENV] = previous;
  }
}

/**
 * Make the next read of `target` return `bytes` and every later read go to the real file —
 * which is the whole point: the read that produces the edit is controlled, the read the
 * guard performs at write time is not. `loadRegistry` and `registryDigest` both go through
 * `fs.readFileSync`, and the patch is asserted to have fired and to be gone again.
 */
function withOneControlledRead(target, bytes, body) {
  const real = fs.readFileSync;
  let armed = true;
  try {
    fs.readFileSync = function patched(other, ...rest) {
      if (armed && other === target) {
        armed = false;
        return Buffer.from(bytes);
      }
      return real.call(fs, other, ...rest);
    };
    const outcome = body();
    assert.equal(armed, false, "the controlled read never happened, so this test judged nothing");
    return outcome;
  } finally {
    fs.readFileSync = real;
    assert.equal(fs.readFileSync, real, "fs.readFileSync must be back to the real reader");
  }
}

/* ------------------------------------------------------------------ *
 * Defect 1 — the baseline must be the bytes that produced this edit
 *
 * REVERT THAT REDDENS THIS SECTION: put the capture back where it was —
 * `const openedAs = fileIdentity(filePath)` taken *after* `requireUsableRegistry`, with
 * `fileIdentity` = `mtimeMs:size:ino` from `fs.statSync`, and `assertNoConcurrentWrite`
 * comparing that against a fresh `fileIdentity`.
 *  - "the drift guard compares the bytes it read…" reddens, because the two `statSync` calls
 *    straddle the other writer's write: the guard compares two IDENTICAL stats of registry B,
 *    finds no drift, and `saveProjects` renames A-plus-ours over B — the lost update reported
 *    as a success.
 *  - "an entry that appears underneath the edit…" reddens for the same reason: the late stat
 *    already sees the file that appeared.
 *  - "the escape hatch refuses to archive…" reddens instead when the pre-rename re-digest is
 *    what gets deleted (see that test), and "the escape hatch archives exactly the bytes…"
 *    reddens when the post-repair baseline is dropped in favour of `snapshot.readAs`.
 * ------------------------------------------------------------------ */

test("the drift guard compares the bytes it read against the bytes on disk, not two stats of the disk", () => {
  const reg = useRegistry();
  try {
    // Two registries, both produced by this module's own writer.
    const alpha = writerBytes(reg.root, "alpha", ALPHA);
    const beta = writerBytes(reg.root, "beta", BETA);

    // The disk holds B; this call is made to read A.
    fs.writeFileSync(reg.filePath, beta.bytes, { mode: 0o600 });
    const message = withOneControlledRead(reg.filePath, alpha.bytes, () => expectRegistryError(
      () => projectSet({ displayName: "Gamma", bundleId: "com.example.gamma" }),
      GP_E_REGISTRY_DRIFT,
      "a read of registry A with registry B on the disk",
    ));

    // The refusal is the content comparison it claims to be: both halves named in it are
    // digests of bytes, and the baseline half is of the bytes THIS call read.
    assert.match(message, /changed between the read that produced this edit/, message);
    assert.ok(message.includes(digestOf(alpha.bytes)),
      `the baseline in the message must be the digest of what we read: ${message}`);
    assert.ok(message.includes(digestOf(beta.bytes)),
      `the disk half must be the digest of what is on the disk: ${message}`);
    assert.match(message, /wrote nothing/, message);

    // And the other writer's entry is still there, verbatim — the point of the whole guard.
    const onDisk = fs.readFileSync(reg.filePath);
    assert.equal(onDisk.toString("utf8"), beta.bytes.toString("utf8"),
      "the refusal must leave the newer table byte-for-byte intact");
    const stored = JSON.parse(onDisk.toString("utf8"));
    assert.deepEqual(stored.map((one) => one.projectId), [beta.entry.projectId]);
    assert.equal(onDisk.toString("utf8").includes("com.example.gamma"), false, "our entry did not land either");
    assert.deepEqual(siblings(reg.root, ".tmp-"), [], "a refused write leaves no half-written temp behind");
  } finally {
    reg.dispose();
  }
});

test("an entry that appears underneath the edit is refused even when it is the file appearing at all", () => {
  // The `null → digest` half of the guard, run through the writer instead of as a pure call.
  // The other writer publishes its registry *inside* the window: our read finds no file at
  // all, and by the time the guard reads, B is on the disk — real bytes from the real
  // writer, a real file, and a real second read.
  // REVERT: with the old ordering the identity is a `statSync` taken *after* the read, so it
  // already sees B, and the guard compares B's stat against B's stat — two identical stats,
  // no drift — and publishes our one-entry table over theirs.
  const reg = useRegistry();
  try {
    const beta = writerBytes(reg.root, "beta", BETA);
    assert.equal(fs.existsSync(reg.filePath), false, "premise: the registry under test was never written");
    const real = fs.readFileSync;
    let armed = true;
    let message;
    try {
      fs.readFileSync = function patched(target, ...rest) {
        if (armed && target === reg.filePath) {
          armed = false;
          fs.writeFileSync(reg.filePath, beta.bytes, { mode: 0o600 });
          // A real ENOENT shape: `code` is what `nodeErrorCode` reads, and an Error built
          // without it would take the "cannot be read" arm instead, which is a different case.
          throw Object.assign(new Error("ENOENT: no such file or directory, open"), { code: "ENOENT" });
        }
        return real.call(fs, target, ...rest);
      };
      message = expectRegistryError(
        () => projectSet(ALPHA),
        GP_E_REGISTRY_DRIFT,
        "an absent read against a file that appeared",
      );
    } finally {
      fs.readFileSync = real;
    }
    assert.equal(armed, false, "the controlled read never happened, so this test judged nothing");
    assert.match(message, /was absent/, message);
    assert.equal(fs.readFileSync(reg.filePath).toString("utf8"), beta.bytes.toString("utf8"),
      "the file that appeared is the one that stays");
    assert.deepEqual(siblings(reg.root, ".tmp-"), [], "and nothing was written beside it");
  } finally {
    reg.dispose();
  }
});

test("the escape hatch archives exactly the bytes this call read, and still publishes the rebuilt table", () => {
  // REVERT THAT REDDENS THIS: return `snapshot.readAs` as the baseline from the repair arm
  // instead of re-digesting after the rename. The bytes this call read have just moved to
  // `.unreadable-…`, so that baseline makes the guard compare them against an absent file,
  // reads this module's own repair as a concurrent write, and the escape hatch stops working.
  const reg = useRegistry();
  try {
    const beta = writerBytes(reg.root, "beta", BETA);
    // A torn write: real bytes from the real writer, cut short. That is the damage the hatch
    // exists for, and it is unparseable by construction.
    const torn = beta.bytes.subarray(0, Math.floor(beta.bytes.length / 2));
    assert.throws(() => JSON.parse(torn.toString("utf8")), "the fixture must be a file this module cannot parse");
    fs.writeFileSync(reg.filePath, torn, { mode: 0o600 });

    expectRegistryError(() => projectSet(ALPHA), GP_E_INTERNAL, "without the hatch the damage is reported, not replaced");
    process.env[FORCE_OVERWRITE_ENV] = "1";
    const entry = projectSet({ displayName: "Rebuilt", bundleId: "com.example.rebuilt" });

    const kept = siblings(reg.root, ".unreadable-");
    assert.equal(kept.length, 1, "the unloadable file was moved aside, not deleted");
    const keptPath = path.join(reg.root, kept[0]);
    assert.deepEqual(fs.readFileSync(keptPath), torn, "the archived bytes are byte-for-byte what this call read");
    assert.equal(entry.discardedUnreadableFile, keptPath);
    const stored = JSON.parse(fs.readFileSync(reg.filePath, "utf8"));
    assert.equal(stored.length, 1, "and the rebuilt registry is the new entry alone");
    assert.equal(stored[0].bundleId, "com.example.rebuilt");
    assert.deepEqual(siblings(reg.root, ".tmp-"), []);
  } finally {
    delete process.env[FORCE_OVERWRITE_ENV];
    reg.dispose();
  }
});

test("the escape hatch refuses to archive a file that is no longer the one that failed to parse", () => {
  // The other half of the same window: `renameSync` is a write. Between the read that could
  // not parse and the rename, a concurrent writer can land a *good* registry, and moving
  // that aside destroys the entry this module exists to protect — this project once
  // destroyed a real `projects.json` exactly that way.
  // REVERT THAT REDDENS THIS: delete the pre-rename `registryDigest` comparison in
  // `requireUsableRegistry`. "I could not read this" is not evidence that it is unreadable.
  const reg = useRegistry();
  try {
    const beta = writerBytes(reg.root, "beta", BETA);
    const torn = beta.bytes.subarray(0, Math.floor(beta.bytes.length / 2));
    assert.throws(() => JSON.parse(torn.toString("utf8")), "the fixture must be unparseable");

    // The disk holds B; this call reads a torn copy of it.
    fs.writeFileSync(reg.filePath, beta.bytes, { mode: 0o600 });
    process.env[FORCE_OVERWRITE_ENV] = "1";
    const message = withOneControlledRead(reg.filePath, torn, () => expectRegistryError(
      () => projectSet(ALPHA),
      GP_E_REGISTRY_DRIFT,
      "the repair met a file that is not the one it read",
    ));
    assert.match(message, /is no longer the file that failed to parse/, message);
    assert.match(message, /nothing was moved/, "the refusal has to say the archive did not happen either");
    assert.match(message, /Repeat the same call/, "and hand over the step that actually works");
    assert.deepEqual(siblings(reg.root, ".unreadable-"), [], "the newer registry was not moved aside");
    assert.equal(fs.readFileSync(reg.filePath).toString("utf8"), beta.bytes.toString("utf8"),
      "the other writer's table is still on the disk, verbatim");
    assert.deepEqual(siblings(reg.root, ".tmp-"), [], "and nothing was written in its place");
  } finally {
    delete process.env[FORCE_OVERWRITE_ENV];
    reg.dispose();
  }
});

test("a single writer is never told it drifted: the digest guard passes its own write, twice", () => {
  // Regression guard for the new comparison, not a red-on-revert test — the old stat-based
  // ordering passes this too, and that was the bug's other half: it stayed quiet for a lone
  // writer. It is here because reading the file twice and hashing it is a *new way to be
  // wrong*: digest the path after `saveProjects` published, or move `assertNoConcurrentWrite`
  // below the write, and every legitimate registration starts answering GP_E_REGISTRY_DRIFT.
  const reg = useRegistry();
  try {
    const created = projectSet(ALPHA);
    const updated = projectSet({ projectId: created.projectId, displayName: "Alpha 2" });
    const second = projectSet(BETA);
    assert.equal(updated.displayName, "Alpha 2", "the patch landed");
    assert.notEqual(second.projectId, created.projectId, "the create appended a second entry of its own");
    const stored = JSON.parse(fs.readFileSync(reg.filePath, "utf8"));
    assert.equal(stored.length, 2, "two entries: the update patched, the create appended");
    assert.deepEqual(stored.map((one) => one.displayName).sort(), ["Alpha 2", "Beta"]);
    assert.deepEqual(siblings(reg.root, ".tmp-"), []);
  } finally {
    reg.dispose();
  }
});

/* ------------------------------------------------------------------ *
 * Defect 2 — a peer-named root may not be created or re-permissioned
 *
 * REVERT THAT REDDENS THIS SECTION: `daemonProjectsPath` going back to
 * `if (named !== "") return path.join(named, "projects.json")` with no classification step.
 * "the root a daemon reports about itself is classified…" and "the refusal touches nothing…"
 * then answer with a joined path instead of a refusal — and the second one with a real
 * `mkdirSync` and `chmod 0700` on the refused directory, which is the damage, done to a
 * directory this suite owns instead of the developer's home.
 * ------------------------------------------------------------------ */

const FIRMLINK_PREFIX = "/System/Volumes/Data";

test("the root a daemon reports about itself is classified before anything is derived from it", () => {
  const home = os.userInfo().homedir;
  const refused = {
    "the filesystem root": "/",
    "the home directory itself": home,
    "the home with a trailing slash": `${home}/`,
    "the home with two trailing slashes": `${home}//`,
    "the home spelled through the APFS firmlink": `${FIRMLINK_PREFIX}${home}`,
    "the home spelled through the firmlink with a trailing slash": `${FIRMLINK_PREFIX}${home}/`,
    "a ~-prefixed value": "~/.glasspane",
    "a bare ~": "~",
    "a relative value": ".glasspane",
    "a bare directory name": "glasspane-state",
    "a relative path with separators": "var/glasspane",
  };
  const messages = new Map();
  for (const [label, root] of Object.entries(refused)) {
    const message = withoutProjectsFile(() => expectRegistryError(
      () => daemonProjectsPath(root), GP_E_STATE_ROOT_REFUSED, `${label} (${root})`,
    ));
    messages.set(label, message);
    // Every claim the refusal makes, in the text an agent reads.
    assert.match(message, /self-reported state root/, `${label}: whose value this is`);
    assert.match(message, /hello/, `${label}: where it arrived`);
    assert.match(message, /stateRoot/, `${label}: the key it came in on`);
    assert.match(message, /no peer authentication/, `${label}: why a reply is not authority`);
    assert.match(message, /will not create or re-permission/, `${label}: what this shell refuses to do`);
    assert.match(message, /will NOT quietly fall back to the home default/, `${label}: no silent fallback`);
    assert.match(message, /created that directory/, `${label}: the mkdir this call would have run`);
    assert.match(message, /0700/, `${label}: the mode it would have applied`);
    assert.match(message, /Nothing was read and nothing was written/, `${label}: what actually happened`);
    assert.match(message, /--state-dir <a directory this install owns>/, `${label}: the daemon's own remedy shape`);
    assert.match(message, /glasspaned --state-dir/, `${label}: the remedy has to name the binary that takes the flag`);
    assert.ok(message.includes(root), `${label}: the refused value has to be visible in the refusal: ${message}`);
  }

  // Folding, stated as the property rather than as one lucky spelling: `StateRoot.swift`'s
  // own note is that "a refusal that only catches one spelling is a refusal the next typo
  // walks past".
  const namesHomeRule = (text) => /is this account's home directory itself/.test(text);
  assert.ok(namesHomeRule(messages.get("the home directory itself")), "the plain home names the home rule");
  assert.ok(namesHomeRule(messages.get("the home with a trailing slash")), "one trailing slash folds onto it");
  assert.ok(namesHomeRule(messages.get("the home with two trailing slashes")), "two must too");
  assert.ok(namesHomeRule(messages.get("the home spelled through the APFS firmlink")),
    `the firmlink spelling is the same directory: ${messages.get("the home spelled through the APFS firmlink")}`);
  assert.ok(namesHomeRule(messages.get("the home spelled through the firmlink with a trailing slash")),
    "…and it folds with a trailing slash as well");
  assert.match(messages.get("the filesystem root"), /is the filesystem root/);
  for (const label of ["a ~-prefixed value", "a bare ~", "a relative value", "a bare directory name", "a relative path with separators"]) {
    assert.match(messages.get(label), /is not an absolute path/, `${label}: ${messages.get(label)}`);
  }

  // Dedicated roots stay usable — including the shape the daemon itself recommends, which
  // is the answer this module must not refuse or it cannot register anything at all.
  const accepted = {
    [`${home}/.glasspane`]: path.join(home, ".glasspane", "projects.json"),
    [`${home}/.glasspane/`]: path.join(home, ".glasspane", "projects.json"),
    "/tmp/sandbox": path.join("/tmp/sandbox", "projects.json"),
    "/tmp/sandbox/": path.join("/tmp/sandbox", "projects.json"),
    [`${home}/work/notes/.glasspane`]: path.join(home, "work/notes/.glasspane", "projects.json"),
    "/Volumes/Work/state": path.join("/Volumes/Work/state", "projects.json"),
    // A firmlink spelling of a *dedicated* root is still usable, and stays in the spelling
    // the daemon reported — un-mapping it would name a file the service does not open. Only
    // the refusal compares in un-mapped form, because that is what it compares to.
    [`${FIRMLINK_PREFIX}/Users/example/state`]: `${FIRMLINK_PREFIX}/Users/example/state/projects.json`,
  };
  for (const [root, expected] of Object.entries(accepted)) {
    assert.equal(daemonProjectsPath(root), expected, `a dedicated root must still be usable: ${root}`);
  }

  // The refusal reaches the tools that actually take `client.reportedStateRoot`, on both
  // the read side and the write side — not just the path builder.
  withoutProjectsFile(() => {
    for (const root of ["/", home]) {
      expectRegistryError(() => projectList(root), GP_E_STATE_ROOT_REFUSED, `projectList(${root})`);
      expectRegistryError(() => projectSet(ALPHA, root), GP_E_STATE_ROOT_REFUSED, `projectSet(_, ${root})`);
    }
  });
});

test("no reported root still means the home default, and is still said as a default", () => {
  // "Do not silently fall back" has a second half: the arm that legitimately *does* use the
  // home default is a guess about the default and must stay worded that way, or the refusal
  // above would be paid for with a new lie.
  const home = os.userInfo().homedir;
  const expected = path.join(home, ".glasspane", "projects.json");
  for (const absent of [undefined, null, "", "   ", "\t"]) {
    assert.equal(daemonProjectsPath(absent), expected, "an absent root must keep resolving the home default");
  }
  const notice = daemonRestartNotice(expected, null);
  assert.match(notice, /not knowable from here/, notice);
  assert.match(notice, /no stateRoot/, notice);
  assert.doesNotMatch(notice, /the state root the running daemon reported/,
    `the default is a guess about the default, never about the running service: ${notice}`);
});

test("the refusal touches nothing: not a directory, not a mode, not a byte of a registry", () => {
  // A refused root has to be a directory someone could actually damage, so `os.userInfo` is
  // stubbed and a scratch directory *is* the account's home for the duration — the same seam
  // `project-registry.test.mjs` stubs for the no-record arm. The mode, the listing and the
  // bytes are then read back off the real filesystem.
  // REVERT THAT REDDENS THIS: delete the classification step. `projectSet` then runs
  // `mkdirSync(<refused root>, 0700)` + `chmodSync(<refused root>, 0700)` and writes its
  // table into it — here, recoverably, instead of into the developer's home.
  const sandbox = privateSandbox("gp-refused-root-");
  const fakeHome = path.join(sandbox.dir, "home");
  fs.mkdirSync(fakeHome, { mode: 0o755 });
  fs.chmodSync(fakeHome, 0o755);
  const realUserInfo = os.userInfo;
  const record = realUserInfo.call(os);
  try {
    assert.equal(modeOf(fakeHome), 0o755, "premise: the refused root starts loose, so a chmod 0700 would show");
    const rootModeBefore = modeOf("/");
    assert.deepEqual(fs.readdirSync(fakeHome), [], "premise: the refused root starts empty");

    os.userInfo = () => ({ ...record, homedir: fakeHome });
    withoutProjectsFile(() => {
      for (const [label, run] of [
        ["projectSet", () => projectSet(ALPHA, fakeHome)],
        ["projectList", () => projectList(fakeHome)],
        ["daemonProjectsPath", () => daemonProjectsPath(fakeHome)],
      ]) {
        expectRegistryError(run, GP_E_STATE_ROOT_REFUSED, `${label} against the home itself`);
      }
      assert.deepEqual(fs.readdirSync(fakeHome), [],
        "a refusal may not create anything in the directory it refused — no projects.json, no temp file");
      assert.equal(modeOf(fakeHome), 0o755, `the refused root was re-permissioned: ${(modeOf(fakeHome)).toString(8)}`);

      // The filesystem root, judged the same way and recorded the same way. Its `chmod`
      // would fail as an unprivileged process anyway; the mode and the absence of
      // `/projects.json` are still what the refusal promises, so they are measured.
      expectRegistryError(() => projectSet(ALPHA, "/"), GP_E_STATE_ROOT_REFUSED, "projectSet against /");
      assert.equal(modeOf("/"), rootModeBefore, "/ must come back of the refusal with the mode it went in with");
      assert.equal(fs.existsSync("/projects.json"), false, "no registry appeared at the filesystem root");

      // And with a registry already sitting in the refused root, the refusal reads nothing:
      // the file comes back byte-for-byte, so "nothing was read and nothing was written" is
      // a measured claim rather than a sentence.
      const witness = writerBytes(sandbox.dir, "witness", BETA);
      const witnessFile = path.join(fakeHome, "projects.json");
      fs.writeFileSync(witnessFile, witness.bytes, { mode: 0o600 });
      const modeBefore = modeOf(fakeHome);
      expectRegistryError(() => projectSet(ALPHA, fakeHome), GP_E_STATE_ROOT_REFUSED, "a refused root that already has a table");
      expectRegistryError(() => projectList(fakeHome), GP_E_STATE_ROOT_REFUSED, "the read side of the same refusal");
      assert.equal(fs.readFileSync(witnessFile).toString("utf8"), witness.bytes.toString("utf8"),
        "the refused root's own projects.json was neither read nor rewritten");
      assert.equal(modeOf(fakeHome), modeBefore, "and its mode is the one it had");
      assert.deepEqual(fs.readdirSync(fakeHome).sort(), ["projects.json"], "nothing new appeared beside it");
    });
  } finally {
    os.userInfo = realUserInfo;
    sandbox.dispose();
  }
  // The patch is off again — otherwise every later test in this file would be judging a
  // stubbed home, and "green" would mean nothing.
  assert.equal(os.userInfo, realUserInfo, "os.userInfo must be back to the real lookup after the stub");
  assert.equal(daemonProjectsPath(null), path.join(record.homedir, ".glasspane", "projects.json"),
    "and the default root resolves the real home again");
});

/* ------------------------------------------------------------------ *
 * Defect 3 — a message that blames the caller for damage it did not do
 *
 * REVERT THAT REDDENS THIS: `assertSingleIdentity(entry)` back to one argument, judging the
 * merged entry alone. "a registry damaged by another writer…" then answers
 * `GP_E_BAD_PARAMS: bundleId (…) and pid (…) are both set … Pass null for the one to drop`
 * to a call that named neither field — a verdict about arguments that were never the problem.
 * ------------------------------------------------------------------ */

test("a registry damaged by another writer is not reported as a fault of this call's arguments", () => {
  const reg = useRegistry();
  try {
    // Real writer output, edited to add the second identity: the shape a careless writer
    // leaves behind, and one `inspectStoredEntry` accepts because it judges the daemon's
    // decodable *types*, not this rule.
    const created = projectSet({ displayName: "Both", bundleId: "com.example.both" });
    const asWritten = fs.readFileSync(reg.filePath);
    const stored = JSON.parse(asWritten.toString("utf8"));
    assert.equal(stored.length, 1, "premise: the real writer published exactly one entry");
    assert.equal("pid" in stored[0], false, "premise: the published entry carries one identity");
    stored[0].pid = 4242;
    const damaged = Buffer.from(JSON.stringify(stored, null, 2), "utf8");
    fs.writeFileSync(reg.filePath, damaged, { mode: 0o600 });

    // The load still works: this is a list-able table, not an unreadable one.
    assert.equal(projectList().length, 1, "a both-identities entry is still decodable, so it is still listed");

    // A call that names neither field.
    const message = expectRegistryError(
      () => projectSet({ projectId: created.projectId, displayName: "Renamed" }),
      GP_E_INTERNAL,
      "a call that named neither identity against a damaged entry",
    );
    assert.ok(message.includes(created.projectId), `the refusal has to name the projectId: ${message}`);
    assert.ok(message.includes("com.example.both") && message.includes("4242"),
      `both stored halves have to be shown: ${message}`);
    assert.match(message, /already stored two identities/, message);
    assert.match(message, /this call named neither bundleId nor pid/, "and where each half came from");
    assert.match(message, /this call did not create that shape/, "the sentence may not read as a verdict about the arguments");
    assert.equal(message.includes("Pass null for the one to drop"), false,
      `the caller-created wording must not be reused as an accusation: ${message}`);
    assert.match(message, /Nothing was written/, message);
    // The next step has to be executable in both directions: drop one half through this
    // module, or find out which half is real before choosing.
    assert.match(message, /gp_project_set with projectId/, message);
    assert.match(message, /pid: null keeps bundleId/, message);
    assert.match(message, /bundleId: null keeps pid/, message);
    assert.match(message, /gp_project_list/, message);
    assert.match(message, /Do not hand-edit/, message);
    assert.equal(fs.readFileSync(reg.filePath).toString("utf8"), damaged.toString("utf8"),
      "the refusal left the damaged entry exactly where it was");

    // The repair it promises really works: clearing one half is accepted, so this module can
    // put back the entry it just refused to publish over.
    const repaired = projectSet({ projectId: created.projectId, displayName: "Renamed", pid: null });
    assert.equal(repaired.displayName, "Renamed");
    assert.equal(repaired.bundleId, "com.example.both", "the identity that was kept stays the stored one");
    assert.equal("pid" in repaired, false, "the cleared half is gone, not null");
    const after = JSON.parse(fs.readFileSync(reg.filePath, "utf8"));
    assert.deepEqual(Object.keys(after[0]).sort(), ["bundleId", "createdAt", "displayName", "projectId"]);
  } finally {
    reg.dispose();
  }
});

test("the caller-created cases keep the wording that tells them which field to null", () => {
  const reg = useRegistry();
  try {
    // A create that names both halves is the caller's own doing, so `GP_E_BAD_PARAMS` and
    // the sentence that says what to change — pinned as the exact text it has always been.
    const both = expectRegistryError(
      () => projectSet({ displayName: "Both", bundleId: "com.example.both", pid: 4242 }),
      GP_E_BAD_PARAMS,
      "create with two identities",
    );
    assert.match(both, /^bundleId \(com\.example\.both\) and pid \(4242\) are both set on projectId prj_[0-9A-HJKMNP-TV-Z]{26} — /);
    assert.ok(both.endsWith(
      "exactly one of bundleId or pid may identify the app. Pass null for the one to drop "
      + "(bundleId: null keeps pid, pid: null keeps bundleId); omitting a field keeps whatever is already stored.",
    ), `the caller-created wording drifted: ${both}`);
    assert.equal(fs.existsSync(reg.filePath), false, "a refused identity never creates the registry");

    // An update that *adds* the second identity to a legal single-identity entry is still
    // this call's collision: one half came from the store, but the store was legal.
    const created = projectSet(ALPHA);
    const merged = expectRegistryError(
      () => projectSet({ projectId: created.projectId, displayName: "Alpha", pid: 4242 }),
      GP_E_BAD_PARAMS,
      "update adding a second identity to a legal entry",
    );
    assert.match(merged, /bundleId \(com\.example\.alpha\) and pid \(4242\) are both set/, merged);
    assert.match(merged, /Pass null for the one to drop/, merged);
    assert.equal(merged.includes("already stored two identities"), false,
      `a legal store must not be blamed for what this call did: ${merged}`);
  } finally {
    reg.dispose();
  }
});

/* ------------------------------------------------------------------ *
 * The shipped comment may describe a home, it may not name one
 * ------------------------------------------------------------------ */

test("the shipped source documents the two home lookups without naming the author's home", () => {
  // `scripts/make-release-archive.mjs:57-63` states the rule for what travels in the release
  // archive this package is packed into: "a release archive should not be the delivery
  // mechanism for whoever built it". `project-registry.ts` ships as `dist/*.js` plus
  // `dist/*.d.ts`, and its `systemHome()` note carried the developer's real home as the
  // measured example. REVERT THAT REDDENS THIS: put that literal back.
  const source = fs.readFileSync(REGISTRY_SOURCE, "utf8");
  const realHome = os.userInfo().homedir;
  assert.ok(realHome.startsWith("/"), `premise: the record's home is a path, got ${realHome}`);
  assert.equal(source.includes(realHome), false,
    `the account that built this package is named in a shipped file (${realHome})`);
  // The example survives as an example: the measurement, both lookups and the fact that they
  // disagree are still documented, so this cannot be satisfied by deleting the note.
  assert.match(source, /HOME=\/tmp\/fake-sbx-home node -e/, "the measured command has to stay");
  assert.match(source, /os\.homedir\(\), "\|", os\.userInfo\(\)\.homedir/, "both halves of the measurement stay");
  assert.match(source, /-> \/tmp\/fake-sbx-home \| \/Users\/<account>/,
    "the output shape stays, with the home written as a placeholder");
  assert.match(source, /a release archive should not be the/,
    "and the reason for the placeholder is on the page");
  assert.match(source, /delivery mechanism for whoever built it/, "the rule from scripts/make-release-archive.mjs is quoted, not paraphrased");
  assert.match(source, /function systemHome\(\)/, "the lookup this note is about is still here");
});
