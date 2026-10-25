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
 *
 * MODES
 *   --check                                  the three-way comparison above, against this tree's
 *                                            install.
 *   --items --package <name>                 print the artifact-checkable demand list for one
 *                                            declared patch as JSON, so a consumer derives the
 *                                            question instead of restating it.
 *   --artifact <file> --package <name>       ask that list of one file's bytes — used by the release
 *                                            lane against the binary the registry served, because
 *                                            `--check` can only ever see the install it runs in and
 *                                            the build job installs on its own machine.
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

/**
 * What a published artifact must be able to show for one declared patch.
 *
 * `measure()` compares patch lines against the installed files, where each line lands in a known
 * file. A released binary is one flat blob after the bundler has been through it, and three
 * candidate rules were measured against the published 0.10.1 bytes before this function existed:
 * every added line (fails — `.d.ts` lines are not in a runtime bundle at all), every identifier the
 * patch introduces (fails — `isSessionRetry`, `requestSessionId`, `expiredSessionId` are local
 * bindings, and bun renames those), and every added string plus every added call name (fails —
 * `'../types.js'` is a module specifier, which the bundler erases, and `isJSONRPCErrorResponse` /
 * `determineScope` are upstream symbols the patch merely calls). What survived all three passes,
 * with 8 of 8 items present in the shipped bytes, is exactly two kinds:
 *
 *   * string literals the patch adds — a bundler cannot rename data without changing behaviour;
 *   * method definitions the patch adds whose name appears on no removed line — these become
 *     property keys reached through `this.`, which survive for the same reason.
 *
 * Only runtime ES modules count (`dist/esm/**\/*.js`): the `.cjs` pair is duplicated content, `.d.ts`
 * ships no bytes, and a TUI-only package is not in this bundle. The list is derived from the patch
 * file rather than hardcoded, so a re-keyed patch cannot quietly stop being checked — and if a patch
 * ever adds no checkable item at all, `artifactVerdict` returns an empty list and the caller refuses
 * (exit 2) instead of passing a question it never asked.
 */
const RUNTIME_TARGET = /^dist\/esm\/.*\.js$/
const ADDED_STRING = /(?:"([^"\n]{8,})"|'([^'\n]{8,})')/g
const ADDED_METHOD = /^\s*(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]{4,})\s*\(/
const NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "return", "function", "await", "new", "else", "try", "typeof"])
const CODE_FRAGMENT = /[(){};=<>|/\\]|\.\.\/|\.js$/

export function artifactItems(patchText) {
  let current = null
  const added = new Map()
  const removedText = []
  for (const line of patchText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      const target = line.slice(6).trim()
      current = target && target !== "/dev/null" && RUNTIME_TARGET.test(target) ? target : null
      if (current && !added.has(current)) added.set(current, [])
      continue
    }
    if (line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("--- ") || line.startsWith("@@")) continue
    if (!current) continue
    if (line.startsWith("+")) added.get(current).push(line.slice(1))
    else if (line.startsWith("-")) removedText.push(line.slice(1))
  }
  const removed = removedText.join("\n")
  const items = new Set()
  for (const lines of added.values()) {
    for (const line of lines) {
      for (const match of line.matchAll(ADDED_STRING)) {
        const value = (match[1] ?? match[2] ?? "").trim()
        if (value.length >= 8 && !CODE_FRAGMENT.test(value)) items.add(value)
      }
      const method = line.match(ADDED_METHOD)
      if (method && !NOT_A_NAME.has(method[1]) && !new RegExp(`\\b${method[1]}\\b`).test(removed)) items.add(method[1])
    }
  }
  return [...items].sort()
}

