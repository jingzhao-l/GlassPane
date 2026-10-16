/**
 * Staging: the only place a downloaded archive ever exists, and the only tree
 * the updater is allowed to delete wholesale.
 *
 * Layout (spec §1.5, §7):
 *   `<stateRoot>/update-staging/<ver>/archive.tar.gz`  (0600, parent 0700)
 *   `<stateRoot>/update-staging/<ver>/tree/...`        (extracted, verified)
 *
 * Every path here is resolved against the staging root before it is used, so a
 * version string pulled out of a release tag (`../..`, `/etc`, an empty string)
 * is a refusal at this boundary rather than a write somewhere else.
 */
import fs from 'node:fs'
import path from 'node:path'

import { CODES } from './codes.js'
import { UpdaterError, canonicalPath, ensurePrivateDir, resolveWithin, removeTreeWithin, tightenMode, uniqueToken, writableRoots, STATE_DIR_MODE, STATE_FILE_MODE } from './fsutil.js'
import { extractTarGz } from './tar.js'
import { bumpKind, parsePlainVersion } from './version.js'

/** The one name the downloaded archive keeps inside a staging directory. */
export const ARCHIVE_FILE_NAME = 'archive.tar.gz'

/** `<stagingRoot>/<version>` — created `0700`, path checked against escapes. */
export function prepareStaging({ stateRoot, version }) {
  const { staging } = writableRoots(stateRoot)
  ensurePrivateDir(staging)
  if (!/^\d+\.\d+\.\d+$/.test(String(version ?? ''))) {
    throw new UpdaterError(CODES.tagUnparseable, `refusing to create a staging directory named ${JSON.stringify(version)}`)
  }
  const dir = resolveWithin(staging, path.join(staging, version), 'staging directory')
  ensurePrivateDir(dir)
  return { dir, archivePath: path.join(dir, ARCHIVE_FILE_NAME), treePath: path.join(dir, 'tree'), stagingRoot: staging }
}

/**
 * Write the archive bytes with an owner-only mode.
 *
 * The temp name carries a unique token (`fsutil.uniqueToken`: pid + clock + counter), **not** a fixed
 * `${target}.part`, because the panel's Install button and the daily job are two processes that stage the
 * same version into the same directory. With one shared name the second `renameSync` answers
 * `ENOENT: no such file or directory, rename '<…>.part' -> '<…>.tar.gz'` about a temp the other run had
 * already moved, and the refusal that follows is about a filesystem that appears to have lost a file rather
 * than about the two runs. A failure between the write and the rename now takes its own temp with it too,
 * so a refused download leaves no bytes behind for the next run to trip over.
 *
 * `beforeRename` is a seam for `test/staging-concurrency.test.mjs`, which needs a *second process* to have
 * its file in place at the exact moment this one renames. Nothing in production passes it.
 */
export function writeArchive(archivePath, bytes, { stagingRoot, token = null, beforeRename = null }) {
  const target = resolveWithin(stagingRoot, archivePath, 'archive path')
  const tmp = `${target}.part-${String(token ?? uniqueToken())}`
  const parent = path.dirname(target)
  try {
    // The version directory is *this run's own* (created by `prepareStaging` a few lines earlier), and a
    // second run staging the same version discards it when its own gates refuse. Recreating it here is what
    // turns that into "both land" instead of a `check-failed` about a missing directory.
    ensurePrivateDir(parent)
    fs.writeFileSync(tmp, bytes, { mode: STATE_FILE_MODE })
    // Every `chmod` in this file is `tightenMode`: a volume that answers chmod with
    // success while keeping the loose mode is exactly what an owner-only staging
    // directory exists to exclude, and "we asked" is not "it is".
    tightenMode(tmp, STATE_FILE_MODE, 'staged archive')
    if (beforeRename) beforeRename({ tmp, target })
    fs.renameSync(tmp, target)
    tightenMode(target, STATE_FILE_MODE, 'staged archive')
    return target
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* never created, or already renamed into place by this very call */
    }
    throw error
  }
}

/**
 * Extract into `<staging>/<ver>/tree`. Extraction happens only into a directory
 * that is empty or was just created: an old tree left over from a previous run
 * is cleared first (inside the staging root only).
 */
