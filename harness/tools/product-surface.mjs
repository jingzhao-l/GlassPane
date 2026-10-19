#!/usr/bin/env node

/**
 * product-surface.mjs — the packaging ruler: one product truth, checked everywhere.
 *
 * WHY. Private-ization is a distributed fact, and distributed facts rot: the npm
 * name lives in product.json *and* in the package manifest, the wrapper's name is
 * derived in publish.ts, the platform package prefix is duplicated in build.ts,
 * postinstall.mjs and the bin shim, the install URLs are in two installer scripts,
 * the release lanes are in a workflow — and nothing notices when one of them keeps
 * the upstream name. The symptom is not a red test: it is an installer that
 * installs something nobody meant to ship, or a publish that pushes to a stranger's
 * registry. `brand-surface.mjs` watches strings; this tool watches *agreement*.
 *
 * WHAT IT CHECKS (each rule names its file; every failure is actionable):
 *   manifest-name / manifest-version / manifest-bins      product.json == package.json
 *   platform-template                                    target names unique, template sane
 *   targets-from-manifest                                build.ts reads the matrix
 *   binary-name-in-build / wrapper-name-in-publish       product name reaches the artifacts
 *   no-upstream-registries                               no ghcr/AUR/tap/opencode.ai/install anywhere product-facing
 *   postinstall-identity / runtime-package-names          the shim + install/upgrade/uninstall speak the product name
 *   cli-text-names-product-env                               src/cli/cmd strings name GLASSPANE_HARNESS_*, not the legacy fallback
 *   state-root / config-names                            XDG root + config file names (product first, legacy kept)
 *   installer-urls / installer-syntax / installer-dry-run the one-click scripts point at the product and actually parse/plan
 *   workflows / notice-license                            our own pipelines only; attribution on disk
 *   release-anchor                                        the release lane proves the released tree IS trunk's
 *                                                         `harness/glasspane-harness` subtree (fetched from trunk,
 *                                                         compared as a tree hash, and depended on by the jobs
 *                                                         that create and build the release)
 *   scan-set                                              every DISCOVERY set this gate walks is pinned at a floor,
 *                                                         because an empty or shortened scan prints fewer
 *                                                         agreements and used to stay green
 *   selftest-wired                                        every fixed-point test under harness/tools is referenced
 *                                                         by a workflow step or a package.json script — a test
 *                                                         nobody runs cannot go red
 *   engine-methods                                        the fork's method table re-derived from FrameCodec.swift,
 *                                                         AND its recorded `swiftBlob` re-hashed from those bytes
 *   agreement-count                                       the run asked at least as many questions as before
 *
 * MODES
 *   --check (default)  all rules must hold
 *   (no --record, and no other flag: this is an agreement, not a number to baseline. If a rule
 *   is wrong, fix the rule in review — there is nothing to "record over", and accepting a
 *   `--record` that writes nothing was a flag that promised a baseline and did nothing)
 *
 * Exit codes: 0 agree, 1 disagree (named rule + file), 2 cannot measure (or an unknown flag).
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const forkRoot = path.join(repoRoot, "harness", "glasspane-harness")
const pkgDir = path.join(forkRoot, "packages", "opencode")

function die(code, msg) {
  console.error(`product-surface: ${msg}`)
  process.exit(code)
}

/**
 * No arguments but `--check` (and none at all — `ci.yml` runs it bare).
 *
 * WHY THIS IS A CHECK AND NOT A POLICY NOTE. `--record` used to be accepted silently: it
 * printed the agreements and exited 0 while writing nothing. A flag that parses but does
 * nothing is how a lane learns to type a flag it believes records a baseline — and this is
 * the one ruler in `harness/tools` that must have no baseline, because what it asserts is
 * "these files agree with product.json", not "this number has not moved". If a rule is
 * wrong, the rule changes in review; there is nothing to stamp over a disagreement.
 */
{
  const unknown = process.argv.slice(2).filter((a) => a !== "--check")
  if (unknown.length) {
    die(
      2,
      `unknown argument(s): ${unknown.join(", ")} — this ruler has NO golden, so there is nothing to record. ${unknown.includes("--record") ? "`--record` is not a mode here: it would be a flag that looks like a baseline and does nothing, which is worse than no flag. " : ""}Run \`node harness/tools/product-surface.mjs --check\` (or with no argument). A red rule is fixed in the named file, or by changing product.json deliberately — never by re-recording.`,
    )
  }
}
function read(rel) {
  const abs = path.join(forkRoot, rel)
  if (!existsSync(abs)) die(2, `missing ${path.relative(repoRoot, abs)} — cannot measure the product surface`)
  return readFileSync(abs, "utf8")
}
/**
 * The executable text of a file. Every "does this file still speak the product name" rule
 * has to read through this, or a comment that quotes the product name satisfies a rule about
 * the code — the same reason `no-upstream-registries` strips comments before searching.
 */
function readCode(rel) {
  return stripComments(read(rel))
}

const product = (() => {
  const file = path.join(forkRoot, "product.json")
  if (!existsSync(file)) die(2, "product.json is missing — the product has no machine-readable truth")
  return JSON.parse(readFileSync(file, "utf8"))
})()
const manifest = JSON.parse(read("packages/opencode/package.json"))

const problems = []
const ok = []
const check = (rule, condition, detail) => {
  if (condition) ok.push(rule)
  else problems.push(`[${rule}] ${detail}`)
}

/**
 * Floors for the DISCOVERY sets this gate walks.
 *
 * WHY. The lane prints `${ok.length} agreement(s)` and compares that number against nothing,
 * and most agreements come from loops: every CLI file under `src/cli/**` × 2 rules (66 files
 * today) plus the launcher, every forbidden-registry file × 6 needles (7 files), every
 * discovered foreign publisher × 3 (4 of them), every `product.bins` entry × 2 (2 of them).
 * Empty one of those sets — delete `product.bins`, rewrite a glob so it matches nothing,
 * shorten a list — and the lane prints a SMALLER number of agreements and still exits 0. The
 * count of what was asked is not evidence that it was asked; `no-foreign-publish` already
 * pins publisher discovery by name (see the `for (const want of …)` below), and this is the
 * same shape applied to every scan set a verdict depends on.
 *
 * Floors, not ceilings: a scan set growing is ordinary work (a new CLI command file adds two
 * agreements), a scan set shrinking is a caliber change and has to be argued in review.
 * Changing one of these numbers in this file IS that argument; lowering one to make a red
 * lane green is the loosening this repository forbids.
 */
const SCAN_SET_FLOORS = {
  bins: 2, // product.json -> bins
  forbiddenFiles: 879, // shipped text discovered under the release, install, launcher and patch paths
  forbiddenNeedles: 7, // what they are searched for
  cliCmdFiles: 66, // packages/opencode/src/cli/cmd/**.ts, walked recursively
  envDiscovery: 67, // those CLI files + the shipped launcher
  foreignPublishers: 4, // per-package publishers that must stay dead ends
  workflows: 7, // 3 root + 2 fork workflow files, plus the 2 package.json manifests the wiring corpus reads
  selftests: 4, // selftests that must be wired to a runner
  catalogProviders: 200, // providers in the committed model catalog
}

