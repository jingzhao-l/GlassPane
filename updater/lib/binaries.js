/**
 * Finding a command this process is actually allowed to run.
 *
 * Why this file exists, and why it is not optional. Measured on this machine on 2026-10-03 for `gpg`
 * (`lib/signature.js`'s `resolveGpgBinary`, whose comment records the whole story) and re-measured on
 * 2026-10-15 for the npm layer:
 *
 *   · launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin` (the repo's own measured value, the one
 *     `test/signature.test.mjs` pins). A Finder-launched `.app` gets nearly the same.
 *   · this machine's `node` and `npm` are in `/usr/local/bin` (measured: `command -v npm` →
 *     `/usr/local/bin/npm`; `npm config get prefix` → `/usr/local`), `glasspane-mcp` is installed by
 *     `npm install -g` into that same prefix bin, and on a Homebrew machine all three live in
 *     `/opt/homebrew/bin`. None of those is on the job's PATH.
 *
 * So every scheduled and every panel-initiated `apply` spawned `npm` *by name*, got ENOENT, and
 * `checkNpmPrefix` turned that into `npm config get prefix answered 127` — which §3.5's refusal then
 * handed to the person as a permissions problem ("check `npm config get prefix` from this account"), on a
 * machine where npm is installed and its prefix is perfectly writable. The true cause was the PATH this
 * process was started with. A refusal that names the wrong cause is itself a defect, so the search comes
 * first and the sentence reports what was searched.
 *
 * Three rules this module keeps:
 *
 * 1. **Search is filesystem-only** (`existsSync` + a regular-file check + `X_OK`), never a probe spawn.
 *    `signature.js` may run `gpg --version` because a gpg that exists and cannot work is a real state there;
 *    for npm and `glasspane-mcp` the question this fix answers is "is there an executable file at this
 *    path", and a test must be able to drive the whole search without the suite depending on whether the
 *    developer's machine has the tool installed. The regular-file half is not decoration: `X_OK` is a
 *    *search* permission and a directory has one, so a directory named `npm` used to be returned as the
 *    binary and then described as "exists but this account cannot execute it" — a permissions story about a
 *    path that holds no executable at all.
 * 2. **Every answer carries `tried`** — the exact paths that were looked at, in the order they were
 *    looked at. "Not installed" is only honest after a search was, and the actionable sentence is the one
 *    that names where it looked.
 * 3. **Resolving is not starting.** Every answer here is a path handed to a spawn, and the real binaries on
 *    this machine are `#!/usr/bin/env node` scripts (measured 2026-10-16: the first line of
 *    `/usr/local/bin/npm` and of `/usr/local/bin/glasspane-mcp`, and `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin
 *    /usr/local/bin/npm config get prefix` → `env: node: No such file or directory`, exit **127**). An `env`
 *    shebang looks `node` up in the **child's** PATH, so spawning the resolved absolute path with the job's
 *    inherited minimal PATH still dies — and 127 is not `notFound`, which is how the caller read it as "npm
 *    answered 127" and blamed the prefix's permissions. `childSpawnEnv()` makes the resolution usable: it
 *    hands the child a PATH that can find the runtime its own shebang asks for.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * The PATH a launchd job is handed on macOS, measured in this repo (`lib/signature.js`,
 * `test/signature.test.mjs`). Exported so a test can drive the search with *this* value rather than with a
 * number somebody invented — the whole defect is the difference between this and a shell's PATH.
 */
export const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/** Where Homebrew, a `/usr/local` install and MacPorts put their commands. */
export const COMMON_BIN_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'])

/**
 * The toolchains a `swift build` can come from. `/usr/bin/swift` is the Command Line Tools shim, which is
 * what a job with the minimal PATH gets *when the tools are installed*; a machine with only Xcode keeps
 * the compiler inside the app bundle.
 */
export const SWIFT_EXTRA_DIRS = Object.freeze([
  '/usr/bin',
  '/Applications/Xcode.app/Contents/Developer/usr/bin',
  '/Library/Developer/CommandLineTools/usr/bin',
])

/** Every bare command `updater/lib` spawns, and where each one may still live. */
export const SEARCHED_COMMANDS = Object.freeze(['npm', 'glasspane-mcp', 'swift'])

function splitPathValue(pathValue) {
  return String(pathValue ?? '')
    .split(':')
    .map((dir) => dir.trim())
    // An empty component means the current directory in POSIX. Searching cwd for a system command is
    // how a dropped `./npm` decides what the updater runs, so it is refused rather than resolved.
    .filter((dir) => dir !== '' && dir !== '.')
}

