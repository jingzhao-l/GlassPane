/**
 * 2026-10-28 daily, finding 1: the seven "this frame belongs to no request" arms in
 * `EngineJsonRpcClient.handleMessage` used to end with `truncate(line)` — the daemon's raw
 * frame bytes, up to 64 KiB, into the report sink.
 *
 * Why that is a defect and not a diagnostic convenience: a body on this socket is observe /
 * assert content (element titles and values, sometimes a document's text). The state root is
 * 0700, but `onEngineNote` goes to stderr, and stderr's mode belongs to whoever supervises the
 * process — this product never sets it. F3 on 2026-10-27 already established the rule for the
 * one path that had a *reply* to log (`lateReplyBodyNote`: size + digest, never the text) and
 * moved the HTTP doorway onto it; the seven arms were never moved, so the same module held two
 * opposite rules about the same bytes, and no test drove any of them (the existing redaction
 * file drives only `reportLateReply`).
 *
 * Each arm here is driven with a body carrying a marker in the real shape the daemon answers
 * (`{tree:[{role:"AXStaticText",value:"…"}]}`), then the note is checked three ways: the marker
 * is absent, the byte count is recomputed from the exact bytes sent (not copied from the
 * message), and the digest is recomputed independently. The last test is the control that keeps
 * this from being a scrubber that also destroyed diagnosability: a *short* field is still quoted
 * verbatim, and the request the client is still waiting on is still named.
 *
 * Reverse mutation: put `${line}` (or `truncate(line)`) back into any of the seven arms ⇒ the
 * matching named test below goes red on the marker assertion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EngineJsonRpcClient } from "../dist/engine-client.js";
import { TOOL_BY_NAME } from "../dist/tools.js";
import { FakeLineIo } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "src", "engine-client.ts"), "utf8");

/** Screen content, in the shape the daemon's `observe` actually answers with. */
const MARKER = "合同金额壹佰贰拾捌万元整·仅限内部";
const SCREEN_BODY = { tree: [{ role: "AXStaticText", value: MARKER, frame: { x: 12, y: 340 } }] };

function noteHarness() {
  const io = new FakeLineIo();
  const notes = [];
  const client = new EngineJsonRpcClient(io);
  client.onEngineNote((note) => notes.push(note));
  return { io, client, notes };
}

