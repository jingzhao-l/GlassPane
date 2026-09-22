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

/** Trees owned by the system/other installs: nothing here is project data. */
const PROTECTED_SUBTREES: readonly string[] = [
  "/Applications", "/System", "/Library", "/private/etc",
];

/**
 * APFS firmlink: on a boot-volume-relative resolve, `/Users`, `/Applications`
 * and `/Volumes` come back as `/System/Volumes/Data/...`. Un-map that first,
 * or every real home-directory path would read as "inside /System".
 */
const FIRMLINK_PREFIX = "/System/Volumes/Data";

/** Escape hatch for the corrupt-registry case; see `unreadableMessage`. */
export const FORCE_OVERWRITE_ENV = "GLASSPANE_PROJECTS_FORCE_OVERWRITE";

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
 * being followed by an unexplained GP_E_NOT_FOUND.
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
  bundleId: z.string().max(256).optional(),
  pid: z.number().int().min(PID_RANGE[0]).max(PID_RANGE[1]).optional(),
  recipeConfigPath: z.string().max(MAX_FIELD_LENGTH).optional(),
  calibrationAssetsPath: z.string().max(MAX_FIELD_LENGTH).optional(),
  evidenceStoragePath: z.string().max(MAX_FIELD_LENGTH).optional(),
}).refine(
  (v) => (v.bundleId !== undefined) !== (v.pid !== undefined),
  { message: "exactly one of bundleId or pid is required" },
);
export type ProjectSetArgs = z.infer<typeof ProjectSetArgs>;

// ----- File access -----

function projectsPath(): string {
  const envPath = process.env["GLASSPANE_PROJECTS_FILE"];
  if (envPath) return envPath;
  return path.join(os.homedir(), ".glasspane", "projects.json");
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
 * Path fields are validated before anything is written, and the result states
 * explicitly that the running daemon has not seen the change yet.
 */
export function projectSet(args: ProjectSetArgs): ProjectSetResult {
  const filePath = projectsPath();
  assertStorablePid(args.pid);
  const patch = validatedPathFields(args);
  const snapshot = loadRegistry(filePath);
  const { projects, discarded } = requireUsableRegistry(filePath, snapshot);

  let entry: ProjectEntry;
  const projectId = args.projectId;

  if (projectId) {
    // Update.
    const idx = projects.findIndex((p) => p.projectId === projectId);
    if (idx === -1) {
      throw new ProjectRegistryError(GP_E_NOT_FOUND, `unknown projectId ${projectId}`);
    }
    const existing = projects[idx];
    entry = {
      ...existing,
      displayName: args.displayName,
      ...(args.bundleId !== undefined ? { bundleId: args.bundleId } : {}),
      ...(args.pid !== undefined ? { pid: args.pid } : {}),
      ...patch,
    } as ProjectEntry;
    projects[idx] = entry;
  } else {
    // Create.
    if (projects.length >= MAX_PROJECTS) {
      throw new ProjectRegistryError(GP_E_PROJECT_LIMIT, `project limit reached (${MAX_PROJECTS})`);
    }
    const created = generateProjectId();
    entry = {
      projectId: created,
      displayName: args.displayName,
      bundleId: args.bundleId,
      pid: args.pid,
      ...patch,
      createdAt: new Date().toISOString(),
    };
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
 * One user-facing sentence for the tool result. The panel already keeps "the
 * file is written" apart from "the running service can act on it"; the MCP
 * surface needs the same distinction because gp_attach is answered by the
 * daemon's in-memory copy of this file.
 */
function daemonRestartNotice(filePath: string): string {
  return `Saved in ${filePath}, but the running background service loaded that file once when it started, so gp_attach will keep returning GP_E_NOT_FOUND for this projectId until the service restarts — run \`launchctl kickstart -k gui/${currentUid()}/com.glasspane.daemon\` (or the settings panel's restart control) first.`;
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
 * a registry that "has no projects".
 */
function assertStorablePid(pid: number | undefined): void {
  if (pid === undefined) return;
  if (!Number.isInteger(pid) || pid < PID_RANGE[0] || pid > PID_RANGE[1]) {
    throw new ProjectRegistryError(
      GP_E_BAD_PARAMS,
      `pid must be an integer in ${PID_RANGE[0]}..${PID_RANGE[1]} (given: ${pid}) — the background service stores it as a 32-bit process id, and a value outside that range makes it discard every registration in projects.json`,
    );
  }
}

/**
 * Validate + normalize the three directory-naming fields. These are stored
 * verbatim into projects.json and become the daemon's evidence archive, where
 * it writes new packs and deletes expired ones, so "absolute, traversal-free,
 * and not somebody else's tree" is checked at this boundary rather than
 * assumed downstream. Errors name the accepted shape.
 */
function validatedPathFields(args: ProjectSetArgs): Partial<ProjectEntry> {
  const out: Partial<ProjectEntry> = {};
  for (const field of PATH_FIELDS) {
    const value = args[field];
    if (value !== undefined) out[field] = checkAgentPath(field, value);
  }
  return out;
}

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
  const candidates = new Set([stripFirmlink(logical), stripFirmlink(resolveExistingAncestor(logical))]);
  for (const candidate of candidates) {
    const refusal = refuseProtected(candidate);
    if (refusal !== null) {
      throw badPath(field, value, `resolves to ${candidate}, which is ${refusal}`);
    }
  }
  return logical;
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
  + "\"..\" components, and not the filesystem root, a top-level directory (/private, "
  + "/tmp, /Volumes...), a mounted volume root, your home directory, anything under "
  + "~/Library, or a system-owned tree (/Applications, /System, /Library, /private/etc) "
  + "— the daemon writes evidence into this directory and deletes expired entries from it";

/** Why `target` (already firmlink-normalized) is unusable, or null if fine. */
function refuseProtected(target: string): string | null {
  const home = stripFirmlink(path.posix.normalize(os.homedir()));
  if (target === home) return "the current user's home directory";
  if (isInside(`${home}/Library`, target)) return "inside the current user's Library folder";
  if (isProtectedRoot(target)) return "a protected system root";
  const components = target.split("/").filter((c) => c !== "");
  if (components.length === 0) return "the filesystem root";
  if (components[0] === "Volumes" && components.length === 2) {
    return "a top-level mounted volume root";
  }
  if (components.length === 1) return "a top-level directory of the boot volume";
  for (const tree of PROTECTED_SUBTREES) {
    if (isInside(tree, target)) return `inside the system-owned tree ${tree}`;
  }
  return null;
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
