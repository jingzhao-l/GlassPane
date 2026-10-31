/**
 * The half of defect 1 that finding the binary did not fix (P1, 2026-10-16).
 *
 * `lib/binaries.js` resolves `npm` / `glasspane-mcp` / `swift` to an absolute path because a launchd job is
 * handed `/usr/bin:/bin:/usr/sbin:/sbin` and this machine keeps its toolchain off that PATH. Measured on
 * this machine 2026-10-16, the resolution alone still cannot start anything:
 *
 *     $ head -1 /usr/local/bin/npm
 *     #!/usr/bin/env node
 *     $ env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/local/bin/npm config get prefix
 *     env: node: No such file or directory        (exit 127)
 *
 * Exit 127 is not `notFound`, so `checkNpmPrefix` answered `npm config get prefix answered 127` with
 * `cause: undefined, dir: null`, and §3.5's refusal printed the retired sentence
 * "Check `npm config get prefix` from this account" — a permissions story about a directory this run never
 * read. The `#!/bin/sh` fixtures of `test/npm-binary-resolution.test.mjs` passed because `/bin/sh` *is* on
 * the minimal PATH; a fixture that cannot fail the way production fails cannot grade the fix.
 *
 * So: every spawn this module owns is handed `childSpawnEnv()` (the node running this program + the
 * resolved binary's own directory, rest of the environment untouched), and a child that still dies on its
 * interpreter is reported as a *named* cause (`npm-runtime-unavailable`) rather than as exit 127.
 *
 * REVERSE MUTATIONS, each named at the test it reddens:
 *   · drop `env: spawnEnv` from `defaultRun`'s spawnSync — `the resolved npm is *started*, not merely found`
 *     and `mcpToolsList starts a #!/usr/bin/env node glasspane-mcp …` both go red on exit 127.
 *   · drop `env` from `lib/mcp.js`'s spawnFn options — the second test reddens alone (it is the only one
 *     that drives the real `spawn`).
 *   · delete the `isInterpreterMissing` branch in `defaultRun` — `a child whose interpreter is genuinely
 *     unavailable refuses with a named cause, not as exit 127` goes red, and with it the §3.5 sentence test,
 *     which starts printing the retired permissions line again.
 *   · take the regular-file test out of `resolveBinary` — `a directory named npm is not a binary, and the
 *     sentence says what was measured` goes red.
 *   · delete `child.stdin?.on('error', noteStdinFailure)` from `lib/mcp.js` — `a server still running but
 *     no longer reading …` goes red: the EPIPE is no longer routed, node throws it as an uncaughtException,
 *     and the driver process this test measures exits 7. That is the bug CI caught and this file exists to
 *     keep caught; the sibling `…dies the moment it answers…` gates the exit-path verdict.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'

import { LAUNCHD_PATH, binaryNotExecutableDetail, childSpawnEnv, isInterpreterMissing, resolveBinary } from '../lib/binaries.js'
import { applyUpdate, checkNpmPrefix, defaultRun } from '../lib/apply.js'
import { mcpToolsList } from '../lib/mcp.js'
import { ARCHIVE_FILE_NAME } from '../lib/staging.js'
import { CODES, EXIT, exitCodeFor } from '../lib/codes.js'
import { writableRoots } from '../lib/fsutil.js'
import { sha256Bytes } from '../lib/digest.js'
import { packTarGz } from '../lib/tar.js'
import { emptyState, loadState, nextState, saveState } from '../lib/state.js'
import { TMP_PREFIX, makeFakeApp, removeDir, shortSocketPath, startSocketDaemon, tempDir } from './helpers.mjs'
import { inertView } from './helpers.mjs'

const NOW = new Date('2026-09-27T12:00:00.000Z')
const BUNDLES = [
  { name: 'GlassPane.app', executable: path.join('Contents', 'MacOS', 'glasspane-settings') },
  { name: 'GlassPane Daemon.app', executable: path.join('Contents', 'MacOS', 'glasspaned') },
]

/**
 * The npm-shaped fixture the machine actually ships: `#!/usr/bin/env node`, so the child needs a PATH that
 * answers that shebang. `runtime` picks which interpreter the shebang asks for — `node` for the production
 * shape, an impossible name for the negative control.
 */
