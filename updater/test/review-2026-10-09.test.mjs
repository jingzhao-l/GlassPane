/**
 * 2026-10-09 复审的九条发现，每条一个**能红**的形状。
 *
 * 这些用例的共同口径（也是这轮复审的判据）：一道可以被跳过的校验，或者一道证明的
 * 不是它将要安装的那份字节的校验，就不算闸。所以下面每一条都问同一类问题——把修复
 * 撤掉之后，这条红不红？注释里逐条写了 REVERSE MUTATION。
 *
 * 夹具按本仓规矩：真 gpg（有就跑真的，没有就断言"没有"本身，不静默跳过）、真
 * tar.gz 字节、真进程、真 SIGKILL、真文件模式。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  classifySignature,
  colonFingerprints,
  loadTrustAnchor,
  normalizePinnedFingerprint,
  PINNED_PRIMARY_FINGERPRINT,
  TRUST_ANCHOR_EXPORTS,
  authorshipNote,
  verifyReleaseSignature,
} from '../lib/signature.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError, writableRoots } from '../lib/fsutil.js'
import { defaultCopy, manifestTree, verifyStagedBytes } from '../lib/apply.js'
import { ARCHIVE_FILE_NAME, extractInto, prepareStaging, writeArchive } from '../lib/staging.js'
import { localVersion, readDaemonVersion } from '../lib/version.js'
import { MAX_DECOMPRESSED_BYTES, extractTarGz, packTarGz, readTarGz, stagedMode } from '../lib/tar.js'
import { AGENT_LABEL, registerAgent, renderAgentPlist } from '../lib/launchd.js'
import { assertRedirectTarget, makeBytesFetcher } from '../lib/source.js'
import { parseArgs } from '../cli.js'
import { buildRelease, makeDaemonBinary, makeFakeApp, removeDir, tempDir, TMP_PREFIX } from './helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPDATER_ROOT = path.resolve(HERE, '..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A 40-hex fingerprint that is not the pinned one — the throwaway-key shape. */
const THROWAWAY_FPR = 'AAAAAAAA3BBB2222CCCC3333DDDD4444EEEE5555'

/* ===================================================================== * finding 1 */

/**
 * REVERSE MUTATION: drop the pin out of `classifySignature` (compare
 * `VALIDSIG` against whatever the imported keyring says, the old rule) — this goes red
 * as `verified`, which is the whole bug: the key that authenticates release N+1 was
 * delivered inside release N's archive, so a waved-through release can replace it and
 * every later attacker release reads `verified`.
 */
test('一条别的钥匙做出的签名：invalid，不是 verified', () => {
  const v = classifySignature({
    version: '9.9.9',
    sumsName: 'SHA256SUMS-9.9.9.txt',
    signatureAsset: { name: 'SHA256SUMS-9.9.9.txt.asc', url: 'https://api.github.com/asset/x' },
    toolAvailable: true,
    anchorAvailable: true,
    keyFingerprints: [THROWAWAY_FPR],
    run: { status: 0, stdout: `[GNUPG:] VALIDSIG ${THROWAWAY_FPR} 1790502228 0\n`, stderr: 'gpg: Good signature from "attacker"' },
    tagVerdict: { status: 'verified' },
  })
  assert.equal(v.outcome, 'invalid', '钥匙环里那把不是 pin 的钥匙签得再"正确"也不是作者身份')
  assert.equal(v.code, CODES.signatureInvalid, '必须是那个 consent 越不过去的码')
  assert.match(v.message, new RegExp(PINNED_PRIMARY_FINGERPRINT), '句子要把期望的 pin 说出口')
  assert.match(v.message, /no consent can override/)
  assert.equal(v.keyFingerprint, null, '没证实的东西不许写进状态文件')
})

/**
 * The other half of the same gate, and the half the old code could not express: the
 * imported *anchor* is what has to match the pin, before any signature is believed.
 */
test('anchor 导进来的那把钥匙不是 pin 时，签名再"好"也判 invalid', () => {
  const v = classifySignature({
    version: '9.9.9',
    signatureAsset: { name: 'SHA256SUMS-9.9.9.txt.asc' },
    keyFingerprints: [THROWAWAY_FPR],
    run: { status: 0, stdout: `[GNUPG:] VALIDSIG ${THROWAWAY_FPR} 1790502228 0\n`, stderr: '' },
  })
  assert.equal(v.outcome, 'invalid')
  assert.match(v.message, /arrives inside the release archive/, '要说清为什么这把钥匙不能自己证明自己：它就是那份归档送来的')
})

/**
 * An override nobody refuses is how this class of fix becomes paper: a caller that can
 * pass "no pin" would put the hole back with one keyword argument. So a non-fingerprint
 * is not a loosening, it is a refusal.
 */
