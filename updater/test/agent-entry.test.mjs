/**
 * The stable agent entry, and the module that installs it.
 *
 * Why this file exists at all: `updater/agent-entry.js` is the one piece of §11 that runs *outside* this
 * package — launchd executes it from the state root, and it decides which copy of the updater tomorrow's
 * daily run becomes. A file whose whole job is "resolve a pointer, then exec it" cannot be proven by a
 * stub: a stub never resolves a pointer, never execs, and never has to forward an exit code. So the
 * central tests here start the real script with the real `node` against a real pointer file, exactly the
 * way `test/cli-options.test.mjs` insists on running the real CLI.
 *
 * REVERSE MUTATION, each verified to redden the named control:
 *   · drop the pointer resolution and exec `import.meta.url`'s own tree → `forwards every argument…`
 *   · `return 0` when the child was killed by a signal                → `a child killed…`
 *   · answer the missing-pointer case with a stack trace (throw)      → `refuses in data`
 *   · accept an empty source in `ensureAgentEntry`                    → `an empty source is refused`
 *   · skip the read-back comparison in `ensureAgentEntry`             → `a file that reads back short`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  ENTRY_SOURCE,
  agentEntryPath,
  agentEntryIsCurrent,
  ensureAgentEntry,
} from '../lib/agent-entry.js'
import { CODES } from '../lib/codes.js'
import { main, refusalLine, resolveEntryStateRoot, resolveUpdaterCli } from '../agent-entry.js'
import { TMP_PREFIX, removeDir, tempDir } from './helpers.mjs'

const NODE = process.execPath
const ENTRY = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'agent-entry.js')

function scratch(label) {
  return path.resolve(tempDir(`${TMP_PREFIX}entry-${label}-`))
}

function seedPointer(stateRoot, pointer) {
  fs.writeFileSync(path.join(stateRoot, 'update-install.json'), JSON.stringify(pointer, null, 2) + '\n', { mode: 0o600 })
}

/* ------------------------------------------------------------------ the script itself */

test('the entry forwards every argument to the copy the pointer names, and its exit code too', () => {
  const stateRoot = scratch('exec-')
  const target = path.join(scratch('target-'), 'updater', 'cli.js')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  // A stand-in for `updater/cli.js` that records what it was called with and refuses with a specific
  // code — the two facts the daily job's contract rests on: nothing is dropped on the way through, and
  // §7's exit code is the child's, not the entry's.
  fs.writeFileSync(target, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs'",
    "fs.writeFileSync(process.env.GP_RECORD, JSON.stringify(process.argv.slice(2)))",
    "process.stdout.write('from the pointed copy\\n')",
    "process.exit(Number(process.env.GP_CODE || 0))",
    "",
  ].join('\n'))
  const record = path.join(stateRoot, 'argv.json')
  seedPointer(stateRoot, { updaterCli: target, installRoot: path.dirname(path.dirname(target)), agentLabel: 'com.glasspane.update' })
  try {
    const got = spawnSync(NODE, [ENTRY, 'apply', '--state-root', stateRoot, '--auto', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, GP_RECORD: record, GP_CODE: '4' },
    })
    assert.equal(got.stdout, 'from the pointed copy\n', 'stdio 是继承的：面板与作业日志读的就是那一份输出')
    assert.equal(got.status, 4, `退出码必须是子进程的那个：${got.status} / ${got.stdout}`)
    const argv = JSON.parse(fs.readFileSync(record, 'utf8'))
    assert.deepEqual(argv, ['apply', '--state-root', stateRoot, '--auto', '--json'], '参数一个不改地交下去')
  } finally {
    removeDir(stateRoot)
    removeDir(path.dirname(path.dirname(path.dirname(target))))
  }
})

