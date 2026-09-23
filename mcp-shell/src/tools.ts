import { z } from "zod";
import {
  SelectorSchema,
  ActionSchema,
  AssertionPropertySchema,
  parseEvidencePackRead,
  KernelSchemaError,
  type Selector,
  type Action,
  type AssertionProperty,
  type EvidencePack,
} from "@iterate/kernel";

import { canonicalJson } from "./canonical.js";
import { daemonUnreachableRemedy, EngineCallError, EngineJsonRpcClient } from "./engine-client.js";
import { formatToolError, formatToolErrorShape, GP_E_BAD_PARAMS, GP_E_INTERNAL, GP_E_NO_EVIDENCE, GP_E_NOT_FOUND, GP_E_PROJECT_LIMIT } from "./errors.js";
import { EvidenceAuditSession, type TrailTurn } from "./audit-session.js";
import { renderHTML, renderMarkdown, escapeHTML } from "./evidence-report.js";
import type { EvidencePackReportView } from "./evidence-report.js";
import {
  ProjectListArgs,
  ProjectSetArgs,
  ProjectGetArgs,
  projectList,
  projectSet,
  projectGet,
  ProjectRegistryError,
  FORCE_OVERWRITE_ENV,
} from "./project-registry.js";

/* ------------------------------------------------------------------ *
 * Tool‑argument validation schemas (spec §6.2). The engine validates
 * daemon‑side too; this shell pre‑validates so bad args surface as
 * isError without touching the engine. <selector> reuses kernel rule.
 * ------------------------------------------------------------------ */

/* `pid` crosses the socket as `pid_t` (Int32): the daemon's own range check
 * (ParamValidation.pidLower/pidUpper) rejects anything else, and a value that
 * reached `pid_t(...)` out of range trapped the daemon while it was decoding
 * the frame — one frame killed the service. Bound it to that domain here, and
 * keep pid 0 out: it is the process-group sentinel, never an attach target.
 * The advertised JSON Schemas below must keep matching these bounds. */
const PID_INT32_MAX = 2_147_483_647;
const OptionalPidSchema = z.number().int().min(1).max(PID_INT32_MAX).optional();
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

/**
 * The closed set `restore.mode` accepts, mirrored from the daemon's
 * `ParamValidation.restoreModes` (the two literals EngineCore branches on plus
 * the two documented names of the forms it runs when `mode` is omitted). The
 * daemon answers anything else with GP_E_BAD_PARAMS, so advertising free text
 * here advertised a shape the service always refuses; the consumer-consistency
 * test reads that Swift declaration and fails if the two lists drift.
 */
export const RESTORE_MODES = [
  "compare",
  "ffwd",
  "restore_snapshot",
  "rollback_full",
] as const;
const RestoreModeSchema = z.enum(RESTORE_MODES).optional();

