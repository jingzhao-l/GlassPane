/**
 * Spec §1 gate 8: *who published this release?* Gates 3–7 answer "are these the
 * bytes the release claims to be, and were they built green on main". None of
 * them answers who typed the claim: `SHA256SUMS-<ver>.txt` is a file somebody
 * uploaded, and every digest gate downstream happily measures whatever it says.
 *
 * This gate closes that with the one thing the release chain now actually
 * produces: `.github/workflows/release.yml` signs the checksum file with an
 * ASCII-armored **detached GPG signature** (`SHA256SUMS-<ver>.txt.asc` — the name
 * `gpg --detach-sign --armor FILE` writes by itself; see `lib/assets.js`)
 * whenever the `GPG_PRIVATE_KEY` secret is configured. Verifying it needs a
 * public key, and this project already owns exactly one copy of it:
 * `installer/cli.js` exports `GLASSPANE_SIGNING_PUBLIC_KEY` (and
 * `classifyTagVerify`, the verdict vocabulary) because the installer verifies the
 * release *tag* with the same key.
 *
 * So the key is **imported, never copied**. A second armored key block inside
 * `updater/` would be a second trust anchor, and "two files that must agree with
 * nothing checking it" is the failure this repository has already had to fix
 * twice (two status roots, two job labels, two version readings). Here the two
 * surfaces cannot drift, because there is one string to read.
 *
 * Verification runs `gpg --verify` in a **throwaway GNUPGHOME** created inside
 * the release's own `0700` staging directory and deleted with it. Never the
 * user's keyring: a check that consulted `~/.gnupg` could be made to answer
 * "verified" by any key somebody else put in that ring.
 *
 * Four states, each with its own code and its own sentence (`SIGNATURE_OUTCOMES`):
 *
 *   verified                the checksum file carries a signature made by the key
 *                           this program ships — authorship established *to that key*
 *   invalid                 a signature is there and does not check, or it checks out
 *                           under some other key. Hard refusal; consent cannot override.
 *   unsigned-release        no `.asc` was published for this release (true of every
 *                           release tagged before the signing job existed, v1.3.1 included)
 *   signature-tool-missing  gpg is not on this machine, or the installer half that
 *                           owns the key could not be read
 *
 * What `verified` does **not** claim: the key is not the repository's identity, it
 * is a string this program ships. The honest reading is "these bytes match the key
 * we ship", so key rotation means editing one exported string in
 * `installer/cli.js`, and both surfaces start agreeing or disagreeing with it
 * together.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { CODES } from './codes.js'
import { SIGNATURE_NAME } from './assets.js'
import { UpdaterError, removeTreeWithin, resolveWithin, writableRoots } from './fsutil.js'

/**
 * The closed vocabulary. The installer's `classifyTagVerify` supplies the words
 * for the states it already names (`verified` / `invalid` / its `unsigned`); the
 * two "there was nothing to check" states are spelled for this surface, because
 * "the tag is unsigned" and "this release publishes no signature asset" are
 * different facts about different artifacts.
 */
export const SIGNATURE_OUTCOMES = Object.freeze(['verified', 'invalid', 'unsigned-release', 'signature-tool-missing'])

/** The consent kind a human has to name to proceed without authorship proof. */
export const UNSIGNED_CONSENT_KIND = 'unsigned-release'

/** The only two things this module takes from the installer: the key and the words. */
export const TRUST_ANCHOR_EXPORTS = Object.freeze({
  publicKey: 'GLASSPANE_SIGNING_PUBLIC_KEY',
  classify: 'classifyTagVerify',
})
/** Resolved relative to *this file*, so it follows the install tree, not the CWD. */
export const INSTALLER_MODULE = '../../installer/cli.js'

/** Outcome → the code stamped in the state file. `verified` refuses nothing. */
export const OUTCOME_CODES = Object.freeze({
  verified: null,
  invalid: CODES.signatureInvalid,
  'unsigned-release': CODES.releaseUnsigned,
  'signature-tool-missing': CODES.signatureToolMissing,
})

export { SIGNATURE_NAME }

/* ------------------------------------------------------------------ verdicts */

/**
 * One verdict: the state, its code, and the sentence §4 makes the panel and
 * `gp_diagnose` print verbatim. Written for a person who has to decide whether to
 * press a button, so each one names the artifact it looked at and the action left.
 */
