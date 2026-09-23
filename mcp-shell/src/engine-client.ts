import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  LineIo,
  MAX_FRAME_BYTES,
  OversizeFrameError,
  recoverFrameId,
  StreamLineIo,
} from "./io.js";
import { GP_E_ENGINE_UNREACHABLE } from "./errors.js";

/**
 * Agent-actionable remedy for an unreachable daemon (P6 §11 audit items ④/⑥:
 * a remedy must be an executable command, not a prose hint). When the repo
 * installer is present next to this build, hand over the machine-verified
 * restore command: it detects a boot-out'd launchd job, bootstraps it, and
 * verifies the daemon's hello self-report — the only remaining human action
 * (TCC checkbox) stays honest. Falls back to generic wording otherwise.
 */
export function daemonUnreachableRemedy(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const installerCli = path.resolve(here, "..", "..", "installer", "cli.js");
  if (fs.existsSync(installerCli)) {
    return `run "node ${installerCli} --restore-launchd" (auto-restores and verifies the launchd-managed daemon), then retry`;
  }
  return "ensure the glasspane daemon is running (launchd job com.glasspane.daemon; in a repo checkout run `node installer/cli.js --restore-launchd`), then retry";
}

/** Env override for the daemon socket path (default below). */
export const ENGINE_SOCKET_ENV = "GLASSPANE_ENGINE_SOCK";

/**
 * The daemon listens here by default (spec §3.1). Single source: the CLI
 * argument parser in index.ts and the reconnecting transport both resolve the
 * path through this function, so an env override cannot be honoured on one side
 * only.
 */
export function defaultSocketPath(): string {
  return process.env[ENGINE_SOCKET_ENV] ?? path.join(os.homedir(), ".glasspane", "engine.sock");
}

/** Fallback deadline for a method missing from the table below. */
export const ENGINE_TIMEOUT_MS = 10_000;

/**
 * Per-method wall-clock deadlines. 10 s is the daemon's *internal* latency
 * flag (`EngineCore.performanceLatencyBudgetMs`), not its worst-case wall
 * time: a tree walk gets 10 s of its own (`AXChannel.treeTimeoutSeconds`), an
 * act reads the tree twice around a 2 s ping, and an ffwd restore replays up
 * to 64 steps (ParamValidation.stepsUpper) by calling act per step. A uniform
 * 10 s deadline diagnoses a slow-but-healthy daemon as "unreachable, restart
 * it" and then throws away the reply that lands later, so every value here is
 * strictly larger than the daemon's own worst case for that method.
 *
 * What these numbers do after B-02: they are still the caller's wait for every
 * method below the ceiling, and above it they are the daemon-side worst case
 * the timeout text quotes — the caller answered at the ceiling, while the
 * request stays registered so the real reply is attributed when it lands.
 */
export const ENGINE_DEADLINES_MS = {
  hello: 15_000,
  attach: 30_000,
  act: 120_000,
  observe: 45_000,
  assert_element: 60_000,
  diagnose: 30_000,
  last_evidence: 60_000,
  snapshot: 90_000,
  probe_status: 15_000,
  shutdown: 15_000,
} as const;

/** Fixed part of an ffwd restore deadline (per-step cost is `act` above). */
export const RESTORE_BASE_DEADLINE_MS = 30_000;

/**
 * B-02: how long a *caller* may be kept waiting for any method, whatever the
 * daemon's own worst case is.
 *
 * A real MCP client times a single request out at around 60 s, stops waiting,
 * and the agent — holding no answer, no code and no remedy — re-issues the
 * call. On `act` that re-issue performs the same click on the user's screen a
 * second time, which is precisely the harm a deadline is meant to remove. So
 * the ceiling sits below a client's patience: the shell answers at 50 s with
 * `GP_E_ENGINE_TIMEOUT` and the no-replay remedy, and the request stays
 * registered, so the reply that arrives later is still attributed and written
 * to the log (`onDeadline` -> `reportLateReply`). Nothing is discarded by
 * answering early, which is what makes the multi-minute deadlines above safe to
 * cap: they describe the daemon, not the caller's wait.
 */
