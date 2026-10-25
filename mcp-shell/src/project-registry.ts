import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import {
  GP_E_BAD_PARAMS,
  GP_E_INTERNAL,
  GP_E_NOT_FOUND,
  GP_E_NO_USER_RECORD,
  GP_E_PROJECT_LIMIT,
  GP_E_REGISTRY_DRIFT,
  GP_E_STATE_ROOT_REFUSED,
  quoteShellArg,
} from "./errors.js";
import { daemonUnreachableRemedy } from "./engine-client.js";

/* ------------------------------------------------------------------ *
 * Project Registry — MCP-layer access (P1 spec v1.4 §4)
 *
 * This module operates directly on the shared projects.json file.
 * The daemon's Swift ProjectRegistry writes this file; the MCP shell
 * reads/writes the same file with mirrored validation constraints.
 * No socket methods are added (spec 变更说明: "不改变 socket 协议方法表").
 *
 * Three properties this file is responsible for:
 * - Trust boundary: the three path fields below are the ONLY place an agent
 *   can name a directory the daemon will later write into and prune files
 *   out of, so they are validated here rather than trusted downstream.
 * - Honest failure: an unreadable/unusable projects.json is reported, never
 *   folded into "0 projects" and then overwritten.
 * - Honest success: a write is reported together with the fact that the
 *   running daemon has not loaded it yet (see `ProjectSetResult`).
 * ------------------------------------------------------------------ */

const CROCKFORD_BODY_RE = "[0-9A-HJKMNP-TV-Z]{26}";
const PROJECT_ID_RE = new RegExp(`^prj_${CROCKFORD_BODY_RE}$`);

/**
 * The registry's ceiling, and the number a `GP_E_PROJECT_LIMIT` reply states.
 * Exported because `tools.ts` quotes it back to the agent in that code's remedy,
 * and a limit nobody can name is a limit nobody can act around. The daemon keeps
 * its own copy at `ProjectModels.ProjectEntry.maxProjects`; `test/tools.test.mjs`
 * reads that literal out of the Swift source and fails if the two numbers differ,
 * so neither side can move the ceiling without the other going red.
 */
export const MAX_PROJECTS = 128;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_FIELD_LENGTH = 1024;

/**
 * The `bundleId` ceiling — one number for both surfaces that carry the identity.
 *
 * It is the daemon's own bound, not this shell's preference: `Dispatcher.handleAttach`
 * reads `bundleId` with `maxLength: 512`, and `test/consumer-consistency.test.mjs` re-reads
 * that literal from the Swift source and fails if either side of the pair moves. The
 * registry stores *the same* identity an attach is matched by and the daemon's registry path
 * applies no length rule of its own, so a second, stricter cap on the storing half was not a
 * safety margin — a 300-character bundleId was attachable and permanently unregisterable,
 * refused by this shell with a `GP_E_BAD_PARAMS` the service would never have issued.
 * Both `gp_attach`'s and `gp_project_set`'s advertised schemas and this module's patch-shaped
 * zod take the number from here, so "one rule, two answers" is a compile-time impossibility
 * rather than a thing to remember.
 */
export const BUNDLE_ID_MAX_LENGTH = 512;

/**
 * `pid` is stored as Swift `Int32?` (ProjectModels.ProjectEntry) and narrowed
 * to `pid_t` by the daemon's attach path. The upper bound is therefore not
 * cosmetic: one out-of-range number makes JSONDecoder reject the *whole*
 * projects.json, which is how a single bad write would silently blank every
 * registration. The bounds mirror the attach contract (ParamValidation.pidLower
 * / pidUpper); pid 0 is not a process.
 */
const PID_RANGE: readonly [number, number] = [1, 2_147_483_647];

/** Fields that name a directory the daemon writes into and prunes out of. */
const PATH_FIELDS = [
  "recipeConfigPath",
  "calibrationAssetsPath",
  "evidenceStoragePath",
] as const;
type PathField = (typeof PATH_FIELDS)[number];

/** Paths that may never be a storage root, matched exactly after resolution. */
const PROTECTED_ROOTS: readonly string[] = [
  "/", "/Applications", "/System", "/Library", "/Users", "/private", "/tmp", "/Volumes",
];

/**
 * Trees owned by the system/other installs: nothing here is project data.
 *
 * The list is the **union** of what this file and the daemon each refused, and
 * it is pinned against the Swift side by `test/path-consistency.test.mjs`
 * rather than kept in sync by hope (J). Two halves of the divergence this
 * closes:
 * - `/usr`, `/bin`, `/sbin`, `/dev` were rejected by name only on the daemon
 *   side; here they survived unless their *owner* happened to be root, so the
 *   same registered value produced a refusal from one process and an acceptance
 *   from the other — and the accepting one is the one that writes projects.json.
 * - `/tmp` matched exactly, so `/tmp/x` fell through to the ownership rule and
 *   passed for a caller-owned scratch directory, while the daemon called the
 *   same path shared scratch. Shared scratch is world-writable by definition:
 *   a registry pointing there is readable-by-everyone evidence, whatever the
 *   directory's own mode says on the day it is checked.
 *
 * What that pinning covers, and what it now says in the present tense because the code
 * moved under it: the guard reads the daemon's *names* and its *matcher*, and the two
 * agree. These entries are matched as subtrees on both sides — `/private/tmp/x` is
 * refused here (`refuseCandidate` walks `PROTECTED_SUBTREES` through `isInside`, which is
 * "equal to the tree, or prefixed by `<tree>/`") and refused there
 * (`EngineCore.resolvedStoragePathDefect` loops `sharedScratchStoragePaths` with
 * `stripped == scratch || stripped.hasPrefix(scratch + "/")`). The daemon's half used to
 * be a whole-path equality test, and that was the divergence this header registered as
 * open; round 4 closed it in Swift and the prose stayed behind, still reading as a split
 * someone ought to fix — which is how one already-fixed side gets "fixed" a second time.
 * The guards that keep this paragraph true are `test/path-consistency.test.mjs` (whose
 * input-level entries pin this file's subtree behaviour and whose own assertions re-read
 * the Swift matcher from source, reddening if the equality form comes back) and
 * `test/qoder-20261019-matcher-parity.test.mjs`, which compares the two sides' names and
 * matchers as the one rule they are meant to be.
 */
const PROTECTED_SUBTREES: readonly string[] = [
  "/Applications", "/System", "/Library", "/private/etc",
  "/usr", "/bin", "/sbin", "/dev",
  "/tmp", "/private/tmp", "/private/var/tmp",
];

/**
 * The two lists, exported **only** so `test/path-consistency.test.mjs` can
 * compare them against the daemon's own literals in
 * `engine/Sources/GlassPaneEngine/EngineCore.swift`. Nothing in this module
 * reads them through here; they stay `const` and internal to the write path.
 * A second language implementing the same rule is a drift waiting to happen, and
 * the only honest guard is one that reads the other side's source.
 */
export const AGENT_PATH_PROTECTION = {
  roots: PROTECTED_ROOTS,
  subtrees: PROTECTED_SUBTREES,
} as const;

/**
 * The user's home directory, by **the same lookup the daemon uses**, and the
 * only place in this module that resolves it. Both consumers here have to agree
 * with a *second process*, which is why this is not a matter of taste:
 *
 * - `os.homedir()` reads `$HOME` — a caller-controlled variable.
 * - `os.userInfo().homedir` reads the user record (passwd), which is what
 *   `NSHomeDirectory()` does, which is what `StateRoot.homeDefault()` =
 *   `NSHomeDirectory() + "/.glasspane"` is built from, which is what
 *   `ProjectRegistry.defaultProjectsPath` = `StateRoot.homeDefault().projectsFile`
 *   publishes to the daemon.
 *
 * Measured, on this machine, with `$HOME` pointed somewhere else:
 *
 * ```
 * HOME=/tmp/fake-sbx-home node -e 'const os=require("os");
 *   console.log(os.homedir(), "|", os.userInfo().homedir)'
 * -> /tmp/fake-sbx-home | /Users/<account>
 * ```
 *
 * (`/Users/<account>` stands for the home the *password record* holds for whoever
 * runs it. It is written as a placeholder on purpose: this file ships inside
 * `dist/*.d.ts` and the release archive, and `scripts/make-release-archive.mjs`
 * states the rule for what may travel there — "a release archive should not be the
 * delivery mechanism for whoever built it".)
 *
 * So `os.homedir()` and `NSHomeDirectory()` resolve **different directories** as
 * soon as a caller exports `HOME` — an agent sandbox doing that is the ordinary
 * case, not the exotic one. `StateRoot.swift`'s own header records what the
 * `$HOME` assumption cost once already (a `swift test` run that rewrote the
 * developer's real `projects.json` while every path in the suite looked
 * sandboxed), and the answer there was to stop reading the variable. This is the
 * same decision taken from the Node side: never infer the home from `$HOME`,
 * ask the record.
 *
 * When there is no record to ask, refuse rather than fall back. `os.homedir()`
 * is not the fallback here — that would reopen exactly the split this function
 * exists to close, silently. The posture matches {@link refuseUnownedTree},
 * which refuses when there is no uid to compare instead of assuming one
 * ("Refuse, never assume"). Unreachable on macOS for a GUI/launchd process: the
 * effective uid always has a record; a container running as a uid absent from
 * its passwd database is where this branch would fire.
 *
 * Pinned against the Swift side by `test/path-consistency.test.mjs`, which bans
 * `os.homedir(` in this file outright, so a third consumer cannot be written
 * against the wrong lookup later.
 */
function systemHome(): string {
  try {
    return os.userInfo().homedir;
  } catch (error) {
    throw new ProjectRegistryError(
      // Not GP_E_INTERNAL: `tools.ts` maps that code to "the projects file is
      // damaged, go read it", and for this failure there is no damaged file —
      // the process has no user record to derive a path from (R8b).
      GP_E_NO_USER_RECORD,
      "cannot read the user record this shell's home directory comes from " +
      `(${describeError(error)}). The background service derives its state root the same way ` +
      "(NSHomeDirectory(), not $HOME), so there is no value here to fall back to: guessing from " +
      "$HOME would name a projects.json the daemon does not load and would let the " +
      "home-directory protection guard the wrong tree. Run this shell as a user that has an " +
      "entry in the password database.",
    );
  }
}

