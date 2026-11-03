/**
 * 残渣闸（`shellResidue`）本轮的四条判据变化，与它们各自"能红"的证据。
 *
 * 背景：2026-10-31 那一轮往 `engine/smoke.md` 追加读数时，包装脚本自己的 9 行漏进正文，
 * 随 `v1.27.0` 与 `v1.28.0` 两份签名归档发出去了。那一轮的修法是"把 heredoc 标记从手抄名单
 * 改成形状"（`[A-Z][A-Z0-9_]{1,15}` 独立成行）。本轮复查量到那一修**仍是半修**：
 *
 * - ② 那半还是手抄词表（`echo|wc|printf|cat|sed|grep|ls|nohup|tar`）。把真残渣**删掉
 *   `XEOF` 那一行**喂进旧判据，报 **0 条**——剩下 8 行是 `node -e "`、`const fs=require("fs");`、
 *   `fs.writeFileSync(p, …);`、`console.log("appended");`、`"; git diff --numstat …`，
 *   没有一条以名单上的词开头。这条是本仓"名单永远少下一枚"形状的第四次。
 * - ① 的宽度 `{1,15}` 放过 `GLASSPANE_SMOKE_APPEND_END`（24 字符），只认独立成行放过
 *   `EOF; git diff …`（标记与语句同一行）。
 * - 围栏开/闭用的是布尔翻面 `/^\s*(?:```|~~~)/`，而同一文件里 `headingsOf` 用的是
 *   CommonMark（缩进 ≤3、同种字符、闭合不更短）——两个读者两套判据，注释却写着"共用一个式子"。
 *   布尔版的后果是**假绿**：一枚落在缩进代码块里的 ``` 会把整篇读成"在栏内"，正文余下部分
 *   一条都不再被判。
 * - 扫描集只有登记的 32 份，`specs/**`（每轮真正往正文里贴东西的地方）不在闸下，
 *   而同文件的 `markdownTableProblems` 却扫它。
 *
 * 每条都配正反两面：能红的具名用例，与"合法形状不许红"的对照。真语料零误红单独一条——
 * 放宽判据很容易，把 71 份文档（含不许改动的 specs/ 与 harness 线文档）量到零误红才是门槛。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { shellResidue, RESIDUE_DOCS, fenceAfter, proseOf } from '../../scripts/check-doc-links.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const RES = 'fs.writeFileSync(p, "x");\n'

function withDoc(body, fn) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-residue-'))
  try {
    fs.writeFileSync(path.join(root, 'x.md'), body)
    return fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const run = (body) => withDoc(body, (root) => shellResidue({ rootDir: root, docs: ['x.md'] }))

/* ------------------------------------------------------------------ ② 形状 */

test('②：真残渣删掉 heredoc 标记那一行之后，仍必须被抓到（旧手抄词表在这里报 0 条）', () => {
  const leaked = execFileSync('git', ['show', '9c41a7ae^:engine/smoke.md'], {
    cwd: REPO, encoding: 'utf8',
  }).split('\n').slice(1541).join('\n')
  const withoutMarker = leaked.split('\n').filter((l) => l.trim() !== 'XEOF').join('\n')
  const hits = withDoc(withoutMarker, (root) => shellResidue({ rootDir: root, docs: ['x.md'] }))
  assert.ok(hits.length >= 1, `2026-10-31 那 9 行去掉标记后旧判据一条都不报；新判据也必须至少报一条，实际 ${hits.length}`)
  assert.match(hits[0], /裸露的语句形状/, `报的不是残渣类问题：${hits[0]}`)
})

test('②：`node -e "` 起头的那一行本身就是一条语句形状，不依赖同行有别的词', () => {
  const hits = run(`正文：\n${RES}`)
  assert.equal(hits.length, 1, JSON.stringify(hits))
  assert.match(hits[0], /x\.md:2/)
})

test('②：散文里的等式与"提到一个函数"都不算残渣', () => {
  const legal = [
    'rc=0（"no changes"，149 installs / 163 packages）。',
    'GLASSPANE_CA_REEXEC=1',
    "runCommand('enable'|'disable')",
    'curl | bash',
    'ConsoleModel.daemonStatsRecovery(pathKnown:)',
  ]
  for (const line of legal) {
    const hits = run(`段落：\n\n${line}\n`)
    assert.deepEqual(hits, [], `合法正文形状被误红：${line} ⇒ ${JSON.stringify(hits)}`)
  }
})

test('②：markdown 表格的行归表格判据管，残渣闸不重复判', () => {
  const table = '| Requirement | Used for | Check |\n| --- | --- | --- |\n| macOS 14+ | the engine (accessibility / capture) |  |\n'
  assert.deepEqual(run(table), [], `表格行被读成残渣：${JSON.stringify(run(table))}`)
})

/* ------------------------------------------------------------------ ① 家族 */

