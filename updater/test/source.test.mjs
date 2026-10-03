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

import { DEFAULT_BASE, REPO_SLUG, UPDATE_BASE_ENV, DOWNLOAD_BUDGET_MS, DOWNLOAD_MIN_RATE_BPS, DOWNLOAD_MIN_RATE_FLOOR_BPS, assetPathNamesPinnedRelease, assertAssetUrl, assertRedirectTarget, describeTransportFailure, isTlsVerificationFailure, makeBytesFetcher, makeFetcher, rateFloorFor, resolveBase } from '../lib/source.js'
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

/**
 * 真机 2026-09-29 查出来的那条：GitHub 的 `browser_download_url` 是
 * `https://github.com/<slug>/releases/download/<tag>/<file>`，与钉死的 base（`https://api.github.com/repos/<slug>`）
 * **不是同一个 origin**。原规则只认 same-origin ⇒ 每一份真实 release 都在资产这一关被拒，
 * 而当时所有夹具写的是 `api.github.com/.../releases/download/…` —— GitHub 根本不用的形状。
 * 所以这一节按**真机取回的报文**来断言（下面三条 URL 逐字来自 `GET releases/latest` 的响应）。
 */
test('the URL shapes GitHub actually returns are accepted, and the widening stays bounded', () => {
  const base = 'https://api.github.com/repos/' + REPO_SLUG
  const realAsset = 'https://github.com/jingzhao-l/GlassPane/releases/download/v1.5.1/GlassPane-1.5.1.tar.gz'
  const realSums = 'https://github.com/jingzhao-l/GlassPane/releases/download/v1.5.1/SHA256SUMS-1.5.1.txt'
  const realTarball = 'https://api.github.com/repos/jingzhao-l/GlassPane/tarball/v1.5.1'
  assert.equal(assertAssetUrl(realAsset, { base }), realAsset, '真实的资产 URL 必须放行，否则自动更新在每一份真实 release 上都是死的')
  assert.equal(assertAssetUrl(realSums, { base }), realSums)
  assert.equal(assertAssetUrl(realTarball, { base }), realTarball, '源码包那一形状同属钉死的族')

  // 放宽的三条边界，缺一条就红：
  // ① 不是钉死的 GitHub API 基址（操作者自建的镜像）⇒ 仍按 same-origin，github.com 的资产要拒。
  const mirror = 'https://mirror.example.test/repos/' + REPO_SLUG
  assert.equal(capture(() => assertAssetUrl(realAsset, { base: mirror })).code, CODES.assetHostUnpinned,
    '镜像基址不该顺手获得"任何 GitHub 主机"这层放宽')
  assert.equal(assertAssetUrl('https://mirror.example.test/releases/pkg-1.5.1.tar.gz', { base: mirror }),
    'https://mirror.example.test/releases/pkg-1.5.1.tar.gz', '镜像仍能用——前提是报文指回镜像自己')
  // ② 在 GitHub 的族里，但路径不是**这个仓**的那两条形状 ⇒ 拒（报文不能替我们决定取谁的仓）。
  for (const hostile of [
    'https://github.com/someone-else/GlassPane/releases/download/v1.5.1/GlassPane-1.5.1.tar.gz',
    'https://github.com/jingzhao-l/other-repo/releases/download/v1.5.1/x.tar.gz',
    'https://api.github.com/repos/jingzhao-l/GlassPane/releases/download/whatever/../x',
    'https://objects.githubusercontent.com/anything',
    'https://github.com/jingzhao-l/GlassPane/releases/download/v1.5.1/',
    'https://github.evil.test/jingzhao-l/GlassPane/releases/download/v1.5.1/x.tar.gz',
  ]) {
    assert.equal(capture(() => assertAssetUrl(hostile, { base })).code, CODES.assetHostUnpinned,
      `这条该拒：${hostile}`)
  }
  // ③ 明文一律拒，哪怕路径形状对。
  assert.equal(capture(() => assertAssetUrl(realAsset.replace('https://', 'http://'), { base })).code, CODES.assetHostUnpinned)

  // 大小写与百分号编码不许成为绕过口：`/JingZhao-L/glasspane/...` 在 GitHub 上指向同一个仓，
  // 所以它**要么按同一个规则放行、要么按同一个规则拒绝**——但不能因为正则没解码就静默通过。
  assert.equal(assetPathNamesPinnedRelease('/jingzhao-l/GlassPane/releases/download/v1/x'), true)
  assert.equal(assetPathNamesPinnedRelease('/%6Aingzhao-l/GlassPane/releases/download/v1/x'), true,
    '解码后仍是那个 slug：GitHub 会把它当同一个仓，我们也一样')
  assert.equal(assetPathNamesPinnedRelease('/other/GlassPane/releases/download/v1/x'), false)
  assert.equal(assetPathNamesPinnedRelease('/jingzhao-l/GlassPane/releases/download/v1/x/y'), false,
    '文件名里再藏一层路径不算资产形状')
})

