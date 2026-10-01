/**
 * The updater's on-disk state: `<stateRoot>/update-state.json`, the installer
 * pointer `<stateRoot>/update-install.json`, and the two judgements the panel
 * and `gp_diagnose` make from them — "is this stale?" and "what is the effective
 * status right now?".
 *
 * Every write goes through `saveState`: schema-validated, temp file + rename,
 * mode tightened to `0600` and *re-read*, and finally re-parsed from disk. A
 * write that cannot be read back exactly as written is reported as a failed
 * write, because the panel decides which buttons are live from this file.
 */
import fs from 'node:fs'
import path from 'node:path'

import { CODES, SCHEMA_VERSION, STATUSES } from './codes.js'
import { UpdaterError, ensurePrivateDir, modeOf, writePrivateFile, STATE_FILE_NAME, POINTER_FILE_NAME, canonicalPath, writableRoots } from './fsutil.js'
import { assertValidState, loadSchema } from './schema.js'

/** Spec §4: a check older than this is shown as overdue ("the fixed time hit while the machine was off"). */
export const OVERDUE_THRESHOLD_MS = 36 * 60 * 60 * 1000

/** History rows kept (spec §3.5: last 10). */
export const HISTORY_LIMIT = 10

/**
 * Statuses the overdue judgement may replace. A refusal or a rollback is not
 * "stale": it is the last real thing that happened, and hiding it behind
 * "check overdue" would hide the reason the button is disabled. An outstanding
 * offer (`available`, `staged`) stays too — the panel still has to show that a
 * specific version is waiting, and `summary.overdue` carries the nag.
 */
export const OVERDUE_REPLACEABLE_STATUSES = Object.freeze([
  'up-to-date',
  'applied',
  null,
  undefined,
])

const ACTIONS = ['check', 'apply', 'rollback', 'enable', 'disable', 'restore']

export function emptyState({ now = new Date(), autoApply = true, disabled = false } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    lastCheckAt: null,
    current: null,
    latest: null,
    status: 'up-to-date',
    code: null,
    staged: null,
    authorship: null,
    lastError: null,
    disabled,
    autoApply,
    history: [],
    updatedAt: iso(now),
  }
}

function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString()
}

