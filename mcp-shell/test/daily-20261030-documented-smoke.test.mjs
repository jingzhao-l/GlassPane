/**
 * A documented verification step must point at bytes that exist.
 *
 * `mcp-shell/.d6_smoke.mjs` used to `import` two modules under `dist/` (`engine-client.js`,
 * `dispatch.js`) that `npm run bundle` deletes — its `find dist -maxdepth 1 -name '*.js'
 * ! -name 'index.js' … -delete` keeps four entrypoints and nothing else. So after the very step
 * `.github/pull_request_template.md` tells a contributor to run, the D6 real-machine smoke died with
 * `ERR_MODULE_NOT_FOUND` (measured before the fix: `import('./mcp-shell/dist/dispatch.js')` fails),
 * while `engine/smoke.md` still listed it as the D6 gate. Nothing referenced the script from a test,
 * so the dead step survived several rounds.
 *
 * This control is the missing class: for every local path a documented step reads, prove the path
 * exists **in the shipped shape** (after `npm run bundle`). It does not run the smoke — that needs a
 * real daemon, Notes, and granted TCC seats — it refuses the failure mode that hid the gap: a
 * documented step whose target nobody can reach.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, "..");
const REPO = path.resolve(SHELL, "..");

/**
 * Resolve every local path the smoke loads, whether by `import` or by spawning an entry.
 *
 * Comments are stripped first: this very file documents the old broken shape (`from
 * "./dist/dispatch.js"`) in prose, and harvesting from comments made the control accuse the fix of
 * still referencing the deleted module — a control that fires on its own documentation is not a
 * control.
 */
function referencedLocalPaths(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out = [];
  for (const m of code.matchAll(/from\s+"(\.\/[^"]+)"/g)) out.push(m[1]);
  for (const m of code.matchAll(/path\.join\(here,\s*"([^"]+)"(?:,\s*"([^"]+)")?\)/g)) {
    out.push(path.join(m[1], m[2] ?? ""));
  }
  return out;
}

test("the D6 smoke script loads only paths that survive `npm run bundle`", () => {
  const smoke = fs.readFileSync(path.join(SHELL, ".d6_smoke.mjs"), "utf8");
  const referenced = referencedLocalPaths(smoke);
  assert.ok(referenced.length >= 1,
    "这条对照没有在这个脚本里找到任何本地路径引用——它被改写成别的形式了，重读这条判据，别删它");
  // 判据要量的是**发布形状**，而 `npm test` 只跑 `tsc`：那时 `dist/` 里每个模块都在，
  // "引用的路径存在"会空过成绿（这条闸第一版就是这么写的）。所以先由 bundle 脚本自己
  // 交出它保留哪四个入口——从 `package.json` 里读，不抄第二份名单——再要求这个冒烟脚本
  // 引用的每一个 `dist/` 路径都在那四个之内。这一步与跑没跑过 bundle 无关，因此它现在
  // 就能红：把 `.d6_smoke.mjs` 里那一行改回 `path.join(here, "dist", "dispatch.js")`，
  // 这条具名用例立刻点名它，而不必等到真机上那一步死掉。
  const pkg = JSON.parse(fs.readFileSync(path.join(SHELL, "package.json"), "utf8"));
  const kept = [...pkg.scripts.bundle.matchAll(/! -name '([^']+)'/g)].map((m) => m[1]);
  assert.ok(kept.length >= 2,
    `bundle 脚本不再用 ! -name 逐个保留入口（读到 ${kept.length} 个）——这一族失效模式换了形状，重读上面那条判据`);
  const distRefs = referenced.filter((rel) => rel.split(path.sep)[0] === "dist");
  assert.ok(distRefs.length >= 1,
    `冒烟脚本现在一个 dist 引用都不剩，这条判据看不见东西了：${JSON.stringify(referenced)}`);
  for (const rel of distRefs) {
    const leaf = rel.split(path.sep).pop();
    assert.ok(kept.includes(leaf),
      `.d6_smoke.mjs 引用 ${rel}，而 bundle 只保留 ${JSON.stringify(kept)}——文档里那一步是死的`);
  }
  const dist = fs.existsSync(path.join(SHELL, "dist")) ? fs.readdirSync(path.join(SHELL, "dist")) : [];
  if (dist.includes("index.js")) {
    for (const rel of referenced) {
      assert.ok(fs.existsSync(path.resolve(SHELL, rel)),
        `.d6_smoke.mjs 引用 ${rel}，而它在当前树上不存在：${rel}`);
    }
  }
  // The entry it spawns must be one of the four published entrypoints, not an internal module:
  // that is precisely the shape that broke.
  assert.match(smoke, /"dist", "index\.js"/,
    "真机冒烟应当驱动发布物入口（dist/index.js），而不是库内部模块");
});

test("the docs that name this step still name it, and nothing else points at a deleted module", () => {
  const smokeMention = (file) => {
    const text = fs.readFileSync(path.join(REPO, file), "utf8");
    return { text, hits: (text.match(/\.d6_smoke\.mjs/g) ?? []).length };
  };
  const sources = ["engine/smoke.md", ".github/pull_request_template.md"];
  let named = 0;
  for (const file of sources) {
    const { hits } = smokeMention(file);
    if (hits > 0) named += 1;
  }
  assert.ok(named >= 1,
    "没有任何文档再提 `.d6_smoke.mjs`：这条真机步骤已经从验收面消失了（曾列在 engine/smoke.md 与 PR 模板）");
  // And the bundle manifest is the reason it must stay entrypoint-only: assert the deletion rule
  // is still the shipped shape, so this control cannot quietly become vacuous.
  const pkg = JSON.parse(fs.readFileSync(path.join(SHELL, "package.json"), "utf8"));
  assert.match(pkg.scripts.bundle, /-delete/,
    "bundle 不再删非入口 .js 了？那这一族失效模式换了形状，重读上面那条判据");
});
