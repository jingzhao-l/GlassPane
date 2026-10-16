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
 *              Refuses unless the checkout's version equals the pinned tag — and
 *              refuses outright when the checkout carries no version at all
 *              (writing `upstreamTag` from a directory whose tag was never read
 *              launders a wrong-basis measurement into a golden).
 *   --check    (default) Verify the golden against a checkout when one is
 *              present; when it is not, assert the golden's internal
 *              consistency and say loudly that upstream was NOT observed here.
 *              Same rule as --record: no readable version means exit 2, not "no drift".
 *
 * Exit codes: 0 ok (including the honest offline skip), 1 contract drift,
 * 2 the tool could not do its job (missing config, unreadable checkout, unreadable
 *   checkout version).
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

/**
 * Extension points THIS fork binds, with the binding site. `--record` writes whatever
 * kind the generator computed (`sites.length > 0 ? "live" : …`), so every assertion that
 * only re-reads the generator's own rule is a tautology that can never fire. These two
 * cannot be: if upstream stops dispatching one, or drops it from the declaration, the
 * golden records it dead/absent while our plugin files keep awaiting calls that never
 * come — the exact "looks healthy, does nothing" failure this tool exists to catch.
 * The offline lane, which never opens upstream, is where this check has to live, because
 * it is the lane CI runs when no clone is present.
 */
