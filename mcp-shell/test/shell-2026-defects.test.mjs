/**
 * Review 2026 defects in the TypeScript MCP shell, one gate per finding.
 *
 * Each gate is written against the behaviour the product promises, and each names
 * the mutation it reddens, so a revert cannot slip past as a silent no-op:
 *   - D1  capability reconciliation (tools.ts DAEMON_FORWARDED_METHODS)
 *   - D3  every error frame leaving the shell carries `{code, message, remedy}`
 *   - D4  the advertised JSON Schema is never looser than the runtime validator
 *   - D5  a signal cannot end stdout ahead of a reply the queue already took
 *   - D6  a dropped reply is visible in-band and named by request id
 *   - D7  the shell's protocol version equals the daemon's, no silent one-sided bump
 * (D2, the recent_reports failure line, is covered in `review-2026-10-09.test.mjs`.)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Writable } from "node:stream";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DAEMON_FORWARDED_METHODS,
  TOOL_BY_NAME,
  TOOL_SPECS,
  describeFetchFailure,
} from "../dist/tools.js";
import { createTrackedMcpServer } from "../dist/dispatch.js";
import { ENGINE_PROTOCOL_VERSION } from "../dist/engine-client.js";
import { DrainAwareWriter, OrderedReplyQueue, STDIO_WRITE_BACKLOG_BYTES } from "../dist/io.js";
import { canonicalJson } from "../dist/canonical.js";
import { FakeLineIo } from "./helpers.mjs";
import { engineClientOver } from "../dist/engine-client.js";
import { shellWireSurface } from "./support/wire-surface.mjs";
import { executableSource } from "./support/source.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "src");
const FRAME_CODEC = path.resolve(HERE, "..", "..", "engine", "Sources", "GlassPaneEngine", "FrameCodec.swift");
const ENGINE_CORE = path.resolve(HERE, "..", "..", "engine", "Sources", "GlassPaneEngine", "EngineCore.swift");

/* ------------------------------------------------------------------ *
 * D1 — `gp_capture_view` forwards `capture_view`, so the method belongs in
 * the set reconciled against the daemon's advertised capabilities. Missing it
 * makes every live connection print "the daemon offers capture_view which this
 * shell does not expose" — a standing false statement about the tool surface.
 * ------------------------------------------------------------------ */

/** The daemon's advertised capability wire names: every EngineMethod but the two pure-transport ones. */
function swiftCapabilityWireNames() {
  const source = fs.readFileSync(FRAME_CODEC, "utf8");
  const block = /public enum EngineMethod: String, CaseIterable \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, "找不到 EngineMethod 声明——capability 清单的源头没了，这条闸要红而不是跳过");
  const names = new Set();
  for (const rawLine of block[1].split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line.startsWith("case ")) {
      continue;
    }
    // A Swift line can mix shapes (`case diagnose, lastEvidence = "last_evidence"`),
    // so every identifier is read and the one carrying a literal contributes that literal.
    for (const part of line.slice("case ".length).split(",")) {
      const trimmed = part.trim();
      if (trimmed === "") continue;
      const withValue = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]+)"$/.exec(trimmed);
      names.add(withValue ? withValue[2] : trimmed);
    }
  }
  // `capabilityMethods` = allCases minus the handshake (`hello`) and the ops verb (`shutdown`).
  const advertised = [...names].filter((n) => n !== "hello" && n !== "shutdown");
  assert.ok(advertised.length >= 10, `只解析出 ${advertised.length} 个对外能力名，读取方式已经对不上写法`);
  return advertised;
}

test("D1: every daemon capability is a method this shell forwards, and capture_view is not the gap", () => {
  const advertised = swiftCapabilityWireNames();
  const forwarded = new Set(DAEMON_FORWARDED_METHODS);
  const unreachable = advertised.filter((method) => !forwarded.has(method));
  assert.deepEqual(unreachable, [],
    `daemon 广告了这些方法而壳的对账集合里没有，每次真连都会 stderr 说"agent 从 MCP 够不到它"——假话：${unreachable.join(", ")}`);
  // Reverse direction: a shell pseudo-method (recent_reports, project_*) must not leak in and
  // invert the message into "this shell forwards X but the daemon does not list it."
  const advertisedSet = new Set(advertised);
  const phantom = [...forwarded].filter((method) => !advertisedSet.has(method));
  assert.deepEqual(phantom, [],
    `对账集合里出现了 daemon 能力表没有的方法，会被判成"发出去 methodNotFound"：${phantom.join(", ")}`);
});

