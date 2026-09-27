/**
 * §1's seven gates, end to end, in the order the spec puts them.
 *
 * This file exists because nothing else drove `lib/check.js`: every gate had a
 * unit test and the *sequence* — which is what §1 actually specifies — had none.
 * Deleting the CI gate, dropping the self-check call, or running the self-check
 * before the provenance gate all used to leave the suite green.
 *
 * What is real here: a `node:http` server on 127.0.0.1 serving a genuine
 * `.tar.gz` built by this package's own writer in the layout `release.yml`
 * produces (`git archive --prefix="GlassPane-<ver>/"`), the real fetchers, the
 * real digest measurement, the real unpack, and a real child process running the
 * tree's own `scripts/check-version.mjs`. That guard script appends to an
 * **execution marker** file, so "did staged content run?" is answered by the
 * filesystem rather than asserted by this file.
 *
 * REVERSE MUTATIONS reddened here, each named at the test that catches it:
 *   · delete the `verifyCiGreen` call in `lib/check.js` —
 *     `a release the CI gate refuses never has its staged code executed` goes red
 *     (the release stages, and the marker exists).
 *   · trust the declared length instead of measuring —
 *     `a tarball whose digest disagrees with SHA256SUMS …` goes red.
 *   · drop the self-check — `a staged tree whose own guard exits non-zero …`.
 *   · let a refusal leave the previous `staged` record standing
 *     (`staged: patch.staged ?? previous.staged`) —
 *     `a refused check clears a staged tree an earlier check left behind`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { runCheck } from '../lib/check.js'
import { CODES } from '../lib/codes.js'
import { makeBytesFetcher, makeFetcher } from '../lib/source.js'
import { stagedTreePresent } from '../lib/staging.js'
import { loadState } from '../lib/state.js'
import { localVersion } from '../lib/version.js'
import { packTarGz } from '../lib/tar.js'
import {
  PINNED_PATH,
  bytesResponse,
  defaultTreeFiles,
  jsonResponse,
  makeDaemonBinary,
  makeFakeApp,
  removeDir,
  startServer,
  tempDir,
  TMP_PREFIX,
  crypto,
} from './helpers.mjs'

const NOW = new Date('2026-09-27T12:00:00.000Z')
const SHA = 'f'.repeat(40)
const GREEN_RUNS = {
  workflow_runs: [{ id: 42, name: 'CI', conclusion: 'success', status: 'completed', html_url: 'https://github.com/o/r/actions/runs/42' }],
}

/** A machine with `currentVersion` installed, under a temp directory. */
function makeMachine(label, currentVersion = '1.4.0') {
  const dir = tempDir(`${TMP_PREFIX}check-${label}-`)
  const appsDir = path.join(dir, 'Applications')
  makeFakeApp(appsDir, 'GlassPane.app', currentVersion)
  makeFakeApp(appsDir, 'GlassPane Daemon.app', currentVersion)
  const daemonBin = makeDaemonBinary(appsDir, currentVersion)
  return {
    dir,
    appsDir,
    local: () => localVersion({
      appsDir,
      daemonExecutable: daemonBin,
      settingsAppName: 'GlassPane.app',
      daemonAppName: 'GlassPane Daemon.app',
    }),
    stagingOf: (version) => path.join(dir, 'update-staging', version),
    cleanup: () => removeDir(dir),
  }
}

/**
 * The 127.0.0.1 source for one release: the document, the two assets, and the
 * `actions/runs` answer. The release handler builds the asset URLs from the
 * request's own `Host`, so the payload points at the port the server really got
 * rather than at a number this file invented.
 */
async function startSource({
  version,
  treeFiles = null,
  tarball = null,
  sums = null,
  runs = GREEN_RUNS,
  runsStatus = null,
  commitId = null,
  targetCommitish = SHA,
  dropSumsAsset = false,
  assetOrigin = null,
}) {
  const files = treeFiles ?? defaultTreeFiles(version)
  const archive = tarball ?? packTarGz(files)
  const digest = crypto.createHash('sha256').update(archive).digest('hex')
  const tarballName = `GlassPane-${version}.tar.gz`
  const sumsName = `SHA256SUMS-${version}.txt`
  const sumsText = sums ?? `${digest}  ${tarballName}\n`
  const routes = {
    [PINNED_PATH + '/releases/latest']: (req, res) => {
      const origin = assetOrigin ?? `http://${req.headers.host}`
      const assets = [{ name: tarballName, browser_download_url: `${origin}/${tarballName}` }]
      if (!dropSumsAsset) assets.push({ name: sumsName, browser_download_url: `${origin}/${sumsName}` })
      const body = { tag_name: `v${version}`, target_commitish: targetCommitish, assets }
      if (commitId) body.commit_id = commitId
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    },
    [`/${tarballName}`]: bytesResponse(archive),
    [`/${sumsName}`]: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(sumsText)
    },
  }
  if (runs !== null) {
    routes[PINNED_PATH + '/actions/runs'] = runsStatus === null
      ? jsonResponse(runs)
      : jsonResponse(runs, runsStatus)
  }
  const server = await startServer(routes)
  return { server, digest, tarballName, sumsName, files }
}

