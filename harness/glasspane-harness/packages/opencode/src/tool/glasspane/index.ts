/**
 * GlassPane's native tool surface inside the harness (M1).
 *
 * Three rules shape every tool here, and they are the same rules the MCP shell
 * already obeys:
 *  1. judgement stays in Swift — a tool forwards the daemon's conclusion, it
 *     never derives one (no "did it work" logic in TypeScript);
 *  2. the model only reads `output`, so error codes and agent-executable remedies
 *     go into that string, not only into `metadata` (measured in `harness/spike`:
 *     a metadata-only remedy is invisible to the model);
 *  3. a call that moves a real app goes through the harness permission plane
 *     first, so `gp_act` cannot click silently.
 *
 * Parameter types come from the schemas (`Schema.Schema.Type<…>`) rather than
 * being written by hand, exactly like the upstream tools do — a hand-written
 * `{maxDepth?: string}` next to a `NumberFromString` schema is how a tool ends up
 * lying about what the model will receive.
 */
import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import * as Daemon from "./daemon"

/** One fixed metadata shape: upstream infers the tool's metadata type from what
 *  `execute` returns, so a union of shapes there becomes a union the registry
 *  cannot carry. Exported for the M1 fixed-point tests (same reason as
 *  `glasspaneRow` in M5): the remedy-in-output rule is the invariant worth pinning,
 *  and a test can only pin what it can name. */
export function present(tool: string, method: string, reply: Daemon.DaemonReply, summary: (result: unknown) => string): Tool.ExecuteResult {
  if (!reply.ok) {
    const { code, message, remedy } = reply.error
    return {
      title: `${tool}: ${code}`,
      output: `${message}\nremedy: ${remedy}`,
      metadata: { ok: false, method, code, message, remedy, result: null },
    }
  }
  return {
    title: `${tool}: ${method} ok`,
    output: summary(reply.result),
    metadata: { ok: true, method, code: null, message: null, remedy: null, result: reply.result as object },
  }
}

/** The one failure this surface can produce without reaching the daemon.
 *  Exported for the M1 fixed-point tests, for the same reason as `present`. */
export function unavailable(method: string, message: string): Tool.ExecuteResult {
  const remedy = "start or update the GlassPane background service, then call gp_probe_status to see what the engine advertises"
  return {
    title: `gp_${method}: unavailable`,
    output: `${message}\nremedy: ${remedy}`,
    metadata: { ok: false, method, code: "GP_E_CAPABILITY_UNAVAILABLE", message, remedy, result: null },
  }
}

/**
 * Refuse a method the running engine has not announced. Reading capabilities from
 * `hello` instead of a hard-coded list is deliberate: the method table grows
 * (`audit_ui` landed after this file was written), and a copied list would let the
 * harness claim support it does not have.
 */
const requireCapability = (method: string, capability: string) =>
  Effect.map(Daemon.probeCapabilities(), (caps) => {
    if (!caps) return `the background service did not report capabilities, so ${method} cannot be assumed available`
    if (caps.capabilities.includes(capability)) return undefined
    return `engine ${caps.version} does not advertise the "${capability}" capability that ${method} needs`
  })

const json = (value: unknown) => JSON.stringify(value, null, 2)

/**
 * Read fields out of a daemon response without asserting its shape away. An
 * `as { nodeCount?: unknown }` on `unknown` silences the checker and tells the
 * reader the shape is known — it is not; the engine can add or rename fields, and
 * a non-object answer should surface as `unknown`, not as a thrown property access.
 */
