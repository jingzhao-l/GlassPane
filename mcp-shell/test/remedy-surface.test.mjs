import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GP_E_BAD_PARAMS,
  GP_E_ENGINE_TIMEOUT,
  GP_E_ENGINE_UNREACHABLE,
  GP_E_INTERNAL,
  GP_E_NO_EVIDENCE,
  GP_E_NO_USER_RECORD,
  GP_E_NOT_FOUND,
  GP_E_PAYLOAD_TOO_LARGE,
  GP_E_PROJECT_LIMIT,
  GP_E_UNKNOWN,
} from "../dist/errors.js";
import { livenessProbeDecision, slowEngineRemedy } from "../dist/engine-client.js";

/**
 * Two claims this shell makes about error codes, and neither was measured when
 * it was written:
 *  - `errors.ts` says a code is or is not in the daemon's vocabulary. The daemon
 *    declares `GP_E_PAYLOAD_TOO_LARGE` itself, so the sentence "the enum has no
    counterpart for either" was false.
 *  - `livenessProbeDecision("engine-error")` used to say a code's own remedy "is
 *    never a restart". `GP_E_AX_UNAVAILABLE`'s daemon remedy *is* a restart
 *    (`ProtocolErrors.swift`), so the probe table forbade the one correct action.
 * Both are now checked against the daemon's source instead of against prose.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_ERRORS = path.resolve(HERE, "..", "..", "engine", "Sources", "GlassPaneEngine", "ProtocolErrors.swift");
const ENGINE_CORE = path.resolve(HERE, "..", "..", "engine", "Sources", "GlassPaneEngine", "EngineCore.swift");
const SHARED = [
  GP_E_BAD_PARAMS, GP_E_INTERNAL, GP_E_NO_EVIDENCE, GP_E_NOT_FOUND,
  GP_E_PAYLOAD_TOO_LARGE, GP_E_PROJECT_LIMIT,
];
const SHELL_ONLY = [
  GP_E_ENGINE_TIMEOUT, GP_E_ENGINE_UNREACHABLE, GP_E_NO_USER_RECORD, GP_E_UNKNOWN,
];

function daemonCodes() {
  const source = fs.readFileSync(PROTOCOL_ERRORS, "utf8");
  const block = /public enum GPErrorCode: String, Codable, CaseIterable \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, "读不到 GPErrorCode 枚举——这些断言就没有对照物了");
  const codes = new Set();
  for (const raw of block[1].split("\n")) {
    const line = raw.replace(/\/\/.*$/, "");
    const declared = /=\s*"(GP_E_[A-Z_]+)"/.exec(line);
    if (declared) {
      codes.add(declared[1]);
      continue;
    }
    const bare = /^\s*case\s+([A-Za-z0-9_]+)\s*$/.exec(line);
    if (bare) {
      codes.add(`GP_E_${bare[1].replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`);
    }
  }
  assert.ok(codes.size >= 15, `只解析出 ${codes.size} 个 daemon 错误码，解析方式已经跟不上枚举`);
  return codes;
}

/** Every daemon remedy string, keyed by code, from the `remedy(for:)` switch. */
function daemonRemedies() {
  const source = fs.readFileSync(PROTOCOL_ERRORS, "utf8");
  const out = new Map();
  let current = null;
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const opened = /^case\s+\.([A-Za-z0-9_]+)\s*:$/.exec(line);
    if (opened) {
      current = `GP_E_${opened[1].replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
      continue;
    }
    const returned = /^return\s+"((?:[^"\\]|\\.)*)"$/.exec(line);
    if (returned && current && !out.has(current)) {
      out.set(current, returned[1].replace(/\\"/g, '"'));
      current = null;
    }
  }
  // The daemon has a `default:` arm, which is why `current` may end unresolved;
  // what must not happen is the scan finding almost nothing, because that is
  // how a rewritten switch would turn this gate into a no-op.
  assert.ok(out.size >= 10, `只解析出 ${out.size} 条 daemon remedy 文本，扫描方式已经对不上写法`);
  return out;
}

test("errors.ts' split between shared and shell-only codes matches the daemon's enum", () => {
  const codes = daemonCodes();
  const wronglyClaimedShared = SHARED.filter((code) => !codes.has(code));
  assert.deepEqual(wronglyClaimedShared, [],
    `这些码被当作 daemon 也声明的码，但枚举里没有：${wronglyClaimedShared.join(", ")}`);
  const wronglyClaimedShellOnly = SHELL_ONLY.filter((code) => codes.has(code));
  assert.deepEqual(wronglyClaimedShellOnly, [],
    `这些码的注释说 daemon 没有对应物，而枚举里有了：${wronglyClaimedShellOnly.join(", ")}`);
});

test("a probe answer of \\\"engine error\\\" may not forbid the restart the daemon itself orders", () => {
  const remedies = daemonRemedies();
  const restartCodes = [...remedies.entries()]
    .filter(([, text]) => text.includes("--restore-launchd") || text.includes("launchctl kickstart"))
    .map(([code]) => code)
    .sort();
  // If this set is empty the sentence below is decoration again, so the gate
  // requires the measurement to have produced something to be careful about.
  assert.ok(restartCodes.length > 0,
    "daemon 的 remedy 表里没有任何一条命令重启——那 \\\"engine-error 永不重启\\\"就成了没被检验的断言");
  const clause = livenessProbeDecision("engine-error");
  assert.ok(!/which is never a restart/.test(clause),
    `这条判据在禁止一个 daemon 自己开出的动作（这些码会点名重启：${restartCodes.join(", ")}）`);
  assert.match(clause, /follow that code's own remedy/);
});

test("the mcp remedy promises the trail, the http remedy promises its own stderr", () => {
  const mcp = slowEngineRemedy("act", "mcp");
  const http = slowEngineRemedy("act", "http");
  assert.ok(mcp.includes("gp_recent_reports"), "MCP 侧要给出取回迟到操作的具名工具");
  assert.ok(!http.includes("gp_recent_reports"),
    "HTTP 调用方没有 gp_recent_reports 可调（POST /v1/tools/recent_reports 是 404），不得把它支过去");
  assert.ok(http.includes("/v1/evidence/"), `HTTP 侧要给出它真能走的那条路：${http.slice(0, 200)}`);
  // Both surfaces must still name the log they actually write to.
  assert.ok(mcp.includes("stderr") && http.includes("stderr"));
  // …and neither may promise the late reply *unconditionally*: the tracking
  // window is bounded, a re-attach supersedes it, and a stopped process records
  // nothing. A promise without its boundary drifts back into "guaranteed".
  for (const [surface, text] of [["mcp", mcp], ["http", http]]) {
    assert.match(text, /while this server still tracks|tracking window is bounded/i,
      `${surface} 侧把迟到回复写成了无条件承诺`);
    assert.match(text, /\b16\b/, "有界窗口必须把界限说出来，而不是只说\"有限\"");
  }
});

test("a GP_E_* literal appears in src/ only in errors.ts", () => {
  // X-15 / R8-中7: the code vocabulary is one file. A second spelling of a code
  // is how a rename leaves one call site answering with a stale string.
  const srcDir = path.resolve(HERE, "..", "src");
  const offenders = [];
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === "errors.ts") {
      continue;
    }
    const body = fs.readFileSync(path.join(srcDir, entry.name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const match of body.matchAll(/"(GP_E_[A-Z_]+)"/g)) {
      offenders.push(`${entry.name}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `这些文件里出现了裸写的错误码字面量：${offenders.join(", ")}`);
});

