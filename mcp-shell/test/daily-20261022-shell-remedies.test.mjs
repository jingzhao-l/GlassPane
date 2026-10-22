import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CALLER_VISIBLE_CEILING_MS,
  EngineJsonRpcClient,
  REPLAY_UNSAFE_METHOD_NAMES,
  STATE_CHANGING_ON_RETRY_METHOD_NAMES,
  daemonUnreachableRemedy,
  engineClientOver,
} from "../dist/engine-client.js";
import {
  DAEMON_FORWARDED_METHODS,
  TOOL_BY_NAME,
  TOOL_SPECS,
  executeTool,
  shellFaultRemedy,
} from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { createHttpGateway } from "../dist/http-gateway.js";
import { FAKE_DAEMON_CAPABILITIES, fakeHelloResult } from "./support/fake-daemon.mjs";
import { executableSource } from "./support/source.mjs";
import { FakeLineIo } from "./helpers.mjs";

/**
 * 2026-10-22 每日轮的壳侧修复：六条都被现场验证过，全部落在"建议文本 + 形状校验"这一层，
 * 不碰证据语义（`node harness/tools/surface-semantics.mjs --check` 量的是那一条）。
 *
 * 夹具一律取 daemon 真会写出的帧：`Dispatcher.response(id:result:)` 与
 * `response(id:error:)` 发的键就 `result`/`error` 加 `id`（没有 `jsonrpc` 键，
 * `encode()` 只排序不加键），错误帧永远是三字段（`ProtocolErrors.swift`），
 * `capture_view` 的回复键集合照 `EngineCore.swift` 的那一段抄，`hello` 用
 * `test/support/fake-daemon.mjs` 的 `fakeHelloResult()`。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAME_CODEC = path.resolve(HERE, "..", "..", "engine", "Sources", "GlassPaneEngine", "FrameCodec.swift");

/** A token that satisfies the gateway's own policy (see `MIN_TOKEN_CHARS`). */
const TEST_TOKEN = "test-bearer-token-0123456789abcdef";

/** The tail every caller of `daemonUnreachableRemedy` still expects. */
const RESTORE_TAIL = ", then retry";

/**
 * The restore command alone, the way `transportDeathRemedy` has to use it. Derived from
 * the exported remedy rather than written out: the whole point of the refactor is that
 * the command sentence has ONE implementation, so a copy in this file would keep the
 * test green while the two halves drifted apart in the product.
 */
function restoreCommand() {
  const remedy = daemonUnreachableRemedy();
  assert.ok(remedy.endsWith(RESTORE_TAIL), `每条出路都还带着那段尾巴：${remedy}`);
  return remedy.slice(0, -RESTORE_TAIL.length);
}

