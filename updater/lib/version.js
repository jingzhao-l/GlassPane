/**
 * Spec §1 gate 1 + 2: what counts as a newer version, and what the machine is
 * actually running.
 *
 * The tag grammar is exact (`^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`) — a
 * prerelease or a `vv1.2` or a `1.2` is unparseable, not "close enough". The
 * comparison is *strictly greater*: an equal version is never an update, and a
 * downgrade is refused with the same code.
 *
 * "Current" is not read from this package's package.json. It is read back from
 * the installed bundle (`CFBundleShortVersionString`) **and** from
 * `glasspaned --version`, and the two have to agree. They are the two things a
 * user sees, and a machine where they disagree is a half-finished install — an
 * update would overwrite one half and leave the other, so it is refused and the
 * user is pointed at the installer instead.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { CODES } from './codes.js'
import { UpdaterError } from './fsutil.js'

export const TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const PLAIN_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** `v1.2.3` -> `{ version: "1.2.3", major, minor, patch }`; anything else refuses. */
export function parseTag(tag) {
  const match = TAG_RE.exec(String(tag ?? ''))
  if (!match) {
    throw new UpdaterError(
      CODES.tagUnparseable,
      `release tag ${JSON.stringify(tag)} is not of the form v<MAJOR>.<MINOR>.<PATCH>: nothing was applied, and the release needs a corrected tag`,
    )
  }
  const [, major, minor, patch] = match
  return { version: `${major}.${minor}.${patch}`, major: Number(major), minor: Number(minor), patch: Number(patch) }
}

/** Parse a plain `x.y.z` (used for locally reported versions). */
export function parsePlainVersion(value) {
  const match = PLAIN_SEMVER_RE.exec(String(value ?? '').trim())
  if (!match) {
    throw new UpdaterError(CODES.versionMismatchLocal, `version ${JSON.stringify(value)} is not a plain x.y.z`)
  }
  return { version: match[0], major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** -1 / 0 / 1 comparison over numeric triples. */
export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parsePlainVersion(a) : a
  const right = typeof b === 'string' ? parsePlainVersion(b) : b
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return 0
}

/** True only when `candidate` is strictly newer than `current`. */
export function isStrictlyNewer(candidate, current) {
  return compareVersions(candidate, current) > 0
}

/** Which kind of bump takes `current` to `candidate`. */
export function bumpKind(candidate, current) {
  const order = compareVersions(candidate, current)
  if (order === 0) return 'none'
  if (order < 0) return 'downgrade'
  if (candidate.major > current.major) return 'major'
  if (candidate.minor > current.minor) return 'minor'
  return 'patch'
}

/* ------------------------------------------------------------- local truth */

/**
 * `CFBundleShortVersionString` out of an `.app`'s Info.plist.
 * Text-scanned rather than `plutil`-parsed: the value is a one-line string key
 * in a file this project generates, and shelling out to a system tool to read
 * one line is a bigger failure surface than the regex.
 */
export function readBundleVersion(appPath, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist')
  let text
  try {
    text = readFile(plistPath)
  } catch (error) {
    throw new UpdaterError(CODES.versionMismatchLocal, `Info.plist for ${appPath} could not be read (${error.message}): reinstall GlassPane`)
  }
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(text)
  if (!match) {
    throw new UpdaterError(CODES.versionMismatchLocal, `Info.plist at ${plistPath} carries no CFBundleShortVersionString: reinstall GlassPane`)
  }
  return parsePlainVersion(match[1]).version
}

/** `glasspaned --version` -> `x.y.z` (the line is `glasspaned 1.2.3`). */
export function readDaemonVersion(executable, { run = defaultRun } = {}) {
  const result = run(executable, ['--version'])
  const text = String(result?.stdout ?? '')
  if (!result || result.ok === false) {
    throw new UpdaterError(CODES.versionMismatchLocal, `the daemon binary ${executable} did not report a version: reinstall GlassPane`)
  }
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/m.exec(text)
  if (!match) {
    throw new UpdaterError(CODES.versionMismatchLocal, `the daemon binary ${executable} printed ${JSON.stringify(text.trim())}, which is not a version: reinstall GlassPane`)
  }
  return parsePlainVersion(match[1]).version
}

function defaultRun(bin, args) {
  const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 10_000 })
  if (res.error) return { ok: false, stdout: '', stderr: String(res.error.message) }
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/**
 * The §1.1 local consistency judgement: bundle version, daemon version, and the
 * verdict. `mismatch` carries both readings so `lastError.details` can name them.
 */
export function localVersion({ appsDir, daemonExecutable, settingsAppName, daemonAppName, run = defaultRun, readFile }) {
  const bundle = readBundleVersion(path.join(appsDir, daemonAppName), { readFile })
  const settingsBundle = readBundleVersion(path.join(appsDir, settingsAppName), { readFile })
  const daemon = readDaemonVersion(daemonExecutable, { run })
  const seen = { daemonApp: bundle, settingsApp: settingsBundle, daemonBinary: daemon }
  const distinct = [...new Set([bundle, settingsBundle, daemon])]
  if (distinct.length > 1) {
    return {
      ok: false,
      code: CODES.versionMismatchLocal,
      version: null,
      seen,
      message: `the installed GlassPane reports ${Object.entries(seen).map(([k, v]) => `${k}=${v}`).join(', ')} — these must match. Automatic update is refused on a half-installed machine: re-run the GlassPane installer, then update again.`,
    }
  }
  return { ok: true, code: null, version: daemon, seen, message: null }
}
