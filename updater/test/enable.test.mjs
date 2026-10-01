/**
 * §9 through the CLI: registering the agent is the moment the root bundle is
 * produced, so this is where "the daily job would never have gotten it" is caught.
 *
 * It also closes a hole the round-12 review found by asking a simple question:
 * nothing in this suite ever ran `enable`. `registerAgent`/`renderAgentPlist` were
 * each tested as functions, so a CLI that called them with the wrong arguments — or
 * recorded a CA status the panel would never see — would have stayed green.
 *
 * REVERSE MUTATION, each verified to redden the named test:
 *   · hand the renderer `caBundle: null` always   → "the job is handed the bundle"
 *   · write `caRoots` even when registration fails → "a refused registration records nothing new"
 *   · export before honouring GLASSPANE_UPDATE_DISABLE → "a disabled machine is not touched"
 *   · drop the CA sentence from the success message  → "empty is said out loud"
 *   · clear `caRoots` on disable                     → "disable keeps the last export on disk"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { runCommand } from '../cli.js'
import { CODES, EXIT } from '../lib/codes.js'
import { CA_ENV_VAR } from '../lib/ca-bundle.js'
import { AGENT_LABEL } from '../lib/launchd.js'
import { loadState } from '../lib/state.js'
import { ensureAgentEntry as realEnsureAgentEntry } from '../lib/agent-entry.js'
import { TMP_PREFIX, removeDir, tempDir } from './helpers.mjs'

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBFAKE\n-----END CERTIFICATE-----\n'

function harness({ bundle = true, record = { status: 'ok', certs: 3, path: null, exportedAt: 'now', detail: null }, register = { ok: true, message: 'agent registered', verified: true }, schedule = { hour: 12, minute: 0 }, entry = null } = {}) {
  // `${TMP_PREFIX}…` and realpathSync: the CLI canonicalises `--state-dir` the way
  // launchd would resolve it, so `/tmp` (a symlink) must be compared as its real
  // path, and the scratch must never be created inside the repository.
  const raw = tempDir(`${TMP_PREFIX}enable-`)
  const stateRoot = fs.realpathSync(raw)
  const calls = []
  const fixedRecord = { ...record, path: record.path ?? (bundle ? path.join(stateRoot, 'ca-roots.pem') : null) }
  if (bundle) fs.writeFileSync(fixedRecord.path, PEM, 'utf8')
  const plistPath = path.join(stateRoot, 'LaunchAgents', `${AGENT_LABEL}.plist`)
  // `readAgentSchedule` is deliberately NOT stubbed: reading back the schedule is the whole point, and
  // a stub would let a CLI that never consults it stay green. This is the file the real function reads.
  if (schedule) {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true })
    fs.writeFileSync(plistPath, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '  <dict>',
      '    <key>Label</key>',
      `    <string>${AGENT_LABEL}</string>`,
      '    <key>StartCalendarInterval</key>',
      '    <dict>',
      '      <key>Hour</key>',
      `      <integer>${schedule.hour}</integer>`,
      '      <key>Minute</key>',
      `      <integer>${schedule.minute}</integer>`,
      '    </dict>',
      '  </dict>',
      '</plist>',
      '',
    ].join('\n'), 'utf8')
  }
  const rendered = []
  const deps = {
    homeDir: stateRoot,
    uid: '501',
    runLaunchctl: () => ({ status: 0, stdout: '', stderr: '' }),
    refreshCaBundle: () => {
      calls.push('refresh')
      return fixedRecord
    },
    usableCaBundle: () => {
      calls.push('usable')
      return { usable: bundle, certs: bundle ? 1 : 0, reason: bundle ? null : 'absent' }
    },
    renderAgentPlist: (options) => {
      calls.push({ render: options.caBundle === undefined ? 'unset' : options.caBundle })
      rendered.push(options)
      return [
        '<plist version="1.0"><dict>',
        '  <key>StartCalendarInterval</key>',
        '  <dict>',
        '    <key>Hour</key>',
        `    <integer>${options.hour}</integer>`,
        '    <key>Minute</key>',
        `    <integer>${options.minute}</integer>`,
        '  </dict>',
        `  <key>ProgramArguments</key><array><string>${options.cliPath}</string></array>`,
        '</dict></plist>',
        '',
      ].join('\n')
    },
    registerAgent: (options) => {
      calls.push({ register: options.plistPath })
      return { ...register, plistPath: options.plistPath }
    },
    unregisterAgent: () => {
      calls.push('unregister')
      return { ok: true, message: 'agent removed' }
    },
    agentPlistPath: ({ label = AGENT_LABEL }) => path.join(stateRoot, 'LaunchAgents', `${label}.plist`),
    // The real installer of the entry is used unless a test asks for a refusal: it lands
    // `updater/agent-entry.js` inside this harness's own scratch state root, so nothing outside is
    // touched, and the registration assertions below are made against the file that really exists
    // rather than against a path a stub invented.
    ensureAgentEntry: (options) => (entry !== null
      ? entry
      : realEnsureAgentEntry({ ...options, stateRoot })),
    now: () => new Date('2026-09-29T09:00:00.000Z'),
  }
  return {
    stateRoot,
    calls,
    plistPath,
    rendered,
    record: fixedRecord,
    run: (command, flags = {}, env = {}) => runCommand({ command, flags: { 'state-dir': stateRoot, ...flags }, env, deps }),
    // removeDir only deletes under the prefix it created; `stateRoot` is the
    // canonical path (/tmp is a symlink to /private/tmp on macOS), so removal has to
    // go by the directory this harness actually made.
    done() {
      removeDir(raw)
    },
  }
}

test('enable exports the bundle, hands its path to the job, and records what happened', async () => {
  const h = harness()
  try {
    const result = await h.run('enable')
    assert.equal(result.ok, true, result.message)
    assert.equal(result.exitCode, EXIT.OK)
    assert.deepEqual(h.calls, ['refresh', 'usable', { render: path.join(h.stateRoot, 'ca-roots.pem') }, { register: path.join(h.stateRoot, 'LaunchAgents', `${AGENT_LABEL}.plist`) }],
      'export first, then the renderer needs to know whether there is a file to point at')
    const saved = loadState(h.stateRoot).state
    assert.equal(saved.caRoots.status, 'ok')
    assert.equal(saved.caRoots.certs, 3)
    assert.equal(saved.disabled, false)
  } finally {
    h.done()
  }
})

test('a machine with no bundle still registers, but the job is not pointed at a file that is not there', async () => {
  const h = harness({ bundle: false, record: { status: 'unavailable', certs: 0, path: null, exportedAt: 'now', detail: 'no security tool' } })
  try {
    const result = await h.run('enable')
    assert.equal(result.ok, true, 'an un-intercepted network does not need this file; refusing to register would be a new outage')
    assert.equal(h.calls.find((c) => typeof c === 'object' && 'render' in c).render, null)
    assert.match(result.message, /"security" tool is not here/, 'the refusal to pretend is in the sentence the installer reads')
    assert.equal(loadState(h.stateRoot).state.caRoots.status, 'unavailable')
  } finally {
    h.done()
  }
})

test('an export that produced nothing is said out loud, not folded into "automatic update is on"', async () => {
  const h = harness({ bundle: false, record: { status: 'empty', certs: 0, path: null, exportedAt: 'now', detail: 'both keychains empty' } })
  try {
    const result = await h.run('enable')
    assert.equal(result.ok, true)
    assert.match(result.message, /produced no certificate/)
    assert.match(result.message, /updater enable|keychain/, 'and it comes with the next step in the same breath')
    assert.ok(result.message.includes('automatic update is on'), 'the agent really was registered: the CA sentence is an addition, not a substitution')
  } finally {
    h.done()
  }
})

test('a disabled machine is not touched: no export, no registration, no status written', async () => {
  const h = harness()
  try {
    const result = await h.run('enable', {}, { GLASSPANE_UPDATE_DISABLE: '1' })
    assert.equal(result.ok, false)
    assert.equal(result.code, CODES.autoDisabled)
    assert.equal(result.exitCode, EXIT.REFUSED)
    assert.deepEqual(h.calls, [], 'exporting a root bundle into somebody\'s state root while telling them automatic update is off is a change they did not ask for')
  } finally {
    h.done()
  }
})

test('the job is registered against the stable entry, never against the script that is running', async () => {
  // The one property §11's entry design rests on. If the plist ever goes back to naming a versioned
  // script, every version move needs a re-registration again — and a scheduled run cannot do that to
  // itself, which is the whole reason the manual step existed. Asserted on the renderer's argument and
  // on the file the fake registration writes, because the plist on disk is what launchd reads.
  const h = harness()
  try {
    const result = await h.run('enable')
    assert.equal(result.ok, true, result.message)
    const entry = path.join(h.stateRoot, 'runtime', 'agent-entry.js')
    assert.equal(h.rendered[0].cliPath, entry, `注册的位置必须是稳定入口，不是这一份 cli.js：${h.rendered[0].cliPath}`)
    assert.notEqual(h.rendered[0].cliPath, new URL('../cli.js', import.meta.url).pathname)
    assert.ok(fs.existsSync(entry), '入口文件要真在盘上——plist 指到一个不存在的文件就是明天的 Cannot find module')
    assert.match(fs.readFileSync(entry, 'utf8'), /resolveUpdaterCli/)
    assert.ok(!result.message.includes('versioned script'), result.message)
  } finally {
    h.done()
  }
})

test('a machine that cannot install the entry is told which shape it ended up with', async () => {
  // Falling back to the versioned path is still a working registration; silently, it is a machine that
  // will ask for a manual enable again on the next version, and only the message can say which happened.
  const h = harness({ entry: { ok: false, message: 'the state root is mounted read-only' } })
  try {
    const result = await h.run('enable')
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /versioned script/, result.message)
    assert.match(result.message, /one manual "enable"/, `要说清代价：${result.message}`)
  } finally {
    h.done()
  }
})

test('a bare enable keeps the daily hour that is already installed', async () => {
  // §11's handover runs `enable` from the new copy with no flags, and the installer's own re-run does
  // the same. Honouring the constant here would move a machine installed with `--hour 3` to midday on
  // the first self-update, with nothing in the state file, the history, the panel or `gp_diagnose` to
  // say the schedule changed — which is §2's "the time is configurable" quietly becoming false.
  //
  // The assertion is on what reached the renderer, not on the file at `plistPath`: the harness seeds
  // that file with the standing schedule, and `registerAgent` is stubbed, so reading the disk here was
  // satisfied by the fixture itself — a control that could not have failed.
  const h = harness({ schedule: { hour: 3, minute: 20 } })
  try {
    const result = await h.run('enable')
    assert.equal(result.ok, true, result.message)
    assert.equal(h.rendered.length, 1, JSON.stringify(h.rendered))
    assert.equal(h.rendered[0].hour, 3, `装机时刻要保住：送进渲染器的是 ${h.rendered[0].hour}`)
    assert.equal(h.rendered[0].minute, 20, `分钟也一样：${h.rendered[0].minute}`)
    assert.ok(!result.message.includes('the daily time is'), `读到了在册时刻就不该再说兜底：${result.message}`)
  } finally {
    h.done()
  }
})

test('an explicit --hour wins over the installed one, and an unreadable schedule says which was used', async () => {
  const chosen = harness({ schedule: { hour: 3, minute: 0 } })
  try {
    const result = await chosen.run('enable', { hour: '7', minute: '45' })
    assert.equal(result.ok, true, result.message)
    assert.equal(chosen.rendered[0].hour, 7, `人当面给的时刻优先，这是 §2 的另一半：${chosen.rendered[0].hour}`)
    assert.equal(chosen.rendered[0].minute, 45)
  } finally {
    chosen.done()
  }

  const blind = harness({ schedule: null })
  try {
    const result = await blind.run('enable')
    assert.equal(result.ok, true, result.message)
    assert.equal(blind.rendered[0].hour, 12, '读不到就按文档默认，但这一句必须说')
    assert.match(result.message, /the daily time is 12:00/, result.message)
    assert.match(result.message, /pass --hour and --minute/, result.message)
  } finally {
    blind.done()
  }
})

test('a registration launchd could not be re-read with is reported as unverified, not as registered', async () => {
  // "已注册"的证据只能是读回来的那份在册作业。读不回来时这一句仍然算成立（bootstrap 成功了，作业
  // 确实装载了），但 `agentVerified=false` 必须出现在结果里——安装器与面板都靠它决定自己敢不敢说
  // "每天会跑"。
  const h = harness({ register: { ok: true, message: 'update agent loaded but the loaded job could not be read back', verified: false } })
  try {
    const result = await h.run('enable')
    assert.equal(result.ok, true)
    assert.equal(result.exitCode, EXIT.OK)
    assert.equal(result.agentVerified, false, JSON.stringify(result))
    assert.match(result.message, /could not be read back/, result.message)
  } finally {
    h.done()
  }
})

test('a registration that launchd refused records no fresh export', async () => {
  const h = harness({ register: { ok: false, code: CODES.busyOrUnreachable, message: 'bootstrap failed' } })
  try {
    const result = await h.run('enable')
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, EXIT.REFUSED)
    assert.ok(!fs.existsSync(path.join(h.stateRoot, 'update-state.json')),
      'launchd said no: a state file written here would tell the panel an agent exists, and the panel would wait on a job nobody registered')
    assert.deepEqual(h.calls.filter((c) => typeof c === 'object' && 'register' in c).length, 1, 'registration was attempted once, and only once')
  } finally {
    h.done()
  }
})

test('disable keeps the last export on disk', async () => {
  const h = harness()
  try {
    await h.run('enable')
    const before = loadState(h.stateRoot).state.caRoots
    assert.equal(before.status, 'ok')
    h.calls.length = 0
    const result = await h.run('disable')
    assert.equal(result.ok, true)
    assert.deepEqual(h.calls, ['unregister'], 'turning the schedule off is not a reason to rewrite machine trust')
    assert.deepEqual(loadState(h.stateRoot).state.caRoots, before)
  } finally {
    h.done()
  }
})

test('the environment variable the job must carry is the one node actually reads', async () => {
  assert.equal(CA_ENV_VAR, 'NODE_EXTRA_CA_CERTS', 'a typo here is a job that silently ignores a perfectly good bundle')
  const h = harness()
  try {
    const result = await h.run('enable')
    assert.equal(result.ok, true)
    const rendered = h.calls.find((c) => typeof c === 'object' && 'render' in c)
    assert.ok(rendered.render.endsWith('ca-roots.pem'), JSON.stringify(rendered))
  } finally {
    h.done()
  }
})
