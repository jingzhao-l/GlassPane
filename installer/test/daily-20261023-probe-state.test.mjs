/**
 * 2026-10-23（缺陷 2）——预检不许把"探测没走完"说成"未找到"。
 *
 * WHY（实测现场，不是假想）。`npm test --workspaces` 整套件并发跑时，
 * `installer/test/review-2026-10-09.test.mjs` 的「finding1: hello 与本轮产物版本一致时才报完成（退出码 0）」
 * 报的是 `这台机器预检先挡了：… 未找到 git（xcode-select --install 会带上它，或 brew install git）`，
 * 而**单独跑这一条恒过**、这台机器上 `/usr/bin/git --version` 一直是好的。旧 `commandAvailable()` 把
 * `spawnSync(...).status === 0` 当唯一判据；超时是 `status:null, error.code:'ETIMEDOUT'`（本机实测，
 * 见下面 timeoutShape 那条），于是"5 秒没答话"和"这台机器没有 git"落进同一个 false。后果有两层：
 *   ① 对用户说"未找到 git，请 xcode-select --install"——把人支去重装一个已经装好的东西；
 *   ② 那条按"预检挡了就跳过"写的真机用例静默不跑，正向分支（退出码 0 / "安装完成" / "实测校验通过"）
 *      在这台 mac 上一次也没被证明过。一条会把自己跳没的闸，等于没有闸。
 *
 * 修法是三档判定（`commandProbe`）：`available` / `absent`（ENOENT 或答了但退非 0）/ `unverified`
 * （探测没走完）。缺席文案照旧；`unverified` 单独一句话，说的是"没能确认"+"手动跑那一条看卡在哪"。
 * 拒绝本身仍然发生——确认不了的依赖不假装齐。第一次 5s，只有"没答话"才补一次 20s：这不是给计时
 * 假红加超时把它糊过去，是把"没答"与"答了不要"分开（非 0 退出仍走缺席那档，一次都不补）。
 *
 * REVERSE MUTATION（每条点自己的名，本机实测）：
 *   · 把 `judge()` 里 `code === 'ENOENT'` 之外的错误也判成 `absent` → 「超时那次不是缺席」红
 *     （unverified 变成 absent，宽预算那一档也红）。
 *   · 删掉 `probeOnce` 的补一次（宽预算）那一步 → 「第一次超时、第二次答话＝可用」红（只剩 absent）。
 *   · 把 `preflightIssues` 里 `env.unverified.includes(name)` 那一臂删掉 → 「预检说的是"未能确认"」红
 *     （超时又会被写成"未找到"）。
 *   · 把 `checkEnvironment()` 里 `unverified` 那条读数删掉 → 「checkEnvironment 把没确认的项记进 unverified」红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import {
  PROBE_STATES,
  PROBE_RETRY_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  checkEnvironment,
  commandAvailable,
  commandProbe,
  preflightIssues,
} from '../cli.js'

const ACCESS_OK = () => {}
const ACCESS_FAIL = () => { throw new Error('ENOENT') }

/** 一台机器上按脚本给出的预算依次回答这些结果的 spawn。 */
function scriptedSpawn(replies) {
  const seen = []
  const spawn = (cmd, args, opts) => {
    const key = `${cmd} ${args.join(' ')}`
    const queue = replies[key]
    if (!queue) throw new Error(`夹具没准备这一条：${key}`)
    const reply = queue.length > 1 ? queue.shift() : queue[0]
    seen.push({ key, timeout: opts.timeout })
    return reply
  }
  return { spawn, seen }
}

test('超时的形状（本机实测）：status 为 null、error.code 是 ETIMEDOUT，而缺席是 ENOENT', () => {
  // 这条不是自证式断言：它钉的是"判据依赖的那个外部事实"。若哪天 node 把超时改报成 status:1，
  // 上面那套三档分类的依据就没了，这条会先红，而不是让分类逻辑悄悄退化成"全部缺席"。
  const hung = spawnSync('/bin/sleep', ['3'], { stdio: 'ignore', timeout: 300 })
  assert.equal(hung.status, null, JSON.stringify({ status: hung.status, code: hung.error && hung.error.code }))
  assert.equal(hung.error?.code, 'ETIMEDOUT', `超时应当报 ETIMEDOUT，实报 ${hung.error?.code}`)
  const missing = spawnSync('definitely-not-a-command-gp', ['--version'], { stdio: 'ignore', timeout: 1000 })
  assert.equal(missing.error?.code, 'ENOENT', `缺席应当报 ENOENT，实报 ${missing.error?.code}`)
})

test('探测超时不是"未找到"：第一档判 unverified，而不是 absent', () => {
  const { spawn } = scriptedSpawn({
    'git --version': [{ status: null, error: { code: 'ETIMEDOUT' } }],
  })
  assert.equal(commandProbe('git', { spawn, access: ACCESS_OK }), PROBE_STATES.unverified,
    '超时被判成缺席＝预检会对着一台装好 git 的机器说"未找到 git"')
  const stillQuiet = scriptedSpawn({ 'git --version': [{ status: null, error: { code: 'ETIMEDOUT' } }] })
  assert.equal(commandAvailable('git', { spawn: stillQuiet.spawn, access: ACCESS_OK }), false,
    '布尔那层仍说"这次没确认成可用"——拒绝照旧发生，只是文案不再撒谎')
})

