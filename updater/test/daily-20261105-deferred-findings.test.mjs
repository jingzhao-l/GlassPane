/**
 * 每日任务 2026-11-05 开的通道 · `scripts/check-doc-links.mjs` 的 `DEFERRED_FINDINGS`。
 *
 * 起因。上一轮候选 J 把 `slug()` 改成与 GitHub 自己的 `github-slugger@2.0.0` 同答（逐枚空格换
 * `-`，不合并）。本机 `npm i github-slugger` 实跑出 `slug("License & attribution") ==
 * "license--attribution"`、`slug("安装 / Installation") == "安装--installation"`，于是闸第一次
 * 如实报出 16 处**在 GitHub 上真点不动**的双语锚点：15 处在本仓 `README.zh-CN.md`（本轮逐条改对），
 * 1 处在 `harness/glasspane-harness/README.md`——那是 subtree 搬来的另一条线的门面，本仓既不许改
 * 它的内容（10:30 有独立任务与独立取号），`release-artifact` 又钉着"已发布 fork tag 的树 ==
 * 主干子树"。
 *
 * 这一条通道就是为了不让"归口"变成一道有纸面记录的无闸（本仓栽过：把发现降级成'交给那条线'
 * 而收件人不存在）。三条判据各测各的：
 *   ① 豁免必须是**可见的**——每一轮都打印成一行 `△`，不许静默少扫；
 *   ② 豁免必须是**精确匹配的**——逐字同形的一行才豁免，换个文件/换个锚点照样红（否则它会长成
 *      一条通配的遮罩）；
 *   ③ 豁免必须**会自己过期**——那一行不再发生时，闸反过来红并点名"把这条删掉"。
 *
 * 2026-11-06 改版。收件人那条线把锚点修掉了（fork 的 `README.md` 把标题写成
 * `## License and attribution`，链接同批跟上），登记表因此清空。这一度让本文件三条测试全部
 * 失去输入——它们原先吃的是模块级那张真表。改成吃 `check({ deferredFindings })` 注入的夹具：
 * 通道由夹具测，真表的状态由第五条测试单独自证。**表的清空不是通道的退役**，所以判据一条都不能
 * 少；反过来，把夹具写成"永远等于模块表"就等于把第三条测试冻死。
 *
 * REVERSE：把夹具那条 `problem` 改成通配式的宽松匹配 ⇒ 第 ② 条红；把第 ③ 条那个反向
 * `problems.push` 删掉 ⇒ 第 ③ 条红；把 `advisories.push` 去掉 ⇒ 第 ① 条红；把 `check()` 的
 * 默认值 `deferredFindings = DEFERRED_FINDINGS` 改成 `= []` ⇒ 第五条红（真表从此不被生产
 * 路径消费）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { check, DOCS, DEFERRED_FINDINGS } from '../../scripts/check-doc-links.mjs'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const DEFERRED_DOC = 'harness/glasspane-harness/README.md'
const DEFERRED_ANCHOR_LINE = `${DEFERRED_DOC}: 同文档锚点失效 → #license-attribution`

/** 通道夹具：形状取自 GitHub 真会怎么算这一枚锚点，逐字同形于当年那一条。 */
const FIXTURE_ENTRY = {
  id: 'fixture-license-anchor',
  problem: DEFERRED_ANCHOR_LINE,
  measured: 'github-slugger@2.0.0 slug("License & attribution") == "license--attribution"',
  owner: '夹具的收件人（本测试）',
  handedTo: 'updater/test/daily-20261105-deferred-findings.test.mjs',
  openedOn: '2026-11-06',
}

/** 临时根里造一份带双语 `&` 标题的文档，链接坏或好由 `fixed` 决定。 */
function rootWithForkReadme({ fixed }) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-deferred-'))
  const dir = path.join(root, DEFERRED_DOC.split('/').slice(0, -1).join(path.sep))
  fs.mkdirSync(dir, { recursive: true })
  const link = fixed ? '#license--attribution' : '#license-attribution'
  fs.writeFileSync(path.join(root, DEFERRED_DOC),
    `# Harness\n\n## License & attribution\n\n[跳去那一节](${link})\n`, 'utf8')
  return root
}

test('①/③ 归口条目发生时要打印成一行，不许静默；且它不再是缺陷', () => {
  const root = rootWithForkReadme({ fixed: false })
  const result = check({ rootDir: root, docs: [DEFERRED_DOC], deferredFindings: [FIXTURE_ENTRY] })
  const anchorProblems = result.problems.filter((p) => p.includes('同文档锚点失效'))
  assert.deepEqual(anchorProblems, [], `归口的那一行不该再算缺陷，实得：${anchorProblems}`)
  const note = (result.advisories ?? []).find((a) => a.includes('fixture-license-anchor'))
  assert.ok(note, '归口条目必须每轮打印一次，静默的豁免与"没扫"在读者眼里长得一样')
  assert.match(note, /github-slugger/, `打印出来的那一行要带判据：${note}`)
  assert.match(note, /daily-20261105-deferred-findings/, `还要点名收件人：${note}`)
  fs.rmSync(root, { recursive: true, force: true })
})

