#!/usr/bin/env node
/**
 * Build the release archive this repo publishes, with this repo's own tar writer.
 *
 *     node scripts/make-release-archive.mjs <version> <out-file>
 *
 * Why this exists instead of `git archive HEAD` (which is the step it replaces): the updater installs the
 * two npm packages by running `npm pack` **inside the staged tree** — §1's last bullet, "the bytes that were
 * verified are the bytes that get installed", never the registry. A source-only archive has no
 * `mcp-shell/dist`, so what got packed was a package whose declared command does not exist. Measured on a
 * real machine on 2026-10-01: `glasspane-mcp-1.5.1.tgz` carried three entries (`package.json`, `LICENSE`,
 * `README.md`), `npm install -g` answered 0, `npm ls -g` read back 1.5.1, and §3.3's MCP half then died on
 * `glasspane-mcp could not run (ENOENT)` — the whole swap was refused and rolled back. Every 1.5.x machine
 * attempting this upgrade hits that wall, because the code that packs is already released.
 *
 * So the archive is the tracked tree — less every entry whose path begins with a prefix
 * `EXCLUDED_PREFIXES` names (a directory like `harness/`, or a single root file like
 * `.iterate_decisions.md`), which is enforced against `REQUIRED_IN_ARCHIVE` so an exclusion
 * can never remove something the install path reads — **plus the build
 * outputs a target machine cannot produce for itself** (`mcp-shell/dist`, `mcp-shell/schemas`). `engine/`
 * still builds on the target, because Xcode is the one toolchain a macOS update may assume. Missing build
 * outputs are a refusal, not a warning: an archive that cannot produce a runnable package is not a release of
 * this product.
 *
 * Determinism is the reason to own the writer rather than shell out to `tar`, whose flags differ between
 * GNU tar and the bsdtar on this machine's PATH: every header here is written with uid 0, gid 0 and mtime 0,
 * entries come from `git ls-files` in byte order, the gzip layer carries no timestamp, and this script packs
 * twice and compares the bytes before it writes anything.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { packTarGz, readTarGz } from '../updater/lib/tar.js'
import { VERSION_SITES } from '../updater/lib/selfcheck.js'

/** Directories that must exist and are not tracked: the JS build outputs the target machine cannot make. */
export const REQUIRED_BUILD_OUTPUTS = ['mcp-shell/dist', 'mcp-shell/schemas']

/**
 * What stays out of the archive, and why that is a decision rather than an accident.
 *
 * `harness/` is the vendored opencode fork: 54.7 MiB of the 60.8 MiB this repository tracks (measured over
 * `git ls-files` on 2026-10-03 — 5,032 of 5,356 files, 90% of the bytes), and the archive it lands in is
 * what the updater downloads on every self-update. Measured the same day on a real machine: the v1.6.1
 * archive is 25,534,048 bytes, the download was refused after 348 KiB because the link was doing 7.3 KiB/s,
 * and the machine stayed on 1.6.0. Nothing on the update path reads a byte of `harness/` — `apply` builds
 * `engine/`, packs `mcp-shell/` and `installer/`, and bundles `updater/` (apply.js's `buildStagedTree`,
 * `checkStagedNpmCommands`, `installNpmPackages`, §11's runtime bundle).
 *
 * The exclusions are enforced against `REQUIRED_IN_ARCHIVE` below, so widening this list can only ever be a
 * loud failure, never a silent shrink of what a target machine needs.
 *
 * Entries are matched by **path prefix**, so an item here may be a directory (`harness/`, with its trailing
 * slash) or a single tracked file at the repository root. `.iterate_decisions.md` is the second shape, and it
 * is a decision rather than tidiness: it is the developer's own iteration log — the real one at v1.7.0 carried
 * four occurrences of the author's absolute home path (`/Users/ethanlin`) and notes on `gh auth` token scopes.
 * The repository is public so the file's existence is not a secret; what matters is that this is the artifact
 * every updater downloads, and a release archive should not be the delivery mechanism for whoever built it.
 * Nothing on the update path reads it, which is exactly why dropping it costs nothing and why the
 * `REQUIRED_IN_ARCHIVE` enforcement below cannot be offended by it.
 */
export const EXCLUDED_PREFIXES = ['harness/', '.iterate_decisions.md']

