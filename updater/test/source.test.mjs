/**
 * §6 row "源只能是 https/pinned".
 *
 * REVERSE MUTATION: relax the https rule (accept `http:` for any host, i.e.
 * "downgrade instead of refuse") — `a cleartext host refuses: the check does not
 * downgrade` and `https is required` both go red.
 * Second mutation: let `GLASSPANE_UPDATE_BASE` choose the repository (honour the
 * path in the override) — `the repository slug stays pinned even when the base
 * names a different path` goes red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_BASE, REPO_SLUG, UPDATE_BASE_ENV, assertAssetUrl, assertRedirectTarget, describeTransportFailure, isTlsVerificationFailure, makeBytesFetcher, makeFetcher, resolveBase } from '../lib/source.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError } from '../lib/fsutil.js'
import { PINNED_PATH, bytesResponse, jsonResponse, startServer } from './helpers.mjs'

test('with no override the source is the pinned GitHub API', () => {
  const resolved = resolveBase({})
  assert.equal(resolved.base, DEFAULT_BASE)
  assert.equal(resolved.base, 'https://api.github.com/repos/' + REPO_SLUG)
  assert.equal(resolved.overridden, false)
})

test('any https host may be named, because a self-built mirror is a legitimate answer', () => {
  assert.equal(
    resolveBase({ [UPDATE_BASE_ENV]: 'https://mirror.example.test' }).base,
    'https://mirror.example.test/repos/' + REPO_SLUG,
  )
})

test('loopback http is accepted, for tests and a local mirror only', () => {
  for (const host of ['127.0.0.1:8787', 'localhost:8787']) {
    assert.equal(
      resolveBase({ [UPDATE_BASE_ENV]: 'http://' + host }).base,
      'http://' + host + '/repos/' + REPO_SLUG,
    )
  }
})

test('a cleartext host refuses: the check does not downgrade', () => {
  const error = capture(() => resolveBase({ [UPDATE_BASE_ENV]: 'http://api.github.com' }))
  assert.equal(error.code, CODES.sourceInsecure)
  assert.match(error.message, /cleartext|refused/)
})

test('https is required for every non-loopback host', () => {
  assert.equal(capture(() => resolveBase({ [UPDATE_BASE_ENV]: 'http://mirror.example.test' })).code, CODES.sourceInsecure)
  assert.equal(capture(() => resolveBase({ [UPDATE_BASE_ENV]: 'ftp://api.github.com' })).code, CODES.sourceInsecure)
})

test('an unusable override refuses rather than being repaired by guesswork', () => {
  assert.equal(capture(() => resolveBase({ [UPDATE_BASE_ENV]: 'not a url' })).code, CODES.sourceShape)
  assert.equal(capture(() => resolveBase({ [UPDATE_BASE_ENV]: 'https://user:token@api.github.com' })).code, CODES.sourceShape)
})

test('the repository slug stays pinned even when the base names a different path', async () => {
  const server = await startServer({
    ['/api' + PINNED_PATH + '/releases/latest']: jsonResponse({ tag_name: 'v1.4.0', assets: [] }),
  })
  try {
    // An API prefix is allowed (GitHub Enterprise puts /api/v3 in front); a
    // repository path in the env value is refused, so the override cannot point
    // this tool at somebody else's releases.
    const resolved = resolveBase({ [UPDATE_BASE_ENV]: server.origin + '/api' })
    assert.ok(resolved.base.endsWith('/repos/' + REPO_SLUG), resolved.base)
    const payload = await makeFetcher()(resolved.base + '/releases/latest')
    assert.equal(payload.tag_name, 'v1.4.0')
    assert.equal(server.requests[0].pathname, '/api' + PINNED_PATH + '/releases/latest')
    assert.equal(capture(() => resolveBase({ [UPDATE_BASE_ENV]: server.origin + '/repos/attacker/GlassPane' })).code, CODES.sourceShape)
  } finally {
    await server.close()
  }
})

test('a release asset cannot name an insecure or off-origin host', () => {
  const base = 'https://api.github.com/repos/' + REPO_SLUG
  const pinned = base + '/releases/download/v1.4.0/pkg.tar.gz'
  assert.equal(assertAssetUrl(pinned, { base }), pinned)
  assert.equal(capture(() => assertAssetUrl('http://api.github.com/x.tar.gz', { base })).code, CODES.assetHostUnpinned)
  assert.equal(capture(() => assertAssetUrl('https://cdn.attacker.test/x.tar.gz', { base })).code, CODES.assetHostUnpinned)
  assert.equal(capture(() => assertAssetUrl('/relative/only', { base })).code, CODES.assetHostUnpinned)
  // This block *used to assert the hole*: `assert.ok(assertAssetUrl('http://
  // 127.0.0.1:9/p.tar.gz', { base }))` passed with an https GitHub base, i.e. a
  // release payload could point the bytes at any local (or, one character from
  // it, routable) listener. Loopback is now a property of the *base*, so the
  // test fixture keeps working by saying so explicitly — see the next test.
  assert.equal(capture(() => assertAssetUrl('http://127.0.0.1:9/p.tar.gz', { base })).code, CODES.assetHostUnpinned)
  assert.equal(capture(() => assertAssetUrl('https://127.0.0.1:9/p.tar.gz', { base })).code, CODES.assetHostUnpinned)
})

test('a loopback base is the only thing that makes a loopback asset legal', () => {
  const testBase = 'http://127.0.0.1:9/repos/' + REPO_SLUG
  assert.equal(assertAssetUrl('http://127.0.0.1:9/p.tar.gz', { base: testBase }), 'http://127.0.0.1:9/p.tar.gz')
  // Same port, same host: a fixture that answers on 127.0.0.1:9 is not a licence
  // for 127.0.0.1:8123 or for `localhost`, which is a *different* trust decision
  // (name resolution) on a machine that may be serving more than the test.
  assert.equal(capture(() => assertAssetUrl('http://127.0.0.1:8123/p.tar.gz', { base: testBase })).code, CODES.assetHostUnpinned)
  assert.equal(capture(() => assertAssetUrl('http://localhost:9/p.tar.gz', { base: testBase })).code, CODES.assetHostUnpinned)
  assert.equal(capture(() => assertAssetUrl('https://api.github.com/x.tar.gz', { base: testBase })).code, CODES.assetHostUnpinned)
})

test('a redirect that leaves the pinned host is refused before the body is read', async () => {
  // `redirect: 'follow'` means the *payload* URL is only a promise about where
  // the bytes come from; `response.url` is the answer. The transport is faked
  // here for one reason only: a refusal test must not dial somebody's host, and
  // `response.url` is a property only a transport can supply. The judgement on it
  // is the real `assertRedirectTarget`, and the same-origin path is pinned
  // against a real server in the next test.
  const fake = (finalUrl) => async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    url: finalUrl,
    json: async () => ({}),
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  })
  const from = 'https://api.github.com/repos/' + REPO_SLUG + '/releases/download/v1.4.0/pkg.tar.gz'
  const jumped = await captureAsync(() => makeBytesFetcher(fake('https://cdn.attacker.test/pkg.tar.gz'))(from))
  assert.equal(jumped.code, CODES.downloadHostUnpinned)
  assert.match(jumped.message, /redirected to/)
  const jsonJump = await captureAsync(() => makeFetcher(fake('https://cdn.attacker.test/r.json'))('https://api.github.com/x'))
  assert.equal(jsonJump.code, CODES.downloadHostUnpinned)
  // GitHub's own hand-off stays legal, and a hop off a non-GitHub mirror does not.
  assert.doesNotThrow(() => assertRedirectTarget('https://objects.githubusercontent.com/x', { requested: from }))
  assert.equal(
    capture(() => assertRedirectTarget('https://objects.githubusercontent.com/x', { requested: 'https://mirror.example.test/a.tar.gz' })).code,
    CODES.downloadHostUnpinned,
  )
  // A loopback test server may not hop hosts either.
  assert.equal(
    capture(() => assertRedirectTarget('https://api.github.com/x', { requested: 'http://127.0.0.1:9/a.tar.gz' })).code,
    CODES.downloadHostUnpinned,
  )
})

test('a real redirect inside the same origin still delivers the bytes', async () => {
  // The other half of the check: `response.url` must not turn an ordinary,
  // legal redirect into a refusal, or no GitHub release would ever download.
  const server = await startServer({
    '/a.tar.gz': (req, res) => {
      res.writeHead(302, { location: '/b.tar.gz' })
      res.end()
    },
    '/b.tar.gz': bytesResponse(Buffer.from('payload bytes')),
  })
  try {
    const bytes = await makeBytesFetcher()(server.origin + '/a.tar.gz')
    assert.equal(Buffer.from(bytes).toString('utf8'), 'payload bytes')
    assert.equal(server.requests.length, 2, 'the redirect really happened, over a real socket')
  } finally {
    await server.close()
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

/** The same, for a refusal that arrives as a rejected promise. */
async function captureAsync(fn) {
  try {
    await fn()
  } catch (error) {
    assert.ok(error instanceof UpdaterError, 'expected an UpdaterError, got ' + error)
    return error
  }
  throw new assert.AssertionError({ message: 'the call was expected to refuse, and it did not' })
}

