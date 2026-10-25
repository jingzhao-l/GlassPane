#!/usr/bin/env node
/**
 * assert-tag-ready.mjs — 打 tag 之前问一次：这棵树配得上一个发布锚点吗。
 *
 * WHY（2026-10-19/20 实测，不是推想）。`v1.17.0` 那枚签名 tag 打在一笔 CI 红的 main 上，
 * 于是 `release.yml` 第一步（`assert-ci-green.mjs`）永远拒它——而那条红来自
 * `harness/tools/release-artifact.mjs`，它量的是**主干当时的子树**与**已发布 tag** 是否同一份
 * 字节。已发布的 tag 绝不移动，所以那笔 commit 的 CI 后来无论如何都转不了绿：harness 线补完
 * 0.9.1 之后，绿的是新 commit，旧 sha 依旧红。结果是仓库里留了一枚"版本线说 1.17.0、
 * registry 与 Release 都到不了 1.17.0"的锚点，下一轮拿到的是一条跑不通的交接命令
 * （`gh run rerun --failed` 只会再拒一次）。
 *
 * 提示词写的顺序本来就是 push → 等 CI 绿 → 打 tag，但链子上没有任何一环**执行**这个顺序：
 * `check-version` 只证明这棵树内部一致，`assert-ci-green` 只在 tag 已经存在之后才被问起。
 * 于是把那句自觉挪到打 tag 之前：这一步拒的是"造出一枚发不出去的锚点"，不是"发出去"。
 *
 * 三条判据，各自能单独变红：
 *   · 版本号形状 + `v<version>` 尚不存在（本地与远端都查）——tag 一旦发布绝不移动；
 *   · HEAD 必须就是 `origin/main` 的 tip——tag 指到 main 之外的提交，registry 上的字节就没有
 *     任何一条 CI 记录为它背书；
 *   · `--workflow`（默认 `ci.yml`）在**这笔 commit 上**、`event=push` 那条通道里的最新一条必须
 *     已完成且 success（判据复用 `assert-ci-green.mjs` 的 `judgeCiGreen`，两处共用一套口径，
 *     避免"两份闸两种说法"；问的是哪一棵树由 `ciRunsApiPath` 钉，不是由文案钉）。
 *
 * 用法：node scripts/assert-tag-ready.mjs <X.Y.Z> [--repository owner/name] [--workflow ci.yml]
 * 退出：0 可以打；1 不可以（点名哪一条、给补救）；2 问不到（git/gh 读不动 = 环境问题，不当作绿）。
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { judgeCiGreen } from './assert-ci-green.mjs'

export const WORKFLOW_DEFAULT = 'ci.yml'

/** tag 名与版本形状：`v` + 三段数字，别的形状一律不当作发布锚点。 */
export function tagShapeOk(version) {
  return /^\d+\.\d+\.\d+$/.test(String(version ?? ''))
}

/**
 * The runs API path — the same shape `assert-ci-green.mjs`'s `fetchRuns` builds, and for the
 * same reason (D1, 2026-10-24 复核). It used to be `…/workflows/ci.yml/runs?per_page=50`, i.e.
 * the workflow name was a literal (so `--workflow` only ever reached the *prose*, never the
 * question) and, worse, unscoped: no `head_sha`, no `event`. GitHub answers that query with the
 * 50 most recent runs of the workflow **across every commit and every trigger channel**, and the
 * judge this file reuses (`judgeCiGreen`) sorts by `created_at` and never reads
 * `run.head_sha`. So "ci.yml 在 <headSha> 上是 success" could be vouched for by a run of a
 * *different* commit — or of a `schedule`/`workflow_dispatch`/`pull_request` run of this one —
 * and a commit CI never verified would get a signed tag. `head_sha=` makes the question about
 * the object being tagged; `event=push` makes it about the channel that actually builds `main`
 * (a PR run of the same sha tested the merge ref, not these bytes).
 */
