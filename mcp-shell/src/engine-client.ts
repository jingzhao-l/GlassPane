import net from "node:net";
import os from "node:os";
import path from "node:path";

import { LineIo, StreamLineIo } from "./io.js";
import { GP_E_ENGINE_UNREACHABLE } from "./errors.js";

/** Env override for the daemon socket path (default below). */
export const ENGINE_SOCKET_ENV = "GLASSPANE_ENGINE_SOCK";
/** Connection/response timeout, per spec §6.2. */
export const ENGINE_TIMEOUT_MS = 10_000;

/** The daemon listens here by default (spec §3.1). */
export function defaultSocketPath(): string {
  return process.env[ENGINE_SOCKET_ENV] ?? path.join(os.homedir(), ".glasspane", "engine.sock");
}

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

interface CallFrame {
  id: number;
  result?: unknown;
  error?: EngineErrorBody;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: EngineCallError) => void;
};

/**
 * Request/response association over a line transport. Kept independent of
 * the transport so tests inject a fake LineIo (spec §7.1 "fake engine
 * transport").
 */
export class EngineJsonRpcClient {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly io: LineIo,
    private readonly timeoutMs: number = ENGINE_TIMEOUT_MS,
  ) {
    this.io.onMessage((line) => this.handleMessage(line));
    this.io.onError((error) => this.failAll(new EngineCallError(
      GP_E_ENGINE_UNREACHABLE,
      `engine transport error: ${error.message}`,
      "ensure the glasspane daemon is running, then retry",
    )));
    this.io.onClose(() => this.failAll(new EngineCallError(
      GP_E_ENGINE_UNREACHABLE,
      "engine transport closed",
      "restart the glasspane daemon and reconnect",
    )));
  }

  /** Send a request and await its matching response frame. */
  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const frame = { id, method, ...(params === undefined ? {} : { params }) };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineCallError(
          GP_E_ENGINE_UNREACHABLE,
          `engine request timed out after ${this.timeoutMs}ms (method ${method})`,
          "check the daemon socket and retry",
        ));
      }, this.timeoutMs);
      timer.unref();

      this.pending.set(id, {
        resolve,
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      this.io.writeLine(JSON.stringify(frame));
    });
  }

  close(): void {
    this.io.close();
  }

  private handleMessage(line: string): void {
    let frame: CallFrame;
    try {
      frame = JSON.parse(line) as CallFrame;
    } catch {
      // Non-JSON response is not attributable to a request id; drop.
      return;
    }
    const entry = this.pending.get(frame.id);
    if (!entry) {
      return; // late/unsolicited frame — drop
    }
    this.pending.delete(frame.id);
    if (frame.error) {
      entry.reject(new EngineCallError(frame.error.code, frame.error.message, frame.error.remedy));
    } else {
      entry.resolve(frame.result);
    }
  }

  private failAll(reason: EngineCallError): void {
    for (const entry of this.pending.values()) {
      entry.reject(reason);
    }
    this.pending.clear();
  }
}

/** Production client bound to a Unix socket path (lazy connect on first call). */
export function unixSocketEngineClient(socketPath: string): EngineJsonRpcClient {
  const socket = net.createConnection(socketPath);
  const io = new StreamLineIo(socket, socket);
  return new EngineJsonRpcClient(io);
}

/**
 * Build a client over an existing LineIo (used by tests with a fake
 * transport and by non-socket connectivity).
 */
export function engineClientOver(io: LineIo, timeoutMs?: number): EngineJsonRpcClient {
  return new EngineJsonRpcClient(io, timeoutMs);
}