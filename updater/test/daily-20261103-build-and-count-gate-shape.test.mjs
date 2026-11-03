/**
 * 本轮（2026-11-03）在"构建脚本 + 数数的闸"这两把尺子上修掉的四处。
 *
 * 共同点：**判据或退码只写了一半**。
 *  - `engine/scripts/make-app.sh`：图标那一圈 `sips` 在 `set -eu` 下没有守卫（同一段里
 *    `iconutil` 有），一枚尺寸失败 = 整个 bundle 构建致命失败 = 更新器那条 staged build
 *    在这台机器上永远过不去；未知选项退 64 而两处入口（install.sh / installer/cli.js）对
 *    同一件事退 2；`--settings-bin --skip-daemon` 把第二枚旗标当路径吞掉；两个 skip 都给时
 *    一个产物都没造却打印"输出目录"退 0。
 *  - `scripts/assert-test-count.mjs`：Swift Testing 的总计行**自带**失败数
 *    （`… failed after 1.586 seconds with 3 issues.`），而那道闸只从 XCTest 行取 failures，
 *    于是"只有 Swift Testing 那一半红"的一趟在闸上读起来是绿的。
 *
 * 每条都有正反两面，且都跑真进程：make-app.sh 是被 `/bin/sh` 真的叫起来的，退码是真退码；
 * assert-test-count 吃的是本轮 `swift test` 打出来的那份**真日志**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(REPO, 'engine', 'scripts', 'make-app.sh')
const COUNT = path.join(REPO, 'scripts', 'assert-test-count.mjs')

function runMake(args, outDir) {
  return spawnSync('/bin/sh', [SCRIPT, ...args, '--out', outDir], {
    cwd: REPO, encoding: 'utf8', timeout: 120_000,
  })
}

function mkOut() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-make-app-'))
}

/* ---------------------------------------------------------------- 退码与旗标 */

