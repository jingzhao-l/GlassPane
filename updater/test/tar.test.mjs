/**
 * Not a §6 row of its own, but the rule the task states as a hard constraint:
 * "your code must NEVER delete or overwrite anything outside
 * `<stateRoot>/update-staging/` / `update-backup/`, and a path that resolves
 * outside the state root is a refusal, not a warning."
 *
 * MUTATION 1: drop the guard in `safeEntryTarget` (join `destDir` with the entry
 * name alone) — `an entry that walks out of the staging directory is refused
 * before anything is written` goes red, and a `../` entry lands in the parent.
 * MUTATION 2: drop the header-checksum verification in `readHeader` —
 * `a flipped byte in a header is caught by the checksum` goes red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { extractTarGz, packTarGz, readTarGz, safeEntryTarget } from '../lib/tar.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError, ensurePrivateDir, isWithin, modeOf, removeTreeWithin, resolveWithin, tightenMode, writableRoots, writePrivateFile } from '../lib/fsutil.js'
import { discardStaging, extractInto, prepareStaging, writeArchive } from '../lib/staging.js'
import { removeDir, tempDir, TMP_PREFIX } from './helpers.mjs'

test('pack/read round-trips a real tree, including modes', () => {
  const bytes = packTarGz([
    { name: 'GlassPane-1.4.0/package.json', content: '{"version":"1.4.0"}' },
    { name: 'GlassPane-1.4.0/scripts', type: 'dir', mode: 0o755 },
    { name: 'GlassPane-1.4.0/scripts/check-version.mjs', content: '#!/usr/bin/env node\n', mode: 0o755 },
  ])
  const entries = readTarGz(bytes)
  assert.deepEqual(entries.map((e) => e.name), [
    'GlassPane-1.4.0/package.json',
    'GlassPane-1.4.0/scripts',
    'GlassPane-1.4.0/scripts/check-version.mjs',
  ])
  assert.equal(entries[0].type, 'file')
  assert.equal(entries[1].type, 'dir')
  assert.equal(entries[0].bytes.toString(), '{"version":"1.4.0"}')
  assert.equal(entries[2].mode & 0o111, 0o111, 'the executable bit survives')
})

test('an entry that walks out of the staging directory is refused before anything is written', () => {
  const dir = tempDir(`${TMP_PREFIX}tar-escape-`)
  try {
    const stagingRoot = path.join(dir, 'staging')
    const dest = path.join(stagingRoot, '1.4.0', 'tree')
    fs.mkdirSync(dest, { recursive: true })
    const canary = path.join(dir, 'CANARY')
    fs.writeFileSync(canary, 'do not touch me')

    const bytes = packTarGz([
      { name: 'GlassPane-1.4.0/harmless.txt', content: 'fine' },
      { name: '../../../../escaped.txt', content: 'written next to the state root' },
    ])
    const error = capture(() => extractTarGz(bytes, dest, { allowedRoot: stagingRoot }))
    assert.equal(error.code, CODES.archiveEntryUnsafe)
    assert.equal(fs.readFileSync(canary, 'utf8'), 'do not touch me', 'the refusal happened before any write')
    assert.ok(!fs.existsSync(path.join(dir, 'escaped.txt')))
    assert.ok(!fs.existsSync(path.join(dest, 'GlassPane-1.4.0', 'harmless.txt')), 'nothing from a refused archive is left behind')
  } finally {
    removeDir(dir)
  }
})

test('absolute names, drive letters, backslashes and empty names refuse', () => {
  const dir = tempDir(`${TMP_PREFIX}tar-names-`)
  try {
    const dest = path.join(dir, 'tree')
    fs.mkdirSync(dest, { recursive: true })
    for (const name of ['/etc/passwd', 'C:\\Windows\\system32', '', 'a/../..', './../out']) {
      assert.equal(capture(() => safeEntryTarget(dest, name)).code, CODES.archiveEntryUnsafe, `refuse ${JSON.stringify(name)}`)
    }
    assert.equal(safeEntryTarget(dest, 'GlassPane-1.4.0/package.json'), path.join(dest, 'GlassPane-1.4.0/package.json'))
  } finally {
    removeDir(dir)
  }
})

test('links and devices in an archive are refused, not created', () => {
  const dir = tempDir(`${TMP_PREFIX}tar-link-`)
  try {
    const dest = path.join(dir, 'tree')
    fs.mkdirSync(dest, { recursive: true })
    const archive = packTarGz([{ name: 'a.txt', content: 'x' }])
    const raw = zlib.gunzipSync(archive)
    const header = Buffer.from(raw.subarray(0, 512))
    header.write('2', 156) // typeflag: symlink
    header.set(Buffer.from('/etc/passwd').subarray(0, 100), 157)
    header.write('        ', 148)
    let sum = 0
    for (let i = 0; i < 512; i += 1) sum += header[i]
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    const symlinkArchive = zlib.gzipSync(Buffer.concat([header, raw.subarray(512)]))

    const error = capture(() => extractTarGz(symlinkArchive, dest, { allowedRoot: dir }))
    // 链接的**绝对目标**仍然一口回绝，只是理由是"这个链接指向暂存目录之外"，比原先那句
    // "只解文件与目录"更准（现在同档内的链接会被物化成副本，见下面几条）。
    assert.equal(error.code, CODES.archiveEntryUnsafe)
    assert.match(error.message, /absolute path/)
    assert.ok(!fs.existsSync(path.join(dest, 'a.txt')), 'a refused archive writes nothing at all')
  } finally {
    removeDir(dir)
  }
})

/**
 * 真机 2026-09-29 查出来的第二条：`git archive` 会把仓里的符号链接原样打进 release 资产
 * （本仓 `harness/.../apple-touch-line` 那几张图标就是链接），而当时的解包器对 typeflag `2`
 * 一律 `archive-entry-unsupported` ⇒ **每一份真实 release 都停在暂存这一步**。
 * 现在的规则：链接一律**物化成档案里那份字节的副本**，落盘的东西里不再有任何链接；
 * 绝对目标、跑出暂存目录的目标、档案里没有的目标、指向目录的链接、设备与 FIFO 仍然全拒。
 */
