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
  runtimeRoot,
  runtimeTreePath,
  runtimeVersionOf,
} from '../lib/runtime.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError, writableRoots } from '../lib/fsutil.js'
import { AGENT_LABEL } from '../lib/launchd.js'
import { readPointer, writePointer } from '../lib/state.js'
import { SCHEMA_PATH } from '../lib/schema.js'
import { undoHandover } from '../lib/runtime.js'
import { canonicalPath } from '../lib/fsutil.js'
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
  // what a real staged tree holds by the time §11 runs: `apply` built inside it and packed the npm
  // layers out of it, so a copy of "the whole tree" is a copy of build products.
  fs.mkdirSync(path.join(dir, 'engine', '.build', 'release'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'engine', '.build', 'release', 'GlassPane.app-arm64.zip'), 'BUILD PRODUCT\n')
  fs.mkdirSync(path.join(dir, 'mcp-shell', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'mcp-shell', 'dist', 'index.js'), 'export const mcp = 1\n')
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

test('the closed enum, the shipped schema, and the four producers are one list', async () => {
  // `RUNTIME_STATUSES` was imported into this file and never used: the vocabulary the writer produces,
  // the vocabulary the shipped schema publishes, and the vocabulary the panel and `gp_diagnose` decode
  // were three lists with nothing tying them together. Deleting `'skipped'` from `runtime.js` — which
  // is exactly what the deferred handover produces — left the whole updater suite green. This is the tie.
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  const branches = [schema.properties.runtime, ...(schema.properties.runtime.anyOf ?? [])]
  const declared = branches.flatMap((branch) => branch.properties?.status?.enum ?? [])
  assert.ok(declared.length > 0, 'schema 里那份 runtime.status 枚举读到了吗')
  assert.deepEqual([...RUNTIME_STATUSES].sort(), [...new Set(declared)].sort(),
    'runtime.js 的封闭枚举与 schema 里那份必须一模一样，多一个少一个都算漂移')

  // Every member needs a call that reaches it, or it is a value no reader will ever be shown and a
  // branch no test can cover.
  const reached = {}
  for (const kind of ['refreshed', 'skipped', 'kept', 'failed']) {
    const fx = seededRoot(`enum-${kind}-`)
    try {
      const { record } = await refreshRuntime(enumCall(kind, fx))
      reached[kind] = record.status
      assert.equal(record.status, kind, `${kind} 的生产者答了别的：${JSON.stringify(record)}`)
    } finally {
      fx.cleanup()
    }
  }
  assert.deepEqual(Object.values(reached).sort(), [...RUNTIME_STATUSES].sort())
})

/** A state root with a pointer already in it, which is what every §11 run starts from. */
function seededRoot(label) {
  const stateRoot = root(label)
  const previousRoot = root(`${label}clone-`)
  const previousCli = path.join(previousRoot, 'updater', 'cli.js')
  fs.mkdirSync(path.dirname(previousCli), { recursive: true })
  fs.writeFileSync(previousCli, 'PREVIOUS UPDATER\n')
  seedPointer(stateRoot, { updaterCli: previousCli, installRoot: previousRoot })
  const source = makeReleaseTree(path.join(root(`${label}src-`), 'GlassPane-1.5.0'))
  return {
    stateRoot,
    previousCli,
    previousRoot,
    sourceTree: source,
    version: '1.5.0',
    cleanup: () => {
      removeDir(stateRoot)
      removeDir(previousRoot)
      removeDir(path.dirname(source))
    },
  }
}

/** The smallest call that makes `refreshRuntime` answer with each member of the enum. */
function enumCall(kind, fx) {
  if (kind === 'failed') return { ...fx, sourceTree: path.join(root('failed-nothing-src-'), 'absent'), runEnable: () => assert.fail('落地都失败了，一次都不该注册') }
  if (kind === 'kept') return { ...fx, disabled: true, runEnable: () => assert.fail('关着的机器不该注册') }
  if (kind === 'skipped') return { ...fx, handover: 'defer', readRunningJob: () => loadedWith(fx.previousCli), runEnable: () => assert.fail('defer 那一支不许注册') }
  return {
    ...fx,
    runEnable: () => ({ ok: true, message: null, parsed: { ok: true } }),
    readRunningJob: () => loadedWith(path.join(fx.stateRoot, 'runtime', '1.5.0', 'updater', 'cli.js')),
  }
}

