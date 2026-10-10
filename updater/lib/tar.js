/**
 * The archive reader. Hand-written on two 512-byte-at-a-time passes over the
 * gunzipped stream, because this package carries no third-party dependency and
 * because extraction is where a malicious archive gets to name paths: every
 * entry is resolved and refused before a byte of it is written if it would land
 * outside the staging directory, and anything that is not a plain file or a
 * directory (symlink, hardlink, device, fifo) is unsupported rather than
 * "probably fine".
 *
 * `packTarGz` is the mirror writer used by the tests to produce real archives.
 * Nothing at runtime calls it; keeping it here means the reader is exercised
 * against bytes a tar implementation produced, not against a fixture someone
 * typed out to match the parser.
 */
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

import { CODES } from './codes.js'
import { UpdaterError, resolveWithin, tightenMode } from './fsutil.js'

const BLOCK = 512

/**
 * What one archive is allowed to become once inflated.
 *
 * `zlib.gunzipSync(buffer)` without `maxOutputLength` sizes its output from the stream
 * alone, so a few kilobytes of deflate payload — well inside the 256 MiB
 * (`DOWNLOAD_MAX_BYTES`, `lib/source.js`) the download half will accept — can ask for
 * unbounded memory, in a process whose whole job is to run unattended on somebody's
 * laptop. A zip bomb is not a trust question, it is the same *availability* question the
 * download cap already answers, and it needed its own number because the two bound
 * different things.
 *
 * 1 GiB, i.e. **4× the compressed cap**. The ratio is measured, not guessed: this
 * machine still holds the real v1.5.1 staging directory, `archive.tar.gz` 25,126,902
 * bytes compressed and 67,399,680 bytes inflated — 2.7×. So the cap leaves a legitimate
 * release more than fifteen times its own inflated size to grow into, while a bomb is
 * refused at one gigabyte instead of being allocated.
 */
export const MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024

/**
 * The mode a staged member may land with.
 *
 * `& 0o777` strips setuid/setgid/sticky and nothing else, so a release that declares
 * `0666` lands world-writable — and `apply` then copies that tree into the runtime the
 * daemon runs from and into `~/Applications`. Group/other **write** bits are not
 * something an archive gets to ask for: the owner keeps whatever they chose, the rest of
 * the machine gets read and execute. (Same reasoning as `lib/runtime.js`'s refusal to
 * land a generation looser than 0700: an owner-only tree is the promise, and read-back
 * mode is part of it.)
 */
export function stagedMode(value, fallback) {
  const declared = Number(value)
  // `0`, absent and unparseable all mean "the archive declared nothing", which is the
  // caller's fallback — not "make this file unreadable to everybody including us".
  const base = Number.isInteger(declared) && declared > 0 ? declared : fallback
  return (base & 0o777) & ~0o022
}

function decodeString(bytes) {
  const end = bytes.indexOf(0)
  const slice = end === -1 ? bytes : bytes.subarray(0, end)
  return Buffer.from(slice).toString('utf8').replace(/\0+$/, '').trim()
}

function parseOctal(bytes) {
  const text = decodeString(bytes).replace(/\0/g, '')
  if (text === '') return 0
  const first = bytes[0]
  if (first === 0x80 || first === 0xff) {
    throw new UpdaterError(CODES.archiveUnreadable, 'base-256 numeric tar fields are not supported by this reader')
  }
  if (!/^[0-7]+$/.test(text)) {
    throw new UpdaterError(CODES.archiveUnreadable, `tar numeric field ${JSON.stringify(text)} is not octal`)
  }
  return Number.parseInt(text, 8)
}

function headerChecksum(block) {
  let sum = 0
  for (let i = 0; i < BLOCK; i += 1) {
    // The checksum field itself is treated as spaces while computing.
    sum += i >= 148 && i < 156 ? 0x20 : block[i]
  }
  return sum
}

