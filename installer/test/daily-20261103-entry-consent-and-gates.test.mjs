/**
 * 本轮（2026-11-03）两条一键入口的三处修复。
 *
 *  #11 弱结论买了容易的路。`installer/cli.js` 的 `tagVerifyDecision` 对 `unavailable`
 *      （这道检查在本机没跑成）是**硬拒**，对 `unsigned`（这一版确实没有发布签名）却只 warn
 *      就继续装。两档说的是同一件事："这台机器现在证明不了这一版是谁发布的"。而 `SECURITY.md`
 *      那一节写的恰恰是要**人来批准**（updater 侧就是 `--consent unsigned-release`）。
 *      现在 `unsigned` 也要求显式同意——用的是同一档上已有的那枚旗标，没有新增对外参数。
 *  #12 平台闸那句"一个字节都不写"被它上面几行的 `advance_existing_clone` 否证（fetch 写对象、
 *      checkout 重写工作树）。闸的位置是 2026-10-22 的决定，不能挪，于是让那一步自己先问平台。
 *  #13 `--repo=<目录>` 连写在 install.sh 里不认识 ⇒ 先付一次 depth-1 网络 clone，再由
 *      installer 以"未知参数"退 2。两条入口退码相同，但只有这一条写了盘，而那枚旗标存在的
 *      理由就是"别 clone"。现在在付代价之前给同一个答案，且不新增参数语义（cli.js 也收连写）。
 *
 * 三条都跑真进程、真 git：断言的是**磁盘上的字节有没有动**，不是脚本说了什么。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { tagVerifyDecision } from '../cli.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const INSTALL_SH = path.join(REPO, 'install.sh')

function tmp(label) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `gp-${label}-`))
}

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

/** 一棵真的、干净的、带两个判据文件的源仓 + 一个旧 tag。 */
function makeSrc(withNewTag = false) {
  const src = tmp('src')
  fs.mkdirSync(path.join(src, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(src, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(src, 'engine', 'Package.swift'), '// swift-tools-version:5.10\n')
  fs.writeFileSync(path.join(src, 'mcp-shell', 'package.json'), '{}\n')
  git(src, ['init', '-q', '.'])
  git(src, ['add', '-A'])
  git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'old'])
  git(src, ['tag', 'v0.0.1-old'])
  if (withNewTag) {
    fs.writeFileSync(path.join(src, 'engine', 'Package.swift'), '// changed\n')
    git(src, ['add', '-A'])
    git(src, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'new'])
    git(src, ['tag', 'v9.9.9-new'])
  }
  return src
}

/** 一把只把 uname 换成别的世界的 PATH 前缀目录（既有夹具的同一形）。 */
function stubBin(dir, kernel) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'uname'), `#!/bin/sh\n[ "$1" = "-s" ] && echo ${kernel} || echo ${kernel}\n`, { mode: 0o755 })
  return dir
}

/* --------------------------------------------------------------------- #11 */

test('#11 unsigned 不再白拿放行：没有显式同意就拒，同意了才继续并且说清是谁放行的', () => {
  const sig = { status: 'unsigned', detail: 'git verify-tag: no signature' }
  const base = { sig, pinRef: 'v1.24.1', repoDir: '/Users/dev/glasspane' }

  const without = tagVerifyDecision(base)
  assert.equal(without.action, 'refuse',
    `"缺来源证明"这一档从前只 warn 就继续，而"这道检查没跑成"却硬拒——同一件事两个答案：${without.text}`)
  assert.match(without.text, /--accept-unverified-signature/, '拒装必须给得出那枚显式同意的旗标')
  assert.match(without.text, /invalid/, '必须说清 invalid（有签名而验不过）不在任何同意覆盖范围内')
  assert.ok(!without.text.includes('继续安装'), '拒装文案里不许出现放行话：' + without.text)

  const withConsent = tagVerifyDecision({ ...base, acceptUnverified: true })
  assert.equal(withConsent.action, 'warn', '同意了就该继续，并把"是哪一枚旗标放行的"写进那句话')
  assert.match(withConsent.text, /--accept-unverified-signature 显式放行/, withConsent.text)
  assert.match(withConsent.text, /不是"验签通过"/, '放行话不许读起来像验过了：' + withConsent.text)

  // 三道同意门里另外两道不许因为这一改而松：invalid 仍是永不被覆盖的硬拒。
  const invalid = tagVerifyDecision({
    ...base, acceptUnverified: true,
    sig: { status: 'invalid', detail: 'BAD signature', raw: '' },
  })
  assert.equal(invalid.action, 'refuse', '带同意也不许覆盖"签名在而验不过"')
})

