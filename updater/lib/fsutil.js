/**
 * Filesystem primitives with teeth: guarded paths, and writes whose mode is
 * *verified after the fact*.
 *
 * Two rules run through this file:
 *
 * 1. Nothing outside `<stateRoot>/update-staging/`, `<stateRoot>/update-backup/`
 *    and the updater's own state/pointer files is ever deleted or overwritten.
 *    A path that resolves outside the state root is a refusal, not a warning —
 *    and "resolves" has to mean the **filesystem's** answer, not the string's:
 *    `path.resolve` folds `..` and makes the path absolute, but a component that
 *    *is* a symbolic link keeps walking out no matter how clean its spelling is.
 *    `isWithin`/`resolveWithin` therefore compare `realContainerPath` (the real
 *    path of the components that exist, with an not-yet-created tail kept
 *    verbatim), and `assertPrivateRoot` refuses a root that is itself a link —
 *    because every write through that name lands in whatever it points at.
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
/**
 * A name no other writer can already be holding: pid + a clock + this process's own counter.
 *
 * Exported because every "write then rename" in this package needs it. `${target}.part`-style *fixed* temp
 * names do not: the panel's Install button and the daily job are two processes that stage the same version
 * into the same directory, and a shared temp is one `renameSync` away from answering ENOENT about a file
 * the other run had already moved (`lib/staging.js`'s `writeArchive` did exactly that until 2026-10-15).
 */
export function uniqueToken() {
  tokenCounter += 1
  return `${process.pid}-${Date.now().toString(36)}-${tokenCounter}`
}

/** Canonical absolute form: no trailing slash (except the filesystem root). */
export function canonicalPath(target) {
  const abs = path.resolve(target)
  return abs.length > 1 ? abs.replace(/\/+$/, '') || path.sep : abs
}

/**
 * The path `p` *actually* names, following the components the filesystem already has.
 *
 * `path.resolve` only folds `..` and makes the string absolute; it cannot see that a component is a
 * symbolic link, and this file already knows that (`realWithin`, `sameRuntimePath`) — which is exactly
 * the inconsistency this closes. Every containment promise here ("nothing outside
 * `<stateRoot>/update-staging/` is ever deleted") was a string comparison, so a state root — or
 * `<root>/update-staging` — that *is* a link made the promise hold about a name while the writes and
 * the removals landed wherever the link pointed, including the live `~/.glasspane`.
 *
 * Only the components that exist are resolved; a tail that has not been created yet (a staging
 * directory about to be made) is kept verbatim, so "not created yet" never reads as "outside".
 */
export function realContainerPath(target) {
  const abs = canonicalPath(target)
  let current = abs
  const tail = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return abs
    }
    const parent = path.dirname(current)
    if (parent === current) return abs
    tail.unshift(path.basename(current))
    current = parent
  }
}

/** True when `candidate` is `root` or lives under it, following the links that exist. */
export function isWithin(root, candidate) {
  const r = realContainerPath(root)
  const c = realContainerPath(candidate)
  return c === r || c.startsWith(r + path.sep)
}

/**
 * Refuse a root that is itself a symbolic link.
 *
 * A link named `<sandbox>` is not a sandbox: `mkdir` answers "it exists", `chmod` tightens the target,
 * and every file written under the name lands in the directory the caller thought they were avoiding.
 * `--consent state-dir` is the human answer to "I do mean that other install", so the refusal names it.
 * Paths that do not exist yet are fine — this call is what creates them, as a real directory.
 */
export function assertPrivateRoot(target, label = 'state root') {
  let stats = null
  try {
    stats = fs.lstatSync(target)
  } catch {
    return canonicalPath(target)
  }
  if (stats.isSymbolicLink()) {
    throw new UpdaterError(
      'path-outside-state-root',
      `the ${label} ${canonicalPath(target)} is a symbolic link to ${(() => { try { return fs.realpathSync(target) } catch { return 'somewhere unreadable' } })()}: `
        + "writing through that name would put the updater's state, staging and deletions in whatever the link points at rather than in the root it was asked to use, "
        + 'so nothing was written and nothing was removed. Point --state-dir at the real directory, or — if this machine really means that other install — pass --consent state-dir',
    )
  }
  return canonicalPath(target)
}

