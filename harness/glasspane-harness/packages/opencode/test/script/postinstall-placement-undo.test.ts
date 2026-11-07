import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Fixed point: what the install hook leaves on the user's PATH is what it checked, and only what
 * this run wrote.
 *
 * Two hazards were measured on 2026-11-06 in `copyBinary()` and its caller.
 *
 * The leaf: `fs.existsSync(target)` answers FALSE for a dangling symlink, so the stale link
 * survived the `existsSync → unlinkSync` guard, `linkSync` threw EEXIST, the catch's
 * `copyFileSync` wrote THROUGH the link, and `chmodSync` chmodded whatever it points at. The parent
 * project had already fixed this class in its own installer (`installer/cli.js`,
 * "chmod 不许穿过叶子链接"); this is the same channel on the npm lane.
 *
 * The undo: `main()` placed the bytes and then ran `verifyBinary()`, and when the check failed it
 * moved on to the next name with the unverified bytes STILL sitting at `targetBinary` — so the
 * command the user ran after a failed install was exactly the build the installer had declared
 * wrong. A placement now carries the undo for itself, and only a file this run created is removed:
 * a regular file that was here before is renamed back, byte for byte and inode for inode.
 *
 * Same fixtures as `postinstall-resolution-anchored.test.ts`: a real wrapper layout under a temp
 * root, a stub npm that refuses every fetch (nothing here reaches a registry), and the hook driven
 * as a subprocess so the assertions are about the bytes left on disk.
 */
const SCRIPT = path.join(import.meta.dir, "../../script/postinstall.mjs")
const VERSION = "9.9.9"
const PLATFORM = process.platform === "win32" ? "windows" : process.platform
const PACKAGE = `glasspane-harness-${PLATFORM}-${process.arch}`
const BINARY = PLATFORM === "windows" ? "glasspane-harness.exe" : "glasspane-harness"
// `targetBinary` is `bin/glasspane-harness.exe` on every platform: the wrapper's `bin` entries name
// that file, and the apology placeholder is overwritten in place.
const WRITTEN = "glasspane-harness.exe"
const BACKUP = `${WRITTEN}.previous-install`
const REGISTRY = "https://registry.npmjs.org"

const scratch = mkdtempSync(path.join(tmpdir(), "gp-postinstall-place-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function shim(answer: string) {
  return `#!/bin/sh\nprintf '%s\\n' '${answer}'\n`
}

/** `<base>/proj/node_modules/glasspane-harness`, hoisted npm layout, with a copy of the hook in it. */
function wrapper(named: string) {
  const base = path.join(scratch, named)
  const modules = path.join(base, "proj", "node_modules")
  const root = path.join(modules, "glasspane-harness")
  mkdirSync(path.join(root, "bin"), { recursive: true })
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "glasspane-harness", version: VERSION, optionalDependencies: { [PACKAGE]: VERSION } }, null, 2)}\n`,
  )
  writeFileSync(path.join(root, "postinstall.mjs"), readFileSync(SCRIPT, "utf8"))
  return { base, root, modules, target: path.join(root, "bin", WRITTEN), backup: path.join(root, "bin", BACKUP) }
}

function platformPackage(dir: string, version: string, answer: string) {
  mkdirSync(path.join(dir, "bin"), { recursive: true })
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: PACKAGE, version, os: PLATFORM, cpu: process.arch }, null, 2)}\n`)
  writeFileSync(path.join(dir, "bin", BINARY), shim(answer))
  chmodSync(path.join(dir, "bin", BINARY), 0o755)
}

/** The record npm writes for a project tree, with one entry per installed package. */
function npmRecord(modules: string, entries: Record<string, { version: string }>) {
  const packages: Record<string, unknown> = { "node_modules/glasspane-harness": { version: VERSION } }
  for (const [key, value] of Object.entries(entries)) {
    packages[`node_modules/${key}`] = {
      version: value.version,
      resolved: `${REGISTRY}/${key}/-/${key}-${value.version}.tgz`,
      integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      optional: true,
      os: [PLATFORM],
      cpu: [process.arch],
    }
  }
  writeFileSync(path.join(modules, ".package-lock.json"), `${JSON.stringify({ name: "proj", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`)
}

function stubNpm(base: string) {
  const bin = path.join(base, "stubbin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    path.join(bin, "npm"),
    ["#!/bin/sh", `log="${base}/npm-calls.log"`, 'printf \'%s\\n\' "$*" >> "$log"', 'exit 1', ""].join("\n"),
  )
  chmodSync(path.join(bin, "npm"), 0o755)
  return bin
}

/** The bytes the published wrapper ships in `bin/` before a successful install replaces them. */
function placeholder(target: string) {
  writeFileSync(target, "#!/bin/sh\n# the apology placeholder this install did not create\nexit 1\n")
  chmodSync(target, 0o755)
}

