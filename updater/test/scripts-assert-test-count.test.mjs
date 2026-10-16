/**
 * `scripts/assert-test-count.mjs` 自己的闸（2026-10-15）。
 *
 * 它要挡的是"跑过了但一条用例都没跑"——本仓栽过两次同形的事：一个 lint 脚本顶层自跑 +
 * exit，让 import 它的测试以 `ℹ tests 0` 收绿；归档检查锚在 `^harness/`，而 tar 里所有条目
 * 都在单一顶层目录下，一条不中，空过成绿。CI 的 swift job 三步是 `swift build` / `swift test`
 * / `swift test`，退出码只说"没失败"，不说"有没有东西在跑"。
 *
 * 夹具不是手写的：`fixtures/swift-test-runner-lines.log` 是从本机
 * `swift test --package-path engine`（HEAD 58da7be 的基线绿跑）逐字截出的 runner 行；
 * 0 用例那一条用的是本机 `swift test --package-path engine/probe` 真打出来的
 * `Test run with 0 tests in 0 suites passed`。
 *
 * 反向变异：把脚本里"两种 runner 都必须出声"改成只数一种 → 第 2 条红；把下限判据改成
 * `<= 0` 之类让它永远绿 → 第 3、4 条红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'assert-test-count.mjs')
const REAL = path.join(HERE, 'fixtures', 'swift-test-runner-lines.log')

function run(label, floor, files) {
  return spawnSync(process.execPath, [SCRIPT, label, String(floor), ...files], {
    encoding: 'utf8',
    cwd: REPO,
  })
}

function writeFixture(name, text) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-test-count-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, text)
  return { dir, file }
}

test('真日志：两种 runner 都出了声，下限 1 达标', () => {
  const r = run('engine', 1, [REAL])
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /XCTest \d+ 条/)
  assert.match(r.stdout, /Swift Testing \d+ 条/)
  // 总计行（带 skipped 子句那条）必须被认出来，否则报的是套件行的最大值而不是这一趟的数。
  const total = /Executed (\d+) tests, with \d+ tests skipped and \d+ failures/.exec(fs.readFileSync(REAL, 'utf8'))
  assert.ok(total, '夹具该含那条总计行')
  assert.match(r.stdout, new RegExp(`XCTest ${total[1]} 条`), `没读到总计行的数：${r.stdout}`)
})

test('一半 runner 没出声就是红，不是"少了一种行形"（反向变异点）', () => {
  const lines = fs.readFileSync(REAL, 'utf8').split('\n').filter((l) => !l.includes('Test run with'))
  const f = writeFixture('only-xctest.log', lines.join('\n'))
  const r = run('engine', 1, [f.file])
  assert.equal(r.status, 1, `Swift Testing 一条没报就该红：${r.stdout}${r.stderr}`)
  assert.match(`${r.stderr}`, /Swift Testing/, '红话要点名是哪一半没出声')
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('0 条用例的绿跑必须红（这条闸存在的唯一理由）', () => {
  // 真形状：本机 probe 那趟里 Swift Testing 半侧就是这一行。
  const f = writeFixture('zero.log', [
    'Executed 0 tests, with 0 failures (0 unexpected) in 0.001 (0.002) seconds',
    '✔ Test run with 0 tests in 0 suites passed after 0.001 seconds.',
  ].join('\n'))
  const r = run('probe', 1, [f.file])
  assert.equal(r.status, 1, `一条都没跑还退 0 的那趟必须被判红：${r.stdout}${r.stderr}`)
  assert.match(`${r.stderr}`, /下限/, r.stderr)
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('日志里报了失败就红，哪怕数量过下限', () => {
  const f = writeFixture('failing.log', [
    'Executed 1065 tests, with 3 tests skipped and 2 failures (2 unexpected) in 33.6 (33.8) seconds',
    '✔ Test run with 15 tests in 2 suites passed after 1.5 seconds.',
  ].join('\n'))
  const r = run('engine', 1, [f.file])
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /失败/, r.stderr)
  fs.rmSync(f.dir, { recursive: true, force: true })
})

test('下限 0 与读不到的日志都不算绿（2 = 环境问题，不是通过）', () => {
  const zeroFloor = run('engine', 0, [REAL])
  assert.equal(zeroFloor.status, 2, '下限 0 就是这条闸自我取消')
  const missing = run('engine', 1, [path.join(REPO, 'no-such-log.txt')])
  assert.equal(missing.status, 2, `${missing.stdout}${missing.stderr}`)
  const noArgs = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: REPO })
  assert.equal(noArgs.status, 2, '缺参数不许当成功')
})
