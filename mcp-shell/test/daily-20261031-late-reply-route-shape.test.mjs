/**
 * 2026-10-31 · lane E, item 2 — 出路不许承诺产品自己禁止存在的内容。
 *
 * `lateReplyRoute("http")` 从前对 HTTP 调用方说："回复会连同**正文**写进本 gateway 的
 * stderr，operationId 从那行读"。真实 sink（`http-gateway.ts` 的 late-reply 注册，正文交给
 * `engine-client.ts` 的 `lateReplyBodyNote`）写的是字节数 + 一段 12 位 sha256，并且**明说
 * 正文不写**；operationId 只在它合上档案语法 `ARCHIVE_OPERATION_ID` 时才作为 `, for <id>`
 * 印出来。出路指向一条本产品自己否掉的字节 = 不可执行：curl 读者会去 stderr 里找一个永远
 * 不会在那儿出现的东西，而这条拒绝存在的理由正是信任边界（屏幕内容不进一个产品没设过 mode
 * 的日志文件，review 2026-10-09 finding 3 / F3 2026-10-27）。
 *
 * 所以改的是句子，不是 sink：反方向把 sink 改成写正文会把这条边界拆掉。
 *
 * 本文件不"各测各的"：它把出路里用反引号抄出来的那半行取回来，把占位符换成**这一条回复
 * 实测**的字节数与摘要，要求在真网关真写的日志行里逐字出现；id 那一档同理两个方向都测。
 *
 * REVERSE MUTATION（本机验证，`cp` 备份还原并核对 sha256）：把 `lateReplyRoute` 的 http 分支
 * 换回旧句子（"…written to this gateway's stderr with its body, so the operationId it carries
 * can be read off that line…"）⇒「逐字」「id 出现在行上」「语法不合就没有 id」三条一起变红；
 * 反过来把 `lateReplyBodyNote` 改成 `${serializedBody}`（写出正文）⇒ 本文件的"正文不落进日志"
 * 断言变红，那条改动本身也是被 `daily-20261027-late-reply-redaction.test.mjs` 禁止的。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createHttpGateway } from "../dist/http-gateway.js";
import { lateReplyRoute } from "../dist/engine-client.js";
import { TOOL_SPECS } from "../dist/tools.js";

const MARKER = "SECRET-ON-SCREEN-TEXT-MUST-NOT-REACH-THIS-LOG";
/** The archive grammar in `engine-client.ts`: `op_` + 26 Crockford characters. */
const ARCHIVE_ID = "op_AAAAAAAAAAAAAAAAAAAAAAAAAA";
/** Same field, a value the grammar refuses (lowercase), so the line must name no id. */
const UNSHAPED_ID = "op_not-archive-shaped";

const TEST_TOKEN = "late-reply-route-shape-token-0123456789";

/**
 * A client the gateway believes is the engine: it captures the late-reply sink the
 * gateway registers, so the test can hand it a reply and read **the gateway's own**
 * report line rather than a paraphrase of it.
 */
class CapturingClient {
  lateHandler = null;

  call(method) {
    return Promise.resolve({ method });
  }

  onEngineNote() {}

  onLateReply(handler) {
    this.lateHandler = handler;
  }
}

/**
 * Start the real gateway over the capturing client and hand back one thing that
 * matters: a function that runs the gateway's registered late-reply sink against a
 * reply body and returns the line the gateway itself wrote.
 */
async function gatewayLineWriter() {
  const fake = new CapturingClient();
  const notes = [];
  const gw = createHttpGateway({
    socketPath: "/tmp/fake-engine-late-route.sock",
    token: TEST_TOKEN,
    port: 0,
    connectController: () => fake,
    report: (note) => notes.push(note),
  });
  await new Promise((resolve) => gw.server.once("listening", resolve));
  const base = `http://127.0.0.1:${gw.server.address().port}`;
  return {
    base,
    /** Feed `result` to the sink the gateway registered, and return its log line. */
    emit(result) {
      assert.equal(typeof fake.lateHandler, "function", "gateway 必须注册 late-reply sink");
      fake.lateHandler({ method: "observe", result });
      const line = notes.find((note) => note.includes("late engine reply to 'observe'"));
      assert.ok(line, `网关没有写出迟到回复那一行：${JSON.stringify(notes)}`);
      return line;
    },
    async close() {
      await (typeof gw.close === "function" ? gw.close() : new Promise((resolve) => gw.server.close(resolve)));
    },
  };
}

const serialized = (result) => JSON.stringify(result);
const byteLength = (text) => Buffer.byteLength(text, "utf8");
const digestOf = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