test("every engine call in the tool layer carries the trail generation it was admitted under", () => {
  // The late-reply sink can only refuse a superseded write if the request said
  // which generation it belonged to. `capture_view` was the one `.call(` in
  // `tools.ts` that did not, and the reason it was harmless ("a PNG frame names
  // no operationId") is a fact about the daemon's *reply* — so the next field
  // added to that frame would have reopened the cross-app leak silently, with no
  // test able to notice. This is the shape-of-the-call check; the behaviour it
  // protects is tested in `tools.test.mjs`.
  const source = fs.readFileSync(path.resolve(HERE, "..", "src", "tools.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const missing = [];
  for (const match of source.matchAll(/(?:engine|context\.engine)\.call\(([\s\S]{0,160}?)\);/g)) {
    if (!match[1].includes("session.generation")) {
      missing.push(match[1].replace(/\s+/g, " ").slice(0, 90));
    }
  }
  assert.deepEqual(missing, [], `这些 engine.call 没带链纪元，迟到回复将无法判断归属：${JSON.stringify(missing)}`);
  assert.ok(source.includes("session.generation"), "一条都没匹配到＝这个闸已经不再看任何东西");
});

/* ------------------------------------------------------------------ *
 * R9: the daemon's per-label capture advice, read out of `EngineCore.swift`.
 *
 * `pixelCaptureFailureLabel` names the cause of a failed capture; the switch
 * inside `map(_:degradation:)` is what turns that name into the sentence the
 * agent acts on — the MCP shell forwards daemon remedies verbatim
 * (`engine-client.ts` `engineError`). `pixel-capture-no-surface` (window on
 * screen but covered) had no arm, so it fell into `default:`, whose text orders
 * re-granting Screen Recording and restarting the daemon; a restart cancels an
 * act in flight, so the advice for a covered window was actively destructive.
 * Two claims are pinned so the defect cannot come back or spread:
 *  1. every label the classifier can emit has its own arm — a new label must
 *     not silently fall through to `default` (set equality, both directions:
 *     an arm for a label nobody emits is dead prose waiting to mislead);
 *  2. no `pixel-capture-*` arm's text names a re-grant or a restart command —
 *     only `screen-recording-denied` may order the seat, because only that
 *     label's cause *is* the seat.
 * Mutations that redden this gate (name them, per doctrine):
 *  - delete `case "pixel-capture-no-surface":` → the label loses its arm →
 *    claim 1 is red (before this file existed, the label still produced a —
 *    wrong — remedy at runtime and every behavioural test stayed green);
 *  - restore the no-surface advice to `seatAdvice` (or paste "grant Screen
 *    Recording" / "restart the daemon" into any pixel-capture-* arm) → claim 2
 *    is red;
 *  - add a new `return "pixel-capture-…"` to `pixelCaptureFailureLabel`
 *    without an arm → claim 1 is red.
 * ------------------------------------------------------------------ */

/** The labels `pixelCaptureFailureLabel` can answer with, from its own returns. */
function swiftCaptureLabels() {
  const source = fs.readFileSync(ENGINE_CORE, "utf8");
  const declaration = "static func pixelCaptureFailureLabel(reason: String) -> String {";
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1,
    "EngineCore 里找不到 pixelCaptureFailureLabel——标签的出处没了，这条闸必须红而不是跳过");
  const next = source.indexOf("\n    static ", start + declaration.length);
  const body = source.slice(start, next === -1 ? undefined : next);
  const labels = new Set();
  for (const match of body.matchAll(/return\s+"([a-z0-9-]+)"/g)) {
    labels.add(match[1]);
  }
  // The equality checks below already fail when this set or the arm set empties,
  // but a floor states the intent: a parse of ~zero labels means the writing
  // style moved, and the gate must say so rather than pass on an empty loop.
  assert.ok(labels.size >= 8, `只解析出 ${labels.size} 个捕获标签，读取方式已经对不上写法`);
  return labels;
}

/** The `case "<label>": advice = …` arms of the advice switch, label → text. */
function swiftCaptureAdviceArms() {
  const source = fs.readFileSync(ENGINE_CORE, "utf8");
  const opened = source.indexOf("switch label {");
  assert.notEqual(opened, -1,
    "EngineCore.map 里不再有 `switch label {`——出路文本换了写法，这条闸要看住它的新家");
  const closed = source.indexOf("return GPError(", opened);
  assert.notEqual(closed, -1, "switch 之后找不到它喂的那个 GPError——扫描边界定不下来");
  const arms = new Map();
  let current = null;
  let text = [];
  const flush = () => {
    if (current !== null) arms.set(current, text.join(" ").replace(/\s+/g, " ").trim());
  };
  for (const raw of source.slice(opened, closed).split("\n")) {
    const line = raw.replace(/\/\/.*$/, "");
    const arm = /^\s*case\s+"([a-z0-9-]+)"\s*:/.exec(line);
    if (arm) {
      flush();
      current = arm[1];
      text = [line.replace(/^\s*case\s+"[a-z0-9-]+"\s*:/, "")];
      continue;
    }
    if (/^\s*default\s*:/.test(line)) {
      // `default` is deliberately not an arm: whatever it says, no label may
      // depend on it — claim 1 is what keeps it unreachable prose.
      flush();
      current = null;
      continue;
    }
    if (current !== null) text.push(line);
  }
  flush();
  assert.ok(arms.size >= 8, `只解析出 ${arms.size} 条 advice 分支，扫描方式已经对不上写法`);
  return arms;
}

test("every pixel-capture label has its own advice arm, and none of them orders a re-grant or a restart", () => {
  const labels = swiftCaptureLabels();
  const arms = swiftCaptureAdviceArms();

  // Claim 1a: no label falls through to `default`.
  const withoutArm = [...labels].filter((label) => !arms.has(label)).sort();
  assert.deepEqual(withoutArm, [],
    `这些捕获标签没有自己的出路分支，会落进 default 那句"去授予屏幕录制并重启 daemon"：${withoutArm.join(", ")}`);
  // Claim 1b: no arm waits for a label that is never emitted (dead prose).
  const deadArms = [...arms.keys()].filter((label) => !labels.has(label)).sort();
  assert.deepEqual(deadArms, [],
    `这些分支服务的标签已不是 pixelCaptureFailureLabel 的取值，出路成了没人触发的死文本：${deadArms.join(", ")}`);

  // Claim 2: the seat sentence belongs to exactly one label. Deliberately
  // patterned on the *command* spellings ("grant Screen Recording", "restart
  // the daemon", the launchd verbs), so an arm that says "no permission grant
  // can fix this" or "do not re-grant on this error alone" — which is what the
  // honest arms do — stays green while an affirmative order to re-grant or
  // recycle the daemon goes red.
  for (const [label, text] of arms) {
    if (!label.startsWith("pixel-capture-")) continue;
    assert.doesNotMatch(text, /grant\s+screen\s+recording/i,
      `\`${label}\` 的出路命令去授予屏幕录制，而它的成因不是席位：${text.slice(0, 160)}`);
    assert.doesNotMatch(text, /restart\s+the\s+daemon|kickstart|--restore-launchd|--grant/i,
      `\`${label}\` 的出路命令重启或再授权——重启会杀掉用户屏幕上在跑的 act：${text.slice(0, 160)}`);
  }

  // The positive half that must keep working: the one label whose cause *is*
  // the seat still routes to the seat sentence, and no-surface still says what
  // actually covers it and what to do instead.
  assert.match(arms.get("screen-recording-denied") ?? "", /seatAdvice|grant Screen Recording/,
    "唯一该去授予席位的分支不再指向席位文本了——这条闸的正半边的对照物没了");
  assert.match(arms.get("pixel-capture-no-surface") ?? "", /cover/i,
    "no-surface 的出路必须仍说出真成因（被盖住），否则又是一句不指向事实的话");
  assert.match(arms.get("pixel-capture-no-surface") ?? "", /raise|bring|above|move the covering window/i,
    "no-surface 的出路必须给一个能执行的动作（把目标窗口带到上层），而不是只有诊断");
});
