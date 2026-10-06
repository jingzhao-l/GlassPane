/**
 * Guard for `scripts/set-version.mjs` — the atomicity the file's own header promises.
 *
 * Two defects, both about the rollback snapshot:
 *
 * 1. ORDER. Lockfiles were added to the snapshot *after* `npm install --package-lock-only`
 *    regenerated them, so the snapshot held the **new** lock text. When a later `LOCK_DIRS`
 *    entry failed, rollback restored the 10 declared sites to the old version while the
 *    already-regenerated lockfiles stayed at the new one — the exact "partial unify" the header
 *    says it exists to prevent. npm package version back at 1.7.0, its lock still at 1.7.1, and
 *    the next `npm ci` installs a tree that matches neither.
 *
 * 2. `--no-lock` WAS ADVERTISED AND UNSATISFIABLE. The flag skipped regeneration, but step ③
 *    called `drift(arg)` unconditionally, which includes the lock rows — so with `--no-lock` over
 *    a stale lock the script always rolled back and could never succeed. Fixed by making the
 *    self-check honour the flag (`drift(arg, { locks: !skipLock })`) and by printing the
 *    consequence, rather than by deleting a flag whose "sites only, locks later" use is real.
 *
 * These run `set-version.mjs` in a scratch repository with a **stubbed npm** on PATH, so nothing
 * touches the working tree and no real `npm install` is paid for. The stub reproduces the one
 * behaviour the defect turns on: it rewrites the directory's `package-lock.json` to the new
 * version, then fails on the call the test designates. `LOCK_DIRS` is `['.', 'kernel',
 * 'mcp-shell']`, so "a later entry fails" is call 2 or 3.
 *
 * REVERSE MUTATION: move the lockfile snapshot back inside the regeneration loop (after the
 * `spawnSync`) — `a failed lock regeneration rolls the already-regenerated lock back too` goes
 * red with the root lock left at the new version against every manifest at the old one. Drop the
 * `null` marker so a lock that did not exist before is left behind — `a lock npm created during a
 * run that then failed is removed, not orphaned` goes red. Pass `drift(arg)` its original
 * single argument — `--no-lock succeeds over stale locks, which is what the flag advertises`
 * goes red, and so does `--no-lock still checks every declared site`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const FROM = '1.0.0'
const TO = '1.2.3'

/** The 10 declared sites, spelled for a scratch tree: file → the text that carries the version. */
const SITE_TEMPLATES = {
  'package.json': (v) => `${JSON.stringify({ name: 'glasspane', version: v, private: true }, null, 2)}\n`,
  'mcp-shell/package.json': (v) => `${JSON.stringify({ name: 'glasspane-mcp', version: v }, null, 2)}\n`,
  'installer/package.json': (v) => `${JSON.stringify({ name: 'glasspane-install', version: v }, null, 2)}\n`,
  'updater/package.json': (v) => `${JSON.stringify({ name: 'glasspane-update', version: v, private: true }, null, 2)}\n`,
  'kernel/package.json': (v) => `${JSON.stringify({ name: '@iterate/kernel', version: v, private: true }, null, 2)}\n`,
  'mcp-shell/src/dispatch.ts': (v) => `export const SERVER_INFO = { name: "glasspane-mcp", version: "${v}" }\n`,
  'engine/Sources/GlassPaneEngine/EngineCore.swift': (v) => `public let version = "${v}"\n`,
  'engine/scripts/make-app.sh': (v) => `#!/bin/sh\ncat <<XML\n<key>CFBundleShortVersionString</key>\n        <string>${v}</string>\nXML\n`,
  'install.sh': (v) => `#!/bin/sh\nGLASSPANE_RELEASE="v${v}"\n`,
  'installer/cli.js': (v) => `export const RELEASE_VERSION = '${v}'\n`,
}

/** The lock shape set-version's own regeneration produces: one versioned entry per workspace key. */
const rootLock = (v) => `${JSON.stringify({ name: 'glasspane', version: v, lockfileVersion: 3, packages: { '': { version: v }, kernel: { version: v }, 'mcp-shell': { version: v }, installer: { version: v }, updater: { version: v } } }, null, 2)}\n`
const subLock = (name, v, extra = {}) => `${JSON.stringify({ name, version: v, lockfileVersion: 3, packages: { '': { version: v }, ...extra } }, null, 2)}\n`

/**
 * A scratch repository holding its own copy of both scripts (so `version-sites.mjs` resolves ROOT
 * to the scratch tree), all 10 sites and all 3 locks at `FROM`, and a `bin/npm` stub on PATH.
 */
