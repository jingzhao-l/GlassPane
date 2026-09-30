/**
 * §6 row "major 不自动应用".
 *
 * REVERSE MUTATION: delete the `kind === 'major' && !hasConsent` branch in
 * `decideUpdate` (and the matching branch in `applyUpdate`) — `a major bump is
 * needs-consent and is never auto-applied` goes red, because the offer would
 * come back `available` with `autoApplyAllowed: true`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CONSENT_KINDS, decideSwapPermission, decideUpdate, foreignStateDir, stateDirFromArgs, stateDirReadings } from '../lib/policy.js'
import { CODES } from '../lib/codes.js'

test('a major bump is needs-consent and is never auto-applied', () => {
  const decision = decideUpdate({ currentVersion: '1.4.2', tag: 'v2.0.0' })
  assert.equal(decision.status, 'needs-consent')
  assert.equal(decision.code, CODES.consentRequired)
  assert.equal(decision.autoApplyAllowed, false)
  assert.equal(decision.kind, 'major')
  assert.match(decision.reason, /press "Install update"/)
})

test('a major with an explicit human consent becomes an ordinary offer', () => {
  const decision = decideUpdate({ currentVersion: '1.4.2', tag: 'v2.0.0', consents: ['major'] })
  assert.equal(decision.status, 'available')
  assert.equal(decision.autoApplyAllowed, true)
})

test('patch and minor bumps are the only automatic ones', () => {
  assert.deepEqual(
    pick(decideUpdate({ currentVersion: '1.4.2', tag: 'v1.4.3' }), ['status', 'autoApplyAllowed', 'kind']),
    { status: 'available', autoApplyAllowed: true, kind: 'patch' },
  )
  assert.deepEqual(
    pick(decideUpdate({ currentVersion: '1.4.2', tag: 'v1.5.0' }), ['status', 'autoApplyAllowed', 'kind']),
    { status: 'available', autoApplyAllowed: true, kind: 'minor' },
  )
})

test('equal is up-to-date, older is not an update at all', () => {
  assert.equal(decideUpdate({ currentVersion: '1.4.2', tag: 'v1.4.2' }).status, 'up-to-date')
  const older = decideUpdate({ currentVersion: '1.4.2', tag: 'v1.4.1' })
  assert.equal(older.status, 'up-to-date')
  assert.equal(older.autoApplyAllowed, false)
  assert.match(older.reason, /older/)
})

test('the user switch stops the automatic path but keeps the offer visible', () => {
  const decision = decideUpdate({ currentVersion: '1.4.2', tag: 'v1.4.3', autoApply: false })
  assert.equal(decision.status, 'available')
  assert.equal(decision.autoApplyAllowed, false)
  assert.match(decision.reason, /switched off/)
})

test('an unanswered probe defers the swap; it never reads as "dead, restart it"', () => {
  const decision = decideSwapPermission({
    probe: { answered: false, reason: 'the daemon did not answer within 5000ms' },
    jobArgs: [],
    ourStateRoot: '/tmp/gp-state',
  })
  assert.equal(decision.status, 'deferred')
  assert.equal(decision.code, CODES.busyOrUnreachable)
  assert.equal(decision.swapped, false)
})

test('a daemon writing somebody else\'s state root needs a human', () => {
  const decision = decideSwapPermission({
    probe: { answered: true },
    jobArgs: ['glasspaned', '--state-dir', '/Volumes/Other/.glasspane'],
    ourStateRoot: '/Users/dev/.glasspane',
  })
  assert.equal(decision.status, 'needs-consent')
  assert.equal(decision.code, CODES.nonDefaultStateDir)
  assert.match(decision.reason, /\/Volumes\/Other\/\.glasspane/)

  assert.equal(decideSwapPermission({ probe: { answered: true }, jobArgs: [], ourStateRoot: '/Users/dev/.glasspane' }).status, 'allowed')
  assert.equal(
    decideSwapPermission({
      probe: { answered: true },
      jobArgs: ['glasspaned', '--state-dir', '/Users/dev/.glasspane/'],
      ourStateRoot: '/Users/dev/.glasspane',
    }).status,
    'allowed',
    'naming the same root the tool was pointed at is not "foreign"',
  )
  assert.equal(
    decideSwapPermission({
      probe: { answered: true },
      jobArgs: ['--state-dir', '/elsewhere'],
      ourStateRoot: '/Users/dev/.glasspane',
      consented: [CONSENT_KINDS[1]],
    }).status,
    'allowed',
  )
})

test('both spellings of the state-root flag are read, and a missing value is not invented', () => {
  assert.equal(stateDirFromArgs(['glasspaned', '--state-dir', '/a/b']), '/a/b')
  assert.equal(stateDirFromArgs(['glasspaned', '--state-dir=/a/b']), '/a/b')
  assert.equal(stateDirFromArgs(['glasspaned', '--socket-path', '/x/y.sock']), null)
  assert.equal(stateDirFromArgs(['glasspaned', '--state-dir']), null, 'a flag with no value must not become the empty string')
  assert.equal(foreignStateDir({ jobArgs: ['--state-dir', '/a/b/'], ourStateRoot: '/a/b' }), null)

  // `--state-root` is not a hypothetical spelling: it is the one the daemon's own option uses
  // (`launchd.js` renders it into the job as `daemonFlag`), and it is what the update agent's
  // `launchctl print` output carried when it was captured from this machine on 2026-09-30. Reading
  // only `--state-dir` here meant a daemon started with `--state-root /somewhere/else` looked like a
  // job with *no* state flag, so §2's foreign-root gate — the one that exists to stop a swap against
  // somebody else's installation — had nothing to compare and let it through.
  assert.equal(stateDirFromArgs(['glasspaned', '--state-root', '/a/b']), '/a/b')
  assert.equal(stateDirFromArgs(['glasspaned', '--state-root=/a/b']), '/a/b')
  assert.equal(foreignStateDir({ jobArgs: ['--state-root', '/other/place'], ourStateRoot: '/a/b' }), '/other/place',
    '换个拼法写别人的状态根，这一道门照样要认出来')
  assert.deepEqual(stateDirReadings(['--state-dir', '/a', '--state-root', '/b']), ['/a', '/b'],
    '两种拼法都算数：同时出现就是"读不出这个作业写哪儿"')
  assert.equal(stateDirFromArgs(['glasspaned', '--state-root']), null, '同样的缺值规则')
})

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]))
}
