/**
 * §6 row "状态文件 0600 + 读回校验".
 *
 * REVERSE MUTATION: drop the `chmod` in `writePrivateFile` (or drop the
 * read-back that follows it) — `a state file inherits nothing from the umask`
 * goes red: pre-creating the file world-readable and saving over it leaves 0644
 * on disk when the chmod is gone, and nothing fails when the verification is
 * gone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { CODES } from '../lib/codes.js'
import { UpdaterError, modeOf, writableRoots } from '../lib/fsutil.js'
import { HISTORY_LIMIT, OVERDUE_THRESHOLD_MS, emptyState, loadState, nextState, pushHistory, readPointer, saveState, updateSummary, writePointer } from '../lib/state.js'
import { assertValidState, loadSchema, validate } from '../lib/schema.js'
import { removeDir, tempDir, TMP_PREFIX } from './helpers.mjs'

const NOW = new Date('2026-09-27T12:00:00.000Z')

function freshRoot(label) {
  return tempDir(`${TMP_PREFIX}${label}-`)
}

test('the schema this package ships is the one the state file is checked against', () => {
  const schema = loadSchema()
  assert.equal(schema.$id, 'glasspane.update-state/1')
  assert.deepEqual(validate(schema, emptyState({ now: NOW })), [], 'the empty state must be valid, not merely constructible')
  // Gate 8's field: declared (so `nextState`, whose field list *is* the schema's
  // property list, actually carries it into the document) and deliberately not
  // required (a state file written before the signature gate existed must still
  // load, or this machine can never update again).
  assert.ok(Object.keys(schema.properties).includes('authorship'), 'authorship is not in the schema, so every write of it is silently dropped')
  assert.equal(schema.required.includes('authorship'), false)
  assert.equal(emptyState({ now: NOW }).authorship, null, 'a machine that has never checked has no authorship claim, not an unproven one')
  const closed = { version: '1.4.1', signature: 'verified', signedAsset: null, keyFingerprint: null, consented: false, at: NOW.toISOString() }
  assert.deepEqual(validate(schema, { ...emptyState({ now: NOW }), authorship: closed }), [])
  assert.throws(
    () => assertValidState({ ...emptyState({ now: NOW }), authorship: { ...closed, notaryAlgorithm: 'minisign' } }),
    /not allowed by the schema/,
    'an undeclared key *inside* the record is a refusal to write, which is the failure mode that gets noticed',
  )
  assert.throws(
    () => assertValidState({ ...emptyState({ now: NOW }), authorship: { ...closed, signature: 'probably-signed' } }),
    /not one of/,
    'the four authorship states are a closed enum too',
  )
})

test('a status outside the closed enum is never published', () => {
  const dir = freshRoot('state-enum')
  try {
    const state = { ...emptyState({ now: NOW }), status: 'probably-fine' }
    assert.throws(() => saveState(dir, state, { now: NOW }), (error) => /not one of/.test(error.message))
    assert.ok(!fs.existsSync(writableRoots(dir).stateFile), 'a rejected state leaves no file behind')
    // The mutation this row names: an unchecked write would accept this.
    const errors = validate(loadSchema(), { ...emptyState({ now: NOW }), status: 'maybe' })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /status/)
    assert.throws(() => assertValidState({ ...emptyState({ now: NOW }), unknownField: 1 }), /not allowed by the schema/)
    assert.throws(() => assertValidState({ ...emptyState({ now: NOW }), digest: 'x', history: [{ at: 'x', action: 'check', result: 'ok' }] }), /missing required property digest/)
    assert.throws(() => assertValidState({ ...emptyState({ now: NOW }), staged: { version: '1.4', dir: '/x', digest: 'y'.repeat(64), at: 'z' } }), /does not match/)
  } finally {
    removeDir(dir)
  }
})

test('a state file inherits nothing from the umask: 0600, and the directory 0700', () => {
  const dir = freshRoot('state-mode')
  try {
    const roots = writableRoots(dir)
    // The hostile starting condition: the file already exists world-readable
    // (an installer that wrote it with `Data.write` under umask 022), and so
    // does its directory.
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    fs.writeFileSync(roots.stateFile, JSON.stringify(emptyState({ now: NOW })), { mode: 0o644 })
    fs.chmodSync(roots.stateFile, 0o644)
    assert.equal(modeOf(roots.stateFile), 0o644, 'the fixture really starts loose')

    const saved = saveState(dir, emptyState({ now: NOW, autoApply: true }), { now: NOW })
    assert.equal(saved.mode, 0o600)
    assert.equal(modeOf(roots.stateFile), 0o600)
    assert.equal(modeOf(dir), 0o700, 'tighten-in-place, not tighten-only-what-you-create')
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), [], 'no temp file left next to the state')
  } finally {
    removeDir(dir)
  }
})

test('the bytes that land are the bytes that were written, re-parsed and re-validated', () => {
  const dir = freshRoot('state-roundtrip')
  try {
    const state = nextState(emptyState({ now: NOW }), {
      status: 'staged',
      code: null,
      current: '1.4.0',
      latest: '1.4.1',
      lastCheckAt: NOW.toISOString(),
      staged: { version: '1.4.1', dir: path.join(dir, 'update-staging', '1.4.1'), digest: 'c'.repeat(64), at: NOW.toISOString() },
      historyEntry: { action: 'check', result: 'staged', digest: 'c'.repeat(64) },
    }, { now: NOW })
    saveState(dir, state, { now: NOW })
    const loaded = loadState(dir)
    assert.equal(loaded.existed, true)
    assert.equal(loaded.mode, 0o600)
    assert.deepEqual(loaded.state, state)
    assert.equal(loaded.state.staged.digest, 'c'.repeat(64))

    // A corrupt file is a refusal with a code, not a silent empty state.
    const roots = writableRoots(dir)
    fs.writeFileSync(roots.stateFile, '{ not json')
    const error = capture(() => loadState(dir))
    assert.equal(error.code, CODES.stateWriteUnverified)
    assert.match(error.message, /not valid JSON/)
  } finally {
    removeDir(dir)
  }
})

test('history keeps the last ten rows, and only the first 12 digest characters', () => {
  const dir = freshRoot('state-history')
  try {
    let state = emptyState({ now: NOW })
    for (let i = 0; i < 14; i += 1) {
      state = nextState(state, {
        historyEntry: { action: 'check', result: i % 2 ? 'staged' : 'up-to-date', digest: `${i.toString(16).repeat(16)}.0`, code: null },
        lastCheckAt: new Date(NOW.getTime() + i * 1000).toISOString(),
      }, { now: new Date(NOW.getTime() + i * 1000) })
    }
    assert.equal(state.history.length, HISTORY_LIMIT)
    assert.equal(HISTORY_LIMIT, 10)
    assert.equal(state.history.at(-1).result, 'staged')
    assert.equal(state.history[0].at, new Date(NOW.getTime() + 4 * 1000).toISOString(), 'the four oldest rows are gone')
    assert.equal(state.history.at(-1).digest.length, 12, 'spec 3.5: digest stored as its leading 12 characters')
    saveState(dir, state, { now: NOW })
    assert.equal(loadState(dir).state.history.length, 10)
    assert.throws(
      () => saveState(dir, { ...state, history: [...state.history, { at: 'x', action: 'check', result: 'y', digest: null }] }, { now: NOW }),
      /maxItems/,
    )
  } finally {
    removeDir(dir)
  }
})

test('the disabled and autoApply switches survive a round trip and shape the summary', () => {
  const dir = freshRoot('state-switch')
  try {
    const state = nextState(emptyState({ now: NOW }), { disabled: true, autoApply: false, status: 'disabled', code: null, lastCheckAt: NOW.toISOString() }, { now: NOW })
    saveState(dir, state, { now: NOW })
    const loaded = loadState(dir).state
    assert.equal(loaded.disabled, true)
    assert.equal(loaded.autoApply, false)
    const summary = updateSummary(loaded, NOW.getTime() + OVERDUE_THRESHOLD_MS + 60_000)
    assert.equal(summary.status, 'disabled', 'a switched-off machine is reported as off, not as overdue')
    assert.equal(summary.overdue, false)
  } finally {
    removeDir(dir)
  }
})

test('the installer pointer: missing, unreadable, stale and live are four different answers', () => {
  const dir = freshRoot('state-pointer')
  try {
    const roots = writableRoots(dir)
    let pointer = readPointer(dir)
    assert.equal(pointer.ok, false)
    assert.equal(pointer.code, CODES.pointerMissing)
    assert.match(pointer.message, /run the GlassPane installer again/)

    fs.writeFileSync(roots.pointerFile, 'not json', { mode: 0o644 })
    assert.equal(readPointer(dir).code, CODES.pointerUnreadable)

    fs.writeFileSync(roots.pointerFile, JSON.stringify({ updaterCli: '/nowhere/updater/cli.js', installRoot: '/nowhere', agentLabel: 'com.glasspane.update', registeredAt: NOW.toISOString() }))
    const stale = readPointer(dir)
    assert.equal(stale.ok, false)
    assert.equal(stale.code, CODES.pointerStale)
    assert.match(stale.message, /is not on disk: reinstall GlassPane before updating/)

    const cli = path.join(dir, 'cli.js')
    fs.writeFileSync(cli, '#!/usr/bin/env node\n')
    const written = writePointer(dir, { updaterCli: cli, installRoot: dir, agentLabel: 'com.glasspane.update' }, { now: NOW })
    assert.equal(written.mode, 0o600)
    const live = readPointer(dir)
    assert.equal(live.ok, true)
    assert.equal(live.pointer.updaterCli, cli)
    assert.equal(live.pointer.agentLabel, 'com.glasspane.update')
    assert.ok(Date.parse(live.pointer.registeredAt) > 0, 'registeredAt is stamped when absent')
  } finally {
    removeDir(dir)
  }
})

test('pushHistory rejects an action the panel has no button for', () => {
  assert.throws(
    () => pushHistory(emptyState({ now: NOW }), { at: NOW.toISOString(), action: 'yolo', result: 'ok' }),
    (error) => error.code === CODES.stateWriteUnverified && /is not one of/.test(error.message),
  )
})

function capture(fn) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof UpdaterError, 'expected an UpdaterError, got ' + error)
    return error
  }
  throw new assert.AssertionError({ message: 'the call was expected to refuse, and it did not' })
}