function readHeader(block) {
  const stored = decodeString(block.subarray(148, 156)).replace(/\0/g, '')
  const computed = headerChecksum(block)
  if (!/^[0-7]+$/.test(stored) || Number.parseInt(stored, 8) !== computed) {
    throw new UpdaterError(
      CODES.archiveUnreadable,
      `tar header checksum ${JSON.stringify(stored)} does not match the computed ${computed.toString(8)}: the archive is corrupt or truncated`,
    )
  }
  const magic = decodeString(block.subarray(257, 263))
  if (magic !== 'ustar') {
    throw new UpdaterError(CODES.archiveUnreadable, `tar magic is ${JSON.stringify(magic)}, not "ustar"`)
  }
  const name = decodeString(block.subarray(0, 100))
  const prefix = decodeString(block.subarray(345, 500))
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: parseOctal(block.subarray(100, 108)) & 0o7777,
    size: parseOctal(block.subarray(124, 136)),
    typeFlag: String.fromCharCode(block[156] || 0x30),
    linkName: decodeString(block.subarray(157, 257)),
  }
}

function isBlankBlock(block) {
  for (let i = 0; i < BLOCK; i += 1) if (block[i] !== 0) return false
  return true
}

/** Parse a pax extended-header record set; returns `{ path }` when present. */
function parsePax(text) {
  const out = {}
  let offset = 0
  while (offset < text.length) {
    const space = text.indexOf(' ', offset)
    if (space === -1) break
    const len = Number.parseInt(text.slice(offset, space), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const record = text.slice(space + 1, offset + len)
    const eq = record.indexOf('=')
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1)
    offset += len
  }
  return out
}

/**
 * Entries from a `.tar.gz`. Returns `[{ name, type, mode, bytes }]` with the
 * bytes already checked against the declared size.
 */
export function readTarGz(buffer, { maxOutputLength = MAX_DECOMPRESSED_BYTES } = {}) {
  let tar
  try {
    tar = zlib.gunzipSync(buffer, { maxOutputLength })
  } catch (error) {
    // The two answers are different facts and must not share a sentence: "this is not
    // gzip" says the release published garbage; "this is gzip asking for more than the
    // cap" says the release published something this machine will not inflate. Whoever
    // reads the second one needs to know it was a choice, and what the choice was about.
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
      const cap = `${(maxOutputLength / (1024 * 1024)).toFixed(1)} MiB`
      throw new UpdaterError(
        CODES.archiveUnreadable,
        `archive is gzip, but inflating it asks for more than the ${cap} this tool will hold for one release archive (the compressed stream itself is ${(buffer.length / 1024).toFixed(0)} KiB): that ratio is a compression bomb, not a release tree, and it is refused by name. Nothing was extracted.`,
      )
    }
    throw new UpdaterError(CODES.archiveUnreadable, `archive is not valid gzip data (${error.message})`)
  }
  const entries = []
  let offset = 0
  let pendingName = null
  let pendingMode = null
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK)
    if (isBlankBlock(block)) {
      offset += BLOCK
      continue
    }
    const header = readHeader(block)
    offset += BLOCK
    const data = tar.subarray(offset, offset + Math.ceil(header.size / BLOCK) * BLOCK)
    if (data.length < header.size) {
      throw new UpdaterError(CODES.archiveUnreadable, `archive ends inside the payload of ${header.name}`)
    }
    offset += Math.ceil(header.size / BLOCK) * BLOCK

    if (header.typeFlag === 'L') {
      // GNU long name: applies to the next entry.
      pendingName = Buffer.from(data.subarray(0, header.size)).toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (header.typeFlag === 'x' || header.typeFlag === 'X') {
      const pax = parsePax(Buffer.from(data.subarray(0, header.size)).toString('utf8'))
      if (header.typeFlag === 'x' && pax.path) pendingName = pax.path
      continue
    }
    const name = pendingName ?? header.name
    const mode = pendingMode ?? header.mode
    pendingName = null
    pendingMode = null
    if (header.typeFlag === 'g') continue
    if (header.typeFlag === '1' || header.typeFlag === '2') {
      // A link inside the archive is *data about the tree*, and `git archive` puts them
      // there (this repo has symlinked icon files, and every real release of it carried
      // one — found by running `check` against v1.5.1 on a real machine). We do not
      // create links. We materialize the target's **bytes** at the link's path, which
      // keeps the release tree complete while leaving the staged tree free of anything
      // a later `cp`/`npm install`/`swift build` step could be led to follow.
      // Refused outright: an absolute or escaping target, an empty one, a link to a link,
      // and a target the archive does not contain as a regular file.
      const link = String(header.linkName ?? '')
      if (link === '') {
        throw new UpdaterError(
          CODES.archiveEntryUnsupported,
          `archive entry ${JSON.stringify(name)} is a link (${JSON.stringify(header.typeFlag)}) that names no target`,
        )
      }
      entries.push({ name, type: 'link', linkName: link, mode: header.mode })
      continue
    }
    if (!['0', '\0', '', '5'].includes(header.typeFlag)) {
      throw new UpdaterError(
        CODES.archiveEntryUnsupported,
        `archive entry ${JSON.stringify(name)} has type flag ${JSON.stringify(header.typeFlag)}: only files, directories and links to a file inside the same archive are extracted, so devices, FIFOs and anything else are refused`,
      )
    }
    entries.push({
      name,
      type: header.typeFlag === '5' ? 'dir' : 'file',
      mode,
      bytes: Buffer.from(data.subarray(0, header.size)),
    })
  }
  return entries
}

