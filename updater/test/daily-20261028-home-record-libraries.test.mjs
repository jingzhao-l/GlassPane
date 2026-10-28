/**
 * 2026-10-28（lane：CLI 契约）—— `updater/lib` 的两处家目录读法必须走**口令档案**，不是 `$HOME`。
 *
 * 缺陷形状（同一个类的第三、第四处）：
 *  · `lib/binaries.js` 的 `homeOf(env)` 先读 `env.HOME`，读不到再退 `os.homedir()`。而
 *    `os.homedir()` 的第一件事也是查 `$HOME`（Node 的实现如此，本仓在
 *    `mcp-shell/test/project-registry.test.mjs` 里实测过），所以那是**同一个变量的两张读法**，
 *    不是一层兜底。它拼出来的 `<home>/.npm-global/bin` 是每日作业 PATH 与 npm 全局命令搜索的第一候选。
 *  · `lib/launchd.js` 的 `agentPlistPath()` 默认值就是 `os.homedir()`——它决定
 *    `~/Library/LaunchAgents/com.glasspane.update.plist` 落在**哪个账号的**目录里。
 *
 * 而这一产品的每一处家目录都读档案：`updater/cli.js` 的 `recordHomeDir()`、`updater/agent-entry.js`
 * 的 `entryHomeDir()`、`mcp-shell/src/update-state.ts` 的 `recordHome()`、`mcp-shell/src/project-registry.ts`
 * 的 `systemHome()`、daemon 的 `StateRoot.homeDefault()`（`NSHomeDirectory()`）。跟着 `$HOME` 走的那两支
 * 会把"每日检查"变成一个装在最真实意义上的别处：搜的是别人家的 npm 前缀，注册的是 launchd 看不见的那份 plist。
 *
 * 读不到档案时的答案形状**沿用各文件本来已有的那一支**（不新造）：
 *  · `binaries.js` 答 `null`（`homeOf` 原来失败就是 `return null`，调用方 `if (home)` 已经受得住），
 *    也就是"这一格不知道"，于是那一条前缀整个不进候选表——**不猜**；
 *  · `launchd.js` 抛 `UpdaterError(CODES.homeRecordUnavailable)`（`agentPlistPath` 本来唯一的失败方式
 *    就是带着 `CODES` 值抛，`home-record-unavailable` 也正是 `cli.js`/`agent-entry.js` 对同一件事用的码）。
 *
 * REVERSE MUTATION（用例与红点的对应）：
 *  · `binaries.js` 的 `homeOf` 回退成 `os.homedir()` ⇒ 第 2 条红（`process.env.HOME` 被换到别处时
 *    搜索表跟着走了）；改回"先读 `env.HOME`" ⇒ 第 1 条与第 2 条一起红；
 *  · 档案读不到时改成猜一个（退回 `$HOME`、或干脆用 `/Users/<name>`）⇒ 第 3 条红；
 *  · `launchd.js` 的默认值回成 `os.homedir()` ⇒ 第 4 条红；把 null 当成家拼出 `Library/LaunchAgents/…`
 *    相对路径 ⇒ 第 5 条红；
 *  · 把 `assertOwnAgentLabel` 排到家目录判定之后 ⇒ 第 6 条红（标签是文件名，必须先拒）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AGENT_LABEL, agentPlistPath } from '../lib/launchd.js'
import { candidateDirsFor, npmGlobalBinDirs, recordHome } from '../lib/binaries.js'
import { CODES } from '../lib/codes.js'

/** 口令档案里的那个家（本机的真值）。 */
const RECORD = os.userInfo().homedir
/** 一个真的不存在、且和档案一眼分得开的"家"：`$HOME` 被重定向时就是它。 */
const REDIRECTED = RECORD === '/tmp/gp-sbx-home' ? '/private/tmp/gp-sbx-home' : '/tmp/gp-sbx-home'
/** 注入给搜索用的"档案答案"（测试不许依赖开发机的档案值，所以自己交出去）。 */
const INJECTED = '/Users/injected-record-home'

