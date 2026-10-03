/**
 * §6 row "非默认 state-dir 不动".
 *
 * REVERSE MUTATION: stop reading the job's arguments (`launchctl print` parsed
 * only for `program`, arguments defaulted to `[]`) —
 * `a print output with no arguments block is "unknown", not "no arguments"` and
 * `a job writing a foreign state root needs consent` both go red, because with
 * defaulted-to-empty arguments the tool believes every daemon writes where it
 * was pointed.
 *
 * `launchctl` itself is never executed here: the injected `run` returns recorded
 * output, and the parsing/judgement under test is the real code path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  AGENT_LABEL,
  DAEMON_JOB_LABEL,
  DEFAULT_HOUR,
  DEFAULT_MINUTE,
  AGENT_TEMPLATE,
  agentEnvironmentBlock,
  agentPlistPath,
  kickstartJob,
  parseArgumentsBlock,
  parseLaunchctlArguments,
  parseLaunchctlProgram,
  parseLaunchctlState,
  readRunningJob,
  registerAgent,
  renderAgentPlist,
  unregisterAgent,
} from '../lib/launchd.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError, modeOf } from '../lib/fsutil.js'
import { decideSwapPermission, stateDirReadings } from '../lib/policy.js'
import { removeDir, tempDir, TMP_PREFIX } from './helpers.mjs'

/** A trimmed but faithful `launchctl print` excerpt for the daemon job. */
const PRINT_DEFAULT = [
  'gui/501/com.glasspane.daemon = {',
  '    active count = 1',
  '    path = /Users/dev/Library/LaunchAgents/com.glasspane.daemon.plist',
  '    type = LaunchAgent',
  '    state = running',
  '    program = /Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned',
  '    arguments = {',
  '        "/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned"',
  '        "--socket-path"',
  '        "/Users/dev/.glasspane/engine.sock"',
  '    }',
  '}',
  '',
].join('\n')

const PRINT_FOREIGN_ROOT = PRINT_DEFAULT.replace(
  '        "/Users/dev/.glasspane/engine.sock"',
  '        "--state-dir"\n        "/Volumes/Work/other-glasspane"',
)

test('the arguments block is parsed exactly, quotes and all', () => {
  const args = parseLaunchctlArguments(PRINT_DEFAULT)
  assert.deepEqual(args, [
    '/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned',
    '--socket-path',
    '/Users/dev/.glasspane/engine.sock',
  ])
  assert.equal(parseLaunchctlProgram(PRINT_DEFAULT), '/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned')
  assert.equal(parseLaunchctlState(PRINT_DEFAULT), 'running')
})

test('parenthesised and unquoted variants parse too, because launchctl is not one format', () => {
  assert.deepEqual(
    parseLaunchctlArguments('  arguments = (\n    glasspaned\n    --verbose\n  )'),
    ['glasspaned', '--verbose'],
  )
  assert.deepEqual(parseLaunchctlArguments('arguments = {\n\tglasspaned\n}'), ['glasspaned'])
})

test('the update agent this tool registers is itself readable back, quotes and all', () => {
  // Captured verbatim from `launchctl print gui/501/com.glasspane.update` on 2026-09-30, with the
  // agent registered for real from a sandbox state root. Two facts in those bytes had never been in any
  // fixture, and each one silently broke a control that looked green:
  //   · launchd prints arguments raw, one per line, no quotes — so the `-c` literal of our own job
  //     begins with a `"` and the parser used to refuse the whole block. §11's read-back then could
  //     never confirm a self-update for the one job this subsystem registers for itself.
  //   · the flag rendered into that job is `--state-root`, not `--state-dir` — so a reader that only
  //     knew the other spelling could not see which state root the scheduled job writes to.
  const PRINTED_AGENT = [
    'gui/501/com.glasspane.update = {',
    '\tactive count = 0',
    '\tpath = /Users/dev/Library/LaunchAgents/com.glasspane.update.plist',
    '\ttype = LaunchAgent',
    '\tstate = not running',
    '',
    '\tprogram = /bin/sh',
    '\targuments = {',
    '\t\t/bin/sh',
    '\t\t-c',
    '\t\t"$0" "$1" check "$2" "$3" --json && "$0" "$1" apply "$2" "$3" --auto --json',
    '\t\t/usr/local/bin/node',
    '\t\t/Volumes/Eng-Dev/.worktrees/gp-iterate/updater/cli.js',
    '\t\t--state-root',
    '\t\t/var/tmp/gp-agent-probe',
    '\t}',
    '',
    '\tstdout path = /var/tmp/gp-agent-probe/update.log',
    '}',
  ].join('\n')

  const block = parseArgumentsBlock(PRINTED_AGENT)
  assert.equal(block.ok, true, block.reason)
  assert.equal(block.args.length, 7, JSON.stringify(block.args))
  assert.equal(block.args[2], '"$0" "$1" check "$2" "$3" --json && "$0" "$1" apply "$2" "$3" --auto --json',
    '壳命令是一整个参数，不是六个')

  const job = readRunningJob({ label: AGENT_LABEL, uid: '501', run: () => ({ status: 0, stdout: PRINTED_AGENT, stderr: '' }) })
  assert.equal(job.unknown, false, job.reason)
  assert.deepEqual(stateDirReadings(job.args), ['/var/tmp/gp-agent-probe'],
    '自己渲染的那种拼法也要读得出来 —— 读不出来就等于放行一个写别处状态根的作业')

  // The guard the fix must not have thrown away. Two shapes, both from the measured format: a bare
  // token carrying the block's closing brace (the truncation this parser exists for), and a quoted
  // token that both opens with a quote and carries that brace.
  const hostileBare = parseArgumentsBlock(PRINTED_AGENT.replace('\t\t--state-root', '\t\t--state-root }'))
  assert.equal(hostileBare.ok, false, '带 } 的裸参数行必须仍然被拒：' + JSON.stringify(hostileBare.args))
  assert.match(hostileBare.reason, /cannot be decoded/)
  // A brace that sits *inside* a fully quoted token is not a boundary risk (the terminator is a line
  // that is nothing but `}`), so it stays readable — which is why the refusal above is scoped to bare
  // lines and to quote-led lines that also carry the delimiter.
  const bracedQuoted = parseArgumentsBlock(PRINTED_AGENT.replace('\t\t--state-root', '\t\t"--state-root } "'))
  assert.equal(bracedQuoted.ok, true, bracedQuoted.reason)
  // And what the fix deliberately now accepts: a token that merely contains quotes. Refusing those was
  // what blinded the read-back; nothing about them can hide a later argument, because the format is
  // one line per argument. (A token carrying a brace is still refused above — that is the real
  // boundary-faking risk, and it stays refused even when the braces sit inside quotes.)
  const quotesOnly = parseArgumentsBlock(PRINTED_AGENT.replace('\t\t--state-root', '\t\t--format="$HOME/bin"'))
  assert.equal(quotesOnly.ok, true, quotesOnly.reason)
  assert.ok(quotesOnly.args.includes('--format="$HOME/bin"'), JSON.stringify(quotesOnly.args))
})

