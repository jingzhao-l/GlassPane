/**
 * GP_E failure-mode codes surfaced to the agent (P0 spec §3.4 / §6.2).
 * Engine-side codes are defined by the daemon; the shell only adds the
 * codes that arise between the shell and the engine connection.
 */
export const GP_E_ENGINE_UNREACHABLE = "GP_E_ENGINE_UNREACHABLE";
export const GP_E_BAD_PARAMS = "GP_E_BAD_PARAMS";
export const GP_E_INTERNAL = "GP_E_INTERNAL";

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