import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
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
  GP_E_ENGINE_BACKLOG,
  GP_E_ENGINE_TIMEOUT,
  GP_E_ENGINE_UNREACHABLE,
  GP_E_INTERNAL,
  GP_E_PAYLOAD_TOO_LARGE,
  GP_E_SOCKET_TRUST,
  GP_E_UNKNOWN,
  quoteShellArg,
} from "./errors.js";

/**
 * The daemon-lifecycle half of the unreachable answer, *without* the ", then
 * retry" tail.
 *
 * It exists because the tail is a separate claim from the command. The command
 * is what only a transport outcome may say at all ({@link
 * livenessProbeDecision}'s `unreachable` arm, pinned by
 * `test/probe-liveness.test.mjs`); "…, then retry" is an instruction to put a
 * second copy of the request on the wire, and for a request that already left
 * this shell that is exactly the re-issue {@link REPLAY_UNSAFE_REASONS},
 * {@link STATE_CHANGING_ON_RETRY_METHOD_NAMES}, {@link slowEngineRemedy},
 * {@link noRemedyFallback} and {@link clientClosingRemedy} all exist to refuse.
 * Keeping the two in one string is how the refusal got written on one face of
 * this file and left standing on another: {@link transportDeathRemedy} needs the
 * command alone, and every caller that wants the pair calls
 * {@link daemonUnreachableRemedy}, whose bytes are that command plus the tail.
 */
function daemonRestoreCommand(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const installerCli = path.resolve(here, "..", "..", "installer", "cli.js");
  if (fs.existsSync(installerCli)) {
    return `run \`node ${quoteShellArg(installerCli)} --restore-launchd\` (auto-restores and verifies the launchd-managed daemon)`;
  }
  return "ensure the glasspane daemon is running (launchd job com.glasspane.daemon; in a repo checkout run `node installer/cli.js --restore-launchd`)";
}

/**
 * Agent-actionable remedy for an unreachable daemon (P6 §11 audit items ④/⑥:
 * a remedy must be an executable command, not a prose hint). When the repo
 * installer is present next to this build, hand over the machine-verified
 * restore command: it detects a boot-out'd launchd job, bootstraps it, and
 * verifies the daemon's hello self-report — the only remaining human action
 * (TCC checkbox) stays honest. Falls back to generic wording otherwise.
 *
 * The ", then retry" tail belongs here and only here: every caller of this
 * function is an answer for a request that did *not* go out (the write failed,
 * {@link EngineJsonRpcClient.call}'s catch, or no request was in flight at all),
 * so nothing can be performed twice by following it. A request that was already
 * on the wire when the transport died gets {@link transportDeathRemedy}, which
 * keeps the command and drops the tail for the methods whose re-issue is the
 * harm.
 */
export function daemonUnreachableRemedy(): string {
  return `${daemonRestoreCommand()}, then retry`;
}

/** Env override for the daemon socket path (default below). */
export const ENGINE_SOCKET_ENV = "GLASSPANE_ENGINE_SOCK";

/** The launchd job this product installs — remedies name it so an agent can read the running job. */
export const LAUNCHD_JOB_LABEL = "com.glasspane.daemon";

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
 *
 * A **blank** override is not an override. `GLASSPANE_ENGINE_SOCK=""` — which is
 * what `export FOO=` and a launcher that means "unset" actually put in the
 * environment — is not nullish, so honouring it literally sends `""` to
 * `net.connect`. Measured on the delivered artifact: `gp_probe_status` answered
 * `GP_E_ENGINE_UNREACHABLE` carrying Node's internals ("Port should be >= 0 and <
 * 65536. Received type string ('')"), and the remedy fell back to the generic
 * "restart the daemon" wording, i.e. the answer *invented a daemon fault* out of a
 * variable the shell was never given. Empty-and-whitespace-only reads as "no name
 * here", which is what the fallback guess is for; the CLI flag spelling of the same
 * empty value is refused instead, because there an operator is naming a socket in
 * this command line and dropping it silently would connect them to one they did not
 * choose (`index.ts`, `http-gateway-cli.ts`).
 */
export function defaultSocketPath(): string {
  const named = socketOverride(process.env[ENGINE_SOCKET_ENV]);
  if (named === null) {
    return homeDefaultSocketPath();
  }
  return named;
}

/**
 * The socket the engine binds when *nothing* names one — the home default, read straight from
 * the passwd-independent `os.homedir()` guess the daemon falls back to.
 *
 * Separate from `defaultSocketPath()` because a remedy that says "the default is X" must name
 * the default even while `GLASSPANE_ENGINE_SOCK` is set to something else: echoing the override
 * back as the default would tell the reader its own mistake is the engine's behaviour. This is
 * also the one place `$HOME` is spelled for the socket, which `engine-client.test.mjs` counts.
 */
export function homeDefaultSocketPath(): string {
  return path.join(os.homedir(), ".glasspane", "engine.sock");
}

/**
 * The env override that actually names a socket, or `null` when it names nothing.
 *
 * `true`-for-blank is written as "returns the value or `null`" rather than as a
 * `boolean` predicate because the caller has to carry the value onward, and a
 * `boolean` helper leaves TypeScript unable to see that the surviving case is a
 * string — the shape of this decision is not something a caller should be cast
 * around.
 *
 * The value is *not* trimmed on the way out: a real path may contain spaces, and
 * `/tmp/ a.sock` is somebody's socket. This only decides whether the value says
 * anything at all. It is the single spelling of that rule so the env override and
 * the CLI flag check (`refuseEmptySocketPath`) cannot drift into disagreeing about
 * what "no socket named" means.
 */
export function socketOverride(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  return value;
}

/**
 * Refuse a `--socket-path` that names nothing, as the usage error it is.
 *
 * The opposite of the env rule above, deliberately: a variable somebody exported
 * can only say "no name here", and the fallback guess is what answers that; a flag
 * on this command line is an operator *naming a socket*, and dropping the name they
 * typed would leave this process bridging a daemon they did not choose. And `""` is
 * not merely a path that does not exist — `net.connect("")` fails its own argument
 * validation ("Port should be >= 0 and < 65536. Received type string ('')"), which
 * arrives dressed as `GP_E_ENGINE_UNREACHABLE` with generic restart wording.
 *
 * Only the truly empty value is refused. A path of spaces is a path (`/tmp/ .sock`
 * exists on a POSIX filesystem), and the honest answer for one that does not exist
 * is the ENOENT this shell already reports, not a usage error invented here.
 */
export function refuseEmptySocketPath(value: string, flag: string): void {
  if (value === "") {
    throw new Error(
      `${flag} requires a value: an empty path is not a socket, and this shell will not connect to it. `
      + `Pass ${flag} <path> with the socket the daemon is really on (the usage below gives the command that reads `
      + `it), or drop the flag and let this shell use ${ENGINE_SOCKET_ENV} or its own fallback guess`,
    );
  }
}

/**
 * The stat facts {@link trustSocket} needs, as a type so a test can hand it a real
 * socket it made unreachable-by-permission without needing a second account.
 */
export type SocketEvidence = Pick<fs.Stats, "uid" | "mode" | "isSocket">;

/**
 * May this path carry the engine's word? `null` means yes; anything else is a
 * three-field refusal to be handed to the caller before a single byte is written.
 *
 * Why this exists at all: the engine socket is owner-only (`chmod 0600`) and carries **no peer
 * authentication** (SECURITY.md — same uid = full authority), so the socket *path* is what makes
 * a reply mean anything. `GLASSPANE_ENGINE_SOCK` therefore is a trust root, not just a location:
 * whatever this function lets through is a thing whose answers this shell renders as the engine's
 * verified word, evidence pack included. Four facts disqualify a path:
 *  - the runtime cannot say which account it is running as, so ownership is unaskable;
 *  - the leaf is not a socket — a plain file planted there must be named as such instead of
 *    producing a connect error that reads like "the daemon is down";
 *  - the leaf or the directory holding it belongs to another uid, so this account did not place
 *    it there;
 *  - either carries a **write** bit for group or other. Write is the bit that matters: on a
 *    socket it grants the ability to send, on a directory the ability to create or replace the
 *    entry. Execute-only for others (`0755` — which is what a listener created by node itself
 *    carries before any chmod, measured on this machine) lets a reader look, not talk, so the
 *    daemon's own socket passes. A listener granting `0666` is advertising itself to the machine.
 *
 * `ENOENT` deliberately returns `null`: no file at the path is the daemon-not-running case, which
 * the transport already renders as `GP_E_ENGINE_UNREACHABLE` with the restart command. Turning it
 * into a trust refusal here would rename a known condition and break the remedy an agent is
 * supposed to copy. A stat that fails for any **other** reason is a refusal, because "could not
 * ask" is not evidence of trust.
 *
 * `read` and `euid` are seams, not abstractions: the other-account branches cannot be produced by
 * an unprivileged test process, and a check whose only exercised path is the friendly one has not
 * been checked. Everything else runs against a real socket on a real filesystem.
 */
