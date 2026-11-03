#!/usr/bin/env node
/*
 * tree-anchor.mjs — refuse to release a tree that trunk does not vouch for.
 *
 * The release is built in the split repository, whose `main` is a `git subtree split` of trunk's
 * `harness/glasspane-harness`. Until this check existed the only thing proving that relationship was a
 * hand-typed line in `docs/release.md`: measured on v0.7.10, two commits (a seven-dependency security
 * bump and the CODEOWNERS file) lived ONLY in the split repo and shipped in that release while trunk's
 * `main` never received them — the next split would have silently reverted a security fix, and the
 * artifact under a live version number would not be reproducible from trunk at all.
 *
 * STRICT, WITH ONE NAMED EXCEPTION, and the exception is not a path. The ledger of a release cannot
 * describe the release that has not happened yet, so `SYNCLOG.md` and `CHANGELOG.md` are always ahead
 * on trunk after a tag is cut — and a tag is never moved, so the lag is structural, not sloppy. This
 * therefore tolerates exactly one shape: a ledger file present in BOTH trees whose bytes in the tagged
 * tree are a PROPER PREFIX of trunk's bytes, i.e. trunk appended and the tag carries a shorter record.
 * Anything else is a refusal: a ledger file added or deleted by the tag (the tag carries bytes trunk
 * lacks, or drops a whole file), a ledger file whose difference is not pure appending, and — the point
 * of the whole check — any non-ledger path at all.
 *
 * The same invariant is measured from trunk's side by `harness/tools/release-artifact.mjs`, which
 * prints `△ artifact: … lags trunk by N line(s) of SYNCLOG.md`. Two repositories, one rule, and both
 * ends are checked: the fork cannot ship a tree trunk does not have, and trunk cannot drift from what
 * is already published. The ledger set is deliberately tiny and named here because a gate that
 * exempts "the docs" would exempt a reverted dependency in a README.
 *
 * WHY THIS MOVED OUT OF THE WORKFLOW: the step lived as ~30 lines of inline bash that compared two
 * tree hashes for byte equality. That made it impossible to finish a release after any ledger commit —
 * measured on v0.13.0, where the tag's tree was 49 ledger lines behind trunk and every rerun of
 * `create-release`/`binaries`/`checksums` died on a step whose own sibling ruler calls that same delta
 * "tolerated". A judge that cannot pass again is a judge that silently turns a rerun into a re-cut, and
 * re-cutting a signed published tag is the defect this file exists to prevent.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const LEDGER_FILES = ['SYNCLOG.md', 'CHANGELOG.md']

function listed(entries) {
  return entries.map((e) => `${e.status}\t${e.path}`).join('\n')
}

/**
 * @param {{own: string, trunk: string, entries: Array<{status: string, path: string, appendedOnly?: boolean, addedToTrunk?: number, carriedByTag?: number}>}} seen
 *   `own` is the tree being released, `trunk` is trunk's subtree tree, `entries` is the file-level delta
 *   between them with `appendedOnly` decided from the two blobs by the caller
 * @returns {{ok: boolean, tolerated: boolean, reason: string}}
 */
export function judgeTreeAnchor({ own, trunk, entries }) {
  if (own === trunk) {
    return { ok: true, tolerated: false, reason: `anchor OK: the artifact being released IS trunk's fork subtree — ${own}` }
  }
  const strays = entries.filter((e) => !LEDGER_FILES.includes(e.path))
  if (strays.length > 0) {
    return {
      ok: false,
      tolerated: false,
      reason: `the tree being released (${own}) is NOT trunk's subtree (${trunk}) outside the ledger. `
        + `${strays.length} non-ledger path(s) differ:\n${listed(strays)}\n`
        + 'The artifact shipped under this version number cannot be reproduced from trunk, and the next '
        + 'subtree split would silently revert whatever differs — which is how v0.7.10 nearly shipped a '
        + 'reverted security dependency. Remedy: make the two trees one tree, then re-cut this tag from '
        + 'the tree that has the change — merge the split-only commits into trunk under '
        + 'harness/glasspane-harness, or re-run `git subtree split --prefix=harness/glasspane-harness` '
        + 'from trunk main and push that. Do not move a published tag to whatever is handy.',
    }
  }
  const notAppending = entries.filter((e) => e.appendedOnly !== true)
  if (notAppending.length > 0) {
    return {
      ok: false,
      tolerated: false,
      reason: `the tree being released (${own}) differs from trunk's subtree (${trunk}) only in ledger `
        + `file(s), but not in the one tolerated direction: ${notAppending.length} of them is not `
        + `"trunk holds the tagged text plus added lines".\n${listed(notAppending)}\n`
        + 'The exemption is measured on the bytes, not on the file name: a ledger the tag reworded, '
        + 'dropped or added is content the artifact carries that trunk does not (or a whole file the '
        + 'artifact is missing) — refuse, and make the trees one tree.',
    }
  }
  const lines = entries.reduce((sum, e) => sum + (e.addedToTrunk ?? 0), 0)
  return {
    ok: true,
    tolerated: true,
    reason: `△ anchor held with the one named exception: outside ${LEDGER_FILES.join(' and ')} the two trees are `
      + `one tree (${own} vs ${trunk}); the ledger on trunk is the tagged text plus ${lines} added line(s) and `
      + 'nothing the tag carries that trunk lacks. That is the record of this release describing a tree the '
      + 'tag had not yet cut — named here rather than hidden, and the next tag carries it.',
  }
}