/**
 * Why a root the daemon reported about itself cannot be handed to this module, or
 * `null` when it can.
 *
 * The daemon resolves `--state-dir` and then sweeps the root it named
 * (`StateRoot.tightenPermissions`), so it refuses **at the argument** the two shapes
 * that would make that sweep a disaster: the filesystem root and the account's home
 * directory itself (`StateRoot.notADedicatedRoot`, `StateRoot.swift`). This shell does
 * the same sweep for the same reason — {@link saveProjects} runs
 * `mkdirSync(dir, {recursive:true, mode:0700})` plus a verified `chmod(dir, 0700)` on
 * whatever directory its path resolves to — and until now it did it on a root it never
 * classified: `hello.stateRoot` is stored verbatim (`engine-client.ts`'s
 * `reportedRoot = report.stateRoot.trim()`) and passed straight into
 * `projectList`/`projectSet`/`projectGet` (`tools.ts`) as `client.reportedStateRoot`.
 * `engine.sock` has no peer authentication — SECURITY.md states the rule as same uid =
 * full authority — so any process running as this user can answer a `hello` frame, and
 * a reply naming `/Users/<you>` or `/` used to make **this** shell re-permission the
 * account's home directory 0700 and write the registry into it. Refusing a path this
 * install does not own, before the first `stat`/`open`/`mkdir` against it, is the whole
 * fix.
 *
 * The three refusals are the daemon's, in the daemon's order, and nothing more:
 * - not an absolute path (`StateRoot.classify`'s `must be an absolute path`), which
 *   covers a `~`-prefixed value the shell would otherwise have to expand and a relative
 *   one whose meaning moves with the working directory;
 * - the filesystem root;
 * - the home directory itself, from {@link systemHome} — the **password record**, never
 *   `$HOME`, because `StateRoot.swift` deliberately does not consult `$HOME` either and
 *   `test/path-consistency.test.mjs` pins that on both sides. Comparing against
 *   `$HOME` would let an agent sandbox move which tree is protected, the exact split
 *   that function exists to close.
 *
 * Trailing slashes are folded and the APFS firmlink un-mapped first, because that is
 * what `StateRoot(path:)` and {@link refuseCandidate} do with the same strings: a
 * refusal that only catches one spelling is a refusal the next typo walks past, and
 * `/System/Volumes/Data/Users/<you>` *is* the home directory.
 *
 * A root this shell derived for itself ({@link daemonProjectsPath} with no reported
 * value) is not judged here: it is `<passwd home>/.glasspane`, a dedicated root by the
 * daemon's own wording, and the daemon's remedy line recommends exactly that shape.
 */
function stateRootRefusal(raw: string): string | null {
  const normalized = stripFirmlink(foldSlashTerminators(path.posix.normalize(raw)));
  if (!normalized.startsWith("/")) {
    return `is not an absolute path (${raw})`;
  }
  if (normalized === "/") {
    return "is the filesystem root";
  }
  if (normalized === stripFirmlink(path.posix.normalize(systemHome()))) {
    return `is this account's home directory itself (${systemHome()})`;
  }
  return null;
}

