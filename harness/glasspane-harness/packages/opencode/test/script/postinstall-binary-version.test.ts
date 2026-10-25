import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Fixed point: the install hook has to prove it got THIS build, not merely "a binary that runs".
 *
 * `verifyBinary()` used to be `spawnSync(target, ["--version"]).status === 0`, so a platform package
 * that shipped an older or mislabelled binary installed green — while `script/build.ts`'s own smoke
 * test and `scripts/install.sh`'s verify step both compare the printed version. The postinstall is
 * the channel every user's machine runs, and it was the one asserting nothing.
 *
 * These cases drive the real script as a subprocess over a real wrapper layout on disk (its own
 * `package.json`, a resolved platform package, a `bin/` to copy into), because the question is about
 * the bytes that landed, not about a function's return value. The wrapper is built with only
 * `optionalDependencies` and no `product.json` above it — which is exactly how the published wrapper
 * looks, and how `postinstall.mjs` itself says the matrix's "only surviving copy" arrives.
 */
const SCRIPT = path.join(import.meta.dir, "../../script/postinstall.mjs")
const VERSION = "9.9.9"
const PLATFORM = process.platform === "win32" ? "windows" : process.platform
const ARCH = process.arch === "arm" ? "arm" : process.arch
const PACKAGE = `glasspane-harness-${PLATFORM}-${ARCH}`
const TARGET_BINARY = PLATFORM === "windows" ? "glasspane-harness.exe" : "glasspane-harness"

const scratch = mkdtempSync(path.join(tmpdir(), "gp-postinstall-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * One throwaway installed wrapper; `answers` is what its platform binary prints for --version.
 *
 * The script sits at the wrapper ROOT (`publish.ts` copies `script/postinstall.mjs` to
 * `dist/<pkg.name>/postinstall.mjs` and seals it as `"postinstall": "node ./postinstall.mjs"`), so
 * `__dirname` is the package directory and the binary it places lands in that package's `bin/`.
 */
function wrapper(named: string, answers: string | null, exitCode = 0) {
  const root = path.join(scratch, named)
  const platformBin = path.join(root, "node_modules", PACKAGE, "bin")
  mkdirSync(platformBin, { recursive: true })
  mkdirSync(path.join(root, "bin"), { recursive: true })
  cpSync(SCRIPT, path.join(root, "postinstall.mjs"))
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name: "glasspane-harness",
    version: VERSION,
    optionalDependencies: { [PACKAGE]: VERSION },
  }, null, 2)}\n`)
  writeFileSync(path.join(root, "node_modules", PACKAGE, "package.json"), `${JSON.stringify({ name: PACKAGE, version: VERSION })}\n`)
  writeFileSync(path.join(platformBin, TARGET_BINARY), `#!/bin/sh\n${answers === null ? "" : `printf '%s\\n' '${answers}'\n`}exit ${exitCode}\n`)
  chmodSync(path.join(platformBin, TARGET_BINARY), 0o755)
  return { root, target: path.join(root, "bin", "glasspane-harness.exe") }
}

async function install(root: string) {
  const child = Bun.spawn([process.execPath, path.join(root, "postinstall.mjs")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [rc, stdout, stderr] = await Promise.all([
    child.exited,
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
  ])
  return { rc, out: `${stdout}${stderr}` }
}

describe("the install hook compares the version it got", () => {
  test("a platform package whose binary answers a different version is refused", async () => {
    const { root } = wrapper("mismatched", "0.0.0-dev")
    const { rc, out } = await install(root)
    expect(rc).toBe(1)
    expect(out).toContain(`--version answers "0.0.0-dev"`)
    expect(out).toContain(`this package declares "${VERSION}"`)
    expect(out).toContain(PACKAGE)
  })

  test("the refusal says what was observed instead of only blaming the package manager", async () => {
    const { root } = wrapper("observed", "1.2.3")
    const { out } = await install(root)
    expect(out).toContain("What this run observed:")
  })

  test("a binary that runs but answers nothing is refused on its exit code", async () => {
    const { root } = wrapper("silent", null, 7)
    const { rc, out } = await install(root)
    expect(rc).toBe(1)
    expect(out).toContain("--version exited 7")
  })

  test("the matching build installs, and installs the bytes that were checked", async () => {
    const { root, target } = wrapper("matching", VERSION)
    const { rc, out } = await install(root)
    expect(rc).toBe(0)
    expect(out).toBe("")
    expect(statSync(target).mode & 0o777).toBe(0o755)
    expect(statSync(target).isFile()).toBe(true)
  })
})
