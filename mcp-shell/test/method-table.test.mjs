import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ENGINE_DEADLINES_MS,
  engineDeadlineMs,
  ENGINE_TIMEOUT_MS,
  RESTORE_BASE_DEADLINE_MS,
} from "../dist/engine-client.js";
import { TOOL_SPECS } from "../dist/tools.js";
import { shellWireSurface } from "./support/wire-surface.mjs";

/**
 * R8-中5: the daemon's method table is frozen (`FrameCodec.EngineMethod`), and
 * this shell's per-method deadlines were checked against nothing. Two drifts were
 * live the day this file was written: `audit_ui` and `capture_view` are requests
 * this shell really sends, yet neither appears in `ENGINE_DEADLINES_MS`, so both
 * silently rode the "unknown method" fallback — a deadline nobody derived from
 * the daemon's own worst case, which is exactly how R8-高1 (a probe given less
 * time than the request it diagnoses) survived its green suite.
 *
 * The gate is deliberately one-directional. `shutdown` is in the table with no
 * tool behind it (an agent that needs to stop the daemon has a CLI, not an MCP
 * tool), and dropping that entry would buy nothing: the table documents the
 * daemon's per-method worst cases, and documenting one more costs no behaviour.
 * What must never happen is the other direction — a request on the wire with no
 * derived number behind it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAME_CODEC = path.resolve(HERE, "..", "..", "engine", "Sources", "GlassPaneEngine", "FrameCodec.swift");

/** Parse the daemon's `EngineMethod` raw values out of its Swift declaration. */
function swiftEngineMethods() {
  const source = fs.readFileSync(FRAME_CODEC, "utf8");
  const block = /public enum EngineMethod: String, CaseIterable \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, "找不到 EngineMethod 声明——daemon 的方法表换了写法，这条闸必须红而不是跳过");
  const names = new Set();
  for (const rawLine of block[1].split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line.startsWith("case ")) {
      continue;
    }
    // A Swift line can mix both shapes — `case diagnose, lastEvidence =
    // "last_evidence"` declares a bare identifier *and* an explicit raw value —
    // so every identifier on the line is read, and the one that carries a
    // literal contributes the literal rather than its camelCase name. (Parsing
    // only "the explicit value if any" drops `diagnose`, which is how this file
    // first went red against a table that plainly contains it.)
    const literalPerIdentifier = new Map();
    for (const part of line.slice("case ".length).split(",")) {
      const trimmed = part.trim();
      if (trimmed === "") {
        continue;
      }
      const withValue = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]+)"$/.exec(trimmed);
      if (withValue) {
        literalPerIdentifier.set(withValue[1], withValue[2]);
      } else {
        literalPerIdentifier.set(trimmed, trimmed);
      }
    }
    for (const [identifier, wire] of literalPerIdentifier) {
      names.add(wire);
      assert.ok(!/[A-Z]/.test(wire),
        `EngineMethod 的线名都是 snake_case，\`${identifier}\` 的 \`${wire}\` 不是——读表的方式错了`);
    }
  }
  return names;
}

/**
 * The guard both method-table gates run before trusting the derivation. It is
 * deliberately *not* a `sent.length >= 10`-style floor: the forwarded-from-spec
 * half alone produces 11 names, so a floor on the merged set survives even when
 * the literal `.call("<name>")` scan has died — and it was exactly a
 * variable-named call (`engine.call(spec.engineMethod, …)` in `tools.ts`) whose
 * methods could otherwise escape this file and the late-reply sweep unnoticed.
 * What has to keep being true is that *both producers still produce*:
 *  - the spec half contributes one method per forwarded-as-is spec, and its
 *    premise (`engine.call(spec.engineMethod, …)` still exists) is alive;
 *  - the literal half still finds at least one wire method the spec half
 *    cannot produce (today `capture_view`).
 * Mutations that redden this (named per doctrine): re-spell every orchestrated
 * `.call("name")` as `.call(\`name\`)` or a variable → `literalOnly` empties →
 * red; refactor `runValidatedTool`'s forward away → `variableForwardAlive`
 * false → red; point the scan at a directory with no `.ts` → both halves empty
 * → red. Without this, tests below compare against whatever the scan happened
 * to find and pass on a shrunk set.
 */