function parseMs(value) {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * `now - lastCheckAt > 36 h`. A file with no check at all counts as overdue:
 * "never checked" is exactly the case the panel must nag about.
 */
export function isOverdue(state, now = Date.now(), thresholdMs = OVERDUE_THRESHOLD_MS) {
  if (state?.disabled === true) return false
  const last = parseMs(state?.lastCheckAt)
  if (last === null) return true
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  return nowMs - last > thresholdMs
}

/** Age of the last check in ms, or null when there never was one. */
export function checkAgeMs(state, now = Date.now()) {
  const last = parseMs(state?.lastCheckAt)
  if (last === null) return null
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  return nowMs - last
}

/**
 * The status a reader should act on: the stored one, upgraded to
 * `check-overdue` when the last check has gone stale (§4's answer to "the
 * machine was switched off at the scheduled time").
 */
export function effectiveStatus(state, now = Date.now()) {
  const stored = state?.status ?? null
  if (!OVERDUE_REPLACEABLE_STATUSES.includes(stored)) return stored
  if (state?.disabled === true) return 'disabled'
  return isOverdue(state, now) ? 'check-overdue' : (stored ?? 'check-overdue')
}

/** Short summary for `gp_diagnose`'s `update` field — the MCP seam (README). */
export function updateSummary(state, now = Date.now()) {
  return {
    current: state?.current ?? null,
    latest: state?.latest ?? null,
    status: effectiveStatus(state, now),
    storedStatus: state?.status ?? null,
    code: state?.code ?? null,
    lastCheckAt: state?.lastCheckAt ?? null,
    overdue: isOverdue(state, now),
    disabled: state?.disabled === true,
    autoApply: state?.autoApply === true,
    stagedVersion: state?.staged?.version ?? null,
    stagedDigest: state?.staged?.digest ?? null,
    // Gate 8 outlives the staged offer: after a successful swap `staged` is gone
    // and this is the only thing on disk still saying whether anybody proved who
    // published what is now installed. It has to be in the summary, because the
    // summary is what `gp_diagnose` and the panel quote.
    authorship: state?.authorship?.signature ?? null,
    authorshipVersion: state?.authorship?.version ?? null,
    authorshipConsented: state?.authorship?.consented === true,
    authorshipKey: state?.authorship?.keyFingerprint ?? null,
  }
}

/** Read the state file. Absent file is not an error: it means "never checked". */
export function loadState(stateRoot) {
  const { stateFile } = writableRoots(stateRoot)
  if (!fs.existsSync(stateFile)) {
    return { state: emptyState(), existed: false, mode: null }
  }
  let text
  try {
    text = fs.readFileSync(stateFile, 'utf8')
  } catch (error) {
    throw new UpdaterError(CODES.stateWriteUnverified, `update-state.json at ${stateFile} could not be read (${error.message})`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new UpdaterError(CODES.stateWriteUnverified, `update-state.json at ${stateFile} is not valid JSON (${error.message}); re-run the installer if this persists`)
  }
  // Reads are lenient about keys this version does not know, writes are not — see `assertValidState`.
  // The case this is for is §11's two-step handover: the scheduled run writes a newer document and the
  // job the book still names is the older updater, which has to go on answering rather than failing to
  // read its own state file.
  try {
    assertValidState(parsed, loadSchema(), { ignoreUnknownProperties: true })
  } catch (error) {
    throw new UpdaterError(CODES.stateWriteUnverified, `${error.message} — read from ${stateFile}: the file is not a state this version can act on, so nothing was reported from it`)
  }
  return { state: parsed, existed: true, mode: modeOf(stateFile) }
}

/**
 * Append one history row, newest last, capped at {@link HISTORY_LIMIT}.
 * `digest` is stored as the leading 12 hex characters (spec §3.5).
 */
export function pushHistory(state, entry) {
  const row = {
    at: entry.at,
    action: entry.action,
    result: entry.result,
    digest: entry.digest ?? null,
    code: entry.code ?? null,
  }
  if (!ACTIONS.includes(row.action)) {
    throw new UpdaterError(CODES.stateWriteUnverified, `history action ${row.action} is not one of ${ACTIONS.join(', ')}`)
  }
  if (typeof row.digest === 'string' && row.digest.length > 12) {
    row.digest = row.digest.slice(0, 12)
  }
  const history = [...(state.history ?? []), row]
  return { ...state, history: history.slice(-HISTORY_LIMIT) }
}

/**
 * Build the next state from an outcome. `patch` carries the fields the caller
 * measured; `null` for a field means "clear it".
 *
 * §4 makes `lastError` part of every refusal: the panel prints `lastError.message`
 * *verbatim* as the reason a button is disabled, so a stamped `code` with no
 * sentence behind it is a dead end for the person reading it. A caller that has
 * a sentence passes `message`; one that has nothing but the code still gets a
 * sentence that names the status.
 *
 * `historyEntry`, `error`, `message` and `details` are INSTRUCTIONS to this
 * function, not fields of the state, and any other key the shipped schema does
 * not declare is dropped for the same reason: the document closes with
 * `additionalProperties: false`, so spreading one of them into the merged state
 * yields something that can never be published — which is how 16 state/apply
 * tests reddened before this was fixed.
 * Reverse mutation: replace the `STATE_FIELDS` filter with a spread of the whole
 * patch — `a patch that carries the caller's sentence publishes it as lastError`
 * goes red on the schema's `property message is not allowed by the schema`.
 */
export function nextState(state, patch, { now = new Date() } = {}) {
  const source = patch ?? {}
  const { historyEntry, error, ...rest } = source
  const carried = {}
  for (const [key, value] of Object.entries(rest)) {
    if (STATE_FIELDS.has(key)) carried[key] = value
  }
  const merged = { ...state, ...carried, updatedAt: iso(now) }
  const sentence = typeof source.message === 'string' && source.message.trim() !== '' ? source.message.trim() : null
  const details = detailText(source.details ?? error?.details ?? null)
  if (error) {
    merged.code = error.code ?? merged.code ?? null
    merged.lastError = {
      code: error.code,
      message: typeof error.message === 'string' && error.message.trim() !== '' ? error.message.trim() : refusalSentence(merged.status, error.code),
      at: iso(now),
      details: detailText(error.details ?? null) ?? details ?? null,
    }
  } else if ('code' in source) {
    merged.code = source.code ?? null
    if (merged.code === null) {
      // A clean outcome clears the standing error: the panel must not keep
      // showing last week's refusal next to an "up to date" row.
      merged.lastError = null
    } else {
      merged.lastError = {
        code: merged.code,
        message: sentence ?? refusalSentence(merged.status, merged.code),
        at: iso(now),
        details: details ?? null,
      }
    }
  } else if (sentence && merged.code !== null && merged.code !== undefined) {
    // A patch that only refines the wording of the standing refusal.
    merged.lastError = { code: merged.code, message: sentence, at: iso(now), details: details ?? null }
  }
  if (historyEntry) {
    return pushHistory({ ...merged, history: state.history ?? [] }, { at: iso(now), ...historyEntry })
  }
  return merged
}

/** Field names the document may carry, read off the schema this package ships. */
const STATE_FIELDS = new Set(Object.keys(loadSchema().properties ?? {}))

/** §4: a refusal always has a sentence a person can act on, even from a code. */
function refusalSentence(status, code) {
  const stopped = typeof status === 'string' ? `the update stopped as "${status}"` : 'the update was refused'
  return `${stopped} (${code ?? 'no code'}): run "updater status" to read the reason, and press "Install update" in the GlassPane panel to try again`
}

/** `lastError.details` is `string | null` in the schema; structure is flattened. */
function detailText(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value === '' ? null : value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Validate + publish. Returns `{ state, mode }` with the mode read off disk. */
export function saveState(stateRoot, state, { now = new Date() } = {}) {
  const { stateFile } = writableRoots(stateRoot)
  const withStamp = { ...state, updatedAt: state.updatedAt ?? iso(now) }
  assertValidState(withStamp)
  ensurePrivateDir(path.dirname(stateFile))
  writePrivateFile(stateFile, JSON.stringify(withStamp, null, 2) + '\n')
  const roundTrip = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assertValidState(roundTrip)
  const mode = modeOf(stateFile)
  if (mode !== 0o600) {
    throw new UpdaterError(CODES.stateWriteUnverified, `update-state.json landed at ${(mode ?? 0).toString(8)} instead of 600`)
  }
  if (JSON.stringify(roundTrip) !== JSON.stringify(withStamp)) {
    throw new UpdaterError(CODES.stateWriteUnverified, 'update-state.json read back different bytes than were written')
  }
  return { state: withStamp, mode, path: stateFile }
}

/* ------------------------------------------------------------------ pointer */

/**
 * `<stateRoot>/update-install.json`, written by the installer and read here:
 * `{ updaterCli, installRoot, agentLabel, registeredAt }`.
 */
export function readPointer(stateRoot) {
  const { pointerFile } = writableRoots(stateRoot)
  if (!fs.existsSync(pointerFile)) {
    return { ok: false, code: CODES.pointerMissing, pointer: null, message: `no installer pointer at ${pointerFile}: run the GlassPane installer again` }
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(pointerFile, 'utf8'))
  } catch (error) {
    return { ok: false, code: CODES.pointerUnreadable, pointer: null, message: `installer pointer ${pointerFile} could not be parsed (${error.message}): run the GlassPane installer again` }
  }
  const cli = typeof parsed?.updaterCli === 'string' ? parsed.updaterCli : null
  if (!cli) {
    return { ok: false, code: CODES.pointerUnreadable, pointer: parsed, message: `installer pointer ${pointerFile} names no updaterCli: run the GlassPane installer again` }
  }
  if (!fs.existsSync(cli)) {
    return {
      ok: false,
      code: CODES.pointerStale,
      pointer: parsed,
      message: `the installer points at ${cli}, which is not on disk: reinstall GlassPane before updating`,
    }
  }
  return { ok: true, code: null, pointer: { ...parsed, updaterCli: canonicalPath(cli) }, message: null }
}

/** Publish a pointer the same way as the state file (installer seam, see README). */
export function writePointer(stateRoot, pointer, { now = new Date() } = {}) {
  const { pointerFile } = writableRoots(stateRoot)
  const body = {
    updaterCli: pointer.updaterCli,
    installRoot: pointer.installRoot,
    agentLabel: pointer.agentLabel,
    registeredAt: pointer.registeredAt ?? iso(now),
  }
  const unknown = Object.keys(pointer).filter((k) => !(k in body))
  if (unknown.length > 0) {
    throw new UpdaterError(CODES.stateWriteUnverified, `unknown pointer fields refused: ${unknown.join(', ')}`)
  }
  writePrivateFile(pointerFile, JSON.stringify(body, null, 2) + '\n')
  const mode = modeOf(pointerFile)
  if (mode !== 0o600) {
    throw new UpdaterError(CODES.stateWriteUnverified, `update-install.json landed at ${(mode ?? 0).toString(8)} instead of 600`)
  }
  return { pointer: body, path: pointerFile, mode }
}

export const STATE_STATUS_VALUES = STATUSES
