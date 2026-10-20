import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { preflightIssues, usageText } from '../cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = path.join(HERE, '..', '..', 'install.sh');

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
  assert.match(usage, /-o \/tmp\/gp-install\.sh && sh \/tmp\/gp-install\.sh/,
    '它要给的是那条真的能拿到结论的写法');
  assert.match(usage, /空输入|EOF/, '并且说清为什么管道会退 0');
});

// MARK: - 平台闸排在 clone 之前

test('install.sh refuses a non-macOS host before paying for the clone', () => {
  const stub = stubBin('uname', 'echo Linux');
  try {
    const got = spawnSync('/bin/sh', [INSTALL_SH], {
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, GLASSPANE_INSTALL_DRY_RUN: '1' },
      encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(got.status, 1, `${got.stdout}\n${got.stderr}`);
    assert.match(got.stderr, /只支持 macOS（uname -s = Linux）/, got.stderr);
    assert.match(got.stderr, /没有 clone、没有写入任何东西/, got.stderr);
  } finally {
    fs.rmSync(stub, { recursive: true, force: true });
  }
  // 对照：本机（Darwin）这一条必须放行，否则那扇闸只是永远拒绝。
  const ok = spawnSync('/bin/sh', [INSTALL_SH], {
    env: { ...process.env, GLASSPANE_INSTALL_DRY_RUN: '1', GLASSPANE_REPO: path.join(HERE, '..', '..') },
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
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

