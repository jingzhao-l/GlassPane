import process from "node:process";

import { canonicalJson } from "./canonical.js";
import {
  createTrackedMcpServer,
  INVALID_REQUEST,
  JSONRPC,
  SERVER_INFO,
} from "./dispatch.js";
import {
  defaultSocketPath,
  EngineJsonRpcClient,
  refuseEmptySocketPath,
  unixSocketEngineClient,
} from "./engine-client.js";
import { GP_E_PAYLOAD_TOO_LARGE } from "./errors.js";
import { DAEMON_FORWARDED_METHODS } from "./tools.js";
import {
  DrainAwareWriter,
  LineReader,
  MAX_FRAME_BYTES,
  OrderedReplyQueue,
  recoverFrameId,
  // The exit-adjacent writer: both places below print a message and call
  // `process.exit()` on the next line, and a piped stderr write that has not been
  // handed to the kernel is gone with the process. It lives in `io.ts` because the
  // other entrypoint (`http-gateway-cli.ts`) has the same exit paths.
  writeDescriptor,
} from "./io.js";

/**
 * The stdio session's wiring, as a library rather than as a script.
 *
 * This split exists because `src/index.ts` is both the package's root export and
 * the `glasspane-mcp` bin, and it calls `main()` at import: `import
 * "glasspane-mcp"` therefore took over whatever process did it — the bin and the
 * library were the same file, and the library half had no way to say "wire me up"
 * without also saying "hijack my stdin and stdout now". (Everything below only
 * touches `process.stdin`/`process.stdout` when {@link startStdioServer} is
 * called; importing this module touches neither.)
 *
 * The other candidate — an `argv[1]`/`require.main` self-exec guard on `index.ts` —
 * is barred by history, not by taste: that guard is what made the bin resolve to a
 * module the guard decided not to run, and 0-byte'd the published package across 19
 * versions. A split cannot fail that way, because nothing decides whether to run:
 * `index.ts` calls `main()`, and anything that wants the wiring without the
 * side effects imports this file.
 */

export interface CliOptions {
  socketPath: string;
  help: boolean;
}

/**
 * The socket a call lands on, in the order the shell actually resolves it. The
 * third line is a *guess made from this process's HOME* and must be worded as
 * one: `glasspaned`'s own default is the per-user home folder as the system
 * reports it (`StateRoot.homeDefault()`, which does not follow a caller-set
 * `HOME` — the same non-inheritance this project has already lost data to), and
 * a daemon started with `--state-dir` binds `<state-dir>/daemon.sock` where no
 * `HOME` value points. `defaultSocketPath` carries the full reason.
 */
export const USAGE = `usage: glasspane-mcp [--socket-path <path>]

Bridges an AI agent (MCP stdio) to the GlassPane engine daemon.

Socket, in the order this shell resolves it:
  1. --socket-path <path>
  2. GLASSPANE_ENGINE_SOCK=<path>
  3. $HOME/.glasspane/engine.sock — a guess read from this process's HOME, not
     the daemon's rule: glasspaned's own default is the home folder the system
     reports, which a HOME you export does not move, and glasspaned --state-dir
     <dir> serves <dir>/daemon.sock instead.

So "nothing is listening on the default path" means this shell guessed a
different directory, not that the daemon is dead. Connect to the socket the
daemon is really on — read it, do not re-derive it:
  launchctl print gui/$(id -u)/com.glasspane.daemon      # the installed job's --socket-path value
  glasspane-mcp --socket-path <that path>                 # or, equivalently:
  GLASSPANE_ENGINE_SOCK=<that path> glasspane-mcp
A daemon started by hand with --state-dir has no launchd job to read: pass it
<state-dir>/daemon.sock.
`;

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { socketPath: defaultSocketPath(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--socket-path" || arg === "-s") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--socket-path requires a value");
      }
      refuseEmptySocketPath(value, arg);
      options.socketPath = value;
      i += 1;
    } else if (arg.startsWith("--socket-path=")) {
      const value = arg.slice("--socket-path=".length);
      refuseEmptySocketPath(value, "--socket-path");
      options.socketPath = value;
    } else {
      // 认不出的参数必须当场拒绝。从前这里什么都不做：`--socket-pth /tmp/x` 会被
      // 静默丢掉，壳照旧连到它自己猜出来的那个默认根，而操作者以为自己点名了另一个
      // daemon。连错 daemon 意味着 act 落在别的 app、别的机器上——这一句 `else`
      // 是这条通路唯一还在说话的机会。位置参数同理：它多半是一个打错的开关。
      throw new Error(
        `unknown argument: ${arg}\n${USAGE}\n`
        + "This shell accepts only --help/-h and --socket-path/-s <path>. "
        + "A flag spelled wrong here is not an error the daemon will ever report.",
      );
    }
  }
  return options;
}

