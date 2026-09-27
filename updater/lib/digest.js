/**
 * Spec §1 gate 5: measure the downloaded archive and compare.
 *
 * The digest is computed by reading the bytes off disk. Content-Length,
 * `Content-Encoding`, the filename, and the server's word are all ignored —
 * a length check proves the transfer finished, not that the content is what the
 * release claims it is. Two files of identical length that differ by one byte
 * pass a length check and must fail this one (see `test/digest.test.mjs`).
 */
import fs from 'node:fs'
import crypto from 'node:crypto'

import { CODES } from './codes.js'
import { UpdaterError, removeTreeWithin } from './fsutil.js'

const HEX64 = /^[0-9a-f]{64}$/

/** sha256 of a file, streamed (so a large archive does not sit in memory twice). */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Synchronous variant, used where the caller already holds the file. */
export function sha256FileSync(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/**
 * Verify `filePath` against `expected`, refusing everything that is not a
 * lowercase 64-hex digest. On mismatch the staging directory (and the archive
 * inside it) is removed — spec §1.5 — and the error says so.
 */
export async function verifyArchiveDigest({ filePath, expected, stagingDir, allowedStagingRoot }) {
  if (!HEX64.test(String(expected ?? ''))) {
    throw new UpdaterError(
      CODES.sumsAmbiguous,
      `the checksum for ${filePath} is not 64 lowercase hex characters, so the archive cannot be verified`,
    )
  }
  const actual = await sha256File(filePath)
  if (actual !== expected) {
    let removed = false
    if (stagingDir) {
      removeTreeWithin(allowedStagingRoot ?? stagingDir, stagingDir)
      removed = true
    }
    throw new UpdaterError(
      CODES.digestMismatch,
      `downloaded archive digests ${actual}, the release checksum says ${expected}: the bytes are not the bytes that were published`
        + (removed ? `; the staging directory ${stagingDir} was deleted with its contents` : ''),
      { expected, actual, size: safeSize(filePath) },
    )
  }
  return { digest: actual, size: safeSize(filePath) }
}

function safeSize(filePath) {
  try {
    return fs.statSync(filePath).size
  } catch {
    return null
  }
}
