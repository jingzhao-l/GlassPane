/**
 * Installing and checking the agent's stable entry point (§11's shape change).
 *
 * The entry lives at `<stateRoot>/runtime/agent-entry.js`, one path that never changes, so the launchd
 * definition can name it forever and a version move needs no re-registration. This module is the only
 * writer of that file, and it treats landing it like it treats every other published artifact here:
 * temp file, rename, **read the bytes back and compare**, mode re-read from disk.
 *
 * "Compare the bytes" is not ceremony. The source is the copy that is running this moment, so a
 * half-written or truncated entry would be the thing the daily job executes tomorrow, and a truncated
 * file that still parses is invisible to an existence check.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CODES } from './codes.js'
import { UpdaterError, ensurePrivateDir, modeOf, resolveWithin, writePrivateFile } from './fsutil.js'
import { runtimeRoot } from './runtime.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Where the shipped entry lives, relative to this module (`updater/agent-entry.js`). */
export const ENTRY_SOURCE = path.join(HERE, '..', 'agent-entry.js')

/** The one file the update agent's plist may ever name as its CLI. */
export function agentEntryPath(stateRoot) {
  if (typeof stateRoot !== 'string' || stateRoot === '') {
    throw new UpdaterError(CODES.homeRecordUnavailable, `the agent entry needs a state root, got ${JSON.stringify(stateRoot)}`)
  }
  const root = runtimeRoot(stateRoot)
  return resolveWithin(root, path.join(root, 'agent-entry.js'), 'agent entry')
}

/** The line that proves this file is the entry and not an empty placeholder that parses. */
const ENTRY_SENTINEL = 'export function resolveUpdaterCli'

/**
 * Put the entry in place and prove it landed.
 *
 * `readSource`/`writeFile` are injectable so a test can hand it a truncated file and a volume whose
 * `chmod` lies — the two refusals this function exists to make.
 */
export function ensureAgentEntry({
  stateRoot,
  readSource = (p) => fs.readFileSync(p, 'utf8'),
  sourcePath = ENTRY_SOURCE,
  writeFile = (p, text) => writePrivateFile(p, text),
  now = () => new Date().toISOString(),
} = {}) {
  const target = agentEntryPath(stateRoot)
  let text
  try {
    text = readSource(sourcePath)
  } catch (error) {
    return {
      ok: false,
      code: CODES.stateWriteUnverified,
      path: target,
      message: `the update agent's entry script could not be read from ${sourcePath} (${error?.message ?? String(error)}): nothing was registered, because the job would have had nothing to run`,
      at: now(),
    }
  }
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, code: CODES.stateWriteUnverified, path: target, message: `${sourcePath} is empty, so it cannot be installed as the agent's entry point`, at: now() }
  }
  if (!text.includes(ENTRY_SENTINEL)) {
    return {
      ok: false,
      code: CODES.stateWriteUnverified,
      path: target,
      message: `${sourcePath} does not look like the agent entry (no ${ENTRY_SENTINEL} in it), so it was not installed in its place`,
      at: now(),
    }
  }

  ensurePrivateDir(path.dirname(target))
  let already = null
  try {
    already = fs.readFileSync(target, 'utf8')
  } catch {
    already = null
  }
  let landed = already === text
  if (!landed) {
    try {
      writeFile(target, text)
    } catch (error) {
      return { ok: false, code: CODES.stateWriteUnverified, path: target, message: `writing the agent entry to ${target} failed (${error?.message ?? String(error)})`, at: now() }
    }
  }
  let back = null
  try {
    back = fs.readFileSync(target, 'utf8')
  } catch (error) {
    return { ok: false, code: CODES.stateWriteUnverified, path: target, message: `${target} could not be read back after writing (${error?.message ?? String(error)})`, at: now() }
  }
  if (back !== text) {
    return refuse({
      target,
      code: CODES.stateWriteUnverified,
      reason: `${target} read back ${back.length} bytes after writing ${text.length}: the file the daily job would execute is not the entry this run installed`,
      // Half an entry is worse than none. It still parses as ESM, and the launchd definition already
      // names this path — so tomorrow's run executes whatever the truncation left. An existence check
      // cannot see this, which is exactly why the comparison above exists.
      remove: true,
      now,
    })
  }
  const mode = modeOf(target)
  if (mode !== 0o600) {
    return refuse({
      target,
      code: CODES.stateWriteUnverified,
      reason: `${target} landed at ${(mode ?? 0).toString(8)} instead of 600${mode === null ? ' (the mode could not be read at all)' : ''}`,
      // A world-writable entry is an open invitation: whoever writes it decides what the schedule runs.
      // Leaving it in place while reporting a refusal would be the one outcome this check must not ship.
      remove: true,
      now,
    })
  }
  return { ok: true, code: null, path: target, message: null, reused: landed, bytes: Buffer.byteLength(text, 'utf8'), mode, at: now() }
}

/**
 * A refusal that also puts the file away, and says whether it could.
 *
 * The caller treats `ok: false` as "do not name this entry in a plist", and falls back to registering the
 * versioned script — so removing the unverified file cannot orphan the job. What it prevents is the other
 * shape: a refused file still sitting at the path a *previous* registration named.
 */
function refuse({ target, code, reason, remove, now }) {
  let removed = true
  let failure = null
  if (remove) {
    try {
      fs.rmSync(target, { force: true })
    } catch (error) {
      removed = false
      failure = error?.message ?? String(error)
    }
  }
  return {
    ok: false,
    code,
    path: target,
    message: `${reason}${remove ? (removed
      ? ', so it was removed — the daily job will report a named missing file instead of running a half-written or world-writable one'
      : `, and removing it failed too (${failure}): re-run the GlassPane installer, and until then this machine's agent must not be trusted`)
      : ''}`,
    at: now(),
  }
}

/** Does the entry that is installed *right now* still match the copy this code would ship? */
export function agentEntryIsCurrent({ stateRoot, readSource = (p) => fs.readFileSync(p, 'utf8'), sourcePath = ENTRY_SOURCE, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const target = agentEntryPath(stateRoot)
  try {
    return readFile(target) === readSource(sourcePath)
  } catch {
    return false
  }
}
