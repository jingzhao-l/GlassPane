/**
 * 2026-10-22 —— 交付形状必须由**真正发出去的那份 tarball** 判，不是由测试自己抄的目录判。
 *
 * WHY（这不是洁癖，是本仓已经付过的一次账）。`installer/test/failure-exit.test.mjs` 的第 (4) 层
 * 把"npm 交付的形状"这样造出来：`for (const file of ['cli.js', 'package.json']) fs.copyFileSync(…)`
 * 再手搭一条符号链接。那份目录**不是** npm 会交付的东西 —— 它绕过的正是交付形状唯一的真判据：
 * `installer/package.json` 的 `files` 白名单与 `bin` 指向的那条路径之间的**一致性**。把 `cli.js`
 * 从 `files` 里删掉，或把 `bin` 指到一个不在 `files` 里的路径，手抄的夹具照旧绿（它根本没读
 * `files`），而发布的声明已经自相矛盾：`bin` 承诺的那条命令不在包自己声明的交付清单里，它只是
 * 靠 npm"强行带上 bin 目标"这条实现细节才恰好还在档内（本机 npm 11.17.0 实测，见下面
 * REVERSE MUTATION 那一条）—— 细节一变、或目标本身写错，装出来的就是一条**悬空的 bin 软链**：
 * 装得上、`npm ls` 读得到版本号、跑起来退出 0 且一个字节都不出。那正是 CHANGELOG `[1.12.3]`
 * 记下的形状 —— 这个包有 19 个版本对外等于一条不能用的命令，而真路径上的测试一路全绿。
 * `mcp-shell/test/published-artifact.test.mjs` 给另一个包做了这件事（`npm pack` → 装进干净前缀 →
 * 不带解释器直接 exec），这个包一直没做。本文件把那份闸补上。
 *
 * 跑的是真链路：`npm pack` → 把那份 .tgz 装进**临时前缀**（`--prefix`，不碰真实的 `~`、不碰真实
 * 的全局 node_modules，也不共享 `~/.npm/_cacache`）→ 直接 exec 装出来的 `glasspane-install`
 * （前面不放 `node`）→ 按文档断言退出码与**字节非空**。
 *
 * REVERSE MUTATION（每一条点自己的名，两条都在本机实测过）：
 *  · 把 `bin` 指向一个不在 `files` 里的路径（如 ./nope.js）→ 本文件六条**全红**：静态那条
 *    （目标不在 files 里）、pack 那条（档内没有它）、软链那条（它指向不存在的文件）、
 *    三条 exec（命令根本跑不起来）。
 *  · 只从 `installer/package.json` 的 `files` 里删掉 "cli.js" → 红的只有静态那条与
 *    `failure-exit.test.mjs` 第 (4) 层的两条。**这是实测出来的边界，不是笔误**：本机
 *    npm 11.17.0 的 `npm pack --dry-run` 在 `files` 与 `main` 都不含 cli.js 时仍把
 *    package/cli.js 放进档里（npm 会强行带上 `bin` 点名的文件），所以 pack/exec 两层
 *    抓不到这一种改动。把这条边界写在这里，正是为了让下一位读者不必再猜这道闸量的是什么：
 *    `files` 与 `bin` 的一致性由静态那条负责，tarball 的真实内容与能否 exec 由其余几条负责。
 *  · 把 `installer/cli.js` 入口守卫换回不比 realpath 的那版 → exec 那几条红（0 字节 / 退出 0）。
 *  · 把 `--help` 那条退出改回 `process.exit(0)` 抢退 → "最后一行必须完整"那条红。
 *  · `npm pack` 在这台机器上跑不起来时，npm 相关用例**具名跳过**并印出复现命令 —— 一条跳过的
 *    交付形状闸正是本缺陷要防的那类东西，所以这里不放宽断言，只把"没测量"这件事喊出来。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { platformRefusal } from '../cli.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const MANIFEST = path.join(PKG, 'package.json')

const SCRATCH = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-delivered-shape-'))
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

/**
 * 一份干净、且**与自己缓存绑定**的 npm 环境。两个坑都是这台机器实测到的，抄自
 * `mcp-shell/test/published-artifact.test.mjs`：① 从父 `npm test` 继承下来的 `npm_config_*` /
 * `npm_lifecycle_*` / `npm_execpath` 会让嵌套的 `npm pack` 走生命周期语义；② 共享的
 * `~/.npm/_cacache` 里一个同键文件就能让 pack 退 243 —— 一条测试不该依赖"用户的全局缓存此刻
 * 恰好干净"。HOME 也指进临时目录：这条链子不许读写真实的 `~`。
 */
