/**
 * 预检的探测面 = 文档里那句数量主张。2026-10-22 那条发现的形状是：三个数字各说各话。
 *
 * `README.md` 写 "four of these rows"、`README.zh-CN.md` 写「只实测这张表里的四项」，而那张表
 * 五行、代码里 `checkEnvironment()` 探的是五项命令（`node`/`npm`/`swift`/`git`/`open`），同一段
 * 落的下一句还写着"这五项"。没有读者，所以两份文档一起错也绿。修法分两半：
 *   1. `installer/cli.js:PREFLIGHT_PROBED_COMMANDS` 成为那个数量的真源（一个数组，不是散文）；
 *      `scripts/check-doc-links.mjs` 的那条主张从它算，README 两份的数量句由它核。
 *   2. 本文件钉住"这个数组里每一项**真的**有一条拒绝路径"——否则那个数就是另一句散文，
 *      只是换了一个地方写。
 *
 * REVERSE MUTATION：
 *   · 从数组里删掉 `open` → 本文件第一条红（映射表里还有它），而 README 那条主张由文档闸判红；
 *   · 把 `checkEnvironment()` 里 `open: commandAvailable('open')` 那一行删掉（数组不动）→ 本文件
 *     第二条红：那一项不再被探测，文档却还写着探测它；
 *   · 把 `preflightIssues` 里 `if (!env.open)` 那一臂删掉 → 第一条里"缺它要报得出它"的断言红：
 *     探测做了、拒绝不做，等于"假设它存在"那条被禁的路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  PREFLIGHT_PROBED_COMMANDS,
  checkEnvironment,
  preflightIssues,
} from '../cli.js'
import { CLAIMS, preflightProbedCommands } from '../../scripts/check-doc-links.mjs'

const REPO = path.resolve(import.meta.dirname, '..', '..')

/**
 * 每一项命令在它**缺席**时应该由哪个 env 字段承载、拒绝句子里要出现什么词。
 * 这张表是本文件唯一的判据来源：它与 `PREFLIGHT_PROBED_COMMANDS` 必须同集合，
 * 那条同集合断言才是"数组加一项而探测没跟上"的抓手。
 */
const PROBE_SURFACE = {
  node: { key: 'nodeMajor', absent: 0, names: 'node' },
  npm: { key: 'npm', absent: false, names: 'npm' },
  swift: { key: 'swift', absent: false, names: 'swift' },
  git: { key: 'git', absent: false, names: 'git' },
  open: { key: 'open', absent: false, names: 'open' },
}

/** 一个"全都齐"的快照——从真源 `checkEnvironment()` 拿，不在这里抄一份字段清单。 */
function allPresent() {
  const env = checkEnvironment({ nodePath: process.execPath })
  return { ...env, nodeMajor: Math.max(env.nodeMajor, 99), nodeOk: true, npm: true, swift: true, git: true, open: true }
}

test('预检数组、探测字段与拒绝句子三者是同一个集合', () => {
  assert.deepEqual([...PREFLIGHT_PROBED_COMMANDS].sort(), Object.keys(PROBE_SURFACE).sort(),
    'PREFLIGHT_PROBED_COMMANDS 与本文件的映射表不再是同一批命令：文档里那个数量主张跟着漂了')
  const good = allPresent()
  assert.deepEqual(preflightIssues(good), [], '全都齐时预检不许报任何事——否则下面每一条"只缺一项"的红都可能是背景噪音')
})

test('数组里的每一项被单独拿掉时，预检都拒绝并且说得出是哪一项', () => {
  for (const command of PREFLIGHT_PROBED_COMMANDS) {
    const surface = PROBE_SURFACE[command]
    const missing = { ...allPresent(), [surface.key]: surface.absent }
    const issues = preflightIssues(missing)
    assert.ok(issues.length >= 1, `缺 ${command} 时预检什么都没报：那一项是"假设它存在"的路径`)
    const line = issues.find((text) => text.toLowerCase().includes(surface.names))
    assert.ok(line, `缺 ${command} 的拒绝没点名它（这一条就是文档里那句"逐条报哪项"）：${issues.join(' / ')}`)
    assert.equal(issues.length, 1, `只缺 ${command} 却报了 ${issues.length} 条：其它项的探测把没缺的东西也报成缺了`)
  }
})

test('checkEnvironment 探的就是数组声明的那几项，一个不多一个不少', () => {
  const keys = Object.keys(checkEnvironment({ nodePath: process.execPath }))
  // node 这一项在快照里是 `nodeMajor`/`nodeOk` 两个读数，不是布尔 `node`。
  const covered = keys.filter((k) => k !== 'nodeOk' && k !== 'nodeMajor')
  assert.deepEqual([...covered, 'nodeMajor'].sort(), ['git', 'nodeMajor', 'npm', 'open', 'swift'],
    '探测面与本文件认的那批字段漂了：新增的探测没人核，删掉的探测文档还写着有')
  for (const command of PREFLIGHT_PROBED_COMMANDS) {
    assert.ok(keys.includes(PROBE_SURFACE[command].key), `${command} 在数组里，但 checkEnvironment() 不再读 ${PROBE_SURFACE[command].key}`)
  }
})

test('文档闸从代码算的那个数量，就是这个数组的长度', () => {
  // 这一条钉的是"真源接对了"：`check-doc-links` 的正则从 cli.js 里读那个字面量，
  // 读不到时它只报"读不到"，读错形状时（比如把注释里的那个名字也吃进去）它报的是一个
  // 谁也没写的数。把两边放在同一行里比，红的时候说的是"闸量的不是这块代码"。
  assert.equal(preflightProbedCommands(REPO)?.length, PREFLIGHT_PROBED_COMMANDS.length,
    'check-doc-links 从 installer/cli.js 解析出的命令数与实际导出的数组不等')
  const claim = CLAIMS.find((c) => c.id === '预检实测的命令数')
  assert.ok(claim, 'CLAIMS 里没有「预检实测的命令数」：README 的那句数量又回到没人核的状态')
  assert.equal(claim.truth(REPO), PREFLIGHT_PROBED_COMMANDS.length)
  for (const doc of ['README.md', 'README.zh-CN.md']) {
    const text = fs.readFileSync(path.join(REPO, doc), 'utf8')
    const pattern = doc.endsWith('zh-CN.md') ? claim.zh : claim.en
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    assert.equal([...text.matchAll(re)].length, 1,
      `${doc} 里那句数量主张命中 ${[...text.matchAll(re)].length} 次：0 次是这句话改名了、闸空转，>1 是同一个数写了两遍`)
  }
})