function writeEnvNodeScript(binDir, { name = 'npm', prefix = null, runtime = 'node' }) {
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 })
  const file = path.join(binDir, name)
  const body = prefix === null
    ? 'process.stderr.write("fixture answers nothing\\n")\nprocess.exit(1)\n'
    : 'const argv = process.argv.slice(2)\n'
      + 'if (argv[0] === "config" && argv[1] === "get" && argv[2] === "prefix") {\n'
      + `  process.stdout.write(${JSON.stringify(`${prefix}\n`)})\n`
      + '  process.exit(0)\n'
      + '}\n'
      + 'process.exit(1)\n'
  fs.writeFileSync(file, `#!/usr/bin/env ${runtime}\n${body}`)
  fs.chmodSync(file, 0o755)
  return file
}

/**
 * A `glasspane-mcp`-shaped stdio server with the same shebang the npm-installed command has. Written as
 * CommonJS because the file has no extension: node decides a module's type from its name, and an
 * extensionless `import` would fail for a reason that has nothing to do with this test.
 */
function writeMcpServerScript(binDir, { name = 'glasspane-mcp', runtime = 'node' } = {}) {
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 })
  const file = path.join(binDir, name)
  fs.writeFileSync(file, `#!/usr/bin/env ${runtime}\n`
    + 'let buffer = ""\n'
    + 'const write = (m) => process.stdout.write(JSON.stringify(m) + "\\n")\n'
    + 'process.stdin.on("data", (chunk) => {\n'
    + '  buffer += chunk.toString("utf8")\n'
    + '  let i\n'
    + '  while ((i = buffer.indexOf("\\n")) !== -1) {\n'
    + '    const line = buffer.slice(0, i).trim()\n'
    + '    buffer = buffer.slice(i + 1)\n'
    + '    if (!line) continue\n'
    + '    let m\n'
    + '    try { m = JSON.parse(line) } catch { continue }\n'
    + '    if (m.method === "initialize") write({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "glasspane-mcp", version: "1.4.1" } } })\n'
    + '    if (m.method === "tools/list") write({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "gp_probe_status" }, { name: "gp_project_set" }] } })\n'
    + '  }\n'
    + '})\n'
    + 'process.stdin.on("end", () => process.exit(0))\n')
  fs.chmodSync(file, 0o755)
  return file
}

function scratch(label) {
  const dir = tempDir(`${TMP_PREFIX}${label}-`)
  const bin = path.join(dir, 'prefix', 'bin')
  const empty = path.join(dir, 'nowhere')
  fs.mkdirSync(bin, { recursive: true, mode: 0o755 })
  fs.mkdirSync(empty, { recursive: true })
  return { dir, bin, empty, cleanup: () => removeDir(dir) }
}

/* ------------------------------------------------------------------ the child environment */

test('childSpawnEnv puts the node this program runs on the child PATH and keeps everything else', () => {
  const env = childSpawnEnv('/opt/other/bin/npm', { env: { PATH: LAUNCHD_PATH, HOME: '/Users/dev' }, execPath: '/usr/local/bin/node' })
  const dirs = env.PATH.split(':')
  assert.equal(dirs[0], '/usr/local/bin', 'dirname(execPath) 是第一候选：shebang 问的 node 就在那里')
  assert.ok(dirs.includes('/opt/other/bin'), `被点名要跑的那一条自己的目录也要在：${env.PATH}`)
  for (const dir of LAUNCHD_PATH.split(':')) assert.ok(dirs.includes(dir), '继承来的 PATH 一条都不许掉')
  assert.equal(env.HOME, '/Users/dev', '只动 PATH；HOME 之类是子进程自己要读的')

  // A bare name has no directory of its own, so only the node directory is added.
  const bare = childSpawnEnv('npm', { env: { PATH: LAUNCHD_PATH }, execPath: '/opt/homebrew/bin/node' })
  assert.equal(bare.PATH.split(':')[0], '/opt/homebrew/bin')
  assert.equal(bare.PATH.split(':').includes('npm'), false, 'PATH 里放的是目录，不是命令名')

  // The measurement the fix is made of, with no seam at all: the node really is on the PATH this returns.
  const real = childSpawnEnv(process.execPath, { env: { PATH: LAUNCHD_PATH } })
  assert.equal(isInterpreterMissing({ status: 127, stderr: 'env: node: No such file or directory\n' }), true)
  // GNU coreutils 给的名字带引号（`/usr/bin/env: 'node': …`，CI 的 ubuntu runner 实测），
  // BSD 的不带。两种都得认出来，否则同一个"起不来"在一个平台上被当成"跑得坏"。
  assert.equal(isInterpreterMissing({ status: 127, stderr: "/usr/bin/env: 'node': No such file or directory\n" }), true,
    'GNU 的引号形状也必须被认成运行时够不着')
  assert.equal(isInterpreterMissing({ status: 1 }), false, '一次普通的非零退出不是这一条')
  assert.ok(real.PATH.split(':').includes(path.dirname(process.execPath)))
})

