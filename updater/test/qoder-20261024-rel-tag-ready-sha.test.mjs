/**
 * D1 — 打 tag 之前那句"ci.yml 在 <headSha> 上是 success"，必须问的是**这一棵 commit 的、
 * push 那条通道的** ci.yml。
 *
 * 复核到的形状（`scripts/assert-tag-ready.mjs`，HEAD=61153ffd）：
 *   · `:129` 把文件名写死成 `const file = 'ci.yml'`，`--workflow` 只进 :104 的 usage 与
 *     :110 的文案，从不进 API 路径；
 *   · `:130` 的查询是 `runs?per_page=50`，**不带** `head_sha=` 也不带 `event=`；
 *   · 它复用的 `judgeCiGreen`（`scripts/assert-ci-green.mjs:39-72`）只按 `created_at` 取
 *     最新一条，从不比较 `run.head_sha`。
 * 三条合起来的后果：GitHub 对 `…/workflows/ci.yml/runs` 答的是**这条 workflow 最近 50 次
 * 运行，跨所有 commit、所有触发通道**，于是一句绿可以由别的 commit、或一次
 * schedule/workflow_dispatch/pull_request 的 run 兑现——给一枚 CI 从没验证过的 commit
 * 放行打 tag。`assert-ci-green.mjs:90-93` 的 fetch 早就是正确形状（`head_sha=&event=push`），
 * 这一条照它抄。
 *
 * 对着未改实现的红那一行（两份都在这里实测过，2026-10-24）：
 *   ① `assert.equal(judgeTagReady(crossSha).ok, false)` → `AssertionError: actual: true`，
 *      理由是那条来自 `d`.repeat(40) 的 success 被当成了证据；
 *   ② `ciRunsApiPath is not a function`（判据函数还不存在）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ciRunsApiPath, judgeTagReady, runsForSha } from '../../scripts/assert-tag-ready.mjs'

const SHA = 'a'.repeat(40)
const OTHER = 'd'.repeat(40)

/** 一条完成的 success 记录，钉在 `sha` 上。 */
const run = ({ sha, at, conclusion = 'success', status = 'completed', event = 'push', id = 1 }) => ({
  id, head_sha: sha, created_at: at, status, conclusion, event, html_url: `https://x/${id}`,
})

test('一条属于别的 commit 的绿，不能给这枚 tag 放行（D1 的本体）', () => {
  const base = { version: '2.0.0', headSha: SHA, originMainSha: SHA, existingTags: [] }
  const crossSha = {
    ...base,
    ciPayload: {
      workflow_runs: [
        // 这一棵上唯一的那条记录是**红的**，而且更早。
        run({ sha: SHA, at: '2026-10-23T01:00:00Z', conclusion: 'failure', id: 10 }),
        // 而下一分钟别的 commit 上跑绿了一条：未改的实现按 created_at 取最新，读到的就是它。
        run({ sha: OTHER, at: '2026-10-23T02:00:00Z', id: 11 }),
      ],
    },
  }
  const verdict = judgeTagReady(crossSha)
  assert.equal(verdict.ok, false, `别的 commit 的绿被当成这棵树的证据放行了：${verdict.reason}`)
  assert.match(verdict.reason, /不是绿的|没有任何运行记录/, verdict.reason)
  // 被排除掉的那几条不许悄悄消失：说过"排除"才算说过。
  assert.match(verdict.reason, /head_sha 不是/, verdict.reason)
  // 同一棵树自己的那条绿仍然必须放行——判据不是被放宽成"一律红"。
  const honest = judgeTagReady({ ...base, ciPayload: { workflow_runs: [run({ sha: SHA, at: '2026-10-23T01:00:00Z' })] } })
  assert.equal(honest.ok, true, honest.reason)
})

test('runsForSha 只排除**声称是别的 commit** 的记录，不排除它没声称的', () => {
  const labeled = runsForSha({ workflow_runs: [run({ sha: SHA, at: 'x' }), run({ sha: OTHER, at: 'y' })] }, SHA)
  assert.equal(1, labeled.length)
  assert.equal(SHA, labeled[0].head_sha)
  // GitHub 的 runs API 永远填 `head_sha`；读不到这个字段的只有合成夹具（
  // `updater/test/scripts-daily-20261020.test.mjs` 就是那种形状），拒掉它们等于把真判据
  // 换成对夹具的猜测，所以这里是"没声称 = 不与之矛盾"，而查询串仍然必须自己带 head_sha=。
  assert.equal(1, runsForSha({ workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] }, SHA).length)
  assert.deepEqual([], runsForSha(null, SHA))
})

test('问 API 的那一句用的是 --workflow 的值，并且钉在 head_sha 与 event=push 上', () => {
  const asked = ciRunsApiPath({ repository: 'jingzhao-l/GlassPane', workflow: 'ci.yml', sha: SHA })
  assert.match(asked, /head_sha=a{40}/, asked)
  assert.match(asked, /event=push/, asked)
  assert.match(asked, /per_page=(100|9[0-9])/, `一条 50 的窗口在一条 busy 的 main 上会漏掉这一棵：${asked}`)
  assert.match(asked, /workflows\/ci\.yml\/runs/, asked)

  // `--workflow` 只进文案不进 API，就是"用法说一件事、查询做另一件事"。
  const nightly = ciRunsApiPath({ repository: 'jingzhao-l/GlassPane', workflow: 'ci-nightly.yml', sha: OTHER })
  assert.match(nightly, /workflows\/ci-nightly\.yml\/runs/, `--workflow 被写死的文件名顶掉了：${nightly}`)
  assert.ok(!/workflows\/ci\.yml\/runs/.test(nightly), nightly)

  // 没有 sha 就不许拼出一条"查所有 commit"的查询——那正是缺陷的形状。
  assert.throws(() => ciRunsApiPath({ repository: 'r/x', workflow: 'ci.yml', sha: '' }), /sha/)
})

test('一条还没跑完的**别的 commit** 的 run，也不能把这枚 tag 钉成"等它"', () => {
  const verdict = judgeTagReady({
    version: '2.0.0',
    headSha: SHA,
    originMainSha: SHA,
    existingTags: [],
    ciPayload: { workflow_runs: [run({ sha: OTHER, at: '2026-10-23T05:00:00Z', status: 'in_progress', id: 12 })] },
  })
  assert.equal(verdict.ok, false, verdict.reason)
  assert.notEqual(verdict.pending, true, `等一条不属于这棵树的 run 是把"没有证据"说成"在路上"：${verdict.reason}`)
  assert.match(verdict.reason, /没有任何运行记录/, verdict.reason)
})
