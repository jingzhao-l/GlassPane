/**
 * Stable vocabularies: the closed status enum, the failure codes, and the exit
 * codes. Panel, launchd agent and `gp_diagnose` read these values off one line
 * of JSON, so a rename here is a contract break, not a cleanup.
 *
 * `STATUS_*` mirrors spec §4: the enum is closed on purpose — a panel that has
 * to guess at an unknown status is a panel that shows the wrong button.
 */

export const SCHEMA_VERSION = 1

/** Closed `status` enum (spec §4). */
export const STATUSES = Object.freeze([
  'up-to-date',
  'available',
  'staged',
  'applied',
  'deferred',
  'needs-consent',
  'check-overdue',
  'rolled-back',
  'check-failed',
  'staged-build-failed',
  'apply-failed',
  'rollback-failed',
  'disabled',
  'installer-pointer-stale',
])

/**
 * Failure/reason codes written into `code` and `lastError.code`. Every one of
 * these is a refusal branch some test reaches; a code nothing can produce is
 * dead weight in the enum.
 */
export const CODES = Object.freeze({
  // Local environment: the identity this tool writes under.
  homeRecordUnavailable: 'home-record-unavailable',
  // §1 source and trust chain
  sourceInsecure: 'source-insecure',
  sourceShape: 'source-shape-invalid',
  releaseUnreachable: 'release-unreachable',
  releaseBadPayload: 'release-payload-invalid',
  checkFailed: 'check-failed',
  versionMismatchLocal: 'version-mismatch-local',
  tagUnparseable: 'tag-unparseable',
  assetsMissing: 'assets-missing',
  sumsAmbiguous: 'sums-ambiguous',
  digestMismatch: 'digest-mismatch',
  versionLineBroken: 'version-line-broken',
  ciUnverified: 'ci-unverified',
  ciNotGreen: 'ci-not-green',
  // §1 gate 8 (authorship): the detached GPG signature over this release's
  // SHA256SUMS file, checked against the key `installer/cli.js` ships.
  // `signature-invalid` is the one refusal no consent can wave through; the
  // other two name a *missing* proof, which a person may accept and a schedule
  // may not.
  signatureInvalid: 'signature-invalid',
  releaseUnsigned: 'release-unsigned',
  signatureToolMissing: 'signature-tool-missing',
  assetHostUnpinned: 'asset-host-unpinned',
  // A download that left the pinned host after a redirect (§1's host pinning is
  // about the bytes that land on disk, not only about the URL in the payload).
  downloadHostUnpinned: 'download-host-unpinned',
  // staging / archive
  archiveUnreadable: 'archive-unreadable',
  archiveEntryUnsafe: 'archive-entry-unsafe',
  archiveEntryUnsupported: 'archive-entry-unsupported',
  stagingEscape: 'path-outside-state-root',
  // §2 when a swap is allowed
  busyOrUnreachable: 'busy-or-unreachable',
  nonDefaultStateDir: 'non-default-state-dir',
  notStaged: 'not-staged',
  consentRequired: 'consent-required',
  autoDisabled: 'auto-disabled',
  // §3 apply / rollback
  backupFailed: 'backup-failed',
  stagedBuildFailed: 'staged-build-failed',
  swapFailed: 'swap-failed',
  handshakeFailed: 'handshake-failed',
  rolledBack: 'rolled-back',
  rollbackFailed: 'rollback-failed',
  npmVersionMismatch: 'npm-version-mismatch',
  // `apply` refused because the staged tree is not newer than what is installed
  // at apply time (§7: `apply` = put the *staged offer* in, not "any tree on disk").
  stagedNotNewer: 'staged-version-not-newer',
  // Anything that threw after the bundles were already swapped in: the answer is
  // 4 or 5, never 3, because the machine did change.
  postSwapFailed: 'post-swap-failed',
  // §11: the swap succeeded but the updater's own copy did not move. Not a refusal — the machine
  // *was* updated — so it never changes the exit code; it is a standing degradation the panel and
  // gp_diagnose have to keep saying until a person re-runs the installer or the next apply lands it.
  runtimeStale: 'runtime-stale',
  // §11: the code and the pointer moved, but the launchd job was not handed over during this run —
  // because a *scheduled* apply is itself that job, and `bootout` would take the job down mid-write.
  // The handover happens the next time a person (or the panel's switch) runs `enable`.
  runtimeRegistrationPending: 'runtime-registration-pending',
  // The scheduled agent's plist could not be rendered without a shell interpreting
  // a path it was handed (§2's "do not guess at another installation").
  agentPathUnsafe: 'agent-path-unsafe',
  // §4 pointer
  pointerMissing: 'installer-pointer-missing',
  pointerStale: 'installer-pointer-stale',
  pointerUnreadable: 'installer-pointer-unreadable',
  // writes
  stateWriteUnverified: 'state-write-unverified',
})

/** Exit codes (spec §7). The panel has nothing but this number and one line. */
export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  REFUSED: 3,
  ROLLED_BACK: 4,
  ROLLBACK_FAILED: 5,
})

/** Statuses that map to exit 3 (refused): nothing changed, a human may retry. */
export const REFUSED_STATUSES = Object.freeze([
  'deferred',
  'needs-consent',
  'check-failed',
  'installer-pointer-stale',
])

/**
 * Map a command outcome onto the §7 exit code.
 *
 * `rolled-back` means the swap happened and the handshake failed *but the
 * backup went back in* (4); `rollback-failed` means the machine is in an
 * unknown state and needs a person (5). Those two must never collapse into one
 * code: the panel's copy for 5 is "manual action required", shown verbatim.
 *
 * A failure that left the live bundles untouched (`staged-build-failed`) is 3,
 * not 5 — the distinction the panel cares about is "nothing of yours changed",
 * and that claim has to come from the outcome's own record rather than from
 * which word the status happens to use.
 */
export function exitCodeFor(outcome) {
  if (outcome?.usageError) return EXIT.USAGE
  const status = outcome?.status
  if (status === 'rolled-back') return EXIT.ROLLED_BACK
  if (status === 'rollback-failed') return EXIT.ROLLBACK_FAILED
  if (status === 'apply-failed' || status === 'staged-build-failed') {
    // The live bundles were already being replaced: only a *verified* restore
    // keeps this out of the "human needed" band.
    return outcome?.rollback?.ok === false ? EXIT.ROLLBACK_FAILED : EXIT.REFUSED
  }
  if (REFUSED_STATUSES.includes(status)) return EXIT.REFUSED
  if (typeof status === 'string' && STATUSES.includes(status)) return EXIT.OK
  return EXIT.USAGE
}

