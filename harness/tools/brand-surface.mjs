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
 *   lineage-coverage         the file count the occurrences are summed over is stated
 *                            every run; a SHRINK is drift (a subtree leaving the tree
 *                            lowers the sum without any branding being fixed), growth
 *                            is stated and allowed
 *   first-party-gateway      no shipped code may offer, wire-identify as, or link
 *                            to opencode's own paid cloud (`opencode`/`opencode-go`
 *                            providers, "opencodeZen" copy, opencode.ai/zen)
 *   wire-identity            the headers we send to third-party providers
 *                            (X-Title, X-Source, originator, User-Agent) name this
 *                            product, not the upstream project
 *   foreign-schema-write     we never write a third party's `$schema` URL into a
 *                            file the user edits (opencode.ai/config.json)
 *   product-file-name        the user's own files are named for the product:
 *                            glasspane-harness.db / glasspane-harness.log, and the
 *                            mDNS default is the product's domain
 *   removed-tree             an upstream tree this product deleted (console, web,
 *                            stats, enterprise, the docs site, artifacts/, nix/,
 *                            infra/, install/, sdks/vscode, .vscode/) does not
 *                            come back
 *
 * MODES
 *   --record  write harness/contracts/brand-surface.json (the baseline). Refuses over a
 *             `missing-product-file` — a file the run could not read must not be
 *             stamped as a green baseline — unless the separate, explicit
 *             --ack-missing-product-file is passed, which records the hole and prints
 *             it every later run.
 *   --check   fail on any unrecorded hit, lineage growth, or a shrink of the scanned
 *             coverage; exit 2 if nothing was scanned
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
  // Added 2026-09-28 after two leaks were found *outside* this list: the session
  // epilogue printed a hardcoded `opencode -s <id>` and the provider dialog kept a
  // dead `opencode:` key. Both are user-facing and both shipped, while this
  // ratchet reported "0 hits" — because a file that is not on the list is not
  // scanned, and "not scanned" is indistinguishable from "clean". The two files
  // below are the ones a user sees on exit and on the provider picker.
  "packages/tui/src/util/presentation.ts",
  "packages/tui/src/component/dialog-provider.tsx",
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
  // ---- rules that keep the private-isation from regressing (2026-09-26 batch) ----
  const SHIPPED_SRC = [
    "packages/opencode/src",
    "packages/core/src",
    "packages/tui/src",
    "packages/app/src",
    "packages/server/src",
  ]
  // Files where the upstream identifier is the *subject* rather than the product's
  // own name: the code that migrates away from it, or that still accepts it. Each
  // entry is a decision, not a hole — a new one has to be argued for in review.
  const LEGACY_NAME_ALLOWANCE = [
    "packages/core/src/database/database.ts", // renames opencode.db on first run
    "packages/opencode/src/config/config.ts", // reads the legacy project config name
    "packages/opencode/src/config/tui-migrate.ts", // migrates the legacy tui config
    "packages/tui/src/context/theme.tsx", // migrates a stored upstream theme id
  ]
  const shippedFiles = []
  const walkSrc = (dir) => {
    if (!existsSync(path.join(forkRoot, dir))) return
    for (const entry of readdirSync(path.join(forkRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walkSrc(rel)
      else if (/\.(ts|tsx)$/.test(entry.name)) shippedFiles.push(rel)
    }
  }
  SHIPPED_SRC.forEach(walkSrc)
  const readShipped = (rel) => readFileSync(path.join(forkRoot, rel), "utf8")
  for (const rel of shippedFiles) {
    // Comments are stripped first: a `[gp]` note that *explains* the removal quotes
    // the old name on purpose, and a rule that flagged its own explanation would be
    // a rule nobody could keep green.
    const text = stripComments(readShipped(rel))
    for (const [rule, re, why] of [
      [
        "first-party-gateway",
        /["'`](?:opencode|opencode-go|opencodeZen|opencode\.ai\/zen)["'`]|dialog\.provider\.opencode|provider\.connect\.opencodeZen/,
        "a first-party gateway surface came back (provider id, upsell copy or a link to the paid cloud)",
      ],
      [
        "wire-identity",
        /["'`](?:X-Title|x-title|X-Source|X-Cerebras-3rd-Party-Integration)["'`]\s*:\s*["'`]opencode["'`]|(?:originator|User-Agent)\s*:\s*[`"']opencode\//,
        "a request header still identifies us to third-party providers as opencode",
      ],
      [
        "foreign-schema-write",
        /\$schema["'`]?\s*[:=]\s*["'`]https:\/\/opencode\.ai\/(?:config|tui|theme)\.json/,
        "a third party's schema URL is written into a file the user edits",
      ],
      [
        "product-file-name",
        // The legacy database name is allowed in exactly one place: the migration
        // that renames it. `LEGACY_NAME_ALLOWANCE` lists the files where the old
        // name is the *subject* rather than the product's own name.
        /["'`]opencode\.(?:db|log)["'`]|default:\s*["'`]opencode\.local["'`]/,
        "the user's own files or the LAN service are named for the upstream project",
      ],
    ]) {
      // A legacy name is legitimate where the code migrates *from* it or still
      // accepts it as an input; those files are listed explicitly above.
      if (LEGACY_NAME_ALLOWANCE.includes(rel)) continue
      if (re.test(text)) hits.push({ file: rel, rule, count: 1 })
    }
  }
  // the built-in skill is injected into every session: its name and body are surface
  if (existsSync(path.join(forkRoot, "packages/core/src/plugin/skill/customize-opencode.md")))
    hits.push({ file: "packages/core/src/plugin/skill/customize-opencode.md", rule: "first-party-gateway", count: 1 })
  // The locale directory is a scan input, not a guarantee: when a batch moves it, the
  // honest answer is "this rule could not run" (exit 2, the code this file already uses
  // for an empty scan at :370). Reading the tree as "no brand drift" on an ENOENT would
  // surface one layer up as exit 1 — a *finding* — and the next person would spend the
  // afternoon hunting a string that was never there.
  const i18nDir = path.join(forkRoot, "packages/app/src/i18n")
  if (!existsSync(i18nDir)) {
    console.error(`brand-surface: no ${path.relative(repoRoot, i18nDir)} — the locale rule cannot run, which is not the same as passing`)
    process.exit(2)
  }
  for (const locale of readdirSync(i18nDir)) {
    const text = readFileSync(path.join(i18nDir, locale), "utf8")
    // values only: `"key": "... opencode ..."`. Key names are internal identifiers.
    for (const m of text.matchAll(/"[^"]*"\s*:\s*"[^"]*\bopencode\b[^"]*"/gi))
      hits.push({ file: `packages/app/src/i18n/${locale}`, rule: "first-party-gateway", count: 1 })
    if (/\bopencode\b/i.test(text.replace(/"[^"]*"\s*:/g, "")) === false && /opencode/i.test(text))
      hits.push({ file: `packages/app/src/i18n/${locale}`, rule: "first-party-gateway", count: 1 })
  }
  for (const rel of [
    "artifacts",
    ".vscode",
    "install",
    "nix",
    "sdks",
    "infra",
    "perf",
    "github",
    "sst.config.ts",
    "flake.nix",
    "screenshot-uk.png",
    "packages/console",
    "packages/web",
    "packages/stats",
    "packages/enterprise",
  ]) {
    if (existsSync(path.join(forkRoot, rel)))
      hits.push({ file: rel, rule: "removed-tree", count: 1 })
  }

  // Lineage counter across the whole fork.
  //
  // What it counts is the *name*, i.e. branding and prose. What it deliberately does
  // not count is the fork's own directory name: packages/opencode is a path in the tree
  // that a manifest, a fixture path and a tool argument all have to name correctly. On
  // 2026-09-26 seven new occurrences were all of that kind, and the ratchet could not
  // tell them apart from a rebrand that leaked — a tripwire that cannot be satisfied
  // honestly gets worked around, and then it protects nothing.
  const files = forkTextFiles()
  let occurrences = 0
  for (const abs of files) {
    const text = readFileSync(abs, "utf8")
    occurrences += (text.replace(/packages\/opencode\b/gi, "packages/<fork>").match(/opencode/gi) ?? []).length
  }
  return { hits, lineage: { occurrences, filesScanned: files.length } }
}

/** Coverage, stated every run. The lineage number is a SUM, so it only means
 *  something against a baseline that summed over the same amount of tree; naming the
 *  file count next to the occurrence count is what makes a shrink visible instead of
 *  readable as progress. A baseline without a coverage figure is said so out loud
 *  rather than treated as a pass. */
function reportCoverage(golden) {
  const now = observed.lineage.filesScanned
  const was = golden?.lineage?.filesScanned
  if (!Number.isFinite(was)) {
    console.log(`  lineage coverage: this run scanned ${now} file(s); the baseline records no coverage figure, so coverage cannot be compared — re-record to make it checkable`)
    return
  }
  const delta = now - was
  const move = delta === 0 ? "unchanged" : `${delta > 0 ? "grew" : "shrank"} ${Math.abs(delta)} file(s)`
  console.log(`  lineage coverage: recorded ${was} file(s) → now ${now} file(s) (${move})${delta < 0 ? " — the occurrence count is a sum over a SMALLER tree" : ""}`)
}

/** Only one direction of coverage movement invalidates the number: a shrink. Growth is
 *  ordinary work and stays green on purpose — growth in the *count* is already red via
 *  the lineage ratchet, and blocking all coverage movement would get the guard turned
 *  off. */
function coverageProblem(golden) {
  const was = golden?.lineage?.filesScanned
  if (!Number.isFinite(was)) return null
  const now = observed.lineage.filesScanned
  if (now >= was) return null
  const dropped = was - now
  const occ = observed.lineage.occurrences
  const howToReadIt = occ < golden.lineage.occurrences
    ? `lineage reads ${golden.lineage.occurrences} → ${occ}; that is NOT brand progress, it is ${dropped} fewer file(s) being looked at`
    : `lineage ${golden.lineage.occurrences} → ${occ}`
  return `lineage coverage shrank ${was} → ${now} file(s) (−${dropped}): ${howToReadIt}. What this rule scans is part of the caliber — restore the subtree, or re-record and say what left the tree`
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
  // A `missing-product-file` is not a brand finding: it is this tool reporting that a
  // scan input is gone. Recording it as an ordinary baseline hit would turn "we
  // stopped looking at this file" into a permanently green number — the installer,
  // product.json or a bin shim gets renamed and the ratchet then protects nothing,
  // which is the same failure this layer already refuses elsewhere: a record must not
  // be written when attribution failed (`tool-surface --record` over an unmeasured
  // surface, `kernel-vendor --record` over a mirror that disagrees with canonical).
  const missing = observed.hits.filter((h) => h.rule === "missing-product-file")
  const acknowledged = process.argv.includes("--ack-missing-product-file")
  if (missing.length && !acknowledged) {
    console.error(`brand-surface: refusing to record — ${missing.length} listed file(s) do not exist, so this run did not read them:`)
    for (const m of missing) console.error(`  · ${m.file}`)
    console.error("  Stamping that as a baseline makes an unscanned file permanently green. Either restore the")
    console.error("  file or move the list with it (PRODUCT_FILES / DOC_FILES in this file, same commit), and")
    console.error("  if the hole is a deliberate interim decision, say so explicitly:")
    console.error("    node harness/tools/brand-surface.mjs --record --ack-missing-product-file")
    process.exit(1)
  }
  if (missing.length) {
    // Recording anyway, but not quietly: the golden keeps carrying the
    // `missing-product-file` hit, and every later --check re-states the hole.
    console.error(`brand-surface: recording WITH ${missing.length} file(s) NOT SCANNED (explicitly acknowledged): ${missing.map((m) => m.file).join(", ")}`)
  }
  mkdirSync(path.dirname(goldenFile), { recursive: true })
  // Coverage travels with the occurrence count. The lineage number is only comparable
  // against a baseline that looked at the same amount of tree, so `--record` prints
  // the coverage move it is blessing instead of leaving it implicit.
  const prior = existsSync(goldenFile) ? JSON.parse(readFileSync(goldenFile, "utf8")) : null
  reportCoverage(prior)
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
// Coverage is part of the caliber. The occurrence count is a sum over the files this
// run actually read, so when the set of read files shrinks the sum can fall for a
// reason that has nothing to do with branding: a subtree disappearing reads as brand
// progress. Only a SHRINK is asserted against — a file being added is normal work and
// stays green on purpose, because the ratchet that guards growth is the occurrence
// count above. Coverage is always stated, and stated with its direction and size.
const covProblem = coverageProblem(golden)
if (covProblem) problems.push(covProblem)
reportCoverage(golden)
// A recorded `missing-product-file` is a hole the baseline blessed (only reachable via
// the explicit acknowledgement). --check says it every run so it cannot age into
// looking like a scanned-and-clean file.
for (const h of golden.hits?.filter((h) => h.rule === "missing-product-file") ?? []) {
  console.log(`  ! ${h.file} is in the golden as NOT SCANNED (missing-product-file); this run ${observed.hits.some((o) => o.file === h.file && o.rule === h.rule) ? "still cannot read it" : "can read it again — re-record to close the hole"}`)
}
if (problems.length > 0) {
  console.error(`brand-surface: ${problems.length} drift(s):`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log(`brand-surface: no unrecorded brand drift; lineage ${observed.lineage.occurrences} (baseline ${golden.lineage.occurrences}) over ${observed.lineage.filesScanned} scanned file(s) (baseline ${golden.lineage?.filesScanned ?? "unknown"})`)

