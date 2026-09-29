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
import { TMP_PREFIX, removeDir, tempDir } from './helpers.mjs'

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBFAKE\n-----END CERTIFICATE-----\n'

function harness({ bundle = true, record = { status: 'ok', certs: 3, path: null, exportedAt: 'now', detail: null }, register = { ok: true, message: 'agent registered' } } = {}) {
  // `${TMP_PREFIX}…` and realpathSync: the CLI canonicalises `--state-dir` the way
  // launchd would resolve it, so `/tmp` (a symlink) must be compared as its real
  // path, and the scratch must never be created inside the repository.
  const raw = tempDir(`${TMP_PREFIX}enable-`)
  const stateRoot = fs.realpathSync(raw)
  const calls = []
  const fixedRecord = { ...record, path: record.path ?? (bundle ? path.join(stateRoot, 'ca-roots.pem') : null) }
  if (bundle) fs.writeFileSync(fixedRecord.path, PEM, 'utf8')
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
      return '<plist>stub</plist>'
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
    now: () => new Date('2026-09-29T09:00:00.000Z'),
  }
  return {
    stateRoot,
    calls,
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
