/**
 * 失败路径的退出方式（`curl | sh` 是文档里的调用形态，stdout 接的是管道）。
 *
 * 入口 `if (isMain)` 里原本有五条退出，其中四条是 `process.exit()`（参数错误 / --help /
 * --restore-launchd / 环境预检），只有 install 的 `.catch` 改成了 `process.exitCode`。
 * 截断的坏处对每一条都一样：抢在 flush 之前退，把刚写出去的 usage、预检清单、restore 判定句
 * 连根吃掉，而失败时用户能读的正是这几行。Linux runner 上这件事是这样现形的：那台机器没有
 * swift，预检拒绝**必然**走到，而原来的端到端测试却指望走到 install 的拒绝分支——
 * 一条依赖机器状态的断言，本机绿、CI 红。
 *
 * 所以这里分四层，每层都不许问"这台机器有什么"：
 *  (1) 机制——同一段大输出，`process.exit()` 是否真丢字节由本机**实测**，量不到就如实说
 *      "本机不可观测"并跳过；这条永远不是产品闸，只是存在性证明。
 *  (2) 形状——入口那一段里一个 `process.exit(` 都不许留（静态、跨平台、每个 CI 都跑）。
 *  (3) 端到端——三条在**任何**平台都走得到的拒绝路径（--help、参数错误、把 PATH 抽干净逼出
 *      环境预检拒绝），各看退出码与"已经写出去的字节一个都不许少"；真安装失败那一条要等
 *      swift 在场才可达，按前置条件跳过并说明原因。
 *  (4) 交付形状——按 `npm install -g` 落地的目录与**符号链接形式的 bin**跑一遍 --help 与
 *      参数错误；第 (3) 层用真路径，测不到用户实际敲的那条命令（见该层注释里的实测数字）。
 *
 * REVERSE MUTATION：把入口任意一条改回 `process.exit(` → 第 (2) 层红；把 --help 那条的
 * `process.exitCode = 0` 换成 `process.exit(0)`，在会出现截断的平台上第 (3) 层的 usage
 * 完整性断言一起红；把入口守卫换回不比 realpath 的那版 → 只有第 (4) 层两条红；把
 * `installer/package.json` 的 `files` 里那条 `"cli.js"` 删掉 → 第 (4) 层的夹具搭建直接红
 * （2026-10-22 起它按 manifest 的交付清单搭目录，不再抄两个写死的文件名——见该层注释）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js')

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gp-exit-${label}-`))
}

function removeRoot(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

/** 只放着 node 的一个 PATH：任何平台都据此把环境预检逼成"未通过"。 */
function barePathDir() {
  const bin = tempRoot('bin')
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  return bin
}

/* --------------------------------------------------------------- (1) 机制 */

/**
 * 本机能不能观测到截断，是要量的，不是假设。管道缓冲与调度在 macOS 与 Linux 上表现不同：
 * 实测 Linux runner 上 exit() 与 exitCode 两条都交回了全部 204,806 字节，本机 exit() 则丢。
 * 量不到时这条**声明跳过**，而不是把断言放宽成恒过——产品闸在第 (2)、(3) 层。
 */
