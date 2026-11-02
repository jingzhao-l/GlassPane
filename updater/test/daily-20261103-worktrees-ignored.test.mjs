/**
 * `.worktrees/` must be invisible to git, not merely invisible to one gate.
 *
 * 缺陷（本轮 2026-11-03 实测发现）：`scripts/check-doc-links.mjs:1074` 的 `MD_SKIP_DIRS` 早就
 * 把 `.worktrees` 当成"不是仓库内容"排除了——那份排除的理由写在它上面的注释里（同一棵 main 的树
 * 不该因为旁边有没有工作树而给出不同读数）。但 `.gitignore` 里没有对应的一条，于是本仓自己的
 * 流程第 4 条（"改用隔离工作树做本轮改动与提交"）每建一棵树，就在仓库根留下
 * 一行 `?? .worktrees/`，让收口硬条件"`git status --porcelain` 为空"在字面上不可满足。
 * 这是同一形状的第二种半修：A 面（文档闸）知道它不是仓库内容，B 面（git 的忽略表）不知道。
 *
 * 这里的判据全部走真命令：真的建一个目录、真的问 `git status`、真的问 `git check-ignore`。
 * 三条测试互相咬住：忽略成立（1）、判据不空转——同一枚探针换个位置就必须被看见（2）、
 * 两面同答（3）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function git(args) {
  const res = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  return { rc: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** 整树未追踪项（`-uall` 展开到文件级），只取路径那一列。 */
function untrackedPaths() {
  const { rc, out } = git(["status", "--porcelain", "--untracked-files=all"]);
  assert.equal(rc, 0, `git status 必须答得出，实际 rc=${rc}：${out}`);
  return out
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim());
}

test("`.worktrees/` 下的内容不进 `git status`——建一棵真目录，问 git 看不看得见", () => {
  const probe = path.join(REPO, ".worktrees", "gp-ignore-probe-20261103");
  fs.mkdirSync(probe, { recursive: true });
  try {
    fs.writeFileSync(path.join(probe, "readme.md"), "# 探针\n");
    const ignored = git(["check-ignore", "-q", "--", ".worktrees/gp-ignore-probe-20261103/readme.md"]);
    assert.equal(ignored.rc, 0, ".worktrees/ 里的文件必须被 git 忽略（check-ignore rc=0）");
    const seen = untrackedPaths().filter((p) => p.startsWith(".worktrees/"));
    assert.deepEqual(seen, [], `仓库根的 status 不该数到工作树里的东西，实际看到：${seen.join(", ")}`);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
});

test("判据不空转：同一枚探针放在仓库根就必须被 status 看见", () => {
  // 上一条断言"看不见"，这一条证明"看不见"是因为规则在起作用，而不是因为 status 根本不会
  // 报告未追踪文件（那会让上一条恒绿）。
  const probe = path.join(REPO, ".worktrees-probe-20261103");
  fs.mkdirSync(probe, { recursive: true });
  try {
    fs.writeFileSync(path.join(probe, "readme.md"), "# 探针\n");
    const ignored = git(["check-ignore", "-q", "--", ".worktrees-probe-20261103/readme.md"]);
    assert.notEqual(ignored.rc, 0, "这枚探针不该被忽略——它被忽略说明上一条测试其实在空转");
    const seen = untrackedPaths().filter((p) => p.startsWith(".worktrees-probe-20261103/"));
    assert.ok(seen.length > 0, "未被忽略的探针必须出现在 status 里，否则本条测试证明不了任何事");
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
});

test("两面同答：文档闸排除 .worktrees 的那条规则，git 的忽略表里也得有", () => {
  const gate = fs.readFileSync(path.join(REPO, "scripts", "check-doc-links.mjs"), "utf8");
  const skipLine = /const MD_SKIP_DIRS = new Set\(\[([^\]]*)\]\)/.exec(gate);
  assert.ok(skipLine, "MD_SKIP_DIRS 的形状变了——重读这条对照，别把它删掉");
  const gateExcludesWorktrees = /['"]\.worktrees['"]/.test(skipLine[1]);
  const gitignore = fs.readFileSync(path.join(REPO, ".gitignore"), "utf8");
  const gitExcludesWorktrees = /^\/?\.worktrees\/?$/m.test(gitignore);
  assert.equal(
    gitExcludesWorktrees,
    gateExcludesWorktrees,
    `文档闸排除 .worktrees=${gateExcludesWorktrees} 而 .gitignore 排除=${gitExcludesWorktrees}：一面排除、另一面数它，就是半修`,
  );
  assert.ok(gitExcludesWorktrees, ".gitignore 必须真的包含 .worktrees 这一条（两面都得排除，不是两面都数）");
});