function fields(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/**
 * Render one engine-reported value into the model-facing text.
 *
 * `String(unknown)` is what the linter flags 13 times here, and it deserves the
 * flag: an object arriving from the daemon would stringify to `[object Object]`
 * and the agent would read that as a fact about the app. Anything non-primitive
 * is reported as its JSON, and `null`/`undefined` as the given fallback.
 */
function text(value: unknown, fallback = "unknown"): string {
  if (value === undefined || value === null) return fallback
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  return JSON.stringify(value)
}


export const ProbeStatusParams = Schema.Struct({})

export const ProbeStatusTool = Tool.define(
  "gp_probe_status",
  Effect.gen(function* () {
    return {
      description:
        "Ask the GlassPane background service what it can actually see: engine version, protocol, which verification capabilities it advertises, whether an in-app probe SDK is connected, and the four macOS permission seats (accessibility, input monitoring, screen recording, developer tools) as the daemon measures them. Read-only; touches no target app.",
      parameters: ProbeStatusParams,
      execute: (_params: Schema.Schema.Type<typeof ProbeStatusParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "glasspane", patterns: ["probe_status"], always: ["*"], metadata: { reads: "daemon self-report only" } })
          const probe = yield* Daemon.call("probe_status", {}, 8000)
          const caps = yield* Daemon.probeCapabilities()
          const head = caps
            ? `engine ${caps.version} / protocol ${caps.protocolVersion}\ncapabilities: ${caps.capabilities.join(", ")}\npermissions: ${json(caps.permissions)}`
            : "engine self-report unavailable — the payload below is all the daemon gave"
          return present("gp_probe_status", "probe_status", probe, (result) => `${head}\n\nprobe_status: ${json(result)}`)
        }),
    }
  }),
)

export const AttachParams = Schema.Struct({
  bundleId: Schema.optional(Schema.String.annotate({ description: "CFBundleIdentifier, e.g. com.apple.Notes" })),
  pid: Schema.optional(Schema.NumberFromString.annotate({ description: "process id, when several instances run and the bundle id is ambiguous" })),
})

export const AttachTool = Tool.define(
  "gp_attach",
  Effect.gen(function* () {
    return {
      description:
        "Point the GlassPane engine at a running macOS app by bundle id or pid so later observe/act calls have a target. Reports the app name and pid the engine resolved, and the accessibility permission it measured. Attaching invalidates earlier evidence on purpose: new target, new context.",
      parameters: AttachParams,
      execute: (params: Schema.Schema.Type<typeof AttachParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const blocked = yield* requireCapability("attach", "observe")
          if (blocked) return unavailable("attach", blocked)
          yield* ctx.ask({ permission: "glasspane", patterns: ["attach"], always: ["*"], metadata: params })
          const reply = yield* Daemon.call("attach", params)
          return present("gp_attach", "attach", reply, (result) => `attached: ${json(result)}`)
        }),
    }
  }),
)

export const ObserveParams = Schema.Struct({
  // [gp] The "1-10" in the description used to be prose only: an agent could ask
  // for maxDepth=100000 and the request would sail through until the daemon's
  // 4MB frame cap turned it into a payload error — one wasted round trip, and a
  // denial-of-context lever aimed at the model's own tool call. The bound is now
  // the schema, so the model is corrected before anything leaves the process.
  maxDepth: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt()).check(Schema.isBetween({ minimum: 1, maximum: 10 })).annotate({
      description: "1-10 (enforced by the schema), engine default is 6. Lower it when the tree is huge.",
    }),
  ),
  role: Schema.optional(Schema.String.annotate({ description: "filter to one role, e.g. AXButton" })),
})

export const ObserveTool = Tool.define(
  "gp_observe",
  Effect.gen(function* () {
    return {
      description:
        "Read the accessibility tree of the attached app as the engine serialises it, with a node count and a digest. The digest is what makes a later comparison meaningful — do not eyeball the tree for a change you need to prove; perform the action and read what the engine reports.",
      parameters: ObserveParams,
      execute: (params: Schema.Schema.Type<typeof ObserveParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const blocked = yield* requireCapability("observe", "observe")
          if (blocked) return unavailable("observe", blocked)
          yield* ctx.ask({ permission: "glasspane", patterns: ["observe"], always: ["*"], metadata: params })
          const body: Record<string, unknown> = {}
          if (params.maxDepth !== undefined) body.maxDepth = params.maxDepth
          if (params.role !== undefined) body.role = params.role
          const reply = yield* Daemon.call("observe", body, Daemon.TIMEOUT_MS.observe)
          return present("gp_observe", "observe", reply, (result) => {
            const tree = fields(result)
            return `nodes=${text(tree.nodeCount, "unknown")} digest=${text(tree.digest, "unknown")}\n${json(tree.axTree ?? result)}`
          })
        }),
    }
  }),
)

export const Selector = Schema.Struct({
  role: Schema.String.annotate({ description: "accessibility role, e.g. AXButton" }),
  title: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
})

export const ActParams = Schema.Struct({
  selector: Selector.annotate({ description: "the element to act on" }),
  action: Schema.Literals(["press", "increment", "decrement", "showMenu", "confirm", "cancel", "pick"]),
  degrade: Schema.optional(Schema.Boolean).annotate({
    description: "allow the engine to act while an input window is busy; the resulting evidence is marked contaminated",
  }),
})

