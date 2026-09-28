/**
 * §1 gate 8: the four things that can be true about a release's authorship, and
 * the wiring that decides them.
 *
 * Doctrine this file is written under: the suite may not depend on a developer's
 * GnuPG. A machine with `gpg` and a machine without it must produce the same
 * verdicts *from the same tests*, so every state is reached through an injected
 * runner (`test/helpers.mjs:fakeGpg`), which is process selection only — the
 * argv, the file pairing and the exit codes are the real shapes
 * `lib/signature.js` reads its verdict out of. The last test here is the one
 * exception, and it is written so that both worlds assert something: where gpg
 * is missing it asserts exactly that absence produced `signature-tool-missing`
 * through the *real* runner, and where gpg is present it asserts that the real
 * binary + the real embedded key still refuse a signature that is not ours.
 * Neither branch can pass by skipping.
 *
 * REVERSE MUTATIONS reddened here:
 *   · `SIGNATURE_NAME` → `.sig`, or the workflow's `--detach-sign --armor` loop
 *     renamed: `the .asc name is the one release.yml actually produces` goes red
 *     (it re-derives the expectation from the workflow text, not from this file).
 *   · paste a second armored key into `updater/` (i.e. stop importing the
 *     installer's export): `the trust anchor is borrowed, never copied` goes red.
 *   · `classifySignature`'s "unknown outcome" branch, dropping the fingerprint
 *     comparison, or checking `status === 0` alone: the two foreign-key tests
 *     go red.
 *   · a `--verify` argument swap (signature file ↔ checksum file), or re-fetching
 *     the checksum bytes instead of verifying the ones the digest gate trusts:
 *     `gpg is handed the .asc and the very bytes the digest gate trusted` goes red.
 *   · letting gpg consult the developer's keyring: `the keyring is a throwaway
 *     inside the staging directory` goes red.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  INSTALLER_MODULE,
  OUTCOME_CODES,
  SIGNATURE_NAME,
  SIGNATURE_OUTCOMES,
  TRUST_ANCHOR_EXPORTS,
  authorshipNote,
  classifySignature,
  colonFingerprints,
  defaultRunGpg,
  loadTrustAnchor,
  statusLines,
  validSigFingerprint,
  verifyReleaseSignature,
} from '../lib/signature.js'
import { CODES } from '../lib/codes.js'
import { FAKE_SIGNER_FPR, FOREIGN_SIGNER_FPR, TMP_PREFIX, fakeGpg, removeDir, tempDir } from './helpers.mjs'

const VERSION = '1.4.1'
const SUMS_NAME = `SHA256SUMS-${VERSION}.txt`
const SIG_NAME = `${SUMS_NAME}.asc`
const SUMS_TEXT = `${'a'.repeat(64)}  GlassPane-${VERSION}.tar.gz\n`
const ASSET = { name: SIG_NAME, url: `https://api.github.com/asset/${SIG_NAME}` }
const KEY_FPRS = [FAKE_SIGNER_FPR]

/* ------------------------------------------------------------- the asset name */

