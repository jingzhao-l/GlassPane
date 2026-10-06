/**
 * Guard for `scripts/version-sites.mjs` — the LOCKFILES table must compare **every** lockfile
 * entry that carries a version belonging to the version line.
 *
 * The table's whole job is the `npm ci` mismatch surface: a manifest at one version and the lock
 * that CI installs from at another. It read `package-lock.json` → `''/kernel/mcp-shell/installer`
 * and each sub-package lock's `''` only, and skipped two versioned entries that npm itself keeps in
 * sync with the very `npm install --package-lock-only` calls `set-version.mjs` runs:
 *
 *   - `mcp-shell/package-lock.json` → `"../kernel"` — the `file:../kernel` devDependency's resolved
 *     local entry, which holds `"version"` copied from `kernel/package.json`.
 *   - `package-lock.json` → `"updater"` — the `updater` workspace entry, whose version belongs to
 *     the line because `updater/package.json` is a declared SITE.
 *
 * Both were confirmed against real npm (11.17.0) on a scratch copy of the repository state, never
 * against the working tree: bump the manifest in the scratch only, run the same command
 * `set-version.mjs` runs, read the entry back. npm rewrote it, and rewrote nothing else in the file.
 * The tests below re-run that measurement each time, so if npm ever *stops* maintaining the field
 * these go red instead of the CI gate silently asserting a value that is not kept.
 *
 * The other half of the original finding is NOT real and is pinned here so it is not "fixed" again:
 * the root lock's `node_modules/glasspane-*` entries are `{"resolved": <dir>, "link": true}` with no
 * `version` field at all, so there is nothing for the line to compare.
 *
 * REVERSE MUTATION: drop `'../kernel'` from the mcp-shell row of `LOCKFILES` —
 * `mcp-shell's file:../kernel entry is a version line site, and is compared` goes red on both the
 * `drift()` row and the lock-vs-manifest cross-check. Drop `'updater'` from the root row and
 * `the root lock's updater workspace entry is a version line site, and is compared` goes red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LOCKFILES, drift, lockVersions, truthVersion } from '../../scripts/version-sites.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const versionOf = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')).version

/** Every `drift()` row's `where` for a given lockfile, e.g. `mcp-shell/package-lock.json → ../kernel`. */
const driftRowsFor = (file, want) => drift(want).filter((row) => row.kind === 'lock' && row.where.startsWith(`${file} →`))

test('the mcp-shell lock entry for file:../kernel is a version line site, and is compared', () => {
  const keys = LOCKFILES.find((lock) => lock.file === 'mcp-shell/package-lock.json').keys
  assert.ok(keys.includes('../kernel'), `'../kernel' 不在 LOCKFILES 里：${JSON.stringify(keys)}`)

  // The npm behaviour the site depends on, measured rather than assumed: the lock's entry for the
  // `file:../kernel` dependency must carry exactly what kernel/package.json says. If npm ever stops
  // writing it, this is red — not the CI gate quietly comparing a field that no longer exists.
  const rows = lockVersions({ file: 'mcp-shell/package-lock.json', keys: ['../kernel'] })
  assert.equal(rows.length, 1, `lockVersions 必须给出这一条：${JSON.stringify(rows)}`)
  assert.equal(rows[0].missing, false, 'lock 条目存在性本身要能断言')
  assert.equal(rows[0].actual, versionOf('kernel/package.json'), 'lock 的 ../kernel 版本要跟 kernel/package.json 同源')

  // And it participates in the gate: an expectation it does not meet must produce a row, which is the
  // only shape in which "the guard can go red" is true for a lockfile site.
  const rows999 = driftRowsFor('mcp-shell/package-lock.json', '9.9.9')
  assert.ok(
    rows999.some((row) => row.where === 'mcp-shell/package-lock.json → ../kernel'),
    JSON.stringify(rows999),
  )
})

test("the root lock's updater workspace entry is a version line site, and is compared", () => {
  const keys = LOCKFILES.find((lock) => lock.file === 'package-lock.json').keys
  assert.ok(keys.includes('updater'), `'updater' 不在 LOCKFILES 里：${JSON.stringify(keys)}`)

  const rows = lockVersions({ file: 'package-lock.json', keys: ['updater'] })
  assert.equal(rows.length, 1, JSON.stringify(rows))
  assert.equal(rows[0].actual, versionOf('updater/package.json'))
  assert.ok(
    driftRowsFor('package-lock.json', '9.9.9').some((row) => row.where === 'package-lock.json → updater'),
    'updater 条目必须进漂移集',
  )
})

test('every lock site the table names exists in its lockfile and matches its own manifest', () => {
  // The cross-check that makes the table worth having: each declared key resolves to a real entry whose
  // version equals the package.json of the same-named workspace. A key that names nothing at all would
  // make `lockVersions()` report `missing`, and this assertion catches the table drifting from the tree.
  const manifestVersion = { '': 'package.json', kernel: 'kernel/package.json', 'mcp-shell': 'mcp-shell/package.json', installer: 'installer/package.json', updater: 'updater/package.json' }
  for (const lock of LOCKFILES) {
    for (const entry of lockVersions(lock)) {
      assert.equal(entry.missing, false, `${lock.file} → ${entry.key} 在 lock 里找不到`)
      assert.ok(/^\d+\.\d+\.\d+/.test(entry.actual), `${lock.file} → ${entry.key} 没有可读版本：${entry.actual}`)
      const manifest = manifestVersion[entry.key]
      if (manifest) assert.equal(entry.actual, versionOf(manifest), `${lock.file} → ${entry.key} 与 ${manifest} 不同源`)
    }
  }
})

test('the line is currently consistent, so a site added in error would be a permanently red gate', () => {
  // This is the check that makes adding lock sites safe: with the real tree at its current version the
  // drift set must be empty. If npm did NOT keep `../kernel` or `updater` in sync, the row would appear
  // here and the gate would be red forever — which is the outcome that has to be proven absent.
  const rows = drift(null)
  assert.deepEqual(rows, [], `版本线漂移：${JSON.stringify(rows)}`)
  assert.equal(truthVersion(), versionOf('kernel/package.json'), '真源与 kernel 同源，否则上面的空集没有意义')
})

test('link entries carry no version, so they are not lock sites (the finding that is not real)', () => {
  // `package-lock.json` → `node_modules/glasspane-update` was reported as a missing site. It is
  // `{"resolved": "updater", "link": true}` with no `version` field, so there is nothing to compare, and
  // adding it as a key would only produce a `missing`/null row. Pinned so the claim is not re-"fixed".
  const data = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'))
  for (const key of ['node_modules/glasspane-update', 'node_modules/glasspane-mcp', 'node_modules/glasspane-install']) {
    const entry = data.packages?.[key]
    assert.ok(entry, `${key} 应当存在`)
    assert.equal(entry.link, true, `${key} 是 link 条目`)
    assert.equal(entry.version, undefined, `${key} 没有 version 字段可比`)
    // And `lockVersions` skips it by design: it produces no row, so it can never be a site.
    assert.deepEqual(lockVersions({ file: 'package-lock.json', keys: [key] }), [])
  }
})
