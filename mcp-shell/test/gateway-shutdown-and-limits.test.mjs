/**
 * 网关的两条失败路径：关停打断在飞的 act，与超限报文的拒绝不可达。
 * 两条都是本轮在**发布产物**上实测出来的，不是推测。
 *
 * 1. `close()` 走 `closeAllConnections()`，把**已经有请求在跑**的连接一起销毁。实测一次
 *    尚未返回的 `POST /v1/tools/act` 回 `ECONNRESET`：没有状态码、没有 `{code,message,remedy}`，
 *    而"do NOT re-issue `act`"那句 remedy 永远送不到——daemon 那边手指还在用户屏幕上。
 *    这是本文件自己的 B-02 口径（不能把"没回话"读成"没发生"）被关停路径打破。
 *    REVERSE：把 `closeIdleKeepAliveConnections` 换回 `closeAllConnections()` → 第一条红。
 * 2. 超限报文在写 400 **之前**就 `req.destroy()`，于是 `GP_HTTP_PAYLOAD_TOO_LARGE` +
 *    "shrink the request payload and retry" 对 100% 的超限请求都读不到（实测 300 KiB 的
 *    POST 回连接重置）：调用方拿着一个"连接断了"去原样重发同一个超限报文。
 *    REVERSE：把 `req.pause()` 换回 `req.destroy()` → 第二条红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createHttpGateway } from "../dist/http-gateway.js";

const TEST_TOKEN = "test-bearer-token-0123456789abcdef";
const POST_PATH = "/v1/tools/act";

class FakeGatewayClient {
  constructor() {
    this.calls = [];
    this.handlers = new Map();
  }
  call(method, params) {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    return Promise.resolve().then(() => (handler ? handler(params) : {}));
  }
  on(method, handler) { this.handlers.set(method, handler); }
  onEngineNote() {}
  onLateReply() {}
  close() {}
}

async function startGateway(fake) {
  const gw = createHttpGateway({
    // never touched: connectController replaces the connector
    socketPath: "/tmp/gp-gateway-shutdown-fake.sock",
    token: TEST_TOKEN,
    port: 0,
    connectController: () => fake,
  });
  await new Promise((resolve) => gw.server.once("listening", resolve));
  return { gw, port: gw.server.address().port };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One POST over a real socket; answers with the status+body, or the transport error. */
function post(port, body, onSent) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port, path: POST_PATH, method: "POST",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text, transportError: null }));
    });
    req.on("error", (error) => resolve({
      status: null, text: null, transportError: error.code ?? String(error),
    }));
    if (onSent) req.on("response", onSent);
    req.end(body);
  });
}

test("an act already handed to the daemon is not reset by a shutdown", async () => {
  const fake = new FakeGatewayClient();
  // 60ms 才回话的 daemon；回的是 Swift 那侧真实写出的帧形状。
  fake.on("act", () => new Promise((resolve) => {
    setTimeout(() => resolve({
      operationId: "op_0123456789ABCDEFGHJKMNPQRS",
      actConfirmed: true,
      axChanged: null,
      pixelChanged: null,
    }), 60);
  }));
  const { gw, port } = await startGateway(fake);
  const agent = new http.Agent({ keepAlive: true });

  const inflight = post(port,
    JSON.stringify({ selector: { role: "button", title: "OK" }, action: "press" }));
  while (fake.calls.length === 0) {
    await settle(5);
  }
  const closing = gw.close();
  let closed = false;
  await Promise.race([closing.then(() => { closed = true; }), settle(3000)]);
  const outcome = await inflight;
  agent.destroy();

  assert.equal(outcome.transportError, null,
    `shutdown 把正在执行的那次 act 打断了（${outcome.transportError}）：调用方拿不到任何 remedy，`
    + "而 daemon 仍然在用户的屏幕上完成了那次操作");
  assert.equal(outcome.status, 200, "那次 act 的结果必须送达，而不是被关停吃掉");
  assert.equal(JSON.parse(outcome.text).result.actConfirmed, true);
  assert.equal(closed, true, "close() 的 promise 也得落地，否则这道闸自己会挂住");
});

test("an oversized body is answered with the limit, not with a reset connection", async () => {
  const fake = new FakeGatewayClient();
  const { gw, port } = await startGateway(fake);
  try {
    // 256 KiB 是网关自己的上限；这里的报文比它大，形状却是真 act 的形状。
    const body = JSON.stringify({
      selector: { role: "button", title: "x".repeat(300 * 1024) },
      action: "press",
    });
    const outcome = await post(port, body);
    assert.equal(outcome.transportError, null,
      `超限的报文被拆链了（${outcome.transportError}）：那句"缩小报文再重试"永远送不到`);
    assert.equal(outcome.status, 400, "超限要回一个能被读走的 400");
    const parsed = JSON.parse(outcome.text);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "GP_HTTP_PAYLOAD_TOO_LARGE");
    assert.match(parsed.error.remedy, /shrink/i, parsed.error.remedy);
    assert.equal(fake.calls.length, 0, "超限的报文不该走到 daemon");
  } finally {
    await gw.close();
  }
});
