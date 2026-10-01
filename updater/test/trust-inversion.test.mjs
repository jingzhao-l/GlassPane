/**
 * §9.3 的守卫：更新这条信任链上的代码从不关闭 TLS 校验，也不把发布站点的请求降到明文。
 *
 * 规格写的是禁令（"不许改 NODE_TLS_REJECT_UNAUTHORIZED、不加 --insecure、不降级到 http"），
 * 而**禁令没有读者就是没有**：1.5.1 之前全仓没有任何一处检查过它。任何一次"先让它跑通"的
 * 改动都能安静地把校验关掉，而 §9 那套导出、探测、状态记录看起来仍然在干活，面板还会显示
 * "自动更新已开"。这条守卫扫的是生产文件本身。
 *
 * 两处精度上的讲究，都是为了让它在人手里活得下来：
 *  · **注释里的词不算**（注释不能执行；写一句"我们从不设这个变量"不该把 CI 弄红）。做法是
 *    带引号状态机的掩码：把注释字符换成空格而**不删**——偏移量保住，报出来的行号就是文件里
 *    那一行。反过来的坑也验过：naive 的"把 `//` 之后全抹掉"会被 `"https://api.github.com"`
 *    里那个 `//` 骗到，把后面一整行代码抹成空白，于是**漏检**——漏检比误伤危险得多。
 *  · 明文 http 只在**真正构造发布请求的那几个文件**里禁。`installer/cli.js` 的 plist DOCTYPE
 *    公共标识符、网关打印的 `http://<监听地址>` 都是合法形状，全局禁会误伤；而
 *    `updater/lib/source.js` 一生只产出一个 URL，那里出现 `http://` 就是降级。
 *
 * 反向变异：自带一次自测（下面第一条），每条禁令词放进假代码必须被扫出来、放进注释必须不被
 * 扫出来；模式表或文件集被清空、或者只扫到几个文件，都会让它变红而不是"0 命中＝通过"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

/**
 * The switches that would turn a verified download into an unverified one. Each entry
 * carries the reason, so a hit names what it endangers instead of printing a bare token.
 */