test('把 pin 覆盖成空值/垃圾值不等于关掉这道闸', () => {
  const base = {
    version: '9.9.9',
    signatureAsset: { name: 'SHA256SUMS-9.9.9.txt.asc' },
    keyFingerprints: [THROWAWAY_FPR],
    run: { status: 0, stdout: `[GNUPG:] VALIDSIG ${THROWAWAY_FPR} 1790502228 0\n`, stderr: '' },
  }
  for (const pin of ['', null, undefined, 'not-a-fingerprint', THROWAWAY_FPR.toLowerCase().slice(0, 32)]) {
    const v = classifySignature({ ...base, pinnedFingerprint: pin })
    assert.equal(v.outcome, 'invalid', `pin=${JSON.stringify(pin)} 不许被读成"没有 pin 这回事"`)
    assert.equal(v.code, CODES.signatureInvalid)
  }
  assert.equal(normalizePinnedFingerprint(`  ${THROWAWAY_FPR.toLowerCase()}  `), THROWAWAY_FPR, '同形的大小写/空白是允许的，那不影响判断')
})

/**
 * REVERSE MUTATION: change `PINNED_PRIMARY_FINGERPRINT` to any other 40 hex — red.
 * The value is *derived here*, from the armored block the installer really exports,
 * not copied from a comment.
 */
