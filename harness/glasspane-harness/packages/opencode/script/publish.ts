#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import product from "../../../product.json"
import { Script } from "@opencode-ai/script"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

// Stable releases go to `latest`; anything on a non-latest channel goes to `next`,
// so a preview can never be installed by `npm i -g glasspane-harness` by accident.
const distTag = Script.channel === "latest" ? "latest" : "next"

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (dryRun) {
    await $`bun pm pack --dry-run`.cwd(dir)
    const problems = await validateTarball(dir, name, version)
    if (problems.length) {
      console.error(`  ✗ ${name}@${version} would publish with problems:`)
      for (const p of problems) console.error(`      - ${p}`)
      process.exitCode = 1
    } else {
      console.log(`  ok ${name}@${version} packs cleanly (not published: --dry-run)`)
    }
    return
  }
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  const provenance = process.env.CI ? " --provenance" : ""
  await $`npm publish *.tgz --access public${provenance} --tag ${distTag}`.cwd(dir)
}

/**
 * What a published tarball must contain, checked before it can be published.
 * A package that installs but cannot run is the worst outcome of a release lane:
 * npm reports success, the user gets a broken command. The checks are the shape of
 * "what the installer needs", not taste.
 */
async function validateTarball(dir: string, name: string, version: string): Promise<string[]> {
  const problems: string[] = []
  const manifest = (await Bun.file(path.join(dir, "package.json")).json()) as Record<string, any>
  if (manifest.version !== version) problems.push(`package.json version ${manifest.version} != product version ${version}`)
  if (manifest.name !== name) problems.push(`package.json name ${manifest.name} != ${name}`)
  if (name === pkg.name) {
    // the wrapper
    for (const [bin, target] of Object.entries(manifest.bin ?? {})) {
      if (!existsSync(path.join(dir, target as string))) problems.push(`bin "${bin}" points at ${target}, which is not in the tarball`)
    }
    if (!existsSync(path.join(dir, "postinstall.mjs"))) problems.push("postinstall.mjs is missing — the platform binary would never be placed")
    if (!existsSync(path.join(dir, "LICENSE"))) problems.push("LICENSE is missing")
    const declared = Object.keys(manifest.optionalDependencies ?? {}).sort()
    if (declared.join(",") !== Object.keys(declaredPlatforms).sort().join(",")) {
      problems.push(`optionalDependencies [${declared.join(", ")}] do not match product.json's target matrix [${Object.keys(declaredPlatforms).join(", ")}]`)
    }
    for (const [field, expected] of [["os", product.platform?.os], ["cpu", product.platform?.arch]] as const) {
      if (JSON.stringify(manifest[field] ?? null) !== JSON.stringify(expected ?? null)) {
        problems.push(`${field} is ${JSON.stringify(manifest[field])} but product.platform says ${JSON.stringify(expected)} — npm would install the wrong platform or refuse the right one`)
      }
    }
  } else {
    // a platform package: the binary itself
    const binary = name.endsWith("-darwin-x64") ? "glasspane-harness" : "glasspane-harness"
    if (!existsSync(path.join(dir, "bin", binary))) problems.push(`bin/${binary} is missing from the tarball`)
    const stat = existsSync(path.join(dir, "bin", binary)) ? (await Bun.file(path.join(dir, "bin", binary)).stat?.()) : undefined
    if (stat && (stat.mode & 0o111) === 0) problems.push(`bin/${binary} is not executable in the tarball (mode ${(stat.mode & 0o777).toString(8)})`)
  }
  return problems
}

// [gp] Product: two modes. Default = the upstream flow (publish every platform
// package found in ./dist, then the wrapper). --wrapper-only = only the wrapper,
// with its optionalDependencies computed from product.json's target matrix —
// that is what the release pipeline needs, because CI builds each platform on its
// own runner and no single job holds all the dists.
const wrapperOnly = process.argv.includes("--wrapper-only")
// --dry-run packs and validates every tarball without publishing anything. The
// main repo's release discipline is "a dry branch is `npm pack --dry-run`, never
// `npm publish --dry-run`" (npm 11's publish --dry-run hits the registry); this is
// the same idea with the product's own validity checks on top, so a broken package
// shape is found on a PR instead of after a publish.
const dryRun = process.argv.includes("--dry-run")

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
console.log(wrapperOnly || dryRun ? "wrapper-only mode" : "binaries", binaries)
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
      // [gp] Product: the distribution is macOS-only (product.platform), and npm
      // enforces it from these fields — an install on Linux/Windows is refused by
      // the package manager with a clear reason, instead of downloading a binary
      // that cannot run there.
      os: product.platform?.os ?? ["darwin"],
      cpu: product.platform?.arch ?? ["arm64", "x64"],
      engines: { node: ">=18" },
      funding: "https://github.com/sponsors/jingzhao-l",
      publishConfig: { access: "public", tag: distTag },
      sideEffects: false,
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
  // In --dry-run this loop validates instead of publishing (publish() returns
  // before it touches the registry), so a PR can prove every tarball's shape.
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
