/**
 * daily-20261028-gateway-error-shape.test.mjs — D4（2026-10-28）：网关最后那道兜底 catch
 * 把 `String(error)` 原样拼进了发给调用方的报文。
 *
 * 缺陷本体（`src/http-gateway.ts`，createServer 的 `.catch`）：
 *   fail(res, 500, GP_E_INTERNAL, `internal gateway error: ${String(error)}`, …)
 * daemon 那一侧早就拒绝过同一个形状了：`engine/Sources/GlassPaneEngine/Dispatcher.swift:48-60`
 * 明写"a Foundation `NSError` description carries absolute paths — the state root, the evidence
 * archive, the home directory — and this frame reaches any same-user process holding the socket"，
 * 于是它只把 `type(of: error)` 放上线，正文留在 daemon 自己的日志里。HTTP 这扇门面对的是同一批读者
 * （任何能碰到 loopback 端口的同用户进程），却一直在把Thrown 的 message 原样往外发。
 *
 * 修法就是这个文件钉住的三件事：
 *   (a) 上线的 `error.message` 里不含那段路径；
 *   (b) 操作者那一侧（`report` sink，即 stderr）仍然拿到完整正文——否则这条闸只是把证据烧了；
 *   (c) 错误帧还是恰好 `{code, message, remedy}` 三个字段，一个不多一个不少。
 *
 * 为什么这里要用一个**会抛的 getter** 来驱动：`handleToolForward` 里 `client.reportedEngineVersion`
 * 是在它自己那圈 try/catch **之外**被读的（`attributeCapability(...)` 那一处），所以它是少数几条真的
 * 落到 line 393 兜底 catch 的路径之一。让 `client.call()` 抛会走进 `failEngine`（另一条句子，
 * "this gateway could not complete the request"），本文件就不量这一条缺陷了——所以下面那条
 * `of type` 的断言同时也是"确实走的是兜底那一条"的路径证明。
 *
 * REVERSE MUTATION（点名它红在什么地方）：把 line 393 的报文换回
 *   `internal gateway error: ${String(error)}`
 * ⇒ `兜底 catch 的报文里没有绝对路径，也没有那段路径标记` 变红（(a) 那两条断言都拦它）；
 * 同时 `报文里确实点出了错误类型` 也红，因为旧句子不带类型。
 * 只把 `report(...)` 那一行删掉（详情两头都没了）⇒ `操作者那一侧仍然拿到完整正文` 变红。
 * 往帧里再塞一个字段（例如把 detail 也放上去）⇒ `错误帧恰好是三个字段` 变红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpGateway } from "../dist/http-gateway.js";

/** A token that satisfies `assertTokenPolicy` (>= 12 chars over >= 8 distinct ones). */
const TEST_TOKEN = "daily-20261028-error-shape-token-0123456789";

/**
 * The thing a thrown description actually carries and this frame must not: a home directory, a
 * state root and an evidence-archive file name, in one realistic absolute path.
 */
const PATHISH = "/Users/glasspane-user/Library/Application Support/GlassPane/state/evidence/op_0PAAAABBBBCCCCDDDDEEEEFFFF.json";
const LEAKED_TEXT = `could not read the evidence archive at ${PATHISH}`;

