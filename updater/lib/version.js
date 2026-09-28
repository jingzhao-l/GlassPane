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
  } catch {
    // No bundle at all (headless install, moved directory, or simply not installed
    // yet): a reading that is *absent* is not the same as a reading that disagrees.
    return null
  }
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(text)
  if (!match) return null
  return parsePlainVersion(match[1]).version
}

/** `glasspaned --version` -> `x.y.z` (the line is `glasspaned 1.2.3`). */
export function readDaemonVersion(executable, { run = defaultRun } = {}) {
  const result = run(executable, ['--version'])
  const text = String(result?.stdout ?? '')
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/m.exec(text)
  if (match) return parsePlainVersion(match[1]).version
  // Measured 2026-09-27 against a real install: the daemon on this machine is 0.1.0
  // and answers `--version` with `unknown argument` + usage on fd 1, exit 64. The
  // flag is newer than the install, so *this is the normal case for exactly the
  // machines auto-update exists for* — treating it as a hard failure made the first
  // real `check` refuse to run at all. Report "no reading" and let `localVersion`
  // decide; the bundle plist usually knows the version.
  return null
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
  const readings = [bundle, settingsBundle, daemon].filter((v) => v !== null)
  if (readings.length === 0) {
    return {
      ok: false,
      code: CODES.versionMismatchLocal,
      version: null,
      seen,
      message: `nothing installed at ${appsDir} reports a version (no .app bundle Info.plist and a daemon that does not answer --version): run the GlassPane installer first — an updater that guessed its own starting point could not tell an upgrade from a downgrade.`,
    }
  }
  const distinct = [...new Set(readings)]
  if (distinct.length > 1) {
    return {
      ok: false,
      code: CODES.versionMismatchLocal,
      version: null,
      seen,
      message: `the installed GlassPane reports ${Object.entries(seen).map(([k, v]) => `${k}=${v}`).join(', ')} — these must match. Automatic update is refused on a half-installed machine: re-run the GlassPane installer, then update again.`,
    }
  }
  return { ok: true, code: null, version: readings[0], seen, message: null }
}
