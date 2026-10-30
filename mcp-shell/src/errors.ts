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
/** Shell-only: the table changed between our read and our write, so we refused
 * to overwrite. The daemon has no such code (it owns one writer), and every other
 * code this shell raises for itself is listed with it in
 * `test/remedy-surface.test.mjs`'s SHELL_ONLY set — a code outside the vocabulary
 * with no remedy arm reads to an agent as "retry the same write". */
export const GP_E_REGISTRY_DRIFT = "GP_E_REGISTRY_DRIFT";

/**
 * Codes this shell raises for itself, in one place so a string literal cannot
 * exist twice with different spellings (X-15).
 *
 * `GP_E_ENGINE_TIMEOUT` is shell-only: the daemon's `GPErrorCode` enum has no
 * counterpart, because it describes a deadline *this process* chose to stop
 * waiting on while the daemon may still be working. An agent must be able to
 * tell that apart from a daemon error, and the daemon's vocabulary is the only
 * place that could add it.
 *
 * `GP_E_PAYLOAD_TOO_LARGE` is **not** shell-only — the daemon declares it too
 * (`GPErrorCode.payloadTooLarge`, raised by its dispatcher for an oversized
 * request frame), and this shell uses the same code for an oversized frame on
 * *its* side of the stdio/HTTP boundary. Sharing the code is deliberate: one
 * meaning ("that frame was too big"), whichever side hit the limit. It is
 * spelled here rather than imported because there is no shared source for the
 * two languages, and `test/remedy-surface.test.mjs` is what keeps this
 * paragraph true: it reads the daemon's enum and fails if any code labelled
 * shell-only ever appears in it, or if a code this file exports stops being
 * either shared or genuinely shell-only.
 */
export const GP_E_ENGINE_TIMEOUT = "GP_E_ENGINE_TIMEOUT";
export const GP_E_PAYLOAD_TOO_LARGE = "GP_E_PAYLOAD_TOO_LARGE";

/**
 * Shell-only: this process refused to *write* a request, because the bytes it had
 * already handed the daemon's socket were not being read
 * (`ENGINE_WRITE_BACKLOG_BYTES` in `engine-client.ts`).
 *
 * It is deliberately not `GP_E_ENGINE_UNREACHABLE`, which is what this refusal
 * used to answer with: that code's remedy orders a daemon restart, and a backlog
 * measures a memory watermark in *this* process, not the service's state — the
 * daemon may be mid-`act` on the user's screen, where a SIGTERM cancels and rolls
 * the action back. The two answers also have different next moves, which is the
 * real reason to split the code: the unread bytes may drain on their own, while a
 * socket nobody is listening on never does.
 */
export const GP_E_ENGINE_BACKLOG = "GP_E_ENGINE_BACKLOG";

/**
 * Shell-only, and deliberately *not* a daemon code: this is what the shell
 * answers when a daemon error frame arrives with no `code` at all. Naming it
 * here (rather than inlining a string at the one call site, where it used to
 * live) keeps it inside the same vocabulary an agent can look up, and
 * `test/remedy-surface.test.mjs` checks it really is absent from the daemon's
 * enum — if the daemon ever declares it, this fallback stops being a shell-side
 * invention and the split has to be re-read.
 */
export const GP_E_UNKNOWN = "GP_E_UNKNOWN";

/**
 * Shell-only: this process could not resolve the user whose state directory is
 * meant (`os.userInfo()` has no record). Distinct from `GP_E_INTERNAL` because
 * the two have different remedies — one names a file to repair, the other names
 * the account this shell is running under — and sending an agent to open
 * `projects.json` for the second case sends it to a file that is fine.
 */
export const GP_E_NO_USER_RECORD = "GP_E_NO_USER_RECORD";

/**
 * Shell-only: a state root **the daemon reported about itself** (`hello`'s
 * `stateRoot`) names a path this process will neither create nor re-permission —
 * the filesystem root, the account's home directory itself, or a value that is not
 * an absolute path at all.
 *
 * Since 1.20.1 this code also answers the *other* un-checked root in this shell: a
 * `GLASSPANE_PROJECTS_FILE` override that names a directory `gp_project_set` would
 * otherwise create and bring to 0700 before publishing the registry into it
 * (`project-registry.ts`'s `overrideProjectsPath`). Same authority, same consequence, and
 * no new vocabulary: both are "a root this process was told to write into, judged and
 * refused before the first syscall". The two differ in who said it — one is the service's
 * self-report, the other this process's own environment — and each frame carries its own
 * remedy (`ProjectRegistryError.remedy`) so the reader is never told to restart the daemon
 * for a variable it exported, or to edit a file for a refusal that names a directory.
 *
 * The daemon refuses the same shapes for its own `--state-dir` (`StateRoot.classify`
 * → `StateRoot.notADedicatedRoot`) and then `tightenPermissions` that root to 0700,
 * so the argument parse is the only thing standing between `--state-dir ~` and a
 * locked home directory. It has no code for the refusal because the refusal is an
 * exit message, not an error frame — which is why this shell cannot reuse one
 * either: the root arrives over a socket with **no peer authentication** (SECURITY.md:
 * same uid = full authority), so a value in a reply frame can name `/Users/<you>` and
 * this shell's own `mkdirSync(…, 0700)` + `chmod` would obey it. `test/remedy-surface.test.mjs`
 * checks this stays absent from the daemon's enum, so the split has to be re-read if
 * the daemon ever does declare it.
 *
 * 它**不**列进下面那份 `SHELL_REQUEST_REFUSAL_CODES`：这一码说的不是"你给的参数不对"，
 * 而是"服务报了一个我们不能照做的根"，改参数重试不会有用；HTTP 那一侧因此按
 * shell-only 的规矩答 503（与 `GP_E_REGISTRY_DRIFT` 同一族："什么都没写，去看服务"），
 * 而不是 4xx。
 */
