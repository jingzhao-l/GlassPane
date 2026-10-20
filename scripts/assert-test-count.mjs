#!/usr/bin/env node
/**
 * assert-test-count.mjs — 一条跑过 0 条用例的测试命令不许算过。
 *
 * 为什么需要它：CI 的 swift job 三步是 `swift build` / `swift test` / `swift test`。
 * `swift test` 的退出码只说"没失败"，它不说"有没有东西在跑"。把用例全删掉、让 glob 匹配
 * 空、或让某个 target 一条都没链上，退出码仍然是 0，而那一格在页面上是绿的。本仓已经栽过
 * 两次同形的事：一个 lint 脚本顶层自跑 + exit 让 import 它的测试以"0 条用例通过"收绿；
 * 归档类检查锚在 `^harness/` 而 tar 里全在单一顶层目录下，一条不中，空过成绿。
 *
 * 判据用**两种runner各自的行**：XCTest 打 `Executed N tests, with M failures (…)`，
 * Swift Testing 打 `Test run with N tests in M suites`。只数一种，另一种清零就看不见。
 * 两种都必须至少出现一次，且各自求和 ≥ 给定下限。**每份日志还要各自至少执行一条**——
 * 合起来数会让第二份空日志躲在第一份的计数后面（2026-10-20 实测：probe 那条线清零仍绿）。
 *
 * 下限为什么由调用方给：Swift 那条线一直有按设计跳过的真机项，数量会随环境动；这里要挡的是
 * "根本没有用例在跑"，不是"少了几条"，所以传一个保守的 1，而不是把一个会随正常改动衰减的
 * 大数钉进 CI。
 *
 * 用法：node scripts/assert-test-count.mjs <label> <floor> <log-file> [<log-file> …]
 * 退出：0 达标；1 不达标（红）；2 用法/日志读不到（环境问题，不许当成绿）。
 */
import fs from 'node:fs'

// 两种行形都要吃：`Executed 18 tests, with 0 failures (0 unexpected)`（每套件），
// 以及带跳过子句的总计行 `Executed 1065 tests, with 3 tests skipped and 0 failures`。
// 只匹配前一种会把总计行整个漏掉——那样一来"有失败"也只会在套件行上看得见，
// 而 XCTest 恰恰把最终失败数报在总计行上。
// `tests?` / `failures?` / `suites?` 这几个单数不是凑数：一条只有 1 个用例或 1 个 suite 的
// 线（2026-10-20 实测：`Test run with 2 tests in 1 suite`）在复数写法下一行都匹配不上，
// 于是"这一半 runner 没出声"——把一个真跑了的套件读成零。
const XCUITEST = /Executed (\d+) tests?, with(?: (\d+) tests? skipped and)? (\d+) failures?/g
const SWIFT_TESTING = /Test run with (\d+) tests? in (\d+) suites?/

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n`)
  process.stderr.write('usage: node scripts/assert-test-count.mjs <label> <floor> <log-file> [...]\n')
}

const [label, floorRaw, ...files] = process.argv.slice(2)
if (!label || floorRaw === undefined || files.length === 0) {
  usage('label, floor and at least one log file are required')
  process.exit(2)
}
const floor = Number(floorRaw)
if (!Number.isInteger(floor) || floor < 1) {
  // 0 作下限是这条闸的自我取消：它就该在"一条都没跑"的时候红。
  usage(`floor must be an integer >= 1, got ${floorRaw}`)
  process.exit(2)
}

let xcuitestSum = 0
let swiftTestingSum = 0
let xcuitestSeen = 0
let swiftTestingSeen = 0
let failures = 0
const silent = []

for (const file of files) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    process.stderr.write(`error: cannot read ${file}: ${error.message}\n`)
    process.exit(2)
  }
  // Per-file measurement, then pooled for the floor. Pooling the *shapes* is what let the
  // probe lane run zero cases and stay green: `engine`'s log alone satisfies "both runners
  // spoke", so a second log contributing nothing was invisible. Each log must therefore
  // show at least one executed test of at least one shape — `engine/probe` is a Swift
  // Testing-only package (measured: no `Executed N tests` line in its log), so requiring
  // both shapes *per file* would be a false requirement, and requiring none would be this
  // same gate's own bug.
  let fileTests = 0
  for (const match of text.matchAll(XCUITEST)) {
    xcuitestSeen += 1
    xcuitestSum = Math.max(xcuitestSum, Number(match[1]))
    fileTests = Math.max(fileTests, Number(match[1]))
    // 套件行与总计行都会计入，可能重复；这里只需要"> 0 就是红"，不需要精确失败条数。
    failures += Number(match[3])
  }
  const testing = SWIFT_TESTING.exec(text)
  if (testing) {
    swiftTestingSeen += 1
    swiftTestingSum = Math.max(swiftTestingSum, Number(testing[1]))
    fileTests = Math.max(fileTests, Number(testing[1]))
  }
  if (fileTests === 0) silent.push(file)
}

const reasons = []
if (xcuitestSeen === 0) reasons.push('日志里没有一行 XCTest 的 `Executed N tests`（那条线一条用例都没跑，或跑错了 target）')
if (swiftTestingSeen === 0) reasons.push('日志里没有一行 Swift Testing 的 `Test run with N tests`（那一半 runner 没出声）')
if (silent.length > 0) {
  reasons.push(`这些日志一条用例都没执行：${silent.join(', ')}（合在一起的计数会把空的那份洗掉）`)
}
if (xcuitestSum + swiftTestingSum < floor) {
  reasons.push(`实到 XCTest ${xcuitestSum} + Swift Testing ${swiftTestingSum} < 下限 ${floor}`)
}
if (failures > 0) reasons.push(`日志里报了 ${failures} 条失败`)

const line = `test-count[${label}]: XCTest ${xcuitestSum} 条(${xcuitestSeen} 行) · Swift Testing ${swiftTestingSum} 条 · floor ${floor} · ${files.length} 份日志(${silent.length} 份空)`
if (reasons.length > 0) {
  process.stderr.write(`${line}\n`)
  for (const reason of reasons) process.stderr.write(`  ✗ ${reason}\n`)
  process.stderr.write('  remedy: 让那一条测试线真的跑到用例（检查 --package-path / glob / target 是否空），不要用 --skip 让它闭嘴。\n')
  process.exit(1)
}
process.stdout.write(`${line}\n  ✓ 两种 runner 都出了声，总数过下限\n`)