/* ---------------------------- 下载的两个时钟（真机 09-29 被 120s 总时长掐死过） */

/**
 * 一个"按节奏吐字节"的假传输，接口形状与 `response.body.getReader()` 一致：
 * `hangAfter` 之后读操作挂住（收到 abort 信号才失败），这就是"代理活着但不传数据"。
 * `declaredBytes` 让响应带上一个真 GitHub 资产都带的那个 `content-length`；`endless` 让它在
 * 声明的长度之后继续滴（那正是"封套说 89 字节却永远流不完"的形状）。
 */
function streamingResponse(chunks, { gapMs = 0, hangAfter = null, signal = null, declaredBytes = null, endless = false } = {}) {
  let index = 0
  const reader = {
    read: async () => {
      if (hangAfter !== null && index >= hangAfter) {
        return new Promise((_resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal?.aborted) onAbort()
          else signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs))
      // 真 fetch 在 abort 之后读一定失败；假的不失败的话，"计时器到了"这一路就只是空转。
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      if (index >= chunks.length) {
        if (!endless) return { done: true, value: undefined }
        const value = chunks[chunks.length - 1]
        index += 1
        return { done: false, value }
      }
      const value = chunks[index++]
      return { done: false, value }
    },
  }
  const headers = declaredBytes === null ? undefined : { get: (name) => String(name).toLowerCase() === 'content-length' ? String(declaredBytes) : null }
  return { ok: true, status: 200, url: 'https://github.com/jingzhao-l/GlassPane/releases/download/v1.5.1/GlassPane-1.5.1.tar.gz', headers, body: { getReader: () => reader } }
}

test('a slow-but-alive download is not killed: the stall clock re-arms on every chunk', async () => {
  const chunk = new Uint8Array(64 * 1024).fill(7)
  const fetchImpl = async (url, { signal } = {}) => streamingResponse(Array.from({ length: 6 }, () => chunk), { gapMs: 30, signal })
  // 每段之间停 30ms（总共 180ms），停摆计时是 100ms：逐段重置才活得下来。
  const fetchBytes = makeBytesFetcher(fetchImpl, { stallMs: 100, timeoutMs: 5_000 })
  const started = Date.now()
  const got = await fetchBytes('https://github.com/x/y')
  const elapsed = Date.now() - started
  assert.equal(got.length, 6 * 64 * 1024, '六段都要拿到')
  assert.equal(got.every((byte) => byte === 7), true, '拼起来的字节要按顺序完整')
  assert.ok(elapsed > 100, `这一趟必须跑过 stallMs（实到 ${elapsed}ms），否则它没有证明"逐段重置"这件事`)
  assert.ok(elapsed < 5_000, '总时长没到，说明它不是被兜底计时放过的')
})

test('a stalled download is refused by the stall clock, naming how much arrived', async () => {
  const started = Date.now()
  const fetchImpl = async (url, { signal } = {}) => streamingResponse([new Uint8Array(64 * 1024).fill(1)], { hangAfter: 1, signal })
  const fetchBytes = makeBytesFetcher(fetchImpl, { timeoutMs: 60_000, stallMs: 40 })
  const error = await fetchBytes('https://github.com/x/y').then(() => null, (e) => e)
  assert.ok(error, '挂住的传输必须被拒，不能一直挂着')
  assert.equal(error.code, CODES.releaseUnreachable)
  assert.match(error.message, /no bytes arrived for/, `要说是"停住了"，不是那句 "This operation was aborted"：${error.message}`)
  assert.match(error.message, /64 KiB/, `要说清已经收到多少：${error.message}`)
  assert.ok(Date.now() - started < 5_000, `停住的连接要在 stallMs 内被发现（实际 ${Date.now() - started}ms）`)
  assert.ok(!error.message.includes('undefined'))
})