// ---- manifest agreement
check("manifest-name", manifest.name === product.name, `package.json name "${manifest.name}" != product.json name "${product.name}"`)
check("manifest-version", manifest.version === product.version, `package.json version ${manifest.version} != product.json version ${product.version}`)
// The bins loop below produces 2 agreements per bin. If `product.bins` goes empty or loses
// one entry, it asserts nothing and the lane simply prints fewer agreements — which reads as
// a smaller product surface rather than as a scan that stopped happening.
check("scan-set", (product.bins ?? []).length >= SCAN_SET_FLOORS.bins, `product.json declares ${(product.bins ?? []).length} bin(s), the floor for this gate is ${SCAN_SET_FLOORS.bins} — the manifest-bins loop would check ${product.bins ? product.bins.length * 2 : 0} fact(s) instead of ${SCAN_SET_FLOORS.bins * 2}. An empty or shortened "bins" list is a scan set shrinking, not a surface getting smaller.`)
for (const bin of product.bins ?? []) {
  const target = manifest.bin?.[bin]
  check("manifest-bins", typeof target === "string", `product.json declares bin "${bin}" but package.json bin map has no such entry`)
  if (typeof target === "string") {
    check("manifest-bins", existsSync(path.join(pkgDir, target)), `bin "${bin}" points at ${target}, which does not exist`)
  }
}

// ---- kernel provenance (the kernel is a dependency, not a copy in our tree)
// product.json used to duplicate the kernel's package/version/mode. It went stale the day the
// vendored tree was retired, and nothing read it — a machine-readable "truth" with no reader is
// a rumour. So product.json now points at contracts/kernel-pin.json, and these checks are the
// reader: the pointer resolves, the pin agrees with the dependency line the build actually
// installs, and the vendored copy stays gone.
const kernelPointer = product.kernel?.provenance
const pinRel = "contracts/kernel-pin.json"
check("kernel-provenance", kernelPointer === pinRel, `product.json kernel.provenance is ${JSON.stringify(kernelPointer)}, expected "${pinRel}"`)
if (kernelPointer === pinRel) {
  const pin = JSON.parse(read(pinRel))
  check("kernel-provenance", pin.package === "iterate-kernel", `kernel-pin.json declares package ${pin.package}, expected iterate-kernel`)
  const declared = manifest.dependencies?.[pin.package]
  check("kernel-provenance", typeof declared === "string", `packages/opencode/package.json has no "${pin.package}" dependency — the pin describes something the product does not install`)
  check("kernel-provenance", declared === pin.version, `dependency line says ${declared}, kernel-pin.json pins ${pin.version}`)
  check("kernel-provenance", !existsSync(path.join(pkgDir, "vendor", "kernel")), "packages/opencode/vendor/kernel is back — the kernel ships as a dependency; the vendored copy was retired with its ruler")
  // Shape, not a magic count. This line used to read `length > 8` while its own message
  // asserted "ships 14", the pin held 15, and 0.1.4 ships 17 — so a corpus that lost eight
  // contract files stayed green and every bump made the sentence a lie. What the rule can
  // actually know is what makes the pin usable: every entry names a file and carries a sha256
  // that `script/kernel-pin.mjs --check` can compare against the installed bytes.
  const corpus = Array.isArray(pin.corpus) ? pin.corpus : []
  const malformed = corpus.filter((entry) => typeof entry?.file !== "string" || entry.file.length === 0 || !/^[0-9a-f]{64}$/.test(String(entry.sha256 ?? ""))).length
  check(
    "kernel-provenance",
    corpus.length > 0 && malformed === 0,
    `kernel-pin.json corpus has ${corpus.length} entr(ies), ${malformed} without a "file" + 64-hex sha256 — a corpus that does not name and hash its files cannot catch a swapped artifact`,
  )
  check(
    "kernel-provenance",
    new Set(corpus.map((entry) => entry?.file)).size === corpus.length,
    "kernel-pin.json lists the same contract file twice — one of the two sha256s would never be read",
  )
}

// ---- platform naming
const template = product.platformPackage ?? ""
check("platform-template", ["{name}", "{os}", "{arch}"].every((token) => template.includes(token)), `platformPackage "${template}" must contain {name}, {os}, {arch}`)
const targetNames = (product.platformTargets ?? []).map((t) => {
  const os = t.os === "win32" ? "windows" : t.os
  return [product.name, os, t.arch, t.avx2 === false ? "baseline" : undefined, t.abi].filter(Boolean).join("-")
})
check("platform-template", new Set(targetNames).size === targetNames.length, "two platform targets compute the same package name")
check("platform-template", (product.platformTargets ?? []).length > 0, "product.json declares no platform targets")