/**
 * One TypeScript function's body, from its signature to the first column-0 `}`. Same shape as
 * `test/fixture-daemon-shape.test.mjs`'s Swift extractor: a scan that silently finds nothing is
 * a gate that stopped looking, so the anchors are asserted rather than assumed.
 */
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} 不在这份源码里了——这条闸要红而不是跳过`);
  const rest = source.slice(start + signature.length);
  const end = rest.indexOf("\n}");
  assert.notEqual(end, -1, `${signature} 的函数体收不住了：这份源码换了写法`);
  return rest.slice(0, end);
}

/** Words that order the caller to put a second copy of the request on the wire. */
const RE_ISSUE_ORDERING = [
  /\bretry\b/i,
  /\bre-?send\b/i,
  /\bsend it again\b/i,
  /\brun it again\b/i,
  /\bissue it again\b/i,
  /\breplay it\b/i,
  /then retry/i,
];

/**
 * One outstanding request answered by the transport going away. `via: "error"` is the
 * socket-error arm, `via: "close"` the socket-close arm — the same defect lived on both,
 * and `clientClosingRemedy` was written for the client-initiated close only.
 */
async function rejectOnTransportDeath(method, { surface = "mcp", via = "error" } = {}) {
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 60_000, null, CALLER_VISIBLE_CEILING_MS, surface);
  const outstanding = client.call(method, method === "act"
    ? { selector: { role: "AXButton" }, action: "press" }
    : {});
  if (via === "error") {
    io.emitError(new Error("connect ECONNREFUSED /var/run/glasspane/engine.sock"));
  } else {
    io.close();
  }
  const error = await outstanding.then(() => null, (caught) => caught);
  assert.ok(error, `${method}: 传输层死了，这一笔却没有被结算`);
  return { error, io, client };
}

// MARK: - Defect 1: the transport-death answer must not order a re-issue

test("a transport death answers an in-flight replay-unsafe call with the restore command and a ban on re-issuing it", async () => {
  // MUTATION THIS PINS: `EngineJsonRpcClient`'s onError/onClose handlers handing every
  // outstanding request the single `daemonUnreachableRemedy()` again ("…, then retry"),
  // i.e. reverting `transportDeathRemedy` to one string for all methods. That tail tells
  // an agent to perform the same click a second time on the user's screen for a request
  // that had already left this shell — the identical defect `clientClosingRemedy`'s own
  // doc comment names ("orders the re-issue of a request whose re-issue is the harm this
  // file spends the rest of its length refusing"), fixed on one face and left on the other.
  // Reverting the per-method split reddens all three arms below at once; reverting the
  // `daemonRestoreCommand` extraction reddens the `startsWith` control instead.
  const cases = [
    { method: "act", reason: /user'?s? screen/, expect: /the original action can still take effect/ },
    { method: "restore", reason: /step by step/, expect: /the original replay can still take effect/ },
    { method: "attach", reason: /another app|discard the trail/, expect: /the original attach can still re-point the daemon/ },
  ];
  for (const via of ["error", "close"]) {
    for (const one of cases) {
      const { error, client } = await rejectOnTransportDeath(one.method, { via });
      assert.equal(error.code, "GP_E_ENGINE_UNREACHABLE", `${one.method}/${via}: 码不变，变的只是它授权的下一步`);
      // The transport's own fact still in the message, on both arms.
      assert.match(error.message, via === "error" ? /ECONNREFUSED/ : /transport closed/, error.message);
      // The lifecycle command STAYS: a dead transport is the one outcome allowed to name
      // it (`livenessProbeDecision("unreachable")`, pinned by `test/probe-liveness.test.mjs`),
      // and `--restore-launchd` is the only executable answer to "nothing is listening".
      assert.ok(error.remedy.startsWith(restoreCommand()),
        `${one.method}/${via}: 出路不再以那条恢复命令开头，说明恢复句子有了第二份实现：${error.remedy.slice(0, 200)}`);
      assert.match(error.remedy, /--restore-launchd/);
      // …and the tail is gone, in every spelling this file already recognises as an order.
      for (const ordering of RE_ISSUE_ORDERING) {
        assert.doesNotMatch(error.remedy, ordering, `${one.method}/${via}: 出路又命令重发（${ordering}）：${error.remedy}`);
      }
      // What it says instead: the request had already gone, the outcome is unknowable here,
      // the ban names THIS method, and the ban carries the method's own reason.
      assert.match(error.remedy, /had already left this shell/, error.remedy.slice(0, 240));
      assert.match(error.remedy, /cannot be told from here/, "要说不确定的来源，不是把不确定抹掉");
      assert.match(error.remedy, new RegExp(`Do NOT re-issue '${one.method}'`), error.remedy.slice(0, 240));
      assert.match(error.remedy, /a re-issue can perform it a second time/, error.remedy.slice(0, 240));
      assert.match(error.remedy, one.expect, `${one.method} 的禁令没带上它自己的理由：${error.remedy}`);
      assert.match(error.remedy, one.reason);
      // The read-instead route, named for the surface that gets it.
      assert.match(error.remedy, /Read what happened instead of performing it a second time/);
      for (const tool of ["gp_recent_reports", "gp_last_evidence", "gp_probe_status"]) {
        assert.ok(error.remedy.includes(tool), `MCP 面的读路少了 ${tool}：${error.remedy}`);
      }
      client.close();
    }
  }
});

test("a transport death answers an in-flight snapshot with the ring clause, not a second copy", async () => {
  // MUTATION THIS PINS: dropping the `STATE_CHANGING_ON_RETRY_METHOD_NAMES` arm so
  // `snapshot` falls through to `daemonUnreachableRemedy()`. Nothing is pressed twice by a
  // second snapshot, so the replay ban would be wrong advice; what is true is the clause
  // `noRemedyFallback` already makes — every accepted copy appends to the daemon's bounded
  // ring and can evict the baseline an earlier snapshot returned, the one a later restore needs.
  for (const via of ["error", "close"]) {
    const { error, client } = await rejectOnTransportDeath("snapshot", { via });
    assert.equal(error.code, "GP_E_ENGINE_UNREACHABLE");
    assert.ok(error.remedy.startsWith(restoreCommand()), error.remedy.slice(0, 200));
    for (const ordering of RE_ISSUE_ORDERING) {
      assert.doesNotMatch(error.remedy, ordering, `snapshot/${via}: 出路又命令再发一次（${ordering}）：${error.remedy}`);
    }
    assert.match(error.remedy, /writes daemon state again/, error.remedy.slice(0, 240));
    assert.match(error.remedy, /bounded/, "有界的环要说出来，否则第二条看上去只是更便宜");
    assert.match(error.remedy, /evict/, error.remedy);
    assert.match(error.remedy, /Do NOT send a second 'snapshot'/, "禁令要指着 snapshot 这个名字");
    assert.match(error.remedy, /had already left this shell/, error.remedy.slice(0, 240));
    // The replay ban belongs to the replay-unsafe set alone; conflating the two would make
    // this answer claim a click that a snapshot does not perform.
    assert.doesNotMatch(error.remedy, /Do NOT re-issue 'snapshot'/, "snapshot 不是重放不安全的方法，不许领到那条禁令");
    client.close();
  }
});

test("a transport death still tells a safe read to send it again", async () => {
  // MUTATION THIS PINS: giving every method the no-reissue treatment. Refusing a retry where
  // nothing is performed twice is its own kind of wrong advice, and this arm's bytes are the
  // pre-existing `daemonUnreachableRemedy()` verbatim — asserted as an equality, so the fix
  // cannot "improve" the reads into silence.
  const reads = ["observe", "diagnose", "last_evidence", "probe_status", "assert_element", "audit_ui", "capture_view", "hello"];
  for (const method of reads) {
    const { error, client } = await rejectOnTransportDeath(method);
    assert.equal(error.remedy, daemonUnreachableRemedy(),
      `'${method}' 是读，重发不重复做任何事：它的出路必须还是那句原话，一个字节都不变`);
    assert.match(error.remedy, /, then retry$/);
    client.close();
  }
  // The set this guards is the transport's own classification, not a list copied here.
  assert.deepEqual([...STATE_CHANGING_ON_RETRY_METHOD_NAMES], ["snapshot"]);
  assert.deepEqual([...REPLAY_UNSAFE_METHOD_NAMES].sort(), ["act", "attach", "restore"]);
});

test("the transport-death answer is written for the surface that receives it", async () => {
  // MUTATION THIS PINS: dropping the per-surface split in `transportDeathRemedy`'s read route,
  // which sends a curl caller of the HTTP gateway to `gp_recent_reports` — a tool this gateway
  // does not expose (`FORWARDABLE_TOOLS` skips every tool with an `execute`, and
  // `POST /v1/tools/recent_reports` is a 404). Same rule `clientClosingRemedy` obeys, on the
  // other arm of the same rejection.
  for (const method of [...REPLAY_UNSAFE_METHOD_NAMES]) {
    const { error, client } = await rejectOnTransportDeath(method, { surface: "http" });
    assert.ok(!/gp_[a-z_]+/.test(error.remedy), `curl 调用方手上没有 gp_* 可调：${error.remedy}`);
    assert.ok(!/POST \/v1\/tools\/recent_reports/.test(error.remedy), "recent_reports 在这条面上是 404");
    assert.match(error.remedy, /this gateway keeps no operation trail of its own/, error.remedy.slice(0, 240));
    assert.ok(error.remedy.startsWith(restoreCommand()), "两面都要留住那条恢复命令，尾巴各自不同");
    for (const ordering of RE_ISSUE_ORDERING) {
      assert.doesNotMatch(error.remedy, ordering, `http/${method}: ${error.remedy}`);
    }
    client.close();
  }
});

test("the restore sentence has one implementation and every old call site keeps its bytes", () => {
  // Two reverts this pins, and the first one is NOT catchable by any remedy string: putting
  // the command text back inline in `daemonUnreachableRemedy()` while `daemonRestoreCommand`
  // keeps its own copy leaves every behavioural assertion green, because the two copies still
  // agree today. So this is a shape check on the source: the command sentence is spelled in
  // exactly one function, and the ", then retry" tail in exactly one place. The second revert
  // it pins is a rewrite of the fallback arm — the one a published artifact reads (`npm pack`
  // ships `dist` + `schemas`, no `installer/`) — which the byte assertions below catch.
  const source = executableSource(fs.readFileSync(path.resolve(HERE, "..", "src", "engine-client.ts"), "utf8"));
  const commandBody = functionBody(source, "function daemonRestoreCommand(): string {");
  const remedyBody = functionBody(source, "export function daemonUnreachableRemedy(): string {");
  assert.equal((commandBody.match(/--restore-launchd/g) ?? []).length, 2,
    "恢复命令的两种拼法不再同在一处：这条句子有了第二份实现");
  assert.equal((remedyBody.match(/--restore-launchd/g) ?? []).length, 0,
    "daemonUnreachableRemedy 又自己拼了一遍恢复命令，两份会各自漂");
  assert.equal((source.match(/, then retry/g) ?? []).length, 1,
    "', then retry' 这条尾巴只能有一个落点，否则按方法分流的那几条随时会被改回统一的尾巴");
  assert.equal(remedyBody.includes("daemonRestoreCommand()"), true, "尾巴不再接在那一条命令上");

  const bytes = daemonUnreachableRemedy();
  assert.ok(bytes.endsWith(RESTORE_TAIL), bytes);
  const installerCli = path.resolve(HERE, "..", "..", "installer", "cli.js");
  if (fs.existsSync(installerCli)) {
    assert.match(bytes, /^run `node .*--restore-launchd` \(auto-restores and verifies the launchd-managed daemon\), then retry$/, bytes);
  } else {
    assert.match(bytes, /^ensure the glasspane daemon is running \(launchd job com\.glasspane\.daemon;.*--restore-launchd.*\), then retry$/, bytes);
  }
  assert.equal(`${restoreCommand()}${RESTORE_TAIL}`, bytes, "去掉尾巴再接回来必须正好是原来那几个字节");
});

// MARK: - Defect 2: the "engine answered nothing" remedy

/**
 * One frame that names the request and carries no answer. The two shapes are the daemon's
 * own keys (`Dispatcher.response` writes `result`/`error` plus `id`, nothing else); a
 * top-level `null` result is not something today's responder emits, but this socket has no
 * peer authentication, so the shell must be measured against the bytes it can actually be
 * handed — same premise `test/daily-20261020.test.mjs` records.
 */
async function answeredNothing(method, body = { result: null }) {
  const io = new FakeLineIo();
  const client = engineClientOver(io, 5_000);
  const promise = client.call(method, {});
  io.send(JSON.stringify({ id: io.lastFrame().id, ...body }));
  const error = await promise.then(() => null, (caught) => caught);
  assert.ok(error, `${method}: 空回答被当成成功了`);
  return { error, client };
}

test("an empty answer for a replay-unsafe method bans the re-issue instead of ordering 'retry once'", async () => {
  // MUTATION THIS PINS: `settleFromFrame`'s remedy going back to the literal
  // "…Retry once, then check the daemon log (stderr) for what it died before answering".
  // The frame echoed this request's id, so the request reached the daemon — which is the
  // very argument `noRemedyFallback` uses to refuse a copy — and "retry once" spent the
  // unknown on a second `act` on the user's screen.
  for (const body of [{ result: null }, {}]) {
    const { error, client } = await answeredNothing("act", body);
    assert.equal(error.code, "GP_E_INTERNAL");
    assert.match(error.remedy, /answered nothing/, "开头那句是对的吗？这条被现有测试钉着");
    assert.doesNotMatch(error.remedy, /retry once/i, `空回答又把重发排上了：${error.remedy}`);
    for (const ordering of RE_ISSUE_ORDERING) {
      assert.doesNotMatch(error.remedy, ordering, `act 的空回答命令重发（${ordering}）：${error.remedy}`);
    }
    assert.match(error.remedy, /echoed this request'?s? id/, "要说清证据来自哪里：这一帧认领了本次请求");
    assert.match(error.remedy, /reached the daemon/i, "不许和 noRemedyFallback 的同一论证打架");
    assert.match(error.remedy, /Do NOT re-issue 'act'/);
    assert.match(error.remedy, /the original action can still take effect/, "禁令要带上这个方法自己的理由");
    assert.match(error.remedy, /daemon'?s? own log/, "仍然要指出唯一读得到成因的一侧");
    client.close();
  }
  const snapshot = await answeredNothing("snapshot");
  assert.match(snapshot.error.remedy, /Do NOT send a second 'snapshot'/);
  assert.match(snapshot.error.remedy, /bounded/);
  assert.match(snapshot.error.remedy, /evict/);
  for (const ordering of RE_ISSUE_ORDERING) {
    assert.doesNotMatch(snapshot.error.remedy, ordering, `snapshot 的空回答又要第二条：${snapshot.error.remedy}`);
  }
  snapshot.client.close();
});

test("an empty answer for a read still tells the caller to send it again", async () => {
  // MUTATION THIS PINS: making the empty-answer remedy uniform across methods, which takes
  // the retry away from a call that performs nothing twice — wrong advice in the other
  // direction, and the reason the three-arm split exists rather than one blanket ban.
  for (const method of ["probe_status", "observe", "diagnose", "last_evidence"]) {
    const { error, client } = await answeredNothing(method);
    assert.match(error.remedy, /\bretry\b/i, `'${method}' 是读，空回答的出路要把重发给出来：${error.remedy}`);
    assert.match(error.remedy, /send it again/i, `'${method}' 的出路要给一句能直接执行的话：${error.remedy}`);
    assert.doesNotMatch(error.remedy, /Do NOT re-issue/, `${method} 不领 no-replay 禁令，否则这条判据就成了口号`);
    assert.match(error.remedy, /answered nothing/);
    client.close();
  }
});

test("the empty-answer answer is written for the surface that receives it", async () => {
  // MUTATION THIS PINS: dropping the per-surface route out of `emptyAnswerRemedy`, which hands
  // a curl caller a `gp_recent_reports` it cannot call. Same split as the transport-death arm,
  // because both are rejections this layer writes for a request whose outcome it cannot see.
  const io = new FakeLineIo();
  const client = new EngineJsonRpcClient(io, 5_000, null, CALLER_VISIBLE_CEILING_MS, "http");
  const promise = client.call("act", {});
  io.send(JSON.stringify({ id: io.lastFrame().id, result: null }));
  const error = await promise.then(() => null, (caught) => caught);
  assert.ok(error, "空回答被当成成功了");
  assert.ok(!/gp_[a-z_]+/.test(error.remedy), `curl 调用方手上没有 gp_* 可调：${error.remedy}`);
  assert.match(error.remedy, /this gateway keeps no operation trail of its own/, error.remedy.slice(0, 240));
  assert.match(error.remedy, /Do NOT re-issue 'act'/);
  client.close();
});

// MARK: - Defect 3: blank code/message forwarded while blank remedy was guarded

/** An error frame in the shape `Dispatcher.response(id:error:)` writes. */
async function errorFrame(method, frame) {
  const io = new FakeLineIo();
  const client = engineClientOver(io, 5_000);
  const promise = client.call(method, {});
  io.send(JSON.stringify({ id: io.lastFrame().id, error: frame }));
  const error = await promise.then(() => null, (caught) => caught);
  assert.ok(error, "错误帧没有回给调用方");
  return { error, client };
}

test("a blank code or message on an error frame is filled, and the shape rule stops being one-field-deep", async () => {
  // MUTATION THIS PINS: `engineError` going back to `String(body.code ?? GP_E_UNKNOWN)` /
  // `String(body.message ?? …)`. `??` catches null and undefined only, so a daemon frame
  // carrying `code: ""` or `message: "   "` was forwarded verbatim as an agent-facing error
  // with no name and no cause — while the remedy arm directly below it already treated `""`
  // as absent. One rule for three fields on one frame.
  const cases = [
    { code: "", message: "   ", wantCode: "GP_E_UNKNOWN", wantMessage: "the engine sent an error frame without a message" },
    { code: "  ", message: "", wantCode: "GP_E_UNKNOWN", wantMessage: "the engine sent an error frame without a message" },
    { code: null, message: undefined, wantCode: "GP_E_UNKNOWN", wantMessage: "the engine sent an error frame without a message" },
  ];
  for (const one of cases) {
    const { error, client } = await errorFrame("observe", { code: one.code, message: one.message, remedy: "call attach first" });
    assert.equal(error.code, one.wantCode, `空白 code 又被原样转发了：${JSON.stringify(one)}`);
    assert.equal(error.message, one.wantMessage, `空白 message 又被原样转发了：${JSON.stringify(one)}`);
    // The daemon DID answer the remedy here, and that answer is the daemon's to own.
    assert.equal(error.remedy, "call attach first", "填充空白不许顺手改写已经答了的字段");
    client.close();
  }
  // The same rule now holds for all three fields. The remedy arm was the one that already
  // read `""` as absent, so the asymmetry the defect describes is closed by extending it to
  // whitespace-only as well: a `remedy` of spaces must not reach an agent as an empty way out.
  const blank = await errorFrame("observe", { code: "GP_E_NOT_ATTACHED", message: "no app attached", remedy: "   " });
  assert.notEqual(blank.error.remedy, "   ", "空白 remedy 又被原样转发了");
  assert.match(blank.error.remedy, /engine sent no remedy for this error code/, blank.error.remedy.slice(0, 200));
  blank.client.close();
});

test("a well-formed error frame passes through byte-for-byte, spaces and all", async () => {
  // Control against the fix turning into a silent rewriter: this shell forwards the daemon's
  // words, and the guard may only fire on a field that says nothing. MUTATION THIS PINS:
  // trimming or normalising a stated value (`text.trim()` on the way out instead of `text`).
  const frame = {
    code: "GP_E_NOT_ATTACHED",
    message: "  no app attached ",
    remedy: "call attach first",
  };
  const { error, client } = await errorFrame("observe", frame);
  assert.equal(error.code, frame.code);
  assert.equal(error.message, frame.message, "非空的 message 必须原样，含首尾空白");
  assert.equal(error.remedy, frame.remedy);
  assert.equal(error.message, "  no app attached ", "这条对照要能被 trim() 一下就读成通过了吗？不能");
  client.close();
});

// MARK: - Defect 4: a remedy that instructs the harm its own sentence warns about

test("the snapshot arm of shellFaultRemedy no longer routes the caller to a listing that does not exist", () => {
  // MUTATION THIS PINS: writing "gp_snapshot lists stored ids" back into the snapshot arm of
  // `tools.ts`'s `shellFaultRemedy`. `gp_snapshot`'s own spec is "Capture a digest-only
  // baseline of the attached app's AX tree for later restore"; the daemon's `snapshot` handler
  // appends to the bounded ring (`EngineCore.swift`'s storeSnapshot, trimmed oldest-first past
  // `snapshotHistoryLimit`). An agent that followed the old clause created a new snapshot —
  // evicting the very baseline the sentence was protecting.
  const remedy = shellFaultRemedy("snapshot");
  assert.doesNotMatch(remedy, /gp_snapshot lists/, `那条不存在的读路又回来了：${remedy}`);
  assert.doesNotMatch(remedy, /lists stored ids/i, remedy);
  assert.match(remedy, /transcript|earlier gp_snapshot repl/i,
    `要说清 id 到底从哪来（调用方自己之前的 gp_snapshot 回复里）：${remedy}`);
  assert.match(remedy, /no route here enumerates|nothing here enumerates/i,
    "并且要说清这里没有一条列举环的路由，否则代理会接着找第二条");
  assert.match(remedy, /re-read your own earlier result/i, remedy);
  // The rest of the sentence survives the edit: the ring claim, the read route, the log route.
  assert.match(remedy, /bounded snapshot ring/);
  assert.match(remedy, /evict a baseline this caller already received/);
  assert.match(remedy, /gp_recent_reports lists the operations/);
  assert.match(remedy, /A daemon restart is not authorised by an answer the daemon never made/);
  for (const ordering of [/then retry/, /retry this call/, /re-run /, /send it again/]) {
    assert.doesNotMatch(remedy, ordering, `snapshot 的出路又要求重发（${ordering}）：${remedy}`);
  }
});

test("no shell-fault remedy orders a re-send of a method in the no-replay or ring-writing set", () => {
  // The exact behaviour, not a prose sweep: for every method this shell forwards,
  // `shellFaultRemedy` may not put a member of `REPLAY_UNSAFE_METHOD_NAMES` or
  // `STATE_CHANGING_ON_RETRY_METHOD_NAMES` on the wire a second time. MUTATION THIS PINS:
  // pasting a `gp_snapshot`/`gp_act`-re-send clause into any arm, and equally softening the
  // ban in the arms that carry it today.
  const forbidden = [...REPLAY_UNSAFE_METHOD_NAMES, ...STATE_CHANGING_ON_RETRY_METHOD_NAMES];
  const checked = [];
  for (const method of DAEMON_FORWARDED_METHODS) {
    const remedy = shellFaultRemedy(method);
    checked.push(method);
    // The ban is scanned out first, exactly as `test/engine-client.test.mjs` does for the
    // transport's own answers: "Do NOT re-issue attach" is the refusal, and a gate that fired
    // on it would make the honest sentence the reason the test fails. What must be clean is
    // whatever is left — an order to put one of these names on the wire again.
    const ordered = remedy
      .replace(/\bdo not re-issue\b/gi, "")
      .replace(/\bdo NOT send a second\b/gi, "")
      .replace(/\bnever re-issue\b/gi, "");
    for (const name of forbidden) {
      assert.doesNotMatch(
        ordered,
        new RegExp(`\\b(send|re-?send|re-?issue|retry|re-run|run again)\\s+(gp_)?${name}\\b`, "i"),
        `'${method}' 的出路命令重发 '${name}'：${remedy.slice(0, 220)}`,
      );
    }
    if (REPLAY_UNSAFE_METHOD_NAMES.includes(method)) {
      assert.match(remedy, new RegExp(`Do NOT re-issue ${method}`), `${method} 的禁令没了：${remedy.slice(0, 200)}`);
      assert.match(remedy, /can perform the same action a second time/, remedy.slice(0, 200));
    }
    if (STATE_CHANGING_ON_RETRY_METHOD_NAMES.includes(method)) {
      assert.match(remedy, /writes daemon state|bounded snapshot ring/, remedy.slice(0, 220));
    }
  }
  assert.ok(checked.includes("act") && checked.includes("attach") && checked.includes("snapshot")
    && checked.length >= 10, `这条闸只看了 ${checked.length} 个方法（${checked.join(", ")}），清单已经没人读了`);
  // And the reads keep the option they are entitled to: softening the ban by silencing the
  // safe arm would be the same defect pointing the other way.
  assert.match(shellFaultRemedy("observe"), /sending this tool again is a real option/, "observe 的出路丢了它能有的那半句话");
});

test("the claim that nothing enumerates stored snapshots is checked against both manifests", () => {
  // The replacement sentence is a claim about routes, so it is gated on the routes: no tool
  // spec here and no method in the daemon's own table lists stored snapshot ids. MUTATION
  // THIS PINS: adding such a route (which would make the new sentence false and this test
  // red on purpose) — and, on the shell side, renaming a tool so the scan finds nothing.
  const toolNames = TOOL_SPECS.map((spec) => spec.name);
  assert.ok(toolNames.length >= 15, `只扫出 ${toolNames.length} 条工具，这份清单已经读不到东西`);
  assert.deepEqual(toolNames.filter((name) => /^(list|recent|get|stored)_?snapshots?$/i.test(name)
    || /^gp_(list|recent|stored)_?snapshots?$/i.test(name)), [],
    "壳里出现了列举快照的工具：shellFaultRemedy 那句『这里没有那条路』要一起改");

  const source = fs.readFileSync(FRAME_CODEC, "utf8");
  const block = /public enum EngineMethod: String, CaseIterable \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, "FrameCodec.swift 不再以这段声明写 EngineMethod——这条闸要红而不是跳过");
  const wireNames = [];
  for (const rawLine of block[1].split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    for (const part of line.startsWith("case ") ? line.slice(5).split(",") : []) {
      const withValue = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]+)"$/.exec(part.trim());
      wireNames.push(withValue ? withValue[2] : part.trim());
    }
  }
  assert.ok(wireNames.length >= 10, `只解析出 ${wireNames.length} 个 daemon 方法名：${wireNames.join(", ")}`);
  assert.deepEqual(wireNames.filter((name) => /list.*snapshot|snapshot.*list/i.test(name)), [],
    "daemon 新增了列举快照的方法：壳的那句话现在撒谎，出路要一起改");
});

// MARK: - Defect 5: a summary that claims numbers the frame never answered

/**
 * The daemon's capture reply, key for key: `EngineCore.swift`'s capture branch writes
 * `pngBase64`, `mimeType`, `byteCount`, `pixelWidth`, `pixelHeight`, `windowId`, `scale`,
 * `appliedScale`, `persisted`, `pointSize{width,height}`.
 */
function captureFrame(omit = []) {
  const frame = {
    pngBase64: "iVBORw0KGgo=",
    mimeType: "image/png",
    byteCount: 12,
    pixelWidth: 864,
    pixelHeight: 540,
    windowId: 12,
    scale: 0.6,
    appliedScale: 0.9,
    persisted: false,
    pointSize: { width: 1440, height: 900 },
  };
  for (const key of omit) {
    delete frame[key];
  }
  return frame;
}

async function runCapture(frame) {
  const io = new FakeLineIo();
  const engine = engineClientOver(io, 5_000);
  const promise = executeTool(TOOL_BY_NAME.get("gp_capture_view"), { scale: 0.6 }, engine, new EvidenceAuditSession());
  io.respond(frame);
  const outcome = await promise;
  return { outcome, engine };
}

test("a full capture frame produces exactly the summary it produced before the fix", async () => {
  // The golden is today's bytes, written out so a reformatting of any number — rounding,
  // stringifying, re-keying — goes red here rather than in a model's reading of a screenshot.
  // MUTATION THIS PINS: running a present value through the sentinel path, or reformatting it.
  const { outcome, engine } = await runCapture(captureFrame());
  assert.equal(outcome.isError, false, JSON.stringify(outcome.content));
  assert.deepEqual(outcome.content.map((item) => item.type), ["image", "text"]);
  assert.equal(outcome.content[0].data, "iVBORw0KGgo=");
  assert.equal(outcome.content[0].mimeType, "image/png");
  assert.equal(outcome.content[1].text,
    '{"appliedScale":0.9,"byteCount":12,"mimeType":"image/png","persisted":false,'
    + '"pixelHeight":540,"pixelWidth":864,"pointSize":{"height":900,"width":1440},"scale":0.6,"windowId":12}');
  engine.close();
});

test("a frame that never answered appliedScale says so instead of dropping the key", async () => {
  // MUTATION THIS PINS: the summary going back to `canonicalJson({...body.appliedScale})`,
  // which silently DROPS an undefined key — leaving a summary that states the requested
  // `scale` only, and `gp_capture_view`'s own description promising both. The model then reads
  // the requested scale as the applied one, which is the inference the two-number sentence
  // exists to prevent. Refusing the frame was not available either: it would break a working
  // capture against an older daemon that genuinely does not report the field.
  const { outcome, engine } = await runCapture(captureFrame(["appliedScale"]));
  assert.equal(outcome.isError, false, "缺一个数字不是丢掉这张图的理由");
  assert.equal(outcome.content[0].type, "image", "图像项必须照旧交出");
  const stated = JSON.parse(outcome.content[1].text);
  assert.ok("appliedScale" in stated, `appliedScale 又被静默丢掉了：${outcome.content[1].text}`);
  assert.match(stated.appliedScale, /not reported/i, stated.appliedScale);
  assert.match(stated.appliedScale, /engine|daemon/i, "要说清是没答的那一侧：${stated.appliedScale}");
  assert.match(stated.appliedScale, /appliedScale/, "要指名是哪个字段没答");
  assert.equal(stated.scale, 0.6, "请求值仍然原样在场，但它不许冒充应用值");
  assert.notEqual(stated.appliedScale, stated.scale);
  engine.close();
});

test("a frame that never answered pixelWidth says so too, and every other number survives unchanged", async () => {
  // The same rule for every measured field the summary claims, and the control that the fix
  // is not a rewriter: the fields that WERE answered come through with their own bytes.
  const { outcome, engine } = await runCapture(captureFrame(["pixelWidth"]));
  assert.equal(outcome.isError, false);
  assert.equal(outcome.content[0].type, "image");
  const stated = JSON.parse(outcome.content[1].text);
  assert.ok("pixelWidth" in stated, "pixelWidth 被静默丢掉了");
  assert.match(stated.pixelWidth, /not reported/i, stated.pixelWidth);
  assert.equal(stated.pixelHeight, 540);
  assert.equal(stated.byteCount, 12);
  assert.equal(stated.windowId, 12);
  assert.deepEqual(stated.pointSize, { height: 900, width: 1440 }, "已答的复合字段原样转达，不做重排以外的加工");
  assert.equal(stated.persisted, false);
  engine.close();
});

// MARK: - Defect 6: one door that discovers one surface and routes another

class FakeHelloClient {
  constructor(reply) {
    this.reply = reply;
    this.calls = [];
  }

  call(method, params) {
    this.calls.push({ method, params });
    return Promise.resolve().then(() => {
      if (method !== "hello") {
        throw new Error(`this fake answers hello only, not '${method}'`);
      }
      return this.reply;
    });
  }

  close() {}
}

async function startGateway(fake) {
  const gw = createHttpGateway({
    socketPath: "/tmp/fake-engine.sock", // never touched: connectController replaces the connector
    token: TEST_TOKEN,
    port: 0,
    connectController: () => fake,
    report: () => undefined,
  });
  await new Promise((resolve) => gw.server.once("listening", resolve));
  return { gw, base: `http://127.0.0.1:${gw.server.address().port}` };
}