/** The package directories the updater packs out of the staged tree. */
export const PACKAGE_DIRS = ['mcp-shell', 'installer']

/**
 * What the update path reads out of the unpacked archive.
 *
 * Transcribed from the readers, not guessed at: `VERSION_SITES` is the list `updater/lib/selfcheck.js`
 * refuses a tree without, `scripts/check-version.mjs` is the guard that same step runs *from the staged
 * tree*, and the rest are the paths `apply.js`'s `buildStagedTree`, `installNpmPackages` and §11's
 * `runtimeCliPath` open by name. The value of checking this at publish time is that an archive which cannot
 * install stops here instead of failing on every machine that downloads it — every one of these absences is
 * loud at the consumer, and "loud at the consumer" is exactly what a release guard exists to prevent.
 */
const posix = (rel) => rel.split(path.sep).join('/')
export const REQUIRED_IN_ARCHIVE = [...new Set([
  ...VERSION_SITES.map((site) => posix(site.file)), // selfcheck.js: "the staged tree has no <file>"
  'scripts/check-version.mjs', // runTreeGuard spawns node against this, inside the staged tree
  'scripts/version-sites.mjs', // the guard above imports its site table from here
  'engine/Package.swift', // swift build --package-path <staged>/engine
  'engine/scripts/make-app.sh', // "the staged tree has no engine/scripts/make-app.sh"
  'updater/cli.js', // runtimeCliPath — the pointer launchd names
  ...PACKAGE_DIRS.map((dir) => `${dir}/package.json`), // npm pack runs inside each of them
])]

const MODE_FILE = 0o100644
const MODE_EXEC = 0o100755
const MODE_LINK = 0o120000
const MODE_GITLINK = 0o160000

function fail(message) {
  throw new Error(message)
}

/** git's own blob hash for these bytes: `sha1("blob <len>\0" + content)`. */
function gitBlobHash(content) {
  return crypto.createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex')
}

/**
 * The tracked tree as tar entries, in git's own byte order, with git's own modes.
 *
 * Unmerged paths and submodule gitlinks are refused rather than guessed at: `git archive` would have failed
 * on the first and silently dropped the second, and a release whose content depends on which tool noticed is
 * not a release anyone can reproduce.
 *
 * The bytes come from **git**, not from disk. `git ls-tree -r --full-tree HEAD` names the blobs of the commit
 * that was checked out, and one `git cat-file --batch` reads exactly those objects. Reading the file off disk
 * instead — which is what this did, discarding the blob id `ls-files` had just handed it — means anything that
 * rewrites a tracked file between checkout and pack (a build writing into `src`, a hook, a leftover edit, a
 * smudge filter) rides into the archive, while the SHA256 the updater later presents as "the bytes the
 * publisher signed" describes a tree nobody tagged. `--verify` cannot catch that: it counts entries, never
 * reads one. The working tree still supplies everything it is supposed to — the build outputs enter through
 * `buildOutputEntries`, because those are exactly what the build just produced.
 */