test('the resolved npm is *started*, not merely found, under the job\'s measured launchd PATH', () => {
  const fx = scratch('childenv-npm')
  try {
    const npmPath = writeEnvNodeScript(fx.bin, { prefix: path.join(fx.dir, 'prefix') })
    // Control, measured rather than asserted about: the same file, spawned the way the code used to spawn
    // it (no `env`), dies exactly like `/usr/local/bin/npm` dies under launchd — **on a machine where the
    // minimal PATH cannot answer `node`**. macOS is such a machine (that is where this was caught);
    // ubuntu runners ship a node under /usr/bin, so there the control is not applicable and saying so is
    // the honest move — a red that only measures the runner's image is not a signal about this code.
    const unaided = spawnSync(npmPath, ['config', 'get', 'prefix'], { encoding: 'utf8', env: { PATH: LAUNCHD_PATH } })
    if (spawnSync('/usr/bin/env', ['node', '-v'], { encoding: 'utf8', env: { PATH: LAUNCHD_PATH } }).status === 0) {
      console.log('# control-not-applicable: 这台机器的最小 PATH 能解析到 node，夹具不会挂；只判正面')
    } else {
      assert.equal(unaided.status, 127, `夹具必须像真 npm 一样挂：${JSON.stringify(unaided)}`)
      assert.match(String(unaided.stderr), /env: '?node'?: No such file or directory/, unaided.stderr)
    }

    const got = defaultRun('npm', ['config', 'get', 'prefix'], {
      timeoutMs: 30_000,
      env: { PATH: LAUNCHD_PATH },
      dirs: [fx.bin],
    })
    assert.equal(got.status, 0, JSON.stringify(got))
    assert.equal(got.stdout.trim(), path.join(fx.dir, 'prefix'))
    assert.equal(got.runtimeUnavailable, undefined)

    const gate = checkNpmPrefix({ env: { PATH: LAUNCHD_PATH }, dirs: [fx.bin] })
    assert.equal(gate.ok, true, gate.reason)
    assert.equal(gate.prefix, path.join(fx.dir, 'prefix'))
  } finally {
    fx.cleanup()
  }
})

test('mcpToolsList starts a #!/usr/bin/env node glasspane-mcp with the real spawn', async () => {
  const fx = scratch('childenv-mcp')
  try {
    const server = writeMcpServerScript(fx.bin)
    // The *default* spawnFn: a fake one would grade the fake. The command is a bare name under the launchd
    // PATH, so both the search and the child environment have to work for a tool list to come back.
    const answer = await mcpToolsList({
      command: 'glasspane-mcp',
      env: { PATH: LAUNCHD_PATH },
      dirs: [fx.bin],
      timeoutMs: 20_000,
    })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    assert.equal(answer.bin, server)
    assert.deepEqual(answer.tools, ['gp_probe_status', 'gp_project_set'])

    // And the same call, denied the child environment, is the 127 this file exists for: said as a runtime
    // fact with the name the shebang asked for, never as "it behaved badly". The `spawn` here is the real
    // one — only its `env` is forced back to the job's minimal PATH.
    const starved = await mcpToolsList({
      command: server,
      env: { PATH: LAUNCHD_PATH },
      timeoutMs: 20_000,
      spawnFn: (bin, args, options) => spawn(bin, args, { ...options, env: { PATH: LAUNCHD_PATH } }),
    })
    assert.equal(starved.ok, false, JSON.stringify(starved))
    assert.equal(starved.interpreterMissing, true, 'node 真的够不着时，这一条必须被认出来')
    assert.match(starved.reason, /could not run: '?node'? is not on the PATH this process handed to the child/, starved.reason)
    assert.doesNotMatch(starved.reason, /exited with code 127 before answering/, `127 不是"跑得坏"，是"起不来"：${starved.reason}`)
  } finally {
    fx.cleanup()
  }
})

