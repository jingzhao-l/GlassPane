/**
 * Defect 1 (P1, 2026-10-15): a scheduled or panel-initiated apply could not resolve `npm` or
 * `glasspane-mcp`, and the refusal blamed npm's global prefix *permissions* for a PATH fact.
 *
 * Measured on this machine, which is the machine the defect is about:
 *   · `command -v npm` → `/usr/local/bin/npm`, `npm config get prefix` → `/usr/local`,
 *     `command -v glasspane-mcp` → `/usr/local/bin/glasspane-mcp`;
 *   · `launchd` hands a job `/usr/bin:/bin:/usr/sbin:/sbin` (`lib/signature.js` records the same measurement
 *     for gpg on 2026-10-03 and `test/signature.test.mjs` is the template this file follows);
 *   · so `spawnSync('npm', …)` ENOENTed, `defaultRun` mapped that to exit 127, `checkNpmPrefix` answered
 *     `npm config get prefix answered 127` with `dir: null`, and §3.5's refusal told the person to go and
 *     check `npm config get prefix` — a PATH problem reported as a permissions problem.
 *
 * What is real here: a real executable npm-shaped script in an off-PATH prefix directory, spawned by the
 * module's **own** `defaultRun` (no injected runner), and a real `glasspane-mcp`-shaped file for the search
 * to find. The filesystem and the spawn are not faked. Since 2026-10-16 the npm fixture carries
 * `#!/usr/bin/env node` like the real binary does — the `#!/bin/sh` it used to be written with could not
 * fail the way production failed, so a green suite hid the second half of the defect (see
 * `test/child-spawn-environment.test.mjs` for the rest of that half).
 *
 * REVERSE MUTATIONS, each named at the test it reddens:
 *   · delete the resolution from `defaultRun` (spawn `bin` as it arrived) —
 *     `checkNpmPrefix finds a real npm that is off PATH, and runs that copy` goes red: both the direct
 *     `defaultRun` call and the pre-flight's answer come back `npm-not-found`.
 *   · spawn without the child environment (`spawnSync(command, args, { cwd, encoding, timeout })`) —
 *     the same test goes red on exit 127, because the fixture's `#!/usr/bin/env node` cannot be answered
 *     from `/usr/bin:/bin:/usr/sbin:/sbin`; `test/child-spawn-environment.test.mjs` reddens with it.
 *   · map a missing binary back to `{status: 127}` (the old shape) —
 *     `npm genuinely absent refuses as "not found on the searched paths"…` goes red, and with it
 *     `the §3.5 refusal for a missing npm names the search and stops blaming the prefix`.
 *   · take the search out of `lib/mcp.js` —
 *     `the MCP half resolves glasspane-mcp through the same helper, and refuses without one` goes red: the
 *     command handed to the process selector is the bare name again.
 *   · drop `npm` / `glasspane-mcp` / `swift` from `SEARCHED_COMMANDS` —
 *     `every bare command updater/lib spawns is either searched or provably inside the launchd PATH` reds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  LAUNCHD_PATH,
  SEARCHED_COMMANDS,
  candidateDirsFor,
  npmGlobalBinDirs,
  resolveBinary,
} from '../lib/binaries.js'
import {
  applyUpdate,
  buildStagedTree,
  checkNpmPrefix,
  defaultReadGlobalVersions,
  defaultRun,
  installNpmPackages,
} from '../lib/apply.js'
import { ARCHIVE_FILE_NAME } from '../lib/staging.js'
import { CODES, EXIT, exitCodeFor } from '../lib/codes.js'
import { mcpToolsList, resolveMcpBinary } from '../lib/mcp.js'
import { writableRoots } from '../lib/fsutil.js'
import { sha256Bytes } from '../lib/digest.js'
import { packTarGz } from '../lib/tar.js'
import { emptyState, loadState, nextState, saveState } from '../lib/state.js'
import { TMP_PREFIX, fakeMcpPeer, makeFakeApp, removeDir, shortSocketPath, startSocketDaemon, tempDir } from './helpers.mjs'

const NOW = new Date('2026-09-27T12:00:00.000Z')
const BUNDLES = [
  { name: 'GlassPane.app', executable: path.join('Contents', 'MacOS', 'glasspane-settings') },
  { name: 'GlassPane Daemon.app', executable: path.join('Contents', 'MacOS', 'glasspaned') },
]

/**
 * The precondition every "off PATH" case needs: none of the four directories a launchd job is handed holds
 * an `npm`. Measured on this machine (macOS with Command Line Tools): it holds none — which is exactly why
 * the daily job failed. A machine that *did* put npm in `/usr/bin` cannot express this case with this
 * literal PATH, so those tests say so and are skipped rather than passing by accident.
 */
