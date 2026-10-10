/**
 * launchd surface: the plist template this package ships, the agent
 * registration, and — the part §2 makes load-bearing — reading back the
 * arguments of **the job that is actually running**.
 *
 * Why the read-back exists: a daemon started with a non-default `--state-dir`
 * writes somebody else's state root. Swapping its bundles under us is not an
 * update of "this machine", it is an unrequested change to a second
 * installation, so the tool refuses and hands it to a person. Guessing the
 * arguments from a plist on disk is not enough — the loaded job may have been
 * bootstrapped from an older plist, which is the same trap round 9/10 of this
 * repo already fell into for the registry notification. Hence `launchctl print`.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { CODES } from './codes.js'
import { CA_ENV_VAR } from './ca-bundle.js'
import { UpdaterError, STATE_FILE_MODE, sameRuntimePath, writePrivateFile } from './fsutil.js'
import { stateDirReadings } from './policy.js'

export const AGENT_LABEL = 'com.glasspane.update'
export const DAEMON_JOB_LABEL = 'com.glasspane.daemon'
export const AGENT_PLIST_NAME = `${AGENT_LABEL}.plist`
/// The daily job's own log, named once. launchd creates it at the process umask,
/// so the daemon's startup sweep (`StateRoot.updateLogFile`) has to know this
/// exact name — `installer/test/log-modes.test.mjs` is the drift gate between them.
export const AGENT_LOG_NAME = 'update.log'
export const DEFAULT_HOUR = 12
export const DEFAULT_MINUTE = 0

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const AGENT_TEMPLATE = path.join(HERE, '..', 'launchd', AGENT_PLIST_NAME)

/**
 * Extract the `arguments` block from `launchctl print gui/<uid>/<label>` output.
 * Handles both brace and paren forms, quoted and bare tokens; returns null when
 * the block is absent *or when it cannot be decoded*, which callers must treat as
 * "unknown", never as "no arguments" and never as "the arguments I happened to
 * read".
 *
 * The line-oriented rule is the security property: a block ends at a line whose
 * only content is the closing delimiter. The previous version cut the body at the
 * first `}` anywhere, so a daemon argument like `--note=}` ended the block early
 * and every argument after it — including a second `--state-dir` pointing at
 * somebody else's installation — became invisible to the §2 gate that exists to
 * notice it.
 */
export function parseArgumentsBlock(printOutput) {
  const text = String(printOutput ?? '')
  const start = /(?:^|\n)\s*arguments\s*=\s*[{(]/.exec(text)
  if (!start) return { ok: false, args: null, reason: 'the printed job lists no arguments block' }
  const open = text[start.index + start[0].length - 1]
  const close = open === '{' ? '}' : ')'
  const lines = text.slice(start.index + start[0].length).split('\n')
  const args = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '') continue
    if (line === close) return { ok: true, args, reason: null }
    const quoted = /^"([\s\S]*)"$/.exec(line)
    if (quoted) {
      const inner = quoted[1]
      if (inner.includes('"')) {
        return { ok: false, args: null, reason: `argument line ${i + 1} carries a quote launchctl did not escape (${JSON.stringify(line)})` }
      }
      args.push(inner)
      continue
    }
    // A line that *opens* a quote without closing it is not malformed — it is a bare token that
    // happens to start with one. Measured on this machine (2026-09-30, `launchctl print
    // gui/501/com.glasspane.update` with the agent registered for real): launchd prints one argument
    // per line, raw, with no quoting and no escaping, and this project's own update agent carries the
    // literal `/bin/sh -c '"$0" "$1" check "$2" "$3" --json && …'`. That line begins with a `"` and
    // contains more of them, so refusing it made the one job this subsystem registers for itself
    // permanently unreadable: §11's read-back could never confirm a self-update, and a registration
    // could never be verified.
    //
    // What is actually dangerous is a token carrying the block's own delimiter, because that is what
    // an embedded `}` used to exploit by ending the list early. That test is kept, below, and it is
    // the only one that has to be: with one line per argument, no amount of quote characters can hide
    // a later `--state-dir`.
    if (line.startsWith('"') && (line.includes(close) || line.includes(open))) {
      return { ok: false, args: null, reason: `argument line ${i + 1} opens a quote and carries an unquoted ${JSON.stringify(close)} (${JSON.stringify(line)}), so the argument list cannot be decoded` }
    }
    // A bare (unquoted) token carrying the block's own delimiters is where the
    // format stops being describable: `--note=}` cannot be told apart from the
    // end of the block by a reader that is not launchctl.
    if (line.includes(close) || line.includes(open)) {
      return { ok: false, args: null, reason: `argument line ${i + 1} carries an unquoted ${JSON.stringify(close)} (${JSON.stringify(line)}), so the argument list cannot be decoded` }
    }
    args.push((/^(.*?),$/.exec(line)?.[1] ?? line).trim())
  }
  return { ok: false, args: null, reason: `the arguments block never closes with a lone ${close} on its own line, so it was not read completely` }
}

