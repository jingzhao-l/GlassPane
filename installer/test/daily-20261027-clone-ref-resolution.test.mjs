/**
 * 2026-10-27 —— 既有 clone 的 ref 解析：`GLASSPANE_REF=main` 与远端名。
 *
 * 两条一键入口（`sh install.sh` 与 `npx glasspane-install`）对同一棵树该给同一个答案，而本轮实测
 * 到的形状是**两边都走不通**：
 *
 *  · 按 tag 建的 clone 里没有 `refs/heads/*`（`git clone --branch v1.23.0 --depth 1` 只配了那一个
 *    tag 的 refspec；本机实测 `git for-each-ref` 只回 `refs/tags/v1.0.0`）。于是
 *    `GLASSPANE_REF=main` 时 `rev-parse --verify main^{commit}` 读不出，走到 fetch 那一支；
 *    `git fetch --tags --depth 1 origin main` **退 0**（`* branch main -> FETCH_HEAD`）却不落下
 *    任何名为 main 的 ref，旧代码复问同一句还是 `fatal: Needed a single revision` ⇒ 拒；
 *    而 `installer/cli.js` 那一支切的是名字：`git checkout --detach main` 被 git 以
 *    `fatal: git checkout: --detach does not take a path argument 'main'` 拒绝。
 *    ⇒ 头里第 64 行与 `repoMissingText` 的 d) 那条**写明的用法**是永久死路，且拒绝句把责任
 *    推给"网络与该 tag 存在"，而网络那一趟答了 0。
 *
 *  · 远端名 `origin` 写死在 fetch 与诊断两处：`git clone --origin up` 建的树走到同一条拒绝，
 *    而那句让读者去跑 `git ls-remote --tags origin <ref>` —— 同一条用错名字的命令。
 *
 * 夹具用**真 git**（同一族教训：桩里跑过的守卫等于没验）。`makeTaggedRepo` 那类假 git 只认
 * 它自己被问的那一个 tag 形状，正因如此上面这两条从没被任何用例摸到过。
 *
 * REVERSE MUTATION（本机实测，逐条具名变红）：
 *  · 把 `install.sh` 的 FETCH_HEAD 回落删掉 ⇒ 第 1、2 条红在 `该目录已经在/已前进到`；
 *  · 把 `checkout --detach "$_tag"` 换回 `--detach "$_ref"` ⇒ 第 1 条红在 detach 那句 fatal；
 *  · 把远端解析换回写死 `origin` ⇒ 第 2 条红在 fetch argv，第 3 条红在"该从哪个远端取"那句；
 *  · 把 `advanceExistingClone` 的 sha 形切回名字形 ⇒ 第 4 条红；
 *  · 把建议目录换回 `~/glasspane-<ref>` ⇒ 第 6 条红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { advanceExistingClone, existingCloneDecision, readCloneFacts, resolveRemoteName } from '../cli.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTALL_SH = path.resolve(HERE, '..', '..', 'install.sh')

/**
 * 一棵真仓库：`main` 分支比旧 tag 多一笔，`v9.9.9-new` 钉在那一笔上。
 * clone 一律**从旧 tag 建**，所以本地既没有新 tag 也没有 `refs/heads/main` —— 这正是
 * "按 tag 一键装过的人想追主干"的真实形状。`remoteName`/`extraRemote` 用来造远端形状。
 */
