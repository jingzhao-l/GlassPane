/**
 * §11 — the updater's own installed copy.
 *
 * The gap this closes is concrete and embarrassing: `apply` swapped the `.app` bundles and the npm
 * packages and never touched the code the daily job runs (`update-install.json` → `updaterCli`), so a
 * release whose content was "fix the updater" could not reach a machine by updating. That means every
 * gate in this file is about **what is on disk after the fact**: the pointer read back from the file,
 * the tree actually copied, the argv the registration process was handed, and the answer launchd gave
 * about the loaded job. A returned object is not evidence.
 *
 * Only two things are injected — the `enable` spawn and `launchctl print` — because both touch this
 * machine. Everything else (copy, rename, mode, pointer write, prune) is the production path against
 * a real temporary state root.
 *
 * REVERSE MUTATION (all measured red, see /var/tmp/gp-iterate-gates/mutate_r12d.py):
 *   · flip the pointer before copying              → `a failed registration puts the pointer back`
 *   · claim verified when launchd cannot be read   → `an unreadable loaded job is a stated failure`
 *   · register with the OLD copy                   → `the new copy is the one that registers itself`
 *   · skip the restore                             → `the job is put back on the previous updater`
 *   · accept a tree with no cli.js                 → `a copy without a readable entry point is refused`
 *   · prune the generation the pointer names       → `only older generations are removed`
 *   · register even when the machine is switched off → `a hard-off machine gets code, not a job`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  RUNTIME_KEEP,
  defaultRunEnable,
  RUNTIME_STATUSES,
  materializeRuntime,
  pruneRuntime,
  refreshRuntime,
  runtimeCliPath,
  runtimeTreePath,
  runtimeVersionOf,
} from '../lib/runtime.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError, writableRoots } from '../lib/fsutil.js'
import { AGENT_LABEL } from '../lib/launchd.js'
import { readPointer, writePointer } from '../lib/state.js'
import { TMP_PREFIX, removeDir, tempDir } from './helpers.mjs'

const NOW = () => new Date('2026-10-01T02:00:00.000Z')

function root(label) {
  return path.resolve(tempDir(`${TMP_PREFIX}runtime-${label}-`))
}

/** A minimal "release tree": what §11 is allowed to copy is a verified release root. */
function makeReleaseTree(dir, { version = '1.5.0', cliBody = 'console.log("ok")\n', extra = {} } = {}) {
  fs.mkdirSync(path.join(dir, 'updater', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@glasspane/monorepo', version }) + '\n')
  fs.writeFileSync(path.join(dir, 'updater', 'cli.js'), cliBody)
  fs.writeFileSync(path.join(dir, 'updater', 'lib', 'state.js'), 'export const x = 1\n')
  for (const [name, text] of Object.entries(extra)) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  return dir
}

function seedPointer(stateRoot, { updaterCli, installRoot }) {
  writePointer(stateRoot, { updaterCli, installRoot, agentLabel: AGENT_LABEL }, { now: NOW() })
}

const okEnable = () => ({ ok: true, message: null, parsed: { ok: true }, argv: [] })
const loadedWith = (cli) => ({ ok: true, args: ['/bin/sh', '-c', '"$0" "$1" check', process.execPath, cli] })

/* ---------------------------------------------------------------- materialize */

test('the verified release tree is copied into a version directory and read back as runnable', () => {
  const stateRoot = root('copy-')
  const source = makeReleaseTree(path.join(root('src-'), 'GlassPane-1.5.0'), { extra: { 'installer/cli.js': 'export const key = 1\n' } })
  try {
    const got = materializeRuntime({ stateRoot, sourceTree: source, version: '1.5.0' })
    assert.equal(got.ok, true, got.message)
    assert.equal(got.treePath, path.join(stateRoot, 'runtime', '1.5.0'))
    assert.equal(fs.readFileSync(runtimeCliPath(got.treePath), 'utf8'), 'console.log("ok")\n', '字节必须一模一样地落进来')
    assert.equal(fs.existsSync(path.join(got.treePath, 'installer', 'cli.js')), true,
      '签名那条腿要动态 import 安装器里的那把公钥，落地少一个文件就是装上一个跑不起来的更新器')
    assert.equal(fs.statSync(got.treePath).mode & 0o777, 0o700, 'runtime 目录是别人可以改的代码位置：owner-only')
    assert.equal(fs.statSync(writableRoots(stateRoot).runtime).mode & 0o777, 0o700)
    assert.deepEqual(fs.readdirSync(writableRoots(stateRoot).runtime).filter((n) => n.startsWith('.')), [],
      '临时目录必须被 rename 消耗掉，留在树上就是一次没完成的安装')
    assert.equal(fs.existsSync(path.join(source, 'updater', 'cli.js')), true, '来源（暂存树）不许被搬走——它还要被清理逻辑处理')
  } finally {
    removeDir(stateRoot)
    removeDir(path.dirname(source))
  }
})

test('a copy that has no readable entry point is refused and never renamed into place', () => {
  const stateRoot = root('nocli-')
  const source = path.join(root('src2-'), 'GlassPane-9.9.9')
  fs.mkdirSync(path.join(source, 'updater'), { recursive: true })
  fs.writeFileSync(path.join(source, 'package.json'), '{}')
  try {
    const got = materializeRuntime({ stateRoot, sourceTree: source, version: '9.9.9' })
    assert.equal(got.ok, false, '没有 updater/cli.js 的树不能算装上了')
    assert.equal(got.code, CODES.stateWriteUnverified)
    assert.equal(fs.existsSync(path.join(stateRoot, 'runtime', '9.9.9')), false, '拒绝的落地不许留在树上')
  } finally {
    removeDir(stateRoot)
    removeDir(path.dirname(source))
  }
})

test('a version string becomes a path only after it passes the shape check', () => {
  const stateRoot = root('evil-')
  try {
    for (const bad of ['../escape', 'v1.2.3', '1.2', '', null, '1.2.3.4', '/abs']) {
      assert.throws(() => runtimeTreePath(stateRoot, bad), (error) => error instanceof UpdaterError && error.code === CODES.tagUnparseable,
        `${JSON.stringify(bad)} 不该变成一个目录名`)
    }
    assert.deepEqual(fs.readdirSync(stateRoot), [], '什么也不许留下')
  } finally {
    removeDir(stateRoot)
  }
})

/* -------------------------------------------------------------------- prune */

test('only older generations are removed, and the pointer\'s own directory never is', () => {
  const stateRoot = root('prune-')
  const runtime = writableRoots(stateRoot).runtime
  try {
    for (const version of ['1.5.0', '1.4.9', '1.4.8', '1.4.7']) fs.mkdirSync(path.join(runtime, version), { recursive: true })
    fs.mkdirSync(path.join(runtime, '.1.5.1.new-4242'), { recursive: true })
    fs.writeFileSync(path.join(runtime, 'notes.txt'), 'not a generation')
    const got = pruneRuntime({ stateRoot, keep: '1.5.0' })
    assert.deepEqual(got.removed, ['1.4.8', '1.4.7'], `留两代（${RUNTIME_KEEP}），其余按版本从新到旧排：${JSON.stringify(got)}`)
    assert.deepEqual(got.failed, [])
    assert.equal(fs.existsSync(path.join(runtime, '1.5.0')), true, '指针指的那一代被删了 —— 下一次注册会立刻找不到代码')
    assert.equal(fs.existsSync(path.join(runtime, '1.4.9')), true, '上一代要留着当回退对象')
    assert.equal(fs.existsSync(path.join(runtime, '1.4.8')), false)
    assert.equal(fs.existsSync(path.join(runtime, '.1.5.1.new-4242')), true, '半成品目录不在世代里，交给它自己的清理路径')
    assert.equal(fs.existsSync(path.join(runtime, 'notes.txt')), true, '不是版本目录的东西一律不碰')
  } finally {
    removeDir(stateRoot)
  }
})

/* ------------------------------------------------------------------ refresh */

test('the new copy registers itself, the loaded job is read back, and the pointer names a file that exists', async () => {
  const stateRoot = root('happy-')
  const previous = makeReleaseTree(path.join(root('prev-'), 'updater-parent'), { version: '1.4.0' })
  const source = makeReleaseTree(path.join(root('src3-'), 'GlassPane-1.5.0'))
  const previousCli = path.join(previous, 'updater', 'cli.js')
  const calls = []
  try {
    seedPointer(stateRoot, { updaterCli: previousCli, installRoot: previous })
    const { record, restored } = await refreshRuntime({
      stateRoot,
      version: '1.5.0',
      sourceTree: source,
      runEnable: (options) => {
        calls.push(options.cliPath)
        return okEnable()
      },
      readRunningJob: () => loadedWith(runtimeCliPath(runtimeTreePath(stateRoot, '1.5.0'))),
      now: NOW,
    })
    assert.equal(record.status, 'refreshed', JSON.stringify(record))
    assert.equal(record.agentVerified, true)
    assert.equal(restored.attempted, false)

    const pointer = readPointer(stateRoot)
    assert.equal(pointer.ok, true, pointer.message)
    assert.equal(pointer.pointer.updaterCli, record.cliPath, '指针与记录必须说同一个路径')
    assert.equal(fs.existsSync(pointer.pointer.updaterCli), true, '指针指的文件必须真在盘上')
    assert.equal(pointer.pointer.installRoot, runtimeTreePath(stateRoot, '1.5.0'))
    assert.equal(calls[0], pointer.pointer.updaterCli, '注册必须由新那份代码自己做')
    assert.notEqual(calls[0], previousCli)
  } finally {
    removeDir(stateRoot)
    removeDir(previous)
    removeDir(path.dirname(source))
  }
})

test('an unreadable loaded job is a stated failure, not a success', async () => {
  const stateRoot = root('unknown-')
  const previous = makeReleaseTree(path.join(root('prev2-'), 'updater-parent'), { version: '1.4.0' })
  const source = makeReleaseTree(path.join(root('src4-'), 'GlassPane-1.5.0'))
  const previousCli = path.join(previous, 'updater', 'cli.js')
  const calls = []
  try {
    seedPointer(stateRoot, { updaterCli: previousCli, installRoot: previous })
    const { record, restored } = await refreshRuntime({
      stateRoot,
      version: '1.5.0',
      sourceTree: source,
      runEnable: (o) => { calls.push(o.cliPath); return okEnable() },
      readRunningJob: () => ({ unknown: true, reason: 'launchctl print: Could not find service' }),
      now: NOW,
    })
    assert.equal(record.status, 'failed')
    assert.equal(record.code, CODES.runtimeStale)
    assert.match(record.detail, /could not be read back/)
    assert.equal(restored.attempted, true, '读不回来就必须退回去，不能留着"新地址 + 没作业"这个形状')
    assert.equal(readPointer(stateRoot).pointer.updaterCli, previousCli, '指针必须回到旧那份')
    assert.deepEqual(calls.map((c) => c === previousCli), [false, true], '第二次注册要用旧那份把作业指回去')
  } finally {
    removeDir(stateRoot)
    removeDir(previous)
    removeDir(path.dirname(source))
  }
})

test('a loaded job that still names the old command line is a failure too', async () => {
  const stateRoot = root('stale-')
  const previous = makeReleaseTree(path.join(root('prev3-'), 'updater-parent'), { version: '1.4.0' })
  const source = makeReleaseTree(path.join(root('src5-'), 'GlassPane-1.5.0'))
  const previousCli = path.join(previous, 'updater', 'cli.js')
  try {
    seedPointer(stateRoot, { updaterCli: previousCli, installRoot: previous })
    const { record } = await refreshRuntime({
      stateRoot,
      version: '1.5.0',
      sourceTree: source,
      runEnable: okEnable,
      readRunningJob: () => loadedWith(previousCli),
      now: NOW,
    })
    assert.equal(record.status, 'failed', 'launchd 说的还是旧路径，就不能说换成了新的')
    assert.match(record.detail, /still names the old command line/)
    assert.equal(readPointer(stateRoot).pointer.updaterCli, previousCli)
  } finally {
    removeDir(stateRoot)
    removeDir(previous)
    removeDir(path.dirname(source))
  }
})

test('a failed registration puts the pointer back before anything else is decided', async () => {
  const stateRoot = root('refused-')
  const previous = makeReleaseTree(path.join(root('prev4-'), 'updater-parent'), { version: '1.4.0' })
  const source = makeReleaseTree(path.join(root('src6-'), 'GlassPane-1.5.0'))
  const previousCli = path.join(previous, 'updater', 'cli.js')
  const enableCalls = []
  try {
    seedPointer(stateRoot, { updaterCli: previousCli, installRoot: previous })
    const { record, restored } = await refreshRuntime({
      stateRoot,
      version: '1.5.0',
      sourceTree: source,
      runEnable: (o) => {
        enableCalls.push(o.cliPath)
        return o.cliPath === previousCli ? okEnable() : { ok: false, message: 'the new updater refused: state root is not writable' }
      },
      readRunningJob: () => loadedWith(previousCli),
      now: NOW,
    })
    assert.equal(record.status, 'failed')
    assert.match(record.detail, /refused: state root is not writable/, '注入的那句失败原因必须原话带出来')
    assert.equal(restored.ok, true)
    assert.equal(enableCalls.length, 2, '新那份失败之后必须再用旧那份注册一次')
    assert.equal(readPointer(stateRoot).pointer.updaterCli, previousCli)
    // 落地的那一代留在盘上（它是这次复制的产物），但没人指向它：这是可诊断的形状，不是半装的更新器。
    assert.equal(fs.existsSync(runtimeCliPath(runtimeTreePath(stateRoot, '1.5.0'))), true)
  } finally {
    removeDir(stateRoot)
    removeDir(previous)
    removeDir(path.dirname(source))
  }
})

test('a hard-off machine gets the new code and the pointer, and no job', async () => {
  const stateRoot = root('disabled-')
  const previous = makeReleaseTree(path.join(root('prev5-'), 'updater-parent'), { version: '1.4.0' })
  const source = makeReleaseTree(path.join(root('src7-'), 'GlassPane-1.5.0'))
  const previousCli = path.join(previous, 'updater', 'cli.js')
  let enabled = 0
  try {
    seedPointer(stateRoot, { updaterCli: previousCli, installRoot: previous })
    const { record } = await refreshRuntime({
      stateRoot,
      version: '1.5.0',
      sourceTree: source,
      disabled: true,
      runEnable: () => { enabled += 1; return okEnable() },
      readRunningJob: () => ({ unknown: true, reason: 'must not be asked' }),
      now: NOW,
    })
    assert.equal(record.status, 'kept', JSON.stringify(record))
    assert.equal(enabled, 0, '关掉自动更新的机器上，这一步不许注册任何作业')
    assert.equal(record.code, CODES.autoDisabled, '但这句话必须留在状态里')
    assert.equal(readPointer(stateRoot).pointer.updaterCli, runtimeCliPath(runtimeTreePath(stateRoot, '1.5.0')),
      '面板跑的就是指针那份代码：关了定时作业也要让它拿到新的')
  } finally {
    removeDir(stateRoot)
    removeDir(previous)
    removeDir(path.dirname(source))
  }
})

test('no pointer means no authority to move: nothing is materialized and the reason is the installer', async () => {
  const stateRoot = root('nopointer-')
  const source = makeReleaseTree(path.join(root('src8-'), 'GlassPane-1.5.0'))
  try {
    const { record } = await refreshRuntime({
      stateRoot, version: '1.5.0', sourceTree: source, runEnable: () => assert.fail('不该注册'), now: NOW,
    })
    assert.equal(record.status, 'failed')
    assert.equal(record.code, CODES.pointerMissing, `缺指针要说的是"重装"，不是"更新器坏了"：${record.code}`)
    assert.match(record.detail, /installer/i)
    assert.equal(fs.existsSync(writableRoots(stateRoot).runtime), false, '没有真源就别先造一份没主目录')
  } finally {
    removeDir(stateRoot)
    removeDir(path.dirname(source))
  }
})

test('a pointer that cannot be rewritten leaves the previous one intact and says so', async () => {
  const stateRoot = root('writefail-')
  const previous = makeReleaseTree(path.join(root('prev6-'), 'updater-parent'), { version: '1.4.0' })
  const source = makeReleaseTree(path.join(root('src9-'), 'GlassPane-1.5.0'))
  const previousCli = path.join(previous, 'updater', 'cli.js')
  try {
    seedPointer(stateRoot, { updaterCli: previousCli, installRoot: previous })
    const { record } = await refreshRuntime({
      stateRoot,
      version: '1.5.0',
      sourceTree: source,
      writePointerImpl: () => { throw new UpdaterError(CODES.stateWriteUnverified, 'disk full') },
      runEnable: () => assert.fail('指针没换成就不该注册'),
      now: NOW,
    })
    assert.equal(record.status, 'failed')
    assert.match(record.detail, /pointer could not be rewritten/)
    assert.equal(readPointer(stateRoot).pointer.updaterCli, previousCli, '写失败之后旧指针必须还是那个（临时文件 + rename 的意义就在这）')
  } finally {
    removeDir(stateRoot)
    removeDir(previous)
    removeDir(path.dirname(source))
  }
})

/* ------------------------------------- 真起子进程的注册（argv 与答案都要按真形状读） */

/**
 * `defaultRunEnable` 是这次换版里唯一"起另一个进程去做一件事"的一步，所以它按真进程测：
 * argv 逐字、答案读那一行 JSON、非零退出与被信号打死都必须是不成功。前一轮的教训同形
 * （假流不听 abort ⇒ 计时器形同不存在而测试仍绿）——假的 spawn 只能证明我以为的语义。
 */
test('the real enable step spawns the new script with the exact argv and reads one JSON line', () => {
  const dir = root('spawn-')
  const stateRoot = path.join(dir, 'state')
  fs.mkdirSync(stateRoot, { recursive: true })
  const cli = path.join(dir, 'cli.js')
  try {
    fs.writeFileSync(cli, 'process.stdout.write(JSON.stringify({ ok: true, status: "registered" }) + "\\n")\n')
    const ok = defaultRunEnable({ cliPath: cli, stateRoot })
    assert.equal(ok.ok, true, JSON.stringify(ok))
    assert.deepEqual(ok.argv, [cli, 'enable', '--state-dir', stateRoot, '--json'],
      'argv 逐字：少一个 --json 就没人读得到答案，少 --state-dir 就会去动别人的状态根')

    fs.writeFileSync(cli, 'process.stdout.write("not json at all\\n"); process.exit(1)\n')
    const junk = defaultRunEnable({ cliPath: cli, stateRoot })
    assert.equal(junk.ok, false)
    assert.match(junk.message, /refused to register itself/, '一句读不懂的答案必须是不成功，不能是"大概成了"')

    fs.writeFileSync(cli, 'process.exit(0)\n')
    const silent = defaultRunEnable({ cliPath: cli, stateRoot })
    assert.equal(silent.ok, false, '退出码 0 但没有那一行 JSON，同样不能算注册成功')

    fs.writeFileSync(cli, 'process.abort()\n')
    const killed = defaultRunEnable({ cliPath: cli, stateRoot })
    assert.equal(killed.ok, false, '被信号打死的注册绝不能算成功')
    assert.match(killed.message, /signal/)

    const missing = defaultRunEnable({ cliPath: path.join(dir, 'no-such-cli.js'), stateRoot })
    assert.equal(missing.ok, false)
    assert.match(missing.message, /Cannot find module|could not be started/i,
      `指到一个不存在的脚本要说得出是哪个文件：${missing.message}`)
  } finally {
    removeDir(dir)
  }
})

test('a scheduled run moves the code and the pointer but does not re-register the job from inside itself', async () => {
  const stateRoot = root('defer-')
  const previous = makeReleaseTree(path.join(root('prev7-'), 'updater-parent'), { version: '1.4.0' })
  const source = makeReleaseTree(path.join(root('src10-'), 'GlassPane-1.5.0'))
  const previousCli = path.join(previous, 'updater', 'cli.js')
  const enableCalls = []
  try {
    seedPointer(stateRoot, { updaterCli: previousCli, installRoot: previous })
    const { record } = await refreshRuntime({
      stateRoot,
      version: '1.5.0',
      sourceTree: source,
      handover: 'defer',
      runEnable: (o) => { enableCalls.push(o.cliPath); return okEnable() },
      readRunningJob: () => ({ ok: true, args: [previousCli] }),
      now: NOW,
    })
    assert.equal(record.status, 'skipped', JSON.stringify(record))
    assert.equal(record.code, CODES.runtimeRegistrationPending)
    assert.notEqual(record.status, 'kept', "'kept' 留给这台机器自己关掉的情况；这次是本轮主动跳过交接")
    assert.equal(record.agentVerified, false, '没有把作业交出去，就不许在状态里说它被核实过')
    assert.deepEqual(enableCalls, [], 'bootout/bootstrap 不许在这次运行里发生：那就是把自己的作业在半路拆掉')
    assert.equal(readPointer(stateRoot).pointer.updaterCli, record.cliPath, '代码与指针照换——面板跑的就是这份')
    assert.match(record.detail, /the next time "updater enable" runs/, `要说清下一步是谁做的：${record.detail}`)
  } finally {
    removeDir(stateRoot)
    removeDir(previous)
    removeDir(path.dirname(source))
  }
})

test('pruning never deletes a generation something still points at', async () => {
  const stateRoot = root('prune-pointed-')
  const runtime = writableRoots(stateRoot).runtime
  const source = makeReleaseTree(path.join(root('src11-'), 'GlassPane-1.5.0'))
  try {
    assert.equal(runtimeVersionOf(path.join(runtime, '1.4.9', 'updater', 'cli.js'), runtime), '1.4.9')
    assert.equal(runtimeVersionOf('/Users/x/glasspane/updater/cli.js', runtime), null,
      '安装那趟 clone 里的路径不属于 runtime，不能被当世代')
    // 三代都在：作业仍指着 1.4.9，新的落到 1.5.0，1.4.8 才是可以清的。
    // 三代旧 + 一代新：作业那一代（1.4.8）排在第三新，所以「只留最新两代」会把它删掉。
    // 这样这条控制才有牙齿——第一版夹具里它是第二新，于是不管钉不钉都活得下来，电池扫出来是绿的。
    for (const v of ['1.4.7', '1.4.8', '1.4.9']) fs.mkdirSync(path.join(runtime, v, 'updater'), { recursive: true })
    // 作业那一份刻意放在**最旧**那一代：不钉住它就一定被"最新两代"挤掉，这条控制才有牙齿。
    const pointedCli = path.join(runtime, '1.4.7', 'updater', 'cli.js')
    fs.mkdirSync(path.dirname(pointedCli), { recursive: true })
    fs.writeFileSync(pointedCli, 'OLD JOB COPY\n')
    seedPointer(stateRoot, { updaterCli: pointedCli, installRoot: path.join(runtime, '1.4.7') })
    const { record } = await refreshRuntime({
      stateRoot, version: '1.5.0', sourceTree: source, handover: 'defer',
      runEnable: () => assert.fail('defer 那一支不许注册'), now: NOW,
    })
    assert.equal(record.status, 'skipped', JSON.stringify(record))
    assert.equal(fs.existsSync(path.join(runtime, '1.5.0')), true, '新落地的要在')
    assert.equal(fs.existsSync(pointedCli), true,
      '作业还指着的那一代不能被删 —— 删了就是「自动更新是开的，明早却没有作业可跑」')
    assert.equal(fs.existsSync(path.join(runtime, '1.4.8')), false, '没人指的那一代要清掉，不留无界的磁盘堆积')
  } finally {
    removeDir(stateRoot)
    removeDir(path.dirname(source))
  }
})

test('a tree that cannot be installed stops before the pointer moves', async () => {
  const stateRoot = root('matfail-')
  const previous = makeReleaseTree(path.join(root('prev8-'), 'updater-parent'), { version: '1.4.0' })
  const previousCli = path.join(previous, 'updater', 'cli.js')
  // 来源树里没有 updater/cli.js：这就是「档案解开了但不是那份代码」的形状。
  const broken = path.join(root('src12-'), 'GlassPane-1.5.0')
  fs.mkdirSync(path.join(broken, 'updater'), { recursive: true })
  fs.writeFileSync(path.join(broken, 'package.json'), '{}')
  try {
    seedPointer(stateRoot, { updaterCli: previousCli, installRoot: previous })
    const { record, restored } = await refreshRuntime({
      stateRoot, version: '1.5.0', sourceTree: broken,
      runEnable: () => assert.fail('落地都没成，不该去注册'), now: NOW,
    })
    assert.equal(record.status, 'failed', JSON.stringify(record))
    assert.equal(record.code, CODES.stateWriteUnverified)
    assert.match(String(record.detail), /no readable updater\/cli.js|copying the verified release tree failed/,
      `要说清是哪一步没成：${record.detail}`)
    assert.equal(restored.attempted, false, '还没动过指针，就谈不上回退')
    assert.equal(readPointer(stateRoot).pointer.updaterCli, previousCli, '指针必须还是旧那一份')
    assert.deepEqual(fs.readdirSync(writableRoots(stateRoot).runtime).filter((n) => n.startsWith('.')), [],
      '失败的那一次不许留下半成品目录')
  } finally {
    removeDir(stateRoot)
    removeDir(previous)
    removeDir(path.dirname(broken))
  }
})
