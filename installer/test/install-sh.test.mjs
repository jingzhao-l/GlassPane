import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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
  validateGitRef,
  validateGitRepoUrl,
  cloneFailureText,
  existingCloneDecision,
  safeGitCloneArgs,
  REPO_URL,
  INSTALL_SH_URL,
  RELEASE_VERSION,
} from '../cli.js'
import './support/darwin-host.mjs'

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
  // HOME 一律给一枚沙箱：dry-run 今天不写盘，但"今天不写"不是让子进程继承开发者家目录的理由
  // ——2026-10-22 那一格就是从仓库根 + 真 HOME 跑出去，把 npm ci / tsc / swift build / launchd
  // 全做了一遍。调用点自己给的 HOME 仍然优先（spread 顺序），`drop` 也照旧删得掉它。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ish-home-'));
  try {
    const childEnv = { ...process.env, HOME: home, GLASSPANE_REPO: '', GLASSPANE_INSTALL_DRY_RUN: '1', ...env }
    for (const name of drop) delete childEnv[name]
    return spawnSync('/bin/sh', [INSTALL_SH], {
      cwd,
      encoding: 'utf8',
      env: childEnv,
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
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
  assert.match(`${smuggle.stderr}${smuggle.stdout}`, /含空白\/控制字符/)
  assert.ok(!/--branch v1 x/.test(smuggle.stdout), '被拒的值不许进到 clone 行')
})

test('repoMissingText: 三条路径齐全且与 install.sh 地址真源一致', () => {
  const text = repoMissingText()
  assert.ok(text.includes(INSTALL_SH_URL))
  assert.ok(text.includes(REPO_URL))
  assert.ok(text.includes('--repo'))
})

/* ===========================================================================
 * 2026-10-15 修复轮（installer P2 #1 / #2）
 *
 * install.sh:42-57 的注释写着 GLASSPANE_REF 的口径"与 installer/cli.js 的 resolvePinRef
 * 同源"，而形状闸那一段（旧 68-88 行）只守"以 - 开头"和"含空白"两条：cli.js 的
 * unsafeArgvValue 还拒以 "+" 开头、validateGitRef 还要求值落在
 * `^[A-Za-z0-9][A-Za-z0-9._/@+-]*$` 里。实测（HEAD 上）`GLASSPANE_REF=+bad`、`v1:2`、
 * `~x`、`%n` 在 install.sh 一路放行、原样进 `git clone --branch`，失败后再由
 * "ref 不存在或网络不可达"那句替形状问题背锅——误归因本身就是缺陷。
 *
 * 下面三条用例把"同源"这句变成可跑的判据：**逐字比对两条入口对同一个值说的话**，
 * 而不是"两边都非零退出"。夹具是真脚本 + 真 installer 函数 + 真 git 仓库。
 * ========================================================================= */

/** install.sh 的 `fail` 打的是 `错误: <那句话>`；剥掉前缀才能与 cli.js 的 error 逐字比。 */
function refusalOf(result) {
  return String(result.stderr).replace(/^错误: /, '').replace(/\n+$/, '')
}

/** 只有 clone 计划行才能证明"走到了 clone 分支"——用它做反证，避免"没出现"是因为没走到。 */
const PLANNED_CLONE = /\[dry-run\].*git clone/

test('install.sh: GLASSPANE_REF 四条形状规则与 installer 的 validateGitRef 逐字同一句（dry-run 矩阵）', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-refmatrix-'))
  const rejected = [
    ['"-" 开头（选项注入）', '--upload-pack=touch /tmp/gp-pwned-ref'],
    ['"-" 开头（短形式）', '-x'],
    ['含空白（ext:: 起 shell 的手段）', 'v1 x'],
    ['"+" 开头（强推语义）', '+bad'],
    ['"+" 开头（看着像合法 tag）', '+v1.15.1'],
    ['字符集外：工作树语法 ":"', 'v1:2'],
    ['字符集外：revision 范围 "~"', '~x'],
    ['字符集外：printf 占位 "%"（旧实现还会把它当格式串）', '%n'],
    ['字符集外：glob "*"', 'v1*branch'],
    ['字符集外：首字符不是字母/数字', '.hidden'],
  ]
  for (const [index, [rule, value]] of rejected.entries()) {
    const installer = validateGitRef(value)
    assert.equal(installer.ok, false, `前提：installer 侧必须拒 ${JSON.stringify(value)}（规则：${rule}）`)
    const result = runInstallSh({
      cwd: bare,
      env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: path.join(bare, `ct-${index}`), GLASSPANE_REF: value },
    })
    assert.equal(result.status, 1, `${rule}：install.sh 必须退出 1，实得 ${result.status}｜${result.stdout}${result.stderr}`)
    assert.equal(
      refusalOf(result),
      installer.error,
      `${rule}：同一个值，两条一键入口必须说同一句话（install.sh 声称与 installer 同源）`,
    )
    assert.doesNotMatch(result.stdout, PLANNED_CLONE, `${rule}：被拒的值不许进到 clone 计划里`)
  }
  // 四条规则里 "+" 与字符集这两条是本轮新加的：没有它们，上面那批值会一路走进 clone。
  assert.match(validateGitRef('+bad').error, /以 "\+" 开头/, '前提：installer 侧的 "+" 规则在')
  assert.match(validateGitRef('v1:2').error, /含不被接受的字符/, '前提：installer 侧的字符集规则在')
  // 对照：合法 ref 两侧都收，且 clone 计划里就是那个值（判据不能被"全拒"满足）。
  for (const value of ['main', `v${RELEASE_VERSION}`, 'refs/tags/v1.15.1', 'feature/x_y-1.0+2']) {
    assert.equal(validateGitRef(value).ok, true, `前提：installer 侧要收 ${value}`)
    const result = runInstallSh({
      cwd: bare,
      env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: path.join(bare, `ok-${value}`), GLASSPANE_REF: value },
    })
    assert.equal(result.status, 0, `${value} 是合法 ref，不该被拒：${result.stderr}`)
    assert.ok(result.stdout.includes(`--branch ${value}`), `clone 计划里必须是那个值：${result.stdout}`)
  }
})

