import { z } from "zod";
import {
  SELECTOR_MAX_LENGTH,
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
import { MAX_FRAME_BYTES } from "./io.js";
import {
  CALLER_VISIBLE_CEILING_MS,
  EngineCallError,
  EngineJsonRpcClient,
  LIVENESS_PROBE_OUTCOMES,
  isReplayUnsafeMethod,
  lateReplyRoute,
  livenessProbeDecision,
} from "./engine-client.js";
import {
  formatToolError,
  formatToolErrorShape,
  GP_E_BAD_PARAMS,
  GP_E_ENGINE_TIMEOUT,
  GP_E_INTERNAL,
  GP_E_NO_EVIDENCE,
  GP_E_NOT_FOUND,
  GP_E_NO_USER_RECORD,
  GP_E_PAYLOAD_TOO_LARGE,
  GP_E_PROJECT_LIMIT,
} from "./errors.js";
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
  MAX_PROJECTS,
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
/**
 * The id grammar, in one place: `op_` + 26 Crockford base32 characters
 * (P0 §4.1, mirrored by `ParamValidation.operationIdPattern` on the daemon side
 * and by `OPERATION_ID_PATTERN` in `http-gateway.ts`).
 *
 * It is a `const` rather than three inline regex literals because the shape is
 * now consulted at a second kind of place: {@link recentReports} checks an id it
 * harvested out of a daemon frame *before* spending a request on it, and the one
 * rule has to be the rule the agent was advertised.
 */
const OPERATION_ID_PATTERN = /^op_[0-9A-HJKMNP-TV-Z]{26}$/;
const OptionalOperationIdSchema = z.string().regex(OPERATION_ID_PATTERN).optional();
const OptionalProjectIdSchema = z.string().regex(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/).optional();

const ExpectSchema = z.union([z.string().max(512), z.boolean()]);

/**
 * The **request-side** selector rule, tightened over the kernel's shared one.
 *
 * The kernel's `SelectorSchema` (used unchanged when *reading* a pack back,
 * which is right: a pack on disk is a record, not a request) only caps the
 * length, so it accepts `role: ""` and `title: ""`. Neither is a question any
 * part of this stack can answer honestly, and the two fail differently:
 *
 *  - `role: ""` is refused by the daemon outright
 *    (`ParamValidation.optSelector`, `guard … , !role.isEmpty`), so the shell
 *    used to spend a round trip to learn a rule it could have applied itself —
 *    and on the HTTP gateway it spent one and then reported the daemon's
 *    wording instead of this tool's.
 *  - `title: ""` is *accepted* by the daemon, matched by exact equality in
 *    `AXChannel.elementMatches` (`title != wantedTitle`), and then printed as
 *    **absent** by the evidence report (`selector.title?.nonEmpty`). So the
 *    action that was performed and the evidence describing it disagree, which
 *    is the one outcome an evidence surface may not produce.
 *
 * Refusing both here is the shell-side half of the fix; `test/tools.test.mjs`
 * reads the rules above out of the daemon's own sources rather than restating
 * them, so a daemon that starts accepting an empty `role` — or starts printing
 * an empty `title` — reddens that gate instead of quietly disagreeing with this
 * file. The published JSON Schema below carries the same `minLength`, so what
 * `tools/list` advertises is what is enforced.
 *
 * `identifier` keeps the kernel's rule: the daemon has no emptiness guard on it
 * either, but an empty identifier can only ever *fail to resolve* (nothing in
 * the tree carries one), so the disagreement the title has never arises.
 */
const ShellSelectorSchema = z.strictObject({
  role: z.string().min(1).max(SELECTOR_MAX_LENGTH),
  title: z.string().min(1).max(SELECTOR_MAX_LENGTH).optional(),
  identifier: z.string().max(SELECTOR_MAX_LENGTH).optional(),
});

/** Crockford base32 body shared by op_/snap_ ids (P0 §4.1 / P1 v1.1 §1.2). */
const SnapshotIdSchema = z.string().regex(/^snap_[0-9A-HJKMNP-TV-Z]{26}$/);

const ActStepSchema = z.strictObject({
  selector: ShellSelectorSchema,
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
}).refine((v) => (v.bundleId === undefined) !== (v.pid === undefined), {
  // Exclusive, not merely "at least one" (R8-中6). The advertised JSON Schema
  // below already says `oneOf` (exactly one), and the daemon resolves both
  // fields by *preferring pid and ignoring bundleId*
  // (`AXChannel.resolveRunningApplication`: `if let pid { … } if let bundleId { … }`).
  // So the loose zod rule let an agent name two different apps and get the one
  // it did not mean, attached, and acting on the user's screen — with the reply
  // naming only one of them. Refusing is the only answer that cannot mislead.
  message: "attach takes exactly one of bundleId or pid, not both and not neither",
  path: ["bundleId"],
});
export type AttachArgs = z.infer<typeof AttachArgs>;

export const ObserveArgs = z.strictObject({
  maxDepth: OptionalDepthSchema,
  role: OptionalRoleSchema,
});
export type ObserveArgs = z.infer<typeof ObserveArgs>;

const OptionalHitTargetSchema = z.number().min(1).max(400).optional();

const OptionalScaleSchema = z.number().min(0.1).max(1).optional();

export const CaptureViewArgs = z.strictObject({
  scale: OptionalScaleSchema,
});
export type CaptureViewArgs = z.infer<typeof CaptureViewArgs>;

export const AuditUiArgs = z.strictObject({
  maxDepth: OptionalDepthSchema,
  minHitTargetPt: OptionalHitTargetSchema,
});
export type AuditUiArgs = z.infer<typeof AuditUiArgs>;

export const ActArgs = z.strictObject({
  selector: ShellSelectorSchema,
  action: ActionSchema,
  degrade: z.boolean().optional(),
});
export type ActArgs = z.infer<typeof ActArgs>;

export const AssertElementArgs = z.strictObject({
  selector: ShellSelectorSchema,
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
  operationId: z.string().regex(OPERATION_ID_PATTERN),
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

/**
 * Content parts a tool may return. `image` exists for exactly one tool:
 * `gp_capture_view`, whose whole point is handing one window image to the
 * user's own model. It is a pass-through, not a store — the shell writes
 * nothing to disk, so "no raw screenshot is persisted anywhere" stays true.
 */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Tool result shape shared by the default path and custom executors. */
export interface ToolResult {
  content: ToolContent[];
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
    // `minLength` here is the advertised half of {@link ShellSelectorSchema};
    // `test/tools.test.mjs` compares the two against each other and against the
    // daemon's own rule, so neither side can be tightened or loosened alone.
    role: { type: "string", minLength: 1, maxLength: SELECTOR_MAX_LENGTH },
    title: { type: "string", minLength: 1, maxLength: SELECTOR_MAX_LENGTH },
    identifier: { type: "string", maxLength: SELECTOR_MAX_LENGTH },
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
      "(attribution becomes weak + contaminated=true) — never silently clean. " +
      "Prefer selector.identifier over selector.title to name the element: a title is not a stable handle " +
      "(a measured case: every act against a title-keyed selector reported actConfirmed while the app's " +
      "handler never ran, because the press resolved to something that was not the button). " +
      "actConfirmed means the accessibility action was accepted — not that the intended element handled it; " +
      "to prove the click itself, read the probe's handler hit or the state change, or assert_element " +
      "against a value that the action is supposed to change.",
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
    name: "gp_audit_ui",
    description:
      "Audit the attached app's layout for operability: element geometry plus deterministic rules " +
      "report zero-sized or out-of-window controls (blocking), undersized hit targets, clipped " +
      "elements and frame overlaps (advisory). The verdict distinguishes pass from insufficient: " +
      "unmeasured geometry never counts as a clean result. Read-only — it records no operation.",
    engineMethod: "audit_ui",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxDepth: { type: "integer", minimum: 1, maximum: 10 },
        minHitTargetPt: { type: "number", minimum: 1, maximum: 400 },
      },
    },
    validate: zodBridge(AuditUiArgs),
  },
  {
    name: "gp_capture_view",
    description:
      "Send the attached app's current window to your model once, as a PNG, for visual review. " +
      "This is the only tool that moves image pixels, and it is a pass-through: the engine encodes " +
      "the capture and writes nothing to disk (the result says persisted: false). Use it for what " +
      "measurements cannot judge — visual taste, layout that reads as wrong, content with no " +
      "accessibility tree. For anything assertable, prefer gp_audit_ui / gp_assert_element: a " +
      "measurement repeats, a visual impression does not. `scale` is a pixel-density factor applied " +
      "to the captured image (window size is reported separately in points as pointSize), and the " +
      "summary states both the requested scale and the appliedScale actually present in the image. " +
      "WARNING: the image enters this conversation, so anything your model provider logs will " +
      "retain whatever was on screen. " +
      "Needs the daemon's Screen Recording grant; oversized windows are refused with a suggested " +
      "scale rather than silently downsampled.",
    engineMethod: "capture_view",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scale: { type: "number", minimum: 0.1, maximum: 1 },
      },
    },
    validate: zodBridge(CaptureViewArgs),
    execute: captureView,
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
    description: "List GlassPaneProbe connections and whether the attached app has a live probe — probe presence is what makes T4/T5/T7/T8 verdicts and tier-1 checkpoint restores decidable. `attachedHasProbe` is that yes/no for the attached app; `probes` holds **live** registrations only (every row `connected: true`), so a probe that dropped is absent from it rather than flagged inside it: read `recentDisconnections` for that history (`pid`, `disconnectReason`, `disconnectedAt`, per-pid `drops`), and `disconnections` is just the total count since start. Each live row can also carry the frame-accounting that makes a zero verdict readable: `stateFramesUnmappedSource` (daemon-side, per pid), and `droppedEvents` / `droppedWrites` / `rejectedKeys` as the probe itself reported them — those are **absent when unreported**, which is not the same as zero, and `unmapableStateFrames` is the daemon-side total that survives a disconnect. The same reply is where the T9 degradation watch is readable without performing an action, under `degradation` (absent when this daemon runs without T9 wired): `tier` is `healthy` / `watch` / `degrading`, and `judged` says whether that tier is a measurement at all — `judged: false` with `tier: healthy` means the window was too thin or too short to read, **not** that the app is clean; `basis` spells out which of those it is with the numbers, alongside `samples`/`minimumSamples` and `spanSeconds`/`minimumSpanSeconds`. `longSession` marks the window spanning at least the long-session threshold; it is context for the trend, and it never changes `tier` by itself. `drivers` appears only when something is trending, and `slopes` carries only the channels that produced one (`pingMsPerSec`, `memoryBytesPerSec`, `handlesPerSec`) — a channel missing from `slopes` was never read, which is not a rate of zero.",
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
    description:
      "List every project stored in the project registry file: projectId, displayName, createdAt, the "
      + "bundleId or pid that identifies its app, and any configured recipe, calibration or evidence paths. "
      + "It reads the file, so it reports what has been written rather than what the running background "
      + "service has loaded.",
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

