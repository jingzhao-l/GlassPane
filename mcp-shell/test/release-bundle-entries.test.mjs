/**
 * The release archive's bundle-shape guard may not hold a hand-copied file list.
 *
 * `scripts/make-release-archive.mjs` refuses a `mcp-shell/dist` that holds a `.js` the
 * bundler does not write, because that is tsc output and its entry points still import
 * `iterate-kernel` — a dependency `glasspane-mcp` declares only at build time, so the installed
 * package dies on `ERR_MODULE_NOT_FOUND` after an install that reported success. What it
 * refused *against* was a `const` in that script listing three entries while
 * `mcp-shell/package.json`'s `bundle` script wrote four, and the guard's own refusal made
 * the tree un-releasable: `dist/stdio-session.js` — the clean library entry the split
 * delivers, packed, installed and exec'd by `test/published-artifact.test.mjs` — was
 * "a file the bundler does not write".
 *
 * So the expected set is derived here from the script that produces it. These gates are
 * the two directions that derivation has to hold: a new bundle entry shows up in the
 * derived list on its own (nothing here names a file), and a script that cannot be read
 * is a refusal rather than an empty list that passes whatever `dist` happens to hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertBundleShape, bundleEntriesFromScript } from "../../scripts/make-release-archive.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, "..");
const REPO = path.resolve(SHELL, "..");

const pkgJson = JSON.parse(fs.readFileSync(path.join(SHELL, "package.json"), "utf8"));

/** `--outfile=dist/<name>.js`, extracted independently of the function under test. */
function outfilesOf(script) {
  return [...script.matchAll(/--outfile=dist\/([\w.-]+\.js)/g)].map((match) => match[1]).sort();
}

test("the derived bundle-entry set is the bundle script's own --outfile list", () => {
  const derived = bundleEntriesFromScript(pkgJson.scripts.bundle, { where: "this test's copy of the bundle script" });
  assert.deepEqual(derived, outfilesOf(pkgJson.scripts.bundle),
    "the derivation and the bundler's own output list disagree");
  // The point of deriving: the fourth entry — the clean library split — is in the set
  // because the script writes it, not because a list here says so.
  assert.ok(derived.includes("stdio-session.js"),
    `the library entry the bundle script writes is not in the derived set: ${JSON.stringify(derived)}`);
  for (const name of ["index.js", "http-gateway.js", "http-gateway-cli.js"]) {
    assert.ok(derived.includes(name), `${name} is a declared bundle output the derivation lost`);
  }
  assert.equal(new Set(derived).size, derived.length, "the derived set repeats an entry");
});

test("a new bundle entry reaches the guard without anything here being edited", () => {
  // MUTATION THIS PINS: re-hardcoding the expected set. Adding a fifth entry to the
  // bundle script must widen the list on its own; a copy of the old three would keep
  // refusing a tree that releases fine, which is the failure mode this file exists for.
  const withNewEntry = pkgJson.scripts.bundle
    .replace(
      "esbuild src/http-gateway-cli.ts",
      "esbuild src/new-entry.ts --bundle --platform=node --format=esm --target=node18 --external:zod --outfile=dist/new-entry.js && esbuild src/http-gateway-cli.ts",
    )
    .replace("! -name 'http-gateway-cli.js'", "! -name 'http-gateway-cli.js' ! -name 'new-entry.js'");
  assert.notEqual(withNewEntry, pkgJson.scripts.bundle, "the fixture did not grow the bundle script it claims to");
  const derived = bundleEntriesFromScript(withNewEntry, { where: "a bundle script that grew an entry" });
  assert.ok(derived.includes("new-entry.js"), `the new entry is invisible to the guard: ${JSON.stringify(derived)}`);
  assert.deepEqual(
    derived.filter((name) => name !== "new-entry.js"),
    bundleEntriesFromScript(pkgJson.scripts.bundle, { where: "the plain bundle script" }),
    "growing the bundler must widen the set, not replace it",
  );

  // The same entry added without telling the script's own clean-up step is a bundler that
  // deletes what it just wrote, and the guard reads the two halves together.
  const halfEdited = pkgJson.scripts.bundle.replace(
    "esbuild src/http-gateway-cli.ts",
    "esbuild src/new-entry.ts --bundle --platform=node --format=esm --target=node18 --external:zod --outfile=dist/new-entry.js && esbuild src/http-gateway-cli.ts",
  );
  assert.throws(
    () => bundleEntriesFromScript(halfEdited, { where: "a half-edited bundle script" }),
    /bundled but deleted by its own clean-up step/,
    "a bundler whose clean-up step deletes an entry it writes must be refused, not guessed around",
  );
});

