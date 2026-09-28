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
export function readTarGz(buffer) {
  let tar
  try {
    tar = zlib.gunzipSync(buffer)
  } catch (error) {
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
    if (!['0', '\0', '', '5'].includes(header.typeFlag)) {
      throw new UpdaterError(
        CODES.archiveEntryUnsupported,
        `archive entry ${JSON.stringify(name)} has type flag ${JSON.stringify(header.typeFlag)}: only files and directories are extracted, so links, devices and FIFOs are refused`,
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
 * Extract a `.tar.gz` into `destDir` (which must be inside `allowedRoot`, i.e.
 * inside the state root). Refuses *before* writing when any entry is unsafe —
 * entries are validated in a first pass so a trap halfway through the archive
 * cannot leave a partially written tree behind.
 */
export function extractTarGz(buffer, destDir, { allowedRoot } = {}) {
  const root = allowedRoot ?? destDir
  resolveWithin(root, destDir, 'staging directory')
  const entries = readTarGz(buffer)
  const targets = entries.map((entry) => ({ entry, target: safeEntryTarget(destDir, entry.name) }))
  const written = []
  for (const { entry, target } of targets) {
    if (entry.type === 'dir') {
      fs.mkdirSync(target, { recursive: true })
      // `tightenMode` rather than `chmodSync`: the staged tree is where unverified
      // release bytes land before any gate has finished with them, and a mode that
      // did not stick has to be a refusal, not a line in a log.
      tightenMode(target, (entry.mode || 0o755) & 0o777, 'staged directory')
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, entry.bytes, { mode: (entry.mode || 0o644) & 0o777 })
      tightenMode(target, (entry.mode || 0o644) & 0o777, 'staged file')
    }
    written.push(target)
  }
  return { destDir, entries: entries.map((e) => ({ name: e.name, type: e.type, size: e.bytes.length })), written }
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

function buildHeader({ name, prefix, mode, size, typeFlag }) {
  const block = Buffer.alloc(BLOCK, 0)
  block.set(name.subarray(0, 100), 0)
  block.write(octal(mode, 8), 100)
  block.write(octal(0, 8), 108)
  block.write(octal(0, 8), 116)
  block.write(octal(size, 12), 124)
  block.write(octal(0, 12), 136)
  block.write('        ', 148) // checksum placeholder: spaces while computing
  block.write(typeFlag, 156)
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
 * Build a deterministic `.tar.gz` from `[{ name, content, mode, type }]`.
 * Test-only companion of {@link readTarGz}.
 */
export function packTarGz(entries) {
  const blocks = []
  for (const entry of entries) {
    const isDir = entry.type === 'dir'
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
      size: isDir ? 0 : content.length,
      typeFlag: isDir ? '5' : '0',
    }))
    if (!isDir && content.length) {
      const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK, 0)
      content.copy(padded)
      blocks.push(padded)
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2, 0))
  return zlib.gzipSync(Buffer.concat(blocks))
}
