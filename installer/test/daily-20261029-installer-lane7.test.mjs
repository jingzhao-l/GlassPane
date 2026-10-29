/**
 * 2026-10-29 · 泳道 7（installer/cli.js + installer/glasspane.js + install.sh）
 *
 * 五条发现，每一条都按"先能红、再变绿、再反向变异回坏写法"的顺序写过（specs/GlassPane_每日
 * 2026-10-29_发现台账.md 的 S7-1..S7-5）。夹具一律走 installer/test/install-sh.test.mjs 与
 * daily-20261027-clone-ref-resolution.test.mjs 已经立着的两套形状：
 *  · install.sh 的夹具 = `runShArgs`（/bin/sh 真脚本 + 沙箱 HOME + 记账的 node/uname 桩），
 *    与 daily-20261027 的差别只有一处，且是被断言逼出来的：**HOME 与 bin 目录要在跑完之后还在**，
 *    因为 "--help/--repo 那一趟不长出 ~/glasspane"、"停了就不该委托"两条都要在事后量它。
 *    原来的 runShArgs 在 finally 里就把 home 删了，量不到。
 *  · git 的夹具 = **真 git**（init/commit/tag/clone 全跑真的）。S7-1 的教训就是"桩里跑过的
 *    守卫等于没验"：那三把假 git 对任意目录都答"我是仓库"，而它们唯一的失职就是没被问过
 *    `--show-toplevel`。
 *
 * 反向变异（每条各一次，坏写法先 cp 到 TMPDIR 之外的备份里，不用 git checkout）：
 *  S7-1 `looksLikeRepoHere`/toplevel 守卫 → 本文件前 5 条里对应那几条红（含"外层仍在 main"）；
 *  S7-2 `--repo` 的当场拒 → 'install.sh: --repo ...' 那条红（回到 rc 0 + HOME 长出 clone）；
 *  S7-3 usage 短路 → 两条 --help 用例红（Linux 那一趟回 1，macOS 那一趟 HOME 里长出 glasspane）；
 *  S7-4 引号 → 静态与行为两半都红（打印出来的照抄句又变成两个词）；
 *  S7-5 探测与占位符 → 四条 npm 用例红（`sh -n -c` 对 `@<版本>` 回 2）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as cli from '../cli.js'
import {
  advanceExistingClone,
  bootstrapPlan,
  existingCloneDecision,
  readCloneFacts,
  resolveProjectRoot,
} from '../cli.js'
import * as gp from '../glasspane.js'
import { READS, doctorReadings } from '../glasspane.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTALL_SH = path.resolve(HERE, '..', '..', 'install.sh')
const CLI_JS = path.join(HERE, '..', 'cli.js')
const GLASSPANE_JS = path.join(HERE, '..', 'glasspane.js')
const INSTALL_SH_SRC = fs.readFileSync(INSTALL_SH, 'utf8')
const CLI_SRC = fs.readFileSync(CLI_JS, 'utf8')
const GLASSPANE_SRC = fs.readFileSync(GLASSPANE_JS, 'utf8')

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 一棵"像 GlassPane"的目录树（只够 looks_like_repo / resolveProjectRoot 认出来）。 */
function writeMarkers(dir) {
  fs.mkdirSync(path.join(dir, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'engine', 'Package.swift'), '// swift-tools-version:5.9\n')
  fs.writeFileSync(path.join(dir, 'mcp-shell', 'package.json'), '{}\n')
}

/* ===========================================================================
 * 夹具：一棵**别人的**仓库，里面提交了两个子目录——`vendored`（没有 marker）与
 * `inner`（有 marker、但没有自己的 .git）。钉住的 tag 在 HEAD 的前一笔上，所以
 * "前进那棵树"这件事真的做得动：这就是 S7-1 实测到的形状（外层 main 被 detach）。
 * ========================================================================= */
