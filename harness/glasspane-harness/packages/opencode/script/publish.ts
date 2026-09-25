#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import product from "../../../product.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  const provenance = process.env.CI ? " --provenance" : ""
  await $`npm publish *.tgz --access public${provenance} --tag ${Script.channel}`.cwd(dir)
}

// [gp] Product: two modes. Default = the upstream flow (publish every platform
// package found in ./dist, then the wrapper). --wrapper-only = only the wrapper,
// with its optionalDependencies computed from product.json's target matrix —
// that is what the release pipeline needs, because CI builds each platform on its
// own runner and no single job holds all the dists.
const wrapperOnly = process.argv.includes("--wrapper-only")

/** Same naming rule as script/build.ts: name-os-arch[-baseline][-abi]. */
function platformPackageName(target: { os: string; arch: string; avx2?: boolean; abi?: string }) {
  return [
    pkg.name,
    target.os === "win32" ? "windows" : target.os,
    target.arch,
    target.avx2 === false ? "baseline" : undefined,
    target.abi ?? undefined,
  ]
    .filter(Boolean)
    .join("-")
}

const version = product.version ?? Script.version
const declaredPlatforms: Record<string, string> = Object.fromEntries(
  (product.platformTargets ?? []).map((target) => [platformPackageName(target), version]),
)

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const found = await Bun.file(`./dist/${filepath}`).json()
  binaries[found.name] = found.version
}
console.log(wrapperOnly ? "wrapper-only mode" : "binaries", binaries)
const missing = Object.keys(declaredPlatforms).filter((name) => !wrapperOnly && !binaries[name])
if (missing.length) console.log(`note: ${missing.length} declared target(s) are not built in this run: ${missing.join(", ")}`)

await $`mkdir -p ./dist/${pkg.name}`
await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${pkg.name}/bin/${pkg.name}.exe`).write(
  [
    `echo "Error: ${pkg.name}'s postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${pkg.name} && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${pkg.name} without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      description: pkg.description,
      keywords: pkg.keywords,
      repository: pkg.repository,
      homepage: pkg.homepage,
      bugs: pkg.bugs,
      bin: {
        [product.bins[0]]: `./bin/${pkg.name}.exe`,
        [product.bins[1] ?? product.bins[0]]: `./bin/${pkg.name}.exe`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      // [gp] Product: the wrapper must resolve a binary on *every* platform, so
      // its optionalDependencies come from the declared target matrix, not from
      // whichever dists happen to exist on this machine.
      optionalDependencies: declaredPlatforms,
    },
    null,
    2,
  ),
)

if (!wrapperOnly) {
  const tasks = Object.entries(binaries).map(async ([name]) => {
    await publish(`./dist/${name}`, name, binaries[name])
  })
  await Promise.all(tasks)
}
// [gp] Product: the wrapper publishes under the product name itself
// (product.json → name). Upstream appended "-ai" (opencode → opencode-ai).
await publish(`./dist/${pkg.name}`, pkg.name, version)

// [gp] Product: upstream's tail published to **upstream's** registries from here —
// docker (ghcr.io/anomalyco/opencode), the AUR `opencode-bin` package, and the
// anomalyco/homebrew-tap. A fork that ran this would push to someone else's
// infrastructure, so the whole block is gone. Our distribution is:
//   - npm: the platform packages + this wrapper (the loop above), and
//   - GitHub release assets: produced by script/build.ts when Script.release is set
//     (tar.gz/zip per platform) and attached by .github/workflows/release.yml.
// Nothing else is published from this script.
