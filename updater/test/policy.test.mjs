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

import { CONSENT_KINDS, decideSwapPermission, decideUpdate, foreignStateDir, stateDirFromArgs } from '../lib/policy.js'
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

test('both spellings of --state-dir are read, and a missing value is not invented', () => {
  assert.equal(stateDirFromArgs(['glasspaned', '--state-dir', '/a/b']), '/a/b')
  assert.equal(stateDirFromArgs(['glasspaned', '--state-dir=/a/b']), '/a/b')
  assert.equal(stateDirFromArgs(['glasspaned', '--socket-path', '/x/y.sock']), null)
  assert.equal(stateDirFromArgs(['glasspaned', '--state-dir']), null, 'a flag with no value must not become the empty string')
  assert.equal(foreignStateDir({ jobArgs: ['--state-dir', '/a/b/'], ourStateRoot: '/a/b' }), null)
})

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]))
}
