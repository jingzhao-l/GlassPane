/**
 * `tools/sync-kernel.sh` is the only sanctioned way to write the canonical kernel back into
 * this repository's `kernel/` mirror, and the daily main-line prompt names it by path. It had
 * two defects nobody could see, because nothing tested the script:
 *
 * 1. The canonical path was interpolated *inside* a `node -p "…"` string literal. A
 *    `KERNEL_SRC` whose path contains a single quote — `/Users/o'brien/iterate-skill`, an
 *    ordinary home directory — broke the JS literal, so the sync died on a SyntaxError on the
 *    version read instead of reading a version. The path now arrives as `process.argv`, which
 *    is not parsed as source.
 * 2. Both `--target` refusal messages still advertised `supported: repo, fork` after the fork
 *    leg was retired (2026-10-08) to exit 2. An operator following that text gets a second
 *    refusal from a flag the tool just told them about.
 *
 * The fixture is a real mirror copy (guard 1 compares file sets, guard 2 greps the consumer
 * contract out of `src/index.ts`), not a stub that answers for a tree the script would reject.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(REPO, 'tools', 'sync-kernel.sh')

/** A canonical checkout that would pass every guard: the mirror's own bytes, version re-stamped. */
function fixture({ apostrophe = true, version = '0.1.99' } = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gp-sync-kernel-'))
  const srcRoot = apostrophe ? path.join(base, "it's a test") : path.join(base, 'plain')
  const kernel = path.join(srcRoot, 'kernel')
  fs.cpSync(path.join(REPO, 'kernel'), kernel, {
    recursive: true,
    filter: (src) => !/(^|[/\\])(node_modules|dist|\.npm-cache)([/\\]|$)/.test(src),
  })
  const pkg = JSON.parse(fs.readFileSync(path.join(kernel, 'package.json'), 'utf8'))
  pkg.version = version
  fs.writeFileSync(path.join(kernel, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  return { base, srcRoot, version }
}

function runSync(srcRoot, args = ['--dry-run']) {
  return spawnSync('/bin/bash', [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, KERNEL_SRC: srcRoot },
  })
}

test('sync-kernel: a KERNEL_SRC path containing a single quote still reads both versions', () => {
  const f = fixture()
  const result = runSync(f.srcRoot)
  const out = `${result.stdout}${result.stderr}`
  // Pre-fix this is where the run died: `require('/…/it's a test/kernel/package.json')` is not
  // valid JavaScript, `set -e` ends the script, and the operator sees a SyntaxError.
  assert.equal(result.status, 0, `带撇号的路径必须能同步：${out}`)
  assert.match(out, /dry run OK/)
  // The version note is the proof the read actually happened, and with the fixture's number —
  // a script that skipped the read would print neither.
  assert.match(out, new RegExp(`canonical says ${f.version}`), out)
  fs.rmSync(f.base, { recursive: true, force: true })
})

test('sync-kernel: the same fixture without the apostrophe is also accepted (the control)', () => {
  // Without this, the case above could be green for the wrong reason — a guard short-circuiting
  // the run would look identical to a path that quoting broke, from the outside.
  const f = fixture({ apostrophe: false })
  const result = runSync(f.srcRoot)
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, new RegExp(`canonical says ${f.version}`))
  fs.rmSync(f.base, { recursive: true, force: true })
})

test('sync-kernel: the retired fork leg refuses, and the usage text no longer advertises it', () => {
  const f = fixture({ apostrophe: false })
  const fork = runSync(f.srcRoot, ['--target=fork', '--dry-run'])
  assert.equal(fork.status, 2, `${fork.stdout}${fork.stderr}`)
  assert.match(`${fork.stderr}${fork.stdout}`, /--target=fork is retired/)
  assert.match(`${fork.stderr}${fork.stdout}`, /kernel-pin\.mjs/, '拒绝报文要给出替它的那条路')

  // The two strings that used to say "supported: repo, fork". Asserted through behaviour —
  // an unknown target value prints the supported list — rather than grepping the script text.
  const unknown = runSync(f.srcRoot, ['--target=bogus'])
  assert.equal(unknown.status, 2, `${unknown.stdout}${unknown.stderr}`)
  const shown = `${unknown.stderr}${unknown.stdout}`
  assert.match(shown, /supported: repo/)
  assert.ok(!/supported: repo, fork/.test(shown), `不该再把已退役的那条腿列为支持项：${shown}`)
  assert.ok(!/repo\|fork/.test(shown), `同一句里的第二种写法：${shown}`)
  fs.rmSync(f.base, { recursive: true, force: true })
})
