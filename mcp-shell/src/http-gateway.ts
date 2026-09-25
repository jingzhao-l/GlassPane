import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";

import { EngineCallError, unixSocketEngineClient } from "./engine-client.js";
import { GP_E_BAD_PARAMS, GP_E_INTERNAL, GP_E_NO_EVIDENCE } from "./errors.js";
import { escapeHTML, renderHTML, renderMarkdown } from "./evidence-report.js";
import type { EvidencePackReportView } from "./evidence-report.js";
import { packForReport, parseEvidenceFrame, TOOL_SPECS, type ToolSpec } from "./tools.js";

/**
 * HTTP/REST transport for non-MCP clients (curl / scripts) to reach the GlassPane
 * verification engine without speaking MCP-on-stdio. Listens on 127.0.0.1 only
 * (never a wildcard), reuses the existing `unixSocketEngineClient` line transport
 * to bridge into the daemon socket, and adds no third-party dependency.
 *
 * The project's honesty rule applies here as everywhere: a pack that cannot be
 * measured or reached is reported as such (`skipped` in aggregation, an
 * `ok:false` error for a single missing operation), never as a fake success.
 */

/** Env var carrying the bearer token; the gateway refuses to start without it. */
export const GLASSPANE_HTTP_TOKEN_ENV = "GLASSPANE_HTTP_TOKEN";

export const DEFAULT_GATEWAY_PORT = 8787;
/** Hard-bound; a request host header is never trusted for routing decisions. */
export const DEFAULT_GATEWAY_HOST = "127.0.0.1";

/** Ceiling on a forwarded request body, so no client can exhaust gateway memory. */
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

/**
 * Ceiling on one GET /v1/evidence?ids= aggregation (aligned with the MCP
 * recent_reports limit=20). Without it a single request could fan into the
 * daemon as thousands of serial last_evidence calls (request amplification /
 * DoS); over the ceiling the whole call is rejected with 400.
 */
const MAX_EVIDENCE_IDS = 20;

/** operationId shape shared with the daemon / MCP shell (form `op_` + 26 Crockford base32). */
const OPERATION_ID_PATTERN = /^op_[0-9A-HJKMNP-TV-Z]{26}$/;

const REPORT_FORMATS = ["html", "markdown"] as const;
type ReportFormat = (typeof REPORT_FORMATS)[number];
function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

/** Gateway-raised error codes (not daemon codes): auth / routing / input. */
const HTTP_UNAUTHORIZED = "GP_HTTP_UNAUTHORIZED";
const HTTP_NOT_FOUND = "GP_HTTP_NOT_FOUND";
const HTTP_BAD_REQUEST = "GP_HTTP_BAD_REQUEST";
const HTTP_PAYLOAD_TOO_LARGE = "GP_HTTP_PAYLOAD_TOO_LARGE";
/**
 * Returned when a route is intentional but maps to no daemon socket method on
 * this build (e.g. /v1/stats only exists as the daemon CLI --evidence-stats):
 * the answer is an honest "not provided here", never a fabricated success.
 */
const HTTP_NOT_PROVIDED = "GP_HTTP_NOT_PROVIDED";

/** The client surface the gateway depends on; injectable for tests. */
export interface EngineClientLike {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Present on the real client; optional so a fake may omit it. */
  close?(): void;
}

export interface HttpGatewayOptions {
  /** Daemon socket path handed to the engine client (the default connector). */
  socketPath: string;
  /** Bearer token from `GLASSPANE_HTTP_TOKEN`; never generated, never defaulted. */
  token: string;
  port?: number;
  host?: string;
  /** Injectable client factory so tests run without a real socket. */
  connectController?: (socketPath: string) => EngineClientLike;
}

export interface HttpGateway {
  server: Server;
  /** Closes the engine client and the HTTP server, resolving once listeners stop. */
  close(): Promise<void>;
}

