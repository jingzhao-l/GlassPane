#!/usr/bin/env node
/*
 * patched-deps — a patch this fork declares is only real if the installed artifact carries it.
 *
 * WHY THIS EXISTS. `bun install` does not refuse a `patchedDependencies` entry whose version no
 * longer matches the graph: it drops the entry from `bun.lock` and installs the package
 * unpatched. Measured on 2026-10-23 with `@modelcontextprotocol/sdk` 1.31.0 -> 1.32.0 — the
 * declared key stayed in `package.json`, the lock's `patchedDependencies` lost the entry, and the
 * installed `dist/esm/client/streamableHttp.js` came back without `_recoverSession` or
 * `isRequestActive`: no 404 session recovery, no abort of a dead request, and the `callTool`
 * overloads that give the per-item MCP reply its types. Nothing downstream reddens. Typecheck reads
 * our own `.d.ts` surface, the suites drive fake transports, and the released bundle had been built
 * from an earlier install. The only place the loss is visible is the installed bytes, so that is
 * what this tool reads.
 *
 * WHAT IT MEASURES, per entry in the root `package.json` -> `patchedDependencies`:
 *   1. the package is installed at the version the patch key names;
 *   2. the lock's `patchedDependencies` still carries that key (its absence is the drop's signature);
 *   3. every line the patch adds is present, line for line, in the installed file it adds it to.
 * (3) is the load-bearing one: (1) and (2) can agree while the patch silently fails to apply.
 *
 * A declared patch for a package that is not in the install graph at all is NOT a verdict here — it
 * is a stale declaration, reported as `△`. Making it red would blame this round's change for a line
 * inherited from upstream, and a gate that cries about the wrong cause gets relaxed rather than
 * fixed. Every other failure is red, with the package, the file and the missing lines named.
 *
 * Exit codes: 0 all declared patches are carried by the install, 1 one is not, 2 cannot measure
 * (no root manifest, no lockfile, no node_modules — a check that goes green when it read nothing
 * would be the same decoration this gate exists to replace).
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

// Same root rule as kernel-pin.mjs: walk up to the tree holding product.json, so the file serves
// the standalone product repo and the monorepo around it without a second copy.
const productRoot = (() => {
  let dir = here
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "product.json"))) return dir
    dir = path.dirname(dir)
  }
  return null
})()

function die(code, message) {
  console.error(`[patched-deps] ${message}`)
  process.exit(code)
}

const strip = (line) => line.replace(/\s+/g, "")

/**
 * The patch file read as `{ files: [[relativePath, [addedLine, ...]]] }`.
 *
 * Added lines are kept per target file and whitespace-normalized, because that is the comparison
 * that can be made without guessing how the re-keyed patch was reformatted: `git apply` matched
 * context that differs, the content it installs does not. Context and removed lines are ignored on
 * purpose — a removed line that is still present means the patch was not applied, and (3) already
 * catches that through the added lines it replaces.
 */
function parsePatch(patchFile) {
  const text = readFileSync(patchFile, "utf8")
  const files = new Map()
  let current = null
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim()
      current = target === "/dev/null" ? null : target.replace(/^b\//, "")
      if (current && !files.has(current)) files.set(current, [])
      continue
    }
    if (!current || !line.startsWith("+") || line.startsWith("+++")) continue
    const content = strip(line.slice(1))
    if (content) files.get(current).push(content)
  }
  return [...files.entries()].map(([file, added]) => [file, added])
}

/** `@scope/name@1.2.3` -> `{ name: "@scope/name", version: "1.2.3" }`; unscoped likewise. */
function splitKey(key) {
  const at = key.lastIndexOf("@")
  if (at <= 0) return { name: key, version: "" }
  return { name: key.slice(0, at), version: key.slice(at + 1) }
}

