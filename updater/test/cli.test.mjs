/**
 * The CLI as a *process* — exit codes and the one-line JSON contract (spec §7).
 *
 * Importing `cli.js` cannot prove any of this: the module is also a library the
 * tests use, and the executable guard at its bottom used to throw at import time
 * for every real invocation. These tests spawn `node cli.js …`, so they exercise
 * exactly what the launchd agent and the settings panel will run.
 *
 * Reverse mutations that redden here: break the import guard (every test here
 * fails with a nonzero status before any subcommand runs); return the wrong exit
 * code for a refusal; print the JSON line to stderr instead of stdout; print two
 * lines; send the `--help` usage block back to stderr (the `--help` tests below
 * read stdout, which is what `updater --help | grep …` reads); drop a code from the
 * usage table that `lib/codes.js` still answers with.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { plainTextLine, USAGE } from '../cli.js'
import { EXIT, STATUSES } from '../lib/codes.js'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js')

function runCli(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('node cli.js runs at all: status answers with one JSON line and exit 0', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cli-'))
  try {
    const result = await runCli(['status', '--json', '--state-dir', stateRoot])
    assert.equal(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`)
    assert.equal(result.stdout.trim().split('\n').length, 1, 'the contract is exactly one line on stdout')
    const parsed = JSON.parse(result.stdout)
    // Measured against the closed enum the contract publishes, not a hand-typed
    // subset: a fresh directory with no installer pointer legitimately answers
    // `installer-pointer-stale`, and an ad-hoc list of "expected" statuses would
    // have reddened the honest answer while passing a wrong one.
    assert.ok(STATUSES.includes(parsed.status), `status outside the documented enum: ${parsed.status}`)
    assert.equal(typeof parsed.exitCode, 'number')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('the plain-text line never answers with nothing', () => {
  // `check` staged an update and printed `check: `. The cause was two absent notes joined into `''`,
  // passed through by `??` because an empty string is present. This is the render rule that had to change;
  // the matching rule in `check.js` is what gave the staged outcome a sentence of its own.
  assert.equal(plainTextLine({ message: 'updated 1.5.0 -> 1.6.0' }), 'updated 1.5.0 -> 1.6.0')
  assert.equal(plainTextLine({ message: '', reason: 'the probe timed out' }), 'the probe timed out')
  const fromState = plainTextLine({ message: '', state: { status: 'staged', summary: { current: '1.4.0', latest: '1.4.1' } } })
  assert.match(fromState, /^status=staged current=1\.4\.0 latest=1\.4\.1$/, fromState)
  assert.notEqual(fromState, '', '一条空的输出行读起来像命令没回答')
})

test('an unknown subcommand is a usage error (exit 2), not a crash', async () => {
  const result = await runCli(['frobnicate'])
  assert.equal(result.code, 2, result.stderr)
  assert.match(result.stderr, /frobnicate|usage/i, 'the operator has to be told what they typed')
})

test('GLASSPANE_UPDATE_DISABLE=1 makes an automatic apply refuse with exit 3', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cli-'))
  try {
    const result = await runCli(['apply', '--json', '--state-dir', stateRoot, '--auto'], {
      env: { GLASSPANE_UPDATE_DISABLE: '1' },
    })
    assert.equal(result.code, 3, `refusal must be exit 3: ${result.stderr}`)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.code, 'a refusal without a code gives the panel nothing to show')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('安装根路径含空格时，CLI 仍然是一个会回答的进程（不是静默 exit 0）', async () => {
  // `new URL(import.meta.url).pathname` 是**百分号编码**的：`My App/cli.js` 会变成
  // `My%20App/cli.js`，于是"我是不是被直接调起的"那道守卫比较的是两个不存在的路径，
  // realpathSync 抛错 ⇒ invokedDirectly=false ⇒ `node cli.js status` 什么都不打印就退 0。
  // 面板因此永远显示"读不到更新状态"，而每日作业的 plist 会指向一个不存在的文件。
  const spaced = fs.mkdtempSync('/var/tmp/gp space-')
  try {
    fs.cpSync(path.join(import.meta.dirname, '..'), `${spaced}/updater`, { recursive: true, filter: (src) => !src.endsWith('node_modules') })
    const cli = `${spaced}/updater/cli.js`
    assert.ok(fs.existsSync(cli), '前置：拷贝到了带空格的安装根')
    const result = await runCliAt(cli, ['status', '--json', '--state-dir', `${spaced}/state`])
    assert.equal(result.stdout.trim().split('\n').length, 1, `恰好一行 JSON，实际收到 ${JSON.stringify(result.stdout)}`)
    const doc = JSON.parse(result.stdout)
    assert.equal(doc.command, 'status', `一行 JSON 得真是这条命令的回答：${result.stdout.slice(0, 200)}`)
    assert.match(result.stdout, /"state"/)
  } finally {
    fs.rmSync(spaced, { recursive: true, force: true })
  }
})

/** 从**任意路径**起 CLI（上面那条要模拟安装根含空格）。 */
function runCliAt(cliPath, args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/* ---------------------------------------------------------------------------
 * 2026-10-28（CLI 契约 lane）—— `--help` 的那一条流，与用法文本里的退出码契约。
 *
 * 缺陷形状：`main()` 把 USAGE 写在 stderr 上，而这个产品的**每一支** CLI 的用法都在
 * stdout（`installer/cli.js` 的 `--help`、`installer/glasspane.js` 的 `help`、
 * `engine/Sources/glasspaned/main.swift` 的 `--help` 都走 standardOutput）。后果是可执行
 * 的：`updater --help | grep -- --state-dir` 读到的是**空**，而管道另一头退出码仍是 0，
 * 于是"这个旗标不存在"看起来是被实测过的。诊断仍然只走 stderr —— 改的只有用法这一块。
 * ------------------------------------------------------------------------- */

test('--help 把用法打在 stdout：`updater --help | grep X` 读得到东西', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await runCli([flag])
    assert.equal(result.code, 0, `${flag} 不是一次操作，不该给非零结论：${result.stderr}`)
    assert.match(result.stdout, /usage: node updater\/cli\.js/, `${flag} 的用法要在 stdout 上，实得 stdout=${JSON.stringify(result.stdout)}`)
    assert.equal(result.stderr, '', `${flag} 不该往 stderr 写任何东西：${result.stderr}`)
  }
  // 这条是缺陷里那个"后果"的直接形状：用法里的一个旗标名必须从 stdout 读得到。
  const piped = await runCli(['--help'])
  assert.match(piped.stdout, /--state-dir/, '管道那头读 stdout，用法里点名的那面旗必须出现在 stdout')
})

