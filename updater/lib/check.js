/**
 * `updater check`: the eight gates of spec §1, in the order the spec lists
 * them, each one able to stop the run on its own. The first gate that refuses
 * decides `code`, and the state file records it — "we tried and this is the one
 * thing that did not hold" is the whole point of the status file.
 *
 *   1 tag grammar + strictly newer than what is installed here
 *     (and the two local readings agreeing with each other)
 *   2 major ⇒ needs-consent, never automatic
 *   3 both release assets present, exactly once each, on a pinned host
 *   4 SHA256SUMS parsed strictly, exactly one row for the tarball
 *   5 the archive measured on disk against that digest (0700 staging)
 *   6 the unpacked tree proving its own version line
 *   7 a green CI run on main for the commit the release names
 *   8 a detached GPG signature over SHA256SUMS, made by the key this program
 *     ships — i.e. *who said any of this* (see `lib/signature.js`)
 *
 * Gate 8 is ordered with a reason, not by preference: it is the only gate whose
 * question is about a *person*, and §8's second item forbids executing anything
 * from the staged tree before the network-verifiable gates are done — so it sits
 * at the front of that group, before the archive is even downloaded. Its outcomes
 * are not all equal either: `invalid` is a hard refusal that no consent
 * overrides, while "nothing was signed" and "this machine cannot check" are
 * refusals a human may accept with `--consent unsigned-release`, which the state
 * file then keeps saying for as long as that release is installed.
 */
import { CODES } from './codes.js'
import { UpdaterError, writableRoots } from './fsutil.js'
import { DEFAULT_BASE, REPO_SLUG, UPDATE_BASE_ENV, resolveBase } from './source.js'
import { localVersion, parseTag } from './version.js'
import { decideUpdate } from './policy.js'
import { findSignatureAsset, requireAssetPair } from './assets.js'
import { authorshipNote, UNSIGNED_CONSENT_KIND, verifyReleaseSignature } from './signature.js'
import { digestFor } from './sums.js'
import { verifyArchiveDigest } from './digest.js'
import { discardStaging, extractInto, prepareStaging, releaseTreeRoot, sweepUnreferencedGenerations, writeArchive } from './staging.js'
import { selfCheckStagedTree } from './selfcheck.js'
import { verifyCiGreen } from './ci.js'
import { loadState, nextState, saveState } from './state.js'
import { readPointer } from './state.js'

export const RELATIVE_RELEASE_PATH = '/releases/latest'

/**
 * The release declares how long each of its assets is (`assets[].size`; measured on v1.5.1: 25,126,902 for
 * the tarball, 89 for the checksum file, and the CDN answers the same numbers in `content-length`). A body
 * that arrives at a different length is not the asset that was described.
 *
 * Said **before** the digest is computed, because "the checksum matched" over a body whose length the release
 * never published is a statement about some other file — and a truncating proxy is exactly the shape that
 * would still match a checksum if the sums file itself were the truncated one. Unknown declared length
 * (a payload that carries no `size`) is not a refusal: this checks the claim, it is not the claim's author.
 */
export function assertDeclaredBytes(what, got, declared) {
  if (declared === null || declared === undefined) return
  if (declared === got) return
  throw new UpdaterError(
    CODES.releaseBadPayload,
    `the release declares ${what} to be ${declared} bytes and the download was ${got}: refusing bytes whose length contradicts the release that names them. Nothing was staged`,
  )
}

/**
 * Gate 8's two "the proof is missing, and missing is not the same as false"
 * states. They refuse with `needs-consent` rather than `check-failed`, because
 * §4's panel keeps the reason visible with a live button for exactly this case.
 * `signature-invalid` is deliberately **not** in here: it is the one outcome no
 * consent can wave through.
 */
const AUTHORSHIP_CONSENT_CODES = new Set([CODES.releaseUnsigned, CODES.signatureToolMissing])

/**
 * Run one check.
 *
 * Everything with a side effect is injected: `fetchJson`/`fetchBytes` (tests
 * point them at a local server), `local` (the two version readings),
 * `selfCheckOpts.runner`, `save`. Defaults are the real implementations, built
 * by `cli.js`.
 */