test('install.sh: GLASSPANE_REPO_URL 的判序与句子同 validateGitRepoUrl（ext:: 不再被报成"含空白"）', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-urlmatrix-'))
  const sentinel = path.join(work, 'pwned-by-ext')
  const rejected = [
    'ext::sh -c touch ' + sentinel,
    'ext::evil',
    'git@github.com:jingzhao-l/GlassPane.git',
    '-u',
    'https://example.invalid/r git',
    // 没有 `://` 分隔符的裸 scheme 词。`${1%%://*}` 对它们返回整串，所以从前那一半
    // 恰好命中 scheme 白名单被放过，而 `validateGitRepoUrl` 拒（它比的是带分隔符的前缀）。
    // 放过的那一半是 `curl | sh`，它把值原样送进 `git clone` argv。
    'https',
    'ssh',
    'file',
    'HTTPS',
    'File',
    'http',
  ]
  for (const [index, value] of rejected.entries()) {
    const installer = validateGitRepoUrl(value)
    assert.equal(installer.ok, false, `前提：installer 侧必须拒 ${JSON.stringify(value)}`)
    const result = runInstallSh({
      cwd: work,
      env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: path.join(work, `ct-${index}`), GLASSPANE_REPO_URL: value },
    })
    assert.equal(result.status, 1, `${JSON.stringify(value)} 必须被拒：${result.stdout}${result.stderr}`)
    // 判序要紧：`ext::sh -c …` 被挡的理由是"不带 scheme 的 ext 传输会起 shell"，
    // 先撞上空白那条就把它报成"含空白/控制字符"，读者看不出真正被拒的是什么。
    assert.equal(refusalOf(result), installer.error, `两侧对同一个 URL 必须说同一句话：${JSON.stringify(value)}`)
    assert.doesNotMatch(result.stdout, PLANNED_CLONE, '被拒的 URL 不许进到 clone 计划里')
  }
  assert.equal(fs.existsSync(sentinel), false, 'sentinel 被创建了：ext:: 传输真的被执行了')
  // 对照：合法 scheme 两侧都收（file:// 是 specs 里记着的离线/镜像用法）。
  for (const value of ['ssh://git@example.invalid/x.git', 'file:///Users/dev/mirror/GlassPane.git']) {
    assert.equal(validateGitRepoUrl(value).ok, true, `前提：installer 侧要收 ${value}`)
    const result = runInstallSh({
      cwd: work,
      env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: path.join(work, 'ok-url'), GLASSPANE_REPO_URL: value },
    })
    assert.equal(result.status, 0, `${value} 是合法 scheme，不该被拒：${result.stderr}`)
    assert.ok(result.stdout.includes(value), `clone 计划里必须是那个地址：${result.stdout}`)
  }
})

/** 一棵真的本地仓库（真 init/commit/tag），给"clone 失败"那条路当地址：`--branch` 指一个
 *  不存在的分支时 git 给的是它自己的原话，不是任何安装器编出来的归因。 */
