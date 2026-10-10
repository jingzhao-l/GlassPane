/**
 * Review 2026-10-09, TypeScript MCP shell.
 *
 * Each test below was written against the *behaviour*, and the stubs refuse the
 * way production refuses: frames use the daemon's real wire shapes (an error frame
 * is `{id, error:{code, message, remedy}}`; a reply echoes the integer id this
 * client sent), and where a defect is about the transport tearing a socket down,
 * the stub is a real `Duplex` driven through the production `StreamLineIo` /
 * `ReconnectingSocketIo` so it can close like `io.ts` does. A stub that answers
 * anything is the defect class this file exists to catch.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EngineCallError,
  engineClientOver,
  isReplayUnsafeMethod,
  unixSocketEngineClient,
} from "../dist/engine-client.js";
import { MAX_FRAME_BYTES } from "../dist/io.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { executeTool, shellFaultRemedy, TOOL_BY_NAME, TOOL_SPECS } from "../dist/tools.js";
import { FakeLineIo } from "./helpers.mjs";
import { executableSource } from "./support/source.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "..", "dist", "index.js");
const OP_A = "op_0123456789ABCDEFGHJKMNPQRS";
const OP_B = "op_123456789ABCDEFGHJKMNPQRST";
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A daemon reply frame in the shape `Dispatcher.response` actually writes. */
const resultFrame = (id, result) => JSON.stringify({ id, result });
/** An engine error frame: code + message + remedy, the three keys §3.2.1. */
const errorFrame = (id, code, message, remedy) =>
  JSON.stringify({ id, error: { code, message, remedy } });

