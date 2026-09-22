#!/usr/bin/env node
import process from "node:process";

import { canonicalJson } from "./canonical.js";
import { INVALID_REQUEST, JSONRPC, McpServer, SERVER_INFO } from "./dispatch.js";
import {
  defaultSocketPath,
  EngineJsonRpcClient,
  GP_E_PAYLOAD_TOO_LARGE,
  unixSocketEngineClient,
} from "./engine-client.js";
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

const USAGE = `usage: glasspane-mcp [--socket-path <path>]

Bridges an AI agent (MCP stdio) to the GlassPane engine daemon.
The daemon socket defaults to $HOME/.glasspane/engine.sock
(override with GLASSPANE_ENGINE_SOCK or --socket-path).
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

  const writeResponse = async (response: unknown): Promise<void> => {
    await replies.write(canonicalJson(response) + "\n");
  };

  const reader = new LineReader({
    onLine: (line) => {
      queue.push(async () => {
        const response = await server.handleLine(line);
        if (response !== null) {
          await writeResponse(response);
        }
      });
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
  process.stdin.on("close", () => queue.push(async () => shutdown()));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