/** Any absolute POSIX path — the class of string the daemon's own refusal names. */
const ABSOLUTE_PATH_RE = /(^|[\s(:=])\/[A-Za-z0-9._-]+(?:\/[^\s"'`,):]*)+/;

/**
 * The fake engine client `test/http-gateway.test.mjs` uses (in-memory, injected through
 * `connectController`, so no Unix socket is ever opened), with one difference: it throws from the
 * property the route reads *outside* its own try/catch, which is the only way to reach the
 * gateway's last-resort `.catch`.
 */
class ThrowingVersionClient {
  constructor() {
    this.calls = [];
  }

  call(method, params) {
    this.calls.push({ method, params });
    return Promise.resolve({});
  }

  /** Read by `attributeCapability(...)` before `handleToolForward`'s try block opens. */
  get reportedEngineVersion() {
    throw new Error(LEAKED_TEXT);
  }

  close() {}
}

async function startGateway(fake, extra = {}) {
  const gw = createHttpGateway({
    socketPath: "/tmp/fake-engine-error-shape.sock", // never touched: connectController replaces it
    token: TEST_TOKEN,
    port: 0,
    connectController: () => fake,
    ...extra,
  });
  await new Promise((resolve) => gw.server.once("listening", resolve));
  return { gw, base: `http://127.0.0.1:${gw.server.address().port}` };
}

/** Drive a read route to the gateway's last-resort catch and hand back both sides of the answer. */
async function hitLastResortCatch() {
  const fake = new ThrowingVersionClient();
  const notes = [];
  const { gw, base } = await startGateway(fake, { report: (note) => notes.push(note) });
  try {
    const res = await fetch(`${base}/v1/tools/observe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: "{}",
    });
    const body = await res.json();
    return { res, body, notes };
  } finally {
    await gw.close();
  }
}

test("这条路确实落在网关的兜底 catch 上（不是 failEngine 的那一句）", async () => {
  const { res, body } = await hitLastResortCatch();
  assert.equal(res.status, 500, JSON.stringify(body));
  assert.equal(body.error.code, "GP_E_INTERNAL");
  // fail() 那条会说 "this gateway could not complete the request"；兜底这条说 internal gateway error。
  // 认句子认到这一层，是为了下面几条断言量的真是 line 393 而不是另一条腿。
  assert.match(body.error.message, /internal gateway error/i, `走错分支了（那不是兜底 catch 的报文）：${body.error.message}`);
  assert.doesNotMatch(body.error.message, /could not complete the request/i, body.error.message);
});

test("兜底 catch 的报文里没有绝对路径，也没有那段路径标记", async () => {
  const { body } = await hitLastResortCatch();
  const message = body.error.message;
  // (a) 缺陷本体：抛出来的那句话一个字都不许上线。
  assert.ok(!message.includes(PATHISH), `报文把抛出的路径原样发给了调用方：${message}`);
  assert.ok(!message.includes(LEAKED_TEXT), `报文把抛出的整句描述发了出去：${message}`);
  // 不止这一个标记：这一句里不该出现任何绝对路径形状的东西。
  assert.equal(ABSOLUTE_PATH_RE.test(message), false, `报文里出现了绝对路径的形状：${message}`);
  // remedy 也是给调用方看的，同样不许带上正文。
  assert.ok(!body.error.remedy.includes(PATHISH), body.error.remedy);
});

test("报文仍然点出错误类型——不给类型的话这句就是纯噪音", async () => {
  const { body } = await hitLastResortCatch();
  assert.match(body.error.message, /\bError\b/, `只丢掉正文不留下类型，读者就只能猜：${body.error.message}`);
  assert.match(body.error.message, /of type Error/, `要按 daemon 那个先例报类型名：${body.error.message}`);
  assert.match(body.error.message, /names files|does not publish/i, `还要说清正文为什么没上来：${body.error.message}`);
});

test("操作者那一侧仍然拿到完整正文：report sink 里有那段路径", async () => {
  const { body, notes } = await hitLastResortCatch();
  // (b) 这条修复的另外一半：详情不是被销毁了，是换了去处——remedy 正是这么承诺的。
  const line = notes.find((note) => /internal gateway error/.test(note));
  assert.ok(line, `兜底 catch 必须在 report sink 上留下一行：${JSON.stringify(notes)}`);
  assert.ok(line.includes(PATHISH), `sink 那一行要把真路径留着，否则操作者无从查起：${line}`);
  assert.ok(line.includes(LEAKED_TEXT), `sink 那一行要留着抛出的原句：${line}`);
  // remedy 说的"读这扇门的 stderr"要真的对得上这行——两句都在，指的地方没错。
  assert.match(body.error.remedy, /stderr/, `remedy 该把读者指向 sink，而 sink 真的记了：${body.error.remedy}`);
  assert.match(line, /POST \/v1\/tools\/observe|observe/, `这一行要说出是哪条请求出的事：${line}`);
});

test("错误帧恰好是三个字段：code / message / remedy", async () => {
  const { body } = await hitLastResortCatch();
  // (c) 丢掉正文不等于可以顺手补一个 detail/errorType 字段——帧的形状是对外契约。
  assert.deepEqual(Object.keys(body.error), ["code", "message", "remedy"], JSON.stringify(body.error));
  assert.equal(Object.keys(body.error).length, 3, JSON.stringify(body.error));
  assert.deepEqual(Object.keys(body), ["ok", "error"], JSON.stringify(body));
});

test("非 Error 的抛出值也不许把 String(error) 漏上线", async () => {
  // `throw "…/Users/…"` 的"正文就是它的值"，所以这一支必须走 typeof 而不是 String()。
  const notes = [];
  const fake = {
    call: () => Promise.resolve({}),
    close: () => {},
    get reportedEngineVersion() {
      throw `a bare string naming ${PATHISH}`;
    },
  };
  const { gw, base } = await startGateway(fake, { report: (note) => notes.push(note) });
  try {
    const res = await fetch(`${base}/v1/tools/observe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: "{}",
    });
    const body = await res.json();
    assert.equal(res.status, 500, JSON.stringify(body));
    assert.ok(!body.error.message.includes(PATHISH), `裸字符串抛出的值上了线：${body.error.message}`);
    assert.match(body.error.message, /of type string/, `非 Error 也要报出一个类型：${body.error.message}`);
    assert.ok(notes.some((note) => note.includes(PATHISH)), `详情仍要落到 sink：${JSON.stringify(notes)}`);
  } finally {
    await gw.close();
  }
});
