import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Fixed point: the install hook may only load a copy that belongs to THIS install.
 *
 * `resolveBinary()` was `require.resolve(`${name}/package.json`)`. That walks every `node_modules`
 * above the wrapper — out of the project, through the home directory, to `/` — and consults
 * `NODE_PATH`, so a package planted in an ancestor directory satisfied it and the only thing said
 * about the bytes afterwards was `--version` string equality, which a three-line shell script
 * answers. The resolver now asks three questions the candidate cannot answer about itself: is the
 * directory inside this install's own tree, does its manifest name the version this wrapper seals,
 * and does the tree's install record (`node_modules/.package-lock.json`) name it.
 *
 * Fixture shapes are the layouts measured on this machine, not invented ones:
 *   · npm hoisting: `<project>/node_modules/glasspane-harness` with the platform package a sibling
 *     in the same `node_modules`, plus the `.package-lock.json` npm writes there. Its entry shape
 *     was read off a real `npm install @parcel/watcher@2.5.1` run:
 *     `{"node_modules/@parcel/watcher-darwin-arm64":{"version":"2.5.1","resolved":"https://registry.npmjs.org/@parcel/watcher-darwin-arm64/-/watcher-darwin-arm64-2.5.1.tgz","integrity":"sha512-eAzPv5os…","optional":true,"os":["darwin"],"cpu":["arm64"]}}`.
 *   · `npm install -g` and pnpm/bun trees keep no `.package-lock.json` (measured: a global prefix
 *     install of `is-odd@3.0.1` left `lib/node_modules/` holding only the package), so those load
 *     on the tree + version checks alone — that branch is the last case below.
 * Every "do not load this" case ends in the fetch branch, so the PATH holds a stub npm that refuses
 * every install and records what it was asked for; nothing here reaches a registry. The stub only
 * answers the argv shape the script actually builds (`install … --prefix <dir> <name>@<version>`);
 * any other call is a hard failure, so a stub can't vouch for a capability the script never asked
 * for.
 */
const SCRIPT = path.join(import.meta.dir, "../../script/postinstall.mjs")
const VERSION = "9.9.9"
const PLATFORM = process.platform === "win32" ? "windows" : process.platform
const PACKAGE = `glasspane-harness-${PLATFORM}-${process.arch}`
const BINARY = PLATFORM === "windows" ? "glasspane-harness.exe" : "glasspane-harness"
// What the hook writes into the wrapper, on every platform: `targetBinary` in postinstall.mjs is
// `bin/glasspane-harness.exe` even on macOS, because the wrapper's `bin` entries already name that
// file and the apology placeholder is overwritten in place. The existence assertions below have to
// read that name or they would pass on a path the script never writes.
const WRITTEN = "glasspane-harness.exe"
const REGISTRY = "https://registry.npmjs.org"

const scratch = mkdtempSync(path.join(tmpdir(), "gp-postinstall-anchor-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function shim(answer: string) {
  return `#!/bin/sh\nprintf '%s\\n' '${answer}'\n`
}

function platformPackage(dir: string, version: string, answer: string) {
  mkdirSync(path.join(dir, "bin"), { recursive: true })
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: PACKAGE, version, os: PLATFORM, cpu: process.arch }, null, 2)}\n`)
  writeFileSync(path.join(dir, "bin", BINARY), shim(answer))
  chmodSync(path.join(dir, "bin", BINARY), 0o755)
}

/** `<base>/proj/node_modules/glasspane-harness` — the hoisted npm layout, wrapper inside the tree. */
function wrapper(named: string) {
  const base = path.join(scratch, named)
  const modules = path.join(base, "proj", "node_modules")
  const root = path.join(modules, "glasspane-harness")
  mkdirSync(path.join(root, "bin"), { recursive: true })
  mkdirSync(base, { recursive: true })
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name: "glasspane-harness",
    version: VERSION,
    optionalDependencies: { [PACKAGE]: VERSION },
  }, null, 2)}\n`)
  cpScript(root)
  return { base, root, modules, target: path.join(root, "bin", WRITTEN) }
}

function cpScript(root: string) {
  writeFileSync(path.join(root, "postinstall.mjs"), readFileSync(SCRIPT, "utf8"))
}

