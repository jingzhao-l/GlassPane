#!/usr/bin/env node
/**
 * 发布之前，问一次 GitHub：这个 commit 的 CI 到底绿没绿。
 *
 * WHY（2026-10-16 实测，不是推想）。本轮 `v1.16.1` 的 tag 切在 `4c58e9c`，两条发布通道都按
 * 顺序走完了：Release 非草稿、资产齐、签名在，registry 两个包也读得到 `1.16.1`。而同一棵树的
 * CI 那次是**红的**（run 38842800885，`root workspace gate` 里 `updater/lib/mcp.js` 的
 * `write EPIPE`）。也就是说：链子上没有任何一环会拦下"内容没被验证过的树"——
 * `check-version` 只证明这份检出内部一致（main 的 HEAD 也满足它），"Refuse to publish a tree
 * no tag vouches for" 只证明 HEAD 就是 tag 指着的那棵树，两者都不问那棵树跑没跑过测试。
 * 提示词写的顺序（push → 等 CI 绿 → tag → dry → publish）在这两点上全靠人自觉。
 *
 * 于是把那句自觉变成一步：读 GitHub Actions 的 runs API（`gh api` 用作业自带的
 * `GITHUB_TOKEN`，需要 `actions: read`），按**这个 sha** 的 `ci.yml` 运行记录判定。三种结果
 * 必须分开说，因为补救动作不同：
 *   · 跑坏了 → 点名 run id、结论与 URL，先修代码再发。
 *   · 还没跑完 → 等，等满预算就按"未验证"拒绝（不是"通过"）；tag 与 push 几乎同时发生，
 *     这一条每天会用到，所以等待是设计而不是兜底。
 *   · 这个 sha 根本没有 CI 记录 → 拒绝，并说"没有证据"。tag 指到一个从没被 push 过的 commit
 *     上就是这种形状；让它过等于给一棵没跑过测试的树发签名发布物。
 *
 * 判据取**最新那一条**（按 `created_at`，不比 id——run id 单调只是 GitHub 的实现细节，
 * 时间戳是 API 明说会变的字段里最直白的那个）：重跑同一个 commit 是常规操作，旧的红记录
 * 不该永远钉住这一版；但"取最新"必须是真的按时间取，所以这条单独有测试。
 *
 * 故意**不**做的事：不因为 CI 红就去放宽判据、不跳过 `action_wait`、不把"没记录"读成"通过"。
 * 需要放行时，人得改这个文件——那是留痕的位置，而不是一个 `--force` 旗标。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * @param {{workflow_runs?: object[]}} payload GitHub `…/workflows/<file>/runs` 的响应体
 * @param {{workflow: string, sha: string}} asked 问了什么，写进拒绝话术里
 * @returns {{ok: boolean, pending?: boolean, reason: string, run?: object}}
 */
export function judgeCiGreen(payload, { workflow, sha }) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : []
  if (runs.length === 0) {
    return {
      ok: false,
      reason: `${workflow} 在 commit ${sha} 上没有任何运行记录——"没跑过"不是"跑绿了"。`
        + '这个 sha 大概从没被 push 过（tag 指到了 main 之外的提交上）。发布对象的正确形状是：'
        + `push 到 main → 等 ${workflow} 绿 → 再在这个 commit 上打 tag。`,
    }
  }
  const sorted = [...runs].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
  const latest = sorted[0]
  if (String(latest?.status ?? '') !== 'completed') {
    return {
      ok: false,
      pending: true,
      run: latest,
      reason: `${workflow} #${latest?.run_number ?? '?'}（${latest?.id}）在 ${sha} 上还没跑完`
        + `（status=${latest?.status ?? '未知'}），等它。`,
    }
  }
  if (String(latest?.conclusion ?? '') !== 'success') {
    const failed = sorted.filter((r) => r.status === 'completed' && r.conclusion !== 'success')
      .map((r) => `#${r.run_number ?? '?'} ${r.conclusion ?? '未知'} ${r.html_url ?? ''}`)
      .join('；')
    return {
      ok: false,
      run: latest,
      reason: `${workflow} 在 commit ${sha} 上是 ${latest.conclusion ?? '未知'}：${failed || `#${latest.run_number} ${latest.html_url ?? ''}`}。`
        + '红的那一条修完再发；把这一步放宽就是给一棵没验证过的树签发布物。',
    }
  }
  return { ok: true, run: latest, reason: `${workflow} #${latest.run_number ?? '?'} 在 ${sha} 上是 success（${latest.id}）` }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

function fetchRuns({ repository, workflow, sha, ghBin }) {
  const apiPath = `repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs`
  const got = spawnSync(ghBin, ['api', `${apiPath}?head_sha=${sha}&event=push&per_page=100`],
    { encoding: 'utf8' })
  if (got.error) return { error: `调用 ${ghBin} 失败（${got.error.message}）` }
  if (got.status !== 0) {
    return { error: `${ghBin} api 回了 ${got.status}：${String(got.stderr ?? '').trim().slice(0, 300) || '(无 stderr)'}`
      + `——问的是 ${apiPath}?head_sha=${sha}` }
  }
  try {
    return { payload: JSON.parse(got.stdout) }
  } catch (error) {
    return { error: `${workflow} 的 runs 响应不是 JSON（${error.message}）：${String(got.stdout).slice(0, 160)}` }
  }
}

export function main({ env = process.env, ghBin = 'gh', sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const sha = arg('sha', env.GITHUB_SHA ?? '') || ''
  const workflow = arg('workflow', 'ci.yml')
  const repository = arg('repository', env.GITHUB_REPOSITORY ?? '')
  const budgetMs = Number(arg('budget', '1200000'))
  const pollMs = Number(arg('poll', '30000'))
  if (!sha) return { code: 1, text: '没有 sha：既没给 --sha，环境里也没有 GITHUB_SHA。没有对象可问，不能算通过。' }
  if (!repository) return { code: 1, text: '没有 GITHUB_REPOSITORY，问不了 Actions API。' }

  const started = Date.now()
  let last = null
  for (;;) {
    const fetched = fetchRuns({ repository, workflow, sha, ghBin })
    if (fetched.error) return { code: 1, text: fetched.error }
    last = judgeCiGreen(fetched.payload, { workflow, sha })
    if (last.ok || !last.pending) return { code: last.ok ? 0 : 1, text: last.reason }
    if (Date.now() - started >= budgetMs) {
      return {
        code: 1,
        text: `${last.reason} 预算 ${Math.round(budgetMs / 60000)} 分钟已经用完，仍未跑完——`
          + '按"未验证"拒绝发布。要更长的等待就调 `--budget <毫秒>`（那是改判据的地方，留下记录）。',
      }
    }
    process.stderr.write(`${last.reason} 再等 ${Math.round(pollMs / 1000)}s…\n`)
    sleep(pollMs)
  }
}

// 被 import 时什么都不跑（`updater/test/scripts-assert-ci-green.test.mjs` 有一条断言专门量这件事：
// 顶层自跑 + exit 的脚本被 `node --test` import 时，会以"零条用例通过"的形状假绿）。
// 判据写成绝对路径比较：实测这一版 Node 交给 argv[1] 的已经是绝对且折叠过的路径，两边归一只是
// 不把这件事押在实现细节上。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = main()
  process.stdout.write(`${result.text}\n`)
  process.exit(result.code)
}
