/**
 * Spec §1 gate 0: where a release may be fetched from, and the HTTP that talks
 * to it.
 *
 * The repository slug is a **constant**. `GLASSPANE_UPDATE_BASE` may only swap
 * the *host*, and only to `https` or to loopback for tests; pointing it at a
 * cleartext host refuses the check outright instead of quietly downgrading,
 * because a downgraded fetch is a silent man-in-the-middle on the exact channel
 * this subsystem has to trust.
 */
import process from 'node:process'

import { CODES } from './codes.js'
import { UpdaterError } from './fsutil.js'

/** Pinned repository. Not overridable by argument, env, or release payload. */
export const REPO_SLUG = 'jingzhao-l/GlassPane'
export const DEFAULT_BASE = `https://api.github.com/repos/${REPO_SLUG}`
export const UPDATE_BASE_ENV = 'GLASSPANE_UPDATE_BASE'
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1', 'localhost'])

/**
 * Resolve the base URL for the release API from the environment.
 * Returns `{ base, origin, insecureAllowed }`; throws on anything that would
 * make the trust chain vacuous.
 */
export function resolveBase(env = process.env) {
  const raw = (env[UPDATE_BASE_ENV] ?? '').trim()
  if (raw === '') return { base: DEFAULT_BASE, origin: new URL(DEFAULT_BASE).origin, overridden: false }

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new UpdaterError(CODES.sourceShape, `${UPDATE_BASE_ENV}=${JSON.stringify(raw)} is not an absolute URL; refusing to check rather than guessing a source`)
  }
  if (url.username || url.password) {
    throw new UpdaterError(CODES.sourceShape, `${UPDATE_BASE_ENV} must not carry credentials in the URL`)
  }
  const loopback = LOOPBACK_HOSTS.includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new UpdaterError(
      CODES.sourceInsecure,
      `${UPDATE_BASE_ENV}=${JSON.stringify(raw)} uses ${url.protocol}//${url.hostname}`
        + ' and is not a loopback address: a cleartext update source can be rewritten in flight, '
        + 'so the check is refused instead of downgraded',
    )
  }
  // Any https host is allowed (the spec's "换成 https"): a self-built mirror is
  // a legitimate answer. What is *not* allowed is for the override to choose
  // the repository — that stays this module's constant.
  const pathPrefix = url.pathname.replace(/\/+$/, '')
  if (pathPrefix.includes(REPO_SLUG) || /(^|\/)repos(\/|$)/.test(pathPrefix)) {
    throw new UpdaterError(
      CODES.sourceShape,
      `${UPDATE_BASE_ENV} must name a host (optionally an API prefix such as /api/v3), not a repository path: ${REPO_SLUG} is pinned by this tool and cannot be replaced by an environment variable`,
    )
  }
  // Only the origin (and an optional API prefix) is taken from the environment;
  // the repository segment is always this module's constant.
  const base = `${url.protocol}//${url.host}${pathPrefix}/repos/${REPO_SLUG}`
  return { base, origin: url.origin, overridden: true }
}

/**
 * The policy every downloaded asset URL passes: the same origin as the pinned
 * base, **or** a release-download URL of the pinned repository on a host GitHub
 * actually serves releases from — always over https. A release payload is *data
 * from the source*; letting it name an arbitrary host would let the thing we are
 * verifying decide where its bytes come from.
 *
 * WHY THE ORIGIN RULE CANNOT BE THE WHOLE RULE (found by running `check` on a real
 * machine the first time a newer release existed, 2026-09-29): `GET releases/latest`
 * answers with `browser_download_url = https://github.com/<owner>/<repo>/releases/
 * download/<tag>/<file>` — origin `https://github.com`, while the pinned base is
 * `https://api.github.com/repos/<owner>/<repo>`. Requiring same-origin alone therefore
 * refused **every real release**: the code had been green only because every fixture
 * invented `api.github.com/.../releases/download/…`, a path GitHub does not use. A
 * fixture-shaped input that bypasses the shape of the real payload is not a test of the
 * contract; it is a test of the fixture.
 *
 * The widening is bounded by three facts, all of them checked: the base must still be the
 * pinned GitHub API host (an operator-set `GLASSPANE_UPDATE_BASE` mirror gets strict
 * same-origin and nothing else), the host must be one of the explicitly pinned GitHub
 * release hosts (no `*.github.com.evil.test` suffix tricks), and the *path* must carry the
 * pinned `REPO_SLUG` in one of the two shapes GitHub produces — so a payload cannot steer
 * the bytes at someone else's repository.
 *
 * Loopback is still **not** a free exception: it is a property of the *base*, because the
 * only reason a `http://127.0.0.1:<port>` asset exists is the fixture that also serves the
 * release. The previous form derived `loopback` from the **asset's own host** and skipped
 * the origin comparison for it, so a payload could point the bytes at any local (and one
 * character away, any routable) listener while the base was still https GitHub. Reverse
 * mutation: derive `loopback` from `url.hostname` and guard the origin comparison with it —
 * `a release asset cannot name an insecure or off-origin host` and `a loopback base is the
 * only thing that makes a loopback asset legal` both go red.
 */
