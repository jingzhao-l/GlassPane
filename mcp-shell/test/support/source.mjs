/**
 * Source with the comments taken out, for the source-scan gates.
 *
 * COMMENT HANDLING — a deliberate choice, because the two ways of getting it
 * wrong are opposite and both are live in these files:
 *  - Matching raw text would report the *fix* as a defect: `project-registry.ts`
 *    now explains this rule where it applies, and that prose names `os.homedir()`
 *    and `$HOME` on purpose. A gate that fired on it would be tuned to be broken,
 *    and the next reader would delete the comment to get green.
 *  - Stripping comments means a call sitting *inside* a comment is not caught.
 *    That one is accepted on purpose: such a call is dead code and cannot run,
 *    so the shape this gate guards is a call site, which by definition lives in
 *    code. What a stripper *can* wrongly hide is a real call the strip ate —
 *    so each gate that uses this also requires its positive half to survive the
 *    same strip, and an over-eager strip turns the test red instead of quietly
 *    green.
 *
 * Both languages here use line comments and block comments (`///` doc lines are
 * line comments), which is why one helper serves both sides — and why it lives
 * in `test/support/` rather than beside one of the two callers: a ban matched
 * against raw text in one file and against stripped text in another is two
 * different rules wearing one name, which is how `R8-中9`'s seam count fired on
 * a comment the day it was written.
 */
export function executableSource(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}
