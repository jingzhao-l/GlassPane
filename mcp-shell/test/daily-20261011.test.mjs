/**
 * 2026-10-11 每日轮 · mcp-shell 侧的四处修复。
 *
 * 夹具一律来自真过程：真的临时文件与真 inode（漂移那条走的是 `projectSet` 的真实写路径，
 * 不是手搭的错误对象）、真的 `fs.statSync` 模式位、真的 daemon 源文件（`FrameCodec.swift`
 * 的方法表），以及一个真的 `Writable` 桩（它的 `writableLength` 是被读的字段，不是编的返回值）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { describeCapabilityDrift } from "../dist/engine-client.js";
import { TOOL_BY_NAME, DAEMON_FORWARDED_METHODS } from "../dist/tools.js";
import { projectSet, registryDriftReason, PROJECTS_FILE_ENV } from "../dist/project-registry.js";
import { readUpdateState } from "../dist/update-state.js";
import { DrainAwareWriter, STDIO_WRITE_BACKLOG_BYTES } from "../dist/io.js";

/* ---------------------------------------------- 1. 丢更新拒绝的代号与 remedy */

test("丢更新的判据能红，抛出点用的是词表里的代号（remedy 不再指回刚被排除的成因）", () => {
  // `projectSet` 是同步的：读盘与写盘之间插不进第二次写，所以"守卫真的会拦"只能把判据
  // 本身拿出来测（这条是模块自己的注释立的规矩），再用结构断言核对抛出点用的是哪个代号。
  assert.equal(registryDriftReason("/tmp/projects.json", "ino:7:123", "ino:7:123"), null,
    "身份没变就说没事——把每次正常写都判成漂移的闸等于把工具关掉了");
  for (const [was, now] of [["ino:7:123", "ino:8:999"], [null, "ino:8:999"], ["ino:7:123", null]]) {
    const reason = registryDriftReason("/tmp/projects.json", was, now);
    assert.ok(reason, `盘从 ${String(was)} 变成 ${String(now)} 必须拒`);
    assert.match(reason, /wrote nothing/, "要说清这次什么都没写");
    assert.match(reason, /Repeat gp_project_set/, "并给出可执行的下一步：再读一次盘再来一遍");
  }

  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gp-drift-"));
  const file = path.join(dir, "projects.json");
  const existing = "prj_00000000000000000000000000";
  process.env[PROJECTS_FILE_ENV] = file;
  try {
    fs.writeFileSync(file, JSON.stringify([{
      projectId: existing, displayName: "first", bundleId: "first",
      createdAt: "2026-10-11T00:00:00.000Z",
    }]), { mode: 0o600 });
    const patched = projectSet({ projectId: existing, displayName: "second" });
    assert.equal(patched.displayName, "second", "对照：正常的补丁式登记要真能写");
    assert.equal(patched.requiresDaemonRestart, true, "写完但活着的服务仍读它启动时那份——这条要说");

    // 结构断言：抛出点用的是词表里的代号，越词的那个字面量不许还活着。
    const registry = fs.readFileSync(path.resolve(import.meta.dirname, "..", "dist", "project-registry.js"), "utf8");
    assert.match(registry, /new ProjectRegistryError\(\s*GP_E_REGISTRY_DRIFT/, "拒绝必须走 GP_E_* 词表");
    assert.doesNotMatch(registry, /registry-changed-underneath/, "那条越出词表的字面量不得留下尸体");
    const tools = fs.readFileSync(path.resolve(import.meta.dirname, "..", "dist", "tools.js"), "utf8");
    assert.match(tools, /GP_E_REGISTRY_DRIFT[\s\S]{0,600}gp_project_set/,
      "这一码必须有自己的一句 remedy，否则落到 \"check the tool's input schema\" 那条兜底——而参数早已过了 zod 校验");
  } finally {
    delete process.env[PROJECTS_FILE_ENV];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------- 2. gp_observe 的空 role */

test("gp_observe 不接受空 role：空的等值过滤答不出\"这个 app 没有无障碍内容\"", () => {
  const spec = TOOL_BY_NAME.get("gp_observe");
  assert.ok(spec, "gp_observe 必须在工具表里");
  const empty = spec.validate({ role: "" });
  assert.equal(empty.ok, false, "空串从前被收下并回 nodeCount:0 —— 那是对着一屏元素说没有元素");
  const named = spec.validate({ role: "AXButton" });
  assert.equal(named.ok, true, "对照：真角色名必须照过");
  const omitted = spec.validate({});
  assert.equal(omitted.ok, true, "对照：不给 role 是\"不过滤\"，仍然合法");
});

/* ---------------------------------------------- 3. hello.capabilities 有了读者 */

test("能力对账：一致时无话可说，缺了与多了各说各的", () => {
  const forwarded = ["attach", "act", "observe", "restore"];
  assert.equal(describeCapabilityDrift(forwarded.slice(), forwarded), null,
    "两边一致时不得编出一句话——那会让这条读者变成噪音");

  const stripped = ["attach", "act"];
  const missing = describeCapabilityDrift(stripped, forwarded);
  assert.ok(missing, "壳转发而 daemon 不列的方法必须被点名");
  assert.match(missing, /observe/);
  assert.match(missing, /methodNotFound/, "要说清后果：那条调用会被 daemon 拒");

  const extra = describeCapabilityDrift([...forwarded, "capture_view"], forwarded);
  assert.ok(extra);
  assert.match(extra, /capture_view/);
  assert.match(extra, /not an error/, "daemon 有而壳没暴露不是缺陷，但要说出来");

  const none = describeCapabilityDrift(null, forwarded);
  assert.ok(none);
  assert.match(none, /unverified/, "没有清单就是没测过，不许当成\"清单齐全\"");
});

test("壳转发的方法集与 daemon 的方法表逐字一致（读者不是只给自己看的）", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "engine", "Sources", "GlassPaneEngine", "FrameCodec.swift"),
    "utf8",
  );
  const block = /public enum EngineMethod: String, CaseIterable \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, "读不到 daemon 的方法表，这条对照就没有对照物");
  const declared = new Set();
  for (const rawLine of block[1].split("\n")) {
    // 注释要剥掉：方法表右边就是每条能力的说明文字，留着会把中文当成名字。
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line.startsWith("case ")) continue;
    for (const piece of line.replace(/^case\s+/, "").split(",")) {
      const token = piece.trim();
      if (!token) continue;
      const named = /^([A-Za-z]+)\s*=\s*"([a-z_]+)"$/.exec(token);
      if (named !== null) {
        declared.add(named[2]);
        continue;
      }
      assert.match(token, /^[A-Za-z]+$/, `daemon 方法表里有一行读不出名字：${JSON.stringify(token)}`);
      declared.add(token.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`).replace(/^_/, ""));
    }
  }
  assert.ok(declared.size >= 11, `只认出 ${declared.size} 个方法名，这条对照已经看不见东西：${[...declared].join(",")}`);
  // hello 的清单去掉 hello 与 shutdown 两个纯传输方法（FrameCodec 里那条 filter）。
  declared.delete("hello");
  declared.delete("shutdown");
  const shell = new Set(DAEMON_FORWARDED_METHODS);
  const notForwarded = [...declared].filter((method) => !shell.has(method));
  const invented = [...shell].filter((method) => !declared.has(method));
  assert.deepEqual(invented, [], `壳转发了 daemon 方法表里没有的名字：${invented.join(", ")}`);
  // 反向不要求"透明转发"：`capture_view` 这类有自己的 execute，是壳内实现而不是直通。
  // 它要求的是更弱也更真的一条：**每条 daemon 能力都得有某个工具指着它**，否则
  // 能力就长在壳外面没人能调到（当年 `checkpoint` 就是这么线上失踪的）。
  const addressed = new Set([...TOOL_BY_NAME.values()].map((spec) => spec.engineMethod));
  const unreachable = notForwarded.filter((method) => !addressed.has(method));
  assert.deepEqual(unreachable.sort(), [],
    `daemon 有这条能力，但没有任何 gp_* 工具指着它：${unreachable.join(", ")}`);
});

/* ---------------------------------------------- 4. update-state 的模式判据 */

test("group/world 可读的 update-state 被拒，而不是被当成事实念出来", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gp-upstate-mode-"));
  const body = JSON.stringify({ schemaVersion: 1, status: "up-to-date", current: "1.6.2", latest: "1.6.2" });
  try {
    const loose = path.join(dir, "loose");
    fs.mkdirSync(loose);
    fs.writeFileSync(path.join(loose, "update-state.json"), body, { mode: 0o644 });
    const reading = readUpdateState({}, loose);
    assert.equal(reading.kind, "unreadable", "0644 那份从前照样被读并交给 gp_diagnose");
    assert.match(reading.summary, /mode 644/, "句子要报出实测到的模式");
    assert.match(reading.summary, /chmod 600/, "并给出可执行的修法");

    const tight = path.join(dir, "tight");
    fs.mkdirSync(tight);
    fs.writeFileSync(path.join(tight, "update-state.json"), body, { mode: 0o600 });
    const ok = readUpdateState({}, tight);
    assert.notEqual(ok.kind, "unreadable", "对照：0600 那份必须照读，否则这条闸只是永远拒");

    const notFile = path.join(dir, "dirish");
    fs.mkdirSync(path.join(notFile, "update-state.json"), { recursive: true });
    assert.equal(readUpdateState({}, notFile).kind, "unreadable", "目录冒充状态文件也得拒");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------- 5. stdio 回包的积压上限 */

function sinkWithBacklog(bytes) {
  const written = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      written.push(chunk.toString());
      callback();
    },
  });
  Object.defineProperty(sink, "writableLength", { get: () => bytes, configurable: true });
  return { sink, written };
}

test("读不走的那一端不再把回包堆成无界内存：到线就丢、点名、说原因", async () => {
  const notes = [];
  const { sink, written } = sinkWithBacklog(STDIO_WRITE_BACKLOG_BYTES + 1);
  const writer = new DrainAwareWriter(sink, (note) => notes.push(note), 50, () => {});
  const delivered = await writer.write('{"jsonrpc":"2.0","id":7,"result":{}}\n');
  assert.equal(delivered, false, "积压过线时不得再往队列里塞");
  assert.equal(written.length, 0, "被丢的那一帧一个字都不该写出去");
  assert.equal(writer.droppedFrames, 1, "丢了多少必须有读者，不能静默收缩");
  assert.match(notes.join("\n"), /dropped, not queued/);
  assert.match(notes.join("\n"), new RegExp(String(STDIO_WRITE_BACKLOG_BYTES)), "句子要说清上限是多少");

  // 对照：没到线时必须照写——否则这条闸只是永远丢。
  const calm = sinkWithBacklog(0);
  const calmWriter = new DrainAwareWriter(calm.sink, () => {}, 50, () => {});
  assert.equal(await calmWriter.write('{"jsonrpc":"2.0","id":8,"result":{}}\n'), true);
  assert.equal(calm.written.length, 1);
  assert.equal(calmWriter.droppedFrames, 0);
});
