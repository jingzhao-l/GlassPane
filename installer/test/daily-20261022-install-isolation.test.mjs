/**
 * 2026-10-22 · "主机能不能装"这两道闸，与一条会改机器状态的测试。
 *
 * 造它的事由不是推想：本轮有泳道被允许跑 `node --test installer/test/daily-20261020.test.mjs`，
 * 那一格在仓库根跑，`HOME` 是开发者真家目录——`looks_like_repo "$PWD"` 命中"源码在手边"那一支，
 * 平台闸（从前只挡"要 clone 的那一趟"）根本不经过，脚本一路 `exec node cli.js`，于是
 * npm ci（走网络）、tsc（把 mcp-shell/dist 重写成非 bundle 形状）、swift build 与 launchd 注册
 * 全部真的发生，最后留下一个在跑的 `com.glasspane.daemon`。install.sh 里那句注释
 * "已经有源码的那一趟……交给 installer 自己去说平台"当时是空的：cli.js 里没有任何平台判据
 * （grep `process.platform` 命中 0）。
 *
 * 一条会改机器状态的测试不是测试；一道挡不住"源码在手边"那一支的平台闸也不是闸。
 * 这里的每一条都跑在沙箱 HOME 与沙箱 cwd 里，并且自己证明沙箱没被动过。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { platformRefusal } from '../cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = path.join(HERE, '..', '..', 'install.sh');

function scratch(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gp-${label}-`));
}

function stubBin(name, body) {
  const dir = scratch(`stub-${name}`);
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

/**
 * 一枚"看着就是仓库"的目录：`looks_like_repo` 要的两份文件都在，而 `installer/cli.js`
 * 是一枚只打印一个词的可执行桩。这样即使两道闸都失效，被委托的也是这枚桩，不是真安装器，
 * 开发者的机器不会被改，而测试仍然看得见"走没走到委托那一步"。
 */
function fakeRepo({ delegateMarker = null } = {}) {
  const root = scratch('fake-repo');
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true });
  fs.mkdirSync(path.join(root, 'mcp-shell'), { recursive: true });
  fs.mkdirSync(path.join(root, 'installer'), { recursive: true });
  fs.writeFileSync(path.join(root, 'engine', 'Package.swift'), '// fixture\n');
  fs.writeFileSync(path.join(root, 'mcp-shell', 'package.json'), '{ "name": "glasspane-mcp" }\n');
  fs.writeFileSync(
    path.join(root, 'installer', 'cli.js'),
    delegateMarker === null ? 'throw new Error("must not be reached")\n'
      : `console.log(${JSON.stringify(delegateMarker)})\n`,
    { mode: 0o755 },
  );
  return root;
}

// MARK: - 判据本身

test('the platform verdict is darwin-only, and it says what it did NOT do', () => {
  assert.equal(platformRefusal('darwin'), null, 'darwin 上是放行；把 macOS 也挡了的那道闸只是永远拒绝');
  for (const platform of ['linux', 'freebsd', 'win32', 'sunos']) {
    const refusal = platformRefusal(platform);
    assert.ok(refusal, `${platform} 必须被挡`);
    assert.match(refusal, /只支持 macOS/, refusal);
    assert.match(refusal, new RegExp(`platform 不是 darwin|本机 platform`), refusal);
    // 三条"没做"必须逐条说出来：读者要能在自己机器上确认这句是真的。
    for (const clause of ['没有跑 npm ci', '没有 swift build', '没有注册 launchd']) {
      assert.match(refusal, new RegExp(clause), `拒绝句里少了「${clause}」：${refusal}`);
    }
    assert.match(refusal, /没有可绕的旗标/, `不许留一条"加个旗标就装"的路：${refusal}`);
  }
});

// MARK: - install.sh：源码在手边那一支也归平台闸管