/* ------------------------------------------------------------------ the dead-pipe path */

/**
 * A reply that makes the parent write, with the read end of stdin gone. Both shapes below are the same
 * event CI hit on 2026-10-16 (run 38842800885, `write EPIPE` attributed as `uncaughtException` to
 * `mcpToolsList starts a #!/usr/bin/env node glasspane-mcp with the real spawn`) — there it happened by
 * luck, between a write being dispatched and the child dying. Locally the same code never errored, so the
 * fixture has to force the state rather than wait for it.
 *
 * The pipe is closed by `exec 0<&-` in a `sh` wrapper, *before* node is exec'd — not by the server itself.
 * A node process that closes its own fd 0 wedges its event loop and answers nothing at all (measured here
 * 2026-10-16), which is a different bug and would make these two tests time out instead of EPIPE.
 *
 * `close` = the read end is gone, the server answers, then stays alive. The parent only writes after it
 * sees the answer, so the write is provably against a dead pipe; closing after answering is a race against
 * the parent's event loop, and a race that passes locally is not a control.
 * `exit`  = the read end is gone because the server dies the instant it answers — CI's shape. Its EPIPE is
 * not guaranteeable (teardown has to beat the parent's write), so this one gates the *verdict* on the exit
 * path; `close` is the one that gates the listener.
 *
 * The wrapper execs the absolute interpreter rather than `env node` on purpose: what is under test here is
 * the pipe, and leaving the interpreter resolvable by PATH would make these tests fail for a reason this
 * file already covers elsewhere.
 */
function writeDeadPipeServer(binDir, name, shape) {
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 })
  const file = path.join(binDir, name)
  const reply = 'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: '
    + '"2024-11-05", capabilities: {}, serverInfo: { name: "glasspane-mcp", version: "1.4.1" } } }) + "\\n")\n'
  const body = shape === 'close' ? `${reply}setInterval(() => {}, 1000)\n` : `${reply}process.exit(0)\n`
  const payload = path.join(binDir, `${name}.payload.cjs`)
  fs.writeFileSync(payload, body)
  fs.writeFileSync(file, `#!/bin/sh\nexec 0<&-\nexec '${process.execPath}' '${payload}'\n`)
  fs.chmodSync(file, 0o755)
  return file
}

/**
 * Driven in a process of its own: inside `node --test`, an unrouted stream error is swallowed by the runner
 * and booked against whichever test happens to be live, so "would this kill a real process" is not
 * measurable from in here. In production it is an uncaughtException that takes the updater down mid-update,
 * so the measurement is that process's exit code plus the line it prints.
 */
function runHandshakeInItsOwnProcess(serverPath, { timeoutMs }) {
  const driver = path.join(path.dirname(serverPath), `driver-${path.basename(serverPath)}.mjs`)
  fs.writeFileSync(driver, 'import { mcpToolsList } from ' + JSON.stringify(new URL('../lib/mcp.js', import.meta.url).href) + '\n'
    + 'process.on("uncaughtException", (error) => {\n'
    + '  process.stdout.write("UNCAUGHT|" + String(error.code ?? error.message) + "\\n")\n'
    + '  process.exit(7)\n'
    + '})\n'
    + 'const answer = await mcpToolsList({ command: ' + JSON.stringify(serverPath)
    + ', env: process.env, timeoutMs: ' + timeoutMs + ' })\n'
    + 'process.stdout.write("VERDICT|" + JSON.stringify(answer) + "\\n")\n'
    + 'process.exit(0)\n')
  const ran = spawnSync(process.execPath, [driver], { encoding: 'utf8' })
  const out = `${ran.stdout ?? ''}${ran.stderr ?? ''}`
  const line = out.split('\n').find((l) => l.startsWith('VERDICT|'))
  return {
    status: ran.status,
    uncaught: /UNCAUGHT\|/.test(out),
    verdict: line ? JSON.parse(line.slice('VERDICT|'.length)) : null,
    out,
  }
}

