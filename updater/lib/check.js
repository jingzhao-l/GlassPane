/**
 * `updater check`: the seven gates of spec §1, in the order the spec lists
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
 *
 * Authorship is *not* claimed: the tag is unsigned, so gates 4–7 buy integrity,
 * version consistency and build traceability, not proof that the bytes came
 * from the repository owner. That is why the digest is kept in the state file
 * for a human to compare against the web UI, and why majors need a button
 * press (see README, "what this does not do").
 */
import { CODES } from './codes.js'
import { UpdaterError, writableRoots } from './fsutil.js'
import { DEFAULT_BASE, REPO_SLUG, UPDATE_BASE_ENV, resolveBase } from './source.js'
import { localVersion, parseTag } from './version.js'
import { decideUpdate } from './policy.js'
import { requireAssetPair } from './assets.js'
import { digestFor } from './sums.js'
import { verifyArchiveDigest } from './digest.js'
import { discardStaging, extractInto, prepareStaging, releaseTreeRoot, writeArchive } from './staging.js'
import { selfCheckStagedTree } from './selfcheck.js'
import { verifyCiGreen } from './ci.js'
import { loadState, nextState, saveState } from './state.js'
import { readPointer } from './state.js'

export const RELATIVE_RELEASE_PATH = '/releases/latest'

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
  log = () => {},
} = {}) {
  const roots = writableRoots(stateRoot)
  const previous = loadState(stateRoot).state
  const currentAutoApply = autoApply ?? previous.autoApply
  const base = safeGate(() => resolveBase({ ...env }), { base: DEFAULT_BASE, origin: new URL(DEFAULT_BASE).origin })

  const finish = (patch, historyEntry) => {
    const merged = nextState(previous, { ...patch, historyEntry }, { now })
    if (save) saveState(stateRoot, merged, { now })
    return {
      ok: patch.status === 'staged' || patch.status === 'available' || patch.status === 'up-to-date' || patch.status === 'applied',
      status: patch.status,
      code: patch.code ?? null,
      message: patch.message ?? null,
      latest: patch.latest ?? previous.latest,
      current: patch.current ?? previous.current,
      // Off the *merged* document, not `patch.staged ?? previous.staged`: a
      // refusal clears the field by setting it to `null`, and `??` reads a
      // deliberate null as "absent, keep the old one" — which is how a refused
      // check used to hand a stale tree straight to `apply`.
      staged: merged.staged,
      state: merged,
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
  const decision = decideUpdate({ currentVersion, tag: release.tag_name, autoApply: currentAutoApply, consents })
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
    return refuse(error, { patch: { current: currentVersion, latest: candidate.version, lastCheckAt: now.toISOString() } })
  }

  // Gate 4/5: checksum file, then the measured digest of the archive.
  let staging
  try {
    staging = prepareStaging({ stateRoot, version: candidate.version })
  } catch (error) {
    return refuse(error, { patch: { current: currentVersion, latest: candidate.version, lastCheckAt: now.toISOString() } })
  }
  try {
    const sumsText = Buffer.from(await fetchBytes(pair.sumsUrl)).toString('utf8')
    const expected = digestFor(sumsText, pair.tarballName, { source: pair.sumsName })
    const archive = Buffer.from(await fetchBytes(pair.tarballUrl))
    writeArchive(staging.archivePath, archive, { stagingRoot: roots.staging })
    const verified = await verifyArchiveDigest({
      filePath: staging.archivePath,
      expected,
      stagingDir: staging.dir,
      allowedStagingRoot: roots.staging,
    })
    log(`digest measured ${verified.digest} for ${pair.tarballName}`)

    // Gate 7 before anything of the tree's is *run*: it needs only the network,
    // so it is a network-verifiable claim about the bytes, while gate 6 executes
    // a script that came inside the archive. Asking them in the other order means
    // an unverified release gets to run code on this machine first and be
    // disbelieved afterwards. Reverse mutation: move the `verifyCiGreen` call
    // below `selfCheckStagedTree` (the previous order) —
    // `a release the CI gate refuses never has its staged code executed` goes red
    // on the execution marker the fixture leaves behind.
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
    return finish(
      {
        status: needsConsent ? 'needs-consent' : 'staged',
        code: needsConsent ? decision.code : null,
        current: currentVersion,
        latest: candidate.version,
        lastCheckAt: now.toISOString(),
        staged: stagedRecord,
        lastError: null,
        autoApply: currentAutoApply,
        message: needsConsent ? decision.reason : null,
      },
      { action: 'check', result: needsConsent ? 'needs-consent' : 'staged', digest: verified.digest, code: needsConsent ? decision.code : null },
    )
  } catch (error) {
    // Any gate from here on has already deleted its own staging (digest
    // mismatch does it in `verifyArchiveDigest`); belt and braces for the rest.
    try {
      discardStaging({ stateRoot, dir: staging.dir })
    } catch {
      /* nothing there to discard */
    }
    return refuse(error, {
      patch: { current: currentVersion, latest: candidate.version, lastCheckAt: now.toISOString(), staged: null },
    })
  }
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