/**
 * Refuse or accept an entry name. Absolute paths, `..` hops and backslash
 * tricks never reach the filesystem.
 */
export function safeEntryTarget(destDir, name) {
  const raw = String(name ?? '')
  if (raw === '') {
    throw new UpdaterError(CODES.archiveEntryUnsafe, 'archive entry with an empty name')
  }
  if (path.isAbsolute(raw) || raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new UpdaterError(CODES.archiveEntryUnsafe, `archive entry ${JSON.stringify(raw)} names an absolute path`)
  }
  if (raw.includes('\\')) {
    throw new UpdaterError(CODES.archiveEntryUnsafe, `archive entry ${JSON.stringify(raw)} uses a backslash path separator`)
  }
  let target
  try {
    target = resolveWithin(destDir, path.join(destDir, raw), 'archive entry')
  } catch (error) {
    throw new UpdaterError(CODES.archiveEntryUnsafe, `archive entry ${JSON.stringify(raw)} would be written outside the staging directory (${error.message})`)
  }
  for (const segment of raw.split('/')) {
    if (segment === '..') {
      throw new UpdaterError(CODES.archiveEntryUnsafe, `archive entry ${JSON.stringify(raw)} walks out of the staging directory`)
    }
  }
  return target
}

/**
 * Where a link entry's target lands, and whether it is legal at all.
 *
 * tar writes a link's target **relative to the directory of the entry that carries
 * it**, not relative to the archive root — reading it the other way turns `../x`
 * into a path outside the tree on one host and inside it on another. Absolute targets
 * are refused outright; a `..` hop is allowed only while the resolution stays inside
 * the staging directory, and the target must be a file the archive itself carries
 * (checked against the entry list in `extractTarGz`'s first pass, so a trap is a
 * refusal before a single byte is written).
 */
export function safeLinkTarget(destDir, entryTarget, linkName) {
  const raw = String(linkName ?? '')
  if (raw === '') {
    throw new UpdaterError(CODES.archiveEntryUnsafe, 'archive link with an empty target')
  }
  if (path.isAbsolute(raw) || raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new UpdaterError(CODES.archiveEntryUnsafe, `archive link ${JSON.stringify(raw)} names an absolute path`)
  }
  if (raw.includes('\\')) {
    throw new UpdaterError(CODES.archiveEntryUnsafe, `archive link ${JSON.stringify(raw)} uses a backslash path separator`)
  }
  try {
    return resolveWithin(destDir, path.join(path.dirname(entryTarget), raw), 'archive link target')
  } catch (error) {
    throw new UpdaterError(CODES.archiveEntryUnsafe, `archive link ${JSON.stringify(raw)} points outside the staging directory (${error.message})`)
  }
}

