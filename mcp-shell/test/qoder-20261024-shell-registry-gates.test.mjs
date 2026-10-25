/**
 * 2026-10-24 unattended review — mcp-shell lane, registry half.
 *
 * Two findings, one file, because both live on the write path of
 * `project-registry.ts` and both are "the shell says one thing and does another":
 *
 * B1 — `projectsPath()` returned `GLASSPANE_PROJECTS_FILE` verbatim, ahead of and
 *        outside every path gate this module owns. `stateRootRefusal` /
 *        `refuseCandidate` judge the root the *daemon* reports and the storage roots an
 *        *agent* reports; the shell's own override slot was judged by neither — while
 *        `saveProjects` then `mkdirSync(dir, 0700)` + `tightenMode`s that directory and
 *        writes the registry (bundle ids, pids, storage paths) into it.
 *        `rootDiscriminator()` even teaches the reader to set the variable.
 * B5 — a `ProjectRegistryError` carried a code and a message only, so `tools.ts`'s
 *        `mapProjectError` derived the remedy from the **code** alone. A durability
 *        fault (EIO on the fsync) and a chmod that will not stick both answer
 *        `GP_E_INTERNAL`, whose code-derived remedy is "the projects file is the
 *        problem … repair or restore the damaged entry" — while the message in the same
 *        frame says "This is the write's own failure, not a verdict about the file's
 *        contents". One frame, two opposite instructions, and the wrong one reads as the
 *        next move.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PROJECTS_FILE_ENV,
  ProjectRegistryError,
  daemonProjectsPath,
  projectList,
  projectSet,
} from "../dist/project-registry.js";
import { TOOL_BY_NAME, executeTool } from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { privateSandbox } from "./support/sandbox.mjs";

/** Run `body` with `GLASSPANE_PROJECTS_FILE` set to `value` (or unset when null). */
async function withProjectsFile(value, body) {
  const previous = process.env[PROJECTS_FILE_ENV];
  if (value === null) delete process.env[PROJECTS_FILE_ENV];
  else process.env[PROJECTS_FILE_ENV] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[PROJECTS_FILE_ENV];
    else process.env[PROJECTS_FILE_ENV] = previous;
  }
}

function registryError(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ProjectRegistryError, `注册表抛的不是它自己的拒绝：${String(error)}`);
    return error;
  }
  throw new Error("expected a ProjectRegistryError, got a normal return");
}

/** The three fields every error frame of this product has, read off one tool answer. */
function fieldsOf(text) {
  const split = text.split("| remedy:");
  assert.equal(split.length, 2, `错误帧恒 code/message/remedy 三字段：${text.slice(0, 200)}`);
  return { code: split[0].split(":")[0] ?? "", message: split[0], remedy: split[1] ?? "" };
}

/* ------------------------------------------------------------------ *
 * B1 — the override slot crosses the same gate as every other root.
 * ------------------------------------------------------------------ */

const HOME_RECORD = os.userInfo().homedir;

/** Values a caller could put in the override that this shell must refuse to create. */
const REFUSED_OVERRIDES = [
  {
    label: "shared scratch",
    value: "/private/tmp/gp-shell-b1-never-created/projects.json",
    expect: /tmp|shared|scratch|protected/i,
  },
  {
    label: "relative path",
    value: "gp-shell-b1-relative/projects.json",
    expect: /absolute/i,
  },
  {
    label: "a first-level dot-directory of the account",
    value: path.join(HOME_RECORD, ".gp-shell-b1-dotdir", "projects.json"),
    expect: /dot-directory|home directory|credential/i,
  },
];

/** Where a refused value would have been created, so the red run leaves nothing behind. */
function probeDirOf(value) {
  return path.resolve(path.dirname(value));
}

test("the projects-file override is judged by the same path gates as a reported root", async () => {
  // MUTATION THIS PINS (red against the reviewed implementation): `projectsPath()`'s
  // `process.env[PROJECTS_FILE_ENV]` branch returned the value as it stood, before any
  // gate. Every case below therefore *answered normally* — the read either found no file
  // ("nothing registered yet") or read whatever was there, and the write would have
  // created and re-permissioned the directory. The shell judged the daemon's reported
  // root and the agent's storage roots and obeyed its own override without asking.
  for (const one of REFUSED_OVERRIDES) {
    const probe = probeDirOf(one.value);
    const cases = [
      ["read", () => projectList()],
      ["write", () => projectSet({ displayName: "B1", bundleId: "test.b1.app" })],
    ];
    try {
      for (const [verb, run] of cases) {
        await withProjectsFile(one.value, () => {
          const error = registryError(run);
          assert.equal(error.code, "GP_E_STATE_ROOT_REFUSED", `${one.label}/${verb}: ${error.message.slice(0, 200)}`);
          assert.match(error.message, new RegExp(PROJECTS_FILE_ENV), `${one.label}/${verb}: 拒绝要说是哪一格被判掉了`);
          assert.match(error.message, one.expect, `${one.label}/${verb}: 没说出它自己的那条形状缺陷`);
          assert.ok(typeof error.remedy === "string" && error.remedy.trim() !== "", `${one.label}/${verb}: 拒绝要带自己的出路`);
          assert.match(error.remedy, new RegExp(`unset ${PROJECTS_FILE_ENV}`), `${one.label}/${verb}: 出路要跑得动：${error.remedy.slice(0, 200)}`);
          assert.equal(fs.existsSync(probe), false, `${one.label}/${verb}: 拒绝之前不许把目录建出来：${probe}`);
        });
      }
    } finally {
      // The reviewed (unfixed) implementation creates these on the write leg — that is the
      // defect. Cleaning up after the red run keeps the refusal's own proof honest.
      fs.rmSync(probe, { recursive: true, force: true });
    }
  }
});

