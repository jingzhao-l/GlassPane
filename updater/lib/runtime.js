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
  removeTreeWithin,
  resolveWithin,
  tightenMode,
  writableRoots,
} from './fsutil.js'
import { AGENT_LABEL, agentPlistPath } from './launchd.js'
import { readPointer, writePointer } from './state.js'

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

function defaultCopyTree(source, target) {
  fs.cpSync(source, target, { recursive: true, dereference: false })
}

/**
 * Copy the verified release tree into a fresh version directory and return its CLI path.
 *
 * The copy goes to a `.<version>.new-<pid>` sibling first and is renamed into place only after
 * `updater/cli.js` has been read back as a non-empty file: a directory that exists is not a tree that
 * works, and a rename within one directory is the only step here that is atomic.
 */
export function materializeRuntime({ stateRoot, sourceTree, version, copy = defaultCopyTree, exists = (p) => fs.existsSync(p) }) {
  const root = runtimeRoot(stateRoot)
  ensurePrivateDir(root)
  const target = runtimeTreePath(stateRoot, version)
  if (exists(target)) {
    // A previous attempt already landed this version. Re-use it rather than deleting a tree that
    // something may be executing from; the caller still verifies the CLI path below.
    const cli = runtimeCliPath(target)
    if (!exists(cli)) {
      return { ok: false, code: CODES.stateWriteUnverified, message: `${target} exists but carries no ${cli}`, treePath: target, cliPath: null }
    }
    return { ok: true, treePath: target, cliPath: cli, reused: true }
  }
  const temp = path.join(root, `.${version}.new-${process.pid}`)
  let landed = false
  let result = null
  try {
    copy(sourceTree, temp)
    const cli = runtimeCliPath(temp)
    let size = 0
    try {
      size = fs.statSync(cli).size
    } catch {
      size = 0
    }
    if (size === 0) {
      result = {
        ok: false,
        code: CODES.stateWriteUnverified,
        message: `the copied tree ${temp} has no readable updater/cli.js (size ${size}); nothing was installed from it`,
        treePath: null,
        cliPath: null,
      }
    } else {
      fs.renameSync(temp, target)
      landed = true
      ensurePrivateDir(target)
      // The pointer is the only thing that decides who runs next, so the copy is only "the runtime"
      // once the mode on the version directory itself says it is private.
      tightenMode(target, 0o700, 'runtime directory')
      result = { ok: true, treePath: target, cliPath: runtimeCliPath(target), reused: false }
    }
  } catch (error) {
    result = {
      ok: false,
      code: CODES.stateWriteUnverified,
      message: `copying the verified release tree into the runtime root failed (${error?.message ?? String(error)})`,
      treePath: null,
      cliPath: null,
    }
  } finally {
    // Every failure path removes the half-copied tree — including "copied but no entry point", which
    // used to return straight through the `catch` and leave a ~73 MB partial release sitting in the
    // runtime root as a hidden directory. A refused install must not cost disk. A cleanup that itself
    // fails is appended to the refusal instead of being swallowed: that leftover needs naming.
    if (!landed && fs.existsSync(temp)) {
      try {
        removeTreeWithin(root, temp)
      } catch (cleanupError) {
        result.message += `; and the half-copied ${temp} could not be removed (${cleanupError?.message ?? String(cleanupError)})`
      }
    }
  }
  return result
}

/** Which generation of the runtime root a CLI path belongs to, or null when it is not one (a clone). */
export function runtimeVersionOf(cliPath, runtimeDir) {
  const text = String(cliPath ?? '')
  if (!text.startsWith(runtimeDir + path.sep)) return null
  const first = text.slice(runtimeDir.length + 1).split(path.sep)[0]
  return VERSION_RE.test(first) ? first : null
}

/**
 * Prune the runtime root down to the generations that are still **pointed at**, and say what was
 * removed. `keep` is a list, not one version, because three things can name one: the new pointer,
 * the previous pointer value, and — when the handover was deferred — the generation the *loaded job*
 * still runs. Deleting what a launchd definition points at is how "automatic update is on" quietly
 * becomes `Cannot find module` the next morning. Pruning is a convenience: a failure here is
 * reported and never turned into "cleaned".
 */
