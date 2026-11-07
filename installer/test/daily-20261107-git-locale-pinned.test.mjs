/**
 * 每日任务 2026-11-07 · 交给读者（和判据）的那句 git 原话，不许由操作系统的语言设置决定。
 *
 * 缺陷。本仓已经为同一件事钉过一次 locale（`installer/cli.js` 的 `verifyEnv`：验签那几趟
 * `LC_ALL=C LANG=C`，理由写在它头上那段注释里——判据读的是英文措辞，不钉 locale 就等于让操作
 * 系统的语言设置决定这道检查出不出结论；`updater/lib/signature.js` 的 `defaultRunGpg` 也钉了）。
 * 但**取码那几趟没钉**：`install.sh` 的两趟 `git clone`、`installer/cli.js` 里 `readCloneFacts`
 * 与 `advanceExistingClone` 的 `git … fetch --tags --depth 1`，spawn 时只给 `encoding:'utf8'`。
 * 本机中文 locale 实测：`install.sh` 回 `致命错误：远程分支 nope-nope 在上游 origin 未找到`，
 * `advanceExistingClone` 回 `致命错误：无法找到远程引用 nosuchbranch`，而 `clone_failure_text`
 * 与那句归因是把 stderr **原话转述给读者**的——同一个失败在两条一键入口上给出两种语言的字节，
 * 而按措辞分叉的任何一侧都只在一种 locale 上成立（先例：#28 的 `é`、`verifyEnv` 那段注释）。
 *
 * 三条用例分两腿，**每一腿都能单独倒**：
 *   ① 结构腿（任何机器都跑）：产品必须真的把 `LC_ALL=C LANG=C` 交到那几趟 git 上——
 *      cli.js 一侧用记录型假 spawn 接住调用方传的 options，install.sh 一侧数那两趟真 clone。
 *      这一条不依赖本机有没有中文语言包，因此它是"闸在英文 runner 上也还活着"的那一半。
 *   ②③ 行为腿（只有造得出另一语言时才谈得上）：中文 locale 下真跑一次缺引用的 clone/fetch，
 *      断言产品交回来的是钉过的字节。跑不出中文的那台机器上这两条**具名跳过并说明缺什么**，
 *      而不是安静通过；补它的确切动作写在跳过理由里。③ 另外按平台分一支：`install.sh` 的平台闸
 *      排在动树之前（本仓明令的那条次序），非 macOS 上压根走不到 clone 那一支——先例 #29。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { advanceExistingClone, readCloneFacts } from '../cli.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const ZH = { ...process.env, LC_ALL: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8', LANGUAGE: 'zh_CN' }

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-locale-'))
  const remote = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const clone = path.join(root, 'clone')
  execFileSync('git', ['init', '-q', '--bare', remote])
  execFileSync('git', ['clone', '-q', remote, seed])
  const g = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n')
  g(seed, 'add', '-A')
  g(seed, '-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'a')
  g(seed, 'branch', '-M', 'main')
  g(seed, 'push', '-q', 'origin', 'main')
  execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'main', remote, clone])
  return { root, remote, clone, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** 这台机器的 git 有没有中文语言包（决定②③能不能谈行为）。 */
function gitSpeaksChinese() {
  const fx = fixture()
  try {
    const raw = spawnSync('git', ['-C', fx.clone, 'fetch', '--tags', '--depth', '1', 'origin', 'nosuchbranch'],
      { encoding: 'utf8', env: ZH })
    if (raw.status === 0) return false
    return /无法找到远程引用|致命错误/.test(`${raw.stderr ?? ''}${raw.stdout ?? ''}`)
  } finally {
    fx.cleanup()
  }
}

const CAN_LOCALIZE = gitSpeaksChinese()

// MARK: - ① 结构腿

test('结构：取码那几趟 git 必须真的收到钉过的 locale 环境', () => {
  const seen = []
  const recording = (bin, args, options = {}) => {
    if (bin === 'git') seen.push({ args, env: options.env })
    return { status: 128, stdout: '', stderr: 'fatal: couldn\'t find remote ref nosuchbranch' }
  }
  const out = advanceExistingClone({ repoDir: '/tmp/whatever', ref: 'nosuchbranch', spawn: recording })
  assert.equal(out.action, 'refuse', JSON.stringify(out))
  assert.ok(seen.length >= 1, '记录型假 spawn 一趟 git 都没接到——被测那一侧根本没走这条路径')
  for (const call of seen) {
    assert.equal(call.env?.LC_ALL, 'C', `这趟 git 没收到 LC_ALL=C：${JSON.stringify(call).slice(0, 160)}`)
    assert.equal(call.env?.LANG, 'C', `这趟 git 没收到 LANG=C：${JSON.stringify(call).slice(0, 160)}`)
  }
  // 第二处（readCloneFacts）也必须走同一枚环境——它是"已有 clone 被前进"那一支真正读事实的地方。
  const seen2 = []
  readCloneFacts({
    targetDir: '/tmp/whatever', ref: 'nosuchbranch',
    spawn: (bin, args, options = {}) => {
      if (bin === 'git') seen2.push(options.env)
      return { status: 128, stdout: '', stderr: '' }
    },
  })
  assert.ok(seen2.length >= 1, 'readCloneFacts 一趟 git 都没发——这条对照失去对象')
  seen2.forEach((env, i) => assert.equal(env?.LC_ALL, 'C', `readCloneFacts 第 ${i} 趟没钉 locale`))
})