export const CALLER_VISIBLE_CEILING_MS = 50_000;

/** When the caller gets its answer for `method`: its deadline, capped. */
export function callerDeadlineMs(
  method: string,
  params?: Record<string, unknown>,
  ceilingMs: number = CALLER_VISIBLE_CEILING_MS,
): number {
  return Math.min(engineDeadlineMs(method, params), ceilingMs);
}

/** Methods whose reply is a user-visible action: replaying them is unsafe. */
const REPLAY_UNSAFE_METHODS = new Set(["act", "restore"]);

/** Deadline for one request; `restore` scales with its replayed step count. */
export function engineDeadlineMs(
  method: string,
  params?: Record<string, unknown>,
): number {
  if (method === "restore") {
    const steps = params?.steps;
    const count = Array.isArray(steps) ? steps.length : 0;
    return RESTORE_BASE_DEADLINE_MS + count * ENGINE_DEADLINES_MS.act;
  }
  const known: number | undefined = ENGINE_DEADLINES_MS[method as keyof typeof ENGINE_DEADLINES_MS];
  return known ?? ENGINE_TIMEOUT_MS * 3;
}

/** Engine protocol version this shell speaks (daemon `hello.protocolVersion`). */
export const ENGINE_PROTOCOL_VERSION = "0";

/** Daemon self-report the shell compares a fresh connection against. */
export interface EngineIdentityExpectation {
  /**
   * Engine release this shell was paired with: the repo keeps one version line,
   * so a difference means the MCP config points at another build. Handed over
   * by the entry point rather than minted here, because a literal in this file
   * would sit outside the version-site guard.
   */
  version?: string;
}

/** Shell-local failure codes (mirrors the daemon's `GPErrorCode` spellings). */
export const GP_E_ENGINE_TIMEOUT = "GP_E_ENGINE_TIMEOUT";
export const GP_E_PAYLOAD_TOO_LARGE = "GP_E_PAYLOAD_TOO_LARGE";

/** Error frame returned by the daemon (spec §3.2.1) or raised by the shell. */
export interface EngineErrorBody {
  code: string;
  message: string;
  remedy: string;
}

export class EngineCallError extends Error {
  readonly code: string;
  override readonly message: string;
  readonly remedy: string;

  constructor(code: string, message: string, remedy: string) {
    super(`${code}: ${message}`);
    this.name = "EngineCallError";
    this.code = code;
    this.message = message;
    this.remedy = remedy;
  }

  toBody(): EngineErrorBody {
    return { code: this.code, message: this.message, remedy: this.remedy };
  }
}

/** Remedy for a deadline overrun: wait and measure, never restart or replay. */
export function slowEngineRemedy(method: string): string {
  const poll = "confirm the daemon is alive with a cheap call instead — gp_probe_status goes out immediately while this request is still outstanding (the shell no longer queues one MCP request behind another) and is answered as soon as the daemon is free of it";
  if (REPLAY_UNSAFE_METHODS.has(method)) {
    return `${poll}. The daemon serves one request at a time and is still working on this one, so wait for it; do NOT re-issue ${method}, because the original action can still take effect on the user's screen — the original reply is written to this server's log (stderr) when it lands, which is where the answer is. Restart only if gp_probe_status times out too — then ${daemonUnreachableRemedy()}`;
  }
  return `${poll}. The daemon serves one request at a time and is still working on this one, so wait, then retry this read narrower (smaller maxDepth / a tighter selector); if gp_probe_status times out as well, ${daemonUnreachableRemedy()}`;
}

/**
 * One inbound engine frame. `id: null`/absent is a real wire case: the daemon
 * answers a frame it could not parse, or could not serialize, without one.
 */
interface CallFrame {
  id?: number | string | null;
  result?: unknown;
  error?: Partial<EngineErrorBody>;
}

/**
 * One outstanding request. `settled` means the caller already has its answer;
 * one settled *by timeout* stays registered so the real reply is still
 * attributed and surfaced instead of discarded.
 *
 * `deadlineMs` is when the caller is answered (the method's deadline, capped at
 * the client-safe ceiling); `methodDeadlineMs` is the daemon's own worst case
 * for the method, quoted whenever the cap is what ended the wait.
 */
