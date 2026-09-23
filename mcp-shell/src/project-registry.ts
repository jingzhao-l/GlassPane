import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  GP_E_BAD_PARAMS,
  GP_E_INTERNAL,
  GP_E_NOT_FOUND,
  GP_E_PROJECT_LIMIT,
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

const MAX_PROJECTS = 128;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_FIELD_LENGTH = 1024;

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
 * The file the *daemon* reads — `ProjectRegistry.defaultProjectsPath` in Swift.
 * It has no override of its own: {@link PROJECTS_FILE_ENV} is parsed by this
 * shell alone (R7-14), so a write aimed elsewhere is a write nothing loads.
 */
export function daemonProjectsPath(): string {
  return path.join(os.homedir(), ".glasspane", "projects.json");
}

/**
 * APFS firmlink: on a boot-volume-relative resolve, `/Users`, `/Applications`
 * and `/Volumes` come back as `/System/Volumes/Data/...`. Un-map that first,
 * or every real home-directory path would read as "inside /System".
 */
const FIRMLINK_PREFIX = "/System/Volumes/Data";

/** Escape hatch for the corrupt-registry case; see `unreadableMessage`. */
export const FORCE_OVERWRITE_ENV = "GLASSPANE_PROJECTS_FORCE_OVERWRITE";

/** Shell-only override of the projects file: the daemon never reads it (R7-14). */
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
  bundleId: z.string().max(256).nullish(),
  pid: z.number().int().min(PID_RANGE[0]).max(PID_RANGE[1]).nullish(),
  recipeConfigPath: z.string().max(MAX_FIELD_LENGTH).nullish(),
  calibrationAssetsPath: z.string().max(MAX_FIELD_LENGTH).nullish(),
  evidenceStoragePath: z.string().max(MAX_FIELD_LENGTH).nullish(),
});
export type ProjectSetArgs = z.infer<typeof ProjectSetArgs>;

// ----- File access -----

function projectsPath(): string {
  const envPath = process.env[PROJECTS_FILE_ENV];
  if (envPath) return envPath;
  return daemonProjectsPath();
}

/**
 * Registry load result. `failure` is a description of why the file cannot be
 * trusted (`null` = it can, including the never-written case); an empty
 * `projects` array with a failure must never be read as "no projects".
 */
interface RegistrySnapshot {
  projects: ProjectEntry[];
  failure: string | null;
}

function loadRegistry(filePath: string): RegistrySnapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return { projects: [], failure: null }; // nothing registered yet
    }
    return { projects: [], failure: `cannot be read (${describeError(error)})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { projects: [], failure: `is not valid JSON (${describeError(error)})` };
  }
  if (!Array.isArray(parsed)) {
    return { projects: [], failure: "is not a JSON array of projects" };
  }

  const projects: ProjectEntry[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const problem = inspectStoredEntry(parsed[i], i);
    if (problem !== null) {
      return { projects: [], failure: problem };
    }
    projects.push(parsed[i] as ProjectEntry);
  }
  return { projects, failure: null };
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
 */
function requireUsableRegistry(filePath: string, snapshot: RegistrySnapshot): { projects: ProjectEntry[]; discarded?: string } {
  if (snapshot.failure === null) {
    return { projects: snapshot.projects };
  }
  if (process.env[FORCE_OVERWRITE_ENV] !== "1") {
    throw new ProjectRegistryError(GP_E_INTERNAL, unreadableMessage(filePath, snapshot.failure));
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
  return { projects: [], discarded };
}

function unreadableMessage(filePath: string, failure: string): string {
  return `projects.json at ${filePath} ${failure}. gp_project_set refused to write it: replacing an unreadable registry discards every registration in it. See the damage with \`python3 -m json.tool ${filePath}\` and repair that file, or set ${FORCE_OVERWRITE_ENV}=1 and retry to rebuild the registry from scratch — the unloadable file is moved aside as ${filePath}.unreadable-<id> rather than deleted, and every existing project entry is lost.`;
}

function readFailureMessage(filePath: string, failure: string): string {
  return `projects.json at ${filePath} ${failure}. This is a read failure, not an empty registry: the entries that are registered cannot be listed. See the damage with \`python3 -m json.tool ${filePath}\`, then repair or replace that file. To rebuild the registry from scratch instead — which costs every existing entry — set ${FORCE_OVERWRITE_ENV}=1 and call gp_project_set again.`;
}