/* ------------------------------------------- a TLS failure must say what it is */

const BUNDLE = '/Users/dev/.glasspane/ca-roots.pem'
const URL_UNDER_TEST = 'https://api.github.com/repos/jingzhao-l/GlassPane/releases/latest'

/** The exact shape undici produces: a TypeError whose `cause` carries the real code. */
function tlsError() {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
  })
}

test('a certificate-verification failure reports the cause code, not "fetch failed"', async () => {
  const fetcher = makeFetcher(async () => {
    throw tlsError()
  }, { caBundlePath: BUNDLE })
  const error = await captureAsync(() => fetcher(URL_UNDER_TEST))
  assert.equal(error.code, CODES.releaseUnreachable)
  assert.match(error.message, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/, 'the code lives in error.cause; dropping it is what made this machine look offline while curl worked')
  assert.match(error.message, /fetch failed/, 'the original sentence stays, this is an addition not a rewrite')
  assert.equal(error.tlsVerification, true, 'the recovery branch reads this flag, not my sentence')
  assert.match(error.details, new RegExp(`NODE_EXTRA_CA_CERTS=${BUNDLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the remedy names the file this machine should be handed')
  assert.match(error.details, /updater enable|installer/, 'and the two ways to produce it')
})

test('a refused connection gets no certificate advice', async () => {
  const fetcher = makeFetcher(async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  }, { caBundlePath: BUNDLE })
  const error = await captureAsync(() => fetcher(URL_UNDER_TEST))
  assert.match(error.message, /ECONNREFUSED/)
  assert.equal(error.tlsVerification === true, false, 'a refused connection must not arm the certificate-recovery branch')
  assert.equal(error.details, null, 'handing an operator a plausible fix for a problem they do not have turns the remedy into a new source of confusion')
})

test('the binary transport says the same thing, because the payload hop is where it also fails', async () => {
  const fetchBytes = makeBytesFetcher(async () => {
    throw tlsError()
  }, { caBundlePath: BUNDLE })
  const error = await captureAsync(() => fetchBytes('https://objects.githubusercontent.com/x'))
  assert.equal(error.code, CODES.releaseUnreachable)
  assert.match(error.message, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/)
  assert.match(error.details, /NODE_EXTRA_CA_CERTS/)
})

test('a TLS failure with no bundle path still names how to get one', () => {
  const described = describeTransportFailure(URL_UNDER_TEST, tlsError(), {})
  assert.equal(isTlsVerificationFailure('SELF_SIGNED_CERT_IN_CHAIN'), true)
  assert.equal(isTlsVerificationFailure('EAI_AGAIN'), false, 'a DNS hiccup is not a trust problem and must not borrow this sentence')
  assert.match(described.details, /updater enable/)
  assert.doesNotMatch(described.details, new RegExp(BUNDLE), 'there is no path on this machine yet; pointing at a file that does not exist would be a lie')
})

test('an HTTP answer is reported as an answer, not as a transport failure', async () => {
  const fetcher = makeFetcher(async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    url: URL_UNDER_TEST,
    json: async () => ({ message: 'rate limited' }),
  }))
  const error = await captureAsync(() => fetcher(URL_UNDER_TEST))
  assert.match(error.message, /answered 403 Forbidden/)
  assert.doesNotMatch(`${error.message} ${error.details ?? ''}`, /NODE_EXTRA_CA_CERTS/, 'the server answered: the trust chain worked, so telling someone to fix certificates is wrong')
})

test('an answer object with no status at all is described, not printed as undefined', async () => {
  const fetcher = makeFetcher(async () => ({ ok: false, url: URL_UNDER_TEST, json: async () => ({}) }))
  const error = await captureAsync(() => fetcher(URL_UNDER_TEST))
  assert.match(error.message, /answered with no status/, 'a response that carries no status is still an answer; "answered undefined undefined" names nothing')
  assert.equal(error.message.includes('undefined'), false, error.message)
})

test('an answer with no statusText still names the status it answered with', async () => {
  const fetcher = makeFetcher(async () => ({ ok: false, status: 500, statusText: '', url: URL_UNDER_TEST, json: async () => ({}) }))
  const error = await captureAsync(() => fetcher(URL_UNDER_TEST))
  assert.equal(error.message.includes('undefined'), false, `"answered undefined undefined" tells nobody that a server answered ${500}: ${error.message}`)
  assert.match(error.message, /answered 500/)
})
