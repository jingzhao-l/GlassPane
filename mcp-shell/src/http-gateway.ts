import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";

import {
  EngineCallError,
  isReplayUnsafeMethod,
  lateReplyRoute,
  unixSocketEngineClient,
} from "./engine-client.js";
import {
  GP_E_BAD_PARAMS,
  GP_E_ENGINE_TIMEOUT,
  GP_E_ENGINE_UNREACHABLE,
  GP_E_INTERNAL,
  GP_E_NO_EVIDENCE,
  GP_E_NO_USER_RECORD,
  GP_E_NOT_FOUND,
  GP_E_PAYLOAD_TOO_LARGE,
  GP_E_PROJECT_LIMIT,
  GP_E_UNKNOWN,
} from "./errors.js";
import { escapeHTML, renderHTML, renderMarkdown } from "./evidence-report.js";
import type { EvidencePackReportView } from "./evidence-report.js";
import {
  oversizedReplyAdvice,
  packForReport,
  parseEvidenceFrame,
  TOOL_BY_NAME,
  TOOL_SPECS,
  type ToolSpec,
} from "./tools.js";

/**
 * HTTP/REST transport for non-MCP clients (curl / scripts) to reach the GlassPane
 * verification engine without speaking MCP-on-stdio. Listens on 127.0.0.1 only
 * (never a wildcard) — and that promise is *enforced*, not aspirational:
 * `createHttpGateway` refuses any host that is not loopback, because this module
 * is a published export (`./http-gateway`) and one bearer token with no TLS is
 * everything standing between a network peer and the user's screen. It reuses the
 * existing `unixSocketEngineClient` line transport to bridge into the daemon
 * socket, and adds no third-party dependency. No engine request is answered later
 * than `CALLER_VISIBLE_CEILING_MS` (engine-client.ts) after it was sent — the CLI
 * prints that number, so a caller can set its own client timeout against it.
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

/**
 * The shortest bearer token this gateway accepts, in code points, and the fewest
 * distinct code points it must draw from.
 *
 * A token is the *only* credential here: no TLS, no per-user identity, and the
 * surface it guards performs clicks and replays on the user's screen. Checking it
 * merely for non-emptiness left `GLASSPANE_HTTP_TOKEN=a` standing in for the whole
 * act surface. A short one is guessable by the one class of peer a loopback bind
 * does not close out — another process on this machine — which can send candidates
 * at loopback speed; the digest + `timingSafeEqual` comparison keeps a *prefix*
 * from leaking out of the timing, and cannot make a 7-character token unguessable.
 * The distinct-character arm exists because a length floor alone is satisfied by
 * `a` repeated 32 times, which carries no more guess cost than `a`.
 *
 * Stated here, in the CLI's usage text, and in both refusals, each of which names
 * the number it applied, so an operator never has to guess why startup stopped.
 */
export const MIN_TOKEN_CHARS = 32;
export const MIN_TOKEN_DISTINCT_CHARS = 8;

/**
 * Whether re-issuing this engine method would perform a change the daemon may
 * already have carried out. Asked of the transport, which owns that verdict for
 * the caller-visible deadline too — an earlier revision of this file kept a third
 * copy of the list (alongside `engine-client.ts` and `tools.ts`), and a fourth
 * method added on one side only would have re-armed the "retry the click" advice
 * on another. `test/http-gateway.test.mjs` still compares the advice this
 * produces against the verdict for every forwardable tool, in both directions.
 */

/**
 * Log ceiling for one late reply body, and the marker this file writes when a
 * body is cut at it.
 *
 * BLOCKED-ON-lane-B: `engine-client.ts` has exactly this helper (`truncate`, over
 * `LOG_BODY_CHARS`) but does not export it, and its late-reply sink is handed the
 * *raw* `frame.result` — so the HTTP side had to cap it again here. Export it and
 * this copy is deleted. Drift risk: the two caps can disagree, which is why
 * `test/http-gateway.test.mjs` hands the sink a body over this cap and requires
 * both the marker and its numbers, so a silent re-widening here goes red.
 */