/** The shape the remedy quotes: whatever is between the first pair of backticks. */
function quotedLineShape(remedy) {
  const shape = /reads `([^`]+)`/.exec(remedy);
  assert.ok(shape, `出路句里没有用反引号抄出日志行的形状，这条比对就没有对象：${remedy.slice(0, 240)}`);
  return shape[1];
}

test("出路抄的那半行，逐字就是网关真写的那半行（占位符换成实测值之后）", async () => {
  const gw = await gatewayLineWriter();
  try {
    const reply = { operationId: ARCHIVE_ID, tree: MARKER };
    const line = gw.emit(reply);
    const remedy = lateReplyRoute("http");
    const bytes = byteLength(serialized(reply));
    const digest = digestOf(serialized(reply));

    const rendered = quotedLineShape(remedy)
      .replace("<method>", "observe")
      .replace("<N>", String(bytes))
      .replace("<12 hex>", digest);
    assert.ok(line.includes(rendered),
      `出路承诺的行形状与实际写出的行不一致。\n  出路：${rendered}\n  实写：${line}`);
    // 抄出来的形状不许是空占位：占位符没被替换干净，比对就成了自说自话。
    assert.doesNotMatch(rendered, /<method>|<N>|<12 hex>/, "出路里的占位符没有被实测值填满");

    // 句子对"id 什么时候在行上"的承诺也要对得上：语法合上的那一条，id 就紧跟摘要出现。
    assert.ok(line.includes(`${rendered}, for ${ARCHIVE_ID}`),
      `出路说 id 以 ', for <operationId>' 的形式紧跟摘要，实际那一行不是这样：${line}`);
    // 而正文确实不在行上——这正是旧句子承诺了、产品否掉了的东西。
    assert.ok(!line.includes(MARKER), `正文泄漏进了网关的日志行：${line}`);
    assert.ok(!remedy.includes("with its body"),
      "出路又承诺了正文：那条字节是本产品明确不写的");
    assert.match(line, /not written/, "实写的行要自己说明正文没写");
    assert.match(remedy, /never as its text|not written/, "出路要说清写的是事实而不是正文");
  } finally {
    await gw.close();
  }
});

test("回复的 operationId 不合档案语法 ⇒ 那一行没有可读的 id，出路也不许说有", async () => {
  const gw = await gatewayLineWriter();
  try {
    const line = gw.emit({ operationId: UNSHAPED_ID, tree: MARKER });
    const remedy = lateReplyRoute("http");
    // 实写的一行：没有 `, for <id>` 那一段。
    assert.ok(!line.includes(", for "), `语法不合的 id 被印上了日志行：${line}`);
    assert.ok(!line.includes(UNSHAPED_ID), `不合语法的 id 泄漏进了日志行：${line}`);
    // 出路句必须是**条件句**：它不能对每一条回复都承诺"从那行读 id"。
    assert.match(remedy, /only when/, `出路把 id 说成了无条件可得：${remedy.slice(0, 240)}`);
    assert.doesNotMatch(remedy, /the operationId it carries can be read off/,
      "旧句子那种『总能从那行读到 id』的承诺不许回来");
    // 句子给出的替代事实要真在行上：字节数与摘要始终在。
    assert.match(line, /with a \d+-byte body \(sha256 [0-9a-f]{12}\)/, line);
    assert.ok(lateReplyRoute("http").includes("<12 hex>"), "出路要说出实写的确实是摘要这一档");
  } finally {
    await gw.close();
  }
});

test("出路点名的两条 HTTP 回读路，这道网关真的答（不是 404）", async () => {
  const gw = await gatewayLineWriter();
  const remedy = lateReplyRoute("http");
  try {
    // 出路文本点名的路由必须存在：curl 读者照句子走，第一步就得有门。
    assert.match(remedy, /GET \/v1\/evidence\/<operationId>/, remedy.slice(0, 240));
    assert.match(remedy, /POST \/v1\/tools\/last_evidence/, remedy.slice(0, 240));
    const auth = { Authorization: `Bearer ${TEST_TOKEN}` };

    const evidence = await fetch(`${gw.base}/v1/evidence/${ARCHIVE_ID}`, { headers: auth });
    assert.notEqual(evidence.status, 404, "出路指的一条回读路在这道网关上不存在");

    const last = await fetch(`${gw.base}/v1/tools/last_evidence`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ operationId: ARCHIVE_ID }),
    });
    assert.notEqual(last.status, 404, "出路指的 POST /v1/tools/last_evidence 是条 404");
    // 而这条句子写的是网关真转发的 daemon 方法，不是 MCP 独有的工具名。
    const forwardable = TOOL_SPECS.filter((spec) => spec.execute === undefined).map((spec) => spec.engineMethod);
    assert.ok(forwardable.includes("last_evidence"), "last_evidence 不再是可转发的 daemon 方法");
    assert.doesNotMatch(remedy, /gp_[a-z_]+/, `curl 读者手上没有 gp_* 可调：${remedy.slice(0, 240)}`);
  } finally {
    await gw.close();
  }
});

test("对照：MCP 那一面仍然承诺它真有的证据链，且两面不共用同一句话", () => {
  const mcp = lateReplyRoute("mcp");
  const http = lateReplyRoute("http");
  assert.notEqual(mcp, http, "两面共用一句就没有 per-surface 的意义了");
  assert.match(mcp, /gp_recent_reports/, "MCP 面要说它真有的那条链");
  assert.match(mcp, /written to this server's log \(stderr\)/, "MCP 面的日志落点没变");
  // 边界句仍然在：窗口有界、驱逐会上线、这一面没有自己的操作链。
  assert.match(http, /bounded \(16 timed-out requests/);
  assert.match(http, /keeps no operation trail of its own/);
});