export function trackedEntries({ root, git = execFileSync }) {
  // The index is still consulted, but only for the two shapes that must stop a release outright.
  const listing = git('git', ['ls-files', '-z', '-s'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  for (const line of String(listing).split('\0').filter((entry) => entry !== '')) {
    const [meta, listedPath] = line.split('\t')
    const [modeOctal, , stage] = String(meta).split(' ')
    if (!listedPath) continue
    if (stage !== '0') fail(`${listedPath} is unmerged (stage ${stage}); refusing to publish a tree with conflicts`)
    if (Number.parseInt(modeOctal, 8) === MODE_GITLINK) fail(`${listedPath} is a submodule gitlink; the release archive has no content for it — vendor it or drop it`)
  }

  const treeListing = git('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const wanted = String(treeListing).split('\0').filter((entry) => entry !== '').map((line) => {
    const [meta, rel] = line.split('\t')
    const [modeOctal, type, objectId] = String(meta).split(' ')
    if (!rel) fail(`git ls-tree handed back a record with no path (${JSON.stringify(line)})`)
    if (type !== 'blob') fail(`${rel} is a ${type} in HEAD's tree, not a blob; refusing to publish an entry whose bytes this script would have to invent`)
    return { rel, mode: Number.parseInt(modeOctal, 8), objectId }
  })
  if (wanted.length === 0) fail("HEAD's tree lists no files — there is nothing to publish, and an empty archive is not a release")

  // One process for all of them: per-file `git cat-file` is one spawn per tracked path (5,500+ on the real
  // tree), and a pack step that slow is a pack step someone skips.
  const batch = Buffer.from(git('git', ['cat-file', '--batch'], {
    cwd: root,
    input: wanted.map((entry) => entry.objectId).join('\n'),
    maxBuffer: 512 * 1024 * 1024,
  }))
  const entries = []
  const seen = new Set()
  let cursor = 0
  for (const { rel, mode, objectId } of wanted) {
    if (seen.has(rel)) fail(`${rel} appears twice in HEAD's tree`)
    seen.add(rel)
    const newline = batch.indexOf(0x0a, cursor)
    if (newline < 0) fail(`git cat-file --batch ended after ${entries.length} of ${wanted.length} objects; refusing to publish a half-read tree`)
    const [echoed, type, sizeText] = batch.subarray(cursor, newline).toString('utf8').split(' ')
    cursor = newline + 1
    if (type === 'missing') fail(`git cannot read object ${objectId} for ${rel} — HEAD's tree names bytes this repository does not have`)
    if (type !== 'blob') fail(`${rel} came back as a ${type} object, not a blob`)
    if (echoed !== objectId) fail(`${rel}: asked for blob ${objectId} and git answered ${echoed}; refusing to guess which bytes belong to which path`)
    const size = Number.parseInt(sizeText, 10)
    if (!Number.isInteger(size) || size < 0 || batch.byteLength < cursor + size) {
      fail(`${rel}: git announced ${sizeText} bytes and the stream holds ${batch.byteLength - cursor}; refusing to publish a truncated tree`)
    }
    const content = batch.subarray(cursor, cursor + size)
    cursor += size + 1 // every record is followed by a newline
    // Belt and braces: bytes that do not hash to the object name they were read under are not that object.
    const actual = gitBlobHash(content)
    if (actual !== objectId) fail(`${rel}: the bytes read from git hash to ${actual}, not the ${objectId} HEAD's tree records`)
    if (mode === MODE_LINK) {
      entries.push({ name: rel, type: 'link', link: content.toString('utf8'), mode: 0o777 })
      continue
    }
    entries.push({ name: rel, content, mode: mode === MODE_EXEC ? 0o755 : 0o644 })
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Which entries of the shipped exclusion list landed on nothing. Kept as a pure function so
 * both answers are testable without packing the repository: an armed-and-empty exclusion is
 * the shape that lets a renamed `harness/` ship ~64 MB in a signed archive while every step
 * still exits 0, and `main()` refuses on it.
 */
export function inertExclusions(matched, prefixes = EXCLUDED_PREFIXES) {
  return prefixes.filter((prefix) => !matched.includes(prefix))
}

/**
 * The refusal as a pure function, so the wiring in `main()` is testable: returning a sentence
 * here is what proves the caller is the one that turns it into exit 1.
 */
export function judgeExclusionsActive({ matched, prefixes = EXCLUDED_PREFIXES }) {
  const inert = inertExclusions(matched, prefixes)
  if (inert.length === 0) return { ok: true, inert }
  return {
    ok: false,
    inert,
    reason: `EXCLUDED_PREFIXES names ${inert.join(', ')}, but no tracked entry starts with any of them. `
      + 'Either that path moved (the archive would now ship it) or the list is stale — fix the one that is '
      + 'actually wrong; do not delete the exclusion to make this line go away.',
  }
}

/**
 * Drop the excluded prefixes from a tracked-entry list, and say how much that took out.
 *
 * The second half is the point: an archive that quietly gets 90% smaller looks identical to an archive that
 * quietly lost something needed, until a machine tries to install it. The number is returned so the caller
 * prints it and the test can assert on it.
 */
export function applyExclusions({ entries, prefixes = EXCLUDED_PREFIXES }) {
  const kept = []
  const excluded = []
  for (const entry of entries) {
    const prefix = prefixes.find((p) => entry.name.startsWith(p))
    if (prefix) excluded.push({ ...entry, prefix })
    else kept.push(entry)
  }
  // A prefix that matched nothing stays a *reported empty exclusion* here, on purpose
  // (`release-archive.test.mjs` pins that: the number the job prints is the thing a
  // reviewer checks, and injected fixtures legitimately pass lists that match nothing).
  // The refusal belongs one level up, where the shipped list is the real one — see the
  // `EXCLUDED_PREFIXES` self-check in `main()`.
  return {
    kept,
    excluded: {
      count: excluded.length,
      bytes: excluded.reduce((total, entry) => total + (entry.content?.byteLength ?? 0), 0),
      prefixes: [...new Set(excluded.map((entry) => entry.prefix))],
    },
  }
}

/** Every file under `dir`, sorted, as tar entries. Refuses symlinks: a build output that is a link is a build that did not run. */
export function buildOutputEntries({ root, dir }) {
  const abs = path.join(root, dir)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    fail(`${dir} is missing — the release archive has to carry this build output, so run the package's own build first ("npm --workspace glasspane-mcp run build && npm --workspace glasspane-mcp run bundle")`)
  }
  const out = []
  out.push({ name: dir, type: 'dir', mode: 0o755 })
  const walk = (current, relPrefix) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name)
      const rel = relPrefix === '' ? name : `${relPrefix}/${name}`
      const stat = fs.lstatSync(full)
      if (stat.isSymbolicLink()) fail(`${rel} is a symlink inside a build output; the archive refuses to publish what the build did not really write`)
      if (stat.isDirectory()) {
        out.push({ name: `${dir}/${rel}`, type: 'dir', mode: 0o755 })
        walk(full, rel)
        continue
      }
      if (!stat.isFile()) fail(`${dir}/${rel} is neither a file nor a directory`)
      // The build's own mode is kept: a command the build marked executable must not arrive as 0644, and a
      // library file must not arrive world-writable. npm also sets +x on `bin` targets when it installs, so
      // this is about not losing information rather than about the only thing that makes a command run.
      out.push({ name: `${dir}/${rel}`, content: fs.readFileSync(full), mode: stat.mode & 0o755 })
    }
  }
  walk(abs, '')
  return out
}

