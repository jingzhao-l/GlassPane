/**
 * `scripts/check-doc-links.mjs` 的工具数量判据：两个方向都必须能证红。
 *
 * 方向一是这条判据存在的理由——主仓文档手抄的 `gp_*` 数量与 `mcp-shell/src/tools.ts`
 * 的真实数量对不上，必须报错（README 写"15 个工具"这类句子是好意，抄来的数字必然漂）。
 * 方向二是 2026-10-13 新学的：同一把尺子量到 fork 自己的文档上会恒红。那一边写
 * "`/experimental/tool/ids` 实测 20 个 id 含全部 6 个 `gp_*`"（harness/…/SYNCLOG.md:107），
 * 那是 opencode 的 tool id 数，不是 `glasspane-mcp` 对外的工具数，而且它是上游一次真实响应。
 * 主仓的数量断言套上去，红的原因就不是任何人写错了数字——而那道闸当时确实在 main 上红着，
 * 挡的是 harness 线的一笔正常文档提交。
 *
 * 夹具写在临时根里，不动仓库任何一份真文档。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { toolCountDrift } from '../../scripts/check-doc-links.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 一个只有 tools.ts 与两份文档的假仓库；`toolCount` 决定源码侧真实数量。 */
function fakeRoot({ mainText, forkText, toolCount = 16 }) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-doc-links-'))
  fs.mkdirSync(path.join(root, 'mcp-shell', 'src'), { recursive: true })
  const names = Array.from({ length: toolCount }, (_, i) => `  name: "gp_tool_${String.fromCharCode(97 + i)}",`).join('\n')
  fs.writeFileSync(path.join(root, 'mcp-shell', 'src', 'tools.ts'), `const SPECS = [\n${names}\n];\n`)
  if (mainText) fs.writeFileSync(path.join(root, 'README.md'), mainText)
  if (forkText) {
    fs.mkdirSync(path.join(root, 'harness/glasspane-harness'), { recursive: true })
    fs.writeFileSync(path.join(root, 'harness/glasspane-harness/SYNCLOG.md'), forkText)
  }
  return root
}

const MAIN = ['README.md']
const BOTH = ['README.md', 'harness/glasspane-harness/SYNCLOG.md']

test('check-doc-links: 主仓文档抄错工具数 → 具名报错（这条判据的存在理由）', () => {
  const root = fakeRoot({ mainText: '本壳对外提供 15 个工具。\n', toolCount: 16 })
  const problems = toolCountDrift({ docs: MAIN, rootDir: root })
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /README\.md: 写了 15 个工具，代码里实际是 16 个/)
  // 报文必须给出原句，否则改文档的人不知道自己动的是哪一句（旧写法把 `${m[1]}`
  // 反斜杠转义留在了普通字符串里，读者看到的是一行模板残骸）。
  assert.match(problems[0], /原句 "15 个工具"/, problems[0])
  fs.rmSync(root, { recursive: true, force: true })
})

test('check-doc-links: 数量对得上时不报（对照，防止判据只会红）', () => {
  const root = fakeRoot({ mainText: '本壳对外提供 16 个工具。\n', toolCount: 16 })
  assert.deepEqual(toolCountDrift({ docs: MAIN, rootDir: root }), [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('check-doc-links: fork 文档里另一个 `gp_*` 数量不参与主仓口径（0.7.8 那次恒红的形状）', () => {
  // 主仓那句是对的，fork 那句写的是 opencode 的 tool id 数。若扫描集合退回成 DOCS（含 fork），
  // 这一条就会红——那正是本轮 main 上红着的状态。
  const root = fakeRoot({
    mainText: '本壳对外提供 16 个工具。\n',
    forkText: '声称工具不在它的函数表里——而 `/experimental/tool/ids` 实测 20 个 id 含全部 6 个 `gp_*`，\n',
    toolCount: 16,
  })
  assert.deepEqual(toolCountDrift({ docs: MAIN, rootDir: root }), [])
  // 对照：把 fork 文档塞回扫描集合，同一条句子必须报错——证明"不红"是刻意的作用域，
  // 不是判据坏掉了或者正则没命中。
  const wrong = toolCountDrift({ docs: BOTH, rootDir: root })
  assert.equal(wrong.length, 1, JSON.stringify(wrong))
  assert.match(wrong[0], /SYNCLOG\.md: 写了 6 个工具，代码里实际是 16 个/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('check-doc-links: 真仓库现在的状态是绿的，且真实数量确实来自 tools.ts（不依赖构建产物）', () => {
  assert.deepEqual(toolCountDrift(), [], 'main 上的文档口径不该红')
  const src = fs.readFileSync(path.join(REPO, 'mcp-shell', 'src', 'tools.ts'), 'utf8')
  const counted = (src.match(/^\s*name:\s*"gp_[a-z_]+",/gm) ?? []).length
  assert.ok(counted > 0, '数不出数量说明正则与工具表形状已漂移')
  assert.equal(toolCountDrift({ docs: ['README.md'], rootDir: REPO }).length, 0)
})
