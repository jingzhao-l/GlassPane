// 闸脚本必须可以被安全 import（2026-11-03）。
//
// WHY：`scripts/check-doc-links.mjs` 与 `scripts/check-workflows.mjs` 的 CLI 段此前有部分跑在
// 模块顶层。import 它们的测试文件（`updater/test/daily-20261030-gate-handoff.test.mjs`、
// `scripts-check-doc-links.test.mjs`、`scripts-daily-20261020.test.mjs` 等 12 份）于是拿到的不是
// 导出而是那道闸自己的结论：宿主 argv 带 `--self-test` 时打出闸的电池并 `process.exit(0)`，
// 带 `--help` 时打出用法并退 0，带任意不认识参数时**退 2 把宿主整个带走**——三种情况下一份写了
// 若干用例的文件都以零条用例的身份通过。这一条判据在 `check-doc-links.mjs` 的注释里写了却没有
// 全覆盖，所以这里量的是"每一条 argv 形状都各自答话"，不是"有一次没崩"。
//
// 对照两头都要在：守卫若把 CLI 一起关掉，这道闸在 CI 里就变成什么都不检查还退 0——那是把
// "闸没运行"伪装成"闸通过了"。所以同一文件里也正向跑一遍真 CLI。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

/** 探针：只 import 目标模块，然后打一行"我还活着"。目标若在 import 时 exit，这行就不出。 */
const PROBE_SRC = `
const target = process.env.GP_TARGET;
const m = await import("file://" + target);
let extra = "";
if (typeof m.shellResidue === "function") {
  extra = " residue=" + m.shellResidue({ docs: ["engine/smoke.md"] }).length;
} else if (typeof m.inspect === "function" || typeof m.NO_RECEIVER !== "undefined") {
  extra = " exported=" + Object.keys(m).length;
}
console.log("SURVIVED keys=" + Object.keys(m).length + extra);
`;

const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), "gate-import-safety-"));
const PROBE = path.join(scratch, "probe.mjs");
writeFileSync(PROBE, PROBE_SRC);

/** 被 import 的那一侧：进程必须活着，且必须真的调用得到导出的判据。 */
function probeImports(moduleRel, hostArg) {
  const argv = [PROBE, ...(hostArg ? [hostArg] : [])];
  return spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180000,
    env: { ...process.env, GP_TARGET: path.join(ROOT, moduleRel) },
  });
}

/** 当作命令执行的那一侧：CLI 的每一条出口都必须照旧答话。 */
function runAsCommand(moduleRel, args) {
  return spawnSync(process.execPath, [path.join(ROOT, moduleRel), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300000,
  });
}

const HOST_ARGS = [null, "--self-test", "--help", "--gp-sentinel-unknown-arg"];

// 只收"有导出、且真被别的文件 import"的脚本：没有导出的纯 CLI（check-version.mjs、
// assert-test-count.mjs、set-version.mjs）没人 import，顶层执行是它们的正常形态，不算缺陷。
const IMPORTED_MODULES = [
  "scripts/check-doc-links.mjs",
  "scripts/check-workflows.mjs",
  "scripts/make-release-archive.mjs",
  "scripts/version-sites.mjs",
  "scripts/assert-tag-ready.mjs",
  "scripts/assert-ci-green.mjs",
];

for (const rel of IMPORTED_MODULES) {
  for (const hostArg of HOST_ARGS) {
    const label = hostArg ?? "<无参数>";
    test(`import 安全：${rel} 在宿主 argv=${label} 时不得接管宿主进程`, () => {
      const r = probeImports(rel, hostArg);
      const out = (r.stdout || "").trim();
      const err = (r.stderr || "").trim().split("\n")[0] || "";
      // 判决用的是"SURVIVED 这一行有没有打出来"，不是退出码：退 0 而没打这行＝被
      // `process.exit(0)` 带走（假绿），退 2 而没打这行＝宿主被杀（真红但原因不属那份测试）。
      assert.match(
        out,
        /^SURVIVED keys=\d+/m,
        `${rel} 在 argv=${label} 时接管了宿主：rc=${r.status} stdout=${out.slice(0, 120)} stderr=${err.slice(0, 160)}`,
      );
      assert.equal(r.status, 0, `${rel} argv=${label}：活着但退出码不是 0（rc=${r.status}）`);
      const keys = Number(/keys=(\d+)/.exec(out)[1]);
      assert.ok(keys > 0, `${rel} 没有任何导出可被 import（keys=0）——那份 import 是假的`);
    });
  }
}