export const AttachArgs = z.strictObject({
  bundleId: OptionalBundleIdSchema,
  pid: OptionalPidSchema,
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
  degrade: z.boolean().optional(),
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

/** P6 §5.4: probe connectivity query takes no arguments. */
export const ProbeStatusArgs = z.strictObject({});
export type ProbeStatusArgs = z.infer<typeof ProbeStatusArgs>;

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
  /**
   * This call's position in the audit trail's request order. Tools that do not
   * touch the trail get {@link INERT_TRAIL_TURN}, which never waits.
   */
  turn: TrailTurn;
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
        pid: { type: "integer", minimum: 1, maximum: PID_INT32_MAX },
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
    description:
      "Perform a UI action on the attached app and confirm it. " +
      "If the daemon reports GP_E_BUSY_INPUT (real user input is contaminating the window), retry later, " +
      "or set degrade: true to proceed immediately with the contamination recorded in evidence " +
      "(attribution becomes weak + contaminated=true) — never silently clean.",
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
        degrade: { type: "boolean" },
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
        mode: { type: "string", enum: [...RESTORE_MODES] },
      },
      required: ["snapshotId"],
    },
    validate: zodBridge(RestoreArgs),
  },
  {
    name: "gp_probe_status",
    description: "List GlassPaneProbe connections and whether the attached app has a live probe — probe presence is what makes T4/T5/T7/T8 verdicts and tier-1 checkpoint restores decidable. `probes` holds **live** registrations only (every row `connected: true`), so a probe that dropped is absent from it rather than flagged inside it: read `recentDisconnections` for that history (`pid`, `disconnectReason`, `disconnectedAt`, per-pid `drops`), and `disconnections` is just the total count since start. Each live row can also carry the frame-accounting that makes a zero verdict readable: `stateFramesUnmappedSource` (daemon-side, per pid), and `droppedEvents` / `droppedWrites` / `rejectedKeys` as the probe itself reported them — those are **absent when unreported**, which is not the same as zero, and `unmapableStateFrames` is the daemon-side total that survives a disconnect.",
    engineMethod: "probe_status",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    validate: zodBridge(ProbeStatusArgs),
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
    description: "Create or update a GlassPane project. Omit projectId to register a new project; include it to update an existing one. Exactly one of bundleId or pid identifies the app: passing both is refused, and on update omitting both keeps the stored identity. Passing null for bundleId, pid or a path field clears it; omitting a field leaves it as stored.",
    engineMethod: "project_set",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", pattern: "^prj_[0-9A-HJKMNP-TV-Z]{26}$" },
        displayName: { type: "string", minLength: 1, maxLength: 256 },
        // `null` clears the field on update, so these mirror
        // ProjectSetArgs' `.nullish()` rather than the old optional-string form.
        bundleId: { type: ["string", "null"], maxLength: 256 },
        // Matches ProjectSetArgs.pid, which is bounded to the same Int32 domain
        // the daemon stores (an out-of-range pid made Swift fail to decode the
        // whole registry file, which then got rewritten as an empty table).
        pid: { type: ["integer", "null"], minimum: 1, maximum: PID_INT32_MAX },
        recipeConfigPath: { type: ["string", "null"], maxLength: 1024 },
        calibrationAssetsPath: { type: ["string", "null"], maxLength: 1024 },
        evidenceStoragePath: { type: ["string", "null"], maxLength: 1024 },
      },
      required: ["displayName"],
      // Exactly one of bundleId/pid must identify the app *after* an update is
      // merged with the stored entry, which a schema for one call cannot state
      // over a shared file: `projectId` alone means "keep the stored identity".
      // The authoritative rule runs on the merged entry in project-registry's
      // assertSingleIdentity, whose message names both fields.
      anyOf: [
        { required: ["bundleId"] },
        { required: ["pid"] },
        { required: ["projectId"] },
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
 * Audit-trail ordering (B-02 follow-up).
 *
 * `index.ts` starts every request at once and serialises only the *write* of
 * each finished frame, so an outstanding `gp_act` cannot stop `ping`,
 * `tools/list` or `gp_probe_status`. That is right for the byte stream and
 * wrong for `EvidenceAuditSession`: its `reset()`/`record()` run *after* the
 * engine `await`, so by themselves they apply in completion order. A client
 * that pipelines `gp_act` and `gp_attach` — which the timeout remedy actively
 * encourages — would then leave whichever interleaving the daemon happened to
 * produce: either the act survives the attach's reset (the new session's trail
 * carries evidence of the app it replaced) or it is wiped (the agent is told
 * "no operations recorded in this session" and re-performs the act on the
 * user's screen). Both are the harm this round already removed for the
 * session-reset semantics; concurrency must not turn it back into a coin flip.
 *
 * Invariant enforced here: **the trail is mutated and read in the order the
 * requests were admitted**, so for any overlap the trail is exactly what a
 * serial run of the same requests would leave. The turn machinery itself lives
 * on the session (`EvidenceAuditSession.claimTrailTurn`, `audit-session.ts`)
 * because request order is a property of one session's trail, not of this
 * module: two sessions in one process must not queue behind each other. What
 * stays here is the policy: which tools need a turn, and where the turns are
 * taken.
 *
 * A turn is claimed when `executeTool` is entered, which `McpServer.handleLine`
 * reaches *synchronously* from the arriving frame — claim order therefore is
 * request order — and it is never *held* across an engine call: every
 * `acquire()` sits directly in front of a `reset()` / `record()` / trail read.
 * Ordering cannot be pushed onto the reply queue instead: a mutation enqueued
 * from after an `await` is enqueued in completion order, which is the defect.
 *
 * Bounded wait: a turn is only outstanding while its `executeTool` promise is,
 * and `engine.call` always settles — on a reply, a transport error, or its
 * per-method deadline — so the worst-case queue delay is the outstanding
 * engine deadline, never a wedge. `test/tools.test.mjs` pins that with a
 * deliberately unanswered act.
 * ------------------------------------------------------------------ */

/** The turn of a tool that never touches the trail: it never waits. */
const INERT_TRAIL_TURN: TrailTurn = {
  acquire: async () => {
    // Nothing to wait for: this call cannot add anything to the trail, so it
    // must not be able to hold up the calls that can.
  },
  release: () => undefined,
};

/**
 * Engine methods whose frame the trail is built from: `attach` resets it (the
 * daemon invalidates its evidence history when the attached app changes), and
 * the rest answer with an `operationId`/`evidenceId` for `record()` to collect.
 */
const TRAIL_SCOPED_ENGINE_METHODS: readonly string[] = [
  "attach",
  "act",
  "assert_element",
  "diagnose",
  "last_evidence",
  "restore",
];

/**
 * Orchestrated tools that touch the trail through their own executor:
 * `gp_export_evidence` records the pack it fetched, and `gp_recent_reports`
 * *reads* the trail — a read queued after an outstanding `gp_act` has to see
 * that act, or it reports an operation the agent then repeats.
 *
 * Deliberately absent: `gp_observe`, `gp_snapshot`, `gp_probe_status`. They do
 * reach `session.record()`, but recording a frame that carries neither
 * `operationId` nor `evidenceId` appends nothing, and none of the three can
 * carry one: an `axTree` node is `{role,title,identifier,children}`
 * (`TreeDigest.AxNode`), `snapshot` answers
 * `{snapshotId,treeDigest,nodeCount,capturedAt,latencyMs}` and `probe_status`
 * `{probes,attachedHasProbe,disconnections,recentDisconnections}`
 * (`EngineCore.probeStatus`). Leaving them out is also what keeps
 * `slowEngineRemedy`'s promise true — `gp_probe_status` is the call an agent is
 * told to make *while an act is outstanding*. Any engine method that starts
 * answering with an operationId must be added above, or its trail write lands
 * in completion order again.
 */
const TRAIL_SCOPED_TOOL_NAMES: readonly string[] = ["gp_export_evidence", "gp_recent_reports"];

/** Does this tool read or write `EvidenceAuditSession`? */
export function trailScopedTool(spec: ToolSpec): boolean {
  return (
    TRAIL_SCOPED_TOOL_NAMES.includes(spec.name)
    || TRAIL_SCOPED_ENGINE_METHODS.includes(spec.engineMethod)
  );
}

/** Read the trail once this call's turn comes up, i.e. in request order. */
async function readTrail(
  session: EvidenceAuditSession,
  turn: TrailTurn,
  limit: number,
): Promise<string[]> {
  await turn.acquire();
  try {
    return session.recentIds(limit);
  } finally {
    turn.release();
  }
}

/* ------------------------------------------------------------------ *
 * Tools/call execution (spec §6.2): pre-validate -> forward -> map error.
 * ------------------------------------------------------------------ */

/**
 * Execute a tool against the engine client. Validates arguments against
 * the tool's zod schema (isError + GP_E_BAD_PARAMS on failure), then either
 * runs the tool's own `execute` (orchestrated tools) or forwards the method
 * to the engine and maps engine/connection errors to agent-facing errors.
 *
 * A tool that touches the audit trail waits for its turn in request order
 * before it does (see the trail-ordering block above); the engine call that
 * precedes that wait stays concurrent with every other outstanding request.
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

  if (!trailScopedTool(spec)) {
    return runValidatedTool(spec, checked.value, engine, session, INERT_TRAIL_TURN);
  }
  // Claimed here, before any `await`, so the claim order is the order the
  // frames arrived in.
  const turn = session.claimTrailTurn();
  try {
    return await runValidatedTool(spec, checked.value, engine, session, turn);
  } finally {
    // Idempotent backstop: a mutation site that threw between `acquire()` and
    // its own release must not leave every later trail-scoped call waiting.
    turn.release();
  }
}

async function runValidatedTool(
  spec: ToolSpec,
  value: Record<string, unknown>,
  engine: EngineJsonRpcClient,
  session: EvidenceAuditSession,
  turn: TrailTurn,
): Promise<ToolResult> {
  if (spec.execute !== undefined) {
    return spec.execute(value, { engine, session, turn });
  }

  try {
    const raw = await engine.call(spec.engineMethod, value);
    // Everything below touches the trail, so it waits for its turn: this is
    // where completion order is turned back into request order.
    await turn.acquire();
    try {
      if (spec.name === "gp_attach") {
        // A successful attach invalidates the daemon's evidence history, so
        // the session trail starts fresh (spec v1.3 §10.3).
        session.reset();
      }
      // Spec §6.3: evidence packs are passed through a strong read-side
      // validation (kernel parseEvidencePackRead) before surfacing to the agent,
      // so a Swift↔TS drift (assertion C35) fails here as a tool error instead of
      // corrupt JSON — while a pack the engine legitimately wrote stays readable.
      if (spec.engineMethod === "last_evidence") {
        parseEvidenceFrame(raw);
      }
      session.record(raw);
    } finally {
      // Released before the reply is built: holding the trail across
      // `canonicalJson` would make every later evidence tool wait on a
      // serialization step that has nothing to do with the trail.
      turn.release();
    }
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
    const evidenceFailure = mapEvidenceReadError(error);
    if (evidenceFailure !== undefined) {
      return evidenceFailure;
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
 * Raised when the engine's `last_evidence` *envelope* is not the contract
 * frame — no `{evidencePack: {…}}` object to read. That is a transport/peer
 * problem, not a pack-body violation, so it must never carry the C35
 * "fixtures drifted" remedy: the shared fixtures were not involved, and an
 * agent following that remedy edits truth files while the real cause (a daemon
 * that did not answer with a pack) survives untouched (R4-16).
 */
class EvidenceFrameShapeError extends Error {
  constructor(detail: string) {
    super(`engine returned a last_evidence frame without an evidencePack object: ${detail}`);
    this.name = "EvidenceFrameShapeError";
  }
}

/**
 * Strongly validates the engine's last_evidence result (§6.3) and returns the
 * parsed pack together with the schema label the archive *carried*. The engine
 * frame is `{evidencePack: {…}}`; the envelope is checked here and the pack body
 * goes to the kernel's read-side parser, which still accepts archives the engine
 * legitimately wrote before the schema froze (legacy `0.1-draft` label,
 * `pixelDiff.bounds` omitted instead of null).
 *
 * The fold is a *validation* step, so the measured label is reported separately
 * rather than hidden: a report that printed only the frozen const would assert a
 * conformance the bytes do not have, and the panel (which prints the label it
 * decoded) would then state a different contract than this report for one and
 * the same archive (B-09). The archive text an agent reads back through
 * gp_last_evidence is the daemon's frame, untouched.
 */
function parseEvidenceFrame(raw: unknown): { pack: EvidencePack; measuredSchemaVersion: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new EvidenceFrameShapeError("result frame is not an object");
  }
  const body = (raw as Record<string, unknown>).evidencePack;
  if (body === undefined) {
    throw new EvidenceFrameShapeError("missing evidencePack field in last_evidence result");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EvidenceFrameShapeError("evidencePack field is not an object");
  }
  const pack = parseEvidencePackRead(body);
  const measured: unknown = (body as Record<string, unknown>).schemaVersion;
  return {
    pack,
    measuredSchemaVersion: typeof measured === "string" ? measured : pack.schemaVersion,
  };
}

