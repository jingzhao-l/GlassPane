#!/usr/bin/env node
/**
 * hook-liveness.mjs — the harness-line contract gate for GlassPane 工具面 B.
 *
 * WHY THIS EXISTS
 * Upstream opencode declares its plugin surface as the `Hooks` interface
 * (packages/plugin/src/index.ts) and the host dispatches a hook by *name*:
 * `Plugin.trigger(name, input, output)` calls `hook[name]?.(input, output)`
 * (packages/opencode/src/plugin/index.ts). A hook that is declared but never
 * passed to `trigger` therefore **type-checks, loads, and silently never runs**.
 *
 * That is not hypothetical. At the pinned tag, `permission.ask` is declared at
 * packages/plugin/src/index.ts:261 and appears exactly once in the whole tree —
 * the declaration. Upstream's own in-repo skill doc lists it under "Hook
 * surface". A GlassPane module built on it (session-level TCC permission
 * onboarding) would have looked healthy and done nothing.
 *
 * So this is the test that keeps "failure is attributable to upstream" true,
 * which is the entire value of the contract-test discipline (综述 R34 / §8.2).
 *
 * MODES
 *   --record   Recompute from a local upstream checkout and rewrite the golden.
 *              Refuses unless the checkout's version equals the pinned tag.
 *   --check    (default) Verify the golden against a checkout when one is
 *              present; when it is not, assert the golden's internal
 *              consistency and say loudly that upstream was NOT observed here.
 *
 * Exit codes: 0 ok (including the honest offline skip), 1 contract drift,
 * 2 the tool could not do its job (missing config, unreadable checkout).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const harnessRoot = path.resolve(here, "..")
const repoRoot = path.resolve(harnessRoot, "..")
const PIN_FILE = path.join(harnessRoot, "upstream.json")
const GOLDEN_FILE = path.join(harnessRoot, "contracts", "hook-liveness.json")

/**
 * Members that are not `trigger`-dispatched by design: the host reads them off
 * the plugin object during init or teardown. Each reason must name the reading
 * site, otherwise it is an excuse, not a reason.
 */
const STRUCTURAL = {
  config: "init-time: host reads plugin.config",
  tool: "init-time: registry.ts iterates Object.entries(p.tool)",
  auth: "init-time: auth provider collection",
  provider: "init-time: provider hooks collection",
  dispose: "teardown: host calls plugin.dispose()",
  "provider.model": "init-time: model listing hook",
  "provider.transformHeader": "init-time: header transform",
}

const args = new Set(process.argv.slice(2))

function fail(code, msg) {
  console.error(`hook-liveness: ${msg}`)
  process.exit(code)
}

function readPin() {
  if (!existsSync(PIN_FILE)) fail(2, `missing ${path.relative(repoRoot, PIN_FILE)}`)
  const pin = JSON.parse(readFileSync(PIN_FILE, "utf8"))
  for (const key of ["repo", "tag", "checkout", "hooksFile", "scanDirs", "observedAt"]) {
    if (!pin[key]) fail(2, `upstream.json missing required key "${key}"`)
  }
  return pin
}

/** Collect .ts/.tsx files under dir, skipping vendored/derived trees. */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === "gen") continue
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Parse the declared hook names out of the `Hooks` interface. */
function parseHooks(file) {
  const text = readFileSync(file, "utf8")
  const start = text.indexOf("export interface Hooks")
  if (start < 0) fail(2, `no "export interface Hooks" in ${file}`)
  let depth = 0
  let i = text.indexOf("{", start)
  const bodyStart = i
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}") {
      depth--
      if (depth === 0) break
    }
  }
  const body = text.slice(bodyStart + 1, i)
  const names = []
  const lineOf = (idx) => text.slice(0, idx).split("\n").length
  const re = /^[ \t]{2}"([a-zA-Z.]+)"\??:/gm
  let m
  while ((m = re.exec(body)) !== null) {
    names.push({ name: m[1], declaredAt: `${path.basename(file)}:${lineOf(bodyStart + 1 + m.index)}` })
  }
  const reUn = /^[ \t]{2}([a-zA-Z]+)\??:/gm
  while ((m = reUn.exec(body)) !== null) {
    if (!names.some((n) => n.name === m[1])) {
      names.push({ name: m[1], declaredAt: `${path.basename(file)}:${lineOf(bodyStart + 1 + m.index)}` })
    }
  }
  return names
}

