/**
 * 本轮（2026-11-03）MCP 壳这一侧的七条修复，各自一条能红的对照。
 *
 * 共同形状：**同一件事在两个入口/两份表里被写了两次，其中一处改了、另一处没改**。
 * 网关与 stdio 对 daemon 报文的一致性、schema 上界与 registry 常量、remedy 里裸的命令名
 * 与"裸名走不受控 PATH"这条自己立下的规矩、状态根的环境变量与 daemon 从不读它的事实、
 * 摘要声称的字节与实际参与计算的字节——每一条都是 A 面已经对、B 面还在按旧行为走。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { McpServer } from "../dist/dispatch.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { LineReader } from "../dist/io.js";
import { frameBodyNotLoggedNote } from "../dist/engine-client.js";
import { readUpdateState, STATE_DIR_ENV } from "../dist/update-state.js";
import { makeEngine } from "./helpers.mjs";
import { emptyState } from "../../updater/lib/state.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (name) => fs.readFileSync(path.join(SRC, name), "utf8");

function makeServer() {
  const { engine, io } = makeEngine();
  return { server: new McpServer({ engine, session: new EvidenceAuditSession() }), io };
}

/* ------------------------------------------------ 1. 协议错也必须有 remedy */

test("五条协议错臂都给 remedy：三条从前只回一句话，兄弟两臂却写着 | remedy:", async () => {
  const { server } = makeServer();
  const arms = [
    { name: "Parse error", line: "这不是 JSON" },
    { name: "Invalid Request", line: JSON.stringify({ jsonrpc: "2.0", id: 1, method: 42 }) },
    { name: "Method not found", line: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/launch" }) },
  ];
  for (const arm of arms) {
    const answer = await server.handleLine(arm.line);
    assert.ok(answer?.error, `${arm.name} 没有回错误帧：${JSON.stringify(answer)}`);
    assert.match(answer.error.message, /\| remedy: /,
      `${arm.name} 这一臂只报了代号，代理拿着它不知道下一步：${answer.error.message}`);
  }
});

test("remedy 里点名的 method 真的存在（出路不许指着这一版没有的东西）", async () => {
  const { server } = makeServer();
  const answer = await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "nope" }));
  const remedy = answer.error.message;
  for (const named of ["initialize", "ping", "tools/list", "tools/call"]) {
    assert.ok(remedy.includes(named), `remedy 该点名这四个之一，实际：${remedy}`);
  }
});

/* ------------------------------------ 2. 两个门面对 daemon 报同一套一致性 */

test("网关与 stdio 建客户端时交出去的握手判据必须一样多", () => {
  const pairs = {
    "stdio-session.ts": ["identity: { version: SERVER_INFO.version }", "expectedDaemonMethods: DAEMON_FORWARDED_METHODS"],
    "http-gateway.ts": ["identity: { version: SERVER_INFO.version }", "expectedDaemonMethods: DAEMON_FORWARDED_METHODS"],
  };
  for (const [file, needles] of Object.entries(pairs)) {
    const source = read(file);
    const call = source.slice(source.indexOf("unixSocketEngineClient("));
    for (const needle of needles) {
      assert.ok(call.slice(0, 900).includes(needle),
        `${file} 的 unixSocketEngineClient(...) 没带 ${needle}：那一面的版本/能力漂移就没人报（缺陷 #17）`);
    }
  }
});

/* ------------------------------------- 3. schema 上界只有一个来源 */

test("gp_project_set 的对外上界读的是 registry 的常量，不是重抄的字面量", () => {
  const registry = read("project-registry.ts");
  const tools = read("tools.ts");
  const display = /export const MAX_DISPLAY_NAME_LENGTH = (\d+)/.exec(registry)?.[1];
  const field = /export const MAX_FIELD_LENGTH = (\d+)/.exec(registry)?.[1];
  assert.ok(display && field, "registry 的两个上界不再是导出的：另一个来源就是字面量");
  assert.ok(tools.includes("MAX_DISPLAY_NAME_LENGTH,") && tools.includes("MAX_FIELD_LENGTH,"),
    "tools.ts 没有 import 这两个常量");
  assert.ok(!/maxLength: 256/.test(tools), `对外 schema 里还留着抄来的 256：改一处漂两处（缺陷 #20）`);
  assert.ok(!/maxLength: 1024/.test(tools), "对外 schema 里还留着抄来的 1024");
});

/* --------------------------------------- 4. remedy 里的命令必须真的跑得动 */

