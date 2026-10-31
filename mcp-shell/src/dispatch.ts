import { EngineJsonRpcClient } from "./engine-client.js";
import { attachIdentityOf, executeTool, shellFaultRemedy, TOOL_SPECS, ToolSpec } from "./tools.js";
import {
  ARRIVAL_ORDER_MECHANISM,
  type LateArrivalAttribution,
  EvidenceAuditSession,
  operationIds,
  UNKNOWN_GENERATION,
} from "./audit-session.js";

/* ------------------------------------------------------------------ *
 * JSON-RPC 2.0 message shapes (spec §6.1).
 * ------------------------------------------------------------------ */

export const JSONRPC = "2.0" as const;
/**
 * This shell's own MCP protocol version — the fallback answer on initialize
 * when the client asks for a version we do not implement (spec §6.1).
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;
/**
 * MCP revisions this shell genuinely interoperates with, i.e. the ones
 * initialize echoes back. A version is listed only when everything the shell
 * answers is part of that revision's own dialect: it implements
 * `initialize`/`ping`/`tools/list`/`tools/call` over newline-delimited JSON-RPC
 * 2.0 on stdio, advertises the `tools` capability alone with
 * `listChanged: false`, sends no batch request and no notification it has not
 * been asked for, and returns `content` text without `structuredContent`,
 * `outputSchema`, sampling, roots, elicitation or streaming. All of that is
 * inside the oldest revision below, so echoing it back promises nothing the
 * shell cannot deliver (spec §6.1: 回显客户端版本，不识别时回落本常量).
 *
 * Anything newer or otherwise unknown falls back to {@link
 * MCP_PROTOCOL_VERSION} — including a *newer* revision: this shell has not been
 * shown against it, so it does not claim it.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "2024-11-05",
  "2025-03-26",
  MCP_PROTOCOL_VERSION,
] as const;
export const SERVER_INFO = { name: "glasspane-mcp", version: "1.26.0" } as const;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export interface RpcErrorBody {
  code: number;
  message: string;
}

export interface RpcResponse {
  jsonrpc: typeof JSONRPC;
  id: number | string | null;
  result?: unknown;
  error?: RpcErrorBody;
}

interface IncomingRequest {
  id?: unknown;
  method: unknown;
  params?: unknown;
}

/* ------------------------------------------------------------------ *
 * Server: frame-agnostic request handling. Each line yields at most one
 * response; notifications and empty/blank lines yield null.
 * ------------------------------------------------------------------ */

export interface McpServerDeps {
  engine: EngineJsonRpcClient;
  specs?: readonly ToolSpec[];
  /**
   * The per-server operationId trail (spec v1.3 §10.3). **Required**: it used to
   * be optional with a `?? new EvidenceAuditSession()` default, which let a
   * server be built with a trail nobody else holds a reference to — every tool
   * result then looked correct while `gp_recent_reports` answered from an empty
   * trail, and the late-reply sink was wired to a *different* session. The
   * composition is `createTrackedMcpServer`'s job now, so the default had no
   * legitimate user (R8b-低).
   */
  session: EvidenceAuditSession;
  /**
   * Sink for facts the protocol gives no answer to: a notification this shell
   * does not act on. Without it `notifications/cancelled` — a client saying it
   * has given up on a request — vanished with zero trace while the daemon
   * request it refers to stayed in flight and kept acting on the user's screen.
   */
  report?: (note: string) => void;
  /**
   * Reads how many replies this shell's stdout writer dropped because the pipe
   * stopped draining. `gp_diagnose` surfaces it so a dropped reply is visible
   * in-band rather than only in the log channel; it is wired from `index.ts`,
   * where the `DrainAwareWriter` that counts them lives.
   */
  stdoutDroppedFrames?: () => number;
}

export class McpServer {
  private readonly specs: readonly ToolSpec[];
  private readonly session: EvidenceAuditSession;

