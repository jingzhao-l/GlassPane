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
// `invocation.js` is the only thing here that touches shell text: every operand of a remedy command
// it prints goes through `quoteShellArg` (`lib/shell-quote.js`) inside the helper, so a remedy cannot
// quote some operands and leave the state root bare.
import { updaterCommand } from './invocation.js'

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
      // `up-to-date` here means only "no published release is newer to take". Say which of
      // the two readings applies, because the word alone also reads as "this machine is on
      // the published line" — and a host built from a tag whose Release never shipped is
      // exactly the case where the two differ (measured 2026-10-19/20 with 1.17.0 tagged,
      // published line at 1.16.4).
      reason: `the newest published release (${candidate.version}) is older than what this machine runs (${currentVersion}); nothing to do. `
        + `"up-to-date" here means no published release is newer — it does not say this machine is on the published line, and the two differ whenever a tag was cut without shipping its Release.`,
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
      // 拒绝必须给出一条能跑的口令（本文件 :112-113 立的规矩）：面板那条路保留，但只说面板的
      // 拒绝对一个在终端前头的 agent 没有下一步，而另外两道门（`state-dir` 见下、
      // `unsigned-release` 见 lib/signature.js）都已经带着 `--consent <kind>`。
      // 那两条口令从前写的是裸的 `updater check` / `updater apply`：这台机器上没有一个叫
      // `updater` 的可执行文件（`updater/package.json` 没有 bin 字段，npm 只发布
      // glasspane-mcp 与 glasspane-install），照抄得到 127。口令现在由 `invocation.js` 的
      // `updaterCommand(...)` 生成，带着这一包 cli.js 的真路径。
      reason: `version ${candidate.version} is a major upgrade from ${currentVersion}: contract changes need a person, so press "Install update" when you want it. `
        + `A person who has decided they want this major may run \`${updaterCommand('check', '--consent', 'major')}\` to stage it and `
        + `\`${updaterCommand('apply', '--consent', 'major')}\` to swap it in; `
        + 'an automatic run never carries that flag.',
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
      // finding C7 (2026-10-24): a probe that carries its own reason keeps it (that is
      // where the measured fact and the next steps live). This fallback is the shape a
      // caller's stub or an older `lib/idle.js` hands back, and it used to be a bare
      // diagnosis-free sentence — while the other three gates each name a command.
      // The swap stays refused here, so this is the only place that sentence is ever read.
      reason: probe?.reason
        ?? 'the daemon did not answer the idle probe, so this run has no evidence it is safe to restart it: nothing was swapped, built, packed or restarted. '
          + 'This measures only "no reply before the deadline" — a queued act, a wedged daemon and a different service owning the socket all look identical from here. '
          + `Next: \`launchctl print gui/$(id -u)/com.glasspane.daemon\` to see whether launchd holds the job at all, \`${updaterCommand('status', '--json')}\` for what the last recorded run saw `
          + `(no network), and \`node installer/cli.js --restore-launchd\` if the daemon answers nothing — then re-run \`${updaterCommand('apply')}\`.`,
      swapped: false,
    }
  }
  // §2 的门问的是"这个 daemon 在写哪个状态根"，所以它的输入必须是**全部读数**：只取第一个
  // 旗标时，`[--state-dir 我们的, --state-dir /other]` 会被判成"是我们的根"并放行，换掉的
  // 正是别家 daemon 正在用的 bundle（真机形态见 lib/launchd.js 的 `launchctl print` 解析，
  // 那里早已按 `stateDirReadings` 判 unknown——两道门口径必须一致）。
  const readings = stateDirReadings(jobArgs)
  // `null` / `''` here is not "no flag": it is *this* flag, present, with a value this reader could
  // not decode (argv ending in `--state-dir`, a value that begins with `-`, `--state-root=` with
  // nothing after the `=`). Reading it as "no flag" is what let the gate answer `allowed` for a job
  // whose state root it had just failed to read — the same "unknown is not fine" rule the
  // multi-value case below already applies, extended to the value that cannot be decoded.
  const undecodable = readings.filter((value) => value === null || value === '')
  if (readings.length > 1 || undecodable.length > 0) {
    const ambiguous = readings.length > 1
    return {
      status: 'unknown',
      code: CODES.busyOrUnreachable,
      reason: ambiguous
        ? `the running job names the state-root flag more than once (${readings.map((value) => String(value)).join(', ')}), so which state root its daemon writes to is not decidable and this tool will not swap on a guess. Nothing was replaced: read the job back with \`launchctl print gui/$(id -u)/com.glasspane.daemon\`, put its arguments list down to one state root — then re-run \`${updaterCommand('apply')}\` against that root.`
        : `the running job names the state-root flag, but its value cannot be read (${readings.map((value) => String(value)).join(', ')} — a flag at the end of the argument list, a value beginning with "-", or nothing after the "="), so which state root its daemon writes to is not decidable and this tool will not swap on a guess. Nothing was replaced: read the job back with \`launchctl print gui/$(id -u)/com.glasspane.daemon\`, put its arguments list down to one readable state root — then re-run \`${updaterCommand('apply')}\` against that root.`,
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
      // 这句从前还补了一句"面板上「安装更新」按钮干的是同一件事"——那是假的：`non-default-state-dir`
      // 不在 UpdatePanelLogic 的 consentGate 表里，落到 `.none` 那一档，而那一档写死
      // `applyEnabled: false`（UpdatePanelTests 钉着）。把人说往一个按不动的按钮，比不说更糟。
      // `ourStateRoot` 走 `quoteShellArg`（经 `invocation.js` 的 `updaterCommand`，它对每一个参数位
      // 都套这条规则）：这句是被面板/agent 原样转发的 remedy，而状态根是从
      // `--state-dir` / `GLASSPANE_STATE_DIR` / 面板透传（UpdateModel.swift 直接传 daemon 报的根）
      // 来的**不受信字节**；从前写的是双引号形态，而 `$()` 与反引号在双引号里照样展开。
      // 命令名从前写的是裸的 `updater`——这台机器上没有那个可执行文件，照抄得 127；面板那一侧
      // 早就换成 `node <绝对路径>`（UpdatePanelLogic.swift:482、:510），这一半跟着改。
      reason: `the running daemon writes to ${foreign}, which is not the state root this tool was asked to update (${ourStateRoot}). A swap here would replace bundles that somebody else's daemon is using. A person who has checked which install they mean may run \`${updaterCommand('apply', '--state-dir', ourStateRoot, '--consent', 'state-dir')}\` — every operand single-quoted by this tool's own rule (see lib/shell-quote.js, applied by lib/invocation.js: double quotes would not do, a command substitution still runs inside them), because a home or state root may contain a space, a non-ASCII name, or a shell metacharacter, and an unquoted copy of it would act on a truncated path; an automatic run never carries that flag.`,
      swapped: false,
    }
  }
  return { status: 'allowed', code: null, reason: null, swapped: true, foreignStateDir: foreign }
}

