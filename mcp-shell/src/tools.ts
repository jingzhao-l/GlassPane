import { z } from "zod";
import {
  SelectorSchema,
  ActionSchema,
  AssertionPropertySchema,
  parseEvidencePack,
  KernelSchemaError,
  type Selector,
  type Action,
  type AssertionProperty,
  type EvidencePack,
} from "@iterate/kernel";

import { canonicalJson } from "./canonical.js";
import { EngineCallError, EngineJsonRpcClient } from "./engine-client.js";
import { formatToolError, formatToolErrorShape, GP_E_BAD_PARAMS, GP_E_INTERNAL, GP_E_NO_EVIDENCE, GP_E_NOT_FOUND, GP_E_PROJECT_LIMIT } from "./errors.js";
import { EvidenceAuditSession } from "./audit-session.js";
import { renderHTML, renderMarkdown, escapeHTML } from "./evidence-report.js";
import {
  ProjectListArgs,
  ProjectSetArgs,
  ProjectGetArgs,
  projectList,
  projectSet,
  projectGet,
  ProjectRegistryError,
} from "./project-registry.js";

/* ------------------------------------------------------------------ *
 * Tool‑argument validation schemas (spec §6.2). The engine validates
 * daemon‑side too; this shell pre‑validates so bad args surface as
 * isError without touching the engine. <selector> reuses kernel rule.
 * ------------------------------------------------------------------ */

const OptionalUintSchema = z.number().int().nonnegative().optional();
const OptionalDepthSchema = z.number().int().min(1).max(10).optional();
const OptionalRoleSchema = z.string().max(128).optional();
const OptionalBundleIdSchema = z.string().max(256).optional();
const OptionalOperationIdSchema = z.string().regex(/^op_[0-9A-HJKMNP-TV-Z]{26}$/).optional();
const OptionalProjectIdSchema = z.string().regex(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/).optional();

const ExpectSchema = z.union([z.string().max(512), z.boolean()]);

/** Crockford base32 body shared by op_/snap_ ids (P0 §4.1 / P1 v1.1 §1.2). */
const SnapshotIdSchema = z.string().regex(/^snap_[0-9A-HJKMNP-TV-Z]{26}$/);

const ActStepSchema = z.strictObject({
  selector: SelectorSchema,
  action: ActionSchema,
});
const RestoreStepsSchema = z.array(ActStepSchema).min(1).max(64).optional();
const RestoreModeSchema = z.string().max(32).optional();

export const AttachArgs = z.strictObject({
  bundleId: OptionalBundleIdSchema,
  pid: OptionalUintSchema,
  projectId: OptionalProjectIdSchema,
}).refine((v) => v.bundleId !== undefined || v.pid !== undefined, {
  message: "attach requires either bundleId or pid",
});
export type AttachArgs = z.infer<typeof AttachArgs>;

export const ObserveArgs = z.strictObject({
  maxDepth: OptionalDepthSchema,
  role: OptionalRoleSchema,
});
export type ObserveArgs = z.infer<typeof ObserveArgs>;

export const ActArgs = z.strictObject({
  selector: SelectorSchema,
  action: ActionSchema,
});
export type ActArgs = z.infer<typeof ActArgs>;

export const AssertElementArgs = z.strictObject({
  selector: SelectorSchema,
  property: AssertionPropertySchema,
  expected: ExpectSchema,
});
export type AssertElementArgs = z.infer<typeof AssertElementArgs>;

export const DiagnoseArgs = z.strictObject({
  operationId: OptionalOperationIdSchema,
});
export type DiagnoseArgs = z.infer<typeof DiagnoseArgs>;

export const LastEvidenceArgs = z.strictObject({
  operationId: OptionalOperationIdSchema,
});
export type LastEvidenceArgs = z.infer<typeof LastEvidenceArgs>;

export const SnapshotArgs = z.strictObject({
  maxDepth: OptionalDepthSchema,
});
export type SnapshotArgs = z.infer<typeof SnapshotArgs>;

export const RestoreArgs = z.strictObject({
  snapshotId: SnapshotIdSchema,
  steps: RestoreStepsSchema,
  mode: RestoreModeSchema,
});
export type RestoreArgs = z.infer<typeof RestoreArgs>;

/** Report format selector shared by the two audit tools (spec v1.3 §10.3). */
const ReportFormatSchema = z.enum(["html", "markdown"]).default("markdown");