test('an endless trickle still hits the ceiling, so the daily job cannot hang forever', async () => {
  const started = Date.now()
  let produced = 0
  const infinite = async (url, { signal } = {}) => ({
    ok: true,
    status: 200,
    url,
    body: {
      getReader: () => ({
        read: async () => {
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          await new Promise((resolve) => setTimeout(resolve, 2))
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          index += 1
          produced = index
          return { done: false, value: new Uint8Array(1024) }
        },
      }),
    },
  })
  let index = 0
  const fetchBytes = makeBytesFetcher(infinite, { timeoutMs: 60, stallMs: 10_000 })
  const error = await fetchBytes('https://github.com/x/y').then(() => null, (e) => e)
  assert.ok(error, '永远在滴流的服务器不能把每日作业吊死')
  assert.match(error.message, /did not finish within/, `要说清是总时长到了：${error.message}`)
  assert.ok(produced > 0, '这一段该确实收到过字节，否则测的是别的东西')
  assert.ok(Date.now() - started < 5_000, `总时长到了就要说（实际 ${Date.now() - started}ms）`)
})

test('a transport with no stream body still returns its bytes', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const fetchBytes = makeBytesFetcher(async () => ({
    ok: true, status: 200, url: 'https://github.com/x/y', arrayBuffer: async () => bytes,
  }), { timeoutMs: 5_000, stallMs: 5_000 })
  assert.deepEqual([...await fetchBytes('https://github.com/x/y')], [1, 2, 3, 4])
})

/* --------- 三个时钟各判各的：停摆 / 太慢 / 兜底总时长（#59：ceiling 不能再当主判据） */

// REVERSE MUTATION: delete the `if (budget > timeoutMs) armCeiling(budget)` widening — this fixture's stream
// is longer than the ceiling it was handed (200ms) but comfortably above the rate floor, which is exactly the
// shape that killed a real 26 KiB/s download of the 24 MiB archive at the 900s cap. The refusal wording turns
// into the ceiling's sentence and `got.length` never gets to 12 KiB.
test('a download that declares its length gets the time its own rate needs, not the default ceiling', async () => {
  const declared = 12 * 1024
  const chunk = new Uint8Array(1024).fill(3)
  const fetchImpl = async (url, { signal } = {}) => streamingResponse(Array.from({ length: 12 }, () => chunk), { gapMs: 30, signal, declaredBytes: declared })
  // 1 KiB/s 的下限 × 12 KiB ⇒ 预算 18s；默认兜底只有 200ms，所以这条只能靠"按声明长度反解"活下来。
  const fetchBytes = makeBytesFetcher(fetchImpl, { timeoutMs: 200, stallMs: 10_000, minRateBps: 1024 })
  const started = Date.now()
  const got = await fetchBytes('https://github.com/x/y')
  assert.equal(got.length, declared, '十二段都要拿到：它没有被兜底计时掐掉')
  assert.ok(Date.now() - started > 200, `这一趟必须跑过那个默认 ceiling（实到 ${Date.now() - started}ms），否则它没有证明预算被放宽`)
})

test('a live but crawling download is refused for being too slow, and the sentence says what it measured', async () => {
  const started = Date.now()
  const endless = async (url, { signal } = {}) => streamingResponse([new Uint8Array(10).fill(9)], { gapMs: 30, signal, endless: true, declaredBytes: 4096 })
  const fetchBytes = makeBytesFetcher(endless, { timeoutMs: 5_000, stallMs: 60_000, minRateBps: 1000, rateWindowMs: 40, rateWindowsBeforeRefusal: 2 })
  const error = await fetchBytes('https://github.com/x/y').then(() => null, (e) => e)
  assert.ok(error, '一直滴、但慢到这一整天都跑不完的流必须被拒')
  assert.equal(error.code, CODES.releaseUnreachable)
  assert.match(error.message, /too slow to be worth finishing/, error.message)
  assert.match(error.message, /under the 1\.0 KiB\/s/, `要说出下限是多少：${error.message}`)
  assert.match(error.message, /of 4 KiB declared/, `要说清收到了多少、声明了多少：${error.message}`)
  assert.ok(!/no bytes arrived/.test(error.message), '这不是停摆：三条判据各说一句，说错就等于没闸')
  assert.ok(!/did not finish within/.test(error.message), `这也不是兜底总时长：${error.message}`)
  assert.ok(Date.now() - started < 2_000, `两个窗口就该发现它慢（实际 ${Date.now() - started}ms）`)
})

