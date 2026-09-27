/**
 * §6 row "过期判定" (spec §4: `now - lastCheckAt > 36 h` shows "check overdue",
 * which is the fallback for "the fixed time hit while the machine was off").
 *
 * REVERSE MUTATION: set the threshold to infinity (never overdue) —
 * `a check 36 h + 1 minute old is overdue` goes red. Setting it to 0 also
 * reddens `exactly 36 h is not yet overdue`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { OVERDUE_THRESHOLD_MS, checkAgeMs, effectiveStatus, emptyState, isOverdue, loadState, saveState, updateSummary } from '../lib/state.js'
import { removeDir, tempDir, TMP_PREFIX } from './helpers.mjs'

const T0 = Date.parse('2026-09-26T12:00:00.000Z')

function checkedAt(iso, extra = {}) {
  return { ...emptyState({ now: new Date(T0) }), lastCheckAt: iso, status: 'up-to-date', ...extra }
}

test('the threshold is 36 hours, spelled once', () => {
  assert.equal(OVERDUE_THRESHOLD_MS, 36 * 60 * 60 * 1000)
})

test('a check 36 h + 1 minute old is overdue', () => {
  const state = checkedAt(new Date(T0).toISOString())
  assert.equal(isOverdue(state, T0 + OVERDUE_THRESHOLD_MS + 60_000), true)
  assert.equal(effectiveStatus(state, T0 + OVERDUE_THRESHOLD_MS + 60_000), 'check-overdue')
})

test('exactly 36 h is not yet overdue', () => {
  const state = checkedAt(new Date(T0).toISOString())
  assert.equal(isOverdue(state, T0 + OVERDUE_THRESHOLD_MS), false)
  assert.equal(effectiveStatus(state, T0 + OVERDUE_THRESHOLD_MS), 'up-to-date')
  assert.equal(checkAgeMs(state, T0 + OVERDUE_THRESHOLD_MS), OVERDUE_THRESHOLD_MS)
})

test('a fresh check is not overdue', () => {
  const state = checkedAt(new Date(T0).toISOString())
  assert.equal(isOverdue(state, T0 + 60_000), false)
  assert.equal(effectiveStatus(state, T0 + 60_000), 'up-to-date')
})

test('never having checked is overdue, not "up to date"', () => {
  const state = emptyState({ now: new Date(T0) })
  assert.equal(state.lastCheckAt, null)
  assert.equal(isOverdue(state, T0), true)
  assert.equal(checkAgeMs(state, T0), null)
  assert.equal(effectiveStatus(state, T0), 'check-overdue')
})

test('a refusal or a rollback is not hidden behind "overdue"', () => {
  const stale = new Date(T0 - 10 * 60 * 60 * 1000).toISOString()
  for (const status of ['deferred', 'needs-consent', 'rolled-back', 'check-failed', 'installer-pointer-stale', 'staged-build-failed']) {
    const verdict = effectiveStatus(checkedAt(stale, { status }), T0 + 10 * 60 * 60 * 1000)
    assert.equal(verdict, status, `${status} is the last real thing that happened and must stay visible`)
  }
  // A staged update is not "stale" either: the Install button has to stay live.
  assert.equal(effectiveStatus(checkedAt(stale, { status: 'staged' }), T0 + 10 * 60 * 60 * 1000), 'staged')
})

test('a disabled machine reports that it is off, and the panel keeps showing it', () => {
  const state = checkedAt(new Date(T0 - 40 * 60 * 60 * 1000).toISOString(), { disabled: true, status: 'disabled' })
  assert.equal(isOverdue(state, Date.parse(state.lastCheckAt) + OVERDUE_THRESHOLD_MS + 1), false)
  assert.equal(effectiveStatus(state, T0 + 1000), 'disabled')
  const summary = updateSummary(state, T0 + 1000)
  assert.equal(summary.disabled, true)
  assert.equal(summary.overdue, false)
})

test('the summary is what gp_diagnose and the panel read, and it carries the digest', () => {
  const dir = tempDir(`${TMP_PREFIX}overdue-`)
  try {
    const state = checkedAt(new Date(T0).toISOString(), {
      status: 'staged',
      current: '1.4.0',
      latest: '1.4.1',
      code: null,
      staged: { version: '1.4.1', dir: path.join(dir, 'update-staging', '1.4.1'), digest: 'ab'.repeat(32), at: new Date(T0).toISOString() },
    })
    saveState(dir, state, { now: new Date(T0) })
    const loaded = loadState(dir).state
    const summary = updateSummary(loaded, T0 + 37 * 60 * 60 * 1000)
    assert.deepEqual(Object.entries(summary).map(([k]) => k).sort(), [
      'autoApply', 'code', 'current', 'disabled', 'lastCheckAt', 'latest', 'overdue', 'stagedDigest', 'stagedVersion', 'status', 'storedStatus',
    ])
    assert.equal(summary.status, 'staged')
    assert.equal(summary.storedStatus, 'staged')
    assert.equal(summary.overdue, true, 'a staged offer with a stale check reports both facts; the panel keeps Install live and adds "Check now"')
    assert.equal(summary.stagedDigest, 'ab'.repeat(32))
    assert.equal(fs.existsSync(path.join(dir, 'update-state.json')), true)
  } finally {
    removeDir(dir)
  }
})