type Pending = {
  id: number;
  method: string;
  deadlineMs: number;
  methodDeadlineMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  deliver: (value: unknown) => void;
  fail: (reason: EngineCallError) => void;
};

/** How many timed-out entries are kept for late replies before the oldest goes. */
const LATE_REPLY_RETENTION = 16;

/** Log ceiling for a frame body; excess is marked, never silently cut. */
const LOG_BODY_CHARS = 64 * 1024;

/**
 * Request/response association over a line transport. Kept independent of
 * the transport so tests inject a fake LineIo (spec §7.1 "fake engine
 * transport").
 */
export class EngineJsonRpcClient {
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private noteHandler: ((note: string) => void) | null = null;

  constructor(
    private readonly io: LineIo,
    private readonly timeoutMs?: number,
    private readonly identity: EngineIdentityExpectation | null = null,
    /**
     * Ceiling on the caller's wait (B-02). Injectable because a test cannot
     * wait 50 s, and because the ceiling is a property of *who is asking* — a
     * caller with a longer patience gets a longer wait, never a longer
     * registration.
     */
    private readonly callerCeilingMs: number = CALLER_VISIBLE_CEILING_MS,
  ) {
    this.io.onMessage((line) => this.handleMessage(line));
    this.io.onError((error) => {
      if (error instanceof OversizeFrameError) {
        // One frame was dropped; the connection is fine and only the request
        // it answered fails (spec §3.1).
        this.failOversizedReply(error);
        return;
      }
      this.teardown(new EngineCallError(
        GP_E_ENGINE_UNREACHABLE,
        `engine transport error: ${error.message}`,
        daemonUnreachableRemedy(),
      ));
    });
    this.io.onClose(() => this.teardown(new EngineCallError(
      GP_E_ENGINE_UNREACHABLE,
      "engine transport closed",
      daemonUnreachableRemedy(),
    )));
    this.io.onOpen?.(() => this.handshake());
  }

  /**
   * Sink for facts that cannot be attached to any request of the caller: a
   * late reply, a frame with an id this client never issued, a daemon that
   * fails its handshake. Without a sink these stay invisible, which is how
   * "not measured" turns into a confident wrong story.
   */
  onEngineNote(handler: (note: string) => void): void {
    this.noteHandler = handler;
  }

  /** Send a request and await its matching response frame. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const frame = { id, method, ...(params === undefined ? {} : { params }) };
    // An injected `timeoutMs` is the caller's own bound (tests, explicit
    // overrides) and is never re-capped; otherwise the caller waits the
    // daemon's worst case for this method, up to the client-safe ceiling.
    const methodDeadlineMs = this.timeoutMs ?? engineDeadlineMs(method, params);
    const deadlineMs = this.timeoutMs ?? callerDeadlineMs(method, params, this.callerCeilingMs);

    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = {
        id,
        method,
        deadlineMs,
        methodDeadlineMs,
        timer: null,
        settled: false,
        deliver: resolve,
        fail: reject,
      };
      entry.timer = setTimeout(() => this.onDeadline(entry), deadlineMs);
      // Deliberately NOT `timer.unref()`: an unreferenced timer does not keep
      // the loop alive, so when a pending call is the only outstanding work
      // Node exits and the caller is settled by process death instead of by a
      // diagnosis. It is cleared on every settle path below, so it only
      // survives while the request really is outstanding.
      this.pending.set(id, entry);

      try {
        this.io.writeLine(JSON.stringify(frame));
      } catch (error) {
        // Nothing reached the daemon, so no late reply can ever land for it.
        this.pending.delete(id);
        this.reject(entry, new EngineCallError(
          GP_E_ENGINE_UNREACHABLE,
          `cannot send '${method}' to the engine daemon: ${(error as Error).message}`,
          daemonUnreachableRemedy(),
        ));
      }
    });
  }

  close(): void {
    this.teardown(new EngineCallError(
      GP_E_ENGINE_UNREACHABLE,
      "engine client closed",
      daemonUnreachableRemedy(),
    ));
    this.closed = true;
    this.io.close();
  }

  /**
   * Timeout path: settle the caller with a *slow* diagnosis but keep the
   * entry, so a reply landing afterwards is delivered instead of thrown away.
   * Only the transport going away makes a request unrecoverable.
   */
  private onDeadline(entry: Pending): void {
    this.report(
      `engine has not answered '${entry.method}' (id ${entry.id}) within ${entry.deadlineMs}ms — still in flight`,
    );
    const capped = entry.methodDeadlineMs > entry.deadlineMs
      ? ` This shell stops waiting for an MCP client's sake at ${entry.deadlineMs}ms while the daemon gets up to ${entry.methodDeadlineMs}ms for '${entry.method}', because a client that is left hanging retries on its own and a retried '${entry.method}' runs twice.`
      : "";
    this.reject(entry, new EngineCallError(
      GP_E_ENGINE_TIMEOUT,
      `engine is still working on '${entry.method}': no reply after ${entry.deadlineMs}ms. `
      + "The request stays registered — a late reply is written to the server log — so this is a busy or slow daemon, not an unreachable one."
      + capped,
      slowEngineRemedy(entry.method),
    ));
    this.retainForLateReply();
  }