test('undoHandover gives the pointer and the loaded job back to the previous copy', async () => {
  // The half of a post-handover rollback that `apply`'s catch used to leave undone: the `.app` bundles
  // go back while `update-install.json` and launchd still name the version that was just rolled out of
  // ~/Applications. A record saying "restored and verified" about that machine is a lie about the
  // updater, even though it is true about the app.
  const fx = seededRoot('undo-')
  const calls = []
  try {
    // 交接之后、回退之前：新那一份确实在盘上，指针也确实指着它——这就是 undo 要处理的现场。
    const landedCli = path.join(runtimeRoot(fx.stateRoot), '1.5.0', 'updater', 'cli.js')
    fs.mkdirSync(path.dirname(landedCli), { recursive: true })
    fs.writeFileSync(landedCli, 'NEW UPDATER\n')
    writePointer(fx.stateRoot, { updaterCli: landedCli, installRoot: runtimeRoot(fx.stateRoot), agentLabel: AGENT_LABEL }, { now: NOW() })
    const flipped = readPointer(fx.stateRoot)
    assert.equal(flipped.ok, true, flipped.message)
    assert.equal(flipped.pointer.updaterCli, landedCli, '这一步的起点是"指针已经换到新那一份"')
    const got = await undoHandover({
      stateRoot: fx.stateRoot,
      previousPointer: { updaterCli: fx.previousCli, installRoot: fx.previousRoot ?? path.dirname(path.dirname(fx.previousCli)), agentLabel: AGENT_LABEL, registeredAt: '2026-09-20T00:00:00.000Z' },
      version: '1.5.0',
      runEnable: ({ cliPath }) => { calls.push(cliPath); return { ok: true, message: null, parsed: { ok: true } } },
      readRunningJob: () => loadedWith(fx.previousCli),
      now: NOW,
    })
    assert.equal(got.ok, true, JSON.stringify(got))
    assert.deepEqual(calls, [fx.previousCli], '交回去要由旧那一份自己做，和新路径同一条规矩')
    const back = readPointer(fx.stateRoot)
    assert.equal(back.ok, true, back.message)
    assert.equal(back.pointer.updaterCli, fx.previousCli)
    assert.equal(back.pointer.registeredAt, '2026-09-20T00:00:00.000Z',
      '回退不是重新安装：把 registeredAt 写成"刚刚"，下一个读者会以为这台机器今天被装过')
    assert.equal(got.record.status, 'failed', JSON.stringify(got.record))
    assert.equal(got.record.agentVerified, true, '读回来核对过：在册的就是旧那一份')
    assert.match(got.record.detail, /the pointer is back at/)
  } finally {
    fx.cleanup()
  }
})

test('an undo whose re-registration launchd did not accept says so instead of claiming a restore', async () => {
  const fx = seededRoot('undo-refuse-')
  try {
    const got = await undoHandover({
      stateRoot: fx.stateRoot,
      previousPointer: { updaterCli: fx.previousCli, installRoot: path.dirname(path.dirname(fx.previousCli)), agentLabel: AGENT_LABEL },
      version: '1.5.0',
      runEnable: () => ({ ok: false, message: 'the previous updater refused: gpg is not installed' }),
      readRunningJob: () => loadedWith(path.join(runtimeRoot(fx.stateRoot), '1.5.0', 'updater', 'cli.js')),
      now: NOW,
    })
    assert.equal(got.ok, false, JSON.stringify(got))
    assert.equal(got.record.agentVerified, false, '交回去没成功，就不能说作业已经在那一份上了')
    assert.match(got.record.detail, /the previous updater refused/, JSON.stringify(got.record.detail))
    assert.match(got.record.detail, /still names/, JSON.stringify(got.record.detail))
  } finally {
    fx.cleanup()
  }
})

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
    assert.equal(fs.existsSync(path.join(got.treePath, 'engine', '.build', 'release')), false,
      '暂存树里 build 的产物不能跟着落进 runtime：一代 200 MB，"两代"就成了半个 GB')
    assert.equal(fs.existsSync(path.join(got.treePath, 'mcp-shell', 'dist', 'index.js')), false,
      'npm 那一层从暂存树装，不属于更新器自己要跑的东西')
    assert.equal(fs.existsSync(path.join(got.treePath, 'package.json')), true)
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
    // Four generations, and the three authorities name three *different* ones. This shape is the whole
    // point: an earlier version of this fixture made the loaded job and the previous pointer value the
    // same directory, so pinning either one kept both and the test could not tell the difference — the
    // battery could only ever find it green.
    //   1.4.9 = the value the pointer had before this run (an orphan from a failed pointer write)
    //   1.4.7 = the generation the *registered job* runs, which a deferred handover never changes
    //   1.4.6 = nobody's
    for (const v of ['1.4.6', '1.4.7', '1.4.8', '1.4.9']) fs.mkdirSync(path.join(runtime, v, 'updater'), { recursive: true })
    const jobCli = path.join(runtime, '1.4.7', 'updater', 'cli.js')
    fs.writeFileSync(jobCli, 'OLD JOB COPY\n')
    // 指针写的那个脚本得真在盘上：`readPointer` 自己就验这一条，夹具不写它就只能以另一种理由失败。
    const pointerCli = path.join(runtime, '1.4.9', 'updater', 'cli.js')
    fs.writeFileSync(pointerCli, 'POINTER COPY\n')
    seedPointer(stateRoot, { updaterCli: pointerCli, installRoot: path.join(runtime, '1.4.9') })
    const { record } = await refreshRuntime({
      stateRoot, version: '1.5.0', sourceTree: source, handover: 'defer',
      readRunningJob: () => loadedWith(jobCli),
      runEnable: () => assert.fail('defer 那一支不许注册'), now: NOW,
    })
    assert.equal(record.status, 'skipped', JSON.stringify(record))
    assert.equal(fs.existsSync(path.join(runtime, '1.5.0')), true, '新落地的要在')
    assert.equal(fs.existsSync(jobCli), true,
      '作业还指着的那一代不能被删 —— 删了就是「自动更新是开的，明早却没有作业可跑」')
    assert.equal(fs.existsSync(path.join(runtime, '1.4.9', 'updater', 'cli.js')), true, '指针上一次指的那一代也要在')
    assert.equal(fs.existsSync(path.join(runtime, '1.4.8')), false, '没人指的那一代要清掉，不留无界的磁盘堆积')
    assert.equal(fs.existsSync(path.join(runtime, '1.4.6')), false, '没人指的最旧一代也要清')
  } finally {
    removeDir(stateRoot)
    removeDir(path.dirname(source))
  }
})

