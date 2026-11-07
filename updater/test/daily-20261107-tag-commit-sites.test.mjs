/**
 * 每日任务 2026-11-07 · tag 之前，版本线必须由**那枚 commit 的字节**自证，而不是由工作树自证。
 *
 * 缺陷（我自己造的，读数在下面这一节里）：`node scripts/set-version.mjs 1.31.1` 改了 15 份文件，
 * 而 `release: 1.31.1` 那一笔逐个路径 `git add` 时列了 14 份，漏掉 `installer/cli.js`。
 * 于是被推上去的那枚 commit 里 `RELEASE_VERSION` 仍是 `1.31.0`；本机
 * `node scripts/check-version.mjs` 照样回 "OK：版本线一致（1.31.1）"——因为它量的是工作树。
 * CI 量的是那枚 commit，三条 job 一起红（version line、root workspace gate 的两入口逐字节对照、
 * macOS node suites）。这不是 CI 的错，是**这道闸本来就该在 tag 之前挡住**：tag 一旦签下去，
 * 发布物与主干之间那三个"=="里就没有任何东西知道有位点少改了一枚。
 *
 * 修法：`scripts/assert-tag-ready.mjs` 新增 `committedSiteDrift(version, textOf)` 与判定输入
 * `siteDrift`——逐枚位点用 `git show HEAD:<file>` 取那枚 commit 的字节来比，缺失、命中数不是 1、
 * 值不等于本版（`line: true` 的段位点按 `expectedFor` 折算）都算漂移并拒绝 tag。
 *
 * REVERSE：`installer/cli.js` 在 HEAD 里那一位如果又漂一次，第一条红并点名它；
 * 把 `committedSiteDrift` 的期望值从 `expectedFor(site, version)` 换成整条 semver ⇒
 * 第二条（段位点那一格）红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SITES, expectedFor } from '../../scripts/version-sites.mjs'
import { committedSiteDrift, judgeTagReady } from '../../scripts/assert-tag-ready.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const show = (file) => {
  try {
    return execFileSync('git', ['show', `HEAD:${file}`], { cwd: REPO, encoding: 'utf8' })
  } catch {
    return null
  }
}

const headVersion = () => {
  const text = show('package.json')
  assert.ok(text, 'HEAD 里读不到根 package.json——这条闸没有对照物')
  return JSON.parse(text).version
}

test('HEAD 那枚 commit 的字节里，版本线的每一枚位点都等于本版（漏 add 一次就红）', () => {
  const version = headVersion()
  const drift = committedSiteDrift(version, show)
  assert.deepEqual(drift, [],
    `被 tag 的那枚 commit 里版本线不自洽：\n  ${drift.join('\n  ')}\n`
    + '（本机工作树可能已经是新的了——那正是本条要抓的形状。）')
  assert.ok(SITES.length >= 15, `位点表只剩 ${SITES.length} 枚，这条对照测不到什么`)
})

test('段位点（line: true）按段比较，不拿整条 semver 去比', () => {
  const lined = SITES.filter((s) => s.line)
  assert.ok(lined.length >= 1, '位点表里没有段位点了——这一条对照失去对象')
  const version = '1.31.4'
  for (const site of lined) {
    const want = expectedFor(site, version)
    assert.equal(want, '1.31', `${site.id} 的期望值应当折成段`)
    const text = show(site.file)
    assert.notEqual(text, null, `${site.file} 在 HEAD 里读不到`)
    const flags = site.regex.flags.includes('g') ? site.regex.flags : `${site.regex.flags}g`
    const hits = [...text.matchAll(new RegExp(site.regex.source, flags))]
    assert.equal(hits.length, 1, `${site.file} 的正则命中 ${hits.length} 次`)
    // 拿"整条 semver"当期望值是这次修复前后最容易犯的错：段位点永远比不中，闸就长红。
    assert.notEqual(hits[0][2], version, `${site.id} 记的不是整条 semver`)
  }
})

test('四种漂移各自点名，且干净的一份字节不报任何东西', () => {
  const version = headVersion()
  const real = show
  const textOf = (file) => (file === 'installer/cli.js'
    ? real('installer/cli.js').replace(new RegExp(`'${version}'`), "'1.31.0'")
    : real(file))
  const drift = committedSiteDrift(version, textOf)
  assert.ok(drift.some((line) => /installer\/cli\.js.*1\.31\.0.*本版.*1\.31\.1|installer\/cli\.js/.test(line)),
    `漏 add 的那一枚没被点名：${drift.join(' | ')}`)

  // 缺失与"正则命中数不是 1"也必须是具名漂移，而不是静默通过。
  assert.match(committedSiteDrift(version, (f) => (f === 'package.json' ? null : real(f))).join('\n'),
    /package\.json.*读不到/)
  const twoHits = committedSiteDrift(version, (f) => (f === 'installer/package.json'
    ? `"version": "0.0.0",\n"version": "0.0.1",\n`
    : real(f)))
  assert.match(twoHits.join('\n'), /installer\/package\.json.*命中 2 次/, twoHits.join(' | '))

  // lock 里少改一位同样点名（root 那格与子包那格分开报）。
  const lockText = JSON.stringify({
    name: '@glasspane/monorepo',
    lockfileVersion: 3,
    packages: { '': { version: '0.0.0' }, installer: { version: '0.0.0' } },
  })
  assert.match(committedSiteDrift(version, (f) => (f === 'package-lock.json' ? lockText : real(f))).join('\n'),
    /package-lock\.json.*0\.0\.0/)

  assert.deepEqual(committedSiteDrift(version, real), [], '干净的一份字节不该报任何东西')
})

test('判定侧：漂移存在就不放行 tag，理由里带着那几行', () => {
  const sha = 'a'.repeat(40)
  const base = { version: '9.9.9', headSha: sha, originMainSha: sha, existingTags: [], ciPayload: { workflow_runs: [] } }
  const refused = judgeTagReady({ ...base, siteDrift: ['installer/cli.js：commit 里是 1.31.0，本版要发的是 9.9.9'] })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /位点不自洽/)
  assert.match(refused.reason, /installer\/cli\.js/, '拒绝的理由必须把漂移那一枚带到读者面前')
})
