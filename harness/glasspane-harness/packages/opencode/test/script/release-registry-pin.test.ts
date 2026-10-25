import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Every npm command in the release pipeline that MOVES bytes has to name the registry.
 *
 * Why this is pinned against the workflow text rather than run: the publish step is the one thing
 * this repository cannot execute in a test (it is irreversible), so what IS checkable is that no
 * `npm publish` / `npm stage publish` was added on the strength of whatever `npm_config_registry`,
 * `NPM_CONFIG_REGISTRY`, `~/.npmrc` or a project `.npmrc` happens to say. The reads in the same file
 * already pin it; the writes were the gap, and a mirror only has to be ambient for the bytes to land
 * somewhere that is not this product's registry.
 *
 * The positive count is the half that keeps the rule honest: a scan whose pattern matches nothing
 * would report a clean pipeline forever.
 */
const WORKFLOW = path.join(import.meta.dir, "../../../../.github/workflows/release.yml")
const lines = readFileSync(WORKFLOW, "utf8").split("\n").filter((line) => !line.trim().startsWith("#"))

const publishers = lines.filter((line) => /\bnpm +(publish|stage publish)\b/.test(line))

describe("the release pipeline pins the registry it publishes to", () => {
  test("the commands exist, so this scan is measuring something", () => {
    expect(publishers.length).toBeGreaterThanOrEqual(4)
  })

  test("each publish command names the registry", () => {
    const unpinned = publishers.filter((line) => !/--registry\b/.test(line))
    expect(unpinned, `publish commands with no --registry: ${JSON.stringify(unpinned)}`).toEqual([])
  })

  test("and the registry comes from product.json, not a literal written into the lane", () => {
    const reads = lines.filter((line) => /\.registry"?\)?"?/.test(line) && /product\.json/.test(line))
    expect(reads.length).toBeGreaterThanOrEqual(3)
    expect(lines.join("\n")).not.toMatch(/npm (publish|stage publish)[^\n]*--registry https:\/\/registry\.npmjs\.org/)
  })
})