/** The bytes the transport would have seen, exactly as the arm received them. */
function rawOf(payload) {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

/**
 * What every one of these seven lines must look like at its tail: the frame reported by size
 * and digest. Recomputed here from the same bytes so a note that *prints* a wrong number is
 * caught, not just a note that prints text.
 */
function assertRedacted(note, raw, context) {
  const bytes = Buffer.byteLength(raw, "utf8");
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  assert.ok(
    note.includes(`a ${bytes}-byte frame (sha256 ${digest})`),
    `${context}: 这一行要能由帧字节自己复算出来 ${JSON.stringify({ bytes, digest })} -> ${note.slice(0, 300)}`,
  );
  assert.ok(!note.includes(MARKER), `${context}: 屏幕正文不得出现在这一行 -> ${note.slice(0, 300)}`);
  assert.ok(!note.includes("AXStaticText"), `${context}: 控件角色也是屏幕内容 -> ${note.slice(0, 300)}`);
  return note;
}

test("非 JSON 帧：报字节与摘要，不抄正文", async () => {
  const { io, client, notes } = noteHarness();
  const raw = `observe-tree ${MARKER} {"id":1,`;
  io.send(raw);
  await new Promise((resolve) => setImmediate(resolve));
  const note = notes.find((line) => /engine sent a non-JSON frame, dropped: /.test(line));
  assert.ok(note, `必须留下一句被丢弃的话，不能静默：${notes.join(" | ")}`);
  assertRedacted(note, raw, "非 JSON 帧");
  client.close();
});

test("合法 JSON 但不是对象：数组 / null / 数字 / 字符串 四样都要红在同一个作者上", async () => {
  for (const payload of [
    [`screen ${MARKER}`],
    null,
    7,
    `a string ${MARKER}`,
    true,
  ]) {
    const { io, client, notes } = noteHarness();
    const raw = JSON.stringify(payload);
    io.send(raw);
    await new Promise((resolve) => setImmediate(resolve));
    const note = notes.find((line) => /engine sent a frame that is not a JSON object, dropped: /.test(line));
    assert.ok(note, `每一样都要留下一句话：${raw} -> ${notes.join(" | ")}`);
    assertRedacted(note, raw, `非对象帧 ${raw.slice(0, 20)}`);
    client.close();
  }
});

test("陌生 id 的帧：仍然点名在途请求，但正文不进这一行", async () => {
  const { io, client, notes } = noteHarness();
  const waiting = client.call("observe", { maxDepth: 6 });
  const sent = io.lastFrame();
  const raw = rawOf({ id: sent.id + 9999, result: SCREEN_BODY });
  io.send(raw);
  await new Promise((resolve) => setImmediate(resolve));
  const note = notes.find((line) => /which this client never issued \(or already gave up on\)/.test(line));
  assert.ok(note, `陌生 id 必须被点名拒绝：${notes.join(" | ")}`);
  assert.match(note, /still tracks 1 request\(s\): 'observe'/, `可诊断性不能一起删掉 -> ${note.slice(0, 300)}`);
  assertRedacted(note, raw, "陌生 id");
  // 被丢掉的只有那一帧：仍在途的请求照常答复，不因为这次改动而变成"永远等不到"。
  io.respond({ tree: [] });
  assert.deepEqual(await waiting, { tree: [] });
  client.close();
});

test("有请求在途时的无 id 结果帧：不投递给任何调用方，也不抄它的正文", async () => {
  const { io, client, notes } = noteHarness();
  const waiting = client.call("snapshot", {});
  const sent = io.lastFrame();
  const raw = rawOf({ result: SCREEN_BODY });
  io.send(raw);
  await new Promise((resolve) => setImmediate(resolve));
  const note = notes.find((line) => /is still waiting for its answer/.test(line));
  assert.ok(note, `这一支必须说话：${notes.join(" | ")}`);
  assert.match(note, new RegExp(`'snapshot' \\(id ${sent.id}\\)`), note);
  assertRedacted(note, raw, "在途时的无 id 结果帧");
  io.respond({ snapshotId: "snap_OK" });
  assert.deepEqual(await waiting, { snapshotId: "snap_OK" });
  client.close();
});

test("没有请求在途时的 error 帧：报代号，不报 message/remedy 的正文", async () => {
  const { io, client, notes } = noteHarness();
  const first = client.call("probe_status");
  io.respond({ connected: false });
  await first;
  const raw = rawOf({
    id: null,
    error: { code: "GP_E_NOT_ATTACHED", message: MARKER, remedy: `${MARKER} 的第二段` },
  });
  io.send(raw);
  await new Promise((resolve) => setImmediate(resolve));
  const note = notes.find((line) => /engine reported .* with no request in flight: /.test(line));
  assert.ok(note, `这一支必须说话：${notes.join(" | ")}`);
  assert.match(note, /GP_E_NOT_ATTACHED/, `代号是要留的诊断信息 -> ${note.slice(0, 300)}`);
  assertRedacted(note, raw, "在途之外的 error 帧");
  client.close();
});

test("没有请求在途时的无 id 结果帧：同样只报字节与摘要", async () => {
  const { io, client, notes } = noteHarness();
  const raw = rawOf({ result: SCREEN_BODY });
  io.send(raw);
  await new Promise((resolve) => setImmediate(resolve));
  const note = notes.find((line) => /engine sent an id-less frame with no request in flight: /.test(line));
  assert.ok(note, `这一支必须说话：${notes.join(" | ")}`);
  assertRedacted(note, raw, "在途之外的无 id 结果帧");
  client.close();
});

test("非数字 id：短的原样报（那是诊断要的），长的按字节与摘要报", async () => {
  const { io, client, notes } = noteHarness();
  const shortRaw = rawOf({ id: "dup", result: SCREEN_BODY });
  io.send(shortRaw);
  await new Promise((resolve) => setImmediate(resolve));
  const shortNote = notes.find((line) => /non-numeric request id \("dup"\)/.test(line));
  assert.ok(shortNote, `一个正常的短 id 值要能读出来：${notes.join(" | ")}`);
  assertRedacted(shortNote, shortRaw, "非数字 id（短值）");

  const longId = `${"x".repeat(4_000)}${MARKER}`;
  const longRaw = rawOf({ id: longId, result: SCREEN_BODY });
  io.send(longRaw);
  await new Promise((resolve) => setImmediate(resolve));
  const longNote = notes.filter((line) => /non-numeric request id/.test(line)).pop();
  assert.ok(longNote, `长 id 也要说话：${notes.join(" | ")}`);
  assert.match(longNote, /-char value \(sha256 [0-9a-f]{12}, \d+ bytes\) not quoted here/, longNote);
  assertRedacted(longNote, longRaw, "非数字 id（长值）");
  client.close();
});

test("note 里点名的回读工具是 tools.ts 里真实存在的名字", async () => {
  const { io, client, notes } = noteHarness();
  const raw = rawOf(SCREEN_BODY);
  io.send(raw);
  await new Promise((resolve) => setImmediate(resolve));
  const note = notes.join(" | ");
  const named = note.match(/gp_[a-z_]+/g) ?? [];
  assert.deepEqual(named, ["gp_last_evidence", "gp_export_evidence"], `这一行提到了这些工具：${JSON.stringify(named)}`);
  for (const tool of named) {
    assert.ok(TOOL_BY_NAME.get(tool), `note 把调用方支到一条不存在的工具：${tool}`);
  }
  client.close();
});

test("七个分支谁都不许再把帧正文抄进日志——源码侧的闸，且不许用注释糊过去", () => {
  const offenders = [];
  SRC.split("\n").forEach((lineText, index) => {
    const trimmed = lineText.trim();
    // 只量真会执行的那一行：注释与文档块里的字不算泄漏（把注释当缺陷，下一轮就会删注释换绿）。
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (/truncate\(/.test(trimmed)) offenders.push(`${index + 1}: 又用起了 truncate() -> ${trimmed.slice(0, 120)}`);
    if (/\$\{line\}/.test(trimmed) || /" \+ line\b/.test(trimmed) || /\+ line[,)]/.test(trimmed)) {
      offenders.push(`${index + 1}: 把整帧拼进了这一行 -> ${trimmed.slice(0, 120)}`);
    }
  });
  assert.deepEqual(offenders, [], `这些行会把 daemon 帧的正文写进日志：\n${offenders.join("\n")}`);
  assert.match(SRC, /export function frameBodyNotLoggedNote/, "七个分支要共用同一位作者，不许各写一句");
  assert.doesNotMatch(SRC, /export const LOG_BODY_CHARS/, "正文上限一旦存在就会被重新拿起");
});
