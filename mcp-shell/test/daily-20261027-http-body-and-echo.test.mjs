/**
 * 2026-10-27 —— HTTP 那扇门的两个缺口：一条没人等的请求体，和一句没人回音的声明。
 *
 * B1 `readBody` 只有字节上限，没有时间上限，而 `createHttpGateway` 也没设
 * `server.requestTimeout`。一个"发完 header 就把 body 卡住"的调用方会让 handler 一直挂着，
 * 直到 Node 自己的默认超时把 socket 销毁 —— 那种结束给调用方的是一记 `ECONNRESET`，
 * 没有 `{code,message,remedy}`，正是本文件为"超大 body"已经拒绝过的那类答案
 * （见同文件里 300 KiB POST 那条注释）。调用方提前挂断（`close` 早于 `end`）时更安静：
 * Promise 永不 settle，handler 与它的字节账一直被人拿着。
 *
 * B3 MCP 那一侧会把调用方自己声明的 dimension 回音成一条独立 content item
 * （`tools.ts` + `dimensionAttributionLine`），curl 这一侧只做参数校验、把值剥掉，
 * **从不回音**。同一个论点在两个门上给出两种答案，是本文件已经为它改过一次的那一族
 * （见 providers-registration 那段注释）。
 *
 * REVERSE（本机实测，含一条"证人不成立"的记录）：
 *  · 把 `readBody` 的定时器换成永不响的那版 ⇒ 第 1 条点名变红；
 *  · 把 `req.on("close")` 那一支删掉 ⇒ **行为用例照样绿**（Node 对已断开的连接同样安静），
 *    只有第 3 条结构闸点名变红。这一条测量记录就是这条结构闸存在的理由：
 *    不可观测的臂不许由一条可观测的用例冒充担保；
 *  · 把 `ok(res, result, attribution, declared.dimension)` 的回音去掉 ⇒ 第 4 条红；
 *  · 把 `providers.ts` 的两个 catch 臂换回 `code: error.code` ⇒
 *    第 5 条与 `providers.test.mjs` 那条 registration 用例都点名变红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { createHttpGateway } from "../dist/http-gateway.js";
import { dimensionAttributionLine } from "../dist/dimension.js";
import { GP_E_INTERNAL } from "../dist/errors.js";

const TEST_TOKEN = "gateway-b0dy-tim3-out-token-1234";
const AUTH = { Authorization: `Bearer ${TEST_TOKEN}` };

class FakeGatewayClient {
  constructor() {
    this.calls = [];
  }

  call(method, params) {
    this.calls.push({ method, params });
    return Promise.resolve({ evidencePack: {}, method });
  }

  onEngineNote() {}

  onLateReply() {}
}

async function startGateway(fake, extra = {}) {
  const gw = createHttpGateway({
    socketPath: "/tmp/fake-engine.sock",
    token: TEST_TOKEN,
    port: 0,
    connectController: () => fake,
    ...extra,
  });
  await new Promise((resolve) => gw.server.once("listening", resolve));
  return { gw, port: gw.server.address().port };
}

async function closeGateway(gw) {
  if (typeof gw.close === "function") await gw.close().catch(() => {});
  else gw.server.close();
}

/**
 * 发一段真 HTTP 报文然后**按脚本停住**：这是 slow-loris 与"半截 body 就挂断"两种形状的
 * 唯一诚实夹具 —— 用 fetch/axios 造不出"发完 header 之后不再发字节"这件事。
 * `halfCloseAfterMs` 发的是 FIN（`socket.end()`）而不是 RST：调用方走了，但这一侧还读得到
 * 服务端的答案 —— 要测的正是"handler 有没有被 settles"，所以答案必须可见。
 */
function writeThen({ port, pieces, holdMs = 0, halfCloseAfterMs = null }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const received = [];
    socket.on("data", (chunk) => received.push(chunk.toString("utf8")));
    socket.on("error", (error) => reject(error));
    const send = (index) => {
      if (index >= pieces.length) {
        if (halfCloseAfterMs !== null) {
          setTimeout(() => socket.end(), halfCloseAfterMs);
        }
        return;
      }
      socket.write(pieces[index], () => {
        if (holdMs > 0 && index === pieces.length - 1) return; // 停在这里，不再发任何东西
        send(index + 1);
      });
    };
    socket.once("connect", () => send(0));
    setTimeout(() => {
      socket.destroy();
      resolve(received.join(""));
    }, Math.max(holdMs, halfCloseAfterMs ?? 0) + 900);
  });
}

