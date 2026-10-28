import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { URL } from "node:url";

import {
  CALLER_VISIBLE_CEILING_MS,
  EngineCallError,
  isReplayUnsafeMethod,
  lateReplyBodyNote,
  lateReplyRoute,
  unixSocketEngineClient,
} from "./engine-client.js";
import {
  GP_E_BAD_PARAMS,
  GP_E_ENGINE_BACKLOG,
  GP_E_ENGINE_TIMEOUT,
  GP_E_ENGINE_UNREACHABLE,
  GP_E_INTERNAL,
  GP_E_NO_EVIDENCE,
  GP_E_NO_USER_RECORD,
  GP_E_NOT_FOUND,
  GP_E_PAYLOAD_TOO_LARGE,
  GP_E_PROJECT_LIMIT,
  GP_E_REGISTRY_DRIFT,
  GP_E_STATE_ROOT_REFUSED,
  GP_E_UNKNOWN,
} from "./errors.js";
import { dimensionAttributionLine, engineBody, validateDimension } from "./dimension.js";
import { escapeHTML, renderHTML, renderMarkdown } from "./evidence-report.js";
import type { EvidencePackReportView } from "./evidence-report.js";
import {
  DAEMON_FORWARDED_METHODS,
  RING_WRITE_REASON,
  narrowingKnobPhrase,
  oversizedReplyAdvice,
  packForReport,
  parseEvidenceFrame,
  payloadOverflowArm,
  TOOL_BY_NAME,
  TOOL_SPECS,
  type ToolSpec,
} from "./tools.js";
import { MAX_FRAME_BYTES } from "./io.js";
import { attributeCapability, providerAttributionLine } from "./providers.js";

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

/** Ceiling on a forwarded request body, so no client can exhaust gateway memory. */
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

/**
 * Ceiling on one GET /v1/evidence?ids= aggregation (aligned with the MCP
 * recent_reports limit=20). Without it a single request could fan into the
 * daemon as thousands of serial last_evidence calls (request amplification /
 * DoS); over the ceiling the whole call is rejected with 400.
 */
const MAX_EVIDENCE_IDS = 20;

/**
 * One wall-clock budget for the **whole** `ids=` fan-out, spent across the
 * `last_evidence` round trips instead of granted to each of them.
 *
 * The bound is the one this shell already promises any single caller
 * (`CALLER_VISIBLE_CEILING_MS`, imported rather than restated), because a
 * request that holds the daemon's one connection for 20 x that ceiling is
 * answered by no client: it gives up holding nothing in hand, and the one thing
 * an agent with no answer does is re-perform the action the report existed to
 * check on. `tools.ts` made exactly this decision for `gp_recent_reports`
 * (`RECENT_REPORTS_BUDGET_MS`, spent through its `CallBudget`); that class is not
 * exported, so the equivalence — same bound, same units, one timer for the
 * aggregate — is pinned by `test/http-gateway.test.mjs` against both files rather
 * than by a second number here. An id the budget could not reach is named in the
 * response as not fetched, never dropped from it.
 */
export const EVIDENCE_FANOUT_BUDGET_MS = CALLER_VISIBLE_CEILING_MS;

/**
 * The operationId grammar, read out of the tool contract that advertises it.
 *
 * `tools.ts` owns this rule twice over — as the zod rule `gp_last_evidence`
 * validates with, and as the `pattern` its `tools/list` schema publishes — and a
 * third spelling here is what let the two drift (the copy this replaces was
 * already carrying a stale comment claiming the shared form). Deriving it means a
 * change on the authority side is this file's behaviour too, with nothing left to
 * re-sync; `test/http-gateway.test.mjs` refuses both a re-spelled literal here and
 * a contract that stops publishing the pattern.
 */
const OPERATION_ID_PATTERN = operationIdPatternFromToolContract();

