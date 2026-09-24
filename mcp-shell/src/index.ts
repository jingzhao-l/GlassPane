#!/usr/bin/env node
import process from "node:process";

import { canonicalJson } from "./canonical.js";
import { INVALID_REQUEST, JSONRPC, McpServer, SERVER_INFO } from "./dispatch.js";
import {
  defaultSocketPath,
  EngineJsonRpcClient,
  unixSocketEngineClient,
} from "./engine-client.js";
import { GP_E_PAYLOAD_TOO_LARGE } from "./errors.js";
import {
  DrainAwareWriter,
  LineReader,
  MAX_FRAME_BYTES,
  OrderedReplyQueue,
  recoverFrameId,
} from "./io.js";

interface CliOptions {
  socketPath: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
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
      options.socketPath = value;
      i += 1;
    } else if (arg.startsWith("--socket-path=")) {
      options.socketPath = arg.slice("--socket-path=".length);
    }
  }
  return options;
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
const USAGE = `usage: glasspane-mcp [--socket-path <path>]

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

/** JSON-RPC answer to a request frame that could not be framed at all. */
function tooLargeResponse(id: number | string | null): unknown {
  return {
    jsonrpc: JSONRPC,
    id,
    error: {
      code: INVALID_REQUEST,
      message: `${GP_E_PAYLOAD_TOO_LARGE}: the request frame exceeds the ${MAX_FRAME_BYTES}-byte limit | remedy: shrink this request — cap observe maxDepth and keep argument strings within their schema limits`,
    },
  };
}

function main(): void {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(String(error) + "\n\n" + USAGE);
    process.exit(2);
  }

  if (options.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  process.stdin.setEncoding("utf8");

  let engine: EngineJsonRpcClient;
  try {
    // Lazy connect, and reconnect on demand once a previous socket is gone:
    // the daemon may restart underneath this session (that is what
    // --restore-launchd is for), so "the socket closed" must never become a
    // permanent condition that contradicts the remedy we hand out.
    engine = unixSocketEngineClient(options.socketPath, {
      identity: { version: SERVER_INFO.version },
    });
  } catch (error) {
    process.stderr.write(
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

  const server = new McpServer({ engine });

  /** One framed reply on stdout; a notification/blank line has none to write. */
  const writeResponse = async (response: unknown): Promise<void> => {
    if (response === null) {
      return;
    }
    await replies.write(canonicalJson(response) + "\n");
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
    shutdown();
  });
  // The queue now orders writes only, so an in-flight request is not part of
  // this chain: stdin closing tears the session down while the daemon may still
  // be working on a request whose client has already gone away.
  process.stdin.on("close", () => queue.push(async () => shutdown()));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
