import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { engineClientOver } from "../dist/engine-client.js";
import { readUpdateState } from "../dist/update-state.js";
import { describeFetchFailure } from "../dist/tools.js";
import { daemonProjectsPath, daemonRestartNotice, projectSet, projectList } from "../dist/project-registry.js";
import { FakeLineIo } from "./helpers.mjs";

/**
 * 2026-10-20 每日轮的壳侧修复。夹具一律取真报文/真文件的形状：帧是 daemon 真会在 socket 上
 * 吐出的字节（这台机器没有 peer 鉴权，任何同用户进程都能写这一行，所以"壳必须拒"是可跑的
 * 前提，不是一个假想），状态文件是 updater 真会落的那种 0600 档案。
 */

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

function privateTempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gp-${label}-`));
  fs.chmodSync(root, 0o700);
  return root;
}

// MARK: - `null` 状态文件不许把 gp_diagnose 变成一次壳内崩溃

test("a state file whose whole body is null is refused as a state, not crashed over", () => {
  const root = privateTempRoot("nullstate");
  try {
    const file = path.join(root, "update-state.json");
    fs.writeFileSync(file, "null\n", { mode: 0o600 });
    // 修之前：JSON.parse("null") 成功，`parsed.status` 抛出 TypeError，整次工具调用被
    // 顶层 catch 折成 GP_E_INTERNAL —— daemon 真正的诊断被丢掉。
    const reading = readUpdateState({}, root);
    assert.equal(reading.kind, "unreadable", JSON.stringify(reading));
    assert.match(reading.summary, /top level is null/, reading.summary);
    assert.match(reading.summary, /not the same as up to date/, "缺席不许读成最新");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the same reader still accepts a real state object, so the refusal is not a permanent no", () => {
  const root = privateTempRoot("goodstate");
  try {
    const file = path.join(root, "update-state.json");
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: "glasspane.update-state/0.1",
      status: "up-to-date", code: null, current: "1.17.0", latest: "1.17.0",
      lastCheckAt: new Date().toISOString(), staged: null,
    })}\n`, { mode: 0o600 });
    const reading = readUpdateState({}, root);
    assert.equal(reading.kind, "read", JSON.stringify(reading));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// MARK: - 一帧 `result: null` 不是答案，不许点亮绿

test("a frame carrying result:null is refused instead of resolving an empty answer", async () => {
  const io = new FakeLineIo();
  const client = engineClientOver(io, 500);
  const promise = client.call("snapshot");
  const frame = io.lastFrame();
  // daemon 的 `Dispatcher.response(result:)` 今天发不出顶层 null，但这根 socket 无 peer 鉴权：
  // 任何同用户进程都能写下这一行。壳层替引擎把"什么都没答"填成答案，正是 capture_view
  // 那条 `persisted !== false` 规矩禁止的。
  io.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: null }));
  const error = await promise.then(
    () => { throw new Error("result:null 被当成成功交上去了") },
    (caught) => caught,
  );
  assert.equal(error.code, "GP_E_INTERNAL");
  assert.match(error.message, /result is null/, error.message);
  assert.match(error.remedy, /answered nothing/, "出路必须阻止调用方把这一轮读成成功");
  client.close();
});

test("the missing-key branch still refuses, and a real result still resolves", async () => {
  const io = new FakeLineIo();
  const client = engineClientOver(io, 500);
  const missing = client.call("snapshot");
  io.send(JSON.stringify({ jsonrpc: "2.0", id: io.lastFrame().id }));
  const error = await missing.then(() => null, (caught) => caught);
  assert.match(error.message, /neither result nor error/, "对照臂：少了键的旧判据还在");
  const okPromise = client.call("snapshot");
  io.respond({ snapshotId: "snap_1" });
  assert.deepEqual(await okPromise, { snapshotId: "snap_1" });
  client.close();
});

// MARK: - 部分报告里的错误仍是三字段，不留一句裸文本

test("describeFetchFailure never emits a two-field error for a mapped refusal", () => {
  const EngineCallErrorModule = "../dist/engine-client.js";
  return import(EngineCallErrorModule).then(({ EngineCallError }) => {
    const asEngine = describeFetchFailure(new EngineCallError("GP_E_NO_EVIDENCE", "no pack", "read gp_last_evidence"));
    assert.match(asEngine, /GP_E_NO_EVIDENCE/);
    assert.match(asEngine, /remedy/, "daemon 的三字段必须原样带上");
    const other = describeFetchFailure(new Error("a shape this shell cannot map"));
    assert.match(other, /GP_E_INTERNAL/);
    assert.match(other, /remedy/, "未知失败的每一支也得是三字段，不能是一句话");
  });
});

// MARK: - 注册表写进 daemon 自己报的那个根，而不是 $HOME 猜的那个

test("the project tools write where the running daemon said it lives", () => {
  const previousOverride = process.env.GLASSPANE_PROJECTS_FILE;
  delete process.env.GLASSPANE_PROJECTS_FILE;
  const root = privateTempRoot("reported-root");
  try {
    const entry = projectSet({ displayName: "Sandboxed project", bundleId: "test.sandbox.app" }, root);
    const written = path.join(root, "projects.json");
    assert.ok(fs.existsSync(written), `注册必须落在 daemon 报的那个根里：${JSON.stringify(entry)}`);
    assert.equal(projectList(root).find((one) => one.projectId === entry.projectId).bundleId, "test.sandbox.app");
    assert.notEqual(path.resolve(written), path.resolve(daemonProjectsPath(null)),
      "home 默认根与 daemon 报的根必须能分开，否则这条修复没有改变任何行为");
    assert.match(entry.daemonRestartNotice, /the state root the running daemon reported/, entry.daemonRestartNotice);
    assert.match(entry.daemonRestartNotice, /launchctl kickstart/, "落在服务自己的根上时，剩下的动作是重启那一次读取");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (previousOverride !== undefined) process.env.GLASSPANE_PROJECTS_FILE = previousOverride;
  }
});

test("without a reported root the shell still names its answer as a default", () => {
  // `systemHome()` deliberately reads the password record, not `$HOME`, so this must NOT go
  // through a real `projectSet`: with no reported root the write would land in the developer's
  // live `~/.glasspane/projects.json`. The notice is a pure function; judge it as one.
  const homeRoot = daemonProjectsPath(null);
  assert.match(homeRoot, /\.glasspane\/projects\.json$/, homeRoot);
  const stray = daemonProjectsPath("/tmp/somewhere-else");
  assert.notEqual(stray, homeRoot, "报上来的根必须真的改变落点，否则这个参数是装饰");
  const notice = daemonRestartNotice(homeRoot, null);
  assert.match(notice, /not knowable from here/, "没报根时不许说这是服务正在读的文件");
  assert.match(notice, /no stateRoot/, "并且要说清为什么不知道：这份 daemon 的 hello 里没有那个键");
  const reported = daemonRestartNotice(path.join("/tmp/reported", "projects.json"), "/tmp/reported");
  assert.match(reported, /the state root the running daemon reported/, reported);
  assert.doesNotMatch(reported, /not knowable from here/, "报了根就不再有一格是猜的");
});