test('the rate floor lets a stream that is merely unhurried through', async () => {
  // 控制对：一条永远正确的"太慢"断言等于没有判据，所以这里放行的必须是同一段代码。
  const chunk = new Uint8Array(512).fill(5)
  const fetchImpl = async (url, { signal } = {}) => streamingResponse(Array.from({ length: 6 }, () => chunk), { gapMs: 10, signal, declaredBytes: 6 * 512 })
  const fetchBytes = makeBytesFetcher(fetchImpl, { timeoutMs: 60_000, stallMs: 60_000, minRateBps: 1000, rateWindowMs: 25, rateWindowsBeforeRefusal: 2 })
  const got = await fetchBytes('https://github.com/x/y')
  assert.equal(got.length, 6 * 512)
})

/* --------- 下限由预算与声明长度反解（真机 2026-10-03：7.3 KiB/s 的 2.4 MiB 归档被 16 KiB/s 的旧常数误拒） */

test('the floor is solved from the budget and the length this response declares', () => {
  // The floor answers one question — "what bytes-per-second does this declared length need to land inside the
  // budget" — so the control states the same arithmetic, and the assertions below are about what that answer
  // does to a payload that is 10x smaller than the one the old constant was costed against.
  const floorFor = (declared) => Math.ceil((declared * 1000) / DOWNLOAD_BUDGET_MS)
  assert.equal(rateFloorFor({ declared: 24 * 1024 * 1024 }), floorFor(24 * 1024 * 1024))
  // 那条历史常数不是被推翻的，是被还原成一个尺寸的答案：24 MiB / 25 min 就是 16 KiB/s。
  const forBigArchive = rateFloorFor({ declared: 24 * 1024 * 1024 })
  assert.ok(Math.abs(forBigArchive - DOWNLOAD_MIN_RATE_BPS) / DOWNLOAD_MIN_RATE_BPS < 0.05, `${forBigArchive} 应当几乎等于历史常数 ${DOWNLOAD_MIN_RATE_BPS}`)
  // 小一个数量级的载荷要得起更慢的流；再小也不得低于那条绝对下限，否则句子会出现 "0.0 KiB/s"。
  assert.equal(rateFloorFor({ declared: 2 * 1024 * 1024 }), Math.max(DOWNLOAD_MIN_RATE_FLOOR_BPS, floorFor(2 * 1024 * 1024)))
  assert.ok(rateFloorFor({ declared: 2 * 1024 * 1024 }) < DOWNLOAD_MIN_RATE_BPS, '2 MiB 的下限必须低于旧常数，否则这次修复没有发生')
  assert.equal(rateFloorFor({ declared: 512 }), DOWNLOAD_MIN_RATE_FLOOR_BPS, '极小的声明长度不许把下限压成 0')
  assert.equal(rateFloorFor({ declared: null }), DOWNLOAD_MIN_RATE_BPS, '没有声明长度的流走保守的固定下限')
  assert.equal(rateFloorFor({ declared: 0 }), DOWNLOAD_MIN_RATE_BPS)
})