function verdict(outcome, { version = null, sumsName = null, detail = null, signedAsset = null, keyFingerprint = null } = {}) {
  const name = signedAsset ?? SIGNATURE_NAME(version ?? '<ver>')
  const who = version ? `release ${version}` : 'this release'
  // "Nothing was signed" and "an empty .asc was signed onto" are the same state of
  // the world for whoever reads this, but not the same sentence about the release.
  const gap = signedAsset ? `publishes a ${name} that carries no signature at all (${detail ?? 'gpg: no signature found'})` : `publishes no ${name}`
  const messages = {
    verified: `${who}'s ${name} verifies against the key this program ships (fingerprint ${keyFingerprint ?? 'unread'}), so the checksum file that gates 4 and 5 take their digest from is the publisher's own statement — authorship established to that key, which is all "verified" claims here and nothing more.`,
    invalid: `${who} publishes ${name}, and that signature does not check against the key this program ships. ${detail ?? 'Nothing more can be said about why.'} Nothing was staged, and no consent can override a bad signature: "updater check --consent unsigned-release" is the answer to "nobody signed this release", never to "the signature contradicts itself". This release is refused outright.`,
    'unsigned-release': `${who} ${gap}, so nothing proves who wrote its checksum file: the digest, version-line and CI gates buy integrity and build traceability, not authorship (the release-signing job was added after 1.3.1, so every release tagged before it reads like this one). An automatic run stops here. A person who has compared the sha256 "updater status" reports against the release page may run "updater check --consent unsigned-release" to stage it with the missing proof recorded in the state file.`,
    'signature-tool-missing': `${who}'s ${name} could not be checked on this machine: ${detail ?? 'no verification tool is available'}, so its authorship is unknown rather than proven. An automatic run stops here; "updater check --consent unsigned-release" proceeds with the gap recorded in the state file.`,
  }
  const sentence = messages[outcome]
  if (sentence === undefined) {
    throw new UpdaterError(CODES.signatureToolMissing, `unknown signature outcome ${JSON.stringify(outcome)}`)
  }
  return {
    outcome,
    code: OUTCOME_CODES[outcome],
    message: sentence,
    signedAsset: outcome === 'unsigned-release' ? null : name,
    keyFingerprint: outcome === 'verified' ? keyFingerprint ?? null : null,
    detail,
  }
}

/* ------------------------------------------------------------------ standing note */

/**
 * The sentence a release that was accepted **without** authorship proof has to
 * keep saying, for as long as it is the offer on disk and after it is installed.
 *
 * It exists because `staged` / `applied` on their own read like every other
 * success, while the honest description of this outcome is "a person waved through
 * the one gate that asks who published it". Stamped as `code` + `lastError.message`
 * (§4 — the panel and `gp_diagnose` print those verbatim), it is the difference
 * between "updated" and "updated, and nobody proved the update came from us".
 *
 * `null` for a verified release: no note, no standing warning, clean success.
 */
export function authorshipNote(authorship, done = 'accepted') {
  if (!authorship) return null
  const word = String(authorship.signature ?? '')
  // Anything that is not the clean verdict keeps the note, including a word this
  // file does not know: an unrecognised state in somebody's state file is not
  // evidence that authorship was established.
  if (word === 'verified') return null
  const asset = authorship.signedAsset ? `, and the .asc published for it does not settle who wrote ${authorship.signedAsset}` : ''
  return {
    code: OUTCOME_CODES[word] ?? CODES.releaseUnsigned,
    message: `release ${authorship.version ?? 'unknown'} was ${done} without authorship proof (${word || 'no verdict'}${asset}): `
      + 'no signature made by the key this program ships was verified, and a person accepted that with '
      + `"updater check --consent ${UNSIGNED_CONSENT_KIND}". The scheduled run will not do this on its own. `
      + 'Compare the sha256 "updater status" reports against the release page before you rely on what is installed.',
  }
}

/* ------------------------------------------------------------------ pure gpg */


/**
 * `[GNUPG:]` status lines are the only unlocalized thing gpg emits: its prose
 * follows the user's locale (`gpg: 找不到有效的 OpenPGP 数据。` on a Chinese
 * session), so a classifier that greps English sentences misreads a machine in
 * another language. Fingerprints and failures are read from these lines; the real
 * runner also pins `LC_ALL=C`, so the installer's English-text `classifyTagVerify`
 * sees the same bytes here that it sees there.
 */
export function statusLines(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\[GNUPG:\]\s+(\S+)(.*)$/.exec(line)
    if (match) out.push({ keyword: match[1], rest: match[2].trim() })
  }
  return out
}