test('a link inside the archive becomes a copy of the bytes the archive carries, never a link on disk', () => {
  const dir = tempDir(`${TMP_PREFIX}tar-deref-`)
  try {
    const dest = path.join(dir, 'tree')
    fs.mkdirSync(dest, { recursive: true })
    const archive = packTarGz([
      { name: 'GlassPane-1.5.1/', type: 'dir' },
      { name: 'GlassPane-1.5.1/apple-touch-icon.png', content: 'ICON-BYTES' },
      // 反向引用（链接在目标之后）与正向引用（链接在目标之前）都要能物化。
      { name: 'GlassPane-1.5.1/apple-touch-icon-v3.png', type: 'link', link: 'apple-touch-icon.png', mode: 0o777 },
      { name: 'GlassPane-1.5.1/sub/', type: 'dir' },
      { name: 'GlassPane-1.5.1/sub/early.png', type: 'link', link: '../apple-touch-icon.png' },
      { name: 'GlassPane-1.5.1/hard.txt', type: 'link', flag: '1', link: 'apple-touch-icon.png' },
    ])
    const result = extractTarGz(archive, dest, { allowedRoot: dir })
    const copied = path.join(dest, 'GlassPane-1.5.1/apple-touch-icon-v3.png')
    const early = path.join(dest, 'GlassPane-1.5.1/sub/early.png')
    const hard = path.join(dest, 'GlassPane-1.5.1/hard.txt')
    for (const file of [copied, early, hard]) {
      assert.equal(fs.readFileSync(file, 'utf8'), 'ICON-BYTES', `${file} 必须是目标那份字节的副本`)
      assert.equal(fs.lstatSync(file).isFile(), true, `${file} 落盘必须是普通文件，不能还是链接`)
      assert.equal(fs.lstatSync(file).isSymbolicLink(), false, `${file} 不许是指向别处的符号链接`)
    }
    assert.equal(result.entries.filter((e) => e.type === 'link').length, 3, '摘要里要看得见这三条是链接')
    // 副本不是硬链接：inode 必须各自独立，否则改一个就动了另一个。
    assert.notEqual(fs.statSync(copied).ino, fs.statSync(path.join(dest, 'GlassPane-1.5.1/apple-touch-icon.png')).ino)
    // 副本的权限位跟**目标文件**走，不跟链接条目走：tar 把符号链接记成 0777，
    // 照抄过来就是每台机器上都多一个人人可写的发布字节（真机 v1.5.1 那棵树实测 0777）。
    assert.equal(fs.statSync(copied).mode & 0o777, fs.statSync(path.join(dest, 'GlassPane-1.5.1/apple-touch-icon.png')).mode & 0o777,
      '链接副本的 mode 必须等于目标文件的 mode')
    assert.equal(fs.statSync(copied).mode & 0o022, 0, '不许出现组/其他人可写')
  } finally {
    removeDir(dir)
  }
})

