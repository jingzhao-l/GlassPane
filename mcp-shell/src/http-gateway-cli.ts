#!/usr/bin/env node
import process from "node:process";

import { defaultSocketPath, CALLER_VISIBLE_CEILING_MS } from "./engine-client.js";
import {
  createHttpGateway,
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  GLASSPANE_HTTP_TOKEN_ENV,
  MIN_TOKEN_CHARS,
  MIN_TOKEN_DISTINCT_CHARS,
  type HttpGateway,
} from "./http-gateway.js";

/**
 * Standalone entry for the HTTP/REST gateway (bin `glasspane-http`). Reads the
 * bearer token from `GLASSPANE_HTTP_TOKEN` and refuses to start without one that
 * meets the credential policy below (security red line: no defaulted or
 * hard-coded token, and no 4-character one either), binds 127.0.0.1 only, treats
 * a failed bind as fatal, and shuts down cleanly on SIGINT/SIGTERM (close the
 * engine client and the HTTP server, exit 0).
 */

/** The gateway never listens on a wildcard interface. */
const HOST = DEFAULT_GATEWAY_HOST;

/** Bad configuration (no token, unparsable arguments): the process never started. */
const EXIT_CONFIG = 2;
/**
 * The socket could not be bound. A distinct code, because the two conditions need
 * different answers: a configuration refusal is fixed by editing the environment,
 * while a failed bind leaves a *live-looking* process that is serving nothing —
 * see the fatal listener below.
 */
const EXIT_LISTEN_FAILED = 3;

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

Exposes the GlassPane engine as an HTTP/REST gateway on ${HOST} only (a loopback
bind is enforced at startup; this process never listens anywhere else).

Lifetime and auth:
  - GLASSPANE_HTTP_TOKEN <token> is required and read from the environment;
    the gateway refuses to start without it (enforced, never defaulted).
  - The token has to be at least ${MIN_TOKEN_CHARS} characters drawn from at least
    ${MIN_TOKEN_DISTINCT_CHARS} distinct ones — it is the only credential between whoever can
    reach this port and the act/restore surface, and there is no TLS here. Make
    one with: openssl rand -hex 16
  - No engine request is answered later than ${CALLER_VISIBLE_CEILING_MS}ms after it was sent; past that
    the caller gets 504, and while this gateway still tracks the request its reply is
    written to this stderr when it lands — the operationId on that line is what
    GET /v1/evidence/<operationId> takes, and this gateway keeps no trail of its own.
  - SIGINT / SIGTERM shut the gateway down cleanly (close the engine client
    and the HTTP server, then exit 0). A port this process cannot bind is fatal
    (exit ${EXIT_LISTEN_FAILED}): a gateway that is not listening must not look alive.

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
    process.exit(EXIT_CONFIG);
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
    process.exit(EXIT_CONFIG);
  }
  // Stated here as well as enforced by `createHttpGateway`, because an operator
  // needs the number and the command that satisfies it, not a stack trace: this
  // token guards a surface that presses keys on someone's screen, and a short one
  // is guessable at loopback speed by any local process.
  const chars = [...token];
  const distinct = new Set(chars).size;
  if (chars.length < MIN_TOKEN_CHARS || distinct < MIN_TOKEN_DISTINCT_CHARS) {
    process.stderr.write(
      `${GLASSPANE_HTTP_TOKEN_ENV} is ${chars.length} character(s) drawn from ${distinct} distinct one(s); `
      + `refusing to start with a credential under the ${MIN_TOKEN_CHARS}-character / `
      + `${MIN_TOKEN_DISTINCT_CHARS}-distinct-character minimum (make one with "openssl rand -hex 16").\n\n${USAGE}`,
    );
    process.exit(EXIT_CONFIG);
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
    process.exit(EXIT_CONFIG);
  }

  gateway.server.once("listening", () => {
    const address = gateway.server.address();
    const bound = typeof address === "object" && address !== null
      ? `${address.address}:${address.port}`
      : String(address);
    process.stderr.write(`[glasspane-http] listening on http://${bound}\n`);
    process.stderr.write(`[glasspane-http] bridging daemon socket ${options.socketPath}\n`);
  });
  // A failed bind is fatal, and was not. `server.listen()` reports its failure as
  // an `error` event rather than a throw, and this handler logged one line and
  // carried on: with the bind failed there was nothing left holding the event loop,
  // so the process printed nothing further and exited 0 as if it had served.
  // Meanwhile whoever bound the port first answers everything sent to it —
  // including this process's bearer token, replayed back at them by any client
  // that follows a "read this gateway's stderr" remedy — while the real gateway
  // never served a single request. Report what could not be bound, name what it
  // means, and leave.
  gateway.server.on("error", (error: NodeJS.ErrnoException) => {
    const code = typeof error.code === "string" ? error.code : "unknown error code";
    const detail = typeof error.message === "string" ? error.message : "no message";
    process.stderr.write(
      `[glasspane-http] FATAL: the gateway is not serving and this process is exiting — `
      + `could not bind ${HOST}:${options.port} (${code}: ${detail}).\n`
      + (code === "EADDRINUSE"
        ? `[glasspane-http] another process already holds that port: nothing is being forwarded to the daemon socket `
          + `${options.socketPath}, and this gateway answers no requests. Point your client at the process that owns `
          + `the port, or free it and start this one again on a port it can bind (--port <n>).\n`
        : `[glasspane-http] nothing is being forwarded to the daemon socket ${options.socketPath}. Free the address `
          + `or choose another --port <n>, then start this gateway on a port it can bind.\n`)
      + `[glasspane-http] the daemon is not implicated by this line: do not restart it on the strength of it.\n`,
    );
    process.exit(EXIT_LISTEN_FAILED);
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
