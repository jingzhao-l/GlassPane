/**
 * `tools/sync-kernel.sh` is the only sanctioned way to write the canonical kernel back into
 * this repository's `kernel/` mirror, and the daily main-line prompt names it by path. It had
 * two defects nobody could see, because nothing tested the script:
 *
 * 1. The canonical path was interpolated *inside* a `node -p "…"` string literal. A
 *    `KERNEL_SRC` whose path contains a single quote — `/Users/o'brien/iterate-skill`, an
 *    ordinary home directory — broke the JS literal, so the sync died on a SyntaxError on the
 *    version read instead of reading a version. The path now arrives as `process.argv`, which
 *    is not parsed as source.
 * 2. Both `--target` refusal messages still advertised `supported: repo, fork` after the fork
 *    leg was retired (2026-10-08) to exit 2. An operator following that text gets a second
 *    refusal from a flag the tool just told them about.
 *
 * The fixture is a real mirror copy (guard 1 compares file sets, guard 2 greps the consumer
 * contract out of `src/index.ts`), not a stub that answers for a tree the script would reject.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(REPO, 'tools', 'sync-kernel.sh')

/** A canonical checkout that would pass every guard: the mirror's own bytes, version re-stamped. */
function fixture({ apostrophe = true, version = '0.1.99' } = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-sync-kernel-'))
  const srcRoot = apostrophe ? path.join(base, "it's a test") : path.join(base, 'plain')
  const kernel = path.join(srcRoot, 'kernel')
  fs.cpSync(path.join(REPO, 'kernel'), kernel, {
    recursive: true,
    filter: (src) => !/(^|[/\\])(node_modules|dist|\.npm-cache)([/\\]|$)/.test(src),
  })
  const pkg = JSON.parse(fs.readFileSync(path.join(kernel, 'package.json'), 'utf8'))
  pkg.version = version
  fs.writeFileSync(path.join(kernel, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  return { base, srcRoot, version }
}

function runSync(srcRoot, args = ['--dry-run']) {
  return spawnSync('/bin/bash', [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, KERNEL_SRC: srcRoot },
  })
}

test('sync-kernel: a KERNEL_SRC path containing a single quote still reads both versions', () => {
  const f = fixture()
  const result = runSync(f.srcRoot)
  const out = `${result.stdout}${result.stderr}`
  // Pre-fix this is where the run died: `require('/…/it's a test/kernel/package.json')` is not
  // valid JavaScript, `set -e` ends the script, and the operator sees a SyntaxError.
  assert.equal(result.status, 0, `带撇号的路径必须能同步：${out}`)
  assert.match(out, /dry run OK/)
  // The version note is the proof the read actually happened, and with the fixture's number —
  // a script that skipped the read would print neither.
  assert.match(out, new RegExp(`canonical says ${f.version}`), out)
  fs.rmSync(f.base, { recursive: true, force: true })
})

test('sync-kernel: the same fixture without the apostrophe is also accepted (the control)', () => {
  // Without this, the case above could be green for the wrong reason — a guard short-circuiting
  // the run would look identical to a path that quoting broke, from the outside.
  const f = fixture({ apostrophe: false })
  const result = runSync(f.srcRoot)
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, new RegExp(`canonical says ${f.version}`))
  fs.rmSync(f.base, { recursive: true, force: true })
})