export function trustSocket(
  target: string,
  read: (p: string) => SocketEvidence = (p) => fs.statSync(p),
  euid: number | null = process.geteuid?.() ?? null,
): { code: string; message: string; remedy: string } | null {
  const refusal = (message: string, remedy: string) => ({ code: GP_E_SOCKET_TRUST, message, remedy });
  // A trust refusal measures the *path*, not the daemon's liveness, so it must never order a
  // lifecycle action: `livenessProbeDecision` reserves the right to name a restart for
  // `GP_E_ENGINE_UNREACHABLE` alone, and kicking a service that is mid-`act` on the user's
  // screen is exactly the harm that rule exists to prevent. `launchctl print` is the read-only
  // twin — it shows the running job's own arguments, which is how an agent finds the root the
  // engine really bound.
  const job = "`launchctl print gui/$(id -u)/" + LAUNCHD_JOB_LABEL + "`";

  if (euid === null) {
    return refusal(
      `this runtime answers no geteuid(), so it cannot say whether the engine socket at ${target} belongs to `
      + "the account running it",
      "run this shell under node on macOS (the platform this product ships on); the check is "
      + "`node -e \"console.log(process.geteuid())\"` — it must print a number",
    );
  }

  let socket: SocketEvidence;
  try {
    socket = read(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return refusal(
      `the engine socket at ${target} could not be inspected (${(error as NodeJS.ErrnoException).code ?? "unknown error"}), `
      + "so this process cannot say whether the thing listening there is the engine",
      `make the path stat-able (\`ls -ld ${quoteShellArg(target)}\`); ${job} reads the running job's own arguments, `
      + "which is how to find the socket the engine actually bound — nothing is restarted by this answer",
    );
  }

  if (!socket.isSocket()) {
    return refusal(
      `${target} is not a socket, so nothing can answer as the engine from it`,
      `see what is really at that path with \`ls -l ${quoteShellArg(target)}\`, then point ${ENGINE_SOCKET_ENV} at the socket `
      + `the engine binds (default ${homeDefaultSocketPath()}); ${job} reads the `
      + "running job's arguments and is the way to check that root without restarting anything",
    );
  }

  const directory = path.dirname(target);
  let dir: SocketEvidence;
  try {
    dir = read(directory);
  } catch (error) {
    return refusal(
      `the directory holding the engine socket (${directory}) could not be inspected `
      + `(${(error as NodeJS.ErrnoException).code ?? "unknown error"}), so this process cannot say who may replace ${target}`,
      `make it readable with \`ls -ld ${quoteShellArg(directory)}\`; ${job} prints the root the job really runs under, `
      + "and this answer authorises no restart",
    );
  }

  for (const [entry, place, kind] of [
    [socket, target, "socket"],
    [dir, directory, "directory"],
  ] as const) {
    if (entry.uid === euid) continue;
    return refusal(
      `the engine ${kind} ${place} belongs to uid ${entry.uid}, not to this process (uid ${euid}), so whatever listens `
      + "there was not placed there by this account",
      `run this shell as the account that owns \`glasspaned\`, or point ${ENGINE_SOCKET_ENV} at the socket that account `
      + `bound (default ${homeDefaultSocketPath()}); check the owner with `
      + `\`ls -ld ${quoteShellArg(place)}\``,
    );
  }

  if (socket.mode & 0o022) {
    return refusal(
      `the engine socket ${target} carries mode ${(socket.mode & 0o7777).toString(8)}, which lets another account send `
      + "requests to it — an answer from there is not evidence of what the engine said",
      `tighten it to owner-only with \`chmod 600 ${quoteShellArg(target)}\` — that is the mode the engine binds with; `
      + `to confirm the socket belongs to the service rather than to someone else, read \`ls -l ${quoteShellArg(target)}\``,
    );
  }
  if (dir.mode & 0o022) {
    return refusal(
      `the directory holding the engine socket (${directory}) carries mode ${(dir.mode & 0o7777).toString(8)}, so another `
      + `account can create or replace ${target}; this process cannot tell the engine's socket from one planted next to it`,
      `make it owner-only with \`chmod 700 ${quoteShellArg(directory)}\`; ${job} prints the state root the job really uses, `
      + "and no restart is authorised by this answer",
    );
  }
  return null;
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
 * answering early — the only thing that ends that registration is the transport
 * going away, and `teardown` logs the tracked requests it drops when it does —
 * which is what makes the multi-minute deadlines above safe to cap: they
 * describe the daemon, not the caller's wait.
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

/**
 * Methods that must not be re-issued after their caller was answered early,
 * each with the reason it is unsafe.
 *
 * `attach` belongs here with `act` and `restore` (R9-中3). The one sentence this
 * replaces called every other method "a read" and told its caller to retry it,
 * which for `attach` ordered an agent to re-perform a request that is still
 * running: attach is a daemon-state change, and when the attached app changes the
 * daemon discards the evidence history the outstanding request is being recorded
 * in (`tools.ts`' trail-ordering note names that condition). Re-issuing it can
 * therefore erase the record of an operation that has not answered yet.
 */
const REPLAY_UNSAFE_REASONS: Readonly<Record<string, string>> = {
  act: "the original action can still take effect on the user's screen",
  restore: "the original replay can still take effect on the user's screen, step by step",
  attach: "the original attach can still re-point the daemon at another app and, when that changes the attached app, discard the trail the request that has not answered yet is being recorded in",
};

/**
 * The single answer to "will re-issuing this method perform a change the daemon may
 * already have carried out?". Exported because two other layers have to ask it —
 * `tools.ts` when it rewrites an oversized reply, `http-gateway.ts` when it answers
 * a curl caller — and a membership list copied into each of them is how the advice
 * for one tool drifts back into "just retry the click". A caller that wants the
 * *reason* per method owns that text; membership comes from here.
 */
export function isReplayUnsafeMethod(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(REPLAY_UNSAFE_REASONS, method);
}

/** The non-replayable methods, for gates that must see the set change on purpose. */
export const REPLAY_UNSAFE_METHOD_NAMES: readonly string[] = Object.keys(REPLAY_UNSAFE_REASONS);

/**
 * The answer this shell gives when the daemon's error frame carries no remedy at all.
 *
 * It used to be one sentence for every method — "check the daemon log (stderr) and retry" —
 * which made the transport order by words the re-send it refuses by behaviour: `act`,
 * `restore` and `attach` are the methods {@link REPLAY_UNSAFE_REASONS} exists to keep off
 * the wire a second time, `slowEngineRemedy` says *do NOT re-issue* for them, and
 * `writeBacklogRemedy` refuses even to name a probe while one is outstanding. An error
 * frame is the daemon's answer to *this* request, so the request did reach the service —
 * and whether the change took effect before the error was raised is a thing no error frame
 * says, which is exactly why the sentence may not spend that unknown on a second copy.
 * `snapshot` is the third case and the one a blanket "retry" also got wrong: nothing is
 * pressed twice, but every accepted copy writes another entry into the daemon's bounded
 * ring and can evict the baseline an earlier snapshot returned — the one a later restore
 * still needs. Membership comes from the two lists this file already keeps, so a method
 * moving between them moves this answer with it.
 *
 * `null` is the unattributed case: an id-less frame this client could not tie to a request
 * it still tracks, where naming a method would be a guess and authorising a re-send on top
 * of the guess would be worse.
 */
export function noRemedyFallback(method: string | null): string {
  const readTheLog = "the engine sent no remedy for this error code, and the daemon's own log (stderr) is the only "
    + "side that can say what it refused; this shell cannot see past the frame it was handed";
  if (method === null) {
    return `${readTheLog}. This frame was not attributed to a request this client still tracks, so nothing here says `
      + "which method it answers, and this line authorises no re-send";
  }
  const unsafe = REPLAY_UNSAFE_REASONS[method];
  if (unsafe !== undefined) {
    return `${readTheLog}. Do not re-issue '${method}' on the strength of this answer: the frame is proof the `
      + "request reached the daemon, and no error frame says whether the change took effect before it was raised — "
      + `this shell never replays it on its own either, because ${unsafe}`;
  }
  if (STATE_CHANGING_ON_RETRY_METHOD_NAMES.includes(method)) {
    return `${readTheLog}. A second '${method}' is not a cheaper copy of the first: it writes daemon state again, `
      + "the snapshot ring the daemon keeps is bounded, and one more entry can evict the baseline an earlier "
      + "snapshot returned — the one a later restore still needs. Read what the first answer said before asking "
      + "for another";
  }
  return `${readTheLog}, and a retry is the plain next step: '${method}' is not a method this shell refuses to `
    + "replay, so nothing is performed twice. Change what the request carries if a different answer is wanted — "
    + "nothing here says the daemon will answer this one differently";
}

/**
 * `hello.capabilities` 的第一个读者（2026-10-11）。
 *
 * 这份清单由 daemon 从 `EngineMethod` 派生（`FrameCodec.capabilityWireNames`），可此前
 * **没有任何一方读它**：面板的解析器只取 version/protocolVersion/pid/identity/permissions，
 * 这一层只比 protocolVersion。没有读者就等于没有镜像——三处真源（kernel schema、daemon 方法表、
 * 本壳的 TOOL_SPECS）漂了也不会有人说一句，而"清单存在但没人核"正是这份代码在别处反复拒绝的
 * 那种自证。返回 null 表示无话可说（两边一致），否则给出要说的那句话。
 */
export function describeCapabilityDrift(
  advertised: readonly string[] | null,
  forwarded: readonly string[],
): string | null {
  if (advertised === null) {
    return "engine self-report carries no capabilities list, so this shell cannot say which daemon methods it measured; every tool result in this session is unverified against the daemon's own method table (an engine older than the capability list, or a hello that was cut short)";
  }
  const missing = forwarded.filter((method) => !advertised.includes(method));
  const unexposed = advertised.filter((method) => !forwarded.includes(method));
  if (missing.length === 0 && unexposed.length === 0) {
    return null;
  }
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`this shell forwards ${missing.join(", ")} but the daemon's hello does not list it/them — that call will be answered methodNotFound, so the tool surface and the engine method table have drifted`);
  }
  if (unexposed.length > 0) {
    parts.push(`the daemon offers ${unexposed.join(", ")} which this shell does not expose as a tool — not an error, but the agent cannot reach it from MCP`);
  }
  return `capability reconciliation: ${parts.join("; ")}`;
}

/**
 * replaying them is not unsafe in the sense {@link REPLAY_UNSAFE_REASONS} means
 * (no operation of the user's is performed a second time). They are the other half
 * of the answer to "may this be narrowed by sending it again?", and they are kept
 * apart from the set above because `test/probe-liveness.test.mjs` pins that set's
 * membership as the no-replay judgement.
 *
 * `snapshot` is here because of a ring, not of a click: `storeSnapshot`
 * (`engine/Sources/GlassPaneEngine/EngineCore.swift:2070`) appends the new
 * baseline and then trims oldest-first to `EngineCore.snapshotHistoryLimit` (the
 * same file, line 25 — 8 entries). A `gp_snapshot` whose caller timed out may
 * therefore have been carried out already, and every re-send — "with a smaller
 * maxDepth", which is what the tool layer used to say — adds another entry that can
 * evict the baseline the caller's *own earlier* snapshot returned, the one
 * `gp_restore {snapshotId}` needs later. Evicting a caller's evidence to fetch a
 * cheaper copy of it is not narrowing.
 *
 * `attach` writes state too, and is already a replay-unsafe method; `tools.ts`
 * unions the two lists rather than repeating names here.
 */
export const STATE_CHANGING_ON_RETRY_METHOD_NAMES: readonly string[] = ["snapshot"];


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

