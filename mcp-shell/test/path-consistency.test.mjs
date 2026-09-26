import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { projectSet, ProjectRegistryError, AGENT_PATH_PROTECTION } from "../dist/project-registry.js";
import { executableSource } from "./support/source.mjs";
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
 * read as "the two sides agree": most checks below compare *which paths are
 * named*, which cannot see *how a named path is matched*. That gap used to be a
 * live split — the shell treated `/tmp`, `/private/tmp` and `/private/var/tmp` as
 * subtrees (`PROTECTED_SUBTREES`, src/project-registry.ts) while the daemon
 * compared `sharedScratchStoragePaths` by exact equality, so `/private/tmp/x` was
 * refused here and accepted there. It was registered in the header of this file
 * and in `specs/GlassPane_规格修订_2026-09-23_iterate-round4.md`, and it is closed
 * (ba07b66): the daemon now subtree-matches both lists and has an ownership
 * fallback. The closing is not taken on anyone's word — the last test below reads
 * the matching semantics out of `EngineCore.swift` and fails if the `hasPrefix`
 * branches or `ownabilityDefect` ever go back to comparing a whole path, which is
 * the form that let one level below a protected directory through.
 *
 * Historical note (R7-低9): those `hasPrefix` checks were first written as a
 * byte-for-byte glyph (a regex of the exact `for … where … hasPrefix(x + "/")`
 * spelling). That failed the real test — it did not actually pin "a child of a
 * protected directory is refused", it pinned one *way of writing it*, so an
 * equivalent refactor (renaming the loop variable, splitting the `||`, reflowing)
 * would have turned the gate red for no reason. They are now semantic: a loop over
 * each protected list must reach a `.hasPrefix(` subtree primitive in its guard,
 * whatever the operand order, names, or whitespace; and the `.contains(` equality
 * form is banned for both lists, not just the one it once hid behind.
 *
 * What remains out of reach here: this file still cannot execute the daemon, so
 * the *behaviour* it proves is the shell's (the input-level subtree entries in the
 * truth table at the bottom) and the daemon's is read as source. A semantic change
 * written in an unexpected place in Swift is caught by the assertion that the
 * quoted text exists, not by inference.
 *
 * J-中4 closed here, in the same spirit: the truth table used to carry the
 * protected-tree rows as *hand-copied names* — five rows against a daemon
 * manifest of eleven members. The set comparison above could then never see the
 * difference, because it compares *names*, and a member nobody typed into the
 * table is simply never executed at the behaviour level. The rows now come out of
 * the two Swift declarations and out of the shell's own refusal wording, so the
 * table grows with the manifest instead of with someone's memory of it, and
 * `the truth table exercises one row per member…` below pins that it did.
 */

const REPO_ROOT = new URL("../../", import.meta.url).pathname;
const DAEMON_SOURCE = path.join(REPO_ROOT, "engine/Sources/GlassPaneEngine/EngineCore.swift");
const SHELL_REGISTRY_SOURCE = path.join(REPO_ROOT, "mcp-shell/src/project-registry.ts");
const SWIFT_STATE_ROOT_SOURCE = path.join(REPO_ROOT, "engine/Sources/GlassPaneEngine/StateRoot.swift");
const SWIFT_REGISTRY_SOURCE = path.join(REPO_ROOT, "engine/Sources/GlassPaneEngine/ProjectRegistry.swift");

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

/**
 * The body of the block whose `{` sits at `openBrace`, brace-balanced. Hand-rolled
 * because the braces inside a template literal's `${…}` are balanced too, so a
 * plain non-greedy `\}` would stop in the middle of the very phrase being read.
 */
function blockBody(source, openBrace) {
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, i);
    }
  }
  assert.fail("unbalanced braces from this point on, so the block cannot be read: " +
    `${JSON.stringify(source.slice(openBrace, openBrace + 120))}`);
}