function operationIdPatternFromToolContract(): RegExp {
  const spec = TOOL_BY_NAME.get("gp_last_evidence");
  const properties = (spec?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const pattern = (properties?.operationId as { pattern?: string } | undefined)?.pattern;
  if (typeof pattern !== "string" || pattern === "") {
    // Refusing to start is the honest answer: an unvalidated id reaching the
    // socket would be this gateway spending a round trip on a shape its own tool
    // contract rejects, and a silently loosened rule is worse than no rule.
    throw new Error("http-gateway: gp_last_evidence's published operationId pattern is missing, so the operationId grammar has no authority to read it from");
  }
  return new RegExp(pattern);
}

/** Ids in the shape the tool contract advertises, for a caller-facing sentence. */
const OPERATION_ID_FORM = OPERATION_ID_PATTERN.source.replace(/^\^/, "").replace(/\$$/, "");

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
/**
 * A request body that never completed (stalled mid-body, or hung up before
 * `end`). Separate from {@link HTTP_BAD_REQUEST}, because the two answers imply
 * different caller actions: one is "your JSON is wrong", this one is "you never
 * finished sending it". Finding B1, 2026-10-27 — before this existed a stalled
 * body had no answer at all, only a destroyed socket.
 */
const HTTP_BODY_UNREAD = "GP_HTTP_BODY_UNREAD";

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
  /**
   * The version the daemon named in its own `hello` on this connection, or null when no
   * handshake has reported one. Optional so a fake may omit it — the seam then attributes
   * what it can measure and says the version is unmeasured, which is exactly what the
   * stdio doorway does for the same client.
   */
  readonly reportedEngineVersion?: string | null;
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
  /**
   * Ceiling on how long one request body may take to arrive (finding B1,
   * 2026-10-27). `readBody` had a byte cap and no *time* cap, and the server set
   * no `requestTimeout`, so a caller that sent headers and then stalled the body
   * held a handler open until Node's own default fired and destroyed the socket —
   * which answers the caller with an unstructured `ECONNRESET`, the exact shape
   * this file already refuses for oversized bodies. Tests may shorten it; it is
   * never allowed to be absent.
   */
  bodyReadTimeoutMs?: number;
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
 *
 * "Identical" covers the provenance too, not just the arguments: {@link
 * handleToolForward} runs every route through the same `attributeCapability` seam
 * `tools.ts` runs the stdio doorway through, so a claimed capability is answered with
 * the same attribution line on both doors and refused before the frame leaves on both
 * doors when that seam cannot name a producer. `test/http-gateway.test.mjs` drives one
 * call through each doorway and compares them.
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

/**
 * The gateway's own answer to "which of the capabilities this `hello` advertises can
 * I actually POST here?", added to {@link handleHello}'s response as one derived field.
 *
 * The daemon's `capabilities` is a measurement of the *daemon*, relayed verbatim — it
 * includes `capture_view`, which this surface deliberately does not route (SECURITY.md
 * §2.3: `gp_capture_view` and the orchestrated tools are not on this surface; the
 * PNG-bearing tool belongs to the stdio server, and `POST /v1/tools/capture_view` is
 * pinned as a 404). So a client that discovers through `GET /v1/hello` was told one
 * thing at this door and handed another one request later: no route, and no field
 * saying which routes exist. Rewriting the daemon's list to hide the difference would
 * falsify the measurement, so the list stays byte-for-byte and the reconciliation is
 * added next to it, computed from {@link FORWARDABLE_TOOLS} rather than written out —
 * a hand-kept copy is the drift this file's whole advice-text doctrine refuses.
 *
 * The split into `mcpOnly` and `exposedNowhere` is what keeps the sentence honest: a
 * capability this surface does not route is only worth calling MCP-only when the MCP
 * surface really does forward it, and anything else is drift between two builds that
 * must be named rather than smoothed over.
 */
function describeCapabilityRouting(result: unknown): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return result;
  }
  const hello = result as Record<string, unknown>;
  const routed = [...FORWARDABLE_TOOLS.keys()];
  const advertised = Array.isArray(hello.capabilities)
    ? hello.capabilities.filter((item): item is string => typeof item === "string")
    : null;
  if (advertised === null) {
    return {
      ...hello,
      capabilityRouting: {
        routed,
        advertised: null,
        note: `this daemon's hello named no capability list, so nothing here can reconcile it; the methods this surface routes are the ones in \`routed\`, reachable as POST /v1/tools/<name>`,
      },
    };
  }
  const notRouted = advertised.filter((name) => !routed.includes(name));
  return {
    ...hello,
    capabilityRouting: {
      routed,
      advertised,
      mcpOnly: notRouted.filter((name) => DAEMON_FORWARDED_METHODS.includes(name)),
      exposedNowhere: notRouted.filter((name) => !DAEMON_FORWARDED_METHODS.includes(name)),
      note: "`capabilities` is the daemon's own measurement and is relayed unchanged; `routed` is what THIS HTTP surface answers at POST /v1/tools/<name>. An entry in `mcpOnly` is a daemon capability that exists but is reachable only through the MCP stdio server's tool, never as an HTTP route — `exposedNowhere` would be a capability reachable on neither surface, which is a build disagreement to report rather than a routing choice",
    },
  };
}

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
  // 这一行把网关自己的 sink 交给 `wireCause`：否则那些自由函数形态的失败出口要么把内部
  // 异常原文写上线（`Dispatcher.swift` 那条理由是它的，也是这一面的），要么一句明细都不留。
  setGatewayReportSink(report);
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
    // body is UI-tree content (titles, values, sometimes a document's text). It
    // must NOT be written here: this gateway's stderr is captured by whoever
    // supervises the process, in a file whose mode this product never sets, so
    // copying the body exported screen content into a log the product does not
    // own (review 2026-10-09 finding 3, and F3 on 2026-10-27). The note keeps the
    // diagnostic facts — the method, the byte length, a short deterministic digest
    // — and says where the real bytes live (the daemon's evidence archive, read
    // back with gp_last_evidence / gp_export_evidence). That sentence is authored
    // once in `engine-client.ts` (`lateReplyBodyNote`, the file that owns the log
    // budget) and the stdio doorway prints the same one, so the two surfaces
    // cannot drift apart.
    report(`late engine reply to '${method}': the engine did answer, ${lateReplyBodyNote(stringifyReply(result), (result as { operationId?: unknown } | null)?.operationId)}`);
  });
  const expectedToken = Buffer.from(options.token, "utf8");
  const bodyReadTimeoutMs = options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS;

  const server = http.createServer((req, res) => {
    handleHttp(req, res, client, expectedToken, bodyReadTimeoutMs).catch((error) => {
      // Never let one bad request kill the server; report an honest envelope. The
      // advice is the same fault advice every other route gets, because a blind
      // "…and retry" here is an instruction to re-perform an `act` that may have
      // already gone out on the request this handler was still holding.
      //
      // The error's OWN TEXT stays off the wire (2026-10-28, the shape the daemon
      // already refuses at `engine/Sources/GlassPaneEngine/Dispatcher.swift:48-60`):
      // a thrown description carries absolute paths — the state root, the evidence
      // archive, a caller's own document — and this answer goes to any same-user
      // process that can reach the loopback port, which is not a privileged reader.
      // What helps a reader is the TYPE, so the frame names the type and nothing
      // else; the detail goes to `report`, the operator's stderr side, which is the
      // one place `gatewayFaultAdvice()` promises the full account lives.
      report(`internal gateway error for ${req.method} ${req.url}: ${String(error)}`);
      fail(res, 500, GP_E_INTERNAL,
        `internal gateway error of type ${errorTypeName(error)}; its own description names files this frame does not publish`,
        gatewayFaultAdvice());
    });
  });
  server.listen(port, host);

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      client.close?.();
      // Node only fires server.close's callback once every connection is gone.
      // What must never be broken is a connection with a request in flight, so
      // idle keep-alive sockets are reaped until the close actually lands —
      // including the ones that only *become* idle after close was asked for.
      const reaper = setInterval(() => closeIdleKeepAliveConnections(server), IDLE_REAP_MS);
      reaper.unref();
      // 到这条上限为止，调用方早就拿到了那句 `GP_E_ENGINE_TIMEOUT` + "别重发"，这条连接
      // 上不会再有谁读的回答；把进程一直挂住对谁都没好处。但要说清楚拆的是什么——
      // 一句假装干净的关闭，比一句承认放弃了在飞的活更坏。
      const deadline = setTimeout(() => {
        report(
          `shutdown is giving up on a connection that never went idle after ${CALLER_VISIBLE_CEILING_MS}ms;`
          + " any engine work it carried may still be running — do not re-issue it",
        );
        server.closeAllConnections?.();
      }, CALLER_VISIBLE_CEILING_MS);
      deadline.unref();
      server.close((error) => {
        clearInterval(reaper);
        clearTimeout(deadline);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
      closeIdleKeepAliveConnections(server);
    });

  return { server, close };
}