export function ciRunsApiPath({ repository, workflow = WORKFLOW_DEFAULT, sha }) {
  if (!/^[0-9a-f]{40}$/i.test(String(sha ?? ''))) {
    // An empty `head_sha=` is the缺陷的形状 itself: GitHub answers "every recent run", and the
    // judge downstream cannot tell which commit it is vouching for. Refuse the question.
    throw new TypeError(`ciRunsApiPath: sha 不是一枚 commit id（${JSON.stringify(sha ?? null)}）——不带 head_sha 的 runs 查询跨所有 commit，正是这条闸要堵的那一格`)
  }
  const apiPath = `repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs`
  return `${apiPath}?head_sha=${String(sha).toLowerCase()}&event=push&per_page=100`
}

/**
 * Second half of the same fix, and the half that cannot be delegated to the query string: keep
 * only runs that do **not** contradict the sha being tagged. A run carrying a different
 * `head_sha` is dropped, so a green run from another commit can never be the evidence. A run
 * that carries no `head_sha` at all passes: the GitHub API always fills the field, so the only
 * way to see it absent is a synthetic payload, and refusing those would mean rewriting the
 * fixtures that already pin this judge. This is a filter on a *claimed* disagreement, not a
 * claim that every run was checked — that is why the query above still has to be scoped.
 */
export function runsForSha(payload, sha) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : []
  const wanted = String(sha ?? '').toLowerCase()
  return runs.filter((run) => {
    const at = String(run?.head_sha ?? '').toLowerCase()
    return !at || at === wanted
  })
}

/**
 * The judgment, with every read injected, so both answers are testable without a repository.
 *
 * @param {{version: string, headSha: string, originMainSha: string, existingTags: string[],
 *          ciPayload: {workflow_runs?: object[]}|null, workflow?: string}} facts
 */