function statusOf(text) {
  const m = /^HTTP\/1\.1 (\d{3})/.exec(text);
  return m === null ? null : Number(m[1]);
}

function bodyOf(text) {
  const index = text.indexOf("\r\n\r\n");
  return index === -1 ? "" : text.slice(index + 4);
}

test("B1 卡住的 body 在 ceilings 到点时被答成一条结构化 408，而不是一记 ECONNRESET", async () => {
  const fake = new FakeGatewayClient();
  const { gw, port } = await startGateway(fake, { bodyReadTimeoutMs: 120 });
  try {
    const text = await writeThen({
      port,
      // chunked：声明了要发 body，然后一个字都不发。真客户端断在半截时就是这个形状。
      // `{"maxD` 恰好 6 字节 —— 前一块写 5 会被 Node 当成畸形 chunked 帧，
      // 那条 400 是 HTTP 解析层给的，测不到本条要测的"body 一直没到"。
      pieces: [
        "POST /v1/tools/observe HTTP/1.1\r\nHost: 127.0.0.1\r\n",
        `Authorization: Bearer ${TEST_TOKEN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
        "6\r\n{\"maxD\r\n",
      ],
      holdMs: 400,
    });
    assert.equal(statusOf(text), 408, `实到：${JSON.stringify(text.slice(0, 300))}`);
    const frame = JSON.parse(bodyOf(text));
    assert.equal(frame.ok, false);
    assert.equal(frame.error.code, "GP_HTTP_BODY_UNREAD");
    for (const field of ["code", "message", "remedy"]) {
      assert.equal(typeof frame.error[field], "string", `三字段错误帧少了 ${field}：${JSON.stringify(frame.error)}`);
    }
    assert.match(frame.error.remedy, /120ms/, "remedy 要说清这一趟等多久，调用方才有的放矢");
    assert.deepEqual(fake.calls, [], "一条没读完的请求不许被转给 daemon");
  } finally {
    await closeGateway(gw);
  }
});

test("B1 调用方半截挂断之后不许留下噪声，也不许把这一扇门钉住", async () => {
  const fake = new FakeGatewayClient();
  // 250ms 的 body 上限，40ms 就挂断 ⇒ 挂断发生在时限**之前**。
  const { gw, port } = await startGateway(fake, { bodyReadTimeoutMs: 250 });
  const unhandled = [];
  const uncaught = [];
  const hookRejection = (reason) => unhandled.push(String(reason));
  const hookException = (error) => uncaught.push(String(error && error.code ? `${error.code}: ${error.message}` : error));
  process.on("unhandledRejection", hookRejection);
  process.on("uncaughtException", hookException);
  try {
    const text = await writeThen({
      port,
      pieces: [
        "POST /v1/tools/observe HTTP/1.1\r\nHost: 127.0.0.1\r\n",
        `Authorization: Bearer ${TEST_TOKEN}\r\nTransfer-Encoding: chunked\r\n\r\n`,
        "6\r\n{\"maxD\r\n",
      ],
      halfCloseAfterMs: 40,
    });
    // 挂断的这一趟：HTTP 解析层自己会先答一句（Node 对半截 body 的 FIN 给 400），
    // 所以这一条**不**把那句话当成壳的答案来断言。本机实测：删掉 `close` 一支，Node 照样
    // 安静、这四项断言照样绿 —— 那它就不是那条闸的证人，这一条证的是"没留噪声、门没被钉住"。
    // `close` 那一支的闸在下一条结构用例里（它的作用是把答案的**理由**说准并立刻 settle，
    // 端到端层面不可观测，就不许假装观测到了）。
    assert.ok(typeof text === "string", "夹具必须真的跑完一次连接");

    // 等过那枚定时器本应响的时刻，再看这台机器有没有多说话。
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(uncaught, [],
      `挂断的一趟之后不许有未捕获异常：${uncaught.join(" | ")}`);
    assert.deepEqual(unhandled, [], `挂断路径不许制造未处理的 rejection：${unhandled.join(" | ")}`);
    assert.equal(gw.server.listeners("request").length, 1, "一次挂断不许给服务器多挂一个 handler");

    // 而且这台机器还没被一趟挂断钉住：一条正常的请求照旧有正常答案。
    const res = await fetch(`http://127.0.0.1:${port}/v1/tools/observe`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ maxDepth: 2 }),
    });
    assert.equal(res.status, 200, "挂断过一次的那扇门必须照常服务");
    assert.equal(fake.calls.length, 1, "只有那条真发完 body 的请求该被转给 daemon");
  } finally {
    process.off("unhandledRejection", hookRejection);
    process.off("uncaughtException", hookException);
    await closeGateway(gw);
  }
});

test("B1 那条读侧规矩的三条臂都在：字节上限、时间上限、连接早断", () => {
  // `close` 那一支端到端不可观测（客户端已经走了，谁的答复都读不到；上面那条实测记录就是证据：
  // 删掉它，行为测试照样绿）。按本仓既有的做法，给这种"只能由代码形状担保"的臂一条具名结构闸：
  // 三条臂一条都不许悄悄没，也不许有人把结构化错误重新变成 ECONNRESET。
  const source = readFileSync(new URL("../src/http-gateway.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function readBody("));
  assert.notEqual(body, source, "找不到 readBody 的函数体——它被改名还是被挪走了？");
  const arm = (name, re) => {
    assert.match(body, re, `readBody 少了「${name}」这一支——它给出的理由就不是这次真发生的事`);
  };
  arm("字节上限", /size > limit[\s\S]{0,600}HTTPPayloadTooLargeError/);
  arm("时间上限", /const timer = setTimeout\([\s\S]{0,600}HTTPBodyUnreadError/);
  arm("连接早断", /req\.on\("close", \(\) => finish\([\s\S]{0,400}connection closed before the body ended/);
  arm("settle 只发生一次", /let settled = false;[\s\S]{0,300}const finish = /);
  assert.match(body, /timer\.unref\?\.\(\)/, "读 body 的定时器不许成为进程活着的原因");
  assert.doesNotMatch(body, /req\.socket\.destroy\(\)|req\.destroy\(\)/,
    " destroying 套接字会把调用方该读到的 {code,message,remedy} 变成一记 ECONNRESET");
});

test("B3 curl 那一侧也回音调用方声明的 dimension，用的还是同一位作者的句子", async () => {
  const fake = new FakeGatewayClient();
  const { gw, port } = await startGateway(fake);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/tools/observe`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ maxDepth: 2, dimension: "security" }),
    });
    assert.equal(res.status, 200);
    const frame = await res.json();
    assert.equal(frame.ok, true);
    assert.equal(
      frame.dimension,
      dimensionAttributionLine("security"),
      "回音必须由 dimension.ts 那一位作者写，两个门才不可能各写一套说法",
    );
    assert.match(frame.dimension, /dimension: security/);
    assert.deepEqual(
      fake.calls[0].params,
      { maxDepth: 2 },
      "声明是给壳的注解，不许进 daemon 的帧（这条不变量两个门都要守住）",
    );

    const undeclared = await fetch(`http://127.0.0.1:${port}/v1/tools/observe`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ maxDepth: 2 }),
    });
    const plain = await undeclared.json();
    assert.ok(!("dimension" in plain), `没声明就不许多出一格：${JSON.stringify(plain)}`);
  } finally {
    await closeGateway(gw);
  }
});

test("B2 面 A 交给 agent 的错误帧只有一个代号家族（GP_E_*），内核的代号留在 message 里", async () => {
  // 这一条是那一族的总闸：把内核词汇（`KERNEL_E_*`）当对外 code 发出去，
  // 拿着已发布代号表的调用方就 parse 不动这一帧。
  const { attributeCapability } = await import("../dist/providers.js");
  const errors = await import("../dist/errors.js");
  // 代号表不手抄：把 `errors.js` 自己声明的那些 `GP_E_*` 字符串常量收集起来当唯一真源。
  // 有人改回 `code: error.code` 时，这一条会因"发出去的 code 不在声明表里"而红。
  const declared = new Set(Object.values(errors).filter((value) => typeof value === "string" && value.startsWith("GP_E_")));
  assert.ok(declared.size > 0, `errors.js 里读不到任何 GP_E_* 常量，那这道闸量的是什么：${declared.size}`);

  const refused = attributeCapability("diagnose", { producerVersion: "x".repeat(4096) });
  assert.equal(refused.status, "refused");
  assert.equal(refused.error.code, GP_E_INTERNAL, JSON.stringify(refused.error));
  assert.ok(declared.has(refused.error.code),
    `对外帧的 code ${refused.error.code} 不在 errors.js 声明的表里（表：${[...declared].join(", ")}）`);
  assert.match(refused.error.message, /KERNEL_E/, "内核自己的名字不能丢");
  for (const field of ["code", "message", "remedy"]) {
    assert.equal(typeof refused.error[field], "string", `三字段错误帧少了 ${field}`);
  }
});
