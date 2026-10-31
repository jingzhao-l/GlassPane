/**
 * 出路里写的那条命令，必须在这台机器上真的跑得起来（P0：裸 `updater <verb>`）。
 *
 * 为什么这一条必须成闸：本产品对 remedy 的定义是"读的人当下真能执行的一条命令"
 * （`SECURITY.md` §3、`specs/GlassPane_规格_自动更新_2026-09-27.md`，以及
 * `mcp-shell/src/update-state.ts:615-625` 把更新器的原话 `lastError=<code>: <message>`
 * **原样转发**给 agent 这一条通道）。而 `updater` 这个可执行文件在任何一台装了本产品的机器上
 * 都不存在：`updater/package.json` 是 `private: true` 且没有 `bin` 字段，npm 只发布
 * `glasspane-mcp` 与 `glasspane-install` 两个包，`install.sh` 也不链这个名字。照抄执行得到
 * 的是 127。Swift 那一半早就认了这件事（`engine/Sources/glasspane-settings/UpdatePanelLogic.swift:401`
 * "这台机器上没有一个叫 `updater` 的可执行文件，让人去跑 `updater status` 是一条走不通的路"；
 * 同文件 :482 与 :510/:519 把面板控件改成 `node <绝对路径> <verb>`）。JS 这一半是半修：A 面改了，
 * B 面还在发旧令 —— 修前实测 70 处字符串字面量（剥注释后按 `['"`]updater (check|apply|rollback|
 * status|enable|disable)` 量：agent-entry.js 1、cli.js 9、lib/apply.js 10、lib/binaries.js 2、
 * lib/ca-bundle.js 6、lib/check.js 4、lib/idle.js 2、lib/launchd.js 8、lib/policy.js 7、
 * lib/runtime.js 1、lib/signature.js 7、lib/source.js 7、lib/state.js 1、lib/tar.js 2、
 * lib/version.js 2、mcp-shell/src/tools.ts 1）。
 *
 * 四条断言，一条都不能只是"跑过了"：
 *  1. 扫描半边：剥注释后的字符串字面量里，命令形的裸 `updater <verb>` 必须为 0；
 *  2. 这条扫描必须**能红**：坏写法 `"updater apply"` 喂进同一个函数要被点名，
 *     而 `updaterCommand('apply')` 这种合法形态要**保持沉默**（只会通过的扫描器等于没有扫描器）；
 *  3. 行为半边：`updaterCommand('check','--consent','major')` 按 sh 的分词读回
 *     `['node', <绝对路径>, 'check', '--consent', 'major']`；带空格与反引号的路径经
 *     `commandFrom` 那一个接缝还原成**恰好一个词**；
 *  4. 存在性半边：`UPDATER_CLI` 指向的字节文件真的在，`node <UPDATER_CLI> --help` 不是 127；
 *     而裸名 `updater --help` 在这台机器上**确实是** 127 —— 这一条量的是本闸成立的前提，
 *     哪天有人真装出一个叫 `updater` 的可执行文件，它红在这里，逼着人来重读本文件。
 *
 * REVERSE MUTATION：把任意一处 remedy 改回 `"updater check"` → 第 1 条红并点名该处；
 * 把 `quoteShellArg` 换成双引号或裸插值 → 第 3 条红（双引号那段会被分词器直接拒绝）；
 * 把 `invocation.js` 的路径解析改坏（`resolveCliPath` 返回相对名）→ 第 4 条红在文件不存在；
 * 删掉第 2 条的夹具 → 那条具名用例红，扫描器从此证明不了自己会拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { commandFrom, UPDATER_CLI, updaterCommand } from '../lib/invocation.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The verbs this product's CLI answers, from `updater/cli.js`'s own `SUBCOMMANDS`. */
const VERBS = ['check', 'apply', 'rollback', 'status', 'enable', 'disable']

/**
 * The scan set: everywhere a remedy string is written for a reader who will copy it.
 * Same four-plus-one directories `mcp-shell/test/remedy-shell-quoting.test.mjs` reads, so the
 * quoting rule and the invocability rule are checked over one file set, not two.
 */
const SCAN_TARGETS = [
  { label: 'updater', dir: path.join(REPO, 'updater'), ext: '.js' },
  { label: 'updater/lib', dir: path.join(REPO, 'updater', 'lib'), ext: '.js' },
  { label: 'mcp-shell/src', dir: path.join(REPO, 'mcp-shell', 'src'), ext: '.ts' },
  { label: 'installer', dir: path.join(REPO, 'installer'), ext: '.js' },
  { label: 'scripts', dir: path.join(REPO, 'scripts'), ext: '.mjs' },
]

