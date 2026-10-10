/**
 * §11 — the updater's own installed copy.
 *
 * Why this module exists: the daily job runs the `updater/` code that the *installer's* clone points at
 * (`update-install.json` → `updaterCli`), while §3.5 swaps the `.app` bundles and the npm packages. Before
 * this, a release whose whole content was "fix the updater" could never reach a machine: users' jobs kept
 * applying the old gates — e.g. the one that refused every real release asset — while the panel said
 * "up to date". A mechanism that cannot deliver the fixes to itself has not fixed anything.
 *
 * The rules that make this safe, in the order the code enforces them:
 *  · the source is **the tree the eight gates already verified** (`staged.rootPath`), copied before the
 *    staging directory is retired, and never anything else;
 *  · it lands in a **new version directory** under `<stateRoot>/runtime/`. The copy that is executing right
 *    now is never written into — that is how a half-replaced updater gets made;
 *  · the pointer flips last and is the only authority for "who runs next" (`writePointer`: temp file,
 *    rename, read back, mode re-checked);
 *  · re-registration is performed **by the new copy** (`enable`), because the plist's CLI path comes from
 *    whoever renders it — having the old code write the new path would recreate a second author;
 *  · the claim "the agent now runs the new path" is only made after `launchctl print` reads the *loaded*
 *    job back. Anything unreadable is `agentVerified: false` and a stated failure, never a success;
 *  · any step that fails puts the pointer and the job back on the previous copy (best-effort, and the
 *    restore's own failure is reported) — while the swap that *did* succeed keeps `status: applied`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync as nodeSpawnSync } from 'node:child_process'

import { CODES } from './codes.js'
import {
  UpdaterError,
  canonicalPath,
  ensurePrivateDir,
  realWithin,
  removeTreeWithin,
  resolveWithin,
  sameRuntimePath,
  tightenMode,
  writableRoots,
} from './fsutil.js'
import { agentEntryPath, ensureAgentEntry } from './agent-entry.js'
import { AGENT_LABEL, agentPlistPath } from './launchd.js'
import { readPointer, writePointer } from './state.js'
import { compareVersions } from './version.js'

/** Two generations live side by side: the one the pointer names, and the one to fall back to. */
export const RUNTIME_KEEP = 2

/** Closed vocabulary for the record stamped into the state file (§11.9). */
export const RUNTIME_STATUSES = Object.freeze(['refreshed', 'failed', 'kept', 'skipped'])

const VERSION_RE = /^\d+\.\d+\.\d+$/

/** `<stateRoot>/runtime` — private, and the only place a runtime tree may ever be written. */
export function runtimeRoot(stateRoot) {
  const { runtime } = writableRoots(stateRoot)
  return runtime
}

/** `<stateRoot>/runtime/<version>`; a version string out of a tag is checked before it becomes a path. */
export function runtimeTreePath(stateRoot, version) {
  const root = runtimeRoot(stateRoot)
  if (!VERSION_RE.test(String(version ?? ''))) {
    throw new UpdaterError(CODES.tagUnparseable, `refusing a runtime directory named ${JSON.stringify(version)}: expected x.y.z`)
  }
  return resolveWithin(root, path.join(root, String(version)), 'runtime directory')
}

/** The file that decides whether a copied tree is runnable at all. */
export function runtimeCliPath(treePath) {
  return path.join(treePath, 'updater', 'cli.js')
}

/**
 * What a runtime generation is made of. `updater/cli.js` reads nothing outside `updater/` —
 * `lib/`, `schema/update-state.schema.json` and `launchd/com.glasspane.update.plist` are all
 * reached from `updater/lib` — and `lib/signature.js` reaches one directory further still: its trust
 * anchor is `GLASSPANE_SIGNING_PUBLIC_KEY`, which lives in `installer/cli.js` and is imported as
 * `../../installer/cli.js` (gate 8 cannot be run at all without that file, which is why a copy that
 * leaves it out would install an updater that cannot verify a release). `package.json` comes along
 * because it is 600 bytes and names the version a reader can compare with the directory it sits in.
 *
 * The whole release tree used to be copied, which cost ~200 MB per generation: `apply` builds the
 * bundles *inside* the staged tree (`swift build --package-path <staged>/engine` lands its products
 * under `<staged>/engine/.build`), so the "updater's own copy" carried two `.app` bundles and every
 * intermediate object file with it, and `RUNTIME_KEEP`'s "two generations" was really half a gigabyte.
 * Measured here on 2026-09-30: `updater` 816 K, `installer` 184 K, `mcp-shell` 33 M, `engine` 1.8 G.
 * It also carried SwiftPM's own symlinks, which is the second reason for this list — see
 * {@link findIndirection}.
 */
export const RUNTIME_COPY_INCLUDES = Object.freeze(['updater', 'installer', 'package.json'])

