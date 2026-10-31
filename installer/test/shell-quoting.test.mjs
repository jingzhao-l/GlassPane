/**
 * 安装器印出去的每一条命令，路径必须是**一个惰性参数**，不是 shell 文本。
 *
 * `installer/cli.js` 顶部那段注释（2026-10-30 写下）说"本包的引号表由
 * `installer/test/shell-quoting.test.mjs` 钉住"——这个文件当时**不存在**。那不是笔误，是
 * 一条假清白：同一轮把扫描集扩到 `installer/*.js` 的那笔提交只带来了静态半边，而静态半边
 * 按名字放行 `quoteShellArg(...)`，于是 `bundlePlacementFailureText()` 里那两处
 * `JSON.stringify`（`const dir = JSON.stringify(...)`、`const q = (p) => JSON.stringify(p)`）
 * 既没被名字认出、也没被任何行为测试读到。后果是发布物 1.26.0 的补救话术里印着
 * `ls -ld "/tmp/x";touch /tmp/pwned"` 这种形态：双引号不是惰性引号，`$(` 与反引号在双引号里
 * 照常展开，而坐在参数位上的路径来自 `--repo` / `GLASSPANE_REPO` / `GLASSPANE_INSTALL_DIR`——
 * 一句"照着这条命令修磁盘"就变成了"照着目录名以您的权限执行"。
 *
 * 所以这个文件做三件事，缺一件就是没闸：
 *  1. 把 `quoteShellArg` 的表钉死（含空串与前导 `-` 两格，少了它们命令行会变短或多一个选项）；
 *  2. 钉"检查者会咬人"：双引号形态必须被同一个解析器拒绝，否则第 3 条可以靠改解析器蒙过去；
 *  3. 用**真生产者**跑恶意路径：`bundlePlacementFailureText()` 的四个 step 各拿一份含反引号、
 *     空格、单引号的路径，把回话里每一条反引号命令按 `sh` 的方式拆开，要求恶意路径整段还原成
 *     恰好一个词。这一半边与 `mcp-shell/test/remedy-shell-quoting.test.mjs` 用的是同一个判据、
 *     同一份解析器（两包各自发行、不能共享 import，共享的是规则）。
 *
 * REVERSE MUTATION：
 *  · 把 `dir` 改回 `JSON.stringify(path.dirname(target))` ⇒ 第 4/5/6 条红（双引号里空格路径
 *    被解析成一个词，但反引号与 `$(` 那一档被解析器直接拒绝，报 "double quotes are not inert"）；
 *  · 把某处 `quoteShellArg(target)` 换成裸 `${target}` ⇒ 同一条红（控制字符没被包住）；
 *  · 把 `quoteShellArg` 里的 `'\\''` 拼接删掉 ⇒ 第 1 条与含单引号那档的路径都红；
 *  · 删掉第 2 条 ⇒ 第 3 条可以靠把解析器改松（不再拒绝双引号）而空过，这条本身就是防那一手。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { bundlePlacementFailureText, quoteShellArg } from '../cli.js'

/** 三种载荷：反引号（命令替换）、空格（劈成两个词）、单引号（引号配对错位的经典形状）。 */
const HOSTILE = {
  backtick: '/tmp/x`;touch /tmp/pwned',
  space: '/tmp/a b/Applications',
  quote: "/tmp/it's/Applications",
}

/* ----------------------------- 解析器 ----------------------------- */