const launchdDirs = LAUNCHD_PATH.split(':')
const launchdPathHasNpm = launchdDirs.some((dir) => fs.existsSync(path.join(dir, 'npm')))
const offPathSkip = launchdPathHasNpm ? 'this machine has npm inside /usr/bin:/bin:/usr/sbin:/sbin, so the off-PATH case is not expressible here' : false

/**
 * A real npm-shaped script, shaped like the real one: `#!/usr/bin/env node` and a node body (measured
 * 2026-10-16: `/usr/local/bin/npm`'s first line *is* that shebang, which is why resolving the absolute path
 * was only half of the fix — the child still has to be handed a PATH that can answer the shebang).
 *
 * The old fixture was `#!/bin/sh`, and it passed while the real npm failed: `/bin/sh` is inside the minimal
 * job PATH, so the spawn never had to look for node. A fixture that cannot fail the way production fails
 * proves nothing about the child, so this one can.
 */
function writeNpmShapedScript(binDir, { prefix, name = 'npm' }) {
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 })
  const file = path.join(binDir, name)
  fs.writeFileSync(file, '#!/usr/bin/env node\n'
    + 'const argv = process.argv.slice(2)\n'
    + 'if (argv[0] === "config" && argv[1] === "get" && argv[2] === "prefix") {\n'
    + `  process.stdout.write(${JSON.stringify(`${prefix}\n`)})\n`
    + '  process.exit(0)\n'
    + '}\n'
    + 'process.stderr.write("npm ERR! this fixture answers config get prefix only\\n")\n'
    + 'process.exit(1)\n')
  fs.chmodSync(file, 0o755)
  return file
}

/** A scratch root holding a whole npm prefix: `<dir>/prefix/{bin,lib/node_modules}`, plus an empty dir. */
function prefixMachine(label) {
  const dir = tempDir(`${TMP_PREFIX}${label}-`)
  const prefix = path.join(dir, 'prefix')
  const bin = path.join(prefix, 'bin')
  const modules = path.join(prefix, 'lib', 'node_modules')
  fs.mkdirSync(modules, { recursive: true, mode: 0o700 })
  fs.mkdirSync(bin, { recursive: true, mode: 0o755 })
  const empty = path.join(dir, 'nowhere')
  fs.mkdirSync(empty, { recursive: true })
  return { dir, prefix, bin, modules, empty, cleanup: () => removeDir(dir) }
}

