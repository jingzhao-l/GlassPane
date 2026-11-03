import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Fixed point: the cross-platform native artifacts a compile needs must come from the reviewed lock.
 *
 * `build.ts` used to run, after CI's `bun install --frozen-lockfile`, three more installs of the
 * shape `bun install --os="*" --cpu="*" <name>@<version>` for @opentui/core, @parcel/watcher and
 * @ff-labs/fff-bun. A package argument makes bun perform an *add*. Measured on this repo's bun
 * (1.3.14) in a fixture workspace shaped like this one (root `workspaces.catalog` + a package whose
 * dependency is written `"catalog:"`):
 *   · the add rewrote the manifest — `"@parcel/watcher": "catalog:"` came back as `"2.5.1"`, so the
 *     very file the frozen install was given its lock for is edited mid-build;
 *   · it re-resolves, so the integrity that lands in `node_modules` is the one for the bytes this
 *     run received, not the one `bun.lock` records.
 * The narrow need is only to *materialise* every platform variant, which `--os`/`--cpu` with no
 * package argument does from the lock. Comments are stripped before the scan because this file's own
 * explanation quotes the command it forbids — the same trap `harness/tools/product-surface.mjs`
 * documents for its `no-foreign-publish` readers.
 */
const ROOT = path.join(import.meta.dir, "../../../..")
const BUILD = path.join(ROOT, "packages/opencode/script/build.ts")
const LOCK = path.join(ROOT, "bun.lock")
const PKG = path.join(ROOT, "packages/opencode/package.json")
const PRODUCT = path.join(ROOT, "product.json")

function code(file: string) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
}

/** `bun.lock` is not strict JSON (trailing commas); one entry is one line, so read it as such. */
function lockEntry(lines: string[], name: string) {
  const prefix = `"${name}": [`
  const line = lines.find((entry) => entry.trim().startsWith(prefix))
  if (!line) return null
  const text = line.trim().slice(prefix.length - 1).replace(/,\s*([\]}])/g, "$1").replace(/,\s*$/, "")
  return JSON.parse(text) as [string, string, Record<string, any> | undefined, string | undefined]
}

const installs = code(BUILD).match(/bun install[^\n`]*/g) ?? []

describe("the build installs its cross-platform natives from the lock", () => {
  test("the scan reads a real command, so an empty result is not a pass", () => {
    expect(installs.length).toBeGreaterThanOrEqual(1)
  })

  test("every install the build runs is frozen against the lockfile", () => {
    const unfrozen = installs.filter((command) => !command.includes("--frozen-lockfile"))
    expect(unfrozen, `bun install without --frozen-lockfile: ${JSON.stringify(unfrozen)}`).toEqual([])
  })

  test("and none of them names a package, which would make it a re-resolving add", () => {
    const resolvers = installs.filter((command) => /(?:^|\s)(?:@[\w.-]+\/)?[\w.-]+@\S/.test(command.replace(/--[\w-]+(="\*")?/g, "")))
    expect(resolvers, `bun install with a package argument re-resolves and rewrites the manifest: ${JSON.stringify(resolvers)}`).toEqual([])
  })

  test("the frozen form is enough: every os/cpu-gated native dependency has a lock-recorded variant for every declared target", () => {
    const lines = readFileSync(LOCK, "utf8").split("\n")
    const dependencies = Object.keys(JSON.parse(readFileSync(PKG, "utf8")).dependencies ?? {})
    const targets = JSON.parse(readFileSync(PRODUCT, "utf8")).platformTargets as { os: string; arch: string; abi?: string }[]
    const natives: string[] = []
    for (const dep of dependencies) {
      const entry = lockEntry(lines, dep)
      if (!entry) continue
      const gated = Object.keys(entry[2]?.optionalDependencies ?? {}).filter((child) => {
        const c = lockEntry(lines, child)
        return c !== null && (c[2]?.os !== undefined || c[2]?.cpu !== undefined)
      })
      if (gated.length === 0) continue
      natives.push(dep)
      for (const target of targets) {
        const hit = gated.find((child) => {
          const c = lockEntry(lines, child)
          if (!c) return false
          const os = Array.isArray(c[2]?.os) ? c[2].os.includes(target.os) : c[2]?.os === target.os
          const cpu = Array.isArray(c[2]?.cpu) ? c[2].cpu.includes(target.arch) : c[2]?.cpu === target.arch
          return os && cpu && /^sha512-/.test(String(c[3] ?? ""))
        })
        expect(hit, `${dep} has no lock-recorded variant for ${target.os}/${target.arch}${target.abi ? `/${target.abi}` : ""} — a frozen install cannot materialise what the lock does not name`).toBeDefined()
      }
    }
    // The guard that keeps the loop above from passing on an empty set: these three are what the
    // compile embeds as native code, and discovery found exactly them in this tree.
    expect(natives.sort()).toEqual(["@ff-labs/fff-bun", "@opentui/core", "@parcel/watcher"])
  })
})