  constructor(private readonly deps: McpServerDeps) {
    // Checked at runtime, not only in types: every caller that matters here is
    // JavaScript (`dist` consumers, the smoke scripts, the tests), where a
    // missing `session` would compile forever and fall back to a per-call trail
    // that silently loses operations. Refusing is the only way the requirement
    // exists outside the editor.
    if (!deps.session) {
      throw new Error(
        "McpServer requires a shared EvidenceAuditSession: build it with "
        + "createTrackedMcpServer(engine, report), which also wires the late-reply sink",
      );
    }
    this.specs = deps.specs ?? TOOL_SPECS;
    // Same reason the `session` check above exists: the specs list reaches this
    // constructor from JavaScript callers (the HTTP gateway's route subset, the smoke
    // scripts, the tests), where a tool spec without a callable `validate` type-checks
    // forever and then throws *mid-request* — `callShapeRemedy()` runs `validate` to pick
    // an example, and a spec missing it turned a caller's shape error into
    // `Internal error: TypeError: spec.validate is not a function` on the wire. Refusing
    // at construction names the defect once, at the place that can fix it.
    for (const spec of this.specs) {
      if (typeof spec.validate !== "function") {
        throw new Error(
          `ToolSpec "${String(spec.name)}" has no callable validate: every spec handed to `
          + 'McpServer must carry the same validate the call path runs (see TOOL_SPECS in src/tools.ts)',
        );
      }
    }
    this.session = deps.session;
  }

  /** Handle a single newline-delimited frame; returns a response or null. */
  async handleLine(line: string): Promise<RpcResponse | null> {
    if (line.trim() === "") {
      return null; // blank frame — no response per protocol §6.1
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return this.error(PARSE_ERROR, "Parse error", null);
    }

    if (!this.isRequestBody(parsed)) {
      return this.error(INVALID_REQUEST, "Invalid Request", null);
    }
    const request = parsed as IncomingRequest;

    if (request.id === undefined) {
      // Notification: process but never answer. Unknown notifications are
      // ignored rather than rejected (spec §6.1).
      await this.handleNotification(request);
      return null;
    }
    if (typeof request.id !== "number" && typeof request.id !== "string") {
      return this.error(INVALID_REQUEST, "Invalid Request", null);
    }

    try {
      return await this.dispatch(request, request.id);
    } catch (error) {
      // `String(error)` may not ride this frame. The HTTP side already refuses that
      // shape (`wireCause` in src/http-gateway.ts: the detail goes to the process's own
      // stderr, the wire gets a sentence that names no file), and an un-converted stdio
      // arm made this shell leak exactly what the other half withholds: internal type and
      // message text, with no remedy for the reader to act on.
      const method = this.callTargetName(request);
      const type = error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
      try {
        process.stderr.write(
          `[glasspane-mcp] an internal failure while handling ${String(request.method)}: `
          + `${type} — ${String(error)} (withheld from the stdio frame: a description of an internal `
          + "failure names files and symbols this frame does not publish; the line above is the one to hand over)\n",
        );
      } catch {
        // A stderr that cannot take a log line leaves nowhere to report — the same
        // allowance `stdio-session.ts`'s logger makes. The answer must still go out.
      }
      return this.error(INTERNAL_ERROR,
        `this shell faulted while handling ${String(request.method)} and answered nothing `
        + `(failure type ${type}) | remedy: ${shellFaultRemedy(method)}`,
        request.id);
    }
  }

  private async handleNotification(request: IncomingRequest): Promise<void> {
    // Nothing is *done* with a notification: only `notifications/initialized`
    // was expected at P0, and answering one would be a protocol error. But
    // `notifications/cancelled` is a client saying it has given up on a request
    // this shell may well have already forwarded to the daemon — and the daemon
    // is single-connection and still acting on it. Dropping that silently left
    // no trace of the most confusing state an operator can hit ("I cancelled,
    // why did it still click?"), so it is reported. R8b-中5.
    const method = request.method;
    if (method === "notifications/cancelled") {
      const params = request.params as { requestId?: unknown } | undefined;
      const target = params && params.requestId !== undefined ? String(params.requestId) : "<no requestId>";
      this.deps.report?.(
        `received notifications/cancelled for request ${target}; this shell cannot cancel what the daemon is `
        + "already doing, so if that request had been forwarded it is still running and can still change the "
        + "user's screen \u2014 its reply will be attributed and recorded when it lands. A cancel is not an undo",
      );
    } else if (method !== "notifications/initialized") {
      this.deps.report?.(
        `notification '${String(method)}' is not implemented by this shell and was dropped without an answer `
        + "(notifications never get one); nothing was done with it",
      );
    }
  }

