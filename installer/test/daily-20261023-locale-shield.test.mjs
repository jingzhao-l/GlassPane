/**
 * 2026-10-23（缺陷 82）——`install.sh` 里 `$VAR` 紧邻一个全角标点，在 macOS 的 UTF-8 语言环境下
 * 会被 bash 3.2 当成变量名的一部分，`set -u` 于是让脚本**死在那一行**：拒绝与进度整句打不出来。
 *
 * 现场（本机实测，同一条命令只换 locale）：
 *   LC_ALL=C           → 错误: 目标目录已存在且不是 GlassPane 仓库: /tmp/…/glasspane（用 …重试）
 *   LC_ALL=en_US.UTF-8 → install.sh: line 228: CLONE_DIR\u00ef: unbound variable
 *
 * 为什么它躲过了整套既有测试：所有端到端用例都通过 `spawnSync` 起脚本，而 CI runner 的 node
 * 进程环境里没有 `LANG`/`LC_ALL`＝C locale，那条吸字节的代码路径根本不执行。macOS 的 GUI 会话、
 * Terminal、以及 `curl | sh` 的默认环境恰恰是 UTF-8 locale——也就是说**用户会遇到的那一档**
 * 从来没被跑过。这条红是 CI 的 `macOS node suites` 泳道先撞出来的（`daily-20261020.test.mjs`
 * 里那句"目标目录已存在"断言读到的是 unbound variable）。
 *
 * 两半各管一段：
 *  · **静态那一半在任何平台都能红**，它扫的是形状：`$NAME` 后面紧跟一个非 ASCII 字符，
 *    且没有写成 `${NAME}`。`$(…)` 不算（命令替换由它自己的右括号定界，bash 不会往里吸字节）。
 *  · **行为那一半把 `uname` 桩成 Darwin**（同 `daily-20261020.test.mjs` 的办法），于是这一支在
 *    ubuntu 上也能被走到；它读的是产品真的那句话到了没有。在 macOS 上它才是那把能红的尺子
 *    （bash 3.2 + UTF-8 locale）；在 Linux 上括号写法不可能红——这边界写在这里，不假装两边等价。
 *
 * REVERSE MUTATION（每条点自己的名）：
 *  · 把 `${CLONE_DIR}（用 GLASSPANE_REPO` 改回 `$CLONE_DIR（` → 静态那条红（点名 install.sh:228 与那个变量）。
 *  · 同上，在 macOS 上行为那第一条也红：读到的是 `unbound variable` 而不是那句拒绝。
 *  · 往 `engine/scripts/make-app.sh` 或 `tools/*.sh` 里塞一条同样的形状 → 静态那条红（扫的面不止 install.sh）。
 *  · 把扫描器改成也吃 `$(…)` → "命令替换不算缺陷"那条对照红（否则扫描器会把产品里合法的写法天天判红，
 *    下一位只会把它关掉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const INSTALL_SH = path.join(REPO, 'install.sh')

/** 会被随发布物交付、并在 macOS 的 shell 里跑起来的那些脚本。 */
const SHELL_SURFACES = [
  'install.sh',
  'engine/scripts/make-app.sh',
  'tools/gpg-signing.sh',
  'tools/release-signing-gate.sh',
  'tools/sync-kernel.sh',
]

/**
 * `$NAME` 后面紧跟一个非 ASCII 字符，且这个 `$` 没有写成 `${`。
 * 引号里的位置不重要：bash 3.2 在 UTF-8 locale 下把多字节首字节算进名字，正是发生在展开那一刻。
 */
function unbracedAdjacent(text) {
  const hits = []
  for (const [index, line] of text.split('\n').entries()) {
    for (const m of line.matchAll(/\$(\{?)([A-Za-z_][A-Za-z0-9_]*)()([^\x00-\x7f])/g)) {
      if (m[1] === '{') continue
      hits.push({ line: index + 1, name: m[2], after: m[4], text: line.trim().slice(0, 72) })
    }
  }
  return hits
}

function scratch(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix))
}