test('结构：install.sh 的每一趟真 clone 都带钉，且 clone 执行点总数就是那个数', () => {
  const text = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8')
  const lines = text.split('\n')
  const executing = lines.filter((l) => /^\s*(LC_ALL=C LANG=C )?git clone /.test(l))
  const pinned = lines.filter((l) => /^\s*LC_ALL=C LANG=C git clone /.test(l))
  assert.ok(executing.length >= 1, 'install.sh 里找不到任何一趟真 git clone——扫描形状变了')
  assert.equal(pinned.length, executing.length,
    `有 ${executing.length} 趟真 clone，只有 ${pinned.length} 趟钉了 locale：漏钉那一趟就是把原话交给操作系统语言的那一趟`)
  // 说明性文本（dry-run 计划行、"下一步"指引）里出现 git clone 不算执行点，这里数的是行首命令。
  const sayClone = lines.filter((l) => /^\s*(say|printf|echo)\b.*git clone /.test(l))
  assert.ok(sayClone.length >= 1, '连说明性的 clone 行都扫不到了——本条的下限失效，说明 install.sh 的文案搬家了')
})

test('结构：cli.js 里每一趟 git spawn 都带着钉过的环境（清单由源码扫出来，不点名行号）', () => {
  const lines = fs.readFileSync(path.join(REPO, 'installer', 'cli.js'), 'utf8').split('\n')
  const calls = lines
    .map((line, i) => ({ line, at: i + 1 }))
    // 调用可能跨行：以 `spawn('git'` 起头的那一行找到它，再向下取到第一个 `})` 之前。
    .filter(({ line }) => /spawn\('git'/.test(line.trim().startsWith('//') ? '' : line))
  assert.ok(calls.length >= 8,
    `只扫到 ${calls.length} 趟 git spawn——cli.js 的取码路径搬家了，或者这条闸的谓词失效（空转）`)
  const unpinned = []
  for (let i = 0; i < calls.length; i++) {
    const at = calls[i].at
    const body = lines.slice(at - 1, Math.min(lines.length, at + 5)).join('\n')
    // 两个合法拼写都算：`gitLocalePinnedEnv()` 本体，以及从它取的 `verifyEnv(…)`（验签那一趟
    // 还要额外带一次性 GNUPGHOME）。除此以外的任何一枚 spawn 都是"把原话交给操作系统语言"。
    if (!/gitLocalePinnedEnv\(\)|verifyEnv\(/.test(body)) unpinned.push(`cli.js:${at}`)
  }
  assert.deepEqual(unpinned, [], `这些 git 调用没带钉过的环境，它们的 stderr 会被本地化：${unpinned.join(', ')}`)
})

// MARK: - ②③ 行为腿

test('行为：中文 locale 的操作者从 advanceExistingClone 手里拿到的仍是钉过的那份字节', (t) => {
  if (!CAN_LOCALIZE) {
    t.skip('这台机器的 git 没有中文语言包，行为腿无从判定；结构腿（上面两条）负责这一档。'
      + '补它：在装有 zh_CN.UTF-8 的 mac/Linux 上跑本文件（或在容器里 locale-gen zh_CN.UTF-8）。')
    return
  }
  const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, LANGUAGE: process.env.LANGUAGE }
  Object.assign(process.env, ZH)
  const fx = fixture()
  try {
    const out = advanceExistingClone({ repoDir: fx.clone, ref: 'nosuchbranch' })
    const text = JSON.stringify(out)
    assert.equal(out.action, 'refuse', text)
    assert.match(text, /couldn.t find remote ref/, `钉过之后还该是这一份字节：${text}`)
    assert.doesNotMatch(text, /无法找到远程引用/, `产品没钉住：${text}`)
  } finally {
    fx.cleanup()
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test('行为：install.sh 的 clone 失败归因在中文 locale 下仍是钉过的那份字节', (t) => {
  if (!CAN_LOCALIZE) {
    t.skip('同上一条：本机 git 无从本地化，行为腿不可判定；结构腿数过 clone 执行点并逐条核过钉。')
    return
  }
  if (process.platform !== 'darwin') {
    t.skip('install.sh 的平台闸排在动树之前（本仓明令的次序，见 install.sh:749 一带），'
      + '非 macOS 上压根走不到 clone 那一支——按平台问哪一支该跑的先例是 2026-10-31 的 #29。')
    return
  }
  const fx = fixture()
  const target = path.join(fx.root, 'fresh-clone')
  try {
    const run = spawnSync('/bin/sh', [path.join(REPO, 'install.sh'), '--no-prompt'], {
      encoding: 'utf8',
      cwd: fx.root,
      env: {
        ...ZH,
        GLASSPANE_REPO_URL: `file://${fx.remote}`,
        GLASSPANE_REF: 'nosuchtag-xyz',
        GLASSPANE_INSTALL_DIR: target,
      },
      timeout: 180000,
    })
    const text = `${run.stderr ?? ''}${run.stdout ?? ''}`
    assert.notEqual(run.status, 0, `一个不存在的 ref 不该装成功：${text.slice(0, 200)}`)
    assert.match(text, /git clone 失败/, `这一趟该落在 clone 失败那句归因里：${text.slice(0, 320)}`)
    assert.doesNotMatch(text, /致命错误：|无法找到远程引用/,
      `install.sh 把本地化的 git 原话转述给了读者：${text.slice(0, 320)}`)
  } finally {
    fx.cleanup()
  }
})
