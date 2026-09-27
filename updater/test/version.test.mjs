/**
 * §6 row "tag 解析与 semver 严格大于".
 *
 * REVERSE MUTATION: allow an equal version to count as an update
 * (`compareVersions(...) >= 0`) — `a release equal to what is installed is not
 * an update` goes red, and so does the policy row that leans on it.
 * Second mutation: drop the local two-reading comparison (trust the bundle
 * alone) — `bundle and binary disagreeing refuses` goes red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  bumpKind,
  compareVersions,
  isStrictlyNewer,
  localVersion,
  parsePlainVersion,
  parseTag,
  readBundleVersion,
  readDaemonVersion,
} from '../lib/version.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError } from '../lib/fsutil.js'
import { makeDaemonBinary, makeFakeApp, removeDir, tempDir, TMP_PREFIX } from './helpers.mjs'

test('the tag grammar is exact', () => {
  assert.deepEqual(parseTag('v1.4.0'), { version: '1.4.0', major: 1, minor: 4, patch: 0 })
  assert.deepEqual(parseTag('v0.0.0'), { version: '0.0.0', major: 0, minor: 0, patch: 0 })
  for (const bad of ['1.4.0', 'v1.4', 'v1.4.0-beta.1', 'v01.4.0', 'vv1.4.0', 'V1.4.0', 'v1.4.0.1', '', null, 'latest']) {
    const error = capture(() => parseTag(bad))
    assert.equal(error.code, CODES.tagUnparseable, `tag ${JSON.stringify(bad)} must refuse as unparseable`)
  }
})

test('comparison is strictly greater, so equal and older are not updates', () => {
  const current = parsePlainVersion('1.3.1')
  assert.equal(compareVersions(parsePlainVersion('1.4.0'), current), 1)
  assert.equal(compareVersions(parsePlainVersion('1.3.1'), current), 0)
  assert.equal(compareVersions(parsePlainVersion('1.3.0'), current), -1)
  assert.equal(compareVersions(parsePlainVersion('2.0.0'), current), 1)
  // The mutation this row names: `>= 0` instead of `> 0`.
  assert.equal(isStrictlyNewer(parsePlainVersion('1.3.1'), '1.3.1'), false)
  assert.equal(isStrictlyNewer(parsePlainVersion('1.3.0'), '1.3.1'), false)
  assert.equal(isStrictlyNewer(parsePlainVersion('1.3.2'), '1.3.1'), true)
  assert.equal(bumpKind(parsePlainVersion('1.3.2'), current), 'patch')
  assert.equal(bumpKind(parsePlainVersion('1.4.0'), current), 'minor')
  assert.equal(bumpKind(parsePlainVersion('2.0.0'), current), 'major')
  assert.equal(bumpKind(parsePlainVersion('1.3.1'), current), 'none')
  assert.equal(bumpKind(parsePlainVersion('1.2.9'), current), 'downgrade')
})

test('numeric comparison does not go lexical', () => {
  assert.equal(isStrictlyNewer(parsePlainVersion('1.10.0'), '1.9.3'), true)
  assert.equal(isStrictlyNewer(parsePlainVersion('10.0.0'), '9.9.9'), true)
})

test('the two readings of "current" come off this machine: Info.plist and glasspaned --version', () => {
  const dir = tempDir(`${TMP_PREFIX}ver-`)
  try {
    const appsDir = path.join(dir, 'Applications')
    makeFakeApp(appsDir, 'GlassPane.app', '1.4.0')
    makeFakeApp(appsDir, 'GlassPane Daemon.app', '1.4.0')
    const exe = makeDaemonBinary(appsDir, '1.4.0')
    assert.equal(readBundleVersion(path.join(appsDir, 'GlassPane.app')), '1.4.0')
    // Real spawn of a real script: no stub stands in for the version read-back.
    assert.equal(readDaemonVersion(exe), '1.4.0')
    const verdict = localVersion({
      appsDir,
      daemonExecutable: exe,
      settingsAppName: 'GlassPane.app',
      daemonAppName: 'GlassPane Daemon.app',
    })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.version, '1.4.0')
  } finally {
    removeDir(dir)
  }
})

test('bundle and binary disagreeing refuses the whole update, and says reinstall', () => {
  const dir = tempDir(`${TMP_PREFIX}ver-mismatch-`)
  try {
    const appsDir = path.join(dir, 'Applications')
    makeFakeApp(appsDir, 'GlassPane.app', '1.4.0')
    makeFakeApp(appsDir, 'GlassPane Daemon.app', '1.4.0')
    const exe = makeDaemonBinary(appsDir, '1.3.1')
    const verdict = localVersion({
      appsDir,
      daemonExecutable: exe,
      settingsAppName: 'GlassPane.app',
      daemonAppName: 'GlassPane Daemon.app',
    })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, CODES.versionMismatchLocal)
    assert.equal(verdict.version, null)
    assert.match(verdict.message, /installer|reinstall/i)
    assert.deepEqual(verdict.seen, { daemonApp: '1.4.0', settingsApp: '1.4.0', daemonBinary: '1.3.1' })
  } finally {
    removeDir(dir)
  }
})

test('a bundle with no readable version, and a binary that prints nothing, both refuse rather than guessing', () => {
  const dir = tempDir(`${TMP_PREFIX}ver-broken-`)
  try {
    const appsDir = path.join(dir, 'Applications')
    fs.mkdirSync(path.join(appsDir, 'GlassPane.app', 'Contents'), { recursive: true })
    fs.writeFileSync(path.join(appsDir, 'GlassPane.app', 'Contents', 'Info.plist'), '<plist><dict></dict></plist>')
    assert.equal(capture(() => readBundleVersion(path.join(appsDir, 'GlassPane.app'))).code, CODES.versionMismatchLocal)

    const silent = path.join(dir, 'glasspaned')
    fs.writeFileSync(silent, '#!/bin/sh\necho "no version here"\n')
    fs.chmodSync(silent, 0o755)
    assert.equal(capture(() => readDaemonVersion(silent)).code, CODES.versionMismatchLocal)
  } finally {
    removeDir(dir)
  }
})

function capture(fn) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof UpdaterError, `expected an UpdaterError, got ${error}`)
    return error
  }
  throw new assert.AssertionError({ message: 'the call was expected to refuse, and it did not' })
}