const LATE_REPLY_BODY_CHARS = 64 * 1024;

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
  /**
   * Sinks for what this gateway cannot answer with: a fact attached to no
   * request (an id-less frame, a handshake that failed) and the body of a reply
   * that landed after its caller was already answered. Both are the daemon's
   * real behaviour, and with no sink they left no trace at all — while the
   * remedy this gateway hands out tells the caller to go read stderr
   * (R8-高3). Optional so a fake may omit it; the gateway refuses to *claim* a
   * log line it did not register for.
   */
  onEngineNote?(handler: (note: string) => void): void;
  onLateReply?(handler: (reply: { method: string; result: unknown }) => void): void;
}

export interface HttpGatewayOptions {
  /** Daemon socket path handed to the engine client (the default connector). */
  socketPath: string;
  /**
   * Bearer token from `GLASSPANE_HTTP_TOKEN`; never generated, never defaulted,
   * and never accepted below {@link MIN_TOKEN_CHARS} code points drawn from
   * {@link MIN_TOKEN_DISTINCT_CHARS} distinct ones.
   */
  token: string;
  port?: number;
  /**
   * Bind address. Only a loopback address is accepted — `0.0.0.0`, `::` and any
   * routable address or hostname are refused with an error, not silently
   * downgraded to the default (R9-高: this module is a published export, so a
   * caller that gets to choose a host must not get to choose a wildcard one).
   */
  host?: string;
  /** Injectable client factory so tests run without a real socket. */
  connectController?: (socketPath: string) => EngineClientLike;
  /**
   * Where to write the facts that have no HTTP response: engine notes and late
   * replies. Defaults to stderr with this process's own prefix, because the
   * remedy text this gateway hands out tells a caller to read *this gateway's
   * stderr* — a promise that has to have a writer behind it (R8-高3).
   */
  report?: (note: string) => void;
}

