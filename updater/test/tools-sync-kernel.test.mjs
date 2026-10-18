/**
 * `tools/sync-kernel.sh` is retired (2026-10-18, Step 0b): this repository no longer mirrors the
 * kernel's source, so the script's only supported behaviour is a refusal that names what to run
 * instead. These tests exist for two reasons.
 *
 * 1. A refusal the operator cannot act on is not a refusal. The retired script had, twice, refused
 *    with text pointing at a mode it had just deleted (`--target=fork` stayed in the "supported"
 *    list of both refusal messages after 2026-10-08 retired it), so an operator following the
 *    advice got a second refusal from a flag the tool just named. Each remedy line below is
 *    asserted by name, not by "it said *something*".
 * 2. The mirror must not come back by accident. The reason it is gone is that nothing recorded
 *    the version of `kernel/src`, and the same class of lag had already blinded a consumer once.
 *    So the absence is asserted as a property of the tree: no mirrored source, not a member of
 *    the workspace list, no `file:` kernel dependency in the shell — while the pinned corpus the
 *    Swift C35 leg and the archive's requirement list read stays present and non-empty.
 *
 * The lessons the deleted implementation carried (manifest copy is not a no-op; verification is
 * part of the operation; rollback must cover everything the operation touched) are recorded in
 * the script's own header, which is what these tests keep from being edited into a stub.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(REPO, 'tools', 'sync-kernel.sh')

function runScript(args, env = {}) {
  return spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO,
    env: { ...process.env, ...env },
  })
}

/** Refusal must cost exit 2 — "cannot act with this tool", not "the tree disagrees". */
test('the retired sync tool refuses, and the refusal costs exit 2', () => {
  for (const args of [['--target=repo'], ['--target=fork'], ['--dry-run'], []]) {
    const res = runScript(args, { KERNEL_SRC: '/nonexistent/iterate-skill' })
    assert.equal(res.status, 2, `${JSON.stringify(args)} → exit ${res.status}; stderr=${res.stderr.slice(0, 200)}`)
    assert.match(res.stderr, /retired/, `${JSON.stringify(args)} must say the tool is retired, not that it failed`)
  }
})

test('the refusal names all three replacement paths, so the operator has something to run', () => {
  const res = runScript(['--target=repo'])
  // 每条出路各自点名，缺一条就是那条红——上一版 retire 时留下的正是"拒绝文案里还写着刚删掉的模式"。
  for (const [label, needle] of [
    ['corpus', 'node scripts/check-kernel-corpus.mjs --record'],
    ['fork pin', 'script/kernel-pin.mjs --record'],
    ['behaviour', 'script/kernel-conformance.mjs'],
  ]) {
    assert.ok(res.stderr.includes(needle), `${label} 那条出路没出现在拒绝文案里：${res.stderr}`)
  }
  assert.match(res.stderr, /no longer mirrors the kernel's source/,
    '拒绝必须先说清这件事本身，否则读起来像一次环境故障')
})

test('the mirrored kernel source is gone from the tree, and the pinned corpus is not', () => {
  // 这份镜像回来的唯一方式是有人再抄一次。这里按属性拦，而不是靠记忆。
  for (const gone of ['kernel/src', 'kernel/test', 'kernel/package.json', 'kernel/tsconfig.json', 'kernel/package-lock.json']) {
    assert.equal(fs.existsSync(path.join(REPO, gone)), false, `${gone} 还在——那是一份没有出处记录的契约副本`)
  }
  const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  assert.equal((root.workspaces ?? []).includes('kernel'), false,
    `kernel 又成根 workspace 成员了：${JSON.stringify(root.workspaces)}`)

  // 壳也不许回到本地路径依赖。
  const shell = JSON.parse(fs.readFileSync(path.join(REPO, 'mcp-shell', 'package.json'), 'utf8'))
  const specs = { ...shell.dependencies, ...shell.devDependencies }
  for (const name of ['@iterate/kernel', 'iterate-kernel']) {
    const spec = specs[name]
    if (spec === undefined) continue
    assert.equal(/^(\^|~|file:|link:|workspace:)/.test(spec), false,
      `${name} 的 spec "${spec}" 不是精确版本——发布物里的契约必须由名字与版本唯一确定`)
  }
  assert.equal(specs['@iterate/kernel'], undefined, '已废弃的 scoped 名字又回来了')
  assert.ok(typeof specs['iterate-kernel'] === 'string', 'mcp-shell 不再声明 iterate-kernel，那这份包捆的内核没有出处')

  // 语料必须还在且非空：Swift 的 C35 腿与归档要求清单都读它。
  for (const sub of ['fixtures', 'schemas']) {
    const dir = path.join(REPO, 'kernel', sub)
    const files = fs.readdirSync(dir).filter((name) => /\.(json|md|html)$/.test(name))
    assert.ok(files.length >= 5, `kernel/${sub} 只剩 ${files.length} 份，C35 腿读不到语料会静默变绿`)
  }
})

test('the corpus gate is what keeps the mirror honest, and it is wired into CI', () => {
  const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(ci, /node scripts\/check-kernel-corpus\.mjs/,
    'check-kernel-corpus 不在 CI 里——那份镜像就没有任何东西在核')
  // 内核代码的测试不该再住在这棵树里：那会造出第二份"能各说各话"的实现。
  assert.doesNotMatch(ci, /working-directory: kernel/,
    'ci.yml 还在构建 kernel/ 镜像——那个目录已经没有代码了')
})