test('a job book that cannot be read leaves every generation on disk', async () => {
  // The fail-safe side of the same rule: "unknown" must never be allowed to mean "nothing was running
  // it", because the cost of guessing wrong is the daily job itself.
  const stateRoot = root('prune-unknown-')
  const runtime = writableRoots(stateRoot).runtime
  const source = makeReleaseTree(path.join(root('src11u-'), 'GlassPane-1.5.0'))
  try {
    for (const v of ['1.4.6', '1.4.7']) fs.mkdirSync(path.join(runtime, v, 'updater'), { recursive: true })
    const knownCli = path.join(runtime, '1.4.7', 'updater', 'cli.js')
    fs.writeFileSync(knownCli, 'POINTER COPY\n')
    seedPointer(stateRoot, { updaterCli: knownCli, installRoot: path.join(runtime, '1.4.7') })
    const { record } = await refreshRuntime({
      stateRoot, version: '1.5.0', sourceTree: source, handover: 'defer',
      readRunningJob: () => ({ unknown: true, reason: 'launchctl print answered 5' }),
      runEnable: () => assert.fail('defer 那一支不许注册'), now: NOW,
    })
    assert.equal(record.status, 'skipped', JSON.stringify(record))
    assert.match(record.detail, /nothing was pruned/, JSON.stringify(record.detail))
    assert.equal(fs.existsSync(path.join(runtime, '1.4.6')), true, '读不到在册作业时就一个都不删')
    assert.equal(fs.existsSync(path.join(runtime, '1.4.7')), true)
  } finally {
    removeDir(stateRoot)
    removeDir(path.dirname(source))
  }
})

test('the newest generation is decided by version, not by how the string sorts', () => {
  // `1.9.0` sorts above `1.10.0` as text. A prune that picks its survivor that way keeps a generation
  // nobody points at and deletes the one something may still be running from — so the order has to
  // come from the same comparator `check` uses to decide whether a version is newer at all.
  const stateRoot = root('prune-order-')
  const runtime = writableRoots(stateRoot).runtime
  try {
    for (const v of ['1.8.0', '1.9.0', '1.10.0']) fs.mkdirSync(path.join(runtime, v, 'updater'), { recursive: true })
    // Only 1.8.0 is named. The survivor is therefore this function's own choice, and the two orders
    // disagree: text sorts `1.9.0` above `1.10.0`, semver does the opposite. Mutating the comparator
    // back to `.sort().reverse()` removes `1.10.0` here and reddens this test — the first version of
    // this control pinned 1.10.0, which made both orders answer identically and proved nothing.
    const got = pruneRuntime({ stateRoot, keep: ['1.8.0'] })
    assert.deepEqual(got.removed, ['1.9.0'], JSON.stringify(got))
    assert.equal(fs.existsSync(path.join(runtime, '1.10.0')), true, '1.10.0 比 1.9.0 新，留下的要是它')
    assert.equal(fs.existsSync(path.join(runtime, '1.8.0')), true, '被点名的那一代永远不动')
  } finally {
    removeDir(stateRoot)
  }
})

