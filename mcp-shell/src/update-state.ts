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
 *  - **unreadable** (bad JSON, permissions, a mode that is not owner-only, a field
 *    outside its documented set): the problem is named. Swallowing it here would be
 *    the exact fail-open this repo has been burned by.
 *  - **read**: current / latest / status / last check / the failure reason when there
 *    is one, as facts the agent can quote.
 *
 * The same rule governs `caRoots`, the record of the machine's exported TLS roots:
 * this file decodes it and nothing else. It is a closed set of five states, and a
 * value outside that set makes the *whole* file unreadable rather than degrading to
 * the friendly state — a shell that guesses about trust is worse than one that says
 * it cannot read. Absent or `null` is decoded as its own state, `recorded: false`
 * ("this install never exported roots"), which is emphatically not "the bundle is fine".
 * The sentence an agent acts on is rendered by `tools.ts`, next to `gp_diagnose`.
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

/** Closed set from `updater/lib/codes.js` `STATUSES`; anything else is unreadable data. */
const KNOWN_STATUSES = new Set([
  "up-to-date", "available", "staged", "applied", "deferred", "needs-consent",
  "check-overdue", "rolled-back", "check-failed", "staged-build-failed",
  "apply-failed", "rollback-failed", "disabled", "installer-pointer-stale",
]);

export type UpdateStateReading =
  | {
      kind: "read";
      stateFile: string;
      summary: string;
      /** Decoded `caRoots`, present exactly when the file was read and understood. */
      ca: CaRootsReading;
    }
  | { kind: "absent" | "unreadable" | "unresolvable"; stateFile: string | null; summary: string };

/**
 * The five states the exporter can record for the machine's root bundle, as a closed
 * set: `ok` (a non-empty bundle landed and a probe through it reached the release
 * endpoint), `probe-failed` (bundle landed, endpoint still unreachable with it),
 * `empty` (the keychain dump produced no certificates), `unavailable` (no keychain
 * tool on this host), `write-unverified` (the file read back different from what was
 * written). Only `ok` means usable; the other four each fail in their own way, so
 * collapsing any of them into `ok` hands an agent a false all-clear.
 */
export const CA_ROOTS_STATUSES = ["ok", "probe-failed", "empty", "unavailable", "write-unverified"] as const;

export type CaRootsStatus = (typeof CA_ROOTS_STATUSES)[number];

const KNOWN_CA_ROOTS_STATUSES: ReadonlySet<string> = new Set<string>(CA_ROOTS_STATUSES);

function isCaRootsStatus(value: string): value is CaRootsStatus {
  return KNOWN_CA_ROOTS_STATUSES.has(value);
}

/** Name the exporter gives the bundle inside the state root; used to name it when the record does not. */
export const CA_BUNDLE_FILE_NAME = "ca-roots.pem";

export type CaRootsReading =
  | {
      recorded: true;
      status: CaRootsStatus;
      /** Certificate count as recorded; `null` only for the non-`ok` states, which may not have one. */
      certs: number | null;
      exportedAt: string | null;
      /** The exporter's own reason text, when it wrote one. */
      detail: string | null;
      /** Where this state root's bundle lives, resolved the same way the state file was. */
      bundlePath: string;
      /** The path the exporter recorded, when it recorded one. */
      recordedPath: string | null;
    }
  | {
      recorded: false;
      bundlePath: string;
    };

/**
 * Decode `caRoots` without inventing a value for it. A judgement that cannot be
 * answered from the record is refused here and surfaces as "this state file is
 * unreadable", because the alternative — defaulting to `ok` — is how an updater that
 * has failed every night since install gets read as a working one.
 */
function decodeCaRoots(value: unknown, bundlePath: string): { ok: true; ca: CaRootsReading } | { ok: false; reason: string } {
  if (value === undefined || value === null) {
    return { ok: true, ca: { recorded: false, bundlePath } };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      reason: `caRoots is ${Array.isArray(value) ? "an array" : typeof value} instead of the object the exporter writes`,
    };
  }
  const record = value as Record<string, unknown>;
  const rawStatus = record.status;
  if (typeof rawStatus !== "string" || !isCaRootsStatus(rawStatus)) {
    return {
      ok: false,
      reason: `caRoots.status ${JSON.stringify(rawStatus ?? null)} is not one of ${CA_ROOTS_STATUSES.join(", ")}`,
    };
  }
  const rawCerts = record.certs;
  let certs: number | null = null;
  if (typeof rawCerts === "number") {
    if (!Number.isInteger(rawCerts) || rawCerts < 0) {
      return { ok: false, reason: `caRoots.certs ${JSON.stringify(rawCerts)} is not a certificate count` };
    }
    certs = rawCerts;
  } else if (rawCerts !== undefined && rawCerts !== null) {
    return { ok: false, reason: `caRoots.certs is ${typeof rawCerts} instead of a count or null` };
  }
  if (rawStatus === "ok" && (certs === null || certs < 1)) {
    // `ok` is defined as "N > 0 landed and the probe passed". An `ok` that records no
    // certificates is the file claiming a measurement it did not take.
    return {
      ok: false,
      reason: `caRoots.status says ok but it records ${JSON.stringify(rawCerts ?? null)} certificates`,
    };
  }
  const rawPath = record.path;
  let recordedPath: string | null = null;
  if (typeof rawPath === "string") {
    if (rawPath.trim() === "") {
      return { ok: false, reason: "caRoots.path is blank, so the bundle it points at cannot be named" };
    }
    recordedPath = rawPath;
  } else if (rawPath !== undefined && rawPath !== null) {
    return { ok: false, reason: `caRoots.path is ${typeof rawPath} instead of a path or null` };
  }
  return {
    ok: true,
    ca: {
      recorded: true,
      status: rawStatus,
      certs,
      exportedAt: typeof record.exportedAt === "string" ? record.exportedAt : null,
      detail: typeof record.detail === "string" && record.detail.trim() !== "" ? record.detail : null,
      bundlePath,
      recordedPath,
    },
  };
}

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
  const ca = decodeCaRoots(parsed.caRoots, path.join(path.dirname(stateFile), CA_BUNDLE_FILE_NAME));
  if (!ca.ok) {
    return {
      kind: "unreadable",
      stateFile,
      summary: `update state: ${stateFile} carries a CA trust bundle record this shell cannot read (${ca.reason}); `
        + "whether this install can reach the release endpoint at all is unknown, so nothing below it is trusted either — "
        + "re-run the installer or `node updater/cli.js enable` to write the record again",
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
  return { kind: "read", stateFile, summary: `update state: ${bits.join("; ")}`, ca: ca.ca };
}
