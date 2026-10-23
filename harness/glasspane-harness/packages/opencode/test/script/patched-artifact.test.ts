import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Fixed points for the release lane's artifact question: does the shipped binary carry the fork's
 * MCP SDK patch?
 *
 * The criterion is deliberately narrower than "every line the patch adds", and the narrowing is not
 * a taste call — three wider rules were measured against the published 0.10.1 bytes and all three
 * produced false misses: added lines include `.d.ts` content that has no bytes in a runtime bundle;
 * introduced identifiers include locals the bundler renames (`isSessionRetry`, `requestSessionId`,
 * `expiredSessionId`) and upstream symbols the patch merely calls (`isJSONRPCErrorResponse`,
 * `determineScope`); added-call rules include module specifiers the bundler erases (`'../types.js'`).
 * What survived, 8 of 8 present in 145,543,778 bytes, is added string literals plus added method
 * names — data and member keys, which a bundler cannot rename without changing behaviour.
 *
 * These cases drive the real script the way the release lane does (a subprocess, the same exit-code
 * contract), and every payload is a file on disk, not an object handed to a function, because the
 * question is about bytes.
 */
const GATE = path.join(import.meta.dir, "../../../../script/patched-deps.mjs")
const SDK = "@modelcontextprotocol/sdk"
const scratch = mkdtempSync(path.join(tmpdir(), "gp-patched-artifact-"))

async function run(args: string[]): Promise<{ rc: number | null; out: string }> {
  const child = Bun.spawn([process.execPath, GATE, ...args], { stdout: "pipe", stderr: "pipe" })
  const [rc, stdout, stderr] = await Promise.all([
    child.exited,
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
  ])
  return { rc, out: `${stdout}${stderr}` }
}

function payload(named: string, content: string): string {
  const file = path.join(scratch, named)
  writeFileSync(file, content)
  return file
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe("what the published bytes are asked to show", () => {
  test("the demand list comes from the declared patch, and it is the narrow set", async () => {
    const { rc, out } = await run(["--items", "--package", SDK])
    expect(rc).toBe(0)
    const items: string[] = JSON.parse(out.trim())
    expect(items.length).toBeGreaterThan(0)
    // The method key and the error string the patch invents — the evidence that the patched
    // transport, not upstream's, was bundled.
    expect(items).toContain("_recoverSession")
    expect(items).toContain("Request is no longer active")
    // And the names that WOULD break the check if the rule were widened to "anything the patch
    // introduces": locals the bundler renames, and upstream symbols the patch only calls.
    expect(items).not.toContain("isSessionRetry")
    expect(items).not.toContain("requestSessionId")
    expect(items).not.toContain("isJSONRPCErrorResponse")
  })

  test("a payload that carries every demanded item passes, and says how many it read", async () => {
    const { out: itemsOut } = await run(["--items", "--package", SDK])
    const items: string[] = JSON.parse(itemsOut.trim())
    const file = payload("patched.bin", `#!/bin/sh\n# payload\n${items.join("\n")}\n`)
    const { rc, out } = await run(["--artifact", file, "--package", SDK])
    expect(rc).toBe(0)
    expect(out).toContain(`all ${items.length} artifact-checkable item(s)`)
  })

  test("one missing item is a named failure, not a count", async () => {
    const { out: itemsOut } = await run(["--items", "--package", SDK])
    const items: string[] = JSON.parse(itemsOut.trim())
    const dropped = items[0]
    const file = payload("unpatched.bin", `# payload without one marker\n${items.slice(1).join("\n")}\n`)
    const { rc, out } = await run(["--artifact", file, "--package", SDK])
    expect(rc).toBe(1)
    expect(out).toContain("FAIL")
    expect(out).toContain(dropped)
    expect(out).toContain("the bundle was built from unpatched sources")
  })

  test("an empty payload fails every item rather than passing for want of one", async () => {
    const file = payload("empty.bin", "")
    const { rc, out } = await run(["--artifact", file, "--package", SDK])
    expect(rc).toBe(1)
    expect(out).toContain("FAIL")
  })

  test("a patch with nothing an artifact can be asked about refuses instead of passing", async () => {
    // `effect` is a real declared patch whose hunks add no string literal or method name — measured:
    // 18 of this fork's 19 declared patches are like this, which is exactly why the release lane
    // names the package it asks about rather than sweeping the declarations.
    const items = await run(["--items", "--package", "effect"])
    expect(JSON.parse(items.out.trim())).toEqual([])
    const file = payload("whatever.bin", readFileSync(GATE, "utf8"))
    const { rc, out } = await run(["--artifact", file, "--package", "effect"])
    expect(rc).toBe(2)
    expect(out).toContain("refusing to report a question never asked as a pass")
  })

  test("unanswerable questions are exit 2, never a green", async () => {
    const noPackage = await run(["--artifact", payload("x.bin", "x")])
    expect(noPackage.rc).toBe(2)
    expect(noPackage.out).toContain("--artifact needs --package")

    const missingFile = await run(["--artifact", path.join(scratch, "not-here.bin"), "--package", SDK])
    expect(missingFile.rc).toBe(2)
    expect(missingFile.out).toContain("could not be read")

    const undeclared = await run(["--artifact", payload("y.bin", "y"), "--package", "@glasspane/does-not-exist"])
    expect(undeclared.rc).toBe(2)
    expect(undeclared.out).toContain("no patchedDependencies declaration")
  })
})
