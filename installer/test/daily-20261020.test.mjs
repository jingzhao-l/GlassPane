import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { preflightIssues, usageText } from '../cli.js';
import { installLandingAudit, INSTALL_LANDING_HANDOFF, installLandingProblems } from '../../scripts/check-doc-links.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const INSTALL_SH = path.join(REPO, 'install.sh');

function stubBin(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gp-stub-${name}-`));
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

// MARK: - 一键入口的退出码：文档不再承诺一条管道给不出的结论

test('curl | sh reports success when curl itself failed, which is why the usage says so', (t) => {
  const hasCurl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).status === 0;
  if (!hasCurl) return t.skip('这台机器没有 curl，测不出这条形状');
  // 端口 1 上没有监听：curl 立刻失败。`sh` 从管道读到 EOF，于是**整条管道退 0**。
  // 这就是从前 `--help` 里那句"curl | sh 的 $? 就是这里的结论"错的地方——它把一次
  // 什么都没装的运行报成成功，而读 $? 的正是不在场的 agent 与 CI。
  const piped = spawnSync('/bin/sh', ['-c', 'curl -fsSL http://127.0.0.1:1/nope.sh | sh; echo "rc=$?"'], {
    encoding: 'utf8', timeout: 30_000,
  });
  const curlRc = spawnSync('/bin/sh', ['-c', 'curl -fsSL http://127.0.0.1:1/nope.sh >/dev/null 2>&1; echo "rc=$?"'], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.match(curlRc.stdout, /rc=[^0]/, `curl 自己必须是失败的：${curlRc.stdout}`);
  assert.match(piped.stdout, /rc=0\b/, `管道整体退 0 正是这条主张不成立的实测形状：${piped.stdout}`);

  const usage = usageText();
  assert.doesNotMatch(usage, /\$\? 就是这里的结论/, 'usage 不许再承诺一条管道给不出的结论');
  // 钉的是**判据**，不是那个 `/tmp` 名字（S10-7，2026-10-29）。这一句从前把"两步写法"与"落在
  // world-writable 目录里一个所有人都猜得到的名字上"一起写成了契约：`/private/tmp` 是 1777，
  // sticky 只挡住别人删你的文件，挡不住他先建一个 `/tmp/gp-install.sh -> ~/.bashrc`——`curl -o`
  // 跟随符号链接并以调用者的 uid 截断覆写目标（本机实测过：预先占住那个名字的符号链接之后，
  // 受害者文件的内容就变成了下载物的内容）。今天留住的契约是"分步、能拿到退出码"这一半；
  assert.match(usage, /-o \S+ && sh \S+/, 'usage 给的那条能拿到真实退出码的两步写法不见了');
  assert.match(usage, /空输入|EOF/, '并且说清为什么管道会退 0');
  // 落点这一半交给 `scripts/check-doc-links.mjs` 的同一条判据统一量，且 installer/cli.js 已在
  // **判红**集合里（INSTALL_LANDING_ENFORCED，2026-10-29 从移交清单并过来）：这里不再接受
  // "有人宣布了就行"，而是要求这份文件读不出任何一条 world-writable 固定落点。
  const cliLanding = installLandingAudit({ rootDir: REPO, files: ['installer/cli.js'] });
  assert.deepEqual(cliLanding.unsafe, [],
    `installer/cli.js 的 usage 还在把安装脚本落在 ${cliLanding.unsafe.map((e) => `${e.landing}:${e.line}`).join(', ')}（world-writable 目录的固定名字）`);
  assert.match(usage, /mktemp/, 'usage 给出的那条两步命令要自己说得出落点来源');
  // 同一条判据对 README 那一侧是真判红：本泳道写得动的文件没有第二条路。
  assert.deepEqual(installLandingProblems({ rootDir: REPO }), [], '对外文档里还有一条 world-writable 固定落点');
});

// MARK: - 平台闸排在 clone 之前

test('install.sh refuses a non-macOS host before the clone, and says so in a dry-run too', () => {
  const stub = stubBin('uname', 'echo Linux');
  const wouldClone = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-nondarwin-'));
  // 平台闸住在"定位不到源码 ⇒ 必须 clone"那一支：已经有源码的那一趟不付 clone，也就没得挡。
  //
  // 两条隔离位是 2026-10-22 补的，之前**没有**：`cwd` 缺省是仓库根，于是
  // `looks_like_repo "$PWD"` 命中，脚本走"源码在手边"那一支，一路 `exec node cli.js`，
  // 而 `HOME` 继承的是开发者真家目录——npm ci、tsc（重写 mcp-shell/dist）、swift build 与
  // launchd 注册全部真的发生。一条会改机器状态的测试必须先自证它改的是沙箱。
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-nondarwin-home-'));
  const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-nondarwin-cwd-'));
  const env = {
    ...process.env,
    PATH: `${stub}:${process.env.PATH}`,
    HOME: sandboxHome,
    GLASSPANE_REPO: '',
    GLASSPANE_INSTALL_DIR: path.join(wouldClone, 'glasspane'),
  };
  try {
    const real = spawnSync('/bin/sh', [INSTALL_SH], {
      env: { ...env, GLASSPANE_INSTALL_DRY_RUN: '0' }, encoding: 'utf8', timeout: 60_000, cwd: emptyCwd, input: '',
    });
    assert.equal(real.status, 1, `${real.stdout}\n${real.stderr}`);
    assert.match(real.stderr, /只支持 macOS（uname -s = Linux）/, real.stderr);
    assert.match(real.stderr, /没有 clone、没有写入任何东西/, real.stderr);
    assert.deepEqual(fs.readdirSync(wouldClone), [], '被拒的那一趟不许在 clone 目录里留下任何东西');

    const dry = spawnSync('/bin/sh', [INSTALL_SH], {
      env: { ...env, GLASSPANE_INSTALL_DRY_RUN: '1' }, encoding: 'utf8', timeout: 60_000, cwd: emptyCwd, input: '',
    });
    assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
    assert.match(dry.stdout, /平台闸会在 clone 之前停/, dry.stdout);
    assert.match(dry.stdout, /\[dry-run\] 未定位到仓库，将执行: git clone/, `clone 计划行不许因为平台闸而消失：${dry.stdout}`);
    // 沙箱家目录必须还是空的：这条测试从前跑到开发者真家目录里去过，那一次留下了
    // 一个装好的 .app 与一个在跑的 daemon。"没有写任何东西"这句要由读者自己量出来。
    assert.deepEqual(fs.readdirSync(sandboxHome), [], `真跑那一趟在沙箱 HOME 里留下了东西：${fs.readdirSync(sandboxHome).join(', ')}`);
    assert.deepEqual(fs.readdirSync(emptyCwd), [], `被拒的那一趟在当前目录里留下了东西：${fs.readdirSync(emptyCwd).join(', ')}`);
  } finally {
    fs.rmSync(stub, { recursive: true, force: true });
    fs.rmSync(wouldClone, { recursive: true, force: true });
    fs.rmSync(sandboxHome, { recursive: true, force: true });
    fs.rmSync(emptyCwd, { recursive: true, force: true });
  }
  // 对照：一台 Darwin 主机上这一条必须放行到"clone 目标已存在"那一支，而不是被平台闸挡下——
  // 否则那扇闸只是永远拒绝。这里自己造一枚 Darwin 的 `uname`，不靠环境：同一份测试要能在
  // ubuntu 的 CI 上跑到同一支（那一格整格外层还套着 test/support/darwin-host.mjs 的桩）。
  const darwin = stubBin('uname', 'echo Darwin');
  const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-darwin-ctl-'));
  const ctlHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-darwin-ctl-home-'));
  try {
    const ok = spawnSync('/bin/sh', [INSTALL_SH], {
      env: {
        ...process.env, PATH: `${darwin}:${process.env.PATH}`, HOME: ctlHome,
        GLASSPANE_INSTALL_DRY_RUN: '0', GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: existing,
      },
      encoding: 'utf8', timeout: 60_000, cwd: os.tmpdir(), input: '',
    });
    assert.doesNotMatch(`${ok.stdout}${ok.stderr}`, /只支持 macOS/, `${ok.stdout}\n${ok.stderr}`);
    assert.match(`${ok.stdout}${ok.stderr}`, /目标目录已存在且不是 GlassPane 仓库/, `${ok.stdout}\n${ok.stderr}`);
    assert.equal(ok.status, 1, '走到"目标已存在"那一支必须是拒（这台机器上它确实存在且非空）');
  } finally {
    fs.rmSync(darwin, { recursive: true, force: true });
    fs.rmSync(existing, { recursive: true, force: true });
    fs.rmSync(ctlHome, { recursive: true, force: true });
  }
});

// MARK: - 预检每一行都说得出下一步；对外文案不漏内部标识

test('every preflight refusal names an action, not only the missing thing', () => {
  const nothingWorks = preflightIssues({
    nodeMajor: 0, nodeOk: false, npm: false, swift: false, git: false, open: false,
  });
  assert.equal(nothingWorks.length, 5, JSON.stringify(nothingWorks));
  for (const line of nothingWorks) {
    assert.match(line, /brew|xcode-select|nvm|macOS 14/, `这一行只说了缺什么，没说该怎么办：${line}`);
  }
  // Node 够格但太旧时是另一条句子（版本号在里面），同样要给得出动作。
  const tooOld = preflightIssues({
    nodeMajor: 16, nodeOk: false, npm: true, swift: true, git: true, open: true,
  });
  assert.equal(tooOld.length, 1, JSON.stringify(tooOld));
  assert.match(tooOld[0], /brew upgrade node|nvm use/, tooOld[0]);
  // 对照：够格的机器一行都不该有，否则这些句子永远在屏幕上。
  assert.deepEqual(preflightIssues({
    nodeMajor: 22, nodeOk: true, npm: true, swift: true, git: true, open: true,
  }), []);
});

test('the guided next steps do not leak the internal identifier into user-facing text', () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'cli.js'), 'utf8');
  assert.doesNotMatch(source, /entryName 核对/, '对外文案里不该出现变量名');
  assert.match(source, /主体名核对/, '换成读的人认得的词');
});

