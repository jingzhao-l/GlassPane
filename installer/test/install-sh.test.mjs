import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mcpClientConfigSnippet,
  nextStepsText,
  repoMissingText,
  REPO_URL,
  INSTALL_SH_URL,
  RELEASE_VERSION,
} from '../cli.js'

/** 发布版本从 cli.js 常量取（真源唯一），测试里不复制字面量。 */
function require_release_version() {
  return { RELEASE_VERSION }
}

const INSTALL_SH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'install.sh')

function makeFakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-installsh-'))
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(root, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(root, 'engine', 'Package.swift'), '// swift-tools-version:5.9\n')
  fs.writeFileSync(path.join(root, 'mcp-shell', 'package.json'), '{}')
  return root
}

/** 以受控环境运行 install.sh（dry-run 保证零副作用：不 clone、不委托执行）。 */
function runInstallSh({ cwd, env = {} } = {}) {
  return spawnSync('/bin/sh', [INSTALL_SH], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GLASSPANE_REPO: '', GLASSPANE_INSTALL_DRY_RUN: '1', ...env },
  })
}

// ---------------------------------------------------------------------------
// install.sh（壳层脚本：语法 + 三条定位分支 + 透传，全部 dry-run 零副作用）
// ---------------------------------------------------------------------------

test('install.sh: POSIX sh 语法检查通过', () => {
  const result = spawnSync('/bin/sh', ['-n', INSTALL_SH], { encoding: 'utf8' })
  assert.equal(result.status, 0, `sh -n 失败：${result.stderr}`)
})

test('install.sh: GLASSPANE_REPO 指向合法仓库 → dry-run 报告委托命令', () => {
  const root = makeFakeRoot()
  const result = runInstallSh({ cwd: os.tmpdir(), env: { GLASSPANE_REPO: root } })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /GLASSPANE_REPO/)
  assert.ok(result.stdout.includes(`node ${root}/installer/cli.js`), '应报告委托 installer 路径')
})

test('install.sh: 当前目录即仓库 → cwd 分支命中', () => {
  const root = makeFakeRoot()
  const result = runInstallSh({ cwd: root })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /当前目录/)
})

test('install.sh: 无仓库 → dry-run 只规划 clone，绝不落盘', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-bare-'))
  const cloneDir = path.join(bare, 'clone-target')
  const result = runInstallSh({
    cwd: bare,
    env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: cloneDir, GLASSPANE_REPO_URL: 'git@example.invalid:repo.git' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[dry-run\].*git clone/)
  assert.ok(result.stdout.includes('git@example.invalid:repo.git'), 'clone URL 可被环境变量覆盖')
  assert.equal(fs.existsSync(cloneDir), false, 'dry-run 不得实际 clone')
})

test('install.sh: 参数透传（--no-gui 出现在委托行）', () => {
  const root = makeFakeRoot()
  const passthrough = spawnSync('/bin/sh', [INSTALL_SH, '--no-gui', '--skip-build'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GLASSPANE_INSTALL_DRY_RUN: '1' },
  })
  assert.equal(passthrough.status, 0, passthrough.stderr)
  assert.match(passthrough.stdout, /cli\.js .*--no-gui --skip-build/)
})

// ---------------------------------------------------------------------------
// cli.js 追加纯函数：MCP 配置片段 / 使用说明 / 无仓库指引
// ---------------------------------------------------------------------------

test('mcpClientConfigSnippet: 合法 JSON、指向仓库内 dist 产物、socket 走 env', () => {
  const snippet = mcpClientConfigSnippet({ rootDir: '/repo', socketPath: '/home/u/.glasspane/engine.sock' })
  const parsed = JSON.parse(snippet)
  assert.deepEqual(Object.keys(parsed.mcpServers), ['glasspane'])
  const server = parsed.mcpServers.glasspane
  assert.equal(server.command, 'node')
  assert.deepEqual(server.args, [path.join('/repo', 'mcp-shell', 'dist', 'index.js')])
  assert.equal(server.env.GLASSPANE_ENGINE_SOCK, '/home/u/.glasspane/engine.sock')
})

test('nextStepsText: 覆盖 MCP 接入、TCC 人工边界、registry 已发布口径', () => {
  const guiOpen = nextStepsText({ rootDir: '/repo', socketPath: '/s.sock', guiOpened: true })
  assert.ok(guiOpen.includes('面板已打开'))
  assert.ok(guiOpen.includes('"command": "node"'), '应内嵌配置片段')
  const guiClosed = nextStepsText({ rootDir: '/repo', socketPath: '/s.sock', guiOpened: false })
  assert.ok(guiClosed.includes('GlassPane.app'), '未开面板时给出打开指引')
  for (const text of [guiOpen, guiClosed]) {
    assert.ok(text.includes('授权勾选必须人工'), '诚实边界：TCC 不程序化')
    // 发布口径已于 2026-09-21 兑现（glasspane-mcp 已上 registry）：文案必须
    // 说"可 npm 全局装 + 它只是转发层"，不能再挂 Phase B 的空头承诺。
    assert.ok(text.includes('npm i -g glasspane-mcp'), 'registry 形态已成立')
    assert.ok(text.includes('只是转发层'), 'npm 包不等于引擎已装好（诚实边界）')
    assert.ok(!text.includes('挂 kernel Phase B'), '不得残留未兑现的发布承诺')
  }
})

test('install.sh: 默认 clone 钉住的发布 tag，不追移动分支', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-bare-ref-'))
  const cloneDir = path.join(bare, 'clone-target')
  const result = runInstallSh({
    cwd: bare,
    env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: cloneDir },
  })
  assert.equal(result.status, 0, result.stderr)
  const { RELEASE_VERSION } = require_release_version()
  assert.ok(
    result.stdout.includes(`--branch v${RELEASE_VERSION}`),
    `clone 应钉在发布 tag v${RELEASE_VERSION}，实际输出：${result.stdout}`,
  )
  assert.ok(!/--branch main/.test(result.stdout), '默认路径不得是 main')
})

test('install.sh: GLASSPANE_REF 显式覆盖（追主干要明说）', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-bare-ref2-'))
  const result = runInstallSh({
    cwd: bare,
    env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: path.join(bare, 'ct'), GLASSPANE_REF: 'main' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--branch main/)
})

test('install.sh: GLASSPANE_REF 置空退回 main，且与 installer 常量同源', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-bare-ref3-'))
  const result = runInstallSh({
    cwd: bare,
    env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: path.join(bare, 'ct'), GLASSPANE_REF: '' },
  })
  assert.match(result.stdout, /--branch main/)
})

test('repoMissingText: 三条路径齐全且与 install.sh 地址真源一致', () => {
  const text = repoMissingText()
  assert.ok(text.includes(INSTALL_SH_URL))
  assert.ok(text.includes(REPO_URL))
  assert.ok(text.includes('--repo'))
})