export const ExportEvidenceArgs = z.strictObject({
  operationId: z.string().regex(/^op_[0-9A-HJKMNP-TV-Z]{26}$/),
  format: ReportFormatSchema,
});
export type ExportEvidenceArgs = z.infer<typeof ExportEvidenceArgs>;

export const RecentReportsArgs = z.strictObject({
  limit: z.number().int().min(1).max(20).default(5),
  format: ReportFormatSchema,
});
export type RecentReportsArgs = z.infer<typeof RecentReportsArgs>;

/* ------------------------------------------------------------------ *
 * Tool table (spec §6.2). Each tool maps to one engine method and passes
 * its validated arguments straight through as engine params.
 * ------------------------------------------------------------------ */

export interface ToolSpec {
  name: string;
  description: string;
  /** Engine method forwarded after validation; pseudo-method for orchestrated tools. */
  engineMethod: string;
  /** JSON Schema emitted by tools/list (hand-written contract, spec §6.2). */
  inputSchema: Record<string, unknown>;
  validate: (args: unknown) => { ok: true; value: Record<string, unknown> } | {
    ok: false;
    issues: string;
  };
  /**
   * Orchestrated tools (spec v1.3 §10.3) run their own logic instead of the
   * default forward-then-relay path — e.g. the audit tools fetch evidence
   * packs and render them through the report generator.
   */
  execute?: (args: Record<string, unknown>, context: ToolExecuteContext) => Promise<ToolResult>;
}

export interface ToolExecuteContext {
  engine: EngineJsonRpcClient;
  session: EvidenceAuditSession;
}

/** Tool result shape shared by the default path and custom executors. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

function zodIssueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

function zodBridge<Args extends z.ZodTypeAny>(schema: Args): ToolSpec["validate"] {
  return (raw: unknown) => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      return { ok: true as const, value: parsed.data as Record<string, unknown> };
    }
    return { ok: false as const, issues: zodIssueText(parsed.error) };
  };
}

/* Hand-written JSON Schemas (draft 2020-12) for tools/list. Kept minimal
 * but faithful to the zod rules above. `$schema` omitted for brevity; the
 * spec only asserts the "要点" (outline) of each input schema (§6.2). */

const selectorJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    role: { type: "string", maxLength: 512 },
    title: { type: "string", maxLength: 512 },
    identifier: { type: "string", maxLength: 512 },
  },
  required: ["role"],
} as const;

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "gp_attach",
    description: "Attach the engine to a running app by bundleId or pid.",
    engineMethod: "attach",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        bundleId: { type: "string", maxLength: 256 },
        pid: { type: "integer", minimum: 0 },
        projectId: { type: "string", pattern: "^prj_[0-9A-HJKMNP-TV-Z]{26}$" },
      },
      oneOf: [
        { required: ["bundleId"] },
        { required: ["pid"] },
      ],
    },
    validate: zodBridge(AttachArgs),
  },
  {
    name: "gp_observe",
    description: "Snapshot the attached app's accessibility tree.",
    engineMethod: "observe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxDepth: { type: "integer", minimum: 1, maximum: 10 },
        role: { type: "string", maxLength: 128 },
      },
    },
    validate: zodBridge(ObserveArgs),
  },
  {
    name: "gp_act",
    description: "Perform a UI action on the attached app and confirm it.",
    engineMethod: "act",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        selector: selectorJsonSchema,
        action: {
          type: "string",
          enum: ["press", "increment", "decrement", "showMenu", "confirm", "cancel", "pick"],
        },
      },
      required: ["selector", "action"],
    },
    validate: zodBridge(ActArgs),
  },
  {
    name: "gp_assert_element",
    description: "Assert a property of an element in the attached app.",
    engineMethod: "assert_element",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        selector: selectorJsonSchema,
        property: { type: "string", enum: ["title", "value", "role", "enabled", "focused"] },
        expected: { oneOf: [{ type: "string", maxLength: 512 }, { type: "boolean" }] },
      },
      required: ["selector", "property", "expected"],
    },
    validate: zodBridge(AssertElementArgs),
  },
  {
    name: "gp_diagnose",
    description: "Diagnose the most recent (or the given) operation.",
    engineMethod: "diagnose",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operationId: { type: "string", pattern: "^op_[0-9A-HJKMNP-TV-Z]{26}$" },
      },
    },
    validate: zodBridge(DiagnoseArgs),
  },
  {
    name: "gp_last_evidence",
    description: "Return the full evidence pack for the most recent (or given) operation.",
    engineMethod: "last_evidence",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operationId: { type: "string", pattern: "^op_[0-9A-HJKMNP-TV-Z]{26}$" },
      },
    },
    validate: zodBridge(LastEvidenceArgs),
  },
  {
    name: "gp_snapshot",
    description: "Capture a digest-only baseline of the attached app's AX tree for later restore.",
    engineMethod: "snapshot",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxDepth: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
    validate: zodBridge(SnapshotArgs),
  },
  {
    name: "gp_restore",
    description: "Restore from a snapshot: replay act steps over the baseline (tier-2 ffwd), or compare the current tree against it when steps are omitted.",
    engineMethod: "restore",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        snapshotId: { type: "string", pattern: "^snap_[0-9A-HJKMNP-TV-Z]{26}$" },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              selector: selectorJsonSchema,
              action: {
                type: "string",
                enum: ["press", "increment", "decrement", "showMenu", "confirm", "cancel", "pick"],
              },
            },
            required: ["selector", "action"],
          },
        },
        mode: { type: "string", maxLength: 32 },
      },
      required: ["snapshotId"],
    },
    validate: zodBridge(RestoreArgs),
  },
  {
    name: "gp_export_evidence",
    description: "Render one operation's evidence pack as a human-readable report (HTML or Markdown) for the developer audit view.",
    engineMethod: "export_evidence",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operationId: { type: "string", pattern: "^op_[0-9A-HJKMNP-TV-Z]{26}$" },
        format: { type: "string", enum: ["html", "markdown"] },
      },
      required: ["operationId"],
    },
    validate: zodBridge(ExportEvidenceArgs),
    execute: exportEvidence,
  },
  {
    name: "gp_recent_reports",
    description: "Aggregate the most recent operations' four-section reports (HTML or Markdown) into one audit view.",
    engineMethod: "recent_reports",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20 },
        format: { type: "string", enum: ["html", "markdown"] },
      },
    },
    validate: zodBridge(RecentReportsArgs),
    execute: recentReports,
  },
  {
    name: "gp_project_list",
    description: "List all registered GlassPane projects (P1 spec v1.4).",
    engineMethod: "project_list",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    validate: zodBridge(ProjectListArgs),
    execute: projectListTool,
  },
  {
    name: "gp_project_set",
    description: "Create or update a GlassPane project. Omit projectId to register a new project; include it to update an existing one.",
    engineMethod: "project_set",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", pattern: "^prj_[0-9A-HJKMNP-TV-Z]{26}$" },
        displayName: { type: "string", minLength: 1, maxLength: 256 },
        bundleId: { type: "string", maxLength: 256 },
        pid: { type: "integer", minimum: 0 },
        recipeConfigPath: { type: "string", maxLength: 1024 },
        calibrationAssetsPath: { type: "string", maxLength: 1024 },
        evidenceStoragePath: { type: "string", maxLength: 1024 },
      },
      required: ["displayName"],
      oneOf: [
        { required: ["bundleId"] },
        { required: ["pid"] },
      ],
    },
    validate: zodBridge(ProjectSetArgs),
    execute: projectSetTool,
  },
  {
    name: "gp_project_get",
    description: "Fetch one GlassPane project by its project ID.",
    engineMethod: "project_get",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", pattern: "^prj_[0-9A-HJKMNP-TV-Z]{26}$" },
      },
      required: ["projectId"],
    },
    validate: zodBridge(ProjectGetArgs),
    execute: projectGetTool,
  },
];

export const TOOL_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(
  TOOL_SPECS.map((spec) => [spec.name, spec]),
);

/* ------------------------------------------------------------------ *
 * Tools/call execution (spec §6.2): pre-validate -> forward -> map error.
 * ------------------------------------------------------------------ */

/**
 * Execute a tool against the engine client. Validates arguments against
 * the tool's zod schema (isError + GP_E_BAD_PARAMS on failure), then either
 * runs the tool's own `execute` (orchestrated tools) or forwards the method
 * to the engine and maps engine/connection errors to agent-facing errors.
 */