  /**
   * A settled-by-timeout entry is what makes a late reply attributable, so the
   * retention is bounded oldest-first and the eviction is logged, not silent.
   */
  private retainForLateReply(): void {
    const stale = [...this.pending.values()].filter((entry) => entry.settled);
    if (stale.length < LATE_REPLY_RETENTION) {
      return;
    }
    const evicted = stale[0];
    if (!evicted) {
      return;
    }
    this.pending.delete(evicted.id);
    this.report(`dropped late-reply tracking for '${evicted.method}' (id ${evicted.id}): retention cap ${LATE_REPLY_RETENTION} reached`);
  }

  private handleMessage(line: string): void {
    let frame: CallFrame;
    try {
      frame = JSON.parse(line) as CallFrame;
    } catch {
      this.report(`engine sent a non-JSON frame, dropped: ${truncate(line)}`);
      return;
    }

    const id = frame.id;

    if (typeof id === "number") {
      const entry = this.pending.get(id);
      if (!entry) {
        this.report(`engine sent a frame for request id ${id}, which this client never issued (or already gave up on): ${truncate(line)}`);
        return;
      }
      this.pending.delete(id);
      if (entry.settled) {
        this.reportLateReply(entry, frame);
        return;
      }
      this.settleFromFrame(entry, frame);
      return;
    }

    // No matching request, and neither case may be reported as "unreachable":
    //   id null/absent — the daemon lost the id while answering a frame it
    //     could not parse (its own oversize path) or could not serialize. It
    //     processes strictly in arrival order and writes each response before
    //     reading the next request, so the oldest unanswered request is the
    //     one it was working on.
    //   any other id shape — nothing to attribute; say so and leave the
    //     outstanding requests to their own deadlines.
    if (id === null || id === undefined) {
      const target = this.oldestOpen();
      if (frame.error && target) {
        // This frame *is* that request's answer, so stop tracking it.
        this.pending.delete(target.id);
        this.reject(target, attribute(this.engineError(frame.error), target));
        return;
      }
      this.report(frame.error
        ? `engine reported ${this.engineError(frame.error).code} with no request in flight: ${truncate(line)}`
        : `engine sent an id-less frame with no request in flight: ${truncate(line)}`);
      return;
    }
    this.report(`engine sent a frame with a non-numeric request id (${jsonOrString(id)}), which this client never issues: ${truncate(line)}`);
  }

  private settleFromFrame(entry: Pending, frame: CallFrame): void {
    if (frame.error) {
      this.reject(entry, this.engineError(frame.error));
    } else {
      this.resolve(entry, frame.result);
    }
  }

