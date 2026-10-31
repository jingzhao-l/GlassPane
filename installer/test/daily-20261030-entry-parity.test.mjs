/**
 * The two one-key entry points must give one answer to one command line.
 *
 * `install.sh` and `node installer/cli.js` are the two doors this product ships through, and this
 * repo has fixed the "same argv, two answers" shape repeatedly (S7-2, S7-3 on 2026-10-29). Two
 * open ends remained, both measured here:
 *
 *  1. `--repo --help`: cli.js refuses a flag-shaped value (`--repo 需要一个目录参数`, rc 2) while
 *     install.sh swallowed the flag as a directory, failed `looks_like_repo`, and answered rc 1
 *     with a shape lecture — while its own comment claimed the two entries "对同一串 argv 给出同一个
 *     结论". The new 2c' gate answers rc 2. Its **position** is the other half of the fix: the
 *     first version put it after the usage gate, and `--repo --no-prompt --help` then diverged the
 *     same way (install.sh rc 0, cli.js rc 2) — measured, not theorised.
 *  2. cli.js reaches exit 1 from three places; its `--help` table named one of them. A caller that
 *     branches on rc read "1 = it ran and failed" for a run that never built anything (platform
 *     refusal, environment preflight). The table now names all three, and this file pins that the
 *     table covers exactly the set of exit codes the file can produce — so a fourth `exitCode = 4`
 *     added tomorrow cannot hide.
 *
 * Only fast argv shapes are driven here. `--repo -x` makes cli.js walk into signature verification
 * (measured: ~2 minutes), which is install.sh's business to refuse and would only slow the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function installSh(argv) {
  const res = spawnSync("/bin/sh", [path.join(REPO, "install.sh"), ...argv], {
    cwd: REPO, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH },
  });
  return { rc: res.status, text: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function installerCli(argv) {
  const res = spawnSync(process.execPath, [path.join(REPO, "installer", "cli.js"), ...argv], {
    cwd: REPO, encoding: "utf8",
  });
  return { rc: res.status, text: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

test("--repo 吞下一面旗标：两条一键入口对同一串 argv 给同一个退出码和同一句话", () => {
  for (const argv of [["--repo", "--help"], ["--repo", "--no-prompt", "--help"]]) {
    const sh = installSh(argv);
    const cli = installerCli(argv);
    assert.equal(sh.rc, 2, `install.sh ${argv.join(" ")} → rc ${sh.rc}：${sh.text.slice(0, 200)}`);
    assert.equal(cli.rc, sh.rc,
      `同一串 argv 两条入口两个码（install.sh=${sh.rc} / cli.js=${cli.rc}）：${argv.join(" ")}`);
    assert.match(sh.text, /需要一个目录参数/,
      `install.sh 那句必须与 cli.js 同一说法（cli.js: ${cli.text.slice(0, 120)}）：${sh.text.slice(0, 200)}`);
    assert.match(cli.text, /需要一个目录参数/, cli.text.slice(0, 200));
  }
});

test("--help 仍然两条入口都退 0（这次对齐不许把帮助本身打回用法错）", () => {
  const sh = installSh(["--help"]);
  const cli = installerCli(["--help"]);
  assert.equal(sh.rc, 0, sh.text.slice(0, 200));
  assert.equal(cli.rc, 0, cli.text.slice(0, 200));
  assert.match(sh.text, /GLASSPANE_INSTALL_DRY_RUN|一键安装/);
});

test("--repo 的真路径坏目录仍按 looks_like_repo 拒（旗标闸不许把这一档吃掉）", () => {
  const notRepo = fs.mkdtempSync("/var/tmp/gp-notrepo-");
  try {
    const sh = installSh(["--repo", notRepo]);
    assert.equal(sh.rc, 1, sh.text.slice(0, 300));
    assert.match(sh.text, /不合判据/, `坏目录仍要说的是判据那一句：${sh.text.slice(0, 200)}`);
    assert.ok(!fs.existsSync(path.join(notRepo, "node_modules")), "本轮不该在指定目录里动手");
  } finally {
    fs.rmSync(notRepo, { recursive: true, force: true });
  }
});

test("退出码表覆盖 installer/cli.js 真能产出的每一个码", () => {
  const source = fs.readFileSync(path.join(REPO, "installer", "cli.js"), "utf8");
  const produced = new Set(
    [...source.matchAll(/process\.exitCode\s*=\s*(\d+)/g)].map((m) => m[1]),
  );
  assert.ok(produced.size >= 3, `源码里只读到 ${produced.size} 个退出码赋值——这条判据看不见东西了`);
  const help = installerCli(["--help"]).text;
  for (const code of [...produced].sort()) {
    const line = help.split("\n").find((l) => new RegExp(`^  ${code} `).test(l));
    assert.ok(line, `--help 的退出码表没有 ${code} 那一格（源码能产出它）`);
  }
  // 1 那一格必须自己点名两条"什么都没构建就停下"的支路，否则按 rc 分叉的调用方仍会把它读成
  // "跑过但没成"。
  const one = help.split("\n").filter((l, i, all) => /^  1 /.test(l)
    || (/^     /.test(l) && all.indexOf(l) > all.findIndex((x) => /^  1 /.test(x))
      && all.indexOf(l) < all.findIndex((x) => /^  2 /.test(x))));
  const joined = one.join("\n");
  assert.match(joined, /platformRefusal|平台拒绝/, "退出码 1 那一格必须点名平台拒绝");
  assert.match(joined, /环境预检/, "退出码 1 那一格必须点名环境预检");
});