test("D1: a method that reaches the wire only through a literal .call(\"…\") is still in the forwarded set", () => {
  // The derivation used `execute === undefined` alone, which drops exactly the
  // executor-forwarded methods — today `capture_view`. This reads the same
  // literal-scan the transport gates trust and refuses to let a `.call("name")`
  // site the spec loop cannot produce fall out of the reconciliation set.
  const surface = shellWireSurface(TOOL_SPECS, SRC);
  assert.ok(surface.literalOnly.length >= 1,
    "字面量 .call(\"<name>\") 扫描再也找不到 spec 环路给不出的方法——这条对照已经空转");
  const forwarded = new Set(DAEMON_FORWARDED_METHODS);
  const dropped = surface.literalOnly.filter((method) => !forwarded.has(method));
  assert.deepEqual(dropped, [],
    `这些方法只在 executor 里以 .call("name") 上到线上，却没进对账集合（derive 漏了 reachesDaemon）：${dropped.join(", ")}`);
});

/* ------------------------------------------------------------------ *
 * D3 — two-field errors. Every frame leaving the shell carries a remedy an
 * agent can run. The fallback arms of the recent_reports failure renderer used
 * to print `GP_E_INTERNAL: <text>` with no `| remedy:`.
 * ------------------------------------------------------------------ */

test("D3: a non-daemon fetch failure still leaves the shell as a three-field error", () => {
  // Reverts red if the fallback returns `${GP_E_INTERNAL}: ${String(error)}`.
  const line = describeFetchFailure(new Error("socket hiccup"));
  assert.match(line, /^GP_E_INTERNAL: .* \| remedy: \S/, `回退臂又只有两个字段：${line}`);
  assert.ok(line.length > "GP_E_INTERNAL: socket hiccup | remedy: ".length + 20,
    "出路是一句能执行的下一步，不是空占位");
});

test("D3: no error string in tools.ts is built as a two-field template", () => {
  // Shape gate so the other fallback (`the evidence read failed`, unreachable in
  // the normal render path but still a frame if it ever is one) cannot regress to
  // a bare `CODE: text` without a behavioral test noticing.
  const source = executableSource(fs.readFileSync(path.resolve(SRC, "tools.ts"), "utf8"));
  const offenders = [...source.matchAll(/\$\{GP_[A-Z_]+\}:\s/g)].map((m) => m[0]);
  assert.deepEqual(offenders, [],
    `这些两字段错误串没带 remedy（要用 formatToolError）：${offenders.join(", ")}`);
});

/* ------------------------------------------------------------------ *
 * D4 — the advertised schema is what an agent reads *before* it forms a
 * request; a field it advertises as optional-but-empty while the validator
 * refuses the empty string sends the agent a request the shell rejects with
 * GP_E_BAD_PARAMS. `gp_observe.role` was that field.
 * ------------------------------------------------------------------ */

test("D4: gp_observe advertises role as non-empty, matching OptionalRoleSchema", () => {
  const role = TOOL_BY_NAME.get("gp_observe").inputSchema.properties.role;
  assert.equal(role.minLength, 1,
    "advertise 的 role 没有 minLength，而运行时 OptionalRoleSchema 是 .min(1)：{\"role\":\"\"} 会被自己拒");
  const empty = TOOL_BY_NAME.get("gp_observe").validate({ role: "" });
  assert.equal(empty.ok, false, "validator 现在收空串了？对照失效");
});

