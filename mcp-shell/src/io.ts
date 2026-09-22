import { Readable, Writable } from "node:stream";

/** Single-frame cap shared with the engine protocol (P0 spec §3.1). */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Leading characters kept of an oversized line. Oversize frames are answered,
 * not just logged (spec §3.1 keeps the connection), so the head must survive:
 * engine replies start `{"id":<n>,…` and MCP requests carry `"id"` early.
 */
export const OVERSIZE_PREFIX_BYTES = 512;

export interface LineSink {
  onLine(line: string): void;
  /**
   * A line crossed the frame cap: reported exactly once, excess dropped,
   * later lines still flowing. Oversize is a per-frame verdict, never a
   * verdict about the connection or about unrelated in-flight requests.
   *
   * @param bytes  total bytes the dropped line carried (cap included)
   * @param prefix leading {@link OVERSIZE_PREFIX_BYTES} characters, for attribution
   */
  onOversize(bytes: number, prefix: string): void;
}

/**
 * Splits a stream on line boundaries, keeping a partial line until its
 * newline arrives (so a JSON message split across chunks still reassembles).
 * Mirrors engine FrameCodec, discard-then-resume included: one huge line
 * cannot grow this buffer without bound.
 */
export class LineReader {
  private buffer = "";
  /** UTF-8 bytes seen for the line in progress (counted, not all retained). */
  private bytes = 0;
  /** The line in progress already blew the cap; only the head is retained. */
  private discarding = false;

  constructor(private readonly sink: LineSink) {}

  /** @param chunk UTF-8 text fragment received from the stream. */
  push(chunk: string): void {
    let rest = chunk;
    while (rest.length > 0) {
      const nl = rest.indexOf("\n");
      const closed = nl !== -1;
      this.consume(closed ? rest.slice(0, nl) : rest);
      rest = closed ? rest.slice(nl + 1) : "";
      if (closed) {
        this.deliver();
      }
    }
  }

  /** Partial line so far; only the retained head while a line is discarded. */
  pendingText(): string {
    return this.buffer;
  }

  private consume(segment: string): void {
    if (segment.length === 0) {
      return;
    }
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (this.discarding) {
      this.bytes += segmentBytes;
      return;
    }
    if (this.bytes + segmentBytes > MAX_FRAME_BYTES) {
      this.discarding = true;
      this.buffer = this.buffer.length >= OVERSIZE_PREFIX_BYTES
        ? this.buffer.slice(0, OVERSIZE_PREFIX_BYTES)
        : (this.buffer + segment).slice(0, OVERSIZE_PREFIX_BYTES);
      this.bytes += segmentBytes;
      return;
    }
    this.buffer += segment;
    this.bytes += segmentBytes;
  }

  private deliver(): void {
    const line = this.buffer;
    const bytes = this.bytes;
    const oversize = this.discarding;
    this.buffer = "";
    this.bytes = 0;
    this.discarding = false;
    if (oversize) {
      this.sink.onOversize(bytes, line);
    } else {
      this.sink.onLine(line);
    }
  }
}

/**
 * An inbound frame crossed the cap. It travels on the error channel only so
 * `LineIo` keeps its shape; it is explicitly *not* a dead connection — the
 * reader stays usable and just the request it belonged to fails (spec §3.1).
 */
export class OversizeFrameError extends Error {
  readonly bytes: number;
  readonly prefix: string;

  constructor(bytes: number, prefix: string) {
    super(`frame exceeds ${MAX_FRAME_BYTES} bytes (${bytes} received)`);
    this.name = "OversizeFrameError";
    this.bytes = bytes;
    this.prefix = prefix;
  }
}

/**
 * `"id"` must be *complete* inside the retained head to be trustworthy: a
 * number cut at the boundary would attribute a frame to the wrong request, so
 * the digit run has to end at whitespace, a comma or a brace.
 */
const FRAME_ID_PATTERN = /"id"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+)(?=[\s,}]))/;

/**
 * Best-effort `"id"` recovery from a truncated frame head, so an unframed
 * reply or request can still be answered instead of hanging. Null when the id
 * is absent, or when reading it would mean guessing.
 */