test('install.sh refuses a non-macOS host even when the source is already present', () => {
  const stub = stubBin('uname', 'echo Linux');
  const repo = fakeRepo({ delegateMarker: 'DELEGATED-TO-REAL-INSTALLER' });
  const home = scratch('home');
  try {
    const run = spawnSync('/bin/sh', [INSTALL_SH], {
      env: {
        ...process.env,
        PATH: `${stub}:${process.env.PATH}`,
        HOME: home,
        GLASSPANE_INSTALL_DRY_RUN: '0',
        GLASSPANE_REPO: repo,
        GLASSPANE_INSTALL_DIR: path.join(home, 'install-target'),
      },
      encoding: 'utf8', timeout: 60_000, cwd: repo, input: '',
    });
    const out = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 1, `非 darwin 且源码在手边时必须是拒：${out}`);
    assert.match(out, /只支持 macOS/, out);
    assert.doesNotMatch(out, /DELEGATED-TO-REAL-INSTALLER/,
      `委托真的发生了——平台闸又只挡 clone 那一支：${out}`);
    assert.deepEqual(fs.readdirSync(home), [],
      `拒绝的那一趟在沙箱 HOME 里留下了东西：${fs.readdirSync(home).join(', ')}`);
  } finally {
    for (const dir of [stub, repo, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('control: the same branch delegates on a darwin host, so the gate is not a blanket refusal', () => {
  const stub = stubBin('uname', 'echo Darwin');
  const repo = fakeRepo({ delegateMarker: 'DELEGATED-AS-EXPECTED' });
  const home = scratch('home');
  try {
    const run = spawnSync('/bin/sh', [INSTALL_SH], {
      env: {
        ...process.env,
        PATH: `${stub}:${process.env.PATH}`,
        HOME: home,
        GLASSPANE_INSTALL_DRY_RUN: '0',
        GLASSPANE_REPO: repo,
        GLASSPANE_INSTALL_DIR: path.join(home, 'install-target'),
      },
      encoding: 'utf8', timeout: 60_000, cwd: repo, input: '',
    });
    const out = `${run.stdout}${run.stderr}`;
    assert.match(out, /DELEGATED-AS-EXPECTED/,
      `darwin 主机上这一支必须走到委托，否则上面那条拒绝就是永远拒绝：${out}`);
    assert.doesNotMatch(out, /只支持 macOS/, out);
  } finally {
    for (const dir of [stub, repo, home]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MARK: - 判据必须在读者那一侧被执行

/**
 * 两道闸各钉一处形状：光有纯函数而不被调用＝没有护栏（本仓为同一件事写过
 * `testPanelGuardsEverySubmitSite`）。顺序也要钉：`exec node` 之前的那道才是护栏，
 * 之后的那道只是事后说明。
 */
/**
 * 位置类判据要在**剥掉注释**的源码上算。同目录的先例是本仓 `CaptureChannelShapeTests.codeOnly`
 * 与 `mcp-shell/test/http-gateway.test.mjs` 的 `gatewayCode()`，理由也一样：注释里出现被扫描的
 * 那个名字，判据就会红在一句说明上——而第一反应是删掉那句说明换绿，教训跟着没了。
 * 本文件 2026-10-22 那次红就是撞在这上面：`cli.js` 新增常量的文档注释里写着
 * "它同时是 `checkEnvironment()` 的探测面清单"，于是 `indexOf('checkEnvironment()')` 指到了
 * 注释上，"平台判据排在环境预检之前"这条判的是注释的位置。
 * 剩下的已知边界：行尾的 `// …` 不剥（整行才剥），所以一句挂在代码行尾的注释仍可能被读成代码。
 */
function jsCode(text) {
  let out = text
  while (true) {
    const open = out.indexOf('/*')
    if (open < 0) break
    const close = out.indexOf('*/', open + 2)
    if (close < 0) break
    out = out.slice(0, open) + out.slice(close + 2)
  }
  return out.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n')
}

function shCode(text) {
  return text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
}

test('both doors consult the platform verdict before anything can mutate the machine', () => {
  const script = shCode(fs.readFileSync(INSTALL_SH, 'utf8'));
  const execAt = script.indexOf('exec node "$REPO/installer/cli.js"');
  assert.ok(execAt > 0, 'install.sh 的委托行形状变了，这条对照不作数');
  const gateBeforeExec = script.lastIndexOf('本安装器只支持 macOS', execAt);
  assert.ok(gateBeforeExec > 0 && script.lastIndexOf('fail ', execAt) > gateBeforeExec - 200,
    '委托行之前找不到平台闸：那一支又回到"源码在手边就直接装"');
  assert.ok(gateBeforeExec > script.indexOf('looks_like_repo "$PWD"'),
    '平台闸必须排在源码定位之后、委托之前——它挡的就是"已经找到源码"的那一趟');

  const cli = jsCode(fs.readFileSync(path.join(HERE, '..', 'cli.js'), 'utf8'));
  // 2026-10-31：平台判据的调用点从入口那条链挪进了 `entryDecision`（那样 Linux 那一档才能在
  // 本机被整表验证）。判据没变——**它在环境预检之前**——所以这里认 `platformRefusal(` 的调用，
  // 不再要求它写在 `()` 那一形上。
  const refusalCall = cli.indexOf('platformRefusal(');
  assert.ok(refusalCall > 0, 'cli.js 没有调用它自己的平台判据');
  assert.ok(cli.indexOf('checkEnvironment()') > refusalCall,
    '平台判据排在环境预检之后：那一步之前谁都不许动机器');
  assert.ok(cli.indexOf('const env = checkEnvironment()') > refusalCall,
    '同上：真正读环境、随后要跑 npm ci 的那一行必须在拒绝之后');
});

// MARK: - 测试自己不许改机器

/**
 * 本轮那一次的根因也包括"测试继承了仓库根与真 HOME"。这里把这条规矩钉在文件上：
 * 任何 spawn install.sh 的 installer 测试都必须同时给 `HOME` 与 `cwd`，
 * 否则它就是在开发者机器上装东西。
 */
test('no installer test spawns install.sh for real with an inherited HOME or cwd', () => {
  const offenders = [];
  for (const name of fs.readdirSync(HERE).filter((n) => n.endsWith('.test.mjs'))) {
    if (name === 'daily-20261022-install-isolation.test.mjs') continue;
    const text = fs.readFileSync(path.join(HERE, name), 'utf8');
    for (const match of text.matchAll(/spawnSync\(\s*'\/bin\/sh'\s*,\s*\[INSTALL_SH/g)) {
      const window = text.slice(Math.max(0, match.index - 1000), match.index + 1000);
      // 只有"真跑"那一支需要隔离：dry-run 不 clone、不委托、不写盘（CI 的 install-gate 就靠它）。
      // 判据取就近的那一个 DRY_RUN 值；两个值都在窗口里时按真跑算（宁可多问一次）。
      const dry = /GLASSPANE_INSTALL_DRY_RUN:\s*'1'/.test(window)
        && !/GLASSPANE_INSTALL_DRY_RUN:\s*'0'/.test(window);
      if (dry) continue;
      if (!/HOME:\s*[A-Za-z_]/.test(window)) offenders.push(`${name}:非 dry-run 未换 HOME`);
      if (!/\bcwd:\s*[A-Za-z_]/.test(window)) offenders.push(`${name}:非 dry-run 未换 cwd`);
    }
  }
  assert.deepEqual(offenders, [],
    `这些格子会（或曾经能）在开发者机器上真装：${offenders.join('; ')}`);
});
