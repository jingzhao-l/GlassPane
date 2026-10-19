import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CA_BUNDLE_FILE_NAME,
  readUpdateState,
  STATE_DIR_ENV,
  updateStateFile,
} from "../dist/update-state.js";
import { executeTool, TOOL_BY_NAME } from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { makeEngine } from "./helpers.mjs";
import { executableSource } from "./support/source.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * A remedy has to be executable by the agent that reads it (the product rule behind
 * review 2026-10-09 finding 12), and a command spelled `node updater/cli.js …` is not:
 * it resolves against *the reader's* working directory, which for an MCP host is
 * nowhere near this repository — and in the published artifact there is nothing to
 * resolve to at all, because `mcp-shell/package.json`'s `files` list ships `dist` and
 * `schemas` only.
 *
 * `tools.ts` fixed this for the `kind === "read"` branch by resolving an absolute path
 * (`absoluteNodeCommand` + `repoScript`) and by saying plainly when none is nameable.
 * The three branches inside `update-state.ts` that render an **absent / unreadable /
 * unresolvable** state kept printing the relative command — which is what a machine
 * that never updated, or whose state file this shell cannot decode, actually reads.
 *
 * The invariant asserted here is the narrow one, so it cannot be satisfied by wording:
 * wherever a string these surfaces hand out says `node <path>`, that path is absolute.
 */

