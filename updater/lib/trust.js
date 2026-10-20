/**
 * trust.js — the signing anchor, kept out of the payload it authenticates.
 *
 * WHY. `PINNED_PRIMARY_FINGERPRINT` (lib/signature.js) and the armored key
 * (`installer/cli.js`) are the two values that decide whether a release's
 * `SHA256SUMS-<ver>.txt.asc` is read as `verified` or as `invalid`. Both ship
 * *inside* the release: `runtime.js` copies `updater/`, `installer/` and
 * `package.json` into the installed tree, and `apply` promotes a staged tree
 * wholesale. So one release waved through with `--consent unsigned-release` replaces
 * the verifier along with the verified — every later release signed by whoever wrote
 * that tree then verifies green against their own pin, and the standing warning in
 * `authorshipNote` disappears on its own. The pin can only anchor anything while it
 * lives somewhere the release cannot write.
 *
 * WHAT. `<stateRoot>/trust.json`, 0600, written by the code that is **already running**
 * — never from staged bytes. Before `apply` builds, packs or swaps anything, the staged
 * tree's own pinned fingerprint is read and compared: a difference is refused as
 * `signature-anchor-changed`, and the only way past it is a person editing that one
 * field, which is what makes a key rotation a decision instead of something a release
 * does to you.
 *
 * LIMITS, said plainly. First-run trust-on-first-use: a machine with no anchor records
 * the pin of whatever it applies first, so the anchor protects every release *after*
 * the wave-through it exists to catch. Pinning at install time is not wired because the
 * published `glasspane-install` package ships no `updater/` code to read — an installer
 * that imported `updater/lib/trust.js` would be a delivered shape the tests never run,
 * which is the bug class this repo already lost 19 versions to.
 */
import fs from 'node:fs'
import path from 'node:path'

import { normalizePinnedFingerprint } from './signature.js'

export const TRUST_FILE_NAME = 'trust.json'
/** Where a staged release tree keeps the fingerprint that decides `verified`. */
export const PIN_SOURCE = 'updater/lib/signature.js'

export function trustFilePath(stateRoot) {
  return path.join(stateRoot, TRUST_FILE_NAME)
}

/**
 * Read the pinned fingerprint a *tree* declares. Deliberately a textual read of the one
 * line: importing staged JavaScript to ask it what it pins would execute the attacker's
 * module to obtain the value used to judge them.
 */
export function releaseSigningFingerprint(treeRoot) {
  const file = path.join(treeRoot, PIN_SOURCE)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, fingerprint: null, reason: `${file} could not be read (${error?.message ?? String(error)}), so the release's own pinned fingerprint is unknown` }
  }
  const match = text.match(/PINNED_PRIMARY_FINGERPRINT\s*=\s*['"]([0-9A-Fa-f]{40})['"]/)
  if (!match) {
    return { ok: false, fingerprint: null, reason: `${file} no longer declares PINNED_PRIMARY_FINGERPRINT on one line, so there is no anchor value to compare this release against` }
  }
  const fingerprint = normalizePinnedFingerprint(match[1])
  if (fingerprint === null) {
    return { ok: false, fingerprint: null, reason: `${file} declares a pinned value that is not a 40-hex-digit fingerprint: ${match[1]}` }
  }
  return { ok: true, fingerprint }
}

/**
 * The recorded anchor. `absent` (nothing to compare against yet) and `unreadable`
 * (something is there but cannot be trusted) are different states and neither may be
 * folded into "matched".
 */
export function readAnchor(stateRoot) {
  const file = trustFilePath(stateRoot)
  if (!fs.existsSync(file)) return { state: 'absent', file, fingerprint: null }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return { state: 'unreadable', file, fingerprint: null, reason: `${file} exists but is not readable JSON (${error?.message ?? String(error)}); the anchor is unknown, which is not the same as agreeing with it` }
  }
  const fingerprint = normalizePinnedFingerprint(parsed?.anchorFingerprint)
  if (fingerprint === null) {
    return { state: 'unreadable', file, fingerprint: null, reason: `${file} carries no 40-hex-digit anchorFingerprint field, so the anchor cannot be read from it` }
  }
  return { state: 'present', file, fingerprint, writtenAt: parsed?.writtenAt ?? null }
}

