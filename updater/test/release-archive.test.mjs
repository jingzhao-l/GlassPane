/**
 * A real round trip of `scripts/make-release-archive.mjs` through the unpacker the updater uses.
 *
 * This file exists because the archive is what every later gate reads: `apply` unpacks it, `swift build`
 * runs inside it, and §1's npm rule packs the two packages *out of it*. When the archive was only
 * `git archive HEAD`, the packed `glasspane-mcp` had no `dist/` at all — a defect that could only be seen
 * by a real machine (measured 2026-10-01: three entries in the tarball, `ENOENT` at the MCP half of the
 * handshake, whole swap rolled back). So the archive's shape is tested here the way the updater will meet
 * it: parse it, unpack it, ask whether the promise the manifest makes is a file that exists on disk.
 *
 * REVERSE MUTATION: drop `mcp-shell/dist` from the script's `REQUIRED_BUILD_OUTPUTS` —
 * `the archive carries the build output the npm package promises to run` goes red, because the declared
 * command is then missing from the tree the unpacked release hands to `npm pack`. Make the tracked-entry
 * order non-deterministic (reverse the sort) and `packing the same tree twice answers with the same bytes`
 * goes red. Widen `EXCLUDED_PREFIXES` to `engine/` and `an exclusion that would remove an install input is
 * refused, not published` goes red — that mutation is the shape the size fix could have taken by accident,
 * and it is the reason `archiveBytes` takes `prefixes` as an argument. Narrow `EXCLUDED_PREFIXES` back to
 * `['harness/']` (what it was before `.iterate_decisions.md` was added) and both
 * `the vendored fork and the developer log stay out of the archive, and by how much is stated` and
 * `the script runs against this repository and refuses a version it cannot name an archive with` go red —
 * the second one is the one that matters, because it reads the real tracked tree and the real artifact the
 * release job publishes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyExclusions,
  archiveBytes,
  declaredCommands,
  EXCLUDED_PREFIXES,
  REQUIRED_IN_ARCHIVE,
  requiredEntries,
  REQUIRED_BUILD_OUTPUTS,
  trackedEntries,
  verifyArchive,
} from '../../scripts/make-release-archive.mjs'
import { extractTarGz, packTarGz, readTarGz } from '../lib/tar.js'
import { VERSION_SITES } from '../lib/selfcheck.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'make-release-archive.mjs')

/** A throwaway git tree with the two packages, their manifests, and (optionally) the build output. */
function makeReleaseTree({ withDist = true, commitBuildOutputs = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-release-tree-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  const write = (rel, body, mode = 0o644) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body, { mode })
    fs.chmodSync(abs, mode)
  }
  // The real repository ignores what the build writes; `commitBuildOutputs` is the other shape, and the
  // archive has to carry such a file exactly once instead of colliding with itself.
  if (!commitBuildOutputs) write('.gitignore', 'mcp-shell/dist/\nmcp-shell/schemas/\n')
  write('README.md', '# GlassPane\n')
  write('package.json', JSON.stringify({ name: 'glasspane', version: '1.6.0', private: true }) + '\n')
  write('scripts/check-version.mjs', 'export const checkVersion = () => true\n')
  write('scripts/version-sites.mjs', 'export const SITES = []\n')
  write('install.sh', '#!/bin/sh\necho hi\n', 0o755)
  write('engine/Package.swift', '// swift-tools\n')
  write('engine/scripts/make-app.sh', '#!/bin/sh\necho app\n', 0o755)
  write('engine/Sources/GlassPaneEngine/EngineCore.swift', 'public let version = "1.6.0"\n')
  write('kernel/schemas/decision-log-entry.schema.json', '{}\n')
  // The vendored fork the release archive leaves out: 90% of this repository's tracked bytes on the real
  // tree, and read by no step of the update path. It has to be present in the fixture, or "excluded" would
  // be tested against an empty set and pass for the wrong reason.
  write('harness/glasspane-harness/package.json', JSON.stringify({ name: 'fork' }) + '\n')
  write('harness/glasspane-harness/src/big.js', 'x'.repeat(4096) + '\n')
  // The developer's own iteration log, tracked at the repository root and read by no step of the update
  // path. The real one carried four copies of its author's absolute home path and notes on `gh auth` token
  // scopes, and it shipped in the v1.7.0 archive. It has to be present here, or excluding it is a rule
  // tested against an empty set.
  write('.iterate_decisions.md', '# Iterate Decision Log\nworktree /Users/someone/dev/thing\ngh auth scopes: repo\n')
  // The real repository tracks symlinked icon files (harness/public), and the archive has to carry them as
  // links for the unpacker to materialize — the shape that once made every real release stop at the unpack.
  write('docs/logo.png', 'PNG-BYTES\n')
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.symlinkSync('logo.png', path.join(root, 'docs', 'icon.png'))
  write('updater/cli.js', 'export const runCommand = () => {}\n')
  write('updater/lib/tar.js', 'export const packTarGz = () => {}\n')
  write('mcp-shell/package.json', JSON.stringify({
    name: 'glasspane-mcp',
    version: '1.6.0',
    bin: { 'glasspane-mcp': 'dist/index.js' },
    files: ['dist', 'schemas', 'LICENSE', 'README.md'],
  }) + '\n')
  write('mcp-shell/src/index.ts', 'export {}\n')
  write('installer/package.json', JSON.stringify({
    name: 'glasspane-install',
    version: '1.6.0',
    bin: 'cli.js',
  }) + '\n')
  write('installer/cli.js', 'export const install = () => {}\n')
  if (withDist) {
    write('mcp-shell/dist/index.js', '#!/usr/bin/env node\nconsole.log("glasspane-mcp")\n', 0o755)
    write('mcp-shell/schemas/decision-log-entry.schema.json', '{}\n')
  }
  git('add', '-A')
  git('-c', 'user.email=test@example.test', '-c', 'user.name=test', 'commit', '-q', '-m', 'tree')
  return { root, git, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test('the archive carries the build output the npm package promises to run', () => {
  const tree = makeReleaseTree()
  try {
    const { bytes, entries, commands } = archiveBytes({ root: tree.root, version: '1.6.0' })
    assert.ok(commands.some((c) => c.endsWith(':glasspane-mcp')), `the manifest's command must be part of the contract: ${commands}`)

    const parsed = readTarGz(bytes).map((entry) => entry.name)
    assert.ok(parsed.includes('GlassPane-1.6.0/mcp-shell/dist/index.js'), JSON.stringify(parsed.slice(0, 6)))
    assert.ok(parsed.includes('GlassPane-1.6.0/mcp-shell/schemas/decision-log-entry.schema.json'), 'schemas ride along: the bundle reads them at runtime')
    assert.ok(parsed.includes('GlassPane-1.6.0/install.sh'), 'tracked files come through')
    assert.ok(entries >= parsed.length - 1, 'every entry is counted')

    // Unpack the way the updater does, then ask the question the *next* step asks: after `npm pack` and
    // `npm install -g`, is there a command on this machine that actually runs? That is the promise
    // `glasspane-mcp could not run (ENOENT)` broke on 2026-10-01, and nothing short of installing it proves it.
    const dest = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-release-unpack-'))
    const prefix = path.join(dest, 'npm-prefix')
    try {
      extractTarGz(bytes, dest, { allowedRoot: dest })
      const binFile = path.join(dest, 'GlassPane-1.6.0', 'mcp-shell', 'dist', 'index.js')
      assert.ok(fs.existsSync(binFile), 'the unpacked release must contain what its manifest declares as the command')
      assert.notEqual(fs.statSync(binFile).mode & 0o111, 0, 'the build wrote an executable command; the archive may not strip that bit')

      // And `npm pack` of that directory has to produce a tarball that really holds it — the exact
      // step that shipped a three-entry package from the source-only archive on 2026-10-01.
      const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dest], {
        cwd: path.join(dest, 'GlassPane-1.6.0', 'mcp-shell'),
        encoding: 'utf8',
      })
      assert.equal(packed.status, 0, packed.stderr)
      const tgz = String(packed.stdout).trim().split('\n').filter(Boolean).pop()
      const listing = execFileSync('tar', ['-tzf', path.join(dest, tgz)], { encoding: 'utf8' }).split('\n')
      assert.ok(listing.includes('package/dist/index.js'), `npm pack must find the build output to ship: ${JSON.stringify(listing)}`)

      const installed = spawnSync('npm', ['install', '-g', '--no-audit', '--no-fund', '--ignore-scripts', path.join(dest, tgz)], {
        cwd: dest,
        encoding: 'utf8',
        env: { ...process.env, npm_config_prefix: prefix },
      })
      assert.equal(installed.status, 0, installed.stdout + installed.stderr)
      const command = path.join(prefix, 'bin', 'glasspane-mcp')
      assert.ok(fs.existsSync(command), `the installed package must put its command on PATH: ${JSON.stringify(fs.readdirSync(path.join(prefix, 'bin')))}\n${installed.stdout}`)
      const ran = spawnSync(command, [], { encoding: 'utf8', timeout: 10_000 })
      assert.equal(ran.error?.code, undefined, `the command must at least be found: ${ran.error?.code ?? ran.error?.message}`)
      assert.equal(ran.status, 0, `the installed command must run: exit=${ran.status} ${ran.stderr}`)

      // The tracked tree's symlinks ride along as links (the repository's own icon files are links, and
      // `git archive` carried them the same way). The unpacker materializes bytes — a release that lost them
      // would unpack an incomplete tree, and one that carried them as *copies* would silently change which
      // bytes are the release's.
      const linkEntry = readTarGz(bytes).find((entry) => entry.name === 'GlassPane-1.6.0/docs/icon.png')
      assert.equal(linkEntry?.type, 'link', 'tracked 符号链接仍以链接入档')
      assert.ok(fs.existsSync(path.join(dest, 'GlassPane-1.6.0', 'docs', 'icon.png')), '解出来的树里那个位置仍有内容')
    } finally {
      fs.rmSync(dest, { recursive: true, force: true })
    }
  } finally {
    tree.cleanup()
  }
})