/**
 * One real reading of "what this machine runs", shared by the tests that are not
 * *about* that reading. `localVersion` spawns the daemon binary, and every other
 * gate this file exercises is independent of it; `a half-installed machine …`
 * below keeps its own real reading so the end-to-end path stays pinned where it
 * matters.
 */
const REFERENCE = makeMachine('reference')
const LOCAL = REFERENCE.local()
assert.equal(LOCAL.ok, true, 'the fixture machine must be internally consistent for the other tests to mean anything')

/** One `runCheck` with the real transports against one of those servers. */
function check({ machine, server, consents = [], env = {}, trigger = 'auto', local = LOCAL }) {
  return runCheck({
    stateRoot: machine.dir,
    env: { GLASSPANE_UPDATE_BASE: server.origin, ...env },
    now: NOW,
    local,
    consents,
    trigger,
    fetchJson: makeFetcher(),
    fetchBytes: makeBytesFetcher(),
    log: () => {},
  })
}

const paths = (server) => server.requests.map((r) => r.pathname)

test('all seven gates pass: the release is staged and the state records the digest', async () => {
  const machine = makeMachine('pass')
  const src = await startSource({ version: '1.4.1' })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.status, 'staged', result.message)
    assert.equal(result.code, null)
    assert.equal(result.ok, true)
    assert.equal(result.staged.digest, src.digest, '§1.5: the digest measured off the downloaded file is the one recorded')
    const state = loadState(machine.dir).state
    assert.equal(state.status, 'staged')
    assert.equal(state.current, '1.4.0')
    assert.equal(state.latest, '1.4.1')
    assert.equal(state.staged.version, '1.4.1')
    assert.equal(state.staged.digest, src.digest)
    assert.equal(state.lastError, null)
    assert.equal(state.history.at(-1).result, 'staged')
    assert.equal(state.history.at(-1).digest, src.digest.slice(0, 12), 'history keeps the leading 12 characters (spec §3.5)')
    // The tree lands one wrapper folder deep, which is the layout `git archive
    // --prefix` produces: `apply` has to build from *that* root.
    const present = stagedTreePresent({ stateRoot: machine.dir, staged: state.staged })
    assert.equal(present.ok, true, present.reason)
    assert.equal(path.basename(present.rootPath), 'GlassPane-1.4.1')
    assert.ok(fs.existsSync(path.join(present.rootPath, 'engine', 'Sources')), 'the release root is where §3.2 expects engine/')
    assert.deepEqual(paths(src.server), [
      PINNED_PATH + '/releases/latest',
      `/${src.sumsName}`,
      `/${src.tarballName}`,
      PINNED_PATH + '/actions/runs',
    ], 'the release document, the two assets, then the CI query')
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('a release whose CI query says nothing succeeded is refused, and nothing is staged', async () => {
  const machine = makeMachine('ci-empty')
  const src = await startSource({ version: '1.4.1', runs: { workflow_runs: [] } })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'check-failed')
    assert.equal(result.code, CODES.ciUnverified, 'no run at all is "unverified", which is not the same claim as "not green"')
    assert.equal(loadState(machine.dir).state.staged, null)
    assert.equal(fs.existsSync(machine.stagingOf('1.4.1')), false, 'the staging directory went with the refusal')
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('a CI query that cannot be read at all is unverified, not skipped', async () => {
  const machine = makeMachine('ci-500')
  const src = await startSource({ version: '1.4.1', runs: { message: 'boom' }, runsStatus: 500 })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.code, CODES.ciUnverified)
    assert.equal(loadState(machine.dir).state.staged, null)
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('CI runs that exist but are not green refuse with ci-not-green, and name the runs', async () => {
  const machine = makeMachine('ci-red')
  const src = await startSource({
    version: '1.4.1',
    runs: { workflow_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'failure' }] },
  })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.code, CODES.ciNotGreen)
    assert.match(result.state.lastError.message, /CI=completed\/failure/)
    assert.equal(loadState(machine.dir).state.staged, null)
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

// REVERSE MUTATION: delete the `verifyCiGreen(...)` call from lib/check.js, or
// move it back below `selfCheckStagedTree` (the order this file shipped with).
// Then this release stages anyway, and the marker — written by the archive's own
// script — exists, which is the sentence §1.7 refuses to accept.
test('a release the CI gate refuses never has its staged code executed', async () => {
  const machine = makeMachine('order-refuse')
  const marker = path.join(machine.dir, 'guard-ran')
  const src = await startSource({
    version: '1.4.1',
    treeFiles: defaultTreeFiles('1.4.1', { guardMarker: marker }),
    runs: { workflow_runs: [] },
  })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.code, CODES.ciUnverified)
    assert.equal(fs.existsSync(marker), false, 'the tree’s own guard RAN on a release the provenance gate refuses')
    assert.equal(paths(src.server).at(-1), PINNED_PATH + '/actions/runs', 'the last thing asked was the CI query: no gate ran after the tree was unpacked')
    assert.equal(fs.existsSync(machine.stagingOf('1.4.1')), false)
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('execution of staged content is the last gate: the guard runs once, after every request', async () => {
  const machine = makeMachine('order-pass')
  const marker = path.join(machine.dir, 'guard-ran')
  const src = await startSource({
    version: '1.4.1',
    treeFiles: defaultTreeFiles('1.4.1', { guardMarker: marker }),
  })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.status, 'staged', result.message)
    assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), ['guard ran'], 'exactly one execution of the tree’s own script')
    assert.deepEqual(paths(src.server), [
      PINNED_PATH + '/releases/latest',
      `/${src.sumsName}`,
      `/${src.tarballName}`,
      PINNED_PATH + '/actions/runs',
    ], 'every network-verifiable gate finished before the tree ran')
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('a tarball whose digest disagrees with SHA256SUMS is refused and its staging deleted', async () => {
  const machine = makeMachine('digest')
  const marker = path.join(machine.dir, 'guard-ran')
  const files = defaultTreeFiles('1.4.1', { guardMarker: marker })
  const archive = packTarGz(files)
  // One byte flipped at the same length: the case a Content-Length or a
  // "the download finished" check passes and §1.5 must not.
  const tampered = Buffer.from(archive)
  tampered[Math.floor(tampered.length / 2)] ^= 0x20
  assert.equal(tampered.length, archive.length)
  const src = await startSource({
    version: '1.4.1',
    treeFiles: files,
    tarball: tampered,
    sums: `${crypto.createHash('sha256').update(archive).digest('hex')}  GlassPane-1.4.1.tar.gz\n`,
  })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.ok, false)
    assert.equal(result.code, CODES.digestMismatch)
    assert.equal(loadState(machine.dir).state.staged, null, 'nothing is staged')
    assert.equal(fs.existsSync(marker), false, 'a tree whose archive did not verify was never run')
    assert.equal(fs.existsSync(machine.stagingOf('1.4.1')), false, '§1.5: the staging directory is deleted with its contents')
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('a staged tree whose own guard exits non-zero is refused as version-line-broken', async () => {
  const machine = makeMachine('guard')
  const marker = path.join(machine.dir, 'guard-ran')
  const src = await startSource({
    version: '1.4.1',
    treeFiles: defaultTreeFiles('1.4.1', { guardExit: 1, guardMarker: marker }),
  })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.code, CODES.versionLineBroken)
    assert.match(result.state.lastError.message, /exit 1/)
    assert.equal(fs.existsSync(marker), true, 'the guard really ran: that is how this gate is decided')
    assert.equal(loadState(machine.dir).state.staged, null)
    assert.equal(fs.existsSync(machine.stagingOf('1.4.1')), false, 'the failing tree is thrown away')
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('a version constant out of step with the tag refuses before the guard is paid for', async () => {
  const machine = makeMachine('drift')
  const marker = path.join(machine.dir, 'guard-ran')
  const files = defaultTreeFiles('1.4.1', { guardMarker: marker }).map((entry) => (
    entry.name.endsWith('mcp-shell/package.json')
      ? { ...entry, content: JSON.stringify({ name: 'glasspane-mcp', version: '1.3.9' }) }
      : entry
  ))
  const src = await startSource({ version: '1.4.1', treeFiles: files })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.code, CODES.versionLineBroken)
    assert.match(result.state.lastError.message, /mcp-shell-package=1\.3\.9/)
    assert.equal(fs.existsSync(marker), false, "§1.6's first half refuses without executing anything")
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('an archive whose wrapper folder is not this release is refused rather than guessed at', async () => {
  const machine = makeMachine('wrapper')
  const files = defaultTreeFiles('1.4.1').map((entry) => ({ ...entry, name: entry.name.replace('GlassPane-1.4.1/', 'GlasPane-1.4.1/') }))
  const archive = packTarGz(files)
  const src = await startSource({
    version: '1.4.1',
    tarball: archive,
    sums: `${crypto.createHash('sha256').update(archive).digest('hex')}  GlassPane-1.4.1.tar.gz\n`,
  })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.code, CODES.versionLineBroken)
    assert.match(result.state.lastError.message, /not shaped like a GlassPane release/)
    assert.match(result.state.lastError.message, /GlasPane-1\.4\.1/, 'the refusal names the folder it found')
    assert.equal(loadState(machine.dir).state.staged, null)
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('a release without its checksum asset refuses before a byte of archive is fetched', async () => {
  const machine = makeMachine('assets')
  const src = await startSource({ version: '1.4.1', dropSumsAsset: true })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.code, CODES.assetsMissing)
    assert.deepEqual(paths(src.server), [PINNED_PATH + '/releases/latest'], 'the release document was the only thing fetched')
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('an asset pointing off the loopback test origin is refused: §1.6 does not run', async () => {
  const machine = makeMachine('asset-host')
  const marker = path.join(machine.dir, 'guard-ran')
  // `resolveBase` pins the base to this 127.0.0.1 port; the payload naming a
  // *different* loopback port is a different listener, and §1's host pinning is
  // about where the bytes come from.
  const src = await startSource({
    version: '1.4.1',
    treeFiles: defaultTreeFiles('1.4.1', { guardMarker: marker }),
    assetOrigin: 'http://127.0.0.1:65001',
  })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.code, CODES.assetHostUnpinned)
    assert.equal(fs.existsSync(marker), false)
    assert.deepEqual(paths(src.server), [PINNED_PATH + '/releases/latest'])
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('a refused check clears a staged tree an earlier check left behind', async () => {
  const machine = makeMachine('clears')
  const first = await startSource({ version: '1.4.1' })
  try {
    const staged = await check({ machine, server: first.server })
    assert.equal(staged.status, 'staged', staged.message)
    assert.equal(stagedTreePresent({ stateRoot: machine.dir, staged: loadState(machine.dir).state.staged }).ok, true, 'the tree is on disk before the second check')
  } finally {
    await first.server.close()
  }
  // The refusal comes from gate 3 — before any staging exists for this run — so
  // it is the path that used to answer "assets-missing" while leaving the OLD
  // staged tree in the record for `apply` to trust.
  const second = await startSource({ version: '1.4.2', dropSumsAsset: true })
  try {
    const result = await check({ machine, server: second.server })
    assert.equal(result.code, CODES.assetsMissing)
    assert.equal(loadState(machine.dir).state.staged, null, 'a refusing check does not leave the old offer standing for apply to trust')
  } finally {
    await second.server.close()
    machine.cleanup()
  }
})

test('a major still stages, but as needs-consent', async () => {
  const machine = makeMachine('major', '1.4.1')
  const src = await startSource({ version: '2.0.0' })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.status, 'needs-consent')
    assert.equal(result.code, CODES.consentRequired)
    const state = loadState(machine.dir).state
    assert.equal(state.status, 'needs-consent')
    assert.equal(state.staged.version, '2.0.0', "the offer is staged so the panel's button has something to install, but apply needs the consent flag")
    assert.equal(paths(src.server).at(-1), PINNED_PATH + '/actions/runs')
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('an equal published release is up-to-date and the archive is never downloaded', async () => {
  const machine = makeMachine('upto', '1.4.1')
  const src = await startSource({ version: '1.4.1' })
  try {
    const result = await check({ machine, server: src.server, local: machine.local() })
    assert.equal(result.status, 'up-to-date')
    assert.deepEqual(paths(src.server), [PINNED_PATH + '/releases/latest'], 'a version nobody would install is not worth four requests')
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('a half-installed machine refuses the check before the source is contacted', async () => {
  const machine = makeMachine('local', '1.4.1')
  const plist = path.join(machine.appsDir, 'GlassPane.app', 'Contents', 'Info.plist')
  fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace('<string>1.4.1</string>', '<string>1.4.0</string>'))
  const src = await startSource({ version: '1.4.2' })
  try {
    const result = await check({ machine, server: src.server, local: machine.local() })
    assert.equal(result.code, CODES.versionMismatchLocal)
    assert.match(result.state.lastError.message, /re-run the GlassPane installer/i)
    assert.deepEqual(paths(src.server), [], 'nothing was fetched about a machine that cannot say what it runs')
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})

test('the CI gate follows commit_id when the release carries one, and says which it used', async () => {
  const machine = makeMachine('commit-id')
  const commitId = 'a'.repeat(40)
  // `target_commitish` is the mutable field (`main`, or a sha somebody moved);
  // `commit_id` is what the tag points at. The gate has to ask about the latter
  // and record that it did.
  const src = await startSource({ version: '1.4.1', commitId, targetCommitish: 'main' })
  try {
    const result = await check({ machine, server: src.server })
    assert.equal(result.status, 'staged', result.message)
    const asked = src.server.requests.find((r) => r.pathname === PINNED_PATH + '/actions/runs')
    assert.equal(asked.query.head_sha, commitId, 'the CI query was made against commit_id, not the branch name in target_commitish')
    assert.equal(asked.query.branch, 'main')
  } finally {
    await src.server.close()
    machine.cleanup()
  }
})
