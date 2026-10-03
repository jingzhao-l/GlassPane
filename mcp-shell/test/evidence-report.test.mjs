import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseEvidencePack } from "@iterate/kernel";

import {
  PLACEHOLDER,
  evidenceSummaryLines,
  renderHTML,
  renderMarkdown,
} from "../dist/evidence-report.js";

/**
 * R4-11 / R6-11 / R7-08: the shared cross-language golden, TS side — the bytes
 * `gp_export_evidence` and `gp_recent_reports` hand the agent.
 * `kernel/fixtures/report.ok-01.md` / `.html` hold the exact output of
 * `renderMarkdown` / `renderHTML` for `goldenPack()`;
 * `EngineP1Batch4Tests` compares the Swift renderer against the same two
 * files, so the mirror claim in both renderer headers is checked instead of
 * asserted (spec v1.3 §12 P1-D1, §13.5). Byte for byte: the Markdown file ends
 * in a newline because the renderer's last block does, the HTML one does not.
 */

const FIXTURES = "../../kernel/fixtures/";

function fixture(name) {
  return readFileSync(new URL(`${FIXTURES}${name}`, import.meta.url), "utf8");
}

/**
 * `evidence-pack.ok-03.json` (the P6 §3.1 probe shape) plus the four overrides
 * the shipped fixture cannot carry: a lateCount that proves the field is read
 * rather than defaulted, a second state entry so the key list is a list, and
 * two doubles whose `%g` rendering differs from JS `String()` (B-9).
 */
function goldenPack(latencyMs = 1234.5678) {
  const value = JSON.parse(fixture("evidence-pack.ok-03.json"));
  value.signals.axEvent.latencyMs = latencyMs;
  value.signals.handlerProbe.lateCount = 1;
  // Key order matters: the engine sorts stateDiff.entries when it decodes.
  value.signals.stateDiff.entries.push({ key: "demo.label", before: "idle", after: "pressed" });
  value.signals.pixelDiff.changedPixelRatio = 0.1234567;
  const pack = parseEvidencePack(value);
  // Fail here, not in a golden diff, if the fixture stops matching the shape.
  assert.equal(pack.operationId, "op_0PAAAABBBBCCCCDDDDEEEEFFFF");
  assert.deepEqual(pack.signals.stateDiff.entries.map((e) => e.key), ["demo.count", "demo.label"]);
  return pack;
}

/** ok-02: required members only, explicit null probe channels, no diagnosis. */
function z5Pack() {
  return parseEvidencePack(JSON.parse(fixture("evidence-pack.ok-02.json")));
}

function withSignals(pack, mutate) {
  const next = structuredClone(pack);
  mutate(next.signals);
  return next;
}

function lineFor(pack, prefix) {
  return evidenceSummaryLines(pack).find((line) => line.startsWith(prefix));
}

/* ------------------------- the shared golden ------------------------- */

test("golden report.ok-01.md matches byte for byte, probe lines included", () => {
  assert.equal(renderMarkdown(goldenPack(), undefined), fixture("report.ok-01.md"));
});

test("golden report.ok-01.html matches byte for byte", () => {
  assert.equal(renderHTML(goldenPack(), undefined), fixture("report.ok-01.html"));
});

/* ---------------------- probe channels (R4-10/R6-16) ---------------------- */

test("a null channel names the missing measurement instead of going blank", () => {
  const pack = z5Pack();
  assert.equal(
    lineFor(pack, "handlerProbe:"),
    "handlerProbe: not measured (no probe connection served this act window)",
  );
  assert.equal(
    lineFor(pack, "stateDiff:"),
    "stateDiff: not measured (the probe reported no state channel)",
  );
});

/**
 * R6-09: all six channels, in the documented order. Four of them used to be
 * dropped when the pack carried no reading, which is the gap that reads to a
 * human as "nothing happened". The TS and Swift spellings are compared to each
 * other below rather than to a copy of themselves.
 */
const CHANNEL_ORDER = ["axEvent", "handlerProbe", "stateDiff", "pixelDiff", "responsiveness", "crash"];

function barePack() {
  return withSignals(z5Pack(), (s) => {
    s.axEvent = undefined;
    s.pixelDiff = undefined;
    s.responsiveness = undefined;
    s.crash = undefined;
  });
}

