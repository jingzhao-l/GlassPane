import { describe, expect, test } from "bun:test"
import path from "path"

import { ConfigPlugin } from "@/config/plugin"
import { tmpdir } from "../fixture/fixture"

/**
 * Opening a repository must not run code from it.
 *
 * This product's agent can move real macOS apps through the `gp_*` accessibility surface, so a
 * plugin discovered by globbing the checkout under review is not a feature: it is code execution
 * with the engine's permissions attached, granted by nothing anybody agreed to. The gate is
 * `ConfigPlugin.projectPluginPlan`, and the two halves below are the two ways it could be wrong —
 * refusing nothing because discovery never matched (a fixture that cannot find the file is a green
 * test proving nothing), and refusing declared plugins nobody asked it to refuse.
 */
describe("project plugins are discovered, then refused by default", () => {
  test("a plugin file sitting in the project's config directory is found and not loaded", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const config = path.join(dir, ".glasspane-harness")
        await Bun.write(path.join(config, "plugin", "reads-the-environment.ts"), "export default async () => ({ name: \"probe\" })\n")
        await Bun.write(path.join(config, "plugins", "nested.js"), "export default async () => ({ name: \"nested\" })\n")
      },
    })
    const configDir = path.join(tmp.path, ".glasspane-harness")
    const discovered = await ConfigPlugin.load(configDir)
    expect(discovered.length, "auto-discovery did not find the files this gate exists for").toBe(2)

    const denied = ConfigPlugin.projectPluginPlan(discovered, false)
    expect(denied.load).toEqual([])
    expect(denied.refused.length).toBe(2)

    const trusted = ConfigPlugin.projectPluginPlan(discovered, true)
    expect(trusted.refused).toEqual([])
    expect(trusted.load.length).toBe(2)
  })

  test("nothing is refused when nothing was discovered, so the warning cannot fire on an empty project", () => {
    expect(ConfigPlugin.projectPluginPlan([], false)).toEqual({ load: [], refused: [] })
  })

  test("a trusted run loads exactly what was discovered, in order", () => {
    const specs = ["file:///a.ts", ["file:///b.ts", { foo: "bar" }]] as never
    const trusted = ConfigPlugin.projectPluginPlan(specs, true)
    expect(trusted.load).toEqual(specs)
    expect(trusted.refused).toEqual([])
  })
})
