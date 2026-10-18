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
 * REVERSE MUTATION: put `'../kernel'` back into the mcp-shell row of `LOCKFILES`, or give
 * `mcp-shell/package.json` a `file:../kernel` dependency again —
 * `mcp-shell 的 lock 里不再有仓内本地内核，而已发布的内核不归这条版本线` goes red on the key list,
 * on the lock scan, or on the `resolved:` URL. Drop `'updater'` from the root row and
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

test('mcp-shell 的 lock 里不再有仓内本地内核，而已发布的内核不归这条版本线', () => {
  // 2026-10-18：mcp-shell 不再吃 `file:../kernel`，改吃已发布的 `iterate-kernel`。这条测试原来钉的是
  // "npm 会把本地依赖的版本写进 lock"那一实测行为；现在它钉退场的**反面**两件事——本地条目不许回来，
  // 内核版本不许被当成 GlassPane 版本线上的位点。这两条一旦复活，就是"两份契约各跟一个节奏发布"，
  // 而那正是这整个 batch 要消掉的东西。内核与 pin 的同号判定住在 scripts/check-kernel-corpus.mjs。
  const keys = LOCKFILES.find((lock) => lock.file === 'mcp-shell/package-lock.json').keys
  assert.deepEqual(keys, [''], `mcp-shell 的 lock 位点只剩它自己：${JSON.stringify(keys)}`)

  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'mcp-shell/package-lock.json'), 'utf8'))
  const localKernel = Object.keys(lock.packages).filter((name) => name === '../kernel' || name.endsWith('/kernel'))
  assert.deepEqual(localKernel, [], `lock 里不许有仓内本地内核条目：${JSON.stringify(localKernel)}`)
  const kernel = lock.packages['node_modules/iterate-kernel']
  assert.ok(kernel, 'lock 必须记录 mcp-shell 捆进产物里的那份内核——有名有姓，否则产物内的契约没有出处')
  assert.match(String(kernel.resolved), /^https:\/\/registry\./,
    `内核必须来自 registry（file:/link: 都意味着这份产物装到别处就不是同一份契约），实得 ${kernel.resolved}`)

  // 位点还在闸里（防止把测试改成永不红）：版本线期望值不符时必须产出行；
  // 而任何指向本地内核的位点都不许再出现。
  const rows999 = driftRowsFor('mcp-shell/package-lock.json', '9.9.9')
  assert.ok(rows999.length >= 1, 'mcp-shell 自己那一位必须参与漂移集')
  assert.ok(rows999.every((row) => !row.where.includes('kernel')),
    `没有任何内核位点该被版本线比较：${JSON.stringify(rows999.map((row) => row.where))}`)
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