test('sync-kernel: the retired fork leg refuses, and the usage text no longer advertises it', () => {
  const f = fixture({ apostrophe: false })
  const fork = runSync(f.srcRoot, ['--target=fork', '--dry-run'])
  assert.equal(fork.status, 2, `${fork.stdout}${fork.stderr}`)
  assert.match(`${fork.stderr}${fork.stdout}`, /--target=fork is retired/)
  assert.match(`${fork.stderr}${fork.stdout}`, /kernel-pin\.mjs/, '拒绝报文要给出替它的那条路')

  // The two strings that used to say "supported: repo, fork". Asserted through behaviour —
  // an unknown target value prints the supported list — rather than grepping the script text.
  const unknown = runSync(f.srcRoot, ['--target=bogus'])
  assert.equal(unknown.status, 2, `${unknown.stdout}${unknown.stderr}`)
  const shown = `${unknown.stderr}${unknown.stdout}`
  assert.match(shown, /supported: repo/)
  assert.ok(!/supported: repo, fork/.test(shown), `不该再把已退役的那条腿列为支持项：${shown}`)
  assert.ok(!/repo\|fork/.test(shown), `同一句里的第二种写法：${shown}`)
  fs.rmSync(f.base, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ 真同步沙箱
 *
 * 上面三条都只跑 `--dry-run`，而 dry-run 不落盘——于是这个脚本真正会写坏的东西，
 * 它们一条也看不见。2026-10-15 实测到的正是这一类：`--target=repo` 把 canonical 的
 * `kernel/package.json` 整份复制过来，镜像侧那份**自有身份**（工作区名
 * `@iterate/kernel`、`private: true`、锁在 `3.25.76` 的 zod、只导 `.` 的 exports）
 * 被 `iterate-kernel` / `private: false` / `>=3.25.76 <5` 那份取代，root 的
 * `npm run build` 立刻 `No workspaces found: --workspace=@iterate/kernel`。
 * guard 3 事后把同步回滚了（那道闸是活的），所以症状是"照文档做的同步永远做不成"，
 * 而不是"镜像被写坏"——缺陷被自己的补救遮住了。
 *
 * 旧夹具为什么测不到：它拿**镜像自己的字节**当 canonical（只改 version），
 * 于是"复制一份身份不同的 manifest"这件事在这套夹具里物理上不可能发生。
 * 这里的 canonical 侧用 `fixtures/canonical-kernel-package.json`——那是
 * iterate-skill `origin/main`（02699de，iterate-kernel 0.1.7）那份 manifest 的原样字节。
 */

const CANONICAL_MANIFEST = path.join(REPO, 'updater', 'test', 'fixtures', 'canonical-kernel-package.json')

/**
 * 沙箱里的 root 与 mcp-shell 都写**当前真源**的号，而不是测试里抄一个数字：
 * 镜像的期望版本就是产品线的版本，抄死的数每次升版都会红一次（1.16.0 就红过，
 * 而那条红读的像是同步坏了）。
 */
const ROOT_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version

/**
 * 一个能**真跑完**的仓沙箱：root workspace + 镜像 + 打桩的 set-version/check-version，
 * 以及一个 build/test 都是空操作的 mcp-shell。被测的是文件的去向，不是 tsc，
 * 所以 manifest 里的 scripts 换成空操作，其余身份字段保持镜像真实值。
 */
function sandbox() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-sync-real-'))
  const repo = path.join(base, 'repo')
  const srcRoot = path.join(base, 'canonical-repo')
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'mcp-shell'), { recursive: true })
  fs.copyFileSync(SCRIPT, path.join(repo, 'tools', 'sync-kernel.sh'))
  const mirrorOf = (dest) =>
    fs.cpSync(path.join(REPO, 'kernel'), dest, {
      recursive: true,
      filter: (src) => !/(^|[/\\])(node_modules|dist|\.npm-cache)([/\\]|$)/.test(src),
    })
  mirrorOf(path.join(repo, 'kernel'))
  // 镜像：真字节，只把 build/test 换成空操作（本测关心文件去向，不关心 tsc）。
  const mirrorPkg = path.join(repo, 'kernel', 'package.json')
  const mirrorManifest = JSON.parse(fs.readFileSync(mirrorPkg, 'utf8'))
  mirrorManifest.scripts = { build: 'node -e 0', test: 'node -e 0' }
  fs.writeFileSync(mirrorPkg, `${JSON.stringify(mirrorManifest, null, 2)}\n`)
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    `${JSON.stringify({
      name: 'sandbox',
      private: true,
      version: ROOT_VERSION,
      workspaces: ['kernel', 'mcp-shell'],
      // 与真 root 同一形状：这两条都按**工作区名**寻址，所以镜像那份 manifest 的名字
      // 一旦被覆盖，这里就会像真机一样红在 `No workspaces found`。
      scripts: {
        build: 'npm run build --workspace @iterate/kernel && npm run build --workspace glasspane-mcp',
        test: 'npm test --workspaces --if-present',
      },
    }, null, 2)}\n`,
  )
  fs.writeFileSync(
    path.join(repo, 'mcp-shell', 'package.json'),
    `${JSON.stringify({ name: 'glasspane-mcp', version: ROOT_VERSION, scripts: { build: 'node -e 0', test: 'node -e 0' } }, null, 2)}\n`,
  )
  for (const stub of ['set-version.mjs', 'check-version.mjs']) {
    fs.writeFileSync(path.join(repo, 'scripts', stub), 'process.exit(0)\n')
  }
  // canonical 侧：src/schemas/fixtures/test 用镜像真字节（guard 1/2 因此看到真实文件形状），
  // 唯独 manifest 换成 capture 下来的那份 canonical。
  mirrorOf(path.join(srcRoot, 'kernel'))
  fs.writeFileSync(
    path.join(srcRoot, 'kernel', 'package.json'),
    `${JSON.stringify(JSON.parse(fs.readFileSync(CANONICAL_MANIFEST, 'utf8')), null, 2)}\n`,
  )
  return { base, repo, srcRoot, mirrorPkg }
}

