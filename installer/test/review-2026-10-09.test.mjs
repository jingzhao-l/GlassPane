/**
 * 2026-10-09 安装器复核的回归闸。
 *
 * 规则只有一条：**安装器不许为自己没验证过的东西报成功；它给出的每一条补救，
 * 读者必须真能跑。**
 *
 * 夹具纪律（本仓被踩过的那条）：桩必须像生产一样拒绝。
 * - `glasspaned` 桩只认 `--version`，其余参数一律 `unknown argument` + 退出码 64
 *   （engine/Sources/glasspaned/main.swift 的真实行为，DaemonVersionFlagTests 钉着）；
 * - socket 桩说的是 FrameCodec/Dispatcher 真形状的一行 JSON：
 *   `{"result":{engine,version,protocolVersion,pid,capabilities},"id":N}`，
 *   坏方法回 `{"error":{"code","message","remedy"},"id":N}`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  ALLOWED_GIT_URL_PREFIXES,
  DAEMON_EXE_NAME,
  REPO_URL,
  SHIM_PROBE_COMMANDS,
  STATE_FILE_MODE,
  bootstrapPlan,
  classifyKillResult,
  cloneFailureText,
  commandAvailable,
  confirm,
  daemonBinaryVersion,
  daemonVersionText,
  daemonVersionVerdict,
  formatMode,
  install,
  installGuard,
  installOutcome,
  launchctlBootstrap,
  nextStepsText,
  panelOpenHint,
  parseArgs,
  preflightIssues,
  resolvePinRef,
  safeGitCloneArgs,
  tagVerifyDecision,
  survivorText,
  terminatePids,
  usageText,
  validateGitRef,
  validateGitRepoUrl,
  writePrivatePlist,
} from '../cli.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'cli.js')
const INSTALL_SH = path.join(HERE, '..', '..', 'install.sh')

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gp-review-${label}-`))
}

/** 一个够 install() 定位到根的假仓库（只有结构文件，没有任何产物）。 */
function makeRepoRoot(label = 'root') {
  const root = tempDir(label)
  fs.mkdirSync(path.join(root, 'engine', '.build', 'release'), { recursive: true })
  fs.mkdirSync(path.join(root, 'mcp-shell'), { recursive: true })
  fs.writeFileSync(path.join(root, 'engine', 'Package.swift'), '// swift-tools-version:5.9\n')
  fs.writeFileSync(path.join(root, 'mcp-shell', 'package.json'), '{}\n')
  return root
}

/**
 * `glasspaned` 桩：**只认 --version**。
 * 生产对别的参数回 `glasspaned: unknown argument: …` + usage + 退出码 64
 * （见 main.swift 的 parseArguments default 分支）——上一轮 updater 的测试就是用一个
 * "对任何参数都 echo 版本号"的桩把这条读数假装出来的，桩里跑过的守卫等于没验。
 */