test('the vendored fork and the developer log stay out of the archive, and by how much is stated', () => {
  const tree = makeReleaseTree()
  try {
    // First prove each exclusion has something to bite on: the tracked tree really carries both. Without
    // this the assertions below pass on a fixture that never had the paths, which would be a guard that has
    // never excluded anything.
    const tracked = trackedEntries({ root: tree.root })
    const fork = tracked.filter((entry) => entry.name.startsWith('harness/'))
    assert.equal(fork.length, 2, JSON.stringify(tracked.map((entry) => entry.name)))
    const log = tracked.filter((entry) => entry.name === '.iterate_decisions.md')
    assert.equal(log.length, 1, '归档里要挡住的是真存在的文件，不是凭空的名')

    const packed = archiveBytes({ root: tree.root, version: '1.6.0' })
    const names = readTarGz(packed.bytes).map((entry) => entry.name)
    assert.ok(!names.some((name) => name.startsWith('GlassPane-1.6.0/harness/')), JSON.stringify(names))
    // The line that goes red if `.iterate_decisions.md` is dropped from EXCLUDED_PREFIXES. This is the
    // artifact every updater downloads, and the file is the developer's own log — home paths and `gh auth`
    // scope notes included.
    assert.ok(
      !names.includes('GlassPane-1.6.0/.iterate_decisions.md'),
      `.iterate_decisions.md 被放进了发布归档：${JSON.stringify(names.filter((n) => n.includes('iterate')))}`,
    )
    assert.ok(!names.some((name) => name.includes('iterate_decisions')), '归档里不该有任何 iterate 决策日志的痕迹')
    assert.equal(packed.excluded.count, 3, '排除条数要说得出，不是"少了一些"')
    const excluded = [...fork, ...log]
    assert.equal(packed.excluded.bytes, excluded.reduce((total, entry) => total + entry.content.byteLength, 0))
    // Byte order puts `.iterate_decisions.md` first, so this list is exact rather than set-like: a prefix
    // silently removed from EXCLUDED_PREFIXES changes it.
    assert.deepEqual(packed.excluded.prefixes, ['.iterate_decisions.md', 'harness/'])
    assert.ok(EXCLUDED_PREFIXES.includes('.iterate_decisions.md'), 'EXCLUDED_PREFIXES 必须显式列出开发日志')

    // Everything the install path reads survives, and the shrink is bounded rather than incidental: the
    // archive is smaller than the full tree but still carries every required input.
    for (const need of REQUIRED_IN_ARCHIVE) {
      assert.ok(names.includes(`GlassPane-1.6.0/${need}`), `${need} 是安装路径要读的，必须仍在档`)
    }
    const fullBytes = archiveBytes({ root: tree.root, version: '1.6.0', prefixes: [] }).bytes.length
    assert.ok(packed.bytes.length < fullBytes, `排除应当真的让归档变小：${packed.bytes.length} vs ${fullBytes}`)
  } finally {
    tree.cleanup()
  }
})

