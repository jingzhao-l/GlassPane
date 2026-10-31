import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { executeUninstall } from "../../../src/cli/cmd/uninstall"
import { tmpdir } from "../../fixture/fixture"

// The product's name, read from the machine-readable source rather than typed here: the same
// argument the package manager is asked to remove is the claim being asserted.
const PRODUCT = (
  (await Bun.file(new URL("../../../../../product.json", import.meta.url).pathname).json()) as {
    name: string
  }
).name

/** A stub package manager that records its argv and answers `uninstall`/`remove` with a failure. */
async function failing(dir: string, name: string, log: string) {
  const script = [
    "#!/bin/sh",
    `{ printf '${name}'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> ${log}`,
    "echo 'stub: refusal from the package manager' >&2",
    "exit 9",
    "",
  ].join("\n")
  const file = path.join(dir, name)
  await Bun.write(file, script)
  await fs.chmod(file, 0o755)
}

/**
 * Drives the real executor with NOTHING to delete (`directories: []`, no shell config, no binary),
 * so the only thing it can touch is the package manager stub on PATH — no file on this machine is
 * removed by this test.
 */
async function run(method: "npm" | "pnpm" | "bun", manager: string) {
  await using tmp = await tmpdir()
  const log = path.join(tmp.path, "calls.log")
  await failing(tmp.path, manager, log)
  for (const other of ["npm", "pnpm", "bun", "brew"]) {
    if (other === manager) continue
    await failing(tmp.path, other, log)
  }
  const previousPath = process.env.PATH
  const previousWrite = process.stdout.write.bind(process.stdout)
  const previousExitCode = Number(process.exitCode ?? 0)
  const printed: string[] = []
  process.stdout.write = ((chunk: string | Uint8Array) => {
    printed.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.env.PATH = `${tmp.path}:/usr/bin:/bin`
  // Pinned to 0 at entry, and restored after: `process.exitCode = undefined` does not clear it in
  // every runtime, so a leaked 1 would make the next test pass for the previous test's reason.
  process.exitCode = 0
  try {
    await executeUninstall(method, { directories: [], shellConfig: null, binary: null })
  } finally {
    process.stdout.write = previousWrite
    process.env.PATH = previousPath
  }
  const code = Number(process.exitCode ?? 0)
  process.exitCode = previousExitCode
  const calls = (await Bun.file(log).text().catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return { printed: printed.join(""), code, calls }
}

describe("glasspane-harness uninstall exit contract", () => {
  // [gp] Product: a package manager that refused the removal used to be printed and then dropped.
  // `errors` collected only filesystem/shell-config failures, so the summary block never ran and
  // the command ended with "Thank you for using glasspane-harness!" and exit 0 — a half-done
  // uninstall wearing the face of a finished one, to an operator that reads `$?` first.
  test("a refused npm uninstall is collected as a failure and exits non-zero", async () => {
    const { printed, code, calls } = await run("npm", "npm")
    expect(calls).toContain(`npm uninstall -g ${PRODUCT}`)
    expect(printed).toContain("Package manager uninstall failed: exit code 9")
    expect(printed).toContain("Some operations failed:")
    expect(printed).toContain(`run manually: npm uninstall -g ${PRODUCT}`)
    expect(code).toBe(1)
  })

  test("a refused bun removal is the same refusal, not a silent success", async () => {
    const { printed, code, calls } = await run("bun", "bun")
    expect(calls).toContain(`bun remove -g ${PRODUCT}`)
    expect(printed).toContain("Some operations failed:")
    expect(code).toBe(1)
  })

  // The other half of the guard: this must not be "any uninstall exits 1". A removal the package
  // manager accepted has to leave the code alone, or the fix above is just a new lie.
  test("a package manager that accepts the removal does not exit non-zero", async () => {
    await using tmp = await tmpdir()
    const log = path.join(tmp.path, "calls.log")
    const script = [
      "#!/bin/sh",
      `{ printf 'npm'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> ${log}`,
      "exit 0",
      "",
    ].join("\n")
    await Bun.write(path.join(tmp.path, "npm"), script)
    await fs.chmod(path.join(tmp.path, "npm"), 0o755)
    for (const other of ["pnpm", "bun", "brew"]) {
      await Bun.write(path.join(tmp.path, other), "#!/bin/sh\nexit 0\n")
      await fs.chmod(path.join(tmp.path, other), 0o755)
    }
    const previousPath = process.env.PATH
    const previousWrite = process.stdout.write.bind(process.stdout)
    const previousExitCode = Number(process.exitCode ?? 0)
    const printed: string[] = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    process.env.PATH = `${tmp.path}:/usr/bin:/bin`
    process.exitCode = 0
    try {
      await executeUninstall("npm", { directories: [], shellConfig: null, binary: null })
    } finally {
      process.stdout.write = previousWrite
      process.env.PATH = previousPath
    }
    const code = Number(process.exitCode ?? 0)
    process.exitCode = previousExitCode
    expect(printed.join("")).toContain("Package removed")
    expect(printed.join("")).not.toContain("Some operations failed:")
    expect(code).toBe(0)
  })
})
