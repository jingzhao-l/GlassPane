/**
 * 每日任务 2026-11-07 · 交给读者（和判据）的那句 git 原话，不许由操作系统的语言设置决定。
 *
 * 缺陷。本仓已经为同一件事钉过一次 locale（`installer/cli.js` 的 `verifyEnv`：验签那几趟
 * `LC_ALL=C LANG=C`，理由写在它头上那段注释里——"判据读的是英文措辞，不钉 locale 就等于让
 * 操作系统的语言设置决定这道检查出不出结论"，`updater/lib/signature.js` 的 `defaultRunGpg`
 * 也钉了）。但**取码那两趟没有**：`install.sh:717/728` 的 `git clone`、`installer/cli.js` 里
 * `readCloneFacts` / `advanceExistingClone` 的 `git … fetch --tags --depth 1`，spawn 时都只给
 * `encoding:'utf8'`。本机实测（中文 locale）：
 *   · `advanceExistingClone` 对不存在的引用回 `致命错误：无法找到远程引用 nosuchbranch`，
 *     而那条纪律的用例（本仓契约）期望 `/couldn.t find remote ref/`；
 *   · `install.sh` 的 clone 失败回 `致命错误：远程分支 nope-nope 在上游 origin 未找到`，
 *     契约期望 `Remote branch nope-nope not found in upstream origin`。
 * 后果不是"测试难看"：`clone_failure_text` 与 `classifyTagVerify` 都把这行原话**转述给读者**
 * 并据此归因，同一个失败在两条一键入口上因此给出两种语言的字节，而按措辞分叉的任何一侧
 * 都只在一种 locale 上成立。本机跑出来的两格红（CI 的 runner 是英文 locale，所以 CI 一直是绿的
 * ——这条缺陷只在非英文机器上现形，与 2026-10-31 #28 那族同一形状）。
 *
 * 修法：一枚环境四处共用（`gitLocalePinnedEnv()`，`verifyEnv` 现在也从它取），
 * clone/fetch 那几趟全部走它；判据本身不动。
 *
 * 第三条是**反空转对照**：先用同一枚中文 locale 直接跑一次裸 `git clone`，证明这台机器的 git
 * 真的会说中文；它要是不说中文，上面两条就什么都没测（那种情况本条直接红并说明理由）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { advanceExistingClone } from '../cli.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 本机中文 locale：产品必须把它压掉；这一枚只用于测试的子进程环境。 */
const ZH = { ...process.env, LC_ALL: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8', LANGUAGE: 'zh_CN' }

/** 一棵本地 bare 远端 + 一份 clone；`--depth 1` 让"浅仓那一问"照真路径走。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-locale-'))
  const remote = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const clone = path.join(root, 'clone')
  execFileSync('git', ['init', '-q', '--bare', remote])
  execFileSync('git', ['clone', '-q', remote, seed])
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n')
  const g = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  g(seed, 'add', '-A')
  g(seed, '-c', 'user.email=t@t.test', '-c', 'user.name=t', 'commit', '-q', '-m', 'a')
  g(seed, 'branch', '-M', 'main')
  g(seed, 'push', '-q', 'origin', 'main')
  execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'main', remote, clone])
  return { root, remote, clone, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('对照物必须真有中文可用：裸 git 在这台机器上说的就是中文，否则下面两条什么都没测', () => {
  const fx = fixture()
  try {
    const raw = spawnSync('git', ['-C', fx.clone, 'fetch', '--tags', '--depth', '1', 'origin', 'nosuchbranch'],
      { encoding: 'utf8', env: ZH })
    const text = `${raw.stderr ?? ''}${raw.stdout ?? ''}`
    assert.notEqual(raw.status, 0, '这趟 fetch 本该失败：它失败了才有原话可看')
    const speaksChinese = /无法找到远程引用|致命错误/.test(text)
    assert.ok(speaksChinese,
      '这台机器的 git 不输出中文（' + text.trim().slice(0, 120) +
      '）——那本文件前两条就成了空转对照，须换一台有 git 中文语言包的机器量，或把契约改成"两侧同答"')
  } finally {
    fx.cleanup()
  }
})

test('advanceExistingClone 在中文 locale 的操作者手里仍交出同一份字节的 git 原话', () => {
  const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, LANGUAGE: process.env.LANGUAGE }
  Object.assign(process.env, ZH)
  const fx = fixture()
  try {
    const result = advanceExistingClone({ repoDir: fx.clone, ref: 'nosuchbranch' })
    const text = JSON.stringify(result)
    assert.notEqual(result.ok, true, `不存在的引用不该被切成功：${text}`)
    assert.match(text, /couldn't find remote ref|could not find remote ref/,
      `那句原话被本地化了，而两条入口的契约与归因读的是这一份字节：${text}`)
    assert.doesNotMatch(text, /无法找到远程引用/, `产品没把 locale 钉住：${text}`)
  } finally {
    fx.cleanup()
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test('install.sh 的 clone 失败归因在中文 locale 下仍是同一份字节', () => {
  const fx = fixture()
  const target = path.join(fx.root, 'fresh-clone')
  try {
    // 走的是真 clone 那一支：`--repo` 要的是源码树形状（engine/Package.swift + mcp-shell/package.json），
    // 一枚 bare 远端会被它按用法错拒掉（那是对的），所以这里用 GLASSPANE_REPO_URL=file:// 覆盖定位。
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
    assert.doesNotMatch(text, /致命错误：|远程分支 .* 在上游|无法找到远程引用/,
      `install.sh 把本地化的 git 原话转述给了读者：${text.slice(0, 320)}`)
    assert.match(text, /Remote branch|not found in upstream origin|fatal:/,
      `归因那句里没有英文的 git 原话：${text.slice(0, 320)}`)
  } finally {
    fx.cleanup()
  }
})