const ROUTED = TOOL_SPECS.filter((spec) => spec.execute === undefined).map((spec) => spec.engineMethod);

test("GET /v1/hello keeps the daemon's measurement and adds this surface's routing next to it", async () => {
  // MUTATION THIS PINS: `handleHello` relaying the daemon's hello verbatim again, which lets
  // `capabilities` advertise `capture_view` to a client standing at a door where `POST
  // /v1/tools/capture_view` is a 404 (pinned by `test/http-gateway.test.mjs`, and deliberate
  // per SECURITY.md §2.3). The daemon's list is NOT rewritten — it is a measurement — so the
  // fix is the derived field beside it, and this test holds both halves.
  const hello = fakeHelloResult();
  const fake = new FakeHelloClient(hello);
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/hello`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.result.capabilities, [...FAKE_DAEMON_CAPABILITIES],
      "daemon 的清单被动过了一刀：这条面不再转达它的测量");
    assert.deepEqual(body.result.capabilityRouting.routed, ROUTED, "routed 不是从 FORWARDABLE_TOOLS 推的吗？");
    const { routed, mcpOnly, exposedNowhere } = body.result.capabilityRouting;
    for (const name of FAKE_DAEMON_CAPABILITIES) {
      const covered = [routed, mcpOnly, exposedNowhere].filter((list) => list.includes(name));
      assert.equal(covered.length, 1, `'${name}' 在这份对账里出现了 ${covered.length} 次：要么漏了，要么重了`);
    }
    assert.ok(mcpOnly.includes("capture_view"), `capture_view 必须被点名成另一条面的工具：${JSON.stringify(mcpOnly)}`);
    assert.ok(!routed.includes("capture_view"), "capture_view 在这条面上就是 404，不许被算成路由");
    assert.deepEqual(exposedNowhere, [], "这条 daemon 的清单里没有任何一面都不暴露的方法");
    assert.ok(routed.length >= 10 && mcpOnly.length >= 1,
      `这份对账只有 ${(routed ?? []).length} 条路由、${mcpOnly.length} 条 MCP-only，条比较早就没在看东西了`);
  } finally {
    await gw.close();
  }
});

test("every capability the hello routing field names is true at the same door", async () => {
  // The reconciliation is checked by walking it: a name in `routed` must answer at
  // `POST /v1/tools/<name>`, and a name in `mcpOnly` must still be a 404 there. MUTATION THIS
  // PINS: `FORWARDABLE_TOOLS` gaining (or losing) a route without the field following it — the
  // lists are derived, so they cannot disagree — and pins a field written as prose instead of
  // computed, which 404s against its own promise.
  const fake = new FakeHelloClient(fakeHelloResult());
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/hello`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
    const { routed, mcpOnly } = (await res.json()).result.capabilityRouting;
    for (const name of routed) {
      const probe = await fetch(`${base}/v1/tools/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        body: "{}",
      });
      const body = await probe.json();
      assert.notEqual(body.error?.code, "GP_HTTP_NOT_FOUND",
        `capabilityRouting 把 '${name}' 说成这条面路由的，路由本身却 404`);
    }
    for (const name of mcpOnly) {
      const probe = await fetch(`${base}/v1/tools/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        body: "{}",
      });
      const body = await probe.json();
      assert.equal(body.error?.code, "GP_HTTP_NOT_FOUND",
        `capabilityRouting 说 '${name}' 只是另一条面的工具，这里却路由到了它`);
      assert.ok(routed.length > 0 && mcpOnly.length > 0, "两半都得有东西可比，否则这条闸在空转");
    }
  } finally {
    await gw.close();
  }
});

