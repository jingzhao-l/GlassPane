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
} from "@iterate/kernel";

import { canonicalJson } from "./canonical.js";
import { EngineCallError, EngineJsonRpcClient } from "./engine-client.js";
import { formatToolError, formatToolErrorShape, GP_E_BAD_PARAMS, GP_E_INTERNAL } from "./errors.js";

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

const ExpectSchema = z.union([z.string().max(512), z.boolean()]);

export const AttachArgs = z.strictObject({
  bundleId: OptionalBundleIdSchema,
  pid: OptionalUintSchema,
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

/* ------------------------------------------------------------------ *
 * Tool table (spec §6.2). Each tool maps to one engine method and passes
 * its validated arguments straight through as engine params.
 * ------------------------------------------------------------------ */

export interface ToolSpec {
  name: string;
  description: string;
  engineMethod: string;
  /** JSON Schema emitted by tools/list (hand-written contract, spec §6.2). */
  inputSchema: Record<string, unknown>;
  validate: (args: unknown) => { ok: true; value: Record<string, unknown> } | {
    ok: false;
    issues: string;
  };
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
];

export const TOOL_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(
  TOOL_SPECS.map((spec) => [spec.name, spec]),
);

/* ------------------------------------------------------------------ *
 * Tools/call execution (spec §6.2): pre-validate -> forward -> map error.
 * ------------------------------------------------------------------ */

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

/**
 * Execute a tool against the engine client. Validates arguments against
 * the tool's zod schema (isError + GP_E_BAD_PARAMS on failure), forwards
 * to the engine method, and maps engine/connection errors to agent-facing
 * tool errors.
 */
export async function executeTool(
  spec: ToolSpec,
  args: unknown,
  engine: EngineJsonRpcClient,
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

  try {
    const raw = await engine.call(spec.engineMethod, checked.value);
    // Spec §6.3: evidence packs are passed through a strong validation via
    // the kernel schema before surfacing to the agent, so a Swift↔TS drift
    // (assertion C35) fails here as a tool error instead of corrupt JSON.
    if (spec.engineMethod === "last_evidence") {
      assertEvidencePack(raw);
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
 * Enforces KernelSchemaError.subclass on the engine's last_evidence result.
 * The engine frame is `{evidencePack: {…}}`; the kernel validator consumes
 * the pack body directly and throws on any schema violation.
 */
function assertEvidencePack(raw: unknown): void {
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
  parseEvidencePack(frame.evidencePack);
}

// Re-exported types for dispatch/tests.
export type { Selector, Action, AssertionProperty };