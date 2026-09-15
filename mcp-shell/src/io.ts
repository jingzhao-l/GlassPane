import { Readable, Writable } from "node:stream";

/** Single-frame cap shared with the engine protocol (P0 spec §3.1). */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export interface LineSink {
  onLine(line: string): void;
  onOversize(bytes: number): void;
}

/**
 * Splits a byte-or-string stream on line boundaries. Keeps the current
 * partial line until a newline arrives (so a JSON message split across
 * chunks still reassembles correctly), mirrors engine FrameCodec.
 */
export class LineReader {
  private buffer = "";

  constructor(private readonly sink: LineSink) {}

  /** @param chunk UTF-8 text fragment received from the stream. */
  push(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const bytes = Buffer.byteLength(line, "utf8");
      if (bytes > MAX_FRAME_BYTES) {
        this.sink.onOversize(bytes);
      } else {
        this.sink.onLine(line);
      }
    }
  }

  /** Unconsumed partial line (tests / graceful close inspection). */
  pendingText(): string {
    return this.buffer;
  }
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
      onOversize: () => this.errorHandler?.(
        new Error("frame exceeds " + MAX_FRAME_BYTES + " bytes")
      ),
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