test('make-app：未知选项的退码与两处入口同价（2，不是 64）', () => {
  const dir = mkOut()
  try {
    const r = runMake(['--nonsense'], dir)
    assert.equal(r.status, 2, `未知选项该退 2（install.sh 与 installer/cli.js 都是 2），实际 ${r.status}：${r.stderr}`)
    assert.match(r.stderr, /未知选项/, r.stderr)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('make-app：取值型旗标不许把下一枚旗标当路径吞掉', () => {
  const dir = mkOut()
  try {
    const swallowed = runMake(['--settings-bin', '--skip-daemon'], dir)
    assert.equal(swallowed.status, 2, `--settings-bin 后面跟的是旗标，这一支该停下而不是继续建：${swallowed.stdout}${swallowed.stderr}`)
    assert.match(swallowed.stderr, /收到的是另一枚旗标/, swallowed.stderr)

    // 这一支不能借 runMake：它会在末尾补 `--out <dir>`，于是脚本读到的其实是
    // `--out --out <dir>`——那是"旗标吞旗标"那一档，不是"后面什么都没有"那一档。
    const missing = spawnSync('/bin/sh', [SCRIPT, '--out'], { cwd: REPO, encoding: 'utf8', timeout: 60_000 })
    assert.equal(missing.status, 2, `旗标后面没有取值时也要退 2：${missing.stderr}`)
    assert.match(missing.stderr, /需要取值/, missing.stderr)

    // 对照：三个取值旗标都走同一个用量子——少一个就是"改一处漏一处"的那个形状。
    const source = fs.readFileSync(SCRIPT, 'utf8')
    const usesGuard = (source.match(/takes_value "\$1" "\$\{2-\}"/g) ?? []).length
    assert.equal(usesGuard, 3, `三个取值旗标该有三处 takes_value，实测 ${usesGuard}——漏的那个就是下一次吞旗标的地方`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('make-app：两个 bundle 都跳过时，"什么都没产出"不是一种成功', () => {
  const dir = mkOut()
  try {
    const r = runMake(['--skip-settings', '--skip-daemon'], dir)
    assert.equal(r.status, 2, `两个 skip 都给 = 一个产物都没造，退码不能是 0。实退 ${r.status}\n${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /不产出任何 bundle/, r.stderr)
    assert.doesNotMatch(r.stdout + r.stderr, /输出目录/, "'输出目录' 那句成功话不许在零产出时说出口：" + r.stdout)
    const made = fs.existsSync(dir) ? fs.readdirSync(dir) : []
    assert.deepEqual(made, [], `这一趟不该产出任何东西，实际产出：${made.join(', ')}`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

/* ------------------------------------------------------------------ 图标那一圈 */

test('make-app：sips 失败降级为"无图标"，而不是判死整个构建（iconutil 早有守卫）', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8')
  const sipsLines = source.split('\n').filter((l) => /^\s*sips /.test(l))
  assert.equal(sipsLines.length, 0, `还有一行裸 sips 在 set -eu 之下：${sipsLines.join('\n')}`)
  const guarded = source.split('\n').filter((l) => l.includes('if ! sips '))
  assert.equal(guarded.length, 1, 'sips 那一圈必须恰好有一支守卫（0 支 = 缺陷回来，2 支 = 有第二条路径）')
  assert.match(source, /sips 生成 .* 失败，跳过图标/, '降级必须说实话并写明"无图标"')
  // 同一段里 iconutil 的守卫必须还在——两处写盘失败都该是"跳过图标"，不是"构建死了"。
  assert.match(source, /if iconutil -c icns .*; then/, 'iconutil 那一半的守卫不许跟着没')
})

test('make-app：产品脚本里不许留开发机解释器的绝对路径', () => {
  const all = fs.readFileSync(SCRIPT, 'utf8')
  // 注释里留着那个路径是可以的（它记的是"为什么不再要它"）；**可执行的那几行**里不许有。
  const code = all.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(code, /\/opt\/miniconda3/,
    '开发机上的 conda 解释器路径进了产品脚本的可执行行：换一台机器"有图标"就变成"构建失败"')
  const candidates = /for candidate in ([^;]*); do/.exec(code)
  assert.ok(candidates, '找不到解释器候选那一行——这条对照的判据形状变了，重读它')
  assert.match(candidates[1], /python3/, candidates[1])
  assert.ok(candidates[1].trim().split(/\s+/).length <= 3, `候选表又被加长成"某个人机器上的清单"了：${candidates[1]}`)
  assert.match(all, /GLASSPANE_PYTHON/, '要指定解释器就只走这一枚显式旗标')
})

/* -------------------------------------------------------- 数数的闸要看得见失败 */

const REAL_LOG = `
Test Suite 'All tests' started at 2026-11-03.
\t Executed 1577 tests, with 5 tests skipped and 1 failure (0 unexpected) in 56.305 (56.490) seconds
✘ Suite "每日 2026-11-03：引擎侧的四条" failed after 0.036 seconds with 1 issue.
✘ Test run with 76 tests in 8 suites failed after 1.586 seconds with 3 issues.
`

test('assert-test-count：Swift Testing 的 "with N issues" 计入失败（只有它红的一趟不许读成绿）', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-count-'))
  try {
    // 夹具是"两半都出声"的一份真日志，只有 Swift Testing 那一半带失败——这才隔离出本轮改的那一条。
    // 前一版这里把 XCTest 行删掉去造反例，结果红是红了，红的理由却是"那条线没跑用例"
    // （`日志里没有一行 XCTest 的 Executed N tests`），本条要问的 failures 会计根本没被碰到。
    const onlyTesting = path.join(dir, 'testing-failures.log')
    fs.writeFileSync(onlyTesting, REAL_LOG.replace(
      'Executed 1577 tests, with 5 tests skipped and 1 failure',
      'Executed 1577 tests, with 5 tests skipped and 0 failure',
    ))
    const r = spawnSync(process.execPath, [COUNT, 'engine', '1', onlyTesting], { cwd: REPO, encoding: 'utf8' })
    assert.notEqual(r.status, 0, `只有 Swift Testing 报 3 issues，这道闸却绿了：${r.stdout}${r.stderr}`)
    assert.match(`${r.stdout}${r.stderr}`, /日志里报了 3 条失败/,
      `必须因为 failures 计数非零而红，不是别的理由：${r.stdout}${r.stderr}`)

    // 反面对照：同一份日志把两半都改成通过 ⇒ 必须零。少了这一半，"恒红"也算通过。
    const passed = path.join(dir, 'passed.log')
    fs.writeFileSync(passed, REAL_LOG
      .replace('Executed 1577 tests, with 5 tests skipped and 1 failure', 'Executed 1577 tests, with 5 tests skipped and 0 failure')
      .replace('Suite "每日 2026-11-03：引擎侧的四条" failed after 0.036 seconds with 1 issue.', 'Suite "每日 2026-11-03：引擎侧的四条" passed after 0.036 seconds.')
      .replace('Test run with 76 tests in 8 suites failed after 1.586 seconds with 3 issues.', 'Test run with 76 tests in 8 suites passed after 1.586 seconds.'))
    const g = spawnSync(process.execPath, [COUNT, 'engine', '1', passed], { cwd: REPO, encoding: 'utf8' })
    assert.equal(g.status, 0, `合法形状被误红：${g.stdout}${g.stderr}`)

    // 第三面：XCTest 那一侧报 1 failure 时必须照样红（本轮没把它改坏）。
    const xcui = path.join(dir, 'xcuitest-failure.log')
    fs.writeFileSync(xcui, REAL_LOG.replace(
      'Test run with 76 tests in 8 suites failed after 1.586 seconds with 3 issues.',
      'Test run with 76 tests in 8 suites passed after 1.586 seconds.',
    ))
    const x = spawnSync(process.execPath, [COUNT, 'engine', '1', xcui], { cwd: REPO, encoding: 'utf8' })
    assert.notEqual(x.status, 0, 'XCTest 那一半报 1 failure 也要红')
    assert.match(`${x.stdout}${x.stderr}`, /日志里报了 1 条失败/, `${x.stdout}${x.stderr}`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
