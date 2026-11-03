#!/usr/bin/env bun
/**
 * [gp] Refused. This is upstream's beta-branch integrator, and this fork has no beta branch to
 * integrate into.
 *
 * What the upstream body did, in order, from any shell that could run it:
 *   - `gh pr list --base v2 --label beta`, `git fetch origin v2`, `git checkout -B beta origin/v2`,
 *     then merge each labelled PR with an `opencode run -m opencode/deepseek-v4-flash` call standing
 *     in for conflict resolution;
 *   - `git add -A` and `git commit` from inside the script, twice;
 *   - delete `bun.lock` and re-run `bun install` when a merge conflicted it — the lock this
 *     product's builds are validated against;
 *   - and finally, at the old line 354:
 *       git push origin beta --force --no-verify
 *
 * Why it is a refusal and not a comment, in the fork's own terms:
 *   1. `--no-verify` on a `--force` push defeats the hooks this repository exists to keep —
 *      `script/hooks` and the fork-diff rule that a touched vendored tree re-records
 *      `harness/contracts/fork-diff.json` in the same commit. A force-push is also the one operation
 *      that rewrites published history for everyone else's clone;
 *   2. it bypasses the release gates on the way to a *branch that becomes a release*: upstream's
 *      `publish.yml` builds and publishes from `beta`. The fork's lane is
 *      `.github/workflows/release.yml`, whose `version-check` job holds the tree anchor and whose
 *      publish jobs need `confirm == true`; neither is reachable from here, which is the point;
 *   3. every input it reads is upstream's — the `v2` base branch, the `beta` label, the
 *      `opencode/deepseek-v4-flash` model on the first-party gateway this product deleted
 *      (product.json -> models.removedFirstParty). Run against this fork's remote it would fail
 *      mid-way, having already committed and force-pushed.
 *
 * Kept as a dead end in the shape `script/publish.ts` uses: an upstream sync replays onto a refusal
 * that says why, instead of silently re-acquiring a script that force-pushes with `--no-verify`.
 * The fork's own beta/preview path is a channel build of `release.yml` (docs/release.md).
 */
console.error("glasspane-harness: this script pushes nowhere, on purpose.")
console.error("  It is upstream's beta integrator: it merges PRs against upstream's v2 branch,")
console.error("  regenerates bun.lock, and force-pushes beta with --no-verify — past the hooks and")
console.error("  past the version-check / assert-ci-green gates this product's lane requires.")
console.error("  This fork has no beta branch and no v2 base. Remedy: docs/release.md.")
process.exit(2)
