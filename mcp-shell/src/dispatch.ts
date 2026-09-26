import { EngineJsonRpcClient } from "./engine-client.js";
import { executeTool, TOOL_SPECS, ToolSpec } from "./tools.js";
import { EvidenceAuditSession, operationIds } from "./audit-session.js";

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
export const SERVER_INFO = { name: "glasspane-mcp", version: "1.3.0" } as const;

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
      return this.error(INTERNAL_ERROR, `Internal error: ${String(error)}`, request.id);
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
      return this.error(INVALID_PARAMS, "tools/call requires an object params", id);
    }
    const name = params.name;
    if (typeof name !== "string") {
      return this.error(INVALID_PARAMS, "tools/call requires a string name", id);
    }
    const spec = this.specs.find((candidate) => candidate.name === name);
    if (!spec) {
      return this.error(INVALID_PARAMS, `Unknown tool: ${name}`, id);
    }

    const outcome = await executeTool(spec, params.arguments, this.deps.engine, this.session);
    return this.result(id, { content: outcome.content, isError: outcome.isError });
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
): { server: McpServer; session: EvidenceAuditSession } {
  const session = new EvidenceAuditSession();
  engine.onLateReply(({ method, result, correlation }) => {
    if (correlation !== undefined && correlation !== session.generation) {
      // Fast path only: the authoritative comparison happens inside
      // `recordLateArrival`, after the write has taken its turn. This one exists
      // so an obviously-superseded reply does not queue at all.
      // The request was admitted under an earlier attach. Writing its
      // operationId into the trail now would put an operation from the previous
      // app into the new app's history, which is what the trail's whole
      // request-order machinery exists to prevent (R8b-高1). Saying so is the
      // point: the alternative is a late id that silently never appears.
      const ids = operationIds(result);
      report(
        `late reply to '${method}' belongs to a superseded attach (trail generation ${correlation}, current `
        + `${session.generation}): not recorded, and gp_recent_reports will not list it`
        + (ids.length > 0
          ? `; the operations it named are ${ids.join(", ")} — fetch one with gp_last_evidence while the `
            + "daemon still holds it"
          : "; the frame named no operationId, so there is nothing to fetch back"),
      );
      return;
    }
    void session.recordLateArrival(result, correlation).then(
      (outcome) => {
        if (outcome.written) {
          return;
        }
        const ids = operationIds(result);
        report(
          `late reply to '${method}' was admitted under trail generation ${correlation ?? "?"} and the `
          + `chain restarted at ${outcome.generationAtWrite} while it waited: not recorded, and `
          + `gp_recent_reports will not list it`
          + (ids.length > 0
            ? `; the operations it named are ${ids.join(", ")} — fetch one with gp_last_evidence while the `
              + "daemon still holds it"
            : "; the frame named no operationId, so there is nothing to fetch back"),
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
  return { server: new McpServer({ engine, session, report }), session };
}
