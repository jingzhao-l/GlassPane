/**
 * 每日任务 2026-11-05 · 生产链的线字节。
 *
 * 缺陷。2026-11-04 候选 D 修的是 `StreamLineIo` 把 `raw` 交给消费侧，可生产里没人直接建
 * `StreamLineIo`——真实链路是 `unixSocketEngineClient` → `ReconnectingSocketIo` → 内层
 * `StreamLineIo` → `EngineJsonRpcClient.handleMessage`。`ReconnectingSocketIo.onMessage`
 * 从前只收 `(line)`：`LineIo` 声明的是 `(line, raw?)`，参数双变性让窄一点的签名合法，
 * 于是 `raw` 在生产传输上被这段接线剪掉而 `tsc` 一声不响——`frameBodyNotLoggedNote` 里
 * 那句 `sha256 of the exact bytes this transport received` 在真实链路上永远走"拿不到就
 * 说没拿到"的降级支。daily-20261104-onmessage-wire-bytes 直接构造 `StreamLineIo`，
 * 恰好绕过了这一环：那条测试全绿时，生产链仍然是断的。
 *
 * 所以这一条不许再搭任何一段替身：客户端、传输、接线、丢帧判据全部走
 * `dist/engine-client.js` 的生产实现，唯一的缝是 `options.open`（返回一枚没有回环的
 * Duplex 假 socket，与 daily-20261031 的 SeamSocket 同一等 seam）与 `options.trust`
 * （seam socket 不是文件系统对象，信任闸对它无事可 stat，答"不拒绝"——那是该 seam
 * 被文档化的行为，不是为测试开的后门）。送上去的那一帧是真的坏 UTF-8：解码文本回编后
 * 不等于原始字节（夹具形状沿用 2026-11-04 那条），JSON 的 `id` 是非数值——正是
 * `handleMessage` 里"这客户端从不发这种 id"那一判据臂。
 *
 * REVERSE（本轮实跑过）：把 `ReconnectingSocketIo.connect()` 里那行转发改回只传 `line`
 * （`this.messageHandler?.(line)`）⇒ 本文件第一条按名字变红——note 落回
 * "as this transport decoded it" 的降级措辞，且摘要变成回编文本的；把 `onMessage` 的
 * 注册签名再收窄成 `(line: string) => void` ⇒ 同一处红。两侧都改回 ⇒ 绿，且
 * "回编摘要 ≠ 线字节摘要"那句对照保证夹具没有自我实现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { createHash } from "node:crypto";

import { unixSocketEngineClient } from "../dist/engine-client.js";

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

/** 写入被吞掉的假 socket：读侧只收测试亲手 `push` 的字节，没有 PassThrough 那种回环。 */
class WireSocket extends Duplex {
  written = [];

  _write(chunk, _encoding, callback) {
    this.written.push(Buffer.from(chunk));
    callback();
  }

  _read() {}
}

/**
 * 一帧坏 UTF-8、id 非数值的 JSON：`0xc3` 后跟 `0x28` 不是合法的 UTF-8 续字节对，
 * 解码出 U+FFFD，回编不再等于原始字节——"摘要算的是线字节"与"摘要算的是解码文本"
 * 在这一帧上必然给出两个数，这正是本文件要区分的那一件事。
 */
function badUtf8NonNumericIdFrame() {
  const head = Buffer.from('{"jsonrpc":"2.0","id":"not-a-number","note":"', "utf8");
  const corrupt = Buffer.from([0xc3, 0x28, 0x61]);
  const tail = Buffer.from('"}', "utf8");
  return Buffer.concat([head, corrupt, tail, Buffer.from([0x0a])]);
}

test("生产链 unixSocketEngineClient → ReconnectingSocketIo → EngineJsonRpcClient 把线字节一路交给丢帧注记", async () => {
  const socket = new WireSocket();
  const client = unixSocketEngineClient("/var/tmp/gp-daily-20261105-wire/engine.sock", {
    open: () => socket,
    // 与 daily-20261031 的 SeamSocket 用例同一枚 seam：不是文件系统对象，信任闸无事可测。
    trust: () => null,
  });
  const notes = [];
  client.onEngineNote((note) => notes.push(note));
  try {
    // 生产链是惰性的：第一笔写出才打开内层传输。这一笔永远不被回答，测试不读它的那一面。
    const inflight = client.call("probe_status");
    inflight.catch(() => {});
    assert.ok(socket.written.length >= 1, "写出没有经过 ReconnectingSocketIo.connect()——这一条就没在测生产链");
    socket.emit("connect"); // 真 net.Socket 会给这枚事件；onOpen 之后 hello 握手也走生产实现
    const wire = badUtf8NonNumericIdFrame();
    socket.push(wire);
    await nextTick();

    const note = notes.find((entry) => entry.includes("non-numeric request id"));
    assert.ok(note !== undefined, `非数值 id 的帧没有被 handleMessage 走"从不发行"臂报出来：${JSON.stringify(notes)}`);
    // 承诺的那半句：拿得到真字节，才许说"精确字节"。
    assert.match(note, /exact bytes this transport received/, note);
    const wireNoNewline = wire.subarray(0, wire.length - 1);
    const wireDigest = createHash("sha256").update(wireNoNewline).digest("hex").slice(0, 12);
    assert.ok(note.includes(wireDigest), `注记的摘要必须是线字节（去换行）的摘要 ${wireDigest}：${note}`);
    // 夹具前提：坏字节真的坏——回编与原始不同，两个摘要才可区分；相等就是对照自我实现。
    const decodedDigest = createHash("sha256")
      .update(Buffer.from(wireNoNewline.toString("utf8"), "utf8"))
      .digest("hex")
      .slice(0, 12);
    assert.notEqual(decodedDigest, wireDigest, "坏 UTF-8 没造出来：回编==原始，这条对照读不到任何东西");
    assert.ok(!note.includes(decodedDigest), `注记报的是回编文本的摘要（${decodedDigest}），线字节在这一环被剪掉了：${note}`);
  } finally {
    client.close();
  }
});
