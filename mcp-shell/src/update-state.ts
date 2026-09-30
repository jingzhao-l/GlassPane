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
 *
 * `runtime` — the record of whether the *updater's own installed copy* moved with the
 * last successful swap — is decoded under exactly that rule. It matters on its own
 * because the daily job runs whatever `update-install.json`'s `updaterCli` points at:
 * a release whose whole content is "fix the updater" reaches this machine only if this
 * record says `refreshed`, and a machine that never recorded one is still running the
 * copy the installer cloned. Four closed states, `additionalProperties:false` honoured
 * by refusing a record that carries an undeclared key, and absent/null decoded as its
 * own `recorded: false` state (with `writtenAsNull` saying which of the two routes the
 * file took) — never as "the updater is current". A `refreshed` whose `agentVerified`
 * is not literally `true` is still decoded, because "it claims the copy moved but never
 * read the loaded job back" is a fact a reader can act on; it is only never *usable*.
 * The sentences an agent acts on are rendered by `tools.ts`, next to `gp_diagnose`.
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
      /** Decoded `runtime`, present exactly when the file was read and understood. */
      runtime: RuntimeReading;
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
 * The four states the updater can record for **its own installed copy**, as a closed set:
 * `refreshed` (the new copy landed *and* the loaded launchd job was read back and names it),
 * `failed` (the updater's own copy did not move — the `.app`/npm swap may still have
 * succeeded, so this is a stated degradation and emphatically not "the update failed"),
 * `kept` (automatic update is switched off on this machine, so the code and the pointer
 * moved but no job was registered: neither a failure nor something to brag about),
 * `skipped` (not attempted by that run). Only `refreshed` with `agentVerified === true` is
 * usable; folding any other state into it is how a machine that has run the same stale
 * updater since install reads as one that fixes itself.
 */
export const RUNTIME_STATUSES = ["refreshed", "failed", "kept", "skipped"] as const;

export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number];

const KNOWN_RUNTIME_STATUSES: ReadonlySet<string> = new Set<string>(RUNTIME_STATUSES);

function isRuntimeStatus(value: string): value is RuntimeStatus {
  return KNOWN_RUNTIME_STATUSES.has(value);
}

/** The keys `runtime` may carry: the schema closes the object with `additionalProperties: false`. */
const RUNTIME_KEYS: readonly string[] = [
  "status", "version", "cliPath", "previousCliPath", "agentVerified", "at", "code", "detail",
];

/** A version triple, the only shape that can name the release the copy came from. */
const RUNTIME_VERSION_RE = /^\d+\.\d+\.\d+$/;

/** A stable gate code — the same pattern the top-level `code` field is closed with. */
const RUNTIME_CODE_RE = /^[a-z0-9][a-z0-9.-]*$/;

export type RuntimeReading =
  | {
      recorded: true;
      status: RuntimeStatus;
      /** Version the updater's own copy was moved to; `null` when the record did not say. */
      version: string | null;
      /** The installed copy this record is about — a real path, never a template. */
      cliPath: string | null;
      /** The copy it came from, when the record kept one (what a rollback points back at). */
      previousCliPath: string | null;
      /** `true` only after the loaded job was read back and names `cliPath`. */
      agentVerified: boolean | null;
      at: string | null;
      /** Stable code of the gate that refused (`runtime-stale`, `auto-disabled`, …), or null. */
      code: string | null;
      /** The updater's own reason text, when it wrote one. */
      detail: string | null;
    }
  | {
      recorded: false;
      /**
       * Which route left nothing recorded: `true` is a file that carries `runtime: null`,
       * `false` is a file with no such key at all — the shape an install predating the
       * feature has. Both mean "this swap never tried", and they stay apart because a
       * reader says them differently.
       */
      writtenAsNull: boolean;
    };

/** One `string | null` slot of the record; every refusal names the field that caused it. */
function runtimeTextSlot(
  record: Record<string, unknown>,
  field: string,
  purpose: string,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  const raw = record[field];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, reason: `runtime.${field} is ${typeof raw} instead of ${purpose} or null` };
  }
  if (raw.trim() === "") {
    return { ok: false, reason: `runtime.${field} is blank, so ${purpose} cannot be named` };
  }
  return { ok: true, value: raw };
}

/**
 * Decode `runtime` without inventing a value for it, under exactly the rule `decodeCaRoots`
 * follows: a judgement that cannot be answered from the record is refused here and surfaces
 * as "this state file is unreadable". Defaulting to `refreshed` would tell an agent that a
 * release fixing the updater reached this machine while the daily job is still running the
 * copy the installer first cloned.
 *
 * A `refreshed` whose `agentVerified` is not `true` is *not* a refusal: the record then says
 * "it claims the copy moved and never read the loaded job back", which is a fact the reader
 * can act on. It is simply never usable — see `runtimeIsUsable`.
 */
