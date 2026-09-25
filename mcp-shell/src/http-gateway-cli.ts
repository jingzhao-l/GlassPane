#!/usr/bin/env node
import process from "node:process";

import { defaultSocketPath } from "./engine-client.js";
import {
  createHttpGateway,
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  GLASSPANE_HTTP_TOKEN_ENV,
  type HttpGateway,
} from "./http-gateway.js";

/**
 * Standalone entry for the HTTP/REST gateway (bin `glasspane-http`). Reads the
 * bearer token from `GLASSPANE_HTTP_TOKEN` and refuses to start without it
 * (security red line: no defaulted or hard-coded token), binds 127.0.0.1 only,
 * and shuts down cleanly on SIGINT/SIGTERM (close the engine client and the
 * HTTP server, exit 0).
 */

/** The gateway never listens on a wildcard interface. */
const HOST = DEFAULT_GATEWAY_HOST;

interface CliOptions {
  socketPath: string;
  port: number;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { socketPath: defaultSocketPath(), port: DEFAULT_GATEWAY_PORT, help: false };
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
    } else if (arg === "--port" || arg === "-p") {
      const raw = argv[i + 1]!;
      const value = Number(raw);
      if (raw === undefined || !Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error("--port requires an integer between 0 and 65535");
      }
      options.port = value;
      i += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = Number(arg.slice("--port=".length));
    }
  }
  return options;
}

const USAGE = `usage: glasspane-http [--socket-path <path>] [--port <n>]

Exposes the GlassPane engine as an HTTP/REST gateway on ${HOST} only.

Lifetime and auth:
  - GLASSPANE_HTTP_TOKEN <token> is required and read from the environment;
    the gateway refuses to start without it (enforced, never defaulted).
  - SIGINT / SIGTERM shut the gateway down cleanly (close the engine client
    and the HTTP server, then exit 0).

Socket, in the order this process resolves it:
  1. --socket-path <path>
  2. GLASSPANE_ENGINE_SOCK=<path>
  3. $HOME/.glasspane/engine.sock (same guess policy as glasspane-mcp)
`;

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

  const token = process.env[GLASSPANE_HTTP_TOKEN_ENV];
  if (typeof token !== "string" || token === "") {
    process.stderr.write(
      `${GLASSPANE_HTTP_TOKEN_ENV} is not set or is empty; refusing to start an unauthenticated gateway.\n\n${USAGE}`,
    );
    process.exit(2);
  }

  let gateway: HttpGateway;
  try {
    gateway = createHttpGateway({
      socketPath: options.socketPath,
      token,
      port: options.port,
      host: HOST,
    });
  } catch (error) {
    process.stderr.write(`failed to start the HTTP gateway: ${String(error)}\n`);
    process.exit(2);
  }

  gateway.server.once("listening", () => {
    const address = gateway.server.address();
    const bound = typeof address === "object" && address !== null
      ? `${address.address}:${address.port}`
      : String(address);
    process.stderr.write(`[glasspane-http] listening on http://${bound}\n`);
    process.stderr.write(`[glasspane-http] bridging daemon socket ${options.socketPath}\n`);
  });
  gateway.server.on("error", (error) => {
    process.stderr.write(`[glasspane-http] server error: ${String(error)}\n`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(`[glasspane-http] received ${signal}; shutting down\n`);
    gateway.close().then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`[glasspane-http] error during shutdown: ${String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