test("every absent channel names itself, in the documented order", () => {
  const lines = evidenceSummaryLines(barePack()).filter((line) =>
    CHANNEL_ORDER.some((channel) => line.startsWith(`${channel}:`)),
  );
  assert.deepEqual(
    lines.map((line) => line.split(":")[0]),
    CHANNEL_ORDER,
    `channel lines out of order or missing: ${JSON.stringify(lines)}`,
  );
  for (const line of lines) {
    assert.match(line, /: not measured \(/, line);
  }
});

/**
 * The control that keeps the case above from being a wish: a pack that measured
 * all six renders no absence line at all. This is also why the shared golden did
 * not move when the four new lines landed — `goldenPack()` carries every channel.
 */
test("a measured channel is never reported as unmeasured", () => {
  const lines = evidenceSummaryLines(goldenPack());
  for (const line of lines) {
    assert.ok(!line.includes("not measured"), `measured pack rendered an absence: ${line}`);
  }
  for (const channel of CHANNEL_ORDER) {
    assert.ok(lines.some((line) => line.startsWith(`${channel}:`)), `${channel} line missing`);
  }
});

/**
 * The mirror's other half: the six strings this file's renderer prints are
 * compared with the six the engine prints, read out of the Swift source. A
 * one-sided rewording fails here, which is the cheaper of the two ways a
 * cross-language drift can be caught (the golden only covers a pack where every
 * channel is present).
 */
test("the Swift renderer's absence wording is byte-identical to this one", () => {
  const swift = readFileSync(
    new URL("../../engine/Sources/GlassPaneEngine/EvidenceReportGenerator.swift", import.meta.url),
    "utf8",
  );
  const found = [...swift.matchAll(/"([a-zA-Z]+: not measured \([^"]*\))"/g)].map((match) => match[1]);
  assert.equal(found.length, CHANNEL_ORDER.length, `Swift literals found: ${JSON.stringify(found)}`);
  // Compared per channel, not per file position: the Swift constants are grouped
  // by when they landed, and a drift check that fails on ordering would hide the
  // wording difference it exists to catch.
  const byChannel = new Map(found.map((line) => [line.split(":")[0], line]));
  assert.deepEqual(
    [...byChannel.keys()].sort(),
    [...CHANNEL_ORDER].sort(),
    `Swift names a channel this side does not: ${JSON.stringify(found)}`,
  );
  const tsLines = evidenceSummaryLines(barePack()).filter((line) =>
    CHANNEL_ORDER.some((channel) => line.startsWith(`${channel}:`)),
  );
  assert.deepEqual(tsLines, CHANNEL_ORDER.map((channel) => byChannel.get(channel)));
});

test("empty lists say so; long lists are bounded with the elided count", () => {
  const empty = withSignals(goldenPack(), (s) => {
    s.handlerProbe.handlers = [];
    s.stateDiff.entries = [];
  });
  assert.ok(lineFor(empty, "handlerProbe:").endsWith("handlers=[no localized hits]"));
  assert.ok(lineFor(empty, "stateDiff:").endsWith("entries=[no key changes]"));

  const wide = withSignals(goldenPack(), (s) => {
    s.handlerProbe.handlers = Array.from({ length: 9 }, (_, i) => ({ file: `lane${i}.swift`, line: i + 1 }));
    s.stateDiff.entries = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, before: "0", after: "1" }));
  });
  const handlerLine = lineFor(wide, "handlerProbe:");
  const stateLine = lineFor(wide, "stateDiff:");
  assert.ok(handlerLine.endsWith("lane7.swift:8, +1 more]"), handlerLine);
  assert.ok(!handlerLine.includes("lane8"), "only the first 8 handlers render");
  assert.ok(stateLine.endsWith('k7 "0" -> "1", +1 more]'), stateLine);
  assert.ok(!stateLine.includes("k8"), "only the first 8 state entries render");
});

/* --------------------------- the number rule --------------------------- */

/**
 * `[value, expected %g, differsFromJsString]`. The third column is what makes
 * these rows able to fail rather than decorate: where true, `String()` — the
 * rule this file used before B-9 — printed something else. The engine-side
 * table pins the same pairs against `%g`.
 */
const NUMBER_RULE_ROWS = [
  [42, "42", false], [0.25, "0.25", false], [0.014, "0.014", false], [1e21, "1e+21", false],
  [1234.5678, "1234.57", true], [0.1234567, "0.123457", true], [123456.7, "123457", true],
  [999999.5, "1e+06", true], [1234567, "1.23457e+06", true], [0.00001234567, "1.23457e-05", true],
];

for (const [value, expected, differsFromJsString] of NUMBER_RULE_ROWS) {
  test(`number rule is %g, not String(): ${value} -> ${expected}`, () => {
    assert.equal(lineFor(goldenPack(value), "axEvent:"), `axEvent: changed=true nodes=24 latencyMs=${expected}`);
    assert.equal(String(value) !== expected, differsFromJsString, `row ${value} mislabels String()`);
  });
}

/* ----------------------- the two absences (R4-14) ----------------------- */

test("no diagnosis recorded is spelled out, with the tool to call", () => {
  const markdown = renderMarkdown(z5Pack(), undefined);
  for (const title of ["PATH", "ANOMALY", "EVIDENCE", "NEXT"]) {
    assert.ok(
      markdown.includes(`## ${title}\n\n— (no diagnosis recorded:`),
      `${title} must name the missing diagnosis`,
    );
  }
  assert.ok(markdown.includes("run gp_diagnose for this operationId"));
});