function decodeRuntime(value: unknown): { ok: true; runtime: RuntimeReading } | { ok: false; reason: string } {
  if (value === undefined || value === null) {
    return { ok: true, runtime: { recorded: false, writtenAsNull: value === null } };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      reason: `runtime is ${Array.isArray(value) ? "an array" : typeof value} instead of the object the updater writes`,
    };
  }
  const record = value as Record<string, unknown>;
  // `additionalProperties: false` is part of the contract this reader was written against: an
  // undeclared key means the file came from a writer with a different shape, and half-reading
  // that shape is how a second author of this document gets made.
  const stray = Object.keys(record).filter((key) => !RUNTIME_KEYS.includes(key));
  if (stray.length > 0) {
    return {
      ok: false,
      reason: `runtime carries ${stray.map((key) => JSON.stringify(key)).join(", ")}, `
        + "a key the state schema does not declare (the object is closed with additionalProperties: false)",
    };
  }
  const rawStatus = record.status;
  if (typeof rawStatus !== "string" || !isRuntimeStatus(rawStatus)) {
    return {
      ok: false,
      reason: `runtime.status ${JSON.stringify(rawStatus ?? null)} is not one of ${RUNTIME_STATUSES.join(", ")}`,
    };
  }
  const version = runtimeTextSlot(record, "version", "a version");
  if (!version.ok) return version;
  if (version.value !== null && !RUNTIME_VERSION_RE.test(version.value)) {
    return { ok: false, reason: `runtime.version ${JSON.stringify(version.value)} is not a version this shell can name` };
  }
  const cliPath = runtimeTextSlot(record, "cliPath", "the installed copy");
  if (!cliPath.ok) return cliPath;
  const previousCliPath = runtimeTextSlot(record, "previousCliPath", "the copy it came from");
  if (!previousCliPath.ok) return previousCliPath;
  const at = runtimeTextSlot(record, "at", "an instant");
  if (!at.ok) return at;
  const code = runtimeTextSlot(record, "code", "a gate code");
  if (!code.ok) return code;
  if (code.value !== null && !RUNTIME_CODE_RE.test(code.value)) {
    return { ok: false, reason: `runtime.code ${JSON.stringify(code.value)} is not a gate code this shell can quote` };
  }
  const rawAgent = record.agentVerified;
  let agentVerified: boolean | null = null;
  if (typeof rawAgent === "boolean") {
    agentVerified = rawAgent;
  } else if (rawAgent !== undefined && rawAgent !== null) {
    return { ok: false, reason: `runtime.agentVerified is ${typeof rawAgent} instead of true, false or null` };
  }
  const rawDetail = record.detail;
  return {
    ok: true,
    runtime: {
      recorded: true,
      status: rawStatus,
      version: version.value,
      cliPath: cliPath.value,
      previousCliPath: previousCliPath.value,
      agentVerified,
      at: at.value,
      code: code.value,
      detail: typeof rawDetail === "string" && rawDetail.trim() !== "" ? rawDetail : null,
    },
  };
}

/**
 * Does this record say the updater's own copy is current? Only `refreshed` *with*
 * `agentVerified === true` qualifies — that pair is the one moment where the code on disk
 * and the code launchd has loaded were both looked at. `kept` is deliberately not usable:
 * the machine is switched off for automatic updates, so nothing was registered and nothing
 * will move by itself.
 */
export function runtimeIsUsable(runtime: RuntimeReading): boolean {
  return runtime.recorded && runtime.status === "refreshed" && runtime.agentVerified === true;
}

/** The state root a state file lives in: one author, so a remedy command never names a directory that is not the root. */
export function stateRootOf(stateFile: string): string {
  return path.dirname(stateFile);
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
  // Same rule, different fact: a record of the updater's own swap that cannot be decoded
  // leaves "what code is running tomorrow's check" unknown, and an unknown there is not a
  // refreshed one. The refusal is stated; it never degrades to the friendly state.
  const runtime = decodeRuntime(parsed.runtime);
  if (!runtime.ok) {
    return {
      kind: "unreadable",
      stateFile,
      summary: `update state: ${stateFile} carries an updater self-update record this shell cannot read (${runtime.reason}); `
        + "which copy of the updater this machine's daily job will run next is unknown, so nothing below it is trusted either — "
        + "re-run the GlassPane installer, or `node updater/cli.js enable`, to write the record again",
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
  return { kind: "read", stateFile, summary: `update state: ${bits.join("; ")}`, ca: ca.ca, runtime: runtime.runtime };
}