/** How often a closing gateway re-checks for connections that have gone idle. */
const IDLE_REAP_MS = 200;

function closeIdleKeepAliveConnections(server: Server): void {
  // Idle-only, deliberately. `closeAllConnections()` — what this called before —
  // also destroys a socket with a request in flight: measured against the
  // shipped bundle, a `POST /v1/tools/act` whose daemon call had not returned
  // came back as `ECONNRESET` with no frame at all, so the caller never learned
  // the act had happened, never received the "do NOT re-issue `act`" remedy, and
  // the daemon kept performing that act on the user's screen. That is the B-02
  // doctrine this gateway is written to hold, broken by the shutdown path.
  //
  // No older-Node fallback here, on purpose: `closeIdleConnections` and
  // `closeAllConnections` both landed in Node v18.2.0 and this package declares
  // `engines: node >=18`, so a runtime with one and not the other does not
  // exist. A branch that cannot run is not defensive — and if it could run, the
  // only thing it would do is re-import the bug above.
  server.closeIdleConnections?.();
}

/* ------------------------------------------------------------------ *
 * Startup guards (security red lines: the bind and the credential are
 * both refused outright rather than downgraded, because everything after
 * them is the user's screen).
 * ------------------------------------------------------------------ */

/**
 * True for a loopback **address literal** and nothing else: 127.0.0.0/8 (and its
 * v4-mapped v6 spelling) or `::1`.
 *
 * Names are not accepted, including the three this function used to allow
 * (`localhost`, `ip6-localhost`, `ip6-loopback`). A name cannot be honoured
 * without resolving it, and resolving it hands the bind — the one security
 * decision this module makes — to `/etc/hosts` and DNS: exactly the reasoning by
 * which every *other* name is refused here, applied inconsistently. `127.0.0.1`
 * says what it means at the moment of `listen()`, and it is what the refusals
 * offer. A caller that wants to reach this gateway by name still can: the name
 * belongs in the URL it connects to, where resolving it decides only where the
 * request goes.
 *
 * `test/http-gateway.test.mjs` asserts the *class* (any string `net.isIP()` does
 * not read as an address is refused) so re-admitting one name cannot pass by
 * being the one spelling no case sends.
 */
export function isLoopbackHost(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") {
    return false;
  }
  const host = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const mapped = /^::ffff:(.+)$/.exec(host);
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped?.[1] ?? host);
  return octets !== null
    && octets[1] === "127"
    && octets.slice(1, 5).every((octet) => Number(octet) <= 255);
}

/**
 * Refuse any bind that is not a loopback address literal. The module doc promises
 * 127.0.0.1 only; this is the sentence that makes it true for `options.host` too,
 * so a caller of the published `./http-gateway` export cannot put the act/restore
 * surface on a wildcard with one bearer token and no TLS in front of it — nor on
 * whatever a name happens to resolve to on the day.
 */
export function assertLoopbackHost(host: string): string {
  if (isLoopbackHost(host)) {
    return host.trim();
  }
  const trimmed = host.trim();
  // "Is this a name, or an address that simply is not loopback?" — the two get
  // different answers, because only the first is refused for a reason the caller
  // can act on by writing an address. Bracket forms are unwrapped for `isIP`, and
  // a string made of address characters alone is treated as an attempted address
  // (`127.0.0.256` is a bad number, not a name).
  const unwrapped = trimmed.replace(/^\[|\]$/g, "");
  const nameNotAddress = trimmed !== "" && isIP(unwrapped) === 0 && !/^[0-9a-fA-F:.]+$/.test(unwrapped);
  const whereANameGoes = nameNotAddress
    ? ` A name is answered by \`/etc/hosts\` and DNS, so accepting one for the bind hands the choice of `
      + `interface to whoever edits those; send the name where resolution is the client's own business — `
      + `in the URL it curls, e.g. http://localhost:<port>/v1/hello — and pass this gateway an address it `
      + `cannot be talked out of, such as 127.0.0.1 or ::1. `
    : " Pass one of the loopback literals above. ";
  throw new Error(
    `createHttpGateway refuses host '${host}': only a loopback address literal is accepted `
    + `(127.0.0.1 — any address in 127.0.0.0/8 — or ::1, in either the bare or the ::ffff:-mapped `
    + `spelling).${whereANameGoes}`
    + `This gateway serves the act/restore surface with one bearer token and no TLS — bound to a `
    + `wildcard or to a routable address, every peer that can reach this port can press controls on `
    + `this machine's screen, which is what a loopback literal is here to rule out.`,
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

/**
 * The TYPE of a thrown value, as one short noun — never any part of what it carries.
 *
 * This is the whole reason the last-resort catch can say something useful without leaking: `Error`
 * subclasses keep their constructor name (`TypeError`, `EngineCallError`), which points a reader at
 * a class of fault, while the message — the part that names files — is dropped. A rejected value
 * that is not an `Error` at all (a bare string, `null`, an object literal) is answered with its
 * `typeof` rather than `String(error)`, because a thrown string's text IS its content and a thrown
 * object's constructor name is the only part of it that is code rather than data.
 */
function errorTypeName(error: unknown): string {
  if (error instanceof Error) {
    const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && name.length > 0 ? name : "Error";
  }
  if (error === null) return "null";
  if (error === undefined) return "undefined";
  return typeof error;
}

/**
 * The sink the free helpers below use when they must keep an internal throw off the
 * wire yet still hand the bytes to the operator. `createHttpGateway` installs its own
 * `report` here when a gateway starts; before that (and in direct-call tests) the
 * shared stderr fallback answers, which is the same policy the gateway's own default
 * is — authored once, per R10-中6's rule about a body cap living twice.
 */
let gatewayReportSink: (note: string) => void = reportToFallbackStderr;

/** Install the sink. Exported for the gateway factory; a caller that replaces it gets
 *  the last writer, which is what a single-process gateway already is. */
export function setGatewayReportSink(sink: (note: string) => void): void {
  gatewayReportSink = sink;
}

/** The fallback: stderr, and a stderr that will not take the line is itself reported
 *  nowhere — the honest default, because then nothing was written anywhere. */
function reportToFallbackStderr(note: string): void {
  try {
    process.stderr.write(`${note}\n`);
  } catch {
    // Nothing is left to do: the sink is the thing that failed.
  }
}

/**
 * The wire-safe account of an internal throw, and the reason this file has a sink.
 *
 * The daemon refuses the other shape for the same reason (`Dispatcher.swift` withholds
 * an `NSError` description because it carries absolute paths — the state root, the
 * evidence archive, the home directory), and on this surface the throw can also be a
 * parse failure of bytes that came out of a live screen. So the frame gets the *type*
 * and a pointer to where the description went; the description goes to the operator's
 * stderr, which is the one place this product is allowed to write it.
 *
 * Reverse mutation: interpolate `String(error)` back into any wire message here and
 * `daily-20261028-gateway-error-shape.test.mjs`'s path-marker assertions go red.
 */
function wireCause(where: string, error: unknown): string {
  const type = errorTypeName(error);
  gatewayReportSink(
    `${where}: internal ${type} — ${String(error)} (withheld from the HTTP frame: a description `
    + "of an internal failure names files this frame does not publish)",
  );
  return `an internal ${type} failure inside this gateway, at ${where}; its own description is on the gateway's stderr, not in this frame`;
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
  bodyReadTimeoutMs: number = DEFAULT_BODY_READ_TIMEOUT_MS,
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
  await dispatch(req, res, url, segments, client, bodyReadTimeoutMs);
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
  bodyReadTimeoutMs: number = DEFAULT_BODY_READ_TIMEOUT_MS,
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
      await handleToolForward(id, req, client, res, bodyReadTimeoutMs);
      return;
    }
    if (resource === "recipes" && id === "validate" && segments.length === 3) {
      await handleRecipeValidate(req, res, bodyReadTimeoutMs);
      return;
    }
  }
  NotFound(res, url.pathname);
}