test("D4: no advertised string field is looser than its validator's emptiness verdict", () => {
  // Generalised: for every top-level string property, if the validator accepts a
  // non-empty value but refuses the empty string for that field, the advertised
  // shape must carry minLength >= 1. Only fires when the validator genuinely
  // distinguishes "" from "x", so fields that truly accept empty (bundleId) stay green.
  const offenders = [];
  const checked = [];
  for (const spec of TOOL_SPECS) {
    const props = spec.inputSchema?.properties ?? {};
    for (const [field, fieldSchema] of Object.entries(props)) {
      if (fieldSchema?.type !== "string" || fieldSchema.enum !== undefined || fieldSchema.pattern !== undefined) {
        continue;
      }
      const nonEmpty = spec.validate({ [field]: "x" });
      const empty = spec.validate({ [field]: "" });
      if (nonEmpty.ok && !empty.ok) {
        checked.push(`${spec.name}.${field}`);
        if ((fieldSchema.minLength ?? 0) < 1) {
          offenders.push(`${spec.name}.${field}: validator refuses "" but advertise 的 minLength=${fieldSchema.minLength ?? 0}`);
        }
      }
    }
  }
  assert.ok(checked.includes("gp_observe.role"),
    `这条闸没有再看见 observe.role 这一对（扫描或字段名变了）：checked=${checked.join(", ")}`);
  assert.deepEqual(offenders, [], `这些对外 advertise 的字段比 validator 松：${offenders.join(", ")}`);
});

/* ------------------------------------------------------------------ *
 * D5 — signals and shutdown. A signal handler that calls `shutdown()` (which
 * ends stdout) directly jumps ahead of replies the queue already took but has
 * not yet flushed — the same loss finding 7 closed on stdin's error path,
 * reachable instead through Ctrl-C / SIGTERM.
 * ------------------------------------------------------------------ */

test("D5: SIGINT and SIGTERM route shutdown through the reply queue, not directly", () => {
  // Reverts red if index.ts goes back to `process.on("SIGINT", shutdown)`.
  const source = fs.readFileSync(path.resolve(SRC, "index.ts"), "utf8");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = new RegExp(`process\\.on\\("${signal}",\\s*\\(\\) => (queue\\.push\\(async \\(\\) => shutdown\\(\\)\\)|shutdown)`).exec(source);
    assert.ok(handler, `读不到 ${signal} 处理器——这条闸要看它自己`);
    assert.match(handler[1], /queue\.push\(async \(\) => shutdown\(\)\)/,
      `${signal} 又直接 shutdown()，会抢在队列已取的回复之前 end 掉 stdout`);
  }
  assert.doesNotMatch(source, /process\.on\("SIG(?:INT|TERM)",\s*shutdown\)/,
    "把 shutdown 原样交给 process.on 就是缺陷本体：它不进队列");
});

test("D5: a queued reply still lands when a shutdown runs behind it, and is lost when it runs ahead", async () => {
  // Behavioural proof on the real io primitives, independent of process signalling
  // (which is timing-flaky — the same reason finding 7 pinned the stdin path by
  // shape). `writer.write` refuses once stdout has ended, so a shutdown ordered
  // ahead of the pending reply makes the reply vanish; ordered behind it, it lands.
  const written = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      if (stream.writableEnded) {
        cb(new Error("write after end"));
        return;
      }
      written.push(chunk.toString());
      cb();
    },
  });
  // Case A (the fix): shutdown queued after the reply already taken by the queue.
  const queue = new OrderedReplyQueue(() => {});
  const writer = new DrainAwareWriter(stream, () => {}, 50, () => {});
  const reply = canonicalJson({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n";
  queue.push(async () => { await writer.write(reply, 1); });
  queue.push(async () => { stream.end(); }); // queued shutdown, like the fixed handler
  await queue.drained();
  assert.equal(written.length, 1, "排在回复之后的 shutdown 不该吞掉那条回复");
  assert.equal(written[0], reply);

  // Case B (the defect): the same reply, but shutdown runs directly before the
  // queue flushes it — the write meets an ended stream and is lost.
  const written2 = [];
  const stream2 = new Writable({
    write(chunk, _enc, cb) {
      if (stream2.writableEnded) { cb(new Error("write after end")); return; }
      written2.push(chunk.toString()); cb();
    },
  });
  const queue2 = new OrderedReplyQueue(() => {});
  const writer2 = new DrainAwareWriter(stream2, () => {}, 50, () => {});
  queue2.push(async () => { await writer2.write(reply, 1); });
  stream2.end(); // direct shutdown, ahead of the queued write
  await queue2.drained();
  assert.equal(written2.length, 0, "对照必须成立：抢在写之前 end stdout，那条回复就是丢了");
});