test('an exclusion that would remove an install input is refused, not published', () => {
  // REVERSE MUTATION of EXCLUDED_PREFIXES: widen it to `engine/` in the real script and the release step
  // stops here rather than shipping an archive whose `swift build --package-path <staged>/engine` has
  // nothing to build. The prefixes are injected because the hostile value is the thing under test.
  const tree = makeReleaseTree()
  try {
    for (const prefix of ['engine/', 'engine/Package.swift', 'updater/', 'installer/', 'scripts/']) {
      assert.throws(
        () => archiveBytes({ root: tree.root, version: '1.6.0', prefixes: [prefix] }),
        (error) => /install-critical/.test(error.message),
        `排除 ${prefix} 必须让发布拒绝，而不是安静少一个目录`,
      )
    }
    // The self-check's own site table is where part of this list comes from, so a new site is a new
    // requirement without anyone remembering to edit a second list.
    for (const site of VERSION_SITES) {
      assert.ok(REQUIRED_IN_ARCHIVE.includes(site.file.split(path.sep).join('/')), `${site.file} 是 selfcheck 要读的`)
    }
    // A prefix that matches nothing is not a refusal — it is reported as an empty exclusion, so the number
    // the job prints stays the thing a reviewer checks.
    const harmless = archiveBytes({ root: tree.root, version: '1.6.0', prefixes: ['nope/'] })
    assert.equal(harmless.excluded.count, 0)
    assert.deepEqual(harmless.excluded.prefixes, [])
    assert.deepEqual(applyExclusions({ entries: [], prefixes: [] }).kept, [])
  } finally {
    tree.cleanup()
  }
})

