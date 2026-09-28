/**
 * The CLI as a *process* — exit codes and the one-line JSON contract (spec §7).
 *
 * Importing `cli.js` cannot prove any of this: the module is also a library the
 * tests use, and the executable guard at its bottom used to throw at import time
 * for every real invocation. These tests spawn `node cli.js …`, so they exercise
 * exactly what the launchd agent and the settings panel will run.
 *
 * Reverse mutations that redden here: break the import guard (every test here
 * fails with a nonzero status before any subcommand runs); return the wrong exit
 * code for a refusal; print the JSON line to stderr instead of stdout; print two
 * lines.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { STATUSES } from '../lib/codes.js'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js')

function runCli(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('node cli.js runs at all: status answers with one JSON line and exit 0', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cli-'))
  try {
    const result = await runCli(['status', '--json', '--state-dir', stateRoot])
    assert.equal(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`)
    assert.equal(result.stdout.trim().split('\n').length, 1, 'the contract is exactly one line on stdout')
    const parsed = JSON.parse(result.stdout)
    // Measured against the closed enum the contract publishes, not a hand-typed
    // subset: a fresh directory with no installer pointer legitimately answers
    // `installer-pointer-stale`, and an ad-hoc list of "expected" statuses would
    // have reddened the honest answer while passing a wrong one.
    assert.ok(STATUSES.includes(parsed.status), `status outside the documented enum: ${parsed.status}`)
    assert.equal(typeof parsed.exitCode, 'number')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('an unknown subcommand is a usage error (exit 2), not a crash', async () => {
  const result = await runCli(['frobnicate'])
  assert.equal(result.code, 2, result.stderr)
  assert.match(result.stderr, /frobnicate|usage/i, 'the operator has to be told what they typed')
})

test('GLASSPANE_UPDATE_DISABLE=1 makes an automatic apply refuse with exit 3', async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cli-'))
  try {
    const result = await runCli(['apply', '--json', '--state-dir', stateRoot, '--auto'], {
      env: { GLASSPANE_UPDATE_DISABLE: '1' },
    })
    assert.equal(result.code, 3, `refusal must be exit 3: ${result.stderr}`)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.ok, false)
    assert.ok(parsed.code, 'a refusal without a code gives the panel nothing to show')
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true })
  }
})