export async function runCheck({
  stateRoot,
  env = {},
  now = new Date(),
  local,
  autoApply = null,
  consents = [],
  fetchJson,
  fetchBytes,
  trigger = 'auto',
  save = true,
  selfCheckOpts = {},
  signatureOpts = {},
  log = () => {},
  /**
   * The sweep of generations this machine has no offer for any more, run at the end of a check that
   * *completed*.
   *
   * It used to live only after a successful swap, which made it unreachable on exactly the machines that
   * need it: this one carried a 25 MB `update-staging/1.5.1/` and an empty `1.12.0/` under a state file that
   * named neither, and the only code that deletes them ran at the end of an apply that could not succeed.
   * A check is the half that runs every day regardless, so it gets the same sweep — under the same
   * protections, and with the state document as the only reference it may read (`lib/staging.js`'s
   * `sweepUnreferencedGenerations`).
   *
   * Injectable because it is a filesystem side effect, and the tests that want to watch it must not have to
   * build a stale tree to prove a sentence.
   */
  sweepStale = sweepUnreferencedGenerations,
} = {}) {
  const roots = writableRoots(stateRoot)
  const previous = loadState(stateRoot).state
  const currentAutoApply = autoApply ?? previous.autoApply
  // A scheduled run has no person behind it, so it has no consents — even if a caller
  // handed some over. `cli.js` refuses the `--auto --consent` pair at the boundary; this
  // is the same rule where an importer (the installer, a test, a future entry point)
  // bypasses that boundary. Before this, `trigger` was destructured and never read: gate
  // 8's "an automatic run stops here" (lib/signature.js) and this file's own header were
  // both unpaid, and `check --auto --consent unsigned-release` staged an unproven release.
  const humanConsents = trigger === 'auto' ? [] : consents
  const base = safeGate(() => resolveBase({ ...env }), { base: DEFAULT_BASE, origin: new URL(DEFAULT_BASE).origin })

  const finish = (patch, historyEntry) => {
    const merged = nextState(previous, { ...patch, historyEntry }, { now })
    if (save) saveState(stateRoot, merged, { now })
    // The stale-generation sweep belongs to the *completed* answers only. A refusal has already thrown its
    // own tree away (and said so if it could not), and a second delete behind a refusal is how this file
    // produced a `check-failed` whose sentence was about something else. A `needs-consent` answer that
    // **staged** an offer is completed in the sense that matters here: the machine has a live offer, so
    // every other generation is by definition unreferenced.
    const completed = patch.status === 'staged' || patch.status === 'available' || patch.status === 'up-to-date' || patch.status === 'applied'
      || (patch.status === 'needs-consent' && Boolean(patch.staged))
    let sweep = null
    if (completed) {
      const referenceVersion = patch.staged?.version ?? patch.current ?? previous.current
      sweep = safeSweep({ stateRoot, state: merged, referenceVersion })
    }
    const sweepNote = sweep && sweep.failed.length > 0
      ? ` This run swept the generations it no longer has an offer for, but could not remove ${sweep.failed.map((one) => one.dir).join(', ')} (${sweep.failed.map((one) => one.reason).join('; ')}).`
      : null
    const message = sweepNote === null
      ? patch.message ?? null
      : (typeof patch.message === 'string' && patch.message !== '' ? `${patch.message}${sweepNote}` : sweepNote.trim())
    if (sweep && sweepNote) log(sweepNote.trim())
    return {
      ok: patch.status === 'staged' || patch.status === 'available' || patch.status === 'up-to-date' || patch.status === 'applied',
      status: patch.status,
      code: patch.code ?? null,
      message,
      tlsVerification: patch.tlsVerification === true,
      latest: patch.latest ?? previous.latest,
      current: patch.current ?? previous.current,
      // Off the *merged* document, not `patch.staged ?? previous.staged`: a
      // refusal clears the field by setting it to `null`, and `??` reads a
      // deliberate null as "absent, keep the old one" — which is how a refused
      // check used to hand a stale tree straight to `apply`.
      staged: merged.staged,
      // What the sweep decided, as data: `removed` / `skipped` / `failed`. A generation left alone because
      // another run is writing it is a *stated* skip, never a silent one.
      stagingSweep: sweep,
      state: merged,
    }
  }

  /** A sweep may not add a second failure on top of the answer the check just gave. */
  function safeSweep(options) {
    try {
      return sweepStale(options)
    } catch (error) {
      return {
        ok: false,
        removed: [],
        failed: [],
        skipped: [`the sweep of unreferenced staging generations threw (${error?.message ?? String(error)})`],
      }
    }
  }

  const refuse = (error, extra = {}) => {
    const code = error instanceof UpdaterError ? error.code : CODES.checkFailed
    log(`gate refused: ${code} — ${error.message}`)
    // §4: `lastError.message` is the sentence the panel prints verbatim, so the
    // gate that refused has to supply its own words. Without this every refusal
    // in this file reads "the update stopped as check-failed (…)", which names
    // nothing a person can act on. Reverse mutation: delete `message` below and
    // the CI / digest / self-check refusals in `test/check.test.mjs` lose their
    // specific sentences.
    // A refusing check clears `staged`, including a tree an *earlier* check
    // parked there: §7 makes `apply` trust the staged record, and a tree staged
    // against a version this machine no longer runs is exactly how a stale offer
    // becomes an auto-downgrade.
    return finish(
      {
        status: extra.status ?? 'check-failed',
        code,
        message: error?.message ?? null,
        details: error?.details ?? null,
        // 不是状态文档的字段（`nextState` 会把它筛掉），只是这条拒绝要带给 CLI 的事实：
        // §9.10 的自愈分支读它，不读文案。
        tlsVerification: error?.tlsVerification === true,
        current: local?.version ?? previous.current,
        lastCheckAt: extra.stampCheck === false ? previous.lastCheckAt : now.toISOString(),
        staged: null,
        ...extra.patch,
      },
      { action: 'check', result: extra.status ?? 'check-failed', digest: null, code },
    )
  }

  // Gate 0 (spec §1's own wording): an unusable source refuses before anything
  // is fetched, and it is never downgraded to plain HTTP.
  if (base.thrown) return refuse(base.thrown, { stampCheck: false })

  // Gate 1a: what this machine claims it runs. Both readings must agree.
  if (!local || local.ok !== true) {
    const error = local?.message
      ? new UpdaterError(local.code ?? CODES.versionMismatchLocal, local.message)
      : new UpdaterError(CODES.versionMismatchLocal, 'the installed version could not be read: re-run the GlassPane installer')
    return refuse(error, { status: 'check-failed' })
  }
  const currentVersion = local.version

  // Gate 1b: the release offer.
  let release
  try {
    release = await fetchJson(`${base.base}${RELATIVE_RELEASE_PATH}`)
  } catch (error) {
    return refuse(error)
  }
  let candidate
  try {
    candidate = parseTag(release?.tag_name)
  } catch (error) {
    return refuse(error)
  }

  // Gates 1c + 2: strictly newer, and the consent policy on top of that.
  const decision = decideUpdate({ currentVersion, tag: release.tag_name, autoApply: currentAutoApply, consents: humanConsents })
  if (decision.status === 'up-to-date') {
    return finish(
      { status: 'up-to-date', code: null, current: currentVersion, latest: candidate.version, lastCheckAt: now.toISOString(), staged: null, message: decision.reason ?? null },
      { action: 'check', result: 'up-to-date', digest: null, code: null },
    )
  }
  const needsConsent = decision.status === 'needs-consent'

  // Gate 3: both assets.
  let pair
  try {
    pair = requireAssetPair(release, { version: candidate.version, base: base.base })
  } catch (error) {
    return refuse(error, { patch: { current: currentVersion, latest: candidate.version, lastCheckAt: now.toISOString(), authorship: null } })
  }

  // Gate 4/5: checksum file, then the measured digest of the archive.
  let staging
  try {
    staging = prepareStaging({ stateRoot, version: candidate.version })
  } catch (error) {
    return refuse(error, { patch: { current: currentVersion, latest: candidate.version, lastCheckAt: now.toISOString(), authorship: null } })
  }
  let authorship = null
  try {
    const sumsBytes = Buffer.from(await fetchBytes(pair.sumsUrl))
    assertDeclaredBytes(pair.sumsName, sumsBytes.length, pair.sumsBytes)
    const sumsText = sumsBytes.toString('utf8')

    // Gate 8: who published this? Asked here — after the checksum file is in
    // hand (its bytes are what the signature covers) and before the archive is
    // downloaded, let alone unpacked, run, or believed by any later gate. §8.2's
    // rule is that nothing from the staged tree executes before the
    // network-verifiable gates, and the tree's own guard script (gate 6) is the
    // only thing in this file that executes anything.
    //
    // Reverse mutation: delete this block — every `--auto` run in
    // `test/check.test.mjs` that stages an unsigned release goes red, and so does
    // `an unsigned release refuses the scheduled run and stages nothing`, which is
    // the sentence that proves the gate exists.
    const signature = await verifyReleaseSignature({
      version: candidate.version,
      sumsName: pair.sumsName,
      sumsText,
      signatureAsset: findSignatureAsset(release, { version: candidate.version, base: base.base }),
      stateRoot,
      stagingDir: staging.dir,
      fetchBytes,
      runGpg: signatureOpts.runner,
      loadAnchor: signatureOpts.loadAnchor,
      log,
    })
    authorship = {
      version: candidate.version,
      signature: signature.outcome,
      signedAsset: signature.signedAsset,
      keyFingerprint: signature.keyFingerprint,
      consented: signature.outcome !== 'verified' && humanConsents.includes(UNSIGNED_CONSENT_KIND),
      at: now.toISOString(),
    }
    if (signature.outcome !== 'verified') {
      // `invalid` is outside the consent question entirely: the ordering of this
      // condition *is* the policy — a bad signature refuses whether or not a human
      // offered `--consent unsigned-release`. The two "the proof is simply absent"
      // states are the ones a person may accept, and only a person: the scheduled
      // run never carries the flag.
      const humanAccepted = humanConsents.includes(UNSIGNED_CONSENT_KIND)
      if (signature.outcome === 'invalid' || !humanAccepted) {
        // The scheduled run that was *offered* a consent has to be told its offer was not
        // used, otherwise the state file reads like nobody was asked.
        const scheduled = trigger === 'auto' && consents.length > 0
          ? ' This run came in as the scheduled run (--auto), so the consent given on its command line was not used: a schedule cannot accept on a person\'s behalf.'
          : ''
        throw new UpdaterError(signature.code, `${signature.message}${scheduled}`)
      }
    }

    const expected = digestFor(sumsText, pair.tarballName, { source: pair.sumsName })
    const archive = Buffer.from(await fetchBytes(pair.tarballUrl))
    assertDeclaredBytes(pair.tarballName, archive.length, pair.tarballBytes)
    writeArchive(staging.archivePath, archive, { stagingRoot: roots.staging })
    const verified = await verifyArchiveDigest({
      filePath: staging.archivePath,
      expected,
      stagingDir: staging.dir,
      allowedStagingRoot: roots.staging,
    })
    log(`digest measured ${verified.digest} for ${pair.tarballName}`)

    // Gates 7 and 8 before anything of the tree's is *run*: both need only the
    // network, so they are network-verifiable claims about the bytes, while gate 6
    // executes a script that came inside the archive. Asking them in the other
    // order means an unverified release gets to run code on this machine first and
    // be disbelieved afterwards (§8.8). Reverse mutation: move the
    // `verifyCiGreen` call below `selfCheckStagedTree` (the previous order) —
    // `a release the CI gate refuses never has its staged code executed` goes red
    // on the execution marker the fixture leaves behind, and
    // `an unsigned release …` reddens for gate 8 the same way.
    const ci = await verifyCiGreen({ release, base: base.base, fetchJson })
    log(`ci run ${ci.run?.id ?? '?'} (${ci.run?.name ?? 'unnamed'}) is green on main for ${ci.headSha.slice(0, 7)} (from ${ci.shaSource})`)

    // Gate 6: the unpacked tree proves its own version line — and this is the one
    // gate that *executes* staged content, so it comes last.
    extractInto({ treePath: staging.treePath, stagingRoot: roots.staging, bytes: archive })
    const treeRoot = releaseTreeRoot({ treePath: staging.treePath, version: candidate.version })
    if (!treeRoot.ok) {
      throw new UpdaterError(
        CODES.versionLineBroken,
        `${staging.treePath} is not shaped like a GlassPane release (${treeRoot.reason}), so its version line cannot be checked and the tree was discarded`,
      )
    }
    const selfCheck = selfCheckStagedTree(treeRoot.rootPath, candidate.version, selfCheckOpts)
    if (!selfCheck.ok) throw new UpdaterError(selfCheck.code, selfCheck.message)

    const stagedRecord = { version: candidate.version, dir: staging.dir, digest: verified.digest, at: now.toISOString() }
    // A release that got here without authorship proof keeps advertising that
    // fact: the standing note is stamped as `code` + `lastError.message` (§4
    // prints those verbatim in the panel and in `gp_diagnose`) for as long as the
    // offer stands, instead of dissolving into a clean `staged` row.
    const standing = authorshipNote(authorship, 'staged')
    const code = needsConsent ? decision.code : standing?.code ?? null
    const message = [needsConsent ? decision.reason : null, standing?.message ?? null]
      .filter((line) => typeof line === 'string' && line !== '')
      .join(' ')
      // A clean stage has to say so out loud. Without this the sentence is `''`, and `updater check` on a
      // machine that just staged an update printed `check: ` and nothing else — which reads like the command
      // produced no answer, when the honest answer is "there is one, and here is what to press" (found by
      // running the real thing on 2026-10-01, right after the first successful 1.6.0 update).
      || `staged ${candidate.version} (sha256 ${verified.digest.slice(0, 12)}); press "Install update" or run "updater apply"`
    return finish(
      {
        status: needsConsent ? 'needs-consent' : 'staged',
        code,
        current: currentVersion,
        latest: candidate.version,
        lastCheckAt: now.toISOString(),
        staged: stagedRecord,
        authorship,
        lastError: null,
        autoApply: currentAutoApply,
        message,
      },
      { action: 'check', result: needsConsent ? 'needs-consent' : 'staged', digest: verified.digest, code },
    )
  } catch (error) {
    // Any gate from here on has already deleted its own staging (digest
    // mismatch does it in `verifyArchiveDigest`); belt and braces for the rest.
    //
    // The `catch {}` that used to sit here — commented "nothing there to discard" — is why this machine
    // still has an empty `update-staging/1.12.0/` under the refusal of 2026-10-11: a discard that failed was
    // swallowed, and the record went on claiming the tree had been thrown away. `discardStaging` now
    // answers in data, and anything it could not remove is added to the sentence the panel prints.
    const discarded = safeDiscard({ stateRoot, dir: staging.dir })
    const discardNote = discarded.ok === true
      ? null
      : `. This run could not throw its own staged bytes away: ${discarded.reason}. Nothing was installed, `
        + 'but the disk it left behind is real — re-run "updater check" (which re-stages into the same place), '
        + `and if ${discarded.dir} is still there after that, that directory is the thing to fix`
    // A filesystem error *inside this run's own staging directory* is a second run's doing, and the raw
    // errno is not the cause a person can act on. See `stagingRaceCause`.
    const raced = stagingRaceCause(error, { dir: staging.dir, staging: roots.staging, version: candidate.version })
    const reported = errorWithNote(raced ?? error, discardNote)
    // Gate 8's two "proof is missing" states are refusals a person can overrule,
    // so they are `needs-consent`, not `check-failed`: the panel keeps the reason
    // on screen with a live check button, and `apply` still sees no staged tree.
    // `signature-invalid` is not in the set and stays a plain check failure.
    const status = AUTHORSHIP_CONSENT_CODES.has(error?.code) ? 'needs-consent' : 'check-failed'
    return refuse(reported, {
      status,
      patch: { current: currentVersion, latest: candidate.version, lastCheckAt: now.toISOString(), staged: null, authorship },
    })
  }
}

