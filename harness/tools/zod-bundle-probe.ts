/*
 * Asks the bundler, not the lock: which `zod@<version>` files land in the release bundle?
 *
 * `bun.lock` answers "what is installed". The shipped artifact answers "what runs", and the two
 * differ: `script/build.ts` bundles every package except `node-gyp`, and the fork imports
 * `gitlab-ai-provider` — which pins zod 3 — by a literal specifier, so a nested copy can reach the
 * binary even though no line of our own code imports zod 3. Measured 2026-10-24: the bundle carries
 * `zod@3.25.76`, `zod@4.4.3` and `zod@4.6.7`, i.e. two copies inside GHSA-mrhx-c7xc-m3w5's `< 4.6.6`
 * ship in the artifact while the advisory-driven bump only moved the copy we import.
 *
 * The released binary cannot be re-downloaded and trusted on this machine — this proxy truncates
 * large GitHub asset streams (recorded), and the arm64 zip at 46 MB is exactly that class — so the
 * bundler is asked instead, through its metafile.
 *
 * The inputs are read out of `script/build.ts` rather than restated here: a probe carrying its own
 * copy of the entrypoints would be measuring the probe. Two of build.ts's inputs are build-stage
 * artifacts rather than code-graph facts and are set aside — the generated web-UI entry (produced by
 * that build itself) and the per-platform native packages (installed by its own
 * `bun install --os="*" --cpu="*"` lines). The omission is reported because it bounds what the tally
 * may claim: a zod reachable only through the generated UI entry would not appear here.
 *
 * Prints one JSON line to stdout; any failure to measure is exit 2 with the reason on stderr.
 * Invoked by `harness/tools/zod-bundle.mjs`, which owns the verdict.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

const forkRoot = path.resolve(import.meta.dir, "..", "glasspane-harness") // this file lives in harness/tools/, beside the fork it measures
const pkg = path.join(forkRoot, "packages", "opencode")
const src = readFileSync(path.join(pkg, "script", "build.ts"), "utf8")

const declared = /entrypoints:\s*\[([\s\S]*?)\]/.exec(src)
if (!declared) {
  console.error("zod-bundle-probe: script/build.ts has no readable `entrypoints: [...]` — refusing to measure a graph of our own invention")
  process.exit(2)
}
const entryMatches = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
if (entryMatches.length === 0) {
  console.error("zod-bundle-probe: no entrypoints were parsed — nothing was measured")
  process.exit(2)
}
const entrypoints = entryMatches.filter((rel) => !rel.endsWith(".gen.ts"))
const dropped = entryMatches.filter((rel) => rel.endsWith(".gen.ts"))
const externals = (src.match(/external:\s*\[([^\]]*)\]/) ?? [])[1] ?? ""
const buildExternals = [...externals.matchAll(/"([^"]+)"/g)].map((m) => m[1])
const platformNatives = ["@opentui/*", "@parcel/watcher-*", "@ff-labs/fff-bun-*"]

const result = await Bun.build({
  entrypoints: entrypoints.map((rel) => path.join(pkg, rel)),
  target: "bun",
  external: [...buildExternals, ...platformNatives],
  packages: "bundle",
  metafile: true,
  write: false,
  minify: true,
})
if (!result.success) {
  console.error(`zod-bundle-probe: the graph did not build (${result.logs.length} log line(s))`)
  for (const log of result.logs.slice(0, 3)) console.error(`  ${log.message}`)
  process.exit(2)
}

const copies = new Map()
for (const info of Object.values(result.metafile?.outputs ?? {})) {
  for (const input of Object.keys(info.inputs ?? {})) {
    const hit = /node_modules[./\\](?:\.bun[./\\])?(zod@[0-9][^/\\]*)/.exec(input)
    if (!hit) continue
    copies.set(hit[1], (copies.get(hit[1]) ?? 0) + 1)
  }
}
if (copies.size === 0) {
  console.error("zod-bundle-probe: no zod path appears in the metafile — this build says nothing about zod")
  process.exit(2)
}
console.log(JSON.stringify({ copies: Object.fromEntries(copies), entrypoints, dropped, external: [...buildExternals, ...platformNatives] }))
