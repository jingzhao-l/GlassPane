import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";

import {
  DrainAwareWriter,
  LineReader,
  MAX_FRAME_BYTES,
  OrderedReplyQueue,
  OVERSIZE_PREFIX_BYTES,
  OversizeFrameError,
  StreamLineIo,
  recoverFrameId,
} from "../dist/io.js";

const MIB = 1024 * 1024;

function collector() {
  const lines = [];
  const oversize = [];
  const prefixes = [];
  const reader = new LineReader({
    onLine: (line) => lines.push(line),
    onOversize: (bytes, prefix) => {
      oversize.push(bytes);
      prefixes.push(prefix);
    },
  });
  return { reader, lines, oversize, prefixes };
}

test("an oversized line is reported once, with its exact size and retained head", () => {
  const { reader, lines, oversize, prefixes } = collector();
  const frame = `{"id":42,"result":{"tree":"${"q".repeat(MAX_FRAME_BYTES + 16)}"}}`;
  reader.push(frame + "\n");
  assert.deepEqual(oversize, [frame.length]);
  assert.equal(prefixes[0].length, OVERSIZE_PREFIX_BYTES);
  assert.equal(recoverFrameId(prefixes[0]), 42, "the head must be enough to attribute the frame");
  assert.equal(reader.pendingText(), "");
  reader.push('{"id":7}\n');
  assert.deepEqual(lines, ['{"id":7}'], "the reader stays usable after an oversize");
});

test("a slow oversize dribbled in chunks cannot grow the buffer", () => {
  const { reader, oversize } = collector();
  const chunk = "y".repeat(MIB);
  for (let i = 0; i < 8; i++) {
    reader.push(chunk);
    const kept = reader.pendingText().length;
    assert.ok(kept <= MAX_FRAME_BYTES, `chunk ${i}: retained ${kept} chars`);
    if ((i + 1) * MIB > MAX_FRAME_BYTES) {
      assert.ok(kept <= OVERSIZE_PREFIX_BYTES, `crossing the cap must drop the body, kept ${kept}`);
    }
  }
  assert.equal(oversize.length, 0, "no newline yet: nothing to report");
  reader.push("\n");
  assert.deepEqual(oversize, [8 * MIB], "the newline itself is not part of the frame");
});

test("a frame exactly at the cap is a frame, not an oversize", () => {
  const { reader, lines, oversize } = collector();
  reader.push("z".repeat(MAX_FRAME_BYTES) + "\n");
  assert.equal(oversize.length, 0);
  assert.equal(lines[0].length, MAX_FRAME_BYTES);
});

test("recoverFrameId reads numeric and string ids, and stays silent when unsure", () => {
  assert.equal(recoverFrameId('{"id":7,"method":"observe"}'), 7);
  assert.equal(recoverFrameId('{"jsonrpc":"2.0","id":"tool-1","method"'), "tool-1");
  assert.equal(recoverFrameId('{"id" : -3 ,'), -3);
  // Cut mid-number: attributing the frame would be a guess, so it is not one.
  assert.equal(recoverFrameId('{"id":12'), null);
  assert.equal(recoverFrameId('{"id":1.5,'), null);
  assert.equal(recoverFrameId('{"method":"observe","params":{"role":"AXButton"}}'), null);
});

test("StreamLineIo turns an oversize frame into a typed error, not a dead transport", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = [];
  const lines = [];
  const io = new StreamLineIo(input, output);
  io.onMessage((line) => lines.push(line));
  io.onError((error) => errors.push(error));

  input.emit("data", `{"id":3,"result":{"blob":"${"b".repeat(MAX_FRAME_BYTES)}"}}\n`);
  assert.equal(errors.length, 1);
  assert.ok(
    errors[0] instanceof OversizeFrameError,
    "an oversize must be distinguishable from a socket failure",
  );
  assert.equal(recoverFrameId(errors[0].prefix), 3);

  input.emit("data", '{"id":4,"result":{"ok":true}}\n');
  assert.deepEqual(lines, ['{"id":4,"result":{"ok":true}}'], "the same transport still works");
  io.writeLine('{"id":5,"method":"ping"}');
  assert.equal(output.read().toString(), '{"id":5,"method":"ping"}\n');
});

test("a rejected reply is reported and cannot poison later replies", async () => {
  const reported = [];
  const seen = [];
  const queue = new OrderedReplyQueue((error) => reported.push(error));
  queue.push(async () => {
    seen.push("a");
  });
  queue.push(async () => {
    throw new Error("reply exploded");
  });
  queue.push(async () => {
    seen.push("b");
  });
  await queue.drained();
  assert.deepEqual(seen, ["a", "b"], "one failed reply may not stop the queue");
  assert.equal(reported.length, 1, "the rejection must surface, not vanish");
  assert.equal(reported[0].message, "reply exploded");
});

/** Writable whose drain the test controls. */
class GateWriter extends Writable {
  chunks = [];
  blocked = false;
  releaseGate = null;

  constructor() {
    super({ highWaterMark: 1 });
  }

  _write(chunk, _encoding, callback) {
    if (this.blocked) {
      this.releaseGate = () => {
        this.chunks.push(chunk.toString());
        this.releaseGate = null;
        callback();
      };
      return;
    }
    this.chunks.push(chunk.toString());
    callback();
  }
}

test("a blocked output is waited for, then reported instead of buffering forever", async () => {
  const sink = new GateWriter();
  const notes = [];
  const writer = new DrainAwareWriter(sink, (note) => notes.push(note), 5_000, () => {});
  sink.blocked = true;
  const pending = writer.write("first\n");
  setImmediate(() => {
    sink.blocked = false;
    sink.releaseGate?.();
  });
  assert.equal(await pending, true, "the write lands once the far end drains");
  assert.deepEqual(sink.chunks, ["first\n"]);
  assert.deepEqual(notes, []);

  const stalled = new DrainAwareWriter(
    sink,
    (note) => notes.push(note),
    20,
    () => {},
  );
  // The drain watchdog is deliberately unref'd, so this test keeps the loop
  // alive itself — that is exactly what unref'ing it means.
  const keepAlive = setInterval(() => {}, 5);
  try {
    sink.blocked = true;
    assert.equal(await stalled.write("slow\n"), false, "a stall is reported as not delivered");
    assert.match(notes.join(" | "), /has not drained within 20ms/);
    sink.blocked = false;
    sink.releaseGate?.();
  } finally {
    clearInterval(keepAlive);
  }
});

test("a dead output pipe is survived, not fatal", async () => {
  const sink = new PassThrough();
  const notes = [];
  let deadCalls = 0;
  const writer = new DrainAwareWriter(sink, (note) => notes.push(note), 1_000, () => {
    deadCalls += 1;
  });
  sink.destroy(new Error("EPIPE: broken pipe"));
  // The stream emits 'error' asynchronously; asserting on the same tick would
  // only prove the flag starts false.
  await new Promise((settle) => setImmediate(settle));
  assert.equal(writer.failed, true);
  assert.equal(deadCalls, 1, "the owner gets exactly one notice to shut down");
  assert.equal(await writer.write("never\n"), false);
  assert.equal(deadCalls, 1, "later writes must not re-notify");
  assert.match(notes.join(" | "), /EPIPE/);
});
