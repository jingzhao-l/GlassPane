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
 *     local entry — retired 2026-10-18, when `mcp-shell` switched to the published `iterate-kernel`.
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
 *
 * 2026-10-22 起这个文件还守第二件事：`SECURITY.md` / `SECURITY.zh-CN.md` 受影响版本表里那一格
 * `| 1.19.x |` 现在是一个声明过的位点（而且是按版本线的**段**比的那一种）。REVERSE MUTATION：
 * 从 `SITES` 删掉那两位 → `SECURITY 的受影响版本线两格是指向表格格的位点…` 红并点名文件；
 * 去掉 `line: true` → 同一条的红落在"没有 line 标记"上，而 `line 位点按版本线的段…` 会指出
 * 那样写会落进表格里的是 `1.20.3.x`；把 `drift()` 的段折算去掉 → `SECURITY 那两格漂了…` 红在
 * 期望值上（真源是 `1.19.0` 而那一格写的是 `1.19`，两边都恒红，所以这一条同时也证自己不是空转）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LOCKFILES, SITES, drift, expectedFor, lineOf, lockVersions, siteHitCount, truthVersion } from '../../scripts/version-sites.mjs'

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
  const manifestVersion = { '': 'package.json', 'mcp-shell': 'mcp-shell/package.json', installer: 'installer/package.json', updater: 'updater/package.json' }
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
  // drift set must be empty. If npm did NOT keep `updater` (or a workspace entry) in sync, the row would
  // appear here and the gate would be red forever — which is the outcome that has to be proven absent.
  const rows = drift(null)
  assert.deepEqual(rows, [], `版本线漂移：${JSON.stringify(rows)}`)
  assert.equal(truthVersion(), versionOf('mcp-shell/package.json'), '真源与壳同源，否则上面的空集没有意义')
  // 内核不在这条线上（2026-10-18）：`kernel/package.json` 跟着代码镜像一起退场了。它若再出现在位点表里，
  // 意思就是那份没有出处的镜像回来了——所以这条断言核的是"这里没有位点"，不是某个数字。
  assert.equal(SITES.some((site) => site.file === 'kernel/package.json'), false,
    'kernel/package.json 又成版本线位点了：那意味着仓里重新有了一份需要跟版本号的内核 manifest')
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

/* ------------------------------------------------------------------ 2026-10-22：SECURITY 那两格活版本线 */

const SECURITY_LINE_SITES = ['SECURITY.md', 'SECURITY.zh-CN.md'].map((file) => SITES.find((s) => s.file === file))

test('SECURITY 的受影响版本线两格是指向表格格的位点，且各自恰好命中一次', () => {
  // 这一族位点原来的状态是：`check-doc-links.mjs` 的「当前版本线」主张读它，而 `SITES` 不知道它，
  // 于是 `set-version` 推不动、每次发版都要人改两份文件——红的原因是"忘了改"而不是"写错了"
  // （2026-10-21 那轮的 #27 记的就是这件事，当时留作手改）。现在是位点了。
  assert.equal(SITES.length, 14, `位点表是 ${SITES.length} 条；新增/删除位点要连这条与它的夹具一起改`)
  for (const site of SECURITY_LINE_SITES) {
    assert.ok(site, 'SECURITY 那一位不在 SITES 里：那一格又回到没人推的状态')
    assert.equal(site.line, true, `${site.file} 的位点没有 line 标记：见下一条测试，那是它必须按段写的原因`)
    const hits = siteHitCount(site)
    assert.equal(hits, 1, `${site.file} 的位点正则命中 ${hits} 次：0 次是漏，>1 会改到别人的格子（位点表自己的口径）`)
  }
  // 命中一次不等于命中在对的那一行：把命中的字符串本身钉住，才是"这一格"。
  for (const site of SECURITY_LINE_SITES) {
    const text = fs.readFileSync(path.join(REPO, site.file), 'utf8')
    const m = new RegExp(site.regex.source, site.regex.flags.includes('g') ? site.regex.flags : `${site.regex.flags}g`).exec(text)
    assert.equal(m[2], '1.19', `${site.file} 的位点抓到的是 "${m[2]}"，不是受影响版本表里那一格`)
    assert.match(m[0], /\|\s*1\.19\.x\s*\|/, `${site.file}：命中的整段必须就是那一格，实得 "${m[0]}"`)
  }
})

test('line 位点按版本线的段（major.minor）比较与改写；按完整号写就会写出 `1.20.0.x`', () => {
  // 为什么需要 `line: true` 这一个标记，而不是把那一位照别人那样当普通位点登记：那一格对外说的是
  // **一条线**（`1.19.x` = 这一线上的一切补丁号都收安全修复），不是某一个补丁版。普通位点写的是完整
  // semver——`applySite` 把 `$1<version>$3` 原样落进去，于是 `1.19.x` 变成 `1.20.0.x`：一个渲染成垃圾
  // 的"修好"，还顺手把 `check-doc-links` 的「当前版本线」主张废掉（它要的是 `| X.Y.x |` 那个形状）。
  // 这里两个方向都判：按段写落在哪，按完整号写落在哪。
  assert.equal(lineOf('1.20.3'), '1.20')
  assert.equal(lineOf('2.0.0-rc.1'), '2.0')
  assert.equal(lineOf('nope'), null, '读不出段要回 null，调用方按异常报，不许拿原串比一个永不相等的值')
  for (const site of SECURITY_LINE_SITES) {
    assert.equal(expectedFor(site, '1.20.3'), '1.20', `${site.file}：line 位点的期望值应是段`)
    assert.equal(expectedFor({ line: false }, '1.20.3'), '1.20.3', '没有 line 标记的位点必须仍然按完整号写')
    const text = fs.readFileSync(path.join(REPO, site.file), 'utf8')
    const moved = text.replace(site.regex, `$1${expectedFor(site, '1.20.3')}$3`)
    assert.match(moved, /\|\s1\.20\.x\s*\|/, `${site.file}：按段改写要落在表格格上`)
    assert.ok(!moved.includes('1.20.0.x'), '写出了 1.20.0.x：位点没按段写')
    // 对照：同一个位点若被当成普通位点登记，落进去的就是那种垃圾——这条不红，上面那条"不红"就
    // 没有对照，判据也就没人信。
    assert.match(text.replace(site.regex, '$11.20.3$3'), /1\.20\.3\.x/, '这条对照必须能重现"垃圾"那个形状')
  }
})

test('SECURITY 那两格漂了必须进漂移集：红要报得出是谁、期望值是哪个段', () => {
  const rows = drift('9.9.9').filter((row) => row.kind === '位点' && /SECURITY/.test(row.where))
  assert.equal(rows.length, 2, JSON.stringify(rows.map((r) => r.where)))
  for (const row of rows) {
    assert.equal(row.target, '9.9', `期望值要是版本线的段，实得 ${row.target}`)
    assert.match(String(row.actual), /^\d+\.\d+$/, `那一格里现在是 "${row.actual}"——位点抓的不是段`)
  }
  // 真源今天与两格同号（`the line is currently consistent` 那条核过整个漂移集为空）；这里补的是它
  // 看不到的那一半：**漂**的时候报不报得出名字。
  assert.deepEqual(drift(null).filter((row) => /SECURITY/.test(row.where)), [], '当下这两格与真源同号，不该出现在漂移集里')
})
