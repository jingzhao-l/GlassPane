/**
 * qoder-20261024-release-chain.test.mjs — 发布链修复（D1/D2）的 Node 侧闸。
 *
 * 被轮数上限切断的那条泳道改完了 `scripts/assert-tag-ready.mjs` 与
 * `.github/workflows/release.yml`，最后一句"现在写发布链修复的 Node 测试文件"没有落地。
 * 这里补的是那一句，四条各钉一件事：
 *
 *   ① `ciRunsApiPath`：问题必须钉在 `head_sha=` 与 `event=push` 上，且**问哪条 workflow 由
 *      参数决定**——从前 `--workflow` 只进文案、API 路径写死 `ci.yml`（"用法说一件事、查询
 *      做另一件事"就是这条闸要收掉的那一格）。
 *   ② `runsForSha`：喂"别的 commit 的一条 success + 目标 sha 的一条 failure"，留下的必须
 *      只有目标那条——别人的绿不许把这棵树的红洗掉；喂没有 `head_sha` 字段的合成 payload
 *      按既有约定放行（真 API 永远填这个字段，拒掉合成 payload 等于把判据换成对夹具的猜测）。
 *   ③ `judgeTagReady` 端到端：payload 里唯一绿的 run 属于另一枚 sha 时，tag 不许放行。
 *   ④ `release.yml` 的 `npm-publish`：那步"这个 tag 的 GitHub Release 必须已对外"存在且形状
 *      对——从**文件文本**按步切块断言（`check-workflows --jobs` 不带每步的 `env:`，而
 *      "GH_TOKEN 配在它自己那步"这一格只有按字节切块才分得出它在本步还是兄弟步）。写法照
 *      `updater/test/daily-20261022-gates.test.mjs`：判据指得到字节，且每条都自带反例。
 *
 * REVERSE MUTATIONS（每条都在 2026-10-24 实测过红的那一行，恢复用
 * /var/tmp/glasspane-main-check/snapshots/relt/ 的备份并以 shasum -a 256 核回）：
 *   · `ciRunsApiPath` 里 `${encodeURIComponent(workflow)}` → 写死 `ci.yml`（修复前的形状）
 *     → `①` 红，报文点名 nightly 树被问成了 ci.yml；
 *   · `runsForSha` 的谓词 `!at || at === wanted` → `return true` → ② 红（别人的记录没被丢）；
 *   · `judgeTagReady` 里 `judgeCiGreen({ workflow_runs: scopedRuns }, …)` →
 *     `judgeCiGreen(ciPayload ?? {}, …)`（scope 白算了）→ ③ 红，别的 sha 的绿被放行；
 *   · 从该步 `env:` 删掉 `GH_TOKEN: ${{ github.token }}` 一行 → ④ 红（GH_TOKEN 判据指不到字节）；
 *   · 从 `--json` 删掉 `targetCommitish` → ④ 红（四条判据缺了一条，而 gh 会照答其余三条——
 *     正是本仓"验证器自己跑不动"的那格）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ciRunsApiPath, runsForSha, judgeTagReady, WORKFLOW_DEFAULT } from '../../scripts/assert-tag-ready.mjs'
import { judgeCiGreen } from '../../scripts/assert-ci-green.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHA = 'a'.repeat(40)
const OTHER = 'd'.repeat(40)

/** GitHub runs 记录的最小形状：判据吃 status/conclusion/created_at/head_sha。 */
const run = ({ sha, at, conclusion = 'success', status = 'completed', id }) => ({
  id, run_number: id, head_sha: sha, created_at: at, status, conclusion,
  html_url: `https://github.example/runs/${id}`,
})

test('① ciRunsApiPath 把问题钉在 head_sha 与 event=push 上，workflow 名取自参数而不是写死 ci.yml', () => {
  const asked = ciRunsApiPath({ repository: 'jingzhao-l/GlassPane', workflow: 'release-nightly.yml', sha: SHA })
  assert.match(asked, new RegExp(`head_sha=${SHA}`), `查询没钉在这枚 commit 上：${asked}`)
  assert.match(asked, /event=push/, `没钉 push 通道——PR/schedule/dispatch 的 run 验的不是 main 的字节：${asked}`)
  assert.match(asked, /workflows\/release-nightly\.yml\/runs/,
    `--workflow 被写死的文件名顶掉了（修复前 :129 就是 const file = 'ci.yml'）：${asked}`)
  // 反方向也要判：参数给的是别的 workflow 时，路径里**不许**出现 ci.yml 那一段。
  assert.ok(!/workflows\/ci\.yml\/runs/.test(asked), asked)
  // 缺省仍然是 ci.yml——`--workflow` 不给时不许变成空段。
  assert.match(ciRunsApiPath({ repository: 'r/g', sha: OTHER }), new RegExp(`workflows/${WORKFLOW_DEFAULT}/runs`))
  // sha 不是一枚 commit id 就不许拼出"查所有 commit"的查询——那正是缺陷的形状。
  assert.throws(() => ciRunsApiPath({ repository: 'r/g', workflow: 'ci.yml', sha: '' }), TypeError)
  assert.throws(() => ciRunsApiPath({ repository: 'r/g', workflow: 'ci.yml', sha: 'not-a-sha' }), TypeError)
})