const BOUND_HOOKS = {
  "tool.execute.after": "packages/opencode/src/plugin/glasspane-decision-log.ts",
  "experimental.session.compacting": "packages/opencode/src/plugin/glasspane-compaction.ts",
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
  // Hook names carry dots AND underscores: `experimental.provider.small_model`
  // (packages/plugin/src/index.ts:297 on the pin) is a declared extension point, and
  // a `[a-zA-Z.]+` class simply did not match it. Silent non-match is the worst
  // outcome a name-pattern can have: the checker reported 20 hooks for a declaration
  // of 21, and had that hook's dispatch site ever disappeared the alarm would have
  // stayed quiet — this tool exists specifically to catch "declared, never dispatched".
  const re = /^[ \t]{2}"([a-zA-Z0-9_.]+)"\??:/gm
  let m
  while ((m = re.exec(body)) !== null) {
    names.push({ name: m[1], declaredAt: `${path.basename(file)}:${lineOf(bodyStart + 1 + m.index)}` })
  }
  const reUn = /^[ \t]{2}([a-zA-Z0-9_]+)\??:/gm
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
 *
 * A dispatch through a generic — `plugin.trigger<"experimental.provider.small_model">(`
 * at packages/opencode/src/provider/provider.ts:1953 on the pin — was invisible to the
 * first pattern, which only allowed `trigger(` or `trigger.x(`. The hook was then
 * reported DEAD although the engine dispatches it every run, and the only symptom was a
 * freeze recommendation with no cause. A matcher that reads a live extension point as
 * dead is as bad as the reverse: both teach people to distrust the verdict.
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
      const isTrigger = /\btrigger\s*(?:\.\w+)?\s*(?:<[^()]*?>)?\s*\(/.test(window)
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
  // without rewriting the pinned coordinates in the repository. A relative
  // pin.checkout resolves against the repo root, so the same coordinates work
  // from any clone of this repository (and `.external/opencode` is the one
  // clone both rulers read — one upstream, not two that can disagree).
  const raw = process.env.HARNESS_UPSTREAM_CHECKOUT || pin.checkout
  const checkout = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw)
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
  // A declaration list that parses to nothing is not "no hooks": it is the pattern
  // failing to see the hooks, and every downstream answer would be vacuously true.
  if (declared.length === 0) {
    fail(2, `parsed 0 hook names out of ${pin.hooksFile} — the Hooks declaration shape changed; fix the parser before trusting any verdict`)
  }
  return {
    version,
    // Named for the caller: `--check`/`--record` must be able to say *which* file it could
    // not read when the version is absent, instead of quietly carrying on and printing
    // "checked … against anomalyco/opencode@v1.18.32" for a checkout whose version was
    // never looked at (the tag it claims to have verified would then be a claim about a
    // directory nobody read — and `--record` would write that tag into the golden).
    versionFile,
    checkout,
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

/**
 * `--check` prints "checked N hooks against <repo>@<pin.tag>" and `--record` writes
 * `upstreamTag: pin.tag` into the golden. Both of those sentences are about the tag, and the
 * tag is only *known* if the checkout's own version was read: the version check used to sit
 * inside `if (existsSync(versionFile))`, so a checkout that has `packages/plugin/src/index.ts`
 * but no `packages/opencode/package.json` passed through it unread and the run still asserted
 * the pin (measured 2026-10-16: `--check` printed "no drift" and `--record` would have stamped
 * `upstreamTag` from that directory). That laundering turns a wrong-basis measurement into a
 * golden, so an unread version is exit 2 — "cannot ask", not "no drift". `--probe` already
 * answers honestly (`v… `unknown``, exit unchanged) and `--offline` never reads upstream.
 * The tag-MISMATCH refusal above is untouched: this only adds the case where there was no
 * tag to compare at all.
 */
if ((mode === "check" || mode === "record") && result && !result.version) {
  fail(
    2,
    `--${mode} cannot assert a tag it did not read: the checkout at ${result.checkout} has no ${path.relative(result.checkout, result.versionFile)}, so its version is unknown while ${pin.repo}@${pin.tag} is what this run would claim to have checked. Point HARNESS_UPSTREAM_CHECKOUT (or upstream.json.checkout) at the pinned checkout, or run --offline (does not read upstream) / --probe (reports the version as "unknown" instead of asserting it).`,
  )
}

if (!existsSync(GOLDEN_FILE) && mode !== "record") {
  fail(2, `no golden at ${path.relative(repoRoot, GOLDEN_FILE)} — run --record`)
}
const golden = existsSync(GOLDEN_FILE) ? JSON.parse(readFileSync(GOLDEN_FILE, "utf8")) : null

// Read before anything dereferences `golden.hooks`: an array-shaped-but-empty golden is
// the offline lane's contract question below; a golden without the key at all is a broken
// tool input, and the reader deserves that sentence instead of a TypeError.
if (golden && !Array.isArray(golden.hooks)) {
  fail(2, `golden at ${path.relative(repoRoot, GOLDEN_FILE)} has no \`hooks\` array — it is not a hook-liveness golden; re-record`)
}

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
  // This used to print "upstream checkout absent" as a fact about the machine, which is not
  // what --offline means: the operator chose a lane that does not read upstream, and the
  // checkout may well be sitting right there (in a worktree it usually is, as a symlink). A
  // degraded output stated as a measurement is the failure mode this file exists to catch.
  if (!Array.isArray(golden.hooks) || golden.hooks.length === 0) {
    fail(1, "golden carries no hooks at all — an empty golden is not a contract, and printing OK over it is the loudest possible nothing. Re-record against the pinned checkout.")
  }
  console.log(`hook-liveness: --offline — this lane does not read upstream, so upstream was NOT observed.`)
  console.log(`  (${pin.checkout} was not opened; nothing here says whether it exists.)`)
  console.log(
    `  golden self-consistency: ${golden.hooks.length} hooks, ${golden.hooks.filter((h) => h.kind === "live").length} live, dead set = [${expectedDead.join(", ")}]`,
  )
  const KINDS = new Set(["live", "structural", "dead"])
  for (const h of golden.hooks) {
    // Beyond the generator's own live/fireSites rule (which no golden it wrote can
    // violate), assert the shapes a hand-edit or a stale-generator golden can have: an
    // unrecorded kind, a missing declaration line, a fire site without file:line. These
    // go red for reasons the --record lane does not itself produce.
    if (typeof h.name !== "string" || !h.name) fail(1, `golden has an entry with no usable name: ${JSON.stringify(h)}`)
    if (!KINDS.has(h.kind)) fail(1, `golden entry ${h.name} has kind ${JSON.stringify(h.kind)}, not one of live/structural/dead — hand-edited or written by an older generator`)
    if (typeof h.declaredAt !== "string" || !h.declaredAt) fail(1, `golden entry ${h.name} has no declaredAt — every recorded hook must name its declaration line`)
    if (!Array.isArray(h.fireSites)) fail(1, `golden entry ${h.name} has no fireSites array`)
    if (h.kind === "live" && h.fireSites.length === 0) {
      fail(1, `golden is internally inconsistent: ${h.name} marked live with no fire site`)
    }
    for (const s of h.fireSites) {
      if (typeof s?.file !== "string" || !Number.isInteger(s?.line)) fail(1, `${h.name} records a fire site without file:line: ${JSON.stringify(s)}`)
    }
  }
  for (const [name, binding] of Object.entries(BOUND_HOOKS)) {
    const recorded = golden.hooks.find((h) => h.name === name)
    if (!recorded) fail(1, `golden does not record ${name}, which this fork binds at ${binding} — a bound extension point silently dropped from the contract`)
    if (recorded.kind !== "live") fail(1, `${name} is recorded ${recorded.kind}, but ${binding} still awaits its dispatch — declared-and-dead means our plugin runs never, not late. Investigate before this lane goes green.`)
  }
  console.log(`  bound hooks still recorded live: ${Object.keys(BOUND_HOOKS).join(", ")}`)
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

// A missing checkout used to fall straight into the loop below and die on
// `observed is not iterable` with exit 1 — and exit 1 in this tool means "upstream
// broke the contract, freeze the upgrade". A machine that simply has no 223 MB
// reference clone is not evidence about upstream. Say what cannot be measured (exit 2)
// and point at the lane that can run without it.
if (!observed) {
  fail(
    2,
    `--check needs the reference checkout at ${process.env.HARNESS_UPSTREAM_CHECKOUT || pin.checkout}; upstream was NOT observed. ` +
      "Run `node harness/tools/hook-liveness.mjs --offline` for a lane that does not read upstream.",
  )
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