// ---- build + publish speak the product
const build = read("packages/opencode/script/build.ts")
check("targets-from-manifest", /platformTargets/.test(build) && !/const allTargets: \{/.test(build), "build.ts must read the target matrix from product.json instead of hard-coding it")
check("binary-name-in-build", build.includes(`bin/${product.binary}`), `build.ts does not write the product binary name (${product.binary})`)
check("binary-name-in-build", build.includes(`--user-agent=${product.name}/`), "build.ts user-agent is not the product name")
const publish = read("packages/opencode/script/publish.ts")
check("wrapper-name-in-publish", publish.includes("await publish(`./dist/${pkg.name}`, pkg.name"), "publish.ts must publish the wrapper under the product name (upstream appended -ai)")
check("wrapper-name-in-publish", publish.includes("--wrapper-only"), "publish.ts has no --wrapper-only mode (the release lane's wrapper job needs it)")
check("wrapper-name-in-publish", !publish.includes('pkg.name + "-ai"'), "publish.ts still derives an -ai suffixed wrapper name")

// ---- the fork root's upstream orchestrator stays a dead end
// Upstream's root `script/publish.ts` stamped a version into every package.json in the tree,
// npm-published `@opencode-ai/sdk` / `-plugin` / `-ui` (three packages this product does not
// own) and force-pushed tags with `--no-verify`. The [gp] version refuses with exit 2 and
// names the real lane; this rule is the reader for the promise written in that file's own
// header, which until now pointed at a rule that did not exist. Comments are stripped, so a
// sentence *describing* the removed body cannot satisfy it — only the absence of the body can.
const rootPublish = stripComments(read("script/publish.ts"))
check("no-foreign-publish", /process\.exit\(2\)/.test(rootPublish), "script/publish.ts (fork root) no longer refuses — it must exit 2 before it can publish")
check("no-foreign-publish", !/npm publish/.test(rootPublish), "script/publish.ts runs `npm publish` from the fork root")
// The two rules above read ONE file: the root orchestrator. The per-package publishers it
// used to call kept their live `npm publish … --access public` bodies, and no needle that
// only looks at script/publish.ts can ever see a file it does not open. A dead root entry
// point with live per-package entry points one `cd` away is the same door left open — and
// the door was wider than the report: four such publishers existed (`@opencode-ai/plugin`,
// `-sdk`, `-ui`, `-cli`), each with its own live publish line, none of them named in
// product.json, none of them protected by `private` or a `publishConfig` gate.
//
// The set is DISCOVERED, not remembered: walking `packages/**/script/publish.ts` means an
// upstream sync that lands a fifth publisher trips this rule without anyone editing it,
// which is exactly the failure a hardcoded file list repeats. The product's own publisher is
// the one file allowed to still contain a publish call, so it is excluded by path.
const publisherFiles = (() => {
  const found = []
  const walk = (rel, depth) => {
    if (depth > 4) return
    for (const entry of readdirSync(path.join(forkRoot, rel), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const child = path.join(rel, entry.name)
      if (entry.name === "script" && existsSync(path.join(forkRoot, child, "publish.ts"))) {
        found.push(`${child}/publish.ts`)
      }
      walk(child, depth + 1)
    }
  }
  walk("packages", 0)
  return found
})()

const productPublisher = "packages/opencode/script/publish.ts"
const foreignPublishers = publisherFiles.filter((f) => f !== productPublisher).sort()
// A broken walk disables this whole section while still printing green, so the discovery is
// asserted on its own: the four known dead ends must all still be found. If one goes missing
// because it moved, this names it; if all four go missing, the walk is broken.
check("no-foreign-publish", publisherFiles.includes(productPublisher), "the product's own publisher (packages/opencode/script/publish.ts) is not discovered — the walk is broken")
check(
  "scan-set",
  foreignPublishers.length >= SCAN_SET_FLOORS.foreignPublishers,
  `the packages/**/script/publish.ts walk found ${foreignPublishers.length} foreign publisher(s) (${foreignPublishers.join(", ") || "none"}); this gate's floor is ${SCAN_SET_FLOORS.foreignPublishers} — each one is worth 3 agreements, so a walk that finds fewer silently checks ${3 * (SCAN_SET_FLOORS.foreignPublishers - foreignPublishers.length)} fewer things. A publisher that moved is renamed here in the same commit; a glob that stopped matching is fixed, not recorded.`,
)
for (const want of [
  "packages/cli/script/publish.ts",
  "packages/plugin/script/publish.ts",
  "packages/sdk/js/script/publish.ts",
  "packages/ui/script/publish.ts",
]) {
  check("no-foreign-publish", foreignPublishers.includes(want), `${want} is not discovered as a per-package publisher — it moved (update the dead-end list) or the walk broke`)
}
check(
  "no-foreign-publish",
  !foreignPublishers.some((rel) => rootPublish.includes(rel)),
  "script/publish.ts invokes a per-package publish script again — that lane npm-publishes under upstream's scope",
)
for (const rel of foreignPublishers) {
  const code = readCode(rel)
  check("no-foreign-publish", /process\.exit\(2\)/.test(code), `${rel} no longer refuses — it must exit 2 before it can publish`)
  check("no-foreign-publish", !/npm publish|--access public/.test(code), `${rel} runs a live public-registry publish again`)
  check("no-foreign-publish", !/@opencode-ai\//.test(code), `${rel} names an upstream-scope package (@opencode-ai/...) in executable text — a live publish body is back`)
}

// ---- nothing product-facing may talk to upstream's infrastructure
const forbidden = [
  ["ghcr.io/anomalyco", "docker registry (upstream's)"],
  ["anomalyco/homebrew-tap", "upstream's Homebrew tap"],
  ["aur.archlinux.org", "the AUR"],
  ["opencode.ai/install", "upstream's self-upgrade script URL"],
  ['"opencode-ai"', "the upstream npm package name"],
  ["opencode-ai@", "the upstream npm package name"],
]
const forbiddenNeedles = [
  ...forbidden,
  ["models.opencode.ai", "upstream's model catalog, which is fetched at runtime and whose `npm` field becomes a dynamic import"],
]
/**
 * The scanned set is DISCOVERED, not remembered. The hand-listed 7 files are why a shipped
 * leak passed: `packages/tui/src/feature-plugins/home/tips-view.tsx` prints
 * `docker run -it --rm ghcr.io/anomalyco/opencode` on the home screen of every installed
 * copy, and this gate never opened that file — the needle it holds was in the list, the
 * file was not. Everything that reaches a user or a machine is in scope: the sources
 * compiled into the binary, the launchers, the installers, and `patches/`, which
 * `bun install` reads. Test and fixture trees are excluded: they quote upstream strings to
 * prove migration works, and a gate that demands they forget would be answered by deleting
 * the test.
 */
const forbiddenScanDirs = [
  "packages/opencode/src",
  "packages/opencode/script",
  "packages/opencode/bin",
  "packages/tui/src",
  "packages/core/src",
  "packages/plugin/src",
  "scripts",
  "patches",
]
const forbiddenScanExt = /\.(ts|tsx|js|mjs|cjs|sh)$/
function textFilesUnder(rel) {
  const found = []
  for (const entry of readdirSync(path.join(forkRoot, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test" || entry.name === "tests" || entry.name === "fixtures") continue
      found.push(...textFilesUnder(child))
    } else if (forbiddenScanExt.test(entry.name)) found.push(child)
  }
  return found
}
const forbiddenFiles = forbiddenScanDirs.flatMap(textFilesUnder).filter((rel) => existsSync(path.join(forkRoot, rel))).sort()
// A discovered set can also go quiet by its roots leaving the tree, so the files that carry
// the release and install path are named as well: the walk must find them or the lane is red.
for (const want of [
  "packages/opencode/script/publish.ts",
  "packages/opencode/script/postinstall.mjs",
  "packages/opencode/src/installation/index.ts",
  "packages/opencode/src/cli/cmd/uninstall.ts",
  "packages/opencode/bin/glasspane-harness",
  "scripts/install.sh",
]) {
  check("scan-set", forbiddenFiles.includes(want) || forbiddenScanDirs.some((d) => want.startsWith(`${d}/`)), `${want} is no longer inside the discovered upstream-registry scan set (${forbiddenScanDirs.join(", ")}) — a distribution file the gate stopped reading`)
}
/** Comments carry the record of what was removed; only code can still reach it. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1").replace(/^\s*#.*$/gm, "")
}
// Both halves of this cross product are pinned. The needles are a literal list (dropping one is
// dropping an upstream release lane this gate looks for), and the files are discovered (a root
// leaving the tree, an extension dropping out, or the exclusions widening is a scan that quietly
// stopped happening). The floor below is the count this walk measures today: shrinking it in
// review is the argument, lowering it to make a red lane green is the loosening this repository
// forbids.
check("scan-set", forbiddenFiles.length >= SCAN_SET_FLOORS.forbiddenFiles, `the upstream-registry scan set discovered ${forbiddenFiles.length} file(s); floor is ${SCAN_SET_FLOORS.forbiddenFiles} — a scan set that found fewer files read fewer of them for every needle at once (${forbiddenFiles.slice(0, 5).join(", ")}…)`)
check("scan-set", forbiddenNeedles.length >= SCAN_SET_FLOORS.forbiddenNeedles, `the upstream-registry needle list holds ${forbiddenNeedles.length} endpoint(s); floor is ${SCAN_SET_FLOORS.forbiddenNeedles} — a needle dropped from this list is an upstream release lane this gate no longer looks for`)
for (const file of forbiddenFiles) {
  const text = stripComments(read(file))
  for (const [needle, what] of forbiddenNeedles) {
    check("no-upstream-registries", !text.includes(needle), `${file} references ${what} (${needle}) in executable text`)
  }
}

// ---- the model catalog the binary embeds is a file in this tree
// WHY. `build.ts` pastes this catalog into `Bun.build({define})`, a source-text substitution, so
// its bytes are inside the signed artifact; one string field of it (`npm`) is later handed to
// `npm install` + `await import()` in the process that owns the `gp_*` surface. Reading it from a
// live endpoint at build time meant the tag did not determine the release, and this gate — which
// scans for upstream infrastructure — could not see either the endpoint or the missing pin.
{
  const catalogRel = "contracts/models-catalog.json"
  const catalogAbs = path.join(forkRoot, catalogRel)
  check("catalog-pinned", existsSync(catalogAbs), `${catalogRel} is not in the tree — the build has no catalog to embed and must fail rather than fetch`)
  const generateTs = readCode("packages/opencode/script/generate.ts")
  check("catalog-pinned", generateTs.includes(`"models-catalog.json"`), "script/generate.ts no longer reads the committed catalog by name")
  check("catalog-pinned", generateTs.includes("GLASSPANE_MODELS_FETCH_LIVE"), "script/generate.ts lost the explicit opt-in marker — a live fetch must be a deliberate flag, not the default")
  if (existsSync(catalogAbs)) {
    let providers = null
    try {
      const parsed = JSON.parse(readFileSync(catalogAbs, "utf8"))
      providers = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : null
    } catch {
      providers = null
    }
    check("catalog-pinned", providers !== null && providers.length > 0, `${catalogRel} is not a non-empty JSON object of providers — an empty or malformed catalog is a build failure, not a smaller product surface`)
    check("scan-set", providers !== null && providers.length >= 200, `${catalogRel} carries ${providers === null ? "unreadable" : providers.length} provider(s); the floor is ${SCAN_SET_FLOORS.catalogProviders} — a catalog that silently lost most of its providers would still build, and the shipped product would answer for models it no longer knows`)
  }
}

// ---- the shim and the runtime install paths speak the product
const postinstall = readCode("packages/opencode/script/postinstall.mjs")
check("postinstall-identity", postinstall.includes(`\`${product.name}-\${platform}-\${arch}\``), "postinstall.mjs does not resolve the product's platform packages")
check("postinstall-identity", postinstall.includes(product.binary), "postinstall.mjs does not carry the product binary name")
// The self-heal in postinstall fetches a package and runs it. npm reads `npm_config_registry`
// (which npm exports into lifecycle scripts), the environment, `~/.npmrc` and a project
// `.npmrc`, so a spawn that names no registry downloads — and then executes — whatever bytes the
// ambient mirror chooses, with integrity self-attested by that mirror. The registry is a
// product-level fact (`product.json`), so it is asserted here rather than left to chance.
check(
  "postinstall-registry",
  postinstall.includes('"--registry"') && postinstall.includes(`"${product.registry}"`),
  `postinstall.mjs resolves the platform package without naming ${product.registry} — an ambient npmrc would decide which bytes get executed`,
)

// ---- one registry, and every npm-facing lane names it
// `product.json` carried the registry twice (`registry` and `npm.registry`) and only one of them
// was gated, so a lane reading the other could silently point at a mirror. Both fields still
// exist (docs quote the nested one), so they must agree, and the publisher — the only lane that
// *writes* — has to name it on both its reads and its publishes.
// The comparison must not be able to satisfy itself: `product.npm?.registry ?? product.registry`
// equals `product.registry` unconditionally once the nested field is deleted, so the old form
// went green by removing one of the two answers it existed to cross-check. Presence is asserted
// separately, and then equality.
check(
  "registry",
  typeof product.npm?.registry === "string" && product.npm.registry.length > 0,
  `product.json has no non-empty "npm.registry" (read ${JSON.stringify(product.npm?.registry)}) — this rule compares two declared registries, and deleting one is not making them agree`,
)
check(
  "registry",
  product.npm?.registry === product.registry,
  `product.json's npm.registry (${product.npm?.registry}) disagrees with the gated product.registry (${product.registry}) — two answers for one fact`,
)
const publishTs = readCode("packages/opencode/script/publish.ts")
check(
  "publish-registry",
  /npm view [^\n]*--registry \$\{registry\}/.test(publishTs) && /npm publish [^\n]*--registry \$\{registry\}/.test(publishTs),
  "packages/opencode/script/publish.ts consults or writes the registry without naming this product's registry",
)

// ---- the engine's method table, as the published fork carries it
// `contracts/engine-methods.json` exists because the fork's fixed-point tests need the engine's
// method list and the engine is NOT in the subtree split: a test that read `FrameCodec.swift`
// directly passed on this machine and failed in the split repo's CI on the missing file. A pinned
// copy that nobody re-derives is just a second answer waiting to be wrong, so this rule re-parses
// the Swift enum on every run and refuses any drift between it and the contract. The parser knows
// both ways Swift writes a case (`case hello, attach, act, observe` and
// `case auditUI = "audit_ui" // …`); reading one identifier per line reported an engine with no
// `attach`, `observe`, `act`, `last_evidence` or `restore`.
//
// THE BYTE-LEVEL HALF OF THAT CONTRACT. The same file carries `swiftBlob` — the git object hash
// of the Swift the table was read from — and until 2026-10-16 nothing anywhere (`*.mjs`, `*.ts`,
// `*.yml`, `*.sh`) read it: grep finds the field and zero readers. A name-only comparison re-derives
// the *list*; the blob pins the *file it came from*, which is the difference between "these 13
// strings appear in the enum" and "the enum I just parsed is the one that was recorded". Two
// engines can carry the same method names with different surrounding bytes, and the split repo's
// tests would read a table whose provenance nobody could check. So the hash is asserted here, and
// the branch where the engine is not in the checkout is a refusal, not a note: this rule printing
// "compares the contract against nothing" and exiting 0 was a control that reported its own
// absence as a pass.
{
  const contractRel = "contracts/engine-methods.json"
  const swiftRelInRepo = path.join("engine", "Sources", "GlassPaneEngine", "FrameCodec.swift")
  const swiftRel = path.join(repoRoot, swiftRelInRepo)
  const contract = existsSync(path.join(forkRoot, contractRel)) ? JSON.parse(read(contractRel)) : null
  check("engine-methods", contract !== null, `${contractRel} is missing — the fork's tests have no engine method table to read`)
  if (!existsSync(swiftRel)) {
    die(
      2,
      `${swiftRelInRepo} is absent from this checkout, so the engine method table cannot be re-derived and its recorded \`swiftBlob\` cannot be re-hashed — that is CANNOT OBSERVE, not agreement. This rule used to print a note and exit 0 over exactly this state, which is how a stale contract survives. Run it where the engine lives (the trunk repository; \`harness/glasspane-harness/contracts/engine-methods.json\` exists precisely because the split repository has no engine tree).`,
    )
  }
  if (contract) {
    // The blob the contract claims to have been read from, recomputed from the bytes on disk.
    // Same object format git uses (`blob <len>\0` + content, sha1), so it equals
    // `git hash-object <file>` for a file with no filter applied — computed here rather than
    // shelled out because the ruler must answer from the bytes it can see.
    const swiftBytes = readFileSync(swiftRel)
    const observedBlob = createHash("sha1").update(Buffer.from(`blob ${swiftBytes.length}\0`)).update(swiftBytes).digest("hex")
    const recordedBlob = String(contract.swiftBlob ?? "")
    check(
      "engine-methods",
      /^[0-9a-f]{40}$/.test(recordedBlob),
      `${contractRel} carries no 40-hex \`swiftBlob\` (${JSON.stringify(contract.swiftBlob)}) — the one byte-level tie between the shipped method table and the Swift engine is missing, so nothing here can prove the table came from the file on disk. Re-derive the contract from ${swiftRelInRepo} and record its blob.`,
    )
    check(
      "engine-methods",
      contract.source === swiftRelInRepo,
      `${contractRel} says it was read from ${JSON.stringify(contract.source)}, but this rule hashes ${swiftRelInRepo} — a blob pinned against one file and compared against another proves nothing.`,
    )
    check(
      "engine-methods",
      observedBlob === recordedBlob,
      `${contractRel} pins swiftBlob ${recordedBlob} but ${swiftRelInRepo} hashes to ${observedBlob} — the shipped method table and the Swift engine are no longer the same artifact. Re-derive the contract (methods AND blob) from the enum in the same commit as the engine change; do not edit either side to make this line match.`,
    )
    const codec = swiftBytes.toString("utf8")
    const from = codec.indexOf("public enum EngineMethod")
    const to = codec.indexOf("extension EngineMethod", from)
    check("engine-methods", from >= 0 && to > from, "FrameCodec.swift has no `public enum EngineMethod` … `extension EngineMethod` span — the table cannot be re-derived")
    const names = []
    if (from >= 0 && to > from) {
      for (const line of codec.slice(from, to).split("\n")) {
        const declared = line.match(/^\s*case\s+(.*)$/)
        if (!declared) continue
        for (const entry of declared[1].replace(/\/\/.*$/, "").split(",")) {
          const one = entry.trim()
          const wired = one.match(/^\w+\s*=\s*"([a-z_]+)"$/)
          const bare = one.match(/^([a-zA-Z]\w*)$/)
          const name = wired ? wired[1] : bare ? bare[1] : null
          if (name) names.push(name)
        }
      }
    }
    const shipped = Array.isArray(contract.methods) ? contract.methods : []
    const missing = names.filter((n) => !shipped.includes(n))
    const extra = shipped.filter((n) => !names.includes(n))
    check(
      "engine-methods",
      names.length > 0 && missing.length === 0 && extra.length === 0,
      `${contractRel} disagrees with the engine: ${missing.length} method(s) the Swift declares are absent (${missing.join(", ")}), ${extra.length} the contract names that the engine does not (${extra.join(", ")}). Re-derive it from FrameCodec.swift; do not edit the contract to match a test.`,
    )
    check(
      "scan-set",
      names.length >= 13,
      `the Swift enum yielded ${names.length} method(s) (${names.join(", ")}); this gate's floor is 13 — a parser that matches fewer case forms reports an engine with missing methods while still printing agreements. Fix the parser, do not re-derive a smaller table.`,
    )
  }
}
check(
  "publish-registry",
  readCode("packages/opencode/script/verify-published.ts").includes("const registry = product.registry"),
  "verify-published.ts no longer reads the gated product.registry — it would verify against a registry nothing pins",
)

// ---- a removed first-party capability must not keep a user-visible entry
// `product.json` lists session sharing among what this product does not have (no account, no
// cloud). `run` still advertised `--share` for it, and the call it made resolves to no route at
// all — measured 2026-10-13 against a live server: `POST /session/<id>/share` answers HTTP 200
// with the embedded web app's HTML, so nothing was printed and the run still exited 0. A flag
// that advertises a capability the product deleted is the same failure as a stub that answers
// every request: it endorses something that is not there.
check(
  "no-removed-capability-entry",
  !readCode("packages/opencode/src/cli/cmd/run.ts").includes(`option("share"`),
  'run.ts advertises --share again for a capability product.json records as removed',
)

// ---- state root + config names (product first, legacy kept)
const globalTs = read("packages/core/src/global.ts")
check("state-root", globalTs.includes(`const app = "${product.name}"`), "packages/core/src/global.ts does not use the product as the state-root name")
const configTs = read("packages/opencode/src/config/config.ts")
// The rule looks at the *candidates list*, not the whole file: a legacy name that
// survives in the global-dir loader is fine; one missing from discovery is not.
const candidatesLine = /const candidates = \[[^\]]*\]/.exec(configTs)?.[0] ?? ""
check("config-names", /opencode\.jsonc/.test(candidatesLine) && /opencode\.json/.test(candidatesLine), "config.ts discovery dropped the legacy opencode.json(c) fallback — existing checkouts would break")
check("config-names", candidatesLine.includes(`${product.name}.json`), "config.ts discovery does not accept the product's config file name first")

// ---- the repository's own project directory is the product's, and the legacy
// `.opencode` name survives only as a compatibility read in a user's project
const forkRootEntries = readdirSync(forkRoot, { withFileTypes: true }).map((e) => e.name)
check(
  "project-dir",
  forkRootEntries.includes(".glasspane-harness") === true,
  "the repo's own project directory is not `.glasspane-harness/` — the product should dogfood its own name",
)
check(
  "project-dir",
  forkRootEntries.includes(".opencode") === false,
  "a `.opencode/` directory is back at the fork root — it is upstream's dev-config name; ours is `.glasspane-harness/` (the legacy name is only a read-compat target in a user's project)",
)
const paths = stripComments(read("packages/opencode/src/config/paths.ts"))
check(
  "project-dir",
  paths.includes('".opencode"') && paths.includes('".glasspane-harness"'),
  "the legacy `.opencode` project dir is no longer probed — an existing upstream checkout must keep working",
)

// ---- macOS-only distribution: the npm side must refuse other platforms, not ship them
const platform = product.platform ?? {}
check("platform", Array.isArray(platform.os) && platform.os.length === 1 && platform.os[0] === "darwin", "product.platform.os must be exactly [darwin] — the product is macOS-only (owner decision)")
check("platform", (product.platformTargets ?? []).every((t) => t.os === "darwin"), "a non-darwin platform target is declared — macOS-only means the npm distribution is macOS-only")
check("platform", (product.install?.powershell ?? null) === null, "product.install still advertises a PowerShell one-liner — there is no Windows installer")

// ---- the one-click installers: right URLs, parse, and plan
const sh = stripComments(read("scripts/install.sh"))
// The raw "curl | bash" URL lives where the user copies it from (product.json's
// install block and the README); the script body is what executes after that.
check("installer-urls", (product.install?.curl ?? "").includes(`raw.githubusercontent.com/${product.repo}/`), "product.json install.curl does not point at the product's own raw script URL")
check("installer-urls", (product.install?.npm ?? "").includes(product.name), "product.json install.npm does not install the product package")
check("installer-urls", sh.includes("releases/download") && sh.includes(product.repo), "install.sh does not point at the product's release assets (repo + /releases/download)")
check("installer-urls", sh.includes('npm install -g --registry "$NPM_REGISTRY" "$NPM_SPEC"'), "install.sh does not install the npm package through the pinned registry (npm must be the primary lane, named registry included)")
// The npm lane used to be the weaker channel: postinstall.mjs pins --registry because a
// bare `npm install` lets ~/.npmrc / npm_config_registry pick the mirror whose bytes then
// get installed (and, for postinstall, executed) — while install.sh's primary lane named
// no registry at all. The literal here is the same product fact as postinstall's; product.json
// is its source, hence a rule and not a coincidence. The second needle keeps the honest
// state on the npm success line: the installer checks no sha256/GPG on that channel, and
// the line must say so instead of printing a bare "installed via npm".
check("installer-registry", sh.includes('NPM_REGISTRY="${GLASSPANE_HARNESS_REGISTRY:-' + product.registry + '}"'), `install.sh does not default its npm registry to product.json's ${product.registry}`)
check("installer-registry", sh.includes("sha256/GPG: not checked on this channel"), "install.sh's npm success line dropped its verification state — the channel that checks nothing must not read like one that does")
check("installer-urls", sh.includes("GlassPane engine"), "install.sh does not tell the user that gp_* needs the GlassPane engine running")
check("installer-urls", sh.includes(`REPO=\"` + product.repo + `\"`) || sh.includes(`REPO="${product.repo}"`), "install.sh REPO is not the product's repo")
check("installer-urls", existsSync(path.join(forkRoot, "scripts", "install.ps1")) === false, "a Windows installer exists — the product is macOS-only (owner decision); one that half-works is worse than none")
check("installer-syntax", (() => {
  try {
    execFileSync("sh", ["-n", path.join(forkRoot, "scripts", "install.sh")], { stdio: "pipe" })
    return true
  } catch (error) {
    problems.push(`[installer-syntax] install.sh does not parse: ${error.message.split("\n")[0]}`)
    return false
  }
})(), "install.sh failed its syntax check")
check("installer-dry-run", (() => {
  // The installer is macOS-only **by product decision** (the engine, the permission
  // model and the evidence pipeline exist only on macOS), so on any other host the
  // correct outcome is the refusal, not a plan. This rule used to demand a plan
  // unconditionally, which meant the gate could only ever pass on a Mac — and the
  // CI lane that runs it is `ubuntu-latest`, where it went red on the honest
  // refusal. Skipping the check off-platform would be the wrong fix (a skipped
  // check is how this repo's failures got invisible in the first place), so each
  // platform asserts its own documented behaviour instead:
  //
  //   darwin  → exits 0, prints the plan, names the product, says nothing installed
  //   other   → exits non-zero AND says why, naming the product (macOS-only)
  //
  // The second branch is a real assertion: an installer that failed for any other
  // reason (a syntax error, a bad path, an unset variable) would not print the
  // macOS-only sentence, so it still fails here.
  const script = path.join(forkRoot, "scripts", "install.sh")
  const isMac = process.platform === "darwin"
  try {
    const out = execFileSync("bash", [script, "--dry-run"], { stdio: "pipe", encoding: "utf8" })
    if (isMac) return out.includes(product.name) && out.includes("nothing was installed")
    // Off-platform the installer must NOT have produced a plan; producing one would
    // mean it is willing to install somewhere it has no build.
    problems.push(`[installer-dry-run] on ${process.platform} the installer produced an install plan; it is macOS-only and must refuse`)
    return false
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`
    if (isMac) {
      problems.push(`[installer-dry-run] install.sh --dry-run failed on macOS: ${error.message.split("\n")[0]}`)
      return false
    }
    // Expect the documented refusal: it names the product and says macOS-only.
    const refuses = out.includes(product.name) && /macOS-only/.test(out)
    if (!refuses) {
      problems.push(
        `[installer-dry-run] install.sh --dry-run failed on ${process.platform} without saying it is macOS-only: ` +
          `${error.message.split("\n")[0]}`,
      )
    }
    return refuses
  }
})(), "install.sh --dry-run did not behave as documented for this platform")

// ---- our own pipelines only, and attribution on disk
const wfDir = path.join(forkRoot, ".github", "workflows")
if (!existsSync(wfDir)) die(2, "the fork has no .github/workflows — cannot verify the product's pipelines")
const workflows = readdirSync(wfDir).sort()
check("workflows", workflows.length === 2 && workflows.includes("ci.yml") && workflows.includes("release.yml"), `the fork's workflows are [${workflows.join(", ")}] — expected exactly ci.yml + release.yml (upstream's 26 are gone for good)`)
const release = readFileSync(path.join(wfDir, "release.yml"), "utf8")
check("workflows", /tags:\s*\n\s*- 'v\*'/.test(release), "release.yml does not build release assets on a v* tag")
check("workflows", /publish_npm/.test(release) && /confirm/.test(release), "release.yml has no manual, confirmed npm publish gate")
check("workflows", !release.includes("anomalyco"), "release.yml references upstream infrastructure")
check("notice-license", existsSync(path.join(forkRoot, "LICENSE")), "the upstream LICENSE is missing — attribution is not optional")
const notice = existsSync(path.join(forkRoot, "NOTICE")) ? readFileSync(path.join(forkRoot, "NOTICE"), "utf8") : ""
// The pinned upstream tag has ONE source: `harness/upstream.json`. Comparing NOTICE against
// `product.upstream?.tag ?? "v1.18.32"` let the rule stay green by deleting the field — the
// fallback is a number this ruler invented, and it also decoupled the check from the pin CI
// actually clones. Presence, cross-source agreement, then the NOTICE text.
const upstreamPin = (() => {
  const f = path.join(repoRoot, "harness", "upstream.json")
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, "utf8")).tag ?? null
  } catch {
    return null
  }
})()
check("notice-license", typeof upstreamPin === "string" && upstreamPin.length > 0, `harness/upstream.json carries no readable \`tag\` (read ${JSON.stringify(upstreamPin)}) — the upstream pin is not on disk, so nothing below can be checked against it`)
check("notice-license", product.upstream?.tag === upstreamPin, `product.json declares upstream.tag ${JSON.stringify(product.upstream?.tag)} while the pin in harness/upstream.json is ${JSON.stringify(upstreamPin)} — two answers for one fact`)
check("notice-license", typeof upstreamPin === "string" && notice.includes(upstreamPin), `NOTICE does not record the pinned upstream tag (${upstreamPin})`)
check("notice-license", notice.includes("MIT"), "NOTICE does not record the upstream license")

// ---- the released tree is anchored to trunk's fork subtree
// WHY THIS IS A RULE AND NOT A LINE IN A DOC. The published repository is a
// `git subtree split` of trunk's `harness/glasspane-harness`, and until today NOTHING in this
// repository or in its CI asserted that the tree being released IS that subtree. The only place
// the equality appeared was a hand-typed line in `docs/release.md` (the
// `test "$(git rev-parse split/…)" = "$(git rev-parse HEAD:harness/glasspane-harness)"` step)
// that a human runs — or skips — at a keyboard, and SYNCLOG records it being run manually every
// release. Skipping it is not hypothetical: measured at v0.7.10, two commits (a seven-dependency
// security bump and the CODEOWNERS file) lived ONLY in the split repo, shipped in that release,
// and trunk's `main` never received them — so the next split would have silently reverted a
// security fix, and the artifact under a live version number was not reproducible from trunk at
// all. A control a person can skip is not a control (the founding rule of this whole layer).
//
// What is asserted is the anchor's SHAPE, not its wording: the step must exist in `version-check`
// (the one moment the claim can be machine-checked — after the tag is agreed, before
// `create-release` makes anything public), must fetch TRUNK rather than the split repo (fetching
// the split repo compares a tree against itself and is vacuously true), must compare a
// `harness/glasspane-harness` tree hash, and must stay a `needs:` prerequisite of the jobs that
// build and publish so the anchor cannot be orphaned into an unreachable job.
{
  const trunkRepo = String(product.glasspane?.engineRepo ?? "")
  const upstreamFile = path.join(repoRoot, "harness", "upstream.json")
  if (!trunkRepo) die(2, "product.json carries no glasspane.engineRepo — the trunk repository this release lane must be anchored to is unnamed, so the anchor cannot be checked")
  if (!existsSync(upstreamFile)) die(2, `harness/upstream.json is absent — the subtree path the released tree must equal (${forkRoot}) is not recorded anywhere readable`)
  const subtreePath = String(JSON.parse(readFileSync(upstreamFile, "utf8"))?.fork?.path ?? "")
  if (!subtreePath) die(2, "harness/upstream.json carries no fork.path — which subtree of trunk is the product?")

  const jobBlock = (text, id) => {
    const lines = text.split("\n")
    const start = lines.findIndex((l) => new RegExp(`^  ${id}:\\s*(#.*)?$`).test(l))
    if (start < 0) return null
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) if (/^  [A-Za-z][\w-]*:\s*(#.*)?$/.test(lines[i])) { end = i; break }
    return lines.slice(start, end).join("\n")
  }
  /** The `run:`/`env:` lines belonging to ONE step, from its `- name:` to the next step. */
  const stepBlock = (job, name) => {
    const lines = job.split("\n")
    const start = lines.findIndex((l) => {
      const m = l.match(/^\s*-\s+name:\s*(.*)$/)
      return m !== null && m[1].trim().replace(/^["']|["']$/g, "") === name
    })
    if (start < 0) return null
    const indent = (lines[start].match(/^\s*/) ?? [""])[0].length
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      const lead = (lines[i].match(/^\s*/) ?? [""])[0].length
      if (/^\s*-\s+/.test(lines[i]) && lead <= indent) { end = i; break }
      if (lead <= indent && /^\S/.test(lines[i])) { end = i; break }
    }
    return lines.slice(start, end).join("\n")
  }
  const needsOf = (job) => {
    const m = job?.match(/^ {4}needs:\s*(\[[^\]]*\]|[^\n#]+)/m)
    return m ? m[1].trim() : ""
  }
  // Comments carry the reason; only the env values and the run body can enforce anything.
  const executable = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")

  const ANCHOR_STEP = "The released tree must equal trunk's fork subtree"
  const versionCheck = jobBlock(release, "version-check")
  check("release-anchor", versionCheck !== null, "release.yml has no `version-check` job — the release lane lost the job the tree anchor is supposed to live in")
  const anchor = versionCheck ? stepBlock(versionCheck, ANCHOR_STEP) : null
  check(
    "release-anchor",
    anchor !== null,
    `release.yml's \`version-check\` job has no step named exactly "${ANCHOR_STEP}" — nothing in CI now asserts that the tree being released equals trunk's \`${subtreePath}\` subtree, which is the state v0.7.10 shipped in (split-only commits, trunk never told). Restore the step; do not re-add the equality as a line in docs/release.md.`,
  )
  if (anchor) {
    const body = executable(anchor)
    check("release-anchor", /git\s+fetch\b/.test(body), `"${ANCHOR_STEP}" does not run \`git fetch\` — it cannot observe trunk's tree, so it cannot compare against it`)
    check(
      "release-anchor",
      body.includes(trunkRepo),
      `"${ANCHOR_STEP}" never names the trunk repository (${trunkRepo}, from product.json -> glasspane.engineRepo) — an anchor that fetches nothing, or fetches somewhere else, proves the agreement of two unrelated things`,
    )
    check(
      "release-anchor",
      !body.includes(`github.com/${product.repo}`) && !body.includes(product.repoUrl),
      `"${ANCHOR_STEP}" names the SPLIT repository (${product.repo}) as an operand — fetching the split repo and comparing it to the split checkout is a tautology: it is true even when trunk never received the commits being shipped`,
    )
    check(
      "release-anchor",
      /FETCH_HEAD\s*:\s*["'`]?\$?\{?TRUNK_PREFIX|FETCH_HEAD:[^"'`\s]*harness\/glasspane-harness/.test(body),
      `"${ANCHOR_STEP}" does not read a \`harness/glasspane-harness\` tree hash out of FETCH_HEAD — the thing it must compare is the subtree at ${subtreePath}, not the trunk commit itself`,
    )
    check(
      "release-anchor",
      /rev-parse[^\n]*(\^\{tree\}|:\S+)/.test(body) && /\[\s*"?\$\w+"?\s*=\s*"?\$\w+"?\s*\]/.test(body),
      `"${ANCHOR_STEP}" does not compare two tree hashes (it must \`git rev-parse\` both the released tree and trunk's subtree, then test them for equality) — echoing a hash is not asserting agreement`,
    )
    check(
      "release-anchor",
      /exit\s+1/.test(body),
      `"${ANCHOR_STEP}" cannot fail: with no \`exit 1\` on the mismatch branch a divergent artifact still passes the step, which is the whole defect this step exists to close`,
    )
  }
  // An anchor nobody depends on is decoration: `version-check` has to gate both the job that
  // creates/publishes the release and the job that builds the binaries.
  for (const gatee of ["create-release", "binaries"]) {
    const job = jobBlock(release, gatee)
    check("release-anchor", job !== null, `release.yml has no \`${gatee}\` job — the anchor's dependency graph changed under it`)
    check(
      "release-anchor",
      job !== null && needsOf(job).includes("version-check"),
      `\`${gatee}\` does not list \`version-check\` in its \`needs:\` (it says ${JSON.stringify(needsOf(job))}) — the tree anchor is orphaned: the release can be created and the binaries built without ever proving the artifact equals trunk's ${subtreePath} subtree`,
    )
  }
}

// ---- postinstall identity, read before the verdict is written
const shimText = readCode("packages/opencode/bin/glasspane-harness")
check("postinstall-identity", shimText.includes(`"${product.name}-" + platform`), "bin shim does not resolve the product's platform packages")
check("postinstall-identity", shimText.includes(`"${product.binary}"`), "bin shim does not carry the product binary name")
check("runtime-package-names", readCode("packages/opencode/src/installation/index.ts").includes(`${product.name}@`), "installation/index.ts does not upgrade the product package")
check("runtime-package-names", readCode("packages/opencode/src/cli/cmd/uninstall.ts").includes(`"uninstall", "-g", "${product.name}"`), "uninstall.ts does not uninstall the product package")

// ---- the CLI's own words name the product's environment variables, and one file resolves them
// Every variable gained a name under the product's own prefix, read first, with the upstream
// name kept as a legacy fallback; and the resolution point is exactly ONE —
// packages/core/src/flag/flag.ts's read() (product.json -> privateSurface.envVars). Reading
// the fallback is code; PRINTING it is a product claim. Four strings did: `serve` and `web`
// warned about the legacy server password, and `attach` / `run` --help named both credentials
// as the default source. No ruler had ever looked at a string literal under src/cli/cmd/, so
// the fix could have come back silently — this is the reader. It scans literals only, which is
// why the legitimate compat reads (Flag.<legacy key>, Config.string("<legacy key>")) stay code
// and do not trip it.
//
// THREE BLIND SPOTS THIS READER HAD, all of them on the same lane:
//   - it listed `src/cli/cmd/*.ts` NON-recursively, so `run/` and `debug/` — 39 more files,
//     including the one that prints the `--help` body — were never opened;
//   - its literal matcher could not cross a newline, so a multi-line template literal (exactly
//     how help text is written) could not be matched even in a file it did open;
//   - the shipped launcher was not in the discovery set at all, so when it started reading one
//     product variable by its legacy name directly — `process.env.<LEGACY>_BIN_PATH`, bypassing
//     read() — the product's own name was silently ignored by the thing users actually run, and
//     nothing said so. Both directions are checked now: a raw legacy read outside the one
//     resolver must be the resolver's own rule (product name first), and the launcher must
//     really name the product's variable.
// The two prefixes are read out of product.json rather than spelled in here, so this file
// cannot become a second place the names live.
const upstreamName = (product.upstream?.repo ?? "").split("/").pop() ?? ""
const legacyPrefix = `${upstreamName.toUpperCase()}_`
const productPrefix = `${String(product.name).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`
const cliDir = "packages/opencode/src/cli/cmd"
const launcher = "packages/opencode/bin/glasspane-harness"
const flagFile = "packages/core/src/flag/flag.ts"

function tsFilesUnder(rel) {
  const found = []
  for (const entry of readdirSync(path.join(forkRoot, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = `${rel}/${entry.name}`
    if (entry.isDirectory()) found.push(...tsFilesUnder(child))
    else if (entry.name.endsWith(".ts")) found.push(child)
  }
  return found
}

// A single- or double-quoted literal cannot hold a raw newline; a template literal can, and
// `help` bodies are written that way — the matcher this replaces stopped at the first line.
const literalPattern = /(["'])(?:\\\1.|(?!\1)[^\\\n])*\1|`(?:\\[\s\S]|[^`\\])*`/g
const upstreamHost = upstreamName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const printedLegacy = new RegExp(`(defaults to|Warning|is not set)[\\s\\S]*${legacyPrefix}[A-Z0-9_]+`)
const printedUpstream = new RegExp(`(defaults to|Warning|is not set)[\\s\\S]*(${upstreamHost}\\.ai|@${upstreamHost}-ai/)`)
// `process.env.<LEGACY>…` and `process.env["<LEGACY>…"]` are resolutions. A property read off
// `Flag`, or a key handed to `Flag.read`, is not — those go through the one resolver.
const rawLegacyRead = new RegExp(
  `process\\.env\\.${legacyPrefix}[A-Z0-9_]+|process\\.env\\[\\s*["'\`]${legacyPrefix}[A-Z0-9_]+["'\`]`,
  "g",
)

const envDiscovery = [...tsFilesUnder(cliDir), launcher]
// Both halves of this set are pinned, and this is the section the pin matters most: the loop
// below contributes two agreements per file, so a `cliDir` that stops resolving (a moved
// command tree, a recursive walk that returns nothing) used to shrink the lane's printed
// agreement count from 132+ to 2 and still exit 0 — the shape this file has been caught in
// twice. The launcher is named separately because it was once missing from the set entirely,
// which is how the shipped binary ended up reading a product variable by its legacy name.
check("scan-set", envDiscovery.length - 1 >= SCAN_SET_FLOORS.cliCmdFiles, `the recursive walk of ${cliDir} found ${envDiscovery.length - 1} .ts file(s); floor is ${SCAN_SET_FLOORS.cliCmdFiles} — the cli-text rule below asks each one, so a shorter walk means fewer questions, not a cleaner CLI (a set that empties is this lane reporting agreement about nothing)`)
check("scan-set", envDiscovery.length >= SCAN_SET_FLOORS.envDiscovery && envDiscovery.includes(launcher), `the env-resolution scan set holds ${envDiscovery.length} entr(ies) including the launcher=${envDiscovery.includes(launcher)}; floor is ${SCAN_SET_FLOORS.envDiscovery} (CLI files + ${launcher}) — without the launcher the shipped binary's own env reads are unmeasured`)
for (const rel of envDiscovery) {
  const code = readCode(rel)
  const literal = (code.match(literalPattern) ?? []).find(
    (s) => printedLegacy.test(s) || printedUpstream.test(s),
  )
  check(
    "cli-text-names-product-env",
    !literal,
    `${rel} shows the user ${JSON.stringify((literal ?? "").slice(0, 78))} — name the product's own variable; the upstream one is a fallback that gets read, not printed`,
  )
}

// Any raw legacy-name resolution outside flag.ts has to be the same rule flag.ts implements:
// product name read first, legacy name as the fallback. One file may do that — the launcher,
// which ships standalone and cannot import the resolver — and it is named below.
for (const rel of envDiscovery) {
  if (rel === flagFile) continue
  const code = readCode(rel)
  for (const read of code.matchAll(rawLegacyRead)) {
    const name = (read[0].match(new RegExp(`${legacyPrefix}[A-Z0-9_]+`)) ?? [""])[0]
    const twin = productPrefix + name.slice(legacyPrefix.length)
    check(
      "env-resolution-point",
      rel === launcher && code.indexOf(twin) !== -1 && code.indexOf(twin) < read.index,
      `${rel} resolves ${name} where only ${flagFile} may: the product's own name (${twin}) is ${code.includes(twin) ? "read after the legacy one, so an exported product setting is ignored" : "never read at all"}. product.json -> privateSurface.envVars says the resolution point is exactly one`,
    )
  }
}
check(
  "env-resolution-point",
  readCode(launcher).includes(`${productPrefix}BIN_PATH`),
  `${launcher} does not name the product's own BIN_PATH variable, so an exported ${productPrefix}BIN_PATH is ignored by the shipped launcher`,
)

// ---- every selftest that guards a ruler is actually run by something
// WHY. A test nobody runs is worse than no test: it is evidence that cannot be re-made, and it
// reads as "someone checked this". The fork's own `ci.yml` says its installer-selftest job exists
// to prevent exactly that failure ("测试写而无人跑"), and the same shape was live in this
// directory: measured 2026-10-16, `ref-batch-selftest.mjs`, `kernel-pin-selftest.mjs` and
// `verify-published-selftest.sh` were referenced by no workflow and no package.json script — the
// only greppable hits were README/SYNCLOG prose, which is how they came to be described as
// passing in batch notes nobody re-ran. `probe-lane-selftest.sh` and `installer-selftest.sh` are
// the two that ARE wired, and they are listed here too so the set does not quietly shrink.
//
// The corpus is the runnable places ONLY (workflow steps and package.json scripts): prose in
// harness/README.md mentioning a test must never satisfy this rule, because mentioning is not
// running. Fixing a red here means adding a step to a lane, not adding a sentence to a doc.
const SELFTESTS = [
  "harness/tools/ref-batch-selftest.mjs",
  "harness/tools/kernel-pin-selftest.mjs",
  "harness/tools/verify-published-selftest.sh",
  "harness/tools/probe-lane-selftest.sh",
  "harness/tools/release-artifact-selftest.mjs",
  "harness/tools/rulers-selftest.mjs",
]
{
  const wiringRoots = [path.join(repoRoot, ".github", "workflows"), path.join(forkRoot, ".github", "workflows")]
  const runnable = []
  for (const dir of wiringRoots) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).sort()) {
      // A YAML comment is prose. The corpus must be the executable part of the lane or the rule
      // "a selftest nobody runs is not a control" is satisfied by leaving the sentence behind and
      // deleting the step — measured here: `ci.yml` holds a comment naming
      // `verify-published-selftest.sh` 40 lines above the step that actually runs it.
      if (/\.ya?ml$/.test(f)) {
        const body = readFileSync(path.join(dir, f), "utf8")
        runnable.push(`${path.relative(repoRoot, path.join(dir, f))}=${body.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n")}`)
      }
    }
  }
  for (const rel of ["package.json", "harness/glasspane-harness/package.json"]) {
    const abs = path.join(repoRoot, rel)
    if (!existsSync(abs)) continue
    const scripts = JSON.parse(readFileSync(abs, "utf8")).scripts
    // Only the SCRIPT VALUES count as a runner. Serializing the whole manifest would let a
    // `"description"` or a dependency name satisfy the rule — which is the "mentioned ≠ run"
    // mistake wearing a JSON coat.
    runnable.push(`${rel}=${JSON.stringify(scripts ?? {})}`)
  }
  const corpus = runnable.join("\n")
  check("scan-set", runnable.length >= SCAN_SET_FLOORS.workflows, `the selftest-wiring scan read ${runnable.length} runner file(s); floor is ${SCAN_SET_FLOORS.workflows} (root + fork workflows, root + fork package.json scripts) — a workflow directory that stops resolving turns every wiring assertion below into "not referenced" noise, so name the scan set first`)
  for (const rel of SELFTESTS) {
    const abs = path.join(repoRoot, rel)
    check("selftest-wired", existsSync(abs), `${rel} is not in the tree — a ruler's fixed-point test that was deleted still has a lane that is believed to run it`)
    check(
      "selftest-wired",
      corpus.includes(path.basename(rel)),
      `${rel} is referenced by NO workflow step and NO package.json script in this repository — a selftest nobody runs cannot go red, so it is not a control (see 闸自己被验过吗 in harness/README.md). Wire it: add a step to .github/workflows/ci.yml's \`harness-rulers\` job (or the fork's ci.yml for anything that must run inside the subtree), then this rule is satisfied by the running, not by a sentence in a doc.`,
    )
  }
}

// The report and the exit are the LAST thing this script does, and there is exactly one
// of each. Four assertions used to sit below both of them: they still ran, still pushed
// into `problems`, and could no longer change anything — the lane printed
// "pipelines agree" and exited 0 with a real disagreement on the books. This is the
// second time this file has been caught that way (the first was found because the
// agreement count went 83 → 86), so the shape of the fix is "one decision point, at the
// bottom", not "remember to put new checks above line N".
//
// The count itself is now asserted, at a floor: every discovery set above is pinned
// individually, and this is the net that catches a future rule being deleted outright
// (including by this file's own editors). Growth is expected and free; a shrink is the
// lane saying less than it used to, which is the one thing a green printout must not mean.
const AGREEMENT_FLOOR = 6351
check("agreement-count", ok.length + problems.length >= AGREEMENT_FLOOR, `this run asked ${ok.length + problems.length} question(s) of the product surface; the floor is ${AGREEMENT_FLOOR} — a smaller number means a rule or a scan set left this file, and "fewer agreements" is how every silent narrowing in this lane has historically looked (83 → 86 was caught by exactly this comparison). Fix the scan; do not lower the floor.`)
console.log(`product-surface — ${ok.length} agreement(s) held, ${problems.length} problem(s)`)
for (const p of problems) console.error(`  ✗ ${p}`)
if (problems.length > 0) {
  console.error("product-surface: the product's parts do not agree with product.json.")
  console.error("  Fix the named file (product.json is the truth), or change product.json deliberately and re-run.")
  process.exit(1)
}
console.log(`product-surface: ${product.name}@${product.version} — manifest, build, publish, installers and pipelines agree`)
