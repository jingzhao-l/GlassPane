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
import { UpdaterError, writePrivateFile } from './fsutil.js'
import { stateDirReadings } from './policy.js'

export const AGENT_LABEL = 'com.glasspane.update'
export const DAEMON_JOB_LABEL = 'com.glasspane.daemon'
export const AGENT_PLIST_NAME = `${AGENT_LABEL}.plist`
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
    if (line.startsWith('"')) {
      return { ok: false, args: null, reason: `argument line ${i + 1} opens a quote that never closes (${JSON.stringify(line)})` }
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
      reason: `the running job names --state-dir more than once (${named.join(', ')}), so which state root it writes is not decidable and no version was swapped`,
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
 * Render the update agent's plist body. The shipped template under
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
  const resolvedLog = logPath
    ?? (typeof stateRoot === 'string' && stateRoot !== '' ? path.join(stateRoot, 'update.log') : null)
  const values = {
    '{{LABEL}}': label,
    '{{NODE_PATH}}': nodePath,
    '{{CLI_PATH}}': cliPath,
    '{{STATE_FLAG}}': daemonFlag,
    '{{STATE_ROOT}}': stateRoot,
    '{{HOUR}}': String(hour),
    '{{MINUTE}}': String(minute),
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
  return path.join(homeDir, 'Library', 'LaunchAgents', label + '.plist')
}

/**
 * Install + (re)load the agent. `run` and `writeFile` are injectable so the
 * tests can drive the exact sequence without touching the developer's
 * `~/Library/LaunchAgents`.
 */
export function registerAgent({
  label = AGENT_LABEL,
  plistPath,
  plistText,
  uid = null,
  run = defaultRun,
  writeFile = (p, text) => writePrivateFile(p, text),
  removeFile = (p) => fs.rmSync(p, { force: true }),
} = {}) {
  const resolvedUid = uid ?? currentUid({ run })
  if (!resolvedUid) {
    return { ok: false, code: CODES.busyOrUnreachable, message: 'the current uid could not be read; the update agent was not registered' }
  }
  writeFile(plistPath, plistText)
  // A stale definition must be booted out first: launchd caches what it read at
  // bootstrap time, which is how this repo produced EX_CONFIG twice.
  run('launchctl', ['bootout', `gui/${resolvedUid}/${label}`])
  const boot = run('launchctl', ['bootstrap', `gui/${resolvedUid}`, plistPath])
  if (boot.status === 0 || /already/i.test(String(boot.stderr ?? ''))) {
    return { ok: true, message: `update agent registered (gui/${resolvedUid}/${label})`, plistPath }
  }
  removeFile(plistPath)
  return {
    ok: false,
    code: CODES.busyOrUnreachable,
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
