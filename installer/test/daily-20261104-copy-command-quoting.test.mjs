/**
 * Two copy-paste commands the installer printed had values interpolated where a shell would
 * re-split or expand them (found 2026-11-04, both in shipped code paths).
 *
 * Both sites were invisible to the static quoting gate, for two different reasons, and the gate
 * now carries a vacuity control for each (mcp-shell/test/remedy-shell-quoting.test.mjs):
 *  - the assignment shape `GLASSPANE_INSTALL_DIR=<hole>` sat inside Chinese copy, and the gate's
 *    "Han present means prose" rule skipped the whole literal;
 *  - `git ls-remote <hole>` used a verb absent from the gate's list, and its operand is a
 *    *name*, not a path. The remote name comes from the cloned tree's own `git remote` output,
 *    and a name containing a space or `$( )` is shell text, not an argument
 *    (`git config 'remote.up stream.url' …` makes one; measured on this machine).
 *
 * Double quotes are not inert quoting: `$( )` and backticks still expand inside them, which is
 * the rule this repo's own SECURITY document states.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { existingCloneDecision, advanceExistingClone, quoteShellArg } from "../cli.js"

const HOSTILE_DIR = "/tmp/x$(touch /tmp/gp-pwned)"
const HOSTILE_REMOTE = "up $(touch /tmp/gp-pwned)"

/** The value has to arrive as ONE single-quoted word, with nothing a shell could expand. */
function assertQuotedWord(value, label) {
  assert.ok(value.startsWith("'") && value.endsWith("'") && value.length > 2,
    `${label} was not wrapped as one word: ${JSON.stringify(value)}`)
  assert.ok(!value.slice(1, -1).includes("'"), `${label} has an unterminated quote: ${JSON.stringify(value)}`)
}

/**
 * Read a copy-paste command the way `sh` would and refuse anything that acts: an unquoted
 * `$( `/backtick expansion, an unquoted control operator, or a double-quoted run that still
 * expands. `quoteShellArg` only quotes values a shell can act on, so the assertion has to be
 * about behaviour, not about how many quote characters came out.
 */
function assertInertShellText(command, label) {
  let i = 0
  while (i < command.length) {
    const c = command[i]
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1)
      assert.notEqual(end, -1, `${label}: unterminated quote in ${JSON.stringify(command)}`)
      if (c === '"') {
        assert.ok(!/[$`]/.test(command.slice(i + 1, end)),
          `${label}: 双引号不是惰性引号，里面的 ${JSON.stringify(command.slice(i + 1, end))} 仍会展开`)
      }
      i = end + 1
      continue
    }
    if (c === "`") {
      throw new assert.AssertionError({ message: `${label}: 未加引号的反引号：${JSON.stringify(command)}` })
    }
    if (c === "$" && (command[i + 1] === "(" || command[i + 1] === "{")) {
      throw new assert.AssertionError({ message: `${label}: 未加引号的展开 ${JSON.stringify(c + command[i + 1])} in ${command}` })
    }
    if (c === ";" || c === "|" || c === "&") {
      throw new assert.AssertionError({ message: `${label}: 未加引号的控制符 ${JSON.stringify(c)} in ${command}` })
    }
    i++
  }
}

test("the dirty-tree refusal keeps the suggested directory as one word", () => {
  const decision = existingCloneDecision({
    targetDir: HOSTILE_DIR,
    ref: "v1.29.1",
    head: "a".repeat(40),
    tagCommit: "b".repeat(40),
    blocking: [" M src/app.ts"],
  })
  assert.equal("refuse", decision.action)
  const expected = `GLASSPANE_INSTALL_DIR=${quoteShellArg(`${HOSTILE_DIR}-v1.29.1`)}`
  assert.ok(decision.text.includes(expected),
    `the remedy must quote the suggested directory; got: ${decision.text}`)
  const quoted = decision.text.match(/GLASSPANE_INSTALL_DIR='[^']*'/)
  assert.ok(quoted, `no one-line install command in: ${decision.text}`)
  assertQuotedWord(quoted[0].slice("GLASSPANE_INSTALL_DIR=".length), "suggested directory")
})

test("the unknown-remote refusal keeps the remote name and the ref as words", () => {
  const ok = (stdout) => ({ status: 0, stdout, stderr: "" })
  const fail = (stderr) => ({ status: 128, stdout: "", stderr })
  const spawn = (cmd, args) => {
    const sub = args.slice(2).join(" ")
    if (sub.startsWith("rev-parse --show-toplevel")) return ok("/tmp/clone\n")
    if (sub.startsWith("rev-parse --verify HEAD")) return ok("c".repeat(40))
    if (sub === "status --porcelain") return ok("")
    if (sub.startsWith("rev-parse --is-shallow-repository")) return ok("false")
    if (sub.startsWith("rev-parse --verify v1.29.1")) return fail("fatal: Needed a single revision")
    if (sub === "remote") return ok(`${HOSTILE_REMOTE}\n`)
    if (sub.startsWith("fetch")) return fail("fatal: unable to access")
    return fail(`unexpected git call: ${sub}`)
  }
  const decision = advanceExistingClone({ repoDir: "/tmp/clone", ref: "v1.29.1", spawn })
  assert.equal("refuse", decision.action)
  assert.ok(decision.text.includes(`git ls-remote ${quoteShellArg(HOSTILE_REMOTE)}`),
    `the remote name must be one word; got: ${decision.text}`)
  // quoteShellArg 只给"shell 能动的"值加引号，所以这里不能要求两枚都带引号——要判的是
  // **照抄这一行之后 shell 会做什么**：远端名里的 `$( )` 不许成为一次展开。
  const printed = decision.text.match(/git ls-remote[^）]*/)?.[0]
  assert.ok(printed, `no ls-remote command in: ${decision.text}`)
  assertInertShellText(printed, "ls-remote 那一行")
})