const mechanismProbe = (() => {
  const script = (strategy) => [
    "process.stdout.write('HEAD\\n')",
    'process.stdout.write("x".repeat(200 * 1024) + "\\n")',
    strategy,
  ].join('\n')
  const run = (strategy) => spawnSync(process.execPath, ['-e', script(strategy)], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const early = run('process.exit(1)')
  const lazy = run('process.exitCode = 1')
  return { early, lazy, drop: lazy.stdout.length - early.stdout.length }
})()

test('机制：本机 exit() 与 exitCode 的字节差（量不到就声明不可观测）', (t) => {
  assert.equal(mechanismProbe.early.status, 1, mechanismProbe.early.stderr)
  assert.equal(mechanismProbe.lazy.status, 1, mechanismProbe.lazy.stderr)
  // 这一条跨平台都成立，而且是真能红的：exitCode 那趟必须交回全部字节。
  assert.equal(mechanismProbe.lazy.stdout.length, 204806,
    `process.exitCode 那趟就该把 200 KiB 全冲出去，实到 ${mechanismProbe.lazy.stdout.length}`)
  if (mechanismProbe.drop <= 0) {
    t.skip(`本机 exit() 没有丢字节（early=${mechanismProbe.early.stdout.length} / lazy=204806）`
      + '——这条存在性证明在平台上不可观测，产品闸在形状层与端到端层')
    return
  }
  assert.ok(mechanismProbe.early.stdout.length < 204806,
    `exit() 那一趟必须真的短：${mechanismProbe.early.stdout.length}`)
})

/* --------------------------------------------------------------- (2) 形状 */

test('形状：入口 no 一条退出走 process.exit()，全部交给事件循环', () => {
  const source = fs.readFileSync(CLI, 'utf8')
  const start = source.indexOf('if (isMain) {')
  assert.notEqual(start, -1, '找不到入口守卫（结构变了就来看这道闸是否还有效）')
  const entry = source.slice(start)
  // 只看代码，不看散文：注释本来就在解释 `process.exit()` 为什么不能用。
  const code = entry
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.ok(!/process\.exit\(/.test(code),
    `入口里还留着 process.exit()：${(code.match(/process\.exit\([^)]*\)/g) ?? []).join(' , ')}`)
  for (const needle of ['process.exitCode = 2', 'process.exitCode = 0', 'process.exitCode = 1',
    'process.exitCode = result.ok ? 0 : 1', 'process.exitCode = outcome.exitCode']) {
    assert.ok(code.includes(needle), `入口应有一条退出写成 ${needle}；少了它说明某条分支被删了而不是改了`)
  }
  assert.match(code, /参数错误/, '参数错误那条仍在给人话')
  assert.match(code, /环境预检未通过/, '预检拒绝那条仍在给人话')
})

/* ------------------------------------------------------------ (3) 端到端 */

/** 三条任何平台都走得到的路径：退出码 + "已写出的字节一个都不许少"。 */
function runCli(args, env = {}) {
  const home = tempRoot('home')
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, GLASSPANE_NO_COLOR: '1', ...env },
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    })
  } finally {
    removeRoot(home)
  }
}

test('端到端 --help：退出码 0，且 usage 一个字节都不许少', () => {
  const r = runCli(['--help'])
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
  const expected = r.stdout.length
  assert.ok(expected > 1000, `usage 该是有内容的一段，实到 ${expected}`)
  assert.match(r.stdout, /用法|USAGE/, r.stdout.slice(0, 200))
  assert.ok(!r.stdout.includes('\x00'), '管道上截断的典型残迹是半个多字节序列，不该出现 NUL')
  assert.equal(r.stdout.slice(-1), '\n', '被抢退的 stdout 通常断在一行中间；最后一行必须完整')
})

test('端到端 参数错误：退出码 2，stderr 与 usage 都完整到达', () => {
  const r = runCli(['--definitely-not-an-option'])
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
  assert.match(r.stderr, /参数错误/, r.stderr)
  assert.ok(r.stderr.length > 500, `参数错误后面该跟着整份 usage，实到 ${r.stderr.length} 字节`)
  assert.equal(r.stderr.slice(-1), '\n', '最后一条必须完整')
})

test('端到端 环境预检拒绝：PATH 抽干净后退出码 1，预检清单一条都不许被截掉', () => {
  const bin = barePathDir()
  try {
    const r = runCli([], { PATH: bin })
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stderr, /环境预检未通过/, 'PATH 里没有 swift/npm/git，必须走预检拒绝这一支')
    const listed = (r.stderr.match(/^ {2}- /gm) ?? []).length
    assert.ok(listed >= 1, `预检要把缺的东西逐条列出来，实到 ${listed} 条：${r.stderr}`)
    assert.match(r.stderr, /修复后重新运行即可/, '拒绝的最后一句是给下一步的，不是收尾装饰')
    assert.equal(r.stderr.slice(-1), '\n', '那句下一步必须完整到达')
  } finally {
    removeRoot(bin)
  }
})

