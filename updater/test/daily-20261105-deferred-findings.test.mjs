/**
 * 每日任务 2026-11-05 · `scripts/check-doc-links.mjs` 新增的 `DEFERRED_FINDINGS` 通道。
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
 * REVERSE：把 `DEFERRED_FINDINGS` 里那条 `problem` 改成通配式的宽松匹配 ⇒ 第 ② 条红；
 * 把第 ③ 条那个反向 `problems.push` 删掉 ⇒ 第 ③ 条红；把 `advisories.push` 去掉 ⇒ 第 ① 条红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { check, DOCS } from '../../scripts/check-doc-links.mjs'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const DEFERRED_DOC = 'harness/glasspane-harness/README.md'
const DEFERRED_ANCHOR_LINE = `${DEFERRED_DOC}: 同文档锚点失效 → #license-attribution`

/** 临时根里造一份带双语 `&` 标题的文档，形状取自 GitHub 真会怎么算这一枚锚点。 */
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
  const result = check({ rootDir: root, docs: [DEFERRED_DOC] })
  const anchorProblems = result.problems.filter((p) => p.includes('同文档锚点失效'))
  assert.deepEqual(anchorProblems, [], `归口的那一行不该再算缺陷，实得：${anchorProblems}`)
  const note = (result.advisories ?? []).find((a) => a.includes('harness-readme-license-anchor'))
  assert.ok(note, '归口条目必须每轮打印一次，静默的豁免与"没扫"在读者眼里长得一样')
  assert.match(note, /github-slugger/, `打印出来的那一行要带判据：${note}`)
  assert.match(note, /daily-glasspane-harness/, `还要点名收件人：${note}`)
  fs.rmSync(root, { recursive: true, force: true })
})

test('③ 那一行不再发生时，闸反过来红并点名"删掉这条豁免"', () => {
  const root = rootWithForkReadme({ fixed: true })
  const result = check({ rootDir: root, docs: [DEFERRED_DOC] })
  const stale = result.problems.filter((p) => p.includes('harness-readme-license-anchor'))
  assert.equal(stale.length, 1, `修好了却还留着豁免，这一条必须红；实得：${result.problems}`)
  assert.match(stale[0], /删掉/, `红话要给出下一步：${stale[0]}`)
  assert.deepEqual((result.advisories ?? []).filter((a) => a.includes('harness-readme-license-anchor')), [],
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
  const result = check({ rootDir: root, docs: [DEFERRED_DOC, 'other.md'] })
  const problems = result.problems.filter((p) => p.includes('同文档锚点失效'))
  assert.deepEqual(problems, [
    `${DEFERRED_DOC}: 同文档锚点失效 → #totally-missing`,
    'other.md: 同文档锚点失效 → #license-attribution',
  ].sort(), `豁免长歪了：实得 ${problems}`)
  assert.ok(!DEFERRED_ANCHOR_LINE || !problems.includes(DEFERRED_ANCHOR_LINE))
  fs.rmSync(root, { recursive: true, force: true })
})

test('真仓库自证当下状态：归口的那一行以 △ 存在，而本仓 README 双语锚点已逐条改对', () => {
  const result = check({ rootDir: REPO, docs: DOCS })
  const anchorProblems = result.problems.filter((p) => p.includes('锚点'))
  assert.deepEqual(anchorProblems, [], `本仓文档里还有失效锚点：${anchorProblems}`)
  assert.ok((result.advisories ?? []).some((a) => a.includes('harness-readme-license-anchor')),
    '真树上这一条应仍是"待那条线修"，不是被删掉了')
})