/**
 * The files `mcp-shell`'s own `bundle` script writes — **read off that script**, never
 * re-listed here. A `dist` holding any other `.js` was produced by `tsc`, not by the
 * bundler — and that is not a cosmetic difference: `glasspane-mcp` declares only `zod` as a
 * dependency (`iterate-kernel` sits in `devDependencies`, because the bundle inlines it),
 * so a tsc-shaped `dist` still carries `import "iterate-kernel/…"` in its entry points.
 * Such a package installs cleanly, reports its version correctly, and then answers with
 * whatever kernel version the machine happened to have — which since 2026-10-18 is
 * *quieter* than the old failure, not safer: with the kernel vendored as `file:../kernel`
 * the same mistake died on `ERR_MODULE_NOT_FOUND` on first run, and with the kernel on the
 * registry it resolves a contract nobody tested against this artifact. Found originally by
 * packing an archive whose `dist` had been rebuilt by `npm test` after the bundle step, then
 * installing that archive's own tarball in a clean prefix. `npm pack --dry-run` cannot see it
 * because a dry run never installs and never executes.
 *
 * The list this replaces named three entries while the script bundled four, and the only
 * thing that noticed was this guard refusing to publish a tree that was fine — i.e. no
 * release archive could be built from it. That is the third time a hand-copied list of
 * this repository's own outputs went stale, so the copy is gone: the expected set is every
 * `--outfile` the bundler declares, and a script that cannot be read is a **refusal**, not
 * an empty list that lets every file in `dist` pass vacuously.
 */
