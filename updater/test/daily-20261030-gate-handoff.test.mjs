/**
 * 移交那一行不许重新承诺一个收件人（`scripts/check-workflows.mjs` 顶部的注释一直说本文件
 * 会在句子改回"报给那一条根自己的闸"时变红，而本文件 2026-10-31 之前不存在）。
 *
 * 为什么这件事值得一条闸：父仓的 `check-workflows` 对 `harness/**` 的两类发现
 * （producer→first-match-consumer、发布 `concurrency`）只**打印**不**拦截**，理由是那棵树属于
 * 另一条每日线。2026-10-26 实测过：那句话写的是"reported to that root's own gate"，而那一侧的
 * linter 根本没实现这两条规则——于是 12 个没有 timeout 的 job、4 个未自声明 shell 门的多语句
 * run 体就带着一条"有人接管了"的纸面记录发出去了。一条没有收件人的移交等于没有闸，
 * 而它比没有闸更危险，因为它在台账里留下了一句假话。
 *
 * 三条判据：句子自己（不许承诺 receiver）、一个坏样本（会咬人）、以及那一侧的 linter
 * **当下确实没有**这两条规则（实测；哪天它实现了，这条红在这里，逼着人来把话说成"已移交"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { NO_RECEIVER } from '../../scripts/check-workflows.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..', '..')
const HARNESS_LINTER = path.join(ROOT, 'harness', 'glasspane-harness', 'script', 'check-workflows.mjs')

/** 一句移交话术是否在承诺"有东西会读它"。撇号两种都认（直角与弯引号），否则坏样本喂不进去。 */
function promisesAReceiver(text) {
  return /reported to that root[\u2019']?s? own gate|blocked by that root|that gate (?:will|does) (?:catch|block|enforce)/i
    .test(String(text))
}

test('移交那一行说实话：不拦截、也没人接管', () => {
  assert.ok(NO_RECEIVER.includes('not enforced from here'), NO_RECEIVER)
  assert.ok(NO_RECEIVER.includes('blocked by nobody'), NO_RECEIVER)
  assert.equal(promisesAReceiver(NO_RECEIVER), false,
    `这句话又开始承诺一个收件人了：${NO_RECEIVER}`)
})

test('判据会咬人：旧形状必须被点名', () => {
  const bad = '— reported to that root’s own gate, which enforces it there'
  assert.equal(promisesAReceiver(bad), true,
    '连旧的那句话都认不出来，这条闸只是装饰')
})

test('对面那一侧确实还没实现这两条规则（实测，不是引用一段说法）', () => {
  assert.ok(fs.existsSync(HARNESS_LINTER), `读不到 ${HARNESS_LINTER}：这一条的对照物不在了，重读上面那段注释`)
  const raw = fs.readFileSync(HARNESS_LINTER, 'utf8')
  // 剥注释再看**代码**里有没有这两条规则：那一侧的文件在说明 `concurrency` 语义的段落里
  // 就写着这个词（`…a hung macOS build holds the concurrency slot six hours…`），
  // 拿着原始文本 `includes` 会把一段解释读成一条实现——那正是"让闸红在自己的说明上"。
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const rule of ['first-match-consumer', 'concurrency']) {
    assert.ok(!code.includes(rule),
      `harness 那一侧的代码现在开始读 ${rule} 了——那这句移交就该改成"已移交、由它拦截"，并把本文件这条判据一起改对`)
  }
})
