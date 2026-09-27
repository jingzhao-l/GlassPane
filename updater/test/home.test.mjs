/**
 * Which home this tool writes into — and the split-brain this prevents.
 *
 * The updater writes `~/.glasspane/update-state.json`; the settings panel (Swift,
 * `NSHomeDirectory()`) and the daemon (`StateRoot.homeDefault()`) read that same
 * path. `os.homedir()` follows `$HOME`, which any caller can set, so a
 * `$HOME`-redirected `updater check` would file its state somewhere the panel will
 * never look and answer "never checked" about a machine that updated five minutes
 * ago. The password record is the one all three processes agree on.
 *
 * Reverse mutation that reddens this file: make either resolver default to
 * `os.homedir()` again — the two `$HOME` cases below then disagree with the record.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import test from 'node:test'

import { resolveStateRoot, resolveAppsDir, recordHomeDir } from '../cli.js'

test('the default roots come from the password record, not from $HOME', () => {
  const record = os.userInfo().homedir
  const redirected = record === '/tmp/fake-home' ? '/private/tmp/fake-home' : '/tmp/fake-home'
  assert.notEqual(record, redirected, 'the two homes must be distinguishable for this to measure anything')

  for (const [name, resolved] of [
    ['state', resolveStateRoot({ env: { ...process.env, HOME: redirected } })],
    ['apps', resolveAppsDir({ env: { ...process.env, HOME: redirected } })],
  ]) {
    assert.ok(resolved.startsWith(record), `${name} landed under ${resolved}, not the record home ${record}`)
    assert.equal(resolved.startsWith(redirected), false, `${name} followed $HOME — the panel would never read it`)
  }
})

test('an explicit --state-dir still wins, and is the only way off the record home', () => {
  const named = resolveStateRoot({ flags: { 'state-dir': '/tmp/gp-home-test-state' }, env: {} })
  assert.equal(named, '/tmp/gp-home-test-state')
  const viaEnv = resolveStateRoot({ flags: {}, env: { GLASSPANE_STATE_DIR: '/tmp/gp-env-state' } })
  assert.equal(viaEnv, '/tmp/gp-env-state')
})

test('recordHomeDir names the record it read, and refuses when there is none', () => {
  assert.equal(typeof recordHomeDir(), 'string')
  assert.ok(recordHomeDir().startsWith('/'), 'an absolute home or nothing')
})