const FORBIDDEN = [
  ['disables certificate verification for every TLS connection in the process', /NODE_TLS_REJECT_UNAUTHORIZED/],
  ['makes a single TLS context accept any certificate', /rejectUnauthorized\s*[:=]\s*false/],
  ['a flag that skips verification (curl, wget, npm)', /(^|[\s"'=])-{1,2}insecure\b/],
  ['accepts any hostname for any certificate', /checkServerIdentity\s*[=:]\s*(?:\(\s*\)\s*=>|undefined|null|true)/],
  ['a TLS server that never asks the peer for a certificate', /requestCert\s*:\s*false/],
  ['a TLS context that never verifies the chain', /verifyChain\s*:\s*false/],
]

/** Where the release URL is built: cleartext anywhere in here is the §9.3 downgrade. */
const CLEARENTEXT_FILES = [
  'updater/lib/source.js',
  'updater/cli.js',
  'updater/lib/apply.js',
  'updater/lib/staging.js',
  'updater/lib/signature.js',
  'engine/Sources/glasspane-settings/UpdateModel.swift',
  'engine/Sources/glasspane-settings/UpdatePanelLogic.swift',
]
const CLEARENTEXT = /\bhttp:\/\/[^\s"'`)<>]{0,80}/g
const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])$/

/**
 * Production code the trust path runs through, **derived by walking** those directories:
 * a hand-written list goes stale the moment someone renames a file, and a stale list
 * reports "0 hits" while reading nothing. Excluded on purpose: `test/` (those files quote
 * the forbidden words in order to forbid them), specs and docs (they state the prohibition).
 */
const SHIPPED_DIRS = [
  ['updater', /\.(?:mjs|js)$/],
  ['installer', /\.(?:mjs|js)$/],
  ['mcp-shell/src', /\.ts$/],
  ['engine/Sources/glasspane-settings', /\.swift$/],
]
const SHIPPED_FILES = ['install.sh', 'updater/launchd/com.glasspane.update.plist']

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function shippedFiles() {
  const out = []
  for (const file of SHIPPED_FILES) {
    const absolute = path.join(ROOT, file)
    if (!fs.existsSync(absolute)) throw new Error(`守卫要读的文件不在树上：${file}`)
    out.push({ file, text: fs.readFileSync(absolute, 'utf8') })
  }
  for (const [dir, pattern] of SHIPPED_DIRS) {
    const absolute = path.join(ROOT, dir)
    if (!fs.existsSync(absolute)) throw new Error(`守卫要读的目录不在树上：${dir}（这条守卫因此什么也没扫）`)
    for (const full of walk(absolute)) {
      const relative = path.relative(ROOT, full).split(path.sep).join('/')
      if (!pattern.test(relative)) continue
      out.push({ file: relative, text: fs.readFileSync(full, 'utf8') })
    }
  }
  return out
}

/**
 * Blank comment characters out to spaces, length preserved so every offset still maps to
 * the original text. Quote-aware, because the `//` inside `"https://api.github.com"` lives
 * in a string and must stay visible. `'`/`"` also end at a newline: a stray quote inside a
 * regex literal would otherwise swallow the rest of the file — a miss, which is worse than
 * a false alarm. Backticks span lines, as they do in the language.
 */
export function maskComments(text, kind = 'js') {
  const chars = Array.from(text)
  let quote = null
  let i = 0
  const blank = (from, to) => {
    for (let k = from; k < to && k < chars.length; k += 1) if (chars[k] !== '\n') chars[k] = ' '
  }
  while (i < chars.length) {
    const ch = chars[i]
    if (quote) {
      if (ch === '\\') { i += 2; continue }
      if (ch === quote) quote = null
      else if ((quote === "'" || quote === '"') && ch === '\n') quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || (kind !== 'sh' && ch === '`')) { quote = ch; i += 1; continue }
    if (kind !== 'sh' && ch === '/' && chars[i + 1] === '/') {
      const end = chars.indexOf('\n', i)
      const stop = end === -1 ? chars.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (kind !== 'sh' && ch === '/' && chars[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? chars.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    // In shell, `#` starts a comment only at line start or after whitespace/;/& — a URL with
    // a fragment must not be masked away.
    if (kind === 'sh' && ch === '#' && (i === 0 || /[\s;&]/.test(chars[i - 1]))) {
      const end = chars.indexOf('\n', i)
      const stop = end === -1 ? chars.length : end
      blank(i, stop)
      i = stop
      continue
    }
    i += 1
  }
  return chars.join('')
}

const maskXmlComments = (text) => text.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, ' '))

const lineOf = (text, index) => text.slice(0, index).split('\n').length

function scan(text, file) {
  const kind = file.endsWith('.plist') ? 'xml' : file.endsWith('.sh') ? 'sh' : 'js'
  const masked = kind === 'xml' ? maskXmlComments(text) : maskComments(text, kind)
  const hits = []
  for (const [reason, pattern] of FORBIDDEN) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    let match
    while ((match = global.exec(masked)) !== null) {
      const line = lineOf(text, match.index)
      hits.push({ file, reason, line, text: text.split('\n')[line - 1].trim().slice(0, 110) })
      if (match[0].length === 0) global.lastIndex += 1
    }
  }
  if (CLEARENTEXT_FILES.includes(file)) {
    CLEARENTEXT.lastIndex = 0
    let match
    while ((match = CLEARENTEXT.exec(masked)) !== null) {
      // Strip path then port: `http://127.0.0.1:8080/x` is loopback, and judging on the
      // raw authority would have flagged every local test server this repo starts.
      const authority = match[0].slice('http://'.length).split('/')[0].replace(/:\d+$/, '')
      if (LOOPBACK.test(authority)) continue
      hits.push({ file, reason: 'downgrades a request on the release trust path to cleartext', line: lineOf(text, match.index), text: match[0] })
    }
  }
  return hits
}

/* --------------------------------- 自测：这条守卫必须能变红 */

test('the guard can fail: every forbidden switch is caught in code, and a comment alone is not', () => {
  const hostile = [
    'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"',
    'const agent = new https.Agent({ rejectUnauthorized: false })',
    'spawnSync("curl", ["--insecure", url])',
    'tls.checkServerIdentity = () => undefined',
    'https.createServer({ requestCert: false }, h)',
    'tls.createSecureContext({ verifyChain: false })',
  ]
  for (const snippet of hostile) {
    const found = scan(`const a = 1\n${snippet}\n`, 'sample.js')
    assert.equal(found.length, 1, `扫不出来，这条禁令就是装饰：\n${snippet}\n→ ${JSON.stringify(found)}`)
    assert.equal(found[0].line, 2, '行号要指着文件里那一行，不然给出去的 location 是假的')
    assert.match(found[0].reason, /\w/, 'a hit must say what it endangers')
  }
  assert.equal(scan('// never NODE_TLS_REJECT_UNAUTHORIZED here\nconst a = 1\n', 'sample.js').length, 0)
  assert.equal(scan('/* curl --insecure is forbidden */\nconst a = 1\n', 'sample.js').length, 0)
  assert.equal(scan('const a = 1 /* rejectUnauthorized: false is a bug */\n', 'sample.js').length, 0)
  assert.equal(scan('# 不许加 --insecure\nnode x.js\n', 'sample.sh').length, 0)
  // 字符串里的 `//` 不是注释：把它当注释抹掉，同一行后面的禁令词就扫不到了——那是漏检。
  assert.equal(scan('const u = "https://api.github.com/x"; process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"\n', 'sample.js').length, 1)
  // 正则里的单引号也不能把后半本文件吞掉。
  assert.equal(scan("const re = /'/; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'\n", 'sample.js').length, 1)
  // shell 里 URL 的 fragment 不是注释。
  assert.equal(scan('curl -s https://x.test/a#frag --insecure\n', 'sample.sh').length, 1)
  // 明文规则：发布路径上 localhost 允许、别处不允许；不在发布路径上的文件不管这条。
  assert.equal(scan('const u = "http://127.0.0.1:8080/x"\n', 'updater/lib/source.js').length, 0)
  assert.equal(scan('const u = "http://api.github.com/x"\n', 'updater/lib/source.js').length, 1)
  assert.equal(scan('const u = "http://localhost:3000/x"\n', 'updater/lib/source.js').length, 0, '带端口的回环地址不是降级')
  assert.equal(scan('const d = "http://www.apple.com/DTDs/PropertyList-1.0.dtd"\n', 'installer/cli.js').length, 0,
    'plist 的 DOCTYPE 公共标识符不是请求，全局禁它会把人引去删注释')
})

test('the file set is real: the guard reads the trust path, not an empty list', () => {
  const files = shippedFiles()
  assert.ok(files.length >= 25, `只扫到 ${files.length} 个生产文件——比这条信任链上的文件数少：${files.map((f) => f.file).join(', ')}`)
  for (const must of ['updater/lib/ca-bundle.js', 'updater/lib/source.js', 'updater/cli.js',
    'installer/cli.js', 'engine/Sources/glasspane-settings/UpdatePanelLogic.swift']) {
    assert.ok(files.some((f) => f.file === must), `${must} 不在扫描范围里，这条守卫就没读到它`)
  }
  for (const file of CLEARENTEXT_FILES) {
    assert.ok(files.some((f) => f.file === file), `明文禁令的文件集列了 ${file}，走查却读不到它（改名了？）`)
  }
  assert.ok(FORBIDDEN.length >= 6, '模式表被清空不等于更安全')
})

/* --------------------------------- 正文：生产代码里一个都不许有 */

test('no shipped file in the update trust path turns off TLS verification', () => {
  const hits = []
  for (const { file, text } of shippedFiles()) hits.push(...scan(text, file))
  assert.deepEqual(hits, [], `这些位置出现的每一个都是可执行代码，不是注释（判据见上面那条自测）：\n${hits
    .map((hit) => `  ${hit.file}:${hit.line} — ${hit.text} (${hit.reason})`).join('\n')}`)
})