test('an archive that would contain a command with nothing behind it is refused', () => {
  // The 2026-10-01 shape: the tree is complete except for what the build never ran, and the manifest still
  // promises `dist/index.js`. Publishing that produces an installable, unreadable, un-runnable package.
  const tree = makeReleaseTree({ withDist: false })
  try {
    assert.throws(
      () => archiveBytes({ root: tree.root, version: '1.6.0' }),
      (error) => /mcp-shell\/dist is missing/.test(error.message),
      '缺构建产物必须是拒绝，不是警告',
    )
    assert.throws(() => {
      // And if the manifest were edited to name a command the build outputs do not contain, the declared
      // -command check has to catch that too, not just the directory being absent.
      fs.mkdirSync(path.join(tree.root, 'mcp-shell', 'dist'), { recursive: true })
      fs.writeFileSync(path.join(tree.root, 'mcp-shell', 'dist', 'other.js'), 'console.log(1)\n')
      fs.mkdirSync(path.join(tree.root, 'mcp-shell', 'schemas'), { recursive: true })
      archiveBytes({ root: tree.root, version: '1.6.0' })
    }, /declares the command "glasspane-mcp" at dist\/index.js, which this tree does not contain/)
  } finally {
    tree.cleanup()
  }
})

test('packing the same tree twice answers with the same bytes', () => {
  const tree = makeReleaseTree()
  try {
    const packed = archiveBytes({ root: tree.root, version: '1.6.0' })
    const a = packed.bytes
    const b = archiveBytes({ root: tree.root, version: '1.6.0' }).bytes
    assert.ok(a.equals(b), 'the release archive is published with a SHA256SUMS file; a second pass that differs makes that claim meaningless')
    // The order is a promise of its own, not an accident of the sort: two publishers (or one publisher and a
    // person verifying the artifact) must be able to `tar -tzf` the same file and diff it line by line.
    const names = readTarGz(a).map((entry) => entry.name)
    assert.deepEqual(names, [...names].sort(), '条目按名字排列，两份归档要能逐行比对')
    assert.equal(REQUIRED_BUILD_OUTPUTS.length, 2, 'the declared build outputs are the contract this guard exists for')
  } finally {
    tree.cleanup()
  }
})

