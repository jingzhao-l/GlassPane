#!/usr/bin/env node
/**
 * brand-surface.mjs — the brand ratchet: the product is glasspane-harness, and
 * the tree is a monitor of that fact.
 *
 * WHY. 私有化批次 A 把 9 处产品身份改成了 glasspane-harness，B 用 product-surface
 * 钉住了它们**彼此一致**。但"一致"不等于"是产品"：一致地叫 `glasspane-harness`，
 * 旁边照样可以长出一句 `npm install -g opencode-ai`、一个 `opencode.ai/install`
 * 自升级、或 README 里一行把用户叫去 `opencode` 启动。品牌腐烂的失败模式全部
 * 是**没人发现**：安装器照跑，只是装错了名字；文档照读，只是叫错了人。
 *
 * CALIBER (recorded in the golden so the check is reproducible):
 *   product files   the product's own distribution + user-facing runtime surface
 *                   (product.json, package.json, bin shim, build/publish/postinstall,
 *                   installers, installation/auth/mdns/global, the CLI command
 *                   strings, the TUI theme + clientInfo + upsell switch)
 *   docs            README.md / README.zh-CN.md — the two a user reads first
 *   lineage count   every case-insensitive "opencode" occurrence across the fork's
 *                   tracked text (minus node_modules/artifacts/.git and the
 *                   vendored kernel mirror, which kernel-vendor.mjs owns)
 *
 * RULES (zero-tolerance on product files unless the golden says otherwise):
 *   upstream-npm-name        the string "opencode-ai" as a package (dist, install,
 *                            upgrade, uninstall)
 *   upstream-platform-package  "opencode-<os>-<arch>" platform package names
 *   upstream-registry        ghcr.io/anomalyco, anomalyco/homebrew-tap,
 *                            aur.archlinux.org, opencode.ai/install
 *   upstream-in-user-text    a user-facing string literal (describe/console/prompt/
 *                            clientInfo/theme/auth default/mDNS) that says
 *                            "opencode" — internal identifiers (@opencode-ai/*,
 *                            OPENCODE_* env, protocol names) are bloodline and stay
 *   doc-line-without-lineage  every "opencode" in the two READMEs must sit on a line
 *                            that also says fork / upstream / anomalyco / MIT /
 *                            上游 / 血缘 — an attribution line, not a product claim
 *   lineage-growth           the global occurrence count may shrink, never grow
 *
 * MODES
 *   --record  write harness/contracts/brand-surface.json (the baseline)
 *   --check   fail on any unrecorded hit or lineage growth, or if nothing was scanned
 *
 * This is a ratchet: a legitimate new hit must be recorded in the same commit and
 * is then visible in review. Removing hits is always allowed.
 *
 * Exit codes: 0 ok, 1 drift, 2 cannot measure.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..")
const forkRoot = path.join(repoRoot, "harness", "glasspane-harness")
const goldenFile = path.join(repoRoot, "harness", "contracts", "brand-surface.json")
const mode = process.argv.includes("--record") ? "record" : "check"

const PRODUCT_FILES = [
  // distribution identity
  "product.json",
  "packages/opencode/package.json",
  "packages/opencode/bin/glasspane-harness",
  "packages/opencode/script/build.ts",
  "packages/opencode/script/publish.ts",
  "packages/opencode/script/postinstall.mjs",
  "scripts/install.sh",
  // user-facing runtime
  "packages/core/src/global.ts",
  "packages/opencode/src/installation/index.ts",
  "packages/opencode/src/server/auth.ts",
  "packages/opencode/src/server/mdns.ts",
  "packages/opencode/src/cli/cmd/upgrade.ts",
  "packages/opencode/src/cli/cmd/uninstall.ts",
  "packages/opencode/src/cli/cmd/serve.ts",
  "packages/opencode/src/cli/cmd/tui.ts",
  "packages/opencode/src/cli/cmd/attach.ts",
  "packages/opencode/src/cli/cmd/run.ts",
  "packages/opencode/src/cli/cmd/pr.ts",
  "packages/opencode/src/cli/cmd/providers.ts",
  "packages/opencode/src/cli/cmd/web.ts",
  "packages/opencode/src/cli/cmd/debug/index.ts",
  "packages/tui/src/context/theme.tsx",
  "packages/tui/src/context/editor.ts",
  "packages/tui/src/routes/session/index.tsx",
]
const DOC_FILES = ["README.md", "README.zh-CN.md"]

const RULES = [
  {
    id: "upstream-npm-name",
    // The upstream npm *package* name in a product file, quoted or not — but NOT
    // the `@opencode-ai/*` workspace scopes, which are kept bloodline on purpose
    // (product.json → upstream.note). The control history: the quoted-only form
    // let an unquoted `npm i -g opencode-ai` through; the unanchored form then bit
    // the kept scopes. Preceded-by-@ / part-of-identifier is the honest middle.
    count: (text) => occ(text, /(^|[^@\w-])opencode-ai/g),
    why: "the upstream npm package name is not installable as *this* product; a user following it gets opencode (@opencode-ai/* workspace scopes are kept bloodline)",
  },
  {
    id: "upstream-platform-package",
    // Covers both the finished name (opencode-darwin-arm64) and the template form
    // (opencode-${platform}-${arch}) that build.ts/postinstall.mjs interpolate.
    count: (text) => occ(text, /opencode-\$\{|opencode-(darwin|linux|win32|windows)(?:-|["'`]|$)/g),
    why: "platform packages are named after the product (product.json → platformPackage)",
  },
  {
    id: "upstream-registry",
    count: (text) => occ(text, /ghcr\.io\/anomalyco|anomalyco\/homebrew-tap|aur\.archlinux\.org|opencode\.ai\/install/g),
    why: "those endpoints belong to someone else's release; touching them is a push into a stranger's account",
  },
  {
    id: "upstream-in-user-text",
    count: (text) =>
      occ(
        text,
        /(?:describe\s*:\s*"|console\.(?:log|error|warn)\(\s*`|console\.(?:log|error|warn)\(\s*"|prompts\.log\.\w+\(\s*`|clientInfo\s*:\s*\{\s*name\s*:\s*"|active\s*:\s*"|withDefault\(\s*"|const name = `opencode)[^\n]*\bopencode\b/g,
      ),
    why: "a user-facing string that says opencode is a product claim; internal identifiers are bloodline, strings are identity",
  },
]
// A doc line may say "opencode" when it is doing lineage work: naming the fork,
// the upstream, the license, or a *path* inside the fork (the CLI package still
// lives at packages/opencode — a path is not a product claim). Everything else on
// a line that says "opencode" is the gate's business.
const LINEAGE_LINE = /fork|upstream|anomalyco|sst\/opencode|MIT|上游|血缘|派生|packages\/opencode|@opencode-ai\//i
const occ = (text, re) => (text.match(re) ?? []).length

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/^\s*#(?!\!)/gm, "")
}

/** The fork's own lineage documents. They are where the bloodline story lives
 *  (FORK.md, SYNCLOG.md, the READMEs, NOTICE, upstream's AGENTS/CONTEXT/
 *  CONTRIBUTING) — counting their prose would make the lineage ratchet punish
 *  honest documentation, so they are out of the code-lineage counter. Their
 *  *claims* are still governed: the two READMEs go through the line rule above. */