test("the refusal says this is the shell's own override being judged, not the daemon's root", async () => {
  // The sentence the reviewed code writes for a *reported* root ("the background service's
  // self-reported state root …") states a different authority. An agent told to go restart
  // the service, when the thing in play is its own exported variable, is sent away from the
  // one move that works.
  const refused = "/private/tmp/gp-shell-b1-wording/projects.json";
  try {
    await withProjectsFile(refused, () => {
      const error = registryError(() => projectSet({ displayName: "B1 wording", bundleId: "test.b1.wording" }));
      assert.match(error.message, /this shell|this process/i, error.message.slice(0, 240));
      assert.doesNotMatch(error.message, /self-reported state root/, "这格是本壳的覆盖位，不是 daemon 报的根");
      assert.equal(fs.existsSync("/private/tmp/gp-shell-b1-wording"), false);
    });
  } finally {
    fs.rmSync("/private/tmp/gp-shell-b1-wording", { recursive: true, force: true });
  }
});

test("gp_project_set answers a refused override as a three-field frame", async () => {
  const refused = "/private/tmp/gp-shell-b1-surface/projects.json";
  let text;
  try {
    text = await withProjectsFile(refused, async () => {
      const outcome = await executeTool(
        TOOL_BY_NAME.get("gp_project_set"),
        { displayName: "B1 surface", bundleId: "test.b1.surface" },
        { call: () => Promise.reject(new Error("a file-level tool must not call the engine")) },
        new EvidenceAuditSession(),
      );
      assert.equal(outcome.isError, true, "被 judged 掉的覆盖位不许报成一次成功的注册");
      return outcome.content[0].text;
    });
  } finally {
    fs.rmSync("/private/tmp/gp-shell-b1-surface", { recursive: true, force: true });
  }
  const fields = fieldsOf(text);
  assert.equal(fields.code, "GP_E_STATE_ROOT_REFUSED", text.slice(0, 200));
  assert.match(fields.remedy, new RegExp(`unset ${PROJECTS_FILE_ENV}`), fields.remedy.slice(0, 240));
  assert.doesNotMatch(fields.remedy, /repair or restore the damaged entry/, "这一支没有坏文件可修");
});

test("a private sandbox override keeps working — the gate is not a fixture breaker", async () => {
  // The positive half, green before and after the fix: this suite points the variable at
  // its own 0700 user-owned directory, and a gate that refused that would be a gate that
  // burns the fixtures instead of closing the hole.
  const sandbox = privateSandbox("gp-shell-b1-ok-");
  const file = path.join(sandbox.dir, "projects.json");
  await withProjectsFile(file, async () => {
    const created = projectSet({ displayName: "B1 control", bundleId: "test.b1.control" });
    assert.match(created.projectId, /^prj_/);
    assert.ok(fs.existsSync(file), "夹具指的私有目录必须照旧可写");
    assert.equal(projectList().length, 1);
    assert.equal((await executeTool(
      TOOL_BY_NAME.get("gp_project_list"),
      {},
      { call: () => Promise.reject(new Error("unused")) },
      new EvidenceAuditSession(),
    )).isError, false);
  });
  sandbox.dispose();
});

/* ------------------------------------------------------------------ *
 * B5 — the registry's own faults carry their own remedies.
 * ------------------------------------------------------------------ */

async function projectSetText() {
  const outcome = await executeTool(
    TOOL_BY_NAME.get("gp_project_set"),
    { displayName: "B5", bundleId: "test.b5.app" },
    { call: () => Promise.reject(new Error("a file-level tool must not call the engine")) },
    new EvidenceAuditSession(),
  );
  assert.equal(outcome.isError, true);
  return outcome.content[0].text;
}

