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
import {
  GP_E_ENGINE_TIMEOUT,
  GP_E_ENGINE_UNREACHABLE,
  GP_E_PAYLOAD_TOO_LARGE,
  GP_E_UNKNOWN,
} from "./errors.js";

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
 * Where this shell connects when nothing was named, in order: `GLASSPANE_ENGINE_SOCK`
 * (the env var {@link ENGINE_SOCKET_ENV} spells), then the explicit
 * `--socket-path` this shell's own CLI accepts, then the fallback below.
 *
 * The fallback is a **guess made from `$HOME`**, and it is worth being exact
 * about which guess: `os.homedir()` reads `$HOME`, while the daemon's own
 * default is `StateRoot.homeDefault()` = `NSHomeDirectory() + "/.glasspane"`,
 * which on macOS does **not** consult `$HOME` — the same non-inheritance that
 * has already cost this project real data, and the reason a caller cannot
 * isolate a run by exporting `HOME`. So in a process whose `$HOME` points into
 * a sandbox the two sides resolve **different directories**: this shell goes
 * looking for `$HOME/.glasspane/engine.sock` inside the sandbox while the daemon
 * is still serving only the socket under the real home. Nor is there a third
 * case to cover by guessing better — a daemon started with `--state-dir <root>`
 * listens on `<root>/daemon.sock`, which no value of `$HOME` points at.
 *
 * The reliable route is therefore to stop deriving and to say which socket: set
 * `GLASSPANE_ENGINE_SOCK`, or pass `--socket-path`. The installer's launchd job
 * hands the daemon an explicit `--socket-path` already, which is what makes an
 * installed pair agree — so read that value back rather than recomputing it;
 * this shell's `--help` gives the command.
 *
 * Deliberately not "fixed" by asking the daemon: before a connection exists
 * there is no daemon to ask, and `hello` is itself answered after connecting.
 *
 * R8-中9, and read this before "harmonising" it with `systemHome()`: matching the
 * daemon's lookup from Node **is** available — `os.userInfo().homedir` reads the
 * user record, the same source `NSHomeDirectory()` uses, no FFI needed, and
 * `project-registry.ts`'s `systemHome()` does exactly that. This function
 * deliberately does not. The two files sit on opposite sides of a safety
 * question:
 *   - `projects.json` is *our* data: naming a file the daemon cannot load turns
 *     a write into a stray, so it must follow the daemon's rule.
 *   - the engine socket is *the user's screen*: a process that pointed `$HOME`
 *     somewhere private as its own isolation boundary currently fails to connect
 *     ("nothing is listening on the guessed path", an honest refusal). Resolve
 *     the home the daemon's way here and that same process silently drives the
 *     live daemon — clicks, state writes, the whole act surface — against a
 *     machine it asked not to be on. `$HOME`-redirect is not a supported way to
 *     isolate from a daemon (name the socket, or don't), but it must not be
 *     upgraded into a way to reach it either.
 *
 * `test/engine-client.test.mjs` pins both halves of that split, so changing
 * either side is a deliberate edit against a red test rather than a cleanup.
 *
 * Single source all the same: the CLI argument parser in index.ts and the
 * reconnecting transport both resolve the path through this function, so an env
 * override cannot be honoured on one side only.
 */
export function defaultSocketPath(): string {
  return process.env[ENGINE_SOCKET_ENV] ?? path.join(os.homedir(), ".glasspane", "engine.sock");
}

/** Fallback deadline for a method missing from the table below. */
export const ENGINE_TIMEOUT_MS = 10_000;

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
 *
 * `probe_status` is deliberately *not* "the cheap call, so give it the shortest
 * window". The daemon answers one request at a time, so a probe is queued
 * behind whatever the agent is standing over, and {@link slowEngineRemedy}
 * tells the agent to send exactly this probe *while an `act` is outstanding*. A
 * probe with a shorter window than the request in front of it expires against a
 * busy daemon, and the agent then reads "the probe timed out too" as permission
 * to restart — which cancels and rolls back an action mid-flight on the user's
 * screen. It gets the full client-safe wait so the busy-but-will-finish case is
 * answerable at all; the case where it is not (`act` up to 120 s against a 50 s
 * ceiling — no deadline here can cover it, since the ceiling is the client's
 * patience, not the daemon's) is what
 * {@link livenessProbeDecision}'s `timed-out` entry exists to disarm.
 * `test/probe-liveness.test.mjs` pins both halves: the armed timer, and the
 * arithmetic invariant that no method can outlive the probe meant to diagnose it.
 */
export const ENGINE_DEADLINES_MS = {
  // `hello` is at the bottom of this table, where its reason is written out.
  attach: 30_000,
  act: 120_000,
  observe: 45_000,
  assert_element: 60_000,
  diagnose: 30_000,
  last_evidence: 60_000,
  snapshot: 90_000,
  probe_status: CALLER_VISIBLE_CEILING_MS,
  // R8b-高4: the same trap as `probe_status`, one layer down. `handshake()` is
  // fired by the transport's `connect` event, but `ReconnectingSocketIo` is lazy:
  // the frame that *causes* the connection is written first, so when a session's
  // very first request is an `act`, `hello` is queued behind it. At 15 s the
  // handshake expired against a healthy daemon every time, R4-06's protocol and
  // version comparison never ran, and the only trace was one stderr line — a
  // silent loss of the one measurement that catches "an old daemon is under this
  // shell". It gets the full client wait so the comparison happens.
  hello: CALLER_VISIBLE_CEILING_MS,
  shutdown: 15_000,
  // R8-中5: these two used to ride `ENGINE_TIMEOUT_MS * 3` by omission, which is
  // a deadline nobody derived from the daemon. Both are on the wire
  // (`gp_audit_ui` forwards `audit_ui`; `gp_capture_view` calls `capture_view`
  // from its own executor), and `test/method-table.test.mjs` now refuses any
  // sent method that is missing here.
  //
  // `audit_ui` is one geometry snapshot walk (`AXChannel.geometrySnapshot`,
  // capped by `AXChannel.treeTimeoutSeconds` = 10 s) plus a pure-geometry
  // overlap scan. It rides `observe`'s number rather than a fresh guess: same
  // tree walk, without observe's pixel round trip.
  audit_ui: 45_000,
  // `capture_view` is attach + `SCKCapturer.captureWindow` + PNG encode. The
  // capture tries up to two candidate surfaces at `captureTimeoutSeconds` = 5 s
  // each (R6-11 made the second candidate conditional, so two attempts is the
  // real worst case), then encodes inside the frame budget.
  capture_view: 30_000,
} as const;

/** Fixed part of an ffwd restore deadline (per-step cost is `act` above). */
export const RESTORE_BASE_DEADLINE_MS = 30_000;

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

/** When the caller gets its answer for `method`: its deadline, capped. */
export function callerDeadlineMs(
  method: string,
  params?: Record<string, unknown>,
  ceilingMs: number = CALLER_VISIBLE_CEILING_MS,
): number {
  return Math.min(engineDeadlineMs(method, params), ceilingMs);
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

/**
 * Shell-side failure codes live in `errors.ts` with the rest of the agent-facing
 * vocabulary (X-15); this file used to declare them locally, which left
 * `GP_E_ENGINE_TIMEOUT` spelled in two places with only a comment keeping them
 * together.
 */

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

/**
 * What an agent can learn from a `gp_probe_status` it sent while another call is
 * outstanding, and — the part that was wrong before — what each answer
 * authorises.
 *
 * R8-高1: the sentence this replaces told the agent to "restart only if
 * gp_probe_status times out too". The daemon serves **one request at a time**,
 * so a probe is queued behind the very request it is meant to diagnose: against
 * a busy daemon "the probe timed out as well" is the *expected* answer, not
 * evidence of death. Following it therefore meant running `--restore-launchd`
 * against a daemon that is mid-`act` on the user's screen — and SIGTERM makes
 * that daemon cancel and roll back the in-flight action (`main.swift`'s early
 * shutdown path). A liveness check whose failure branch is reached exactly when
 * the thing it checks is alive is not a check. Only a transport outcome can tell
 * "gone" from "busy", so every outcome now states its own decision, and
 * `test/probe-liveness.test.mjs` pins that exactly one of them may name the
 * restore command.
 */
export type LivenessProbeOutcome = "answered" | "engine-error" | "timed-out" | "unreachable";

/** Every outcome the four sentences below cover; the gate iterates this list. */
export const LIVENESS_PROBE_OUTCOMES: readonly LivenessProbeOutcome[] = [
  "answered",
  "engine-error",
  "timed-out",
  "unreachable",
];

/**
 * The decision for one probe outcome. There is no `default` on purpose: adding
 * an outcome to {@link LIVENESS_PROBE_OUTCOMES} without deciding what it
 * authorises is a compile error rather than a silent hole.
 *
 * Only `unreachable` may name the restore command, because only it is raised
 * when the socket itself is gone ({@link GP_E_ENGINE_UNREACHABLE}); `timed-out`
 * is {@link GP_E_ENGINE_TIMEOUT}, which by construction means "no answer yet".
 * The lookup is a function, not a frozen object, so the filesystem probe inside
 * `daemonUnreachableRemedy()` stays out of module initialisation.
 */
export function livenessProbeDecision(outcome: LivenessProbeOutcome): string {
  switch (outcome) {
    case "answered":
      return "answered at all (a result or an engine error frame) => the daemon is alive and has worked its way past the request in front of yours: keep waiting, the outstanding call's reply is still attributed and recorded";
    case "engine-error":
      return "answered with a named engine error code => the daemon is alive, so this answer never means \"restart the daemon because it is wedged\"; follow that code's own remedy instead, and note that some codes genuinely do name a restart (`GP_E_AX_UNAVAILABLE` does, because a wedged Accessibility API needs the service recycled) — that is the daemon's decision to make, not this sentence's";
    case "timed-out":
      return `not answered within its own window => NOT evidence that the daemon is down: it is single-connection and still busy with the earlier request (this is ${GP_E_ENGINE_TIMEOUT}, and the request stays registered so the real reply is attributed when it lands). Keep waiting; do not run the restore command on this answer alone, because restarting cancels and rolls back an action that is mid-flight on the user's screen`;
    case "unreachable":
      return `${GP_E_ENGINE_UNREACHABLE} (nothing is listening, or the transport died) => this is the one answer that justifies touching the daemon's lifecycle: ${daemonUnreachableRemedy()}`;
  }
}

/** The four probe decisions, rendered into one clause for a remedy. */
function livenessProbeGuide(): string {
  return LIVENESS_PROBE_OUTCOMES
    .map((outcome) => `${outcome} — ${livenessProbeDecision(outcome)}`)
    .join("; ");
}

/**
 * Which way into this shell an answer is being delivered to. The two surfaces
 * hold different state: only the MCP stdio server has an
 * `EvidenceAuditSession`, so only it can promise that a late reply's
 * operationId will come back through `gp_recent_reports`. Promising that to a
 * `curl` caller of the HTTP gateway sends it to a tool that route does not even
 * expose (`POST /v1/tools/recent_reports` is a 404 — `FORWARDABLE_TOOLS` skips
 * every tool with its own `execute`), so each surface gets the sentence about
 * the state it really has (R8b-高3).
 */
export type ShellSurface = "mcp" | "http";

/** Where the answer to a timed-out request can be found, per surface. */
export function lateReplyRoute(surface: ShellSurface): string {
  return surface === "mcp"
    ? "the original reply, when it lands, is written to this server's log (stderr) *and* its operationId is recorded "
      + "in this session's trail, so a later gp_recent_reports lists the operation that ran instead of telling you to "
      + "run it again — **while this server still tracks the request**: the window is bounded ("
      + LATE_REPLY_RETENTION + " timed-out requests, and an eviction is logged), a re-attach in between supersedes it "
      + "(also logged, with the operationIds it dropped), and if this process has exited nothing will be recorded at all"
    : "the original reply, when it lands, is written to this gateway's stderr with its body, so the operationId it "
      + "carries can be read off that line and fetched with GET /v1/evidence/<operationId> — the tracking window is "
      + "bounded (" + LATE_REPLY_RETENTION + " timed-out requests, and an eviction is logged), and this gateway keeps "
      + "no operation trail of its own";
}

/**
 * Remedy for a deadline overrun: wait and measure, never restart on a probe that
 * merely went unanswered, and never replay a user-visible action.
 */
export function slowEngineRemedy(method: string, surface: ShellSurface = "mcp"): string {
  // "goes out immediately" is a property of the *client*, not of this shell: the
  // shell will not queue one MCP request behind another, but a client that
  // serialises its own tool calls cannot send the probe until the outstanding
  // request has been answered — and then `answered`/`engine-error` are
  // unreachable and only `timed-out` can occur. Wording it as a conditional
  // keeps the guidance executable without asserting an unmeasured fact about
  // whoever is reading it (R8b-低).
  const poll = "if your client can send a second request while this one is still outstanding, confirm the daemon is alive with a cheap call: the shell does not queue one MCP request behind another, so gp_probe_status goes out at once and is answered as soon as the daemon is free of the request in front of it. Read its answer as: "
    + livenessProbeGuide();
  const restarted = livenessProbeDecision("unreachable");
  if (REPLAY_UNSAFE_METHODS.has(method)) {
    return `${poll}. The daemon serves one request at a time and is still working on this one, so wait for it; do NOT re-issue ${method}, because the original action can still take effect on the user's screen — ${lateReplyRoute(surface)}. Only ${restarted}`;
  }
  if (method === "probe_status") {
    return `the liveness probe itself has not been answered, and it is given the longest wait this shell allows any request (${CALLER_VISIBLE_CEILING_MS}ms), so this particular answer carries no information about whether the daemon is alive: the daemon is single-connection and is still working on the request in front of this probe. ${livenessProbeDecision("timed-out")}. Keep waiting instead — the outstanding call's reply is attributed when it lands, and ${lateReplyRoute(surface)}. If the daemon's socket really is gone, the next call answers with ${GP_E_ENGINE_UNREACHABLE}, and that remedy names the restore command.`;
  }
  return `${poll}. The daemon serves one request at a time and is still working on this one, so wait, then retry this read narrower (smaller maxDepth / a tighter selector) — that is safe for a read; a restart is authorised only by ${restarted}`;
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
  /**
   * Opaque number handed in by whoever made the call and echoed back to the
   * late-reply sink. This client never interprets it — the shell's caller uses it
   * as the audit-trail generation the request was admitted under, so a reply
   * that lands after a re-attach can be told apart from one that belongs to the
   * trail it would otherwise be written into (R8b-高1).
   */
  correlation?: number;
  /** The request's own params: the only honest basis for "narrow this". */
  params?: Record<string, unknown>;
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

/** One late engine reply, as handed to {@link EngineJsonRpcClient.onLateReply}. */
export interface LateReply {
  method: string;
  result: unknown;
  /** Whatever `call()` was given; see {@link Pending.correlation}. */
  correlation?: number;
}

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
  private lateReplyHandler: ((reply: LateReply) => void) | null = null;

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
    /** Whom a timeout's remedy is being written for; see {@link ShellSurface}. */
    private readonly surface: ShellSurface = "mcp",
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

  /**
   * Sink for the *body* of a reply that lands after its caller was already
   * answered (R8-高3). Logging it is not enough: the operationId in that frame
   * is the only thing that puts the operation into this session's evidence
   * trail, and without it `gp_recent_reports` answers
   * `GP_E_NO_EVIDENCE ... run gp_act first` for an act that genuinely ran and
   * genuinely mutated the user's screen — an agent reading that answer clicks
   * again. The entry the reply is attributed to is only kept for
   * `LATE_REPLY_RETENTION` requests, so this sink sees the tracked window and
   * the eviction note says when something fell outside it.
   */
  onLateReply(handler: (reply: LateReply) => void): void {
    this.lateReplyHandler = handler;
  }

  /**
   * Send a request and await its matching response frame. `correlation` is
   * echoed to {@link onLateReply} if this request is answered after its caller
   * has already been given a timeout; it is otherwise unused by this client.
   */
  call(method: string, params?: Record<string, unknown>, correlation?: number): Promise<unknown> {
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
        correlation,
        params,
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
      slowEngineRemedy(entry.method, this.surface),
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
      "narrow this request or ask for less of it; the tool's own schema names the parameters that can "
      + "shrink a reply, and this shell rewrites this line into that advice when it can (the transport "
      + "layer deliberately does not guess them)",
    ), entry, inferred));
  }

  private engineError(body: Partial<EngineErrorBody>): EngineCallError {
    return new EngineCallError(
      String(body.code ?? GP_E_UNKNOWN),
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
    if (frame.error || frame.result === undefined) {
      // An error answer carries no operationId to record, and a frame with
      // neither `result` nor `error` is not an answer this sink can use.
      return;
    }
    const handler = this.lateReplyHandler;
    if (handler === null) {
      return;
    }
    try {
      handler({ method: entry.method, result: frame.result, correlation: entry.correlation });
    } catch (error) {
      // The reply has already been logged above; a sink that throws must not
      // lose that fact, and must not be allowed to take the transport down.
      this.report(`the late-reply sink failed for '${entry.method}' (id ${entry.id}): ${String(error)}`);
    }
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
    /** Pass `"http"` from the gateway: its callers have no operation trail. */
    surface?: ShellSurface;
  } = {},
): EngineJsonRpcClient {
  const open: EngineTransportOpener = options.open
    ?? ((target) => net.createConnection(target));
  return new EngineJsonRpcClient(
    new ReconnectingSocketIo(socketPath, open),
    undefined,
    options.identity ?? null,
    options.callerCeilingMs ?? CALLER_VISIBLE_CEILING_MS,
    options.surface ?? "mcp",
  );
}

/**
 * Build a client over an existing LineIo (used by tests with a fake
 * transport and by non-socket connectivity).
 */
export function engineClientOver(io: LineIo, timeoutMs?: number): EngineJsonRpcClient {
  return new EngineJsonRpcClient(io, timeoutMs);
}