/// 引擎 socket 上允许积压的字节数。超过就不再接受新调用。
/// 一帧的上限是 `MAX_FRAME_BYTES`，所以这个数约等于"允许排队 N 帧"——
/// 它不是性能调优，是一条"别替一个卡死的对端攒内存"的界线。
export const ENGINE_WRITE_BACKLOG_BYTES = 8 * 1024 * 1024;

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
      + "(also logged, with the operationIds it dropped), a transport that ends first is logged the same way with the "
      + "requests it stopped tracking, and if this process has exited nothing will be recorded at all"
    : "the original reply, when it lands, is written to this gateway's stderr with its body, so the operationId it "
      + "carries can be read off that line and fetched with GET /v1/evidence/<operationId> — the tracking window is "
      + "bounded (" + LATE_REPLY_RETENTION + " timed-out requests, and an eviction is logged, as is a transport that "
      + "ends before the reply lands), and this gateway keeps "
      + "no operation trail of its own";
}

/**
 * Where the question "what can be narrowed here?" is answered, per surface, in
 * words the caller of that surface can act on. This layer cannot quote the
 * answer: it holds one request's *params*, never the ranges those params
 * advertise, and a schema-free guess at a knob is exactly what
 * {@link reIssueGuidance} exists to stop.
 */
const NARROWING_AUTHORITY: Record<ShellSurface, string> = {
  mcp: "the gp_* tool that took this call publishes its own parameters, and their floors, in the schema shown beside "
    + "that tool — read it there, not here",
  http: "this gateway publishes no parameter listing of its own, so the floors a body was accepted against are in the "
    + "request contract this call was copied from",
};

/**
 * 背压闸的出路。两条禁令各由一条现场证据撑着：探针本身也要过一次 `call()`，会被
 * 同一道测量原地拒掉，所以旧文本那句"先用 gp_probe_status 查一下"是一件此刻做不到
 * 第二次的事；这里唯一测到的是**本进程**的字节水位，不是 daemon 的状态，而旧文本
 * 却挂了 GP_E_ENGINE_UNREACHABLE 那条重启命令——`livenessProbeDecision` 把点名生命
 * 周期命令的权力只留给 `unreachable`，换一个可能正跑着 act 的 service 会回滚用户屏
 * 幕上的动作。"每次重试都只会把队列堆得更深"同样不成立：拒绝发生在 `writeLine` 之前。
 */
export function writeBacklogRemedy(backlogBytes: number, limitBytes: number): string {
  return `this shell wrote nothing: ${backlogBytes} bytes — over this gate's ${limitBytes} — are queued in THIS `
    + "process for the engine socket, and the service accepted the connection and is not reading it. That is a fact "
    + "about this shell's buffer, not a diagnosis of why: one long operation and a service wedged solid look "
    + "identical from here, which is why this answer orders neither a restart nor a probe. Stop sending. Do not "
    + "retry this call in a loop: every attempt is refused by this same measurement, and a refusal writes no bytes, "
    + "so a loop moves only the clock, not the queue. What is already queued is the service's to read, so wait for "
    + "the backlog to drain and send again after that — this gate is re-measured per call, so the first call "
    + "accepted after the wait is the proof that it drained, and it is a first send rather than a second copy of an "
    + "action, because nothing went out the first time. While waiting, read the daemon's own log: it is the only "
    + "side that can say what it is stuck on, and this shell cannot see past its own buffer. For the service "
    + "installed by this repo's installer that log is `~/.glasspane/installer-daemon.log`, the file its stderr is "
    + "redirected into, in the same directory as the default socket; a daemon started by hand writes wherever its "
    + "operator pointed its stderr.";
}

/**
 * Where a caller of this surface can *read* what happened instead of performing
 * an action a second time. Split out of {@link clientClosingRemedy} because the
 * transport-death answer ({@link transportDeathRemedy}) needs the same route for
 * the same reason, and because the two surfaces do not hold the same state: only
 * the MCP stdio server has a trail, so only it can name tools that read one.
 * Naming `gp_recent_reports` to a `curl` caller sends it to `POST
 * /v1/tools/recent_reports`, which this gateway answers with a 404 — the same
 * mistake {@link lateReplyRoute} was split for (R8b-高3), and the reason this
 * text is per-surface rather than one sentence handed to both.
 */
function readInsteadRoute(surface: ShellSurface): string {
  return surface === "mcp"
    ? "gp_recent_reports lists the operations this session recorded, gp_last_evidence {operationId} returns one in "
      + "full, and gp_probe_status reads the daemon's own self-report on this same connection"
    : "this gateway keeps no operation trail of its own, so this process's stderr is the record, and the requests "
      + "this transport dropped are named there";
}

/**
 * What the answer to an *outstanding* request may say when this shell's own client
 * ends while the daemon is still working on it (finding 中-3).
 *
 * This rejection used to carry `daemonUnreachableRemedy()` — "run … --restore-launchd,
 * then retry" — on a routine shutdown, possibly with an `act` in flight. Two things
 * were wrong with that, and both are claims about authority rather than about tone:
 *  - the close measures nothing about the daemon, so it is not one of the answers
 *    that may name a lifecycle command. `livenessProbeDecision("unreachable")`
 *    reserves that for a transport outcome, and `test/probe-liveness.test.mjs`
 *    pins that exactly one probe outcome may name it; a shutdown is not it. A
 *    daemon SIGTERMed mid-`act` cancels and rolls the action back on the user's
 *    screen.
 *  - "then retry" orders the re-issue of a request whose re-issue is the harm this
 *    file spends the rest of its length refusing.
 *
 * What this layer does know is three things, and they are what the text says: the
 * client of this shell is ending, whether the daemon finished is unknown here, and
 * the reply may still land — under the bounded contract {@link lateReplyRoute}
 * spells, of which this close is itself one of the named endings.
 */
function clientClosingRemedy(surface: ShellSurface): string {
  const readRoute = readInsteadRoute(surface);
  return `this shell's own engine client is ending, which measures nothing about the daemon: nothing here authorises `
    + "touching the daemon's lifecycle, and no restart is authorised by this answer. What is unknown stays unknown: "
    + "whether the daemon finished this request cannot be told from a client that stopped asking. The reply may still "
    + `land, under the bound this shell already states — ${lateReplyRoute(surface)} — and this shutdown is one of the `
    + "endings that bound names: the server log line written at this moment lists the requests this client stopped "
    + `tracking. Read what happened rather than performing it a second time: ${readRoute}. Ask through a server `
    + "process that still has a live engine client.";
}

/**
 * What the message says about a request that was still in this process's own write queue
 * when its transport died ({@link EngineJsonRpcClient.teardown}).
 *
 * The lazy transport opens its socket on the first write, and a `net.Socket` that has not
 * reached `connect` accepts the frame into memory rather than onto a wire: `write()`
 * succeeds, `writableLength` still holds the bytes, and a `connect ECONNREFUSED` five
 * milliseconds later means the daemon was never sent anything. The reviewed answer said the
 * opposite — "this request had already left this shell when its transport died" — and the
 * consequence was not cosmetic: that sentence is *why* the no-reissue bans are given, so a
 * request nobody received was answered with the one instruction that is wrong for it (do
 * not retry), while the retry is exactly what is safe.
 */
const NEVER_LEFT_TRANSPORT = "the frame this request wrote never left this process — its bytes were still in "
  + "this client's own write queue when the transport went, so nothing reached the daemon and nothing was "
  + "performed there";

/**
 * The answer a *transport death* gives to one outstanding request, per method.
 *
 * {@link clientClosingRemedy} documents the defect this is the other face of: the
 * socket erroring or closing used to reject every request it had in flight with
 * the single {@link daemonUnreachableRemedy} — "…, then retry" — including the
 * `act` that had already gone out. The command half of that sentence is earned
 * here (a transport outcome is the one outcome {@link livenessProbeDecision}
 * reserves the lifecycle command for, and `test/probe-liveness.test.mjs` pins
 * that), and the tail is not: the request left this shell, whether the daemon
 * carried it out before the socket went is not knowable from a dead transport,
 * and "then retry" spends that unknown on a second copy on the user's screen.
 *
 * The same three-way split the error-frame fallback ({@link noRemedyFallback}) and
 * the timeout answer ({@link slowEngineRemedy}) already make, read from the same
 * two lists so a method moving between them moves this answer with it, and gated
 * on one prior question — did this request's bytes ever leave this process
 * ({@link NEVER_LEFT_TRANSPORT})? Every arm below is written for a transport that
 * died *after* carrying the request, and the three-way split says what a re-issue
 * would cost. For a request that was still queued locally when the socket failed,
 * there is nothing to re-issue a second time: this returns the plain
 * {@link daemonUnreachableRemedy}, which is the answer for "nothing is listening".
 *  - {@link REPLAY_UNSAFE_REASONS} members: no re-issue, naming that method's own
 *    reason, plus the read route this surface really has;
 *  - {@link STATE_CHANGING_ON_RETRY_METHOD_NAMES} members (`snapshot`): nothing is
 *    pressed twice, but a second accepted copy writes daemon state again and can
 *    evict the baseline an earlier snapshot returned;
 *  - every other method (the reads: `observe`, `diagnose`, `last_evidence`,
 *    `probe_status`, `assert_element`, `audit_ui`, `capture_view`, `hello`):
 *    refusing a retry where nothing is performed twice is its own kind of wrong
 *    advice, so this arm keeps {@link daemonUnreachableRemedy}'s bytes verbatim.
 */
function transportDeathRemedy(method: string, surface: ShellSurface, handedOff: boolean): string {
  const restore = daemonRestoreCommand();
  if (!handedOff) {
    // Nothing reached the daemon, so nothing can have been performed there and no
    // re-issue is a second performance of anything. The existing unreachable wording is
    // reused byte for byte rather than re-derived, because it is the answer this shell
    // already gives when nothing is listening — and a transport that never came up is
    // that case, seen one step earlier.
    return daemonUnreachableRemedy();
  }
  const unsafe = REPLAY_UNSAFE_REASONS[method];
  if (unsafe !== undefined) {
    return `${restore}. Do NOT re-issue '${method}' on the strength of this answer: this request had already left `
      + "this shell when its transport died, and whether the daemon carried it out before that cannot be told from "
      + `here — a re-issue can perform it a second time, because ${unsafe}. Read what happened instead of `
      + `performing it a second time: ${readInsteadRoute(surface)}.`;
  }
  if (STATE_CHANGING_ON_RETRY_METHOD_NAMES.includes(method)) {
    return `${restore}. Do NOT send a second '${method}' to replace the one this transport lost: it had already left `
      + "this shell, so the daemon may have stored the baseline already, and a second copy is not a cheaper re-read "
      + "of the first — it writes daemon state again, the snapshot ring the daemon keeps is bounded, and one more "
      + "entry can evict the baseline an earlier snapshot returned, the one a later restore still needs. The ids a "
      + "restore can name are the ones an earlier reply of this caller's already returned; nothing here enumerates "
      + "the ring.";
  }
  return daemonUnreachableRemedy();
}

