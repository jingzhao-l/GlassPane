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
 * version, then fails on the call the test designates. `LOCK_DIRS` is `['.', 'mcp-shell']`
 * (`kernel` left it on 2026-10-18 with the mirrored manifest), so "the later entry fails" is call 2.
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
import { SITES } from '../../scripts/version-sites.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const FROM = '1.0.0'
const TO = '1.2.3'

/**
 * The declared sites, spelled for a scratch tree: file → the text that carries the version.
 *
 * `every declared site has a scratch template` below is what keeps this list honest: a site
 * added to scripts/version-sites.mjs without a template here makes the guard name the file, instead
 * of the three lock tests failing with "位点异常" like they did when the README sites landed.
 */
const SITE_TEMPLATES = {
  'package.json': (v) => `${JSON.stringify({ name: 'glasspane', version: v, private: true }, null, 2)}\n`,
  'mcp-shell/package.json': (v) => `${JSON.stringify({ name: 'glasspane-mcp', version: v }, null, 2)}\n`,
  'installer/package.json': (v) => `${JSON.stringify({ name: 'glasspane-install', version: v }, null, 2)}\n`,
  'updater/package.json': (v) => `${JSON.stringify({ name: 'glasspane-update', version: v, private: true }, null, 2)}\n`,
  'mcp-shell/src/dispatch.ts': (v) => `export const SERVER_INFO = { name: "glasspane-mcp", version: "${v}" }\n`,
  // 1.10.0 起权威位点是 static；1.16.0 起还有一份**旧 updater 读者能解析的实例字面量**
  // （兼容位，见 CHANGELOG 1.16.0 与 version-sites.mjs 的那条注释）。夹具必须同时带这两行——
  // 只给一份的测试结果会像 1.16.0 那次一样：三个锁测试红在"位点异常"，而完备性对照因为
  // 按**文件名**去核，看见这个文件有夹具就放行了。
  'engine/Sources/GlassPaneEngine/EngineCore.swift': (v) =>
    `public static let buildVersion = "${v}"\n    public let version = "${v}"\n`,
  'engine/scripts/make-app.sh': (v) => `#!/bin/sh\ncat <<XML\n<key>CFBundleShortVersionString</key>\n        <string>${v}</string>\n<key>CFBundleVersion</key>\n        <string>${v}</string>\nXML\n`,
  'install.sh': (v) => `#!/bin/sh\nGLASSPANE_RELEASE="v${v}"\n`,
  'installer/cli.js': (v) => `export const RELEASE_VERSION = '${v}'\n`,
  // 文档里那条 clone 命令也是位点（1.15.0 起）：README 与 install.sh 各写一份 tag 时，
  // 漂移的是用户照抄的那一行，而 check-version 当时看不见它。夹具按生产那一行的形状给。
  'README.md': (v) => `git clone --branch v${v} https://github.com/jingzhao-l/GlassPane.git && cd GlassPane\n`,
  'README.zh-CN.md': (v) => `git clone --branch v${v} https://github.com/jingzhao-l/GlassPane.git && cd GlassPane\n`,
  // 2026-10-22：`SECURITY.md` / `SECURITY.zh-CN.md` 的受影响版本表那一格进了位点表，而它是这一族
  // 里的第一种 `line: true`——写进那格的是版本线的**段**（`1.2`），不是完整号。原因在那条位点自己
  // 的注释里：那一格对外说的是"这一线的一切补丁号都收安全修复"，把 `1.2.3` 落进去会把它变成
  // "只有 1.2.3 这一个补丁版受支持"，那是另一句话，而且是假的那一句。夹具因此按生产的形状给：
  // 段在格子里，完整号只出现在那句带日期的散文读数里（`siteTexts()` 读的就是它）。
  'SECURITY.md': (v) =>
    `| ${v.split('.').slice(0, 2).join('.')}.x | ✅ current release line; security fixes ship here. ` +
    `**Measurement (2026-10-20, at the ${v} bump):** the root \`package.json\` version is the source of truth. |\n`,
  'SECURITY.zh-CN.md': (v) =>
    `| ${v.split('.').slice(0, 2).join('.')}.x | ✅ 当前版本线，安全修复在此发布。` +
    `**测量口径（2026-10-20，随 ${v} 取号）**：真源是根 \`package.json\` 的 version。|\n`,
}

/** The lock shape set-version's own regeneration produces: one versioned entry per workspace key. */
const rootLock = (v) => `${JSON.stringify({ name: 'glasspane', version: v, lockfileVersion: 3, packages: { '': { version: v }, 'mcp-shell': { version: v }, installer: { version: v }, updater: { version: v } } }, null, 2)}\n`
const subLock = (name, v, extra = {}) => `${JSON.stringify({ name, version: v, lockfileVersion: 3, packages: { '': { version: v }, ...extra } }, null, 2)}\n`

/**
 * A scratch repository holding its own copy of both scripts (so `version-sites.mjs` resolves ROOT
 * to the scratch tree), every declared site and both locks at `FROM`, and a `bin/npm` stub on PATH.
 */