/**
 * Methods the gateway forwards straight to the daemon: the tool specs without a
 * custom executor, keyed by engine method name (`act`, `observe`, `attach`, …).
 * Orchestrated tools (`export_evidence`, `recent_reports`, project ops) are
 * excluded — they are not daemon socket methods, and the gateway only claims to
 * bridge to the daemon. Reusing `TOOL_SPECS` keeps validation identical to the
 * MCP path instead of duplicating a second schema.
 */
const FORWARDABLE_TOOLS: ReadonlyMap<string, ToolSpec> = new Map(
  TOOL_SPECS.filter((spec) => spec.execute === undefined).map((spec) => [spec.engineMethod, spec]),
);

export function createHttpGateway(options: HttpGatewayOptions): HttpGateway {
  const port = options.port ?? DEFAULT_GATEWAY_PORT;
  const host = options.host ?? DEFAULT_GATEWAY_HOST;
  if (options.token === "") {
    throw new Error(
      `createHttpGateway requires a non-empty token (read ${GLASSPANE_HTTP_TOKEN_ENV}); refusing to start with an empty or defaulted token`,
    );
  }
  const client: EngineClientLike = options.connectController !== undefined
    ? options.connectController(options.socketPath)
    : unixSocketEngineClient(options.socketPath);
  const expectedToken = Buffer.from(options.token, "utf8");

  const server = http.createServer((req, res) => {
    handleHttp(req, res, client, expectedToken).catch((error) => {
      // Never let one bad request kill the server; report an honest envelope.
      fail(res, 500, GP_E_INTERNAL, `internal gateway error: ${String(error)}`, "see the gateway log and retry");
    });
  });
  server.listen(port, host);

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      client.close?.();
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
      // Node only fires server.close's callback once every connection is gone;
      // keep the promise from hanging on a keep-alive client.
      forceCloseConnections(server);
    });

  return { server, close };
}

function forceCloseConnections(server: Server): void {
  const withCloseAll = server as Server & { closeAllConnections?: () => void };
  if (typeof withCloseAll.closeAllConnections === "function") {
    withCloseAll.closeAllConnections();
  }
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  client: EngineClientLike,
  expectedToken: Buffer,
): Promise<void> {
  if (!authorized(req, expectedToken)) {
    fail(res, 401, HTTP_UNAUTHORIZED,
      "missing or invalid Authorization: Bearer <token>",
      "set the Authorization header to `Bearer <token>` where <token> is the GLASSPANE_HTTP_TOKEN the gateway was launched with");
    return;
  }

  const url = parseRequestUrl(req.url);
  if (url === null) {
    fail(res, 400, HTTP_BAD_REQUEST, "could not parse request URL", "send a well-formed request line");
    return;
  }
  const segments = url.pathname.split("/").filter((part) => part !== "");
  await dispatch(req, res, url, segments, client);
}

/** Parse the request target against a fixed base; the host field is never trusted. */
function parseRequestUrl(raw: string | undefined): URL | null {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  try {
    return new URL(raw, `http://${DEFAULT_GATEWAY_HOST}`);
  } catch {
    return null;
  }
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: readonly string[],
  client: EngineClientLike,
): Promise<void> {
  const [v1, resource, id] = segments;
  if (v1 !== "v1") {
    NotFound(res, url.pathname);
    return;
  }
  if (req.method === "GET") {
    // Each GET route requires exactly its own segment count. A surplus segment
    // (`/v1/evidence/<id>/junk`, `/v1/hello/x`) is a 404, never a silently
    // trimmed route: trimming would let a caller think a path is invalid while
    // the real act still runs underneath it, which is dangerous on a live action.
    if (resource === "hello" && segments.length === 2) {
      await handleHello(client, res);
      return;
    }
    if (resource === "evidence" && segments.length === 2) {
      await handleEvidenceAggregate(url, client, res);
      return;
    }
    if (resource === "evidence" && segments.length === 3 && id !== undefined) {
      await handleEvidenceSingle(id, url, client, res);
      return;
    }
    if (resource === "stats" && segments.length === 2) {
      handleEvidenceStats(res);
      return;
    }
  } else if (req.method === "POST") {
    if (resource === "tools" && segments.length === 3 && id !== undefined) {
      await handleToolForward(id, req, client, res);
      return;
    }
    if (resource === "recipes" && id === "validate" && segments.length === 3) {
      await handleRecipeValidate(req, res);
      return;
    }
  }
  NotFound(res, url.pathname);
}