/** The one system call this module asks for a home. Throws when there is no record; `recordHome` turns that into `null`. */
const passwordRecordHome = () => os.userInfo().homedir

/**
 * The home the **password record** answers for, or `null` when this process cannot read one.
 *
 * Why not `$HOME`: `env.HOME` and `os.homedir()` are the *same* caller-controlled value
 * (`os.homedir()` consults `$HOME` first and only falls back to the record), and this
 * product's every other home lookup reads the record — `updater/cli.js`'s `recordHomeDir`,
 * `updater/agent-entry.js`'s `entryHomeDir`, `mcp-shell/src/update-state.ts`'s `recordHome`,
 * `installer/glasspane.js`'s `stateRootOf`. A `$HOME`-redirected daily job would search a
 * prefix bin that describes nobody's install while the panel and the daemon use the account's
 * real one.
 *
 * Failure shape: `null`, which is what this module's home lookup already answered when it
 * could not read one (`homeOf` used to `return null`), and which every caller already
 * tolerates (`if (home)`). It is "unknown", not a guess — there is no fallback to `$HOME` behind it.
 * `readRecord` is injectable so a test can arrange the no-record shape this machine has.
 */
export function recordHome({ readRecord = passwordRecordHome } = {}) {
  try {
    const home = String(readRecord() ?? '').trim()
    return home === '' ? null : home
  } catch {
    return null
  }
}

/**
 * The `bin` directories a global `npm install -g` can land a command in, without asking npm.
 *
 * Asking npm is the circular move — `npm config get prefix` is one of the calls this search exists to make
 * possible — so the prefixes come from the places npm itself is documented to use, plus the environment
 * (`npm_config_prefix`, which npm reads before it reads any file). Every one of these is a *guess about a
 * directory*, checked with `existsSync` before it is ever used, so a wrong guess costs a stat and cannot
 * put a non-executable path in front of a real one.
 *
 * The home half of that list is the **password record's** home (`recordHome`), never `$HOME`: a redirected
 * `$HOME` must not move where this search looks. With no record to read, that prefix is left out — the
 * answer is "unknown", not a guessed directory — and the documented machine prefixes still stand.
 */
export function npmGlobalBinDirs({ env = process.env, readRecord = passwordRecordHome } = {}) {
  const home = recordHome({ readRecord })
  const prefixes = []
  const configPrefix = String(env?.npm_config_prefix ?? '').trim()
  if (configPrefix !== '') prefixes.push(configPrefix)
  if (home) prefixes.push(path.join(home, '.npm-global'))
  prefixes.push('/usr/local', '/opt/homebrew', '/opt/local')
  const dirs = []
  for (const prefix of prefixes) {
    // A prefix *is* a bin directory on Homebrew-style installs (`/opt/homebrew/bin` is the prefix's own
    // bin), and `<prefix>/bin` on `/usr/local`-style ones. Both spellings are searched, in this order.
    if (prefix.endsWith(`${path.sep}bin`)) dirs.push(prefix)
    else dirs.push(path.join(prefix, 'bin'))
  }
  return [...new Set(dirs)]
}

/**
 * The extra directories to search for `name` after PATH, in the order they are searched.
 *
 * `dirname(process.execPath)` is first because this program is *node*, so wherever node was found to run
 * this process is by definition a directory this account can execute from — and node and npm are installed
 * together on every shape this project ships (measured: `/usr/local/bin/node` and `/usr/local/bin/npm`).
 */
export function candidateDirsFor(name, {
  env = process.env,
  execPath = process.execPath,
  readRecord = passwordRecordHome,
} = {}) {
  const nodeDir = path.dirname(String(execPath ?? ''))
  const npmBin = npmGlobalBinDirs({ env, readRecord })
  if (name === 'glasspane-mcp') {
    // Installed by `npm install -g`, so the prefix bin is where it actually is; the node directory is the
    // same one on this machine and is kept behind it as the fallback.
    return [...new Set([...npmBin, nodeDir, ...COMMON_BIN_DIRS])]
  }
  if (name === 'swift') {
    return [...new Set([nodeDir, ...SWIFT_EXTRA_DIRS, ...COMMON_BIN_DIRS])]
  }
  return [...new Set([nodeDir, ...COMMON_BIN_DIRS, ...npmBin])]
}

const defaultExists = (target) => {
  try {
    return fs.existsSync(target)
  } catch {
    return false
  }
}