/** `VALIDSIG`'s first field is the fingerprint of the key that made the signature. */
export function validSigFingerprint(text) {
  const hit = statusLines(text).find((entry) => entry.keyword === 'VALIDSIG')
  const fpr = hit ? String(hit.rest).split(/\s+/)[0] : null
  return typeof fpr === 'string' && /^[0-9a-fA-F]{16,64}$/.test(fpr) ? fpr.toUpperCase() : null
}

/** `fpr:::::::::<HEX>:` lines from `--with-colons --list-keys` (primary and subkeys). */
export function colonFingerprints(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('fpr:')) continue
    const value = line.split(':').filter((field) => field !== '').pop()
    if (typeof value === 'string' && /^[0-9A-Fa-f]{16,64}$/.test(value)) out.push(value.toUpperCase())
  }
  return [...new Set(out)]
}

/**
 * The decision table, as a pure function of what the release published and what
 * gpg answered — which is what makes all four states testable on a machine with
 * or without gpg. `tagVerdict` is the *installer's* judgement of the same run, so
 * the tag surface and this one share one rule and one set of words.
 */
export function classifySignature({
  version = null,
  sumsName = null,
  signatureAsset = null,
  toolAvailable = true,
  anchorAvailable = true,
  toolDetail = null,
  run = null,
  keyFingerprints = [],
  tagVerdict = null,
} = {}) {
  const want = { version, sumsName }
  // A release that published nothing to verify is decided before the machine's
  // tooling is asked about: "no signature asset" is a fact about the release,
  // "no gpg" is a fact about this host, and the first is the one a schedule
  // refuses on for the right reason.
  if (!signatureAsset) return verdict('unsigned-release', want)
  if (!toolAvailable) {
    return verdict('signature-tool-missing', {
      ...want,
      signedAsset: signatureAsset.name,
      detail: toolDetail ?? 'gpg is not installed (or "gpg --version" failed), so a detached signature cannot be checked here',
    })
  }
  if (!anchorAvailable) {
    return verdict('signature-tool-missing', {
      ...want,
      signedAsset: signatureAsset.name,
      detail: `the signing key this program borrows from ${INSTALLER_MODULE} (${TRUST_ANCHOR_EXPORTS.publicKey}) could not be read or imported`,
    })
  }
  if (!run) {
    return verdict('signature-tool-missing', { ...want, signedAsset: signatureAsset.name, detail: 'gpg was never asked, so nothing is known about this signature' })
  }
  const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  if (tagVerdict?.status === 'unsigned') {
    // The asset exists and holds no signature: the installer's own word for that,
    // and the same state of the world for a person reading either surface.
    return verdict('unsigned-release', { ...want, signedAsset: signatureAsset.name, detail: 'the published .asc carries no signature at all' })
  }
  const trusted = keyFingerprints.map((fpr) => String(fpr).toUpperCase())
  const fingerprint = validSigFingerprint(run.stdout)
  if (run.status === 0 && fingerprint && trusted.includes(fingerprint)) {
    return verdict('verified', { ...want, signedAsset: signatureAsset.name, keyFingerprint: fingerprint })
  }
  // Why, in the sentence the person reads. The installer's `tagVerdict` is not
  // quoted here: its prose is about `git verify-tag` and in the installer's
  // language, and what this surface shares with it is the *word*, not the string.
  let detail
  if (run.status === 0) {
    detail = fingerprint
      // A well-formed signature made by somebody else's key. This keyring only
      // ever holds the embedded key, so getting here means a different
      // installation of this program or a hand-built keyring is in play; either
      // way it is not our publisher, and it is not a consent question.
      ? `The signature is well formed but reads back under ${fingerprint}, and the key this program ships is ${trusted.join(' or ') || 'unreadable'}.`
      : 'gpg answered that the signature is good without naming which key made it.'
  } else {
    const tail = text.trim().split('\n').filter((line) => line !== '').slice(-2).join(' / ')
    detail = `gpg --verify exited ${run.status ?? 'null'}${tail ? `: ${tail}` : ', with no output'}.`
  }
  return verdict('invalid', { ...want, signedAsset: signatureAsset.name, detail })
}

/* -------------------------------------------------------------------- gpg io */

/**
 * Where a `gpg` may still live when it is not on PATH.
 *
 * Measured on this machine on 2026-10-03: gnupg is installed (`/opt/homebrew/bin/gpg`), yet every scheduled
 * and GUI-initiated run answered "gpg is not installed" — because launchd hands a job
 * `/usr/bin:/bin:/usr/sbin:/sbin`, a `.app` launched from Finder gets nearly the same, and gate 8 spawns
 * `gpg` by name. The verdict was therefore permanently consent-gated on exactly the machines that have
 * Homebrew gnupg, while the sentence told the person to install a thing they had installed.
 */