  private async dispatch(request: IncomingRequest, id: number | string): Promise<RpcResponse> {
    if (typeof request.method !== "string") {
      return this.error(INVALID_REQUEST, "Invalid Request", id);
    }

    switch (request.method) {
      case "initialize":
        return this.result(id, {
          protocolVersion: this.negotiateProtocolVersion(request.params),
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      case "ping":
        return this.result(id, {});
      case "tools/list":
        return this.result(id, {
          tools: this.specs.map((spec) => ({
            name: spec.name,
            description: spec.description,
            inputSchema: spec.inputSchema,
          })),
        });
      case "tools/call":
        return this.callTool(id, request.params);
      default:
        return this.error(METHOD_NOT_FOUND, `Method not found: ${request.method}`, id);
    }
  }

  /**
   * Spec §6.1: echo the client's protocolVersion when this server implements it
   * (the shipped {@link SUPPORTED_PROTOCOL_VERSIONS}; see that list for what
   * "implements" means here), otherwise fall back to MCP_PROTOCOL_VERSION. A
   * missing or non-string version is just "not recognized" — it falls back too,
   * and never throws.
   */
  private negotiateProtocolVersion(rawParams: unknown): string {
    if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
      return MCP_PROTOCOL_VERSION;
    }
    const requested: unknown = (rawParams as Record<string, unknown>).protocolVersion;
    if (typeof requested !== "string") {
      return MCP_PROTOCOL_VERSION;
    }
    return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
  }

  private async callTool(id: number | string, rawParams: unknown): Promise<RpcResponse> {
    const params = this.asParams(rawParams);
    if (!params) {
      return this.error(INVALID_PARAMS, `tools/call requires an object params | remedy: ${this.callShapeRemedy()}`, id);
    }
    const name = params.name;
    if (typeof name !== "string") {
      return this.error(INVALID_PARAMS, `tools/call requires a string name | remedy: ${this.callShapeRemedy()}`, id);
    }
    const spec = this.specs.find((candidate) => candidate.name === name);
    if (!spec) {
      return this.error(INVALID_PARAMS, `Unknown tool: ${name}`
        + ` | remedy: ${this.publishedNamesNear(name)}`, id);
    }

    // `arguments` is optional in the MCP `tools/call` shape: a tool with no
    // required inputs (`gp_observe`, `gp_probe_status`, `gp_project_list`…) is
    // legally called without it. Passing `undefined` into a `z.strictObject`
    // schema produced "invalid arguments … | remedy: … : Required" — a remedy
    // naming a cause the published schema (`properties: {}`, no `required`)
    // denies, and an empty issue path that renders as a stray `": Required"`.
    // Absent means empty here, exactly what the `{"arguments":{}}` twin sends.
    const outcome = await executeTool(
      spec,
      params.arguments ?? {},
      this.deps.engine,
      this.session,
      this.deps.stdoutDroppedFrames,
    );
    return this.result(id, { content: outcome.content, isError: outcome.isError });
  }

  /**
   * The tool a `tools/call` names, when the frame names one. `shellFaultRemedy` branches on
   * whether the engine method is safe to re-issue, so a fault inside `gp_act` must not be
   * answered with the generic "read what happened" sentence — and the name is only usable
   * when the frame actually carries a string, which the shape refusals above handle.
   */
  private callTargetName(request: IncomingRequest): string {
    const params = this.asParams(request.params);
    return typeof params?.name === "string" && params.name.length > 0
      ? params.name
      : String(request.method);
  }

  private asParams(rawParams: unknown): { name: unknown; arguments?: unknown } | null {
    if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
      return null;
    }
    return rawParams as { name: unknown; arguments?: unknown };
  }