async function handleHello(client: EngineClientLike, res: ServerResponse): Promise<void> {
  try {
    const result = await client.call("hello");
    ok(res, result);
  } catch (error) {
    failEngine(res, error);
  }
}

async function handleEvidenceSingle(
  rawId: string,
  url: URL,
  client: EngineClientLike,
  res: ServerResponse,
): Promise<void> {
  const operationId = parseOperationId(rawId);
  if (operationId === null) {
    fail(res, 400, HTTP_BAD_REQUEST,
      `invalid operationId '${rawId}'`,
      "operationId must match `op_[0-9A-HJKMNP-TV-Z]{26}`");
    return;
  }
  const format = parseFormat(url.searchParams.get("format"));
  if (format === null) {
    fail(res, 400, HTTP_BAD_REQUEST, "invalid format", "format must be 'html' or 'markdown'");
    return;
  }
  try {
    const raw = await client.call("last_evidence", { operationId });
    const { pack, measuredSchemaVersion } = parseEvidenceFrame(raw);
    const view = packForReport(pack, measuredSchemaVersion);
    ok(res, { operationId, format, report: render(view, format) });
  } catch (error) {
    failEngine(res, error);
  }
}

async function handleEvidenceAggregate(
  url: URL,
  client: EngineClientLike,
  res: ServerResponse,
): Promise<void> {
  const ids = parseOperationIdList(url.searchParams.get("ids"));
  if (ids === null) {
    fail(res, 400, HTTP_BAD_REQUEST,
      "invalid or empty ids",
      "ids must be a comma-separated list of operationIds of form `op_[0-9A-HJKMNP-TV-Z]{26}`");
    return;
  }
  if (ids.length > MAX_EVIDENCE_IDS) {
    fail(res, 400, HTTP_BAD_REQUEST,
      `too many ids: ${ids.length} exceeds the ${MAX_EVIDENCE_IDS}-id ceiling`,
      `pass at most ${MAX_EVIDENCE_IDS} operationIds per request; split the batch`);
    return;
  }
  const format = parseFormat(url.searchParams.get("format"));
  if (format === null) {
    fail(res, 400, HTTP_BAD_REQUEST, "invalid format", "format must be 'html' or 'markdown'");
    return;
  }

  // Fetch each id; the daemon's bounded history may have evicted it or the
  // engine may have restarted, so per-item misses are skipped with a note
  // instead of failing the whole report (honesty: a missing pack is "skipped",
  // never a fabricated render).
  const blocks: string[] = [];
  const renderedIds: string[] = [];
  const skipped: string[] = [];
  for (const operationId of ids) {
    try {
      const raw = await client.call("last_evidence", { operationId });
      const { pack, measuredSchemaVersion } = parseEvidenceFrame(raw);
      blocks.push(render(packForReport(pack, measuredSchemaVersion), format));
      renderedIds.push(operationId);
    } catch (error) {
      if (error instanceof EngineCallError && error.code === GP_E_NO_EVIDENCE) {
        skipped.push(operationId);
      } else {
        await failEngine(res, error);
        return;
      }
    }
  }

  if (blocks.length === 0) {
    fail(res, 404, GP_E_NO_EVIDENCE,
      "none of the requested operations have evidence in the daemon history",
      "the engine may have restarted or those operationIds never produced evidence; re-run gp_act / gp_assert_element to regenerate");
    return;
  }

  const header = format === "html"
    ? `<h1>GlassPane evidence reports (${blocks.length})</h1>`
    : `# GlassPane evidence reports (${blocks.length})`;
  const skipNote = makeSkipNote(skipped, format);
  const separator = format === "html" ? "\n<hr>\n" : "\n\n---\n";
  const sections: string[] = [header];
  if (skipNote !== "") {
    sections.push(skipNote);
  }
  sections.push(blocks.join(separator));
  ok(res, { format, renderedIds, skipped, report: sections.join("\n") });
}

