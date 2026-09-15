import { test } from "node:test";
import assert from "node:assert/strict";

import { LineReader, MAX_FRAME_BYTES } from "../dist/io.js";

/** Collect lines/oversize callbacks from a reader for assertions. */
function collector() {
  const lines = [];
  const oversize = [];
  const reader = new LineReader({
    onLine: (line) => lines.push(line),
    onOversize: (bytes) => oversize.push(bytes),
  });
  return { reader, lines, oversize };
}

test("line reader reassembles a JSON message split across chunks", () => {
  const { reader, lines } = collector();
  reader.push('{"id":1,"me');
  reader.push('thod":"ping"}');
  reader.push("\n");
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '{"id":1,"method":"ping"}');
  assert.equal(reader.pendingText(), "");
});

test("line reader emits two frames from one chunk with trailing newline", () => {
  const { reader, lines } = collector();
  reader.push("a\nb\n");
  assert.deepEqual(lines, ["a", "b"]);
});

test("partial frame stays pending until its newline", () => {
  const { reader, lines } = collector();
  reader.push("no-newline");
  assert.deepEqual(lines, []);
  assert.equal(reader.pendingText(), "no-newline");
});

test("empty line yields an empty frame for the dispatcher to skip", () => {
  const { reader, lines } = collector();
  reader.push("\n");
  assert.deepEqual(lines, [""]);
});

test("oversize frame is reported and the reader stays usable", () => {
  const { reader, lines, oversize } = collector();
  const big = "x".repeat(MAX_FRAME_BYTES + 1);
  reader.push(big + "\n");
  assert.equal(oversize.length, 1);
  // Follow-up normal frame still works.
  reader.push("ok\n");
  assert.deepEqual(lines, ["ok"]);
});