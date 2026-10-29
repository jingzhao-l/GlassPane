import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  parseArgs,
  resolveProjectRoot,
  nodeMajorVersion,
  commandAvailable,
  preflightIssues,
  launchdPlistString,
  LAUNCHD_LABEL,
  bootstrapPlan,
  existingCloneDecision,
  advanceExistingClone,
  readCloneFacts,
  repoMissingText,
  RELEASE_VERSION,
  REPO_URL,
  classifyTagVerify,
  tagVerifyDecision,
  repoHasRef,
  verifyCloneTagGpg,
} from '../cli.js'

function makeFakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-installer-test-'))
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(root, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(root, 'engine', 'Package.swift'), '// swift-tools-version:5.9')
  fs.writeFileSync(path.join(root, 'mcp-shell', 'package.json'), '{}')
  return root
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: 默认值（全开、无 repo）', () => {
  const { options, error } = parseArgs([])
  assert.equal(error, null)
  assert.equal(options.repoDir, null)
  assert.equal(options.prompt, true)
  assert.equal(options.gui, true)
  assert.equal(options.daemon, true)
  assert.equal(options.app, true)
  assert.equal(options.launchd, true)
  assert.equal(options.skipBuild, false)
})

test('parseArgs: 显式开关与 repo 目录', () => {
  const { options, error } = parseArgs(['--repo', '/tmp/x', '--no-gui', '--no-prompt', '--no-app', '--no-launchd', '--skip-build'])
  assert.equal(error, null)
  assert.equal(options.repoDir, '/tmp/x')
  assert.equal(options.gui, false)
  assert.equal(options.prompt, false)
  assert.equal(options.app, false)
  assert.equal(options.launchd, false)
  assert.equal(options.skipBuild, true)
})

test('parseArgs: --repo 缺参报错', () => {
  const { error } = parseArgs(['--repo'])
  assert.ok(error, '缺参必须返回错误')
  assert.ok(error.includes('--repo'), '错误信息应指出 --repo')
})

test('parseArgs: 未知参数报错、--help 生效', () => {
  const unknow = parseArgs(['--wat'])
  assert.ok(unknow.error)
  assert.equal(parseArgs(['-h']).options.help, true)
  assert.equal(parseArgs(['--help']).options.help, true)
})

// ---------------------------------------------------------------------------
// resolveProjectRoot
// ---------------------------------------------------------------------------

test('resolveProjectRoot: 顶部目录被识别为根', () => {
  const root = makeFakeRoot()
  assert.equal(resolveProjectRoot(root), root)
})

test('resolveProjectRoot: 深层子目录向上找到根', () => {
  const root = makeFakeRoot()
  const deep = path.join(root, 'mcp-shell', 'src', 'nested')
  fs.mkdirSync(deep, { recursive: true })
  assert.equal(resolveProjectRoot(deep), root)
})

test('resolveProjectRoot: 无匹配结构返回 null', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-empty-'))
  assert.equal(resolveProjectRoot(empty), null)
})

// ---------------------------------------------------------------------------
// 环境检测
// ---------------------------------------------------------------------------

test('nodeMajorVersion: 解析当前 Node 主版本 >= 18', () => {
  assert.ok(nodeMajorVersion() >= 18)
})

test('nodeMajorVersion: 不存在的解释器返回 0', () => {
  assert.equal(nodeMajorVersion('/nonexistent/node-bin'), 0)
})

test('commandAvailable: 真实命令可用、假命令不可用', () => {
  assert.equal(commandAvailable(process.execPath), true)
  assert.equal(commandAvailable('/nonexistent/definitely-not-a-command'), false)
})

test('preflightIssues: 缺项逐条列出，全绿为空', () => {
  const broken = preflightIssues({ nodeMajor: 14, nodeOk: false, npm: false, swift: false, git: false, open: false })
  assert.ok(broken.length >= 4, 'node 版本 + npm + swift + git + open 都应为缺失项')
  assert.ok(broken.some((item) => item.includes('Node.js')))
  const healthy = preflightIssues({ nodeMajor: 20, nodeOk: true, npm: true, swift: true, git: true, open: true })
  assert.deepEqual(healthy, [])
})

// ---------------------------------------------------------------------------
// launchd plist 生成器（纯函数）
// ---------------------------------------------------------------------------