export function bundleEntriesFromScript(script, { where = 'the bundle script' } = {}) {
  if (typeof script !== 'string' || script.trim() === '') {
    fail(`${where} is missing or empty: the expected bundle output cannot be derived from a script that is not there, and an empty list would pass every file dist holds`)
  }
  const outfiles = [...script.matchAll(/--outfile=(?:"([^"]+)"|'([^']+)'|([^\s&"']+))/g)]
    .map((match) => match[1] ?? match[2] ?? match[3])
  if (outfiles.length === 0) {
    fail(`${where} declares no --outfile= at all: either esbuild stopped writing the bundle or this script stopped being the bundler — refusing rather than assuming nothing is expected`)
  }
  const names = []
  for (const outfile of outfiles) {
    const rel = posix(outfile)
    if (!/^dist\/[A-Za-z0-9._-]+\.js$/.test(rel)) {
      fail(`${where} writes ${outfile}, which is not a plain \`dist/<name>.js\`: this guard compares dist's files by name and cannot do that against a nested or non-.js output`)
    }
    const name = rel.slice('dist/'.length)
    if (!names.includes(name)) names.push(name)
  }
  // The clean-up step is part of the same promise: it keeps exactly the files the bundler
  // wrote. A `! -name` list that disagrees with the `--outfile` list means one of the two
  // is lying — an entry the script deletes again after writing it, or a leftover it
  // protects that the bundler no longer produces.
  const kept = [...script.matchAll(/! -name '([^']+)'/g)].map((match) => match[1])
  if (kept.length > 0) {
    const keptButNotBundled = kept.filter((name) => !names.includes(name))
    const bundledButDeleted = names.filter((name) => !kept.includes(name))
    if (keptButNotBundled.length > 0 || bundledButDeleted.length > 0) {
      fail(`${where} is internally inconsistent: its clean-up step keeps ${JSON.stringify([...kept].sort())} while it bundles ${JSON.stringify([...names].sort())}`
        + `${keptButNotBundled.length > 0 ? ` (${JSON.stringify(keptButNotBundled)} kept but never bundled)` : ''}`
        + `${bundledButDeleted.length > 0 ? ` (${JSON.stringify(bundledButDeleted)} bundled but deleted by its own clean-up step)` : ''}`)
    }
  }
  return names.sort()
}

/** The expected set, read from this repository's own `mcp-shell` manifest. */
function repoBundleEntries() {
  const manifest = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'mcp-shell', 'package.json')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  } catch (error) {
    fail(`mcp-shell/package.json could not be read to derive the bundle entries (${String(error)}): this script cannot say what the bundler writes without it`)
  }
  return bundleEntriesFromScript(parsed?.scripts?.bundle, { where: 'mcp-shell/package.json scripts.bundle' })
}

/** Prove the packed `mcp-shell/dist` is the bundle, and that nothing it imports is undeclared. */
export function assertBundleShape({ entries, manifest }) {
  const declared = new Set(Object.keys(manifest.dependencies ?? {}))
  const bundleEntries = repoBundleEntries()
  const js = entries.filter((entry) => entry.name.startsWith('mcp-shell/dist/') && entry.name.endsWith('.js'))
  if (js.length === 0) fail('mcp-shell/dist carries no .js at all — there is nothing for the declared bin targets to run')
  const unbundled = js
    .filter((entry) => !bundleEntries.includes(entry.name.split('/').pop()))
    .map((entry) => entry.name)
  if (unbundled.length > 0) {
    fail(`mcp-shell/dist holds ${unbundled.length} file(s) the bundler does not write (${unbundled.slice(0, 6).join(', ')}): this is tsc output, its entry points still import "iterate-kernel/…" which glasspane-mcp declares only as a build-time dependency, so the installed package resolves a kernel nobody tested against this artifact. Run "npm --workspace glasspane-mcp run bundle" as the LAST step touching dist before packing (npm test rebuilds it with tsc). The expected set (${bundleEntries.join(', ')}) is read from mcp-shell/package.json's own bundle script.`)
  }
  const missing = new Set()
  for (const entry of js) {
    const text = (entry.content ?? Buffer.alloc(0)).toString('utf8')
    // 只认行首的 ESM import/export。捆绑输出里嵌着大量给面板与 agent 读的文案，里面出现过
    // `from "` 这样的片段——早先不限行首、又允许跨行的正则把整段文案当成模块名，
    // 于是一条真 bundle 被拒在一份不存在的依赖上（"over this gate (imported by …)"）。
    const specifiers = [
      ...[...text.matchAll(/^[ \t]*(?:import|export)\b[^\n]*?\bfrom\s*["']([^"'\n]+)["']/gm)].map((m) => m[1]),
      ...[...text.matchAll(/^[ \t]*import\s*["']([^"'\n]+)["']/gm)].map((m) => m[1]),
    ]
    for (const specifier of specifiers) {
      if (specifier.startsWith('.') || specifier.startsWith('node:') || !/^[^./]/.test(specifier)) continue
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]
      if (!declared.has(packageName)) missing.add(`${packageName} (imported by ${entry.name})`)
    }
  }
  if (missing.size > 0) {
    fail(`mcp-shell/dist imports package(s) the manifest does not declare: ${[...missing].sort().join(', ')} — npm will install it happily and the first run will fail to resolve them`)
  }
  return { jsEntries: js.length, declared: [...declared].sort() }
}