export const ActTool = Tool.define(
  "gp_act",
  Effect.gen(function* () {
    return {
      description:
        "Perform one accessibility action on the attached app and return what the engine observed changing: whether the action was confirmed, whether the tree changed, whether pixels changed, and the operation id that ties it to an evidence pack. This drives a real app, so it goes through the permission prompt. Degraded mode is accepted but recorded as contamination — the engine does not relax its verdict for it.",
      parameters: ActParams,
      execute: (params: Schema.Schema.Type<typeof ActParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const blocked = yield* requireCapability("act", "act")
          if (blocked) return unavailable("act", blocked)
          yield* ctx.ask({
            permission: "glasspane",
            patterns: [`act:${params.selector.role}:${params.action}`],
            always: [],
            metadata: fields(params),
          })
          const reply = yield* Daemon.call("act", params, Daemon.TIMEOUT_MS.act)
          return present("gp_act", "act", reply, (result) => {
            const out = fields(result)
            const opId = text(out.operationId, "none")
            return [
              `action confirmed=${text(out.actConfirmed, "?")} tree changed=${text(out.axChanged, "?")} pixels changed=${text(out.pixelChanged, "?")}`,
              `operationId=${opId} evidenceId=${text(out.evidenceId, "none")} latencyMs=${text(out.latencyMs, "?")}`,
              "",
              json(result),
              "",
              `If that is not the change you expected, call gp_diagnose with operationId=${opId} before retrying — do not re-click and hope.`,
            ].join("\n")
          })
        }),
    }
  }),
)

export const DiagnoseParams = Schema.Struct({
  operationId: Schema.optional(Schema.String.annotate({ description: "operation id from gp_act; omit to diagnose the most recent operation" })),
})

export const DiagnoseTool = Tool.define(
  "gp_diagnose",
  Effect.gen(function* () {
    return {
      description:
        "Ask the engine why an operation did not produce the expected change. Returns a classification plus a four-part report (path taken, anomaly, evidence, next action). Defaults to the most recent operation when no id is given.",
      parameters: DiagnoseParams,
      execute: (params: Schema.Schema.Type<typeof DiagnoseParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "glasspane", patterns: ["diagnose"], always: ["*"], metadata: params })
          const reply = yield* Daemon.call("diagnose", params)
          return present("gp_diagnose", "diagnose", reply, (result) => {
            const out = fields(result)
            const report = fields(out.report)
            return `class=${text(out.class, "unknown")}\npath: ${text(report.path, "-")}\nanomaly: ${text(report.anomaly, "-")}\nevidence: ${text(report.evidence, "-")}\nnext: ${text(report.next, "-")}`
          })
        }),
    }
  }),
)

export const LastEvidenceParams = Schema.Struct({
  operationId: Schema.optional(Schema.String.annotate({ description: "omit for the most recent operation" })),
})

export const LastEvidenceTool = Tool.define(
  "gp_last_evidence",
  Effect.gen(function* () {
    return {
      description:
        "Fetch the evidence pack the engine built for an operation: before/after tree digests, pixel diff, attribution level and contamination flag, circuit-breaker state and the assertions checked. This is the artifact you cite when claiming a UI change happened.",
      parameters: LastEvidenceParams,
      execute: (params: Schema.Schema.Type<typeof LastEvidenceParams>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "glasspane", patterns: ["last_evidence"], always: ["*"], metadata: params })
          const reply = yield* Daemon.call("last_evidence", params)
          return present("gp_last_evidence", "last_evidence", reply, (result) => json(result))
        }),
    }
  }),
)

/**
 * What `registry.ts` asks for: one effect yielding the ready-to-register defs, so
 * the vendored patch stays three lines. `Tool.init` is itself an effect (it needs
 * the truncate/agent services), and the requirement is left in the inferred `R`
 * on purpose — annotating it `never` here would be a lie about what the registry
 * has to provide.
 */
export const glasspaneDefs = Effect.gen(function* () {
  const inits = yield* Effect.all([ProbeStatusTool, AttachTool, ObserveTool, ActTool, DiagnoseTool, LastEvidenceTool])
  return yield* Effect.all(inits.map((info) => Tool.init(info)))
})