/** Drop redundant trailing separators, keeping `/` itself as `/`. */
function foldSlashTerminators(target: string): string {
  let out = target;
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * The one sentence {@link stateRootRefusal} produces, written so that all three of its
 * promises are in the text an agent reads: where the refused value came from (a daemon
 * self-report, not this process's choice), what this shell would have done with it
 * (create and re-permission it), and what actually happened (nothing).
 *
 * No silent fallback to the home default, and that is the load-bearing half: writing a
 * *different* file while reporting success is the incident class this module was created
 * to refuse (see the header above {@link ProjectEntry}), and `daemonRestartNotice`'s
 * whole design — "default", never "the running service's root" — presumes the two are
 * never conflated by an accident like this one.
 *
 * The remedy is the daemon's own shape (`--state-dir <a directory this install owns>`,
 * `StateRoot.notADedicatedRoot`), because the root is the service's configuration; only
 * the daemon can move it, and this shell restarting the service on a root of its own
 * guessing would be the same overreach one level up.
 */
function refusedStateRootMessage(raw: string, defect: string): string {
  // The suggested root is the daemon's own recommendation for the same refusal, and it
  // is derived from {@link systemHome} like every other home here. If there is no record
  // to ask, the *refusal* is still the fact the caller needs, so the suggestion degrades
  // to the shape rather than replacing one refusal with another.
  let suggested: string | null = null;
  try {
    suggested = `${stripFirmlink(path.posix.normalize(systemHome()))}/.glasspane`;
  } catch {
    /* no user record to derive it from: the refusal above is the fact the caller needs */
  }
  return `the background service's self-reported state root ${defect}, so this shell refuses to use it: ${quoteShellArg(raw)}. `
    + "That value is not a choice this process made — it is the `stateRoot` field of the `hello` frame the daemon answered, and "
    + "the engine socket has no peer authentication (SECURITY.md: any process running as this user may answer one), so a reply can "
    + "name a directory this install does not own. `gp_project_*` would have created that directory and re-permissioned it to 0700 "
    + "before writing projects.json into it, which is the daemon's own `--state-dir` guard arriving one step late: "
    + "`StateRoot.notADedicatedRoot` rejects the same two shapes at the argument precisely so that nothing is ever touched. "
    + "This shell will not create or re-permission that path, and it will NOT quietly fall back to the home default instead — "
    + "writing a different file while reporting success is the failure this registry refuses by design. "
    + "Nothing was read and nothing was written: no directory was created, no permission was changed, no projects.json was opened, "
    + "listed or saved. Move the service onto a directory this install owns: start it as "
    + (suggested === null
      ? "`glasspaned --state-dir <a directory this install owns>` "
      : `\`glasspaned --state-dir <a directory this install owns>\` (the daemon's own suggested form is \`glasspaned --state-dir ${quoteShellArg(suggested)}\`) `)
    + `then reconnect so a fresh hello reports the new root, and repeat the call. If the reported root is not one you configured, treat the `
    + "answer to that handshake as untrusted: another process on this account replied to it.";
}

/**
 * The file the daemon reads **when it was started with no state root of its
 * own** — `ProjectRegistry.defaultProjectsPath` =
 * `StateRoot.homeDefault().projectsFile` in Swift, which is what this function
 * mirrors, home record included.
 *
 * It is the *default*, not the only root, and the distinction is load-bearing:
 * `glasspaned --state-dir <path>` (parsed at `glasspaned/main.swift`, resolved
 * through `StateRoot(path:)`) makes the service load `<path>/projects.json`
 * instead — `ProjectRegistry(stateRoot:)` is the route every subcommand takes, so
 * no command honours the flag and misses it. The shell can read that root: since
 * 1.15.0 the daemon names it in `hello`'s `stateRoot`, and
 * {@link daemonProjectsPath} takes that value — falling back to the home default
 * only when no handshake answered, which is said as "default", never as "the
 * running service's root" ({@link daemonRestartNotice} carries the difference).
 *
 * A reported root is classified by {@link stateRootRefusal} before it is joined, so a
 * root the daemon names that this install does not own produces a refusal here — the
 * first read or write has not happened yet — and never a path.
 *
 * Derived from {@link systemHome}, not from `$HOME`, because a root *this* process
 * can move is not the daemon's default root: with an overridden `HOME` the old
 * lookup named the sandbox file, which made both halves of the promise it was
 * written for false — a write into the sandbox was reported as the file the
 * service loads, and a write to the file it really loads was called a stray.
 */
export function daemonProjectsPath(daemonStateRoot?: string | null): string {
  // Since 1.15.0 the daemon names the root it resolved in `hello`'s `stateRoot`, so the
  // shell does not have to guess it from `$HOME`. Without that key (an older binary, or no
  // handshake yet) the home default is the only defensible answer, and it is said as
  // "where the service writes by default", never as "where the running service reads".
  const named = typeof daemonStateRoot === "string" ? daemonStateRoot.trim() : "";
  if (named !== "") {
    const defect = stateRootRefusal(named);
    if (defect !== null) {
      throw new ProjectRegistryError(GP_E_STATE_ROOT_REFUSED, refusedStateRootMessage(named, defect));
    }
    return path.join(named, "projects.json");
  }
  return path.join(systemHome(), ".glasspane", "projects.json");
}

/**
 * APFS firmlink: on a boot-volume-relative resolve, `/Users`, `/Applications`
 * and `/Volumes` come back as `/System/Volumes/Data/...`. Un-map that first,
 * or every real home-directory path would read as "inside /System".
 */
const FIRMLINK_PREFIX = "/System/Volumes/Data";

/** Escape hatch for the corrupt-registry case; see `unreadableMessage`. */
export const FORCE_OVERWRITE_ENV = "GLASSPANE_PROJECTS_FORCE_OVERWRITE";

/**
 * Shell-only override of the projects file: the daemon never reads it (R7-14).
 *
 * It is the one path in this module that a caller sets for *this process* rather than
 * sending in a tool argument, and since 1.20.1 it is judged by the same gates as every
 * other root this shell writes into — see {@link projectsPath}. The reason it could not
 * stay an exception is the write that follows it: {@link saveProjects} creates the
 * directory named here and brings it to 0700 before publishing the registry (bundle ids,
 * pids and storage paths) into it, so an ungated override is a way to make this process
 * re-permission and populate any directory its environment can name.
 */
export const PROJECTS_FILE_ENV = "GLASSPANE_PROJECTS_FILE";

export interface ProjectEntry {
  projectId: string;
  displayName: string;
  bundleId?: string;
  pid?: number;
  recipeConfigPath?: string;
  calibrationAssetsPath?: string;
  evidenceStoragePath?: string;
  createdAt: string;
}

/**
 * `projectSet` result: the stored entry plus how the write lands from the
 * daemon's point of view. `gp_project_*` writes projects.json directly while
 * the running background service keeps the copy it loaded at start, so the
 * entry is not usable by `gp_attach`/`projectId` lookups until that service
 * restarts — the same "written, but the running instance read it once at
 * startup" distinction the settings panel makes for permissions that need a
 * restart. Surfacing it here is what keeps a successful-looking write from
 * being followed by an unexplained GP_E_NOT_FOUND. See {@link
 * daemonRestartNotice}: when this shell wrote a file other than the one the
 * daemon loads, a restart is required but not sufficient.
 */
export interface ProjectSetResult extends ProjectEntry {
  requiresDaemonRestart: true;
  daemonRestartNotice: string;
  /** Set only when the escape hatch moved an unreadable registry aside. */
  discardedUnreadableFile?: string;
}

// ----- Zod schemas for MCP input validation -----

export const ProjectListArgs = z.strictObject({});
export type ProjectListArgs = z.infer<typeof ProjectListArgs>;

export const ProjectGetArgs = z.strictObject({
  projectId: z.string().regex(PROJECT_ID_RE, "projectId must match prj_ + 26 Crockford chars"),
});
export type ProjectGetArgs = z.infer<typeof ProjectGetArgs>;

export const ProjectSetArgs = z.strictObject({
  projectId: z.string().regex(PROJECT_ID_RE).optional(),
  displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  // An optional field is *patch*-shaped (B-11): `undefined` keeps what is
  // stored, `null` clears it, a value replaces it. The exactly-one-of identity
  // rule deliberately is not a check on this object — it holds of the MERGED
  // entry, and an update that clears one field while setting the other only
  // becomes legal after the merge (`assertSingleIdentity`).
  bundleId: z.string().max(BUNDLE_ID_MAX_LENGTH).nullish(),
  pid: z.number().int().min(PID_RANGE[0]).max(PID_RANGE[1]).nullish(),
  recipeConfigPath: z.string().max(MAX_FIELD_LENGTH).nullish(),
  calibrationAssetsPath: z.string().max(MAX_FIELD_LENGTH).nullish(),
  evidenceStoragePath: z.string().max(MAX_FIELD_LENGTH).nullish(),
});
export type ProjectSetArgs = z.infer<typeof ProjectSetArgs>;

// ----- File access -----

/**
 * The projects file this shell reads and writes.
 *
 * Two authorities, and the first one used to be unchecked: {@link PROJECTS_FILE_ENV} is
 * this process's own override slot, and when it is set the reported root below is never
 * consulted. Returning it as it stood was the hole — {@link saveProjects} runs
 * `mkdirSync(dir, 0700)` + {@link tightenMode} on whatever directory the value names and
 * publishes the registry (bundle ids, pids, storage paths) into it, so the override was a
 * way to make this process re-permission and populate any path its environment could
 * name, while every *reported* root and every *agent-supplied* storage root in this module
 * passes a judge first. It now crosses the same gates: absolute, traversal-free, and not
 * a tree this shell refuses to create or re-permission ({@link refuseOverrideDirectory}).
 *
 * The one shape that is allowed past {@link refuseCandidate} is the daemon's own default
 * root, `<passwd home>/.glasspane`: its home-dot-directory rule exists to stop an *evidence
 * archive* (which the daemon writes packs into and prunes) from being pointed at the
 * account's key chain, and `~/.glasspane/projects.json` is precisely the file the service
 * loads when started with no `--state-dir` — refusing it would turn a guard into a
 * regression of the documented default.
 */
function projectsPath(daemonStateRoot?: string | null): string {
  const envPath = process.env[PROJECTS_FILE_ENV];
  if (envPath) return overrideProjectsPath(envPath);
  return daemonProjectsPath(daemonStateRoot);
}

/** `<passwd home>/.glasspane`, the daemon's own default root, in the judged form. */
function homeDefaultStateRoot(): string {
  return stripFirmlink(path.posix.normalize(systemHome() + "/.glasspane"));
}

/**
 * Judge one override value and hand back the path it is allowed to mean.
 *
 * The judgement runs on the *directory* the write would create, because that is the half
 * with a side effect: the file itself is the registry, and its mode is set after the fact.
 * Normalisation happens here rather than being handed downstream, so what was judged and
 * what is written are the same string.
 */
function overrideProjectsPath(raw: string): string {
  const trimmed = raw.trim();
  const normalized = foldSlashTerminators(stripFirmlink(path.posix.normalize(trimmed)));
  if (!normalized.startsWith("/")) {
    throw refusedProjectsFileOverride(
      trimmed,
      `is not an absolute path (${trimmed}), so which projects file this write reaches moves with the `
      + "working directory of whoever started this MCP server",
    );
  }
  for (const component of normalized.split("/")) {
    if (component === "." || component === "..") {
      throw refusedProjectsFileOverride(
        trimmed,
        `carries a "." or ".." component (${trimmed}), so the file it names is not the file this `
        + "call was asked to write",
      );
    }
  }
  const directory = path.dirname(normalized);
  if (directory === homeDefaultStateRoot()) {
    // The daemon's own default root: `ProjectRegistry.defaultProjectsPath` on the Swift
    // side reads `<NSHomeDirectory>/.glasspane/projects.json`, and this shell's notice says
    // as much. Nothing is created here that the service has not already claimed.
    return normalized;
  }
  const shape = stateRootRefusal(directory);
  if (shape !== null) {
    throw refusedProjectsFileOverride(trimmed, `its directory ${shape} (${directory})`);
  }
  const resolved = stripFirmlink(resolveExistingAncestor(directory));
  const refusal = strongestRefusal(resolved === directory ? [directory] : [directory, resolved], resolved);
  if (refusal !== null) {
    throw refusedProjectsFileOverride(trimmed, `its directory ${refusalPhrase(refusal, resolved)}`);
  }
  return normalized;
}

/**
 * The refusal {@link projectsPath} raises for its own override slot.
 *
 * It carries its own remedy (B5) because the code-derived one would be wrong here: the
 * `GP_E_STATE_ROOT_REFUSED` arm in `tools.ts` tells a reader to go and ask the *service*
 * which root it resolved, and the thing in play is a variable this process was started
 * with. `unset` it, or point it at a file both sides accept — that is the move that works,
 * and it is the only one this sentence may claim.
 */
function refusedProjectsFileOverride(raw: string, defect: string): ProjectRegistryError {
  const defaultFile = `${homeDefaultStateRoot()}/projects.json`;
  return new ProjectRegistryError(
    GP_E_STATE_ROOT_REFUSED,
    `the ${PROJECTS_FILE_ENV} override this shell was started with ${defect}, so this shell refuses to use it: `
    + `${quoteShellArg(raw)}. This is the override slot of **this process**, not a root the background service `
    + `reported about itself — the daemon never reads ${PROJECTS_FILE_ENV} (R7-14), so the value being judged is `
    + "one an environment, a wrapper, or an agent set for the MCP shell alone. It is not a harmless pointer either: "
    + "`gp_project_set` would have created that directory and re-permissioned it to 0700, then written the project "
    + "registry — bundle ids, pids and storage paths — into it, which is the same authority this module refuses a "
    + "self-reported root over (`StateRoot.notADedicatedRoot`) and refuses an agent-named evidence archive over "
    + "(`refuseCandidate`). Nothing was read and nothing was written by this call: no directory was created, no "
    + "permission was changed, no projects.json was opened, listed or saved.",
    `this shell's own override is what is configured, not your arguments and not a damaged file: `
    + `\`unset ${PROJECTS_FILE_ENV}\` for this MCP server process and repeat gp_project_set — it then writes the `
    + `projects file of the root the running daemon named in its hello, or the home default `
    + `\`${quoteShellArg(defaultFile)}\` when it named none. Alternatively point the override at one of those two `
    + "paths; do not point it at a tree this shell will not create or re-permission, and do not repair a projects "
    + "file for this refusal — the refusal names a directory, and no path under it was touched. If the service "
    + "really is running on a root this shell cannot accept, move the service instead: "
    + "`glasspaned --state-dir <a directory this install owns>`, then reconnect so a fresh hello reports it",
  );
}

/**
 * Registry load result. `failure` is a description of why the file cannot be
 * trusted (`null` = it can, including the never-written case); an empty
 * `projects` array with a failure must never be read as "no projects".
 *
 * `readAs` is the SHA-256 of the **exact bytes this function read**, and it is the
 * read-modify-write baseline {@link assertNoConcurrentWrite} compares the file to
 * before publishing anything. It is `null` only when no bytes were obtained at all
 * — the file was absent, or it could not be read — and a *damaged* file still has a
 * digest, because those are the bytes {@link requireUsableRegistry} is about to move
 * aside and must be able to prove it did not move something else.
 */
interface RegistrySnapshot {
  projects: ProjectEntry[];
  failure: string | null;
  readAs: string | null;
}

function loadRegistry(filePath: string): RegistrySnapshot {
  // Bytes, not a decoded string: the digest has to be of what is on the device, and a
  // decode can lose information (invalid UTF-8 becomes U+FFFD, and two damaged files
  // that decode alike would then look like the same registry). The BOM is dropped for
  // the *parse* only, which is what `readFileSync(…, "utf8")` did before this, so a
  // registry that used to load still loads.
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return { projects: [], failure: null, readAs: null }; // nothing registered yet
    }
    return { projects: [], failure: `cannot be read (${describeError(error)})`, readAs: null };
  }
  const readAs = registryBytesDigest(bytes);
  const decoded = bytes.toString("utf8");
  const raw = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { projects: [], failure: `is not valid JSON (${describeError(error)})`, readAs };
  }
  if (!Array.isArray(parsed)) {
    return { projects: [], failure: "is not a JSON array of projects", readAs };
  }

  const projects: ProjectEntry[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const problem = inspectStoredEntry(parsed[i], i);
    if (problem !== null) {
      return { projects: [], failure: problem, readAs };
    }
    projects.push(parsed[i] as ProjectEntry);
  }
  return { projects, failure: null, readAs };
}