test('①：24 字符的全大写标记（GLASSPANE_SMOKE_APPEND_END）也必须被抓到', () => {
  const hits = run(`正文：\nGLASSPANE_SMOKE_APPEND_END\n`)
  assert.equal(hits.length, 1, JSON.stringify(hits))
  assert.match(hits[0], /恰好是一枚全大写标记/)
})

test('①′：标记与下一条语句写在同一行（EOF; git diff …）不算散文', () => {
  const hits = run(`正文：\nEOF; git diff --numstat -- engine/smoke.md\n`)
  assert.ok(hits.length >= 1, `同行形状的 heredoc 标记漏过：${JSON.stringify(hits)}`)
})

test('①″：正文里出现 heredoc 引入式（<<\'EOF\'）要报', () => {
  const hits = run("正文：\n$(cat <<'XEOF'\n")
  assert.ok(hits.length >= 1, JSON.stringify(hits))
})

test('① 的文案不把"一定是残渣"当既成事实——给得出第二种解释与可执行动作', () => {
  const hits = run(`正文：\nTODO_MARKER\n`)
  assert.equal(hits.length, 1)
  assert.match(hits[0], /通常/, `文案把猜测写成事实：${hits[0]}`)
  assert.match(hits[0], /放进 ``` 围栏/, `出路不可执行：${hits[0]}`)
})

/* ---------------------------------------------------------------- 围栏模型 */

test('围栏状态机是 CommonMark：缩进代码块里的 ``` 不开栏，正文尾部仍被扫', () => {
  const hits = run('段落：\n\n    ```\n\n' + RES)
  assert.equal(hits.length, 1, '一枚缩进的三反引号把整篇读成了"在栏内"（旧布尔判据的假绿形状）：' + JSON.stringify(hits))
})

test('围栏：配对开闭之后正文尾部照扫；真未闭合的围栏之后不扫（那是渲染出的代码）', () => {
  assert.equal(run('段落：\n\n```\n栏内\n```\n\n' + RES).length, 1, '配对围栏之后必须回到正文')
  assert.deepEqual(run('段落：\n\n```\n栏内\n' + RES), [], '未闭合围栏之后的行按 CommonMark 就是代码')
})

test('围栏：~~~ 与 ``` 都算开栏，且闭合必须是同种字符且不更短', () => {
  assert.equal(fenceAfter('~~~bash', null), '~~~')
  assert.equal(fenceAfter('```', '~~~'), '~~~', '不同种字符不许闭栏')
  assert.equal(fenceAfter('~~`', '~~~'), '~~~', '更短的同种串不许闭栏')
  assert.equal(fenceAfter(' ~~~ ', '~~~'), null)
  assert.equal(fenceAfter('    ~~~', '~~~'), '~~~', '缩进 ≥4 的行不是闭合栏')
})

test('行内代码按行配对：一枚落单的反引号不许翻转整段的状态', () => {
  // 本轮实测踩到过：跨行状态让 `updater/README.md` 一段六行项目符号里的配对错位把中文正文
  // 整段当代码剥掉，只剩 `NODE_EXTRA_CA_CERTS` 一枚 ⇒ 一道为了消灭假绿的闸自己造出一条假红。
  assert.ok(!proseOf('前 `code` 后').includes('code'), '成对的行内代码段必须被剥掉')
  assert.match(proseOf('前 `code` 后'), /^前\s+后$/, '剥掉后左右文字不许粘成一个词')
  assert.equal(proseOf('落单的 ` 一枚'), '落单的 ` 一枚', '配不上的反引号必须原样留在正文里，不翻转任何状态')
  // 跨行状态的真实代价：上一行有一枚落单反引号时，下一行整段被当成"在代码段里"剥掉，
  // 于是**贴进正文的语句读不见**（假绿）。按行配对之后下一行照常参与判定。
  const hits = run('恢复时都带上 ` 这里落单\n' + RES)
  assert.equal(hits.length, 1, `落单反引号把下一行的语句吃掉了（假绿形状）：${JSON.stringify(hits)}`)
  // 而 `updater/README.md:20` 那一枚夹在成对反引号里的全大写环境变量名不许报——它是正文。
  assert.deepEqual(run('都带上 `NODE_EXTRA_CA_CERTS`。结果记在状态\n'), [], '成对行内代码里的全大写词被误报成标记')
})

/* ------------------------------------------------------------------- 扫描集 */

test('扫描集含 specs/**——每轮真正往正文里贴脚本的地方不许在闸外', () => {
  assert.ok(RESIDUE_DOCS.some((d) => d.startsWith('specs/')), 'specs/ 不在残渣闸的扫描集里')
})

test('真语料零误红：登记的文档 + specs/ 全过（放宽判据容易，量到零误红才是门槛）', () => {
  assert.deepEqual(shellResidue(), [], `本轮把判据改宽了：${JSON.stringify(shellResidue().slice(0, 3))}`)
})