/** How long a blocked stdout may stay blocked before the stall is reported. */
const DRAIN_WAIT_MS = 30_000;

/** stderr is the only logging channel an MCP stdio server may use freely. */
function logNote(text: string): void {
  try {
    process.stderr.write(`[glasspane-mcp] ${text}\n`);
  } catch {
    // A stderr that cannot take a log line leaves nowhere to report; this is
    // the last resort for a dead pipe, not a handler for engine errors.
  }
}

/**
 * JSON-RPC answer to a request frame that could not be framed at all.
 *
 * One fact, said once: the inbound bytes exceeded the frame cap, so nothing in them ever
 * became a request this shell could validate. The numeric code is therefore the JSON-RPC
 * class that fact genuinely is — `INVALID_REQUEST`, "the JSON sent is not a valid Request
 * object" — and `GP_E_PAYLOAD_TOO_LARGE` rides in the message as *this shell's name for the
 * same frame*, the label the tool and HTTP surfaces carry and the one the daemon uses at its
 * own end of the socket (`Dispatcher.swift` answers its `.oversize` case with it, and
 * `errors.ts` says the two sides share the code on purpose).
 *
 * The message used to lead with that label as though it were the verdict the numeric code
 * carried, which made one answer state two conditions and disagree with itself. JSON-RPC's
 * numeric space has no payload-too-large class and this shell is not going to mint one —
 * `test/published-artifact.test.mjs` pins both halves an installed bundle answers with — so
 * the fix is the wording: the code names the class, the message names the same class first
 * and then the label, and `test/qoder-20261019-oversize-frame-code.test.mjs` pins that the
 * two still describe one frame.
 */
export function tooLargeResponse(id: number | string | null): unknown {
  return {
    jsonrpc: JSONRPC,
    id,
    error: {
      code: INVALID_REQUEST,
      message: `Invalid Request: the inbound frame exceeds the ${MAX_FRAME_BYTES}-byte frame cap, so nothing in it `
        + "was ever a JSON-RPC request this shell could parse or validate — the same frame the numeric code above "
        + `calls an invalid request, and ${GP_E_PAYLOAD_TOO_LARGE} is the code this shell (and the daemon) use for `
        + "that same frame rather than a second verdict on it | remedy: shrink this request — cap observe maxDepth "
        + "and keep argument strings within their schema limits",
    },
  };
}

/**
 * Run the stdio session: read framed requests from `process.stdin`, answer them
 * on `process.stdout`, bridge to the daemon socket named in `options`.
 *
 * A startup failure still exits the process (2), exactly as it did when this body
 * lived in `index.ts` — the bin's contract with whoever spawned it is unchanged by
 * the split. What changed is only that nothing here runs until something asks for
 * it, so the wiring is now reachable from a test, and from a host that wants to
 * embed the session rather than be replaced by it.
 */