test('a print output with no arguments block is "unknown", not "no arguments"', () => {
  assert.equal(parseLaunchctlArguments('gui/501/x = {\n  state = running\n}'), null)
  const result = readRunningJob({
    uid: '501',
    run: () => ({ status: 0, stdout: 'gui/501/com.glasspane.daemon = {\n  program = /x\n}', stderr: '' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.unknown, true)
  assert.equal(result.code, CODES.busyOrUnreachable)
  assert.match(result.reason, /cannot tell which state root/)
})

test('a job writing a foreign state root needs consent', () => {
  const job = readRunningJob({ uid: '501', run: () => ({ status: 0, stdout: PRINT_FOREIGN_ROOT, stderr: '' }) })
  assert.equal(job.ok, true)
  assert.equal(job.stateDir, '/Volumes/Work/other-glasspane')
  const decision = decideSwapPermission({ probe: { answered: true }, jobArgs: job.args, ourStateRoot: '/Users/dev/.glasspane' })
  assert.equal(decision.status, 'needs-consent')
  assert.equal(decision.code, CODES.nonDefaultStateDir)
  assert.match(decision.reason, /\/Volumes\/Work\/other-glasspane/)

  const same = readRunningJob({ uid: '501', run: () => ({ status: 0, stdout: PRINT_DEFAULT, stderr: '' }) })
  assert.equal(same.stateDir, null)
  assert.equal(decideSwapPermission({ probe: { answered: true }, jobArgs: same.args, ourStateRoot: '/Users/dev/.glasspane' }).status, 'allowed')
})

test('a job that is not loaded is unknown, and so is a uid that cannot be read', () => {
  const notLoaded = readRunningJob({ uid: '501', run: () => ({ status: 113, stdout: '', stderr: 'Could not find service "com.glasspane.daemon" in domain for user gui: 501' }) })
  assert.equal(notLoaded.unknown, true)
  assert.equal(notLoaded.loaded, false)
  assert.match(notLoaded.reason, /launchctl print gui\/501/)

  const noUid = readRunningJob({ run: (bin, args) => ({ status: args[0] === '-u' ? 1 : 0, stdout: '', stderr: '' }) })
  assert.equal(noUid.unknown, true)
  assert.match(noUid.reason, /uid/)
})

test('the daemon job label is the one the installer registers', () => {
  assert.equal(DAEMON_JOB_LABEL, 'com.glasspane.daemon')
  assert.equal(AGENT_LABEL, 'com.glasspane.update')
})

/**
 * The argv the rendered plist really holds, read back by macOS's own property-list
 * reader (`plutil -convert json`) rather than by a regex in this file: a test that
 * parses the plist with the same assumptions the renderer made proves nothing.
 */
function plistToJson(text, dir) {
  const file = path.join(dir, 'rendered.plist')
  fs.writeFileSync(file, text)
  const res = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`plutil refused the rendered agent plist (${(res.stderr || '').trim()}):\n${text}`)
  }
  return JSON.parse(res.stdout)
}

test('the shipped plist runs the CLI through argv, with no path inside the shell command', (t) => {
  if (process.platform !== 'darwin') return t.skip('plutil is the macOS property-list reader this test is made of')
  const dir = tempDir(`${TMP_PREFIX}plist-render-`)
  try {
    const text = renderAgentPlist({
      nodePath: '/usr/local/bin/node',
      cliPath: '/Users/dev/Applications/GlassPane.app/Contents/Resources/updater/cli.js',
      stateRoot: '/Users/dev/.glasspane',
      hour: 3,
      minute: 45,
    })
    const doc = plistToJson(text, dir)
    assert.equal(doc.Label, AGENT_LABEL)
    assert.deepEqual(doc.ProgramArguments.slice(0, 2), ['/bin/sh', '-c'], 'the job still sequences check && apply, which one argv array cannot express')
    const command = doc.ProgramArguments[2]
    assert.match(command, /\$0.*check.*\$1.*apply/, 'the paths are referenced as positional parameters, never spelled out')
    // §5: only the scheduled path carries the marker that makes it scheduled. A
    // daily job that runs a bare `apply` reaches the swap gate as a *manual* run,
    // so turning automatic update off would stop nothing — reverse mutation:
    // delete `--auto` from the template and this reddens.
    assert.match(command, /apply[^&]*--auto/, 'the scheduled apply must identify itself as automatic')
    assert.equal(/check[^&]*--auto/.test(command), false, '`check` is trigger-neutral on purpose')
    for (const value of ['/usr/local/bin/node', 'GlassPane.app', '/Users/dev/.glasspane', '--state-root']) {
      assert.ok(!command.includes(value), `the shell command still contains ${JSON.stringify(value)}: it would be re-parsed by the shell`)
    }
    assert.deepEqual(doc.ProgramArguments.slice(3), [
      '/usr/local/bin/node',
      '/Users/dev/Applications/GlassPane.app/Contents/Resources/updater/cli.js',
      '--state-root',
      '/Users/dev/.glasspane',
    ], 'node, the CLI, the flag and the state root are four separate argv slots')
    assert.equal(doc.RunAtLoad, false, 'a login must not start an update')
    assert.equal(doc.StartCalendarInterval.Hour, 3)
    assert.equal(doc.StartCalendarInterval.Minute, 45)
    assert.equal(doc.StandardOutPath, '/Users/dev/.glasspane/update.log')
    assert.ok(!text.includes('{{'), 'no unreplaced token: ' + (/\{\{[A-Z_]+\}\}/.exec(text) ?? [''])[0])
  } finally {
    removeDir(dir)
  }
})

// REVERSE MUTATION: put the interpolation back into the template (the shape this
// file shipped before — `<string>"{{NODE_PATH}}" "{{CLI_PATH}}" check --state-root
// "{{STATE_ROOT}}" …` inside the `-c` argument). Two things redden here:
// `assertNoInterpolatedShellCommand` refuses the render, and, with that guard
// removed, the control case below shows the injected `touch PWNED` really runs.
test('a state root carrying quotes, a semicolon and $( ) is inert in the rendered agent', (t) => {
  if (process.platform !== 'darwin') return t.skip('the proof runs the rendered argv through /bin/sh and plutil')
  const dir = tempDir(`${TMP_PREFIX}plist-inert-`)
  try {
    const pwned = path.join(dir, 'PWNED')
    const marker = path.join(dir, 'argv.json')
    const recorder = path.join(dir, 'recorder')
    const cliPath = '/Users/dev/Applications/GlassPane.app/Contents/Resources/updater/cli.js'
    const hostileStateRoot = path.join(dir, `x"; touch ${pwned}; echo "$(id)`)
    // A stand-in for `node`: it records the argv it was handed and exits 0, so the
    // rendered command can be *executed* instead of merely looked at.
    fs.writeFileSync(recorder, [
      '#!/bin/sh',
      // Appends, because the rendered job runs the CLI twice (`check && apply`)
      // and both invocations are evidence.
      `printf '%s\\n' "$@" >> ${JSON.stringify(marker)}`,
      'exit 0',
      '',
    ].join('\n'))
    fs.chmodSync(recorder, 0o755)

    const text = renderAgentPlist({
      nodePath: recorder,
      cliPath,
      stateRoot: hostileStateRoot,
      logPath: path.join(dir, 'update.log'),
    })
    const doc = plistToJson(text, dir)
    assert.equal(fs.existsSync(pwned), false, 'rendering alone must not have executed anything')
    assert.equal(doc.ProgramArguments[doc.ProgramArguments.length - 1], hostileStateRoot, 'the hostile path survives verbatim as one argument')

    const res = spawnSync(doc.ProgramArguments[0], doc.ProgramArguments.slice(1), { encoding: 'utf8' })
    assert.equal(res.status, 0, `the rendered command itself has to run: ${res.stderr}`)
    assert.equal(fs.existsSync(pwned), false, 'the injected `touch` ran as the user: the state root is being interpreted by a shell')
    const argv = fs.readFileSync(marker, 'utf8').trim().split('\n')
    assert.deepEqual(argv, [
      cliPath, 'check', '--state-root', hostileStateRoot, '--json',
      cliPath, 'apply', '--state-root', hostileStateRoot, '--auto', '--json',
    ], 'the hostile string arrived as ONE argument, in order, on both runs the job makes')
    assert.equal(argv.filter((a) => a === hostileStateRoot).length, 2, 'never split, never mangled, never re-parsed')
  } finally {
    removeDir(dir)
  }
})

/** The control for the test above: the old shape really was exploitable. */
test('control: the template this file used to ship does run the injected command', (t) => {
  if (process.platform !== 'darwin') return t.skip('the control executes /bin/sh -c')
  const dir = tempDir(`${TMP_PREFIX}plist-control-`)
  try {
    const pwned = path.join(dir, 'PWNED')
    const recorder = path.join(dir, 'recorder')
    fs.writeFileSync(recorder, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(recorder, 0o755)
    const hostile = `${dir}/x"; touch ${pwned}; echo "`
    const legacyTemplate = [
      '<plist version="1.0"><dict>',
      '<key>ProgramArguments</key><array>',
      '<string>/bin/sh</string><string>-c</string>',
      '<string>"{{NODE_PATH}}" "{{CLI_PATH}}" check {{STATE_FLAG}} "{{STATE_ROOT}}" --json</string>',
      '</array></dict></plist>',
    ].join('\n')
    // The guard is what stands between this template and a registration, so the
    // control first proves the *string* is what executes it.
    assert.equal(capture(() => renderAgentPlist({
      nodePath: recorder,
      cliPath: 'cli.js',
      stateRoot: hostile,
      template: legacyTemplate,
    })).code, CODES.agentPathUnsafe, 'a template that interpolates a path into the shell command is refused')
    // The argv the old renderer really produced for this input, taken as the
    // shell would receive it from launchd.
    const legacyCommand = `"${recorder}" "cli.js" check --state-root "${hostile}" --json`
    spawnSync('/bin/sh', ['-c', legacyCommand], { encoding: 'utf8' })
    assert.equal(fs.existsSync(pwned), true, 'the control is not a control: this shape never ran the injection, so the test above proves nothing')
  } finally {
    removeDir(dir)
  }
})

test('a path carrying a control character is refused, not silently rendered', () => {
  const error = capture(() => renderAgentPlist({ cliPath: '/x/cli.js', stateRoot: '/tmp/a\nb' }))
  assert.equal(error.code, CODES.agentPathUnsafe)
  assert.match(error.message, /control character/)
  assert.equal(capture(() => renderAgentPlist({ cliPath: '/x/cli.js', stateRoot: null })).code, CODES.agentPathUnsafe)
  assert.equal(capture(() => renderAgentPlist({ cliPath: '', stateRoot: '/x' })).code, CODES.stateWriteUnverified)
})

test('an ampersand or a less-than in a path cannot rewrite the plist document', (t) => {
  if (process.platform !== 'darwin') return t.skip('plutil is the reader being satisfied here')
  const dir = tempDir(`${TMP_PREFIX}plist-escape-`)
  try {
    const stateRoot = `${dir}/a&b</string>c`
    const doc = plistToJson(renderAgentPlist({ cliPath: `${dir}/c&li.js`, stateRoot }), dir)
    assert.equal(doc.ProgramArguments[doc.ProgramArguments.length - 1], stateRoot)
    assert.equal(doc.StandardOutPath, `${stateRoot}/update.log`)
  } finally {
    removeDir(dir)
  }
})

test('the template defaults to one run a day at 12:00 local', () => {
  assert.equal(DEFAULT_HOUR, 12)
  assert.equal(DEFAULT_MINUTE, 0)
  const text = renderAgentPlist({ cliPath: '/x/cli.js', stateRoot: '/state' })
  assert.match(text, /<integer>12<\/integer>/)
})

test('enable boots out a stale definition, bootstraps it, and reads the loaded job back', () => {
  const dir = tempDir(`${TMP_PREFIX}launchd-enable-`)
  const stateRoot = '/Users/dev/.glasspane'
  const cliPath = `${stateRoot}/runtime/1.5.0/updater/cli.js`
  // 形状是从这台机器上真跑出来的作业抄的（`launchctl print gui/501/com.glasspane.daemon`）：参数一行
  // 一个、**不加引号**、Tab 缩进。之前这一版夹具写的是带引号的行，而本模块的解析器对"引号行里还有引号"
  // 是直接拒绝的，于是这条控制红在解析上，而不是红在它本该问的那件事上。第三行就是更新器那份 shell
  // 命令字面量——它自己带引号，正好检验解析器不会被它绊倒。
  const printed = (arg) => [
    `gui/501/${AGENT_LABEL} = {`,
    '\tactive count = 1',
    '\tstate = not running',
    '',
    '\targuments = {',
    '\t\t/bin/sh',
    '\t\t-c',
    '\t\t"$0" "$1" check "$2" "$3" --json && "$0" "$1" apply "$2" "$3" --auto --json',
    `\t\t${arg}`,
    '\t\t--state-dir',
    `\t\t${stateRoot}`,
    '\t}',
    '}',
  ].join('\n')
  try {
    const calls = []
    const plistPath = path.join(dir, 'LaunchAgents', `${AGENT_LABEL}.plist`)
    const outcome = registerAgent({
      label: AGENT_LABEL,
      plistPath,
      plistText: '<plist>rendered</plist>',
      cliPath,
      uid: '501',
      run: (bin, args) => {
        calls.push([bin, ...args])
        if (args[0] === 'bootstrap') return { status: 0, stdout: '', stderr: '' }
        if (args[0] === 'print') return { status: 0, stdout: printed(cliPath), stderr: '' }
        return { status: 3, stdout: '', stderr: 'No such process' }
      },
    })
    assert.equal(outcome.ok, true, outcome.message)
    assert.equal(outcome.verified, true, 'bootstrap 退出 0 不等于作业换成了这一份：必须读回来')
    assert.deepEqual(calls, [
      ['launchctl', 'bootout', `gui/501/${AGENT_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', plistPath],
      ['launchctl', 'print', `gui/501/${AGENT_LABEL}`],
    ], 'bootout runs first: launchd caches the definition it read at bootstrap time; print is the read-back')
    assert.equal(modeOf(plistPath), 0o600, 'a registered agent definition is owner-only')

    const failing = registerAgent({
      label: AGENT_LABEL,
      plistPath: path.join(dir, 'other.plist'),
      plistText: 'x',
      cliPath,
      uid: '501',
      run: () => ({ status: 2, stdout: '', stderr: 'Operation not permitted' }),
      writeFile: () => undefined,
      removeFile: () => undefined,
    })
    assert.equal(failing.ok, false)
    assert.match(failing.message, /Operation not permitted/)
  } finally {
    removeDir(dir)
  }
})

test('a refused re-registration puts the previous definition back instead of leaving no agent', () => {
  // This call booted the working job out before bootstrap failed, so "delete the file and report a refusal"
  // leaves the machine with neither a job nor a definition — and a refused enable writes no state, so nothing
  // on the machine records that auto-update just went blind. Measured shape from this machine on 2026-10-03:
  // the state file's last entry was a successful `enable`, yet `launchctl print` had no such job and
  // ~/Library/LaunchAgents held no plist. REVERSE MUTATION: drop the `previous !== null` restore branch.
  const dir = tempDir(`${TMP_PREFIX}launchd-rollback-`)
  const plistPath = path.join(dir, 'LaunchAgents', `${AGENT_LABEL}.plist`)
  const previousText = '<plist>previous, working</plist>'
  fs.mkdirSync(path.dirname(plistPath), { recursive: true })
  fs.writeFileSync(plistPath, previousText, { mode: 0o600 })
  const calls = []
  let bootstraps = 0
  const outcome = registerAgent({
    label: AGENT_LABEL,
    plistPath,
    plistText: '<plist>new, refused</plist>',
    cliPath: '/Users/dev/.glasspane/runtime/agent-entry.js',
    uid: '501',
    run: (bin, args) => {
      calls.push(args.join(' '))
      if (args[0] === 'bootstrap') {
        bootstraps += 1
        return bootstraps === 1
          ? { status: 5, stdout: '', stderr: 'Could not find service in domain' }
          : { status: 0, stdout: '', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(outcome.ok, false, '要换的那一份没换成，就不能报成功')
  assert.equal(outcome.restored, true, outcome.message)
  assert.match(outcome.message, /previous definition is back|the definition this machine had before/, outcome.message)
  assert.match(outcome.message, /Could not find service/, 'launchd 的原话要在句子里')
  assert.equal(fs.readFileSync(plistPath, 'utf8'), previousText, '盘上留下的必须是先前那一份能加载的定义')
  const steps = calls.filter((line) => line.startsWith('bootout') || line.startsWith('bootstrap'))
  assert.deepEqual(steps, [
    `bootout gui/501/${AGENT_LABEL}`,
    `bootstrap gui/501 ${plistPath}`,
    `bootstrap gui/501 ${plistPath}`,
  ], '回滚要真的再 bootstrap 一次，只把文件写回去不算')
  assert.equal(modeOf(plistPath), 0o600, '重新写回的那份同样是 owner-only')
  removeDir(dir)
})

test('a first registration that launchd refuses leaves no unloadable file behind', () => {
  // The other half of the same branch: with no previous definition there is nothing to put back, and the
  // file this call wrote is unloadable, so it must go — and the sentence must say the machine has no agent.
  const dir = tempDir(`${TMP_PREFIX}launchd-fresh-`)
  const plistPath = path.join(dir, 'LaunchAgents', `${AGENT_LABEL}.plist`)
  fs.mkdirSync(path.dirname(plistPath), { recursive: true })
  const outcome = registerAgent({
    label: AGENT_LABEL,
    plistPath,
    plistText: '<plist>new, refused</plist>',
    cliPath: '/Users/dev/.glasspane/runtime/agent-entry.js',
    uid: '501',
    run: (bin, args) => (args[0] === 'bootstrap' ? { status: 5, stdout: '', stderr: 'I/O error' } : { status: 3, stdout: '', stderr: 'Operation not found: 3' }),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.restored, false)
  assert.equal(fs.existsSync(plistPath), false, '没有旧定义可还原时，不许留一份加载不了的 plist')
  assert.match(outcome.message, /was left in place only if bootstrap succeeded/, outcome.message)
  removeDir(dir)
})

test('a job that still names the old command line is not reported as replaced', () => {
  const dir = tempDir(`${TMP_PREFIX}launchd-stale-`)
  const cliPath = '/Users/dev/.glasspane/runtime/1.5.0/updater/cli.js'
  try {
    const outcome = registerAgent({
      label: AGENT_LABEL,
      plistPath: path.join(dir, 'LaunchAgents', `${AGENT_LABEL}.plist`),
      plistText: '<plist>rendered</plist>',
      cliPath,
      uid: '501',
      run: (bin, args) => {
        if (args[0] === 'print') {
          return { status: 0, stdout: ['gui/501/com.glasspane.update = {', '    arguments = {', `        "${'/Users/dev/old-install/updater/cli.js'}"`, '    }', '}'].join('\n'), stderr: '' }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      writeFile: () => undefined,
    })
    assert.equal(outcome.ok, false, 'launchd 手里还是旧那份时，"已注册"是一句假话')
    assert.match(outcome.message, /was not replaced/)
    assert.match(outcome.message, /old-install/, '句子里要看得见读回来的那条命令，否则人只能猜')
  } finally {
    removeDir(dir)
  }
})

test('an unreadable job book is said as unverified instead of either verdict', () => {
  const dir = tempDir(`${TMP_PREFIX}launchd-unknown-`)
  try {
    const outcome = registerAgent({
      label: AGENT_LABEL,
      plistPath: path.join(dir, 'LaunchAgents', `${AGENT_LABEL}.plist`),
      plistText: '<plist>rendered</plist>',
      cliPath: '/x/cli.js',
      uid: '501',
      run: (bin, args) => (args[0] === 'print'
        ? { status: 5, stdout: '', stderr: 'I/O error' }
        : { status: 0, stdout: '', stderr: '' }),
      writeFile: () => undefined,
    })
    assert.equal(outcome.ok, true, '作业已经装载，这里拒绝等于告诉用户"自动更新是关的"而没有证据')
    assert.equal(outcome.verified, false)
    assert.match(outcome.message, /could not be read back/)
  } finally {
    removeDir(dir)
  }
})

test('a label that is not this project\'s own is refused before launchctl is asked for anything', () => {
  // The pointer file is written by another process, and this value decides both which job
  // `launchctl bootout` tears down and what the plist in ~/Library/LaunchAgents is *named*. A caller
  // that passed somebody else's label would unregister their login item and leave a plist behind under
  // their name; the rule has to be a refusal, not a comment in the caller.
  for (const foreign of ['com.microsoft.autoupdate', 'com.apple.spotlight', 'com.glasspane.updat', 'com.glasspane.extra']) {
    const calls = []
    assert.throws(
      () => registerAgent({ label: foreign, plistPath: '/tmp/nope.plist', plistText: 'x', uid: '501', run: (bin, args) => { calls.push(args); return { status: 0, stdout: '', stderr: '' } } }),
      (error) => error.code === CODES.agentPathUnsafe && /only ever registers/.test(error.message) && /not GlassPane's/.test(error.message),
      `${foreign} 不能被当成更新器的作业标签`,
    )
    assert.deepEqual(calls, [], '拒绝发生在任何 launchctl 调用之前')
    assert.throws(() => unregisterAgent({ label: foreign, plistPath: '/tmp/nope.plist', uid: '501', run: () => ({ status: 0, stdout: '', stderr: '' }) }), (error) => error.code === CODES.agentPathUnsafe)
    assert.throws(() => agentPlistPath({ label: foreign, homeDir: '/Users/dev' }), (error) => error.code === CODES.agentPathUnsafe)
  }
  assert.equal(agentPlistPath({ homeDir: '/Users/dev' }), path.join('/Users/dev', 'Library', 'LaunchAgents', 'com.glasspane.update.plist'), '自己那份照旧通过')
})

test('disable boots the agent out and removes its plist; an unloaded job is already done', () => {
  const dir = tempDir(`${TMP_PREFIX}launchd-disable-`)
  try {
    const plistPath = path.join(dir, 'com.glasspane.update.plist')
    fs.writeFileSync(plistPath, 'x')
    const calls = []
    const outcome = unregisterAgent({
      label: AGENT_LABEL,
      plistPath,
      uid: '501',
      run: (bin, args) => {
        calls.push(args.join(' '))
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    assert.equal(outcome.ok, true)
    assert.deepEqual(calls, ['bootout gui/501/com.glasspane.update'])
    assert.ok(!fs.existsSync(plistPath))

    fs.writeFileSync(plistPath, 'x')
    const already = unregisterAgent({
      label: AGENT_LABEL,
      plistPath,
      uid: '501',
      run: () => ({ status: 3, stdout: '', stderr: 'No such process' }),
    })
    assert.equal(already.ok, true, 'exit 3 means "not loaded", which is the state disable wants')
    assert.ok(!fs.existsSync(plistPath))

    fs.writeFileSync(plistPath, 'x')
    const refused = unregisterAgent({ label: AGENT_LABEL, plistPath, uid: '501', run: () => ({ status: 5, stdout: '', stderr: 'I/O error' }) })
    assert.equal(refused.ok, false)
    assert.ok(fs.existsSync(plistPath), 'a bootout that failed leaves the definition in place')
  } finally {
    removeDir(dir)
  }
})

test('kickstart names the daemon job in the gui domain, and reports a failure', () => {
  const calls = []
  const ok = kickstartJob({ uid: '501', run: (bin, args) => { calls.push([bin, ...args]); return { status: 0, stdout: '', stderr: '' } } })
  assert.equal(ok.ok, true)
  assert.deepEqual(calls, [['launchctl', 'kickstart', '-k', 'gui/501/com.glasspane.daemon']])
  const bad = kickstartJob({ uid: '501', run: () => ({ status: 125, stdout: '', stderr: 'Could not find service' }) })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /Could not find service/)
})

test('the agent plist lands in ~/Library/LaunchAgents for the named home', () => {
  assert.equal(
    agentPlistPath({ homeDir: '/Users/dev' }),
    path.join('/Users/dev', 'Library', 'LaunchAgents', 'com.glasspane.update.plist'),
  )
})

/* ------------------------------------------------------------------ §2 fail-closed
 * `launchctl print` is the only evidence this tool has that the daemon it is
 * about to restart writes where it thinks it writes. Every case below is an
 * output the old reader *accepted*: it cut the argument list at the first `}`,
 * so a brace inside an argument hid whatever came after it — including a second
 * `--state-dir` pointing at another installation.
 *
 * REVERSE MUTATION (lib/launchd.js `parseArgumentsBlock`): go back to
 * `const end = body.indexOf(close)` over the whole remainder and take the lines
 * before it — `a --state-dir hidden behind an embedded brace still needs consent`
 * reports `ok: true` with no state dir, and the four "unknown" cases below all
 * turn into green lights for the swap.
 */

const PRINT_HIDDEN_ROOT = [
  'gui/501/com.glasspane.daemon = {',
  '    state = running',
  '    program = /Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned',
  '    arguments = {',
  '        "/Users/dev/Applications/GlassPane Daemon.app/Contents/MacOS/glasspaned"',
  '        "--socket-path"',
  '        "/Users/dev/.glasspane/engine.sock"',
  '        "--note=}"',
  '        "--state-dir"',
  '        "/Volumes/Other"',
  '    }',
  '}',
  '',
].join('\n')

test('a --state-dir hidden behind an embedded brace still needs consent', () => {
  const job = readRunningJob({ uid: '501', run: () => ({ status: 0, stdout: PRINT_HIDDEN_ROOT, stderr: '' }) })
  assert.equal(job.ok, true)
  assert.deepEqual(job.args.slice(3), ['--note=}', '--state-dir', '/Volumes/Other'], 'the whole list was read, not the part before the brace')
  assert.equal(job.stateDir, '/Volumes/Other')
  const decision = decideSwapPermission({ probe: { answered: true }, jobArgs: job.args, ourStateRoot: '/Users/dev/.glasspane' })
  assert.equal(decision.status, 'needs-consent', '§2: a daemon writing somebody else\u2019s state root is never swapped automatically')
  assert.equal(decision.code, CODES.nonDefaultStateDir)
  assert.match(decision.reason, /\/Volumes\/Other/)
})

test('an unquoted brace and an unclosed block are "unknown"; a bare quote is not', () => {
  const cases = {
    'an unquoted } in a bare token': PRINT_HIDDEN_ROOT.replace('"--note=}"', '--note=}'),
    // This one used to be a refusal and is now a decodable token — measured on this machine, the
    // update agent's own `-c` argument *begins* with a quote, so treating an opening quote as damage
    // made the job this subsystem registers for itself unreadable. The refusal list keeps the shapes
    // that can actually fake or abort the block boundary.
    'an unquoted { in a bare token': PRINT_HIDDEN_ROOT.replace('"--state-dir"', '--state-dir {'),
    // Both of these first versions were self-defeating and measured nothing:
    // deleting only the inner `    }` left the outer `}` on its own line, which
    // *is* a legal terminator, and putting `}` on the line before the closer left
    // the closer intact. A "malformed output" case has to actually remove or
    // corrupt the terminator, or the parser is being shown a well-formed job.
    'a block that never ends': PRINT_HIDDEN_ROOT.replace('    }\n}\n', '\n'),
    'a delimiter with text after it on the same line': PRINT_HIDDEN_ROOT.replace('    }', '    } // end'),
  }
  for (const [label, output] of Object.entries(cases)) {
    const job = readRunningJob({ uid: '501', run: () => ({ status: 0, stdout: output, stderr: '' }) })
    assert.equal(job.ok, false, `${label}: undecodable output must not be read as "no arguments"`)
    assert.equal(job.unknown, true, label)
    assert.equal(job.code, CODES.busyOrUnreachable)
    assert.match(job.reason, /could not be read|not read completely|cannot be decoded|carries an unquoted/, label)
  }

  // The case that changed, pinned so a later "be stricter" pass cannot quietly blind the read-back
  // again: one quotation mark at the start of a line is a token, not a truncation.
  const openQuote = readRunningJob({ uid: '501', run: () => ({ status: 0, stdout: PRINT_HIDDEN_ROOT.replace('"--state-dir"', '"--state-dir'), stderr: '' }) })
  assert.equal(openQuote.unknown, false, openQuote.reason)
  assert.ok(openQuote.args.some((arg) => arg.startsWith('"')), JSON.stringify(openQuote.args))
})

test('a job that names --state-dir twice is not a job whose root can be read', () => {
  const output = PRINT_HIDDEN_ROOT
    .replace('        "--state-dir"\n        "/Volumes/Other"', '        "--state-dir"\n        "/Volumes/Other"\n        "--state-dir"\n        "/Volumes/Third"')
  const job = readRunningJob({ uid: '501', run: () => ({ status: 0, stdout: output, stderr: '' }) })
  assert.equal(job.unknown, true)
  assert.match(job.reason, /more than once/)
  assert.match(job.reason, /\/Volumes\/Other, \/Volumes\/Third/)
  // The same arguments seen twice with one value is a normal job, not an ambiguity.
  assert.deepEqual(stateDirReadings(['--state-dir', '/a', '--state-dir', '/a']), ['/a'])
  assert.deepEqual(stateDirReadings(['--state-dir=/a', 'x']), ['/a'])
  assert.deepEqual(stateDirReadings(['glasspaned']), [])
})

/* ------------------------------------------------- the CA bundle the agent is handed */

/**
 * A strict reader, on purpose. `plutil` (and launchd itself) accept an XML comment
 * containing a double hyphen; `expat`, `xmllint` and Python's `plistlib` do not, and
 * the installed plist is the file someone reaches for when the job misbehaves. This
 * exact shape shipped in a real `~/Library/LaunchAgents` plist until a strict parser
 * was pointed at it, while every plutil-based assertion above stayed green — a lenient
 * oracle cannot see a malformation only strict readers refuse.
 */
function strictParse(file) {
  const py = 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb")); print("STRICT OK")'
  return spawnSync('python3', ['-c', py, file], { encoding: 'utf8' })
}

test('the rendered agent survives a strict XML/plist reader, not just plutil', (t) => {
  const dir = tempDir(`${TMP_PREFIX}plist-strict-`)
  try {
    for (const caBundle of ['/Users/dev/.glasspane/ca-roots.pem', null]) {
      const text = renderAgentPlist({ cliPath: '/x/cli.js', stateRoot: '/Users/dev/.glasspane', caBundle })
      const file = path.join(dir, caBundle ? 'with-bundle.plist' : 'no-bundle.plist')
      fs.writeFileSync(file, text)
      for (const comment of [...text.matchAll(/<!--([\s\S]*?)-->/g)]) {
        assert.equal(comment[1].includes('--'), false, '注释里出现连续连字符：严格解析器（expat/xmllint/plistlib）会整份拒收')
      }
      const strict = strictParse(file)
      if (strict.error && strict.error.code === 'ENOENT') return t.skip('python3 不在这台机器上，严格读者这一半没得测')
      assert.equal(strict.status, 0, `strict parser refused the rendered plist:\n${strict.stderr || ''}\n${text}`)
      assert.match(strict.stdout, /STRICT OK/)
    }
  } finally {
    removeDir(dir)
  }
})



test('the agent is handed the exported root bundle, because node reads it when the process starts', (t) => {
  if (process.platform !== 'darwin') return t.skip('plutil is the reader being satisfied here')
  const dir = tempDir(`${TMP_PREFIX}ca-env-`)
  try {
    const bundle = '/Users/dev/.glasspane/ca-roots.pem'
    const text = renderAgentPlist({ cliPath: '/x/cli.js', stateRoot: '/Users/dev/.glasspane', caBundle: bundle })
    const doc = plistToJson(text, dir)
    assert.equal(doc.EnvironmentVariables.NODE_EXTRA_CA_CERTS, bundle, 'a bundle that exists but is not in the job environment changes nothing')
  } finally {
    removeDir(dir)
  }
})

test('no bundle means no EnvironmentVariables key at all — not an empty one, not an empty string', (t) => {
  if (process.platform !== 'darwin') return t.skip('plutil is the reader being satisfied here')
  const dir = tempDir(`${TMP_PREFIX}ca-none-`)
  try {
    const text = renderAgentPlist({ cliPath: '/x/cli.js', stateRoot: '/Users/dev/.glasspane' })
    const doc = plistToJson(text, dir)
    assert.equal('EnvironmentVariables' in doc, false, 'NODE_EXTRA_CA_CERTS="" is a bundle path that points at nothing; node fails at start-up on an unreadable file')
    // The absence has to be readable by a person too: the installed plist is the
    // artifact someone opens when the daily job misbehaves.
    assert.match(text, /NODE_EXTRA_CA_CERTS not set: this machine has no exported system root bundle/)
  } finally {
    removeDir(dir)
  }
})

test('a bundle path carrying XML metacharacters comes back byte-identical', (t) => {
  if (process.platform !== 'darwin') return t.skip('plutil is the reader being satisfied here')
  const dir = tempDir(`${TMP_PREFIX}ca-xml-`)
  try {
    const bundle = '/Users/dev/.glasspane/we&ird<c>"x".pem'
    const doc = plistToJson(renderAgentPlist({ cliPath: '/x/cli.js', stateRoot: '/Users/dev/.glasspane', caBundle: bundle }), dir)
    assert.equal(doc.EnvironmentVariables.NODE_EXTRA_CA_CERTS, bundle, 'an unescaped path rewrites the plist around itself and launchd reads a different job than this rendered')
  } finally {
    removeDir(dir)
  }
})

test('an unnamed bundle is refused instead of rendered as a job that trusts nothing', () => {
  for (const bad of ['', 42, {}]) {
    assert.equal(capture(() => agentEnvironmentBlock(bad)).code, CODES.agentPathUnsafe)
  }
  assert.equal(capture(() => renderAgentPlist({
    cliPath: '/x/cli.js',
    stateRoot: '/Users/dev/.glasspane',
    caBundle: '/Users/dev/.glasspane/\nca.pem',
  })).code, CODES.agentPathUnsafe, 'a newline in a path cannot survive launchd reading the plist, so it is refused here rather than silently dropped')
})

test('a template that lost the ENV_BLOCK slot cannot be handed a bundle silently', () => {
  assert.match(fs.readFileSync(AGENT_TEMPLATE, 'utf8'), /\{\{ENV_BLOCK\}\}/, 'the shipped template no longer asks for the environment block, so the bundle would never reach the job')
  const body = fs.readFileSync(AGENT_TEMPLATE, 'utf8').replace('{{ENV_BLOCK}}', '<!-- slot gone -->')
  // The plist still renders, still parses, still runs — it just never gets the
  // bundle, and on an intercepted machine that is a daily failure that looks like
  // a network problem. So: refuse when there was a bundle to hand over.
  const error = capture(() => renderAgentPlist({
    cliPath: '/x/cli.js',
    stateRoot: '/Users/dev/.glasspane',
    caBundle: '/Users/dev/.glasspane/ca-roots.pem',
    template: body,
  }))
  assert.equal(error.code, CODES.agentPathUnsafe)
  assert.match(error.message, /\{\{ENV_BLOCK\}\}/)
  // …and the same template is fine when there is no bundle to place.
  assert.doesNotThrow(() => renderAgentPlist({ cliPath: '/x/cli.js', stateRoot: '/Users/dev/.glasspane', template: body }))
})

/** The refusal, as data. */
function capture(fn) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof UpdaterError, 'expected an UpdaterError, got ' + error)
    return error
  }
  throw new assert.AssertionError({ message: 'the call was expected to refuse, and it did not' })
}

test('every substituted token keeps a `$&` in the value verbatim (replaceAll semantics, not XML)', (t) => {
  if (process.platform !== 'darwin') return t.skip('plutil is the reader being satisfied here')
  const dir = tempDir(`${TMP_PREFIX}plist-dollar-`)
  try {
    // `String.prototype.replaceAll(token, value)` 会把替换串里的 `$&` 展开成"刚才匹配到的那段"，
    // 于是路径里一个 `$&` 就能把 plist 的前文原样拼回 <string>。XML 转义对它无效 —— 这是字符串
    // 替换语义，不是文档语义。而这些值全部来自另一个进程写的文件（指针、状态根、日志路径）。
    const values = {
      nodePath: '/usr/local/bin/node$&',
      cliPath: '/Users/x/my app$&/updater/cli.js',
      stateRoot: '/Users/x/.glasspane$&',
      logPath: '/Users/x/.glasspane$&/update.log',
    }
    const doc = plistToJson(renderAgentPlist({ ...values, caBundle: '/Users/x/.glasspane$&/ca-roots.pem' }), dir)
    assert.deepEqual(doc.ProgramArguments.slice(3), [values.nodePath, values.cliPath, '--state-root', values.stateRoot],
      'argv 槽位必须逐字等于传进来的路径')
    assert.equal(doc.StandardOutPath, values.logPath, JSON.stringify(doc.StandardOutPath))
    assert.equal(doc.EnvironmentVariables.NODE_EXTRA_CA_CERTS, '/Users/x/.glasspane$&/ca-roots.pem')
    assert.equal(doc.ProgramArguments[2].includes('glasspane$&'), false, 'shell 里那句命令是常量，不该被任何值改写')
  } finally {
    removeDir(dir)
  }
})