/**
 * Shape check for one stored entry: what the daemon's Swift decoder requires.
 * It rejects the *entire* file on any violation, so a single bad row means
 * every registration is unreadable — checked here rather than half-read, and
 * reported as a load failure instead of a shorter project list. Path *values*
 * are deliberately not re-validated on read: refusing to list a legacy
 * registry would hide the problem, while `checkAgentPath` at write time plus
 * the daemon's own deletion scope cover it.
 */
function inspectStoredEntry(raw: unknown, index: number): string | null {
  const at = `entry ${index}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `${at} is not an object`;
  }
  const record = raw as Record<string, unknown>;
  const stringField = (key: string, required: boolean): string | null => {
    const value = record[key];
    if (value === undefined || value === null) {
      return required ? `${at} is missing '${key}'` : null;
    }
    return typeof value === "string" ? null : `${at} has a non-string '${key}'`;
  };
  const requiredStrings: readonly string[] = ["projectId", "displayName", "createdAt"];
  for (const key of requiredStrings) {
    const problem = stringField(key, true);
    if (problem) return problem;
  }
  const optionalStrings: readonly string[] = ["bundleId", ...PATH_FIELDS];
  for (const key of optionalStrings) {
    const problem = stringField(key, false);
    if (problem) return problem;
  }
  const pid = record.pid;
  if (pid !== undefined && pid !== null) {
    if (typeof pid !== "number" || !Number.isInteger(pid)) {
      return `${at} has a non-integer 'pid'`;
    }
    if (pid < -2_147_483_648 || pid > 2_147_483_647) {
      return `${at} has a 'pid' outside the range the daemon can decode (Int32)`;
    }
  }
  return null;
}

/**
 * Refuse to lose data on a registry we cannot read. Without the escape hatch
 * this is a hard stop; with it, the unloadable file is moved aside (so the
 * evidence in it is still recoverable by hand) and the registry is rebuilt.
 *
 * The `baseline` it hands back is what {@link projectSet} later compares the file to
 * before publishing, so it is established *here*, after any repair this function made:
 * the point of the check is "is the file still the one we read?", and after a rename the
 * honest answer is that there is no such file any more (`null`), not "the bytes that
 * failed to parse". The old `fileIdentity` capture — a `stat` taken after this step, of
 * whatever was on the disk by then — folded a concurrent writer's update into the
 * baseline and let this call rename a stale table over it.
 *
 * The rename is the other half of the same window, and it is guarded the same way: the
 * bytes are re-digested first, and a file that is no longer the one that failed to parse
 * is left exactly where it is. Moving aside a registry that a concurrent *good* write
 * landed in the meantime would be the identical data loss this escape hatch was narrowed
 * to avoid — this project once destroyed a real `projects.json` that way — and "we could
 * not read it" is not evidence that it is still unreadable.
 *
 * When no bytes were obtained at all ({@link RegistrySnapshot.readAs} is `null`, i.e. a
 * *read* error such as `EACCES`, not a parse error) the digest check cannot run: there is
 * nothing to compare against. That case keeps the documented behaviour and the rename
 * proceeds, because the only thing we know about that file is that this process could
 * not look at it, and the file it moves aside is the one it was told to move.
 */
function requireUsableRegistry(
  filePath: string,
  snapshot: RegistrySnapshot,
): { projects: ProjectEntry[]; baseline: string | null; discarded?: string } {
  if (snapshot.failure === null) {
    return { projects: snapshot.projects, baseline: snapshot.readAs };
  }
  if (process.env[FORCE_OVERWRITE_ENV] !== "1") {
    throw new ProjectRegistryError(GP_E_INTERNAL, unreadableMessage(filePath, snapshot.failure));
  }
  if (snapshot.readAs !== null) {
    let stillThere: string | null;
    try {
      stillThere = registryDigest(filePath);
    } catch (error) {
      throw new ProjectRegistryError(
        GP_E_INTERNAL,
        `projects.json at ${filePath} ${snapshot.failure}, and it cannot be re-read to confirm it is still the `
        + `bytes that failed (${describeError(error)}), so ${FORCE_OVERWRITE_ENV}=1 moved nothing and wrote nothing. `
        + "Reading it is the next step — " + registryReaders(filePath) + " — not replacing it.",
      );
    }
    if (stillThere !== snapshot.readAs) {
      throw new ProjectRegistryError(GP_E_REGISTRY_DRIFT, refusedToDiscardMessage(filePath, stillThere));
    }
  }
  const discarded = `${filePath}.unreadable-${uniqueToken()}`;
  try {
    fs.renameSync(filePath, discarded);
  } catch (error) {
    throw new ProjectRegistryError(
      GP_E_INTERNAL,
      `projects.json at ${filePath} ${snapshot.failure}; ${FORCE_OVERWRITE_ENV}=1 asked to move it aside first, but that failed (${describeError(error)}), so nothing was overwritten`,
    );
  }
  // Re-established *after* the rename: the file this call read is now at `discarded`, so
  // the table it is about to publish has nothing to overwrite.
  return { projects: [], baseline: registryDigest(filePath), discarded };
}

/**
 * The repair arm met a newer file: say which fact was observed (the bytes are not the
 * ones that failed to parse), that nothing was moved, and what the caller can do — the
 * same forced call, which now *reads* those newer bytes and only rebuilds if they turn
 * out to be unreadable too.
 */
function refusedToDiscardMessage(filePath: string, now: string | null): string {
  return `projects.json at ${filePath} is no longer the file that failed to parse — its contents changed between `
    + `this call reading it (${FORCE_OVERWRITE_ENV}=1 was set, so it was about to be moved aside) and the rename `
    + `(the file is now ${now === null ? "absent" : "present with different bytes"}), so nothing was moved and `
    + "nothing was written. Another process — the background service, its CLI, or the settings panel — landed a newer "
    + "version of this table, and archiving it as unreadable would delete an entry that was written after we gave up on "
    + "reading the old one. Repeat the same call: it reads the file again, so the second attempt judges those bytes "
    + "instead of the ones that are gone. If they parse, the rebuild is not needed at all.";
}

/**
 * The two readers a damaged registry can be looked at with, named as absolute commands.
 *
 * `python3 -m json.tool` used to stand in both messages below, and it was wrong twice over:
 * a stock macOS ships no `python3` at all, and a bare command name resolves through a PATH
 * this reader does not control — the exact rule the `GP_E_INTERNAL` remedy beside those
 * messages already states ("both absolute, so they … need nothing that may be off PATH").
 * One error carried two opposite rules; the stricter side is the true one, so both halves
 * now say it out of here rather than each in its own words.
 *
 * `target` is the file when this layer knows it, and the placeholder
 * `"<that path>"` when the sentence above has already named it — one phrasing, two callers,
 * so neither can drift back to a command the agent cannot run.
 */
export function registryReaders(target: string): string {
  return `\`/usr/bin/plutil -p ${quoteShellArg(target)}\` or \`/bin/cat ${quoteShellArg(target)}\` — both absolute, so they run from whatever `
    + "directory the reader is in and need nothing that may be off PATH";
}

function unreadableMessage(filePath: string, failure: string): string {
  return `projects.json at ${filePath} ${failure}. gp_project_set refused to write it: replacing an unreadable registry discards every registration in it. See the damage with ${registryReaders(filePath)} and repair that file, or set ${FORCE_OVERWRITE_ENV}=1 and retry to rebuild the registry from scratch — the unloadable file is moved aside as ${filePath}.unreadable-<id> rather than deleted, and every existing project entry is lost.`;
}

function readFailureMessage(filePath: string, failure: string): string {
  return `projects.json at ${filePath} ${failure}. This is a read failure, not an empty registry: the entries that are registered cannot be listed. See the damage with ${registryReaders(filePath)}, then repair or replace that file. To rebuild the registry from scratch instead — which costs every existing entry — set ${FORCE_OVERWRITE_ENV}=1 and call gp_project_set again.`;
}

/**
 * The modes the daemon's `StateRoot` publishes for this state root: the
 * directory `0700`, every file inside it `0600` (`StateRoot.tightenPermissions`
 * / `StateRoot.isolateFile`, spec revision §8 "就地收紧"). These are the daemon's
 * numbers, not this writer's preference — it reads and writes the *same*
 * `projects.json`, and the table it holds is the project list a daemon will act
 * on for every local account that can read it.
 *
 * The round-4 decision for this family of defects is *tighten in place*: what the
 * state root already is gets brought to the documented mode, rather than what is
 * documented being lowered to what the file happens to be. So these are applied
 * to a pre-existing directory and a pre-existing file too, which is the half the
 * old code skipped — `mkdir` with the default mode plus a `writeFileSync` with no
 * mode answered 0755/0644 under umask 022, and `StateRoot.swift`'s own comment
 * names "a ~/.glasspane made by the MCP shell" as the hole the daemon then has to
 * close at the next start. Until that start, every `gp_project_set` re-loosened
 * what the daemon had tightened.
 */
const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;

/**
 * Bring one path to `want` and *verify it after* the chmod.
 *
 * The verification is not decoration: a volume that ignores chmod (read-only
 * mount, ACL, immutable flag) answers the call with success and leaves the old
 * mode in place, which is exactly the case where the file is world-readable and
 * the writer believes it is not. The daemon does the same two-step
 * (`StateRoot.isolateFile`), and refuses out loud when the mode does not stick —
 * so does this, under the code that means "the write did not land as promised".
 */
function tightenMode(target: string, want: number, kind: "directory" | "file"): void {
  try {
    fs.chmodSync(target, want);
  } catch (error) {
    throw new ProjectRegistryError(
      GP_E_INTERNAL,
      `the ${kind} ${target} could not be made owner-only (chmod ${(want & 0o777).toString(8)} failed: ${describeError(error)})`,
    );
  }
  let mode: number;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch (error) {
    throw new ProjectRegistryError(
      GP_E_INTERNAL,
      `the ${kind} ${target} was tightened but cannot be read back (${describeError(error)})`,
    );
  }
  if (mode !== want) {
    throw new ProjectRegistryError(
      GP_E_INTERNAL,
      `the ${kind} ${target} is still ${(mode & 0o777).toString(8)} after chmod(${(want & 0o777).toString(8)})`,
    );
  }
}

