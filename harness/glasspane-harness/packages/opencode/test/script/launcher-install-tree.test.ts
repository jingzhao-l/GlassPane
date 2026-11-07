import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Fixed point: the shipped launcher may only exec a copy this install can account for.
 *
 * `findBinary()` walked every `node_modules` ABOVE the wrapper — out of the project, through the
 * home directory, to `/` — and handed whatever it found straight to `spawn`, while
 * `GLASSPANE_HARNESS_BIN_PATH` / `OPENCODE_BIN_PATH` were exec'd with no statement at all about
 * the bytes. script/postinstall.mjs's `resolveBinary()` was fixed to the same hazard (its comment
 * block above `installTrees()` records it: a package planted in an ancestor directory satisfied
 * the old search, and `--version` string equality is answered by a 3-line shell script) and this
 * shim — the other half of the same channel, the one that runs on the user's machine for every
 * `glasspane-harness` command — kept the weak rule.
 *
 * These cases drive the real file as an installed copy runs it: a scratch
 * `node_modules/glasspane-harness` layout, `node` on the launcher, and a fixture binary that
 * records in a marker file that IT executed. "Refused" here is never read off the output alone —
 * the marker is the statement that nothing was spawned.
 */
const LAUNCHER = path.join(import.meta.dir, "../../bin/glasspane-harness")
const PRODUCT_VAR = "GLASSPANE_HARNESS_BIN_PATH"
const LEGACY_VAR = "OPENCODE_BIN_PATH"
const VERSION = "9.9.9"
const PLATFORM = process.platform === "win32" ? "windows" : process.platform
const PACKAGE = `glasspane-harness-${PLATFORM}-${process.arch}`
const BINARY = PLATFORM === "windows" ? "glasspane-harness.exe" : "glasspane-harness"

// Realpath the scratch root: the launcher compares `fs.realpathSync` output against the tree it
// derives from its own realpath, and macOS hands out `/var/…` for a path that resolves to
// `/private/var/…`. Built from the resolved root, every fixture is compared the way the launcher
// compares.
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "gp-launcher-")))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * `<base>/proj/node_modules/glasspane-harness` — the hoisted npm layout with the launcher copy in
 * its `bin/`. The manifest seals one platform package at `VERSION` and no `product.json` sits
 * three directories above the shim, which is how the published wrapper looks and how the launcher
 * itself says the matrix's "only surviving copy" arrives.
 */
function wrapper(named: string) {
  const base = path.join(scratch, named)
  const modules = path.join(base, "proj", "node_modules")
  const root = path.join(modules, "glasspane-harness")
  mkdirSync(path.join(root, "bin"), { recursive: true })
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "glasspane-harness", version: VERSION, optionalDependencies: { [PACKAGE]: VERSION } }, null, 2)}\n`,
  )
  const launcher = path.join(root, "bin", "glasspane-harness")
  writeFileSync(launcher, readFileSync(LAUNCHER, "utf8"))
  chmodSync(launcher, 0o755)
  return { base, modules, launcher, marker: path.join(base, "spawned.marker") }
}

/** A platform package with a correct-looking manifest whose binary records that it ran. */
function platformPackage(dir: string, version: string, marker: string) {
  mkdirSync(path.join(dir, "bin"), { recursive: true })
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: PACKAGE, version, os: PLATFORM, cpu: process.arch }, null, 2)}\n`)
  writeFileSync(path.join(dir, "bin", BINARY), `#!/bin/sh\n: > '${marker}'\nprintf '%s\\n' '${version}'\n`)
  chmodSync(path.join(dir, "bin", BINARY), 0o755)
}