test('every link that is not a plain in-archive file reference is refused before a byte is written', () => {
  const cases = [
    ['absolute', [{ name: 'a.txt', content: 'x' }, { name: 'b.txt', type: 'link', link: '/etc/passwd' }]],
    ['escapes the tree', [{ name: 'a.txt', content: 'x' }, { name: 'b.txt', type: 'link', link: '../../../../etc/passwd' }]],
    ['dangling', [{ name: 'a.txt', content: 'x' }, { name: 'b.txt', type: 'link', link: 'nope.txt' }]],
    ['empty target', [{ name: 'a.txt', content: 'x' }, { name: 'b.txt', type: 'link', link: '' }]],
    ['to a directory', [{ name: 'd/', type: 'dir' }, { name: 'b.txt', type: 'link', link: 'd' }]],
    ['to another link', [{ name: 'a.txt', content: 'x' }, { name: 'l1', type: 'link', link: 'a.txt' }, { name: 'l2', type: 'link', link: 'l1' }]],
    ['hard link to a directory', [{ name: 'd/', type: 'dir' }, { name: 'b', type: 'link', flag: '1', link: 'd' }]],
  ]
  for (const [label, entries] of cases) {
    const dir = tempDir(`${TMP_PREFIX}tar-link-${label}-`)
    try {
      const dest = path.join(dir, 'tree')
      fs.mkdirSync(dest, { recursive: true })
      const error = capture(() => extractTarGz(packTarGz(entries), dest, { allowedRoot: dir }))
      assert.ok(error, `${label} 这条链接必须被拒，不能悄悄落盘`)
      assert.ok([CODES.archiveEntryUnsupported, CODES.archiveEntryUnsafe].includes(error.code),
        `${label} 拒绝了但换了个没听过的码：${error.code}`)
      assert.deepEqual(fs.readdirSync(dest), [], `${label}：拒了却已经写了东西——先校验后写这条不成立了`)
    } finally {
      removeDir(dir)
    }
  }
})

test('device, FIFO and other exotic entry types stay refused', () => {
  for (const flag of ['3', '4', '6']) {
    const dir = tempDir(`${TMP_PREFIX}tar-dev-${flag}-`)
    try {
      const dest = path.join(dir, 'tree')
      fs.mkdirSync(dest, { recursive: true })
      const error = capture(() => extractTarGz(packTarGz([{ name: 'x', flag, link: '' }]), dest, { allowedRoot: dir }))
      assert.equal(error.code, CODES.archiveEntryUnsupported, `flag ${flag} 必须拒（拿到 ${error?.code ?? 'no error'}）`)
      assert.match(error.message, /devices, FIFOs/)
      assert.deepEqual(fs.readdirSync(dest), [], `flag ${flag} 拒晚了，树里已经有东西`)
    } finally {
      removeDir(dir)
    }
  }
})

test('a flipped byte in a header is caught by the checksum', () => {
  const dir = tempDir(`${TMP_PREFIX}tar-corrupt-`)
  try {
    const dest = path.join(dir, 'tree')
    fs.mkdirSync(dest, { recursive: true })
    const archive = packTarGz([{ name: 'GlassPane-1.4.0/package.json', content: '{"version":"1.4.0"}' }])
    const raw = zlib.gunzipSync(archive)
    raw.write('x', 5) // corrupt the name, leave the stored checksum alone
    const broken = zlib.gzipSync(raw)
    assert.equal(capture(() => readTarGz(broken)).code, CODES.archiveUnreadable)
    assert.equal(capture(() => extractTarGz(broken, dest, { allowedRoot: dir })).code, CODES.archiveUnreadable)
    assert.deepEqual(fs.readdirSync(dest), [], 'a corrupt archive leaves nothing behind')
  } finally {
    removeDir(dir)
  }
})

