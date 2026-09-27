/**
 * §6 row "暂存树版本线自证".
 *
 * REVERSE MUTATION: skip the tree's own guard (drop the `runTreeGuard` call, or
 * return `ok: true` when `scripts/check-version.mjs` is missing) —
 * `a tree whose own guard exits non-zero is refused` and
 * `a tree with no guard at all cannot prove anything` both go red.
 *
 * The guard really runs: `node <staged>/scripts/check-version.mjs` is spawned as
 * a child process and its exit code decides the verdict, so this is the same
 * judgement CI makes, applied to bytes nobody has verified are that repo's.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { VERSION_SITES, assertVersionSites, runTreeGuard, selfCheckStagedTree, siteVersion } from '../lib/selfcheck.js'
import { CODES } from '../lib/codes.js'
import { removeDir, tempDir, TMP_PREFIX } from './helpers.mjs'

/** Write a staged tree that looks like a GlassPane release at `version`. */
function makeTree(dir, version, { guardExit = 0, driftSite = null, noGuard = false } = {}) {
  const write = (rel, content, mode) => {
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
  }
  write('package.json', JSON.stringify({ name: '@glasspane/monorepo', version }))
  write(path.join('mcp-shell', 'package.json'), JSON.stringify({ name: 'glasspane-mcp', version }))
  write(
    path.join('engine', 'Sources', 'GlassPaneEngine', 'EngineCore.swift'),
    `public final class EngineCore {\n    public let version = "${version}"\n}\n`,
  )
  if (!noGuard) {
    // A real script a real node process runs: no injected fake stands in for it.
    write(
      path.join('scripts', 'check-version.mjs'),
      `#!/usr/bin/env node\nimport process from 'node:process'\nprocess.stdout.write('version line root = ${version}\\n')\nprocess.exit(${guardExit})\n`,
      0o755,
    )
  }
  if (driftSite) write(driftSite.file, driftSite.content)
  return dir
}

test('three version sites and the tree guard are what self-checking means', () => {
  assert.deepEqual(VERSION_SITES.map((site) => site.id), ['root-package', 'mcp-shell-package', 'daemon-hello'])
  const dir = tempDir(`${TMP_PREFIX}selfcheck-ok-`)
  try {
    makeTree(dir, '1.4.0')
    const verdict = selfCheckStagedTree(dir, '1.4.0')
    assert.equal(verdict.ok, true, verdict.message)
    assert.deepEqual(verdict.sites, { 'root-package': '1.4.0', 'mcp-shell-package': '1.4.0', 'daemon-hello': '1.4.0' })
    assert.match(verdict.guard.stdout, /1\.4\.0/)
  } finally {
    removeDir(dir)
  }
})

test('a tree whose own guard exits non-zero is refused', () => {
  const dir = tempDir(`${TMP_PREFIX}selfcheck-guard-`)
  try {
    makeTree(dir, '1.4.0', { guardExit: 1 })
    const verdict = selfCheckStagedTree(dir, '1.4.0')
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, CODES.versionLineBroken)
    assert.match(verdict.message, /exit 1/)
  } finally {
    removeDir(dir)
  }
})

test('a tree with no guard at all cannot prove anything', () => {
  const dir = tempDir(`${TMP_PREFIX}selfcheck-noguard-`)
  try {
    makeTree(dir, '1.4.0', { noGuard: true })
    const verdict = selfCheckStagedTree(dir, '1.4.0')
    assert.equal(verdict.ok, false)
    assert.equal(verdict.code, CODES.versionLineBroken)
    assert.match(verdict.message, /carries no scripts\/check-version\.mjs/)
    assert.equal(runTreeGuard(dir).ok, false)
  } finally {
    removeDir(dir)
  }
})

test('one site out of step with the tag is version-line-broken, and it names the site', () => {
  const cases = [
    { file: 'mcp-shell/package.json', content: JSON.stringify({ name: 'glasspane-mcp', version: '1.3.9' }), expect: 'mcp-shell-package=1.3.9' },
    {
      file: 'engine/Sources/GlassPaneEngine/EngineCore.swift',
      content: 'public let version = "1.3.9"\n',
      expect: 'daemon-hello=1.3.9',
    },
    { file: 'package.json', content: JSON.stringify({ name: '@glasspane/monorepo', version: '1.5.0' }), expect: 'root-package=1.5.0' },
  ]
  for (const item of cases) {
    const dir = tempDir(`${TMP_PREFIX}selfcheck-drift-`)
    try {
      makeTree(dir, '1.4.0', { driftSite: item })
      const verdict = selfCheckStagedTree(dir, '1.4.0')
      assert.equal(verdict.ok, false, `drift at ${item.file} must refuse`)
      assert.equal(verdict.code, CODES.versionLineBroken)
      assert.match(verdict.message, new RegExp(item.expect))
      assert.match(verdict.message, /the release tag says 1\.4\.0/)
    } finally {
      removeDir(dir)
    }
  }
})

test('a missing or unreadable site file refuses rather than reading as a match', () => {
  const dir = tempDir(`${TMP_PREFIX}selfcheck-missing-`)
  try {
    makeTree(dir, '1.4.0')
    fs.rmSync(path.join(dir, 'mcp-shell', 'package.json'))
    const error = capture(() => assertVersionSites(dir, '1.4.0'))
    assert.equal(error.code, CODES.versionLineBroken)
    assert.match(error.message, /staged tree has no mcp-shell/)
  } finally {
    removeDir(dir)
  }
})

test('the swift site is read by its constant, not by any version-looking text', () => {
  const dir = tempDir(`${TMP_PREFIX}selfcheck-swift-`)
  try {
    const swift = path.join(dir, 'engine', 'Sources', 'GlassPaneEngine', 'EngineCore.swift')
    fs.mkdirSync(path.dirname(swift), { recursive: true })
    fs.writeFileSync(swift, '// released in 1.2.3\npublic let version = "1.4.0"\n')
    assert.equal(siteVersion(dir, VERSION_SITES[2]), '1.4.0')
    fs.writeFileSync(swift, 'public let version = "unreleased"\n')
    assert.equal(capture(() => siteVersion(dir, VERSION_SITES[2])).code, CODES.versionLineBroken)
  } finally {
    removeDir(dir)
  }
})

function capture(fn) {
  try {
    fn()
  } catch (error) {
    assert.ok(error.code, 'expected an UpdaterError, got ' + error)
    return error
  }
  throw new assert.AssertionError({ message: 'the call was expected to refuse, and it did not' })
}