async function install(fixture: { root: string; base: string }, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, path.join(fixture.root, "postinstall.mjs")], {
    cwd: fixture.root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${stubNpm(fixture.base)}:${process.env.PATH}`, ...env },
  })
  const [rc, stdout, stderr] = await Promise.all([child.exited, Bun.readableStreamToText(child.stdout), Bun.readableStreamToText(child.stderr)])
  return { rc, out: `${stdout}${stderr}` }
}

describe("the install hook writes only through a leaf it can name", () => {
  test("a dangling symlink at the target is refused, and nothing is created at where it points", async () => {
    const fixture = wrapper("dangling")
    platformPackage(path.join(fixture.modules, PACKAGE), VERSION, VERSION)
    npmRecord(fixture.modules, { [PACKAGE]: { version: VERSION } })
    const victim = path.join(fixture.base, "outside", WRITTEN)
    mkdirSync(path.dirname(victim), { recursive: true })
    symlinkSync(victim, fixture.target)
    const { rc, out } = await install(fixture)
    expect(rc).toBe(1)
    expect(out).toContain("is a symbolic link to")
    expect(out).toContain("refusing to write or chmod through it")
    // The link is still the link, still dangling, and the file the old code wrote through it was
    // never created.
    expect(lstatSync(fixture.target).isSymbolicLink()).toBe(true)
    expect(existsSync(victim)).toBe(false)
    expect(existsSync(fixture.backup)).toBe(false)
  })

  test("a symlink to a real file is refused, and the file at its other end keeps its bytes and its mode", async () => {
    const fixture = wrapper("link-to-real")
    platformPackage(path.join(fixture.modules, PACKAGE), VERSION, VERSION)
    npmRecord(fixture.modules, { [PACKAGE]: { version: VERSION } })
    const victim = path.join(fixture.base, "outside", "someone-elses-file")
    mkdirSync(path.dirname(victim), { recursive: true })
    writeFileSync(victim, "the bytes this install may not overwrite\n")
    chmodSync(victim, 0o600)
    const before = statSync(victim)
    symlinkSync(victim, fixture.target)
    const { rc, out } = await install(fixture)
    expect(rc).toBe(1)
    expect(out).toContain("is a symbolic link to")
    const after = statSync(victim)
    expect(after.ino).toBe(before.ino)
    expect(after.mode & 0o777).toBe(0o600)
    expect(readFileSync(victim, "utf8")).toBe("the bytes this install may not overwrite\n")
    expect(lstatSync(fixture.target).isSymbolicLink()).toBe(true)
  })
})

describe("a refused install leaves nothing executable where the command lives", () => {
  test("the binary this run placed is gone when the version check fails, backup included", async () => {
    const fixture = wrapper("undo-fresh")
    platformPackage(path.join(fixture.modules, PACKAGE), VERSION, "0.0.0-dev")
    npmRecord(fixture.modules, { [PACKAGE]: { version: VERSION } })
    const { rc, out } = await install(fixture)
    expect(rc).toBe(1)
    expect(out).toContain(`--version answers "0.0.0-dev"`)
    expect(existsSync(fixture.target)).toBe(false)
    expect(existsSync(fixture.backup)).toBe(false)
  })

  test("the regular file that was there before is put back rather than deleted", async () => {
    const fixture = wrapper("undo-preexisting")
    platformPackage(path.join(fixture.modules, PACKAGE), VERSION, "0.0.0-dev")
    npmRecord(fixture.modules, { [PACKAGE]: { version: VERSION } })
    placeholder(fixture.target)
    const before = statSync(fixture.target)
    const { rc, out } = await install(fixture)
    expect(rc).toBe(1)
    expect(out).toContain(`--version answers "0.0.0-dev"`)
    // Not the refused bytes, and not merely a file with the same text: the same inode, untouched.
    expect(readFileSync(fixture.target, "utf8")).toContain("this install did not create")
    const after = statSync(fixture.target)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(existsSync(fixture.backup)).toBe(false)
  })

  test("a run that never placed anything touches nothing it did not create", async () => {
    const fixture = wrapper("never-placed")
    // Nothing in the install tree, so the hook falls to the fetch and the stub npm refuses it.
    npmRecord(fixture.modules, {})
    placeholder(fixture.target)
    const before = statSync(fixture.target)
    const { rc } = await install(fixture)
    expect(rc).toBe(1)
    const after = statSync(fixture.target)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  test("and a verified install keeps the new bytes with no backup left behind", async () => {
    const fixture = wrapper("commit")
    platformPackage(path.join(fixture.modules, PACKAGE), VERSION, VERSION)
    npmRecord(fixture.modules, { [PACKAGE]: { version: VERSION } })
    placeholder(fixture.target)
    const { rc, out } = await install(fixture)
    expect(rc).toBe(0)
    expect(out).toBe("")
    expect(readFileSync(fixture.target, "utf8")).toContain(VERSION)
    expect(statSync(fixture.target).mode & 0o777).toBe(0o755)
    expect(existsSync(fixture.backup)).toBe(false)
  })
})