function makeVersionTree({ locks = ['.', 'kernel', 'mcp-shell'] } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-set-version-'))
  const write = (rel, body, mode) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body, mode === undefined ? {} : { mode })
    if (mode !== undefined) fs.chmodSync(abs, mode)
  }
  write('scripts/set-version.mjs', fs.readFileSync(path.join(REPO, 'scripts', 'set-version.mjs'), 'utf8'))
  write('scripts/version-sites.mjs', fs.readFileSync(path.join(REPO, 'scripts', 'version-sites.mjs'), 'utf8'))
  write('scripts/check-version.mjs', fs.readFileSync(path.join(REPO, 'scripts', 'check-version.mjs'), 'utf8'))
  for (const [rel, template] of Object.entries(SITE_TEMPLATES)) write(rel, template(FROM))
  if (locks.includes('.')) write('package-lock.json', rootLock(FROM))
  if (locks.includes('kernel')) write('kernel/package-lock.json', subLock('@iterate/kernel', FROM))
  if (locks.includes('mcp-shell')) write('mcp-shell/package-lock.json', subLock('glasspane-mcp', FROM, { '../kernel': { name: '@iterate/kernel', version: FROM, dev: true } }))

  // The npm stub: what it must reproduce is "this directory's lock is now at the new version".
  write('bin/npm', `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
fs.appendFileSync(process.env.GP_NPM_LOG, cwd + '\\n')
const calls = fs.readFileSync(process.env.GP_NPM_LOG, 'utf8').trim().split('\\n').length
const lock = path.join(cwd, 'package-lock.json')
// npm generates the lock when it is absent, so the stub creates it too — that is what the
// "a run that failed must not orphan a lock npm created" case needs to see.
const body = fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8').split('${FROM}').join('${TO}') : '{"lockfileVersion":3,"packages":{"":{"version":"${TO}"}}}'
fs.writeFileSync(lock, body)
if (calls === Number(process.env.GP_FAIL_ON)) { process.stderr.write('stub npm refused\\n'); process.exit(1) }
process.exit(0)
`, 0o755)
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** Run the scratch set-version with the stub npm first on PATH. */
function runSetVersion({ root }, args, { failOn = 0 } = {}) {
  const log = path.join(root, 'npm-calls.log')
  fs.rmSync(log, { force: true })
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'set-version.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, GP_NPM_LOG: log, GP_FAIL_ON: String(failOn) },
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: readCalls(log) }
}

const readCalls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])

/**
 * The declared site files as `rel → text`. Every template carries the version exactly once, and the
 * two versions are distinct strings, so "still holds the old one" and "moved to the new one" are
 * readable straight off the text without re-deriving the site regexes here.
 */
function siteTexts({ root }) {
  const out = {}
  for (const rel of Object.keys(SITE_TEMPLATES)) out[rel] = fs.readFileSync(path.join(root, rel), 'utf8')
  return out
}

const lockText = (tree, dir) => fs.readFileSync(path.join(tree.root, dir, 'package-lock.json'), 'utf8')

test('a failed lock regeneration rolls the already-regenerated lock back too', () => {
  // `.` regenerates fine, `kernel` then fails. The defect: the root lock had already been snapshotted
  // *after* npm rewrote it, so rollback restored the 10 sites to 1.0.0 and left the root lock at 1.2.3.
  const tree = makeVersionTree()
  try {
    const run = runSetVersion(tree, [TO], { failOn: 2 })
    assert.equal(run.status, 1, run.output)
    assert.deepEqual(run.calls, [tree.root, path.join(tree.root, 'kernel')], 'failOn=2 应当死在 kernel 这一步：' + JSON.stringify(run.calls))

    // The declared sites are back at the old version — the half that always worked.
    const moved = Object.entries(siteTexts(tree)).filter(([, text]) => text.includes(TO))
    assert.deepEqual(moved, [], `回滚后仍有位点停在新版本：${JSON.stringify(moved)}`)

    // …and this is the assertion that used to be false: the lock npm already regenerated must go back
    // with them, not stay at the new version beside an old tree.
    assert.equal(lockText(tree, '.').includes(TO), false, '回滚后根 package-lock.json 仍是新版本 —— 部分统一')
    assert.equal(lockText(tree, '.').includes(FROM), true, '根 lock 应回到旧版本')
    assert.match(run.output, /已回滚/, run.output)
  } finally {
    tree.cleanup()
  }
})

test('a failed third lock regeneration rolls back the first two', () => {
  // Same defect one step further along: with `mcp-shell` failing, both the root and kernel locks had
  // already been regenerated and snapshotted too late.
  const tree = makeVersionTree()
  try {
    const run = runSetVersion(tree, [TO], { failOn: 3 })
    assert.equal(run.status, 1, run.output)
    for (const dir of ['.', 'kernel']) {
      assert.equal(lockText(tree, dir).includes(TO), false, `${dir}/package-lock.json 没跟着回滚`)
    }
  } finally {
    tree.cleanup()
  }
})

