/**
 * 2026-10-27 (F3) —— 迟到回复的诊断句不许把屏幕内容抄进一条本产品不拥有的日志。
 *
 * 一个 daemon 回复如果在其调用方的 deadline 之后才到，这道壳仍然要把"它答了"这件事记下来，
 * 但要记的是**诊断事实**（方法名、字节数、一段确定性摘要），不是回复正文本身。正文在这条路上
 * 是 observe/assert 的内容——元素的 title/value、有时是一份文档的文本，单帧最多到
 * LOG_BODY_CHARS。状态根是 0700，可这条日志落进的 stderr 归 supervising 它的进程管，而这个
 * 产品从没设过那个文件的 mode。F3 之前的两处都在往外写正文：HTTP 那扇门直接把
 * `truncate(stringifyReply(result))` 写进 report（当年还自称"raw engine content and not
 * redacted"），MCP/stdio 那扇门走 `engine-client.ts` 内部那条 report。
 *
 * 修法是把这句话**只写一遍**：`engine-client.ts`（那本日志预算的主人）导出
 * `lateReplyBodyNote`，两处都调它，于是它们不可能漂移。本文件钉三件事：
 *  · 两扇门各自的迟到回复 note 都含方法名、字节数与 sha256 摘要，且**不含**正文里的标记串；
 *  · 两扇门含的是**同一句** `lateReplyBodyNote(...)`（authored once 的直接证据）；
 *  · note 点明正文没写、真内容在 daemon 的证据档案里、用 `gp_last_evidence` /
 *    `gp_export_evidence` 读回——这两个工具名必须是 `tools.ts` 里真实存在的。
 *
 * REVERSE MUTATION（在本机验证过，跑完即还原并核对 sha）：把 `http-gateway.ts` 那句
 * `report(...)` 换回 `${truncate(stringifyReply(result))}` 的原始正文 ⇒ 本文件 HTTP 那条
 * "不含 SECRET-TREE-TEXT-MARKER" 的断言当场点名变红；把 `engine-client.ts` 内部那条
 * `report(...)` 的 `${lateReplyBodyNote(bodyJson)}` 换回 `${bodyJson}` ⇒ stdio 那条变红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createHttpGateway } from "../dist/http-gateway.js";
import { EngineJsonRpcClient, lateReplyBodyNote } from "../dist/engine-client.js";
import { TOOL_SPECS } from "../dist/tools.js";
import { FakeLineIo } from "./helpers.mjs";

// 正文里两处独有的字符串：一处当"别泄漏"的标记，一处模拟 act 回复里的 operationId。
const MARKER = "SECRET-TREE-TEXT-MARKER";
const OP_ID = "op_late_reply_should_not_appear";
const REPLY = { tree: MARKER, operationId: OP_ID };
const SERIALIZED = JSON.stringify(REPLY);

const TEST_TOKEN = "late-reply-redaction-token-0123456789";
const digestOf = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

/**
 * 钉住一条迟到回复 note 的诊断形状：方法名 + 字节数 + 确定性摘要 + "正文没写" + 证据档案回读，
 * 且绝不含正文标记。两扇门共用这一个断言，正是"同一句话"的落点。
 */
function assertLateReplyNote(note, method) {
  assert.ok(note, "迟到回复必须留下一行，不能被静静丢掉");
  // 方法名点名是哪一条请求。
  assert.match(note, new RegExp(`'${method}'`), note);
  // 字节数：让操作者知道这一帧多大，够不够得着档案里的那条。
  assert.match(note, /\b\d+-byte body\b/, `note 要报出字节数：${note}`);
  assert.match(note, new RegExp(`${Buffer.byteLength(SERIALIZED, "utf8")}-byte body`),
    `报出的字节数必须是这条正文序列化后的真实长度：${note}`);
  // 摘要：确定性、可复算，用来把这条 note 和档案里那一包对上。
  assert.match(note, /sha256 [0-9a-f]{12}/, `note 要带一段 12 位 sha256 摘要：${note}`);
  assert.ok(note.includes(digestOf(SERIALIZED)),
    `摘要必须是这条序列化正文 SHA-256 的前 12 位（${digestOf(SERIALIZED)}）：${note}`);
  // 明说正文没写，并指回真内容在哪、用什么工具读。
  assert.match(note, /not written/, `note 要说明正文没写进日志：${note}`);
  assert.match(note, /evidence archive/, `note 要指明真内容在证据档案：${note}`);
  assert.match(note, /gp_last_evidence/, `note 要给真实存在的读回工具 gp_last_evidence：${note}`);
  assert.match(note, /gp_export_evidence/, `note 要给真实存在的读回工具 gp_export_evidence：${note}`);
  // 本条缺陷本体：屏幕内容绝不落进这条日志。
  assert.ok(!note.includes(MARKER), `正文标记泄漏进了日志：${note}`);
  assert.ok(!note.includes(OP_ID), `operationId 泄漏进了日志：${note}`);
  // authored once 的直接证据：这行里含的就是 engine-client.ts 那一句 `lateReplyBodyNote`。
  assert.ok(note.includes(lateReplyBodyNote(SERIALIZED)),
    `这扇门写的必须是 engine-client.ts 那一遍成文的句子：${note}`);
}