test("remedy 不许把 daemon 写成裸名：裸名走的是这个读者控制不了的 PATH", () => {
  const files = ["project-registry.ts", "tools.ts", "update-state.ts", "engine-client.ts"];
  const bare = [];
  for (const name of files) {
    const source = read(name);
    source.split("\n").forEach((line, i) => {
      // 注释里的 `glasspaned/main.swift`、旗标名 `glasspaned --permissions` 这类**指代码位置**的
      // 写法不算：这里问的是"把一个动词交给读者去执行"。
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/(?<![\w/."-])glasspaned --/.test(line)) bare.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(bare, [], `这些出路印的是裸命令名：${bare.join(", ")}`);
  const absolute = read("project-registry.ts") + read("tools.ts");
  const hits = (absolute.match(/Applications\/GlassPane Daemon\.app\/Contents\/MacOS\/glasspaned/g) ?? []).length;
  assert.ok(hits >= 8, `绝对形态只剩 ${hits} 处，八处出路不可能都指得动（空转对照）`);
});

/* ------------------------------------- 5. 状态根：谁读的、谁不读，要说明白 */

test(`${STATE_DIR_ENV} 驱动的读数必须自己声明 daemon 从不读这枚变量`, () => {
  // 真的把那份状态文件写进这棵根里：`readUpdateState` 对不存在的根回的是 `absent`，
  // 而 absent 那一支根本不读环境变量指的位置——前提不成立的话这条测试什么都不是。
  const root = fs.mkdtempSync("/tmp/gp-state-dir-attribution-");
  // 形状来自真写者：`updater/lib/state.js` 的 `emptyState()`——壳这一面读的就是那一份的字节，
  // 桩里编出来的形状只会测到"壳认得桩"，测不到壳认得更新器。
  fs.writeFileSync(path.join(root, "update-state.json"), JSON.stringify(emptyState()), { mode: 0o600 });
  let reading;
  try {
    reading = readUpdateState({ [STATE_DIR_ENV]: root, HOME: "/tmp/gp-home" });
    assert.equal(reading.kind, "read", `前提：这一趟要走到 read 那一支，实际 ${reading.kind}`);
    assert.match(reading.summary, /state root taken from GLASSPANE_STATE_DIR/, reading.summary);
    assert.match(reading.summary, /never reads that variable/, "必须说清后台服务不读这枚变量，否则'新鲜/陈旧'是在替别人的状态根作答");
  // 对照：没有那枚变量时不许冒出这句话（否则这条判据就成了无条件打印）。
  const plain = readUpdateState({ HOME: root });
    assert.ok(!/state root taken from/.test(plain.summary), plain.summary);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------------- 6. 摘要算的是线字节，不是重编码后的文本 */

test("行读器把线字节交给读者：非 UTF-8 帧的摘要仍等于那串字节的 sha256", () => {
  const wire = Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x31, 0x7d, 0xff, 0xfe, 0x0a]);
  let gotText = null;
  let gotRaw = null;
  const reader = new LineReader({
    onLine: (line, raw) => { gotText = line; gotRaw = raw ?? null; },
    onOversize: () => { throw new Error("不该走到这一支"); },
  });
  reader.push(wire.subarray(0, 5));
  reader.push(wire.subarray(5));
  assert.ok(gotRaw, "喂的是 Buffer，onLine 却没拿到线字节：那句 'exact bytes' 又是假的");
  assert.deepEqual([...gotRaw], [...wire.subarray(0, wire.length - 1)], "线字节必须逐字节等于到达的那一串");
  const note = frameBodyNotLoggedNote(gotText, gotRaw);
  const digest = createHash("sha256").update(gotRaw).digest("hex").slice(0, 12);
  assert.ok(note.includes(`sha256 ${digest}, of the exact bytes this transport received`), note);
  assert.ok(note.includes(`${gotRaw.length}-byte frame`), note);
  // 反面对照：文本与字节不等长时（解码丢了字节），不许谎称"exact bytes"。
  const textOnly = frameBodyNotLoggedNote(gotText);
  assert.match(textOnly, /of the frame text as this transport decoded it/, textOnly);
});

test("文本流照样读：setEncoding 的那条旧路径不许被这次改动打死", () => {
  const seen = [];
  const reader = new LineReader({ onLine: (line) => seen.push(line), onOversize: () => {} });
  reader.push('{"id":1}\n{"id":2}\n');
  reader.push('{"id":');
  reader.push("3}\n");
  assert.deepEqual(seen, ['{"id":1}', '{"id":2}', '{"id":3}']);
});
