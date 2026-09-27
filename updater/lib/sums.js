/**
 * Spec §1 gate 4: strict parse of `SHA256SUMS-<ver>.txt`.
 *
 * Accepted line shape, and the *only* accepted line shape:
 *
 *     <64 lowercase hex><exactly two spaces><file name>
 *
 * `sha256sum` writes it this way by default; the one-space BSD `shasum` form, a
 * leading binary-mode `*`, trailing whitespace, CRLF, or an uppercase digest all
 * fail. That is deliberate: a parser that "normalises" whatever it is handed is
 * a parser that will happily read a file somebody else generated.
 *
 * Then: the wanted tarball name must be matched by **exactly one** line. Two
 * lines with the same name and different digests is the case where "take the
 * first" silently picks an attacker's choice, so it is `sums-ambiguous`.
 */
import { CODES } from './codes.js'
import { UpdaterError } from './fsutil.js'

export const SUMS_LINE_RE = /^([0-9a-f]{64})  (\S+)$/

/** Parse into rows, dropping blank lines and refusing every other shape. */
export function parseSums(text, { source = 'SHA256SUMS' } = {}) {
  if (typeof text !== 'string') {
    throw new UpdaterError(CODES.sumsAmbiguous, `${source} is not text`)
  }
  const lines = text.split('\n')
  const rows = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === '' && i === lines.length - 1) continue // trailing newline
    if (line.trim() === '') {
      throw new UpdaterError(CODES.sumsAmbiguous, `${source} line ${i + 1} is whitespace rather than a checksum row`)
    }
    const match = SUMS_LINE_RE.exec(line)
    if (!match) {
      throw new UpdaterError(
        CODES.sumsAmbiguous,
        `${source} line ${i + 1} (${JSON.stringify(line)}) is not "<64 hex>  <name>": refusing to guess at a checksum file this project did not write`,
      )
    }
    if (match[2].startsWith('*')) {
      // GNU `sha256sum --binary` writes `<hex>  *<name>`. That is a different
      // format, and reading it as a plain name would produce a confusing
      // "no row for GlassPane-1.4.0.tar.gz" for a file that does have one.
      throw new UpdaterError(
        CODES.sumsAmbiguous,
        `${source} line ${i + 1} marks its name with a leading "*" (binary-mode checksum format); only the text form "<64 hex>  <name>" is accepted`,
      )
    }
    rows.push({ digest: match[1], name: match[2], line: i + 1 })
  }
  return rows
}

/** The single digest for `name`, or a refusal. */
export function digestFor(text, name, opts = {}) {
  const source = opts.source ?? `SHA256SUMS for ${name}`
  const rows = parseSums(text, { source })
  const hits = rows.filter((row) => row.name === name)
  if (hits.length === 0) {
    throw new UpdaterError(
      CODES.sumsAmbiguous,
      `${source} lists no row for ${name} (rows: ${rows.map((r) => r.name).join(', ') || 'none'}): the archive was not staged`,
    )
  }
  if (hits.length > 1) {
    const distinct = [...new Set(hits.map((h) => h.digest))]
    throw new UpdaterError(
      CODES.sumsAmbiguous,
      `${source} names ${name} on ${hits.length} lines (rows ${hits.map((h) => h.line).join(', ')}, digests ${distinct.join(', ')}); `
        + 'picking the first one would decide the answer by ordering, so this release is refused',
    )
  }
  return hits[0].digest
}