/** The record npm writes for a project tree, with one entry per installed package. */
function npmRecord(modules: string, entries: Record<string, { version: string; resolved?: string; integrity?: string }>) {
  const packages: Record<string, unknown> = { "node_modules/glasspane-harness": { version: VERSION } }
  for (const [key, value] of Object.entries(entries)) {
    packages[`node_modules/${key}`] = {
      version: value.version,
      resolved: value.resolved ?? `${REGISTRY}/${key}/-/${key}-${value.version}.tgz`,
      integrity: value.integrity ?? "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
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
    [
      "#!/bin/sh",
      `log="${base}/npm-calls.log"`,
      "printf '%s\\n' \"$*\" >> \"$log\"",
      "# Only the fetch this script builds is answered, and it is answered with a refusal:",
      "# a stub that also replied to `npm view`, `npm publish` or a bare `npm install` would be",
      "# vouching for capabilities the hook never uses.",
      'case "$*" in',
      '  install*--prefix*"$PACKAGE"@*) exit 1 ;;',
      '  *) echo "stub npm: unexpected invocation: $*" >&2; exit 127 ;;',
      "esac",
      "",
    ].join("\n"),
  )
  chmodSync(path.join(bin, "npm"), 0o755)
  return bin
}

async function install(root: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, path.join(root, "postinstall.mjs")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [rc, stdout, stderr] = await Promise.all([
    child.exited,
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
  ])
  return { rc, out: `${stdout}${stderr}` }
}

describe("the install hook only loads a copy that belongs to this install", () => {
  test("a hoisted copy inside the tree, named by the tree's install record, installs", async () => {
    const { base, root, modules } = wrapper("hoisted")
    platformPackage(path.join(modules, PACKAGE), VERSION, VERSION)
    npmRecord(modules, { [PACKAGE]: { version: VERSION } })
    const bin = stubNpm(base)
    const { rc, out } = await install(root, { PATH: `${bin}:${process.env.PATH}` })
    expect(rc).toBe(0)
    expect(out).toBe("")
    expect(existsSync(path.join(base, "npm-calls.log"))).toBe(false)
    expect(readFileSync(path.join(root, "bin", WRITTEN), "utf8")).toContain(VERSION)
  })

  test("a package planted in an ancestor node_modules is not loaded, even when it answers the right version", async () => {
    const { base, root, modules } = wrapper("ancestor")
    // A true ancestor of the wrapper's own path — `<base>/node_modules` is on the upward walk
    // `require.resolve` used to make, and `<base>/proj/node_modules` (this install's tree) is not.
    const ancestor = path.join(base, "node_modules")
    platformPackage(path.join(ancestor, PACKAGE), VERSION, VERSION)
    npmRecord(modules, {})
    const bin = stubNpm(base)
    const { rc, out } = await install(root, { PATH: `${bin}:${process.env.PATH}` })
    expect(rc).toBe(1)
    expect(existsSync(path.join(root, "bin", WRITTEN))).toBe(false)
    expect(out).toContain("It seems your package manager failed to install")
    expect(readFileSync(path.join(base, "npm-calls.log"), "utf8")).toContain(`--prefix`)
  })

  test("a package reached through NODE_PATH is not loaded either", async () => {
    const { base, root, modules } = wrapper("nodepath")
    const detour = path.join(scratch, "nodepath-detour")
    platformPackage(path.join(detour, PACKAGE), VERSION, VERSION)
    npmRecord(modules, {})
    const bin = stubNpm(base)
    const { rc } = await install(root, { PATH: `${bin}:${process.env.PATH}`, NODE_PATH: detour })
    expect(rc).toBe(1)
    expect(existsSync(path.join(root, "bin", WRITTEN))).toBe(false)
  })

  test("an in-tree copy whose manifest names a different version than this wrapper seals is refused, although its binary answers the sealed one", async () => {
    const { base, root, modules } = wrapper("oldbuild")
    platformPackage(path.join(modules, PACKAGE), "0.7.0", VERSION)
    npmRecord(modules, { [PACKAGE]: { version: "0.7.0" } })
    const bin = stubNpm(base)
    const { rc, out } = await install(root, { PATH: `${bin}:${process.env.PATH}` })
    expect(rc).toBe(1)
    expect(existsSync(path.join(root, "bin", WRITTEN))).toBe(false)
    expect(out).toContain(`this wrapper seals ${VERSION}`)
  })

  test("an in-tree directory the install record does not mention was not installed here", async () => {
    const { base, root, modules } = wrapper("unrecorded")
    platformPackage(path.join(modules, PACKAGE), VERSION, VERSION)
    npmRecord(modules, {})
    const bin = stubNpm(base)
    const { rc, out } = await install(root, { PATH: `${bin}:${process.env.PATH}` })
    expect(rc).toBe(1)
    expect(existsSync(path.join(root, "bin", WRITTEN))).toBe(false)
    expect(out).toContain(`is not recorded in`)
  })

  test("an install record whose tarball URL is not this package at this version is refused", async () => {
    const { base, root, modules } = wrapper("mirror")
    platformPackage(path.join(modules, PACKAGE), VERSION, VERSION)
    npmRecord(modules, { [PACKAGE]: { version: VERSION, resolved: "https://mirror.example.com/glasspane-harness-other-1.0.0.tgz" } })
    const bin = stubNpm(base)
    const { rc, out } = await install(root, { PATH: `${bin}:${process.env.PATH}` })
    expect(rc).toBe(1)
    expect(existsSync(path.join(root, "bin", WRITTEN))).toBe(false)
    expect(out).toContain(`not the ${PACKAGE}@${VERSION} tarball`)
  })

  test("a symlink that leaves the install tree is refused", async () => {
    const { base, root, modules } = wrapper("symlink")
    const outside = path.join(scratch, "symlink-outside")
    platformPackage(path.join(outside, PACKAGE), VERSION, VERSION)
    symlinkSync(path.join(outside, PACKAGE), path.join(modules, PACKAGE))
    npmRecord(modules, { [PACKAGE]: { version: VERSION } })
    const bin = stubNpm(base)
    const { rc, out } = await install(root, { PATH: `${bin}:${process.env.PATH}` })
    expect(rc).toBe(1)
    expect(existsSync(path.join(root, "bin", WRITTEN))).toBe(false)
    expect(out).toContain("is not inside this install")
  })

  test("a tree with no install record at all still loads on the tree and version checks", async () => {
    // The `npm install -g` / pnpm / bun shape, measured: no `.package-lock.json` anywhere in the
    // tree. Refusing these would break the managers this product tells people to install with.
    const { base, root, modules } = wrapper("norecord")
    platformPackage(path.join(modules, PACKAGE), VERSION, VERSION)
    const bin = stubNpm(base)
    const { rc } = await install(root, { PATH: `${bin}:${process.env.PATH}` })
    expect(rc).toBe(0)
    expect(statSync(path.join(root, "bin", WRITTEN)).mode & 0o777).toBe(0o755)
  })
})
