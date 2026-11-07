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
import { LOCKFILES, SITES, expectedFor } from './version-sites.mjs'

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
export function judgeTagReady({ version, headSha, originMainSha, existingTags = [], ciPayload, workflow = WORKFLOW_DEFAULT, siteDrift = [] }) {
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
  // 版本号必须在那枚 commit 的字节里成立，不是在工作树里。`set-version` 之后漏 add 一枚位点，
  // 本机 check-version 仍会绿（它读工作树），而 tag 一旦打下去，registry 与 Release 钉的就是那枚
  // 少了一位的树。判据取自 commit：见 `committedSiteDrift` 头上那段。
  if (siteDrift.length > 0) {
    return {
      ok: false,
      reason: `v${version} 的那枚 commit 里，版本线位点不自洽（共 ${siteDrift.length} 处）：\n`
        + siteDrift.map((line) => `      · ${line}`).join('\n')
        + `\n——这一枚不能被签成 tag：发布物与主干的版本号必须由 commit 自己证明，不能由工作树证明。`,
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

/**
 * `origin/main` 的 tip — 问**远端**，不问本地那一枚跟踪引用。
 *
 * 从前这一格读的是 `git rev-parse refs/remotes/origin/main`：那是本地上一次 `git fetch` 留下的快照。
 * 另一条线在我们上一次 fetch 之后推了 Y，本地仍旧写着 X ⇒ tip 判据把 X 当成 main 的 tip 放过，
 * 于是一枚签名 tag、一份 Release 与 npm 上的两个包全部钉在 X，而 main 已经在 Y —— 与文件顶部
 * 那句"HEAD 必须就是 origin/main 的 tip"直接冲突。fetch 与否不是这条判据能假设的前置条件。
 *
 * `--repository` 没给时这里也**不许**退回本地快照：tip 判据宁可答"读不出来"（judge 那一侧回 2）。
 * 读不到不是绿。
 */
export function remoteMainSha(cwd) {
  const out = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd, encoding: 'utf8' })
  const sha = out.split('\n').map((line) => line.split('\t')[0] ?? '').find((s) => /^[0-9a-f]{40}$/.test(s))
  if (!sha) throw new Error('git ls-remote origin refs/heads/main 没答出一枚 commit id')
  return sha
}

/**
 * 位点值取自**被 tag 的那枚 commit 的字节**，不取自工作树。
 *
 * 为什么需要它（2026-11-07 本机实测的自伤）：`set-version 1.31.1` 改了 15 份文件，而发布提交只
 * `git add` 了 14 份——被推上去的那枚 commit 里 `installer/cli.js` 的 `RELEASE_VERSION` 还是
 * `1.31.0`。`check-version.mjs` 本机照样回"OK（1.31.1）"，因为它量的是工作树；CI 量的是那枚
 * commit，于是三条 job 红。版本号一旦被签成 tag，"发布物 == 主干 == 位点表"这三件事就只能靠
 * commit 自己的字节来证——所以这道闸在放行 tag 之前，逐枚位点去读 HEAD 的那一份。
 *
 * `textOf` 是接缝：测试把"从 commit 读"注入进来，判定本体保持纯函数。
 */
export function committedSiteDrift(version, textOf) {
  const drift = []
  for (const site of SITES) {
    const text = textOf(site.file)
    const want = expectedFor(site, version)
    if (text === null || text === undefined) {
      drift.push(`${site.file}：被 tag 的那枚 commit 里读不到这份文件（位点在表上而树上没有）`)
      continue
    }
    if (want === null) {
      drift.push(`${site.file}：版本 ${version} 取不出 major.minor 段，而这一位记的就是段——不猜`)
      continue
    }
    const flags = site.regex.flags.includes('g') ? site.regex.flags : `${site.regex.flags}g`
    const hits = [...text.matchAll(new RegExp(site.regex.source, flags))]
    if (hits.length !== 1) {
      drift.push(`${site.file}：位点正则在那枚 commit 的字节里命中 ${hits.length} 次（应为 1 次）`)
      continue
    }
    if (hits[0][2] !== want) {
      drift.push(`${site.file}：commit 里是 ${hits[0][2]}，本版要发的是 ${want}`)
    }
  }
  for (const lock of LOCKFILES) {
    const text = textOf(lock.file)
    if (text === null || text === undefined) {
      drift.push(`${lock.file}：被 tag 的那枚 commit 里读不到这份 lock`)
      continue
    }
    let data
    try { data = JSON.parse(text) } catch {
      drift.push(`${lock.file}：commit 里的那一份不是合法 JSON，版本无从判断`)
      continue
    }
    for (const key of lock.keys) {
      const entry = data.packages?.[key]
      if (!entry || entry.link || !entry.version) continue
      if (entry.version !== version) {
        drift.push(`${lock.file} packages[${JSON.stringify(key === '' ? '(root)' : key)}]：commit 里是 ${entry.version}，本版是 ${version}`)
      }
    }
  }
  return drift
}

export function main(argv, { cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), readTip = remoteMainSha } = {}) {
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
      // 问远端（`remoteMainSha`），不问本地跟踪引用：见上面那段注释里的失效模式。
      originMainSha = readTip(cwd)
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
    const committedText = (file) => {
      try { return git(['show', `HEAD:${file}`], cwd) } catch { return null }
    }
    const siteDrift = committedSiteDrift(version, committedText)
    facts = { version, headSha, originMainSha, existingTags: [...new Set([...localTags, ...remoteTags])], ciPayload, workflow, siteDrift }
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