/**
 * The answer for a frame that names this request and carries no answer at all
 * (`result: null`, or neither `result` nor `error`).
 *
 * This used to be one sentence for every method — "…Retry once, then check the
 * daemon log (stderr) for what it died before answering" — which put the same
 * order on `act`/`restore`/`attach`/`snapshot` that {@link noRemedyFallback}
 * refuses on the same evidence. The frame echoed this request's id, so the
 * request demonstrably reached the daemon; what it did there before producing an
 * empty answer is not something this frame says, and a second copy would be the
 * transport's guess at it. The three arms are {@link transportDeathRemedy}'s, read
 * from the same two lists: no re-issue for the replay-unsafe set, no second copy
 * for the ring-writing one, and a plain retry for the reads, where nothing is
 * performed twice and refusing it is wrong advice of its own.
 */
function emptyAnswerRemedy(method: string, surface: ShellSurface): string {
  const opening = "do not read this call as successful: the engine answered nothing. The frame echoed this "
    + "request's id, so the request reached the daemon, and an empty answer says nothing about what it did there — "
    + "this shell cannot see past the frame it was handed";
  const log = "The daemon's own log (stderr) is the only side that can say what it was doing when it answered "
    + "nothing.";
  const unsafe = REPLAY_UNSAFE_REASONS[method];
  if (unsafe !== undefined) {
    return `${opening}. Do NOT re-issue '${method}': a re-issue can perform it a second time, because ${unsafe}. `
      + `Read what happened instead of performing it a second time: ${readInsteadRoute(surface)}. ${log}`;
  }
  if (STATE_CHANGING_ON_RETRY_METHOD_NAMES.includes(method)) {
    return `${opening}. Do NOT send a second '${method}': every accepted copy writes daemon state again, the `
      + "snapshot ring the daemon keeps is bounded, and one more entry can evict the baseline an earlier snapshot "
      + "returned — the one a later restore still needs. The id a restore names comes from the reply the first call "
      + `got, and nothing here enumerates the ring. ${log}`;
  }
  return `${opening}, and a retry is the plain next step here: '${method}' is not a method this shell refuses to `
    + "replay, so nothing is performed twice — send it again. " + log;
}

/**
 * What the timeout answer may say about the caller's *next* request when the
 * method is not one the transport refuses to replay.
 *
 * Round 9 took the knob guess out of the oversized-reply path — "narrow this
 * reply" is composed by the tool layer from that tool's own schema — and this
 * function then put it back on the timeout path: every `observe`/`snapshot`/
 * `audit_ui` caller was told to re-send the same request with a smaller depth,
 * whether or not it had already sent the smallest value the shell's own schema
 * validation accepts. The retry this line ordered was therefore rejected by the
 * very floor it was supposed to help, and the agent that read it had one move
 * left: raise the value, which asks the daemon for *more* of the tree that is
 * already taking too long.
 *
 * So this states only what a transport can see — the wait is spent, the daemon is
 * still working on this same request, a second copy of it queues behind the first
 * — and hands "what can be narrowed, and whether it can still be narrowed at the
 * values already sent" to the surface that owns the schema (named per surface,
 * because the two surfaces do not hold the same thing). It names no parameter and
 * no direction for one, and `test/engine-client.test.mjs` guards that as a rule
 * rather than as a phrasing: it reads the parameter names out of `TOOL_SPECS` and
 * refuses any transport remedy text that puts one next to a narrowing verb, which
 * a re-wording cannot satisfy by trading "smaller maxDepth" for another knob.
 */
function reIssueGuidance(surface: ShellSurface): string {
  return "wait for the outstanding reply rather than sending this request again: the daemon answers one request at "
    + "a time, so a second copy of it now only queues behind the one still running and answers nothing sooner, and if "
    + "the first did take effect the copy performs it a second time. What is worth narrowing here, and whether it can "
    + "still be narrowed at the values this request already sent, is a fact about a schema, and this layer holds no "
    + `schema for any request: ${NARROWING_AUTHORITY[surface]}. Re-send only after reading that, and only if the `
    + "request is one whose repetition changes nothing";
}

/**
 * Remedy for a deadline overrun: wait and measure, never restart on a probe that
 * merely went unanswered, and never replay a request whose re-issue has a side
 * effect.
 */
export function slowEngineRemedy(method: string, surface: ShellSurface = "mcp"): string {
  // "goes out immediately" is a property of the *client*, not of this shell: the
  // shell will not queue one MCP request behind another, but a client that
  // serialises its own tool calls cannot send the probe until the outstanding
  // request has been answered — and then `answered`/`engine-error` are
  // unreachable and only `timed-out` can occur. Wording it as a conditional
  // keeps the guidance executable without asserting an unmeasured fact about
  // whoever is reading it (R8b-低).
  // The probe has a name on each surface, and naming the wrong one is not a style
  // problem: a curl caller told to call `gp_probe_status` can only guess at
  // `POST /v1/tools/gp_probe_status`, which this gateway answers with a 404.
  const probeCall = surface === "mcp" ? "gp_probe_status" : "POST /v1/tools/probe_status";
  const poll = `if your client can send a second request while this one is still outstanding, confirm the daemon is alive with a cheap call: the shell does not queue one request behind another on this surface, so ${probeCall} goes out at once and is answered as soon as the daemon is free of the request in front of it. Read its answer as: `
    + livenessProbeGuide();
  const restarted = livenessProbeDecision("unreachable");
  const unsafe = REPLAY_UNSAFE_REASONS[method];
  if (unsafe !== undefined) {
    return `${poll}. The daemon serves one request at a time and is still working on this one, so wait for it; do NOT re-issue ${method}, because ${unsafe} — ${lateReplyRoute(surface)}. Only ${restarted}`;
  }
  if (method === "probe_status") {
    return `the liveness probe itself has not been answered, and it is given the longest wait this shell allows any request (${CALLER_VISIBLE_CEILING_MS}ms), so this particular answer carries no information about whether the daemon is alive: the daemon is single-connection and is still working on the request in front of this probe. ${livenessProbeDecision("timed-out")}. Keep waiting instead — the outstanding call's reply is attributed when it lands, and ${lateReplyRoute(surface)}. If the daemon's socket really is gone, the next call answers with ${GP_E_ENGINE_UNREACHABLE}, and that remedy names the restore command.`;
  }
  return `${poll}. The daemon serves one request at a time and is still working on this one, so ${reIssueGuidance(surface)}; a restart is authorised only by ${restarted}`;
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
  /**
   * Whether this request's bytes left this process. `false` is only ever set by a
   * transport that can measure it (one with `bufferedBytes()`), and it means the frame was
   * still sitting in *this* process's write queue when the transport died — so the daemon
   * never saw it, and {@link transportDeathRemedy} may not claim otherwise.
   * The `writeLine` hand-off callback (S1-1) can raise it back to `true` after the
   * queue drains: bytes that were locally queued at write time but flushed before
   * the transport went are the daemon's to have executed.
   */
  handedOff: boolean;
  deadlineMs: number;
  methodDeadlineMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  /**
   * Set when an id-less frame has already been attributed to this request by
   * arrival order. The entry stays tracked (finding 中-4): the arrival-order
   * attribution is a *guess*, and the layer that consumes it (`dispatch.ts`'s
   * generation check) may refuse it — and if the entry were dropped at the same
   * moment, the daemon's real reply, which does echo the id, would then read as a
   * frame this client never issued, which is how an operation that really ran
   * becomes unrecordable and the agent is told to run `gp_act` a second time.
   * Marking instead of deleting keeps the guess from being reused for the *next*
   * id-less frame while the echoed reply is still expected.
   */
  arrivalOrderConsumed?: boolean;
  deliver: (value: unknown) => void;
  fail: (reason: EngineCallError) => void;
};

/** How many timed-out entries are kept for late replies before the oldest goes. */
const LATE_REPLY_RETENTION = 16;

/** How long a single frame *field* may be before a log line stops quoting it verbatim. */
const LOG_FIELD_CHARS = 120;

/**
 * How a reply frame was matched to the request it is reported for.
 *
 * `echoed-id` is the frame carrying the request id this client sent and the
 * lookup hitting; that is the only attribution this transport can *confirm*.
 * `arrival-order` is the daemon's id-less answer (it loses the id on the paths
 * that could not parse or could not serialize the frame), matched to the oldest
 * request still tracked because the daemon answers in the order it received
 * them — an inference from scheduling, never a confirmation, so anything written
 * from it into an evidence trail has to carry that caveat with it
 * (`EvidenceAuditSession.provenanceOf`).
 *
 * Spelled as the same two literals `audit-session.ts` accepts for the same
 * reason: the transport is the only thing that sees the frame, and the session is
 * the only thing that decides what the trail claims about an id.
 */
export type FrameAttribution = "echoed-id" | "arrival-order";

/** One late engine reply, as handed to {@link EngineJsonRpcClient.onLateReply}. */
export interface LateReply {
  method: string;
  result: unknown;
  /** Whatever `call()` was given; see {@link Pending.correlation}. */
  correlation?: number;
  /**
   * Whether this reply's *request* was confirmed by an echoed id or inferred
   * from arrival order; see {@link FrameAttribution}. A sink that records this
   * body into a trail must not present an `arrival-order` frame as a confirmed
   * one, because the method it is filed under is a guess.
   */
  attribution: FrameAttribution;
}

/**
 * The mutable half of {@link EngineJsonRpcClient}'s state, held in one object so
 * that a write through a prototype-chain receiver lands on the client itself — see
 * the field's comment in the class for why that is a safety property here and not
 * a style preference.
 */
interface ClientState {
  /** Next request id. Written by every `call()`. */
  nextId: number;
  /** Set once by `close()`; read by `call()` and `handshake()`. */
  closed: boolean;
  noteHandler: ((note: string) => void) | null;
  /**
   * Declared to accept anything as its return value, while the public
   * {@link EngineJsonRpcClient.onLateReply} keeps the `(reply) => void` shape
   * callers were written against: an `async` sink is assignable to both, and only
   * this wider one lets {@link EngineJsonRpcClient.reportLateReply} see the promise
   * it has to keep from becoming an unhandled rejection.
   */
  lateReplyHandler: ((reply: LateReply) => unknown) | null;
}

/**
 * Request/response association over a line transport. Kept independent of
 * the transport so tests inject a fake LineIo (spec §7.1 "fake engine
 * transport").
 */