test('a build output that the repository also commits is carried once, not twice', () => {
  // `git ls-files` and the build-output walk can name the same path. The archive must not contain two
  // entries for it (an unpacker would silently take the last), and it must still contain the file at all.
  const tree = makeReleaseTree({ commitBuildOutputs: true })
  try {
    const { bytes } = archiveBytes({ root: tree.root, version: '1.6.0' })
    const names = readTarGz(bytes).map((entry) => entry.name)
    const dupes = names.filter((name) => name === 'GlassPane-1.6.0/mcp-shell/dist/index.js')
    assert.equal(dupes.length, 1, `只许出现一次：${JSON.stringify(dupes)}`)
    assert.ok(new Set(names).size === names.length, '归档里没有任何重名条目')
  } finally {
    tree.cleanup()
  }
})

test('--verify reads the artifact back and answers the question the updater will ask', () => {
  const tree = makeReleaseTree()
  const out = path.join(tree.root, 'GlassPane-1.6.0.tar.gz')
  try {
    fs.writeFileSync(out, archiveBytes({ root: tree.root, version: '1.6.0' }).bytes)
    const ok = verifyArchive({ file: out, version: '1.6.0', root: tree.root })
    assert.deepEqual(ok.missing, [], JSON.stringify(ok.required))
    // Derived, not hardcoded: the requirement is the manifest's own `bin` plus what `kernel/schemas` holds,
    // so adding a command or a schema extends the check without anyone remembering to edit a list. The
    // install inputs ride along for the same reason they are checked at build time — an archive that
    // satisfies every `bin` field but has no `engine/` cannot be installed at all.
    assert.ok(ok.required.includes('GlassPane-1.6.0/mcp-shell/dist/index.js'), JSON.stringify(ok.required))
    for (const need of REQUIRED_IN_ARCHIVE) {
      assert.ok(ok.required.includes(`GlassPane-1.6.0/${need}`), `${need} 必须进 required 清单：${JSON.stringify(ok.required)}`)
    }

    // And the same call against the shape that shipped on 2026-10-01 — a source-only archive — must say so.
    const sourceOnly = path.join(tree.root, 'source-only.tar.gz')
    fs.writeFileSync(sourceOnly, packTarGz([
      { name: 'GlassPane-1.6.0/mcp-shell/package.json', content: fs.readFileSync(path.join(tree.root, 'mcp-shell', 'package.json')) },
      { name: 'GlassPane-1.6.0/installer/package.json', content: fs.readFileSync(path.join(tree.root, 'installer', 'package.json')) },
      { name: 'GlassPane-1.6.0/installer/cli.js', content: fs.readFileSync(path.join(tree.root, 'installer', 'cli.js')) },
    ]))
    const bad = verifyArchive({ file: sourceOnly, version: '1.6.0', root: tree.root })
    assert.ok(bad.missing.includes('GlassPane-1.6.0/mcp-shell/dist/index.js'), JSON.stringify(bad.missing))
    assert.ok(bad.missing.includes('GlassPane-1.6.0/engine/Package.swift'), `安装输入缺席也要点名：${JSON.stringify(bad.missing)}`)

    // An empty `kernel/schemas` means there is nothing to require next to the command, and the archive would
    // then pass while shipping a package whose runtime schemas are gone. "Nothing listed" is a refusal here,
    // not a vacuous pass.
    fs.rmSync(path.join(tree.root, 'kernel', 'schemas', 'decision-log-entry.schema.json'))
    assert.throws(
      () => requiredEntries({ root: tree.root, version: '1.6.0' }),
      /kernel\/schemas holds no \.json schema/,
      '空清单不能当成"没有要求"',
    )
  } finally {
    tree.cleanup()
  }
})

