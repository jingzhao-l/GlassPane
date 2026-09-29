/**
 * §9: the root bundle node is handed on a machine whose TLS is intercepted.
 *
 * Why a whole file for a `security` invocation: the failure this exists for was
 * found by *running* `check` on a real machine, and every test in this suite up to
 * then drove a fake HTTP layer — so a job that could never reach GitHub while the
 * panel cheerfully reported "automatic update is on" passed 198 tests. The shapes
 * below are the ones that make that state impossible to reach: statuses that cannot
 * collapse into each other, a probe that must run in a **child** process (node reads
 * `NODE_EXTRA_CA_CERTS` at start, so setting it in-process proves nothing), and a
 * bundle that is only believed after it is read back.
 *
 * REVERSE MUTATION, one per row, each verified to redden the named test:
 *   · fold `probe-failed` into `ok`            → closed-vocabulary + probe tests
 *   · believe the export on `security`'s exit  → empty-bundle test
 *   · skip the read-back compare              → write-unverified test
 *   · delete the previous file when empty      → "keeps the previous bundle" test
 *   · probe in this process instead of a child → "child, not this process" test
 *   · put the URL inside the `-e` script       → "url rides argv" test
 * `run` is always injected: nothing here touches a developer's keychain or network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  CA_BUNDLE_NAME,
  CA_ENV_VAR,
  CA_STATUSES,
  KEYCHAIN_SOURCES,
  caBundlePath,
  countCertificates,
  describeCa,
  exportCaBundle,
  usableBundle,
} from '../lib/ca-bundle.js'
import { CODES } from '../lib/codes.js'
import { modeOf } from '../lib/fsutil.js'
import { TMP_PREFIX, removeDir, tempDir } from './helpers.mjs'

/**
 * `caBundlePath` refuses a relative state root (a relative NODE_EXTRA_CA_CERTS in
 * a launchd job resolves against whatever directory the job starts in), so the
 * scratch directories here are made absolute the same way a caller would.
 */
function scratch(prefix) {
  // `${TMP_PREFIX}…` is not decoration: removeDir() refuses anything outside it, so
  // a bare prefix here would leave a scratch directory in the repository after every
  // run — which is exactly how a test suite quietly turns into uncommitted files.
  return path.resolve(tempDir(`${TMP_PREFIX}ca-${prefix}-`))
}

const PEM = (n) => Array.from({ length: n }, (_, i) => `-----BEGIN CERTIFICATE-----\nMIIB${i}FAKE\n-----END CERTIFICATE-----\n`).join('')
const URL = 'https://api.github.com/repos/jingzhao-l/GlassPane/releases/latest'

/** Records every command asked of it and answers by command name. */
function fakeRun({ keychains = {}, nodeExit = 0, nodeStderr = '', nodeError = null, securityError = null } = {}) {
  const calls = []
  return {
    calls,
    run(command, args, options = {}) {
      calls.push({ command, args, options })
      if (command === 'security') {
        if (securityError) return { status: null, stdout: '', stderr: '', error: securityError }
        const out = keychains[command === 'security' ? args[args.length - 1] : command]
        if (out === undefined) return { status: 1, stdout: '', stderr: 'unable to open keychain' }
        return { status: 0, stdout: out, stderr: '' }
      }
      if (nodeError) return { status: null, stdout: '', stderr: '', error: nodeError }
      return { status: nodeExit, stdout: '', stderr: nodeStderr }
    },
  }
}

test('the bundle is exported from both keychains, written private, and believed only after it is read back', () => {
  const stateRoot = scratch('ca-ok-')
  try {
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(3), [KEYCHAIN_SOURCES[1]]: PEM(2) } })
    const record = exportCaBundle({ stateRoot, probeUrl: URL, run: f.run })
    assert.equal(record.status, 'ok', JSON.stringify(record))
    assert.equal(record.certs, 5, 'both keychains contribute: the system roots and the administrator-installed one')
    assert.equal(record.path, caBundlePath(stateRoot))
    const written = fs.readFileSync(caBundlePath(stateRoot), 'utf8')
    assert.equal(countCertificates(written), 5)
    assert.equal(modeOf(caBundlePath(stateRoot)), 0o600, 'a root bundle is not secret, but this file is written by the same rule as every other state file')
  } finally {
    removeDir(stateRoot)
  }
})

