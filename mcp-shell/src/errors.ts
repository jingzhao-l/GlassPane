/**
 * GP_E failure-mode codes surfaced to the agent (P0 spec §3.4 / §6.2).
 * Engine-side codes are defined by the daemon; the shell only adds the
 * codes that arise between the shell and the engine connection.
 */
export const GP_E_ENGINE_UNREACHABLE = "GP_E_ENGINE_UNREACHABLE";
export const GP_E_BAD_PARAMS = "GP_E_BAD_PARAMS";
export const GP_E_NO_EVIDENCE = "GP_E_NO_EVIDENCE";
export const GP_E_INTERNAL = "GP_E_INTERNAL";
export const GP_E_PROJECT_LIMIT = "GP_E_PROJECT_LIMIT";
export const GP_E_NOT_FOUND = "GP_E_NOT_FOUND";

/**
 * Codes this shell raises for itself, in one place so a string literal cannot
 * exist twice with different spellings (X-15). They are **not** daemon codes:
 * the daemon's `GPErrorCode` enum has no counterpart for either, because both
 * describe a failure of the shell↔engine connection rather than of a request —
 * a deadline this process chose to stop waiting on, and a frame too large to
 * put on the wire. An agent must be able to tell those apart from a daemon
 * error, and the daemon's own vocabulary is the only place that could add them.
 */
export const GP_E_ENGINE_TIMEOUT = "GP_E_ENGINE_TIMEOUT";
export const GP_E_PAYLOAD_TOO_LARGE = "GP_E_PAYLOAD_TOO_LARGE";

export interface ToolErrorText {
  code: string;
  message: string;
  remedy: string;
}

/**
 * Wire text shape consumed by the agent (spec §6.2):
 * `GP_E_XXX: message | remedy: <guidance>` — the prefix is greppable.
 */
export function formatToolError(code: string, message: string, remedy: string): string {
  return `${code}: ${message} | remedy: ${remedy}`;
}

export function formatToolErrorShape(error: ToolErrorText): string {
  return formatToolError(error.code, error.message, error.remedy);
}