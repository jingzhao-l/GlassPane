import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { judgeTagReady, tagShapeOk } from '../../scripts/assert-tag-ready.mjs';
import { inertExclusions, trackedEntries, EXCLUDED_PREFIXES } from '../../scripts/make-release-archive.mjs';
import { check as checkDocs, markdownTableProblems, DOCS } from '../../scripts/check-doc-links.mjs';
import { judgeAnchor, judgeStagedAnchor, readAnchor, recordAnchor, releaseSigningFingerprint, trustFilePath } from '../lib/trust.js';
import { PINNED_PRIMARY_FINGERPRINT } from '../lib/signature.js';
import { CODES } from '../lib/codes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gp-${label}-`));
  fs.chmodSync(dir, 0o700);
  return dir;
}

const greenRun = [{ id: 1, status: 'completed', conclusion: 'success', created_at: '2026-10-20T01:00:00Z', html_url: 'https://x/1' }];

// MARK: - 打 tag 之前的那道闸：不许再造一枚发不出去的锚点

test('assert-tag-ready refuses every shape that produced the dangling v1.17.0', () => {
  const base = { version: '1.18.0', headSha: SHA, originMainSha: SHA, existingTags: [], ciPayload: { workflow_runs: greenRun } };
  assert.equal(judgeTagReady(base).ok, true, judgeTagReady(base).reason);

  // ① tag 已经存在：绝不覆盖（install.sh 与 updater 钉的就是它）。
  const taken = judgeTagReady({ ...base, existingTags: ['v1.18.0'] });
  assert.equal(taken.ok, false);
  assert.match(taken.reason, /已经存在/, taken.reason);
  assert.match(taken.reason, /取下一个号/, '话术要给出那一条走得通的路', taken.reason);

  // ② HEAD 不是 main 的 tip：tag 指到没被 CI 跑过的提交上。
  const off = judgeTagReady({ ...base, originMainSha: 'c'.repeat(40) });
  assert.equal(off.ok, false);
  assert.match(off.reason, /不是 origin\/main/, off.reason);

  // ③ 本地没推：origin/main 读不出来。
  const unpushed = judgeTagReady({ ...base, originMainSha: '' });
  assert.equal(unpushed.ok, false);
  assert.match(unpushed.reason, /origin\/main 读不出来/, unpushed.reason);

  // ④ CI 红：正是 v1.17.0 撞上的那一格。
  const red = judgeTagReady({
    ...base,
    ciPayload: { workflow_runs: [{ id: 2, status: 'completed', conclusion: 'failure', created_at: '2026-10-20T02:00:00Z', html_url: 'https://x/2' }] },
  });
  assert.equal(red.ok, false);
  assert.match(red.reason, /不是绿的/, red.reason);
  assert.equal(red.run.id, 2, '拒绝要点名是哪一条 run，否则下一轮只能重新猜');

  // ⑤ 还在跑：等，不当成绿。
  const pending = judgeTagReady({ ...base, ciPayload: { workflow_runs: [{ id: 3, status: 'in_progress', created_at: '2026-10-20T03:00:00Z' }] } });
  assert.equal(pending.ok, false);
  assert.equal(pending.pending, true);

  // ⑥ 一条记录都没有 = 没有证据。
  const none = judgeTagReady({ ...base, ciPayload: { workflow_runs: [] } });
  assert.equal(none.ok, false);
  assert.match(none.reason, /没有任何运行记录/, none.reason);

  // 形状闸：`v` 拼错与四位版本都拒。
  assert.equal(tagShapeOk('1.18'), false);
  assert.equal(tagShapeOk('1.18.0'), true);
  assert.equal(judgeTagReady({ ...base, version: '1.18' }).ok, false);
});

test('assert-tag-ready as a process refuses to guess the repository', () => {
  const got = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'assert-tag-ready.mjs'), '9.9.9'], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
  });
  // 没有 --repository 就问不到 CI。"问不到"必须是 2，不能悄悄退 0。
  assert.equal(got.status, 2, `${got.stdout}\n${got.stderr}`);
  assert.match(got.stderr, /无法问 CI/, got.stderr);
});

