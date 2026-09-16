import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Project Registry — MCP-layer access (P1 spec v1.4 §4)
 *
 * This module operates directly on the shared projects.json file.
 * The daemon's Swift ProjectRegistry writes this file; the MCP shell
 * reads/writes the same file with mirrored validation constraints.
 * No socket methods are added (spec 变更说明: "不改变 socket 协议方法表").
 * ------------------------------------------------------------------ */

const CROCKFORD_BODY_RE = "[0-9A-HJKMNP-TV-Z]{26}";
const PROJECT_ID_RE = new RegExp(`^prj_${CROCKFORD_BODY_RE}$`);

const MAX_PROJECTS = 128;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_FIELD_LENGTH = 1024;

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
  pid: z.number().int().nonnegative().optional(),
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

function loadProjects(filePath: string): ProjectEntry[] {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ProjectEntry[];
  } catch {
    return [];
  }
}

function saveProjects(filePath: string, entries: ProjectEntry[]): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: tmp + rename.
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

// ----- Public operations -----

export function projectList(): ProjectEntry[] {
  return loadProjects(projectsPath());
}

export function projectGet(projectId: string): ProjectEntry | undefined {
  const projects = loadProjects(projectsPath());
  return projects.find((p) => p.projectId === projectId);
}

/**
 * Create or update a project.  If `projectId` is undefined, a new entry is
 * created; otherwise the existing entry is updated (GP_E_NOT_FOUND on miss).
 */
export function projectSet(args: ProjectSetArgs): ProjectEntry {
  const filePath = projectsPath();
  const projects = loadProjects(filePath);

  let entry: ProjectEntry;
  const projectId = args.projectId;

    if (projectId) {
    // Update.
    const idx = projects.findIndex((p) => p.projectId === projectId);
    if (idx === -1) {
      throw new ProjectRegistryError("GP_E_NOT_FOUND", `unknown projectId ${projectId}`);
    }
    const existing = projects[idx];
    entry = {
      ...existing,
      displayName: args.displayName,
      ...(args.bundleId !== undefined ? { bundleId: args.bundleId } : {}),
      ...(args.pid !== undefined ? { pid: args.pid } : {}),
      ...(args.recipeConfigPath !== undefined ? { recipeConfigPath: args.recipeConfigPath } : {}),
      ...(args.calibrationAssetsPath !== undefined ? { calibrationAssetsPath: args.calibrationAssetsPath } : {}),
      ...(args.evidenceStoragePath !== undefined ? { evidenceStoragePath: args.evidenceStoragePath } : {}),
    } as ProjectEntry;
    projects[idx] = entry;
  } else {
    // Create.
    if (projects.length >= MAX_PROJECTS) {
      throw new ProjectRegistryError("GP_E_PROJECT_LIMIT", `project limit reached (${MAX_PROJECTS})`);
    }
    const projectId = generateProjectId();
    entry = {
      projectId,
      displayName: args.displayName,
      bundleId: args.bundleId,
      pid: args.pid,
      recipeConfigPath: args.recipeConfigPath,
      calibrationAssetsPath: args.calibrationAssetsPath,
      evidenceStoragePath: args.evidenceStoragePath,
      createdAt: new Date().toISOString(),
    };
    projects.push(entry);
  }

  saveProjects(filePath, projects);
  return entry;
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

/** Thrown for GP_E_PROJECT_LIMIT / GP_E_NOT_FOUND / GP_E_BAD_PARAMS. */
export class ProjectRegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectRegistryError";
    this.code = code;
  }
}