function fakeGlasspanedBin(dir, { version, name = DAEMON_EXE_NAME } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  const body = version === null
    ? '#!/bin/sh\nprintf \'glasspaned: unknown argument: %s\\n\' "$1" >&2\nexit 64\n'
    : [
        '#!/bin/sh',
        'want=""',
        'for a in "$@"; do',
        '  case "$a" in',
        '    --version) want=1 ;;',
        '    *) printf \'glasspaned: unknown argument: %s\\n\' "$a" >&2; exit 64 ;;',
        '  esac',
        'done',
        '[ -n "$want" ] || { printf \'glasspaned: no --version given\\n\' >&2; exit 64; }',
        `printf 'glasspaned %s\\n' '${version}'`,
      ].join('\n')
  fs.writeFileSync(file, body, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
  return file
}

/**
 * 只说真话的 hello 桩：**独立进程**里的一行 JSON 进、一行 `{"result":…,"id":N}` 出
 * （FrameCodec 的分帧 + Dispatcher.response() 的键）。坏方法按 Dispatcher 的 error 形状回，
 * 不静默吞。
 *
 * 为什么不是测试进程里的 net.createServer：安装器是 `spawnSync` 起的子进程，那一趟把测试
 * 进程的事件循环整个阻塞了，桩于是收不到请求——上一版在这里得到的永远是
 * "socket 在但没应答 hello"（no-hello），finding 1 那条真正的路径（版本不一致）根本没被走到。
 */
const HELLO_DAEMON_SOURCE = `
import net from 'node:net'
import fs from 'node:fs'
const [socketPath, version] = process.argv.slice(2)
try { fs.unlinkSync(socketPath) } catch {}
const server = net.createServer((conn) => {
  let buffer = ''
  conn.on('error', () => {})
  conn.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      let request = null
      try { request = JSON.parse(line) } catch { continue }
      if (request?.method !== 'hello') {
        conn.write(JSON.stringify({
          error: { code: 'GP_E_UNKNOWN_METHOD', message: 'unknown method', remedy: 'call hello' },
          id: request?.id ?? null,
        }) + '\\n')
        continue
      }
      conn.write(JSON.stringify({
        result: {
          engine: 'glasspaned',
          version,
          protocolVersion: '0',
          pid: process.pid,
          capabilities: ['hello'],
        },
        id: request.id ?? null,
      }) + '\\n')
    }
  })
})
server.listen(socketPath, () => process.send?.('ready'))
`

function startStaleDaemon({ socketPath, version }) {
  const dir = tempDir('hello-daemon')
  const script = path.join(dir, 'hello-daemon.mjs')
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(script, HELLO_DAEMON_SOURCE)
  const child = spawn(process.execPath, [script, socketPath, version], { stdio: 'ignore' })
  const deadline = Date.now() + 8000
  while (!fs.existsSync(socketPath) && Date.now() < deadline) {
    spawnSync('/bin/sleep', ['0.05'])
  }
  if (!fs.existsSync(socketPath)) {
    child.kill('SIGKILL')
    throw new Error(`hello 桩没能在 ${socketPath} 上监听（这个夹具自己就先坏了）`)
  }
  return {
    child,
    stop() {
      spawnSync('/bin/kill', ['-9', String(child.pid)], { encoding: 'utf8' })
      try { fs.unlinkSync(socketPath) } catch { /* 已经没了 */ }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}


function runCli(args, { env = {}, cwd } = {}) {
  const home = tempDir('home')
  try {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, HOME: home, GLASSPANE_REPO: '', GLASSPANE_REF: '', ...env },
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

/** 本机走不到安装分支时（没有 swift 的 runner）如实声明跳过，而不是把断言放宽成恒过。 */
function preflightBlocked(result) {
  return result.status === 1 && /环境预检未通过/.test(result.stderr ?? '')
}

/* ---------------------------------------------------------------------------
 * finding 1 — "verified" 必须核对**应答的那一份就是本轮装的那一份**
 * ------------------------------------------------------------------------- */

function installWithStaleDaemonFixture({ binaryVersion, helloVersion }) {
  const root = makeRepoRoot('v1-root')
  const home = tempDir('v1-home')
  const bin = fakeGlasspanedBin(path.join(root, 'engine', '.build', 'release'), { version: binaryVersion })
  return {
    root,
    home,
    bin,
    run() {
      const daemon = startStaleDaemon({
        socketPath: path.join(home, '.glasspane', 'engine.sock'),
        version: helloVersion,
      })
      try {
        return spawnSync(process.execPath, [CLI,
          '--repo', root, '--skip-build', '--no-app', '--no-gui', '--no-launchd', '--no-prompt',
        ], {
          encoding: 'utf8',
          env: { ...process.env, HOME: home, GLASSPANE_REPO: '', GLASSPANE_REF: '' },
          timeout: 120_000,
        })
      } finally {
        daemon.stop()
      }
    },
  }
}

test('finding1: 陈旧 daemon 占着 socket 时（hello 1.0.0 / 本轮产物 9.9.9）不得报安装完成', (t) => {
  const fx = installWithStaleDaemonFixture({ binaryVersion: '9.9.9', helloVersion: '1.0.0' })
  try {
    const r = fx.run()
    if (preflightBlocked(r)) { t.skip(`这台机器预检先挡了：${r.stderr.trim().slice(0, 120)}`); return }
    assert.notEqual(r.status, 0, `应答的不是本轮产物却退出 0：${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /已在监听/, '前置：走的就是"跳过启动"那一支（正是旧代码报成功的场景）')
    assert.match(r.stdout, /version=1\.0\.0/, '必须点名应答方自报的版本')
    assert.match(r.stdout, /9\.9\.9/, '必须点名本轮产物自报的版本')
    assert.match(r.stdout, /--replace-daemon/, '补救必须是读者真能跑的那条')
    assert.ok(!/安装完成（退出码 0）/.test(r.stdout), `不许打印成功结论：${r.stdout}`)
    assert.ok(!r.stdout.includes('实测校验通过'), '版本对不上时"实测校验通过"这句话不成立')
    assert.equal(installOutcome({ verified: false, daemonExpected: true }).exitCode, r.status,
      '退出码就是收尾校验结论')
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
    fs.rmSync(fx.home, { recursive: true, force: true })
  }
})

test('finding1: hello 与本轮产物版本一致时才报完成（退出码 0）', (t) => {
  const fx = installWithStaleDaemonFixture({ binaryVersion: '9.9.9', helloVersion: '9.9.9' })
  try {
    const r = fx.run()
    if (preflightBlocked(r)) { t.skip(`这台机器预检先挡了：${r.stderr.trim().slice(0, 120)}`); return }
    assert.equal(r.status, 0, `版本一致就该算通过：${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /安装完成（退出码 0）/)
    assert.match(r.stdout, /实测校验通过/)
    assert.ok(!r.stdout.includes('补救（先收拢旧实例'), `版本一致却给了版本不符的那条补救：${r.stdout}`)
    assert.ok(!r.stdout.includes('安装未完成'), r.stdout)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
    fs.rmSync(fx.home, { recursive: true, force: true })
  }
})

test('finding1: 产物读不出版本时说的是"这项检查没做成"，不是通过也不是版本不符', (t) => {
  // 1.9.0 之前的 glasspaned 根本没有 --version：真机上它就是回 unknown argument + 64。
  const dir = tempDir('v1-oldbin')
  const bin = fakeGlasspanedBin(dir, { version: null })
  try {
    const got = daemonBinaryVersion(bin)
    assert.equal(got.ok, false, '拒绝 64 的产物必须读不成')
    assert.match(got.error, /退出码 64/)
    const verdict = daemonVersionVerdict({ arrived: true, hello: { version: '1.0.0' }, binary: got })
    assert.equal(verdict.verified, false, '读不出来 ≠ 通过')
    assert.equal(verdict.kind, 'uncheckable')
    const text = daemonVersionText({
      ...verdict, socketPath: '/s.sock', daemonBin: bin, cliPath: CLI, exitCode: 1,
    })
    assert.match(text, /无法核对版本/)
    assert.match(text, /没有做成/, '必须说"检查没能做成"，而不是给出一个通过/不通过的假二元')
    assert.ok(!text.includes('安装完成'), text)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('finding1: --version 读数只认真参数；桩像生产一样拒绝 --help/--bogus', () => {
  const dir = tempDir('v1-args')
  const bin = fakeGlasspanedBin(dir, { version: '9.9.9' })
  try {
    // 夹具自己的纪律：对任何参数都 echo 版本号的桩等于没验（updater 上一轮就是这么把它假装出来的）。
    for (const arg of ['--help', '--bogus', '--version --bogus']) {
      const r = spawnSync(bin, arg.split(' '), { encoding: 'utf8' })
      assert.equal(r.status, 64, `${arg} 必须按生产口径拒（unknown argument + 64），实得 ${r.status}`)
      assert.match(r.stderr, /unknown argument/)
    }
    assert.equal(daemonBinaryVersion(bin).version, '9.9.9')
    // 只传 --version：调用方拼不出第二个参数，也就没法被"对什么都答版本号"的桩糊过去。
    const seen = []
    const got = daemonBinaryVersion(bin, { spawn: (cmd, args, opts) => {
      seen.push([cmd, args])
      assert.ok(Number.isInteger(opts?.timeout) && opts.timeout > 0,
        `探测必须带**有界**超时，否则一个卡死的产物会把整次安装挂在这里：${JSON.stringify(opts)}`)
      return spawnSync(cmd, args, opts)
    } })
    assert.equal(got.ok, true)
    assert.deepEqual(seen, [[bin, ['--version']]],
      '探测必须是恰好一次、恰好只带 --version')
    // 跑不起来的产物（不存在）说的也是"读不出来"。
    assert.equal(daemonBinaryVersion(path.join(dir, 'nope')).ok, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('finding1: hello 缺席时判据仍是 no-hello（不拿版本核对冒充握手）', () => {
  assert.equal(daemonVersionVerdict({ arrived: false, hello: null, binary: { ok: true, version: '1.9.0' } }).kind, 'no-hello')
  assert.equal(daemonVersionVerdict({ arrived: true, hello: {}, binary: { ok: true, version: '1.9.0' } }).kind, 'no-hello')
  assert.equal(daemonVersionVerdict({ arrived: true, hello: { version: '1.9.0' }, binary: { ok: true, version: '1.9.0' } }).verified, true)
  assert.equal(daemonVersionVerdict({ arrived: true, hello: { version: '1.0.0' }, binary: { ok: true, version: '1.9.0' } }).kind, 'mismatch')
})

/* ---------------------------------------------------------------------------
 * finding 2 — 签名**对不上**是硬拒，不是黄字
 * ------------------------------------------------------------------------- */

test('finding2: 硬拒文案点名 tag、公钥与该看的地方（纯函数）', () => {
  // 合并时这一档的实现取上游那份（`tagVerifyDecision`：三档判据 + 单一出口），
  // 本轮多出来的三条信息（用的是哪把钥匙、git 的一手原话、该看哪儿）并进它的文案。
  const verdict = tagVerifyDecision({
    sig: {
      status: 'invalid',
      detail: 'git verify-tag 失败（退出码 1），签名无法确证',
      raw: "gpg: BAD signature from 'jingzhao-l'",
    },
    pinRef: 'v1.9.0',
    repoDir: '/Users/dev/glasspane',
  })
  assert.equal(verdict.action, 'refuse')
  const text = verdict.text
  assert.match(text, /v1\.9\.0/, '点名是哪个 tag')
  assert.match(text, /BAD signature/, '把 git/gpg 的一手原话交出来')
  assert.match(text, /0929EA31DF4F7429F63FC53189D88B1D043A1298/, '点名用的是哪把钥匙')
  assert.match(text, /SECURITY\.md/, '告诉读者该看哪里')
  assert.ok(!text.includes('继续安装'), '硬拒里没有"继续"这条路')
})

test('finding2: 别人签的同名 tag → install() 硬拒，且拒绝发生在任何写入之前', async (t) => {
  const gpg = spawnSync('gpg', ['--version'], { stdio: 'ignore' })
  const git = spawnSync('git', ['--version'], { stdio: 'ignore' })
  if (gpg.status !== 0 || git.status !== 0) { t.skip('这一条要 gpg + git（verify-tag 走的是真验签）'); return }
  const gnupg = tempDir('v2-gnupg')
  const root = makeRepoRoot('v2-repo')
  const home = tempDir('v2-home')
  fs.chmodSync(gnupg, 0o700)
  try {
    // 造一个"带签名而验不过"的 tag：用一把临时 key 签，安装器手里只有内置发布公钥。
    const gen = spawnSync('gpg', ['--homedir', gnupg, '--batch', '--pinentry-mode', 'loopback',
      '--passphrase', '', '--quick-generate-key', 'Impostor <i@i.local>', 'ed25519', 'sign', 'never'], { encoding: 'utf8' })
    assert.equal(gen.status, 0, gen.stderr)
    const fpr = spawnSync('gpg', ['--homedir', gnupg, '--batch', '--list-keys', '--with-colons', 'i@i.local'], { encoding: 'utf8' })
      .stdout.split('\n').find((l) => l.startsWith('fpr:'))?.split(':')[9]
    assert.ok(fpr, '拿不到临时 key 的指纹')
    const gitRun = (args) => spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GNUPGHOME: gnupg },
    })
    gitRun(['init', '-q'])
    gitRun(['config', 'user.email', 'i@i.local'])
    gitRun(['config', 'user.name', 'impostor'])
    gitRun(['config', 'user.signingkey', fpr])
    gitRun(['config', 'commit.gpgsign', 'false'])
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'x\n')
    gitRun(['add', 'tracked.txt'])
    gitRun(['commit', '-qm', 'init'])
    const tag = gitRun(['tag', '-s', '-m', 'signed by someone else', 'v1.9.0'])
    assert.equal(tag.status, 0, `${tag.stdout}\n${tag.stderr}`)

    const options = { ...parseArgs([]).options, repoDir: root, skipBuild: true, app: false, gui: false, daemon: false, launchd: false, prompt: false }
    await assert.rejects(
      install({ options, env: { HOME: home, GLASSPANE_REPO: '', GLASSPANE_REF: 'v1.9.0' }, uid: 501 }),
      (error) => {
        assert.match(error.message, /拒绝安装|硬拒/, error.message)
        assert.match(error.message, /v1\.9\.0/, error.message)
        assert.match(error.message, /0929EA31DF4F7429F63FC53189D88B1D043A1298/, error.message)
        assert.match(error.message, /SECURITY\.md/, error.message)
        return true
      },
      'tag 带签名而验不过必须硬拒（SECURITY.md：任何同意都不覆盖）',
    )
    assert.equal(fs.existsSync(path.join(home, '.glasspane')), false,
      '拒绝必须发生在 ensureLogDir 之前：什么都没写才算"没继续安装"')
  } finally {
    for (const dir of [gnupg, root, home]) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('finding2: 未签名（unsigned）仍按文档口径继续，不硬拒', () => {
  // 这一条钉住"三档分得开"：unsigned 是作者身份无从确证，不是被证伪。
  const say = (status) => tagVerifyDecision({
    sig: { status, detail: 'd' }, pinRef: 'v1.9.0', repoDir: '/Users/dev/glasspane',
  })
  assert.equal(say('invalid').action, 'refuse', '签名对不上必须停下')
  assert.equal(say('unsigned').action, 'warn', '没签名只是缺那一层证明，不是被证伪')
  assert.equal(say('unavailable').action, 'warn', '没有 gpg 同样是"这一档测不了"，不是"验不过"')
  assert.match(say('unsigned').text, /继续安装/, '告警那句要明说自己放行')
  assert.ok(!say('invalid').text.includes('继续安装'), '硬拒的文案里不许出现放行')
  // 一个不认识的新判据不得默默退回"没签名"那一档（上游那份的第四支，本轮保住它）
  assert.equal(say('whatever-comes-next').action, 'refuse')
  const source = fs.readFileSync(CLI, 'utf8')
  assert.match(source, /verdict\.action === 'refuse'\) throw new Error\(verdict\.text/,
    'install() 只有一个出口：判到 refuse 就 throw')
})

/* ---------------------------------------------------------------------------
 * finding 3 — 覆盖位进 git argv 之前的形状闸
 * ------------------------------------------------------------------------- */

test('finding3: ext:: 与以 - 开头的 ref 被拒，位置参数前有 --', () => {
  const evil = safeGitCloneArgs({ repoUrl: 'ext::sh -c touch /tmp/pwn', ref: 'v1.9.0', targetDir: '/tmp/x' })
  assert.match(evil.error, /scheme|前缀/, evil.error)
  assert.equal(evil.args, undefined)
  assert.match(evil.error, /https:\/\//, '拒绝里要给可用形态')
  assert.match(validateGitRef('--upload-pack=touch /tmp/pwn2').error, /以 "-" 开头|当成.*选项/)
  assert.match(validateGitRepoUrl('git@github.com:x/y.git').error, /ssh:\/\//, 'scp 式要指到 ssh:// 写法')
  assert.match(validateGitRepoUrl('-u').error, /以 "-" 开头/)
  assert.match(safeGitCloneArgs({ repoUrl: REPO_URL, ref: 'main', targetDir: '-x' }).error, /目标目录/)
  const ok = safeGitCloneArgs({ repoUrl: REPO_URL, ref: 'v1.9.0', targetDir: '/tmp/x' })
  assert.deepEqual(ok.args, ['clone', '--branch', 'v1.9.0', '--depth', '1', '--', REPO_URL, '/tmp/x'])
  assert.ok(ALLOWED_GIT_URL_PREFIXES.includes('https://'))
  assert.ok(ALLOWED_GIT_URL_PREFIXES.includes('file://'), '离线/镜像 clone 的路子得留着，但必须是带 scheme 的写法')
  assert.match(bootstrapPlan({ homeDir: '/Users/dev', repoUrl: 'ext::sh -c evil' }).error, /GLASSPANE_REPO_URL/)
})

test('finding3: install.sh 里 GLASSPANE_REPO_URL=ext::sh -c … 既不执行也不落盘', () => {
  const work = tempDir('sh-inject')
  const sentinel = path.join(work, 'pwned-by-ext')
  const cloneDir = path.join(work, 'clone-target')
  const runSh = (env) => spawnSync('/bin/sh', [INSTALL_SH], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: cloneDir, GLASSPANE_INSTALL_DRY_RUN: '0', ...env },
  })
  try {
    const r = runSh({ GLASSPANE_REPO_URL: `ext::sh -c touch ${sentinel}` })
    assert.notEqual(r.status, 0, `注入成功（退出码 0）：${r.stdout}\n${r.stderr}`)
    assert.equal(fs.existsSync(sentinel), false, 'sentinel 文件被创建了：clone 时执行了任意命令')
    assert.match(r.stderr, /GLASSPANE_REPO_URL/, r.stderr)
    assert.equal(fs.existsSync(cloneDir), false, '拒绝之后不该留下半个 clone')

    // 同样的形状走 dry-run 也要拒绝（CI 靠 dry-run 读这条）。
    const dry = spawnSync('/bin/sh', [INSTALL_SH], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, GLASSPANE_REPO: '', GLASSPANE_INSTALL_DIR: cloneDir, GLASSPANE_INSTALL_DRY_RUN: '1', GLASSPANE_REPO_URL: 'ext::evil' },
    })
    assert.notEqual(dry.status, 0, dry.stdout + dry.stderr)
    assert.match(dry.stderr, /GLASSPANE_REPO_URL/, dry.stderr)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

test('finding3: 以 - 开头的 GLASSPANE_REF（--upload-pack=…）同样被拒', () => {
  const work = tempDir('sh-ref')
  const sentinel = path.join(work, 'pwned-by-ref')
  try {
    const r = spawnSync('/bin/sh', [INSTALL_SH], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        GLASSPANE_REPO: '',
        GLASSPANE_INSTALL_DIR: path.join(work, 'clone-target'),
        GLASSPANE_INSTALL_DRY_RUN: '0',
        GLASSPANE_REF: `--upload-pack=touch ${sentinel}`,
      },
    })
    assert.notEqual(r.status, 0, `ref 注入成功：${r.stdout}\n${r.stderr}`)
    assert.equal(fs.existsSync(sentinel), false, 'ref 被当成 git 选项执行了')
    assert.match(r.stderr, /GLASSPANE_REF|以 '-' 开头/, r.stderr)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * finding 4 — HOME 与 uid 0
 * ------------------------------------------------------------------------- */

test('finding4: HOME 缺失/相对 与 uid 0 三条拒绝各自给人能跑的话', () => {
  const noHome = installGuard({ home: '', uid: 501 })
  assert.equal(noHome.ok, false)
  assert.match(noHome.error, /HOME/, noHome.error)
  assert.match(noHome.error, /补救/, '拒绝必须带补救')
  const rel = installGuard({ home: path.join('.glasspane-home'), uid: 501 })
  assert.equal(rel.ok, false)
  assert.match(rel.error, /绝对路径/, rel.error)
  const root = installGuard({ home: '/Users/dev', uid: 0 })
  assert.equal(root.ok, false)
  assert.match(installGuard({ home: '/Users/dev', uid: 0 }).error, /sudo|root/, root.error)
  assert.equal(installGuard({ home: '/Users/dev', uid: 501 }).ok, true)
  assert.equal(installGuard({ home: '/Users/dev', uid: null }).ok, true, '读不到 uid 时不编一个 0 出来')
})

test('finding4: 注入 uid=0 → install() 拒绝且不往 HOME 写任何东西', async () => {
  const home = tempDir('v4-home')
  const root = makeRepoRoot('v4-root')
  try {
    const options = { ...parseArgs([]).options, repoDir: root, skipBuild: true, app: false, gui: false, daemon: false, launchd: false, prompt: false }
    await assert.rejects(
      install({ options, env: { HOME: home, GLASSPANE_REPO: '' }, uid: 0 }),
      (error) => { assert.match(error.message, /sudo|root|uid 0/); return true },
    )
    assert.deepEqual(fs.readdirSync(home), [], '拒绝后 HOME 里不该有 .glasspane / Library 这些产物')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('finding4: HOME 未设置时子进程拒绝，且当前目录里没长出 .glasspane', (t) => {
  const cwd = tempDir('v4-cwd')
  try {
    const env = { ...process.env }
    delete env.HOME
    const r = spawnSync(process.execPath, [CLI, '--repo', makeRepoRoot('v4-root2'), '--skip-build', '--no-app', '--no-gui', '--no-launchd', '--no-prompt'], {
      cwd, env: { ...env, GLASSPANE_REPO: '' }, encoding: 'utf8', timeout: 60_000,
    })
    if (preflightBlocked(r)) { t.skip('这台机器预检先挡了，走不到 HOME 闸'); return }
    assert.equal(r.status, 1, `stdout:${r.stdout}\nstderr:${r.stderr}`)
    assert.match(r.stderr, /HOME/, r.stderr)
    assert.equal(fs.existsSync(path.join(cwd, '.glasspane')), false,
      'HOME 缺失时旧实现把状态根拼成 ./.glasspane，整棵安装落进当前目录')
    assert.ok(!/安装完成/.test(r.stdout), r.stdout)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * finding 5 — kill 的退出码不能被丢掉
 * ------------------------------------------------------------------------- */

test('finding5: kill 失败分得清"没了"和"我动不了它"', () => {
  assert.equal(classifyKillResult({ status: 0, stderr: '' }), 'alive')
  assert.equal(classifyKillResult({ status: 1, stderr: 'kill: 4242: No such process' }), 'gone')
  assert.equal(classifyKillResult({ status: 1, stderr: 'kill: 1: Operation not permitted' }), 'denied')
  assert.equal(classifyKillResult({ status: null, stderr: '', error: new Error('ENOENT: /bin/kill 起不来') }), 'unknown',
    '连 kill 都没跑起来时不许冒充"进程不在了"')
})

test('finding5: EPERM 的 pid 进 survivors，不进 terminated（注入接缝=假 kill）', () => {
  const result = terminatePids([4242], {
    sleep: () => {},
    spawn: (cmd, args) => (cmd === 'kill'
      ? { status: 1, stderr: `kill: ${args[args.length - 1]}: Operation not permitted` }
      : { status: 0, stderr: '' }),
  })
  assert.deepEqual(result.terminated, [], '一条 kill 都没成功过，却说"已结束"就是撒谎')
  assert.deepEqual(result.survivors.map((s) => s.pid), [4242])
  assert.match(result.survivors[0].reason, /EPERM|不属于当前用户/)
  const text = survivorText(result.survivors, { socketPath: '/Users/dev/.glasspane/engine.sock' })
  assert.match(text, /pid 4242/)
  assert.match(text, /sudo kill -9 4242/, '补救必须是坐在键盘前的人能执行的命令')
  assert.match(text, /--replace-daemon/)
  assert.match(text, /engine\.sock/)
})

test('finding5: 真的收不掉 pid 1（root 所有），也真的收得掉一个赖着不走的孩子', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('这一条要一个**非 root** 的账号：root 能收掉 pid 1，就测不到 EPERM 那一档')
    return
  }
  const root = terminatePids([1], { sleep: () => {} })
  assert.deepEqual(root.terminated, [], 'pid 1 属于 root：安装器说"已结束"就是假结论')
  assert.deepEqual(root.survivors.map((s) => s.pid), [1], `期望 survivor，实测 ${JSON.stringify(root)}`)

  // 一个吃掉 SIGTERM 的真实进程：必须走 forced，并且**只有再探一次确认不在**才算 terminated。
  // 它的父进程是一个正在 `wait` 的 sh，不是测试进程自己——否则被 SIGKILL 的那个 pid 会挂在
  // 僵尸态（测试进程正阻塞在 spawnSync 里，没人收尸），`kill -0` 会一直报它存在。
  const dir = tempDir('v5-child')
  const marker = path.join(dir, 'pid.txt')
  const sh = spawn('/bin/sh', ['-c', `trap '' TERM; /bin/sleep 30 & echo $! > '${marker}'; wait`], {
    detached: true, stdio: 'ignore',
  })
  sh.unref()
  const deadline = Date.now() + 5000
  while (!fs.existsSync(marker) && Date.now() < deadline) spawnSync('/bin/sleep', ['0.05'])
  try {
    assert.ok(fs.existsSync(marker), '夹具的中间 sh 没把子 pid 写出来')
    const pid = Number(fs.readFileSync(marker, 'utf8').trim())
    assert.ok(pid > 0, `读到的 pid 不成立：${pid}`)
    assert.equal(spawnSync('/bin/kill', ['-0', String(pid)], { encoding: 'utf8' }).status, 0, '前置：它还活着')
    const real = terminatePids([pid], { sleepMs: 150 })
    assert.ok(real.forced.includes(pid), '它吃掉了 SIGTERM，必须被记成强杀')
    assert.ok(real.terminated.includes(pid), `SIGKILL 之后应确认它不在了：${JSON.stringify(real)}`)
    assert.deepEqual(real.survivors, [], '真的已经没了的 pid 不许进 survivors（那是 EPERM 那一档）')
    assert.notEqual(spawnSync('/bin/kill', ['-0', String(pid)], { encoding: 'utf8' }).status, 0, '进程应真的没了')
    spawnSync('/bin/kill', ['-9', String(sh.pid)], { encoding: 'utf8' })
  } finally {
    spawnSync('/bin/kill', ['-9', String(sh.pid)], { encoding: 'utf8' })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * finding 6 — 存在 ≠ 可用（CLT shim）
 * ------------------------------------------------------------------------- */

test('finding6: 文件在但跑不起来（shim）算不可用；只有探测命令真的成功才算可用', () => {
  const accessOk = () => {}
  const access = () => { throw new Error('ENOENT') }
  const stub = (answers) => (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    if (!(key in answers)) throw new Error(`夹具没准备这一条：${key}`)
    return answers[key]
  }
  // 第三档：/usr/bin/swift 在、可执行，但 CLT 不在 → 两个探测都失败。
  const broken = stub({
    'swift --version': { status: 1, stderr: 'xcode-select: note: no developer tools were found' },
    'xcode-select -p': { status: 1, stderr: 'xcode-select: error: Unable to get active developer directory' },
  })
  assert.equal(commandAvailable('swift', { spawn: broken, access: accessOk }), false,
    '旧实现在这里 accessSync(“/usr/bin/swift”, X_OK) 成功就报可用，预检于是骗人')
  const fixed = stub({
    'swift --version': { status: 1, stderr: 'nope' },
    'xcode-select -p': { status: 0, stdout: '/Applications/Xcode.app/Contents/Developer' },
  })
  assert.equal(commandAvailable('swift', { spawn: fixed, access: access }), true, 'xcode-select -p 成功即 CLT 在场')
  const working = stub({ 'swift --version': { status: 0 }, 'xcode-select -p': { status: 1 } })
  assert.equal(commandAvailable('swift', { spawn: working, access: access }), true)
  // git 同样不吃"文件存在"。
  const brokenGit = stub({ 'git --version': { status: 1, stderr: 'no developer tools' } })
  assert.equal(commandAvailable('git', { spawn: brokenGit, access: accessOk }), false)
  // open 不支持 --version，文件退化检查对它仍然是唯一可行的路子。
  const openStub = stub({ 'open --version': { status: 1, stderr: 'unknown option' } })
  assert.equal(commandAvailable('open', { spawn: openStub, access: accessOk }), true)
  assert.equal(commandAvailable('open', { spawn: openStub, access }), false)
  assert.deepEqual(Object.keys(SHIM_PROBE_COMMANDS).sort(), ['git', 'swift'])
  assert.match(preflightIssues({ nodeMajor: 20, nodeOk: true, npm: true, swift: false, git: true, open: true })[0], /xcode-select --install/)
})

/* ---------------------------------------------------------------------------
 * finding 7 — LaunchAgents 里的 plist 必须是私有的
 * ------------------------------------------------------------------------- */

test('finding7: plist 以 0600 落盘并把模式读回来', () => {
  const dir = tempDir('v7-plist')
  const file = path.join(dir, 'com.glasspane.daemon.plist')
  try {
    const written = writePrivatePlist(file, '<plist>ok</plist>')
    assert.equal(written.ok, true, written.error ?? '')
    assert.equal(written.mode, STATE_FILE_MODE)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, '磁盘上的实际模式必须读得回来')
    // 已存在的 0644 也要被收紧（writeFileSync 的 mode 只管新建）。
    fs.chmodSync(file, 0o644)
    assert.equal(writePrivatePlist(file, '<plist>again</plist>').mode, 0o600)

    // 卷不保存权限位时按**写失败**报，并把实际模式点名——不许说"应该已经私有了"。
    const loose = writePrivatePlist(file, '<plist/>', { statMode: () => 0o644 })
    assert.equal(loose.ok, false)
    assert.match(loose.error, /0644/, loose.error)
    assert.match(loose.error, /0600/, loose.error)
    const denied = writePrivatePlist(file, '<plist/>', { chmod: () => { throw new Error('EPERM') } })
    assert.equal(denied.ok, false)
    assert.match(denied.error, /EPERM/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  // 形状闸：安装器不许再往那份 plist 上写 0644。
  const source = fs.readFileSync(CLI, 'utf8')
  assert.doesNotMatch(source, /mode:\s*0o644/, 'cli.js 里不该再有 0644 的写模式')
  assert.match(source, /writePrivatePlist\(plistPath/, '开机自启那份 plist 必须走 owner-only 写入')
})

/* ---------------------------------------------------------------------------
 * finding 8 — 面板指引必须落在真的东西上（install() 用 settingsLaunchPath 的结果）
 * ------------------------------------------------------------------------- */

test('finding8: 面板产物不存在时说明里没有 open，装好之后才有', () => {
  const dir = tempDir('v8-panel')
  const missing = path.join(dir, 'GlassPane.app')
  const real = path.join(dir, 'glasspane-settings')
  assert.equal(panelOpenHint({ panel: { viaBundle: true, executable: null, app: missing, exists: false } }).runnable, false)
  fs.writeFileSync(real, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const hint = panelOpenHint({ panel: { viaBundle: false, executable: real, app: null, exists: true } })
  assert.equal(hint.runnable, true)
  assert.ok(hint.text.includes(real))
  assert.ok(fs.existsSync(hint.target), '交给读者的那条路径必须存在')
  const guide = nextStepsText({
    rootDir: '/repo', socketPath: '/s.sock', guiOpened: false,
    daemon: { path: '/repo/glasspaned', viaBundle: false },
    panel: { viaBundle: true, executable: null, app: missing, exists: false },
  })
  assert.ok(!/open "/.test(guide), '没安置任何东西时不许印 open')
  assert.match(guide, /去掉 --no-app 重跑/, '给的补救必须是读者真能跑的那一条')
  fs.rmSync(dir, { recursive: true, force: true })
  // install() 必须把 settingsLaunchPath 的结果交给说明，而不是另拼一个路径。
  const source = fs.readFileSync(CLI, 'utf8')
  assert.match(source, /const panel = \{[\s\S]{0,400}?settingsLaunchPath|settingsLaunchPath\(\{ plan, bareBin: settingsBin \}\)[\s\S]{0,600}?panel/,
    'panel 必须由 settingsLaunchPath 算出')
  assert.match(source, /nextStepsText\(\{[\s\S]{0,600}?panel[,}\s]/, 'install() 要把这份结论传进说明')
})

/* ---------------------------------------------------------------------------
 * finding 9 — clone 失败要交出 git 的原话
 * ------------------------------------------------------------------------- */

test('finding9: “already exists and is not an empty directory” 不再被说成网络问题', () => {
  const fatal = "fatal: destination path '/Users/dev/glasspane' already exists and is not an empty directory."
  const text = cloneFailureText({ ref: 'v1.9.0', status: 128, stderr: fatal, targetDir: '/Users/dev/glasspane' })
  assert.match(text, /原因不是网络/, text)
  assert.match(text, /已存在且不是空目录/, text)
  assert.ok(text.includes(fatal), 'git 的原话必须一字不改地交给读者')
  assert.match(text, /GLASSPANE_INSTALL_DIR|--repo/, '给的是能跑的补救，不是"再试一次"')
  assert.doesNotMatch(text.split('\n')[0], /网络不可达/)
  const other = cloneFailureText({ ref: 'nope', status: 128, stderr: 'fatal: Remote branch nope not found in upstream origin', targetDir: '/x' })
  assert.ok(other.includes('Remote branch nope'), other)
  const silent = cloneFailureText({ ref: 'v1.9.0', status: null, stderr: '', targetDir: '/x' })
  assert.match(silent, /没有留下 stderr/, '读不到原话就明说读不到，不编一个成因')
})

test('finding9: bootstrap 目标已存在时，cli.js 把 git 那句原话交出来而不是怪网络', (t) => {
  const home = tempDir('v9-home')
  const cwd = tempDir('v9-cwd')
  try {
    // 目标目录本身就是一个 GlassPane 形状的仓库：bootstrapPlan 的"存在但不是仓库"检查放它过去
    // （resolveProjectRoot 会往上找到它），于是 git 才是真正说不通的那一个。
    const target = path.join(home, 'glasspane')
    fs.mkdirSync(path.join(target, 'engine'), { recursive: true })
    fs.mkdirSync(path.join(target, 'mcp-shell'), { recursive: true })
    fs.writeFileSync(path.join(target, 'engine', 'Package.swift'), '//')
    fs.writeFileSync(path.join(target, 'mcp-shell', 'package.json'), '{}')
    const r = spawnSync(process.execPath, [CLI, '--skip-build', '--no-app', '--no-gui', '--no-launchd', '--no-prompt'], {
      cwd, encoding: 'utf8', env: { ...process.env, HOME: home, GLASSPANE_REPO: '' }, timeout: 120_000,
    })
    if (preflightBlocked(r)) { t.skip('这台机器预检先挡了，走不到 clone 分支'); return }
    assert.equal(r.status, 1, `stdout:${r.stdout}\nstderr:${r.stderr}`)
    assert.match(r.stderr, /already exists and is not an empty directory/, r.stderr)
    assert.match(r.stderr, /原因不是网络/, r.stderr)
    assert.ok(!/网络不可达或该发布 tag 不存在/.test(r.stderr), '旧文案把任何非零都算成网络问题')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * finding 10 — 两条一键入口对空 GLASSPANE_REF 必须同义（另一半在 install-sh.test.mjs）
 * ------------------------------------------------------------------------- */

test('finding10: 空/未设置/空白 的 GLASSPANE_REF 都读成钉住的发布 tag', () => {
  const pinned = resolvePinRef({})
  assert.match(pinned, /^v\d+\.\d+\.\d+$/, pinned)
  for (const value of ['', '   ', undefined, null]) {
    assert.equal(resolvePinRef({ GLASSPANE_REF: value }), pinned, `空值读成了 ${value === undefined ? '未设置' : JSON.stringify(value)}`)
  }
  assert.equal(resolvePinRef({ GLASSPANE_REF: 'main' }), 'main', '追主干要显式写 main')
  const source = fs.readFileSync(INSTALL_SH, 'utf8')
  assert.doesNotMatch(source, /\[ -n "\$REF" \] \|\| REF=main/, 'install.sh 里那条"空值退回 main"必须删掉')
  assert.match(source, /REF="\$\{GLASSPANE_REF-\$\{GLASSPANE_RELEASE\}\}"[\s\S]{0,220}\[ -n "\$REF" \] \|\| REF="\$GLASSPANE_RELEASE"/)
})

/* ---------------------------------------------------------------------------
 * finding 11 — --no-prompt 真的有东西可跳过
 * ------------------------------------------------------------------------- */

test('finding11: confirm 三档——显式放行 / 交互问一句 / 非交互没给 flag 就不做也不挂', async () => {
  assert.equal(await confirm('x', { autoYes: true, interactive: false, ask: () => { throw new Error('不该问') } }), true)
  // 非交互且没给 --no-prompt：既不阻塞（没有 ask 调用、立刻回 false），也不默认同意。
  const started = Date.now()
  assert.equal(await confirm('要覆盖已存在的 .app', { autoYes: false, interactive: false, ask: () => { throw new Error('非交互环境不该去读 stdin') } }), false)
  assert.ok(Date.now() - started < 200, '非交互时不得等待')
  const asked = []
  assert.equal(await confirm('要覆盖已存在的 .app', {
    autoYes: false, interactive: true, ask: async (q) => { asked.push(q); return true },
  }), true)
  assert.match(asked[0], /覆盖/, '问的必须是那件破坏性的事本身')
  assert.equal(await confirm('要 bootout 已加载的作业', { autoYes: false, interactive: true, ask: async () => false }), false)
})

test('finding11: 没拿到许可时 bootout 一次都没发生，且给的是 --no-prompt 那条路', () => {
  const calls = []
  const spawn = (cmd, args) => {
    calls.push([cmd, args.join(' ')])
    if (cmd === 'id') return { status: 0, stdout: '501\n' }
    if (args[0] === 'print') return { status: 0, stdout: '\t\tprogram = /old/glasspaned' }
    return { status: 0, stdout: '' }
  }
  const declined = launchctlBootstrap('com.glasspane.daemon', '/tmp/x.plist', {
    desiredProgram: '/new/glasspaned', spawn, allowBootout: false,
  })
  assert.equal(declined.ok, false)
  assert.equal(declined.bootoutDeclined, true)
  assert.ok(!calls.some(([, arg]) => arg.startsWith('bootout')), `bootout 竟然跑了：${JSON.stringify(calls)}`)
  assert.ok(!calls.some(([, arg]) => arg.startsWith('bootstrap')), '没确认就不该动 launchd')
  assert.match(declined.message, /--no-prompt/, declined.message)
  assert.match(declined.message, /\/old\/glasspaned/, '要说清现在跑的是哪一份')
  // 定义一致时不问也不卸（常规幂等重跑）。
  const same = launchctlBootstrap('com.glasspane.daemon', '/tmp/x.plist', {
    desiredProgram: '/old/glasspaned', spawn, allowBootout: false,
  })
  assert.equal(same.ok, true, same.message)
  assert.equal(same.already, true)
  // 放行时按既有语义 bootout + bootstrap。
  const approved = launchctlBootstrap('com.glasspane.daemon', '/tmp/x.plist', { desiredProgram: '/new/glasspaned', spawn })
  assert.equal(approved.ok, true, approved.message)
  assert.ok(calls.some(([, arg]) => arg.startsWith('bootout')), '放行后必须真的换定义')
})

test('finding11: --no-prompt 被三个破坏性步骤读，usage 与 install.sh 的口径一致', () => {
  const source = fs.readFileSync(CLI, 'utf8')
  const body = source.slice(source.indexOf('export async function install('))
  assert.equal((body.match(/await confirm\(/g) ?? []).length, 3,
    '被拦的应当恰好是三件破坏性动作：bootout 已加载作业、覆盖已存在 .app、结束在跑实例')
  assert.match(body, /autoYes: options\.prompt === false/, 'confirm 的放行只能由这个 flag 决定')
  assert.match(usageText(), /--no-prompt[\s\S]{0,600}bootout[\s\S]{0,400}\.app/, 'usage 要说清跳过的是哪几步')
  assert.match(usageText(), /必须显式带 --no-prompt/, '非交互调用方要被告知必须显式带 flag')
  const sh = fs.readFileSync(INSTALL_SH, 'utf8')
  assert.match(sh, /\[ -t 0 \] \|\| SILENT="--no-prompt"/, '非 TTY 由入口脚本补上 flag，CI/e2e 行为不变')
})