/**
 * The commands the shipped packages promise: every path a `bin` field names, resolved inside its package.
 *
 * Checked here rather than left to the updater because this is where the bytes are assembled: a package whose
 * declared command is absent produces an install that succeeds, a global symlink that dangles, and a refused
 * update — which is precisely the 2026-10-01 rollback.
 */
export function declaredCommands({ root }) {
  const wanted = []
  for (const rel of PACKAGE_DIRS) {
    const manifest = path.join(root, rel, 'package.json')
    if (!fs.existsSync(manifest)) fail(`${rel}/package.json is missing from the tree this archive is built from`)
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    const bin = parsed?.bin
    const pairs = typeof bin === 'string' ? [[parsed?.name, bin]] : Object.entries(bin ?? {})
    for (const [command, target] of pairs) {
      if (!command || !target) continue
      wanted.push({ package: rel, command, file: path.join(root, rel, target), target })
    }
  }
  if (wanted.length === 0) fail('no package in this tree declares a command; either the manifest changed or the archive is being built from the wrong directory')
  return wanted
}

/**
 * Assemble the archive bytes. `prefix` is the top-level directory the unpacker's §3.2 layout expects
 * (`GlassPane-<ver>/`), so this stays interchangeable with what `extractInto` and the self-check read.
 */
