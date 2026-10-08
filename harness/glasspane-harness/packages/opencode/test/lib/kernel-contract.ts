import path from "node:path"
import { existsSync, readFileSync } from "node:fs"

/**
 * Shared resolution for the tests that touch the shared kernel.
 *
 * Three test files need the same two things — the installed `iterate-kernel` and the
 * provenance manifest that pins it — and each of them used to hard-code a path into the
 * vendored source tree that no longer exists. A relative `../../..` chain is also exactly
 * what silently disabled the provenance check before: it resolved five levels up, hit
 * `harness/contracts/`, found nothing, and warned instead of failing. Walking up until a
 * file appears is the shape that cannot quietly become a no-op: if nothing is found, the
 * caller is told what was searched for.
 */

function walkUp(from: string, depth: number): string[] {
  const dirs: string[] = []
  let dir = from
  for (let i = 0; i < depth; i++) {
    dirs.push(dir)
    dir = path.dirname(dir)
  }
  return dirs
}

/** The installed `iterate-kernel` directory. bun hoists, so it may sit at either level. */
export function kernelPackageDir(testDir: string): string {
  for (const dir of walkUp(testDir, 6)) {
    const candidate = path.join(dir, "node_modules", "iterate-kernel")
    if (existsSync(path.join(candidate, "package.json"))) return candidate
  }
  throw new Error(
    `iterate-kernel is not installed above ${testDir} — run \`bun install\` in the fork root`,
  )
}

/** The contract corpus shipped inside the package: fixtures are the cross-language anchor. */
export function kernelFixturesDir(testDir: string): string {
  return path.join(kernelPackageDir(testDir), "fixtures")
}

/** One fixture, parsed. `name` is the stem, e.g. `evidence-pack.ok-01`. */
export function kernelFixture<T = unknown>(testDir: string, name: string): T {
  return JSON.parse(readFileSync(path.join(kernelFixturesDir(testDir), `${name}.json`), "utf8")) as T
}

/**
 * A provenance/contract manifest from the product tree's `contracts/`, or the monorepo's
 * `harness/contracts/` if the tree moved. Returns null only when neither carries it, and
 * the caller must say what that means rather than passing.
 */
export function kernelContractFile(testDir: string, fileName: string): string | null {
  for (const dir of walkUp(testDir, 6)) {
    const candidate = path.join(dir, "contracts", fileName)
    if (existsSync(candidate)) return candidate
  }
  return null
}
