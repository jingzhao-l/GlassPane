import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import { pullExactnessProblems } from "../../script/pull-exactness"

/**
 * Fixed points for the platform-package gate in the publish lane.
 *
 * The accident these pin is the file's own: on v0.7.6 the release job printed
 * `+ glasspane-harness-darwin-x64@0.7.6`, exited 0, and the registry had no such version — and the
 * pre-install gate that names this check judged "the registry serves this release" by substring over
 * the log lines IT had formatted (`served.every((line) => line.includes(`@${version}`))`), so any
 * served version that merely starts with the wanted one passed: `0.11.14` contains `@0.11.1`. The
 * gate's other conjunct, `pulls.length === served.length`, was structurally always true because the
 * loop pushes or exits through `notServed`. Each case below hands the function the exact record shape
 * the loop produces (`{name, want, seen}`) and names the field the verdict is about.
 */
const release = "0.11.1"
const arm = "glasspane-harness-darwin-arm64"
const x64 = "glasspane-harness-darwin-x64"

describe("what the serves-this-release gate accepts", () => {
  test("every pull answered at exactly the release version is the healthy case, with no problems", () => {
    expect(
      pullExactnessProblems(release, [
        { name: arm, want: release, seen: release },
        { name: x64, want: release, seen: release },
      ]),
    ).toEqual([])
  })
})

describe("what the serves-this-release gate refuses", () => {
  test("the adversarial pair: served 0.11.14 for wanted 0.11.1 is red where the substring verdict was green", () => {
    // This line is the shape the OLD verdict compared: the log string `${name}@${seen} in 1 look(s), 0s`
    // the loop pushed for the adversarial answer. Asserted here so the pair's history is pinned, then
    // the new comparison is asked the same input — it must say the registry answered a different artifact.
    const oldServedLine = `${x64}@0.11.14 in 1 look(s), 0s`
    expect(oldServedLine.includes(`@${release}`)).toBe(true)
    const problems = pullExactnessProblems(release, [{ name: x64, want: release, seen: "0.11.14" }])
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain(x64)
    expect(problems[0]).toContain("0.11.14")
  })

  test("a stale replica answering an older version is the v0.7.6 class, not a pass", () => {
    // The registry answered for the package, but with `0.11.0` — bytes the `0.11.1` tag never named.
    // `servedProbe` surfaces a different version rather than laundering it; this verdict is where it
    // goes red.
    const problems = pullExactnessProblems(release, [{ name: arm, want: release, seen: "0.11.0" }])
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("0.11.0")
  })

  test("a wrapper declaring a range instead of the plain version is refused — the release script never writes one", () => {
    // publish.ts's `declaredPlatforms` maps every platformTargets entry to the plain version string,
    // so `^0.11.1` means the published wrapper does not match what the release script produces, even
    // if the registry happens to answer the wanted version.
    const problems = pullExactnessProblems(release, [{ name: arm, want: "^0.11.1", seen: release }])
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("^0.11.1")
    expect(problems[0]).toContain("plain version")
  })

  test("a range that resolved to a newer version is refused twice: the declaration and the answer", () => {
    const problems = pullExactnessProblems(release, [{ name: x64, want: "^0.11.1", seen: "0.11.14" }])
    expect(problems.length).toBe(2)
    expect(problems.some((line) => line.includes("^0.11.1"))).toBe(true)
    expect(problems.some((line) => line.includes("0.11.14"))).toBe(true)
  })

  test("one bad pull among good ones is named, and the good ones are not charged", () => {
    const problems = pullExactnessProblems(release, [
      { name: arm, want: release, seen: release },
      { name: x64, want: release, seen: "0.11.2" },
    ])
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain(x64)
    expect(problems.some((line) => line.includes(arm))).toBe(false)
  })
})

/**
 * The wiring, pinned in source text: a pure function nothing consumes would close the hole only
 * in this test file. The gate in verify-published.ts must drive its verdict from the records, keep
 * the log array for the detail line only, and not restore the substring comparison.
 */
describe("the release lane actually asks the extracted verdict", () => {
  // Comments stripped the way `registry-readiness.test.ts` strips them: this file's own comments
  // QUOTE the replaced predicate to explain why it was wrong, and a pin over the raw text would
  // be red on the fix's own prose. What must not exist is the predicate in executable position.
  const script = readFileSync(new URL("../../script/verify-published.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")

  test("the pull loop records {name, want, seen} and the check asks pullExactnessProblems", () => {
    expect(script).toContain("resolved.push({ name, want, seen: one.seen })")
    expect(script).toContain("const exact = pullExactnessProblems(version, resolved)")
    expect(script).toContain("exact.length === 0,")
  })

  test("the substring-over-log-line verdict is gone", () => {
    expect(script).not.toContain("served.every((line) => line.includes")
    expect(script).not.toContain("pulls.length === served.length")
  })
})
