/**
 * remedy 的升权面（本轮审查的一条真实发现）。
 *
 * 为什么这一条必须成闸：remedy 在本产品里是**被当作命令消费**的（`mcp-shell` 原样转发、
 * `tools.ts` 渲染给 agent，SECURITY.md §3 就是这个口径）。上一版的 `probe-failed` 写的是
 * `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain <pem>`
 * ——一句可以照着执行的就地命令。任何被注入的一轮都能拿它把一张根证书装成**全机**信任：
 * 影响这台机器上每一个 app，且不会被任何一次校验发现。比 §2.8 那条反复权衡过的放宽大得多。
 *
 * 三条断言，一条都不能只是"跑过了"：
 *  1. 每个状态**实际**回给调用方的 remedy 里不许出现升权命令的形状；
 *  2. 扫描器必须能拒绝当年那一句原文（负例留在文件里，不是摆设）；
 *  3. `ca-bundle.js` 的状态分支必须被逐个覆盖——新增一个状态而这份夹具没跟上，
 *     这条闸就会在看不见的地方绿着。
 *
 * REVERSE MUTATION：把 `probe-failed` 的 remedy 换回上面那句原文 → 第 1 与第 2 条红；
 * 把第 2 条的负例删掉 → 那条具名用例红（扫描器从此证明不了自己会拒绝）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeCa } from '../lib/ca-bundle.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * What counts as handing out an escalation. Each alternative is a shape that has
 * appeared in this product's own prose, not a hypothetical: an elevated install of
 * a root of trust, a bypassed verification, an ownership sweep, and a pipe of a
 * remote script into a shell.
 */
const ESCALATION = [
  { name: 'sudo', re: /\bsudo\b/ },
  { name: 'trustRoot installed into the system keychain', re: /add-trusted-cert[^\n]*(-k\s*\/Library\/Keychains|-r\s+trustRoot)/ },
  { name: 'a bypassed verification', re: /--no-verify|--insecure|strict-ssl[^,}]*false/i },
  { name: 'an ownership or permission sweep', re: /\b(chmod|chown)\s+-[a-zA-Z]*R\b/ },
  { name: 'a remote script run by a shell', re: /\b(curl|wget)[^|\n]*\|\s*(\/bin\/)?(ba)?sh\b/ },
]

/** The sentence this gate was written for. Kept here on purpose: the scanner has
 *  to be able to refuse it, or the gate proves nothing. */
const HISTORICAL_PROBE_FAILED_REMEDY =
  'the intercepting root is not in the system keychains, or the network really is down. '
  + 'Import it ("sudo security add-trusted-cert -d -r trustRoot '
  + '-k /Library/Keychains/System.keychain /path/to/the-intercepting-root.pem"), '
  + 'or export NODE_EXTRA_CA_CERTS to a bundle you control before invoking the updater.'

const OFFENDING = (text) => ESCALATION.filter(({ re }) => re.test(text)).map(({ name }) => name)

// Every branch `describeCa` can take, with a record shaped like the one
// `exportCaBundle` actually writes (path/certs/detail are read by the prose).
const RECORDS = [
  { label: '(no record)', record: null },
  { label: 'ok', record: { status: 'ok', path: '/Users/dev/.glasspane/ca-roots.pem', certs: 147 } },
  { label: 'empty', record: { status: 'empty', path: '/Users/dev/.glasspane/ca-roots.pem' } },
  { label: 'empty without a bundle', record: { status: 'empty', path: null } },
  { label: 'unavailable', record: { status: 'unavailable', path: null, detail: 'no /usr/bin/security' } },
  { label: 'write-unverified', record: { status: 'write-unverified', path: '/Users/dev/.glasspane/ca-roots.pem', detail: 'still 644' } },
  { label: 'probe-failed', record: { status: 'probe-failed', path: '/Users/dev/.glasspane/ca-roots.pem', certs: 147, detail: 'unable to verify the first certificate' } },
  { label: 'a status this build does not know', record: { status: 'from-the-future', path: null } },
]

test('每个状态回给调用方的 remedy，都不许是一句可以照着执行的升权命令', () => {
  for (const { label, record } of RECORDS) {
    for (const bundlePath of [null, '/Users/dev/.glasspane/ca-roots.pem']) {
      const { remedy, summary } = describeCa(record, { bundlePath })
      if (remedy === null) continue
      const offenders = OFFENDING(remedy)
      assert.deepEqual(offenders, [], `${label} 的 remedy 把升权动作写成可执行命令（${offenders.join(', ')}）：${remedy}`)
      assert.ok(remedy.length > 0)
      assert.ok(summary.length > 0)
    }
  }
})

