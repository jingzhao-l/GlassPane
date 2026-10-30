// GlassPane P1-D6 真机冒烟（spec v1.3 §10.4）：真实 daemon 上
// gp_attach -> gp_act -> gp_export_evidence(markdown/html)，断言四段报告可见。
//
// 它走的是**发布物的入口**：`node dist/index.js --socket-path <sock>` 起一个 stdio MCP 服务，
// 本脚本按行喂 JSON-RPC、按行读回来——和任何真代理走的代码路径完全一致。
// 从前这里 `import { createTrackedMcpServer } from "./dist/dispatch.js"`，而
// `npm run bundle` 的那条 `find dist -maxdepth 1 -name '*.js' ! -name 'index.js' … -delete`
// 只留四个入口，dispatch.js / engine-client.js 都被删掉：`npm run bundle` 之后这份冒烟
// 一律 ERR_MODULE_NOT_FOUND，而 `engine/smoke.md` 与 `.github/pull_request_template.md`
// 都还把它当成 D6 那一格让人跑。改成子进程以后，这份脚本对内部模块布局不再敏感，
// 并且量的真是被发布的那份字节。
import process from "node:process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "dist", "index.js");

// The socket the daemon is on: an argument, else the same default the shell itself uses.
const DEFAULT_ROOT = path.join(process.env.HOME ?? "", ".glasspane");
const socketPath = process.argv[2] ?? process.env.GLASSPANE_ENGINE_SOCK ?? path.join(DEFAULT_ROOT, "engine.sock");

const child = spawn(process.execPath, [entry, "--socket-path", socketPath], { stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout });

let nextId = 0;
const waiters = new Map();
lines.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  const settle = waiters.get(msg.id);
  if (settle) {
    waiters.delete(msg.id);
    settle(msg);
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("error", (error) => {
  console.log(`FAIL cannot start the published server: ${String(error)}`);
  process.exit(1);
});

function send(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`no answer to ${method} (id ${id}) within 60s`));
    }, 60_000);
    waiters.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function fail(msg) {
  console.log(`FAIL ${msg}`);
  child.stdin.end();
  child.kill("SIGTERM");
  process.exit(1);
}

async function callTool(name, args, label) {
  const resp = await send("tools/call", { name, arguments: args });
  const text = resp.result?.content?.[0]?.text ?? "";
  if (resp.result?.isError) fail(`${label}: ${text.slice(0, 400)}`);
  console.log(`PASS ${label}`);
  return text;
}

await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "d6-smoke", version: "1" },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const attachText = await callTool("gp_attach", { bundleId: "com.apple.Notes" }, "gp_attach Notes");
if (!attachText.includes("com.apple.Notes")) fail("gp_attach bundleId echo");

const actText = await callTool(
  "gp_act",
  { selector: { role: "AXButton" }, action: "press" },
  "gp_act press role-only AXButton",
);
let operationId;
try {
  operationId = JSON.parse(actText).operationId;
} catch {
  fail(`gp_act text not canonical JSON: ${actText.slice(0, 200)}`);
}
if (!String(operationId).startsWith("op_")) fail(`gp_act operationId prefix: ${String(operationId)}`);
console.log(`operationId=${operationId}`);

const md = await callTool(
  "gp_export_evidence",
  { operationId, format: "markdown" },
  "gp_export_evidence markdown",
);
for (const heading of ["## PATH", "## ANOMALY", "## EVIDENCE", "## NEXT"]) {
  if (!md.includes(heading)) fail(`markdown missing section ${heading}`);
}
if (!md.includes(operationId)) fail("markdown missing operationId");

const html = await callTool(
  "gp_export_evidence",
  { operationId, format: "html" },
  "gp_export_evidence html",
);
for (const heading of ["PATH", "ANOMALY", "EVIDENCE", "NEXT"]) {
  if (!html.includes(`<h2>${heading}</h2>`)) fail(`html missing section ${heading}`);
}
if (html.includes("<script")) fail("html contains raw <script> (injection escape)");

child.stdin.end();
child.kill("SIGTERM");
console.log("D6 SMOKE OK");
