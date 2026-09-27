/**
 * §6 row "实测 sha256".
 *
 * REVERSE MUTATION: replace the measured hash with the transport's own book —
 * compare `Number(response.headers['content-length'])` against the declared size
 * (or trust a `digest` header) instead of hashing the bytes on disk. The
 * `a same-length, different-bytes archive is a digest mismatch` case goes red:
 * the length is *identical*, only the bytes differ, so no header-based check can
 * see it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { sha256Bytes, sha256File, verifyArchiveDigest } from '../lib/digest.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError, writableRoots } from '../lib/fsutil.js'
import { makeBytesFetcher } from '../lib/source.js'
import { PINNED_PATH, bytesResponse, jsonResponse, removeDir, startServer, tempDir, TMP_PREFIX } from './helpers.mjs'

/** Two payloads with equal length and different content. */
function pair() {
  const good = Buffer.alloc(2048, 0x41)
  const swapped = Buffer.from(good)
  swapped[1000] = 0x42
  swapped[1001] = 0x43
  return { good, swapped }
}

test('sha256File measures the bytes on disk', async () => {
  const dir = tempDir(`${TMP_PREFIX}digest-`)
  try {
    const file = path.join(dir, 'blob')
    const { good } = pair()
    fs.writeFileSync(file, good)
    const expected = crypto.createHash('sha256').update(good).digest('hex')
    assert.equal(await sha256File(file), expected)
    assert.equal(sha256Bytes(good), expected)
    fs.appendFileSync(file, 'extra byte changes the digest')
    assert.notEqual(await sha256File(file), expected)
  } finally {
    removeDir(dir)
  }
})

test('a same-length, different-bytes archive is a digest mismatch', async () => {
  const { good, swapped } = pair()
  assert.equal(good.length, swapped.length, 'the fixture must keep length identical: that is what defeats a Content-Length check')
  assert.notEqual(sha256Bytes(good), sha256Bytes(swapped))
})

test('verifyArchiveDigest accepts the real digest and removes the staging dir on mismatch', async () => {
  const dir = tempDir(`${TMP_PREFIX}digest-verify-`)
  try {
    const roots = writableRoots(dir)
    const stagingDir = path.join(roots.staging, '1.4.0')
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
    const file = path.join(stagingDir, 'archive.tar.gz')
    const { good, swapped } = pair()
    fs.writeFileSync(file, good)
    const digest = sha256Bytes(good)

    const verified = await verifyArchiveDigest({ filePath: file, expected: digest, stagingDir, allowedStagingRoot: roots.staging })
    assert.equal(verified.digest, digest)
    assert.equal(verified.size, good.length)
    assert.ok(fs.existsSync(stagingDir), 'a passing verification keeps the tree')

    // Now the bytes under the same name are the swapped ones, same length.
    fs.writeFileSync(file, swapped)
    const error = await captureAsync(() =>
      verifyArchiveDigest({ filePath: file, expected: digest, stagingDir, allowedStagingRoot: roots.staging }))
    assert.equal(error.code, CODES.digestMismatch)
    assert.ok(!fs.existsSync(stagingDir), 'spec 1.5: the staging directory goes away with its contents')
    assert.match(error.message, /digests [0-9a-f]{64}/)
  } finally {
    removeDir(dir)
  }
})

test('a checksum that is not 64 hex cannot verify anything', async () => {
  const dir = tempDir(`${TMP_PREFIX}digest-bad-`)
  try {
    const file = path.join(dir, 'a.tar.gz')
    fs.writeFileSync(file, 'bytes')
    for (const expected of ['abc', 'A'.repeat(64), '', null, `${'a'.repeat(64)}  GlassPane-1.4.0.tar.gz`]) {
      const error = await captureAsync(() => verifyArchiveDigest({ filePath: file, expected }))
      assert.equal(error.code, CODES.sumsAmbiguous, `expected refusal for ${JSON.stringify(expected)}`)
    }
  } finally {
    removeDir(dir)
  }
})

test('the digest is computed from bytes fetched over a real server, not from its headers', async () => {
  const { good, swapped } = pair()
  const server = await startServer({
    [PINNED_PATH + '/releases/latest']: jsonResponse({ tag_name: 'v1.4.0', assets: [] }),
    '/dl/good.tar.gz': bytesResponse(good),
    '/dl/tampered.tar.gz': bytesResponse(swapped),
  })
  try {
    const fetchBytes = makeBytesFetcher()
    const expected = sha256Bytes(good)
    const downloaded = Buffer.from(await fetchBytes(server.origin + '/dl/good.tar.gz'))
    assert.equal(downloaded.length, good.length)
    assert.equal(sha256Bytes(downloaded), expected)

    const tampered = Buffer.from(await fetchBytes(server.origin + '/dl/tampered.tar.gz'))
    assert.equal(tampered.length, good.length, 'the tampered body is the same length: only hashing tells them apart')
    assert.notEqual(sha256Bytes(tampered), expected)
  } finally {
    await server.close()
  }
})

async function captureAsync(fn) {
  try {
    await fn()
  } catch (error) {
    assert.ok(error instanceof UpdaterError, 'expected an UpdaterError, got ' + error)
    return error
  }
  throw new assert.AssertionError({ message: 'the call was expected to refuse, and it did not' })
}