/**
 * 这份文件此刻的内容指纹：内容一样就是同一份，改过一个字节就不是。
 * 文件不在时为 null——"还没人注册过"与"刚被别人删了"在这一层是同一个观察，
 * 两者都不许被盖过去。
 *
 * 这是 `fileIdentity`（`mtimeMs:size:ino`）的替代而不是第二套身份方案，理由就在
 * "基线要取自产生这次编辑的那份字节"这一条上：stat 三元组描述的永远是**问它的那一刻**
 * 的盘，而不是我们读到的那份内容。旧顺序（先 `readFileSync` 再 `statSync`）把别人在这
 * 两步之间落地的那次写折进了基线，于是一次读到的表 A、盘上已经是表 B 的调用，最后拿
 * B 跟 B 比，判定"没变"，然后把过期的 A（外加我们这一条）rename 上去并报告成功。
 * 内容指纹没有这个缝：`loadRegistry` 返回的是它自己那一次读的哈希，写前回读的是盘，
 * 两者一比就是"盘上换了哪一份"。
 *
 * 顺带把粒度也收紧了：`mtimeMs:size` 在同一毫秒内的等长改写可以完全相同，指纹不会。
 */
function registryDigest(filePath: string): string | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  return registryBytesDigest(bytes);
}

/** SHA-256 of the exact bytes, hex. One hash function for both halves of the comparison. */
function registryBytesDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 读—改—写之间盘上换了哪一份：给出这一句拒绝的理由，没换则 null。
 *
 * 判据是**内容指纹**（`registryDigest`），不是 stat 三元组：基线必须是"产生这次编辑的
 * 那批字节"，而 stat 只能回答"我问的那一刻盘上是什么"。
 *
 * 两个参数都当作不透明值比较，调用方给什么就是什么——`registry-drift.test.mjs` 与
 * `daily-20261011.test.mjs` 传的是 `"1:2:3"` 这类假指纹，签名一旦要求十六进制或 Buffer，
 * 那两条会一起变红。判据本身继续单独抽出来验红；而"取基线的位置对不对"这件事，如今可以
 * 真的跑出来：`test/daily-20261022-registry-trust.test.mjs` 用一次受控的读（读到 A、盘上是 B）
 * 走的是 `projectSet` 的真实路径。
 */
export function registryDriftReason(
  filePath: string,
  openedAs: string | null,
  now: string | null,
): string | null {
  if (now === openedAs) {
    return null;
  }
  return `projects.json at ${filePath} changed between the read that produced this edit and the write that `
    + `would have published it (was ${openedAs ?? "absent"}, now ${now ?? "absent"}), so this call wrote `
    + "nothing. Another process — the background service, its CLI, or the settings panel — holds a newer "
    + "version of this table, and renaming ours over theirs would drop their entry while reporting success. "
    + `Repeat gp_project_set: it reads the file again, so the second attempt carries what the other writer `
    + "landed. If it keeps failing, something is writing this registry on a timer — read the file to see "
    + "what appeared, and do not force the write.";
}

/**
 * 落锁要 daemon 那边一起改协议，这里做的是这一层能独立做到的：写之前把盘上的内容与
 * 我们读到的那份比一比，不是同一份就**拒绝**而不是覆盖，并把重试这条路说清楚。
 * 比较的两边都是内容，所以"基线取在哪"不再有缝——`loadRegistry` 的那一次读就是基线。
 * 丢更新仍然可能发生在本函数返回与 rename 之间那几微秒里，但那已经不是"读到的表和写回的表不是同一份"了。
 */
function assertNoConcurrentWrite(filePath: string, openedAs: string | null): void {
  const reason = registryDriftReason(filePath, openedAs, registryDigest(filePath));
  if (reason !== null) {
    throw new ProjectRegistryError(GP_E_REGISTRY_DRIFT, reason);
  }
}

/**
 * Sync the directory entry so the rename itself is on disk, not only the file's bytes.
 *
 * Tolerant on purpose: a volume that has no directory sync (smbfs, NFS, exFAT, a read-only
 * mount) is a legal `--state-dir` target, and refusing the write there would report
 * "nothing was saved" about a registration that did land. Only an error that says the
 * storage actually misbehaved (`EIO`, `ENOMEM`) is rethrown, and the caller's existing
 * refusal text is what the operator then reads.
 */