test('扫描器能拒绝当年那一句原文，也认出现在那句点名工具的写法', () => {
  // 第 2 条：这一条是**对照**。一个只会通过的扫描器等于没有扫描器。
  assert.deepEqual(
    OFFENDING(HISTORICAL_PROBE_FAILED_REMEDY),
    ['sudo', 'trustRoot installed into the system keychain'],
    '当年那一句必须被这道闸拒绝——它拒绝了，第 1 条才有内容',
  )
  // 第 3 条：现在的 remedy 仍然**点名**修复办法（工具名在句子里），只是不再给出可执行形状。
  const now = describeCa({ status: 'probe-failed', path: '/x/ca-roots.pem', certs: 147, detail: 'y' }).remedy
  assert.match(now, /add-trusted-cert/, '点名工具是这条 remedy 的价值，不许被这道闸削成"找个人看看"')
  assert.match(now, /NODE_EXTRA_CA_CERTS/, 'agent 自己就能执行的那半区必须在句子里')
})

test('describeCa 交出去的每一句 caller-facing 散文都不许是升权命令', () => {
  // 静态的一半：不只在 `describeCa` 的返回值上测——将来新分支若不走这张表，
  // 第 1 条看不见它。这里把整张表里的字符串字面量逐条扫过去（含 `remedy:` 用三元式
  // 分支写的那两条：只盯 `remedy: '<引号>'` 的写法会漏掉它们，本条第一次跑就红在
  // "只抠出 5 条"上——计数闸的作用就是让这种漏检不能静默通过）。
  const raw = fs.readFileSync(path.join(HERE, '..', 'lib', 'ca-bundle.js'), 'utf8')
  const from = raw.indexOf('export function describeCa')
  const sliced = raw.slice(from, raw.indexOf('\n}', from))
  // 注释要剥掉：本文件把当年那句原文**留在注释里**当作教训，扫描器把它当成交出去的
  // 话就会红在自己身上——那可不是这条闸想说的话。剥注释的写法沿用
  // `mcp-shell/test/http-gateway.test.mjs` 的 `gatewayCode()`。
  const body = sliced
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.ok(body.length > 500, 'describeCa 的函数体没抠出来，这条闸已经不作数了')
  const literals = [...body.matchAll(/'((?:[^'\\]|\\[\s\S])*)'|"((?:[^"\\]|\\[\s\S])*)"|`((?:[^`\\]|\\[\s\S])*)`/g)]
    .map((m) => [m[1], m[2], m[3]].find((s) => s !== undefined))
    .filter((s) => s.length > 30)
  assert.ok(literals.length >= 10,
    `describeCa 里只认出 ${literals.length} 条给调用方的话，这条对照已经看不见东西`)
  for (const literal of literals) {
    assert.deepEqual(OFFENDING(literal), [],
      `一句话把升权动作写成了可执行命令：${literal.slice(0, 120)}`)
  }
})

test('状态分支与这份夹具一一对应，新增一个状态不许悄悄不被扫', () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'lib', 'ca-bundle.js'), 'utf8')
  const branches = new Set(
    [...source.matchAll(/\bcase '([a-z-]+)':/g)].map((m) => m[1]),
  )
  const covered = new Set(RECORDS.map(({ record }) => record?.status).filter((s) => s !== undefined))
  const missing = [...branches].filter((status) => !covered.has(status))
  assert.deepEqual(missing, [], `这些状态分支没有被扫到：${missing.join(', ')}——给它们补一条夹具，而不是删掉断言`)
  assert.ok(branches.size >= 5, `只认出 ${branches.size} 个状态分支，这条对照已不作数`)
})

/* ------------------------------------------------------------------ 整条 lib */