test("a capability this shell forwards nowhere is named as drift, not smoothed into mcpOnly", async () => {
  // The honesty half: `mcpOnly` may only contain names the MCP surface really does expose, so
  // a capability neither surface reaches is reported as what it is. MUTATION THIS PINS:
  // collapsing the two lists into one "not routed here" array, which would tell a client it
  // could reach `checkpoint` over MCP when no tool forwards it.
  const fake = new FakeHelloClient(fakeHelloResult({ capabilities: [...FAKE_DAEMON_CAPABILITIES, "checkpoint"] }));
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/hello`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
    const routing = (await res.json()).result.capabilityRouting;
    assert.deepEqual(routing.exposedNowhere, ["checkpoint"], JSON.stringify(routing));
    assert.ok(!routing.mcpOnly.includes("checkpoint"), "没转发的方法不许被说成 MCP 面有");
    assert.deepEqual(routing.advertised, [...FAKE_DAEMON_CAPABILITIES, "checkpoint"],
      "daemon 多列的那一条也要原样在场，不能被这条面对账抹掉");
  } finally {
    await gw.close();
  }
});

test("a hello with no capability list still says what this surface routes, and nothing about what it does not", async () => {
  // The absent list is a real daemon shape (a build older than the capability list), and the
  // derived field must not invent a reconciliation from nothing. MUTATION THIS PINS: deriving
  // `advertised` from `FORWARDABLE_TOOLS` when the daemon named no list, which would publish
  // this gateway's own set as the daemon's measurement.
  const fake = new FakeHelloClient({ engine: "glasspaned", version: "1.0.0", protocolVersion: "0", pid: 4242 });
  const { gw, base } = await startGateway(fake);
  try {
    const res = await fetch(`${base}/v1/hello`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
    const body = await res.json();
    assert.equal("capabilities" in body.result, false, "这半边不许替 daemon 补一个清单");
    const routing = body.result.capabilityRouting;
    assert.equal(routing.advertised, null, "没清单就说没清单");
    assert.deepEqual(routing.routed, ROUTED, "本面路由了什么与 daemon 有没有报清单无关，仍要说得出");
    assert.match(routing.note, /no capability list/i, routing.note);
  } finally {
    await gw.close();
  }
});

test("the routing field is derived from the gateway's own route table, not from a copy", () => {
  // MUTATION THIS PINS: hand-writing the exception list — `capture_view` spelled as a literal
  // in `http-gateway.ts` — which is the second-copy drift this repo refuses everywhere else.
  const source = executableSource(fs.readFileSync(path.resolve(HERE, "..", "src", "http-gateway.ts"), "utf8"));
  assert.match(source, /FORWARDABLE_TOOLS/, "这个文件不再从自己的路由表推对账了？");
  assert.doesNotMatch(source, /capture_view/, "http-gateway.ts 的源码里出现了字面量 capture_view：那份对账成了手抄的清单");
  assert.doesNotMatch(source, /recent_reports/, "同上：MCP-only 的那一半也不能靠点名实现");
  assert.ok(ROUTED.length >= 10, `这条面只认出 ${ROUTED.length} 条路由，FORWARDABLE_TOOLS 的读法大概变了`);
});
