/**
 * 每日任务 2026-11-04（同日第二条会话）· 候选 D。
 *
 * 缺陷。`LineIo` 接口（`io.ts:281`）与内部 `messageHandler`（`:299`、`:308`）都带第二参数
 * `raw`，`handleMessage` 也早就收它（`engine-client.ts:1489`）并在 `frameBodyNotLoggedNote(line, raw)`
 * 里用它——可注册侧的 `StreamLineIo.onMessage` 把 handler 签名写成 `(line: string) => void`
 * （`:344`），`engine-client.ts:1189` 于是也只转发 `(line)`。运行时那枚 Buffer 一直被传，
 * 只是没有一个读者接得住。后果：2026-11-03 #16 修完的"先 setEncoding 再算字节"在 socket 这一路
 * 又被这段接线剪断，那句 `sha256 of the exact bytes this transport received` 永远走的是
 * "拿不到就说没拿到"的降级支——承诺没兑现，而单测按类型看不出来（参数双变性让窄签名合法）。
 *
 * 判据形状来自真报文：一条**坏 UTF-8** 的帧。解码文本再回编 ≠ 原始字节，所以"读到的是线字节"
 * 与"读到的是回编字节"在这里必然给出两个不同的 sha256——这正是 #23 当初记下这件事的理由。
 *
 * REVERSE：把 `onMessage` 的签名或 `engine-client` 的转发改回只传 `line` ⇒ 第一条红（拿不到 raw）；
 * 把 `frameBodyNotLoggedNote` 里 `wireBytes ?? Buffer.from(...)` 改成只用回编 ⇒ 第二条红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";

import { StreamLineIo } from "../dist/io.js";
import { frameBodyNotLoggedNote } from "../dist/engine-client.js";

/** 一帧真的坏字节：非法续字节会让 utf8 解码产出 U+FFFD，回编就不再是原来的那串。 */
const WIRE = Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x35, 0x2c, 0x22, 0x78, 0x22,
  0x3a, 0x22, 0xc3, 0x28, 0x61, 0x22, 0x7d, 0x0a]);

test("the transport hands the consumer the bytes it actually read, not a re-encoding", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const io = new StreamLineIo(input, output);
  const seen = [];
  io.onMessage((line, raw) => seen.push({ line, raw }));

  input.emit("data", WIRE);

  assert.equal(seen.length, 1, "一帧该有一次回调");
  const { line, raw } = seen[0];
  assert.ok(Buffer.isBuffer(raw), "注册侧接不到 raw——onMessage 的签名又把线字节剪掉了");
  assert.equal(raw.toString("hex"), WIRE.subarray(0, WIRE.length - 1).toString("hex"),
    "raw 必须是去掉换行的那一段线字节，逐字节");
  assert.notEqual(Buffer.from(line, "utf8").toString("hex"), raw.toString("hex"),
    "这条夹具的意义在于解码文本回编后不等于原字节；两者相等就说明坏字节没造出来，对照是假的");
});

test("the dropped-frame note says 精确字节 only when it really has them", () => {
  const input = new PassThrough();
  const io = new StreamLineIo(input, new PassThrough());
  const reports = [];
  io.onMessage((line, raw) => reports.push(frameBodyNotLoggedNote(line, raw)));
  input.emit("data", WIRE);

  assert.equal(reports.length, 1);
  assert.match(reports[0], /exact bytes this transport received/, reports[0]);
  const digest = createHash("sha256").update(WIRE.subarray(0, WIRE.length - 1)).digest("hex").slice(0, 12);
  assert.ok(reports[0].includes(digest),
    `句子里的摘要必须是线字节的摘要（${digest}），不是回编文本的：${reports[0]}`);

  // 降级支也必须诚实：没有 raw 时不许声称"读到的正是那串字节"。
  const withoutRaw = frameBodyNotLoggedNote(WIRE.subarray(0, WIRE.length - 1).toString("utf8"));
  assert.doesNotMatch(withoutRaw, /exact bytes this transport received/, withoutRaw);
});
