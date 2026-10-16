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

const NOW = new Date('2026-09-27T12:00:00.000Z')
const BUNDLES = [
  { name: 'GlassPane.app', executable: path.join('Contents', 'MacOS', 'GlassPane Settings') },
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
  assert.equal(isInterpreterMissing({ status: 1 }), false, '一次普通的非零退出不是这一条')
  assert.ok(real.PATH.split(':').includes(path.dirname(process.execPath)))
})

test('the resolved npm is *started*, not merely found, under the job\'s measured launchd PATH', () => {
  const fx = scratch('childenv-npm')
  try {
    const npmPath = writeEnvNodeScript(fx.bin, { prefix: path.join(fx.dir, 'prefix') })
    // Control, measured rather than asserted about: the same file, spawned the way the code used to spawn
    // it (no `env`), dies exactly like `/usr/local/bin/npm` dies under launchd.
    const unaided = spawnSync(npmPath, ['config', 'get', 'prefix'], { encoding: 'utf8', env: { PATH: LAUNCHD_PATH } })
    assert.equal(unaided.status, 127, `夹具必须像真 npm 一样挂：${JSON.stringify(unaided)}`)
    assert.match(String(unaided.stderr), /env: node: No such file or directory/, unaided.stderr)

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
    assert.match(starved.reason, /could not run: node is not on the PATH this process handed to the child/, starved.reason)
    assert.doesNotMatch(starved.reason, /exited with code 127 before answering/, `127 不是"跑得坏"，是"起不来"：${starved.reason}`)
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
    assert.match(got.stderr, new RegExp(`was found and started, but it could not run: ${missing}`), got.stderr)
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

test('node genuinely unavailable still refuses through §3.5 without the retired permissions sentence', async () => {
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
      npm: () => assert.fail('the npm gate refused, so nothing global may be touched'),
      // The real gate, with the node directory pointed at an empty one: this is the launchd job whose node
      // vanished (uninstalled, moved, a broken link) while npm's file is still on disk.
      preflightNpm: () => checkNpmPrefix({
        env: { PATH: LAUNCHD_PATH },
        dirs: [bin],
        execPath: path.join(fx.empty, 'node'),
      }),
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'deferred', JSON.stringify(result))
    assert.equal(result.code, CODES.npmPrefixUnwritable, result.message)
    assert.equal(exitCodeFor(result), EXIT.REFUSED)
    assert.deepEqual(kick, [], '这道门仍然排在换版之前')
    assert.ok(String(result.state.lastError.details).includes('npm-runtime-unavailable'), `因由要作为数据留在记录里：${result.state.lastError.details}`)
    assert.match(result.message, /could not run: node is not on the PATH this process handed to the child/, result.message)
    assert.doesNotMatch(result.message, /Check `npm config get prefix` from this account/, '那一句在本轮被退休，运行时够不着也不许把它请回来：' + result.message)
    assert.doesNotMatch(result.message, /cannot write where npm would put them/, result.message)
    assert.doesNotMatch(result.message, /\bsudo\b/, 'remedy 不许交出可照抄执行的升权命令')
    assert.match(result.message, /put node back where this run can reach it/, `补救要说真正的病因：${result.message}`)
    assert.match(result.message, /updater enable/, `补救要指向本产品支持的下一步（enable 会重渲染作业的 PATH）：${result.message}`)
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