function syncDirectory(dir: string): void {
  let dirFd: number | null = null;
  try {
    dirFd = fs.openSync(dir, "r");
    fs.fsyncSync(dirFd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EIO" || code === "ENOMEM") throw error;
  } finally {
    if (dirFd !== null) fs.closeSync(dirFd);
  }
}

function saveProjects(filePath: string, entries: ProjectEntry[]): void {
  const dir = path.dirname(filePath);
  // Atomic write: tmp + rename. The temp name is unique per write — three
  // different processes rewrite this file (daemon CLI, shell tools, panel),
  // and a shared `<file>.tmp` lets one writer rename another's half-written
  // buffer into place.
  const tmpPath = `${filePath}.tmp-${uniqueToken()}`;
  try {
    // `mode` on `mkdir` is applied only to what it creates *and* masked by the
    // process umask, so it cannot be the whole answer; the chmod inside is what
    // makes the promise true, and it runs on a directory that already existed.
    fs.mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
    tightenMode(dir, STATE_DIR_MODE, "directory");
    // Bytes before name: `writeFileSync` + `renameSync` alone publishes the path while the
    // payload may still be in the buffer cache, so `gp_project_set` could answer "saved"
    // about a registration that a power loss never wrote down. The daemon's own stores
    // (engine/Sources/GlassPaneEngine/DurableFileWrite.swift) fsync the fd before the
    // rename; this file is the *other* production writer of the same table, and a fix on
    // one face only is what makes the other face's promise false.
    const fd = fs.openSync(tmpPath, "w", STATE_FILE_MODE);
    try {
      fs.writeFileSync(fd, JSON.stringify(entries, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Tightened while it still carries the temp name, so the path that is
    // *created* is never world-readable, and judged again after the rename: a
    // replacement can hand the destination's older, looser mode to the item that
    // lands (the daemon says as much about `replaceItemAt` on APFS), which is the
    // pre-existing world-readable file this shell is about to rewrite.
    tightenMode(tmpPath, STATE_FILE_MODE, "file");
    fs.renameSync(tmpPath, filePath);
    syncDirectory(dir);
    tightenMode(filePath, STATE_FILE_MODE, "file");
  } catch (error) {
    // The half-written temp file goes either way: a mode that would not stick is
    // no reason to leave litter next to a registry somebody else has to read.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* temp already gone, or never created */
    }
    if (error instanceof ProjectRegistryError) {
      throw new ProjectRegistryError(
        error.code,
        `${error.message}; projects.json at ${filePath} was therefore not published as owner-only, and `
        + `gp_project_set refuses to report a write the daemon's own modes did not hold. Bring the state root `
        + `to them yourself (chmod 700 ${quoteShellArg(dir)}, chmod 600 ${quoteShellArg(filePath)}) and retry — a volume that ignores chmod `
        + "(read-only mount, ACL, immutable flag) needs the daemon's --state-dir moved to one that honours "
        + "permissions; until then the registry on disk and this shell disagree about who can read it",
        // The refusal above already names the two commands that make the modes true, so the
        // remedy transcribes them instead of sending the reader to repair a file nobody
        // called damaged (B5). Nothing here is a judgement about the registry's contents.
        `the mode this shell asked for did not stick, so nothing was published: bring it to the daemon's own `
        + `modes yourself — \`chmod 700 ${quoteShellArg(dir)}\` and \`chmod 600 ${quoteShellArg(filePath)}\` — read them back with `
        + `\`stat -f '%Sp %N' ${quoteShellArg(dir)} ${quoteShellArg(filePath)}\`, and repeat gp_project_set once they say 700 and 600. `
        + "If chmod answers success and the mode stays loose, the volume ignores permissions: find out with "
        + `\`ls -lO ${quoteShellArg(dir)}\` (an immutable flag) and \`diskutil info -live ${quoteShellArg(dir)}\` `
        + "(a read-only or remote mount), and move the service onto a volume that honours them "
        + "`glasspaned --state-dir <a directory this install owns>`). Do not repair or overwrite projects.json for "
        + `this one, and do not set ${FORCE_OVERWRITE_ENV}: the fault is the mode, not the bytes in the file`,
      );
    }
    // A durability fault is not a permissions story, and it is not "the file is damaged":
    // the write itself could not be committed. Say which syscall failed, answer "not saved"
    // instead of "saved", and hand over the two commands that tell the causes apart.
    const errno = (error as NodeJS.ErrnoException)?.code ?? "unknown";
    throw new ProjectRegistryError(
      GP_E_INTERNAL,
      `projects.json at ${filePath} was not published: committing the bytes to the device failed (${errno}). `
      + `gp_project_set answers "not saved" here rather than "saved", because a registration a power loss can `
      + `drop is not a registration. This is the write's own failure, not a verdict about the file's contents: `
      + `check what the volume will do (\`ls -lO ${quoteShellArg(dir)}\` for an immutable flag, \`diskutil info -live ${quoteShellArg(dir)}\` `
      + `for a read-only or remote mount), fix that, then retry the same call.`,
      // Carried by the error rather than derived from `GP_E_INTERNAL` in `tools.ts` (B5):
      // that code's arm reads "the projects file is the problem … repair or restore the
      // damaged entry", which is the opposite of the sentence above and would send an agent
      // to edit a registry that this call never failed to decode.
      `nothing was published by this call, and the file's contents are not in question: check what the volume `
      + `will do — \`ls -lO ${quoteShellArg(dir)}\` for an immutable flag, \`diskutil info -live ${quoteShellArg(dir)}\` for a `
      + `read-only or remote mount, \`df -h ${quoteShellArg(dir)}\` for a full one — fix that, and repeat the same `
      + "gp_project_set once the volume commits. Do not repair or restore projects.json for this fault, and do not "
      + `set ${FORCE_OVERWRITE_ENV}: it moves an unreadable registry aside, which is a different problem from a write `
      + "the device refused",
    );
  }
}

let tokenCounter = 0;
function uniqueToken(): string {
  tokenCounter += 1;
  return `${process.pid}-${Date.now().toString(36)}-${tokenCounter.toString(36)}-${randomBytes(4).toString("hex")}`;
}

// ----- Public operations -----

export function projectList(daemonStateRoot?: string | null): ProjectEntry[] {
  const filePath = projectsPath(daemonStateRoot);
  const snapshot = loadRegistry(filePath);
  if (snapshot.failure !== null) {
    throw new ProjectRegistryError(GP_E_INTERNAL, readFailureMessage(filePath, snapshot.failure));
  }
  return snapshot.projects;
}

export function projectGet(projectId: string, daemonStateRoot?: string | null): ProjectEntry | undefined {
  const projects = projectList(daemonStateRoot);
  return projects.find((p) => p.projectId === projectId);
}

/**
 * Create or update a project.  If `projectId` is undefined, a new entry is
 * created; otherwise the existing entry is updated (GP_E_NOT_FOUND on miss).
 * Fields are patched: omitted keeps the stored value, explicit null clears it.
 * Path fields and the identity rule are validated on the *merged* entry before
 * anything is written, and the result states explicitly what the running daemon
 * can and cannot see yet.
 */
export function projectSet(args: ProjectSetArgs, daemonStateRoot?: string | null): ProjectSetResult {
  const filePath = projectsPath(daemonStateRoot);
  assertStorablePid(args.pid);
  const snapshot = loadRegistry(filePath);
  // 基线就是**产生这次编辑的那批字节**：`requireUsableRegistry` 把它（`baseline`）交出来，
  // 因为那一步自己就会动文件（读不回的表被挪成 `.unreadable-…` 而不是删掉），挪过之后盘上
  // 那份已经不是我们读到的那份了。旧写法是在那一步**之后**再取一次 `stat` 当基线，于是
  // "读完之后别人写了一次"正好被折进基线——守卫拿别人的结果跟别人的结果比，判定没变，
  // `saveProjects` 把我们这份过期的表 rename 上去并报告成功，别人那条 entry 就没了。
  // 现在基线在上面那一次读里就定了：`loadRegistry` 交回它自己读的字节摘要，
  // `requireUsableRegistry` 之后没有任何一步能替它改写它（除了它自己那次修复）。
  const { projects, discarded, baseline: openedAs } = requireUsableRegistry(filePath, snapshot);

  let entry: ProjectEntry;
  const projectId = args.projectId;

  if (projectId) {
    // Update: the patch is applied to the stored entry, never to a blank one.
    const existing = projects.find((p) => p.projectId === projectId);
    if (existing === undefined) {
      throw new ProjectRegistryError(GP_E_NOT_FOUND, `unknown projectId ${projectId}`);
    }
    entry = applyPatch(existing, args);
    assertSingleIdentity(entry, args, existing, filePath);
    projects[projects.indexOf(existing)] = entry;
  } else {
    // Create.
    if (projects.length >= MAX_PROJECTS) {
      throw new ProjectRegistryError(GP_E_PROJECT_LIMIT, `project limit reached (${MAX_PROJECTS})`);
    }
    entry = applyPatch(
      {
        projectId: generateProjectId(),
        displayName: args.displayName,
        createdAt: new Date().toISOString(),
      },
      args,
    );
    assertSingleIdentity(entry, args, null, filePath);
    projects.push(entry);
  }

  assertNoConcurrentWrite(filePath, openedAs);
  saveProjects(filePath, projects);
  return {
    ...entry,
    requiresDaemonRestart: true,
    daemonRestartNotice: daemonRestartNotice(filePath, daemonStateRoot),
    ...(discarded !== undefined ? { discardedUnreadableFile: discarded } : {}),
  };
}

/**
 * Apply one call's fields to a stored entry: value validation happens here, the
 * rule about the *combination* of fields on the result (that is the entry the
 * daemon will decode).
 */
function applyPatch(base: ProjectEntry, args: ProjectSetArgs): ProjectEntry {
  const next: ProjectEntry = { ...base, displayName: args.displayName };
  if (args.bundleId !== undefined) {
    if (args.bundleId === null) delete next.bundleId;
    else next.bundleId = args.bundleId;
  }
  if (args.pid !== undefined) {
    if (args.pid === null) delete next.pid;
    else next.pid = args.pid;
  }
  for (const field of PATH_FIELDS) {
    applyPathField(next, field, args[field]);
  }
  return next;
}

/** One storage-root field: keep (undefined), clear (null), or replace. */
function applyPathField(target: ProjectEntry, field: PathField, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null) {
    delete target[field];
    return;
  }
  target[field] = checkAgentPath(field, value);
}

/**
 * Exactly one of `bundleId` / `pid` identifies the app: the daemon's `create()`
 * refuses any other combination and its `update()` only adds the field named, so
 * an entry carrying both is a shape no write path produces — and
 * `EngineCore.projectMismatch` would then compare both halves against one
 * attach, making one projectId mean two apps. Runs on the MERGED entry (B-11):
 * an update may name neither field, and clearing one with an explicit null is
 * only correct once the other is known to remain. The message names both fields.
 *
 * "Both are set" has two opposite causes, and only one of them is the caller's:
 * a registry damaged by another writer can *already* carry both — {@link inspectStoredEntry}
 * judges the daemon's decodable *types*, not this rule, because refusing to load a
 * legacy table would blank every registration — and then a call that named neither
 * field was refused for a shape it did not create. The old single sentence read as a
 * verdict about the caller's own arguments ("Pass null for the one to drop"), which
 * sends an agent to change inputs that were never the problem; its sibling branch
 * below already distinguishes the two ("this call cleared the one that was stored").
 * So the stored entry comes in as well as the merged one, and the two causes get the
 * two codes that match what the caller can actually do:
 * - caller-made (`GP_E_BAD_PARAMS`, unchanged wording): different arguments fix it;
 * - stored damage (`GP_E_INTERNAL`): the file is the problem, not the input — which is
 *   exactly what `tools.ts`' remedy arm for that code already says ("the projects file
 *   is the problem, not your arguments: … repair or restore the damaged entry, and
 *   retry"), and the next step here is a real one: a call that nulls one half is
 *   accepted, so this module can repair the entry it just refused to publish over.
 */
function assertSingleIdentity(
  entry: ProjectEntry,
  args: ProjectSetArgs,
  stored: ProjectEntry | null,
  filePath: string,
): void {
  const hasBundleId = entry.bundleId !== undefined;
  const hasPid = entry.pid !== undefined;
  if (hasBundleId && hasPid) {
    if (stored !== null && stored.bundleId !== undefined && stored.pid !== undefined) {
      throw new ProjectRegistryError(GP_E_INTERNAL, damagedStoredIdentityMessage(entry, args, filePath));
    }
    throw new ProjectRegistryError(
      GP_E_BAD_PARAMS,
      `bundleId (${entry.bundleId}) and pid (${entry.pid}) are both set on projectId ${entry.projectId} — exactly one of bundleId or pid may identify the app. Pass null for the one to drop (bundleId: null keeps pid, pid: null keeps bundleId); omitting a field keeps whatever is already stored.`,
    );
  }
  if (!hasBundleId && !hasPid) {
    throw new ProjectRegistryError(
      GP_E_BAD_PARAMS,
      `projectId ${entry.projectId} would be left with neither bundleId nor pid — exactly one of bundleId or pid must identify the app (this call cleared the one that was stored). Set bundleId or pid instead of nulling it.`,
    );
  }
}

/**
 * The stored entry was already illegal before this call touched it: say whose halves
 * these are, name the projectId and the file, and keep the next step executable.
 *
 * It deliberately does not read as a complaint about the arguments — the caller may
 * have named neither field — and it does not stop at blaming the file either, because
 * the one write that fixes this entry is a `gp_project_set` with a single explicit
 * null. That arm stays open by construction: the check above asks whether the *stored*
 * entry carried both, so clearing one half merges to a legal entry and lands.
 */
function damagedStoredIdentityMessage(entry: ProjectEntry, args: ProjectSetArgs, filePath: string): string {
  const fromCall = args.bundleId !== undefined && args.pid !== undefined
    ? "this call named both bundleId and pid"
    : args.bundleId !== undefined
      ? `this call named only bundleId (${args.bundleId})`
      : args.pid !== undefined
        ? `this call named only pid (${args.pid})`
        : "this call named neither bundleId nor pid";
  return `projects.json at ${filePath} already stored two identities on projectId ${entry.projectId} — bundleId (${entry.bundleId}) and pid (${entry.pid}) — and ${fromCall}, so this call did not create that shape, it inherited it. `
    + "Nothing was written: the entry stays as the other writer left it. The damage is a rule about the *combination*, which the daemon enforces on its own create()/update() and the file's shape check cannot see, so it survives a load and reaches the first call that tries to save the entry again. "
    + "Two identities on one projectId means `gp_attach` would match that project against two different apps. "
    + `Put the entry back with the one write that is accepted here: gp_project_set with projectId ${entry.projectId}, its current displayName, and null for the half that is not this app (pid: null keeps bundleId, bundleId: null keeps pid) — naming the half to keep is not required, clearing one is enough. `
    + "Check which half the app actually runs as first: gp_project_list shows both, `ps -p <pid> -o comm=` names the process a stored pid points at (nothing back means that process is gone, which is the usual sign of a stale pair), and a bundle id is the app's own identifier. "
    + "Do not hand-edit the file: the running service holds its own copy of the table and rewrites it, so a hand repair disappears at its next save.";
}

/**
 * One user-facing sentence for the tool result. The panel already keeps "the
 * file is written" apart from "the running service can act on it"; the MCP
 * surface needs the same distinction because gp_attach is answered by the
 * daemon's in-memory copy of this file.
 *
 * B-10: computed from the facts instead of asserted blindly, because the old text
 * was wrong twice over. It promised a restart surfaces *any* path this shell had
 * just written, while {@link PROJECTS_FILE_ENV} is a file nothing reads; and it
 * prescribed a raw `launchctl kickstart`, which cannot work for a job that was
 * never bootstrapped, so the notice defers to the helper that covers that case.
 *
 * Round 9 keeps both corrections and drops one premise: "the daemon loads
 * {@link daemonProjectsPath} and nothing else" is only true of a service started
 * with no state root. `glasspaned --state-dir <root>` makes it load
 * `<root>/projects.json` (`ProjectRegistry(stateRoot:)`, and every subcommand
 * resolves through the same root), and the socket cannot be asked which root the
 * running job chose — since 1.15.0 the daemon says so in `hello`'s `stateRoot`, while a
 * service still running an older binary does not. So a
 * notice that simply ordered a restart was telling an agent that restarting would
 * help in the one case where it cannot, and a notice that said "this is the file
 * the service loads" was naming a file the service may not load. Both branches
 * therefore name the `--state-dir` case, hand over the one discriminator the
 * surface actually has, and say what each outcome means:
 * {@link rootDiscriminator}.
 */
export function daemonRestartNotice(filePath: string, daemonStateRoot?: string | null): string {
  const named = typeof daemonStateRoot === "string" && daemonStateRoot.trim() !== "" ? daemonStateRoot.trim() : null;
  const daemonPath = daemonProjectsPath(named);
  // Two different authorities, and the sentence has to say which one spoke: a daemon that
  // answered `hello.stateRoot` names the root it loads, while an older binary (or no
  // handshake) leaves only the home default, which is a guess about the default and not
  // about the running service.
  const authority = named === null
    ? "its default root is the folder under this user's home record (where a service started with no --state-dir looks)"
    : `its root is the one the running daemon named in its hello (${named})`;
  if (path.resolve(filePath) !== path.resolve(daemonPath)) {
    return `Saved in ${filePath}. The background service does not read this path because of anything in its own configuration: ${authority}. It loads ${daemonPath} once when it starts, and ${PROJECTS_FILE_ENV} — the variable that pointed this write here — is honoured by this MCP shell only, so as far as the service's own configuration goes it never reads that file, and no restart of the service will make it load this one. ${rootDiscriminator()} To land the entry where that root looks: unset ${PROJECTS_FILE_ENV} for this shell (or point it at ${daemonPath}) and repeat gp_project_set, then restart the background service so it reloads — ${restartCommand()}`;
  }
  if (named !== null) {
    return `Saved in ${filePath} — the projects file of the state root the running daemon reported in its own hello (${named}), so this is the file that service loads. It read that file once when it started, so gp_attach will keep returning GP_E_NOT_FOUND for this projectId until the service restarts: ${restartCommand()}`;
  }
  return `Saved in ${filePath}, the projects file under the home record this user's state root defaults to. If this is the root the service was started on — which is not knowable from here, because this daemon's hello reported no stateRoot — then the running background service loaded that file once when it started, so gp_attach will keep returning GP_E_NOT_FOUND for this projectId until the service restarts: ${restartCommand()}. ${rootDiscriminator()}`;
}

/**
 * The check an agent can run itself, with what each outcome means.
 *
 * It is the only discriminator this surface has: `gp_project_list` reads the file
 * this call wrote, and `gp_attach {projectId}` is answered by the running
 * service's own copy. Written-and-listed plus a GP_E_NOT_FOUND attach is
 * therefore not "the write failed" — it is the service and the shell looking at
 * different files, and the two ways that happens need opposite answers: a service
 * that predates the write is fixed by reloading it, and a service started with
 * `--state-dir <root>` is not fixed by any restart, because every restart reads
 * the same other file. Which of the two it is comes from reading the job's
 * arguments (`launchctl print`), never from deriving a root here.
 */
function rootDiscriminator(): string {
  return "Tell the two cases apart with the service's own answer: gp_project_list reads the file this call wrote, so an entry it lists is on disk, and gp_attach {projectId} is answered by the running service — an entry the list shows plus an attach that answers GP_E_NOT_FOUND means the service is loading a different projects.json than the one this write reached, not that the write failed. "
    + "Which file the running service loads is not something this shell guesses from $HOME: `glasspaned --state-dir <root>` moves it to <root>/projects.json, and the daemon reports the root it resolved — `hello` names the state root under its `stateRoot` key. A daemon predating 1.15.0 omits the key, and an omitted key means \"that daemon does not report it\", never \"so it must be the home default\": for those binaries the discriminator below is the only read. Cross-check either way — `launchctl print gui/"
    + currentUid()
    + "/com.glasspane.daemon` prints the arguments the job was started with. "
    + "If those arguments name a --state-dir, the entry has to go into that root's projects.json (repeat gp_project_set with "
    + PROJECTS_FILE_ENV
    + " pointed at <that root>/projects.json — this shell judges that override with the same path gates it judges "
    + "every root it writes, because writing there means creating the directory and bringing it to 0700, so a shared "
    + "scratch tree, a directory this user does not own, or a world-writable one is refused with "
    + GP_E_STATE_ROOT_REFUSED
    + " and nothing is written; such a service root is not a place this surface can register "
    + "into, and the fix is to run the service on a root both sides accept): no restart of the service will make it "
    + "read anywhere else, so restarting again changes nothing. "
    + "If they name no --state-dir, the service is on the default root and simply predates this write, and one restart with the command in this notice is what surfaces it.";
}

/** The restart instruction, including the case where kickstart cannot work. */
function restartCommand(): string {
  return `run \`launchctl kickstart -k gui/${currentUid()}/com.glasspane.daemon\` — if that reports the service was not found, the launchd job was never bootstrapped, so ${daemonUnreachableRemedy()}`;
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

// ----- Path boundary (agent-supplied storage roots) -----

/**
 * Second line of defense behind the zod schema: `pid` is stored as a Swift
 * `Int32?`, so writing an out-of-range number does not fail that one entry, it
 * makes the daemon reject the whole file at load (see `inspectStoredEntry`).
 * A value that cannot be stored is refused here rather than surfacing later as
 * a registry that "has no projects". `null` is the explicit clear (B-11) and
 * stores nothing, so it has no range to check.
 */
function assertStorablePid(pid: number | null | undefined): void {
  if (pid === undefined || pid === null) return;
  if (!Number.isInteger(pid) || pid < PID_RANGE[0] || pid > PID_RANGE[1]) {
    throw new ProjectRegistryError(
      GP_E_BAD_PARAMS,
      `pid must be an integer in ${PID_RANGE[0]}..${PID_RANGE[1]} (given: ${pid}) — the background service stores it as a 32-bit process id, and a value outside that range makes it discard every registration in projects.json`,
    );
  }
}

/**
 * Validate + normalize one directory-naming field. These are stored verbatim
 * into projects.json and become the daemon's evidence archive, where it writes
 * new packs and deletes expired ones, so "absolute, traversal-free, and not
 * somebody else's tree" is checked at this boundary rather than assumed
 * downstream. Errors name the accepted shape.
 *
 * The *check* runs on both locations — the path as given and the path it
 * resolves to — so no link above the archive can be walked around. The
 * *diagnosis* is read off the resolved location whenever it has one: an agent
 * told "the temp directory you passed belongs to uid 0" is sent to the wrong
 * fact when the real reason is that a symlink inside it lands in
 * `/private/etc/ssh`. The caller's own string is still shown, in the
 * `(given: "…")` clause that {@link badPath} appends.
 */
function checkAgentPath(field: PathField, value: string): string {
  if (!value.startsWith("/")) {
    throw badPath(field, value, `must be an absolute path (got "${value}")`);
  }
  for (const component of value.split("/")) {
    if (component === "." || component === "..") {
      throw badPath(field, value, `must not contain "." or ".." components (got "${value}")`);
    }
  }
  const logical = path.posix.normalize(value);
  const given = stripFirmlink(logical);
  const resolved = stripFirmlink(resolveExistingAncestor(logical));
  const refusal = strongestRefusal(given === resolved ? [resolved] : [resolved, given], resolved);
  if (refusal !== null) {
    throw badPath(field, value, refusalPhrase(refusal, resolved));
  }
  return logical;
}

/** Why a location is unusable, plus which half of the rule found it. */
interface PathRefusal {
  /**
   * `named` = one of the explicit roots, subtrees and shapes {@link
   * refuseCandidate} lists by hand; `ownership` = the generic
   * nearest-existing-directory argument. Both refuse the call — the source only
   * picks which reason gets reported, see {@link strongestRefusal}.
   */
  readonly source: "named" | "ownership";
  readonly reason: string;
}

/** A refusal plus the location it was read off, and its reporting priority. */
interface LocatedRefusal {
  readonly target: string;
  readonly reason: string;
  /** Higher wins when several apply; see {@link strongestRefusal}. */
  readonly rank: number;
}

/**
 * The most diagnostic of the refusals that apply. A named-rule reason is
 * printed ahead of the generic ownership argument because the two facts have
 * different remedies: the ownership complaint disappears when the caller points
 * the archive at a directory they own, a system-owned tree never becomes
 * usable. Between equal sources the resolved location wins, because that is the
 * directory the daemon would actually write into. Ranking selects wording only
 * — any refusal at all still refuses.
 */
function strongestRefusal(targets: readonly string[], resolved: string): LocatedRefusal | null {
  let best: LocatedRefusal | null = null;
  for (const target of targets) {
    const refusal = refuseCandidate(target);
    if (refusal === null) continue;
    const ranked: LocatedRefusal = {
      target,
      reason: refusal.reason,
      rank: (refusal.source === "named" ? 2 : 0) + (target === resolved ? 1 : 0),
    };
    if (best === null || ranked.rank > best.rank) {
      best = ranked;
    }
  }
  return best;
}

/**
 * Say where the judged location is. "resolves to X" is only a true sentence
 * when X is the resolution, so a refusal that came from the literal string (a
 * shape rule the resolved path does not share) names both instead of
 * mislabelling the given path as if it had been resolved. Both paths are the
 * firmlink-un-mapped form the rules themselves are stated in, so what the
 * caller sees is the string the verdict was made from.
 */
function refusalPhrase(refusal: LocatedRefusal, resolved: string): string {
  if (refusal.target === resolved) {
    return `resolves to ${resolved}, which is ${refusal.reason}`;
  }
  return `is ${refusal.target}, which is ${refusal.reason}; that path resolves to ${resolved}`;
}

function badPath(field: PathField, value: string, problem: string): ProjectRegistryError {
  return new ProjectRegistryError(
    GP_E_BAD_PARAMS,
    `${field} ${problem}. ${PATH_SHAPE_HINT} (given: "${value}")`,
  );
}

const PATH_SHAPE_HINT =
  "An acceptable value is a project-owned directory at least two levels deep, "
  + "e.g. \"/Users/you/work/notes-app/.glasspane/evidence\": absolute, with no \".\" or "
  + "\"..\" components, not world-writable, with its nearest existing directory owned by "
  + "the user running this shell (never a shared tree such as /Users/Shared, another "
  + "user's home, /private/tmp, or a top-level directory of the boot volume), and not the "
  + "filesystem root, a mounted volume root, your home directory, anything under "
  + "~/Library, a dot-directory of your home (`~/.ssh`, `~/.aws`, `~/.gnupg`, "
  + "`~/.config`, `~/.glasspane` and their kin — the daemon chmods whatever is registered "
  + "here to 0700 and writes evidence packs into it, so a credential store or the daemon's "
  + "own state root is the wrong answer twice over), or a system-owned tree "
  + `(${PROTECTED_SUBTREES.join(", ")}) `
  + "— the daemon writes evidence into this directory and deletes expired entries from it";

/**
 * The home dot-directory rule of {@link refuseCandidate}.
 *
 * A path under the home directory is judged by ownership and by the world-writable
 * test, and a home dot-directory passes both: the user owns `~/.ssh`, and it is not
 * world-writable — it is usually 0700, which is *why* it holds what it holds. The
 * registration the daemon then performs on it is `chmod 0700` (already true) plus
 * **writing evidence packs into it** (`EvidenceStore` prunes expired packs from the
 * registered directory), so a mistyped value turns the account's key chain or the
 * daemon's own state root into an archive this shell hands out `gp_export_evidence`
 * from — and the prune half can delete what it finds there.
 *
 * So the boundary is: a *project-owned directory*, which a dot-directory directly
 * under the home is not. `~/work/notes-app/.glasspane/evidence` stays legal (the
 * dot-directory there is two levels below the home, inside a project tree, which is
 * exactly the shape the hint above advertises); `~/.ssh` and everything under it
 * does not.
 */
function refuseHomeDotDirectory(target: string, home: string): PathRefusal | null {
  if (!isInside(home, target) || target === home) {
    return null;
  }
  const first = target.slice(home.length + 1).split("/")[0];
  if (first === undefined || first.length < 2 || first[0] !== ".") {
    return null;
  }
  return named(`a dot-directory of the current user's home directory (~/${first}), which is where that `
    + "account's credentials and client configuration live (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`) or "
    + "the daemon's own private state (`~/.glasspane`); the daemon chmods a registered storage root to 0700 "
    + "and writes evidence packs into it, and prunes expired ones out of it, so this is not a place a project "
    + `archive may be pointed at — name a directory inside the project instead, e.g. "the project tree/${first}"`);
}

/**
 * Why `target` (already firmlink-normalized) is unusable, or null if fine.
 *
 * The named roots and subtrees below are a *deny* list; B-13 adds the positive
 * rule, because the deny list only ever covered four first-level subtrees and
 * a shared tree simply not on it passed — `/Users/Shared/...`, another user's
 * home, `/var/folders/...` — and each of those is a directory where a
 * different user can put a file (or a symlink) that the daemon would then
 * write into and prune. The rule that states the actual trust boundary is:
 * the nearest existing directory on the path must be owned by the uid running
 * this shell and must not be world-writable.
 *
 * The named list is kept rather than folded into that rule for the case the
 * ownership test cannot see: this shell running as uid 0 owns everything, and a
 * system tree is still somebody else's data root. The same blind spot is why
 * {@link refuseHomeDotDirectory} is a named rule and not an ownership one: the
 * user's `~/.ssh` is owned by the user and is not world-writable, so the generic
 * test waves it through — and the registered root is where the daemon then writes.
 *
 * The two halves answer differently, so each tags its reason (see {@link
 * PathRefusal}): the named rules are marked `named` and the ownership fallback
 * `ownership`. The system-tree loop deliberately sits *above* the ownership
 * call rather than beside it — when a symlink hop lands inside `/private/etc`,
 * the ownership check also fires (that tree belongs to uid 0) and would report
 * the weaker, fixable-sounding reason first.
 *
 * The home half of the rule reads {@link systemHome}, i.e. the user record, not
 * `$HOME`. It has to: this is the protection that keeps an agent from pointing
 * the daemon's evidence archive — a directory it writes into and deletes
 * expired packs from — at the user's home or `~/Library`, where the rest of
 * their data lives. Under `$HOME`-derived homes the protected tree moved to
 * wherever the variable pointed, so exporting one variable switched the rule
 * off over the real home; the sandbox kept being guarded while `/Users/<you>`
 * became registrable. Same source as the daemon's own root, for the same reason
 * {@link daemonProjectsPath} uses it.
 */
function refuseCandidate(target: string): PathRefusal | null {
  const home = stripFirmlink(path.posix.normalize(systemHome()));
  if (target === home) return named("the current user's home directory");
  if (isInside(`${home}/Library`, target)) return named("inside the current user's Library folder");
  const homeDot = refuseHomeDotDirectory(target, home);
  if (homeDot !== null) return homeDot;
  if (isProtectedRoot(target)) return named("a protected system root");
  const components = target.split("/").filter((c) => c !== "");
  if (components.length === 0) return named("the filesystem root");
  if (components[0] === "Volumes" && components.length === 2) {
    return named("a top-level mounted volume root");
  }
  if (components.length === 1) return named("a top-level directory of the boot volume");
  for (const tree of PROTECTED_SUBTREES) {
    if (isInside(tree, target)) return named(`inside the system-owned tree ${tree}`);
  }
  const unowned = refuseUnownedTree(target);
  return unowned === null ? null : { source: "ownership", reason: unowned };
}

/** One of the explicitly named roots, subtrees and shapes. */
function named(reason: string): PathRefusal {
  return { source: "named", reason };
}

/** Allow-by-shape ownership rule; see {@link refuseCandidate}. */
function refuseUnownedTree(target: string): string | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const ancestor = nearestExistingAncestor(target);
  if (uid === null) {
    // Refuse, never assume: an unchecked owner is exactly the hole this rule
    // exists to close.
    return `on a platform where this shell has no user id to compare against, so the owner of its nearest existing directory ${ancestor} cannot be checked`;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(ancestor);
  } catch (error) {
    return `under a nearest existing directory ${ancestor} that cannot be inspected (${describeError(error)})`;
  }
  if (stat.uid !== uid) {
    return `not under a directory owned by the current user: its nearest existing directory ${ancestor} belongs to uid ${stat.uid}, not uid ${uid}`;
  }
  if ((stat.mode & 0o022) !== 0) {
    return `under the world-writable directory ${ancestor} (mode ${(stat.mode & 0o777).toString(8)}), where any user can place a file or a link that this archive would then be written into and pruned from`;
  }
  return null;
}

/**
 * The deepest directory on `target` that exists, `"/"` if nothing above it
 * does. The ownership rule needs the *parent* the filesystem will actually
 * honour, not the not-yet-created archive directory named in the call.
 */
function nearestExistingAncestor(target: string): string {
  let cursor = target;
  for (;;) {
    if (fs.existsSync(cursor)) {
      return cursor;
    }
    const parent = path.posix.dirname(cursor);
    if (parent === cursor) return parent;
    cursor = parent;
  }
}

function isProtectedRoot(target: string): boolean {
  return PROTECTED_ROOTS.includes(target);
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function stripFirmlink(target: string): string {
  if (target === FIRMLINK_PREFIX) return "/";
  return target.startsWith(`${FIRMLINK_PREFIX}/`) ? `/${target.slice(FIRMLINK_PREFIX.length + 1)}` : target;
}

/**
 * Resolve symlinks as far as the filesystem allows: `realpath` the nearest
 * existing ancestor and re-append the not-yet-created tail, so a future
 * archive directory cannot be smuggled in through a link. A component that
 * cannot be resolved is walked past (it is simply not created yet).
 */
function resolveExistingAncestor(target: string): string {
  let cursor = target;
  const missingTail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cursor);
      return missingTail.length === 0 ? real : path.posix.join(real, ...missingTail);
    } catch {
      const parent = path.posix.dirname(cursor);
      if (parent === cursor) return target; // walked off the root without resolving
      missingTail.unshift(path.posix.basename(cursor));
      cursor = parent;
    }
  }
}

