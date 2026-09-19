#!/usr/bin/env node
import process from "node:process";

import { canonicalJson } from "./canonical.js";
import { McpServer } from "./dispatch.js";
import {
  defaultSocketPath,
  EngineJsonRpcClient,
  unixSocketEngineClient,
} from "./engine-client.js";
import { LineReader } from "./io.js";

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

/** Serialize async reply ordering so stdout stays a valid sequence of frames. */
class ReplyQueue {
  private tail: Promise<void> = Promise.resolve();

  push(run: () => Promise<void>): void {
    this.tail = this.tail.then(run);
  }
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
  const queue = new ReplyQueue();

  let engine: EngineJsonRpcClient;
  try {
    engine = unixSocketEngineClient(options.socketPath);
  } catch (error) {
    process.stderr.write(
      `failed to create engine client on ${options.socketPath}: ${String(error)}\n`,
    );
    process.exit(2);
  }

  const server = new McpServer({ engine });

  const reader = new LineReader({
    onLine: (line) => {
      queue.push(async () => {
        const response = await server.handleLine(line);
        if (response !== null) {
          process.stdout.write(canonicalJson(response) + "\n");
        }
      });
    },
    onOversize: (bytes) => {
      process.stderr.write(`dropping oversized stdio frame (${bytes} bytes)\n`);
    },
  });

  process.stdin.on("data", (chunk: string) => reader.push(chunk));

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

  process.stdin.on("close", () => queue.push(async () => shutdown()));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();