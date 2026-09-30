/**
 * Filesystem primitives with teeth: guarded paths, and writes whose mode is
 * *verified after the fact*.
 *
 * Two rules run through this file:
 *
 * 1. Nothing outside `<stateRoot>/update-staging/`, `<stateRoot>/update-backup/`
 *    and the updater's own state/pointer files is ever deleted or overwritten.
 *    A path that resolves outside the state root is a refusal, not a warning —
 *    which means it is resolved (`path.resolve`) *before* it is compared, so
 *    `..` segments and symlinks-in-the-string cannot walk out.
 * 2. `chmod` is not proof. A volume that ignores permission bits (read-only
 *    mount, ACL, immutable flag, a USB stick without the metadata) answers
 *    `chmod` with success and leaves the old mode in place, so every write
 *    reads the mode back and fails the write when it did not stick. Same shape
 *    as `mcp-shell/src/project-registry.ts`'s `tightenMode`, because both
 *    writers touch the daemon's state root and must promise the same thing.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export const STATE_DIR_MODE = 0o700
export const STATE_FILE_MODE = 0o600
export const STAGING_DIR_NAME = 'update-staging'
export const BACKUP_DIR_NAME = 'update-backup'
export const STATE_FILE_NAME = 'update-state.json'
export const POINTER_FILE_NAME = 'update-install.json'
/** §11: where a verified release tree lands so the updater can update itself. */
export const RUNTIME_DIR_NAME = 'runtime'

export class UpdaterError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = 'UpdaterError'
    this.code = code
    this.details = details
  }
}

let tokenCounter = 0
function uniqueToken() {
  tokenCounter += 1
  return `${process.pid}-${Date.now().toString(36)}-${tokenCounter}`
}

/** Canonical absolute form: no trailing slash (except the filesystem root). */
export function canonicalPath(target) {
  const abs = path.resolve(target)
  return abs.length > 1 ? abs.replace(/\/+$/, '') || path.sep : abs
}

/** True when `candidate` is `root` or lives under it (already resolved). */
export function isWithin(root, candidate) {
  const r = canonicalPath(root)
  const c = canonicalPath(candidate)
  return c === r || c.startsWith(r + path.sep)
}

/**
 * Resolve `candidate` and refuse it unless it is inside `root`.
 * Returns the resolved absolute path.
 */
export function resolveWithin(root, candidate, label = 'path') {
  const resolved = path.resolve(candidate)
  if (!isWithin(root, resolved)) {
    throw new UpdaterError(
      'path-outside-state-root',
      `${label} ${resolved} resolves outside ${canonicalPath(root)}; the updater writes only inside its own state root, so this was refused rather than cleaned up`,
    )
  }
  return resolved
}

/** The writable locations this subsystem may ever touch. */
export function writableRoots(stateRoot) {
  const root = canonicalPath(stateRoot)
  return {
    stateRoot: root,
    staging: path.join(root, STAGING_DIR_NAME),
    backup: path.join(root, BACKUP_DIR_NAME),
    runtime: path.join(root, RUNTIME_DIR_NAME),
    stateFile: path.join(root, STATE_FILE_NAME),
    pointerFile: path.join(root, POINTER_FILE_NAME),
  }
}

/** `0700` directory, created if missing, mode verified afterwards. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE })
  tightenMode(dir, STATE_DIR_MODE, 'directory')
  return dir
}

/**
 * Bring one existing path to `want` and *read the mode back*.
 * Throws when chmod fails, when the stat fails, or when the mode did not stick.
 *
 * `statMode` is injectable so a test can simulate the volume this check exists
 * for — one where `chmod` answers success and the mode stays loose. The default
 * is the real `stat`; only the "did not stick" branch needs the simulation, and
 * `test/state.test.mjs` pins the real path with real mode assertions.
 */
export function tightenMode(target, want, kind = 'file', { statMode = null } = {}) {
  try {
    fs.chmodSync(target, want)
  } catch (error) {
    throw new UpdaterError(
      'state-write-unverified',
      `the ${kind} ${target} could not be made owner-only (chmod ${(want & 0o777).toString(8)} failed: ${error.message})`,
    )
  }
  let mode
  try {
    mode = statMode ? statMode(target) : fs.statSync(target).mode & 0o777
  } catch (error) {
    throw new UpdaterError(
      'state-write-unverified',
      `the ${kind} ${target} was tightened but cannot be read back (${error.message})`,
    )
  }
  if (mode !== want) {
    throw new UpdaterError(
      'state-write-unverified',
      `the ${kind} ${target} is still ${(mode & 0o777).toString(8)} after chmod(${(want & 0o777).toString(8)}): `
        + 'this volume does not hold permission bits, so an owner-only write is not achievable here',
    )
  }
  return mode
}

/**
 * Atomic owner-only write: unique temp name -> tighten -> rename -> tighten
 * again (a rename can hand the destination's older, looser mode to the item
 * that lands) -> verify. Returns the final verified mode.
 */
export function writePrivateFile(filePath, text, { statMode = null } = {}) {
  const options = { statMode }
  const dir = path.dirname(filePath)
  ensurePrivateDir(dir)
  const tmpPath = `${filePath}.tmp-${uniqueToken()}`
  try {
    fs.writeFileSync(tmpPath, text, 'utf8')
    tightenMode(tmpPath, STATE_FILE_MODE, 'file', options)
    fs.renameSync(tmpPath, filePath)
    return tightenMode(filePath, STATE_FILE_MODE, 'file', options)
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      /* temp already gone, or never created */
    }
    throw error
  }
}

/** Recursively remove a directory, refusing anything outside `allowedRoot`. */
export function removeTreeWithin(allowedRoot, target) {
  const resolved = resolveWithin(allowedRoot, target, 'removal target')
  if (canonicalPath(resolved) === canonicalPath(allowedRoot)) {
    // Deleting the guard root itself would remove the very path the next
    // refusal check compares against; drop the contents, keep the directory.
    for (const entry of fs.readdirSync(resolved)) {
      fs.rmSync(path.join(resolved, entry), { recursive: true, force: true })
    }
    return resolved
  }
  fs.rmSync(resolved, { recursive: true, force: true })
  return resolved
}

/** Mode of a path (`null` when it does not exist). */
export function modeOf(target) {
  try {
    return fs.statSync(target).mode & 0o777
  } catch {
    return null
  }
}