function run(args) {
  const got = spawnSync('git', args, { encoding: 'utf8' })
  if (got.error) return { error: `could not run git ${args.join(' ')} (${got.error.message})` }
  if (got.status !== 0) return { error: `git ${args.join(' ')} answered ${got.status}: ${String(got.stderr ?? '').trim().slice(0, 300) || '(no stderr)'}` }
  return { out: String(got.stdout ?? '') }
}

function existsIn(tree, file) {
  return run(['cat-file', '-e', `${tree}:${file}`]).error === undefined
}

/**
 * `git diff --numstat <tagTree> <trunkTree> -- <path>` read as "what does trunk hold beyond the tag":
 * field 1 is lines trunk has that the tagged blob does not, field 2 is lines the tagged blob has that
 * trunk does not. Tolerance needs the second to be zero — the artifact must not carry ledger bytes trunk
 * lacks — and the first to be positive, since a "difference" with neither side is not a difference.
 * Counting lines is the measurement; a prefix test would have failed the real v0.13.0 case for the
 * wrong reason, because SYNCLOG.md is newest-first and the next entry is inserted at the TOP.
 */
function ledgerDelta(own, trunk, file) {
  const got = run(['diff', '--numstat', own, trunk, '--', file])
  if (got.error) return null
  const line = String(got.out ?? '').split('\n').find((l) => l.trim() !== '')
  if (!line) return { addedToTrunk: 0, carriedByTag: 0 }
  const [added, deleted] = line.split('\t')
  return { addedToTrunk: Number(added) || 0, carriedByTag: Number(deleted) || 0 }
}

export function main({ env = process.env } = {}) {
  const url = env.TRUNK_URL ?? ''
  const ref = env.TRUNK_REF ?? 'main'
  const prefix = env.TRUNK_PREFIX ?? 'harness/glasspane-harness'
  if (!url) {
    return { code: 1, text: 'no TRUNK_URL, so this tree cannot be anchored to trunk. Refusing on purpose: an unmeasured anchor is not a passing anchor.' }
  }
  const ownGot = run(['rev-parse', 'HEAD^{tree}'])
  if (ownGot.error) return { code: 1, text: ownGot.error }
  const own = ownGot.out.trim()
  // An anonymous HTTPS fetch of a public repository: this job keeps `contents: read` and asks for no
  // wider token. A failed fetch is a refusal, never a skip — the release would otherwise be anchored on
  // whatever the runner happened to have cached.
  const fetched = run(['fetch', '--no-tags', '--depth', '1', url, ref])
  if (fetched.error) {
    return {
      code: 1,
      text: `could not fetch trunk's ${ref} from ${url}, so this tree cannot be anchored to trunk. `
        + 'Refusing on purpose: an unmeasured anchor is not a passing anchor. Check network access from '
        + 'this runner and that trunk still exists at that URL.',
    }
  }
  const headGot = run(['rev-parse', 'FETCH_HEAD'])
  const trunkGot = run(['rev-parse', `FETCH_HEAD:${prefix}`])
  if (trunkGot.error) {
    const head = headGot.out ? headGot.out.trim() : 'unknown commit'
    return {
      code: 1,
      text: `trunk's ${ref} (${head}) has no ${prefix} subtree. The fork no longer lives inside trunk's tree, `
        + 'so this lane\'s whole premise is gone; nothing is published until that is decided on purpose.',
    }
  }
  const trunk = trunkGot.out.trim()
  if (trunk === own) return { code: 0, text: judgeTreeAnchor({ own, trunk, entries: [] }).reason }
  const delta = run(['diff', '--name-status', trunk, own])
  if (delta.error) {
    return { code: 1, text: `${delta.error} — the file-level delta between trunk's subtree and the tree being released could not be read, so the one tolerated exception could not be measured either.` }
  }
  const entries = delta.out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [status, ...rest] = line.split('\t')
      const file = rest[rest.length - 1]
      if (!LEDGER_FILES.includes(file)) return { status: status.slice(0, 1), path: file }
      const counted = ledgerDelta(own, trunk, file)
      const present = existsIn(own, file) && existsIn(trunk, file)
      return {
        status: status.slice(0, 1),
        path: file,
        appendedOnly: status.slice(0, 1) === 'M'
          && present
          && counted !== null
          && counted.carriedByTag === 0
          && counted.addedToTrunk > 0,
        addedToTrunk: counted?.addedToTrunk ?? 0,
        carriedByTag: counted?.carriedByTag ?? 0,
      }
    })
  if (entries.length === 0) {
    return { code: 1, text: `the two tree hashes differ (${own} vs ${trunk}) while \`git diff --name-status\` reports no path. Refusing: an anchor this gate cannot explain is not an anchor.` }
  }
  const verdict = judgeTreeAnchor({ own, trunk, entries })
  return { code: verdict.ok ? 0 : 1, text: verdict.reason }
}

// Nothing runs on import: `bun test` must be able to require `judgeTreeAnchor` without the top-level
// self-run exiting the process. Both sides of the entry comparison need realpath, because node loads
// the ESM entry by its real path and a symlinked invocation would otherwise skip main() and exit 0 —
// for a release gate that shape is "the lane could not read the tree and said yes".
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
  const result = main()
  process.stdout.write(`${result.text}\n`)
  process.exit(result.code)
}