export function extractInto({ treePath, stagingRoot, bytes }) {
  const target = resolveWithin(stagingRoot, treePath, 'tree path')
  if (fs.existsSync(target)) removeTreeWithin(stagingRoot, target)
  fs.mkdirSync(target, { recursive: true, mode: 0o700 })
  tightenMode(target, STATE_DIR_MODE, 'staged tree directory')
  const result = extractTarGz(bytes, target, { allowedRoot: stagingRoot })
  return { ...result, treePath: target }
}

/**
 * Drop a staged version (called whenever a gate fails after download).
 *
 * Answers as data — `{ok, leftBehind, reason}` — because "the refusal said it discarded the tree" and "the
 * tree is gone" are two claims, and this machine proved they can disagree: `~/.glasspane/update-staging/`
 * still held an empty `1.12.0/` from the refusal of 2026-10-11 and a whole 25 MB `1.5.1/archive.tar.gz`
 * under a state file that had long since stamped `applied`, while `lib/check.js`'s `catch {}` said
 * "nothing there to discard". Removal that did not happen is reported as removal that did not happen, and
 * the caller puts that in the sentence the panel shows.
 *
 * The path guard still *throws* (`path-outside-state-root`): that is a refusal to touch anything outside
 * the staging root, not a failed filesystem operation, and `test/tar.test.mjs` pins it.
 */
export function discardStaging({ stateRoot, dir, remove = removeTreeWithin, existsFn = (target) => fs.existsSync(target), readDir = (target) => fs.readdirSync(target) }) {
  const { staging } = writableRoots(stateRoot)
  const target = resolveWithin(staging, dir ?? staging, 'discard target')
  const isGuardRoot = canonicalPath(target) === canonicalPath(staging)
  try {
    remove(staging, target)
  } catch (error) {
    return {
      ok: false,
      dir: target,
      leftBehind: existsFn(target),
      reason: `throwing away ${target} failed (${error?.message ?? String(error)}): the bytes are still on disk`,
    }
  }
  // Read the answer back. `removeTreeWithin` keeps the guard root itself and empties it, so for that one
  // path "gone" means "no entries".
  if (!isGuardRoot && existsFn(target)) {
    return { ok: false, dir: target, leftBehind: true, reason: `${target} is still on disk after its removal was asked for — something else is holding it open or the delete did not take` }
  }
  if (isGuardRoot) {
    let left = []
    try {
      left = readDir(target)
    } catch (error) {
      return { ok: false, dir: target, leftBehind: true, reason: `${target} could not be read back after emptying it (${error?.message ?? String(error)})` }
    }
    if (left.length > 0) {
      return { ok: false, dir: target, leftBehind: true, reason: `${target} still holds ${left.join(', ')} after the discard was asked for` }
    }
  }
  return { ok: true, dir: target, leftBehind: false, reason: null }
}

/**
 * Retire the staging generations this machine no longer has an offer for.
 *
 * A successful apply retired only its own `<staging>/<version>` directory, so every earlier generation
 * stayed: measured on this machine, a full 25 MB archive under `update-staging/1.5.1/` beneath a state file
 * that had moved on three versions. That is not only disk — a stale tree is what a later `apply` has to be
 * *proven against* (`verifyStagedBytes`), and the fewer trees on the machine the less there is to prove.
 *
 * The rule is race-safe by construction: only a directory whose version is **equal to or older than** the
 * version just applied is removed. A strictly newer `<staging>/<version>` may be a second run (the panel
 * button, the daily job) staging its offer *right now*, and §7 makes an equal or older tree unapplyable
 * (`staged-not-newer`), so nothing legitimate can be in flight there. Names that are not a plain `x.y.z`
 * directory are left alone and *named* in the answer — this sweep is not a `rm -rf` of a directory it has
 * not read.
 *
 * Two options exist for the caller that has no swap behind it to make that rule safe (`sweepUnreferenced-
 * Generations`, i.e. the end of a check): `keep` protects the generations the state document still points at
 * whatever their number says, and `protectInFlight` leaves a directory that holds a `*.part-*` entry — a
 * download in the air — alone and names it. With both left at their defaults the post-swap behaviour is
 * unchanged.
 */
