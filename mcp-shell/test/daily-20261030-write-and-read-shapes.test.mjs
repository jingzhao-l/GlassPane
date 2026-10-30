/**
 * Two durable-write shapes this shell got wrong, and the artifact's own type surface.
 *
 * 1. `project-registry.ts` opened its temp file with `"w"` — `O_CREAT|O_WRONLY|O_TRUNC`, which
 *    **follows** whatever is at that name. The daemon's writers do not: `DurableFileWrite.swift`
 *    opens `O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC`, `EvidenceReportGenerator.swift` adds `O_NOFOLLOW`,
 *    and `bridge/glasspane_bridge.py` refuses to follow too. This file is the *other* production
 *    writer of the same `projects.json` table, so parity is the fix; a same-uid process that
 *    planted a symlink or a directory at the temp name used to have the registry bytes written
 *    through it, outside the archive, while the call still reported success. The temp name is
 *    random per write (`.tmp-<pid>-<ts>-<n>-<4 hex>`), so no unprivileged test can guess it —
 *    which is precisely why this half is a source judgement, and the mutation is real: change the
 *    flags back to `"w"` and this case names the site.
 * 2. `update-state.ts` read its state file through `fs.statSync`, which follows a symlink planted
 *    at `<root>/update-state.json`; every fact judged below the stat — regular-file-ness, the
 *    owner-only mode, and the summary `gp_diagnose` then narrates as this machine's freshness —
 *    was measured on the link's TARGET. `StateRoot.swift:140-147` (`leafSymlinkDefect`) refuses
 *    that shape on the daemon side for the same reason: an owner-only mode cannot be judged, or
 *    set, by acting on whatever the link points at. This one is behavioural: a real symlink, a
 *    real read, and the refusal text.
 * 3. The shipped `.d.ts` files import `iterate-kernel/evidence-pack`, while `iterate-kernel` was a
 *    **devDependency**. npm installs no devDependencies for a consumer, and `README.md` invites
 *    embedding (`要嵌进自己的进程就用这一条`) through `exports["./stdio-session"].types`, so a
 *    TypeScript host got `TS2307` on the package's own published types unless it set
 *    `skipLibCheck`. The bundle is self-contained JS; the *declarations* are the half that had a
 *    dependency it never declared.
 *
 * `privateSandbox` is used, not `os.tmpdir()`: on the Linux runner `TMPDIR=/tmp` is 01777 and the
 * registry's own world-writable guard would refuse the write before reaching anything under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readUpdateState } from "../dist/update-state.js";
import { quoteShellArg } from "../dist/errors.js";
import { privateSandbox } from "./support/sandbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "src");
const DIST = path.resolve(HERE, "..", "dist");

/** Comments stripped the same way the repo's other source gates strip them. */
function executableSource(text) {
  return text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

test("the registry's temp write opens exclusively and refuses to follow a link", () => {
  const source = executableSource(fs.readFileSync(path.join(SRC, "project-registry.ts"), "utf8"));
  const site = /fs\.openSync\(\s*tmpPath,([\s\S]{0,260}?)STATE_FILE_MODE\s*,?\s*\)/.exec(source);
  assert.ok(site, "the registry's temp-file open is not where this control looks — re-read it, do not delete this case");
  const flags = site[1];
  for (const needed of ["O_WRONLY", "O_CREAT", "O_EXCL", "O_NOFOLLOW"]) {
    assert.match(flags, new RegExp(`fs\\.constants\\.${needed}`),
      `projects.json 的临时文件必须以 ${needed} 打开，否则同 uid 的进程可以在那个名字上放一个符号链接，让注册表字节写到档案之外：${flags}`);
  }
  assert.ok(!/"w"/.test(flags), `open flags regressed to the following form: ${flags}`);
});

test("the registry write still lands a 0600 regular file in a private root (the flags must not break the good path)", async () => {
  const box = privateSandbox("gp-registry-open-");
  const target = path.join(box.dir, "projects.json");
  const { projectSet, PROJECTS_FILE_ENV } = await import("../dist/project-registry.js");
  const previous = process.env[PROJECTS_FILE_ENV];
  process.env[PROJECTS_FILE_ENV] = target;
  try {
    projectSet({ bundleId: "com.example.round20261030", displayName: "round20261030" });
    const stat = fs.lstatSync(target);
    assert.ok(stat.isFile(), "the landed entry is a regular file");
    assert.equal(stat.mode & 0o077, 0, `the registry must be owner-only, got ${(stat.mode & 0o777).toString(8)}`);
    assert.ok(fs.readFileSync(target, "utf8").includes("com.example.round20261030"), "the entry is in the table");
    // The exclusive open must not leave debris either: the temp name is random per write, so a
    // surviving `.tmp-*` is a writer that failed and said nothing about it.
    const debris = fs.readdirSync(box.dir).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(debris, [], `临时文件留在了盘上：${debris.join(", ")}`);
  } finally {
    if (previous === undefined) delete process.env[PROJECTS_FILE_ENV];
    else process.env[PROJECTS_FILE_ENV] = previous;
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("update-state refuses a symlink planted at the state file instead of narrating its target", () => {
  const box = privateSandbox("gp-state-link-");
  const stateFile = path.join(box.dir, "update-state.json");
  const elsewhere = path.join(box.dir, "someone-else.json");
  try {
    fs.writeFileSync(elsewhere, JSON.stringify({ schemaVersion: 1, status: "up-to-date" }), { mode: 0o600 });
    fs.symlinkSync(elsewhere, stateFile);
    const reading = readUpdateState({}, box.dir);
    assert.equal(reading.kind, "unreadable", `a symlinked state file must not be read as the engine's own document: ${JSON.stringify(reading)}`);
    assert.match(reading.summary, /symlink/, `the refusal must name the shape it found: ${reading.summary}`);
    // The honest tail of every unreadable answer says "freshness is unknown" — that is the product
    // saying it measured nothing. What must NOT survive is the *target's* verdict leaking in as a
    // reading of this machine, i.e. any field other than the refusal itself.
    assert.equal(reading.status, undefined, `the link target's status became the answer: ${JSON.stringify(reading)}`);
    assert.ok(!/"status"\s*:\s*"up-to-date"/.test(JSON.stringify(reading)),
      `the link target's payload was parsed and returned: ${JSON.stringify(reading)}`);
    assert.ok(reading.summary.includes(quoteShellArg(stateFile)) || reading.summary.includes(stateFile),
      "the message has to name the path the reader was pointed at");
  } finally {
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("update-state still reads a real owner-only file (the guard did not become a blanket refusal)", () => {
  const box = privateSandbox("gp-state-good-");
  const stateFile = path.join(box.dir, "update-state.json");
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, status: "up-to-date" }), { mode: 0o600 });
    const reading = readUpdateState({}, box.dir);
    assert.notEqual(reading.kind, "unreadable", JSON.stringify(reading));
    assert.notEqual(reading.kind, "absent", JSON.stringify(reading));
  } finally {
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test("every package the shipped .d.ts files import is declared as a runtime dependency", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, "..", "package.json"), "utf8"));
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  // Doc comments in a `.d.ts` are prose ("the bytes a *busy* daemon never read from"), so they
  // have to be stripped before any `from "…"` is read as a module specifier — the first version of
  // this control harvested sentences like `from busy` and accused the artifact of undeclared
  // packages that do not exist. Builtins are not packages either: nothing installs `node:fs`.
  const bareImports = (name) => [...executableSource(fs.readFileSync(path.join(DIST, name), "utf8"))
    .matchAll(/from\s+"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"))
    .map((specifier) => (specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]));
  const files = fs.readdirSync(DIST).filter((f) => f.endsWith(".d.ts"));
  assert.ok(files.length >= 4, `only ${files.length} declaration files in dist — this control is reading an unbuilt tree`);
  const offenders = [];
  const seen = new Set();
  for (const name of files) {
    for (const specifier of bareImports(name)) {
      seen.add(specifier);
      if (!declared.has(specifier)) offenders.push(`${name} → ${specifier}`);
    }
  }
  assert.ok(seen.size >= 1, "the declaration files import nothing outside the tree — this control is reading nothing");
  assert.deepEqual(offenders, [],
    `这些 .d.ts 引用了没有声明为 dependencies 的包：消费者 `
    + `npm install 拿不到它，而 README 教的"嵌进自己进程"那条路会在类型上撞 TS2307：${offenders.join(", ")}`);
});