/* ---------------------------------------------------------------- *
 * 门一：HTTP gateway 的 late-reply sink。
 * ---------------------------------------------------------------- */
class FakeGatewayClient {
  constructor() {
    this.calls = [];
  }

  call() {
    return Promise.resolve({});
  }

  onEngineNote() {}

  onLateReply(handler) {
    this.lateHandler = handler;
  }
}

test("F3 HTTP 那扇门的迟到回复 note 报方法名/字节/摘要，且不落屏幕正文", async () => {
  const fake = new FakeGatewayClient();
  const notes = [];
  const gw = createHttpGateway({
    socketPath: "/tmp/fake-engine-late.sock",
    token: TEST_TOKEN,
    port: 0,
    connectController: () => fake,
    report: (note) => notes.push(note),
  });
  await new Promise((resolve) => gw.server.once("listening", resolve));
  try {
    assert.equal(typeof fake.lateHandler, "function", "gateway 必须注册 late-reply sink");
    fake.lateHandler({ method: "observe", result: REPLY });
    const note = notes.find((line) => line.includes("late engine reply to 'observe'"));
    assertLateReplyNote(note, "observe");
  } finally {
    if (typeof gw.close === "function") await gw.close().catch(() => {});
    else gw.server.close();
  }
});

/* ---------------------------------------------------------------- *
 * 门二：stdio/MCP 那扇门（engine-client 内部那条 report，经 onEngineNote 落到 stderr）。
 * ---------------------------------------------------------------- */
test("F3 stdio 那扇门的迟到回复 note 与 HTTP 那扇说同一句，且不落屏幕正文", async () => {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 30); // 30ms deadline：调用先被判超时
  const notes = [];
  client.onEngineNote((note) => notes.push(note));

  const promise = client.call("observe", { maxDepth: 8 });
  const frame = io.lastFrame();
  await assert.rejects(promise, (err) => err.code === "GP_E_ENGINE_TIMEOUT");

  // daemon 在超时之后才答：这条迟到的结果帧走 reportLateReply → 内部 note。
  io.send(JSON.stringify({ id: frame.id, result: REPLY }));
  await new Promise((resolve) => setImmediate(resolve));

  const note = notes.find((line) => /late engine reply for 'observe'/.test(line));
  assertLateReplyNote(note, "observe");
});

test("F3 两扇门写的确实是同一句 lateReplyBodyNote，不可能各写一套说法", async () => {
  // 这条不依赖任何 transport，直接钉"authored once"这件事：句子只能有一个出处。
  const sentence = lateReplyBodyNote(SERIALIZED);
  assert.ok(sentence.includes(`${Buffer.byteLength(SERIALIZED, "utf8")}-byte body`), sentence);
  assert.ok(sentence.includes(`sha256 ${digestOf(SERIALIZED)}`), sentence);
  assert.ok(/not written/.test(sentence), sentence);
  assert.ok(!sentence.includes(MARKER) && !sentence.includes(OP_ID),
    `这一句本身就不许含正文标记：${sentence}`);
  // 摘要对同样的字节是确定的（否则 correlating 无从谈起）。
  assert.equal(digestOf(SERIALIZED), digestOf(SERIALIZED));
  assert.equal(lateReplyBodyNote(SERIALIZED), sentence);
});

test("F3 note 引用的回读工具是 tools.ts 里真实存在的名字", () => {
  const names = new Set(TOOL_SPECS.map((spec) => spec.name));
  for (const tool of ["gp_last_evidence", "gp_export_evidence"]) {
    assert.ok(names.has(tool), `note 指向的 ${tool} 不是真实存在的工具名`);
  }
});