/**
 * The attach result's app identity, keyed by **every** stored property of the
 * daemon's `AttachedApp` (`pid`, `bundleId`, `appName`) — that struct's
 * `Equatable` conformance is precisely what decides whether `EngineCore.attach`
 * clears the daemon's evidence history, so a key that left a field out would
 * keep this trail across a change the daemon did clear, and the next app would
 * read the previous app's operations as its own.
 *
 * Null means the reply did not identify the app (no `pid` or no `appName`):
 * unknown is treated as *changed*, because an identity that cannot be compared
 * cannot be shown to be the same one. `test/attach-identity.test.mjs` reads the
 * Swift struct and fails if the key ever covers fewer fields than it stores.
 */
export function attachIdentityOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }
  const record = result as Record<string, unknown>;
  const pid = typeof record.pid === "number" ? String(record.pid) : null;
  const appName = typeof record.appName === "string" ? record.appName : null;
  if (pid === null || appName === null) {
    return null;
  }
  // `nil` bundleId is a value of its own here: Swift compares the optional, so
  // "no bundle id" attached twice is the same app, not a change.
  const bundleId = typeof record.bundleId === "string" ? record.bundleId : "<no-bundle-id>";
  return `${pid}|${bundleId}|${appName}`;
}

/**
 * One advertised numeric bound, read out of a tool's own JSON Schema.
 *
 * `maximum`/`minimum` are what `tools/list` publishes, so they are also what an
 * agent can act on: advice built from anything else can tell it to use a value
 * this shell would then reject.
 */
interface NarrowingKnob {
  name: string;
  kind: "scale" | "depth" | "selector" | "limit";
  minimum?: number;
  maximum?: number;
  /** The value the request carried, when it carried one. */
  sent?: number;
}

