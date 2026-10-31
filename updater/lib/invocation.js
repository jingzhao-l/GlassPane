/**
 * One value, quoted as one shell word — the updater-side copy of the product rule.
 * 见 `shell-quote.js`。这一份管的是另一半：把"跑哪一份程序"这件事说成一个真的路径。
 *
 * WHY THIS EXISTS. A remedy in this product is not prose: `SECURITY.md` §3, the specs and
 * `mcp-shell/src/update-state.ts:615-625` all define it as *the command an agent runs on the
 * machine it is told this on* — `bits.push(`lastError=${code}: ${message}`)` forwards the
 * updater's own sentence verbatim to the agent. Until this file existed, 70 string literals across
 * `updater/*.js`, `updater/lib/*.js` and `mcp-shell/src/tools.ts` told the reader to run a bare
 * `updater check` / `updater apply` / `updater rollback` / `updater status` / `updater enable` /
 * `updater disable`. There is no executable named `updater` on any machine this product installs:
 * `updater/package.json` has no `bin` field (the package is `private: true` and is never
 * published), npm publishes only `glasspane-mcp` and `glasspane-install`, and `install.sh` links
 * no such name. Copying any one of those sentences answers 127.
 *
 * THE OTHER HALF ALREADY KNEW THIS. The settings panel stopped saying it and started saying a
 * path:
 *   - `engine/Sources/glasspane-settings/UpdatePanelLogic.swift:401` — "这台机器上没有一个叫
 *     `updater` 的可执行文件，让人去跑 `updater status` 是一条走不通的路";
 *   - the same file, `:482-484` — "从前这里写的是'跑一次 `updater status`'，而这台机器上没有任何叫
 *     `updater` 的可执行文件——那句话指的路人走不通，而它是这一屏唯一给出的下一步";
 *   - and `:510`/`:519` render the control as `node <updaterPath> status --state-dir <root>`, with
 *     every operand quoted by `StateRoot.swift:438-444` (`RemedyCommand.quote`).
 * The Swift side is face A; the JS strings above were face B, still issuing the old order. This
 * file is the fix for face B, and it is the ONLY place in `updater/` that names how this package's
 * CLI is invoked, so a second copy of the path rule cannot grow beside the first.
 *
 * WHAT THE COMMAND IS: `node <real path of this package's cli.js> <verb> <args…>`. The path comes
 * from `import.meta.url` of this module (`updater/lib/`), then `fs.realpathSync` — a delivered
 * entry commonly *is* a link (this repo has already been bitten by npm's bin symlink, see
 * `test/npm-binary-resolution.test.mjs`), and a remedy naming the link name is naming a file that
 * may not be where the reader thinks it is. Every operand, including the CLI path, goes through
 * `quoteShellArg`: an argument position may not carry double quotes (a command substitution still
 * runs inside them) and may not carry a bare interpolation. That is the rule
 * `mcp-shell/test/remedy-shell-quoting.test.mjs` enforces on both languages, and
 * `test/remedy-command-invocable.test.mjs` enforces the shape of what this helper prints.
 *
 * `commandFrom` is exported as the seam: the behaviour test drives it with a path containing a
 * space and a backtick, which no real install on this machine can arrange.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { quoteShellArg } from './shell-quote.js'

/**
 * This package's CLI, as the absolute path a reader on THIS machine can hand to `node`.
 * Computed from `import.meta.url` rather than from `process.argv[1]` (whatever the caller typed),
 * from `process.cwd()` (the reader's, not this package's) or from `$GLASSPANE_*` (a caller-controlled
 * variable) — the three spellings this repo has already been burned by for a path that has to be
 * this file's own neighbour.
 *
 * @param ownUrl the URL of the module computing its neighbour; `import.meta.url` by default, so a
 *   test can ask what the rule produces for a module standing somewhere else.
 */
export function resolveCliPath(ownUrl = import.meta.url) {
  const lexical = path.resolve(path.dirname(fileURLToPath(ownUrl)), '..', 'cli.js')
  try {
    // `realpathSync` throws for a path that does not exist; the lexical name is still the honest
    // answer then (a test tree, a half-installed copy), and refusing to print anything would put
    // the reader back in the position the bare `updater` name put them in.
    return fs.realpathSync(lexical)
  } catch {
    return lexical
  }
}

/** The path itself, resolved once at import: this package's `cli.js`, real name. */
export const UPDATER_CLI = resolveCliPath()

/**
 * `node <cliPath> <args…>` with every word quoted by `quoteShellArg` — the pure half of the rule,
 * with the path handed in rather than resolved from disk. `updaterCommand` is this with the real
 * path; tests that need a hostile path call this one.
 *
 * Args are positional strings (`'check'`, `'--consent'`, `'major'`). A flag and its value are two
 * args, never one `'--consent major'` string: the helper would then single-quote the pair together
 * and the shell would hand the CLI one argument containing a space, which is a flag that names
 * nothing. An `undefined`/`null` arg is dropped rather than printed as the word `'undefined'` —
 * a remedy that tells the reader to pass a state root this run did not have is worse than one
 * that says it does not know the root.
 */
export function commandFrom(cliPath, args = []) {
  const words = args
    .filter((arg) => arg !== undefined && arg !== null)
    .map((arg) => quoteShellArg(String(arg)))
  return `node ${quoteShellArg(cliPath)}${words.length > 0 ? ` ${words.join(' ')}` : ''}`
}

/** The command this product's remedies hand to a reader: this package's CLI, run by absolute path. */
export function updaterCommand(...args) {
  return commandFrom(UPDATER_CLI, args)
}