test("a durability fault names the volume, not a damaged entry", async (t) => {
  // MUTATION THIS PINS (red against the reviewed implementation): the frame read
  // `GP_E_INTERNAL: … This is the write's own failure, not a verdict about the file's
  // contents …` followed by `| remedy: the projects file is the problem … repair or
  // restore the damaged entry`, because the remedy was derived from the code alone.
  const sandbox = privateSandbox("gp-shell-b5-eio-");
  const file = path.join(sandbox.dir, "projects.json");
  t.mock.method(fs, "fsyncSync", () => {
    throw Object.assign(new Error("simulated device fault"), { code: "EIO" });
  });
  const text = await withProjectsFile(file, async () => projectSetText());
  const fields = fieldsOf(text);
  assert.equal(fields.code, "GP_E_INTERNAL", text.slice(0, 160));
  assert.match(fields.message, /not a verdict about the file's contents/, "message 一侧的事实要说全");
  assert.doesNotMatch(fields.remedy, /repair or restore the damaged entry/, `出路把人支去修一个没坏的文件：${fields.remedy}`);
  assert.doesNotMatch(fields.remedy, /the projects file is the problem/, `同一条 message 已经否掉了这个断言：${fields.remedy}`);
  assert.match(fields.remedy, /ls -lO/, `出路要给这一支真正跑得动的命令：${fields.remedy.slice(0, 220)}`);
  assert.match(fields.remedy, /diskutil info -live/);
  assert.equal(fs.existsSync(file), false, "没落盘的写不许留下注册表");
  sandbox.dispose();
});

test("a mode that will not stick gives the chmod route, not a file-repair route", async (t) => {
  // The other GP_E_INTERNAL write arm: `tightenMode` finds the directory still 0755 after
  // chmod — a volume that ignores permissions. The reviewed remedy answered that with
  // "repair or restore the damaged entry" for a file nothing in the frame calls damaged.
  const sandbox = privateSandbox("gp-shell-b5-mode-");
  const dir = path.join(sandbox.dir, "loose");
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  t.mock.method(fs, "chmodSync", () => undefined);
  const text = await withProjectsFile(path.join(dir, "projects.json"), async () => projectSetText());
  const fields = fieldsOf(text);
  assert.equal(fields.code, "GP_E_INTERNAL", text.slice(0, 200));
  assert.match(fields.remedy, /chmod 700/, `拒绝自己已经给出这一步，出路要转录它：${fields.remedy.slice(0, 220)}`);
  assert.doesNotMatch(fields.remedy, /repair or restore the damaged entry/, fields.remedy);
  // The judge is "does this send the caller to force-overwrite as the fix", not "does the
  // name appear": the remedy *prohibits* it on purpose ("do not set GLASSPANE_PROJECTS_FORCE_OVERWRITE:
  // the fault is the mode, not the bytes in the file"), and a substring ban would have to delete
  // that prohibition to pass — teaching the next reader that the guardrail does not exist.
  assert.match(fields.remedy, /do not set GLASSPANE_PROJECTS_FORCE_OVERWRITE/,
    `权限问题要把"别用强制覆盖"说出来：${fields.remedy}`);
  assert.doesNotMatch(fields.remedy, /GLASSPANE_PROJECTS_FORCE_OVERWRITE=(1|true)|set GLASSPANE_PROJECTS_FORCE_OVERWRITE(?!:)/,
    `强制覆盖不能被当成这一支的出路：${fields.remedy}`);
  sandbox.dispose();
});

test("a read-side damaged registry keeps the file-repair remedy it is right about", async () => {
  // The other half of B5: the fix is to transcribe the registry's own remedy **when it has
  // one**, never to drop `projectErrorRemedy`. A registry whose bytes do not decode has no
  // remedy of its own and the code-derived one is the honest answer.
  const sandbox = privateSandbox("gp-shell-b5-damaged-");
  const file = path.join(sandbox.dir, "projects.json");
  fs.writeFileSync(file, '[{"projectId":"prj_0123456789ABCDEFGHJKMNPQRS","displayName":"A","pid":not-a-number}]', "utf8");
  const text = await withProjectsFile(file, async () => {
    const outcome = await executeTool(
      TOOL_BY_NAME.get("gp_project_list"),
      {},
      { call: () => Promise.reject(new Error("unused")) },
      new EvidenceAuditSession(),
    );
    return outcome.content[0].text;
  });
  const fields = fieldsOf(text);
  assert.equal(fields.code, "GP_E_INTERNAL", text.slice(0, 200));
  assert.match(fields.remedy, /repair or restore the damaged entry/, fields.remedy.slice(0, 220));
  sandbox.dispose();
});

test("the reported-root path is untouched by any of this", async () => {
  // Control for the whole file: the gate added for B1 must not move the answer this module
  // gives when nothing overrides it — that path is the daemon's root and `daemonProjectsPath`
  // is its only authority.
  const sandbox = privateSandbox("gp-shell-b5-control-");
  await withProjectsFile(null, async () => {
    assert.equal(
      daemonProjectsPath(sandbox.dir),
      path.join(sandbox.dir, "projects.json"),
      "daemon 报的根仍然直接落在 <root>/projects.json",
    );
    const created = projectSet({ displayName: "B5 control", bundleId: "test.b5.control" }, sandbox.dir);
    assert.match(created.projectId, /^prj_/);
    assert.match(created.daemonRestartNotice, /the state root the running daemon reported/, created.daemonRestartNotice);
  });
  sandbox.dispose();
});