const defaultCanExec = (target) => {
  try {
    fs.accessSync(target, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Is `target` a regular file (following a symlink, because `npm install -g` puts a *symlink* in the prefix
 * bin — measured: `/usr/local/bin/glasspane-mcp` is one)?
 *
 * `X_OK` cannot answer this: on macOS and Linux a directory answers it, since "executable" for a directory
 * means "searchable". Without this second test a directory named `npm` was returned as `bin` and later
 * described as a file this account cannot execute.
 */
const defaultIsFile = (target) => {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * The environment to hand a spawned command so that its own shebang can be satisfied.
 *
 * The PATH this process was started with is the launchd job's `/usr/bin:/bin:/usr/sbin:/sbin` (see
 * `LAUNCHD_PATH`), and this machine's npm is a `#!/usr/bin/env node` script — so a spawn that inherits it
 * verbatim resolves `npm`, execs it, and gets `env: node: No such file or directory` with exit 127. The
 * two directories added here are not guesses:
 *
 *   · `dirname(process.execPath)` — the node that is *running this program*, therefore executable by this
 *     account by construction;
 *   · the directory of the resolved binary itself — the same directory that holds `node` on every install
 *     shape this project ships, and the right one for a shebang that asks for anything else in it.
 *
 * Everything else in `env` is kept as it arrived: this adds search directories to PATH, it does not edit
 * the caller's HOME, its CA bundle, or any other variable a child legitimately reads.
 */
export function childSpawnEnv(bin, {
  env = process.env,
  execPath = process.execPath,
  pathValue = env?.PATH,
} = {}) {
  const base = env && typeof env === 'object' ? env : {}
  const dirs = []
  const nodeDir = path.dirname(String(execPath ?? ''))
  if (nodeDir !== '' && nodeDir !== '.') dirs.push(nodeDir)
  const wanted = String(bin ?? '')
  if (wanted.includes(path.sep)) {
    const own = path.dirname(wanted)
    if (own !== '' && own !== '.') dirs.push(own)
  }
  const PATH = [...new Set([...dirs, ...splitPathValue(pathValue)])].join(':')
  return { ...base, PATH }
}

/**
 * Did this child die because its interpreter could not be found?
 *
 * `/usr/bin/env` answers exactly one shape (`env: node: No such file or directory`) and the exit is 127 —
 * the same number a shell uses for "command not found", which is why this machine's old refusal read it as
 * npm answering. Recognising it is what lets the sentence name the *runtime* instead of the prefix.
 */
export function isInterpreterMissing({ status = null, stderr = '' } = {}) {
  const text = String(stderr ?? '')
  return status === 127 && /env:\s*\S+:\s*No such file or directory/.test(text)
}

/** The sentence for "the child ran and could not find the interpreter its shebang names". */
export function interpreterMissingDetail({ name = 'the command', bin = null, stderr = '', searched = null } = {}) {
  const asked = (/env:\s*(\S+):/.exec(String(stderr ?? '')) ?? [])[1] ?? 'its interpreter'
  return `${bin ?? name} was found and started, but it could not run: ${asked} is not on the PATH this process handed to the child `
    + `(searched ${searched ?? 'the inherited PATH'}), which is what the \`${asked}\` line at the top of that script asks for. `
    + `This is the *runtime* being unreachable, not a permission of any directory: install ${asked} where the updater can reach it, `
    + 'or re-run "updater enable" from a session that has it — enable renders the daily job\'s PATH from the directory node is '
    + 'running this program from, so the job gets the same reach this run just had.'
}

/**
 * Look for `name` in PATH's directories first, then in `dirs`, without executing anything.
 *
 * Returns `{ bin, tried, source, blocked }`: `bin` is always an **absolute path** (so a later spawn never
 * depends on the PATH of the process that spawned it either), `tried` is every candidate that was looked
 * at, in order — *including* the ones that turned out not to exist, because the sentence a person acts on
 * is the list of places this run was allowed to look — and `source` says which half of the search answered
 * (`path` / `known prefix` / `null`).
 *
 * A candidate that is there but unusable is *named in the reason* and skipped rather than reported as "not
 * installed": `blocked` carries the path and `blockedWhy` says which measurement failed (`directory` — not
 * a regular file at all; `not-executable` — a file this account cannot exec). Those are different repairs
 * from installing the thing and this module's whole purpose is to tell them apart, so the sentence must not
 * call a directory a permission problem.
 */
export function resolveBinary(name, {
  env = process.env,
  dirs = [],
  exists = defaultExists,
  canExec = defaultCanExec,
  isFile = defaultIsFile,
  pathValue = env?.PATH,
} = {}) {
  const wanted = String(name ?? '')
  if (wanted === '' || wanted.includes(path.sep)) {
    // A path, not a name: nothing to search, and `tried` stays honest by naming exactly that path.
    if (wanted === '') return { bin: null, tried: [], source: null, blocked: null, blockedWhy: null }
    const unusable = exists(wanted) && (!isFile(wanted) || !canExec(wanted)) ? wanted : null
    return {
      bin: wanted,
      tried: [wanted],
      source: 'named path',
      blocked: unusable,
      blockedWhy: unusable ? (!isFile(wanted) ? 'directory' : 'not-executable') : null,
    }
  }
  const pathDirs = splitPathValue(pathValue)
  const searched = [...new Set([...pathDirs, ...dirs])]
  const tried = []
  let blocked = null
  let blockedWhy = null
  for (const dir of searched) {
    const candidate = path.join(dir, wanted)
    if (tried.includes(candidate)) continue
    tried.push(candidate)
    if (!exists(candidate)) continue
    if (!isFile(candidate)) {
      // A directory named `npm` answers `X_OK` (that bit means "searchable" here), so this test has to come
      // first: passing it on as the binary would hand a spawn a path that can never run.
      if (blocked === null) { blocked = candidate; blockedWhy = 'directory' }
      continue
    }
    if (canExec(candidate)) return { bin: candidate, tried, source: pathDirs.includes(dir) ? 'path' : 'known prefix', blocked: null, blockedWhy: null }
    // Found but not executable: keep searching (another prefix may hold a real one), and remember it so
    // the sentence can name the one thing that was there.
    if (blocked === null) { blocked = candidate; blockedWhy = 'not-executable' }
  }
  return { bin: null, tried, source: null, blocked, blockedWhy }
}

/**
 * The honest sentence for "this run could not find the command", naming the search rather than guessing at
 * the cause. Shaped like `signature.js`'s `gpgMissingDetail` on purpose: same fact, same reader.
 */
export function binaryNotFoundDetail({
  name = 'the command',
  tried = [],
  pathValue = process.env.PATH ?? '',
  blocked = null,
  blockedWhy = null,
} = {}) {
  const where = `PATH=${pathValue || '(empty)'}`
  if (tried.length === 0) {
    return `${name} was not found: this process searched no directory at all (${where}), so nothing can be concluded about whether it is installed`
  }
  // The tail says what was *measured* about the one path that was there. A directory is not a permissions
  // fact, and describing it as one sends the operator to `chmod` on a path with no file in it.
  const tail = blocked
    ? blockedWhy === 'directory'
      ? ` ${blocked} is there but it is a directory, not an executable file, which is a different repair from installing it or from granting permission`
      : ` ${blocked} is there but is not executable by this account, which is a different repair from installing it`
    : ''
  return `${name} could not be found on the searched paths — it was looked for at ${tried.join(', ')} and none of those is an executable file. `
    + `This process runs with ${where}, which does not include the directory the command is installed in (a launchd job and a Finder-launched .app are handed ${LAUNCHD_PATH} even when your shell has the right one)${tail}. `
    + `Re-run the same command from a shell whose PATH includes that directory; for the daily job run "updater enable" from that `
    + `shell, because enable renders the job's own PATH (the directory this node lives in plus the npm prefix bins) into the `
    + `plist it registers — a hand-edit of that block is overwritten by the next enable. The updater will not invent a path it did not see.`
}

/**
 * The sentence for "the file is there and this run could not put it into motion" — said as whichever fact
 * was measured: a directory has no executable to be denied, and a file this account cannot exec does.
 */
export function binaryNotExecutableDetail({ name = 'the command', bin = null, code = 'EACCES', why = 'not-executable' } = {}) {
  if (why === 'directory') {
    return `${bin ?? name} is a directory, not an executable file, so the updater ran nothing`
  }
  return `${bin ?? name} exists but this account cannot execute it (${code}), so the updater ran nothing`
}

/**
 * Is `bin` one of the commands this module searches for?
 *
 * Only these get resolution. `launchctl`, `id` and `security` are deliberately **not** in the list: they
 * live in `/bin` and `/usr/bin`, which the minimal job PATH does contain, so a search would add noise to
 * the sentence without ever changing an answer. `signature.js` keeps its own gpg resolver — probing gpg is
 * a stronger question than checking a bit — and this module does not touch it.
 */
export function isSearchedCommand(bin) {
  const wanted = String(bin ?? '')
  return !wanted.includes(path.sep) && SEARCHED_COMMANDS.includes(wanted)
}
