/**
 * The two one-key entry points must give one answer to one command line.
 *
 * `install.sh` and `node installer/cli.js` are the two doors this product ships through, and this
 * repo has fixed the "same argv, two answers" shape repeatedly (S7-2, S7-3 on 2026-10-29). The 2026-10-31
 * round closed the three that were still open, all of them measured on this machine **before** the fix:
 *
 *  1. `--repo <一个存在的非仓库目录>`（以及 `GLASSPANE_REPO=<同一个>`）：cli.js 只测 `fs.existsSync`，
 *     没过 `looksLikeRepoHere`，于是真的把那个目录当项目根——`npm install` 以它为 cwd 跑起来（读数：
 *     `NPM-STUB cwd=/private/var/tmp/…/notrepo args=install`），一路撞到 `swift` 才回 1。同一串输入
 *     install.sh 回 1 且"本轮没有 clone、没有写入任何东西"。"先写再拒"违背本仓的规矩（能拒绝的守卫要在
 *     第一字节之前拒），两条入口对同一串 argv 也必须同判：现在都回 1，判据两行逐字节同一句话。
 *  2. 用法错与 `--help` 同时出现时的**一条规则**（写在 install.sh 的 2c' 与 installer/cli.js 的入口注释里）：
 *     `--repo` 没接到取值、或接到的那一枚以 `-` 开头（单双横线都算）——"这一层自己就说不通"的用法错，
 *     **先赢**，两条入口都退 2 并说同一句；"未知参数"只有 installer 的旗标清单才判得出来，而 install.sh
 *     没有那份清单（抄一份就是下一处没人对照的孪生抄本），所以那一档**让位**给 `--help`：两条入口都退 0
 *     打各自那一页。改之前的实测读数：`--help --repo` sh=0/cli=2、`--help --no-such-flag` sh=0/cli=2、
 *     `--repo -x` sh=1（当坏目录拒）而 cli.js 把 `-x` 当一个目录收下继续跑。
 *     `--repo -x` 这一档现在是**能测的**（本轮之前它要走进 tag 验签与构建，实测约 2 分钟；parseArgs 现在
 *     在第一个字节之前就把旗标形状的取值退回 2，矩阵里那一格跑的是毫秒）。
 *  3. cli.js 的 `--help` 退出码表必须覆盖这个文件真能产出的每一个码（这一条从前只点名 1 的三条支路里的
 *     一条，按 rc 分叉的调用方把"什么都没构建就停下"读成"跑过但没成"）。
 *
 * 测不了的那一格，点名在这里（不是静默跳过）：`--no-such-flag` **不带 --help** 时两入口的**句子**在
 * 非 macOS 上对不上——install.sh 回 1 说的是它自己那句"本安装器只支持 macOS（uname -s = …）"，cli.js 回 1
 * 说的是 platformRefusal 那句"这个产品只支持 macOS（本机 platform 不是 darwin）"，两句从来不是同一份文案；
 * 退出码仍然逐值相等（都是 1），所以这里在 darwin 上比句子、在非 darwin 上只比码。补那一句需要同意的命令：
 * `docker run --rm --platform linux/amd64 node:22 sh -c 'cd /repo && sh install.sh --no-such-flag; echo $?'`
 * ——它要先把两条入口的平台拒绝文案钉成同一份（那是文案改动，本轮没做），否则这一格在 Linux 上只能比码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { entryDecision, install, locatedRootRefusal, parseArgs } from "../cli.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const IS_DARWIN = process.platform === "darwin";

/** 一次性沙箱：`bin/` 里是记录调用的 npm/swift/open 桩（让 cli.js 的环境预检在任何主机上都能过，
 *  而不必真跑 npm），`home/` 是子进程的 HOME（拒绝路径必须让它保持空），`notrepo/` 是一个**存在的
 *  非仓库目录**，`cli-cwd/` 是给 cli.js 的非仓库 cwd（仓库里跑 cli.js 会让自动查找命中 $PWD）。 */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gp-entry-parity-"));
  const stub = path.join(root, "bin");
  const calls = path.join(root, "calls.log");
  fs.mkdirSync(stub, { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.mkdirSync(path.join(root, "cli-cwd"), { recursive: true });
  const notrepo = path.join(root, "notrepo");
  fs.mkdirSync(notrepo, { recursive: true });
  fs.writeFileSync(path.join(notrepo, "package.json"), '{"name":"gp-notrepo","version":"1.0.0"}\n');
  // npm/swift/open 桩：`--version` 答得像个安装过的工具（预检要读它），其余调用**记录后立刻返回**。
  // 记录本身就是证据：拒绝路径要是走偏了，npm 会以那个目录为 cwd 出现在这份 log 里。
  for (const [name, versionLine] of [["npm", "9.9.0"], ["swift", "swift version 5.9"], ["open", ""]]) {
    const p = path.join(stub, name);
    fs.writeFileSync(p, [
      "#!/bin/sh",
      `printf '%s cwd=%s args=%s\\n' "STUB-${name}" "$(pwd)" "$*" >> ${JSON.stringify(calls)}`,
      `case "$1" in --version) printf '%s\\n' ${JSON.stringify(versionLine)}; exit 0;; esac`,
      "exit 0",
      "",
    ].join("\n"), { mode: 0o755 });
  }
  return {
    root,
    notrepo,
    home: path.join(root, "home"),
    cwd: path.join(root, "cli-cwd"),
    path: `${stub}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    calls,
    npmCalls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : ""),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function installSh(argv, { cwd = REPO, env = {} } = {}) {
  const res = spawnSync("/bin/sh", [path.join(REPO, "install.sh"), ...argv], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH, ...env },
  });
  return { rc: res.status, text: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function installerCli(argv, { cwd = REPO, env = {} } = {}) {
  const res = spawnSync(process.execPath, [path.join(REPO, "installer", "cli.js"), ...argv], {
    cwd, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH, ...env },
  });
  return { rc: res.status, text: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/* ------------------------------------------------------------------ (1) 用法错矩阵 */

/** 每一格：这一串 argv 在两入口该回几、该出现哪一句（`both` 用 `m` 锚定行首，因为两入口的正文
 *  都把那句话顶格印）。`--help` 单独一格的 0 是既有契约（CI 的 install-gate 与两份 README 读的
 *  就是那一页），本轮没有为了对齐把它改成非 0。 */
const MATRIX = [
  { name: "单独的 --help", argv: ["--help"], rc: 0, both: [/用法/] },
  { name: "单独的 -h", argv: ["-h"], rc: 0, both: [/用法/] },
  {
    name: "--repo 吞下 --help（取值是旗标形 ⇒ 用法错先赢）",
    argv: ["--repo", "--help"],
    rc: 2,
    both: [/^参数错误：--repo 需要一个目录参数（收到的是旗标：--help）$/m],
  },
  {
    name: "--repo 吞下旗标、后面还有 --help（位置不许改变答案）",
    argv: ["--repo", "--no-prompt", "--help"],
    rc: 2,
    both: [/^参数错误：--repo 需要一个目录参数（收到的是旗标：--no-prompt）$/m],
  },
  {
    name: "--help + 尾部裸 --repo（取值缺）",
    argv: ["--help", "--repo"],
    rc: 2,
    both: [/^参数错误：--repo 需要一个目录参数（后面没有取值）$/m],
  },
  {
    name: "--help + 未知旗标（未知参数让位给 --help）",
    argv: ["--help", "--no-such-flag"],
    rc: 0,
    both: [/退出码/],
    absent: [/^参数错误：/m],
  },
  {
    name: "--help + --repo -x（单横线旗标形取值）",
    argv: ["--help", "--repo", "-x"],
    rc: 2,
    both: [/^参数错误：--repo 需要一个目录参数（收到的是旗标：-x）$/m],
  },
  {
    name: "--repo -x（本轮之前 cli.js 把 -x 当目录收下继续跑）",
    argv: ["--repo", "-x"],
    rc: 2,
    both: [/^参数错误：--repo 需要一个目录参数（收到的是旗标：-x）$/m],
  },
  {
    name: "尾部裸 --repo（没有 --help）",
    argv: ["--repo"],
    rc: 2,
    both: [/^参数错误：--repo 需要一个目录参数（后面没有取值）$/m],
  },
  {
    name: "--repo 后面是 -（一枚裸连字符也是旗标形状）",
    argv: ["--repo", "-"],
    rc: 2,
    both: [/^参数错误：--repo 需要一个目录参数（收到的是旗标：-）$/m],
  },
];

test("用法错矩阵：--help × {取值缺、未知旗标、单横线旗标形取值、尾部裸 --repo} 两入口逐格同码同句", () => {
  for (const cell of MATRIX) {
    const sh = installSh(cell.argv);
    const cli = installerCli(cell.argv, { cwd: makeCliCwd() });
    const line = `${cell.name}｜argv=${JSON.stringify(cell.argv)}`;
    assert.equal(cli.rc, cell.rc, `cli.js ${line} 应回 ${cell.rc}，实得 ${cli.rc}：${cli.text.slice(0, 300)}`);
    assert.equal(sh.rc, cell.rc, `install.sh ${line} 应回 ${cell.rc}，实得 ${sh.rc}：${sh.text.slice(0, 300)}`);
    assert.equal(sh.rc, cli.rc, `同一串 argv 两条入口两个码（install.sh=${sh.rc} / cli.js=${cli.rc}）：${line}`);
    for (const re of cell.both) {
      assert.match(sh.text, re, `install.sh 少了那一句 ${re}：${line}｜${sh.text.slice(0, 300)}`);
      assert.match(cli.text, re, `cli.js 少了那一句 ${re}：${line}｜${cli.text.slice(0, 300)}`);
    }
    for (const re of cell.absent ?? []) {
      assert.doesNotMatch(sh.text, re, `install.sh 不该说这一句 ${re}：${line}`);
      assert.doesNotMatch(cli.text, re, `cli.js 不该说这一句 ${re}：${line}`);
    }
    // 用法错与帮助页同时到达：退 2 的那几格必须也打出"这一页"，否则按 rc 分叉的调用方读到了码
    // 却读不到该改哪里。
    if (cell.rc === 2) {
      assert.match(sh.text, /用法/, `install.sh 的用法错后面要跟着 usage：${line}`);
      assert.match(cli.text, /用法/, `cli.js 的用法错后面要跟着 usage：${line}`);
    }
  }
});

/** cli.js 那一头不需要真仓库 cwd：给它一枚临时空目录，免得"自动向上查找"把外层仓库当答案。
 *  每次调用新建，用完交给进程退出清理（矩阵里十格都用同一枚就够了，所以只做一次）。 */
let cliCwdCache = null;
function makeCliCwd() {
  if (cliCwdCache === null) {
    cliCwdCache = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gp-parity-cli-cwd-"));
    process.on("exit", () => fs.rmSync(cliCwdCache, { recursive: true, force: true }));
  }
  return cliCwdCache;
}

/* --------------------------------------------------------- (2) 判据闸：坏目录同码同句零写入 */

/** 两入口**逐字节相同**的那四行（改一头的文案另一头立刻红）。`安装失败：` 是 cli.js 的 catch 前缀，
 *  所以第一行不按行首锚定。 */
function refusalLines(label, dir, ref) {
  return [
    `${label} 给了这个目录，而它不合判据：${dir}`,
    "  判据（两条都要在，与 looks_like_repo 同一份）：目录要存在；目录里要同时有 engine/Package.swift 与 mcp-shell/package.json。",
    "本轮没有 clone、没有写入任何东西。",
    `下一步：${label} 指一棵真的仓库（上面两条判据都在），或去掉 ${label} 让它 clone 一份（ref: ${ref}）。`,
  ];
}

const PIN_REF = (GLASSPANE_RELEASE_READ())
function GLASSPANE_RELEASE_READ() {
  const sh = fs.readFileSync(path.join(REPO, "install.sh"), "utf8").match(/^GLASSPANE_RELEASE="([^"]+)"/m);
  assert.ok(sh, "install.sh 里的发布锚点行没读到，这一格的 ref 就没有对照物");
  return sh[1];
}

for (const kind of ["--repo", "GLASSPANE_REPO"]) {
  for (const shape of ["exists-not-repo", "does-not-exist"]) {
    test(`判据闸 ${kind}=${shape}：两入口同码（1）、同句（逐字节四行）、拒绝路径零写入`, () => {
      const fx = makeSandbox();
      try {
        const dir = shape === "exists-not-repo" ? fx.notrepo : path.join(fx.root, "never-created");
        const argv = kind === "--repo" ? [kind, dir] : [];
        const env = kind === "--repo"
          ? { PATH: fx.path, HOME: fx.home, GLASSPANE_REPO: "", GLASSPANE_INSTALL_DIR: path.join(fx.root, "never-cloned") }
          : { PATH: fx.path, HOME: fx.home, GLASSPANE_REPO: dir };
        const sh = installSh(argv, { cwd: REPO, env: { ...env, GLASSPANE_INSTALL_DRY_RUN: "1" } });
        const cli = installSh === null ? null : installerCli(argv, { cwd: fx.cwd, env });
        const lines = refusalLines(kind, dir, PIN_REF);
        assert.equal(sh.rc, 1, `install.sh ${kind}=${dir} 应回 1，实得 ${sh.rc}：${sh.text.slice(0, 400)}`);
        assert.equal(cli.rc, sh.rc, `同一串输入两条入口两个码（install.sh=${sh.rc} / cli.js=${cli.rc}）：${sh.text.slice(0, 200)}`);
        for (const line of lines) {
          assert.ok(sh.text.includes(line), `install.sh 少了这一行（逐字节对照）：[${line}]\n实得：${sh.text.slice(0, 500)}`);
          assert.ok(cli.text.includes(line), `cli.js 少了这一行（逐字节对照）：[${line}]\n实得：${cli.text.slice(0, 500)}`);
        }
        const missing = shape === "exists-not-repo"
          ? "  现在缺的是：engine/Package.swift、mcp-shell/package.json 不在"
          : "  现在缺的是：目录不存在";
        for (const entry of [sh, cli]) {
          assert.ok(entry.text.includes(missing), `两条判据之外还要点名**现在缺的是哪一条**：${missing}\n实得：${entry.text.slice(0, 500)}`);
        }
        // 零写入的三处落点：指定目录里不长 node_modules、家目录里不长 .glasspane、npm 从未以那个目录
        // 为 cwd 被调用（这一条就是本轮修掉的那句"先写再拒"）。
        assert.equal(fs.existsSync(path.join(dir, "node_modules")), false, "被拒的目录里不该长出 node_modules");
        assert.equal(fs.existsSync(path.join(fx.home, ".glasspane")), false, "拒绝路径不该建过日志/ socket 目录");
        assert.doesNotMatch(fx.npmCalls(), new RegExp(`cwd=${escapeRe(dir)}\\b`), `npm 不该以被拒的目录为 cwd 跑过：${fx.npmCalls()}`);
        assert.doesNotMatch(sh.text, /将执行: node |exec node/, "被拒的定位位不许出现在委托行里");
      } finally {
        fx.cleanup();
      }
    });
  }
}

test("判据闸的正向对照：一棵真的仓库交给 --repo 时两条入口都不说\"不合判据\"", () => {
  const fx = makeSandbox();
  try {
    const sh = installSh(["--repo", REPO], {
      cwd: fx.cwd,
      env: { PATH: fx.path, HOME: fx.home, GLASSPANE_REPO: "", GLASSPANE_INSTALL_DRY_RUN: "1" },
    });
    assert.equal(sh.rc, 0, `真仓库该放行到计划行，实得 ${sh.rc}：${sh.text.slice(0, 400)}`);
    assert.match(sh.text, /使用 --repo 指定的仓库/, sh.text.slice(0, 400));
    assert.doesNotMatch(sh.text, /不合判据/, "闸不是\"永远拒\"：合判据的树要走过去");
    // cli.js 那一头同样要放行——它接着会去跑构建，所以这里只看那句拒绝有没有出现（前缀 argv 让它
    // 停在预检之后的第一件事上）。
    const refusal = locatedRootRefusal({ label: "--repo", dir: REPO, ref: PIN_REF });
    assert.equal(refusal, null, `looksLikeRepoHere 通过时闸必须让路，实得：${String(refusal).slice(0, 200)}`);
  } finally {
    fx.cleanup();
  }
});

test("闸排在 install() 的第一个写入之前（进程内，任何主机都可判）", async () => {
  const fx = makeSandbox();
  try {
    for (const [label, options, env] of [
      ["--repo", parseArgs(["--repo", fx.notrepo]).options, { HOME: fx.home, GLASSPANE_REPO: "" }],
      ["GLASSPANE_REPO", parseArgs([]).options, { HOME: fx.home, GLASSPANE_REPO: fx.notrepo }],
    ]) {
      await assert.rejects(
        () => install({ options, env, uid: 501 }),
        (error) => {
          const text = String(error.message);
          for (const line of refusalLines(label, path.resolve(fx.notrepo), PIN_REF)) {
            assert.ok(text.includes(line), `${label} 那一支少了这一行：[${line}]\n实得：${text.slice(0, 500)}`);
          }
          return true;
        },
        `${label} 指的坏目录必须在 install() 里被拒，而不是留给后面的步骤去撞`,
      );
      assert.equal(fs.existsSync(path.join(fx.home, ".glasspane")), false, "抛错之前没有 mkdir 过日志目录（ensureLogDir 排在闸之后）");
      assert.deepEqual(fs.readdirSync(fx.notrepo), ["package.json"], "被拒的目录里一个字节都不该多出来");
    }
  } finally {
    fx.cleanup();
  }
});

/* --------------------------------------------------------------- (3) 退出码表覆盖 */

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
  // 2 那一格现在还要说清它与 --help 相遇时谁赢——两入口的规则只有写在这页上才读者拿得到。
  const two = help.split("\n").filter((l) => /^  2 /.test(l)
    || (/^     /.test(l) && help.split("\n").indexOf(l) > help.split("\n").findIndex((x) => /^  2 /.test(x))
      && help.split("\n").indexOf(l) < help.split("\n").findIndex((x) => /^  跨二进制的用法错对照/.test(x))))
    .join("\n");
  assert.match(two, /先赢/, "退出码 2 那一格要点名\"哪两类用法错先于 --help\"");
  assert.match(two, /让位/, "退出码 2 那一格要点名\"未知参数让位给 --help\"");
});

test("非 macOS 上两入口的**码**仍然同答（句子在不同主机上不同，见文件头那一格）", () => {
  // platformRefusal 读的是 process.platform，桩不掉；这一格在本机（darwin）走的是"未知参数 → 2"，
  // 在 Linux runner 上两入口都回 1（各自的平台拒绝）。两种情形下要闸的都是同一件事：**码不能分叉**。
  const argv = ["--no-such-flag"];
  const fx = makeSandbox();
  try {
    const sh = installSh(argv, {
      cwd: REPO,
      env: { PATH: fx.path, HOME: fx.home, GLASSPANE_REPO: "", GLASSPANE_INSTALL_DIR: path.join(fx.root, "never-cloned") },
    });
    const cli = installerCli(argv, { cwd: fx.cwd, env: { PATH: fx.path, HOME: fx.home, GLASSPANE_REPO: "" } });
    assert.equal(sh.rc, cli.rc, `未知参数的退出码在两入口上分叉了（install.sh=${sh.rc} / cli.js=${cli.rc}）：\n${sh.text}\n${cli.text}`);
    if (IS_DARWIN) {
      assert.equal(sh.rc, 2, `本机是 darwin，这一格该走到 installer 的 2，实得 ${sh.rc}：${sh.text.slice(0, 300)}`);
      const sentence = /^参数错误：未知参数：--no-such-flag（--help 查看用法）$/m;
      assert.match(sh.text, sentence, `install.sh 透传之后要带着 installer 那句：${sh.text.slice(0, 300)}`);
      assert.match(cli.text, sentence, cli.text.slice(0, 300));
    } else {
      assert.equal(sh.rc, 1, `非 darwin：两入口都该停在平台拒绝（1），实得 install.sh=${sh.rc} / cli.js=${cli.rc}`);
    }
    assert.doesNotMatch(fx.npmCalls(), /cwd=/, "这一格一个 npm 都不该起");
  } finally {
    fx.cleanup();
  }
});

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ *
 * 入口次序的整表（2026-10-31）。
 *
 * 这一格必须能在**任一台**主机上跑完：CI 的两条 lane 各是一种平台，而上一轮就是把
 * "未知参数在非 darwin 上该由谁答"写在 `if (isMain)` 的链里——本机（darwin）永远走不到
 * 那一档，于是 Linux runner 现形：同一串 `--no-such-flag`，install.sh 回 1、cli.js 回 2。
 * `entryDecision` 把那条次序抽成纯函数之后，整张矩阵在本机就能跑满，包括那台跑不到的。
 * ------------------------------------------------------------------ */

const baseOptions = { repoDir: null, help: false, restoreLaunchd: false, prompt: false };

test("入口次序整表：非 darwin 那一档在两种主机上都是同一个答案", () => {
  const notRepoDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gp-entry-order-"));
  const env = { PATH: process.env.PATH };
  try {
    const cases = [
      // argv, 期望的 kind 与码（darwin / 非 darwin 两列）
      [["--help"], ["help", 0], ["help", 0]],
      [["--no-such-flag"], ["usage-error", 2], ["platform", 1]],
      [["--repo"], ["usage-error", 2], ["usage-error", 2]],
      [["--repo", "--help"], ["usage-error", 2], ["usage-error", 2]],
      // 显式定位位交的目录不合判据：**与主机无关**，两列必须同码同 kind
      [["--repo", notRepoDir], ["located-root", 1], ["located-root", 1]],
      [[], ["install", 0], ["platform", 1]],
      [["--restore-launchd"], ["restore-launchd", 0], ["restore-launchd", 0]],
    ];
    for (const [argv, darwin, other] of cases) {
      const { options, error, errorKind } = parseArgs(argv);
      for (const [platform, expected] of [["darwin", darwin], ["linux", other]]) {
        const d = entryDecision({ options, error, errorKind, platform, env });
        assert.equal(d.kind, expected[0],
          `argv=${JSON.stringify(argv)} 在 ${platform} 上判成 ${d.kind}，期望 ${expected[0]}`);
        assert.equal(d.exitCode, expected[1],
          `argv=${JSON.stringify(argv)} 在 ${platform} 上的退出码是 ${d.exitCode}，期望 ${expected[1]}`);
      }
    }
    // 判据自己也得会咬人：--repo 的判据若被排到平台判据**之后**，Linux 那一列就会分叉。
    const flipped = entryDecision({
      options: { ...baseOptions, repoDir: notRepoDir }, error: null, errorKind: null,
      platform: "linux", env,
    });
    assert.equal(flipped.kind, "located-root",
      "显式定位位的判据不再是平台判据的前身——两条入口在 Linux 上会重新分叉");
  } finally {
    fs.rmSync(notRepoDir, { recursive: true, force: true });
  }
});