/** A standalone executable an override can name; the marker is written by those same bytes. */
function privateBinary(base: string, name: string, mode: number) {
  const file = path.join(base, "private", name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n: > '${base}/env-spawned.marker'\nprintf '%s\\n' '${VERSION}'\n`)
  chmodSync(file, mode)
  return file
}

async function launch(fixture: { base: string; launcher: string }, env: Record<string, string> = {}) {
  const ambient = { ...process.env }
  // Neither override may leak in from the maintainer's shell — every case below sets exactly the
  // one it means to test. `installer-selftest.sh` strips the same two names for the same reason.
  for (const key of [PRODUCT_VAR, LEGACY_VAR]) delete ambient[key]
  const child = Bun.spawn(["node", fixture.launcher, "--version"], {
    cwd: path.join(fixture.base, "proj"),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...ambient, ...env },
  })
  const [rc, stdout, stderr] = await Promise.all([child.exited, Bun.readableStreamToText(child.stdout), Bun.readableStreamToText(child.stderr)])
  return { rc, out: `${stdout}${stderr}` }
}

describe("the launcher only execs a copy this install can account for", () => {
  test("a platform package planted in an ancestor node_modules is not spawned, and neither is one planted in $HOME", async () => {
    const fixture = wrapper("ancestor")
    const home = path.join(fixture.base, "home")
    // `<base>/node_modules` is on the upward walk the old search made from the shim's own
    // directory; `<home>/node_modules` is the one the defect names. Neither is inside this install.
    platformPackage(path.join(fixture.base, "node_modules", PACKAGE), VERSION, path.join(fixture.base, "ancestor-spawned.marker"))
    platformPackage(path.join(home, "node_modules", PACKAGE), VERSION, path.join(home, "home-spawned.marker"))
    const { rc, out } = await launch(fixture, { HOME: home })
    expect(rc).toBe(1)
    expect(existsSync(path.join(fixture.base, "ancestor-spawned.marker"))).toBe(false)
    expect(existsSync(path.join(home, "home-spawned.marker"))).toBe(false)
    expect(out).toContain("It seems that your package manager failed to install")
  })

  test("an in-tree entry that resolves into an ancestor node_modules is refused by the statement it failed", async () => {
    const fixture = wrapper("link-out")
    const planted = path.join(fixture.base, "node_modules", PACKAGE)
    platformPackage(planted, VERSION, path.join(fixture.base, "spawned.marker"))
    // The candidate is where a manager would put it; its realpath is not. A directory that exists
    // but sits outside the install's tree was not placed by this install.
    symlinkSync(planted, path.join(fixture.modules, PACKAGE))
    const { rc, out } = await launch(fixture)
    expect(rc).toBe(1)
    expect(existsSync(fixture.marker)).toBe(false)
    expect(out).toContain("is not inside this install")
  })

  test("an in-tree copy whose manifest is a different version than the wrapper seals is refused by name", async () => {
    const fixture = wrapper("oldbuild")
    // Its binary answers exactly the sealed version — the manifest is the claim, not the print.
    platformPackage(path.join(fixture.modules, PACKAGE), "0.7.0", fixture.marker)
    const { rc, out } = await launch(fixture)
    expect(rc).toBe(1)
    expect(existsSync(fixture.marker)).toBe(false)
    expect(out).toContain(`this wrapper seals ${VERSION}`)
  })

  test("a manifest that names some other package is refused by name", async () => {
    const fixture = wrapper("wrongname")
    platformPackage(path.join(fixture.modules, PACKAGE), VERSION, fixture.marker)
    writeFileSync(path.join(fixture.modules, PACKAGE, "package.json"), `${JSON.stringify({ name: "something-else", version: VERSION })}\n`)
    const { rc, out } = await launch(fixture)
    expect(rc).toBe(1)
    expect(existsSync(fixture.marker)).toBe(false)
    expect(out).toContain(`its package.json names "something-else", not ${PACKAGE}`)
  })

  test("an override that points at a group-writable file is refused and that file is never spawned", async () => {
    const fixture = wrapper("group-writable")
    const file = privateBinary(fixture.base, "planted", 0o775)
    const { rc, out } = await launch(fixture, { [PRODUCT_VAR]: file })
    expect(rc).toBe(1)
    expect(existsSync(path.join(fixture.base, "env-spawned.marker"))).toBe(false)
    expect(out).toContain("refuses the binary its environment names")
    expect(out).toContain("is writable by group or world (mode 775)")
    // The refusal is one line naming the statement that failed; nothing falls back to the search.
    expect(out).not.toContain("It seems that your package manager failed")
  })

  test("the legacy spelling goes through the identical screen and is refused for the same reason", async () => {
    const fixture = wrapper("legacy-group-writable")
    const file = privateBinary(fixture.base, "planted", 0o764)
    const { rc, out } = await launch(fixture, { [LEGACY_VAR]: file })
    expect(rc).toBe(1)
    expect(existsSync(path.join(fixture.base, "env-spawned.marker"))).toBe(false)
    expect(out).toContain("is writable by group or world")
  })

  test("an override that is a symbolic link is refused instead of followed, dangling or not", async () => {
    const fixture = wrapper("symlink-override")
    const real = privateBinary(fixture.base, "real", 0o755)
    const link = path.join(fixture.base, "private", "link")
    symlinkSync(real, link)
    const { rc, out } = await launch(fixture, { [PRODUCT_VAR]: link })
    expect(rc).toBe(1)
    expect(existsSync(path.join(fixture.base, "env-spawned.marker"))).toBe(false)
    expect(out).toContain("is a symbolic link to")

    const dangling = path.join(fixture.base, "private", "dangling")
    symlinkSync(path.join(fixture.base, "private", "nowhere"), dangling)
    const danglingRun = await launch(fixture, { [PRODUCT_VAR]: dangling })
    expect(danglingRun.rc).toBe(1)
    expect(danglingRun.out).toContain("is a symbolic link to")
    expect(existsSync(path.join(fixture.base, "env-spawned.marker"))).toBe(false)
  })

  test("an override that is not an absolute path is refused", async () => {
    const fixture = wrapper("relative-override")
    const { rc, out } = await launch(fixture, { [PRODUCT_VAR]: "bin/glasspane-harness" })
    expect(rc).toBe(1)
    expect(out).toContain("is not an absolute path")
    expect(existsSync(path.join(fixture.base, "env-spawned.marker"))).toBe(false)
  })

  // The uid statement needs a file this process cannot make: `chown` to another uid requires
  // privileges the test does not have. The guard is `lstat.uid !== process.geteuid()`, read on the
  // same leaf the other three are read on, and the two cases above prove that leaf is the one the
  // launcher acts on.
  test("a private absolute executable the environment names is honored, under both spellings", async () => {
    for (const key of [PRODUCT_VAR, LEGACY_VAR]) {
      const fixture = wrapper(`honored-${key.toLowerCase()}`)
      const file = privateBinary(fixture.base, "mine", 0o755)
      expect(lstatSync(file).isFile()).toBe(true)
      const { rc, out } = await launch(fixture, { [key]: file })
      expect(rc).toBe(0)
      expect(out.trim()).toBe(VERSION)
      expect(existsSync(path.join(fixture.base, "env-spawned.marker"))).toBe(true)
    }
  })
})
