import { describe, expect, test } from "bun:test"

import { ConfigPlugin } from "@/config/plugin"

/**
 * Opening a repository must not run tool code from it, either.
 *
 * This is the tool twin of `glasspane-project-plugin-trust.test.ts`, which proves the same gate
 * end-to-end for plugins against a real temp checkout. Auto-discovered project tools
 * (`{tool,tools}/*.{js,ts}`) go through the same dynamic `import()` as auto-discovered plugins, so
 * a drive-by clone used to get code execution through the tool directory even after the plugin
 * directory was gated. The gate is `ConfigPlugin.projectToolPlan`, and the halves below are the
 * ways it could be wrong — refusing nothing because discovery never matched, and refusing on an
 * empty project so the warning cannot fire.
 */
describe("project tools are discovered, then refused by default", () => {
  test("a discovered tool file is not loaded unless the operator trusted the checkout", () => {
    const discovered = [
      { file: "/repo/.glasspane-harness/tool/reads-the-environment.ts" },
      { file: "/repo/.glasspane-harness/tools/nested.js" },
    ]

    const denied = ConfigPlugin.projectToolPlan(discovered, false)
    expect(denied.load).toEqual([])
    expect(denied.refused).toEqual(discovered)

    const trusted = ConfigPlugin.projectToolPlan(discovered, true)
    expect(trusted.refused).toEqual([])
    expect(trusted.load).toEqual(discovered)
  })

  test("nothing is refused when nothing was discovered, so the warning cannot fire on an empty project", () => {
    expect(ConfigPlugin.projectToolPlan([], false)).toEqual({ load: [], refused: [] })
  })

  test("the tool gate and the plugin gate share one trust decision, not two flags", () => {
    // Both plans read the same Flag.GLASSPANE_HARNESS_TRUST_PROJECT_PLUGINS at the call sites;
    // this pins that a trusted checkout loads both lanes and an untrusted one refuses both.
    const spec = [{ file: "/repo/.glasspane-harness/tool/x.ts" }]
    const pluginSpec = ["file:///repo/.glasspane-harness/plugin/x.ts"] as never
    expect(ConfigPlugin.projectToolPlan(spec, true).load).toEqual(spec)
    expect(ConfigPlugin.projectToolPlan(spec, false).refused).toEqual(spec)
    expect(ConfigPlugin.projectPluginPlan(pluginSpec, true).load).toEqual(pluginSpec)
    expect(ConfigPlugin.projectPluginPlan(pluginSpec, false).refused).toEqual(pluginSpec)
  })
})