export function judgeTagReady({ version, headSha, originMainSha, existingTags = [], ciPayload, workflow = WORKFLOW_DEFAULT }) {
  const want = `v${version}`
  if (!tagShapeOk(version)) {
    return { ok: false, reason: `版本号形状不是 X.Y.Z：${JSON.stringify(version)}。tag 名由它拼出来，形状不对就连"发的是哪一版"都说不清。` }
  }
  if (existingTags.includes(want)) {
    return {
      ok: false,
      reason: `${want} 已经存在。已发布的 tag 绝不移动（install.sh 与 updater 钉的就是它）；`
        + '这一版发不出去就取下一个号，不要覆盖锚点，也不要把它当成本轮的收口。',
    }
  }
  if (!/^[0-9a-f]{40}$/.test(String(headSha ?? ''))) {
    return { ok: false, reason: `HEAD 读出来是 ${JSON.stringify(headSha ?? null)}，不是一枚 commit id：无法证明要打的那棵树是什么。` }
  }
  if (!/^[0-9a-f]{40}$/.test(String(originMainSha ?? ''))) {
    return {
      ok: false,
      reason: `origin/main 读不出来（${JSON.stringify(originMainSha ?? null)}）：本地这笔提交大概还没推，或远端答不上来。`
        + 'tag 只能钉在**已经在 main 上**的提交——推上去那笔才有 CI 记录，而 CI-green 前置只认记录。',
    }
  }
  if (headSha !== originMainSha) {
    return {
      ok: false,
      reason: `HEAD (${headSha}) 不是 origin/main (${originMainSha}) 的 tip。tag 指到 main 之外的提交，`
        + 'registry 与 Release 的字节就没有任何一条 CI 运行为它背书；先推 main，或在 main 上重新走一遍。',
    }
  }
  const scopedRuns = runsForSha(ciPayload, headSha)
  const dropped = (Array.isArray(ciPayload?.workflow_runs) ? ciPayload.workflow_runs : []).length - scopedRuns.length
  const ci = judgeCiGreen({ workflow_runs: scopedRuns }, { workflow, sha: headSha })
  if (dropped > 0 && !ci.ok) {
    // Say what was thrown away: "没有记录" and "只有别的 commit 的记录" are different facts, and
    // the second one is exactly the defect this line exists to close.
    ci.reason = `${ci.reason}（本轮另见 ${dropped} 条 ${workflow} 记录，head_sha 不是 ${headSha}，已按"别的 commit"排除）`
  }
  if (ci.pending === true) {
    return {
      ok: false,
      pending: true,
      reason: `${workflow} 在 ${headSha} 上还没跑完（${ci.reason}）。等它，不要用 --no-verify 之类的旗标绕过——`
        + '本脚本没有那个旗标，这是有意的。',
      run: ci.run ?? null,
    }
  }
  if (!ci.ok) {
    return {
      ok: false,
      reason: `${workflow} 在 ${headSha} 上不是绿的：${ci.reason}`,
      run: ci.run ?? null,
    }
  }
  return { ok: true, reason: `可以打 ${want}：HEAD == origin/main == ${headSha}，且 ${workflow} 最新一条是 success。`, run: ci.run ?? null }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

export function main(argv, { cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') } = {}) {
  const version = argv[0]
  if (!version) {
    process.stderr.write('usage: node scripts/assert-tag-ready.mjs <X.Y.Z> [--repository owner/name] [--workflow ci.yml]\n')
    return 2
  }
  const repoAt = argv.indexOf('--repository')
  const repository = repoAt > -1 && argv[repoAt + 1] ? argv[repoAt + 1] : null
  const wfAt = argv.indexOf('--workflow')
  const workflow = wfAt > -1 && argv[wfAt + 1] ? argv[wfAt + 1] : WORKFLOW_DEFAULT
  let facts
  try {
    const headSha = git(['rev-parse', 'HEAD'], cwd)
    let originMainSha = ''
    try {
      originMainSha = git(['rev-parse', 'refs/remotes/origin/main'], cwd)
    } catch {
      originMainSha = ''
    }
    const localTags = git(['tag', '--list', `v${version}`], cwd).split('\n').filter(Boolean)
    let remoteTags = []
    if (repository) {
      const listed = execFileSync('gh', ['api', `repos/${repository}/git/matching-refs/tags/v`, '--paginate', '--jq', '.[].ref'],
        { cwd, encoding: 'utf8' })
      remoteTags = listed.split('\n').map((line) => line.replace('refs/tags/', '').trim()).filter(Boolean)
    }
    let ciPayload = null
    if (repository) {
      // Scoped to the commit being tagged and to the channel that builds it, and asked about
      // the workflow the caller named — see `ciRunsApiPath` for what the old literal bought.
      const json = execFileSync('gh', ['api', ciRunsApiPath({ repository, workflow, sha: headSha })],
        { cwd, encoding: 'utf8' })
      ciPayload = JSON.parse(json)
    }
    facts = { version, headSha, originMainSha, existingTags: [...new Set([...localTags, ...remoteTags])], ciPayload, workflow }
  } catch (error) {
    process.stderr.write(`assert-tag-ready: 问不到必要的事实（${error?.message ?? String(error)}）——"读不到"不是"可以打"，判 2。\n`)
    return 2
  }
  if (!repository) {
    // Without the repository name the CI question cannot be asked at all. Refusing beats
    // shipping a guard whose central judgment silently defaults to "yes".
    process.stderr.write('assert-tag-ready: 没给 --repository owner/name，无法问 CI 在这笔 commit 上绿没绿——判 2，不给放行。\n')
    return 2
  }
  const judgment = judgeTagReady(facts)
  if (!judgment.ok) {
    process.stderr.write(`assert-tag-ready: 不能打 v${version}。\n  ✗ ${judgment.reason}\n`)
    if (judgment.run?.html_url) process.stderr.write(`  run: ${judgment.run.html_url}\n`)
    process.stderr.write('  remedy: 先让那笔 commit 的 CI 绿（修代码，或等另一条线把它拦的那格补齐），再按顺序 push → 核 CI → '
      + `git tag v${version} && git push origin v${version}。已存在的 tag 一律不覆盖，取下一个号。\n`)
    return 1
  }
  process.stdout.write(`assert-tag-ready: ${judgment.reason}\n`)
  process.stdout.write(`下一步：git tag -s v${version} && git push origin v${version}\n`)
  return 0
}

function invokedAsEntrypoint() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedAsEntrypoint()) {
  process.exitCode = main(process.argv.slice(2))
}
