#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import product from "../../../product.json"
import { Script } from "@opencode-ai/script"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

/**
 * One publish at a time, enforced rather than remembered.
 *
 * WHY THIS EXISTS: on 2026-09-26 two of these were launched by mistake. Both packed
 * the same version, both published the wrapper, and npm — seeing a duplicate — staged
 * the loser instead of failing it. The result was a staged version that `npm stage
 * list` does not show and that then refuses every future publish of that number: the
 * version was burned and the release had to move to the next one. A `mkdir` is an
 * atomic exclusive create on every filesystem we support, so it is a lock that needs no
 * dependency and no cleanup if the process dies (the stale case is reported, not
 * silently broken).
 */
// `dist/` is build output and does not exist in a clean checkout — the first CI run
// of this lane died here with exit 2, which is the lock's own code. The parent is
// created first for exactly that reason.
const lockDir = path.join(dir, "dist", ".publish.lock")
try {
  mkdirSync(path.dirname(lockDir), { recursive: true })
  mkdirSync(lockDir)
} catch {
  console.error(`another publish is running, or one died holding ${lockDir}`)
  console.error(`if nothing is running: rm -rf ${lockDir} && retry`)
  process.exit(2)
}
process.on("exit", () => {
  try {
    rmSync(lockDir, { recursive: true, force: true })
  } catch {}
})

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
  if (dryRun) await $`bun pm pack --dry-run`.cwd(dir)
  // These assertions gate the live path too. They used to sit inside the `dryRun`
  // branch, so the run that actually published checked nothing, while the comment on
  // `validateTarball` promised they were "checked before it can be published".
  const problems = await validateTarball(dir, name, version)
  if (problems.length) {
    console.error(`  ✗ ${name}@${version} ${dryRun ? "would publish" : "will not publish"} with problems:`)
    for (const p of problems) console.error(`      - ${p}`)
    process.exitCode = 1
    return
  }
  if (dryRun) {
    console.log(`  ok ${name}@${version} packs cleanly (not published: --dry-run)`)
    return
  }
  if (await published(name, version)) {
    console.log(`  already published ${name}@${version} — this call published nothing`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  const provenance = process.env.CI ? " --provenance" : ""
  await $`npm publish *.tgz --access public${provenance} --tag ${distTag}`.cwd(dir)
}

/** The npm page of a platform package: what it is, and where the product is. */
async function writePlatformReadme(dir: string, name: string) {
  const target = name.replace(`${pkg.name}-`, "")
  const body = [
    `# ${name}`,
    "",
    `Platform binary of [${pkg.name}](${product.repoUrl}) for **${target}** (macOS ${product.platform?.minVersion}+).`,
    "",
    "You almost certainly do not want to install this directly. It contains one compiled",
    `binary and no JavaScript entry points; install the wrapper instead:`,
    "",
    "```bash",
    `npm install -g ${pkg.name}`,
    "```",
    "",
    `The wrapper resolves the right platform package for the machine and places the binary on`,
    `your PATH. The bytes themselves are vouched for by npm's registry integrity (the tarball`,
    `is fetched against its recorded sha512); the install step then runs \`--version\` to confirm`,
    `the binary it placed actually starts, and nothing further is verified on this channel. See`,
    `${product.repoUrl}#readme for the product README, docs and the`,
    "macOS permission setup.",
    "",
  ].join("\n")
  await Bun.file(path.join(dir, "README.md")).write(body)
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
    // What the wrapper ships in its bin entries is the apology script, not a binary:
    // postinstall replaces it at install time. Nothing checked those bytes, so a tarball could
    // go out with a placeholder that cannot be exec'd, or that points its reader at a directory
    // that does not exist — and the release lane called that clean. Each check below is the
    // shape of one of those two failures, and each was seen red by deleting the thing it
    // guards (the shebang, the resolved path, the exec bit).
    const scripts = new Set<string>(Object.values(manifest.bin ?? {}).map((target) => path.join(dir, target as string)))
    for (const file of scripts) {
      if (!existsSync(file)) continue
      const label = path.relative(dir, file)
      const stat = await Bun.file(file).stat?.()
      if (stat && (stat.mode & 0o111) === 0) problems.push(`${label} is not executable in the tarball (mode ${(stat.mode & 0o777).toString(8)}) — the command would answer "permission denied" instead of its remedy`)
      const first = (await Bun.file(file).text()).split("\n", 1)[0]
      if (!first.startsWith("#!")) problems.push(`${label} has no shebang (first line is ${JSON.stringify(first)}) — a launcher that execs it without a shell gets ENOEXEC and no message`)
      // The remedy has to be actionable from wherever the reader is standing, which is the
      // whole point of the file and the thing it used to get wrong. Run it the way a tool
      // runs it — spawned directly, from an unrelated directory — and ask the output for the
      // directory it tells the reader to cd into.
      if (process.platform !== "win32") {
        try {
          const run = Bun.spawnSync([path.resolve(file)], { cwd: "/", stdout: "pipe", stderr: "pipe" })
          const seen = run.stderr.toString()
          if (run.exitCode === 0) problems.push(`${label} exits 0 when run — the placeholder reports success while installing nothing`)
          const named = seen.match(/cd "(\/[^"]*)" && node postinstall\.mjs/)
          if (!named) problems.push(`${label} prints no absolute "cd <dir> && node postinstall.mjs" remedy — a relative one does not resolve from a global install`)
          else if (!existsSync(path.join(named[1], "postinstall.mjs"))) problems.push(`${label} sends the reader to ${named[1]}, which does not hold postinstall.mjs`)
        } catch (error) {
          problems.push(`${label} could not be spawned from another directory: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    if (!existsSync(path.join(dir, "postinstall.mjs"))) problems.push("postinstall.mjs is missing — the platform binary would never be placed")
    if (!existsSync(path.join(dir, "LICENSE"))) problems.push("LICENSE is missing")
    if (!existsSync(path.join(dir, "README.md"))) problems.push("README.md is missing — the npm page would render as a bare version string")
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
    // a platform package: the binary itself. Every target names it after the product —
    // this used to be `name.endsWith("-darwin-x64") ? "glasspane-harness" : "glasspane-harness"`,
    // a branch whose two arms are the same string, which reads as if the x64 tarball held
    // a differently named binary and would quietly mis-validate the next target added here.
    const binary = product.bins[0]
    if (!existsSync(path.join(dir, "bin", binary))) problems.push(`bin/${binary} is missing from the tarball`)
    if (!existsSync(path.join(dir, "README.md"))) problems.push("README.md is missing — the npm page would render as a bare version string")
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

// A clean checkout has no dist/ (it is gitignored build output). The first CI run
// of the pack lane died here with a raw ENOENT, which is the tool being honest
// about its assumption and the lane being useless. Now it says what it needs.
const distExists = existsSync(path.join(dir, "dist"))
const binaries: Record<string, string> = {}
if (distExists) {
  for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
    const found = await Bun.file(`./dist/${filepath}`).json()
    binaries[found.name] = found.version
  }
} else {
  console.log(`no ./dist here — validating the wrapper only (platform tarballs need a build first)`)
  if (!dryRun) {
    console.error("publish: nothing to publish: run `bun run build` first (dist/ is build output and is not in git)")
    process.exit(2)
  }
}
// The label used to say "wrapper-only mode" for every `--dry-run`, including a default
// all-targets run — so the reader of the release log was told platform packages were not
// in scope at the exact moment the run was packing them.
console.log(`${dryRun ? "dry-run, every dist found here" : wrapperOnly ? "wrapper-only mode" : "binaries"} ${JSON.stringify(binaries)}`)
const missing = Object.keys(declaredPlatforms).filter((name) => !wrapperOnly && !binaries[name])
if (missing.length && distExists) {
  const detail = `${missing.length} declared target(s) are not built in this run: ${missing.join(", ")}`
  // A note is honest while nothing is being published. On the live path it is a broken
  // release: the wrapper's optionalDependencies are computed from product.json's target
  // matrix (not from this machine's dists), so it would go out naming a version of a
  // platform package that no build in this run produced. The machine for that target
  // then installs the wrapper and gets no binary — and npm reports the install as a
  // success because the dependency was optional.
  if (!dryRun) {
    console.error(`publish: refusing to publish — ${detail}`)
    console.error("  The wrapper would declare a platform package this run never built.")
    console.error("  Remedy: build every declared target, or publish the wrapper with")
    console.error("    bun run script/publish.ts --wrapper-only")
    console.error("  from the lane that holds them all (.github/workflows/release.yml, publish-wrapper).")
    process.exit(2)
  }
  console.log(`note: ${detail}`)
}

await $`mkdir -p ./dist/${pkg.name}`
await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())

// The npm page for a package renders its README, and 0.2.0 shipped without one —
// so the page was a bare version string. The wrapper gets the product README (it
// is the thing a reader wants on the page); platform packages get a short README
// that says what the package is and points at the product repo, because their
// "readme" is really a download notice.
// The product READMEs live at the fork root, not in this package (cwd is
// packages/opencode), so the paths climb two levels.
await Bun.file(`./dist/${pkg.name}/README.md`).write(await Bun.file("../../README.md").text())
await Bun.file(`./dist/${pkg.name}/README.zh-CN.md`).write(await Bun.file("../../README.zh-CN.md").text())
// The apology a user reads when their package manager gated the lifecycle script. Two
// shapes here were wrong and both were measured on 0.7.6:
//   * no shebang. npm and bun symlink their bin entry onto this file, and a launcher that
//     execs it without a shell gets nothing back — node's spawnSync returned an ENOEXEC
//     error with no stdout, bun's spawnSync threw (`errno -8, posix_spawn`), and a script
//     with a shebang run the same way printed and exited 1. So the one person who needed
//     the remedy — an agent or tool spawning the command directly — saw no message at all.
//   * the remedy was a path relative to a project root ("cd node_modules/glasspane-harness"),
//     which is exactly the install that has no project root. Reproduced with `bun add -g`:
//     the package landed in $HOME/node_modules/glasspane-harness and the printed line was
//     unresolvable from anywhere else. The fix is to resolve this script's own location:
//     $0 is the PATH entry the launcher used, measured identical under sh, bash, zsh and
//     node's spawnSync, so following the symlink chain names *this* install's directory.
await Bun.file(`./dist/${pkg.name}/bin/${pkg.name}.exe`).write(
  [
    "#!/bin/sh",
    "self=$0",
    "i=0",
    'while [ -L "$self" ] && [ $i -lt 8 ]; do',
    '  t=$(readlink "$self")',
    "  case $t in",
    "    /*) self=$t ;;",
    '    *) self=$(CDPATH= cd -P -- "$(dirname -- "$self")" && printf \'%s/%s\' "$PWD" "$t") ;;',
    "  esac",
    "  i=$((i + 1))",
    "done",
    'here=$(CDPATH= cd -P -- "$(dirname -- "$self")/.." 2>/dev/null && pwd)',
    `echo "Error: ${pkg.name}'s postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "The command on your PATH is still the placeholder the tarball ships, not the" >&2',
    'echo "binary. Managers leave it in place when they gate lifecycle scripts: bun blocks a" >&2',
    'echo "dependency\'s scripts until you trust it, npm skips them under --ignore-scripts," >&2',
    'echo "and some managers skip them by default." >&2',
    'echo "" >&2',
    'if [ -n "$here" ]; then',
    '  echo "Run this install\'s own postinstall step:" >&2',
    '  echo "  cd \\"$here\\" && node postinstall.mjs" >&2',
    '  echo "" >&2',
    "fi",
    'echo "Or let the package manager run it:" >&2',
    // Single-quoted on purpose: $(npm root -g) must expand in the reader's shell, not in
    // this script. Expanding here would run npm from inside the apology and print an empty
    // path on a machine that has only bun.
    `echo '  cd "$(npm root -g)/${pkg.name}" && node postinstall.mjs   # npm global install' >&2`,
    `echo "  bun pm trust ${pkg.name}                        # in the project you installed into" >&2`,
    'echo "" >&2',
    'echo "Either way the check afterwards is the same, and only a version number means it" >&2',
    `echo "worked: ${pkg.name} --version" >&2`,
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
  //
  // The wrapper's own `dist/<product>` directory is excluded: it is left behind by a
  // previous run, so scanning `dist/*/package.json` picked the wrapper up as if it were
  // one of the platform packages and published it *inside* this batch — before the
  // platform packages its optionalDependencies name. That ordering is the one thing the
  // release lane guarantees (publish-wrapper carries `needs: publish-platform`), and the
  // duplicate number here was already visible in the dry-run as two identical
  // "ok glasspane-harness@… packs cleanly" lines.
  const tasks = Object.entries(binaries)
    .filter(([name]) => name !== pkg.name)
    .map(async ([name]) => {
      await writePlatformReadme(`./dist/${name}`, name)
      // The version a platform tarball must carry is the product's, not the one its own
      // dist manifest happens to say. `binaries[name]` was read out of that same
      // package.json a few lines above, so handing it to validateTarball() made its first
      // assertion compare a file with itself — it could never fire. A stale `dist/` from
      // the previous release therefore packed, printed "ok … packs cleanly", and would
      // have published under the OLD version while the wrapper published under the new
      // one; the wrapper's optionalDependencies name the new version, so the machine that
      // needs it resolves nothing and installs without a binary. Measured on this machine
      // before the fix: dist said glasspane-harness-darwin-arm64@0.7.0 against a 0.7.1
      // wrapper, and --dry-run called that clean.
      await publish(`./dist/${name}`, name, version)
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