export const GPG_CANDIDATE_PATHS = Object.freeze([
  '/opt/homebrew/bin/gpg',
  '/usr/local/bin/gpg',
  '/opt/local/bin/gpg',
])

/**
 * Find a working gpg: the configured override, then PATH, then the known prefixes.
 *
 * Every answer carries `tried`, because the sentence a person reads must say what was looked at. "Not
 * installed" is only honest after the search was; "on this PATH it is not" is the actionable version.
 */
export function resolveGpgBinary({
  env = process.env,
  candidates = GPG_CANDIDATE_PATHS,
  exists = (target) => fs.existsSync(target),
  probe = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }),
} = {}) {
  const tried = []
  const works = (bin) => {
    tried.push(bin)
    const answer = probe(bin)
    return Boolean(answer) && answer.status === 0
  }
  const override = String(env.GLASSPANE_GPG ?? '').trim()
  if (override && works(override)) return { bin: override, tried, source: 'GLASSPANE_GPG' }
  if (works('gpg')) return { bin: 'gpg', tried, source: 'PATH' }
  for (const candidate of candidates) {
    if (!exists(candidate)) continue
    if (works(candidate)) return { bin: candidate, tried, source: 'known prefix' }
  }
  return { bin: null, tried, source: null }
}

/** The honest sentence for "no working gpg", naming the search rather than guessing at the cause. */
export function gpgMissingDetail({ tried = [], pathValue = process.env.PATH ?? '' } = {}) {
  if (tried.length === 0) return 'gpg is not installed (or "gpg --version" failed), so a detached signature cannot be checked here'
  const where = `PATH=${pathValue || '(empty)'}`
  return `no working gpg was found after trying ${tried.join(', ')} — this process runs with ${where}, which does not include the directory gpg is installed in (a launchd job or a Finder-launched .app gets this minimal PATH even when your shell has the right one). Set GLASSPANE_GPG=/absolute/path/to/gpg, or add the directory to the job's PATH.`
}

let resolvedGpg = null

/**
 * The real runner. `--homedir` *and* `GNUPGHOME` are both pinned to the throwaway
 * directory: passing only one leaves a gpg that reads the other still able to
 * consult — and write — the developer's own keyring.
 */
export function defaultRunGpg(args, { gnupgHome } = {}) {
  if (resolvedGpg === null) resolvedGpg = resolveGpgBinary()
  const bin = resolvedGpg.bin
  if (bin === null) {
    // ENOENT / EACCES: the binary is not there. That has to arrive as the
    // `signature-tool-missing` verdict, not as an exception escaping a gate — with
    // the search report attached so the sentence can name what was looked at.
    return { status: null, stdout: '', stderr: `gpg could not be found (tried ${resolvedGpg.tried.join(', ') || 'nothing'})`, tried: [...resolvedGpg.tried] }
  }
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, GNUPGHOME: gnupgHome ?? '', LC_ALL: 'C', LANG: 'C' },
  })
  if (res.error && res.status === null && res.stdout === null && res.stderr === null) {
    return { status: null, stdout: '', stderr: String(res.error.message ?? res.error), tried: [...resolvedGpg.tried] }
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? (res.error ? String(res.error.message) : '') }
}

/**
 * The one place the armored key is read: import the installer module and take its
 * exported value. There is deliberately no fallback copy in `updater/` — if this
 * import cannot produce both the key and the classifier, gate 8 says so instead
 * of deciding with a key nobody published.
 */
export async function loadTrustAnchor({ importInstaller = () => import(INSTALLER_MODULE) } = {}) {
  let mod
  try {
    mod = await importInstaller()
  } catch (error) {
    return { ok: false, reason: `${INSTALLER_MODULE} could not be imported (${error.message})` }
  }
  const publicKey = mod?.[TRUST_ANCHOR_EXPORTS.publicKey]
  if (typeof publicKey !== 'string' || !publicKey.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
    return { ok: false, reason: `${INSTALLER_MODULE} exports no armored ${TRUST_ANCHOR_EXPORTS.publicKey}` }
  }
  const classifyTagVerify = mod?.[TRUST_ANCHOR_EXPORTS.classify]
  if (typeof classifyTagVerify !== 'function') {
    return { ok: false, reason: `${INSTALLER_MODULE} exports no ${TRUST_ANCHOR_EXPORTS.classify}, so the tag surface and this one no longer share one verdict rule` }
  }
  return { ok: true, publicKey, classifyTagVerify, source: INSTALLER_MODULE }
}

