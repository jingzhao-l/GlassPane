/**
 * Spec §1 gate 2 + §2: given a newest offer and the machine's state, what is
 * allowed to happen *without a human*?
 *
 * A major bump never auto-applies. This repository's major numbers mark a
 * change to outward contracts (see CHANGELOG 1.1.0 / 1.3.0), so swapping one in
 * under a running agent session is exactly the kind of surprise the version
 * line exists to prevent. Minors and patches are the only automatic swaps.
 *
 * `needs-consent` is a *refusal with a reason*, not a failure: the panel keeps
 * the install button live, the agent does not.
 */
import { bumpKind, compareVersions, parseTag } from './version.js'
import { CODES } from './codes.js'

/**
 * Consent gates a human can name with `--consent <kind>`.
 *
 * The third one is different in kind from the other two: `major` and `state-dir`
 * are judgements this tool can make for itself, while `unsigned-release` is
 * "the proof that would have answered this question was not published". Granting
 * it never overrules a *bad* signature — see `lib/check.js` gate 8 — it accepts a
 * missing one, and the state file keeps saying that it did.
 */
export const CONSENT_KINDS = Object.freeze(['major', 'state-dir', 'unsigned-release'])

/**
 * Decide what `check` should record for a candidate release.
 *
 * `currentVersion` — plain `x.y.z` read back locally.
 * `tag` — the release tag as offered.
 * `opts.autoApply` — the user's switch (§5).
 */
export function decideUpdate({ currentVersion, tag, autoApply = true, consents = [] }) {
  const candidate = parseTag(tag)
  const current = { version: currentVersion }
  const kind = bumpKind(candidate, normalise(current))
  if (kind === 'none') {
    return { status: 'up-to-date', code: null, candidate: candidate.version, kind, autoApplyAllowed: false, reason: null }
  }
  if (kind === 'downgrade') {
    return {
      status: 'up-to-date',
      code: null,
      candidate: candidate.version,
      kind,
      autoApplyAllowed: false,
      reason: `the newest published release (${candidate.version}) is older than what this machine runs (${currentVersion}); nothing to do`,
    }
  }
  const hasConsent = consents.includes(kind)
  if (kind === 'major' && !hasConsent) {
    return {
      status: 'needs-consent',
      code: CODES.consentRequired,
      candidate: candidate.version,
      kind,
      autoApplyAllowed: false,
      consent: 'major',
      reason: `version ${candidate.version} is a major upgrade from ${currentVersion}: contract changes need a person, so press "Install update" when you want it`,
    }
  }
  if (!autoApply) {
    return {
      status: 'available',
      code: null,
      candidate: candidate.version,
      kind,
      autoApplyAllowed: false,
      reason: 'automatic update is switched off; installing stays available from the panel',
    }
  }
  return { status: 'available', code: null, candidate: candidate.version, kind, autoApplyAllowed: true, reason: null }
}

function normalise(ref) {
  const [major, minor, patch] = String(ref.version).split('.').map(Number)
  return { major, minor, patch, version: ref.version }
}

/**
 * §2: is a swap allowed right now? Only an *answered* probe means idle.
 * Returns a decision object; `deferred` when the daemon did not answer.
 */