const ENV = (() => {
  const env = { ...process.env, HOME: path.join(SCRATCH, 'home') }
  for (const key of Object.keys(env)) {
    if (
      /^npm_(config|lifecycle|package|init|user|loglevel)/.test(key)
      || key === 'npm_execpath'
      || key === 'npm_config'
    ) delete env[key]
  }
  fs.mkdirSync(env.HOME, { recursive: true })
  env.npm_config_cache = path.join(SCRATCH, 'npm-cache')
  env.GLASSPANE_NO_COLOR = '1'
  delete env.GLASSPANE_REPO
  delete env.GIT_CONFIG_GLOBAL
  return env
})()

function npmRun(args, cwd) {
  const res = spawnSync('npm', args, {
    cwd,
    env: ENV,
    encoding: 'utf8',
    timeout: 900_000,
    // npm 的进度写在 stderr；默认 1 MiB 截断后 spawnSync 会把 ENOBUFS 报成"安装失败"却一个字
    // 不说 —— 那正是一条误导性的红的形状。
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ? String(res.error) : null,
  }
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
/** `bin` 的两种写法（字符串＝单命令）都归一成 `{命令: 目标}`；目标按 `files` 的口径去掉 `./`。 */
function binTargets(pkg) {
  if (typeof pkg.bin === 'string') return { [pkg.name]: pkg.bin }
  return Object.fromEntries(Object.entries(pkg.bin ?? {}))
}
/** `files` 里的一条（可能是目录，也可能是一个文件）是否覆盖到 rel 这条路。 */
function fileCovers(entry, rel) {
  const e = String(entry).replace(/^\.\//, '').replace(/\/+$/, '')
  return e === rel || rel.startsWith(`${e}/`)
}
const bin = binTargets(manifest)

/* ------------------------------------------------------ 静态不变量（不需要 npm） */

test('交付形状的真源不变量：package.json 的每个 bin 目标都必须在 files 里被点名', () => {
  const entries = Object.entries(bin)
  assert.ok(entries.length > 0, `${manifest.name} 不再声明任何 bin —— 这个包对外还是一条命令吗？`)
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0,
    `${manifest.name} 的 package.json 没有用 files 点名交付内容；那时 npm 发的是**整个目录**，`
    + '这条不变量也就无处可查（files 与 bin 两份清单必须都在，且必须互相对得上）')
  for (const [command, target] of entries) {
    const rel = String(target).replace(/^\.\//, '')
    // files 允许写目录（如 `dist`），也算命中——否则这道闸会在合法的目录形态上假红，
    // 而假红的闸等于没有闸。
    const covered = manifest.files.some((entry) => fileCovers(entry, rel))
    assert.ok(covered,
      `${manifest.name} 的 bin["${command}"] 指向 ${target}，而 files 是 ${JSON.stringify(manifest.files)} —— `
      + '这条命令不在包自己声明的交付清单里。它此刻可能仍在 tarball 内，但那是 npm"强行带上 bin 目标"'
      + '的实现细节，不是这个包的决定；细节一变（或目标写错），发出去的就是一条悬空软链：装得上、'
      + 'npm ls 读得到版本号、跑起来退出 0 且零字节 —— CHANGELOG [1.12.3] 记下的那 19 个版本。')
    assert.ok(fs.existsSync(path.join(PKG, rel)),
      `bin 的目标 ${rel} 在仓库里就不存在（files 点没点名是另一问，先问它在不在树上）`)
  }
})

/* ---------------------------------------------------------------- 真链路（要 npm） */

let artifact = null
let unavailable = null

/** pack → 装进两个临时前缀（局部 `.bin/` 与全局 `bin/`）；一次做完，多条用例共用同一份产物。 */
function delivered() {
  if (unavailable !== null) return null
  if (artifact !== null) return artifact
  const which = npmRun(['--version'], SCRATCH)
  if (which.status !== 0) {
    unavailable = `npm --version 退 ${which.status}：${(which.stderr || which.stdout || which.error || '（无输出）').slice(0, 400)}`
    return null
  }
  const packed = npmRun(['pack', '--no-audit', '--fund=false', '--pack-destination', SCRATCH], PKG)
  if (packed.status !== 0) {
    unavailable = `npm pack 退 ${packed.status}（${packed.error ?? '无 spawn 错误'}）：`
      + `${(packed.stderr || packed.stdout || '（无输出）').slice(0, 600)}`
    return null
  }
  const fileName = packed.stdout.trim().split('\n').filter(Boolean).pop()
  const tarball = path.join(SCRATCH, fileName)
  if (!fileName || !fs.existsSync(tarball)) {
    unavailable = `npm pack 报了 ${JSON.stringify(fileName)}，那份文件却不在 ${SCRATCH} 里`
    return null
  }
  // 文档里给的两条一键形态都装一遍：`npm i -g` 的 `<prefix>/bin/<命令>`，与本地 `--prefix`
  // （npx 用的那一种）的 `<prefix>/node_modules/.bin/<命令>`。两条都是符号链接，层级不同，
  // 交付形状上是两件事。
  const localPrefix = path.join(SCRATCH, 'prefix-local')
  const globalPrefix = path.join(SCRATCH, 'prefix-global')
  fs.mkdirSync(localPrefix, { recursive: true })
  fs.mkdirSync(globalPrefix, { recursive: true })
  const local = npmRun(['i', '--prefix', localPrefix, '--no-audit', '--no-fund', '--prefer-offline', tarball], localPrefix)
  if (local.status !== 0) {
    unavailable = `npm i --prefix 装那份 tarball 退 ${local.status}（${local.error ?? '无 spawn 错误'}）：`
      + `${(local.stderr || local.stdout || '（无输出）').slice(0, 600)}`
    return null
  }
  const global = npmRun(['i', '-g', '--prefix', globalPrefix, '--no-audit', '--no-fund', '--prefer-offline', tarball], globalPrefix)
  if (global.status !== 0) {
    unavailable = `npm i -g --prefix 装那份 tarball 退 ${global.status}（${global.error ?? '无 spawn 错误'}）：`
      + `${(global.stderr || global.stdout || '（无输出）').slice(0, 600)}`
    return null
  }
  const packageRoot = path.join(localPrefix, 'node_modules', manifest.name)
  if (!fs.existsSync(path.join(packageRoot, 'package.json'))) {
    unavailable = `npm 报了安装成功，${packageRoot} 里却没有 package.json`
    return null
  }
  // 全局前缀的落点在 `lib/node_modules/<name>`，与局部前缀的 `node_modules/<name>` 不是同一层——
  // 两条软链各自必须解回**自己那一份**，用局部那份比全局那条会假红。
  const globalRoot = path.join(globalPrefix, 'lib', 'node_modules', manifest.name)
  if (!fs.existsSync(path.join(globalRoot, 'package.json'))) {
    unavailable = `npm i -g 报了安装成功，${globalRoot} 里却没有 package.json`
    return null
  }
  artifact = {
    fileName,
    tarball,
    packageRoot,
    localBin: path.join(localPrefix, 'node_modules', '.bin', manifest.name),
    globalBin: path.join(globalPrefix, 'bin', manifest.name),
    globalRoot,
    shapes: [
      ['npm i --prefix（npx 用的那一种）', path.join(localPrefix, 'node_modules', '.bin', manifest.name), packageRoot],
      ['npm i -g --prefix', path.join(globalPrefix, 'bin', manifest.name), globalRoot],
    ],
  }
  return artifact
}

/** 没能测量就具名跳过（不放宽断言）。返回 true 表示这一条该跳。 */
function skipUnlessMeasured(t) {
  if (artifact === null && unavailable === null) delivered()
  if (artifact !== null) return false
  t.skip(`这台机器没能测量交付形状：${unavailable}。`
    + `复现命令：cd ${PKG} && npm pack --pack-destination /tmp && npm i --prefix /tmp/gp-p <那份 .tgz>`
    + ` && /tmp/gp-p/node_modules/.bin/${manifest.name} --help —— 一条被跳过的交付形状闸正是本缺陷要防`
    + '的那类东西：它不会红，哪怕发布出去的 bin 是悬空的。')
  return true
}

/** 直接 exec 装出来的那条命令，前面不放 node —— 被测的正是这件事。 */
function execInstalled(binPath, args) {
  return spawnSync(binPath, args, {
    encoding: 'utf8',
    env: { ...ENV, PATH: `${path.dirname(process.execPath)}:${ENV.PATH}` },
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  })
}

test('npm pack 的产物里必须带着它自己承诺的那条命令', (t) => {
  if (skipUnlessMeasured(t)) return
  const res = spawnSync('tar', ['-tzf', artifact.tarball], { encoding: 'utf8', env: ENV })
  assert.equal(res.status, 0, res.stderr)
  const entries = res.stdout.split('\n').filter((line) => line !== '')
  assert.ok(entries.includes('package/package.json'), `tarball 里没有 package.json：${JSON.stringify(entries)}`)
  for (const [command, target] of Object.entries(bin)) {
    const rel = String(target).replace(/^\.\//, '')
    assert.ok(entries.includes(`package/${rel}`),
      `bin["${command}"] 指向 ${rel}，这份 .tgz 里却没有它（档内：${JSON.stringify(entries)}）——`
      + '发出去的就是一条悬空软链。files 与 bin 必须在同一份清单上，而这份清单的唯一权威是 pack 的结果。')
  }
  // `files` 点名的每一项都得真的在档内：pack 会静默丢掉不存在的项，那也是一种"没人检查"。
  for (const entry of manifest.files) {
    const rel = String(entry).replace(/^\.\//, '').replace(/\/+$/, '')
    assert.ok(entries.some((line) => line === `package/${rel}` || line.startsWith(`package/${rel}/`)),
      `files 点名了 ${rel}，pack 却没带上它：${JSON.stringify(entries)}`)
  }
  // 装进前缀的那份入口，字节必须与仓库里这一份相同——否则"测的是交付物"这句话是空的。
  const rel = String(bin[manifest.name]).replace(/^\.\//, '')
  const inRepo = fs.readFileSync(path.join(PKG, rel))
  for (const [label, root] of [['局部前缀', artifact.packageRoot], ['全局前缀', artifact.globalRoot]]) {
    const shipped = fs.readFileSync(path.join(root, rel))
    assert.ok(shipped.equals(inRepo),
      `${label}里安装出来的 ${rel} 与仓库里那份不是同一批字节（${shipped.length} vs ${inRepo.length}）——pack 装的是别的东西`)
  }
})

test('装出来的 bin 是指向包内文件的符号链接，且带 shebang 与可执行位', (t) => {
  if (skipUnlessMeasured(t)) return
  for (const [label, binPath, packageRoot] of artifact.shapes) {
    assert.ok(fs.existsSync(binPath), `${label}：装完后 ${binPath} 不存在，PATH 上没有 ${manifest.name}`)
    assert.ok(fs.lstatSync(binPath).isSymbolicLink(), `${label}：${binPath} 不是 npm 建的那条符号链接`)
    const target = fs.realpathSync(binPath)
    assert.ok(target.startsWith(fs.realpathSync(packageRoot)),
      `${label}：软链解到了它自己那一份安装包之外：${target}（应在 ${fs.realpathSync(packageRoot)} 之下）`)
    assert.match(fs.readFileSync(target, 'utf8').split('\n')[0], /^#!\/usr\/bin\/env node/,
      `${target} 丢了 shebang，bin 就没法被直接 exec`)
    // eslint-disable-next-line no-bitwise
    assert.notEqual(fs.statSync(target).mode & 0o111, 0, `${target} 没有可执行位，exec 它会 EACCES`)
  }
})

test('交付形状跑 --help：退出 0，usage 一个字节都不许少（前面不放 node）', (t) => {
  if (skipUnlessMeasured(t)) return
  const r = execInstalled(artifact.localBin, ['--help'])
  assert.equal(r.error, undefined, `exec 装出来的命令本身失败了：${r.error}`)
  assert.equal(r.status, 0, `--help 经交付形状退出 ${r.status}｜stdout=${r.stdout.length} 字节｜stderr=${r.stderr}`)
  assert.ok(r.stdout.length > 1000,
    `实到 ${r.stdout.length} 字节。0 字节 + 退出 0 就是"入口没跑"的签名（argv[1] 是链接路径，`
    + 'import.meta.url 是被指向文件的 realpath），也正是那 19 个版本对外表现的样子。')
  assert.match(r.stdout, /用法|USAGE/, r.stdout.slice(0, 200))
  assert.ok(!r.stdout.includes('\x00'), '管道上截断的典型残迹是半个多字节序列')
  assert.equal(r.stdout.slice(-1), '\n', '最后一行必须完整到达')
})

test('交付形状跑参数错误：macOS 上是文档承诺的 2，非 macOS 主机先撞平台闸（1）——两种都不是 0 字节', (t) => {
  if (skipUnlessMeasured(t)) return
  const r = execInstalled(artifact.localBin, ['--definitely-not-an-option'])
  assert.equal(r.error, undefined, String(r.error))
  // 2026-10-31：这一档的答案按主机分岔，是本轮把两条一键入口的次序定死之后的样子——
  // `entryDecision` 里平台判据排在"未知参数"之前（同一串 argv 在 install.sh 与 cli.js 上
  // 必须同答，那是 CI 的 ubuntu 格抓到的分叉）。判据只能是"按平台问哪一支该跑"，
  // 既不是把 darwin 那一支硬塞给别的主机（那是假红，CI 就是这么红的），也不是放宽成
  // "1 或 2 都算过"（那是没有闸）。两支各有一条会红的断言，共同的不变量写在最后。
  if (process.platform === 'darwin') {
    assert.equal(r.status, 2,
      `参数错误必须退出 2；实得 ${r.status}（stdout=${r.stdout.length} 字节，stderr=${r.stderr.length} 字节）`
      + '——0 字节 + 退出 0 是入口没跑的签名\nstderr: ' + r.stderr)
    assert.match(r.stderr, /参数错误/, r.stderr)
    assert.ok(r.stderr.length > 500, `参数错误后面该跟着整份 usage，实到 ${r.stderr.length} 字节`)
  } else {
    assert.equal(r.status, 1,
      `非 macOS 主机上这一串 argv 必须先答"这台机器跑不了"（1）；实得 ${r.status}`
      + `（stdout=${r.stdout.length} 字节，stderr=${r.stderr.length} 字节）\nstderr: ${r.stderr}`)
    const refusal = platformRefusal()
    assert.ok(typeof refusal === 'string' && refusal.length > 0,
      '非 darwin 上 `platformRefusal()` 必须给出一句话——它是这一支的真源')
    assert.ok(r.stderr.includes(refusal),
      `装出来的那条命令说的必须与 \`platformRefusal()\` 逐字同源，实到：${r.stderr}`)
    assert.doesNotMatch(r.stderr, /参数错误/,
      '平台闸排在用法错之前，非 mac 不该读到那一页')
  }
  assert.equal(r.stdout.length, 0,
    `拒绝走的是 stderr，stdout 不该有半个字节（按 rc 分叉的调用方会把它当结论）：实到 ${r.stdout.length}`)
  assert.ok(r.stderr.length > 100, `拒绝也要有可读的字节，实到 ${r.stderr.length}`)
  assert.equal(r.stderr.slice(-1), '\n', '最后一条必须完整')
})

test('交付形状在全局前缀（npm i -g 那一种）里同样跑得出字节', (t) => {
  if (skipUnlessMeasured(t)) return
  const r = execInstalled(artifact.globalBin, ['--help'])
  assert.equal(r.error, undefined, String(r.error))
  assert.equal(r.status, 0, `退出 ${r.status}｜${r.stderr}`)
  assert.ok(r.stdout.length > 1000, `实到 ${r.stdout.length} 字节：全局前缀那条 bin 软链没被执行`)
})

/* ------------------------------------------------------------------ 需要 URI 编码的安装路径 */

/**
 * 2026-10-27（finding C1）：这道闸问的是**装在一条需要 percent-encoding 的路径里**时两个 bin 还跑不跑。
 * 形状来自真投递，不是猜想 —— macOS 账户名可以带空格与 CJK（`/Users/John Smith`、`/Users/张三`），
 * npx 的缓存前缀也可以是这种形状，而 npm 把全局/局部前缀原样放在 `$HOME` 下。
 *
 * 缺陷本体：`installer/glasspane.js` 的入口守卫写成
 * `realpathSync(new URL(import.meta.url).pathname)`。`.pathname` **不解码**：
 * 实测 `new URL("file:///Users/John%20Smith/g.js").pathname` 仍是
 * `/Users/John%20Smith/g.js`，那条路径上没有任何文件，于是 `realpathSync` 在 **import 期**抛出
 * ENOENT，`glasspane --help`／`status`／`doctor`／`update` 每一支都带着一坨栈退出 1。
 * 同一条规则在兄弟入口 `updater/agent-entry.js` 里早已写下（`fileURLToPath` + 包裹 try），
 * 这一份是没跟上的那张脸 —— 半修比不修更糟，因为它把缺陷伪装成已经修过。
 */
let encodedArtifact = null
let encodedUnavailable = null

function deliveredEncoded() {
  if (encodedUnavailable !== null) return null
  if (encodedArtifact !== null) return encodedArtifact
  if (artifact === null && unavailable === null) delivered()
  if (artifact === null) {
    encodedUnavailable = `没拿到那份 .tgz：${unavailable ?? 'npm 链子在本机没跑起来'}`
    return null
  }
  // 空格 + CJK 两类需要编码的字符一次覆盖：只测空格会漏掉非 ASCII 那一半。
  const prefix = path.join(SCRATCH, 'prefix John Smith 家')
  fs.mkdirSync(prefix, { recursive: true })
  const installed = npmRun(
    ['i', '--prefix', prefix, '--no-audit', '--no-fund', '--prefer-offline', artifact.tarball],
    prefix,
  )
  if (installed.status !== 0) {
    encodedUnavailable = `npm i --prefix 装进带空格/CJK 的前缀退 ${installed.status}：`
      + `${(installed.stderr || installed.stdout || installed.error || '（无输出）').slice(0, 600)}`
    return null
  }
  encodedArtifact = {
    prefix,
    bins: Object.entries(bin).map(([command]) => path.join(prefix, 'node_modules', '.bin', command)),
  }
  for (const binPath of encodedArtifact.bins) {
    if (!fs.existsSync(binPath)) {
      encodedUnavailable = `装完了却读不到 ${binPath}（那前缀里没有这条命令）`
      encodedArtifact = null
      return null
    }
  }
  return encodedArtifact
}

test('两个 bin 在需要 URI 编码的安装路径里都跑得出字节（入口守卫不许在 import 期抛）', (t) => {
  if (artifact === null && unavailable === null) delivered()
  if (encodedArtifact === null && encodedUnavailable === null) deliveredEncoded()
  if (encodedArtifact === null) {
    t.skip(`这台机器没能把包装进带空格/CJK 的前缀：${encodedUnavailable}。`
      + `复现命令：cd ${PKG} && npm pack --pack-destination /tmp && npm i --prefix "/tmp/gp 家" <那份 .tgz>`
      + ' && "/tmp/gp 家/node_modules/.bin/glasspane" --help —— 一条跳过的交付形状闸不算测量。')
    return
  }
  for (const binPath of encodedArtifact.bins) {
    const command = path.basename(binPath)
    const r = execInstalled(binPath, ['--help'])
    assert.equal(r.error, undefined, `exec ${command} 本身失败了：${r.error}`)
    assert.equal(r.status, 0,
      `${command} --help 装在 ${encodedArtifact.prefix}（路径需要 percent-encoding）时退出 ${r.status}。`
      + `stdout=${r.stdout.length} 字节｜stderr 前 400 字节=${r.stderr.slice(0, 400)}——`
      + '入口守卫读 `import.meta.url` 的 `.pathname`（不解码）并在 import 期裸调 realpathSync，'
      + '这条路径上就没有那个文件，栈直接替命令答了话。')
    // 判据是"这一页是用法页"，不是一个抄来的字节数：两个 bin 的 usage 长度本来就不同
    // （`glasspane` 一条薄命令 757 字节，`glasspane-install` 3 327 字节），拿同一条下限
    // 去量两条命令会把一条合法输出判成缺陷——坏对照比没有对照更糟。
    assert.match(r.stdout, /用法/, `${command} 的 --help 第一行不是用法页：${r.stdout.slice(0, 200)}`)
    assert.ok(!r.stdout.includes('\x00'), `${command} 的输出里出现 NUL：管道被截断的残迹`)
    assert.equal(r.stdout.slice(-1), '\n', `${command} 的最后一行必须完整到达`)
    assert.ok(r.stderr.length === 0,
      `${command} --help 本该只写 stdout，实得 stderr ${r.stderr.length} 字节：${r.stderr.slice(0, 400)}`)
    if (command === 'glasspane') {
      // 薄命令这一支的签名：四个动词一个都不许少（缺一个就是 usage 被半路打断）。
      for (const verb of ['update', 'status', 'doctor', 'help']) {
        assert.match(r.stdout, new RegExp(`^\\s+${verb}\\s`, 'm'),
          `${command} 的用法页里少了动词 ${verb}（实到 ${r.stdout.length} 字节）：${r.stdout}`)
      }
    }
  }
})

test('那条守卫的判据本身：argv[1] 与包内文件不同路时必须答"不是被直接执行的"，而不是抛', () => {
  // 生产形状里有一种是**悬空的 bin 软链**（`npm uninstall -g` 被打断）。argv[1] 指向不存在的文件时
  // realpathSync 会抛；那时答案只能是"这次不是直接执行"，不能是整个模块在 import 期死掉。
  const src = fs.readFileSync(path.join(PKG, 'glasspane.js'), 'utf8')
  const guard = src.match(/function invokedAsCommand\(\)[\s\S]*?\n}/)
  assert.ok(guard, 'glasspane.js 里找不到了口守卫函数——守卫被挪去哪了？')
  assert.match(guard[0], /try\s*\{/, '守卫没有 try 包裹：任何一次 realpathSync 抛错都会替整条命令答话')
  assert.match(guard[0], /catch\s*\{[\s\S]*return false/, '不可比对必须答"不是直接执行"（false），不是继续抛')
  assert.match(guard[0], /fileURLToPath\(import\.meta\.url\)/,
    '仍从 `.pathname` 读 URL：那条路径对带空格/CJK 的安装位置永远是 percent-encoded 的、永不存在的')
  assert.doesNotMatch(guard[0], /\.pathname/, '守卫里不该再出现 .pathname')
})