export function pruneRuntime({ stateRoot, keep = [], limit = RUNTIME_KEEP }) {
  const root = runtimeRoot(stateRoot)
  if (!fs.existsSync(root)) return { removed: [], failed: [] }
  const versions = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()
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
 * The §11 sequence, as one function returning the record for the state file.
 *
 * @returns {{record: object, restored: object}} `record.status` is `refreshed` (new copy runs and the
 *          loaded job names it), `kept` (code and pointer moved, no registration because this machine is
 *          switched off for automatic updates), `failed` (with the pointer and job put back), or `skipped`
 *          (a scheduled run that left the handover to the next `enable`).
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

  // A machine that turned automatic updates off must not get a new job. Its *code* still moves, because
  // the settings panel runs whatever the pointer names, and leaving it on the old copy would be a second,
  // silent way of not shipping a fix.
  if (handover === 'defer') {
    // The job is still the old one, so its generation is pinned too: pruning it here would leave the
    // launchd definition pointing at a directory that no longer exists.
    const pruned = prune({ stateRoot, keep: [version, runtimeVersionOf(previousCli, runtimeRoot(stateRoot))] })
    return {
      record: {
        // `skipped`, not `kept`: this machine *is* set to update automatically — the handover is what
        // this particular run deliberately did not do, because doing it here would unregister the job
        // we are running inside of. (`kept` stays reserved for the machine that switched it off.)
        status: 'skipped',
        version: String(version),
        cliPath: copied.cliPath,
        previousCliPath: previousCli,
        agentVerified: false,
        at,
        code: CODES.runtimeRegistrationPending,
        detail: `this run was the scheduled one, so the launchd job was not re-registered from inside itself; the updater code and pointer moved to ${copied.cliPath}${pruned.removed.length ? ` (pruned ${pruned.removed.join(', ')})` : ''}, and the job takes it over the next time "updater enable" runs (the panel's switch off and on does exactly that)`,
      },
      restored: { attempted: false, ok: true },
      pruned,
    }
  }

  if (disabled) {
    const pruned = prune({ stateRoot, keep: [version, runtimeVersionOf(previousCli, runtimeRoot(stateRoot))] })
    return {
      record: {
        status: 'kept',
        version: String(version),
        cliPath: copied.cliPath,
        previousCliPath: previousCli,
        agentVerified: false,
        at,
        code: CODES.autoDisabled,
        detail: `automatic update is switched off on this machine, so no launchd job was registered; the updater code and pointer moved to ${copied.cliPath}${pruned.removed.length ? ` (pruned ${pruned.removed.join(', ')})` : ''}`,
      },
      restored: { attempted: false, ok: true },
      pruned,
    }
  }

  const failAndRestore = (detail, { agentVerified = false, code = CODES.runtimeStale } = {}) => {
    const restore = { attempted: true, ok: false, message: null, reEnable: null }
    try {
      writePointerImpl(stateRoot, { updaterCli: previousCli, installRoot: previousRoot, agentLabel }, { now: now() })
      restore.ok = true
    } catch (error) {
      restore.message = `putting the pointer back failed too (${error?.message ?? String(error)})`
    }
    if (restore.ok && previousCli && fs.existsSync(previousCli)) {
      const back = runEnable({ cliPath: previousCli, stateRoot, env })
      restore.reEnable = back.ok ? 'the job was re-registered by the previous updater' : `re-registering with the previous updater failed: ${back.message}`
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
        detail: `${detail}${restore.ok ? '' : `; ${restore.message}`}${restore.reEnable ? `; ${restore.reEnable}` : ''}`,
      },
      restored: restore,
    }
  }

  const enabled = runEnable({ cliPath: copied.cliPath, stateRoot, env })
  if (!enabled.ok) return failAndRestore(enabled.message)

  // §11.6: the loaded job is the only proof that the registration took. Read it back and require the new
  // path to be the one launchd has; "unknown" is a failure we say out loud, not a default.
  let loaded = null
  if (typeof readRunningJob === 'function') {
    try {
      loaded = readRunningJob({ label: agentLabel })
    } catch (error) {
      loaded = { unknown: true, reason: `launchctl print failed (${error?.message ?? String(error)})` }
    }
  }
  if (!loaded || loaded.unknown) {
    return failAndRestore(`the new updater registered itself but the loaded job could not be read back (${loaded?.reason ?? 'no reader'}), so it is not claimed that the new copy runs`)
  }
  const args = Array.isArray(loaded.args) ? loaded.args.map(String) : []
  const namesNew = args.some((arg) => canonicalPath(arg) === canonicalPath(copied.cliPath))
  if (!namesNew) {
    return failAndRestore(`the loaded job still names the old command line (${args.slice(0, 6).join(' ') || 'no arguments read back'}), so the swap did not take effect`)
  }

  const pruned = prune({ stateRoot, keep: version })
  return {
    record: {
      status: 'refreshed',
      version: String(version),
      cliPath: copied.cliPath,
      previousCliPath: previousCli,
      agentVerified: true,
      at,
      code: null,
      detail: pruned.failed.length ? `pruned ${pruned.removed.join(', ') || 'nothing'}; ${pruned.failed.map((f) => `${f.version}: ${f.message}`).join('; ')}` : null,
    },
    restored: { attempted: false, ok: true },
    pruned,
  }
}

/** Where the plist would have to be for this home; kept here so a reader can ask the same question. */
export function runtimeAgentPlistPath(homeDir) {
  return agentPlistPath({ homeDir })
}
