import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectSet, ProjectRegistryError, AGENT_PATH_PROTECTION } from "../dist/project-registry.js";

/**
 * J: the same registered path was judged by two validators that did not agree,
 * and the one that *writes* `projects.json` (this shell) was the looser side for
 * `/usr`, `/bin`, `/sbin`, `/dev`, `/private/tmp` and `/private/var/tmp`, while
 * the daemon was the looser side for `/Users/Shared`-style ownership cases and
 * for `recipeConfigPath`/`calibrationAssetsPath` content it never checked.
 *
 * A comment saying "keep these in sync" is not a guard, so this file reads the
 * Swift literals out of the daemon's source — the same technique
 * `consumer-consistency.test.mjs` uses for `ParamValidation.swift` — and compares
 * sets. It is a drift detector in both directions: a path added to one side and
 * not the other fails here, with the difference printed rather than implied.
 */

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const DAEMON_SOURCE = path.join(REPO_ROOT, "engine/Sources/GlassPaneEngine/EngineCore.swift");

/** The quoted members of one Swift array literal, by declaration name. */
function swiftArrayLiteral(source, declaration) {
  const pattern = new RegExp(
    `(?:static\\s+)?(?:private\\s+)?let\\s+${declaration}\\s*(?::[^=]*)?=\\s*\\[([^\\]]*)\\]`,
    "s"
  );
  const match = pattern.exec(source);
  assert.ok(
    match,
    `the daemon source no longer declares \`${declaration}\` as a readable array literal — ` +
    "either the rule moved (update this test to the new home and say why) or it was deleted " +
    "(then this shell must stop claiming the union it no longer implements)"
  );
  return [...match[1].matchAll(/"([^"]+)"/g)].map((one) => one[1]);
}

test("the daemon's named protected trees are all refused by this shell too", () => {
  const source = fs.readFileSync(DAEMON_SOURCE, "utf8");
  const systemTrees = swiftArrayLiteral(source, "systemOwnedStorageTrees");
  const scratchPaths = swiftArrayLiteral(source, "sharedScratchStoragePaths");
  assert.ok(systemTrees.length >= 4, `parsed ${systemTrees.length} system trees: ${systemTrees}`);
  assert.ok(scratchPaths.length >= 1, `parsed ${scratchPaths.length} scratch paths: ${scratchPaths}`);

  const daemonNamed = [...new Set([...systemTrees, ...scratchPaths])].sort();
  const shellSubtrees = [...new Set(AGENT_PATH_PROTECTION.subtrees)].sort();
  const missingHere = daemonNamed.filter((one) => !shellSubtrees.includes(one));
  const extraHere = shellSubtrees.filter((one) => !daemonNamed.includes(one));
  assert.deepEqual(
    { missingHere, extraHere },
    { missingHere: [], extraHere: [] },
    `path protection drifted between the two implementations.\n` +
      `  refused by the daemon, accepted here: ${missingHere.join(", ") || "none"}\n` +
      `  refused here, unknown to the daemon:  ${extraHere.join(", ") || "none"}`
  );
});

test("the shell's exact-root list stays a superset of what resolution can produce", () => {
  // `/`, `/Users`, `/private`, `/Volumes` are exact matches here but *generalized*
  // rules in Swift (top-level component, `<volume>` at depth 2), so a set
  // equality across the two lists would be a false claim. What must hold is that
  // every exact root this shell refuses is either named by the daemon or a root
  // its generalized rules cover — checked here as containment of the system trees.
  const source = fs.readFileSync(DAEMON_SOURCE, "utf8");
  const daemonNamed = new Set([
    ...swiftArrayLiteral(source, "systemOwnedStorageTrees"),
    ...swiftArrayLiteral(source, "sharedScratchStoragePaths"),
  ]);
  for (const root of AGENT_PATH_PROTECTION.roots) {
    if (root === "/") continue;
    assert.ok(
      daemonNamed.has(root) || ["/Users", "/private", "/Volumes"].includes(root),
      `${root} is refused here with no counterpart rule in the daemon`
    );
  }
});

/**
 * Input-level truth table for the write path. `refused` entries must be rejected
 * by `projectSet`; `accepted` entries must go through. Both directions are
 * asserted: a guard that only ever refuses is as useless as one that never does.
 */
test("projectSet's verdicts match the shared table entry by entry", (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gp-path-table-")), "projects.json");
  process.env.GLASSPANE_PROJECTS_FILE = file;
  t.after(() => {
    delete process.env.GLASSPANE_PROJECTS_FILE;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gp-path-owner-"));
  const base = {
    displayName: "Table",
    bundleId: "com.example.table",
    recipeConfigPath: path.join(scratch, "recipe.json"),
    calibrationAssetsPath: path.join(scratch, "calibration"),
  };

  const refused = [
    "/usr/share/x",
    "/dev/foo",
    "/bin/zzz",
    "/sbin/zzz",
    "/private/tmp/a",
    "/private/var/tmp/a",
    "/tmp/anything/in/here",
    "/etc/ssh",
    "/System/Volumes/Data/Users",
    "/Applications/Notes.app/Contents",
    os.homedir(),
    `${os.homedir()}/Library/Preferences`,
    "/Users/Shared/a",
    "relative/path",
    `${scratch}/../elsewhere`,
  ];
  for (const value of refused) {
    let escaped = false;
    try {
      projectSet({ ...base, evidenceStoragePath: value });
      escaped = true;
    } catch (error) {
      assert.ok(error instanceof ProjectRegistryError, `${value}: wrong error type ${error}`);
      // A refusal that does not say what would be acceptable is a dead end for
      // the agent that reads it, so the table requires the remedy-shaped half of
      // the message too — not just "some error came out".
      assert.ok(
        error.message.includes(`(given: "${value}")`),
        `${value}: the caller's own string must stay visible: ${error.message}`,
      );
      assert.match(
        error.message,
        /An acceptable value is a project-owned directory/,
        `${value}: refusal must name an acceptable shape: ${error.message}`,
      );
    }
    assert.ok(!escaped, `${value} was ACCEPTED as a storage path — the shared table refuses it`);
  }

  // A caller-owned directory that is not shared scratch and not inside a
  // protected tree: the one shape the product is for, so it must still pass.
  const acceptedPath = path.join(scratch, "evidence");
  const accepted = projectSet({ ...base, evidenceStoragePath: acceptedPath });
  assert.equal(accepted.evidenceStoragePath, acceptedPath);
  assert.ok(fs.existsSync(file), "the accepted case must actually have written the registry");
});
