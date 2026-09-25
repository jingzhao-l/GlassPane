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
import { existsSync, readFileSync } from "node:fs"
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
function has(rel, needle) {
  return read(rel).includes(needle)
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
const postinstall = read("packages/opencode/script/postinstall.mjs")
check("postinstall-identity", postinstall.includes(`\`${product.name}-\${platform}-\${arch}\``), "postinstall.mjs does not resolve the product's platform packages")
check("postinstall-identity", postinstall.includes(product.binary), "postinstall.mjs does not carry the product binary name")

// ---- state root + config names (product first, legacy kept)
const globalTs = read("packages/core/src/global.ts")
check("state-root", globalTs.includes(`const app = "${product.name}"`), "packages/core/src/global.ts does not use the product as the state-root name")
const configTs = read("packages/opencode/src/config/config.ts")
// The rule looks at the *candidates list*, not the whole file: a legacy name that
// survives in the global-dir loader is fine; one missing from discovery is not.
const candidatesLine = /const candidates = \[[^\]]*\]/.exec(configTs)?.[0] ?? ""
check("config-names", /opencode\.jsonc/.test(candidatesLine) && /opencode\.json/.test(candidatesLine), "config.ts discovery dropped the legacy opencode.json(c) fallback — existing checkouts would break")
check("config-names", candidatesLine.includes(`${product.name}.json`), "config.ts discovery does not accept the product's config file name first")

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
check("installer-urls", sh.includes(`npm install -g "$NPM_SPEC"`), "install.sh does not install the npm package (npm must be the primary lane)")
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
  try {
    const out = execFileSync("bash", [path.join(forkRoot, "scripts", "install.sh"), "--dry-run"], { stdio: "pipe", encoding: "utf8" })
    return out.includes(product.name) && out.includes("nothing was installed")
  } catch (error) {
    problems.push(`[installer-dry-run] install.sh --dry-run failed: ${error.message.split("\n")[0]}`)
    return false
  }
})(), "install.sh --dry-run did not produce a plan naming the product")

// ---- our own pipelines only, and attribution on disk
const wfDir = path.join(forkRoot, ".github", "workflows")
if (!existsSync(wfDir)) die(2, "the fork has no .github/workflows — cannot verify the product's pipelines")
const { readdirSync } = await import("node:fs")
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

// ---- report
console.log(`product-surface — ${ok.length} agreement(s) held, ${problems.length} problem(s)`)
for (const p of problems) console.error(`  ✗ ${p}`)
if (problems.length > 0) {
  console.error("product-surface: the product's parts do not agree with product.json.")
  console.error("  Fix the named file (product.json is the truth), or change product.json deliberately and re-run.")
  process.exit(1)
}
console.log(`product-surface: ${product.name}@${product.version} — manifest, build, publish, installers and pipelines agree`)

const shim = read("packages/opencode/bin/glasspane-harness")
check("postinstall-identity", shim.includes(`"${product.name}-" + platform`), "bin shim does not resolve the product's platform packages")
check("postinstall-identity", shim.includes(`"${product.binary}"`), "bin shim does not carry the product binary name")
check("runtime-package-names", has("packages/opencode/src/installation/index.ts", `${product.name}@`), "installation/index.ts does not upgrade the product package")
check("runtime-package-names", has("packages/opencode/src/cli/cmd/uninstall.ts", `"uninstall", "-g", "${product.name}"`), "uninstall.ts does not uninstall the product package")
