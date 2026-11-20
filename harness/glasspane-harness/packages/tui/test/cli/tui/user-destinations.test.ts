import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Fork discipline for the user-visible destinations this fork's TUI opens and names.
 *
 * Three rules, all of which were broken until 2026-11-20:
 *
 *  1. the crash screen filed its bug report on the UPSTREAM tracker. `error-component.tsx`'s
 *     `buildIssueURL` pointed at `github.com/anomalyco/opencode/issues/new` and pre-filled the
 *     field ids of upstream's own `bug-report.yml` (`opencode-version`/`terminal`/`reproduce`).
 *     Those ids do not exist in this repository's template, so every field silently dropped.
 *  2. the `docs.open` slash command opened the upstream's documentation site
 *     (`https://opencode.ai/docs`). This product's own `docs/` is the canonical documentation.
 *  3. the retry dialog carried the upstream's paid-tier gateway (`opencode.ai/go`) and the
 *     decorative "Go" treatment built for it. The producer is disabled here
 *     (`GO_UPSELL_PROVIDERS` is empty), so the constant and its branch were dead — but the
 *     gateway URL still shipped in the bundle.
 *
 * The scan reads string LITERALS in comment-free source: a scan that flagged comments gets
 * "fixed" by deleting the comment and keeping the string, which is how this class of defect came
 * back before. `brand-surface.mjs` ratchets brand strings over a product-file list that does not
 * include these three TUI files, so this file is the only thing standing between them and a
 * re-added upstream destination.
 */

const FILES = {
  "src/component/error-component.tsx": "src/component/error-component.tsx",
  "src/component/dialog-retry-action.tsx": "src/component/dialog-retry-action.tsx",
  "src/app.tsx": "src/app.tsx",
} as const

function sourceOf(file: string): string {
  return readFileSync(path.join(import.meta.dir, "../../..", file), "utf8")
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

/** The upstream repository this product is a fork of — no user-facing destination may name it. */
const UPSTREAM_TRACKER = /github\.com\/anomalyco\/opencode\b/
/** The upstream brand's documentation / install site. */
const UPSTREAM_DOCS_SITE = /opencode\.ai\/docs\b/
/** The upstream brand's paid-tier gateway. */
const UPSTREAM_GATEWAY = /opencode\.ai\/(?:go|zen)\b/

describe("the TUI's user-visible destinations", () => {
  test("the crash screen files its report on this product's tracker, not upstream's", () => {
    const literals = stringLiterals(sourceOf(FILES["src/component/error-component.tsx"]))
    expect(literals.length, "the crash-screen literal scan read no strings, so it can find no offender either").toBeGreaterThan(5)
    const tracker = literals.filter((literal) => UPSTREAM_TRACKER.test(literal))
    expect(tracker, `the crash screen still points at upstream's issue tracker: ${JSON.stringify(tracker)}`).toEqual([])
    const ours = literals.filter((literal) => /github\.com\/jingzhao-l\/glasspane-harness\/issues\/new/.test(literal))
    expect(ours.length, "the crash screen names no issue URL for this product at all — the fix regressed to no destination").toBeGreaterThan(0)
  })

  test("the crash screen pre-fills THIS repository's bug-report field ids", () => {
    const source = stripComments(sourceOf(FILES["src/component/error-component.tsx"]))
    // Upstream's ids — present in their template, absent from ours, so a pre-fill that used them
    // would be silently discarded by GitHub.
    for (const upstreamId of ["opencode-version", "reproduce"]) {
      expect(source.includes(upstreamId), `the crash screen still pre-fills upstream-only field id '${upstreamId}'`).toBe(false)
    }
    // Ours — the ids `.github/ISSUE_TEMPLATE/bug-report.yml` actually declares.
    for (const ourId of ["version", "os", "what"]) {
      expect(source.includes(`"${ourId}"`), `the crash screen does not pre-fill this repo's field id '${ourId}'`).toBe(true)
    }
  })

  test("the crash screen names the product, not the upstream brand, in its user-visible copy", () => {
    const literals = stringLiterals(sourceOf(FILES["src/component/error-component.tsx"]))
    const branded = literals.filter((literal) => /\bopencode\b/i.test(literal) && /crashed|TUI crashed/.test(literal))
    expect(branded, `the crash screen still says 'opencode' where it should name this product: ${JSON.stringify(branded)}`).toEqual([])
    const ours = literals.filter((literal) => /glasspane-harness.*crashed|crashed/.test(literal))
    expect(ours.length, "no crash-screen string names a crash at all").toBeGreaterThan(0)
  })

  test("docs.open opens this product's documentation, not the upstream's site", () => {
    const literals = stringLiterals(sourceOf(FILES["src/app.tsx"]))
    expect(literals.length, "the app.tsx literal scan read no strings, so it can find no offender either").toBeGreaterThan(20)
    const offenders = literals.filter((literal) => UPSTREAM_DOCS_SITE.test(literal))
    expect(offenders, `docs.open still points a user at the upstream's documentation site: ${JSON.stringify(offenders)}`).toEqual([])
  })

  test("the retry dialog carries no upstream paid-tier gateway URL", () => {
    const source = stripComments(sourceOf(FILES["src/component/dialog-retry-action.tsx"]))
    expect(source.includes("opencode.ai/go"), "the retry dialog still hardcodes the upstream gateway URL").toBe(false)
    const literals = stringLiterals(sourceOf(FILES["src/component/dialog-retry-action.tsx"]))
    const offenders = literals.filter((literal) => UPSTREAM_GATEWAY.test(literal))
    expect(offenders, `the retry dialog still names the upstream gateway: ${JSON.stringify(offenders)}`).toEqual([])
  })

  test("and the scan sees every destination it is supposed to refuse", () => {
    // THE CONTROL FOR THE SCANNER, in both directions. A rule of the shape "no literal matches X"
    // is satisfied by a parser that read nothing, so each upstream destination is fed back
    // through the same function that must catch it — and parked in a comment (which the rules
    // must NOT charge, because comments are how a scan that reads prose "fixes" itself).
    const planted = [
      'const url = new URL("https://github.com/anomalyco/opencode/issues/new?template=bug-report.yml")',
      'open("https://opencode.ai/docs").catch(() => {})',
      'const GO_URL = "https://opencode.ai/go"',
    ]
    const docScan = (src: string) => stringLiterals(src).filter((l) => UPSTREAM_TRACKER.test(l) || UPSTREAM_DOCS_SITE.test(l) || UPSTREAM_GATEWAY.test(l))
    for (const line of planted) {
      expect(docScan(`${line}\n`), `the scanner stopped seeing this upstream destination, so the rules above certify nothing: ${line}`).toHaveLength(1)
    }
    // The same three parked in comments must stay silent — comments are stripped first.
    for (const line of planted) {
      expect(docScan(`// ${line}\n`), `the scanner charged a comment, so a [gp] note that only explains a removal would read as a live violation: ${line}`).toEqual([])
    }
  })
})