/** The same items, judged against the bytes of one artifact. `missing` empty plus `items` non-empty is the only pass. */
export function artifactVerdict(patchText, bytes) {
  const items = artifactItems(patchText)
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const missing = items.filter((item) => !buffer.includes(item))
  return { items, missing }
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
 * What `bun.lock` itself resolves: package name → the set of versions this install has to hold.
 *
 * `installCandidates` reads the filesystem, and the filesystem is not the graph. A store directory an
 * older install left behind still has bytes, yet nothing links them, so judging "is this in the
 * install" from disk alone gives one committed tree two verdicts: red on a machine holding a stale
 * copy, `△` on a clean CI without one. Measured on 2026-10-25 against
 * `@standard-community/standard-openapi@0.2.9` — absent from this lock (the whole package, every
 * version), present in `node_modules/.bun` from a 2026-09-25 install — where the gate answered
 * "the install was not told to apply it", a claim about an install that does not contain it.
 *
 * Returning `null` when there is no `packages` block is deliberate: that is a layout this reader does
 * not understand, and then the honest answer is the weaker disk judgement plus the note the caller
 * prints, not a confident "not in graph" built from a block it never parsed.
 */
function lockedGraph() {
  const lockFile = path.join(productRoot, "bun.lock")
  if (!existsSync(lockFile)) return null
  const lines = readFileSync(lockFile, "utf8").split("\n")
  const start = lines.findIndex((line) => /^\s*"packages":\s*\{/.test(line))
  if (start === -1) return null
  const versions = new Map()
  let depth = 0
  for (const line of lines.slice(start)) {
    for (const ch of line) {
      if (ch === "{") depth++
      else if (ch === "}") depth--
    }
    const token = line.match(/:\s*\[\s*"([^"]+)"/)
    if (token) {
      const bare = token[1].split("+")[0]
      const at = bare.lastIndexOf("@")
      if (at > 0) {
        const name = bare.slice(0, at)
        if (!versions.has(name)) versions.set(name, new Set())
        versions.get(name).add(bare.slice(at + 1))
      }
    }
    if (depth <= 0) break
  }
  return versions
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

// There is deliberately no allow-list here. An earlier draft carried an empty one ("a patch may
// target a file some platforms do not ship"), which no case could ever reach — a branch nobody can
// make fire is the same decoration this file was written to replace. Every absent target is red:
// an unapplied patch most often looks exactly like the file the patch edits simply not being there.
export function measure() {
  const problems = []
  const notes = []
  let located = 0
  const declaredEntries = declared()
  const lock = lockedKeys()
  const graph = lockedGraph()
  for (const entry of declaredEntries) {
    const patchFile = path.join(productRoot, entry.patchPath)
    const dirs = installCandidates(entry.name)
    if (dirs.length === 0) {
      notes.push(`△ ${entry.key}: not in this install graph — stale declaration, nothing to patch`)
      continue
    }
    // Bytes on disk are only evidence of what this install holds when the lock cannot say. Where the
    // lock can say, it wins: a copy of the declared version that the lock does not resolve is an
    // artifact of some earlier install, and a copy of a package the lock resolves at another version
    // is the original accident — the dependency moved and the patch key stayed.
    if (graph !== null && !graph.get(entry.name)?.has(entry.version)) {
      if (!graph.has(entry.name)) {
        notes.push(
          `△ ${entry.key}: not in bun.lock's package graph — ${dirs[0]} is bytes an older install left ` +
            `behind, which nothing links, so there is no loaded copy of this patch to look at`,
        )
        continue
      }
      located += 1
      problems.push(
        `${entry.key}: bun.lock resolves ${entry.name} only at ${[...graph.get(entry.name)].join(" | ")} — ` +
          `the declared version is not in the graph, which is the shape of a dependency that moved while ` +
          `this patch key stayed where it was`,
      )
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
          problems.push(`${entry.key}: ${file} targeted by the patch is absent from ${dir}`)
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

/** The declared patch for one package name, whatever version it is keyed at. */
function declaredFor(name) {
  return declared().find((entry) => entry.name === name) ?? null
}

function runArtifact(argv) {
  const artifact = argv[argv.indexOf("--artifact") + 1]
  const at = argv.indexOf("--package")
  const name = at === -1 ? undefined : argv[at + 1]
  if (!artifact) die(2, "--artifact needs a file to read — the published bytes, not a directory")
  if (!name) die(2, "--artifact needs --package <name> so the demand list comes from a declared patch")
  if (!productRoot) die(2, "could not find the tree that holds product.json")
  if (!existsSync(artifact)) die(2, `no artifact at ${artifact} — the published bytes could not be read, so nothing was observed`)
  const entry = declaredFor(name)
  if (!entry) die(2, `${name} has no patchedDependencies declaration — asking an artifact about an undeclared patch has no answer`)
  const patchFile = path.join(productRoot, entry.patchPath)
  if (!existsSync(patchFile)) die(2, `${entry.key}: ${entry.patchPath} is declared but not in the tree`)
  // Read the payload once. This file is a 145 MB compiled binary at release time, and an earlier
  // draft read it twice — once to judge, once to report how many bytes it had read.
  const bytes = readFileSync(artifact)
  const { items, missing } = artifactVerdict(readFileSync(patchFile, "utf8"), bytes)
  if (items.length === 0) {
    die(2, `${entry.key}: its patch adds nothing an artifact can be asked about — refusing to report a question never asked as a pass`)
  }
  if (missing.length > 0) {
    for (const item of missing.slice(0, 10)) console.error(`FAIL ${entry.key}: ${JSON.stringify(item)} is added by the patch but absent from ${artifact}`)
    die(1, `${missing.length}/${items.length} item(s) the patch of ${entry.key} must show in the published artifact are not in its bytes — the bundle was built from unpatched sources`)
  }
  console.log(`[patched-deps] ${entry.key}: all ${items.length} artifact-checkable item(s) present in ${path.basename(artifact)} (${bytes.length} bytes read)`)
}

// Only run as a program. The release lane (`verify-published.ts`) calls this file as a command rather
// than importing it, so the criterion lives in exactly one place; a top-level CLI body that ran on
// import would either measure the wrong tree or exit silently and let an importing test run zero
// cases. `import.meta.main` is deliberately not used: it is undefined under older Node, which would
// make this gate inert exactly where it is wired in (the parent CI calls it with `node`).
//
// Both sides are realpaths, and that is not pedantry: the battery that proves this gate can go red
// runs a copy of it from a temp directory, and on macOS `tmpdir()` hands out `/var/folders/…` while
// Node resolves the module URL to `/private/var/folders/…`. Comparing the two as written made the
// copy decide it had been imported, so every case expecting a red silently got exit 0 — 23 of them,
// caught by the battery rather than by me.
const invoked = process.argv[1] ? realpathSync(path.resolve(process.argv[1])) : ""
const isMain = invoked !== "" && invoked === realpathSync(fileURLToPath(import.meta.url))

/** Print the demand list for one declared patch as JSON, so a consumer derives it instead of restating it. */
function runItems(argv) {
  const at = argv.indexOf("--package")
  const name = at === -1 ? undefined : argv[at + 1]
  if (!name) die(2, "--items needs --package <name>")
  if (!productRoot) die(2, "could not find the tree that holds product.json")
  const entry = declaredFor(name)
  if (!entry) die(2, `${name} has no patchedDependencies declaration`)
  const patchFile = path.join(productRoot, entry.patchPath)
  if (!existsSync(patchFile)) die(2, `${entry.key}: ${entry.patchPath} is declared but not in the tree`)
  process.stdout.write(`${JSON.stringify(artifactItems(readFileSync(patchFile, "utf8")))}\n`)
}

if (isMain) {
  const argv = process.argv.slice(2)
  if (argv.includes("--items")) {
    runItems(argv)
  } else if (argv.includes("--artifact")) {
    runArtifact(argv)
  } else {
    if (argv[0] !== "--check" && argv[0] !== undefined) die(2, `unknown mode ${argv[0]} — expected --check (or --artifact <file> --package <name>)`)
    if (!productRoot) die(2, "could not find the tree that holds product.json")
    const nodeModules = path.join(productRoot, "node_modules")
    if (!existsSync(nodeModules)) die(2, `no node_modules under ${productRoot} — run \`bun install\` before measuring`)

    const { problems, notes, measured, located } = measure()
    // A tree where nothing could be located is not a clean tree. Without this, an empty or half-done
    // install answers "all declared patches are present" for the reason that no patch was looked at.
    if (measured === 0) {
      die(2, `no patchedDependencies declaration is left in ${path.join(productRoot, "package.json")} — `
        + `this fork's install only stays patched while those declarations exist, so an empty list is the `
        + `block having been deleted, not a clean tree. If deleting it is really intended, remove this gate's `
        + `CI step in the same commit: silence has to be a decision, never a side effect of a manifest edit.`)
    }
    if (measured > 0 && located === 0) {
      die(2, `none of the ${measured} declared patch(es) is in this install — nothing was measured, so "no failures" would be a claim about bytes nobody read`)
    }
    for (const note of notes) console.log(note)
    if (problems.length > 0) {
      for (const problem of problems) console.error(`FAIL ${problem}`)
      die(1, `${problems.length} declared patch(es) of ${measured} are not carried by the install`)
    }
    console.log(`[patched-deps] ${located}/${measured} declared patch(es) checked against installed bytes, ${measured - located} not in this graph (see △ above)`)
  }
}