test('pinned 常量等于 installer 真正导出的那把钥匙的主指纹（gpg 现场解出来）', async () => {
  const anchor = await loadTrustAnchor()
  assert.equal(anchor.ok, true, anchor.reason)
  const probe = spawnSync('gpg', ['--version'], { encoding: 'utf8', timeout: 15_000 })
  if (probe.status !== 0) {
    // No gpg here: the absence is the asserted fact, and it is asserted through the
    // real binary rather than a flag. This branch exists so the test cannot pass by
    // skipping; on this machine (gnupg at /opt/homebrew/bin/gpg) the branch below runs.
    assert.equal(colonFingerprints('').length, 0, '没有 gpg 时这一条只能问"有没有 gpg"')
    assert.match(PINNED_PRIMARY_FINGERPRINT, /^[0-9A-F]{40}$/, '即使解不了，形状也得是一个 V4 主指纹')
    assert.equal(normalizePinnedFingerprint(PINNED_PRIMARY_FINGERPRINT), PINNED_PRIMARY_FINGERPRINT)
    return
  }
  const home = fs.mkdtempSync(`${TMP_PREFIX}pin-anchor-`)
  try {
    const keyPath = path.join(home, 'anchor.asc')
    fs.writeFileSync(keyPath, anchor.publicKey, { mode: 0o600 })
    const imp = spawnSync('gpg', ['--homedir', home, '--batch', '--yes', '--import', keyPath], { encoding: 'utf8', env: { ...process.env, GNUPGHOME: home, LC_ALL: 'C' } })
    assert.equal(imp.status, 0, `真 gpg 拒绝导入装机公钥：${imp.stderr}`)
    const listed = spawnSync('gpg', ['--homedir', home, '--batch', '--with-colons', '--list-keys'], { encoding: 'utf8', env: { ...process.env, GNUPGHOME: home, LC_ALL: 'C' } })
    assert.equal(listed.status, 0, listed.stderr)
    const fingerprints = colonFingerprints(listed.stdout)
    assert.ok(fingerprints.length >= 1, '钥匙环解不出任何指纹')
    assert.ok(fingerprints.includes(PINNED_PRIMARY_FINGERPRINT),
      `installer/cli.js 导出的 armored key 报的是 ${fingerprints.join(', ')}，而 pin 写的是 ${PINNED_PRIMARY_FINGERPRINT}：两者必须一致`)
    assert.ok(fingerprints.includes(normalizePinnedFingerprint(PINNED_PRIMARY_FINGERPRINT)))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/**
 * Production reaches the pinned default. Two halves, because one of them alone is a
 * decoration: no call site may pass an override (a scan of the shipped code says so),
 * and driving the *real* binary with a *real* throwaway key against the default pin
 * refuses (the same bytes accepted the moment the pin is named as that key).
 */
test('生产路径用的就是默认 pin：调用点不覆盖，真 gpg 真签名走过去就是 invalid', async (t) => {
  const offenders = []
  for (const rel of ['cli.js', 'agent-entry.js', ...fs.readdirSync(path.join(UPDATER_ROOT, 'lib')).filter((n) => n.endsWith('.js')).map((n) => `lib/${n}`)]) {
    const text = fs.readFileSync(path.join(UPDATER_ROOT, rel), 'utf8')
    if (rel === 'lib/signature.js') {
      const defaults = (text.match(/pinnedFingerprint = PINNED_PRIMARY_FINGERPRINT/g) ?? []).length
      assert.ok(defaults >= 2, `classifySignature 与 verifyReleaseSignature 的默认值不见了（找到 ${defaults} 处）：pin 又变成调用点说了算`)
      continue
    }
    if (/\bpinnedFingerprint\b/.test(text)) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], '有非测试调用点在传 pinnedFingerprint：那等于把 pin 交回给跑这段代码的人选')

  const probe = spawnSync('gpg', ['--version'], { encoding: 'utf8', timeout: 15_000 })
  if (probe.status !== 0) return t.diagnostic('这台机器没有 gpg；上面那半（调用点扫描）仍然跑了，下面这半需要真二进制')
  const home = fs.mkdtempSync(`${TMP_PREFIX}pin-throwaway-`)
  const stateRoot = tempDir(`${TMP_PREFIX}pin-e2e-`)
  try {
    const env = { ...process.env, GNUPGHOME: home, LC_ALL: 'C' }
    const gen = spawnSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-gen-key',
      'GlassPane Throwaway <t@example.test>', 'rsa2048', 'sign', 'never'], { encoding: 'utf8', env, timeout: 120_000 })
    assert.equal(gen.status, 0, `throwaway 钥匙生成失败：${gen.stderr}`)
    const listed = spawnSync('gpg', ['--batch', '--with-colons', '--list-keys'], { encoding: 'utf8', env })
    const throwaway = colonFingerprints(listed.stdout)[0]
    assert.ok(throwaway, '解不出 throwaway 钥匙的指纹')
    assert.notEqual(throwaway, PINNED_PRIMARY_FINGERPRINT, '夹具自己就得是一把别的钥匙')
    const armor = spawnSync('gpg', ['--armor', '--export'], { encoding: 'utf8', env })
    assert.match(armor.stdout, /-----BEGIN PGP PUBLIC KEY BLOCK-----/)

    const sumsName = 'SHA256SUMS-9.9.9.txt'
    const sumsText = `${'b'.repeat(64)}  GlassPane-9.9.9.tar.gz\n`
    const sumsPath = path.join(home, sumsName)
    fs.writeFileSync(sumsPath, sumsText)
    const ascPath = path.join(home, `${sumsName}.asc`)
    const sign = spawnSync('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', '',
      '--local-user', throwaway, '--detach-sign', '--armor', '--output', ascPath, sumsPath], { encoding: 'utf8', env })
    assert.equal(sign.status, 0, `签名失败：${sign.stderr}`)
    const signatureBytes = fs.readFileSync(ascPath)

    const installer = await import('../../installer/cli.js')
    const fakeAnchor = {
      ok: true,
      publicKey: armor.stdout,
      classifyTagVerify: installer[TRUST_ANCHOR_EXPORTS.classify],
      source: 'test throwaway keyring',
    }
    const args = {
      version: '9.9.9',
      sumsName,
      sumsText,
      signatureAsset: { name: `${sumsName}.asc`, url: 'https://api.github.com/asset/x' },
      stateRoot,
      fetchBytes: async () => signatureBytes,
      loadAnchor: async () => fakeAnchor,
    }
    // The same real bytes, the same real keyring, the only difference being the pin.
    const production = await verifyReleaseSignature(args)
    assert.equal(production.outcome, 'invalid', `一条真 throwaway 钥匙的真签名，在生产默认 pin 下读成了 ${production.outcome}`)
    assert.equal(production.code, CODES.signatureInvalid)
    assert.match(production.message, new RegExp(PINNED_PRIMARY_FINGERPRINT))
    const note = authorshipNote({ version: '9.9.9', signature: production.outcome, signedAsset: `${sumsName}.asc` }, 'applied')
    assert.ok(note, 'invalid 之后长驻警告必须还在——这条发现的后果就是它会静静消失')
    assert.equal(note.code, CODES.signatureInvalid)

    const withItsOwnPin = await verifyReleaseSignature({ ...args, pinnedFingerprint: throwaway })
    assert.equal(withItsOwnPin.outcome, 'verified', `pin 换成这把钥匙自己之后还拒绝，说明拒绝的不是 pin 而是别的东西（夹具废了）：${withItsOwnPin.message}`)
    assert.equal(withItsOwnPin.keyFingerprint, throwaway)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    removeDir(stateRoot)
  }
})

/* ===================================================================== * finding 2 */