test("import 安全：导出的判据函数在 import 之后仍然算得出答案，不是只挂在命名空间上", () => {
  const r = probeImports("scripts/check-doc-links.mjs", null);
  const m = /residue=(\d+)/.exec((r.stdout || "").trim());
  assert.ok(m, `探针没能调用 shellResidue：stdout=${JSON.stringify(r.stdout)}`);
  // 真仓库此刻是干净的（残渣为 0）——这一句同时是"闸没被守卫关掉"的旁证：
  // 函数被守卫连带删掉时这里拿到的是 undefined，上一条 assert.ok 就先红。
  assert.equal(m[1], "0", `engine/smoke.md 读出了 ${m[1]} 条残渣`);
});

test("反向对照：探针确实看得见一次接管（否则上面那 24 条是零断言的绿）", () => {
  // 一份合成模块：import 时按宿主 argv 决定 exit(0)。探针必须报"没活着"。
  const hijackDir = path.join(scratch, "hijack");
  mkdirSync(hijackDir, { recursive: true });
  writeFileSync(
    path.join(hijackDir, "gate.mjs"),
    `export const SOMETHING = 1;\nif (process.argv.includes("--help")) { console.log("usage printed by the gate"); process.exit(0); }\n`,
  );
  const r = spawnSync(process.execPath, [PROBE, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, GP_TARGET: path.join(hijackDir, "gate.mjs") },
  });
  assert.doesNotMatch((r.stdout || "").trim(), /SURVIVED/, "合成劫持模块没能被探针抓到——上面那些用例判的是空气");
  assert.match(r.stdout || "", /usage printed by the gate/, "合成模块的 exit(0) 没被执行，这一档对照组不成立");
});

test("守卫没把闸关掉：check-doc-links 作为命令执行时四条出口各自答话", () => {
  const self = runAsCommand("scripts/check-doc-links.mjs", ["--self-test"]);
  assert.equal(self.status, 0, `--self-test rc=${self.status}：${(self.stderr || "").slice(0, 300)}`);
  assert.match(self.stdout, /case\(s\) each verified to fail/, `--self-test 没报电池读数：${self.stdout.slice(0, 200)}`);

  const help = runAsCommand("scripts/check-doc-links.mjs", ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: node scripts\/check-doc-links\.mjs/, "作为命令执行时 --help 必须还给用法");

  const bogus = runAsCommand("scripts/check-doc-links.mjs", ["--gp-sentinel-unknown-arg"]);
  assert.equal(bogus.status, 2, "作为命令执行时不认识的参数必须退 2（守卫不许把这个也关掉）");
  assert.match(bogus.stderr, /不认识的参数/);

  const real = runAsCommand("scripts/check-doc-links.mjs", []);
  assert.equal(real.status, 0, `真仓库的文档闸红了：${(real.stderr || "").slice(0, 400)}`);
  assert.match(real.stdout, /文档 \d+ 份/, "作为命令执行时主体检查必须真的跑完并打读数");
});

test("守卫没把闸关掉：check-workflows 作为命令执行时三条出口各自答话", () => {
  const self = runAsCommand("scripts/check-workflows.mjs", ["--self-test"]);
  assert.equal(self.status, 0, `--self-test rc=${self.status}：${(self.stderr || "").slice(0, 300)}`);
  assert.match(self.stdout, /48 case\(s\) each verified to fail|case\(s\) each verified to fail/);

  const jobs = runAsCommand("scripts/check-workflows.mjs", ["--jobs"]);
  assert.equal(jobs.status, 0, `--jobs rc=${jobs.status}`);
  const rows = JSON.parse(jobs.stdout.trim());
  assert.ok(Array.isArray(rows) && rows.length > 0, "--jobs 交回空集合");

  const bogus = runAsCommand("scripts/check-workflows.mjs", ["--gp-sentinel-unknown-arg"]);
  assert.equal(bogus.status, 2, "作为命令执行时不认识的参数必须退 2");
  assert.match(bogus.stderr, /unknown argument/);

  const real = runAsCommand("scripts/check-workflows.mjs", []);
  assert.equal(real.status, 0, `真仓库的 workflow 闸红了：${(real.stderr || "").slice(0, 400)}`);
  assert.match(real.stdout, /workflow file\(s\) clean/);
});

test("import 之后 NO_RECEIVER 仍可取（那条 import 就是本轮抓出来的真实受害者形状）", () => {
  const probeSrc = `
const m = await import("file://" + process.env.GP_TARGET);
console.log("NO_RECEIVER=" + (typeof m.NO_RECEIVER));
`;
  const f = path.join(scratch, "probe-no-receiver.mjs");
  writeFileSync(f, probeSrc);
  const r = spawnSync(process.execPath, [f], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, GP_TARGET: path.join(ROOT, "scripts/check-workflows.mjs") },
  });
  assert.equal(r.status, 0, `取 NO_RECEIVER 时被接管：rc=${r.status} stderr=${(r.stderr || "").slice(0, 200)}`);
  assert.match(r.stdout, /NO_RECEIVER=string/, `check-workflows 不再导出 NO_RECEIVER：${r.stdout.trim()}`);
});
