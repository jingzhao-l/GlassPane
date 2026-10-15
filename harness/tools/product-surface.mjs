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
 *
 * MODES
 *   --check (default)  all rules must hold
 *   (no --record: this is an agreement, not a number to baseline. If a rule is
 *   wrong, fix the rule in review — there is nothing to "record over")
 *
 * Exit codes: 0 agree, 1 disagree (named rule + file), 2 cannot measure.
 */
import { execFileSync } from "node:child_process"
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

// ---- manifest agreement
check("manifest-name", manifest.name === product.name, `package.json name "${manifest.name}" != product.json name "${product.name}"`)
check("manifest-version", manifest.version === product.version, `package.json version ${manifest.version} != product.json version ${product.version}`)
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
const forbiddenFiles = [
  "packages/opencode/script/publish.ts",
  "packages/opencode/script/build.ts",
  "packages/opencode/script/postinstall.mjs",
  "packages/opencode/src/installation/index.ts",
  "packages/opencode/src/cli/cmd/uninstall.ts",
  "packages/opencode/bin/glasspane-harness",
  "scripts/install.sh",
]
/** Comments carry the record of what was removed; only code can still reach it. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1").replace(/^\s*#.*$/gm, "")
}
for (const file of forbiddenFiles) {
  const text = stripComments(read(file))
  for (const [needle, what] of forbidden) {
    check("no-upstream-registries", !text.includes(needle), `${file} references ${what} (${needle}) in executable text`)
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
check(
  "registry",
  (product.npm?.registry ?? product.registry) === product.registry,
  `product.json's npm.registry (${product.npm?.registry}) disagrees with the gated product.registry (${product.registry}) — two answers for one fact`,
)
const publishTs = readCode("packages/opencode/script/publish.ts")
check(
  "publish-registry",
  /npm view [^\n]*--registry \$\{registry\}/.test(publishTs) && /npm publish [^\n]*--registry \$\{registry\}/.test(publishTs),
  "packages/opencode/script/publish.ts consults or writes the registry without naming this product's registry",
)
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
check("notice-license", notice.includes(product.upstream?.tag ?? "v1.18.32"), "NOTICE does not record the pinned upstream tag")
check("notice-license", notice.includes("MIT"), "NOTICE does not record the upstream license")

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

// The report and the exit are the LAST thing this script does, and there is exactly one
// of each. Four assertions used to sit below both of them: they still ran, still pushed
// into `problems`, and could no longer change anything — the lane printed
// "pipelines agree" and exited 0 with a real disagreement on the books. This is the
// second time this file has been caught that way (the first was found because the
// agreement count went 83 → 86), so the shape of the fix is "one decision point, at the
// bottom", not "remember to put new checks above line N".
console.log(`product-surface — ${ok.length} agreement(s) held, ${problems.length} problem(s)`)
for (const p of problems) console.error(`  ✗ ${p}`)
if (problems.length > 0) {
  console.error("product-surface: the product's parts do not agree with product.json.")
  console.error("  Fix the named file (product.json is the truth), or change product.json deliberately and re-run.")
  process.exit(1)
}
console.log(`product-surface: ${product.name}@${product.version} — manifest, build, publish, installers and pipelines agree`)