export function assertAssetUrl(candidate, { base }) {
  let url
  try {
    url = new URL(String(candidate))
  } catch {
    throw new UpdaterError(CODES.assetHostUnpinned, `release asset URL ${JSON.stringify(candidate)} is not a usable absolute URL`)
  }
  let baseLoopback = false
  let baseOrigin = null
  let baseHost = null
  if (base) {
    const baseUrl = new URL(String(base))
    baseLoopback = LOOPBACK_HOSTS.includes(baseUrl.hostname)
    baseOrigin = baseUrl.origin
    baseHost = baseUrl.hostname
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && baseLoopback)) {
    throw new UpdaterError(
      CODES.assetHostUnpinned,
      `release asset ${url.href} is served over ${url.protocol}//${url.hostname}: only https (or loopback, and only when the update base itself is the loopback test source) is accepted, so this release is refused rather than downloaded insecurely`,
    )
  }
  if (baseOrigin && url.origin !== baseOrigin) {
    const onPinnedGitHub = PINNED_API_HOSTS.includes(baseHost)
      && url.protocol === 'https:'
      && GITHUB_DOWNLOAD_HOSTS.includes(url.hostname)
      && assetPathNamesPinnedRelease(url.pathname)
    if (!onPinnedGitHub) {
      throw new UpdaterError(
        CODES.assetHostUnpinned,
        `release asset ${url.href} is neither on the pinned update origin ${baseOrigin} nor a ${REPO_SLUG} release URL on a pinned GitHub host: the payload names where its own bytes come from, so an off-family host, another repository, or a mirror that was not given as the update base is refused instead of downloaded`,
      )
    }
  }
  // Same-origin is not enough on the pinned API host either: `api.github.com` carries
  // *every* repository's API, so a payload naming `/repos/<someone-else>/…` or a path
  // that is not one of the two shapes GitHub produces for this release must still fail.
  // (URL normalization silently eats `..`, which is exactly why the shape is checked on
  // the decoded pathname rather than on the string that came in.)
  if (PINNED_API_HOSTS.includes(baseHost) && url.protocol === 'https:' && !assetPathNamesPinnedRelease(url.pathname)) {
    throw new UpdaterError(
      CODES.assetHostUnpinned,
      `release asset ${url.href} is on the pinned host but is not a ${REPO_SLUG} release download or source-archive path: this tool only fetches the release it names`,
    )
  }
  return url.href
}

/**
 * The two URL shapes a GitHub release payload really names, each with the pinned
 * repository slug in it: an uploaded asset (`/<slug>/releases/download/<tag>/<file>`)
 * and the source archive (`/repos/<slug>/{tarball,zipball}/<ref>`). Anything else —
 * including a GitHub host serving somebody else's release — fails here.
 */