test('a server that dies the moment it answers is given a verdict, not an uncaughtException', () => {
  const fx = scratch('childenv-pipe-exit')
  try {
    const server = writeDeadPipeServer(fx.bin, 'glasspane-mcp-exit', 'exit')
    // 20s is not how long this takes — the `close` event answers it in about a second. It is how much room
    // the exit path gets before the timer is allowed to preempt it: on a cold node start the first spawn of
    // a suite has been measured at 3.4s here, and a verdict that flips from "exited with code 0" to "did not
    // answer within 3000ms" depending on how busy the machine is grades the runner, not this code.
    const got = runHandshakeInItsOwnProcess(server, { timeoutMs: 20_000 })
    assert.equal(got.uncaught, false, `管道死了不是把宿主进程带下去的理由：${got.out}`)
    assert.equal(got.status, 0, `升级过程不能因为一次 EPIPE 就退出非零：${JSON.stringify(got)}`)
    assert.ok(got.verdict, `必须有一个判决可打印：${got.out}`)
    assert.equal(got.verdict.ok, false, JSON.stringify(got.verdict))
    assert.match(got.verdict.reason, /exited with code \d+ before answering tools\/list/, got.verdict.reason)
    assert.doesNotMatch(got.verdict.reason, /could not be run/, '它确实被启动了，是起来之后没读第二帧')
  } finally {
    fx.cleanup()
  }
})

test('a server still running but no longer reading says the pipe was dead, not just that it was slow', () => {
  const fx = scratch('childenv-pipe-close')
  try {
    const server = writeDeadPipeServer(fx.bin, 'glasspane-mcp-close', 'close')
    // The verdict on this path comes from the timer, so the timer has to outlast a cold node start on a
    // loaded machine; a timeout shorter than the fixture's boot would red for the runner's speed, not for
    // anything about this code.
    const got = runHandshakeInItsOwnProcess(server, { timeoutMs: 8000 })
    assert.equal(got.uncaught, false, `管道死了不是把宿主进程带下去的理由：${got.out}`)
    assert.equal(got.status, 0, JSON.stringify(got))
    assert.equal(got.verdict?.ok, false, JSON.stringify(got.verdict))
    assert.match(got.verdict.reason, /did not answer tools\/list within 8000ms/, got.verdict.reason)
    // "没答话"只说了半场。真相是它已经不读了——不写出来的话，读者会去查一个根本没坏的服务器。
    assert.match(got.verdict.reason, /writing to its stdin had already failed \(EPIPE\)/, got.verdict.reason)
  } finally {
    fx.cleanup()
  }
})

/* ------------------------------------------------------------------ the negative control */

test('a child whose interpreter is genuinely unavailable refuses with a named cause, not as exit 127', () => {
  const fx = scratch('childenv-runtime')
  try {
    // Production-shaped: the file is found, exec'd, and its shebang asks for a runtime that is not on this
    // machine anywhere — the same event as "npm is here but node is not", measured one level down.
    const missing = 'gp-absent-runtime-20261016'
    writeEnvNodeScript(fx.bin, { prefix: path.join(fx.dir, 'prefix'), runtime: missing })
    const got = defaultRun('npm', ['config', 'get', 'prefix'], { timeoutMs: 30_000, env: { PATH: LAUNCHD_PATH }, dirs: [fx.bin] })
    assert.equal(got.status, 127, JSON.stringify(got))
    assert.equal(got.runtimeUnavailable, true, '这是一个被点名的因由，不是一个数')
    assert.notEqual(got.notFound, true, '文件找到了：这不是"没有装"')
    // 报话把那个运行时的名字用引号括起来（`'gp-absent-runtime-…'`），因为那是一段人可以
    // 复制的文字；判据盯的是"哪个名字、哪一件事"，不是引号的个数。
    assert.match(got.stderr, new RegExp(`could not run: .?${missing}.? is not on the PATH this process handed to the child`), got.stderr)
    assert.match(got.stderr, /was found and started, but it could not run/, got.stderr)
    assert.match(got.stderr, /not a permission of any directory/, got.stderr)

    const gate = checkNpmPrefix({ env: { PATH: LAUNCHD_PATH }, dirs: [fx.bin] })
    assert.equal(gate.ok, false)
    assert.equal(gate.cause, 'npm-runtime-unavailable', JSON.stringify(gate))
    assert.equal(gate.dir, null, '一次都没问到前缀，就没有"哪个目录不能写"可说')
    assert.doesNotMatch(gate.reason, /npm config get prefix answered 127/, gate.reason)
  } finally {
    fx.cleanup()
  }
})