test('launchdPlistString: 关键键值齐全、参数顺序正确、XML 转义生效', () => {
  const plist = launchdPlistString({
    label: LAUNCHD_LABEL,
    daemonBin: '/repo/engine/.build/release/glasspaned',
    socketPath: '/Users/ethanlin/.glasspane/engine.sock',
    logPath: '/Users/ethanlin/.glasspane/installer-daemon.log',
  })
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.glasspane\.daemon<\/string>/)
  // ProgramArguments 严格顺序：二进制 → --socket-path → socket 路径
  const argumentsBlock = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)
  assert.ok(argumentsBlock, 'ProgramArguments 必须存在')
  const argStrings = [...argumentsBlock[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
  assert.deepEqual(argStrings, [
    '/repo/engine/.build/release/glasspaned',
    '--socket-path',
    '/Users/ethanlin/.glasspane/engine.sock',
  ])
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/)
  assert.match(plist, /<key>StandardErrorPath<\/key>/)
  assert.doesNotMatch(plist, /&(?!amp;|lt;|gt;)/, '路径中的 & 必须被转义')
})

test('launchdPlistString: 特殊字符路径 XML 转义（防路径注入）', () => {
  const plist = launchdPlistString({
    label: LAUNCHD_LABEL,
    daemonBin: '/tmp/a&b/glasspaned',
    socketPath: '/tmp/x<y>.sock',
    logPath: '/tmp/l>og.log',
  })
  assert.ok(plist.includes('/tmp/a&amp;b/glasspaned'))
  assert.ok(plist.includes('/tmp/x&lt;y&gt;.sock'))
  assert.ok(plist.includes('/tmp/l&gt;og.log'))
})
// ---------------------------------------------------------------------------
// restoreLaunchd（P6 §11 审计项④：launchd 恢复机器化）
// ---------------------------------------------------------------------------

import { restoreLaunchd } from '../cli.js'

function makeRestoreDeps({ already = false, bootOk = true, reachable = true, hello = null, kickOk = true } = {}) {
  const calls = { kickstart: 0, bootstrap: 0 }
  let helloReturns = hello
  const deps = {
    plistPath: '/fake/com.glasspane.daemon.plist',
    socketPath: '/fake/engine.sock',
    existsFn: () => true,
    bootstrapFn: () => {
      calls.bootstrap += 1
      return { ok: bootOk, already, message: bootOk ? (already ? 'already loaded' : 'bootstrapped') : 'boom' }
    },
    kickstartFn: () => {
      calls.kickstart += 1
      return { ok: kickOk, message: 'kicked' }
    },
    waitFn: async () => reachable,
    helloFn: async () => helloReturns,
  }
  return { deps, calls }
}

test('restoreLaunchd: --restore-launchd 参数被解析且默认关闭', () => {
  assert.equal(parseArgs([]).options.restoreLaunchd, false)
  assert.equal(parseArgs(['--restore-launchd']).options.restoreLaunchd, true)
})

test('restoreLaunchd: plist 缺失 → 不猜，指回完整安装', async () => {
  const { deps } = makeRestoreDeps()
  const result = await restoreLaunchd({ ...deps, existsFn: () => false })
  assert.equal(result.ok, false)
  assert.equal(result.action, 'missing-plist')
  assert.match(result.message, /install\.sh/)
})

test('restoreLaunchd: bootstrap 失败如实上报，不进入校验', async () => {
  const { deps, calls } = makeRestoreDeps({ bootOk: false })
  const result = await restoreLaunchd(deps)
  assert.equal(result.ok, false)
  assert.equal(result.action, 'bootstrap-failed')
  assert.equal(calls.bootstrap, 1)
})

test('restoreLaunchd: bootout 恢复 + hello 自报 granted → 零人工动作', async () => {
  const { deps, calls } = makeRestoreDeps({
    already: false,
    hello: { pid: 123, version: '0.1.0', permissions: { accessibility: 'granted' } },
  })
  const result = await restoreLaunchd(deps)
  assert.equal(result.ok, true)
  assert.equal(result.action, 'bootstrapped')
  assert.equal(result.verified.accessibility, 'granted')
  assert.match(result.message, /无人工动作/)
  assert.equal(calls.kickstart, 0, '新 bootstrap 的进程判定本就是新的，不得多余 kickstart')
})

test('restoreLaunchd: 已加载但自报未授权 → kickstart 换进程复验（勾框后的闭环）', async () => {
  const { deps, calls } = makeRestoreDeps({ already: true, hello: { pid: 1, version: 'v', permissions: { accessibility: 'notGranted' } } })
  // 第一次 hello 未授权；kickstart 后的第二次 hello 授权（模拟用户刚勾完框）。
  let n = 0
  deps.helloFn = async () => {
    n += 1
    return n === 1
      ? { pid: 1, version: 'v', permissions: { accessibility: 'notGranted' } }
      : { pid: 2, version: 'v', permissions: { accessibility: 'granted' } }
  }
  const result = await restoreLaunchd(deps)
  assert.equal(result.ok, true)
  assert.equal(calls.kickstart, 1)
  assert.equal(result.action, 'restarted-for-grant')
  assert.equal(result.verified.accessibility, 'granted')
})

