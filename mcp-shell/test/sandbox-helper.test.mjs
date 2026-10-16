/**
 * 测试沙箱助手的并发前提：`dispose()` 不许把兄弟进程还要用的基目录抽走。
 *
 * WHY（CI 实测，不是理论）。2026-10-16 run 38862162240 的 mcp-shell 段红在
 * `not ok 273 - 控制：目录 sync 成功时照旧落盘；不支持目录 sync 的卷不因此拒绝一次成功的写`，
 * 报错是 `ENOENT: no such file or directory, mkdtemp '…/mcp-shell/.gp-test-sandbox/gp-registry-dirsync…'`。
 * 同一棵树本地两趟全绿。根因与"目录 sync"这件事毫无关系：`test/*.test.mjs` 由 `node --test` 逐文件
 * 起**并发进程**，它们共用一个 `.gp-test-sandbox` 基目录，而 `dispose()` 里有一句"基目录空了就
 * rmdir"——先跑完的那个文件把空基目录收掉，还没跑完的那个下一次 `mkdtemp` 就撞在消失的父目录上。
 * 这是"靠调度赢的夹具"：它绿的时候什么也没证明。
 *
 * REVERSE MUTATION：把 `dispose()` 里那段 rmdir 加回来（见本文件最后一条用例，它直接测这件事）
 * → 具名红 `最后一个沙箱收尾之后基目录还在`。这条不需要负载配合，所以它才是判据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { privateSandbox } from './support/sandbox.mjs'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = path.join(PKG, '.gp-test-sandbox')

test('沙箱落在包内、0700，且不在任何受保护树里', () => {
  const box = privateSandbox('gp-helper-shape-')
  try {
    assert.ok(box.dir.startsWith(BASE + path.sep), `夹具必须落在 ${BASE} 下，实得 ${box.dir}`)
    assert.equal(fs.statSync(box.dir).mode & 0o777, 0o700, '沙箱必须是 0700，否则 projectSet 的归属判据会拒')
    // `/tmp` 与它的符号链接形态都算受保护树（Linux CI 的 os.tmpdir() 就是 /tmp）。
    for (const guarded of ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp']) {
      assert.ok(!box.dir.startsWith(guarded), `沙箱落进受保护树 ${guarded}：CI 上这份夹具会被守卫拒掉`)
    }
  } finally {
    box.dispose()
  }
})

test('两个沙箱并存时，先收尾的那个不许影响另一个', () => {
  const a = privateSandbox('gp-helper-concurrent-a-')
  const b = privateSandbox('gp-helper-concurrent-b-')
  try {
    fs.writeFileSync(path.join(b.dir, 'marker'), 'b 还在用它')
    a.dispose()
    assert.equal(fs.readFileSync(path.join(b.dir, 'marker'), 'utf8'), 'b 还在用它')
    assert.equal(fs.existsSync(b.dir), true, '别人的收尾不许动我的目录')
  } finally {
    b.dispose()
  }
})

test('最后一个沙箱收尾之后基目录还在——它是并发进程共用的，不是某个文件的私产', () => {
  const box = privateSandbox('gp-helper-base-survives-')
  assert.equal(fs.existsSync(BASE), true, '建沙箱时必须把基目录带出来')
  box.dispose()
  assert.equal(fs.existsSync(box.dir), false, '自己的目录要收干净，不许给下一次运行留残骸')
  assert.equal(fs.existsSync(BASE), true,
    '基目录被 dispose() 收掉了：`node --test` 逐文件起并发进程共用它，先跑完的那个把父目录抽走，'
    + '慢的那个下一次 mkdtemp 就 ENOENT（CI run 38862162240 的 mcp-shell 那条红正是这个形状）')
})

test('mkdtemp 在基目录被外部删掉之后仍能重建（自愈，不是只在干净树上跑得通）', () => {
  const box = privateSandbox('gp-helper-selfheal-')
  box.dispose()
  // 模拟一次外部清理（例如另一条命令 rm -rf 了基目录）：下一次使用必须自己把基目录建回来。
  fs.rmSync(BASE, { recursive: true, force: true })
  const again = privateSandbox('gp-helper-selfheal2-')
  try {
    assert.equal(fs.existsSync(again.dir), true, '基目录没了就得重建，否则整段套件在一个干净检出上必红')
    fs.writeFileSync(path.join(again.dir, 'ok'), 'written')
    assert.equal(fs.readFileSync(path.join(again.dir, 'ok'), 'utf8'), 'written')
  } finally {
    again.dispose()
  }
})

test('另一个进程里用同一份助手：两个沙箱互不重叠，收尾后基目录仍在', () => {
  // 并发进程这一半只能在**子进程**里量：本文件的其余用例都在同一个进程内。
  const esm = 'import fs from "node:fs"\n'
    + `import { privateSandbox } from ${JSON.stringify(path.join(PKG, 'test', 'support', 'sandbox.mjs'))}\n`
    + 'const a = privateSandbox("gp-helper-proc-a-")\n'
    + 'const b = privateSandbox("gp-helper-proc-b-")\n'
    + 'a.dispose()\n'
    + 'b.dispose()\n'
    + `console.log(JSON.stringify({ distinct: a.dir !== b.dir, baseKept: fs.existsSync(${JSON.stringify(BASE)}) }))\n`
  const got = spawnSync(process.execPath, ['--input-type=module', '-e', esm], { encoding: 'utf8', cwd: PKG })
  assert.equal(got.status, 0, `${got.stdout}${got.stderr}`)
  const parsed = JSON.parse(got.stdout.trim())
  assert.equal(parsed.distinct, true, '同一进程里两个沙箱必须互不重叠')
  assert.equal(parsed.baseKept, true, '两个沙箱都收尾后基目录仍要在——它是共用的')
})
