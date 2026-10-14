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
  resolvePinRef,
  bootstrapPlan,
  installGuard,
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

/** 以受控环境运行 install.sh（dry-run 保证零副作用：不 clone、不委托执行）。
 *  `drop` 是**删掉**某个变量的口子：`{...process.env, HOME: undefined}` 在 spawnSync 里
 *  等于没删（undefined 会被 JSON 序列化丢掉，但为了让"未设置"这件事写在测试里而不是一行
 *  赋值里，这里显式 delete）。 */
function runInstallSh({ cwd, env = {}, drop = [] } = {}) {
  const childEnv = { ...process.env, GLASSPANE_REPO: '', GLASSPANE_INSTALL_DRY_RUN: '1', ...env }
  for (const name of drop) delete childEnv[name]
  return spawnSync('/bin/sh', [INSTALL_SH], {
    cwd,
    encoding: 'utf8',
    env: childEnv,
  })
}

// ---------------------------------------------------------------------------
// install.sh（壳层脚本：语法 + 三条定位分支 + 透传，全部 dry-run 零副作用）
// ---------------------------------------------------------------------------

test('install.sh: POSIX sh 语法检查通过', () => {
  const result = spawnSync('/bin/sh', ['-n', INSTALL_SH], { encoding: 'utf8' })
  assert.equal(result.status, 0, `sh -n 失败：${result.stderr}`)
})

/* HOME 闸：`set -eu` 下 CLONE_DIR 的默认值 `${GLASSPANE_INSTALL_DIR:-$HOME/glasspane}`
 * 里，$HOME 也是**展开的一部分**，所以 HOME 未设置时 shell 在第 19 行就死了
 * （实测：`install.sh: line 19: HOME: unbound variable`，退出 1）。installer/cli.js 的
 * installGuard() 就是为这一种情况写的补救话，而 install.sh 从来走不到它——它死在委托之前。
 * 夹具是**真脚本**（INSTALL_SH），不是重写一份逻辑。 */