test('restoreLaunchd: 新 bootstrap 但未授权 → 指路唯一人工动作，不乱 kickstart', async () => {
  const { deps, calls } = makeRestoreDeps({
    already: false,
    hello: { pid: 7, version: 'v', permissions: { accessibility: 'notDetermined' } },
  })
  const result = await restoreLaunchd(deps)
  assert.equal(result.ok, true)
  assert.equal(result.action, 'bootstrapped')
  assert.match(result.message, /勾选/)
  assert.equal(calls.kickstart, 0)
})

test('restoreLaunchd: hello 缺 permissions → 如实 unknown，绝不冒充 granted', async () => {
  const { deps } = makeRestoreDeps({ already: false, hello: { pid: 9, version: 'v' } })
  const result = await restoreLaunchd(deps)
  assert.equal(result.verified.accessibility, null)
  assert.match(result.message, /unknown/)
})

test('restoreLaunchd: socket 不可达 → ok=false，报告未服务', async () => {
  const { deps } = makeRestoreDeps({ already: false, reachable: false })
  const result = await restoreLaunchd(deps)
  assert.equal(result.ok, false)
  assert.match(result.message, /未服务/)
})

// ---------------------------------------------------------------------------
// 源码引导（npx 一等渠道兑现，2026-09-22 基础设施审计）
// ---------------------------------------------------------------------------

test('bootstrapPlan: 默认把发布 tag clone 到 ~/glasspane', () => {
  const plan = bootstrapPlan({ homeDir: '/Users/tester' })
  assert.equal(plan.error, undefined)
  assert.equal(plan.targetDir, path.join('/Users/tester', 'glasspane'))
  assert.equal(plan.ref, `v${RELEASE_VERSION}`)
  assert.deepEqual(plan.gitArgs, [
    'clone', '--branch', `v${RELEASE_VERSION}`, '--depth', '1', '--',
    REPO_URL, path.join('/Users/tester', 'glasspane'),
  ], '位置参数前必须有 -- ：值以 - 开头时会被 git 当成选项（finding 3）')
})

test('bootstrapPlan: GLASSPANE_REF/installDir 覆盖生效（钉 main 可追主干）', () => {
  const plan = bootstrapPlan({ homeDir: '/Users/tester', installDir: '/tmp/gp', ref: 'main' })
  assert.equal(plan.targetDir, '/tmp/gp')
  assert.equal(plan.ref, 'main')
  assert.equal(plan.gitArgs[2], 'main')
})

test('bootstrapPlan: HOME 为空不猜目标目录，直接给错', () => {
  const plan = bootstrapPlan({ homeDir: '' })
  assert.match(plan.error, /HOME/)
})

test('bootstrapPlan: 目标已存在且不是仓库 → 拒绝，绝不覆盖用户目录', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-bootstrap-'))
  const busy = path.join(outer, 'occupied')
  fs.mkdirSync(busy)
  fs.writeFileSync(path.join(busy, 'keep-me.txt'), 'x')
  const plan = bootstrapPlan({ homeDir: outer, installDir: busy })
  assert.match(plan.error, /已存在且不是 GlassPane 仓库/)
  assert.equal(fs.existsSync(path.join(busy, 'keep-me.txt')), true)
})

