import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectSet, ProjectRegistryError, AGENT_PATH_PROTECTION } from "../dist/project-registry.js";
import { privateSandbox } from "./support/sandbox.mjs";

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
 *
 * WHAT THIS FILE DOES NOT COVER, stated because a green run here is otherwise
 * read as "the two sides agree": every check below compares *which paths are
 * named*. It cannot see *how a named path is matched*, and the two sides match
 * identical names differently today:
 * - this shell treats `/tmp`, `/private/tmp` and `/private/var/tmp` as
 *   **subtrees**, so `/private/tmp/x` is refused
 *   (`PROTECTED_SUBTREES`, src/project-registry.ts);
 * - the daemon compares `sharedScratchStoragePaths` by **exact equality**
 *   (`EngineCore.resolvedStoragePathDefect`, the `sharedScratchStoragePaths
 *   contains stripped` branch — no `hasPrefix` beside it, and no ownership
 *   fallback in Swift either), so `/private/tmp/x` is accepted there.
 * Same list, two verdicts: the set comparisons below would not notice, and the
 * split is therefore *registered* rather than implied — it is the "仍未收口"
 * entry of `specs/GlassPane_规格修订_2026-09-23_iterate-round4.md` (the Swift
 * half of path validation), and the one who closes it is whoever holds
 * `EngineCore.swift`. This file does not touch Swift and does not pretend a
 * list comparison settled the semantics.
 *
 * What is pinned here instead, and how to tell when the caveat goes stale: the
 * TS side's *behaviour* is proven by the input-level subtree entries in the
 * truth table at the bottom of this file (they fail the moment this shell stops
 * treating shared scratch as a tree), and the daemon's exact-match branch is
 * quoted above rather than paraphrased. When that quote no longer matches the
 * Swift source, the split is closed: delete this caveat, and the set comparison
 * then does say what it looks like it says.
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
  // List equality only — see the file header. This proves neither side names a
  // path the other has never heard of; it says nothing about whether the two
  // matchers reach the same verdict for a path *inside* one of those names, and
  // for the shared-scratch trio they currently do not.
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

/**
 * The daemon's *generalized* location rules, read out of the body of
 * `EngineCore.resolvedStoragePathDefect` rather than taken on trust: the shapes
 * it refuses without naming them. Each entry is a condition this test can look
 * for in the Swift source plus the coverage it grants a path of that shape.
 *
 * Whitespace inside the extracted body is collapsed, so a re-format is not
 * mistaken for a removed rule, and `covers` is a shape test rather than a name
 * list: whether a root may rest on one of these rules has to be derived from
 * the path, and whether the rule exists has to be derived from the source.
 */
const DAEMON_GENERALIZED_RULES = [
  {
    label: "the filesystem root",
    // Swift: `if components.isEmpty { … }`
    probe: /components\s*\.\s*isEmpty/,
    covers: (components) => components.length === 0,
  },
  {
    label: "any top-level directory of the boot volume",
    // Swift: `if components.count == 1 { … }`
    probe: /components\s*\.\s*count\s*==\s*1/,
    covers: (components) => components.length === 1,
  },
  {
    label: "the root of a mounted volume, `/Volumes/<name>`",
    // Swift: `if components[0] == "Volumes", components.count == 2 { … }`
    probe: /components\s*\[\s*0\s*\]\s*==\s*"Volumes"/,
    companion: /components\s*\.\s*count\s*==\s*2/,
    covers: (components) => components[0] === "Volumes" && components.length === 2,
  },
];

/**
 * Which of the daemon's generalized rules this file may lean on, as measured
 * against its source: `found` are present in `resolvedStoragePathDefect`,
 * `absent` are not. A rule that went missing is not silently treated as not
 * covering — the test below reports it per root, because "the branch died" and
 * "this shape was never covered" have different fixes.
 */
function daemonGeneralizedRules(source) {
  const declaration = "static func resolvedStoragePathDefect";
  const start = source.indexOf(declaration);
  assert.ok(
    start !== -1,
    "the daemon no longer defines `resolvedStoragePathDefect`, so nothing here can say which " +
    "shapes it covers generically — point this test at the rule's new home and say why " +
    "(a root previously excused by inference must not keep passing on the strength of a guess)",
  );
  const next = source.indexOf("static func", start + declaration.length);
  const body = (next === -1 ? source.slice(start) : source.slice(start, next)).replace(/\s+/g, " ");
  const found = [];
  const absent = [];
  for (const rule of DAEMON_GENERALIZED_RULES) {
    const present = rule.probe.test(body)
      && (rule.companion === undefined || rule.companion.test(body));
    (present ? found : absent).push(rule);
  }
  return { found, absent };
}

