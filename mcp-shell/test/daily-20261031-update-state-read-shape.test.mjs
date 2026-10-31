/**
 * 状态文件这一读的三件事：判与读是同一个 inode、外来的字节有限长且不带上控制字符、
 * 链接与被换掉的路径都拒得出去（2026-10-31，lane-ts 的第 4 条）。
 *
 * 原来这里是 `existsSync` → `lstatSync` → `readFileSync`：批准的是那一份 0600 的常规文件，
 * 读回来的可能已经是另一份东西；而 `update-state.json` 的 `current` / `latest` /
 * `lastError.message` / `runtime.detail` 被无界、不转义地插进 `gp_diagnose` 念给 agent 的那
 * 一行——同仓对报告正文与 daemon 来的 id 早就分别走 `escapeTerminalControl` 与
 * `renderForeign`，这一面是最后一处原样复述。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readUpdateState, UPDATE_STATE_MAX_BYTES, STATE_DIR_ENV } from "../dist/update-state.js";

const esc = String.fromCharCode(0x1b);

function root(label) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `gp-ustate-${label}-`));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function writeState(dir, text, mode = 0o600) {
  const file = path.join(dir, "update-state.json");
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
  return file;
}

const readingFor = (dir) => readUpdateState({ [STATE_DIR_ENV]: dir });

test("a hostile state file cannot make gp_diagnose print whatever it holds", () => {
  const dir = root("bounds");
  try {
    const hostile = `${esc}[2J` + "P".repeat(5000);
    writeState(dir, JSON.stringify({
      schemaVersion: 1, status: "check-failed", current: hostile,
      latest: hostile, updatedAt: hostile,
      lastError: { code: "sig", message: `${esc}[31;1m` + "M".repeat(4000) },
    }));
    const summary = readingFor(dir).summary;
    assert.ok(!summary.includes(esc), `上线的那一行里有裸 ESC：${summary.slice(0, 120)}`);
    assert.ok(summary.length < 4096, `一句话复述了 ${summary.length} 个字符的外来正文`);
    assert.match(summary, /more characters not shown/, `截断必须说实话，不许静默剪掉：${summary.slice(0, 200)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a state file bigger than the bound is refused before it is allocated", () => {
  const dir = root("size");
  try {
    // 比判据大一字节即可：这条闸问的是"会不会去分配外来文件声称的大小"，不是压测。
    writeState(dir, " ".repeat(UPDATE_STATE_MAX_BYTES + 1));
    const reading = readingFor(dir);
    assert.equal(reading.kind, "unreadable");
    assert.match(reading.summary, /more than this reader will hold/, reading.summary);
    assert.match(reading.summary, new RegExp(String(UPDATE_STATE_MAX_BYTES)), "上限要点名得出，读者才知道要改什么");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlink at the state path is refused by the same open that judges it, and the target is not read", () => {
  const dir = root("link");
  try {
    const elsewhere = path.join(dir, "someone-else.json");
    fs.writeFileSync(elsewhere, JSON.stringify({ status: "up-to-date" }), { mode: 0o600 });
    const state = path.join(dir, "update-state.json");
    fs.symlinkSync(elsewhere, state);
    const reading = readUpdateState({ [STATE_DIR_ENV]: dir });
    assert.equal(reading.kind, "unreadable", `符号链接那一档必须拒，不许把指着的文件当状态：${reading.summary}`);
    assert.match(reading.summary, /it is a symlink/, reading.summary);
    assert.ok(!reading.summary.includes("up-to-date"), `读回了指着的那份内容：${reading.summary}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("foreignValue is the one table: ESC neutralised, length bounded, honest about the cut", async () => {
  const { foreignValue } = await import("../dist/update-state.js");
  assert.equal(foreignValue("up-to-date"), "up-to-date", "惰性正文不许被无谓地改写");
  assert.ok(!foreignValue(`${esc}[2Jx`).includes(esc), "ESC 必须被中和");
  const long = "Z".repeat(1000);
  const cut = foreignValue(long, 40);
  assert.ok(cut.length < 120, `截断后仍然 1000 字符：${cut.length}`);
  assert.match(cut, /\(960 more characters not shown\)/, `截断要说实话：${cut}`);
});

test("a directory at the state path is named as not a regular file (the fstat judgement, not a guess)", () => {
  const dir = root("dirleaf");
  try {
    fs.mkdirSync(path.join(dir, "update-state.json"), { mode: 0o700 });
    const reading = readUpdateState({ [STATE_DIR_ENV]: dir });
    assert.equal(reading.kind, "unreadable");
    assert.match(reading.summary, /not a regular file/, reading.summary);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