/** A staged release on disk: archive bytes, extracted tree, and the state's `staged` row. */
function stagePair({ version = '9.9.9', treeFrom = 'evil' } = {}) {
  const stateRoot = tempDir(`${TMP_PREFIX}review-stage-`)
  const roots = writableRoots(stateRoot)
  const staged = prepareStaging({ stateRoot, version })
  const treeFiles = [{ name: `GlassPane-${version}/package.json`, content: JSON.stringify({ version }) }]
  const good = buildRelease({ version, treeFiles })
  const evil = buildRelease({
    version,
    treeFiles: [{ name: `GlassPane-${version}/package.json`, content: JSON.stringify({ version, planted: true }) }],
  })
  writeArchive(staged.archivePath, good.tarball, { stagingRoot: roots.staging })
  const extracted = extractInto({ treePath: staged.treePath, stagingRoot: roots.staging, bytes: treeFrom === 'good' ? good.tarball : evil.tarball })
  const rootPath = path.join(extracted.treePath, `GlassPane-${version}`)
  return {
    stateRoot,
    staged: { dir: staged.dir, version, digest: good.digest, rootPath },
    archivePath: staged.archivePath,
    rootPath,
    good,
    evil,
    cleanup: () => removeDir(stateRoot),
  }
}

/**
 * REVERSE MUTATION: put the second `readArchive(archivePath)` back next to
 * `hashFile(archivePath)` — the proof succeeds on bytes it then does not install, and
 * this reads the archive twice instead of once.
 */
test('归档只读一次：两次读出不同字节时，被证明的必须正是被解出来的那一份', async () => {
  const f = stagePair()
  const reads = []
  try {
    const out = await verifyStagedBytes({
      stateRoot: f.stateRoot,
      staged: f.staged,
      rootPath: f.rootPath,
      readArchive: (file) => {
        reads.push(file)
        // 第一读给签名过的字节，第二读给攻击者的字节——旧代码正是这两次读之间的替换窗口。
        return reads.length === 1 ? f.good.tarball : f.evil.tarball
      },
    })
    assert.equal(reads.length, 1, `归档被读了 ${reads.length} 次：两次读之间就是同账户写手的替换窗口`)
    assert.equal(out.ok, false, '攻击者的树不能因为"第二次读到的字节和它一致"就被证明')
    assert.match(out.reason, /does not match the tree inside the archive/, out.reason)
    assert.ok(out.details?.differences?.some((d) => d.includes('package.json')), `拒绝要点名相对路径：${JSON.stringify(out.details)}`)
  } finally {
    f.cleanup()
  }
})

/**
 * The second half of the finding: proof and build must read the *same* tree. Here the
 * on-disk tree is byte-identical to the archive (so the proof passes), and the marker
 * is the tree's own mtime — after a successful proof the file at `rootPath` has to be
 * one this call just wrote, because that is the tree `swift build` is handed.
 *
 * REVERSE MUTATION: keep the compare and then build the pre-existing tree — the planted
 * 2020 mtime is still there, and this is red.
 */
test('证明通过之后交给构建树，是这一次刚从被证明的字节里解出来的那一份', async () => {
  const f = stagePair({ treeFrom: 'good' })
  const plantedMs = Date.parse('2020-01-01T00:00:00.000Z')
  try {
    const file = path.join(f.rootPath, 'package.json')
    fs.utimesSync(file, new Date(plantedMs), new Date(plantedMs))
    const out = await verifyStagedBytes({ stateRoot: f.stateRoot, staged: f.staged, rootPath: f.rootPath })
    assert.equal(out.ok, true, out.reason)
    assert.equal(out.rootPath, f.rootPath, '返回的就是下游继续用的那个路径')
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ version: '9.9.9' }), '内容当然还得是发布里的内容')
    assert.ok(fs.statSync(file).mtimeMs > plantedMs + 86_400_000,
      '这棵树的字节是这一次解出来的（mtime 被换掉了），不是"check 之后一直躺在那儿的那一份"')
    const leftovers = fs.readdirSync(f.staged.dir).filter((n) => n.includes('apply-verify-'))
    assert.deepEqual(leftovers, [], `临时解包目录不许留在暂存目录里：${leftovers}`)
  } finally {
    f.cleanup()
  }
})

/* ===================================================================== * finding 3 */

/**
 * REVERSE MUTATION: `rmSync(target)` + `cpSync` again — by the time the copy throws the
 * installed bundle is already gone, and both assertions below are red.
 */
