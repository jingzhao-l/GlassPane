/**
 * LineReader must decode a frame ONCE, from the whole line's bytes (2026-11-04).
 *
 * The defect this pins: `consume` used to call `segment.toString("utf8")` per segment and append
 * the results into a string. A socket read boundary landing inside a multi-byte UTF-8 sequence is
 * normal for frames bigger than one read, and `toString` replaces each half with U+FFFD. The frame
 * still parsed, so a daemon reply carrying **screen text** — `gp_observe` titles, `last_evidence`
 * values — reached the agent and the report renderer with that text silently edited, while
 * `bytes`/`raw` stayed correct and every downstream length check looked fine. For a product whose
 * whole claim is evidence fidelity, a transport that rewrites the evidence is the worst class.
 *
 * Measured before the fix, on the shipped shape (`{"title":"数据"}` = 19 wire bytes): splitting at
 * each of its 18 positions corrupted the decoded title at 4 of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { LineReader, MAX_FRAME_BYTES, OVERSIZE_PREFIX_BYTES } from "../dist/io.js";

const OBJECT = { title: "数据", note: "一个标题", ascii: "plain" };
const FRAME = Buffer.from(JSON.stringify(OBJECT) + "\n", "utf8");

function sinkOf() {
  const lines = [];
  const raws = [];
  const oversize = [];
  const reader = new LineReader({
    onLine: (line, raw) => { lines.push(line); raws.push(raw); },
    onOversize: (bytes, prefix) => oversize.push({ bytes, prefix }),
  });
  return { reader, lines, raws, oversize };
}

/** Feed one frame as two chunks split at `cut`, the way a socket read would. */
function splitAt(frame, cut) {
  const got = sinkOf();
  got.reader.push(frame.subarray(0, cut));
  got.reader.push(frame.subarray(cut));
  return got;
}

test("every split point of a multi-byte frame delivers the exact text and the exact wire bytes", () => {
  const corrupted = [];
  for (let cut = 1; cut < FRAME.length; cut++) {
    const { lines, raws } = splitAt(FRAME, cut);
    assert.equal(1, lines.length, `cut ${cut}: 一条帧应当只交付一次`);
    if (lines[0].includes("\uFFFD")) corrupted.push(cut);
    assert.deepEqual(JSON.parse(lines[0]), OBJECT, `cut ${cut}: 解码结果与发送对象不再相等`);
    assert.equal(raws[0].length, FRAME.length - 1, `cut ${cut}: 线字节数不是这条帧的`);
    assert.deepEqual(raws[0], FRAME.subarray(0, FRAME.length - 1), `cut ${cut}: raw 不是线上的字节`);
  }
  assert.deepEqual([], corrupted, `这些切点把屏幕文本换成了 U+FFFD：${corrupted.join(",")}`);
});

test("one whole chunk still round-trips (the control that the loop above measures something)", () => {
  const fresh = sinkOf();
  fresh.reader.push(FRAME);
  assert.equal(1, fresh.lines.length);
  assert.deepEqual(JSON.parse(fresh.lines[0]), OBJECT);
  assert.ok(!fresh.lines[0].includes("\uFFFD"));
});

test("the retained head of an oversized frame is not cut through a character", () => {
  // Oversize attribution reads the head as text (`recoverFrameId`), so a replacement character
  // there would be handed to the agent as "what the daemon sent".
  const head = Buffer.from('{"id":7,"title":"', "utf8");
  const filler = Buffer.from("数".repeat(Math.ceil((MAX_FRAME_BYTES + 64) / 3)), "utf8");
  const body = Buffer.concat([head, filler, Buffer.from('"}\n', "utf8")]);
  assert.ok(body.length > MAX_FRAME_BYTES, "夹具必须真超上限，否则这条测的是别的东西");
  const got = sinkOf();
  const step = 7; // 7 does not divide 3, so boundaries land inside the sequences over and over
  for (let i = 0; i < body.length; i += step) {
    got.reader.push(body.subarray(i, Math.min(i + step, body.length)));
  }
  assert.equal(1, got.oversize.length, "超限要报一次，报的还是一帧");
  const reported = got.oversize[0];
  assert.equal(reported.bytes, body.length - 1,
    "报的字节数必须是这条线收到的全部字节——超限那一段也要计进去");
  assert.ok(!reported.prefix.includes("\uFFFD"),
    `保留头部被切成半个字符：${JSON.stringify(reported.prefix.slice(0, 40))}`);
  assert.ok(reported.prefix.startsWith('{"id":7'), "头部不再是发出去那一句的开头");
  assert.ok(Buffer.byteLength(reported.prefix, "utf8") <= OVERSIZE_PREFIX_BYTES,
    "保留窗口的字节宽度要有界");
});
