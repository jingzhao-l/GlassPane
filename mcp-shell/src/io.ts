import { Readable, Writable } from "node:stream";
import fs from "node:fs";

/**
 * How long one synchronous wait for a full pipe lasts, and how often it repeats.
 */
const WRITE_STALL_MS = 10;
const WRITE_STALL_LIMIT = 1_000;

/**
 * Write a whole string to a descriptor and do not return until the kernel has
 * taken all of it.
 *
 * This is the writer for a message printed and then followed by
 * `process.exit()`. `process.stderr`/`process.stdout` are *asynchronous* whenever
 * the destination is a pipe — which is how every MCP host captures this server,
 * and how every `glasspane-mcp … | tee` or every launchd-redirected run reads it —
 * so a `write()` on a piped stream only queues a libuv request, `process.exit()`
 * never runs the loop that would flush it, and the reader is handed a bare exit
 * code with the explanation cut off mid-buffer (measured in `index.ts` and carried
 * here: a 256 KiB piped stderr write stops at the 64 KiB pipe capacity, its tail
 * gone). `fs.writeSync` issues a real blocking write instead, and the retry loop is
 * what carries a message past the pipe capacity rather than assuming one syscall
 * takes it all.
 *
 * Both entrypoints need it, so it lives in the module they both already import:
 * the stdio shell prints its usage and startup failures this way, and
 * `glasspane-http` prints its configuration refusals, its token refusals and — the
 * one that matters most to an operator — its FATAL "the gateway is not serving"
 * block immediately before `process.exit(3)`.
 *
 * The bound is deliberate: a descriptor that will not take the message (EPIPE,
 * EBADF, or a pipe nobody drains for {@link WRITE_STALL_LIMIT} rounds) leaves
 * nowhere to report the failure, so the write gives up rather than wedging the
 * exit. A caller on a *live* path — a server that keeps running — pays that stall
 * budget up front instead, which is why these sites are the exit-adjacent ones.
 */
export function writeDescriptor(fd: 1 | 2, text: string): void {
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
      // message leaves nowhere to report it (the same last resort as the shell's
      // `logNote`).
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
  /**
   * 已经交给内核、还没被对端读走的字节数。可选：只有真的接在一条 socket/pipe 上
   * 的传输量得出这个数。
   *
   * 它存在的理由是 `writeLine` 不看 `output.write()` 的返回值（stdio 那一侧有
   * `DrainAwareWriter` 管背压，引擎这一侧从前没有）：daemon 停止读 socket 时，
   * Node 会把写进去的帧无上限地堆在进程内存里，调用方只看到"还没回"，
   * 而这一面已经悄悄替它攒了几百 MB。有了这个数，客户端可以选择**不再接活**。
   */
  bufferedBytes?(): number;
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

  bufferedBytes(): number {
    return this.output.writableLength;
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

  /**
   * Order the *writing* of a reply that is produced elsewhere. `push()` above
   * serialises everything its callback does, so a request awaiting the daemon
   * also stops every later request from starting: an outstanding `act` swallowed
   * `ping`, `tools/list` and the `gp_probe_status` the timeout remedy tells the
   * agent to call, the client's own timeout fired first, and the agent re-issued
   * the click (B-02). This variant runs `inFlight` immediately and joins the
   * chain when the value exists — one frame on the byte stream at a time,
   * replies in completion order, paired by the JSON-RPC `id` each carries.
   *
   * Both outcomes are taken at call time, so a request that fails while earlier
   * replies are still being written is reported here instead of surfacing as an
   * unhandled rejection.
   */
  pushDelivery<T>(inFlight: Promise<T>, deliver: (value: T) => Promise<void>): void {
    inFlight.then(
      (value) => this.push(() => deliver(value)),
      (error: unknown) => this.report(error),
    );
  }

  /** Resolves once everything queued so far has been attempted. */
  drained(): Promise<void> {
    return this.tail;
  }
}

/**
 * 回包在 stdout 队列里允许的积压上限。镜像方向的同一件事早就有闸（`engine-client.ts` 的
 * `ENGINE_WRITE_BACKLOG_BYTES` + 自己的错误码），stdio 这一侧却只说过"有 DrainAwareWriter
 * 管背压"——串行化不等于**有界**：30s 的 drain 看门狗一响，后面的 `write()` 照样继续往
 * Node 的队列里塞，一个不读了客户端就能把 `gp_recent_reports`（20 × 4 MiB，且这层没有
 * 出站帧长上限）变成无界内存。到线就丢这一帧、点名丢了谁、说清为什么，比让进程被 OOM
 * 杀掉后再也答不出第 21 条更好。
 */
export const STDIO_WRITE_BACKLOG_BYTES = 32 * 1024 * 1024;

/**
 * Writes with backpressure honoured and a dead pipe survived: an ignored
 * `write()` return lets replies pile up in memory, and an unlistened `error`
 * (EPIPE when the MCP client goes away) kills the process outright.
 */
export class DrainAwareWriter {
  private dead: Error | null = null;
  private dropped = 0;

  constructor(
    private readonly sink: Writable,
    private readonly report: (note: string) => void,
    private readonly drainWaitMs: number,
    private readonly onDead: (error: Error) => void,
    private readonly backlogLimitBytes: number = STDIO_WRITE_BACKLOG_BYTES,
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

  /**
   * How many replies this writer refused to queue. `gp_diagnose` reads it and
   * surfaces it in-band (a reply dropped to a stalled stdout otherwise has no
   * reader outside the logs): a silently-shrinking answer is the failure mode this
   * ceiling replaces.
   */
  get droppedFrames(): number {
    return this.dropped;
  }

  /**
   * @param text already framed, including its trailing newline.
   * @param requestId the JSON-RPC id the frame answers, so a drop names *which*
   * reply the agent lost rather than only that one went missing.
   */
  async write(text: string, requestId?: number | string | null): Promise<boolean> {
    if (this.failed) {
      return false;
    }
    if (this.sink.writableLength >= this.backlogLimitBytes) {
      this.dropped += 1;
      const who = requestId === undefined || requestId === null ? "a reply" : `reply ${JSON.stringify(requestId)}`;
      this.report(`${who} dropped, not queued: stdout already holds ${this.sink.writableLength} bytes past the ${this.backlogLimitBytes} ceiling — the reader on the other end stopped consuming, so this frame (and ${this.dropped - 1} earlier one(s)) will not be delivered`);
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