test('#11 出路里点名的命令是惰性词（照抄不会被目录名反噬）', () => {
  const hostile = "/tmp/it's a `touch /tmp/pwned`"
  const text = tagVerifyDecision({
    sig: { status: 'unsigned', detail: 'x' }, pinRef: 'v1.2.3', repoDir: hostile,
  }).text
  assert.match(text, /git -C '/, `git -C 那一枚参数位必须是单引号惰性词：${text.slice(0, 200)}`)
  assert.doesNotMatch(text, /git -C "/, '双引号包不住 $( ) 与反引号：出路里不许用它')
})

/* --------------------------------------------------------------------- #12 */

test('#12 非 macOS 上，既有 clone 那一条路在动它之前就停下——磁盘字节是判据', () => {
  const src = makeSrc(true)
  const work = tmp('gate')
  const cloneDir = path.join(work, 'glasspane')
  const bin = stubBin(path.join(work, 'bin'), 'Linux')
  try {
    const clone = git(work, ['clone', '--quiet', '--branch', 'v0.0.1-old', '--single-branch', `file://${src}`, cloneDir])
    assert.equal(clone.status, 0, clone.stderr)
    const headBefore = git(cloneDir, ['rev-parse', '--verify', 'HEAD']).stdout.trim()
    const packsBefore = fs.readdirSync(path.join(cloneDir, '.git', 'objects'))
      .filter((n) => /^[0-9a-f]{2}$/.test(n)).length

    const run = spawnSync('/bin/sh', [INSTALL_SH], {
      cwd: work, encoding: 'utf8', stdin: 'ignore', timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: cloneDir, GLASSPANE_REF: 'v9.9.9-new',
        GLASSPANE_REPO_URL: `file://${src}`,
      },
    })
    const out = `${run.stdout}${run.stderr}`
    assert.match(out, /只支持 macOS（uname -s = Linux）/, `平台闸没说这话：${out.slice(0, 300)}`)
    assert.notEqual(run.status, 0, '非 macOS 不许退 0')
    assert.equal(git(cloneDir, ['rev-parse', '--verify', 'HEAD']).stdout.trim(), headBefore,
      '那句"一个字节都不写"要成立：HEAD 动了就是 fetch/checkout 已经跑过')
    const packsAfter = fs.readdirSync(path.join(cloneDir, '.git', 'objects'))
      .filter((n) => /^[0-9a-f]{2}$/.test(n)).length
    assert.equal(packsAfter, packsBefore, `对象目录多了条目：fetch 真的跑过了（${packsBefore} → ${packsAfter}）`)
    assert.doesNotMatch(out, /既有 clone 没有被前进/, '不该走到"前进失败"那句——它已经在动树之前停了')
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
})

/* --------------------------------------------------------------------- #13 */

test('#13 `--repo=<目录>` 连写在付 clone 代价之前就退，且两枚形式的答案与 installer 相同', () => {
  const work = tmp('repo-eq')
  const cloneDir = path.join(work, 'glasspane')
  const bin = stubBin(path.join(work, 'bin'), 'Darwin')
  try {
    const run = spawnSync('/bin/sh', [INSTALL_SH, `--repo=${work}/somewhere`], {
      cwd: work, encoding: 'utf8', stdin: 'ignore', timeout: 120_000,
      env: {
        // 桩目录排在最前，真实 PATH 的其余段要留着：install.sh 第一步问 node，
        // 把它挡掉就变成"未找到 Node.js"那一档退 1，测的就不是这里要测的那一道闸了。
        ...process.env, PATH: `${bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: cloneDir,
      },
    })
    const out = `${run.stdout}${run.stderr}`
    assert.equal(run.status, 2, `连写形该与 installer/cli.js 同退 2，实退 ${run.status}：${out.slice(0, 300)}`)
    assert.match(out, /两枚的形式/, out.slice(0, 300))
    assert.equal(fs.existsSync(cloneDir), false,
      '这一趟不许留下 clone——那枚旗标存在的理由就是"别 clone"，先 clone 再拒是两种副作用')
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('#13 对照：两枚的形式照旧被认下来（这条闸不许把合法用法一起挡掉）', () => {
  const src = makeSrc()
  const work = tmp('repo-ok')
  const bin = stubBin(path.join(work, 'bin'), 'Darwin')
  try {
    const run = spawnSync('/bin/sh', [INSTALL_SH, '--repo', src, '--no-bootstrap'], {
      cwd: work, encoding: 'utf8', stdin: 'ignore', timeout: 120_000,
      env: {
        // 桩目录排在最前，真实 PATH 的其余段要留着：install.sh 第一步问 node，
        // 把它挡掉就变成"未找到 Node.js"那一档退 1，测的就不是这里要测的那一道闸了。
        ...process.env, PATH: `${bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: path.join(work, 'nope'),
      },
    })
    const out = `${run.stdout}${run.stderr}`
    // `--repo <目录>` 收下了：它要么把定位交给那棵树，要么在别的地方停——但**绝不**是"未知旗标"那一档。
    assert.doesNotMatch(out, /两枚的形式/, `合法的两枚写法被当成连写挡掉了：${out.slice(0, 300)}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
})