/** The argv list, or `null` when it is absent or undecodable. */
export function parseLaunchctlArguments(printOutput) {
  const block = parseArgumentsBlock(printOutput)
  return block.ok ? block.args : null
}

/** `program = /path/to/thing` from the same output. */
export function parseLaunchctlProgram(printOutput) {
  const match = /(?:^|\n)\s*program\s*=\s*(.*)/.exec(String(printOutput ?? ''))
  return match ? match[1].trim() : null
}

/** `state = running` / `pid = 123` — a job that exists but is not loaded must not look idle. */
export function parseLaunchctlState(printOutput) {
  const match = /(?:^|\n)\s*state\s*=\s*(\S+)/.exec(String(printOutput ?? ''))
  return match ? match[1] : null
}

function defaultRun(bin, args) {
  const res = spawnSync(bin, args, { encoding: 'utf8', timeout: 15_000 })
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ''),
  }
}

export function currentUid({ run = defaultRun } = {}) {
  const res = run('id', ['-u'])
  const text = String(res.stdout ?? '').trim()
  return /^\d+$/.test(text) ? text : null
}

/**
 * Read the *loaded* daemon job. `unknown: true` whenever the read itself failed
 * — the caller must then refuse to swap, because "cannot tell" is not "default
 * arguments".
 */
export function readRunningJob({
  label = DAEMON_JOB_LABEL,
  uid = null,
  run = defaultRun,
} = {}) {
  const resolved = uid ?? currentUid({ run })
  if (!resolved) {
    return { ok: false, unknown: true, code: CODES.busyOrUnreachable, reason: 'the current uid could not be read, so the running daemon job cannot be identified' }
  }
  const res = run('launchctl', ['print', `gui/${resolved}/${label}`])
  if (res.status !== 0) {
    return {
      ok: false,
      unknown: true,
      loaded: false,
      code: CODES.busyOrUnreachable,
      reason: `launchctl print gui/${resolved}/${label} answered ${res.status}: ${(res.stderr || 'no stderr').trim().slice(0, 200) || 'the daemon job is not loaded'}`,
    }
  }
  const block = parseArgumentsBlock(res.stdout)
  if (!block.ok) {
    return {
      ok: false,
      unknown: true,
      loaded: true,
      program: parseLaunchctlProgram(res.stdout),
      code: CODES.busyOrUnreachable,
      reason: `launchctl print's argument list could not be read (${block.reason}), so this tool cannot tell which state root the daemon writes to`,
    }
  }
  const args = block.args
  // A job that names `--state-dir` twice with two different values is not a job
  // whose state root can be *read*: whichever one the §2 gate looked at, the
  // daemon would be writing to the other. This used to be reachable only through
  // an embedded `}` that truncated the list, and the truncation is what the parse
  // above now refuses instead.
  const named = stateDirReadings(args)
  if (named.length > 1) {
    return {
      ok: false,
      unknown: true,
      loaded: true,
      program: parseLaunchctlProgram(res.stdout),
      code: CODES.busyOrUnreachable,
      reason: `the running job names the state-root flag more than once (${named.join(', ')}), so which state root it writes is not decidable and no version was swapped`,
    }
  }
  return {
    ok: true,
    unknown: false,
    loaded: true,
    program: parseLaunchctlProgram(res.stdout),
    jobState: parseLaunchctlState(res.stdout),
    args,
    stateDir: named[0] ?? null,
    uid: resolved,
  }
}

