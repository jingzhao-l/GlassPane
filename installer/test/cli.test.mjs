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