/** The `--state-dir` a running job names when it differs from ours. */
export function foreignStateDir({ jobArgs, ourStateRoot }) {
  const readings = stateDirReadings(jobArgs)
  // 0 个读数＝作业没写旗标，1 个**读得出来**的＝唯一答案；多于 1 个是歧义、1 个读不出也是歧义，
  // 两种都由 `decideSwapPermission` 判 `unknown`，这里不替它猜一个值。
  if (readings.length !== 1) return null
  const named = readings[0]
  if (named === null || named === '') return null
  const a = stripTrailing(String(named))
  const b = stripTrailing(String(ourStateRoot))
  return a === b ? null : a
}

/**
 * The two spellings one flag has in this project. `updater/cli.js` accepts both, and
 * `renderAgentPlist`'s `daemonFlag` default puts `--state-root` into the job it registers
 * (`lib/launchd.js`) — so a reader that only knows `--state-dir` is blind to the state root of a
 * job this tool rendered itself. That is not a cosmetic gap: §2's foreign-root gate answers "which
 * state root does the running daemon write to", and reading only one spelling means a daemon started
 * with `--state-root /some/other/place` reports "no flag" and is waved through as ours.
 *
 * The sentence this comment used to carry — "the daemon's own option is `--state-root`" — was
 * measured false: `engine/Sources/glasspaned/main.swift` parses `--state-dir`. Both spellings are
 * read here because **the job this tool renders** is the one that carries `--state-root`, not the
 * daemon's own CLI; the daemon reads `--state-dir` and `--state-root` only ever appears in argv this
 * repository wrote into a plist.
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