export function startStdioServer(options: CliOptions): void {
  process.stdin.setEncoding("utf8");

  let engine: EngineJsonRpcClient;
  try {
    // Lazy connect, and reconnect on demand once a previous socket is gone:
    // the daemon may restart underneath this session (that is what
    // --restore-launchd is for), so "the socket closed" must never become a
    // permanent condition that contradicts the remedy we hand out.
    engine = unixSocketEngineClient(options.socketPath, {
      identity: { version: SERVER_INFO.version },
      // `hello.capabilities` 的读者在这一层接线：清单由 daemon 派生、由这里与 TOOL_SPECS
      // 对账，两边谁漂了都会有人说，而不是各自安静地活着。
      expectedDaemonMethods: DAEMON_FORWARDED_METHODS,
    });
  } catch (error) {
    writeDescriptor(
      2,
      `failed to create engine client on ${options.socketPath}: ${String(error)}\n`,
    );
    process.exit(2);
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    engine.close();
    process.stdin.destroy();
    process.stdout.end();
  };

  const replies = new DrainAwareWriter(process.stdout, logNote, DRAIN_WAIT_MS, () => shutdown());
  const queue = new OrderedReplyQueue((error) => logNote(`reply failed: ${String(error)}`));
  engine.onEngineNote(logNote);

  // One shared audit session plus the late-reply sink; see
  // `createTrackedMcpServer` for why that wiring is a production seam and not
  // four lines in here.
  const server = createTrackedMcpServer(engine, logNote, () => replies.droppedFrames).server;

  /** One framed reply on stdout; a notification/blank line has none to write. */
  const writeResponse = async (response: unknown): Promise<void> => {
    if (response === null) {
      return;
    }
    // The id is handed to the writer so a dropped reply names which request was
    // lost, and the boolean is not discarded: `false` means this reply will never
    // reach stdout, which `gp_diagnose` then surfaces from the writer's counter.
    const id = (response as { id?: number | string | null }).id;
    await replies.write(canonicalJson(response) + "\n", id);
  };

  const reader = new LineReader({
    onLine: (line) => {
      // B-02: `handleLine` is started here, not inside the queue, so a request
      // that awaits the daemon cannot stop `ping`, `tools/list` or
      // `gp_probe_status` from being served. `pushDelivery` serialises only the
      // write of each finished frame — one frame at a time on the byte stream,
      // replies in completion order, paired by the JSON-RPC id each carries.
      //
      // What that split deliberately leaves *out* of the completion order is the
      // `EvidenceAuditSession`. Its `reset()`/`record()` run after an `await`,
      // so ordering them through this queue would order them by completion, and
      // the trail a later `gp_recent_reports` reads would depend on which daemon
      // reply landed first. `tools.ts` therefore claims a trail turn
      // synchronously when `executeTool` is entered — which happens inside the
      // synchronous prefix of the `handleLine` call on the next line, i.e. in the
      // order the frames arrived — so the trail is mutated and read in *request*
      // order while the engine calls and these replies keep flowing freely
      // (`tools.test.mjs`: "an act admitted after an attach keeps its trail
      // entry…"). Do not fold the two back together: this queue is for bytes,
      // the trail turn is for `operationIds`, and only the second one has an
      // order the agent acts on — a trail that lost an act tells it to click
      // again.
      queue.pushDelivery(server.handleLine(line), writeResponse);
    },
    onOversize: (bytes, prefix) => {
      // An oversize frame keeps the connection open (spec §3.1), and the
      // client that sent a request must not wait forever for an answer that
      // is never going to come: recover the id from the retained head and
      // answer that one request instead of only writing to the log.
      const id = recoverFrameId(prefix);
      queue.push(async () => {
        logNote(`dropped oversized stdio frame (${bytes} bytes); request ${JSON.stringify(id)} answered as too large`);
        await writeResponse(tooLargeResponse(id));
      });
    },
  });

  process.stdin.on("data", (chunk: string) => reader.push(chunk));
  process.stdin.on("error", (error) => {
    logNote(`stdin failed: ${error.message}`);
    // Queued exactly like the `close` path below, and that agreement is the whole
    // fix. `shutdown()` ends the engine client and calls `stdout.end()`; run
    // straight from this handler it jumped *ahead* of the replies `queue` had
    // already taken but not yet written, so each one landed on an ended stream —
    // write-after-end, dropped, and the caller held nothing while the daemon had
    // really answered. The close path already knew a shutdown has to wait its turn
    // behind pending bytes (review 2026-10-09 finding 7).
    queue.push(async () => shutdown());
  });
  // The queue now orders writes only, so an in-flight request is not part of
  // this chain: stdin closing tears the session down while the daemon may still
  // be working on a request whose client has already gone away.
  process.stdin.on("close", () => queue.push(async () => shutdown()));
  // Signals join the stdin error/close paths in `queue.push`, for the reason
  // documented there: `shutdown()` ends stdout, and run straight from a signal
  // handler it jumped ahead of the replies the queue had already taken but not yet
  // written — the same loss finding 7 closed on stdin, reachable instead through
  // Ctrl-C. A signal now waits its turn behind the bytes in flight.
  process.on("SIGINT", () => queue.push(async () => shutdown()));
  process.on("SIGTERM", () => queue.push(async () => shutdown()));
}