/**
 * 2026-10-09 复审把这条闸的覆盖面从 `ca-bundle.js` 一个文件扩到**整个 lib**，因为它
 * 当年就是只盯着一份文件才漏掉的：`lib/apply.js` 的 `npm-prefix-unwritable` remedy 把
 * `sudo chown -R "$(whoami)" <dir>` 交给了读者，而 `<dir>` 逐字来自
 * `npm config get prefix`（也就是来自 `~/.npmrc`，同账户任意进程都写得动）。那句话会
 * 进 `lastError.message`，面板原样打印、`mcp-shell` 原样转发给 agent —— 等于把一段
 * 攻击者选的 shell 以 root 交出去。SECURITY.md §3 的口径是：升权动作只**点名**，不替
 * 人写好命令。
 *
 * REVERSE MUTATION：把 apply.js 那句 remedy 换回 `sudo chown -R …` → 下面第 1、2 条一起红。
 */

/** 注释要剥掉：这些文件把当年那几句原文**留在注释里**当教训，扫描器把它们当成交出去的
 *  话就会红在自己身上——那不是这条闸想说的话。剥法沿用上面 `describeCa` 那一条。 */
function codeOnly(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

/** 会被交给读者/agent 的字符串字面量（长的才是句子，短的是键名与片段）。 */
function spokenLiterals(code) {
  return [...code.matchAll(/'((?:[^'\\]|\\[\s\S])*)'|"((?:[^"\\]|\\[\s\S])*)"|`((?:[^`\\]|\\[\s\S])*)`/g)]
    .map((m) => [m[1], m[2], m[3]].find((s) => s !== undefined))
    .filter((s) => s.length > 30)
}

const LIB_JS = fs.readdirSync(path.join(HERE, '..', 'lib')).filter((name) => name.endsWith('.js')).sort()

test('整个 lib 的代码（剥掉注释）里，一句 sudo 都不许出现', () => {
  assert.ok(LIB_JS.includes('apply.js') && LIB_JS.includes('source.js'),
    `这条闸必须真的盖到 apply.js 与 source.js，扫到的却是：${LIB_JS.join(', ')}`)
  assert.ok(LIB_JS.length >= 15, `只认出 ${LIB_JS.length} 份 lib 文件，这条对照已经看不见东西`)
  for (const name of LIB_JS) {
    const code = codeOnly(fs.readFileSync(path.join(HERE, '..', 'lib', name), 'utf8'))
    assert.ok(code.length > 200, `lib/${name} 抠不出代码体，这条闸对它不作数`)
    assert.doesNotMatch(code, /\bsudo\b/, `lib/${name} 的代码里出现了 sudo：升权命令不许出现在任何交给读者的话里`)
    const offenders = OFFENDING(code)
    assert.deepEqual(offenders, [], `lib/${name} 交出升权命令的形状：${offenders.join(', ')}`)
  }
})

test('整个 lib 交出去的每一句长字符串，都不是可以照着执行的升权命令', () => {
  let spoken = 0
  for (const name of LIB_JS) {
    const code = codeOnly(fs.readFileSync(path.join(HERE, '..', 'lib', name), 'utf8'))
    for (const literal of spokenLiterals(code)) {
      spoken += 1
      assert.deepEqual(OFFENDING(literal), [],
        `lib/${name} 里一句话把升权动作写成了可执行命令：${literal.slice(0, 140)}`)
    }
  }
  assert.ok(spoken >= 300, `只认出 ${spoken} 条要交给读者的话，这条对照已经不作数`)
})

test('换成"点名动作"之后，那条 remedy 仍然点得出工具与路径，并说清不许 agent 代跑', () => {
  // 这条是第 1、2 条的对照面：一道只会拒绝的闸会把 remedy 削成"找个人看看"，那同样是
  // 产品规则的失守（读者必须知道要改**哪一个**目录、这件事只能**谁**去做）。
  const code = codeOnly(fs.readFileSync(path.join(HERE, '..', 'lib', 'apply.js'), 'utf8'))
  const npmRemedy = spokenLiterals(code).join('\n')
  assert.ok(/terminal|privileged/.test(npmRemedy), 'apply.js 里找不到那条点名动作的 npm-prefix remedy')
  assert.match(npmRemedy, /at a terminal/, '要说清这一步只能由一个人在终端做')
  assert.match(npmRemedy, /will not run a privileged command/, '也要说清程序自己不跑，更不会把它交给 agent')
  assert.ok(code.includes('JSON.stringify'), '路径必须 JSON 引起来，读者才知道路径在哪里结束')
  assert.ok(code.includes('npm config get prefix'), '路径是从 npm 读来的这件事必须交代，人才会去核')
})