test('端到端 真安装失败：走到 install 的拒绝分支时步骤输出不许消失', (t) => {
  // 一个"看起来像仓库、但没有构建产物"的根目录：够 install() 走到 launchd 那一步再抛。
  const root = tempRoot('repo')
  fs.mkdirSync(path.join(root, 'engine'), { recursive: true })
  fs.mkdirSync(path.join(root, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(root, 'engine', 'Package.swift'), '// swift-tools-version:5.9\n')
  fs.writeFileSync(path.join(root, 'mcp-shell', 'package.json'), '{}\n')
  try {
    const r = runCli(['--repo', root, '--skip-build', '--no-app', '--no-gui', '--no-daemon'])
    // 走到哪一支由**产品自己的回话**判定，不由测试猜机器上有什么：上一版用
    // `PATH 里有没有 swift` 当代理，GitHub 的 ubuntu runner 上它与 installer 的
    // `checkEnvironment()` 判得不一致，测试因此没跳、把预检拒绝误当成 install 拒绝打红。
    // 猜不得，就看它说什么：预检挡住就如实声明这一支本机不可达（原因带出来），
    // 因为这一支的形状已经由上一条（把 PATH 抽干净**主动**逼出预检拒绝）覆盖了。
    // 2026-10-23（缺陷 2）：这一档只认真缺席（"未找到"）。"未能确认"是探测没答话，
    // 拿它当"本机不可达"会把用例跳没——那正是本轮修掉的第二个后果。
    if (r.status === 1 && /环境预检未通过/.test(r.stderr) && /未找到/.test(r.stderr) && !/未能确认/.test(r.stderr)) {
      t.skip(`这台机器走不到 install 的拒绝分支，预检先挡了：${r.stderr.trim().slice(0, 160)}`)
      return
    }
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stderr, /安装失败/, '必须走的是 install 的拒绝分支')
    assert.match(r.stderr, /daemon 产物不存在|launchd|不存在/, r.stderr)
    assert.match(r.stdout, /项目根目录/, '失败之前已经打出去的那几步不许因为退出方式被吃掉')
    assert.ok(!/安装完成/.test(r.stdout), '失败的安装不许同时打印一句完成')
    assert.equal(r.stdout.slice(-1), '\n', 'stdout 必须停在一次完整写入的末尾')
  } finally {
    removeRoot(root)
  }
})

/* ---------------------------------- (4) npm 交付的形状：bin 是一条符号链接 */

/**
 * 上面四条端到端都用**真路径**跑 `node <CLI> …`，而用户手里那条 `glasspane-install` 不是真路径：
 * `npm install -g` 在 `<prefix>/bin/` 放的是一条相对符号链接，指向
 * `lib/node_modules/glasspane-install/cli.js`；`npx glasspane-install` 走的是 `.bin/` 下同一种链。
 * node 按 realpath 载入 ESM 入口，于是 `process.argv[1]` 是链本身、`import.meta.url` 是被指向的文件，
 * 两个字符串恒不相等。守卫若直接比这两个，整块 `if (isMain)` 一步都不走：退出码 0，stdout 与 stderr
 * 全空——README 里写着"一键安装"的命令，在 npm 与 npx 这两条**文档里给的路径**上安静地什么都不做，
 * 而真路径的测试全绿。2026-10-12 从 registry 装 1.12.1 到干净前缀实测：`--help` 0 字节 / rc 0，
 * 未知参数也是 0 字节 / rc 0（本该是 2）。
 *
 * 夹具就得长成产品交付的样子：目录布局、相对链接写法、目标文件的可执行位、bin 路径从
 * package.json 读（改了声明这条闸会跟着走，不会钉死在旧文件名上）。
 *
 * 2026-10-22 补的两件事（都不删旧断言）：从前这里抄的是**写死的两个文件名**
 * （`['cli.js','package.json']`），于是 `files` 白名单从没被读过——把 `cli.js` 从 `files`
 * 里删掉，这一层照旧绿，而真实发布的包会只剩一条悬空 bin 软链（CHANGELOG [1.12.3] 的那 19 个
 * 版本）。现在交付清单从 manifest 读，并当场要求"每个 bin 目标都在 files 里"。
 * 真正 `npm pack → 装进临时前缀 → exec` 的那道闸在
 * `installer/test/daily-20261022-delivered-shape.test.mjs`：它跑的是发布物本体，不依赖这台机器
 * 之外的东西也能跑（npm 不在时它具名跳过）。这一层保留下来是因为它**不需要 npm**，
 * 入口守卫那一类红（不比 realpath 的守卫）在没有网络/没有 npm 的机器上照样能被发现。
 *
 * REVERSE MUTATION：把入口守卫换回 `import.meta.url === pathToFileURL(process.argv[1]).href`
 * → 下面两条具名变红，而第 (3) 层那三条仍绿；这个反差正是这条闸存在的理由。
 */