function defaultCopyTree(source, target) {
  for (const rel of RUNTIME_COPY_INCLUDES) {
    const from = path.join(source, rel)
    if (rel === 'updater') {
      if (!fs.existsSync(from)) {
        throw new UpdaterError(CODES.stateWriteUnverified, `${source} carries no updater/ directory, so there is no updater to install from it`)
      }
    } else if (!fs.existsSync(from)) {
      continue
    }
    fs.cpSync(from, path.join(target, rel), { recursive: true, dereference: false })
  }
}

/**
 * Every path under `dir` that is neither a regular file nor a directory.
 *
 * Measured on this machine (2026-09-30, `probe-cp-and-realpath.mjs`): `fs.cpSync(..., {dereference:
 * false})` does **not** preserve a relative symlink — `link -> a.txt` is recreated as
 * `link -> /private/var/folders/…/gp-src-XXXX/a.txt`, i.e. an absolute link back into the directory
 * it was copied *from*. Here that directory is the staging tree, which `apply` retires two statements
 * after this function returns. So a link in the copy is not "the same link": it is a dangling one that
 * points into `<stateRoot>/update-staging/<ver>/…`, a path the next `check` re-creates out of freshly
 * downloaded bytes — a rejected tree's contents silently re-appearing under the copy the daily job
 * runs. A release archive's own links are already materialized as byte copies by `tar.js`, and the
 * build's links live under `engine/.build`, which {@link RUNTIME_COPY_INCLUDES} no longer copies; this
 * is the gate that says so out loud instead of trusting either.
 */
export function findIndirection(dir) {
  const found = []
  const walk = (current, rel) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      found.push(`${rel || '.'}: the directory itself could not be listed (${error?.message ?? String(error)})`)
      return
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      const key = rel ? `${rel}/${entry.name}` : entry.name
      let stat = null
      try {
        // `lstat`, because the whole question is what the entry *is* and not what it leads to.
        stat = fs.lstatSync(abs)
      } catch (error) {
        found.push(`${key}: cannot be inspected (${error?.message ?? String(error)})`)
        continue
      }
      if (stat.isDirectory()) walk(abs, key)
      else if (stat.isFile()) continue
      else found.push(`${key} is ${stat.isSymbolicLink() ? 'a symlink' : 'not a regular file'} (${rel ? `${rel}/` : ''}${entry.name})`)
    }
  }
  walk(dir, '')
  return found
}

/** The three things a directory must be before it may be pointed at as "the updater". */
function verifyRuntimeTree(dir) {
  // The directory itself first, and by `lstat`: a `runtime/<version>` that is a *symlink* passes every
  // check below it (listing follows the link) while naming somebody else's tree, and the pointer would
  // then hand launchd a path whose contents are decided by whoever made that link. Same-user code owns
  // this directory tree, so "it is a directory" is not the question — "it is this directory" is.
  let self = null
  try {
    self = fs.lstatSync(dir)
  } catch (error) {
    return { ok: false, message: `${dir} could not be inspected (${error?.message ?? String(error)})` }
  }
  if (!self.isDirectory()) {
    return { ok: false, message: `${dir} is ${self.isSymbolicLink() ? 'a symlink, not a directory' : 'not a directory'}: a runtime generation must be a real directory this tool copied itself, because the pointer is about to name it as the updater` }
  }
  const indirect = findIndirection(dir)
  if (indirect.length > 0) {
    return { ok: false, message: `${dir} carries ${indirect.length} entrie(s) that are not regular files or directories (${indirect.slice(0, 5).join('; ')}): a copied link would point back into the staging tree this run retires, so the tree was refused` }
  }
  const cli = runtimeCliPath(dir)
  let size = 0
  try {
    size = fs.statSync(cli).size
  } catch {
    size = 0
  }
  if (size === 0) {
    return { ok: false, message: `${dir} has no readable updater/cli.js (size ${size}); nothing was installed from it` }
  }
  return { ok: true, message: null, cliPath: cli }
}

/**
 * Copy the verified release tree into a fresh version directory and return its CLI path.
 *
 * The copy goes to a `.<version>.new-<pid>` sibling first and is renamed into place only after the
 * tree has been verified ({@link verifyRuntimeTree}): a directory that exists is not a tree that
 * works, and a rename within one directory is the only atomic step here.
 *
 * The mode check happens *before* the tree is declared landed, and a mode that does not stick removes
 * the tree again. That order is the fix for a reuse bypass: the tree used to be marked landed first,
 * so a `tightenMode` refusal left a 0755 generation on disk that the *next* run accepted through the
 * reuse path without re-checking anything — one loose volume turning into a permanent one.
 */