  private isRequestBody(value: unknown): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return candidate.jsonrpc === JSONRPC;
  }

  private result(id: number | string, result: unknown): RpcResponse {
    return { jsonrpc: JSONRPC, id, result };
  }

  /**
   * The example for the two `tools/call` **shape** refusals, taken from the list this server
   * actually answers. A JSON-RPC reader cannot open a source symbol, and an example naming a
   * tool this surface does not publish would be a second refusal waiting to happen — so the
   * preference is a published tool that is legal to call with an empty `arguments`.
   *
   * "Legal with an empty arguments" is measured by running the same `validate` the call path
   * runs (`executeTool(spec, params.arguments ?? {}, …)`), not by reading `required` off the
   * advertised JSON Schema. Those two are not the same question: `gp_attach` publishes
   * `oneOf: [{required:[bundleId]}, {required:[pid]}]` with no top-level `required` key, so the
   * schema read called it "takes nothing" while its own refinement refuses `{}` — and measured
   * on the delivered artifact, the remedy this sentence prints sent the agent to a call answered
   * `GP_E_BAD_PARAMS: attach takes exactly one of bundleId or pid`. An example the caller is
   * guaranteed to fail is worse than no example, which is the rule `publishedNamesNear` below
   * already states for the *name* half of the same sentence.
   * `test/dispatch.test.mjs` checks every name in this sentence against `tools/list`, checks it
   * again on a server deliberately built with a one-tool list, and now checks that the named
   * tool really answers `arguments: {}` without a params refusal.
   */
  private callShapeRemedy(): string {
    const takesNothing = this.specs.filter((spec) => spec.validate({}).ok);
    const example = takesNothing[0]?.name;
    if (example === undefined) {
      return "no tool is published on this connection; call tools/list to read what it answers";
    }
    return `send {"name":"${example}","arguments":{}} — a tool with no required inputs answers to an empty `
      + "arguments object; tools/list lists every tool this server answers";
  }

  /**
   * The names this server actually answers with, nearest the caller's guess first. Every
   * name offered here is one `tools/list` just advertised: a suggestion the caller cannot
   * call is worse than no suggestion, and the point of the sentence is to end the guessing
   * loop a bare `Unknown tool: gp_acti` left the caller in.
   */
  private publishedNamesNear(guess: string): string {
    const names = this.specs.map((spec) => spec.name);
    const near = names.filter((candidate) => candidate.startsWith(guess.slice(0, 6)));
    const offered = near.length > 0 ? near : names;
    return `call one of: ${offered.join(", ")} — or call tools/list to read this server's own list`;
  }

  private error(code: number, message: string, id: number | string | null): RpcResponse {
    return { jsonrpc: JSONRPC, id, error: { code, message } };
  }
}

/**
 * Wire an engine client to a server over one shared audit session, including the
 * late-reply sink (R8-高3).
 *
 * This is a function rather than four lines inside `main()` so that the test for
 * "a reply that lands after the caller was answered still reaches the trail"
 * drives **the** wiring an MCP client actually gets. Inlining it would leave the
 * only copy of that decision in a file that runs `main()` on import, i.e. a fix
 * on a path no test can execute.
 *
 * The session is created here and handed to `McpServer` rather than left to its
 * default, because the engine client must reach the *same* instance: a late
 * reply names an operation that really ran, and the only place an agent can get
 * that back from is this trail (`gp_recent_reports`). A sink that recorded into
 * a second session would look fixed and change nothing.
 */