test("the shell's exact roots are each named by the daemon or covered by one of its generalized rules", () => {
  // `/`, `/Users`, `/private`, `/Volumes` are exact matches here but *generalized*
  // rules in Swift (the filesystem root, the top-level-component rule,
  // `<volume>` at depth 2), so a set equality across the two lists would be a
  // false claim. What must hold is that every exact root this shell refuses is
  // either named by the daemon literally *or* a shape one of the daemon's
  // generalized rules covers — and which of the two, plus the rule that did it,
  // is printed in the assertion message instead of being left to the reader.
  const source = fs.readFileSync(DAEMON_SOURCE, "utf8");
  const daemonNamed = [...new Set([
    ...swiftArrayLiteral(source, "systemOwnedStorageTrees"),
    ...swiftArrayLiteral(source, "sharedScratchStoragePaths"),
  ])].sort();
  const { found, absent } = daemonGeneralizedRules(source);

  for (const root of AGENT_PATH_PROTECTION.roots) {
    const components = root.split("/").filter((one) => one !== "");
    const covering = found.filter((rule) => rule.covers(components));
    const lost = absent.filter((rule) => rule.covers(components));
    // The reason a root may be excused without being one of the daemon's
    // literals, spelled out for every one of the four (`/` = no component at
    // all, `/Users` and `/private` = a single top-level component, `/Volumes` =
    // a volume root, which the daemon also reaches at depth 2) and carried into
    // the message below — never a list of names exempted here, and never a
    // `continue`.
    const shape = components.length === 0
      ? "the filesystem root, no components at all"
      : components.length === 1
        ? `a single-component top-level path (/${components[0]})`
        : `${components.length} components, first /${components[0]}`;
    const basis = daemonNamed.includes(root)
      ? "named literally by the daemon"
      : covering.length > 0
        ? `covered by the daemon's generalized rule: ${covering.map((rule) => rule.label).join(", ")}`
        : lost.length > 0
          ? `it would rest on the daemon's ${lost.map((rule) => rule.label).join(", ")} rule, and that branch is no longer in \`resolvedStoragePathDefect\` — the rule moved or died; say which`
          : `no generalized rule of the daemon covers ${shape}`;
    assert.ok(
      daemonNamed.includes(root) || covering.length > 0,
      `${root} is refused here by exact match, and the daemon has no counterpart for it (its ` +
      `literals: ${daemonNamed.join(", ")}). ${root}: ${basis}, ${shape}. Two sides that refuse ` +
      `different sets are the split this file exists to catch, and an exemption here has to name ` +
      `the rule behind it rather than a list written in this test`,
    );
  }
});

/**
 * Input-level truth table for the write path. `refused` entries must be rejected
 * by `projectSet`; `accepted` entries must go through. Both directions are
 * asserted: a guard that only ever refuses is as useless as one that never does.
 *
 * This is also the only place in the file that can speak about *semantics*
 * rather than names: each entry carries the rule that has to reach it, so a
 * path inside a protected subtree is proven to be refused as part of that tree
 * by the real judgement function — the behaviour the daemon's exact-match
 * scratch rule still does not implement.
 */
test("projectSet's verdicts match the shared table entry by entry", (t) => {
  const tableSandbox = privateSandbox("gp-path-table-");
  const file = path.join(tableSandbox.dir, "projects.json");
  process.env.GLASSPANE_PROJECTS_FILE = file;
  t.after(() => {
    delete process.env.GLASSPANE_PROJECTS_FILE;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    tableSandbox.dispose();
  });

  const scratchSandbox = privateSandbox("gp-path-owner-");
  const scratch = scratchSandbox.dir;
  t.after(() => scratchSandbox.dispose());
  const base = {
    displayName: "Table",
    bundleId: "com.example.table",
    recipeConfigPath: path.join(scratch, "recipe.json"),
    calibrationAssetsPath: path.join(scratch, "calibration"),
  };

  // `because` is the half the set comparison cannot express: *which* of this
  // shell's rules reaches the path. Where it is a phrase it is required; where
  // it is null the reason genuinely depends on the live filesystem — the owner
  // and mode of a real directory, or where `realpath` lands `/tmp` on this OS —
  // and the table pins the verdict only rather than hard-coding a platform fact.
  const refused = [
    { value: "/usr/share/x", because: "inside the system-owned tree /usr" },
    { value: "/dev/foo", because: "inside the system-owned tree /dev" },
    { value: "/bin/zzz", because: "inside the system-owned tree /bin" },
    { value: "/sbin/zzz", because: "inside the system-owned tree /sbin" },
    { value: "/private/tmp/a", because: "inside the system-owned tree /private/tmp" },
    // The two paths the daemon currently *accepts* with its exact-match scratch
    // rule (see the file header): refused here as members of a subtree, not as
    // names on a list, which is what `because` pins.
    { value: "/private/tmp/x", because: "inside the system-owned tree" },
    { value: "/tmp/anything/here", because: "inside the system-owned tree" },
    { value: "/private/var/tmp/a", because: "inside the system-owned tree /private/var/tmp" },
    { value: "/etc/ssh", because: null },
    { value: "/System/Volumes/Data/Users", because: "a protected system root" },
    { value: "/Applications/Notes.app/Contents", because: "inside the system-owned tree /Applications" },
    { value: os.homedir(), because: "the current user's home directory" },
    { value: `${os.homedir()}/Library/Preferences`, because: "inside the current user's Library folder" },
    { value: "/Users/Shared/a", because: null },
    { value: "relative/path", because: "must be an absolute path" },
    { value: `${scratch}/../elsewhere`, because: 'must not contain "." or ".." components' },
  ];
  for (const { value, because } of refused) {
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
      if (because === undefined) {
        // An entry with no `because` at all is a hole in the table, not a free
        // pass: `null` is the answer that says "this one cannot be named here",
        // and it has to be given on purpose.
        assert.fail(
          `${value}: every refused entry must state its reason as a phrase or an explicit null ` +
          `(null where the live filesystem decides it) — this one states neither`,
        );
      }
      if (because !== null) {
        assert.ok(
          error.message.includes(because),
          `${value}: refused, but not by the rule the table says refuses it (` +
          `expected "${because}"): ${error.message}`,
        );
      }
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