test("a bundle script that cannot be read is a refusal, never an empty list", () => {
  // The vacuity half: with `[]` as the expected set, every file in `dist` would be
  // "produced by the bundler" and the guard would pass any tsc build — silently undoing
  // the defect it exists to catch.
  for (const [label, script] of [
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["no bundler at all", "tsc -p tsconfig.json"],
    ["no outfile", "esbuild src/index.ts --bundle --platform=node"],
    ["writes outside dist", "esbuild src/index.ts --bundle --outfile=build/index.js"],
    ["writes a non-js output", "esbuild src/index.ts --bundle --outfile=dist/index.cjs"],
    ["keeps a file it never bundles", "esbuild src/index.ts --bundle --outfile=dist/index.js && find dist -maxdepth 1 -name '*.js' ! -name 'index.js' ! -name 'gone.js' -delete"],
    ["deletes a file it bundles", "esbuild src/index.ts --bundle --outfile=dist/index.js && esbuild src/extra.ts --bundle --outfile=dist/extra.js && find dist -maxdepth 1 -name '*.js' ! -name 'index.js' -delete"],
  ]) {
    assert.throws(
      () => bundleEntriesFromScript(script, { where: `a ${label} bundle script` }),
      (error) => {
        assert.match(String(error.message), /a (missing|empty|blank|no bundler at all|no outfile|writes outside dist|writes a non-js output|keeps a file it never bundles|deletes a file it bundles) bundle script/,
          `the refusal must name which script it could not read: ${error.message}`);
        return true;
      },
      `${label} produced no refusal`,
    );
  }
});

test("the guard accepts the bundle this repository really writes, and still refuses tsc residue", () => {
  const manifest = { name: "glasspane-mcp", dependencies: { zod: "3.25.76" } };
  const bundleFile = (name) => ({
    name: `mcp-shell/dist/${name}`,
    content: Buffer.from('#!/usr/bin/env node\nimport { z } from "zod"\nexport const x = 1\n'),
  });
  const everyEntry = bundleEntriesFromScript(pkgJson.scripts.bundle, { where: "the bundle script" })
    .map((name) => bundleFile(name));
  const accepted = assertBundleShape({ entries: everyEntry, manifest });
  assert.equal(accepted.jsEntries, everyEntry.length, "the real bundle shape was refused by its own guard");

  // The tsc residue the guard exists for, one step short of the archive refusing the
  // release: a non-entry file, and an entry that imports an undeclared package.
  assert.throws(
    () => assertBundleShape({ entries: [...everyEntry, bundleFile("tools.js")], manifest }),
    /holds 1 file\(s\) the bundler does not write \(mcp-shell\/dist\/tools\.js\).*tsc output.*iterate-kernel.*run bundle/s,
    "a tsc leftover must still be refused, and named",
  );
  assert.throws(
    () => assertBundleShape({
      entries: [{ name: "mcp-shell/dist/index.js", content: Buffer.from('import { RunPlan } from "iterate-kernel/run-plan"\n') }],
      manifest,
    }),
    /imports package\(s\) the manifest does not declare: iterate-kernel/,
    "the dependency half of the guard must not have been lost with the list",
  );
});

test("the tree this repository is in is the shape the guard now accepts", () => {
  // The measured symptom from the finding: with the hand-copied list, a *correct* tree
  // refused to publish. Run the guard over the real `mcp-shell/dist` as the archive does,
  // so the claim "a release archive can be built from this tree" is checked rather than
  // asserted by the author of the fix.
  const dist = path.join(SHELL, "dist");
  const manifest = JSON.parse(fs.readFileSync(path.join(SHELL, "package.json"), "utf8"));
  const files = fs.readdirSync(dist).filter((name) => name.endsWith(".js"));
  assert.ok(files.length > 0, `no .js in ${dist}: build and bundle first (npm run build && npm run bundle)`);
  const tscShaped = files.some((name) => !bundleEntriesFromScript(manifest.scripts.bundle, { where: "mcp-shell/package.json" }).includes(name));
  if (tscShaped) {
    // `npm test` leaves dist as tsc output; that is the state the guard must refuse, and
    // saying which state was measured keeps a green run from being a silent skip.
    assert.throws(
      () => assertBundleShape({
        entries: files.map((name) => ({ name: `mcp-shell/dist/${name}`, content: fs.readFileSync(path.join(dist, name)) })),
        manifest,
      }),
      /the bundler does not write/,
      "a tsc-shaped dist must be refused whatever the expected set is derived from",
    );
    return;
  }
  const outcome = assertBundleShape({
    entries: files.map((name) => ({ name: `mcp-shell/dist/${name}`, content: fs.readFileSync(path.join(dist, name)) })),
    manifest,
  });
  assert.equal(outcome.jsEntries, files.length);
  assert.ok(fs.existsSync(path.join(REPO, "scripts", "make-release-archive.mjs")), "the guard's own repository moved");
});