function makeLocalGitRepo(label) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `glasspane-${label}-`))
  const src = path.join(work, 'src')
  fs.mkdirSync(src, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: src, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.test')
  git('config', 'user.name', 'test')
  fs.writeFileSync(path.join(src, 'a.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'one')
  git('tag', 'v9.9.9')
  return { work, src, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) }
}

test('install.sh: clone 失败交出 git 的原话，那句归因与 cli.js 的 cloneFailureText 逐字同', () => {
  const repo = makeLocalGitRepo('clonefail')
  const missingRef = 'nope-nope'
  const cloneDir = path.join(repo.work, 'clone-target')
  try {
    // 参照跑：同一条 git 命令行、同一个目标目录，先拿到 git 自己的退出码与原话。
    // （git 在失败时会把它建的目录收掉，所以 install.sh 随后仍能看到"目标不存在"。）
    const reference = spawnSync('git', ['clone', '--branch', missingRef, '--depth', '1', '--', `file://${repo.src}`, cloneDir], {
      encoding: 'utf8',
    })
    assert.equal(reference.status, 128, `前提：真 git 对不存在的分支应退 128，实得 ${reference.status}｜${reference.stderr}`)
    assert.match(reference.stderr, /Remote branch nope-nope not found in upstream origin/, reference.stderr)
    fs.rmSync(cloneDir, { recursive: true, force: true })
    const expected = cloneFailureText({
      ref: missingRef,
      status: reference.status,
      stderr: reference.stderr,
      targetDir: cloneDir,
    })

    const result = runInstallSh({
      cwd: repo.work,
      env: {
        GLASSPANE_REPO: '',
        GLASSPANE_INSTALL_DIR: cloneDir,
        GLASSPANE_REPO_URL: `file://${repo.src}`,
        GLASSPANE_REF: missingRef,
        GLASSPANE_INSTALL_DRY_RUN: '0',
      },
    })
    assert.equal(result.status, 1, `clone 失败必须退 1：${result.stdout}\n${result.stderr}`)
    // 逐字：install.sh 那句归因 == installer 的 cloneFailureText 对同一批输入给的那几句。
    assert.equal(refusalOf(result), expected, '两侧对同一次 clone 失败必须说同一句话')
    assert.ok(result.stderr.includes(reference.stderr.trim()), 'git 的原话必须一字不改地交给读者')
    assert.match(result.stderr, /git 的原话：/, '要说"git 的原话"，不是替它总结成因')
    // 反证旧文案：把任何非零都算成"ref 不存在或网络不可达"（句号收尾的那句断言）不许再出现。
    assert.doesNotMatch(result.stderr, /不存在或网络不可达。/, '旧写法把非零退出直接算成网络/tag 问题')
    assert.match(result.stderr, /只是这份原话\*\*可能\*\*的成因之一/, '网络只作为"可能的成因之一"出现，以原话为准')
    assert.equal(fs.existsSync(cloneDir), false, '失败后不该留下半个 clone 目录')
  } finally {
    repo.cleanup()
  }
})

test('install.sh: Node 预检排在 clone 之前——低于 18 时连 clone 计划行都不出现', () => {
  const repo = makeLocalGitRepo('oldnode')
  const stubDir = path.join(repo.work, 'bin')
  fs.mkdirSync(stubDir, { recursive: true })
  // 只答真 node 的那一条版本探测（install.sh 用的正是这句 argv），其余 argv 一律按"不认识"
  // 退 64：不给不存在的能力作背书，也不替 clone/委托那一行兜底。
  fs.writeFileSync(
    path.join(stubDir, 'node'),
    [
      '#!/bin/sh',
      'if [ "$1" = "-p" ] && [ "$2" = \x27Number(process.versions.node.split(".")[0])\x27 ]; then',
      '  echo 16',
      '  exit 0',
      'fi',
      'echo "node: 这个 stub 不认的 argv: $*" >&2',
      'exit 64',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const cloneDir = path.join(repo.work, 'clone-target')
  const env = {
    GLASSPANE_REPO: '',
    GLASSPANE_INSTALL_DIR: cloneDir,
    GLASSPANE_REPO_URL: `file://${repo.src}`,
  }
  try {
    const old = runInstallSh({
      cwd: repo.work,
      env: { ...env, PATH: `${stubDir}:/usr/bin:/bin:/usr/sbin:/sbin` },
    })
    assert.equal(old.status, 1, `Node 16 必须让入口就拒，实得 ${old.status}｜${old.stdout}\n${old.stderr}`)
    assert.match(old.stderr, /Node\.js 需要 >= 18，当前主版本为 16/, old.stderr)
    // 断言的是**计划输出**，不是某个 flag：clone 那一条计划行压根不许出现。
    assert.doesNotMatch(old.stdout, PLANNED_CLONE, `Node 不够格时不该先付一次 clone：${old.stdout}`)
    assert.doesNotMatch(old.stdout, /未定位到本地仓库，clone 源码到/, '也不该先说"将要 clone"')
    assert.doesNotMatch(old.stdout, /将执行: node /, '拒绝之后不许再打印委托行')
    assert.equal(fs.existsSync(cloneDir), false, '零副作用：目标目录不该被建出来')

    // 对照：同一套 env 只把 PATH 换回真 node，clone 计划行必须出现——否则上面那条
    // "没有出现"可以由"根本没走到 clone 分支"白过，尺子就是空的。
    const control = runInstallSh({ cwd: repo.work, env })
    assert.equal(control.status, 0, `对照跑必须走到 clone 计划：${control.stderr}`)
    assert.match(control.stdout, PLANNED_CLONE, control.stdout)
    assert.match(control.stdout, /Node\.js \d+ 预检通过/, '对照跑里 Node 预检仍要说一句（它排在 clone 之前）')
    const cloneAt = control.stdout.search(PLANNED_CLONE)
    const nodeAt = control.stdout.search(/Node\.js \d+ 预检通过/)
    assert.ok(nodeAt >= 0 && nodeAt < cloneAt, `Node 预检行必须排在 clone 计划行之前（nodeAt=${nodeAt}, cloneAt=${cloneAt}）`)
  } finally {
    repo.cleanup()
  }
})

/* ===========================================================================
 * DEFECT 5（2026-10-22）— install.sh 的两个地址是**没人对照的第二份抄本**
 *
 * `installer/cli.js` 把头两行写成"真源"（REPO_URL / INSTALL_SH_URL），而 install.sh:41 的
 * 默认 clone 地址、install.sh 头里那条 curl、cli.js 里 root 补救句的第三份 curl 各写各的。
 * 现有那些用例只测**覆盖位**那条路（`GLASSPANE_REPO_URL=https://example.invalid/…`），默认
 * 值一次都没被对照过 —— 于是 org 改名之后：`npx glasspane-install` 仍然能装（它读常量），
 * `curl | sh` 却在 clone 一份 404，而那句"去掉 sudo 就重跑这条命令"的补救指着一具死链。
 * 三条用例一起把"两份必须相等而没人检查"这个类别钉住：静态抄本一条、动态默认一条、
 * 头里的职责条数一条。REVERSE MUTATION：只改 cli.js 的常量 → 三条里对应那条红；只改
 * install.sh 的默认值 → 静态与动态两条一起红；只改头里那句"只做 N 件事"或增删一条职责行 →
 * 第四条红。
 * ========================================================================= */

const CLI_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js')
const INSTALL_SH_SRC = fs.readFileSync(INSTALL_SH, 'utf8')
/** 头部注释区：到第一行 `set -eu` 为止（不是"前 40 行"那种抄本，改了脚本长度不用回来改这里）。 */
const INSTALL_SH_HEADER = INSTALL_SH_SRC.slice(0, INSTALL_SH_SRC.indexOf('\nset -eu'))

/** install.sh 那条默认值，从**赋值行本身**读出来（不是从输出猜）。 */
function defaultRepoUrlFromSource(src) {
  const m = /^REPO_URL="\$\{GLASSPANE_REPO_URL:-([^}]*)\}"/m.exec(src)
  assert.ok(m, 'install.sh 里 `REPO_URL="${GLASSPANE_REPO_URL:-…}"` 这一行的形状变了——同步改这道闸，别让它空转')
  return m[1]
}

/** install.sh 头里那条一键 curl 的 URL。 */
function headerCurlUrlFromSource(src) {
  const lines = src.split('\n').filter((line) => /^#\s+curl -fsSL (\S+) \| sh\s*$/.test(line))
  assert.equal(lines.length, 1, `头里应当恰好有一行 \`#   curl -fsSL <url> | sh\`，实得 ${JSON.stringify(lines)}`)
  return /^#\s+curl -fsSL (\S+) \| sh\s*$/.exec(lines[0])[1]
}

test('install.sh: 默认 clone 地址与头里的 curl 地址 = cli.js 的两个常量（抄本必须被对照过）', () => {
  // 前提：这两个常量本来就是两个不同的地址。否则下面两条会互相顶包——一条改了，另一条
  // 也能"相等"地绿过去。
  assert.notEqual(REPO_URL, INSTALL_SH_URL, '前提：REPO_URL 与 INSTALL_SH_URL 是两个不同的东西')
  assert.equal(defaultRepoUrlFromSource(INSTALL_SH_SRC), REPO_URL,
    `install.sh 的默认 clone 地址不再是 cli.js 的 REPO_URL 那份：实为 ${defaultRepoUrlFromSource(INSTALL_SH_SRC)}`)
  assert.equal(headerCurlUrlFromSource(INSTALL_SH_SRC), INSTALL_SH_URL,
    `install.sh 头里那条 curl 不再是 cli.js 的 INSTALL_SH_URL 那份：实为 ${headerCurlUrlFromSource(INSTALL_SH_SRC)}`)
  // 两条一键入口指的是同一处 clone：cli.js 的默认参数拼出来的 URL 与 install.sh 打印的那个
  // 必须是同一个字符串（这条把"真源"那句从注释变成判据）。
  const planned = safeGitCloneArgs({ targetDir: '/tmp/whatever' })
  assert.ok(planned.args.includes(REPO_URL), `前提：installer 侧默认 clone 的就是 REPO_URL，实得 ${JSON.stringify(planned.args)}`)
})

test('install.sh: 不设覆盖位时，clone 计划行里的地址就是那个常量（默认路径从前从没被测过）', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'glasspane-default-url-'))
  const cloneDir = path.join(bare, 'clone-target')
  // drop 而不是设空：`GLASSPANE_REPO_URL=` 会被形状闸拒（那是另一条用例的判据），
  // 这里要的是"这个覆盖位**没设**"那条默认路径。
  const result = runInstallSh({
    cwd: bare,
    env: { GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: cloneDir },
    drop: ['GLASSPANE_REPO_URL', 'GLASSPANE_REF'],
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, PLANNED_CLONE, '这一条走的就是 clone 分支，否则下面的相等是空的')
  assert.ok(result.stdout.includes(`-- ${REPO_URL} ${cloneDir}`),
    `默认 clone 的必须是 cli.js 那份 REPO_URL（紧跟在选项分隔符 -- 之后、目标目录之前），实得：${result.stdout}`)
  // 钉的是发布 tag，不是 main——同一条命令的两半都得对得上。
  assert.ok(result.stdout.includes(`--branch v${RELEASE_VERSION}`), result.stdout)
})

test('cli.js: curl 地址的字面量只许出现在常量声明那一行，root 补救那句用插值', () => {
  const src = fs.readFileSync(CLI_JS, 'utf8')
  // 只数**含该 URL 值**的行：`${INSTALL_SH_URL}` 那种插值行里出现的是标识符，不是值，
  // 所以这条计数量的正是"第二份抄本"。
  const literalLines = src.split('\n').filter((line) => line.includes(INSTALL_SH_URL))
  assert.equal(literalLines.length, 1,
    `INSTALL_SH_URL 的字面量出现在 ${literalLines.length} 行里（应当只有常量声明那一行）：`
    + `${JSON.stringify(literalLines.map((l) => l.trim()))}——多出来的那一行就是 org 改名时唯一不会被任何闸发现的复制品`)
  assert.match(literalLines[0], /^\s*'https:\/\//, `那一行应当是常量声明本身，实得：${literalLines[0].trim()}`)

  const guard = installGuard({ home: '/Users/someone', uid: 0 })
  assert.equal(guard.ok, false, '前提：uid 0 走的就是拒绝分支')
  assert.ok(guard.error.includes(`curl -fsSL ${INSTALL_SH_URL} | sh`),
    `root 的补救必须把 INSTALL_SH_URL 交给读者（那是它唯一能照做的命令），实得：${guard.error}`)
})

test('install.sh: 头里声明的职责条数与实际列出的条目一一对得上（第五件事从前躲过了所有闸）', () => {
  const stated = /只做 (\d+) 件事/.exec(INSTALL_SH_HEADER)
  assert.ok(stated, '头里必须写成「本脚本只做 N 件事」——这道闸按那句数与下面的职责行比对')
  const n = Number(stated[1])
  const listed = [...INSTALL_SH_HEADER.matchAll(/^# 职责(\d+)：/gm)].map((m) => Number(m[1]))
  assert.deepEqual(listed, Array.from({ length: n }, (_, i) => i + 1),
    `头里说 ${n} 件事，实际列出的职责行是 ${JSON.stringify(listed)}——序号必须连续 1..N，`
    + `加一条职责就把它写上并把数改对（v1.18.0 的 macOS 平台闸就是那么漏掉的）`)
  const duties = [...INSTALL_SH_HEADER.matchAll(/^# 职责\d+：(.*)$/gm)].map((m) => m[1]).join('\n')
  // 清单不能只是"条数对"，声明的每一条都得在脚本里真做。平台闸是本轮点名的那一条。
  assert.match(duties, /平台闸/, '职责清单里必须写明平台闸（只 macOS）')
  assert.match(INSTALL_SH_SRC, /\[ "\$\(uname -s\)" != "Darwin" \]/,
    '头里说有平台闸，脚本里就必须真有那条判据——两边任一边先动都是红')
  assert.match(duties, /Node 硬预检/, '职责清单里必须写明 Node 预检')
  assert.match(INSTALL_SH_SRC, /-ge 18/, '头里说有 Node 预检，脚本里就必须真有那次比较')
  assert.match(duties, /委托 installer/, '职责清单里必须写明委托 installer')
  assert.match(INSTALL_SH_SRC, /^exec node "\$REPO\/installer\/cli\.js" "\$@"$/m, '委托那一行必须真在脚本末尾')
})

/* ===========================================================================
 * 2026-10-26 · 既有 clone：干净就前进，脏就拒＋给命令
 *
 * 这一格是用户报上来的第二条：`npx` 对已存在的 `~/glasspane` 跑 `git clone` 被拒，而 `install.sh`
 * 只打印一句"既有 clone 不会被自动切到 v1.21.0"然后**照用那棵 v1.5.0 的树**去构建。两条入口当时
 * 都没问那棵树脏不脏。`advance_existing_clone` 是这个问题在 shell 这一侧的答案，判据与
 * `installer/cli.js` 的 `existingCloneDecision` 同源；下面两条分别钉"前进成立"与"脏必须拒"，
 * 第三条把两侧的动作口径对照（同一份事实，两处不许给出不同结论——本轮修的就是这种不对称）。
 *
 * REVERSE MUTATION：把 `advance_existing_clone` 的脏分支删掉 → 第二条红（别人的未提交工作被切走）；
 * 把切后复判删掉 → 第一条的 HEAD 断言红（只看 rc 的话，一条什么都不做的分支也能绿）。
 */

/** 一棵能过 `looks_like_repo` 的源仓库，带两个 tag：旧的与要装的。`shallow: false` 给一棵完整 clone。 */
function makeTaggedRepo(label, { shallow = true } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `glasspane-${label}-`))
  const src = path.join(work, 'src')
  fs.mkdirSync(path.join(src, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(src, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(src, 'engine', 'Package.swift'), '// swift-tools-version:5.9\n')
  fs.writeFileSync(path.join(src, 'mcp-shell', 'package.json'), '{}\n')
  const git = (...args) => execFileSync('git', args, { cwd: src, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.test')
  git('config', 'user.name', 'test')
  git('add', '-A')
  git('commit', '-q', '-m', 'old release')
  git('tag', 'v0.0.1-old')
  fs.writeFileSync(path.join(src, 'engine', 'Package.swift'), '// swift-tools-version:5.10\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'new release')
  git('tag', 'v9.9.9-new')
  const cloneDir = path.join(work, 'clone')
  // 两棵都从旧 tag 起，且都**没有**要装的 v9.9.9-new，但缺的原因不同：浅的那棵因为边界只取一笔，
  // 完整的那棵因为 `--single-branch` 只跟随 `v0.0.1-old` 这一个 ref（默认的全量 clone 会连
  // `refs/heads/main` 一起拉下来，那笔新提交于是可达、tag 也被 auto-follow 带进来——第一版夹具就
  // 在这里翻了车：前提"本地还没有这个 tag"根本没成立，fetch 那一支一步都没走，用例照样绿得起来）。
  const cloneArgs = ['clone', '--quiet', '--branch', 'v0.0.1-old']
  if (shallow) cloneArgs.push('--depth', '1')
  else cloneArgs.push('--single-branch')
  execFileSync('git', [...cloneArgs, `file://${src}`, cloneDir], { encoding: 'utf8' })
  const headIn = () => execFileSync('git', ['-C', cloneDir, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim()
  const tagCommit = (tag) => execFileSync('git', ['-C', src, 'rev-parse', '--verify', `${tag}^{commit}`], { encoding: 'utf8' }).trim()
  const isShallow = () => execFileSync('git', ['-C', cloneDir, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim()
  // 夹具的前提：要装的那个 tag 在**clone 里**还不存在。前提要能被测试自己问出来，
  // 不然哪天 clone 的形状变了、fetch 那一支根本不走，用例却还在绿。
  const hasTagLocal = (tag) => spawnSync('git', ['-C', cloneDir, 'rev-parse', '--verify', `${tag}^{commit}`], { encoding: 'utf8' }).status === 0
  return { work, src, cloneDir, headIn, tagCommit, isShallow, hasTagLocal, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) }
}

/** 一把只记录不干活的 node/uname：委托行不许真跑 installer，平台闸要按 macOS 走。 */
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
  return dir
}

/**
 * 一只记账的 git：把**真正执行的 argv**落进文件，再交给 `/usr/bin/git` 干活。
 * 为什么要它：脚本里那句"先 fetch 它——git -C … fetch --tags … origin …"是 say 自己拼的字符串，
 * 拿 stdout 断言"fetch 用了哪个 argv"读到的是**它说了什么**，不是**它做了什么**。
 * 2026-10-27 的变异 M9（把命令里的 `$_depth` 删掉、say 那行照打）就这样绿了过去——
 * 同一族"断言回显状态而不是指令"的账，这是第三次记。
 */
function makeGitSpy(dir) {
  const log = path.join(dir, 'git-argv.txt')
  fs.writeFileSync(path.join(dir, 'git'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${log}"`,
    'exec /usr/bin/git "$@"',
    '',
  ].join('\n'), { mode: 0o755 })
  return {
    log,
    read: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : []),
  }
}

const STUB_ENV = (bin, repo, extra = {}) => ({
  GLASSPANE_REPO: '',
  GLASSPANE_INSTALL_DIR: repo.cloneDir,
  GLASSPANE_REPO_URL: `file://${repo.src}`,
  GLASSPANE_REF: 'v9.9.9-new',
  GLASSPANE_INSTALL_DRY_RUN: '0',
  PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  ...extra,
})

test('install.sh: 既有 clone 干净时被前进到钉住的 tag，委托行用的是切完的那一棵', () => {
  const repo = makeTaggedRepo('sh-advance')
  const bin = makeStubBin(path.join(repo.work, 'bin'))
  const spy = makeGitSpy(bin)
  const calls = path.join(bin, 'calls.txt')
  const before = repo.headIn()
  try {
    assert.equal(repo.hasTagLocal('v9.9.9-new'), false, '夹具前提：浅 clone 本地没有要装的 tag')
    const result = runInstallSh({ cwd: repo.work, env: STUB_ENV(bin, repo) })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /该目录干净而在/, `要看得见"为什么切"：${result.stdout}`)
    assert.match(result.stdout, /已前进到 v9\.9\.9-new/, result.stdout)
    // 浅仓缺 tag ⇒ 这一趟的 fetch 必须**真的**带 --depth 1（它已经在边界里，多取一个 tag
    // 不必拉回整段历史）。读的是落进账里的 argv，不是脚本自己打印的那一句。
    const fetches = spy.read().filter((line) => line.includes('fetch --tags'))
    assert.deepEqual(fetches.filter((line) => /fetch --tags --depth 1 origin v9\.9\.9-new/.test(line)).length, 1,
      `浅仓的 fetch argv 要恰好一条带 --depth 1：${JSON.stringify(spy.read())}`)
    assert.equal(repo.isShallow(), 'true', '这一趟不改变深浅：浅仓前进之后还是浅仓')
    const after = repo.headIn()
    assert.notEqual(after, before, 'HEAD 真的动了——只看 rc 的话，一条什么都不做的分支也能绿')
    assert.equal(after, repo.tagCommit('v9.9.9-new'), '切到的必须正是钉住的那个 tag 指向的 commit')
    const delegated = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : ''
    assert.match(delegated, /installer\/cli\.js/, `委托行必须落到切完的那一棵：${delegated}`)
    assert.ok(delegated.includes(repo.cloneDir), `GLASSPANE_REPO 要指向前进后的目录：${delegated}`)
  } finally {
    repo.cleanup()
  }
})

test('install.sh: 前进一棵**完整** clone 时 fetch 不带 --depth——它不许把别人的历史变成浅仓', () => {
  // 2026-10-27 本机 `~/glasspane` 的真实形状：一棵完整的旧 clone，tag 表停在更早的一版。旧写法对
  // 任何树都 `fetch --tags --depth 1`，而 `--depth` 会落下 `.git/shallow`：一句"只往 .git 里加对象"
  // 掩盖了它其实给一份完整历史加了人为边界（要抹掉得 `git fetch --unshallow`）。
  const repo = makeTaggedRepo('sh-advance-full', { shallow: false })
  const bin = makeStubBin(path.join(repo.work, 'bin'))
  const spy = makeGitSpy(bin)
  const before = repo.headIn()
  try {
    assert.equal(repo.isShallow(), 'false', '夹具前提：这棵 clone 是完整的')
    assert.equal(repo.hasTagLocal('v9.9.9-new'), false, '夹具前提：要装的 tag 本地还没有，这一趟必须走 fetch 那一支')
    const result = runInstallSh({ cwd: repo.work, env: STUB_ENV(bin, repo) })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const fetches = spy.read().filter((line) => line.includes('fetch --tags'))
    assert.equal(fetches.length, 1, `只该 fetch 一次，且必须是从 argv 里数出来的：${JSON.stringify(spy.read())}`)
    assert.match(fetches[0], /fetch --tags origin v9\.9\.9-new$/,
      `完整 clone 的 fetch argv 必须不含 --depth（读的是 argv，不是脚本自己说的那句）：${fetches[0]}`)
    assert.doesNotMatch(fetches[0], /--depth/, fetches[0])
    assert.equal(repo.headIn(), repo.tagCommit('v9.9.9-new'), 'fetch 之后照样前进到钉住的 tag')
    assert.notEqual(repo.headIn(), before)
    assert.equal(repo.isShallow(), 'false', '前进之后还是完整仓：这一趟没有落下 .git/shallow')
    assert.equal(fs.existsSync(path.join(repo.cloneDir, '.git', 'shallow')), false, '边界文件本身也不许出现')
  } finally {
    repo.cleanup()
  }
})

test('install.sh: 既有 clone 是脏的时候拒绝，点名挡路的文件，且一个字都不切', () => {
  const repo = makeTaggedRepo('sh-dirty')
  const bin = makeStubBin(path.join(repo.work, 'bin'))
  const before = repo.headIn()
  fs.writeFileSync(path.join(repo.cloneDir, 'engine', 'Package.swift'), '// 别人正在改的一行\n')
  try {
    const result = runInstallSh({ cwd: repo.work, env: STUB_ENV(bin, repo) })
    assert.equal(result.status, 1, `脏树必须停下：${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /有 1 处未提交改动/, result.stdout)
    assert.match(result.stdout, /engine\/Package\.swift/, '要点名是哪一个文件挡的路')
    assert.match(result.stdout, /GLASSPANE_INSTALL_DIR=/, '要给一条做得动的路')
    assert.doesNotMatch(result.stdout, /git (stash|clean)|checkout -f/, '补救里不许出现销毁性的 git 动作')
    assert.equal(repo.headIn(), before, '拒绝这一支必须一个字都没切')
    assert.equal(fs.existsSync(callsPath(bin)), false, '停了就不该再委托：那棵树还是别人的旧版本')
  } finally {
    repo.cleanup()
  }
})

function callsPath(bin) {
  return path.join(bin, 'calls.txt')
}

test('install.sh 与 installer/cli.js 对同一份既有 clone 事实给出同一种动作（两处不许各说各话）', () => {
  // 本轮被修掉的正是这一类不对称：一条入口照用旧树、另一条被 git 拒掉。判据既然同源，就要被
  // 同一份事实问一次——形状取自 `updater/lib/launchd.js` 的 formatMode：两处各写一份，测试逐值比对。
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)
  const cases = [
    { name: '已经在钉住的 tag 上', state: { head: A, tagCommit: A, blocking: [] }, want: 'use' },
    { name: '干净而在别处', state: { head: B, tagCommit: A, blocking: [] }, want: 'advance' },
    // 本机 `~/glasspane` 那一棵（2026-10-27 实测：干净、HEAD 在 v1.5.0 之后、本地 tag 只到 v1.2.0）。
    // 旧判据在这格上是 refuse，而 refuse 之后没有人会去 fetch 那个 tag——npm 入口对旧 clone 恒拒，
    // shell 入口却能前进。两处对同一份事实给两种答案，修的就是这一类。
    { name: '干净但本地还没有那个 tag', state: { head: B, tagCommit: null, blocking: [] }, want: 'advance' },
    { name: '脏', state: { head: B, tagCommit: A, blocking: [' M engine/Package.swift'] }, want: 'refuse' },
    { name: '读不出', state: { head: null, tagCommit: null, blocking: [] }, want: 'refuse' },
  ]
  for (const one of cases) {
    const decided = existingCloneDecision({ targetDir: '/Users/x/glasspane', ref: 'v9.9.9', ...one.state }).action
    assert.equal(decided, one.want, `JS 那一侧的判据在「${one.name}」上回的是 ${decided}`)
  }
  // shell 那一侧不许有第二种"什么算脏"：它只可能问 `git status --porcelain`，且只可能用
  // detach 形态去切（没有 -f / stash / clean 的口子）。
  assert.match(INSTALL_SH_SRC, /git -C "\$_dir" status --porcelain/, 'shell 侧的"脏"必须来自同一把尺子')
  assert.match(INSTALL_SH_SRC, /git -C "\$_dir" checkout --detach "\$_ref"/, '切只能是 detach 那一形')
  assert.doesNotMatch(INSTALL_SH_SRC, /git[^\n]*(stash|clean|checkout -f|reset --hard)/, '安装脚本里不许出现销毁性的 git 动作')
  // fetch 的深浅形状由 git 自己答的那句决定，且**只有一条**带变量的命令：写两遍
  // `fetch --tags …` 就是给下一次"改一处漏一处"留的口子。
  assert.match(INSTALL_SH_SRC, /rev-parse --is-shallow-repository/, '浅不浅要问 git，不许脚本自己猜')
  assert.match(INSTALL_SH_SRC, /git -C "\$_dir" fetch --tags \$_depth origin "\$_ref"/, 'fetch 只有一条命令，argv 由 $_depth 决定')
  assert.doesNotMatch(INSTALL_SH_SRC, /fetch --tags --depth 1 origin/, '不许再有那条无条件的 --depth：它会把完整 clone 变成浅仓')
})