test('a copied tree that carries a symlink is refused before it can be pointed at', () => {
  // Measured: `cpSync({dereference:false})` does not copy a relative link as a relative link — it
  // rewrites it as an absolute one pointing back at the directory it read from, and here that directory
  // is the staging tree this very apply deletes. So the runtime generation would hold a dangling path
  // under `<stateRoot>/update-staging/…` that the *next* check re-creates out of freshly downloaded
  // bytes. The tree this module installs must contain no indirection at all.
  const stateRoot = root('copy-link-')
  const source = makeReleaseTree(path.join(root('src13-'), 'GlassPane-1.5.0'))
  try {
    fs.symlinkSync(path.join(source, 'package.json'), path.join(source, 'updater', 'link.json'))
    const got = materializeRuntime({ stateRoot, sourceTree: source, version: '1.5.0' })
    assert.equal(got.ok, false, '带符号链接的一份不能算装上')
    assert.match(got.message, /symlink/, got.message)
    assert.equal(fs.existsSync(path.join(stateRoot, 'runtime', '1.5.0')), false, '拒绝的一份不许留在树上')
    assert.deepEqual(fs.readdirSync(writableRoots(stateRoot).runtime).filter((n) => n.startsWith('.')), [], '临时那份也要一起清掉')
  } finally {
    removeDir(stateRoot)
    removeDir(path.dirname(source))
  }
})

test('an existing generation is re-verified, not trusted by name', () => {
  // The reuse path exists so a retried apply does not delete a tree something may be executing from.
  // It used to check only that `updater/cli.js` existed, which turned a one-run refusal into a
  // permanent bypass: a directory that failed its private-mode check stayed on disk, and the next run
  // flipped the pointer at it without asking anything.
  const stateRoot = root('reuse-check-')
  const tree = path.join(writableRoots(stateRoot).runtime, '1.5.0')
  fs.mkdirSync(path.join(tree, 'updater'), { recursive: true })
  fs.writeFileSync(runtimeCliPath(tree), 'console.log("ok")\n')
  fs.symlinkSync('/etc/hosts', path.join(tree, 'updater', 'cli-backup'))
  try {
    const got = materializeRuntime({ stateRoot, sourceTree: makeReleaseTree(path.join(root('src14-'), 'GlassPane-1.5.0')), version: '1.5.0' })
    assert.equal(got.ok, false, '已在盘上的那一份也要过同一套检查')
    assert.match(got.message, /symlink/, got.message)
    assert.equal(got.reused, undefined, JSON.stringify(got))
  } finally {
    removeDir(stateRoot)
  }
})

test('a pointer that registers somebody else\'s job is refused before anything moves', async () => {
  const stateRoot = root('foreign-label-')
  const cloneRoot = root('clone-foreign-')
  const source = makeReleaseTree(path.join(root('src15-'), 'GlassPane-1.5.0'))
  try {
    // The label reaches here from `update-install.json`, a file another process writes, and it is the
    // value `launchctl bootout` and the plist's *file name* are built from.
    const cloneCli = path.join(cloneRoot, 'updater', 'cli.js')
    fs.mkdirSync(path.dirname(cloneCli), { recursive: true })
    fs.writeFileSync(cloneCli, 'CLONE UPDATER\n')
    writePointer(stateRoot, { updaterCli: cloneCli, installRoot: cloneRoot, agentLabel: 'com.apple.something' }, { now: NOW() })
    const { record } = await refreshRuntime({
      stateRoot, version: '1.5.0', sourceTree: source,
      runEnable: () => assert.fail('标签不是自己的，一次都不该注册'), now: NOW,
    })
    assert.equal(record.status, 'failed', JSON.stringify(record))
    assert.equal(record.code, CODES.agentPathUnsafe)
    assert.match(record.detail, /not this project's own label/, JSON.stringify(record.detail))
    assert.equal(fs.existsSync(path.join(writableRoots(stateRoot).runtime, '1.5.0')), false, '拒绝的一份连落地都不该发生')
  } finally {
    removeDir(stateRoot)
    removeDir(cloneRoot)
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