test('第一次没答话、补一次答了＝可用；补的那一次用的是宽预算', () => {
  const { spawn, seen } = scriptedSpawn({
    'git --version': [
      { status: null, error: { code: 'ETIMEDOUT' } },
      { status: 0 },
    ],
  })
  assert.equal(commandProbe('git', { spawn, access: ACCESS_OK }), PROBE_STATES.available)
  assert.deepEqual(seen.map((s) => s.timeout), [PROBE_TIMEOUT_MS, PROBE_RETRY_TIMEOUT_MS],
    `宽预算那一档必须真的用上：${JSON.stringify(seen)}`)
})

test('答了但退非 0＝缺席，一次都不补（CLT shim 那一档没有被放宽成"再等 20 秒"）', () => {
  const { spawn, seen } = scriptedSpawn({
    'swift --version': [{ status: 1, stderr: 'no developer tools were found' }],
    'xcode-select -p': [{ status: 1, stderr: 'Unable to get active developer directory' }],
  })
  assert.equal(commandProbe('swift', { spawn, access: ACCESS_OK }), PROBE_STATES.absent)
  assert.deepEqual(seen.map((s) => s.key), ['swift --version', 'xcode-select -p'],
    `非 0 退出不是"没答话"，不许再补一次宽的：${JSON.stringify(seen)}`)
})

test('ENOENT＝缺席，且 shim 那两条不碰 /usr/bin 的文件退化检查', () => {
  const { spawn, seen } = scriptedSpawn({
    'git --version': [{ status: null, error: { code: 'ENOENT' } }],
  })
  let accessed = 0
  const countingAccess = () => { accessed += 1; throw new Error('ENOENT') }
  assert.equal(commandProbe('git', { spawn, access: countingAccess }), PROBE_STATES.absent)
  // git 的 shim 探测就是同一条命令的第二次问法（SHIM_PROBE_COMMANDS 里记着），
  // 关键是它**没有**退化到"文件在就当可用"——那正是 finding 6 要防的谎。
  assert.deepEqual(seen.map((s) => s.key), ['git --version', 'git --version'], JSON.stringify(seen))
  assert.equal(accessed, 0, 'shim 易感工具不许由 access() 洗白')
  // open 这类不支持 --version 的，缺席之后仍退回 /usr/bin 检查（旧行为，防把唯一可行的路子改没）。
  const openOnly = scriptedSpawn({ 'open --version': [{ status: 1, stderr: 'unknown option' }] })
  assert.equal(commandProbe('open', { spawn: openOnly.spawn, access: ACCESS_OK }), PROBE_STATES.available)
  assert.equal(commandProbe('open', { spawn: openOnly.spawn, access: ACCESS_FAIL }), PROBE_STATES.absent)
})

test('预检对"未能确认"说的是另一句话，并给出下一条能跑的动作', () => {
  const env = {
    nodeMajor: 22, nodeOk: true, npm: true, swift: true, open: true,
    unverified: ['git'], git: false,
  }
  const issues = preflightIssues(env)
  assert.equal(issues.length, 1, JSON.stringify(issues))
  assert.match(issues[0], /未能确认/, `超时必须说成"没能确认"：${issues[0]}`)
  assert.doesNotMatch(issues[0], /未找到/, `没证据就不许说"未找到"：${issues[0]}`)
  assert.doesNotMatch(issues[0], /xcode-select --install/, `不许把负载问题支去重装 CLT：${issues[0]}`)
  assert.match(issues[0], /`git --version`/, '补救要指到那条能自己看出卡在哪的命令')

  // 缺席那一档的文案一字未动：`未找到 swift（…xcode-select --install…）` 仍是那条真能跑的动作。
  const absentIssues = preflightIssues({ nodeMajor: 22, nodeOk: true, npm: true, swift: false, git: true, open: true })
  assert.equal(absentIssues.length, 1)
  assert.match(absentIssues[0], /未找到 swift/)
  assert.match(absentIssues[0], /xcode-select --install/)
})

test('checkEnvironment 把没确认的项记进 unverified，全健康的这台机器上是空表', () => {
  const env = checkEnvironment({ nodePath: process.execPath })
  assert.ok(Array.isArray(env.unverified), `unverified 必须是一条读数（数组），不是没有这个字段：${JSON.stringify(env)}`)
  for (const name of env.unverified) {
    assert.equal(env[name], false, `${name} 在 unverified 里却又被报成可用：预检于是既不拒绝也不说明`)
  }
  // 这台机器实测五项全齐（CI 的 macOS job 也走这一条）；空表是"确认过"的意思，不是"没探"。
  assert.deepEqual(env.unverified, [], `本机实测应当全确认，实得：${JSON.stringify(env)}`)
  assert.equal(env.git, true)
  assert.equal(env.swift, true)
})

test('接线：探测没走完那一项必须由 checkEnvironment 记进 unverified（不是只有函数会分档）', () => {
  // 判据函数分档在上几条测过了；这一条测**读数是照着分档写的**。反向：把 `checkEnvironment`
  // 里 `unverified` 换成写死的 `[]` → 这条红，而"本机健康"那条照样绿——因为健康的机器上
  // 两者相等。没有这一条，那条读数就等于没人驱动。
  const states = { npm: 'available', swift: 'available', git: PROBE_STATES.unverified, open: 'available' }
  const env = checkEnvironment({ nodePath: process.execPath, probe: (bin) => states[bin] })
  assert.deepEqual(env.unverified, ['git'], `没确认的那一项没被记下来：${JSON.stringify(env)}`)
  assert.equal(env.git, false, 'unverified 的项在布尔那档必须是"不可用"，预检才会拒')
  assert.equal(env.npm, true)
  const issues = preflightIssues(env)
  assert.equal(issues.length, 1, JSON.stringify(issues))
  assert.match(issues[0], /git 未能确认/, `整条链子（探测→读数→文案）要说得出这一项：${issues[0]}`)
})
