/**
 * Standalone probe: does a pending engine call's timeout actually get
 * delivered when the timer is the *only* thing left in the event loop?
 *
 * Run as its own process (nothing else keeps the loop alive, no transport
 * handles), so the answer is not polluted by a test runner's own timers.
 *
 *   node mcp-shell/test/fixtures/timeout-loop.mjs
 *
 * Exit 0  + "REJECTED <code>" → the timeout settled the call (correct).
 * Exit 13 + "unsettled"       → Node drained the loop and exited; the caller
 *                               never received a diagnosis (the defect).
 */
import fs from "node:fs";
import { EngineJsonRpcClient } from "../../dist/engine-client.js";

/** In-memory transport with zero OS handles. */
const silentIo = {
  writeLine() {},
  onMessage() {},
  onClose() {},
  onError() {},
  close() {},
};

const say = (text) => fs.writeSync(1, text + "\n");

const client = new EngineJsonRpcClient(silentIo, 30);
try {
  await client.call("diagnose");
  say("RESOLVED");
  process.exitCode = 2;
} catch (error) {
  say(`REJECTED ${error?.code ?? "<no code>"}`);
  process.exitCode = 0;
}