test('② runsForSha：别的 commit 的一条 success 洗不掉目标 sha 的那条 failure；没有 head_sha 的合成 payload 按约定放行', () => {
  const payload = {
    workflow_runs: [
      // 别的 commit 上的绿，而且更新——按 created_at 取最新的旧读法会把它当成证据。
      run({ sha: OTHER, at: '2026-10-24T02:00:00Z', id: 21 }),
      // 目标 sha 上唯一的一条是红的。
      run({ sha: SHA, at: '2026-10-24T01:00:00Z', conclusion: 'failure', id: 20 }),
    ],
  }
  const kept = runsForSha(payload, SHA)
  assert.equal(1, kept.length, `目标树之外的记录必须丢掉：${JSON.stringify(kept)}`)
  assert.equal(SHA, kept[0].head_sha)
  assert.equal('failure', kept[0].conclusion, '留下的必须是目标那一条')
  // 判 red 的必须是目标那条：把过滤结果交给共用的 judge，红话点名的是 #20，不是别人的绿。
  const verdict = judgeCiGreen({ workflow_runs: kept }, { workflow: 'ci.yml', sha: SHA })
  assert.equal(verdict.ok, false, '别人洗不掉的这条红必须仍是红')
  assert.match(verdict.reason, /#20 failure/, verdict.reason)
  assert.ok(!/#21/.test(verdict.reason), `红话里不许把被排除的记录算进来：${verdict.reason}`)
  // 合成 payload（没有 head_sha 字段）：真 API 永远填这个字段，拒掉它们等于重写既有夹具，
  // 所以约定是"没声称 = 不与这枚 sha 矛盾"，放行；范围由上面那个 head_sha= 查询自己钉。
  const synthetic = runsForSha({ workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] }, SHA)
  assert.equal(1, synthetic.length, '没有 head_sha 的记录不许被当成"别的 commit"丢掉')
  assert.deepEqual([], runsForSha(null, SHA), 'payload 读不到就是空集，不是崩')
  // 大小写：sha 比对不许因为十六进制的大小写把同一枚 commit 判成"别的"。
  assert.equal(1, runsForSha({ workflow_runs: [{ head_sha: SHA.toUpperCase(), id: 3 }] }, SHA).length)
})

test('③ judgeTagReady 端到端：payload 里唯一绿的 run 属于另一枚 sha 时，tag 不许放行', () => {
  const base = { version: '2.0.0', headSha: SHA, originMainSha: SHA, existingTags: [] }
  const verdict = judgeTagReady({
    ...base,
    ciPayload: { workflow_runs: [run({ sha: OTHER, at: '2026-10-24T03:00:00Z', id: 31 })] },
  })
  assert.equal(verdict.ok, false, `别的 commit 的绿被当成这棵树的证据放行了：${verdict.reason}`)
  // 是"没有这棵树的记录"，不是"等一条不属于这棵树的 run"：pending 不许被冒充成在路上。
  assert.notEqual(true, verdict.pending, verdict.reason)
  assert.match(verdict.reason, /没有任何运行记录/, verdict.reason)
  // 被排除的那条不许悄悄消失——说过"排除"才算说过。
  assert.match(verdict.reason, /head_sha 不是/, verdict.reason)
  // 对照（判据不是被放宽成一律红）：同一枚 sha 上自己的绿仍然放行。
  const honest = judgeTagReady({ ...base, ciPayload: { workflow_runs: [run({ sha: SHA, at: '2026-10-24T03:00:00Z', id: 32 })] } })
  assert.equal(true, honest.ok, honest.reason)
})

// ---------------------------------------------------------------------------
// ④ release.yml 文本闸：按步切块，GH_TOKEN 的归属只认字节，不认"job 里反正有"。
// ---------------------------------------------------------------------------

/**
 * 把 `<repo>/.github/workflows/release.yml` 里某个 job 的每一步切成块。
 * 切法与 `scripts/check-workflows.mjs` 的 job 边界一致（job 键 = 2 空格缩进，
 * 步 = 6 空格 `- `），这里只重切成"步"这一层——`--jobs` 的输出不带每步的 env，
 * 而这一条判据（token 在本步还是兄弟步）需要的正是每步粒度。
 */
function stepBlocksOfJob(workflowText, jobName) {
  const lines = workflowText.split('\n')
  const jobAt = lines.findIndex((l) => new RegExp(`^  ${jobName}:\\s*(#.*)?$`).test(l))
  assert.notEqual(jobAt, -1, `workflow 文本里没有 job "${jobName}"`)
  let jobEnd = lines.length
  for (let i = jobAt + 1; i < lines.length; i++) {
    if (/^ {0,2}\S/.test(lines[i])) { jobEnd = i; break }
  }
  const blocks = []
  let current = null
  for (let i = jobAt + 1; i < jobEnd; i++) {
    if (/ {6}- /.test(lines[i])) {
      if (current) blocks.push(current)
      current = { line: i + 1, lines: [] }
    }
    if (current) current.lines.push(lines[i])
  }
  if (current) blocks.push(current)
  return blocks.map((b) => ({ line: b.line, text: b.lines.join('\n') }))
}

/** 正文的"能执行的那几行"：注释行不参与判据（prose 里出现 gh/GH_TOKEN 不算配置）。 */
const codeLines = (blockText) => blockText.split('\n').filter((l) => !/^\s*#/.test(l))

test('④ release.yml 的 npm-publish 有一步读回 isDraft/assets/targetCommitish，dry 跳过，GH_TOKEN 在它自己那步的 env 里', () => {
  const text = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8')
  const steps = stepBlocksOfJob(text, 'npm-publish')
  assert.ok(steps.length >= 2, `npm-publish 只切出 ${steps.length} 步，切块器先瞎了`)
  const step = steps.find((s) => /- name: This tag must already be a public GitHub Release/.test(s.text))
  assert.ok(step, `npm-publish 里没有"这个 tag 的 GitHub Release 必须已对外"这一步（行 ${steps.map((s) => s.line).join(',')}）`)
  const code = codeLines(step.text).join('\n')

  // 判据一：真的问了 gh，且要的是那四个字段的读回。
  assert.match(code, /gh release view "\$WANT" --json tagName,isDraft,assets,targetCommitish/,
    '这一步没有向 gh 要 tagName,isDraft,assets,targetCommitish 的逐字读回')
  // 判据二：读回来的三个量各自落地成 shell 变量并被单独判（缺一个就是一条永远绿的判据）。
  assert.match(code, /IFS=\$'\\t' read -r DRAFT ASSET_COUNT TARGET_READ/,
    '读回的 isDraft/assets/targetCommitish 没有被逐列收进变量：三条判据无从各自变红')
  assert.match(code, /"\$\{DRAFT:-<空>\}" != "false"/, 'isDraft 那一格没判')
  assert.match(code, /-lt 1/, 'assets 数量那一格没判（空资产列表的发布放行了）')
  assert.match(code, /TARGET_READ\}" != "\$\{HEAD_SHA\}/, 'target 与本轮 commit 的比对那一格没判')

  // 判据三：mode 不是 publish 时跳过——守卫在 gh 之前，且分支是 exit 0 不是 exit 1。
  const guardAt = code.indexOf('!= "publish"')
  const viewAt = code.indexOf('gh release view')
  assert.notEqual(guardAt, -1, '这一步没有 `MODE != "publish"` 的守卫：dry 也会被这条闸咬')
  assert.ok(viewAt > guardAt, 'gh 的调用在 mode 守卫之前：dry 模式不再安全')
  const guardBody = code.slice(guardAt, code.indexOf('fi', guardAt))
  assert.match(guardBody, /exit 0/, 'mode 守卫的跳过分支必须体面退出，而不是掉进下面的判据')

  // 判据四：GH_TOKEN 配在**这一步自己的** env: 里。切块保证兄弟步上的 token 会被算成没有——
  // 这正是下面反例自证要钉的形状（判据得指得到字节）。
  const envSegment = step.text.slice(0, step.text.search(/^ {8}run:/m))
  assert.match(envSegment, /^ {8}env:$/m, '这一步没有自己的 env: 块')
  assert.match(envSegment, /GH_TOKEN: \$\{\{ github\.token \}\}/,
    `gh 读 GH_TOKEN，runner 给的是 GITHUB_TOKEN——本步 env 里没有 GH_TOKEN 就是 v1.16.2 那一格的复现`)
  assert.match(envSegment, /MODE: \$\{\{ github\.event\.inputs\.mode \}\}/,
    'mode 守卫读的 ${MODE} 必须由本步 env 提供')
})

test('④ 的自证：切块器分得出"token 在本步"与"token 在兄弟步"（判据不是空转）', () => {
  const synthetic = [
    'jobs:',
    '  npm-publish:',
    '    steps:',
    '      - name: sibling with the token',
    '        env:',
    '          GH_TOKEN: ${{ github.token }}',
    '        run: |',
    '          set -euo pipefail',
    '          echo sibling',
    '      - name: This tag must already be a public GitHub Release before the registry gets it',
    '        run: |',
    '          gh release view "$WANT" --json tagName,isDraft,assets,targetCommitish',
    '  next-job:',
    '    steps: []',
  ].join('\n')
  const steps = stepBlocksOfJob(synthetic, 'npm-publish')
  assert.equal(2, steps.length, `切块数不对：${JSON.stringify(steps.map((s) => s.line))}`)
  const target = steps[1]
  assert.match(target.text, /gh release view/, '目标步没被切成独立一块')
  const envSegment = target.text.slice(0, target.text.search(/^ {8}run:/m))
  assert.ok(!/GH_TOKEN/.test(envSegment),
    '切块把兄弟步的 env 也算进了目标步——上一条对 release.yml 的绿就是这个切块器恒真的证据')
  // job 边界：next-job 不许被算进 npm-publish 的步里。
  assert.ok(!steps.some((s) => /next-job|steps: \[\]/.test(s.text)), 'job 边界没切住：跨 job 的文本会被当成步')
})