/**
 * The whole question `apply` asks, as one function over two real directories: read this
 * machine's anchor, read the staged tree's own declaration, compare. Kept together so the
 * wiring cannot drift from the judgment — a caller that forgot to compare would have to call
 * a different function, and `apply.js` calls only this one.
 */
export function judgeStagedAnchor({ stateRoot, treeRoot }) {
  const anchor = readAnchor(stateRoot)
  const staged = releaseSigningFingerprint(treeRoot)
  const judgment = judgeAnchor({ anchor, stagedFingerprint: staged.ok ? staged.fingerprint : null })
  return { ...judgment, anchor, staged: staged.fingerprint ?? null, stagedRead: staged }
}

/** Write the anchor from the code that is running right now. 0600, create-exclusive. */
export function recordAnchor(stateRoot, fingerprint, { now = new Date(), force = false } = {}) {
  const normalized = normalizePinnedFingerprint(fingerprint)
  if (normalized === null) return { ok: false, reason: `refusing to record ${JSON.stringify(fingerprint)} as a signing anchor: not a 40-hex-digit fingerprint` }
  const file = trustFilePath(stateRoot)
  const body = `${JSON.stringify({ schemaVersion: 'glasspane.trust/0.1', anchorFingerprint: normalized, writtenAt: now.toISOString() }, null, 2)}\n`
  try {
    if (!force && fs.existsSync(file)) {
      const existing = readAnchor(stateRoot)
      if (existing.state === 'present' && existing.fingerprint === normalized) return { ok: true, unchanged: true, file }
      if (existing.state === 'present') return { ok: false, reason: `${file} already anchors ${existing.fingerprint}; this code would record ${normalized} — say which one is meant by editing that file, do not let a run overwrite it silently` }
      if (existing.state === 'unreadable') return { ok: false, reason: existing.reason }
    }
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, body, { mode: 0o600 })
    fs.renameSync(temp, file)
    fs.chmodSync(file, 0o600)
  } catch (error) {
    return { ok: false, reason: `${file} could not be written (${error?.message ?? String(error)}): the signing anchor did not land, so nothing here is protected by it` }
  }
  return { ok: true, file, fingerprint: normalized }
}

/**
 * The judgment, as a pure function so both answers are testable without a filesystem.
 * A missing anchor is *stated*, never treated as agreement; an unreadable one refuses,
 * because "cannot tell" and "matches" must not share an exit.
 */
export function judgeAnchor({ anchor, stagedFingerprint }) {
  if (anchor.state === 'unreadable') {
    return { ok: false, reason: anchor.reason ?? 'the recorded signing anchor could not be read' }
  }
  if (anchor.state === 'absent') {
    return { ok: true, establishing: true }
  }
  if (stagedFingerprint === null || stagedFingerprint === undefined) {
    return { ok: false, reason: 'the staged release does not declare a pinned fingerprint this tool can read, while this machine holds an anchor — authorship cannot be compared, so it is not asserted' }
  }
  if (stagedFingerprint.toUpperCase() !== anchor.fingerprint) {
    return {
      ok: false,
      reason: `the staged release pins ${stagedFingerprint.toUpperCase()} while ${anchor.file} anchors ${anchor.fingerprint} — a different signing key from the one this machine already trusts. Nothing was built, packed, swapped or restarted. If the key really was rotated, edit that one file's anchorFingerprint to ${stagedFingerprint.toUpperCase()} and re-run: a rotation has to be a decision somebody made here, not something a release made for this machine.`,
    }
  }
  return { ok: true, establishing: false }
}
