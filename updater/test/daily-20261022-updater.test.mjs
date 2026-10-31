/**
 * daily 2026-10-22 — four verified P2 defects in the auto-updater, each pinned by name.
 *
 *  1. Three remedy strings interpolated a path the updater did not choose (lib/check.js's
 *     `ls -lO`/`stat -f`, lib/source.js's `export NODE_EXTRA_CA_CERTS=`, lib/policy.js's
 *     `updater apply --state-dir`). A remedy here is *a command an agent runs*, and the state
 *     root rides in from `--state-dir` / `GLASSPANE_STATE_DIR` / the panel passing the
 *     daemon-reported root (`UpdateModel.swift` `arguments(for:stateRoot:)` hands it straight
 *     through), so it is untrusted bytes at a shell operand position.
 *  2. `agent-entry.js` derived the fallback state root from `os.homedir()` — `$HOME`, a
 *     caller-controlled variable — while `cli.js:226-247` deliberately uses `os.userInfo().homedir`
 *     (the password record). Split-brain: the scheduled job read the installer pointer from a
 *     different root than the installer wrote.
 *  3. `lib/source.js`'s 4xx refusal was the only transport refusal in the module with no
 *     consequence clause and no next step, and the panel prints it verbatim (check.js keeps it
 *     in `lastError.message`).
 *  4. The release archive's "the archive is not the delivery mechanism for whoever built it"
 *     rule (`scripts/make-release-archive.mjs:57-63`): a tripwire over the updater's own code.
 *
 * REVERSE MUTATIONS, each named against the control it reddens:
 *   · check.js back to `ls -lO ${deniedPath}` (bare) or `"${…}"` (double) → `the denied-syscall
 *     remedy…` reds: the quoted form is gone from the text, and the double-quoted shape the
 *     parser rejects comes back.
 *   · source.js back to `export NODE_EXTRA_CA_CERTS="<path>"` → `the CA-bundle export line…`
 *     reds on the exact-substring and on the no-double-quote assertion.
 *   · policy.js back to `--state-dir "<root>"` → `the state-dir consent command…` reds.
 *   · agent-entry back to `os.homedir()` → `the entry's fallback…` reds with `$HOME` flipped in
 *     this process (that is the whole point: `os.homedir()` re-reads it on every call).
 *   · drop the `try` around `os.userInfo()` (or the code branch in `main`) → `no password
 *     record…` reds: the coded refusal escapes as a throw instead of exit 3 on one line.
 *   · strip the clause from `answered()` → `a real 404 answers…` reds on the consequence clause.
 *   · make `lib/shell-quote.js` double-quote → the helper-table test and every behavioural test
 *     above red together.
 * The quoting rule itself is the port of `mcp-shell/src/errors.ts:96-124` /
 * `engine/Sources/GlassPaneEngine/StateRoot.swift:438-444`; the source-scan gate that covers
 * `updater/lib/*.js` and `updater/*.js` lives in `mcp-shell/test/remedy-shell-quoting.test.mjs`
 * (widened the same day; its `updater/` vacuity assertions are the pin that the widened set is
 * not decoration).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { stagingRaceCause } from '../lib/check.js'
import { describeTransportFailure, makeFetcher } from '../lib/source.js'
import { decideSwapPermission } from '../lib/policy.js'
import { quoteShellArg } from '../lib/shell-quote.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError } from '../lib/fsutil.js'
import { SUBCOMMANDS, resolveStateRoot } from '../cli.js'
import {
  NO_USER_RECORD_CODE,
  entryHomeDir,
  homeRefusalLine,
  main,
  resolveEntryStateRoot,
} from '../agent-entry.js'
import { PINNED_PATH, TMP_PREFIX, removeDir, startServer, tempDir } from './helpers.mjs'

/**
 * Hostile-but-real payloads. `$(touch …)` and `` ` `` are what a path crafted by an
 * earlier link/socket/record on the machine can carry; the space and the apostrophe are
 * shapes a *legitimate* macOS home directory really has (`/Users/a name`, `/Users/it's`).
 */
