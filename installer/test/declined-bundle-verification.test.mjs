/**
 * bundle 安置被拒时，安装结论不许说"本轮构建产物"（2026-10-16）。
 *
 * 为什么需要这一份：同一件事的端到端证明在 `install-honesty.test.mjs`
 * （真跑一次安装、对覆盖答"不"、看打印的那句），而那条用例的前提是 installer 自己的
 * 环境预检能过——它要 `swift` 与 `open`，CI 的 install-gate 跑在 ubuntu-latest 上，
 * 两个都不在。于是一条产品诚实性的判据在**每一个 CI job 里都不执行**（本机负载高时
 * 还间歇性 skip）。这条是那条判据的可 everywhere 执行的那一半：直接把
 * `installVerification` 的判定按真形状喂进去，CI 一定跑到。
 *
 * 反向变异：把 `declinedBundles` 那一支从 installVerification 里删掉 → 第 1 条红；
 * 把 `verified` 无条件写成 true → 第 1、2 条都红。第 3 条是对照，防止"一切都拒"也能绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installVerification } from '../cli.js'

const SAME = { arrived: true, helloVersion: '1.16.0', builtVersion: '1.16.0' }

test('同一版本号 + bundle 安置被跳过：不许写"本轮构建产物"', () => {
  const verdict = installVerification({ ...SAME, declinedBundles: ['GlassPane.app'] })
  assert.equal(
    verdict.verified,
    false,
    `版本号相同就宣布校验通过，而应答的那一份是盘上的旧 bundle：${JSON.stringify(verdict)}`,
  )
  const note = String(verdict.note ?? '')
  assert.ok(note.length > 0, '拒绝必须给出那句话——面板与 CLI 打印的就是它')
  assert.match(note, /旧|上一轮|未替换|跳过/, `那句话要说明应答的是磁盘上的旧一份：${note}`)
  assert.match(note, /不算校验通过|没有依据/, `要有一句明确收回结论：${note}`)
  // 判据的实体是 `verified`：安装报告那句"实测校验通过…本轮构建产物=<v>"由它决定
  // （见第 2 条对照：declined 为空时 verified=true、note=null，那句话才会被打印）。
  // 所以这里不靠禁某个子串过关，而是钉住"这一轮不许点亮"。
})

test('对照：bundle 真的被替换了，才允许说本轮产物', () => {
  const verdict = installVerification({ ...SAME, declinedBundles: [] })
  assert.equal(verdict.verified, true, JSON.stringify(verdict))
})

test('版本不同 + bundle 被拒时，说的是两件不同的事', () => {
  const stale = installVerification({
    arrived: true, helloVersion: '1.14.1', builtVersion: '1.16.0', declinedBundles: ['GlassPane.app'],
  })
  assert.equal(stale.verified, false, JSON.stringify(stale))
  assert.match(String(stale.note), /1\.14\.1/, '版本号不同的那一支仍要点名两个数，不能只谈 bundle')
})
