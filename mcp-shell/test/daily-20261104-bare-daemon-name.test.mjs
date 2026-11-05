/**
 * No remedy this shell prints may hand a caller the bare word `glasspaned`.
 *
 * Why a GATE and not another site-by-site fix: this class has been found short of the next site
 * five times (ledger 2026-11-03 #14 fixed 15 places by hand; `DaemonInvocation.swift` exists for
 * the Swift side; today two more appeared in `http-gateway.ts`, which is the file the previous
 * sweep never looked at). A vocabulary list is the wrong tool — the shape is what recurs.
 *
 * The judgement is positional: `glasspaned` appearing as the COMMAND of a copyable run — i.e.
 * immediately followed by a flag — inside a backticked span. Prose that merely names the binary
 * ("the glasspaned process", "glasspaned's socket") is not a command and must not be flagged, or
 * the gate starts demanding things that cannot be done.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src");

/** A bare `glasspaned` at a command position: not preceded by a path separator or a quote-expansion. */
const BARE_DAEMON_COMMAND = /(?:^|[^/\w$"'])(glasspaned)\s+--([a-z][a-z-]*)/g;

import { executableSource } from "./support/source.mjs";

function files() {
  return fs.readdirSync(SRC).filter((name) => name.endsWith(".ts")).sort();
}

/**
 * Bare-name command positions in CODE. Comments are stripped first: prose that says
 * "run `glasspaned --permissions` inside the daemon" is documentation about another layer, not a
 * remedy a caller executes — and a gate that fires on it gets loosened rather than obeyed.
 */
function offendersOf(text) {
  return [...executableSource(text).matchAll(BARE_DAEMON_COMMAND)].map((match) => match[2]);
}

/** daemon 命令位（裸名或带位置的写法都算）：这条闸"看见了几个位置"的空转下界用它说话。 */
const DAEMON_COMMAND_POSITION = /glasspaned(?:\\?["'])?\s+--/g;

test("no caller-facing string in src runs the daemon by a bare name", () => {
  const offenders = [];
  let positions = 0;
  for (const name of files()) {
    const text = fs.readFileSync(path.join(SRC, name), "utf8");
    const code = executableSource(text);
    for (const flag of offendersOf(text)) {
      offenders.push(`${name}: glasspaned --${flag}`);
    }
    // 空转下界（2026-11-05，风格同 remedy-shell-quoting 末尾的具名 floor）：`deepEqual(offenders, [])`
    // 在"一个文件都没扫、一处命令位都没看见"时同样绿。扫描集一旦塌掉，这里必须先红。
    positions += (code.match(DAEMON_COMMAND_POSITION) ?? []).length;
  }
  assert.ok(files().length >= 8,
    `src 只扫到 ${files().length} 个 .ts——文件列表塌了，裸名闸正在对着空集点头`);
  assert.ok(positions >= 8,
    `daemon 命令位只看见 ${positions} 处（本轮引号修完后实数 12）：扫描集空了，offenders 为空不再说明任何事`);
  assert.deepEqual(offenders, [],
    `这些出路把 daemon 写成裸名，而它不在 PATH 上（照抄得到 127）：${offenders.join(" | ")}`);
});

test("the scanner bites: a bare-name remedy is reported, a path-form one is not", () => {
  const bad = 'fail(res, 501, "x", "run `glasspaned --evidence-stats` here")';
  assert.deepEqual(["evidence-stats"], offendersOf(bad), "反向对照：这条扫描必须能抓到裸名");
  const good = "run `'~/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned' --evidence-stats` here";
  assert.deepEqual([], offendersOf(good), "带位置的写法不该被判成缺陷");
  const prose = "the glasspaned process owns that socket; glasspaned is not a bin of this package";
  assert.deepEqual([], offendersOf(prose), "散文里提一下进程名不是命令位，要求它加引号是不可能的事");
});

test("the two /v1 routes that point at the daemon CLI name it by location", () => {
  const text = fs.readFileSync(path.join(SRC, "http-gateway.ts"), "utf8");
  assert.ok(text.includes("daemonCliCommand(\"--evidence-stats\")"),
    "evidence-stats 那条出路不再走 daemonCliCommand，本轮的修法被打回去了");
  assert.ok(text.includes("daemonCliCommand(\"--recipe-validate\", \"<recipe.json-path>\")"),
    "recipe-validate 那条出路不再走 daemonCliCommand");
});