// MARK: - 排除表用空了：发布拒，而不是安静地长大

test('an exclusion prefix that landed on nothing is inert, and the shipped list must not be', () => {
  assert.deepEqual(inertExclusions(['harness/', '.iterate_decisions.md']), []);
  assert.deepEqual(inertExclusions(['harness/'], ['harness/', '.iterate_decisions.md']), ['.iterate_decisions.md']);
  assert.deepEqual(inertExclusions([], EXCLUDED_PREFIXES), EXCLUDED_PREFIXES,
    '一条都没匹配上时，整张表都是惰性的——这正是 harness/ 改名之后的形状');
  // 对真树再核一遍：两条排除前缀都得有东西命中，否则发布这一步就红了。
  const names = trackedEntries({ root: ROOT }).map((entry) => entry.name);
  assert.ok(names.length > 1000, `真树的清单读出来只有 ${names.length} 条，这条闸已经看不见东西`);
  const matched = EXCLUDED_PREFIXES.filter((prefix) => names.some((name) => name.startsWith(prefix)));
  assert.deepEqual(inertExclusions(matched), [], `真实树里这些排除前缀一条都没命中：${JSON.stringify(inertExclusions(matched))}`);
});

// MARK: - 一份都没执行的日志不算绿

test('a second log that ran zero cases reddens the pooled count gate', () => {
  const dir = tempRoot('testcount');
  try {
    const real = path.join(dir, 'real.log');
    const empty = path.join(dir, 'empty.log');
    fs.writeFileSync(real, 'Test Suite \'All tests\' passed\n\t Executed 10 tests, with 0 failures (0 unexpected)\n✔ Test run with 2 tests in 1 suite passed\n');
    fs.writeFileSync(empty, 'Building for debugging...\nBuild complete!\n');
    const script = path.join(ROOT, 'scripts', 'assert-test-count.mjs');
    const pooled = spawnSync(process.execPath, [script, 'engine', '1', real, empty], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(pooled.status, 1, `${pooled.stdout}\n${pooled.stderr}`);
    assert.match(pooled.stderr, /一条用例都没执行/, pooled.stderr);
    assert.match(pooled.stderr, /empty\.log/, '必须点名是哪一份日志空了');
    // 对照：只有那份真日志时同样过——否则这条判据只是永远拒绝。
    const alone = spawnSync(process.execPath, [script, 'engine', '1', real], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(alone.status, 0, `${alone.stdout}\n${alone.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MARK: - 登记过却不在磁盘上的文档不是"不归它管"

test('a registered document that is gone is a problem, and zero documents cannot be OK', () => {
  const dir = tempRoot('docmissing');
  try {
    fs.writeFileSync(path.join(dir, 'present.md'), '# present\n');
    const onlyMissing = checkDocs({ rootDir: dir, docs: ['missing.md'] });
    assert.ok(onlyMissing.problems.some((p) => /登记在 DOCS 里但磁盘上没有/.test(p)),
      JSON.stringify(onlyMissing.problems));
    assert.ok(onlyMissing.problems.some((p) => /什么都量不到/.test(p)),
      '一份文档都没在磁盘上时，汇总行必须红，不许打 `文档 0 份 … OK`');
    const both = checkDocs({ rootDir: dir, docs: ['present.md', 'gone.md'] });
    assert.ok(both.problems.some((p) => /gone\.md/.test(p)), JSON.stringify(both.problems));
    // 对照：真实仓库这一趟必须干净，否则上面两条只是把闸改成永远红。
    const real = checkDocs();
    assert.deepEqual(real.problems, [], `main 上的文档闸不该红：${JSON.stringify(real.problems)}`);
    assert.ok(DOCS.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MARK: - 表格形状：渲染时才错的那类缺陷
//
// 下面六条都打在 `check-doc-links.mjs` 的 `markdownTableProblems` 上。这条规则的存在理由是本轮
// 在自己的台账里中招两处、回扫全仓又抓到 13 行，而死链/锚点/双语/主张四道判据对此全都无感。

test('an unescaped pipe inside a table cell is a problem, and the escaped one is not', () => {
  const dir = tempRoot('mdtable');
  const write = (rel, body) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  try {
    const bad = '| # | 判据 | 处置 |\n|---|---|---|\n| A | 或值 `x || y` 被放过 | 已修 |\n';
    write('bad.md', bad);
    const p = markdownTableProblems({ rootDir: dir }).problems.filter((s) => s.includes('bad.md'));
    assert.equal(p.length, 1, JSON.stringify(p));
    assert.match(p[0], /bad\.md:3/, '要报得出行号，否则读者只能自己数');
    assert.match(p[0], /5 格而表头是 3 格/, p[0]);
    // 对照：同一张表把格内竖线转义之后必须完全沉默，否则这条规则只是永远红。
    write('bad.md', bad.replace('`x || y`', '`x \\|\\| y`'));
    assert.deepEqual(markdownTableProblems({ rootDir: dir }).problems, [], '转义过的形状必须放行');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a table with no separator row is not a table to the renderer, and that is reported', () => {
  const dir = tempRoot('mdsep');
  try {
    fs.writeFileSync(path.join(dir, 'nosep.md'), '| a | b |\n| 1 | 2 |\n');
    const out = markdownTableProblems({ rootDir: dir }).problems;
    assert.equal(out.length, 1, JSON.stringify(out));
    assert.match(out[0], /没有竖线分隔行/, out[0]);
    // 对照：孤零零一行 `|a|b|` 不是表格，不该红。
    fs.rmSync(path.join(dir, 'nosep.md'));
    fs.writeFileSync(path.join(dir, 'lone.md'), '| a | b |\n正文继续说话\n');
    assert.deepEqual(markdownTableProblems({ rootDir: dir }).problems, [], '单行不判，否则任何竖线开头的正文都是假红');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a separator row whose cell count disagrees with the header is its own problem', () => {
  const dir = tempRoot('mdsepcount');
  try {
    fs.writeFileSync(path.join(dir, 'x.md'), '| a | b | c |\n|---|---|\n| 1 | 2 | 3 |\n');
    const out = markdownTableProblems({ rootDir: dir }).problems;
    assert.equal(out.length, 1, JSON.stringify(out));
    assert.match(out[0], /分隔行是 2 格，表头是 3 格/, out[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an ASCII table inside a code fence is content, not a table', () => {
  // 这一条是"误红的闸会被放宽"的防线：围栏里的对齐图常按内容补空格，行与行格数本来就不同。
  const dir = tempRoot('mdfence');
  try {
    fs.writeFileSync(path.join(dir, 'f.md'), '```\n| 左 | 右 |\n| 很长的一段 | x |\n| a | b | c |\n```\n');
    const r = markdownTableProblems({ rootDir: dir });
    assert.deepEqual(r.problems, [], JSON.stringify(r.problems));
    assert.equal(r.tables, 0, '围栏里的段数不该被数进表格总数');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a row that opens with a pipe but never closes it is reported', () => {
  const dir = tempRoot('mdtrunc');
  try {
    fs.writeFileSync(path.join(dir, 't.md'), '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4\n');
    const out = markdownTableProblems({ rootDir: dir }).problems;
    assert.ok(out.some((s) => /不以竖线结尾/.test(s)), JSON.stringify(out));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the repository as shipped has every table row agree, and the gate counts them', () => {
  const { problems, tables, files } = markdownTableProblems({ rootDir: ROOT });
  assert.deepEqual(problems, [], `main 上不该有坏表格：${JSON.stringify(problems.slice(0, 5))}`);
  // 两个分母都要有读者：零张表 / 极少文件意味着扫描没走到任何地方（路径规则变了，或 SKIP 名单
  // 吞掉了全仓），那是一种"永远绿"的假绿。
  assert.ok(files > 100, `只走到 ${files} 份 markdown：本仓自己的文档就有 110+ 份`);
  assert.ok(tables > 200, `只数到 ${tables} 张表格：这条闸的红与绿全靠它有覆盖面`);
});

test('the vendored fork package tree is out of scope, and the rest of the tree is not', () => {
  // 跳过 `harness/glasspane-harness/packages/**` 是一次**范围决定**，不是一句注释：上游 bump
  // 不该能红在本仓的闸上（那种红的唯一修法是放宽本闸）。所以两侧都要能测出来——
  // 只测"外面的被抓"会放过一个把整仓都跳过去了的实现，只测"里面的沉默"会放过一个永不判的实现。
  const dir = tempRoot('mdscope');
  const broken = '| a | b |\n|---|---|\n| 1 | 2 | 3 |\n';
  try {
    const vendored = 'harness/glasspane-harness/packages/opencode/docs/x.md';
    const ours = 'harness/glasspane-harness/docs/y.md';
    for (const rel of [vendored, ours]) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, broken);
    }
    const r = markdownTableProblems({ rootDir: dir });
    assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
    assert.match(r.problems[0], /^harness\/glasspane-harness\/docs\/y\.md:3/, r.problems[0]);
    assert.ok(!r.problems.some((s) => s.includes('packages/')), 'vendored 树里的坏表格被判红了：范围决定失效');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MARK: - 签名锚点住在发布物写不到的地方

test('the anchor compares the staged release against what this machine recorded', () => {
  const absent = judgeAnchor({ anchor: { state: 'absent', file: '/x/trust.json' }, stagedFingerprint: SHA });
  assert.equal(absent.ok, true);
  assert.equal(absent.establishing, true, '没有锚点时是"这一次建立"，不是"这一次通过"');

  const match = judgeAnchor({ anchor: { state: 'present', file: '/x/trust.json', fingerprint: SHA.toUpperCase() }, stagedFingerprint: SHA.toLowerCase() });
  assert.equal(match.ok, true, '大小写不同也是同一枚指纹');

  const swapped = judgeAnchor({ anchor: { state: 'present', file: '/x/trust.json', fingerprint: SHA.toUpperCase() }, stagedFingerprint: OTHER });
  assert.equal(swapped.ok, false);
  assert.match(swapped.reason, /edit that one file's anchorFingerprint/, swapped.reason);
  assert.match(swapped.reason, /Nothing was built, packed, swapped or restarted/, '拒绝必须说清什么都没动');

  const unreadable = judgeAnchor({ anchor: { state: 'unreadable', file: '/x/trust.json', reason: 'not readable JSON' }, stagedFingerprint: SHA });
  assert.equal(unreadable.ok, false, '"读不出锚点"不许折成"锚点对上了"');

  const silent = judgeAnchor({ anchor: { state: 'present', file: '/x/trust.json', fingerprint: SHA }, stagedFingerprint: null });
  assert.equal(silent.ok, false, '发布物读不出自己的 pin 时不能默认通过');
});

test('the staged fingerprint is read as text from the shape signature.js really has', () => {
  const dir = tempRoot('pin-tree');
  try {
    const file = path.join(dir, 'updater', 'lib', 'signature.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `export const PINNED_PRIMARY_FINGERPRINT = '${OTHER}'\n`);
    const read = releaseSigningFingerprint(dir);
    assert.equal(read.ok, true);
    assert.equal(read.fingerprint, OTHER.toUpperCase(), '锚点比较用的是规范化后的大写形态');

    fs.writeFileSync(file, 'export const PINNED_PRIMARY_FINGERPRINT = undefined\n');
    const gone = releaseSigningFingerprint(dir);
    assert.equal(gone.ok, false, '声明被改掉时必须有话说，而不是回一个 null 让人当"没变化"');

    fs.rmSync(file);
    assert.equal(releaseSigningFingerprint(dir).ok, false, '文件不在也是拒，不是通过');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the anchor file is this machine\'s own record: 0600, exclusive, and never overwritten quietly', () => {
  const dir = tempRoot('anchor');
  try {
    assert.equal(recordAnchor(dir, 'not-a-fingerprint').ok, false, '非 40 位十六进制不配当锚点');
    const first = recordAnchor(dir, SHA);
    assert.equal(first.ok, true, JSON.stringify(first));
    const mode = fs.statSync(trustFilePath(dir)).mode & 0o777;
    assert.equal(mode, 0o600, '锚点里说的是谁签了这份软件，不该是同用户谁都能读的一张名片');
    assert.deepEqual(JSON.parse(fs.readFileSync(trustFilePath(dir), 'utf8')).anchorFingerprint, SHA.toUpperCase());
    assert.equal(readAnchor(dir).fingerprint, SHA.toUpperCase());

    const conflict = recordAnchor(dir, OTHER);
    assert.equal(conflict.ok, false, '已有锚点时换钥匙是一次决定，不是某次运行顺手改写的事');
    assert.match(conflict.reason, /say which one is meant/, conflict.reason);
    assert.equal(recordAnchor(dir, SHA).unchanged, true, '同一枚钥匙重复登记不许报错');
    assert.equal(readAnchor(dir).state, 'present');

    fs.writeFileSync(trustFilePath(dir), 'not json at all');
    assert.equal(readAnchor(dir).state, 'unreadable', '坏文件不许被读成 absent（那等于悄悄关掉这道闸）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the anchor question is answered over two real directories, the way apply asks it', () => {
  const state = tempRoot('anchor-state');
  const tree = tempRoot('anchor-tree');
  try {
    const write = (rel, text) => {
      const file = path.join(tree, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    const pinLine = (fp) => `export const PINNED_PRIMARY_FINGERPRINT = '${fp}'\n`;

    // 没有锚点：这一次是建立，不是通过。
    const establishing = judgeStagedAnchor({ stateRoot: state, treeRoot: tree });
    assert.equal(establishing.ok, true, JSON.stringify(establishing));
    assert.equal(establishing.anchor.state, 'absent');

    // 锚点记的是这台机器正在运行的那份代码的钥匙；暂存树带同一枚 → 放行。
    recordAnchor(state, SHA);
    write('updater/lib/signature.js', pinLine(SHA));
    assert.equal(judgeStagedAnchor({ stateRoot: state, treeRoot: tree }).ok, true,
      '对照：同一枚钥匙必须过，否则这道闸只会永远拒绝');

    // 另一把钥匙签的发布：拒，并点名两枚指纹。
    write('updater/lib/signature.js', pinLine(OTHER));
    const refused = judgeStagedAnchor({ stateRoot: state, treeRoot: tree });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /a different signing key/, refused.reason);
    assert.equal(refused.anchor.fingerprint, SHA.toUpperCase());
    assert.equal(refused.staged, OTHER.toUpperCase());

    // 树里那一行被改掉：也是拒，不是"没变化"。
    write('updater/lib/signature.js', 'export const PINNED_PRIMARY_FINGERPRINT = undefined\n');
    assert.equal(judgeStagedAnchor({ stateRoot: state, treeRoot: tree }).ok, false);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test('the refusal is the one apply reaches before anything can change the machine', () => {
  const body = fs.readFileSync(path.join(ROOT, 'updater', 'lib', 'apply.js'), 'utf8');
  const gate = body.indexOf('judgeStagedAnchor({ stateRoot, treeRoot: provenTree })');
  const refusal = body.indexOf("return fail('deferred', CODES.signatureAnchorChanged");
  const commit = body.lastIndexOf('const saved = stampOnto(base, {');
  assert.ok(gate > 0, 'apply 只问这一个函数；它不许在别处重新拼一遍判据');
  assert.ok(refusal > gate, '判据先算，拒绝后落');
  assert.ok(refusal < commit, '拒绝必须发生在把这一版记成 applied 之前');
  assert.ok(body.includes('recordAnchor(stateRoot, PINNED_PRIMARY_FINGERPRINT)'),
    '第一次建立锚点用的是正在运行的这份代码自己的 pin，不是刚下载的那份');
  assert.equal(CODES.signatureAnchorChanged, 'signature-anchor-changed');
});