/** 一枚只回 `echo <platform>` 的 `uname`，加上 coreutils 够用的一份 PATH。 */
function stubUname(platform) {
  const dir = scratch('gp-uname-stub-')
  const file = path.join(dir, 'uname')
  fs.writeFileSync(file, `#!/bin/sh\necho ${platform}\n`, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
  return dir
}

/** UTF-8 locale 那一档——用户实际遇到的那一档；`-u LANG` 保证是我们说的这一个。 */
function utf8Env(extra) {
  const env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
  return { ...env, ...extra }
}

// 注意：这一份文件里每一处真跑 spawn 都**就地**写 `HOME:` 与 `cwd:`，不抽成 helper。
// `daily-20261022-install-isolation.test.mjs` 那条隔离闸是按 spawn 点附近的文本判的（它判的是
// "非 dry-run 那一支换了家目录与工作目录没有"），把 spawn 包进函数会让它看不见——那条闸不是
// 形式主义：上一轮就是被"测试继承了仓库根与真 HOME"咬过一次（真装进开发者机器）。

test('静态：交付的 shell 里不许有 `$NAME` 紧跟非 ASCII 而未写成 `${NAME}`', () => {
  const found = []
  for (const rel of SHELL_SURFACES) {
    const abs = path.join(REPO, rel)
    if (!fs.existsSync(abs)) continue
    for (const hit of unbracedAdjacent(fs.readFileSync(abs, 'utf8'))) {
      found.push(`${rel}:${hit.line} $${hit.name}${hit.after} —— ${hit.text}`)
    }
  }
  assert.deepEqual(found, [],
    '这些行在 macOS 的 UTF-8 locale 下会让 bash 3.2 把多字节首字节吸进变量名，'
    + `set -u 直接死在这一行（用户读到的是 unbound variable，不是那句拒绝）：\n${found.join('\n')}`)
})

test('对照：`$(…)` 定界的命令替换不是这一类缺陷，扫描器不许把它也判红', () => {
  // install.sh 里合法写法：`= $(uname -s)）：` ——命令替换由自己的右括号结束，bash 不会往里吸字节。
  const text = fs.readFileSync(INSTALL_SH, 'utf8')
  assert.ok(/\$\(uname -s\)）/.test(text), '前提变了：install.sh 里那条 `$(uname -s)）` 不在了，这条对照要看的是别的形状')
  const line = text.split('\n').find((l) => l.includes('$(uname -s)）')) ?? ''
  assert.deepEqual(unbracedAdjacent(line), [], '`$(…)` 被扫描器当成了缺陷——它会把合法写法天天判红')
  // 反向对照：把同一行换成未加括号的 `$REPO）` 形状，扫描器必须抓到。
  assert.equal(unbracedAdjacent('fail "源码已经在手边（$REPO）这一趟不付 clone"').length, 1,
    '扫描器抓不到真正的形状——它是一条不会红的尺子')
})

test('行为：UTF-8 locale 下"目标目录已存在"那句必须完整到达（不是 unbound variable）', () => {
  const home = scratch('gp-locale-home-')
  const cwd = scratch('gp-locale-cwd-')
  const parent = scratch('gp-locale-target-')
  const stub = stubUname('Darwin')
  const target = path.join(parent, 'glasspane')
  fs.mkdirSync(target)
  try {
    const raw = spawnSync('/bin/sh', [INSTALL_SH], {
      cwd: cwd,
      env: utf8Env({
        PATH: `${stub}:${process.env.PATH}`,
        HOME: home,
        GLASSPANE_REPO: '',
        GLASSPANE_REPO_URL: 'file:///nonexistent-glasspane-probe',
        GLASSPANE_INSTALL_DIR: target,
        GLASSPANE_INSTALL_DRY_RUN: '0',
      }),
      encoding: 'utf8', timeout: 90_000, input: '', maxBuffer: 32 * 1024 * 1024,
    })
    const r = { status: raw.status, out: `${raw.stdout ?? ''}${raw.stderr ?? ''}` }
    assert.equal(r.status, 1, r.out)
    assert.ok(!/unbound variable/.test(r.out), `脚本死在展开那一行了，读者什么动作都拿不到：${r.out}`)
    assert.match(r.out, /目标目录已存在且不是 GlassPane 仓库/, r.out)
    assert.match(r.out, /清理后重试/, '那句拒绝的下一步动作也必须一起到——它和路径在同一条展开里')
    assert.deepEqual(fs.readdirSync(cwd), [], '被拒的这一趟不许在当前目录留下东西')
    assert.deepEqual(fs.readdirSync(home), [], '被拒的这一趟不许在沙箱 HOME 里留下东西')
  } finally {
    for (const dir of [home, cwd, parent, stub]) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('行为：UTF-8 locale 下"既有 clone"那两行与 clone 计划行都到得了', () => {
  const home = scratch('gp-locale-home2-')
  const cwd = scratch('gp-locale-cwd2-')
  const stub = stubUname('Darwin')
  // 一枚 GlassPane 形状的"既有 clone"：`looks_like_repo` 认它，于是走到 198/199 那两行。
  const existing = path.join(scratch('gp-locale-existing-'), 'glasspane')
  fs.mkdirSync(path.join(existing, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(existing, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(existing, 'engine', 'Package.swift'), '// swift\n')
  fs.writeFileSync(path.join(existing, 'mcp-shell', 'package.json'), '{}\n')
  try {
    // dry-run：打印计划就退出，绝不 exec installer（上一轮那条实测代价写在 cli.js 的头注里）。
    const rawDry = spawnSync('/bin/sh', [INSTALL_SH], {
      cwd: cwd,
      env: utf8Env({
        PATH: `${stub}:${process.env.PATH}`, HOME: home, GLASSPANE_REPO: '',
        GLASSPANE_INSTALL_DIR: existing, GLASSPANE_INSTALL_DRY_RUN: '1',
      }),
      encoding: 'utf8', timeout: 90_000, input: '', maxBuffer: 32 * 1024 * 1024,
    })
    const dry = { status: rawDry.status, out: `${rawDry.stdout ?? ''}${rawDry.stderr ?? ''}` }
    assert.equal(dry.status, 0, dry.out)
    assert.ok(!/unbound variable/.test(dry.out), dry.out)
    assert.match(dry.out, /使用既有 clone: /, dry.out)
    assert.match(dry.out, /不会被自动切到 v[0-9]+\.[0-9]+\.[0-9]+；/, '那半句里的版本号与"；"必须一起到达')
    assert.match(dry.out, /\[dry-run\] 将执行: node /, dry.out)

    // 定位不到源码 ⇒ 真要 clone：那一行 `clone 源码到 $CLONE_DIR（ref: $REF）` 在展开里。
    // URL 是一条不存在的 file://，所以 git 只能快速失败，不碰网络也不写盘。
    const missing = path.join(home, 'nowhere-clone')
    const rawReal = spawnSync('/bin/sh', [INSTALL_SH], {
      cwd: cwd,
      env: utf8Env({
        PATH: `${stub}:${process.env.PATH}`, HOME: home, GLASSPANE_REPO: '',
        GLASSPANE_REPO_URL: 'file:///nonexistent-glasspane-probe',
        GLASSPANE_INSTALL_DIR: missing, GLASSPANE_INSTALL_DRY_RUN: '0',
      }),
      encoding: 'utf8', timeout: 90_000, input: '', maxBuffer: 32 * 1024 * 1024,
    })
    const real = { status: rawReal.status, out: `${rawReal.stdout ?? ''}${rawReal.stderr ?? ''}` }
    assert.equal(real.status, 1, real.out)
    assert.ok(!/unbound variable/.test(real.out), real.out)
    assert.match(real.out, /clone 源码到 .*（ref: v[0-9.]+）……/, '进度那行带着 ref 与全角括号，必须在同一句里到齐')
    assert.match(real.out, /git clone 失败|原因不是网络|无法进一步归因/, `clone 失败要给出归因，不是半句话：${real.out}`)
    assert.equal(fs.existsSync(missing), false, '失败的 clone 不许把目标目录留在盘上')
  } finally {
    for (const dir of [home, cwd, path.dirname(existing), stub]) fs.rmSync(dir, { recursive: true, force: true })
  }
})
