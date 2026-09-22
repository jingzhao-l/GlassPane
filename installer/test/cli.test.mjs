import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseArgs,
  resolveProjectRoot,
  nodeMajorVersion,
  commandAvailable,
  preflightIssues,
  launchdPlistString,
  LAUNCHD_LABEL,
  bootstrapPlan,
  repoMissingText,
  RELEASE_VERSION,
  REPO_URL,
} from '../cli.js'

function makeFakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-installer-test-'))
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(root, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(root, 'engine', 'Package.swift'), '// swift-tools-version:5.9\n')
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
    'clone', '--branch', `v${RELEASE_VERSION}`, '--depth', '1',
    REPO_URL, path.join('/Users/tester', 'glasspane'),
  ])
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

test('bootstrapPlan: 目标已是 GlassPane 结构 → 复用，不重复 clone', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-bootstrap-'))
  const repo = path.join(outer, 'glasspane')
  fs.mkdirSync(path.join(repo, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'engine', 'Package.swift'), '//\n')
  fs.writeFileSync(path.join(repo, 'mcp-shell', 'package.json'), '{}')
  const plan = bootstrapPlan({ homeDir: outer, installDir: repo })
  assert.equal(plan.error, undefined)
  assert.equal(plan.targetDir, repo)
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