function makeNestedRepo(label) {
  const work = tmp(`gp-lane7-${label}-`)
  const outer = path.join(work, 'outer')
  const vendored = path.join(outer, 'vendored')
  const inner = path.join(outer, 'inner')
  fs.mkdirSync(outer, { recursive: true })
  writeMarkers(outer)
  const g = (...args) => execFileSync('git', args, { cwd: outer, encoding: 'utf8' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'test@example.test')
  g('config', 'user.name', 'test')
  g('add', '-A')
  g('commit', '-q', '-m', 'one')
  // 第二笔：别人的子目录（没有 marker）。要装的 tag 钉在这一笔上。
  fs.mkdirSync(vendored, { recursive: true })
  fs.writeFileSync(path.join(vendored, 'keep.txt'), '别人的东西\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'two')
  g('tag', 'v9.9.9-new')
  // 第三笔（HEAD）：inner 自己带 marker 而**没有**自己的 .git，所以它躲得过"不是仓库"那一步，
  // 只能由 --show-toplevel 挡下。全部提交 ⇒ `git -C <子目录> status --porcelain` 答"干净"，
  // 而 `git -C <子目录> rev-parse --verify HEAD` 答的是**外层**的那一笔——旧代码正是在这两句上
  // 把别人的树读成了"既有 clone"。
  fs.mkdirSync(inner, { recursive: true })
  writeMarkers(inner)
  g('add', '-A')
  g('commit', '-q', '-m', 'three')
  const commitOf = (rev) => execFileSync('git', ['-C', outer, 'rev-parse', '--verify', rev], { encoding: 'utf8' }).trim()
  return {
    work,
    outer,
    vendored,
    inner,
    branch: () => execFileSync('git', ['-C', outer, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
    head: () => commitOf('HEAD'),
    tagCommit: () => commitOf('v9.9.9-new'),
    statusLines: () => execFileSync('git', ['-C', outer, 'status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((l) => l !== ''),
    cleanup: () => fs.rmSync(work, { recursive: true, force: true }),
  }
}

/** 一棵能过 looks_like_repo 的源仓库 + 一个两个 tag（旧的与要装的），给 install.sh 的 clone 用。 */
function makeSrcRepo(label) {
  const work = tmp(`gp-lane7-${label}-`)
  const src = path.join(work, 'src')
  writeMarkers(src)
  const g = (...args) => execFileSync('git', args, { cwd: src, encoding: 'utf8' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'test@example.test')
  g('config', 'user.name', 'test')
  g('add', '-A')
  g('commit', '-q', '-m', 'release one')
  g('tag', 'v0.0.1-old')
  fs.writeFileSync(path.join(src, 'engine', 'Package.swift'), '// new\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'release two')
  g('tag', 'v9.9.9-new')
  return { work, src, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) }
}

/** 从 src 的旧 tag clone 一棵到 dest（真 git，浅仓）。 */
function cloneOldTag(src, dest) {
  execFileSync('git', ['clone', '--quiet', '--branch', 'v0.0.1-old', '--depth', '1', `file://${src}`, dest], { encoding: 'utf8' })
  return dest
}

/**
 * install.sh 的沙箱：node 桩只记账不真跑 installer，uname 桩决定平台（与 install-sh.test.mjs 的
 * makeStubBin 同形）。home 与 bin **跑完不删**，因为"HOME 里没长出目录"与"没有委托"两条都要事后量。
 */
function makeShFixture({ kernel = 'Darwin' } = {}) {
  const home = tmp('gp-lane7-home-')
  const bin = tmp('gp-lane7-bin-')
  fs.writeFileSync(path.join(bin, 'node'), [
    '#!/bin/sh',
    'if [ "$1" = "-p" ]; then echo 22; exit 0; fi',
    `printf '%s\\n' "$*" >> "${bin}/calls.txt"`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'uname'), `#!/bin/sh\necho ${kernel}\n`, { mode: 0o755 })
  return {
    home,
    bin,
    calls: path.join(bin, 'calls.txt'),
    delegated: () => (fs.existsSync(path.join(bin, 'calls.txt')) ? fs.readFileSync(path.join(bin, 'calls.txt'), 'utf8') : ''),
    cleanup: () => {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(bin, { recursive: true, force: true })
    },
  }
}

/** 与 daily-20261027 的 runShArgs 同一套 env/argv 形状（dryRun 与 PATH 仍可覆盖）。
 *  `cwd: cwd` 与 `HOME: fx.home` 都写成显式形式：daily-20261022-install-isolation.test.mjs 那道
 *  隔离闸是按源码文本找这两位的，简写 `cwd,` 在它眼里等于"没换 cwd"。 */
function runShArgs({ args = [], cwd, fx, env = {}, dryRun = '1' }) {
  return spawnSync('/bin/sh', [INSTALL_SH, ...args], {
    cwd: cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: fx.home,
      GLASSPANE_REPO: '',
      GLASSPANE_INSTALL_DRY_RUN: dryRun,
      PATH: `${fx.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      ...env,
    },
  })
}

const spawnGit = (bin, args) => spawnSync(bin, args, { encoding: 'utf8' })

/* ===========================================================================
 * S7-1（P0）：判断"这一棵是不是仓库"的那一步不许向上走；两个 git 函数先问
 * `--show-toplevel`，答出来的不是所指的那一棵就拒，并且点名要动的是哪一棵。
 * ========================================================================= */

test('S7-1 looksLikeRepoHere 存在且**不向上走**：同一份判据，外层是仓库而这一层不是时答 false', () => {
  assert.equal(typeof cli.looksLikeRepoHere, 'function', '缺少具名导出的 looksLikeRepoHere（S7-1 的修法要求它替代会向上走的那一步）')
  const fx = makeNestedRepo('s7-1-nowalk')
  try {
    // 判据本身：有 marker 的目录答 true，缺一个 marker 的答 false。
    assert.equal(cli.looksLikeRepoHere(fx.inner), true, fx.inner)
    const partial = path.join(fx.work, 'partial')
    fs.mkdirSync(path.join(partial, 'engine'), { recursive: true })
    fs.writeFileSync(path.join(partial, 'engine', 'Package.swift'), '//')
    assert.equal(cli.looksLikeRepoHere(partial), false, '只有 engine/Package.swift 不算一棵仓库')
    assert.equal(cli.looksLikeRepoHere(''), false, '空目录名不许读成"相对当前目录的那一棵"')

    // 与"会向上走"的那一版必须在这里分叉：vendored 自己没有 marker，而它的**外层**有。
    assert.equal(cli.looksLikeRepoHere(fx.vendored), false, '别人的子目录被向上走的判据读成了"这一棵是仓库"')
    assert.equal(resolveProjectRoot(fx.vendored), fx.outer,
      '对照：resolveProjectRoot 会向上走并答出外层那一棵——这正是旧写法放行 clone 的理由')
  } finally {
    fx.cleanup()
  }
})

test('S7-1 bootstrapPlan 判"目标是不是仓库"用的是不上走的判据：别人仓库的子目录 ⇒ 拒', () => {
  const fx = makeNestedRepo('s7-1-plan')
  try {
    const plan = bootstrapPlan({
      homeDir: fx.work,
      installDir: fx.vendored,
      ref: 'v9.9.9-new',
      readCloneState: ({ targetDir, ref }) => readCloneFacts({ targetDir, ref }),
    })
    assert.match(String(plan.error), /已存在且不是 GlassPane 仓库/, `要按 install.sh 同一条输入的形状拒：${JSON.stringify(plan)}`)
    assert.ok(String(plan.error).includes(fx.vendored), '拒绝要点名被拒的那个目录')
    assert.equal(plan.advance, undefined, '不许给出"前进那棵树"的计划')
    assert.equal(plan.use, undefined, '也不许给出"就用它"')
    // 外层一个字都没动。
    assert.equal(fx.branch(), 'main', '外层仍在 main')
    assert.deepEqual(fx.statusLines(), [], '外层工作树仍干净')
  } finally {
    fx.cleanup()
  }
})

test('S7-1 readCloneFacts 先问 --show-toplevel：不是所指的那一棵就不给事实，判据落到拒', () => {
  const fx = makeNestedRepo('s7-1-facts')
  try {
    const facts = readCloneFacts({ targetDir: fx.inner, ref: 'v9.9.9-new', spawn: spawnGit })
    assert.ok(facts.toplevelProblem, `必须带回答不出/答的是别处这件事：${JSON.stringify(facts)}`)
    assert.equal(facts.head, null, '要动的是外层那一棵树时，不许把外层的 HEAD 当成"这棵树的事实"')
    const decision = existingCloneDecision({ targetDir: fx.inner, ref: 'v9.9.9-new', ...facts })
    assert.equal(decision.action, 'refuse', JSON.stringify(decision))
    assert.ok(decision.text.includes(fx.outer), `要点名要动的到底是哪一棵（外层=${fx.outer}）：${decision.text}`)
    assert.match(decision.text, /不是你说|你指的/, '句子要说清"它指的不是这一棵"')
    assert.equal(fx.branch(), 'main', '外层仍在 main')
  } finally {
    fx.cleanup()
  }
})

test('S7-1 advanceExistingClone 对别人仓库的子目录回答拒，且外层的分支仍在 main（真 git，不桩 spawn）', () => {
  const fx = makeNestedRepo('s7-1-advance')
  const before = fx.head()
  try {
    // 前提：这一棵子目录**确实**会被旧写法前进——外层干净、HEAD 在第三笔、要装的 tag 在第二笔。
    assert.deepEqual(fx.statusLines(), [], '前提：外层工作树是干净的（旧写法据此判"可以切"）')
    assert.equal(fx.branch(), 'main', '前提：外层在 main 上')
    assert.notEqual(before, fx.tagCommit(), '前提：要装的 tag 不在 HEAD 上，旧写法会真的切走外层')
    assert.equal(cli.looksLikeRepoHere?.(fx.inner), true, '前提：inner 自己有 marker，所以它躲得过"不是仓库"那一步，只能由 --show-toplevel 挡下')

    const out = advanceExistingClone({ repoDir: fx.inner, ref: 'v9.9.9-new', spawn: spawnGit })
    assert.equal(out.action, 'refuse', `要动外层那棵树时必须拒：${JSON.stringify(out)}`)
    assert.ok(String(out.text).includes(fx.outer), `拒绝要点名要动的是哪一棵：${out.text}`)
    // 这条是整场事故的原判据：外层 main 曾被 detach 并搬到旧 tag。
    assert.equal(fx.branch(), 'main', '外层 rev-parse --abbrev-ref HEAD 必须仍是 main')
    assert.equal(fx.head(), before, '外层的 HEAD 一个字都没动')
    assert.deepEqual(fx.statusLines(), [], '外层工作树仍干净')

    // bootstrapPlan 那一头给出的结论必须一致（同一条事实、两处不许各说各话）。
    const plan = bootstrapPlan({
      homeDir: fx.work,
      installDir: fx.inner,
      ref: 'v9.9.9-new',
      readCloneState: ({ targetDir, ref }) => readCloneFacts({ targetDir, ref }),
    })
    assert.equal(plan.advance, undefined, `计划不许给出"前进"：${JSON.stringify(plan)}`)
    assert.ok(plan.refuse || plan.error, `要么拒要么错，都得点名外层：${JSON.stringify(plan)}`)
    assert.equal(fx.branch(), 'main', '复判：外层仍在 main')
  } finally {
    fx.cleanup()
  }
})

test('S7-1 git 答不出仓库根（谁都不是仓库）⇒ 不回"干净"，且句子仍是"不是 git 仓库"那一族', () => {
  const work = tmp('gp-lane7-s7-1-nogit-')
  const target = path.join(work, 'glasspane')
  writeMarkers(target)
  const facts = readCloneFacts({ targetDir: target, ref: 'v9.9.9-new', spawn: spawnGit })
  assert.ok(facts.toplevelProblem, JSON.stringify(facts))
  assert.equal(facts.head, null, '答不出要动哪一棵时，"读不出"不许变成"干净"')
  const decision = existingCloneDecision({ targetDir: target, ref: 'v9.9.9-new', ...facts })
  assert.equal(decision.action, 'refuse', JSON.stringify(decision))
  assert.match(decision.text, /不是 git 仓库|答不出/, '要说的是"这一问没有答案"')
  assert.match(decision.text, /GLASSPANE_INSTALL_DIR=/, '拒了也要给做得动的下一步')
  fs.rmSync(work, { recursive: true, force: true })
})

test('S7-1 "判据同源"这句要指向真存在的东西：install.sh 的 looks_like_repo 测的就是 cli.js 那份 marker 表', () => {
  assert.ok(Array.isArray(cli.REPO_MARKERS), 'cli.js 必须导出 marker 表，否则"同源"只是两句注释互相指认')
  const body = /looks_like_repo\(\)\s*\{([\s\S]*?)\n\}/.exec(INSTALL_SH_SRC)
  assert.ok(body, 'install.sh 里那个 looks_like_repo 函数的形状变了——同步改这道闸，别让它空转')
  const tested = [...body[1].matchAll(/\[\s*-f\s*"\$1\/([^"]+)"\s*\]/g)].map((m) => m[1])
  assert.deepEqual(tested, [...cli.REPO_MARKERS], '两条一键入口测的是同一组 marker 吗？少一个或多一个都是红')
  // 而且这份 marker 表在 cli.js 里真的被用上走的判据与**不**上走的判据共用同一处（否则
  // "同源"仍然是两份抄本）。
  assert.match(CLI_SRC, /looksLikeRepoHere\(dir\)|looksLikeRepoHere\(candidate\)/, 'resolveProjectRoot 与 looksLikeRepoHere 必须共用那份 marker 表')
})

test('S7-1 install.sh 的 advance_existing_clone 也先问 --show-toplevel：别人的子目录不动它', () => {
  const repo = makeNestedRepo('s7-1-sh')
  const sh = makeShFixture()
  const before = repo.head()
  try {
    const result = runShArgs({
      args: [],
      cwd: repo.work,
      fx: sh,
      dryRun: '0',
      env: { GLASSPANE_INSTALL_DIR: repo.inner, GLASSPANE_REF: 'v9.9.9-new' },
    })
    assert.equal(result.status, 1, `要动的是外层那棵树时必须停下：\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /--show-toplevel|不是你说|你指的/, `要说清要动的是哪一棵：\n${result.stdout}\n${result.stderr}`)
    // 打印出来的是 git 答的那个**物理路径**（/var → /private/var 这一类软链会被解开），
    // 与夹具手里的字符串差一层软链是事实，不是缺陷——所以按 realpath 比。
    assert.ok(result.stdout.includes(fs.realpathSync(repo.outer)), `要点名外层：${result.stdout}`)
    assert.equal(repo.branch(), 'main', '外层 rev-parse --abbrev-ref HEAD 必须仍是 main')
    assert.equal(repo.head(), before, '外层的 HEAD 一个字都没动')
    assert.equal(sh.delegated(), '', '停了就不该再委托')
  } finally {
    sh.cleanup()
    repo.cleanup()
  }
})

/* ===========================================================================
 * S7-2：被 looks_like_repo 拒掉的 `--repo` 不许原样透传给 cli.js。
 * ========================================================================= */

test('S7-2 install.sh: --repo 给了而不合判据 ⇒ 当场拒（rc 1，不 clone、不透传），dry-run 与真跑同句', () => {
  const src = makeSrcRepo('s7-2-repo')
  const bad = tmp('gp-lane7-s7-2-bad-')
  const elsewhere = tmp('gp-lane7-s7-2-cwd-')
  for (const dryRun of ['1', '0']) {
    const sh = makeShFixture()
    try {
      const result = runShArgs({
        args: ['--repo', bad],
        cwd: elsewhere,
        fx: sh,
        dryRun,
        env: { GLASSPANE_REPO_URL: `file://${src.src}`, GLASSPANE_REF: 'v9.9.9-new' },
      })
      const text = `${result.stdout}\n${result.stderr}`
      assert.equal(result.status, 1, `dry-run=${dryRun}：被拒的 --repo 必须当场停下，实得 ${result.status}：${text}`)
      assert.match(result.stdout, /--repo/, '要说清是哪一枚旗标被拒')
      assert.match(result.stdout, /engine\/Package\.swift/, '要给出判据本身，而不是"不像仓库"这种没有尺子的说法')
      assert.match(result.stdout, /没有 clone|不 clone/, '要说这一趟没付 clone')
      assert.doesNotMatch(text, /将执行: node |exec node/, '被拒的旗标不许出现在委托行里')
      assert.doesNotMatch(text, /--branch v9\.9\.9-new .*clone|git clone --branch v9\.9\.9-new/, '也不许进到 clone 计划里')
      assert.equal(fs.existsSync(path.join(sh.home, 'glasspane')), false, `真 clone 出来的那一棵不该存在（dry-run=${dryRun}）`)
      assert.equal(sh.delegated(), '', `停了就不该委托 installer：${sh.delegated()}`)
    } finally {
      sh.cleanup()
    }
  }
  // 对照：同一套夹具把 --repo 换成一棵真的树 ⇒ 必须走得通，否则上面那把尺子只是"永远拒"。
  const good = makeSrcRepo('s7-2-good')
  const shCtl = makeShFixture()
  try {
    const ctl = runShArgs({ args: ['--repo', good.src], cwd: elsewhere, fx: shCtl, env: { GLASSPANE_REPO: '' } })
    assert.equal(ctl.status, 0, `${ctl.stdout}\n${ctl.stderr}`)
    assert.match(ctl.stdout, /使用 --repo 指定的仓库/, ctl.stdout)
  } finally {
    shCtl.cleanup()
    good.cleanup()
    fs.rmSync(bad, { recursive: true, force: true })
    fs.rmSync(elsewhere, { recursive: true, force: true })
    src.cleanup()
  }
})

/* ===========================================================================
 * S7-3：install.sh 从来没有 --help/-h。非 macOS 回 1 而 cli.js 的 --help 回 0，
 * macOS 上则先付一次浅 clone 才打印。
 * ========================================================================= */

function runCliHelp(args, home) {
  return spawnSync(process.execPath, [CLI_JS, ...args], {
    cwd: tmp('gp-lane7-cli-cwd-'),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, GLASSPANE_REPO: '' },
    timeout: 120_000,
  })
}

for (const flag of ['--help', '-h']) {
  test(`S7-3 install.sh ${flag}: 退出码与 node installer/cli.js ${flag} 逐值相等，且 HOME 里不长出 glasspane`, () => {
    const sh = makeShFixture()
    const src = makeSrcRepo('s7-3-help')
    const cliHome = tmp('gp-lane7-cli-home-')
    try {
      // 真跑（dry-run=0）：今天这一条会先 clone 一棵 depth 1 才打印，所以夹具给的是本地 file:// 地址，
      // 红的不是网络而是"HOME 里长出了一棵 clone"。
      const got = runShArgs({
        args: [flag],
        cwd: tmp('gp-lane7-s7-3-cwd-'),
        fx: sh,
        dryRun: '0',
        env: { GLASSPANE_REPO_URL: `file://${src.src}`, GLASSPANE_REF: 'v9.9.9-new' },
      })
      const ref = runCliHelp([flag], cliHome)
      assert.equal(ref.status, 0, `前提：cli.js 的 ${flag} 回 0（用法页），实得 ${ref.status}｜${ref.stderr}`)
      assert.equal(got.status, ref.status, `两条一键入口对同一个 ${flag} 必须给同一个退出码：install.sh=${got.status}\n${got.stdout}\n${got.stderr}`)
      assert.match(got.stdout, /用法/, `要打出 usage：${got.stdout}`)
      assert.doesNotMatch(got.stdout, /将执行: node |exec node/, 'usage 那一趟不许委托')
      assert.doesNotMatch(`${got.stdout}${got.stderr}`, /目标目录已存在|只支持 macOS/, '不许走到 clone 分支的结论上去')
      assert.equal(fs.existsSync(path.join(sh.home, 'glasspane')), false, `${flag} 那一趟不许在家目录里 clone 出一棵树`)
      assert.equal(fs.existsSync(path.join(cliHome, 'glasspane')), false, 'cli.js 那一侧同样不该长出来（对照）')
      assert.equal(sh.delegated(), '', `${flag} 之后一个 node 都不该起`)

      // 反证这把尺子不是空的：同一条命令不带 ${flag} 时，这一趟**就是**要 clone 的。
      const ctlSh = makeShFixture()
      try {
        const without = runShArgs({
          args: [],
          cwd: tmp('gp-lane7-s7-3-cwd2-'),
          fx: ctlSh,
          dryRun: '1',
          env: { GLASSPANE_REPO_URL: `file://${src.src}`, GLASSPANE_REF: 'v9.9.9-new' },
        })
        assert.match(without.stdout, /将执行: git clone --branch v9\.9\.9-new/, `对照跑要能走到 clone 计划：${without.stdout}`)
      } finally {
        ctlSh.cleanup()
      }
    } finally {
      sh.cleanup()
      src.cleanup()
      fs.rmSync(cliHome, { recursive: true, force: true })
    }
  })
}

test('S7-3 install.sh --help 在非 macOS 上同样豁免：--help 回 0，不带它回 1（与 cli.js:3453 同一句话）', () => {
  const sh = makeShFixture({ kernel: 'Linux' })
  const cliHome = tmp('gp-lane7-cli-home2-')
  try {
    const got = runShArgs({ args: ['--help'], cwd: tmp('gp-lane7-s7-3-linux-'), fx: sh, dryRun: '0' })
    assert.equal(got.status, 0, `非 macOS 上 --help 必须回 0（CI 的 install-gate 读的就是 usage），实得 ${got.status}：\n${got.stdout}\n${got.stderr}`)
    assert.match(got.stdout, /用法/, got.stdout)
    assert.doesNotMatch(`${got.stdout}${got.stderr}`, /只支持 macOS/, 'usage 这一条不该被平台闸挡在前面')

    const ref = runCliHelp(['--help'], cliHome)
    assert.equal(got.status, ref.status, `--help 的退出码在两条入口上逐值相等（实为 install.sh=${got.status} / cli.js=${ref.status}）`)

    // 对照：同一把 Linux 桩、同一个沙箱，不带 --help 时这一趟仍然要被平台闸拒掉。
    const ctl = runShArgs({ args: [], cwd: tmp('gp-lane7-s7-3-linux2-'), fx: sh, dryRun: '0' })
    assert.equal(ctl.status, 1, `平台闸不许因为加了 --help 就被顺手删掉：\n${ctl.stdout}\n${ctl.stderr}`)
    assert.match(ctl.stderr, /只支持 macOS/, ctl.stderr)
  } finally {
    sh.cleanup()
    fs.rmSync(cliHome, { recursive: true, force: true })
  }
})

/* ===========================================================================
 * S7-4：打印给读者照抄的那两句 git 命令里，路径展开没加引号（:211 已经是带引号的）。
 * ========================================================================= */

test('S7-4 install.sh 静态闸：照抄句里不许出现裸的 git -C ${…}', () => {
  const bare = INSTALL_SH_SRC.split('\n').filter((line) => /git -C \$\{/.test(line))
  assert.deepEqual(bare.map((l) => l.trim()), [], `打印出来的下一步里 ${JSON.stringify(bare.map((l) => l.trim()))} 会把带空格的路径断成两个词`)
  assert.deepEqual(
    INSTALL_SH_SRC.split('\n').filter((line) => /git ls-remote \$\{/.test(line)).map((l) => l.trim()),
    [],
    '同一族：远端名与 ref 也是照抄进 shell 的参数')
  // 正面：那两句必须真以带引号的形式存在（只删裸形、不给带引号的形式，句子会整个消失）。
  // 带引号在 shell 源码里是 `\"${_dir}\"`（say 的那一整行本身在双引号里），两种写法都算带引号。
  assert.match(INSTALL_SH_SRC, /git -C \\?"\$\{_dir\}\\?" fetch --tags/, 'fetch 那一句的带引号形式')
  assert.match(INSTALL_SH_SRC, /git ls-remote \\?"\$\{_remote\}\\?" \\?"\$\{_ref\}\\?"/, 'ls-remote 那一句的带引号形式')
})

test('S7-4 install.sh 行为半：clone 目录带空格时，打印的两句照抄进去仍是一个词', () => {
  const src = makeSrcRepo('s7-4-space')
  const work = tmp('gp-lane7-s7-4-')
  const spaced = path.join(work, 'John Smith', 'glasspane')
  fs.mkdirSync(path.dirname(spaced), { recursive: true })
  cloneOldTag(src.src, spaced)
  const sh = makeShFixture()
  try {
    // nosuchtag 在远端不存在 ⇒ fetch 非零，两句都在屏幕上：247 的"先 fetch 它"与 249 的 ls-remote。
    const result = runShArgs({
      args: [],
      cwd: work,
      fx: sh,
      dryRun: '0',
      env: { GLASSPANE_INSTALL_DIR: spaced, GLASSPANE_REF: 'nosuchtag', GLASSPANE_REPO_URL: `file://${src.src}` },
    })
    const text = `${result.stdout}\n${result.stderr}`
    assert.match(text, /没有 nosuchtag 这个引用|fetch/, `前提：这一趟要走到 fetch 那一支：${text}`)
    assert.ok(text.includes(`git -C "${spaced}" fetch --tags`), `打印的 fetch 句必须把路径包在引号里：${text}`)
    assert.ok(text.includes('git ls-remote "origin" "nosuchtag"'), `打印的 ls-remote 句同理：${text}`)
    // 未加引号的那一形就是本条要红的地方（也是 S7-4 的反向变异会回来的地方）。
    assert.doesNotMatch(text, new RegExp(`git -C ${spaced.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} fetch`), '裸形又回来了')
  } finally {
    sh.cleanup()
    src.cleanup()
    fs.rmSync(work, { recursive: true, force: true })
  }
})

/* ===========================================================================
 * S7-5：glasspane doctor 的 npm 补法——"不需要权限"要有探测支撑，占位符不许是 shell 元字符。
 * ========================================================================= */

function doctorFixture({ prefixAnswer, npmDeps = { 'glasspane-mcp': { version: '1.20.0' } } }) {
  const root = tmp('gp-lane7-doctor-')
  const updaterCli = path.join(root, 'tree', 'updater', 'cli.js')
  fs.mkdirSync(path.dirname(updaterCli), { recursive: true })
  fs.writeFileSync(updaterCli, '//')
  fs.writeFileSync(path.join(root, 'update-install.json'), JSON.stringify({ updaterCli, installRoot: path.join(root, 'tree') }))
  fs.writeFileSync(path.join(root, 'engine.sock'), '')
  const calls = []
  const table = [
    [/updater\/cli\.js status/, { status: 0, stdout: JSON.stringify({ status: 'applied', code: null, message: 'ok', state: { current: '1.20.0', latest: '1.21.0' } }), stderr: '' }],
    [/launchctl print/, { status: 0, stdout: 'gui/501/com.glasspane.daemon = {\n\tstate = running\n}', stderr: '' }],
    [/^npm ls -g/, { status: 0, stdout: JSON.stringify({ name: 'lib', dependencies: npmDeps }, null, 2), stderr: '' }],
  ]
  if (prefixAnswer) table.push([/npm prefix -g/, prefixAnswer])
  const fn = (bin, args) => {
    const join = [bin, ...(args ?? [])].join(' ')
    calls.push(join)
    for (const [re, answer] of table) {
      if (re.test(join)) return typeof answer === 'function' ? answer(join) : answer
    }
    return { status: null, stdout: '', stderr: '', error: new Error(`没有这条的答案：${join}`) }
  }
  return {
    root,
    calls,
    readings: () => doctorReadings({ env: { GLASSPANE_STATE_DIR: root }, spawn: fn, uid: '501' }),
    npmRow: () => doctorReadings({ env: { GLASSPANE_STATE_DIR: root }, spawn: fn, uid: '501' }).find((one) => one.name === '全局 npm 包'),
    cleanup: () => {
      fs.chmodSync(root, 0o700)
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

test('S7-5 doctor 真的去探测全局前缀：npm prefix -g 被问过一次，且补法里有读到的那个前缀', () => {
  const prefix = tmp('gp-lane7-prefix-writable-')
  fs.mkdirSync(path.join(prefix, 'lib', 'node_modules'), { recursive: true })
  const fx = doctorFixture({ prefixAnswer: { status: 0, stdout: `${prefix}\n`, stderr: '' } })
  try {
    const row = fx.npmRow()
    assert.equal(row.read, READS.absent, '前提：缺包那一格仍然是缺席')
    assert.ok(fx.calls.some((line) => /npm prefix -g/.test(line)), `全局 npm 那一格必须真的探测过前缀：${JSON.stringify(fx.calls)}`)
    assert.match(row.remedy, /不需要权限/, '可写时那句"不需要权限"才有支撑')
    assert.ok(row.remedy.includes(prefix), `补法要交出读到的那个前缀：${row.remedy}`)
    assert.doesNotMatch(row.remedy, /</, `补法里不许出现 shell 重定向符（占位符 <版本> 就是它）：${row.remedy}`)
    assert.doesNotMatch(row.remedy, /\bsudo\b/, '补法不许交出可照抄的升权命令')
    assert.equal(typeof gp.NPM_GLOBAL_INSTALL_CMD, 'string', '命令本身要具名导出，测试才能力求"印出来的就是能跑的"')
    assert.ok(row.remedy.includes(gp.NPM_GLOBAL_INSTALL_CMD), `补法里的那一行必须就是导出的那一条命令：${row.remedy}`)
  } finally {
    fx.cleanup()
    fs.rmSync(prefix, { recursive: true, force: true })
  }
})

test('S7-5 前缀不可写时：点名前缀与探测的目录，且不发升权命令', (t) => {
  // root 之下 accessSync(W_OK) 对 0o500 也答"可写"，这一档在那台机器上根本造不出来——
  // 如实跳过并声明，而不是把断言改松。补它的那一条命令：以非 root 账号跑
  // `cd installer && node --test test/daily-20261029-installer-lane7.test.mjs`。
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return t.skip('这一格以 root 跑：W_OK 对任何目录都真，不可写那一档在这台机器上测不出')
  }
  const prefix = tmp('gp-lane7-prefix-rot-')
  const target = path.join(prefix, 'lib', 'node_modules')
  fs.mkdirSync(target, { recursive: true })
  fs.chmodSync(target, 0o500) // 可执行可读、不可写：真 accessSync(W_OK) 在这一格答 false
  const fx = doctorFixture({ prefixAnswer: { status: 0, stdout: `${prefix}\n`, stderr: '' } })
  try {
    const row = fx.npmRow()
    assert.match(row.remedy, /不可写/, `前缀不可写时不许再印"不需要权限"那一条：${row.remedy}`)
    assert.doesNotMatch(row.remedy, /不需要权限/, row.remedy)
    assert.ok(row.remedy.includes(prefix) && row.remedy.includes(target), `要点名前缀与被探测的目录：${row.remedy}`)
    assert.doesNotMatch(row.remedy, /\bsudo\b/, '不可写那一档只给"把前缀挪到自己名下"，不给可照抄的升权命令')
    assert.doesNotMatch(row.remedy, /</, row.remedy)
  } finally {
    fx.cleanup()
    fs.chmodSync(target, 0o700)
    fs.rmSync(prefix, { recursive: true, force: true })
  }
})

test('S7-5 前缀读不出时答"未验证"，不许把没探测过的东西写成不需要权限', () => {
  for (const answer of [
    { status: null, stdout: '', stderr: '', error: new Error("spawnSync npm ENOENT: can't open '<x>'") },
    { status: 0, stdout: '\n', stderr: '' },
    null,
  ]) {
    const fx = doctorFixture({ prefixAnswer: answer })
    try {
      const row = fx.npmRow()
      assert.doesNotMatch(row.remedy, /不需要权限/, `读不出前缀时不许背书"不需要权限"：${row.remedy}`)
      assert.match(row.remedy, /未验证|读不出|答不出/, `要说的是"这一问没有答案"：${row.remedy}`)
      assert.doesNotMatch(row.remedy, /</, `npm 的原话里有元字符也要裁掉，否则照抄就是语法错：${row.remedy}`)
      assert.equal(spawnSync('/bin/sh', ['-n', '-c', row.remedy], { encoding: 'utf8' }).status, 0,
        `补法这一整行要能被 /bin/sh 解析：${row.remedy}`)
    } finally {
      fx.cleanup()
    }
  }
})

test('S7-5 补法那一行能被 /bin/sh -c 跑起来：桩 npm 收到的 argv 就是导出的那条命令（旧占位符是语法错）', () => {
  const cmd = gp.NPM_GLOBAL_INSTALL_CMD
  assert.equal(typeof cmd, 'string', '缺少具名导出的 NPM_GLOBAL_INSTALL_CMD')
  assert.match(cmd, /^npm install -g glasspane-mcp glasspane-install$/, `命令本身：${cmd}`)
  const bin = tmp('gp-lane7-npmparse-')
  const log = path.join(bin, 'npm-argv.txt')
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 })
  try {
    const parsed = spawnSync('/bin/sh', ['-n', '-c', cmd], { encoding: 'utf8' })
    assert.equal(parsed.status, 0, `sh -n 解析不过：${parsed.stderr}`)
    const run = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` } })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    assert.equal(fs.readFileSync(log, 'utf8').trim(), 'install -g glasspane-mcp glasspane-install', '桩 npm 收到的 argv 才是这一行的事实')
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /sudo/, '不能起升权命令')

    // 反证这把尺子会咬：台账实量的那一枚占位符（`@<版本>`）在 /bin/sh 里就是语法错。
    const old = 'npm install -g glasspane-mcp@<版本> glasspane-install@<版本>'
    assert.equal(spawnSync('/bin/sh', ['-n', '-c', old], { encoding: 'utf8' }).status, 2, `旧写法的占位符必须是语法错那一档，否则这条断言是空的：${old}`)
    assert.equal(spawnSync('/bin/sh', ['-c', old], { encoding: 'utf8' }).status, 2, '旧写法连命令都起不来')

    // 三条补法形状都要能被解析（可写/不可写/读不出）——上一行是 S7-5 的"照抄连命令都起不来"。
    const prefix = tmp('gp-lane7-prefix-parse-')
    fs.mkdirSync(path.join(prefix, 'lib', 'node_modules'), { recursive: true })
    for (const answer of [{ status: 0, stdout: `${prefix}\n`, stderr: '' }, { status: 1, stdout: '', stderr: 'npm ERR!' }, null]) {
      const fx = doctorFixture({ prefixAnswer: answer })
      try {
        assert.equal(spawnSync('/bin/sh', ['-n', '-c', fx.npmRow().remedy], { encoding: 'utf8' }).status, 0, fx.npmRow().remedy)
      } finally {
        fx.cleanup()
      }
    }
    fs.rmSync(prefix, { recursive: true, force: true })
  } finally {
    fs.chmodSync(bin, 0o700)
    fs.rmSync(bin, { recursive: true, force: true })
  }
})

test('S7-5 glasspane.js 里那枚占位符已经不在屏幕上（静态半：印出来的补法不含 <版本>）', () => {
  assert.doesNotMatch(GLASSPANE_SRC, /@<版本>/, 'glasspane.js 里还留着 shell 重定向符那一枚占位符')
  assert.match(GLASSPANE_SRC, /npm', \['prefix', '-g'\]|"prefix", "-g"/, '探测必须真的问一次 npm prefix -g，不是另一句注释')
})
