import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import {
  parseArgs,
  usageText,
  nextStepsText,
  registerAutoUpdate,
  autoUpdateMissingText,
  updateGuidanceText,
  updaterTreePaths,
  installOutcome,
  LAUNCHD_LABEL,
} from '../cli.js'

/**
 * 自动更新接线（规格 2026-09-27 §5/§7）。
 *
 * 这些测试全部跑在**临时 HOME**里：`homeDir` + 注入的 `runLaunchctl` 把整条注册链
 * （plist 落盘、launchctl bootout/bootstrap）留在临时目录内，开发机的
 * `~/Library/LaunchAgents` 与 `~/.glasspane` 一个字节都不动——口径与
 * test/cli.test.mjs 的 restoreLaunchd 注入假件、updater/test/launchd.test.mjs 的
 * `run` 注入完全一致。指针与状态文件则用 updater 自己的 writer 真写盘，所以断言到
 * 的是磁盘上的 mode 与字节，不是函数的返回值。
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..')
const UPDATER_CLI = path.join(REPO_ROOT, 'updater', 'cli.js')
const INSTALLER_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'installer', 'cli.js'), 'utf8')

async function updaterLibs() {
  return {
    launchd: await import(pathToFileURL(path.join(REPO_ROOT, 'updater', 'lib', 'launchd.js')).href),
    state: await import(pathToFileURL(path.join(REPO_ROOT, 'updater', 'lib', 'state.js')).href),
    codes: await import(pathToFileURL(path.join(REPO_ROOT, 'updater', 'lib', 'codes.js')).href),
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 一份"像仓库"的假根：够 resolveProjectRoot 认出来，但不含 updater/。 */
function makeRepoRootWithoutUpdater(prefix) {
  const root = tempDir(prefix)
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(root, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(root, 'engine', 'Package.swift'), '// swift-tools-version:5.9\n')
  fs.writeFileSync(path.join(root, 'mcp-shell', 'package.json'), '{}')
  return root
}

/** 假 launchctl：只记账 + 返回可编排的退出码，绝不 exec 真命令。 */
function fakeLaunchctl({ bootstrapStatus = 0, bootstrapStderr = '' } = {}) {
  const calls = []
  const run = (bin, args) => {
    calls.push([bin, ...args])
    if (bin === 'id') return { status: 0, stdout: '501\n', stderr: '' }
    // bootout 对"本来就没加载"回 3，那是 disable 想要的状态（updater 的口径）。
    if (args[0] === 'bootout') return { status: 3, stdout: '', stderr: 'Could not find service' }
    return { status: bootstrapStatus, stdout: '', stderr: bootstrapStderr }
  }
  return { calls, run, verbs: () => calls.map((call) => call[1]) }
}

const NOW = new Date('2026-09-27T04:00:00.000Z')

/**
 * §9 的联网接缝：注册那一趟会导出系统根证书束（`security find-certificate`）并**起一个 node
 * 子进程**去探测 release 端点。单元测试不联网，所以这里换掉这两件事；返回值走的是 updater 自己
 * 的记录形状，字段一个都不省。
 */
const CA_RECORD = { status: 'ok', certs: 163, path: null, exportedAt: '2026-09-29T09:00:00.000Z', detail: null }
const CA_DEPS = {
  updaterDeps: {
    refreshCaBundle: () => CA_RECORD,
    usableCaBundle: () => ({ usable: true, certs: CA_RECORD.certs, reason: null }),
  },
}

function mode(file) {
  return fs.statSync(file).mode & 0o777
}

// ---------------------------------------------------------------------------
// §7 指针文档：字段、mode、读回
// ---------------------------------------------------------------------------