  /**
   * A frame over the cap: attribute it to the request it belonged to — from
   * the retained head when the daemon echoed an id, else by arrival order —
   * and fail that one call only.
   */
  private failOversizedReply(error: OversizeFrameError): void {
    const echoed = recoverFrameId(error.prefix);
    let entry = typeof echoed === "number" ? this.pending.get(echoed) : undefined;
    if (entry?.settled) {
      this.pending.delete(entry.id);
      this.report(`the engine's late reply to '${entry.method}' (id ${entry.id}) exceeded the ${MAX_FRAME_BYTES}-byte frame cap (${error.bytes} bytes), so its body could not be delivered even late`);
      return;
    }
    const inferred = entry === undefined;
    if (!entry) {
      entry = this.oldestOpen();
    }
    if (!entry) {
      this.report(`engine sent an oversized frame (${error.bytes} bytes) with no request in flight — dropped, connection intact`);
      return;
    }
    this.pending.delete(entry.id);
    this.reject(entry, attribute(new EngineCallError(
      GP_E_PAYLOAD_TOO_LARGE,
      `the engine's reply to '${entry.method}' exceeded the ${MAX_FRAME_BYTES}-byte frame cap (${error.bytes} bytes) and was dropped; the connection is intact and other requests are unaffected`,
      "narrow this request: retry with a smaller maxDepth or a more specific selector (the daemon keeps answering other requests)",
    ), entry, inferred));
  }

  private engineError(body: Partial<EngineErrorBody>): EngineCallError {
    return new EngineCallError(
      String(body.code ?? "GP_E_UNKNOWN"),
      String(body.message ?? "the engine sent an error frame without a message"),
      typeof body.remedy === "string" && body.remedy !== ""
        ? body.remedy
        : "the engine sent no remedy for this error code; check the daemon log (stderr) and retry",
    );
  }

  /** Oldest request the caller is still waiting on (daemon FIFO order). */
  private oldestOpen(): Pending | undefined {
    for (const entry of this.pending.values()) {
      if (!entry.settled) {
        return entry;
      }
    }
    return undefined;
  }

  private reportLateReply(entry: Pending, frame: CallFrame): void {
    const body = frame.error
      ? `error ${JSON.stringify(frame.error)}`
      : truncate(jsonOrString(frame.result));
    this.report(
      `late engine reply for '${entry.method}' (id ${entry.id}), ${entry.deadlineMs}ms deadline already reported: ${body}`,
    );
  }

  private resolve(entry: Pending, value: unknown): void {
    this.complete(entry);
    entry.deliver(value);
  }

  private reject(entry: Pending, reason: EngineCallError): void {
    this.complete(entry);
    entry.fail(reason);
  }

  /**
   * Single settle funnel: clears the deadline timer on every path and marks
   * the entry settled. Callers delete the entry when the transport can no
   * longer answer it, and keep it after a timeout for the late reply.
   */
  private complete(entry: Pending): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.settled = true;
  }

  /** Reject everything outstanding and drop every handle. */
  private teardown(reason: EngineCallError): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (!entry.settled) {
        this.reject(entry, reason);
      } else if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    }
  }

  private report(note: string): void {
    this.noteHandler?.(note);
  }

  /**
   * R4-06: both sides self-report protocol/version and the repo keeps a single
   * version line, yet nothing compared them at runtime — an old daemon under a
   * new shell only surfaced as a mystery schema error later. Handshake once
   * per (re)connection and report the measurement, including "unmeasured".
   */
  private handshake(): void {
    if (this.closed) {
      return;
    }
    this.call("hello").then(
      (result) => this.verifyIdentity(result),
      (error: unknown) => this.report(
        `engine did not answer the hello handshake on this connection: ${(error as Error).message}`,
      ),
    );
  }

  private verifyIdentity(result: unknown): void {
    const expected = ENGINE_PROTOCOL_VERSION;
    if (typeof result !== "object" || result === null) {
      this.report("engine answered hello without an object result — protocol compatibility could not be measured");
      return;
    }
    const report = result as { engine?: unknown; version?: unknown; protocolVersion?: unknown };
    const protocol = typeof report.protocolVersion === "string" ? report.protocolVersion : null;
    if (protocol === null) {
      this.report(`engine self-report has no protocolVersion (engine=${jsonOrString(report.engine)}); expected '${expected}' — compatibility unverified`);
      return;
    }
    if (protocol !== expected) {
      this.report(`protocol mismatch: engine speaks '${protocol}', this shell speaks '${expected}' — upgrade or restart one side before trusting tool results`);
      return;
    }
    const version = typeof report.version === "string" ? report.version : null;
    const wantVersion = this.identity?.version;
    if (version !== null && wantVersion !== undefined && version !== wantVersion) {
      this.report(`version mismatch: engine self-reports '${version}', this MCP shell ships '${wantVersion}' (single version line) — one side is stale`);
    }
  }
}