test('the workflow asks that question through the script, not a shell pipeline', () => {
  // The v1.6.0 release job reddened on `tar -tzf … | grep -q …` under `set -o pipefail`: grep exits at the
  // first match, GNU tar dies of SIGPIPE, and the step fails while naming an entry the archive contains.
  // A check that reports its own success wrongly is worse than no check, so the step is one script call now.
  const text = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  assert.match(text, /node scripts\/make-release-archive\.mjs --verify/, '发布作业要经由同一个脚本问这个问题')
  assert.ok(!/tar -tzf[^\n]*\|[^\n]*grep/.test(text), '不许再用 `tar | grep` 的管道判成败：pipefail 会把它变成假红')
})

test('the script runs against this repository and refuses a version it cannot name an archive with', () => {
  const out = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-release-out-')), 'GlassPane-1.6.0.tar.gz')
  try {
    // Only when this working tree has *all* the build outputs the archive promises (the gate's mcp lane runs
    // `build` + `bundle`; CI's updater job checks out without either) can the real repository pass. Say which
    // of the two was measured, so a passing run is never a silent skip.
    const built = REQUIRED_BUILD_OUTPUTS.every((dir) => fs.existsSync(path.join(REPO, dir)))
    const run = spawnSync(process.execPath, [SCRIPT, '1.6.0', out], { encoding: 'utf8' })
    if (built) {
      assert.equal(run.status, 0, run.stdout + run.stderr)
      assert.match(run.stdout, /entries=\d+ bytes=\d+ sha256=[0-9a-f]{64}/)
      const listing = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).split('\n')
      assert.ok(listing.includes('GlassPane-1.6.0/mcp-shell/dist/index.js'), 'the shipped archive must carry the command')
      // The defect this closes was only visible against the *real* tracked tree. The fixture above proves
      // the mechanism; `.iterate_decisions.md` is a real file, and the real v1.7.0 artifact shipped it —
      // four occurrences of its author's absolute home path and notes on `gh auth` token scopes, inside the
      // archive every updater downloads. Assert on the bytes the release job would publish.
      assert.ok(
        !listing.some((name) => name.includes('iterate_decisions')),
        `真实归档仍带着开发者日志：${JSON.stringify(listing.filter((name) => name.includes('iterate')))}`,
      )
      // And it must be *exactly one* entry fewer than the same tree published without the rule — not "somehow
      // smaller". That is what ties the exclusion to the file and nothing else.
      const beforeTheRule = archiveBytes({ root: REPO, version: '1.6.0', prefixes: ['harness/'] })
      const entries = Number(/entries=(\d+)/.exec(run.stdout)[1])
      assert.equal(entries, beforeTheRule.entries - 1, `排除应当只少这一个条目：${entries} vs ${beforeTheRule.entries}`)
      // The `--verify` lane still holds over the reduced archive: excluding a file removes an entry, never a
      // requirement, and the release job's own check must still say so in the same numbers.
      const verify = spawnSync(process.execPath, [SCRIPT, '--verify', out, '1.6.0'], { encoding: 'utf8' })
      assert.equal(verify.status, 0, verify.stdout + verify.stderr)
      assert.match(verify.stdout, /all \d+ declared commands and schemas present/, verify.stdout)
      assert.equal(Number(/verified: (\d+) entries/.exec(verify.stdout)[1]), entries, '--verify 的条目数要和自己写出的字节一致')
      assert.match(run.stdout, /excluded: \d+ entries \/ \d+ raw bytes under \.iterate_decisions\.md, harness\//, run.stdout)
    } else {
      assert.equal(run.status, 1, '缺构建产物时要拒绝发版，而不是打出一个三条目包')
      assert.match(run.stderr, /is missing/, run.stderr)
    }
    const bad = spawnSync(process.execPath, [SCRIPT, 'refs/pull/16/head', path.join(path.dirname(out), 'x.tar.gz')], { encoding: 'utf8' })
    assert.equal(bad.status, 2, bad.stdout + bad.stderr)
    assert.match(bad.stderr, /not a version this script will name a release archive with/, bad.stderr)
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true })
  }
})