/** 按 `sh` 的分词规则读一条命令；任何裸的算子/展开/通配/未闭合引号都直接抛。 */
function shellWords(cmd) {
  const words = []
  let current = null
  let i = 0
  const flush = () => {
    if (current !== null) {
      words.push(current)
      current = null
    }
  }
  while (i < cmd.length) {
    const c = cmd[i]
    if (c === ' ' || c === '\t' || c === '\n') {
      flush()
      i++
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '<' || c === '>') {
      throw new Error(`unquoted control operator ${JSON.stringify(c)} in: ${cmd}`)
    }
    if (c === '`') throw new Error(`unquoted backtick (command substitution) in: ${cmd}`)
    if (c === '$' && (cmd[i + 1] === '(' || cmd[i + 1] === '{')) {
      throw new Error(`unquoted expansion ${JSON.stringify(c + cmd[i + 1])} in: ${cmd}`)
    }
    if (c === '*' || c === '?' || c === '[') throw new Error(`unquoted glob ${JSON.stringify(c)} in: ${cmd}`)
    if (c === "'") {
      current = current ?? ''
      i++
      while (i < cmd.length && cmd[i] !== "'") {
        current += cmd[i]
        i++
      }
      if (i >= cmd.length) throw new Error(`unterminated single quote in: ${cmd}`)
      i++
      continue
    }
    if (c === '"') {
      current = current ?? ''
      i++
      let inner = ''
      while (i < cmd.length && cmd[i] !== '"') {
        inner += cmd[i]
        i++
      }
      if (i >= cmd.length) throw new Error(`unterminated double quote in: ${cmd}`)
      i++
      if (/[$`]/.test(inner)) {
        throw new Error(`double quotes are not inert quoting — ${JSON.stringify(inner)} still expands`)
      }
      current += inner
      continue
    }
    if (c === '\\') {
      current = current ?? ''
      current += cmd[i + 1] ?? ''
      i += 2
      continue
    }
    current = current ?? ''
    current += c
    i++
  }
  flush()
  return words
}

/** 回话里每一条反引号划出来的命令。 */
function commandsIn(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1])
}

const MASKED = '@@PATH@@'

/**
 * 先遮掉已经包好的形态，再看命令里还剩什么——顺序和理由与 mcp-shell 那半边一致：
 * 恶意载荷自己含反引号，先按反引号切片会把切片边界落在文件名里，闸会把自己的解析器报成缺陷。
 */
function assertCommandsKeepPathsInert(text, label, paths) {
  let masked = text
  let quotedSeen = 0
  for (const p of paths) {
    const quoted = quoteShellArg(p)
    quotedSeen += masked.split(quoted).length - 1
    masked = masked.split(quoted).join(MASKED)
  }
  masked = masked.replace(/'[^'\n]*'/g, MASKED)
  const commands = commandsIn(masked)
  assert.ok(commands.length > 0, `${label}: 这句话里没有反引号命令，这条闸什么也没看`)
  assert.ok(quotedSeen > 0, `${label}: 一条包好的路径都没有，闸在看别的东西：${text}`)
  const words = []
  for (const cmd of commands) {
    let parsed
    try {
      parsed = shellWords(cmd)
    } catch (error) {
      assert.fail(`${label}: 命令 ${JSON.stringify(cmd)} 会被 shell 拆成别的东西 — ${error.message}`)
    }
    for (const p of paths) {
      assert.ok(!cmd.includes(p), `${label}: 遮掉包好形态后命令里还剩裸路径 ${JSON.stringify(p)}：${cmd}`)
    }
    if (cmd.includes(MASKED)) {
      // 每个包好的路径都必须是一个**独立的词**（`mv` 那一条有两个，所以不数总数，只验形状：
      // 一个词要么整个是 @@PATH@@，要么根本不含它——混进别的字符就是被劈开或粘连的证据）。
      assert.ok(parsed.every((w) => !w.includes(MASKED) || w === MASKED),
        `${label}: 包好的路径没落成独立的词：${JSON.stringify(parsed)}`)
      assert.ok(parsed.includes(MASKED), `${label}: 命令里有 @@PATH@@ 却没有一个词就是它：${JSON.stringify(parsed)}`)
    }
    words.push(parsed)
  }
  return words
}

/* ------------------------------ 引号表 ------------------------------ */

test('quoteShellArg 是 POSIX 单引号表：惰性字符原样、其余整段包住、内嵌单引号用 \'\\\'\' 拼接', () => {
  assert.equal(quoteShellArg(HOSTILE.space), `'${HOSTILE.space}'`)
  assert.equal(quoteShellArg(HOSTILE.backtick), `'${HOSTILE.backtick}'`)
  assert.equal(quoteShellArg("/tmp/it's/x"), `'/tmp/it'\\''s/x'`)
  assert.equal(quoteShellArg('/Users/me/Applications'), '/Users/me/Applications',
    '普通绝对路径不该被裹起来：它是惰性的，包起来只是更难读')
  assert.equal(quoteShellArg(''), "''", '空串不写就是少一个参数：那已经是另一个命令行')
  assert.equal(quoteShellArg('-rf'), "'-rf'", '以 - 开头的值会被读成选项')
  for (const payload of Object.values(HOSTILE)) {
    assert.deepEqual(shellWords(`chmod 600 ${quoteShellArg(payload)}`), ['chmod', '600', payload],
      `${payload}: 引号没把它还原成一个词`)
  }
})

test('检查者会咬人：双引号与裸插值都不是惰性引号（这条不存在时，第 3 组可以靠改松解析器蒙过去）', () => {
  for (const payload of Object.values(HOSTILE)) {
    let thrown = null
    let words = null
    try {
      words = shellWords(`ls -ld ${payload}`)
    } catch (error) {
      thrown = error
    }
    const split = words !== null && words.length !== 3
    assert.ok(thrown !== null || split,
      `未加引号的 ${JSON.stringify(payload)} 既没被拒绝也没被劈开，那这条对照什么都没证：${JSON.stringify(words)}`)
    if (thrown !== null) {
      assert.match(thrown.message, /control operator|backtick|glob|unquoted expansion|unterminated/)
    }
  }
  assert.throws(() => shellWords(`ls -ld "${HOSTILE.backtick}"`), /double quotes are not inert/)
  assert.throws(() => shellWords('ls -ld "$(touch /tmp/pwned)"'), /double quotes are not inert/)
  // JSON.stringify 的产物正是这一档：本文件存在之前，`installer/cli.js` 用的就是它。
  assert.throws(() => shellWords(`df -h ${JSON.stringify(HOSTILE.backtick)}`), /double quotes are not inert/)
})

/* ---------------------------- 真生产者 ---------------------------- */

const FAILURE = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })

function textFor(step, paths, stagedRemoved) {
  return bundlePlacementFailureText({
    source: paths.target,
    target: paths.target,
    staged: paths.staged,
    retired: paths.retired,
    error: FAILURE,
    step,
    ...stagedRemoved === undefined ? {} : { stagedRemoved },
  })
}

const ALL_STEPS = ['copy', 'retire', 'restore', 'place']

/**
 * 每一档**坐在命令参数位上**的那些路径。这不是随手列的：`copy`/`retire` 只在
 * `stagedRemoved=false` 时才印出 `rm -rf <staged>`，`place` 只印 `ls -ld <dirname>`，而
 * 正文里 bare 提到的一份路径不构成注入（判据的范围是命令，不是整句话）。写死这张表，
 * 生产者少发一条命令会红，多发一条没包好的命令也会红。
 */
function commandPathsFor(step, paths, stagedRemoved) {
  const dir = path.dirname(paths.target)
  if (step === 'place') return [dir]
  if (step === 'restore') return [paths.retired, paths.target, paths.staged, dir]
  return stagedRemoved === false ? [paths.target, paths.staged, dir] : [paths.target, dir]
}

test('空格载荷：四个 step 的每一条命令都解析得动，路径整段还原成独立的词', () => {
  const paths = {
    target: `${HOSTILE.space}/GlassPane.app`,
    staged: `${HOSTILE.space}/staged.app`,
    retired: `${HOSTILE.space}/retired.app`,
  }
  const all = [...Object.values(paths), path.dirname(paths.target)]
  const produced = ALL_STEPS.flatMap((step) => [textFor(step, paths), textFor(step, paths, false)])
  let commands = 0
  for (const text of produced) {
    commands += assertCommandsKeepPathsInert(text, 'space', all).length
  }
  assert.ok(commands >= 4, `只解析到 ${commands} 条命令，这条闸看不见东西`)
})

/**
 * 含单引号与含反引号的两档**不做整句切片**：正文里也 bare 地印着这份路径（`安置 <path> 失败`），
 * 而它的 `'` / `` ` `` 正是切片的定界符——把切片边界落在文件名里的对照不是对照，是在测自己的
 * 解析器（`mcp-shell/test/remedy-shell-quoting.test.mjs` 已经为同一件事改过一次，注释就写在那儿）。
 * 这两档改成问可判定的那两句：包好的形态必须整段在场，而双引号形态与裸形态必须都不在场。
 */
for (const name of ['quote', 'backtick']) {
  test(`${name} 载荷：包好的形态整段在场，双引号形态与命令位上的裸形态都不在场`, () => {
    const paths = {
      target: `${HOSTILE[name]}/GlassPane.app`,
      staged: `${HOSTILE[name]}/staged.app`,
      retired: `${HOSTILE[name]}/retired.app`,
    }
    for (const step of ALL_STEPS) {
      for (const stagedRemoved of [undefined, false]) {
        const text = textFor(step, paths, stagedRemoved)
        for (const p of commandPathsFor(step, paths, stagedRemoved)) {
          assert.ok(text.includes(quoteShellArg(p)),
            `${step}(stagedRemoved=${stagedRemoved}) 里 ${JSON.stringify(p)} 没有被引号助手整段包住：${text.slice(0, 240)}`)
          assert.ok(!text.includes(`"${p}"`),
            `${step}: 出现了双引号包的路径——JSON.stringify 的形状，本文件存在之前就是这样：${text.slice(0, 240)}`)
        }
        // 命令位上的裸形态：`df -h <path>`、`ls -ld <path>`、`ls -lO <path>`、`rm -rf <path>`、`mv <path>`
        for (const m of text.matchAll(/(?:df -h|ls -ld|ls -lO|rm -rf|mv) ((?:[^`\n]|\\`)*)/g)) {
          const tail = m[1] ?? ''
          for (const p of [...Object.values(paths), path.dirname(paths.target)]) {
            assert.ok(!tail.startsWith(p), `${step}: 命令参数位上是裸路径 ${JSON.stringify(p)}：${tail.slice(0, 80)}`)
          }
        }
      }
    }
    // 具名判决：这四支命令必须真在这句回话里，否则上面那一串"不在场"是空话。
    const copy = textFor('copy', paths)
    assert.match(copy, /`df -h /, 'df -h 那条不在')
    assert.match(copy, /`ls -ld /, 'ls -ld 那条不在')
    assert.match(copy, /`ls -lO /, 'ls -lO 那条不在')
    assert.match(textFor('copy', paths, false), /`rm -rf /, 'rm -rf 那条不在')
    assert.match(textFor('restore', paths), /`mv /, 'mv 放回原位的命令不在')
  })
}


test('生产者用的确实是本包的引号助手，不是又一份 JSON.stringify（惰性路径必须原样不带引号）', () => {
  // 这条是防止判据退化成装饰：`quoteShellArg` 对纯惰性字符**不加**引号，而 `JSON.stringify`
  // 一定加双引号。拿一条普通绝对路径跑一遍，命令里出现的是裸路径 ⇒ 走的是引号助手；一旦有
  // 人把某处换回 `"…"`（或换成自己发明的引号），这一条立刻红，而恶意载荷那几条也会被同一处
  // 变更打到——两侧一起红才是证据。
  const plain = {
    target: '/Users/me/Applications/GlassPane.app',
    staged: '/Users/me/Applications/.GlassPane-staged.app',
    retired: '/Users/me/Applications/.GlassPane-retired.app',
  }
  const text = textFor('copy', plain)
  assert.ok(text.includes('ls -ld /Users/me/Applications'), `目录位没走引号助手（应原样裸写）：${text}`)
  assert.ok(text.includes('ls -lO /Users/me/Applications/GlassPane.app'),
    `target 位没走引号助手（应原样裸写）：${text}`)
  assert.ok(!text.includes('"/Users/me'), `命令里出现了双引号包的路径——那是本文件存在之前的形状：${text}`)
})