function saveProjects(filePath: string, entries: ProjectEntry[]): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: tmp + rename. The temp name is unique per write — three
  // different processes rewrite this file (daemon CLI, shell tools, panel),
  // and a shared `<file>.tmp` lets one writer rename another's half-written
  // buffer into place.
  const tmpPath = `${filePath}.tmp-${uniqueToken()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* temp already gone, or never created */
    }
    throw error;
  }
}

let tokenCounter = 0;
function uniqueToken(): string {
  tokenCounter += 1;
  return `${process.pid}-${Date.now().toString(36)}-${tokenCounter.toString(36)}-${randomBytes(4).toString("hex")}`;
}

// ----- Public operations -----

export function projectList(): ProjectEntry[] {
  const filePath = projectsPath();
  const snapshot = loadRegistry(filePath);
  if (snapshot.failure !== null) {
    throw new ProjectRegistryError(GP_E_INTERNAL, readFailureMessage(filePath, snapshot.failure));
  }
  return snapshot.projects;
}

export function projectGet(projectId: string): ProjectEntry | undefined {
  const projects = projectList();
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
export function projectSet(args: ProjectSetArgs): ProjectSetResult {
  const filePath = projectsPath();
  assertStorablePid(args.pid);
  const snapshot = loadRegistry(filePath);
  const { projects, discarded } = requireUsableRegistry(filePath, snapshot);

  let entry: ProjectEntry;
  const projectId = args.projectId;

  if (projectId) {
    // Update: the patch is applied to the stored entry, never to a blank one.
    const existing = projects.find((p) => p.projectId === projectId);
    if (existing === undefined) {
      throw new ProjectRegistryError(GP_E_NOT_FOUND, `unknown projectId ${projectId}`);
    }
    entry = applyPatch(existing, args);
    assertSingleIdentity(entry);
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
    assertSingleIdentity(entry);
    projects.push(entry);
  }

  saveProjects(filePath, projects);
  return {
    ...entry,
    requiresDaemonRestart: true,
    daemonRestartNotice: daemonRestartNotice(filePath),
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
 */
function assertSingleIdentity(entry: ProjectEntry): void {
  const hasBundleId = entry.bundleId !== undefined;
  const hasPid = entry.pid !== undefined;
  if (hasBundleId && hasPid) {
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
 * One user-facing sentence for the tool result. The panel already keeps "the
 * file is written" apart from "the running service can act on it"; the MCP
 * surface needs the same distinction because gp_attach is answered by the
 * daemon's in-memory copy of this file.
 *
 * B-10: computed from the facts instead of asserted blindly, because the old
 * text was wrong in two ways. It promised that a restart makes the entry
 * visible for *any* path this shell had just written, while the daemon only
 * ever loads {@link daemonProjectsPath} — under {@link PROJECTS_FILE_ENV} the
 * shell is writing a file nothing reads, and no restart fixes that. And it
 * prescribed a raw `launchctl kickstart`, which cannot work for a job that was
 * never bootstrapped; the shell already has a helper that hands over a restore
 * command covering that case, so the notice defers to it.
 */
export function daemonRestartNotice(filePath: string): string {
  const daemonPath = daemonProjectsPath();
  if (path.resolve(filePath) !== path.resolve(daemonPath)) {
    return `Saved in ${filePath}, but the background service never reads that file: it loads ${daemonPath} once when it starts (${PROJECTS_FILE_ENV} is honoured by this MCP shell only, not by the daemon), so gp_attach will keep returning GP_E_NOT_FOUND for this projectId and restarting the service will not help. Repeat the registration against ${daemonPath} — unset ${PROJECTS_FILE_ENV} for the shell, or write the entry where the daemon looks — and only then restart the background service so it reloads: ${restartCommand()}`;
  }
  return `Saved in ${filePath}, but the running background service loaded that file once when it started, so gp_attach will keep returning GP_E_NOT_FOUND for this projectId until the service restarts: ${restartCommand()}`;
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
  + `~/Library, or a system-owned tree (${PROTECTED_SUBTREES.join(", ")}) `
  + "— the daemon writes evidence into this directory and deletes expired entries from it";

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
 * system tree is still somebody else's data root.
 *
 * The two halves answer differently, so each tags its reason (see {@link
 * PathRefusal}): the named rules are marked `named` and the ownership fallback
 * `ownership`. The system-tree loop deliberately sits *above* the ownership
 * call rather than beside it — when a symlink hop lands inside `/private/etc`,
 * the ownership check also fires (that tree belongs to uid 0) and would report
 * the weaker, fixable-sounding reason first.
 */
function refuseCandidate(target: string): PathRefusal | null {
  const home = stripFirmlink(path.posix.normalize(os.homedir()));
  if (target === home) return named("the current user's home directory");
  if (isInside(`${home}/Library`, target)) return named("inside the current user's Library folder");
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
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectRegistryError";
    this.code = code;
  }
}