/**
 * Extract a `.tar.gz` into `destDir` (which must be inside `allowedRoot`, i.e.
 * inside the state root). Refuses *before* writing when any entry is unsafe —
 * entries are validated in a first pass so a trap halfway through the archive
 * cannot leave a partially written tree behind.
 */
export function extractTarGz(buffer, destDir, { allowedRoot, maxOutputLength = MAX_DECOMPRESSED_BYTES } = {}) {
  const root = allowedRoot ?? destDir
  resolveWithin(root, destDir, 'staging directory')
  const entries = readTarGz(buffer, { maxOutputLength })
  const targets = entries.map((entry) => ({ entry, target: safeEntryTarget(destDir, entry.name) }))

  // First pass: no filesystem writes. Every link is resolved against the archive's own
  // entry list, so "what does this point at" is decided by the archive's contents and
  // never by whatever happens to exist on the machine.
  const byTarget = new Map()
  for (const { entry, target } of targets) {
    if (byTarget.has(target) && entry.type !== 'link') {
      throw new UpdaterError(CODES.archiveEntryUnsafe, `archive carries two entries named ${JSON.stringify(entry.name)}: the second would silently replace the first`)
    }
    byTarget.set(target, entry)
  }
  const links = []
  for (const { entry, target } of targets) {
    if (entry.type !== 'link') continue
    const sourceTarget = safeLinkTarget(destDir, target, entry.linkName)
    const source = byTarget.get(sourceTarget)
    if (!source) {
      throw new UpdaterError(
        CODES.archiveEntryUnsupported,
        `archive link ${JSON.stringify(entry.name)} targets ${JSON.stringify(entry.linkName)}, which the archive does not carry as a file: nothing is materialized from a target we cannot read out of the archive itself`,
      )
    }
    if (source.type !== 'file') {
      throw new UpdaterError(
        CODES.archiveEntryUnsupported,
        `archive link ${JSON.stringify(entry.name)} targets a ${source.type} (${JSON.stringify(entry.linkName)}): only links to a file inside the archive are materialized`,
      )
    }
    links.push({ entry, target, source })
  }

  const written = []
  for (const { entry, target } of targets) {
    if (entry.type === 'link') continue
    if (entry.type === 'dir') {
      fs.mkdirSync(target, { recursive: true })
      // `tightenMode` rather than `chmodSync`: the staged tree is where unverified
      // release bytes land before any gate has finished with them, and a mode that
      // did not stick has to be a refusal, not a line in a log.
      tightenMode(target, stagedMode(entry.mode, 0o755), 'staged directory')
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const mode = stagedMode(entry.mode, 0o644)
      fs.writeFileSync(target, entry.bytes, { mode })
      tightenMode(target, mode, 'staged file')
    }
    written.push(target)
  }
  // Links become **copies of the archive's own bytes** for their target — never a link on
  // disk. The staged tree therefore holds no indirection for a later `cp`, `npm install`
  // or `swift build` to be walked through, and taking the bytes from the parsed entry
  // (not from the file on disk) means same-user code cannot swap the target between the
  // two passes, which is the adversary §2.2 of SECURITY.md names.
  for (const { target, source } of links) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // The **target's** mode, not the link entry's: tar records a symlink's mode as 0777,
    // and copying that onto a regular file would hand every reader write access to a
    // release byte (measured on the real v1.5.1 tree: the icon link came in 0777).
    // `+x` is the one bit inherited from the link itself, and only when the target is
    // already executable — the archive's file entry decides whether this is a script.
    const mode = stagedMode(source.mode, 0o644)
    fs.writeFileSync(target, source.bytes, { mode })
    tightenMode(target, mode, 'staged file')
    written.push(target)
  }
  return {
    destDir,
    entries: targets.map(({ entry }) => ({
      name: entry.name,
      type: entry.type,
      size: entry.type === 'link' ? 0 : entry.bytes.length,
      linkName: entry.linkName ?? null,
    })),
    written,
  }
}

