import { describe, expect, test } from "bun:test"

import { validatePackageIdentity } from "../../script/publish-shape"

/**
 * Fixed points for the publish lane's identity gate.
 *
 * The check these replace read the package's name out of its own `package.json` and compared
 * it with a string read out of that same file, so it was green for every input — a self-echo
 * wearing the label of a control. Each case below is the shape of one accident that gate would
 * have missed, and each names the field the refusal is about.
 */
const wrapper = "glasspane-harness"
const arm = "glasspane-harness-darwin-arm64"
const x64 = "glasspane-harness-darwin-x64"
const allowed = [wrapper, arm, x64]
const version = "0.7.10"

describe("what the publish lane refuses to put on the registry", () => {
  test("the wrapper and each declared target pass with nothing to complain about", () => {
    for (const name of [wrapper, arm, x64]) {
      expect(validatePackageIdentity({ manifest: { name, version }, dirName: name, expectedVersion: version, allowedNames: allowed })).toEqual([])
    }
  })

  test("a dist left behind by the previous release is refused by version", () => {
    const problems = validatePackageIdentity({ manifest: { name: arm, version: "0.7.9" }, dirName: arm, expectedVersion: version, allowedNames: allowed })
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("version")
    expect(problems[0]).toContain("0.7.9")
    expect(problems[0]).toContain(version)
  })

  test("a manifest that does not name its own directory is refused — the directory is the independent source", () => {
    const problems = validatePackageIdentity({ manifest: { name: arm, version }, dirName: x64, expectedVersion: version, allowedNames: allowed })
    expect(problems.some((line) => line.includes("dist directory"))).toBe(true)
  })

  test("a name the product does not publish is refused even when its directory agrees with it", () => {
    // The self-echo's blind spot: `binaries` is keyed by `found.name`, so a planted or stale
    // dist satisfied the old check by construction and would have been published under whatever
    // name it carried. This target was dropped by owner decision (product.json's platform.dropped
    // names the Windows lane), so a dist carrying it can only be stale or planted.
    const foreign = "glasspane-harness-windows-x64"
    const problems = validatePackageIdentity({ manifest: { name: foreign, version }, dirName: foreign, expectedVersion: version, allowedNames: allowed })
    expect(problems.some((line) => line.includes("not a package this product publishes"))).toBe(true)
    expect(problems.some((line) => line.includes(foreign))).toBe(true)
  })

  test("a manifest with no name at all is refused rather than compared against undefined", () => {
    const problems = validatePackageIdentity({ manifest: { version }, dirName: arm, expectedVersion: version, allowedNames: allowed })
    expect(problems.some((line) => line.includes("not a package this product publishes"))).toBe(true)
  })

  test("a version that is only missing is refused, not read as equal", () => {
    const problems = validatePackageIdentity({ manifest: { name: arm }, dirName: arm, expectedVersion: version, allowedNames: allowed })
    expect(problems.some((line) => line.includes("version"))).toBe(true)
  })
})