/**
 * The realpath of `p` when the filesystem can answer, its lexical form when it cannot.
 *
 * node hands a running script's own module URL back *realpath'd* (measured: starting
 * `/private/var/…/gp-linkprobe-link/cli.mjs` through a symlinked directory reports the `…-real`
 * path), while `canonicalPath` is a lexical `path.resolve`. Comparing the two directly is how a
 * self-update could never verify itself on exactly the machines this feature is tested on — a state
 * root under `/tmp` or `/var/tmp`, or any `GLASSPANE_STATE_DIR` that goes through a link.
 *
 * (Moved here from `lib/runtime.js` on 2026-10-09, because a second reader of the same fact —
 * `launchd.js`'s registration check — needed it and importing `runtime.js` from `launchd.js` would
 * have made the two modules a cycle: `runtime.js` already imports `launchd.js`.)
 */
export function realWithin(p) {
  const text = String(p ?? '')
  if (text === '') return text
  try {
    return fs.realpathSync(text)
  } catch {
    return text
  }
}

/**
 * Do these two spellings name the same path, allowing for a symlinked component on either side?
 *
 * This is the strict answer to "is this argument *the* path we named".
 * `arg === cliPath || arg.includes(String(cliPath))` — the shape `registerAgent` used
 * until 2026-10-09 — is not: anything that merely *contains* the named path verifies, so
 * `/tmp/dropin/<cliPath>` or a `sh -c` line that quotes it reports the job as registered
 * while launchd is holding something else entirely. `lib/runtime.js`'s reader of the same
 * book has always demanded this function, which is what made the two disagree: one said
 * `verified`, the other said the loaded job names something else, about one definition.
 */
export function sameRuntimePath(a, b) {
  const left = canonicalPath(a)
  const right = canonicalPath(b)
  if (left === right) return true
  const realLeft = realWithin(left)
  const realRight = realWithin(right)
  return realLeft === realRight && realLeft !== ''
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
  // The one choke point every write and every removal in this subsystem passes through — if the root
  // itself is a link, the four names below are four promises about a directory nobody chose.
  const root = assertPrivateRoot(stateRoot)
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
  // `mkdir -p` on a name that is already a link answers "it exists" and the `chmod` below then tightens
  // the *target*, so this has to be refused before either syscall — not after the mode was read back.
  assertPrivateRoot(dir, 'directory')
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
      removeEntry(path.join(resolved, entry))
    }
    return resolved
  }
  removeEntry(resolved)
  return resolved
}

/**
 * One entry, leaves first, and the **first** errno that comes back is the one thrown.
 *
 * `fs.rmSync(dir, { recursive: true })` reports `ENOTEMPTY` for the parent when a child
 * inside it could not be unlinked: on this machine the same tree, written by the same run,
 * answered "Directory not empty: …/update-staging/1.4.1/tree" for a directory whose child
 * was mode 0500 — a permission denial dressed up as a bookkeeping complaint, and the
 * sentence a person or an agent reads is the refusal's whole diagnosis. Walking here keeps
 * the cause's own code and path attached.
 */
function removeEntry(entry) {
  let stats
  try {
    stats = fs.lstatSync(entry)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    let names
    try {
      names = fs.readdirSync(entry)
    } catch (error) {
      throw namedRemovalFailure(entry, error)
    }
    for (const name of names) removeEntry(path.join(entry, name))
    try {
      fs.rmdirSync(entry)
    } catch (error) {
      throw namedRemovalFailure(entry, error)
    }
    return
  }
  try {
    fs.unlinkSync(entry)
  } catch (error) {
    throw namedRemovalFailure(entry, error)
  }
}

function namedRemovalFailure(entry, error) {
  const wrapped = new Error(`${error?.code ?? 'removal failed'}: ${entry} (${error?.message ?? String(error)})`)
  wrapped.code = error?.code ?? 'EUNKNOWN'
  wrapped.path = entry
  return wrapped
}

/** Mode of a path (`null` when it does not exist). */
export function modeOf(target) {
  try {
    return fs.statSync(target).mode & 0o777
  } catch {
    return null
  }
}
