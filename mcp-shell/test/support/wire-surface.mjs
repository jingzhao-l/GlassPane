import fs from "node:fs";
import path from "node:path";

/**
 * Which daemon methods this shell can actually put on the wire — derived, not
 * remembered.
 *
 * Two producers, both read out of the sources: the specs whose request is
 * forwarded as-is (`execute === undefined`), and every `.call("<name>")` written
 * in the shell's own code, which is how the orchestrated tools reach the daemon
 * through their executor. `hello` is added because the transport handshakes on
 * it before anything else can.
 *
 * It lives in `test/support/` because two gates need the *same* answer and must
 * not drift while disagreeing: `method-table.test.mjs` refuses a sent method with
 * no derived deadline, and `tools.test.mjs` sweeps the tools that can receive an
 * oversized reply. Either of those, reading a hand-kept list, would go quiet the
 * day a tool is added — which is the failure mode this whole round keeps hitting.
 */
export function methodsSentByShell(TOOL_SPECS, srcDir) {
  const sent = new Set(["hello"]);
  for (const spec of TOOL_SPECS) {
    if (spec.execute === undefined) {
      sent.add(spec.engineMethod);
    }
  }
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    const body = fs.readFileSync(path.join(srcDir, entry.name), "utf8");
    for (const match of body.matchAll(/\.call\(\s*"([a-z_]+)"/g)) {
      sent.add(match[1]);
    }
  }
  return sent;
}

/** Can a reply to this tool arrive at all? If not, no advice about shrinking one applies. */
export function canReceiveDaemonReply(spec, sent) {
  return sent.has(spec.engineMethod);
}