test('install.sh: HOME 未设置 → 人话拒绝而不是 unbound variable，dry-run 仍是拒', () => {
  const guard = installGuard({ home: '' })
  assert.equal(guard.ok, false, '前提：installer 侧这条本来就是拒绝分支')

  // 三个入口分支都验：仓库靠 cwd 定位、靠 GLASSPANE_REPO 指定、什么都没定位到（将要 clone）。
  // 闸若排在任何一处消息逻辑之后，第一条就会漏。
  const cases = [
    ['cwd 即仓库', { cwd: makeFakeRoot(), env: {} }],
    ['GLASSPANE_REPO 指定', { cwd: os.tmpdir(), env: { GLASSPANE_REPO: makeFakeRoot() } }],
    ['未定位到仓库（clone 分支）', { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-bare-home-')), env: {} }],
  ]
  for (const [label, spec] of cases) {
    const result = runInstallSh({ ...spec, drop: ['HOME'] })
    const text = `${result.stderr}\n${result.stdout}`
    assert.equal(result.status, 1, `${label}：HOME 未设置必须退出 1，实得 ${result.status}｜${text}`)
    assert.match(text, /HOME 未设置/, `${label}：要说的是 HOME 未设置这件事`)
    assert.doesNotMatch(text, /unbound variable/, `${label}：不许以 shell 的 nounset 报错收场`)
    assert.doesNotMatch(text, /\[dry-run\]/, `${label}：dry-run 不豁免这条拒绝（它拒的是路径拼不出来）`)
    assert.doesNotMatch(text, /node .*installer\/cli\.js/, `${label}：拒绝之后不得再打印委托行`)
    // 与 installer 侧同口径：两条一键入口对同一个缺失给同一句补救。
    for (const fragment of ['export HOME=/Users/', 'env -u HOME']) {
      assert.ok(guard.error.includes(fragment), `前提：installGuard 的补救里有 ${fragment}`)
      assert.ok(text.includes(fragment), `${label}：拒绝文案要带 installGuard 的补救片段「${fragment}」，实得：${text}`)
    }
  }
})

test('install.sh: HOME 设了但为空 = 与未设置同义（一样拒，且零输出零副作用）', () => {
  const result = runInstallSh({ cwd: makeFakeRoot(), env: { HOME: '' } })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /HOME 未设置/)
  assert.doesNotMatch(`${result.stderr}${result.stdout}`, /unbound variable/)
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
  // 覆盖位现在要过 scheme 白名单（finding 3）：scp 式 git@host:path 与 `ext::sh -c …`
  // 落在同一个"看不出会做什么"的形状里，所以这里用 https:// 形态演示"覆盖仍可用"。
  const result = runInstallSh({
    cwd: bare,
    env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: cloneDir, GLASSPANE_REPO_URL: 'https://example.invalid/repo.git' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[dry-run\].*git clone/)
  assert.ok(result.stdout.includes('https://example.invalid/repo.git'), 'clone URL 可被环境变量覆盖')
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

test('install.sh: GLASSPANE_REF 置空 = 钉发布 tag，与 installer 常量真的同源（两侧同测）', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-bare-ref3-'))
  const result = runInstallSh({
    cwd: bare,
    env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: path.join(bare, 'ct'), GLASSPANE_REF: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  // 旧行为：install.sh 把空值读成 main，installer/cli.js 把同一个空值读成钉住的 tag——
  // 同一条 `GLASSPANE_REF=` 在两条一键入口上拿到两份源码，而这条用例的标题写着"同源"。
  assert.ok(!/--branch main/.test(result.stdout), `空值不该再退回 main：${result.stdout}`)
  assert.ok(
    result.stdout.includes(`--branch v${RELEASE_VERSION}`),
    `install.sh 一侧空值应钉 v${RELEASE_VERSION}，实际：${result.stdout}`,
  )
  // 另一侧：同一个 env 交给 installer 的口径函数，必须给出同一个 ref。
  assert.equal(resolvePinRef({ GLASSPANE_REF: '' }), `v${RELEASE_VERSION}`, 'installer 侧空值同样钉发布 tag')
  assert.equal(resolvePinRef({ GLASSPANE_REF: '' }), resolvePinRef({}), '未设置与置空同义（两侧都是）')
  assert.equal(bootstrapPlan({ homeDir: bare, installDir: path.join(bare, 'ct'), ref: resolvePinRef({ GLASSPANE_REF: '' }) }).ref,
    `v${RELEASE_VERSION}`, 'bootstrapPlan 拿这个 ref 时也是同一个 tag')
})

test('install.sh: GLASSPANE_REF 只有空白 = 与置空同义；含内部空白仍被形状闸拒', () => {
  // 这条用例补的是"同源"那句话的另一半。上面那条测了 `GLASSPANE_REF=`，但 resolvePinRef 对值
  // 是先 trim 的，`GLASSPANE_REF='   '` 在它那里就是"没设"＝钉发布 tag；install.sh 当时没有
  // trim，同一个值走进 assert_no_option_smuggling（空白正是 ext:: 起 shell 的必要成分）被拒，
  // 退出 1。于是一条入口安静装发布版、另一条报错——两边都"有道理"，合起来不是同一份口径。
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-bare-ref4-'))
  const result = runInstallSh({
    cwd: bare,
    env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: path.join(bare, 'ct'), GLASSPANE_REF: '   ' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(
    result.stdout.includes(`--branch v${RELEASE_VERSION}`),
    `空白值该与置空同义、钉 v${RELEASE_VERSION}，实际：${result.stdout}`,
  )
  assert.equal(resolvePinRef({ GLASSPANE_REF: '   ' }), `v${RELEASE_VERSION}`, 'installer 侧同一形状同结论')
  assert.equal(resolvePinRef({ GLASSPANE_REF: '   ' }), resolvePinRef({ GLASSPANE_REF: '' }), '裁完为空即"没设"')
  // 对照：裁首尾空白不等于放宽形状闸。带内部空白的值仍是 ext:: 的形状，必须照旧被拒——
  // 没有这一条，上面的 trim 就同时可以是"把危险值裁绿"的做法。
  const smuggle = runInstallSh({
    cwd: bare,
    env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: path.join(bare, 'ct2'), GLASSPANE_REF: 'v1 x' },
  })
  assert.notEqual(smuggle.status, 0, '含内部空白的 ref 必须仍被拒')
  assert.match(`${smuggle.stderr}${smuggle.stdout}`, /含空白字符/)
  assert.ok(!/--branch v1 x/.test(smuggle.stdout), '被拒的值不许进到 clone 行')
})

test('repoMissingText: 三条路径齐全且与 install.sh 地址真源一致', () => {
  const text = repoMissingText()
  assert.ok(text.includes(INSTALL_SH_URL))
  assert.ok(text.includes(REPO_URL))
  assert.ok(text.includes('--repo'))
})