const LINEAGE_DOCS = new Set([
  "FORK.md",
  "SYNCLOG.md",
  "README.md",
  "README.zh-CN.md",
  "NOTICE",
  "AGENTS.md",
  "CONTEXT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "STATS.md",
])

/** Every tracked text file under the fork, minus build output, deps, the
 *  vendored kernel mirror (kernel-vendor.mjs owns that copy's identity) and the
 *  lineage documents above. */
function forkTextFiles(dir = forkRoot, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "artifacts" || entry === ".git" || entry === "dist") continue
    if (dir === forkRoot && LINEAGE_DOCS.has(entry)) continue
    const abs = path.join(dir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (path.join(dir, entry) === path.join(forkRoot, "packages", "opencode", "vendor")) continue
      forkTextFiles(abs, out)
      continue
    }
    if (/\.(ts|tsx|mjs|js|json|md|sh|ps1|yml|yaml|txt|toml|nix|lock)$/.test(entry)) out.push(abs)
  }
  return out
}

function scan() {
  const hits = []
  for (const rel of PRODUCT_FILES) {
    const abs = path.join(forkRoot, rel)
    if (!existsSync(abs)) {
      hits.push({ file: rel, rule: "missing-product-file", count: 1 })
      continue
    }
    const code = stripComments(readFileSync(abs, "utf8"))
    for (const rule of RULES) {
      const count = rule.count(code)
      if (count > 0) hits.push({ file: rel, rule: rule.id, count })
    }
  }
  // docs: every occurrence must live on an attribution line
  for (const rel of DOC_FILES) {
    const abs = path.join(forkRoot, rel)
    if (!existsSync(abs)) {
      hits.push({ file: rel, rule: "missing-product-file", count: 1 })
      continue
    }
    const lines = readFileSync(abs, "utf8").split("\n")
    lines.forEach((line, i) => {
      if (!/opencode/i.test(line)) return
      if (LINEAGE_LINE.test(line)) return
      hits.push({ file: `${rel}:${i + 1}`, rule: "doc-line-without-lineage", count: 1 })
    })
  }
  // lineage counter across the whole fork
  const files = forkTextFiles()
  let occurrences = 0
  for (const abs of files) {
    occurrences += (readFileSync(abs, "utf8").match(/opencode/gi) ?? []).length
  }
  return { hits, lineage: { occurrences, filesScanned: files.length } }
}

