/**
 * §6 row "SUMS 严格解析".
 *
 * REVERSE MUTATION: take the first matching row instead of requiring exactly one
 * (`hits[0]` without the length check), and accept a "close enough" separator —
 * `two rows naming the same tarball refuse` and every shape test below go red.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SUMS_LINE_RE, digestFor, parseSums } from '../lib/sums.js'
import { CODES } from '../lib/codes.js'
import { UpdaterError } from '../lib/fsutil.js'

const DIGEST = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const NAME = 'GlassPane-1.4.0.tar.gz'

test('the sha256sum default form is the only accepted row shape', () => {
  assert.deepEqual(parseSums(`${DIGEST}  ${NAME}\n`), [{ digest: DIGEST, name: NAME, line: 1 }])
  assert.deepEqual(parseSums(`${DIGEST}  ${NAME}`).map((r) => r.name), [NAME], 'no trailing newline is fine')
})

test('every near-miss refuses: one space, tab, binary marker, uppercase, CRLF, padding, extra fields', () => {
  const bad = [
    `${DIGEST} ${NAME}`, // single space (BSD shasum text mode)
    `${DIGEST}   ${NAME}`, // three spaces
    `${DIGEST}\t${NAME}`, // tab separated
    `${DIGEST}  *${NAME}`, // binary-mode marker
    `${DIGEST.toUpperCase()}  ${NAME}`, // uppercase hex
    `${DIGEST.slice(0, 63)}  ${NAME}`, // 63 characters
    `${DIGEST}  ${NAME} `, // trailing space
    `${DIGEST}  ${NAME}\r`, // CR left in place
    `${DIGEST}  ${NAME}  extra`, // a third field
    `# ${DIGEST}  ${NAME}`, // a comment line
    `${DIGEST}  ${NAME} ${NAME}`, // name with a space in it
  ]
  for (const line of bad) {
    const error = capture(() => parseSums(line + '\n'))
    assert.equal(error.code, CODES.sumsAmbiguous, `expected refusal for ${JSON.stringify(line)}`)
  }
  assert.equal(SUMS_LINE_RE.test(`${DIGEST}  ${NAME}`), true)
})

test('blank lines refuse; only the newline that terminates the last row is tolerated', () => {
  assert.equal(capture(() => parseSums(`${DIGEST}  ${NAME}\n\n${OTHER}  other.tar.gz\n`)).code, CODES.sumsAmbiguous)
  assert.equal(capture(() => parseSums(`${DIGEST}  ${NAME}\n\n`)).code, CODES.sumsAmbiguous, 'a trailing blank line is still a blank line')
  assert.deepEqual(parseSums(''), [], 'an empty file parses to zero rows; the exactly-one-row rule is what refuses it')
  assert.equal(capture(() => digestFor('', NAME)).code, CODES.sumsAmbiguous)
})

test('the wanted tarball must appear exactly once', () => {
  assert.equal(digestFor(`${OTHER}  other.txt\n${DIGEST}  ${NAME}\n`, NAME), DIGEST)
  assert.equal(capture(() => digestFor(`${OTHER}  other.txt\n`, NAME)).code, CODES.sumsAmbiguous)
})

test('two rows naming the same tarball refuse, even when the digests agree', () => {
  const duplicated = `${DIGEST}  ${NAME}\n${DIGEST}  ${NAME}\n`
  const error = capture(() => digestFor(duplicated, NAME, { source: 'SHA256SUMS-1.4.0.txt' }))
  assert.equal(error.code, CODES.sumsAmbiguous)
  assert.match(error.message, /picking the first one would decide the answer by ordering/)
  // The attacker-relevant variant: two different digests for one name.
  const conflicting = `${DIGEST}  ${NAME}\n${OTHER}  ${NAME}\n`
  assert.equal(capture(() => digestFor(conflicting, NAME)).code, CODES.sumsAmbiguous)
})

test('a name-prefix collision is not a match', () => {
  // `GlassPane-1.4.0.tar.gz` vs `GlassPane-1.4.0.tar.gz.sig` — substring matching
  // would hand back the wrong digest and the digest gate would then refuse a
  // good release, or (worse) a careless implementation would accept the wrong row.
  assert.equal(digestFor(`${DIGEST}  ${NAME}\n${OTHER}  ${NAME}.sig\n`, NAME), DIGEST)
  assert.equal(capture(() => digestFor(`${OTHER}  ${NAME}.sig\n`, NAME)).code, CODES.sumsAmbiguous)
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