/* --------------------------------------------------------- test-side writer */

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function nameFields(name) {
  const bytes = Buffer.from(name, 'utf8')
  if (bytes.length <= 100) return { name: bytes, prefix: Buffer.alloc(0), long: null }
  const split = name.lastIndexOf('/', 255)
  if (split > 0 && Buffer.byteLength(name.slice(0, split)) <= 155 && Buffer.byteLength(name.slice(split + 1)) <= 100) {
    return { name: Buffer.from(name.slice(split + 1)), prefix: Buffer.from(name.slice(0, split)), long: null }
  }
  const header = Buffer.alloc(BLOCK)
  header.write('0'.repeat(100), 0) // patched by caller; placeholder
  return { name: Buffer.alloc(0), prefix: Buffer.alloc(0), long: name }
}

function buildHeader({ name, prefix, mode, size, typeFlag, linkName = '' }) {
  const block = Buffer.alloc(BLOCK, 0)
  block.set(name.subarray(0, 100), 0)
  block.write(octal(mode, 8), 100)
  block.write(octal(0, 8), 108)
  block.write(octal(0, 8), 116)
  block.write(octal(size, 12), 124)
  block.write(octal(0, 12), 136)
  block.write('        ', 148) // checksum placeholder: spaces while computing
  block.write(typeFlag, 156)
  if (linkName) block.set(Buffer.from(linkName, 'utf8').subarray(0, 100), 157)
  block.set(Buffer.from('ustar\0'), 257)
  block.set(Buffer.from('00'), 263)
  if (prefix && prefix.length) block.set(prefix.subarray(0, 155), 345)
  let sum = 0
  for (let i = 0; i < BLOCK; i += 1) sum += block[i]
  // 6 octal digits + NUL + space, the field's exact 8-byte width.
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return block
}

/**
 * Build a deterministic `.tar.gz` from `[{ name, content, mode, type, link }]`.
 * `type: 'link'` with `link: '<target>'` writes a symlink entry (flag `2`), and
 * `flag: '1'` on it writes a hard-link entry — the two shapes a real `git archive`
 * produces. Anything else can be forced with `flag`, which is how the refusal tests
 * get a device or FIFO entry into an archive.
 * Test-only companion of {@link readTarGz}.
 */
export function packTarGz(entries) {
  const blocks = []
  for (const entry of entries) {
    const isDir = entry.type === 'dir'
    const isLink = entry.type === 'link'
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '', 'utf8')
    const { name, prefix, long } = nameFields(entry.name)
    if (long !== null) {
      const payload = Buffer.from(long, 'utf8')
      const padded = Buffer.alloc(Math.ceil(payload.length / BLOCK) * BLOCK, 0)
      payload.copy(padded)
      blocks.push(buildHeader({ name: Buffer.from('./PaxHeaders.0/LongName'), mode: 0o644, size: payload.length, typeFlag: 'L' }))
      blocks.push(padded)
    }
    blocks.push(buildHeader({
      name,
      prefix,
      mode: entry.mode ?? (isDir ? 0o755 : 0o644),
      size: isDir || isLink ? 0 : content.length,
      typeFlag: entry.flag ?? (isDir ? '5' : isLink ? '2' : '0'),
      linkName: isLink ? String(entry.link ?? '') : '',
    }))
    if (!isDir && !isLink && content.length) {
      const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK, 0)
      content.copy(padded)
      blocks.push(padded)
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0))
  return zlib.gzipSync(Buffer.concat(blocks))
}