export const GP_E_STATE_ROOT_REFUSED = "GP_E_STATE_ROOT_REFUSED";

/**
 * Shell-only: the socket this shell is about to write into is not one it can call the
 * engine's. The engine socket is `chmod 0600` with **no peer authentication** (SECURITY.md:
 * same uid = full authority), so the path is a trust root, not just a location: a leaf another
 * account created, a leaf any other account may write to, or a directory any other account may
 * replace the entry in all mean the bytes this shell reads back are not evidence of what the
 * engine said — and every verdict this product publishes is built from those bytes.
 *
 * The judgement is made before the first byte leaves this process, so a refusal carries no
 * claim that anything was executed. It deliberately does NOT reuse `GP_E_ENGINE_UNREACHABLE`:
 * that code's remedy names a daemon restart, and restarting a service that is mid-`act` on the
 * user's screen is an action this measurement does not license — the thing listening there may
 * be running perfectly well, just not as the engine.
 *
 * It is also not in `SHELL_REQUEST_REFUSAL_CODES` below: this is not the caller's argument, so
 * the HTTP surface answers it as 503 like the other infrastructure codes.
 */
export const GP_E_SOCKET_TRUST = "GP_E_SOCKET_TRUST";

/**
 * Shell-only: a declared review dimension is malformed. The daemon has no dimension
 * vocabulary at all — a dimension is the harness's annotation on a call, never an engine
 * parameter — so this code can only ever come from the two surfaces that accept the argument,
 * and `test/remedy-surface.test.mjs` checks it is genuinely absent from the daemon's enum.
 * 面 B (`tool/glasspane/kernel.ts:validateDimension`) spells the same code for the same refusal:
 * an agent that drives the app through either doorway must see one vocabulary, and
 * `mcp-shell/test/dimension.test.mjs` is the leg that compares the two surfaces' tool lists so a
 * slot added on one side reddens on the other.
 */
export const GP_E_DIMENSION = "GP_E_DIMENSION";

/**
 * Codes this shell authors **about the caller's request**, as opposed to about its own failure.
 *
 * They are absent from the daemon's enum for a reason that has nothing to do with blame: the
 * daemon has no `dimension` concept to declare, because the argument is stripped before the frame
 * is built. So "the daemon does not declare it" cannot be read as "this gateway did not finish the
 * request", and `test/http-gateway.test.mjs` therefore partitions shell-only codes with this list
 * instead of with enum membership — the infrastructure codes (`GP_E_ENGINE_TIMEOUT`,
 * `GP_E_ENGINE_BACKLOG`, …) still may never be answered as a 4xx, while a code listed here must be
 * *proven* to come from argument validation, by the HTTP test that drives the real route.
 */
export const SHELL_REQUEST_REFUSAL_CODES: readonly string[] = [GP_E_DIMENSION];

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

/**
 * Quote one value for the backticked command an error frame tells the agent to run.
 *
 * This is not a cosmetic concern: the product's own rule is that a remedy is *a command
 * an agent can run on the machine it is told this on*, so every path a caller of this
 * helper interpolates into such a command is text a shell will parse. Those paths are not
 * trusted bytes — a state root arrives from `--state-dir` / `GLASSPANE_STATE_DIR`, an
 * updater record's `runtime.cliPath` from a JSON file on disk, a socket path from a daemon
 * reply — and an unquoted one carrying `;`, `$()` or a backtick turns "check the file"
 * into "run what the file name says".
 *
 * Single quotes, because that is the only POSIX quoting form in which no other character
 * is active: inside a single-quoted word a dollar sign, a backtick, a double quote and a
 * backslash are all literal, and the single quote itself is spliced out and re-added as
 * the four-character sequence quote-backslash-quote-quote. Double quotes would *not* do —
 * the shape this replaced (`shellPath`, which reached for `JSON.stringify` when a path
 * looked odd) produced double-quoted words, where a command substitution still runs.
 *
 * A value made only of characters a shell cannot act on is left bare so the command still
 * reads as one word; anything else — a space, a quote, a dollar sign, a glob, an empty
 * string, or a leading hyphen that would be read as an option — gets quoted.
 */
const SHELL_INERT_WORD = /^[A-Za-z0-9@%+=:,./_-]+$/;

export function quoteShellArg(value: string): string {
  return SHELL_INERT_WORD.test(value) && !value.startsWith("-")
    ? value
    : `'${value.split("'").join("'\\''")}'`;
}