test('non-gzip bytes and a truncated payload refuse', () => {
  assert.equal(capture(() => readTarGz(Buffer.from('this is not gzip'))).code, CODES.archiveUnreadable)
  const archive = packTarGz([{ name: 'a.txt', content: 'x'.repeat(3000) }])
  const raw = zlib.gunzipSync(archive)
  assert.equal(capture(() => readTarGz(zlib.gzipSync(raw.subarray(0, 900)))).code, CODES.archiveUnreadable)
})

test('staging paths outside the state root are refused at every entry point', () => {
  const dir = tempDir(`${TMP_PREFIX}staging-`)
  try {
    const roots = writableRoots(dir)
    ensurePrivateDir(roots.staging)
    assert.equal(roots.staging, path.join(dir, 'update-staging'))
    for (const version of ['../../etc', '1.4.0; rm -rf /', '', null]) {
      assert.equal(capture(() => prepareStaging({ stateRoot: dir, version })).code, CODES.tagUnparseable)
    }

    const ok = prepareStaging({ stateRoot: dir, version: '1.4.0' })
    assert.equal(modeOf(ok.dir), 0o700, 'the staging directory is owner-only')
    const archive = writeArchive(ok.archivePath, Buffer.from('bytes'), { stagingRoot: roots.staging })
    assert.equal(modeOf(archive), 0o600)
    const extracted = extractInto({
      treePath: ok.treePath,
      stagingRoot: roots.staging,
      bytes: packTarGz([{ name: 'x/y.txt', content: 'hej' }]),
    })
    assert.equal(fs.readFileSync(path.join(extracted.treePath, 'x', 'y.txt'), 'utf8'), 'hej')

    assert.equal(capture(() => discardStaging({ stateRoot: dir, dir: path.join(dir, '..') })).code, CODES.stagingEscape)
    assert.ok(fs.existsSync(dir))
  } finally {
    removeDir(dir)
  }
})

test('the write guards themselves: isWithin / resolveWithin / removeTreeWithin', () => {
  const dir = tempDir(`${TMP_PREFIX}guards-`)
  try {
    assert.equal(isWithin(dir, path.join(dir, 'a', 'b')), true)
    assert.equal(isWithin(dir, path.join(dir, 'a', '..', '..', 'b')), false)
    assert.equal(isWithin(dir, dir), true)
    assert.equal(isWithin(dir, dir + 'd'), false, 'a string prefix of the root is not inside it')
    assert.equal(capture(() => resolveWithin(dir, '/etc/passwd')).code, CODES.stagingEscape)

    ensurePrivateDir(dir)
    const file = path.join(dir, 'state.json')
    writePrivateFile(file, '{}')
    assert.equal(capture(() => removeTreeWithin(dir, '/')).code, CODES.stagingEscape)
    assert.ok(fs.existsSync(file), 'a refused removal removes nothing')
    removeTreeWithin(dir, file)
    assert.ok(!fs.existsSync(file))
  } finally {
    removeDir(dir)
  }
})

test('a mode that does not stick is a failed write, not a warning', () => {
  const dir = tempDir(`${TMP_PREFIX}mode-`)
  try {
    const file = path.join(dir, 'x.json')
    fs.writeFileSync(file, '{}', { mode: 0o644 })
    assert.equal(modeOf(file), 0o644, 'the fixture really starts world-readable')
    // The injected read-back stands in for the odd volume this check exists for:
    // chmod answers success and the mode stays loose.
    assert.throws(
      () => tightenMode(file, 0o600, 'file', { statMode: () => 0o644 }),
      (error) => error.code === CODES.stateWriteUnverified && /is still 644/.test(error.message),
    )
    assert.throws(
      () => writePrivateFile(path.join(dir, 'y.json'), '{}', { statMode: () => 0o644 }),
      (error) => error.code === CODES.stateWriteUnverified,
    )
    assert.ok(!fs.existsSync(path.join(dir, 'y.json.tmp-0')), 'the half-written temp file is cleaned up')
    // The real path: the mode lands and is verified off disk.
    assert.equal(tightenMode(file, 0o600, 'file'), 0o600)
    assert.equal(modeOf(file), 0o600)
  } finally {
    removeDir(dir)
  }
})

function capture(fn) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof UpdaterError, 'expected an UpdaterError, got ' + error)
    return error
  }
  throw new assert.AssertionError({ message: 'the call was expected to refuse, and it did not' })
}