/**
 * Comments out, for the same reasons `mcp-shell/test/support/source.mjs` gives: the fix has to be
 * able to *explain* the old shape (this repo keeps the historical sentence in a comment as the
 * lesson), and a gate that fired on the explanation would be tuned to be broken. What a stripper
 * can wrongly hide is a real finding the strip ate — so the count floors below are computed on the
 * SAME stripped text, and an over-eager strip turns this file red instead of quietly green.
 */
function executableSource(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

/** String literals of one language's source: single, double and backtick spans, escapes honoured. */
function stringLiterals(body) {
  const found = []
  let i = 0
  while (i < body.length) {
    const c = body[i]
    if (c === '"' || c === "'" || c === '`') {
      const open = i
      i += 1
      while (i < body.length && body[i] !== c) {
        if (body[i] === '\\') { i += 2; continue }
        if (body[i] === '\n' && c !== '`') break // an unterminated ' or " is not a literal
        i += 1
      }
      found.push({ text: body.slice(open, i + 1), at: open })
      i += 1
      continue
    }
    i += 1
  }
  return found
}

/**
 * The judgement, as a function so the fixture half below can bite it with a known-bad line.
 *
 * Command-shaped means a quote character *immediately* followed by `updater <verb>`: that is the
 * shape a reader copies. Prose that merely says "the updater checks the release" has no quote in
 * front of it and is not what this gate is for — asking for it would make the gate fire on English.
 */
function bareUpdaterCommands(source, label) {
  const body = executableSource(source)
  const offenders = []
  for (const { text, at } of stringLiterals(body)) {
    const re = new RegExp('[\'"`]updater\\s+(' + VERBS.join('|') + ')\\b', 'g')
    for (const match of text.matchAll(re)) {
      const line = body.slice(0, at).split('\n').length
      offenders.push(`${label}:${line} 写出 ${JSON.stringify(match[0])} — 裸的可执行名 updater（这台机器上没有这个文件），整段：${text.slice(0, 90)}`)
    }
  }
  return offenders
}

test('出路里不许出现裸的 `updater <verb>`：全站扫描为 0', () => {
  const offenders = []
  let literals = 0
  let converted = 0
  for (const target of SCAN_TARGETS) {
    assert.ok(fs.existsSync(target.dir), `扫描目录不在了：${target.dir}——这条闸已经看不见东西`)
    for (const name of fs.readdirSync(target.dir).filter((entry) => entry.endsWith(target.ext)).sort()) {
      const source = fs.readFileSync(path.join(target.dir, name), 'utf8')
      literals += stringLiterals(executableSource(source)).filter((s) => s.text.length > 30).length
      converted += (source.match(/updaterCommand\(/g) ?? []).length
      for (const offender of bareUpdaterCommands(source, `${target.label}/${name}`)) offenders.push(offender)
    }
  }
  assert.deepEqual(offenders, [], `这些被转发的话术里有一条走不通的裸命令：\n${offenders.join('\n')}`)
  // Vacuity floors: a scan that stopped seeing anything would pass forever. The literal count is
  // measured on the stripped text, so the strip eating the corpus is red here too.
  assert.ok(literals >= 300, `扫描面只认出 ${literals} 条话术字面量，这条闸已经塌了`)
  assert.ok(converted >= 40, `全站只剩 ${converted} 处 updaterCommand( 调用点，改写被悄悄退回了`)
})

test('这条扫描能红：坏写法被点名，而改好的写法保持沉默', () => {
  // 第 2 条：对照。一个只会通过的扫描器等于没有扫描器。
  const bad = 'export const m = "updater apply --consent major"\n'
  const found = bareUpdaterCommands(bad, 'fixture')
  assert.equal(found.length, 1, `坏写法没有被点名，这条闸就什么都没证明：${JSON.stringify(found)}`)
  assert.match(found[0], /fixture:1/, `点名要带着"哪个文件哪一行"的坐标，否则改的人找不到：${found[0]}`)
  assert.match(found[0], /"updater apply/, `点名的要就是那一段裸命令：${found[0]}`)
  // 三种引号、六个动词都要能红：一条只认双引号或只认 `check` 的判据会在下一次写手换一种写法时绿着。
  for (const quote of ['"', "'", '`']) {
    for (const verb of VERBS) {
      const sample = `const x = ${quote}updater ${verb}${quote}`
      assert.equal(bareUpdaterCommands(sample, 'fixture').length, 1,
        `${quote}updater ${verb}${quote} 没被认出来：${JSON.stringify(bareUpdaterCommands(sample, 'fixture'))}`)
    }
  }
  // 而合法形态必须沉默：改写成 updaterCommand(...) 之后，句子仍然提到 check/apply，但参数位上
  // 不再有一个裸名。判据对"提到"与"让人照抄"分开处理，否则它会去考英语。
  for (const quiet of [
    'const x = `run ${updaterCommand("check")} first`\n',
    'const x = "the updater checks the release";\n',
    'const x = "node \'/Volumes/Eng-Dev/GlassPane/updater/cli.js\' enable"\n',
  ]) {
    assert.deepEqual(bareUpdaterCommands(quiet, 'legal'), [], `合法写法被误报，这条闸会被人为了变绿而删掉：${quiet}`)
  }
  // 注释里留着当年的原话不算交货：这一条量的是剥注释这件事真的在起作用。
  assert.deepEqual(bareUpdaterCommands('// 从前写的是 "updater status"\nconst x = 1\n', 'comment'), [],
    '注释里的历史原话不该被当成一句交出去的出路')
})

/* ------------------------------------------------------------------ behaviour half */

/**
 * A minimal `sh` word reader: single quotes are inert, `'\''` splices, and anything a shell could
 * act on outside a quote (an operator, a backtick, a `$(`, a glob, an unterminated quote, a double
 * quote carrying `$`/backtick) throws. Same judgement as
 * `mcp-shell/test/remedy-shell-quoting.test.mjs`, kept local because the two packages ship
 * separately and cannot import each other's test support.
 */
function shellWords(cmd) {
  const words = []
  let current = null
  let i = 0
  const flush = () => {
    if (current !== null) { words.push(current); current = null }
  }
  while (i < cmd.length) {
    const c = cmd[i]
    if (/\s/.test(c)) { flush(); i += 1; continue }
    if (';|&<>'.includes(c)) throw new Error(`未加引号的控制字符 ${JSON.stringify(c)}：${cmd}`)
    if (c === '`') throw new Error(`未加引号的反引号（命令替换）：${cmd}`)
    if (c === '$' && '({'.includes(cmd[i + 1] ?? '')) throw new Error(`未加引号的展开 ${JSON.stringify(c + cmd[i + 1])}：${cmd}`)
    if ('*?['.includes(c)) throw new Error(`未加引号的通配 ${JSON.stringify(c)}：${cmd}`)
    if (c === "'") {
      current = current ?? ''
      i += 1
      while (i < cmd.length && cmd[i] !== "'") {
        if (cmd[i] === '\\' && cmd[i + 1] === "'") { current += "'"; i += 2; continue }
        current += cmd[i]; i += 1
      }
      if (i >= cmd.length) throw new Error(`单引号没有闭合：${cmd}`)
      i += 1
      continue
    }
    if (c === '"') {
      current = current ?? ''
      i += 1
      let inner = ''
      while (i < cmd.length && cmd[i] !== '"') { inner += cmd[i]; i += 1 }
      if (i >= cmd.length) throw new Error(`双引号没有闭合：${cmd}`)
      i += 1
      if (/[$`]/.test(inner)) throw new Error(`双引号不是惰性引号 — ${JSON.stringify(inner)} 在里面照样展开`)
      current += inner
      continue
    }
    if (c === '\\') { current = (current ?? '') + (cmd[i + 1] ?? ''); i += 2; continue }
    current = (current ?? '') + c
    i += 1
  }
  flush()
  return words
}

test('updaterCommand(...) 分词回来就是 node、这一包的 cli.js、与那几个参数', () => {
  const cmd = updaterCommand('check', '--consent', 'major')
  assert.ok(cmd.startsWith('node '), `出路要以 node 加绝对路径开头：${cmd}`)
  assert.deepEqual(shellWords(cmd), ['node', UPDATER_CLI, 'check', '--consent', 'major'])
  // 三个动词的常见形状各自都要读得动（从前这几条都是"看起来是命令，跑起来是 127"）。
  for (const args of [['status', '--json'], ['apply'], ['rollback'], ['enable', '--hour', '3', '--minute', '0']]) {
    const words = shellWords(updaterCommand(...args))
    assert.equal(words[0], 'node')
    assert.equal(words[1], UPDATER_CLI)
    assert.deepEqual(words.slice(2), args, `${args.join(' ')} 的参数被引号形状改写了`)
  }
  // 没有参数时不许留一个尾随空格：那是一条"看起来多一个空参数"的命令行。
  assert.equal(updaterCommand(), `node ${UPDATER_CLI}`)
})

test('接缝半边：路径里有空格与反引号时，单引号把它还原成恰好一个词', () => {
  // 这一档真实安装在别的机器上排得出（带空格的家目录、代理写的符号链接），本机排不出，
  // 所以走 `commandFrom` 这一个纯函数接缝，而不是去改这台机器的目录。
  for (const hostile of ['/tmp/a b/cli.js', "/tmp/it's/cli.js", '/tmp/x`;touch /tmp/pwned/cli.js']) {
    const cmd = commandFrom(hostile, ['apply', '--state-dir', '/tmp/a b/root'])
    let words = null
    assert.doesNotThrow(() => { words = shellWords(cmd) }, `恶意路径没被包住，读的人执行的就不是"检查这个文件"：${cmd}`)
    assert.deepEqual(words, ['node', hostile, 'apply', '--state-dir', '/tmp/a b/root'],
      `分词回来的不是那六个词：${cmd} → ${JSON.stringify(words)}`)
  }
  // 反例必须能红：把引号退化成双引号，同一条载荷就会被这台闸拒绝——这正是本仓在
  // `installer/cli.js` 与 `lib/policy.js` 上栽过的那一格。
  const doubled = `node "/tmp/x\`;touch /tmp/pwned/cli.js" apply`
  assert.throws(() => shellWords(doubled), /双引号不是惰性引号/)
  // 旗标与它的值是两个参数，不是一个含空格的串：合成一个串会被单引号包成一个词，交出去就是
  // 一个谁都不认的选项。判据在这里，而不是只写在注释里。
  assert.deepEqual(shellWords(commandFrom('/x/cli.js', ['--consent major'])), ['node', '/x/cli.js', '--consent major'])
})

/* ------------------------------------------------------------------ existence half */

test('UPDATER_CLI 指的是一个真的字节文件，node 跑得动它（不是 127）', () => {
  assert.ok(path.isAbsolute(UPDATER_CLI), `出路里的路径必须是绝对的，读者的 cwd 不是这个包的目录：${UPDATER_CLI}`)
  assert.ok(fs.existsSync(UPDATER_CLI), `UPDATER_CLI 指向的文件不存在：${UPDATER_CLI}`)
  assert.ok(fs.statSync(UPDATER_CLI).isFile(), `UPDATER_CLI 指向的不是一个文件：${UPDATER_CLI}`)
  assert.equal(fs.realpathSync(UPDATER_CLI), UPDATER_CLI,
    `UPDATER_CLI 必须是真名而不是符号链接的名：${UPDATER_CLI}`)
  assert.match(fs.readFileSync(UPDATER_CLI, 'utf8'), /^#!/, '这一份要是一个能交给 node 的入口文件')

  // 跑一次 `--help`：不要求它做什么有用的事，只要求它**不是 127**（命令没找到）。
  const run = spawnSync(process.execPath, [UPDATER_CLI, '--help'], { encoding: 'utf8' })
  assert.equal(run.error, undefined, `node 这个可执行文件本身没能起来：${run.error?.message}`)
  assert.notEqual(run.status, 127, `照抄这一条出路得到 127：${UPDATER_CLI}`)
  assert.equal(run.status, 0, `cli.js 的 --help 按契约退 0，退出码 ${run.status}：${run.stderr}`)
  assert.ok(String(run.stdout).includes('usage'), '--help 没有把用法块打在 stdout 上：这一条出路指的不是本产品的 CLI')

  // 前提本身也要量一次：这台机器上没有叫 `updater` 的可执行文件，所以裸名是一条走不通的路。
  // 哪天这一条红了，说明有人装出了那个名字——那时要重读的是这个文件与本闸的第一条，不是把断言删掉。
  const bare = spawnSync('/bin/sh', ['-c', 'updater --help'], { encoding: 'utf8' })
  assert.equal(bare.status, 127,
    `本闸的前提变了：这台机器现在能解析出 \`updater\`（退出码 ${bare.status}）——裸名是否可执行要重新判断`)
})