export function materializeRuntime({ stateRoot, sourceTree, version, copy = defaultCopyTree, exists = (p) => fs.existsSync(p) }) {
  const root = runtimeRoot(stateRoot)
  ensurePrivateDir(root)
  const target = runtimeTreePath(stateRoot, version)
  if (exists(target)) {
    // A previous attempt already landed this version. Re-use it rather than deleting a tree that
    // something may be executing from — but "re-use" re-runs every check the fresh path does. The
    // name of a directory is not evidence that its contents came from a verified tree or that its
    // mode ever stuck.
    const checked = verifyRuntimeTree(target)
    if (!checked.ok) {
      // The whole reason goes in, unedited: this string is the only thing a person or an agent gets,
      // and an earlier version of this line trimmed "updater/cli-backup is a symlink" off the front of
      // it while keeping the generic tail — which read as "try again" about a tree that will never be
      // right.
      return { ok: false, code: CODES.stateWriteUnverified, message: `an existing runtime generation was not re-used: ${checked.message}`, treePath: null, cliPath: null }
    }
    try {
      tightenMode(target, 0o700, 'runtime directory')
    } catch (error) {
      return { ok: false, code: CODES.stateWriteUnverified, message: `${target} exists but its mode could not be brought to 0700 (${error?.message ?? String(error)}), so it is not pointed at`, treePath: null, cliPath: null }
    }
    return { ok: true, treePath: target, cliPath: checked.cliPath, reused: true }
  }
  const temp = path.join(root, `.${version}.new-${process.pid}`)
  let landed = false
  let result = null
  try {
    copy(sourceTree, temp)
    const checked = verifyRuntimeTree(temp)
    if (!checked.ok) {
      result = { ok: false, code: CODES.stateWriteUnverified, message: `the copied tree ${checked.message}; nothing was installed from it`, treePath: null, cliPath: null }
    } else {
      fs.renameSync(temp, target)
      ensurePrivateDir(target)
      // The pointer is the only thing that decides who runs next, so the copy is only "the runtime"
      // once the mode on the version directory itself says it is private.
      try {
        tightenMode(target, 0o700, 'runtime directory')
        landed = true
      } catch (error) {
        result = {
          ok: false,
          code: CODES.stateWriteUnverified,
          message: `${target} was copied but its mode could not be set to 0700 (${error?.message ?? String(error)}); the tree was removed instead of being pointed at`,
          treePath: null,
          cliPath: null,
        }
      }
      if (landed) result = { ok: true, treePath: target, cliPath: runtimeCliPath(target), reused: false }
    }
  } catch (error) {
    result = {
      ok: false,
      code: CODES.stateWriteUnverified,
      message: `copying the verified release tree into the runtime root failed (${error?.message ?? String(error)})`,
      treePath: null,
      cliPath: null,
    }
    // The rename can succeed and the step after it (private mode, verified by reading it back) can
    // still refuse. Keeping that tree would be the worse answer: the next apply of the same version
    // would find `<runtime>/<version>` on disk, take the reuse path, and flip the pointer at a
    // generation whose mode this tool had just refused to sign off on — one loose volume turning into
    // a permanent one. A refusal must cost disk nothing, so the tree goes back with the refusal, and a
    // cleanup that itself fails is said out loud rather than left for somebody to find.
    if (landed && fs.existsSync(target)) {
      try {
        removeTreeWithin(root, target)
        landed = false
        result.message += `; ${target} was removed again because it was never verified`
      } catch (cleanupError) {
        result.message += `; and ${target} could not be removed after the failure (${cleanupError?.message ?? String(cleanupError)}), so it is on disk without a pointer naming it`
      }
    }
  } finally {
    // Every failure path removes the half-copied tree — including "copied but no entry point", which
    // used to return straight through the `catch` and leave a partial release sitting in the runtime
    // root as a hidden directory. A refused install must not cost disk. A cleanup that itself fails is
    // appended to the refusal instead of being swallowed: that leftover needs naming.
    if (!landed && fs.existsSync(temp)) {
      try {
        removeTreeWithin(root, temp)
      } catch (cleanupError) {
        result.message += `; and the half-copied ${temp} could not be removed (${cleanupError?.message ?? String(cleanupError)})`
      }
    }
    // Same rule one step later: a tree that landed and then failed its mode check must not stay behind
    // for the reuse path to trip over.
    if (!landed && result?.treePath === null && fs.existsSync(target) && fs.lstatSync(target).isDirectory()) {
      try {
        removeTreeWithin(root, target)
      } catch (cleanupError) {
        result.message += `; and ${target} could not be removed after the failed mode check (${cleanupError?.message ?? String(cleanupError)})`
      }
    }
  }
  return result
}

/**
 * `realWithin` and `sameRuntimePath` live in `lib/fsutil.js` since 2026-10-09: the
 * registration check in `lib/launchd.js` had to make the *same* path-identity
 * comparison, and importing this module from there would have made a cycle
 * (`runtime.js` already imports `launchd.js`). They are re-exported here because the
 * runtime surface's readers name them this way.
 */
export { realWithin, sameRuntimePath }

/** Which generation of the runtime root a CLI path belongs to, or null when it is not one (a clone). */
export function runtimeVersionOf(cliPath, runtimeDir) {
  const dir = String(runtimeDir ?? '')
  const candidates = [[String(cliPath ?? ''), dir], [realWithin(cliPath), realWithin(runtimeDir)]]
  for (const [text, root] of candidates) {
    if (!text.startsWith(root + path.sep)) continue
    const first = text.slice(root.length + 1).split(path.sep)[0]
    if (VERSION_RE.test(first)) return first
  }
  return null
}