test('a pointer that names nothing on disk is refused in data, not as a stack trace', () => {
  // The shape this replaces is node's own: `Cannot find module '/…/runtime/1.4.0/updater/cli.js'` plus a
  // 40-line ESM trace in the job's log, which reads as "the update ran and printed something" to every
  // consumer that only looks at the last line. A refusal with a code and a remedy is the difference
  // between a machine an agent can repair and one it has to guess about.
  const stateRoot = scratch('stale-')
  seedPointer(stateRoot, { updaterCli: path.join(stateRoot, 'runtime', '9.9.9', 'updater', 'cli.js'), installRoot: stateRoot, agentLabel: 'com.glasspane.update' })
  try {
    const json = spawnSync(NODE, [ENTRY, 'check', '--state-root', stateRoot, '--json'], { encoding: 'utf8' })
    assert.equal(json.status, 3, `拒绝必须落在 §7 的那一档：${json.status} ${json.stdout} ${json.stderr}`)
    const line = JSON.parse(json.stdout.trim().split('\n').pop())
    assert.equal(line.ok, false)
    assert.equal(line.code, CODES.pointerStale ?? 'installer-pointer-stale')
    assert.equal(line.status, 'check-failed')
    assert.match(line.message, /is not on disk/)
    assert.match(line.message, /re-run the GlassPane installer|Re-run|re-register/i, 'remedy 要做得动，不是"未知错误"')

    const text = spawnSync(NODE, [ENTRY, 'check', '--state-root', stateRoot], { encoding: 'utf8' })
    assert.equal(text.status, 3)
    assert.match(text.stdout, /agent-entry:/)
    assert.ok(!text.stdout.includes('{'), '没有 --json 时不许把 JSON 甩给人')
  } finally {
    removeDir(stateRoot)
  }
})

test('a missing pointer is a different answer from a stale one, and both are refusals', () => {
  const stateRoot = scratch('nopointer-')
  try {
    assert.equal(resolveUpdaterCli(stateRoot).ok, false)
    assert.equal(resolveUpdaterCli(stateRoot).code, 'installer-pointer-unreadable')
    const line = refusalLine({ code: 'installer-pointer-unreadable', stateRoot, cli: null, json: true })
    const parsed = JSON.parse(line)
    assert.equal(parsed.exitCode, 3)
    assert.match(parsed.message, /missing or unreadable/, '没有指针与指针坏了是两件事，remedy 也一样但说法不能混')
  } finally {
    removeDir(stateRoot)
  }
})

test('a child killed by a signal never comes back as a zero', () => {
  // `spawnSync` reports `status === null` with a signal set. Returning 0 there would tell launchd the
  // daily run succeeded, and nothing on the machine would ever say otherwise.
  const seen = main(['check', '--json'], {
    env: {},
    execPath: NODE,
    spawn: () => ({ status: null, signal: 'SIGKILL', error: null }),
    write: () => {},
  })
  assert.notEqual(seen, 0, `被杀死的子进程不能算成功：${seen}`)
})

test('the state root is resolved in the same precedence the CLI uses', () => {
  const home = os.homedir()
  assert.equal(resolveEntryStateRoot(['check', '--state-root', '/a'], {}), '/a')
  assert.equal(resolveEntryStateRoot(['check', '--state-dir', '/b'], {}), '/b')
  assert.equal(resolveEntryStateRoot(['check', '--state-dir=/c'], {}), '/c')
  assert.equal(resolveEntryStateRoot(['check', '--state-dir', '--json'], {}), path.join(home, '.glasspane'),
    '一个没有值的开关不能被当成值')
  assert.equal(resolveEntryStateRoot(['check'], { GLASSPANE_STATE_DIR: '/env' }), '/env')
})

/* ------------------------------------------------------------------ the installer of the entry */

test('the entry reimplements its two literals, so they are pinned against the real source of truth', async () => {
  // `updater/agent-entry.js` deliberately imports nothing from this repo: it is copied into the state
  // root and runs alone, and following `updater/`'s version would put back the very coupling §11 removes.
  // That makes two literals exist twice — the state-root flags and the pointer file's name. Nothing in the
  // runtime can notice the two drifting apart, so this is the guard: change the spelling in
  // `policy.js`/`state.js` and forget the entry, and the daily job would silently read the wrong
  // directory or find no pointer at all while every in-repo test stayed green.
  const { STATE_ROOT_FLAGS } = await import('../lib/policy.js')
  const { POINTER_FILE_NAME } = await import('../lib/fsutil.js')
  const entry = await import('../agent-entry.js')
  assert.deepEqual([...entry.STATE_FLAGS].sort(), [...STATE_ROOT_FLAGS].sort(),
    '入口认的状态根开关必须与 CLI 同一个拼法**集合**（两处作者，这一条是唯一读者；顺序不比，因为两个拼法互不为前缀，谁先match都不改变答案）')
  assert.equal(entry.POINTER_FILE_NAME, POINTER_FILE_NAME,
    '入口读的指针文件名必须与 `fsutil.js` 那一个真源同一个')
})