function assertDerivationAlive(surface) {
  assert.ok(surface.speclessCount >= 1 && surface.fromSpecs.size === surface.speclessCount,
    `转发自 spec 的那半边没产出（forwardable=${surface.speclessCount}，解析出 ${surface.fromSpecs.size}）——推导已经断了`);
  assert.ok(surface.variableForwardAlive,
    "tools.ts 里找不到 `engine.call(spec.engineMethod, …)` 这个转发臂——spec 半边的前提没了，方法表要看住它的新家");
  assert.ok(surface.literalOnly.length >= 1,
    "字面量 `.call(\"<name>\")` 扫描再也找不到 spec 环路给不出的方法——这一半边已经不再检查任何东西");
}

test("every method this shell sends is one the daemon declares", () => {
  const swift = swiftEngineMethods();
  const surface = shellWireSurface(TOOL_SPECS, path.resolve(HERE, "..", "src"));
  assertDerivationAlive(surface);
  const sent = [...surface.sent].sort();
  assert.ok(sent.length >= 10, `只收集到 ${sent.length} 个方法名，这条闸已经不再检查任何东西`);
  const unknown = sent.filter((method) => !swift.has(method));
  assert.deepEqual(unknown, [],
    `这些方法 daemon 的 EngineMethod 表里没有，发出去只会被拒：${unknown.join(", ")}`);
});

test("every method this shell sends has a deadline derived from the daemon, not the fallback", () => {
  const surface = shellWireSurface(TOOL_SPECS, path.resolve(HERE, "..", "src"));
  // Same guard as above: without it, a dead derivation shrinks `sent` and the
  // `missing` filter below goes green by never seeing the method that rides the
  // fallback.
  assertDerivationAlive(surface);
  const sent = [...surface.sent].sort();
  // `restore` is the one sent method whose deadline is *derived* rather than
  // listed: an ffwd restore replays its steps by calling `act` per step, so a
  // table entry would be a number that contradicts the formula
  // (`RESTORE_BASE_DEADLINE_MS + steps × act`). Every other name must be spelled
  // out, because "absent from the table" means "fell on the unknown-method
  // fallback", which is the hole this gate exists to keep shut.
  const missing = sent.filter((method) => !(method in ENGINE_DEADLINES_MS) && method !== "restore");
  assert.deepEqual(missing, [],
    `这些请求落在 ENGINE_TIMEOUT_MS*3=${ENGINE_TIMEOUT_MS * 3}ms 的缺省上，没有人按 daemon 的最坏值推过它：${missing.join(", ")}`);
  // The fallback has to exist with the shape asserted above, or an empty
  // `missing` would prove nothing: a method absent from the table would then be
  // failing somewhere else rather than riding a derived-by-nobody number.
  assert.equal(engineDeadlineMs("method_the_daemon_does_not_have"), ENGINE_TIMEOUT_MS * 3,
    "缺省路径的形状变了，这条闸的比较对象就不再是\"落在缺省上\"");
  assert.equal(engineDeadlineMs("restore", { steps: [{}, {}, {}] }),
    RESTORE_BASE_DEADLINE_MS + 3 * ENGINE_DEADLINES_MS.act,
    "restore 的期限不是按步数推出来的公式，表里没有它就成了没人核对的数");
});

test("a named deadline is never shorter than the daemon's own latency flag", () => {
  // The flag is read from the daemon's source, not restated here: `ENGINE_TIMEOUT_MS`
  // is *this shell's* fallback, and a gate that compared the table to it would only
  // prove the table agrees with another TS number. `EngineCore.performanceLatencyBudgetMs`
  // is the point where the daemon calls itself slow; a caller deadline at or under it
  // diagnoses a merely-slow daemon as broken.
  const engineCore = path.resolve(HERE, "..", "..", "engine", "Sources", "GlassPaneEngine", "EngineCore.swift");
  const declared = /public static let performanceLatencyBudgetMs: Double = ([0-9_]+)/.exec(fs.readFileSync(engineCore, "utf8"));
  assert.ok(declared, "读不到 EngineCore.performanceLatencyBudgetMs —— 这条闸就没有对照物了");
  const daemonFlag = Number(declared[1].replace(/_/g, ""));
  assert.equal(ENGINE_TIMEOUT_MS, daemonFlag,
    `TS 缺省 ${ENGINE_TIMEOUT_MS}ms 与 daemon 的 ${daemonFlag}ms 已经不是一个数；注释里的"10 s 是 daemon 的内部旗标"不再成立`);
  const offenders = Object.entries(ENGINE_DEADLINES_MS).filter(([, ms]) => ms <= daemonFlag);
  assert.deepEqual(offenders, [], `这些期限不大于 daemon 的延迟旗标 ${daemonFlag}ms：${JSON.stringify(offenders)}`);
});