// REVERSE MUTATION: put `minRateBps = DOWNLOAD_MIN_RATE_BPS` back as the default (the pre-fix shape) —
// `a small archive is not refused for a rate its own budget affords` goes red, because that 5 KiB/s stream
// is exactly what the fixed 16 KiB/s floor threw away on the real machine at 348 KiB received.
test('a small archive is not refused for a rate its own budget affords', async () => {
  const declared = 12 * 512
  const chunk = new Uint8Array(512).fill(4)
  // 512 B 每 100ms ⇒ ≈5 KiB/s：低于旧的固定下限，高于这条 6 KiB 载荷反解出来的下限（绝对下限 1 KiB/s）。
  const fetchImpl = async (url, { signal } = {}) => streamingResponse(Array.from({ length: 12 }, () => chunk), { gapMs: 100, signal, declaredBytes: declared })
  const fetchBytes = makeBytesFetcher(fetchImpl, { timeoutMs: 300, stallMs: 60_000, rateWindowMs: 40, rateWindowsBeforeRefusal: 2 })
  const started = Date.now()
  const got = await fetchBytes('https://github.com/x/y')
  assert.equal(got.length, declared, '一条按自己的预算算得过来的流不许被拒')
  assert.ok(Date.now() - started > 300, `这一趟必须跑过默认 ceiling（实到 ${Date.now() - started}ms），否则它没有走过反解出来的预算`)
})

test('the same stream is refused once its own declared length asks for more than it delivers', async () => {
  // 配对控制：改的是同一段代码。把预算压到 1s，同一条 5 KiB/s 的流就不够用了——
  // 判据跟着预算走，而不是跟着某个 payload 尺寸挑出来的常数走。
  const declared = 12 * 512
  const chunk = new Uint8Array(512).fill(4)
  const fetchImpl = async (url, { signal } = {}) => streamingResponse(Array.from({ length: 12 }, () => chunk), { gapMs: 100, signal, declaredBytes: declared })
  const fetchBytes = makeBytesFetcher(fetchImpl, {
    timeoutMs: 60_000,
    stallMs: 60_000,
    budgetMs: 1_000,
    rateWindowMs: 40,
    rateWindowsBeforeRefusal: 2,
    maxCeilingMs: 120_000,
  })
  const error = await fetchBytes('https://github.com/x/y').then(() => null, (e) => e)
  assert.ok(error, '预算压到 1s 之后这条流就必须被拒，否则放行是免费的')
  assert.equal(error.code, CODES.releaseUnreachable)
  assert.match(error.message, /too slow to be worth finishing/, error.message)
  assert.match(error.message, /the 6\.0 KiB\/s this 6 KiB file has to hold to land inside 1\.0s/, `要说出下限是多少、由什么算出来：${error.message}`)
  assert.ok(!/the daily schedule needs/.test(error.message), '那句把常数当判据的旧话不该还在：' + error.message)
})

// REVERSE MUTATION: drop the `Math.min(..., maxCeilingMs)` clamp — 1 GiB at the default floor is 27 hours,
// so the ceiling below stops being a ceiling. Widening exists to stop the backstop from being the primary
// criterion; an unbounded widening does not soften it, it removes it.
test('a widened ceiling is still bounded: an absurd declared length cannot buy hours', async () => {
  const started = Date.now()
  // 500 × 1 KiB every 2ms ≈ one second at ~500 KiB/s — comfortably above the floor, and far past the 200ms
  // cap this call asks for. With the clamp the ceiling fires at 200ms and the refusal names it; with the
  // clamp removed the ceiling is 27 hours, so the stream simply *finishes* and there is no error at all.
  // The stream is deliberately **finite**: a control whose failure mode is "hang" would spend the CI job's
  // whole timeout instead of pointing at the guard that went missing.
  const chunk = new Uint8Array(1024).fill(1)
  const lots = async (url, { signal } = {}) => streamingResponse(Array.from({ length: 500 }, () => chunk), { gapMs: 2, signal, declaredBytes: 1024 * 1024 * 1024 })
  const fetchBytes = makeBytesFetcher(lots, { timeoutMs: 60, maxCeilingMs: 200, stallMs: 60_000, rateWindowMs: 60_000 })
  const error = await fetchBytes('https://github.com/x/y').then(() => null, (e) => e)
  assert.ok(error, '离谱的声明长度不许把下载变成没有上限的等待')
  assert.match(error.message, /did not finish within 200ms/, `要说清真正拦住它的那条上限：${error.message}`)
  assert.match(error.message, /widened to the 200ms/, `要说预算被放宽过、也到顶了：${error.message}`)
  assert.match(error.message, /of the 1024\.0 MiB this response declared/, error.message)
  assert.ok(Date.now() - started < 5_000, `到上限就该停（实际 ${Date.now() - started}ms）`)
})