function npmInstalledCli() {
  const root = tempRoot('npmprefix')
  const pkgSrc = path.dirname(CLI)
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgSrc, 'package.json'), 'utf8'))
  const binPairs = typeof manifest.bin === 'string'
    ? [[manifest.name, manifest.bin]]
    : Object.entries(manifest.bin ?? {})
  assert.ok(binPairs.length > 0, `package.json 没给 ${manifest.name} 声明 bin，这条闸就无处安放`)
  // 交付集合 = manifest 自己点名的那份，不再是测试手抄的两个名字。
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0,
    `${manifest.name} 的 package.json 没有 files 白名单：这一层就退化成"测试自己决定发什么"，`
    + '而"谁交付哪些文件"必须是包自己说的那一份')
  for (const [command, target] of binPairs) {
    const rel = String(target).replace(/^\.\//, '')
    const covered = manifest.files.some((entry) => {
      const e = String(entry).replace(/^\.\//, '').replace(/\/+$/, '')
      return e === rel || rel.startsWith(`${e}/`)
    })
    assert.ok(covered,
      `bin["${command}"] 指向 ${target}，而 files 是 ${JSON.stringify(manifest.files)} —— 这条命令不在包自己`
      + `声明的交付清单里（它此刻还在档内只是 npm 强行带上 bin 目标的实现细节）。这一层按 files 搭目录，`
      + `所以清单与声明一脱钩它就红；真发出去的形态由 daily-20261022-delivered-shape.test.mjs 那份 pack 判。`)
  }
  const binTarget = binPairs.map(([, target]) => target)[0]
  const pkgDir = path.join(root, 'lib', 'node_modules', manifest.name)
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  const ship = new Set(['package.json', ...manifest.files.map((entry) => String(entry).replace(/^\.\//, '').replace(/\/+$/, ''))])
  for (const file of ship) {
    const from = path.join(pkgSrc, file)
    assert.ok(fs.existsSync(from), `files 点名了 ${file}，仓库里却没有它——pack 会静默跳过，这一层也必须红`)
    const to = path.join(pkgDir, file)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    if (fs.statSync(from).isDirectory()) fs.cpSync(from, to, { recursive: true })
    else fs.copyFileSync(from, to)
  }
  fs.chmodSync(path.join(pkgDir, binTarget.replace(/^\.\//, '')), 0o755)
  const link = path.join(binDir, manifest.name)
  fs.symlinkSync(path.relative(binDir, path.join(pkgDir, binTarget)), link)
  // PATH 只留 node：`--help` 与参数错误两支都在环境预检之前返回，不该被这台机器有什么拖累。
  return { root, link, env: { PATH: path.dirname(process.execPath), HOME: tempRoot('home'), GLASSPANE_NO_COLOR: '1' } }
}

function runInstalled(cli, args) {
  return spawnSync(cli.link, args, { encoding: 'utf8', env: cli.env, timeout: 120_000 })
}

test('端到端 经 npm 的 bin 符号链接：--help 的 usage 一个字节都不许少', () => {
  const cli = npmInstalledCli()
  try {
    const r = runInstalled(cli, ['--help'])
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`)
    assert.ok(r.stdout.length > 1000,
      `实到 ${r.stdout.length} 字节——0 字节意味着入口守卫判成"不是直接运行"，`
      + `整块 if (isMain) 没执行（argv[1] 是链接路径，import.meta.url 是被指向文件的 realpath）：${r.stdout}`)
    assert.match(r.stdout, /用法|USAGE/, r.stdout.slice(0, 200))
    assert.equal(r.stdout.slice(-1), '\n', '最后一行必须完整')
  } finally {
    removeRoot(cli.env.HOME)
    removeRoot(cli.root)
  }
})

test('端到端 经 npm 的 bin 符号链接：未知参数仍是退出码 2 并说人话', () => {
  const cli = npmInstalledCli()
  try {
    const r = runInstalled(cli, ['--definitely-not-an-option'])
    assert.equal(r.status, 2,
      `参数错误必须退出 2；实得 ${r.status}（stdout=${r.stdout.length} 字节，stderr=${r.stderr.length} 字节）`
      + `——0 字节 + 0 退出正是入口没跑的签名\nstderr: ${r.stderr}`)
    assert.match(r.stderr, /参数错误/, r.stderr)
    assert.ok(r.stderr.length > 500, `参数错误后面该跟着整份 usage，实到 ${r.stderr.length} 字节`)
  } finally {
    removeRoot(cli.env.HOME)
    removeRoot(cli.root)
  }
})
