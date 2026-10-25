/**
 * 发布链的三格（D2 / D5 / D6-b）——用 `scripts/check-workflows.mjs --jobs` 这一个读法问
 * workflow，不在这里写第二套 YAML 正则（`updater/test/daily-20261022-gates.test.mjs` 立的
 * 规矩：两个读者各写各的正则，agreeing 只是因为它们是两把同一形状的错误尺子）。
 *
 * D2（`.github/workflows/release.yml` 的 `npm-publish`）：dispatch 那条通道原来只问两件事——
 * 这棵树等不等于 tag、这棵树的 ci.yml 绿没绿。**没有任何一环问"这个 tag 的 GitHub Release
 * 是否已对外且带资产"**。于是 registry 上有包、`releases/latest` 还在服务上一版，而同一文件
 * `github-release` 那一步自己写明了后果：`updater/lib/check.js` 把"最新已发布的版本比本机
 * 跑的还旧"读成 `up-to-date` + exit 0，每台机器静默不再更新。`needs: github-release` 不能加
 * ——那个 job 是 `if: github.event_name == 'push'`，dispatch 时它是 skipped，加 needs 等于
 * 永久锁死这条通道，所以问的是**状态**不是**顺序**。
 *
 * D5：三条 workflow 共 14 个 job，`grep -c timeout-minutes` 在 HEAD 上是 0/0/0 —— 全在 GitHub
 * 默认的 6 小时上跑。
 *
 * D6-b：`harness-contract.yml` 的 "Skip when latest equals the pin" 那一步正文一行闸门都没有
 * （原来 rule 2a 只做 `bash -n`：语法对、闸门松，看不见）。同一步里那条 `printf | grep -Eq`
 * 也不能留着：正文一旦带上 pipefail，`grep -q` 命中即走、printf 死在 SIGPIPE 上，一个**合法**
 * 的 probe_tag 会被判成形状不合法。
 *
 * 对着未改实现的红那一行（三条都在 2026-10-24 实测过，红在 HEAD=61153ffd 的那份文件上）：
 *   ① `AssertionError: npm-publish 的正文里没有任何一句问这个 tag 的 Release：
 *      /…/qoder-….test.mjs` — 具体是 `body.includes('gh release view') === false`；
 *   ② `AssertionError: 14 个 job 里声明了 timeout-minutes 的是 0 个`；
 *   ③ `AssertionError: 那一步仍然把闸门押在 runner 的默认 shell 上`（正文第一行是
 *      `pinned="$(node -p …)"`），以及 `grep -Eq` 还挂在 printf 管道尾巴上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHECK_WORKFLOWS = path.join(REPO, 'scripts', 'check-workflows.mjs')
const PRIMARY = ['ci.yml', 'release.yml', 'harness-contract.yml']

/** 同一把尺子：job 表由 `check-workflows` 自己读，这里只消费它的答案。 */
function jobsOf(workflow) {
  const got = spawnSync(process.execPath, [CHECK_WORKFLOWS, '--jobs'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(got.status, 0, `check-workflows --jobs 退 ${got.status}：${got.stderr}`)
  const rows = JSON.parse(got.stdout)
  assert.ok(Array.isArray(rows) && rows.length, `--jobs 答了个空集：${got.stdout.slice(0, 200)}`)
  return rows.filter((row) => row.workflow === workflow)
}

const bodyOf = (job) => job.runs.map((r) => r.text).join('\n')
const readWorkflow = (name) => fs.readFileSync(path.join(REPO, '.github', 'workflows', name), 'utf8')

test('npm-publish 在 publish 分支上必须先核实这个 tag 的 GitHub Release，再碰 registry（D2）', () => {
  const job = jobsOf('release.yml').find((row) => row.name === 'npm-publish')
  assert.ok(job, 'release.yml 里没有 npm-publish 这条 job')
  const body = bodyOf(job)
  const view = /gh\s+release\s+view\s+"\$\{?WANT\}?"/.exec(body)
  assert.ok(view, `npm-publish 的正文里没有任何一句问这个 tag 的 Release：${body.slice(0, 400)}`)
  // 四条判据都得在，且用的是 gh 真答得出的字段（规则 3a2 盯的就是这一件事）。
  for (const field of ['isDraft', 'assets', 'targetCommitish', 'tagName']) {
    assert.match(body, new RegExp(`${field}`), `Release 判据少了 ${field} 那一半`)
  }
  assert.match(body, /DRAFT.*!=.*false|isDraft/, '读回来必须**判**，不是打印')
  assert.match(body, /ASSET|assets/, '资产为空的那个发布等于没发')
  assert.match(body, /TARGET/, 'target 不是本轮 commit 时，Release 服务的是别的树')
  // 顺序判据：这一步必须在**第一次** `npm publish` 之前——publish 不可逆。
  const viewAt = body.indexOf(view[0])
  const publishAt = body.indexOf('npm publish')
  assert.ok(viewAt > -1 && viewAt < publishAt,
    'Release 的核实发生在 npm publish 之后，等于事后才知道发错了')
  // dry 不查（它不写 registry），且不许用 needs 把通道锁死。
  assert.match(body.slice(Math.max(0, viewAt - 1400), viewAt), /MODE.*!=.*publish|mode 不是 publish/,
    'dry 分支必须在此之前退场')
  assert.doesNotMatch(readWorkflow('release.yml').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'),
    /needs:\s*(\[.*\]\s*)?github-release/,
    'needs: github-release 会永久锁死这条通道：那个 job 在 dispatch 时是 skipped')
})

test('三条 workflow 的 14 个 job 都给了 timeout-minutes，发布那两条容得下自己内部的等待（D5）', () => {
  const rows = PRIMARY.flatMap((wf) => jobsOf(wf).map((row) => ({ ...row, workflow: wf })))
  assert.equal(14, rows.length, `读到 ${rows.length} 个 job，不是 14：${rows.map((r) => r.name).join(', ')}`)
  const missing = rows.filter((row) => !/^\d+$/.test(String(row.timeoutMinutes ?? '')) || Number(row.timeoutMinutes) < 1)
  assert.deepEqual([], missing.map((row) => `${row.workflow}/${row.name}:${row.timeoutMinutes}`),
    `${missing.length} 个 job 没有 timeout-minutes（GitHub 默认 360 分钟）`)
  // 判据自己的预算不能超过 job 的天花板：`assert-ci-green --budget 1200000` 是 20 分钟，
  // 一条 25 分钟的 job 会在"CI 还在跑、正在等"的正常形状上被咬断。
  for (const row of rows.filter((r) => /assert-ci-green/.test(bodyOf(r)))) {
    const budgets = [...bodyOf(row).matchAll(/--budget\s+(\d+)/g)].map((m) => Number(m[1]))
    const needed = Math.ceil(Math.max(...budgets, 0) / 60000)
    assert.ok(Number(row.timeoutMinutes) > needed,
      `${row.workflow}/${row.name} 的 timeout=${row.timeoutMinutes}m 容不下它自己 --budget ${needed}m 的等待`)
  }
  // 两条 macOS job 是这条 lane 最贵的东西，但不能给到比实测还短：HEAD 上量到 429s / 229s / 51s，
  // 所以 30 分钟是"慢四倍仍然过"，而不是随手一个大数。
  const mac = rows.filter((row) => /macos/i.test(String(row.runsOn ?? '')))
  assert.equal(3, mac.length, `macOS job 读到 ${mac.length} 条`)
  for (const row of mac) {
    assert.ok(Number(row.timeoutMinutes) >= 30, `${row.name} 的 ${row.timeoutMinutes}m 太窄：一次 Xcode 冷构建就能吃掉它`)
    assert.ok(Number(row.timeoutMinutes) <= 45, `${row.name} 的 ${row.timeoutMinutes}m 太宽：实测最慢 429s`)
  }
})

test('D6-b 点名的那一步自己声明闸门，且不再把 grep -q 挂在管道尾巴上', () => {
  const text = readWorkflow('harness-contract.yml')
  const job = jobsOf('harness-contract.yml').find((row) => row.name === 'contract')
  assert.ok(job, 'harness-contract.yml 里没有 contract 这条 job')
  const skipAt = text.indexOf('Skip when latest equals the pin')
  assert.ok(skipAt > -1, '那条 skip 步骤不见了')
  const bodyLines = text.slice(skipAt).split('\n').slice(1)
  const runAt = bodyLines.findIndex((l) => /^\s*(?:-\s+)?run:\s*[|>]/.test(l))
  assert.ok(runAt > -1, 'skip 那一步没有 run 正文')
  const indent = bodyLines[runAt].search(/\S/)
  const firstCode = bodyLines.slice(runAt + 1)
    .map((l) => ({ ind: l.search(/\S/), text: l.trim() }))
    .filter((l) => l.text && !l.text.startsWith('#') && l.ind > indent)
    .map((l) => l.text)[0]
  assert.match(String(firstCode), /^set -euo pipefail$/,
    `那一步仍然把闸门押在 runner 的默认 shell 上：第一行代码是 ${JSON.stringify(firstCode)}`)
  // pipefail 开着的时候，`printf | grep -q` 会自己造出一个假拒绝：grep 命中即走，
  // printf 死在 SIGPIPE 上，管道状态 141，`if !` 把它读成"形状不合法"。
  // 只量**会执行的那几行**：解释这一坑的注释本身带着这个形状，把它判红只会让人删注释。
  const codeOnly = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.doesNotMatch(codeOnly, /printf[^|]*\|\s*grep\s+-E?q/,
    '判据那一行不许再出现 printf|grep -q 这一形')
  // 三条 workflow 的每一条多语句 run 正文都得声明闸门——这是 `check-workflows` 的规则 2d，
  // 这里判的是"它对这三条文件真的成立"，而不是重复它的实现。
  const gate = spawnSync(process.execPath, [CHECK_WORKFLOWS], { cwd: REPO, encoding: 'utf8' })
  assert.equal(gate.status, 0, `check-workflows 红了：\n${gate.stdout}\n${gate.stderr}`)
  assert.doesNotMatch(gate.stderr, /never declares -e\/-u\/pipefail/,
    `还有一条 run 正文没声明闸门：\n${gate.stderr}`)
  assert.doesNotMatch(gate.stderr, /declares no "timeout-minutes"/, gate.stderr)
  // 而那条闸自己得能被证红：新增规则必须在 --self-test 里有变异档。
  const self = spawnSync(process.execPath, [CHECK_WORKFLOWS, '--self-test'], { cwd: REPO, encoding: 'utf8' })
  assert.equal(self.status, 0, `--self-test 红了：\n${self.stdout}\n${self.stderr}`)
  for (const id of ['a job that declares no timeout-minutes', 'leans on the runner', 'declares no GH_TOKEN']) {
    assert.match(self.stdout, new RegExp(`ok self-test: .*${id}`), `${id} 没有一条变异档：等于没有这道闸`)
  }
})