/**
 * The discard may not add a second failure on top of the one being reported.
 *
 * `discardStaging` answers in data for anything that did not delete; the one throw left in it is the path
 * guard, and a guard firing here must still come out as *this* refusal plus a stated leftover, not as an
 * exception that reaches `cli.js`'s generic handler with no gate sentence at all.
 */
function safeDiscard(options) {
  try {
    return discardStaging(options)
  } catch (error) {
    return { ok: false, dir: options.dir ?? null, reason: `throwing the staged tree away was refused (${error?.message ?? String(error)})` }
  }
}

/**
 * One refusal, one sentence, and the leftovers in it.
 *
 * Appending to the *returned* message only would be the dishonest half of the pair: `lastError.message` is
 * what the panel and `gp_diagnose` print, so the note has to be part of the error the state is stamped
 * from. The code, the details and the TLS flag of the original refusal are carried over untouched — this
 * adds a fact, it does not re-decide one.
 */
function errorWithNote(error, note) {
  if (note === null || error === null || error === undefined) return error
  const wrapped = new UpdaterError(
    error instanceof UpdaterError ? error.code : CODES.checkFailed,
    `${error.message ?? ''}${note}`,
    error.details ?? null,
  )
  wrapped.tlsVerification = error.tlsVerification === true
  return wrapped
}