/**
 * The daemon's two storage manifests as one ordered list.
 *
 * Swift declares them separately (`systemOwnedStorageTrees` and
 * `sharedScratchStoragePaths`), and the shell folds both into a single
 * `PROTECTED_SUBTREES` loop that reports both with the *same* phrase — measured,
 * not remembered: `/private/tmp/x` answers `inside the system-owned tree
 * /private/tmp`, exactly like `/usr/x`, even though the daemon calls the first
 * one "the world-writable shared scratch directory". So the table walks the
 * concatenation and one member listed in both declarations earns two rows.
 */
function daemonStorageManifest(source) {
  const systemTrees = swiftArrayLiteral(source, "systemOwnedStorageTrees");
  const scratchPaths = swiftArrayLiteral(source, "sharedScratchStoragePaths");
  assert.ok(systemTrees.length >= 4, `parsed ${systemTrees.length} system trees: ${systemTrees}`);
  assert.ok(scratchPaths.length >= 1, `parsed ${scratchPaths.length} scratch paths: ${scratchPaths}`);
  return [
    ...systemTrees.map((literal) => ({ literal, declaration: "systemOwnedStorageTrees" })),
    ...scratchPaths.map((literal) => ({ literal, declaration: "sharedScratchStoragePaths" })),
  ];
}

/**
 * The shell's wording for "this location is inside a protected tree", read out of
 * the body of the `for (const tree of PROTECTED_SUBTREES)` loop in
 * `refuseCandidate` instead of typed into this file, and returned as a function of
 * the tree that matched.
 *
 * Two reasons it is read rather than written here. (1) The table's whole job is to
 * say *which rule* reaches a path; a phrase quoted from memory keeps passing after
 * the rule that emits it is replaced by another one that happens to use the same
 * words, and it goes red for no reason when the wording is improved. (2) Reading
 * it from inside that loop, and only from inside it, is what stops the table
 * crediting a row to the ownership fallback — the fallback also refuses, but with
 * a fixable-sounding reason, and a table that accepted it would not notice a
 * subtree rule being deleted.
 */
