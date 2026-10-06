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

/**
 * The tracked tree as tar entries, in git's own byte order, with git's own modes.
 *
 * Unmerged paths and submodule gitlinks are refused rather than guessed at: `git archive` would have failed
 * on the first and silently dropped the second, and a release whose content depends on which tool noticed is
 * not a release anyone can reproduce.
 */
export function trackedEntries({ root, git = execFileSync }) {
  const listing = git('git', ['ls-files', '-z', '-s'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const lines = String(listing).split('\0').filter((line) => line !== '')
  const entries = []
  const seen = new Set()
  for (const line of lines) {
    const [meta, stagePath] = line.split('\t')
    const [modeOctal, , stage] = String(meta).split(' ')
    const rel = stagePath
    if (!rel) continue
    if (stage !== '0') fail(`${rel} is unmerged (stage ${stage}); refusing to publish a tree with conflicts`)
    const mode = Number.parseInt(modeOctal, 8)
    if (mode === MODE_GITLINK) fail(`${rel} is a submodule gitlink; the release archive has no content for it — vendor it or drop it`)
    if (seen.has(rel)) fail(`${rel} appears twice in git's index`)
    seen.add(rel)
    const abs = path.join(root, rel)
    if (mode === MODE_LINK) {
      entries.push({ name: rel, type: 'link', link: fs.readlinkSync(abs), mode: 0o777 })
      continue
    }
    if (!fs.existsSync(abs)) fail(`${rel} is in the index but not on disk`)
    entries.push({ name: rel, content: fs.readFileSync(abs), mode: mode === MODE_EXEC ? 0o755 : 0o644 })
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
 * added. The install inputs come from `REQUIRED_IN_ARCHIVE`, which is a transcription of what
 * `updater/lib/apply.js` reads out of the unpacked tree — that one is checked against the archive on purpose,
 * because an exclusion rule (`EXCLUDED_PREFIXES`) is exactly the shape that can remove `engine/` and still
 * leave every `bin` field satisfied.
 */
export function requiredEntries({ root, version }) {
  const prefix = `GlassPane-${version}/`
  const wanted = declaredCommands({ root }).map((cmd) => `${prefix}${path.relative(root, cmd.file).split(path.sep).join('/')}`)
  const schemaDir = path.join(root, 'kernel', 'schemas')
  if (!fs.existsSync(schemaDir)) fail('kernel/schemas is missing: the bundle step copies it next to the command, so there is nothing to require without it')
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
export function verifyArchive({ file, version, root }) {
  const bytes = fs.readFileSync(file)
  const entries = readTarGz(bytes).map((entry) => String(entry.name).replace(/\/+$/, ''))
  const have = new Set(entries)
  const { required } = requiredEntries({ root, version })
  const missing = required.filter((name) => !have.has(name))
  return { entries: entries.length, bytes: bytes.length, required, missing }
}

function main(argv) {
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
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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
    process.stdout.write(`release archive verified: ${checked.entries} entries, ${checked.bytes} bytes, all ${checked.required.length} declared commands and schemas present\n`)
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

const SELF = path.resolve(fileURLToPath(import.meta.url))
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exitCode = main(process.argv.slice(2))
}