export interface HttpGateway {
  /**
   * The HTTP server, already handed `listen(port, host)` by this factory. A bind
   * that fails (a port already held by another process) is emitted as an `error`
   * event on it, *not* thrown, and a gateway that is not listening is not
   * serving: `http-gateway-cli.ts` treats that event as fatal, and every other
   * consumer of this published export has to as well.
   */
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

/**
 * Every tool route this surface answers, spelled the way a caller has to send it.
 *
 * Derived from `FORWARDABLE_TOOLS` rather than written out, because the errors
 * below name routes to a curl caller and a hand-kept list is how a remedy ends up
 * sending an agent to a route that 404s (this file's whole doctrine on advice
 * text). `POST /v1/tools/recent_reports` and the project tools are absent from it
 * on purpose: they have an `execute` of their own and are not daemon methods, so
 * naming them here would be naming a 404.
 */
const TOOL_ROUTES_TEXT = [...FORWARDABLE_TOOLS.keys()]
  .map((method) => `POST /v1/tools/${method}`)
  .join(", ");

export function createHttpGateway(options: HttpGatewayOptions): HttpGateway {
  // Both guards run before anything is opened: no engine client, no listening
  // socket, nothing left behind for a caller that got refused.
  assertTokenPolicy(options.token);
  const port = options.port ?? DEFAULT_GATEWAY_PORT;
  const host = assertLoopbackHost(options.host ?? DEFAULT_GATEWAY_HOST);
  const report = options.report ?? ((note: string) => {
    try {
      process.stderr.write(`[glasspane-http] ${note}
`);
    } catch {
      // A stderr that cannot take a line leaves nowhere to report this; the
      // gateway must not die over its own log (same last resort as index.ts).
    }
  });
  const client: EngineClientLike = options.connectController !== undefined
    ? options.connectController(options.socketPath)
    : unixSocketEngineClient(options.socketPath, { surface: "http" });
  // The gateway is a *bridge*, so everything the engine client learns that no
  // HTTP response carries has to be written down here: the remedy text handed to
  // a curl caller says "read this gateway's stderr", and that promise is only
  // true because of these two registrations.
  client.onEngineNote?.((note) => report(`engine: ${note}`));
  client.onLateReply?.(({ method, result }) => {
    // The transport hands the sink the raw reply body, and on this surface that
    // body is UI-tree content (titles, values, sometimes a document's text). The
    // MCP path caps what it writes; an uncapped `JSON.stringify` here could put
    // tens of megabytes of it on stderr per late reply.
    report(`late engine reply to '${method}' (reply body below, raw engine content and not redacted): ${truncateLateReplyBody(stringifyReply(result))}`);
  });
  const expectedToken = Buffer.from(options.token, "utf8");

  const server = http.createServer((req, res) => {
    handleHttp(req, res, client, expectedToken).catch((error) => {
      // Never let one bad request kill the server; report an honest envelope. The
      // advice is the same fault advice every other route gets, because a blind
      // "…and retry" here is an instruction to re-perform an `act` that may have
      // already gone out on the request this handler was still holding.
      fail(res, 500, GP_E_INTERNAL, `internal gateway error: ${String(error)}`, gatewayFaultAdvice());
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

/* ------------------------------------------------------------------ *
 * Startup guards (security red lines: the bind and the credential are
 * both refused outright rather than downgraded, because everything after
 * them is the user's screen).
 * ------------------------------------------------------------------ */

/** The loopback *names* accepted: `localhost` and the two alias spellings a macOS
 * resolver answers. Any other name is refused, because naming the bind means
 * letting `/etc/hosts` and DNS decide where it lands — and a caller that meant
 * loopback can write the address. */
const LOOPBACK_HOST_NAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

/** True for the loopback forms only: 127.0.0.0/8 (and its v4-mapped v6 spelling),
 * `::1`, and the `localhost` names. `0.0.0.0`, `::`, the empty string and every
 * routable address or name are false. */
export function isLoopbackHost(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") {
    return false;
  }
  const host = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (LOOPBACK_HOST_NAMES.has(host) || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const mapped = /^::ffff:(.+)$/.exec(host);
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped?.[1] ?? host);
  return octets !== null
    && octets[1] === "127"
    && octets.slice(1, 5).every((octet) => Number(octet) <= 255);
}

/**
 * Refuse any bind that is not loopback. The module doc promises 127.0.0.1 only;
 * this is the sentence that makes it true for `options.host` too, so a caller of
 * the published `./http-gateway` export cannot put the act/restore surface on a
 * wildcard with one bearer token and no TLS in front of it.
 */
export function assertLoopbackHost(host: string): string {
  if (isLoopbackHost(host)) {
    return host.trim();
  }
  throw new Error(
    `createHttpGateway refuses host '${host}': only a loopback address is accepted `
    + `(127.0.0.0/8, ::1 or "localhost"), because this gateway serves the act/restore surface `
    + `with one bearer token and no TLS — bound to a wildcard or a routable address, every peer `
    + `that can reach this port can press controls on this machine's screen`,
  );
}

/** Refuse an empty token, and one too short or too uniform to be a credential. */
export function assertTokenPolicy(token: string): void {
  if (token === "") {
    throw new Error(
      `createHttpGateway requires a non-empty token (read ${GLASSPANE_HTTP_TOKEN_ENV}); refusing to start with an empty or defaulted token`,
    );
  }
  const chars = [...token];
  const distinct = new Set(chars).size;
  if (chars.length < MIN_TOKEN_CHARS || distinct < MIN_TOKEN_DISTINCT_CHARS) {
    throw new Error(
      `createHttpGateway refuses this ${GLASSPANE_HTTP_TOKEN_ENV}: ${chars.length} character(s) `
      + `drawn from ${distinct} distinct one(s), and the gateway needs at least ${MIN_TOKEN_CHARS} `
      + `characters drawn from at least ${MIN_TOKEN_DISTINCT_CHARS} distinct ones — it is the only `
      + `credential guarding the act/restore surface, with no TLS and no per-user identity behind `
      + `it. Generate one with "openssl rand -hex 16" and export it as ${GLASSPANE_HTTP_TOKEN_ENV}.`,
    );
  }
}

/** Cap one late reply body, and say how much of it did not get written. */
function truncateLateReplyBody(text: string): string {
  return text.length <= LATE_REPLY_BODY_CHARS
    ? text
    : `${text.slice(0, LATE_REPLY_BODY_CHARS)}… [reply body truncated: ${text.length - LATE_REPLY_BODY_CHARS} of ${text.length} chars not written]`;
}

/** The transport's values come from JSON.parse, but an injected client can hand
 * this sink anything, and a sink must not be the thing that loses the note. */
function stringifyReply(result: unknown): string {
  try {
    const text = JSON.stringify(result);
    return text === undefined ? String(result) : text;
  } catch {
    return String(result);
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
  // Two different failures live here and they used to be answered with one
  // sentence: "the daemon did not answer" (a transport code, whose remedy names a
  // restart) and "the daemon answered with something that is not a pack" (it
  // demonstrably did answer, so nothing is wrong with its lifecycle).
  let raw: unknown;
  try {
    raw = await client.call("last_evidence", { operationId });
  } catch (error) {
    await failEngine(res, error, TOOL_BY_NAME.get("gp_last_evidence"), { operationId });
    return;
  }
  try {
    const { pack, measuredSchemaVersion } = parseEvidenceFrame(raw);
    const view = packForReport(pack, measuredSchemaVersion);
    ok(res, { operationId, format, report: render(view, format) });
  } catch (error) {
    failEvidenceFrameShape(res, error, operationId);
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
    let raw: unknown;
    try {
      raw = await client.call("last_evidence", { operationId });
    } catch (error) {
      if (error instanceof EngineCallError && error.code === GP_E_NO_EVIDENCE) {
        skipped.push(operationId);
        continue;
      }
      // The too-large advice is the tool contract's business, so the aggregate
      // route asks the same helper the single-fetch route uses.
      await failEngine(res, error, TOOL_BY_NAME.get("gp_last_evidence"), { operationId });
      return;
    }
    try {
      const { pack, measuredSchemaVersion } = parseEvidenceFrame(raw);
      blocks.push(render(packForReport(pack, measuredSchemaVersion), format));
      renderedIds.push(operationId);
    } catch (error) {
      failEvidenceFrameShape(res, error, operationId);
      return;
    }
  }

  if (blocks.length === 0) {
    fail(res, 404, GP_E_NO_EVIDENCE,
      "none of the requested operations have evidence in the daemon history",
      "the engine may have restarted, or those operationIds never produced evidence; each id named here was fetched "
      + "and missed, and this gateway keeps no operation trail of its own, so it cannot list what ran. Producing a "
      + "fresh pack means performing another action, which a read like this one does not do for you: see what the "
      + "attached app is doing now with POST /v1/tools/observe, POST /v1/tools/assert_element or "
      + "POST /v1/tools/probe_status, re-fetch one id with GET /v1/evidence/<operationId>, and the routes this "
      + `surface answers are ${TOOL_ROUTES_TEXT}`);
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
      `this surface forwards the daemon methods an MCP-less caller can use, and those are exactly: ${TOOL_ROUTES_TEXT}`);
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
      } catch (error) {
        failEvidenceFrameShape(res, error, readOperationId(checked.value));
        return;
      }
    }
    ok(res, result);
  } catch (error) {
    await failEngine(res, error, spec, checked.value);
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
    "GET /v1/hello, GET /v1/evidence/:operationId, GET /v1/evidence?ids=a,b&format=html, "
    + `POST /v1/recipes/validate, POST /v1/tools/:name — the tool names that resolve here are ${TOOL_ROUTES_TEXT}`);
}

/**
 * HTTP status for one engine/daemon error code, by family.
 *
 * The old rule was "404 for GP_E_NO_EVIDENCE, 502 for everything else", which
 * told a curl caller that its *gateway* had failed for answers the daemon had
 * produced about the caller's own request: `GP_E_NOT_FOUND` (nothing by that id)
 * and the daemon's busy/refused family are 4xx facts, and a 5xx in particular
 * reads as "the request never landed, sending it again is the fix" — on `act`
 * that reading is a second click on the user's screen. Only what this shell's own
 * transport raises is a 5xx, and even those now say which part failed:
 * nothing listening (503), no answer in time (504), a reply that could not be
 * delivered (502).
 *
 * A code this file does not name falls to the `default` arm, and that arm is
 * chosen rather than a 5xx on purpose: every code the daemon authors lives there
 * (its enum is `GPErrorCode` in `engine/Sources/GlassPaneEngine/ProtocolErrors.swift`)
 * and a daemon-authored code is a request it received, parsed and answered. The
 * shell's own codes are each named above, and `test/http-gateway.test.mjs` checks
 * both directions against that enum: no daemon code may be answered as a 5xx
 * except the two that describe an undeliverable reply, and no code the daemon does
 * not declare may be answered as a 4xx — a code this shell raises for itself is
 * never the caller's bad request.
 */
function httpStatusForEngineCode(code: string): number {
  switch (code) {
    case GP_E_NO_EVIDENCE:
    case GP_E_NOT_FOUND:
      return 404;
    case GP_E_BAD_PARAMS:
      return 400;
    case GP_E_PROJECT_LIMIT:
      return 409;
    case GP_E_ENGINE_UNREACHABLE:
      return 503;
    case GP_E_ENGINE_TIMEOUT:
      return 504;
    case GP_E_PAYLOAD_TOO_LARGE:
      return 502;
    case GP_E_INTERNAL:
      return 500;
    case GP_E_NO_USER_RECORD:
      return 500;
    case GP_E_UNKNOWN:
      return 502;
    default:
      return 422;
  }
}

/** Map an engine/daemon error to an honest HTTP error with the daemon's remedy. */
async function failEngine(
  res: ServerResponse,
  error: unknown,
  spec?: ToolSpec,
  params?: Record<string, unknown>,
): Promise<void> {
  if (error instanceof EngineCallError) {
    fail(res, httpStatusForEngineCode(error.code), error.code, error.message, engineRemedy(error, spec, params));
    return;
  }
  // Not an engine error frame, so this is *not* a transport verdict either: every
  // transport failure the client raises arrives as an `EngineCallError` carrying
  // GP_E_ENGINE_UNREACHABLE. What lands here is a request this gateway could not
  // complete, and the old text called it "engine transport error … ensure the
  // daemon is running, then retry" — an unearned diagnosis plus a restart order
  // for a daemon that had, in every reachable case, just answered.
  fail(res, 500, GP_E_INTERNAL,
    `this gateway could not complete the request: ${String(error)}`,
    gatewayFaultAdvice(spec));
}

/**
 * The advice that goes with an engine error code.
 *
 * The transport states the fact; the tool contract owns the advice — same split
 * the MCP path uses, so a curl caller whose reply overflowed gets the knobs its
 * own request has. What it must not get is a narrowing instruction dressed up as
 * recovery for a request that already took effect: see
 * {@link httpReplayUnsafePayloadAdvice}.
 *
 * For every other code this returns the remedy its author wrote (the daemon's own
 * table, or `engine-client.ts`'s timeout text) unchanged. That includes the codes
 * whose remedy genuinely does name a restart, because the daemon is the one that
 * measured the condition — the gateway adds no restart order of its own, and the
 * only one it could not have earned is the fall-through above.
 *
 * BLOCKED-ON-lane-B: the timeout text this passes through is written for both
 * surfaces and still says "so gp_probe_status goes out at once" on the `http`
 * branch (`slowEngineRemedy`'s poll clause) — a tool name a curl caller has to
 * translate into `POST /v1/tools/probe_status` on its own. It belongs to
 * `engine-client.ts`; rewriting it here would be a second copy of that advice, so
 * the pass-through stays and the naming has to be fixed at the source.
 */
function engineRemedy(
  error: EngineCallError,
  spec?: ToolSpec,
  params?: Record<string, unknown>,
): string {
  if (spec !== undefined && error.code === GP_E_PAYLOAD_TOO_LARGE) {
    const asked = params ?? {};
    return isReplayUnsafeMethod(spec.engineMethod)
      ? httpReplayUnsafePayloadAdvice(spec, asked)
      : oversizedReplyAdvice(spec, asked);
  }
  return error.remedy;
}

/**
 * A reply that overflowed, for a request whose re-issue performs a change again.
 *
 * `tools.ts` applies exactly this split on the MCP path; this is the same decision
 * worded for a caller that is holding curl rather than a tool list, because
 * `replayUnsafePayloadAdvice()` routes that caller to `gp_recent_reports` — a tool
 * this surface does not expose (`POST /v1/tools/recent_reports` is a 404) and the
 * HTTP gateway has no operation trail to list from anyway. The narrowing clause is
 * still delegated to lane B's exported `oversizedReplyAdvice`, so the knob and
 * floor facts stay in one file; the set this branches on is
 * {@link REPLAY_UNSAFE_ENGINE_METHODS}, whose BLOCKED-ON note explains the copy.
 */
function httpReplayUnsafePayloadAdvice(spec: ToolSpec, params: Record<string, unknown>): string {
  return "do not re-send this request on this answer. "
    + `'${spec.engineMethod}' reached the daemon and was answered, and only its reply was dropped for exceeding one `
    + "frame, so sending it again performs the change a second time rather than recovering the first answer (an act "
    + "presses the same control again, a restore replays its steps again, an attach re-points the daemon at another "
    + "app). Read what happened instead of acting again: GET /v1/evidence/<operationId> and "
    + "POST /v1/tools/last_evidence {operationId} return the pack of an operation whose id you already hold, and "
    + "POST /v1/tools/observe, POST /v1/tools/assert_element and POST /v1/tools/probe_status read the attached app as "
    + "it is now without changing it — this gateway keeps no operation trail of its own, so it cannot list which "
    + "operations ran. If that reading shows this request never took effect, send it again narrowed to what its own "
    + `schema advertises: ${oversizedReplyAdvice(spec, params)}`;
}

/** What to tell a caller when this gateway itself could not complete the request. */
function gatewayFaultAdvice(spec?: ToolSpec): string {
  const log = "this gateway writes what the engine said about this connection to its own stderr, so read that before concluding anything about the daemon";
  if (spec !== undefined && isReplayUnsafeMethod(spec.engineMethod)) {
    return "do not re-send this request on this answer: this gateway could not read the reply, so it cannot say "
      + `whether '${spec.engineMethod}' reached the daemon, and if it did a re-send performs the change a second `
      + "time. Nothing here indicts the daemon's lifecycle, so do not restart it on this answer. Read what the "
      + "attached app is doing now without performing anything: POST /v1/tools/observe, "
      + "POST /v1/tools/assert_element or POST /v1/tools/probe_status. "
      + `${lateReplyRoute("http")}; ${log}.`;
  }
  return `re-send this request only if it is one that changes nothing — a read; the routes this surface answers are ${TOOL_ROUTES_TEXT}. ${log}.`;
}

/**
 * The daemon answered, but not with something this gateway can render or forward.
 *
 * This is the case that used to be reported as a transport failure ("engine
 * transport error … ensure the daemon is running, then retry") or, on the tool
 * route, as an order to go "reenact the operation" — a second act, performed by a
 * caller who was only trying to read a pack. Neither is what happened: an answer
 * arrived, and its bytes do not match the contract.
 */
function failEvidenceFrameShape(res: ServerResponse, error: unknown, operationId?: string): void {
  fail(res, 502, GP_E_INTERNAL,
    `the daemon returned a last_evidence frame that does not match the engine contract (no parseable evidencePack${operationId === undefined ? "" : ` for ${operationId}`}: ${String(error)})`,
    "the daemon answered this request, so the transport is up and restarting it changes nothing here; this gateway "
    + "validates a pack before rendering or forwarding it, so GET /v1/evidence/<operationId> and "
    + "POST /v1/tools/last_evidence {operationId} will both refuse this frame for the same reason. Read what the "
    + "attached app is doing now without performing anything: POST /v1/tools/observe, POST /v1/tools/assert_element "
    + "or POST /v1/tools/probe_status. Producing a fresh pack for this operation means acting again, which is a "
    + "decision this read cannot make for you.");
}

/** The operationId a validated `last_evidence` request carried, if it named one. */
function readOperationId(params: Record<string, unknown>): string | undefined {
  const value = params.operationId;
  return typeof value === "string" ? value : undefined;
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