test('a bundle that does not read back the same is write-unverified, not ok', () => {
  const stateRoot = scratch('ca-rb-')
  try {
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(4), [KEYCHAIN_SOURCES[1]]: '' } })
    const record = exportCaBundle({
      stateRoot,
      run: f.run,
      readFile: () => PEM(1), // the disk answers with something else than what was written
    })
    assert.equal(record.status, 'write-unverified')
    assert.match(record.detail, /read back 1 certificate\(s\) of the 4 written/)
    assert.ok(describeCa(record).remedy, 'a bundle nobody can read back must come with a next step, not just a shrug')
  } finally {
    removeDir(stateRoot)
  }
})

test('a failing write is a status, not a thrown error: an export is never a reason to refuse an update', () => {
  const stateRoot = scratch('ca-throw-')
  try {
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(1), [KEYCHAIN_SOURCES[1]]: '' } })
    const record = exportCaBundle({
      stateRoot,
      run: f.run,
      writeFile: () => {
        throw new Error('EACCES: permission denied')
      },
    })
    assert.equal(record.status, 'write-unverified')
    assert.match(record.detail, /EACCES/)
  } finally {
    removeDir(stateRoot)
  }
})

test('zero certificates exported keeps the bundle that already worked and says it produced nothing', () => {
  const stateRoot = scratch('ca-empty-')
  try {
    const previous = PEM(7)
    fs.writeFileSync(caBundlePath(stateRoot), previous, 'utf8')
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: '', [KEYCHAIN_SOURCES[1]]: '' } })
    const record = exportCaBundle({ stateRoot, run: f.run })
    assert.equal(record.status, 'empty', '"security ran" is not evidence any certificate came out of it')
    assert.equal(fs.readFileSync(caBundlePath(stateRoot), 'utf8'), previous, 'a bad export must not take away the bundle the agent is already using')
    assert.match(describeCa(record).summary, /is kept and still handed to the agent/)
  } finally {
    removeDir(stateRoot)
  }
})

test('a machine without the security tool is unavailable and gets a remedy it can actually run', () => {
  const stateRoot = scratch('ca-nowin-')
  try {
    const f = fakeRun({ securityError: Object.assign(new Error('spawn security ENOENT'), { code: 'ENOENT' }) })
    const record = exportCaBundle({ stateRoot, run: f.run })
    assert.equal(record.status, 'unavailable')
    assert.ok(!fs.existsSync(caBundlePath(stateRoot)))
    assert.match(describeCa(record).remedy, new RegExp(CA_ENV_VAR), 'the only fix left is pointing node at a bundle the operator trusts')
  } finally {
    removeDir(stateRoot)
  }
})

test('the probe runs a child node with the bundle in its environment, not this process with it set later', () => {
  const stateRoot = scratch('ca-probe-')
  try {
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(2), [KEYCHAIN_SOURCES[1]]: '' } })
    const record = exportCaBundle({ stateRoot, probeUrl: URL, run: f.run, nodePath: '/usr/local/bin/node' })
    assert.equal(record.status, 'ok')
    const probe = f.calls.at(-1)
    assert.equal(probe.command, '/usr/local/bin/node', 'the probe is a node start-up, because that is the only moment node reads the variable')
    assert.equal(probe.options.env[CA_ENV_VAR], caBundlePath(stateRoot), 'the child gets the bundle the agent will get; setting it in this process would prove nothing')
    assert.ok(!('NODE_EXTRA_CA_CERTS' in process.env) || process.env.NODE_EXTRA_CA_CERTS !== caBundlePath(stateRoot))
  } finally {
    removeDir(stateRoot)
  }
})

test('the URL rides on argv, never inside the script the child evaluates', () => {
  const stateRoot = scratch('ca-argv-')
  try {
    const hostile = 'https://example.test/$(touch /tmp/pwned)"; rm -rf /'
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(1), [KEYCHAIN_SOURCES[1]]: '' } })
    exportCaBundle({ stateRoot, probeUrl: hostile, run: f.run })
    const probe = f.calls.at(-1)
    assert.equal(probe.args[probe.args.length - 1], hostile, 'the URL is an argv slot the child reads with process.argv[1]')
    assert.ok(!probe.args[1].includes(hostile), 'a base URL that carried a quote must not become code in the -e script')
  } finally {
    removeDir(stateRoot)
  }
})

