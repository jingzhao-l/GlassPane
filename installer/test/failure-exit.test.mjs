/**
 * 失败路径的退出方式（`curl | sh` 是文档里的调用形态，stdout 接的是管道）。
 *
 * 成功路径早就用 `process.exitCode`（让排在队列里的说明文本先冲干净），失败路径却是
 * `process.stderr.write(...)` 之后直接 `process.exit(1)`：管道里还没落地的步骤输出会被
 * 连根截掉，而那正是用户唯一需要读的一段（哪一步炸的、下一步跑什么）。
 *
 * 这里分三层，缺一层就是在测别的东西：
 *  (1) 机制——同一段大输出，`process.exit()` 真会丢字节、`process.exitCode` 不丢。这一层
 *      证明"截断"在这台机器上不是想象中的事；
 *  (2) 形状——cli.js 的 install 拒绝分支必须走 `process.exitCode = 1`，且不再有 `process.exit(`；
 *  (3) 端到端——真的把 installer 跑失败一次（缺 daemon 产物），退出码仍是 1，stderr 仍是那句
 *      安装失败，stdout 里已经写出去的那几步不许消失。
 *
 * REVERSE MUTATION：把 `.catch` 里的 `process.exitCode = 1` 换回 `process.exit(1)` → 第 (2) 层红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js')

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gp-exit-${label}-`))
}

/** 一个"看起来像仓库、但没有构建产物"的根目录：够 install() 走到 launchd 那一步再抛。 */
function fakeRepoRoot() {
  const root = tempRoot('repo')
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(root, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(root, 'engine', 'Package.swift'), '// swift-tools-version:5.9\n')
  fs.writeFileSync(path.join(root, 'mcp-shell', 'package.json'), '{}\n')
  return root
}

test('机制：管道上的 stdout 未 flush 时，process.exit() 会丢字节而 process.exitCode 不会', () => {
  // 这段不是在被测代码，它是第 (2) 层那句断言的**存在性证明**：200 KiB 远超 64 KiB 的管道缓冲，
  // 剩下的都在 node 的用户态队列里；exit() 直接不等，exitCode 让事件循环跑完再退。
  const script = (strategy) => [
    "process.stdout.write('HEAD\\n')",
    'process.stdout.write("x".repeat(200 * 1024) + "\\n")',
    strategy,
  ].join('\n')
  const run = (strategy) => spawnSync(process.execPath, ['-e', script(strategy)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const early = run('process.exit(1)')
  const lazy = run('process.exitCode = 1')
  assert.equal(early.status, 1, early.stderr)
  assert.equal(lazy.status, 1, lazy.stderr)
  assert.ok(lazy.stdout.length > early.stdout.length,
    `exit() 丢了 ${lazy.stdout.length - early.stdout.length} 字节（early=${early.stdout.length} / lazy=${lazy.stdout.length}）——这条控制对不成立时，下面那层形状断言就是在管一件不存在的事`)
  assert.ok(early.stdout.length < 200 * 1024, `exit() 那一趟必须真的短：${early.stdout.length}`)
})

test('形状：install 失败路径用 process.exitCode，不再 process.exit()', () => {
  const source = fs.readFileSync(CLI, 'utf8')
  const start = source.indexOf('.catch((installError)')
  assert.notEqual(start, -1, '找不到安装失败的 catch 分支（结构变了就来看这道闸是否还有效）')
  const block = source.slice(start, start + 600)
  const end = block.indexOf('\n}')
  const raw = end > 0 ? block.slice(0, end) : block
  // 只看代码，不看散文：这一段注释本来就在解释 `process.exit()` 为什么不能用，留着它的话
  // 下面那条"不许出现"的断言会被自己的注释打红。
  const body = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.match(body, /process\.exitCode = 1/, '失败也要把退出码交给事件循环，而不是抢在 flush 之前退')
  assert.ok(!/process\.exit\(/.test(body), `拒绝分支里不许再出现 process.exit()：${body}`)
  assert.match(raw, /安装失败/, '那句给人读的话仍然要先写进 stderr')
})

test('端到端：安装真失败一次，退出码仍是 1，已经写出去的步骤输出没有消失', () => {
  const root = fakeRepoRoot()
  const home = tempRoot('home')
  try {
    const result = spawnSync(process.execPath, [
      CLI,
      '--repo', root,
      '--skip-build',
      '--no-app',
      '--no-gui',
      '--no-daemon',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, GLASSPANE_NO_COLOR: '1' },
      timeout: 120_000,
    })
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stderr, /安装失败/, '必须走的是 install 的拒绝分支，不是参数错误／预检那两条')
    assert.match(result.stderr, /daemon 产物不存在|launchd|不存在/, result.stderr)
    assert.match(result.stdout, /项目根目录/, '失败之前已经打出去的那几步不许因为退出方式被吃掉')
    assert.ok(!/安装完成/.test(result.stdout), '失败的安装不许同时打印一句完成')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  }
})
