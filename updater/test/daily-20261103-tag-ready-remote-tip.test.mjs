/**
 * 每日任务 2026-11-03 · `assert-tag-ready` 的 tip 判据必须问**远端**。
 *
 * 缺陷（本轮复核到的形状，`scripts/assert-tag-ready.mjs:165`）：那一格读的是
 * `git rev-parse refs/remotes/origin/main` —— 一枚本地跟踪引用，只有 `git fetch` 才会动它。
 * 于是"另一条线在我们上一次 fetch 之后推了 Y"这一档，tip 判据读到的还是 X：HEAD(X) ==
 * origin/main(X) ⇒ 放行 ⇒ 签名 tag / Release / npm 全部钉在 X，而 main 已经在 Y。文件顶部
 * （`:19-20`）主张的恰好是"HEAD 必须就是 origin/main 的 tip"。同一次 fetch 之后一切正常，
 * 所以这条在 CI 与绝大多数本地跑法里永远是绿的——只有真分叉的那一次会漏。
 *
 * 三条用例各自能单独变红：
 *   ① 夹具本身（两份真 clone，远端被第三者推进过一格）：远端读到的 tip 与本地跟踪引用**不相等**，
 *      且相等的那个方向正是缺陷方向 —— 这条不是"测不到所以写个真的"，是把现场摆出来。
 *   ② 绑定：`main()` 在①的现场上必须**拒绝**打 tag，并点名远端那一枚。把 `main` 改回读本地跟踪
 *      引用 ⇒ 这一条红（它变成放行）。
 *   ③ 正对照：同一棵树 fetch 过之后（无分叉）`main()` 必须**放行** —— 证明 ② 的红来自分叉本身，
 *      而不是桩 `gh`、夹具或版本形状碰巧不让过。
 *
 * 桩 `gh` 只答两件事：`matching-refs/tags/v` 答"没有 tag"，`…/runs` 答"HEAD 上那条 push 通道
 * 的 run 是 success"。这样 tip 那一格就是唯一能左右结论的判据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { main, remoteMainSha } from '../../scripts/assert-tag-ready.mjs'

function gitAt(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * 现场：一个本地 bare 远端 + 两份 clone。B 是"发布线的工作树"（fetch 停在 C1），
 * A 代表"另一条线"，把远端 main 推进到 C2 —— 全程不碰 B，所以 B 的跟踪引用是旧的。
 */
function makeStaleTipFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-tag-tip-'))
  const remote = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const b = path.join(root, 'lane-b')
  const a = path.join(root, 'lane-a')
  execFileSync('git', ['init', '-q', '--bare', remote])
  execFileSync('git', ['clone', '-q', remote, seed])
  const commit = (dir, message) => {
    fs.writeFileSync(path.join(dir, message + '.txt'), message + '\n')
    gitAt(dir, 'add', '-A')
    gitAt(dir, '-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '-m', message)
    gitAt(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    return gitAt(dir, 'rev-parse', 'HEAD')
  }
  // 首格由 seed 建立；B 之后 clone，所以 B 天然带着这格的跟踪引用。
  const c1 = commit(seed, 'c1')
  execFileSync('git', ['clone', '-q', '-b', 'main', remote, b])
  execFileSync('git', ['clone', '-q', '-b', 'main', remote, a])
  // 第三者推进远端：B 不 fetch ⇒ 它的 refs/remotes/origin/main 仍是 c1。
  const c2 = commit(a, 'c2')
  return { root, remote, b, a, seed, c1, c2, commit, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** 只答"tip 之外都放行"的桩 gh，让 tip 成为唯一变量。 */
function makeGhStub(dir, runSha) {
  const bin = path.join(dir, 'ghstub-bin')
  fs.mkdirSync(bin, { recursive: true })
  const script = path.join(bin, 'gh')
  // sha 走 env（`GP_STUB_SHA`），不拼进脚本正文：拼接字符串进可执行文件就是这个仓反复记过账的那类注入面。
  fs.writeFileSync(script, `#!/bin/sh
# argv: api <path> […]. 只认两个端点，其余一律答"空"。
case "$2" in
  *matching-refs/tags/*) printf '' ;;
  */runs*) printf '{"workflow_runs":[{"id":1,"head_sha":"%s","event":"push","status":"completed","conclusion":"success","created_at":"2026-11-03T00:00:00Z","html_url":"https://x/1"}]}\\n' "$GP_STUB_SHA" ;;
  *) printf '' ;;
esac
`, { mode: 0o755 })
  return { dir: bin, sha: runSha }
}

function runMainInProcess({ cwd, stub, argv }) {
  // `main()` 的 cwd 是一个**选项**，不是进程工作目录：CLI 那一头永远把脚本自己的仓根当 cwd
  // （`:150` 的默认值）。所以这条对照必须直接调 `main`，并把桩 `gh` 临时挂进 PATH。
  // 环境与此处的 stdout/stderr 都在 finally 里逐字还原——不留任何副作用给同文件的其他用例。
  const savedPath = process.env.PATH
  const savedSha = process.env.GP_STUB_SHA
  const out = []
  const err = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  process.env.PATH = `${stub.dir}${path.delimiter}${savedPath}`
  process.env.GP_STUB_SHA = stub.sha
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true }
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true }
  let rc = -1
  try {
    rc = main(argv, { cwd })
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
    if (savedSha === undefined) delete process.env.GP_STUB_SHA
    else process.env.GP_STUB_SHA = savedSha
    process.env.PATH = savedPath
  }
  return { rc, stdout: out.join(''), stderr: err.join('') }
}

test('① 夹具：远端的 tip 与本地跟踪引用分叉，分叉方向就是缺陷方向', () => {
  const fx = makeStaleTipFixture()
  try {
    const localTracking = gitAt(fx.b, 'rev-parse', 'refs/remotes/origin/main')
    assert.equal(localTracking, fx.c1, '夹具没造出"本地仍停在 c1"的旧视图')
    assert.equal(remoteMainSha(fx.b), fx.c2, '问远端必须读到 c2 — 读不到就说明这条对照测不到那件事')
    assert.notEqual(localTracking, remoteMainSha(fx.b), '两枚必须不等：这条用例的全部意义在这里')
  } finally {
    fx.cleanup()
  }
})

test('② 绑定：tip 分叉时 assert-tag-ready 必须拒绝，并点名远端那一枚', () => {
  const fx = makeStaleTipFixture()
  try {
    const stub = makeGhStub(fx.root, fx.c1) // HEAD 上的绿是真的，唯一不成立的只能是 tip
    const r = runMainInProcess({ cwd: fx.b, stub, argv: ['9.9.9', '--repository', 'o/r'] })
    assert.notEqual(r.rc, 0, `远端已被第三者推进而闸仍放行：${r.stdout}${r.stderr}`)
    assert.match(r.stderr + r.stdout, /不是 origin\/main/, `拒绝的理由不该是别的：${r.stderr}`)
    assert.match(r.stderr + r.stdout, new RegExp(fx.c2.slice(0, 12)), '拒绝必须点名远端那一枚 commit')
  } finally {
    fx.cleanup()
  }
})

test('③ 正对照：fetch 过、无分叉时同一枚 commit 必须放行', () => {
  const fx = makeStaleTipFixture()
  try {
    gitAt(fx.b, 'fetch', '-q', 'origin', 'refs/heads/main:refs/remotes/origin/main')
    const headNow = gitAt(fx.b, 'rev-parse', 'HEAD')
    assert.equal(headNow, fx.c1, '夹具假设 B 的 HEAD 停在 c1')
    // 把 B 快进到远端 tip，模拟"这条线自己把 main 拉到最新"——此时 tip == HEAD，唯一拦路的判据消失。
    gitAt(fx.b, 'merge', '-q', '--ff-only', 'refs/remotes/origin/main')
    const stub = makeGhStub(fx.root, fx.c2)
    const r = runMainInProcess({ cwd: fx.b, stub, argv: ['9.9.9', '--repository', 'o/r'] })
    assert.equal(r.rc, 0, `无分叉时闸不该拦：rc=${r.rc}\n${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /下一步：git tag/, '放行的那一句必须给出下一步')
  } finally {
    fx.cleanup()
  }
})