test('a bundle that still cannot reach the endpoint is probe-failed, which is not the same sentence as ok', () => {
  const stateRoot = scratch('ca-dead-')
  try {
    const f = fakeRun({
      keychains: { [KEYCHAIN_SOURCES[0]]: PEM(9), [KEYCHAIN_SOURCES[1]]: PEM(1) },
      nodeExit: 21,
      nodeStderr: 'Error: unable to verify the first certificate\n',
    })
    const record = exportCaBundle({ stateRoot, probeUrl: URL, run: f.run })
    assert.equal(record.status, 'probe-failed', 'certs on disk is not "the network path works"; this is the case where the exported bundle did not contain the intercepting root')
    assert.match(record.detail, /unable to verify the first certificate/)
    assert.match(describeCa(record).remedy, /add-trusted-cert/, 'the named fix is: that root is not in the two keychains this exports')
  } finally {
    removeDir(stateRoot)
  }
})

test('a probe that could not start is a failed probe, not a passed one', () => {
  const stateRoot = scratch('ca-nospan-')
  try {
    const f = fakeRun({ keychains: { [KEYCHAIN_SOURCES[0]]: PEM(1), [KEYCHAIN_SOURCES[1]]: '' }, nodeError: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) })
    const record = exportCaBundle({ stateRoot, probeUrl: URL, run: f.run })
    assert.equal(record.status, 'probe-failed')
    assert.match(record.detail, /node could not be started/)
  } finally {
    removeDir(stateRoot)
  }
})

test('the five statuses are the schema enum, and each one says something different', () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'schema', 'update-state.schema.json'), 'utf8'))
  const inSchema = schema.properties.caRoots.properties.status.enum
  assert.deepEqual([...CA_STATUSES].sort(), [...inSchema].sort(), 'ca-bundle.js and the state schema must not carry two lists of the same vocabulary')

  const seen = new Map()
  for (const status of CA_STATUSES) {
    const described = describeCa({ status, certs: 3, path: '/tmp/x/ca-roots.pem', exportedAt: 'now', detail: 'd' })
    assert.ok(described.summary && described.summary !== '', `${status} has to be sayable`)
    if (status !== 'ok') {
      assert.ok(described.remedy, `${status} must come with a next step; a refusal that names no action is not a remedy`)
    }
    assert.ok(!seen.has(described.summary), `${status}'s summary collides with ${seen.get(described.summary)}: two different failures told in the same words`)
    seen.set(described.summary, status)
  }
  assert.equal(CA_STATUSES.length, 5)
})

test('absent, empty and "not one this program knows" are three different sentences', () => {
  assert.match(describeCa(null).summary, /never exported/, 'a state file from before this existed reads as "not recorded", never as "fine"')
  assert.ok(describeCa(null).remedy)
  assert.match(describeCa({ status: 'fine', certs: 99, path: '/x', exportedAt: 'now' }).summary, /not one this program knows/)
  assert.equal(describeCa({ status: 'ok', certs: 163, path: '/x', exportedAt: 'now' }).remedy, null, 'the good state invents no advice')
})

test('usableBundle: a file exists, is empty, or is there — only the last one is handed to launchd', () => {
  const stateRoot = scratch('ca-use-')
  try {
    const target = caBundlePath(stateRoot)
    assert.deepEqual(usableBundle(target), { usable: false, certs: 0, reason: 'absent' })
    fs.writeFileSync(target, '', 'utf8')
    assert.equal(usableBundle(target).usable, false, 'a 0-byte NODE_EXTRA_CA_CERTS makes node fail at start-up: worse than no bundle')
    assert.equal(usableBundle(target).reason, 'empty')
    fs.writeFileSync(target, PEM(2), 'utf8')
    assert.deepEqual(usableBundle(target), { usable: true, certs: 2, reason: null })
  } finally {
    removeDir(stateRoot)
  }
})

test('a bundle is only ever written inside the state root it was given', () => {
  const stateRoot = scratch('ca-root-')
  try {
    assert.equal(caBundlePath(stateRoot), path.join(stateRoot, CA_BUNDLE_NAME))
    assert.throws(() => caBundlePath(''), (error) => error.code === CODES.homeRecordUnavailable, 'an unnamed state root must not become a bundle in the cwd')
    assert.throws(() => caBundlePath(null), (error) => error.code === CODES.homeRecordUnavailable)
    assert.throws(() => caBundlePath('.glasspane'), (error) => error.code === CODES.homeRecordUnavailable, 'a relative root becomes a different file depending on the directory launchd starts the job in')
  } finally {
    removeDir(stateRoot)
  }
})