/* --------------------------------------------------------------- the agent */

/**
 * The `EnvironmentVariables` block, or a comment saying why there is none.
 *
 * This is the whole reason the agent can reach GitHub at all on a machine whose
 * TLS is intercepted: node reads `NODE_EXTRA_CA_CERTS` **at process start**, so a
 * bundle that exists but is not in the job's environment changes nothing, and the
 * daily run keeps failing its first network gate while looking alive.
 *
 * "No bundle" renders as a comment rather than an empty dict on purpose: the
 * installed plist is the artifact an operator reads when this goes wrong, and
 * "this machine has no exported root bundle" is information where an empty dict
 * reads like a mistake somebody made.
 */
export function agentEnvironmentBlock(caBundle) {
  if (caBundle === null || caBundle === undefined) {
    return `    <!-- ${CA_ENV_VAR} not set: this machine has no exported system root bundle -->`
  }
  if (typeof caBundle !== 'string' || caBundle === '') {
    throw new UpdaterError(CODES.agentPathUnsafe, `the update agent cannot be rendered: the CA bundle path was ${JSON.stringify(caBundle)}; an unnamed bundle would be a job that trusts nothing while claiming to trust something`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000\u000a\u000d]/.test(caBundle)) {
    throw new UpdaterError(CODES.agentPathUnsafe, `the update agent cannot be rendered: the CA bundle path carries a control character (${JSON.stringify(caBundle)})`)
  }
  return '    <key>EnvironmentVariables</key>\n'
    + '    <dict>\n'
    + `      <key>${CA_ENV_VAR}</key>\n`
    + `      <string>${escapePlistString(caBundle)}</string>\n`
    + '    </dict>'
}

/**
 * The job's own log file, named in **one** place. `StandardOutPath`/
 * `StandardErrorPath` in the rendered plist and the pre-creation below have to
 * agree on the same name, and `StateRoot.updateLogFile` on the Swift side is the
 * third reader of it — `installer/test/log-modes.test.mjs` pins all three
 * against drift.
 */
export function agentLogPath(stateRoot) {
  return typeof stateRoot === 'string' && stateRoot !== '' ? path.join(stateRoot, AGENT_LOG_NAME) : null
}

/**
 * Create the job's log owner-only, *before* launchd is handed the definition.
 *
 * launchd opens `StandardOutPath` itself, at the process umask — measured 0644 —
 * and this file is a record of what this machine has installed and updated:
 * versions, staging paths, digests, tags, GPG verdicts and the reason every
 * refusal happened. The daemon's startup sweep now tightens the name too, but a
 * log created *after* the daemon started would wait for the next restart; the
 * writer gets there first. Same posture as the installer's log: a `chmod` that
 * does not stick is a **write failure**, not a success with a note.
 */
