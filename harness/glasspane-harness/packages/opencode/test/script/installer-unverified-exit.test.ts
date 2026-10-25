import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * "Installed, not verified" has to be a different answer from "installed, verified".
 *
 * The curl channel already prints the truth in prose (`sha256: skipped by …`), but prose is a channel
 * only a human reads: an agent that scripts the install branches on the exit code, and until 2026-10-25
 * that code was 0 in both cases. The script is driven from a shell against a live GitHub release, which
 * this repository cannot stage in a test, so what IS checkable is that the flag, the branch that sets
 * it, and the refusal to exit 0 all exist and sit in the right relationship to the verified path.
 */
const SCRIPT = path.join(import.meta.dir, "../../../../scripts/install.sh")
const text = readFileSync(SCRIPT, "utf8")
const lines = text.split("\n")

describe("the installer's unverified outcome is machine-visible", () => {
  test("the script is read, not stubbed", () => {
    expect(lines.length).toBeGreaterThan(400)
  })

  test("the not-fully-verified branch sets the flag it exits on", () => {
    const branch = /case "\$SHA_STATE\/\$GPG_STATE" in\n\s*verified\*\/\*verified\*\) ;;\n\s*\*\)\n\s*UNVERIFIED_INSTALL=1/.test(text)
    expect(branch, "the unverified arm must set UNVERIFIED_INSTALL").toBe(true)
  })

  test("and it is the only place that raises the flag", () => {
    const setters = lines.filter((line) => /UNVERIFIED_INSTALL=1/.test(line))
    expect(setters.length).toBe(1)
  })

  test("the outcome is a distinct exit code, named in the message it prints", () => {
    expect(text).toMatch(/exit 3: installed WITHOUT full verification/)
    expect(text).toMatch(/^  exit 3$/m)
  })
})