test('node genuinely unavailable still installs the bundles and names the runtime, not a permission', async () => {
  const fx = stagedMachine('childenv-refusal')
  const bin = path.join(fx.dir, 'offpath-bin')
  const kick = []
  const socketPath = shortSocketPath(fx.dir, 'childenv.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  try {
    writeEnvNodeScript(bin, { prefix: path.join(fx.dir, 'prefix') })
    const result = await applyUpdate({
      stateRoot: fx.dir,
      appsDir: fx.appsDir,
      bundles: BUNDLES,
      now: NOW,
      currentVersion: '1.4.0',
      socketPath,
      probe: { socketPath, timeoutMs: 1_000 },
      job: { ok: true, args: ['glasspaned', '--socket-path', socketPath] },
      build: () => ({ ok: true, builtDir: fx.builtDir, message: null }),
      kickstart: async (options) => { kick.push(options); return { ok: true, message: 'restarted' } },
      toolsList: async () => ({ ok: true, count: 16, tools: ['gp_probe_status'] }),
      npm: () => assert.fail('预检已经答"这一趟够不着 npm"，全局层就不许再被碰'),
      // §11's handover copies the updater and may re-register the job; this test measures §3.5's answer,
      // so that step is replaced rather than allowed to reach for the developer's machine.
      refreshRuntimeImpl: () => ({
        record: { status: 'refreshed', version: '1.4.1', cliPath: '/var/tmp/st/runtime/1.4.1/updater/cli.js', previousCliPath: null, agentVerified: true, at: NOW.toISOString(), code: null, detail: null },
        restored: { attempted: false, ok: true },
      }),
      // The real gate, with the node directory pointed at an empty one: this is the launchd job whose node
      // vanished (uninstalled, moved, a broken link) while npm's file is still on disk.
      preflightNpm: () => checkNpmPrefix({
        env: { PATH: LAUNCHD_PATH },
        dirs: [bin],
        execPath: path.join(fx.empty, 'node'),
      }),
    })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.status, 'applied', JSON.stringify(result))
    assert.equal(result.code, CODES.npmNotRefreshed, result.message)
    assert.equal(exitCodeFor(result), EXIT.OK, '应用装了、全局层没装 ⇒ 机器确实变了')
    assert.equal(kick.length, 1, 'daemon 重启了一次：这一格与"整场拒绝"的分别就在这个数字上')
    assert.ok(String(result.state.lastError.details).includes('npm-runtime-unavailable'), `因由要作为数据留在记录里：${result.state.lastError.details}`)
    assert.match(result.message, /could not run: '?node'? is not on the PATH this process handed to the child/, result.message)
    assert.match(result.message, /npm install -g glasspane-mcp@1\.4\.1 glasspane-install@1\.4\.1/,
      '够不着 npm 的那一趟也要把人手上能跑的补法交出去')
    assert.doesNotMatch(result.message, /Check `npm config get prefix` from this account/, '那一句在本轮被退休，运行时够不着也不许把它请回来：' + result.message)
    assert.doesNotMatch(result.message, /cannot write where npm would put them/, result.message)
    assert.doesNotMatch(result.message, /\bsudo\b/, 'remedy 不许交出可照抄执行的升权命令')
    assert.match(result.message, /put node back where this run can reach it/, `补救要说真正的病因：${result.message}`)
    assert.match(inertView(result.message), /updater\/cli\.js enable/, `补救要指向本产品支持的下一步（enable 会重渲染作业的 PATH）：${result.message}`)
    assert.doesNotMatch(result.message, /add that directory to the update agent's EnvironmentVariables/, '那个手工编辑会被下一次 enable 抹掉，不是补救')
  } finally {
    await daemon.close()
    fx.cleanup()
  }
})

/* ------------------------------------------------------------------ finding 6: a directory is not a binary */