async function handleToolForward(
  name: string,
  req: IncomingMessage,
  client: EngineClientLike,
  res: ServerResponse,
): Promise<void> {
  const spec = FORWARDABLE_TOOLS.get(name);
  if (spec === undefined) {
    fail(res, 404, HTTP_NOT_FOUND,
      `unknown tool method '${name}'`,
      "the gateway only forwards the daemon methods an MCP-less caller can use; see TOOL_SPECS for the whitelist");
    return;
  }

  let body: unknown;
  try {
    const text = await readBody(req, MAX_REQUEST_BODY_BYTES);
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof HTTPPayloadTooLargeError) {
      fail(res, 400, HTTP_PAYLOAD_TOO_LARGE,
        `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
        "shrink the request payload and retry");
      return;
    }
    fail(res, 400, HTTP_BAD_REQUEST,
      "request body must be a JSON object of tool params",
      "send a JSON object matching the tool's input schema");
    return;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    fail(res, 400, HTTP_BAD_REQUEST,
      "request body must be a JSON object of tool params",
      "send a JSON object matching the tool's input schema");
    return;
  }

  const checked = spec.validate(body);
  if (!checked.ok) {
    fail(res, 400, GP_E_BAD_PARAMS,
      `invalid arguments for '${name}'`,
      checked.issues);
    return;
  }

  try {
    const result = await client.call(spec.engineMethod, checked.value);
    // Honesty-bypass guard (mirrors tools.ts §6.3): a last_evidence frame is
    // passed through the strong read-side validation before it is surfaced, so
    // a pack the engine wrote but the kernel cannot parse is reported as an
    // error here and never echoed forward as if it were trusted evidence.
    if (spec.engineMethod === "last_evidence") {
      try {
        parseEvidenceFrame(result);
      } catch {
        fail(res, 502, GP_E_INTERNAL,
          "the daemon returned a last_evidence frame that does not match the engine contract (no parseable evidencePack)",
          "reenact the operation so the daemon writes a fresh pack; if it still fails, the engine and kernel schemas have drifted (assertion C35)");
        return;
      }
    }
    ok(res, result);
  } catch (error) {
    await failEngine(res, error);
  }
}

/* ------------------------------------------------------------------ *
 * Endpoints whose capability exists only as a daemon CLI command on this build
 * (no socket method): the gateway answers honestly that it cannot measure or
 * validate here, and never mints a fake success (honesty red line).
 * ------------------------------------------------------------------ */

/** GET /v1/stats: evidence stats are the daemon CLI `--evidence-stats`, not a
 * socket method on this build. The gateway reports "not provided" rather than
 * inventing count/totalBytes/listFailure/dir. */
function handleEvidenceStats(res: ServerResponse): void {
  fail(res, 501, HTTP_NOT_PROVIDED,
    "evidence statistics are not exposed over this daemon's socket protocol in this build",
    "run `glasspaned --evidence-stats` against the same --state-dir this socket serves to get count/totalBytes/listFailure/dir");
}

/** POST /v1/recipes/validate: recipe validation (`glasspaned --recipe-validate`)
 * is a daemon CLI capability, not a socket method on this build. The recipe JSON
 * body is drained/disposed but never "validated" here, and no fake valid result
 * is minted — the caller is pointed at the daemon CLI that genuinely validates. */
async function handleRecipeValidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await readBody(req, MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    if (error instanceof HTTPPayloadTooLargeError) {
      fail(res, 400, HTTP_PAYLOAD_TOO_LARGE,
        `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
        "shrink the request payload and retry");
      return;
    }
    fail(res, 400, HTTP_BAD_REQUEST, "could not read the request body", "resend the request");
    return;
  }
  fail(res, 501, HTTP_NOT_PROVIDED,
    "recipe validation is not exposed over this daemon's socket protocol in this build",
    "run `glasspaned --recipe-validate <recipe.json-path>`; this build provides no socket method for it");
}

