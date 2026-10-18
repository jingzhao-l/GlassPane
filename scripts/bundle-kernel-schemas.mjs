#!/usr/bin/env node
/**
 * bundle-kernel-schemas.mjs — the shipped `mcp-shell/schemas/` is a copy of the **published**
 * kernel's schemas, not of the repository's mirror of them.
 *
 * WHY THIS EXISTS. `mcp-shell` used to resolve `@iterate/kernel` through
 * `"file:../kernel"`, so its bundle step copied `../kernel/schemas` and the tarball shipped
 * whatever the mirror happened to hold. Two things were wrong with that: the mirror's code had
 * no provenance record at all (only `fixtures/` and `schemas/` are pinned, by
 * `scripts/check-kernel-corpus.mjs`), and the artifact a user installed could therefore carry a
 * contract that no manifest anywhere claims. The kernel has been published as `iterate-kernel`
 * since 2026-10-08 and the fork consumes it as a dependency; the shell was the last consumer
 * still reading a hand-synced copy.
 *
 * WHAT THIS CHECKS, in order, refusing at the first disagreement:
 *
 *   1. `mcp-shell/package.json` declares `iterate-kernel` with an **exact** version — no range.
 *      A range would mean the published bytes of this release depend on what registry npm
 *      served that day.
 *   2. The package Node will actually resolve (walking up from `mcp-shell`, the same way an
 *      `import "iterate-kernel/…"` resolves) reports that exact version.
 *   3. `harness/glasspane-harness/contracts/kernel-pin.json` — the fork's provenance record —
 *      names the same version. The two consumers of this contract are the fork's product code
 *      and the shell's published artifact; one kernel version between them is the entire point
 *      of sharing a kernel, and a bump that reaches one and not the other is a fork of the
 *      contract, not a release. In a tree that carries no pin (the scratch tree the
 *      publish-shape suite bundles from) this leg **prints that it was not observed** instead of
 *      refusing to build; `scripts/check-kernel-corpus.mjs` enforces the same equality on every
 *      CI run, where the checkout is whole.
 *   4. Every schema file the package ships is copied byte-for-byte, and the copy refuses to be
 *      empty: a `schemas/` directory with no `.json` in it is a refusal, not a green build.
 *
 * Exit codes: 0 copied and verified, 1 a stated disagreement above.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The **caller's** directory is the package being bundled, not this file's repository location.
// `mcp-shell/test/published-artifact.test.mjs` bundles from a scratch tree whose `scripts/` is a
// symlink into a worktree, and Node resolves a symlinked entry module to its real path — so
// deriving the destination from `import.meta.url` wrote the corpus into the worktree, exited 0,
// and left the scratch tree's tarball with no schemas at all. The pin is the one thing that does
// live by this file's location, so it keeps the repo root.
const shell = resolve(process.cwd());
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(shell, "package.json");
const pinPath = join(root, "harness", "glasspane-harness", "contracts", "kernel-pin.json");

function die(what, remedy) {
  console.error(`bundle-kernel-schemas: ${what}`);
  console.error(`  Remedy: ${remedy}`);
  process.exit(1);
}

function readJson(file, label) {
  if (!existsSync(file)) die(`${label} is missing (${file})`, "run this script from a GlassPane checkout — it refuses to invent the manifest it is meant to read");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    die(`${label} does not parse (${file}): ${error.message}`, "fix the manifest; a bundle built on an unreadable dependency line is not a release");
  }
}

/** The declared version of `iterate-kernel` in the shell's own manifest, from either face. */
function declaredVersion(manifest) {
  for (const face of ["dependencies", "devDependencies"]) {
    const spec = manifest?.[face]?.["iterate-kernel"];
    if (typeof spec === "string") return { spec, face };
  }
  return null;
}