export async function executeTool(
  spec: ToolSpec,
  args: unknown,
  engine: EngineJsonRpcClient,
  session: EvidenceAuditSession = new EvidenceAuditSession(),
): Promise<ToolResult> {
  const checked = spec.validate(args);
  if (!checked.ok) {
    return {
      content: [{ type: "text", text: formatToolError(
        GP_E_BAD_PARAMS,
        `invalid arguments for ${spec.name}`,
        `check the tool's input schema; ${checked.issues}`,
      ) }],
      isError: true,
    };
  }

  if (spec.execute !== undefined) {
    return spec.execute(checked.value, { engine, session });
  }

  try {
    const raw = await engine.call(spec.engineMethod, checked.value);
    if (spec.name === "gp_attach") {
      // A successful attach invalidates the daemon's evidence history, so
      // the session trail starts fresh (spec v1.3 §10.3).
      session.reset();
    }
    // Spec §6.3: evidence packs are passed through a strong validation via
    // the kernel schema before surfacing to the agent, so a Swift↔TS drift
    // (assertion C35) fails here as a tool error instead of corrupt JSON.
    if (spec.engineMethod === "last_evidence") {
      parseEvidenceFrame(raw);
    }
    session.record(raw);
    return {
      content: [{ type: "text", text: canonicalJson(raw) }],
      isError: false,
    };
  } catch (error) {
    if (error instanceof EngineCallError) {
      return {
        content: [{ type: "text", text: formatToolErrorShape(error.toBody()) }],
        isError: true,
      };
    }
    if (error instanceof KernelSchemaError) {
      return {
        content: [{ type: "text", text: formatToolError(
          GP_E_INTERNAL,
          `engine returned an invalid evidence pack: ${error.message}`,
          "engine and kernel schema drifted; fix the common fixtures (assertion C35)",
        ) }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: formatToolError(
        GP_E_INTERNAL,
        `internal shell error: ${String(error)}`,
        "see the MCP server logs and retry",
      ) }],
      isError: true,
    };
  }
}

/**
 * Strongly validates the engine's last_evidence result (§6.3) and returns
 * the parsed pack. The engine frame is `{evidencePack: {…}}`; the kernel
 * validator consumes the pack body directly and throws on any violation.
 */
function parseEvidenceFrame(raw: unknown): EvidencePack {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new KernelSchemaError("evidence pack", [{
      path: "evidencePack",
      message: "expected an object frame with a nested evidencePack field",
    }]);
  }
  const frame = raw as Record<string, unknown>;
  if (typeof frame.evidencePack !== "object" || frame.evidencePack === null) {
    throw new KernelSchemaError("evidence pack", [{
      path: "evidencePack",
      message: "missing evidencePack field in last_evidence result",
    }]);
  }
  return parseEvidencePack(frame.evidencePack);
}

/* ------------------------------------------------------------------ *
 * Project tools (spec v1.4 §4): operate on the shared projects.json at
 * the MCP layer — no socket methods are added ("不改变 socket 协议方法表").
 * ------------------------------------------------------------------ */

async function projectListTool(): Promise<ToolResult> {
  const projects = projectList();
  return {
    content: [{ type: "text", text: canonicalJson({ projects }) }],
    isError: false,
  };
}

async function projectSetTool(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const entry = projectSet(args as ProjectSetArgs);
    return { content: [{ type: "text", text: canonicalJson({ project: entry }) }], isError: false };
  } catch (error) {
    return mapProjectError(error);
  }
}

async function projectGetTool(args: Record<string, unknown>): Promise<ToolResult> {
  const argv = args as ProjectGetArgs;
  const entry = projectGet(argv.projectId);
  if (entry === undefined) {
    return {
      content: [{ type: "text", text: formatToolError(
        "GP_E_NOT_FOUND",
        `unknown project ${argv.projectId}`,
        "check the projectId; use gp_project_list to view available projects",
      ) }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: canonicalJson({ project: entry }) }], isError: false };
}

function mapProjectError(error: unknown): ToolResult {
  if (error instanceof ProjectRegistryError) {
    return {
      content: [{ type: "text", text: formatToolError(
        error.code,
        error.message,
        error.code === GP_E_PROJECT_LIMIT
          ? "delete unused projects first, then retry"
          : error.code === GP_E_NOT_FOUND
            ? "check the projectId; use gp_project_list to view available projects"
            : "check the tool's input schema and retry",
      ) }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: formatToolError(
      GP_E_INTERNAL,
      `internal shell error in project registry: ${String(error)}`,
      "see the MCP server logs and retry",
    ) }],
    isError: true,
  };
}