test('③ 那一行不再发生时，闸反过来红并点名"删掉这条豁免"', () => {
  const root = rootWithForkReadme({ fixed: true })
  const result = check({ rootDir: root, docs: [DEFERRED_DOC], deferredFindings: [FIXTURE_ENTRY] })
  const stale = result.problems.filter((p) => p.includes('fixture-license-anchor'))
  assert.equal(stale.length, 1, `修好了却还留着豁免，这一条必须红；实得：${result.problems}`)
  assert.match(stale[0], /删掉/, `红话要给出下一步：${stale[0]}`)
  assert.deepEqual((result.advisories ?? []).filter((a) => a.includes('fixture-license-anchor')), [],
    '已经不再发生的条目不许还打印成"待修"')
  fs.rmSync(root, { recursive: true, force: true })
})

test('② 豁免是逐字匹配：换个文件或换个锚点照样红', () => {
  // 同一枚坏锚点在**别的**文件里（换个门面文档），以及同一文件里另一枚坏锚点，两条都不许被豁免。
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-deferred-lookalike-'))
  fs.mkdirSync(path.join(root, 'harness/glasspane-harness'), { recursive: true })
  fs.writeFileSync(path.join(root, DEFERRED_DOC),
    '# Harness\n\n## License & attribution\n\n[a](#license-attribution)\n[b](#totally-missing)\n', 'utf8')
  fs.writeFileSync(path.join(root, 'other.md'),
    '# Other\n\n## License & attribution\n\n[a](#license-attribution)\n', 'utf8')
  const result = check({ rootDir: root, docs: [DEFERRED_DOC, 'other.md'], deferredFindings: [FIXTURE_ENTRY] })
  const problems = result.problems.filter((p) => p.includes('同文档锚点失效'))
  assert.deepEqual(problems, [
    `${DEFERRED_DOC}: 同文档锚点失效 → #totally-missing`,
    'other.md: 同文档锚点失效 → #license-attribution',
  ].sort(), `豁免长歪了：实得 ${problems}`)
  assert.ok(!problems.includes(DEFERRED_ANCHOR_LINE))
  fs.rmSync(root, { recursive: true, force: true })
})

test('夹具不许反过来当生产表用：真表为空时，坏锚点就是缺陷，不是 △', () => {
  // 这一条盯的是"注入通道的默认值"：如果 `check()` 在生产路径上不再读模块表，上面三条就都在
  // 测一个没人消费的机制。真树上表已清空，于是同一份坏文档必须**红**——这才证明消费的是真表。
  const root = rootWithForkReadme({ fixed: false })
  const result = check({ rootDir: root, docs: [DEFERRED_DOC] })
  assert.deepEqual(result.problems.filter((p) => p.includes('同文档锚点失效')), [DEFERRED_ANCHOR_LINE],
    '模块表为空却仍被豁免，说明豁免通道被硬编码而不是读表')
  assert.deepEqual((result.advisories ?? []).filter((a) => a.includes('fixture-license-anchor')), [],
    '夹具不该出现在生产读数里')
  fs.rmSync(root, { recursive: true, force: true })
})

test('真仓库自证当下状态：那一处锚点已由收件人修掉，登记表因此为空', () => {
  const result = check({ rootDir: REPO, docs: DOCS })
  const anchorProblems = result.problems.filter((p) => p.includes('锚点'))
  assert.deepEqual(anchorProblems, [], `本仓文档里还有失效锚点：${anchorProblems}`)
  assert.deepEqual(DEFERRED_FINDINGS, [],
    '登记表里还有条目——要么是真有归口缺陷没修完，要么是这一条已过期却留着当掩护')
  assert.deepEqual((result.advisories ?? []).filter((a) => a.includes('归口待修')), [],
    '表为空却仍打印归口，说明打印的不是表的内容')
  // 修的是标题而不是链接：`## License and attribution` 的 slug 就是 `license-and-attribution`，
  // 这一枚锚点从此不再依赖"`&` 被丢掉留下两枚空格"这个只有实跑才知道的形状。
  const readme = fs.readFileSync(path.join(REPO, DEFERRED_DOC), 'utf8')
  assert.match(readme, /^## License and attribution$/m, '标题形状是这条修复的一部分')
  assert.ok(!readme.includes('#license-attribution'), '目录里还留着那只断链')
  assert.ok(readme.includes('[License and attribution](#license-and-attribution)'), '目录项与标题不同形')
})
