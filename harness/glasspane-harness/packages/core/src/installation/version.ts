declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

// [gp] Product: pinned, not read from npm config. A project's own `.npmrc` or
// `npm_config_registry` would otherwise decide which bytes land in the user's tree and in
// their global prefix, and this product publishes to exactly one registry — the same reason
// `script/postinstall.mjs` passes `--registry` and `scripts/install.sh` refuses other origins.
export const NpmRegistry = "https://registry.npmjs.org"

// [gp] Product: the plugin API this product writes into a project is published by upstream
// under upstream's own release numbers, not ours: asking npm for
// `@opencode-ai/plugin@<product version>` asks for a version that does not exist (measured:
// 404 for 0.7.10, 200 for 1.18.32), the background install fails, and the user's plugin
// import stays unresolved. product-surface.mjs holds this equal to
// packages/plugin/package.json, which carries the pinned upstream release.
export const PluginPackageVersion = "1.18.32"