/**
 * The one failure shape this file could not name before: `ENOENT … update-staging/1.4.1/archive.tar.gz`.
 *
 * Two runs staging the *same* version share one directory — the panel's Install button and the daily job
 * both fetch what is the latest release — so whichever refuses first throws away the tree the other is still
 * writing. Measured on this machine on 2026-10-11: a `check-failed / version-line-broken` row over an empty
 * `update-staging/1.12.0/`, which is the same event read from the losing side. An errno is honest about the
 * syscall and silent about the cause, and a silent cause is the defect this repo already named for gpg (a
 * PATH problem reported as a permissions problem): the reader is sent to the wrong door.
 *
 * **`EPERM`/`EACCES` are not that event, and used to be told as if they were.** The shared-directory story
 * explains a file that vanished; it does not explain a syscall that was *denied*, and a denied one has at
 * least two authors this run cannot tell apart from the errno alone: an immutable flag set on the tree
 * (`uchg`, which an installer or a hand `chflags` leaves behind and which root cannot delete either), or a
 * directory owned by somebody else. Naming "the usual author" for those is the same unmeasured cause this
 * batch set out to remove, so they get the two facts that *were* measured — the errno and the path — the
 * possibilities as possibilities, and the one command that distinguishes them.
 *
 * Only a raw filesystem error about a path under *this run's* staging directory is re-told here. An
 * `UpdaterError` already names its own gate, keeps its own code, and is left exactly as it is.
 */
