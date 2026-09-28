/**
 * §6 row "双资产必须齐".
 *
 * REVERSE MUTATION: make the missing-checksum case continue (treat an absent
 * `SHA256SUMS-<ver>.txt` as "nothing to verify" and carry on) —
 * `a release without its checksum file is refused` goes red, and the end-to-end
 * check test in `cli.test.mjs` would stage a release with no digest.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SUMS_NAME, TARBALL_NAME, assetIndex, requireAssetPair } from '../lib/assets.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError } from '../lib/fsutil.js'

const BASE = 'https://api.github.com/repos/jingzhao-l/GlassPane'
const DOWNLOAD = BASE + '/releases/download/v1.4.0/'

function releaseWith(...names) {
  return { assets: names.map((name) => ({ name, browser_download_url: DOWNLOAD + name })) }
}

test('asset names are the ones release.yml publishes', () => {
  assert.equal(TARBALL_NAME('1.4.0'), 'GlassPane-1.4.0.tar.gz')
  assert.equal(SUMS_NAME('1.4.0'), 'SHA256SUMS-1.4.0.txt')
})

test('both assets present resolves to two urls', () => {
  const release = releaseWith('GlassPane-1.4.0.tar.gz', 'SHA256SUMS-1.4.0.txt')
  const pair = requireAssetPair(release, { version: '1.4.0', base: BASE })
  assert.equal(pair.tarballUrl, DOWNLOAD + 'GlassPane-1.4.0.tar.gz')
  assert.equal(pair.sumsUrl, DOWNLOAD + 'SHA256SUMS-1.4.0.txt')
})

test('a release without its checksum file is refused', () => {
  const error = capture(() => requireAssetPair(releaseWith('GlassPane-1.4.0.tar.gz'), { version: '1.4.0', base: BASE }))
  assert.equal(error.code, CODES.assetsMissing)
  assert.match(error.message, /SHA256SUMS-1\.4\.0\.txt/)
})

test('a checksum file without its archive is refused too', () => {
  assert.equal(capture(() => requireAssetPair(releaseWith('SHA256SUMS-1.4.0.txt'), { version: '1.4.0', base: BASE })).code, CODES.assetsMissing)
})

test('an asset published twice is refused rather than picked from', () => {
  const release = {
    assets: [
      { name: 'GlassPane-1.4.0.tar.gz', browser_download_url: DOWNLOAD + 'a.tar.gz' },
      { name: 'GlassPane-1.4.0.tar.gz', browser_download_url: DOWNLOAD + 'b.tar.gz' },
      { name: 'SHA256SUMS-1.4.0.txt', browser_download_url: DOWNLOAD + 'sums.txt' },
    ],
  }
  assert.equal(capture(() => requireAssetPair(release, { version: '1.4.0', base: BASE })).code, CODES.assetsMissing)
})

test('the version inside the asset name has to be the release version', () => {
  // `v1.4.0` publishing `GlassPane-1.3.9.tar.gz` is the "tag and content are
  // not the same release" case, and it is refused at the asset gate.
  const release = releaseWith('GlassPane-1.3.9.tar.gz', 'SHA256SUMS-1.3.9.txt')
  assert.equal(capture(() => requireAssetPair(release, { version: '1.4.0', base: BASE })).code, CODES.assetsMissing)
})

test('an asset with no download url, and a non-https one, both refuse', () => {
  const noUrl = { assets: [{ name: 'GlassPane-1.4.0.tar.gz' }, { name: 'SHA256SUMS-1.4.0.txt', url: 'x' }] }
  assert.equal(capture(() => requireAssetPair(noUrl, { version: '1.4.0', base: BASE })).code, CODES.assetsMissing)
  const insecure = {
    assets: [
      { name: 'GlassPane-1.4.0.tar.gz', browser_download_url: 'http://files.example.test/GlassPane-1.4.0.tar.gz' },
      { name: 'SHA256SUMS-1.4.0.txt', browser_download_url: DOWNLOAD + 'SHA256SUMS-1.4.0.txt' },
    ],
  }
  assert.equal(capture(() => requireAssetPair(insecure, { version: '1.4.0', base: BASE })).code, CODES.assetHostUnpinned)
})

test('assetIndex ignores assets with no name and keeps the payload order', () => {
  assert.deepEqual(assetIndex({ assets: [{ url: 'x' }, { name: 'a' }] }), [{ name: 'a', url: null }])
  assert.deepEqual(assetIndex(null), [])
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
