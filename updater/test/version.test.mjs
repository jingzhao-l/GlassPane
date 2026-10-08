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
import { spawnSync } from 'node:child_process'

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

test('这个桩只认 --version：它不许再替一个不存在的开关背书', () => {
  // `makeDaemonBinary` 从前对**任何**参数都 echo 版本号。那正是 `glasspaned --version`
  // 这个当时根本不存在的能力能带着"两读数必须一致"长期全绿的原因——桩答得越慷慨，
  // 缺的能力藏得越深。所以拒绝这条也要有一条用例钉住：桩自己退化回有求必应时，
  // 这里必须先红，而不是让上面那些用例继续绿。
  const dir = tempDir(`${TMP_PREFIX}stub-refusal-`)
  try {
    const exe = makeDaemonBinary(dir, '1.4.0', 'GlassPane Daemon.app')
    const answering = spawnSync(exe, ['--version'], { encoding: 'utf8' })
    assert.equal(answering.status, 0, answering.stderr)
    assert.match(answering.stdout, /^glasspaned 1\.4\.0\s*$/, '认得出的参数要照真 daemon 的样子回答')

    for (const arg of ['--help', '--permissions', '']) {
      const refused = spawnSync(exe, [arg], { encoding: 'utf8' })
      assert.equal(refused.status, 64, `${arg || '(空)'} 被这个桩接下了：它又开始替不存在的能力背书`)
      assert.equal(refused.stdout, '', '拒绝时不许吐出版本号')
      assert.match(refused.stderr, /unknown argument/, '拒绝的话要和真 daemon 同形')
    }
  } finally {
    removeDir(dir)
  }
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

/**
 * The readers report "no reading" (`null`); the *refusal* lives in `localVersion`,
 * which is the only place that can see all three readings at once.
 *
 * This changed on 2026-09-27 because of a real run: `node updater/cli.js check`
 * against this machine's install failed with `version-mismatch-local` — the daemon
 * there is 0.1.0 and answers `--version` with `unknown argument` + usage and exit
 * 64, because the flag is newer than the install. A reader that throws on "the
 * binary does not know the question" makes the updater dead on arrival for exactly
 * the machines it exists for, while still telling nobody anything. Reversing this
 * (throwing again) reddens the old-install case below, and dropping the
 * `readings.length === 0` guard in `localVersion` reddens the first case.
 */
test('readers that learn nothing yield null, and the judgement refuses only when nothing answered', () => {
  const dir = tempDir(`${TMP_PREFIX}ver-broken-`)
  try {
    const appsDir = path.join(dir, 'Applications')
    fs.mkdirSync(path.join(appsDir, 'GlassPane.app', 'Contents'), { recursive: true })
    fs.writeFileSync(path.join(appsDir, 'GlassPane.app', 'Contents', 'Info.plist'), '<plist><dict></dict></plist>')
    assert.equal(readBundleVersion(path.join(appsDir, 'GlassPane.app')), null, 'a plist without the key is no reading')
    assert.equal(readBundleVersion(path.join(appsDir, 'NotInstalled.app'))
      , null, 'a bundle that is not there at all is no reading either')

    const silent = path.join(dir, 'glasspaned')
    fs.writeFileSync(silent, '#!/bin/sh\necho "no version here"\n')
    fs.chmodSync(silent, 0o755)
    assert.equal(readDaemonVersion(silent), null)

    const verdict = localVersion({
      appsDir,
      daemonExecutable: silent,
      settingsAppName: 'GlassPane.app',
      daemonAppName: 'GlassPane Daemon.app',
    })
    assert.equal(verdict.ok, false, 'nothing answered ⇒ still a refusal, not a guess')
    assert.equal(verdict.code, CODES.versionMismatchLocal)
    assert.match(verdict.message, /nothing installed at/)
  } finally {
    removeDir(dir)
  }
})

/** The state this machine is actually in: old daemon, readable bundle. */
test('an install whose daemon predates --version is still readable from its bundle', () => {
  const dir = tempDir(`${TMP_PREFIX}ver-old-`)
  try {
    const appsDir = path.join(dir, 'Applications')
    for (const [name, version] of [['GlassPane.app', '0.1.0'], ['GlassPane Daemon.app', '0.1.0']]) {
      fs.mkdirSync(path.join(appsDir, name, 'Contents'), { recursive: true })
      fs.writeFileSync(
        path.join(appsDir, name, 'Contents', 'Info.plist'),
        `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
      )
    }
    const oldDaemon = path.join(dir, 'glasspaned')
    fs.writeFileSync(oldDaemon, '#!/bin/sh\necho "glasspaned: unknown argument: --version"\nexit 64\n')
    fs.chmodSync(oldDaemon, 0o755)
    const verdict = localVersion({
      appsDir,
      daemonExecutable: oldDaemon,
      settingsAppName: 'GlassPane.app',
      daemonAppName: 'GlassPane Daemon.app',
    })
    assert.equal(verdict.ok, true, verdict.message)
    assert.equal(verdict.version, '0.1.0')
    assert.equal(verdict.seen.daemonApp, '0.1.0')
    assert.equal(verdict.seen.daemonBinary, null, 'the missing reading stays visible in the record')

    // And a real disagreement between the readings that DO exist is still refused.
    fs.writeFileSync(
      path.join(appsDir, 'GlassPane.app', 'Contents', 'Info.plist'),
      '<plist><dict><key>CFBundleShortVersionString</key><string>1.4.0</string></dict></plist>',
    )
    const split = localVersion({
      appsDir,
      daemonExecutable: oldDaemon,
      settingsAppName: 'GlassPane.app',
      daemonAppName: 'GlassPane Daemon.app',
    })
    assert.equal(split.ok, false, 'a half-updated machine must not be auto-updated from an unknown base')
    assert.match(split.message, /0\.1\.0.*1\.4\.0|1\.4\.0.*0\.1\.0/)
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