test('the .asc name is the one release.yml actually produces, not one this file guessed', () => {
  const workflow = path.resolve(import.meta.dirname, '..', '..', '.github', 'workflows', 'release.yml')
  const text = fs.readFileSync(workflow, 'utf8')
  // The signing step loops over exactly the two artifacts, armored and detached, and
  // the upload step names the sidecar next to the file it signed. `gpg --detach-sign
  // --armor FILE` with no `--output` writes `FILE.asc`, which is where the name gate 8
  // looks for comes from. The upload used to collect whatever `.asc` happened to exist
  // (`ls *.asc`); signing is mandatory now, so the two names are pushed into an array
  // and expanded — a missing sidecar fails the run instead of quietly publishing a
  // release whose asset list reads "nobody signed this".
  const loop = /for f in "GlassPane-\$\{VERSION\}\.tar\.gz" "(SHA256SUMS-\$\{VERSION\}\.txt)"; do/.exec(text)
  assert.ok(loop, 'release.yml no longer signs the checksum file, so gate 8 has to be re-read against whatever it does instead')
  assert.equal(loop[1], 'SHA256SUMS-${VERSION}.txt', 'the file the workflow signs is no longer the checksum file this updater parses for a digest')
  assert.match(text, /--detach-sign --armor "\$f"/, 'the signature is no longer detached+armored, so the artifact is no longer named <file>.asc')
  assert.match(text, /\[ -s "\$\{f\}\.asc" \]/, 'the non-empty-sidecar check is gone: gpg can exit 0 without writing a signature, and that would read as signed')
  assert.match(text, /ASSETS\+=\("\$f" "\$\{f\}\.asc"\)/, 'the .asc is no longer uploaded alongside the file it signs, so gate 8 has nothing to verify')
  assert.match(text, /gh release upload "\$REF_NAME" "\$\{ASSETS\[@\]\}"/, 'the release upload no longer expands the signed asset set')
  assert.doesNotMatch(text, /if: \$\{\{ (steps|secrets)\.gpg-key|steps\.gpg-key\.outputs\.present/, 'signing became conditional again: a skipped sign step publishes checksums nobody signed')
  // `${VERSION}` there is the tag with its `v` removed, which is exactly what
  // `parseTag` hands this module, so the two names are the same string:
  assert.equal(SUMS_NAME, `SHA256SUMS-${VERSION}.txt`)
  assert.equal(SIGNATURE_NAME(VERSION), `${SUMS_NAME}.asc`)
  assert.equal(SIG_NAME, SIGNATURE_NAME(VERSION))
})

test('the four outcomes are a closed vocabulary, each with its own code', () => {
  assert.deepEqual(SIGNATURE_OUTCOMES, ['verified', 'invalid', 'unsigned-release', 'signature-tool-missing'])
  assert.equal(OUTCOME_CODES.verified, null, 'the good state refuses nothing, so it stamps no code')
  assert.equal(OUTCOME_CODES.invalid, CODES.signatureInvalid)
  assert.equal(OUTCOME_CODES['unsigned-release'], CODES.releaseUnsigned)
  assert.equal(OUTCOME_CODES['signature-tool-missing'], CODES.signatureToolMissing)
  // Every code in the table is a code the state file is allowed to carry.
  for (const code of Object.values(OUTCOME_CODES)) {
    if (code !== null) assert.ok(Object.values(CODES).includes(code), `${code} is not in codes.js`)
  }
})

/* ------------------------------------------------------------------ the states */

const verifiedRun = { outcome: 'verified', run: { status: 0, stdout: `[GNUPG:] VALIDSIG ${FAKE_SIGNER_FPR} 1790502228 0\n`, stderr: 'gpg: Good signature from "jingzhao-l (sign-github)"\n' } }

function classify(extra) {
  return classifySignature({
    version: VERSION,
    sumsName: SUMS_NAME,
    signatureAsset: ASSET,
    keyFingerprints: KEY_FPRS,
    toolAvailable: true,
    anchorAvailable: true,
    ...extra,
  })
}

test('verified: named key, named asset, no refusal of any kind', () => {
  const v = classify({ ...verifiedRun, tagVerdict: { status: 'verified', detail: 'ok' } })
  assert.equal(v.outcome, 'verified')
  assert.equal(v.code, null)
  assert.equal(v.signedAsset, SIG_NAME, 'the state file has to be able to say *what* was verified')
  assert.equal(v.keyFingerprint, FAKE_SIGNER_FPR, 'and *with which key*')
  assert.match(v.message, /verifies against the key this program ships/)
  assert.match(v.message, new RegExp(FAKE_SIGNER_FPR), 'the sentence names the fingerprint, so a reader can check it against the release page')
  assert.match(v.message, /all "verified" claims here and nothing more/, 'and says out loud that it is not a claim about the organisation')
})

test('an unknown signature word is never read as verified', () => {
  // The status-0-with-no-VALIDSIG arm: "gpg liked it but did not say who signed".
  const v = classify({ run: { status: 0, stdout: '[GNUPG:] GOODSIG 89D88B1D043A1298 4 2\n', stderr: '' }, tagVerdict: { status: 'verified' } })
  assert.equal(v.outcome, 'invalid', 'a good signature nobody can attribute is not authorship')
  assert.equal(v.code, CODES.signatureInvalid)
  assert.match(v.message, /without naming which key made it/)
})

test('invalid: a bad signature is a hard refusal, and the sentence says consent cannot help', () => {
  const v = classify({
    run: { status: 1, stdout: '[GNUPG:] BADSIG 4 2 1\n', stderr: 'gpg: BAD signature from "jingzhao-l (sign-github)"\n' },
    tagVerdict: { status: 'invalid', detail: 'whatever the installer says about git verify-tag' },
  })
  assert.equal(v.outcome, 'invalid')
  assert.equal(v.code, CODES.signatureInvalid)
  assert.match(v.message, /does not check against the key this program ships/)
  assert.match(v.message, /no consent can override/)
  assert.equal(v.keyFingerprint, null, 'nothing is attested here, so nothing gets recorded as a key')
})

test('invalid: a signature that is well formed under somebody else’s key', () => {
  const v = classify({
    run: { status: 0, stdout: `[GNUPG:] VALIDSIG ${FOREIGN_SIGNER_FPR} 1790502228 0\n`, stderr: 'gpg: Good signature from "somebody else"\n' },
    tagVerdict: { status: 'verified' },
  })
  assert.equal(v.outcome, 'invalid', 'exit 0 proves the signature is internally sound, not that it is *ours*')
  assert.match(v.message, new RegExp(`reads back under ${FOREIGN_SIGNER_FPR}`))
  assert.match(v.message, new RegExp(FAKE_SIGNER_FPR), 'the sentence names the key it expected')
})

test('unsigned-release: no .asc published is a different claim from a wrong one', () => {
  const v = classify({ signatureAsset: null, run: null, tagVerdict: null })
  assert.equal(v.outcome, 'unsigned-release')
  assert.equal(v.code, CODES.releaseUnsigned)
  assert.match(v.message, /publishes no SHA256SUMS-1\.4\.1\.txt\.asc/)
  assert.match(v.message, /not authorship/, 'it has to say plainly that the other gates do not answer this question')
  assert.match(v.message, /--consent unsigned-release/, 'and name the one action left for a human')
  assert.equal(v.signedAsset, null, 'there is no verified asset to record')
})

test('unsigned-release: an .asc that carries no signature is the same state, said differently', () => {
  // The installer's `classifyTagVerify` owns the word for this; reusing it is why
  // the tag surface and the release surface cannot drift into naming one state
  // two things.
  const v = classify({
    run: { status: 1, stdout: '[GNUPG:] NODATA 1\n', stderr: 'gpg: no signature found\n' },
    tagVerdict: { status: 'unsigned', detail: '该发布 tag 未做 GPG 签名' },
  })
  assert.equal(v.outcome, 'unsigned-release')
  assert.equal(v.code, CODES.releaseUnsigned)
  assert.match(v.message, /carries no signature at all/)
  assert.doesNotMatch(v.message, /git verify-tag/, "the installer's prose is about tags; only its *word* is borrowed")
})

test('signature-tool-missing: no gpg on this machine', () => {
  const v = classify({ toolAvailable: false, run: null })
  assert.equal(v.outcome, 'signature-tool-missing')
  assert.equal(v.code, CODES.signatureToolMissing)
  assert.match(v.message, /gpg is not installed/)
  assert.match(v.message, /authorship is unknown rather than proven/)
})

test('signature-tool-missing: the installer half that owns the key could not be read', () => {
  const v = classify({ anchorAvailable: false, run: null })
  assert.equal(v.outcome, 'signature-tool-missing')
  assert.equal(v.code, CODES.signatureToolMissing)
  assert.match(v.message, /installer\/cli\.js/)
})

test('a missing proof outranks a missing tool: the release’s own state is the useful one', () => {
  const v = classify({ signatureAsset: null, toolAvailable: false })
  assert.equal(v.outcome, 'unsigned-release')
})

test('the verdict prose is localisation-proof: gpg’s status lines are the only thing read', () => {
  // Real output from a Chinese-locale gpg 2.5 (captured, not invented): the prose
  // is not English, the `[GNUPG:]` machine lines are. A classifier that grepped
  // English sentences would call this unreadable, or worse, unsigned.
  const chinese = {
    status: 1,
    stdout: '[GNUPG:] NODATA 1\n[GNUPG:] NODATA 2\n[GNUPG:] FAILURE gpg-exit 33554433\n',
    stderr: 'gpg: 找不到有效的 OpenPGP 数据。\ngpg: 签名无法被验证。\n',
  }
  assert.equal(validSigFingerprint(chinese.stdout), null)
  const v = classify({ run: chinese, tagVerdict: { status: 'invalid' } })
  assert.equal(v.outcome, 'invalid')
  assert.match(v.message, /exited 1/)
})

/* --------------------------------------------------------------- gpg plumbing */

test('status parsing reads the fields the verdict depends on', () => {
  const stdout = `[GNUPG:] GOODSIG 89D88B1D043A1298 4 2\n[GNUPG:] VALIDSIG ${FAKE_SIGNER_FPR} 1790502228 0 4 0 1 27 01 00 09 0929EA\n[GNUPG:] TRUST_UNDEFINED 0 pgp\n`
  assert.deepEqual(statusLines(stdout).map((entry) => entry.keyword), ['GOODSIG', 'VALIDSIG', 'TRUST_UNDEFINED'])
  assert.equal(validSigFingerprint(stdout), FAKE_SIGNER_FPR)
  assert.equal(validSigFingerprint('[GNUPG:] BADSIG 4 2 1\n'), null)
  assert.deepEqual(
    colonFingerprints('pub:-:4096:1:89D88B1D043A1298:1790502228:::-:::scESC::::::23::0:\nfpr:::::::::0929EA31DF4F7429F63FC53189D88B1D043A1298:\nsub:-:4096:1:A4A6630F68690940:1790502228::::::e::::::23:\nfpr:::::::::2775D97356DAF8CC807C691AA4A6630F68690940:\n'),
    [FAKE_SIGNER_FPR, '2775D97356DAF8CC807C691AA4A6630F68690940'],
    'a signature made by the signing subkey counts as the same key',
  )
  assert.deepEqual(colonFingerprints('uid:-::::1790502228::ABC::jingzhao-l:::0:\n'), [])
})

test('the trust anchor is borrowed, never copied', async () => {
  const anchor = await loadTrustAnchor()
  assert.equal(anchor.ok, true, anchor.reason)
  assert.match(anchor.publicKey, /-----BEGIN PGP PUBLIC KEY BLOCK-----/)
  assert.equal(anchor.source, INSTALLER_MODULE)
  // The proof there is one key in the tree: the value this module loaded *is* the
  // value the installer exports. (Both sides ask the same export; nothing here
  // carries a second armored copy.)
  const installer = await import('../../installer/cli.js')
  assert.equal(anchor.publicKey, installer[TRUST_ANCHOR_EXPORTS.publicKey])
  assert.equal(anchor.classifyTagVerify, installer[TRUST_ANCHOR_EXPORTS.classify])
  // …and the copy check, on the base64 body rather than on the armor header: a
  // module that *reads* the key legitimately mentions the header string once, and
  // that is not the drift this test is about.
  const body = anchor.publicKey.split('\n').filter((line) => /^[A-Za-z0-9+/=]{40,}$/.test(line)).slice(1, 4)
  assert.ok(body.length === 3, 'the embedded key is not armored the way this check expects')
  const offenders = sourceFilesUnder(path.resolve(import.meta.dirname, '..'))
    .filter((file) => {
      const text = fs.readFileSync(file, 'utf8')
      return body.some((line) => text.includes(line))
    })
    .map((file) => path.relative(path.resolve(import.meta.dirname, '..'), file))
  assert.deepEqual(offenders, [], 'a second copy of the signing key appeared under updater/: two trust anchors that must agree with nothing checking it is the drift this gate exists to avoid')
})

/** Every JS/MJS/JSON source under `dir`, excluding `node_modules`. */
function sourceFilesUnder(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFilesUnder(full))
    else if (/\.(?:js|mjs|cjs|json)$/.test(entry.name)) out.push(full)
  }
  return out
}

