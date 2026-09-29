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
 * The policy every downloaded asset URL passes: same-origin with the pinned
 * base, over https. A release payload is *data from the source*; letting it name
 * an arbitrary cleartext host would let the thing we are verifying decide
 * where its bytes come from.
 *
 * Loopback is **not** a free exception on its own: it is a property of the
 * *base*, because the only reason a `http://127.0.0.1:<port>` asset exists is
 * the test fixture that also serves the release. The previous form derived
 * `loopback` from the **asset's own host** and then skipped the origin
 * comparison for it, so a release payload could point the bytes at any local
 * (and one character away, any routable) listener while the base was still
 * https GitHub. Reverse mutation: derive `loopback` from `url.hostname` and
 * guard the origin comparison with it — `a release asset cannot name an
 * insecure or off-origin host` and `a loopback base is the only thing that
 * makes a loopback asset legal` both go red.
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
  if (base) {
    const baseUrl = new URL(String(base))
    baseLoopback = LOOPBACK_HOSTS.includes(baseUrl.hostname)
    baseOrigin = baseUrl.origin
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && baseLoopback)) {
    throw new UpdaterError(
      CODES.assetHostUnpinned,
      `release asset ${url.href} is served over ${url.protocol}//${url.hostname}: only https (or loopback, and only when the update base itself is the loopback test source) is accepted, so this release is refused rather than downloaded insecurely`,
    )
  }
  if (baseOrigin && url.origin !== baseOrigin) {
    // GitHub redirects *after* the request to objects.githubusercontent.com;
    // the *named* URL in the payload still has to be the pinned API origin.
    throw new UpdaterError(
      CODES.assetHostUnpinned,
      `release asset ${url.href} is not on the pinned update origin ${baseOrigin}`,
    )
  }
  return url.href
}

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
    : `node trusts only the CA bundle compiled into it and does not read the macOS keychain, so a machine whose HTTPS is intercepted needs its own root bundle exported: run the installer or "updater enable", then point NODE_EXTRA_CA_CERTS at <stateRoot>/ca-roots.pem.`
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

/** Binary transport (tarball / SUMS file). Returns bytes; never text-decodes. */
export function makeBytesFetcher(fetchImpl = globalThis.fetch, { timeoutMs = 120_000, caBundlePath = null } = {}) {
  return async function fetchBytes(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'glasspane-updater' } })
      if (!response.ok) {
        throw new UpdaterError(CODES.releaseUnreachable, answered(url, response))
      }
      assertRedirectTarget(response.url, { requested: url })
      return new Uint8Array(await response.arrayBuffer())
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
