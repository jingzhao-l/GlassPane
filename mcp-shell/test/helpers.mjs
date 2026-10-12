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
  #queuedError = null;

  writeLine(line) {
    this.sent.push(line);
    // A refusal queued before the request existed is delivered now that it does: the frame being
    // written *is* the moment the client's pending entry exists (both happen synchronously inside
    // `call()`), so delivery stays tied to that fact instead of to an event-loop phase.
    if (this.#queuedError !== null) {
      const error = this.#queuedError;
      this.#queuedError = null;
      this.#deliverError(error);
    }
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

  /**
   * Simulate a transport failure, delivered **before any deadline can fire**.
   *
   * The ordering is the whole point, and it is not a matter of how loaded the machine is. `call()`
   * registers the pending entry and arms its `setTimeout(deadlineMs)` in the same synchronous pass in
   * which it writes the frame. A bare `setImmediate` put the refusal in the **check** phase, while an
   * expired deadline sits in the **timers** phase, which node drains first in the next loop pass. So
   * one loop iteration outlasting the budget flipped the verdict from `GP_E_ENGINE_UNREACHABLE` to
   * `GP_E_ENGINE_TIMEOUT` — measured on a machine at load 60–321, where two named controls
   * (`call rejects on transport error…`, `tools/call engine unreachable maps to isError…`) went red for
   * a reason that had nothing to do with the code under test. A control whose answer is decided by the
   * scheduler measures the scheduler, not the product.
   *
   * `process.nextTick` runs when the current stack unwinds, ahead of the timers phase, so a refusal
   * for an already-pending call lands first, every time. A refusal queued *before* the request was
   * written waits for `writeLine` — which is exactly the moment the entry comes into existence —
   * instead of waiting for a phase. The deadline budgets stay untouched on purpose: some fixtures
   * assert that a caller does get answered by its deadline (`consumer-consistency.test.mjs` relies on
   * the 500 ms), so inflating them would break a real assertion rather than fix this one.
   */
  emitError(error) {
    if (this.sent.length > 0) this.#deliverError(error);
    else this.#queuedError = error;
  }

  #deliverError(error) {
    process.nextTick(() => this.#errorHandler?.(error));
  }
}

/**
 * The 500 ms below is deliberately kept: some fixtures assert that a caller *does* get answered
 * by its deadline (`consumer-consistency.test.mjs` depends on it), so the budget is load-bearing
 * and must not be inflated. The scheduler race is removed in `FakeLineIo.emitError` instead — by
 * delivery ordering, not by making the wait longer.
 */
export function makeEngine(overrides = {}) {
  const io = new FakeLineIo();
  const { timeoutMs = 500, ...rest } = overrides;
  return { io, engine: engineClientOver(io, timeoutMs), ...rest };
}

export function withEngine() {
  return makeEngine();
}

export { EngineJsonRpcClient };