function narrowingKnobsFor(spec: ToolSpec, params: Record<string, unknown>): NarrowingKnob[] {
  const properties = (spec.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const knobs: NarrowingKnob[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const schema = raw as { type?: string; minimum?: number; maximum?: number };
    const sentValue = params[name];
    const sent = typeof sentValue === "number" ? sentValue : undefined;
    // Which knob shrinks *what* is a property of the tool, so the mapping is
    // spelled per name rather than guessed from types: `limit` and `maxDepth`
    // are both integers and shrink very different things.
    if (name === "maxDepth") {
      knobs.push({ name, kind: "depth", minimum: schema.minimum, maximum: schema.maximum, sent });
    } else if (name === "scale") {
      knobs.push({ name, kind: "scale", minimum: schema.minimum, maximum: schema.maximum, sent });
    } else if (name === "limit") {
      knobs.push({ name, kind: "limit", minimum: schema.minimum, maximum: schema.maximum, sent });
    } else if (name === "selector" || name === "role" || name === "title") {
      knobs.push({ name, kind: "selector", sent: undefined });
    }
  }
  return knobs;
}

/**
 * Is this knob already at the floor the tool's own schema advertises?
 *
 * The floor is not a matter of phrasing: zod answers `maxDepth: 0` with
 * `min(1)` and GP_E_BAD_PARAMS, so "retry with a smaller maxDepth" on a request
 * that already carried `1` is an instruction this shell rejects on receipt. R8d-
 * 高2 noticed that for `scale` alone; `depth` and `limit` carry a `minimum` in
 * the schema exactly the same way, so they come through here too.
 */
function atAdvertisedFloor(knob: NarrowingKnob): boolean {
  return knob.minimum !== undefined
    && knob.sent !== undefined
    && knob.sent <= knob.minimum;
}

/** What this knob controls, for the sentence that says it cannot go lower. */
function knobSubject(kind: NarrowingKnob["kind"]): string {
  switch (kind) {
    case "depth":
      return "the tree it reads";
    case "limit":
      return "the number of entries it collects";
    case "scale":
      return "the image";
    case "selector":
      return "the reply";
  }
}

function describeKnob(knob: NarrowingKnob): string {
  const bounds = knob.minimum !== undefined && knob.maximum !== undefined
    ? ` (this tool advertises ${knob.minimum}…${knob.maximum})`
    : knob.maximum !== undefined
      ? ` (this tool advertises at most ${knob.maximum})`
      : knob.minimum !== undefined
        ? ` (this tool advertises at least ${knob.minimum})`
        : "";
  if (atAdvertisedFloor(knob)) {
    // At the floor there is nothing left to lower, and telling an agent to lower
    // it is a command this shell would then reject: say which part of the reply
    // is therefore already minimal, in this tool's own parameter name.
    return `${knob.name} is already at this tool's floor (${knob.minimum}), so ${knobSubject(knob.kind)} cannot be made smaller that way here`;
  }
  switch (knob.kind) {
    case "depth":
      return `a smaller maxDepth${bounds}`;
    case "limit":
      return `a smaller limit${bounds}`;
    case "selector":
      // Named by the parameter this tool really publishes: `gp_observe` has
      // `role`, not `selector`, and telling it to tighten a field it does not
      // accept is the same mistake this function exists to stop making.
      return knob.name === "selector"
        ? "a more specific selector (aim at one element)"
        : `a tighter ${knob.name} filter`;
    case "scale":
      return `a smaller scale${bounds}${knob.sent !== undefined ? `, currently ${knob.sent}` : ""}`;
  }
}

/**
 * The advice for a reply that did not fit the frame.
 *
 * R8d-高2 replaces the previous version of this function, which read the *params
 * the request happened to carry*: `gp_observe` with no explicit `maxDepth` got
 * "this request carries no narrowing parameter this shell can name", which is
 * false — the tool advertises `maxDepth` 1…10 and the daemon applies its own
 * default — and `capture_view`'s `scale` branch could never be reached at all,
 * because the PNG budget is already below the frame cap (a fact now pinned by
 * `test/consumer-consistency.test.mjs`). The authority for "what can this caller
 * shrink" is the schema it was shown, so that is what this reads; the sent value
 * is used only to notice a knob that is already at its floor.
 *
 * `test/tools.test.mjs` checks the three properties that make this worth
 * having: every parameter it names exists in that tool's own advertised schema,
 * no knob at its floor is ever described as shrinkable, and the floor rule is
 * applied to every kind that advertises a `minimum` rather than to `scale` only.
 */
export function oversizedReplyAdvice(spec: ToolSpec, params: Record<string, unknown>): string {
  const knobs = narrowingKnobsFor(spec, params);
  const atFloor = knobs.filter(atAdvertisedFloor);
  const shrinkable = knobs.filter((knob) => !atAdvertisedFloor(knob));
  const head = `the reply was too large for one frame (${MAX_FRAME_BYTES}-byte limit); `;
  // A knob the request already holds at its floor is stated even when another
  // knob is still open: without it, `gp_observe {maxDepth: 1}` reads "retry with
  // a tighter role filter" and the agent has no way to know the depth it set is
  // already the smallest the tool publishes — the number it would otherwise go
  // back and lower, into a GP_E_BAD_PARAMS.
  const floorNote = atFloor.length === 0
    ? ""
    : `${atFloor.map(describeKnob).join("; ")}; `;
  if (shrinkable.length === 0) {
    return knobs.length > 0
      ? head + `${atFloor.map(describeKnob).join("; ")} — nothing left to narrow on this request: ask a `
        + "smaller question (one element, one region) rather than retrying it unchanged; the connection is "
        + "intact and the daemon keeps answering other requests"
      : head + "this tool advertises no parameter that shrinks a reply, so do not retry it unchanged — ask a "
        + "smaller question (one element, one region) instead; the connection is intact and the daemon keeps "
        + "answering other requests";
  }
  return head + floorNote + `retry with ${shrinkable.map(describeKnob).join(" and ")}; `
    + "the reply body has to fit one frame, and a retried identical request will be dropped identically; "
    + "the connection is intact and the daemon keeps answering other requests";
}

/**
 * The harm each non-replayable request does, keyed by the engine method that
 * carries it — the *sentence* only. Whether a method is non-replayable at all is
 * the transport's decision (`isReplayUnsafeMethod`, exported from
 * `engine-client.ts`), because that is where the same question is already asked
 * when a caller's wait is capped: a GP_E_PAYLOAD_TOO_LARGE reply proves the request
 * reached the daemon and was answered — only the answer was dropped for size — so
 * telling the caller to send one of these again is an instruction to perform the
 * change a second time, which is the exact harm B-02's ceiling exists to remove.
 * A method missing from this map still gets the no-retry advice with the generic
 * harm clause, never the "retry narrower" advice: the fallback errs toward not
 * acting. `test/tools.test.mjs` compares the transport's verdict against the advice
 * for every tool in both directions.
 */
const REPLAY_UNSAFE_PAYLOAD_HARMS: Readonly<Record<string, string>> = {
  act: "it changes the user's screen",
  restore: "it replays recorded steps onto the user's screen, one after another",
  attach: "it re-points the daemon at another app, and a changed attach discards the evidence history a request that has not answered yet is being recorded in",
};

/**
 * The advice for a replay-unsafe tool whose reply did not fit the frame.
 *
 * `oversizedReplyAdvice` answers "how do I make the next reply smaller", which is
 * the right question for a read and the wrong one here. This surface does have
 * routes for finding out what happened without acting again: the trail
 * (`gp_recent_reports`, `gp_last_evidence`) records the operations this session
 * admitted, and `gp_observe` / `gp_assert_element` / `gp_probe_status` read the
 * daemon's state on the same connection.
 */
export function replayUnsafePayloadAdvice(
  spec: ToolSpec,
  method: string,
  params: Record<string, unknown>,
): string {
  const shrinkable = narrowingKnobsFor(spec, params).filter((knob) => !atAdvertisedFloor(knob));
  const head = `the reply was too large for one frame (${MAX_FRAME_BYTES}-byte limit); `;
  const harm = REPLAY_UNSAFE_PAYLOAD_HARMS[method] ?? "it changes daemon state";
  const narrower = shrinkable.length > 0
    ? `with ${shrinkable.map(describeKnob).join(" and ")}`
    : "only after narrowing it (this tool advertises no parameter that shrinks a reply, so ask a smaller question: one element, one region)";
  return head
    + `do not re-issue this request. '${spec.name}' already reached the daemon and was answered — only the answer was dropped for exceeding one frame — and ${harm}, `
    + `so sending it again performs the change a second time rather than recovering the first. Read what happened instead: gp_recent_reports lists the operations this session `
    + `recorded and gp_last_evidence {operationId} returns one of them in full, and gp_observe / gp_assert_element read the app the daemon is attached to now without `
    + `performing anything (gp_probe_status answers on the same connection and names the apps with a live probe with their pids). `
    + `The connection is intact and the daemon keeps answering other requests; if that reading shows this request never took effect, it can be sent again ${narrower}, `
    + `and a retried identical request will be dropped identically.`;
}

/**
 * The advice for a request that was never answered inside the caller's wait.
 *
 * R9-中3 moved this here on purpose. A deadline overrun is the one engine error
 * whose *cause* the transport knows ("still working on the request in front of
 * yours") and whose *cure* it cannot know: which parameter would have made this
 * answer cheaper is a property of the tool, and the only authority for that is
 * the schema the tool published to `tools/list`. The transport therefore states
 * the fact and the wait; the narrowing clause below is composed from the same
 * advertised bounds `oversizedReplyAdvice` reads, so it is floor-aware for time
 * exactly as it is for size — `gp_observe {maxDepth: 1}` is told that its depth
 * is already at the tool's floor, never told to lower a value this shell would
 * then reject with `GP_E_BAD_PARAMS`.
 *
 * What the transport owns is imported rather than re-worded — the four probe
 * outcomes ({@link livenessProbeDecision}), the one outcome that authorises a
 * restart, and the bounded late-reply window ({@link lateReplyRoute}) — because a
 * rewritten remedy that silently dropped "a busy daemon is not a dead daemon"
 * would send the agent to `--restore-launchd` over an act in flight, which is the
 * exact harm R8-高1 removed.
 */
export function slowReplyAdvice(
  spec: ToolSpec,
  params: Record<string, unknown>,
): string {
  const knobs = narrowingKnobsFor(spec, params);
  const atFloor = knobs.filter(atAdvertisedFloor);
  const shrinkable = knobs.filter((knob) => !atAdvertisedFloor(knob));
  const floorNote = atFloor.length === 0 ? "" : ` ${atFloor.map(describeKnob).join("; ")}.`;
  const narrowed = shrinkable.length === 0
    ? `there is nothing left to narrow on this request:${floorNote} ask a smaller question `
      + "(one element, one region) rather than re-sending the same one and waiting out the "
      + "same deadline on it"
    : `once it is answered, re-send '${spec.name}' with ${shrinkable.map(describeKnob).join(" and ")} `
      + `— these are the parameters this tool itself advertises as deciding how much work one `
      + `answer carries${floorNote}`;
  const probeGuide = LIVENESS_PROBE_OUTCOMES
    .map((outcome) => `${outcome} — ${livenessProbeDecision(outcome)}`)
    .join("; ");
  return "the daemon serves one request at a time and is still working on this one, so this answer "
    + "describes a busy daemon, not a dead one: wait for it, and do not put a second copy of the same "
    + `request on the wire while the first is outstanding — it queues behind the work that is already late. ${narrowed}. `
    + "If your client can send a second request while this one is still outstanding, confirm the daemon is "
    + "alive with gp_probe_status (this shell does not queue one MCP request behind another) and read its "
    + `answer as: ${probeGuide}. A restart is authorised only by ${livenessProbeDecision("unreachable")}. `
    + `Nothing is discarded by this shell having answered early: ${lateReplyRoute("mcp")}`;
}

/**
 * Does the tool layer have more to say about a timeout on `method` than the
 * transport does?
 *
 * Only where the tool actually advertises a knob: a request that carries one is
 * the request whose cost the caller can still change, and the transport cannot
 * see the tool's schema. Everywhere else the transport's own sentence stands —
 * including `gp_probe_status`, whose remedy the transport writes specially because
 * a probe that went unanswered must not be told to send a probe (and must not
 * name a restart at all). Replay-unsafe methods are the transport's too: its
 * remedy already forbids the re-issue, and this layer adds no reason to re-issue.
 */
export function toolAuthorsTimeoutAdvice(
  spec: ToolSpec,
  method: string,
  params: Record<string, unknown>,
): boolean {
  return !isReplayUnsafeMethod(method) && narrowingKnobsFor(spec, params).length > 0;
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

  // The advice is attached once, here, rather than at each place an error is
  // rendered: `gp_capture_view`, `gp_export_evidence` and `gp_recent_reports`
  // all catch their own engine errors, so a per-site rewrite would keep working
  // for the tools somebody remembered and quietly not for the rest (that is how
  // R8d-高2 left it). `Object.create` shares the client's own state — the real
  // prototype, no cast, no `any` — with one method shadowed. The validated
  // arguments travel with it because an orchestrated tool's inner frame does not
  // carry the knob the caller actually set (see {@link engineWithPayloadAdvice}).
  const advised = engineWithPayloadAdvice(engine, spec, checked.value);
  if (!trailScopedTool(spec)) {
    return runValidatedTool(spec, checked.value, advised, session, INERT_TRAIL_TURN);
  }
  // Claimed here, before any `await`, so the claim order is the order the
  // frames arrived in.
  const turn = session.claimTrailTurn();
  try {
    return await runValidatedTool(spec, checked.value, advised, session, turn);
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
    // `session.generation` travels with the request so a reply that lands after
    // this caller was answered can be judged against the trail it belongs to
    // (R8b-高1, `EngineJsonRpcClient.call`'s correlation).
    const raw = await engine.call(spec.engineMethod, value, session.generation);
    // Everything below touches the trail, so it waits for its turn: this is
    // where completion order is turned back into request order.
    await turn.acquire();
    try {
      if (spec.name === "gp_attach") {
        // The trail restarts when the *attached app* changes, which is the
        // daemon's own condition (`if attachedApp != app { history.removeAll() }`)
        // — not on every successful attach. Clearing unconditionally deleted
        // operations the daemon still had, including the one a late reply had
        // just put into the trail, which sent the agent back to
        // "GP_E_NO_EVIDENCE … run gp_act first" for a click that already
        // happened (spec v1.3 §10.3, R8b-高1).
        session.restart(attachIdentityOf(raw));
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
export function parseEvidenceFrame(raw: unknown): { pack: EvidencePack; measuredSchemaVersion: string } {
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
export function packForReport(pack: EvidencePack, measuredSchemaVersion: string): EvidencePackReportView {
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
 * `gp_capture_view`：把引擎返回的 PNG 作为 MCP image content 交给调用方，并附一段
 * 文字摘要（尺寸、字节数、缩放、"没有落盘"）。摘要不是装饰：模型只看图时，没人记得
 * 这张图是被 0.6 缩过的，而"我看清了"和"我看清的是缩过 40% 的版本"是两个结论。
 */
async function captureView(
  args: Record<string, unknown>,
  context: ToolExecuteContext,
): Promise<ToolResult> {
  try {
    // The generation travels with this call too. `capture_view` answers with a PNG
    // and no operationId today, so nothing leaks if it is omitted — but that is a
    // property of the reply shape, not of the call site, and the trail must not
    // depend on nobody ever adding an id to this frame. The gate at the bottom of
    // `test/remedy-surface.test.mjs` keeps every `.call(` in this file honest.
    const raw = await context.engine.call("capture_view", args, context.session.generation);
    const body = (raw ?? {}) as Record<string, unknown>;
    const png = body.pngBase64;
    if (typeof png !== "string" || png.length === 0) {
      return {
        content: [{ type: "text", text: formatToolError(
          GP_E_INTERNAL,
          "capture_view answered without a pngBase64 payload",
          "retry once; if it repeats, report this — the engine captured but the shell could not read the image",
        ) }],
        isError: true,
      };
    }
    // "没有落盘"是这条通路对外的主张，所以它必须由引擎**说出来**，不能由壳层在字段
    // 缺失时补一个 `false`：`?? false` 会把"引擎没回答这个问题"变成"引擎说没有落盘"。
    if (body.persisted !== false) {
      return {
        content: [{ type: "text", text: formatToolError(
          GP_E_INTERNAL,
          `capture_view answered without persisted:false (got ${JSON.stringify(body.persisted ?? null)})`,
          "do not treat this image as unsaved: the engine did not say so. Retry once, then report the frame shape — the pass-through guarantee is a claim about the protocol, not a default the shell may fill in",
        ) }],
        isError: true,
      };
    }
    const mimeType = typeof body.mimeType === "string" && body.mimeType.length > 0
      ? body.mimeType
      : "image/png";
    const summary = canonicalJson({
      mimeType,
      byteCount: body.byteCount,
      pixelWidth: body.pixelWidth,
      pixelHeight: body.pixelHeight,
      scale: body.scale,
      // 实际应用的倍率与请求值都给出：静默降采样失败时，"appliedScale" 才是
      // 模型该信的那个数（它决定自己看到的是不是缩过的版本）。
      appliedScale: body.appliedScale,
      windowId: body.windowId,
      pointSize: body.pointSize,
      persisted: body.persisted,
    });
    return {
      content: [
        { type: "image", data: png, mimeType },
        { type: "text", text: summary },
      ],
      isError: false,
    };
  } catch (error) {
    if (error instanceof EngineCallError) {
      return {
        content: [{ type: "text", text: formatToolErrorShape(error.toBody()) }],
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
 * A reply arrived on this socket and did not decode. Two different facts, and
 * the old text collapsed both into "restart the service":
 *
 *  - `EvidenceFrameShapeError` — the frame carried no pack at all;
 *  - `KernelSchemaError` — a pack arrived and the shared evidence schema rejects it.
 *
 * Neither is a dead daemon: something answered. Ordering `--restore-launchd` here
 * was the defect, because the daemon the agent is standing over may hold an act
 * that has already changed the user's screen, and the restart takes it down mid
 * flight. What each remedy does instead is state the fact and hand over a check
 * that reads something: `gp_probe_status` answers a *different* reply shape on the
 * same socket, so it separates "a foreign service is on this path" from "the two
 * sides disagree about evidence", and `launchctl print` reads back the running
 * job's own arguments — which socket, which `--state-dir` — without touching
 * either.
 */
function mapEvidenceReadError(error: unknown): ToolResult | undefined {
  if (error instanceof EvidenceFrameShapeError) {
    return {
      content: [{ type: "text", text: formatToolError(
        GP_E_INTERNAL,
        error.message,
        "retry gp_last_evidence for the same operationId once. If it still answers with no evidencePack object, the socket is speaking something other than the engine contract — send gp_probe_status on this same connection: it is a different reply shape, and an answer there means the service is alive and this is a disagreement about the evidence format between two builds, not a dead daemon. Do not restart anything on this answer: a restart takes down the service that just answered you and anything it has in flight on the user's screen, so `--restore-launchd` and `launchctl kickstart` are both the wrong move here. What identifies the service instead is reading it: `launchctl print gui/$(id -u)/com.glasspane.daemon` gives the socket path and state root the running job was started with, and comparing that with the GLASSPANE_ENGINE_SOCK or --socket-path this shell was given says whether the two are pointed at the same daemon. Retrying this call unchanged gets the same frame back",
      ) }],
      isError: true,
    };
  }
  if (error instanceof KernelSchemaError) {
    return {
      content: [{ type: "text", text: formatToolError(
        GP_E_INTERNAL,
        `engine returned an evidence pack this shell's read rules reject: ${error.message}`,
        "a pack did arrive and its contents do not satisfy the evidence format this shell was built against, so the two sides came from different releases rather than one of them being down. Read the versions instead of restarting: `launchctl print gui/$(id -u)/com.glasspane.daemon` gives the program path the running service was started from, and this shell reports its own build on startup. Any other operation's pack can still be fetched by id with gp_last_evidence {operationId}, so the read is not lost — this pack is. Do not hand-edit an archive or a fixture to make this pack validate: the disagreement is the finding, and the report is the place it should surface",
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
          // Both the code and the remedy come from the one place they are
          // spelled: this used to retype the literal and the sentence, so a
          // change to `projectErrorRemedy` left this reply behind (R8-低).
          GP_E_NOT_FOUND,
          `unknown project ${argv.projectId}`,
          projectErrorRemedy(GP_E_NOT_FOUND),
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
    // What is actually possible. The old sentence was "delete unused projects
    // first (`glasspaned --list-projects` prints the registered set), then
    // retry", which ordered an action nothing here performs: this surface adds
    // and patches entries (`gp_project_set`) and reads them (`gp_project_list`,
    // `gp_project_get`), and the daemon CLI's project-shaped flags
    // (`--list-projects`, `--active-project`, and the evidence-only
    // `--prune-evidence`/`--project`) print or prune archives — none removes a
    // registration. `test/tools.test.mjs` pins both halves: the remedy names no
    // delete on this surface, and every `glasspaned --flag` it quotes is one the
    // daemon's own argument parser accepts.
    return `the limit (${MAX_PROJECTS}) counts the entries stored in the projects file named above, so a new registration cannot be made to fit by changing an existing one: gp_project_set with an existing projectId patches that entry and leaves the count where it is. See what is stored with gp_project_list, then free a slot by removing an entry from that file itself (read it first with \`python3 -m json.tool <that path>\`; this surface offers no delete, so this is a repair of the file the message names, the same route a damaged registry takes) and retry. To read the same set without this shell: glasspaned --list-projects prints the file the service loads by default`;
  }
  if (code === GP_E_NOT_FOUND) {
    return "check the projectId; use gp_project_list to view available projects";
  }
  if (code === GP_E_NO_USER_RECORD) {
    // Distinct from GP_E_INTERNAL on purpose: this failure names no file, and
    // sending the agent to read and repair `projects.json` for a missing
    // password-database entry wastes the one turn it has — the file it would
    // open is not the thing that is wrong.
    return "this process has no entry in the password database, so neither it nor the daemon can know which user's state directory is meant; run the shell as a user that has one (`id -u` / `dscl . -read /Users/<name> NFSHomeDirectory`). Nothing in ~/.glasspane needs repairing for this";
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
    const raw = await context.engine.call(
      "last_evidence",
      { operationId: argv.operationId },
      context.session.generation,
    );
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

/**
 * The whole `gp_recent_reports` call gets **one** caller-visible ceiling, not
 * one per trail entry.
 *
 * `limit` reaches 20 and each id is its own `last_evidence` round trip, for which
 * the transport will wait up to `CALLER_VISIBLE_CEILING_MS`. Sequentially that is
 * 20 × 50 s of held client — some 1000 s — on the one tool whose purpose is to
 * tell an agent whether the `gp_act` it is standing behind already happened. The
 * client gives up long before that, holds no code and no remedy, and does the one
 * thing B-02's ceiling exists to prevent: it clicks again. So the bound is not a
 * new number but the ceiling the shell already promises for *any* request, spent
 * across the fan-out instead of per round trip. Nothing is lost by answering
 * early: the packs already fetched are rendered, and every id that was not
 * fetched is named in the report rather than left out.
 */
const RECENT_REPORTS_BUDGET_MS = CALLER_VISIBLE_CEILING_MS;

/** One wall-clock bound for a call that makes several engine round trips. */
class CallBudget {
  readonly #startedAt = Date.now();
  #expiry: Promise<"budget"> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly budgetMs: number) {}

  /** True once the whole budget has been spent on the fetches so far. */
  get spent(): boolean {
    return Date.now() - this.#startedAt >= this.budgetMs;
  }

  /**
   * Resolves `"budget"` at the deadline, arming the one timer on first use.
   * Unreferenced, because a tool that has already answered must not be the
   * reason a session's process stays up.
   */
  get expired(): Promise<"budget"> {
    this.#expiry ??= new Promise<"budget">((resolve) => {
      const left = Math.max(this.budgetMs - (Date.now() - this.#startedAt), 0);
      const timer = setTimeout(() => resolve("budget"), left);
      this.#timer = timer;
      timer.unref();
    });
    return this.#expiry;
  }

  /** Releases the timer once the fan-out is over, however it ended. */
  done(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

/** One `last_evidence` read's outcome, tagged so nothing can reject into a race. */
type RecentReportFetch =
  | { kind: "pack"; pack: EvidencePackReportView }
  | { kind: "missing" }
  | { kind: "failed"; error: unknown };

/**
 * How much of one trail id a report prints.
 *
 * An id that reached the trail from a daemon frame can be any string, and the
 * report is one text part: unbounded, twenty of them are a payload this shell
 * then refuses to deliver (`MAX_FRAME_BYTES`), which is a worse outcome than a
 * truncated name.
 */
const RENDERED_ID_MAX_CHARS = 64;

/** Markdown structure characters: none of them occurs in an accepted id. */
const MARKDOWN_STRUCTURE_CHARS = /[`|[\]<>#*\\]/g;

/**
 * One string that did not come from this shell's own vocabulary, bounded and
 * neutralised for the report it is about to appear in.
 *
 * Two renderings, and each half is load-bearing on its own: an HTML report is
 * consumed by something that parses tags, so `&` and `<` have to come back as
 * entities; a Markdown report is consumed by something that parses headings,
 * emphasis and tables, so a `#`, a `*` or a backtick would restructure it. An
 * accepted operationId contains none of those characters, which is why bounding
 * and neutralising cost the normal case nothing.
 */
function renderForeign(text: string, format: "html" | "markdown"): string {
  const bounded = text.length <= RENDERED_ID_MAX_CHARS
    ? text
    : `${text.slice(0, RENDERED_ID_MAX_CHARS)}…+${text.length - RENDERED_ID_MAX_CHARS} more chars`;
  const stripped = bounded.replace(/[\u0000-\u001f\u007f]/g, "·");
  return format === "html"
    ? escapeHTML(stripped)
    : stripped.replace(MARKDOWN_STRUCTURE_CHARS, "·");
}

/** One trail id as it appears in a report. */
function renderTrailId(id: string, format: "html" | "markdown"): string {
  return renderForeign(id, format);
}

/** A list of trail ids as it appears in a report. */
function renderTrailIds(ids: readonly string[], format: "html" | "markdown"): string {
  return ids.map((id) => renderTrailId(id, format)).join(", ");
}

/** One fetch failure, in the one line a partial report has room for. */
function describeFetchFailure(error: unknown): string {
  if (error instanceof EngineCallError) {
    return `${error.code}: ${error.message}`;
  }
  const mapped = mapEvidenceReadError(error);
  if (mapped !== undefined) {
    const [first] = mapped.content;
    return first !== undefined && first.type === "text" ? first.text : "the evidence read failed";
  }
  return `${GP_E_INTERNAL}: ${String(error)}`;
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

  // The trail is written from *any* daemon frame: `EvidenceAuditSession.record`
  // collects every string-valued `operationId`/`evidenceId` it finds, with no
  // shape check of its own (it must not invent one — the frames it reads are the
  // daemon's). So an id can reach here that `gp_last_evidence`'s own
  // `operationId` rule would reject, and the HTTP half has always checked
  // (`http-gateway.ts` `OPERATION_ID_PATTERN`). Asking the daemon for one costs a
  // round trip to be told `GP_E_BAD_PARAMS`, and — because a hard error used to
  // abort this call outright — it threw away every pack already fetched, which is
  // the one outcome that leaves the agent holding nothing and re-running the act
  // the report was opened to check on. Validate the shape *before* spending the
  // request, report the rejects, never send them.
  const rejected: string[] = [];
  const sendable: string[] = [];
  for (const id of ids) {
    (OPERATION_ID_PATTERN.test(id) ? sendable : rejected).push(id);
  }
  const format = argv.format === "html" ? ("html" as const) : ("markdown" as const);
  const rejectedClause = (count: number) => `rejected ${count} trail ${count === 1 ? "entry" : "entries"}`
    + ` whose operationId is not one this shell sends (must match op_ + 26 Crockford base32 characters): `;
  if (sendable.length === 0) {
    return {
      content: [{ type: "text", text: formatToolError(
        GP_E_INTERNAL,
        `gp_recent_reports sent no request: all ${ids.length} ${ids.length === 1 ? "id" : "ids"} in this session's trail `
        + "are shaped like operationIds the daemon would reject, so this shell refused them before the wire: "
        + renderTrailIds(rejected, format),
        "these ids were harvested from engine reply frames, so the disagreement is between the daemon and the id "
        + "grammar this shell publishes, not in your arguments, and nothing here can repair one: gp_last_evidence "
        + "and gp_export_evidence apply the same rule, so an id rejected here cannot be fetched from there either. "
        + "Re-run gp_act / gp_assert_element only for work that genuinely has not happened — the operations behind "
        + "these ids are recorded in the trail, and this call reporting them unusable is not evidence that they did "
        + "not run",
      ) }],
      isError: true,
    };
  }

  // Fetch each trail id; the daemon's bounded history may have evicted it or the
  // engine may have restarted, so per-item misses are skipped with a note
  // instead of failing the whole report — and the whole fan-out is bounded by
  // RECENT_REPORTS_BUDGET_MS, so an id the budget could not reach is named as not
  // fetched rather than dropped from the report or waited on without bound.
  const packs: Array<{ id: string; pack: EvidencePackReportView }> = [];
  const skipped: string[] = [];
  const notFetched: string[] = [];
  /** One id the daemon answered with something that is not "no evidence". */
  let hardFailure: {
    id: string;
    line: string;
    mapped: ToolResult;
  } | null = null;
  const fetchOne = async (id: string): Promise<RecentReportFetch> => {
    try {
      // The per-id fetches are reads, but they still carry the generation: a
      // late reply to one of them must not be written into a successor app's
      // trail either.
      const raw = await context.engine.call(
        "last_evidence",
        { operationId: id },
        context.session.generation,
      );
      const parsed = parseEvidenceFrame(raw);
      return { kind: "pack", pack: packForReport(parsed.pack, parsed.measuredSchemaVersion) };
    } catch (error) {
      if (error instanceof EngineCallError && error.code === GP_E_NO_EVIDENCE) {
        return { kind: "missing" };
      }
      // Tagged, never rethrown: this promise is raced against the budget, and a
      // rejection the race has already lost would surface as an unhandled
      // rejection instead of as this call's answer.
      return { kind: "failed", error };
    }
  };

  const budget = new CallBudget(RECENT_REPORTS_BUDGET_MS);
  try {
    for (const [index, id] of sendable.entries()) {
      if (budget.spent) {
        notFetched.push(...sendable.slice(index));
        break;
      }
      const settled = await Promise.race([fetchOne(id), budget.expired]);
      if (settled === "budget") {
        // The read in flight is dropped here, and with it every id that had not
        // been sent: they stay named in the report, because the daemon may still
        // be answering the one in flight — precisely what an agent has to know
        // before it decides whether the action behind it needs doing again.
        notFetched.push(...sendable.slice(index));
        break;
      }
      if (settled.kind === "pack") {
        packs.push({ id, pack: settled.pack });
      } else if (settled.kind === "missing") {
        skipped.push(id);
      } else {
        // The fan-out stops — this shell is not going to keep asking a daemon
        // that answers with an unexpected error — but the packs already in hand
        // do not go with it. Everything the call did manage to read is rendered,
        // and the id that failed is named with the answer it got.
        hardFailure = {
          id,
          line: describeFetchFailure(settled.error),
          mapped: mapAuditError(settled.error),
        };
        notFetched.push(...sendable.slice(index + 1));
        break;
      }
    }
  } finally {
    budget.done();
  }

  if (packs.length === 0 && hardFailure !== null) {
    // Nothing could be rendered, so the daemon's own answer is the whole of this
    // call's information and goes out under its own code — the same answer the
    // call gave before the packs were made to survive a failure, with the ids it
    // never reached appended so that a partial fetch is never read as a full one.
    const [first] = hardFailure.mapped.content;
    const base = first !== undefined && first.type === "text"
      ? first.text
      : `${GP_E_INTERNAL}: the evidence read failed`;
    const extras: string[] = [];
    if (notFetched.length > 0) {
      extras.push(`${notFetched.length} further ${notFetched.length === 1 ? "entry" : "entries"} never fetched: `
        + renderTrailIds(notFetched, format));
    }
    if (rejected.length > 0) {
      extras.push(`${rejectedClause(rejected.length)}${renderTrailIds(rejected, format)}`);
    }
    return {
      content: [{
        type: "text",
        text: extras.length === 0 ? base : `${base}\n> ${extras.join("; ")}`,
      }],
      isError: true,
    };
  }

  if (packs.length === 0 && notFetched.length > 0) {
    // Not "no evidence": the operations are recorded and this call ran out of the
    // wait it allows itself. Answering GP_E_NO_EVIDENCE here would tell an agent
    // its actions produced nothing, which is the one reading that makes it re-run
    // the act they came from.
    return {
      content: [{ type: "text", text: formatToolError(
        GP_E_ENGINE_TIMEOUT,
        `gp_recent_reports fetched no pack inside its ${RECENT_REPORTS_BUDGET_MS}ms budget: ${notFetched.length} of ${ids.length} trail ${ids.length === 1 ? "entry" : "entries"} went unanswered (${renderTrailIds(notFetched, format)})`,
        "the operations are recorded and the daemon may still be answering; ask for fewer at once with a smaller limit (gp_recent_reports advertises 1…20), or read one operation with gp_last_evidence {operationId} / gp_export_evidence {operationId}, each of which answers inside its own deadline. Do not re-run gp_act to regenerate what the trail already holds",
      ) }],
      isError: true,
    };
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

  const render = format === "html" ? renderHTML : renderMarkdown;
  const header = format === "html"
    ? `<h1>GlassPane recent reports (${packs.length})</h1>`
    : `# GlassPane recent reports (${packs.length})`;
  // Every dynamic value that reaches one of these notes has already been through
  // {@link renderForeign}, so the note itself only assembles safe pieces.
  const note = (className: string, sentence: string) => format === "html"
    ? `<p class="${className}">${sentence}</p>`
    : `> ${sentence}`;
  const skipNote = skipped.length === 0
    ? ""
    : note("gp-skipped", `skipped ${skipped.length} unreachable ${skipped.length === 1 ? "entry" : "entries"}: ${renderTrailIds(skipped, format)}`);
  // A budget stop is a different fact from an unreachable entry: the daemon may
  // be answering these right now, so they are named as not fetched, with the
  // wait that ran out, and never folded into the "unreachable" count.
  const unfetchedNote = notFetched.length === 0 ? "" : format === "html"
    ? `<p class="gp-not-fetched">not fetched within this report's ${RECENT_REPORTS_BUDGET_MS}ms wait: ${notFetched.length} ${notFetched.length === 1 ? "entry" : "entries"} left unanswered: ${renderTrailIds(notFetched, format)}. Fetch one by id with gp_last_evidence, or ask again with a smaller limit</p>`
    : `> not fetched within this report's ${RECENT_REPORTS_BUDGET_MS}ms wait: ${notFetched.length} ${notFetched.length === 1 ? "entry" : "entries"} left unanswered: ${renderTrailIds(notFetched, format)}. Fetch one by id with gp_last_evidence, or ask again with a smaller limit`;
  // Ids this shell refused to send are reported as *rejected*, in their
  // neutralised form, and never as "unreachable": the daemon was never asked, so
  // it has no opinion about them, and an agent reading "unreachable" goes looking
  // for evidence that was never addressable.
  const rejectNote = rejected.length === 0
    ? ""
    : note("gp-rejected", `${rejectedClause(rejected.length)}${renderTrailIds(rejected, format)}. They were not sent, so nothing was lost by their absence here: gp_last_evidence validates an id the same way before it asks`);
  const failureNote = hardFailure === null
    ? ""
    : note("gp-fetch-failed", `the report stops here: ${renderTrailId(hardFailure.id, format)} failed with `
      + `${renderForeign(hardFailure.line, format)}. The ${packs.length} ${packs.length === 1 ? "pack" : "packs"} above were fetched and are `
      + "rendered; read the failed one on its own with gp_last_evidence {operationId}. Do not re-run gp_act to "
      + "regenerate what the trail already holds");
  const separator = format === "html" ? "\n<hr>\n" : "\n\n---\n";
  const body = packs.map(({ pack }) => render(pack, undefined)).join(separator);

  const sections: string[] = [header];
  for (const section of [rejectNote, skipNote, unfetchedNote, failureNote]) {
    if (section !== "") {
      sections.push(section);
    }
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


/**
 * The engine view handed to one tool: the same client, with one kind of error's
 * remedy rewritten from this tool's own advertised schema.
 *
 * The transport can only state the fact (a reply did not fit one frame). Which
 * parameters could make the next reply smaller belongs to the tool contract, and
 * includes knobs the caller never sent — `gp_observe` without `maxDepth` still
 * has `maxDepth`. `Object.create` keeps the real client (its pending map, its
 * sinks, its reconnecting transport) on the prototype chain and shadows exactly
 * one method, so wrapping cannot lose state or invent a fake client.
 *
 * The rewrite is not one sentence for every tool, and not one error either:
 * a request whose re-issue changes the user's screen gets the no-retry advice
 * instead of the narrowing advice, because "retry with a narrower X" is an
 * instruction to perform that change a second time. And a reply that never came
 * back is a different fact from a reply that came back too big, so
 * `GP_E_ENGINE_TIMEOUT` is rewritten too — for the tools that advertise a knob
 * the transport cannot see ({@link toolAuthorsTimeoutAdvice}). See
 * {@link replayUnsafePayloadAdvice} and {@link slowReplyAdvice}.
 *
 * `toolArgs` are the arguments the *agent* sent, which for an orchestrated tool
 * are not the params of the frame that failed: `gp_recent_reports` asks
 * `last_evidence` per id, so its `limit` — the one number the caller can still
 * lower — appears nowhere on the wire.
 */
export function engineWithPayloadAdvice(
  engine: EngineJsonRpcClient,
  spec: ToolSpec,
  toolArgs: Record<string, unknown> = {},
): EngineJsonRpcClient {
  const wrapped = Object.create(engine) as EngineJsonRpcClient;
  Object.defineProperty(wrapped, "call", {
    value: (method: string, params?: Record<string, unknown>, correlation?: number): Promise<unknown> =>
      engine.call(method, params, correlation).catch((error: unknown) => {
        if (!(error instanceof EngineCallError)) {
          throw error;
        }
        // The agent's own arguments are the ones it could change, and an
        // orchestrated tool's inner request does not carry them:
        // `gp_recent_reports` fetches `{operationId}` per id, so reading only
        // the frame's params misses a `limit` the caller already sent. The
        // request's own values win where both name one.
        const asked = { ...toolArgs, ...params ?? {} };
        if (error.code === GP_E_PAYLOAD_TOO_LARGE) {
          throw new EngineCallError(
            error.code,
            error.message,
            isReplayUnsafeMethod(method)
              ? replayUnsafePayloadAdvice(spec, method, asked)
              : oversizedReplyAdvice(spec, asked),
          );
        }
        if (
          error.code === GP_E_ENGINE_TIMEOUT
          && toolAuthorsTimeoutAdvice(spec, method, asked)
        ) {
          throw new EngineCallError(error.code, error.message, slowReplyAdvice(spec, asked));
        }
        throw error;
      }),
  });
  return wrapped;
}