test("a diagnosis that ran but left a section empty keeps the plain placeholder", () => {
  const pack = structuredClone(z5Pack());
  pack.diagnosis = {
    class: "INCONCLUSIVE",
    report: { path: "", anomaly: "", evidence: "", next: "" },
  };
  const markdown = renderMarkdown(pack, undefined);
  assert.ok(markdown.includes(`## PATH\n\n${PLACEHOLDER}\n`));
  assert.ok(markdown.includes(`## NEXT\n\n${PLACEHOLDER}\n`));
  assert.ok(!markdown.includes("no diagnosis recorded"));
});

test("caller diagnostics replace the EVIDENCE absence of a real report", () => {
  assert.ok(renderMarkdown(z5Pack(), "provisional").includes("## EVIDENCE\n\nprovisional\n"));
  assert.ok(renderHTML(z5Pack(), "provisional").includes("<pre>provisional</pre>"));
  const diagnosed = structuredClone(z5Pack());
  diagnosed.diagnosis = { class: "T3", report: { path: "p", anomaly: "a", evidence: "measured", next: "n" } };
  assert.ok(renderMarkdown(diagnosed, "provisional").includes("## EVIDENCE\n\nmeasured"));
});

/* ----------------------------- escaping ----------------------------- */

test("probe values are escaped in HTML and verbatim in Markdown", () => {
  const pack = withSignals(goldenPack(), (s) => {
    s.handlerProbe.probeVersion = 'gp-probe/<b>&"0.1"';
    s.handlerProbe.handlers = [{ file: "a&b/<x>.swift", line: 7 }];
    s.stateDiff.entries = [{ key: "k\"1", before: "<i>", after: "a&b" }];
  });
  assert.ok(renderMarkdown(pack, undefined).includes("handlers=[a&b/<x>.swift:7]"));
  const html = renderHTML(pack, undefined);
  assert.ok(html.includes("handlers=[a&amp;b/&lt;x&gt;.swift:7]"), html);
  assert.ok(html.includes("probeVersion=gp-probe/&lt;b&gt;&amp;&quot;0.1&quot;"), html);
  assert.ok(
    html.includes("entries=[k&quot;1 &quot;&lt;i&gt;&quot; -&gt; &quot;a&amp;b&quot;]"),
    "the before/after arrow escapes along with the rest of the value",
  );
});

/* ---------------- 终端控制字符：报告是打给终端看的 ---------------- */

/**
 * `escapeHTML` 只护住了 HTML 那半，而 `gp_export_evidence` / `gp_recent_reports`
 * 默认交回的是 **markdown 文本**，代理会原样打到终端上。报告里的 selector 标题、
 * stateDiff 的键值都是 app 自己写的字符串——一个窗口标题塞一段 OSC-52 就能改写
 * 用户的剪贴板，一段 ANSI 能把光标移走覆盖掉它说过的话。
 * daemon 那一侧为这件事立过规矩（R5-03：`<0x20` 一律转义），这里补齐壳这一侧。
 *
 * 反向变异：把 renderMarkdown 末尾的 `escapeTerminalControl(...)` 去掉，
 * 第一、二条立刻变红；把 `\n`/`\t` 也纳入替换，第三条变红。
 */
test("markdown report carries no raw terminal escape", () => {
  const ESC = String.fromCharCode(27);
  const pack = goldenPack();
  const hostile = structuredClone(pack);
  hostile.signals.act.selector.title = `Submit${ESC}]52;c;aGVsbG8=${ESC}\\`;
  const out = renderMarkdown(hostile, undefined);
  assert.equal(out.includes(ESC), false, "报告里不许出现可执行的 ESC 字节");
  assert.ok(out.includes("\\u001b"), "要被看见，而不是被悄悄删掉：", out.slice(0, 200));
});

test("html report carries no raw terminal escape either", () => {
  const ESC = String.fromCharCode(27);
  const hostile = structuredClone(goldenPack());
  hostile.signals.stateDiff.entries[0].after = `${ESC}[2Jpwned`;
  const out = renderHTML(hostile, undefined);
  assert.equal(out.includes(ESC), false, "HTML 也是当文本交回的，`<` 被转义不代表 ESC 被转义");
  assert.ok(out.includes("\\u001b"));
});

test("the renderer's own newlines and tabs survive", () => {
  const plain = renderMarkdown(goldenPack(), undefined);
  assert.ok(plain.includes("\n"), "换行是这份 markdown 自己的排版，不许被吃掉");
  assert.equal(plain, fixture("report.ok-01.md"), "无控制字符的输入必须逐字节不变（金样仍成立）");
});