/* ------------------------------------------------------------------ *
 * D6 — the `droppedFrames` counter claimed to be read by `gp_diagnose`. The
 * claim is made true: the drop note names the request id, and the counter is
 * surfaced in the diagnose payload so a lost reply is visible in-band, not only
 * in the log channel.
 * ------------------------------------------------------------------ */

test("D6: the stdout drop note names the request id of the reply it dropped", async () => {
  const notes = [];
  const sink = new Writable({ write(_c, _e, cb) { cb(); } });
  Object.defineProperty(sink, "writableLength", { get: () => STDIO_WRITE_BACKLOG_BYTES + 1, configurable: true });
  const writer = new DrainAwareWriter(sink, (note) => notes.push(note), 50, () => {});
  await writer.write('{"jsonrpc":"2.0","id":42,"result":{}}\n', 42);
  assert.match(notes.join("\n"), /reply 42\b/, `被丢的那一帧要点名它的 request id：${notes.join("\n")}`);
  assert.match(notes.join("\n"), /dropped, not queued/);
  assert.equal(writer.droppedFrames, 1);
});

test("D6: gp_diagnose surfaces the dropped-reply count in-band, and stays silent at zero", async () => {
  // Driven through the real server wiring (index.ts → createTrackedMcpServer →
  // McpServer.callTool → executeTool), because the accessor reaching the tool is
  // the half of this fix the direct tool call cannot prove.
  async function diagnoseWith(dropped) {
    const io = new FakeLineIo();
    const engine = engineClientOver(io, 5_000);
    const { server } = createTrackedMcpServer(engine, () => {}, () => dropped);
    const line = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "gp_diagnose", arguments: {} },
    });
    const response = server.handleLine(line);
    io.respond({ class: "T1", summary: "ok" });
    const { result } = await response;
    engine.close();
    return result.content.map((c) => c.text ?? "");
  }

  const silent = await diagnoseWith(0);
  assert.ok(!silent.some((t) => /stdout backlog/.test(t)), "没有丢帧时不该多出这一节，普通回复形状要原样");

  const loud = await diagnoseWith(3);
  const dropLine = loud.find((t) => /stdout backlog/.test(t));
  assert.ok(dropLine, `gp_diagnose 没有读到丢帧计数，io.ts 的注释就成了假话：${JSON.stringify(loud)}`);
  assert.match(dropLine, /dropped 3 replies/, "要把计数说出来");
  assert.match(dropLine, /gp_last_evidence/, "要给出读得回来的下一步，而不是只报丢");
  // The JSON reply an agent parses must still be byte-identical: the drop note is
  // an appended block, never folded into the first content item.
  assert.deepEqual(JSON.parse(loud[0]), { class: "T1", summary: "ok" });
});

/* ------------------------------------------------------------------ *
 * D7 — the protocol version is a two-ended constant with no gate. Both sides
 * hardcode "0"; a one-sided bump means `hello` handshake silently mismatches.
 * ------------------------------------------------------------------ */

test("D7: the shell's engine protocol version equals the daemon's literal", () => {
  const source = fs.readFileSync(ENGINE_CORE, "utf8");
  const swift = /public let protocolVersion = "([^"]+)"/.exec(source);
  assert.ok(swift, "EngineCore.swift 不再用这行写 protocolVersion——这条闸要看它的新写法");
  assert.equal(ENGINE_PROTOCOL_VERSION, swift[1],
    `壳的 ENGINE_PROTOCOL_VERSION=${ENGINE_PROTOCOL_VERSION} 与 daemon 的 ${swift[1]} 不一致：单边改号无人拦`);
});