const observed = {
  observedAt: new Date().toISOString().slice(0, 10),
  source: "私有化批次 A/B 之后的产品面（产品身份 = glasspane-harness）",
  rules: [...RULES.map((r) => ({ id: r.id, why: r.why })), { id: "doc-line-without-lineage", why: "a README line that says opencode must also say fork/upstream/anomalyco/MIT/上游/血缘" }],
  productFiles: PRODUCT_FILES.length,
  docFiles: DOC_FILES,
  ...scan(),
}

console.log(`brand-surface — ${observed.productFiles} product file(s) + ${DOC_FILES.length} doc(s); ${observed.hits.length} hit(s); lineage ${observed.lineage.occurrences} occurrence(s) across ${observed.lineage.filesScanned} file(s)`)
for (const hit of observed.hits) console.log(`    ${hit.rule} ×${hit.count}  ${hit.file}`)

if (mode === "record") {
  mkdirSync(path.dirname(goldenFile), { recursive: true })
  writeFileSync(goldenFile, JSON.stringify(observed, null, 2) + "\n")
  console.log(`recorded -> ${path.relative(repoRoot, goldenFile)}`)
  process.exit(0)
}

if (!existsSync(goldenFile)) {
  console.error("brand-surface: no golden — run with --record and commit it with the change it describes")
  process.exit(2)
}
const golden = JSON.parse(readFileSync(goldenFile, "utf8"))
const problems = []
for (const hit of observed.hits) {
  const prior = golden.hits?.find((h) => h.file === hit.file && h.rule === hit.rule)
  if (!prior) problems.push(`${hit.file}: ${hit.rule} ×${hit.count} is new (no baseline)`)
  else if (hit.count > prior.count) problems.push(`${hit.file}: ${hit.rule} grew ${prior.count} → ${hit.count}`)
}
if (observed.lineage.occurrences > golden.lineage.occurrences) {
  problems.push(
    `lineage occurrences grew ${golden.lineage.occurrences} → ${observed.lineage.occurrences} (bloodline names may shrink, never multiply)`,
  )
}
if (observed.lineage.filesScanned === 0) {
  console.error("brand-surface: scanned zero files — refusing to report success")
  process.exit(2)
}
if (problems.length > 0) {
  console.error(`brand-surface: ${problems.length} drift(s):`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log(`brand-surface: no unrecorded brand drift; lineage ${observed.lineage.occurrences} (baseline ${golden.lineage.occurrences})`)