/**
 * Where a hook name is actually dispatched from.
 * Two shapes count as a fire site:
 *   A) `trigger(` ... `"<name>"`   (name may sit on the following line)
 *   B) `hook["<name>"]` / `hooks["<name>"]` bracket lookup by literal
 * Anything else (prose, docs, type-only re-export) is not a fire site.
 */
function findFireSites(files, name) {
  const quoted = new RegExp(`["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "g")
  const sites = []
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n")
    for (let i = 0; i < lines.length; i++) {
      quoted.lastIndex = 0
      if (!quoted.test(lines[i])) continue
      const window = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 2)).join("\n")
      const isTrigger = /\btrigger\s*(?:\.\w+)?\s*\(/.test(window)
      const isLookup = new RegExp(`\\b(?:hooks?|plugin|p)\\s*\\[\\s*["']${name.replace(/\./g, "\\.")}["']\\s*\\]`).test(
        lines[i],
      )
      if (isTrigger || isLookup) {
        sites.push({ file: path.relative(files.root ?? harnessRoot, file), line: i + 1 })
      }
    }
  }
  return sites
}

function observe(pin, { expectTag = true } = {}) {
  // HARNESS_UPSTREAM_CHECKOUT lets CI point the tool at a freshly fetched tag
  // without rewriting the pinned coordinates in the repository.
  const checkout = path.resolve(process.env.HARNESS_UPSTREAM_CHECKOUT || pin.checkout)
  if (!existsSync(checkout)) return null
  let version = null
  const versionFile = path.join(checkout, "packages/opencode/package.json")
  if (existsSync(versionFile)) {
    version = JSON.parse(readFileSync(versionFile, "utf8")).version
    if (expectTag && version !== pin.tag.replace(/^v/, "")) {
      fail(2, `checkout at ${checkout} is version ${version}, pinned tag is ${pin.tag} — refusing to mix bases`)
    }
  }
  const hooksFile = path.join(checkout, pin.hooksFile)
  if (!existsSync(hooksFile)) fail(2, `missing ${hooksFile}`)
  const files = []
  for (const dir of pin.scanDirs) files.push(...walk(path.join(checkout, dir)))
  files.root = checkout
  const declared = parseHooks(hooksFile)
  return {
    version,
    hooks: declared.map((d) => {
      const sites = findFireSites(files, d.name)
      return {
        name: d.name,
        declaredAt: d.declaredAt,
        fireSites: sites,
        kind: sites.length > 0 ? "live" : STRUCTURAL[d.name] ? "structural" : "dead",
        ...(STRUCTURAL[d.name] ? { reason: STRUCTURAL[d.name] } : {}),
      }
    }),
  }
}

const pin = readPin()
// --offline forces the no-checkout path: used by lanes that deliberately do not
// fetch upstream, so the run reports what it could NOT see instead of going quiet.
// --probe never writes: it compares a checkout (HARNESS_UPSTREAM_CHECKOUT) against
// the golden and answers exactly one question — "would upgrading break us?"
const mode = args.has("--record") ? "record" : args.has("--probe") ? "probe" : args.has("--offline") ? "offline" : "check"
const result = mode === "offline" ? null : observe(pin, { expectTag: mode !== "probe" })
const observed = result && result.hooks

if (!existsSync(GOLDEN_FILE) && mode !== "record") {
  fail(2, `no golden at ${path.relative(repoRoot, GOLDEN_FILE)} — run --record`)
}
const golden = existsSync(GOLDEN_FILE) ? JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) : null

if (mode === "record") {
  if (!observed) fail(2, "--record needs the upstream checkout; set upstream.json.checkout")
  const next = {
    _comment:
      "Generated by harness/tools/hook-liveness.mjs --record. Do not hand-edit: regenerate against the pinned checkout.",
    repo: pin.repo,
    upstreamTag: pin.tag,
    hooksFile: pin.hooksFile,
    scanDirs: pin.scanDirs,
    observedAt: new Date().toISOString().slice(0, 10),
    hooks: observed,
  }
  writeFileSync(GOLDEN_FILE, JSON.stringify(next, null, 2) + "\n")
  const dead = observed.filter((h) => h.kind === "dead")
  console.log(`recorded ${observed.length} declared hooks -> ${path.relative(repoRoot, GOLDEN_FILE)}`)
  console.log(`  live: ${observed.filter((h) => h.kind === "live").length}`)
  console.log(`  structural (not trigger-dispatched by design): ${observed.filter((h) => h.kind === "structural").length}`)
  console.log(`  DEAD (declared, never dispatched): ${dead.length ? dead.map((h) => h.name).join(", ") : "none"}`)
  process.exit(0)
}