export function assetPathNamesPinnedRelease(pathname) {
  const path = decodeURIComponent(String(pathname ?? ''))
  const slug = REPO_SLUG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|/)${slug}/releases/download/[^/]+/[^/]+$`).test(path)
    || new RegExp(`(?:^|/)repos/${slug}/(?:tarball|zipball)/[^/]+$`).test(path)
}

/**
 * The API host this tool pins by default. Kept separate from GITHUB_DOWNLOAD_HOSTS:
 * an operator-supplied mirror base must not gain the release-host widening, or
 * `GLASSPANE_UPDATE_BASE` would become a way to *broaden* which hosts a payload may
 * name rather than a way to point at a mirror of the same shape.
 */
export const PINNED_API_HOSTS = Object.freeze(['api.github.com'])

/**
 * Hosts a GitHub release download may legally land on after the redirect GitHub
 * itself issues. Pinned as an explicit set: `*.githubusercontent.com` is a
 * suffix, and a suffix is one careless `endsWith` away from
 * `objects.githubusercontent.com.evil.test`.
 */
export const GITHUB_DOWNLOAD_HOSTS = Object.freeze([
  'api.github.com',
  'github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'media.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-cloud.githubusercontent.com',
])

/**
 * The check a `redirect: 'follow'` transport has to make *after* the fact: the
 * bytes that landed came from where they were verified to come from. Without it
 * a payload-supplied URL on the pinned host that answers 302 to anywhere else
 * puts somebody else's tarball into the staging directory, and every digest gate
 * downstream happily measures *those* bytes.
 *
 * A loopback test source may not hop hosts either — the fixture server answers
 * on one port, and a redirect off it is not a test.
 */
export function assertRedirectTarget(finalHref, { requested }) {
  const text = String(finalHref ?? '')
  if (text === '') return requested
  let final
  let from
  try {
    final = new URL(text)
    from = new URL(String(requested))
  } catch {
    throw new UpdaterError(CODES.downloadHostUnpinned, `the download of ${requested} ended at ${JSON.stringify(finalHref)}, which is not a readable URL`)
  }
  if (final.origin === from.origin) return final.href
  const fromPinned = GITHUB_DOWNLOAD_HOSTS.includes(from.hostname)
  const toPinned = GITHUB_DOWNLOAD_HOSTS.includes(final.hostname)
  if (fromPinned && toPinned && final.protocol === 'https:') return final.href
  throw new UpdaterError(
    CODES.downloadHostUnpinned,
    `the download of ${requested} was redirected to ${final.href}, which is not the pinned update host (${from.hostname}): refusing to stage bytes that did not come from the release`,
  )
}

/** Default transport: global fetch. Injectable so tests can *not* reach the internet. */
/**
 * Where a transport failure is really about **trust**, not about the network.
 *
 * Why this exists as its own thing: node verifies TLS against the CA bundle
 * compiled into it and never consults the macOS trust store, so on a machine whose
 * HTTPS is intercepted (corporate gateway, local accelerator) `fetch` rejects a
 * chain that `curl`, `git` and `gh` all accept on the same host. Reporting that as
 * `GET … failed: fetch failed` sends whoever reads it off to check their network
 * connection — which is fine — while the updater fails every single day. The cause
 * code is the difference between those two sentences, so it goes into the message
 * and the remedy goes next to it.
 */
const TLS_VERIFICATION_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

export function isTlsVerificationFailure(code) {
  return typeof code === 'string' && TLS_VERIFICATION_CODES.has(code)
}

/**
 * Turns a thrown transport error into (message, details). A non-TLS failure keeps
 * its own reason and gets **no** certificate remedy — handing an operator a
 * plausible-looking fix for a problem they do not have is how a remedy becomes a
 * new source of confusion.
 */
export function describeTransportFailure(url, error, { caBundlePath = null } = {}) {
  const cause = error && typeof error === 'object' ? error.cause : null
  const code = cause && typeof cause.code === 'string' ? cause.code : null
  const causeText = cause && typeof cause.message === 'string' && cause.message.trim() !== '' ? cause.message.trim() : null
  const own = error && typeof error.message === 'string' && error.message.trim() !== '' ? error.message.trim() : String(error)
  const head = `GET ${url} failed: ${own}${code ? ` (${code}${causeText ? `: ${causeText}` : ''})` : ''}`
  if (!isTlsVerificationFailure(code)) return { message: head, details: null, tlsVerification: false }
  const remedy = caBundlePath
    ? `node trusts only the CA bundle compiled into it and does not read the macOS keychain, so a machine whose HTTPS is intercepted by a locally trusted root needs that root handed to it: export NODE_EXTRA_CA_CERTS=${caBundlePath} (if that file does not exist yet, re-run the installer or "updater enable" — either exports the machine's own root bundle; nothing verifies less by doing this, it adds the roots this machine's administrator already trusts).`
    : `node trusts only the CA bundle compiled into it and does not read the macOS keychain, so a machine whose HTTPS is intercepted needs its own root bundle exported: run the installer or "updater enable", then point NODE_EXTRA_CA_CERTS at the ca-roots.pem inside your update state root ("updater status --json" names that directory in its stateRoot field).`
  // 结构化地说"这是证书类失败"：下游的自愈分支必须读这个布尔，而不是去匹配我写的句子
  // （文案会改，判据不能跟着改）。
  return { message: head, details: remedy, tlsVerification: true }
}

/**
 * A refused HTTP answer, worded so it can be acted on. `statusText` is empty on
 * plenty of real servers (and undefined on anything that is not a Response), so
 * printing it unconditionally produced "answered undefined undefined" — a message
 * that names neither the status nor the fact that the server did answer.
 */
function answered(url, response) {
  const status = Number.isInteger(response && response.status) ? String(response.status) : 'with no status'
  const text = response && typeof response.statusText === 'string' && response.statusText.trim() !== '' ? ` ${response.statusText.trim()}` : ''
  return `GET ${url} answered ${status}${text}`
}

export function makeFetcher(fetchImpl = globalThis.fetch, { timeoutMs = 20_000, caBundlePath = null } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new UpdaterError(CODES.sourceShape, 'no fetch implementation available on this runtime (Node >= 18 required)')
  }
  return async function fetchJson(url, { headers = {} } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'glasspane-updater', ...headers },
      })
      if (!response.ok) {
        throw new UpdaterError(CODES.releaseUnreachable, answered(url, response))
      }
      // The transport follows redirects, so the URL it *ended* at is the only
      // evidence of where the bytes came from. Checked before the body is read.
      assertRedirectTarget(response.url, { requested: url })
      return await response.json()
    } catch (error) {
      if (error instanceof UpdaterError) throw error
      const { message, details, tlsVerification } = describeTransportFailure(url, error, { caBundlePath })
      const wrapped = new UpdaterError(CODES.releaseUnreachable, message, details)
      wrapped.tlsVerification = tlsVerification === true
      throw wrapped
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Binary transport (tarball / SUMS file). Returns bytes; never text-decodes.
 *
 * Two different clocks, because the release archive is ~24 MiB (measured: 25,126,902
 * bytes for v1.5.1) and a single total-time cap cannot tell "slow but alive" from
 * "dead connection". The old 120s cap did neither: on a loaded/proxied link it aborted
 * a *progressing* download ("GET … failed: This operation was aborted" — seen on a real
 * machine 2026-09-29, 39s uncontended, >120s under contention), and the message named
 * neither the deadline nor how much had arrived, so nobody could tell a stalled proxy
 * from a broken network.
 *
 *  · `stallMs` — no bytes at all for this long ⇒ refuse. This is the **sharper** guard:
 *    a dead connection is now caught in 30s instead of being confused with a slow one.
 *  · `timeoutMs` — an overall ceiling so a trickling server cannot hold the daily job
 *    open forever. Raising it is not an accommodation: the stall clock is what decides
 *    liveness, and both outcomes say which fired and how many bytes arrived.
 */
export const DOWNLOAD_STALL_MS = 30_000
export const DOWNLOAD_CEILING_MS = 900_000

const humanBytes = (n) => (n >= 1024 * 1024
  ? `${(n / (1024 * 1024)).toFixed(1)} MiB`
  : `${(n / 1024).toFixed(0)} KiB`)

export function makeBytesFetcher(fetchImpl = globalThis.fetch, {
  timeoutMs = DOWNLOAD_CEILING_MS,
  stallMs = DOWNLOAD_STALL_MS,
  caBundlePath = null,
} = {}) {
  return async function fetchBytes(url) {
    const controller = new AbortController()
    let fired = null
    let received = 0
    let stallTimer = null
    const armStall = () => {
      if (!(stallMs > 0)) return
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        fired = 'stall'
        controller.abort()
      }, stallMs)
    }
    const ceiling = setTimeout(() => {
      fired = 'ceiling'
      controller.abort()
    }, timeoutMs)
    armStall()
    try {
      const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'glasspane-updater' } })
      if (!response.ok) {
        throw new UpdaterError(CODES.releaseUnreachable, answered(url, response))
      }
      assertRedirectTarget(response.url, { requested: url })
      if (!response.body || typeof response.body.getReader !== 'function') {
        const once = new Uint8Array(await response.arrayBuffer())
        received = once.length
        return once
      }
      const reader = response.body.getReader()
      const chunks = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length) {
          chunks.push(value)
          received += value.length
          armStall()
        }
      }
      return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
    } catch (error) {
      if (error instanceof UpdaterError) throw error
      if (fired) {
        const why = fired === 'stall'
          ? `no bytes arrived for ${Math.round(stallMs / 1000)}s after ${humanBytes(received)} had been received`
          : `the whole download did not finish within ${Math.round(timeoutMs / 1000)}s with ${humanBytes(received)} received`
        throw new UpdaterError(
          CODES.releaseUnreachable,
          `GET ${url} was stopped: ${why}. The release is refused and nothing partial is staged, so the next run starts from a clean slate`,
        )
      }
      const { message, details, tlsVerification } = describeTransportFailure(url, error, { caBundlePath })
      const wrapped = new UpdaterError(CODES.releaseUnreachable, message, details)
      wrapped.tlsVerification = tlsVerification === true
      throw wrapped
    } finally {
      clearTimeout(stallTimer)
      clearTimeout(ceiling)
    }
  }
}
