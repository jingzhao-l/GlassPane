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
import { UpdaterError, ensurePrivateDir, resolveWithin, removeTreeWithin, tightenMode, writableRoots, STATE_DIR_MODE, STATE_FILE_MODE } from './fsutil.js'
import { extractTarGz } from './tar.js'

/** `<stagingRoot>/<version>` — created `0700`, path checked against escapes. */
export function prepareStaging({ stateRoot, version }) {
  const { staging } = writableRoots(stateRoot)
  ensurePrivateDir(staging)
  if (!/^\d+\.\d+\.\d+$/.test(String(version ?? ''))) {
    throw new UpdaterError(CODES.tagUnparseable, `refusing to create a staging directory named ${JSON.stringify(version)}`)
  }
  const dir = resolveWithin(staging, path.join(staging, version), 'staging directory')
  ensurePrivateDir(dir)
  return { dir, archivePath: path.join(dir, 'archive.tar.gz'), treePath: path.join(dir, 'tree'), stagingRoot: staging }
}

/** Write the archive bytes with an owner-only mode. */
export function writeArchive(archivePath, bytes, { stagingRoot }) {
  const target = resolveWithin(stagingRoot, archivePath, 'archive path')
  const tmp = `${target}.part`
  fs.writeFileSync(tmp, bytes, { mode: STATE_FILE_MODE })
  // Every `chmod` in this file is `tightenMode`: a volume that answers chmod with
  // success while keeping the loose mode is exactly what an owner-only staging
  // directory exists to exclude, and "we asked" is not "it is".
  tightenMode(tmp, STATE_FILE_MODE, 'staged archive')
  fs.renameSync(tmp, target)
  tightenMode(target, STATE_FILE_MODE, 'staged archive')
  return target
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

/** Drop a staged version (called whenever a gate fails after download). */
export function discardStaging({ stateRoot, dir }) {
  const { staging } = writableRoots(stateRoot)
  return removeTreeWithin(staging, dir ?? staging)
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