function makeVersionTree({ locks = ['.', 'mcp-shell'] } = {}) {
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
  // `iterate-kernel` sits in the shell's lock at its OWN version (0.1.8, not the GlassPane line):
  // the kernel publishes on iterate's rhythm, and the stub npm rewrites only `FROM` — so this entry
  // also proves a version bump here cannot drag the kernel's number along.
  if (locks.includes('mcp-shell')) write('mcp-shell/package-lock.json', subLock('glasspane-mcp', FROM, { 'node_modules/iterate-kernel': { name: 'iterate-kernel', version: '0.1.8', dev: true, resolved: 'https://registry.npmjs.org/iterate-kernel/-/iterate-kernel-0.1.8.tgz' } }))

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

/**
 * 一个位点文件在"统一到 `version`"之后**应当**含有哪一段字符串。
 *
 * 普通位点就是完整 semver。带 `line: true` 的那几位写的是版本线的**段**（`SECURITY.md` /
 * `SECURITY.zh-CN.md` 受影响版本表里那一格 `| 1.2.x |` 说的是"这一线的一切补丁号都收安全修复"；
 * 把 `1.2.3` 落进那一格等于宣称只有那一个补丁版受支持——那是另一句话，而且是不真的那一句。判据与
 * 它的对照见 `updater/test/scripts-version-sites.test.mjs` 的 `line 位点按版本线的段…`）。
 * 拿完整号去核那一格，会把"按段写"这个正确行为判成"没改到新版本"；反过来去掉段折算，
 * `the happy path…` 会红在缺 `1.2`，两边都有名字。
 */
const siteTextNeedle = (rel, version) =>
  (SITES.find((site) => site.file === rel)?.line ? version.split('.').slice(0, 2).join('.') : version)

test('a failed lock regeneration rolls the already-regenerated lock back too', () => {
  // `.` regenerates fine, `mcp-shell` then fails. The defect: the root lock had already been snapshotted
  // *after* npm rewrote it, so rollback restored the sites to 1.0.0 and left the root lock at 1.2.3.
  // (`kernel` left `LOCK_DIRS` on 2026-10-18 — the mirrored manifest is no longer on the GlassPane
  // version line — so this is the second and last regeneration call.)
  const tree = makeVersionTree()
  try {
    const run = runSetVersion(tree, [TO], { failOn: 2 })
    assert.equal(run.status, 1, run.output)
    assert.deepEqual(run.calls, [tree.root, path.join(tree.root, 'mcp-shell')], 'failOn=2 应当死在 mcp-shell 这一步：' + JSON.stringify(run.calls))

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

test('a lock npm created during a run that then failed is removed, not orphaned', () => {
  // The snapshot cannot describe a file that did not exist before the run. `mcp-shell` has no lock at
  // all; the stub generates one; the run then fails there. "Rolled back to the original state" is only
  // true if the generated lock goes away rather than being left at the new version.
  const tree = makeVersionTree({ locks: ['.'] })
  try {
    const run = runSetVersion(tree, [TO], { failOn: 2 })
    assert.equal(run.status, 1, run.output)
    assert.equal(fs.existsSync(path.join(tree.root, 'mcp-shell', 'package-lock.json')), false, '回滚后留下了一个本不该存在的 lock')
    assert.equal(lockText(tree, '.').includes(TO), false, '根 lock 也要回到旧版本')
  } finally {
    tree.cleanup()
  }
})

test('--no-lock succeeds over stale locks, which is what the flag advertises', () => {
  // The unsatisfiable-flag half: regeneration is skipped, so both locks stay at 1.0.0 while the
  // sites move to 1.2.3. Step ③ used to count the lock rows as drift and roll the whole thing back,
  // meaning `--no-lock` could never exit 0. It must, and it must say the locks are still stale.
  const tree = makeVersionTree()
  try {
    const run = runSetVersion(tree, [TO, '--no-lock'])
    assert.equal(run.status, 0, run.output)
    assert.deepEqual(run.calls, [], '--no-lock 不该调用 npm：' + JSON.stringify(run.calls))
    for (const [rel, text] of Object.entries(siteTexts(tree))) assert.ok(text.includes(siteTextNeedle(rel, TO)), `${rel} 没改到新版本（这一位该出现 ${siteTextNeedle(rel, TO)}）`)
    for (const dir of ['.', 'mcp-shell']) {
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
    assert.equal(run.calls.length, 2, `两个 lock 目录都要重生成一次：${JSON.stringify(run.calls)}`)
    for (const [rel, text] of Object.entries(siteTexts(tree))) assert.ok(text.includes(siteTextNeedle(rel, TO)), `${rel} 没改到新版本（这一位该出现 ${siteTextNeedle(rel, TO)}）`)
    for (const dir of ['.', 'mcp-shell']) {
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

test('every declared site has a scratch template, so adding one cannot break the lock tests silently', () => {
  const templated = new Set(Object.keys(SITE_TEMPLATES))
  const missing = [...new Set(SITES.map((s) => s.file))].filter((f) => !templated.has(f))
  assert.deepEqual(missing, [], `scripts/version-sites.mjs 里有位点没有夹具：${missing.join(', ')}`)
  // 反过来说，模板表里留着已经不在位点表的文件也是漂移（上一版写死的"10 个位点"就是这么过期的）。
  const declared = new Set(SITES.map((s) => s.file))
  const stale = [...templated].filter((f) => !declared.has(f))
  assert.deepEqual(stale, [], `夹具里有已经不在位点表的文件：${stale.join(', ')}`)
  // 文件名对上不等于位点对上。1.16.0 那次新增的兼容位点**和被删的位点在同一个文件里**，
  // 上面两条对照全绿，而三个锁测试红在"位点异常"——因为夹具还写着 1.10.0 的转读写法，
  // 那条正则在新位点上永远不命中。判据必须是"每一条位点正则能在它自己的夹具里打到东西"。
  for (const site of SITES) {
    const template = SITE_TEMPLATES[site.file]
    const produced = template('9.9.9')
    const re = new RegExp(site.regex.source, site.regex.flags.replace('g', ''))
    assert.ok(re.test(produced),
              `位点 ${site.id} 的正则打不到自己的夹具（${site.file}）：加位点要连夹具一起加`)
  }
})