/**
 * Prune the runtime root down to the generations that are still **pointed at**, and say what was
 * removed. `keep` is a list, not one version, because three things can name one: the new pointer,
 * the previous pointer value, and — when the handover was deferred — the generation the *loaded job*
 * still runs. Deleting what a launchd definition points at is how "automatic update is on" quietly
 * becomes `Cannot find module` the next morning. Pruning is a convenience: a failure here is
 * reported and never turned into "cleaned".
 *
 * "Newest" is decided with {@link compareVersions}, not with a string sort. A lexicographic order puts
 * `1.9.0` above `1.10.0`, so the fallback generation kept by an unpinned sort can be the one nobody
 * points at while the one something still runs from is deleted — measured against `1.8.0`/`1.9.0`
 * fixtures in `test/runtime.test.mjs`.
 */
export function pruneRuntime({ stateRoot, keep = [], limit = RUNTIME_KEEP }) {
  const root = runtimeRoot(stateRoot)
  if (!fs.existsSync(root)) return { removed: [], failed: [] }
  const versions = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => compareVersions(b, a))
  const pinned = (Array.isArray(keep) ? keep : [keep]).filter(Boolean).filter((v) => versions.includes(v))
  const extra = versions.filter((v) => !pinned.includes(v)).slice(0, Math.max(0, limit - pinned.length))
  const wanted = new Set([...pinned, ...extra])
  const removed = []
  const failed = []
  for (const version of versions) {
    if (wanted.has(version)) continue
    const dir = path.join(root, version)
    try {
      removeTreeWithin(root, dir)
      removed.push(version)
    } catch (error) {
      failed.push({ version, message: error?.message ?? String(error) })
    }
  }
  return { removed, failed }
}

/**
 * The default registration step: let the new copy register itself, and read its answer.
 * Exported because "the argv we handed" and "what a killed child means" can only be
 * proven against a real process, not against my reading of the code.
 */