export function archiveBytes({ root, version, prefixes = EXCLUDED_PREFIXES }) {
  const commands = declaredCommands({ root })
  const trackedAll = trackedEntries({ root })
  const { kept: tracked, excluded } = applyExclusions({ entries: trackedAll, prefixes })
  const extras = REQUIRED_BUILD_OUTPUTS.flatMap((dir) => buildOutputEntries({ root, dir }))
  const present = new Set([...tracked, ...extras].map((entry) => entry.name))
  for (const need of REQUIRED_IN_ARCHIVE) {
    if (!present.has(need)) {
      fail(`the release archive would not contain ${need}, which the update path reads out of the unpacked tree — an exclusion (or a missing file) has taken something install-critical`)
    }
  }
  for (const cmd of commands) {
    const rel = path.relative(root, cmd.file).split(path.sep).join('/')
    if (!present.has(rel)) {
      fail(`${cmd.package} declares the command "${cmd.command}" at ${cmd.target}, which this tree does not contain — the installed package would have nothing to run`)
    }
  }
  // The bundle shape is checked on the same bytes that go into the tar, and *after* the install-critical
  // presence checks above so each guard keeps its own refusal: a missing `dist/index.js` must read as
  // "the declared command has nothing behind it", not as "this is tsc output".
  assertBundleShape({
    entries: extras,
    manifest: JSON.parse(fs.readFileSync(path.join(root, 'mcp-shell', 'package.json'), 'utf8')),
  })
  // A build output that is *also* tracked (a repository that one day commits `dist`) is one entry, not a
  // collision: the tracked bytes come from git, and the requirement this script guards is that the file
  // exists, which both sources agree on. Anything else that lands twice is an internal bug and refused.
  const chosen = new Map()
  for (const entry of tracked) chosen.set(entry.name, entry)
  for (const entry of extras) if (!chosen.has(entry.name)) chosen.set(entry.name, entry)
  const names = new Set()
  const entries = []
  for (const entry of [...chosen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = `GlassPane-${version}/${entry.name}`
    if (names.has(name)) fail(`${name} would be written twice into the archive`)
    names.add(name)
    entries.push({ ...entry, name })
  }
  return { bytes: packTarGz(entries), entries: entries.length, commands: commands.map((c) => `${c.package}:${c.command}`), excluded }
}

/**
 * The entries an archive must contain for the updater's install path to have anything to work with.
 *
 * Two kinds, deliberately derived from different places. The commands come from the packages' own `bin`
 * fields and the schemas from `kernel/schemas`, so neither list goes stale when a command or a schema is
 * added. The bundle step no longer copies from that directory (it copies from the installed
 * `iterate-kernel`, via `scripts/bundle-kernel-schemas.mjs`), which is what makes this a check rather than
 * a tautology: the mirror is kept equal to the published corpus by `scripts/check-kernel-corpus.mjs`, so
 * requiring the archive to hold the mirror's schema set asks whether the artifact shipped the contract the
 * fork's pin describes. The install inputs come from `REQUIRED_IN_ARCHIVE`, which is a transcription of what
 * `updater/lib/apply.js` reads out of the unpacked tree — that one is checked against the archive on purpose,
 * because an exclusion rule (`EXCLUDED_PREFIXES`) is exactly the shape that can remove `engine/` and still
 * leave every `bin` field satisfied.
 */
export function requiredEntries({ root, version }) {
  const prefix = `GlassPane-${version}/`
  const wanted = declaredCommands({ root }).map((cmd) => `${prefix}${path.relative(root, cmd.file).split(path.sep).join('/')}`)
  const schemaDir = path.join(root, 'kernel', 'schemas')
  if (!fs.existsSync(schemaDir)) fail('kernel/schemas is missing: this list is the pinned corpus the archive is required against (scripts/check-kernel-corpus.mjs keeps it equal to what iterate-kernel publishes), so there is nothing to require without it')
  const schemas = fs.readdirSync(schemaDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => `${prefix}mcp-shell/schemas/${name}`)
  if (schemas.length === 0) fail('kernel/schemas holds no .json schema, which is not what the bundle step is supposed to copy')
  const installInputs = REQUIRED_IN_ARCHIVE.map((need) => `${prefix}${need}`)
  return { prefix, required: [...new Set([...wanted, ...schemas, ...installInputs])] }
}

/**
 * Re-read an archive this script (or anything else) produced and answer the only question the release job
 * cares about: are the commands the packages declare actually inside?
 *
 * This lives here rather than as a `tar -tzf | grep -q` in the workflow because that pipeline is a trap:
 * `grep -q` exits at the first match, GNU tar then dies of SIGPIPE, and `set -o pipefail` turns a
 * **successful** check into a failed step — which is how the v1.6.0 release job reddened on 2026-10-01
 * while naming an entry the archive did contain. One author for the question and one for the answer, and
 * both read the same `bin` fields.
 */
export function verifyArchive({ file, version, root, excludedPrefixes = EXCLUDED_PREFIXES }) {
  const bytes = fs.readFileSync(file)
  const entries = readTarGz(bytes).map((entry) => String(entry.name).replace(/\/+$/, ''))
  const have = new Set(entries)
  const { required } = requiredEntries({ root, version })
  const missing = required.filter((name) => !have.has(name))
  // The other half of the question. `required` can only prove what must be present; nothing
  // in it notices an archive that also carries the excluded tree, and every entry here sits
  // under the single `GlassPane-<ver>/` top directory — so a `^harness/`-anchored check would
  // match nothing and pass vacuously (this repo has been fooled by exactly that shape).
  const prefix = `GlassPane-${version}/`
  const leaked = entries.filter((name) => excludedPrefixes.some((p) => name.startsWith(`${prefix}${p}`)))
  return { entries: entries.length, bytes: bytes.length, required, missing, leaked }
}

/**
 * The CLI. `root` is injectable for the same reason `archiveBytes` takes `prefixes`: the two
 * refusals this function owns (an exclusion that went inert, an archive that leaks the excluded
 * tree) live here, and a test that can only reach the pure judges would leave the wiring uncovered.
 */
export function main(argv, { root: rootOverride } = {}) {
  const [firstArg, second, third] = argv
  const verifying = firstArg === '--verify'
  const version = verifying ? third : firstArg
  const target = second
  if (!version || !target) {
    process.stderr.write('usage: node scripts/make-release-archive.mjs <version> <out-file>\n')
    process.stderr.write('       node scripts/make-release-archive.mjs --verify <archive-file> <version>\n')
    return 2
  }
  if (!/^\d+\.\d+\.\d+[\w.-]*$/.test(version)) {
    process.stderr.write(`refusing: ${JSON.stringify(version)} is not a version this script will name a release archive with\n`)
    return 2
  }
  const root = rootOverride ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (verifying) {
    let checked
    try {
      checked = verifyArchive({ file: target, version, root })
    } catch (error) {
      process.stderr.write(`release archive cannot be verified: ${error.message}\n`)
      return 1
    }
    if (checked.missing.length > 0) {
      for (const name of checked.missing) process.stderr.write(`::error::the release archive does not contain ${name}\n`)
      process.stderr.write(`release archive is missing ${checked.missing.length} of ${checked.required.length} required entries\n`)
      return 1
    }
    if (checked.leaked.length > 0) {
      for (const name of checked.leaked.slice(0, 12)) process.stderr.write(`::error::the release archive carries ${name}, which EXCLUDED_PREFIXES says must not ship\n`)
      process.stderr.write(`release archive leaks ${checked.leaked.length} excluded entr(ies) — the updater downloads this file on every self-update\n`)
      return 1
    }
    process.stdout.write(`release archive verified: ${checked.entries} entries, ${checked.bytes} bytes, all ${checked.required.length} declared commands and schemas present, no entry under ${EXCLUDED_PREFIXES.join(' / ')}\n`)
    return 0
  }
  let first
  let secondPass
  try {
    first = archiveBytes({ root, version })
    secondPass = archiveBytes({ root, version })
  } catch (error) {
    process.stderr.write(`release archive refused: ${error.message}\n`)
    return 1
  }
  if (!first.bytes.equals(secondPass.bytes)) {
    process.stderr.write('release archive is not reproducible: two passes over the same tree produced different bytes\n')
    return 1
  }
  // The half `applyExclusions` deliberately leaves to the caller: this is the run whose
  // prefixes are the *shipped* list, so a configured prefix that landed on nothing means
  // `harness/` (or a file named in `EXCLUDED_PREFIXES`) moved out from under it — the
  // signed artifact every updater downloads would grow by ~64 MB while both this step and
  // `--verify` still exit 0. Measured cost of that shape: v1.6.1's 25 MB archive refused at
  // 7.3 KiB/s, machine pinned to the previous version. Printed counts are for review;
  // an armed-and-empty exclusion is a refusal.
  const active = judgeExclusionsActive({ matched: first.excluded.prefixes })
  if (!active.ok) {
    process.stderr.write(`release archive refused: ${active.reason}\n`)
    return 1
  }
  fs.writeFileSync(target, first.bytes)
  const digest = crypto.createHash('sha256').update(first.bytes).digest('hex')
  process.stdout.write(`release archive: ${target}\n`)
  process.stdout.write(`  entries=${first.entries} bytes=${first.bytes.length} sha256=${digest}\n`)
  process.stdout.write(`  commands carried: ${first.commands.join(', ')}\n`)
  process.stdout.write(
    `  excluded: ${first.excluded.count} entries / ${first.excluded.bytes} raw bytes` +
      `${first.excluded.prefixes.length > 0 ? ` under ${first.excluded.prefixes.join(', ')}` : ''}\n`,
  )
  return 0
}

// **两侧都 realpath**，与 `updater/cli.js`、`installer/cli.js`、`updater/agent-entry.js` 那三个
// npm/launchd 交付的入口同一个规矩：node 按**真实路径**载入 ESM 入口，所以这个脚本被符号链接
// 调用时 `path.resolve(process.argv[1])` 是链接本身、`fileURLToPath(import.meta.url)` 是被指的那份，
// 两者永不相等——`main()` 一步不走，进程**退 0 且零输出**。本机 2026-10-19 实测：直接跑无参
// → rc 2 加两行 usage；经 `/var/tmp/gp-item4-20261019/mra-link.mjs` → rc 0、一行不出。发布作业里
// 那一格于是"成功"了，而归档一个字节都没写。realpathSync 对不存在的路径会抛，抛＝"不是被
// 直接运行"，不是崩掉模块。
function invokedAsEntrypoint() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedAsEntrypoint()) {
  process.exitCode = main(process.argv.slice(2))
}