test('bootstrapPlan: 目标已是 GlassPane 结构 → 按那棵树的事实决定，不再往它身上跑 git clone', () => {
  // 这一支以前只回一个 clone 计划，于是"复用"这个名字是空的：真跑下去是 git 的
  // "destination path … already exists and is not an empty directory"，读者被告知"换个目录"，
  // 而换到的目录下次还会是同一个。现在三种事实三种结论，且三种都不产生 `gitArgs`。
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-bootstrap-'))
  const repo = path.join(outer, 'glasspane')
  fs.mkdirSync(path.join(repo, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'engine', 'Package.swift'), '//')
  fs.writeFileSync(path.join(repo, 'mcp-shell', 'package.json'), '{}')
  const shapes = {
    same: { head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tagCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', blocking: [] },
    older: { head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', tagCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', blocking: [] },
    // 本机那棵 `~/glasspane` 的真实形状（2026-10-27 量）：干净、HEAD 在 v1.5.0 之后一笔、
    // 本地 tag 表停在 v1.2.0 ⇒ `rev-parse --verify v1.22.0^{commit}` 答非零。旧判据把这一格读成
    // 拒绝，于是**会去 fetch 这个 tag 的那一步永远轮不到执行**——npm 入口对旧 clone 恒拒。
    noTag: { head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', tagCommit: null, blocking: [] },
    dirty: { head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', tagCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', blocking: [' M engine/Package.swift'] },
    unreadable: { head: null, tagCommit: null, blocking: [] },
  }
  for (const [name, state] of Object.entries(shapes)) {
    const plan = bootstrapPlan({ homeDir: outer, installDir: repo, ref: 'v9.9.9', readCloneState: () => state })
    assert.equal(plan.gitArgs, undefined, `${name} 这一支不许产生 clone 参数`)
    assert.equal(plan.error, undefined, `${name}：${plan.error}`)
  }
  const use = bootstrapPlan({ homeDir: outer, installDir: repo, ref: 'v9.9.9', readCloneState: () => shapes.same })
  assert.equal(use.use, true, JSON.stringify(use))
  assert.equal(use.targetDir, repo)
  const advance = bootstrapPlan({ homeDir: outer, installDir: repo, ref: 'v9.9.9', readCloneState: () => shapes.older })
  assert.equal(advance.advance.ref, 'v9.9.9', JSON.stringify(advance))
  assert.equal(advance.advance.targetDir, repo)
  const missingTag = bootstrapPlan({ homeDir: outer, installDir: repo, ref: 'v9.9.9', readCloneState: () => shapes.noTag })
  assert.ok(!missingTag.refuse, `tag 本地缺席不是拒绝：${JSON.stringify(missingTag)}`)
  assert.equal(missingTag.advance?.decision?.needsFetch, true, '要交给会 fetch 的那一步，而不是在这里判死')
  const dirty = bootstrapPlan({ homeDir: outer, installDir: repo, ref: 'v9.9.9', readCloneState: () => shapes.dirty })
  assert.equal(dirty.refuse?.blocking.length, 1, JSON.stringify(dirty))
  assert.match(dirty.refuse.text, /engine\/Package\.swift/, '拒绝要点名挡路的那个文件')
  assert.match(dirty.refuse.text, /GLASSPANE_INSTALL_DIR=/, '也要给一条做得动的路')
  assert.doesNotMatch(dirty.refuse.text, /git (stash|checkout -f|clean)/, '不许把销毁性的 git 动作写成补救')
  // 没注入探针的调用方（旧的 main 之外的一切）仍走 clone 计划：这条计划的存在是这个函数的手感。
  const blind = bootstrapPlan({ homeDir: outer, installDir: repo })
  assert.ok(Array.isArray(blind.gitArgs), '不报状态时仍按 clone 计划返回')
})

test('existingCloneDecision: HEAD 读不出是拒，tag 本地读不出是"先去 fetch 再判"', () => {
  const base = { targetDir: '/Users/x/glasspane', ref: 'v9.9.9' }
  assert.equal(existingCloneDecision({ ...base, head: 'a', tagCommit: 'a', blocking: [] }).action, 'use')
  assert.equal(existingCloneDecision({ ...base, head: 'b', tagCommit: 'a', blocking: [] }).action, 'advance')
  assert.equal(existingCloneDecision({ ...base, head: 'b', tagCommit: 'a', blocking: ['?? scratch/'] }).action, 'refuse')
  // 这两格在 2026-10-26 是并成一句"判不出来就拒"的，于是本机那棵旧 clone 在 npm 入口上永远走不到
  // fetch。分开之后：能补的事实缺口 ⇒ 前进（由 IO 步去 fetch）；判据本身没了 ⇒ 拒。
  const noTag = existingCloneDecision({ ...base, head: 'b', tagCommit: null, blocking: [] })
  assert.equal(noTag.action, 'advance', 'tag 缺席不许在这里判死：拒绝它的那一步之后没有人会去 fetch')
  assert.equal(noTag.needsFetch, true, '结论要带着"缺一次 fetch"这个事实，句子里才说得出为什么还没切')
  assert.match(noTag.text, /先 fetch/, noTag.text)
  assert.match(noTag.text, /fetch 不成就是拒/, '要当场说清 fetch 失败的下场，不留"大概会切过去"的想象')
  const noHead = existingCloneDecision({ ...base, head: null, tagCommit: 'a', blocking: [] })
  assert.equal(noHead.action, 'refuse')
  assert.doesNotMatch(noHead.text, /fetch --tags --depth 1 后重跑/, '旧文案让人手工跑那一步——而那本来是代码自己会做的')
  assert.equal(existingCloneDecision({ ...base, head: null, tagCommit: null, blocking: [] }).action, 'refuse')
  // 挡路文件超过 10 个时只点前 10 个，但**计数**要说全：一句"有 47 处"加 10 行样本，读者知道规模。
  const many = Array.from({ length: 47 }, (_, i) => ` M file-${i}.swift`)
  const refused = existingCloneDecision({ ...base, head: 'b', tagCommit: 'a', blocking: many })
  assert.match(refused.text, /有 47 处未提交改动/, refused.text.slice(0, 200))
  assert.match(refused.text, /另有 37 处/, refused.text)
  assert.equal(refused.blocking.length, 47, '数据要留全：文本是给人读的，字段是给机器读的')
  assert.equal(refused.text.split('\n').filter((l) => /file-\d+\.swift/.test(l)).length, 10, '屏幕上只点十个')
})

test('readCloneFacts: 浅不浅由 git 答，答不出来按完整仓对待', () => {
  const read = (stdout, status = 0) => ({ status, stdout, stderr: '' })
  const spawn = (bin, args) => {
    const join = args.join(' ')
    // 2026-10-29 S7-1：这把桩从前**没有** --show-toplevel 这一答，于是它对任意目录都默认
    // "这里就是一棵仓库，且这就是它自己的根"——被修的缺陷恰恰活在那一句没问里（外层那棵树
    // 的事实被读成"这一棵"的事实）。答成被问的那个目录本身，测的才是"根对上了往下走"那一支；
    // 答不上的那一支由 daily-20261029-installer-lane7.test.mjs 用**真 git** 量。
    if (/--show-toplevel/.test(join)) return read(`${args[1]}\n`)
    if (/status --porcelain/.test(join)) return read('')
    if (/rev-parse --verify HEAD/.test(join)) return read('b'.repeat(40) + '\n')
    if (/rev-parse --verify v9\.9\.9/.test(join)) return read('', 1)  // 本地没这个 tag
    if (/--is-shallow-repository/.test(join)) return shallow
    return read('', 128)
  }
  let shallow = read('true\n')
  assert.equal(readCloneFacts({ targetDir: '/x', ref: 'v9.9.9', spawn }).shallow, true)
  shallow = read('false\n')
  assert.equal(readCloneFacts({ targetDir: '/x', ref: 'v9.9.9', spawn }).shallow, false)
  // git 太老／答不了：`null` 是"不知道"，而"不知道"在 fetch 那一支落到**不带 --depth**——
  // 宁可多取一点，也不给一棵可能完整的仓落下 .git/shallow 边界。
  shallow = read('', 128)
  assert.equal(readCloneFacts({ targetDir: '/x', ref: 'v9.9.9', spawn }).shallow, null)
})

test('advanceExistingClone: 完整 clone 的 fetch 不许带 --depth，浅仓才带；fetch 不成就是拒', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)
  const run = ({ shallow, fetchStatus = 0 }) => {
    const calls = []
    let head = B
    let hasTag = false
    let checkedOut = false
    const spawn = (bin, args) => {
      calls.push(args.slice(2).join(' '))
      const join = args.join(' ')
      // S7-1（2026-10-29）：这把桩必须答得出"要动的是不是这一棵"。从前它对所有 argv 都答话、
      // 唯独没被问过 --show-toplevel，等于替"外层那棵树也可以被前进"作背书。这里答的是被问的
      // 那个目录自己（args[1]），也就是"根对上了"那一支；答不上的那一支由真 git 的量
      // （daily-20261029-installer-lane7.test.mjs），不在桩里假装验过。
      if (/--show-toplevel/.test(join)) return { status: 0, stdout: `${args[1]}\n`, stderr: '' }
      if (args[args.length - 1] === 'remote') return { status: 0, stdout: 'origin\n', stderr: '' }
      if (/status --porcelain/.test(join)) return { status: 0, stdout: checkedOut ? '' : '', stderr: '' }
      if (/rev-parse --verify HEAD/.test(join)) return { status: 0, stdout: `${head}\n`, stderr: '' }
      if (/rev-parse --verify v9\.9\.9\^\{commit\}/.test(join)) {
        return hasTag ? { status: 0, stdout: `${A}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' }
      }
      if (/--is-shallow-repository/.test(join)) {
        return shallow === null
          ? { status: 128, stdout: '', stderr: 'unknown repository' }
          : { status: 0, stdout: `${shallow ? 'true' : 'false'}\n`, stderr: '' }
      }
      if (/\bfetch --tags/.test(join)) {
        if (fetchStatus !== 0) return { status: fetchStatus, stdout: '', stderr: `fatal: remote did not send ${A}: 网络断了\n` }
        hasTag = true
        return { status: 0, stdout: '', stderr: '' }
      }
      // 切的是**落点 sha**，不是那个名字：`checkout --detach v9.9.9` 在按 tag 建的 clone 里
      // 走不通（本机实测 git 报 "--detach does not take a path argument"），而 fetch 的落点就是
      // 一个 sha。见 daily-20261027-clone-ref-resolution.test.mjs。
      if (new RegExp(`checkout --detach ${A}`).test(join)) { checkedOut = true; head = A; return { status: 0, stdout: '', stderr: '' } }
      return { status: 128, stdout: '', stderr: `unexpected: ${join}` }
    }
    return { out: advanceExistingClone({ repoDir: '/Users/x/glasspane', ref: 'v9.9.9', spawn }), calls }
  }
  // 旧 clone 补 tag 这一趟以前在判据处就被拒了（见上一条用例），这里是它真正走完的样子。
  const full = run({ shallow: false })
  assert.equal(full.out.action, 'use', full.out.text ?? JSON.stringify(full.out))
  assert.equal(full.out.advanced, true, 'fetch 之后复判成立才算前进过')
  const fullFetch = full.calls.find((a) => /fetch --tags/.test(a))
  assert.equal(fullFetch, 'fetch --tags origin v9.9.9', `完整 clone 的 fetch 不许带 --depth：${fullFetch}`)
  assert.ok(full.calls.some((a) => a === `checkout --detach ${A}`),
    `必须切到读到的那个 commit sha：${JSON.stringify(full.calls)}`)

  const shallowRun = run({ shallow: true })
  assert.equal(shallowRun.out.action, 'use', shallowRun.out.text ?? JSON.stringify(shallowRun.out))
  assert.equal(shallowRun.calls.find((a) => /fetch --tags/.test(a)), 'fetch --tags --depth 1 origin v9.9.9',
    '浅仓才带 --depth 1：它已经在边界里了，多一个 tag 不必把整段历史拉进来')

  // git 答不出浅不浅 ⇒ 与"完整"同一形（宁可多取，不落下边界）。
  const unknown = run({ shallow: null })
  assert.equal(unknown.calls.find((a) => /fetch --tags/.test(a)), 'fetch --tags origin v9.9.9', JSON.stringify(unknown.calls))

  // fetch 不成 ⇒ 拒，且交出 git 的原话、说清什么都没动。这一支是"tag 缺席改成前进"之后
  // 唯一还在拒绝的地方：删掉它，切一个取不回来的 ref 就会把 clone 留在原地而不明说。
  const failed = run({ shallow: false, fetchStatus: 128 })
  assert.equal(failed.out.action, 'refuse', JSON.stringify(failed.out))
  assert.match(failed.out.text, /网络断了/, 'git 的原话要淌进结论里，不许被"网络不可达"这种二手归因盖掉')
  assert.match(failed.out.text, /没有切分支/, failed.out.text)
  assert.equal(failed.out.fetchArgs.join(' '), 'fetch --tags origin v9.9.9', '拒的时候要把自己用的 argv 留在数据里')
  assert.ok(!failed.calls.some((a) => /checkout/.test(a)), `fetch 失败之后不许切：${JSON.stringify(failed.calls)}`)
})

test('advanceExistingClone: 只有读、fetch、detach 这几种动作，且切完按事实复判', () => {
  const calls = []
  const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  let head = B
  let checkedOut = false
  const spawn = (bin, args) => {
    calls.push(args.slice(2))
    const join = args.join(' ')
    // S7-1：见上一条用例里同一段注释——"只有这几种动作"这份名单从前漏了 --show-toplevel，
    // 而恰恰是那一问挡住了"动外层那棵树"。它现在是一次**读**，仍在这条用例允许的集合里。
    if (/--show-toplevel/.test(join)) return { status: 0, stdout: `${args[1]}\n`, stderr: '' }
    if (args[args.length - 1] === 'remote') return { status: 0, stdout: 'origin\n', stderr: '' }
    if (/status --porcelain/.test(join)) return { status: 0, stdout: checkedOut ? '' : '', stderr: '' }
    if (/rev-parse --verify HEAD/.test(join)) return { status: 0, stdout: `${head}\n`, stderr: '' }
    if (/rev-parse --verify v9\.9\.9\^\{commit\}/.test(join)) return { status: 0, stdout: `${A}\n`, stderr: '' }
    if (/checkout --detach a{40}/.test(join)) { checkedOut = true; head = A; return { status: 0, stdout: '', stderr: '' } }
    if (/fetch/.test(join)) return { status: 0, stdout: '', stderr: '' }
    return { status: 128, stdout: '', stderr: `unexpected: ${join}` }
  }
  const out = advanceExistingClone({ repoDir: '/Users/x/glasspane', ref: 'v9.9.9', spawn })
  assert.equal(out.action, 'use', out.text ?? JSON.stringify(out))
  assert.equal(out.advanced, true)
  assert.equal(out.from, B, '句子要说从哪个 commit 前进过来的')
  for (const args of calls) {
    assert.doesNotMatch(args.join(' '), /(?:^|\s)-f(?:\s|$)|--force|stash|clean|reset/, `安装器不许动别人的工作：${args.join(' ')}`)
  }
  assert.ok(calls.some((args) => args.join(' ') === `checkout --detach ${A}`),
    `该切的那一步要真的切了，且切的是落点 sha 而不是那个名字：${JSON.stringify(calls.map((a) => a.join(' ')))}`)

  // 切完复判不成立 ⇒ 拒。这一条是"判据落在切换之后的事实上"这条规矩的读者：把复判删掉，
  // 上面那段 detach-fails-open 的代码就会把一棵切坏了的树交去构建。
  let checkoutRan = false
  const lying = advanceExistingClone({
    repoDir: '/Users/x/glasspane',
    ref: 'v9.9.9',
    spawn: (bin, args) => {
      const join = args.join(' ')
      // S7-1：同上。这一把桩要演的是"切完之后判据不再成立"，所以它得先通过"要动的是这一棵"那一问。
      if (/--show-toplevel/.test(join)) return { status: 0, stdout: `${args[1]}\n`, stderr: '' }
      if (args[args.length - 1] === 'remote') return { status: 0, stdout: 'origin\n', stderr: '' }
      // 切之前：干净、HEAD 在 B、tag 在 A ⇒ 判成"前进"。切之后：HEAD 到了 A 却冒出一处改动，
      // 复判必须把它拦下来——这一支不许把"命令退出了 0"当成"这棵树可用"。
      if (/status --porcelain/.test(join)) return { status: 0, stdout: checkoutRan ? ' M 被切坏了的文件\n' : '', stderr: '' }
      if (/rev-parse --verify HEAD/.test(join)) return { status: 0, stdout: `${checkoutRan ? A : B}\n`, stderr: '' }
      if (/rev-parse --verify v9\.9\.9\^\{commit\}/.test(join)) return { status: 0, stdout: `${A}\n`, stderr: '' }
      if (/checkout --detach/.test(join)) { checkoutRan = true; return { status: 0, stdout: '', stderr: '' } }
      return { status: 128, stdout: '', stderr: join }
    },
  })
  assert.equal(lying.action, 'refuse', JSON.stringify(lying))
  assert.match(lying.text, /切完之后/, lying.text)
  assert.equal(lying.blocking.length, 1, '复判拒的时候也要把冒出来的改动带在数据里')
})

test('parseArgs: bootstrap 默认开，--no-bootstrap 关闭', () => {
  assert.equal(parseArgs([]).options.bootstrap, true)
  assert.equal(parseArgs(['--no-bootstrap']).options.bootstrap, false)
})

test('parseArgs: --no-bootstrap 不影响其它开关默认值', () => {
  const { options, error } = parseArgs(['--no-bootstrap'])
  assert.equal(error, null)
  assert.equal(options.skipBuild, false)
  assert.equal(options.app, true)
  assert.equal(options.launchd, true)
})

test('repoMissingText: 指引里的 ref 与 --no-bootstrap 文案口径一致', () => {
  const text = repoMissingText()
  assert.match(text, new RegExp(`--branch v${RELEASE_VERSION}`))
  assert.match(text, /install\.sh \| sh/)
  assert.match(text, /GLASSPANE_REF=main/)
})

// ---------------------------------------------------------------------------
// 发布 tag GPG 验签（P4 §35 来源证明；best-effort，不阻断）
// ---------------------------------------------------------------------------

function makeGitRepoWithUnsignedTag() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-verifytag-'))
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x')
  const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git(['init', '-q'])
  git(['config', 'user.email', 't@t.local'])
  git(['config', 'user.name', 't'])
  git(['add', 'a.txt'])
  git(['commit', '-qm', 'init'])
  git(['tag', '-a', 'v0.0.0', '-m', 'unsigned tag'])
  return repo
}

test('classifyTagVerify: 退出码 0 = 验签通过', () => {
  const res = classifyTagVerify({ status: 0, stdout: 'Good signature', stderr: '' })
  assert.equal(res.status, 'verified')
})

test('classifyTagVerify: no signature found = 未签名（非篡改）', () => {
  const res = classifyTagVerify({ status: 1, stderr: 'error: no signature found' })
  assert.equal(res.status, 'unsigned')
})

test('classifyTagVerify: 其余非零失败 = invalid（签名对不上/无法确证）', () => {
  assert.equal(classifyTagVerify({ status: 1, stderr: 'gpg: BAD signature from ...' }).status, 'invalid')
  assert.equal(classifyTagVerify({ status: 2, stderr: 'Could not check signature: public key not found' }).status, 'invalid')
})

test('repoHasRef: 有 tag 为 true，无则为 false（不抛错）', () => {
  const repo = makeGitRepoWithUnsignedTag()
  try {
    assert.equal(repoHasRef(repo, 'v0.0.0'), true)
    assert.equal(repoHasRef(repo, 'v9.9.9'), false)
    assert.equal(repoHasRef('/definitely/not/a/repo', 'v0.0.0'), false)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('verifyCloneTagGpg: 未签名 tag 如实报 unsigned（真实 gpg 路径）', { skip: commandAvailable('gpg') ? false : 'gpg 不可用' }, () => {
  const repo = makeGitRepoWithUnsignedTag()
  try {
    const res = verifyCloneTagGpg({ repoDir: repo, ref: 'v0.0.0' })
    assert.equal(res.status, 'unsigned')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('verifyCloneTagGpg: 仓库无该 tag → unavailable，不触发 gpg', () => {
  const repo = makeGitRepoWithUnsignedTag()
  try {
    const res = verifyCloneTagGpg({ repoDir: repo, ref: 'v9.9.9', tmpDir: '/definitely/unwritable' })
    assert.equal(res.status, 'unavailable')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * 验签结论落成安装动作。修之前 main() 里是一个两分支的 if：`invalid`（签名在、
 * 验不过）与 `unsigned`（只是没签名）都走同一句"——继续安装"，然后照跑
 * npm install、swift build 并注册 launchd。自动更新那面对 `invalid` 是硬拒且
 * consent 洗不掉，两条路的诚实度不该不一样——而安装是更不可逆的那条。
 * 判据抽成 `tagVerifyDecision` 之后才有测试可指：埋在 main() 里的那一段没法单测。
 */
test('tagVerifyDecision: 只有 tag 真没签名才继续，签不上与没跑成都停下', () => {
  const repoDir = '/repo'
  const decide = (status, detail = 'd') => tagVerifyDecision({ sig: { status, detail }, pinRef: 'v1.2.3', repoDir })

  assert.equal(decide('verified').action, 'pass')
  assert.match(decide('verified').text, /签名验证通过/)

  // 缺证明（tag 里确实没有签名层）：黄字继续，但话说清是"缺增量"，不许写成"验签通过"。
  const unsigned = decide('unsigned')
  assert.equal(unsigned.action, 'warn', 'unsigned 只是缺证明，应当继续')
  assert.match(unsigned.text, /继续安装/, 'unsigned 的文案要说明确实继续')
  assert.ok(!/签名验证通过/.test(unsigned.text), 'unsigned 不许冒充验签通过')

  // 2026-10-28 缺陷 2：`unavailable` 从前和 `unsigned` 合流放行，可它说的不是"这个 tag
  // 没签名"，而是"这道验签在本机没跑成"（没有 gpg / 导入公钥失败 / 验签抛错）。
  // "没跑成的检查"讲成"检查过了"就是替没验过的字节作保——拒装，出路是一条显式旗标。
  const unavailable = decide('unavailable', 'gpg 不可用，跳过发布 tag GPG 验签')
  assert.equal(unavailable.action, 'refuse', '验签没跑成不许与"没签名"合流放行')
  assert.match(unavailable.text, /--accept-unverified-signature/, '拒绝必须给得出可执行的下一步')
  assert.match(unavailable.text, /没有跑 npm install/, '拒装要说明确实什么都没做')
  assert.ok(!/签名验证通过/.test(unavailable.text))
  const waived = tagVerifyDecision({
    sig: { status: 'unavailable', detail: 'gpg 不可用' }, pinRef: 'v1.2.3', repoDir, acceptUnverified: true,
  })
  assert.equal(waived.action, 'warn', '显式旗标才放行')
  assert.match(waived.text, /没有验签结论/, '放行后仍要如实打出这是缺结论装上的')

  // 签不上：停下，并且说清哪些不可逆的事**没做**、下一步做什么。
  const refusal = decide('invalid', 'gpg: BAD signature from ...')
  assert.equal(refusal.action, 'refuse')
  assert.match(refusal.text, /没有跑 npm install/)
  assert.match(refusal.text, /没有注册 launchd/)
  assert.ok(!/继续安装/.test(refusal.text), '拒签的报文里不许出现"继续安装"')
  assert.match(refusal.text, /git -C "\/repo" tag -v v1\.2\.3/, '拒绝必须给得出可执行的核对步骤')
  assert.match(refusal.text, /GLASSPANE_REF=/, '拒绝必须给得出下一步怎么继续安装')

  // 负例的另一半：安装器不认识的新判据不许被当成"没签名"放过。
  for (const status of ['failed', 'ok', '', undefined]) {
    assert.equal(decide(status).action, 'refuse', `${JSON.stringify(status)} 是安装器没见过的判据，必须停下`)
  }
})
