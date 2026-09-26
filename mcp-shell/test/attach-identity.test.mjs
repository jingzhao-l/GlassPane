import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attachIdentityOf } from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";

/**
 * Whether the shell restarts its evidence trail is decided by the *daemon's*
 * condition — `EngineCore.attach` clears `history` under
 * `if attachedApp != app`, i.e. by `AttachedApp: Equatable` over the fields of
 * that struct. So `attachIdentityOf` must cover every stored property of the
 * Swift struct, and a key that quietly drops one would keep the previous app's
 * operations in the next app's trail. The field list is read out of Swift rather
 * than restated here, because a restated list is exactly the copy that goes
 * stale (R8b-高1).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_CHANNEL = path.resolve(HERE, "..", "..", "engine", "Sources", "GlassPaneEngine", "RuntimeChannel.swift");
const ENGINE_CORE = path.resolve(HERE, "..", "..", "engine", "Sources", "GlassPaneEngine", "EngineCore.swift");

function attachedAppFields() {
  const source = fs.readFileSync(RUNTIME_CHANNEL, "utf8");
  const block = /public struct AttachedApp: Equatable \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, "找不到 AttachedApp 声明——身份键的对照物没了，这条闸必须红而不是跳过");
  const fields = [];
  for (const raw of block[1].split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const stored = /^public let ([A-Za-z0-9_]+)\s*:/.exec(line);
    if (stored) {
      fields.push(stored[1]);
    }
  }
  assert.ok(fields.length >= 2, `AttachedApp 只解析出 ${fields.length} 个存储属性，解析方式已经失效`);
  return fields;
}

test("the attach identity key covers every field of the daemon's AttachedApp", () => {
  const fields = attachedAppFields();
  const source = executable(fs.readFileSync(path.resolve(HERE, "..", "src", "tools.ts"), "utf8"));
  const start = source.indexOf("export function attachIdentityOf");
  assert.notEqual(start, -1, "attachIdentityOf 不在了——身份键换了地方，这条闸要看住它");
  // The function's own closing brace at column 0 — `indexOf("}")` would stop at
  // the first `if {` block and the assertions below would then be looking at a
  // fragment that happens not to mention `bundleId`.
  const bodyEnd = source.indexOf("\n}", start);
  assert.notEqual(bodyEnd, -1, "attachIdentityOf 没有正常收尾");
  const body = source.slice(start, bodyEnd);
  const missing = fields.filter((field) => !body.includes(field));
  assert.deepEqual(missing, [],
    `daemon 比较这些字段决定要不要清历史，而身份键没覆盖它们：${missing.join(", ")}（fields=${fields.join(", ")}）`);
  // And the key must be built from all of them together, not from one.
  // A template literal whose first interpolation is one of those fields: joining
  // them is the point, so a body that compares one field and returns a constant
  // would satisfy `missing` above and still collapse two apps into one identity.
  assert.match(body.replace(/\s+/g, " "), /return\s*`\$\{/,
    "身份键必须由模板把各字段拼起来，而不是只读出其中一个");
});

/** Comments out; the same convention as `test/support/source.mjs`. */
function executable(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("the daemon still clears history only when the attached app changed", () => {
  // `restart()` mirrors this condition, so if the daemon ever changes it (e.g.
  // clears on every attach), the shell's more-lenient rule becomes a leak and
  // this has to be the thing that says so.
  const source = fs.readFileSync(ENGINE_CORE, "utf8");
  const at = source.indexOf("history.removeAll()");
  assert.notEqual(at, -1, "EngineCore 里再也找不到 history.removeAll()——镜像的条件消失了");
  const guard = source.slice(Math.max(0, at - 400), at);
  assert.match(guard.replace(/\s+/g, " "), /if attachedApp != app/,
    "daemon 不再按 app 变化清历史，shell 侧的同源规则要重判");
});

test("an identity is only the same identity when all three fields match", () => {
  const base = { pid: 4242, bundleId: "com.example.app", appName: "Example" };
  assert.equal(attachIdentityOf(base), attachIdentityOf({ ...base }));
  assert.notEqual(attachIdentityOf(base), attachIdentityOf({ ...base, pid: 4243 }),
    "pid 变了就是另一个进程：daemon 会清历史");
  assert.notEqual(attachIdentityOf(base), attachIdentityOf({ ...base, appName: "Other" }));
  assert.notEqual(attachIdentityOf(base), attachIdentityOf({ ...base, bundleId: "com.other.app" }));
  // A missing bundle id is a value, not an absence of comparison.
  assert.equal(attachIdentityOf({ pid: 1, appName: "A" }), attachIdentityOf({ pid: 1, appName: "A" }));
  assert.notEqual(attachIdentityOf({ pid: 1, appName: "A" }), attachIdentityOf({ pid: 1, bundleId: "x", appName: "A" }));
  // Unidentifiable replies are reported as such rather than guessed.
  assert.equal(attachIdentityOf({ bundleId: "com.example.app", appName: "Example" }), null);
  assert.equal(attachIdentityOf(null), null);
  assert.equal(attachIdentityOf("nonsense"), null);
});

test("restart() keeps the trail across an idempotent re-attach and bumps the generation on a change", () => {
  const session = new EvidenceAuditSession();
  const first = session.restart("4242|com.example.app|Example");
  assert.equal(first, true, "第一次 attach 之前没有身份，必须算作变化");
  session.record({ operationId: "op_kept" });
  assert.equal(session.restart("4242|com.example.app|Example"), false,
    "同一个 app 的幂等 re-attach 不得清空链条——那会把刚记下的操作又变成\\\"没做过\\\"");
  assert.deepEqual(session.recentIds(20), ["op_kept"]);
  const generation = session.generation;
  assert.equal(session.restart("9999|com.other.app|Other"), true);
  assert.deepEqual(session.recentIds(20), [], "换了 app 必须重新开始");
  assert.ok(session.generation > generation, "纪元必须前进，迟到回复才有可比的依据");
  assert.equal(session.restart(null), true, "认不出身份＝按变化处理，不能拿旧链冒充新 app");
});
