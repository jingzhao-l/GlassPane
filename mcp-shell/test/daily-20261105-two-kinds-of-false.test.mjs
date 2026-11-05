/**
 * 每日任务 2026-11-05 · 两种 `false` 不许共用一个"丢了"计数器（复审 R-4）。
 *
 * 缺陷形状。`stdio-session.ts` 从前在注释里写"这一枚布尔没有被丢掉：`false` 意味着这一条回话
 * 永远到不了 stdout，`gp_diagnose` 从 writer 的计数器里把它读出来"。三样都不对：代码
 * `await replies.write(...)` 之后确实没读它；而两种 `false` 里只有不队列上限那一支是"从没交给
 * stdout"，drain 看门狗那一支的字节已经进了内核缓冲，只是这一侧不再等读者取走——把它记成
 * "丢了"是在声称一次没量过的损失。
 *
 * 这一条闸把**分档**钉住：该记的记（`droppedFrames` +1，并在报话里点名是哪一条 id），
 * 不该记的不许记（`droppedFrames` 保持 0），但两种都必须有可观测的出口——后一种由 writer
 * 自己那条注记报，带着等待毫秒与积压字节数，不静默。
 *
 * REVERSE：把 drain 那一支也 `this.dropped += 1` ⇒ 第二条红（计数器替一次没量过的损失作保）；
 * 把上限那一支的计数删掉 ⇒ 第一条红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import { DrainAwareWriter } from "../dist/io.js";

/** 一枚读者不取走的 sink：`_write` 永远不回调，于是字节堆在缓冲里、`drain` 永不来。 */
function stalledSink(highWaterMark = 1) {
  const sink = new Writable({
    highWaterMark,
    write(_chunk, _encoding, _cb) {
      // 故意不回调：这就是"另一端的读者停止消费"的真形状，不是桩替任何一边答话。
    },
  });
  sink.on("error", () => { /* 背压下 node 可能报错，本条判据不看它 */ });
  return sink;
}

/**
 * 把事件环交给一枚 ref'd 计时器撑着。
 *
 * `DrainAwareWriter` 自己的看门狗计时器是 `unref()` 的——一次 bounded report 不该替产品把进程
 * 钉住，那是产品的正确设计（见 `io.ts` 里那行注释）。于是"等一次 drain 超时"这一条 `await`
 * 背后没有任何 ref'd handle：GitHub 的 runner 上实测报
 * `Promise resolution is still pending but the event loop has already resolved`，本机因为旁边
 * 还有句柄活着而过去了。留一环是**夹具**的事，判据一位没动：writer 仍然只等那 20 ms，
 * 仍然不许计数。
 */
async function withLoopAlive(body) {
  const keepLoopAlive = setTimeout(() => {}, 2_000);
  try {
    await body();
  } finally {
    clearTimeout(keepLoopAlive);
  }
}

test("不队列上限那一支：从没交给 stdout 的那一帧计进 droppedFrames，并报出是哪一条 id", () => withLoopAlive(async () => {
  const notes = [];
  const writer = new DrainAwareWriter(stalledSink(), (n) => notes.push(n), 5, () => {}, 0);
  const ok = await writer.write('{"id":7,"result":{}}\n', 7);
  assert.equal(ok, false, "上限已到，这一帧不该被收下");
  assert.equal(writer.droppedFrames, 1, "从没交给 stdout 的一帧不计数，`gp_diagnose` 就会报 0");
  assert.equal(notes.length, 1, "丢一帧要说一帧");
  assert.match(notes[0], /reply 7/, `报话要点名是哪一条 id：${notes[0]}`);
  assert.match(notes[0], /past the 0 ceiling/, notes[0]);
}));

test("drain 看门狗那一支：不算丢（字节已在缓冲里），但必须把这等事说出来", () => withLoopAlive(async () => {
  const notes = [];
  const writer = new DrainAwareWriter(stalledSink(), (n) => notes.push(n), 20, () => {}, 1_000_000);
  const ok = await writer.write('{"id":9,"result":{}}\n', 9);
  assert.equal(ok, false, "drain 没等到，write() 报的就是 false");
  assert.equal(writer.droppedFrames, 0,
    "把没量过的损失记进 droppedFrames，`gp_diagnose` 就替一次没有的丢失作保");
  const note = notes.join("\n");
  assert.match(note, /has not drained within 20ms/, `这一支的可观测出口就是那条注记：${note}`);
  assert.doesNotMatch(note, /dropped, not queued/, `两种说法不许混用：${note}`);
}));
