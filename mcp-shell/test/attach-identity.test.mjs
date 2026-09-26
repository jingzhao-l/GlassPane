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
  const initAssigns = [];
  let insideInit = false;
  for (const raw of block[1].split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    // `let` **and** `var`: a `public var` stored property participates in the
    // synthesized `Equatable` exactly like a `let`, so reading only `let` let a
    // field re-declared (or newly added) as `var` drop out of the comparison
    // silently — the identity key could then miss a field the daemon clears
    // history on.
    const stored = /^public\s+(?:let|var)\s+([A-Za-z0-9_]+)\s*:/.exec(line);
    if (stored) {
      fields.push(stored[1]);
      continue;
    }
    if (/^public init\b/.test(line)) insideInit = true;
    if (insideInit) {
      const assigned = /self\.([A-Za-z0-9_]+)\s*=/.exec(line);
      if (assigned) initAssigns.push(assigned[1]);
      if (/^\}/.test(line)) insideInit = false;
    }
  }
  // The expected count is derived from the struct itself, not typed here: its
  // own `init` assigns every stored property, so the assignment list is a
  // second, independent reading of the same set. The old `fields.length >= 2`
  // passed even when the parse had silently dropped a field (3 → 2 still ≥ 2);
  // two readings that disagree cannot. If the struct ever loses its explicit
  // `init`, this goes red and says so instead of quietly watching nothing.
  assert.ok(initAssigns.length >= 2,
    `AttachedApp 的显式 init 只给 ${initAssigns.length} 个属性赋值——期望字段数没有出处了，改用别的推导或改这条闸`);
  assert.deepEqual([...new Set(fields)].sort(), [...new Set(initAssigns)].sort(),
    `AttachedApp 的存储属性（${fields.join(", ")}）与它 init 的赋值（${initAssigns.join(", ")}）对不上——字段读取方式已过期，身份键的对照表不可信`);
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
  //
  // EVERY occurrence is checked, not just the first: `indexOf` read only the
  // site that was there when the file was written, so an *additional*
  // unconditional `history.removeAll()` — the exact shape of the bug this
  // mirror exists to catch — was invisible to it and left the gate green.
  // Mutation that reddens this (and used to): add `history.removeAll()` as the
  // first statement of `attach` — its nearest guard line is no
  // `if attachedApp != app`, so that site fails.
  // Mutation: rename the daemon's condition (`attachedApp?.pid != app.pid`) —
  // every site fails, as it must: the shell's rule is derived from *this* one.
  const source = fs.readFileSync(ENGINE_CORE, "utf8");
  const sites = [...source.matchAll(/history\.removeAll\(\)/g)];
  assert.ok(sites.length >= 1, "EngineCore 里再也找不到 history.removeAll()——镜像的条件消失了");
  for (const site of sites) {
    const line = source.slice(0, site.index).split("\n").length;
    const guard = nearestGuardLine(source.slice(0, site.index));
    assert.ok(guard !== null && /attachedApp\s*!=\s*app/.test(guard),
      `EngineCore.swift:${line} 的 history.removeAll() 不在 \`if attachedApp != app\` 之下` +
      (guard === null ? "（它上面没有直接的守卫——这是一次无条件清空）" : `，最近的守卫是：${guard}`));
  }
});

/**
 * The line that opens the block the clear sits in: walk back over blank and
 * comment lines until a `}` closing a previous block (no guard → `null`) or an
 * `if` (return its condition). Deliberately shallow — the point is not to
 * resolve Swift scoping, it is that a clear added *outside* the guarded block
 * has no `if attachedApp != app` on its way up within a few lines.
 */
function nearestGuardLine(textBefore) {
  const lines = textBefore.split("\n");
  const own = lines[lines.length - 1];
  const candidates = [own, ...lines.slice(0, -1).reverse()];
  for (const raw of candidates) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    const opened = /(?:^|[};]\s*)if\s+(.+?)\s*\{?\s*$/.exec(line);
    if (opened) return opened[1];
    if (line.startsWith("}")) return null;
    if (/[{(]$/.test(line)) return null; // reached an enclosing statement, not a guard
  }
  return null;
}

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