export function preparePrivateLogFile(logPath, {
  open = (p) => fs.openSync(p, 'a'),
  chmod = (fd, mode) => fs.fchmodSync(fd, mode),
  fstat = (fd) => fs.fstatSync(fd),
  close = (fd) => fs.closeSync(fd),
} = {}) {
  if (typeof logPath !== 'string' || logPath === '') {
    return { ok: false, mode: null, error: 'the update agent needs a log path before it can be registered' }
  }
  let fd
  try {
    fd = open(logPath)
  } catch (error) {
    return { ok: false, mode: null, error: `the agent log ${logPath} could not be opened: ${error.message}` }
  }
  try {
    chmod(fd, STATE_FILE_MODE)
    const mode = Number(fstat(fd).mode ?? 0) & 0o777
    if (mode !== STATE_FILE_MODE) {
      return {
        ok: false,
        mode,
        error: `the agent log ${logPath} is still ${(mode & 0o777).toString(8)} after chmod(0600): this volume does not hold permission bits, so an owner-only log is not achievable here`,
      }
    }
    return { ok: true, mode, error: null }
  } catch (error) {
    return { ok: false, mode: null, error: `the agent log ${logPath} could not be tightened: ${error.message}` }
  } finally {
    try {
      close(fd)
    } catch {
      /* already decided; a leaking fd on a refused registration is the lesser fact */
    }
  }
}

/**
 * `launchd/` carries `{{TOKENS}}`; this is the single place that fills them, so
 * a registered agent and a rendered file in tests come from the same string.
 *
 * Two rules, both about the fact that every value here comes from a file another
 * process wrote (`update-install.json`, `GLASSPANE_STATE_DIR`, `--state-dir`):
 *
 * 1. Values are **XML-escaped**, because a path carrying `&` or `<` would
 *    otherwise rewrite the document around itself (and launchd would read a
 *    different job than this function was asked to render).
 * 2. Values never enter a shell command. The template's `/bin/sh -c` literal is
 *    a constant that references `$0`…`$3`; the paths are the argv slots after
 *    it. Quoting a path into a `-c` string instead would make a state root
 *    containing `"` or `;` into code that runs daily as the user, which is what
 *    this function used to do. The guard below refuses a *template* that has
 *    regressed to that shape, so the fix cannot be undone by editing only the
 *    plist file.
 */
/**
 * One component of `StartCalendarInterval`, in the form launchd has to be given.
 *
 * `readAgentSchedule` has always refused an out-of-range hour or minute on the *read*
 * side; the write side took whatever `Number()` the caller could spell. That mismatch is
 * the whole finding: `enable --hour 25` renders a syntactically valid plist that launchd
 * loads, never fires, and leaves the state file saying automatic updates are on — while
 * the next `enable` reading that schedule back gets `null` ("no readable
 * StartCalendarInterval") about a file that plainly exists. Checking it at the render is
 * what makes the two readers of one fact agree, and it holds for every caller, not just
 * the CLI parser that now also refuses earlier.
 */
function assertScheduleComponent(value, name, limit) {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : ''
  if (!/^\d+$/.test(text)) {
    throw new UpdaterError(
      CODES.agentPathUnsafe,
      `the update agent cannot be rendered: ${name} was ${JSON.stringify(value)}, and it has to be a whole number from 0 to ${limit} — a negative, fractional or unparseable value is not a time launchd can hold`,
    )
  }
  const number = Number(text)
  if (number > limit) {
    throw new UpdaterError(
      CODES.agentPathUnsafe,
      `the update agent cannot be rendered: ${name} ${number} is outside 0…${limit}. That plist loads and never fires, so this machine would go on reporting "automatic update is on" for a daily job that cannot run; nothing was registered`,
    )
  }
  return number
}

