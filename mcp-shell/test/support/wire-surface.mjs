import fs from "node:fs";
import path from "node:path";

/**
 * Which daemon methods this shell can actually put on the wire — derived, not
 * remembered.
 *
 * Two producers, both read out of the sources: the specs whose request is
 * forwarded as-is (`execute === undefined` — `runValidatedTool` puts
 * `engine.call(spec.engineMethod, …)` on the wire, a *variable* name the
 * literal scan below can never see), and every `.call("<name>")` written in the
 * shell's own code, which is how the orchestrated tools reach the daemon
 * through their executor. `hello` is added because the transport handshakes on
 * it before anything else can.
 *
 * It lives in `test/support/` because two gates need the *same* answer and must
 * not drift while disagreeing: `method-table.test.mjs` refuses a sent method with
 * no derived deadline, and `tools.test.mjs` sweeps the tools that can receive an
 * oversized reply. Either of those, reading a hand-kept list, would go quiet the
 * day a tool is added — which is the failure mode this whole round keeps hitting.
 *
 * `shellWireSurface` returns the two producers *separately* so a consumer can
 * guard its own vacuity: `methodsSentByShell` alone cannot tell a working scan
 * from a dead one, because the spec loop on its own feeds any `sent.length >= N`
 * floor. The premise each half rests on is pinned here, at the one place both
 * gates read through: if the variable-forward arm or the literal call shape
 * moves, the derivation says so instead of returning a shrunk answer that every
 * downstream set-comparison passes on the smaller set.
 */
export function shellWireSurface(TOOL_SPECS, srcDir) {
  const forwardable = TOOL_SPECS.filter((spec) => spec.execute === undefined);
  const fromSpecs = new Set(forwardable.map((spec) => spec.engineMethod));
  const foundLiterals = new Set();

  const sources = new Map();
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    const file = path.join(srcDir, entry.name);
    sources.set(entry.name, fs.readFileSync(file, "utf8"));
  }
  for (const body of sources.values()) {
    for (const match of body.matchAll(/\.call\(\s*"([a-z_]+)"/g)) {
      foundLiterals.add(match[1]);
    }
  }
  // `hello` stays in the answer because the transport really does send it, but
  // it is *seeded*, not scanned — so the vacuity guard below counts only what
  // the regex found, or a dead scan would hide behind the seed.
  const fromLiterals = new Set(["hello", ...foundLiterals]);

  // Premise of the spec half: `tools.ts` still forwards a forwarded-as-is
  // spec by *variable* — `engine.call(spec.engineMethod, …)`. Mutation: that
  // arm is renamed/refactored away and the 10 specs' methods are no longer
  // proven to reach the wire; the count of literal `.call("…")` sites alone
  // stays ≥ 10 and both gates go quiet. This says so at the single producer.
  const tools = sources.get("tools.ts") ?? "";
  const variableForwardAlive = /\.call\(\s*spec\.engineMethod\b/.test(tools);
  // Premise of the literal half: at least one method reaches the wire *only*
  // through a written-out `.call("<name>")` (today `capture_view` — its spec
  // carries an `execute`, so the spec loop cannot produce it). Mutation: the
  // orchestrated call sites in `tools.ts` are re-spelled with a constant
  // (`engine.call(CAPTURE_METHOD, …)`) while the transport's own handshake
  // literal survives — the merged set quietly loses `capture_view` and every
  // comparison below passes on the smaller one. So the guard counts only scan
  // hits that no other producer could stand in for, and the seeded handshake
  // name may not vouch for the very scan meant to keep it honest.
  const literalOnly = [...foundLiterals].filter((method) => !fromSpecs.has(method) && method !== "hello");

  return {
    fromSpecs,
    fromLiterals,
    literalOnly,
    variableForwardAlive,
    speclessCount: forwardable.length,
    sent: new Set([...fromSpecs, ...fromLiterals]),
  };
}

export function methodsSentByShell(TOOL_SPECS, srcDir) {
  return shellWireSurface(TOOL_SPECS, srcDir).sent;
}

/** Can a reply to this tool arrive at all? If not, no advice about shrinking one applies. */
export function canReceiveDaemonReply(spec, sent) {
  return sent.has(spec.engineMethod);
}
