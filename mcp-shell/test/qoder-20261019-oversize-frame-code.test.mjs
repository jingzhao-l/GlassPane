import assert from "node:assert/strict";
import test from "node:test";

import { tooLargeResponse } from "../dist/stdio-session.js";
import { INVALID_REQUEST, PARSE_ERROR, METHOD_NOT_FOUND, INVALID_PARAMS } from "../dist/dispatch.js";
import { GP_E_PAYLOAD_TOO_LARGE } from "../dist/errors.js";
import { MAX_FRAME_BYTES } from "../dist/io.js";

/**
 * One inbound stdio frame, one fact about it: it is bigger than the frame cap, so it
 * never became a JSON-RPC request that this shell could validate.
 *
 * The answer used to carry that fact twice and disagree with itself — the numeric
 * JSON-RPC code was `INVALID_REQUEST` while the message opened by *declaring a different
 * condition*, `GP_E_PAYLOAD_TOO_LARGE:`, as though the two names were two judgements.
 * They are one judgement at two layers (`errors.ts` shares the string with the daemon's
 * `GPErrorCode.payloadTooLarge`, and `Dispatcher.swift`'s `.oversize` case answers it the
 * same way at its own end of the socket), and the answer has to say so: the code stays
 * the JSON-RPC class the shell can honestly claim, and the message leads with that same
 * class and names the shared code as *this shell's label for the very same frame*.
 *
 * No new protocol is invented here: JSON-RPC's numeric space carries no payload-too-large
 * condition, and `test/published-artifact.test.mjs` pins both halves of what an installed
 * bundle must still answer (`-32600`, and a message an agent can grep for
 * `GP_E_PAYLOAD_TOO_LARGE`), so the shape is fixed and the *wording* is what moves.
 */

/** The class names JSON-RPC owns, and the one condition the frame actually is. */
const CODE_CLASSES = new Map([
  [PARSE_ERROR, "parse"],
  [INVALID_REQUEST, "invalid request"],
  [METHOD_NOT_FOUND, "method not found"],
  [INVALID_PARAMS, "invalid params"],
]);

test("an oversized inbound frame: the numeric code and the message name the same fact", () => {
  const answer = tooLargeResponse(7);
  assert.equal(answer.jsonrpc, "2.0");
  assert.equal(answer.id, 7, "the caller whose frame was dropped must not be left waiting");
  assert.equal(answer.error.code, INVALID_REQUEST,
    `一条没能成为请求的帧答的是 ${answer.error.code}：JSON-RPC 的数字空间里没有 payload-too-large 这一档，`
      + "而 -32600 正是'这不是一个合法的 Request'");
  assert.equal(CODE_CLASSES.has(answer.error.code), true,
    "只准用 JSON-RPC 保留的标准码，不许自造一个数字码");

  // The message leads with the class its own code states, and carries the cap value that
  // makes the claim checkable. Both are in the first clause: an agent greps the head.
  assert.match(answer.error.message, /^Invalid Request\b/, answer.error.message);
  assert.match(answer.error.message, new RegExp(`the ${MAX_FRAME_BYTES}-byte frame cap`), answer.error.message);

  // …and the shared condition name is still there, marked as *this shell's code for that
  // same frame*, not as a second verdict competing with the numeric one.
  assert.match(answer.error.message, new RegExp(GP_E_PAYLOAD_TOO_LARGE), answer.error.message);
  assert.match(answer.error.message, /the code this shell \(and the daemon\) (use|name) for that same frame/
    , answer.error.message);
});

test("the oversized-frame answer does not declare a condition its numeric code contradicts", () => {
  const message = tooLargeResponse(null).error.message;
  // The old shape — a bare `<GP_E_*>::` prefix, i.e. the message naming the condition
  // while the code names another one — is the mutation this half reddens.
  assert.doesNotMatch(message, new RegExp(`^${GP_E_PAYLOAD_TOO_LARGE}:`), message);
  assert.doesNotMatch(message, /^GP_E_[A-Z_]+:/, "任何 GP_E_* 码都不许以'判定头'的形式出现在 -32600 的 message 前缀里");
  // A frame this shell could not frame says nothing about the request inside it.
  assert.doesNotMatch(message, /malformed|not a valid JSON|corrupt/i,
    `这条答复没有解析过那帧字节，就不能说它格式错误：${message}`);
  // One remedy, executable, and it does not order a re-send of the same oversized bytes.
  assert.match(message, /\| remedy: shrink this request/, message);
});
