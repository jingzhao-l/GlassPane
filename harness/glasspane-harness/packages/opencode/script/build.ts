#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@opencode-ai/script"
import pkg from "../package.json"
import { assetUploadDecision, visibilityFromGhOutput } from "./release-assets"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
// [gp] Product decision (revised 2026-09-25 after owner input: "那几个配套产品面
// 还是需要的"): the web app IS a product face and is embedded by default again,
// like upstream and like iterate-harness baking its dashboard into the wheel.
// `--skip-embed-web-ui` stays for a CLI-only build (it is what a headless CI lane
// or a slow machine wants); the runtime flag OPENCODE_DISABLE_EMBEDDED_WEB_UI and
// the graceful fallback in server/shared/ui.ts are untouched, so a build without
// the bundle still starts and says the UI is absent instead of failing.
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  // [gp] Product guard: `packages/app/vite.config.ts` (upstream's file, byte-identical
  // to the reference clone) activates `@sentry/vite-plugin` whenever SENTRY_AUTH_TOKEN,
  // SENTRY_ORG and SENTRY_PROJECT are all present — uploading sourcemaps to a third
  // party and deleting `dist/**/*.map` after. No release workflow sets them today, but
  // the activation is env-driven and ambient, so any future CI or dev machine that does
  // would silently push this product's sources to Sentry. This build lane is this
  // product's entry point, so it clears the switch explicitly rather than relying on the
  // app's own config to stay quiet. `OPENCODE_CHANNEL` stays: it is this product's own
  // channel, set by the caller, not a third-party upload.
  await $`OPENCODE_CHANNEL=${Script.channel} SENTRY_AUTH_TOKEN= SENTRY_ORG= SENTRY_PROJECT= SENTRY_RELEASE= VITE_SENTRY_RELEASE= bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()

const treeSitterWorker = await Bun.file(fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))).text()

// [gp] Product: the target matrix lives in product.json (one truth for build,
// publish and the product-surface gate). Upstream hard-coded it right here, which
// meant the npm wrapper's optionalDependencies had to be re-derived by hand.
// `name` is here because the platform manifest below is named after the product and
// says so in its own `description`; it was missing from this annotation, so
// `tsc --noEmit` failed with TS2339 on both uses. That is the typecheck lane in the
// split repo's own CI — which had been red since the `repository` field landed, so
// the failure nobody saw was the typecheck itself failing.
const product = (await Bun.file(path.join(import.meta.dirname, "..", "..", "..", "product.json"))
  .json()
  .catch(() => null)) as { name?: string; version?: string; platformTargets?: PlatformTarget[]; repo?: string; repoUrl?: string } | null
if (!product?.platformTargets?.length) {
  console.error("product.json is missing or has no platformTargets — refusing to build a product with an unrecorded target matrix")
  process.exit(2)
}
type PlatformTarget = { os: string; arch: "arm64" | "x64"; abi?: "musl"; avx2?: false }
const allTargets: PlatformTarget[] = product.platformTargets

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

await $`rm -rf dist`

const binaries: Record<string, string> = {}
// [gp] Cross-platform native artifacts, installed FROM the reviewed lock.
//
// These three lines used to be `bun install --os="*" --cpu="*" <name>@<version>` for @opentui/core,
// @parcel/watcher and @ff-labs/fff-bun. A package argument makes bun run an *add*, not an install,
// and both halves of that were measured on this repo's bun (1.3.14) against a fixture workspace
// shaped like this one (root `workspaces.catalog` + a package whose dependency is `"catalog:"`):
//   · it rewrites the manifest — `"@parcel/watcher": "catalog:"` came back as a literal `"2.5.1"`,
//     so the file CI's `bun install --frozen-lockfile` (release.yml:336, :887, :1111, :1225, :1257
//     and ci.yml:55) was given its lock for is edited mid-build;
//   · it re-resolves, so the integrity recorded is the one for the bytes this run received, not the
//     one the audited `bun.lock` carries.
// The step's actual need is narrower: every platform variant must be *materialised* on disk,
// because `Bun.build({compile})` for a foreign target reads the native package of that target.
// `--os`/`--cpu` with no package argument does exactly that from the lock, and `--frozen-lockfile`
// turns "the lock has no such variant" into a refusal instead of a quiet new resolution. Checked
// against this repository's own lock before the change: the three natives declare 29 platform
// variants between them (8 `@opentui/core-*`, 13 `@parcel/watcher-*`, 8 `@ff-labs/fff-bin-*`), every
// one of them is already an entry in `bun.lock` with an `os`/`cpu` gate and a `sha512-` integrity,
// and `bun install --frozen-lockfile --os="*" --cpu="*" --dry-run` in this package plans all of
// them — so the frozen form asks for nothing the audited set does not already contain.
if (!skipInstall) {
  await $`bun install --frozen-lockfile --os="*" --cpu="*"`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const workerPath = "./src/cli/tui/worker.ts"
  const treeSitterWorkerPath = "opentui-tree-sitter-worker.js"
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"

  const compiled = await Bun.build({
    conditions: ["bun", "node"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/glasspane-harness`,
      execArgv: [`--user-agent=glasspane-harness/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      [treeSitterWorkerPath]: treeSitterWorker,
      ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
    },
    entrypoints: [
      "./src/index.ts",
      workerPath,
      treeSitterWorkerPath,
      ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : []),
    ],
    define: {
      FFF_LIBC: JSON.stringify(item.abi === "musl" ? "musl" : "gnu"),
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MODELS_DEV: generated.modelsData,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + treeSitterWorkerPath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
    // The rejection half of Bun.build's failure contract, caught so it can name the target.
    // Measured on this repo's bun (1.3.14): `throw` defaults to true, so an unresolvable import,
    // a syntax error, an outfile that is an existing directory and an unknown compile target all
    // reject with `AggregateError: Bundle failed`. Left unhandled, that ends the run with a dump
    // whose target is only guessable from the `building <name>` line printed before it — and it
    // ends *before* `binaries[name]`, so the two failure shapes need the same named verdict here.
  }).catch((error) => {
    console.error(`build failed: Bun.build threw for target ${name}: ${String(error).split("\n")[0]}`)
    process.exit(1)
  })

  // The build result is judged per target, by name.
  //
  // Two separate holes were here. (1) The awaited value was thrown away, so nothing in this loop
  // ever asked whether the compile succeeded — and `binaries[name]` at the bottom of the loop is
  // recorded unconditionally, which is what the publish lane and the release upload read as "this
  // target exists". (2) Only the *native* target is smoke-tested below, so a second target had no
  // observer on `bun run build` (both darwin targets on one machine, docs/release.md).
  //
  // Three shapes are named failures now: the rejection (the `.catch` above), a build that settles
  // with `success: false` — the half of the API the discarded value made unreachable, and the only
  // verdict a caller gets once `throw` is off or a future bun changes that default — and a build
  // that settles as successful without writing the artifact, which is the case that leaves
  // `dist/<name>/bin` empty while `binaries` says otherwise.
  if (!compiled.success) {
    console.error(`build failed: Bun.build reported success=false for target ${name}`)
    for (const log of compiled.logs) console.error(`  ${name}: ${log.message}`)
    process.exit(1)
  }
  const outfile = `dist/${name}/bin/glasspane-harness`
  if (!(await Bun.file(outfile).exists())) {
    console.error(`build failed: Bun.build reported success for ${name} but wrote no ${outfile}`)
    process.exit(1)
  }

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/glasspane-harness`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      // The smoke test's whole claim is "this binary is the one this tree built", and that claim
      // is only checked by the number it answers with. Exit status alone passes on a binary that
      // prints the development fallback: running this source without the version define answers
      // `local` (measured in the worktree on 2026-10-13), and the lane called that a pass —
      // FORK.md cites this very output as the proof the build came from this tree.
      const got = versionOutput.trim()
      if (got !== Script.version) {
        console.error(`Smoke test failed: ${binaryPath} --version answers ${JSON.stringify(got)}, this build declares ${JSON.stringify(Script.version)}`)
        process.exit(1)
      }
      console.log(`Smoke test passed: ${got}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        description: `The ${item.os}/${item.arch} binary of ${product.name}. Install the ${product.name} wrapper instead of this package.`,
        // npm verifies a provenance bundle's repository against the published
        // manifest and refuses the upload when they disagree:
        //   E422 "repository.url" is "", expected to match "https://github.com/…"
        // The wrapper carried this field and the platform packages did not, so
        // both --provenance and the staged fallback were rejected. Same source of
        // truth as the wrapper (product.json), so the two cannot drift.
        ...(product.repo ? { repository: { type: "git", url: `git+https://github.com/${product.repo}.git` } } : {}),
        // This read `product.homepage`, a field product.json does not have, so the spread silently
        // emitted nothing and the platform packages shipped without a homepage while the wrapper had
        // one. `repoUrl` is the declared field and `#readme` is the form npm's own metadata uses, so
        // the two manifests now come from one source instead of one being read from a name nobody wrote.
        ...(product.repoUrl ? { homepage: `${product.repoUrl}#readme` } : {}),
        ...(product.repo ? { bugs: { url: `https://github.com/${product.repo}/issues` } } : {}),
        license: "MIT",
        preferUnplugged: true,
        os: [item.os],
        cpu: [item.arch],
        ...(item.abi ? { libc: [item.abi] } : {}),
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  // Upload exactly the archives this run produced.
  //
  // The previous form globbed both extensions unconditionally
  // (`./dist/*.zip ./dist/*.tar.gz`). Each matrix runner builds only its own
  // platform, so exactly one of the two ever exists — and bun's shell treats a
  // non-matching glob as an error rather than an empty argument list, so a
  // macOS runner died on `./dist/*.tar.gz` finding nothing, *after* the binary
  // had built and passed its smoke test. Collecting the names as they are made
  // removes the guess and makes the macOS-only product path work.
  const archives: string[] = []
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
      archives.push(`./dist/${key}.tar.gz`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
      archives.push(`./dist/${key}.zip`)
    }
  }
  if (archives.length === 0) throw new Error("no binaries were built, so there is nothing to upload")
  // Ask what the release is before overwriting anything in it. `--clobber` exists so a re-run of this
  // job can replace its own unfinished asset while the release is still the draft `create-release`
  // made; onto a PUBLIC release the same flag replaces the bytes a published version number names,
  // and npm — the channel most users install from — refuses that version and keeps its old tarballs.
  // One version, two byte sets, only one of them the registry's. `release-assets.ts` carries the
  // reasoning; the answer here is a refusal the operator can act on, not a warning to scroll past.
  const tag = `v${Script.version}`
  const visibility = await $`gh release view ${tag} --json isDraft --repo ${process.env.GH_REPO}`
    .nothrow()
    .quiet(true)
  const decision = assetUploadDecision(visibilityFromGhOutput(visibility.stdout.toString(), visibility.exitCode), tag)
  if (!decision.ok) throw new Error(`refusing to upload ${tag}: ${decision.message}\n  remedy: ${decision.remedy}`)
  console.log(`build: ${decision.why} — uploading ${archives.length} asset(s)`)
  await $`gh release upload ${tag} ${archives} --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
