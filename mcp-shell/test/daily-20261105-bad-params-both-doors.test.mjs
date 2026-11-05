/**
 * 每日任务 2026-11-05 · 候选 E：同一道拒绝，两道门不许说两种话。
 *
 * 缺陷。zod 校验失败时 stdio 那道门（`tools.ts` 的 `executeTool`）发的是
 * `check the tool's input schema; <issues>`，而 HTTP 那道门（`http-gateway.ts` 的
 * `spec.validate` 失败支）把 `<issues>` **裸着**当整条 remedy 发出去。zod 的原话是对一次
 * 模式失败的复述（"expected string, received number at …"），不是一条做得动的动作；
 * 本仓对 remedy 的口径是"agent 照着敲就得做得动"，而这一条只在一道门上成立过。
 *
 * 判据三面：
 *   ① 措辞有唯一作者：`badParamsRemedy` 一处定义，两道门都从它取；
 *   ② 行为：stdio 那道门真的把拒绝发出来时，remedy 以那句动作开头、并带着 zod 的原话；
 *   ③ 反向：HTTP 那道门不许再出现"把 `checked.issues` 裸着当 remedy"那一形。
 *
 * REVERSE：把 `http-gateway.ts` 改回 `checked.issues` ⇒ ③ 红；把 `badParamsRemedy` 的句子
 * 改成只复述不给动作 ⇒ ② 红；把 `tools.ts` 也改成裸 issues ⇒ ① 红（两处都不再叫它）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { badParamsRemedy, GP_E_BAD_PARAMS } from "../dist/errors.js";
import { executeTool, TOOL_BY_NAME } from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

test('① 出路的措辞只有一个作者，两道门都从 errors.ts 取', () => {
  const doors = ["tools.ts", "http-gateway.ts"];
  for (const file of doors) {
    const text = fs.readFileSync(path.join(SRC, file), "utf8");
    assert.ok(text.includes("badParamsRemedy(checked.issues)"),
      `${file} 不再从真源取这条出路，两道门又会各写一份：${file}`);
    assert.ok(text.includes("badParamsRemedy") && /from "\.\/errors\.js"/.test(text),
      `${file} 里的 ` + "badParamsRemedy" + ` 必须是从 errors.ts 导入的，不是本地抄的一份`);
  }
  // 定义只许住在 errors.ts：挪进任一道门自己的文件，另一道门就又是手抄。
  const errors = fs.readFileSync(path.join(SRC, "errors.ts"), "utf8");
  assert.equal(errors.split("export function badParamsRemedy").length - 1, 1,
    "badParamsRemedy 的定义出现了不止一处（或没有），这一条闸失去了对照物");
});

test('② stdio 那道门真发拒绝时，remedy 先给动作再附 zod 原话', async () => {
  const spec = TOOL_BY_NAME.get("gp_act");
  assert.ok(spec, "夹具依赖 gp_act 在册；它不在了这条对照就该红而不是空跑");
  const neverCalled = {
    call() {
      throw new Error("参数没过校验，这一趟一次都不该碰引擎");
    },
  };
  const session = new EvidenceAuditSession();
  const result = await executeTool(spec, { selector: null }, neverCalled, session);
  assert.equal(result.isError, true, "坏参数必须是一条拒绝：" + JSON.stringify(result));
  const text = result.content[0].text;
  assert.ok(text.startsWith(`${GP_E_BAD_PARAMS}:`), `错误帧的头部形状变了：${text}`);
  const remedy = text.split(" | remedy: ")[1];
  assert.ok(remedy, `错误帧缺了 remedy 这一格：${text}`);
  assert.ok(remedy.startsWith("check the tool's input schema; "),
    `出路必须先是一条做得动的动作，而不是只复述问题：${remedy}`);
  assert.ok(remedy.length > "check the tool's input schema; ".length,
    `动作后面要带着 zod 的原话，读者才知道改哪一位：${remedy}`);
});

test('③ HTTP 那道门不许把 issues 裸着当 remedy', () => {
  const text = fs.readFileSync(path.join(SRC, "http-gateway.ts"), "utf8");
  // 只看那个失败支：从 `if (!checked.ok)` 到它自己那个右括号为止。
  const start = text.indexOf("if (!checked.ok) {");
  assert.ok(start >= 0, "http-gateway.ts 里的 zod 失败支不见了，这条对照看不到东西");
  const block = text.slice(start, start + 600);
  assert.doesNotMatch(block, /,\s*checked\.issues\)/,
    `又把一段对问题的复述当成出路发出去了：${block.split("\n").slice(0, 8).join(" ")}`);
  assert.match(block, /badParamsRemedy\(checked\.issues\)/,
    `HTTP 这一面不再共用那句话：${block.split("\n").slice(0, 8).join(" ")}`);
});

test('④ 句子本身：动作 + 原话，不多不少', () => {
  assert.equal(badParamsRemedy("expected string, received number"),
    "check the tool's input schema; expected string, received number");
});
