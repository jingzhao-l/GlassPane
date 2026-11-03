import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Fork discipline for the user-facing text of the CLI commands this fork ships.
 *
 * Two rules, both of which were broken in `src/cli/cmd/` until 2026-11:
 *
 *  1. a pointer a user can follow has to resolve *after* installation. `web.ts`'s `describe`
 *     said "see FORK.md". Measured with `npm pack --dry-run` in `packages/opencode`: the tarball
 *     carries its own READMEs and no `FORK.md` — the fork's discipline file never enters the
 *     product, so the sentence sent an installed user to a file they cannot open.
 *  2. the product's own install/docs/scripts surface must not send a user to the upstream
 *     brand's distribution or documentation site. `github.handler.ts` printed
 *     `https://opencode.ai/docs/github/…` and `providers.ts` printed
 *     `https://opencode.ai/docs/providers/…` as their "learn more" lines. Both were replaced by
 *     the primary source for the thing being described (GitHub's own Actions docs, Cloudflare's
 *     own AI Gateway docs).
 *
 * The scan reads string LITERALS, not prose, and the file's comment-stripped text for the
 * markdown-pointer rule: a scan that flagged comments gets "fixed" by deleting the comment and
 * keeping the sentence, which is how this class of defect came back before. `api.opencode.ai` is
 * a functional endpoint the GitHub agent calls, not a pointer a user is told to read, and it is
 * asserted as still-in-range below so the URL rule cannot be satisfied by a scanner that stopped
 * seeing URLs at all.
 *
 * `harness/tools/brand-surface.mjs` ratchets brand strings over a named product-file list which
 * does not include `github.handler.ts`, so this file is the only thing standing between that
 * command and a re-added upstream doc link.
 */

const FILES = {
  "src/cli/cmd/web.ts": "src/cli/cmd/web.ts",
  "src/cli/cmd/github.handler.ts": "src/cli/cmd/github.handler.ts",
  "src/cli/cmd/providers.ts": "src/cli/cmd/providers.ts",
} as const

function sourceOf(file: string): string {
  return readFileSync(path.join(import.meta.dir, "../..", file), "utf8")
}

/** The source with `//` and block comments removed, so a rule about text cannot be met by prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** Every double-quoted, single-quoted and backtick string literal in a comment-free source. */
function stringLiterals(source: string): string[] {
  const text = stripComments(source)
  const found: string[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '"' && ch !== "'" && ch !== "`") continue
    let value = ""
    let j = i + 1
    let closed = false
    for (; j < text.length; j++) {
      const c = text[j]
      if (c === "\\") {
        value += text[j + 1] ?? ""
        j++
        continue
      }
      if (c === ch) {
        closed = true
        break
      }
      value += c
    }
    if (!closed) continue
    found.push(value)
    i = j
  }
  return found
}

const DOC_POINTER = /opencode\.ai\/(docs|install|github|providers)\b/
const DEAD_REPO_POINTER = /\b(?:see |read |docs in |参见 |详见 )?(?:[A-Z0-9_.-]*\/)?(FORK|CHANGELOG|SYNCLOG|CONTRIBUTING)\.md\b/i

describe("the CLI's user-facing text", () => {
  test("no command sends a user to the upstream's docs or install site", () => {
    for (const file of Object.keys(FILES)) {
      const literals = stringLiterals(sourceOf(file))
      expect(literals.length, `${file}: the literal scan read no strings, so it can find no offender either`).toBeGreaterThan(20)
      const offenders = literals.filter((literal) => DOC_POINTER.test(literal))
      expect(offenders, `${file} points a user at the upstream's documentation site: ${JSON.stringify(offenders)}`).toEqual([])
    }
  })

  test("and the scan sees a pointer it is supposed to refuse", () => {
    // THE CONTROL FOR THE SCANNER, in both directions. A rule of the shape "no literal matches X"
    // is satisfied by a parser that read nothing, so the shipped defect is fed back through the
    // same function: the two lines this file exists because of, and the same URL parked in a
    // comment (which the rule must NOT charge, because comments are how a scan that reads prose
    // gets quietly switched off).
    expect(
      stringLiterals('prompts.outro("   Learn more about the GitHub agent - https://opencode.ai/docs/github/#usage-examples")'),
    ).toEqual(["   Learn more about the GitHub agent - https://opencode.ai/docs/github/#usage-examples"])
    expect(stringLiterals('const p = "Read more: https://opencode.ai/docs/providers/#cloudflare-ai-gateway"').filter((l) => DOC_POINTER.test(l))).toHaveLength(1)
    expect(stringLiterals("// see https://opencode.ai/docs/github for the agent\nconst x = 1")).toEqual([])
    // The functional endpoint stays in range, so the rule above is not being met by a scanner
    // that stopped reading URLs: `github.handler.ts` really does carry it today.
    expect(stringLiterals(sourceOf(FILES["src/cli/cmd/github.handler.ts"])).some((literal) => literal.includes("api.opencode.ai"))).toBe(true)
  })

  test("no command sends a user to a file the product does not ship", () => {
    for (const file of Object.keys(FILES)) {
      const text = stripComments(sourceOf(file))
      const matches = text.match(DEAD_REPO_POINTER)
      expect(matches, `${file} tells the user to read a repository file that never enters the release: ${matches?.[0]}`).toBeNull()
    }
  })

  test("web.ts describes what the command does, in words the user can act on", () => {
    // The replacement for the `see FORK.md` pointer: the sentence states the effect of running
    // the command and cites nothing the reader has to go and find.
    const describe = stringLiterals(sourceOf(FILES["src/cli/cmd/web.ts"])).find((literal) => literal.startsWith("start the glasspane-harness server"))
    expect(describe, "the web command has no describe string this scan can read").toBeDefined()
    expect(describe).toContain("web interface")
    expect(describe).not.toMatch(/\.md/)
    expect(describe).not.toMatch(/\bsee\b/i)
  })

  test("the two replaced lines name a primary source the user can open", () => {
    const github = stringLiterals(sourceOf(FILES["src/cli/cmd/github.handler.ts"])).filter((literal) => literal.includes("Learn more"))
    expect(github.length, "the github command's learn-more line is gone").toBeGreaterThan(0)
    for (const line of github) expect(line).toContain("https://docs.github.com/en/actions")

    const cloudflare = stringLiterals(sourceOf(FILES["src/cli/cmd/providers.ts"])).filter((literal) => literal.includes("Cloudflare AI Gateway"))
    expect(cloudflare.length, "the provider prompt's Cloudflare line is gone").toBeGreaterThan(0)
    for (const line of cloudflare) expect(line).toContain("https://developers.cloudflare.com/ai-gateway/")
  })
})
