/**
 * 2026-11-05（lane：拒装文案里那条补救必须跑得通）—— P2。
 *
 * 缺陷：`installer/cli.js` 四支验签拒绝文案（invalid / unavailable / unsigned / 未知判据）都写着
 * `git -C <repo> tag -v <ref>`，让读者"自己核对一下"。可内置发布公钥只活在那次运行的
 * **一次性钥匙环**里（`verifyCloneTagGpg` 的 finally 就把它删了），`~/.gnupg` 里没有这把钥匙，
 * 于是照抄那一行对一份完全健康的发布也只会回
 * `gpg: Can't check signature: No public key` + 非零退出——一条**永远跑不通**的补救，
 * 而它跑不通的形态恰好长得像"验不过"。读者据此得出的结论比没有这条补救更坏。
 *
 * 修法：四支共用一个纯函数 `isolatedVerifyCommand({repoDir, ref, installerPath})` 产出的
 * 同一条链——建一次性钥匙环、用 node 从**这个 installer 文件**里取
 * `GLASSPANE_SIGNING_PUBLIC_KEY`、导入、`GNUPGHOME` + `LC_ALL=C` + `-c gpg.program=gpg` 验、
 * 两条路都把钥匙环删掉。插进去的三份值全部走 `quoteShellArg`（目录名来自 `--repo`/`GLASSPANE_REPO`）。
 *
 * REVERSE MUTATION（编号 = 本文件里 test() 的出现顺序；红点为本机实测）：
 *  · M6 把"未知判据"那一支的出路改回 `git -C <repo> tag -v <ref>` ⇒ 第 1 条红（四支不再共用
 *    一条出路，且出路上又出现了那句读 ~/.gnupg 的命令）；
 *  · M7 把出路里的 `quoteShellArg(repoDir)` 换成裸插值 ⇒ 第 2 条红（文本层）与第 4 条红
 *    （替身跑读到的 argv 里，`/Volumes/a b/GlassPane` 被拆成两个词）；
 *  · M12 把 `-c gpg.program=gpg -c gpg.format=openpgp` 从那条链里摘掉 ⇒ 第 4 条红；
 *  · M13 把清理挪进成功那一支（`… && rm -rf "$KEYRING"`）⇒ 第 5 条红（git 桩退 3 时钥匙环
 *    还留在盘上）；
 *  · 把 `quoteShellArg(ref)` 摘掉 ⇒ 第 4 条红在 `verify-tag` 那一枚参数上（同名不同值的载荷
 *    由 shell 重排）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  RELEASE_VERSION,
  commandAvailable,
  isolatedVerifyCommand,
  quoteShellArg,
  repoHasRef,
  tagVerifyDecision,
} from '../cli.js'
import { PINNED_KEY_ID } from './support/gpg-verify-fixtures.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'cli.js')
const REPO = path.resolve(HERE, '..', '..')
const RELEASE_REF = `v${RELEASE_VERSION}`
const REAL_RUN_OK = commandAvailable('gpg') && commandAvailable('git') && commandAvailable('node')
  && repoHasRef(REPO, RELEASE_REF)

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gp-${label}-`))
}

/** 四支拒绝共用同一条出路，且那条出路里不许再留下 `tag -v` 那一问。 */
test('四条验签文案共用同一条隔离验签命令，且没有一处还写着 git tag -v', () => {
  const seen = []
  for (const status of ['invalid', 'unavailable', 'unsigned', 'a-verdict-nobody-has-seen']) {
    const verdict = tagVerifyDecision({
      sig: { status, detail: 'd' }, pinRef: 'v1.29.1', repoDir: '/Users/dev/glasspane',
    })
    assert.equal(verdict.action, 'refuse', status + ' 那一档必须拒')
    assert.doesNotMatch(verdict.text, /tag -v/, `${status} 的出路里还有那句读 ~/.gnupg 的命令：${verdict.text}`)
    const found = isolatedVerifyCommand({ repoDir: '/Users/dev/glasspane', ref: 'v1.29.1' })
    assert.ok(verdict.text.includes(found), `${status} 的出路里没有那条隔离命令：${verdict.text}`)
    seen.push(found)
  }
  assert.equal(new Set(seen).size, 1, '四支出路不是同一条命令：出路的真源只有一份')
})