test('用法错误照旧走 stderr 并退 2：改的只有 --help 那一块流', async () => {
  const result = await runCli(['frobnicate'])
  assert.equal(result.code, EXIT.USAGE, result.stderr)
  assert.equal(result.stdout, '', '用法错误不许往 stdout 写字节（--json 的调用方只认那一行）')
  assert.match(result.stderr, /unknown command/, result.stderr)
  assert.match(result.stderr, /usage: node updater\/cli\.js/, '拒绝的原因后面要跟得着用法')
})

/**
 * 用法文本里的退出码表 = 代码真的会答的那几个数（`updater/README.md` 把它称作契约）。
 * 判据是 `lib/codes.js` 的 `EXIT`，不是手抄的一份：加一个码却不写进用法、或用法里写一个
 * 代码答不出来的数，两边都会在这里红。
 */
test('USAGE 里的退出码表与 EXIT 常量一一对得上，且每个都带着它那一类失败的说法', () => {
  const table = USAGE.slice(USAGE.indexOf('exit codes'))
  const listed = [...new Set([...table.matchAll(/^ {2}(\d) {2}/gm)].map((m) => Number(m[1])))]
    .sort((a, b) => a - b)
  const real = [...new Set(Object.values(EXIT))].sort((a, b) => a - b)
  assert.deepEqual(listed, real, `用法表的数字要正好是 ${real.join(', ')}，实到 ${listed.join(', ') || '（空）'}`)
  // 每个码的说明就是它那一行加上后面那些五空格续行；表外的散文（"These five are…"）不算。
  const blockOf = (code) => {
    const lines = table.split('\n')
    const start = lines.findIndex((line) => line.startsWith(`  ${code}  `))
    if (start === -1) return null
    const body = [lines[start].slice(4)]
    for (let i = start + 1; i < lines.length; i += 1) {
      if (!/^ {5}\S/.test(lines[i])) break
      body.push(lines[i].trim())
    }
    return body.join(' ')
  }
  for (const [code, words] of [
    [EXIT.OK, /did what it says|success/],
    [EXIT.USAGE, /usage error/],
    [EXIT.REFUSED, /nothing changed/],
    [EXIT.ROLLED_BACK, /backup is back/],
    [EXIT.ROLLBACK_FAILED, /a person is required/],
  ]) {
    const block = blockOf(code)
    assert.ok(block, `退出码 ${code} 要在用法表里有一段自己的说明`)
    assert.match(block, words, `退出码 ${code} 的说明不对题：${block}`)
  }
  assert.match(table, /no 1/, '这一支压根不答 1，用法要把那句话说出来')
})

test('USAGE 记下跨二进制的用法错码（记录已知分歧，不是修它）', () => {
  assert.match(USAGE, /64/, 'glasspaned 对用法错答 64，读 rc 的人要能预见到')
  assert.match(USAGE, /installer\/cli\.js/, '同一类失败在另一支 CLI 上是几，也要写出来')
  assert.match(USAGE, /glasspaned/)
  assert.match(USAGE, /KNOWN divergence|NOT a fix/i, '这一行是**说明**，不许被读成已经统一过了')
})


/**
 * `URL.pathname` 不是文件系统路径（`%20` 会把空格编进去），而这条 CLI 有**三处**要用"我自己
 * 在哪儿"：注册进 plist 的那条命令、证书恢复时起的那个子进程、以及"我是被直接调起的吗"。
 * 上面那条真机形状只压得住第三处（子进程跑的是 `status`），前两处只有在这条命令被真正执行时
 * 才暴露——那一趟要动这台机器，不该在单测里跑。所以这里按**源码形状**闸住：
 * `import.meta.url` 只能经 `fileURLToPath` 变成路径。
 *
 * 反向变异（实测三条全红）：把任意一处退回 `new URL(import.meta.url).pathname` ⇒ 这条红；
 * 三处都在 ⇒ 计数守住，删一处也会红（少一处就是有一处重新用 pathname 或者干脆没用自己）。
 */
test('self-path resolution goes through fileURLToPath at every site that needs it', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'cli.js'), 'utf8')
  assert.doesNotMatch(source, /new URL\(import\.meta\.url\)\.pathname/,
    'URL.pathname 会把安装根里的空格写成 %20：注册进 plist 的那条命令于是指向一个不存在的文件，而 install 那边没人看得见')
  const sites = source.match(/fileURLToPath\(import\.meta\.url\)/g) ?? []
  assert.equal(sites.length, 3, `用到"我自己在哪儿"的地方应当是 3 处（plist 的 CLI、恢复的子进程、入口判定），现在是 ${sites.length} 处`)
  // 掩耳盗铃的一种：把 URL 拼在别处再传过来。形状闸只看这一句就够，因为它没有别的合法写法。
  assert.doesNotMatch(source, /import\.meta\.url\)\.pathname/, '还是那个 .pathname，只是换了个前缀')
})