export function renderAgentPlist({
  nodePath = process.execPath,
  cliPath,
  stateRoot,
  daemonFlag = '--state-root',
  hour = DEFAULT_HOUR,
  minute = DEFAULT_MINUTE,
  logPath = null,
  label = AGENT_LABEL,
  caBundle = null,
  template,
} = {}) {
  if (!cliPath) throw new UpdaterError(CODES.stateWriteUnverified, 'the update agent needs an updaterCli path')
  // The log path is derived from the state root, so it is derived *after* the
  // state root has been named: `path.join(null, …)` used to throw a TypeError out
  // of a function whose refusals are supposed to be `UpdaterError`s with a code.
  const resolvedLog = logPath ?? agentLogPath(stateRoot)
  const askedHour = assertScheduleComponent(hour, 'Hour', 23)
  const askedMinute = assertScheduleComponent(minute, 'Minute', 59)
  const values = {
    '{{LABEL}}': label,
    '{{NODE_PATH}}': nodePath,
    '{{CLI_PATH}}': cliPath,
    '{{STATE_FLAG}}': daemonFlag,
    '{{STATE_ROOT}}': stateRoot,
    '{{HOUR}}': String(askedHour),
    '{{MINUTE}}': String(askedMinute),
    '{{LOG_PATH}}': resolvedLog,
  }
  for (const [token, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value === '') {
      throw new UpdaterError(CODES.agentPathUnsafe, `the update agent cannot be rendered: ${token} was ${JSON.stringify(value)}, and a job with an unnamed path would run something nobody chose`)
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000\u000a\u000d]/.test(value)) {
      throw new UpdaterError(
        CODES.agentPathUnsafe,
        `the update agent cannot be rendered: ${token} carries a control character (${JSON.stringify(value)}); a plist string cannot hold one that survives launchd's read, so fix the installer pointer or the state root rather than registering a job that may mean something else`,
      )
    }
  }
  const body = template ?? agentTemplateText()
  assertNoInterpolatedShellCommand(body)
  if (caBundle && !body.includes('{{ENV_BLOCK}}')) {
    // A template that lost the token would render a perfectly valid plist that
    // simply never hands the job its bundle — the silent shape this whole module
    // exists to prevent, because the failure it produces looks like a network
    // problem on a machine where the network is fine.
    throw new UpdaterError(CODES.agentPathUnsafe, 'the agent template has no {{ENV_BLOCK}} slot, so the exported root bundle could not reach the job; add the slot back rather than registering an agent that will fail its first network gate daily')
  }
  let out = body
  for (const [token, value] of Object.entries(values)) {
    // **函数形式**是必须的：`replaceAll` 会把替换串里的 `$&` / `$1` / `$\`` 当作模式引用展开，
    // 于是"路径里带 $&"就能把文档前文原样拼回 <string> 里 —— 转义管不了这个，它是字符串
    // 替换语义而不是 XML 语义。而这些值全部来自另一个进程写的文件（指针 / 状态根）。
    out = out.replaceAll(token, () => escapePlistString(value))
  }
  // The environment block is markup this function builds (with the path escaped
  // inside it), so it is substituted last and never through the escaping loop —
  // escaping it would put a literal `&lt;key&gt;` into the plist.
  out = out.replaceAll('{{ENV_BLOCK}}', () => agentEnvironmentBlock(caBundle))
  const leftover = /\{\{[A-Z_]+\}\}/.exec(out)
  if (leftover) {
    throw new UpdaterError(CODES.agentPathUnsafe, `the rendered agent still carries ${leftover[0]}: the template asks for a value this function does not fill, and launchd would run the placeholder`)
  }
  return out
}

/**
 * The one structural thing this module insists the template get right: nothing
 * that came from outside may sit *inside* the command the shell parses. Tokens
 * still standing inside a `"…"` or `'…'` span of the `-c` string is that mistake.
 */
export function assertNoInterpolatedShellCommand(body) {
  const match = /<string>\s*\/bin\/sh\s*<\/string>\s*<string>\s*-c\s*<\/string>\s*<string>([\s\S]*?)<\/string>/.exec(body)
  if (!match) {
    throw new UpdaterError(CODES.agentPathUnsafe, 'the update agent template no longer runs /bin/sh -c, so its argv shape has to be re-checked before it is registered')
  }
  const commandLiteral = match[1]
  if (/\{\{[A-Z_]+\}\}/.test(commandLiteral)) {
    throw new UpdaterError(
      CODES.agentPathUnsafe,
      `the update agent's shell command interpolates a token (${/\{\{[A-Z_]+\}\}/.exec(commandLiteral)[0]}) into the string the shell parses: a path containing a quote or a semicolon would run as the user every day, so the agent was not rendered`,
    )
  }
  return commandLiteral
}