/** 空格/引号/`$( )` 三类载荷：命令位上的值必须是**一个**词。 */
test('载荷目录名被拆成一个 shell 词（裸插值会在这里红）', () => {
  const hostile = "/Volumes/a b/repo's `touch /tmp/gp-pwned`$(touch /tmp/gp-pwned2)"
  const cmd = isolatedVerifyCommand({ repoDir: hostile, ref: 'v1.29.1' })
  assert.ok(cmd.includes(`git -C ${quoteShellArg(hostile)} `), 'git -C 的参数位必须是 quoteShellArg 的产物：' + cmd)
  assert.ok(cmd.includes(`verify-tag v1.29.1`), '惰性 ref 原样（这一枚没有 shell 能动的字符）')
  assert.doesNotMatch(cmd, /git -C "/, '双引号包不住 $( ) 与反引号')
  // installerPath 也要走同一张表：它来自 `--repo`/GLASSPANE_REPO 那一侧的绝对路径，而这里
  // 它是**先被编码成 file:// URL、再整段塞进 node -e 的那个词**里的。文本这一层能说的是
  // "那一枚操作数是单引号包好的一段"，真正证明"它是一个词、且还原成原路径"的是下面那条替身跑。
  const installer = isolatedVerifyCommand({
    repoDir: '/r', ref: 'v1', installerPath: "/tmp/my dir/ins'taller/cli.js",
  })
  assert.ok(installer.includes('file:///tmp/my%20dir/ins'), '路径里的空格要按 URL 编码，不留下第二个词：' + installer)
  assert.match(installer, /-e 'const m = await import\(/, 'node 的那段程序必须整段单引号包好：' + installer)
  assert.doesNotMatch(installer, /-e "/, '双引号里的 $( ) 与反引号还是会展开')
})

/** 真跑：这条命令对着**真仓库 + 真签名 tag** 回 0，并把钉死的那枚指纹打在 stderr 上。
 *  gpg / git / node 任一发缺、或这棵树里没有那个 tag ⇒ skip（与 cli.test.mjs 的
 *  `commandAvailable('gpg')` 同一口径）。 */
test('真跑：那条出路对 v1.29.1 回 0（这是它取代 git tag -v 的全部理由）', {
  skip: REAL_RUN_OK ? false : '需要 gpg + git + node，且这棵树里有 ' + RELEASE_REF,
}, () => {
  const cmd = isolatedVerifyCommand({ repoDir: REPO, ref: RELEASE_REF })
  const run = spawnSync('/bin/bash', ['-c', cmd], { encoding: 'utf8' })
  assert.equal(run.status, 0, `出路自己跑不通：\n$ ${cmd}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`)
  assert.match(run.stderr, new RegExp(PINNED_KEY_ID), '那趟要把点名的钥匙打出来：' + run.stderr)
  assert.match(run.stderr, /Good signature/, run.stderr)
})

/* ---------------------------------------------------------------- 替身跑 */

/** PATH 前置一枚桩目录：`git` / `gpg` / `node` 各自把 argv 逐条记进日志（带序号与制表符，
 *  所以"值被拆成几个词"这件事是**读出来的**，不是从字符串里猜的）。 */
function stubBinDir({ gitStatus = 0 } = {}) {
  const dir = tempRoot('remedy-stub')
  const log = path.join(dir, 'argv.log')
  const stub = (name, tail) => {
    // 制表符 + 序号：值里出现空格时"这是一个词还是两个词"是**读出来**的，不是从字符串里猜的。
    // （载荷里不放制表符——那是另一种分裂，本条测的是空格与引号。）
    const body = [
      '#!/bin/sh',
      `printf '%s\\t0\\t\\n' "${name}" >> "${log}"`,
      'i=1',
      `for a in "$@"; do printf '%s\\t%d\\t%s\\n' "${name}" "$i" "$a" >> "${log}"; i=$((i + 1)); done`,
      tail,
      '',
    ].join('\n')
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 })
  }
  stub('gpg', 'exit 0')
  stub('node', 'echo "-----BEGIN PGP PUBLIC KEY BLOCK-----"; exit 0')
  stub('git', `exit ${gitStatus}`)
  return { dir, log }
}

function readArgv(log) {
  const byCmd = new Map()
  if (!fs.existsSync(log)) return byCmd
  for (const line of fs.readFileSync(log, 'utf8').split('\n').filter((l) => l !== '')) {
    const [cmd, index, value] = line.split('\t')
    if (!byCmd.has(cmd)) byCmd.set(cmd, [])
    const args = byCmd.get(cmd)
    if (index === '0') args.length = 0 // 这一行只是"这条命令被调过"的标记
    else args[Number(index) - 1] = value
  }
  return byCmd
}

test('替身跑：带空格的仓库目录作为一个 argv 抵达 git（不是两个词）', () => {
  const spaceRepo = '/Volumes/a b/GlassPane'
  const { dir, log } = stubBinDir({})
  const cmd = isolatedVerifyCommand({ repoDir: spaceRepo, ref: 'v1.29.1', installerPath: CLI })
  const run = spawnSync('/bin/bash', ['-c', cmd], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  })
  try {
    assert.equal(run.status, 0, `桩跑不通这条出路：${run.stderr}\n$ ${cmd}`)
    const gitArgs = readArgv(log).get('git')
    assert.ok(gitArgs && gitArgs.length > 0, 'git 桩一次都没被叫到：' + run.stderr)
    const c = gitArgs.indexOf('-C')
    assert.notEqual(c, -1, 'git 桩没收到 -C：' + JSON.stringify(gitArgs))
    assert.equal(gitArgs[c + 1], spaceRepo, '目录名必须**整段**是一个词，实为：' + JSON.stringify(gitArgs[c + 1]))
    assert.ok(!gitArgs.includes('/Volumes/a'), '它被拆开过：' + JSON.stringify(gitArgs))
    // 校验程序与签名格式由命令自己钉住，而不是由那棵树的 .git/config 决定。
    assert.ok(gitArgs.includes('gpg.program=gpg'), JSON.stringify(gitArgs))
    assert.ok(gitArgs.includes('gpg.format=openpgp'), JSON.stringify(gitArgs))
    const verifyIndex = gitArgs.indexOf('verify-tag')
    assert.ok(c < verifyIndex, '-C 与两枚 -c 都在子命令之前：' + JSON.stringify(gitArgs))
    assert.equal(gitArgs[verifyIndex + 1], 'v1.29.1', JSON.stringify(gitArgs))

    // 同一枚载荷换到 installerPath 那一头：node 的 `-e` 程序必须**是一个** argv，
    // 且解开 URL 编码后正是那个含空格与单引号的路径——证明包引号的那一层没有把值改掉。
    const oddInstaller = "/tmp/my dir/ins'taller/cli.js"
    const { dir: dir2, log: log2 } = stubBinDir({})
    try {
      const run2 = spawnSync('/bin/bash', ['-c', isolatedVerifyCommand({
        repoDir: '/r', ref: 'v1', installerPath: oddInstaller,
      })], { encoding: 'utf8', env: { ...process.env, PATH: `${dir2}:${process.env.PATH}` } })
      assert.equal(run2.status, 0, run2.stderr)
      const nodeArgs = readArgv(log2).get('node')
      assert.ok(nodeArgs && nodeArgs.length > 0, 'node 桩一次都没被叫到：' + run2.stderr)
      const program = nodeArgs[nodeArgs.length - 1]
      assert.ok(!nodeArgs.slice(0, -1).some((a) => a.includes('GLASSPANE_SIGNING_PUBLIC_KEY')),
        '那段程序被拆成了多个 argv：' + JSON.stringify(nodeArgs))
      const href = /await import\("([^"]+)"\)/.exec(program)?.[1]
      assert.ok(href, program)
      assert.equal(href, pathToFileURL(oddInstaller).href,
        '空格按 URL 编码留在这段程序里，单引号由 shell 那一层原样还原')
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('钥匙环在失败那一支也被删掉（与 verifyCloneTagGpg 的 finally 同一个义务）', () => {
  const tmp = tempRoot('remedy-tmpdir')
  const { dir, log } = stubBinDir({ gitStatus: 3 })
  const cmd = isolatedVerifyCommand({ repoDir: '/Volumes/Eng-Dev/GlassPane', ref: 'v1.29.1', installerPath: CLI })
  const run = spawnSync('/bin/bash', ['-c', cmd], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: `${tmp}/` },
  })
  try {
    assert.equal(run.status, 3, 'git 桩的退出码必须原样透出来，否则这条链在骗读者：' + run.status)
    assert.ok(readArgv(log).get('git'), '失败之前确实叫过 git（不然"删了"没有意义）')
    assert.deepEqual(fs.readdirSync(tmp), [], `一次性钥匙环留在了盘上：${fs.readdirSync(tmp).join(', ')}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('纯函数：同样的输入给同样的串（出路只有一份真源）', () => {
  const a = isolatedVerifyCommand({ repoDir: '/r', ref: 'v1.1.0', installerPath: CLI })
  const b = isolatedVerifyCommand({ ref: 'v1.1.0', repoDir: '/r', installerPath: CLI })
  assert.equal(a, b)
  assert.ok(a.includes(pathToFileURL(CLI).href), '公钥要从**这个文件**里取，不是从读者的 HOME：' + a)
})
