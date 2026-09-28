import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
// [gp] Product: the product line lives in product.json (machine-readable truth,
// shipped with the subtree). packages/opencode/package.json is kept in step by
// harness/tools/product-surface.mjs; the dev fallback below is only for the
// unlikely case that a checkout has the package but not the manifest.
const productPath = path.resolve(import.meta.dir, "../../../product.json")
const product = (await Bun.file(productPath)
  .json()
  .catch(() => null)) as { name?: string; version?: string } | null
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  OPENCODE_CHANNEL: process.env["OPENCODE_CHANNEL"],
  OPENCODE_BUMP: process.env["OPENCODE_BUMP"],
  OPENCODE_VERSION: process.env["OPENCODE_VERSION"],
  OPENCODE_RELEASE: process.env["OPENCODE_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.OPENCODE_CHANNEL) return env.OPENCODE_CHANNEL
  if (env.OPENCODE_BUMP) return "latest"
  if (env.OPENCODE_VERSION && !env.OPENCODE_VERSION.startsWith("0.0.0-")) return "latest"
  if (product?.version && !product.version.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.OPENCODE_VERSION) return env.OPENCODE_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  // [gp] Product: the version is exactly what product.json says. Upstream's
  // default here was a *patch bump* (its release script installed the published
  // package and computed the next number), so an ordinary local build of the
  // fork printed `0.1.1` — a version that was never built or published. Our
  // release lane passes OPENCODE_VERSION explicitly (from product.json), so the
  // bump has no caller left; the honest default is the manifest's own number.
  return product?.version ?? rootPkg.version ?? "0.1.0"
})()

// [gp] Product: the upstream TEAM_MEMBERS file is not shipped (private product),
// so the team list is the bots only; if a file exists it is still honoured.
const bot = ["actions-user", "glasspane-harness"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))
    .catch(() => [] as string[])),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.OPENCODE_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`${product?.name ?? "glasspane-harness"} script`, JSON.stringify(Script, null, 2))
