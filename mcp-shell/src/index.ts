#!/usr/bin/env node
import fs from "node:fs";
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

/** How long one synchronous wait for a full pipe lasts, and how often it repeats. */
const WRITE_STALL_MS = 10;
const WRITE_STALL_LIMIT = 1_000;

/**
 * Write a whole string to a descriptor and do not return until the kernel has
 * taken all of it.
 *
 * The startup and argument paths below write a message and then call
 * `process.exit()` on the next line. `process.stderr`/`process.stdout` are
 * *asynchronous* whenever the destination is a pipe — which is how every MCP host
 * captures this server, and how every `glasspane-mcp … | tee` runs it — so a
 * `write()` on a piped stream only queues a libuv request, `process.exit()` never
 * runs the loop that would flush it, and the reader is handed a bare exit code
 * with the explanation cut off mid-buffer (measured here: a 256 KiB piped stderr
 * write stops at the 64 KiB pipe capacity, its tail gone). `fs.writeSync` issues a
 * real blocking write instead, and the loop is what carries a message past the pipe
 * capacity rather than assuming one syscall takes it all.
 */
function writeDescriptor(fd: 1 | 2, text: string): void {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  let stalls = 0;
  while (offset < buffer.length) {
    let written: number;
    try {
      written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      // A piped stdio descriptor is *non-blocking* in this process — Node hands
      // the fd to libuv that way as soon as stdout/stderr are pipes, which is how
      // every MCP host and every `glasspane-mcp … | tee` runs it — so once the
      // 64 KiB pipe buffer is full `writeSync` does not wait, it throws `EAGAIN`.
      // Letting that escape killed the process on an uncaught exception (exit 1,
      // message cut at the pipe capacity), and returning quietly would have cut it
      // the same way while claiming the message had gone out. Retry after a short
      // synchronous block so the reader gets its turn, and bound the retries so a
      // pipe nobody drains cannot wedge the exit.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" && stalls < WRITE_STALL_LIMIT) {
        stalls++;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WRITE_STALL_MS);
        continue;
      }
      // EPIPE, EBADF, or the retry ceiling: a descriptor that will not take the
      // message leaves nowhere to report it (the same last resort as `logNote`).
      return;
    }
    // A zero-length return means the descriptor took nothing without saying so;
    // continuing would spin.
    if (written <= 0) {
      return;
    }
    offset += written;
    stalls = 0;
  }
}

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
    // Synchronous, and the whole message: this is the path an operator who
    // misspelled a flag lands on, and a truncated one reads as "the shell printed
    // nothing and exited 2".
    writeDescriptor(2, String(error) + "\n\n" + USAGE);
    process.exit(2);
  }

  if (options.help) {
    writeDescriptor(1, USAGE);
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
  const server = createTrackedMcpServer(engine, logNote).server;

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
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