export function createTrackedMcpServer(
  engine: EngineJsonRpcClient,
  report: (note: string) => void,
  stdoutDroppedFrames?: () => number,
): { server: McpServer; session: EvidenceAuditSession } {
  const session = new EvidenceAuditSession();
  /**
   * The clause an id list carries when the frame it came from was never matched by id.
   *
   * `gp_recent_reports` already renders {@link TRAIL_PROVENANCE_NOTES} beside a recorded
   * id, but both refusal paths below name ids for a frame that is *not* in the trail, and
   * an agent holding `op_…` from a log line has no trail entry to read the caveat out of.
   * Saying "the operations it named are X" for an arrival-order guess states a match the
   * transport could not make, so the mechanism goes in the sentence — the same
   * {@link ARRIVAL_ORDER_MECHANISM} text the trail note is built from, so the two surfaces
   * describe one rule and not two. Nothing here adjudicates the ids: it does not say the
   * operation did not run, and it does not say the guess is wrong.
   */
  // 机制文字按**键查表**取，不在这里比较 `attribution` 的值：比较引擎交来的证据字段
  // （`attribution` 就是其中一个）会把解释搬进壳里，`harness/tools/surface-semantics.mjs`
  // 正是为此而红（本轮 CI 上被抓到）。查同一张表得到的还是同一句话，判据仍在引擎。
  const LATE_REPLY_CLAUSE: Partial<Record<LateArrivalAttribution, string>> = {
    "arrival-order": ` (the frame echoed no request id, so ${ARRIVAL_ORDER_MECHANISM}: these are the ids that frame carried, `
      + "which is the most this shell can say about which operation they are)",
  };
  const arrivalOrderClause = (attribution: LateArrivalAttribution | undefined): string => (
    attribution === undefined ? "" : LATE_REPLY_CLAUSE[attribution] ?? ""
  );
  engine.onLateReply(({ method, result, correlation, attribution }) => {
    if (correlation !== undefined && correlation !== session.generation) {
      // The request was admitted under an earlier attach: writing its
      // operationId now would put an operation from the previous app into the
      // new app's history, which is what the trail's whole request-order
      // machinery exists to prevent (R8b-高1). This test at arrival is a fast
      // path only — the authoritative one is inside `recordLateArrival`, after
      // the write has taken its turn — and it exists so an obviously superseded
      // reply does not queue at all. Saying so is the point either way: the
      // alternative is a late id that silently never appears.
      const ids = operationIds(result);
      report(
        `late reply to '${method}' belongs to a superseded attach (trail generation ${correlation}, current `
        + `${session.generation}): not recorded, and gp_recent_reports will not list it`
        + (ids.length > 0
          ? `; the operations it named are ${ids.join(", ")}${arrivalOrderClause(attribution)} — fetch one with `
            + "gp_last_evidence while the daemon still holds it"
          : "; the frame named no operationId, so there is nothing to fetch back"),
      );
      return;
    }
    void session.recordLateArrival((trail) => {
      if (method === "attach") {
        // A late attach reply is still the event that changes which app the
        // trail belongs to. Restarting only on the in-time path (what 8b shipped)
        // left the generation untouched, so every epoch gate added to catch the
        // cross-app leak was dead for the busiest — and most leak-prone — case.
        const restarted = trail.restart(attachIdentityOf(result));
        report(
          restarted
            ? `late attach reply: the trail restarted for ${describeAttach(result)} (generation ${trail.generation})`
            : `late attach reply for the already-attached ${describeAttach(result)}: trail unchanged`,
        );
        return;
      }
      trail.record(result);
    // The frame's own attribution, forwarded: an id pulled out of a reply that echoed
    // no request id is filed as inferred, and `gp_recent_reports` must say so rather
    // than let the entry read as verified (R10-中2). Dropping it would be the worse
    // lie — it would claim no such operation ran.
    }, correlation ?? UNKNOWN_GENERATION, attribution).then(
      (outcome) => {
        if (outcome.written) {
          return;
        }
        const ids = operationIds(result);
        report(
          `late reply to '${method}' was admitted under trail generation ${correlation ?? "unknown"}, which the `
          + `chain restarted away from (now ${outcome.generationAtWrite}): not recorded, and gp_recent_reports `
          + "will not list it"
          + (ids.length > 0
            ? `; the operations it named are ${ids.join(", ")}${arrivalOrderClause(attribution)} — fetch one with `
              + "gp_last_evidence while the daemon still holds it"
            : "; no operationId appeared within the depth this shell reads (3), so there is nothing it "
              + "can name for you to fetch back"),
        );
      },
      (error: unknown) => {
        // Reported, never swallowed: the reply body itself is already in the log
        // line the client emitted before calling this sink, so this one says
        // specifically that the *trail write* failed.
        report(`late reply could not be recorded in this session's trail: ${String(error)}`);
      },
    );
  });
  return { server: new McpServer({ engine, session, report, stdoutDroppedFrames }), session };
}

/** The attach result's app, phrased for a log line; never a guessed identity. */
function describeAttach(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    return "an attach reply that is not an object";
  }
  const record = result as Record<string, unknown>;
  const parts = ["pid", "bundleId", "appName"]
    .filter((field) => record[field] !== undefined && record[field] !== null)
    .map((field) => `${field}=${String(record[field])}`);
  return parts.length > 0 ? parts.join(" ") : "an attach reply naming no app";
}
