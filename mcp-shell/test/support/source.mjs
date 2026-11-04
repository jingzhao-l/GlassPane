/**
 * Source with the comments taken out, for the source-scan gates.
 *
 * COMMENT HANDLING — a deliberate choice, because the two ways of getting it wrong are opposite
 * and both are live in these files:
 *  - Matching raw text would report the *fix* as a defect: `project-registry.ts` explains this rule
 *    where it applies, and that prose names `os.homedir()` and `$HOME` on purpose. A gate that
 *    fired on it would be tuned to be broken, and the next reader would delete the comment to get
 *    green.
 *  - Stripping comments means a call sitting *inside* a comment is not caught. Accepted on purpose:
 *    such a call is dead code and cannot run, so the shape these gates guard is a call site, which
 *    by definition lives in code. What a stripper *can* wrongly hide is real code the strip ate —
 *    so every gate that uses this also requires its positive half to survive the same strip, and an
 *    over-eager strip turns the test red instead of quietly green.
 *
 * WHY THIS IS A TOKEN WALK AND NOT TWO REGEXES (measured 2026-11-04; this is the second paragraph
 * above actually biting): the previous implementation deleted `/\*[\s\S]*?\*\//g` and then dropped
 * `//` lines. `installer/cli.js` documents its own scan set with the words "installer/*.js", and the
 * `/*` inside that doc comment opened a block comment that did not close where its author meant —
 * so ~4.5 KB of real code after it disappeared from the scan, including the
 * `git ls-remote ${...}` command the quoting gate exists to guard. Strings and templates are
 * therefore walked, not regex-matched: a `//` or `/*` inside a value or a comment cannot retire a
 * rule. (A template is treated as one run through its closing backtick, so a nested template inside
 * `${ }` still ends the span early — the same limitation the scanning regexes have, and the reason
 * the 2026-11-04 round moved the interpolation out of the template instead.)
 */

const CODE = 0
const LINE = 1
const BLOCK = 2
const SINGLE = 3
const DOUBLE = 4
const TEMPLATE = 5

export function executableSource(source) {
  let out = ""
  let state = CODE
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]

    if (state === LINE) {
      if (c === "\n") {
        state = CODE
        out += c
      }
      i++
      continue
    }
    if (state === BLOCK) {
      if (c === "*" && next === "/") {
        state = CODE
        i += 2
        continue
      }
      i++
      continue
    }
    if (state === SINGLE || state === DOUBLE || state === TEMPLATE) {
      // Inside a value, `//` and `/*` are text. Nothing about the shape of a comment may delete code.
      if (c === "\\") {
        out += c + (next ?? "")
        i += 2
        continue
      }
      const closer = (state === SINGLE && c === "'")
        || (state === DOUBLE && c === '"')
        || (state === TEMPLATE && c === "`")
      if (closer) {
        state = CODE
        out += c
        i++
        continue
      }
      out += c
      i++
      continue
    }

    // CODE
    if (c === "/" && next === "/") {
      state = LINE
      i += 2
      continue
    }
    if (c === "/" && next === "*") {
      state = BLOCK
      i += 2
      continue
    }
    if (c === "'") state = SINGLE
    else if (c === '"') state = DOUBLE
    else if (c === "`") state = TEMPLATE
    out += c
    i++
  }
  // A trailing `//`-initial line is already dropped above; this pass keeps the older behaviour of
  // removing whole comment-only lines (a block comment can leave blank lines behind).
  return out.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n")
}