test('归档的每一个字节都必须等于 index 记下的那一份——脏工作树不许被说成 tagged tree', () => {
  // 这条闸盯的是发布通道上最贵的一种谎：`git ls-files -s` 明明给出 blob 号，从前却被丢掉，
  // 内容改从磁盘读。checkout 之后任何进程改脏一个被追踪的文件（构建往 src 里写、残留的编辑、
  // 钩子），归档就带上"tag 里根本没有的字节"，而 updater 之后把这份的 SHA256 呈现成"发布者
  // 签过的那份"。`--verify` 抓不到：它只数条目在不在，不看里面是什么。
  const tree = makeReleaseTree()
  try {
    // 对照的一半：同一棵树没被改脏时必须打得开，否则下面的拒绝可能红在别的原因上。
    const clean = trackedEntries({ root: tree.root })
    assert.ok(clean.length > 10, `干净树要能列出条目，实得 ${clean.length}`)

    tree.write('engine/Sources/GlassPaneEngine/EngineCore.swift', 'public let version = "1.6.0-dirty"\n')
    assert.throws(
      () => trackedEntries({ root: tree.root }),
      /differs between the working tree .* and git's index .*refusing to publish an archive whose bytes are not the tagged tree/,
      '被改脏的追踪文件必须被点名拒绝，而不是静静进档',
    )

    // 符号链接走同一扇门：blob 存的是目标字符串，换目标就是改内容。
    const linkTree = makeReleaseTree()
    try {
      fs.rmSync(path.join(linkTree.root, 'docs', 'icon.png'))
      fs.symlinkSync('logo.png?v=2', path.join(linkTree.root, 'docs', 'icon.png'))
      assert.throws(
        () => trackedEntries({ root: linkTree.root }),
        /is a symlink to .* which hashes to .* the index has /,
        '换了目标的符号链接必须被拒——归档里那条 link 不是 tag 里的那条',
      )
    } finally {
      linkTree.cleanup()
    }

    // 拒绝要一路顶到脚本：打归档那条命令不能只警告一下就写出文件。
    const out = path.join(fs.realpathSync(os.tmpdir()), 'gp-dirty-archive-probe.tar.gz')
    const run = spawnSync(process.execPath, [SCRIPT, 'HEAD', out], { cwd: tree.root, encoding: 'utf8' })
    assert.equal(run.status, 1, `脏树必须非零退出：\n${run.stdout}\n${run.stderr}`)
    assert.match(run.stderr, /differs between the working tree/, run.stderr)
    assert.equal(fs.existsSync(out), false, '拒绝之后不能留下半个归档')
  } finally {
    tree.cleanup()
  }
})