export function recoverFrameId(prefix: string): number | string | null {
  const match = FRAME_ID_PATTERN.exec(prefix);
  if (!match) {
    return null;
  }
  const quoted = match[1];
  if (quoted !== undefined) {
    try {
      return JSON.parse(`"${quoted}"`) as string;
    } catch {
      return null;
    }
  }
  const digits = match[2];
  if (digits === undefined) {
    return null;
  }
  const numeric = Number(digits);
  return Number.isSafeInteger(numeric) ? numeric : digits;
}

/**
 * Low-level line I/O boundary used by the engine client. Production uses
 * a Unix socket; tests inject an in-memory fake transport.
 */
export interface LineIo {
  writeLine(line: string): void;
  onMessage(handler: (line: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
  /**
   * Optional: transports that can open more than once (a reconnecting socket)
   * announce each established connection, which is what lets the client
   * re-handshake instead of assuming the old peer.
   */
  onOpen?(handler: () => void): void;
  close(): void;
}

/**
 * Wraps a Node Stream as a line-oriented transport. Calls encode the plain
 * newline-delimited frames the daemon speaks (Section 3.1).
 */
export class StreamLineIo implements LineIo {
  private readonly reader: LineReader;
  private messageHandler: ((line: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;

  constructor(
    readonly input: Readable,
    private readonly output: Writable,
  ) {
    this.reader = new LineReader({
      onLine: (line) => this.messageHandler?.(line),
      onOversize: (bytes, prefix) => this.errorHandler?.(new OversizeFrameError(bytes, prefix)),
    });
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.reader.push(chunk));
    input.on("close", () => this.closeHandler?.());
    input.on("error", (error) => this.errorHandler?.(error));
  }

  writeLine(line: string): void {
    this.output.write(line + "\n");
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

  close(): void {
    this.input.destroy();
  }
}

/**
 * Serialize async replies so a byte stream stays a valid sequence of frames.
 * A rejected reply must not poison the chain: without the catch the tail
 * stays rejected forever and every later reply silently never runs — one bad
 * request turning into a server that stops answering altogether.
 */
export class OrderedReplyQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly report: (error: unknown) => void) {}

  push(run: () => Promise<void>): void {
    this.tail = this.tail.then(run).catch((error) => {
      this.report(error);
    });
  }

  /** Resolves once everything queued so far has been attempted. */
  drained(): Promise<void> {
    return this.tail;
  }
}

/**
 * Writes with backpressure honoured and a dead pipe survived: an ignored
 * `write()` return lets replies pile up in memory, and an unlistened `error`
 * (EPIPE when the MCP client goes away) kills the process outright.
 */
export class DrainAwareWriter {
  private dead: Error | null = null;

  constructor(
    private readonly sink: Writable,
    private readonly report: (note: string) => void,
    private readonly drainWaitMs: number,
    private readonly onDead: (error: Error) => void,
  ) {
    sink.on("error", (error) => {
      if (this.dead) {
        return;
      }
      this.dead = error;
      this.report(`output stream failed, further replies cannot be delivered: ${error.message}`);
      this.onDead(error);
    });
  }

  get failed(): boolean {
    return this.dead !== null;
  }

  /** @param text already framed, including its trailing newline. */
  async write(text: string): Promise<boolean> {
    if (this.failed) {
      return false;
    }
    let flowing = true;
    try {
      flowing = this.sink.write(text);
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      this.dead = reason;
      this.report(`write failed: ${reason.message}`);
      this.onDead(reason);
      return false;
    }
    return flowing ? true : this.waitForDrain();
  }

  private waitForDrain(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        this.sink.removeListener("drain", onDrain);
        resolve(value);
      };
      const onDrain = () => finish(true);
      // Unlike the engine request deadline this timer only bounds a *report*,
      // so it must not be able to hold the event loop open on its own.
      timer = setTimeout(() => {
        finish(false);
        this.report(`output has not drained within ${this.drainWaitMs}ms — the reader on the other end stopped consuming; later replies queue behind this one instead of buffering without bound`);
      }, this.drainWaitMs);
      timer.unref();
      this.sink.on("drain", onDrain);
    });
  }
}