test('一份中途失败的 bundle 拷贝之后，目标里还是原来的完整字节', () => {
  const dir = tempDir(`${TMP_PREFIX}review-copy-`)
  try {
    const appsDir = path.join(dir, 'Applications')
    const target = path.join(appsDir, 'GlassPane.app')
    fs.mkdirSync(path.join(target, 'Contents', 'MacOS'), { recursive: true })
    fs.writeFileSync(path.join(target, 'Contents', 'MacOS', 'binary'), 'installed bytes')

    const built = path.join(dir, 'built', 'GlassPane.app')
    fs.mkdirSync(path.join(built, 'Contents', 'MacOS'), { recursive: true })
    fs.writeFileSync(path.join(built, 'Contents', 'a_first.txt'), 'first new byte')
    fs.writeFileSync(path.join(built, 'Contents', 'b_second.txt'), 'second new byte')
    fs.writeFileSync(path.join(built, 'Contents', 'MacOS', 'binary'), 'NEW binary')
    // The copy fails *after* it has started: an entry the reader cannot open, which is
    // what "killed in the middle" looks like from the copier's side without a signal.
    const blocker = path.join(built, 'Contents', 'c_locked.txt')
    fs.writeFileSync(blocker, 'x')
    fs.chmodSync(blocker, 0o000)

    assert.throws(() => defaultCopy(built, target), /EACCES|ENOENT|EPERM/)

    assert.equal(fs.readFileSync(path.join(target, 'Contents', 'MacOS', 'binary'), 'utf8'), 'installed bytes',
      '拷贝失败之后，装着的那一份必须一个字节都没变')
    const strays = fs.readdirSync(appsDir).filter((n) => /GlassPane\.app\.(new|old)-/.test(n))
    assert.deepEqual(strays, [], `半份拷贝不许留在 ~/Applications 里让人去点：${strays}`)
  } finally {
    fs.chmodSync(path.join(dir, 'built', 'GlassPane.app', 'Contents', 'c_locked.txt'), 0o600)
    removeDir(dir)
  }
})

/**
 * A real kill, not a thrown error: a child process is SIGKILLed while copying, and the
 * target is read back. Either the complete old bundle or the complete new one — never a
 * half, because the new tree only ever arrives by rename.
 *
 * REVERSE MUTATION: the old `rmSync`-then-`cpSync` leaves the name missing or partially
 * filled for the whole length of the copy; the kill lands in that window (the test waits
 * for the target to disappear) and the read-back is red.
 */