/** Write one of the three files gpg needs next to the throwaway keyring. */
function writeVerificationFile(dir, name, bytes) {
  const target = path.join(dir, path.basename(String(name)))
  fs.writeFileSync(target, bytes, { mode: 0o600 })
  return target
}

/**
 * Ask gpg. Returns the same verdict object as {@link classifySignature}, so the
 * caller only ever deals with the four states and their sentences.
 *
 * `sumsText` is handed in rather than re-fetched: the bytes verified here must be
 * the bytes whose single row produced the digest gate 5 measures, or gate 8 would
 * certify one file while gates 4–5 trusted another.
 *
 * Everything environmental is injected (`runGpg`, `loadAnchor`, `fetchBytes`,
 * `mkdtemp`), so the suite drives all four states without a gpg on the machine —
 * and one test in `test/signature.test.mjs` uses the real binary when it is there.
 */
export async function verifyReleaseSignature({
  version,
  sumsName,
  sumsText,
  signatureAsset = null,
  stateRoot,
  stagingDir = null,
  fetchBytes,
  runGpg = defaultRunGpg,
  loadAnchor = loadTrustAnchor,
  mkdtemp = fs.mkdtempSync,
  log = () => {},
} = {}) {
  const want = { version, sumsName }
  // Nothing published ⇒ nothing to ask about, and no subprocess is paid for.
  if (!signatureAsset) return classifySignature({ ...want, signatureAsset: null })

  const anchor = await loadAnchor()
  const probed = runGpg(['--version'], { gnupgHome: null })
  if (!probed || probed.status !== 0) {
    return classifySignature({
      ...want,
      signatureAsset,
      toolAvailable: false,
      anchorAvailable: anchor.ok,
      toolDetail: gpgMissingDetail({ tried: probed?.tried ?? [] }),
    })
  }
  if (!anchor.ok) {
    return classifySignature({ ...want, signatureAsset, toolAvailable: true, anchorAvailable: false })
  }

  const roots = stagingDir ? writableRoots(stateRoot) : null
  const home = stagingDir
    ? resolveWithin(roots.staging, path.join(stagingDir, 'gnupg-verify'), 'verification keyring')
    : mkdtemp(path.join(os.tmpdir(), 'glasspane-gnupg-'))
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    const keyPath = writeVerificationFile(home, 'publish-key.asc', anchor.publicKey)
    const imported = runGpg(['--homedir', home, '--batch', '--yes', '--import', keyPath], { gnupgHome: home })
    if (!imported || imported.status !== 0) {
      return classifySignature({ ...want, signatureAsset, toolAvailable: true, anchorAvailable: false })
    }
    const listed = runGpg(['--homedir', home, '--batch', '--with-colons', '--list-keys'], { gnupgHome: home })
    const keyFingerprints = colonFingerprints(listed?.stdout)
    const sumsPath = writeVerificationFile(home, sumsName ?? 'SHA256SUMS.txt', sumsText)
    const sigName = signatureAsset.name ?? SIGNATURE_NAME(version ?? '<ver>')
    const signatureBytes = await fetchBytes(signatureAsset.url)
    const sigPath = writeVerificationFile(home, sigName, signatureBytes)
    const run = runGpg(['--homedir', home, '--batch', '--yes', '--status-fd', '1', '--verify', sigPath, sumsPath], { gnupgHome: home })
    const tagVerdict = anchor.classifyTagVerify({ status: run?.status ?? null, stdout: run?.stdout ?? '', stderr: run?.stderr ?? '' })
    log(`gate 8: ${sigName} over ${sumsName ?? 'SHA256SUMS'} with ${keyFingerprints.length} embedded fingerprint(s) -> gpg exit ${run?.status ?? 'null'} (${tagVerdict?.status ?? 'unreadable'})`)
    return classifySignature({
      ...want,
      signatureAsset: { ...signatureAsset, name: sigName },
      toolAvailable: true,
      anchorAvailable: true,
      run,
      keyFingerprints,
      tagVerdict,
    })
  } finally {
    if (stagingDir) {
      // The keyring is a verification artifact, not state: it goes away with the
      // staging directory (which `check` discards on every refusal path).
      try {
        removeTreeWithin(roots.staging, home)
      } catch {
        /* the staging discard covers it */
      }
    } else {
      try {
        fs.rmSync(home, { recursive: true, force: true })
      } catch {
        /* an undeletable temp keyring is not a reason to refuse a release */
      }
    }
  }
}