test('a lock npm created during a run that then failed is removed, not orphaned', () => {
  // The snapshot cannot describe a file that did not exist before the run. `mcp-shell` has no lock at
  // all; the stub generates one; the run then fails there. "Rolled back to the original state" is only
  // true if the generated lock goes away rather than being left at the new version.
  const tree = makeVersionTree({ locks: ['.', 'kernel'] })
  try {
    const run = runSetVersion(tree, [TO], { failOn: 3 })
    assert.equal(run.status, 1, run.output)
    assert.equal(fs.existsSync(path.join(tree.root, 'mcp-shell', 'package-lock.json')), false, '回滚后留下了一个本不该存在的 lock')
    assert.equal(lockText(tree, '.').includes(TO), false, '根 lock 也要回到旧版本')
  } finally {
    tree.cleanup()
  }
})

test('--no-lock succeeds over stale locks, which is what the flag advertises', () => {
  // The unsatisfiable-flag half: regeneration is skipped, so the three locks stay at 1.0.0 while the
  // sites move to 1.2.3. Step ③ used to count the lock rows as drift and roll the whole thing back,
  // meaning `--no-lock` could never exit 0. It must, and it must say the locks are still stale.
  const tree = makeVersionTree()
  try {
    const run = runSetVersion(tree, [TO, '--no-lock'])
    assert.equal(run.status, 0, run.output)
    assert.deepEqual(run.calls, [], '--no-lock 不该调用 npm：' + JSON.stringify(run.calls))
    for (const [rel, text] of Object.entries(siteTexts(tree))) assert.ok(text.includes(TO), `${rel} 没改到新版本`)
    for (const dir of ['.', 'kernel', 'mcp-shell']) {
      assert.equal(lockText(tree, dir).includes(TO), false, `${dir} 的 lock 不该被动`)
    }
    assert.match(run.output, /--no-lock 跳过了 lockfile/, '旗标的后果要说出来，否则"自证通过"会被读成 CI 也通过')
    assert.match(run.output, /check-version\.mjs 会因 lock 条目报漂移/, run.output)
  } finally {
    tree.cleanup()
  }
})

test('--no-lock still checks every declared site, so a broken site is still refused', () => {
  // Tolerating *locks* must not become tolerating *anything*. `--no-lock` narrows step ③ to the 10
  // declared sites; a site whose anchor stopped matching is still caught, still refuses to write, and
  // still says which one. Widen the flag to skip the site rows too and this goes red.
  const tree = makeVersionTree()
  try {
    // Rename the daemon's self-report so its site regex hits nothing.
    fs.writeFileSync(path.join(tree.root, 'engine/Sources/GlassPaneEngine/EngineCore.swift'), 'public let bundleVersion = "1.0.0"\n')
    const run = runSetVersion(tree, [TO, '--no-lock'])
    assert.equal(run.status, 1, run.output)
    assert.match(run.output, /位点异常/, run.output)
    assert.match(run.output, /EngineCore\.swift/, '要说得出是哪个位点：' + run.output)
    // And "中断，未改动任何文件" has to be true, not a claim: nothing was rewritten, and no npm ran.
    assert.equal(fs.readFileSync(path.join(tree.root, 'package.json'), 'utf8').includes(FROM), true, run.output)
    assert.deepEqual(run.calls, [], run.output)
  } finally {
    tree.cleanup()
  }
})

test('the happy path still unifies sites and locks in one run', () => {
  // The run the release flow depends on: every site and every lock ends at the new version, exit 0,
  // and the self-check that passes is the same rule `check-version.mjs` applies.
  const tree = makeVersionTree()
  try {
    const run = runSetVersion(tree, [TO])
    assert.equal(run.status, 0, run.output)
    assert.equal(run.calls.length, 3, `三个 lock 目录都要重生成一次：${JSON.stringify(run.calls)}`)
    for (const [rel, text] of Object.entries(siteTexts(tree))) assert.ok(text.includes(TO), `${rel} 没改到新版本`)
    for (const dir of ['.', 'kernel', 'mcp-shell']) {
      assert.equal(lockText(tree, dir).includes(FROM), false, `${dir}/package-lock.json 仍停在旧版本`)
    }
    assert.match(run.output, /版本线已统一到/, run.output)
    // The lock sites this script must keep in sync, checked by the same table CI reads.
    const checked = spawnSync(process.execPath, [path.join(tree.root, 'scripts', 'check-version.mjs'), TO], { cwd: tree.root, encoding: 'utf8' })
    assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`)
  } finally {
    tree.cleanup()
  }
})