/** Note which request an id-less attribution was matched to, without hiding it. */
function attribute(error: EngineCallError, entry: Pending, inferred = true): EngineCallError {
  if (!inferred) {
    return error;
  }
  return new EngineCallError(
    error.code,
    `${error.message} (the engine's frame carried no request id; this is the oldest request still in flight, and the daemon answers in the order it received them — method '${entry.method}')`,
    error.remedy,
  );
}

function truncate(text: string): string {
  return text.length <= LOG_BODY_CHARS
    ? text
    : `${text.slice(0, LOG_BODY_CHARS)}… [+${text.length - LOG_BODY_CHARS} chars not logged]`;
}

/** Inbound values come from JSON.parse, so serialization cannot throw or cycle. */
function jsonOrString(value: unknown): string {
  return String(JSON.stringify(value));
}

/** How a transport stream is opened; injectable so tests need no socket. */
export type EngineTransportOpener = (socketPath: string) => Duplex;

/**
 * A line transport that is genuinely lazy *and* recoverable: nothing opens
 * until the first call, and once a connection closed or errored the next call
 * opens a fresh one. Without this, a daemon restart (what `--restore-launchd`
 * exists for) leaves the shell failing forever while its own remedy says "run
 * --restore-launchd, then retry" — a retry that could never work without also
 * restarting the MCP client.
 */
class ReconnectingSocketIo implements LineIo {
  private inner: StreamLineIo | null = null;
  private closed = false;
  private messageHandler: ((line: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private openHandler: (() => void) | null = null;

  constructor(
    private readonly socketPath: string,
    private readonly open: EngineTransportOpener,
  ) {}

  writeLine(line: string): void {
    this.connect().writeLine(line);
  }

  onMessage(handler: (line: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }

  close(): void {
    this.closed = true;
    const inner = this.inner;
    this.inner = null;
    inner?.close();
  }

  private connect(): StreamLineIo {
    if (this.closed) {
      throw new Error(`engine transport for ${this.socketPath} is closed`);
    }
    if (this.inner) {
      return this.inner;
    }
    const socket = this.open(this.socketPath);
    const io = new StreamLineIo(socket, socket);
    io.onMessage((line) => this.messageHandler?.(line));
    io.onError((error) => {
      // Forget this transport first, and drop its socket: the next call must
      // open a new one rather than write into a dead fd forever.
      if (this.inner === io) {
        this.inner = null;
        io.close();
      }
      this.errorHandler?.(error);
    });
    io.onClose(() => {
      if (this.inner === io) {
        this.inner = null;
      }
      this.closeHandler?.();
    });
    socket.once("connect", () => {
      if (this.inner === io) {
        this.openHandler?.();
      }
    });
    this.inner = io;
    return io;
  }
}

/**
 * Production client on a Unix socket: lazy connect, reconnect on demand once
 * the daemon is back, re-handshake per connection.
 */
export function unixSocketEngineClient(
  socketPath: string,
  options: {
    identity?: EngineIdentityExpectation;
    open?: EngineTransportOpener;
    callerCeilingMs?: number;
  } = {},
): EngineJsonRpcClient {
  const open: EngineTransportOpener = options.open
    ?? ((target) => net.createConnection(target));
  return new EngineJsonRpcClient(
    new ReconnectingSocketIo(socketPath, open),
    undefined,
    options.identity ?? null,
    options.callerCeilingMs ?? CALLER_VISIBLE_CEILING_MS,
  );
}

/**
 * Build a client over an existing LineIo (used by tests with a fake
 * transport and by non-socket connectivity).
 */
export function engineClientOver(io: LineIo, timeoutMs?: number): EngineJsonRpcClient {
  return new EngineJsonRpcClient(io, timeoutMs);
}