test('ensureAgentEntry lands the shipped bytes and proves them by reading them back', () => {
  const stateRoot = scratch('write-')
  try {
    const first = ensureAgentEntry({ stateRoot })
    assert.equal(first.ok, true, first.message)
    assert.equal(first.reused, false)
    assert.equal(first.path, agentEntryPath(stateRoot))
    assert.equal(fs.readFileSync(first.path, 'utf8'), fs.readFileSync(ENTRY_SOURCE, 'utf8'), '落地的字节必须就是仓里那一份')
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o600)
    assert.equal(agentEntryIsCurrent({ stateRoot }), true)

    const second = ensureAgentEntry({ stateRoot })
    assert.equal(second.ok, true)
    assert.equal(second.reused, true, '同一份内容不重写第二遍，但每次都要重新核对盘上的字节')

    // A source that is a stub, or empty, is not "an entry that happens to be small".
    const stubbed = ensureAgentEntry({ stateRoot, readSource: () => '', sourcePath: '/nowhere/agent-entry.js' })
    assert.equal(stubbed.ok, false, '空文件不能算装好了一个入口')
    const wrong = ensureAgentEntry({ stateRoot, readSource: () => 'console.log(1)\n', sourcePath: '/nowhere/agent-entry.js' })
    assert.equal(wrong.ok, false)
    assert.match(wrong.message, /does not look like the agent entry/)
    assert.equal(fs.readFileSync(agentEntryPath(stateRoot), 'utf8').length > 0, true, '一次拒绝不许把已经装好的入口清空')

    // The write itself lying about what landed.
    const looseRoot = scratch('loose-')
    const loose = ensureAgentEntry({
      stateRoot: looseRoot,
      writeFile: (p, text) => fs.writeFileSync(p, text, { mode: 0o666 }),
    })
    assert.equal(loose.ok, false, 'mode 不是 600 就要判失败——这个文件决定每天跑哪份代码')
    assert.equal(loose.code, CODES.stateWriteUnverified)
    assert.equal(fs.existsSync(agentEntryPath(looseRoot)), false,
      '一个 0666 的入口被拒绝之后不能还站在作业点名的那个位置上')
    removeDir(looseRoot)
  } finally {
    removeDir(stateRoot)
  }
})

test('a file that reads back short is refused, and the half-written entry is not left standing', () => {
  // A short write is not a hypothetical: a full volume, a crash between `write` and `rename`, or a second
  // process touching the path all leave a file that *parses* and runs something other than what this
  // install meant. This is the control for the byte comparison itself — the reason the landing step reads
  // the file back instead of trusting the write call: drop that comparison and this test must go red.
  const stateRoot = scratch('shortwrite-')
  const target = agentEntryPath(stateRoot)
  try {
    const source = fs.readFileSync(ENTRY_SOURCE, 'utf8')
    const got = ensureAgentEntry({
      stateRoot,
      writeFile: (p, text) => fs.writeFileSync(p, text.slice(0, text.length - 40), { mode: 0o600 }),
    })
    assert.equal(got.ok, false, `写进去的字节与源不同就必须判失败：${JSON.stringify(got)}`)
    assert.equal(got.code, CODES.stateWriteUnverified)
    assert.match(got.message, new RegExp(`read back ${source.length - 40} bytes after writing ${source.length}`),
      `句子里要看得见这两个字节数，不然读者分不清"短了"与"没写上"：${got.message}`)
    assert.equal(fs.existsSync(target), false, '半份入口比没有入口更危险：作业点名的就是这个路径，它会照着执行')
    assert.match(got.message, /it was removed/, ' removal 成功这件事要说出来：' + got.message)

    // The next call must not mistake the *absence* for a landing it never proved.
    const again = ensureAgentEntry({
      stateRoot,
      writeFile: (p, text) => fs.writeFileSync(p, text.slice(0, text.length - 40), { mode: 0o600 }),
    })
    assert.equal(again.ok, false, '清掉之后重新写还是那半份，结论不许变成 ok')
    assert.equal(fs.existsSync(target), false)
  } finally {
    removeDir(stateRoot)
  }
})

test('an entry that cannot be written is a refusal with the reason, and nothing lands', () => {
  const stateRoot = scratch('unwritable-')
  try {
    const got = ensureAgentEntry({ stateRoot, readSource: () => { throw new Error('EACCES: the package directory is read-only') } })
    assert.equal(got.ok, false)
    assert.equal(got.code, CODES.stateWriteUnverified)
    assert.match(got.message, /could not be read from/, `要说的是读不到源文件这件事：${got.message}`)
    assert.equal(fs.existsSync(agentEntryPath(stateRoot)), false, '失败的那一次不许留下半个入口')
  } finally {
    removeDir(stateRoot)
  }
})
