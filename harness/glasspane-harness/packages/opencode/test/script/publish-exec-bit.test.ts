import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { symbolicToMode, validateExecBit } from "../../script/publish-shape"

/**
 * Fixed points for the pack-shape validator's exec-bit assertion.
 *
 * The check these replace was written `if (mode !== undefined && (mode & 0o111) === 0)`, where the
 * mode came from an inline helper that returned `undefined` whenever the `tar -tvzf` listing had no
 * parseable entry for the member. So when the listing came back EMPTY or GARBLED — precisely the
 * state that would let a non-executable binary ship — `mode` was `undefined`, the `!== undefined`
 * short-circuit skipped the assertion, and the run still printed "packs cleanly". A check that
 * degrades to PASS when it cannot observe is the failure this repository keeps being burned by (the
 * sibling `published()` / `verify-published.ts` answer it with a deliberate third verdict).
 *
 * `validateExecBit` now lives in `publish-shape.ts` because `publish.ts` chdirs, takes a publish lock
 * and writes `dist/` at import — it cannot be imported to drive a fixture. That indirection is the
 * whole reason this file could be written at all. The cases build REAL tarballs (as the pack tests
 * do), so the pass case is validated against whatever `tar -tvzf` format this host actually emits.
 */
const scratch = mkdtempSync(path.join(tmpdir(), "gp-exec-bit-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

// A real package/ tree with one executable binary, one non-executable file, packed as the release
// lane packs it (prefix `package/`, member paths relative to the extraction root).
function buildRealTarball(): { tarball: string; listing: string[] } {
  const root = path.join(scratch, "pack")
  mkdirSync(path.join(root, "package", "bin"), { recursive: true })
  writeFileSync(path.join(root, "package", "bin", "glasspane-harness"), "#!/bin/sh\necho hi\n")
  chmodSync(path.join(root, "package", "bin", "glasspane-harness"), 0o755)
  writeFileSync(path.join(root, "package", "plain.txt"), "data\n")
  chmodSync(path.join(root, "package", "plain.txt"), 0o644)
  const tarball = path.join(scratch, "glasspane-harness-0.0.1.tgz")
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"])
  const text = execFileSync("tar", ["-tvzf", tarball], { encoding: "utf8" })
  return { tarball, listing: text.split("\n").filter((line) => line.length > 0) }
}

const BIN = "package/bin/glasspane-harness"
const PLAIN = "package/plain.txt"

describe("the symbolic permission reader behind the exec-bit gate", () => {
  test("parses both tar dialects of the nine mode bits", () => {
    expect(symbolicToMode("rwxr-xr-x")).toBe(0o755)
    expect(symbolicToMode("rw-r--r--")).toBe(0o644)
    expect(symbolicToMode("rwxrwxrwx")).toBe(0o777)
  })
})

describe("what the exec-bit gate reads from a real tarball", () => {
  test("an executable member passes with nothing to complain about", () => {
    const { tarball, listing } = buildRealTarball()
    expect(validateExecBit({ label: "bin/glasspane-harness", member: BIN, tarball, listing })).toEqual([])
  })

  test("a member the archive recorded non-executable is a named problem", () => {
    const { tarball, listing } = buildRealTarball()
    const problems = validateExecBit({ label: "plain.txt", member: PLAIN, tarball, listing })
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("plain.txt")
    expect(problems[0]).toContain("not executable in the tarball")
    expect(problems[0]).toContain("644")
  })

  test("a refusal names the file, the listing command and the tarball", () => {
    const { tarball } = buildRealTarball()
    const problems = validateExecBit({ label: "bin/glasspane-harness", member: BIN, tarball, listing: [] })
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("bin/glasspane-harness")
    expect(problems[0]).toContain("tar -tvzf")
    expect(problems[0]).toContain(tarball)
  })
})

describe("the degrade-to-pass it replaces: unreadable listings must REFUSE, not skip", () => {
  test("an EMPTY listing (tar returned nothing) is a refusal naming what it found", () => {
    const { tarball } = buildRealTarball()
    const problems = validateExecBit({ label: "bin/glasspane-harness", member: BIN, tarball, listing: [] })
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("not named by")
    expect(problems[0]).toContain("0 line(s)")
    expect(problems[0]).toContain(BIN)
  })

  test("a member missing from an otherwise-valid listing is a refusal", () => {
    const { tarball, listing } = buildRealTarball()
    const withoutBin = listing.filter((line) => !line.endsWith(BIN))
    expect(withoutBin.length).toBeLessThan(listing.length)
    const problems = validateExecBit({ label: "bin/glasspane-harness", member: BIN, tarball, listing: withoutBin })
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("not named by")
  })

  test("a GARBLED listing whose mode column is too short is a refusal, not undefined", () => {
    const { tarball } = buildRealTarball()
    // A line that matches the member but carries no 10-character permission field.
    const garbled = [`??? ${BIN}`]
    const problems = validateExecBit({ label: "bin/glasspane-harness", member: BIN, tarball, listing: garbled })
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("no permission field")
    expect(problems[0]).toContain(JSON.stringify("???"))
  })

  test("the wrapper's reason clause is preserved on the non-executable refusal", () => {
    const { tarball } = buildRealTarball()
    const listing = [`-rw-r--r--  0 u g  5 Nov  6 12:00 ${BIN}`]
    const problems = validateExecBit({ label: "bin/x", member: BIN, tarball, listing, reason: "the command would answer \"permission denied\"" })
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("permission denied")
  })
})

describe("the call sites in publish.ts delegate to the tested function", () => {
  // publish.ts cannot be imported (side effects), so the regression lock is on its source: the
  // silent-skip expression that let an unreadable mode pass must be GONE, and the delegation must be
  // PRESENT. Reverting publish.ts to the `mode !== undefined && (mode & 0o111) === 0` form fails this.
  const source = readFileSync(path.join(import.meta.dir, "../../script/publish.ts"), "utf8")

  test("the silent-skip exec guard is gone from publish.ts", () => {
    // `(mode & 0o111) === 0` was the guard's test and appears ONLY in the old code, never in prose —
    // a revert restores it here. (The comment's `mode !== undefined` is prose about the old form.)
    expect(source.includes("(mode & 0o111) === 0")).toBe(false)
  })

  test("both exec sites call validateExecBit", () => {
    const calls = source.split("validateExecBit(").length - 1
    expect(calls).toBeGreaterThanOrEqual(2)
  })
})