export function retireStaleGenerations({
  stateRoot,
  appliedVersion,
  also = [],
  keep = [],
  protectInFlight = false,
  remove = discardStaging,
  readDir = (target) => fs.readdirSync(target, { withFileTypes: true }),
  listDir = (target) => fs.readdirSync(target),
  existsFn = (target) => fs.existsSync(target),
  kindOf = bumpKind,
  parse = parsePlainVersion,
} = {}) {
  const { staging } = writableRoots(stateRoot)
  const removed = []
  const failed = []
  const skipped = []
  // The paths this machine's own document points at. Compared by canonical path, because the state file
  // stores what `prepareStaging` returned and a bind-mounted or symlinked temp root makes those strings
  // differ while the directory is the same one.
  const protectedDirs = new Set(keep.filter((dir) => typeof dir === 'string' && dir !== '').map((dir) => canonicalPath(dir)))
  if (!existsFn(staging)) {
    return { ok: true, removed, failed, skipped: [...skipped, `${staging} does not exist`] }
  }
  let applied = null
  try {
    applied = parse(appliedVersion)
  } catch {
    // Without a version to compare against, "no longer referenced" is not decidable, and guessing is how a
    // sweep eats the offer another run is writing. Say so instead.
    return { ok: false, removed, failed, skipped: [`${staging}: the applied version ${JSON.stringify(appliedVersion)} is not a plain x.y.z, so no generation could be judged stale`] }
  }
  const candidates = new Set([...also, path.join(staging, String(applied.version))])
  let entries = []
  try {
    entries = readDir(staging)
  } catch (error) {
    return { ok: false, removed: [], failed, skipped: [`${staging} could not be listed (${error?.message ?? String(error)})`] }
  }
  for (const entry of entries) {
    const full = path.join(staging, entry.name)
    if (!entry.isDirectory()) {
      skipped.push(`${full} is not a directory`)
      continue
    }
    if (protectedDirs.has(canonicalPath(full))) {
      // A generation the state file still points at is not stale by definition, whatever its number says:
      // this is the offer `apply` is allowed to trust (§7), and deleting it here would make the next
      // "Install update" a refusal about a missing tree.
      skipped.push(`${full} is referenced by this machine's state, so it is not stale`)
      continue
    }
    let candidate = null
    try {
      candidate = parse(entry.name)
    } catch {
      skipped.push(`${full} is not named as a version`)
      continue
    }
    const kind = kindOf(candidate, applied)
    if (kind !== 'none' && kind !== 'downgrade') {
      skipped.push(`${full} is newer than ${applied.version} (${kind}): left in place, it may be the offer another run is writing now`)
      continue
    }
    if (protectInFlight) {
      // `writeArchive` gives its temp a unique token *inside* the version directory, so a generation holding
      // a `*.part-*` entry has a download in progress right now — the equal-or-older rule alone cannot see
      // that, because the second run may be staging the *same* version this sweep is judging.
      let names = null
      try {
        names = listDir(full)
      } catch (error) {
        skipped.push(`${full} could not be read (${error?.message ?? String(error)}): left alone`)
        continue
      }
      const inflight = names.filter((name) => name.includes('.part'))
      if (inflight.length > 0) {
        skipped.push(`${full} is being written right now (${inflight.join(', ')}): left alone, it is another run's bytes`)
        continue
      }
    }
    candidates.add(full)
  }
  for (const dir of candidates) {
    if (protectedDirs.has(canonicalPath(dir))) {
      skipped.push(`${dir} is referenced by this machine's state, so it is not stale`)
      continue
    }
    // A generation that is not on the disk was not removed by this sweep either, and reporting it as removed
    // is how a record claims a cleanup that never happened (the `catch {}` in `lib/check.js` had the same
    // shape on the other side). The named-generation case in particular is *normal* here: the version this
    // run applied may already have been discarded by its own gate.
    if (!existsFn(dir)) {
      skipped.push(`${dir} is not on the disk, so there was nothing for this sweep to remove`)
      continue
    }
    const outcome = remove({ stateRoot, dir })
    if (outcome.ok === true) removed.push(dir)
    else failed.push({ dir, reason: outcome.reason })
  }
  return { ok: failed.length === 0, removed, failed, skipped }
}

/**
 * The sweep a *completed check* owes the disk.
 *
 * `retireStaleGenerations` only ever ran after a swap that succeeded, so on a machine whose apply cannot
 * succeed the stale trees are unremovable by design: measured on this machine, a full 25 MB
 * `update-staging/1.5.1/archive.tar.gz` and an empty `update-staging/1.12.0/` sitting under a state file that
 * named neither — bytes that a later `apply` still has to *prove against* (`verifyStagedBytes`) and that a
 * reader of the disk cannot tell from a live offer.
 *
 * This is the read-only-references version: the state document decides what is referenced, a generation with
 * a download in the air is left alone and named, and nothing outside the staging root is ever touched.
 * It never changes a verdict — a sweep that could not delete is a *stated* leftover, the way `discardStaging`
 * reports one.
 */