test('自动更新接线：指针落进状态根，文件 0600 / 目录 0700，且 updater 自己的 reader 读得回来', async () => {
  const home = tempDir('gp-install-pointer-')
  const lines = []
  try {
    const { launchd, state } = await updaterLibs()
    const launchctl = fakeLaunchctl()
    const result = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: REPO_ROOT,
      env: { HOME: home },
      homeDir: home,
      uid: '501',
      runLaunchctl: launchctl.run,
      now: NOW,
      say: (line) => lines.push(line),
    })
    assert.equal(result.ok, true)
    assert.equal(result.registered, true, '默认开（§5）')
    assert.equal(result.stateRoot, path.join(home, '.glasspane'))

    const pointerFile = path.join(result.stateRoot, 'update-install.json')
    assert.equal(pointerFile, result.pointerPath)
    assert.equal(mode(pointerFile), 0o600, '指针必须 0600：写它的 writer 会拒绝 mode 没落住的卷，0644 在这里就红')
    assert.equal(mode(result.stateRoot), 0o700, '状态根由 updater 的 ensurePrivateDir 建，0700；自己 mkdir 出来的 0755 在这里就红')
    const body = JSON.parse(fs.readFileSync(pointerFile, 'utf8'))
    assert.deepEqual(Object.keys(body), ['updaterCli', 'installRoot', 'agentLabel', 'registeredAt'], '§7 的四个字段，不多不少')
    assert.equal(body.updaterCli, UPDATER_CLI)
    assert.equal(body.installRoot, REPO_ROOT)
    assert.equal(body.agentLabel, launchd.AGENT_LABEL)
    assert.equal(body.registeredAt, NOW.toISOString())
    assert.ok(fs.existsSync(body.updaterCli), '指针指向的脚本必须真在（否则状态就是 installer-pointer-stale）')

    const readBack = state.readPointer(result.stateRoot)
    assert.equal(readBack.ok, true, `读回必须成功：${readBack.message ?? ''}`)
    assert.equal(readBack.pointer.updaterCli, UPDATER_CLI)

    // 注册走的是 updater 自己的 launchd 面：先 bootout 再 bootstrap，plist 落在临时 HOME。
    const plistPath = launchd.agentPlistPath({ homeDir: home })
    assert.deepEqual(launchctl.calls, [
      ['launchctl', 'bootout', `gui/501/${launchd.AGENT_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', plistPath],
    ], 'bootout 先于 bootstrap：launchd 缓存 bootstrap 时读到的定义')
    assert.equal(mode(plistPath), 0o600)
    const plist = fs.readFileSync(plistPath, 'utf8')
    assert.ok(plist.includes(UPDATER_CLI), '定时代理执行的就是指针那条 CLI（§7 一处实现）')
    assert.ok(!plist.includes('{{'), '渲染不留未替换的 token')

    const stateFile = path.join(result.stateRoot, 'update-state.json')
    assert.equal(mode(stateFile), 0o600)
    const recorded = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.equal(recorded.disabled, false)
    assert.equal(recorded.autoApply, true)
    assert.equal(recorded.history.at(-1).action, 'enable')

    assert.ok(lines.some((line) => line.includes(launchd.AGENT_LABEL)), '打印的这一步要说出注册了哪个作业')
    assert.ok(!JSON.stringify(launchctl.calls).includes(path.join(os.homedir(), 'Library')), '测试不得触碰开发机真实 ~/Library/LaunchAgents')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// §5 一键关：--no-auto-update 与环境变量必须同义
// ---------------------------------------------------------------------------

test('--no-auto-update：一次 bootstrap 都不发，状态里记 disabled=true（面板因此不是"从未检查"）', async () => {
  const home = tempDir('gp-install-off-')
  const lines = []
  try {
    const { launchd, state } = await updaterLibs()
    const launchctl = fakeLaunchctl()
    assert.equal(parseArgs([]).options.autoUpdate, true, '默认开')
    assert.equal(parseArgs(['--no-auto-update']).options.autoUpdate, false)
    assert.equal(parseArgs(['--no-auto-update']).error, null)
    assert.ok(usageText().includes('--no-auto-update'), '用法文本要认这个 flag')

    const result = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: REPO_ROOT,
      env: { HOME: home },
      homeDir: home,
      uid: '501',
      // 由 parseArgs 真算出来，免得测试与 CLI 各写一份"关掉"的含义。
      autoUpdate: parseArgs(['--no-auto-update']).options.autoUpdate,
      runLaunchctl: launchctl.run,
      now: NOW,
      say: (line) => lines.push(line),
    })
    assert.equal(result.ok, true)
    assert.equal(result.registered, false)
    assert.equal(result.reason, 'flag')
    assert.deepEqual(launchctl.verbs(), ['bootout'], '只允许 bootout（把上一轮可能残留的作业清掉），绝不 bootstrap')
    assert.equal(fs.existsSync(launchd.agentPlistPath({ homeDir: home })), false, '没有 plist')

    const stateFile = path.join(result.stateRoot, 'update-state.json')
    assert.equal(mode(stateFile), 0o600)
    const recorded = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    assert.equal(recorded.disabled, true, 'effectiveStatus 靠它判"自动更新已关闭"')
    assert.equal(recorded.status, 'disabled')
    assert.equal(recorded.autoApply, false)
    assert.equal(state.readPointer(result.stateRoot).ok, true, '指针照写：手动 check/apply 与面板仍要靠它找到 CLI')
    assert.ok(lines.some((line) => line.includes('自动更新已关闭')), `必须打印关掉了什么，实际：${lines.join(' | ')}`)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('环境变量那一位：判定权在 updater，installer 不读它；结论与 --no-auto-update 同义', async () => {
  const home = tempDir('gp-install-envoff-')
  const lines = []
  try {
    const { launchd, state, codes } = await updaterLibs()
    assert.ok(!/GLASSPANE_UPDATE_DISABLE/.test(INSTALLER_SOURCE),
      'installer 源码里不许出现这个环境变量的名字：读它是 updater 的活（§7），出现第二处读法就有两套语义')
    const launchctl = fakeLaunchctl()
    const result = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: REPO_ROOT,
      env: { HOME: home, GLASSPANE_UPDATE_DISABLE: '1' },
      homeDir: home,
      uid: '501',
      runLaunchctl: launchctl.run,
      now: NOW,
      say: (line) => lines.push(line),
    })
    assert.equal(result.registered, false, '环境变量等价于关掉：没有作业')
    assert.equal(result.reason, 'env')
    assert.deepEqual(launchctl.verbs(), ['bootout'], 'updater 先按 §7 拒绝注册，安装器再请它跑自己的 disable')
    assert.equal(fs.existsSync(launchd.agentPlistPath({ homeDir: home })), false)
    const recorded = JSON.parse(fs.readFileSync(path.join(result.stateRoot, 'update-state.json'), 'utf8'))
    assert.equal(recorded.disabled, true, '与 --no-auto-update 同义：状态里同样是 disabled=true')
    assert.equal(codes.CODES.autoDisabled, 'auto-disabled')
    assert.ok(lines.some((line) => line.includes('GLASSPANE_UPDATE_DISABLE=1')),
      '转述的必须是 updater 自己那句原话（名字由它给，不是 installer 拼的）')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 装树里没有 updater：安装照旧，指针不写，打印必须点名
// ---------------------------------------------------------------------------

test('安装树缺 updater/cli.js：不抛错（安装仍成功）、指针不写、打印的那行点名缺的文件与失去的东西', async () => {
  const root = makeRepoRootWithoutUpdater('gp-install-noupdater-')
  const home = tempDir('gp-install-noupdater-home-')
  const lines = []
  try {
    const launchctl = fakeLaunchctl()
    const result = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: root,
      env: { HOME: home },
      homeDir: home,
      uid: '501',
      runLaunchctl: launchctl.run,
      now: NOW,
      say: (line) => lines.push(line),
    })
    assert.equal(result.ok, true, '旧 checkout 不该把一次成功的安装判成失败')
    assert.equal(result.registered, false)
    assert.equal(result.state, 'missing')
    assert.equal(result.updaterCli, path.join(root, 'updater', 'cli.js'))
    assert.equal(launchctl.calls.length, 0, '一个 launchctl 调用都不许发')
    assert.equal(fs.existsSync(path.join(home, '.glasspane', 'update-install.json')), false,
      '写了就是一张指向不存在脚本的假地图（readPointer 会报 installer-pointer-stale）')
    assert.ok(lines.length > 0, '静默跳过是本仓禁止的失败形态')
    assert.ok(lines.some((line) => line.includes(path.join(root, 'updater', 'cli.js'))),
      `必须点名缺的是哪个文件（绝对路径），实际：${lines.join(' | ')}`)
    const lost = lines.join('\n')
    assert.ok(lost.includes('每日') && lost.includes('指针') && lost.includes('面板'),
      `必须说清失去什么（每日代理、指针、面板按钮），实际：${lost}`)
    // 纯函数那份文案本身也可单测：缺哪个文件就点名哪个，且不抄代理标签（第二真源）。
    const pure = autoUpdateMissingText({ updaterCli: '/some/root/updater/cli.js', rootDir: '/some/root' })
    assert.ok(pure.includes('/some/root/updater/cli.js'))
    assert.ok(!pure.includes('com.glasspane.'), '这段文案不许出现手写的作业标签')
    // 使用说明也得带上同一件事，别让告警被后面的大段文本淹没。
    const guide = nextStepsText({
      rootDir: root, socketPath: '/s.sock', guiOpened: false,
      daemon: { path: '/x/glasspaned', viaBundle: false }, update: result,
    })
    assert.ok(guide.includes(path.join(root, 'updater', 'cli.js')), '使用说明第 6 条也要点名同一处缺失')
    assert.equal(installOutcome({ verified: true, daemonExpected: true }).exitCode, 0,
      '缺 updater 不参与安装结论：结论仍由 hello 校验决定')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('半棵树（cli.js 在、lib/state.js 不在）同样是如实点名，而不是当成"没有 updater"', async () => {
  const root = makeRepoRootWithoutUpdater('gp-install-halftree-')
  const home = tempDir('gp-install-halftree-home-')
  const lines = []
  try {
    fs.mkdirSync(path.join(root, 'updater', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(root, 'updater', 'cli.js'), '')
    const result = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: root, env: { HOME: home }, homeDir: home, uid: '501',
      runLaunchctl: fakeLaunchctl().run, now: NOW, say: (line) => lines.push(line),
    })
    assert.equal(result.ok, true)
    assert.equal(result.state, 'missing')
    assert.equal(result.updaterCli, path.join(root, 'updater', 'lib', 'state.js'))
    assert.ok(lines.some((line) => line.includes(path.join(root, 'updater', 'lib', 'state.js'))),
      `缺哪个模块就点名哪个：${lines.join(' | ')}`)
    assert.deepEqual(updaterTreePaths(root).state, path.join(root, 'updater', 'lib', 'state.js'))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 幂等：重跑安装既不留两个作业，也不留指向已挪走 checkout 的旧 plist
// ---------------------------------------------------------------------------

test('重跑安装幂等：LaunchAgents 里只有一份 plist，指针与作业都改指新的 checkout', async () => {
  const home = tempDir('gp-install-idem-')
  const moved = makeRepoRootWithoutUpdater('gp-install-moved-')
  try {
    const { launchd, state } = await updaterLibs()
    // "挪了窝的 checkout"：一份新路径下的安装树（updater/ 软链过来，模块只有一份真源）。
    fs.symlinkSync(path.join(REPO_ROOT, 'updater'), path.join(moved, 'updater'), 'dir')
    const launchctl = fakeLaunchctl()
    const first = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: REPO_ROOT, env: { HOME: home }, homeDir: home, uid: '501',
      runLaunchctl: launchctl.run, now: NOW, say: () => {},
    })
    const agentsDir = path.join(home, 'Library', 'LaunchAgents')
    assert.deepEqual(fs.readdirSync(agentsDir), [`${launchd.AGENT_LABEL}.plist`])
    assert.equal(JSON.parse(fs.readFileSync(first.pointerPath, 'utf8')).updaterCli, UPDATER_CLI)

    const second = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: moved, env: { HOME: home }, homeDir: home, uid: '501',
      runLaunchctl: launchctl.run, now: new Date('2026-09-28T01:02:03.000Z'), say: () => {},
    })
    const plistPath = launchd.agentPlistPath({ homeDir: home })
    assert.deepEqual(fs.readdirSync(agentsDir), [`${launchd.AGENT_LABEL}.plist`],
      '重跑不许留下第二个作业（append/换名落盘都会在这里红）')
    assert.deepEqual(launchctl.verbs(), ['bootout', 'bootstrap', 'bootout', 'bootstrap'],
      '每轮都是 bootout 再 bootstrap：已加载的定义不换掉，新 plist 就不生效')
    assert.equal(fs.readdirSync(second.stateRoot).filter((f) => f.startsWith('update-install.json')).length, 1,
      '临时文件必须已被 rename 收掉，不留 .tmp- 残骸')

    const pointer = JSON.parse(fs.readFileSync(second.pointerPath, 'utf8'))
    assert.equal(mode(second.pointerPath), 0o600, '覆盖写之后 mode 仍是 0600（rename 会把旧目标 mode 带过来）')
    assert.equal(pointer.updaterCli, path.join(moved, 'updater', 'cli.js'), '指针是整份覆盖，不是追加')
    assert.equal(pointer.installRoot, moved)
    assert.equal(pointer.registeredAt, new Date('2026-09-28T01:02:03.000Z').toISOString())
    assert.equal(state.readPointer(second.stateRoot).ok, true)

    const plist = fs.readFileSync(plistPath, 'utf8')
    assert.ok(plist.includes(path.join(moved, 'updater', 'cli.js')), '作业必须跑新位置的那条 CLI')
    assert.ok(!plist.includes(UPDATER_CLI), '旧的、已挪走的 checkout 路径必须从作业定义里消失')
    assert.equal(JSON.parse(fs.readFileSync(path.join(second.stateRoot, 'update-state.json'), 'utf8')).disabled, false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(moved, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 标签只有一个真源；注册失败不许被说成成功
// ---------------------------------------------------------------------------

test('launchd 标签只有 updater 那一处真源：installer 源码里没有手写的更新作业名', async () => {
  const { launchd } = await updaterLibs()
  assert.ok(!INSTALLER_SOURCE.includes(launchd.AGENT_LABEL),
    `installer 里不许出现 "${launchd.AGENT_LABEL}" 这个字面量：改名时它会漂移，指针/作业名必须读自 updater`)
  assert.equal(LAUNCHD_LABEL, launchd.DAEMON_JOB_LABEL,
    'daemon 作业名在 installer 里是常量副本（它必须能脱离 updater/ 独立 import 跑 npx/旧 checkout），'
    + '所以用这条相等断言钉住：任何一边改名都红')

  const home = tempDir('gp-install-label-')
  try {
    const result = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: REPO_ROOT, env: { HOME: home }, homeDir: home, uid: '501',
      runLaunchctl: fakeLaunchctl().run, now: NOW, say: () => {},
    })
    assert.equal(result.agentLabel, launchd.AGENT_LABEL)
    assert.equal(JSON.parse(fs.readFileSync(result.pointerPath, 'utf8')).agentLabel, launchd.AGENT_LABEL)
    assert.deepEqual(fs.readdirSync(path.join(home, 'Library', 'LaunchAgents')), [`${launchd.AGENT_LABEL}.plist`])

    const guide = nextStepsText({
      rootDir: REPO_ROOT, socketPath: '/s.sock', guiOpened: false,
      daemon: { path: '/x/glasspaned', viaBundle: true }, update: result,
    })
    assert.ok(guide.includes(launchd.AGENT_LABEL), '使用说明里的作业名来自 updater 常量')
    assert.ok(guide.includes(`${launchd.DEFAULT_HOUR}:${String(launchd.DEFAULT_MINUTE).padStart(2, '0')}`),
      '时刻也只从 updater 的默认常量拼（§2 的 12:00），installer 不写第二份')
    assert.ok(guide.includes('bootout'), '卸载口径必须同时移除更新代理——只删 daemon 作业会留下一个没人看的定时作业')
    assert.ok(updateGuidanceText(null).length === 0, '没接线时不编造一段说明')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})


test('先开后关：重跑安装带 --no-auto-update 会把已注册的代理卸干净（不留僵尸作业）', async () => {
  const home = tempDir('gp-install-thenoff-')
  try {
    const { launchd } = await updaterLibs()
    const launchctl = fakeLaunchctl()
    const plistPath = launchd.agentPlistPath({ homeDir: home })
    const on = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: REPO_ROOT, env: { HOME: home }, homeDir: home, uid: '501',
      runLaunchctl: launchctl.run, now: NOW, say: () => {},
    })
    assert.equal(on.registered, true)
    assert.ok(fs.existsSync(plistPath), '前置：这一轮确实注册了')

    const off = await registerAutoUpdate({
      ...CA_DEPS,
      rootDir: REPO_ROOT, env: { HOME: home }, homeDir: home, uid: '501',
      autoUpdate: parseArgs(['--no-auto-update']).options.autoUpdate,
      runLaunchctl: launchctl.run, now: NOW, say: () => {},
    })
    assert.equal(off.registered, false)
    assert.deepEqual(launchctl.verbs(), ['bootout', 'bootstrap', 'bootout'],
      '卸载轮只 bootout 已加载的作业，不再 bootstrap 回来')
    assert.equal(fs.existsSync(plistPath), false, '定义文件必须一并删掉：只 bootout 不删 plist，下次登录又被 launchd 读回去')
    assert.deepEqual(fs.readdirSync(path.join(home, 'Library', 'LaunchAgents')), [],
      'LaunchAgents 里不能再有第二个同名文件（换个名字落盘就查不出来）')
    const recorded = JSON.parse(fs.readFileSync(path.join(off.stateRoot, 'update-state.json'), 'utf8'))
    assert.equal(recorded.disabled, true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('launchctl 拒绝 bootstrap 时抛错：自动更新注册失败不能被报成安装成功', async () => {
  const home = tempDir('gp-install-refuse-')
  try {
    const { launchd } = await updaterLibs()
    const launchctl = fakeLaunchctl({ bootstrapStatus: 5, bootstrapStderr: 'Bootstrap failed: 5: Input/output error' })
    await assert.rejects(
      () => registerAutoUpdate({
        rootDir: REPO_ROOT, env: { HOME: home }, homeDir: home, uid: '501',
        runLaunchctl: launchctl.run, now: NOW, say: () => {},
      }),
      /自动更新代理注册失败.*Bootstrap failed: 5/,
    )
    assert.equal(fs.existsSync(launchd.agentPlistPath({ homeDir: home })), false,
      'bootstrap 没成，定义文件也不能留在原地冒充已注册')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------- §9：束的态必须出现在安装口径里 */

function caDeps(record, { usable = true, withCaRoots = true } = {}) {
  return {
    updaterDeps: {
      refreshCaBundle: () => record,
      usableCaBundle: () => ({ usable, certs: usable ? record.certs : 0, reason: usable ? null : 'absent' }),
      ...(withCaRoots ? {} : { __noCaRoots: true }),
    },
  }
}

test('注册成功那行把导出的束说出来（多少张、写进了哪个变量）', async () => {
  const home = tempDir('gp-install-ca-ok-')
  try {
    const lines = []
    const launchctl = fakeLaunchctl()
    const result = await registerAutoUpdate({
      rootDir: REPO_ROOT, env: { HOME: home }, homeDir: home, uid: '501',
      runLaunchctl: launchctl.run, now: NOW, say: (line) => lines.push(line),
      ...caDeps({ ...CA_RECORD, path: `${home}/.glasspane/ca-roots.pem` }),
    })
    assert.equal(result.registered, true, result.message)
    assert.equal(result.caRoots.certs, 163)
    assert.ok(lines.some((l) => l.includes('163 张') && l.includes('NODE_EXTRA_CA_CERTS')),
      `安装日志要说清 node 被给了什么：${lines.join(' / ')}`)
    const guide = updateGuidanceText(result).join('\n')
    assert.match(guide, /163 张/)
    assert.match(guide, /八道校验/, '校验从七道变八道之后，说明文字不能再写七道')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('束导不出来时安装日志转述 updater 的原话，而不是沉默或自己编一句', async () => {
  const home = tempDir('gp-install-ca-bad-')
  try {
    const lines = []
    const launchctl = fakeLaunchctl()
    const result = await registerAutoUpdate({
      rootDir: REPO_ROOT, env: { HOME: home }, homeDir: home, uid: '501',
      runLaunchctl: launchctl.run, now: NOW, say: (line) => lines.push(line),
      ...caDeps({ status: 'unavailable', certs: 0, path: null, exportedAt: NOW.toISOString(), detail: 'no security tool' }, { usable: false }),
    })
    assert.equal(result.registered, true, '注册本身没失败：不拦截的机器不需要这份文件')
    const all = lines.join('\n')
    assert.match(all, /注意（自动更新的网络这一跳）/)
    assert.match(all, /"security" tool is not here|security/, '措辞来自 updater 的那一句（唯一作者）， installer 只转述')
    assert.match(all, /NODE_EXTRA_CA_CERTS/, 'remedy 也在同一句里')
    assert.match(updateGuidanceText(result).join('\n'), /⚠/, '后续使用说明里也得有这一条，安装日志翻上去的人才能看到')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('旧 updater 没回报束的态时，说"没有回报"而不是说"没问题"', async () => {
  const home = tempDir('gp-install-ca-none-')
  try {
    const lines = []
    const launchctl = fakeLaunchctl()
    // 一份不认识这件事的 updater：注册照做，但状态里没有任何 caRoots 记录（不是 null，是键都不在）。
    const result = await registerAutoUpdate({
      rootDir: REPO_ROOT, env: { HOME: home }, homeDir: home, uid: '501',
      runLaunchctl: launchctl.run, now: NOW, say: (line) => lines.push(line),
      ...caDeps(null, { usable: false }),
    })
    assert.equal(result.registered, true)
    assert.equal(result.caRoots, null, '"没有记录"只有一个形状：null；不许被补成一个看起来可用的默认值')
    assert.ok(lines.some((l) => l.includes('没有回报')), `缺失要读成"旧版本"，不是读成正常：${lines.join(' / ')}`)
    assert.match(lines.join('\n'), /enable/, '并给出把它补上的那一条命令')
    assert.doesNotMatch(updateGuidanceText(result).join('\n'), /163 张/, '没有记录就不许出现一句看起来像证据的数字')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * §9 的最后一环：安装到盘上的那份 plist **真把束交给了作业**。
 *
 * 为什么单独立一条：上面所有用例都把 `refreshCaBundle` / `usableCaBundle` 换成桩，
 * 于是它们证明的是"安装器说了什么"，不是"launchd 拿到了什么"。桩给的是
 * `{path: null, certs: 163}` 且**从没往盘上写过那个文件**——`plist.includes('NODE_EXTRA_CA_CERTS')`
 * 照样绿，而真实作业指向一个不存在的文件，node 只会打一句 Warning 然后照旧连不上。
 * 这是"手工造输入绕开生产层"那一类（复审 #4③）。
 *
 * 这一条不绕：真 `exportCaBundle`（只把 `security` 与探测子进程这两件外部事注入掉，
 * 不联网、不碰开发机钥匙串）→ 真 writer 落盘 → 真 `usableBundle` 读盘 → `enable` 注册
 * → 用 **python3 plistlib** 严格解析盘上那份 plist。选 plistlib 而不是 `plutil`：后者对
 * 结构问题宽容（本仓已经吃过两次"lenient 读者把缺陷藏起来"）。python3 不在场时这条会
 * **变红而不是跳过**——它要守的正是"作业真的带上了信任"，跳过等于没这条闸。
 */
test('盘上那份 plist 的 EnvironmentVariables 真带着写成功的那份束（严格解析）', async () => {
  const { spawnSync } = await import('node:child_process')
  const ca = await import(pathToFileURL(path.join(REPO_ROOT, 'updater', 'lib', 'ca-bundle.js')).href)
  const launchd = await import(pathToFileURL(path.join(REPO_ROOT, 'updater', 'lib', 'launchd.js')).href)

  const home = tempDir('gp-install-ca-')
  const stateRoot = path.join(home, '.glasspane')
  const bundlePath = path.join(stateRoot, 'ca-roots.pem')
  const pem = Array.from({ length: 3 }, (_, i) => `-----BEGIN CERTIFICATE-----\nMIIB${i}INSTALLTEST\n-----END CERTIFICATE-----\n`).join('')
  const external = []
  let securityCalls = 0
  const run = (command, args) => {
    external.push([command, ...(args ?? [])])
    if (command === 'security') {
      securityCalls += 1
      // 只有第一个钥匙串有东西：系统根与管理员根本来就是分两处装的，
      // 而张数必须等于 3 而不是 6——两份都返回同一批证书就会把重复计数写进记录。
      return { status: 0, stdout: securityCalls === 1 ? pem : '', stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }  // 探测子进程：假装这一次连上了
  }

  try {
    const launchctl = fakeLaunchctl()
    const result = await registerAutoUpdate({
      rootDir: REPO_ROOT,
      env: { HOME: home },
      homeDir: home,
      uid: '501',
      runLaunchctl: launchctl.run,
      now: NOW,
      say: () => {},
      updaterDeps: {
        refreshCaBundle: () => ca.exportCaBundle({ stateRoot, probeUrl: 'https://example.invalid/releases/latest', run }),
      },
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.registered, true)
    assert.equal(result.caRoots?.status, 'ok', `导出没成 ok，这条就退化成一次字符串检查：${JSON.stringify(result.caRoots)}`)
    assert.equal(result.caRoots.certs, 3)
    assert.equal(result.caRoots.path, bundlePath, '记录里的路径就是真写成的那一个')
    assert.equal(ca.countCertificates(fs.readFileSync(bundlePath, 'utf8')), 3, '束必须真在盘上，不是只在返回值里')

    const plistPath = launchd.agentPlistPath({ homeDir: home })
    const parsed = spawnSync('python3', ['-c',
      'import plistlib,json,sys\n'
      + 'with open(sys.argv[1], "rb") as handle:\n'
      + '    print(json.dumps(plistlib.load(handle)))\n', plistPath], { encoding: 'utf8' })
    assert.equal(parsed.status, 0, `plistlib 读不动这份 plist（它比 launchd 严）：${parsed.stderr}`)
    const job = JSON.parse(parsed.stdout)

    assert.equal(job.Label, launchd.AGENT_LABEL)
    assert.equal(job.EnvironmentVariables?.NODE_EXTRA_CA_CERTS, bundlePath,
      '§9.4：束由**作业**带进去，不是靠 updater 自己在进程里设——进程启动后才设的变量改不了任何东西')
    assert.notEqual(job.EnvironmentVariables?.NODE_EXTRA_CA_CERTS, '',
      '空串在 node 眼里等于没设；写一个空值还会把操作者从终端带进来的那份信任静默覆盖掉')
    assert.ok(fs.existsSync(String(job.EnvironmentVariables?.NODE_EXTRA_CA_CERTS ?? '')),
      '作业指过去的那个文件必须存在——这是桩版本唯一漏掉的事')
    assert.deepEqual([job.ProgramArguments[0], job.ProgramArguments[1], job.ProgramArguments[3], job.ProgramArguments[4]],
      ['/bin/sh', '-c', process.execPath, UPDATER_CLI], 'argv 槽位：shell、CLI 都在自己的参数里')
    assert.equal(job.RunAtLoad, false)
    assert.ok(!JSON.stringify(job).includes('{{'), '严格解析出来的文档里不该有未替换的 token')
    assert.deepEqual(
      external.filter((call) => call[0] === 'security').map((call) => call.slice(0, 4)),
      ca.KEYCHAIN_SOURCES.map(() => ['security', 'find-certificate', '-a', '-p']),
      '两个钥匙串各查一次，且用的是那条真参数序列',
    )
    assert.equal(external.filter((call) => call[0] === 'security').length, ca.KEYCHAIN_SOURCES.length)
    assert.ok(external.some((call) => call[0] === process.execPath),
      '探测确实起了一个 node 子进程（这里只替换它的返回值，形状与真的一条不差）')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('导不出束的那台机器：作业照样注册，但**不带**那个键（而不是带一个空值）', async () => {
  const { spawnSync } = await import('node:child_process')
  const launchd = await import(pathToFileURL(path.join(REPO_ROOT, 'updater', 'lib', 'launchd.js')).href)
  const home = tempDir('gp-install-noca-')
  try {
    const launchctl = fakeLaunchctl()
    const result = await registerAutoUpdate({
      rootDir: REPO_ROOT,
      env: { HOME: home },
      homeDir: home,
      uid: '501',
      runLaunchctl: launchctl.run,
      now: NOW,
      say: () => {},
      updaterDeps: {
        refreshCaBundle: () => ({ status: 'unavailable', certs: 0, path: null, exportedAt: NOW.toISOString(), detail: 'no security tool' }),
      },
    })
    assert.equal(result.registered, true, '导不出证书不是拒绝注册的理由——没被拦截的网络本来就不需要它')
    const plistPath = launchd.agentPlistPath({ homeDir: home })
    const got = spawnSync('python3', ['-c',
      'import plistlib,json,sys\n'
      + 'with open(sys.argv[1], "rb") as handle:\n'
      + '    print(json.dumps(plistlib.load(handle)))\n', plistPath], { encoding: 'utf8' })
    assert.equal(got.status, 0, got.stderr)
    const job = JSON.parse(got.stdout)
    assert.ok(!('NODE_EXTRA_CA_CERTS' in (job.EnvironmentVariables ?? {})),
      '这台机器没有束，就不该出现这个键；出现一个空值等于替操作者取消了他自己的信任')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