function noRecord() {
  throw Object.assign(new Error('getpwuid: no record for this uid'), { code: 'ENOENT' })
}

/* ------------------------------------------------------- 1. env.HOME 不再是输入 */

test('npm 全局前缀的候选不再读 env.HOME：重定向 $HOME 不改变搜索表', () => {
  const dirs = npmGlobalBinDirs({ env: { HOME: REDIRECTED }, readRecord: () => INJECTED })
  assert.ok(dirs.includes(path.join(INJECTED, '.npm-global', 'bin')), `档案那份前缀必须在：${dirs.join(', ')}`)
  assert.equal(
    dirs.some((d) => d.startsWith(REDIRECTED)),
    false,
    `$HOME 又被当成家目录用了：${dirs.join(', ')} —— 面板与 daemon 读的是档案那一份，跟着 $HOME 搜的就是别人家的 npm`,
  )
  // 只有 env、没有注入：默认那支读档案，答案与 $HOME 无关。
  const defaulted = npmGlobalBinDirs({ env: { HOME: REDIRECTED } })
  assert.ok(defaulted.includes(path.join(RECORD, '.npm-global', 'bin')), `默认要落进档案家：${defaulted.join(', ')}`)
  assert.equal(defaulted.some((d) => d.startsWith(REDIRECTED)), false, defaulted.join(', '))

  // 同一条判据用到候选表上（glasspane-mcp 那一支就是靠它找 npm 全局装的包）。
  const candidates = candidateDirsFor('glasspane-mcp', {
    env: { HOME: REDIRECTED, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    execPath: '/usr/local/bin/node',
    readRecord: () => INJECTED,
  })
  assert.ok(candidates.includes(path.join(INJECTED, '.npm-global', 'bin')), candidates.join(', '))
  assert.equal(candidates.some((d) => d.startsWith(REDIRECTED)), false, candidates.join(', '))
})

test('process.env.HOME 被换掉时搜索表不动（os.homedir() 那张读法也算数）', () => {
  const before = process.env.HOME
  process.env.HOME = REDIRECTED
  try {
    // 前提先量一遍：`os.homedir()` 确实跟着 $HOME 走，否则这条测量什么也没量。
    assert.equal(os.homedir(), REDIRECTED, `夹具失效：os.homedir() 没跟 $HOME 走（${os.homedir()}）`)
    assert.notEqual(RECORD, REDIRECTED, '夹具失效：两个家分不开')
    for (const dirs of [npmGlobalBinDirs({ env: {} }), candidateDirsFor('npm', { env: {} })]) {
      assert.equal(dirs.some((d) => d.startsWith(REDIRECTED)), false, `候选跟着 $HOME 走了：${dirs.join(', ')}`)
      assert.ok(dirs.includes(path.join(RECORD, '.npm-global', 'bin')), `候选里没有档案家那一份：${dirs.join(', ')}`)
    }
  } finally {
    if (before === undefined) delete process.env.HOME
    else process.env.HOME = before
  }
})

/* ------------------------------------------------- 2. 读不到档案 = 不知道，不是猜 */

test('档案读不到时 recordHome 答 null，搜索表把那一格整个去掉而不是猜一个家', () => {
  assert.equal(recordHome({ readRecord: noRecord }), null, '读不到就是"不知道"')
  assert.equal(recordHome({ readRecord: () => '' }), null, '空答案同义：拼出来的会是个相对味道的家')
  assert.equal(recordHome({ readRecord: () => null }), null)
  const dirs = npmGlobalBinDirs({ env: { HOME: REDIRECTED }, readRecord: noRecord })
  assert.equal(dirs.some((d) => d.includes('.npm-global')), false, `没有档案就不许有那条前缀：${dirs.join(', ')}`)
  assert.equal(dirs.some((d) => d.startsWith(REDIRECTED)), false, `拿 $HOME 兜底就是把猜的说成测的：${dirs.join(', ')}`)
  // 文档里在用的那三条前缀照旧在：这一条拒绝只是摘掉"家"那一格，不是取消整张搜索表。
  for (const bin of ['/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin']) {
    assert.ok(dirs.includes(bin), `别处的 npm 前缀不能跟着一起消失：${dirs.join(', ')}`)
  }
})

/* -------------------------------------------------------------- 3. plist 落进哪个家 */

test('agentPlistPath 的默认家是口令档案，不是 $HOME', () => {
  const before = process.env.HOME
  process.env.HOME = REDIRECTED
  try {
    assert.equal(os.homedir(), REDIRECTED, '夹具失效：$HOME 没和档案拉开距离')
    const expected = path.join(RECORD, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`)
    assert.equal(agentPlistPath(), expected, '默认值跟着 $HOME 走 = 把每日作业注册进 launchd 看不见的目录')
    assert.equal(agentPlistPath({ homeDir: undefined }), expected, '显式 undefined 与没给同义：都读档案')
    assert.equal(
      agentPlistPath({ readRecord: () => INJECTED }),
      path.join(INJECTED, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`),
    )
  } finally {
    if (before === undefined) delete process.env.HOME
    else process.env.HOME = before
  }
})