export class EngineJsonRpcClient {
  /**
   * Every mutable piece of this client's state, in one object that is *never*
   * reassigned through `this`.
   *
   * That is not a style choice (R10-中4). `tools.ts` hands one tool an engine view
   * built with `Object.create(engine)`, which puts the real client on the shadow's
   * prototype chain so the shadow shares its map, its sinks and its transport — and
   * any method that runs with the *shadow* as `this` then writes its field on the
   * shadow, because assigning a property that exists only on the prototype creates
   * an own property instead of touching the prototype's. `pending` survived that
   * only because it is a `Map` that gets mutated rather than reassigned. A
   * `this.closed = true` did not: it marked the shadow closed and left the client
   * sending requests on a transport it had been told to end. Reading state out of
   * this box still resolves through the chain, and writing a property of it mutates
   * the one box the client itself holds.
   *
   * `test/engine-client.test.mjs` closes the *shadow* and asserts the client behind
   * it is closed, which is the observable form of the whole rule.
   */
  private readonly state: ClientState = {
    nextId: 0,
    closed: false,
    noteHandler: null,
    lateReplyHandler: null,
  };
  private readonly pending = new Map<number, Pending>();

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
    /**
     * The daemon methods this shell forwards, injected by the composition root
     * from `TOOL_SPECS` (never hand-copied — a copied list is the drift this
     * exists to catch). Empty means "no expectation was wired", and the
     * reconciliation stays silent rather than reporting every capability as
     * unexposed; `index.ts` supplies the real list.
     */
    private readonly expectedDaemonMethods: readonly string[] = [],
  ) {
    this.io.onMessage((line) => this.handleMessage(line));
    this.io.onError((error) => {
      if (error instanceof OversizeFrameError) {
        // One frame was dropped; the connection is fine and only the request
        // it answered fails (spec §3.1).
        this.failOversizedReply(error);
        return;
      }
      this.teardown(
        `engine transport error: ${error.message}`,
        (method, handedOff) => transportDeathRemedy(method, this.surface, handedOff),
        NEVER_LEFT_TRANSPORT,
      );
    });
    this.io.onClose(() => this.teardown(
      "engine transport closed",
      (method, handedOff) => transportDeathRemedy(method, this.surface, handedOff),
      NEVER_LEFT_TRANSPORT,
    ));
    this.io.onOpen?.(() => {
      // Whatever was waiting in this process's write queue went out with the connection:
      // from here the frames are the peer's to answer, and the transport-death answer may
      // say so. Marked before the handshake so the `hello` this writes is itself counted as
      // handed off.
      for (const entry of this.pending.values()) {
        entry.handedOff = true;
      }
      this.handshake();
    });
  }

  /**
   * The state root the daemon named in its own `hello` (additive since 1.15.0), or null
   * when no handshake answered that key. `null` means "this daemon does not report it" —
   * never "therefore it is the home default"; callers say which of the two they used.
   */
  private helloStateRoot: string | null = null;

  get reportedStateRoot(): string | null {
    return this.helloStateRoot;
  }

  /**
   * The version the daemon named in its own `hello`, or null when no handshake on this
   * connection has reported one.
   *
   * This is the *producer's* measurement, and it is what the provider attribution line
   * states (`providers.ts`'s `attributeCapability`): the verdict an agent is being told
   * about came out of the daemon's build, not this package's. Read rather than assumed —
   * `null` means "not measured on this connection", never "therefore it is the shell's
   * own version", which is the mistake that made an app bundle older than the shell
   * report a verdict from a build that did not produce it.
   */
  private helloVersion: string | null = null;

  get reportedEngineVersion(): string | null {
    return this.helloVersion;
  }

  /**
   * Sink for facts that cannot be attached to any request of the caller: a
   * late reply, a frame with an id this client never issued, a daemon that
   * fails its handshake. Without a sink these stay invisible, which is how
   * "not measured" turns into a confident wrong story.
   */
  onEngineNote(handler: (note: string) => void): void {
    this.state.noteHandler = handler;
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
    this.state.lateReplyHandler = handler;
  }

  /**
   * Whether {@link close} has ended this client. Public because the answer has to
   * be readable *through* the `Object.create` shadow the tool layer builds: a
   * shadow that was closed has to report the client behind it closed, otherwise
   * "closed" is a property of whichever object happened to receive the call.
   */
  isClosed(): boolean {
    return this.state.closed;
  }

  /**
   * Send a request and await its matching response frame. `correlation` is
   * echoed to {@link onLateReply} if this request is answered after its caller
   * has already been given a timeout; it is otherwise unused by this client.
   */
  call(method: string, params?: Record<string, unknown>, correlation?: number): Promise<unknown> {
    if (this.state.closed) {
      // A client that was closed does not write into its transport any more: the
      // id it would have used is one the daemon never saw, so nothing can answer
      // it and no late reply can ever be attributed to it. The remedy says which
      // thing ended — this shell's own client — and names no daemon lifecycle
      // command: nothing was sent, so nothing about the daemon was measured, and a
      // restart ordered here could recycle a daemon that is mid-action on the
      // user's screen.
      return Promise.reject(new EngineCallError(
        GP_E_ENGINE_UNREACHABLE,
        `cannot send '${method}': this engine client was closed, so it opens nothing and sends nothing`,
        "the engine client of this shell ended, not the daemon: nothing was sent, so nothing about the daemon was "
        + "measured and no restart is authorised by this answer. Ask through a server process that still has a live "
        + "engine client — start this server again — rather than recycling the daemon",
      ));
    }
    const id = this.state.nextId++;
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
        handedOff: true,
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
      // 背压闸：daemon 不读 socket 时，Node 会把写进去的帧无上限地堆在本进程内存里，
      // 调用方只看到"还没回"。与其替一个卡死的对端越攒越多，不如在超过这一档时
      // 直接拒掉新请求——拒绝是可诊断的，积压只会把整个壳拖垮。
      // 注意这不等价于"没有超时"：每一次调用本来就带 deadline，卡死的 daemon
      // 会以 GP_E_ENGINE_TIMEOUT 现形；这里补的是**内存**那一条，不是等待那一条。
      const backlog = this.io.bufferedBytes?.() ?? 0;
      if (backlog > ENGINE_WRITE_BACKLOG_BYTES) {
        // 自己的码：GP_E_ENGINE_UNREACHABLE 的出路在这里自相矛盾（它命令重启，而这条
        // 测量没测到 daemon 的任何事），见 `writeBacklogRemedy`。
        // 这里没有、也不该有 `pending.delete(id)`：这一支发生在 `pending.set(id, entry)`
        // 之前，id 由 `state.nextId++` 单调生成、从未进过这张表，删除恒为 no-op（S1-4）。
        // catch 里那一句不同——那里的 set 已经发生，删除是真的在收口。
        this.reject(entry, new EngineCallError(
          GP_E_ENGINE_BACKLOG,
          `not sending '${method}': ${backlog} bytes are already queued for the engine socket and it `
          + "has not read them",
          writeBacklogRemedy(backlog, ENGINE_WRITE_BACKLOG_BYTES),
        ));
        return;
      }

      this.pending.set(id, entry);

      const queuedBefore = this.io.bufferedBytes?.() ?? null;
      try {
        const frameText = JSON.stringify(frame);
        // S1-1: two criteria answer one question — did this frame's bytes leave
        // this process? The static `bufferedBytes()` diff below is the *instant*
        // reading at write time; the write callback is the *temporal* one, run
        // when a transport that queued the bytes finally flushes them. Without
        // the callback, a frame that sat in the local send queue, then drained,
        // then was executed by the daemon before the transport died was
        // permanently answered with NEVER_LEFT_TRANSPORT and a "then retry" the
        // user's screen pays for twice. A transport that never calls back (every
        // silent fake, B7's `QueuingIo` among them) keeps the static verdict
        // untouched — the callback only ever raises `handedOff`, never lowers it.
        let writeHandedOffConfirmed = false;
        this.io.writeLine(frameText, () => {
          writeHandedOffConfirmed = true;
          entry.handedOff = true;
        });
        if (queuedBefore !== null && !writeHandedOffConfirmed) {
          // B7: the lazy transport opens its socket on the first write, and a `net.Socket`
          // accepts that write into its own queue — `write()` returns, nothing has been
          // delivered, and `writableLength` still holds the bytes. A transport that reports
          // its queue therefore gets told, per request, whether the frame left this process
          // or is still sitting in it; the answer decides what the death of that transport
          // may claim. `null` (no `bufferedBytes()` on this transport) keeps the previous
          // reading, which is the honest default for a transport that cannot say.
          const queuedAfter = this.io.bufferedBytes?.() ?? 0;
          entry.handedOff = queuedAfter < queuedBefore + frameText.length + 1;
        }
      } catch (error) {
        // Nothing reached the daemon, so no late reply can ever land for it.
        this.pending.delete(id);
        // A refusal this transport raised about its *own* judgement (an untrusted socket) already
        // carries its code and remedy; re-laundering it as `GP_E_ENGINE_UNREACHABLE` would hand
        // the caller a daemon-restart order that this measurement does not license — the thing
        // listening there may be running fine, just not as the engine.
        if (error instanceof EngineCallError) {
          this.reject(entry, error);
          return;
        }
        this.reject(entry, new EngineCallError(
          GP_E_ENGINE_UNREACHABLE,
          `cannot send '${method}' to the engine daemon: ${(error as Error).message}`,
          daemonUnreachableRemedy(),
        ));
      }
    });
  }

  close(): void {
    // Marked first, and as a property of the shared box rather than a field of
    // `this`: `io.close()` below can run the transport's close handler
    // synchronously, and anything that answers to it has to *read* a flag that is
    // already set — on the client, not on whichever object received the call.
    this.state.closed = true;
    // The outstanding calls are rejected with what *this* event can support
    // ({@link clientClosingRemedy}), not with the unreachable-daemon remedy: a
    // shutdown of this shell is not a measurement of the daemon, and the one
    // finding that does justify a lifecycle command is reserved for the transport
    // paths above, where a socket really did go away.
    this.teardown(
      "engine client closed: this shell's own client is ending, so whether the daemon finished this request is "
      + "not known here and this client can no longer attribute the reply that may still land",
      () => clientClosingRemedy(this.surface),
    );
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
    // S1-3: who this shell stops waiting *for* is a fact about the surface, not
    // about the shell — the same split `lateReplyRoute` was authored for
    // (R8b-高3). Hard-coding "an MCP client" here told a `curl` caller of the
    // HTTP gateway that this shell had given up on somebody else's caller, and
    // `MCP_PROSE_FOR_HTTP` in the gateway never translated this clause.
    const waitingFor = this.surface === "mcp" ? "an MCP client" : "an HTTP caller";
    const capped = entry.methodDeadlineMs > entry.deadlineMs
      ? ` This shell stops waiting for ${waitingFor}'s sake at ${entry.deadlineMs}ms while the daemon gets up to ${entry.methodDeadlineMs}ms for '${entry.method}', because a client that is left hanging retries on its own and a retried '${entry.method}' runs twice.`
      : "";
    this.reject(entry, new EngineCallError(
      GP_E_ENGINE_TIMEOUT,
      `engine is still working on '${entry.method}': no reply after ${entry.deadlineMs}ms. `
      + "The request stays registered — a late reply is written to the server log — so this is a busy or slow daemon, not an unreachable one. "
      + "That registration lasts only while this connection does: if the transport ends first, the server log says so and names what it stopped tracking."
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.report(`engine sent a non-JSON frame, dropped: ${frameBodyNotLoggedNote(line)}`);
      return;
    }
    // 形状也要过这一遍，不能只挡住"不是 JSON"。`null`、数组、一个数字都是合法的
    // JSON，而下一行就要读 `frame.id` —— 那一次抛错发生在 socket 的 `data` 回调里，
    // 没有任何东西接得住（`index.ts` 只挂了 SIGINT/SIGTERM），整个壳进程随之退出，
    // 把所有在途请求一起带走。stdio 那一侧的 `isRequestBody` 早就防到这个形状了，
    // 引擎这一侧漏了：同一份"对端不可信"的判断，两半必须同一口径。
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.report(`engine sent a frame that is not a JSON object, dropped: ${frameBodyNotLoggedNote(line)}`);
      return;
    }
    const frame = parsed as CallFrame;

    const id = frame.id;

    if (typeof id === "number") {
      const entry = this.pending.get(id);
      if (!entry) {
        // The refusal has to be diagnosable, not just firm: an id this client no
        // longer tracks is either one it evicted from the late-reply window or one
        // the daemon invented, and the only thing that tells the two apart is which
        // requests are still held. Naming them is what finding 中-4 asks the refusal
        // path to keep able to do, now that an id-less frame no longer removes one.
        const tracked = [...this.pending.values()];
        const held = tracked.length === 0
          ? "nothing is tracked now"
          : `this client still tracks ${tracked.length} request(s): `
            + tracked.map((kept) => "'" + kept.method + "' id " + kept.id
              + (kept.settled ? " (caller already answered)" : "")).join(", ");
        this.report(
          `engine sent a frame for request id ${id}, which this client never issued (or already gave up on); `
          + held + ": " + frameBodyNotLoggedNote(line),
        );
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
    //     reading the next request, so the request it was working on is the
    //     oldest one this client still *tracks* (R9-高1). Tracked, not "the
    //     oldest the caller is still waiting on": a request whose caller was
    //     answered at the ceiling is still the daemon's current one, and
    //     skipping it delivered that other request's failure to the next caller
    //     in the queue, deleted the entry its real reply needed, and made that
    //     reply read as a frame this client never issued. The reverse mutation to
    //     watch for is `oldestTracked` becoming `oldestOpen` again.
    //   any other id shape — nothing to attribute; say so and leave the
    //     outstanding requests to their own deadlines.
    if (id === null || id === undefined) {
      const target = this.oldestTracked();
      if (target) {
        if (target.settled) {
          // Its caller already has an answer, so this is a late reply: report it,
          // route a result to the trail sink, and under no circumstances hand it
          // to a different caller that is still waiting. `inferred: true` is the
          // other half of R10-中2 — the *body* is the daemon's, but which request it
          // answers is this method's inference from arrival order, so the sink (and
          // the trail behind it) is told the attribution was not confirmed.
          //
          // The entry is *not* deleted, and that is finding 中-4: an inferred
          // attribution can be refused downstream (a reply admitted under a
          // superseded trail generation is not recorded), and the refused frame is
          // the only thing the delete used to make room for. Dropping the entry
          // here destroyed the one route back — the daemon's own reply with the id
          // echoed — and the log then said "this client never issued" about a
          // request it had in fact sent, for an operation that had in fact run.
          // Marking it consumes the guess for arrival-order purposes only.
          this.reportLateReply(target, frame, true);
          target.arrivalOrderConsumed = true;
          // The retention is what bounds these now-kept entries, so it runs here
          // as well as on the deadline path; the eviction it performs is logged.
          this.retainForLateReply();
          return;
        }
        if (frame.error) {
          // This frame *is* that request's answer, so its caller is settled with
          // it — but the entry is *not* deleted, and that is finding 中-4 read on
          // the unsettled side (review 2026-10-09 finding 2), where it was worse:
          // the attribution here is only a guess by arrival order, so the request
          // this frame was spent on may not be the one the daemon was answering
          // (an `act` whose frame parsed fine can be given another request's
          // failure), and deleting the entry at the same moment threw away the one
          // route back — the daemon's real reply, which does echo the id. That
          // reply then read as "a frame this client never issued", the operationId
          // never reached the trail, and an agent holding `GP_E_NO_EVIDENCE … run
          // gp_act first` pressed the action a second time on the user's screen.
          // `reject()` settles the caller, so the echoed reply takes the late-reply
          // path above and is still attributed and recorded; marking the entry
          // spends the guess for arrival-order purposes only.
          this.reject(target, attribute(this.engineError(frame.error, target.method), target));
          target.arrivalOrderConsumed = true;
          this.retainForLateReply();
          return;
        }
        // A result frame with no id is not something the daemon's own paths
        // produce (its id-less answers are the error paths), and delivering a
        // guessed result to a live caller would answer it with another request's
        // data — so nothing is settled here and the request keeps its own
        // deadline.
        this.report(`engine sent an id-less frame with a result while '${target.method}' (id ${target.id}) is still waiting for its answer; an id-less answer from this daemon is an error frame, so this one was not delivered to any caller: ${frameBodyNotLoggedNote(line)}`);
        return;
      }
      this.report(frame.error
        // `null`, and not a guess at a method: this frame is being reported precisely
        // because no request this client still tracks owns it.
        ? `engine reported ${this.engineError(frame.error, null).code} with no request in flight: ${frameBodyNotLoggedNote(line)}`
        : `engine sent an id-less frame with no request in flight: ${frameBodyNotLoggedNote(line)}`);
      return;
    }
    this.report(`engine sent a frame with a non-numeric request id (${shortFieldValue(id)}), which this client never issues: ${frameBodyNotLoggedNote(line)}`);
  }

  private settleFromFrame(entry: Pending, frame: CallFrame): void {
    if (frame.error) {
      this.reject(entry, this.engineError(frame.error, entry.method));
      return;
    }
    // "没有 result 这个键"与"result 是 undefined"不是一件事。少了这一句，一帧既无
    // error 又无 result 会被当成**成功**交上去：工具层把 undefined 规范成一条没有
    // text 的内容项，`isError` 仍是 false——引擎什么都没答，代理读到的却是绿。
    // 与 `capture_view` 的 `persisted !== false` 同一条规矩：主张必须由引擎说出来，
    // 壳层不许替它填一个默认值。
    if (!("result" in frame) || frame.result === null) {
      this.reject(entry, new EngineCallError(
        GP_E_INTERNAL,
        frame.result === null
          ? `engine answered '${entry.method}' with a frame whose result is null: the key is present but carries no answer`
          : `engine answered '${entry.method}' with a frame carrying neither result nor error`,
        emptyAnswerRemedy(entry.method, this.surface),
      ));
      return;
    }
    this.resolve(entry, frame.result);
  }

  /**
   * A frame over the cap: attribute it to the request it belonged to — from
   * the retained head when the daemon echoed an id, else by arrival order, which
   * is the oldest *tracked* request for the same reason the id-less frame path
   * uses it (R9-高1) — and fail that one call only.
   */
  private failOversizedReply(error: OversizeFrameError): void {
    const echoed = recoverFrameId(error.prefix);
    const direct = typeof echoed === "number" ? this.pending.get(echoed) : undefined;
    const entry = direct ?? this.oldestTracked();
    if (!entry) {
      this.report(`engine sent an oversized frame (${error.bytes} bytes) with no request in flight — dropped, connection intact`);
      return;
    }
    const inferred = direct === undefined;
    if (entry.settled) {
      this.pending.delete(entry.id);
      this.report(`the engine's late reply to '${entry.method}' (id ${entry.id}) exceeded the ${MAX_FRAME_BYTES}-byte frame cap (${error.bytes} bytes), so its body could not be delivered even late${inferred ? " (attributed by arrival order: the frame's head carried no readable id)" : ""}`);
      return;
    }
    const failure = new EngineCallError(
      GP_E_PAYLOAD_TOO_LARGE,
      `the engine's reply to '${entry.method}' exceeded the ${MAX_FRAME_BYTES}-byte frame cap (${error.bytes} bytes) and was dropped; the connection is intact and other requests are unaffected`,
      "narrow this request or ask for less of it; the tool's own schema names the parameters that can "
      + "shrink a reply, and this shell rewrites this line into that advice when it can (the transport "
      + "layer deliberately does not guess them)",
    );
    if (inferred) {
      // S1-2: same shape as the id-less error-frame arm above (reject, keep the
      // entry, mark the guess spent, retain for the late reply). This attribution
      // is a guess by arrival order, and the daemon's real reply — which does
      // echo the id — still has to find its entry; deleting it here made that
      // reply read as "a frame this client never issued", kept the operationId
      // out of the trail, and left the caller's PAYLOAD_TOO_LARGE answer with a
      // re-narrow story for a request the daemon may in fact have answered.
      this.reject(entry, attribute(failure, entry));
      entry.arrivalOrderConsumed = true;
      this.retainForLateReply();
      return;
    }
    // The echoed-id case is a confirmed attribution: the frame naming this
    // request *was* its answer, nothing further can arrive for it, and the entry
    // goes.
    this.pending.delete(entry.id);
    this.reject(entry, attribute(failure, entry, false));
  }

  /**
   * The daemon's error frame, mapped into this shell's error.
   *
   * An error frame is a three-field shape — code, message, remedy — and each
   * field has to actually say something for the answer to be usable by an agent.
   * `??` only catches null/undefined, so a frame carrying `code: ""` used to be
   * forwarded verbatim as an error with no name and no cause, while the remedy arm
   * below already treats `""` as absent: one rule for three fields on the same
   * frame. A blank is now read as "not stated" for every one of them, and a
   * non-blank value — including one that merely looks odd — passes through
   * untouched, because this function forwards the daemon's own words and has no
   * authority to rewrite them.
   */
  private engineError(body: Partial<EngineErrorBody>, method: string | null): EngineCallError {
    return new EngineCallError(
      nonBlankOr(body.code, GP_E_UNKNOWN),
      nonBlankOr(body.message, "the engine sent an error frame without a message"),
      typeof body.remedy === "string" && body.remedy.trim() !== ""
        ? body.remedy
        : noRemedyFallback(method),
    );
  }

  /**
   * Oldest request this client still tracks, settled ones included: that is the
   * request the daemon's arrival-ordered answer belongs to. `Map` iteration is
   * insertion order, which is the order the requests went out.
   *
   * An entry whose id-less answer has already been taken (`arrivalOrderConsumed`)
   * is passed over for *this* purpose while staying in the map for the echoed-id
   * lookup: the guess has been spent once and may not be spent again on the next
   * id-less frame, and the request it was spent on is still the request whose real
   * reply can arrive with its id (finding 中-4).
   */
  private oldestTracked(): Pending | undefined {
    for (const entry of this.pending.values()) {
      if (!entry.arrivalOrderConsumed) {
        return entry;
      }
    }
    return undefined;
  }


  /**
   * Route the reply that lands after its caller was already answered. `inferred`
   * marks an attribution made by arrival order rather than by a matching id, and
   * says so in the note — and hands the same distinction to the sink, which is
   * the only place the caveat can travel with the body it records (R10-中2: an
   * id-less result is a *guess about which request this is the answer to*, and a
   * trail that files it without that note presents a guessed frame as a verified
   * one). What the transport may not do is claim the sink recorded anything: it
   * cannot see whether the trail accepted the frame or refused it for belonging to
   * a superseded attach.
   */
  private reportLateReply(entry: Pending, frame: CallFrame, inferred = false): void {
    const attribution: FrameAttribution = inferred ? "arrival-order" : "echoed-id";
    const byOrder = inferred
      // Deliberately free of a narrowing verb: the sentence states *which* request
      // this is filed under, not what the caller should change, and
      // `test/engine-client.test.mjs` refuses remedy/note text that pairs the two.
      ? " (attributed by arrival order: this frame echoed no request id, so nothing here confirms that guess — this is "
        + "the oldest request this client still tracks, and the daemon answers in the order it received them; a frame "
        + "matched to a request that way is recorded as inferred, never as verified)"
      : "";
    if (frame.error) {
      // Name the missing operationId rather than leaving this to read as a reply
      // that was logged and then silently not recorded: an error answer carries
      // nothing the trail could hold on to.
      this.report(
        `late engine reply for '${entry.method}' (id ${entry.id}), ${entry.deadlineMs}ms deadline already reported, is an error frame (${JSON.stringify(frame.error)}): an error answer names no operationId, so nothing can be recorded in the trail for it${byOrder}`,
      );
      return;
    }
    // The body is deliberately *not* written here, and the reason is said in the
    // line itself so the next reader does not "helpfully" put it back: this is raw
    // engine content — the accessibility tree of the user's screen, whose
    // `title`/`value`/`description` fields are whatever is on-screen right now
    // (document titles, form fields, message text) — and stderr is captured by
    // whoever launched this server, so dumping a reply copied an on-screen secret
    // into a log nobody asked for (review 2026-10-09 finding 3). The clause is
    // {@link lateReplyBodyNote}, the one sentence both doorways say so they cannot
    // drift. The trail sink below still receives the body, because that is what an
    // evidence record needs; this line keeps the part that is diagnostic — which
    // request, how big, a digest that correlates it with the archive — and states
    // plainly that the engine did answer. The reverse mutation is to re-interpolate
    // the frame here, which is what this comment exists to refuse.
    const bodyJson = jsonOrString(frame.result);
    this.report(
      `late engine reply for '${entry.method}' (id ${entry.id}), ${entry.deadlineMs}ms deadline already reported: the engine did answer, ${lateReplyBodyNote(bodyJson, operationIdOf(frame.result))}${byOrder}`,
    );
    if (frame.result === undefined) {
      // A frame with neither `result` nor `error` is not an answer this sink can
      // use.
      return;
    }
    const handler = this.state.lateReplyHandler;
    if (handler === null) {
      return;
    }
    const reply: LateReply = {
      method: entry.method,
      result: frame.result,
      correlation: entry.correlation,
      attribution,
    };
    try {
      const returned = handler(reply);
      // An `async` sink satisfies the `(reply) => void` signature it is
      // registered with, and its rejection never reaches the `catch` below — it
      // escapes as an unhandled rejection, which takes the MCP process down with
      // every request still pending in it (R9-中2). The reverse mutation is to
      // drop this block and leave the sync `catch` as the whole guard.
      if (returned instanceof Promise) {
        returned.catch((error: unknown) => this.reportSinkFailure(entry, error));
      }
    } catch (error) {
      // The reply has already been logged above; a sink that throws must not
      // lose that fact, and must not be allowed to take the transport down.
      this.reportSinkFailure(entry, error);
    }
  }

  private reportSinkFailure(entry: Pending, error: unknown): void {
    this.report(`the late-reply sink failed for '${entry.method}' (id ${entry.id}): ${String(error)}`);
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

  /**
   * Reject everything outstanding and drop every handle. The settled entries go
   * too, and that has to be reported: each of them was answered with "the
   * request stays registered" (`onDeadline`) and with {@link lateReplyRoute}'s
   * promise that its reply is attributed when it lands. This map is what that
   * promise was standing on, so clearing it silently leaves an agent reading the
   * log for an operation that really ran, finding nothing, and unable to tell
   * "this shell stopped tracking it" from "it never happened" — the difference
   * that decides whether it re-performs an `act` on the user's screen (R9-中1).
   * The reverse mutation is to delete this note and keep the silent clear.
   *
   * The message is one sentence for every request — it states what happened to
   * the transport, which is the same fact for all of them — while the remedy is
   * written per method (`remedyFor`): what the caller may do next depends on
   * whether re-issuing that particular request would perform it a second time,
   * and one remedy for the whole batch is how "…, then retry" reached an
   * outstanding `act` at all. See {@link transportDeathRemedy}.
   */
  private teardown(
    message: string,
    remedyFor: (method: string, handedOff: boolean) => string,
    /**
     * What to say about a request whose bytes were still in this process when the transport
     * went, or `null` when this teardown is not a transport outcome. Only the transport-death
     * arms pass it: {@link clientClosingRemedy} is written for the case where a reply may
     * still land, and a frame that never left cannot land one.
     */
    neverLeftNote: string | null = null,
  ): void {
    const entries = [...this.pending.values()];
    // Read before the loop below: `reject()` marks an entry settled, and a
    // request that never got an answer is not one whose caller was promised a
    // tracking window.
    const tracked = entries.filter((entry) => entry.settled);
    this.pending.clear();
    for (const entry of entries) {
      if (!entry.settled) {
        // A request whose bytes were still in this process when the transport went is not
        // one the daemon can have carried out, and saying so is the difference between an
        // answer that permits a retry and one that forbids a duplicate (B7).
        const said = entry.handedOff || neverLeftNote === null
          ? message
          : `${message}; ${neverLeftNote}`;
        this.reject(entry, new EngineCallError(GP_E_ENGINE_UNREACHABLE, said, remedyFor(entry.method, entry.handedOff)));
      } else if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    }
    if (tracked.length > 0) {
      this.report(
        `${message}: late-reply tracking ended for ${tracked.length} request(s) whose callers had been told their replies would still be attributed (${tracked.map((entry) => `'${entry.method}' id ${entry.id}`).join(", ")}). Nothing tracks them now, so a reply that lands after this line is not attributed, not recorded in the trail, and not evidence either way that the operation ran.`,
      );
    }
  }

  private report(note: string): void {
    this.state.noteHandler?.(note);
  }

  /**
   * R4-06: both sides self-report protocol/version and the repo keeps a single
   * version line, yet nothing compared them at runtime — an old daemon under a
   * new shell only surfaced as a mystery schema error later. Handshake once
   * per (re)connection and report the measurement, including "unmeasured".
   */
  private handshake(): void {
    if (this.state.closed) {
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
    const report = result as { engine?: unknown; version?: unknown; protocolVersion?: unknown; capabilities?: unknown; stateRoot?: unknown };
    // Stored before the protocol arms, and whatever they decide: the daemon that answered
    // this handshake is the build that produced the verdicts on this connection, so its
    // self-reported version is a measurement whether or not the protocol numbers agree.
    // A blank or absent one stays unmeasured — never defaulted to this shell's own.
    const version = typeof report.version === "string" ? report.version.trim() : "";
    if (version !== "") {
      this.helloVersion = version;
    }
    // `hello.stateRoot` (additive since 1.15.0) is the daemon's own answer to "which root
    // did you resolve", and it is recorded on exactly the same terms as the version above.
    // The project tools read it through `reportedStateRoot` instead of deriving a root from
    // `$HOME`: a service started with `--state-dir /tmp/sandbox` loads
    // `/tmp/sandbox/projects.json`, and writing the home default while reporting success is
    // the incident class this module was created to refuse. An absent key is kept absent —
    // "that daemon does not report it", never "so it must be the home default".
    //
    // It used to be assigned *below* the two protocol arms, both of which `return`. A daemon
    // that reported a root and a protocol number this shell does not speak therefore left
    // `reportedStateRoot` null, and the harm was not the missing measurement: the project
    // tools fell back to the home default and `daemonRestartNotice` said, to the agent's
    // face, "this daemon's hello reported no stateRoot". It reported one; this shell had
    // simply not kept it. Storing what a frame says before deciding about it is the shape
    // `version` already had, and the two now share it.
    const reportedRoot = typeof report.stateRoot === "string" ? report.stateRoot.trim() : "";
    if (reportedRoot !== "") {
      this.helloStateRoot = reportedRoot;
    }
    const protocol = typeof report.protocolVersion === "string" ? report.protocolVersion : null;
    if (protocol === null) {
      this.report(`engine self-report has no protocolVersion (engine=${jsonOrString(report.engine)}); expected '${expected}' — compatibility unverified`);
      return;
    }
    if (protocol !== expected) {
      this.report(`protocol mismatch: engine speaks '${protocol}', this shell speaks '${expected}' — upgrade or restart one side before trusting tool results`);
      return;
    }
    const reportedVersion = version === "" ? null : version;
    const wantVersion = this.identity?.version;
    if (reportedVersion !== null && wantVersion !== undefined && reportedVersion !== wantVersion) {
      this.report(`version mismatch: engine self-reports '${reportedVersion}', this MCP shell ships '${wantVersion}' (single version line) — one side is stale`);
    }
    if (this.expectedDaemonMethods.length > 0) {
      const advertised = Array.isArray(report.capabilities)
        ? (report.capabilities as unknown[]).filter((item): item is string => typeof item === "string")
        : null;
      const drift = describeCapabilityDrift(advertised, this.expectedDaemonMethods);
      if (drift !== null) {
        this.report(drift);
      }
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

/**
 * The one sentence every unattributable-frame arm says about the bytes it refused to log.
 *
 * `handleMessage` has seven arms that drop a frame the client cannot attribute — not JSON, not
 * an object, an id it never issued, an id-less answer, a non-numeric id. Each of them still has
 * to be diagnosable, and none of them may copy the frame: a reply on this socket is observe /
 * assert content (element titles and values, sometimes a document's text), while the report
 * sink — stderr, or whatever supervises the process — is a file this product never sets the
 * mode of. Copying the body there exports screen content past the 0700 state root, which is
 * exactly what `lateReplyBodyNote` was authored to prevent on the late-reply path; the two
 * surfaces cannot be allowed to hold opposite rules about the same bytes (review 2026-10-09
 * finding 3, F3 on 2026-10-27, and this round's finding that the seven arms were never moved).
 *
 * So the note keeps the facts that survive redaction and are recomputable from the frame
 * itself: the byte length and a short deterministic SHA-256 digest of the exact bytes this
 * transport received. Unlike a *reply* to a request this client still tracks, a frame that
 * belongs to no request may have no archive entry at all, so the note names where content the
 * daemon did record lives, and says how to read it back, without promising this frame is in it.
 *
 * The reverse mutation is to interpolate the frame back into any of those seven lines.
 */
export function frameBodyNotLoggedNote(serializedFrame: string): string {
  const bytes = Buffer.byteLength(serializedFrame, "utf8");
  const digest = createHash("sha256").update(serializedFrame, "utf8").digest("hex").slice(0, 12);
  return `a ${bytes}-byte frame (sha256 ${digest}) whose text is not written to this log: on this `
    + "socket a frame body is on-screen accessibility content — element titles and values, "
    + "sometimes a document's text — and this log's sink is a file this product never sets the mode "
    + "of, so the state root's 0700 does not cover it. Anything the daemon did record is in its "
    + "evidence archive under the state root, read back with gp_last_evidence {operationId} or "
    + "gp_export_evidence {operationId}";
}

/**
 * A single frame *field* quoted into a log line, bounded.
 *
 * A normal request id is a number or a short string, so it is printed exactly as it came —
 * editing the daemon's words would be its own dishonesty. The bound is for the other case: a
 * peer on this socket path that answers with an id-shaped field holding several kilobytes of
 * text would otherwise put that text in the log through the one clause this file still trusted.
 * Over the bound the value is reported by size and digest, the same shape as the frame note.
 */
export function shortFieldValue(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  if (text.length <= LOG_FIELD_CHARS) return text;
  const bytes = Buffer.byteLength(text, "utf8");
  const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
  return `${text.length}-char value (sha256 ${digest}, ${bytes} bytes) not quoted here`;
}

/**
 * The late-reply body clause, authored ONCE so both doorways say the same thing.
 *
 * When a daemon answer lands after its caller's deadline this shell still has to record that
 * it answered, and give an operator a way to correlate that answer with the record that holds
 * it — *without* copying the answer into a log this product does not own. The body on this
 * path is observe/assert content: element titles and values, sometimes a document's text.
 * The state root itself is 0700, but the report sink
 * (stderr, or whatever supervises the process) is a file this product never sets the mode of,
 * so a reply written there leaves the 0700 boundary (review 2026-10-09 finding 3, and the F3
 * fix on 2026-10-27 that moved the HTTP doorway onto this same sentence).
 *
 * The note therefore keeps only the diagnostic facts — the caller's context names the request,
 * and this clause names the method's body by **size** and a short **deterministic** SHA-256
 * digest of the serialized body (the same bytes always hash the same way, so an operator can
 * match a note against the archive that holds it) — and states plainly that the body was not
 * written and where the real content lives: the daemon's evidence archive under the state
 * root, read back with `gp_last_evidence` / `gp_export_evidence`.
 *
 * It takes the *serialized* string, not the value, because each doorway owns how its own
 * transport turns a reply into bytes; hashing that exact string is what makes the digest
 * correlatable. The reverse mutation is to interpolate the body back into a log line.
 */
/**
 * The daemon's own operation-id grammar (`op_` + 26 Crockford base-32 characters),
 * byte-identical to the one `EvidenceStore.isEntryName` and the evidence schema pin.
 * Used only to decide whether an id may be *named* in a log line.
 */
const ARCHIVE_OPERATION_ID = /^op_[0-9A-HJKMNP-TV-Z]{26}$/;

export function lateReplyBodyNote(serializedBody: string, operationId?: unknown): string {
  const bytes = Buffer.byteLength(serializedBody, "utf8");
  const digest = createHash("sha256").update(serializedBody, "utf8").digest("hex").slice(0, 12);
  // The id is the one field of the body that may be written: it is not screen content,
  // it is the archive's own filename stem, and the strict grammar means a value that
  // merely *looks* like an id (or an id-shaped field that holds something else) never
  // reaches the line. Without it the note says "a reply landed" but not which operation
  // it landed for, and the whole point of the digest was correlation.
  const named = typeof operationId === "string" && ARCHIVE_OPERATION_ID.test(operationId)
    ? `, for ${operationId}`
    : "";
  return `with a ${bytes}-byte body (sha256 ${digest})${named} that is on-screen accessibility content `
    + "— element titles and values, sometimes a document's text — so its text is not written to "
    + "this log; the reply itself is in the daemon's evidence archive under the state root, read "
    + "it back with gp_last_evidence {operationId} or gp_export_evidence {operationId}";
}

/**
 * A frame field that says something, or the fallback for the one that says
 * nothing.
 *
 * Absent, null, empty and whitespace-only all read as "the daemon did not state
 * this"; anything else is returned exactly as it came (`String` of it, which is
 * what this function already did for a non-string value). The distinction
 * matters in both directions: defaulting a blank is what keeps an agent-facing
 * error from carrying an empty code, and passing a stated value through
 * unrewritten is what keeps this from becoming a silent editor of the daemon's
 * own words.
 */
function nonBlankOr(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  const text = String(value);
  return text.trim() === "" ? fallback : text;
}

/** Inbound values come from JSON.parse, so serialization cannot throw or cycle. */
function jsonOrString(value: unknown): string {
  return String(JSON.stringify(value));
}

/** The reply's operation id when the body is an object that states one; anything else is absent. */
function operationIdOf(result: unknown): unknown {
  return typeof result === "object" && result !== null
    ? (result as { operationId?: unknown }).operationId
    : undefined;
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
    /** Identity check run before the first byte leaves this process; see {@link trustSocket}. */
    private readonly trust: (target: string) => { code: string; message: string; remedy: string } | null = trustSocket,
  ) {}

  writeLine(line: string, onHandedOff?: () => void): void {
    this.connect().writeLine(line, onHandedOff);
  }

  bufferedBytes(): number {
    // 还没连上时没有积压可报：0 说的是"这一面什么都没堆"，不是"量不出来"。
    return this.inner?.bufferedBytes() ?? 0;
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
    // Trust before traffic: everything below treats a reply as the engine's word, and a socket
    // another account created — or any account may write to — cannot carry that claim. The check
    // runs on the path this process is about to connect to, *before* `open`, so a refusal sends
    // nothing and therefore claims nothing about what the daemon did.
    const untrusted = this.trust(this.socketPath);
    if (untrusted) {
      throw new EngineCallError(untrusted.code, untrusted.message, untrusted.remedy);
    }
    const socket = this.open(this.socketPath);
    const io = new StreamLineIo(socket, socket);
    io.onMessage((line) => this.messageHandler?.(line));
    io.onError((error) => {
      // An oversize frame is a *per-frame* verdict and this transport survives
      // it: `LineReader` discarded exactly the remainder of that one line and
      // resumed at its newline, which is the same shape the daemon's own
      // `FrameCodec` keeps (drop-to-EOL, `discardUntilNewline` cleared, socket
      // still serving). So it is forwarded to the client, which fails only the
      // request that frame belonged to, and the socket is neither forgotten nor
      // closed. Forgetting it here used to close the fd, the close handler ran,
      // and `teardown` answered *every other* in-flight request with
      // `GP_E_ENGINE_UNREACHABLE` plus a remedy ordering a daemon restart — a
      // SIGTERM against a daemon that may be mid-`act` on the user's screen —
      // while the oversize call's own text claimed the connection was intact.
      // One bad frame therefore destroyed unrelated concurrent calls
      // (review 2026-10-09 finding 1). A real transport error still takes the
      // original route below — there the framing *is* lost, so this transport is
      // forgotten first and its socket dropped, and the next call opens a new
      // one rather than writing into a dead fd forever.
      if (!(error instanceof OversizeFrameError) && this.inner === io) {
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
    /** Daemon methods this shell forwards; see {@link EngineJsonRpcClient}'s last parameter. */
    expectedDaemonMethods?: readonly string[];
    /** Seam for {@link trustSocket}; production callers never pass it — the real stat is the default. */
    trust?: (target: string) => { code: string; message: string; remedy: string } | null;
  } = {},
): EngineJsonRpcClient {
  const open: EngineTransportOpener = options.open
    ?? ((target) => net.createConnection(target));
  return new EngineJsonRpcClient(
    new ReconnectingSocketIo(socketPath, open, options.trust ?? trustSocket),
    undefined,
    options.identity ?? null,
    options.callerCeilingMs ?? CALLER_VISIBLE_CEILING_MS,
    options.surface ?? "mcp",
    options.expectedDaemonMethods ?? [],
  );
}

/**
 * Build a client over an existing LineIo (used by tests with a fake
 * transport and by non-socket connectivity).
 */
export function engineClientOver(io: LineIo, timeoutMs?: number): EngineJsonRpcClient {
  return new EngineJsonRpcClient(io, timeoutMs);
}