test('a trust anchor that cannot be read is a tool gap, not a verdict', async () => {
  const missing = await loadTrustAnchor({ importInstaller: async () => { throw new Error('Cannot find module') } })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /could not be imported/)
  const keyless = await loadTrustAnchor({ importInstaller: async () => ({ classifyTagVerify: () => ({ status: 'invalid' }) }) })
  assert.equal(keyless.ok, false)
  assert.match(keyless.reason, /exports no armored/)
  const wordless = await loadTrustAnchor({
    importInstaller: async () => ({ GLASSPANE_SIGNING_PUBLIC_KEY: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nx' }),
  })
  assert.equal(wordless.ok, false)
  assert.match(wordless.reason, /classifyTagVerify/, 'sharing the verdict *rule* is part of the contract, so its absence is a failure too')
})

/** The staging-root-shaped state root `verifyReleaseSignature` writes its keyring into. */
function stagingDirs(label) {
  const stateRoot = tempDir(`${TMP_PREFIX}sig-${label}-`)
  const stagingDir = path.join(stateRoot, 'update-staging', VERSION)
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
  return { stateRoot, stagingDir }
}

/** One `verifyReleaseSignature` with the fake gpg and the real trust anchor. */
async function run({ label, gpg = fakeGpg(), signatureAsset = ASSET, loadAnchor = null, sumsText = SUMS_TEXT, stagingDir = null, stateRoot = null } = {}) {
  const anchor = loadAnchor ?? await loadTrustAnchor()
  return verifyReleaseSignature({
    version: VERSION,
    sumsName: SUMS_NAME,
    sumsText,
    signatureAsset,
    stateRoot,
    stagingDir,
    fetchBytes: async () => Buffer.from('-----BEGIN PGP SIGNATURE-----\nfake\n'),
    runGpg: gpg.runGpg,
    loadAnchor: async () => anchor,
    mkdtemp: () => fs.mkdtempSync(`${TMP_PREFIX}sig-${label}-gnupg-`),
  })
}

test('gpg is handed the .asc and the very bytes the digest gate trusted', async () => {
  const { stateRoot, stagingDir } = stagingDirs('pairing')
  const gpg = fakeGpg()
  try {
    const v = await run({ label: 'pairing', gpg, stateRoot, stagingDir })
    assert.equal(v.outcome, 'verified', v.message)
    assert.equal(gpg.verified.length, 1)
    const asked = gpg.verified[0]
    assert.equal(path.basename(asked.signedFile), SUMS_NAME, 'the file gpg was told to check is the checksum file — not the archive, and not a re-fetched copy')
    assert.equal(path.basename(asked.signatureFile), SIG_NAME)
    assert.equal(asked.signedBytes, SUMS_TEXT, 'the bytes verified are the bytes the caller parsed for the digest')
    assert.deepEqual(
      gpg.calls.map((call) => call.args[0] ?? '?'),
      ['--version', '--homedir', '--homedir', '--homedir'],
      'probed once, then import / list / verify, all inside the throwaway home',
    )
  } finally {
    removeDir(stateRoot)
  }
})

test('the keyring is a throwaway inside the staging directory, and it does not outlive the check', async () => {
  const { stateRoot, stagingDir } = stagingDirs('keyring')
  const gpg = fakeGpg()
  try {
    await run({ label: 'keyring', gpg, stateRoot, stagingDir })
    const home = gpg.verified[0].gnupgHome
    assert.ok(home, 'gate 8 ran with a keyring')
    assert.ok(home.startsWith(path.join(stateRoot, 'update-staging')), `the keyring was ${home}, outside the staging root`)
    assert.notEqual(path.dirname(home), path.join(os.homedir(), '.gnupg'), 'the updater’s own keyring must never be the developer’s')
    assert.equal(fs.existsSync(home), false, 'a verification keyring left behind is state nobody asked for')
  } finally {
    removeDir(stateRoot)
  }
})

test('without a staging directory the keyring goes to a temp home that is still removed', async () => {
  const gpg = fakeGpg()
  const v = await run({ label: 'tmp-home', gpg })
  assert.equal(v.outcome, 'verified', v.message)
  const home = gpg.verified[0].gnupgHome
  assert.ok(home.startsWith(TMP_PREFIX), home)
  assert.equal(fs.existsSync(home), false)
})

test('no published .asc costs nothing: no anchor load, no subprocess, no download', async () => {
  const stateRoot = tempDir(`${TMP_PREFIX}sig-none-`)
  let anchors = 0
  const gpg = fakeGpg()
  try {
    const v = await verifyReleaseSignature({
      version: VERSION,
      sumsName: SUMS_NAME,
      sumsText: SUMS_TEXT,
      signatureAsset: null,
      stateRoot,
      fetchBytes: async () => { throw new Error('nothing may be fetched for a signature that is not there') },
      runGpg: gpg.runGpg,
      loadAnchor: async () => { anchors += 1; return loadTrustAnchor() },
    })
    assert.equal(v.outcome, 'unsigned-release')
    assert.equal(anchors, 0)
    assert.equal(gpg.calls.length, 0)
    assert.equal(fs.readdirSync(stateRoot).length, 0, 'the gate did not leave a directory behind in a state root it never needed')
  } finally {
    removeDir(stateRoot)
  }
})

test('a release signed by an unknown key refuses end to end, not just in the table', async () => {
  const v = await run({ label: 'foreign', gpg: fakeGpg({ outcome: 'foreign-key', signerFingerprint: FOREIGN_SIGNER_FPR }) })
  assert.equal(v.outcome, 'invalid')
  assert.equal(v.code, CODES.signatureInvalid)
})

test('a keyring the embedded key cannot be imported into is the tool gap, not a pass', async () => {
  const v = await run({ label: 'import-fails', gpg: fakeGpg({ importStatus: 2 }) })
  assert.equal(v.outcome, 'signature-tool-missing')
  assert.match(v.message, /could not be read or imported/)
  const noAnchor = await run({ label: 'no-anchor', gpg: fakeGpg(), loadAnchor: { ok: false, reason: 'gone' } })
  assert.equal(noAnchor.outcome, 'signature-tool-missing')
})

/* ------------------------------------------------------------- the standing note */

test('authorshipNote: verified is silent, everything else keeps saying it', () => {
  assert.equal(authorshipNote({ version: VERSION, signature: 'verified', consented: false }), null)
  assert.equal(authorshipNote(null), null)
  for (const word of ['unsigned-release', 'signature-tool-missing']) {
    const note = authorshipNote({ version: VERSION, signature: word, signedAsset: null, consented: true }, 'applied')
    assert.equal(note.code, OUTCOME_CODES[word])
    assert.match(note.message, /was applied without authorship proof/)
    assert.match(note.message, /--consent unsigned-release/)
  }
  const staged = authorshipNote({ version: VERSION, signature: 'unsigned-release', signedAsset: null, consented: true }, 'staged')
  assert.match(staged.message, /was staged without authorship proof/, 'the tense follows what happened, or the record describes an event that did not')
  const stranger = authorshipNote({ version: VERSION, signature: 'who-knows', signedAsset: SIG_NAME, consented: false }, 'applied')
  assert.equal(stranger.code, CODES.releaseUnsigned, 'an unrecognised word in somebody’s state file is not evidence of authorship')
})

/* ------------------------------------------------------------------ the real one */

test('the real gpg binary, when it exists: the absence path and a real refusal, never a skip', async (t) => {
  const probe = spawnSync('gpg', ['--version'], { encoding: 'utf8', timeout: 15_000 })
  if (probe.status !== 0) {
    // This machine has no gpg, so *that* is the fact worth asserting through the
    // real runner: the updater notices, and what it notices is the consent-gated
    // gap — not a crash, and not a pass.
    const real = defaultRunGpg(['--version'], { gnupgHome: null })
    assert.notEqual(real.status, 0, 'spawnSync said gpg is missing, then the real runner answered as if it were there')
    const v = await verifyReleaseSignature({
      version: VERSION,
      sumsName: SUMS_NAME,
      sumsText: SUMS_TEXT,
      signatureAsset: ASSET,
      stateRoot: tempDir(`${TMP_PREFIX}sig-nogpg-`),
      fetchBytes: async () => Buffer.from('whatever'),
    })
    assert.equal(v.outcome, 'signature-tool-missing', 'a missing gpg must never read as "verified"')
    assert.equal(v.code, CODES.signatureToolMissing)
    return
  }
  // gpg is here: drive the real binary, with the real embedded key imported into a
  // real throwaway keyring, against a signature that is not ours. Import *and*
  // verify both run for real, so a broken argv shape, an unusable key export, or
  // an "it looks like armor, call it verified" fallback all surface here as a
  // refusal that is not `verified`.
  const { stateRoot, stagingDir } = stagingDirs('real')
  try {
    const v = await verifyReleaseSignature({
      version: VERSION,
      sumsName: SUMS_NAME,
      sumsText: SUMS_TEXT,
      signatureAsset: ASSET,
      stateRoot,
      stagingDir,
      fetchBytes: async () => Buffer.from('not an OpenPGP signature at all\n'),
    })
    assert.equal(v.outcome, 'invalid', `the real gpg answered ${v.outcome} to a fabricated .asc; only "invalid" is honest`)
    assert.equal(v.code, CODES.signatureInvalid)
    assert.doesNotMatch(v.message, /verified against the key/)
    assert.equal(fs.existsSync(path.join(stagingDir, 'gnupg-verify')), false, 'the real run left its real keyring behind')
    t.diagnostic(`real gpg said: ${v.detail}`)
  } finally {
    removeDir(stateRoot)
  }
})