/** Every summary this module can produce for a state it did not understand. */
function machineStateSummaries() {
  const cases = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-remedy-exec-"));
  try {
    const stateFile = path.join(root, "update-state.json");

    // 1. absent — auto-update has never run here.
    cases.push({ label: "absent", reading: readUpdateState({}, root) });

    const write = (body, mode = 0o600) => {
      fs.writeFileSync(stateFile, typeof body === "string" ? body : JSON.stringify(body), { mode });
    };
    const clean = () => fs.rmSync(stateFile, { force: true });

    // 2. unreadable: not JSON.
    write("{not json");
    cases.push({ label: "unreadable: not JSON", reading: readUpdateState({}, root) });
    clean();

    // 3. unreadable: group-readable mode, the case the file header has always named.
    write({ status: "up-to-date", current: "1.4.0", latest: "1.4.0", updatedAt: "2026-10-01T04:00:00.000Z" }, 0o644);
    cases.push({ label: "unreadable: mode 0644", reading: readUpdateState({}, root) });
    clean();

    // 4. unreadable: a CA record this shell cannot decode → the `enable` branch.
    write({
      status: "up-to-date",
      current: "1.4.0",
      latest: "1.4.0",
      updatedAt: "2026-10-01T04:00:00.000Z",
      caRoots: { status: "fine", certs: 3 },
    });
    cases.push({ label: "unreadable: caRoots out of contract", reading: readUpdateState({}, root) });
    clean();

    // 5. unreadable: an updater self-update record this shell cannot decode → the other
    //    `enable` branch.
    write({
      status: "up-to-date",
      current: "1.4.0",
      latest: "1.4.0",
      updatedAt: "2026-10-01T04:00:00.000Z",
      runtime: { status: "current" },
    });
    cases.push({ label: "unreadable: runtime out of contract", reading: readUpdateState({}, root) });
    clean();

    // 6. unreadable: a status outside the closed set.
    write({ status: "banana", current: "1.4.0" });
    cases.push({ label: "unreadable: unknown status", reading: readUpdateState({}, root) });
    clean();

    // `unresolvable` (no password-database record, so no state root to name) cannot be
    // produced from a test running under a real account; the source gate below covers that
    // branch instead, so no rendered form of it can carry a relative command either.
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return cases;
}

/**
 * The invariant: any `node <path>` **command position** in the text — one whose operand
 * is an entry-point script — must name an absolute path. A relative operand is a command
 * for a working directory the reader is not standing in, and no amount of surrounding
 * prose makes it runnable. Prose that merely says the word "node" is not a command, so
 * the operand has to be a `…cli.js` path for this to fire.
 */
function assertNoRelativeNodeCommand(text, label) {
  for (const match of text.matchAll(/node\s+([^\s`|;,]*(?:updater|installer)\/cli\.js[^\s`|;,]*)/g)) {
    const target = match[1];
    assert.ok(target.startsWith("/") || target.startsWith("\"") || target.startsWith("'"),
      `${label}: 出路印了一条按读者工作目录解析的命令 \`node ${target}\` — 发布物只带 dist 与 schemas，`
        + `那里没有这个相对路径，而读者的 cwd 也不是这个仓库。要么给绝对路径，要么明说这台机器点名不出命令：${text}`,
    );
  }
}

test("no absent/unreadable/unresolvable update state prints a bare node updater|installer/cli.js command", () => {
  const cases = machineStateSummaries();
  assert.ok(cases.length >= 5, `这组机器状态必须同时覆盖 absent 与 unreadable 的每一态，实测 ${cases.length} 例`);
  for (const { label, reading } of cases) {
    assert.notEqual(reading.kind, "read", `${label} 应当落在 read 之外的某一态，不然这条闸什么也没测：${reading.summary}`);
    assertNoRelativeNodeCommand(reading.summary, `${label} (${reading.kind})`);
    for (const bare of [/`node updater\/cli\.js/, /`node installer\/cli\.js/]) {
      assert.equal(bare.test(reading.summary), false,
        `${label}: ${bare} 又出现在出路里（review 2026-10-09 finding 12 的形态）：${reading.summary}`);
    }
  }
});

test("an unrendered state says either an absolute command or that none is nameable", () => {
  // The two-armed shape `tools.ts` already holds its `read` branch to: an agent handed
  // "run X" must be able to run X, and an agent handed nothing must be told why.
  const cases = machineStateSummaries().filter(({ reading }) => reading.kind !== "read");
  for (const { label, reading } of cases) {
    // What this gate forbids is a *shown* command the reader cannot run. A backticked
    // instruction whose operand is an absolute path is runnable from wherever the reader
    // stands (`node /…/cli.js` and `chmod 600 /…/update-state.json` are the same class).
    // A sentence that shows no command at all is a diagnosis, not an instruction — the
    // relative-command guard above is what keeps it from being a fake instruction.
    const showsACommand = /`[^`\n]+`/.test(reading.summary);
    const namesACommand = /`[^`\n]*\s\/[^\s`]+`/.test(reading.summary);
    const admitsNone = /no absolute path|prints no command|names no command|no command (is )?(printable|named)|cannot name (a|an) (absolute )?path/i
      .test(reading.summary);
    assert.ok(!showsACommand || namesACommand || admitsNone,
      `${label}: 这句话点了一条读者跑不动的命令，又没有明说点不出命令：${reading.summary}`);
    // The arms are probed, not assumed: each one must be able to say what it claims, or
    // this assertion is only as strong as the prose it happens to match.
    assert.equal(/`[^`\n]+`/.test("Run `chmod 600 /var/db/glasspane/update-state.json`"), true,
      "拒绝臂失效：一句真给了绝对命令的话被当成没给");
    assert.equal(/`[^`\n]*\s\/[^\s`]+`/.test("Run `node updater/cli.js check` and read again"), false,
      "拒绝臂失效：相对路径的命令被当成可执行的出路");
    assert.equal(/`[^`\n]+`/.test("the updater and this shell disagree about the contract"), false,
      "接受臂失效：纯描述的话不该被当成一条命令");
  }
});

test("gp_diagnose hands the agent an update block with no relative command in it", async () => {
  // The block is what an agent actually reads, so the check runs through the tool seam.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-remedy-exec-diag-"));
  const saved = process.env[STATE_DIR_ENV];
  process.env[STATE_DIR_ENV] = root;
  try {
    const { engine, io } = makeEngine();
    const promise = executeTool(TOOL_BY_NAME.get("gp_diagnose"), {}, engine, new EvidenceAuditSession());
    io.lastFrame();
    io.respond({ class: "T1", summary: "ok" });
    const outcome = await promise;
    assert.equal(outcome.content.length, 2, JSON.stringify(outcome.content.map((c) => c.text.slice(0, 60))));
    const block = outcome.content[1].text;
    assert.match(block, /^update state:/, block);
    assertNoRelativeNodeCommand(block, "gp_diagnose 的 update block");
  } finally {
    if (saved === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("update-state.ts builds its remedy text through the absolute resolver, not a relative guess", () => {
  // The half no test on this machine can reach at runtime: `unresolvable` needs a process
  // with no password-database record. Same gate shape as
  // `test/review-2026-10-09.test.mjs`'s tools.ts check — command positions only, so prose
  // that explains what a line stopped naming stays writable.
  const source = executableSource(
    fs.readFileSync(path.resolve(HERE, "..", "src", "update-state.ts"), "utf8"),
  );
  for (const bare of [/`node updater\/cli\.js/, /`node installer\/cli\.js/]) {
    assert.equal(bare.test(source), false,
      `${bare} 又回到 src/update-state.ts 的命令位：它按读者的 cwd 解析，而发布物只带 dist 与 schemas`);
  }
  assert.match(source, /absoluteNodeCommand|repoScript/,
    "出路要由绝对路径拼出来，与 tools.ts 的 read 分支同一口径");
});

test("the state file this shell resolves is the one it names, and the CA bundle sits in that root", () => {
  // Guards the fixture itself: if `updateStateFile` and the reading ever disagree about
  // which file was checked, the assertions above would be measuring nothing.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-remedy-exec-path-"));
  try {
    const reading = readUpdateState({}, root);
    assert.equal(reading.kind, "absent");
    assert.equal(reading.stateFile, updateStateFile({}, root));
    assert.equal(reading.stateFile, path.join(root, "update-state.json"));
    assert.equal(path.basename(path.join(root, CA_BUNDLE_FILE_NAME)), CA_BUNDLE_FILE_NAME);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