function declared() {
  const manifest = path.join(productRoot, "package.json")
  if (!existsSync(manifest)) die(2, `no root package.json at ${manifest}`)
  const map = JSON.parse(readFileSync(manifest, "utf8")).patchedDependencies ?? {}
  return Object.entries(map).map(([key, patchPath]) => ({ key, ...splitKey(key), patchPath }))
}

/**
 * The lock's own `patchedDependencies` block, read line by line.
 *
 * `bun.lock` is JSONC — comments and trailing commas — so it will not `JSON.parse` as a whole, same
 * finding kernel-pin.mjs records. Each entry sits on one line, so the block is delimited by brace
 * depth and its keys are pulled out without a parser that could be fed a different layout.
 */
function lockedKeys() {
  const lockFile = path.join(productRoot, "bun.lock")
  if (!existsSync(lockFile)) die(2, `no bun.lock at ${lockFile} — cannot tell what the install was told to patch`)
  const keys = new Set()
  let depth = 0
  let inside = false
  for (const line of readFileSync(lockFile, "utf8").split("\n")) {
    if (!inside) {
      if (/^\s*"patchedDependencies":\s*\{/.test(line)) {
        inside = true
        depth = 1
      }
      continue
    }
    for (const ch of line) {
      if (ch === "{") depth++
      else if (ch === "}") depth--
    }
    const match = line.match(/^\s*"([^"]+)":\s*"patches\/[^"]+",?\s*$/)
    if (match) keys.add(match[1])
    if (depth <= 0) break
  }
  return keys
}

/**
 * Every place the install holds this package, de-duplicated by real path.
 *
 * Three sources, because the linker is not one thing. The isolated install puts every package under
 * `node_modules/.bun/<name-with-+>@<version>[+<peer-hash>]/node_modules/<name>` and links each
 * workspace's *direct* dependencies into that workspace's own `node_modules`; `setup-bun` switches to
 * `--linker hoisted` on Windows, where there is no store directory at all. Reading only one of these
 * would report a real, applied patch as "not in the graph" — the false clearance this file exists to
 * prevent, and measured: the two link levels alone found 12 of 19 declarations, the store finds all
 * 18 that are in the graph. Workspaces are enumerated rather than named, so a dependency reached from
 * any of them is read, not just the one that happens to be the CLI.
 */
function installCandidates(name) {
  const levels = [path.join(productRoot, "node_modules", name)]
  const packagesDir = path.join(productRoot, "packages")
  if (existsSync(packagesDir)) {
    for (const workspace of readdirSync(packagesDir)) {
      levels.push(path.join(packagesDir, workspace, "node_modules", name))
    }
  }
  const store = path.join(productRoot, "node_modules", ".bun")
  const storeDirs = existsSync(store)
    ? readdirSync(store)
        .filter((entry) => entry.startsWith(`${name.replace("/", "+")}@`))
        .map((entry) => path.join(store, entry, "node_modules", name))
    : []
  const seen = new Map()
  for (const dir of [...levels, ...storeDirs]) {
    if (!existsSync(path.join(dir, "package.json"))) continue
    let real
    try {
      real = realpathSync(dir)
    } catch {
      continue
    }
    if (!seen.has(real)) seen.set(real, dir)
  }
  return [...seen.keys()]
}

function versionOf(dir) {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version
}

// A patch may target a file the publisher only ships for some platform. That is not this fork
// losing its work, so an absent target file is a `△` — but only for files listed here, with the
// reason written next to it. An unlisted absent file is red: an unapplied patch usually looks like
// a missing file, and a gate that shrugs at every missing file shrugs at the accident above.
const ABSENT_TARGET_IS_OK = new Set()