// ----- Helpers -----

/** Crockford base32 ULID-shaped project ID (P1 spec v1.4 §1.1). */
function generateProjectId(): string {
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const body: string[] = [];
  const bytes = new Uint8Array(26);
  // Node 16+ crypto is safe; use globalThis for older runtimes.
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 26; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < 26; i++) {
    const byte = bytes[i]!;
    body.push(CROCKFORD.charAt(byte % 32));
  }
  return `prj_${body.join("")}`;
}

function nodeErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Thrown for GP_E_PROJECT_LIMIT / GP_E_NOT_FOUND / GP_E_BAD_PARAMS / GP_E_INTERNAL. */
export class ProjectRegistryError extends Error {
  readonly code: string;
  /**
   * The registry layer's own next move, when this fault has one that the code cannot
   * state. `tools.ts` transcribes it instead of deriving a remedy from the code alone
   * (B5): a durability fault and a damaged registry both answer `GP_E_INTERNAL`, and the
   * sentence that is right about the second — "the projects file is the problem … repair
   * or restore the damaged entry" — is a lie about the first, whose own message says "This
   * is the write's own failure, not a verdict about the file's contents". Absent means
   * "the code's arm is the honest answer here", which is what the read-side faults below
   * rely on.
   */
  readonly remedy?: string;
  constructor(code: string, message: string, remedy?: string) {
    super(message);
    this.name = "ProjectRegistryError";
    this.code = code;
    this.remedy = remedy;
  }
}
