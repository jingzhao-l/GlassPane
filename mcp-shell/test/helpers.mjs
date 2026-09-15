import { engineClientOver, EngineJsonRpcClient } from "../dist/engine-client.js";

/**
 * In-memory engine transport (spec §7.1 "fake engine transport").
 * Captures written frames and lets tests push back response/error frames
 * or transport errors.
 */
export class FakeLineIo {
  sent = [];
  #messageHandler = null;
  #closeHandler = null;
  #errorHandler = null;

  writeLine(line) {
    this.sent.push(line);
  }

  onMessage(handler) {
    this.#messageHandler = handler;
  }

  onClose(handler) {
    this.#closeHandler = handler;
  }

  onError(handler) {
    this.#errorHandler = handler;
  }

  close() {
    this.#closeHandler?.();
  }

  /** Last written frame parsed back to an object. */
  lastFrame() {
    if (this.sent.length === 0) {
      throw new Error("fake engine: no frame written");
    }
    return JSON.parse(this.sent[this.sent.length - 1]);
  }

  /** Inject a raw frame (e.g. an unsolicited / out-of-order response). */
  send(raw) {
    this.#messageHandler?.(raw);
  }

  /** Reply to the last written frame with a success result frame. */
  respond(result) {
    const frame = this.lastFrame();
    this.#messageHandler?.(JSON.stringify({ id: frame.id, result }));
  }

  /** Reply to the last written frame with an error frame (spec §3.2.1). */
  respondError({ code, message, remedy }) {
    const frame = this.lastFrame();
    this.#messageHandler?.(
      JSON.stringify({ id: frame.id, error: { code, message, remedy } }),
    );
  }

  /** Simulate a transport failure after the next tick (so the call is pending). */
  emitError(error) {
    setImmediate(() => this.#errorHandler?.(error));
  }
}

export function makeEngine(overrides = {}) {
  const io = new FakeLineIo();
  const { timeoutMs = 500, ...rest } = overrides;
  return { io, engine: engineClientOver(io, timeoutMs), ...rest };
}

export function withEngine() {
  return makeEngine();
}

export { EngineJsonRpcClient };