test('checkNpmPrefix finds a real npm that is off PATH, and runs that copy', { skip: offPathSkip }, () => {
  const fx = prefixMachine('binres-found')
  try {
    const npmPath = writeNpmShapedScript(fx.bin, { prefix: fx.prefix })
    // The fixture must break the way the machine's real npm breaks, or the success below is grading a stub.
    // Measured against `/usr/local/bin/npm`: `#!/usr/bin/env node` + the job's PATH ⇒ exit 127 and
    // `env: node: No such file or directory`. REVERSE MUTATION: drop `env: spawnEnv` from `defaultRun`'s
    // spawnSync and this whole test goes red on exactly that 127.
    const raw = spawnSync(npmPath, ['config', 'get', 'prefix'], { encoding: 'utf8', env: { PATH: LAUNCHD_PATH } })
    // 控制组的前提是"这个平台的最小 PATH 里没有 node"。这在 macOS 上是实测（本轮就是在那儿
    // 抓到 127 的），在 ubuntu runner 上不一定成立（那儿 /usr/bin 里可能就有 node）。
    // 前提不成立时不能拿它当失败，也不能悄悄当通过——打出来，让读的人知道这台机器
    // 只证了正面那一半。
    const nodeReachableHere = spawnSync('/usr/bin/env', ['node', '-v'], { encoding: 'utf8', env: { PATH: LAUNCHD_PATH } }).status === 0
    if (nodeReachableHere) {
      console.log('# control-not-applicable: 这台机器的最小 PATH 里能解析到 node，夹具不会像真 npm 那样挂；只判正面')
    } else {
      assert.equal(raw.status, 127, `一个不带 env 的真 spawn 必须像真 npm 那样死：${JSON.stringify({ status: raw.status, stderr: raw.stderr })}`)
      assert.match(String(raw.stderr), /env: '?node'?: No such file or directory/, '夹具的 shebang 问的是 node，而最小 PATH 里没有 node')
    }
    // The control first: with the same PATH and no extra directory, nothing is found. So every success
    // below is attributable to the search, not to a PATH that happens to work on this machine.
    const bare = defaultRun('npm', ['config', 'get', 'prefix'], { timeoutMs: 30_000, env: { PATH: LAUNCHD_PATH }, dirs: [fx.empty] })
    assert.equal(bare.status, null, JSON.stringify(bare))
    assert.equal(bare.notFound, true, '最小 PATH 里就是没有 npm——这台机器的定时作业每天遇到的事')

    const direct = defaultRun('npm', ['config', 'get', 'prefix'], { timeoutMs: 30_000, env: { PATH: LAUNCHD_PATH }, dirs: [fx.bin, fx.empty] })
    assert.equal(direct.status, 0, JSON.stringify(direct))
    assert.equal(direct.stdout.trim(), fx.prefix, '真的跑起了那一份脚本，才谈得上读到它的前缀')
    assert.equal(direct.notFound, undefined)

    // And through the gate itself, on the module's own runner: a bare `npm` under that PATH can only
    // ENOENT, so `ok: true` here *is* the proof that the resolved absolute path got spawned.
    const got = checkNpmPrefix({ env: { PATH: LAUNCHD_PATH }, dirs: [fx.bin, fx.empty] })
    assert.equal(got.ok, true, got.reason)
    assert.equal(got.prefix, fx.prefix, '答案来自那一份被找到的 npm')
    assert.deepEqual([...got.dirs].sort(), [fx.bin, fx.modules].sort(), '两处都要能写：包落进去的那一层和命令链过去的那一层')

    // The same npm reached through the machine's real default candidates, with the node directory as the
    // only hint: measured here, `/usr/local/bin/node` and `/usr/local/bin/npm` are the same directory.
    const viaNodeDir = defaultRun('npm', ['config', 'get', 'prefix'], {
      timeoutMs: 30_000,
      env: { PATH: LAUNCHD_PATH },
      dirs: candidateDirsFor('npm', { env: { PATH: LAUNCHD_PATH }, execPath: path.join(fx.bin, 'node') }),
    })
    assert.equal(viaNodeDir.status, 0, JSON.stringify(viaNodeDir))
  } finally {
    fx.cleanup()
  }
})

test('the search itself: PATH first, then the named prefixes, and never a guess about a missing file', () => {
  const fx = prefixMachine('binres-order')
  try {
    const npmPath = writeNpmShapedScript(fx.bin, { prefix: fx.prefix })
    const found = resolveBinary('npm', { env: { PATH: LAUNCHD_PATH }, dirs: [fx.bin, fx.empty] })
    assert.equal(found.bin, npmPath)
    assert.equal(found.source, 'known prefix', 'PATH 上没有人，答案来自点名的前缀')
    assert.equal(found.tried.at(-1), npmPath, `搜到哪一条就停在哪一条：${found.tried.join(', ')}`)

    // PATH first when PATH really has it: two installs on one machine must resolve to the one this process
    // would have run anyway, not to whichever prefix this file likes.
    const inPath = resolveBinary('npm', { env: { PATH: `${fx.bin}:${LAUNCHD_PATH}` }, dirs: [fx.empty] })
    assert.equal(inPath.bin, npmPath)
    assert.equal(inPath.source, 'path')

    // A name that is already a path is left alone: `apply.test.mjs` spawns `process.execPath`, and
    // re-resolving a path the caller chose is how a fixture stops testing the thing it names.
    assert.equal(resolveBinary('/bin/sh', { env: { PATH: '' }, dirs: [] }).bin, '/bin/sh')

    // The node directory is a candidate by itself: wherever node came from is, by definition, executable by
    // this account (measured here: /usr/local/bin/node and /usr/local/bin/npm in the same directory).
    const dirs = candidateDirsFor('npm', { env: { PATH: LAUNCHD_PATH }, execPath: '/opt/homebrew/bin/node' })
    assert.ok(dirs.includes('/opt/homebrew/bin'), `dirname(process.execPath) 必须在候选里：${dirs.join(', ')}`)
    assert.equal(npmGlobalBinDirs({ env: { npm_config_prefix: '/srv/npm' } })[0], '/srv/npm/bin', 'npm_config_prefix 是 npm 自己会认的那个前缀')
  } finally {
    fx.cleanup()
  }
})