test('a directory named npm is not a binary, and the sentence says what was measured', () => {
  const fx = scratch('dirnamed')
  try {
    const asDir = path.join(fx.bin, 'npm')
    fs.mkdirSync(asDir, { recursive: true, mode: 0o755 })
    // Why `X_OK` alone was the bug: a directory answers it, because for a directory that bit means
    // "searchable". Measured here rather than asserted about.
    let xOk = false
    try {
      fs.accessSync(asDir, fs.constants.X_OK)
      xOk = true
    } catch {
      xOk = false
    }
    assert.equal(xOk, true, '前提：X_OK 对目录是给通过的，否则这条闸测的不是那个形状')

    const found = resolveBinary('npm', { env: { PATH: LAUNCHD_PATH }, dirs: [fx.bin, fx.empty] })
    assert.equal(found.bin, null, `一个目录不能当二进制交出去：${JSON.stringify(found)}`)
    assert.equal(found.blocked, asDir)
    assert.equal(found.blockedWhy, 'directory', JSON.stringify(found))

    const detail = binaryNotExecutableDetail({ name: 'npm', bin: asDir, why: found.blockedWhy })
    assert.match(detail, /is a directory, not an executable file/, detail)
    assert.doesNotMatch(detail, /cannot execute it|EACCES/, `目录没有被拒绝执行这回事：${detail}`)

    const run = defaultRun('npm', ['config', 'get', 'prefix'], { timeoutMs: 30_000, env: { PATH: LAUNCHD_PATH }, dirs: [fx.bin] })
    assert.equal(run.notFound, true, JSON.stringify(run))
    assert.match(run.stderr, /is a directory, not an executable file/, run.stderr)
    assert.doesNotMatch(run.stderr, /exists but this account cannot execute it/, run.stderr)

    // The not-found sentence keeps the same distinction, because that is the one a person can act on.
    const gate = checkNpmPrefix({ env: { PATH: LAUNCHD_PATH }, dirs: [fx.bin] })
    assert.equal(gate.ok, false)
    assert.equal(gate.cause, 'npm-not-found', JSON.stringify(gate))
    assert.match(gate.reason, /is a directory, not an executable file/, gate.reason)
    assert.doesNotMatch(gate.reason, /cannot write|not writable/, gate.reason)
  } finally {
    fx.cleanup()
  }
})

/* ------------------------------------------------------------- the staged machine (same shape as apply.test.mjs) */

function stagedMachine(label) {
  const dir = tempDir(`${TMP_PREFIX}${label}-`)
  const appsDir = path.join(dir, 'Applications')
  makeFakeApp(appsDir, 'GlassPane.app', '1.4.0', { marker: 'installed' })
  makeFakeApp(appsDir, 'GlassPane Daemon.app', '1.4.0', { marker: 'installed' })
  const stagingDir = path.join(writableRoots(dir).staging, '1.4.1')
  const treePath = path.join(stagingDir, 'tree')
  fs.mkdirSync(treePath, { recursive: true, mode: 0o700 })
  const treeFiles = [{ name: 'package.json', content: JSON.stringify({ version: '1.4.1' }) }]
  for (const file of treeFiles) fs.writeFileSync(path.join(treePath, file.name), file.content)
  const archive = packTarGz(treeFiles)
  fs.writeFileSync(path.join(stagingDir, ARCHIVE_FILE_NAME), archive)
  const builtDir = path.join(dir, 'built')
  for (const bundle of BUNDLES) makeFakeApp(builtDir, bundle.name, '1.4.1', { marker: 'NEW' })
  const empty = path.join(dir, 'nowhere')
  fs.mkdirSync(empty, { recursive: true })
  // A whole npm prefix, so the only thing that can refuse this gate is the thing under test.
  const npmPrefix = path.join(dir, 'prefix')
  fs.mkdirSync(path.join(npmPrefix, 'lib', 'node_modules'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(npmPrefix, 'bin'), { recursive: true, mode: 0o755 })
  saveState(dir, nextState(emptyState({ now: NOW }), {
    status: 'staged',
    code: null,
    current: '1.4.0',
    latest: '1.4.1',
    lastCheckAt: NOW.toISOString(),
    staged: { version: '1.4.1', dir: stagingDir, digest: sha256Bytes(archive), at: NOW.toISOString() },
  }, { now: NOW }), { now: NOW })
  return {
    dir,
    appsDir,
    builtDir,
    empty,
    npmPrefix,
    stagingDir,
    installedBytes: () => fs.readFileSync(path.join(appsDir, 'GlassPane Daemon.app', 'Contents', 'MacOS', 'binary'), 'utf8'),
    cleanup: () => removeDir(dir),
  }
}

function require$writableRoots(dir) {
  return writableRootsFor(dir)
}