if (golden.upstreamTag !== pin.tag) {
  fail(1, `golden recorded at ${golden.upstreamTag} but upstream.json pins ${pin.tag} — re-record, do not compare across bases`)
}

const expectedDead = golden.hooks.filter((h) => h.kind === "dead").map((h) => h.name).sort()

if (mode === "offline") {
  // No upstream source in this lane. Say so instead of pretending it was checked.
  console.log(`hook-liveness: upstream checkout absent (${pin.checkout}) — upstream NOT observed in this run.`)
  console.log(
    `  golden self-consistency: ${golden.hooks.length} hooks, ${golden.hooks.filter((h) => h.kind === "live").length} live, dead set = [${expectedDead.join(", ")}]`,
  )
  for (const h of golden.hooks) {
    if (h.kind === "live" && (!Array.isArray(h.fireSites) || h.fireSites.length === 0)) {
      fail(1, `golden is internally inconsistent: ${h.name} marked live with no fire site`)
    }
  }
  console.log("  OK (offline). The upstream-facing lane is the scheduled `harness contract` job, not this one.")
  process.exit(0)
}

if (mode === "probe") {
  if (!observed) fail(2, `--probe needs a checkout at ${process.env.HARNESS_UPSTREAM_CHECKOUT || pin.checkout}`)
  const label = result.version ? `v${result.version}` : "unknown"
  let drift = 0
  for (const now of observed) {
    const was = golden.hooks.find((h) => h.name === now.name)
    if (!was) {
      console.log(`  + ${label} declares a new hook: ${now.name} (${now.kind})`)
      continue
    }
    if (was.kind !== now.kind) {
      console.error(`  ✗ ${now.name}: pinned=${was.kind} ${label}=${now.kind}`)
      drift++
    }
  }
  for (const was of golden.hooks) {
    if (!observed.some((h) => h.name === was.name)) {
      console.error(`  ✗ ${label} removed hook ${was.name} (pinned kind ${was.kind})`)
      drift++
    }
  }
  const nowDead = observed.filter((h) => h.kind === "dead").map((h) => h.name).sort()
  const newlyDead = nowDead.filter((n) => !expectedDead.includes(n))
  if (newlyDead.length) {
    console.error(`  ✗ ${label} silently un-wires: ${newlyDead.join(", ")} — declared, but no longer dispatched.`)
    console.error(`     Anything built on them keeps compiling and stops running.`)
    drift++
  }
  if (drift > 0) {
    console.error(`probe ${pin.repo}@${label} vs golden ${pin.tag}: ${drift} drift — 上游坏. Do not upgrade; freeze.`)
    process.exit(1)
  }
  console.log(`probe ${pin.repo}@${label} vs golden ${pin.tag}: plugin surface intact (${observed.length} hooks)`)
  process.exit(0)
}

let drift = 0
for (const now of observed) {
  const was = golden.hooks.find((h) => h.name === now.name)
  if (!was) {
    console.log(`  + upstream declared a new hook: ${now.name} (${now.kind}, ${now.declaredAt})`)
    drift++
    continue
  }
  if (was.kind !== now.kind) {
    console.error(`  ✗ ${now.name}: golden=${was.kind} now=${now.kind} — the contract moved under us.`)
    if (now.kind === "dead") {
      console.error(`     It is declared (${now.declaredAt}) but no engine code dispatches it. Anything built on it runs never, not late.`)
    }
    drift++
  }
}
for (const was of golden.hooks) {
  if (!observed.some((h) => h.name === was.name)) {
    console.error(`  ✗ hook removed upstream: ${was.name} (golden says ${was.kind})`)
    drift++
  }
}
const stillDead = observed.filter((h) => h.kind === "dead").map((h) => h.name).sort()
if (JSON.stringify(stillDead) !== JSON.stringify(expectedDead)) {
  console.error(`  ✗ dead-hook set changed: golden=[${expectedDead.join(", ")}] now=[${stillDead.join(", ")}]`)
  drift++
}

console.log(`checked ${observed.length} hooks against ${pin.repo}@${pin.tag}: ${drift === 0 ? "no drift" : drift + " drift"}`)
if (drift > 0) {
  console.error("Attribution per 综述 R34: this is 上游坏 (upstream changed the plugin floor). Freeze the upgrade, do not patch around it here.")
  process.exit(1)
}
