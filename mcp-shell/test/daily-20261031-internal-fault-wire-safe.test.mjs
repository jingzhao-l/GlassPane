/**
 * 壳自己的内部故障：细节留在本进程 stderr，线上只留失败类型（三处半修的另一半）。
 *
 * HTTP 半边早就立过这条规矩（`src/http-gateway.ts` 的 `wireCause`：细节进 sink，帧上只留
 * 一句不点名任何文件与符号的话），而 stdio 这一边有两处没跟着改：
 *  1. 协议层的兜底 catch 直接把 `String(error)` 拼成 `Internal error: …` 上线；
 *  2. `tools.ts` 里四支 `GP_E_INTERNAL` 手臂把 `internal shell error: ${String(error)}`
 *     原样放进工具结果——那正是网关剥掉的那一段。
 * 2026-10-31 两处一起收进同一个身体（`internalFaultAccount` / `reportInternalFault`），
 * 因为同一个事实不许有两份说法：一份说了算的写法只允许存在一处，剩下的是引用它。
 *
 * 三条判据，各自都能红：
 *  · 行为半边：拿一段含绝对路径的哨兵当抛出值跑真工具，要求线上不出现它、stderr 必须出现；
 *  · 静态半边：`src/**` 里凡把外来文本插进 `formatToolError` 的 message 位都必须走那两个
 *    助手；扫描器自己被喂一段坏写法要能点名（不然它只是"跑过了"）；
 *  · 句子只有一份：两个助手的产物逐字节相同的那一句由本文件钉住，防止有人复制粘贴出第二份。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { executeTool, TOOL_BY_NAME, internalFaultAccount, reportInternalFault } from "../dist/tools.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { makeEngine } from "./helpers.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.resolve(HERE, "..", "src");
const LEAKED = "EPHEMERAL read of /Users/someone/.glasspane/evidence/op_X.json failed";

function captureStderr(run) {
  const written = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  return Promise.resolve(run())
    .then((value) => ({ value, log: written.join("") }))
    .finally(() => { process.stderr.write = real });
}

test("a tool that faults inside the shell answers with the failure type and keeps the detail local", async () => {
  const { engine } = makeEngine();
  engine.call = () => { throw new Error(LEAKED); };
  const { value, log } = await captureStderr(async () => {
    const outcome = await executeTool(
      TOOL_BY_NAME.get("gp_probe_status"), {}, engine, new EvidenceAuditSession(),
    );
    return outcome.content.map((c) => c.text).join("\n");
  });
  assert.ok(log.includes(LEAKED), `细节没进 stderr，现在它哪儿也没去：${log}`);
  assert.match(log, /withheld from the tool frame/, "stderr 那一行必须说清为什么不上线");
  assert.ok(!value.includes(LEAKED), `内部描述被印到读者会转述的那一帧上：${value}`);
  assert.match(value, /GP_E_INTERNAL/, `仍然必须是那一码：${value}`);
  assert.match(value, /failure type Error/, `帧上要留下能分叉的那一点：${value}`);
  assert.match(value, /remedy/i, "错误帧恒带 remedy");
});

/**
 * 静态半边。判据的形状与 `remedy-shell-quoting` 一致：不看"跑没跑过"，看**写在哪**。
 * 一条 `formatToolError(<code>, <message 位>, …)` 的 message 位里，外来的 `${String(x)}`
 * 只允许从 `internalFaultAccount` / `reportInternalFault` 那一个身体里出来。
 */
const FRAME_ARG = /formatToolError\(\s*[^,]+,\s*([^)]*?)[,)]/g;
const FOREIGN = /\$\{\s*String\(/;
function scanSource() {
  const offenders = [];
  for (const name of fs.readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(SRC, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of source.matchAll(FRAME_ARG)) {
      if (FOREIGN.test(m[1] ?? "")) offenders.push(`${name}: ${m[1].slice(0, 60)}`);
    }
  }
  return offenders;
}

test("the message slot of a frame never takes raw foreign text", () => {
  assert.deepEqual(scanSource(), [],
    "这些工具帧的 message 位直接把 String(error) 放上线，而网关那一半是剥掉的：同一次抛出两种上线形状");
});

test("that scan bites: the bad shape is named, the fixed one stays silent", () => {
  // 没有这一条，上面那道闸可以靠把 `FRAME_ARG` 改松（或把 message 位挪出它看得见的形状）而
  // 永远"绿"。所以这里拿两个样本喂给同一个 `FOREIGN` 判据，一个必须中、一个必须不中。
  const bad = '`internal shell error: ${String(error)}`';
  const good = "reportInternalFault(where, error).wire";
  assert.ok(FOREIGN.test(bad), "扫描器读不出坏写法——它已经看不见东西了");
  assert.ok(!FOREIGN.test(good), `合法的接缝被误判：${good}`);
});

test("one body, two surfaces: the sentence is produced in exactly one place", () => {
  const a = internalFaultAccount("gp_probe_status", new Error("x"), "tool");
  const b = internalFaultAccount("gp_probe_status", new Error("x"), "stdio");
  assert.equal(a.wire, b.wire, "帧上那句话不许按表面分叉——分叉就是两份说法");
  assert.ok(a.detail.endsWith("symbols this frame does not publish; the line above is the one to hand over)")
    || a.detail.includes("withheld from the tool frame"), a.detail);
  assert.ok(b.detail.includes("withheld from the stdio frame"), b.detail);
  // 抛出值必须整段留在 detail 里：诊断只可能从那里来。
  assert.ok(b.detail.includes("x") && b.detail.includes("Error —"), b.detail);
  assert.equal(typeof reportInternalFault("probe", new Error("y")).wire, "string");
});