test('npm genuinely absent refuses as "not found on the searched paths", not as a permissions problem', () => {
  const fx = prefixMachine('binres-absent')
  try {
    // A hermetic "not anywhere": an empty PATH plus one real directory that holds nothing.
    const gone = checkNpmPrefix({ env: { PATH: '' }, dirs: [fx.empty] })
    assert.equal(gone.ok, false, JSON.stringify(gone))
    assert.equal(gone.cause, 'npm-not-found', `这才是真正的因由，得作为一个事实带出去：${JSON.stringify(gone)}`)
    assert.equal(gone.prefix, null, '问不出前缀就是问不出，不许留一个看起来读到了的值')
    assert.equal(gone.dir, null, '一个字节都没写过，就没有"哪个目录不能写"可点名')
    assert.match(gone.reason, /could not be found on the searched paths/, gone.reason)
    assert.ok(gone.tried.includes(path.join(fx.empty, 'npm')), `要点名搜过的那条路径：${JSON.stringify(gone.tried)}`)
    assert.doesNotMatch(gone.reason, /not writable|permission|EACCES/, `找不到就是找不到，不许说成权限：${gone.reason}`)
    assert.doesNotMatch(gone.reason, /npm config get prefix answered/, '127 是这条链上最没有信息量的一个数')
    assert.match(gone.reason, /Re-run the same command from a shell/, '补救必须是一次能执行的动作')

    // And with the repo's own measured launchd value, on a machine that really has no npm in it: the four
    // directories have to be named one by one, because that is the sentence that tells a person the job's
    // PATH is the thing to change.
    if (!launchdPathHasNpm) {
      const launchd = checkNpmPrefix({ env: { PATH: LAUNCHD_PATH }, dirs: [fx.empty] })
      assert.equal(launchd.ok, false)
      assert.equal(launchd.cause, 'npm-not-found', JSON.stringify(launchd))
      for (const dir of launchdDirs) {
        assert.ok(launchd.tried.includes(path.join(dir, 'npm')), `launchd 的 ${dir} 必须逐个被点名：${launchd.tried.join(', ')}`)
      }
      assert.match(launchd.reason, new RegExp(`PATH=${LAUNCHD_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '要说清这次是用哪条 PATH 跑的')
      assert.match(launchd.reason, /launchd job/, '定时作业拿到的是最小 PATH，这一点必须写在句子里')
    }
  } finally {
    fx.cleanup()
  }
})

/* ----------------------------------------------------- the §3.5 refusal, end to end */

/**
 * A machine with 1.4.0 installed and 1.4.1 staged, all under a temp directory — the same shape
 * `test/apply.test.mjs` builds, small enough to keep here because this file's point is the gate's sentence.
 */
function stagedFixture(label) {
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
    stagingDir,
    installedBytes: () => fs.readFileSync(path.join(appsDir, 'GlassPane Daemon.app', 'Contents', 'MacOS', 'binary'), 'utf8'),
    cleanup: () => removeDir(dir),
  }
}

test('a run that cannot find npm still installs the bundles, names the search, and stops blaming the prefix', async () => {
  const fx = stagedFixture('binres-refusal')
  const absent = prefixMachine('binres-refusal-absent')
  const kick = []
  const socketPath = shortSocketPath(fx.dir, 'refusal.sock')
  const daemon = await startSocketDaemon(socketPath, { behaviour: 'answer', version: '1.4.1' })
  try {
    const deps = {
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
      npm: () => assert.fail('预检已经答"这一趟找不到 npm"，全局层就不许再被碰'),
      // §11's step is replaced so this test keeps measuring §3.5's answer instead of starting to copy an
      // updater and re-register a launchd job.
      refreshRuntimeImpl: () => ({
        record: { status: 'refreshed', version: '1.4.1', cliPath: '/var/tmp/st/runtime/1.4.1/updater/cli.js', previousCliPath: null, agentVerified: true, at: NOW.toISOString(), code: null, detail: null },
        restored: { attempted: false, ok: true },
      }),
      // The real pre-flight, told to search a place with nothing in it: this is the daily job's situation,
      // and the sentence under test is what the gate builds out of the answer it gets back.
      preflightNpm: () => checkNpmPrefix({ env: { PATH: '' }, dirs: [absent.empty] }),
    }
    const result = await applyUpdate(deps)
    assert.equal(result.ok, true, result.message)
    assert.equal(result.status, 'applied', JSON.stringify(result))
    assert.equal(result.code, CODES.npmNotRefreshed, result.message)
    assert.equal(exitCodeFor(result), EXIT.OK, '应用换了、全局层没换 ⇒ 机器确实变了，不是 §7 的 3')
    assert.equal(kick.length, 1, 'daemon 重启了一次：这一格正是"部分成功"与"整场拒绝"的分别')
    assert.match(fx.installedBytes(), /NEW/, '~/Applications 上是新的那一份')
    assert.ok(fs.existsSync(writableRoots(fx.dir).backup), '换过东西就要有备份：这条路径与成功路径共用同一套回滚')

    assert.match(result.message, /could not be found on the searched paths/, result.message)
    assert.ok(result.message.includes(path.join(absent.empty, 'npm')), `句子要带着搜过的那条路径：${result.message}`)
    // The misattribution, pinned in the negative: the old sentence for this shape was the permissions one.
    assert.doesNotMatch(result.message, /cannot write where npm would put them/, '没找到 npm 的时候不许说"写不进去"：' + result.message)
    assert.doesNotMatch(result.message, /Check `npm config get prefix` from this account/, '不许把人支去看一个还没被问到的命令：' + result.message)
    assert.doesNotMatch(result.message, /not writable/, result.message)
    assert.match(result.message, /This is a PATH fact/, `要把真正的因由说出来：${result.message}`)
    assert.match(result.message, /line above from a shell whose PATH includes/, `补救要是一次能执行的动作：${result.message}`)
    assert.match(result.message, /npm install -g glasspane-mcp@1\.4\.1 glasspane-install@1\.4\.1/,
      '这一趟装不成的那两包，要把人手上能跑的那一行交出去')
    assert.doesNotMatch(result.message, /\bsudo\b/, 'remedy 不许交出可照抄执行的升权命令')

    const state = loadState(fx.dir).state
    assert.equal(state.current, '1.4.1', '面板读的是状态文件：版本号要说这次的换版')
    assert.equal(state.code, CODES.npmNotRefreshed, '面板读的是状态文件')
    assert.match(state.lastError.message, /could not be found on the searched paths/, '同一句话要落进记录里')
    assert.ok(String(state.lastError.details).includes('npm-not-found'), `因由要作为数据留在记录里：${state.lastError.details}`)
  } finally {
    await daemon.close()
    fx.cleanup()
    absent.cleanup()
  }
})

/* ------------------------------------------------------------------------- mcp.js */

test('the MCP half resolves glasspane-mcp through the same helper, and refuses without one', async () => {
  const fx = prefixMachine('binres-mcp')
  try {
    const mcpPath = path.join(fx.bin, 'glasspane-mcp')
    fs.writeFileSync(mcpPath, '#!/bin/sh\necho "glasspane-mcp fixture"\n')
    fs.chmodSync(mcpPath, 0o755)
    const peer = fakeMcpPeer('answer')
    const seen = []
    const spawnFn = (command, args, options) => {
      seen.push(command)
      return peer(command, args, options)
    }
    const answer = await mcpToolsList({
      spawnFn,
      resolveBin: resolveMcpBinary,
      env: { PATH: LAUNCHD_PATH },
      dirs: [fx.bin, fx.empty],
      timeoutMs: 5_000,
    })
    assert.equal(answer.ok, true, answer.reason)
    assert.deepEqual(seen, [mcpPath], `MCP 那一半也要走同一个搜索，拿到绝对路径：${JSON.stringify(seen)}`)
    assert.equal(answer.bin, mcpPath, '答案里要带着真正跑起来的那一份')

    // Nothing found: the refusal is made here, and the process selector is never reached — a doomed spawn
    // is how this call used to answer `could not run (ENOENT)` about a machine's PATH.
    const absent = await mcpToolsList({
      spawnFn: (command) => { throw new Error(`this call must not spawn anything, asked for ${command}`) },
      resolveBin: resolveMcpBinary,
      env: { PATH: '' },
      dirs: [fx.empty],
    })
    assert.equal(absent.ok, false)
    assert.equal(absent.notFound, true, JSON.stringify(absent))
    assert.match(absent.reason, /could not be found on the searched paths/, absent.reason)
    assert.ok(absent.tried.includes(path.join(fx.empty, 'glasspane-mcp')), `搜过的路径要在答案里：${JSON.stringify(absent.tried)}`)
    assert.doesNotMatch(absent.reason, /could not run \(/, '不是"跑坏了"，是"没有东西可跑"')

    // The default search knows where a global npm install puts the command, without asking npm.
    // 2026-10-28（CLI 契约 lane）：这里从前写的是 `env: { HOME: '/Users/dev' }`——那个家的读法本身
    // 就是缺陷（`$HOME` 是调用方可控的变量，而本产品每一处家目录都读**口令档案**：`updater/cli.js` 的
    // `recordHomeDir`、`mcp-shell/src/update-state.ts` 的 `recordHome`）。所以候选表现在按 `readRecord`
    // 注入同一个 `/Users/dev`，断言的内容（前缀 bin 必须在候选里、且排在 /usr/local/bin 前面）一字未改；
    // 多加的那两行闸的是新契约本身：同一个 `env.HOME` 现在不许再改变搜索表。
    const dirs = candidateDirsFor('glasspane-mcp', {
      env: { HOME: '/Users/somebody-elses-home', PATH: LAUNCHD_PATH },
      execPath: '/usr/local/bin/node',
      readRecord: () => '/Users/dev',
    })
    assert.ok(dirs.includes('/Users/dev/.npm-global/bin'), `npm 全局前缀的 bin 必须在候选里：${dirs.join(', ')}`)
    assert.ok(dirs.includes('/usr/local/bin'), '本机实测那一份就在这里')
    assert.ok(dirs.indexOf('/Users/dev/.npm-global/bin') < dirs.indexOf('/usr/local/bin'), '全局包落在前缀 bin，不在别处')
    assert.equal(dirs.some((d) => d.startsWith('/Users/somebody-elses-home')), false, `$HOME 又成了搜索表的输入：${dirs.join(', ')}`)
  } finally {
    fx.cleanup()
  }
})

/* ------------------------------------------------------------------ the other sites */

test('an unrunnable build tool is reported as missing, not as a build that failed', () => {
  const dir = tempDir(`${TMP_PREFIX}binres-swift-`)
  try {
    const empty = path.join(dir, 'nowhere')
    fs.mkdirSync(empty, { recursive: true })
    fs.mkdirSync(path.join(dir, 'engine'), { recursive: true })
    const outcome = buildStagedTree(dir, {
      // The real runner, told to search a PATH that holds nothing: `swift` is the third bare name
      // `lib/apply.js` spawns, and the daily job is in the same position for it as for npm.
      run: (bin, args, options) => defaultRun(bin, args, { ...options, env: { PATH: '' }, dirs: [empty] }),
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.message, /the build could not be started/, outcome.message)
    assert.match(outcome.message, /could not be found on the searched paths/, outcome.message)
    assert.doesNotMatch(outcome.message, /swift build -c release exited null/, '"exited null" 把一个没找到的工具说成一次失败的构建')
  } finally {
    removeDir(dir)
  }
})

test('npm not found says so at every call site, rather than reporting exit null', () => {
  const dir = tempDir(`${TMP_PREFIX}binres-sites-`)
  try {
    const empty = path.join(dir, 'nowhere')
    fs.mkdirSync(empty, { recursive: true })
    const notFound = (bin, args, options) => defaultRun(bin, args, { ...options, env: { PATH: '' }, dirs: [empty] })

    const versions = defaultReadGlobalVersions({ run: notFound })
    assert.equal(versions.ok, false, JSON.stringify(versions))
    assert.match(versions.message, /npm ls -g --json could not be run/, versions.message)
    assert.match(versions.message, /could not be found on the searched paths/, versions.message)

    // `installNpmPackages` reaches the pack step before any global call, so give it a real staged tree.
    const staged = path.join(dir, 'tree')
    for (const rel of ['mcp-shell', 'installer']) {
      fs.mkdirSync(path.join(staged, rel), { recursive: true })
      fs.writeFileSync(
        path.join(staged, rel, 'package.json'),
        JSON.stringify({ name: rel === 'mcp-shell' ? 'glasspane-mcp' : 'glasspane-install', version: '1.4.1', bin: './cli.js' }),
      )
      fs.writeFileSync(path.join(staged, rel, 'cli.js'), '// nothing\n')
    }
    const packed = installNpmPackages({ stagedTree: staged, run: notFound })
    assert.equal(packed.ok, false, JSON.stringify(packed))
    assert.equal(packed.code, CODES.npmVersionMismatch, '仍走 §7 已有的那一条码，不新增')
    assert.match(packed.message, /npm pack in .* could not be run: npm could not be found on the searched paths/, packed.message)
    assert.doesNotMatch(packed.message, /exit null/, packed.message)
  } finally {
    removeDir(dir)
  }
})

test('every bare command updater/lib spawns is either searched or provably inside the launchd PATH', () => {
  // The enumeration is the fix's scope, so it is gated rather than checked once: a new `run('something')`
  // in `lib/` that a daily job cannot reach has to fail here, not in the field.
  const libDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib')
  const files = fs.readdirSync(libDir).filter((name) => name.endsWith('.js')).sort()
  assert.ok(files.length >= 8, `只认出 ${files.length} 个 lib 文件，这条闸已经不作数了`)
  // The allowlist explains itself: searched by this module, or living in a directory the minimal job PATH
  // does contain. Anything else is a new bare-name spawn and must join the search.
  const KNOWN = {
    npm: 'searched by lib/binaries.js',
    'glasspane-mcp': 'searched by lib/binaries.js',
    swift: 'searched by lib/binaries.js',
    gpg: 'searched by lib/signature.js — GPG_CANDIDATE_PATHS, with a --version probe this tool needs and npm does not',
    id: '/usr/bin/id',
    launchctl: { path: '/bin/launchctl', platform: 'darwin' },
    security: { path: '/usr/bin/security', platform: 'darwin' },
  }
  const found = []
  for (const name of files) {
    const raw = fs.readFileSync(path.join(libDir, name), 'utf8')
    const body = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
    for (const match of body.matchAll(/\b(?:defaultRun|runGpg|runner|run|spawnSync|spawnFn|spawn|execFile)\(\s*['"]([a-z][a-z0-9._-]*)['"]/g)) {
      found.push({ file: name, bin: match[1] })
    }
  }
  assert.ok(found.length >= 8, `只认出 ${found.length} 处裸命令调用，这条闸已经看不见东西：${JSON.stringify(found)}`)
  const unknown = [...new Set(found.map((one) => one.bin))].filter((bin) => !(bin in KNOWN))
  assert.deepEqual(unknown, [], `这些命令名是新出现的裸调用，需要被搜索或被解释（出现在 ${JSON.stringify(found)}）`)
  for (const [bin, claim] of Object.entries(KNOWN)) {
    const where = typeof claim === 'string' ? claim : claim.path
    if (where.startsWith('searched by')) {
      if (bin === 'gpg') continue
      assert.ok(SEARCHED_COMMANDS.includes(bin), `${bin} 声称被 lib/binaries.js 搜索，却不在 SEARCHED_COMMANDS 里`)
      continue
    }
    // 「最小 PATH 里就有」是一个**关于某个平台**的说法：launchctl 与 security 是 macOS 的
    // 系统二进制，ubuntu runner 上根本没有这两个文件——本条闸在两种 runner 上都该判得动，
    // 所以按平台要求存在性，而目录必须在最小 PATH 里这一半永远成立。
    // 反向变异：把 `id` 改成 `/usr/local/bin/id`（不在最小 PATH）→ 两种平台都红。
    if (claim.platform === 'darwin' && process.platform !== 'darwin') {
      console.log(`# platform-scoped: ${bin} 声称在 ${where}，那是 macOS 的系统二进制；本平台只核目录归属`)
    } else {
      assert.ok(fs.existsSync(where), `${bin} 声称在 ${where}，那儿没有这个文件——它就不该被算作"最小 PATH 够用"`)
    }
    assert.ok(launchdDirs.includes(path.dirname(where)), `${bin} 的 ${where} 不在 launchd 的最小 PATH 里，必须改成被搜索的名字`)
  }
})