function makeBranchClone(label, { shallow = true, remoteName = 'origin', extraRemote = null } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `gp-${label}-`))
  const src = path.join(work, 'src')
  fs.mkdirSync(path.join(src, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(src, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(src, 'engine', 'Package.swift'), '// old\n')
  fs.writeFileSync(path.join(src, 'mcp-shell', 'package.json'), '{}\n')
  const g = (...args) => execFileSync('git', args, { cwd: src, encoding: 'utf8' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'test@example.test')
  g('config', 'user.name', 'test')
  g('add', '-A')
  g('commit', '-q', '-m', 'old release')
  g('tag', 'v0.0.1-old')
  const oldTip = g('rev-parse', '--verify', 'HEAD').trim()
  fs.writeFileSync(path.join(src, 'engine', 'Package.swift'), '// new\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'new release')
  g('tag', 'v9.9.9-new')
  const mainTip = g('rev-parse', '--verify', 'main^{commit}').trim()

  const cloneDir = path.join(work, 'clone')
  const cloneArgs = ['clone', '--quiet', '--branch', 'v0.0.1-old']
  if (shallow) cloneArgs.push('--depth', '1')
  else cloneArgs.push('--single-branch')
  if (remoteName !== 'origin') cloneArgs.push('--origin', remoteName)
  cloneArgs.push(`file://${src}`, cloneDir)
  execFileSync('git', cloneArgs, { encoding: 'utf8' })
  if (extraRemote) execFileSync('git', ['-C', cloneDir, 'remote', 'add', extraRemote, `file://${src}`], { encoding: 'utf8' })
  const git = (...args) => execFileSync('git', ['-C', cloneDir, ...args], { encoding: 'utf8' })
  return {
    work,
    src,
    cloneDir,
    oldTip,
    mainTip,
    refs: () => execFileSync('git', ['-C', cloneDir, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' })
      .split('\n').filter((line) => line !== ''),
    head: () => git('rev-parse', '--verify', 'HEAD').trim(),
    isShallow: () => git('rev-parse', '--is-shallow-repository').trim(),
    statusLines: () => git('status', '--porcelain').split('\n').filter((line) => line !== ''),
    cleanup: () => fs.rmSync(work, { recursive: true, force: true }),
  }
}

/** 一把只记录不真干活的 node/uname，加一只把 argv 记进账本再交给真 git 的 spy。 */
function makeStubBin(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'uname'), '#!/bin/sh\n[ "$1" = "-s" ] && echo Darwin || echo stub\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'node'), [
    '#!/bin/sh',
    'if [ "$1" = "-p" ]; then echo 22; exit 0; fi',
    `printf '%s\\n' "$*" >> "${dir}/calls.txt"`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  const log = path.join(dir, 'git-argv.txt')
  fs.writeFileSync(path.join(dir, 'git'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${log}"`,
    'exec /usr/bin/git "$@"',
    '',
  ].join('\n'), { mode: 0o755 })
  return {
    dir,
    calls: path.join(dir, 'calls.txt'),
    readGit: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l !== '') : []),
  }
}

function runSh({ repo, ref, env = {}, work }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-shref-home-'))
  try {
    return spawnSync('/bin/sh', [INSTALL_SH], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        GLASSPANE_REPO: '',
        GLASSPANE_INSTALL_DIR: repo.cloneDir,
        GLASSPANE_REPO_URL: `file://${repo.src}`,
        GLASSPANE_REF: ref,
        GLASSPANE_INSTALL_DRY_RUN: '0',
        PATH: `${env.__bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        ...Object.fromEntries(Object.entries(env).filter(([k]) => k !== '__bin')),
      },
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

/* --------------------------------------------------------------- install.sh（真 git） */

test('install.sh: GLASSPANE_REF=main 前进一棵按 tag 建的 clone——文档写明的那条用法不许是死路', () => {
  const repo = makeBranchClone('sh-main')
  const bin = makeStubBin(path.join(repo.work, 'bin'))
  try {
    // 夹具前提，必须自己问出来：本地没有 refs/heads/main，否则 fetch 那一支根本不走而用例照样绿。
    assert.deepEqual(repo.refs(), ['refs/tags/v0.0.1-old'], '夹具形状：按 tag 建的浅 clone 里只有那一个 tag')
    assert.equal(repo.head(), repo.oldTip)
    const result = runSh({ repo, ref: 'main', env: { __bin: bin.dir }, work: repo.work })
    assert.equal(result.status, 0, `追主干必须走得通：\n${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(result.stdout, /读不出 main 指向的 commit/, result.stdout)
    assert.match(result.stdout, /已前进到 main/, result.stdout)
    assert.equal(repo.head(), repo.mainTip, '切到的必须正是主干那一笔，不是旧 tag')
    const fetches = bin.readGit().filter((line) => line.includes(' fetch '))
    assert.equal(fetches.length, 1, `只该 fetch 一次，读的是 argv：${JSON.stringify(bin.readGit())}`)
    assert.match(fetches[0], /fetch --tags --depth 1 origin main$/, fetches[0])
    assert.equal(repo.isShallow(), 'true', '这一趟不许改变深浅')
    assert.deepEqual(repo.statusLines(), [], '切完的树必须还是干净的')
  } finally {
    repo.cleanup()
  }
})

test('install.sh: 远端不叫 origin 时用它自己的那一个——写死 origin 会让同一棵树两次失败', () => {
  const repo = makeBranchClone('sh-remote', { remoteName: 'up' })
  const bin = makeStubBin(path.join(repo.work, 'bin'))
  try {
    assert.ok(repo.refs().includes('refs/tags/v0.0.1-old'))
    assert.deepEqual(execFileSync('git', ['-C', repo.cloneDir, 'remote'], { encoding: 'utf8' }).trim(), 'up')
    const result = runSh({ repo, ref: 'main', env: { __bin: bin.dir }, work: repo.work })
    assert.equal(result.status, 0, `远端改名不该把一键安装钉死：\n${result.stdout}\n${result.stderr}`)
    const fetches = bin.readGit().filter((line) => line.includes(' fetch '))
    assert.match(fetches[0], /fetch --tags --depth 1 up main$/, `fetch 必须用读到的那个远端名：${fetches[0]}`)
    assert.equal(repo.head(), repo.mainTip)
  } finally {
    repo.cleanup()
  }
})

test('install.sh: 多个远端而没有 origin 时拒，且说的是"该从哪取"而不是"网络有问题"', () => {
  const repo = makeBranchClone('sh-ambiguous', { remoteName: 'up', extraRemote: 'mirror' })
  const bin = makeStubBin(path.join(repo.work, 'bin'))
  const before = repo.head()
  try {
    const result = runSh({ repo, ref: 'main', env: { __bin: bin.dir }, work: repo.work })
    assert.equal(result.status, 1, `远端答不出就该停下：\n${result.stdout}`)
    assert.match(result.stdout, /该从哪个远端取/, result.stdout)
    assert.doesNotMatch(result.stdout, /网络/, '这一趟网络根本没被试过，不许把责任推给它')
    assert.equal(repo.head(), before, '拒绝的一支必须一个字都没切')
    assert.equal(bin.readGit().filter((line) => / fetch /.test(line)).length, 0, '答不出远端就不许 fetch')
  } finally {
    repo.cleanup()
  }
})

/* --------------------------------------------------------- installer/cli.js（真 git，npx 那一侧） */

const spawnGit = (bin, args) => spawnSync(bin, args, { encoding: 'utf8' })

test('advanceExistingClone: 同一个 main 在 npx 入口上也必须走得通（两条入口同一个答案）', () => {
  const repo = makeBranchClone('cli-main')
  try {
    assert.deepEqual(repo.refs(), ['refs/tags/v0.0.1-old'])
    const out = advanceExistingClone({ repoDir: repo.cloneDir, ref: 'main', spawn: spawnGit })
    assert.equal(out.action, 'use', `${out.text ?? ''}｜${JSON.stringify(out)}`)
    assert.equal(out.advanced, true)
    assert.equal(repo.head(), repo.mainTip, '切的是 FETCH_HEAD 那个 sha，不是 main 这个名字')
    const facts = readCloneFacts({ targetDir: repo.cloneDir, ref: 'main', spawn: spawnGit })
    assert.equal(facts.tagCommit, null, '前提：切完之后 main 在本地仍然不是一个 ref（这就是旧写法切不动的原因）')
    assert.equal(facts.head, repo.mainTip)
  } finally {
    repo.cleanup()
  }
})

test('advanceExistingClone: 远端没有那个引用时交出 git 的原话，且一次都不切', () => {
  // 本机实测的形状：`git fetch --tags --depth 1 origin nosuchbranch` 退 **128**
  // （`fatal: couldn't find remote ref nosuchbranch`），不是"退 0 而落点为空"。所以下面那条
  // `targetCommit` 为空的分支在生产里没有形状，它只是"实参只许是读到的 commit"的护栏。
  const repo = makeBranchClone('cli-noref')
  try {
    const out = advanceExistingClone({ repoDir: repo.cloneDir, ref: 'nosuchbranch', spawn: spawnGit })
    assert.equal(out.action, 'refuse', JSON.stringify(out))
    assert.match(out.text, /couldn.t find remote ref/, `git 的原话要淌进结论里：${out.text}`)
    assert.match(out.text, /ls-remote origin nosuchbranch/, '补救里的命令要用这一趟真选出来的那个远端名')
    assert.equal(repo.head(), repo.oldTip, '拒绝的一支必须一个字都没切')
  } finally {
    repo.cleanup()
  }
})

test('advanceExistingClone: 切的那一步只拿得到读到的 commit——空落点不许进 checkout 的 argv', () => {
  // 这条测的是**我自己代码的构造**，不是 git 的一种形状（上面那条已经量过：真 git 对缺引用答 128）。
  // 假 git 在这里只做一件事：fetch 答 0 而任何 ref 都读不出。若有人把顺序换回"先切名字再复判"，
  // 这条会点名叫出 argv 里混进了空值或名字。
  const B = 'b'.repeat(40)
  const calls = []
  const spawn = (bin, args) => {
    calls.push(args.slice(2).join(' '))
    const join = args.join(' ')
    if (args[args.length - 1] === 'remote') return { status: 0, stdout: 'origin\n', stderr: '' }
    if (/status --porcelain/.test(join)) return { status: 0, stdout: '', stderr: '' }
    if (/rev-parse --verify HEAD/.test(join)) return { status: 0, stdout: `${B}\n`, stderr: '' }
    if (/--is-shallow-repository/.test(join)) return { status: 0, stdout: 'true\n', stderr: '' }
    if (/rev-parse --verify (main|FETCH_HEAD)\^\{commit\}/.test(join)) return { status: 128, stdout: '', stderr: 'fatal: Needed a single revision\n' }
    if (/\bfetch\b/.test(join)) return { status: 0, stdout: '', stderr: '' }
    if (/checkout --detach/.test(join)) return { status: 0, stdout: '', stderr: '' }
    return { status: 128, stdout: '', stderr: `unexpected: ${join}` }
  }
  const out = advanceExistingClone({ repoDir: '/Users/x/glasspane', ref: 'main', spawn })
  assert.notEqual(out.action, 'use', `落点读不出就不可能算前进过：${JSON.stringify(out)}`)
  const detaches = calls.filter((line) => /checkout --detach/.test(line))
  assert.deepEqual(detaches, [], `一次都不许切：${JSON.stringify(calls)}`)
  assert.ok(calls.some((line) => /rev-parse --verify FETCH_HEAD\^\{commit\}/.test(line)),
    `fetch 之后必须问过 FETCH_HEAD 这一支落点（不然 main 永远读不出，又回到死路）：${JSON.stringify(calls)}`)
  assert.ok(!calls.some((line) => /checkout --detach (main|)$/.test(line)),
    '名字或空值不许进 checkout 的 argv')
})

/* ------------------------------------------------------------------ 纯判定的两处 */
test('resolveRemoteName：有 origin 用它；只剩一个用它；零个或多个而无 origin 都答不出', () => {
  assert.deepEqual(resolveRemoteName({ remotes: ['origin', 'mirror'] }), { remote: 'origin' })
  assert.deepEqual(resolveRemoteName({ remotes: ['up'] }), { remote: 'up' })
  assert.match(resolveRemoteName({ remotes: [] }).error, /一个远端都没有/)
  const two = resolveRemoteName({ remotes: ['up', 'mirror'] })
  assert.equal(two.remote, undefined)
  assert.match(two.error, /2 个远端/, JSON.stringify(two))
  assert.match(two.error, /up、mirror/, '答不出的时候要把它读到的名字交出去，否则人还得自己再问一遍 git')
  assert.match(resolveRemoteName({ remotes: ['', '  '] }).error, /一个远端都没有/, '空白行不算一个远端')
})

test('既有 clone 被拒时，建议的目录从**被拒的那棵树**推出来并带引号（路径带空格要能照抄）', () => {
  const dirty = [' M engine/Package.swift']
  const out = existingCloneDecision({ targetDir: '/Volumes/src/gp', ref: 'v9.9.9-new', head: 'a'.repeat(40), tagCommit: 'a'.repeat(40), blocking: dirty })
  assert.equal(out.action, 'refuse')
  assert.match(out.text, /GLASSPANE_INSTALL_DIR="\/Volumes\/src\/gp-v9\.9\.9-new"/, out.text)
  assert.doesNotMatch(out.text, /GLASSPANE_INSTALL_DIR=~\/glasspane-/, '写死在家目录里的那条路和本轮被拒的树毫无关系')
  const spaced = existingCloneDecision({ targetDir: '/Users/John Smith/glasspane', ref: 'main', head: 'b'.repeat(40), tagCommit: 'b'.repeat(40), blocking: dirty })
  assert.match(spaced.text, /GLASSPANE_INSTALL_DIR="\/Users\/John Smith\/glasspane-main"/,
    '带空格的路径不加引号，照抄就变成两个词，clone 静默落错位置')
})

/* ------------------------------------------------- install.sh 里的两个透传旗标（finding C6） */

function makeFakeRepoTree(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gp-${label}-`))
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(root, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(root, 'engine', 'Package.swift'), '// swift-tools-version:5.9\n')
  fs.writeFileSync(path.join(root, 'mcp-shell', 'package.json'), '{}\n')
  return root
}

/** 带参数跑 install.sh（一律 dry-run：只读它**决定**做什么，不落盘）。 */
function runShArgs({ args, cwd, env = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-shargs-home-'))
  const fakeNode = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-shargs-bin-'))
  try {
    fs.writeFileSync(path.join(fakeNode, 'node'), '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 22; exit 0; fi\nexit 0\n', { mode: 0o755 })
    fs.writeFileSync(path.join(fakeNode, 'uname'), '#!/bin/sh\n[ "$1" = "-s" ] && echo Darwin || echo stub\n', { mode: 0o755 })
    return spawnSync('/bin/sh', [INSTALL_SH, ...args], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        GLASSPANE_REPO: '',
        GLASSPANE_INSTALL_DRY_RUN: '1',
        PATH: `${fakeNode}:/usr/bin:/bin:/usr/sbin:/sbin`,
        ...env,
      },
      timeout: 60_000,
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(fakeNode, { recursive: true, force: true })
  }
}

test('install.sh 认 --repo：指到一棵真树时不再付那次网络 clone（离线旗标不是只给 installer 看的）', () => {
  const repo = makeFakeRepoTree('sh-repo-flag')
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-sh-repo-cwd-'))
  try {
    const r = runShArgs({ args: ['--repo', repo], cwd: elsewhere })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /使用 --repo 指定的仓库/, r.stdout)
    assert.doesNotMatch(r.stdout, /将执行: git clone/, '给了 --repo 还规划 clone，就是把这个旗标存在的理由反着做')
    assert.match(r.stdout, new RegExp(`node ${repo}/installer/cli\\.js`), '委托行必须用的是 --repo 那一棵')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('install.sh 认 --no-bootstrap：定位不到源码就停，绝不先 clone 再让 installer 拒', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-sh-noboot-'))
  try {
    const r = runShArgs({ args: ['--no-bootstrap'], cwd: empty })
    assert.equal(r.status, 1, `免 clone 的这一趟定位不到源码必须停下，实得 ${r.status}：${r.stdout}`)
    assert.doesNotMatch(r.stdout, /git clone --branch/, r.stdout)
    assert.match(r.stdout, /本脚本不 clone/, r.stdout)
    // 四个定位位都要点名，否则读者不知道自己是被哪一条挡住的。
    for (const needle of ['GLASSPANE_REPO=', '--repo=', '当前目录=', '既有 clone=']) {
      assert.match(r.stdout, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), r.stdout)
    }
    assert.match(r.stdout, /下一步：用 --repo <目录>/, '拒绝要给做得动的下一步')

    // `--repo` 给了但目录不像仓库 ⇒ 同一支拒绝，不静默回落去 clone。
    const bad = runShArgs({ args: ['--repo', empty, '--no-bootstrap'], cwd: empty })
    assert.equal(bad.status, 1, bad.stdout + bad.stderr)
    assert.doesNotMatch(bad.stdout, /git clone --branch/, '目录不像仓库时不许偷偷改成 clone')
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})
