import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { pluginDependency } from "@/config/config"
import { InstallationVersion, PluginPackageVersion } from "@opencode-ai/core/installation/version"

// Upstream publishes the plugin API under upstream's release numbers, so the version this
// product writes into a user's project has to come from the pinned upstream tree — not from
// this product's own version line. Measured 2026-10-16: npm answers 404 for
// `@opencode-ai/plugin@0.7.10` and serves 1.18.32, and because the install runs forked in
// the background the failure was only a warning, so every project opened by a shipped build
// silently never received the API its plugin files import.
const declared = () =>
  JSON.parse(readFileSync(path.join(import.meta.dir, "..", "..", "..", "plugin", "package.json"), "utf8")).version

test("a shipped build asks for the plugin API version the fork actually carries", () => {
  const add = pluginDependency(false)
  expect(add.name).toBe("@opencode-ai/plugin")
  expect(add.version).toBe(declared())
  expect(PluginPackageVersion).toBe(declared())
})

test("asking for this product's own release number is not what the shipped path does", () => {
  expect(pluginDependency(false).version).not.toBe(InstallationVersion)
})

test("running from source leaves the plugin API to the workspace", () => {
  expect(pluginDependency(true).version).toBeUndefined()
})