test('真把拷贝进程 SIGKILL 掉，目标要么完整旧要么完整新，绝不会是半份', async (t) => {
  const dir = tempDir(`${TMP_PREFIX}review-kill-`)
  const appsDir = path.join(dir, 'Applications')
  const target = path.join(appsDir, 'GlassPane.app')
  const built = path.join(dir, 'built', 'GlassPane.app')
  const modulePath = path.join(UPDATER_ROOT, 'lib', 'apply.js')
  let child = null
  try {
    fs.mkdirSync(path.join(target, 'Contents', 'MacOS'), { recursive: true })
    for (let i = 0; i < 40; i += 1) fs.writeFileSync(path.join(target, 'Contents', `old-${i}.txt`), `old ${i}`)
    fs.writeFileSync(path.join(target, 'Contents', 'MacOS', 'binary'), 'installed bytes')
    const oldManifest = manifestTree(target)

    fs.mkdirSync(path.join(built, 'Contents', 'MacOS'), { recursive: true })
    const chunk = Buffer.alloc(128 * 1024, 7)
    for (let i = 0; i < 150; i += 1) fs.writeFileSync(path.join(built, 'Contents', `new-${i}.bin`), chunk)
    fs.writeFileSync(path.join(built, 'Contents', 'MacOS', 'binary'), 'NEW binary')
    const newManifest = manifestTree(built)

    child = spawn(process.execPath, ['-e', `
      const [mod, src, dst] = process.argv.slice(1)
      import('file://' + mod).then((m) => { m.defaultCopy(src, dst); process.stdout.write('copied\\n') })
    `, modulePath, built, target], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderrTail = ''
    child.stderr.on('data', (b) => { stderrTail = `${stderrTail}${b}`.slice(-400) })

    const deadline = Date.now() + 20_000
    let observed = null
    while (Date.now() < deadline && observed === null) {
      const entries = fs.existsSync(appsDir) ? fs.readdirSync(appsDir) : []
      if (entries.some((n) => /GlassPane\.app\.new-/.test(n))) observed = 'staged copy'
      else if (!fs.existsSync(target)) observed = 'target removed'
      else if (child.exitCode !== null) observed = 'child finished'
      else await sleep(2)
    }
    if (observed === 'child finished') {
      // Copied before we could interfere: nothing to assert about a window this machine
      // was too fast for. Say so, because a silent pass here would be a fake control.
      return t.diagnostic(`拷贝在我们看到 ${observed} 之前就完成了（${stderrTail}）`)
    }
    t.diagnostic(`kill 看到的现场：${observed}`)
    child.kill('SIGKILL')
    // 'close', not 'exit': until the pid is reaped it is still a zombie, and a zombie
    // answers  with 'alive' — which is exactly what the sweep in
    //  reads to decide that a  sibling is somebody's garbage.
    await new Promise((resolve) => child.once('close', resolve))

    assert.ok(fs.existsSync(target), `${target} 在拷贝被打断之后不见了：状态文件还会说旧版本装着`)
    const landed = manifestTree(target)
    const isOld = JSON.stringify(landed) === JSON.stringify(oldManifest)
    const isNew = JSON.stringify(landed) === JSON.stringify(newManifest)
    assert.ok(isOld || isNew, `目标是一半：${landed && Object.keys(landed).length} 个条目，既不是完整旧的一份也不是完整新的一份`)

    // And the stale in-flight copy a killed run leaves behind is not permanent junk:
    // the next copy sweeps it (pid no longer alive) and lands cleanly.
    if (!isNew) {
      defaultCopy(built, target)
      assert.equal(JSON.stringify(manifestTree(target)), JSON.stringify(newManifest), '重跑一次要能把东西装完')
      const strays = fs.readdirSync(appsDir).filter((n) => /GlassPane\.app\.(new|old)-/.test(n))
      assert.deepEqual(strays, [], `上一次被杀掉的半份必须被扫掉：${strays}`)
    }
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    removeDir(dir)
  }
})

/* ===================================================================== * finding 4 */

/**
 * The literal scan in `test/remedy-surface.test.mjs` is the gate; this is the half that
 * says what the replacement has to *do*: name the exact path, and say a person runs it.
 * REVERSE MUTATION: restore `sudo chown -R "$(whoami)" <dir>` — red on both.
 */
test('npm-prefix 那条 remedy 点名路径、交给一个人，且不交出任何命令行', () => {
  const raw = fs.readFileSync(path.join(UPDATER_ROOT, 'lib', 'apply.js'), 'utf8')
  const from = raw.indexOf('const unwritableDirs')
  assert.ok(from > 0, 'apply.js 里找不到那条点名目录的 remedy 了')
  const block = raw.slice(from, from + 1600)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.match(block, /at a terminal/, '要写清这一步只能由一个人在终端做')
  assert.match(block, /will not run a privileged command/, '也要写清这个程序自己不跑，更不会把命令交给 agent')
  assert.match(block, /JSON\.stringify/, '路径要 JSON 引起来，读者才知道路径在哪一行结束')
  assert.match(block, /npm config get prefix/, '要交代路径是从 npm 读来的，人才会去核')
  assert.doesNotMatch(block, /\bsudo\b/, '这段里不许出现任何一句可执行的升权命令')
})

/* ===================================================================== * finding 5 */

/**
 * REVERSE MUTATION: drop the `ok`/exit-0 condition and the anchor — the banner below is
 * read as "this machine runs 1.9.0", which then becomes the baseline of the
 * newer/downgrade decision and (with a 1.4.0 bundle) a `version-mismatch-local` refusal
 * about a healthy install.
 */
test('exit 64 的 usage 横幅里写着 1.9.0，也不许被读成本机装的版本', () => {
  const dir = tempDir(`${TMP_PREFIX}review-ver-`)
  try {
    const banner = path.join(dir, 'glasspaned')
    fs.writeFileSync(banner, '#!/bin/sh\n'
      + 'if [ "$1" = "--version" ]; then\n'
      + '  echo "glasspaned: unknown argument: --version"\n'
      + '  echo "usage: glasspaned (built 1.9.0, flags since 1.9.0)"\n'
      + '  exit 64\n'
      + 'fi\n'
      + 'echo "glasspaned: unknown argument: $1" >&2\n'
      + 'exit 64\n')
    fs.chmodSync(banner, 0o755)
    assert.equal(readDaemonVersion(banner), null, '退出码 64 的答案里没有任何版本读数')

    const appsDir = path.join(dir, 'Applications')
    makeFakeApp(appsDir, 'GlassPane.app', '1.4.0')
    makeFakeApp(appsDir, 'GlassPane Daemon.app', '1.4.0')
    const verdict = localVersion({
      appsDir,
      daemonExecutable: banner,
      settingsAppName: 'GlassPane.app',
      daemonAppName: 'GlassPane Daemon.app',
    })
    assert.equal(verdict.ok, true, verdict.message)
    assert.equal(verdict.version, '1.4.0', '基线只能来自真读得出来的那一份')
    assert.equal(verdict.seen.daemonBinary, null)

    // And a binary that really answers still reads: the gate is not "refuse everything".
    const exe = makeDaemonBinary(appsDir, '1.9.0')
    assert.equal(readDaemonVersion(exe), '1.9.0')
    // Only the exact line the binary prints counts (`main.swift` → `glasspaned <v>`).
    const chatty = path.join(dir, 'chatty')
    fs.writeFileSync(chatty, '#!/bin/sh\necho "checking 1.9.0 against the registry"\necho "glasspaned 2.3.4 listening"\n')
    fs.chmodSync(chatty, 0o755)
    assert.equal(readDaemonVersion(chatty), '2.3.4', '行首那一句才算，日志里的第一行不算')
  } finally {
    removeDir(dir)
  }
})

/* ===================================================================== * finding 6 */

/**
 * REVERSE MUTATION: delete the range check in `parseArgs` and the one in
 * `renderAgentPlist` — `--hour 25` renders a plist whose job never fires while the state
 * file says automatic updates are on, and `readAgentSchedule` refuses to read it back.
 */
test('enable --hour 25 在写路径上就被拒绝，23:59 通过', () => {
  assert.equal(parseArgs(['enable', '--hour', '23', '--minute', '59']).ok, true)
  assert.equal(parseArgs(['enable', '--hour', '0', '--minute', '0']).ok, true)
  for (const bad of [['--hour', '24'], ['--hour', '25'], ['--hour', '-1'], ['--hour', 'abc'], ['--hour', '12.5'], ['--minute', '60'], ['--minute', '-5']]) {
    const parsed = parseArgs(['enable', ...bad])
    assert.equal(parsed.ok, false, `${bad.join(' ')} 被接下了`)
    assert.match(parsed.reason, /0 to /, `拒绝要给出范围：${parsed.reason}`)
    assert.match(parsed.reason, /never fires|not a time/, `要说得出不接受的后果：${parsed.reason}`)
  }
  assert.throws(() => renderAgentPlist({ cliPath: '/x/cli.js', stateRoot: '/state', hour: 25 }), (error) => {
    assert.ok(error instanceof UpdaterError)
    assert.equal(error.code, CODES.agentPathUnsafe)
    assert.match(error.message, /never fires/, error.message)
    return true
  }, '渲染器自己也要顶得住：不是只有 CLI 解析器会传时刻进来')
  assert.doesNotThrow(() => renderAgentPlist({ cliPath: '/x/cli.js', stateRoot: '/state', hour: '3', minute: '45' }))
})

/* ===================================================================== * finding 7 */

/**
 * REVERSE MUTATION: `arg.includes(String(cliPath))` again — the decoy below contains the
 * path, so registration reports `verified` while launchd holds something else, and
 * `runtime.js`'s reader of the same argument list says the opposite.
 */
test('只是"包含" cliPath 的参数列表不算注册成功，两个读数从此同口径', () => {
  const dir = tempDir(`${TMP_PREFIX}review-agent-`)
  const cliPath = '/Users/dev/.glasspane/runtime/agent-entry.js'
  const plistPath = path.join(dir, `${AGENT_LABEL}.plist`)
  fs.mkdirSync(dir, { recursive: true })
  try {
    const printed = (arg) => [
      `gui/501/${AGENT_LABEL} = {`,
      '\tstate = not running',
      '\targuments = {',
      '\t\t/bin/sh',
      '\t\t-c',
      `\t\t"${cliPath}" --json`,
      `\t\t${arg}`,
      '\t}',
      '}',
    ].join('\n')
    const outcome = registerAgent({
      label: AGENT_LABEL,
      plistPath,
      plistText: '<plist>rendered</plist>',
      cliPath,
      uid: '501',
      run: (bin, args) => ({ status: 0, stdout: args[0] === 'print' ? printed(`/tmp/dropin${cliPath}`) : '', stderr: '' }),
      writeFile: () => undefined,
    })
    assert.equal(outcome.ok, false, '一份写着别人路径的作业不许被读成"注册好了"')
    assert.match(outcome.message, /was not replaced/, outcome.message)
    assert.match(outcome.message, /dropin/, '句子里要看得见读回来的那个参数')

    const exact = registerAgent({
      label: AGENT_LABEL,
      plistPath,
      plistText: '<plist>rendered</plist>',
      cliPath,
      uid: '501',
      run: (bin, args) => ({ status: 0, stdout: args[0] === 'print' ? printed(cliPath) : '', stderr: '' }),
      writeFile: () => undefined,
    })
    assert.equal(exact.ok, true, exact.message)
    assert.equal(exact.verified, true, '精确命中的那一份仍然是注册成功——闸不是无条件拒绝')
  } finally {
    removeDir(dir)
  }
})

/* ===================================================================== * finding 8 */

/**
 * REVERSE MUTATION: `zlib.gunzipSync(buffer)` with no `maxOutputLength` — the stream
 * inflates until the process is out of memory, and the refusal below never happens.
 */
test('超过上限的 gzip 要按名字拒绝，而不是把内存要光', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 3))
  const dir = tempDir(`${TMP_PREFIX}review-bomb-`)
  try {
    assert.throws(() => extractTarGz(bomb, dir, { allowedRoot: dir, maxOutputLength: 256 * 1024 }), (error) => {
      assert.ok(error instanceof UpdaterError, `不是 UpdaterError：${error}`)
      assert.equal(error.code, CODES.archiveUnreadable)
      assert.match(error.message, /compression bomb/, error.message)
      assert.match(error.message, /MiB/, `拒绝要报出上限：${error.message}`)
      assert.equal(fs.readdirSync(dir).length, 0, '拒绝之后暂存目录里不该有半棵树')
      return true
    })
    // A normal archive still unpacks, so this is not an unconditional refusal.
    const small = packTarGz([{ name: 'GlassPane-9.9.9/package.json', content: '{"version":"9.9.9"}' }])
    assert.equal(extractTarGz(small, dir, { allowedRoot: dir }).entries.length, 1)
  } finally {
    removeDir(dir)
  }
  // Production reaches the documented default: nothing in the shipped code overrides it.
  assert.ok(MAX_DECOMPRESSED_BYTES >= 4 * 256 * 1024 * 1024, '上限必须与 256 MiB 的压缩上限同量级')
  const readers = ['lib/tar.js', 'lib/staging.js', 'lib/apply.js', 'lib/check.js']
  for (const rel of readers) {
    const text = fs.readFileSync(path.join(UPDATER_ROOT, rel), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    const passed = [...text.matchAll(/(?:readTarGz|extractTarGz)\([^)]*maxOutputLength:\s*(\w+)/g)].map((m) => m[1])
    assert.deepEqual(passed.filter((v) => v !== 'MAX_DECOMPRESSED_BYTES'), [], `${rel} 里有生产调用点在覆盖解压上限`)
  }
  assert.match(fs.readFileSync(path.join(UPDATER_ROOT, 'lib', 'tar.js'), 'utf8'), /maxOutputLength = MAX_DECOMPRESSED_BYTES/)
  assert.match(readTarGz.toString(), /gunzipSync\(buffer, \{ maxOutputLength \}\)/, "gunzip 不再受上限约束了")
})