export function stagingRaceCause(error, { dir, staging, version }) {
  const code = error?.code
  const isDenied = code === 'EPERM' || code === 'EACCES'
  if (!isDenied && code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EEXIST') return null
  if (error instanceof UpdaterError) return null
  const text = String(error?.message ?? '')
  if (!text.includes(staging) && !text.includes(dir)) return null
  const where = text.includes(dir) ? dir : staging
  const refused = isDenied
    ? new UpdaterError(
      CODES.checkFailed,
      `the update run was denied by the filesystem while it worked on ${where}: ${code}: ${text}. `
        + 'Nothing about that answer identifies who denied it, and the two candidates have different repairs: the tree may carry an '
        + 'immutable flag (a `uchg` makes even the owner\'s `unlink` an `EPERM`), or it may belong to another account or mode. Tell them apart '
        + `before retrying — "ls -lO ${where}" shows the flags (look for \`uchg\`/\`schg\`; "chflags -R nouchg" is what clears one), and `
        + `"stat -f 'owner %Su group %Sg mode %Sp flags %Sf' ${where}" shows who owns it and what mode it has. `
        + `If neither points at the directory, whatever else on this machine holds ${where} open is the thing to fix. `
        + `Nothing was kept and no version was offered: nothing was installed, and re-run "updater check" once the flags or the owner `
        + 'are the ones this account can write.',
    )
    : new UpdaterError(
      CODES.checkFailed,
      `the bytes this run was staging under ${dir} moved while it worked (${code}: ${text}) — `
        + `the usual author of that is a second update run for ${version} in the same directory: the GlassPane panel's "Install update" and the daily job fetch the same release, `
        + 'and whichever one refuses first throws the shared tree away (the other cause is a hand-cleaned update-staging/). '
        + 'Nothing was kept and no version was offered: run "updater check" again on its own, and leave the other run\'s directory alone while it works.',
    )
  refused.tlsVerification = error?.tlsVerification === true
  return refused
}

/** Wrap a synchronous gate that may refuse, keeping the refusal as data. */
function safeGate(fn, fallback) {
  try {
    return fn()
  } catch (error) {
    return { ...fallback, thrown: error }
  }
}

export { REPO_SLUG, UPDATE_BASE_ENV }
export const CHECK_FAILED = 'check-failed'

/** The pointer half of §7: is the installer's record of us still usable? */
export function pointerCheck(stateRoot) {
  return readPointer(stateRoot)
}
