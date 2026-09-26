import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../dist/canonical.js";
import { executeTool, TOOL_BY_NAME } from "../dist/tools.js";
import { makeEngine } from "./helpers.mjs";

/* ------------------------------------------------------------------ *
 * R10-高0 — a member named `__proto__` used to disappear.
 *
 * `sortKeys` built its sorted object as a literal `{}` and then assigned by key,
 * so `sorted["__proto__"] = …` hit the *inherited setter* and reassigned the
 * prototype instead of writing a member. The entry then vanishes from the
 * canonical form, and this function serialises (a) every outbound stdio frame
 * (`src/index.ts`) and (b) the daemon replies the agent is shown verbatim
 * (`tools.ts`'s forwarded results). So a key the daemon really sent reads to the
 * agent as "no such field", while the daemon's own writer
 * (`engine/Sources/GlassPaneEngine/CanonicalJSON.swift`) emits it as an ordinary
 * dictionary member — two surfaces, two answers for one pack, which is the exact
 * divergence the canonical writer exists to prevent.
 *
 * Reverse mutations, named so the next reader can check the gate rather than the
 * prose: revert `Object.create(null)` to `{}` → tests 1 and 3 redden; special-case
 * `__proto__` by *deleting* it instead of keeping it → tests 1, 2 and 3 redden.
 * ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_CANONICAL = path.resolve(HERE, "../../engine/Sources/GlassPaneEngine/CanonicalJSON.swift");

test("a member named __proto__ survives canonicalisation, at top level and nested", () => {
  const wire = String.raw`{"__proto__":{"a":1},"x":1}`;
  const parsed = JSON.parse(wire);
  const out = canonicalJson(parsed);
  assert.ok(out.includes(`"__proto__"`), `成员被吞掉了：${out}`);
  assert.equal(out, String.raw`{"__proto__":{"a":1},"x":1}`);

  const nested = canonicalJson(JSON.parse(String.raw`{"tree":{"__proto__":"leaf"},"k":[1,{"__proto__":2}]}`));
  assert.equal(nested, String.raw`{"k":[1,{"__proto__":2}],"tree":{"__proto__":"leaf"}}`,
    "数组元素与嵌套对象里的同名成员也得留下");

  // And the canonical form must not become a prototype-poisoned object on the way
  // out either: the returned string is what crosses the wire, so check the value
  // round-trips to an object that still carries the member as its OWN property.
  const back = JSON.parse(out);
  assert.equal(Object.prototype.hasOwnProperty.call(back, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(back), Object.prototype, "序列化不得改动任何对象的原型");
});

test("everything else about the canonical form is byte-identical", () => {
  // The fix must not have changed the bytes for any input that was already safe:
  // key order sorted, no insignificant whitespace, nesting preserved.
  const samples = [
    { b: 1, a: 2 },
    { z: { y: [3, { b: 2, a: 1 }], x: null }, a: true },
    { nested: { deeper: { leaf: "value" } }, list: [1, "2", { k: "v" }] },
    { "needs/escape": "line\nbreak", "quote\"key": 1 },
    {},
    [],
  ];
  const sortedStringify = (value) => JSON.stringify(sortPlain(value));
  for (const sample of samples) {
    assert.equal(canonicalJson(sample), sortedStringify(sample),
      `与"只按键排序"的等价实现不再逐字一致：${JSON.stringify(sample)}`);
  }
});

test("the forwarded daemon reply keeps the member the agent is shown", async () => {
  // The product path, not the helper: a forwarded tool answers with the daemon's
  // frame body rendered by `canonicalJson`, and that text is what the agent reads
  // as the UI tree. `gp_observe` is the plainest forward (no `execute`, no pack
  // parsing), so a dropped key here is a field the agent is told the app does not
  // have — not a formatting detail.
  const { engine, io } = makeEngine();
  const spec = TOOL_BY_NAME.get("gp_observe");
  const promise = executeTool(spec, { maxDepth: 3 }, engine);
  io.lastFrame();
  const reply = JSON.parse(String.raw`{"tree":{"role":"AXWindow","__proto__":"attr-name"},"count":1}`);
  io.respond(reply);
  const outcome = await promise;
  assert.equal(outcome.isError, false, JSON.stringify(outcome.content));
  assert.ok(outcome.content[0].text.includes(`"__proto__"`),
    `代理看到的正文里少了这个成员：${outcome.content[0].text}`);
  assert.equal(outcome.content[0].text, canonicalJson(reply));
});

test("the daemon's canonical writer treats the key as an ordinary member — the side this must match", () => {
  // Not a copy of the rule: this reads the Swift writer and asserts it has no
  // special case for `__proto__`. If that ever gains one, the two surfaces
  // disagree again and this reds with the reason, rather than the shell quietly
  // returning to dropping the member to "match".
  const swift = fs.readFileSync(SWIFT_CANONICAL, "utf8");
  assert.ok(swift.includes("if let object = value as? [String: Any]"),
    `CanonicalJSON.swift 的对象分支换了写法，这条对照要先改自己：${SWIFT_CANONICAL}`);
  assert.equal(swift.includes("__proto__"), false,
    "Swift 侧开始点名 __proto__＝两侧又开始各说各话，这里必须先于壳层的改动被重新讨论");
  const objectBranch = swift.slice(swift.indexOf("if let object = value as? [String: Any]"));
  const keysLine = objectBranch.split("\n").find((line) => line.includes(".keys.sorted()"));
  assert.ok(keysLine, "对象分支里找不到按键排序那一行——排序口径的出处变了");
});

/** Plain recursive key sort, used only as the byte-equivalence oracle above. */
function sortPlain(value) {
  if (Array.isArray(value)) {
    return value.map(sortPlain);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortPlain(value[key]);
    }
    return out;
  }
  return value;
}
