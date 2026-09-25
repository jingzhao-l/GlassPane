import { EngineJsonRpcClient } from "./engine-client.js";
import { executeTool, TOOL_SPECS, ToolSpec } from "./tools.js";
import { EvidenceAuditSession } from "./audit-session.js";

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
export const SERVER_INFO = { name: "glasspane-mcp", version: "1.1.2" } as const;

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
  /** Overridable audit session (per-server operationId trail, spec v1.3 §10.3). */
  session?: EvidenceAuditSession;
}

export class McpServer {
  private readonly specs: readonly ToolSpec[];
  private readonly session: EvidenceAuditSession;

  constructor(private readonly deps: McpServerDeps) {
    this.specs = deps.specs ?? TOOL_SPECS;
    this.session = deps.session ?? new EvidenceAuditSession();
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
    // no-op: only `notifications/initialized` is expected at P0; nothing to do.
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