export function sweepUnreferencedGenerations({
  stateRoot,
  state = null,
  referenceVersion,
  retire = retireStaleGenerations,
  existsFn = (target) => fs.existsSync(target),
} = {}) {
  const { staging } = writableRoots(stateRoot)
  if (!existsFn(staging)) {
    // Nothing staged on this machine at all: not a failure, and not a sweep either — say which.
    return { ok: true, removed: [], failed: [], skipped: [`${staging} does not exist`] }
  }
  const keep = []
  if (state?.staged?.dir) keep.push(state.staged.dir)
  // `state.runtime` names the updater's own copy (`update-runtime/<version>`), which is not under the
  // staging root — but a record that ever did point inside it has to protect the *generation folder* that
  // holds it, not just the leaf path, or the sweep would delete the directory out from under the pointer.
  for (const value of [state?.runtime?.cliPath, state?.runtime?.treePath]) {
    if (typeof value !== 'string' || value === '') continue
    const relative = path.relative(staging, value)
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
    keep.push(path.join(staging, relative.split(path.sep)[0]))
  }
  return retire({ stateRoot, appliedVersion: referenceVersion, keep, protectInFlight: true })
}

/** Is a staged tree still on disk and shaped as claimed? `apply` asks before swapping. */
export function stagedTreePresent({ stateRoot, staged }) {
  const { staging } = writableRoots(stateRoot)
  if (!staged?.dir) return { ok: false, reason: 'the state file names no staged tree' }
  let dir
  try {
    dir = resolveWithin(staging, staged.dir, 'staged directory')
  } catch (error) {
    return { ok: false, reason: error.message }
  }
  const tree = path.join(dir, 'tree')
  if (!fs.existsSync(tree)) return { ok: false, reason: `the staged tree ${tree} is no longer on disk` }
  const root = releaseTreeRoot({ treePath: tree, version: staged.version })
  if (!root.ok) return { ok: false, reason: `${tree} is no longer a readable release tree (${root.reason})` }
  return { ok: true, dir, treePath: tree, rootPath: root.rootPath }
}

/**
 * Where the release's own files sit inside `<staging>/<ver>/tree`.
 *
 * `release.yml` builds the archive with `git archive --prefix="GlassPane-<ver>/"`,
 * so the extracted directory holds **one wrapper folder** and every path §1.6
 * names (`package.json`, `mcp-shell/package.json`,
 * `engine/Sources/GlassPaneEngine/EngineCore.swift`, `scripts/check-version.mjs`)
 * is one level below it. A tarball that puts them at the top is equally legal.
 * This resolves which of the two it is, and refuses anything else: "look for a
 * package.json somewhere underneath" is how a stray directory in an archive gets
 * to decide which tree gets *executed*.
 */
export function releaseTreeRoot({ treePath, version }) {
  if (!fs.existsSync(treePath)) return { ok: false, reason: `${treePath} does not exist`, rootPath: null }
  if (fs.existsSync(path.join(treePath, 'package.json'))) return { ok: true, rootPath: treePath, reason: null }
  const entries = fs.readdirSync(treePath, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory())
  if (entries.length !== 1 || dirs.length !== 1) {
    return {
      ok: false,
      rootPath: null,
      reason: `${treePath} holds ${entries.length} top-level entries (${dirs.length} directories) rather than the one release folder, so its version line cannot be located`,
    }
  }
  const wrapped = path.join(treePath, dirs[0].name)
  if (!fs.existsSync(path.join(wrapped, 'package.json'))) {
    return { ok: false, rootPath: null, reason: `the single top-level folder ${dirs[0].name} carries no package.json` }
  }
  const wrapper = `GlassPane-${version}`
  if (dirs[0].name !== wrapper) {
    return {
      ok: false,
      rootPath: null,
      reason: `the archive's top-level folder is named ${JSON.stringify(dirs[0].name)}, not ${JSON.stringify(wrapper)}: the tag and the bytes it wraps are not the same release`,
    }
  }
  return { ok: true, rootPath: wrapped, reason: null }
}