/**
 * REVERSE MUTATION: `(entry.mode || 0o644) & 0o777` — a 0666 member lands world-writable
 * and `apply` copies it into the runtime and into ~/Applications.
 */
test('归档里 0666/0777 的成员落地后，组与其他用户都不许能写', () => {
  const dir = tempDir(`${TMP_PREFIX}review-mode-`)
  const roots = writableRoots(dir)
  try {
    const staged = prepareStaging({ stateRoot: dir, version: '9.9.9' })
    const archive = packTarGz([
      { name: 'GlassPane-9.9.9/loose.txt', content: 'x', mode: 0o666 },
      { name: 'GlassPane-9.9.9/script.sh', content: '#!/bin/sh\n', mode: 0o777 },
      { name: 'GlassPane-9.9.9/world/', type: 'dir', mode: 0o777 },
      { name: 'GlassPane-9.9.9/plain.txt', content: 'y', mode: 0o644 },
    ])
    writeArchive(staged.archivePath, archive, { stagingRoot: roots.staging })
    const out = extractInto({ treePath: staged.treePath, stagingRoot: roots.staging, bytes: archive })
    const fileMode = (rel) => fs.statSync(path.join(out.treePath, rel)).mode & 0o777
    assert.equal(fileMode('GlassPane-9.9.9/loose.txt') & 0o022, 0, '0666 的成员不许原样落地')
    assert.equal(fileMode('GlassPane-9.9.9/script.sh') & 0o022, 0)
    assert.equal(fileMode('GlassPane-9.9.9/script.sh') & 0o100, 0o100, '属主的执行位是自己的，不该被削掉')
    assert.equal(fileMode('GlassPane-9.9.9/world') & 0o022, 0, '目录也一样')
    assert.equal(fileMode('GlassPane-9.9.9/plain.txt'), 0o644, '本来就合规的模式一个不改')
    assert.equal(stagedMode(0o666, 0o644), 0o644)
    assert.equal(stagedMode(0o4755, 0o644), 0o755, 'setuid 位同样进不来')
    assert.equal(stagedMode(0, 0o644), 0o644, '归档没声明模式时用调用方的默认，不是 000')
  } finally {
    removeDir(dir)
  }
})

/* ===================================================================== * finding 9 */

/**
 * REVERSE MUTATION: `if (text === '') return requested` — the host pin is skipped
 * exactly when the transport cannot say where the bytes came from.
 */
test('传输报不出最终 URL 时是拒绝，不是"当作没跳转"', async () => {
  const requested = 'https://codeload.github.com/jingzhao-l/GlassPane/tar.gz/v9.9.9'
  for (const empty of ['', '   ', null, undefined]) {
    assert.throws(() => assertRedirectTarget(empty, { requested }), (error) => {
      assert.ok(error instanceof UpdaterError)
      assert.equal(error.code, CODES.downloadHostUnpinned, `空 final URL 被放行了（${String(empty)}）`)
      assert.match(error.message, /no final URL|Refused rather than assumed/, error.message)
      return true
    })
  }
  assert.equal(assertRedirectTarget(requested, { requested }), requested)
  // The same fact through the real transport shape: an answer with no `url` at all.
  const fetchBytes = makeBytesFetcher(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]),
  }), { timeoutMs: 5_000 })
  await assert.rejects(() => fetchBytes(requested), (error) => {
    assert.equal(error.code, CODES.downloadHostUnpinned, '读不出的最终地址必须失败闭合')
    return true
  })
})