export function measure() {
  const problems = []
  const notes = []
  let located = 0
  const declaredEntries = declared()
  const lock = lockedKeys()
  for (const entry of declaredEntries) {
    const patchFile = path.join(productRoot, entry.patchPath)
    const dirs = installCandidates(entry.name)
    if (dirs.length === 0) {
      notes.push(`△ ${entry.key}: not in this install graph — stale declaration, nothing to patch`)
      continue
    }
    // "located" answers a different question than "measured": how many declarations refer to bytes
    // this install actually holds. It is incremented before the patch file is opened so that a
    // missing patch file counts as a measurement that failed (exit 1) rather than as nothing
    // measured — the order here was caught by the selftest, which watched exit 2 swallow that red.
    located += 1
    if (!existsSync(patchFile)) {
      problems.push(`${entry.key}: ${entry.patchPath} is declared but not in the tree`)
      continue
    }
    const installed = dirs.map(versionOf)
    // bun patches the version named in the key and only that version, so the copy that has to carry
    // the patch lines is the one at `entry.version`. Other copies of the same package in the tree are
    // a different fact and get a different treatment: if none exists at the declared version, the
    // patch describes bytes nothing loads (red); if it does exist, the extra versions are upstream's
    // dependency graph asking for a range the patch never claimed to cover (a `△` finding, not a
    // verdict — a gate that reddens on every multi-version package would be relaxed within a week).
    const matching = dirs.filter((dir) => versionOf(dir) === entry.version)
    if (matching.length === 0) {
      problems.push(
        `${entry.name}: patch declares ${entry.version}, the install carries only ${[...new Set(installed)].join(" | ")} — ` +
          `bun applies a patch only for the exact version in its key, so nothing loads these bytes`,
      )
      continue
    }
    if (!lock.has(entry.key)) {
      problems.push(
        `${entry.key}: declared in package.json but absent from bun.lock's patchedDependencies — ` +
          `the install was not told to apply it`,
      )
      continue
    }
    const targets = parsePatch(patchFile)
    for (const dir of matching) {
      for (const [file, added] of targets) {
        const full = path.join(dir, file)
        if (!existsSync(full)) {
          if (ABSENT_TARGET_IS_OK.has(`${entry.name}|${file}`)) {
            notes.push(`△ ${entry.key}: ${file} is not part of this platform's artifact`)
          } else {
            problems.push(`${entry.key}: ${file} targeted by the patch is absent from ${dir}`)
          }
          continue
        }
        const present = new Set(readFileSync(full, "utf8").split("\n").map(strip))
        const missing = added.filter((line) => !present.has(line))
        if (missing.length > 0) {
          problems.push(
            `${entry.key}: ${missing.length}/${added.length} line(s) the patch adds are not in ${dir}/${file} — ` +
              `the patch did not reach the installed bytes. First: ${JSON.stringify(missing[0].slice(0, 90))}`,
          )
        }
      }
    }
    const others = [...new Set(installed)].filter((version) => version !== entry.version)
    if (others.length > 0) {
      notes.push(
        `△ ${entry.name} also installed at ${others.join(", ")} with no patch key covering them — ` +
          `those copies load without this patch by bun's own rule`,
      )
    }
  }
  return { problems, notes, measured: declaredEntries.length, located }
}

const argv = process.argv.slice(2)
if (argv[0] !== "--check" && argv[0] !== undefined) die(2, `unknown mode ${argv[0]} — expected --check`)
if (!productRoot) die(2, "could not find the tree that holds product.json")
const nodeModules = path.join(productRoot, "node_modules")
if (!existsSync(nodeModules)) die(2, `no node_modules under ${productRoot} — run \`bun install\` before measuring`)

const { problems, notes, measured, located } = measure()
// A tree where nothing could be located is not a clean tree. Without this, an empty or half-done
// install answers "all declared patches are present" for the reason that no patch was looked at.
if (measured > 0 && located === 0) {
  die(2, `none of the ${measured} declared patch(es) is in this install — nothing was measured, so "no failures" would be a claim about bytes nobody read`)
}
for (const note of notes) console.log(note)
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`)
  die(1, `${problems.length} declared patch(es) of ${measured} are not carried by the install`)
}
console.log(`[patched-deps] ${located}/${measured} declared patch(es) checked against installed bytes, ${measured - located} not in this graph (see △ above)`)