/** The five XML predefined escapes: everything else a plist string may hold. */
export function escapePlistString(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function agentTemplateText() {
  return fs.readFileSync(AGENT_TEMPLATE, 'utf8')
}

/** Where a user agent lives for this uid. */
export function agentPlistPath({ label = AGENT_LABEL, homeDir = os.homedir(), uid = null } = {}) {
  void uid
  // The label is the file *name* here, so this is the same refusal in a second place: a caller that
  // passed a foreign label would write `~/Library/LaunchAgents/<somebody else>.plist` and have
  // launchd load it as a login item for that identifier.
  assertOwnAgentLabel(label)
  return path.join(homeDir, 'Library', 'LaunchAgents', label + '.plist')
}

/**
 * The one label this subsystem may ever name a plist after, boot out, or load.
 *
 * Every caller passes the constant today, which is exactly why the check lives here: `bootout` and the
 * plist *file name* both come from this value, so a future caller that took the label from the
 * installer pointer (`update-install.json`, a file another process writes) would unregister somebody
 * else's login item and leave its own definition in `~/Library/LaunchAgents` under their name. That is
 * not a hypothetical shape — §11 already reads a label out of that file to verify its own job. A rule
 * that only exists in the caller is a comment; this one is a refusal.
 */
export function assertOwnAgentLabel(label) {
  if (label !== AGENT_LABEL) {
    throw new UpdaterError(
      CODES.agentPathUnsafe,
      `the update agent's label was ${JSON.stringify(label)}, and this tool only ever registers ${JSON.stringify(AGENT_LABEL)}: a different label would make launchctl bootout tear down a job that is not GlassPane's and write a plist named after it, so nothing was registered`,
    )
  }
  return label
}

/**
 * The schedule a *rendered* agent plist asks for, read back off disk.
 *
 * Why this exists: `updater enable` renders the job, and a bare `enable` carries no `--hour`, so the
 * default would silently move a machine installed with `--hour 3` to midday — every self-update
 * (`runtime.js` hands over by running the new copy's `enable`) does exactly that, on every version.
 * Reading the definition that is already installed is what makes re-registration preserve the schedule
 * instead of re-choosing it. `null` means "this file does not answer", and the caller then says so
 * rather than pretending the job still runs at the hour the user picked.
 */
export function readAgentSchedule({ plistPath, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let text = ''
  try {
    text = readFile(plistPath)
  } catch {
    return null
  }
  const block = /<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)
  if (!block) return null
  const numberAfter = (key) => {
    const match = new RegExp(`<key>${key}<\\/key>\\s*<(?:integer|string)>([\\s\\S]*?)<\\/(?:integer|string)>`).exec(block[1])
    return match ? Number.parseInt(match[1].trim(), 10) : null
  }
  const hour = numberAfter('Hour')
  const minute = numberAfter('Minute')
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
  return { hour, minute }
}

/**
 * Install + (re)load the agent. `run` and `writeFile` are injectable so the
 * tests can drive the exact sequence without touching the developer's
 * `~/Library/LaunchAgents`.
 *
 * The verdict is not "bootstrap exited 0". launchd keeps the definition it read at bootstrap time, so
 * a bootout that failed leaves the *old* job loaded while a fresh plist sits on disk; the only thing
 * that proves the registration took is reading the loaded job back and finding the CLI path this run
 * rendered. Two different answers come out of that: a book that cannot be read is reported as
 * unverified (the job may well be right, and refusing here would tell a person their update agent is
 * off when nothing shows it is), while a book that reads back naming a different command line is a
 * failure — the swap did not take, and saying "registered" would be the lie this function exists to
 * prevent.
 */
export function registerAgent({
  label = AGENT_LABEL,
  plistPath,
  plistText,
  cliPath = null,
  uid = null,
  logPath = null,
  prepareLog = (p) => preparePrivateLogFile(p),
  run = defaultRun,
  writeFile = (p, text) => writePrivateFile(p, text),
  removeFile = (p) => fs.rmSync(p, { force: true }),
  readFile = (p) => fs.readFileSync(p, 'utf8'),
} = {}) {
  assertOwnAgentLabel(label)
  const resolvedUid = uid ?? currentUid({ run })
  if (!resolvedUid) {
    return { ok: false, code: CODES.busyOrUnreachable, message: 'the current uid could not be read; the update agent was not registered' }
  }
  // The log is tightened before launchd ever opens it. A registration that
  // cannot produce an owner-only log is refused rather than completed with a
  // world-readable audit trail attached: the daily job writes what this machine
  // has installed and why each update was refused, and "it will be fixed at the
  // next daemon restart" is not a mode that exists today.
  if (logPath !== null) {
    const prepared = prepareLog(logPath)
    if (!prepared?.ok) {
      return {
        ok: false,
        code: CODES.stateWriteUnverified,
        message: `the update agent was not registered: ${prepared?.error ?? 'the agent log could not be prepared'}`,
      }
    }
  }
  // The definition launchd is *currently* holding, kept before anything is overwritten: a re-registration
  // that launchd refuses must not leave the machine with neither a job nor a file. Measured on this machine
  // on 2026-10-03 — the state file said `enable → enabled` (that run was fine, and a refused `enable` writes
  // no state), yet by 15:27 the job was gone from `launchctl print` and `~/Library/LaunchAgents/` held no
  // plist. The only path that erases both is this function's own failure branch: `bootout` already took the
  // working job down, and `removeFile` then deleted its definition.
  let previous = null
  try {
    previous = readFile(plistPath)
  } catch {
    previous = null
  }
  writeFile(plistPath, plistText)
  // A stale definition must be booted out first: launchd caches what it read at
  // bootstrap time, which is how this repo produced EX_CONFIG twice.
  const out = run('launchctl', ['bootout', `gui/${resolvedUid}/${label}`])
  // 3 is "not loaded", which is the state this step wants; anything else is a fact about the next step.
  const booted = out.status === 0 || out.status === 3
  const boot = run('launchctl', ['bootstrap', `gui/${resolvedUid}`, plistPath])
  if (boot.status === 0 || /already/i.test(String(boot.stderr ?? ''))) {
    const loaded = readRunningJob({ label, uid: resolvedUid, run })
    if (loaded.unknown === true) {
      return {
        ok: true,
        verified: false,
        plistPath,
        message: `update agent loaded (gui/${resolvedUid}/${label}) but the loaded job could not be read back (${loaded.reason}), so this run cannot show which command line launchd is holding${booted ? '' : `; the previous definition also failed to boot out (exit ${out.status}: ${(out.stderr || 'no stderr').trim().slice(0, 120)})`}`,
      }
    }
    const args = Array.isArray(loaded.args) ? loaded.args.map(String) : []
    // Same comparison `lib/runtime.js`'s `jobState` makes against the same book: an
    // argument that merely *contains* the path we named used to verify here, so
    // `/tmp/dropin/<cliPath>` — or a wrapper whose `-c` string quotes it — produced
    // `verified: true` about a job launchd was holding for something else, while the
    // runtime reader of that very argument list said "the loaded job names … not the
    // stable entry". One fact, two answers. `sameRuntimePath` is exact (with a symlinked
    // component allowed for, which is why `includes` looked necessary and is not).
    const names = cliPath === null ? true : args.some((arg) => sameRuntimePath(arg, cliPath))
    if (!names) {
      return {
        ok: false,
        verified: false,
        plistPath,
        code: CODES.busyOrUnreachable,
        message: `launchctl bootstrap for gui/${resolvedUid}/${label} exited ${boot.status}, but the loaded job names (${args.slice(0, 6).join(' ') || 'no arguments read back'}) and not ${cliPath ?? 'the CLI path this run rendered'}${booted ? '' : `; bootout of the previous definition also failed (exit ${out.status})`}: the update agent was not replaced`,
      }
    }
    return {
      ok: true,
      verified: true,
      plistPath,
      message: `update agent registered (gui/${resolvedUid}/${label}) and the loaded job names ${cliPath ?? 'the CLI path this run rendered'}`,
    }
  }
  // launchd refused the new definition — and this call already booted out whatever was loaded. Deleting the
  // file (the shape this function used to end in) leaves the machine with neither a job nor a definition, and
  // no state write to explain it, because a refused registration deliberately writes nothing. So the
  // definition that *was* working goes back on disk and gets loaded again, and the sentence says which of the
  // two outcomes the machine is now in.
  if (previous !== null) {
    writeFile(plistPath, previous)
    const back = run('launchctl', ['bootstrap', `gui/${resolvedUid}`, plistPath])
    const restored = back.status === 0 || /already/i.test(String(back.stderr ?? ''))
    const why = `(launchctl bootstrap exit ${boot.status}: ${(boot.stderr || 'no stderr').trim().slice(0, 200)})`
    return {
      ok: false,
      code: CODES.busyOrUnreachable,
      plistPath,
      restored,
      message: `the update agent could not be loaded ${why}; ` + (restored
        ? `the definition this machine had before is back on disk and loaded again, so automatic update keeps running that previous job — the change this run asked for did not take`
        : `putting the previous definition back also failed (launchctl bootstrap exit ${back.status}: ${(back.stderr || 'no stderr').trim().slice(0, 160)}), so this machine has NO update agent registered and "updater enable" has to be run again`),
    }
  }
  removeFile(plistPath)
  return {
    ok: false,
    code: CODES.busyOrUnreachable,
    restored: false,
    message: `the update agent could not be loaded (launchctl bootstrap exit ${boot.status}): ${(boot.stderr || 'no stderr').trim().slice(0, 200)}; ${plistPath} was left in place only if bootstrap succeeded`,
    plistPath,
  }
}

/** Unload + remove the agent (`updater --disable`). */
export function unregisterAgent({
  label = AGENT_LABEL,
  plistPath,
  uid = null,
  run = defaultRun,
  removeFile = (p) => fs.rmSync(p, { force: true }),
} = {}) {
  assertOwnAgentLabel(label)
  const resolvedUid = uid ?? currentUid({ run })
  if (!resolvedUid) {
    return { ok: false, code: CODES.busyOrUnreachable, message: 'the current uid could not be read; the update agent was left installed' }
  }
  const boot = run('launchctl', ['bootout', `gui/${resolvedUid}/${label}`])
  // 3 = no such job: already not loaded, which is the state "disabled" wants.
  if (boot.status !== 0 && boot.status !== 3) {
    return { ok: false, code: CODES.busyOrUnreachable, message: `launchctl bootout gui/${resolvedUid}/${label} failed (exit ${boot.status}): ${(boot.stderr || '').trim().slice(0, 200)}` }
  }
  removeFile(plistPath)
  return { ok: true, message: `update agent removed (gui/${resolvedUid}/${label})`, plistPath }
}

/** Restart the daemon job — only ever called after §2's idle probe answered. */
export function kickstartJob({ label = DAEMON_JOB_LABEL, uid = null, run = defaultRun } = {}) {
  const resolvedUid = uid ?? currentUid({ run })
  if (!resolvedUid) return { ok: false, message: 'uid could not be resolved; the daemon was not restarted' }
  const res = run('launchctl', ['kickstart', '-k', `gui/${resolvedUid}/${label}`])
  return {
    ok: res.status === 0,
    message: res.status === 0 ? `daemon restarted (gui/${resolvedUid}/${label})` : `launchctl kickstart exit ${res.status}: ${(res.stderr || '').trim().slice(0, 200)}`,
  }
}
