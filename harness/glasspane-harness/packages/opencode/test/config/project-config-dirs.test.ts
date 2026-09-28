import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

import { ConfigPaths } from "@/config/paths"
import { testEffect } from "../lib/effect"

/**
 * The project-config directory rename, pinned where it can bite.
 *
 * The product's project directory is `.glasspane-harness`; the upstream
 * `.opencode` is still read. The load **order** is the part that cannot be left
 * to taste: the config loader merges directories in list order and
 * `mergeDeep(target, source)` lets the *later* source win (measured with
 * remeda, not inferred), so listing the product dir second at the same level is
 * exactly what makes it win when a checkout has both. Reverse the two and a
 * legacy directory silently overrides the product's own configuration — the kind
 * of failure no compiler and no other test can see, which is why it gets a test.
 *
 * The two parallel stacks (v2 `core/config.ts` and the TUI config scan) filter
 * directories by name inside service layers that need the whole config graph;
 * those two filters are pinned structurally below, with the boundary stated.
 */
const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node])))

const tree = (dirs: string[]) => {
  const root = mkdtempSync(path.join(tmpdir(), "gp-config-dirs-"))
  for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true })
  return root
}

describe("project config directories", () => {
  it.effect("finds a legacy .opencode directory", () => {
    const root = tree([".opencode"])
    return Effect.map(ConfigPaths.directories(root, root), (dirs) =>
      expect(dirs.map((dir) => path.basename(dir))).toContain(".opencode"),
    )
  })

  it.effect("finds the product's .glasspane-harness directory", () => {
    const root = tree([".glasspane-harness"])
    return Effect.map(ConfigPaths.directories(root, root), (dirs) =>
      expect(dirs.map((dir) => path.basename(dir))).toContain(".glasspane-harness"),
    )
  })

  it.effect("when both exist at one level the product directory loads last, so it wins the merge", () => {
    const root = tree([".opencode", ".glasspane-harness"])
    return Effect.map(ConfigPaths.directories(root, root), (dirs) => {
      const names = dirs.map((dir) => path.basename(dir))
      const legacy = names.indexOf(".opencode")
      const product = names.indexOf(".glasspane-harness")
      expect(legacy).toBeGreaterThanOrEqual(0)
      expect(product).toBeGreaterThanOrEqual(0)
      expect(product).toBeGreaterThan(legacy) // later merge wins (measured mergeDeep)
    })
  })
})

describe("the name filters in the parallel config stacks", () => {
  const source = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", "..", rel), "utf8")

  test("v1's per-directory loop accepts the product directory name", () => {
    expect(source("src/config/config.ts")).toMatch(/dir\.endsWith\("\.glasspane-harness"\)/)
  })

  test("v2's discovery probes the product directory and its basename filter accepts it", () => {
    const core = source("../core/src/config.ts")
    expect(core).toContain('".glasspane-harness"')
    expect(core).toMatch(/path\.basename\(item\) === "\.glasspane-harness"/)
  })

  test("the TUI config scan accepts the product directory name", () => {
    expect(source("src/config/tui.ts")).toMatch(/dir\.endsWith\("\.glasspane-harness"\)/)
  })
})