/* ------------------------------------------------------------------ *
 * Audit tools (spec v1.3 §10.3): fetch-centred renderers over the frozen
 * daemon method table — `last_evidence {operationId}` (no new daemon method,
 * no schema change). Shared rendering with the Swift engine mirror keeps the
 * HTML/Markdown contract under one golden test set.
 * ------------------------------------------------------------------ */

async function exportEvidence(
  args: Record<string, unknown>,
  context: ToolExecuteContext,
): Promise<ToolResult> {
  const argv = args as ExportEvidenceArgs;
  const render = argv.format === "html" ? renderHTML : renderMarkdown;
  try {
    const raw = await context.engine.call("last_evidence", { operationId: argv.operationId });
    const pack = parseEvidenceFrame(raw);
    context.session.record(raw);
    return { content: [{ type: "text", text: render(pack, undefined) }], isError: false };
  } catch (error) {
    return mapAuditError(error);
  }
}

async function recentReports(
  args: Record<string, unknown>,
  context: ToolExecuteContext,
): Promise<ToolResult> {
  const argv = args as RecentReportsArgs;
  const ids = context.session.recentIds(argv.limit);
  if (ids.length === 0) {
    return {
      content: [{ type: "text", text: formatToolError(
        GP_E_NO_EVIDENCE,
        "no operations recorded in this session",
        "run gp_act / gp_assert_element first, then retry gp_recent_reports",
      ) }],
      isError: true,
    };
  }

  // Fetch each trail id; the daemon's bounded history may have evicted it or
  // the engine may have restarted, so per-item misses are skipped with a
  // note instead of failing the whole report.
  const packs: Array<{ id: string; pack: EvidencePack }> = [];
  const skipped: string[] = [];
  for (const id of ids) {
    try {
      const raw = await context.engine.call("last_evidence", { operationId: id });
      packs.push({ id, pack: parseEvidenceFrame(raw) });
    } catch (error) {
      if (error instanceof EngineCallError && error.code === GP_E_NO_EVIDENCE) {
        skipped.push(id);
      } else {
        return mapAuditError(error);
      }
    }
  }

  if (packs.length === 0) {
    return {
      content: [{ type: "text", text: formatToolError(
        GP_E_NO_EVIDENCE,
        "no recent evidence is reachable in the daemon history",
        "the engine may have restarted; re-run gp_act / gp_assert_element to regenerate evidence",
      ) }],
      isError: true,
    };
  }

  const render = argv.format === "html" ? renderHTML : renderMarkdown;
  const header = argv.format === "html"
    ? `<h1>GlassPane recent reports (${packs.length})</h1>`
    : `# GlassPane recent reports (${packs.length})`;
  const skipNote = skipped.length === 0 ? "" : argv.format === "html"
    ? `<p class="gp-skipped">skipped ${skipped.length} unreachable ${skipped.length === 1 ? "entry" : "entries"}: ${escapeHTML(skipped.join(", "))}</p>`
    : `> skipped ${skipped.length} unreachable ${skipped.length === 1 ? "entry" : "entries"}: ${skipped.join(", ")}`;
  const separator = argv.format === "html" ? "\n<hr>\n" : "\n\n---\n";
  const body = packs.map(({ pack }) => render(pack, undefined)).join(separator);

  const sections: string[] = [header];
  if (skipNote !== "") {
    sections.push(skipNote);
  }
  sections.push(body);
  return { content: [{ type: "text", text: sections.join("\n") }], isError: false };
}

/** Error mapping shared by the audit tools (spec v1.3 §10.3 / P0 §3.4). */
function mapAuditError(error: unknown): ToolResult {
  if (error instanceof EngineCallError) {
    return {
      content: [{ type: "text", text: formatToolErrorShape(error.toBody()) }],
      isError: true,
    };
  }
  if (error instanceof KernelSchemaError) {
    return {
      content: [{ type: "text", text: formatToolError(
        GP_E_INTERNAL,
        `engine returned an invalid evidence pack: ${error.message}`,
        "engine and kernel schema drifted; fix the common fixtures (assertion C35)",
      ) }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: formatToolError(
      GP_E_INTERNAL,
      `internal shell error: ${String(error)}`,
      "see the MCP server logs and retry",
    ) }],
    isError: true,
  };
}

// Re-exported types for dispatch/tests.
export type { Selector, Action, AssertionProperty };