export function defaultRunEnable({ cliPath, stateRoot, env = process.env, spawn = nodeSpawnSync }) {
  const got = spawn(process.execPath, [cliPath, 'enable', '--state-dir', stateRoot, '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...env },
  })
  const line = String(got?.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
  let parsed = null
  try {
    parsed = line === '' ? null : JSON.parse(line)
  } catch {
    parsed = null
  }
  if (got?.error && got.error.code === 'ENOENT') {
    return { ok: false, message: `the new updater script ${cliPath} could not be started (${got.error.message})`, parsed: null, argv: [cliPath, 'enable', '--state-dir', stateRoot, '--json'] }
  }
  if (got?.signal) {
    return { ok: false, message: `registering with the new updater was killed by signal ${got.signal}`, parsed, argv: [cliPath, 'enable', '--state-dir', stateRoot, '--json'] }
  }
  if (!parsed || parsed.ok !== true) {
    // When there is no answer to read, the child's own stderr is the only reason there is —
    // "Cannot find module /private/…/cli.js" (the script never landed) and "the new updater
    // refused: <code>" (it landed and said no) demand opposite actions from a person.
    // node's error banner ends with its version line, so "the last line" is never the reason.
    // Prefer the line that actually names the failure, then the first one, then nothing.
    const lines = String(got?.stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    const noise = lines.find((l) => /Error|Cannot find|MODULE_NOT_FOUND|not found/i.test(l)) ?? lines[0] ?? ''
    const why = parsed ? (parsed.message ?? parsed.code ?? `answered ok=false with no sentence`)
      : `exit ${String(got?.status)} with no readable answer${noise ? `: ${noise.slice(0, 200)}` : ''}`
    return {
      ok: false,
      message: `the new updater refused to register itself: ${why}`,
      parsed,
      argv: [cliPath, 'enable', '--state-dir', stateRoot, '--json'],
    }
  }
  return { ok: true, message: null, parsed, argv: [cliPath, 'enable', '--state-dir', stateRoot, '--json'] }
}

/**
 * Ask launchd the two questions its answer can settle, in one read.
 *
 * · **does the registered job go through the stable entry?** That is the whole §11 mechanism now: the
 *   entry resolves `updaterCli` each time it runs, so once the definition names it, no future version
 *   needs a registration. Anything else in that slot is a machine registered before the entry existed.
 * · **which generation of `runtime/` does it run?** Only worth asking while the first answer is "no":
 *   a pre-entry definition is pinned to one generation by name, and pruning that generation is how
 *   "automatic update is on" quietly becomes `Cannot find module` the next morning.
 *
 * `asked: false` is a different answer from "the job runs no runtime generation", and the difference
 * decides whether disk may be deleted: a job that could not be read is a job that might be about to
 * execute the tree pruning would remove. Skipping the cleanup costs a version directory; guessing
 * costs the daily job.
 */
function jobState({ stateRoot, readRunningJob: reader, agentLabel, entryPath }) {
  const nothing = (reason) => ({ asked: false, gen: null, namesEntry: false, args: [], reason })
  if (typeof reader !== 'function') return nothing('no launchd reader was given, so the registered job was never asked what it runs')
  let loaded = null
  try {
    loaded = reader({ label: agentLabel })
  } catch (error) {
    return nothing(`launchctl print ${agentLabel} threw (${error?.message ?? String(error)})`)
  }
  if (!loaded || loaded.unknown === true) return nothing(loaded?.reason ?? 'the loaded job answered nothing at all')
  const args = Array.isArray(loaded.args) ? loaded.args.map(String) : []
  const namesEntry = Boolean(entryPath) && args.some((arg) => sameRuntimePath(arg, entryPath))
  let gen = null
  for (const arg of args) {
    const found = runtimeVersionOf(arg, runtimeRoot(stateRoot))
    if (found) gen = found
  }
  return {
    asked: true,
    gen,
    namesEntry,
    args,
    reason: namesEntry
      ? null
      : `the loaded job names (${args.slice(0, 4).join(' ') || 'no arguments were read'}) and not the stable entry ${entryPath ?? '(none)'}`,
  }
}
/**
 * The §11 sequence, as one function returning the record for the state file.
 *
 * @returns {{record: object, restored: object}} `record.status` is `refreshed` (new copy runs and the
 *          loaded job names it), `kept` (code and pointer moved, no registration because this machine is
 *          switched off for automatic updates), `failed` (with the pointer and job put back), or `skipped`
 *          (a scheduled run that left the job on its own versioned path — the one-time migration onto the
 *          stable entry, which no later version asks for again).
 */
export async function refreshRuntime({
  stateRoot,
  version,
  sourceTree,
  env = process.env,
  disabled = false,
  homeDir = null,
  label = AGENT_LABEL,
  readPointerImpl = readPointer,
  writePointerImpl = writePointer,
  materialize = materializeRuntime,
  prune = pruneRuntime,
  runEnable = defaultRunEnable,
  ensureEntry = ensureAgentEntry,
  readRunningJob = null,
  // `handover: 'now'` hands the launchd job over during this run — only safe when a person asked for
  // it (the panel, a terminal). `handover: 'defer'` moves the code and the pointer and stops there,
  // because a scheduled apply *is* the job being handed over: `bootout` inside it can take the job down
  // between the swap and the state write. (Unrelated to this parameter: `now`, the clock.)
  handover = 'now',
  now = () => new Date(),
} = {}) {
  const at = now().toISOString()
  const previous = readPointerImpl(stateRoot)
  const previousCli = previous.ok ? previous.pointer.updaterCli : null
  const previousRoot = previous.ok ? previous.pointer.installRoot : null
  const agentLabel = (previous.ok && previous.pointer.agentLabel) || label
  if (previous.ok && agentLabel !== AGENT_LABEL) {
    // The pointer is a file another process wrote, and this label is the one this run is about to hand
    // to `launchctl print` — and, in the next release that reads it for registration, to `bootout`.
    // The reader here is harmless, but a record that verified somebody else's job would be a lie, and
    // the §2 rule "the update agent is the only job this subsystem ever touches" has to be enforced
    // where the value enters rather than assumed. So a label that is not this project's own is refused
    // before anything is copied, and the sentence names the remedy.
    return {
      record: {
        status: 'failed',
        version: null,
        cliPath: null,
        previousCliPath: previousCli,
        agentVerified: null,
        at,
        code: CODES.agentPathUnsafe,
        detail: `the installer pointer at ${stateRoot} registers the update agent under ${JSON.stringify(agentLabel)}, which is not this project's own label ${JSON.stringify(AGENT_LABEL)}: nothing was copied or re-registered, and re-running the GlassPane installer is what puts the pointer back`,
      },
      restored: { attempted: false, ok: true },
    }
  }

  if (!previous.ok) {
    // There is no authority to move. Saying so is better than inventing one: a machine whose pointer is
    // broken needs the installer, and writing a pointer here would hide that behind a fresh path.
    return {
      record: {
        status: 'failed',
        version: null,
        cliPath: null,
        previousCliPath: previousCli,
        agentVerified: null,
        at,
        code: previous.code ?? CODES.runtimeStale,
        detail: previous.message,
      },
      restored: { attempted: false, ok: true },
    }
  }

  // The stable entry first, before anything that can be seen from outside. It is the path the launchd
  // definition names, and it resolves the pointer when it runs, so once it is in place a version move
  // needs no registration at all. Installing it cannot be deferred past the pointer flip: a pointer
  // the entry cannot read is a daily job that answers "the pointer names nothing on disk" instead of
  // doing the update.
  const entry = ensureEntry({ stateRoot })
  if (!entry.ok) {
    return {
      record: {
        status: 'failed',
        version: null,
        cliPath: null,
        previousCliPath: previousCli,
        agentVerified: null,
        at,
        code: entry.code ?? CODES.stateWriteUnverified,
        detail: entry.message,
      },
      restored: { attempted: false, ok: true },
    }
  }

  const copied = materialize({ stateRoot, sourceTree, version })
  if (!copied.ok) {
    return {
      record: {
        status: 'failed',
        version: null,
        cliPath: null,
        previousCliPath: previousCli,
        agentVerified: null,
        at,
        code: copied.code ?? CODES.runtimeStale,
        detail: copied.message,
      },
      restored: { attempted: false, ok: true },
    }
  }

  try {
    writePointerImpl(stateRoot, { updaterCli: copied.cliPath, installRoot: copied.treePath, agentLabel }, { now: now() })
  } catch (error) {
    return {
      record: {
        status: 'failed',
        version: null,
        cliPath: copied.cliPath,
        previousCliPath: previousCli,
        agentVerified: null,
        at,
        code: CODES.stateWriteUnverified,
        detail: `the new release tree is on disk (${copied.treePath}) but the pointer could not be rewritten (${error?.message ?? String(error)}): the previous updater still runs`,
      },
      restored: { attempted: false, ok: true },
    }
  }

  const root = runtimeRoot(stateRoot)
  /**
   * Which generations of `runtime/` may not be deleted.
   *
   * With the stable entry in place, the registered job names *no* generation — it names the entry, and
   * the entry resolves the pointer every time it runs. So the list is the pointer this run wrote plus the
   * value it replaced, and the third author (the generation in the book) only exists on a machine whose
   * definition still predates the entry. That is precisely the window where pruning by pointer alone
   * would delete the tree launchd is about to execute, so the job's own generation is pinned while it
   * lasts — and when the book cannot be read at all, nothing is pruned. Skipping the cleanup costs a
   * version directory; guessing costs the daily job.
   */
  const prunePinned = ({ job, dropNew = false }) => {
    if (job.asked !== true) {
      return { removed: [], failed: [], skipped: `nothing was pruned: ${job.reason}` }
    }
    const keep = [
      ...(dropNew ? [] : [String(version)]),
      runtimeVersionOf(previousCli, root),
      job.gen,
    ].filter(Boolean)
    return prune({ stateRoot, keep })
  }

  const failAndRestore = (detail, { agentVerified = false, code = CODES.runtimeStale } = {}) => {
    const restore = { attempted: true, ok: false, message: null, reEnable: null, pruned: null }
    try {
      // `registeredAt` is carried over rather than left out: `writePointer` stamps the current instant
      // when a field is absent, and a rollback that re-dates the installer's registration would tell a
      // reader this machine was installed just now — which is the opposite of what happened.
      writePointerImpl(stateRoot, { updaterCli: previousCli, installRoot: previousRoot, agentLabel, registeredAt: previous.pointer.registeredAt }, { now: now() })
      restore.ok = true
    } catch (error) {
      restore.message = `putting the pointer back failed too (${error?.message ?? String(error)})`
    }
    /**
     * Whether the job has to be handed back by hand depends on what it names. A job that goes through
     * the entry needs nothing: the pointer is back on the previous copy, so the entry will resolve that
     * copy tomorrow by itself — that is the whole point of the indirection, and it is why this path no
     * longer spawns an `enable` the way the pre-entry shape had to. Anything else re-registers through
     * the previous copy, and that includes a book this run could not read at all: not knowing what is
     * loaded is not evidence that it goes through the entry, so the conservative restore is the one
     * that puts the definition back in the previous copy's hands.
     */
    const after = book()
    if (restore.ok && !after.namesEntry && previousCli && fs.existsSync(previousCli)) {
      const back = runEnable({ cliPath: previousCli, stateRoot, env })
      restore.reEnable = back.ok ? 'the job was re-registered by the previous updater' : `re-registering with the previous updater failed: ${back.message}`
    } else if (restore.ok && after.namesEntry) {
      restore.reEnable = 'the loaded job goes through the stable entry, so the pointer being back is what decides what runs next'
    }
    // The generation this run failed to install may be dropped only once the book has been read: until
    // launchd answers, the new directory is the tree a job might still execute. `asked: true` with no
    // generation is a *good* answer (the job goes through the entry, or names a clone outside
    // `runtime/`), so that case prunes; only a book that never replied at all refuses the cleanup.
    if (after.asked === true) {
      restore.pruned = prune({ stateRoot, keep: [after.gen, runtimeVersionOf(previousCli, root)].filter(Boolean) })
    } else {
      restore.pruned = { removed: [], failed: [], skipped: `nothing was pruned: ${after.reason}` }
    }
    return {
      record: {
        status: 'failed',
        version: String(version),
        cliPath: copied.cliPath,
        previousCliPath: previousCli,
        agentVerified,
        at,
        code,
        detail: `${detail}${restore.ok ? '' : `; ${restore.message}`}${restore.reEnable ? `; ${restore.reEnable}` : ''}${restore.pruned.skipped ? `; ${restore.pruned.skipped}` : ''}`,
      },
      restored: restore,
      pruned: restore.pruned,
    }
  }

  const book = () => jobState({ stateRoot, readRunningJob, agentLabel, entryPath: entry.path })

  // A machine that turned automatic updates off must not get a new job. Its *code* still moves, because
  // the settings panel runs whatever the pointer names, and leaving it on the old copy would be a second,
  // silent way of not shipping a fix.
  if (disabled) {
    const pruned = prunePinned({ job: book() })
    return {
      record: {
        status: 'kept',
        version: String(version),
        cliPath: copied.cliPath,
        previousCliPath: previousCli,
        agentVerified: false,
        at,
        code: CODES.autoDisabled,
        detail: `automatic update is switched off on this machine, so no launchd job was registered; the updater code and pointer moved to ${copied.cliPath}${pruneNote(pruned)}, and the entry at ${entry.path} is in place for whenever it is switched back on`,
      },
      restored: { attempted: false, ok: true },
      pruned,
    }
  }

  /**
   * The success record. `job` is the read-back that proves the registered definition goes through the
   * entry; `agentVerified` says exactly that, and nothing more — it is no longer a claim about which
   * version launchd holds, because with the entry the version is the pointer's business (and the pointer
   * was verified by `writePointer`'s own read-back).
   */
  const finishRefreshed = (job) => {
    const pruned = prunePinned({ job: { ...job, gen: job.gen ?? runtimeVersionOf(copied.cliPath, root) } })
    return {
      record: {
        status: 'refreshed',
        version: String(version),
        cliPath: copied.cliPath,
        previousCliPath: previousCli,
        agentVerified: true,
        at,
        code: null,
        detail: pruned.failed.length
          ? `pruned ${pruned.removed.join(', ') || 'nothing'}; ${pruned.failed.map((f) => `${f.version}: ${f.message}`).join('; ')}`
          : pruned.skipped ?? null,
      },
      restored: { attempted: false, ok: true },
      pruned,
    }
  }

  const registered = book()
  if (registered.namesEntry) {
    // The definition already goes through the entry, so this run is done: what the next scheduled run
    // executes is decided by the pointer it just wrote. No bootout, no bootstrap, no child process —
    // the step that used to be this section's most dangerous one is now a file write.
    return finishRefreshed(registered)
  }

  // The job names something else: a machine whose definition was registered before the entry existed, or
  // no definition at all. That needs exactly one registration through the entry, and it is the last
  // time any version of this updater will ask for one.
  if (handover === 'defer') {
    const pruned = prunePinned({ job: registered })
    return {
      record: {
        // `skipped`, not `kept`: this machine *is* set to update automatically — the registration is
        // what this run deliberately did not do, because doing it here would unregister the job we are
        // running inside of. Unlike the pre-entry shape, this is a one-time migration rather than a cost
        // on every version, and the sentence has to say so or a reader will keep looking for the next one.
        status: 'skipped',
        version: String(version),
        cliPath: copied.cliPath,
        previousCliPath: previousCli,
        agentVerified: false,
        at,
        code: CODES.runtimeRegistrationPending,
        detail: `the updater code, the pointer, and the stable entry are all in place, but the registered job still names its own path instead of ${entry.path}, and this run was the scheduled one — re-registering from inside it would tear the job down mid-run. Flip "automatic update" off and on once (or run "updater enable") to move the definition onto the entry; after that single step, no future version needs it${pruneNote(pruned)}.`,
      },
      restored: { attempted: false, ok: true },
      pruned,
    }
  }

  const migrated = runEnable({ cliPath: copied.cliPath, stateRoot, env })
  if (!migrated.ok) return failAndRestore(`registering the stable entry with the new copy failed: ${migrated.message}`)
  const afterMigration = book()
  if (!afterMigration.namesEntry) {
    return failAndRestore(`the new copy ran "enable", but the loaded job still does not name the stable entry ${entry.path} (${afterMigration.reason})`)
  }
  return finishRefreshed(afterMigration)
}

/**
 * How a prune that may have been refused is described in a record's own detail. A skipped cleanup is
 * not the same sentence as an empty one: "nothing was pruned because the book never answered" is the
 * fact a reader needs before deciding whether to care about the disk.
 */
function pruneNote(pruned) {
  if (!pruned) return ''
  if (pruned.skipped) return `, and ${pruned.skipped}`
  return pruned.removed.length ? ` (pruned ${pruned.removed.join(', ')})` : ''
}

/** Where the plist would have to be for this home; kept here so a reader can ask the same question. */
export function runtimeAgentPlistPath(homeDir) {
  return agentPlistPath({ homeDir })
}

/**
 * Put the machine back the way the pointer found it, after a rollback that ran *past* a successful
 * handover.
 *
 * `apply`'s post-swap region can still throw after §11 finished — retrying the staging tree,
 * re-exporting the root bundle, or the final state write itself are all between the handover and the
 * return. Its catch restores the two `.app` bundles, and if nothing else moved the authority back the
 * record would say "`1.6.0` restored and verified" while `update-install.json` and the loaded job both
 * name the copy that was supposed to be undone. This function is that missing half: the pointer goes back,
 * and the launchd definition is only re-registered when it actually needs it and this run is allowed to.
 *
 * The caller hands in the pointer it read *before* the handover, because after the flip there is no
 * reading of the pointer that still says what the machine used to be.
 *
 * `handover` is the mode the forward step ran in, and it decides what this function is allowed to do to
 * launchd. Under `'defer'` this run *is* the scheduled job, so registering anything here would `bootout`
 * the process that is rolling the bundles back — the same reason the forward step stopped at the pointer.
 * Such a run puts the pointer back and leaves the definition alone; whether the machine is actually
 * consistent is then decided by the read-back below, not asserted. `disabled` removes the question: a
 * switched-off machine has no job, and re-registering one would undo the user's own switch.
 */
export async function undoHandover({
  stateRoot,
  previousPointer,
  version = null,
  env = process.env,
  runEnable = defaultRunEnable,
  writePointerImpl = writePointer,
  readRunningJob: reader = null,
  handover = 'now',
  disabled = false,
  now = () => new Date(),
} = {}) {
  const at = now().toISOString()
  const cli = previousPointer?.updaterCli ?? null
  const root = previousPointer?.installRoot ?? null
  const record = (extra) => ({
    status: 'failed',
    version: version === null ? null : String(version),
    cliPath: null,
    previousCliPath: cli,
    agentVerified: false,
    at,
    code: CODES.runtimeStale,
    ...extra,
  })
  if (!cli || !root) {
    return {
      ok: false,
      record: record({ detail: 'the updater had been handed over, but the pointer read before the handover named no previous script to go back to, so the pointer was left where it is and a person has to re-run the GlassPane installer' }),
    }
  }
  let pointerBack = null
  try {
    writePointerImpl(stateRoot, { updaterCli: cli, installRoot: root, agentLabel: previousPointer.agentLabel ?? AGENT_LABEL, registeredAt: previousPointer.registeredAt }, { now: now() })
    pointerBack = { ok: true, message: `the pointer is back at ${cli}` }
  } catch (error) {
    pointerBack = { ok: false, message: `the pointer could not be put back at ${cli} (${error?.message ?? String(error)})` }
  }
  // A machine whose owner switched automatic update off has no job to hand back, and `enable` is the one
  // call that would give it one — turning the user's switch back on behind a record that is talking about a
  // rollback. The pointer still goes back, because the settings panel runs whatever it names.
  if (disabled) {
    return {
      ok: pointerBack.ok,
      record: record({
        detail: `the apply was rolled back after the updater had already been handed over: ${pointerBack.message}; automatic update is switched off on this machine, so no job was registered and none needed handing back`,
      }),
    }
  }
  // Does the registered definition go through the stable entry? If so, putting the pointer back *is*
  // handing the job back: the entry resolves `updaterCli` every time it runs, so tomorrow's run picks up
  // the restored path with no launchd call and no child process. Only a pre-entry definition — one that
  // carries a versioned path in its own text, or a book that would not answer — still needs the old copy
  // to re-register itself, and only a run that a person asked for may make that call.
  const entryFile = (() => { try { return agentEntryPath(stateRoot) } catch { return null } })()
  const book = jobState({ stateRoot, readRunningJob: reader, agentLabel: previousPointer.agentLabel ?? AGENT_LABEL, entryPath: entryFile })
  let reEnable = null
  if (book.namesEntry) {
    reEnable = { ok: true, message: 'the loaded job goes through the stable entry, so the pointer being back is what decides what runs next' }
  } else if (handover === 'defer') {
    reEnable = {
      ok: true,
      message: `this run is the scheduled job, so nothing was re-registered — a registration here would unregister the process rolling the bundles back. The definition keeps the path it already named${book.gen ? ` (generation ${book.gen})` : ''}, and the read-back below is what says whether that is the copy the pointer went back to`,
    }
  } else if (fs.existsSync(cli)) {
    const back = runEnable({ cliPath: cli, stateRoot, env })
    reEnable = back.ok
      ? { ok: true, message: 'the previous updater re-registered the job' }
      : { ok: false, message: `re-registering with the previous updater failed: ${back.message}` }
  } else {
    reEnable = { ok: false, message: `${cli} is not on disk, so the job could not be handed back` }
  }
  // Same §11.6 rule as the forward path: the book is the only proof, and a job that could not be read
  // is not a job that was restored.
  let loaded = null
  if (typeof reader === 'function') {
    try {
      loaded = reader({ label: previousPointer.agentLabel ?? AGENT_LABEL })
    } catch (error) {
      loaded = { unknown: true, reason: `launchctl print failed (${error?.message ?? String(error)})` }
    }
  }
  const args = Array.isArray(loaded?.args) ? loaded.args.map(String) : []
  const verified = book.namesEntry ? true : loaded && loaded.unknown !== true ? args.some((arg) => sameRuntimePath(arg, cli)) : null
  const detail = `the apply was rolled back after the updater had already been handed over: ${pointerBack.message}; ${reEnable.message}${verified === null ? '; the loaded job was not read back, so this run cannot show which command line launchd holds' : verified ? `; the loaded job names ${cli}` : `; the loaded job still names (${args.slice(0, 6).join(' ') || 'no arguments read back'})`}`
  return {
    ok: pointerBack.ok && reEnable.ok && verified !== false,
    record: record({ detail, agentVerified: verified === true }),
  }
}