function runRealSync(repo, srcRoot) {
  return spawnSync('/bin/bash', [path.join(repo, 'tools', 'sync-kernel.sh'), '--target=repo'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, KERNEL_SRC: srcRoot },
  })
}

test('sync-kernel: 真同步保留镜像自有的 manifest，只搬 canonical 的代码与契约', () => {
  const s = sandbox()
  const result = runRealSync(s.repo, s.srcRoot)
  assert.equal(result.status, 0, `真同步必须走通：${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /target=repo/)
  const after = JSON.parse(fs.readFileSync(s.mirrorPkg, 'utf8'))
  // 四条被覆盖掉的字段，每一条都对应一个真实消费者。
  assert.equal(after.name, '@iterate/kernel', '工作区名是 mcp-shell 的 file:../kernel 解析入口')
  assert.equal(after.private, true, '镜像不在 GlassPane 这条线上发布')
  assert.equal(after.version, ROOT_VERSION, '镜像跟着产品版本线走，不是 kernel 自己的号')
  assert.equal(after.dependencies.zod, '3.25.76', '镜像钉精确范围，可复现安装是这条线的决定')
  // exports/files 是契约形状，不是身份：这两项**必须**跟 canonical 一致（kernel 自己的
  // packaging 闸断言它们）。私有的一侧写 "." 才是缺陷——上一轮就是这两项没跟上。
  const canonicalManifest = JSON.parse(fs.readFileSync(CANONICAL_MANIFEST, 'utf8'))
  assert.deepEqual(Object.keys(after.exports).sort(), Object.keys(canonicalManifest.exports).sort(), '子路径导出要跟 canonical 一致')
  assert.deepEqual(after.files, canonicalManifest.files, 'fixture 语料要随包走（跨语言契约）')
  // 排除 manifest 不等于排除代码：canonical 那一侧的内容必须真的落地。
  const canonicalSrc = fs.readFileSync(path.join(s.srcRoot, 'kernel', 'src', 'index.ts'), 'utf8')
  assert.equal(fs.readFileSync(path.join(s.repo, 'kernel', 'src', 'index.ts'), 'utf8'), canonicalSrc, 'src/ 仍要从 canonical 过来')
  fs.rmSync(s.base, { recursive: true, force: true })
})

test('sync-kernel: canonical 新增一个镜像没有的依赖时先拒，且一个字节都不写', () => {
  const s = sandbox()
  const before = fs.readFileSync(s.mirrorPkg, 'utf8')
  const canonical = JSON.parse(fs.readFileSync(CANONICAL_MANIFEST, 'utf8'))
  canonical.dependencies = { ...canonical.dependencies, 'some-new-dep': '^1.0.0' }
  fs.writeFileSync(path.join(s.srcRoot, 'kernel', 'package.json'), `${JSON.stringify(canonical, null, 2)}\n`)
  const result = runRealSync(s.repo, s.srcRoot)
  assert.equal(result.status, 1, `缺依赖要拒：${result.stdout}\n${result.stderr}`)
  const shown = `${result.stderr}${result.stdout}`
  assert.match(shown, /some-new-dep/, '拒答必须点名缺哪一个包')
  assert.match(shown, /kernel\/package\.json/, '补救要给出改哪一份 manifest')
  assert.equal(fs.readFileSync(s.mirrorPkg, 'utf8'), before, '拒在写之前，镜像不该被动过')
  fs.rmSync(s.base, { recursive: true, force: true })
})
