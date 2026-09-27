/**
 * The one thing the MCP surface says about GlassPane's own freshness.
 *
 * `gp_diagnose` answers "what happened to that operation", and an agent that has
 * to decide whether a strange answer is a bug or an outdated build needs the same
 * fact the settings panel shows. The updater owns this state (`updater/lib/state.js`
 * writes `update-state.json`); this file only *reads* it, because a second writer
 * of the same document would be a second truth.
 *
 * Three outcomes are stated, never collapsed into silence:
 *  - **never installed** (no state file, no installer pointer): the machine has no
 *    auto-update configured. Saying "no data" would let an agent infer "up to date".
 *  - **unreadable** (bad JSON, permissions, a mode that is not owner-only): the
 *    problem is named. Swallowing it here would be the exact fail-open this repo
 *    has been burned by.
 *  - **read**: current / latest / status / last check / the failure reason when there
 *    is one, as facts the agent can quote.
 *
 * The state root is resolved the way the daemon and the panel resolve it — the
 * password-record home, not `$HOME` — and `test/update-state.test.mjs` compares
 * that resolution against the updater's own, so the two cannot drift apart.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Env the daemon's own `--state-dir` maps to for this process (X-22 family). */
export const STATE_DIR_ENV = "GLASSPANE_STATE_DIR";

/**
 * The home the *other* processes use. `os.homedir()` reads `$HOME`, which a caller
 * controls; `os.userInfo().homedir` reads the password record, which is what
 * `NSHomeDirectory()` in the panel and `StateRoot.homeDefault()` in the daemon both
 * return. Refuse rather than fall back — the same rule `project-registry.ts` states
 * at length, and for the same reason: a redirected `$HOME` here means reading a
 * state file that describes nobody's machine.
 */
export function recordHome(): string | null {
  try {
    return os.userInfo().homedir;
  } catch {
    return null;
  }
}

/** Where `update-state.json` lives for this process, or null when it cannot be named. */
export function updateStateFile(env: NodeJS.ProcessEnv = process.env, stateRootOverride?: string): string | null {
  const named = stateRootOverride ?? env[STATE_DIR_ENV];
  if (typeof named === "string" && named.trim() !== "") {
    return path.join(path.resolve(named), "update-state.json");
  }
  const home = recordHome();
  if (home === null) {
    return null;
  }
  return path.join(home, ".glasspane", "update-state.json");
}

export interface UpdateStateReading {
  kind: "read" | "absent" | "unreadable" | "unresolvable";
  stateFile: string | null;
  summary: string;
}

/** Closed set from `updater/lib/codes.js` `STATUSES`; anything else is unreadable data. */
const KNOWN_STATUSES = new Set([
  "up-to-date", "available", "staged", "applied", "deferred", "needs-consent",
  "check-overdue", "rolled-back", "check-failed", "staged-build-failed",
  "apply-failed", "rollback-failed", "disabled", "installer-pointer-stale",
]);

/**
 * Read and render. Never throws: `gp_diagnose` answers about an operation, and a
 * missing or broken update file is a fact about the machine, not a reason to fail
 * the diagnosis.
 */
export function readUpdateState(env: NodeJS.ProcessEnv = process.env, stateRootOverride?: string): UpdateStateReading {
  const stateFile = updateStateFile(env, stateRootOverride);
  if (stateFile === null) {
    return {
      kind: "unresolvable",
      stateFile: null,
      summary: "update state: this process has no password-database record, so the state root cannot be named; "
        + "nothing was read and no claim about GlassPane's freshness is being made",
    };
  }
  if (!fs.existsSync(stateFile)) {
    return {
      kind: "absent",
      stateFile,
      summary: `update state: no ${stateFile} — auto-update has never run on this machine, so nothing here says `
        + "the installed GlassPane is current; run \`node updater/cli.js check\` (or use the settings panel) to find out",
    };
  }
  let text: string;
  try {
    text = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    return {
      kind: "unreadable",
      stateFile,
      summary: `update state: ${stateFile} exists but could not be read (${String(error)}); freshness is unknown, `
        + "which is not the same as up to date",
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    return {
      kind: "unreadable",
      stateFile,
      summary: `update state: ${stateFile} is not valid JSON (${String(error)}); freshness is unknown, which is `
        + "not the same as up to date",
    };
  }
  const status = typeof parsed.status === "string" ? parsed.status : null;
  if (status === null || !KNOWN_STATUSES.has(status)) {
    return {
      kind: "unreadable",
      stateFile,
      summary: `update state: ${stateFile} carries status ${JSON.stringify(parsed.status ?? null)}, which is not a `
        + "status this shell knows; the updater and this shell disagree about the contract, so freshness is unknown",
    };
  }
  const bits = [
    `status=${status}`,
    `current=${String(parsed.current ?? "unknown")}`,
    `latest=${String(parsed.latest ?? "none-seen")}`,
    `lastCheckAt=${String(parsed.updatedAt ?? "never")}`,
    `autoUpdate=${parsed.disabled === true ? "off" : parsed.autoApply === true ? "on" : "on-by-default"}`,
  ];
  const lastError = parsed.lastError as { code?: string; message?: string } | null | undefined;
  if (lastError && typeof lastError.message === "string") {
    bits.push(`lastError=${lastError.code ?? "no-code"}: ${lastError.message}`);
  }
  const staged = parsed.staged as { version?: string; digest?: string } | null | undefined;
  if (staged && typeof staged.version === "string") {
    bits.push(`staged=${staged.version}${staged.digest ? ` (${String(staged.digest).slice(0, 12)}…)` : ""}`);
  }
  return { kind: "read", stateFile, summary: `update state: ${bits.join("; ")}` };
}