/**
 * Relays the daemon's self-report with one derived field added beside it —
 * {@link describeCapabilityRouting}, which says which of the advertised
 * capabilities this surface actually routes. Nothing in the daemon's own keys is
 * rewritten or dropped: `capabilities` stays the daemon's measurement, and the
 * reconciliation is a separate key, because the discovery answer and the routing
 * answer have to be reconcilable at the one door a client stands at.
 */
async function handleHello(client: EngineClientLike, res: ServerResponse): Promise<void> {
  try {
    const result = await client.call("hello");
    ok(res, describeCapabilityRouting(result));
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
      `operationId must match \`${OPERATION_ID_FORM}\``);
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

/**
 * One wall-clock bound for a request that makes several engine round trips — the
 * same shape `tools.ts` uses for `gp_recent_reports` (`CallBudget`), reimplemented
 * here only because that class is not exported. The three members are the three
 * decisions that make a budget a budget and not a timeout: {@link spent} stops
 * *sending* the next request, {@link expired} stops *waiting* on the one already
 * in flight, and {@link done} releases the single timer so an answered request is
 * not the reason this process stays alive.
 *
 * `test/http-gateway.test.mjs` pins the equivalence with the authority (same
 * bound, same units, both arms enforced) rather than letting the two drift.
 */
class FanOutBudget {
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
   * Unreferenced, because a request that has already been answered must not be
   * the reason the gateway's process stays up.
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

/** One `last_evidence` read's outcome, tagged so nothing can reject into the race. */
type EvidenceFetch =
  | { kind: "pack"; raw: unknown }
  | { kind: "missing" }
  | { kind: "failed"; error: unknown };

async function fetchLastEvidence(client: EngineClientLike, operationId: string): Promise<EvidenceFetch> {
  try {
    return { kind: "pack", raw: await client.call("last_evidence", { operationId }) };
  } catch (error) {
    if (error instanceof EngineCallError && error.code === GP_E_NO_EVIDENCE) {
      return { kind: "missing" };
    }
    // Tagged, never rethrown: this promise is raced against the budget, and a
    // rejection the race has already lost would surface as an unhandled rejection
    // instead of as this request's answer.
    return { kind: "failed", error };
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
      `ids must be a comma-separated list of operationIds of form \`${OPERATION_ID_FORM}\``);
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

  // Fetch each id inside ONE budget for the whole fan-out: the daemon answers one
  // request at a time, and each `last_evidence` is allowed the caller-visible
  // ceiling on its own, so an unbudgeted loop over the id ceiling is that ceiling
  // times the id count of held connection — a wait no curl client
  // outlasts, and one whose answer arrives as a dropped connection with no code
  // and no remedy. The daemon's bounded history may have evicted an id or the
  // engine may have restarted, so per-item misses are skipped with a note instead
  // of failing the whole report, and an id the budget could not reach is named as
  // not fetched (honesty: a missing pack is "skipped", an unreached one "not
  // fetched", never a fabricated render and never a silent omission).
  const blocks: string[] = [];
  const renderedIds: string[] = [];
  const skipped: string[] = [];
  const notFetched: string[] = [];
  /**
   * The id that ended the fan-out, with the answer that ended it.
   *
   * It is *recorded*, not returned, because a failure on a later id used to discard every
   * pack this request had already rendered: the loop `return`ed straight to an error
   * response, and the caller was left holding nothing for a read that had partly worked —
   * while this file's own budget comment promises that what this request did not reach is
   * "never dropped from it", and `tools.ts`'s `gp_recent_reports` (the same fan-out over
   * the same `last_evidence` on the other doorway) had already been fixed to render what it
   * has and name the failure (2026-10-24 review, B6). Both faces now build one shape:
   * packs kept, failing id named, unreached ids named, and an error frame only when nothing
   * at all could be rendered.
   */
  let hardFailure: { operationId: string; line: string; kind: "frame" | "engine"; error: unknown } | null = null;
  const budget = new FanOutBudget(EVIDENCE_FANOUT_BUDGET_MS);
  try {
    for (const [index, operationId] of ids.entries()) {
      if (budget.spent) {
        notFetched.push(...ids.slice(index));
        break;
      }
      const settled = await Promise.race([fetchLastEvidence(client, operationId), budget.expired]);
      if (settled === "budget") {
        // The read in flight is dropped here, and with it every id that had not
        // been sent: the daemon may still be answering exactly that request, which
        // is what the caller has to know before deciding anything, so they stay
        // named in the answer.
        notFetched.push(...ids.slice(index));
        break;
      }
      if (settled.kind === "pack") {
        try {
          const { pack, measuredSchemaVersion } = parseEvidenceFrame(settled.raw);
          blocks.push(render(packForReport(pack, measuredSchemaVersion), format));
          renderedIds.push(operationId);
        } catch (error) {
          // The daemon answered this id, and what it answered is not a pack. Say so and
          // stop asking — but keep the packs that are already in hand.
          hardFailure = {
            operationId,
            kind: "frame",
            error,
            line: `${GP_E_INTERNAL}: the daemon returned a last_evidence frame this gateway cannot render `
              + `(no parseable evidencePack for ${operationId}: ${wireCause("the last_evidence fan-out", error)})`,
          };
          notFetched.push(...ids.slice(index + 1));
          break;
        }
      } else if (settled.kind === "missing") {
        skipped.push(operationId);
      } else {
        // The too-large advice is the tool contract's business, so the aggregate route asks the same
        // helper the single-fetch route uses — but only when this is the whole answer (below).
        hardFailure = {
          operationId,
          kind: "engine",
          error: settled.error,
          line: engineFailureLine(settled.error),
        };
        notFetched.push(...ids.slice(index + 1));
        break;
      }
    }
  } finally {
    budget.done();
  }

  if (blocks.length === 0 && hardFailure !== null) {
    // Nothing could be rendered, so the answer to the one id that failed is the whole of
    // this request's information and goes out under its own code — with the ids this
    // request never reached named next to it, which is what keeps a stopped fan-out from
    // reading as "the daemon refused everything".
    const tail = notFetchedTail(notFetched);
    if (hardFailure.kind === "frame") {
      failEvidenceFrameShape(res, hardFailure.error, hardFailure.operationId, tail);
      return;
    }
    await failEngine(res, hardFailure.error, TOOL_BY_NAME.get("gp_last_evidence"), {
      operationId: hardFailure.operationId,
    }, tail);
    return;
  }

  if (blocks.length === 0 && notFetched.length > 0) {
    // Not "no evidence": these operations may well have packs, and this read ran
    // out of the wait it allows itself. Answering GP_E_NO_EVIDENCE here tells a
    // caller its actions produced nothing — the reading that makes it re-perform
    // the action they came from.
    fail(res, 504, GP_E_ENGINE_TIMEOUT,
      `this gateway fetched no pack inside its own ${EVIDENCE_FANOUT_BUDGET_MS}ms budget for ${ids.length} `
      + `id(s): ${notFetched.length} went unanswered (${notFetched.join(", ")})`
      + (skipped.length === 0
        ? ""
        : `, and ${skipped.length} were answered as having no evidence in the daemon history`),
      "the ids named above were not fetched, which is not a finding about the operations behind them: the daemon "
      + "answers one request at a time and may still be working on the one this request stopped waiting for. Read "
      + "one operation with GET /v1/evidence/<operationId>, which answers inside its own deadline, or send this "
      + `request again with fewer ids (at most ${MAX_EVIDENCE_IDS} per request, and this budget is one request's, `
      + "not one id's). See what the attached app is doing now without changing it with POST /v1/tools/observe, "
      + "POST /v1/tools/assert_element or POST /v1/tools/probe_status. A wait that expired says nothing about the "
      + "daemon's health, so nothing here authorises restarting it.");
    return;
  }

  if (blocks.length === 0) {
    // Every id this route sent came back answered, with `GP_E_NO_EVIDENCE`. That is the
    // daemon saying its bounded history holds no pack for the id — it is *not* a statement
    // that the operation never ran, and it is not evidence about the daemon's lifetime
    // either: a request that receives an answer is a request to something that is up. The
    // sentence this branch used to open with asserted exactly that unmeasured cause ("the
    // engine may have restarted"); the MCP half of the same branch was rewritten for that
    // reason (review 2026-10-09 finding 4, `tools.ts`) and this route is the same fact, so
    // it now says the same thing in this surface's own nouns.
    fail(res, 404, GP_E_NO_EVIDENCE,
      `none of the ${ids.length} requested ${ids.length === 1 ? "operation has" : "operations have"} a pack in the `
      + "daemon history: each id this request named was fetched and answered with that code",
      "the daemon holding no pack for these operations is a fact about its bounded history, not evidence that they "
      + "did not run, and this request measured nothing about a restart, so no cause is claimed here. Each id named "
      + "above was fetched and missed, and this gateway keeps no operation trail of its own, so it cannot list what "
      + "ran. Producing a fresh pack means performing another action, which a read like this one does not do for "
      + "you: see what the attached app is doing now with POST /v1/tools/observe, POST /v1/tools/assert_element or "
      + "POST /v1/tools/probe_status, re-fetch one id with GET /v1/evidence/<operationId>, ask again with fewer ids "
      + `(at most ${MAX_EVIDENCE_IDS} per request), and the routes this surface answers are ${TOOL_ROUTES_TEXT}`);
    return;
  }

  const header = format === "html"
    ? `<h1>GlassPane evidence reports (${blocks.length})</h1>`
    : `# GlassPane evidence reports (${blocks.length})`;
  const skipNote = makeSkipNote(skipped, format);
  const unfetchedNote = makeNotFetchedNote(notFetched, format);
  // Reaching this line with a failure recorded means the report below is **partial**: one id
  // was answered with something this gateway cannot render, or the engine refused mid-fan-out.
  // The packs are the useful half of the answer and are not thrown away for it (that was the
  // defect this route shared with `gp_recent_reports`: a caller left holding nothing re-performs
  // the action the report was opened to check on) — but a partial report that does not say so is
  // a report that reads as complete. Name the failing id and the answer that failed it.
  const failureNote = makeHardFailureNote(hardFailure, format);
  const separator = format === "html" ? "\n<hr>\n" : "\n\n---\n";
  const sections: string[] = [header];
  for (const note of [skipNote, unfetchedNote, failureNote]) {
    if (note !== "") {
      sections.push(note);
    }
  }
  sections.push(blocks.join(separator));
  ok(res, {
    format,
    renderedIds,
    skipped,
    notFetched,
    ...(hardFailure === null ? {} : { failed: [hardFailure.operationId] }),
    report: sections.join("\n"),
  });
}

async function handleToolForward(
  name: string,
  req: IncomingMessage,
  client: EngineClientLike,
  res: ServerResponse,
  bodyReadTimeoutMs: number = DEFAULT_BODY_READ_TIMEOUT_MS,
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
    const text = await readBody(req, MAX_REQUEST_BODY_BYTES, bodyReadTimeoutMs);
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof HTTPPayloadTooLargeError) {
      fail(res, 400, HTTP_PAYLOAD_TOO_LARGE,
        `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
        "shrink the request payload and retry");
      return;
    }
    if (error instanceof HTTPBodyUnreadError) {
      fail(res, 408, HTTP_BODY_UNREAD,
        `request body never completed: ${error.message}`,
        `send the whole body in one request (Content-Length must match what you write) and retry; `
        + `this gateway waits ${bodyReadTimeoutMs}ms for one body before it answers this way`);
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

  // The same provider-registration seam `tools.ts` runs the stdio doorway through, in the
  // same place in the sequence: before the frame reaches the daemon, so a capability the
  // registration does not claim an answer for is refused here too rather than answered
  // with a verdict this door cannot attribute. One rule, two doors — a half-armed gate
  // was the defect: the same diagnose reply used to arrive with provenance on stdio and
  // bare over HTTP.
  const claim = attributeCapability(spec.engineMethod, {
    producerVersion: client.reportedEngineVersion ?? null,
  });
  if (claim.status === "refused") {
    fail(res, httpStatusForEngineCode(claim.error.code), claim.error.code, claim.error.message, claim.error.remedy);
    return;
  }
  const attribution = claim.status === "ok" ? providerAttributionLine(claim.provider) : undefined;

  // 面 A's second doorway runs the same argument guard as the first, at the same point in the
  // sequence: a malformed declared dimension is answered as the caller's bad request (it *is* the
  // caller's argument), and a well-formed one never reaches the daemon. Without this leg the curl
  // surface would forward `dimension` inside the frame — the invariant "the engine never sees our
  // annotation" holds only where it is enforced, and two doors that disagree is the defect this
  // file was already amended for once (see the provider-registration note above).
  const declared = validateDimension(checked.value.dimension);
  if (!declared.ok) {
    fail(res, 400, declared.error.code, declared.error.message, declared.error.remedy);
    return;
  }

  try {
    const result = await client.call(spec.engineMethod, engineBody(checked.value));
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
    ok(res, result, attribution, declared.dimension);
  } catch (error) {
    await failEngine(res, error, spec, engineBody(checked.value));
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
async function handleRecipeValidate(
  req: IncomingMessage,
  res: ServerResponse,
  bodyReadTimeoutMs: number = DEFAULT_BODY_READ_TIMEOUT_MS,
): Promise<void> {
  try {
    await readBody(req, MAX_REQUEST_BODY_BYTES, bodyReadTimeoutMs);
  } catch (error) {
    if (error instanceof HTTPPayloadTooLargeError) {
      fail(res, 400, HTTP_PAYLOAD_TOO_LARGE,
        `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
        "shrink the request payload and retry");
      return;
    }
    if (error instanceof HTTPBodyUnreadError) {
      fail(res, 408, HTTP_BODY_UNREAD,
        `request body never completed: ${error.message}`,
        `send the whole body in one request and retry; this gateway waits ${bodyReadTimeoutMs}ms `
        + "for one body before it answers this way");
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

/**
 * The other half of "what this report does not contain": an id this request
 * stopped waiting for, named with the wait that ran out.
 *
 * Deliberately not folded into {@link makeSkipNote}. "Unreachable" is the
 * daemon's answer — it was asked and said it has no such pack — while a
 * budget stop means nothing was answered, and the daemon may be producing that
 * pack right now. An agent that reads the second as the first goes and performs
 * the action again.
 */
function makeNotFetchedNote(notFetched: readonly string[], format: ReportFormat): string {
  if (notFetched.length === 0) {
    return "";
  }
  const label = notFetched.length === 1 ? "entry" : "entries";
  const sentence = `not fetched within this request's ${EVIDENCE_FANOUT_BUDGET_MS}ms wait: `
    + `${notFetched.length} ${label} left unanswered: ${notFetched.join(", ")}. `
    + "Fetch one by id with GET /v1/evidence/<operationId>, or ask again with a shorter ids= list";
  return format === "html"
    ? `<p class="gp-not-fetched">${escapeHTML(sentence)}</p>`
    : `> ${sentence}`;
}

/** How many characters of a failure cause a response is allowed to carry. */
const CAUSE_MAX_CHARS = 400;

/** Cap a cause without pretending the cut bytes were shown. */
function boundedCause(text: string): string {
  return text.length <= CAUSE_MAX_CHARS
    ? text
    : `${text.slice(0, CAUSE_MAX_CHARS)}… [+${text.length - CAUSE_MAX_CHARS} chars not shown]`;
}

/**
 * The one-line account of an engine failure for the *partial* report body.
 *
 * It transcribes the code and message the daemon (or `engine-client.ts`) wrote; it does not
 * re-derive advice, because advice for the whole-request case is `failEngine`'s business and a
 * second copy of that table is how the two doorways start answering the same code differently.
 */
function engineFailureLine(error: unknown): string {
  return error instanceof EngineCallError
    ? `${error.code}: ${boundedCause(error.message)}`
    : `${GP_E_INTERNAL}: ${wireCause("an engine call inside the partial report", error)}`;
}

/** The clause that keeps a stopped fan-out from reading as "the daemon refused everything". */
function notFetchedTail(notFetched: readonly string[]): string {
  if (notFetched.length === 0) {
    return "";
  }
  const label = notFetched.length === 1 ? "id" : "ids";
  return ` — and ${notFetched.length} ${label} this request never sent (${notFetched.join(", ")}), `
    + "which is a stopped read, not an answer about them";
}

/**
 * The note naming the id that ended a partial evidence fan-out.
 *
 * Same reason the MCP half has one (`tools.ts`'s `gp_recent_reports`): the packs already in
 * hand are kept, so the failure has to appear *inside* the report — a 200 whose body silently
 * omits the id that failed is the shape that makes a caller believe it read the whole list.
 */
function makeHardFailureNote(
  failure: { operationId: string; line: string } | null,
  format: ReportFormat,
): string {
  if (failure === null) {
    return "";
  }
  const sentence = `incomplete: ${failure.operationId} failed with ${failure.line} — the fan-out stopped there, `
    + 'so the packs above are what this request read, not the whole list';
  return format === "html"
    ? `<p class="gp-incomplete">${escapeHTML(sentence)}</p>`
    : `> ${sentence}`;
}

/* ------------------------------------------------------------------ *
 * Response envelopes and the body reader (all JSON, capped).
 * ------------------------------------------------------------------ */

/**
 * The success envelope. `result` is the daemon's reply, byte for byte as this client
 * decoded it, and never folded into: the same rule the MCP doorway keeps when it appends
 * the attribution as its own content item.
 *
 * One caller adds a key *beside* the daemon's rather than folding one into them:
 * {@link handleHello} appends the routing reconciliation {@link
 * describeCapabilityRouting} derives from `FORWARDABLE_TOOLS`, and does not touch
 * any key the daemon wrote.
 *
 * `attribution` is that same item's text, present exactly when the provider-registration
 * contract claims the method that produced the reply. A caller reading `result` alone
 * therefore gets the same answer on either doorway, and a caller asking who produced a
 * judgement gets one answer rather than one per door.
 */
function ok(res: ServerResponse, result: unknown, attribution?: string, dimension?: string): void {
  // `dimension` is this doorway's echo of a caller-declared dimension (finding B3,
  // 2026-10-27): the MCP doorway answers the same declaration with its own content
  // item (`tools.ts`, `dimensionAttributionLine`), and a curl caller that declared one
  // got nothing back — two doors, two answers about the same argument, which is the
  // family this file has already been amended for. The sentence is authored once in
  // `dimension.ts` and reused here rather than re-spelled, so the two doorways cannot
  // drift in wording while agreeing in meaning. Undeclared calls get no key at all:
  // the daemon's `result` bytes do not move.
  const body: Record<string, unknown> = { ok: true, result };
  if (attribution !== undefined) body.attribution = attribution;
  if (dimension !== undefined) body.dimension = dimensionAttributionLine(dimension);
  writeJson(res, 200, body);
}

function fail(res: ServerResponse, status: number, code: string, message: string, remedy: string): void {
  // One boundary, and every caller-facing sentence crosses it. The remedy for a
  // timeout is authored in `engine-client.ts` for *both* surfaces (`surface:
  // "http"` selects the late-reply sentence), and the daemon authors its own table
  // in Swift with no HTTP surface in view at all — so a name written for an MCP
  // caller can arrive here from either, and a curl caller cannot call a tool by
  // name. This is where that gets translated, because it is where this surface's
  // advice ends and another's begins; the authoring layers stay untouched, which
  // is what keeps this from being a second copy of their text.
  writeJson(res, status, { ok: false, error: { code, message: forHttpCaller(message), remedy: forHttpCaller(remedy) } });
}

/**
 * Rewrite another layer's caller-facing prose into what this surface can execute.
 *
 * Two classes of leak, both real and both from text this file does not own:
 *  - an MCP tool name (`gp_probe_status`), which has no meaning for a curl caller
 *    and — worse — invites a `POST /v1/tools/gp_probe_status` shaped guess;
 *  - a *false* claim about the other surface ("the shell does not queue one MCP
 *    request behind another"), which on this side describes a queue the reader is
 *    not standing in.
 * The route each tool name maps to is read out of {@link FORWARDABLE_TOOLS}, the
 * same map that decides which routes exist, so a translation can never name a 404
 * — a tool the daemon answers but this gateway does not forward (every tool with
 * its own `execute`) is reported as not exposed here rather than sent to a route
 * that is not. `test/http-gateway.test.mjs` scans every response body this
 * produces for `gp_` names and asks of every route it does name.
 */
function forHttpCaller(text: string): string {
  let out = text.replace(/\bgp_([a-z][a-z_]*)\b/g, (_whole, method: string) => (
    FORWARDABLE_TOOLS.has(method)
      ? `POST /v1/tools/${method}`
      : "an MCP-only tool this gateway does not expose"
  ));
  for (const [pattern, replacement] of MCP_PROSE_FOR_HTTP) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Clauses written from the MCP shell's own point of view, stated for this one. */
const MCP_PROSE_FOR_HTTP: ReadonlyArray<readonly [RegExp, string]> = [
  [/the shell does not queue one MCP request behind another/gi,
    "this gateway does not queue one request behind another"],
];

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
    case GP_E_ENGINE_BACKLOG:
      // 503 for the same reason `GP_E_ENGINE_UNREACHABLE` gets it — this gateway
      // cannot serve the request right now — but it is a separate code because the
      // two answers tell a caller to do different things: one says the service may
      // need to be brought back, this one says stop sending and let the queue
      // drain. Collapsing them would hand a curl caller the restart reading.
      return 503;
    case GP_E_ENGINE_TIMEOUT:
      return 504;
    case GP_E_REGISTRY_DRIFT:
      // 503，不是 4xx：这一码说的是"另一个写者在我们读与写之间改过盘，所以这次什么都没写"。
      // 说成调用方的错（走 default 的 422）会让 curl 那一侧去改它本来就没错的参数，
      // 而真正的动作是再读一次盘、把同一次登记重发一遍。
      return 503;
    case GP_E_STATE_ROOT_REFUSED:
      // 同样是 503：这一码说的不是"你的参数不对"，而是"后台服务在 hello 里自报了一个
      // 本壳不会创建、也不会改权限的根，所以这次什么都没读、什么都没写"。把它答成 4xx
      // 会让 curl 那一侧去改它本来就没错的 body，而真正的动作在 daemon 那一侧
      // （`glasspaned --state-dir <这个安装自己能拥有的目录>`）。`GP_E_BAD_PARAMS`
      // 才是这一面上"调用方的错"那一族，而它有自己那条 400。
      return 503;
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
  tail: string = "",
): Promise<void> {
  if (error instanceof EngineCallError) {
    fail(res, httpStatusForEngineCode(error.code), error.code, `${error.message}${tail}`,
      engineRemedy(error, spec, params));
    return;
  }
  // Not an engine error frame, so this is *not* a transport verdict either: every
  // transport failure the client raises arrives as an `EngineCallError` carrying
  // GP_E_ENGINE_UNREACHABLE. What lands here is a request this gateway could not
  // complete, and the old text called it "engine transport error … ensure the
  // daemon is running, then retry" — an unearned diagnosis plus a restart order
  // for a daemon that had, in every reachable case, just answered.
  fail(res, 500, GP_E_INTERNAL,
    `this gateway could not complete the request: ${wireCause(`the ${spec?.name ?? "tool"} route handler`, error)}${tail}`,
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
 * table, or `engine-client.ts`'s timeout text) with its *words for the other
 * surface* translated by {@link forHttpCaller} at the response boundary — that
 * text still says "the shell does not queue one MCP request behind another, so
 * gp_probe_status goes out at once" on its `http` branch, and a curl caller has no
 * tool by that name. Rewriting the sentence here instead of in
 * `engine-client.ts` keeps one copy of the advice: the authoring layer holds the
 * transport's facts, this file holds what its own callers can type, and
 * `test/http-gateway.test.mjs` fails on any `gp_` name that gets through.
 */
function engineRemedy(
  error: EngineCallError,
  spec?: ToolSpec,
  params?: Record<string, unknown>,
): string {
  if (spec !== undefined && error.code === GP_E_PAYLOAD_TOO_LARGE) {
    const asked = params ?? {};
    // The branch is taken from `tools.ts`'s single gate, not from a second copy of the
    // method lists here: the reviewed version asked only "is this replay-unsafe", which let
    // `snapshot` — the method this surface's own timeout answer refuses to re-send, because
    // a second accepted copy appends to the daemon's bounded ring — receive "retry with a
    // smaller maxDepth" from the overflow path (2026-10-24 review, B4).
    switch (payloadOverflowArm(spec.engineMethod)) {
      case "replay-unsafe":
        return httpReplayUnsafePayloadAdvice(spec, asked);
      case "ring-writing":
        return httpRingWritingPayloadAdvice(spec, asked);
      case "narrowable":
        return oversizedReplyAdvice(spec, asked);
    }
  }
  return error.remedy;
}

/**
 * A reply that overflowed on a method whose re-send writes daemon state, in this surface's
 * nouns.
 *
 * `tools.ts` owns the decision ({@link payloadOverflowArm}); this is the same fact worded
 * for a caller holding curl: no `gp_*` tool to name, no operation trail to read, and the
 * routes below are the ones this gateway actually answers.
 */
function httpRingWritingPayloadAdvice(spec: ToolSpec, params: Record<string, unknown>): string {
  return `the reply was too large for one frame (${MAX_FRAME_BYTES}-byte limit); '${spec.engineMethod}' reached the `
    + "daemon and was answered, and only its reply was dropped — which means the baseline it captured is already "
    + `stored. Do NOT send this request again to recover that reply: ${RING_WRITE_REASON}. `
    + `${narrowingKnobPhrase(spec, params)}, and using it is the second send this answer refuses; the ids the daemon `
    + "stored are only ever where a caller already has them, in the snapshot replies it has already received, and "
    + "this gateway lists no ring. Read what is held, and see the attached app as it is now without changing it "
    + "with POST /v1/tools/observe, POST /v1/tools/assert_element or POST /v1/tools/probe_status; an operation whose "
    + "id is already held re-reads with GET /v1/evidence/<operationId>. Taking a fresh baseline is a decision, not "
    + "error recovery, and the connection is intact and the daemon keeps answering other requests";
}

/**
 * A reply that overflowed, for a request whose re-issue performs a change again.
 *
 * `tools.ts` applies exactly this split on the MCP path; this is the same decision
 * worded for a caller that is holding curl rather than a tool list, because
 * `replayUnsafePayloadAdvice()` routes that caller to `gp_recent_reports` — a tool
 * this surface does not expose (`POST /v1/tools/recent_reports` is a 404) and the
 * HTTP gateway has no operation trail to list from anyway. The narrowing clause is
 * still delegated to `tools.ts`'s exported `oversizedReplyAdvice`, so the knob and
 * floor facts stay in one file; whether this branch is taken at all is asked of
 * the transport (`isReplayUnsafeMethod` in `engine-client.ts`), the one layer that
 * already answers that question when it caps a caller's wait.
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
function failEvidenceFrameShape(
  res: ServerResponse,
  error: unknown,
  operationId?: string,
  tail: string = "",
): void {
  fail(res, 502, GP_E_INTERNAL,
    `the daemon returned a last_evidence frame that does not match the engine contract (no parseable evidencePack${operationId === undefined ? "" : ` for ${operationId}`}: ${wireCause("the last_evidence frame parser", error)})${tail}`,
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

/**
 * The body never arrived, for one of two stated reasons: the caller went quiet
 * mid-body, or the connection closed before `end`. Both are answers this surface
 * used to *not have* — finding B1 (2026-10-27): `readBody` capped bytes and had no
 * ceiling on time, and a stalled body kept the handler pending until Node destroyed
 * the socket, so the caller received an `ECONNRESET` with no `{code,message,remedy}`
 * while the gateway held a request open. The cause is carried in the message because
 * "quiet" and "gone" are different facts for the caller to act on.
 */
class HTTPBodyUnreadError extends Error {
  constructor(reason: string, timeoutMs: number) {
    super(`request body did not arrive (${reason}; ceiling ${timeoutMs}ms)`);
    this.name = "HTTPBodyUnreadError";
  }
}

/** How long one request body may take, when the caller did not choose (see {@link HttpGatewayOptions.bodyReadTimeoutMs}). */
export const DEFAULT_BODY_READ_TIMEOUT_MS = 15_000;

function readBody(req: IncomingMessage, limit: number, timeoutMs: number = DEFAULT_BODY_READ_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      finish(() => {
        chunks.length = 0;
        req.pause();
        reject(new HTTPBodyUnreadError("no complete body within the read ceiling", timeoutMs));
      });
    }, timeoutMs);
    // A pending body timer must not be the reason a process stays alive: the
    // gateway's own shutdown path is bounded by the socket, not by this timer.
    timer.unref?.();
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop reading, but keep the socket. The 400 that names this limit is
        // the only thing telling the caller *why* it was refused, and destroying
        // the connection here made every oversized body an ECONNRESET with no
        // `{code,message,remedy}` at all — measured with a 300 KiB POST — so the
        // remedy "shrink the request payload and retry" never reached anyone and
        // the caller retried the same oversized body.
        finish(() => {
          chunks.length = 0;
          req.pause();
          reject(new HTTPPayloadTooLargeError(limit));
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(() => resolve(Buffer.concat(chunks).toString("utf8"))));
    // `close` before `end` is the caller hanging up mid-body. Without this arm the
    // promise never settles and the handler — plus the byte ceiling's bookkeeping —
    // is held for a request that no longer exists.
    req.on("close", () => finish(() => {
      chunks.length = 0;
      reject(new HTTPBodyUnreadError("the connection closed before the body ended", timeoutMs));
    }));
    req.on("error", (error) => finish(() => reject(error)));
  });
}