// GlassPane P1-D6 真机冒烟（spec v1.3 §10.4）：真实 daemon 上
// gp_attach -> gp_act -> gp_export_evidence(markdown/html)，断言四段报告可见。
// 经由 dist 里的真实 McpServer + EngineClient 走与 CLI 完全相同的代码路径。
import process from "node:process";
import { defaultSocketPath, unixSocketEngineClient } from "./dist/engine-client.js";
import { createTrackedMcpServer } from "./dist/dispatch.js";

const socketPath = process.argv[2] ?? defaultSocketPath();
const engine = unixSocketEngineClient(socketPath);
const server = createTrackedMcpServer(engine, (note) => process.stderr.write(`${note}\n`)).server;

let nextId = 0;
const req = (method, params) =>
  server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }));

async function callTool(name, args, label) {
  const resp = await req("tools/call", { name, arguments: args });
  const text = resp.result?.content?.[0]?.text ?? "";
  const isError = resp.result?.isError ?? false;
  if (isError) {
    console.log(`FAIL ${label}: ${text.slice(0, 400)}`);
    engine.close();
    process.exit(1);
  }
  console.log(`PASS ${label}`);
  return text;
}

function fail(msg) {
  console.log(`FAIL ${msg}`);
  engine.close();
  process.exit(1);
}

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

engine.close();
console.log("D6 SMOKE OK");