function shellSubtreePhrase(shellSource) {
  const loop = /for\s*\(\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s+of\s+PROTECTED_SUBTREES\s*\)\s*\{/.exec(
    shellSource
  );
  assert.ok(
    loop,
    "project-registry.ts no longer refuses protected trees from a `for (const … of " +
    "PROTECTED_SUBTREES)` loop, so nothing here can say what the truth table's " +
    "protected-tree rows are supposed to be refused *by* — point this at the rule's new " +
    "home and say which phrase it reports",
  );
  const loopVariable = loop[1];
  const body = blockBody(shellSource, shellSource.indexOf("{", loop.index + loop[0].length - 1));
  const phrasings = [...body.matchAll(/`([^`\n]*)`/g)]
    .map((one) => one[1])
    .filter((one) => new RegExp(`\\$\\{\\s*${loopVariable}\\s*\\}`).test(one));
  assert.equal(
    phrasings.length,
    1,
    `the protected-tree loop must report exactly one phrase that names the tree it matched ` +
    `(found ${phrasings.length}: ${JSON.stringify(phrasings)}). Zero means the tree name left the ` +
    `message, and the table could no longer tell which member refused a row; more than one means a ` +
    `second shape joined the loop, and this table has to grow rows for it on purpose`,
  );
  assert.match(
    body,
    /return/,
    "the protected-tree loop no longer returns a refusal, so matching it does not refuse anything " +
    "and every generated row below would be a claim about a rule that is not wired up",
  );
  const template = phrasings[0];
  return (tree) => template.replace(new RegExp(`\\$\\{\\s*${loopVariable}\\s*\\}`), tree);
}

/** The child segment of every generated row: two components deep, so the row
 *  reaches the subtree loop rather than the exact-root or the single-component
 *  rule, and a name that is not a real directory anywhere. */
const MANIFEST_CHILD = "gp-daemon-manifest-probe";

/**
 * One refused-table row per member of either daemon manifest.
 *
 * `becauseAnyOf` is the realpath widening the task asks for, and it is applied per
 * member by measurement rather than by a class of rows. `realpath` maps `/tmp`
 * onto `/private/tmp` on this OS, so the row generated for `/tmp` is refused with
 * the *twin's* name: the shell judges the resolved location first (see
 * `strongestRefusal`, whose resolved target outranks the given one), which is the
 * right product behaviour and the wrong thing to hard-code as a platform fact. So
 * for a member whose location moves under `realpath` the row requires "refused, by
 * the protected-tree rule, naming a tree that actually covers where the probe
 * landed" and nothing looser — the verdict and the rule are still both asserted,
 * only the spelling of the matched tree is allowed to be the canonical one.
 *
 * The accepted spellings are computed as **every manifest member that is an
 * ancestor of either the literal path or its realpath**, not as a per-item alias
 * list. That difference is what CI caught on 2026-09-26: the row generated for
 * `/bin` was given `["/bin", "/usr/bin"]` (the literal plus its realpath) while
 * both macOS (`/bin` → `/usr/bin`) and the ubuntu runner resolve the probe to
 * `/usr/bin/<probe>`, which the shell correctly refuses as being inside the tree
 * **`/usr`** — a manifest member nobody listed as an alias of `/bin`. An alias
 * list is a platform fact wearing a derived name; the covering relation is the
 * rule the shell actually applies, so it is what the row allows, and it still
 * rejects an ownership-only refusal or a tree that covers nothing.
 *
 * Computed from `fs.realpathSync` on every run, so it tightens back to a single
 * expected phrase by itself the day a member stops being a twin. A member that
 * does not exist on the machine running this suite gets no widening at all:
 * `realpathSync` throws, the row keeps its literal-only expectation, and the shell
 * answers it from the ownership fallback, which this row reports as red rather
 * than skipping.
 */
function manifestRefusalRows(manifest, phrase, realpathOf = (target) => fs.realpathSync(target)) {
  const literals = [...new Set(manifest.map((member) => member.literal))];
  const covers = (tree, target) => target === tree || target.startsWith(`${tree}/`);
  return manifest.map((member) => {
    let real = null;
    try {
      real = realpathOf(member.literal);
    } catch {
      real = null;
    }
    // The locations this row's probe can be judged at: what the caller wrote, and
    // where the filesystem says that actually is. Either may be the one the shell
    // matched, and the manifest member that covers it is the rule behind the word.
    const locations = real === null || real === member.literal
      ? [member.literal]
      : [member.literal, real];
    const matchedTrees = literals.filter((tree) =>
      locations.some((location) => covers(tree, `${location}/${MANIFEST_CHILD}`)));
    return {
      ...member,
      value: `${member.literal}/${MANIFEST_CHILD}`,
      because: phrase(member.literal),
      // Unreachable by construction, and kept as a guard rather than advertised as
      // a red direction: a member always covers its own child, so `matchedTrees`
      // holds at least the member itself. If `covers()` ever stops being
      // reflexive this fallback is what keeps the row asserting *something*; the
      // red paths that do exist are the derived ones below (a tree that covers
      // nothing is not accepted, and an unresolvable member keeps its literal).
      becauseAnyOf: (matchedTrees.length > 0 ? matchedTrees : [member.literal]).map(phrase),
    };
  });
}

/** The table's protected-tree rows, generated from both sides' sources. */
function generatedManifestRows() {
  return manifestRefusalRows(
    daemonStorageManifest(fs.readFileSync(DAEMON_SOURCE, "utf8")),
    shellSubtreePhrase(executableSource(fs.readFileSync(SHELL_REGISTRY_SOURCE, "utf8"))),
  );
}

test("the truth table exercises one row per member of either daemon manifest", () => {
  // The right-hand side is the raw parse of the two Swift declarations, re-read
  // here rather than taken from the generator, and the left-hand side is the
  // number of rows the table will actually execute. That is what makes it a
  // measurement and not a constant: this file used to carry five hand-copied
  // tree names against a manifest of eleven, and an assertion written against a
  // typed-in `11` would have been the same hand copy in a new place. Anything
  // that makes the executed table shorter than the manifest — a re-typed list, a
  // `filter`, a `continue`, a de-dup of the two declarations — lands on the left
  // and goes red here, while a member listed in both declarations still earns
  // both rows.
  const source = fs.readFileSync(DAEMON_SOURCE, "utf8");
  const rows = generatedManifestRows();
  const manifestSize = swiftArrayLiteral(source, "systemOwnedStorageTrees").length
    + swiftArrayLiteral(source, "sharedScratchStoragePaths").length;
  assert.equal(
    rows.length,
    manifestSize,
    `the table runs ${rows.length} protected-tree rows against ${manifestSize} manifest members ` +
    `(${rows.map((row) => row.value).join(", ")}). Every member of either Swift declaration has ` +
    `to be refused by a row here, or it is a name the set comparison can match while nothing ` +
    `executes it`,
  );

  // The ring the row count alone cannot close. The rows are generated from Swift,
  // so a member *deleted* from Swift would shrink this table and still satisfy the
  // count above; what catches it is that this shell keeps protecting the tree and
  // no row is decided by it any more — the exact asymmetry that made the hand-copied
  // table useless. Together with the set comparison at the top of the file (Swift
  // names vs. the shell's list) the three agree or two of the three go red.
  const exercised = rows.map((row) => row.literal);
  const shellProtected = [...new Set(AGENT_PATH_PROTECTION.subtrees)];
  const unexercised = shellProtected.filter((tree) => !exercised.includes(tree));
  const unbacked = [...new Set(exercised)].filter((tree) => !shellProtected.includes(tree));
  assert.deepEqual(
    { unexercised, unbacked },
    { unexercised: [], unbacked: [] },
    `the table and the two lists it stands between disagree ` +
      `(${exercised.length} generated rows vs ${shellProtected.length} trees protected here).\n` +
      `  protected here, exercised by no row: ${unexercised.join(", ") || "none"} — that member ` +
      `left \`systemOwnedStorageTrees\`/\`sharedScratchStoragePaths\` while this shell still refuses ` +
      `it, so the behaviour half of this file no longer covers it\n` +
      `  a row with no subtree rule behind it: ${unbacked.join(", ") || "none"} — the daemon names ` +
      `it but \`PROTECTED_SUBTREES\` does not, so its row can only be refused by the ownership ` +
      `fallback, which is a different rule with a different remedy`,
  );
});

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
 * by the real judgement function. Its protected-tree half is generated from the
 * daemon's manifests (see `generatedManifestRows`) rather than copied from them,
 * which is what lets it say anything about members nobody remembered to type.
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
  //
  // The protected-tree rows are not typed below any more: `generatedManifestRows`
  // builds one row per member of the daemon's two Swift declarations, with the
  // `because` read out of the shell's own subtree loop. What stays hand-written is
  // only what no manifest can generate — a verdict the live filesystem decides, or
  // one this shell reaches by a rule that is not a tree name.
  const refused = [
    ...generatedManifestRows(),
    // Not on either Swift list: refused because the nearest existing directory
    // belongs to somebody else, so the verdict is pinned and the reason is not.
    { value: "/etc/ssh", because: null },
    { value: "/System/Volumes/Data/Users", because: "a protected system root" },
    // The two home entries read the passwd record, the same source the rule
    // itself uses (see the gate at the bottom of this file): `os.homedir()`
    // would follow `$HOME`, so a suite run with an overridden `$HOME` would
    // assert the wrong directory and let the real home be registered.
    { value: os.userInfo().homedir, because: "the current user's home directory" },
    { value: `${os.userInfo().homedir}/Library/Preferences`, because: "inside the current user's Library folder" },
    { value: "/Users/Shared/a", because: null },
    { value: "relative/path", because: "must be an absolute path" },
    { value: `${scratch}/../elsewhere`, because: 'must not contain "." or ".." components' },
  ];
  for (const { value, because, becauseAnyOf, literal, declaration } of refused) {
    const origin = declaration === undefined ? "" : ` (row generated for ${declaration}: ${literal})`;
    let escaped = false;
    let message = null;
    try {
      projectSet({ ...base, evidenceStoragePath: value });
      escaped = true;
    } catch (error) {
      assert.ok(error instanceof ProjectRegistryError, `${value}: wrong error type ${error}`);
      message = error.message;
      // A refusal that does not say what would be acceptable is a dead end for
      // the agent that reads it, so the table requires the remedy-shaped half of
      // the message too — not just "some error came out".
      assert.ok(
        message.includes(`(given: "${value}")`),
        `${value}: the caller's own string must stay visible: ${message}`,
      );
      assert.match(
        message,
        /An acceptable value is a project-owned directory/,
        `${value}: refusal must name an acceptable shape: ${message}`,
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
        // `becauseAnyOf` is the per-member realpath widening documented on
        // `manifestRefusalRows`; every other row carries the one phrase, so what
        // is required is still *this rule, naming this tree*, never "some error".
        const expected = becauseAnyOf ?? [because];
        assert.ok(
          expected.some((one) => message.includes(one)),
          `${value}: refused, but not by the rule the table says refuses it${origin} ` +
          `(expected one of ${JSON.stringify(expected)}): ${message}`,
        );
      }
    }
    assert.ok(
      !escaped,
      `${value} was ACCEPTED as a storage path${origin} — the shared table refuses it. When the row ` +
      `came from the daemon's manifest this is the split in its rawest form: the daemon names a ` +
      `location this shell registers`,
    );
  }

  // A caller-owned directory that is not shared scratch and not inside a
  // protected tree: the one shape the product is for, so it must still pass.
  const acceptedPath = path.join(scratch, "evidence");
  const accepted = projectSet({ ...base, evidenceStoragePath: acceptedPath });
  assert.equal(accepted.evidenceStoragePath, acceptedPath);
  assert.ok(fs.existsSync(file), "the accepted case must actually have written the registry");
});

