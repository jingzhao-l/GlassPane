/**
 * 调用方交给壳的那些参数，壳必须照实回应——两个入口各一条。
 *
 * 都是本轮在**发布产物**上实测的形状：
 *  1. `tools/call` 不带 `arguments` 是合法 MCP（`gp_observe`、`gp_probe_status` 这些
 *     无入参工具就是这么发的），`dispatch.ts` 却把 `undefined` 直接喂进 `z.strictObject`
 *     校验，回 `GP_E_BAD_PARAMS … : Required`——remedy 指着一个发布 schema
 *     （`properties: {}`，没有 `required`）里并不存在的东西，空路径还渲染成一句多余的
 *     `": Required"`。而 `{"arguments":{}}` 那个孪生写法是能过的：同一句话两种结果，
 *     读者只会以为是 daemon 的问题。
 *     REVERSE：`params.arguments` 去掉 `?? {}` → 本文件第一条红。
 *  2. 网关入口的解析循环没有 `index.ts` 那条 `else { throw }`：`--socket-pth /tmp/x`、
 *     `--prot 8788` 与裸位置参数被**静默丢掉**，网关照旧桥接到它自己猜出来的默认 socket，
 *     而操作者以为点名了另一个 daemon。连错 daemon 意味着 act 落在别的 app、别人的屏幕上。
 *     `shell-cli.test.mjs` 此前只把这条规矩钉在 `dist/index.js` 一侧。
 *     REVERSE：删掉那条 `else { throw }` → 本文件后两条红。
 */
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { McpServer } from "../dist/dispatch.js";
import { EvidenceAuditSession } from "../dist/audit-session.js";
import { makeEngine } from "./helpers.mjs";

const GATEWAY_CLI = fileURLToPath(new URL("../dist/http-gateway-cli.js", import.meta.url));

test("a tools/call that omits arguments is still a valid call", async () => {
  const { engine, io } = makeEngine({ timeoutMs: 500 });
  const server = new McpServer({ engine, session: new EvidenceAuditSession() });
  const promise = server.handleLine(JSON.stringify({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "gp_probe_status" },
  }));
  const written = io.lastFrame();
  assert.equal(written.method, "probe_status");
  // 真 daemon 的 probe_status 回帧形状（`FrameCodec` 那一侧的键名，不是编出来的）。
  io.respond({ probes: [], attachedHasProbe: false, disconnections: 0, recentDisconnections: [] });
  const response = await promise;
  assert.equal(response.result.isError, false,
    `不带 arguments 的调用被拒了：${response.result.content[0].text}`);
  assert.equal(JSON.parse(response.result.content[0].text).attachedHasProbe, false);
});

test("the gateway CLI refuses an argument it does not recognize", () => {
  const typo = spawnSync(process.execPath, [GATEWAY_CLI, "--socket-pth", "/tmp/whatever.sock"], {
    encoding: "utf8", timeout: 15000,
  });
  assert.notEqual(typo.status, 0,
    "拼错的开关被静默接受了，网关照样连到它猜出来的那个 socket");
  assert.match(typo.stderr, /unknown argument: --socket-pth/, typo.stderr);

  const stray = spawnSync(process.execPath, [GATEWAY_CLI, "8788"], {
    encoding: "utf8", timeout: 15000,
  });
  assert.notEqual(stray.status, 0, "裸的位置参数多半是一个打错的开关，不许当空气");
  assert.match(stray.stderr, /unknown argument: 8788/, stray.stderr);

  const help = spawnSync(process.execPath, [GATEWAY_CLI, "--help"], {
    encoding: "utf8", timeout: 15000,
  });
  assert.equal(help.status, 0, "--help 仍要走得通：" + help.stderr);
});

test("认得出的参数照样有效——拒绝不许把正路一起堵死", () => {
  // 对照必须能过：一条只会拒的闸和一条坏闸同样没用。
  const ok = spawnSync(process.execPath,
    [GATEWAY_CLI, "--socket-path", "/tmp/gp-caller-args-never-opens.sock", "--port", "0", "--help"], {
      encoding: "utf8", timeout: 15000,
    });
  assert.equal(ok.status, 0, ok.stderr);
});