/** The evidence pack shape `Dispatcher.handleLastEvidence` wraps in `evidencePack`. */
function evidenceFrame(operationId) {
  return {
    evidencePack: {
      schemaVersion: "glasspane.evidence/0.1",
      operationId,
      createdAt: "2026-09-15T00:00:00.000Z",
      attribution: { level: "soft", contaminated: false },
      circuitBreaker: { level: 0 },
      signals: {
        act: { selector: { role: "AXButton", title: "Submit" }, action: "press", actConfirmed: true },
        axEvent: {
          axChanged: false, latencyMs: 9, nodeCount: 42,
          treeDigestBefore: "a".repeat(32), treeDigestAfter: "b".repeat(32),
        },
        handlerProbe: null,
        stateDiff: null,
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Finding 1 — an oversize daemon reply must fail only its own request.
 * ------------------------------------------------------------------ */

/**
 * A daemon socket that behaves like the real thing: the frames it writes are
 * parsed by the production `LineReader`, it can hand back a line over the cap,
 * and `destroy()` really closes it (which is what the old stub could not do, and
 * why this shipped).
 */
class RealShapeDaemonSocket extends Duplex {
  sent = [];
  _write(chunk, _enc, cb) {
    this.sent.push(chunk.toString());
    cb();
  }
  _read() {}
  deliver(object) {
    this.push(typeof object === "string" ? object : JSON.stringify(object) + "\n");
  }
  frames() {
    return this.sent.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
}

function socketEngine() {
  const sockets = [];
  const notes = [];
  const client = unixSocketEngineClient("/tmp/glasspane-review-2026-10-09.sock", {
    open: () => {
      const socket = new RealShapeDaemonSocket();
      sockets.push(socket);
      return socket;
    },
  });
  client.onEngineNote((note) => notes.push(note));
  return { client, sockets, notes };
}

test("an oversize daemon reply fails only its own call and leaves the socket up for the other one", async () => {
  const { client, sockets, notes } = socketEngine();
  const doomed = client.call("observe", { maxDepth: 10 });
  const survivor = client.call("act", { selector: { role: "AXButton" }, action: "press" });
  const [observeFrame, actFrame] = sockets[0].frames();

  // Over the cap by enough to blow past a pipe buffer, written the way the
  // daemon writes: one line, newline terminated.
  const huge = `{"id":${observeFrame.id},"result":{"tree":"${"x".repeat(MAX_FRAME_BYTES + 4_096)}"}}\n`;
  sockets[0].deliver(huge);

  await assert.rejects(doomed, (error) => {
    assert.equal(error.code, "GP_E_PAYLOAD_TOO_LARGE");
    // The claim in that message has to be the behaviour, so check the half about
    // the innocent caller where the caller is.
    assert.match(error.message, /connection is intact/);
    assert.doesNotMatch(error.remedy, /--restore-launchd|launchctl|restart/, "一个超长帧不是重启 daemon 的依据");
    return true;
  });

  let survivorState = "pending";
  survivor.then(() => { survivorState = "resolved"; }, () => { survivorState = "rejected"; });
  await tick();
  assert.equal(survivorState, "pending", "另一路在途请求不能因为别人那一帧超限就被判死");

  // The transport survived: same socket, still not destroyed, no reconnect, and
  // the daemon's real reply for `act` still reaches its caller.
  assert.equal(sockets.length, 1, "超限帧不该让传输重建");
  assert.equal(sockets[0].destroyed, false, "超限帧不该关掉 socket");
  assert.ok(!notes.some((note) => /transport closed|transport error|late-reply tracking ended/.test(note)), notes.join(" | "));
  sockets[0].deliver({ id: actFrame.id, result: { operationId: OP_A, evidencePersisted: true } });
  assert.deepEqual(await survivor, { operationId: OP_A, evidencePersisted: true });
  client.close();
});

/* ------------------------------------------------------------------ *
 * Finding 2 — an id-less error frame may not spend another caller's entry.
 * ------------------------------------------------------------------ */

test("an id-less error frame settles its inferred caller but keeps the entry for the daemon's real reply", async () => {
  const io = new FakeLineIo();
  const client = engineClientOver(io, 5_000);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  const late = [];
  client.onLateReply((reply) => late.push(reply));

  const act = client.call("act", { selector: { role: "AXButton" }, action: "press" });
  const actId = io.lastFrame().id;
  // The daemon's id-less answer, exactly as `Dispatcher.structuredErrorLine` writes it.
  io.send(errorFrame(null, "GP_E_NOT_ATTACHED", "no app attached", "attach the app with gp_attach first"));
  await assert.rejects(act, (error) => {
    assert.equal(error.code, "GP_E_NOT_ATTACHED");
    assert.match(error.message, /carried no request id/);
    return true;
  });

  // The real reply for that same act arrives afterwards, with its id echoed: it
  // must still be attributed (late), not read as a frame this client never issued.
  io.send(resultFrame(actId, { operationId: OP_A, evidencePersisted: true }));
  await tick();
  assert.ok(!notes.some((note) => /never issued/.test(note)), notes.join(" | "));
  assert.equal(late.length, 1, "真实回复要落进迟到通路，operationId 才有记录");
  assert.equal(late[0].method, "act");
  assert.equal(late[0].result.operationId, OP_A);
  assert.equal(late[0].attribution, "echoed-id");

  // The spent guess is not re-spent on the act: the entry is marked, so a second
  // id-less frame can only be inferred onto the request that is *now* oldest —
  // and the request whose answer already arrived is never answered twice.
  const next = client.call("snapshot", { maxDepth: 2 });
  io.send(errorFrame(null, "GP_E_AX_UNAVAILABLE", "the accessibility api is wedged", "restart the accessibility service"));
  await assert.rejects(next, (error) => {
    assert.equal(error.code, "GP_E_AX_UNAVAILABLE");
    assert.match(error.message, /method 'snapshot'/, "第二次推断要落在当下最老的那一路，而不是已经答过的 act");
    return true;
  });
  // The act's real reply was already routed as a late one, so nothing further may
  // be claimed about it; and the client still works for the next request.
  const after = client.call("observe", { maxDepth: 1 });
  io.respond({ tree: { role: "AXWindow" } });
  assert.deepEqual(await after, { tree: { role: "AXWindow" } });
  assert.equal(late.length, 1, "迟到通路只该收到 act 那一条真实回复");
  client.close();
});

/* ------------------------------------------------------------------ *
 * Finding 3 — a late reply's body is on-screen content, not log content.
 * ------------------------------------------------------------------ */

test("a late reply logs method, id and byte count instead of the on-screen body", async () => {
  const io = new FakeLineIo();
  const client = engineClientOver(io, 20);
  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  const secret = "the-user-opened-a-document-titled-Draft-divorce-settlement";
  const promise = client.call("observe", { maxDepth: 10 });
  const requestId = io.lastFrame().id;
  await assert.rejects(promise, (error) => error.code === "GP_E_ENGINE_TIMEOUT");
  io.send(resultFrame(requestId, { tree: { role: "AXWindow", title: secret } }));
  await tick();
  const late = notes.find((note) => /late engine reply/.test(note));
  assert.ok(late, `expected a late-reply note in: ${notes.join(" | ")}`);
  assert.doesNotMatch(late, new RegExp(secret), "正文是屏幕上的内容，不能整段抄进日志");
  assert.match(late, /'observe'/);
  assert.match(late, /\(id \d+\)/);
  assert.match(late, /byte/, "要说清答复有多大、确实答过");
  assert.match(late, /not (be )?written|not redacted|raw engine content/);
  client.close();
});

/* ------------------------------------------------------------------ *
 * Findings 4 and 5 — the all-missing report, and a fetch failure's remedy.
 * ------------------------------------------------------------------ */

async function recentReportsWith(ioResponder, operations) {
  const io = new FakeLineIo();
  const engine = engineClientOver(io, 5_000);
  const session = new EvidenceAuditSession();
  for (const operationId of operations) {
    session.record({ operationId });
  }
  const promise = executeTool(TOOL_BY_NAME.get("gp_recent_reports"), { limit: 5 }, engine, session);
  await ioResponder(io, operations.length);
  const outcome = await promise;
  engine.close();
  return outcome.content.map((item) => item.text ?? "").join("\n");
}

const answerEveryFrame = (build) => async (io, count) => {
  for (let index = 0; index < count; index++) {
    await tick();
    io.send(build(io.lastFrame().id, index));
  }
};

test("a trail whose ids are all missing states no cause and orders no re-run", async () => {
  const text = await recentReportsWith(
    answerEveryFrame((id) => errorFrame(id, "GP_E_NO_EVIDENCE", "no evidence pack for that operation", "run gp_act first")),
    [OP_A, OP_B],
  );
  assert.match(text, /^GP_E_NO_EVIDENCE/);
  // The branch may not assert a cause it never measured, and may not order a
  // second press of an action the trail already recorded.
  assert.doesNotMatch(text, /the engine may have restarted|may have restarted/, "这一支什么都没测到，不能指认原因");
  assert.match(text, /Do not re-run gp_act/, "缺的是无重放的警告");
  for (const match of text.matchAll(/re-run gp_act/g)) {
    assert.match(
      text.slice(Math.max(0, match.index - 12), match.index),
      /do not\s*$/i,
      "出路里每一句 re-run gp_act 都必须是否定式",
    );
  }
  assert.match(text, /gp_last_evidence/, "要给出读得到证据的那条路");
});

test("a failed evidence fetch keeps the daemon's remedy in the partial report", async () => {
  const remedy = "attach the app with gp_attach, then read this operation again by id";
  const text = await recentReportsWith(
    answerEveryFrame((id, index) => (index === 0
      ? errorFrame(id, "GP_E_NOT_ATTACHED", "no app attached", remedy)
      : resultFrame(id, evidenceFrame(OP_B)))),
    [OP_A, OP_B],
  );
  assert.match(text, /GP_E_NOT_ATTACHED/);
  assert.match(text, /remedy:/, "部分报告里的失败行也得带 remedy 这一格");
  assert.ok(text.includes(remedy), `daemon 的出路被 describeFetchFailure 丢了：${text.slice(0, 400)}`);
});

/* ------------------------------------------------------------------ *
 * Finding 6 — the argument error has to survive a pipe.
 * ------------------------------------------------------------------ */

function runShell(args, stderrSink) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => stderrSink(chunk.toString()));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end();
  });
}

test("a bad argument writes the whole message before exiting, through a pipe", async () => {
  // The unknown argument is itself 200 KB, so the *message* it produces is longer
  // than the 64 KB pipe capacity: a queued (asynchronous) piped write followed by
  // `process.exit()` loses exactly the tail these assertions read.
  const long = "x".repeat(200_000);
  let seen = "";
  const { code } = await runShell([long], (chunk) => { seen += chunk; });
  assert.equal(code, 2);
  assert.match(seen, /unknown argument/);
  assert.match(seen, /usage: glasspane-mcp/);
  assert.ok(seen.includes("<state-dir>/daemon.sock."), `管道里的用法文本被截断了（收到 ${seen.length} 字节）`);
  assert.ok(seen.length > 200_000, `长消息必须整条送达，收到 ${seen.length} 字节`);
});

/* ------------------------------------------------------------------ *
 * Finding 7 — a stdin error must wait behind the replies already produced.
 * ------------------------------------------------------------------ */

test("stdin's error path queues shutdown the way the close path does", () => {
  const source = fs.readFileSync(path.resolve(HERE, "..", "src", "index.ts"), "utf8");
  const errored = /process\.stdin\.on\("error",\s*\(error\) => \{([\s\S]{0,900}?)\n  \}\);/.exec(source);
  assert.ok(errored, "读不到 stdin 的 error 处理器，这条闸要看的是它自己");
  const body = errored[1];
  assert.match(body, /queue\.push\(async \(\) => shutdown\(\)\)/, "error 通路必须和 close 通路一样排在已产出的回复之后");
  assert.doesNotMatch(body, /^\s*shutdown\(\);/m, "直接 shutdown() 会抢在写之前 end 掉 stdout，回复落在已结束流的写里丢掉");
});

/* ------------------------------------------------------------------ *
 * Finding 8 — no remedy for a replay-unsafe method may order a re-send.
 * ------------------------------------------------------------------ */

test("table: no shell-fault remedy for a replay-unsafe method orders a re-send", () => {
  const checked = [];
  for (const spec of TOOL_SPECS) {
    if (!isReplayUnsafeMethod(spec.engineMethod)) {
      continue;
    }
    const remedy = shellFaultRemedy(spec.engineMethod);
    checked.push(spec.name);
    assert.match(remedy, /Do NOT re-issue/, `${spec.name} 的出路没说不许重发`);
    for (const forbidden of [/then retry/, /retry this call/, /re-run /, /send it again/]) {
      assert.doesNotMatch(remedy, forbidden, `${spec.name} 的出路又要求重发 ${spec.engineMethod}：${remedy.slice(0, 200)}`);
    }
    assert.ok(
      /gp_recent_reports|gp_last_evidence|gp_probe_status/.test(remedy),
      `${spec.name} 的出路没有点名一个读得到状态的只读工具`,
    );
    assert.doesNotMatch(remedy, /see the MCP server logs/, "日志不是调用方做得动的下一步");
  }
  assert.deepEqual(checked.sort(), ["gp_act", "gp_attach", "gp_restore"], "重放不安全的方法表变了，这条闸要按新表重跑");
});

/* ------------------------------------------------------------------ *
 * Finding 10 — executeTool's trail is the server's, never a per-call secret.
 * ------------------------------------------------------------------ */

test("executeTool refuses a call with no session instead of recording into a private trail", async () => {
  const io = new FakeLineIo();
  const engine = engineClientOver(io, 5_000);
  const act = TOOL_BY_NAME.get("gp_act");
  const args = { selector: { role: "AXButton" }, action: "press" };

  const withoutSession = await executeTool(act, args, engine, undefined);
  assert.equal(withoutSession.isError, true);
  assert.match(withoutSession.content[0].text, /GP_E_INTERNAL/);
  assert.match(withoutSession.content[0].text, /without the session.s trail/);
  assert.match(withoutSession.content[0].text, /shared EvidenceAuditSession/);
  assert.equal(io.sent.length, 0, "缺会话时连帧都不该发出去");

  const session = new EvidenceAuditSession();
  const promise = executeTool(act, args, engine, session);
  io.respond({ operationId: OP_A, evidencePersisted: true });
  const outcome = await promise;
  assert.equal(outcome.isError, false);
  assert.deepEqual(session.recentIds(5), [OP_A], "带会话的这一笔必须进的是调用方拿得到的那条 trail");
  engine.close();
});

/* ------------------------------------------------------------------ *
 * Finding 11 — a capture frame's mimeType is the engine's to state.
 * ------------------------------------------------------------------ */

test("capture_view refuses a frame that omits mimeType instead of defaulting it", async () => {
  const capture = TOOL_BY_NAME.get("gp_capture_view");
  const missing = new FakeLineIo();
  const missingEngine = engineClientOver(missing, 5_000);
  const promise = executeTool(capture, {}, missingEngine, new EvidenceAuditSession());
  missing.respond({ pngBase64: "aWNh", persisted: false, byteCount: 4, pixelWidth: 2, pixelHeight: 2, scale: 1, appliedScale: 1 });
  const outcome = await promise;
  assert.equal(outcome.isError, true);
  assert.match(outcome.content[0].text, /without a mimeType/);
  assert.doesNotMatch(outcome.content[0].text, /image\/png/, "壳不能替引擎宣布这张图是什么格式");

  const stated = new FakeLineIo();
  const statedEngine = engineClientOver(stated, 5_000);
  const ok = executeTool(capture, {}, statedEngine, new EvidenceAuditSession());
  stated.respond({ pngBase64: "aWNh", persisted: false, mimeType: "image/png", byteCount: 4 });
  const good = await ok;
  assert.equal(good.isError, false);
  assert.equal(good.content[0].mimeType, "image/png");
  missingEngine.close();
  statedEngine.close();
});

/* ------------------------------------------------------------------ *
 * Finding 12 — a remedy is only worth printing if it can be run from anywhere.
 * ------------------------------------------------------------------ */

test("no remedy hands out a command resolved against an unknown cwd or PATH", () => {
  // Comments are stripped first: this file explains, in prose, which spellings it
  // stopped using, and a gate that fired on that explanation would be tuned to be
  // broken (the reasoning is in `test/support/source.mjs`).
  const source = executableSource(fs.readFileSync(path.resolve(HERE, "..", "src", "tools.ts"), "utf8"));
  // Command *position* spellings: a remedy that explains what it stopped naming
  // ("the `python3 -m json.tool` this line used to name") is prose about the old
  // defect and stays; one that hands the agent the old command is the defect.
  for (const notExecutable of [
    /`node updater\/cli\.js/,
    /`node installer\/cli\.js/,
    /with `python3 -m json\.tool/,
    /see the MCP server logs/,
  ]) {
    assert.doesNotMatch(source, notExecutable, `${notExecutable} 又在出路里：它按读者的工作目录或 PATH 解析`);
  }
  assert.match(source, /absoluteNodeCommand|repoScript/, "出路要由绝对路径拼出来");
});