test('读不到档案时 agentPlistPath 拒绝，不拼一个没人认的家', () => {
  for (const readRecord of [noRecord, () => '', () => null, () => '   ']) {
    assert.throws(
      () => agentPlistPath({ readRecord }),
      (error) => {
        assert.equal(error?.code, CODES.homeRecordUnavailable, `失败要报本仓那一个已有的码：${error?.code}`)
        assert.match(error.message, /password-database|password record/i, error.message)
        assert.match(error.message, /nothing was registered/i, '拒绝要说清什么都没做')
        return true
      },
      '没有档案时这一格的答案是"不知道"，不是 os.homedir() 或 /Users/<name> 那一种猜测',
    )
  }
})

test('显式 homeDir 照旧优先，外来的标签仍然先被拒（顺序不许换）', () => {
  assert.equal(
    agentPlistPath({ homeDir: '/Users/dev' }),
    path.join('/Users/dev', 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`),
  )
  assert.equal(
    agentPlistPath({ homeDir: '  /Users/dev  ' }),
    path.join('/Users/dev', 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`),
    '首尾空白不是家目录的一部分',
  )
  // 标签就是文件名：它那一支必须排在家目录判定之前，否则"别人的文件名"会先被拼出来。
  assert.throws(
    () => agentPlistPath({ label: 'com.somebody.else', readRecord: noRecord }),
    (error) => error?.code === CODES.agentPathUnsafe,
  )
})

/* ------------------------------------------------------------------ 4. 源码形状闸 */

/**
 * 行为闸只看得到默认值那一条；这一条闸的是"这个类不再回来"的形状：
 * `updater/lib` 里不许再出现 `os.homedir()`（`mcp-shell/test/path-consistency.test.mjs` 对
 * `project-registry.ts` 用的是同一种写法，同一条理由）。
 */
test('updater/lib 的两处家目录读法没有 $HOME 那张读法', () => {
  const LIBRARIES = ['binaries.js', 'launchd.js']
  for (const file of LIBRARIES) {
    const source = fs.readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8')
    const codeOnly = stripComments(source)
    assert.match(codeOnly, /\S/, `${file} 的注释剥离把代码也剥掉了，下面的断言是在匹配一段空字符串`)
    assert.doesNotMatch(codeOnly, /os\.homedir\(/, `${file} 又用回了 $HOME 的那张读法`)
    assert.match(codeOnly, /os\.userInfo\(\)/, `${file} 要留下档案那一条读法（注入点的默认值）`)
  }
  assert.doesNotMatch(
    stripComments(fs.readFileSync(new URL('../lib/binaries.js', import.meta.url), 'utf8')),
    /env\??\.HOME/,
    'binaries.js 不许再把 env.HOME 当输入（$HOME 不是这个产品的家目录读法）',
  )
})

/** 只留代码行：这些文件里的**说明**故意提到 `os.homedir()`（写的正是为什么不能用它），
 *  形状闸要判的是调用点，不是散文。剥掉的只有整行注释，不是任意一段文本。 */
function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}