/**
 * R6-03: the matching semantics, read out of the daemon.
 *
 * The two sides used to name the same paths and disagree about what "inside"
 * means: this shell refused `/private/tmp/x` because it matches shared scratch as
 * a subtree, while the daemon compared the whole path against the list and took
 * the child as somebody else's directory. The header of this file carried that as
 * a registered split with a stated removal condition; the split is closed, so the
 * caveat becomes a control. It has to be able to go red the way the defect came
 * back — by someone writing `contains(stripped)` again — which is why the last
 * assertion is the negative one.
 */
test("the daemon matches protected storage as subtrees and falls back to ownership", () => {
  const source = fs.readFileSync(DAEMON_SOURCE, "utf8");
  const declaration = "static func resolvedStoragePathDefect";
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} moved: point this check at its new home and say why`);
  const next = source.indexOf("static func", start + declaration.length);
  const raw = next === -1 ? source.slice(start) : source.slice(start, next);
  // Comments stripped for the checks below, which is the *opposite* of what the
  // Swift-side isolation gate does with its own tree — and for the opposite
  // reason. There, prose has to count so a violation cannot hide behind a `//`;
  // here the function's own comment quotes the equality form it replaced, so
  // matching prose would report the fixed shape as present forever.
  const body = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  for (const list of ["sharedScratchStoragePaths", "systemOwnedStorageTrees"]) {
    // Semantic, not a glyph. The old check pinned the exact spelling
    // `for x in <list> where y == z || y.hasPrefix(z + "/")`, so an equivalent
    // refactor — renaming the loop variable, splitting the `||`, hoisting the
    // `list + "/"` prefix, or reflowing onto more lines — turned the gate red
    // even though subtree semantics were intact (R7-低9). The semantic contract
    // this must survive is narrower and stricter: the loop that iterates `<list>`
    // has to reach a subtree primitive (`.hasPrefix(`) inside its guard, whatever
    // the operand order, names, or whitespace. If subtree matching dies and the
    // list is matched by whole-path equality only, `.hasPrefix(` leaves the guard
    // and this goes red.
    const subtree = new RegExp(
      `for\\s+[A-Za-z_][A-Za-z0-9_]*\\s+in\\s+${list}\\s+[^{]*?hasPrefix\\(`
    );
    assert.match(
      body.replace(/\s+/g, " "),
      subtree,
      `${list} is no longer subtree-matched: a path one level below it is accepted by the daemon ` +
        `and refused here, which is the split this check exists to keep shut`,
    );
  }

  // The ownership fallback: TS has refused a world-writable or foreign-owned
  // directory since the round that unified the lists; the daemon gained it in
  // ba07b66, wired at the tail of the evidence-path check rather than as a name.
  assert.match(source, /static func ownabilityDefect\(path: String\)/, "ownabilityDefect is gone");
  assert.match(
    source.replace(/\s+/g, " "),
    /evidenceStoragePathDefect[\s\S]{0,900}?ownabilityDefect\(path:/,
    "the ownership fallback is no longer reached from the evidence-path check",
  );

  // Negative half, and the one that would actually catch a regression: the
  // equality form is what made a child of `/tmp` admissible. Checked for *both*
  // protected lists so a `systemOwnedStorageTrees.contains(...)` sneaking back
  // is no quieter than the shared-scratch one it once hid behind.
  assert.doesNotMatch(
    body,
    /(?:sharedScratchStoragePaths|systemOwnedStorageTrees)\s*\.contains\(/,
    "exact-equality matching is back in resolvedStoragePathDefect",
  );
});

/**
 * X-22's other half: the two processes must agree on *which* home the state
 * lives under, not merely on what is inside it.
 *
 * `StateRoot.homeDefault()` is `NSHomeDirectory() + "/.glasspane"` and does not
 * consult `$HOME` (its own header records the data loss that came from assuming
 * otherwise). `os.homedir()` *does* consult `$HOME`; `os.userInfo().homedir`
 * reads the passwd record and does not, which is the same semantics Swift gets.
 * Measured on this machine:
 *
 *   HOME=/tmp/fake-sbx-home node -e '…os.homedir()…os.userInfo().homedir…'
 *   -> /tmp/fake-sbx-home | /Users/ethanlin
 *
 * Before this gate, `project-registry.ts` used `$HOME` in two places — the file
 * the daemon loads, and the home-directory protection — so exporting one
 * variable moved both halves off the real user's tree while the daemon kept
 * serving it. The two sides are now locked together here: this shell may not
 * call the `$HOME`-following lookup, and the daemon's root must still be the
 * `NSHomeDirectory()` one. A "fix" on either side that changes the semantics
 * turns this red, which is the point.
 */
test("the shell derives the daemon's home, not its own $HOME", () => {
  const shell = executableSource(fs.readFileSync(SHELL_REGISTRY_SOURCE, "utf8"));

  // Sanity on the strip itself, before any ban is credited with a pass. A stray
  // block-comment opener in a string would swallow everything up to the next
  // `*/`, and a file stripped down to a fragment satisfies every `doesNotMatch`
  // below on an empty body. So the two ends of the module have to still be here.
  assert.match(
    shell,
    /export function daemonProjectsPath/,
    "the strip took the module's head with it, so the assertions below are matching a fragment",
  );
  assert.match(
    shell,
    /class ProjectRegistryError extends Error/,
    "the strip took the module's tail with it, so the assertions below are matching a fragment",
  );

  assert.doesNotMatch(
    shell,
    /os\.homedir\(/,
    "project-registry.ts has a $HOME-following home lookup again. The daemon's registry path is \
     StateRoot.homeDefault().projectsFile, derived from NSHomeDirectory(), which ignores $HOME — \
     so any HOME override makes the two processes name different directories, and both the \
     \"a write aimed elsewhere\" guard and the home-directory protection go wrong together. \
     Use the module's single systemHome() exit instead.",
  );

  // The positive half: the banned call leaving is not the same as the right one
  // arriving. `os.userInfo().homedir` appears exactly once, in `systemHome()`, so
  // a third inline lookup is caught as drift rather than silently accepted.
  const lookups = shell.match(/os\.userInfo\(\)\.homedir/g) ?? [];
  assert.equal(
    lookups.length,
    1,
    `the passwd-based home lookup must be written once, inside the single exit \`systemHome()\` \
     (found ${lookups.length}). Zero means the lookup moved — point this gate at its new home and \
     say why; more than one means a caller started composing it again, which is how the two \
     halves drifted apart this time`,
  );
  assert.match(
    shell,
    /function\s+systemHome\s*\(/,
    "systemHome() is gone, so the ban above has no replacement to route new callers through",
  );

  const stateRoot = executableSource(fs.readFileSync(SWIFT_STATE_ROOT_SOURCE, "utf8"));
  assert.match(
    stateRoot,
    /NSHomeDirectory\(\)/,
    "StateRoot.swift no longer derives its default root from NSHomeDirectory() in *code* — the \
     match is against comment-stripped source, so prose about it cannot satisfy this. The daemon's \
     home semantics moved; re-derive what this shell's systemHome() has to mirror and change both \
     sides together",
  );
  assert.doesNotMatch(
    stateRoot,
    /environment\s*\[\s*"HOME"\s*\]|getenv\(\s*"HOME"/,
    "StateRoot now reads $HOME: that re-opens the same split from the other side — a HOME override \
     would move the daemon's root while this shell keeps naming the passwd home (or the reverse)",
  );

  // The chain that makes the first assertion mean anything: the daemon's
  // projects.json really is the homeDefault-derived file this shell compares to.
  const registry = executableSource(fs.readFileSync(SWIFT_REGISTRY_SOURCE, "utf8"));
  assert.match(
    registry,
    /defaultProjectsPath\s*=\s*StateRoot\.homeDefault\(\)\.projectsFile/,
    "ProjectRegistry.defaultProjectsPath is no longer StateRoot.homeDefault().projectsFile, so \
     daemonProjectsPath() in this shell is mirroring a path the daemon does not use",
  );
});

test("the manifest rows accept the tree that covers the resolved location, and only those", () => {
  // `manifestRefusalRows` is the one place that decides which wording counts as
  // "refused by the right rule", and the case that broke on CI (a `/bin` probe the
  // filesystem reports under `/usr/bin`, refused as inside `/usr`) cannot be
  // reproduced on the machine that wrote it. So the rule is exercised against a
  // synthetic manifest with an injected realpath instead of hoping the next OS
  // behaves: covering is derived from the lists, never from an alias table.
  const synthetic = [
    { literal: "/bin", declaration: "systemOwnedStorageTrees" },
    { literal: "/usr", declaration: "systemOwnedStorageTrees" },
    { literal: "/quux", declaration: "sharedScratchStoragePaths" },
  ];
  const phraseOf = (tree) => `inside the system-owned tree ${tree}`;
  const rows = manifestRefusalRows(synthetic, phraseOf, (target) =>
    target === "/bin" ? "/usr/bin" : target);

  const bin = rows.find((row) => row.literal === "/bin");
  assert.deepEqual(bin.becauseAnyOf.sort(), [phraseOf("/bin"), phraseOf("/usr")].sort(),
    `a /bin probe that resolves under /usr/bin must be allowed to be refused as inside either: ${bin.becauseAnyOf}`);
  assert.ok(!bin.becauseAnyOf.includes(phraseOf("/quux")),
    "covering is a path relation, not a set of anything-goes strings");
  assert.equal(bin.value, "/bin/gp-daemon-manifest-probe", "the row still probes the Swift literal");

  // The red direction: a member whose own child is covered by nobody keeps the
  // literal-only expectation, so a shell that stopped matching it reports red
  // instead of being handed a looser phrase list.
  const orphan = manifestRefusalRows(
    [{ literal: "/zzz", declaration: "systemOwnedStorageTrees" }], phraseOf, () => { throw new Error("no such path"); },
  )[0];
  assert.deepEqual(orphan.becauseAnyOf, [phraseOf("/zzz")]);
  assert.ok(manifestRefusalRows(synthetic, phraseOf, (t) => t).find((row) => row.literal === "/bin")
    .becauseAnyOf.every((one) => one === phraseOf("/bin")),
    "without a moving realpath the row must tighten back to its own literal");
});
