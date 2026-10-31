/**
 * One value, quoted as one shell word — the updater-side copy of the product rule.
 *
 * The rule lives on both sides of this product and is the *same rule*:
 *   - `mcp-shell/src/errors.ts:96-124` (`quoteShellArg`, TypeScript side),
 *   - `engine/Sources/GlassPaneEngine/StateRoot.swift:438-444` (`RemedyCommand.quote`, Swift side).
 * A remedy in this product is defined as *a command an agent runs on the machine it is told
 * this on*, and every path a remedy interpolates is text a shell will parse. Those paths are
 * not trusted bytes: the state root arrives from `--state-dir` / `GLASSPANE_STATE_DIR`, and
 * the settings panel hands the DAEMON-REPORTED root straight through
 * (`engine/Sources/glasspane-settings/UpdateModel.swift:266-271` passes `stateRoot` as a bare
 * argument value). One path carrying `$(`, `;` or a backtick turns "check the file" into
 * "execute what the path says", with the agent's own privileges.
 *
 * Single quotes, because that is the only POSIX quoting form in which no other character is
 * active; the single quote itself is spliced out and re-added as the four-character sequence
 * quote-backslash-quote-quote. Double quotes do NOT work: inside them a command substitution
 * still runs — that double-quoted shape is exactly what one of this file's callers used before
 * this helper existed, and `test/daily-20261022-updater.test.mjs` keeps the control that shows
 * it failing.
 *
 * Why a second implementation is legitimate here and nowhere else: `updater/` ships standalone
 * (its `lib/` is bundled into the state root beside `agent-entry.js`, and the package cannot
 * import `mcp-shell/dist`), so a cross-package import is impossible. What this file therefore
 * is: THE single updater-side implementation — every updater site that quotes (lib/check.js,
 * lib/source.js, and lib/invocation.js, which is where lib/policy.js's remedy operands get quoted
 * now) imports it rather than writing its own rule, and
 * `mcp-shell/test/remedy-shell-quoting.test.mjs` scans `updater/lib/*.js` and `updater/*.js`
 * with the same argument-position judgement it applies to `mcp-shell/src`, so a bare
 * interpolation at a command operand fails the gate on both sides in one test run.
 */

/** Characters a shell cannot act on inside an unquoted word. */
const SHELL_INERT_WORD = /^[A-Za-z0-9@%+=:,./_-]+$/

/**
 * `value` as one shell word: left bare when it is made only of characters a shell cannot act
 * on (so ordinary paths still read as one word), and single-quoted with `'\''` splices for
 * anything else — a space, a quote, a dollar sign, a glob, the empty string (an argument that
 * vanished is a different command line), or a leading hyphen (read as an option otherwise).
 * Same table as `mcp-shell/src/errors.ts`'s `quoteShellArg`; the two tables are pinned by
 * identically named cases in their respective test files.
 */
export function quoteShellArg(value) {
  const text = String(value)
  return SHELL_INERT_WORD.test(text) && !text.startsWith('-')
    ? text
    : `'${text.split("'").join("'\\''")}'`
}