const HOSTILE = {
  subst: '/tmp/$(touch /tmp/pwned);x',
  backtick: '/tmp/x`;touch /tmp/pwned',
  space: '/tmp/a b/.glasspane',
  quote: "/tmp/it's/.glasspane",
}

/* ------------------------------------------------------------------ *
 * The reader, not the runner: split a command the way `sh` does and throw on
 * anything a shell would *act on*. Nothing in this file ever executes a remedy;
 * the whole defence is "the parsed word still equals the path, one word, inert".
 * (The rule table is the one `mcp-shell/test/remedy-shell-quoting.test.mjs` uses;
 * that file cannot be imported here — updater tests must not reach `mcp-shell/dist`
 * — so this is a deliberate second copy *of the test reader*, never of the product
 * helper, which exists exactly once: `updater/lib/shell-quote.js`.)
 * ------------------------------------------------------------------ */
function shellWords(cmd) {
  const words = []
  let current = null
  let i = 0
  const flush = () => {
    if (current !== null) {
      words.push(current)
      current = null
    }
  }
  while (i < cmd.length) {
    const c = cmd[i]
    if (c === ' ' || c === '\t' || c === '\n') { flush(); i += 1; continue }
    if (c === ';' || c === '|' || c === '&' || c === '<' || c === '>') {
      throw new Error(`unquoted control operator ${JSON.stringify(c)} in: ${cmd}`)
    }
    if (c === '`') throw new Error(`unquoted backtick (command substitution) in: ${cmd}`)
    if (c === '$' && (cmd[i + 1] === '(' || cmd[i + 1] === '{')) {
      throw new Error(`unquoted expansion ${JSON.stringify(c + cmd[i + 1])} in: ${cmd}`)
    }
    if (c === '*' || c === '?' || c === '[') throw new Error(`unquoted glob ${JSON.stringify(c)} in: ${cmd}`)
    if (c === "'") {
      current = current ?? ''
      i += 1
      while (i < cmd.length && cmd[i] !== "'") { current += cmd[i]; i += 1 }
      if (i >= cmd.length) throw new Error(`unterminated single quote in: ${cmd}`)
      i += 1
      continue
    }
    if (c === '"') {
      current = current ?? ''
      i += 1
      let inner = ''
      while (i < cmd.length && cmd[i] !== '"') { inner += cmd[i]; i += 1 }
      if (i >= cmd.length) throw new Error(`unterminated double quote in: ${cmd}`)
      i += 1
      if (/[$`]/.test(inner)) {
        throw new Error(`double quotes are not inert quoting — ${JSON.stringify(inner)} still expands`)
      }
      current += inner
      continue
    }
    if (c === '\\') { current = current ?? ''; current += cmd[i + 1] ?? ''; i += 2; continue }
    current = current ?? ''
    current += c
    i += 1
  }
  flush()
  return words
}

/** Slice the one command out of the sentence between two fixed anchors. */
function commandBetween(text, begin, end, label) {
  const s = text.indexOf(begin)
  assert.notEqual(s, -1, `${label}: 句子里找不到命令起点 ${JSON.stringify(begin)}：${text}`)
  const e = text.indexOf(end, s)
  assert.notEqual(e, -1, `${label}: 句子里找不到命令终点 ${JSON.stringify(end)}：${text}`)
  return text.slice(s, e)
}

/* ================================ the helper (Defect 1, shared import) ================================ */

test('the updater quoting helper is the product rule: single quotes with the \\\' splice, inert words left bare', () => {
  // Same table `mcp-shell/test/remedy-shell-quoting.test.mjs` pins for `src/errors.ts`; the two
  // helpers live in separately-shipped packages, so what must NOT drift is the behaviour.
  assert.equal(quoteShellArg(HOSTILE.subst), `'${HOSTILE.subst}'`)
  assert.equal(quoteShellArg(HOSTILE.backtick), `'${HOSTILE.backtick}'`)
  assert.equal(quoteShellArg(HOSTILE.space), `'${HOSTILE.space}'`)
  assert.equal(quoteShellArg("/tmp/it's/x"), `'/tmp/it'\\''s/x'`, "内嵌单引号只能拆出来再拼回去，这是单引号词里唯一的正确写法")
  assert.equal(quoteShellArg('/Users/example/.glasspane'), '/Users/example/.glasspane', '普通绝对路径保持裸形，命令仍读作一个词')
  assert.equal(quoteShellArg(''), "''", '空串不写就是少了一个参数：那已经是另一个命令行')
  assert.equal(quoteShellArg('-rf'), "'-rf'", '以 - 开头的值会被读成选项')
  // The parse-half of the same claim: every payload comes back as exactly one inert word.
  for (const p of Object.values(HOSTILE)) {
    assert.deepEqual(shellWords(`chmod 600 ${quoteShellArg(p)}`), ['chmod', '600', p], `${p} 没有还原成一个词`)
  }
})

test('the checker bites: the unquoted and the double-quoted shapes are NOT one inert command (control that can fail)', () => {
  // Without this the four site tests below could be green because the reader is blind.
  for (const p of [HOSTILE.subst, HOSTILE.backtick]) {
    assert.throws(() => shellWords(`chmod 600 ${p}`), /control operator|backtick|glob|unquoted expansion|unterminated/)
  }
  assert.notEqual(shellWords(`chmod 600 ${HOSTILE.space}`).length, 3, '一个空格的形状是**参数被劈成两个词**，没有算子可拒')
  // The exact shapes the two files used before this fix — `export NODE_EXTRA_CA_CERTS="<path>"`
  // and `--state-dir "<root>"` — must fail the very same reader. This is the "show the revert
  // could have been caught" requirement: double quotes are where `$( )` and backticks still run.
  assert.throws(() => shellWords(`export NODE_EXTRA_CA_CERTS="${HOSTILE.subst}/ca-roots.pem"`), /double quotes are not inert/)
  assert.throws(() => shellWords('export NODE_EXTRA_CA_CERTS="$(touch /tmp/pwned)"'), /double quotes are not inert/)
  assert.throws(() => shellWords(`ls -lO "${HOSTILE.subst}"`), /double quotes are not inert/)
})

/* ================================ Defect 1, site 1: check.js stagingRaceCause ================================ */

test('the denied-syscall remedy keeps a hostile staging path one inert word in both commands it prints', () => {
  // Real shapes: `dir`/`staging` come from the state root the run was pointed at; a hostile root
  // is exactly what the panel can hand through (`arguments(for:stateRoot:)` → `--state-dir <root>`).
  const hostileRoot = HOSTILE.subst
  const staging = `${hostileRoot}/update-staging`
  const dir = `${staging}/1.4.1`
  for (const code of ['EPERM', 'EACCES']) {
    const error = Object.assign(new Error(`${code}: operation not permitted, unlink '${path.join(dir, 'tree', 'x')}'`), { code })
    const told = stagingRaceCause(error, { dir, staging, version: '1.4.1' })
    assert.ok(told instanceof UpdaterError, `${code} 必须被说清楚`)
    const text = told.message
    // 1. the emitted commands, sliced out of the sentence and parsed: the path survives as ONE word.
    const ls = commandBetween(text, 'ls -lO ', '" shows the flags', 'ls 那一条')
    assert.deepEqual(shellWords(ls), ['ls', '-lO', dir], `ls 的命令位没有把恶意路径当成一个词：${ls}`)
    const st = commandBetween(text, "stat -f 'owner %Su group %Sg mode %Sp flags %Sf' ", '" shows who owns', 'stat 那一条')
    assert.deepEqual(
      shellWords(st),
      ['stat', '-f', 'owner %Su group %Sg mode %Sp flags %Sf', dir],
      `stat 的命令位没有把恶意路径当成一个词：${st}`,
    )
    // 2. the quote form is present, and the bare/double copies of the path are not.
    assert.ok(text.includes(`ls -lO '${dir}'`) && text.includes(`flags %Sf' '${dir}'"`), '路径没有以单引号整段出现在命令位上')
    assert.ok(!text.includes(`ls -lO ${dir}`), `裸路径又坐回了参数位：${text}`)
    assert.ok(!text.includes(`ls -lO "${dir}"`), `双引号形态回来了，而 \`$( )\` 在双引号里照样展开：${text}`)
  }
  // The non-denied branch must not have been flattened into the same sentence (control, not decoration).
  const gone = Object.assign(new Error(`ENOENT: no such file or directory, open '${path.join(dir, 'archive.tar.gz')}'`), { code: 'ENOENT' })
  assert.doesNotMatch(stagingRaceCause(gone, { dir, staging, version: '1.4.1' }).message, /ls -lO/)
})

/* ================================ Defect 1, site 2: source.js CA-bundle line ================================ */

test('the CA-bundle export line single-quotes a hostile bundle path, and the double-quoted form it replaced would not have passed', () => {
  const err = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
  })
  const bundle = `${HOSTILE.subst}/ca-roots.pem`
  const described = describeTransportFailure('https://api.github.com/x', err, { caBundlePath: bundle })
  assert.equal(described.tlsVerification, true)
  const exportCmd = commandBetween(described.details, 'export NODE_EXTRA_CA_CERTS=', ' (one shell word', 'export 那一条')
  assert.deepEqual(shellWords(exportCmd), ['export', `NODE_EXTRA_CA_CERTS=${bundle}`], `赋值位上的路径被拆开了或展开了：${exportCmd}`)
  assert.ok(described.details.includes(`export NODE_EXTRA_CA_CERTS='${bundle}'`), '没有以单引号整段包住：' + described.details)
  assert.ok(!described.details.includes(`="${bundle}"`), `双引号形态回来了：$(…) 在它内部仍然执行`)
  // A legitimate path with a space — the ordinary macOS shape — rides the same rule.
  const spaced = describeTransportFailure('https://api.github.com/x', err, { caBundlePath: `${HOSTILE.space}/ca-roots.pem` })
  assert.ok(spaced.details.includes(`export NODE_EXTRA_CA_CERTS='${HOSTILE.space}/ca-roots.pem'`), spaced.details)
})

/* ================================ Defect 1, site 3: policy.js consent command ================================ */

test('the state-dir consent command keeps a hostile state root one inert word at the flag operand', () => {
  const hostileRoot = HOSTILE.subst
  const decision = decideSwapPermission({
    probe: { answered: true },
    jobArgs: ['glasspaned', '--state-dir', '/tmp/other-install/.glasspane'],
    ourStateRoot: hostileRoot,
  })
  assert.equal(decision.status, 'needs-consent')
  // 2026-10-31：出路里那条命令是 `node <这一包的 cli.js> apply --state-dir <根> --consent state-dir`。
  // 从前它写的是裸的 `updater apply …`——这台机器上没有那个可执行文件，照抄得 127，而这道闸当时
  // 恰好把"能跑"这件事验成了"词数对"。现在先要求它点名 node 与真路径，再按 shell 的分词验每一个参数位。
  const cmd = (decision.reason.match(/`([^`]+)`/) ?? [])[1] ?? ''
  assert.ok(cmd.startsWith('node '), `出路没有印一条跑得动的命令，只印了散文：${decision.reason}`)
  const words = shellWords(cmd)
  assert.equal(words[1].endsWith('/updater/cli.js'), true, `命令跑的不是这一包的 cli.js：${words[1]}`)
  assert.deepEqual(
    words.slice(2),
    ['apply', '--state-dir', hostileRoot, '--consent', 'state-dir'],
    `--state-dir 的参数位没有把恶意根当成一个词：${cmd}`,
  )
  assert.ok(decision.reason.includes(`'--state-dir' '${hostileRoot}'`), '单引号形态缺席：' + decision.reason)
  assert.ok(!decision.reason.includes('--state-dir "'), '双引号形态回来了：那正是 `$( )` 仍然展开的位置')
})

/* ================================ Defect 2: agent-entry's home ================================ */

test('the entry\'s fallback root is the password record: flipping $HOME in this process does not move it, and cli.js agrees', () => {
  const record = os.userInfo().homedir
  const sandbox = path.resolve(tempDir(`${TMP_PREFIX}home-sandbox-`))
  const saved = process.env.HOME
  try {
    // This is the whole defect: `os.homedir()` re-reads `$HOME` on every call, so a launchd job
    // or an `env -u HOME` shape lands on a different root than the installer wrote. Flipping
    // `process.env.HOME` *inside* this process is the one way to make the decision observable
    // without touching the password database.
    process.env.HOME = sandbox
    assert.notEqual(os.homedir(), record, '夹具失效：$HOME 没有和记录拉开距离，这条测量什么也没量')
    assert.equal(entryHomeDir(), record, 'entryHomeDir 读了 $HOME —— 面板与 daemon 读的是记录')
    const entryRoot = resolveEntryStateRoot(['check'], { ...process.env })
    assert.equal(entryRoot, path.join(record, '.glasspane'), '入口的兜底根不再落在密码记录上')
    assert.ok(!entryRoot.startsWith(sandbox), `入口跟着 $HOME 进了沙箱：${entryRoot}`)
    // The decision-parity with the CLI: both name the *same* root for the same process, whatever
    // `$HOME` says. (`resolveStateRoot` canonicalises; a `/Users/…` record home is already
    // canonical on this machine — the equality is the contract, the form is incidental.)
    const cliRoot = resolveStateRoot({ flags: {}, env: { ...process.env } })
    assert.equal(entryRoot, cliRoot, `入口与 CLI 认出了两个不同的根：${entryRoot} vs ${cliRoot}`)
    // An explicit flag/env still outranks both, unchanged.
    assert.equal(resolveEntryStateRoot(['check', '--state-dir', '/flag'], { ...process.env }), '/flag')
    assert.equal(resolveEntryStateRoot(['check'], { GLASSPANE_STATE_DIR: '/env' }), '/env')
  } finally {
    process.env.HOME = saved
    removeDir(sandbox)
  }
})

test('no password record is a named one-line refusal at exit 3, never an os.userInfo() stack trace', () => {
  // The no-record shape cannot be manufactured on this machine (the test process has a passwd
  // entry, and dropping it needs a setuid into an unassigned uid) — so the seam `cli.js` itself
  // injects (`resolveStateRoot({ homeDir })`) is mirrored here and the *decision* is what gets
  // pinned: coded error in, coded refusal out, exit 3, one line.
  const codedThrow = () => {
    throw Object.assign(new Error('getpwuid: no such user'), { code: NO_USER_RECORD_CODE })
  }
  const lines = []
  const write = (s) => lines.push(s)
  let exit
  assert.doesNotThrow(() => {
    exit = main(['check', '--json'], { env: {}, spawn: () => ({ status: 0, error: null }), write, homeDir: codedThrow })
  }, '入口在无记录机器上把 node 的栈甩进了日志')
  assert.equal(exit, 3, `无记录的拒绝必须落在 §7 那一档：${exit}`)
  assert.equal(lines.length, 1, '作业日志一次只该看见一行')
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.code, CODES.homeRecordUnavailable, '代码必须与 CLI 的那一个同名，读者只需学一种形状')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.status, 'check-failed')
  assert.equal(parsed.exitCode, 3)
  assert.match(parsed.message, /password-database record/, '句子里要说清是哪一个东西没有')
  assert.match(parsed.message, /--state-dir/, '下一步必须是可执行的：给作业一个显式的状态根旗标')
  assert.ok(!/^\s+at \S+/.test(lines[0]) && lines[0].split('\n').join('') === lines[0].trim(), '日志里不许出现栈帧：' + lines[0])
  assert.doesNotMatch(parsed.message, /<[a-z][^>]*>/i, '命令里有尖括号模板就没法原样执行：' + parsed.message)
  // The non-JSON arm keeps the human prefix and never emits JSON.
  const text = []
  assert.equal(main(['check'], { env: {}, spawn: () => ({ status: 0, error: null }), write: (s) => text.push(s), homeDir: codedThrow }), 3)
  assert.match(text[0], /^updater\/agent-entry: /)
  assert.ok(!text[0].includes('{'), '没有 --json 时不许把 JSON 甩给人')
  // And an unrelated throw must NOT be swallowed into the named refusal — that would hide a crash.
  assert.throws(() => main(['check'], { env: {}, spawn: () => ({ status: 0 }), write: () => {}, homeDir: () => { throw new Error('something else') } }), /something else/)
})

test('the entry\'s no-record code is the CLI\'s code, spelled the same (two authors, one reader)', () => {
  // Same parity pattern as `test/agent-entry.test.mjs` uses for `STATE_FLAGS` / `POINTER_FILE_NAME`:
  // the entry imports nothing from the repo, so literals exist twice *by design* and the parity
  // assertion is the only reader that can see them drift.
  assert.equal(NO_USER_RECORD_CODE, CODES.homeRecordUnavailable)
  assert.equal(homeRefusalLine({ json: true }).includes(NO_USER_RECORD_CODE), true)
})

/* ================================ Defect 3: the 4xx refusal ================================ */

test('a real 404 from a local server answers with the status, the consequence clause, and a next step whose commands exist', async () => {
  // The fixture is the one the module's own tests use: a real `node:http` server on 127.0.0.1;
  // `helpers.mjs` answers any unregistered path with a real 404 + `Not Found`.
  const server = await startServer({})
  try {
    const fetcher = makeFetcher()
    let error = null
    try {
      await fetcher(`${server.origin}${PINNED_PATH}/releases/latest`)
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof UpdaterError, '404 必须落成 releaseUnreachable 的拒绝')
    assert.equal(error.code, CODES.releaseUnreachable)
    assert.match(error.message, /answered 404 Not Found/, '状态与 statusText 都要在场：' + error.message)
    // The consequence clause, in the siblings' own words (`source.js:589`, `stoppedForLength`).
    assert.match(error.message, /The release is refused and nothing partial is staged, so the next run starts from a clean slate/, '这一条是模块里唯一一句只有状态、没有后果的拒绝；补齐的必须就是同胞那一句：' + error.message)
    assert.ok(!error.message.includes('undefined'), error.message)
    // Grep-driven existence: every `updater <word>` the sentence tells the reader to run is a
    // subcommand `cli.js` actually parses (`SUBCOMMANDS`), in the style of the repo's remedy-existence gates.
    const named = [...error.message.matchAll(/updater\/cli\.js ([a-z][a-z-]*)/g)].map((m) => m[1])
    assert.ok(named.length >= 1, '拒绝里没有点名任何 updater 子命令，这条闸什么也没看：' + error.message)
    for (const word of named) {
      assert.ok(SUBCOMMANDS.includes(word), `remedy 点了一个不存在的命令 updater ${word}（SUBCOMMANDS=${SUBCOMMANDS.join('/')})：${error.message}`)
    }
    assert.ok(named.includes('check'), '4xx 的下一步里必须有重跑那一次检查')
    assert.ok(named.includes('status'), '4xx 的下一步里必须有一个无网络可读的现状')
  } finally {
    await server.close()
  }
})

/* ================================ Defect 4: the release-archive rule, applied to the updater ================================ */

test('the updater\'s own code names no real account and no mounted volume of this machine (make-release-archive.mjs:57-63)', () => {
  // The archive this code ships inside states it must not deliver whoever built it
  // (`scripts/make-release-archive.mjs`'s exclusion of `.iterate_decisions.md` for carrying the
  // author's `/Users/ethan…` home). Tripwire for the directories on the update path: neutral
  // placeholders stay legal, the *current* machine's identity is not.
  const username = os.userInfo().username
  const volumes = fs.existsSync('/Volumes') ? fs.readdirSync('/Volumes') : []
  const banned = [`/Users/${username}`, ...volumes.map((v) => `/Volumes/${v}`)]
  const HERE = path.dirname(fileURLToPath(import.meta.url))
  const libDir = path.join(HERE, '..', 'lib')
  const rootDir = path.join(HERE, '..')
  const files = [
    ...fs.readdirSync(libDir).filter((n) => n.endsWith('.js')).map((n) => path.join(libDir, n)),
    ...fs.readdirSync(rootDir).filter((n) => n.endsWith('.js')).map((n) => path.join(rootDir, n)),
  ]
  assert.ok(files.length >= 20, `只认出 ${files.length} 个 updater 代码文件，这条对照看不见东西`)
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8')
    for (const b of banned) {
      assert.ok(!raw.includes(b), `${file} 里带着这台机器的身份字面量 ${JSON.stringify(b)}——发版归档的那条规则（不是把构建者的路径装进每一台机器下载的包里）同样管这段代码`)
    }
  }
})