/** Where Node would find the package from inside `mcp-shell` — walking up, as resolution does. */
function installedDir() {
  let dir = shell;
  for (;;) {
    const candidate = join(dir, "node_modules", "iterate-kernel");
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const manifest = readJson(manifestPath, `${relative(process.cwd(), manifestPath) || "package.json"}`);
if (manifest?.name !== "glasspane-mcp") {
  die(`the current directory is not glasspane-mcp (its manifest says "${manifest?.name}")`, `run this from the package it bundles into: npm --workspace glasspane-mcp run bundle (cwd was ${shell})`);
}
const declared = declaredVersion(manifest);
if (!declared) {
  die("the manifest declares no iterate-kernel", 'add "iterate-kernel": "<exact version>" to mcp-shell/package.json devDependencies — the shell bundles the kernel, so the version that went into these bytes has to be written down');
}
if (!/^\d+\.\d+\.\d+$/.test(declared.spec)) {
  die(`the declared spec "${declared.spec}" is a range or a local path`, "pin an exact published version: npm resolves a range to whatever the registry serves today, and then the shipped artifact's contract is not reproducible");
}

const installed = installedDir();
if (!installed) {
  die(`no iterate-kernel resolves from ${shell}`, "run `npm ci` at the repository root — the bundle inlines the package, so it has to be installed before it can be bundled");
}
const installedManifest = readJson(join(installed, "package.json"), "the installed iterate-kernel");
if (installedManifest.name !== "iterate-kernel") {
  die(`the resolved package calls itself "${installedManifest.name}"`, `delete the stale install: ${installed} is not what the manifest names`);
}
if (installedManifest.version !== declared.spec) {
  die(`installed ${installedManifest.version} but the manifest declares ${declared.spec}`, "the lock and the manifest disagree — run `npm ci` from the committed package-lock.json before bundling, never `npm install` into a half-moved tree");
}

const pin = existsSync(pinPath) ? readJson(pinPath, "harness/glasspane-harness/contracts/kernel-pin.json") : null;
if (pin === null) {
  // Not a refusal: a bundle step that dies because an unrelated subtree is absent cannot be
  // run anywhere but a full checkout, and the release path does run in partial trees
  // (`mcp-shell/test/published-artifact.test.mjs` bundles from a scratch one). The agreement
  // between the shell's kernel and the fork's pin is still a gate — `scripts/check-kernel-corpus.mjs`
  // enforces it in CI, where the pin exists — so say what was not observed here rather than
  // either silently skipping it or refusing to build.
  console.log(`bundle-kernel-schemas: pin leg 未观测 — ${relative(root, pinPath)} 不在这个树里；`
    + "shell↔pin 同号由 scripts/check-kernel-corpus.mjs 的 mcp-shell 那条判据在完整检出上守。");
} else {
  if (pin.package !== "iterate-kernel") {
    die(`${pinPath} does not describe an iterate-kernel pin (package: ${pin.package})`, "the fork's provenance record is the other consumer's copy of this contract; run script/kernel-pin.mjs --record");
  }
  if (pin.version !== declared.spec) {
    die(`the fork ships ${pin.version} while the shell bundles ${declared.spec}`, "one kernel per ecosystem: bump mcp-shell/package.json and re-record the pin in the same batch, or this artifact and that product answer different contracts");
  }
}

const source = join(installed, "schemas");
if (!existsSync(source)) {
  die(`the installed package ships no schemas/ directory (${source})`, "the corpus is the contract for every consumer that cannot import TypeScript — refuse to ship a package published without it; see the kernel's own packaging gate");
}
const files = readdirSync(source).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) {
  die(`the installed package's schemas/ holds no .json file (${source})`, "an empty corpus is not a contract; this is a publish defect, report it on the kernel side rather than bundling around it");
}

const target = join(shell, "schemas");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of files) copyFileSync(join(source, name), join(target, name));

const written = readdirSync(target).filter((name) => name.endsWith(".json")).sort();
if (written.join(",") !== files.join(",")) {
  die(`the copy disagrees with the source (${written.length} written, ${files.length} read)`, "re-check the volume permissions; a partially copied corpus is worse than no corpus, because it looks complete");
}

console.log(`bundle-kernel-schemas: ${written.length} schema(s) copied from iterate-kernel@${installedManifest.version} (${installed}) into mcp-shell/schemas/`);
for (const name of written) console.log(`  ${name}  sha256=${sha256(join(target, name)).slice(0, 16)}…`);