/* ------------------------------------------------------------------ *
 * Auth (security red line: no defaulted or hard-coded token; the caller
 * must supply GLASSPANE_HTTP_TOKEN before the gateway will start).
 * ------------------------------------------------------------------ */

function authorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null) {
    return false;
  }
  const bearer = match[1];
  if (bearer === undefined) {
    return false;
  }
  return tokenMatches(expected, bearer);
}

/**
 * Constant-time comparison. Every candidate, whatever its length, is hashed to
 * a fixed 32-byte digest before the timing-safe compare, so a length mismatch
 * never returns early and neither length nor prefix can be probed from response
 * timing or from an observable branch (the work is the same for any input).
 */
function tokenMatches(expected: Buffer, received: string): boolean {
  const expectedDigest = sha256(expected);
  const receivedDigest = sha256(Buffer.from(received, "utf8"));
  return timingSafeEqual(expectedDigest, receivedDigest);
}

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/* ------------------------------------------------------------------ *
 * Input validation (guard clauses everywhere; user input never reaches a
 * filesystem path or a shell — it only selects a validated daemon method
 * or a validated operationId).
 * ------------------------------------------------------------------ */

function parseOperationId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return OPERATION_ID_PATTERN.test(value) ? value : null;
}

/** Comma-separated list; every token must validate, else the whole call is rejected. */
function parseOperationIdList(raw: string | null): string[] | null {
  if (raw === null) {
    return null;
  }
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");
  if (tokens.length === 0) {
    return null;
  }
  for (const token of tokens) {
    if (parseOperationId(token) === null) {
      return null;
    }
  }
  return tokens;
}

/** Absent format defaults to `markdown` (matching the MCP tool schema); a bad value is rejected. */
function parseFormat(value: string | null): ReportFormat | null {
  if (value === null) {
    return "markdown";
  }
  return isReportFormat(value) ? value : null;
}

function render(view: EvidencePackReportView, format: ReportFormat): string {
  return format === "html" ? renderHTML(view, undefined) : renderMarkdown(view, undefined);
}

/** Skip note mirrored after `gp_recent_reports`: an unreachable entry is named, not hidden. */
function makeSkipNote(skipped: readonly string[], format: ReportFormat): string {
  if (skipped.length === 0) {
    return "";
  }
  const label = skipped.length === 1 ? "entry" : "entries";
  return format === "html"
    ? `<p class="gp-skipped">skipped ${skipped.length} unreachable ${label}: ${escapeHTML(skipped.join(", "))}</p>`
    : `> skipped ${skipped.length} unreachable ${label}: ${skipped.join(", ")}`;
}

/* ------------------------------------------------------------------ *
 * Response envelopes and the body reader (all JSON, capped).
 * ------------------------------------------------------------------ */

function ok(res: ServerResponse, result: unknown): void {
  writeJson(res, 200, { ok: true, result });
}

function fail(res: ServerResponse, status: number, code: string, message: string, remedy: string): void {
  writeJson(res, status, { ok: false, error: { code, message, remedy } });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function NotFound(res: ServerResponse, pathname: string): void {
  fail(res, 404, HTTP_NOT_FOUND,
    `no route for ${pathname}`,
    "GET /v1/hello, GET /v1/evidence/:operationId, GET /v1/evidence?ids=a,b&format=html, POST /v1/tools/:name");
}

/** Map an engine/daemon error to an honest HTTP error with the daemon's remedy. */
async function failEngine(res: ServerResponse, error: unknown): Promise<void> {
  if (error instanceof EngineCallError) {
    const status = error.code === GP_E_NO_EVIDENCE ? 404 : 502;
    fail(res, status, error.code, error.message, error.remedy);
    return;
  }
  fail(res, 500, GP_E_INTERNAL,
    `engine transport error: ${String(error)}`,
    "ensure the glasspane daemon is running, then retry");
}

class HTTPPayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "HTTPPayloadTooLargeError";
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new HTTPPayloadTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error) => reject(error));
  });
}