export function decideSwapPermission({ probe, jobArgs, ourStateRoot, consented = [] }) {
  if (!probe?.answered) {
    return {
      status: 'deferred',
      code: CODES.busyOrUnreachable,
      reason: probe?.reason ?? 'the daemon did not answer the idle probe',
      swapped: false,
    }
  }
  // §2 的门问的是"这个 daemon 在写哪个状态根"，所以它的输入必须是**全部读数**：只取第一个
  // 旗标时，`[--state-dir 我们的, --state-dir /other]` 会被判成"是我们的根"并放行，换掉的
  // 正是别家 daemon 正在用的 bundle（真机形态见 lib/launchd.js 的 `launchctl print` 解析，
  // 那里早已按 `stateDirReadings` 判 unknown——两道门口径必须一致）。
  const readings = stateDirReadings(jobArgs)
  if (readings.length > 1) {
    return {
      status: 'unknown',
      code: CODES.busyOrUnreachable,
      reason: `the running job names the state-root flag more than once (${readings.map((value) => String(value)).join(', ')}), so which state root its daemon writes to is not decidable and this tool will not swap on a guess. Nothing was replaced: read the job back with \`launchctl print gui/$(id -u)/com.glasspane.daemon\`, put its arguments list down to one state root — then re-run "updater apply" against that root.`,
      swapped: false,
    }
  }
  const foreign = foreignStateDir({ jobArgs, ourStateRoot })
  if (foreign && !consented.includes('state-dir')) {
    return {
      status: 'needs-consent',
      code: CODES.nonDefaultStateDir,
      // 拒绝必须带一个可执行的下一步（对照 lib/signature.js 的 `--consent unsigned-release`
      // 与 cli.js 里 wired 的 `--consent state-dir`）：光说"do it by hand"的拒绝，agent 无从操作。
      reason: `the running daemon writes to ${foreign}, which is not the state root this tool was asked to update (${ourStateRoot}). A swap here would replace bundles that somebody else's daemon is using. A person who has checked which install they mean may run "updater apply --state-dir ${ourStateRoot} --consent state-dir" (the panel's "Install update" button does the same thing); an automatic run never carries that flag.`,
      swapped: false,
    }
  }
  return { status: 'allowed', code: null, reason: null, swapped: true, foreignStateDir: foreign }
}

/** The `--state-dir` a running job names when it differs from ours. */
export function foreignStateDir({ jobArgs, ourStateRoot }) {
  const readings = stateDirReadings(jobArgs)
  // 0 个读数＝作业没写旗标，1 个＝唯一答案；多于 1 个是歧义，由 `decideSwapPermission` 判
  // `unknown`，这里不替它猜一个值。
  if (readings.length !== 1) return null
  const named = readings[0]
  if (!named) return null
  const a = stripTrailing(String(named))
  const b = stripTrailing(String(ourStateRoot))
  return a === b ? null : a
}

/**
 * The two spellings one flag has in this project. `updater/cli.js` accepts both, the daemon's own
 * option is `--state-root`, and `renderAgentPlist` puts `--state-root` into the job it registers — so
 * a reader that only knows `--state-dir` is blind to the state root of a job this tool rendered
 * itself. That is not a cosmetic gap: §2's foreign-root gate answers "which state root does the
 * running daemon write to", and reading only one spelling means a daemon started with
 * `--state-root /some/other/place` reports "no flag" and is waved through as ours.
 */
export const STATE_ROOT_FLAGS = Object.freeze(['--state-dir', '--state-root'])

/** Pull `--state-dir <path>` / `--state-root=<path>` out of an argv list. */
export function stateDirFromArgs(args) {
  const list = Array.isArray(args) ? args : []
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i])
    const exact = STATE_ROOT_FLAGS.find((flag) => token === flag)
    if (exact) {
      const value = list[i + 1]
      if (typeof value === 'string' && !value.startsWith('-')) return value
      return null
    }
    const inline = STATE_ROOT_FLAGS.find((flag) => token.startsWith(`${flag}=`))
    if (inline) return token.slice(inline.length + 1)
  }
  return null
}

/**
 * Every `--state-dir` an argv list names, in order. §2's foreign-root gate is
 * made of one value, so a job that names the flag twice is not a job this tool
 * can reason about: `launchctl print` output whose first block was cut short by
 * an embedded `}` used to hide exactly that second flag, and reading only the
 * first value then meant "default root, go ahead". Callers that need a verdict
 * must treat more than one distinct reading as "unknown".
 */
export function stateDirReadings(args) {
  const list = Array.isArray(args) ? args : []
  const found = []
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i])
    const exact = STATE_ROOT_FLAGS.find((flag) => token === flag)
    if (exact) {
      const value = list[i + 1]
      found.push(typeof value === 'string' && !value.startsWith('-') ? value : null)
      continue
    }
    const inline = STATE_ROOT_FLAGS.find((flag) => token.startsWith(`${flag}=`))
    if (inline) found.push(token.slice(inline.length + 1))
  }
  return [...new Set(found)]
}

function stripTrailing(value) {
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

export { compareVersions }
