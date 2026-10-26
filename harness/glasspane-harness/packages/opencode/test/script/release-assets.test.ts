import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { assetUploadDecision, visibilityFromGhOutput } from "../../script/release-assets"

/**
 * Fixed points for the rule "a public release's assets are not this run's to overwrite".
 *
 * `script/build.ts` uploads with `gh release upload --clobber`. The flag is correct while the
 * release is the draft that `create-release` made — that is how a re-run replaces its own half-built
 * asset — and destructive once the release is public, because npm refuses the same version a second
 * time and keeps its tarballs: one version number would then name two sets of bytes.
 */
describe("the three answers about a release's visibility", () => {
  test("a draft may be overwritten by the run that is assembling it", () => {
    const decision = assetUploadDecision("draft", "v0.12.0")
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.why).toContain("draft")
  })

  test("a public release is refused, and the refusal says what would have broken", () => {
    const decision = assetUploadDecision("published", "v0.12.0")
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.message).toContain("already public")
    expect(decision.message).toContain("--clobber")
    expect(decision.remedy).toContain("cut the next version")
  })

  test("unknown visibility is not draft", () => {
    // The branch that matters most: a token that cannot read releases, a repository that 404s, a
    // gh that is not on PATH. Defaulting this to "draft" would be the function authorising the
    // overwrite it exists to refuse.
    const decision = assetUploadDecision("unaskable", "v0.12.0")
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.message).toContain("could not tell")
    expect(decision.remedy).toContain("gh release view v0.12.0 --json isDraft")
  })
})

describe("the gh answer mapped without a forgiving default", () => {
  test("isDraft true and false are the two states they name", () => {
    expect(visibilityFromGhOutput('{"isDraft":true}', 0)).toBe("draft")
    expect(visibilityFromGhOutput('{"isDraft":false}', 0)).toBe("published")
  })

  test("a non-zero gh is unaskable, whatever it printed", () => {
    expect(visibilityFromGhOutput('{"isDraft":true}', 1)).toBe("unaskable")
  })

  test("a document without the field, or with it as a string, is unaskable", () => {
    // `{"isDraft":"false"}` is truthy in JS; a mapping that read it loosely would call a public
    // release a draft. A document with no field says nothing, and saying nothing is unaskable.
    expect(visibilityFromGhOutput('{"url":"https://github.com/x/y"}', 0)).toBe("unaskable")
    expect(visibilityFromGhOutput('{"isDraft":"false"}', 0)).toBe("unaskable")
    expect(visibilityFromGhOutput("<!doctype html>", 0)).toBe("unaskable")
  })
})

describe("build.ts consumes the decision instead of uploading unconditionally", () => {
  const code = readFileSync(new URL("../../script/build.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")

  test("the upload is behind a decision that can throw", () => {
    expect(code).toContain("assetUploadDecision(")
    expect(code).toContain("visibilityFromGhOutput(")
    expect(code).toMatch(/if \(!decision\.ok\) throw new Error\(`refusing to upload/)
  })

  test("and the only remaining `gh release upload` is the one after that guard", () => {
    const uploads = [...code.matchAll(/gh release upload/g)]
    expect(uploads.length, "build.ts should issue exactly one release upload").toBe(1)
    const guardAt = code.indexOf("if (!decision.ok) throw")
    const uploadAt = code.indexOf("gh release upload")
    expect(guardAt).toBeGreaterThan(-1)
    expect(uploadAt).toBeGreaterThan(guardAt)
  })
})
