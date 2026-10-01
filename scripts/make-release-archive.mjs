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
 * So the archive is the tracked tree **plus the build outputs a target machine cannot produce for itself**
 * (`mcp-shell/dist`, `mcp-shell/schemas`) — `engine/` still builds on the target, because Xcode is the one
 * toolchain a macOS update may assume. Missing build outputs are a refusal, not a warning: an archive that
 * cannot produce a runnable package is not a release of this product.
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

import { packTarGz } from '../updater/lib/tar.js'

/** Directories that must exist and are not tracked: the JS build outputs the target machine cannot make. */
export const REQUIRED_BUILD_OUTPUTS = ['mcp-shell/dist', 'mcp-shell/schemas']

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
  for (const rel of ['mcp-shell', 'installer']) {
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
export function archiveBytes({ root, version }) {
  const commands = declaredCommands({ root })
  const tracked = trackedEntries({ root })
  const extras = REQUIRED_BUILD_OUTPUTS.flatMap((dir) => buildOutputEntries({ root, dir }))
  const present = new Set([...tracked, ...extras].map((entry) => entry.name))
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
  return { bytes: packTarGz(entries), entries: entries.length, commands: commands.map((c) => `${c.package}:${c.command}`) }
}

function main(argv) {
  const [version, out] = argv
  if (!version || !out) {
    process.stderr.write('usage: node scripts/make-release-archive.mjs <version> <out-file>\n')
    return 2
  }
  if (!/^\d+\.\d+\.\d+[\w.-]*$/.test(version)) {
    process.stderr.write(`refusing: ${JSON.stringify(version)} is not a version this script will name a release archive with\n`)
    return 2
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let first
  let second
  try {
    first = archiveBytes({ root, version })
    second = archiveBytes({ root, version })
  } catch (error) {
    process.stderr.write(`release archive refused: ${error.message}\n`)
    return 1
  }
  if (!first.bytes.equals(second.bytes)) {
    process.stderr.write('release archive is not reproducible: two passes over the same tree produced different bytes\n')
    return 1
  }
  fs.writeFileSync(out, first.bytes)
  const digest = crypto.createHash('sha256').update(first.bytes).digest('hex')
  process.stdout.write(`release archive: ${out}\n`)
  process.stdout.write(`  entries=${first.entries} bytes=${first.bytes.length} sha256=${digest}\n`)
  process.stdout.write(`  commands carried: ${first.commands.join(', ')}\n`)
  return 0
}

const SELF = path.resolve(fileURLToPath(import.meta.url))
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exitCode = main(process.argv.slice(2))
}