/**
 * The pack as a report prints it: `schemaVersion` states the label measured in
 * the archive *and* the contract the read path resolved it against —
 * `glasspane.evidence/0.1-draft (read as glasspane.evidence/0.1)` — so the
 * agent-facing report can never claim more than the bytes carry. A pack that
 * needed no fold is returned unchanged, which keeps the common report
 * byte-identical to the shared golden.
 */
function packForReport(pack: EvidencePack, measuredSchemaVersion: string): EvidencePackReportView {
  if (measuredSchemaVersion === pack.schemaVersion) {
    return pack;
  }
  // One literal-typed field widened to carry its provenance. The renderers
  // print `schemaVersion` verbatim and read nothing else off it
  // (`evidence-report.ts` markdown/HTML summary lines), and the validated pack
  // above still holds the contract value, so no consumer of `EvidencePack`
  // receives this: it is a presentation form for one line of text.
  return { ...pack, schemaVersion: `${measuredSchemaVersion} (read as ${pack.schemaVersion})` };
}

/**
 * The two evidence-read failure classes, each with the remedy that matches its
 * cause. Shared by the default tool path and the orchestrated audit tools so
 * one defect cannot be reported with the other's remedy.
 */
function mapEvidenceReadError(error: unknown): ToolResult | undefined {
  if (error instanceof EvidenceFrameShapeError) {
    return {
      content: [{ type: "text", text: formatToolError(
        GP_E_INTERNAL,
        error.message,
        `retry gp_last_evidence for the same operationId; if the answer still carries no evidencePack object then whatever is listening on this socket does not speak the engine contract — ${daemonUnreachableRemedy()}`,
      ) }],
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
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Project tools (spec v1.4 §4): operate on the shared projects.json at
 * the MCP layer — no socket methods are added ("不改变 socket 协议方法表").
 * ------------------------------------------------------------------ */

async function projectListTool(): Promise<ToolResult> {
  try {
    const projects = projectList();
    return {
      content: [{ type: "text", text: canonicalJson({ projects }) }],
      isError: false,
    };
  } catch (error) {
    return mapProjectError(error);
  }
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
  try {
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
  } catch (error) {
    return mapProjectError(error);
  }
}

/**
 * The single error mapper for all three project tools. `projectList()` and
 * `projectGet()` used to have no handler at all, so the registry's honest
 * "this file is unreadable" throw escaped `executeTool` entirely (custom
 * executors run outside its try/catch) and the agent saw a bare JSON-RPC
 * -32603 with no code and no remedy — the exact shape the registry was changed
 * to avoid producing (R4-03/A-15 family).
 */
function mapProjectError(error: unknown): ToolResult {
  if (error instanceof ProjectRegistryError) {
    return {
      content: [{ type: "text", text: formatToolError(
        error.code,
        error.message,
        projectErrorRemedy(error.code),
      ) }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: formatToolError(
      GP_E_INTERNAL,
      `internal shell error in project registry: ${String(error)}`,
      projectErrorRemedy(GP_E_INTERNAL),
    ) }],
    isError: true,
  };
}

/**
 * Remedy per registry failure code. `GP_E_INTERNAL` here means one specific
 * thing — the projects file cannot be read or decoded — so the guidance has to
 * be about that file: "see the MCP server logs" (the old shell-wide default)
 * sends the agent to look at something that never touched the damage, and
 * "check the tool's input schema" (the old non-limit default) states a cause
 * the message already ruled out.
 */
function projectErrorRemedy(code: string): string {
  if (code === GP_E_PROJECT_LIMIT) {
    return "delete unused projects first (`glasspaned --list-projects` prints the registered set), then retry";
  }
  if (code === GP_E_NOT_FOUND) {
    return "check the projectId; use gp_project_list to view available projects";
  }
  if (code === GP_E_INTERNAL) {
    return `the projects file is the problem, not your arguments: the message above names its path, so read it with \`python3 -m json.tool <that path>\`, repair or restore the damaged entry, and retry — or set ${FORCE_OVERWRITE_ENV}=1 and call gp_project_set to rebuild the registry from scratch (the unloadable file is moved aside as <path>.unreadable-<id>, never deleted, and every entry still in it is lost). Do not retry the same read-only call unchanged: it will keep failing.`;
  }
  return "check the tool's input schema and retry";
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
    const { pack, measuredSchemaVersion } = parseEvidenceFrame(raw);
    await context.turn.acquire();
    try {
      context.session.record(raw);
    } finally {
      context.turn.release();
    }
    return { content: [{ type: "text", text: render(packForReport(pack, measuredSchemaVersion), undefined) }], isError: false };
  } catch (error) {
    return mapAuditError(error);
  }
}

async function recentReports(
  args: Record<string, unknown>,
  context: ToolExecuteContext,
): Promise<ToolResult> {
  const argv = args as RecentReportsArgs;
  // The trail read is the reason this tool is trail-scoped: it has to see the
  // operations admitted before it, and answering from the state *before* an
  // outstanding `gp_act` is what makes an agent repeat that act. The turn is
  // released right after the read — the evidence fetches below do not touch the
  // trail, and queueing them behind this turn would make every later evidence
  // tool wait on daemon round trips that are none of its business.
  const ids = await readTrail(context.session, context.turn, argv.limit);
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
  const packs: Array<{ id: string; pack: EvidencePackReportView }> = [];
  const skipped: string[] = [];
  for (const id of ids) {
    try {
      const raw = await context.engine.call("last_evidence", { operationId: id });
      const parsed = parseEvidenceFrame(raw);
      packs.push({ id, pack: packForReport(parsed.pack, parsed.measuredSchemaVersion) });
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
  const evidenceFailure = mapEvidenceReadError(error);
  if (evidenceFailure !== undefined) {
    return evidenceFailure;
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